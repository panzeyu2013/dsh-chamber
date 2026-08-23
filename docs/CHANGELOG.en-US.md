# Changelog

All notable changes to dsh-chamber are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release artifacts and per-release notes also live on the GitHub Releases page
(`https://github.com/panzeyu2013/dsh-chamber/releases`).

> 中文版: [CHANGELOG.md](../CHANGELOG.md)

## [Unreleased]

### Added

- **Authenticated server Gateway (design 17)** — adds the independently
  publishable `@dsh-chamber/gateway`: it manages a loopback dsh and exposes the
  official frontend/API behind one HTTP/WS Host/Origin policy, mandatory auth,
  and bounded proxying. Desktop gains a `gateway` transport, write-only token,
  and per-server orchestration settings. Gateway also ships a browser
  orchestration page, derived session index, approval/question handling,
  scheduler, and a workspace-authority-bound Git worktree saga. CI/release now
  cover build, typecheck, tests, tgz install smoke, and npm publish.

### Security

- Gateway rejects absolute/protocol-relative/backslash authorities, forged
  forwarded identity, weak credentials, and anonymous external deployment.
  Password changes revoke old cookies across restarts, token replacement closes
  established streams, and credentials are isolated from the renderer, logs,
  managed dsh, and Git environments. The shared proxy now enforces a genuine
  process-wide 300 MiB request-body budget (32 MiB per unknown/chunked request),
  backpressure-aware lifetimes, and forwarding-header stripping. Login bodies,
  raw dsh event frames/queues, and the derived-index buffer all have hard
  pre-filter limits; every Gateway state document is owner-only.
- Git compensation now preserves ambiguous commits and records recovery state:
  repositories must be canonical main checkouts derived from live workspaces,
  inherited `GIT_*` overrides are stripped, and create/delete revalidate live
  authority immediately before mutation. Unverified records cannot be deleted,
  live/symlink cwd checks fail closed, deletion never forces or removes branches,
  and a deleting recovery row cannot remove a path reoccupied by another workspace
  id or surviving after workspace authority disappeared. Approval/question pending
  rows are removed only after an explicitly accepted dsh receipt. Feature flags
  default off and are server-enforced; the scheduler bounds timers, runs
  single-flight, backs off failures, and guards cancel/reconnect generations.
- The release workflow binds tags to the checkout SHA and rejects untrusted-version
  shell injection, deletion of a published release, dry-run mutations, and npm
  channel rollback. Stable/prerelease packages use `latest`/`beta` respectively,
  formal builds do not pin a third-party Electron mirror, and existing Gateway
  secrets reject symlinks/non-regular files and converge to mode 0600 before read.

## [0.1.4] - 2026-08-21

### Added

- **Git worktree plugin OpenChamber presentation alignment (design 08 §11)**
  — the **workspace row IS the git surface**: the occupant renders inside the
  workspace header row (always-visible branch chip, inline create/remove
  actions revealed together with the row's "+"/kebab on hover, status badges
  for dirty / ↑↓ ahead-behind / health / attention); the standalone git line
  and the standalone panel seat are removed (the contextual
  `sidebar.workspace.git` seat replaces `sidebar.git`). The create dialog is
  aligned with OpenChamber: New/Existing tabs, de-duplicated two-word slug
  suggestion, directory sync/reset, source-branch dropdown (per-repo
  localStorage memory), an existing-branch picker fed by snapshot branches,
  **one-click direct create** (no preview screen; the host validation chain is
  kept), and **creating never commits a session** (the recovery record carries
  the createSession flag). The remove dialog lists the affected session titles
  (≤5 + "and N more") and can **optionally delete the local branch** (user
  decision; a failed branch delete is reported honestly and never undoes the
  removed worktree).
- **Git worktree backend alignment** — a unified worktree root
  `<DSH_HOME>/worktrees/<repo>-<hash12>/<dir>` (centralized, collision-free
  across same-named repos, outside any working tree); **source branch
  (startRef)** — a new branch starts from the chosen local branch HEAD, pinned
  to the exact commit and re-verified at create; snapshot **upstream / ahead /
  behind read-only facts** (status `--branch`, local refs only, never
  fetched); 30s discovery cache with workspace-signature invalidation; new
  `show-ref --heads` / `branch -D` allowlist shapes.
