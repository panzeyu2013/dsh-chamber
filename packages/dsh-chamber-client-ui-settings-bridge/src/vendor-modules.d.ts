/**
 * Loose ambient faces for the @deepseek-ai/* dependencies of this package
 * (mirrors renderer/src/vendor-modules.d.ts). The vendor packages resolve to
 * read-only source without built lib/ types, so their faces are declared here
 * with the exact surface this package consumes; the standalone
 * `typecheck:settings-bridge` script keeps this package's own code checked.
 * Keep in sync with what the src/client modules actually import.
 *
 * 2026-12 audit: the faces this package never imports were removed (the
 * dissolved-runtime store / api-controller mirrors, the ui-renderer client
 * shim and the settings-family entry shims) — none of them was imported by
 * src/ or test/, so each was inert. Add a block back only alongside a real
 * import of that specifier.
 *
 * The renderer's `src/client/bindings.tsx` (2026-09-11 upstream-alignment A3:
 * the bridge uses the OFFICIAL `observableHook` instead of re-implementing it)
 * is the one exception: a DEEP `./src/*` specifier resolves to the real vendor
 * source, and that module reads host/binding faces this file's loose ui-slots
 * mirror deliberately does not carry — so it is declared in
 * src/ambient/renderer-bindings.d.ts and mapped through this package's tsconfig
 * `paths` instead of being mirrored here.
 */

declare module '@deepseek-ai/cordis' {
  export class Context {
    plugin(plugin: unknown, ...args: unknown[]): unknown
    inject(deps: string[], callback: (ctx: Context) => void): unknown
    provide<T>(name: string, value: T): void
    get<T = any>(name: string): T
    effect(fn: () => void | (() => void) | Promise<void | (() => void)>, label?: string): () => void
    on<K extends string>(name: K, fn: (...args: any[]) => void): () => void
    emit(name: string, ...args: unknown[]): void
    fiber: { dispose(): Promise<void> }
    /** Service merges the mounted client plugins augment onto Context (chamber's loose face). */
    locale: {
      register(namespace: string, dictionaries: Record<string, Record<string, string>>): void
      bind(namespace: string): (key: string) => string
    }
    slots: {
      inject(slot: string, register: () => unknown): void
      register(...args: unknown[]): unknown
    }
    settingsScope: {
      bind<T = unknown>(spec: {
        namespace: string
        decode?: (value: unknown) => T
      }): {
        getSnapshot(): { status: string; value: unknown; writable: boolean; revision: number | undefined }
        subscribe(fn: () => void): () => void
        set(field: string, value: unknown): Promise<void>
        load(): Promise<void>
      }
    }
  }
}

/**
 * Service base class (cordis service.ts): registering through the constructor
 * makes every method call CALLER-bound — `this.ctx` inside a method is the
 * calling plugin's context.
 */
declare module '@deepseek-ai/cordis' {
  export class Service<T = never> {
    constructor(ctx: Context, name: string)
    ctx: Context
    name: string
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { ReactNode } from 'react'
  export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'
  export type SlotScope = 'root' | 'session-maybe' | 'session'
  export type SlotLabel = string | (() => string)
  export interface SlotSpec<E = { kind: SlotKind; scope: SlotScope }> {
    kind: E extends { kind: infer K } ? K : SlotKind
    scope: E extends { scope: infer S } ? S : SlotScope
  }
  export interface StoredEntry {
    component: unknown
    options: { key?: string; id?: string; order?: number; label?: SlotLabel; priority?: number }
    inject?: ((...args: never[]) => Record<string, unknown>) | undefined
    children?: Readonly<Record<string, { kind: SlotKind; scope: SlotScope }>> | undefined
    store?: { create(): StoreInstanceLike } | undefined
    locale?: string | undefined
    registrant?: string | undefined
  }
  export interface StoreInstanceLike {
    getSnapshot(): unknown
    subscribe(fn: () => void): () => void
    readonly actions: Record<string, (...params: never[]) => void>
  }
  export interface HostObservable<T> {
    getSnapshot(): T
    subscribe(fn: () => void): () => void
  }
  export interface LocaleFace extends HostObservable<{ revision: number }> {
    bind(ns: string): Translate
  }
  export type Translate = (key: string, params?: Record<string, unknown>) => string
  export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
  export interface RenderOpts {
    entryKey?: string
    only?: string
    fallback?: ReactNode
    hookContext?: unknown
  }
  /** Slot-component props composition helpers (the official settings plugins compose these). */
  export type InjectFace<I> = I
  export type PropsLocale<N extends string> = Record<string, unknown>
  export type PropsRuntime<S extends string> = Record<string, unknown>
  /** Augmented by each settings plugin for its own dictionary namespace. */
  export interface LocaleNamespaceMap {}
  export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  import type { Context } from '@deepseek-ai/cordis'
  export const inject: string[]
  export function apply(ctx: Context): void
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'
  export interface ButtonProps {
    variant?: 'primary' | 'outline' | 'ghost'
    size?: 'sm' | 'md' | 'lg'
    disabled?: boolean
    autoFocus?: boolean
    icon?: ReactNode
    className?: string
    title?: string
    onClick?: () => void
    children?: ReactNode
  }
  export function Button(props: ButtonProps): ReactNode
  /**
   * Two-state toggle, 36×20 (2026-09-11 upstream-alignment T9): track/thumb/
   * transition/focus are the official vocabulary the chamber's hand-rolled
   * switch copied; `label` is required, so the control cannot ship unnamed.
   */
  export function Switch(props: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
    disabled?: boolean
    title?: string
    className?: string
  }): ReactNode
  /**
   * Centered, body-portaled dialog over a blurred mask (2026-09-11
   * upstream-alignment T2: the ONE confirmation surface the dsh runtime section
   * uses). `closeLabel` is required — the atoms own no fallback copy.
   */
  export function Modal(props: {
    open: boolean
    /** Escape, mask click and the header close button. */
    onClose: () => void
    title: string
    closeLabel: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
  }): ReactNode
  export interface IconProps {
    size?: number
    className?: string
  }
  export function IconCloseOutline16(props?: IconProps): ReactNode
  export function IconLoadingOutline16(props?: IconProps): ReactNode
  export function IconSettingsOutline14(props?: IconProps): ReactNode
  export function IconSettingsOutline16(props?: IconProps): ReactNode
  export function IconDataOutline16(props?: IconProps): ReactNode
  export function IconAgentPresetOutline16(props?: IconProps): ReactNode
  export function IconPersonalizationOutline16(props?: IconProps): ReactNode
  export function IconLinkOutline16(props?: IconProps): ReactNode
  export function IconChevronDownOutline14(props?: IconProps): ReactNode
  export interface MenuEntry {
    id: string
    label: ReactNode
    disabled?: boolean
    danger?: boolean
  }
  export function Menu(props: {
    open: boolean
    anchor: ReactNode
    items: readonly MenuEntry[]
    footer?: readonly MenuEntry[]
    selectedId?: string | undefined
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    closeOnPointerLeave?: boolean
    dense?: boolean
    compact?: boolean
  }): ReactNode
  /** RiskConfirmation: `closeLabel` became REQUIRED in dsh-v0.1.2-alpha.1 (forwards to Modal). */
  export function RiskConfirmation(props: {
    open: boolean
    title: string
    description: string
    closeLabel: string
    acknowledgeLabel: string
    cancelLabel: string
    confirmLabel: string
    acknowledged: boolean
    disabled?: boolean
    onAcknowledgedChange: (acknowledged: boolean) => void
    onCancel: () => void
    onConfirm: () => void
  }): ReactNode
}
