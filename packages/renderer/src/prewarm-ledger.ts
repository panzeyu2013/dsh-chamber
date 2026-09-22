/**
 * Prewarm ledger：白壳预热的**命中率**必须可判（≥80%），
 * 否则"预热有没有用"只能靠感觉。
 *
 * 三个事件的确切定义（接线点见 App.tsx，均有源文本锁）：
 *   - attempt：一次后台挂载**真的开始**（drainPrewarm 选出目标并加入 mountedViews）；
 *   - hit：用户**选中**了一个仍在自动预热集合里的来源——预热确实被用上了；
 *   - cancelled：在途预热随来源退役而作废（还没被任何人用上就消失）。
 * 命中率 = hits / attempts（无尝试时为 0，不臆造）。逐来源计数，另有全局合计；
 * 只读、有界（每来源仅计数），发布为函数视图的页面全局。
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

/** 进程级单例（只读仪表）。 */
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
