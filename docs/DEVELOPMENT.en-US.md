# dsh-chamber Development

> For developers: architecture, environment setup, running, building/packaging, CI/releases, repository layout.
> User docs: [README.md](../README.md); contribution: [CONTRIBUTING.md](../CONTRIBUTING.md); repo rules: [AGENTS.md](../AGENTS.md); design authority: [docs/design/01-overview.md](design/01-overview.md).

> 中文版: [docs/DEVELOPMENT.md](DEVELOPMENT.md)

> **Version scope (2026-11 user ruling)**: the only shipped flavor is the macOS Swift native shell; the Electron
> flavor is frozen and archived (files kept, revivable; Windows/Linux desktop legs frozen and not published).
> Default development, gates and releases cover macOS Swift plus shared contracts only; the "Electron window /
> desktop main process" boxes in the diagram below are archival references — the shipped shell entry is `macos/`
> plus the sidecar (`packages/desktop/sidecar-entry.ts`). Scope and revival checklist:
> [progress/electron-frozen.md](progress/electron-frozen.md).

## 1. Architecture overview

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron window (single frame, loadURL the control-plane origin)       │
│ └─ dsh official frontend (source reuse)                                │
│     ├─ self-built sidebar plugin: multi-source session navigation      │
│     │   + chamberBridge                                                │
│     ├─ Git worktree client plugin: repo-internal checkout rows + sagas │
│     ├─ bridge host (entry-level React): first screen = local pure dsh  │
│     │   shell                                                          │
│     └─ N-ctx: one dsh shell per instance via /api/i/<id>/* same-origin │
├───────────────────────────────────────────────────────────────────────┤
│ Control plane (127.0.0.1:17500)                                        │
│  ├─ Management REST: /health · /api/connections · /api/host/logs       │
│  ├─ Per-instance proxy: /api/i/local/* → local dsh (web profile)       │
│  │       /api/i/dsh-<id>/*, /api/i/gateway-<id>/* → registered transport│
│  │       (ordinary desktop v1 is anonymous and loopback-only)          │
│  ├─ Local host hosting + two-host-package seed / one overlay           │
│  └─ Static frontend serving (dist + __DSH_BOOT__ manifest)             │
├───────────────────────────────────────────────────────────────────────┤
│ Desktop main process (desktop)                                         │
│  ├─ transport-manager: target dsh|gateway × transport ssh|http         │
│  │    SSH tunnel/systemd or main-process HTTP(S), generation-isolated  │
│  ├─ Ready-time remote host-package seed (never SSH-executes Git)       │
│  ├─ Instance registry: <userData>/ssh-instances.json                   │
│  └─ IPC (preload allowlist): dsh-chamber:info · desktop_ssh_*          │
└───────────────────────────────────────────────────────────────────────┘
```

In one sentence: the control plane owns connection management, per-instance same-origin reverse proxying and static frontend serving; the renderer is the source-reused, self-built dsh official frontend (single window, single frame, N-ctx shells); the desktop composes `dsh|gateway` targets with `ssh|http` transports, while the explicitly started Gateway reuses the same local-host core behind an authenticated-by-default public boundary.

Git worktree support pairs a chamber-bundled client plugin with an in-instance host plugin (P5b: a worktree is a checkout inside the source repository under `.agents/worktrees`, and the official forge bundle shares that same pool with this plugin). The control plane and desktop only distribute the host package and mount loader rows; they neither interpret Git facts nor execute Git over SSH.

Design authority: `docs/design/` (01 entry point, 05 v1 surface/architecture contract); package responsibilities and constraints: `AGENTS.md` "Runtime Boundaries"—this file navigates only.

Package responsibilities, boundaries and constraints have one home: root [`AGENTS.md`](../AGENTS.md) "Runtime Boundaries"; each package contract lives in `packages/*/README.md`. This file does not copy the package table; it keeps only the architecture diagram above.

## 2. Environment setup

### 2.1 Requirements

- Node.js 24+ (LTS recommended; TypeScript sources run natively via Node type stripping, see `.nvmrc`)
- Swift toolchain (only `verify:stream-state-swift-parity` needs it; the gate fails without it — skip explicitly with `DSH_CHAMBER_SWIFT_PARITY_SKIP=1`)
- pnpm≥11 (package manager; lockfile `pnpm-lock.yaml`)
- git
- macOS (needed for `dist:desktop:mac` dmg/zip packaging)
- A dsh host install is optional; the integration smoke test auto-SKIPs without it

### 2.2 Clone and install

```bash
git clone <REPO-URL> --recurse-submodules   # materialize the vendor/harness-checkout submodule in one step
cd dsh-chamber
```

If you cloned without `--recurse-submodules`, materialize with `git submodule update --init` (the submodule is a 240-package monorepo—a full fetch is slow; `--depth 1` is safe because the gitlink pins an exact commit).

`vendor/harness-packages` is a gitignored symlink directory: one symlink per dsh package, pointing at the fixed-commit git submodule (`vendor/harness-checkout`; gitlink=upstream commit, single source of truth with no fallbacks—no env vars, no sibling checkout, no codeload download). It is never committed and must exist before `pnpm install` (the workspace resolves unmodified dsh packages through it). `scripts/dev/ensure-harness-vendor.mjs` bootstraps it: hard-fails when submodule HEAD != `harness.commit`, rebuilds links idempotently (no-op when unchanged), asserts the link set matches the lockfile's vendor importer records; `--check` validates without writing. On a fresh clone, run it before `pnpm install`:

```bash
git submodule update --init   # materialize the submodule (CI: checkout submodules: true)
node scripts/dev/ensure-harness-vendor.mjs
pnpm install
```

Upgrading the harness pin goes only through `node scripts/upstream/update-vendor.mjs <tag>` (atomic: fetch+verify tag→switch submodule→update `harness.commit`→rebuild links→regenerate lockfile→frozen verify); never bump the gitlink/`harness.commit` by hand. `pnpm-workspace.yaml` sets `verifyDepsBeforeRun: false`: `pnpm run` no longer auto-installs (guarding the lockfile from non-frozen rewrites); run `pnpm install` after dependency changes; CI also asserts `git diff --exit-code -- pnpm-lock.yaml` after every frozen install.

The root `.npmrc` is a gitignored local config, so local development may opt into a binary mirror. Formal builds commit no third-party `electronDownload.mirror` and always use Electron's official source, preventing one mirror from replacing both a binary and its checksum before formal signing.

### 2.3 Bundle the dsh runtime

The desktop bundles official `@deepseek-ai/dsh` into `packages/desktop/vendor/dsh` (the control plane's default dsh workspace, preferred over the optional `ref-dsh` symlink):

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # exact pin by default; overrides must also be exact semver
```

