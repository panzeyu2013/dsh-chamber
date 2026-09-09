/**
 * Layout plugin, browser half: one register() call contributes AppFrame into
 * the runtime's built-in 'root' slot and, in the same breath, declares the
 * child slots (declaration = exclusive render authority), seats the layout
 * store (panel geometry + main-panel selection), and wires the panel-action
 * service face. ctx.layout is the cross-plugin panel-action contract
 * (`selectPanel` / `toggleSidebar` / `openRightbar` / `closeRightbar`);
 * Session selection lives with the runtime sessions service. A second effect
 * seats the theme presenter, which projects ctx.theme snapshots onto
 * document.body.
 *
 * CHAMBER FORK (design 06 — sidebar width sharing): verbatim copy of the
 * vendor `@deepseek-ai/dsh-client-ui-layout` client index with the frame
 * imports switched to the vendor deep source subpaths
 * (`@deepseek-ai/dsh-client-ui-layout/src/client/…` — resolved to source by
 * the renderer's deepseekSource plugin) and the store to THIS fork's
 * `stores.ts` (shared + persisted sidebar width). Everything else mirrors the
 * upstream `dsh-v0.1.5-alpha.2` client index — `inject: ['slots', 'theme',
 * 'locale']`, the eager root instance shared with the registration
 * (`store: { ...handle, create: () => instance }`), the SlotMap merges
 * (`sidebar` / keyed `main` / `rightbar` / `shell.overlay`),
 * SidebarOwnerProps/RightbarOwnerProps, the `usePanelInfo` root hook
 * projection, LayoutController construction, registration order and priority —
 * so the official bundle must never load (a second 'root' registration at
 * priority 0 would throw the one-declarer rule; see chamber-covered.ts).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import { SIDEBAR_AUTO_COLLAPSE } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { createLayoutStore, trackLayoutInstance } from './stores.ts'
import type { LayoutState } from './store-core.ts'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import { ThemePresenter } from '@deepseek-ai/dsh-client-ui-layout/src/client/theme-presenter.ts'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { createDocumentThemeProjector, type DocumentThemeSnapshot } from './document-theme.ts'

/**
 * Page-wide document theme writer: ONE vendor ThemePresenter for the whole
 * document (this module is statically imported by the chamber composite entry,
 * so every per-instance boot reaches the same copy). Instance teardown never
 * disposes it — the projection belongs to whichever view is active next, and
 * the vendor `dispose()` would strip the ACTIVE view's palette. See
 * `document-theme.ts`.
 */
let documentThemePresenter: ThemePresenter | undefined

/** Project one resolved snapshot onto the shared document. */
function applyDocumentTheme(snapshot: DocumentThemeSnapshot): void {
  ;(documentThemePresenter ??= new ThemePresenter()).apply(snapshot)
}

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
export type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
export type { LayoutState } from './store-core.ts'

/** Selector hook over root-scoped panel selection (the `usePanelInfo` seat). */
export type UsePanelInfo = SnapshotSelectorHook<PanelInfo>

/**
 * CHAMBER FORK (design 17 §18 — mobile surface): the layout FACTS face —
 * snapshot + subscription + the frame's collapsed derivation for cross-plugin
 * consumers (the mobile adaptation plugin), provided per-ctx as
 * `ctx.layoutFacts`. The root instance is minted EAGERLY by this plugin's
 * apply (the alpha.2 baseline), so the face binds to that one instance
 * directly; per-ctx scoping is the ctx lifecycle's own. `getCollapsed()`
 * mirrors AppFrame's derivation (`narrow = viewportWidth < SIDEBAR_AUTO_COLLAPSE`,
 * then `narrow ? !narrowExpanded : sidebar === 0`), so consumers never restate
 * the vendor breakpoint constant.
 */
export interface LayoutFacts {
  /** Current store snapshot (panel selection + frame/panel geometry). */
  getLayoutSnapshot(): LayoutState
  /** AppFrame's derived sidebar-collapsed flag for the current snapshot. */
  getCollapsed(): boolean
  /** Subscribe to snapshot changes; fires once immediately on subscribe. */
  subscribeLayout(listener: () => void): () => void
}

