/**
 * Chamber open-in client plugin: ONE entry component serving TWO seats — the
 * conversation header utility entry and (rc.2) the official Files-tab
 * directory-actions seat — over the per-source view-model.
 *
 *  - the machine catalog (installed apps + real bundle icons + local launches)
 *    is read ONCE per page from the LOCAL instance's `openInApp/*` host domain
 *    and injected into every entry as `chamberMachineCatalog`: "what is installed
 *    on this machine" is a machine fact, exactly as upstream treats it;
 *  - this source's launch capability selects from that catalog: a LOCAL source
 *    launches on the machine directly, a remote ssh source keeps only the main
 *    provider's `remoteCapable` entries (the VS Code Remote-SSH carrier).
 *
 * The slot is session-scoped, so the component receives the per-header
 * `sessionId` and the framework's global `useWorkspaces` hook — no direct ctx
 * store access. Per-entry facts ride this ctx (`chamberInstanceId`,
 * `chamberTransport`, `chamberSourceFingerprint`): the source id and transport
 * decide the matrix, and the fingerprint is the exact-boot proof the trusted
 * main process verifies before a launch. This entry owns no connection carrier.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OpenInButton, type OpenInInjected } from './OpenInButton.tsx'
import { createOpenInSourceAdapter } from './source-adapter.ts'
import { registerSessionStreamHealthSeat } from './session-stream-health-seat.ts'
import type { MachineCatalog } from './machine-catalog.ts'
import { getOpenInChoice, setOpenInChoice, subscribeOpenInChoice } from './choice-store.ts'
import { en, zh, type OpenInKey } from '../locales.ts'
import {
  parseOpenInSource,
  parseOpenInSourceFingerprint,
} from '../shared/capabilities.ts'
import {
  bridgePlatform,
  getOpenInApps,
  refreshApps,
  subscribeOpenIn,
  type Translate,
} from '../shared/coordinator.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.open-in': OpenInKey
  }
  interface SlotMap {
    /**
     * Official rc.2 hole: workspace directory actions after the file tree's
     * reload control (declared by ui-sidebar-files, occupied by ui-open-in-app).
     * chamber occupies it too with its own list id — the official occupant's
     * document-relative `open-in-app/*` reads fall through to the SPA-fallback
     * HTML at the control-plane origin under N-ctx and render nothing.
     *
     * This mirror is the DOCUMENTATION/type half only: the package program
     * compiles against the loose vendor declaration (SlotMap is empty there),
     * so the source lock in test/ui-lock/files-seat-declaration.test.ts is
     * what actually keeps the shape aligned with vendor ui-sidebar-files.
     */
    'sidebar.right.tab.files.actions': {
      kind: 'list'
      scope: 'session'
      owner: {
        /** Absolute directory path displayed by the file tree. */
        readonly absolutePath: string
      }
    }
  }
}

