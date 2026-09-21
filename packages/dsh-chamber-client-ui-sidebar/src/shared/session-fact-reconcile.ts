/**
 * 会话事实对账链（运行位活性守卫的 L1 执行半；2026-12）。
 *
 * ## 为什么需要它
 *
 * 官方 session 的 running 位只由 mux 上 emit 型转发事件 `api-session/status`
 * 递送（无重传），而官方唯一的收敛路径 `handleConnected() → refreshList()`
 * 只挂在连接代际重置上。守卫在 App 侧发现「某会话持续 running」后，需要一条
 * **只读、幂等、单飞**的对账动作：请挂载 ctx 重跑官方 `ctx.sessions.refresh()`
 * ——其内部 `refreshList()` 会把权威 summary 的 running 回灌到每个已物化会话，
 * 卡死的位随之掉落。
 *
 * ## 为什么需要「回执」
 *
 * App 层无法从「事实没变」区分「宿主确实还在跑」与「对账根本没成功」。本链
 * 因此把每次请求的**结算**（成功/失败/尝试次数）投影进运行时事实通道
 * （`InstanceRuntimeReport.sessionFactReconcile`），守卫只在**拿不到权威结论**
 * 时升级到 reconnect —— 这正是「不以静默时长单独升级」的前提。
 *
 * ## 纪律
 *
 * - 单飞：同一时刻只有一条在途链，重复请求只推进 `requestedAt`。在途期间回执
 *   不结算（`settledAt` 缺省），守卫**只消费已结算回执**、且只用 `settledAt` 水位
 *   （不与 App 时钟比较）；`requestedAt` 目前没有判定消费者（诊断/测试用）。
 * - 有界：`maxAttempts` 次尝试、`retryMs` 退避、单次尝试 `attemptTimeoutMs` 硬上限；
 *   方法缺失（`refresh()` 不存在）是永久性失败，WARN 一次且不重试（与既有
 *   `officialSessionRefresh` 同纪律），而**调用点同步抛错**走可重试路径。
 * - fail-closed：任何异常只结算成 `ok:false` 并 WARN，绝不上抛（桥监听器抛错
 *   会中断 App 的推送处理）。
 * - 可测：`schedule/cancel/now` 可注入（仓内 skill/producer 纪律：生产端文件
 *   导入 React/CSS 无法被 node 测试导入，状态机因此抽到 shared/）。
 */

