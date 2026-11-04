/**
 * Forward child lifecycle: the crash-safe registry + startup reaper for ssh
 * forward children (design 28, W0/S1 slice).
 *
 * THE PROBLEM THIS MODULE ADDRESSES.
 * A forward is an `ssh -N -L ...` child. Normal paths (release, source delete,
 * app exit) stop it in-process, but the main process can be SIGKILLed / crash.
 * The child then keeps its local listener alive until the connection dies — a
 * tunnel that any local process may use, with no UI that knows it exists. Two
 * bounded mitigations, both implemented here as PURE logic over adapters:
 *   1. every spawned child is recorded (`forward-children.json`: pid + a
 *      platform start-time token + the exact argv) before it can be forgotten;
 *      the record is written through a 0600/ACL adapter;
 *   2. the NEXT launch reaps records whose process provably IS the recorded
 *      child: pid AND start-time AND full argv must match, so a recycled pid or
 *      a forged file can never make the app kill an unrelated process
 *      ("unprovable => do not kill": the fail-closed rule).
 * The residual window is explicitly bounded and documented: after kill -9 the
 * listener survives until the next app start (or until the connection drops on
 * its own); there is no parent-death signal. POSIX gains a process-group kill
 * (`detached` spawn + `kill(-pgid)`) so the whole ssh tree dies together;
 * Windows uses `taskkill /T /F` because this package has no native Job Object
 * addon (security review I4 — the option is not available, not merely unchosen).
 *
 * WHAT IS NOT HERE.
 * - Spawning, signal escalation and askpass leases belong to the launcher
 *   adapter (remote-forward-manager.ts ForwardChildLauncher; integration TODO).
 * - Reading /proc, ps or CIM belongs to ForwardProcessProbe; building the
 *   actual taskkill argv is the one pure win32 piece exported below so it can
 *   be asserted without a Windows host.
 * - The ledger never deletes a file; the storage adapter owns atomic replace
 *   and the owner-only ACL.
 *
 * STORAGE SEMANTICS.
 * - `inspect(pid)` MUST return null only when the OS proves the pid does not
 *   exist; any uncertainty is an exception (the reaper then treats the record
 *   as unprovable and never kills).
 * - Corrupt registry JSON fails CLOSED: the ledger refuses to load, so the app
 *   starts forwarding only after the file is repaired/rotated, instead of
 *   silently forgetting live children.
 */
import { isForwardAliasHost } from './remote-forward-namespace.ts'

/** Persisted schema version of forward-children.json. */
export const FORWARD_CHILD_REGISTRY_VERSION = 1

/** Hard bound on records (8/source * 32 sources leaves headroom; corrupt files cannot balloon). */
export const FORWARD_CHILD_REGISTRY_MAX_ENTRIES = 256

/**
 * Documented crash semantics (tests assert the flags stay true):
 *   - the reaper runs at the next start, so the exposure window is bounded by
 *     "until the next launch", not by a timer;
 *   - a kill requires the full identity triple (pid, start-time, argv);
 *   - unreadable ownership/identity => no kill.
 */
export const FORWARD_REAP_SEMANTICS = Object.freeze({
  window: 'next-start',
  requiresPid: true,
  requiresStartTime: true,
  requiresArgv: true,
  failClosed: true,
})

/** One recorded child (the ONLY durable facts about a forward child). */
export interface ForwardChildRecord {
  readonly forwardId: string
  readonly sourceId: string
  readonly pid: number
  /** Opaque, platform-normalized process start token (Linux /proc field 22, ps lstart, CIM CreationDate). */
  readonly startTime: string
  /** Exact argv the child was spawned with (shell:false). */
  readonly argv: readonly string[]
  /** POSIX process-group id (== pid when spawned detached); null outside POSIX. */
  readonly pgid: number | null
  readonly localHost: string
  readonly localPort: number
  readonly targetPort: number
  /** Main-clock watermark when the record was committed. */
  readonly recordedAt: number
}

