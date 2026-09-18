/**
 * 会话运行位活性守卫（2026-12；Swift 原生版 ui-chat「深度求索中」卡死根因修复）。
 *
 * ## 缺陷（已定位，两 flavor 共享）
 *
 * ui-chat 的运行指示器由官方 session 的 running 位驱动
 * （`dsh-client-ui-chat`: `const running = useSession(s => s.running)` →
 * `running && <TurnStatus>` → `chat.deepDiving`），而该位只由 mux 的
 * `$events` 流上一条 **emit 型转发事件** `api-session/status` 递送
 * （`dsh-api-session-controller`: `handleSessionStatus` → `handleRunning`）。
 * emit 无重传，`$events` 的开场帧也只有 host 事实、不重放会话状态 ⇒ 丢一帧、
 * 或 carrier 静默半死（无 close/error）时，running 位永久停在 true。客户端
 * 没有任何超时，官方唯一的收敛路径 `handleConnected() → refreshList()`
 * 只挂在**连接代际重置**上，而连接代际只在 close/error 或 sleep/wake 类
 * 事件才会重启。宿主侧无责：agent loop 在 `finally` 必写 `turn/end`。
 *
 * ## 本模块的位置
 *
 * 守卫的**纯决策半**（App 侧持有 refs、producer 侧执行动作）。三级阶梯：
 *
 * - **L1 只读**：请挂载 ctx 重跑官方 `session.list`（`ctx.sessions.refresh()`
 *   是 single-flight 的读操作，其内部 `refreshList()` 会把权威 summary 的
 *   running 回灌到每个已物化会话 ⇒ 卡死的位自然掉落）。
 * - **L2 有界**：仅当 L1 的**回执**证明对账通道已坏（refresh 失败，或请求后
 *   `refreshOutcomeTimeoutMs` 内没有回执）时，才升级
 *   `reconnectInstanceConnection`（复用既有 S2 watchdog 的纪律与记账）。
 * - **L3 可见**：L2 用尽且仍无「健康回执」时，交给 App 渲染非模态提示
 *   （绝不自动重载；与 mobile `session-stall.ts` 同纪律：用户选择才动作）。
 *
 * ## 为什么不能只按「静默时长」升级（本模块的核心取舍）
 *
 * 长工具执行与长推理的合法静默（本仓实测 `ttftMs=75s`，长工具可数分钟）与
 * 真卡死在 App 层不可区分；每次 reconnect 都要重放全部打开会话的 baseline，
 * 误升级会引入比原缺陷更糟的 reconnect 风暴。因此升级的唯一依据是
 * **「权威对账拿不到结论」**，而不是「沉默很久」。L1 是读操作、幂等、单飞，
 * 所以可以在长时间 running 上廉价重复（`refreshCoalesceMs` 限频、
 * `maxRefreshRequests` 封顶）。
 *
 * ## 契约
 *
 * 纯函数、无 React、无计时器、无全局状态：App 每 tick（既有 30s staleness
 * watchdog，隐藏期本就跳过）调用一次 `planSessionLiveness`，把返回的
 * `actions` 派发给既有 seam（`chamberBridge.requestSessionListRefresh` /
 * `reconnectInstanceConnection`），并把 `state` 写回 ref。来源离开 ready
 * 或会话不再 running 时记录自动清除（`stalled` 随之收敛）。
 */

/** 每会话事实（App 已持有的 `runtimeFacts[sourceId].sessions` 行）。 */
export interface SessionLivenessSessionFacts {
  running?: boolean
}

/**
 * producer 侧最近一次 L1 对账的回执（`InstanceRuntimeReport.sessionFactReconcile`）。
 * `settledAt` 缺省 = 请求在途；`ok=false` = 重试用尽仍未拿到权威结论。
 */
