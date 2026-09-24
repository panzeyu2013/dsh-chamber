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
import type { SidebarRootComponentProps } from './contract/slots.ts'

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
export function workspaceDropEnv(
  sourceId: string,
  realWorkspaceIds: readonly string[],
  override: readonly string[] | undefined,
  folded: Readonly<Record<string, boolean>>,
): WorkspaceDropEnv {
  const realSet = new Set(realWorkspaceIds)
  const order = override === undefined
    ? [...realWorkspaceIds]
    : [
        ...override.filter(id => realSet.has(id)),
        ...realWorkspaceIds.filter(id => !override.includes(id)),
      ]
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
  /** The chamber Git plugin's per-workspace seat (slot inject). */
  renderWorkspaceGit: (
    key: 'sidebar.workspace.git',
    owner: { wide: boolean },
    opts: { hookContext: { sourceId: string; workspaceId: string; repoKey?: string } },
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
  onArchiveSession: (server: ChamberServerAggregate, sessionId: string) => void
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
