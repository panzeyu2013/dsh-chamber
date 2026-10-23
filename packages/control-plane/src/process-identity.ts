/**
 * process-identity.ts —— 进程身份取证（state 根写者租约的判据底座）。
 *
 * 租约要回答的问题不是「这个 pid 还存在吗」，而是「这条记录仍由当初那个进程
 * 持有吗」。两者在重启后分叉：pid 会被复用，`kill(pid, 0)` 对**任何**同号
 * 进程都成功，EPERM 只说明「存在但不是我的」——对租约而言那恰恰是「不是我记
 * 录的那个持有者」的强信号，而不是「持有者还活着」。
 *
 * 本模块把身份收敛成一条可比较的元组（Linux）：
 *
 *   (machineId, bootId, pidNamespace, pid, startTicks)
 *
 * - machineId 跨重启恒定：识别「同一个 state 根被另一台机器写了」（共享盘）。
 * - bootId 每次内核启动必变：跨启动的记录在语义上 100% 失效。
 * - pidNamespace 区分 PID 命名空间：不同 namespace 里同号 pid 互不指代。
 * - startTicks（/proc/<pid>/stat 第 22 字段）区分同一启动内的 pid 复用。
 *
 * 任何一项读不到都返回 null，由调用方保守判定（保持锁定），**绝不**因为读不
 * 到就断言进程已死。非 Linux 平台没有 /proc：身份只剩 pid，配合同一模块的
 * bootWallClockMs 做「记录写于本次开机之前」的启动代际推断。
 *
 * 本模块只依赖 node 内建，不属于 control-plane 的公共导出面。
 */
import { readFileSync, readlinkSync } from 'node:fs'
import { hostname, uptime } from 'node:os'

/** 一条租约记录携带的持有者身份；null = 本平台/本次读取拿不到该事实。 */
export interface ProcessIdentity {
  /** 写入方主机名：仅用于诊断，**绝不**参与存活判定（主机名会变）。 */
  host: string | null
  /** 稳定机器标识（Linux /etc/machine-id）：跨重启不变。 */
  machineId: string | null
  /** 本次内核启动标识（Linux /proc/sys/kernel/random/boot_id）：跨重启必变。 */
  bootId: string | null
  /** PID 命名空间 inode 文本（Linux /proc/self/ns/pid，形如 pid:[4026531836]）。 */
  pidNamespace: string | null
  /** 进程启动时的内核 jiffies（/proc/<pid>/stat 第 22 字段）：同号复用必变。 */
  procStartTicks: number | null
}

/** 空身份：记录里没有身份段（schemaVersion 1）时的取值。 */
export const EMPTY_PROCESS_IDENTITY: Readonly<ProcessIdentity> = Object.freeze({
  host: null,
  machineId: null,
  bootId: null,
  pidNamespace: null,
  procStartTicks: null,
})

/** 身份字段的取值上限：拒绝用超长字符串撑大租约记录或日志。 */
const MAX_IDENTITY_CHARS = 128

function usableText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > MAX_IDENTITY_CHARS) return null
  return trimmed
}

export interface ProcessObservation {
  /** 'unknown' 只来自非 ESRCH/EPERM 的探测失败（调用方按「读不到」保守处理）。 */
  presence: 'absent' | 'present' | 'unknown'
  /** /proc/<pid>/stat 的 state 字母（R/S/D/Z/X …）；读不到为 null。 */
  state: string | null
  startTicks: number | null
}

/**
 * 解析 /proc/<pid>/stat。
 *
 * comm（第 2 字段）可以包含空格和右括号，所以**最后一个** ')' 才是字段边界；
 * `split(') ')[1]` 在 `(a) b)` 这类 comm 上会切错。')' 之后第一个字段是
 * state（字段 3），starttime 是字段 22（`rest[19]`）。
 */
export function parseProcessStat(text: string): { state: string; startTicks: number } | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const rest = text.slice(close + 1).trim().split(/\s+/u)
  if (rest.length < 20) return null
  const state = rest[0]
  const startTicks = Number(rest[19])
  if (typeof state !== 'string' || state.length !== 1) return null
  if (!Number.isSafeInteger(startTicks) || startTicks < 0) return null
  return { state, startTicks }
}

