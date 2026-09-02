/**
 * Ambient typing for the dsh workspace packages this plugin consumes (family
 * convention — see packages/dsh-chamber-client-ui-sidebar/src/vendor-modules.d.ts).
 * The vendor tree is excluded from the repository typecheck, so every dsh
 * specifier is declared loosely here; the plugin's own code stays fully
 * checked. The chamber layout fork's `layoutFacts` face (design 17 §18) is
 * declared here as well — the mobile plugin does not import the fork's
 * source (it pulls AppFrame and friends), it consumes the per-ctx service
 * through the ambient Context face.
 *
 * No top-level imports (a top-level import would turn this file into a
 * module and demote every `declare module` below to an augmentation).
 */

declare module '@deepseek-ai/cordis' {
  /** Loose minimal shape (the plugin consumes ctx through the cordis Context face). */
  export class Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-locale' {
  /** Locale dictionary registration face (loose). */
  export interface LocaleService {
    register(namespace: string, dictionaries: { zh: Record<string, string>; en: Record<string, string> }): unknown
    bind(namespace: string): (key: string) => string
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  /** Client locale service (module augmentation target; no runtime values). */
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  /** Slot registration surface (loose). */
  export function register(entry: unknown, component: unknown): unknown
  export type PropsRuntime<Slot extends string> = {
    [Key in Slot]: unknown
  } & Record<string, unknown>
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  /** Client slots module augmentation target. */
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  /** Layout facts face (design 17 §18) — provided per-ctx by the chamber
   *  layout fork. */
  export interface LayoutFacts {
    getLayoutSnapshot(): LayoutState
    subscribeLayout(listener: () => void): () => void
  }
  export interface LayoutState {
    sidebar: number
    details: number
    narrow: boolean
    narrowExpanded: boolean
  }
}
