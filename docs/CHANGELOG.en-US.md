# Changelog

All notable changes to dsh-chamber are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release artifacts and per-release notes also live on the GitHub Releases page
(`https://github.com/panzeyu2013/dsh-chamber/releases`).

> 中文版: [CHANGELOG.md](../CHANGELOG.md)

## [Unreleased]

### Fixed

- **Gateway state root permission contract: fail-closed `require 0700` → auto-tighten + owner check** —
  `createGatewayStore` no longer refuses to start when a pre-existing state root
  is not exactly 0700 (legacy installs created a 0755 root under the default
  umask, which crash-looped under systemd). The root is now tightened to 0700
  via a pinned no-follow descriptor; a new owner-uid check fails closed on
  foreign-owned directories (a root service must never adopt another user's
  directory and then read/execute its content as install input), and the mode
  is re-verified after fchmod to keep fail-closed on filesystems that silently
  ignore chmod (2026-09 user decision).
- **install-gateway.sh private layout converges to 0700** — the script now sets
  `umask 077` globally and `ensure_private_layout()` creates/verifies
  BASE_DIR/gateway/versions/dsh-anchor/bin/run as 0700 across install, update
  and foreground restart flows, closing the early 0755 window on
  BASE_DIR/GATEWAY_DIR.
- **systemd unit `EnvironmentFile=` unquoted** — the directive does not support
  quoting; the old template emitted a quoted path that was looked up literally
  and silently failed to load (service started with an empty environment /
  defaults). The raw path is now written.
- **control-plane recursive mkdir uses explicit 0700** — `ensurePrivateDirectoryNoFollow`
  and `createJsonStore` now pass `mode: 0o700` when creating ancestor
  directories (defensive).

## [0.2.0] - 2026-08-31

> **First stable release** — aggregates the full 0.2.0-beta.1 → beta.4 line
> (desktop connection manager + authenticated Gateway (design 17) + dsh
> runtime version management (design 18); the complete evolution is recorded
> in the per-beta sections below) plus the closing changes:

### Changed

- **`scripts/` layout reorganization** — all developer/maintainer/test scripts now
  live under `scripts/dev/` (including `update-vendor.mjs`, new path
  `node scripts/dev/update-vendor.mjs <tag>`); `scripts/` keeps only the
  user-facing `install-gateway.sh` and the directory convention README.
- **`install-gateway.sh` full rework** — 8-stage interactive wizard (welcome
  page + version channel / access mode / credentials / ports / service mode /
  dsh runtime / location / preview confirm; `q` quits, ESC or `back` goes back,
  every step explained with validation loops, non-interactive `-y` uses all
  defaults); **local install by default** (the gateway owns dsh versions,
  switchable at runtime via `/chamber/runtime`); new `restart` subcommand;
  double-entry credentials with character count, empty = auto-generate shown
  once on the completion page (TTY only; non-TTY points to the 0600 file);
  `--no-auth` requires an interactive YES confirmation; npm mirror three-way
  choice (CN mirror default); take-over suggestion for pre-existing dsh;
  idempotent PATH setup and script self-copy; preflight (node/curl) and flag
  value validation (ports/bind/origin/proxy/credential lengths/channel).
- **Deployment docs relocation** — `docs/deploy-gateway.md` moved into the new
  `docs/deploy/` directory; the README "Remote dsh instance (systemd)" section
  extracted to `docs/deploy/remote-dsh-instance.md` with a short note and link
  left in the README; all references updated.

### Fixed

- **CI: host-graph typecheck could not resolve `compression`/`negotiator` on a
  fresh install** — pnpm links registry deps of symlinked vendor workspace
  members with a depth computed from the logical path while physically creating
  them inside the checkout (broken links); the imports are new in upstream
  `dsh-host-webserver` (0.1.2-alpha.2). Map them to their @types packages in the
  host-graph tsconfig `paths`, following the `@standard-schema/spec` seam
  (types-only, no runtime surface).

## [0.2.0-beta.4] - 2026-08-30

### Added

- **Gateway runtime credential management (design 17 §7.4)** — gateway
  passwords/tokens became server state instead of deployment config:
  `<stateDir>/password-credential` and `tokens.json` now use a v2 JSON envelope
  (`{schemaVersion:2, source:'config'|'runtime', updatedAt, verifier|hash}`,
  0600 atomic writes; legacy v1 files migrate on next write). Config seeding
  (`seedCredentialsFromConfig`) asserts credentials only while unset or
  `source='config'` (rotating `jwt-secret` first on change); `source='runtime'`
  credentials are authoritative — config is ignored with a loud warning. New
  runtime API behind the auth gate: `POST /auth/change-password`
  (`{newPassword}` 12–1024 or `{remove:true}`), `POST /auth/change-token`
  (`{newToken}` 32–4096 visible ASCII, `{}` server-generated, or
  `{remove:true}`; plaintext returned exactly once), `GET /auth/credentials`
  (non-secret projection, HEAD supported). Error codes map to
  400/401/403/409/429/503/413. Non-ambient proof (S25): changes require a
  bearer-token principal or the current password; cookie-only principals are
  refused. Rotate-first on password changes; removing the last credential is
  refused 409 unless config provides a replacement (revert). stateDir
  exclusive lock `.gateway.lock` (O_EXCL-first + rename-claim takeover with
  moved-content verification and post-create ownership verification —
  provably no double-hold for two contenders, displaced owners fail closed;
  pid-verified release, exit listener registered only after a successful
  acquisition, `close()`/`reacquire()`); offline CLI `gateway auth
  status|reset-password --new PASSWORD|clear` (status is lock-free read-only;
  reset/clear refuse a running gateway with the structured `gateway_locked`
  error); S24 audit events `credential_changed`/`credential_change_rejected`;
  `/chamber/` Credentials panel (one-time 60s token reveal, config-reseed
  notices); S25 invariant; full fix round (mutual-exclusion 400 for
  `remove`+new value, verifier shape validation, `probe-error:<code>` audit
  detail, `/auth/*` no login redirect, boot line prints the effective auth
  kind). Desktop settings-bridge convenience reset remains deferred (STATUS).

