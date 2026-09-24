/**
 * source 账本的 live-view 适配层：容器（SourceRegistry）是唯一状态所有者，每个适配器只把
 * 「容器投影」翻译成可变只读视图（读走 project*，写翻译成一条 dispatchLifecycle 事件）。
 *
 * 声明顺序约束：前三个适配器声明在容器 ref 之前，readRegistry 是**延迟读**——闭包只在真正
 * 访问视图时才触及 App 的 const 绑定（否则渲染期求值会命中 TDZ）。
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

/** 容器事件派发（App 的 dispatchLifecycle 签名）；返回值只有调度器内部消费，适配器一律忽略。 */
export type LedgerLifecycleDispatch = (viewId: string, event: SourceEvent, capturedEpoch?: number) => unknown

export interface SourceLedgerViewDeps {
  /** 延迟读容器（前三个适配器声明在容器 ref 之前，只能经闭包读）。 */
  readRegistry: () => SourceRegistry
  dispatchLifecycle: LedgerLifecycleDispatch
}

/** 空闲预热集（Set 视图）：读投影容器，add/delete 各成一条事件；迭代基于快照，边遍历边 delete 安全。 */
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
 * 保留策略：被回收的源禁止自动预热，直到用户主动点开（selectView 清除）或来源从注册表删除
 * （retireSources 清除）——否则 prewarmEligible 会立刻把刚回收的源重新 boot，回收空转。
 * add/delete 都不请求 boot：重 boot 由 prewarm drain 决定，不是本账本。
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
 * 首屏基线收割账本：每源尝试次数/退避/是否已满足。每个调用点读整条记录、跑纯判定、写回，
 * 所以视图接受**成品的记录**（策略函数留在原处，存储只有一个所有者）。
 */
export function useHarvestStateView(deps: SourceLedgerViewDeps): { current: Record<string, { attempts: number; mountedAt: number; retryAt: number; satisfied: boolean }> } {
  const { readRegistry, dispatchLifecycle } = deps
  return useMemo(() => ({
    current: createHarvestView({
      read: () => projectHarvest(readRegistry()),
      // 每个写函数都构造整条记录，所以一次写入携带全部四个字段。
      onWrite: (id, record) => dispatchLifecycle(id, { kind: 'harvestRecord', record }),
      onDelete: (id) => dispatchLifecycle(id, { kind: 'harvestCleared' }),
      // The initial value: an absent record reads as "nothing attempted yet".
      initial: () => ({ attempts: 0, mountedAt: 0, retryAt: 0, satisfied: false }),
    }),
  }), [dispatchLifecycle])
}

/** 保留策略计时：每视图「连续隐藏」起点的活视图；setter 把差异翻译成 hidden / windowReset 事件。 */
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

/** 降级自愈的 once-per-ready-epoch 标记；clear（[id] = false）翻译成 retryForgotten，生命周期只有一个所有者。 */
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

/** 被放弃的视图账本（Map 视图）：只由遮罩的「切换来源」写入，selectView（用户点回）或落地回收删除。 */
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
