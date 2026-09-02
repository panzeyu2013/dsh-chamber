/**
 * Ambient typing for the dsh workspace packages this package bundles (design
 * 05 §2: the renderer compiles workspace source via vite aliases — see
 * packages/renderer/vite.config.mjs). The vendor packages are excluded from
 * the repository typecheck (root tsconfig excludes vendor/), and their built
 * type outputs do not exist in the source-only vendor tree, so each dsh
 * specifier the sidebar imports is declared loosely here (mirroring
 * packages/renderer/src/vendor-modules.d.ts). The sidebar's own code stays
 * fully checked; the loose faces are the dsh seam.
 *
 * No top-level imports: a top-level import would turn this file into a module
 * and demote every `declare module` below to an augmentation of a module that
 * does not exist here. Types are referenced through inline `import(...)`.
 */

declare module '@deepseek-ai/cordis' {
  /** Loose minimal shape (the sidebar consumes ctx through the cordis Context face). */
  export class Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-invariants' {
  /** Package invariant installer (loose face). */
  export type InvariantInstaller = (ctx: any) => void | Promise<void>
}

declare module '@deepseek-ai/dsh-client-store' {
  /** Minimal observable snapshot source (contract.ts; the mounted ctx store faces). */
  export interface ObservableSnapshot<T> {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
  }
  export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  /** Session list row (client store SessionSummary face). */
  export interface SessionSummary {
    id: string
    title?: string
    displayTitle: string
    cwd?: string
    parentId?: string
    origin?: 'subagent'
    running: boolean
    completed?: boolean
    blank: boolean
    updatedAt: number
    projectionValues?: Readonly<Record<string, unknown>>
  }
  /** Session list store snapshot (client `ctx.sessions.list`). */
  export interface SessionListState {
    ids: readonly string[]
    byId: Readonly<Record<string, SessionSummary>>
    current?: string
    phase: 'pending' | 'ready'
  }
  /** Wire search-result page bound (SidebarRoot search copy). */
  export const SESSION_SEARCH_RESULT_LIMIT: number
}

declare module '@deepseek-ai/dsh-api-workspace-controller/client' {
  /** Workspace id brand (slots contract). */
  export type WorkspaceId = string
  /** One durable Workspace projected for browser consumers. */
  export interface WorkspaceView {
    workspaceId: WorkspaceId
    path: string
    title: string
    sessionIds: readonly string[]
    createdAt: string
    updatedAt: string
  }
  /** Client Workspace list snapshot (`ctx.workspaces.list`; no `baselinesReady` upstream). */
  export interface WorkspaceSnapshot {
    items: readonly WorkspaceView[]
    archivedSessionIds: readonly string[]
    state: 'idle' | 'loading' | 'error'
    phase: 'pending' | 'ready'
    error: unknown
  }
  /** Structured workspace-create failure (P2-18 check; unused by the sidebar, declared for the seam). */
  export class WorkspaceCreateError extends Error {
    readonly rpcError: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-workspace/src/client/navigation.ts' {
  /** Browse-capability business error (DirectoryBrowser renders rpcError.message). */
  export class DirectoryBrowseError extends Error {
    constructor(rpcError: { code: string; message: string; details?: unknown })
    readonly rpcError: { code: string; message: string; details?: unknown }
  }
}

declare module '@deepseek-ai/dsh-client-ui-workspace/src/client/subagent-lineage.ts' {
  /** Descendant counts for one possible parent Session. */
  export interface SubagentDescendantSummary {
    count: number
    runningCount: number
  }
  /** Vendor subagent-lineage aggregation (06 §4.5, running-subagent ring). */
  export function indexSubagentDescendants(
    summaries: Readonly<Record<string, {
      id: string
      origin?: 'subagent'
      parentId?: string
      running?: boolean
    }>>,
  ): ReadonlyMap<string, SubagentDescendantSummary>
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  /** Locale-bound translation function. */
  export type Translate = (key: string, params?: Record<string, string | number>) => string
}

declare module '@deepseek-ai/dsh-client-ui-renderer/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { ReactNode } from 'react'
  /** Locale-namespace map (index.ts augments with the sidebar keys). */
  export interface LocaleNamespaceMap {}
  /** Slot map (contract/slots.ts augments with the sidebar holes). */
  export interface SlotMap {}
  /** Locale seat the slot registrant receives. */
  export type PropsLocale<T extends string> = { t: import('@deepseek-ai/dsh-client-locale/client').Translate }
  /** The declared holes' render shares. */
  export type PropsRenderSlots<H extends string> = { renderSlot: (hole: H, props?: any) => ReactNode }
  /** Owner runtime share (collapsed/width etc. — loose). */
  export type PropsRuntime<N extends string> = Record<string, any>
}

