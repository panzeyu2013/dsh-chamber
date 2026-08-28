/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot, plus the holes this shell declares. The shell
 * owns column geometry (fold state machine, brand row, New Session) and —
 * chamber patch (design 05 §2) — the multi-source session/workspace list in
 * the browsing region: every source's sessions render equal in one list,
 * grouped by source only; the region is NOT the `sidebar.workspaces`
 * registrant's anymore. The hole stays declared (declaring is claiming):
 * ui-workspace's registration must not fail, but the chamber shell renders
 * its own chamber list instead. The foot is the `sidebar.settings`
 * registrant's (ui-settings), followed by optional footer actions in
 * `sidebar.footer.action`.
 */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge (the 'sidebar' entry) into every
// program that sees this contract, so PropsRuntime<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The workspace/session browsing region. Declared by this package's
     * 'sidebar' entry (declaring is claiming); ui-workspace may register a
     * browser here without error, but the chamber shell renders its own
     * multi-source session list instead (05 §2) and never calls this hole.
     */
    'sidebar.workspaces': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }
    /**
     * Per-workspace Git occupant rendered inside every workspace group of the
     * browsing region (workspace-centric discovery, design 08 §11). The
     * sidebar stays git-type-free: it renders the hole once per workspace
     * with an opaque occurrence context, and the chamber Git plugin occupies
     * it with the workspace's branch/create/remove line. Non-git workspaces
     * get an empty mount (the occupant returns null). The workspace identity
     * rides the slot-level `hookContext`; the contextual hook factory lives
     * in this slot's `inject` (the vendored contextual-hook seam — entry
     * injects bind hooks as observables, only slot injects bind factories
     * with the occurrence context). The factory is git-agnostic (it only
     * closes over the sidebar-owned context) and is provided in the owner's
     * children table.
     */
    'sidebar.workspace.git': {
      kind: 'single',
      scope: 'root',
      owner: SidebarWorkspaceGitOwnerProps,
      hookContext: { sourceId: string; workspaceId: string; repoKey?: string },
      inject: {
        hooks: {
          workspaceGitContext: (
            _standard: object,
            context: { sourceId: string; workspaceId: string; repoKey?: string },
          ) => () => ({ sourceId: string; workspaceId: string; repoKey?: string }),
        },
      },
    }
    /**
     * The settings seat at the sidebar foot. Declared by this package's
     * 'sidebar' entry; ui-settings registers its trigger row + modal panel.
     * The sidebar passes only its column state — it holds no settings state.
     */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    /**
     * Optional actions beside Settings at the sidebar foot. Declared by this
     * package's 'sidebar' entry; each action receives only the column state.
     */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

/**
 * Owner share of the browser hole — kept for wire compatibility with the
 * official declaration (chamber renders no occupant here).
 */
export interface SidebarSectionOwnerProps {
  /** Shell fold-state output: wide renders the full browser, rail the icon column. */
  wide: boolean
  /** Rail icons request expansion; the browser rides the wide flip for focus. */
  expandSidebar: () => void
}

/**
 * Owner share of the sidebar settings seat: the column display state the
 * occupant's trigger row must render against (wide row vs rail icon).
 */
export interface SidebarSettingsOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Owner share of the per-workspace Git occupant. The workspace identity rides
 * the slot's `hookContext` (one occurrence per workspace group); the owner
 * share carries only the column state.
 */
export interface SidebarWorkspaceGitOwnerProps {
  /** Whether the sidebar renders wide content; the occupant hides on the rail. */
  wide: boolean
}

/** Owner share of an action rendered beside Settings at the sidebar foot. */
export interface SidebarFooterActionOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/**
 * Registrant-private injected share (arrives via the register inject
 * factory). The shell keeps only its own controls: starting a Session from
 * the New Session button, toggling the column, and — chamber patch (05 §4) —
 * the current instance id for the active-source highlight.
 */
export type SidebarRootInjected = {
  /**
   * Start a New Session: with a workspace, reuse-or-create its blank session
   * and open it; without one, inherit the current Session Workspace, then the
   * recent Workspace, or clear into the New Session pure view when none exist.
   */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
  /**
   * chamber: the immutable instance id provided on this shell entry's Cordis
   * root context. The multi-source list highlights this source.
   */
  chamberInstanceId?: string
  /**
   * chamber (05 §4): the directory-browser dialog's copy (`directory-browser`
   * namespace, registered by the browse directory-picker package — every boot
   * mounts that surface). The add-workspace dialog binds the per-source wire
   * calls itself; only the copy comes from the ctx.
   */
  directoryBrowserT: Translate
}

/**
 * Full component props: layout owner state/actions plus the declared holes'
 * render shares, this package's injected callbacks, and the standard locale
 * seat. No store is registered.
 */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<'sidebar.workspaces' | 'sidebar.workspace.git' | 'sidebar.settings' | 'sidebar.footer.action'>
  & SidebarRootInjected & PropsLocale<'sidebar'>