/** Persisted file shape (strict, versioned). */
export interface ForwardChildRegistryFile {
  readonly version: typeof FORWARD_CHILD_REGISTRY_VERSION
  readonly children: readonly ForwardChildRecord[]
}

/** Storage adapter: the only fs seam (0600/ACL + atomic replace live behind it). */
export interface ForwardChildRegistryStorage {
  read(): Promise<string | null>
  write(text: string): Promise<void>
  /**
   * Optional ownership attestation (win32 ACL / POSIX mode re-check). When it
   * exists and returns false, the reaper kills NOTHING (fail closed).
   */
  verifyOwner?(): Promise<boolean>
}

/** Typed lifecycle failure. */
export type ForwardLifecycleErrorCode =
  | 'child_registry_corrupt'
  | 'child_registry_unavailable'
  | 'child_registry_not_loaded'
  | 'child_registry_full'
  | 'invalid_child_record'

/** Typed lifecycle error (never a bare Error: main maps the code). */
export class ForwardLifecycleError extends Error {
  readonly code: ForwardLifecycleErrorCode

  constructor(code: ForwardLifecycleErrorCode, message: string) {
    super(message)
    this.name = 'ForwardLifecycleError'
    this.code = code
  }
}

/** One live-process observation returned by the platform probe. */
export interface ForwardProcessSnapshot {
  readonly pid: number
  readonly startTime: string
  readonly argv: readonly string[]
}

/**
 * Platform process probe (POSIX /proc|ps; win32 CIM). `remote-forward-service.ts`
 * implements all three; win32 CommandLine is tokenized by
 * remote-forward-windows.ts exactly like spawn argv, else fail-closed.
 */
export interface ForwardProcessProbe {
  /** null ONLY when the pid provably does not exist; throw when unknown. */
  inspect(pid: number): Promise<ForwardProcessSnapshot | null>
}

/** One kill request handed to the platform adapter. */
export interface ForwardKillPlan {
  readonly pid: number
  readonly pgid: number | null
}

/** Kill outcome; `not_found` is a success for reaping (nothing alive to kill). */
export type ForwardKillOutcome = 'killed' | 'not_found' | 'failed'

/**
 * Platform kill adapter (POSIX process group / win32 taskkill /T /F).
 * `remote-forward-service.ts` implements both; neither is called before the
 * identity triple (pid/start-time/argv) matched.
 */
export interface ForwardKiller {
  kill(plan: ForwardKillPlan): Promise<ForwardKillOutcome>
}

/** Ledger port consumed by the reaper (the class below implements it). */
export interface ForwardChildLedgerPort {
  list(): readonly ForwardChildRecord[]
  remove(forwardId: string): Promise<void>
}

/** Spawn supervision the launcher MUST apply for the reaper to reach the tree. */
export interface ForwardSpawnSupervision {
  /** POSIX: detached:true (own process group). win32: false (no Job Object addon). */
  readonly detached: boolean
  /** POSIX process-group id (pid at spawn); null on win32. */
  readonly pgid: number | null
}

/** Pure spawn-supervision policy per platform. */
export function forwardSpawnSupervision(platform: 'posix' | 'win32', pid: number): ForwardSpawnSupervision {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('invalid pid: ' + String(pid))
  return platform === 'posix' ? { detached: true, pgid: pid } : { detached: false, pgid: null }
}

function executableIdentity(value: string): string {
  const base = value.split(/[\\/]/u).pop() ?? value
  return base.toLowerCase().replace(/\.exe$/u, '')
}

/** The bind argument recorded in argv; the reaper requires it to be present. */
export function forwardBindSpec(record: Pick<ForwardChildRecord, 'localHost' | 'localPort' | 'targetPort'>): string {
  return record.localHost + ':' + String(record.localPort) + ':127.0.0.1:' + String(record.targetPort)
}

