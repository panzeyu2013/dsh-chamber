/**
 * The boot-graph entry ids the chamber page covers WITHOUT the host graph — the
 * dedupe set the per-instance host-graph merge filters against (dedupeCoveredRows).
 * Loading any of these again from the host graph would register the same plugin
 * twice on one cordis ctx (duplicate provide / slot), so they are skipped, never
 * loaded — mostly the client plugin packages the composite registers, plus the
 * page-own rows (ui-sidebar / ui-modules / ui-renderer / ui-layout) and the one
 * seed platform word that must be deduped (`@deepseek-ai/dsh-client-store`; the page
 * seed answers it, the composite registers no factory for it).
 *
 * The deliberate extra ids — covered but never loaded — are the skips: hmr /
 * directory-picker-native. They are page-own rows the composite replaces
 * plus host rows the shell drops on purpose; each carries its own reason below,
 * and design 09 §3.5 有意跳过名单 owns their re-review. (settings-account left that
 * list in alpha.3: covered DEFERRED row, desktop overlay gated off by the
 * build-time vendor patch — design 09 §3.5 ③.)
 *
 * Maintenance: a plugin import added to chamber-entry.ts must append its package
 * name here in the same batch (missing ids fail LOUD at boot; extra ids are
 * harmless). Lockstep with chamber-entry.ts COVERED_FACTORIES: every factory id
 * must be covered here. Own module so shell.ts can import it without pulling
 * chamber-entry.ts's module-table handoff into the main chunk.
 */

/**
 * The shell seed's platform words (`packages/dsh-client-web/src/platform.ts` PLATFORM_MODULES):
 * the module system registers them at CREATION, before any bundle executes. The composite
 * must NEVER factory-register one — a second registration is boot-fatal — and the
 * unsatisfiable-external predicate treats them as answered. Pinned against the seed source
 * by test; the local copy keeps the renderer's pure modules importable under plain node.
 */
export const SEED_PLATFORM_IDS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
]

