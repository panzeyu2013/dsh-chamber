/**
 * Chamber remote-browser plugin dsh seam. Loose vendor faces: the repo-level
 * union in types/vendor-modules.d.ts.
 *
 * This package is a faithful fork of upstream
 * `@deepseek-ai/dsh-client-ui-sidebar-browser` 0.2.2-rc.1 client sources. The
 * repo-level ambient union predates that fork, so the handful of upstream
 * imports it does not declare yet are declared/augmented here — package-local,
 * exactly the loose-face convention the reference file documents.
 */
/// <reference path="../../../types/vendor-modules.d.ts" />

/** Upstream ui-sidebar-right client extension face (tab type + params map + tab actions). */
declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  /** Params a page kind accepts from `openTab` (each tab plugin merges its kind). */
  export interface SidebarRightTabParamsMap {}
  /** Where a tab was last navigated to. */
  export interface SidebarRightTabNavigation {
    address: string
    params: unknown
    revision: number
  }
  /** One guide-page entry contributed by the type it opens. */
  export interface SidebarRightGuideEntry {
    id: string
    order: number
    title: () => string
    description?: () => string
    commandId?: string
    icon?: unknown
  }
  /** One registered tab type (static face; the body is the keyed slot registration). */
  export interface SidebarRightTabDefinition {
    id: string
    kind: string
    multiple?: boolean
    keepMounted?: boolean
    priority?: 'extension' | 'builtin' | 'fallback'
    title: (address: string) => string
    guide?: readonly SidebarRightGuideEntry[]
  }
  /** The actions one tab may take on itself. */
  export interface SidebarRightTabActions {
    bindCommands(commands: { refresh?: () => void }): () => void
    openTab(kind: string, options?: unknown): void
    openResource(address: string, options?: unknown): void
    close(): void
  }
}

/** Dock-kit tab id (the repo union declares the module shorthand only). */
declare module '@deepseek-ai/dsh-client-ui-dockkit' {
  export type TabId = string
}

/** `TranslateNS` (upstream locale client face); the repo union only declares `Translate`. */
declare module '@deepseek-ai/dsh-client-locale/client' {
  export type TranslateNS<N extends string> = (key: string, params?: Record<string, unknown>) => string
}

/** `BoundActions` (upstream store face); the repo union declares the handle/instance halves. */
declare module '@deepseek-ai/dsh-client-store' {
  export type BoundActions<H> = any
}

/** `PropsStore` (upstream ui-slots component face: the store seat's useStore/actions). */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type PropsStore<H> = {
    useStore: <S>(selector: (state: any) => S, equal?: (a: S, b: S) => boolean) => S
    actions: any
  }
}

/** Icons/artwork the upstream Browser view imports (the repo union predates them). */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const IconGlobeOutlineRegular: (props?: any) => any
  export const IconChevronLeftOutlineRegular: (props?: any) => any
  export const IconRightUpOutlineRegular: (props?: any) => any
  export const GuideArtworkBrowser: (props?: any) => any
  export const SHIELD_OUTLINE_PATH: string
  export const ICON_REGULAR_STROKE: number
}
