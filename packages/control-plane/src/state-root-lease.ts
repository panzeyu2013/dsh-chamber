/**
 * state-root-lease.ts —— state 根写者唯一租约。
 *
 * 契约：一个 state 根同一时刻只有一个写者，判据是 <stateRoot>/owner.json 的 O_EXCL
 * 创建与 token/inode：
 *
 *   - 活持有者：响亮拒绝（state_root_locked，携带 holder pid/flavor）；
 *   - 陈旧记录：rename 到唯一 .stale-* 证据名，证明移动的正是先前读到的精确
 *     字节 + inode 后重建；任何证明缺口 fail-closed（state_root_takeover_race）；
 *   - 撕裂/空记录：认领 + 告警；release 只按 token + inode 精确删除，不匹配时
 *     state_root_not_owner 且绝不删除；同进程同根第二个 acquire 为 state_root_duplicate。
 *
 * 「活」的判据是**持有者身份**，不是 pid 存活：记录带 identity 段（machineId /
 * bootId / pidNamespace / startTicks，见 process-identity.ts），判定顺序为
 * 跨机 → 跨启动 → 跨 PID namespace → 进程不存在 → startTicks 不符，全部一致才
 * 算「真的有人在占」。没有身份段的 v1 记录只做启动代际推断（写入时刻早于本次
 * 开机 ⇒ 必然陈旧）；读不到身份时保守锁定。**EPERM 不再等价于 alive**：它只
 * 说明存在同号进程，必须继续用 startTicks 核对。
 *
 * 本模块不 import electron / dsh-runtime，是 control-plane 公共面的一部分。
 */
import { randomBytes } from 'node:crypto'
import { renameSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { errorMessage } from './error-text.ts'
import {
  EMPTY_PROCESS_IDENTITY,
  bootWallClockMs,
  captureProcessIdentity,
  currentBootId,
  currentMachineId,
  currentPidNamespace,
  probeProcess,
  type ProcessIdentity,
  type ProcessObservation,
} from './process-identity.ts'
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

/**
 * 入口进程的「确定性租约冲突」退出码。
 *
 * 语义：**重试没有意义**，必须有人停掉持有者或换 state 根。systemd 单元据此设
 * `RestartPreventExitStatus=3`，一次都不重启；临时性启动失败仍走 1。桌面
 * sidecar 有自己的 0/3/70 分级（租约失败是 70=启动失败，3 专指 L1 目录锁冲
 * 突），两者不共用数值契约，只在「确定性冲突不自动重启」上同义。
 */
const STATE_ROOT_LEASE_CONFLICT_EXIT_CODE = 3

/** 租约错误 → 进程退出码。 */
export function stateRootLeaseExitCode(code: StateRootLeaseCode): number {
  return code === 'state_root_locked' || code === 'state_root_duplicate'
    ? STATE_ROOT_LEASE_CONFLICT_EXIT_CODE
    : 1
}

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

/** 写入格式：v2 = v1 + identity 段（持有者身份）。 */
const LEASE_SCHEMA_VERSION = 2
/**
 * 可读格式：v1（无 identity 段）与 v2。v1 只在升级路径上出现——把它读成
 * `future` 会让升级后的第一次启动被自己的旧记录锁死，正好复现本模块要消灭的
 * 事故。更新版本的记录（3+）仍然 fail-closed。
 */
const SUPPORTED_LEASE_SCHEMA_VERSIONS: readonly number[] = [1, 2]
const LEASE_MAX_BYTES = 16 * 1024
const LEASE_TOKEN_BYTES = 24
const TAKEOVER_ATTEMPTS = 3
/**
 * 启动代际推断的余量。
 *
 * 无身份段的记录只能靠「写入时刻早于本次开机」判定陈旧。开机后墙钟被 NTP 步
 * 进时，这个推断可能把同一启动内写下的记录误判成开机前——故只在证据明显早于
 * 开机（≥ 5 分钟）时采用。反向代价是「刚写下就重启」且 pid 恰好被复用的记录
 * 仍会保守锁定，需要人工清理；这是有意的取舍：误判陈旧会制造双写者。
 */
const BOOT_EPOCH_MARGIN_MS = 5 * 60 * 1000

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
  identity: ProcessIdentity
}