/** POSIX kill target: the negative process-group id when detached, else the pid. */
export function posixKillTarget(record: Pick<ForwardChildRecord, 'pid' | 'pgid'>): number {
  return record.pgid !== null && Number.isSafeInteger(record.pgid) && record.pgid > 1 ? -record.pgid : record.pid
}

/** Windows taskkill argv (options before the pid value; /T kills the tree, /F forces). */
export function windowsTaskkillArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('invalid pid: ' + String(pid))
  return ['/PID', String(pid), '/T', '/F']
}

const FORWARD_ID_PATTERN = /^fwd-[0-9a-f]{16,64}$/u
const SOURCE_ID_PATTERN = /^(?:dsh|gateway|ssh)-[A-Za-z0-9_-]{1,64}$/u
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositivePid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value)
  return present.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Validate one record (used by parse AND by ledger.add). */
export function validateForwardChildRecord(value: unknown): ForwardChildRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ForwardLifecycleError('invalid_child_record', 'child record is not an object')
  }
  const record = value as Record<string, unknown>
  if (!exactKeys(record, [
    'forwardId', 'sourceId', 'pid', 'startTime', 'argv', 'pgid',
    'localHost', 'localPort', 'targetPort', 'recordedAt',
  ])) {
    throw new ForwardLifecycleError('invalid_child_record', 'child record has an unexpected key set')
  }
  if (typeof record.forwardId !== 'string' || !FORWARD_ID_PATTERN.test(record.forwardId)) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid forward id')
  }
  if (typeof record.sourceId !== 'string' || !SOURCE_ID_PATTERN.test(record.sourceId)) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid source id')
  }
  if (!isPositivePid(record.pid)) throw new ForwardLifecycleError('invalid_child_record', 'invalid pid')
  if (typeof record.startTime !== 'string' || record.startTime.length === 0
    || record.startTime.length > 128 || CONTROL_CHARS.test(record.startTime)) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid start-time token')
  }
  if (!Array.isArray(record.argv) || record.argv.length === 0 || record.argv.length > 64) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid argv (length 1..64)')
  }
  for (const arg of record.argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 4096 || CONTROL_CHARS.test(arg)) {
      throw new ForwardLifecycleError('invalid_child_record', 'invalid argv element')
    }
  }
  if (record.pgid !== null && !isPositivePid(record.pgid)) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid pgid')
  }
  if (!isForwardAliasHost(record.localHost)) {
    throw new ForwardLifecycleError('invalid_child_record', 'localHost is not a forward alias')
  }
  if (!Number.isSafeInteger(record.localPort) || (record.localPort as number) < 1024 || (record.localPort as number) > 65535) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid local port')
  }
  if (!Number.isSafeInteger(record.targetPort) || (record.targetPort as number) < 1 || (record.targetPort as number) > 65535) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid target port')
  }
  if (!isWatermark(record.recordedAt)) {
    throw new ForwardLifecycleError('invalid_child_record', 'invalid recordedAt watermark')
  }
  const normalized: ForwardChildRecord = {
    forwardId: record.forwardId,
    sourceId: record.sourceId,
    pid: record.pid,
    startTime: record.startTime,
    argv: [...record.argv] as string[],
    pgid: record.pgid as number | null,
    localHost: record.localHost as string,
    localPort: record.localPort as number,
    targetPort: record.targetPort as number,
    recordedAt: record.recordedAt,
  }
  // The recorded argv must describe exactly this binding: a file that pairs a
  // listener with an unrelated command line is corrupt, not merely skipped.
  if (!normalized.argv.includes(forwardBindSpec(normalized))) {
    throw new ForwardLifecycleError('invalid_child_record', 'argv does not carry the recorded bind spec')
  }
  return normalized
}

