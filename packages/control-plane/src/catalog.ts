/**
 * Connection registry with JSON persistence (v4: single local row).
 *
 * The catalog is the control plane's durable view of what it manages: the
 * local dsh instance — exactly one connection row with connectionId 'local'
 * (design 03 §2.1). Persisted at <stateDir>/catalog.json on top of
 * json-store.ts — the storage protocol from design 04 §6 / 03 §2.1: a
 * serialized mutation queue, backup-first atomic writes (.bak → .tmp+fsync →
 * rename), revision + If-Match (409), an explicit recovery state, and
 * "corrupt is never a fake-empty". A schemaVersion-less file is treated as
 * v1 and migrated in place to v2 at load, with the original v1 document
 * preserved as the .bak (the backup-first protocol handles the ordering).
 *
 * v4 narrowing (01 §4/§5): projects/bindings/adapters are gone — the dsh
 * frontend runtime owns session business and the desktop main process owns
 * the remote-instance registry. Rows whose kind is not 'local' are dropped
 * and counted at load (thin-shell era ssh rows never silently kept).
 * User-editable fields (label/accentColor) persist in the row; status and
 * dshPort are runtime projections written by the host-management layer
 * (03 §2.1: runtime facts are never authoritative in the file).
 *
 * All row APIs stay synchronous (the in-memory apply is atomic within the
 * calling tick; the disk write is enqueued on the store's serialized queue).
 */

import { join } from 'node:path'
import {
  createJsonStore,
  JsonStoreRevisionConflictError,
} from './json-store.ts'
import type {
  JsonStore,
  JsonStoreDroppedCounts,
  JsonStoreLogger,
  JsonStoreMutator,
  JsonStoreRecoveryState,
  JsonStoreValidateResult,
} from './json-store.ts'

/** Persisted catalog file name under the state dir. */
export const CATALOG_FILE = 'catalog.json'

/** Backup file name (backup-first protocol, design 03 §2.1). */
export const CATALOG_BACKUP_FILE = 'catalog.json.bak'

/** Current catalog schema version. */
export const CATALOG_SCHEMA_VERSION = 2

/**
 * One persisted connection row. The wire contract (03 §2.1): the fixed row
 * 'local' with user-editable label/accentColor and the runtime projections
 * status/dshPort/error. The row carries a permissive index signature so the
 * host-management layer can attach operational fields.
 */
export interface CatalogConnectionRow {
  connectionId: string
  kind: string
  status?: string
  label?: string
  accentColor?: string
  dshPort?: number | null
  error?: string
  [key: string]: unknown
}

/** The persisted catalog document (v2). */
export interface CatalogDocument {
  schemaVersion: number
  revision: number
  connections: CatalogConnectionRow[]
  migration: Record<string, unknown>
  [key: string]: unknown
}

/** Load-time entry validation outcome (dropped counts surface via recovery). */
export interface CatalogValidateResult {
  doc: CatalogDocument
  dropped: JsonStoreDroppedCounts
}

/** createCatalog options. */
export interface CatalogOptions {
  stateDir: string
  logger?: JsonStoreLogger
}

/** updateConnectionFields outcome; null when the row is absent. */
export type UpdateConnectionFieldsResult =
  | { row: CatalogConnectionRow | null; updated: boolean }
  | null

/** Diagnostics projection (catalog block of the health/diagnostics surface). */
export interface CatalogHealth {
  schemaVersion: number
  revision: number
  loaded: boolean
  lastPersistSucceededAt: number | null
  recoveryState: JsonStoreRecoveryState
  dropped: JsonStoreDroppedCounts
  connectionCount: number
}

/** The catalog surface returned by createCatalog(). */
export interface Catalog {
  load(): { connections: CatalogConnectionRow[] }
  save(): Promise<boolean>
  listConnections(): CatalogConnectionRow[]
  getConnection(connectionId: string): CatalogConnectionRow | null
  upsertConnection(row: CatalogConnectionRow): CatalogConnectionRow
  updateConnectionFields(
    connectionId: string,
    fields: Record<string, unknown>,
  ): UpdateConnectionFieldsResult
  removeConnection(connectionId: string): boolean
  mutate(
    ifMatchRevision: number | undefined,
    mutator: (doc: CatalogDocument) => { next: CatalogDocument; changed: boolean },
  ): Promise<{ next: CatalogDocument; changed: boolean }>
  getSnapshot(): Promise<CatalogDocument>
  snapshotHealth(): CatalogHealth
}

/**
 * Accepted connection kinds (v4: the catalog only ever holds the local
 * instance — remote instances live in the desktop main-process registry,
 * 03 §2.2). Rows with a kind outside this set are dropped and counted at
 * load, never silently kept.
 */
