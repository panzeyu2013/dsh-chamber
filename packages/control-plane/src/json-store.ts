/**
 * Generic atomic JSON document store — the control plane's JSON write protocol.
 *
 * - Mutations are synchronous write-through transactions; a failed persist restores
 *   the previous in-memory document and throws — unless an exact readback proves the
 *   intended main bytes are already online (revision retained, error still thrown).
 * - Backup-first persist: .bak then main, each via a random O_EXCL/no-follow temp,
 *   file fsync, rename and parent fsync; state timestamps change only after both hit
 *   disk.
 * - Corrupt is never a fake-empty: a corrupt main falls back to .bak with an explicit
 *   recoveryState (main deliberately NOT rewritten); double corruption throws loudly;
 *   dropped rows are counted.
 * - Load: main → .bak → initial (initial only when both leaves are absent; a present
 *   corrupt backup fails loudly even when main is absent). A schemaVersion-less legacy
 *   main is migrated in place with the pre-migration document as the .bak.
 * - One instance serializes its own callers (transactions are synchronous); atomic
 *   replacement is NOT a cross-process compare-and-swap — the store owns the revision
 *   counter and mutateIfMatch throws a typed conflict on mismatch.
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWritePrivateFileNoFollow, readPrivateFileNoFollow } from './private-file.ts'

/** Logger sink the store reports persist failures to (console-like subset). */
export interface JsonStoreLogger {
  log?: (...args: unknown[]) => void
  warn?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

/**
 * A JSON document handled by the store. The store itself owns only the optional
 * schemaVersion and the revision counter; domain fields are free-form.
 */
interface JsonStoreDocument {
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
 * Recovery state: null (healthy) or {source: 'main'|'backup', dropped} — the main
 * file is deliberately not rewritten after a recovery, so the state stays visible.
 */
export type JsonStoreRecoveryState =
  | { source: 'main' | 'backup'; dropped: JsonStoreDroppedCounts }
  | null

/**
 * Outcome of the onLoadValidate hook: the cleaned document, the dropped counters and
 * optionally {migrated: true, backupDoc} for an in-place schema migration (the
 * pre-migration document becomes the .bak).
 */
export interface JsonStoreValidateResult {
  doc: JsonStoreDocument
  dropped: JsonStoreDroppedCounts
  migrated?: boolean
  backupDoc?: unknown
}

/** createJsonStore options (see the module header for semantics). */
interface JsonStoreOptions {
  filePath: string
  logger?: JsonStoreLogger
  initial?: JsonStoreDocument
  onLoadValidate?: (doc: JsonStoreDocument) => JsonStoreValidateResult
  /** Optional owner policy for the main, backup and temporary documents, applied on
   *  load and after every open so umask or a legacy mode cannot weaken the store. */
  fileMode?: number
}

/** persist() options; backupDoc overrides the .bak content (migrations). */
export interface JsonStorePersistOptions {
  backupDoc?: unknown
}

/** Diagnostics projection. */
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
 * (JsonStorePersistError) — including from mutate/mutateIfMatch/persist, which are
 * plain functions that also throw before returning their promise, so a bare
 * `.catch()` chain misses the synchronous throw. mutate/mutateIfMatch roll the
 * in-memory document back unless the thrown error has `onlinePublished === true`
 * (that exact-readback case retains the online revision but still throws).
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
 * Typed error for If-Match conflicts. Message is exactly 'revision conflict'; the
 * catalog layer tags it with code 'catalog_revision_conflict'.
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

/** A mutation could not be confirmed as durably committed. */
export class JsonStorePersistError extends Error {
  code = 'json_store_persist_failed'
  /** Exact stable readback found the intended bytes at the main path. */
  readonly onlinePublished: boolean
  /** True when publication is visible but the failing write could not confirm durability. */
  readonly durabilityUnknown: boolean

