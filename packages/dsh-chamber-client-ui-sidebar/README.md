# @dsh-chamber/dsh-client-ui-sidebar

English | [中文](README.zh.md)

Chamber's self-built sidebar plugin (design 05 §2): a copy of the official
ui-sidebar shell whose `sidebar.workspaces` region is replaced by the chamber
multi-source session/workspace list, registered into the `sidebar` slot in
place of the official ui-sidebar (which stays untouched in
`vendor/harness-packages`, never in the boot graph).

## Structure

- Source groups → workspace groups → session rows: every source (local + each
  registered remote instance) renders in ONE equal list, grouped by source
  only. Source header = label + connection-status badge (active source
  highlighted); remote sources carry a stable accent derived from the source
  id (hue hash), local keeps the default ink (the old header identity DOT is
  gone — 2026-10 user feedback; identity rides the fold-glyph accent, the
  active left inset and the rail dots); the rail renders the source color dots.
- Sessions outside every workspace trail in one synthetic ungrouped bucket at
  the source's end (sessions only, no workspace actions); blank rows DO surface
  while they are the source's current session (rendered as "New Session") and
  during the 450 ms ghost grace after they lose it (06 §2.2 / 05 §2.1);
  subagent-origin sessions never surface in the navigation list
  (`shared/derive.ts`).
- A connected source whose snapshot fetch failed shows the error text instead
  of the workspace list — never masquerading as "no workspaces". Disconnected
  sources render header + status icon only (dot/spinner, phase on
  hover/aria, no status text); all disconnected → empty hint.
- Live sessions carry a running dot (`sessions.list.running`); no relative
  time cell is rendered (06 §4.3 — `relativeTimeBucket` stays as a shared
  tool only). State-dot priority and the current-session highlight
  (single-selection) are described under "Chamber third round (design 06)"
  below.
- Workspace groups fold via the header chevron (session-count badge); fold
  state persists in localStorage view prefs (`dsh-chamber.sidebar.v1`).
- Source groups fold the same way (2026-09, design 06 §2.4): each source
  header's left slot holds a MONITOR glyph (self-drawn `IconMonitorOutline16`
  in `client/icons.tsx` — the primitives set has no server glyph, and the
  former folder glyph read as another workspace; folder = workspace,
  monitor = server, 2026-10 user feedback) that swaps to the collapse
  chevron on hover — clicking collapses the source's ENTIRE workspace list
  (search capsule, source-scope git alert and list included) WITHOUT touching
  any workspace's own conversation fold state (`sourceFolded`, separate from
  `folded`), so expanding restores every workspace with its sessions exactly
  as they were.
- Each workspace header's icon (folder, or the git-branch glyph of a derived
  worktree) carries its own deterministic accent (`workspaceAccentStyle` in
  `shared/derive.ts`): a golden-angle hue spread of the
  `(sourceId, family seed)` hash plus a per-workspace lightness jitter
  (56/61/66 %) at a SOFT palette (34 % saturation; 21 % for derived
  worktrees — user feedback 2026-10 softened the original 62/45 % jewel
  tones; the source accent matches at `hsl(hue 34% 61%)`) — no user
  customization, no persistence, selection-independent
  (the current-session row keeps its own official selected tint). Worktrees
  and their repository's MAIN checkout share the family hue (seed = the
  `repoKey`; `mainWorkspaceId` only falls back for a repoKey-less flag — the
  family survives an unregistered or renamed main) at a muted saturation;
  the ungrouped bucket gets no accent (default ink).

## Interactions

- Session row click → `chamberBridge.requestOpenSession(sourceId, sessionId)`;
  the App layer switches to that source's shell and opens the session.
- Hover actions (v1 minimal set over the source's own unary wire client,
  `shared/instance-api.ts`): session rename/archive; workspace
  new-session/rename/delete. Failures surface inline, never silently; every
  success triggers `chamberBridge.requestRefresh(sourceId)` — the App layer re-pulls that source's snapshot immediately.
