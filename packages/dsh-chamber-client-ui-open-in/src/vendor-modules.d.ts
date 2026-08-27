/** Loose vendor faces; the renderer resolves these packages to pinned source. */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export type ClientContext = any
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
}

/** Menu subset used by the open-in dropdown (copied from the git plugin's
 *  declaration; only the props this plugin passes are declared). */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactNode } from 'react'
  export interface MenuItem {
    id: string
    label: ReactNode
    disabled?: boolean
    icon?: ReactNode
    danger?: boolean
  }
  export interface MenuProps {
    compact?: boolean
    portal?: boolean
    align?: 'start' | 'end'
    open: boolean
    onClose: () => void
    onSelect?: (id: string) => void
    items?: MenuItem[]
    /** Row shown with the trailing selection check (the vendor runtime's
     *  native selected marker). */
    selectedId?: string
    anchor: ReactNode
  }
  export function Menu(props: MenuProps): ReactNode
}
