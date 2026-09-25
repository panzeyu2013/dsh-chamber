/**
 * Repo-level ambient faces for the pinned dsh vendor packages: the merged union
 * of the eight former hand-copied src/vendor-modules.d.ts tables (renderer + the
 * seven chamber client plugins). Each package keeps only a /// <reference> stub;
 * a face added here is visible to every package program, so verify it against
 * the vendor source first.
 *
 * The vendor tree ships source without built types, so every consumed specifier
 * is declared loosely; the chamber-owned copies/fork are checked by their own
 * programs and the renderer compiles the real vendor source via vite aliases.
 * No top-level import/export: that would turn this file into a module and demote
 * every 'declare module' below to an augmentation.
 */

// cordis: union of the former loose Context faces. The declared members are what
// chamber code reads; the index signature is the escape hatch four copies carried.
declare module '@deepseek-ai/cordis' {
  export interface Context {
    plugin(...args: any[]): this
    inject(...args: any[]): this
    provide<T = unknown>(name: string, value: T): void
    get<T = any>(name: string, strict?: boolean): T
    on(event: string, listener: (...args: any[]) => void): () => void
    emit(name: string, ...args: unknown[]): void
    /** Cordis effect scope: the returned disposer runs on fiber teardown. */
    effect(fn: () => (() => void) | void | Promise<void | (() => void)>, label?: string): () => void
    fiber: { dispose(): Promise<void> }
    reflect: { provide(name: string, value: unknown): () => void; get?(name: string, strict?: boolean): unknown; [key: string]: any }
    theme: { getTheme(): any }
    slots: {
      register(options: any, component: any): () => void
      entries(slot: string): Array<{ options: { key?: string } }>
      entriesOfSlot(slot: string): readonly { options: { id?: string; order?: number; label?: string | (() => string); key?: string; priority?: number } }[]
      subscribe(slot: string, listener: () => void): () => void
      /** Root standard sources (vendor RootStandardSourceContribution). */
      provideRoot(c: { hooks?: Record<string, unknown>; keyedHooks?: Record<string, unknown>; props?: Record<string, unknown> }): () => void
      inject(slot: string, register: () => unknown): void
    }
    locale: {
      register(ns: string, d: Record<string, Record<string, string>>): void
      bind(ns: string): (key: string) => string
      subscribe(listener: () => void): () => void
    }
    /** Per-instance sessions runtime face (rc.2 ISessions); retain = caller owns the reference. */
    sessions: {
      retain(target: string, options: { source: string }): { readonly sessionId: string; release(): void }
      list: { getSnapshot(): { byId?: Record<string, unknown> } }
    }
    /** Official view owner (ui-workspace service): openSession retains the target as mainView. */
    uiWorkspace?: { openSession(target: string): void }
    /** Cordis Loader mounted by the web shell boot; the renderer reads name + root fiber state. */
    loader?: { entries(): readonly { options: { name: string }; fiber?: { state: number } }[] }
    [key: string]: any
  }
}

// dsh web shell (chamber fork) + the client-modules loader contract.
declare module '@deepseek-ai/dsh-client-web' {
  /** Module transport hook (boot.ts BootSeams). */
  export interface BootSeams { loadBundle?: (url: string) => Promise<void> }
  /**
   * chamber patch (design 05/09): per-instance extra host-graph rows; the
   * required initialUrl is the preloaded combo url, inject is empty and
   * external lists the specifiers the row factory requires at create time.
   */
  export interface AppWebEntryOptions extends BootSeams {
    extraRows?: { id: string; url: string; initialUrl: string; rev: string; inject: string[]; external: string[] }[]
    configureContext?: (ctx: Context) => void
  }
  /**
   * chamber patch (design 05 §4): install-or-reuse the page-level module system
   * BEFORE any bundle preload; idempotent. Mirror of
   * packages/dsh-client-web/src/boot.ts — signature drift is NOT caught by tsc.
   */
  export function ensureWebModuleSystem(seams?: BootSeams): {
    manifest: { plugins: ReadonlyArray<{ id: string; immediately?: boolean }> }
    prefetch(id: string): Promise<void>
    import(specifier: string): Promise<unknown>
  }
  /** Fiber-state value mirror of packages/dsh-client-web/src/loader-status.ts. */
  export const FIBER_STATE: { PENDING: 0; LOADING: 1; ACTIVE: 2; FAILED: 3; DISPOSED: 4; UNLOADING: 5 }
  /** The web shell kernel consumed by the renderer (boot.ts). */
  export class AppWebEntry {
    constructor(el: HTMLElement, options?: AppWebEntryOptions)
    run(): Promise<unknown>; dispose(): Promise<void>
    /** Settled runtime context; undefined after dispose. */
    runtimeCtx: Context | undefined
    /** Boot failure report; undefined while loading or after a clean settle. */
    bootError: string | undefined
  }
}

