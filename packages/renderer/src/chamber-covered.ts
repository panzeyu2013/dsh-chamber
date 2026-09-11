/**
 * The boot-graph entry ids the chamber page covers WITHOUT the host graph —
 * the dedupe set the per-instance host-graph merge filters against (design 09
 * §3.3, module C: `dedupeHostEntries` in host-graph.ts).
 *
 * Mostly two families, plus a third, non-row class:
 *
 * - every client plugin package the chamber composite bundle registers
 *   (chamber-entry.ts import list — one entry per package name): the
 *   first-screen families via static import (including the dsh-v0.1.2-alpha.1
 *   provider group that replaced dsh-client-runtime: the platform store word
 *   `@deepseek-ai/dsh-client-store`, the api session/workspace controllers,
 *   and the ui-session / ui-chat / ui-approval conversation families), the
 *   rc.8 deferred families (ui-attachment / ui-brand-official / ui-reference)
 *   via the registerDeferred dynamic imports, and the C4 settings cluster
 *   (2026-09: official settings sections + the chamber settings shell &
 *   connections — ui-settings itself stays first-screen, see its comments in
 *   both lists) via the same registerDeferred path. Loading any such row again
 *   from
 *   the host graph would register the same plugin twice on one cordis ctx
 *   (cordis rejects the duplicate provide / slot), so these rows must be
 *   skipped, never loaded;
 * - page-own rows that must never arrive as graph extras:
 *   `@deepseek-ai/dsh-client-ui-sidebar` — the official sidebar registration
 *   the chamber sidebar REPLACES (loading it would collide on the sidebar
 *   slot), `@deepseek-ai/dsh-client-modules` — the shell kernel adopts that
 *   entry itself (boot.ts MODULES_ID: statically registered, never fetched),
 *   so a second entry would provide `modules` twice, and (rc.8)
 *   `@deepseek-ai/dsh-client-ui-renderer` — rc.8 moved the slot-renderer
 *   install OUT of the shell into this row (app-shell no longer installs it;
 *   the boot kernel mounts through the row's `ctx.uiRenderer`), so a
 *   host-graph row would install a second renderer / provide `uiRenderer`
 *   twice.
 *
 * Maintenance discipline: when a plugin import is added to chamber-entry.ts,
 * append its package name here in the same batch; when a row becomes
 * page-own (kernel-adopted, or replacing an official registration), append
 * it with a comment. Missing ids fail LOUD at boot (duplicate registration);
 * extra ids are harmless (a covered id absent from a host graph is never
 * filtered).
 *
 * Lockstep with the union-table factories (chamber-entry.ts COVERED_FACTORIES,
 * design 09 §3.2): every first-screen family the composite statically imports
 * registers a module-table factory under its package id — the id must be
 * covered here, or the composite's own factory registration collides with the
 * host-graph row's bundle (fail-loud assert at chamber-entry execution).
 *
 * `@deepseek-ai/cordis` is intentionally absent: it is a type-only import in
 * chamber-entry.ts, never a registered client plugin, and the host graph
 * cannot carry a row for it.
 *
 * dsh-v0.1.2-alpha.2 (decision D6): `@deepseek-ai/dsh-client-ui-cordis` (the
 * debug-surface roster row) is intentionally absent too — the chamber
 * composite does not register it and never will; "no such plugin" is
 * behaviorally identical to "plugin absent" (the official row is an opt-in
 * debugger face), so it is absent from the chamber covered/factories tables;
 * the host-graph row still preloads through the same extra-rows mechanism as
 * any other roster entry — one extra combo preload at most, never a
 * duplicate registration (review-round7b P2-5 wording).
 *
 * dsh-v0.1.2-alpha.2 roster rows without explicit coverage decisions:
 * `@deepseek-ai/dsh-client-ui-schedule` (new in alpha.2; the official row is
 * disabled and the modules loader skips disabled rows, so it never reaches
 * the host graph) and `@deepseek-ai/dsh-cordis-client-runner` (an active
 * official row the chamber composite leaves to the extra-rows preload, like
 * every non-covered active row) — both documented, no explicit exclusion
 * needed (check-round1b P2-1/P2-2).
 *
 * This constant lives in its own module (re-exported by chamber-entry.ts) on
 * purpose: shell.ts must import it without pulling chamber-entry.ts's
 * top-level module-table handoff into the main chunk.
 */

