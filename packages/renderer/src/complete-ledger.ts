/**
 * complete 通知记忆的单一账本内核。
 *
 * 状态面（design 19 §3.2.3）：**三张 durable 表 + 五项易失 per-source 表**：
 *   - notified（durable）：facts 入口的已通知水位（每 (source, session, kind)，单调只升）；
 *   - outcomes（durable）：目标/中性标题的**一次性身份**（每 (source, goalId) 的水位）——
 *     R2-A/TL1：同一 goalId 的「目标已完成/已受阻/未继续运行」至多发一次，其后一律回落
 *     「会话已完成」；
 *   - pending（durable）：目标活跃期间被压制的完成结算位（每 (source, session)）；
 *   - armed（volatile）：壳边沿的「已发 complete 直到重新 running」武装位；
 *   - armedFloor（volatile）：与 armed 同拍的已消费水位上界（F5 阻断项 2）；
 *   - settleFence（volatile）：无水位消费的 emit 后的一次性围栏（A2/A3-3/B3-1）；
 *   - generation（volatile）：每来源当前代（G1 门）；
 *   - goalKnown（volatile）：§3.5 结算点记忆（首份已知 goal 事实）。
 *
 * 键空间、读取、写入与整体清除只有一处（两级键 source → session/goalId）；App 只持有
 * 一个引用，per-source 剪枝不会漏表。本模块不重写任何一轨的裁定规则：水位原语在
 * watermark.ts，水平收敛器在 notification-projection.reconcile（直接读写本模块的
 * CompletionDecisionState）。
 *
 * 撤回语义（R2-D）：forgetArmed / withdraw 清 armed + armedFloor + pending +
 * settleFence + goalKnown（撤回窗口内的完成不得在恢复后补发，附属围栏不得跨撤回存活，
 * 结算点记忆随会话身份作废），notified/outcomes 保持 durable；forgetSession 对单会话
 * 执行同一纪律（B4-2：goalKnown 不得在会话 churn 下泄漏）；forget/prune 收敛全部
 * **8 张 per-source 表**（durable + 易失）。页代 token 的单源是 boot-token.ts：
 * 本账本不保留副本、不参与来源收敛（见 {@link CompleteLedgerOptions.bootToken}）。
 *
 * 加载期卫生（§3.5）：boot='fresh'（新进程/新窗口）丢弃全部 pending 并 loud；
 * boot='same'（reload）保留 pending，但超过 PENDING_MAX_AGE_MS 的条目丢弃并 loud
 * （卫生上界，不是判定计时器）。
 *
 * 身份键空间（D1，独立于水位面）：notifiedRuns = source → session → 最后一次已通知的
 * SessionRunId（unread v4 的持久来源；v2 迁移对旧水位表写 LEGACY_NOTIFIED_RUN_ID
 * 哨兵），以及易失的 runtimeSettled = source → session → 原生结算边沿的 host updatedAt
 * 锚点（无 host 身份的运行完成后，下一份可信 host 完成据此认领身份）。身份面与水位的
 * notified/pending/outcomes 只并列存储、互不混写：水位裁定仍全部走 state()。
 */
import { isWatermark, maxWatermarkValue } from './watermark.ts'
import type { UnreadKind } from './watermark.ts'
import type { SessionRunId } from '@dsh-chamber/dsh-stream-state'

/** v2 未读 payload 的 notified 段：source → session → kind → 已通知水位。 */
export type NotifiedWatermarkTable = Record<string, Record<string, Partial<Record<UnreadKind, number>>>>

/** 身份 spine：source → session → 最后一次已通知的 SessionRunId（unread v4 持久来源）。 */
export type NotifiedRunTable = Record<string, Record<string, SessionRunId>>

/** 被压制完成的 pending 条目（v5 §3.1）。 */
export interface PendingCompletion {
  /** facts 入口的内容水位；壳证据入场时缺席（缺席 ⇒ 结算时置 settleFence）。 */
  watermark?: number
  /** 压制时该会话的 goal 身份；goalId 变化 ⇒ drop（§3.4 #3）。 */
  goalId?: string
  /**
   * 延迟来源（G4）：busy 只延迟「此刻本应直发」的完成（goal null/paused/unknown），
   * 不制造目标压制。带此标记的 pending 在 busy 结束后必须中性释放一次（§3.2.3
   * #10/#11 语义），不得被 #3/#G3 静默 drop 或永久留存（评审 A 阻断项）；只有新建
   * pending 时采纳——已有 pending（目标 hold）保持自己的身份。
   */
  deferred?: 'subagent-busy'
  /** 入场时刻（毫秒；年龄上界卫生用，非判定计时器）。 */
  at: number
}