export const CONNECTION_KINDS = new Set(['local'])

function emptyDoc(): CatalogDocument {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    revision: 0,
    connections: [],
    migration: { legacyProjectsImported: false, pendingConnectionIds: [] },
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * Load-time validation + v1→v2 migration. Entry-level failures (missing
 * fields, duplicate ids, non-local kind) drop the row and count it — never
 * silent; document-level failures (bad schemaVersion, revision not a
 * non-negative integer, connections not an array) throw, sending the store
 * down the .bak recovery path. A schemaVersion-less document is v1:
 * migrated in place (schemaVersion 2, revision 0, migration block), with the
 * original v1 document returned as the backup content. v2 legacy documents
 * may still carry a `projects` array (thin-shell era); it is stripped at
 * load — v4 has no project table (01 §4).
 * @param raw - the parsed document, read from disk.
 * @returns {doc, dropped, migrated, backupDoc?} — the cleaned document and
 *   dropped counters; throws when the document is unusable as a whole.
 */
// The store hands the hook a parsed document of unknown shape; internal use only.
type RawCatalogDocument = any

function validateAndMigrate(raw: RawCatalogDocument): JsonStoreValidateResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('catalog: document is not an object')
  }
  if (raw.schemaVersion === undefined) {
    if (!Array.isArray(raw.connections)) {
      throw new Error('catalog: v1 document without connections array')
    }
    const next = {
      ...raw,
      schemaVersion: CATALOG_SCHEMA_VERSION,
      revision: 0,
      migration: { legacyProjectsImported: false, pendingConnectionIds: [] },
    }
    return { ...validateEntries(next), migrated: true, backupDoc: raw }
  }
  if (raw.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`catalog: unsupported schemaVersion ${String(raw.schemaVersion)}`)
  }
  if (!isNonNegativeInteger(raw.revision)) {
    throw new Error('catalog: revision must be a non-negative integer')
  }
  if (!Array.isArray(raw.connections)) {
    throw new Error('catalog: connections must be an array')
  }
  const doc = raw.migration === undefined || raw.migration === null || typeof raw.migration !== 'object'
    ? { ...raw, migration: { legacyProjectsImported: false, pendingConnectionIds: [] } }
    : raw
  return { ...validateEntries(doc), migrated: false }
}

/**
 * Entry-level validation with dropped counting. Invalid rows are dropped and
 * counted; the counters surface through the store's recovery state. Rows
 * whose kind is not 'local' are dropped (v4: the catalog never holds remote
 * instances). The legacy `projects` array is stripped — v4 has no project
 * table and the dsh frontend runtime owns session business.
 */
function validateEntries(doc: RawCatalogDocument): CatalogValidateResult {
  const dropped: JsonStoreDroppedCounts = { connections: 0, projects: 0 }
  const connections: CatalogConnectionRow[] = []
  const seenConnectionIds = new Set()
  for (const row of doc.connections) {
    const invalid = row === null || typeof row !== 'object' || Array.isArray(row)
      || !isNonEmptyString(row.connectionId)
      || seenConnectionIds.has(row.connectionId)
      || !CONNECTION_KINDS.has(row.kind)
    if (invalid) {
      dropped.connections += 1
      continue
    }
    seenConnectionIds.add(row.connectionId)
    connections.push(row)
  }
  const next: CatalogDocument = { ...doc, connections }
  delete next.projects
  return { doc: next, dropped }
}

/**
 * Create the registry.
 * @param options - {stateDir, logger}.
 * @returns {load(), save(), listConnections(), getConnection(id),
 *   upsertConnection(row), updateConnectionFields(id, fields),
 *   removeConnection(id), mutate(ifMatchRevision, mutator),
 *   getSnapshot(), snapshotHealth()}.
 */
