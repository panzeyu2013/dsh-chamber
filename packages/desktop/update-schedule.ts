/**
 * update-schedule.ts — 静默更新检查的节奏策略（上游 apps/desktop/src/update-schedule.ts 的镜像）。
 *
 * 单一来源：Electron flavor 的 updater.ts 与 Swift flavor 的 update-headless.ts 都从这里
 * 取「首次延迟 / 周期 / 失败退避 / 抖动」，因此两 flavor 的节奏天然一致（S-37 的数值锁
 * 现在锁的是这里的常量）。环境变量名与上游逐字相同（DSH_DESKTOP_UPDATE_CHECK_*），
 * 便于运维沿用上游文档。
 *
 * 与上游的一处有意偏差：上游 resolveDesktopUpdateScheduleConfig 对非法 env **抛错**；
 * 壳的更新器在装配期抛错等于把应用打不开——我们改为 loud 警告 + 回退默认值
 * （见 resolveUpdateScheduleConfig 的 fallback 说明），非法配置绝不静默生效。
 */

/** 上游同名默认值：周期 600s、退避封顶 1h、抖动 ±20%。 */
export const UPDATE_SCHEDULE_DEFAULTS = {
  intervalMs: 600_000,
  maxBackoffMs: 3_600_000,
  jitter: 0.2,
} as const

/** 首检延迟（保留既有 15s：让应用先稳定，再静默检查一次）。 */
export const UPDATE_FIRST_CHECK_DELAY_MS = 15_000

/** 检查/下载的 idle 超时缺省（上游同值 60s）。 */
export const UPDATE_IDLE_TIMEOUT_DEFAULT_MS = 60_000

/** 抖动后的最小延迟（防退避被抖到 0 造成热循环）。 */
export const UPDATE_MIN_DELAY_MS = 1_000

export interface UpdateScheduleConfig {
  readonly intervalMs: number
  readonly maxBackoffMs: number
  readonly jitter: number
}

export interface ResolveScheduleResult {
  readonly config: UpdateScheduleConfig
  /** 非空 = env 非法，已回退默认值（调用方 loud 记录）。 */
  readonly problems: readonly string[]
}

const MAX_TIMER_MS = 2_147_483_647

function duration(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  problems: string[],
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_TIMER_MS) {
    problems.push(name + ' must be an integer from 1000 through ' + MAX_TIMER_MS)
    return fallback
  }
  return value
}

/**
 * 解析检查节奏（env 名与上游一致）。非法值回退默认并记 problems（绝不抛）。
 * @param env - 进程环境（默认 process.env；测试注入）。
 * @returns 校验后的配置 + 非法项说明。
 */
export function resolveUpdateScheduleConfig(
  env: Record<string, string | undefined>,
): ResolveScheduleResult {
  const problems: string[] = []
  const intervalMs = duration(env, 'DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS', UPDATE_SCHEDULE_DEFAULTS.intervalMs, problems)
  const maxBackoffMs = duration(
    env,
    'DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS',
    Math.max(intervalMs, UPDATE_SCHEDULE_DEFAULTS.maxBackoffMs),
    problems,
  )
  let jitter: number = UPDATE_SCHEDULE_DEFAULTS.jitter
  const rawJitter = env.DSH_DESKTOP_UPDATE_CHECK_JITTER
  if (rawJitter !== undefined && rawJitter !== '') {
    const value = Number(rawJitter)
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      problems.push('DSH_DESKTOP_UPDATE_CHECK_JITTER must be a number in [0, 1]')
    } else {
      jitter = value
    }
  }
  if (maxBackoffMs < intervalMs) {
    problems.push('DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS must cover DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS')
    return {
      config: {
        intervalMs: UPDATE_SCHEDULE_DEFAULTS.intervalMs,
        maxBackoffMs: UPDATE_SCHEDULE_DEFAULTS.maxBackoffMs,
        jitter: UPDATE_SCHEDULE_DEFAULTS.jitter,
      },
      problems,
    }
  }
  return { config: { intervalMs, maxBackoffMs, jitter }, problems }
}

/**
 * 下一次静默检查的延迟：指数退避（×2，封顶 maxBackoffMs）后再乘 ±jitter 抖动。
 * @param input.attempt - 连续失败次数（0 = 上一次成功）。
 * @param input.config - 来自 resolveUpdateScheduleConfig。
 * @param input.random - [0,1) 随机源（测试注入固定值）。
 * @returns 毫秒延迟，≥ UPDATE_MIN_DELAY_MS。
 */
export function nextCheckDelay(input: {
  attempt: number
  config: UpdateScheduleConfig
  random: () => number
}): number {
  const attempt = Math.max(0, Math.floor(input.attempt))
  const base = Math.min(input.config.maxBackoffMs, input.config.intervalMs * 2 ** attempt)
  const span = base * input.config.jitter
  const jittered = base - span + input.random() * span * 2
  return Math.min(MAX_TIMER_MS, Math.max(UPDATE_MIN_DELAY_MS, Math.round(jittered)))
}

/**
 * 检查/下载的 idle 超时（上游 `DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS`，缺省 60s）：
 * 「静默」= 没有响应头或没有新的下载分片，不是总下载时限。非法值回退默认并记问题。
 * @param env - 进程环境。
 * @returns 毫秒超时 + 非法项说明。
 */
export function resolveUpdateIdleTimeout(env: Record<string, string | undefined>): {
  timeoutMs: number
  problem: string | null
} {
  const raw = env.DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS
  if (raw === undefined || raw === '') return { timeoutMs: UPDATE_IDLE_TIMEOUT_DEFAULT_MS, problem: null }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > MAX_TIMER_MS) {
    return {
      timeoutMs: UPDATE_IDLE_TIMEOUT_DEFAULT_MS,
      problem: 'DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS must be an integer from 1000 through ' + MAX_TIMER_MS,
    }
  }
  return { timeoutMs: value, problem: null }
}