type RawRead =
  | { kind: 'missing' }
  | { kind: 'present'; raw: string; identity: PrivateFileIdentity; mtimeMs: number }

type Classified =
  | { kind: 'record'; record: LeaseRecordView }
  | { kind: 'torn'; reason: string }
  | { kind: 'future'; reason: string }

/** 陈旧判据：每一条都是「记录里的持有者不可能还在」的可证实结论。 */
type StaleReason =
  | 'process-absent'
  | 'process-zombie'
  | 'rebooted'
  | 'pid-reused'
  | 'record-predates-boot'

/**
 * 对一条记录的持有者判定。
 *
 * - stale      记录已失效，可以 rename 认领；
 * - live       同号进程存在且身份未能否定（verified=false 表示读不到身份）；
 * - foreign-*  记录来自另一台机器 / 另一个 PID namespace：既不是陈旧，也不能
 *              接管（pid 在对方的命名空间里才有意义），只能响亮失败。
 */
type HolderVerdict =
  | { kind: 'stale'; reason: StaleReason }
  | { kind: 'live'; verified: boolean }
  | { kind: 'foreign-machine'; machineId: string; host: string | null }
  | { kind: 'foreign-namespace'; pidNamespace: string }

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
    return { kind: 'present', raw: read.value, identity: read.identity, mtimeMs: read.mtimeMs }
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
  if (version !== undefined && (typeof version !== 'number' || !SUPPORTED_LEASE_SCHEMA_VERSIONS.includes(version))) {
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
      identity: parseRecordIdentity(candidate.identity),
    },
  }
}

/** 身份段的逐字段校验：任何形状不符的字段降级为 null（由判定逻辑保守处理）。 */
function parseRecordIdentity(value: unknown): ProcessIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...EMPTY_PROCESS_IDENTITY }
  }
  const raw = value as Record<string, unknown>
  const text = (key: string): string | null => {
    const field = raw[key]
    if (typeof field !== 'string') return null
    const trimmed = field.trim()
    if (trimmed === '' || trimmed.length > 128) return null
    // 身份字段会被原样嵌进日志与错误文本：只收可打印 ASCII，控制字符能把
    // 一条伪造的 journal 行塞进诊断输出（记录属主私有，但仍可能被拷贝/篡改）。
    return /^[\x20-\x7e]+$/u.test(trimmed) ? trimmed : null
  }
  const ticks = raw.procStartTicks
  return {
    host: text('host'),
    machineId: text('machineId'),
    bootId: text('bootId'),
    pidNamespace: text('pidNamespace'),
    procStartTicks: typeof ticks === 'number' && Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null,
  }
}

/**
 * 判定记录里的持有者是否还占着 state 根。
 *
 * 判据顺序即证据强度顺序：跨机器是「不是同一个仲裁域」；bootId 不等是重启
 * （整批作废，与 pid 无关）；同一启动内跨 PID namespace 意味着 pid 在此无名可
 * 指；进程不存在是 ESRCH 或僵尸；startTicks 不等是同一启动内的 pid 复用——
 * EPERM 也走这条核对，因为 `kill(pid, 0)` 的成功/EPERM 只证明「有同号进程」。
 * 身份读不到时保守返回 live(unverified)，绝不因为读不到就判死。
 */