- **Show ALL worktrees (Plan A)** — unregistered worktrees render at the end
  of their repository group (name = directory basename, row style matching
  derived workspaces); "New session" lazy-registers (adopt), "Remove" runs the
  unregistered removal (host `workspaceId` optional + `path`, git-first with
  every guard kept, `next: 'none'` skips the workspace delete); orphaned
  workspaces (path gone) show a "Missing" badge and delete through a dedicated
  confirm (registration cleanup only; sessions are kept and become
  Ungrouped); the associated-session count counts only VISIBLE sessions
  (archived / subagent excluded).
- **Dialog details** — the create dialog's tabs become a **slider-style
  switch**; the source-branch / existing-branch dropdowns reuse the repo's
  Menu primitive (custom styling, no native selects); the directory name
  **auto-suffixes on collision** (`name-2`/`name-3`…, checked on open / tab
  switch / blur / submit, same-repo scope); the remove dialog drops its long
  description text and the worktree path ink is lifted to the primary color.

### Fixed

- Git host: **startRef was dropped at the input-parser layer** (choosing a
  source branch failed with `invalid-input`, P1); a missing branch reported
  with exit 128 was treated as a hard git failure (`localBranchHead` now maps
  any non-zero exit to "absent"); create did not clear the discovery caches
  (new worktrees invisible to snapshots for up to 30s); snapshots ran a
  redundant `show-ref --heads` per repo per poll (the cached branches were
  never consumed); deleteBranch was silently skipped on target-absent replay
  paths.
- Git client: a session-less create still committed and opened a session on
  recovery retry; the Existing tab kept the new-mode random branch suggestion;
  Existing-mode directory edits were silently overwritten; the occupant's
  buttons were not covered by the sidebar's drag-end trailing-click
  suppression; branch-delete outcomes were dropped by the decoder; the new
  attention/upstream fields now decode as "absent degrades, present-but-
  unknown rejects" for older hosts (no more silently vanishing git surface);
  blur normalization preserves non-ASCII (Chinese branch names are no longer
  rewritten to `-`); dead styles/locale keys cleaned up.
- **Git host 404 semantics**: a git RPC 404 is a definitive
  `git-host-not-loaded` (host package missing or not yet effective — no
  recovery, no retry): restart the desktop locally, or re-seed the chamber
  host packages in the remote connection settings and click "restart to take
  effect".
- **One-click remote restart**: the connections plugin's chamber block gains
  a "Restart instance" button (`restart_service`) and a pendingRestart
  "restart to take effect" state after seeding; the dual-package chamber seed
  also probes `gitWorktree`.
- **Window-rebuild crash root cause**: the desktop rebuilt the window with a
  trailing-slash renderer origin producing a `//` URL, and the control
  plane's `new URL` parse threw on Node 22 → fatal exit. Fixed on both ends
  (origin normalization + parse try/catch returning 400).

### Changed

- **dsh baseline upgrade 0.1.0-rc.8 → 0.1.1-rc.2** — the build-time source
  (`harness.commit` / vendor tree), the bundled runtime (`@deepseek-ai/dsh`)
  and the sibling checkout are unified on rc.2; the in-repo forks are re-based
  on upstream rc.2: `dsh-client-connection` (merged RPC signature that also
  accepts the upstream transport override, HTTP body cap 160→300 MiB, and the
  `__DSH_TRANSPORT__` transport-hook wiring while fully keeping the chamber
  per-instance basePath patch) and `dsh-client-web` (boot kernel
  `__DSH_TRANSPORT__.loadBundle` wiring + prefetch skip). The upstream rc.2
  image/Files pipeline (200 MiB image admission) is now reachable through the
  chamber proxy (see next entry).
