/** Loose vendor faces; the renderer resolves these packages to pinned source. */

declare module '@deepseek-ai/cordis' {
  /** Loose root-context face (the plugin consumes ctx through the cordis Context). */
  export interface Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
}

/**
 * UI primitives (the pinned vendor source the renderer bundles): the open-in
 * entry renders the OFFICIAL `Menu` (dense rows, fill selection, item icons,
 * focus transfer and arrow navigation through `autoFocus`) and the design
 * system's `Tooltip` instead of the hand-rolled menu and the native `title`
 * bubble (2026-09-11 upstream-alignment, T13/T5). The face mirrors
 * `ui-primitives/src/Menu.tsx` + `Tooltip.tsx` at the pin.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    /** Leading icon (figma .Menu_cell gap 8). */
    icon?: ReactNode
    danger?: boolean
  }
  export interface MenuProps {
    /** Focus the first item on open and enable arrow-key navigation; Escape focuses the anchor's first button. */
    autoFocus?: boolean
    open: boolean
    anchor: ReactNode
    items: readonly MenuItem[]
    selectedId?: string | undefined
    onSelect: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
    dense?: boolean
    compact?: boolean
    selection?: 'check' | 'fill'
    className?: string | undefined
  }
  export function Menu(props: MenuProps): ReactNode
  /** Bubble placement relative to the anchor. */
  export type TooltipSide = 'right' | 'bottom' | 'top'
  export interface TooltipProps {
    /** Bubble text, or a resolver evaluated only while the bubble is visible. */
    label: string | (() => string)
    side?: TooltipSide
    delayMs?: number
    disabled?: boolean
    maxWidth?: number
    /** A single anchor element; its own ref and handlers are forwarded. */
    children: ReactNode
  }
  export function Tooltip(props: TooltipProps): ReactNode
}