`bundle:dsh` also runs in `build:desktop` (the Electron `dist:desktop:mac` was removed with the freeze)—jump straight to running or packaging.

## 3. Running

> **(Electron frozen, 2026-11)** `pnpm run dev:desktop` was removed from the default script surface; the live
> development path is `pnpm run dev:control-plane` plus the macOS Swift build chain (`build:sidecar` →
> `build:swift-app`). The Electron dev command below is kept as a revival reference.

```bash
pnpm run dev:control-plane   # control plane only — http://127.0.0.1:17500 (management REST + static frontend)
# ARCHIVED (Electron frozen): pnpm run dev:desktop   # full window: control plane + dsh frontend + desktop shell
```

## 4. Build & package

> **(Electron frozen, 2026-11)** The `dist:desktop:*` commands (dmg/zip/NSIS) were removed from the default
> script surface and no longer produce anything; `build:desktop` is still live (the Swift sidecar reuses its
> control-plane / renderer / host-package artifacts, and it no longer includes the preload step).

```bash
pnpm run build:host-packages # build the four host packages: host-graph, host-git-worktree, host-archive-cleanup, host-open-in
pnpm run build:renderer      # build the dsh-frontend bundle (vite over the dsh workspace source)
pnpm run build:desktop       # host packages → renderer → control-plane/copy → bundle:dsh (Electron preload removed with the freeze)
# ARCHIVED (Electron frozen):
# pnpm run dist:desktop:mac  # package the macOS app (dmg + zip)
# pnpm run dist:desktop:win  # package the Windows app (nsis only; must run on Windows)
```

