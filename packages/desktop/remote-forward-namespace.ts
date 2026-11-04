/**
 * Browser identity (namespace) store for remote-browser forwards — W0/S1 pure
 * logic, design 28 ("Browser alias identity").
 *
 * WHY A PERSISTED NAMESPACE, NOT A HASH OF sourceId/fingerprint.
 * The browser alias 127.0.0.n is a SYSTEM-BROWSER host: cookies, localStorage
 * and Service Workers persist there after the app forgets the source. Two
 * repository facts make the obvious keys unusable:
 *   - sourceId survives a retarget (same id, new host/user/port), so hashing it
 *     would hand the new machine the old machine's browser storage;
 *   - sourceFingerprint is minted per process (randomBytes in notifications.ts),
 *     so hashing it would change the alias on every restart and lose the user's
 *     session state.
 * The identity key is therefore a PERSISTED 16-bit `namespace`, minted once per
 * (source, identity) and written next to the connection state; the alias is a
 * deterministic function of that namespace plus the set of aliases already
 * handed out. The caller supplies a stable `identity` digest (host/user/
 * sshPort/remotePort) and a fresh `ensure` with a different digest rotates the
 * namespace AND the alias.
 *
 * INVARIANTS (each one is a security property, each has a negative test):
 *   1. aliases live in 127.0.0.2 .. 127.0.0.254; .1 is never allocated, so a
 *      forward can never land in the host's real loopback origin (.0/.255 are
 *      excluded by construction as well);
 *   2. an alias is NEVER handed to a different namespace — retired entries stay
 *      as tombstones, so deleting "dev A" can never leak its browser storage to
 *      the next source that asks for an alias;
 *   3. allocation is deterministic: smallest free alias from the namespace's
 *      preferred octet, wrapping once. Given the same persisted state the same
 *      namespace always gets the same alias, regardless of startup order;
 *   4. one active entry per source; retarget/delete retires (never reuses);
 *   5. a corrupt store fails CLOSED — the manager refuses to allocate rather
 *      than start from an empty file that would reuse unknown aliases.
 *
 * NO fs / NO CLOCK / NO CRYPTO: persistence is a typed adapter (the real one
 * writes <userData>/remote-browser-namespaces.json with 0600/ACL, atomic
 * replace) and every side effect is injected, so the whole allocation policy is
 * testable without a home directory.
 *
 * LIFETIME CAPACITY. Aliases are retired forever, so 253 distinct assignments
 * are the lifetime budget; `ensure` fails with `alias_exhausted` when the pool
 * is gone. Clearing the store is an explicit user decision (it also accepts
 * browser-storage inheritance) and is deliberately NOT offered here.
 */

/** First usable alias octet (127.0.0.1 is the host's real loopback — never ours). */
export const FORWARD_ALIAS_MIN_OCTET = 2

/** Last usable alias octet (127.0.0.255 is the subnet broadcast spelling). */
export const FORWARD_ALIAS_MAX_OCTET = 254

/** 2..254 inclusive. */
export const FORWARD_ALIAS_CAPACITY = FORWARD_ALIAS_MAX_OCTET - FORWARD_ALIAS_MIN_OCTET + 1

/** Persisted schema version of the namespace file. */
export const FORWARD_NAMESPACE_STATE_VERSION = 1

/** Source-id grammar (local is not a source; legacy ssh- ids are dsh aliases). */
const SOURCE_ID_PATTERN = /^(?:dsh|gateway|ssh)-[A-Za-z0-9_-]{1,64}$/u

/** Stable identity digest: caller-computed, printable, bounded. */
const IDENTITY_PATTERN = /^[A-Za-z0-9._:-]{8,512}$/u

/** Every namespace error is typed so main can map it to one wire error code. */
export type ForwardNamespaceErrorCode =
  | 'namespace_store_corrupt'
  | 'namespace_store_unavailable'
  | 'namespace_invalid_input'
  | 'namespace_not_loaded'
  | 'alias_exhausted'

/** Typed namespace failure (never a bare Error: the code is the contract). */
export class ForwardNamespaceError extends Error {
  readonly code: ForwardNamespaceErrorCode

  constructor(code: ForwardNamespaceErrorCode, message: string) {
    super(message)
    this.name = 'ForwardNamespaceError'
    this.code = code
  }
}

