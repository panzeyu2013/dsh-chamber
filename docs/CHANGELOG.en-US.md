# Changelog

All notable changes to dsh-chamber are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release artifacts and per-release notes also live on the GitHub Releases page
(`https://github.com/panzeyu2013/dsh-chamber/releases`).

> 中文版: [CHANGELOG.md](../CHANGELOG.md)

## [Unreleased]

## [0.2.0-beta.1] - 2026-08-25

### Added

- **Authenticated server Gateway (design 17)** — adds the independently
  publishable `@dsh-chamber/gateway`: it manages a loopback dsh and exposes the
  official frontend/API behind one HTTP/WS Host/Origin policy, mandatory auth,
  and bounded proxying. Desktop gains a `gateway` transport, write-only token,
  and per-server orchestration settings. Gateway also ships a browser
  orchestration page, derived session index, approval/question handling,
  scheduler, and a workspace-authority-bound Git worktree saga. CI/release
  cover build, typecheck, tests, and tgz pack+install smoke (npm publishing is
  deferred, 2026-08).
- **dsh runtime version management (design 18)** — installs/switches the dsh
  runtime at runtime: registry-origin binding + SRI verification + embedded pnpm
  `file:` install, probe-gated switching with a two-phase rollback/recovery loop
  (M0/M2/M4 done; M1/M3 partial — packaged-machine acceptance awaits a real
  `.app`); data-safety gap fixes — journal-mismatch classified as
  `selection-corrupt`, pre-rollback stash restore, and `incomplete` restores
  unblocking `recover-metadata`.
- **Open-in registry (design 20)** — evolution of the VS Code deep-link
  (design 16) into one unified open surface: Finder / local / remote VS Code via
  the main-process OpenInApp provider registry plus a six-step loud execution
  pipeline; the plugin package is renamed `dsh-chamber-client-ui-open-in` and
  the legacy vscode IPC is removed.
- **Desktop notifications (design 19)** — native notifications for session
  completion / agent questions / approval requests (opt-in setting); detection =
  renderer edge detection over the runtime fact channel, presentation =
  main-process Electron Notification + click-to-open; settings merged into the
  general-page "Notifications" control group.