Artifacts land in `packages/desktop/release/` (electron-builder `directories.output`). A formal macOS release needs all five Apple/Developer ID credentials (a missing value fails closed before any GitHub Release mutation) and must pass Developer ID signing, notarization, stapler and spctl checks before its draft is public. Even with formal secrets, `workflow_dispatch dry_run` clears all signing/notarization variables and `GH_TOKEN`, uses `--publish=never`, writes no Release or asset, and produces an ad-hoc-signed validation package via the afterPack hook. The first Windows release remains unsigned (the SmartScreen warning is the explicit Design 11 §7 tradeoff).

`build:desktop` copies the four built host packages into `packages/desktop/dist/host-*-package/` (`host-graph-package/`, `host-git-worktree-package/`, `host-archive-cleanup-package/`, `host-open-in-package/`); the packaged local control-plane seed and the desktop's ready-time remote seed consume those artifacts (open-in is `localOnly`: local seed only, never the remote/gateway seed).

> Windows install slowness/hangs on "Installing" (Windows Defender per-file scanning) — see the README FAQ.

### Windows support matrix (design 23; **ARCHIVED: Windows leg frozen, not published, unscheduled**)

> The table below is the pre-freeze baseline kept for revival; it is not scheduled and nothing is published
> (see [progress/electron-frozen.md](progress/electron-frozen.md)).

|Area|Status|
|-|-|
|Target shape|Windows 11 x64, NSIS packaging (`dist:desktop:win`, must run on Windows)|
|CI|`test-windows` (windows-2022) contract leg defined in ci.yml; packaging in release.yml `build-windows`|
|Lifecycle (M1)|win-probes (CIM identity/netstat port/taskkill tree kill) + platform-adaptive reaper/spawn-dsh: code ready, POSIX tests green, win32-only integration tests in place|
|Runtime management (M2a/M2b)|Read-only by default; validation via `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1`; M2b UI flip is a discipline gate|
|Desktop capabilities (M3)|AUMID/tray-candidate convergence/loud preload failure wired; real-machine matrix pending|
|Decision unlocks (M4)|Login autostart, deep-link registration, open-in local paths, SSH password gate guidance unlocked (code); NSIS uninstall Run-key cleanup wired|
|Known limits|Unsigned (SmartScreen); SSH passwords disabled (use keys/Pageant); runtime mutations read-only; 0700/0600 via icacls/ACLs|
|Authority records|`docs/design/23-windows-support.md`; open real-machine gates and progress live in `docs/progress/STATUS.md`|

## 5. CI & releases

> **(Electron frozen, 2026-11)** Current CI = `ci.yml` jobs `test` / `test-macos` / `test-macos-pack`
> (Windows jobs removed, Electron packaging rehearsal removed); current release = `release.yml`
> `build-swift` + `build-gateway` (the three Electron legs stay skipped by their job-level `if: ${{ false }}`
> plus ARCHIVED header notes). Electron/Windows release paragraphs below describe the **pre-freeze shape**;
> revival: [progress/electron-frozen.md](progress/electron-frozen.md) §6.

