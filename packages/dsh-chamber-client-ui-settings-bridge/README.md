# @dsh-chamber/dsh-chamber-client-ui-settings-bridge

English | [中文](README.zh.md)

Chamber's self-built **settings shell** plugin (design discussion 2026-08;
graph-driven revision 2026-12): it registers the 设置 / Settings shell into the
`sidebar.settings` slot at the RESERVED shadow priority (`-1000`, shared face
`settings-shell.ts`), so the official SettingsRoot is shadowed — never
conflicted: the official entry stays on the ledger and its `settings.*` children
declarations remain valid. The chamber sidebar watches the seat's cell winner and
reports (console) any registrant that goes below the reserved range.

## Complete bridge (2026-12 revision)

The panel renders the **selected source's own settings surface** — the
`settings.section` ledger of that source's own boot cordis context, with the
standard seats that context's own renderer bound (`settings-source-face.ts`).
Nothing is mounted twice and no service is stubbed, so a third-party plugin that
is active in that instance's own frontend is active here too, with its real
`remote` (WS event stream), live settings invalidation, and real
`useSessions` / `useWorkspaces` / `usePanelInfo` / `useResource` seats. The
retired alternative — a detached child context mounting a reduced copy of the
source's plugin graph — is what produced "settings not activated: missing
services", "root seat not seated" and the capability-degradation reports; those
diagnostics are gone with it.

Two halves make a source renderable, published per instance:

- the bridge plugin's `apply` (one per instance boot ctx) publishes the ctx's
  `slots` registry, `locale` face and authoritative `chamberSourceFingerprint`;
- that instance's settings shell component — the `sidebar.settings` occupant,
  hence the one chamber entry the renderer hands the complete standard kit to —
  publishes those seats.

The panel only renders a face whose `sourceFingerprint` matches the roster's
current incarnation for that source id. While the panel is open it asks the App
layer to keep that source's shell MOUNTED (`chamberBridge.setSettingsTarget`:
mount off-screen if needed — never switching the active view — and exclude it
from retention reclaim); closing the panel releases both guarantees.

## Behavior

- A server dropdown over the selected instance; the options column renders that
  instance's own sections exactly as its own frontend does (icon + label; the
  ledger's `registrant` stamp is diagnostics-only upstream and is not rendered —
  the old chamber-side「插件」provenance tag was retired 2026-09-11). A gateway
  source's own ledger additionally carries the
  per-server "dsh runtime" section, which this package registers on that
  instance's ctx (design 18 §3.6/§9.3, proxying `/chamber/runtime` — version
  select/apply/rollback/restart); it is derived from projected capability facts
  and reported (never thrown) when a projection is malformed.
- A source that is not mounted yet shows the "starting this instance's
  frontend" intermediate state; an unreachable source shows the existing
  unavailable placeholder plus the connections route, and triggers no mount.
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
- Every outlet this shell renders (the local-only `settings.action` and the
  selected-instance `settings.section` content outlet) is contained by
  `<BridgeEntryBoundary containAll>` — the source's own plugin content never
  abdicates wholesale to the official SettingsRoot (bridge-owned assembly errors
  still fail loud).

## i18n

Owns the `dsh-chamber.settings.bridge` dictionary namespace (zh key source;
`src/locales.ts`); binds the `dsh-chamber.settings.connections` namespace for
the embedded connections section.