declare module '@deepseek-ai/dsh-client-modules/client'

// client store + api controllers.
declare module '@deepseek-ai/dsh-client-store' {
  /** Store write set (contract.ts) + engine-backed instance/handle faces (index.ts). */
  export type ActionsDecl<T> = Record<string, (draft: T, ...params: any[]) => void>
  export interface EngineStoreInstance<T, A extends ActionsDecl<T>> {
    readonly actions: {
      [K in keyof A]: A[K] extends (draft: T, ...params: infer P) => void ? (...params: P) => void : never
    }
    getSnapshot(): T; subscribe(fn: () => void): () => void; clearPersisted(): void
    readonly store: {
      update(mutator: (draft: T) => void): void; set(next: T): void
      getSnapshot(): T; subscribe(fn: () => void): () => void
    }
  }
  export interface EngineStoreHandle<T, A extends ActionsDecl<T>> {
    readonly spec: { init: () => T; persist?: string; actions: A }
    create(scopeKey?: string): EngineStoreInstance<T, A>
  }
  export function defineStore<T, A extends ActionsDecl<T>>(
    decl: { init: () => T; persist?: string; actions: A & ActionsDecl<T> },
  ): EngineStoreHandle<T, A>
  /** Minimal observable snapshot source (contract.ts). */
  export interface ObservableSnapshot<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
  /** Selector hook over one observable source (vendor two-arg form). */
  export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
  /** Writable snapshot store: getSnapshot/subscribe plus set (wholesale) and update (immer draft). */
  export interface SnapshotStore<T> extends ObservableSnapshot<T> {
    set(next: T): void
    update(mutator: (draft: T) => void): void
  }
  export function createSnapshotStore<T>(
    init: T, opts?: { flush?: 'raf' | 'sync'; persist?: { name: string } },
  ): SnapshotStore<T>
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  /**
   * One row of the CLIENT session store (`ctx.sessions.list`): what
   * `ClientSessions.projectList()` publishes, NOT the host wire `SessionSummary`
   * (the typert declaration carries `sessionId`/`parentSessionId`, and has no
   * `id`, `displayTitle` or `retainedBy`). The store builder renames
   * `sessionId→id`, `parentSessionId→parentId` and adds `displayTitle`/`retainedBy`.
   *
   * There is deliberately NO `completed` member: the store row has none. The
   * official completion-unread fact is `uiSession.sessionStatus.completionUnread`
   * (read by the official nav as `status?.completionUnread === true`), and chamber's
   * completed-unread dot is its own ledger — a `completed` here would be a phantom
   * field that reads `undefined` forever.
   */
  export interface SessionSummary {
    id: string; title?: string; displayTitle: string; cwd?: string; parentId?: string
    origin?: 'subagent'; running: boolean; blank: boolean; updatedAt: number
    projectionValues?: Readonly<Record<string, unknown>>
    /** Local ownership counts: the presented session is the mainView-retained row. */
    retainedBy?: Readonly<Record<string, number>>
  }
  export interface SessionListState {
    ids: readonly string[]; byId: Readonly<Record<string, SessionSummary>>; phase: 'pending' | 'ready'
  }
  /** Wire search-result page bound (sidebar search copy). */
  export const SESSION_SEARCH_RESULT_LIMIT: number
}

declare module '@deepseek-ai/dsh-api-workspace-controller/client' {
  export type WorkspaceId = string
  export interface WorkspaceView {
    workspaceId: WorkspaceId; path: string; title: string
    sessionIds: readonly string[]; createdAt: string; updatedAt: string
  }
  /** Client Workspace list snapshot (ctx.workspaces.list). */
  export interface WorkspaceSnapshot {
    items: readonly WorkspaceView[]; archivedSessionIds: readonly string[]
    state: 'idle' | 'loading' | 'error'; phase: 'pending' | 'ready'; error: unknown
  }
  /** Structured workspace-create failure (declared for the seam). */
  export class WorkspaceCreateError extends Error { readonly rpcError: unknown }
}