### Fixed

- **The chamber shell no longer loads the official dev-only `dsh-client-hmr` entry** —
  its client fiber unconditionally opens `new EventSource('/plugins/events')` (an
  instance-origin relative path), which on chamber pages (control-plane origin)
  hits the control-plane SPA fallback's `index.html` (`text/html`), triggering
  "MIME type is not text/event-stream" abort errors on every boot and every
  EventSource reconnect; the web profile has no usable hmr client channel
  (design 09). It is now added to `CHAMBER_COVERED_IDS` (page-own, no factory)
  to skip loading. The same known issue `dsh-session-log-export` (the chamber
  view cannot export session logs while the instance's official UI works) is
  deferred by decision, see `STATUS.md`.
- **Host-graph 503 retry budget widened from 6 to 10 attempts (2.5s → 4.5s
  summed delay)** — measured local instance spawn→ready takes about 2.8–3.0s
  (control-plane host logs); the old budget could not cover the scenario where
  the shell starts exactly inside the spawn window, and after exhaustion it
  silently degraded per the existing contract (no extra plugins this boot).
  Non-503 channel failures still fail fast; the budget only affects the
  fast-503 path.

- **Control-plane reaper protects replaced ledgers** — before signaling or
  deleting, the reaper revalidates the record's device/inode and exact bytes;
  replacement, PID reuse, or a no-longer-matching record fails closed, avoiding
  an accidental process kill or deletion of a newer record.

- **Deterministic CI and release builds** — Gateway tests invoke the same build
  script when a clean checkout lacks the ignored dist bundles; fake-registry
  acceptance creates its secure user-data root first; third-party notices are
  generated from the actually declared direct dependencies, so local hoisted
  leftovers cannot pollute CI.

### Changed

- **dsh runtime "Apply now" (design 18 addendum)** — the pending phase gains a
  user-triggered "Apply now" action that runs the existing activation
  transaction (stop → snapshot → pointer switch → probe gate →
  verdict/rollback) in the current session instead of waiting for the next
  launch; the desktop host uses a native confirm, the gateway host exposes
  `POST /chamber/runtime/apply-now` (202 + status polling), and the gateway
  single-target proxy gains an activation-aware gate (no forwarding to an
  unverified candidate during the probe window). Zero new terminal states, zero
  new crash windows. See `docs/design/18-addendum-apply-now.md`.

- **Gateway login page aligned with the dsh design language** — the `/auth/login`
  pre-auth page went from a bare minimal form to a self-contained dark card page
  (a `--dsw-alias-*` token layer whose values match the `/chamber/` orchestration
  page): password-manager input hygiene (`autocomplete="current-password"`,
  `required`, `maxlength=1024`), en/zh copy selected by `Accept-Language` prefix
  matching, and an inline SVG favicon (the login CSP gains `img-src data:`;
  `script-src` stays absent). Login failures render same-status HTML error pages
  for browser forms via content negotiation (401 wrong password / 429 rate limit
  with `Retry-After` and the wait seconds / 503 busy), while API and desktop
  clients keep the byte-identical JSON shape; plaintext HTTP shows an honest
  warning banner and HTTPS shows an encrypted badge (the same `decision.secure`
  fact as the conditional `Secure` cookie); expired sessions surface a
  `/auth/login?expired=1` hint; token-only deployments serve an HTML 404
  explanation to browsers and `--no-auth` deployments never claim a token.
  Remains script-free, never echoes the password (S5), and leaves audit events
  and the failure status-code matrix unchanged (design 17 §7.1/§7.3).

## [0.2.0-beta.3] - 2026-08-29

### Added

- **safeStorage v3 credential storage (S22)** — `<userData>/gateway-secrets.json`
  schema v3 stores tokens and passwords in independent maps, per-dimension
  Gateway-target bindings, plus an authoritative
  file-level `storage:'safeStorage'|'plaintext'` discriminator (ciphertext is
  never guessed from its character shape), and wires
  `SecretCryptoAdapter` to Electron safeStorage, with a 0600 plaintext fallback
  when `isEncryptionAvailable()` is false. Passwords accept 12–1024 Unicode
  JavaScript characters while tokens remain 32–4096 visible ASCII; corrupt
  entries are preserved as `.corrupt`. Credentials are transient write-only form
  inputs, are never returned/prefilled or persisted by the renderer, and never
  enter the registry or logs. **Token and password are independent nullable dimensions**
  (design 17 §2.3; clearing one never clears the other), while whole-instance
  removal explicitly calls `setInstanceSecrets(id, null, null)`. The
  `instances_get` projection now includes the actual durable `secretStorage`.
  A plaintext mirror is atomically upgraded as soon as a keychain becomes
  available and claims safeStorage only after the rewrite succeeds; a nonempty
  unlabeled historical v2 file fails closed. Gateway and SSH credential loads
  reject symlinks/non-regular files, verify the opened inode, and tighten it to
  0600 before reading secret bytes. Nonempty legacy Gateway v1/v2 and SSH
  password v1 files lack trustworthy target bindings. A structurally valid v1 at
  the current path, a nonempty v2 with a valid storage discriminator, and SSH v1
  therefore fail closed under unique `.unbound-*` names and require explicit
  re-entry; a nonempty sidecar `gateway-tokens.json` v1 remains in place and is
  disabled rather than being assigned a guessed binding.
- **Password-login sessions** — Gateway `/auth/login` (minimal GET page; POST
  verifies the password, issues the `dsh_gateway_session` cookie, and redirects
  to `/`) plus the desktop `gateway-session.ts` manager. The 12-hour cookie is
  kept only in main-process memory and keyed by network origin, `Host`
  authority, and a stable connection-id/target scope; localPort is not session
  ownership. Six all-or-none `configureGatewaySessionProvider` hooks maintain
  the password session independently and probe with its cookie, invalidating
  and retrying after 401. Scope invalidation covers every historical origin and
  advances its generations; login, cookie probe, bearer fallback, and 401
  relogin fence late results after every await so they cannot continue network
  work or mutate cache/backoff/auth proof. A current-generation `cookie|bearer`
  proof gates ready registration: password targets fail closed without their
  cookie/proof, except for an intentionally verified bearer fallback. When token and password coexist, verifyUp, ready, and
  refresh registration carry both Bearer and Cookie and Gateway accepts either
  valid principal; token no longer shadows password. Empty credentials still
  inject no auth header, and instance-proxy revalidates the 0..2 header allowlist.
  **Pre-expiry refresh** (`gateway-session-refresh.ts`) logs in and re-registers
  the transport about 60 seconds before expiry, re-arming on ready and
  disarming on non-ready/removal/quit. Each action advances a per-id refresh
  epoch, and post-await work rechecks password/token/URL/pin/authority/scope;
  a changed tunnel endpoint logs in at its
  new origin. Refresh failure preserves the still-valid registration and
  retries at expiry; persistent failure is reported honestly and falls through
  to bounded reconnect/verifyUp instead of being hidden.
- **SPKI certificate pinning (S23)** — optional `spkiPin` (hex SHA-256 of SPKI
  DER) is an HTTPS-direct trust anchor. `verifyGatewayEndpoint` checks it on the
  socket `secureConnect` event and reports a terminal certificate-pin mismatch;
  instance-proxy carries the pin through registerTransport, forwardHttp, and
  forwardUpgrade, returning explicit `502 upstream_failed` on mismatch.
  Desktop login/probes and control-plane HTTP/WS proxying call `write/end` or
  send the upgrade only after the peer matches; no header, credential, password
  body, or other application byte reaches the upstream before that match, and
  a mismatch invokes no upstream handler/upgrade. HTTP
  rejects a pin. Real `node:https` self-signed-certificate fixtures cover a
  matching pin, a terminal mismatch, and ordinary HTTPS without a pin.
- **Lightweight non-secret audit (S24)** — desktop
  `packages/desktop/audit-log.ts` appends and fsyncs JSONL, enforces 0600 even on
  inherited loose files, rotates at 5 MiB to `<file>.1`, and serializes only an
  allowlist so accidentally supplied credentials never reach disk. It records
  connecting/ready/error transitions (including terminal user-action errors),
  transport register/unregister with only auth presence token+password|token|password|none and
  insecureHttp, and credential set/clear without values. Gateway
  `packages/gateway/src/audit.ts` writes under the 0700 state directory and
  classifies login results as success/invalid_credentials/rate_limited/busy
  with client source but never password, cookie, or session body. Both sides
  have unit coverage.

### Fixed

- **Crash-safe main-process connection save** — the renderer no longer chains
  write-only setters. `desktop_ssh_save_connection` snapshots registry metadata plus
  SSH password, Gateway token, and Gateway password in main, compensates every
  old value after any failed step, and safely scrubs with a loud error if
  compensation itself fails. Gateway credentials bind only to
  kind+host+remotePort while SSH passwords bind separately to host+user+sshPort.
  Each binding is committed with its secret and rechecked against the current
  registry before injection, so a hard crash between secret and registry fsyncs
  cannot send a new value to the old target. Blank add/enter/leave/retarget also
  clears hidden half-transaction values. Exact `desktop_ssh_delete_connection(id)`
  disconnects, invalidates the exact-scope sessions, and clears secrets before
  metadata; an absent id is an idempotent no-op. Legacy `instances_set` accepts
  only the exact unchanged normalized current roster, and
  all three individual setters are clear-only. Real Gateway ssh↔http changes are
  therefore not mistaken for auth retargets.
- **Connection reconfiguration generations and systemd argv boundary** — edits
  to `serviceName` or `remoteDshHome` advance both the transport generation and
  `execEpoch`, cancel old live/retry/probe work and exec children, and fence the
  next multi-step spawn plus late logs/projections/results; a formerly non-idle
  connection alone restarts with the new values. systemd uses the fixed argument
  array `systemctl <action> -- <serviceName>`, with
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` requiring an alphanumeric first character.
- **Gateway recovery reachability and orthogonal authentication** — a Gateway
  transport now proves the authenticated `/chamber/runtime/status` identity
  instead of being gated by managed-dsh `host.describe`, keeping recovery
  reachable while dsh is blocked/down. SSH-tunnel Host and session authority use
  remote `127.0.0.1:<remotePort>`, so SSH aliases/DNS no longer cause 421 or cache
  key drift. Direct/SSH/refresh regressions cover dual-header OR-principal fallback.
- **Cross-user SSH askpass directory pre-claim** — password-bearing helpers no
  longer use the globally pre-claimable `<tmp>/dsh-chamber-ssh`. Each process
  gets an unguessable 0700 `mkdtemp` directory whose uid/type/inode/mode are
  verified; EPERM or owner mismatch fails closed. Helpers use O_EXCL and become
  executable only after a complete fsync. Every tunnel/systemd/run child owns a
  lease deleted only on its real exit/error/spawn failure; removal/clear delays
  cleanup of live leases instead of evicting paths by a fixed generation cap.
  Startup cleanup touches only trusted directories owned by the current user.
- **Instance-proxy capability boundary** — local/dsh/legacy sources now reject
  normalized `/chamber/*` paths, including encoded, dot-segment, and backslash
  variants; only Gateway sources may reach that surface. Together with the
  no-auth dsh HTTP-direct rule, this prevents kind/transport confusion from
  widening capabilities.
- **Gateway authentication protocol hardening** — the shared HTTP/WS request
  policy rejects duplicate Authorization from `rawHeaders` before auth work;
  Bearer is single-valued and limited to 32–4096 visible ASCII before any
  hash/scrypt. JWT `exp` must be an unexpired safe integer no later than now+12h;
  missing, nonnumeric, infinite, fractional, unsafe, expired, and over-window
  values are rejected. Desktop instance-proxy mirrors the Bearer lower bound
  and requires Gateway-over-SSH authority to be remote
  `127.0.0.1:<port>` with a valid port range. If the token scrypt work gate is
  saturated, an independent valid Cookie still authenticates successfully;
  only an invalid Cookie preserves the original 503 `auth_busy`, enforcing OR
  principal semantics under overload too.

- **dsh HTTP-direct registration boundary** — canonical
  `{kind:'dsh', transport:'http'}` now carries its explicit transport dimension
  into instance-proxy registration and may use a user-configured public
  `http(s)` origin, while the target still strictly forbids auth headers and
  `/chamber/*` capabilities. `{kind:'dsh', transport:'ssh'}` and legacy
  registrations with no transport remain loopback-only, so the existing SSH
  and local trust boundary is never widened silently.
- **Bounded Gateway runtime JSON-body reader** — the 64 KiB
  `/chamber/runtime` JSON reader now uses a cumulative byte counter. On overflow
  it immediately releases retained chunks, ignores all later `data` events,
  and still sends 413 before destroying the request. This removes the O(n²)
  per-chunk `reduce` scan and prevents poison chunks from consuming more CPU or
  memory after rejection; a malicious trailing-chunk regression covers it.
- **Gateway runtime recovery and projection integrity** — `restore-builtin` no
  longer deletes selection metadata directly. It reuses the stop, snapshot,
  atomic pointer switch, full probe, and rollback/data-restore transaction, and
  clears override/journal only after success. Registry configuration falls back
  to the default only when truly absent; corrupt, symlinked, or hard-linked
  files are quarantined and fail loud, writes are atomic, and source changes are
  fenced during installation. Offline version lists retain every valid cached
  tree. `/chamber/runtime/status` uses a fixed identity and reports the actual
  env/override/current/builtin source plus failure/restore/pre-rollback,
  snapshots, progress, and classified disk usage. Desktop settings and the
  standalone `/chamber/` page expose the complete action/status surface, which
  remains reachable while managed dsh is blocked or down. A durable
  `selectedOnly` marker distinguishes a legitimate staged selection over the
  builtin anchor from a missing active-user pointer. Install writer single-flight
  is separate from activation quarantine, so downloads keep the current proxy and
  features online while candidate-ready edges stay detached until probe verdict.
  Healthy env overrides no longer appear blocked, and ordinary pending permits
  only restore-builtin in core, routes, and both UIs.

### Changed

- **Build-time vendor source submoduled** — `vendor/harness-checkout` migrated
  from multi-source fallbacks (env override / sibling checkout / codeload
  download) to a fixed-commit git submodule: the gitlink is the pin (single
  source of truth), `ensure-harness-vendor` hard-verifies submodule HEAD ==
  `harness.commit`, rebuilds links idempotently (no-op when the link set is
  unchanged), and asserts the link set matches the lockfile's vendor importers
  (`--check`); `verifyDepsBeforeRun: false` kills pnpm's implicit non-frozen
  installs; CI checkouts materialize the submodule and assert zero lockfile
  drift after frozen installs; new `scripts/update-vendor.mjs <tag>` is the
  only upgrade entry for the upstream pin.
- **Design 17 rewrite (2026-09 connection model v2)** —
  `docs/design/17-server-side-gateway.md` now makes remote connections a
  first-class surface with four orthogonal dimensions (dsh/gateway target ×
  ssh/http transport × nullable token/password credentials × server channel).
  Explicit plaintext HTTP and unauthenticated use are a bounded user decision
  (S21): the client does not pre-reject them and the server remains the auth
  authority. Security extensions are decided individually: S22 safeStorage,
  S23 SPKI pinning, and S24 lightweight audit are integrated, while mTLS and
  per-connection network policy retain extension slots. The design is
  self-contained and no longer derives orchestration rules from design 01.
- **Connection-model v2 migration decision (design 17 §2.2/§9.1)** — source IDs
  move from `ssh-<id>` to `dsh-<id>` / `gateway-<id>`, with the old `ssh-`
  prefix retained for legacy deep-link mapping. Old `kind:'ssh'` loads as
  `{kind:'dsh', transport:'ssh'}` and old `kind:'gateway'` gains
  `{transport:'http'}`. Kind controls target semantics: dsh never receives auth
  headers or `/chamber/*`, while gateway may inject independently nullable token
  and password credentials. Related docs now align design 01 references and
  bounded S22/S24 exceptions, designs 08/19 source-ID enumerations, design 11
  package counts and userData retention, design 14 tray connection counts and
  quit confirmation, and designs 16/20 legacy wording. **S22/S23/S24 and the
  password-login session ship in this release** as listed above; remaining
  real-machine release gates are recorded honestly in
  `docs/progress/STATUS.md`.
- **Release-channel and Gateway distribution closure** — stable desktop builds
  use the package configuration and generate only `latest.yml` /
  `latest-mac.yml`; beta builds use the independent
  `packages/desktop/electron-builder.beta.yml` and generate only `beta.yml` /
  `beta-mac.yml`, with negative assertions preventing either feed from
  overwriting the other. The release gate accepts only canonical stable
  `X.Y.Z` or beta `X.Y.Z-beta.N`; `alpha`, `rc`, and every other prerelease fail
  closed, and only an exact `-beta.N` app selects beta from its own version.
  Each check uses the bounded Releases API to select only the highest canonical
  published `vX.Y.Z-beta.N`, then switches to that exact-tag Generic feed and
  stops on discovery failure instead of invoking a stable `latest*` fallback.
  Formal macOS publication checks all five signing and
  notarization credentials before any Release mutation, then requires Developer
  ID, stapler, and Gatekeeper verification before public finalization. Only
  `dry_run` may produce an ad-hoc mac build; even when formal secrets exist it
  unconditionally clears all signing/notarization variables and `GH_TOKEN`,
  creates or modifies no Release, and uploads no artifacts. Gateway distribution is limited to a
  clean-prefix-smoked `.tgz` plus its `.tgz.sha256` on GitHub Releases; npm
  publish and dist-tags are deferred.

## [0.2.0-beta.2] - 2026-08-27

### Added

- **Serverized gateway runtime management (design 18 M5–M7)** — authenticated
  `/chamber/runtime` surface (status / versions / select / apply / rollback /
  restore-builtin / retry-apply / retry-restore / restart / registry, exempt from
  the not-ready gate): startup transaction (cleanup → snapshot → atomic pointer
  switch → candidate spawn → full activation probe set) with two-phase
  rollback/restore; runtime-manager (env → override → builtin anchor resolution,
  intent journal, fail-loud owner takeover, 409 mutation exclusion,
  blocked-but-alive / FATAL projection); restart endpoint whitelist
  (ready / degraded) with honest failure (resolve ≠ success: stopped /
  restart-exhausted never reports ok).
- **Shared pure-Node runtime core `packages/dsh-runtime`** — the desktop main
  process and the gateway server adapt the same core through real DI seams
  (StartupDeps / ApplyDeps / InstallerDeps / ControllerDeps; `RuntimeHostAdapter`
  remains a documented sketch); runtime state and version trees are never shared
  between owners.
- **`dsh-runtime` settings section (design 18 §3.6)** — local = full runtime
  management, gateway = proxied `/chamber/runtime`, ssh = version read-only;
  every source gets a restart-dsh action (control-plane `restartLocal()` /
  `/chamber/runtime/restart` / `restart_service` systemd IPC) without restarting
  the Electron shell.
- **Controlled installer anchor** — install-gateway.sh installs the dsh builtin
  anchor into the gateway-controlled directory (`${BASE_DIR}/gateway/dsh-anchor`,
  `npm install --prefix` workspace shape) instead of the npm global tree; runtime
  versions are still installed by the gateway's embedded pnpm into
  `<stateDir>/dsh-runtime/` via `/chamber/runtime/select`.
- **Chamber host packages ship with the gateway tarball** — the build copies
  `dsh-host-client-graph` / `dsh-chamber-host-git-worktree` (package.json +
  committed dist) into the gateway package and injects them into the
  control-plane seed (`hostGraphPackageSourceDir` /
  `hostGitWorktreePackageSourceDir`); managed dsh instances expose the chamber
  RPCs so the full activation probe set passes server-side (verified live).

### Fixed

- **install-gateway.sh npm-global anchor path semantics** — `verify_dsh` expects
  the workspace shape (`<ws>/node_modules/@deepseek-ai/dsh`) but the global
  branch passed `npm root -g` (itself the node_modules directory), so
  post-install verification always failed and the anchor pointed at the wrong
  place; both paths now convert to `dirname(npmRoot)` (live-test finding).
- **Response-leg disconnect detection (main 6791f84 merged)** — `IncomingMessage
  'close'` fires as soon as the request body is consumed (immediately for a
  bodyless GET), so request-leg detection aborted every GET/WS forward and SSE;
  detection moved to the response leg (`res 'close'` + `writableEnded` guard,
  raw browser socket for WS upgrades).
- **M3b compression headers** — `accept-encoding` is stripped upstream (the
  proxy never negotiates compression); response `content-encoding` rides through
  the header whitelist so the browser decodes correctly.
- **Main-process plugin action confirmation (design 09 §4)** — local/remote
  plugin installs & removals and the materialize transfer require a confirmation
  dialog; a dismissal is never reported as success
  (`{ok:true, cancelled:true}`).
- **H2 generation-aborted health probes / killFailedSpawn host-log writer /
  reaper command identity / fsync'd atomic writes** (audit rounds merged).
- **Spawn pid-record failure is fail-closed** — the child is reclaimed and the
  spawn throws `dsh_spawn_non_retryable` (never retried on another port;
  resolution kept when merging with main's retryable semantics).
- **Sidebar create/fork convergence without the ungrouped flash** and
  **open-in dropdown icon + short app name**.
- **Release-gate fixes (2026-09 beta.2 incident)** — preload.cts restores the
  local `ChamberInjectionState` declaration (L3 lockstep guard regression);
  workflow action-SHA gate (`release-preflight --actions-only`) + script path
  fixes; **shared-core F4 fix**: `writeActivationIntent` and the journal
  round-trip parsers accept the `builtin-anchor` sentinel (previously any
  machine with an existing override record crashed at shell upgrade startup);
  tests' hardcoded versions decoupled.


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
  Password changes revoke old cookies across restarts and token replacement closes
  established streams. Credential values are transient write-only connection-form
  inputs; otherwise they are never returned or prefilled by main, persisted by the
  renderer, or placed in logs, managed dsh, or Git environments. The shared proxy enforces a real process-wide
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

- **Main-process confirmation for plugin actions (design 09 §4 v1 security
  mitigation)** — `desktop_ssh_plugin_materialize_add` / `desktop_local_plugin_add`
  / `desktop_local_plugin_remove` now require a main-process confirmation
  dialog: a remote instance's client bundle shares the chamber page and must
  not silently drive local-source exfiltration, arbitrary registry-package
  installation (persistent execution surface) or destructive removal. Cancel
  resolves `{ok:true, cancelled:true}`; fail-closed without a window;
  single-flight guard against dialog stacking; the three UI call sites now
  handle `cancelled` (a dismissal is never reported as success).
- **Local plugin manifest path redaction (design 09 §4 v1 security
  mitigation)** — `desktop_local_plugin_list` no longer echoes local absolute
  paths: file:/link:/relative/absolute/`~/` dependency values are masked as
  `file:<hidden>` (materialize classification and name matching preserved;
  client-side diff unchanged).
- **Control-plane lifecycle race guards (2026 audit H2)** — health probes
  carry a generation AbortSignal: stop()/start() abort an in-flight probe and
  wait for its verdict; failure verdicts landing in `stopped`/`error` or while
  a start is in flight are inert (no connection resurrection, no double
  spawn); a spawn failure landing after stop() (epoch changed) no longer flips
  `stopped` back to `error`.
- **Uniform failed-spawn cleanup (2026 audit H3)** — every spawnAttempt failure
  path (including a pid-record write failure) converges on `killFailedSpawn`:
  process-group SIGKILL → confirmed exit → record removal (design 02 §3.3), so
  an untracked detached process can never leak.
- **Catalog persistence no longer blocks the state machine (2026 audit M13)** —
  the status/dshPort/error runtime projections persist best-effort: a disk
  failure logs loud, the machine still advances, the next transition
  self-heals; user-editable fields (label/accentColor) keep strict
  write-through.
- **Proxy compression consistency (2026 audit M3b)** — `accept-encoding` is
  stripped upstream (identity always), and `content-encoding` rides the
  response whitelist so any compression stays correctly labeled for the
  browser.
- **Boot budget cancellation + serialized chain (2026 audit H1)** — the whole
  boot task (host-graph channel and `AppWebEntry.run()` phases included) is
  bounded by a timeout budget: expiry cancels the boot (disposes the
  constructed entry, rejects queued opens), and both the caller and the
  admission chain settle within budget. Underlying async work from an expired
  entry may resume late, so routing facts are immutable on that entry's own
  Cordis root context and the connection gets an explicit basePath — no mutable
  page-global routing knob is shared. Dispose acts as cancellation, blocks a
  late mount, and repeats the root sweep; the timer is cleared when the task
  wins, so a successful boot is never cancelled by a stale timer.
- **Serialized dispose (2026 audit M1)** — `AppWebEntry.dispose()` is an async
  teardown: a same-id re-boot awaits the old teardown (pendingDisposes)
  before constructing a fresh ctx; duplicate disposal of the same entry joins
  the same promise and cannot replace the real teardown with an already-settled
  promise. The shell reserves a producer-generation floor when async boot
  starts or is cancelled, and runtime/snapshot producers carry the explicit
  boot generation, so an old ctx's late registration/report/clear cannot
  displace or clear the new shell's shared state.
- **Exec-child exit wait (2026 audit M2)** — exec children (systemd/remote
  command ssh) get the same SIGTERM → SIGKILL escalation as tunnel children
  at quit, and `disposeAsync` waits for all of them — a SIGTERM-ignoring ssh
  exec can no longer be orphaned.
- **Prewarm queue unstick (2026 audit M8)** — removing an instance that is
  mid-prewarm now clears the inflight marker and advances the queue
  immediately (previously the dropped settle left the marker forever and the
  whole prewarm queue wedged).
- **Port-allocation failure recovery (2026 audit M10)** — a transient local
  port-allocation failure enters the slow periodic re-probe (same as the
  max-retry path) instead of parking the instance in error forever.
- **Missing-plugin visibility (2026 audit M6)** — when the host boot-graph
  channel fails (graph-unreachable / not-injected) the boot still succeeds
  but the settled state carries `pluginDegraded` and the instance view shows
  a warning banner — never the same presentation as a fully successful boot.
- **Search visible-set semantics (2026 audit M7)** — `mergeSearchResults`
  takes an explicit `projectionReady` (`aggregateReady`): once the projection
  is ready the visible set is authoritative — an empty set filters ALL remote
  hits (archived/subagent/blank sessions never resurface in clickable
  results); only a not-ready projection keeps the no-filter degrade.
- **Compensating host-save atomicity (2026 audit M9, 2026 merge-review
  correction)** — new and existing hosts now commit and re-read the
  authoritative registry first, and write the password only after metadata
  demonstrably landed. A refused/thrown registry save leaves the password
  untouched; a password failure restores the complete pre-submit registry
  snapshot; the rollback result is verified too, and a refused/thrown
  rollback keeps the form in edit mode from the
  authoritative registry. Main-process registry saves also validate the
  whole proposed set: one invalid/kind-mismatched/duplicate row rejects all
  of it, so an invalid edit cannot silently delete an existing host; legacy
  file loading remains lenient-with-warning.
- **Architecture merge-safety review fixes (2026-08-28)** — the reaper now
  requires the pid record's exact managed CLI absolute path, exact
  `--profile web`/`--port` tokens, port ownership, and a dead owner
  (basename/any-`bin.ts` identities fail closed, and mismatch logs never echo
  an unrelated process argv); local start→stop→start
  releases the old single-flight generation and late failures cannot clear
  the new one; host-log write/compaction failures start a fresh generation
  instead of resurrecting a removed backing file; `stopped` is logged once;
  fork parent-accounted hiding is a bounded 3s first-observation grace so a
  partial attach failure eventually appears ungrouped; form path/length gates
  match desktop authority; CI/release action pins have an offline consistency
  guard and the invalid setup-node SHA was corrected. The subsequent thorough
  pass also made local spawn port/TCP probes and unary body reads cancellable;
  restricted transports to loopback HTTP; incrementally bounded SSH
  unterminated lines, captured stdout, and stderr detail; disabled package
  lifecycle scripts during local packing and put local pack/install process
  groups or trees under will-quit ownership; isolated renderer session-open,
  aggregate retry/source removal plus remove→same-id source-generation ABA,
  recovery timers, and quit generations; and
  made deep-link queues/protocol registration, Windows local paths, external
  open failures, and settings side-effect rollback fail loudly without
  projecting host paths to the renderer. Release concurrency now maps tag
  `vX` and manual version `X` to the same mutation group while allowing
  unrelated versions to proceed independently.
- **Source-scoped keys (2026 audit L2)** — the double-click pending and the
  blank-ghost grace are keyed by `(serverId, sessionId)`: cloned instances
  carrying the same UUID can no longer cross-trigger rename or share ghost
  slots across sources (cross-source double-click rename still works — both
  clicks key to the row's owning source via `data-chamber-section`).
- **IPC mirror drift guard (2026 audit L3, final-review hardening)** —
  `ipc-surface-mirror.test.ts` now also compares FIELD SETS (covering the
  manifest / chamber / gitWorktree / notifications helper types), and three
  real drifts were fixed (preload's two manifests missing `chamber`, the
  renderer `ChamberInjectionState` missing `gitWorktree`, the settings
  `ChamberSettings` missing `notifications`).
- **Remote plugin-apply confirmation (2026 final review)** —
  `desktop_ssh_plugin_apply` registry add/remove now requires a main-process
  confirmation dialog (a remote persistent execution surface, same gate as
  local installs); `SshPluginApplyIpcResult` gained `{ok:true, cancelled:true}`
  (all three mirrors synced), and both sync/add view call sites treat a
  dismissal as a skip, never a success.
- **Quit guards (2026 final review)** — `trustedIpc` refuses every IPC while
  quit is in progress (`app_quitting`); transport-manager `dispose()` sets an
  internal gate so `exec()`/`connect()` refuse new work after teardown (no
  theoretical orphan spawn into shutdown).
- **Double-side materialize classification parity (2026 final review)** — the
  client `isPathSpec` file:/link: prefix checks are now case-insensitive,
  aligned with the main process `isMaterializeSpec` (uppercase `FILE:`/`LINK:`
  remote values no longer classify differently on the two sides).
- **Cleanup-review fixes (2026)** — `settings-set` validation failures now
  return the uniform `{ok:false,error}` shape; tunnel stdout goes through the
  provider's redaction before entering the ring buffer; `writeSettingsFile`
  gained fsync + an explicit 0600 chmod (matching the atomic-write
  discipline); `bundle-dsh` derives its default dsh version from the COMMITTED
  runtime lockfile (the hardcoded twin of release.yml can no longer drift);
  the management API body reads got a 10s per-chunk idle timeout; the pid
  record and seed overlay atomic writes gained fsync; the shell's
  `pluginDegraded` declaration moved above the closure that references it
  (TDZ fragility gone); the sidebar drag commits now read the live store /
  live roster; connections save/remove became read-modify-write against the
  authoritative registry (render-closure snapshot race gone); the git
  unregistered-worktree remove surfaces a refresh failure explicitly instead
  of swallowing it; the mirror test's comment stripping is anchored at line
  start (`//` inside string literals survives). Real-machine smoke still
  needs a real environment.
- **Independent-review fixes (2026)** — desktop: the askpass helper is now
  REUSED while the password is unchanged (the old delete-and-recreate raced a
  concurrent tunnel+exec into fake auth failures), and clearing the password /
  removing an instance removes the baked helpers; the manual
  `desktop_ssh_seed_host_graph` path gained a main-process confirmation (the
  auto path is unaffected) with a `{ok,cancelled}` result variant synced
  across the three mirrors; `connect`/`instances_set` converge unknown/invalid
  input to the null/current shapes instead of throwing IPC rejections;
  `TransportRunCommand` narrowed to the actually dispatchable set. Validation:
  release.yml gained a `validation` job wired into both packaging jobs (a tag
  release can no longer bypass the test gates); ci.yml now runs the desktop
  build sub-steps and checks the third-party notices stay current; the shell
  serialization test lost its false-negative (B's knob zeroed + a macrotask
  yield); the spawn-cleanup test now asserts at the process-table level (the
  pid-log marker raced the cleanup SIGKILL; switched to `ps`); golden
  baselines added for Update/SettingsSurface; host-package builds verify the
  output exists; boot-rows gained an extras-dedupe boundary test;
  `instance-mutation-values` moved back under test:sidebar. Docs: 05 §7.6
  whitelist aligned with 13 §7.2, 02 §3.4 notes the dev-path identity, 09 §4
  marks the baseline as historical, desktop README exit semantics and field
  lists corrected, spawn-dsh comment fixed.
- **Fresh-review fixes (2026)** — control plane: spawn now listens for the
  async `error` event (an ENOENT/Electron-fuse spawn failure no longer crashes
  the whole process with an uncaughtException); the proxy body-budget
  reservation is held until the upstream request completes (releasing it
  right after readBody let 64×300MiB concurrent bodies exhaust process
  memory while the counter said zero); `dshPort` is cleared before entering
  `starting`; `noteHealthFailure` treats a signal-killed child as dead. Types:
  settings-connections now RE-EXPORTS the whole IPC face from the renderer's
  global.d.ts (the triple hand-mirror drift source is gone); the
  settings-bridge chamber-bridge mirror matches the real
  ChamberServerAggregate (phantom `hint` removed, workspaces/aggregate*/
  runtime added); the connections-section mirror declares the real
  `pluginDiagnostics` consumption; the layout view-prefs mirror gained four
  missing optional fields; preload normalizes absent info fields to null; the
  enter-row adopter validates the wire value (fallback to the default); the
  mirror test now asserts the re-export model (9/9).