/** pending 段：source → session → 结算位。 */
export type PendingCompletionTable = Record<string, Record<string, PendingCompletion>>

/**
 * settleFence 的围栏条目（A2/A3-3/B3-1 围栏边界重构）：一次**无水位消费**的 emit
 * （壳候选直发 / flush 无水位 / releaseDeferred 无水位）之后置下的一次性守卫。
 *   - boundary：置栏观测当时该会话观察层**已吸收**的 facts 水位（不可知 = 0）；
 *   - seededSince：facts 播种批只播种到 ≤ boundary 时记录——被守卫的完成尚未在
 *     facts 侧出现，其后第一条严格更高的候选按「首次上报」吞一次（见 reconcile 的
 *     吞栏判定）；播种到 > boundary 时围栏直接清除（播种已吸收被守卫的完成）。
 */
export interface SettleFenceEntry {
  boundary: number
  seededSince?: number
}

/** settleFence 段：source → session → 围栏（易失，不落盘）。 */
export type SettleFenceTable = Record<string, Record<string, SettleFenceEntry>>

/** outcomes 段：source → goalId → 已消费标题的水位（一次性身份）。 */
export type GoalOutcomeTable = Record<string, Record<string, number>>

/**
 * reconcile 的完整状态（v5 §3.1：三张 durable 表 + 五项易失状态）。
 * durable 三表（notified/pending/outcomes）走 unread payload 增量；其余全部易失：
 *   - armed：壳边沿武装位；
 *   - armedFloor：与 armed 同拍的「已消费水位上界」（arm 时写；见字段注释）；
 *   - settleFence：无水位消费的 emit 后按 boundary（置栏时已吸收的 facts 水位）
 *     守卫该会话的下一次 facts 上报一次（§3.3；A2/A3-3/B3-1 的边界判定在
 *     notification-projection.swallowFactsCandidateByFence）；
 *   - generation：每来源当前代（G1 代际门）；
 *   - goalKnown：已见已知 goal 事实的会话（§3.5 结算点：首份已知事实即 outcome/null ⇒
 *     静默结清，离线完成不补发）；随会话身份同拍作废（forgetSession / withdraw /
 *     forget / prune；B4-2），绝不跨会话 churn 泄漏。
 */
export interface CompletionDecisionState {
  notified: NotifiedWatermarkTable
  pending: PendingCompletionTable
  outcomes: GoalOutcomeTable
  armed: Record<string, Set<string>>
  /**
   * 与 armed 逐会话同拍的易失水位界（F5 阻断项 2）：arm 时记录「该次消费的
   * candidate/notified 水位上界」。armed 门只吞水位 ≤ 界的 facts 候选（同一完成的
   * 重复上报）；水位严格更高 = 新完成。没有它时，无 running=true 帧的 facts-only
   * 来源（poll/重连跳变）会在首次 arm 后永久吞掉后续所有完成。
   * 无界的武装（旧 setArmed 入口，无消费水位可记）保持原汇合语义（不写界）。
   */
  armedFloor: Record<string, Record<string, number>>
  settleFence: SettleFenceTable
  generation: Record<string, number>
  goalKnown: Record<string, Set<string>>
}

/** pending 卫生上界（§3.5 建议 7 天；加载时丢弃更老条目并 loud）。 */
export const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000

/** 加载期选项（旧调用点只传 notified 表时全部取默认）。 */
export interface CompleteLedgerOptions {
  /** 持久化读出的 pending 表（unread v4 payload.pending）。 */
  pending?: PendingCompletionTable
  /** 持久化读出的 outcomes 表（unread v4 payload.outcomes）。 */
  outcomes?: GoalOutcomeTable
  /** same = reload（保留 pending）；fresh = 新进程/新窗口（丢弃 pending 并 loud）。缺省 same。 */
  boot?: 'same' | 'fresh'
  /**
   * sessionStorage 页代 token（**兼容入参，账本不再保留副本**）：页代 token 的单源
   * 是 boot-token.ts（App 的 unreadBoot.boot.token，经 completionIdentity 进观测层
   * identity）；本账本既不读也不存它，保留该键只为 App 调用点继续按原签名传入
   * （App 不在本次改动范围）。新调用点无需提供。
   */
  bootToken?: string
  /** 年龄判定基准（测试注入；缺省 Date.now()）。 */
  now?: number
  /** 卫生上界覆盖（测试注入；非正数回落到 PENDING_MAX_AGE_MS）。 */
  maxPendingAgeMs?: number
  /** loud 出口（缺省 console.warn；never-throw）。 */
  onDiagnostic?: (message: string, detail?: unknown) => void
}