/** The official conversation header utilities slot (beside "Session log"). */
const OPEN_IN_HEADER_SLOT = 'conversation.session.header.utilities' as const
/** The official Files-tab directory-actions slot (rc.2). */
const FILES_ACTIONS_SLOT = 'sidebar.right.tab.files.actions' as const
const NS = 'dsh-chamber.open-in'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: open-in dictionaries')

  const t = ctx.locale.bind(NS) as Translate

  // Session stream-health seat (the recovery arm for the ui-chat freeze),
  // registered BEFORE the open-in gates so an unparseable source still gets it.
  registerSessionStreamHealthSeat(ctx, t)

  // Per-boot instance id provided by chamber-entry; loose cast (the vendor cordis
  // face stays loose). Bail on an absent id: the gate-2 local check would
  // otherwise let a bogus '' source render a button that can only fail.
  const source = parseOpenInSource(
    (ctx as { chamberInstanceId?: string }).chamberInstanceId,
    (ctx as { chamberTransport?: 'local' | 'ssh' | 'http' }).chamberTransport,
  )
  if (source === null) return
  const sourceFingerprint = parseOpenInSourceFingerprint(
    source,
    (ctx as { chamberSourceFingerprint?: string }).chamberSourceFingerprint,
  )
  if (sourceFingerprint === null) return

  // The machine catalog is a PAGE fact (built once by the renderer shell for the
  // LOCAL instance); this entry reads it and never builds a per-source copy.
  const machineCatalog = (ctx as { chamberMachineCatalog?: MachineCatalog }).chamberMachineCatalog ?? null

  // Per-source adapter: owns the rendered-set merge (machine catalog + page-wide
  // main pool), the per-entry channel routing (local → host domain, main →
  // trusted preload IPC with the exact-boot proof), plus the persisted choice.
  const adapter = createOpenInSourceAdapter({
    source,
    sourceFingerprint,
    translate: t,
    machineCatalog,
    mainPool: { get: getOpenInApps, subscribe: subscribeOpenIn, refresh: refreshApps },
    // The remembered app is per source: one page serves every source, so a shared
    // key would let a remote target overwrite the local choice (and vice versa).
    choice: {
      get: () => getOpenInChoice(source.sourceId),
      set: (appId: string) => { setOpenInChoice(source.sourceId, appId) },
      subscribe: subscribeOpenInChoice,
    },
    platform: bridgePlatform(),
  })
  ctx.effect(() => () => adapter.dispose(), 'dsh-chamber: open-in adapter')

  // The slot inject factory closes over ctx: it hands the component this ctx's
  // source id, bound translator and per-ctx model/launch faces.
  const injected = (): OpenInInjected => ({
    source,
    t,
    getViewModel: adapter.getViewModel,
    subscribe: adapter.subscribe,
    refresh: adapter.refresh,
    launch: adapter.launch,
    getChoice: adapter.getChoice,
    choose: adapter.choose,
    iconUrl: adapter.iconUrl,
    // 一次性读取：Swift shim 与 preload 同序（只有 info 成功才暴露 dshChamber），注入发生时
    // platform 已填；让共享插件用 getter 补偿 shim 的早暴露不是它的职责。
    platform: bridgePlatform(),
  })

  ctx.slots.inject(OPEN_IN_HEADER_SLOT, () => ctx.slots.register({
    name: OPEN_IN_HEADER_SLOT,
    // Our own id, deliberately NOT the official row's `open-in-app`. The official
    // client row now loads from the host graph (chamber-covered.ts no longer skips
    // it) for its file-level seats; its own header entry stays inert on this page
    // because it reads document-relative `open-in-app/*` routes that resolve to
    // the control-plane origin. Distinct list ids are what let both entries
    // coexist: the registry THROWS on a duplicate id at one priority.
    id: 'open-in',
    // Row order ascends by `order` (default 0). -10 is the official `open-in-app`
    // row's own value, which keeps the vendor "Session log" entry (0) at the far
    // right and places this button to its left.
    order: -10,
    // Neutral entry label (slot diagnostics — the user-facing copy comes from the component).
    label: () => t('titleOpen'),
    inject: injected,
  }, OpenInButton))
  // The official rc.2 Files-tab seat, same entry with the owner's directory:
  // the file tree hands over the displayed root, so the button opens exactly
  // what the reader is looking at. Adopted (ruling D-01 = B) after the official
  // occupant proved inert on this page (document-relative openInApp/* reads);
  // our per-source view-model and launch carrier are what make the seat usable
  // across sources. Distinct id from the official 'open-in-app', same as the
  // header seat: list entries may coexist, duplicate ids at one priority throw.
  ctx.slots.inject(FILES_ACTIONS_SLOT, () => ctx.slots.register({
    name: FILES_ACTIONS_SLOT,
    id: 'open-in',
    // No order: the official occupant keeps the default 0 and this hole has no
    // "Session log at order 0" neighbour to sort against — list rows otherwise
    // render in ledger order. Same inject closure as the header seat, so both
    // seats share one per-source adapter and one per-source choice.
    label: () => t('titleOpen'),
    inject: injected,
  }, OpenInButton))
}