export interface SessionFactReconcileFacts {
  /**
   * 最近一次请求的发起时刻（**producer 时钟**；在途期间的重复请求会推进它）。
   * 守卫**不**用它做判定——App 与 producer 是两个时间戳来源，跨时钟比较会制造
   * 「新鲜回执被判过期 ⇒ 假升级」；判定只用 `settledAt` 水位（且 producer 侧
   * 保证 `settledAt` 单调推进，同毫秒的两次结算不会互相覆盖）。它只服务诊断/测试。
   */
  readonly requestedAt: number
  /** 结算时刻；缺省 = 在途/尚未结算。 */
  readonly settledAt?: number
  /** 结算是否成功（拿不到权威结论 = false）。 */
  readonly ok: boolean
  /**
   * 权威判定（三值；缺省 = 旧 producer 或未结算）。
   * `unknown` = 辅助探针自己失败（与被守卫的 WS 事实通道无关的载体抖动）：
   * **既不升级也不清等待**——守卫保留「等回执」计时，持续拿不到权威结论仍会在
   * 超期后升级；同时把升级期限挂起（见 {@link SessionLivenessRecord.unknownAbsorbedAt}），
   * 直到"吸收之后再发过一次 L1"才重新起算，使单次探针抖动不会在 coalesce 允许
   * 下一次 L1 之前就制造假 reconnect（2026-12 二轮复核 + 独立复核的时间线仿真）。
   */
  readonly verdict?: 'converged' | 'stale' | 'unknown'
  /** 本轮链内尝试次数（诊断用）。 */
  readonly attempts: number
}

/** 一个来源的输入面。 */
export interface SessionLivenessSourceInput {
  /** 该来源已列出的会话（事实通道原样投影；undefined = 通道缺席）。 */
  readonly sessions: Record<string, SessionLivenessSessionFacts> | undefined
  /** 来源代际指纹（registry 的 sourceFingerprint）；变化即重起算（代际围栏纪律）。 */
  readonly generation?: string
  /** 最近一次对账回执；缺席 = 从未请求过。 */
  readonly reconcile?: SessionFactReconcileFacts
  /**
   * App 侧共享重连账本的事实：该来源此刻**不可执行** L2（同一 tick 里另一条臂
   * 刚重连过，或落在 60s 退避窗内）。守卫据此**不派遣**，而不是派遣后被 App 丢弃
   * ——被丢弃的派遣已经在守卫里记账（`lastReconnectDispatchAt` 置位、等待计时清零），
   * 会让这条臂静默整个退避窗且 L1 一并停摆，同时 no-op 账不增长（2026-12 独立
   * 复核抓出的记账缺口）。账本事实由 App 提供（它拥有 S2/fallback 两条臂的写入）。
   *
   * 边界（二轮复核记录为已知形态）：另一条臂**每 ≤60s 都在重连**时，这条臂始终不允许
   * 派遣，L3 的 no-op 出口也不会增长——此时"自愈动作"由那条臂持续执行，本臂只保留 L1
   * 只读对账。不把它计成假 L3：用户看到的应该是那条臂的失败面，而不是一条"我重连过但
   * 没用"的重复横幅。
   */
  readonly reconnectBlocked?: boolean
}

/** 一次 tick 的输入。 */
export interface SessionLivenessInput {
  readonly now: number
  /** 只传 ready 来源：未传的来源记录即被清除（断连/退役语义）。 */
  readonly sources: Record<string, SessionLivenessSourceInput | undefined>
}

/** 守卫时序参数（全部有界；单位为毫秒）。 */
export interface SessionLivenessConfig {
  /** running 连续保持多久后才值得做一次只读对账（L1 门槛）。 */
  readonly refreshAfterMs: number
  /** 同一来源两次 L1 之间的最小间隔（限频；官方 refresh 是 disk walk）。 */
  readonly refreshCoalesceMs: number
  /** 滚动窗口 {@link refreshWindowMs} 内最多请求几次 L1（**不是**整个 running 时段的总量：
   *  总量封顶会让长任务的第 4 分钟之后彻底失明——2026-12 独立复核抓出的缺陷）。 */
  readonly maxRefreshRequests: number
  /** L1 配额的滚动窗口（默认 10 分钟）。 */
  readonly refreshWindowMs: number
  /** 请求 L1 后多久没有回执就判定对账通道已坏（升级 L2）。 */
  readonly refreshOutcomeTimeoutMs: number
  /** 两次 L2 之间的最小间隔。 */
  readonly reconnectBackoffMs: number
  /** 一次 running 期间最多几次 L2。 */
  readonly maxReconnects: number
  /**
   * 连续 no-op 派遣达到该次数后允许 L3（默认 3；配合 reconnectBackoffMs 约 15 分钟）。
   * L2 杠杆长期不可用（shell/ctx/connection 缺失）时，只看 reconnectCount 永远不满足
   * L3 门 ⇒ 用户永远看不到提示（2026-12 三轮复核指出的死路）。
   */
  readonly maxNoopReconnects: number
  /** L2 用尽后多久仍无健康回执才亮 L3 提示。 */
  readonly noticeAfterMs: number
}