/** Canonical alias host for one octet; the ONLY place the string is built. */
export function forwardAliasHost(octet: number): string {
  if (!Number.isInteger(octet) || octet < FORWARD_ALIAS_MIN_OCTET || octet > FORWARD_ALIAS_MAX_OCTET) {
    throw new RangeError('forward alias octet out of range: ' + String(octet))
  }
  return '127.0.0.' + String(octet)
}

/**
 * Alias predicate 127.0.0.2..127.0.0.254 (leading zeros rejected).
 * Kept as a leaf spelling; a lockstep test proves it agrees with the wire
 * contract's copy over the full grid.
 */
export function isForwardAliasHost(value: unknown): value is string {
  return typeof value === 'string'
    && /^127\.0\.0\.(?:[2-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-4])$/u.test(value)
}

/** The namespace's first-choice alias octet. */
export function preferredAliasOctet(namespace: number): number {
  if (!Number.isSafeInteger(namespace) || namespace < 0 || namespace > 0xffff) {
    throw new RangeError('invalid forward namespace: ' + String(namespace))
  }
  return FORWARD_ALIAS_MIN_OCTET + (namespace % FORWARD_ALIAS_CAPACITY)
}

/**
 * First alias not present in `usedHosts`, starting at the namespace's preferred
 * octet and wrapping once. Deterministic for a given (namespace, usedHosts) and
 * the single allocator for both first assignment and post-retire allocation.
 * @throws ForwardNamespaceError('alias_exhausted') when all 253 hosts are burned.
 */
export function allocateForwardAlias(namespace: number, usedHosts: ReadonlySet<string>): string {
  const start = preferredAliasOctet(namespace)
  for (let step = 0; step < FORWARD_ALIAS_CAPACITY; step += 1) {
    const octet = FORWARD_ALIAS_MIN_OCTET
      + ((start - FORWARD_ALIAS_MIN_OCTET + step) % FORWARD_ALIAS_CAPACITY)
    const host = forwardAliasHost(octet)
    if (!usedHosts.has(host)) return host
  }
  throw new ForwardNamespaceError(
    'alias_exhausted',
    'all ' + String(FORWARD_ALIAS_CAPACITY) + ' browser alias hosts are retired; refusing to reuse one',
  )
}

/** One assignment record; retired entries stay FOREVER as tombstones. */
export interface ForwardNamespaceEntry {
  readonly sourceId: string
  /** 16-bit persisted browser namespace. */
  readonly namespace: number
  /** 127.0.0.2..127.0.0.254, unique across active AND retired entries. */
  readonly aliasHost: string
  /** Caller-computed stable identity digest (host/user/sshPort/remotePort). */
  readonly identity: string
  /** Main-clock watermark of the assignment. */
  readonly assignedAt: number
  /** null while active; a watermark once retired (retarget/delete). */
  readonly retiredAt: number | null
}

/** Persisted file shape (schema version 1, strict key set). */
export interface ForwardNamespaceState {
  readonly version: typeof FORWARD_NAMESPACE_STATE_VERSION
  readonly entries: readonly ForwardNamespaceEntry[]
}

/** One active assignment handed to the manager. */
export interface ForwardNamespaceAssignment {
  readonly sourceId: string
  readonly namespace: number
  readonly aliasHost: string
}

/**
 * Storage adapter: the only fs seam. `remote-forward-service.ts` wires it to
 * `<userData>/remote-browser/remote-browser-namespaces.json` through the
 * repository's 0600 private-file writer; tests inject memory stores.
 */
export interface ForwardNamespaceStorage {
  /** Read the raw file; null = absent (first run). I/O failures must reject. */
  read(): Promise<string | null>
  /** Replace the file atomically; failures must reject (the caller commits nothing). */
  write(text: string): Promise<void>
}

/** Entropy seam: one 16-bit namespace per call. */
export type ForwardNamespaceMint = () => number

/** Options: every side effect injected (tests use fakes; main wires the real ones). */
export interface ForwardNamespaceOptions {
  readonly storage: ForwardNamespaceStorage
  /** Main clock (watermarks only). */
  readonly now?: () => number
  /** 16-bit namespace mint; defaults to a crypto-free Math.random draw. */
  readonly mintNamespace?: ForwardNamespaceMint
}

