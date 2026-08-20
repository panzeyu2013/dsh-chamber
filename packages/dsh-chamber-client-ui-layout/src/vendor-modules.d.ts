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
  /** Loose minimal shape (the fork consumes ctx through the runtime's ClientContext face). */
  interface Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  /**
   * Root context of a booted dsh shell (loose structural face — enough shape
   * for the vendor-copied client index to typecheck verbatim: ctx.effect /
   * ctx.reflect.provide / ctx.slots.register / ctx.on / ctx.theme; anything
   * else falls through the index signature).
   */
  export type ClientContext = {
    effect(fn: () => (() => void) | void, label?: string): void
    reflect: { provide(name: string, value: unknown): () => void }
    slots: { register(options: any, component: any): () => void }
    on(event: string, listener: (snapshot: any) => void): () => void
    theme: { getTheme(): any }
    [key: string]: any
  }
  /** Store action declaration table (mirrors ui-slots' ActionsDecl). */
  export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>
  /** The engine-backed store instance (loose mirror of the runtime contract/store.ts face). */
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

declare module '@deepseek-ai/dsh-client-ui-theme/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Slot map (the fork's client/index.ts augments with the layout holes). */
  export interface SlotMap {}
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts' {
  /** Contract-frozen column geometry (mirrors the vendor columns.ts constants). */
  export const CENTER_MIN: number
  export const SIDEBAR_MIN: number
  export const SIDEBAR_MAX: number
  export const SIDEBAR_DEFAULT: number
  export const SIDEBAR_COLLAPSED: number
  export const SIDEBAR_AUTO_COLLAPSE: number
  export const DETAILS_MIN: number
  export const DETAILS_MAX: number
  export const DETAILS_DEFAULT: number
  export function clampWidth(px: number, min: number, max: number): number
  export function computeColumns(
    viewport: number,
    sidebar: number,
    details: number,
  ): { sidebar: number; center: number; details: number }
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx' {
  /** The vendor three-column shell frame (loose face — the vendor shape is the source of truth). */
  export const AppFrame: (props: any) => any
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts' {
  /** The outward layout face (`ctx.layout`): panel transitions other plugins may trigger. */
  export interface ILayout {
    toggleSidebar(): void
    openDetails(): void
    closeDetails(): void
  }
  /** Cross-plugin panel-action face (loose face — the vendor shape is the source of truth). */
  export class LayoutController implements ILayout {
    attachPanels(actions: any): void
    toggleSidebar(): void
    openDetails(): void
    closeDetails(): void
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