/**
 * 默认时序。取值依据（2026-12 实测）：活跃 turn 期间宿主 durable 进展
 * 5–21s/次（median 11s，161s 13 次），而合法静默可达 75s（TTFT）到数分钟
 * （长工具）——所以 L1 门槛取 120s（比实测最大间隔高约 6 倍，且动作只是读）；
 * L1 等回执 150s 覆盖对账链最坏时延（2 次尝试 × (refresh 20s + verify 35s) +
 * 退避 1.5s ≈ 111.5s；相位预算拆开后不能再取 90s，否则慢宿主会被误判）；L2 退避
 * 300s 是「重连是重动作」的量级（同类的 S2 臂用 60s，但那条臂每 ~2min 就会自己重连，
 * 不需要同值）；L3 在 L2 后 120s。
 */
export const SESSION_LIVENESS_DEFAULTS: SessionLivenessConfig = {
  refreshAfterMs: 120_000,
  // 生产 tick 30s（AGGREGATE_FALLBACK_POLL_MS）+ 门槛 120s ⇒ L1 落在 120/330/540s…
  // （**均匀**铺开）。若用 60s（= 窗口/配额），
  // 探测会在 120/180/240s 爆发用完窗口，之后 8 分钟零探测（2026-12 二轮复核的
  // 成本/时延分析）；coalesce = refreshWindowMs / maxRefreshRequests 时平均成本
  // 完全相同却把最坏未探测时长从 8 分钟压到 200s。
  refreshCoalesceMs: 200_000,
  maxRefreshRequests: 3,
  refreshWindowMs: 600_000,
  // 必须 > 对账链最坏回执时延（2 次尝试 × (refresh 20s + verify 35s) + 退避 1.5s
  // ≈ 111.5s，见 sidebar/src/shared/session-fact-reconcile.ts 的默认值）：相位预算
  // 拆开之后，90s 会在「一切正常但宿主很慢」时误判成「拿不到结论」⇒ 假 L2
  // （2026-12 三轮自审发现的跨模块不变量，由 wiring 测试锁住）。
  // 本值 150s < coalesce 200s：单次「探针无结论」（unknown）由 unknownAbsorbedAt
  // 挂起期限，直到下一次 L1 发出，否则它必然抢在下一次 L1 之前到点（2026-12 独立复核实测）。
  refreshOutcomeTimeoutMs: 150_000,
  reconnectBackoffMs: 300_000,
  maxReconnects: 1,
  maxNoopReconnects: 3,
  noticeAfterMs: 120_000,
}