/** /proc/<pid>/stat 的 state+starttime；任何失败（无 /proc、hidepid、权限）返回 null。 */
function readProcessStat(pid: number): { state: string; startTicks: number } | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    return parseProcessStat(readFileSync('/proc/' + String(pid) + '/stat', 'utf8'))
  } catch {
    return null
  }
}

/**
 * 进程是否仍存在。
 *
 * 'present' 只表示「同号进程存在」，**不**表示身份匹配；身份由调用方用
 * startTicks 比对。僵尸（Z）与正在退出（X）按 'absent' 处理：它们不执行任何
 * 代码，若按「存在」保守锁定，一个未回收的僵尸会永久锁死 state 根。
 */
export function probeProcess(pid: number): ProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { presence: 'unknown', state: null, startTicks: null }
  }
  try {
    process.kill(pid, 0)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return { presence: 'absent', state: null, startTicks: null }
    // EPERM = 存在但不可信号：只证明「有同号进程」。
    if (code !== 'EPERM') return { presence: 'unknown', state: null, startTicks: null }
  }
  const stat = readProcessStat(pid)
  if (stat !== null && (stat.state === 'Z' || stat.state === 'X' || stat.state === 'x')) {
    return { presence: 'absent', state: stat.state, startTicks: stat.startTicks }
  }
  return { presence: 'present', state: stat?.state ?? null, startTicks: stat?.startTicks ?? null }
}

let cachedBootId: string | null | undefined
let cachedMachineId: string | null | undefined
let cachedPidNamespace: string | null | undefined

/** 本次内核启动标识（Linux）；非 Linux 或读取失败为 null。进程内恒定。 */
export function currentBootId(): string | null {
  if (cachedBootId !== undefined) return cachedBootId
  try {
    cachedBootId = usableText(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'))
  } catch {
    cachedBootId = null
  }
  return cachedBootId
}

/** 稳定机器标识（Linux /etc/machine-id，回退 /var/lib/dbus/machine-id）。 */
export function currentMachineId(): string | null {
  if (cachedMachineId !== undefined) return cachedMachineId
  for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const value = usableText(readFileSync(path, 'utf8'))
      if (value !== null) { cachedMachineId = value; return cachedMachineId }
    } catch { /* try the next source */ }
  }
  cachedMachineId = null
  return cachedMachineId
}

/** 当前 PID 命名空间标识（Linux /proc/self/ns/pid 的符号链接文本）。 */
export function currentPidNamespace(): string | null {
  if (cachedPidNamespace !== undefined) return cachedPidNamespace
  try {
    cachedPidNamespace = usableText(readlinkSync('/proc/self/ns/pid'))
  } catch {
    cachedPidNamespace = null
  }
  return cachedPidNamespace
}

/** 采集一个进程的完整身份（写入租约记录时用；读不到的事实为 null）。 */
export function captureProcessIdentity(pid: number): ProcessIdentity {
  return {
    host: usableText(hostname()),
    machineId: currentMachineId(),
    bootId: currentBootId(),
    pidNamespace: currentPidNamespace(),
    procStartTicks: readProcessStat(pid)?.startTicks ?? null,
  }
}

/** 读取 /proc/stat 的 btime（Linux 开机墙钟，秒精度）；非 Linux 为 null。 */
function linuxBootEpochMs(): number | null {
  try {
    for (const line of readFileSync('/proc/stat', 'utf8').split('\n')) {
      if (!line.startsWith('btime ')) continue
      const seconds = Number(line.slice('btime '.length).trim())
      return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null
    }
  } catch { /* fall through to the portable estimate */ }
  return null
}

/**
 * 本次开机的墙钟时刻估计（epoch ms）。
 *
 * Linux 优先用 /proc/stat 的 btime；其余平台（以及 btime 读不到时）用
 * `now - os.uptime()`。两种来源都受「开机后时钟被步进」影响，所以调用方必须
 * 带余量（BOOT_EPOCH_MARGIN_MS）才敢下「记录写于开机之前」的结论。
 */
export function bootWallClockMs(now: number = Date.now()): number | null {
  const linux = linuxBootEpochMs()
  if (linux !== null) return linux
  const seconds = uptime()
  if (!Number.isFinite(seconds) || seconds < 0) return null
  return now - seconds * 1000
}