/** Input of one ensure call. */
export interface ForwardNamespaceEnsureInput {
  readonly sourceId: string
  readonly identity: string
}

function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value)
  return present.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validateEntry(value: unknown, index: number): ForwardNamespaceEntry {
  const at = 'entries[' + String(index) + ']'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + ' is not an object')
  }
  const record = value as Record<string, unknown>
  if (!exactKeys(record, ['sourceId', 'namespace', 'aliasHost', 'identity', 'assignedAt', 'retiredAt'])) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + ' has an unexpected key set')
  }
  if (typeof record.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(record.sourceId)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + '.sourceId is invalid')
  }
  if (!Number.isSafeInteger(record.namespace) || (record.namespace as number) < 0 || (record.namespace as number) > 0xffff) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + '.namespace is not a 16-bit integer')
  }
  if (!isForwardAliasHost(record.aliasHost)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + '.aliasHost is outside 127.0.0.2..254')
  }
  if (typeof record.identity !== 'string' || !IDENTITY_PATTERN.test(record.identity)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + '.identity is invalid')
  }
  if (!isWatermark(record.assignedAt)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + '.assignedAt is not a watermark')
  }
  if (record.retiredAt !== null && !isWatermark(record.retiredAt)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + '.retiredAt is not a watermark/null')
  }
  if (record.retiredAt !== null && (record.retiredAt as number) < (record.assignedAt as number)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', at + '.retiredAt predates assignedAt')
  }
  return {
    sourceId: record.sourceId,
    namespace: record.namespace as number,
    aliasHost: record.aliasHost as string,
    identity: record.identity,
    assignedAt: record.assignedAt as number,
    retiredAt: record.retiredAt as number | null,
  }
}

/**
 * Parse + validate the persisted state. `null`/empty text is the empty state.
 * Anything malformed throws `namespace_store_corrupt`: a store we cannot prove
 * is not retried with an empty one (that would silently reuse aliases).
 */
