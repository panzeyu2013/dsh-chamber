/**
 * Renderer App time-budget table: the ONE declaration site for the App-side
 * cadences, retry limits and grace windows. The boot budget it references is
 * itself single-sourced in boot-budget.ts (the harvest/abandon ladder derives
 * from it there), so the whole ladder has exactly one number per rung.
 *
 * A hand-written number at a call site drifts out of that ladder silently —
 * worst case the serving gate outlives the abandonment sweep.
 */
import { BOOT_TIMEOUT_MS } from '../boot-budget.ts'

/** Minimum gap between two connection reconnects of one stale MOUNTED source:
 * the watchdog may mark a healthy-but-quiet producer stale on recency alone,
 * so a failed (or unnecessary) reconnect must not retry every tick. */
export const AGGREGATE_RECONNECT_BACKOFF_MS = 60_000

/** 空闲预热的挂载并发上限——同一时刻至多一个"用户没看但已在后台 boot 全量 UI"的壳；
 * 配合保留策略（retention.ts）把稳态壳数压到 local + 活动 + ≤1 隐藏 + ≤1 预热中，
 * 且仅前台推进。 */
export const MAX_PREWARMED_REMOTE_VIEWS = 1

/** gateway 托管 dsh 状态轮询周期（仅前台，见 managed-runtime.ts）。 */
export const MANAGED_RUNTIME_POLL_MS = 15_000

/** 单次托管 dsh 状态探针上限：悬挂的代理请求不得堵死轮询（单飞守卫）。 */
export const MANAGED_RUNTIME_PROBE_TIMEOUT_MS = 10_000

/** 连接行（label/dshPort）低频轮询：状态本身走推送，行字段极少变化。 */
export const CONNECTIONS_POLL_MS = 30_000

/** Cold-start roster failures retry quickly before the 30s steady-state poll. */
export const REMOTE_ROSTER_RETRY_MS = 1_000
export const REMOTE_ROSTER_RETRY_LIMIT = 5

/** A transient listener-ready IPC failure must not strand main's held intent forever. */
export const LISTENER_READY_RETRY_MS = 500
export const LISTENER_READY_RETRY_LIMIT = 5

export const MAX_PENDING_ROSTER_NOTIFICATION_OPENS = 64

/**
 * How long a boot's host-graph fetch may wait for its source to start serving.
 * SINGLE-SOURCED from the boot budget on purpose: the same 60s sizes the
 * shell's page-level slot (boot-budget.ts), the prewarm harvest deadline
 * (HARVEST_DEADLINE_MS = budget + 15s) and the mount abandonment threshold
 * (HARVEST_ABANDON_MS = deadline + budget). A hand-written number here would
 * silently drift out of that ladder.
 */
export const SERVING_WAIT_MS = BOOT_TIMEOUT_MS

/** Poll interval of the serving gate (cheap; ends the moment the phase flips). */
export const SERVING_POLL_MS = 250

/** How long control-plane health may stay down mid-session before the fatal
 * screen shows — tolerates one SSE reconnect / transient blip; the 1s ticker
 * only runs under that condition, so the healthy path stays free. */
export const HEALTH_ERROR_GRACE_MS = 10_000