export const CHAMBER_COVERED_IDS: readonly string[] = [
  // ── chamber composite registration (chamber-entry.ts import list) ──
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  // dsh-v0.1.2-alpha.1 provider group (replaces dsh-client-runtime, which no
  // longer exists): the platform store word (a PLATFORM_MODULES seed —
  // every client bundle that value-imports the store engine emits a
  // `require("@deepseek-ai/dsh-client-store")` edge), the two api
  // controllers (ctx.sessions / ctx.workspaces), and the three conversation
  // families the web roster added (ui-session root source, ui-chat chat
  // nodes, ui-approval approval surface). All six are composite-covered:
  // loading any of them again from a host graph would double-register on
  // one ctx (or split the store engine version).
  '@deepseek-ai/dsh-client-store',
  // C3 (2026-09 性能审计): ui-primitives is NOT a loader row (never a
  // host-graph plugin) — it joins the covered + factory set so the composite
  // answers the platform-word require edges of extra bundles after the seed
  // dropped the word (dsh-client-web seed.ts/platform.ts deviation; the
  // shell.ts C3 gate orders the chamber entry before any extra load). An id
  // absent from a host graph is never filtered, so listing it is harmless —
  // the union-table lockstep asserts demand it (factory id ∈ covered).
  '@deepseek-ai/dsh-client-ui-primitives',
  // alpha.2: ui-dockkit is a PLATFORM_MODULES word answered by the composite's
  // covered factory (the seed deliberately omits it — see chamber-entry.ts).
  // It has no `dsh.client`, so it is never a host-graph row; listing it keeps
  // the factory-id lockstep assert and the require edges of the right-sidebar
  // rows satisfied.
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-theme',
  '@dsh-chamber/dsh-chamber-client-ui-layout',
  '@dsh-chamber/dsh-chamber-client-ui-sidebar',
  '@dsh-chamber/dsh-chamber-client-ui-git',
  '@dsh-chamber/dsh-chamber-client-ui-open-in',
  // ui-settings stays FIRST-SCREEN (C4, 2026-09 性能审计): locale/ui-theme
  // root-inject its settingsScope. Its section families + the chamber
  // settings shell/connections are deferred — the ids stay covered (see the
  // deferred group below).
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
  // ── dsh-v0.1.2-alpha.1 conversation families (decision D6: into the
  // ── composite; first-screen static imports, chamber-entry.ts):
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-approval',
  // 2026-09 三轮: the background-upload client is composite-covered for TWO
  // reasons — (1) `ui-conversation` and `api-session-controller` root-inject
  // `fileUpload`, and (2) the vendor bundle builds a same-origin absolute
  // upload URL (`location.origin + /api/session/uploadFileBinary`) that 404s
  // under the N-ctx shell; only a composite-bundled copy can carry the
  // registered vendor patch (design 09 §3.6), because an extra-row bundle is
  // served by the instance and never passes our build.
  '@deepseek-ai/dsh-client-file-upload',
  // Directory picking: the composite pins the `browse` interaction (the host
  // pins the same per spawn — chamber-entry.ts import comment), so the
  // picker-auto-mounted browse row is composite-covered too.
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  // 2026-09 四轮: the session-log export client is composite-covered (deferred)
  // for the same reason as file-upload — its vendor bundle builds a same-origin
  // absolute export URL (`/api/session.export`) that 404s under the N-ctx shell,
  // and only a composite-bundled copy can carry the registered vendor patch.
  '@deepseek-ai/dsh-session-log-export',
  // chamber page-own skips (covered, no factory, never loaded into the chamber
  // shell): the mobile adaptation is the GATEWAY deployment's single-shell
  // surface — a desktop attached to a gateway-kind target must not preload it
  // into the multi-shell page (its own header says its document-level effects
  // are single-shell by design); the `native` directory-picker face can never
  // win in the chamber shell because the host's picker interaction is pinned to
  // `browse` (design 02 §3.9 / 05 §4) — loading it would double-register the
  // same two single directoryFlow holes and fail the row.
  '@dsh-chamber/dsh-client-ui-mobile',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
  // ── rc.8 deferred families (chamber-entry.ts registerDeferred dynamic
  // imports, design 09 §4 baseline alignment): registered after the boot
  // settles — composite-owned namespaces all the same, so a host-graph row
  // for any of them would double-register the package on the same ctx.
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-brand-official',
  '@deepseek-ai/dsh-client-ui-reference',
  // ── C4 settings cluster (2026-09 性能审计; chamber-entry.ts
  // ── registerDeferred): the official settings sections + the chamber
  // ── settings shell & connections register after settle (official ui-settings
  // ── itself stays first-screen — locale/ui-theme root-inject its
  // ── settingsScope). Ids stay covered: loading any row again from the host
  // ── graph would double-register once the deferred chunk registers it.
  // ── 可观测瞬态仅「设置入口缺席 ≈1 chunk 往返」（页面首个实例首冷启一次
  // ── 性；其后模块缓存同 tick 解析）；面板内容经所选服务器 child ctx
  // ── 独立装载（bridge-context），不受 boot-ctx 时序影响；簇级失败面见
  // ── chamber-entry.ts registerDeferred 注释。
  '@deepseek-ai/dsh-client-ui-settings-general',
  '@deepseek-ai/dsh-client-ui-settings-models',
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@dsh-chamber/dsh-chamber-client-ui-settings-connections',
  '@dsh-chamber/dsh-chamber-client-ui-settings-bridge',
  // ── page-own rows (see header comment) ──
  '@deepseek-ai/dsh-client-ui-sidebar',
  // The official layout registration the chamber ui-layout fork REPLACES
  // (design 06): the composite registers the fork into 'root', so loading
  // the official bundle would register a second 'root' entry — a duplicate
  // declaration of the same slot at the same priority, rejected by the
  // one-declarer rule (ui-slots index.ts:800-803).
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-modules',
  // rc.8 (design 09 §4 baseline alignment): the renderer install moved OUT of
  // the shell into this row (the shell kernel adopts it — the boot mounts
  // through the row's ctx.uiRenderer), so a second entry would install a
  // second slot renderer / provide `uiRenderer` twice. NOT part of the
  // composite: chamber-entry never imports it (page-own only, no factory).
  '@deepseek-ai/dsh-client-ui-renderer',
  // The official dev-only HMR entry (dsh-client-hmr): its client fiber
  // unconditionally opens `new EventSource('/plugins/events')` — an
  // instance-origin-relative path the chamber page (control-plane origin)
  // must never hit: the control plane's SPA fallback answers it with
  // index.html (text/html), so every boot — and every EventSource
  // reconnect, which never stops — logs the "MIME type is not
  // text/event-stream" abort in the console. The chamber web profile has no
  // usable hmr client channel (design 09; composite reloads are
  // chamber-owned, chamber-entry.ts header), so the row is skipped, never
  // loaded — page-own, no factory.
  '@deepseek-ai/dsh-client-hmr',
  // dsh-v0.1.3-alpha.2: the official open-in client row (ui-open-in-app).
  // 2026-09-11 (fork & supersede, design 20 §2.2): our
  // dsh-chamber-client-ui-open-in is a SUPERSET of this client and REPLACES
  // its registration at the same conversation utility slot — an official row
  // materialized from the host graph would add a second entry. Skipped like
  // the other page-own official rows (ui-sidebar / ui-layout), and the
  // rationale is now replacement, not the older "the official button
  // self-hides under the N-ctx shell" double guard: the local app catalog is
  // served by our own instance host package
  // (@dsh-chamber/dsh-chamber-seed-open-in), never by the official host half.
  // Page-own, no factory.
  '@deepseek-ai/dsh-client-ui-open-in-app',
]