- **Control-plane proxy body caps 50/100 → 300 MiB** — the per-instance
  proxy's request/response caps and the process-wide buffered budget align
  with the upstream rc.2 300 MiB request cap (200 MiB of images still fits
  after ~267.7 MiB base64 expansion); the 413/503 semantics and the 30s
  chunk-idle timeout are unchanged.

## [0.1.3] - 2026-08-20
### Added

- **Independent Git worktree plugin (design 08)** — adds the in-instance
  `@dsh-chamber/dsh-host-git-worktree` Remote and the first-screen static
  `@dsh-chamber/dsh-client-ui-git`: 30-second single-flight topology,
  a `sidebar.git` seat, a compensating worktree/workspace/session create saga,
  and retryable Git-first/workspace-delete removal. Git runs beside the
  workspace authority under the same process user; main, dirty, locked, and
  running targets are hard-rejected, with no archive, force, branch deletion,
  or network Git verbs such as fetch, pull, or push. Creation checkout still
  honors repository filters configured by that user (for example Git LFS,
  which may access the network), and the confirmation UI says so explicitly.
  The host-graph and Git host packages share one overlay. Local-profile and
  remote ready-time seeds preflight both packages before per-file writes, then
  merge the overlay once; this is not a cross-file transaction, so failures
  stay loud and retry idempotently on the next ready transition.
- **Three Git worktree plugin extensions (post-merge, 2026-08-20)** — ① every
  worktree row gains "new session here": session-only adoption of an EXISTING
  worktree (no Git mutation; workspace reuse/registration + a preallocated
  session id, never compensated once session.create is attempted); ② a
  session-worktree attachment state model: the host snapshot classifies each
  row as ready/missing/invalid/not-a-repo, branch/detached/unborn HEAD, and
  in-progress Git operations (merge/rebase/cherry-pick/revert/bisect, probed
  from the worktree git dir); the sidebar shows health/HEAD/attention/current
  badges and blocks removal of unhealthy worktrees; ③ aligned removal cascade:
  the confirmation recursively enumerates (parentSessionId closure) direct +
  all subsessions, states that sessions are kept as Ungrouped and never
  deleted, and offers archiving the whole session tree first (any archive
  failure aborts with nothing removed).
- **In-app "Check for updates" button and update settings section** (design 11
  revision) — the settings General section gains `UpdateSection`, letting the
  user trigger an explicit update check (same path as the startup/periodic
  silent checks, never auto-downloads); `update-gate` phase gate + unit test.

- **rc.8 backend version tolerance (design 09 §3.3 revision)** — an instance
  whose backend dsh frontend version differs from the chamber shell no longer
  fails the whole boot: extra host-graph rows the shell does not cover
  (including core rows rc.8 added, e.g. the `dsh-client-ui-attachment` client
  half) degrade to **absent features** on apply/materialize failure
  (console.error + status `failed`; the shell boots normally). The shell seed
  word table aligns with the official rc.8 platform set (a platform word can
  never be a graph row); the app-shell renderer install tolerates a backend
  `ui-renderer` row installing first (it adopts the installed renderer); the
  chamber entry bundle loads WITHOUT the `?rev=` query (same URL as the vite
  chunk graph's bare reference — deferred ui-* chunks no longer re-execute
  the entry bundle and the duplicate-factory sink no longer fires).
- **Boot-tolerance decision-rule unit tests (`pnpm run test:client-web`)** —
  the tolerance policy is extracted into a pure module
  (`dsh-client-web/src/boot-tolerance.ts`) and added to the CI unit-test
  surface.


### Fixed


- **Quit-flow hardening** (design 14 review round) — the quit confirmation now
  appears only while a local dsh process is actually alive (`localProcessAlive`,
  a state-string-independent fact); SIGTERM/SIGINT take the graceful quit path
  (will-quit full cleanup — hard kills no longer leave detached orphan hosts
  holding ports); the control plane force-closes connections before close()
  (lingering SSE/WS no longer hang the exit); the settings shell is restructured
  to the fixed "Connections/General" entries + a `quitConfirmation` toggle.
