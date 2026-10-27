/**
 * Mounted-view retention clocks: prune the hiddenSince/boot-start keys with the mount set,
 * start the boot clock for non-deferred mounts (a deferred boot must NOT be timed as
 * 'never settles', but an already-started one keeps its key), give the deferred views the
 * mount-time hidden clock they would otherwise never get, and run the periodic reclaim
 * tick. Split out of App.tsx (B1-3e); every ref and callback is an explicit input.
 */
import { useEffect } from 'react'
import { VIEW_RECLAIM_TICK_MS } from '../retention.ts'

export interface MountedViewClocksInputs {
  mountedViews: string[]
  deferredBootSignature: unknown
  deferredBootRef: { current: ReadonlySet<string> }
  hiddenSinceRef: { current: Record<string, number> }
  viewBootStartedAtRef: { current: Record<string, number> }
  viewStore: { getSnapshot(): { active: string } }
  pendingViewRef: { current: string | null }
  reclaimHiddenViews: () => void
  reclaimHiddenViewsRef: { current: () => void }
  drainPrewarmRef: { current: () => void }
}

export function useMountedViewClocks(inputs: MountedViewClocksInputs): void {
  const {
    mountedViews, deferredBootSignature, deferredBootRef, hiddenSinceRef, viewBootStartedAtRef,
    viewStore, pendingViewRef, reclaimHiddenViews, reclaimHiddenViewsRef, drainPrewarmRef,
  } = inputs
  // hiddenSince 键随挂载收敛（注册表删除 + 回收两条路径），并在挂载/回收/激活变化后补查一轮回收（60s 安全窗外的兜底由周期 tick 承担）。
  useEffect(() => {
    const live = new Set(mountedViews)
    for (const id of Object.keys(hiddenSinceRef.current)) {
      if (!live.has(id)) delete hiddenSinceRef.current[id]
    }
    // 挂载时刻（绝对放弃上限的基准；settle 时清除）。**被推迟的 boot 不起表**：还没有在途 boot，
    // 绝不能被放弃臂判成"永不 settle"；相位离开 idle 后本 effect 重跑，那一刻才起表。刻意**只跳过
    // 起表、绝不删除已有表**：boot 已开始、来源随后被手动断开时，在途 boot 仍需放弃臂看管。
    const now = Date.now()
    for (const id of mountedViews) {
      if (deferredBootRef.current.has(id)) {
        // 生命周期：被推迟的视图**永不 settle**，拿不到 handleInstanceSettled 的 hiddenSince，后台
        // 挂载（设置面板选来源）又不过 activeView 变化臂——没有计时键，推迟回收臂与 retention 都看
        // 不见它（视图泄漏 + 误占预热槽）。这里按挂载时刻起表，与"隐藏即计时"同一条语义。
        if (id !== viewStore.getSnapshot().active && id !== pendingViewRef.current
          && hiddenSinceRef.current[id] === undefined) {
          hiddenSinceRef.current[id] = now
        }
        continue
      }
      if (viewBootStartedAtRef.current[id] === undefined) viewBootStartedAtRef.current[id] = now
    }
    for (const id of Object.keys(viewBootStartedAtRef.current)) {
      if (!live.has(id)) delete viewBootStartedAtRef.current[id]
    }
    reclaimHiddenViews()
  }, [mountedViews, deferredBootSignature, reclaimHiddenViews])

  // 周期回收检查（settle/切换以外的主要驱动）；visibilitychange 恢复补偿的回收臂在下方 aggregate 段
  // visibility effect 中统一处理（与预热/聚合补偿同源，避免重复监听）。
  useEffect(() => {
    const timer = setInterval(() => {
      reclaimHiddenViewsRef.current()
      // 退避期满的重试不能只靠 30s roster 轮询带来的重渲染驱动（轮询失败时后台槽会无限空转）：同一 tick 补一次 drain。
      drainPrewarmRef.current()
    }, VIEW_RECLAIM_TICK_MS)
    return () => { clearInterval(timer) }
  }, [])
}