/** Parse + validate forward-children.json. null/empty = empty registry. */
export function parseForwardChildRegistry(text: string | null): ForwardChildRegistryFile {
  if (text === null || text.trim() === '') {
    return { version: FORWARD_CHILD_REGISTRY_VERSION, children: [] }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ForwardLifecycleError('child_registry_corrupt', 'forward children file is not JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ForwardLifecycleError('child_registry_corrupt', 'forward children root is not an object')
  }
  const root = raw as Record<string, unknown>
  if (!exactKeys(root, ['version', 'children'])) {
    throw new ForwardLifecycleError('child_registry_corrupt', 'forward children file has an unexpected key set')
  }
  if (root.version !== FORWARD_CHILD_REGISTRY_VERSION) {
    throw new ForwardLifecycleError('child_registry_corrupt', 'unsupported forward children schema: ' + String(root.version))
  }
  if (!Array.isArray(root.children)) {
    throw new ForwardLifecycleError('child_registry_corrupt', 'forward children is not an array')
  }
  if (root.children.length > FORWARD_CHILD_REGISTRY_MAX_ENTRIES) {
    throw new ForwardLifecycleError('child_registry_corrupt', 'forward children exceeds the record bound')
  }
  const children = root.children.map((entry, index) => {
    try {
      return validateForwardChildRecord(entry)
    } catch (error) {
      // A malformed entry makes the FILE corrupt (fail closed), not merely one
      // invalid record: the caller must not proceed with a partially trusted list.
      if (error instanceof ForwardLifecycleError) {
        throw new ForwardLifecycleError('child_registry_corrupt', 'children[' + String(index) + ']: ' + error.message)
      }
      throw error
    }
  })
  const ids = new Set<string>()
  const pids = new Set<number>()
  for (const child of children) {
    if (ids.has(child.forwardId)) {
      throw new ForwardLifecycleError('child_registry_corrupt', 'duplicate forward id: ' + child.forwardId)
    }
    ids.add(child.forwardId)
    if (pids.has(child.pid)) {
      throw new ForwardLifecycleError('child_registry_corrupt', 'duplicate pid: ' + String(child.pid))
    }
    pids.add(child.pid)
  }
  return { version: FORWARD_CHILD_REGISTRY_VERSION, children }
}

/** Serialize in one stable byte shape (schema v1, trailing newline). */
export function serializeForwardChildRegistry(file: ForwardChildRegistryFile): string {
  return JSON.stringify({ version: file.version, children: file.children }, null, 2) + '\n'
}

/**
 * Identity match for the reaper: pid + start-time token + the FULL argv,
 * including the recorded bind spec. Any missing proof is a mismatch — the
 * reaper then does not kill (fail closed).
 */
export function matchesForwardChild(record: ForwardChildRecord, snapshot: ForwardProcessSnapshot): boolean {
  if (snapshot.pid !== record.pid) return false
  if (snapshot.startTime !== record.startTime) return false
  // New records carry the full argv (program name included). Records written by
  // the first S1 slice carry only buildForwardArgs() (no argv[0]); accept that
  // shape as a migration window so a crash before the upgrade is still reapable.
  const prefixOnly = snapshot.argv.length === record.argv.length + 1
  if (prefixOnly && executableIdentity(snapshot.argv[0]) !== 'ssh') return false
  const candidate = snapshot.argv.length === record.argv.length
    ? snapshot.argv
    : prefixOnly
      ? snapshot.argv.slice(1)
      : null
  if (candidate === null) return false
  for (let index = 0; index < record.argv.length; index += 1) {
    if (candidate[index] === record.argv[index]) continue
    // argv[0] may be an absolute path or a Windows .exe spelling while the
    // ledger records the bare program name. Compare the executable identity;
    // every forwarding argument after it remains exact.
    if (index === 0 && executableIdentity(candidate[index]) === executableIdentity(record.argv[index])) continue
    return false
  }
  return record.argv.includes(forwardBindSpec(record))
}

/** The durable ledger (write-through; serialized mutations). */
export class ForwardChildLedger implements ForwardChildLedgerPort {
  readonly #storage: ForwardChildRegistryStorage
  readonly #now: () => number
  #children: ForwardChildRecord[] = []
  #loaded = false
  #tail: Promise<unknown> = Promise.resolve()

  constructor(options: { storage: ForwardChildRegistryStorage; now?: () => number }) {
    this.#storage = options.storage
    this.#now = options.now ?? (() => Date.now())
  }

  get loaded(): boolean {
    return this.#loaded
  }

  /** Read + validate. A corrupt file throws and leaves the ledger unusable. */
  load(): Promise<void> {
    return this.#run(async () => {
      await this.#loadLocked()
    })
  }

  /** Record a child BEFORE it can be forgotten; rejects on duplicates/full. */
  add(input: Omit<ForwardChildRecord, 'recordedAt'> & { recordedAt?: number }): Promise<ForwardChildRecord> {
    let record: ForwardChildRecord
    try {
      record = validateForwardChildRecord({
        ...input,
        recordedAt: input.recordedAt ?? this.#now(),
      })
    } catch (error) {
      return Promise.reject(error)
    }
    return this.#run(async () => {
      await this.#loadLocked()
      if (this.#children.some(child => child.forwardId === record.forwardId)) {
        throw new ForwardLifecycleError('invalid_child_record', 'forward id already recorded: ' + record.forwardId)
      }
      if (this.#children.some(child => child.pid === record.pid)) {
        throw new ForwardLifecycleError('invalid_child_record', 'pid already recorded: ' + String(record.pid))
      }
      if (this.#children.length >= FORWARD_CHILD_REGISTRY_MAX_ENTRIES) {
        throw new ForwardLifecycleError('child_registry_full', 'forward child registry is full')
      }
      await this.#commit([...this.#children, record])
      return record
    })
  }

  /** Forget one child (normal exit / proven-gone reaping). Missing id is a no-op. */
  remove(forwardId: string): Promise<void> {
    return this.#run(async () => {
      await this.#loadLocked()
      const next = this.#children.filter(child => child.forwardId !== forwardId)
      if (next.length === this.#children.length) return
      await this.#commit(next)
    })
  }

  /** Snapshot in record order. */
  list(): readonly ForwardChildRecord[] {
    this.#assertLoaded()
    return this.#children.map(child => ({ ...child, argv: [...child.argv] }))
  }

  async #run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task, task)
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  #assertLoaded(): void {
    if (!this.#loaded) throw new ForwardLifecycleError('child_registry_not_loaded', 'forward child ledger has not been loaded')
  }

  async #loadLocked(): Promise<void> {
    if (this.#loaded) return
    let text: string | null
    try {
      text = await this.#storage.read()
    } catch (error) {
      throw new ForwardLifecycleError(
        'child_registry_unavailable',
        'forward children could not be read: ' + (error instanceof Error ? error.message : 'unknown error'),
      )
    }
    this.#children = [...parseForwardChildRegistry(text).children]
    this.#loaded = true
  }

  async #commit(children: readonly ForwardChildRecord[]): Promise<void> {
    try {
      await this.#storage.write(serializeForwardChildRegistry({
        version: FORWARD_CHILD_REGISTRY_VERSION,
        children: [...children],
      }))
    } catch (error) {
      throw new ForwardLifecycleError(
        'child_registry_unavailable',
        'forward children could not be written: ' + (error instanceof Error ? error.message : 'unknown error'),
      )
    }
    this.#children = [...children]
  }
}

