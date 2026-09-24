/**
 * Sidebar slot contract: the registrant-side props composition for the
 * layout-owned `sidebar` slot, plus the holes this shell declares. The shell
 * owns column geometry (fold state machine, brand row, New Session) and — as a
 * chamber patch — the multi-source session/workspace list in the browsing
 * region: every source's sessions render equal in one list, grouped by source
 * only, so the region is not the `sidebar.workspaces` registrant's anymore. The
 * hole stays declared (declaring is claiming) so ui-workspace's registration
 * cannot fail, but the shell never calls it. The foot is `sidebar.settings`
 * (ui-settings) followed by optional `sidebar.footer.action`.
 */
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-layout's SlotMap merge so PropsRuntime<'sidebar'> resolves.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { Translate } from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Brand mark at the sidebar's top-left; the shell supplies the chamber wordmark fallback. */
    'sidebar.brand.mark': { kind: 'single'; scope: 'root'; owner: SidebarBrandMarkOwnerProps }
    /** Brand name beside the expanded mark; the shell supplies a generic text fallback. */
    'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: SidebarBrandNameOwnerProps }
    /** Global panel icons: each list id addresses the matching main panel key;
     *  the shell owns the button, resolves its label from list metadata, then
     *  asks `ctx.layout.selectPanel(id)`. */
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }
    /** The workspace/session browsing region: declared by this package's
     *  'sidebar' entry, so ui-workspace may register without error, but the
     *  chamber shell renders its own multi-source list and never calls the hole. */
    'sidebar.workspaces': {
      kind: 'single'; scope: 'root'
      /** Kept for wire compatibility with the official declaration (chamber renders no occupant). */
      owner: { wide: boolean; expandSidebar: () => void }
    }
    /**
     * Per-workspace Git occupant rendered inside every workspace group. The
     * sidebar stays git-type-free: it renders the hole once per workspace with
     * an opaque occurrence context (the workspace identity rides `hookContext`),
     * and the Git plugin occupies it with the branch/create/remove line; non-git
     * workspaces get an empty mount. The contextual hook factory lives in this
     * slot's `inject` — only slot injects bind factories with the occurrence
     * context; the factory stays git-agnostic.
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
    /** The settings seat at the sidebar foot: ui-settings registers its trigger
     *  row + modal panel; the sidebar passes only its column state. */
    'sidebar.settings': { kind: 'single'; scope: 'root'; owner: SidebarSettingsOwnerProps }
    /** Optional actions beside Settings at the foot; each receives only the
     *  column state. */
    'sidebar.footer.action': { kind: 'list'; scope: 'root'; owner: SidebarFooterActionOwnerProps }
  }
}

export interface SidebarBrandMarkOwnerProps {
  /** Requested square edge in pixels. */
  size: number
}

export interface SidebarBrandNameOwnerProps {
  /** Marker field: the occupant owns its own content and width. */
  children?: never
}

export interface SidebarPanelIconOwnerProps {
  size: number
  /** Whether this panel is selected in the main column. */
  active: boolean
}

/** Serializable metadata for one active global panel list registration. */
export interface SidebarPanelMetadata {
  /** List id and matching main panel key. */
  id: MainPanelId
  /** Ascending row order; ties retain registration order. */
  order: number
  /** Row title and accessible name: resolved label, or the id when omitted. */
  label: string
}

/** Owner share of the settings seat: the column display state the trigger row renders against. */
export interface SidebarSettingsOwnerProps {
  /** Whether the sidebar renders wide content (false = 56px rail). */
  wide: boolean
}

/** Owner share of the per-workspace Git occupant: the workspace identity rides
 *  the slot's `hookContext`, so this carries only the column state. */
export interface SidebarWorkspaceGitOwnerProps {
  /** Whether the sidebar renders wide content; the occupant hides on the rail. */
  wide: boolean
}

export interface SidebarFooterActionOwnerProps {
  wide: boolean
}

/** Registrant-private injected share (via the register inject factory): the
 *  shell's own controls — New Session, column toggle, panel selection — plus
 *  the chamber instance id for the active-source highlight. */
export type SidebarRootInjected = {
  /** Start a New Session: with a workspace, reuse-or-create its blank session
   *  and open it; without one, inherit the current Session Workspace, then the
   *  recent Workspace, else clear into the pure New Session view. */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Toggle the sidebar column through the layout service. */
  toggleSidebar: () => void
  /** Select the global panel addressed by a sidebar row. */
  selectPanel: (id: MainPanelId) => void
  /** Private reactive sources bound to framework selector hooks. */
  hooks: { panels: HostObservable<readonly SidebarPanelMetadata[]> }
  /** chamber: the immutable per-entry instance id this ctx's shell belongs to
   *  (installed by AppWebEntry.configureContext); the list highlights it. */
  chamberInstanceId?: string
  /** chamber: the directory-browser dialog's copy (`directory-browser` namespace,
   *  mounted by every boot); the wire calls come from each source's own ctx. */
  directoryBrowserT: Translate
}

/** Full component props: layout owner state/actions, the declared holes' render
 *  shares, this package's injected callbacks and the locale seat. */
export type SidebarRootComponentProps =
  PropsRuntime<'sidebar'>
  & PropsRenderSlots<
    | 'sidebar.brand.mark'
    | 'sidebar.brand.name'
    | 'sidebar.panellist'
    | 'sidebar.workspaces'
    | 'sidebar.workspace.git'
    | 'sidebar.settings'
    | 'sidebar.footer.action'
  >
  & InjectFace<SidebarRootInjected> & PropsLocale<'sidebar'>