declare module '@deepseek-ai/dsh-client-locale/client' {
  import type { Context } from '@deepseek-ai/cordis'
  export type Translate = (key: string, params?: Record<string, unknown>) => string
  export const inject: string[]
  export function apply(ctx: Context): Promise<void>
}

declare module '@deepseek-ai/dsh-client-shortcuts/client' {
  export type ShortcutCommandId = string
}

// ui-slots contract faces (union of the loose per-plugin mirrors).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  import type { ReactNode } from 'react'
  /** Augmentation targets: each plugin merges its own keys/holes. */
  export interface LocaleNamespaceMap {}
  export interface SlotMap {}
  export interface GlobalStandardProps {}
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
    store?: { create(): StoreInstanceLike } | undefined; locale?: string | undefined
    registrant?: string | undefined
  }
  export interface StoreInstanceLike {
    getSnapshot(): unknown; subscribe(fn: () => void): () => void
    readonly actions: Record<string, (...params: never[]) => void>
  }
  /** Bare observable source bound to a use<Name> selector hook. */
  export interface HostObservable<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }
  /** Selector hook over one observable source (vendor two-arg form). */
  export type SnapshotSelectorHook<T> = <S>(sel: (s: T) => S, eq?: (a: S, b: S) => boolean) => S
  export interface LocaleFace extends HostObservable<{ revision: number }> { bind(ns: string): Translate }
  export type Translate = (key: string, params?: Record<string, unknown>) => string
  /** renderSlot dispatch options: keyed dispatch key, list filtering, empty fallback. */
  export interface RenderOpts { entryKey?: string; only?: string; fallback?: ReactNode; hookContext?: unknown }
  /**
   * Component-side view of an inject face (vendor SlotInjectFace, loose): the
   * reserved hooks compartment arrives as bound use<Name> selector hooks; every
   * other member passes through verbatim.
   */
  export type InjectFace<I> = I extends { hooks: infer HS extends object }
    ? Omit<I, 'hooks'> & { [N in keyof HS & string as `use${Capitalize<N>}`]: any } & Record<string, any>
    : I
  /** Locale seat the slot registrant receives (declared namespace => bound t). */
  export type PropsLocale<N extends string> = { t: Translate }
  /** Owner runtime share (loose; the vendor conditional type is the source of truth). */
  export type PropsRuntime<N extends string> = Record<string, any>
  export type PropsRenderSlots<H extends string> = {
    renderSlot: (hole: H, props?: any, opts?: { entryKey?: string; only?: string; fallback?: ReactNode }) => ReactNode
  }
  export function resolveSlotLabel(label: SlotLabel | undefined): string | undefined
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  export type MainPanelId = string
  export interface PanelInfo { readonly activePanelId: MainPanelId | null }
  /** Panel navigation + geometry actions exposed through ctx.layout. */
  export interface ILayout {
    selectPanel(panelId: MainPanelId | null): void; beginNavigation(): AbortSignal
    toggleSidebar(): void; openRightbar(track: boolean, fullscreen: boolean): void; closeRightbar(): void
  }
}

// ui-layout deep source faces (the chamber fork replaces the official package).
declare module '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts' {
  /** Contract-frozen column geometry (mirrors the vendor columns.ts constants). */
  export const CENTER_MIN: number; export const SIDEBAR_MIN: number; export const SIDEBAR_MAX: number
  export const SIDEBAR_DEFAULT: number; export const SIDEBAR_COLLAPSED: number; export const SIDEBAR_AUTO_COLLAPSE: number
  export const RIGHTBAR_MIN: number; export const RIGHTBAR_MAX_RATIO: number; export const RIGHTBAR_DEFAULT_RATIO: number
  export function clampWidth(px: number, min: number, max: number): number
  export function computeColumns(
    viewport: number, sidebar: number, rightbar: number,
  ): { sidebar: number; center: number; rightbar: number }
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx' {
  /** The vendor three-column shell frame (loose face). */
  export const AppFrame: (props: any) => any
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts' {
  /** Identity shared by a sidebar panel entry and its main-slot occupant. */
  export type MainPanelId = string & { readonly __brand?: 'MainPanelId' }
  export interface PanelInfo { readonly activePanelId: MainPanelId | null }
  /** The outward layout face (ctx.layout): panel transitions other plugins may trigger. */
  export interface ILayout {
    selectPanel(panelId: MainPanelId | null): void; beginNavigation(): AbortSignal
    toggleSidebar(): void; openRightbar(track: boolean, fullscreen: boolean): void; closeRightbar(): void
  }
  export class LayoutController implements ILayout {
    constructor(panels: any, hasMainPanel: (id: MainPanelId) => boolean, panelInfo: any)
    readonly panelInfo: any; dispose(): void
    selectPanel(panelId: MainPanelId | null): void; beginNavigation(): AbortSignal
    toggleSidebar(): void; openRightbar(track: boolean, fullscreen: boolean): void; closeRightbar(): void
  }
  export type PanelActions = any
}

