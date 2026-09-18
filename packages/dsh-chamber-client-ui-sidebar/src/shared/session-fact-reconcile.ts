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
   */
  readonly verify?: () => Promise<SessionFactVerdict>
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
   * **verify 相位**的上限（默认 35s）。必须 ≥ 权威 unary 探针自身的上限
   * （`instance-api.ts` 的 30s AbortSignal）：两个相位共用一个计时器时，慢宿主上
   * 「refresh 花了 15s + 探针 25s」会被 20s 预算误判成「拿不到权威结论」⇒ 假 L2
   * 与假横幅（2026-12 二轮复核）。进入 verify 时重新起算。
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
}

const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_RETRY_MS = 1_500
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000
const DEFAULT_VERIFY_TIMEOUT_MS = 35_000

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
 * **权威判定**（纯函数，2026-12 修复的语义核心；生产端
 * `verifySessionFactConvergence` 只是取数 + 调本函数）：
 * 官方 `refreshList()` 对拉取失败**照常 resolve**，所以「promise 解决」不算
 * 「拿到权威结论」；只有把官方 store 的 running 位与**独立 unary 权威快照**对
 * 表才能判定收敛。
 *
 * 判定规则（保守优先——假升级＝reconnect 风暴，比漏判更糟）：
 *  1. 官方说 running 的每一行；
 *  2. 跳过后端刻意过滤的行：子代理（`origin === 'subagent'`）；
 *  3. 跳过权威快照里不存在的行（被过滤/已归档/未知）——无证词即不作判定；
 *  4. 只有当权威明确给出「该会话没在跑」时才判不收敛（false）。
 *
 * 于是「宿主确实还在跑」（长工具/长推理）永远返回 true（无升级依据），而
 * 「官方位卡住 + 权威说已结束」返回 false（允许升级 L2/L3）。
 *
 * **已知残余（2026-12 二轮复核登记，未闭合）**：官方 running=true 而权威快照**整行
 * 缺席**时本函数不作证（返回 true）。缺席只可能来自「子代理被过滤」（已在上面排除）
 * 或「该会话不在权威 corpus 里」（已归档/删除，或宿主返回了不完整列表）；后者理论上
 * 是「官方位卡住」的一个出口，但把「缺席」判成未收敛会在宿主返回瞬时局部列表时引入
 * 假升级（reconnect 风暴的经济性比漏判更差）。收口方式 = 上游给权威读一个「完整性」
 * 信号（例如 asOfSeq/游标），届时可把缺席升级为「未收敛」；见
 * `docs/progress/STATUS.md` 的对应未闭合门。
 * @param official - 官方 store 的 byId 视图。
 * @param authoritative - 独立 unary 探针取到的行。
 * @returns 是否拿到了权威结论（true = 收敛/一致）。
 */
export function sessionFactsConverged(
  official: Readonly<Record<string, OfficialSessionFactRow | undefined>>,
  authoritative: readonly AuthoritativeSessionFactRow[],
): boolean {
  const authoritativeById = new Map(authoritative.map(row => [row.sessionId, row]))
  for (const [sessionId, summary] of Object.entries(official)) {
    if (summary?.running !== true) continue
    if (summary.origin === 'subagent') continue
    const row = authoritativeById.get(sessionId)
    if (row === undefined) continue
    if (row.running !== true) return false
  }
  return true
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
      // 调用点同步抛错多为瞬时（代理/客户端状态窗口），按可重试失败处理。
      this.settle(false, error)
      return
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
     * 相位计时器。**两个相位的超时语义不同**（2026-12 三轮复核）：refresh 相位超时
     * = 官方对账没有结论 ⇒ 失败；verify 相位超时 = 辅助探针（**另一条载体**）没回来
     * ⇒ `unknown`（不升级、不清等待），与探针抛错/自身上限超时同一条语义。
     */
    const armPhase = (ms: number, phase: 'refresh' | 'verify'): void => {
      phaseTimer = schedule(() => {
        if (!finishAttempt()) return
        this.settle(false, new Error(`session-fact reconcile ${phase} phase timed out`),
          phase === 'verify' ? 'unknown' : 'stale')
      }, ms)
      this.attemptTimer = phaseTimer
    }
    armPhase(this.attemptTimeoutMs, 'refresh')
    const settleWithinAttempt = (verdict: SessionFactVerdict, error: unknown): void => {
      if (!finishAttempt()) return
      if (verdict === 'converged') this.settle(true, undefined)
      else this.settle(false, error, verdict)
    }
    void Promise.resolve(pending).then(
      async () => {
        // dispose 之后仍在飞的 continuation 不得再武装 verify 相位或调用探针
        // （teardown 后无副作用；settle 的 disposed 栅栏只挡住回执，不挡住副作用）。
        if (this.disposed || attemptSettled) return
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
        if (verdict === 'converged') {
          settleWithinAttempt('converged', undefined)
          return
        }
        if (verdict === 'unknown') {
          settleWithinAttempt('unknown', new Error('session-fact reconcile probe is unavailable (no authority this round)'))
          return
        }
        settleWithinAttempt('stale', new Error('session-fact reconcile did not converge to an authoritative baseline'))
      },
      (error: unknown) => { settleWithinAttempt('stale', error) },
    )
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

  private settle(ok: boolean, error: unknown, verdict: SessionFactVerdict = ok ? 'converged' : 'stale'): void {
    if (this.disposed) return
    if (!ok && error !== undefined) {
      this.deps.warn(`official session refresh failed (attempt ${String(this.attempts)}/${String(this.maxAttempts)}): `
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
    this.finish(ok, ok ? 'converged' : 'stale')
  }

  /** 结算（不排期）：回执落定 + 通知生产端重发事实。 */
  private finish(ok: boolean, verdict: SessionFactVerdict): void {
    if (this.disposed) return
    this.running = false
    this.settledOk = ok
    this.settledVerdict = verdict
    this.settledAt = this.lastSettledAt === undefined ? this.deps.now() : this.nextSettledAt()
    this.lastSettledAt = this.settledAt
    this.deps.onSettled?.()
  }
}
