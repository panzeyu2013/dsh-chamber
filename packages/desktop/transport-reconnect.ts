/**
 * 宿主统一尝试调度器：OS 唤醒重探、sidecar 启动对账、权威保存的新增行对账共用一个
 * 规划器 + 执行器（v2 §P2-B / B 切片 §3.2.5；O2：并入既有 transport-reconnect.ts，
 * 不新建 reconcile 模块）。
 *
 * 三条来源（kind）：
 * - 'startup'：sidecar bindPlane + ready 帧之后对**全部行**对账（仅 idle；suppressed/
 *   quitting/plane 未绑定一律跳过）——本切片的核心：页面未加载也连、sidecar 重启后连回。
 * - 'added'：authoritative save 后只对**新增 id**（nextIds - beforeIds）对账。
 * - 'wake'：OS 唤醒/网络恢复的即时重探——保持既有相位筛（只 error/degraded）与
 *   requiresUserAction 跳过，并补上错峰窗口内的票据复查。
 *
 * 纪律：错峰（默认 120ms，与唤醒波次同值、上限 32 行 ⇒ 最坏 ~3.7s 收敛）；每个定时
 * 尾都过 attemptStillAuthorized 票据三查（退出/行身份/传输代 + 执行时意图抑制），
 * stale-row 按当前 level 重规划一次、其余一律丢弃留 info；timer unref 且可取消；
 * 整条链 self-swallow 错误、永不 reject（sidecar 的 unhandledRejection → exit 1）。
 */
import { attemptStillAuthorized, type AttemptTicket, type ConnectionIntentSnapshot } from './connection-intent.ts'
import { describeError } from './describe-error.ts'
import type { TransportManager } from './transport-manager.ts'
import type { TransportPhase } from './transport-provider.ts'

/** 生产错峰值（与唤醒波次/连接行错峰一致：120ms）。 */
export const DEFAULT_HOST_ATTEMPT_STAGGER_MS = 120

export type HostAttemptKind = 'startup' | 'added' | 'wake'

export type HostAttemptAction =
  | 'connect'
  | 'skip-quitting'
  | 'skip-plane'
  | 'skip-suppressed'
  | 'skip-unknown'
  | 'skip-not-idle'
  | 'skip-terminal'

export interface HostAttemptPlanRow {
  readonly id: string
  readonly action: HostAttemptAction
}

/** 纯规划输入：只含事实（无 timer、无副作用、无 manager 依赖）。 */
export interface HostAttemptPlanInput {
  readonly kind: HostAttemptKind
  /** 候选 id（顺序即波次顺序）；rows 里不存在的 id 会落在 skip-unknown。 */
  readonly ids: readonly string[]
  readonly isQuitting: boolean
  readonly planeBound: boolean
  readonly suppressed: ReadonlySet<string>
  readonly status: (id: string) => { readonly phase: TransportPhase; readonly requiresUserAction?: boolean } | null
}

/**
 * 纯规划（可单测）：退出 → plane（startup/added 硬门）→ 意图抑制 → 行存在 → 相位。
 * wake 的相位筛与既有时序逐条一致：只 error/degraded 且 requiresUserAction !== true。
 */
export function planHostAttempts(input: HostAttemptPlanInput): HostAttemptPlanRow[] {
  const plan: HostAttemptPlanRow[] = []
  for (const id of input.ids) {
    if (input.isQuitting) {
      plan.push({ id, action: 'skip-quitting' })
      continue
    }
    if (input.kind !== 'wake' && !input.planeBound) {
      // bindPlane 之前发起会漏掉注册（P5 死局）——startup/added 硬拒；wake 沿用既有时序。
      plan.push({ id, action: 'skip-plane' })
      continue
    }
    if (input.suppressed.has(id)) {
      plan.push({ id, action: 'skip-suppressed' })
      continue
    }
    const status = input.status(id)
    if (status === null) {
      plan.push({ id, action: 'skip-unknown' })
      continue
    }
    if (input.kind === 'wake') {
      if (status.phase !== 'error' && status.phase !== 'degraded') {
        plan.push({ id, action: 'skip-not-idle' })
        continue
      }
      if (status.requiresUserAction === true) {
        plan.push({ id, action: 'skip-terminal' })
        continue
      }
    } else if (status.phase !== 'idle') {
      plan.push({ id, action: 'skip-not-idle' })
      continue
    }
    plan.push({ id, action: 'connect' })
  }
  return plan
}

/** 排队票据的只读事实来源（manager.getAttemptFacts 的结构面）。 */
export interface HostAttemptFacts {
  readonly state: object
  readonly tunnelEpoch: number
}

