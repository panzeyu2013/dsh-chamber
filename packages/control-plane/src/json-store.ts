/**
 * Generic atomic JSON document store — the control plane's JSON write
 * protocol (design 04 §6 / 03 §2.1).
 *
 * Protocol, verbatim from the design:
 *
 * 1. Mutations are synchronous write-through transactions (read-modify-write
 *    runs to completion in one JS turn, so the shared .tmp path never has two
 *    writers). State is published only with a successful disk write; a failed
 *    persist restores the previous in-memory document and throws to the caller.
 * 2. Backup-first persist: write .bak (writeFileSync + fsync) → write .tmp
 *    (writeFileSync + fsync) → rename onto the main file. If the main write
 *    fails, the backup holds the new document and recovery can take it.
 * 3. lastPersistSucceededAt / recoveryState are only touched after both files
 *    hit disk.
 * 4. Corrupt is never a fake-empty: a corrupt main falls back to .bak and
 *    loads with an explicit recoveryState (the main file is deliberately NOT
 *    rewritten, so the recovery state stays visible); double corruption
 *    throws loudly and the store refuses to load.
 * 5. Dropped rows are counted and surfaced through the recovery state — never
 *    silent.
 * 6. Load sequence: main → .bak → initial. A schemaVersion-less legacy main
 *    is migrated in place by the onLoadValidate hook (its `migrated` flag);
 *    the migration persist writes the pre-migration document as the .bak so
 *    recovery re-runs the migration (design 03 §3.8A: old file retained as an
 *    explicit backup).
 *
 * Revision semantics: the store owns the counter; every changed mutation
 * bumps doc.revision by one. mutateIfMatch(expected, mutator) throws a typed
 * JsonStoreRevisionConflictError ('revision conflict') when they differ.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** Logger sink the store reports persist failures to (console-like subset). */
export interface JsonStoreLogger {
  log?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/**
 * A JSON document handled by the store. The only fields the store itself
 * owns are the optional schemaVersion and the revision counter; domain
 * fields are free-form.
 */
export interface JsonStoreDocument {
  schemaVersion?: number
  revision?: number
  [key: string]: unknown
}

/** {next, changed} contract of every mutator (design 03 §3.2). */
export interface JsonStoreMutateResult {
  next: JsonStoreDocument
  changed: boolean
}

/** A store mutation: read the current document, produce the next one. */
export type JsonStoreMutator = (doc: JsonStoreDocument) => JsonStoreMutateResult

/** Dropped-row counters from a load/validation run (never silent). */
export interface JsonStoreDroppedCounts {
  connections: number
  projects: number
}

/**
 * Recovery state: null (healthy) or {source: 'main'|'backup'|'initial',
 * dropped} — the main file is deliberately not rewritten after a recovery,
 * so the state stays visible.
 */
export type JsonStoreRecoveryState =
  | { source: 'main' | 'backup' | 'initial'; dropped: JsonStoreDroppedCounts }
  | null

/**
 * Outcome of the onLoadValidate hook: the cleaned document, the dropped
 * counters, and optionally {migrated: true, backupDoc} for an in-place
 * schema migration (the pre-migration document becomes the .bak).
 */
export interface JsonStoreValidateResult {
  doc: JsonStoreDocument
  dropped: JsonStoreDroppedCounts
  migrated?: boolean
  backupDoc?: unknown
}

/** createJsonStore options (see the module header for semantics). */
export interface JsonStoreOptions {
  filePath: string
  logger?: JsonStoreLogger
  initial?: JsonStoreDocument
  onLoadValidate?: (doc: JsonStoreDocument) => JsonStoreValidateResult
}

/** persist() options; backupDoc overrides the .bak content (migrations). */
export interface JsonStorePersistOptions {
  backupDoc?: unknown
}

/** Diagnostics projection (design 03 §3.10 storage block). */
export interface JsonStoreStatus {
  loaded: boolean
  schemaVersion: number | undefined
  revision: number
  recoveryState: JsonStoreRecoveryState
  dropped: JsonStoreDroppedCounts
  lastPersistSucceededAt: number | null
}

/**
 * The store surface returned by createJsonStore().
 *
 * Failure semantics: every persistence failure throws synchronously
 * (JsonStorePersistError) — including from the promise-returning members
 * mutate/mutateIfMatch/persist, which are plain (non-async) functions that
 * also throw before returning their promise. Callers must therefore use
 * try/catch or `await` inside a try block; a bare `.catch()` chain misses
 * the synchronous throw. mutate/mutateIfMatch additionally roll the
 * in-memory document back before throwing, so a failed mutation is never
 * partially applied.
 */
export interface JsonStore {
  load(): JsonStoreDocument
  getDoc(): JsonStoreDocument
  getSnapshot(): Promise<JsonStoreDocument>
  mutate(mutator: JsonStoreMutator): Promise<JsonStoreMutateResult>
  mutateIfMatch(
    expectedRevision: number | undefined,
    mutator: JsonStoreMutator,
  ): Promise<JsonStoreMutateResult>
  persist(doc?: JsonStoreDocument, options?: JsonStorePersistOptions): Promise<boolean>
  getStatus(): JsonStoreStatus
}

/**
 * Typed error for If-Match conflicts (design 03 §3.2 step 3). Message is
 * exactly 'revision conflict'; the catalog layer tags it with
 * code 'catalog_revision_conflict' before it reaches routes.
 */
export class JsonStoreRevisionConflictError extends Error {
  expected: number | undefined
  actual: number | undefined
  code: string | undefined

