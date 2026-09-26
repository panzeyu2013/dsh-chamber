/**
 * 事实健康面包屑：把「观察者其实一直不可判」落成**盘上可读**的证据。
 *
 * 生产缺陷的形状是「页面里没人能看出来观察者从没取到过基线」：判定面因此永久冻结，
 * 而外部只能看到空账本。本模块复用权威动作日志的**有界环**（dsh-chamber.authority-log.v1，
 * 每来源 32 条，never-throw），不新增存储键、不新增隐私面：只写状态与计数。
 *
 * 只在**状态**（可判性 + 不可判起点 + 失败原因）变化时写一条，计数（基线次数/重连/行数…）
 * 只进那一刻的 detail。理由：环只有 32 条、它是时间线不是计数器——若把单调计数编进签名，
 * 健康源每 30s 一次的成功对账（baselines+1）就能把「曾经坏过」的证据挤出环外；
 * 高频重复异常同样不许刷环（`error()` 按来源去重）。
 *
 * 纪律与 authority-log-store 同款：诊断绝不打断账本链——storage 缺失/配额/敌意形状
 * 一律降级为「没有证据」，绝不抛错。
 */
import {
  appendAuthorityLog,
  authorityLogStorage,
  type AuthorityLogStorage,
} from '@dsh-chamber/dsh-chamber-client-core/authority-log-store'

const FACTS_HEALTH_KIND = 'facts-health'
const UNREAD_DERIVE_ERROR_KIND = 'unread-derive-error'

/** 一次采样的判定面事实（全部是可读计数；不含标题、不含 transcript）。 */
export interface FactsHealthSample {
  readonly ready: boolean
  readonly staleSince: number | null
  readonly baselines: number
  readonly baselineFailures: number
  readonly baselineResamples: number
  readonly baselineFailureReason: string | null
  readonly reconnects: number
  readonly socketErrors: number
  readonly rows: number
  /** 输入行的最大内容水位（0 = 全部行都没有 host 水位）：未读面「播种不消费」的现场读数。 */
  readonly maxWatermark: number
  /** 最近一次可信基线的时刻（null = 从未取到过）：区分「从没基线」与「基线变旧」。 */
  readonly lastTrustedBaselineAt: number | null
}

/** 等价性签名：只编码**状态**的三项可读面——可判性、是否处于不可判窗口（staleSince 是否为 null）、失败原因。计数不进签名（见文件头）。 */
function factsHealthSignature(sample: FactsHealthSample): string {
  return [
    sample.ready ? 'ok' : 'down',
    sample.staleSince === null ? '-' : 'stale',
    sample.baselineFailureReason ?? '-',
  ].join('|')
}

/** 一行紧凑 detail：读环的人不必再去页面里查状态（状态转折那一刻的计数快照）。 */
function factsHealthDetail(sample: FactsHealthSample): string {
  return 'ready=' + (sample.ready ? '1' : '0')
    + ' rows=' + String(sample.rows)
    + ' maxWatermark=' + String(sample.maxWatermark)
    + ' baselines=' + String(sample.baselines)
    + ' baselineFailures=' + String(sample.baselineFailures)
    + ' resamples=' + String(sample.baselineResamples)
    + ' reconnects=' + String(sample.reconnects)
    + ' socketErrors=' + String(sample.socketErrors)
    + ' lastBaseline=' + (sample.lastTrustedBaselineAt === null ? '-' : String(sample.lastTrustedBaselineAt))
    + ' reason=' + (sample.baselineFailureReason ?? '-')
}

export interface FactsHealthRecorder {
  /**
   * 记录一次采样；只在**状态**变化时写环。返回是否发生状态变化（写入本身是 best-effort：
   * storage 缺失或抛错都降级为「没有证据」，true 只表示这不是一次重复采样）。
   */
  record(sourceId: string, sample: FactsHealthSample): boolean
  /** 派生/接线抛错的面包屑（never-throw，供 never-throw 包装层调用；同一来源同一异常只留一条）。 */
  error(sourceId: string, message: string): void
}

/** never-throw 包装的记账出口（recorder 只取 error 一面的窄化；测试可注入假实现）。 */
export interface FactsStepErrorSink {
  error(sourceId: string, message: string): void
}

/**
 * 步骤级 never-throw 包装：**唯一**的未读派生/接线失败面（design 19 §3.7.1 诊断）。
 * 异常 → 事实健康环 + loud 一次（按来源 + 步骤去重：确定性异常每拍都抛，环与 console
 * 都不得被刷屏），返回值 undefined；调用方的控制流不回退（下一步照常执行）。
 */
export interface FactsStepGuard {
  /** 执行一步：异常落环 + loud 一次，返回 undefined。 */
  guard<T>(sourceId: string, step: string, run: () => T): T | undefined
}

export function createFactsStepGuard(
  recorder: FactsStepErrorSink,
  warn: (message: string, ...rest: readonly unknown[]) => void = console.warn,
): FactsStepGuard {
  const warned = new Set<string>()
  const report = (sourceId: string, step: string, error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error)
    recorder.error(sourceId, step + ': ' + message)
    const key = sourceId + '|' + step
    if (warned.has(key)) return
    warned.add(key)
    warn('[unread] ' + step + ' 失败（保持上一拍）：', sourceId, message)
  }
  return {
    guard(sourceId, step, run) {
      try {
        return run()
      } catch (error) {
        report(sourceId, step, error)
        return undefined
      }
    },
  }
}

export function createFactsHealthRecorder(
  now: () => number = () => Date.now(),
  storage: AuthorityLogStorage | undefined = authorityLogStorage(),
): FactsHealthRecorder {
  const last = new Map<string, string>()
  const lastError = new Map<string, string>()
  return {
    record(sourceId: string, sample: FactsHealthSample): boolean {
      const signature = factsHealthSignature(sample)
      if (last.get(sourceId) === signature) return false
      last.set(sourceId, signature)
      // 状态已经前进 ⇒ 同一异常再次出现要重新留证。
      lastError.delete(sourceId)
      if (storage === undefined) return true
      appendAuthorityLog(storage, sourceId, {
        at: now(), kind: FACTS_HEALTH_KIND, detail: factsHealthDetail(sample),
      })
      return true
    },
    error(sourceId: string, message: string): void {
      // 只写前 200 字符：错误文本足够定位，不给环灌长文；同一来源的同一异常只留一条
      // （确定性异常会在每个快照拍上重复，几拍就能冲光 32 条环）。
      const text = message.slice(0, 200)
      if (lastError.get(sourceId) === text) return
      lastError.set(sourceId, text)
      if (storage === undefined) return
      appendAuthorityLog(storage, sourceId, {
        at: now(), kind: UNREAD_DERIVE_ERROR_KIND, detail: text,
      })
    },
  }
}