- `.github/workflows/ci.yml`: branch pushes to `main` and PRs run the validation chain (no release artifacts). A **code change** runs frozen install → root/gateway/runtime/host-package/client-plugin type checks → control-plane/runtime/desktop/gateway/renderer/client/host tests (including `test:git` and `test:host-git`) → workflow action-SHA gate (`release-preflight --actions-only`) → smoke [SKIPs without a bundled runtime] → renderer/host/desktop sub-builds → gateway pack-and-install smoke [`pack` → temporary prefix install → `gateway --help`]); a **prose-only change** runs only the file-only gates (classification below) and skips install/type checks/tests/builds. The macOS legs `test-macos` (Swift build/test) and `test-macos-pack` (darwin lock + packaging-script suites i.e. `test:macos`, the compiled sidecar / native GUI assembly / Electron artifact gates) run on macos-latest; **the Windows legs were removed with the Electron freeze**. Desktop packaging and the real smoke run live in `release.yml` (tag/manual trigger).
- `.github/workflows/release.yml`: produces distributable releases—push a `v*` tag (or run manually with a version without `v` and an optional dry-run). Publishable versions are canonical stable `X.Y.Z` or beta `X.Y.Z-beta.N` only; `alpha`, `rc` and other prereleases fail closed. Stable uses the default desktop build config and publishes only `latest.yml`/`latest-mac.yml`; beta uses `packages/desktop/electron-builder.beta.yml` and publishes only `beta.yml`/`beta-mac.yml`, with mutually exclusive channel assets. A formal run creates a draft, builds macOS arm64 (v1 is Apple Silicon only) and Windows x64, and goes public only after the fail-closed macOS checks above; dry-run writes no Release. `release-preflight --versions-only` checks the root, every non-fork chamber package, and all three fork baselines; the matching `## [<version>]` section of `CHANGELOG.md` is the mandatory release body. The `validation` job runs the release CI proof after the local chain and the builds, immediately before the third-party notices check (deliberately late: the proof polls the ci.yml run for this SHA, so local validation overlaps that wait; `scripts/release/verify-release-ci-proof.mjs`: the commit must carry a completed, successful `ci.yml` push run on `main` with the `test`, `test-macos` and `test-macos-pack` jobs green (the Windows/Linux desktop legs are ARCHIVED with the Electron freeze) (each contract leg plus the parallel packaging job its assembly/rehearsal steps were split into — the proof still pins those steps by name); an in-flight run is waited for with a bound; a failed run or a commit that never went through `main` fails closed); the local chain (gateway/runtime type checks and tests plus critical control-plane/desktop/renderer/plugin/CLI/policy gates) has already completed by then; `build-gateway` publishes only a clean-prefix-smoked `.tgz` plus matching `.tgz.sha256` to GitHub Releases; npm publish/dist-tags deferred.
- Pre-release mechanical gate: `pnpm run release:preflight <version>` (`scripts/release/release-preflight.mjs`) — version uniformity (incl. fork copies and the installer dsh constant), changelog zh/en parity, i18n, every workflow action SHA resolves upstream, conflict markers, clean git status, frozen install, test:release-workflow; the release checklist §2/§7 mandates it before commit and before push.
- Release flow (optimization): local preflight + full battery on the exact release commit→commit+tag→workflow_dispatch dry-run first (new/modified workflows, script paths and action SHAs must pass one dry-run)→real tag push; full steps in the release checklist.
- Push-path classification : the linux chain in `ci.yml` differs per event. On a branch push/PR, a prose-only change (`docs/**` plus the root prose allowlist, classified by `scripts/gates/classify-ci-changes.mjs`) runs only the file-only gates (every step of the `ci.test.pre`/`post` generated blocks — single source `scripts/gates/gate-surfaces.json`: action SHAs, upstream touchpoints, workflow policy, tooling unit tests, i18n (the `pre` block runs before install, the `post` block after). `verify:md-links`, `verify:test-wiring`, `verify:styles` and `verify:no-dead-exports` remain **local-only** gates that run in `check:static`) and skips install/type checks/unit suites/builds/the gateway pack smoke and the frozen Windows leg; a code change runs everything. **Tag pushes do not trigger `ci.yml` at all** (CI-trigger revision)—a release PROVES instead of re-running: `release.yml`'s `validation` runs `verify-release-ci-proof.mjs`, which requires a successful full `ci.yml` run on `main` (the linux `test` chain plus the `test-windows`/`test-macos` legs and their `-pack` packaging jobs), waiting a bounded time for an in-flight run and failing closed otherwise. The old shape (linux chain stepping aside, Windows leg re-running on the tag) repeated one Windows run on the identical SHA and left a hole: tagging a commit that never went through `main` skipped the entire linux chain; the proof closes that hole. release.yml's gate alignment with ci.yml is still asserted by `release-workflow-policy.test.mjs` derived from ci.yml (adding a gate to ci.yml without mirroring it into release.yml turns CI red). The classifier fails safe: anything it cannot prove to be prose runs the full chain, and the prose allowlist is frozen by the policy test, so widening it takes a deliberate edit.
- `ci.yml` serializes pushes per ref with `concurrency: ci-${{ github.ref }}` and cancels only superseded pull-request runs: branch pushes queue, because a prose-only push that cancelled the previous run would leave the code commit it followed with no validation at all (the classifier spares prose the heavy chain, but there is no "zero validation" tier). `release.yml` keeps `release-publish` + `cancel-in-progress: false` so a run that may already have created a draft is never cancelled.
- Both workflows bootstrap the vendor source tree at the `harness.commit` pin before installing.

