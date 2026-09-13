/** Loose vendor faces; the renderer resolves these packages to pinned source. */

declare module '@deepseek-ai/cordis' {
  export interface Context {
    [key: string]: any
  }
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export interface LocaleNamespaceMap {}
}

declare module '@dsh-chamber/dsh-chamber-client-ui-sidebar/client' {
  export interface SidebarWorkspaceGitOwnerProps { wide: boolean }
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
  export interface InputProps {
    value?: string
    disabled?: boolean
    placeholder?: string
    className?: string
    icon?: ReactNode
    onChange?: (event: { target: { value: string } }) => void
    onBlur?: () => void
  }
  export function Input(props: InputProps): ReactNode
  export function IconChevronRightOutline14(props: { size?: number; className?: string }): ReactNode
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
    anchor: ReactNode
  }
  export function Menu(props: MenuProps): ReactNode
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
  /** Read-only capsule badge (upstream `Tag.tsx`), used for the unregistered
   *  worktree's status capsule (2026-09-11 upstream-alignment, T14). */
  export type TagTone = 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  export function Tag(props: { tone?: TagTone; className?: string | undefined; children?: ReactNode }): ReactNode
  /** Controlled risk acknowledgement dialog (upstream `RiskConfirmation.tsx`):
   *  the primary action stays unavailable until `acknowledged` is true. */
  export interface RiskConfirmationProps {
    open: boolean
    title: string
    description: string
    acknowledgeLabel: string
    cancelLabel: string
    closeLabel: string
    confirmLabel: string
    acknowledged: boolean
    disabled?: boolean
    onAcknowledgedChange: (acknowledged: boolean) => void
    onCancel: () => void
    onConfirm: () => void
  }
  export function RiskConfirmation(props: RiskConfirmationProps): ReactNode
  export function IconBranchOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconLoadingOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconPlusOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconRefreshOutline16(props?: { size?: number; className?: string }): ReactNode
  export function IconTrashOutline16(props?: { size?: number; className?: string }): ReactNode
}