/** 一个来源的守卫记录。 */
export interface SessionLivenessRecord {
  /**
   * 来源代际（registry 的 sourceFingerprint）：变化即整条记录重起算——同一 id
   * 被退役再挂载（新 producer 代际）绝不继承旧代际的配额/提示（代际围栏纪律）。
   */
  generation: string
  /**
   * 运行会话 id → **首次被观测到 running 的时刻**（每会话计时，2026-12 复核后
   * 的第二版身份模型）。原版按「running 集合字符串」重起算，看似能挡「A 结束、
   * B 开始继承旧状态」，但同一来源下出现**短会话反复开始/结束**时会把一个真正
   * 卡住的长会话的时段反复重置 ⇒ 长会话永不进入对账（保护被旁路）。现在：
   * 只有「当前集合与上一 tick **不相交**」（真换代）或代际变化才重置计数器；
   * 有会话存活就保留它的计时。
   */
  runningSince: Record<string, number>
  /** 本连续 running 时段的起点 = 当前存活会话里最早的 runningSince。 */
  since: number
  /** 滚动窗口内的 L1 请求时刻（有界裁剪，见 refreshWindowMs）。 */
  refreshHistory: number[]
  /**
   * 上一次**派遣** L2 的时刻（只作节流；真正执行与否在 App 侧记账）。
   *
   * 默认 `maxReconnects = 1` 下真实重连会把预算用满，于是本字段唯一生效的场景是
   * 「每次派遣都是 no-op」（shell/ctx/connection 缺失）——那时它防止**每个 tick**
   * 都重连一次并饿死 L1（2026-12 三轮复核实测：退避=0 时 116 次重连/小时、L1 只剩
   * 1 次）。**不要把它当冗余状态删掉**。
   */
  lastReconnectDispatchAt?: number
  /** 最近一次 L1 请求时刻。 */
  lastRefreshRequestedAt?: number
  /**
   * 「仍在等回执」的起始时刻（升级依据）。**刻意不被 coalesce 重复请求刷新**：
   * 若每次请求都重置它，只要 coalesce < 等回执期限（生产值 200s < 150s 不成立时
   * 才需要担心；此处的原始缺陷发生在早期 60s/90s 组合下），
   * 对账通道静默时这个计时器永不到期 ⇒ L2 永不触发（本守卫最初的实现缺陷，
   * 由 lifecycle 测试抓出）。**唯一例外**是 {@link SessionLivenessRecord.unknownAbsorbedAt}
   * 挂起后的「之后新发 L1」重新起算——只发生一次。
   */
  awaitingOutcomeSince?: number
  /**
   * 第一次 `unknown` 被吸收的时刻（一次性，绝不累积）。
   *
   * 生产常量下 `refreshOutcomeTimeoutMs`(150s) < `refreshCoalesceMs`(200s)：探针一次
   * 无结论（502/代理重启/慢 session.list）若还让原期限生效，期限会比下一次 L1 先到点，
   * 把「探针无法裁决」误判成「对账通道已坏」⇒ 一次假 L2 并吃掉该 running 时段唯一的
   * 重连预算（2026-12 独立复核的时间线仿真）。因此门控是：**吸收过 unknown 之后，必须
   * 再发过一次 L1（`lastRefreshRequestedAt > unknownAbsorbedAt`）才允许按期限升级**
   * ——快 unknown（L1 后 1s 就结算）与慢 unknown 同判，绝不抢在下一次 L1 前面；单靠
   * "从 unknown 时刻顺延"对快 unknown 无效（期限仍在下一次 L1 之前到点，二轮复核）。
   * 顺延只做一次：之后仍长期无权威结论，由「unknown 之后那次 L1 + 期限」收口（有界：
   * ≤ coalesce + 期限，配额耗尽时由滚动窗口的下一个 L1 兜底）。拿到非 unknown 结论或
   * 真实 L2 之后清零。
   */
  unknownAbsorbedAt?: number
  /** 已消费的对账回执结算时刻（回执只被消费一次）。 */
  outcomeSeenAt?: number
  /** 已消费回执的成功与否。 */
  lastOutcomeOk?: boolean
  /**
   * 最近一次**非 unknown** 结算的时刻（失败证据的时钟）。
   *
   * 绝不能拿 {@link outcomeSeenAt} 代替：那个水位被**每一次**结算推进（含 unknown），
   * 于是「重连前留下 ok:false + 重连后一次 unknown」会让失败证据看起来发生在重连之后
   * ⇒ 重连 + noticeAfterMs 亮一条假 L3 横幅，而那次 unknown 恰恰**没有**给出任何结论
   * （2026-12 三轮独立复核的时间线仿真：L1@120 → stale@180 → L2@180 → L1@210 →
   * unknown@240 → 假 notice@330）。契约见 design 14 §D4「最近一次**非 unknown** 结算」。
   */
  lastVerdictAt?: number

  /** 本时段内**真正执行过**的 L2 次数（no-op 不计：由 markSessionLivenessReconnect 记账）。 */
  reconnectCount: number
  /**
   * 本时段内**派遣了但没执行**（`reconnectInstanceConnection` 返回 false）的 L2 次数。
   * 它是 L3 的第二条出口：杠杆长期不可用时也要让用户看到提示，而不是永远静默
   * （2026-12 三轮复核的完整性缺口）。
   */
  noopReconnects: number
  /**
   * 本时段内**因 App 共享账本被挡下**（本来该派遣 L2，但另一条臂已在同一退避窗内
   * 重连）且同时带未收敛证据的 tick 数。它是 L3 的第三条出口：否则另一条臂静默地
   * 每 60s 重连一次就能把这条臂的 L3 出口永久封死——用户既看不到横幅、也没有可用
   * 的自愈动作（2026-12 三轮独立复核的 MEDIUM 缺口；那条臂自己没有用户可见面）。
   */
  blockedReconnects: number
  /** 最近一次 L2 执行时刻。 */
  lastReconnectAt?: number
  /**
   * **升级梯子到顶的时刻**（真实预算用尽，或连续 no-op 达到门槛），只记一次。
   *
   * L3 的宽限锚点必须是它而不是"最近一次派遣"：no-op 路径会按 backoff 反复派遣，
   * 若用最近派遣时刻当锚，锚点每 300s 向前滑动 ⇒ 宽限永远重新起算、横幅永远不亮
   * （2026-12 三轮复核的 no-op 死路在修复过程中的第二次形态）。
   */
  ladderAnchorAt?: number
  /** L3 提示是否已亮（同一时段只亮一次）。 */
  noticed: boolean
}