## 6. Repository layout

```
packages/
  control-plane/            Control plane: host hosting, management REST,
                            per-instance proxy, frontend serving
  renderer/                 Self-built dsh frontend (source reuse + bridge host + N-ctx)
  desktop/                  Electron shell: single frame, orthogonal target/transport providers, instance registry, IPC
  cli/                      CLI thin shell
  gateway/                  Standalone authenticated server shape + one local dsh + runtime management / credential panel / seed registry
  dsh-runtime/              Pure-Node dsh runtime-management core shared by desktop and Gateway
  dsh-client-connection/    Modified dsh source #1 (base-path patch)
  dsh-client-web/           Modified dsh source #2 (boot.tsx N-ctx seam)
  dsh-chamber-client-core/  Shared chamber client kernel (source-only; multi-source projection / page-level load kernel / unary / multiplex channel / settings seat)
  dsh-chamber-wire/         Neutral host↔client wire contracts (session-state / json-guards / mux-frame; zero runtime deps)
  dsh-stream-state/         Pure, clockless session/stream lifecycle state (design 14 §D4)
  dsh-api-gateway/          Second-implementation fork of the official api-gateway client half (G43; replay as a fork)
  dsh-chamber-client-ui-sidebar/     Self-built sidebar plugin: multi-source session navigation + chamberBridge
  dsh-chamber-client-ui-layout/      Self-built ui-layout shell fork (persists sidebarWidth)
  dsh-chamber-client-ui-settings-connections/
                            Self-built connections settings plugin
  dsh-chamber-client-ui-settings-bridge/
                            Self-built settings shell plugin
  dsh-chamber-client-ui-settings-plugin-manager/
                            Settings plugin-manager section (design 05; owns no sidebar panel)
  dsh-chamber-seed-client-graph/    Self-built host-side package (read-only exposure of the client-plugin boot graph)
  dsh-chamber-client-ui-git/
                            Git worktree client (sidebar + coordinator + sagas)
  dsh-chamber-seed-git-worktree/
                            In-instance Git worktree host Remote (guards + constrained Git)
  dsh-chamber-seed-archive-cleanup/
                            In-instance archive-cleanup host Remote (design 24)
  dsh-chamber-client-ui-open-in/
                            Open-in client plugin (session-header local app / VS Code open)
  dsh-chamber-client-ui-browser/
                            Remote-browser client plugin (embedded right-sidebar iframe browser: a faithful fork of the upstream ui-sidebar-browser; not seeded)
  dsh-chamber-seed-open-in/
                            In-instance open-in host Remote (local app catalog + icons + launches; local shape only)
docs/
  design/                   Design documents (01 is the entry point; 05 is the surface/architecture contract (v1))
  progress/                 STATUS.md — the only progress record; TODO.md — unscheduled plans (A upstream / B platform / C features / D engineering);
                            deviations.md — dual-flavor deviations
  checklists/               Operational checklists (release / dsh upgrade / packaging integrity / GUI acceptance / remote browser / session-authority calibration / upstream touchpoints)
  *.en-US.md                English mirrors of the root docs
scripts/
  install-gateway.sh        One-shot Gateway installer (user/ops; entry docs/deploy/deploy-gateway.md)
  dev/                      Development tooling (bootstrap, typecheck shims, test loader stubs, test-support)
  gates/                    Per-push repository gates (run-checks entry + verify-* + CI classification + workflow gates)
  release/                  Release chain (preflight/semver/artifacts, workflow policy, packaging-manifest lockstep)
  upstream/                 Upstream pin and touchpoints (update-vendor, pin preflight, registry.json single source + generated views,
                            the full touchpoint gate, symbol-anchor + legacy-anchor budget gates, C8 artifact gate)
  perf/                     Performance measurement toolbox (boot/switch/eval/measure-ui/disk-walk + data/)
  gui-acceptance/           GUI acceptance toolbox (probe/walkthrough/mobile-walkthrough/checks)
                            (classification rules and wiring discipline: scripts/README.md)
vendor/
  harness-packages/         @deepseek-ai/* symlink tree into the dsh source
                            inside the submodule (bootstrapped by preinstall,
                            gitlink pinned at harness.commit)
  harness-checkout/         dsh source git submodule (fixed commit, gitlink is the pin)
```