export const CHAMBER_COVERED_IDS: readonly string[] = [
  // chamber composite registration (chamber-entry.ts import list)
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  // alpha.3: required by ui-session/ui-workspace (remoteAccess inject); first-screen.
  '@deepseek-ai/dsh-api-remote-access',
  // 0.2.2: required by ui-chat/ui-attachment (fileDrag inject); first-screen.
  '@deepseek-ai/dsh-client-ui-file-drag',
  // 0.2.2-alpha.3: the context-menu hub. It provides the useContextMenu root standard
  // prop that the covered ui-chat/ui-deliverables read at render, and the contextMenus
  // service ui-workspace/ui-sidebar-right/ui-open-in-app inject. Covered first-screen for
  // the same reason as shortcuts/file-drag: an uncovered provider leaves covered families
  // PENDING (or throws at render) on a degraded or older host graph while boot reports success.
  '@deepseek-ai/dsh-client-ui-context-menu',
  '@deepseek-ai/dsh-api-remotes',
  // provider group: the platform store word (seed-answered; listed here only so a host
  // that ever serves it as a graph row never double-mounts the store engine), the two
  // api controllers (ctx.sessions / ctx.workspaces), and the three conversation
  // families the web roster carries.
  '@deepseek-ai/dsh-client-store',
  // C3: ui-primitives is NOT a loader row — it joins the covered + factory set so
  // the composite answers the platform-word require edges of extra bundles after
  // the seed dropped the word. An id absent from a host graph is never filtered,
  // and the union-table lockstep demands it (factory id ∈ covered).
  '@deepseek-ai/dsh-client-ui-primitives',
  // ui-dockkit is a PLATFORM_MODULES word answered by the composite's covered
  // factory (the seed deliberately omits it). It has no `dsh.client`, so it is
  // never a host-graph row; listing it keeps the factory-id lockstep assert.
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-locale',
  // The official ui-layout/ui-workspace inject faces name `shortcuts`, whose
  // ONLY provider is @deepseek-ai/dsh-client-shortcuts (inject: ['locale']).
  // Uncovered it was a second reverse dependency on a host-graph row: a degraded
  // or failed graph channel left the layout/workspace fibers PENDING and the
  // whole shell unregistered while boot still reported success; the covered
  // locale already satisfies its inject face, so the provider is first-screen now.
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-ui-theme',
  '@dsh-chamber/dsh-chamber-client-ui-layout',
  '@dsh-chamber/dsh-chamber-client-ui-sidebar',
  '@dsh-chamber/dsh-chamber-client-ui-git',
  '@dsh-chamber/dsh-chamber-client-ui-open-in',
  // ui-settings stays FIRST-SCREEN (C4): locale/ui-theme root-inject its
  // configForms service; its section families + the chamber settings shell/connections
  // are deferred (ids stay covered).
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-jobs',
  '@deepseek-ai/dsh-client-ui-goal',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-message-feedback',
  '@deepseek-ai/dsh-client-ui-plan',
  '@deepseek-ai/dsh-client-ui-skill',
  '@deepseek-ai/dsh-client-ui-subagent',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-trajectory',
  '@deepseek-ai/dsh-client-ui-user-questions',
  '@deepseek-ai/dsh-client-ui-workflow-run',
  '@deepseek-ai/dsh-client-ui-agent-preset',
  '@deepseek-ai/dsh-client-ui-deliverables',
  // conversation families (first-screen static imports, chamber-entry.ts):
  '@deepseek-ai/dsh-client-ui-session',
  // alpha.1: the Session status table (running / pendingInteraction / completionUnread /
  // completionFailed) moved OUT of ui-session into its own package/service
  // (`uiSession.sessionStatus`); the covered conversation/workspace families + the chamber
  // sidebar inject it, so the composite must register the row first-screen (a host-graph
  // load would double-register the service, and a missing row leaves those fibers PENDING).
  '@deepseek-ai/dsh-client-ui-session-status',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-approval',
  // The background-upload client is composite-covered for two reasons: two
  // packages root-inject `fileUpload`, and its vendor bundle builds a same-origin
  // absolute upload URL that 404s under the N-ctx shell — only a composite-bundled
  // copy can carry the registered vendor patch.
  '@deepseek-ai/dsh-client-file-upload',
  // Directory picking: the composite pins the `browse` interaction (the host pins
  // the same per spawn), so the picker-auto-mounted browse row is covered too.
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  // The session-log export client is composite-covered (deferred) for the same
  // reason as file-upload: its vendor bundle builds a same-origin absolute export
  // URL that 404s under the N-ctx shell.
  '@deepseek-ai/dsh-session-log-export',
  // chamber skips (covered, no factory, never loaded into the chamber shell):
  // page-own rows plus the host rows the shell deliberately drops. The `native`
  // directory-picker face can never win because the host's picker interaction is
  // pinned to `browse`.
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  // The official desktop account family is NOT skipped any more (alpha.3): the build-time
  // vendor patch gates its desktop-onboarding shell.overlay seat off (the overlay took
  // over #root and parked without desktop configForms), and chamber-entry loads the row
  // from the DEFERRED cluster, so the account settings section registers normally.
  '@deepseek-ai/dsh-client-ui-settings-account',
  // deferred families (registerDeferred dynamic imports): registered after the
  // boot settles — composite-owned namespaces all the same, so a host-graph row
  // would double-register the package on the same ctx.
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-reference',
  // C4 settings cluster (registerDeferred): the official settings sections + the
  // chamber settings shell & connections register after settle; ui-settings itself
  // stays first-screen. Ids stay covered: loading any row again would
  // double-register once the deferred chunk registers it. The only observable
  // transient is the settings entry being absent for ≈1 chunk round-trip; until
  // it lands the panel shows the "starting that instance's frontend" state.
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  // The upstream plugin-manager entry registers a permanent sidebar panel; the
  // chamber replacement mounts the same page as its own Settings section.
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@dsh-chamber/dsh-chamber-client-ui-settings-plugin-manager',
  '@dsh-chamber/dsh-chamber-client-ui-settings-connections',
  '@dsh-chamber/dsh-chamber-client-ui-settings-bridge',
  // Remote Browser launcher (design 28): a deferred row. Its apply() registers a
  // sidebar-right tab type, the keyed body/title seats and a locale namespace on
  // local and every SSH source; an http source leaves no trace. Covered so the
  // host graph can never load a second copy.
  '@dsh-chamber/dsh-chamber-client-ui-browser',
  // page-own rows (see header comment)
  '@deepseek-ai/dsh-client-ui-sidebar',
  // The official layout registration the chamber ui-layout fork REPLACES: loading
  // it would register a second 'root' entry — rejected by the one-declarer rule.
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-modules',
  // The renderer install lives in this row (the boot mounts through the row's
  // ctx.uiRenderer), so a second entry would install a second slot renderer.
  // Page-own only, no factory: chamber-entry never imports it.
  '@deepseek-ai/dsh-client-ui-renderer',
  // The official HMR entry (0.2.3-alpha.1: an authenticated `pluginEvents/follow` Remote
  // stream; rc.3 and earlier: a document-relative `new EventSource('plugins/events')`).
  // Its client half drives the PAGE-LEVEL `modules.entries` reconciler, which cannot run
  // per instance under N-ctx (one page, one module system, one entries controller). The
  // chamber shell therefore mounts the same generated `pluginEvents` contribution and
  // follows the stream from EACH instance's ctx (hmr-events.ts + live-graph.ts), and this
  // client row stays skipped forever (page-own, no factory).
  '@deepseek-ai/dsh-client-hmr',
  // The official open-in client row is NOT skipped any more (D2): it loads from
  // the host graph so its file-level surfaces register — the right-sidebar
  // document actions (sidebar.right.tab.document.actions / .unpreviewable) and
  // the deliverables file actions (deliverables[.review].file.actions), whose
  // owner route (api/present.open / api/changes.open) the ui-deliverables covered
  // fork prefixes per entry (design 09 §3.6); the document seats carry only an
  // absolutePath and stay on their own per-instance source, not on open-in's host
  // half. Its directory entries — the header one (id open-in-app at
  // conversation.session.header.utilities) and the Files-tab one (same id at
  // sidebar.right.tab.files.actions, owner {absolutePath}) — read the
  // document-relative open-in-app/* routes, which resolve to the control-plane
  // origin this composite page is served from (only host-graph bundle urls get
  // the per-instance prefix — host-graph.ts toExtraRows; the control plane answers
  // the SPA fallback HTML, which the controller's json() rejects and swallows as an
  // empty app list), and the official HOST half is disabled by the per-spawn overlay
  // while dsh-chamber-seed-open-in is seeded — so both directory entries render null
  // here. The effective directory-open entry is
  // @dsh-chamber/dsh-chamber-client-ui-open-in (id open-in) in BOTH slots (header
  // order -10 beside the vendor Session log; the Files-tab actions hole at the
  // default order the official occupant uses); the ids differ, so list entries coexist, and
  // if the official entries ever become live the shell shows two directory entries —
  // the residual risk registered in design 20 §7.2 and the checklist §4.6 row.
]