/** 守卫状态（App 以一个 ref 持有）。 */
export interface SessionLivenessState {
  readonly records: Record<string, SessionLivenessRecord>
}

/** 一次 tick 要派发的动作（每个来源每种动作至多一条）。 */
export type SessionLivenessAction =
  | { readonly kind: 'refresh'; readonly sourceId: string }
  | { readonly kind: 'reconnect'; readonly sourceId: string }
  | { readonly kind: 'notice'; readonly sourceId: string }

/** 一次 tick 的结果。 */
export interface SessionLivenessPlan {
  /** 新状态（不可变替换；无变化时返回同引用以便 React/ref 去重）。 */
  readonly state: SessionLivenessState
  /** 本轮要执行的动作。 */
  readonly actions: readonly SessionLivenessAction[]
  /** 需要 App 呈现 L3 提示的来源（升序，按传入顺序）。 */
  readonly stalled: readonly string[]
}

/** 空状态。 */
export function createSessionLivenessState(): SessionLivenessState {
  return { records: {} }
}

/**
 * 规划一次 tick。
 * @param state - 上一轮状态（`createSessionLivenessState()` 起步）。
 * @param input - 本 tick 的 `now` 与 ready 来源事实。
 * @param config - 时序参数（默认 {@link SESSION_LIVENESS_DEFAULTS}）。
 * @returns 新状态 + 动作 + 停滞来源。
 */