/** 对账链的可注入依赖。 */
export interface SessionFactReconcileDeps {
  /** 官方 session-list 刷新（方法调用形式：detached 调用会静默 no-op）。 */
  readonly refresh: () => Promise<unknown> | undefined
  /**
   * **权威判定**（**语义上必需**：缺席时每次尝试都按 `ok:false` 结算，fail-closed；
   * 类型上可选只为让测试能单独构造「没有校验」的反例。2026-12 review 修复）：官方 `refreshList()` 对「拉取失败」
   * **照常 resolve**（vendor `sessions/manager.ts`：`result.ok===false` 只置
   * `listState='error'` 后正常返回；carrier 失败也被折叠成 `ok:false` 结果而非
   * reject）——因此「promise 解决」**不等于**「拿到权威结论」。本 seam 返回
   * false/undefined 时，本次尝试记失败（守卫据此升级 L2/L3）。生产端接独立的
   * unary 权威探针 + 权威 running 位对表（见 sidebar client/index.ts）。
   *
   * **三值**（2026-12 二轮复核）：`converged`（权威确认，含「宿主确实还在跑」）/
   * `stale`（权威**正面证伪**：官方位说 running 而权威说没在跑）/ `unknown`
   * （辅助探针自己失败——它是**另一条载体**（HTTP 代理），不能证明被守卫的 WS
   * 事实通道坏）。`unknown` 不升级也不抹掉等待（守卫保留「等回执」计时，超期后
   * 仍会按「长期拿不到权威结论」升级），从而既不制造假 reconnect 风暴，也不把
   * 持续拿不到权威结论误判成健康。
   *
   * **沉默不作证，但也绝不是覆盖**（2026-12 五轮复核）：官方 `refreshList()` 的**主流**
   * 失败形态是**照常 resolve** 成 `ok:false`（vendor：只把 `listState` 置 `'error'`），而
   * `ISessions.refresh()` 又把结果抹平成 `Promise<void>` ⇒ reconciliation 侧**观察不到**
   * 「这次 refresh 其实没应用」。因此「权威读没有覆盖某个 running 行」一律按**无结论**
   *（`unknown`）处理，与 refresh 相位的成败无关：真正成功的 refresh 会用
   * `mergeOrderedBaseline` 把缺席 id 从 store 清掉，留下的「未覆盖 running 行」本身就说明
   * 官方对账没落地。旧实现只在 refresh 失败/超时时这么判，于是最主流的形态仍会回执
   * ok:true 并永久关掉升级阶梯（2026-12 五轮复核的 HIGH）。
   */
  readonly verify?: () => Promise<SessionFactVerdict>
  /**
   * **写回 seam**（2026-12 彻底修复，design 14 §D4 tier-3）：当 `verify` 判 `stale`
   * （独立权威读**正面证伪**官方 `running` 位）时，把权威结论写进官方 store 自己的
   * 公开写路径（`ClientSessions.handleSessionStatus(id, false)`），并**自校验**
   * （store 快照里被证伪的会话已不再是 running）。返回 true = 已写入且校验通过 ——
   * 本次尝试按 `converged` 结算（回执带 `corrected: true`），守卫据此判定通道健康、
   * 不升级。
   *
   * 缺席 = 该构建没有可用的写回路径（降级到既有升级阶梯，绝不静默）；抛错或返回
   * false = 写回/自校验失败，仍按 `stale` 结算（允许 L2/L3）。
   *
   * 为什么需要它：官方 `refreshList()` 对「拉取失败」照常 resolve，且 store 快照
   * **不暴露** `state`/`error`（`projectList()` 只投影 ids/byId/current/phase/…），
   * 所以「refresh 成功但 running 未回灌」在契约内没有纠正路径。写回是仓内唯一不依赖
   * 上游修改的确定性修复动作；它**只写 false、从不写 true**，且后续任何成功的官方基线
   * （refresh/重连）都可以覆盖它——host 永远赢，无 TTL、无 latch。
   * 「官方 session.list 单飞悬挂」下 refresh 永不结算：本链的 refresh 相位超时/被拒不
   * 直接结算，而是照常进入权威相位（见 attempt()），所以该形态下写回仍可达；悬挂的
   * **store 级** loading 本身仍只能由重载收口（STATUS ③）。
   */
  readonly correct?: () => Promise<boolean> | boolean
  /** 时钟。 */
  readonly now: () => number
  /** 有界告警（绝不抛）。 */
  readonly warn: (message: string) => void
  /** 结算后回调（生产端用它 `sync()` 重发运行时事实）。 */
  readonly onSettled?: () => void
  /** 退避调度（默认真实 `setTimeout`；测试注入假时钟）。 */
  readonly schedule?: (run: () => void, ms: number) => unknown
  /** 取消调度（与 `schedule` 成对注入）。 */
  readonly cancel?: (handle: unknown) => void
  /** 尝试次数上限（含首次；默认 2）。 */
  readonly maxAttempts?: number
  /** 两次尝试之间的退避（默认 1500ms）。 */
  readonly retryMs?: number
  /**
   * **refresh 相位**的上限（默认 20s）。没有它，一次悬挂的官方 refresh 会把单飞链
   * 永久卡死（后续 request 全部静默 no-op）——与仓内 `purged-convergence` 对同一
   * seam 的纪律一致。
   */
  readonly attemptTimeoutMs?: number
  /**
   * **verify 相位**的上限（默认 65s）。必须覆盖**两次串行**权威 unary 探针（N=2 确认），
   * 每次上限 = `INSTANCE_UNARY_TIMEOUT_MS`（30s，shared/instance-api.ts 导出）⇒ ≥ 60s，
   * 本值留 5s 余量。两个相位共用一个计时器时，慢宿主上「refresh 花了十几秒 + 探针还没
   * 回来」会被预算误判成「拿不到权威结论」⇒ 假 L2 与假横幅（2026-12 二轮复核；四轮复核
   * 把预算改到 N=2 口径）。进入 verify 相位时重新起算。
   */
  readonly verifyTimeoutMs?: number
}

