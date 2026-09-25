/**
 * Layout plugin, browser half: one register() contributes AppFrame into the
 * runtime's 'root' slot, declares the child slots (declaration = exclusive
 * render authority), seats the layout store, and wires the ctx.layout
 * panel-action service. A second effect seats the theme presenter.
 * CHAMBER FORK (design 06 — sidebar width sharing): the vendor client index
 * with frame imports switched to the vendor deep source subpaths and the store
 * to THIS fork's `stores.ts`; everything else mirrors upstream (`inject`, the
 * eager root instance shared with the registration, the SlotMap merges, the
 * `usePanelInfo` projection, registration order), so the official bundle must
 * never load a second 'root' registration (the one-declarer rule).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { en, zh } from './shortcut-locales.ts'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import { createLayoutStore, trackLayoutInstance } from './stores.ts'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { ThemePresenter } from '@deepseek-ai/dsh-client-ui-layout/src/client/theme-presenter.ts'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core'
import { createDocumentThemeProjector, type DocumentThemeSnapshot } from './document-theme.ts'
import { resolveSourceThemeCache } from './theme-cache.ts'

/**
 * Page-wide document theme writer: ONE vendor ThemePresenter for the whole
 * document; instance teardown never disposes it (that would strip the ACTIVE
 * view's palette). See `document-theme.ts`.
 */
let documentThemePresenter: ThemePresenter | undefined

/** Project one resolved snapshot onto the shared document. */
function applyDocumentTheme(snapshot: DocumentThemeSnapshot): void {
  ;(documentThemePresenter ??= new ThemePresenter()).apply(snapshot)
}

// Contract exports only: cross-package consumers keep a symbol exported;
// package-internal symbols live off /src.
export { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
export type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
export type { LayoutState } from './store-core.ts'

/** Selector hook over root-scoped panel selection (the `usePanelInfo` seat). */
export type UsePanelInfo = SnapshotSelectorHook<PanelInfo>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('@deepseek-ai/dsh-client-ui-layout/src/client/service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Subscribe to the selected main panel independently of parent renders. */
    usePanelInfo: UsePanelInfo
    /**
     * chamber extension (design 09): this entry's API base path (`/api/i/<id>`)
     * as a plain prop; the ui-chat vendor patch builds the file-API URL from it.
     * Absent on official-layout deployments, where the patch falls back upstream.
     */
    chamberFileApiBase?: string
  }

  interface SlotMap {
    // The 'root' entry is the runtime's built-in slot; these four are the
    // frame's children, declared by the same register() call that contributes AppFrame.
    /**
     * The whole left column, OCCUPIED by ui-sidebar's SidebarRoot: registering
     * here REPLACES the navigation column and the seats it declares. The
     * occupant receives the live collapsed/width column state.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /** Central panel selected by sidebar entry id; the reserved `conversation` key hosts the Conversation. */
    'main': { kind: 'keyed'; scope: 'root' }
    /**
     * The right column: a track the centre makes room for, or nothing. Shown/track
     * state is the occupant's own recorded business reported through `ctx.layout`.
     */
    'rightbar': { kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }
    /**
     * Frame-wide floating layer above every column, click-through (entries opt
     * back into pointer events). Additive: a fresh `id` joins the shipped entries.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
    /**
     * Frame top-left window-chrome seat, mounted only while the darwin collapse
     * hides the sidebar column entirely (the column is width 0 then). The frame
     * owns placement and the `--dsh-frame-leading-clearance` band; the chamber
     * sidebar fork occupies it with the reopen / New Session controls.
     */
    'shell.leading': { kind: 'single'; scope: 'root' }
  }
}

// OwnerShare contracts: the render-side share a slot owner supplies at renderSlot.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Right column owner share: resolved normal geometry and opening eligibility. */
export interface RightbarOwnerProps {
  /** Resolved normal panel width in px, not the saved preference; zero if it cannot fit. */
  width: number
  /** Current frame width in px. */
  viewportWidth: number
  /**
   * Whether a normal right panel can retain 300px beside a 400px center; before
   * a narrow opening, includes the space from collapsing the left sidebar.
   */
  canShow: boolean
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'theme', 'locale', 'shortcuts']

