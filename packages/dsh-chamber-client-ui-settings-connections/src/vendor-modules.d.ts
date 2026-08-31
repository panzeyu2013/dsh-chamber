/**
 * Loose ambient faces for the @deepseek-ai/* dependencies of this package
 * (mirrors renderer/src/vendor-modules.d.ts). The vendor packages resolve to
 * read-only source without built lib/ types, so their faces are declared here
 * with the exact surface this plugin consumes; the standalone
 * `typecheck:connections` script keeps this package's own code checked
 * (design 05 §5). Keep in sync with what ConnectionsSection.tsx / index.ts
 * actually import.
 */

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
  export interface ModalProps {
    open: boolean
    onClose: () => void
    title: string
    closeLabel?: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    className?: string
    contentClassName?: string
    headless?: boolean
  }
  export function Modal(props: ModalProps): ReactNode
  export interface IconProps {
    size?: number
    className?: string
  }
  export function IconChecklistOutline14(props?: IconProps): ReactNode
  export function IconChevronDownOutline14(props?: IconProps): ReactNode
  export function IconCloseOutline16(props?: IconProps): ReactNode
  export function IconEditOutline16(props?: IconProps): ReactNode
  export function IconLinkOutline16(props?: IconProps): ReactNode
  export function IconPlayOutline16(props?: IconProps): ReactNode
  export function IconPlusOutline16(props?: IconProps): ReactNode
  export function IconRefreshOutline16(props?: IconProps): ReactNode
  export function IconStopFill16(props?: IconProps): ReactNode
  export function IconTrashOutline16(props?: IconProps): ReactNode
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type InjectFace<I> = I
  export type PropsLocale<N extends string> = Record<string, unknown>
  export type PropsRuntime<S extends string> = Record<string, unknown>
  /** Augmented by each settings plugin for its own dictionary namespace. */
  export interface LocaleNamespaceMap {}
}

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
  }
}

declare module '@deepseek-ai/dsh-client-ui-settings/client' {}

declare module '@deepseek-ai/dsh-client-locale/client' {}