- **Round-3 review fixes (2026)** — control plane: liveness now checks
  `signalCode` (signal-killed children no longer report alive); the
  restart-exhausted landing stops the residual child and clears
  `child/dshPort` (matching the "stops automatically" contract); `setState`
  deletes `error` instead of writing `undefined` (memory/disk parity); the
  final `→ stopped` transition line is written once through `setState`; the reaper command
  identity also matches the source-tsx dev path; host-logs writes became
  synchronous appends with an in-memory ring compaction (eliminating the
  async-stream buffer/open race that duplicated and interleaved content, plus
  a blank-line separator bug) and an out-of-range offset now returns empty; the proxy drains GET/HEAD bodies so
  keep-alive reuse never misparses frames. Desktop/client: save-host no
  longer lets a rollback throw masquerade as the password error; the
  connection client's stop() aborts the pending backoff sleep; the App
  reclamation effect reaps the parallel per-instance refs. Validation: tag
  pushes (v*) trigger the full CI validation chain and host-package esbuild
  builds joined the push path; a cross-instance serialization shell test and
  a 25-method golden baseline for the mirror test were added.
- **Round-2 review hardening (2026)** — the IPC mirror test now compares
  TYPE-SENSITIVE `name:type` signatures (covering PluginApplyResult /
  ChamberNotificationSettings / ChamberSettings) and fixed parser fragility
  (\b-anchored type lookup); the settings-connections `Window.dshChamber`
  imports the authoritative `DshChamberBridge` instead of a self-described
  mirror missing four fields; the transport M2 test now really proves
  `disposeAsync` does not settle before the SIGKILL escalation, and a new M10
  guard case covers "disconnect during allocation arms no slow re-probe"; the
  shell late-settle test timing margins were widened (80ms budget / 250ms
  delay).
- **Session-runtime export cleanup (2026 audit M12)** — the control-plane index
  re-exports only the production unary surface (call / RpcBusinessError /
  RpcTransportError); respond / openEventStream are no longer public.
- **Audit review registry (2026 audit S19)** — the following audit findings
  were re-verified as ALREADY FIXED, no change needed: H7 (Origin:null is
  rejected by corsFor with 403), M3a (proxy idle timeout re-arms per chunk,
  45s), M5 (pnpm pack / local plugin CLI are async runChild), M11
  (uncaughtException fails closed with app.exit(1)), L1 (layout WeakRef
  fan-out), L4 (all CI actions pinned to commit SHAs).
- **Packaging integrity** — `notifications.ts` added to the electron-builder
  `build.files` (the packaged app would otherwise fail to start); the preload
  build now emits into a temp dir and moves only `preload.cjs` (three dead
  files no longer ship in the asar); `build.files` excludes `dist/.vite/**`.
- **Dead dependency cleanup** — removed `@simplewebauthn/server` from the
  control plane (vestige of the removed v1 auth surface); lockfile and
  third-party notices synced.

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