declare module '@deepseek-ai/dsh-client-ui-layout/src/client/theme-presenter.ts' {
  /** Applies theme snapshots to the document (loose face). */
  export class ThemePresenter { apply(snapshot: any): void; dispose(): void }
}

// ui-workspace / directory-picker deep faces.
declare module '@deepseek-ai/dsh-client-ui-workspace/src/client/navigation.ts' {
  /** Browse-capability business error (DirectoryBrowser renders rpcError.message). */
  export class DirectoryBrowseError extends Error {
    constructor(rpcError: { code: string; message: string; details?: unknown })
    readonly rpcError: { code: string; message: string; details?: unknown }
  }
}

declare module '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx' {
  import type { DirectoryListingRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
  /**
   * The in-app workspace-directory browser (design 05 §4); props mirror the
   * vendor component's contract (list/create ride the per-source unary client).
   */
  export interface DirectoryBrowserProps {
    open: boolean; busy: boolean; onOpen: (path: string) => void; onClose: () => void
    listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListingRow>
    createDirectory: (path: string, name: string) => Promise<string>
    t: import('@deepseek-ai/dsh-client-locale/client').Translate
  }
  export const DirectoryBrowser: (props: DirectoryBrowserProps) => import('react').ReactNode
}

// ui-primitives: union of every atom/icon the chamber packages consume.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react'
  export interface IconProps { size?: number; className?: string }
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant; size?: 'md' | 'sm'; icon?: ReactNode
    /** Paired with aria-label on connection-manager buttons. */
    'data-tip'?: string
  }
  export function Button(props: ButtonProps): JSX.Element | null
  export interface InputProps {
    value?: string; disabled?: boolean; placeholder?: string; className?: string; icon?: ReactNode
    onChange?: (event: { target: { value: string } }) => void; onBlur?: () => void
  }
  export function Input(props: InputProps): JSX.Element | null
  export interface MenuItem {
    id: string; label: ReactNode; disabled?: boolean; icon?: ReactNode; danger?: boolean
    /** Effective binding supplied by the command owner; omitted for unbound actions. */
    shortcut?: { keys: readonly string[]; aria?: string | undefined }
    /** Nested card opened to the right on hover/focus. */
    submenu?: readonly MenuItem[]
  }
  export interface MenuSeparator { type: 'separator'; id: string }
  export interface MenuLabel { type: 'label'; id: string; text: string }
  export type MenuEntry = MenuItem | MenuSeparator | MenuLabel
  export interface MenuProps {
    open: boolean; anchor: ReactNode; onClose: () => void; items?: readonly MenuEntry[]
    children?: ReactNode; footer?: readonly MenuEntry[]; selectedId?: string | undefined
    selectedIds?: readonly string[] | undefined; onSelect?: (id: string) => void
    autoFocus?: boolean; align?: 'start' | 'end'; side?: 'bottom' | 'top' | 'right'
    portal?: boolean; closeOnPointerLeave?: boolean; dense?: boolean; compact?: boolean
    selection?: 'check' | 'fill'; getAnchorRect?: () => DOMRect | null
    className?: string | undefined; listClassName?: string | undefined
  }
  export function Menu(props: MenuProps): JSX.Element | null
  export interface ModalBaseProps {
    open: boolean; onClose: () => void; title: string; description?: string
    children?: ReactNode; footer?: ReactNode; className?: string; contentClassName?: string
    shortcutModal?: string; backdropBlur?: boolean
  }
  /** Vendor conditional: closeLabel is required unless the dialog is headless. */
  export type ModalProps = ModalBaseProps & (
    | { headless: true; closeLabel?: never }
    | { headless?: false; closeLabel: string }
  )
  export function Modal(props: ModalProps): JSX.Element | null
  export interface RiskConfirmationProps {
    open: boolean; title: string; description: string; acknowledgeLabel: string
    cancelLabel: string; closeLabel: string; confirmLabel: string; acknowledged: boolean
    disabled?: boolean
    onAcknowledgedChange: (acknowledged: boolean) => void; onCancel: () => void; onConfirm: () => void
  }
  export function RiskConfirmation(props: RiskConfirmationProps): JSX.Element | null
  /** Two-state toggle, 36x20; label is required so the control cannot ship unnamed. */
  export function Switch(props: {
    checked: boolean; onChange: (next: boolean) => void; label: string
    disabled?: boolean; title?: string; className?: string
  }): JSX.Element | null
  /** Read-only capsule badge (vendor Tag.tsx), used for worktree status capsules. */
  export type TagTone =
    | 'outline' | 'solid' | 'neutral' | 'quiet' | 'success' | 'info' | 'warning' | 'danger'
  export function Tag(props: { tone?: TagTone; className?: string | undefined; children?: ReactNode }): JSX.Element | null
  /** Anchor-preserving tooltip (vendor Tooltip.tsx); children is one anchor element. */
  export type TooltipSide = 'right' | 'bottom' | 'top'
  export interface TooltipProps {
    label: string | (() => string); shortcutKeys?: readonly string[] | undefined
    side?: TooltipSide; align?: 'center' | 'end'; delayMs?: number; gap?: number
    disabled?: boolean; portal?: boolean; maxWidth?: number; children: ReactElement
  }
  export function Tooltip(props: TooltipProps): JSX.Element | null
  /** Host clipboard write; resolves true only when the host accepted the write. */
  export function writeClipboard(text: string): Promise<boolean>
  export const BrandWordmark: (props: any) => JSX.Element | null
  export const FishLogo: (props: any) => JSX.Element | null
  /** Official dsh state dot: done/warning/ongoing/error (loose face). */
  export const StateDot: (props: any) => JSX.Element | null
  /** Vendor icon atoms (union of the glyphs the chamber packages render). */
  export type IconComponent = (props?: IconProps) => JSX.Element | null
  export const IconAgentPresetOutlineRegular: IconComponent
  export const IconAlarmClockOutlineRegular: IconComponent
  export const IconArchiveOutlineRegular: IconComponent
  export const IconBranchOutlineRegular: IconComponent
  export const IconChecklistOutlineRegular: IconComponent
  export const IconChevronDownOutlineRegular: IconComponent
  export const IconChevronRightOutlineRegular: IconComponent
  export const IconCloseOutlineRegular: IconComponent
  export const IconDataOutlineRegular: IconComponent
  export const IconEditOutlineRegular: IconComponent
  export const IconEllipsisOutlineRegular: IconComponent
  export const IconFolderOpenOutlineRegular: IconComponent
  export const IconLinkOutlineRegular: IconComponent
  export const IconLoadingOutlineRegular: IconComponent
  export const IconNewChatOutlineRegular: IconComponent
  export const IconPanelLeftOutlineRegular: IconComponent
  export const IconPersonalizationOutlineRegular: IconComponent
  export const IconPlayOutlineRegular: IconComponent
  export const IconPlusOutlineRegular: IconComponent
  export const IconProjectAddOutlineRegular: IconComponent
  export const IconQuestionOutlineRegular: IconComponent
  export const IconRefreshOutlineRegular: IconComponent
  export const IconSearchOutlineRegular: IconComponent
  export const IconSettingsOutlineRegular: IconComponent
  export const IconStopFillRegular: IconComponent
  export const IconTrashOutlineRegular: IconComponent
  export const IconWarningOutlineRegular: IconComponent
}

