/**
 * system-memory.ts 单测（D4）：系统内存快照的**解析**与**缓存/单飞**语义。
 *
 * 两个可无 IO 测的面：
 * - parseMeminfo / parseVmStat：纯函数（真实 /proc/meminfo 与 vm_stat 的样本形态，
 *   含缺键、老版本少一行、非内存行干扰）；
 * - createSystemMemoryReader：假探针 + 假时钟覆盖 30s TTL、单飞、失败缓存与正规化，
 *   不依赖真实等待，也不依赖 CI 平台能跑出某个具体数值。
 *
 * 另外两条**真探针**断言按 process.platform 分腿（未知平台必须 null —— 绝不伪造），
 * 以及 wire 镜像类型的结构同形（chamber-settings.ts 的 ChamberSystemMemory）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SYSTEM_MEMORY_CACHE_TTL_MS,
  createSystemMemoryReader,
  parseMeminfo,
  parseVmStat,
  readSystemMemory,
  type SystemMemoryProbeResult,
  type SystemMemorySnapshot,
} from '../../system-memory.ts'
import type { ChamberSystemMemory } from '../../chamber-settings.ts'

const KIB = 1024

// ---------------------------------------------------------------------------
// /proc/meminfo 解析
// ---------------------------------------------------------------------------

test('parseMeminfo: MemTotal/MemAvailable 以 kB 为单位 → 字节（其余行忽略）', () => {
  const text = [
    'MemTotal:       131633256 kB',
    'MemFree:        11614168 kB',
    'MemAvailable:   36540584 kB',
    'Buffers:            4116 kB',
    'Cached:         18308440 kB',
    'HugePages_Total:       0',
    'HugePages_Free:        0',
    '',
  ].join('\n')
  assert.deepEqual(parseMeminfo(text), {
    totalBytes: 131633256 * KIB,
    availableBytes: 36540584 * KIB,
  })
})

test('parseMeminfo: 缺 MemAvailable 或缺 MemTotal → null（缺失即未知，绝不拿 MemFree/Cached 顶替）', () => {
  assert.equal(parseMeminfo('MemTotal:       1000 kB\nMemFree:         500 kB\n'), null)
  assert.equal(parseMeminfo('MemAvailable:    400 kB\nMemFree:         500 kB\n'), null)
  assert.equal(parseMeminfo(''), null)
})

test('parseMeminfo: MemAvailable 超过 MemTotal 时 clamp 到 total（消费端不产出 >100% 占用）', () => {
  assert.deepEqual(parseMeminfo('MemTotal:  1000 kB\nMemAvailable: 4000 kB\n'), {
    totalBytes: 1000 * KIB,
    availableBytes: 1000 * KIB,
  })
})

test('parseMeminfo: 非内存形态（无单位且不是这两个键 / 亿级溢出 / 单位非 kB）→ null', () => {
  // 单位不是 kB（如 MB 的伪造形态）不匹配：宁可 null 也不按错误单位换成字节。
  assert.equal(parseMeminfo('MemTotal: 1 MB\nMemAvailable: 1 MB\n'), null)
  // 超过安全整数的 kB → 乘完即不可信，判 null。
  assert.equal(parseMeminfo('MemTotal: 9007199254740992 kB\nMemAvailable: 1 kB\n'), null)
})

// ---------------------------------------------------------------------------
// vm_stat 解析
// ---------------------------------------------------------------------------

const VM_STAT_SAMPLE = [
  'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
  'Pages free:                               24015.',
  'Pages active:                            987654.',
  'Pages inactive:                          123456.',
  'Pages speculative:                         1234.',
  'Pages throttled:                              0.',
  'Pages wired down:                        200000.',
  'Pages purgeable:                           4321.',
  '',
  'File-backed pages:                       345678.',
  'Anonymous pages:                         654321.',
  'Pages stored in compressor:              111111.',
  'Pages occupied by compressor:             22222.',
].join('\n')

test('parseVmStat: 页大小取表头，available=(free+inactive+speculative+purgeable)×页大小', () => {
  const parsed = parseVmStat(VM_STAT_SAMPLE)
  assert.deepEqual(parsed, {
    pageSizeBytes: 16384,
    availableBytes: (24015 + 123456 + 1234 + 4321) * 16384,
  })
})

test('parseVmStat: Intel 4 KiB 页同样按表头而不是默认值', () => {
  const text = '(page size of 4096 bytes)\nPages free: 10.\nPages inactive: 20.\n'
  assert.deepEqual(parseVmStat(text), { pageSizeBytes: 4096, availableBytes: (10 + 20) * 4096 })
})

test('parseVmStat: 缺页大小表头 → null（拿 4096 兜底会让 Apple silicon 少算 4 倍）', () => {
  assert.equal(parseVmStat('Pages free: 10.\nPages inactive: 20.\n'), null)
})

test('parseVmStat: 一条已知可回收页类都没有 → null；少一两个页类按 0 计而不是整条作废', () => {
  assert.equal(parseVmStat('(page size of 16384 bytes)\nPages active: 100.\nPages wired down: 200.\n'), null)
  // 旧版本可能没有 purgeable / speculative 行：缺失的那个量按 0 计。
  const partial = '(page size of 16384 bytes)\nPages free: 100.\nPages inactive: 50.\n'
  assert.deepEqual(parseVmStat(partial), { pageSizeBytes: 16384, availableBytes: (100 + 50) * 16384 })
})

// ---------------------------------------------------------------------------
// reader：TTL / 单飞 / 失败缓存 / 正规化
// ---------------------------------------------------------------------------

/** 可控探针：返回固定事实并记录调用次数。 */
function countingProbe(result: SystemMemoryProbeResult | null): { probe: () => Promise<SystemMemoryProbeResult | null>; calls: () => number } {
  let calls = 0
  return {
    probe: async () => {
      calls += 1
      return result
    },
    calls: () => calls,
  }
}