/**
 * The first-screen families the chamber composite statically imports and
 * registers a module-table factory for (chamber-entry.ts COVERED_FACTORIES).
 * This leaf list is the TESTABLE contract behind the map (chamber-entry cannot
 * be imported by the node test runner):
 *
 *   every id here ∈ CHAMBER_COVERED_IDS (else the composite's own factory
 *   registration collides with the host-graph row's bundle — double register);
 *   chamber-entry asserts the map matches this list EXACTLY at execution.
 *
 * Maintenance: one first-screen family = one import + one map row + one id here
 * + one id in CHAMBER_COVERED_IDS, in the same batch.
 */
export const CHAMBER_COVERED_FACTORY_IDS: readonly string[] = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  // alpha.3: required by ui-session/ui-workspace (remoteAccess inject); first-screen.
  '@deepseek-ai/dsh-api-remote-access',
  // 0.2.2: required by ui-chat/ui-attachment (fileDrag inject); first-screen.
  '@deepseek-ai/dsh-client-ui-file-drag',
  // 0.2.2-alpha.3: the context-menu hub. It provides the useContextMenu root standard
  // prop that the covered ui-chat/ui-deliverables read at render, and the contextMenus
  // service ui-workspace/ui-sidebar-right/ui-open-in-app inject. Covered first-screen for
  // the same reason as shortcuts/file-drag: an uncovered provider leaves covered families
  // PENDING (or throws at render) on a degraded or older host graph while boot reports success.
  '@deepseek-ai/dsh-client-ui-context-menu',
  '@deepseek-ai/dsh-api-remotes',
  // provider group: the controllers and conversation families are first-screen plugins.
  // The store word is seed-answered (PLATFORM_MODULES) and must NEVER be a factory here:
  // the seed registers it before any bundle executes and a second registration is
  // boot-fatal. C3: ui-primitives joins here — a platform word the seed dropped
  // (factory only).
  '@deepseek-ai/dsh-client-ui-primitives',
  // the docking-kit word answered by the composite factory.
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-locale',
  // The official ui-layout/ui-workspace inject faces name `shortcuts`, whose
  // ONLY provider is @deepseek-ai/dsh-client-shortcuts (inject: ['locale']).
  // Uncovered it was a second reverse dependency on a host-graph row: a degraded
  // or failed graph channel left the layout/workspace fibers PENDING and the
  // whole shell unregistered while boot still reported success; the covered
  // locale already satisfies its inject face, so the provider is first-screen now.
  '@deepseek-ai/dsh-client-shortcuts',
  '@deepseek-ai/dsh-client-ui-theme',
  '@dsh-chamber/dsh-chamber-client-ui-layout',
  '@dsh-chamber/dsh-chamber-client-ui-sidebar',
  '@dsh-chamber/dsh-chamber-client-ui-git',
  '@dsh-chamber/dsh-chamber-client-ui-open-in',
  // ui-settings stays FIRST-SCREEN (C4 — locale/ui-theme root-inject its
  // configForms service); the deferred settings sections + chamber settings shell/
  // connections have NO static factory (see CHAMBER_COVERED_IDS).
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-conversation',
  // commands + input-trigger are first-screen covered factories: model-selection
  // needs commandUi from commands, commands needs inputTriggers from
  // input-trigger — the three move as one.
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-model-selection',
  // conversation families (first-screen: factories must be registered before any
  // loader entry materializes).
  '@deepseek-ai/dsh-client-ui-session',
  // alpha.1: the extracted Session status table, covered first-screen with its factory
  // (the chamber sidebar's status producer and the covered conversation families consume
  // `uiSession.sessionStatus`; see CHAMBER_COVERED_IDS).
  '@deepseek-ai/dsh-client-ui-session-status',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
]