declare module '@deepseek-ai/dsh-client-ui-layout/client'

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  /** Loose pending-interaction face (SessionPendingInteractionBase mirror; the
   *  official ui-workspace consumes the same registry via
   *  useSessionPendingInteraction). The sidebar reads only the observable
   *  pending map; the publish side stays ui-approval/ui-questions-owned. */
  export interface SessionPendingInteractionBase {
    readonly key: string
    /** Presentation discriminator: 'approval' | 'plan-review' | 'question' (unknown kinds stay invisible). */
    readonly kind: string
    readonly sessionId: string
  }
  /** Per-session effective pending interaction (precedence already resolved by the registry). */
  export type SessionPendingInteractionSnapshot = ReadonlyMap<string, SessionPendingInteractionBase>
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, ReactNode } from 'react'
  /** Sidebar shell icons/components (loose face). */
  export const BrandWordmark: (props: any) => ReactElement | null
  export const FishLogo: (props: any) => ReactElement | null
  export const Tooltip: (props: any) => ReactElement | null
  export const IconChevronRightOutline14: (props: any) => ReactElement | null
  export const IconCloseOutline16: (props: any) => ReactElement | null
  export const IconNewChatOutline16: (props: any) => ReactElement | null
  export const IconPanelLeftOutline16: (props: any) => ReactElement | null
  export const IconSearchOutline16: (props: any) => ReactElement | null
  export const IconEllipsisOutline16: (props: any) => ReactElement | null
  export const IconPlusOutline16: (props: any) => ReactElement | null
  export const IconEditOutline16: (props: any) => ReactElement | null
  export const IconTrashOutline16: (props: any) => ReactElement | null
  export const IconArchiveOutline20: (props: any) => ReactElement | null
  export const IconLoadingOutline16: (props: any) => ReactElement | null
  export const IconQuestionOutline14: (props: any) => ReactElement | null
  export const IconChecklistOutline14: (props: any) => ReactElement | null
  export const IconWarningOutline16: (props: any) => ReactElement | null
  /** Session fork (row menu, 06 §7): IconBranchOutline16 glyph. */
  export const IconBranchOutline16: (props: any) => ReactElement | null
  /** Per-source session sort toggle (06 §7): IconPersonalizationOutline16 glyph. */
  export const IconPersonalizationOutline16: (props: any) => ReactElement | null
  /** Workspace header folder glyph (08 §11 project-row parity). */
  export const IconFolderOpenOutline16: (props: any) => ReactElement | null
  /**
   * Delayed hover-preview card portaled to document.body (06 §7, official
   * ui-primitives HoverCard): `anchor` renders in place, `content` floats in
   * the card on hover dwell; `disabled` suppresses/close it; optional
   * copyText/copyLabel/copiedLabel make the card an activation-copy affordance.
   * Loose face (the vendor shape is the source of truth).
   */
  export const HoverCard: (props: any) => ReactElement | null
  /** Official dsh state dot: done/warning/ongoing/error (loose face). */
  export const StateDot: (props: any) => ReactElement | null
  /** Row action menu entry (row + optional icon/danger; loose face). */
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
    submenu?: readonly MenuItem[]
  }
  /** Row action dropdown (portal mode for the overflow-clipping sidebar). */
  export const Menu: (props: any) => ReactElement | null
}

declare module '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx' {
  import type { DirectoryListingRow } from '../shared/instance-api.ts'
  /**
   * The in-app workspace-directory browser (design 05 §4). Props mirror the
   * vendor component's contract; the browse calls ride the per-source unary
   * client (listHostDirectory / createHostDirectory).
   */
  export interface DirectoryBrowserProps {
    /** Dialog visibility (owner-local; closed unmounts nothing but resets on reopen). */
    open: boolean
    /** List one directory level (absent path = the Host home directory); the signal aborts a superseded scan. */
    listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListingRow>
    /** Create one child directory under an existing parent. */
    createDirectory: (path: string, name: string) => Promise<string>
    /** The operator confirmed a directory (the selection, else the listed level). */
    onOpen: (path: string) => void
    /** Close without picking (mask, Escape, Cancel). */
    onClose: () => void
    /** The owner's confirm is in flight: Open disables, the view freezes. */
    busy: boolean
    /** Localized copy. */
    t: import('@deepseek-ai/dsh-client-locale/client').Translate
  }
  /** The browse dialog component (loose face — the vendor shape is the source of truth). */
  export const DirectoryBrowser: (props: DirectoryBrowserProps) => import('react').ReactElement | null
}
