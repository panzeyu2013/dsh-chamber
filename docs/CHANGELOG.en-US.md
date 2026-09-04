# Changelog

All notable changes to dsh-chamber are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release artifacts and per-release notes also live on the GitHub Releases page
(`https://github.com/panzeyu2013/dsh-chamber/releases`).

> 中文版: [CHANGELOG.md](../CHANGELOG.md)

## [Unreleased]

### Added

- **`update` syncs the dsh anchor by default (design 17/18 consistency)** —
  `install-gateway.sh update` gains `--dsh-upgrade/--no-dsh-upgrade`
  (**default: upgrade**). The target gateway asset carries its release line's
  paired dsh baseline (`dshAnchorVersion` in `packages/gateway/package.json`,
  hard-asserted in sync with the installer constant and the release.yml env by
  release-preflight; assets without the field fall back to the running
  script's constant). After the hot switch the `dsh-anchor` is upgraded to
  that baseline via staging + an atomic swap, so the F4 shell-upgrade fallback
  on first boot lands on the new baseline — the managed dsh stays consistent
  with the gateway. `--no-dsh-upgrade` (or declining the interactive confirm)
  pins the pre-upgrade dsh version. Failures (npm install/verify/swap) roll
  back with the update (old anchor restored); INT/TERM restores the anchor
  best-effort, and crash leftovers under `.anchor.*` are cleaned by the next
  `acquire_lock`. The npm mirror chosen at install time is persisted into
  gateway.conf (`NPM_REGISTRY`) from this release onward and reused by the
  update-time anchor sync (mirror choices of older installs lived only in the
  wizard's memory — add `NPM_REGISTRY` to gateway.conf before the first anchor
  sync on such deployments; the failure hint points there). Sites: `scripts/install-gateway.sh` (cmd_update + anchor
  helpers), `packages/gateway/package.json`,
  `scripts/dev/release-preflight.mjs` (three-source assertion),
  release-checklist and deploy-gateway.md docs.

### Fixed

- **Gateway crash-loop self-healing after an interrupted upgrade (design 18 F4)** —
  An interrupted F4 shell-upgrade fallback whose intent journal was lost (e.g. the
  installer's health-check timeout rolled back to an older gateway shell, which
  consumed the newer shell's journal) strands the durable state as "current
  pointer still on the old tree + override invalidated + no journal": the startup
  transaction reports clean, yet the first startLocal's resolveWorkspace throws
  `gateway runtime current pointer has no matching active override`, hard-exiting
  the process into a systemd crash loop with no HTTP recovery surface. The
  gateway/desktop boot F4 gate now re-arms the shell-invalidation transaction
  (snapshot + probe-gated builtin fallback) whenever the pointer exists with an
  invalidated override and no resumable journal, self-healing instead of
  crash-looping; the invalidated record and historical selection are preserved.
  Stale failure markers (lastOutcome=snapshot-failed/swapAttempted) are
  superseded per fresh-transaction semantics — an F4 whose journaled apply
  kept failing at the snapshot retries every boot and heals once the cause
  clears. Fix sites: `packages/gateway/src/runtime-manager.ts`
  executeStartupTransaction,
  `packages/desktop/main.ts` boot F4 gate (parity).

## [0.2.1-beta.1] - 2026-09-03

### Added

- **Linux desktop first-party support (design 22)** — AppImage (x64) distribution shape (electron-builder linux target / desktop.entry / executableName), Linux auto-update unlocked behind an install-shape gate (packaged AND started from a writable `$APPIMAGE`; dev / unpacked-dir / deb shapes keep the historic inert reason string and settings button gate — zero UX regression), per-user protocol-handler `.desktop` rewritten on every packaged launch (MimeType=x-scheme-handler, Exec targeting `$APPIMAGE`), XDG-compliant autostart (honors `XDG_CONFIG_HOME`, adds Icon/StartupWMClass), platform-split node fallback roots with X_OK checks, platform-neutral EINVAL/ENOTSUP tolerance for directory fsync (NFS/FUSE home dirs), Linux install roots added to pnpm resolution, plus a `build-linux` release.yml leg (ubuntu-22.04 baseline) and the 4-leg release policy test. Contract and remaining real-machine gates: `docs/design/22-linux-desktop.md`.
- **Windows first-party support progress (design 23)** — M0–M6 code landed: CI `test-windows` contract leg and win32 lifecycle probes (`win-probes.ts`: PowerShell CIM identity / netstat port / taskkill tree kill; platform-adaptive reaper and spawn-dsh wiring), `win-acl.ts` ACL tightening on the startup path, NSIS uninstall cleanup, win32 login autostart and packaged deep-link registration, open-in local drive-letter paths, SSH password gate guidance; dsh-runtime gains `windows-process.ts` (supervisor tree termination) / `rename-retry.ts` (Windows rename retry), and snapshot publish/restore/stash all move onto the retry path. Runtime management stays read-only by default on Windows with `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1` as the dev/validation gate (strict '1', off by default). Real-Windows runner first run and the real-machine matrix remain external gates — see `docs/design/23-windows-support.md` and the ledger.
- **Unified gateway and SSH plugin management (design 21)** — the gateway gains a `/chamber/plugins` install/remove/materialize/tasks write surface with journal/queue plus the `/chamber/plugins/installed` read face, tgz scanning and plugin-spec validation; the desktop side builds/syncs plugin tarballs and the SSH backend shares the same model (apply-rows/journal); a managed profile-write lease serializes against runtime transactions, and the `/chamber/runtime/start` primitive (stopped/error/restart-exhausted recovery, decision 12) is added. Contract: `docs/design/21-gateway-plugin-parity.md`.
- **Unified dsh runtime settings surface (local × gateway isomorphism)** — a shared colored status-badge vocabulary, snapshots/disk folded into the current-state group, unified registry read-only row + edit mode, always-visible "clean up installed versions"; the gateway gains `cleanup-version` / `restore-pre-rollback` / `recover-metadata` routes; FATAL metadata corruption becomes blocked-alive (gateway stays up, the managed dsh stops, the management surface stays pollable, recovery = recover-metadata); status gains the metadata-health projection; desktop env/read-only platforms may now restart dsh.
- **Built-in-version row guidance (2026-12 user decision)** — in both the desktop and gateway settings, selecting the row whose version equals the built-in (bundled copy / deployment anchor) while no managed tree exists turns the primary button into "Restore bundled" (clears the user selection back to the built-in copy/anchor, zero download); "download and install it as a managed tree anyway" stays as an explicit secondary action; cached rows keep the ordinary switch.

### Changed

- **Desktop packaging config** — `build.linux` target moves from `dir` to `AppImage`; new `dist:desktop:linux` / `dist:linux` scripts.
- **updater.ts Linux gate is shape-based** — the unconditional `platform==='linux'` gates become a "writable AppImage runtime" gate (`probeLinuxAppImage`); non-AppImage Linux keeps the same blocked reason and settings-bridge button gate unchanged.
- **Lazy Electron binaries (machine-shared dist)** — the root postinstall no longer downloads Electron by default; `DSH_CHAMBER_ELECTRON=1` or the first dev launch materializes it into a platform-cache shared dist (one copy across parallel worktrees); the dev control-plane port auto-backoffs from 17520 to the first free port (`DSH_CHAMBER_CP_PORT` pins it).
- **dsh baseline upgraded to 0.1.2-rc.1** — both the build-time source line (submodule pin) and the bundled runtime (`@deepseek-ai/dsh`) advance to dsh-v0.1.2-rc.1 (a66e4702); upstream rc.1 carries **zero code changes** relative to alpha.5 — all 252 repository `package.json` files only bump their version line (alpha.5 → rc.1, verified by diff), with no client/wire/storage/DOM additions — the in-repo fork copies (connection/web/api-gateway) need no code replay and only sync their version markers; DOM anchors and wire contracts inherit the alpha.5 audit baseline.
- **Gateway runtime client core restructure (design 21 §5.2)** — the pure core (parsers / action gates / error classification / polls) moves into the sidebar shared face; settings-bridge keeps only the view mapping; consumer ambient mirrors stay in sync, locked by a lockstep test.

### Fixed

- **Renderer extra-bundle recovery across instance restarts** — extra-bundle loads that arrive inside an instance-restart window are no longer dropped: they resume correctly after the restart instead of leaving that plugin row silently missing.

## [0.2.0] - 2026-09-03

### Added

- **Authenticated server-side Gateway** — a separately deployable `@dsh-chamber/gateway` hosting a single loopback dsh instance and exposing the official frontend/API through a unified HTTP/WS request boundary that is authenticated by default (password login + bearer token) with bounded proxying; the login page and request-boundary diagnostic pages follow the official dsh-blue design language and the browser display mode, rejected browser requests receive same-status localized explanation pages (echoed values HTML-escaped, no scripts), and API clients keep the `{error, code}` shape; external deployments are authenticated by default and `--no-auth` is only an explicit trusted-network exception. Ships with the `install-gateway.sh` one-shot installer: interactive wizard (ESC-back, validation loops, offline-package auto-detection), offline `--tgz` installs with content-fingerprint updates, transactional `update` with automatic rollback, `--service-user` dedicated run user, systemd/user/foreground service shapes and 0700 state-layout convergence. The Gateway is distributed as a `.tgz` on GitHub Releases (npm publishing deferred).
- **dsh runtime version management** — install/switch/roll back the dsh runtime at run time: registry-origin binding + SRI verification, embedded-pnpm `file:` installs, probe-gated atomic activation with two-phase rollback/recovery, and a journal/snapshot/stash data-safety loop; user-triggered immediate apply (apply-now) is supported. The core is extracted into the shared pure-Node `packages/dsh-runtime`, and desktop and Gateway settings share the same runtime-management surface (the `dsh-runtime` settings section: full local management, proxied `/chamber/runtime` for gateways, not mounted for ssh/http direct targets); the installer seeds a controlled dsh anchor that can be switched at run time via `/chamber/runtime`.
- **Unified open registry open-in** — the former VS Code deep link grew into a unified open surface: the per-session open entry goes through the main-process OpenInApp provider registry (Finder, local and remote VS Code) with a six-step loud execution pipeline and source-lifecycle proof; remote VS Code opens over the SSH tunnel; the plugin package is renamed `dsh-chamber-client-ui-open-in`.
- **Native desktop notifications** — session completion / agent questions / approval requests push native notifications (opt-in via settings): the renderer detects edges on the runtime fact channel, the main process renders Electron Notifications, and clicking opens the session; multi-instance (N-ctx) routing is generation-fenced.
- **Sidebar enhancements** — sessions/workspaces grouped and collapsible per source, drag-sorting with live cross-instance sync (persisted view prefs), in-place workspace rename (visible and working while the group is folded), Git worktree topology with identity-derived family colors; session create/fork convergence fixes (no row/icon/position jumping) and restored pending indicators and notification edges for questions/approvals.
- **Connection model v2 and direct targets** — desktop transport and target are decoupled: `ssh | http` × `dsh | gateway` combinations (http-direct dsh is disabled before this release on the 0.1.2 line — see Changed; ssh is the only dsh transport); connection failures now distinguish "SSH transport error" from "dsh instance probe failure"; the connections settings page gains a plugin-inventory view and per-server runtime section.
- **Gateway runtime credential management** — v2 credential envelope, `/auth/change-password` `/auth/change-token` `/auth/credentials`, and the stopped-state `gateway auth` CLI; desktop credential panel with change-password/token-rotation entry points.
- **Mobile web access surface** — the `dsh-chamber-client-ui-mobile` adaptation plugin: narrow-viewport drawer layout, 44px touch targets, safe-area handling, single-line composer input with full IME recovery, and a dual-source drawer scroll lock over `layoutFacts`; the UA redirect switch is off by default; it ships with the Gateway artifact as the single packaged chamber client-plugin seed.
- **chamber host-plugin seed registry** — the desktop syncs chamber host packages (host graph, Git worktree) into the server state dir via `PUT /chamber/plugins`, version-locked to the connecting desktop, so managed dsh instances gain chamber host extensions at every spawn (the activation probe skips the chamber host domains until a sync exists).

### Changed

- **dsh baseline upgraded to 0.1.2-alpha.5** — the 0.2 line moves the dsh baseline from the 0.1.x line of the v0.1.5 era onto 0.1.2: the breaking 0.1.2 wire changes (`workspace.list`, `SessionSummary.pendingInteraction` and `host.describe` removal, smooth-corners visuals, …) are adapted explicitly on the chamber side — sidebar archive/state flows over the push channel, pending switches to the official ui-session registry, and notification edges and host facts move to the new channels; the alpha.5 delta is entirely host-side storage (session-projection-cache/storage cross-version read compatibility: `session_projcache` v5 declares `compatibleVersions` [3,4], corrupt records are salvaged via `backup-and-skip`, fixing app-start failures and missing session-list titles when upgrading from 0.1.1-rc.2 / 0.1.2-alpha.3) — the client/wire/protocol surface is untouched, the in-repo fork copies (connection/web/api-gateway) need no code replay and only sync their version markers, and DOM anchors and wire contracts need no re-audit (verified by diff).
- **dsh×http direct combination disabled** — the http-direct dsh target is hard-blocked on the 0.1.2 line (the host answers 401 without the spawn-time browser-auth launch token; unrecoverable remotely): the connection form no longer offers http for dsh (a kind switch into dsh moves an http draft onto ssh) and the main-process http provider refuses kind dsh at the registry mutation point; ssh is the only dsh transport and http serves gateway targets only.
- **Gateway shape consolidation** — the orchestration surface is stripped entirely: the Gateway is auth + reverse-proxy shell + host duties + seed registry; the desktop "gateway orchestration" section is removed, and cross-session scheduling/approval proxies/session indexes no longer exist server-side — session business is entirely the official dsh frontend's.
- **Credential and connection hardening** — desktop credential storage moves to safeStorage v3 (target-bound, honest 0600 plaintext fallback), with the SSH password mirror and Gateway secrets under the same discipline; with an HTTPS SPKI pin no application bytes flow before the peer key matches; connection reconfiguration is generation-fenced so stale credentials/sessions never cross; a lightweight non-secret audit trail is added.
- **Install and runtime surface hardening** — gateway state roots auto-tighten to 0700 with owner checks (foreign owners fail closed); the installer private layout converges to 0700; the systemd unit `EnvironmentFile=` quoting template is fixed; instance reverse-proxy capability bounds and bounded request-body reads; plugin actions require main-process confirmation and local paths are masked (v1 security mitigations).
- **Build and release infrastructure** — the build-time vendor source tree becomes a pinned git submodule with link-set assertions; the release pipeline gains full-chain dry-run validation, action-SHA preflight, and strict stable/beta update-feed isolation; Electron binaries install lazily (desktop installs no longer download ~100 MB by default).

### Fixed

- **Reverse-proxy disconnect-detection false kills** — the control-plane instance proxy used to treat bodyless requests and WS handshakes as client disconnects (Node fires `IncomingMessage 'close'` once the body is consumed), aborting every proxied GET/HEAD and WS upgrade: bundle-load timeouts, endless web-runtime reconnect loops and instance boot failures; with disconnect detection moved to the response leg and the browser socket, healthy traffic is no longer killed (including the same fix for health SSE and real-stream integration regressions).
- **Browser logins to the Gateway always 403'd (live finding)** — `Referrer-Policy: no-referrer` made compliant browsers serialize same-origin form Origins as `null`, which the request policy rejects fail-closed; the login page and control-plane responses switch to `same-origin` (no cross-site outbound document requests exist, so the privacy intent is unchanged), with regressions locked by header assertions.
- **A revoked Gateway session no longer presents as connected for hours** — READY transports re-verify identity on a 60s cadence, and password sessions self-heal through the cached-cookie → 401 → single automatic re-login flow; a refused re-login lands explicitly on `requires_user_action` (red dot + connections-page guidance), proxy registrations re-apply on auth-header fingerprint changes without revoking healthy traffic, and clicking a source or opening a session triggers one immediate probe.
- **Sidebar 0.1.2-migration regression cleanup** — archived sessions/workspaces resurrecting, missing question/approval pending indicators, notification-edge withdrawal-window false reports, silent no-op rename of folded workspaces, and dead-channel residue removal.
- **Gateway state permission contract fix** — pre-existing loose (0755) state roots no longer crash startup fail-closed; they are auto-tightened with owner verification, and the installer converges on the same contract.

## [0.1.5] - 2026-08-23

### Added

- **VS Code deep-link plugin** — `dsh-chamber://` OS deep links
  plus an in-app button that launches the local VS Code Remote-SSH session
  for the target server instance (local: `vscode://file/`, remote:
  `ssh-remote+`); the button sits in the official session-header utilities
  slot (left of session-log) with the icon taken from the local VS Code
  official resources.
- **Git worktree removal enhancement**
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

- **Git worktree plugin OpenChamber presentation alignment**
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

- **Independent Git worktree plugin** — adds the in-instance
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
- **In-app "Check for updates" button and update settings section** — the
  settings General section gains `UpdateSection`, letting the
  user trigger an explicit update check (same path as the startup/periodic
  silent checks, never auto-downloads); `update-gate` phase gate + unit test.

- **rc.8 backend version tolerance** — an instance
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


- **Quit-flow hardening** — the quit confirmation now
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


- **Full dsh rc.8 baseline alignment** — `harness.commit` →
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
- The failure-degrade semantics are stated per layer: load failures
  stay loud at the preload layer (collectExtraRows), apply/materialize
  failures degrade at the boot-kernel layer.

## [0.1.2] - 2026-08-19

### Added

- **Desktop auto-update** — silent update checks (startup delay +
  6h interval), a low-key Settings "Update" section, download only after explicit
  user confirmation, install on quit. Update feed shipped for both platforms
  (`latest.yml` / `latest-mac.yml`; beta channel via a semver prerelease
  version). macOS install leg reports honestly when a Developer ID signature
  is absent (manual-install hint, never a fake success).
- **Sleep / background persistence** — configurable close behavior
  (hide to tray while dsh keeps running, or quit, with a quit confirmation
  when active tunnels or the local instance would be stopped), launch at login
  (mac/linux), immediate reconnect on OS wake (no heartbeat watchdog wait),
  keep-awake toggle. Settings persist in the main-process
  `chamber-settings.json` (0600, atomic, corrupt-file preserved).
- **Chamber settings page (v1 flat form)** — fixed Settings-shell
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
- Client plugin runtime loading: per-instance host-graph merge,
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
- Auto-update redesigned as a quiet settings-based flow.

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
