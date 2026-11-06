/**
 * 系统内存快照（resident 阀门的输入，D4）——纯 Node，Electron main 与 Swift
 * sidecar 共用同一实现：两 flavor 都经 createHostAssembly → shell-core 的
 * installIpcHandlers → registerSettingsHandlers（host-assembly.ts:3、
 * shell-core.ts:1106），因此本模块只在 **`node:` 内置面** 上做只读探测，
 * 不碰任何 Electron API（`app.getAppMetrics()` 只有 Electron 腿，Swift sidecar
 * 是纯 Node；把快照做成 Electron-only 会让两 flavor 的阀门输入形状分叉）。
 *
 * 探测面（每个平台一条只读臂，失败一律 null —— 消费端必须把 null 读作「未知」，
 * 绝不把 0 或 100% 当事实）：
 * - linux：异步读 /proc/meminfo 的 MemTotal / MemAvailable（kB → 字节）；
 * - win32：os.totalmem()/os.freemem()（Windows 的 GlobalMemoryStatusEx，无需子进程）；
 * - darwin：异步 execFile('/usr/bin/vm_stat')（绝对路径：GUI 启动的宿主 PATH 可能不含
 *   /usr/bin；硬超时 1s），available = (free + inactive + speculative + purgeable) × pageSize；
 *   页大小取自 vm_stat 自己的表头
 *   （Apple silicon 16 KiB / Intel 4 KiB），total 取 os.totalmem()；
 * - 其余平台：null（不猜测、不伪造）。
 *
 * 缓存与单飞：默认 30s TTL + 模块级单飞。快照是**采样**而不是实时读数：
 * capturedAt 是采样时刻（缓存命中时保留原值，消费端据它判陈旧，而不是拿
 * Date.now() 冒充新鲜）。失败同样进 TTL（避免 settings.get 每帧重试一个已知失败的
 * 探针）；探针抛错绝不外抛。
 *
 * 可测性：缓存/单飞逻辑经 `createSystemMemoryReader` 的注入缝（假探针 + 假时钟）
 * 确定性地测，无需等待真实 TTL；`parseMeminfo`/`parseVmStat` 是无 IO 的纯函数。
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'

/** 探测来源（非秘密、可审计：同一结论出自哪条臂必须可见）。 */
export type SystemMemorySource = 'proc-meminfo' | 'os-freemem' | 'vm-stat'

/** 一次系统内存采样（非秒级实时值；capturedAt 是采样时刻）。 */
export interface SystemMemorySnapshot {
  totalBytes: number
  availableBytes: number
  source: SystemMemorySource
  /** 采样时刻（ms epoch）。缓存命中时保留原采样时刻，不是本次调用时刻。 */
  capturedAt: number
}

/** 一次探测的原始事实（无时间戳：capturedAt 由 reader 的时钟盖章）。 */
export interface SystemMemoryProbeResult {
  totalBytes: number
  availableBytes: number
  source: SystemMemorySource
}

/** 默认缓存窗口：设置页会反复 settings-get，30s 足够新且不会把 /proc 读爆。 */
export const SYSTEM_MEMORY_CACHE_TTL_MS = 30_000

/** vm_stat 硬超时：1s 不返回即按失败处理（绝不吊住 settings.get 的应答）。 */
const VM_STAT_TIMEOUT_MS = 1_000
const VM_STAT_MAX_BUFFER = 1 << 20
const BYTES_PER_KIB = 1024

/**
 * /proc/meminfo → { totalBytes, availableBytes }。
 * 只认 MemTotal / MemAvailable 两键；任一缺失 = null（缺失即未知，绝不拿 MemFree
 * 或 Cached 顶替）。行格式「MemTotal:  131633256 kB」（带补空格的数字 + kB 单位；
 * 无单位形态按 kB 读，/proc 的这两行在受支持内核上恒带 kB）。非内存行
 * （HugePages_Total 等）被忽略而不是误读成字节数。
 */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  let totalBytes: number | undefined
  let availableBytes: number | undefined
  for (const rawLine of text.split('\n')) {
    const match = /^([A-Za-z0-9_()]+):\s*([0-9]+)(?:\s+kB)?\s*$/.exec(rawLine.trim())
    if (match === null) continue
    const kib = Number.parseInt(match[2], 10)
    if (match[1] === 'MemTotal') totalBytes = kib * BYTES_PER_KIB
    else if (match[1] === 'MemAvailable') availableBytes = kib * BYTES_PER_KIB
  }
  if (totalBytes === undefined || availableBytes === undefined) return null
  if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(availableBytes)) return null
  if (totalBytes <= 0) return null
  // MemAvailable 理论上 ≤ MemTotal；异常内核/字节序下 clamp 而不是让消费端算出 >100% 占用。
  return { totalBytes, availableBytes: Math.min(Math.max(availableBytes, 0), totalBytes) }
}

/**
 * vm_stat 输出 → { pageSizeBytes, availableBytes }（available = 四个「可回收」页类
 * 之和 × 页大小：free + inactive + speculative + purgeable）。
 *
 * 表头「(page size of 16384 bytes)」是页大小的唯一来源（Intel 4 KiB / Apple
 * silicon 16 KiB）；缺表头 = null（拿 4096 当默认会让 Apple silicon 少算 4 倍）。
 * 「Pages free:                            24015.」的行尾点号是 vm_stat 的固定
 * 格式（不是小数点）。某个页类行在当前 macOS 版本缺席时按 0 计（该版本里那个量
 * 不存在），但一条已知页类都没有 = 不是 vm_stat 输出 → null。
 */