- Add workspace: each connected source opens one in-app directory-browser
  dialog (the browse directory-picker surface, design 05 §4) driven over THAT
  source's unary client (`host.listDirectory`/`host.createDirectory`); a confirmed
  path commits `workspace.create` on that instance — the path must be an existing
  directory on that instance's host (remote paths are remote-server paths).
- A non-current source's header click switches the active N-ctx view without
  opening a session (`chamberBridge.requestActivateSource`); archiving hides
  the session immediately (`archivedSessionIds` filtered in `shared/derive.ts`).

## Data discipline

- The shell subscribes to the chamberBridge projection only; the renderer App
  layer owns and publishes it (state via push: /health health-events stream,
  tunnel phase onStatusChanged, registry onInstancesChanged + 30s poll
  fallback; aggregate 10s poll + requestRefresh). The control plane holds no
  session facts.

## Chamber third round (design 06)

- Per-source session search (wide only): the source header opens a capsule
  input; queries run over that source's unary `sessions.search` after a
  250 ms debounce with a 30 s caller timeout (a changed query supersedes the
  in-flight job; Escape / the clear button / outside-click with an empty
  query collapse the capsule — a non-empty query survives blur by design,
  official semantics) — result rows (title + snippet) replace the workspace
  list while a query is active.
- In-source drag ordering: session rows (real workspaces and the ungrouped
  bucket) and real workspace group headers reorder via HTML5 DnD within
  their own source only (cross-source drops are blocked in code). Real
  workspaces commit through the wire (`insertSessionBefore`/`insertBefore`)
  with a transient optimistic order override that self-heals on the next
  pull; the ungrouped order persists in view prefs.
- Source-group drag ordering (2026-09, design 06 §2.4): source headers are
  the drag handles — dropping on a section boundary reorders the source
  groups. A pure DISPLAY preference: the new order persists into the shared
  `serverOrder` view pref (cross-ctx live sync, no wire, no App-layer
  N-ctx/registry change — navigation is id-keyed); the anchor math is the
  unit-tested `nextServerOrder` pure function and the render order is
  `orderServersForDisplay` (stored order first, unknown ids skipped,
  unlisted ids trail in projection order — a new source appears at the
  bottom until dragged).
- View-preference persistence (06 §3, 2026-08 revision): fold state and the
  ungrouped order live in ONE shared live store under one localStorage key
  (`dsh-chamber.sidebar.v1`, `shared/view-prefs.ts`) — a single vite-shared
  in-memory instance across every ctx's sidebar (`getViewPrefs`/
  `subscribeViewPrefs`/`updateViewPrefs`), writes persist + notify every
  subscriber, so a fold toggle in ANY source's sidebar propagates live to all
  sources (no per-ctx stale copy, no write-back resurrecting another ctx's
  newer state); writes prune only sources seen-then-vanished this session
  (`seenSources` is session-only memory, never restored from storage — the
  startup window can never wipe remote prefs).
- Runtime-fact status indicators ride the runtime-facts channel: pending
  interactions render distinguishable icon badges (question `?`, plan-review
  checklist, approval warning triangle — priority over the live
  running-subagent ring, the completed dots, then the polled running pulse);
  each source's own ctx reports its
  `sessions.list` projection (including the vendor lineage index's running
  subagent count per parent) through a generation-safe
  `chamberBridge.registerInstanceRuntimeProducer`; the shell reserves the
  generation before async boot, so even late registration from an expired ctx
  is inert,
  the App layer merges it into `server.runtime`, and this shell renders the
  indicators for every source without subscribing to any store. The
  current-session
  highlight is single-selection: only the source owning the visible ctx
  (the active view) renders it, so exactly one session is highlighted
  globally.

## Kept official shell geometry

- Logo row (wide/rail), New Session (rides this ctx's runtime action — always
  the current source), the wide/rail fold state machine (slide + crossfade,
  rail-in animation), the pointer-followed scrollbar discipline, the foot
  (`sidebar.footer.action` + `sidebar.settings`), i18n namespace `sidebar` (zh key source; `src/client/locales.ts`).