/** AppFrame's collapsed derivation over one snapshot (single source of truth). */
function collapsedOf(snapshot: LayoutState): boolean {
  const { sidebar, viewportWidth, narrowExpanded } = snapshot.layoutInfo
  return viewportWidth < SIDEBAR_AUTO_COLLAPSE ? !narrowExpanded : sidebar === 0
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('@deepseek-ai/dsh-client-ui-layout/src/client/service.ts').ILayout
    /** Design 17 §18 mobile surface: layout facts for cross-plugin consumers.
     * OPTIONAL on purpose: the service exists only in the chamber fork —
     * deployments running the official ui-layout (gateway-hosted instances)
     * do not provide it, so consumers must probe (and cannot declare it in
     * `inject`, which would hard-fail the boot there). */
    layoutFacts?: LayoutFacts
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    /** Subscribe to the selected main panel independently of parent renders. */
    usePanelInfo: UsePanelInfo
  }

  interface SlotMap {
    // The 'root' entry itself is the runtime's built-in slot (declared
    // there); these four are the frame's children, declared by the same
    // register() call that contributes AppFrame. Session owners never pass
    // sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's live column state (collapsed, width)
     * and is expected to render the compact control rail while collapsed.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /**
     * Central panel selected by sidebar entry id. The reserved `conversation`
     * key hosts the Conversation; other keys receive no Session binding.
     */
    'main': { kind: 'keyed'; scope: 'root' }
    /**
     * The right column: a track the centre makes room for, or nothing.
     * OCCUPIED by the right Sidebar, which uses the resolved column width in
     * normal mode and covers the viewport in fullscreen, retaining the
     * wide-screen column reservation underneath.
     *
     * Whether the panel is shown, and whether it takes a track, is the
     * occupant's own recorded business — it reports the composition of its
     * expanded and presentation state through `ctx.layout`, and the frame
     * sizes the track and places the resize handle from that. The expand
     * control is not this column's: it is a button in the conversation header.
     * The root occupant decides when to render its Session-bound content.
     */
    'rightbar': { kind: 'single'; scope: 'root'; owner: RightbarOwnerProps }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I).

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
   * Whether a normal right panel can retain 300px beside a 400px center.
   * Before a narrow opening, includes the space from collapsing the left sidebar.
   */
  canShow: boolean
}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme', 'locale']

/**
 * Client plugin body: provide ctx.layout, then one register() call — AppFrame
 * into 'root' with the child-slot declarations, the layout store seat, and the
 * shared root instance supplying commands and the panel-info source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // The root instance is minted EAGERLY and shared with the registration
    // (upstream baseline): AppFrame reads it through PropsStore, ctx.layout
    // wraps its bound actions, and the usePanelInfo hook projects its
    // panelInfo slice as a root-standard source.
    const handle = createLayoutStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    // chamber fork (design 06): register the instance so the shared
    // view-prefs subscription adopts cross-shell sidebar-width changes.
    trackLayoutInstance(instance)
    const layout = new LayoutController(instance.actions, id =>
      ctx.slots.entries('main').some(entry => entry.options.key === id))
    const retainMainPanels = (): void => {
      instance.actions.retainMainPanels(ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const panelInfo: HostObservable<PanelInfo> = {
      getSnapshot: () => instance.getSnapshot().panelInfo,
      subscribe: listener => instance.subscribe(listener),
    }
    const disposePanelInfo = ctx.slots.provideRoot({ hooks: { panelInfo } })
    const disposeService = ctx.reflect.provide('layout', layout)
    // CHAMBER FORK (design 17 §18 — mobile surface): layout facts bound to the
    // one root instance this ctx minted. Subscribers get the current snapshot
    // immediately, then every change; per-listener isolation mirrors the
    // store-core adoption guard (one throwing consumer must not starve its
    // siblings).
    const listeners = new Set<() => void>()
    const notifyLayout = (): void => {
      for (const listener of listeners) {
        try {
          listener()
        } catch (error) {
          console.error('[dsh-chamber] layoutFacts subscriber threw:', error)
        }
      }
    }
    const layoutFacts: LayoutFacts = {
      getLayoutSnapshot: () => instance.getSnapshot(),
      getCollapsed: () => collapsedOf(instance.getSnapshot()),
      subscribeLayout: listener => {
        listeners.add(listener)
        listener()
        return () => { listeners.delete(listener) }
      },
    }
    const disposeFacts = ctx.reflect.provide('layoutFacts', layoutFacts)
    const unsubscribeInstance = instance.subscribe(notifyLayout)
    const disposeRegistration = ctx.slots.register({
      name: 'root',
      locale: 'common',
      children: {
        'sidebar': { kind: 'single', scope: 'root' },
        'main': { kind: 'keyed', scope: 'root' },
        'rightbar': { kind: 'single', scope: 'root' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
      // Exclusive store: the shared root instance — the framework delivers
      // useStore/actions to AppFrame as standard props.
      store,
    }, AppFrame)
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()
    return () => {
      layout.dispose()
      disposePanels()
      disposeRegistration()
      unsubscribeInstance()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
      void disposeFacts()
      disposePanelInfo()
    }
  }, 'ui-layout: service + root registration')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  // CHAMBER FORK (N-ctx hardening): the document is shared by every mounted
  // view, so only the ACTIVE view's instance may project onto it and teardown
  // must never retract it — see document-theme.ts.
  ctx.effect(() => {
    // The cordis ctx proxy THROWS for an un-provided service rather than
    // returning undefined, so a fork mounted on a ctx without the chamber boot
    // fact must be read defensively — otherwise apply() throws instead of the
    // projector failing open (2026-12 review MINOR-1; same discipline as the
    // mobile plugin's layoutFacts probe).
    let instanceId: string | undefined
    try {
      instanceId = (ctx as ClientContext & { chamberInstanceId?: string }).chamberInstanceId
    } catch {
      instanceId = undefined
    }
    const projector = createDocumentThemeProjector(instanceId, {
      getActiveSource: () => chamberBridge.getActiveSource(),
      onActiveSource: listener => chamberBridge.onActiveSource(listener),
      apply: applyDocumentTheme,
    })
    projector.project(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { projector.project(snapshot) })
    return () => {
      off()
      projector.dispose()
    }
  }, 'ui-layout: document theme presenter (active view only)')
}
