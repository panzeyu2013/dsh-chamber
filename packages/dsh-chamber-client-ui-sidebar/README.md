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
  id (hue hash), local keeps the default dot; the rail renders the source color dots.
- Sessions outside every workspace trail in one synthetic ungrouped bucket at
  the source's end (sessions only, no workspace actions); blank and
  subagent-origin sessions never surface in the navigation list
  (`shared/derive.ts`).
- A connected source whose snapshot fetch failed shows the error text instead
  of the workspace list — never masquerading as "no workspaces". Disconnected
  sources render header + status icon only (dot/spinner, phase on
  hover/aria, no status text); all disconnected → empty hint.
- Live sessions carry a running dot + relative-time cell
  (`sessions.list.running`/`updatedAt`, official relativeTime bucketing,
  localized). State-dot priority and the current-session highlight
  (single-selection) are described under "Chamber third round (design 06)"
  below.
- Workspace groups fold via the header chevron (session-count badge); fold
  state persists in localStorage view prefs (`dsh-chamber.sidebar.v1`).

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
  250 ms debounce with abort on change/blur — result rows (title + snippet)
  replace the workspace list while a query is active.
- In-source drag ordering: session rows (real workspaces and the ungrouped
  bucket) and real workspace group headers reorder via HTML5 DnD within
  their own source only (cross-source drops are blocked in code). Real
  workspaces commit through the wire (`insertSessionBefore`/`insertBefore`)
  with a transient optimistic order override that self-heals on the next
  pull; the ungrouped order persists in view prefs.
- View-preference persistence: fold state and ungrouped order live under one
  localStorage key (`dsh-chamber.sidebar.v1`, `shared/view-prefs.ts`), read
  on mount, written back on change.
- Runtime-fact status indicators ride the runtime-facts channel: pending
  interactions render distinguishable icon badges (question `?`, plan-review
  checklist, approval warning triangle — priority over the running pulse,
  then completed dots); each source's own ctx reports its
  `sessions.list` projection through `chamberBridge.reportInstanceRuntime`,
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