const MEMORY_FACT: SystemMemoryProbeResult = { totalBytes: 1000, availableBytes: 400, source: 'os-freemem' }

test('createSystemMemoryReader: 30s TTL 内命中缓存（同一对象、capturedAt 保留原采样时刻）', async () => {
  let clock = 1_000
  const { probe, calls } = countingProbe(MEMORY_FACT)
  const reader = createSystemMemoryReader({ probe, now: () => clock, ttlMs: SYSTEM_MEMORY_CACHE_TTL_MS })
  const first = await reader.read()
  assert.deepEqual(first, { totalBytes: 1000, availableBytes: 400, source: 'os-freemem', capturedAt: 1_000 })
  assert.equal(calls(), 1)
  clock = 1_000 + SYSTEM_MEMORY_CACHE_TTL_MS - 1
  assert.equal(await reader.read(), first, 'TTL 内返回同一快照对象')
  assert.equal(calls(), 1, 'TTL 内不再探测')
  clock = 1_000 + SYSTEM_MEMORY_CACHE_TTL_MS
  const refreshed = await reader.read()
  assert.equal(calls(), 2, '到 TTL 边界即重新探测（不可变语义：新快照）')
  assert.equal(refreshed?.capturedAt, 1_000 + SYSTEM_MEMORY_CACHE_TTL_MS, '新快照的 capturedAt 是新采样时刻')
})

test('createSystemMemoryReader: 并发读共享一次探测（单飞），两个调用拿到同一快照对象', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = () => { resolve() } })
  let calls = 0
  const reader = createSystemMemoryReader({
    probe: async () => {
      calls += 1
      await gate
      return MEMORY_FACT
    },
    now: () => 42,
    ttlMs: SYSTEM_MEMORY_CACHE_TTL_MS,
  })
  const a = reader.read()
  const b = reader.read()
  assert.equal(calls, 1, '第二个调用进入在飞通道，不重复探测')
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(first, second, '单飞的两个调用结算为同一快照对象')
  assert.equal(calls, 1)
})