/** Why one record was (not) reaped. */
export type ForwardReapReason =
  | 'killed'
  | 'already_gone'
  | 'identity_mismatch'
  | 'unprovable'
  | 'kill_failed'
  | 'registry_untrusted'

/** One reaper verdict (never throws per record). */
export interface ForwardReapVerdict {
  readonly forwardId: string
  readonly pid: number
  readonly reason: ForwardReapReason
  /** True only when the record was removed from the ledger. */
  readonly removed: boolean
}

/** Aggregate reaper result. */
export interface ForwardReapReport {
  /** False = ownership attestation failed; nothing was killed or removed. */
  readonly trusted: boolean
  readonly verdicts: readonly ForwardReapVerdict[]
  readonly reaped: number
  readonly remaining: number
}

/** Input of one startup reap pass. */
export interface ForwardReapInput {
  readonly ledger: ForwardChildLedgerPort
  readonly probe: ForwardProcessProbe
  readonly killer: ForwardKiller
  /** Platform-specific kill plan builder; defaults to POSIX process-group semantics. */
  readonly planFor?: (record: ForwardChildRecord) => ForwardKillPlan
  /** Optional storage ownership attestation (ACL/mode); false = trust nothing. */
  readonly verifyOwnership?: () => Promise<boolean>
}

