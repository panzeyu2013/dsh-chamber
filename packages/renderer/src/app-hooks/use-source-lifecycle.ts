/**
 * Source lifecycle ledger: the ONE owner of the per-source lifecycle registry, the
 * dispatch callback every lifecycle event goes through, and the four live views
 * derived from it (prewarm / suppression / harvest / hidden-since) plus the harvest
 * bookkeeping refs and the settings-panel target ref.
 *
 * Extracted verbatim from App.tsx. The internal declaration order is preserved (the
 * dispatch callback closes over the ledger ref declared below it; legal because the
 * body only runs after render), and the hook order relative to the frame's other
 * hooks is unchanged.
 */
import { useCallback, useRef } from 'react'
import {
  dispatchSource, epochOf, reincarnate,
  type SourceEvent, type SourceRegistry,
} from '@dsh-chamber/dsh-stream-state'
import { isRetryableBootGap, type ShellDegradedKind } from '../boot-gap.ts'
import type { SourceOwnershipRegistry } from '../deep-link-activation.ts'
import {
  useAutoPrewarmedView, useHarvestStateView, useHiddenSinceView, usePrewarmSuppressedView,
} from './use-source-ledger-views.ts'

/** Minimal structural view of the ownership ref (the frame creates the registry). */
interface OwnershipRef {
  current: SourceOwnershipRegistry | null
}

export function useSourceLifecycle(sourceLifecyclesRef: OwnershipRef) {  // Views mounted only by background prewarm; user selection removes the id, freeing an idle-prewarm
  // slot while keeping the user-opened N-ctx shell resident. The incarnation fence uses the ownership
  // registry's REAL fingerprint, so a re-registered source gets a fresh record; `undefined` falls back
  // to the id. Declared BEFORE the ledger views below (they read it during render — else TDZ).
  const dispatchLifecycle = useCallback((viewId: string, event: SourceEvent, capturedEpoch?: number) => {
    let registry = sourceLedgerStoreRef.current
    let epoch = capturedEpoch ?? epochOf(registry, viewId)
    if (epoch === undefined) {
      // The authoritative roster refresh pre-registers every source; this lazy path only covers
      // an event that beats it (or a local view). The ONLY place the ownership fingerprint is read.
      const fingerprint = sourceLifecyclesRef.current?.capture(viewId)?.fingerprint ?? viewId
      registry = reincarnate(registry, { sourceId: viewId, fingerprint })
      epoch = epochOf(registry, viewId)
    }
    if (epoch === undefined) return undefined
    // `retryableGap` is passed as data from `isRetryableBootGap`: the registry owns the decision, the App the table.
    const reduction = dispatchSource(
      registry,
      viewId,
      { ...event, epoch },
      { reclaimGraceMs: 0, retryableGap: (kind) => isRetryableBootGap(kind as ShellDegradedKind) },
    )
    // A dropped event (superseded epoch / unregistered source) returns the SAME registry reference, so this write cannot resurrect a retired life.
    sourceLedgerStoreRef.current = reduction.registry
    return reduction.effects[0]?.effect
  }, [])
  // A Set LEDGER view: reads project the container, add/delete become events (the Set shape is why
  // this is not the assignment-translating view the record ledgers use); sweeps iterate a snapshot.
  const autoPrewarmedRef = useAutoPrewarmedView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  // 保留策略：被回收（闲置隐藏壳超限回收）的源禁止自动预热，直到用户主动点开（selectView 清除）
  // 或来源从注册表删除（retireSources 清除）——否则 prewarmEligible 会立刻把它重新 boot，回收空转。
  const prewarmSuppressedRef = usePrewarmSuppressedView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  // 设置面板目标来源：面板渲染的是**选中来源自己的 boot ctx 台账**，所以该来源的壳必须挂载着。
  // 面板打开期间由 App 保证两件事——未挂载则后台挂载（不切 active view），已挂载则排除出保留策略
  // 回收候选（否则隐藏 60s 后壳被拆，面板正在编辑的设置面随之消失）。关闭即撤除两条保证。
  const settingsTargetRef = useRef<string | undefined>(undefined)
  // 首屏基线收割（baseline-harvest.ts）：ready 但从未挂载过的来源在后台预热槽里挂一次，拿到首个
  // 权威推送即回收——否则它稳态停留在 unary 兜底视图（合成分组 + 空归档集）直到用户点击。
  // harvestStateRef 是每源账本（尝试次数/退避/是否已满足），harvestIntentRef 记录"当前这次挂载是
  // 收割挂载"（提交推送、boot 失败、用户点开三条路径据此分流）。收割槽位由容器承载，存储单一所有者。
  const harvestStateRef = useHarvestStateView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  const harvestIntentRef = useRef<Set<string>>(new Set())
  // 仍需收割的来源（prewarmEligible 的渲染期镜像）：提交推送时据此决定"保留最后收割的壳当温壳"还是"回收让位给下一个候选"。
  const harvestCandidatesRef = useRef<Set<string>>(new Set())
  const sourceLedgerStoreRef = useRef<SourceRegistry>({})
  // The incarnation fence uses the ownership registry's REAL fingerprint, so a re-registered source gets a
  // fresh record; `undefined` falls back to the id. A LIVE VIEW, not a store: reads project the container
  // (never a stale render) and direct writes translate back into reducer events — exactly one owner.
  const hiddenSinceRef = useHiddenSinceView({
    readRegistry: () => sourceLedgerStoreRef.current,
    dispatchLifecycle,
  })
  return {
    sourceLedgerStoreRef, dispatchLifecycle, autoPrewarmedRef, prewarmSuppressedRef,
    settingsTargetRef, harvestStateRef, harvestIntentRef, harvestCandidatesRef, hiddenSinceRef,
  }
}