/** 通知水位与壳边沿武装位的合并账本（App 单例持有）。 */
export interface CompleteLedger {
  /** 完整状态（reconcile 直接读写；durable 三表是持久化来源）。 */
  state(): CompletionDecisionState
  /** 水位轨：v2 落盘读出的表（内部对象，调用方只读）。 */
  notifiedTable(): NotifiedWatermarkTable
  /**
   * 水位轨：单会话单类别已通知水位。
   *
   * **仅测试/诊断面（D4 标注）**：生产无调用——reconcile 直接读写
   * `state().notified`；保留给用例构造/直读与持久化核对。新生产代码不得以它为
   * 接线面（需要水位请走 `state()`，与 reconcile 同纪律）。
   */
  notifiedWatermark(sourceId: string, sessionId: string, kind: UnreadKind): number | undefined
  /** **仅测试/诊断面**（D4）：语义同 {@link notifiedWatermark}。 */
  setNotifiedWatermark(sourceId: string, sessionId: string, kind: UnreadKind, watermark: number): void
  /** 身份轨：落盘读出的表（内部对象，调用方只读；持久化来源是 unread v4 payload.notifiedRuns）。 */
  notifiedRunTable(): NotifiedRunTable
  /** 身份轨：该会话最后一次已通知的运行身份（重复观察同一身份 = 不重发）。 */
  notifiedRun(sourceId: string, sessionId: string): SessionRunId | undefined
  /** 身份轨：写入一笔（同 id 幂等）；命中即消费该会话的 runtimeSettled 待归属标记。 */
  setNotifiedRun(sourceId: string, sessionId: string, runId: SessionRunId): void
  /** 无 host 身份的运行时完成已获原生结算；值 = 该边沿覆盖到的 host updatedAt 锚点（undefined = 无锚点）。 */
  runtimeSettled(sourceId: string): ReadonlyMap<string, number | undefined>
  markRuntimeSettled(sourceId: string, sessionId: string, hostObservedAt?: number): void
  /** pending 轨：整表（持久化来源）。 */
  pendingTable(): PendingCompletionTable
  /** **仅测试/诊断面（D4）**：pending 轨单会话结算位；生产路径（reconcile / 各自分支）直接经 `state().pending` 读写。 */
  pendingEntry(sourceId: string, sessionId: string): PendingCompletion | undefined
  /**
   * **仅测试/诊断面（D4）**：pending 轨单会话写入；生产零调用——reconcile 与各结算
   * 分支直接经 `state().pending` 写时复制（见 notification-projection 的
   * writePending/dropPending）。与 {@link pendingEntry} 对应，保留给用例构造/直读。
   */
  setPending(sourceId: string, sessionId: string, entry: PendingCompletion): void
  /**
   * **仅测试/诊断面（D4）**：pending 轨单会话清除；生产零调用——生产清理由
   * reconcile 的 dropPending 与账本内部 forgetSessionScope 闭包承担。语义同
   * {@link setPending}（构造/核对用）。
   */
  clearPending(sourceId: string, sessionId: string): void
  /** outcomes 轨：整表（持久化来源）。 */
  outcomesTable(): GoalOutcomeTable
  /** **仅测试/诊断面（D4）**：outcomes 轨该 goalId 是否已消费过标题；生产经 `state().outcomes`。 */
  outcomeWatermark(sourceId: string, goalId: string): number | undefined
  /** **仅测试/诊断面**（D4）：语义同 {@link outcomeWatermark}。 */
  setOutcome(sourceId: string, goalId: string, watermark: number): void
  /**
   * 武装轨：该来源当前武装集合。
   *
   * **仅测试面（F14 标注）**：生产的水平收敛器 `reconcile` 直接读写
   * `state().armed`，从不经过本入口；`armed`/`setArmed` 保留给用例构造/直读武装位
   * （撤回/遗忘测试）。新的生产代码不得以它们为接线面——需要武装位请走 `state()`
   * （与 reconcile 同纪律）。
   */
  armed(sourceId: string): ReadonlySet<string>
  /** 武装轨：写回集合（空集 = 删除该来源的表项）；**仅测试面**，语义同 {@link armed}。 */
  setArmed(sourceId: string, sessions: ReadonlySet<string>): void
  /** 来源退役：全部 per-source 表（3 durable + 5 易失）同拍删除（同 id 重加 = 新来源代，不得继承上一代判定）。 */
  forget(sourceId: string): void
  /**
   * 撤回（旧名）：清 armed + pending + settleFence + goalKnown，保留 durable 的
   * notified/outcomes（R2-D）。通道撤回（壳重连/重 boot）时调用；恢复后首份观测
   * 不补发窗口内完成，且不得围栏吞掉窗口外的下一条真完成。
   */
  forgetArmed(sourceId: string): void
  /** 撤回（显式名）：语义同 forgetArmed。 */
  withdraw(sourceId: string): void
  /** 只清 pending 不清 armed（诊断/局部收敛用）。 */
  forgetPending(sourceId: string): void
  /**
   * 会话消失（两条通道都不再列出，§3.1）：该会话的 armed + settleFence + pending
   * + goalKnown 同拍清（notified/outcomes 保持 durable），与来源级撤回同纪律、只收窄
   * 到单会话。不这样做时，残留围栏/武装会吞掉重现会话之后的新完成，且水位已被静默
   * 推进（评审 A 重要项）；goalKnown 残留则是会话级泄漏（B4-2），会话重现时首份已知
   * goal 事实也不再是 §3.5 结算点。
   */
  forgetSession(sourceId: string, sessionId: string): void
  /**
   * facts 播种批消费（F5 重要项 3；A2/A3-3/B3-1 边界化）：播种 = 对「被栏守卫的
   * 完成」的等价消费。seededWatermark > boundary ⇒ 播种吸收的正是那条完成 ⇒ 清栏；
   * 否则只播种到 ≤ boundary ⇒ seededSince = max(旧值, 水位) 并保留（其后首条严格
   * 更高的候选由吞栏判定吞一次）。无栏会话 = no-op。
   */
  seedSettleFence(sourceId: string, sessionId: string, seededWatermark: number): void
  /** 按现存来源集合剪枝；返回是否有变化（调用方据此决定是否重建引用）。 */
  prune(liveIds: ReadonlySet<string>): boolean
}