## 7. Scripts

The script list has one home: root [`package.json`](../package.json) `scripts` (not copied here). For gate selection by change surface see [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`docs/AGENTS.md`](AGENTS.md) §5; build/release chains are in §4–§5.

## 8. Documentation map

|Document|Purpose|
|-|-|
|[README.md](../README.md)|User docs (features/install/deploy/FAQ)|
|This file `docs/DEVELOPMENT.md`|Development: architecture/build/package/CI/release|
|[CONTRIBUTING.md](../CONTRIBUTING.md)|Contribution process (testing/commits/PR contract)|
|[AGENTS.md](../AGENTS.md)|Always-on repository rules (purpose/hard facts/execution flows/package map)|
|[docs/AGENTS.md](AGENTS.md)|Documentation standard (layering/writing/word budgets/doc gates/review checklist)|
|[.agents/skills/](../.agents/skills/)|Reusable workflows: chamber-doc / chamber-pre-push / chamber-code-review|
|[CHANGELOG.md](../CHANGELOG.md)|Version history|
|[docs/design/01-overview.md](design/01-overview.md)|Design entry point & consolidation principles|
|[docs/progress/STATUS.md](progress/STATUS.md)|Progress overview (the only progress record)|
|[docs/checklists/release-checklist.md](checklists/release-checklist.md)|Pre-release checklist (version/changelog/tests/build/tag/CI)|
|[docs/checklists/dsh-upgrade-checklist.md](checklists/dsh-upgrade-checklist.md)|Pre-dsh-upgrade checklist (pin consistency/fork rebase/lockfile/regression)|
|[docs/checklists/packaging-closure-checklist.md](checklists/packaging-closure-checklist.md)|Packaging integrity checklist (module closure vs build.files, build-chain artifacts, packaged-app smoke)|
|[docs/checklists/gui-acceptance-checklist.md](checklists/gui-acceptance-checklist.md)|GUI acceptance procedure (what to run / look for / record)|
|[docs/checklists/remote-browser-acceptance.md](checklists/remote-browser-acceptance.md)|Right-sidebar browser v2 acceptance (local CDP + dual-flavor real machine)|
|[docs/checklists/session-authority-calibration.md](checklists/session-authority-calibration.md)|Session-fact single-authority real-machine calibration (design 14 §D4)|
|[docs/checklists/upstream-touchpoints.md](checklists/upstream-touchpoints.md)|Upstream touchpoint registry and per-tag maintenance loop (generated views; §2/§9 hand-edit forbidden)|