- **Sidebar enhancements (design 06 §2.4/§3.1)** — source-level collapse
  (source-header collapse toggle, folds the whole source workspace list) +
  server drag ordering (display preference persisted in
  `dsh-chamber.sidebar.v1`, live-synced across ctx) + workspace icon identity
  coloring (hue derived from `(serverId, family seed)` hashing with stable
  accent; worktrees share the main checkout's family hue).
- **Lazy Electron binary bootstrap** — the root postinstall no longer downloads
  the Electron binary (~100MB) by default; it is fetched only with
  `DSH_CHAMBER_ELECTRON=1` (or auto-installed on the first `electron-dev` launch);
  server deployments (gateway/control-plane/CLI) install without the desktop
  dependency.

### Fixed

- **Packaging closure** — `notifications.ts` added to electron-builder
  `build.files` (the packaged artifact previously missed the module and would
  fail at startup); preload compilation now emits into a temp dir and copies
  only `preload.cjs` (three dead files no longer enter the asar);
  `build.files` excludes `dist/.vite/**`.
- **Dead dependency cleanup** — the control-plane's `@simplewebauthn/server`
  (a leftover from the removed v1 auth surface) is dropped; lockfile and
  third-party declarations synced.
- **Gateway ESM bundle require shim** — ws's static `require('events')` hit
  "Dynamic require not supported" in the pure-ESM bundle, wedging the derived
  session index / approval streams in an endless reconnect loop with an
  always-empty `/chamber/sessions` (live finding on Linux + macOS); the build.mjs
  banner now injects `createRequire`, locked by a build smoke test.
- **Scheduler `session.prompt` wire shape** — the old `{sessionId, prompt}`
  payload was rejected by dsh 0.1.1-rc.2 (schema reverse-engineered live: the
  discriminator is `mode`); switched to
  `{sessionId, mode:'queue', content:[{type:'text',text}]}` with a regression test.
- **Review hardening round (2026-08 full review)** — business rejections now
  terminate scheduled jobs (no infinite backoff); dirty-worktree git deletes roll
  back to `ready` with an `error` field (retryable); `removedSessionIds` cap;
  request streams destroyed after body-limit rejection; WS upgrade `auth_busy` →
  503; explicit JWT alg check; scheduler job/prompt limits; gateway-source open-in
  buttons fail closed (dead control removed); open-in/layout client packages gain
  tests (29 cases); askpass generation retirement semantics (disconnect keeps the
  in-flight helper, final deletion on removal); exec epoch guards against stale
  projection pollution; settings file validation covers the notifications block;
  EPERM degradation; etc.

### Security

- Gateway rejects absolute/protocol-relative/backslash authorities, forged
  forwarded identity, weak credentials, and anonymous external deployment
  (anonymous external is refused by default; the `--no-auth` flag is an explicit,
  loudly-warned operator override for trusted networks).
  Password changes revoke old cookies across restarts, token replacement closes
  established streams, and credentials are isolated from the renderer, logs,
  managed dsh, and Git environments. The shared proxy enforces a real process-wide
  300 MiB body budget (unknown/chunked 32 MiB per request), a backpressure
  lifecycle, and forwarding-header scrubbing; login bodies, raw dsh event
  frames/queues, and the derived index all have pre-filter hard caps, and all
  Gateway state is owner-only.
- Git compensation is "keep ambiguous and record recovery": only live-workspace
  canonical main checkouts are allowed; Git children have inherited `GIT_*`
  stripped and mutations re-verify live authority right before create/delete;
  unverified records cannot be deleted, running/symlinked cwd fails closed,
  deletes are non-force and never drop branches, and deleting-recovery records
  cannot be removed after a new workspaceId takes the path or the workspace
  vanishes; approvals/questions leave pending only on an explicit accepted dsh
  receipt. Feature flags are off by default and enforced server-side; the
  scheduler has timer caps, single-flight, failure backoff, and cancel/reconnect
  generation guards.
- The release workflow binds tags to checkout SHAs, rejects untrusted-version
  shell injection, published-release deletion, dry-run writes, and npm channel
  downgrades (the npm step is commented out while publishing is deferred,
  2026-08); stable/prerelease use `latest`/`beta` channels, and official builds
  do not pin third-party Electron mirrors. Existing Gateway secrets refuse
  symlink/non-regular files and are chmodded to 0600 before reads.
- notify answer/approval client-response envelope shapes verified live against
  the real dsh wire (unknown rpcId → `not-pending` receipt; failure surfaces as
  explicit 409 + pending row kept).

### Changed

- **Documentation closure** — `docs/progress/STATUS.md` rewritten to track only
  incomplete/partially-complete items and scope deviations (implemented
  baselines live in git history / CHANGELOG); AGENTS.md and design docs synced
  (open-in package, ws-frames tests, packaging-closure checklist added).

## [0.1.5] - 2026-08-23

### Added

- **VS Code deep-link plugin (design 16)** — `dsh-chamber://` OS deep links
  plus an in-app button that launches the local VS Code Remote-SSH session
  for the target server instance (local: `vscode://file/`, remote:
  `ssh-remote+`); the button sits in the official session-header utilities
  slot (left of session-log) with the icon taken from the local VS Code
  official resources.
- **Git worktree removal enhancement (design 08 §6 amendment, user decision)**
  — a dirty worktree no longer hard-blocks removal: the remove dialog warns
  "uncommitted changes will be discarded, the branch is kept" and requires a
  checkbox before the host removes it with `git worktree remove --force`;
  **the branch/commits/HEAD are never touched** and the identity/lock/main/
  running guards all stay unconditional.

### Fixed

- **Git removal 504 race and workspace residue** — the control-plane upstream
  idle timeout is raised 10s→45s (above the host's 30s git mutation budget)
  and the browser git RPC timeout 30s→60s: a slow `git worktree remove` over
  a node_modules-heavy directory is no longer cut with 504 after the host
  already committed, and no longer strands the workspace registration as a
  plain workspace.
- **Git host** — fall back to newline-delimited `--porcelain` on pre-2.47 Git
  (unknown `-z` switch exits 129); disable worktree hooks via the
  highest-precedence `-c core.hooksPath` so a repo's own `core.hooksPath`
  cannot re-enable `post-checkout`.
- **Control-plane hardening** — strip forwarded identity headers in the
  proxy; drain oversized JSON request bodies on keep-alive (no long-lived
  connection squatting); fail closed on an unverifiable reaper port; enforce
  loopback-only bind addresses.
- **Desktop security** — reject renderer-supplied `file:` plugin specs; deny
  web permission requests by default (clipboard write exempted).
- **Renderer** — bounded retry on pre-ready 503 while preloading extra rows
  (profile-installed plugins no longer silently lost during the instance
  spawn window); load only root-relative host-graph bundles.
- **Sidebar** — drop the dead `sessions.state` completeness check (fixes the
  session status icon lagging a poll cycle after a broken snapshot push).
- **Settings bridge** — keep the server dropdown open while its search
  focuses; move the client-plugin diagnostic into the connections plugin's
  chamber block.
- **VS Code plugin** — place the button in the official
  `conversation.session.header.utilities` slot (no more overlap with the
  utilities row); use the official icon resources and order before
  session-log.

### Changed

- **Release pipeline** — macOS Developer ID signing/notarization wiring
  (fail-closed: missing credentials or failed verification aborts the
  release, and credentials are preflighted before deleting the old Release).
- **Performance** — the sidebar skips re-rendering when the drag target did
  not change.

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
  6h interval), a low-key Settings "Update" section, download only after explicit
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
  module A version and a live-effect tri-state (Effective / Effective after
  restart / Unknown)
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

[0.1.5]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.5
[0.1.4]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.4
[0.1.3]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.3
[0.1.2]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.2
[0.1.1]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.1
[0.1.0]: https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.1.0