export function planSessionLiveness(
  state: SessionLivenessState,
  input: SessionLivenessInput,
  config: SessionLivenessConfig = SESSION_LIVENESS_DEFAULTS,
): SessionLivenessPlan {
  const { now } = input
  const records: Record<string, SessionLivenessRecord> = {}
  const actions: SessionLivenessAction[] = []
  const stalled: string[] = []

  for (const [sourceId, source] of Object.entries(input.sources)) {
    if (source === undefined) continue
    const sessions = source.sessions ?? {}
    const runningIds = Object.entries(sessions)
      .filter(([, facts]) => facts?.running === true)
      .map(([id]) => id)
      .sort()
    if (runningIds.length === 0) continue

    const generation = source.generation ?? ''
    const previous = state.records[sourceId]
    const previousRunningSince = previous?.runningSince ?? {}
    // 有任何一个本 tick 运行的会话在上一 tick 也在运行 ⇒ 时段延续（保留配额与
    // 提示）；否则（首次/整组换代/代际变化）按新时段重起算。
    const overlaps = previous !== undefined
      && runningIds.some(id => previousRunningSince[id] !== undefined)
    const generationChanged = previous === undefined || previous.generation !== generation
    const isNewSpell = generationChanged || !overlaps
    // 代际变化（同 id 被退役再挂载 = 新 producer）时**不继承任何年龄**：整条记录
    // 重起算（否则新代际的第一个 tick 会带着旧代际的 since 立刻发 L1，与「代际围栏」
    // 的措辞不符——2026-12 三轮复核）。同代际内只有「整组换代（不相交）」重起算，
    // 部分重叠时存活会话保留自己的计时。
    // 残余（2026-12 独立复核，已裁决**保留**）：一个卡住的会话若在某一 tick 里从
    // 事实通道消失、下一 tick 又出现，它会重新 seed（检测最多推迟一个 refreshAfterMs）。
    // 不保留"墓碑"是为了不把"退役后再以同 id 挂载/新会话复用同 id"的形态继承旧时钟
    // ——那会把上一会话的年龄算到新会话头上（假升级方向），两害相权取假阴性。
    const runningSince: Record<string, number> = {}
    for (const id of runningIds) {
      runningSince[id] = generationChanged ? now : previousRunningSince[id] ?? now
    }
    const since = Math.min(...runningIds.map(id => runningSince[id] as number))
    const record: SessionLivenessRecord = isNewSpell
      ? {
          generation,
          runningSince,
          since,
          refreshHistory: [],
          reconnectCount: 0,
          noopReconnects: 0,
          blockedReconnects: 0,
          noticed: false,
          // 旧时段的回执水位：只消费「本时段开始之后结算」的回执，否则上一
          // 时段的失败裁决会让新时段第一个 tick 就无依据地升级（2026-12
          // 复核抓出的假升级风暴路径）。
          ...(source.reconcile?.settledAt === undefined
            ? {}
            : { outcomeSeenAt: source.reconcile.settledAt }),
        }
      : { ...previous, generation, runningSince, since }

    // 消费一次对账回执：只认「比上次消费过的更新」的结算。刻意**不**与
    // `lastRefreshRequestedAt` 比较——那是 App 的时钟，而 `requestedAt` 是
    // producer 的时钟（同机同源但仍是两个时间戳），跨时钟比较会产生「新鲜
    // 回执被判过期 ⇒ 假升级」的整类缺陷。
    const reconcile = source.reconcile
    if (reconcile !== undefined
      && reconcile.settledAt !== undefined
      && (record.outcomeSeenAt === undefined || reconcile.settledAt > record.outcomeSeenAt)) {
      record.outcomeSeenAt = reconcile.settledAt
      if (reconcile.verdict === 'unknown') {
        // 无结论：只推进水位，并记下**第一次**被吸收的时刻（第二次起不再吸收）。
        // 刻意不动 awaitingOutcomeSince——期限是否生效由 unknownAbsorbedAt 的门控决定
        // （必须等到"吸收之后又发过一次 L1"）。
        record.unknownAbsorbedAt ??= now
      } else {
        record.lastOutcomeOk = reconcile.ok
        // 失败证据的时钟只在**有结论**的结算上推进（unknown 不算结论）。
        record.lastVerdictAt = reconcile.settledAt
        record.awaitingOutcomeSince = undefined
        // 等待周期结束：下一次 unknown 可以重新吸收一次。
        record.unknownAbsorbedAt = undefined
        // 拿到健康结论 ⇒ 通道已恢复，撤下 L3 提示（否则一次恢复会把横幅永久
        // latch 到 running 结束，之后真断链也不再提示——2026-12 复核修复）。
        // 刻意**不**重置 ladderAnchorAt：梯子已到顶（自愈预算用尽）之后再次出现未收敛
        // 证据就该立刻提示，不该再等一个 noticeAfterMs 宽限——否则用户在一个已耗尽自愈
        // 的链路上看不到第二次故障。宽限只在梯子到顶的那一刻给一次（2026-12 独立复核
        // 记为有意裁决，lifecycle 测试钉住）。
        if (reconcile.ok === true && record.noticed) record.noticed = false
      }
    }

    const age = now - record.since
    // L2 先判：仅当对账通道已坏（失败回执，或等回执超过期限）才升级。升级的
    // 那一 tick 不再发 L1（重连会自己重放 baseline，再读一次没有意义）。
    // 计数**不在这里**自增：App 拿到 reconnectInstanceConnection 的真实返回值
    // 后才经 markSessionLivenessReconnect 记账（no-op 不得消耗唯一预算）。
    // 被吸收的 unknown 之后**还没发过 L1** ⇒ 期限一律不生效：这是快 unknown（L1 后
    // 一个 tick 内结算）也会假 L2 的根因（二轮独立复核的时间线仿真）；慢 unknown 由
    // 这条一并覆盖，且不会无限推迟——下一次 L1 一到就重新起算期限。
    // 边界（三轮复核记录，保守方向）：与吸收**同一 tick** 发出的 L1 算「之前」
    // （两个时间戳相等），期限再多等一个 coalesce 窗口才生效——最多多等 200s，
    // 换掉"同毫秒顺序歧义 ⇒ 可能重开假 L2"这类风险；生产常量下要求一次 >150s 的
    // 结算才可能走到，且仍在 coalesce 上界之内。
    const unknownAwaitingNextL1 = record.unknownAbsorbedAt !== undefined
      && (record.lastRefreshRequestedAt === undefined
        || record.lastRefreshRequestedAt <= record.unknownAbsorbedAt)
    const outcomeMissing = record.awaitingOutcomeSince !== undefined
      && now - record.awaitingOutcomeSince > config.refreshOutcomeTimeoutMs
      && !unknownAwaitingNextL1
    // 「失败证据」必须是**本时段内、最近一次真实重连之后**的结论：重连前的 sticky
    // 失败若继续记账，会在重连后 +noticeAfterMs 先亮一条 30s 的假横幅（慢而最终
    // 健康的回执随后才到并撤下；2026-12 三轮复核的 flash 复现）。静默链仍由
    // outcomeMissing 收口，真卡死路径不受影响。
    const outcomeFailed = record.lastOutcomeOk === false
      && (record.lastVerdictAt ?? 0) > (record.lastReconnectAt ?? 0)
    // App 侧共享账本挡住派遣时**不派遣**：派遣会在守卫里记账（lastReconnectDispatchAt
    // 置位、等待计时清零），被 App 丢弃后这条臂会静默一整个退避窗、连 L1 也一并停摆，
    // 且 no-op 账不增长（2026-12 独立复核的记账缺口）。不派遣则本 tick 走 L1 路径，
    // 退避窗一过即可升级。
    // 账本挡下的派遣也记账（第三条 L3 出口，见 blockedReconnects）：只统计"本来
    // 就该派遣"的情形——仍有预算、且带着未收敛证据。
    if (source.reconnectBlocked === true
      && (outcomeFailed || outcomeMissing)
      && record.reconnectCount < config.maxReconnects) {
      record.blockedReconnects += 1
    }
    const reconnectDue = source.reconnectBlocked !== true
      && (outcomeFailed || outcomeMissing)
      && record.reconnectCount < config.maxReconnects
      && (record.lastReconnectDispatchAt === undefined
        || now - record.lastReconnectDispatchAt >= config.reconnectBackoffMs)
    if (reconnectDue) {
      record.lastReconnectDispatchAt = now
      // 回到「请求前」状态：清在途回执与 coalesce 锚（重连本身会重放官方基线，
      // 不需要马上再发 L1）。**刻意不清 refreshHistory**：清了会让一次 L2 之后
      // 600s 窗口内的 L1 达到 4 次、突破 maxRefreshRequests=3（2026-12 三轮复核
      // 的仿真），而这份配额的意义正是「连重连都不能变成探测风暴」。
      record.lastRefreshRequestedAt = undefined
      record.awaitingOutcomeSince = undefined
      record.unknownAbsorbedAt = undefined
      // 刻意**不**清 lastOutcomeOk：它是「最后一次权威结论」，正是重连之后
      // L3 门（要求未收敛证据）与 noticeAfterMs 宽限所依赖的事实；抹掉它会让
      // 守卫在重连后立刻失忆（提示永远不亮或立刻亮），也是 2026-12 二轮复核
      // 抓出的时序缺陷。
      actions.push({ kind: 'reconnect', sourceId })
    } else {
      // L1：只读对账（幂等、单飞、限频、**滚动窗口**配额——总量封顶会让长
      // 任务的第 4 分钟之后彻底失明）。
      const history = record.refreshHistory.filter(at => now - at < config.refreshWindowMs)
      const refreshDue = age >= config.refreshAfterMs
        && history.length < config.maxRefreshRequests
        && (record.lastRefreshRequestedAt === undefined
          || now - record.lastRefreshRequestedAt >= config.refreshCoalesceMs)
      if (refreshDue) {
        record.refreshHistory = [...history, now]
        record.lastRefreshRequestedAt = now
        // 只有「还没有在等的回执」才开新计时器——coalesce 重复请求不得把
        // 升级期限一路推迟。唯一例外：上一次等待被 unknown 顺延过，新请求要开一个
        // 新的完整期限，否则顺延出的窗口会被慢宿主的对账链吃光（顺延本身只做一次，
        // 所以不会累积成"永不升级"）。
        if (record.awaitingOutcomeSince === undefined) record.awaitingOutcomeSince = now
        else if (record.unknownAbsorbedAt !== undefined) record.awaitingOutcomeSince = now
        actions.push({ kind: 'refresh', sourceId })
      } else {
        record.refreshHistory = history
      }
    }

    // L3：L2 已真正执行过、且**当前这一轮等待**（最近一次未结算的请求，或最近
    // 一次重连）之后仍没有健康回执 ⇒ 用户可见提示。用「关注起点」而不是单调
    // 的 lastReconnectAt：否则一次重连后的健康回执会把 L3 永久关掉。
    // L3 门 = **真实失败证据** + 重连之后的一段宽限（2026-12 二轮复核修复）：
    //  - 只用时间锚点（「很久没有健康结论」）会把守卫因滚动窗口配额没发请求的
    //    间隙当成通道静默 ⇒ 健康通道上的长任务会周期性亮/灭假横幅；
    //  - 只要求「有失败证据」又会在重连成功的瞬间就亮横幅（新代际还没被验证）。
    // 因此：必须有未收敛证据（回执 ok:false 或等回执超期），且距最近一次真正
    // 执行的重连已过 noticeAfterMs。
    //  - 还有第二条出口：L2 杠杆**一直不可用**（每次派遣都是 no-op）时
    //    reconnectCount 永远到不了 maxReconnects ⇒ 只要连续 no-op 达到
    //    maxNoopReconnects，同样按「重连之后的一段宽限」亮提示（三轮复核抓出的
    //    死路：用户既看不到横幅、也没有可用的自愈动作）。
    const ladderExhausted = record.reconnectCount >= config.maxReconnects
      || record.noopReconnects >= config.maxNoopReconnects
      || record.blockedReconnects >= config.maxNoopReconnects
    // 只记一次：梯子到顶的那一刻，之后所有派遣（no-op 会反复派遣）都不得把它推后。
    if (ladderExhausted && record.ladderAnchorAt === undefined) record.ladderAnchorAt = now
    const noticeDue = record.ladderAnchorAt !== undefined
      && (outcomeFailed || outcomeMissing)
      && now - record.ladderAnchorAt >= config.noticeAfterMs
      && !record.noticed
    if (noticeDue) {
      record.noticed = true
      actions.push({ kind: 'notice', sourceId })
    }
    if (record.noticed) stalled.push(sourceId)

    records[sourceId] = record
  }

  // 返回**新**状态（不再做「13 字段逐项比较决定是否复用旧引用」）：消费点只有
  // App 的一个 ref，引用身份不触发 React；而手工字段表一旦漏登记就会返回旧
  // state、把本轮全部 mutation 静默丢弃（2026-12 二轮复核：功能丢失 > 省一个
  // 对象分配）。未出现在输入里的来源（断连/退役）与不再 running 的会话在这里
  // 自然被剔除（records 只由本 tick 的输入构建）。
  return { state: { records }, actions, stalled }
}

