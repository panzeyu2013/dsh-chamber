/**
 * Prewarm ledger：白壳预热的命中率（hits / attempts，无尝试时为 0，不臆造）。
 *   - attempt：一次后台挂载真的开始（drainPrewarm 选出目标并加入 mountedViews）；
 *   - hit：用户选中了仍在自动预热集合里的来源——预热确实被用上了；
 *   - cancelled：在途预热随来源退役而作废（尚未被任何人用上）。
 * 逐来源计数 + 全局合计；只读有界，以函数视图挂全局。
 */

export type PrewarmEvent = 'attempt' | 'hit' | 'cancelled'

export interface PrewarmCounters {
  attempts: number
  hits: number
  cancelled: number
}

function empty(): PrewarmCounters {
  return { attempts: 0, hits: 0, cancelled: 0 }
}

export function createPrewarmLedger() {
  const perSource = new Map<string, PrewarmCounters>()
  return {
    record(event: PrewarmEvent, sourceId: string): void {
      if (sourceId === '') return
      let counters = perSource.get(sourceId)
      if (counters === undefined) {
        counters = empty()
        perSource.set(sourceId, counters)
      }
      if (event === 'attempt') counters.attempts += 1
      else if (event === 'hit') counters.hits += 1
      else counters.cancelled += 1
    },
    counters(): Record<string, PrewarmCounters> {
      const snapshot: Record<string, PrewarmCounters> = {}
      for (const [sourceId, counters] of perSource) snapshot[sourceId] = { ...counters }
      return snapshot
    },
    totals(): PrewarmCounters {
      const total = empty()
      for (const counters of perSource.values()) {
        total.attempts += counters.attempts
        total.hits += counters.hits
        total.cancelled += counters.cancelled
      }
      return total
    },
    /** 命中率（0–1）；没有尝试时返回 0（不是 1——不臆造"完美"）。 */
    hitRate(): number {
      const total = this.totals()
      return total.attempts === 0 ? 0 : total.hits / total.attempts
    },
  }
}

export const prewarmLedger = createPrewarmLedger()

/** 幂等挂全局（函数视图；measure-ui 的 watcher 字段会读它）。 */
export function publishPrewarmInstrument(target: unknown = globalThis): void {
  const host = target as { __dshChamberPrewarm?: unknown }
  if (host.__dshChamberPrewarm !== undefined) return
  host.__dshChamberPrewarm = {
    counters: () => prewarmLedger.counters(),
    totals: () => prewarmLedger.totals(),
    hitRate: () => prewarmLedger.hitRate(),
  }
}

/** App 侧一次记账（自带仪器安装：第一次记账即挂全局）。 */
export function recordPrewarm(event: PrewarmEvent, sourceId: string): void {
  prewarmLedger.record(event, sourceId)
  publishPrewarmInstrument()
}