export function parseForwardNamespaceState(text: string | null): ForwardNamespaceState {
  if (text === null || text.trim() === '') {
    return { version: FORWARD_NAMESPACE_STATE_VERSION, entries: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ForwardNamespaceError('namespace_store_corrupt', 'namespace file is not JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', 'namespace file root is not an object')
  }
  const root = raw as Record<string, unknown>
  if (!exactKeys(root, ['version', 'entries'])) {
    throw new ForwardNamespaceError('namespace_store_corrupt', 'namespace file has an unexpected key set')
  }
  if (root.version !== FORWARD_NAMESPACE_STATE_VERSION) {
    throw new ForwardNamespaceError('namespace_store_corrupt', 'unsupported namespace schema version: ' + String(root.version))
  }
  if (!Array.isArray(root.entries)) {
    throw new ForwardNamespaceError('namespace_store_corrupt', 'namespace entries is not an array')
  }
  const entries = root.entries.map((entry, index) => validateEntry(entry, index))
  const aliases = new Set<string>()
  const activeBySource = new Set<string>()
  for (const entry of entries) {
    if (aliases.has(entry.aliasHost)) {
      throw new ForwardNamespaceError('namespace_store_corrupt', 'alias host reused: ' + entry.aliasHost)
    }
    aliases.add(entry.aliasHost)
    if (entry.retiredAt !== null) continue
    if (activeBySource.has(entry.sourceId)) {
      throw new ForwardNamespaceError('namespace_store_corrupt', 'two active entries for source ' + entry.sourceId)
    }
    activeBySource.add(entry.sourceId)
  }
  return { version: FORWARD_NAMESPACE_STATE_VERSION, entries }
}

/** Serialize the state in one stable byte shape (schema v1, trailing newline). */
export function serializeForwardNamespaceState(state: ForwardNamespaceState): string {
  return JSON.stringify({ version: state.version, entries: state.entries }, null, 2) + '\n'
}

function assignmentOf(entry: ForwardNamespaceEntry): ForwardNamespaceAssignment {
  return { sourceId: entry.sourceId, namespace: entry.namespace, aliasHost: entry.aliasHost }
}

function validateEnsureInput(input: ForwardNamespaceEnsureInput): ForwardNamespaceEnsureInput {
  const raw: unknown = input
  if (typeof raw !== 'object' || raw === null) {
    throw new ForwardNamespaceError('namespace_invalid_input', 'namespace input is not an object')
  }
  if (typeof input.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(input.sourceId)) {
    throw new ForwardNamespaceError('namespace_invalid_input', 'invalid source id')
  }
  if (typeof input.identity !== 'string' || !IDENTITY_PATTERN.test(input.identity)) {
    throw new ForwardNamespaceError('namespace_invalid_input', 'invalid identity digest')
  }
  return { sourceId: input.sourceId, identity: input.identity }
}

/**
 * The namespace store. All public methods are serialized through one promise
 * chain, so concurrent `ensure` calls can never allocate the same alias twice.
 */
export class ForwardNamespaces {
  readonly #storage: ForwardNamespaceStorage
  readonly #now: () => number
  readonly #mint: ForwardNamespaceMint
  #entries: ForwardNamespaceEntry[] = []
  #loaded = false
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: ForwardNamespaceOptions) {
    this.#storage = options.storage
    this.#now = options.now ?? (() => Date.now())
    this.#mint = options.mintNamespace ?? (() => Math.floor(Math.random() * 0x10000))
  }

  /** True after a successful load; `assignment()` refuses to guess before it. */
  get loaded(): boolean {
    return this.#loaded
  }

  /** Read + validate the persisted store. Corrupt/unreadable surfaces as a typed error. */
  load(): Promise<void> {
    return this.#run(async () => {
      await this.#loadLocked()
    })
  }

  /**
   * Return the source's stable assignment, minting/rotating when needed:
   * same identity -> same alias; different identity (retarget) -> old entry retired,
   * NEW namespace and NEW alias; unknown source -> first assignment.
   */
  ensure(input: ForwardNamespaceEnsureInput): Promise<ForwardNamespaceAssignment> {
    let validated: ForwardNamespaceEnsureInput
    try {
      validated = validateEnsureInput(input)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.#run(async () => {
      await this.#loadLocked()
      const entries = this.#entries.map(entry => ({ ...entry }))
      const result = this.#assignLocked(entries, [validated])
      if (result.changed) await this.#commit(entries)
      return result.assignments[0]
    })
  }

  /**
   * Batch form used at startup pre-provisioning: inputs are sorted by source id
   * first, so the FIRST assignment of several sources in one transaction is
   * independent of caller order (the reviewer's "conflicts need a total order").
   * Results are returned in the caller's original order.
   */
  ensureMany(inputs: readonly ForwardNamespaceEnsureInput[]): Promise<ForwardNamespaceAssignment[]> {
    if (!Array.isArray(inputs)) {
      return Promise.reject(new ForwardNamespaceError('namespace_invalid_input', 'namespace inputs is not an array'))
    }
    const validated = inputs.map(validateEnsureInput)
    const seen = new Map<string, string>()
    for (const input of validated) {
      const previous = seen.get(input.sourceId)
      if (previous !== undefined && previous !== input.identity) {
        return Promise.reject(new ForwardNamespaceError(
          'namespace_invalid_input',
          'conflicting identities in one namespace batch: ' + input.sourceId,
        ))
      }
      seen.set(input.sourceId, input.identity)
    }
    return this.#run(async () => {
      await this.#loadLocked()
      const entries = this.#entries.map(entry => ({ ...entry }))
      const ordered = [...validated].sort((left, right) => (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0))
      const result = this.#assignLocked(entries, ordered)
      if (result.changed) await this.#commit(entries)
      const bySource = new Map(result.assignments.map(assignment => [assignment.sourceId, assignment]))
      return validated.map(input => bySource.get(input.sourceId) as ForwardNamespaceAssignment)
    })
  }

  /** Retire the source's active alias (delete / explicit rotation). Returns false when none. */
  retire(sourceId: string): Promise<boolean> {
    if (typeof sourceId !== 'string' || !SOURCE_ID_PATTERN.test(sourceId)) {
      return Promise.reject(new ForwardNamespaceError('namespace_invalid_input', 'invalid source id'))
    }
    return this.#run(async () => {
      await this.#loadLocked()
      const active = this.#activeEntry(sourceId)
      if (active === null) return false
      const entries: ForwardNamespaceEntry[] = this.#entries.map(entry =>
        entry === active ? { ...entry, retiredAt: this.#now() } : { ...entry })
      await this.#commit(entries)
      return true
    })
  }

  /** Active assignment for one source (null when none). Requires a prior load. */
  assignment(sourceId: string): ForwardNamespaceAssignment | null {
    if (!this.#loaded) {
      throw new ForwardNamespaceError('namespace_not_loaded', 'namespace store has not been loaded')
    }
    const active = this.#activeEntry(sourceId)
    return active === null ? null : assignmentOf(active)
  }

  /** All entries (active + tombstones), in assignment order. Requires a prior load. */
  entries(): readonly ForwardNamespaceEntry[] {
    if (!this.#loaded) {
      throw new ForwardNamespaceError('namespace_not_loaded', 'namespace store has not been loaded')
    }
    return this.#entries.map(entry => ({ ...entry }))
  }

  async #run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  async #loadLocked(): Promise<void> {
    if (this.#loaded) return
    let text: string | null
    try {
      text = await this.#storage.read()
    } catch (error) {
      throw new ForwardNamespaceError(
        'namespace_store_unavailable',
        'namespace store could not be read: ' + (error instanceof Error ? error.message : 'unknown error'),
      )
    }
    this.#entries = [...parseForwardNamespaceState(text).entries]
    this.#loaded = true
  }

  #activeEntry(sourceId: string): ForwardNamespaceEntry | null {
    for (const entry of this.#entries) {
      if (entry.sourceId === sourceId && entry.retiredAt === null) return entry
    }
    return null
  }

  /**
   * Mutates `entries`; returns one assignment per input, in input order, plus
   * whether anything changed (an idempotent ensure must not rewrite the file).
   */
  #assignLocked(
    entries: ForwardNamespaceEntry[],
    inputs: readonly ForwardNamespaceEnsureInput[],
  ): { assignments: ForwardNamespaceAssignment[]; changed: boolean } {
    const out: ForwardNamespaceAssignment[] = []
    let changed = false
    for (const input of inputs) {
      const active = entries.find(entry => entry.sourceId === input.sourceId && entry.retiredAt === null)
      if (active !== undefined && active.identity === input.identity) {
        out.push(assignmentOf(active))
        continue
      }
      const now = this.#now()
      if (active !== undefined) {
        entries[entries.indexOf(active)] = { ...active, retiredAt: now }
        changed = true
      }
      const namespace = this.#mintNamespace()
      const used = new Set(entries.map(entry => entry.aliasHost))
      const entry: ForwardNamespaceEntry = {
        sourceId: input.sourceId,
        namespace,
        aliasHost: allocateForwardAlias(namespace, used),
        identity: input.identity,
        assignedAt: now,
        retiredAt: null,
      }
      entries.push(entry)
      out.push(assignmentOf(entry))
      changed = true
    }
    return { assignments: out, changed }
  }

  #mintNamespace(): number {
    let value: number
    try {
      value = this.#mint()
    } catch {
      throw new ForwardNamespaceError('namespace_invalid_input', 'namespace mint threw')
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
      throw new ForwardNamespaceError('namespace_invalid_input', 'namespace mint returned a non-16-bit value')
    }
    return value
  }

  async #commit(entries: readonly ForwardNamespaceEntry[]): Promise<void> {
    if (entries.length > FORWARD_ALIAS_CAPACITY) {
      // Keep the invariant even if the pool is already exhausted: the file only
      // ever holds entries whose aliases are unique, so this is unreachable.
      throw new ForwardNamespaceError('alias_exhausted', 'namespace store exceeds the alias pool')
    }
    const next: ForwardNamespaceState = { version: FORWARD_NAMESPACE_STATE_VERSION, entries: [...entries] }
    try {
      await this.#storage.write(serializeForwardNamespaceState(next))
    } catch (error) {
      throw new ForwardNamespaceError(
        'namespace_store_unavailable',
        'namespace store could not be written: ' + (error instanceof Error ? error.message : 'unknown error'),
      )
    }
    this.#entries = [...entries]
  }
}