/** 执行器依赖：事实全部注入（生产 = host-assembly 的 manager 面；测试 = 替身）。 */
export interface HostAttemptDeps {
  readonly listInstances: () => readonly { readonly id: string }[]
  readonly status: (id: string) => { readonly phase: TransportPhase; readonly requiresUserAction?: boolean } | null
  readonly connect: (id: string) => unknown
  /** 本会话意图快照；缺省 = 无意图事实（旧唤醒替身/无会话宿主）。 */
  readonly connectionIntents?: () => ConnectionIntentSnapshot
  readonly getAttemptFacts?: (id: string) => HostAttemptFacts | null
  readonly isQuitting: () => boolean
  /** plane 绑定事实（startup/added 硬门；缺省 true = 不验证）。 */
  readonly planeBound?: () => boolean
  readonly log: (level: 'info' | 'warn', message: string) => void
  /** 旧唤醒调用方的 2 参告警面（保留既有文案/错误对象形状）；缺省走 log。 */
  readonly warnConnect?: (id: string, error: unknown) => void
  /** 测试注入的定时器（生产缺省 = unref 的真实 setTimeout，可取消）。 */
  readonly setTimer?: (run: () => void, milliseconds: number) => HostAttemptTimer
}

export interface HostAttemptTimer {
  unref?: () => void
  cancel?: () => void
}

export interface HostAttemptOptions {
  readonly kind: HostAttemptKind
  /** 只对指定 id 执行（added 波次）；缺省 = 当前全部行。 */
  readonly ids?: readonly string[]
  /** 错峰间隔；0 = 全部同步（测试/历史唤醒循环）。 */
  readonly staggerMs?: number
}

const EMPTY_SUPPRESSED: ReadonlySet<string> = new Set<string>()

/** 未取消的错峰定时器（dispose 时可整体撤销；每个尾仍自证 isQuitting）。 */
const pendingAttemptTimers = new Set<HostAttemptTimer>()

/** 取消所有未触发的尝试定时器（退出/测试清理；触发中的票据仍会自证）。 */
export function cancelHostAttemptTimers(): void {
  for (const timer of pendingAttemptTimers) {
    try {
      timer.cancel?.()
    } catch { /* 已触发的 timer 不可取消：忽略 */ }
  }
  pendingAttemptTimers.clear()
}

const defaultSetTimer = (run: () => void, milliseconds: number): HostAttemptTimer => {
  const timer = setTimeout(run, milliseconds)
  timer.unref?.()
  return { cancel: () => clearTimeout(timer) }
}

function ticketFor(deps: HostAttemptDeps, id: string): AttemptTicket {
  const facts = deps.getAttemptFacts?.(id) ?? null
  return { id, state: facts?.state ?? null, tunnelEpoch: facts?.tunnelEpoch ?? null }
}

/** 失败的两条既有告警面（warnConnect 优先；绝不外抛，sidecar 的 unhandledRejection 会 exit）。 */
function warnAttemptFailure(deps: HostAttemptDeps, id: string, error: unknown): void {
  if (deps.warnConnect !== undefined) {
    deps.warnConnect(id, error)
    return
  }
  deps.log('warn', `host-attempt ${id} connect failed: ${describeError(error)}`)
}

/** 执行一次 connect（错误折叠为告警面）。 */
function connectHostAttempt(deps: HostAttemptDeps, id: string): void {
  try {
    deps.connect(id)
  } catch (error) {
    warnAttemptFailure(deps, id, error)
  }
}

/**
 * `stale-row` 的同步重规划（一次，不新增 timer/波次）：行身份换代可能来自删行/重加或
 * 机制/参数改址，但**当前 level 才是真值**——复用同一纯规划器按当前 plane/suppressed/
 * 相位再判一次：行仍在、相位合格、未抑制才连接，否则丢弃留 info。
 * `stale-transport`/quit/`suppressed` 永不重规划：已意图断开的行绝不复活。
 */
function replanHostAttempt(deps: HostAttemptDeps, kind: HostAttemptKind, id: string): void {
  const [row] = planHostAttempts({
    kind,
    ids: [id],
    isQuitting: deps.isQuitting(),
    planeBound: deps.planeBound?.() ?? true,
    suppressed: deps.connectionIntents?.().suppressed ?? EMPTY_SUPPRESSED,
    status: candidate => deps.status(candidate),
  })
  if (row === undefined) return
  deps.log('info', `host-attempt ${id} stale-row; re-planned: ${row.action}`)
  if (row.action === 'connect') connectHostAttempt(deps, id)
}

/** 执行前的票据三查（每次 fire 都重读事实/意图）；stale-row 重规划一次，其余非 authorized 丢弃并留痕。 */
function fireHostAttempt(deps: HostAttemptDeps, kind: HostAttemptKind, ticket: AttemptTicket): void {
  try {
    const outcome = attemptStillAuthorized(ticket, {
      isQuitting: deps.isQuitting,
      stateOf: (id) => deps.getAttemptFacts?.(id)?.state ?? null,
      tunnelEpochOf: (id) => deps.getAttemptFacts?.(id)?.tunnelEpoch ?? null,
      suppressed: deps.connectionIntents?.().suppressed ?? EMPTY_SUPPRESSED,
    })
    if (outcome === 'stale-row') {
      replanHostAttempt(deps, kind, ticket.id)
      return
    }
    if (outcome !== 'authorized') {
      deps.log('info', `host-attempt ${ticket.id} skipped: ${outcome}`)
      return
    }
    connectHostAttempt(deps, ticket.id)
  } catch (error) {
    warnAttemptFailure(deps, ticket.id, error)
  }
}

