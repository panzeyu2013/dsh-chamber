/**
 * Cross-cutting state for one sidebar shell's per-source sections: the shell
 * (SidebarRoot) owns every store/effect/commit below and provides ONE context
 * value per render; each ServerSection (and the workspace groups / session
 * rows inside it) reads what it needs through useSidebarSection(). Keeping
 * the value in a context (instead of threading ~40 props through three
 * component levels) is what lets the giant shell split into per-source files.
 * Nothing here is a store — the shell re-renders and rebuilds the value.
 */
import { createContext, useContext, type Dispatch, type MutableRefObject, type ReactNode, type SetStateAction } from 'react'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { sourceAccentColor, type SessionOrderBy } from '../shared/derive.ts'
import type { WorkspaceDropEnv } from '../shared/workspace-drag-order.ts'
import { getWorkspaceGitFlag, hiddenByMainWorkspaceFold } from '../shared/workspace-git-flags.ts'
import type { ChamberSidebarViewPrefs } from '../shared/view-prefs.ts'
import type { SidebarRootComponentProps } from './contract/slots.ts'

/** In-progress inline rename target. */
export interface RenameTarget {
  sourceId: string
  kind: 'session' | 'workspace'
  id: string
  value: string
}

/** In-flight session-row drag: source identity plus the current insert marker (06 §2.2). */
export interface SessionDragState {
  /** Source the drag started in — cross-source drops are structurally impossible. */
  sourceId: string
  /** Workspace id, or the ungrouped bucket id for the source-local loose-session account. */
  accountKey: string
  /** Whether the row's workspace is the synthetic ungrouped bucket (carried in
   *  the drag state so the commit resolves the account by id + flag — a real
   *  workspace whose wire id ever equaled UNGROUPED_WORKSPACE_ID could
   *  otherwise hijack a bucket drag's anchor). */
  ungrouped: boolean
  sessionId: string
  /** Row the marker sits on and which half (insert above/below it). */
  over: { id: string; half: 'before' | 'after' } | null
}

/** In-flight real-workspace drag: source identity plus the current marker (06 §2.2). */
export interface WorkspaceDragState {
  sourceId: string
  workspaceId: string
  over: { id: string; half: 'before' | 'after' } | null
}

/** In-flight server-group drag (06 §2.4): dragged source + marker. */
export interface ServerDragState {
  sourceId: string
  over: { id: string; half: 'before' | 'after' } | null
}

export type DropOver = { id: string; half: 'before' | 'after' }

/**
 * Per-element accent CSS variable for the active source/session left inset:
 * the remote source's hue string, omitted for the local source so the CSS
 * falls back to the default ink (visual audit P2-3).
 */
export function sourceAccentStyle(server: ChamberServerAggregate): { '--dsh-source-accent': string } | undefined {
  const color = sourceAccentColor(server.id)
  return color === undefined ? undefined : { '--dsh-source-accent': color }
}

/**
 * Build the resolver environment for one source's workspace drag: the real
 * workspace order in display form (transient drag override first, rows the
 * override does not know appended in registry order — a workspace that
 * appeared mid-drag stays a valid target), the git-flag lookup and the
 * repo-group-fold visibility verdict. Consumed identically by the marker
 * render, the onDragOver gate, the drop handler and the commit — one rule
 * set (shared/workspace-drag-order.ts), no drift between them.
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
  /** Wide column geometry (server sections only render wide content). */
  wide: boolean
  /** Locale translate (the sidebar namespace). */
  t: SidebarRootComponentProps['t']
  /** The instance id this ctx's shell belongs to (active-view highlight gate). */
  chamberInstanceId: string | undefined
  /** The chamber Git plugin's per-workspace seat (slot inject). */
  renderWorkspaceGit: (
    key: 'sidebar.workspace.git',
    owner: { wide: boolean },
    opts: { hookContext: { sourceId: string; workspaceId: string; repoKey?: string } },
  ) => ReactNode

  /** Shared view prefs snapshot + fold/order toggles. */
  viewPrefs: ChamberSidebarViewPrefs
  toggleWorkspaceFold: (serverId: string, workspaceId: string) => void
  toggleSourceFold: (serverId: string) => void
  setOrderBy: (server: ChamberServerAggregate, mode: SessionOrderBy) => void
  /** Transient optimistic drag overrides (render over the projection). */
  sessionOrderOverride: Readonly<Record<string, string[]>>
  workspaceOrderOverride: Readonly<Record<string, string[]>>

  /** Drag state machines (owned by the shell; sections read + update them). */
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
  /** Blank-row ghost slot machinery (double-click window layout guard). */
  ghostExpiry: MutableRefObject<Map<string, number>>
  armBlankGhostForClick: () => void

  /** Per-row error text (actions run through the shell's local runAction). */
  rowErrors: Readonly<Record<string, string>>
  /** Open kebab menus (keyed by row). */
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
   *  (design 24 §6 revision 2026-09 — the manager lists what is archived and
   *  offers per-row / multi-select purges; whole-set deletion goes through
   *  the explicit select-all checkbox — no standalone delete-all). */
  onOpenArchiveCleanup: (server: ChamberServerAggregate) => void
  /** Source-header add-workspace entry (opens the directory browser). */
  setAddingWorkspace: Dispatch<SetStateAction<string | null>>

  /** Row actions over the source's own unary API. */
  openSession: (serverId: string, sessionId: string) => void
  onNewSession: (server: ChamberServerAggregate, workspaceId: string) => void
  onArchiveSession: (server: ChamberServerAggregate, sessionId: string, title: string) => void
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
