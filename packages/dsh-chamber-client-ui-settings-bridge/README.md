# @dsh-chamber/dsh-client-ui-settings-bridge

English | [中文](README.zh.md)

Chamber's self-built **settings shell** plugin (design discussion 2026-08): it
registers the 设置 / Settings shell into the `sidebar.settings` slot at a
LOWER priority (`-1`) than the official SettingsRoot registration, so the
official shell is shadowed — never conflicted: the official entry stays on
the ledger and its `settings.*` children declarations remain valid.

## Behavior

- A server dropdown over the selected instance; the panel mounts a
  **per-instance child cordis context** (fake connection + the official
  settings plugin subset) and renders the target instance's official
  settings sections — the bridge only proxies the existing
  settings/credentials/llm RPC surface; a selected gateway server
  additionally mounts the per-server "dsh runtime" section (design 18
  §3.6/§9.3, proxying `/chamber/runtime` — version select/apply/rollback/
  restart).
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
  sidebar shared face (`@dsh-chamber/dsh-client-ui-sidebar/shared`, exported from
  `src/shared/gateway-runtime*.ts`); this package imports it back for its
  gateway dsh-runtime section and typechecks it against its own handwritten
  ambient mirror (`src/ambient/chamber-bridge.d.ts`, MIRROR WARNING header —
  locked to the real modules by the sidebar `gateway-runtime-mirror.test.ts`).
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