function judgeHolder(
  record: LeaseRecordView,
  observed: ProcessObservation,
  mtimeMs: number | null,
  now: number,
): HolderVerdict {
  const machine = currentMachineId()
  if (record.identity.machineId !== null && machine !== null && record.identity.machineId !== machine) {
    return { kind: 'foreign-machine', machineId: record.identity.machineId, host: record.identity.host }
  }
  // 重启判据在 namespace 之前：同一台机器上 bootId 不等 ⇒ 记录写者已随重启
  // 消失，与它当时在哪个 PID namespace 无关（跨机器已在上一步排除）。
  const boot = currentBootId()
  const bootComparable = record.identity.bootId !== null && boot !== null
  if (bootComparable && record.identity.bootId !== boot) return { kind: 'stale', reason: 'rebooted' }
  const namespace = currentPidNamespace()
  if (record.identity.pidNamespace !== null && namespace !== null && record.identity.pidNamespace !== namespace) {
    return { kind: 'foreign-namespace', pidNamespace: record.identity.pidNamespace }
  }
  if (observed.presence === 'absent') {
    const zombie = observed.state === 'Z' || observed.state === 'X' || observed.state === 'x'
    return { kind: 'stale', reason: zombie ? 'process-zombie' : 'process-absent' }
  }
  if (bootComparable && observed.presence === 'present'
    && record.identity.procStartTicks !== null && observed.startTicks !== null) {
    return record.identity.procStartTicks === observed.startTicks
      ? { kind: 'live', verified: true }
      : { kind: 'stale', reason: 'pid-reused' }
  }
  // 没有身份段的 v1 记录：唯一可证的失效是「写入时刻早于本次开机」。记录若是
  // 上一启动写下的，写它的进程必然已随重启消失；同启动内的 pid 复用则无证据，
  // 保守锁定（记录会被后续版本重新写成 v2，届时即可精确判定）。
  if (record.identity.bootId === null) {
    const writtenAt = record.startedAt ?? mtimeMs
    const bootWall = bootWallClockMs(now)
    if (writtenAt !== null && bootWall !== null && writtenAt < bootWall - BOOT_EPOCH_MARGIN_MS) {
      return { kind: 'stale', reason: 'record-predates-boot' }
    }
  }
  return { kind: 'live', verified: false }
}

function parseRecordPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown }
    const pid = parsed?.pid
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch { return null }
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 12) + '…'
}

/** 判定依据的人类可读后缀：告诉操作者「为什么不是陈旧记录」。 */
function verdictBasis(verdict: Extract<HolderVerdict, { kind: 'live' } | { kind: 'foreign-machine' } | { kind: 'foreign-namespace' }>): string {
  if (verdict.kind === 'foreign-machine') {
    return '; the record was written on another machine'
      + (verdict.host === null ? '' : ' (' + verdict.host + ')')
      + ' [' + shortId(verdict.machineId) + '], and a state root shared across machines cannot be arbitrated by pid'
  }
  if (verdict.kind === 'foreign-namespace') {
    return '; the record belongs to PID namespace ' + shortId(verdict.pidNamespace)
      + ', not this one, so its pid does not name a process here'
  }
  if (verdict.verified) {
    return '; its process identity matches the lease (same boot and start time), so this is a live holder, not a reused pid'
  }
  return '; the pid exists but its identity could not be verified against the lease (no readable /proc entry, or the record predates the identity fields), so the lease stays locked conservatively'
}

function lockedError(
  stateRoot: string,
  file: string,
  record: LeaseRecordView,
  verdict: Extract<HolderVerdict, { kind: 'live' } | { kind: 'foreign-machine' } | { kind: 'foreign-namespace' }>,
): StateRootLeaseError {
  const holder: StateRootLeaseHolder = { pid: record.pid, flavor: record.flavor, startedAt: record.startedAt }
  // startedAt 是记录写入时刻，不是进程启动时刻——文案不冒充后者。
  const written = record.startedAt === null ? '' : ' (record written ' + new Date(record.startedAt).toISOString() + ')'
  const escape = verdict.kind === 'foreign-machine' || verdict.kind === 'foreign-namespace'
    ? '; if this state root was copied, migrated or mounted from another environment, move the record aside; otherwise stop that writer'
    : verdict.verified
      ? '; stop it or pass an explicit --state-dir/DSH_*_STATE'
      : '; stop the holder, or pass an explicit --state-dir/DSH_*_STATE'
  return new StateRootLeaseError(
    'state_root_locked',
    'state root ' + stateRoot + ' is owned by pid ' + record.pid
      + (record.flavor === null ? '' : ' (' + record.flavor + ')') + written
      + verdictBasis(verdict) + escape + ' (' + file + ')',
    { stateRoot, pid: record.pid, holder },
  )
}

/** 陈旧判据的诊断文本（接管告警里说明「凭什么判死」）。 */
function staleReasonText(reason: StaleReason): string {
  switch (reason) {
    case 'process-absent': return 'owner pid is not running'
    case 'process-zombie': return 'owner pid is a zombie (already exited)'
    case 'rebooted': return 'record belongs to a previous boot'
    case 'pid-reused': return 'pid now belongs to a different process (start time mismatch)'
    case 'record-predates-boot': return 'record was written before this boot'
  }
}

function staleEvidencePath(file: string): string {
  return file + '.stale-' + process.pid + '-' + randomBytes(4).toString('hex')
}

