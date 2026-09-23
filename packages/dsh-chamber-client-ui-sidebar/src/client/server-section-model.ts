/**
 * Pure per-source helpers of the chamber sidebar ServerSection subtree: the
 * connection-status kind/label mapping, the public header title/activation
 * contract and the projection-local-search-snapshot rebuild. The two public
 * helpers stay re-exported there so SidebarRoot keeps importing them from
 * ServerSection.tsx.
 */
import { MANAGED_RUNTIME_TRANSIENT_STATES } from '@dsh-chamber/dsh-chamber-client-core/managed-runtime'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { InstanceSnapshot } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import type { SidebarKey } from './locales.ts'

/** Connection-status visual kind: dot colors plus the connecting spinner. */
export type SourceStatusKind = 'ok' | 'busy' | 'err' | 'idle'

/**
 * Rebuild an InstanceSnapshot-shaped view of ONE source aggregate for the
 * LOCAL search matcher (06 §1.2 render-side merge). The render layer only
 * has the ChamberServerAggregate projection — no raw InstanceSnapshot, no
 * archivedSessionIds — so the snapshot is rebuilt from the VISIBLE rows:
 * every projected session is already post-filter (subagent-origin /
 * archived / blank-non-current rows never enter the projection), therefore
 * the archived filter gets the EMPTY set (nothing archived can be matched
 * here). Wire paths/createdAt are absent from the projection and irrelevant
 * to title/workspace-label substring matching — empty strings.
 */
export function projectionToLocalSearchSnapshot(server: ChamberServerAggregate): InstanceSnapshot {
  return {
    workspaces: server.workspaces.map(workspace => ({
      workspaceId: workspace.id,
      path: '',
      title: workspace.title,
      sessionIds: workspace.sessions.map(session => session.id),
      createdAt: '',
      updatedAt: '',
    })),
    sessions: server.workspaces.flatMap(workspace => workspace.sessions.map(session => ({
      sessionId: session.id,
      running: session.running === true,
      blank: session.blank === true,
      ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
      ...(session.title === '' ? {} : { title: session.title }),
      // The label is what search matches on, so the resolved display title
      // rides the local snapshot: a directory-named row is searchable by
      // the name the user actually sees.
      displayTitle: session.displayTitle,
    }))),
    archivedSessionIds: [],
  }
}

/**
 * Map the projected phase (local /health status; remote tunnel phase) to a
 * visual kind: ready → green dot; connecting/starting/restarting/degraded →
 * spinner (the reconnect cycle folds into ONE stable "trying" state — the
 * main surface must never flicker between spinner and dot on every retry
 * attempt); error/stopped/restart-exhausted → red dot; the pre-first-poll
 * placeholders (idle/unknown) → gray dot. The text itself is never
 * rendered — hover carries it (tooltip + aria-label).
 */
export function sourceStatusKind(server: ChamberServerAggregate): SourceStatusKind {
  const phase = server.phase
  if (phase === 'ready') return 'ok'
  if (phase === 'connecting' || phase === 'starting' || phase === 'restarting' || phase === 'degraded') return 'busy'
  if (phase === 'error' || phase === 'stopped' || phase === 'restart-exhausted') return 'err'
  return 'idle'
}


/**
 * Header title/aria text: the managed-down reason replaces "switch to this
 * instance". Exported for the collapsed rail: its per-source dot buttons are
 * operable controls and must carry the SAME activation contract as the wide
 * header — one definition, no rail copy that can drift.
 */
export function sourceHeaderTitle(
  server: ChamberServerAggregate,
  chamberInstanceId: string | undefined,
  t: (key: SidebarKey, params?: Record<string, string | number>) => string,
): string | undefined {
  if (server.id === chamberInstanceId) return undefined
  if (server.managedRuntimeDown === true) {
    return t('source.managedDown', { state: t(sourceStatusLabelKey(server)) })
  }
  // 瞬态托管态同样不可激活：title 不能还宣称"切换到该实例"。
  if (server.kind === 'gateway' && (server.phase === 'starting' || server.phase === 'restarting')) {
    return t('source.managedStarting', { state: t(sourceStatusLabelKey(server)) })
  }
  return t('list.activate')
}

/** Whether a source header is an activation affordance (not self, not
 *  managed-down). Exported beside {@link sourceHeaderTitle} for the rail's
 *  named source buttons. */
export function sourceHeaderActivatable(server: ChamberServerAggregate, chamberInstanceId: string | undefined): boolean {  // 终态停机与瞬态 starting/restarting 都不可激活：两者的壳 boot 必然 503
  // （App 侧同样按 managedRuntimeUnusable 拒绝预热/收割），头部不应承诺切换。
  const managedUnusable = server.managedRuntimeDown === true
    || (server.kind === 'gateway'
      // Shared constant, not a second literal set: the
      // transient states live in managed-runtime.ts, and a set that grows
      // there must reach this header without a second edit.
      && (MANAGED_RUNTIME_TRANSIENT_STATES as readonly string[]).includes(server.phase))
  return server.id !== chamberInstanceId && !managedUnusable
}

/** Localized status-label key for a projected phase (tooltip/aria only). */
export function sourceStatusLabelKey(server: ChamberServerAggregate): SidebarKey {
  const phase = server.phase
  if (phase === 'ready') return 'status.ready'
  if (phase === 'connecting') return 'status.connecting'
  if (phase === 'starting') return 'status.starting'
  if (phase === 'restarting') return 'status.restarting'
  if (phase === 'degraded') return 'status.reconnecting'
  if (phase === 'error') return 'status.error'
  if (phase === 'stopped') return 'status.stopped'
  if (phase === 'restart-exhausted') return 'status.restartExhausted'
  if (phase === 'idle') return 'status.idle'
  return 'status.unknown'
}

/**
 * Pointer-position half of a row (insert line above or below). Must only be
 * called synchronously inside a handler: React nulls `currentTarget` on a
 * synthetic event as soon as dispatch returns, so reading it from a setState
 * updater (executed on a later render) crashes.
 */
export function rowHalf(event: { clientY: number; currentTarget: HTMLElement | null }): 'before' | 'after' {
  // A detached row (unmounted mid-drag re-render) has no geometry — treat
  // the pointer as being past it, never as a before-boundary (defensive).
  if (event.currentTarget === null) return 'after'
  const rect = event.currentTarget.getBoundingClientRect()
  // A zero-height row (mid-drag re-render edge) has no halves — treat the
  // pointer as being past it, never as a before-boundary (defensive).
  if (rect.height <= 0) return 'after'
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** 拖拽态里「当前 over 目标」的形状（服务器 / 工作区 / 会话行三种拖拽共用）。 */
export interface DragOverCarrier {
  over: { id: string; half: 'before' | 'after' } | null
}

/**
 * 推进拖拽的 over 目标：目标（id + half）未变时返回**原对象**（不制造 state
 * churn），否则返回带新 over 的浅拷贝。三处拖拽闭包共用本实现。
 * 调用方必须同步算好 half（见 {@link rowHalf}：currentTarget 在 dispatch 后即被置空）。
 * @param current - 当前拖拽态（null 表示拖拽未开始，保持 no-op）。
 * @param id - 悬停目标 id。
 * @param half - 目标的插入半边。
 * @returns 新状态或原状态。
 */
export function dragOverState<T extends DragOverCarrier>(
  current: T | null,
  id: string,
  half: 'before' | 'after',
): T | null {
  if (current === null) return current
  if (current.over?.id === id && current.over.half === half) return current
  return { ...current, over: { id, half } }
}
