/**
 * state-root-lease.ts —— state 根写者唯一租约。
 *
 * 契约：一个 state 根同一时刻只有一个写者，判据是 <stateRoot>/owner.json 的 O_EXCL
 * 创建与 token/inode：
 *
 *   - 活 pid：响亮拒绝（state_root_locked，携带 holder pid/flavor）；
 *   - 死 pid（ESRCH）：rename 到唯一 .stale-* 证据名，证明移动的正是先前读到的精确
 *     字节 + inode 后重建；任何证明缺口 fail-closed（state_root_takeover_race）；
 *   - 撕裂/空记录：认领 + 告警；release 只按 token + inode 精确删除，不匹配时
 *     state_root_not_owner 且绝不删除；同进程同根第二个 acquire 为 state_root_duplicate。
 *
 * 本模块不 import electron / dsh-runtime，是 control-plane 公共面的一部分。
 */
import { randomBytes } from 'node:crypto'
import { renameSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { errorMessage } from './error-text.ts'
import {
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
  removePrivateFileNoFollow,
  samePrivateIdentity,
  syncPrivateDirectoryNoFollow,
  type PrivateFileIdentity,
} from './private-file.ts'

/** 唯一租约文件名（<stateRoot>/owner.json）。 */
export const STATE_ROOT_LEASE_FILENAME = 'owner.json'

/** 一次性 legacy 退役路径（相对 stateRoot）。 */
export const LEGACY_STATE_ROOT_LOCK_PATHS: readonly string[] = [
  '.gateway.lock',
  join('dsh-runtime', 'owner.json'),
]

/** Default state root when no explicit path and no env override is set. */
export const DEFAULT_STATE_DIR = join(homedir(), '.dsh-chamber')

export interface ResolveStateRootOptions {
  explicit?: string | undefined
  /** Flavor-specific env var name, e.g. 'DSH_GATEWAY_STATE'; only the gateway sets one. */
  flavorEnv?: string | null | undefined
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * 唯一 state 根解析：explicit > DSH_<FLAVOR>_STATE > DSH_CHAMBER_STATE >
 * DEFAULT_STATE_DIR。空/空白值视为缺省（绝不解析为 cwd），结果绝对路径。
 */
export function resolveStateRoot(options: ResolveStateRootOptions = {}): string {
  const env = options.env ?? process.env
  const explicit = options.explicit?.trim()
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const flavorEnv = options.flavorEnv?.trim()
  if (flavorEnv !== undefined && flavorEnv !== '') {
    const flavored = env[flavorEnv]?.trim()
    if (flavored !== undefined && flavored !== '') return resolve(flavored)
  }
  const shared = env.DSH_CHAMBER_STATE?.trim()
  if (shared !== undefined && shared !== '') return resolve(shared)
  return DEFAULT_STATE_DIR
}

const LEASE_SCHEMA_VERSION = 1
const LEASE_MAX_BYTES = 16 * 1024
const LEASE_TOKEN_BYTES = 24
const TAKEOVER_ATTEMPTS = 3

export type StateRootLeaseScope = 'state-root' | 'host-root'
export type StateRootLeaseFlavor = 'control-plane' | 'gateway' | 'gateway-cli' | 'desktop' | 'sidecar'

export type StateRootLeaseCode =
  | 'state_root_locked'
  | 'state_root_duplicate'
  | 'state_root_unreadable'
  | 'state_root_takeover_race'
  | 'state_root_not_owner'

export interface StateRootLeaseHolder {
  pid: number
  flavor: string | null
  startedAt: number | null
}

export interface StateRootLeaseLogger {
  warn(message: string): void
}

export class StateRootLeaseError extends Error {
  readonly code: StateRootLeaseCode
  readonly stateRoot: string
  readonly pid: number | null
  readonly holder: StateRootLeaseHolder | null

  constructor(
    code: StateRootLeaseCode,
    message: string,
    fields: { stateRoot: string; pid?: number | null; holder?: StateRootLeaseHolder | null },
  ) {
    super(message)
    this.name = 'StateRootLeaseError'
    this.code = code
    this.stateRoot = fields.stateRoot
    this.pid = fields.pid ?? null
    this.holder = fields.holder ?? null
  }
}

export interface StateRootLease {
  readonly stateRoot: string
  readonly file: string
  readonly token: string
  readonly scope: StateRootLeaseScope
  readonly flavor: StateRootLeaseFlavor
  held(): boolean
  assertCurrent(): void
  release(): void
  reacquire(): void
}

export interface StateRootLeaseOptions {
  scope: StateRootLeaseScope
  flavor: StateRootLeaseFlavor
  logger?: StateRootLeaseLogger
  /** 确定性并发缝：在 stale 记录被 rename 之前调用（测试用）。 */
  beforeStaleRename?: () => void
}

interface LeaseRecordView {
  pid: number
  startedAt: number | null
  token: string | null
  flavor: string | null
}

type RawRead = { kind: 'missing' } | { kind: 'present'; raw: string; identity: PrivateFileIdentity }

type Classified =
  | { kind: 'record'; record: LeaseRecordView }
  | { kind: 'torn'; reason: string }
  | { kind: 'future'; reason: string }

function comparablePath(path: string): string {
  const absolute = resolve(path)
  let canonical = absolute
  try { canonical = realpathSync.native(absolute) } catch { /* a new state root has no realpath yet */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

/** 广根拒绝（gateway store.ts 的 validateGatewayStateDirPath 迁入的单一实现）。 */
export function assertDedicatedStateRoot(stateRoot: string): void {
  const absolute = resolve(stateRoot)
  const candidateKeys = new Set([
    process.platform === 'win32' ? absolute.toLowerCase() : absolute,
    comparablePath(absolute),
  ])
  const forbidden: Array<[string, string]> = [
    ['filesystem root', parse(absolute).root],
    ['user home', homedir()],
    ['system temp root', tmpdir()],
  ]
  for (const [label, path] of forbidden) {
    const forbiddenAbsolute = resolve(path)
    const forbiddenKeys = [
      process.platform === 'win32' ? forbiddenAbsolute.toLowerCase() : forbiddenAbsolute,
      comparablePath(forbiddenAbsolute),
    ]
    if (forbiddenKeys.some(key => candidateKeys.has(key))) {
      throw new Error('state root must be a dedicated child directory; refusing ' + label + ': ' + absolute)
    }
  }
}

function canonicalLeaseKey(stateRoot: string): string {
  const absolute = resolve(stateRoot)
  let canonical = absolute
  try { canonical = realpathSync.native(absolute) } catch { /* created by claim before this call */ }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function readRawFile(file: string, stateRoot: string): RawRead {
  try {
    const read = readPrivateFileNoFollow(file, { maxBytes: LEASE_MAX_BYTES })
    return { kind: 'present', raw: read.value, identity: read.identity }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw new StateRootLeaseError(
      'state_root_unreadable',
      'state root lease is unsafe or unreadable: ' + file + ' (' + errorMessage(error) + ')',
      { stateRoot },
    )
  }
}

function classifyRaw(raw: string): Classified {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { kind: 'torn', reason: 'record is not valid JSON' } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'torn', reason: 'record is not a JSON object' }
  }
  const candidate = parsed as Record<string, unknown>
  const version = candidate.schemaVersion
  if (version !== undefined && version !== LEASE_SCHEMA_VERSION) {
    return { kind: 'future', reason: 'unsupported schemaVersion ' + String(version) }
  }
  const pid = candidate.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return { kind: 'torn', reason: 'record has no usable pid' }
  }
  return {
    kind: 'record',
    record: {
      pid,
      startedAt: typeof candidate.startedAt === 'number' && Number.isFinite(candidate.startedAt) ? candidate.startedAt : null,
      token: typeof candidate.token === 'string' && candidate.token.length > 0 ? candidate.token : null,
      flavor: typeof candidate.flavor === 'string' ? candidate.flavor : null,
    },
  }
}

function probePid(pid: number): 'alive' | 'dead' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return 'alive'
    if (code === 'ESRCH') return 'dead'
    throw error
  }
}

function parseRecordPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown }
    const pid = parsed?.pid
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch { return null }
}

function lockedError(stateRoot: string, file: string, record: LeaseRecordView): StateRootLeaseError {
  const holder: StateRootLeaseHolder = { pid: record.pid, flavor: record.flavor, startedAt: record.startedAt }
  const started = record.startedAt === null ? '' : ' (started ' + new Date(record.startedAt).toISOString() + ')'
  return new StateRootLeaseError(
    'state_root_locked',
    'state root ' + stateRoot + ' is owned by pid ' + record.pid
      + (record.flavor === null ? '' : ' (' + record.flavor + ')') + started
      + '; stop it or pass an explicit --state-dir/DSH_*_STATE (' + file + ')',
    { stateRoot, pid: record.pid, holder },
  )
}

function staleEvidencePath(file: string): string {
  return file + '.stale-' + process.pid + '-' + randomBytes(4).toString('hex')
}

/**
 * 一次性 legacy 退役：`.gateway.lock` 与 `dsh-runtime/owner.json`。活 pid →
 * state_root_locked；不安全 → state_root_unreadable；死 pid/空/不可解析 → rename
 * 取证 + identity 精确删除。独立函数 + 单一调用点（claim()）。
 */
export function retireLegacyStateLocks(stateRoot: string, logger?: StateRootLeaseLogger): void {
  const root = resolve(stateRoot)
  for (const relative of LEGACY_STATE_ROOT_LOCK_PATHS) {
    const file = join(root, relative)
    const observed = readRawFile(file, root)
    if (observed.kind === 'missing') continue
    const pid = parseRecordPid(observed.raw)
    if (pid !== null && probePid(pid) === 'alive') {
      throw new StateRootLeaseError(
        'state_root_locked',
        'legacy state lock ' + file + ' is held by live pid ' + pid
          + '; stop the old-version process before starting a lease-owning writer',
        { stateRoot: root, pid, holder: { pid, flavor: null, startedAt: null } },
      )
    }
    const stale = staleEvidencePath(file)
    try {
      renameSync(file, stale)
      syncPrivateDirectoryNoFollow(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new StateRootLeaseError(
        'state_root_takeover_race',
        'legacy state lock could not be retired: ' + file + ' (' + errorMessage(error) + ')',
        { stateRoot: root },
      )
    }
    let movedExact = false
    try {
      const moved = readRawFile(stale, root)
      movedExact = moved.kind === 'present' && moved.raw === observed.raw
        && samePrivateIdentity(moved.identity, observed.identity)
    } catch { movedExact = false }
    if (!movedExact) {
      try { renameSync(stale, file); syncPrivateDirectoryNoFollow(root) } catch { /* retain ambiguous evidence */ }
      throw new StateRootLeaseError(
        'state_root_takeover_race',
        'legacy state lock changed while being retired: ' + file,
        { stateRoot: root },
      )
    }
    try { removePrivateFileNoFollow(stale, observed.identity) } catch { /* unique evidence is non-authoritative */ }
    logger?.warn('state-root-lease: retired legacy state lock ' + file + ' (owner pid ' + (pid === null ? 'unreadable' : String(pid)) + ')')
  }
}

const heldLeases = new Map<string, StateRootLeaseHandle>()
let exitListenerRegistered = false

function registerExitListener(): void {
  if (exitListenerRegistered) return
  exitListenerRegistered = true
  process.on('exit', releaseAllLeasesOnExit)
}

function releaseAllLeasesOnExit(): void {
  for (const lease of [...heldLeases.values()]) {
    try { lease.release() } catch { /* best-effort at process exit */ }
  }
}

class StateRootLeaseHandle implements StateRootLease {
  readonly stateRoot: string
  readonly file: string
  readonly scope: StateRootLeaseScope
  readonly flavor: StateRootLeaseFlavor
  token = ''
  #payload = ''
  #identity: PrivateFileIdentity | null = null
  #held = false
  #key = ''
  #options: StateRootLeaseOptions

  constructor(stateRoot: string, options: StateRootLeaseOptions) {
    this.stateRoot = stateRoot
    this.file = join(stateRoot, STATE_ROOT_LEASE_FILENAME)
    this.scope = options.scope
    this.flavor = options.flavor
    this.#options = options
  }

  held(): boolean { return this.#held }

  #install(payload: string, identity: PrivateFileIdentity, token: string): void {
    this.#payload = payload
    this.#identity = identity
    this.token = token
    this.#held = true
    heldLeases.set(this.#key, this)
    registerExitListener()
  }

  #markLost(): void {
    this.#held = false
    this.#identity = null
    if (heldLeases.get(this.#key) === this) heldLeases.delete(this.#key)
  }

  /** O_EXCL 创建 / 死 pid rename 认领；成功安装本次租约，失败一律 fail-closed。 */
  claim(): void {
    assertDedicatedStateRoot(this.stateRoot)
    ensurePrivateDirectoryNoFollow(this.stateRoot, 0o700)
    const key = canonicalLeaseKey(this.stateRoot)
    const existing = heldLeases.get(key)
    if (existing !== undefined && existing !== this) {
      throw new StateRootLeaseError(
        'state_root_duplicate',
        'this process already holds the state-root lease for ' + this.stateRoot,
        { stateRoot: this.stateRoot, pid: process.pid },
      )
    }
    this.#key = key
    // legacy 退役块的唯一调用点。
    retireLegacyStateLocks(this.stateRoot, this.#options.logger)

    const token = randomBytes(LEASE_TOKEN_BYTES).toString('hex')
    const payload = JSON.stringify({
      schemaVersion: LEASE_SCHEMA_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      token,
      scope: this.scope,
      flavor: this.flavor,
    }) + '\n'

    for (let attempt = 0; attempt < TAKEOVER_ATTEMPTS; attempt += 1) {
      let created: PrivateFileIdentity | null = null
      try {
        created = createPrivateFileExclusiveNoFollow(this.file, payload, { mode: 0o600 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (created !== null) {
        const proof = readRawFile(this.file, this.stateRoot)
        if (proof.kind !== 'present' || proof.raw !== payload || !samePrivateIdentity(proof.identity, created)) {
          try { removePrivateFileNoFollow(this.file, created) } catch { /* ambiguous evidence retained */ }
          throw new StateRootLeaseError(
            'state_root_takeover_race',
            'state-root lease ownership was displaced during acquisition: ' + this.file,
            { stateRoot: this.stateRoot },
          )
        }
        this.#install(payload, created, token)
        return
      }
      const observed = readRawFile(this.file, this.stateRoot)
      if (observed.kind === 'missing') continue
      const classified = classifyRaw(observed.raw)
      if (classified.kind === 'future') {
        throw new StateRootLeaseError(
          'state_root_unreadable',
          'state-root lease has ' + classified.reason + ': ' + this.file,
          { stateRoot: this.stateRoot },
        )
      }
      if (classified.kind === 'record') {
        if (classified.record.pid === process.pid) {
          throw new StateRootLeaseError(
            'state_root_duplicate',
            'state-root lease record already belongs to this process (pid ' + process.pid + '): ' + this.file,
            {
              stateRoot: this.stateRoot,
              pid: process.pid,
              holder: { pid: process.pid, flavor: classified.record.flavor, startedAt: classified.record.startedAt },
            },
          )
        }
        if (probePid(classified.record.pid) === 'alive') throw lockedError(this.stateRoot, this.file, classified.record)
      }
      if (classified.kind === 'torn') {
        this.#options.logger?.warn('state-root-lease: claiming a torn lease record at ' + this.file + ' (' + classified.reason + ')')
      }
      this.#options.beforeStaleRename?.()
      const stale = staleEvidencePath(this.file)
      try {
        renameSync(this.file, stale)
        syncPrivateDirectoryNoFollow(this.stateRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw new StateRootLeaseError(
          'state_root_takeover_race',
          'stale state-root lease could not be claimed: ' + this.file + ' (' + errorMessage(error) + ')',
          { stateRoot: this.stateRoot },
        )
      }
      let movedExact = false
      try {
        const moved = readRawFile(stale, this.stateRoot)
        movedExact = moved.kind === 'present' && moved.raw === observed.raw
          && samePrivateIdentity(moved.identity, observed.identity)
      } catch { movedExact = false }
      if (!movedExact) {
        try { renameSync(stale, this.file); syncPrivateDirectoryNoFollow(this.stateRoot) } catch { /* retain ambiguous evidence */ }
        throw new StateRootLeaseError(
          'state_root_takeover_race',
          'state-root lease takeover lost a concurrent race: ' + this.file,
          { stateRoot: this.stateRoot },
        )
      }
      try { removePrivateFileNoFollow(stale, observed.identity) } catch { /* unique evidence is non-authoritative */ }
      if (classified.kind === 'record') {
        this.#options.logger?.warn('state-root-lease: took over a stale lease record at ' + this.file + ' (owner pid ' + classified.record.pid + ' is not running)')
      }
    }
    throw new StateRootLeaseError(
      'state_root_takeover_race',
      'state-root lease could not be acquired after ' + TAKEOVER_ATTEMPTS + ' attempts: ' + this.file,
      { stateRoot: this.stateRoot },
    )
  }

  assertCurrent(): void {
    if (!this.#held || this.#identity === null) {
      throw new StateRootLeaseError(
        'state_root_not_owner',
        'state-root lease is not held by this process: ' + this.file,
        { stateRoot: this.stateRoot },
      )
    }
    let observed: RawRead
    try {
      observed = readRawFile(this.file, this.stateRoot)
    } catch (error) {
      this.#markLost()
      throw error
    }
    if (observed.kind !== 'present' || observed.raw !== this.#payload || !samePrivateIdentity(observed.identity, this.#identity)) {
      this.#markLost()
      throw new StateRootLeaseError(
        'state_root_not_owner',
        'state-root lease is no longer owned by this process: ' + this.file,
        { stateRoot: this.stateRoot },
      )
    }
  }

  release(): void {
    if (!this.#held || this.#identity === null) return
    let observed: RawRead
    try {
      observed = readRawFile(this.file, this.stateRoot)
    } catch (error) {
      this.#markLost()
      throw error
    }
    if (observed.kind !== 'present' || observed.raw !== this.#payload || !samePrivateIdentity(observed.identity, this.#identity)) {
      this.#markLost()
      throw new StateRootLeaseError(
        'state_root_not_owner',
        'refusing to remove a state-root lease this process no longer owns: ' + this.file,
        { stateRoot: this.stateRoot },
      )
    }
    try {
      removePrivateFileNoFollow(this.file, this.#identity)
    } catch (error) {
      // 记录仍是本租约：保留 held（reacquire 不得自锁），调用方按 fail-loud 处理。
      throw new Error('state-root lease could not be removed; ownership retained: ' + this.file + ' (' + errorMessage(error) + ')')
    }
    this.#markLost()
  }

  reacquire(): void {
    if (this.#held) return
    this.claim()
  }
}

/** 取得 state 根写者租约；失败 fail-closed（绝不返回无租约的 handle）。 */
export function acquireStateRootLease(stateRoot: string, options: StateRootLeaseOptions): StateRootLease {
  const lease = new StateRootLeaseHandle(resolve(stateRoot), options)
  lease.claim()
  return lease
}