/** legacy 记录自称的写入时刻（startedAt / createdAt）；不可读为 null。 */
function parseRecordTimestamp(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { startedAt?: unknown; createdAt?: unknown }
    const value = parsed?.startedAt ?? parsed?.createdAt
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  } catch { return null }
}

/**
 * 一次性 legacy 退役：`.gateway.lock` 与 `dsh-runtime/owner.json`。活持有者 →
 * state_root_locked；不安全 → state_root_unreadable；进程已不存在/空/不可解析/写于本次
 * 开机之前 → rename 取证 + identity 精确删除。独立函数 + 单一调用点（claim()）。
 *
 * legacy 格式没有身份段，但同样不能把「同号进程存在」当成「老版本还活着」：
 * 重启后 pid 被别的服务复用，正是这类文件永久锁死的路径。写入时刻早于本次开
 * 机（含 mtime 回退）即可证明写者已随重启消失。
 */
export function retireLegacyStateLocks(stateRoot: string, logger?: StateRootLeaseLogger): void {
  const root = resolve(stateRoot)
  for (const relative of LEGACY_STATE_ROOT_LOCK_PATHS) {
    const file = join(root, relative)
    const observed = readRawFile(file, root)
    if (observed.kind === 'missing') continue
    const pid = parseRecordPid(observed.raw)
    const recordedAt = pid === null ? null : parseRecordTimestamp(observed.raw)
    let retiredWhy = ''
    if (pid !== null) {
      const presence = probeProcess(pid).presence
      const writtenAt = recordedAt ?? observed.mtimeMs
      const bootWall = bootWallClockMs()
      const predatesBoot = writtenAt !== null && bootWall !== null && writtenAt < bootWall - BOOT_EPOCH_MARGIN_MS
      if (presence !== 'absent' && !predatesBoot) {
        throw new StateRootLeaseError(
          'state_root_locked',
          'legacy state lock ' + file + ' is held by live pid ' + pid
            + (presence === 'unknown' ? ' (the pid could not be probed conclusively)' : '')
            + '; stop the old-version process before starting a lease-owning writer',
          { stateRoot: root, pid, holder: { pid, flavor: null, startedAt: recordedAt } },
        )
      }
      retiredWhy = predatesBoot ? ', written before this boot' : ''
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
    logger?.warn('state-root-lease: retired legacy state lock ' + file + ' (owner pid ' + (pid === null ? 'unreadable' : String(pid)) + retiredWhy + ')')
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

  /** O_EXCL 创建 / 陈旧记录 rename 认领；成功安装本次租约，失败一律 fail-closed。 */
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
    // startedAt 是**记录写入**时刻（旧记录用它做启动代际推断）；进程启动时刻由
    // identity.procStartTicks 精确表达，两者不可互换。
    const payload = JSON.stringify({
      schemaVersion: LEASE_SCHEMA_VERSION,
      pid: process.pid,
      startedAt: Date.now(),
      token,
      scope: this.scope,
      flavor: this.flavor,
      identity: captureProcessIdentity(process.pid),
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
      let staleReason: StaleReason | null = null
      if (classified.kind === 'record') {
        const observedProcess = probeProcess(classified.record.pid)
        const verdict = judgeHolder(classified.record, observedProcess, observed.mtimeMs, Date.now())
        if (verdict.kind === 'stale') {
          staleReason = verdict.reason
        } else if (verdict.kind === 'live' && classified.record.pid === process.pid) {
          // 只有「身份确为本进程」才是 duplicate；重启后旧记录的 pid 恰好等于本
          // 进程时（同号复用）它仍是陈旧记录，绝不能据此拒绝启动。
          throw new StateRootLeaseError(
            'state_root_duplicate',
            'state-root lease record already belongs to this process (pid ' + process.pid + '): ' + this.file,
            {
              stateRoot: this.stateRoot,
              pid: process.pid,
              holder: { pid: process.pid, flavor: classified.record.flavor, startedAt: classified.record.startedAt },
            },
          )
        } else {
          throw lockedError(this.stateRoot, this.file, classified.record, verdict)
        }
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
        this.#options.logger?.warn('state-root-lease: took over a stale lease record at ' + this.file
          + ' (owner pid ' + classified.record.pid + ': ' + staleReasonText(staleReason ?? 'process-absent') + ')')
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
