/**
 * Cross-cutting state for one sidebar shell's per-source sections: SidebarRoot
 * owns every store/effect/commit below and provides ONE context value per
 * render; ServerSection / workspace groups / session rows read what they need
 * through useSidebarSection(). Nothing here is a store — the shell re-renders
 * and rebuilds the value.
 */
import { createContext, useContext, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { sourceAccentColor, type SessionOrderBy } from '@dsh-chamber/dsh-chamber-client-core/derive'
import type { WorkspaceDropEnv } from '@dsh-chamber/dsh-chamber-client-core/workspace-drag-order'
import { getWorkspaceGitFlag, hiddenByMainWorkspaceFold } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import type { ChamberSidebarViewPrefs } from '@dsh-chamber/dsh-chamber-client-core/view-prefs'
import type { ShortcutsHook, SidebarRootComponentProps } from './contract/slots.ts'

export interface RenameTarget {
  sourceId: string
  kind: 'session' | 'workspace'
  id: string
  value: string
}

export interface SessionDragState {
  /** Source the drag started in — cross-source drops are structurally impossible. */
  sourceId: string
  accountKey: string
  /** 合成 ungrouped 桶标记：提交时按 id + flag 解析账目，避免真实工作区
   *  的 wire id 恰好等于 UNGROUPED_WORKSPACE_ID 时劫持桶拖拽的锚点。 */
  ungrouped: boolean
  sessionId: string
  over: { id: string; half: 'before' | 'after' } | null
}

export interface WorkspaceDragState {
  sourceId: string
  workspaceId: string
  over: { id: string; half: 'before' | 'after' } | null
}

export interface ServerDragState {
  sourceId: string
  over: { id: string; half: 'before' | 'after' } | null
}

export type DropOver = { id: string; half: 'before' | 'after' }

/** Per-element accent CSS var for the active source/session left inset: the
 *  remote source's hue, omitted for the local source (default-ink fallback). */
export function sourceAccentStyle(server: ChamberServerAggregate): { '--chamber-source-accent': string } | undefined {
  const color = sourceAccentColor(server.id)
  return color === undefined ? undefined : { '--chamber-source-accent': color }
}

/**
 * Resolver env for one source's workspace drag: display order (transient drag
 * override first, rows it does not know appended in registry order — a
 * workspace that appeared mid-drag stays a valid target), git-flag lookup and
 * repo-group-fold visibility. One rule set for the marker render, the
 * onDragOver gate, the drop handler and the commit — no drift between them.
 */
/**
 * 拖拽覆盖表 → 实际顺序的**唯一**规则，渲染序与 drop 环境序共用（两处不同序会把拖拽锚点算到
 * 旧行上）。覆盖表只描述拖拽那一刻存在的行；不在表里的 id 是其后新建的行，而宿主把新建的
 * workspace 插在序列头部（PREPEND）⇒ 按原序**前置**（否则新建/回声行先落表尾，位置意图的首帧
 * 锚点判定失败，要等下一提交才滑回锚点）。override 不存在时返回原序的副本。
 */
export function orderWithOverride<T>(
  items: readonly T[],
  override: readonly string[] | undefined,
  idOf: (item: T) => string,
): T[] {
  if (override === undefined) return [...items]
  const known = new Set(override)
  const placed = new Set<string>()
  const ordered: T[] = []
  for (const item of items) {
    const id = idOf(item)
    if (known.has(id)) continue
    ordered.push(item)
    placed.add(id)
  }
  for (const id of override) {
    if (placed.has(id)) continue
    const item = items.find(candidate => idOf(candidate) === id)
    if (item === undefined) continue
    ordered.push(item)
    placed.add(id)
  }
  for (const item of items) if (!placed.has(idOf(item))) ordered.push(item)
  return ordered
}

export function workspaceDropEnv(
  sourceId: string,
  realWorkspaceIds: readonly string[],
  override: readonly string[] | undefined,
  folded: Readonly<Record<string, boolean>>,
): WorkspaceDropEnv {
  const realSet = new Set(realWorkspaceIds)
  const order = orderWithOverride(realWorkspaceIds, override, id => id)
  return {
    order,
    flag: id => getWorkspaceGitFlag(sourceId, id),
    hidden: id => {
      const flag = getWorkspaceGitFlag(sourceId, id)
      const mainId = flag?.mainWorkspaceId
      if (mainId === undefined) return false
      return hiddenByMainWorkspaceFold(flag, folded[`${sourceId}/${mainId}`] === true, realSet.has(mainId))
    },
  }
}

export interface SidebarSectionContextValue {
  wide: boolean
  t: SidebarRootComponentProps['t']
  /** The instance id this ctx's shell belongs to (active-view highlight gate). */
  chamberInstanceId: string | undefined
  /** The page shortcut catalog bound as a selector hook (`hooks.shortcuts`): every
   *  row-level affordance selects its own command row for the tooltip keycap and
   *  `aria-keyshortcuts`, exactly as upstream threads `useShortcuts` down. */
  useShortcuts: ShortcutsHook
  /** The chamber Git plugin's per-workspace seat (slot inject). */
  renderWorkspaceGit: (
    key: 'sidebar.workspace.git',
    owner: { wide: boolean },
    opts: { hookContext: { sourceId: string; workspaceId: string; repoKey?: string } },
  ) => ReactNode
  /** chamber patch 13: the two session-row seats this shell declares (the leading
   *  status seat and the hover-card seat) rendered with the official occurrence
   *  share. `opts.fallback` renders when no occupant elects, so the shell's own
   *  Schedule mark is the fallback and can never double with an occupant. */
  renderSessionSeat: (
    key: 'sidebar.session.row.leading' | 'sidebar.session.row.hover',
    owner: { sessionId: string },
    opts?: { fallback?: ReactNode },
  ) => ReactNode

  viewPrefs: ChamberSidebarViewPrefs
  toggleWorkspaceFold: (serverId: string, workspaceId: string) => void
  toggleSourceFold: (serverId: string) => void
  setOrderBy: (server: ChamberServerAggregate, mode: SessionOrderBy) => void
  /** Transient optimistic drag overrides (render over the projection). */
  sessionOrderOverride: Readonly<Record<string, string[]>>
  workspaceOrderOverride: Readonly<Record<string, string[]>>

  sessionDrag: SessionDragState | null
  setSessionDrag: Dispatch<SetStateAction<SessionDragState | null>>
  workspaceDrag: WorkspaceDragState | null
  setWorkspaceDrag: Dispatch<SetStateAction<WorkspaceDragState | null>>
  serverDrag: ServerDragState | null
  setServerDrag: Dispatch<SetStateAction<ServerDragState | null>>
  commitSessionDrag: (server: ChamberServerAggregate, drag: SessionDragState, over: DropOver) => void
  commitWorkspaceDrag: (server: ChamberServerAggregate, drag: WorkspaceDragState, over: DropOver) => void
  commitServerDrag: (drag: ServerDragState, over: DropOver) => void
  /** Drag-end trailing-click suppression + drag-initiation guards (shared refs). */
  suppressClickRef: MutableRefObject<boolean>
  dragPressOnButtonRef: MutableRefObject<boolean>
  sessionDropCommitted: MutableRefObject<boolean>
  workspaceDropCommitted: MutableRefObject<boolean>
  serverDropCommitted: MutableRefObject<boolean>
  ghostExpiry: MutableRefObject<Map<string, number>>
  armBlankGhostForClick: () => void

  rowErrors: Readonly<Record<string, string>>
  menuOpen: Readonly<Record<string, boolean>>
  toggleMenu: (key: string) => void
  closeMenu: (key: string) => void
  sortMenuOpen: string | null
  setSortMenuOpen: Dispatch<SetStateAction<string | null>>
  renaming: RenameTarget | null
  setRenaming: Dispatch<SetStateAction<RenameTarget | null>>
  /** Commit the active inline rename (wire call via the shell's runAction). */
  commitRename: () => void
  /** Server-row archive-cleanup entry: opens the archive manager dialog
   *  (per-row / multi-select purges; whole-set deletion only through the
   *  explicit select-all checkbox — no standalone delete-all). */
  onOpenArchiveCleanup: (server: ChamberServerAggregate) => void
  /** Source-header add-workspace entry (opens the directory browser). This is
   *  the shell's GUARDED opener, not the raw setter — it refuses while another
   *  chamber dialog layer is up, so the section cannot stack a second Modal by
   *  calling it; closing stays the shell's own business (`browseClose`). */
  openWorkspaceBrowser: (sourceId: string) => void

  openSession: (serverId: string, sessionId: string) => void
  onNewSession: (server: ChamberServerAggregate, workspaceId: string) => void
  onArchiveSession: (server: ChamberServerAggregate, sessionId: string, displayTitle: string) => void
  onForkSession: (server: ChamberServerAggregate, session: { id: string; title: string }) => void
  onDeleteWorkspace: (server: ChamberServerAggregate, workspaceId: string, title: string) => void
}

/** @internal — provided by SidebarRoot; sections consume via useSidebarSection. */
export const SidebarSectionContext = createContext<SidebarSectionContextValue | undefined>(undefined)

/** Read the shell-provided cross-cutting state (throw = misuse outside the tree). */
export function useSidebarSection(): SidebarSectionContextValue {
  const value = useContext(SidebarSectionContext)
  if (value === undefined) {
    throw new Error('useSidebarSection outside SidebarSectionContext')
  }
  return value
}
