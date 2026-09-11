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
- Fixed chamber-global **Connections** and **Desktop** nav entries: the
  connections page renders the settings-connections section from the chamber
  packages; the desktop page renders chamber-global runtime settings (design
  14 D7/15 — quit confirmation / launch at login / keep awake + the design 11
  update status). The second entry was named "General" until the 2026-09-11
  upstream alignment: the OFFICIAL section is the one named 通用设置/General, so
  the chamber-global desktop-client page and its nav cell are renamed
  `客户端` / `Desktop` (one dictionary key serves both).
- The shell also coordinates its OWN boot ctx's `settings.onboarding` stage
  (upstream SettingsRoot parity): the first ordered, not-yet-completed step
  mounts while that ctx's current session is blank or absent, and the step's own
  component (registered in that ctx) owns its readiness gate, its ctx reads and
  its dialog chrome — the shell paints none of it. The stage is per-ctx on
  purpose: it is driven by the ctx's own sessions seat (`props.useSessions`) and
  its own ledger, never by the panel's selected source (two mounted shells
  selecting the same source would otherwise mount the same step twice), and it
  is gated on the chamber's App-published active-view fact — several instance
  shells are mounted at once, and a first-run dialog is document-global. That gate
  covers MOUNTING only: the completed set resets on the sessions fact ALONE
  (2026-09-11 review-fix F1 — a plain view switch no longer wipes a step the user
  finished or explicitly deferred). Registered residual: the set is
  component-local, so a shell REMOUNT still starts the run over; closing that
  needs per-instance state that survives the mount.
- Every bridged outlet renders inside the official `[data-slot="<key>"]` anchor
  (`display: contents`; the wrapper rides the outlet, not the dispatch outcome),
  so official stylesheets that address a slot's children — General's
  trailing-separator rule in `ui-settings-general/GeneralSection.module.css` —
  match inside this panel exactly as they do in the instance's own frontend. A
  cell whose registrations all abdicated keeps its addressable crash face
  (`<div data-slot-error="<key>">`) instead of collapsing into the owner's
  fallback.
- Controls and shared symbols come from upstream: the toggle is `ui-primitives`'
  `Switch` (36×20, required accessible name; a disclosure row's
  `aria-expanded`/`aria-controls` are written by this package onto the primitive's
  OWN `role="switch"` node — `src/client/disclosure-attrs.ts` — because the
  primitive exposes no attribute pass-through and a role-less wrapper cannot carry
  `aria-expanded` at all, 2026-09-11 review-fix F3), every action capsule and every
  confirmation dialog is `ui-primitives` (`Button`, and the `Modal` the dsh
  runtime section confirms through — title + description + outline Cancel +
  error-toned confirm, with an aria-live pending row while the action runs), the
  nav projection resolves labels with upstream's exported `resolveSlotLabel`,
  and the outlet binds hooks with the renderer's exported `observableHook`.
  Chrome geometry follows upstream's rules (42px trigger row, r32 panel, one page
  title per page — the section body renders its own heading — and closing the
  dialog returns focus to the trigger); the server sub-line and the empty-ledger
  placeholder are the deliberate N-source additions.
- The「dsh 运行时」section confirms every destructive action — the restart on both
  shapes and all seven gateway mutations — through ONE in-app dialog
  (`RuntimeConfirmDialog` over the official `Modal`, driven by the pure
  `confirm-machine.ts` machine: arming runs nothing, a cancel performs nothing,
  and an accept launches exactly one runner — after re-validating the armed
  request against the LIVE facts, so a request whose gates closed while the dialog
  was open is dropped and reported instead of reaching the wire; the gateway-legged
  actions also carry a 12-minute wall-clock ceiling, the 11-minute status-poll
  budget plus a one-minute margin, since a pending dialog deliberately ignores
  cancel/Escape/mask — 2026-09-11 review-fix F2/F4b). The earlier split (native
  confirm
  on the desktop shape, `window.confirm` on the gateway shape) is gone: native
  chrome cannot ride the panel's `--dsw-alias-*` vocabulary or its multi-shell
  document, and the gateway shape has no native dialog at all. Which layer
  confirms an action is otherwise unchanged — the local apply-now transaction is
  still confirmed inside the local runtime surface, so the panel never
  double-asks.
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
