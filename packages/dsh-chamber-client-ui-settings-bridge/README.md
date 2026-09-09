# @dsh-chamber/dsh-chamber-client-ui-settings-bridge

English | [中文](README.zh.md)

Chamber's self-built **settings shell** plugin (design discussion 2026-08;
graph-driven revision 2026-12): it registers the 设置 / Settings shell into the
`sidebar.settings` slot at the RESERVED shadow priority (`-1000`, shared face
`settings-shell.ts`), so the official SettingsRoot is shadowed — never
conflicted: the official entry stays on the ledger and its `settings.*` children
declarations remain valid. The chamber sidebar watches the seat's cell winner and
reports (console) any registrant that goes below the reserved range.

## Behavior

- A server dropdown over the selected instance; the panel mounts a
  **per-instance child cordis context** whose plugin set is **graph-driven**
  (2026-12 revision, design 05 §5): a base set (declaration chain, slots,
  locale, theme, official settings families, BridgeRows, the per-source
  "dsh runtime" section) plus **the selected source's own client plugin graph**
  (`clientGraph/graph`, minus the covered rows, loaded through the page-level
  union module table and mounted one by one into the same child context). The
  bridge only proxies the existing settings/credentials/llm RPC surface; a
  selected gateway server additionally mounts the per-server "dsh runtime"
  section (design 18 §3.6/§9.3, proxying `/chamber/runtime` — version
  select/apply/rollback/restart).
- **Honest reporting**: plugin-provided sections carry a provenance tag, and
  every non-rendered contribution (inactive with its missing services, failed
  load/apply, seats the shell does not render, contained render crashes,
  cross-source module-instance sharing, capability degradation for plugins
  subscribing to `remote.$on`) is listed on the "plugin settings" diagnostics
  page — nothing disappears silently. "Reload" re-reads the graph and reconciles
  (the base set is never rebuilt).
- Fixed chamber-global **Connections** and **General** nav entries: the
  connections page renders the settings-connections section from the chamber
  packages; the general page renders chamber-global runtime settings (design
  14 D7/15 — quit confirmation / launch at login / keep awake + the design 11
  update status).
- Config facts stay on the target host: no chamber-side persistence, no new
  control-plane API.


## Shared gateway-runtime split (design 21 §5.2)

- The pure gateway dsh-runtime core (status parse/fetch, action gates, error
  classification, restart-readiness poll) moved OUT of this package into the
  sidebar shared face (`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`, exported from
  `src/shared/gateway-runtime*.ts`); this package imports it back for its
  gateway dsh-runtime section and typechecks it against the REAL sidebar shared
  source (P4-4: the handwritten ambient mirror
  `src/ambient/chamber-bridge.d.ts` was deleted — this package keeps its own
  tsconfig `paths` for the connections-section mapping, so its sidebar/shared
  specifier resolves via the node_modules workspace link + the sidebar
  package exports to the REAL `src/shared/index.ts`).
- Only the settings-bridge-local view mapping stays here:
  `remoteRuntimeStatusView` / `RemoteRuntimeStatusView` (SettingsBridgeKey
  coupling) in `src/client/gateway-runtime-api.ts`.
## Keyed slots & containment (2026-08)

- The bridge outlet supports root+keyed slots (`settings.plugin.item`,
  entryKey dispatch + fallback, mirroring the official scoped-slots contract).
- Every bridged outlet (the local-only `settings.action` and the
  selected-instance `settings.section` content outlet) is contained in the
  child-ctx → host seam by `<BridgeEntryBoundary containAll>` — child content
  never abdicates wholesale to the official SettingsRoot (bridge-owned
  assembly errors still fail loud).

## i18n

Owns the `dsh-chamber.settings.bridge` dictionary namespace (zh key source;
`src/locales.ts`); binds the `dsh-chamber.settings.connections` namespace for
the embedded connections section.