test('createSystemMemoryReader: 探针抛错 → null，且失败同样进 TTL（settings.get 不每帧重试）', async () => {
  let clock = 7
  let calls = 0
  const reader = createSystemMemoryReader({
    probe: async () => {
      calls += 1
      throw new Error('probe-boom')
    },
    now: () => clock,
    ttlMs: 1_000,
  })
  assert.equal(await reader.read(), null)
  assert.equal(await reader.read(), null)
  assert.equal(calls, 1, '失败结果被缓存：TTL 内不重试')
  clock = 7 + 1_000
  assert.equal(await reader.read(), null)
  assert.equal(calls, 2, 'TTL 到期后允许重试')
})

test('createSystemMemoryReader: 不可信的探针数值读作未知；available 超 total 时 clamp', async () => {
  const readerFor = (probe: () => Promise<SystemMemoryProbeResult | null>): ReturnType<typeof createSystemMemoryReader> =>
    createSystemMemoryReader({ probe, now: () => 1, ttlMs: SYSTEM_MEMORY_CACHE_TTL_MS })
  assert.equal(await readerFor(async () => null).read(), null, 'null 探针 = 未知')
  assert.equal(await readerFor(async () => ({ totalBytes: 0, availableBytes: 0, source: 'os-freemem' })).read(), null, 'total 0 = 未知')
  assert.equal(await readerFor(async () => ({ totalBytes: Number.NaN, availableBytes: 1, source: 'os-freemem' })).read(), null, 'NaN = 未知')
  assert.equal(await readerFor(async () => ({ totalBytes: 100, availableBytes: -1, source: 'os-freemem' })).read(), null, '负可用量 = 未知')
  const clamped = await readerFor(async () => ({ totalBytes: 100, availableBytes: 250, source: 'vm-stat' })).read()
  assert.deepEqual(clamped, { totalBytes: 100, availableBytes: 100, source: 'vm-stat', capturedAt: 1 })
})

// ---------------------------------------------------------------------------
// 真探针（按平台分腿）与镜像同形
// ---------------------------------------------------------------------------

test('readSystemMemory: 本平台有探测腿则来源正确且数值自洽；未知平台必须是 null', async () => {
  const snapshot = await readSystemMemory()
  if (process.platform === 'linux') {
    assert.ok(snapshot !== null, 'linux 必须能读 /proc/meminfo')
    assert.equal(snapshot?.source, 'proc-meminfo')
    assert.ok((snapshot?.totalBytes ?? 0) > 0)
    assert.ok((snapshot?.availableBytes ?? -1) >= 0 && (snapshot?.availableBytes ?? 0) <= (snapshot?.totalBytes ?? 0))
    assert.equal(await readSystemMemory(), snapshot, '模块级缓存：第二次读到同一快照对象')
  } else if (process.platform === 'darwin') {
    assert.equal(snapshot?.source, 'vm-stat', 'darwin 的腿是 vm_stat（失败才允许 null）')
  } else if (process.platform === 'win32') {
    assert.equal(snapshot?.source, 'os-freemem')
  } else {
    assert.equal(snapshot, null, '未知平台 = null（绝不伪造）')
  }
})

test('ChamberSystemMemory（wire 镜像）与 SystemMemorySnapshot（生产者）结构同形', () => {
  // 两个方向的赋值是本测试的**编译期**判据（typecheck 会在这里报错）：生产者的快照
  // 能当 wire 镜像发出，镜像也能被当作生产者形态读回——少字段/多字段/可选性漂移都会红。
  const sources: ReadonlyArray<SystemMemorySnapshot['source']> = ['proc-meminfo', 'os-freemem', 'vm-stat']
  const snapshot: SystemMemorySnapshot = { totalBytes: 8, availableBytes: 4, source: 'proc-meminfo', capturedAt: 3 }
  const mirror: ChamberSystemMemory = snapshot
  const back: SystemMemorySnapshot = mirror
  assert.deepEqual(back, snapshot)
  assert.deepEqual(Object.keys(mirror).sort(), ['availableBytes', 'capturedAt', 'source', 'totalBytes'])
  // 运行期再钉一次 source 三值联合：镜像的联合没有少值（每个成员都能过 wire 镜像）。
  for (const source of sources) {
    const asMirror: ChamberSystemMemory = { totalBytes: 1, availableBytes: 1, source, capturedAt: 1 }
    assert.equal(asMirror.source, source)
  }
})
