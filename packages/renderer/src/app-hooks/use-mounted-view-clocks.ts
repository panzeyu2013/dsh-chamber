/**
 * Mounted-view boot clocks: start the boot-start clock for every non-deferred mount (the
 * absolute-abandon window's basis) and prune the keys with the mount set. The hidden-since
 * bookkeeping and the deferred reclaim clock retired with the idle-reclaim policy (N-ctx
 * resident refactor D1): hidden shells are no longer reclaimed for idleness.
 *
 * The periodic sweep is CONDITIONAL: a 20s tick exists only while the scheduler reports
 * watchdogNeeded (an unsettled mount or a pending harvest intent); `false` never creates a
 * timer. The tick keeps two arms alive that would otherwise depend on an unrelated re-render:
 * the 135s hang-abandon sweep and the backoff-expired prewarm drain.
 */
import { useEffect } from 'react'

/** Conditional watchdog cadence (the retired idle-reclaim tick's 20s; only runs while needed). */
const WATCHDOG_TICK_MS = 20_000

export interface MountedViewClocksInputs {
  mountedViews: string[]
  deferredBootSignature: unknown
  deferredBootRef: { current: ReadonlySet<string> }
  viewBootStartedAtRef: { current: Record<string, number> }
  reclaimHiddenViewsRef: { current: () => void }
  drainPrewarmRef: { current: () => void }
  /** Scheduler's watchdogNeeded: true = build the 20s tick, false = no timer at all. */
  watchdogActive: boolean
}

export function useMountedViewClocks(inputs: MountedViewClocksInputs): void {
  const {
    mountedViews, deferredBootSignature, deferredBootRef, viewBootStartedAtRef,
    reclaimHiddenViewsRef, drainPrewarmRef, watchdogActive,
  } = inputs
  // boot-start 键随挂载收敛（注册表删除 + 释放两条路径）。**被推迟的 boot 不起表**：还没有在途
  // boot，绝不能被 135s 绝对放弃臂判成"永不 settle"；相位离开 idle 后（deferredBootSignature
  // 变化）本 effect 重跑，那一刻才起表。刻意**只跳过起表、绝不删除已有表**：boot 已开始、
  // 来源随后被手动断开时，在途 boot 仍需放弃臂看管。
  useEffect(() => {
    const live = new Set(mountedViews)
    const now = Date.now()
    for (const id of mountedViews) {
      if (deferredBootRef.current.has(id)) continue
      if (viewBootStartedAtRef.current[id] === undefined) viewBootStartedAtRef.current[id] = now
    }
    for (const id of Object.keys(viewBootStartedAtRef.current)) {
      if (!live.has(id)) delete viewBootStartedAtRef.current[id]
    }
  }, [mountedViews, deferredBootSignature, deferredBootRef])

  // 条件 watchdog：watchdogActive === false 不建定时器（常态：没有在途 boot、没有收割意图）。
  // 同 tick 补一次 drain：退避期满的重试不能只靠 30s roster 轮询带来的重渲染驱动
  // （轮询失败时后台槽会无限空转）。
  useEffect(() => {
    if (!watchdogActive) return
    const timer = setInterval(() => {
      reclaimHiddenViewsRef.current()
      drainPrewarmRef.current()
    }, WATCHDOG_TICK_MS)
    return () => { clearInterval(timer) }
  }, [watchdogActive, reclaimHiddenViewsRef, drainPrewarmRef])
}