function defaultPlan(record: ForwardChildRecord): ForwardKillPlan {
  return { pid: record.pid, pgid: posixKillTarget(record) < 0 ? record.pgid : null }
}

/**
 * One startup reap pass over the durable ledger.
 *
 * Per record:
 *   - probe says "no such pid"        -> remove the tombstone (nothing to kill);
 *   - probe fails / ownership refused -> keep, DO NOT kill (unprovable);
 *   - identity triple mismatches      -> keep, DO NOT kill (pid reuse / forgery);
 *   - identity matches                -> kill (POSIX process group / win32 taskkill);
 *       'killed' | 'not_found' -> remove; 'failed' -> keep and report.
 *
 * Never throws for one bad record; a storage failure while removing propagates
 * (the ledger stays authoritative for the next launch).
 */
export async function reapForwardChildren(input: ForwardReapInput): Promise<ForwardReapReport> {
  const records = [...input.ledger.list()]
  let trusted = true
  if (input.verifyOwnership !== undefined) {
    try {
      trusted = await input.verifyOwnership()
    } catch {
      trusted = false
    }
  }
  if (!trusted) {
    return {
      trusted: false,
      verdicts: records.map(record => ({
        forwardId: record.forwardId,
        pid: record.pid,
        reason: 'registry_untrusted' as const,
        removed: false,
      })),
      reaped: 0,
      remaining: records.length,
    }
  }
  const verdicts: ForwardReapVerdict[] = []
  let reaped = 0
  for (const record of records) {
    let snapshot: ForwardProcessSnapshot | null
    try {
      snapshot = await input.probe.inspect(record.pid)
    } catch {
      verdicts.push({ forwardId: record.forwardId, pid: record.pid, reason: 'unprovable', removed: false })
      continue
    }
    if (snapshot === null) {
      await input.ledger.remove(record.forwardId)
      verdicts.push({ forwardId: record.forwardId, pid: record.pid, reason: 'already_gone', removed: true })
      reaped += 1
      continue
    }
    if (!matchesForwardChild(record, snapshot)) {
      verdicts.push({ forwardId: record.forwardId, pid: record.pid, reason: 'identity_mismatch', removed: false })
      continue
    }
    let outcome: ForwardKillOutcome
    try {
      outcome = await input.killer.kill((input.planFor ?? defaultPlan)(record))
    } catch {
      outcome = 'failed'
    }
    if (outcome === 'killed' || outcome === 'not_found') {
      await input.ledger.remove(record.forwardId)
      verdicts.push({
        forwardId: record.forwardId,
        pid: record.pid,
        reason: outcome === 'killed' ? 'killed' : 'already_gone',
        removed: true,
      })
      reaped += 1
      continue
    }
    verdicts.push({ forwardId: record.forwardId, pid: record.pid, reason: 'kill_failed', removed: false })
  }
  return {
    trusted: true,
    verdicts,
    reaped,
    remaining: records.length - reaped,
  }
}