const EMPTY_ARMED: ReadonlySet<string> = new Set()
const EMPTY_SETTLED: ReadonlyMap<string, number | undefined> = new Map()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 条目的成立条件只有 at（有限数）；watermark/goalId 是判定字段，坏值整条不成立。
 * deferred 是**字段级**清洗（与 unread-store.sanitizeUnreadPayload 同口径）：非法值
 * 只丢该字段、moved 到加载循环里剥掉——deferred 缺失时条目仍可用于水位结算，
 * 整条丢弃反而会在离线/降级路径静默丢一次完成。
 */
function isPendingCompletion(value: unknown): value is PendingCompletion {
  if (!isPlainRecord(value)) return false
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return false
  if (value.watermark !== undefined && !isWatermark(value.watermark)) return false
  if (value.goalId !== undefined && (typeof value.goalId !== 'string' || value.goalId.length === 0)) return false
  return true
}

function copyOutcomes(outcomes: GoalOutcomeTable | undefined): GoalOutcomeTable {
  const next: GoalOutcomeTable = {}
  if (outcomes === undefined) return next
  for (const [sourceId, table] of Object.entries(outcomes)) {
    if (!isPlainRecord(table)) continue
    const copy: Record<string, number> = {}
    for (const [goalId, watermark] of Object.entries(table)) {
      if (isWatermark(watermark)) copy[goalId] = watermark
    }
    if (Object.keys(copy).length > 0) next[sourceId] = copy
  }
  return next
}

/**
 * @param initialNotified - 持久化读数：水位表（unread v2 遗留 shape）或身份表
 *   （unread v4 payload.notifiedRuns）；逐行按值的形状分流后浅拷贝、写时复制。
 * @param options - 持久化 pending/outcomes + boot/年龄卫生（旧调用点省略）。
 */
