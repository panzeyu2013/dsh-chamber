/**
 * Session-creation attribution ledger。
 *
 * 把每次应用内会话创建（含 blank）按触发路径标签记账，使「多源启动/切换新增 blank = 0」可测：
 * 没有归因就分不清一个 blank 是冷 boot 交接、预热兜底，还是用户点了 "+"。origin === 'unknown'
 * 表示未被标签覆盖，计数必须为 0。
 *
 * 只记账不判定，不改写任何投影；条目有界（环形，默认 200），只存 id/标签/时间。
 */
import { assertSingletonModule } from './singleton.ts'

/** 触发路径标签（boot 队列 / 预热 / 用户；unknown 仅作仪表覆盖率的失败信号）。 */
export type SessionCreationOrigin = 'user' | 'boot-handoff' | 'boot-fallback' | 'prewarm' | 'unknown'

export const SESSION_CREATION_ORIGINS: readonly SessionCreationOrigin[] = Object.freeze([
  'boot-handoff', 'boot-fallback', 'prewarm', 'user', 'unknown',
])

export interface SessionCreationLedgerEntry {
  sourceId: string
  sessionId: string
  /** 官方临时行（session.create）为 true；fork 子会话为 false。 */
  blank: boolean
  origin: SessionCreationOrigin
  at: number
}

export interface SessionCreationCounters {
  total: number
  blank: number
  byOrigin: Record<SessionCreationOrigin, number>
  blankByOrigin: Record<SessionCreationOrigin, number>
}

function emptyCounters(): SessionCreationCounters {
  return {
    total: 0,
    blank: 0,
    byOrigin: { user: 0, 'boot-handoff': 0, 'boot-fallback': 0, prewarm: 0, unknown: 0 },
    blankByOrigin: { user: 0, 'boot-handoff': 0, 'boot-fallback': 0, prewarm: 0, unknown: 0 },
  }
}

/** 有界账本（环形）。record 是唯一写入口；counters/entries 是只读读出口。 */
export function createSessionCreationLedger(options: { limit?: number } = {}) {
  const limit = options.limit ?? 200
  const entries: SessionCreationLedgerEntry[] = []
  const perSource = new Map<string, SessionCreationCounters>()
  return {
    record(entry: SessionCreationLedgerEntry): void {
      entries.push(entry)
      if (entries.length > limit) entries.splice(0, entries.length - limit)
      let counters = perSource.get(entry.sourceId)
      if (counters === undefined) {
        counters = emptyCounters()
        perSource.set(entry.sourceId, counters)
      }
      counters.total += 1
      counters.byOrigin[entry.origin] += 1
      if (entry.blank) {
        counters.blank += 1
        counters.blankByOrigin[entry.origin] += 1
      }
    },
    counters(): Record<string, SessionCreationCounters> {
      const snapshot: Record<string, SessionCreationCounters> = {}
      for (const [sourceId, counters] of perSource) {
        snapshot[sourceId] = {
          total: counters.total,
          blank: counters.blank,
          byOrigin: { ...counters.byOrigin },
          blankByOrigin: { ...counters.blankByOrigin },
        }
      }
      return snapshot
    },
    entries(): readonly SessionCreationLedgerEntry[] {
      return [...entries]
    },
    /** 仪表覆盖率：未经标签的创建数（判据第二半必须为 0）。 */
    unlabeled(): number {
      let count = 0
      for (const counters of perSource.values()) count += counters.byOrigin.unknown
      return count
    },
    /** 按标签聚合的 blank 计数（新增 blank = 0 判据的输入）。 */
    blankByOrigin(): Record<SessionCreationOrigin, number> {
      const total = emptyCounters().blankByOrigin
      for (const counters of perSource.values()) {
        for (const origin of SESSION_CREATION_ORIGINS) total[origin] += counters.blankByOrigin[origin]
      }
      return total
    },
  }
}

assertSingletonModule('session-create-ledger')

/** 进程级单例（所有壳共享；只读仪表） */
export const sessionCreationLedger = createSessionCreationLedger()

/** 把只读仪表幂等地挂到页面全局一次（供外部直接读，无需 IPC/构建产物；挂函数而非快照）。 */
export function publishSessionCreationInstrument(target: unknown = globalThis): void {
  const host = target as { __dshChamberSessionCreates?: unknown }
  if (host.__dshChamberSessionCreates !== undefined) return
  host.__dshChamberSessionCreates = {
    counters: () => sessionCreationLedger.counters(),
    entries: () => sessionCreationLedger.entries(),
    blankByOrigin: () => sessionCreationLedger.blankByOrigin(),
    unlabeled: () => sessionCreationLedger.unlabeled(),
  }
}