/**
 * 记账一次**真正执行**的 L2 reconnect（App 侧在
 * `reconnectInstanceConnection` 返回 true 后调用）。
 *
 * 为什么不在 planner 里自增：该杠杆在「壳未 boot / ctx 缺失」时是 no-op 并返回
 * false（`shell.ts` 的 M4 纪律），若在派发时就消耗唯一预算，用户会得到
 * 「一次都没试过」的 L3 提示。
 * @param state - 当前状态。
 * @param sourceId - 执行成功的来源。
 * @param now - 当前时刻。
 * @returns 新状态（无记录时原样返回）。
 */
/**
 * 记账一次 **no-op 派遣**（`reconnectInstanceConnection` 返回 false：壳未 boot /
 * ctx 缺失 / 连接不可用）。与 {@link markSessionLivenessReconnect} 相对：真实执行
 * 走那条（消耗预算），派发了但没执行走这条（不消耗预算，但计入 L3 的第二条出口）。
 * @param state - 当前状态。
 * @param sourceId - 派遣了但未执行的来源。
 * @returns 新状态（无记录时原样返回）。
 */
export function markSessionLivenessReconnectNoop(
  state: SessionLivenessState,
  sourceId: string,
): SessionLivenessState {
  const record = state.records[sourceId]
  if (record === undefined) return state
  return {
    records: {
      ...state.records,
      [sourceId]: { ...record, noopReconnects: record.noopReconnects + 1 },
    },
  }
}

export function markSessionLivenessReconnect(
  state: SessionLivenessState,
  sourceId: string,
  now: number,
): SessionLivenessState {
  const record = state.records[sourceId]
  if (record === undefined) return state
  return {
    records: {
      ...state.records,
      [sourceId]: {
        ...record,
        reconnectCount: record.reconnectCount + 1,
        lastReconnectAt: now,
      },
    },
  }
}
