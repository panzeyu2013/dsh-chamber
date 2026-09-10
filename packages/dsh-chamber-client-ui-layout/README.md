# @dsh-chamber/dsh-chamber-client-ui-layout

A minimal chamber-owned fork of the official
`@deepseek-ai/dsh-client-ui-layout` shell plugin (design 06 — sidebar width
sharing). **The fork replaces the layout STORE, owns the document-level theme
projection, and adds the `ctx.layoutFacts` face**; the frame itself —
`AppFrame` (the three-column grid, drag handles, column solve), the
`LayoutController` service / `ctx.layout` face, and the theme presenter — is
imported from the vendor source through deep subpaths
(`@deepseek-ai/dsh-client-ui-layout/src/client/…`), never re-implemented.

## Why the fork exists

The sidebar width is a **per-shell/per-boot** layout-store preference: each
N-ctx shell boot instantiates its own store (`ui-layout stores.ts`), and the
vendor `defineStore` persistence is opt-in and unpersisted. As a result the
width the user drags in ONE shell was invisible in the other shells, and every
restart reset to the 280px contract default.

The chamber fork feeds the store from — and writes every drag back to — the
chamber sidebar package's page-wide view-prefs store
(`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`, the single in-memory store all
boots share over the vite shared chunk, persisted under one versioned
`localStorage` key):

- `init` seeds `sidebar` from `getViewPrefs().sidebarWidth` (clamped into the
  vendor `[SIDEBAR_MIN, SIDEBAR_MAX]` drag range, falling back to
  `SIDEBAR_DEFAULT` when never dragged);
- `setSidebar` (every drag) writes the clamped width back through
  `updateViewPrefs`, so every other live boot's store adopts it and the next
  page load restores it;
- `toggleSidebar` re-expands to the persisted width instead of the contract
  default (closing still forgets nothing — the width preference survives);
- every instance registered through `trackLayoutInstance` (the assembly mints
  the root instance eagerly and registers it) joins the shared view-prefs
  subscription and adopts external width changes (guarded: never when the
  instance is collapsed `sidebar === 0`, never when the value is unchanged — no
  loops, no un-collapsing another shell's closed sidebar).

The official `@deepseek-ai/dsh-client-ui-layout` bundle must never load in the
chamber page (a second `root` slot registration at priority 0 would throw the
one-declarer rule); it stays covered in
`packages/renderer/src/chamber-covered.ts`.

## Shape

- `src/client/index.ts` — the vendor `ui-layout` client index copied verbatim,
  with the imports switched to the vendor deep source paths and the store to
  this fork's `stores.ts` (the `'root'` registration, the child-slot
  declarations `sidebar` / keyed `main` / `rightbar` / `shell.overlay`, the
  `usePanelInfo` root-hook projection, `SidebarOwnerProps` /
  `RightbarOwnerProps` / `LayoutController` / `ILayout`,
  `inject: ['slots', 'theme', 'locale']`, registration order and priority
  unchanged), plus the per-ctx `layoutFacts` service.
- `src/client/store-core.ts` — the pure, dependency-injected store factory
  (alpha.2 nested `LayoutState`, eight actions, the shared `collapsedOf`
  derivation) so the behavior is testable under plain node.
- `src/client/stores.ts` — the production wiring: the vendor column geometry +
  view-prefs seed/persist/subscribe environment and `trackLayoutInstance`.
- `src/client/document-theme.ts` — the active-view-gated document theme
  projector (design 06 §4.6).
- `src/vendor-modules.d.ts` — ambient faces for every dsh specifier this
  package imports (vendor packages are excluded from the repository typecheck
  and their built type outputs do not exist in the source-only vendor tree;
  the renderer compiles the real vendor source via vite aliases, see
  `packages/renderer/vite.config.mjs`).

The renderer's `chamber-entry.ts` registers this package's `/client` in the
composite boot in place of the official layout; `vite.config.mjs` aliases
`@dsh-chamber/dsh-chamber-client-ui-layout(/client)` to this source tree and resolves
the vendor deep subpaths through the `deepseekSource` plugin.