/**
 * Client plugin body: provide ctx.layout, then one register() call seating
 * AppFrame with its child slots and the shared root instance.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('shortcuts.layout', { zh, en }), 'layout: command labels')
  const t = ctx.locale.bind('shortcuts.layout')

  ctx.effect(() => {
    // Minted EAGERLY and shared with the registration: AppFrame reads it through
    // PropsStore, ctx.layout wraps its bound actions, usePanelInfo projects panelInfo.
    const handle = createLayoutStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    // Register the instance so the shared view-prefs subscription adopts cross-shell width changes.
    trackLayoutInstance(instance)
    const retainMainPanels = (): void => {
      instance.actions.retainMainPanels(ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: listener => instance.subscribe(listener),
    }
    const layout = new LayoutController(instance.actions, id =>
      ctx.slots.entries('main').some(entry => entry.options.key === id), panelInfo)
    // chamber patch (design 09): the per-entry API base as an immutable root
    // standard prop for the ui-chat vendor patch. The ctx proxy THROWS for an
    // absent member; unguarded, this read before the 'root' registration below
    // would take the whole frame down, so it is probed defensively.
    let chamberFileApiBase: string | undefined
    try {
      chamberFileApiBase = (ctx as ClientContext & { chamberBasePath?: string }).chamberBasePath
    } catch {
      chamberFileApiBase = undefined
    }
    const disposePanelInfo = ctx.slots.provideRoot({
      hooks: { panelInfo: layout.panelInfo },
      props: chamberFileApiBase === undefined ? {} : { chamberFileApiBase },
    })
    const disposeService = ctx.reflect.provide('layout', layout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: 'common',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
        'shell.leading': { kind: 'single', scope: 'root' },
      },
      // Exclusive store: the shared root instance (delivered to AppFrame as standard props).
      store,
    }, AppFrame)
    const disposeShortcut = ctx.shortcuts.register({
      id: 'sidebar.left.toggle' as ShortcutCommandId, label: () => t('toggle'), aliases: ['sidebar', 'toggle left sidebar'],
      defaults: {
        'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyB', modifiers: ['primary'] },
        'web:macos': { code: 'KeyB', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] },
      },
      regions: ['page', 'editable'], modals: [],
      resolve: () => ({ status: 'handled', run: () => { layout.toggleSidebar() } }),
    })
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()
    return () => {
      disposeShortcut()
      layout.dispose()
      disposePanels()
      disposeRegistration()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
      disposePanelInfo()
    }
  }, 'ui-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots, event-driven only.
  // CHAMBER FORK: only the ACTIVE view's instance may project and teardown never retracts it.
  ctx.effect(() => {
    // The ctx proxy THROWS for an un-provided service, so the boot fact is read
    // defensively to keep the projector failing open.
    let instanceId: string | undefined
    try {
      instanceId = (ctx as ClientContext & { chamberInstanceId?: string }).chamberInstanceId
    } catch {
      instanceId = undefined
    }
    const cache = resolveSourceThemeCache()
    // The first snapshot is the runtime's PROVISIONAL value, so it must never
    // become a source palette; identity is a sound settledness gate.
    const initial = ctx.theme.getTheme()
    const projector = createDocumentThemeProjector(instanceId, {
      getActiveSource: () => chamberBridge.getActiveSource(),
      onActiveSource: listener => chamberBridge.onActiveSource(listener),
      apply: applyDocumentTheme,
    }, {
      cache,
      isSettled: snapshot => snapshot !== initial,
    })
    projector.project(initial)
    const off = ctx.on('theme/change', (snapshot) => { projector.project(snapshot) })
    return () => {
      off()
      projector.dispose()
    }
  }, 'ui-layout: document theme presenter (active view only)')
}