  constructor(expected: number | undefined, actual: number | undefined) {
    super('revision conflict')
    this.name = 'JsonStoreRevisionConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** A mutation could not be durably committed and was rolled back in memory. */
export class JsonStorePersistError extends Error {
  code = 'json_store_persist_failed'

  constructor(filePath: string, cause: unknown) {
    super(`failed to persist ${filePath}`, { cause })
    this.name = 'JsonStorePersistError'
  }
}

/**
 * Create a JSON document store.
 * @param options - {filePath, logger, initial, onLoadValidate}.
 *   - filePath: the main document path (<file>.bak and <file>.tmp are derived).
 *   - logger: {warn(...)} sink for persist failures.
 *   - initial: the empty document used when neither main nor .bak exists.
 *   - onLoadValidate(doc): runtime validation/normalization; must return
 *     {doc, dropped: {connections, projects}}. May additionally return
 *     {migrated: true, backupDoc} to signal an in-place schema migration —
 *     the migrated doc is persisted immediately with the pre-migration
 *     document as the backup. Throwing marks the document as unusable at the
 *     document level and sends the loader down the .bak recovery path.
 * @returns {load(), getDoc(), getSnapshot(), mutate(), mutateIfMatch(),
 *   persist(), getStatus()}.
 */
export function createJsonStore({
  filePath,
  logger,
  initial = {},
  onLoadValidate,
}: JsonStoreOptions): JsonStore {
  const backupPath = `${filePath}.bak`
  const tmpPath = `${filePath}.tmp`
  const warnSink = logger?.warn
  const warn = typeof warnSink === 'function' ? (message: string) => warnSink(message) : () => {}

  /** The in-memory document; null until loaded (reads fall back to a fresh initial clone). */
  let state: JsonStoreDocument | null = null
  /** Diagnostics: timestamp of the last persist where both files were written. */
  let lastPersistSucceededAt: number | null = null
  /** Explicit recovery state: null (healthy) | {source, dropped}. */
  let recoveryState: JsonStoreRecoveryState = null
  /** Dropped-row counters from the most recent load (never silent). */
  let dropped: JsonStoreDroppedCounts = zeroDropped()

  function zeroDropped(): JsonStoreDroppedCounts {
    return { connections: 0, projects: 0 }
  }

  /** The initial document, deep-copied so repeated loads never share state. */
  function cloneInitial(): JsonStoreDocument {
    return structuredClone(initial)
  }

  /** writeFileSync + fsync: open 'w', write, fsync, close. */
  function writeFileWithFsync(path: string, text: string): void {
    const fd = openSync(path, 'w')
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  /** Read + parse one file; throws when missing or corrupt. */
  function readParsed(path: string): JsonStoreDocument {
    return JSON.parse(readFileSync(path, 'utf8')) as JsonStoreDocument
  }

  /** Run the validation hook; a throw marks the document as unusable. */
  function validateParsed(parsed: JsonStoreDocument): JsonStoreValidateResult {
    if (typeof onLoadValidate !== 'function') {
      return { doc: parsed, dropped: zeroDropped(), migrated: false }
    }
    const result = onLoadValidate(parsed)
    if (result === null || typeof result !== 'object' || !('doc' in result)) {
      throw new Error(`validation hook produced no doc for ${filePath}`)
    }
    return result
  }

  /**
   * Backup-first persist: .bak → .tmp (+fsync each) → rename onto main.
   * lastPersistSucceededAt and recoveryState are only touched when both
   * writes succeeded. `options.backupDoc` overrides the backup content (used
   * by in-place migrations, so the backup holds the pre-migration document).
   * Failures are logged and thrown. Callers must never report a mutation as
   * successful when the durable commit failed.
   */
  function persistSync(doc: JsonStoreDocument, options: JsonStorePersistOptions = {}): void {
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const text = `${JSON.stringify(doc, undefined, 2)}\n`
      const backupText = options.backupDoc === undefined
        ? text
        : `${JSON.stringify(options.backupDoc, undefined, 2)}\n`
      writeFileWithFsync(backupPath, backupText)
      writeFileWithFsync(tmpPath, text)
      renameSync(tmpPath, filePath)
      lastPersistSucceededAt = Date.now()
      recoveryState = null
    } catch (error) {
      warn(`json-store: failed to persist ${filePath}: ${String(error)}`)
      throw new JsonStorePersistError(filePath, error)
    }
  }

  /**
   * Read main → .bak → initial. Throws when both main and .bak are unusable
   * (double corruption — never a fake-empty). A valid .bak loads with an
   * explicit recoveryState and the main file is NOT rewritten, so the
   * recovery state stays visible.
   */
  function readDocument(): {
    doc: JsonStoreDocument
    dropped: JsonStoreDroppedCounts
    recoveryState: JsonStoreRecoveryState
  } {
    const mainExists = existsSync(filePath)
    let mainResult: JsonStoreValidateResult | null = null
    try {
      mainResult = validateParsed(readParsed(filePath))
    } catch {
      /* corrupt or unusable → recovery path */
    }
    if (mainResult !== null) {
      const { doc, dropped: droppedCounts, migrated, backupDoc } = mainResult
      if (migrated) {
        persistSync(doc, { backupDoc: backupDoc ?? readParsed(filePath) })
      }
      return {
        doc,
        dropped: droppedCounts,
        recoveryState: hasDropped(droppedCounts)
          ? { source: 'main' as const, dropped: droppedCounts }
          : null,
      }
    }
    let backupResult: JsonStoreValidateResult | null = null
    try {
      backupResult = validateParsed(readParsed(backupPath))
    } catch {
      /* keep null */
    }
    if (backupResult !== null) {
      const { doc, dropped: droppedCounts } = backupResult
      return { doc, dropped: droppedCounts, recoveryState: { source: 'backup' as const, dropped: droppedCounts } }
    }
    if (mainExists) {
      throw new Error(`${filePath} is corrupt and no valid backup (${backupPath}) is available`)
    }
    if (existsSync(backupPath)) {
      // Main missing + backup unreadable: evidence of a torn first write.
      // Start from the initial document but surface the recovery state —
      // never a silent empty.
      const emptyDropped = zeroDropped()
      return { doc: cloneInitial(), dropped: emptyDropped, recoveryState: { source: 'initial', dropped: emptyDropped } }
    }
    return { doc: cloneInitial(), dropped: zeroDropped(), recoveryState: null }
  }

  function hasDropped(counts: JsonStoreDroppedCounts): boolean {
    return counts.connections > 0 || counts.projects > 0
  }

  /**
   * Apply a mutator to the in-memory document: read current doc → construct
   * next → bump revision on change → swap state. Fully synchronous, so
   * concurrent callers can never interleave.
   */
  function apply(mutator: JsonStoreMutator): JsonStoreMutateResult {
    // Mutators work on a clone: an in-place mutator cannot corrupt the live
    // document before the write-through transaction commits.
    const doc: JsonStoreDocument = structuredClone(state ?? cloneInitial())
    const result = mutator(doc)
    if (!result.changed) return result
    result.next.revision = (doc.revision ?? 0) + 1
    state = result.next
    return result
  }

  return {
    /**
     * Load the document (main → .bak → initial). Returns the loaded document.
     * Throws on double corruption. A hook-flagged in-place migration is
     * persisted here (backup-first, pre-migration document as the backup);
     * a backup-loaded document is never rewritten.
     */
    load(): JsonStoreDocument {
      const outcome = readDocument()
      state = outcome.doc
      recoveryState = outcome.recoveryState
      dropped = outcome.dropped
      return state
    },

    /** The live in-memory document (no clone). For store owners that need
     * synchronous access (the catalog's sync row API); never hand this to
     * routes. */
    getDoc() {
      return state ?? cloneInitial()
    },

    /** Deep-cloned snapshot (never the internal document). */
    getSnapshot() {
      return Promise.resolve(structuredClone(state ?? cloneInitial()))
    },

    /**
     * Apply a mutation. The mutator receives the current document and returns
     * {next, changed}; a changed mutation bumps revision by one, swaps the
     * in-memory document, then commits it with a synchronous backup-first
     * write. A failed write restores the prior state and throws synchronously,
     * so even legacy synchronous catalog callers cannot ignore the failure.
     */
    mutate(mutator: JsonStoreMutator): Promise<JsonStoreMutateResult> {
      const previous = state
      const result = apply(mutator)
      if (!result.changed) return Promise.resolve(result)
      try {
        persistSync(result.next)
      } catch (error) {
        state = previous
        throw error
      }
      return Promise.resolve(result)
    },

    /**
     * mutate with an If-Match guard: rejects with
     * JsonStoreRevisionConflictError ('revision conflict') when
     * doc.revision !== expectedRevision, before anything is applied.
     * `expectedRevision === undefined` disables the check (preserving the
     * catalog's current behavior).
     */
    mutateIfMatch(
      expectedRevision: number | undefined,
      mutator: JsonStoreMutator,
    ): Promise<JsonStoreMutateResult> {
      const doc: JsonStoreDocument = state ?? cloneInitial()
      if (expectedRevision !== undefined && doc.revision !== expectedRevision) {
        return Promise.reject(new JsonStoreRevisionConflictError(expectedRevision, doc.revision))
      }
      const previous = state
      const result = apply(mutator)
      if (!result.changed) return Promise.resolve(result)
      try {
        persistSync(result.next)
      } catch (error) {
        state = previous
        throw error
      }
      return Promise.resolve(result)
    },

    /**
     * Run a backup-first persist. `doc` defaults to the current document;
     * `options.backupDoc` overrides the .bak content (migrations).
     * @returns a promise resolving with whether both files were written.
     */
    persist(doc: JsonStoreDocument = state ?? cloneInitial(), options: JsonStorePersistOptions = {}): Promise<boolean> {
      try {
        persistSync(doc, options)
        return Promise.resolve(true)
      } catch (error) {
        return Promise.reject(error)
      }
    },

    /** Diagnostics projection: loaded/revision/recovery/dropped/persist time. */
    getStatus(): JsonStoreStatus {
      return {
        loaded: state !== null,
        schemaVersion: state?.schemaVersion,
        revision: state?.revision ?? 0,
        recoveryState,
        dropped: { connections: dropped.connections, projects: dropped.projects },
        lastPersistSucceededAt,
      }
    },
  }
}