- **Plugin-management modal fixes** — light-theme white-on-white (content
  anchored to label-primary); the local instance's constant loading phase left
  the footer "Close" button permanently disabled (removed).


- Chamber renderer boot crash against an rc.8 official frontend (seed word
  shadowing the factory → "invalid plugin"); now degrades to absent features
  and the instance boots normally.
- Deferred ui-* families rendering the "unknown surface event: tool-call"
  fallback (the chamber entry bundle was double-executed because `?rev=`
  made the browser treat the boot-time load as a different module record
  than the chunk graph's bare reference).
- App-shell whole-boot failure when a backend `ui-renderer` row installed the
  slot renderer first; the already-installed renderer is now adopted.
- Boot-tolerance log wording aligned with the actual failure type; the
  manifest preload dedupe filter now also strips stale `?rev=` forms.


### Changed


- **Full dsh rc.8 baseline alignment (design 09 §4)** — `harness.commit` →
  141eb6fef8 (dsh 0.1.0-rc.8): the vendor source is materialized as the in-repo
  managed snapshot `vendor/harness-checkout` (avoids the pnpm 11 lockfile pruning;
  `--frozen-lockfile` passes); the boot kernel moves to the rc.8 module-system
  bootstrap (`boot.ts` class kernel + `__ModuleLoader__` facade + BootPage loading
  page, mount via `ctx.uiRenderer`); the composite deferred family gains +3
  coverage (`ui-attachment` / `ui-brand-official` / `ui-reference`), `ui-renderer`
  becomes page-own; web-react/schema-form deep imports are removed/migrated
  (rendering assembly moved into the ui-renderer row, settings packages move to
  `SettingsSchemaService`); the local host is upgraded to rc.8 (vendor dsh
  0.1.0-rc.8). The rc.8 client carries the `commands.execute` `images` argument
  natively, so the temporary compat bridge is removed; rc.7 hosts leave the
  supported set with this alignment.



- The shell seed word table drops the rc.7-era platform words
  (`dsh-client-web-react` / `dsh-client-ui-attachment` /
  `dsh-client-schema-form`), matching the official rc.8 set.
- Design 09's failure-degrade semantics are stated per layer: load failures
  stay loud at the preload layer (collectExtraRows), apply/materialize
  failures degrade at the boot-kernel layer.

## [0.1.2] - 2026-08-19

### Added

- **Desktop auto-update (design 11)** — silent update checks (startup delay +
  6h interval), a low-key Settings「更新」section, download only after explicit
  user confirmation, install on quit. Update feed shipped for both platforms
  (`latest.yml` / `latest-mac.yml`; beta channel via a semver prerelease
  version). macOS install leg reports honestly when a Developer ID signature
  is absent (manual-install hint, never a fake success).
- **Sleep / background persistence (design 14)** — configurable close behavior
  (hide to tray while dsh keeps running, or quit, with a quit confirmation
  when active tunnels or the local instance would be stopped), launch at login
  (mac/linux), immediate reconnect on OS wake (no heartbeat watchdog wait),
  keep-awake toggle. Settings persist in the main-process
  `chamber-settings.json` (0600, atomic, corrupt-file preserved).
- **Chamber settings page (design 15, v1 flat form)** — fixed Settings-shell
  entries Connections / General / Update; chamber-global settings kept strictly
  separate from per-instance config planes.
- **First-paint performance (P4)** — static skeleton + critical CSS in the
  served HTML, parallel boot, host-graph fetch overlapped with the boot chain,
  non-first-screen ui-* families split into lazy chunks (entry chunk 934KB →
  650KB), absolute modulepreload matching the manifest URL, on-the-fly gzip +
  immutable caching for `/assets/*` in the control plane.
- **Sidebar UX batch** — single click opens a session immediately with
  double-click rename; sidebar width persisted across shells and restarts via
  a chamber ui-layout fork; sidebar scroll position preserved across N-ctx
  server switches; explicit sort menu with official updated-order semantics
  (manual order + activity promotion).
- **Host-graph visibility** — the chamber-injected host package row shows the
  module A version and a live-effect tri-state (已生效 / 重启后生效 / 未知)
  probed over the tunnel RPC.
- **Boot hardening** — union-table completion for covered packages,
  chamber-level failure overlay (report + retry + server switching),
  first-boot module-system race fix.

### Fixed

- macOS: `windowCloseBehavior='quit'` now actually quits (previously left the
  app windowless forever on darwin); wake re-probe no longer spawns transports
  during quit teardown.
- `isAllowedReleaseUrl` rejects percent-encoded path traversal and userinfo —
  the allowlist can no longer be pointed at an arbitrary github.com path.
- Updater: a periodic re-check can no longer clobber the `downloaded` state
  while a download is in flight; error-text path redaction covers any POSIX
  absolute path.
- Sidebar: the two rowActions wrapper spans now pair `stopPropagation` with
  `clearPendingClick` (a stray pending could spuriously enter rename).
- Remote plugin-list refresh no longer writes ERROR log lines for
  uninitialized remote profiles (quiet manifest probe).
- Settings-bridge keyed-slot support (Plugins page no longer abdicates the
  chamber shell); child-ctx errors contained at the host seam.
- Connections settings: chamber-block legibility restored; refresh actions
  distinguished.
- Renderer/sidebar scroll sync excludes ghost rows; sort derivation converges
  without write loops.

### Changed

- **macOS release builds now target macOS 26** (`macos-latest` runner) —
  macos-14 is deprecated (2026-07) and unsupported by 2026-11.
- Release engineering: version assert covers all 6 chamber packages;
  concurrency guard on the release workflow; CI packaging runs with an
  explicit `--publish=never` (electron-builder 26 implicitly publishes in CI
  environments otherwise).
- **No `.blockmap` sidecars in releases** — Windows `nsis.differentialPackage`
  back to `false`; the mac zip's hardcoded `.zip.blockmap` is dropped from the
  draft before finalize. Feeds never reference blockmaps, so updates fall back
  to full downloads (functionality unchanged).
- Chinese README promoted to primary (`docs/README.en-US.md` mirror).

## [0.1.1] - 2026-08-18

### Added

- Chamber host-graph injection surfaced in plugin management (local/remote
  seed wiring, `--patch` overlay, install-level fallback).
- Client plugin runtime loading (design 09): per-instance host-graph merge,
  extra-entry preloading, covered-set dedupe.
- Remote plugin management over the SSH exec channel (list / add / remove /
  restart, spec whitelist).
- Multi-source sidebar enhancement batch (workspace grouping, info cards,
  running-subagent indicators, cross-ctx live sync).
- Trusted IPC + navigation fencing to the control-plane main frame;
  non-loopback HTTP/WS origin rejection.
- Windows single-pass lean installer; app/tray icons; packaged dev-instance
  isolation.

### Fixed

- Transient tunnel failures retried via a slow re-probe; renderer crash
  window recovery; N-ctx cordis ctx teardown on dispose; queued session opens
  kept pending until runtime accepts; cursor flicker over row actions;
  chamberBridge publish gated on projection signature (identity-preserving
  aggregate state).

### Changed

- dsh 0.1.0-rc.7 integrated (harness pin + CI bundle pin + lockfile sync).
- macOS x64 CI builds dropped for v1 (arm64 only).
- Auto-update redesigned as a quiet settings-based flow (design 11 scoping).

## [0.1.0] - 2026-08-15

Initial release — local desktop connection manager for dsh:

- Control-plane connection core: web-profile host hosting, management REST
  (`/health`, `/api/connections`, `/api/host/logs`), per-instance same-origin
  reverse proxy, static frontend serving.
- Self-built renderer (source-reused dsh official frontend): N-ctx
  multi-instance, chamber sidebar / connections settings / settings-bridge
  client plugins.
- SSH transport (tunnels + remote systemd), instance registry, Electron
  single-frame shell, CLI.

v1 scope: no authentication/audit surface (loopback-only control plane).

[0.1.3]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.3
[0.1.2]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.2
[0.1.1]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.1
[0.1.0]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.0
