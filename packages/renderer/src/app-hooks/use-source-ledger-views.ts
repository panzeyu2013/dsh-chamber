/**
 * source 账本的 live-view 适配层（App.tsx 的 6 个适配器，原样抽出）。
 *
 * 容器（dsh-stream-state 的 SourceRegistry）是唯一状态所有者；这里的每个适配器
 * 只把「容器投影」翻译成一个可变的只读视图：读走 project*，写翻译成一条 reducer
 * 事件（dispatchLifecycle）。App 只负责把容器 ref 与派发函数接进来，适配器的
 * 调用位置、useMemo 依赖与对象身份语义与抽出前逐字一致。
 *
 * 声明顺序约束（App 侧不变）：前三个适配器（autoPrewarmed / prewarmSuppressed /
 * harvestState）声明在容器 ref 之前，因此 readRegistry 是**延迟读**——闭包只在
 * 真正访问视图时才触及 App 的 const 绑定（否则渲染期求值会命中 TDZ）。
 */
import { useMemo } from 'react'
import {
  createHarvestView,
  createMapLedgerView,
  createSetLedgerView,
  projectAbandonedTargets,
  projectAutoPrewarmed,
  projectDegradedRetried,
  projectHarvest,
  projectHiddenSince,
  projectPrewarmSuppressed,
  type MapLedgerView,
  type SetLedgerView,
  type SourceEvent,
  type SourceRegistry,
} from '@dsh-chamber/dsh-stream-state'

/**
 * 容器事件派发（App 的 dispatchLifecycle 签名；返回值只有调度器内部消费，
 * 适配器一律忽略）。
 */
export type LedgerLifecycleDispatch = (viewId: string, event: SourceEvent, capturedEpoch?: number) => unknown

export interface SourceLedgerViewDeps {
  /** 延迟读容器（前三个适配器声明在容器 ref 之前，只能经闭包读）。 */
  readRegistry: () => SourceRegistry
  dispatchLifecycle: LedgerLifecycleDispatch
}

/**
 * 空闲预热集（Set 视图）：reads 投影容器，add/delete 各成一条事件。
 * 迭代基于快照，故「边遍历边 delete」的清扫是安全的。
 */
export function useAutoPrewarmedView(deps: SourceLedgerViewDeps): { current: SetLedgerView } {
  const { readRegistry, dispatchLifecycle } = deps
  return useMemo(() => ({
    current: createSetLedgerView({
      read: () => projectAutoPrewarmed(readRegistry()),
      onAdd: (id) => dispatchLifecycle(id, { kind: 'prewarmStarted' }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'prewarmForgotten' }),
    }),
  }), [dispatchLifecycle])
}

/**
 * 保留策略：被回收（闲置隐藏壳超限回收）的源禁止自动预热，直到用户主动
 * 点开（selectView 清除）或来源从注册表删除（retireSources 清除）——否则
 * prewarmEligible 会立刻把刚回收的源重新 boot，回收空转（见 reclaimView）。
 * add = retention just suppressed this source; delete = the suppression entry
 * is gone (user opened it, or the registry dropped it). Neither asks for a boot
 * - the re-boot decision is the prewarm drain's, not this ledger's.
 */
export function usePrewarmSuppressedView(deps: SourceLedgerViewDeps): { current: SetLedgerView } {
  const { readRegistry, dispatchLifecycle } = deps
  return useMemo(() => ({
    current: createSetLedgerView({
      read: () => projectPrewarmSuppressed(readRegistry()),
      onAdd: (id) => dispatchLifecycle(id, { kind: 'prewarmSuppressed' }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'prewarmSuppressionForgotten' }),
    }),
  }), [dispatchLifecycle])
}

/**
 * 首屏基线收割账本（design 05 / baseline-harvest.ts）：每源尝试次数/退避/
 * 是否已满足。the harvest slots are container-backed：每个调用点读整条记录、
 * 跑一个纯判定函数、把结果写回，所以视图接受**成品的记录**（策略函数留在原处，
 * 存储只有一个所有者）。
 */
export function useHarvestStateView(deps: SourceLedgerViewDeps): { current: Record<string, { attempts: number; mountedAt: number; retryAt: number; satisfied: boolean }> } {
  const { readRegistry, dispatchLifecycle } = deps
  return useMemo(() => ({
    current: createHarvestView({
      read: () => projectHarvest(readRegistry()),
      // harvestAttemptStarted / harvestSatisfied / harvestParkedRecord 每条都构造
      // 整条记录，所以一次写入携带全部四个字段。
      onWrite: (id, record) => dispatchLifecycle(id, { kind: 'harvestRecord', record }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'harvestCleared' }),
      // The initial value: an absent record reads as "nothing attempted yet".
      initial: () => ({ attempts: 0, mountedAt: 0, retryAt: 0, satisfied: false }),
    }),
  }), [dispatchLifecycle])
}

/**
 * 保留策略计时：每视图「连续隐藏」起点的活视图（getter/setter 对象，
 * 不是 store）。读每次投影容器；setter 把差异翻译成 hidden / windowReset 事件。
 */
export function useHiddenSinceView(deps: SourceLedgerViewDeps): { current: Record<string, number> } {
  const { readRegistry, dispatchLifecycle } = deps
  return useMemo(() => ({
    get current(): Record<string, number> {
      return projectHiddenSince(readRegistry())
    },
    set current(next: Record<string, number>) {
      const previous = projectHiddenSince(readRegistry())
      for (const [id, at] of Object.entries(next)) {
        if (previous[id] !== at) dispatchLifecycle(id, { kind: 'hidden', at })
      }
      for (const id of Object.keys(previous)) {
        if (next[id] === undefined) dispatchLifecycle(id, { kind: 'windowReset' })
      }
    },
  }), [dispatchLifecycle])
}

/**
 * 降级自愈的 once-per-ready-epoch 标记（同一个容器投影）。
 * clear（[id] = false）翻译成容器的 retryForgotten，标记生命周期只有一个所有者。
 */
export function useDegradedRetriedView(deps: SourceLedgerViewDeps): { current: Record<string, boolean> } {
  const { readRegistry, dispatchLifecycle } = deps
  return useMemo(() => ({
    get current(): Record<string, boolean> {
      return projectDegradedRetried(readRegistry())
    },
    set current(next: Record<string, boolean>) {
      const previous = projectDegradedRetried(readRegistry())
      for (const id of Object.keys(previous)) {
        if (next[id] !== true) dispatchLifecycle(id, { kind: 'retryForgotten' })
      }
    },
  }), [dispatchLifecycle])
}

/**
 * 被放弃的视图账本（Map 视图）：只由遮罩的「切换来源」写入，
 * selectView（用户又点回它 = 撤回意图）或落地回收删除。Map 视图：读投影容器，
 * set/delete 各成一条事件（清扫遍历的是快照，循环内删除安全）。
 */
export function useAbandonedViewsView(deps: SourceLedgerViewDeps): { current: MapLedgerView } {
  const { readRegistry, dispatchLifecycle } = deps
  return useMemo(() => ({
    current: createMapLedgerView({
      read: () => projectAbandonedTargets(readRegistry()),
      onSet: (id, target) => dispatchLifecycle(id, { kind: 'abandoned', target }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'abandonmentCleared' }),
    }),
  }), [dispatchLifecycle])
}
