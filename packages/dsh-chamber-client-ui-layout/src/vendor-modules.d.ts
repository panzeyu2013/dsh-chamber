/**
 * Ambient typing for the dsh workspace packages this package composes
 * against (design 06 — the chamber ui-layout fork; the renderer compiles the
 * real vendor source via vite aliases, see packages/renderer/vite.config.mjs).
 * The vendor packages are excluded from the repository typecheck (root
 * tsconfig excludes vendor/), and their built type outputs do not exist in
 * the source-only vendor tree, so each dsh specifier this package imports —
 * including the vendor `./src/*` deep subpaths (AppFrame, service, columns,
 * theme-presenter) — is declared loosely here (mirroring
 * packages/dsh-chamber-client-ui-sidebar/src/vendor-modules.d.ts). The
 * fork's own code stays fully checked; the loose faces are the dsh seam.
 *
 * Baseline: `dsh-v0.1.5-rc.1` — the vendor columns face is the
 * rightbar/root-scope model, and the vendor service face is
 * `LayoutController(panels, hasMainPanel)` with `selectPanel`/`beginNavigation`.
 *
 * Deliberately NO package.json dependency on @deepseek-ai/dsh-client-ui-layout
 * (the official package this fork replaces): a declared peer/dep would link
 * the real vendor source into this package's node_modules and pull it into
 * the tsc program, defeating the ambient shadow above (the vendor source
 * fails under this package's strict config). The fork consumes the official
 * frame purely as these ambient deep-path faces; the renderer compiles the
 * real source via vite aliases.
 *
 * No top-level imports: a top-level import would turn this file into a module
 * and demote every `declare module` below to an augmentation of a module that
 * does not exist here. Types are referenced through inline `import(...)`.
 */

declare module '@deepseek-ai/cordis' {
  /**
   * Loose minimal shape (the fork consumes ctx through the cordis Context
   * face; index.ts augments it with ctx.layout). The structured members
   * mirror the face the deleted runtime ClientContext provided so the
   * vendor-copied client index typechecks verbatim; anything else falls
   * through the index signature.
   */
  interface Context {
    effect(fn: () => (() => void) | void, label?: string): void
    reflect: { provide(name: string, value: unknown): () => void }
    slots: {
      register(options: any, component: any): () => void
      entries(slot: string): Array<{ options: { key?: string } }>
      subscribe(slot: string, listener: () => void): () => void
      /** Root standard sources (vendor `RootStandardSourceContribution`):
       *  hooks become `use<Name>` props, `props` are copied verbatim into every
       *  scope's standard props, keyedHooks become keyed selector hooks. */
      provideRoot(contribution: {
        hooks?: Record<string, unknown>
        keyedHooks?: Record<string, unknown>
        props?: Record<string, unknown>
      }): () => void
    }
    on(event: string, listener: (snapshot: any) => void): () => void
    theme: { getTheme(): any }
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-store' {
  /**
   * Store contract + engine faces (mirrors `@deepseek-ai/dsh-client-store`
   * src/contract.ts + src/index.ts — the engine-extended handle/instance
   * subtypes the fork's stores.ts / store-core.ts consume). Names and
   * signatures are preserved from the deleted runtime face.
   */
  /** Store action declaration table (mirrors the store contract's ActionsDecl). */
  export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>
  /** The engine-backed store instance (loose mirror of the store engine's EngineStoreInstance). */
  export interface EngineStoreInstance<T, A extends ActionsDecl<T>> {
    readonly actions: {
      [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
    }
    getSnapshot(): T
    subscribe(fn: () => void): () => void
    /** The underlying engine store (framework/test API; the fork adopts widths through it). */
    readonly store: {
      update(mutator: (draft: T) => void): void
      set(next: T): void
      getSnapshot(): T
      subscribe(fn: () => void): () => void
    }
    clearPersisted(): void
  }
  /** The engine-backed store handle: create() narrowed to the engine instance. */
  export interface EngineStoreHandle<T, A extends ActionsDecl<T>> {
    readonly spec: { init: () => T; persist?: string; actions: A }
    create(scopeKey?: string): EngineStoreInstance<T, A>
  }
  /** Declare a store: initial state, optional persistence, and the full write set as draft mutators. */
  export function defineStore<T, A extends ActionsDecl<T>>(
    decl: { init: () => T; persist?: string; actions: A & ActionsDecl<T> },
  ): EngineStoreHandle<T, A>
}

declare module '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-renderer/client'

declare module '@deepseek-ai/dsh-client-ui-session/client'

declare module '@deepseek-ai/dsh-client-ui-theme/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Slot map (the fork's client/index.ts augments with the layout holes). */
  export interface SlotMap {}
  /** Global standard props table (the fork augments it with `usePanelInfo`
   *  and the chamber `chamberFileApiBase` prop). */
  export interface GlobalStandardProps {}
  /** Bare observable source bound to a `use<Name>` hook by the renderer. */
  export interface HostObservable<Snapshot> {
    getSnapshot(): Snapshot
    subscribe(listener: () => void): () => void
  }
  /** Selector hook over one observable source. */
  export type SnapshotSelectorHook<Snapshot> = <Selected>(selector: (snapshot: Snapshot) => Selected) => Selected
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts' {
  /** Contract-frozen column geometry (mirrors the vendor columns.ts constants). */
  export const CENTER_MIN: number
  export const SIDEBAR_MIN: number
  export const SIDEBAR_MAX: number
  export const SIDEBAR_DEFAULT: number
  export const SIDEBAR_COLLAPSED: number
  export const SIDEBAR_AUTO_COLLAPSE: number
  export const RIGHTBAR_MIN: number
  export const RIGHTBAR_MAX_RATIO: number
  export const RIGHTBAR_DEFAULT_RATIO: number
  export function clampWidth(px: number, min: number, max: number): number
  export function computeColumns(
    viewport: number,
    sidebar: number,
    rightbar: number,
  ): { sidebar: number; center: number; rightbar: number }
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx' {
  /** The vendor three-column shell frame (loose face — the vendor shape is the source of truth). */
  export const AppFrame: (props: any) => any
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts' {
  /** Identity shared by a sidebar panel entry and its main-slot occupant. */
  export type MainPanelId = string & { readonly __brand?: 'MainPanelId' }
  /** Root-scoped navigation state exposed to panel-aware components. */
  export interface PanelInfo {
    readonly activePanelId: MainPanelId | null
  }
  /** The outward layout face (`ctx.layout`): panel transitions other plugins may trigger. */
  export interface ILayout {
    selectPanel(panelId: MainPanelId | null): void
    beginNavigation(): AbortSignal
    toggleSidebar(): void
    openRightbar(track: boolean, fullscreen: boolean): void
    closeRightbar(): void
  }
  /** Cross-plugin panel-action face (loose face — the vendor shape is the source of truth). */
  export class LayoutController implements ILayout {
    constructor(panels: any, hasMainPanel: (id: MainPanelId) => boolean)
    dispose(): void
    selectPanel(panelId: MainPanelId | null): void
    beginNavigation(): AbortSignal
    toggleSidebar(): void
    openRightbar(track: boolean, fullscreen: boolean): void
    closeRightbar(): void
  }
  /** The layout store's bound action set (loose). */
  export type PanelActions = any
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/theme-presenter.ts' {
  /** Applies theme snapshots to the document (loose face — the vendor shape is the source of truth). */
  export class ThemePresenter {
    apply(snapshot: any): void
    dispose(): void
  }
}
