/**
 * Loose ambient faces for the @deepseek-ai/* dependencies of this package
 * (mirrors renderer/src/vendor-modules.d.ts). The vendor packages resolve to
 * read-only source without built lib/ types, so their faces are declared here
 * with the exact surface this package consumes; the standalone
 * `typecheck:settings-bridge` script keeps this package's own code checked.
 * Keep in sync with what the src/client modules actually import.
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
  }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  import type { Context } from '@deepseek-ai/cordis'
  import type { LocaleFace, StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
  export interface ClientContext extends Context {
    effect(fn: () => void | (() => void), label?: string): void
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
  export class SlotRegistry {
    constructor(ctx: Context)
    register(options: Record<string, unknown>, component: unknown): () => void
    inject(key: string, callback: () => void | Iterable<() => void>): () => void
    entries(key: string): readonly StoredEntry[]
    entriesOfSlot(key: string): readonly StoredEntry[]
    getVersion(key: string): number
    subscribe(key: string, fn: () => void): () => void
    spec(key: string): { kind: string; scope: string } | undefined
    installLocale(face: LocaleFace): void
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
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
}

declare module '@deepseek-ai/dsh-client-ui-theme/client' {
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
}

declare module '@deepseek-ai/dsh-client-ui-renderer/src/client/bind' {
  import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
  export function bindSnapshotSelector<T>(source: HostObservable<T>): SnapshotSelectorHook<T>
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
  /** Live schemastery node (introspection face this package consumes). */
  export interface SchemaNode {
    type: string
    list?: readonly unknown[]
    value?: unknown
    meta?: { description?: unknown }
  }
  /** Settings-owned synchronous schema operations (ui-settings client service face). */
  export interface SettingsSchemaService {
    rehydrate(serialized: unknown): SchemaNode
    nodeAtPath(root: unknown, path: readonly string[]): SchemaNode | undefined
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings-general/client' {
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
}

declare module '@deepseek-ai/dsh-client-ui-settings-models/client' {
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
}

declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
}

declare module '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client' {
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
}

declare module '@deepseek-ai/dsh-client-ui-agent-preset/client' {
  import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
  export const inject: string[]
  export function apply(ctx: ClientContext): void
}

declare module '@deepseek-ai/dsh-api-remotes/client' {
  /** Wire view of one registered settings namespace (a settings.describe row). */
  export interface SettingsNamespaceView {
    /** Namespace key (`permission`, `ui-conversation`, …). */
    ns: string
    /** Serialized schemastery schema envelope (`schema.toJSON()`). */
    schema: unknown
    /** Redacted resolved value (schema defaults → composition base → user layer). */
    value: unknown
    /** Redacted composition base layer, when the registrant declared one. */
    base?: unknown
    /** Redacted raw user section, when one exists. */
    user?: unknown
    /** When the owner applies changes. */
    applies: 'live' | 'restart'
    /** Every schema-declared secret slot with its configured state. */
    secrets: readonly { path: readonly string[]; set: boolean }[]
    /** Monotonic revision of the raw user section this view was read at. */
    revision: number
  }
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
    onClick?: () => void
    children?: ReactNode
  }
  export function Button(props: ButtonProps): ReactNode
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
  export function RiskConfirmation(props: {
    open: boolean
    title: string
    description: string
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