export function createCompleteLedger(
  initialNotified: NotifiedWatermarkTable | NotifiedRunTable = {},
  options: CompleteLedgerOptions = {},
): CompleteLedger {
  const initialWatermarks: NotifiedWatermarkTable = {}
  const initialRuns: NotifiedRunTable = {}
  for (const [sourceId, sessions] of Object.entries(initialNotified)) {
    if (!isPlainRecord(sessions)) continue
    const rows = Object.entries(sessions)
    if (rows.length > 0 && rows.every(([, value]) => typeof value === 'string')) {
      const table: Record<string, SessionRunId> = {}
      for (const [sessionId, runId] of rows) table[sessionId] = runId as SessionRunId
      initialRuns[sourceId] = table
      continue
    }
    const table: Record<string, Partial<Record<UnreadKind, number>>> = {}
    for (const [sessionId, kinds] of rows) {
      if (!isPlainRecord(kinds)) continue
      const row: Partial<Record<UnreadKind, number>> = {}
      for (const kind of ['complete', 'ask', 'request'] as const) {
        if (isWatermark(kinds[kind])) row[kind] = kinds[kind]
      }
      if (Object.keys(row).length > 0) table[sessionId] = row
    }
    if (Object.keys(table).length > 0) initialWatermarks[sourceId] = table
  }
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  const maxAge = typeof options.maxPendingAgeMs === 'number' && Number.isFinite(options.maxPendingAgeMs) && options.maxPendingAgeMs > 0
    ? options.maxPendingAgeMs
    : PENDING_MAX_AGE_MS
  const report = (message: string, detail?: unknown): void => {
    try {
      if (options.onDiagnostic !== undefined) options.onDiagnostic(message, detail)
      else console.warn('[complete-ledger] ' + message, detail ?? '')
    } catch {
      /* diagnostics are best-effort */
    }
  }

  const state: CompletionDecisionState = {
    notified: initialWatermarks,
    pending: {},
    outcomes: copyOutcomes(options.outcomes),
    armed: {},
    armedFloor: {},
    settleFence: {},
    generation: {},
    goalKnown: {},
  }

  // 加载期卫生：fresh 丢弃全部 pending；same 只丢年龄超界/坏形状（loud）。
  let droppedFresh = 0
  let droppedStale = 0
  let droppedMalformed = 0
  let droppedFields = 0
  const persistedPending = options.pending ?? {}
  for (const [sourceId, sessions] of Object.entries(persistedPending)) {
    if (!isPlainRecord(sessions)) {
      droppedMalformed += 1
      continue
    }
    const kept: Record<string, PendingCompletion> = {}
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (!isPendingCompletion(entry)) {
        droppedMalformed += 1
        continue
      }
      if (options.boot === 'fresh') {
        droppedFresh += 1
        continue
      }
      if (now - entry.at > maxAge) {
        droppedStale += 1
        continue
      }
      // deferred 字段级清洗：非法值丢掉该字段，at 成立即保留整条（与未读 v2 的
      // sanitizeUnreadPayload 完全同口径；两条加载路径不得对同一载荷给出不同结果）。
      const sanitized: PendingCompletion = { ...entry }
      if (sanitized.deferred !== undefined && sanitized.deferred !== 'subagent-busy') {
        delete sanitized.deferred
        droppedFields += 1
      }
      kept[sessionId] = sanitized
    }
    if (Object.keys(kept).length > 0) state.pending[sourceId] = kept
  }
  if (droppedMalformed > 0) report('discarded ' + String(droppedMalformed) + ' malformed pending entr(ies)')
  if (droppedFields > 0) report('dropped ' + String(droppedFields) + ' invalid pending field(s); entries kept')
  if (droppedFresh > 0) {
    report(
      'fresh boot (new process/window): discarded ' + String(droppedFresh) +
      ' pending completion(s); notified/outcomes stay durable',
    )
  }
  if (droppedStale > 0) {
    report('discarded ' + String(droppedStale) + ' pending completion(s) older than ' + String(maxAge) + 'ms')
  }

  /** 身份轨（独立键空间）：持久身份 + 易失的原生结算待归属标记。 */
  let notifiedRuns: NotifiedRunTable = { ...initialRuns }
  let runtimeSettled: Record<string, Map<string, number | undefined>> = {}

  /** 待归属标记消费（写时复制；空 map 收敛掉来源表项）。setNotifiedRun 命中即清。 */
  const clearRuntimeSettled = (sourceId: string, sessionId: string): void => {
    const sessions = runtimeSettled[sourceId]
    if (sessions === undefined || !sessions.has(sessionId)) return
    const nextSessions = new Map(sessions)
    nextSessions.delete(sessionId)
    const next = { ...runtimeSettled }
    if (nextSessions.size === 0) delete next[sourceId]
    else next[sourceId] = nextSessions
    runtimeSettled = next
  }

  const clearPending = (sourceId: string, sessionId: string): void => {
    const table = state.pending[sourceId]
    if (table === undefined || table[sessionId] === undefined) return
    const next = { ...table }
    delete next[sessionId]
    if (Object.keys(next).length === 0) {
      const sources = { ...state.pending }
      delete sources[sourceId]
      state.pending = sources
    } else {
      state.pending = { ...state.pending, [sourceId]: next }
    }
  }

  /** 单会话围栏清除（写时复制；空表收敛掉来源表项）。 */
  const clearFenceSession = (sourceId: string, sessionId: string): void => {
    const table = state.settleFence[sourceId]
    if (table === undefined || table[sessionId] === undefined) return
    const next = { ...table }
    delete next[sessionId]
    if (Object.keys(next).length === 0) {
      const sources = { ...state.settleFence }
      delete sources[sourceId]
      state.settleFence = sources
    } else {
      state.settleFence = { ...state.settleFence, [sourceId]: next }
    }
  }

  /**
   * facts 播种批消费（见接口注释）：按 boundary 裁决清栏 / 记 seededSince。
   * seededSince 单调取 max（同一次播种批重放 / 多次恢复批不得把界回退）。
   */
  const seedFenceSession = (sourceId: string, sessionId: string, seededWatermark: number): void => {
    const table = state.settleFence[sourceId]
    const fence = table?.[sessionId]
    if (table === undefined || fence === undefined) return
    if (seededWatermark > fence.boundary) {
      clearFenceSession(sourceId, sessionId)
      return
    }
    const seededSince = maxWatermarkValue(fence.seededSince, seededWatermark)
    state.settleFence = {
      ...state.settleFence,
      [sourceId]: { ...table, [sessionId]: { boundary: fence.boundary, seededSince } },
    }
  }

  /** 单会话水位界清除（写时复制；空表收敛掉来源表项）。 */
  const clearArmedFloorSession = (sourceId: string, sessionId: string): void => {
    const table = state.armedFloor[sourceId]
    if (table === undefined || table[sessionId] === undefined) return
    const next = { ...table }
    delete next[sessionId]
    if (Object.keys(next).length === 0) {
      const sources = { ...state.armedFloor }
      delete sources[sourceId]
      state.armedFloor = sources
    } else {
      state.armedFloor = { ...state.armedFloor, [sourceId]: next }
    }
  }

  /**
   * 单会话结算点记忆清除（B4-2；写时复制；空集收敛掉来源表项）。goalKnown 是
   * §3.5 的「首份已知 goal 事实即静默结清」记忆，与会话身份同寿：会话消失后它不再
   * 有可结算的对象，残留即会话级泄漏（长活来源的 churn 会让表缓慢增长）。
   */
  const clearGoalKnownSession = (sourceId: string, sessionId: string): void => {
    const current = state.goalKnown[sourceId]
    if (current?.has(sessionId) !== true) return
    const next = new Set(current)
    next.delete(sessionId)
    const tables = { ...state.goalKnown }
    if (next.size === 0) delete tables[sourceId]
    else tables[sourceId] = next
    state.goalKnown = tables
  }

  /** 单会话武装位清除（写时复制；空集收敛掉来源表项；水位界同拍清）。 */
  const clearArmedSession = (sourceId: string, sessionId: string): void => {
    clearArmedFloorSession(sourceId, sessionId)
    const current = state.armed[sourceId]
    if (current?.has(sessionId) !== true) return
    const next = new Set(current)
    next.delete(sessionId)
    const tables = { ...state.armed }
    if (next.size === 0) delete tables[sourceId]
    else tables[sourceId] = next
    state.armed = tables
  }

  /**
   * 会话消失（§3.1）：armed + settleFence + pending 同拍清（notified/outcomes durable）。
   * 与 withdrawSource 同一纪律，只是作用域为一个会话：残留围栏/武装会让重现会话的
   * **新**完成被静默吞掉（facts 候选被围栏消费或被武装门单调记账），而消除它们的
   * 依据（会话已不在两条通道）恰恰要求旧身份一起作废。
   */
  const forgetSessionScope = (sourceId: string, sessionId: string): void => {
    clearPending(sourceId, sessionId)
    clearArmedSession(sourceId, sessionId)
    clearFenceSession(sourceId, sessionId)
    clearGoalKnownSession(sourceId, sessionId)
  }

  /**
   * 撤回：armed + pending + settleFence 同拍清（notified/outcomes 保持 durable）。
   * settleFence 是「无 facts 水位的 pending 结算」的附属易失轨：pending 被撤回后
   * 它守卫的那次完成已不再是待结算身份，围栏必须随之消失——否则它会吞掉恢复后
   * 第一条**新的** facts 候选（撤回窗口外的真完成），而那条候选与旧完成无关。
   */
  const withdrawSource = (sourceId: string): void => {
    if (state.armed[sourceId] !== undefined) {
      const next = { ...state.armed }
      delete next[sourceId]
      state.armed = next
    }
    if (state.pending[sourceId] !== undefined) {
      const next = { ...state.pending }
      delete next[sourceId]
      state.pending = next
    }
    if (state.settleFence[sourceId] !== undefined) {
      const next = { ...state.settleFence }
      delete next[sourceId]
      state.settleFence = next
    }
    if (state.armedFloor[sourceId] !== undefined) {
      const next = { ...state.armedFloor }
      delete next[sourceId]
      state.armedFloor = next
    }
    // B4-2：结算点记忆与会话身份同批作废（撤回窗口内的完成恢复后不补发；会话若重现，
    // 首份已知 goal 事实重新成为 §3.5 结算点）。notified/outcomes 仍 durable。
    if (state.goalKnown[sourceId] !== undefined) {
      const next = { ...state.goalKnown }
      delete next[sourceId]
      state.goalKnown = next
    }
  }

  return {
    state() { return state },
    notifiedTable() { return state.notified },
    notifiedWatermark(sourceId, sessionId, kind) {
      return state.notified[sourceId]?.[sessionId]?.[kind]
    },
    setNotifiedWatermark(sourceId, sessionId, kind, watermark) {
      const sourceTable = state.notified[sourceId] ?? {}
      const row = sourceTable[sessionId] ?? {}
      state.notified = { ...state.notified, [sourceId]: { ...sourceTable, [sessionId]: { ...row, [kind]: watermark } } }
    },
    notifiedRunTable() { return notifiedRuns },
    notifiedRun(sourceId, sessionId) { return notifiedRuns[sourceId]?.[sessionId] },
    setNotifiedRun(sourceId, sessionId, runId) {
      const sourceTable = notifiedRuns[sourceId] ?? {}
      if (sourceTable[sessionId] !== runId) {
        notifiedRuns = { ...notifiedRuns, [sourceId]: { ...sourceTable, [sessionId]: runId } }
      }
      clearRuntimeSettled(sourceId, sessionId)
    },
    runtimeSettled(sourceId) { return runtimeSettled[sourceId] ?? EMPTY_SETTLED },
    markRuntimeSettled(sourceId, sessionId, hostObservedAt) {
      const sessions = runtimeSettled[sourceId] ?? EMPTY_SETTLED
      const next = new Map(sessions)
      next.set(sessionId, hostObservedAt)
      runtimeSettled = { ...runtimeSettled, [sourceId]: next }
    },
    pendingTable() { return state.pending },
    pendingEntry(sourceId, sessionId) { return state.pending[sourceId]?.[sessionId] },
    setPending(sourceId, sessionId, entry) {
      const table = state.pending[sourceId] ?? {}
      state.pending = { ...state.pending, [sourceId]: { ...table, [sessionId]: { ...entry } } }
    },
    clearPending(sourceId, sessionId) { clearPending(sourceId, sessionId) },
    outcomesTable() { return state.outcomes },
    outcomeWatermark(sourceId, goalId) { return state.outcomes[sourceId]?.[goalId] },
    setOutcome(sourceId, goalId, watermark) {
      if (!isWatermark(watermark)) return
      const table = state.outcomes[sourceId] ?? {}
      const current = table[goalId]
      if (current !== undefined && current >= watermark) return
      state.outcomes = { ...state.outcomes, [sourceId]: { ...table, [goalId]: watermark } }
    },
    armed(sourceId) { return state.armed[sourceId] ?? EMPTY_ARMED },
    setArmed(sourceId, sessions) {
      // 水位界与 armed 同拍：不在集合里的会话不得留下界（否则迟到候选会被旧界以
      // 「已消费」错误吞并；F5 阻断项 2 的边界清理）。旧入口不写界——无消费水位可记。
      const floors = state.armedFloor[sourceId]
      if (floors !== undefined) {
        let nextFloors: Record<string, number> | null = null
        for (const sessionId of Object.keys(floors)) {
          if (sessions.has(sessionId)) continue
          if (nextFloors === null) nextFloors = { ...floors }
          delete nextFloors[sessionId]
        }
        if (nextFloors !== null) {
          if (Object.keys(nextFloors).length === 0) {
            const sources = { ...state.armedFloor }
            delete sources[sourceId]
            state.armedFloor = sources
          } else {
            state.armedFloor = { ...state.armedFloor, [sourceId]: nextFloors }
          }
        }
      }
      if (sessions.size === 0) {
        if (state.armed[sourceId] === undefined) return
        const next = { ...state.armed }
        delete next[sourceId]
        state.armed = next
        return
      }
      state.armed = { ...state.armed, [sourceId]: new Set(sessions) }
    },
    forgetArmed(sourceId) { withdrawSource(sourceId) },
    withdraw(sourceId) { withdrawSource(sourceId) },
    forgetPending(sourceId) {
      if (state.pending[sourceId] === undefined) return
      const next = { ...state.pending }
      delete next[sourceId]
      state.pending = next
    },
    forgetSession(sourceId, sessionId) { forgetSessionScope(sourceId, sessionId) },
    seedSettleFence(sourceId, sessionId, seededWatermark) {
      if (!isWatermark(seededWatermark)) return
      seedFenceSession(sourceId, sessionId, seededWatermark)
    },
    forget(sourceId) {
      if (state.notified[sourceId] !== undefined) {
        const next = { ...state.notified }
        delete next[sourceId]
        state.notified = next
      }
      if (state.outcomes[sourceId] !== undefined) {
        const next = { ...state.outcomes }
        delete next[sourceId]
        state.outcomes = next
      }
      if (state.pending[sourceId] !== undefined) {
        const next = { ...state.pending }
        delete next[sourceId]
        state.pending = next
      }
      if (state.armed[sourceId] !== undefined) {
        const next = { ...state.armed }
        delete next[sourceId]
        state.armed = next
      }
      if (state.settleFence[sourceId] !== undefined) {
        const next = { ...state.settleFence }
        delete next[sourceId]
        state.settleFence = next
      }
      if (state.armedFloor[sourceId] !== undefined) {
        const next = { ...state.armedFloor }
        delete next[sourceId]
        state.armedFloor = next
      }
      if (state.generation[sourceId] !== undefined) {
        const next = { ...state.generation }
        delete next[sourceId]
        state.generation = next
      }
      if (state.goalKnown[sourceId] !== undefined) {
        const next = { ...state.goalKnown }
        delete next[sourceId]
        state.goalKnown = next
      }
      if (notifiedRuns[sourceId] !== undefined) {
        const next = { ...notifiedRuns }
        delete next[sourceId]
        notifiedRuns = next
      }
      if (runtimeSettled[sourceId] !== undefined) {
        const next = { ...runtimeSettled }
        delete next[sourceId]
        runtimeSettled = next
      }
    },
    prune(liveIds) {
      let changed = false
      /** 写时复制：无变化返回原表（旧快照冻结），有变化返回新表。 */
      const drop = <T>(map: Record<string, T>): Record<string, T> => {
        let next: Record<string, T> | null = null
        for (const sourceId of Object.keys(map)) {
          if (liveIds.has(sourceId)) continue
          if (next === null) next = { ...map }
          delete next[sourceId]
          changed = true
        }
        return next ?? map
      }
      state.notified = drop(state.notified)
      state.outcomes = drop(state.outcomes)
      state.pending = drop(state.pending)
      state.armed = drop(state.armed)
      state.armedFloor = drop(state.armedFloor)
      state.settleFence = drop(state.settleFence)
      state.generation = drop(state.generation)
      state.goalKnown = drop(state.goalKnown)
      // 身份键空间不在 state 里：notifiedRuns 走同一 drop；runtimeSettled 是 Map 表，显式删。
      notifiedRuns = drop(notifiedRuns)
      let nextRuntime: Record<string, Map<string, number | undefined>> | null = null
      for (const sourceId of Object.keys(runtimeSettled)) {
        if (liveIds.has(sourceId)) continue
        if (nextRuntime === null) nextRuntime = { ...runtimeSettled }
        delete nextRuntime[sourceId]
        changed = true
      }
      if (nextRuntime !== null) runtimeSettled = nextRuntime
      return changed
    },
  }
}
