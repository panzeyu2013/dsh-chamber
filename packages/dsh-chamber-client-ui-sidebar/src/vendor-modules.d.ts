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
  /** Loose minimal shape (the sidebar consumes ctx through the runtime's ClientContext face). */
  export class Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-invariants' {
  /** Package invariant installer (loose face). */
  export type InvariantInstaller = (ctx: any) => void | Promise<void>
}

declare module '@deepseek-ai/dsh-client-connection/client' {
  /** The unary wire client base (instance-api.ts subclasses and overrides doFetch). */
  export class AbstractApiClient {
    [key: string]: any
    protected doFetch(input: URL, init?: RequestInit): Promise<Response>
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** Browse-capability business error (DirectoryBrowser renders rpcError.message). */
  export class DirectoryBrowseError extends Error {
    constructor(rpcError: { code: string; message: string; details?: unknown })
    readonly rpcError: { code: string; message: string; details?: unknown }
  }
  /** Root context of a booted dsh shell (loose face). */
  export type ClientContext = any
  /** Snapshot store (runtime facts report, 06 §4). */
  export type ObservableSnapshot<T> = {
    getSnapshot(): T
    subscribe(listener: () => void): () => void
  }
  /** Session list state (runtime facts report). */
  export type SessionListState = any
  /** Workspace id brand (slots contract). */
  export type WorkspaceId = string
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  /** Locale-bound translation function. */
  export type Translate = (key: string, params?: Record<string, string | number>) => string
}

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