// The official Button atom, imported by the FRAME (App.tsx) by DEEP SOURCE PATH
// so the primitives barrel's markdown/highlight families stay out of the main graph.
declare module '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx' {
  import type { ButtonHTMLAttributes, ReactNode } from 'react'
  export type ButtonVariant = 'primary' | 'ghost' | 'outline' | 'toolbar'
  export function Button(props: {
    variant?: ButtonVariant; size?: 'md' | 'sm'; icon?: ReactNode
    className?: string | undefined; children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactNode
}

// invariants + chamber client-plugin registration faces.
declare module '@deepseek-ai/dsh-invariants' {
  /** Package invariant installer (loose face). */
  export type InvariantInstaller = (ctx: any) => void | Promise<void>
}

// Chamber client-plugin registration faces (designs 05/06/08/16).
declare module '@dsh-chamber/dsh-chamber-client-ui-sidebar/client' {
  export const inject: string[]; export function apply(ctx: any): void
  /** Owner share of the per-workspace Git occupant (declared by the Git plugin). */
  export interface SidebarWorkspaceGitOwnerProps { wide: boolean }
}
declare module '@dsh-chamber/dsh-chamber-client-ui-git/client' {
  export const inject: string[]; export function apply(ctx: any): void
}
declare module '@dsh-chamber/dsh-chamber-client-ui-open-in/client' {
  export const inject: string[]; export function apply(ctx: any): void
}
declare module '@dsh-chamber/dsh-chamber-client-ui-layout/client' {
  export const inject: string[]; export function apply(ctx: any): void
}
declare module '@dsh-chamber/dsh-chamber-client-ui-settings-connections/client' {
  export const inject: string[]; export function apply(ctx: any): void
}
declare module '@dsh-chamber/dsh-chamber-client-ui-settings-bridge/client' {
  export const inject: string[]; export function apply(ctx: any): void
}

// Remaining first-screen / deferred / covered vendor client entries: declared
// bare because the renderer only merges their ids into the per-instance boot
// graph (chamber-entry.ts covered + deferred families, design 09 §4).
declare module '@deepseek-ai/dsh-client-connection/client'
declare module '@deepseek-ai/dsh-client-ui-dockkit'
declare module '@deepseek-ai/dsh-typert-registry/client'
declare module '@deepseek-ai/dsh-api-gateway/client'
declare module '@deepseek-ai/dsh-api-remotes/client'
declare module '@deepseek-ai/dsh-client-ui-agent-preset/client'
declare module '@deepseek-ai/dsh-client-file-upload/client'
declare module '@deepseek-ai/dsh-session-log-export/client'
declare module '@deepseek-ai/dsh-client-ui-approval/client'
declare module '@deepseek-ai/dsh-client-ui-attachment/client'
declare module '@deepseek-ai/dsh-client-ui-brand-official/client'
declare module '@deepseek-ai/dsh-client-ui-chat/client'
declare module '@deepseek-ai/dsh-client-ui-commands/client'
declare module '@deepseek-ai/dsh-client-ui-conversation/client'
declare module '@deepseek-ai/dsh-client-ui-deliverables/client'
declare module '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'
declare module '@deepseek-ai/dsh-client-ui-goal/client'
declare module '@deepseek-ai/dsh-client-ui-input-trigger/client'
declare module '@deepseek-ai/dsh-client-ui-jobs/client'
declare module '@deepseek-ai/dsh-client-ui-message-feedback/client'
declare module '@deepseek-ai/dsh-client-ui-model-selection/client'
declare module '@deepseek-ai/dsh-client-ui-permission-presets/client'
declare module '@deepseek-ai/dsh-client-ui-plan/client'
declare module '@deepseek-ai/dsh-client-ui-reference/client'
declare module '@deepseek-ai/dsh-client-ui-renderer/client'
declare module '@deepseek-ai/dsh-client-ui-settings/client'
declare module '@deepseek-ai/dsh-client-ui-settings-general/client'
declare module '@deepseek-ai/dsh-client-ui-settings-models/client'
declare module '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client'
declare module '@deepseek-ai/dsh-client-ui-session/client'
declare module '@deepseek-ai/dsh-client-ui-sidebar/client'
declare module '@deepseek-ai/dsh-client-ui-skill/client'
declare module '@deepseek-ai/dsh-client-ui-subagent/client'
declare module '@deepseek-ai/dsh-client-ui-theme/client'
declare module '@deepseek-ai/dsh-client-ui-tool/client'
declare module '@deepseek-ai/dsh-client-ui-trajectory/client'
declare module '@deepseek-ai/dsh-client-ui-user-questions/client'
declare module '@deepseek-ai/dsh-client-ui-workflow-run/client'
declare module '@deepseek-ai/dsh-client-ui-workspace/client'
