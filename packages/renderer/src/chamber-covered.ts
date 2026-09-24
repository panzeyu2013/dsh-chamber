/**
 * The boot-graph entry ids the chamber page covers WITHOUT the host graph — the
 * dedupe set the per-instance host-graph merge filters against (dedupeCoveredRows).
 * Loading any of these again from the host graph would register the same plugin
 * twice on one cordis ctx (duplicate provide / slot), so they are skipped, never
 * loaded — mostly the client plugin packages the composite registers, plus the
 * page-own rows (ui-sidebar / ui-modules / ui-renderer / ui-layout / ui-open-in-app
 * / hmr / mobile / directory-picker-native) and the PLATFORM_MODULES words the
 * composite answers.
 *
 * Maintenance: a plugin import added to chamber-entry.ts must append its package
 * name here in the same batch (missing ids fail LOUD at boot; extra ids are
 * harmless). Lockstep with chamber-entry.ts COVERED_FACTORIES: every factory id
 * must be covered here. Own module so shell.ts can import it without pulling
 * chamber-entry.ts's module-table handoff into the main chunk.
 */

export const CHAMBER_COVERED_IDS: readonly string[] = [
  // chamber composite registration (chamber-entry.ts import list)
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-api-remotes',
  // provider group: the platform store word (a PLATFORM_MODULES seed), the two
  // api controllers (ctx.sessions / ctx.workspaces), and the three conversation
  // families the web roster carries. All six are composite-covered: loading any
  // again would double-register on one ctx (or split the store engine version).
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
  '@deepseek-ai/dsh-client-ui-theme',
  '@dsh-chamber/dsh-chamber-client-ui-layout',
  '@dsh-chamber/dsh-chamber-client-ui-sidebar',
  '@dsh-chamber/dsh-chamber-client-ui-git',
  '@dsh-chamber/dsh-chamber-client-ui-open-in',
  // ui-settings stays FIRST-SCREEN (C4): locale/ui-theme root-inject its
  // settingsScope; its section families + the chamber settings shell/connections
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
  // chamber page-own skips (covered, no factory, never loaded into the chamber
  // shell): mobile is the GATEWAY deployment's single-shell surface (its own
  // header says its document-level effects are single-shell by design); the
  // `native` directory-picker face can never win because the host's picker
  // interaction is pinned to `browse`.
  '@dsh-chamber/dsh-client-ui-mobile',
  '@deepseek-ai/dsh-client-ui-directory-picker-native',
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
  '@deepseek-ai/dsh-client-ui-settings-plugins',
  '@deepseek-ai/dsh-client-ui-settings-plugin-inventory',
  '@dsh-chamber/dsh-chamber-client-ui-settings-connections',
  '@dsh-chamber/dsh-chamber-client-ui-settings-bridge',
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
  // The official dev-only HMR entry: its client fiber opens
  // `new EventSource('/plugins/events')` on the instance-origin-relative path,
  // which the control plane's SPA fallback answers as text/html — the chamber web
  // profile has no usable hmr client channel, so the row is skipped, never loaded
  // (page-own, no factory).
  '@deepseek-ai/dsh-client-hmr',
  // The official open-in client row: our dsh-chamber-client-ui-open-in is a
  // SUPERSET of it and REPLACES its registration at the same conversation
  // utility slot, so an official row from the host graph would add a second
  // entry. Skipped like the other page-own official rows. Page-own, no factory.
  '@deepseek-ai/dsh-client-ui-open-in-app',
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
  '@deepseek-ai/dsh-api-remotes',
  // provider group: the store is a platform word (registered factory, no
  // ctx.plugin); the controllers and conversation families are first-screen
  // plugins. C3: ui-primitives joins here — platform word the composite answers
  // since the seed dropped it (factory only).
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-primitives',
  // the docking-kit word answered by the composite factory.
  '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-theme',
  '@dsh-chamber/dsh-chamber-client-ui-layout',
  '@dsh-chamber/dsh-chamber-client-ui-sidebar',
  '@dsh-chamber/dsh-chamber-client-ui-git',
  '@dsh-chamber/dsh-chamber-client-ui-open-in',
  // ui-settings stays FIRST-SCREEN (C4 — locale/ui-theme root-inject its
  // settingsScope); the deferred settings sections + chamber settings shell/
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
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-approval',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
]