/**
 * 一次对账尝试的权威判定（见 {@link SessionFactReconcileDeps.verify}）。
 * `unknown` 既不等于成功也不等于失败：守卫只推进水位、不动「等回执」计时。
 */
export type SessionFactVerdict = 'converged' | 'stale' | 'unknown'


/** 投影进运行时事实通道的回执快照。 */
export interface SessionFactReconcileSnapshot {
  /** 最近一次请求时刻（在途期间重复请求会推进它）。 */
  readonly requestedAt: number
  /** 结算时刻；缺省 = 在途。 */
  readonly settledAt?: number
  /** 是否拿到了权威结论。 */
  readonly ok: boolean
  /** 本轮尝试次数。 */
  readonly attempts: number
  /** 权威判定（结算时必有；`unknown` = 辅助探针失败，无结论）。 */
  readonly verdict?: SessionFactVerdict
  /**
   * 本轮结束时官方 store 里**已无已确认证伪的 running 位**（`verdict: 'converged'` +
   * `corrected: true`）：写回 seam 写过 store（并通过自校验），或 probe 与写回之间它已
   * 自然收敛（targets 为空）。守卫按普通健康结算消费；本字段只服务诊断与测试。
   */
  readonly corrected?: boolean
}

const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_RETRY_MS = 1_500
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000
const DEFAULT_VERIFY_TIMEOUT_MS = 65_000
/**
 * 写回相位的上限（2026-12 五轮复核）：探针返回后只剩 store 写 + 自校验（毫秒级），
 * 给一个短上限既防「correct 悬挂把单飞链挂死」，又把「结算后写回」窗口从 65s 压到 5s。
 */
const CORRECTIVE_PHASE_TIMEOUT_MS = 5_000

/**
 * 生产默认值（跨模块不变量的一半，design 14 §D4）：对账链最坏回执时延 =
 * `maxAttempts × (attemptTimeoutMs + verifyTimeoutMs) + retryMs` ≈ 171.5s，必须小于
 * 守卫的 `refreshOutcomeTimeoutMs`（190s），否则慢宿主会被误判成「拿不到权威结论」
 * ⇒ 假 L2/假横幅；`verifyTimeoutMs` 还必须覆盖**两次串行**独立 unary 探针（N=2 确认），
 * 每次上限 = `INSTANCE_UNARY_TIMEOUT_MS`（30s，shared/instance-api.ts 导出）⇒ ≥ 60s，
 * 本值 65s 留 5s 余量（2026-12 四轮复核：35s 只能覆盖一次探针，会让「宿主一次
 * session.list 超过 ~17.5s」的形态永远判 unknown ⇒ 写回不可达）。渲染端接线测试
 * `packages/renderer/test/wiring/session-liveness-wiring.test.ts` 直接消费本对象做
 * 推导，两侧禁止各写一份数字。
 */
export const SESSION_FACT_RECONCILE_DEFAULTS = {
  maxAttempts: DEFAULT_MAX_ATTEMPTS,
  retryMs: DEFAULT_RETRY_MS,
  attemptTimeoutMs: DEFAULT_ATTEMPT_TIMEOUT_MS,
  verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
} as const

/**
 * 默认定时器**成对**提供（2026-12 二轮复核抓到 critical）：生产装配不传
 * schedule/cancel，若只给 schedule 而不给配对的 cancel，attempt 超时定时器永远
 * 取消不掉——它在结算之后照常开火，把一次**成功**的结算改写成 ok:false（并可能
 * 再排一轮重试），于是守卫在完全健康的通道上收到假失败回执 ⇒ 假 L2/假横幅。
 */