export function createCatalog({ stateDir, logger }: CatalogOptions): Catalog {
  const file = join(stateDir, CATALOG_FILE)
  const store: JsonStore = createJsonStore({
    filePath: file,
    logger,
    initial: emptyDoc(),
    onLoadValidate: validateAndMigrate,
  })

  /** The live document; methods read rows from it (live references, so the
   * existing in-place row mutation pattern keeps working). */
  function doc(): CatalogDocument {
    return store.getDoc() as unknown as CatalogDocument
  }

  /** Load the persisted catalog; a missing file starts from the empty v2 doc. */
  function load(): { connections: CatalogConnectionRow[] } {
    const loaded = store.load() as unknown as CatalogDocument
    return { connections: loaded.connections }
  }

  /** A typed mutation over the live document (the store treats docs opaquely). */
  type CatalogMutator = (doc: CatalogDocument) => { next: CatalogDocument; changed: boolean }
  type CatalogMutateResult = { next: CatalogDocument; changed: boolean }

  function mutateDoc(mutator: CatalogMutator): Promise<CatalogMutateResult> {
    return store.mutate(mutator as unknown as JsonStoreMutator) as unknown as Promise<CatalogMutateResult>
  }

  /** One connection row by id; null when absent. */
  function getConnection(connectionId: string): CatalogConnectionRow | null {
    return doc().connections.find(row => row.connectionId === connectionId) ?? null
  }

  /** All connection rows in registration order. */
  function listConnections(): CatalogConnectionRow[] {
    return doc().connections
  }

  /**
   * Insert or update one connection row (replacing its mutable status
   * fields in place, preserving registration order). Always persists, even
   * when the row is the same reference already in the document — callers
   * mutate live rows in place before calling.
   */
  function upsertConnection(row: CatalogConnectionRow): CatalogConnectionRow {
    mutateDoc(doc => {
      const existing = doc.connections.find(candidate => candidate.connectionId === row.connectionId)
      if (existing === undefined) {
        return { next: { ...doc, connections: [...doc.connections, row] }, changed: true }
      }
      Object.assign(existing, row)
      return { next: doc, changed: true }
    })
    return getConnection(row.connectionId) ?? row
  }

  /** Remove a connection row; returns whether it existed. */
  function removeConnection(connectionId: string): boolean {
    const before = doc().connections.length
    mutateDoc(doc => {
      if (!doc.connections.some(row => row.connectionId === connectionId)) {
        return { next: doc, changed: false }
      }
      return {
        next: {
          ...doc,
          connections: doc.connections.filter(row => row.connectionId !== connectionId),
        },
        changed: true,
      }
    })
    return doc().connections.length !== before
  }

  /**
   * Update selected fields of one connection row without touching the rest.
   * A field whose value is `undefined` deletes the key.
   * @returns {row, updated} or null when the row is absent. `updated` is
   *   true when anything actually changed (a no-op change does not bump the
   *   revision).
   */
  function updateConnectionFields(
    connectionId: string,
    fields: Record<string, unknown>,
  ): UpdateConnectionFieldsResult {
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      const error = new Error('updateConnectionFields: fields must be an object') as Error & { code: string }
      error.code = 'catalog_invalid_input'
      throw error
    }
    if (getConnection(connectionId) === null) return null
    let changed = false
    mutateDoc(doc => {
      const target = doc.connections.find(candidate => candidate.connectionId === connectionId)
      if (target === undefined) return { next: doc, changed: false }
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
          if (key in target) {
            delete target[key]
            changed = true
          }
        } else if (target[key] !== value) {
          target[key] = value
          changed = true
        }
      }
      return { next: doc, changed }
    })
    return { row: getConnection(connectionId), updated: changed }
  }

  /**
   * Mutate with an optional If-Match guard: a revision mismatch throws a
   * typed error tagged code 'catalog_revision_conflict' (message
   * 'revision conflict') — the 409 contract. Pass undefined to skip the
   * check (all row methods above do exactly that, preserving current
   * behavior). The mutator receives the current document and returns
   * {next, changed}; resolves with {next, changed} after the persist.
   */
  function mutate(ifMatchRevision: number | undefined, mutator: CatalogMutator): Promise<CatalogMutateResult> {
    const attempt = store.mutateIfMatch(ifMatchRevision, mutator as unknown as JsonStoreMutator)
    const typedAttempt = attempt as unknown as Promise<CatalogMutateResult>
    return typedAttempt.catch(error => {
      if (error instanceof JsonStoreRevisionConflictError) {
        error.code = 'catalog_revision_conflict'
      }
      throw error
    })
  }

  /** Deep-cloned snapshot of the whole document (never the internal rows). */
  function getSnapshot(): Promise<CatalogDocument> {
    return store.getSnapshot() as unknown as Promise<CatalogDocument>
  }

  /** Persist the current document (compat; the row methods persist already). */
  function save(): Promise<boolean> {
    return store.persist()
  }

  /** Diagnostics projection (catalog block of the health/diagnostics surface). */
  function snapshotHealth(): CatalogHealth {
    const status = store.getStatus()
    const current = doc()
    return {
      schemaVersion: current.schemaVersion,
      revision: current.revision ?? 0,
      loaded: status.loaded,
      lastPersistSucceededAt: status.lastPersistSucceededAt,
      recoveryState: status.recoveryState,
      dropped: status.dropped,
      connectionCount: current.connections.length,
    }
  }

  return {
    load,
    save,
    listConnections,
    getConnection,
    upsertConnection,
    updateConnectionFields,
    removeConnection,
    mutate,
    getSnapshot,
    snapshotHealth,
  }
}
