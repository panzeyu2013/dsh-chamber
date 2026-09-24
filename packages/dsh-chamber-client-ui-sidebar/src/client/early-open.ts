/**
 * Boot-time early-open arm — one instance ctx, driven by the sidebar plugin's
 * effect. The cold-booted shell's official workspace navigation policy REUSES
 * or CREATES (host-side `session.create`) a blank session when no current
 * session exists, and the App's dispatch starts only after boot settlement;
 * this arm polls the page-wide open-intent slot (`App.openSession` owns
 * arm/release) in the target ctx and preempts the policy as soon as the
 * requested session is addressable. Contract: never reports an outcome (the
 * App owns the terminal report and row-level error surface; `sessions.open`
 * is idempotent); one open per arm; live-intent read (absent slot = "not
 * yet"); a missing/throwing list face retires silently.
 */
import {
  EARLY_OPEN_BUDGET_MS,
  EARLY_OPEN_RETRY_MS,
  shouldEarlyOpenSession,
} from '@dsh-chamber/dsh-chamber-client-core/open-intent'

export interface EarlyOpenArmDeps {
  instanceId: string
  /** Live intent read — never a captured value (see the contract above). */
  readIntent: () => string | undefined
  /**
   * `undefined` = the list face is absent/hostile or the probe threw (retire
   * silently); `false` = readable but not listed yet (keep polling). A per-id
   * probe rather than an id set: 50ms cadence, lists can hold thousands of rows.
   */
  isAddressable: (sessionId: string) => boolean | undefined
  /** Open on this ctx's OWN sessions service (method call, never a detached reference). */
  open: (sessionId: string) => void
  /** One loud line for a refused open (an unexpected state: the id was listed). */
  warn: (message: string) => void
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/** Start the arm: one immediate attempt, then the retry cadence until the
 *  deadline. Returns the disposer (ctx teardown). */
export function startEarlyOpenArm(deps: EarlyOpenArmDeps): () => void {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
  const clearTimer = deps.clearTimer ?? (handle => { clearTimeout(handle) })
  const deadline = now() + EARLY_OPEN_BUDGET_MS
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const finish = (): void => {
    finished = true
    if (timer !== undefined) {
      clearTimer(timer)
      timer = undefined
    }
  }

  const attempt = (): void => {
    timer = undefined
    if (finished) return
    const intent = deps.readIntent()
    if (intent !== undefined) {
      let addressable: boolean | undefined
      try {
        addressable = deps.isAddressable(intent)
      } catch {
        // 计时器回调里的逃逸异常会静默杀死节奏（无下一 tick、无告警），故退休。
        return finish()
      }
      // 缺失/敌意面 ⇒ 静默退休：同 ctx 的 runtime-facts producer 已为此告警。
      if (addressable === undefined) return finish()
      if (shouldEarlyOpenSession(intent, addressable)) {
        try {
          deps.open(intent)
        } catch (error) {
          deps.warn(`boot-time early open of ${intent} on ${deps.instanceId} was refused: `
            + `${error instanceof Error ? error.message : String(error)}`)
        }
        return finish()
      }
    }
    // 空意图是「尚未」而非「永不」：首次尝试在 plugin apply 时同步执行，早于
    // 用户点击，预热/收割启动是常态；首次空读即退休会让已在飞行中的点击落空，
    // 官方导航策略随后在 host 上创建空会话——正是本 arm 要避免的代价。只有
    // 一次成功/被拒的 open 与 8s 截止时间终止本 arm，空槽保持 50ms 节奏。
    if (now() >= deadline) return finish()
    timer = setTimer(attempt, EARLY_OPEN_RETRY_MS)
  }

  attempt()
  return finish
}