  constructor(filePath: string, cause: unknown, onlinePublished = false) {
    super(`failed to persist ${filePath}`, { cause })
    this.name = 'JsonStorePersistError'
    this.onlinePublished = onlinePublished
    this.durabilityUnknown = onlinePublished
  }
}

/** The backup leaf for a document path (`<file>.bak`; backup-first protocol). Single
 *  source for the derivation: store, catalog and any recovery reader name the same leaf. */
export function backupPathFor(filePath: string): string {
  return `${filePath}.bak`
}

/**
 * Create a JSON document store.
 * @param options - filePath (main document; <file>.bak is derived); logger (warn
 *   sink); initial (document used when neither main nor .bak exists);
 *   onLoadValidate(doc) — runtime validation/normalization returning {doc, dropped};
 *   it may return {migrated: true, backupDoc} for an in-place schema migration
 *   (persisted immediately with the pre-migration document as the backup), and
 *   throwing sends the loader down the .bak recovery path; fileMode (enforced on
 *   main/.bak and every private temp/write).
 * @returns {load, getDoc, getSnapshot, mutate, mutateIfMatch, persist, getStatus}.
 */
export function createJsonStore({
  filePath,
  logger,
  initial = {},
  onLoadValidate,
  fileMode,
}: JsonStoreOptions): JsonStore {
  const backupPath = backupPathFor(filePath)
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

  /** Read + parse one file; throws when missing or corrupt. */
  function readParsed(path: string): JsonStoreDocument {
    const read = readPrivateFileNoFollow(path, {
      ...(fileMode === undefined ? {} : { tightenMode: fileMode, requiredMode: fileMode }),
      maxBytes: 64 * 1024 * 1024,
    })
    return JSON.parse(read.value) as JsonStoreDocument
  }

  /** A persist failure after rename is ambiguous: only exact stable bytes at the public path prove the intended revision is online. */
  function isExactMainReadback(expected: string): boolean {
    try {
      return readPrivateFileNoFollow(filePath, {
        ...(fileMode === undefined ? {} : { tightenMode: fileMode, requiredMode: fileMode }),
        maxBytes: 64 * 1024 * 1024,
      }).value === expected
    } catch {
      return false
    }
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

  /** A leaf below a missing/non-directory ancestor is absent from this store's view;
   *  an initial load must retain the empty-store behaviour so callers can construct a
   *  store before its parent exists. Persistence will still surface the structural error. */
  function isAbsentPathError(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR'
  }

  /**
   * Backup-first persist: atomic .bak replacement → atomic main replacement. State
   * timestamps change only when both writes succeeded. `options.backupDoc` overrides
   * the backup content (in-place migrations keep the pre-migration document there).
   * Failures are logged and thrown.
   */
  function persistSync(doc: JsonStoreDocument, options: JsonStorePersistOptions = {}): void {
    let text: string | null = null
    try {
      mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
      text = `${JSON.stringify(doc, undefined, 2)}\n`
      const backupText = options.backupDoc === undefined
        ? text
        : `${JSON.stringify(options.backupDoc, undefined, 2)}\n`
      atomicWritePrivateFileNoFollow(backupPath, backupText, { mode: fileMode })
      atomicWritePrivateFileNoFollow(filePath, text, { mode: fileMode })
      lastPersistSucceededAt = Date.now()
      recoveryState = null
    } catch (error) {
      const onlinePublished = text !== null && isExactMainReadback(text)
      warn(`json-store: failed to persist ${filePath}: ${String(error)}`)
      throw new JsonStorePersistError(filePath, error, onlinePublished)
    }
  }

  /**
   * Read main → .bak → initial. Throws when both leaves are unusable (double
   * corruption — never a fake-empty). A valid .bak loads with an explicit recoveryState
   * and main is NOT rewritten, so the state stays visible.
   */
  function readDocument(): {
    doc: JsonStoreDocument
    dropped: JsonStoreDroppedCounts
    recoveryState: JsonStoreRecoveryState
  } {
    let mainMissing = false
    let mainError: unknown = null
    let mainResult: JsonStoreValidateResult | null = null
    try {
      mainResult = validateParsed(readParsed(filePath))
    } catch (error) {
      mainError = error
      mainMissing = isAbsentPathError(error)
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
    let backupMissing = false
    let backupError: unknown = null
    let backupResult: JsonStoreValidateResult | null = null
    try {
      backupResult = validateParsed(readParsed(backupPath))
    } catch (error) {
      backupError = error
      backupMissing = isAbsentPathError(error)
      /* keep null */
    }
    if (backupResult !== null) {
      const { doc, dropped: droppedCounts } = backupResult
      return { doc, dropped: droppedCounts, recoveryState: { source: 'backup' as const, dropped: droppedCounts } }
    }
    if (!mainMissing) {
      throw new Error(`${filePath} is corrupt and no valid backup (${backupPath}) is available`, {
        cause: new AggregateError([mainError, backupError], 'main and backup are unusable'),
      })
    }
    if (!backupMissing) {
      // Main missing + backup corrupt/unsafe is evidence of a torn or tampered write;
      // initializing would let the next mutation overwrite the only recovery evidence.
      throw new Error(`${filePath} is missing and backup ${backupPath} is corrupt or unsafe`, { cause: backupError })
    }
    return { doc: cloneInitial(), dropped: zeroDropped(), recoveryState: null }
  }

  function hasDropped(counts: JsonStoreDroppedCounts): boolean {
    return counts.connections > 0 || counts.projects > 0
  }

  /**
   * Apply a mutator to the in-memory document: read current → construct next → bump
   * revision on change → swap state. Fully synchronous, so callers cannot interleave.
   */
  function apply(mutator: JsonStoreMutator): JsonStoreMutateResult {
    // Mutators work on a clone: an in-place mutator cannot corrupt the live document before commit.
    const doc: JsonStoreDocument = structuredClone(state ?? cloneInitial())
    const result = mutator(doc)
    if (!result.changed) return result
    result.next.revision = (doc.revision ?? 0) + 1
    state = result.next
    return result
  }

  return {
    /**
     * Load the document (main → .bak → initial). A hook-flagged in-place migration is
     * persisted here (pre-migration document as the backup); a backup-loaded document
     * is never rewritten. Throws on double corruption.
     */
    load(): JsonStoreDocument {
      const outcome = readDocument()
      state = outcome.doc
      recoveryState = outcome.recoveryState
      dropped = outcome.dropped
      return state
    },

    /** The live in-memory document (no clone), for synchronous store owners; never hand this to routes. */
    getDoc() {
      return state ?? cloneInitial()
    },

    /** Deep-cloned snapshot (never the internal document). */
    getSnapshot() {
      return Promise.resolve(structuredClone(state ?? cloneInitial()))
    },

    /**
     * Apply a mutation: the mutator returns {next, changed}; a changed mutation bumps
     * revision, swaps the document, then commits with a synchronous backup-first write.
     * A failed write restores the prior state unless exact readback proves the intended
     * revision is online; either way it throws synchronously.
     */
    mutate(mutator: JsonStoreMutator): Promise<JsonStoreMutateResult> {
      const previous = state
      const result = apply(mutator)
      if (!result.changed) return Promise.resolve(result)
      try {
        persistSync(result.next)
      } catch (error) {
        if (!(error instanceof JsonStorePersistError && error.onlinePublished)) state = previous
        throw error
      }
      return Promise.resolve(result)
    },

    /**
     * mutate with an If-Match guard: rejects with JsonStoreRevisionConflictError
     * ('revision conflict') when doc.revision !== expectedRevision, before anything is
     * applied. `expectedRevision === undefined` disables the check.
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
        if (!(error instanceof JsonStorePersistError && error.onlinePublished)) state = previous
        throw error
      }
      return Promise.resolve(result)
    },

    /**
     * Run a backup-first persist. `doc` defaults to the current document; `backupDoc`
     * overrides the .bak content (migrations). Resolves with whether both files were written.
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