/**
 * 执行一波宿主尝试（幂等：重复调用只补当前仍需连的行）。永不 reject——任何异常折叠为
 * warn 行；错峰定时器 unref 且登记可取消；每拍过票据三查（stale-row 重规划一次）。
 */
export async function runHostAttempts(deps: HostAttemptDeps, options: HostAttemptOptions): Promise<void> {
  try {
    if (deps.isQuitting()) return
    const snapshot = deps.connectionIntents?.()
    const ids = options.ids ?? deps.listInstances().map(instance => instance.id)
    const plan = planHostAttempts({
      kind: options.kind,
      ids,
      isQuitting: deps.isQuitting(),
      planeBound: deps.planeBound?.() ?? true,
      suppressed: snapshot?.suppressed ?? EMPTY_SUPPRESSED,
      status: id => deps.status(id),
    })
    const staggerMs = Math.max(0, options.staggerMs ?? DEFAULT_HOST_ATTEMPT_STAGGER_MS)
    let waveIndex = 0
    for (const row of plan) {
      if (row.action !== 'connect') {
        deps.log('info', `host-attempt ${row.id} ${row.action}`)
        continue
      }
      const ticket = ticketFor(deps, row.id)
      const attempt = (): void => { fireHostAttempt(deps, options.kind, ticket) }
      if (staggerMs === 0 || waveIndex === 0) {
        attempt()
      } else {
        let timer: HostAttemptTimer
        timer = (deps.setTimer ?? defaultSetTimer)(() => {
          // A fired timer is no longer pending: drop it before the ticket-guarded attempt
          // (otherwise a long-lived sidecar accumulates one dead entry per wake/reconcile).
          pendingAttemptTimers.delete(timer)
          attempt()
        }, waveIndex * staggerMs)
        pendingAttemptTimers.add(timer)
        timer.unref?.()
      }
      waveIndex += 1
    }
  } catch (error) {
    deps.log('warn', `host-attempt wave (${options.kind}) failed: ${describeError(error)}`)
  }
}

/** runHostAttempts 的 manager 结构面（host-assembly 用完整 manager，测试可替身）。 */
export type HostAttemptSm = Pick<TransportManager, 'listInstances' | 'status' | 'connect'>
  & Partial<Pick<TransportManager, 'connectionIntents' | 'getAttemptFacts'>>

export interface ReconnectStaleOptions {
  /** Delay between instances; 0 keeps the historical synchronous loop. */
  readonly staggerMs?: number
  /** 测试注入：定时器。 */
  readonly setTimer?: (run: () => void, milliseconds: number) => HostAttemptTimer
}

/**
 * OS 唤醒重探（历史入口，签名保持）：only transient failures are touched —
 * phase error/degraded AND not terminal (requiresUserAction === true means "do not
 * retry the RESUME wave"); never idle. Now routed through the shared planner so the
 * stagger window re-checks the intent/row/transport generations (T8); a quit in
 * flight must not spawn new transports; a missing manager is a no-op. A per-instance
 * throw stays loud without breaking the resume frame; the caller supplies its
 * flavor's log label.
 */
export function reconnectStaleTransports(
  sm: HostAttemptSm | null,
  isQuitting: () => boolean,
  warn: (message: string, error: unknown) => void,
  label: string,
  options: ReconnectStaleOptions = {},
): void {
  if (isQuitting()) return
  if (sm === null) return
  const deps: HostAttemptDeps = {
    listInstances: () => sm.listInstances(),
    status: (id) => {
      const status = sm.status(id)
      return status === null ? null : { phase: status.phase, requiresUserAction: status.requiresUserAction }
    },
    connect: (id) => { sm.connect(id) },
    ...(sm.connectionIntents === undefined ? {} : { connectionIntents: () => sm.connectionIntents!() }),
    ...(sm.getAttemptFacts === undefined ? {} : { getAttemptFacts: (id: string) => sm.getAttemptFacts!(id) }),
    isQuitting,
    planeBound: () => true,
    log: (level, message) => {
      if (level === 'warn') console.warn(`${label} ${message}`)
    },
    warnConnect: (id, error) => { warn(label + ' 唤醒重探 ' + id + ' 失败：', error) },
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
  }
  void runHostAttempts(deps, { kind: 'wake', staggerMs: options.staggerMs ?? 0 })
}