const defaultSchedule = (run: () => void, ms: number): unknown => setTimeout(run, ms)
const defaultCancel = (handle: unknown): void => {
  clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** 官方 store 里的一行（只取判定需要的两个字段）。 */
export interface OfficialSessionFactRow {
  readonly running?: boolean
  readonly origin?: string
}

/** 权威快照里的一行（chamber 自己的 unary 读；只取判定需要的两个字段）。 */
export interface AuthoritativeSessionFactRow {
  readonly sessionId: string
  readonly running: boolean
}


/**
 * 是否还有「可对账」的 running 行（tier-1.5 本地判定的输入）：只有**非子代理**
 * 行才算。返回 false 时本轮没有对账对象，**不必发任何 host 读**（修复成功后的
 * 常见路径因此只需官方 refresh 的 1 次 host 读）。
 * @param official - 官方 store 的 byId 视图。
 * @returns 是否存在需要权威对账的 running 行。
 */
export function isRunningNonSubagentRow(row: OfficialSessionFactRow | undefined): boolean {
  return row?.running === true && row.origin !== 'subagent'
}

export function hasReconcilableRunning(
  official: Readonly<Record<string, OfficialSessionFactRow | undefined>>,
): boolean {
  return Object.values(official).some(isRunningNonSubagentRow)
}

/**
 * 第一次权威读之后能直接下的结论（纯函数；N=2 的第二读由调用方决定）。
 * - `needs-second-probe`：有正面证伪 ⇒ 必须第二读确认（N=2）才允许写回/升级；
 * - `unknown`：权威读数对该 running 行**沉默**（未覆盖）⇒ 本轮拿不到正面覆盖，不许按
 *   健康结算。**无条件**成立：官方 refresh 的失败可以 resolve 成 `ok:false`（观察不到），
 *   所以不能靠 refresh 的成败来 gate 这一步；否则「官方对账没落地 + 权威缺席行」会被
 *   回执成 ok:true、升级阶梯被永久关掉（2026-12 五轮复核的 HIGH）；
 * - `converged`：无正面证伪，且每个 running 行都被本次读数**覆盖**。
 * @param opts - 第一次独立权威读的结果。
 * @returns 直接结论，或「需要第二读」。
 */
export function decideAfterFirstAuthorityRead(opts: {
  denied: ReadonlySet<string>
  uncovered: ReadonlySet<string>
}): 'needs-second-probe' | 'unknown' | 'converged' {
  if (opts.denied.size > 0) return 'needs-second-probe'
  // **无条件**：官方 refresh 的失败可以 resolve（ok:false，见 verify seam 文档），
  // 所以「本行未被权威覆盖」必须自己作数——不是「没证据就健康」。成功的 refresh 会
  // 清掉缺席行，因此这条只会在官方对账没落地/语料不一致时命中，代价是一次被吸收的
  // unknown（不立即升级，期限由下一次 L1 重新起算）。
  if (opts.uncovered.size > 0) return 'unknown'
  return 'converged'
}

/**
 * 「权威沉默」的 running 行（纯函数）：官方 store 说在跑（非子代理），但本次独立权威
 * 读里**没有这个 id**。沉默不作证，但**不是**正面覆盖：官方 refresh 的失败可以
 * resolve（`ok:false`，见 verify seam 文档），所以「未覆盖」必须自己作数；真正成功的
 * refresh 会用 `mergeOrderedBaseline` 清掉缺席行，命中本函数的只剩「官方对账没落地」
 * 与「语料不一致」两种形态。
 * @param official - 官方 store 的 byId 视图。
 * @param authoritative - 本次独立权威读的会话行。
 * @returns store 里 claiming running 但权威读未覆盖的 id 集。
 */
export function uncoveredRunningIds(
  official: Readonly<Record<string, OfficialSessionFactRow | undefined>>,
  authoritative: readonly AuthoritativeSessionFactRow[],
): Set<string> {
  const covered = new Set(authoritative.map(row => row.sessionId))
  const uncovered = new Set<string>()
  for (const [id, row] of Object.entries(official)) {
    if (isRunningNonSubagentRow(row) && !covered.has(id)) uncovered.add(id)
  }
  return uncovered
}

/**
 * **N=2 确认**（纯函数）：两次独立权威读必须证伪同一个 id 才允许写回或升级。
 * 交集为空 ⇒ 没有结论（调用方按 `unknown` 处理）：一次不完整列表既会造成假写回
 * （把真在跑的会话压成 false），也会造成假升级，两者都比陈旧运行位更糟。
 * @param first - 第一次独立读数。
 * @param second - 第二次独立读数。
 * @returns 两次都证伪的 id 集。
 */
export function confirmDeniedRunningIds(
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
): Set<string> {
  return new Set([...first].filter(id => second.has(id)))
}

/**
 * **写回目标**（纯函数）：只在「本轮已确认证伪」∩「此刻 store 仍 claiming running」
 * 的 id 上写。前者保证有权威依据，后者保证幂等与最小写面（probe 与本调用之间已
 * 自然收敛的 id 不动）。空集 = 已收敛（本轮按成功结算）。
 * @param denied - 已确认的证伪集。
 * @param official - 官方 store 的 byId 视图（写回前的即时读）。
 * @returns 需要写入 `running: false` 的 id 列表。
 */
export function writeBackTargets(
  denied: ReadonlySet<string>,
  official: Readonly<Record<string, OfficialSessionFactRow | undefined>>,
): string[] {
  return [...denied].filter(id => official[id]?.running === true)
}

/**
 * **正面证伪集**（纯函数）：官方 store 说 running、而独立权威快照**显式**说该会话没在跑
 * 的会话 id。
 *
 * 规则与收敛判定完全一致，绝不放松：子代理行不作证（`origin === 'subagent'`）、
 * 权威缺失行不作证（无证词即不作判定）、只有权威明确给出 `running !== true` 才入集。
 * 写回 seam（design 14 §D4 tier-3）消费本集合，因此「判未收敛」与「写哪些 id」永远
 * 共用同一份规则，两处不会漂移。
 * @param official - 官方 store 的 byId 视图。
 * @param authoritative - 独立 unary 探针取到的行。
 * @returns 被正面证伪的会话 id 集合（空集 = 无证伪）。
 */
export function deniedRunningIds(
  official: Readonly<Record<string, OfficialSessionFactRow | undefined>>,
  authoritative: readonly AuthoritativeSessionFactRow[],
): Set<string> {
  const authoritativeById = new Map(authoritative.map(row => [row.sessionId, row]))
  const denied = new Set<string>()
  for (const [sessionId, summary] of Object.entries(official)) {
    if (!isRunningNonSubagentRow(summary)) continue
    const row = authoritativeById.get(sessionId)
    if (row === undefined) continue
    if (row.running !== true) denied.add(sessionId)
  }
  return denied
}

/** 一个来源 ctx 的对账链（单飞 + 有界重试 + 回执）。 */
export class SessionFactReconciler {
  private readonly deps: SessionFactReconcileDeps
  private readonly maxAttempts: number
  private readonly retryMs: number
  private readonly attemptTimeoutMs: number
  private readonly verifyTimeoutMs: number
  private requestedAt: number | undefined
  private settledAt: number | undefined
  private settledOk = false
  private settledVerdict: SessionFactVerdict = 'unknown'
  private settledCorrected = false
  /** 已发布的最近结算时刻（**不随 request() 清空**；见 nextSettledAt）。 */
  private lastSettledAt: number | undefined
  private attempts = 0
  private running = false
  private disposed = false
  private timer: unknown
  /** 单次尝试的超时定时器（dispose 时必须取消，否则悬挂尝试的结算会漏出）。 */
  private attemptTimer: unknown
  /** seam 缺失只告警一次（永久性失败，不重试）。 */
  private warnedMissing = false

  constructor(deps: SessionFactReconcileDeps) {
    this.deps = deps
    this.maxAttempts = Math.max(1, deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
    this.retryMs = Math.max(0, deps.retryMs ?? DEFAULT_RETRY_MS)
    this.attemptTimeoutMs = Math.max(1, deps.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS)
    this.verifyTimeoutMs = Math.max(1, deps.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS)
  }

  /**
   * 请求一次对账。在途时只推进 `requestedAt`（单飞），不叠加第二条链。
   */
  request(): void {
    if (this.disposed) return
    this.requestedAt = this.deps.now()
    if (this.running) return
    this.running = true
    this.settledAt = undefined
    this.attempts = 0
    this.attempt()
  }

  /** 最近一次请求的回执；从未请求过时返回 undefined。 */
  snapshot(): SessionFactReconcileSnapshot | undefined {
    if (this.requestedAt === undefined) return undefined
    return {
      requestedAt: this.requestedAt,
      ...(this.settledAt === undefined ? {} : { settledAt: this.settledAt }),
      ok: this.settledAt === undefined ? false : this.settledOk,
      attempts: this.attempts,
      ...(this.settledAt === undefined ? {} : { verdict: this.settledVerdict }),
      ...(this.settledAt === undefined || !this.settledCorrected ? {} : { corrected: true }),
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // 与 attempt() 用同一对默认定时器原语：生产装配不传 cancel，若这里用
    // `this.deps.cancel?` 就永远取消失败（定时器会一直挂到开火）。
    const cancelTimer = this.deps.cancel ?? defaultCancel
    if (this.timer !== undefined) {
      cancelTimer(this.timer)
      this.timer = undefined
    }
    if (this.attemptTimer !== undefined) {
      cancelTimer(this.attemptTimer)
      this.attemptTimer = undefined
    }
    this.running = false
  }

  private attempt(): void {
    this.attempts += 1
    let pending: Promise<unknown> | undefined
    try {
      pending = this.deps.refresh()
    } catch (error) {
      // 调用点同步抛错：与 rejection 同一条路（先进权威相位——另一条载体不依赖
      // refresh），不再直接结算永久失败（2026-12 五轮复核指出与三入口文档不符）。
      pending = Promise.reject(error)
    }
    if (pending === undefined) {
      // seam 缺失是**永久**失败（不是抖动）：WARN 一次、不重试，直接结算成
      // ok:false —— 守卫据此把该来源判为「拿不到权威结论」并升级 L2。
      if (!this.warnedMissing) {
        this.warnedMissing = true
        this.deps.warn('official session client exposes no refresh() — running-bit reconciliation is unavailable')
      }
      this.finish(false, 'stale')
      return
    }
    // 两个相位各有独立硬上限（2026-12 二轮复核）：refresh 与 verify 走**不同载体**
    // （官方单飞 refresh vs 独立 unary 探针），共用一个计时器会让「refresh 花了十几秒
    // + 慢宿主探针还没回来」被误判成「拿不到权威结论」⇒ 假 L2/假横幅。verify 相位
    // 的预算必须 ≥ 探针自身的 30s AbortSignal 上限。
    // 本 attempt 的**结算栅栏**：超时回调与 promise 结算竞争，谁先到谁结算一次，
    // 后者必须原地返回——没有这道栅栏就会出现「成功后又被超时改写成失败」。
    let attemptSettled = false
    // 声明顺序：finishAttempt 会在定时器回调里跑，phaseTimer/cancelTimer 必须先初始化
    // （即便 schedule 是同步实现也不能踩 TDZ）。
    const schedule = this.deps.schedule ?? defaultSchedule
    const cancelTimer = this.deps.cancel ?? defaultCancel
    let phaseTimer: unknown
    const finishAttempt = (): boolean => {
      if (attemptSettled || this.disposed) return false
      attemptSettled = true
      this.attemptTimer = undefined
      if (phaseTimer !== undefined) cancelTimer(phaseTimer)
      return true
    }
    /**
     * 相位计时器（**两相位语义不同**，2026-12 三轮复核 + 四轮修订）：refresh 相位的
     * 超时/失败**不再直接结算**——权威相位（独立 unary 探针 + tier-3 写回）走的是另
     * 一条载体，**不依赖 refresh**；只有它也给不出结论时才按相位语义结算。verify 相位
     * 超时 = 探针没回来 ⇒ `unknown`（不升级、不清等待），与探针抛错同一条语义。
     */
    const armPhase = (ms: number, phase: 'verify'): void => {
      phaseTimer = schedule(() => {
        if (!finishAttempt()) return
        this.settle(false, new Error(`session-fact reconcile ${phase} phase timed out`), 'unknown')
      }, ms)
      this.attemptTimer = phaseTimer
    }
    const settleWithinAttempt = (verdict: SessionFactVerdict, error: unknown, corrected = false): void => {
      if (!finishAttempt()) return
      if (verdict === 'converged') this.settle(true, undefined, 'converged', corrected)
      else this.settle(false, error, verdict)
    }
    /**
     * 权威相位（独立 unary 探针 + 可能的 tier-3 写回）。**三个入口**：refresh 结算、
     * refresh 被拒、refresh 相位超时——后两者正是「官方 `session.list` 单飞悬挂 / 拉取
     * 失败」形态：官方对账没有结论，但另一条载体仍能给出权威 running 位，写回因此仍可
     * 把事实纠正（2026-12 四轮独立复核：此前该形态下写回不可达，而文档声称可达）。
     * `authorityStarted` 保证单相位只跑一次：晚到的 refresh 结算不得再开第二轮。
     * @param refreshFailure - 从失败入口进入时携带的 refresh 错误（观测用）：权威相位若
     *   仍收敛，说明官方 refresh 已坏而事实由另一条载体裁决——必须留一行有界告警，
     *   否则「静默降级」会掩盖一个持续损坏的官方通道（2026-12 四轮复核）。
     */
    let authorityStarted = false
    const runAuthorityPhase = async (refreshFailure?: unknown): Promise<void> => {
      if (this.disposed || attemptSettled || authorityStarted) return
      authorityStarted = true
      // 「promise 解决」不等于「拿到权威结论」（见 verify seam 文档）。
      if (this.deps.verify === undefined) {
        settleWithinAttempt('stale', new Error('session-fact reconcile has no authority verification seam'))
        return
      }
      // 进入 verify 相位：重开计时（refresh 已经用掉的时间不计入这一相位）。
      cancelTimer(phaseTimer)
      armPhase(this.verifyTimeoutMs, 'verify')
      let verdict: SessionFactVerdict = 'unknown'
      try {
        verdict = (await this.deps.verify()) ?? 'unknown'
      } catch {
        // 辅助探针自己失败 = 与被守卫的 WS 事实通道无关的载体抖动 ⇒ unknown
        // （不升级、不清等待；持续拿不到权威结论仍由守卫的「等回执超期」收口）。
        verdict = 'unknown'
      }
      // 探针已返回：剩下的只有 store 写 + 自校验（毫秒级），给一个**短**上限，
      // 免得「探针返回后 correct 悬挂」把单飞链挂死（原缺陷类）；同时也把
      // 「结算后再写回」的窗口从 65s 压到 5s（2026-12 五轮复核的 F4 残余）。
      cancelTimer(phaseTimer)
      armPhase(CORRECTIVE_PHASE_TIMEOUT_MS, 'verify')
      // dispose 之后，或**相位计时器已经把本 attempt 结算掉之后**，不得再有副作用：
      // 写回会改官方 store，而被遗弃的 verify 仍可能晚到返回 stale（2026-12 五轮复核
      // 用注入时钟复现：verify 相位 65s 超时结算 unknown 后，写回仍被调用）。
      if (this.disposed || attemptSettled) return
      const refreshNote = refreshFailure === undefined
        ? ''
        : ' (official session-list refresh failed: '
          + (refreshFailure instanceof Error ? refreshFailure.message : String(refreshFailure)) + ')'
      /**
       * 观测（有界，每 attempt 至多一次）：refresh 坏了、但权威相位仍给出收敛结论时，
       * 必须留一行告警——否则「官方通道持续损坏」会变成静默降级（2026-12 四轮复核）。
       * 不收敛的路径不在这里 warn：refresh 失败已并入 settle 的错误文本。
       */
      const warnIfRefreshWasBroken = (): void => {
        if (refreshFailure === undefined) return
        this.deps.warn('official session refresh failed — the independent authority phase gave'
          + ` the verdict instead:${refreshNote}`)
      }
      if (verdict === 'converged') {
        warnIfRefreshWasBroken()
        settleWithinAttempt('converged', undefined)
        return
      }
      if (verdict === 'unknown') {
        settleWithinAttempt('unknown', new Error('session-fact reconcile probe is unavailable (no authority this round)' + refreshNote))
        return
      }
      // 权威正面证伪 ⇒ 先尝试**写回**（tier-3）：契约内没有纠正路径时，这一步是
      // 唯一能让侧栏与聊天面一起脱离陈旧 running 位的动作。写回幂等、只写 false，
      // 且必须自校验通过才按 converged 结算（否则仍按 stale 允许升级）。
      if (this.deps.correct !== undefined) {
        let corrected = false
        try {
          corrected = await this.deps.correct()
        } catch (error) {
          corrected = false
          this.deps.warn('authoritative running-bit write-back failed (attempt '
            + `${String(this.attempts)}/${String(this.maxAttempts)}): `
            + (error instanceof Error ? error.message : String(error)))
        }
        // 写回也可能被 dispose 打断：回执由 finishAttempt 的 disposed 栅栏挡住，
        // 这里保证不再有后续动作。
        if (this.disposed) return
        if (corrected) {
          warnIfRefreshWasBroken()
          settleWithinAttempt('converged', undefined, true)
          return
        }
      }
      settleWithinAttempt('stale', new Error('session-fact reconcile did not converge to an authoritative baseline' + refreshNote))
    }
    // refresh **结算或被拒**都进同一个权威相位（另一条载体不依赖它）。入口不 warn（成功不吵），
    // 失败信息随相位携带：收敛时留一行有界告警，不收敛时并入 settle 的错误文本。
    void Promise.resolve(pending).then(
      () => { void runAuthorityPhase() },
      (error: unknown) => { void runAuthorityPhase(error) },
    )
    // refresh 相位超时：不再直接判失败（见 runAuthorityPhase 文档），先进权威相位。
    phaseTimer = schedule(() => {
      if (this.disposed || attemptSettled) return
      void runAuthorityPhase(new Error(`official session-list refresh phase timed out after ${String(this.attemptTimeoutMs)}ms`))
    }, this.attemptTimeoutMs)
    this.attemptTimer = phaseTimer
  }

  /**
   * 单调推进的结算时刻（同毫秒内的两次结算不得被守卫的水位比较吞掉）。
   * 水位用**独立的已发布水位**字段：`request()` 会把 `settledAt` 置回 undefined
   * （在途），若拿它当单调基准，重新请求后的结算又会回到 `now()`、与上一轮同毫秒
   * （2026-12 三轮复核指出这是死代码）。
   */
  private nextSettledAt(): number {
    const previous = this.lastSettledAt ?? 0
    return Math.max(this.deps.now(), previous + 1)
  }

  private settle(
    ok: boolean,
    error: unknown,
    verdict: SessionFactVerdict = ok ? 'converged' : 'stale',
    corrected = false,
  ): void {
    if (this.disposed) return
    if (!ok && error !== undefined) {
      // 中性前缀：这是**对账链**的失败，可能来自 refresh、探针或写回（2026-12 五轮复核）。
      this.deps.warn(`session-fact reconcile did not settle (attempt ${String(this.attempts)}/${String(this.maxAttempts)}): `
        + (error instanceof Error ? error.message : String(error)))
    }
    // `unknown` 不重试：探针不可用与官方 refresh 无关，同一窗口内再跑一遍只是重复
    // 两轮 refresh+探针；留给下一次 L1 请求（守卫的节拍）重探即可。
    if (!ok && verdict === 'unknown') {
      this.finish(false, 'unknown')
      return
    }
    if (!ok && this.attempts < this.maxAttempts) {
      const schedule = this.deps.schedule ?? defaultSchedule
      this.timer = schedule(() => {
        this.timer = undefined
        if (!this.disposed) this.attempt()
      }, this.retryMs)
      return
    }
    this.finish(ok, ok ? 'converged' : 'stale', corrected)
  }

  /** 结算（不排期）：回执落定 + 通知生产端重发事实。 */
  private finish(ok: boolean, verdict: SessionFactVerdict, corrected = false): void {
    if (this.disposed) return
    this.running = false
    this.settledOk = ok
    this.settledVerdict = verdict
    this.settledCorrected = ok && corrected
    this.settledAt = this.lastSettledAt === undefined ? this.deps.now() : this.nextSettledAt()
    this.lastSettledAt = this.settledAt
    this.deps.onSettled?.()
  }
}
