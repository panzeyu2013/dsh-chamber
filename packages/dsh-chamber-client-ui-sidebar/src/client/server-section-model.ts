/**
 * Pure per-source helpers of the chamber sidebar ServerSection subtree: the
 * connection-status kind/label mapping, the public header title/activation
 * contract and the projection-local-search-snapshot rebuild. The two public
 * helpers stay re-exported so SidebarRoot keeps importing them from
 * ServerSection.tsx.
 */
import { MANAGED_RUNTIME_TRANSIENT_STATES } from '@dsh-chamber/dsh-chamber-client-core/managed-runtime'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { InstanceSnapshot } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import type { SidebarKey } from './locales.ts'

/** Connection-status visual kind: dot colors plus the connecting spinner. */
export type SourceStatusKind = 'ok' | 'busy' | 'err' | 'idle'

/** Rebuild an InstanceSnapshot-shaped view of ONE source aggregate for the LOCAL search
 * matcher from already-post-filter VISIBLE rows (projection only — no raw snapshot, no
 * archivedSessionIds, so the archived filter is EMPTY); wire paths/createdAt are irrelevant. */
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
      // 用户看到的标题就是搜索命中的标签：目录命名的行必须能按用户看到的名字
      // 搜到，故 resolved display title 进入本地快照。
      displayTitle: session.displayTitle,
    }))),
    archivedSessionIds: [],
  }
}

/** Map the projected phase to a visual kind. The reconnect cycle folds into ONE stable
 * "trying" state — the main surface must never flicker between spinner and dot per retry;
 * the text is never rendered (hover carries it). */
export function sourceStatusKind(server: ChamberServerAggregate): SourceStatusKind {
  const phase = server.phase
  if (phase === 'ready') return 'ok'
  if (phase === 'connecting' || phase === 'starting' || phase === 'restarting' || phase === 'degraded') return 'busy'
  if (phase === 'error' || phase === 'stopped' || phase === 'restart-exhausted') return 'err'
  return 'idle'
}


/** Header title/aria text: the managed-down reason replaces "switch to this instance".
 * Exported for the collapsed rail, whose dot buttons must carry the SAME activation
 * contract as the wide header — one definition, no rail copy that can drift. */
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

/** Whether a source header is an activation affordance (not self, not managed-down);
 *  exported beside {@link sourceHeaderTitle} for the rail's named source buttons. */
export function sourceHeaderActivatable(server: ChamberServerAggregate, chamberInstanceId: string | undefined): boolean {  // 终态停机与瞬态 starting/restarting 不可激活：壳 boot 必然 503（App 同样拒绝预热/收割）
  const managedUnusable = server.managedRuntimeDown === true
    || (server.kind === 'gateway'
      // 共用常量而非第二份字面集合：managed-runtime.ts 的瞬态集合增长时，
      // 本头部无需第二次编辑即可跟上。
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

/** Pointer-position half of a row. Must be called synchronously inside a handler: React
 * nulls `currentTarget` as soon as dispatch returns, so reading it from a setState updater
 * (executed on a later render) crashes. */
export function rowHalf(event: { clientY: number; currentTarget: HTMLElement | null }): 'before' | 'after' {
  // 已分离的行（拖拽重渲染中卸载）没有几何——视为指针已越过，绝不算 before 边界。
  if (event.currentTarget === null) return 'after'
  const rect = event.currentTarget.getBoundingClientRect()
  // 零高行（拖拽重渲染边缘）没有两半——同样视为越过，绝不算 before 边界。
  if (rect.height <= 0) return 'after'
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/** 拖拽态里「当前 over 目标」的形状（服务器 / 工作区 / 会话行三种拖拽共用）。 */
export interface DragOverCarrier {
  over: { id: string; half: 'before' | 'after' } | null
}

/** 推进拖拽的 over 目标：目标（id + half）未变时返回**原对象**（不制造 state churn），
 * 否则返回带新 over 的浅拷贝；三处拖拽闭包共用。调用方必须同步算好 half
 * （见 {@link rowHalf}：currentTarget 在 dispatch 后即被置空）；current 为 null 时 no-op。 */
export function dragOverState<T extends DragOverCarrier>(
  current: T | null,
  id: string,
  half: 'before' | 'after',
): T | null {
  if (current === null) return current
  if (current.over?.id === id && current.over.half === half) return current
  return { ...current, over: { id, half } }
}
