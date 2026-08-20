/** Loose vendor faces; the renderer resolves these packages to pinned source. */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export type ClientContext = any
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
}

declare module '@dsh-chamber/dsh-client-ui-sidebar/client' {
  export interface SidebarGitOwnerProps { wide: boolean }
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
  }
  export function Modal(props: ModalProps): ReactNode
  export function IconBranchOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconLoadingOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconPlusOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconRefreshOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconTrashOutline16(props?: { size?: number; className?: string }): ReactNode
}