export function parseVmStat(text: string): { pageSizeBytes: number; availableBytes: number } | null {
  const pageSizeMatch = /page size of ([0-9]+) bytes/.exec(text)
  if (pageSizeMatch === null) return null
  const pageSizeBytes = Number.parseInt(pageSizeMatch[1], 10)
  if (!Number.isSafeInteger(pageSizeBytes) || pageSizeBytes <= 0) return null
  const pages = new Map<string, number>()
  for (const rawLine of text.split('\n')) {
    const match = /^Pages ([a-z][a-z ]*):\s*([0-9]+)\.?\s*$/.exec(rawLine.trim())
    if (match === null) continue
    pages.set(match[1], Number.parseInt(match[2], 10))
  }
  const reclaimable = ['free', 'inactive', 'speculative', 'purgeable'] as const
  let availablePages = 0
  let seen = 0
  for (const label of reclaimable) {
    const count = pages.get(label)
    if (count === undefined) continue
    seen += 1
    availablePages += count
  }
  if (seen === 0) return null
  const availableBytes = availablePages * pageSizeBytes
  if (!Number.isSafeInteger(availableBytes)) return null
  return { pageSizeBytes, availableBytes }
}

/** 异步读 /proc/meminfo 并解析；任何 IO/解析失败 → null。 */
async function probeProcMeminfo(): Promise<SystemMemoryProbeResult | null> {
  let text: string
  try {
    text = await readFile('/proc/meminfo', 'utf8')
  } catch {
    return null
  }
  const parsed = parseMeminfo(text)
  return parsed === null
    ? null
    : { totalBytes: parsed.totalBytes, availableBytes: parsed.availableBytes, source: 'proc-meminfo' }
}

/** Windows：os 两个事实（Electron 与纯 Node 同源，无需子进程）。 */
function probeOsFreemem(): SystemMemoryProbeResult | null {
  const totalBytes = totalmem()
  const availableBytes = freemem()
  if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes)) return null
  return { totalBytes, availableBytes, source: 'os-freemem' }
}

/** darwin：execFile('/usr/bin/vm_stat')（绝对路径 + 1s 硬超时）；失败/解析失败 → null。 */
async function probeVmStat(): Promise<SystemMemoryProbeResult | null> {
  let stdout: string
  try {
    stdout = await new Promise<string>((resolve, reject) => {
      execFile('/usr/bin/vm_stat', { timeout: VM_STAT_TIMEOUT_MS, maxBuffer: VM_STAT_MAX_BUFFER }, (error, output) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(typeof output === 'string' ? output : '')
      })
    })
  } catch {
    return null
  }
  const parsed = parseVmStat(stdout)
  if (parsed === null) return null
  const totalBytes = totalmem()
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
  return { totalBytes, availableBytes: parsed.availableBytes, source: 'vm-stat' }
}

/** 默认探针：平台分派（未知平台 = null，绝不猜）。 */
async function probeSystemMemory(): Promise<SystemMemoryProbeResult | null> {
  try {
    if (process.platform === 'linux') return await probeProcMeminfo()
    if (process.platform === 'win32') return probeOsFreemem()
    if (process.platform === 'darwin') return await probeVmStat()
    return null
  } catch {
    // 探头异常安全兜底（同步 throw 与 reject 同汇；绝不冒给 settings.get）。
    return null
  }
}

/** 注入缝：单测用假探针/假时钟覆盖 TTL 与单飞，生产用默认探针与 Date.now。 */
export interface SystemMemoryReaderOptions {
  probe?: () => Promise<SystemMemoryProbeResult | null>
  now?: () => number
  ttlMs?: number
}

export interface SystemMemoryReader {
  /** 读快照（TTL 内命中缓存；并发调用共享一次探测）。永不 reject。 */
  read(): Promise<SystemMemorySnapshot | null>
}

/** 把探针结果正规化：不可信的数值（NaN/<=0/负可用量）读作未知；available clamp 到 total。 */
function finalizeSnapshot(result: SystemMemoryProbeResult, capturedAt: number): SystemMemorySnapshot | null {
  const { totalBytes, availableBytes } = result
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null
  if (!Number.isFinite(availableBytes) || availableBytes < 0) return null
  return {
    totalBytes,
    availableBytes: Math.min(availableBytes, totalBytes),
    source: result.source,
    capturedAt,
  }
}

export function createSystemMemoryReader(options: SystemMemoryReaderOptions = {}): SystemMemoryReader {
  const probe = options.probe ?? probeSystemMemory
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? SYSTEM_MEMORY_CACHE_TTL_MS
  /** 缓存值（null = 上次采样不可得，同样受 TTL 保护）。 */
  let cached: SystemMemorySnapshot | null = null
  /** 缓存年龄起点；null = 从未采样过。 */
  let cachedAt: number | null = null
  let inflight: Promise<SystemMemorySnapshot | null> | null = null

  const read = async (): Promise<SystemMemorySnapshot | null> => {
    const startedAt = now()
    if (cachedAt !== null && startedAt - cachedAt < ttlMs) return cached
    if (inflight !== null) return inflight
    const run = (async (): Promise<SystemMemorySnapshot | null> => {
      let result: SystemMemoryProbeResult | null = null
      try {
        result = await probe()
      } catch {
        result = null
      }
      const snapshot = result === null ? null : finalizeSnapshot(result, startedAt)
      cached = snapshot
      // 以**完成时刻**记缓存年龄：慢探针（vm_stat 上限 1s）不会在返回时已过期。
      cachedAt = now()
      inflight = null
      return snapshot
    })()
    inflight = run
    return run
  }

  return { read }
}

/**
 * 模块级单飞 + 30s 缓存的系统内存快照（settings-get 专用；settings-changed push
 * 不携带它 —— 采样事实不进每帧推送）。**永不 reject**：不可得 = null。
 */
export const readSystemMemory: () => Promise<SystemMemorySnapshot | null> = createSystemMemoryReader().read