/**
 * The first-screen families the chamber composite bundle statically imports
 * and registers a module-table factory for (design 09 §3.2 union table,
 * chamber-entry.ts COVERED_FACTORIES). This leaf list is the TESTABLE contract
 * behind the map (chamber-entry cannot be imported by the node test runner —
 * its namespaces resolve to source), kept in the covered module so the CI
 * lockstep test can assert every factory id is covered:
 *
 *   every id here ∈ CHAMBER_COVERED_IDS (else the composite's own factory
 *   registration collides with the host-graph row's bundle — double register);
 *   chamber-entry asserts the map matches this list EXACTLY at execution.
 *
 * Maintenance: adding a first-screen family = one import + one map row in
 * chamber-entry.ts + one id here + one id in CHAMBER_COVERED_IDS (the header
 * discipline), in the same batch.
 */
export const CHAMBER_COVERED_FACTORY_IDS: readonly string[] = [
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  // dsh-v0.1.2-alpha.1 provider group (replaces dsh-client-runtime): the
  // store is a platform word (module-table seed — registered factory, no
  // ctx.plugin: it is not a cordis plugin); the controllers and the three
  // conversation families are first-screen plugins (chamber-entry.ts).
  // C3 (2026-09 性能审计): ui-primitives joins here — platform word the
  // composite answers since the seed dropped it (see the CHAMBER_COVERED_IDS
  // comment; factory only, never a ctx.plugin).
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  // alpha.2: the docking-kit word answered by the composite factory.
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-theme',
  '@dsh-chamber/dsh-chamber-client-ui-layout',
  '@dsh-chamber/dsh-chamber-client-ui-sidebar',
  '@dsh-chamber/dsh-chamber-client-ui-git',
  '@dsh-chamber/dsh-chamber-client-ui-open-in',
  // ui-settings stays FIRST-SCREEN (C4, 2026-09 性能审计 — locale/ui-theme
  // root-inject its settingsScope); the C4-deferred settings sections + the
  // chamber settings shell/connections have NO static factory (registered
  // after settle from their deferred chunks — see CHAMBER_COVERED_IDS).
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-conversation',
  // commands + input-trigger are first-screen covered factories (2026-08
  // review fix): ui-model-selection's root inject requires commandUi from
  // commands, commands requires inputTriggers from input-trigger — the three
  // move as one (chamber-entry.ts import comments).
  '@deepseek-ai/dsh-client-ui-commands',
  '@deepseek-ai/dsh-client-ui-input-trigger',
  '@deepseek-ai/dsh-client-ui-workspace',
  '@deepseek-ai/dsh-client-ui-model-selection',
  // dsh-v0.1.2-alpha.1 conversation families (decision D6: first-screen, so
  // their factories must be registered before any loader entry materializes).
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
]
