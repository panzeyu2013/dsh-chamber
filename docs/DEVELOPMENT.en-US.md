# dsh-chamber Development

> For **developers**: this file covers the architecture overview, environment
> setup, running, building/packaging, CI/releases, and repository layout.
> User docs live in [README.md](../README.md), contribution process in
> [CONTRIBUTING.md](../CONTRIBUTING.md), always-on repo rules in
> [AGENTS.md](../AGENTS.md), and the design authority in
> [docs/design/01-overview.md](design/01-overview.md).

> 中文版: [docs/DEVELOPMENT.md](DEVELOPMENT.md)

## 1. Architecture overview

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron window (single frame, loadURL the control-plane origin)       │
│ └─ dsh official frontend (source reuse)                                │
│     ├─ self-built sidebar plugin: multi-source session navigation      │
│     │   + chamberBridge                                                │
│     ├─ Git worktree client plugin: per-instance topology + safe sagas  │
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

**In one sentence**: the control plane (connection-manager core) owns connection management, per-instance same-origin reverse proxying, and static frontend serving; the renderer is the dsh official frontend, source-reused and self-built (single window, single frame, multiple instances coexisting as N-ctx shells); the desktop independently composes `dsh|gateway` targets with `ssh|http` transports, while the explicitly started Gateway reuses the same local-host core behind an authenticated-by-default public boundary.

Git worktree support pairs a chamber-bundled client plugin with an **in-instance**
host plugin. The control plane and desktop only distribute the host package and
mount loader rows; they neither interpret Git facts nor execute Git over SSH.

**Design authority** lives in `docs/design/` (01 is the entry point, 05 is the v1 surface/architecture contract); **package responsibilities and constraints** live in `AGENTS.md` "Runtime Boundaries" — this file is a one-line navigation aid only and does not repeat the details.

| Package | Responsibility (one line) |
|---|---|
| `packages/control-plane` | Connection-manager core: web-profile host hosting, local two-host-package seed/overlay, management REST, per-instance proxy, static frontend serving |
| `packages/renderer` | Self-built dsh frontend (source reuse): entry build, pure-dsh first-screen bridge host, N-ctx orchestration, boot manifest |
| `packages/desktop` | Electron shell: single frame, orthogonal target/transport providers, ready-time remote host-package seed, instance registry, IPC, runtime management, and native edge capabilities |
| `packages/cli` | CLI thin shell (serve/status/connections/host logs) |
| `packages/gateway` | Standalone authenticated server shape (Design 17): mandatory-auth public boundary, one local dsh proxy, and runtime management / credential panel / seed registry |
| `packages/dsh-runtime` | Pure-Node dsh version-tree, install, activation, probe, and two-phase rollback core shared by desktop and Gateway while each host owns separate state |
| `packages/dsh-client-connection` | In-repo copy of the official connection client + base-path patch |
| `packages/dsh-client-web` | In-repo copy of the official web shell + boot.ts N-ctx module-table sharing seam |
| `packages/dsh-chamber-client-ui-sidebar` | Self-built sidebar plugin: multi-source session navigation + chamberBridge (replaces the official ui-sidebar registration) |
| `packages/dsh-chamber-client-ui-settings-connections` | Self-built connections settings plugin (local instance card + remote host CRUD/connect/systemd/logs) |
| `packages/dsh-chamber-client-ui-settings-bridge` | Self-built settings shell plugin (shadows the official SettingsRoot registration; server dropdown + fixed connections nav entry) |
| `packages/dsh-chamber-client-ui-layout` | Self-built ui-layout shell fork (layout-store replacement persisting sidebarWidth) |
| `packages/dsh-host-client-graph` | Host-side package: read-only exposure of the instance's client-plugin boot graph over a Typert Remote |
| `packages/dsh-chamber-client-ui-git` | Chamber-bundled Git worktree client: sidebar slot, per-instance topology, create/remove sagas; never executes Git directly |
| `packages/dsh-chamber-client-ui-open-in` | Chamber-bundled open-in client plugin: session-header utilities open button (local Finder + local/remote VS Code via the main-process OpenInApp registry + `dsh-chamber://` deep link) |
| `packages/dsh-chamber-host-git-worktree` | In-instance host package: authoritative workspace/agent guards plus constrained, local-only Git worktree lifecycle |

## 2. Environment setup

### 2.1 Requirements

- Node.js 24+ (LTS recommended; sources are TypeScript run natively via Node type stripping, see `.nvmrc`)
- pnpm ≥ 11 (package manager; lockfile `pnpm-lock.yaml`)
- git
- macOS (needed for `dist:desktop:mac` dmg/zip packaging)
- A dsh host install is optional — only needed for the integration smoke test, which auto-SKIPs when absent

### 2.2 Clone and install

```bash
git clone <REPO-URL> --recurse-submodules   # materialize the vendor/harness-checkout submodule in one step
cd dsh-chamber
```

If you already cloned without `--recurse-submodules`, materialize with
`git submodule update --init` (the submodule is a 240-package monorepo and a
full fetch is slow; `--depth 1` is safe here — the gitlink pins an exact
commit, so a shallow fetch is sufficient).

`vendor/harness-packages` is a **gitignored symlink directory** — one symlink per dsh package, named after the package, pointing at the fixed-commit **git submodule** (`vendor/harness-checkout`; gitlink = upstream commit, **single source of truth with no fallbacks** — no env vars, no sibling checkout, no codeload download). It is never committed and must exist **before** `pnpm install` (the workspace resolves unmodified dsh packages through it). `scripts/dev/ensure-harness-vendor.mjs` bootstraps it: it hard-fails when submodule HEAD != `harness.commit`, rebuilds links idempotently (no-op when the link set is unchanged), and asserts the link set matches the lockfile's vendor importer records; `--check` validates without writing. On a fresh clone (after submodule materialization) run it explicitly **before** `pnpm install`:

```bash
git submodule update --init   # materialize the submodule (CI: checkout submodules: true)
node scripts/dev/ensure-harness-vendor.mjs
pnpm install
```

**Upgrading the harness pin goes only through** `node scripts/dev/update-vendor.mjs <tag>` (atomic: fetch+verify tag → switch submodule → update `harness.commit` → rebuild links → regenerate lockfile → frozen verify); never bump the gitlink / `harness.commit` by hand. `pnpm-workspace.yaml` sets `verifyDepsBeforeRun: false`: `pnpm run` no longer auto-installs (guarding the lockfile from non-frozen rewrites) — run `pnpm install` explicitly after dependency changes; CI additionally asserts `git diff --exit-code -- pnpm-lock.yaml` after every frozen install.

The root `.npmrc` is a gitignored local convenience config, so local development may opt into a binary mirror. Formal build configuration commits no third-party `electronDownload.mirror` and always uses Electron's official source, preventing one mirror from replacing both a binary and its checksum before formal signing.

### 2.3 Bundle the dsh runtime

The desktop bundles the official `@deepseek-ai/dsh` release into `packages/desktop/vendor/dsh` (the control plane's default dsh workspace, preferred over the optional `ref-dsh` source symlink):

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # exact pin by default; overrides must also be exact semver
```

`bundle:dsh` also runs automatically as part of `build:desktop` / `dist:desktop:mac` — you can jump straight to running or packaging.

## 3. Running

```bash
pnpm run dev:control-plane   # control plane only — http://127.0.0.1:17500 (management REST + static frontend)
pnpm run dev:desktop         # full window: control plane + dsh frontend + desktop shell
```

## 4. Build & package

```bash
pnpm run build:host-packages # build both host-graph and host-git-worktree packages
pnpm run build:renderer      # build the dsh-frontend bundle (vite over the dsh workspace source)
pnpm run build:desktop       # two host packages → renderer → control-plane/copy → preload → bundle:dsh
pnpm run dist:desktop:mac    # package the macOS app (dmg + zip)
pnpm run dist:desktop:win    # package the Windows app (nsis + zip; must run on Windows — dsh runtime bundling is platform-specific)
```

Artifacts land in `packages/desktop/release/` (electron-builder `directories.output`). A formal macOS release requires all five Apple/Developer ID credentials: a missing value fails closed before any GitHub Release mutation, and the built app must then pass Developer ID signing, notarization, stapler, and spctl checks before its draft can be finalized publicly. Even when formal secrets exist, `workflow_dispatch dry_run` unconditionally clears all signing/notarization variables and `GH_TOKEN`, uses `--publish=never`, performs no Release creation/update or asset upload, and produces an ad-hoc-signed validation package through the afterPack hook. The first Windows release remains unsigned (the SmartScreen warning is the explicit Design 11 §7 tradeoff).

`build:desktop` copies the two built host packages into
`packages/desktop/dist/host-graph-package/` and
`packages/desktop/dist/host-git-worktree-package/`. The packaged local
control-plane seed and the desktop's ready-time remote seed consume those same
artifacts.

> Windows install slowness/hangs on "Installing" (Windows Defender per-file scanning) — see the README FAQ.

## 5. CI & releases

- `.github/workflows/ci.yml`: runs on every push/PR — validation chain only (frozen install → root/gateway/runtime/two-host-package/client-plugin type checks → i18n → control-plane/runtime/desktop/gateway/renderer/client/host tests, including `test:git` and `test:host-git` → **workflow action-SHA gate** (`release-preflight --actions-only`, since 2026-09) → smoke [SKIPs without a bundled runtime] → renderer/host/desktop sub-builds → gateway pack-and-install smoke [`pack` → temporary prefix install → `gateway --help`]); it **does not produce release artifacts**. Desktop packaging and the real smoke run live in `release.yml` (tag/manual trigger).
- `.github/workflows/release.yml`: produces distributable releases — push a `v*` tag (or run manually with a version without `v` and an optional dry-run). Publishable versions are limited to canonical stable `X.Y.Z` or beta `X.Y.Z-beta.N`; `alpha`, `rc`, and every other prerelease fail closed. Stable uses the default desktop build configuration and publishes only `latest.yml`/`latest-mac.yml`; beta uses the independent `packages/desktop/electron-builder.beta.yml` and publishes only `beta.yml`/`beta-mac.yml`, with mutually exclusive channel assets. A formal run creates a draft, builds macOS arm64 (v1 is Apple Silicon only) and Windows x64, and makes it public only after the fail-closed macOS checks above; dry-run performs zero Release writes. `release-preflight --versions-only` dynamically checks the root, every non-fork chamber package, and both fork baselines; the matching `## [<version>]` section of `CHANGELOG.md` becomes the release body and is mandatory. The `validation` job self-validates gateway/runtime type checks and tests plus critical control-plane/desktop/renderer/plugin/CLI/policy gates; `build-gateway` publishes only a clean-prefix-smoked `.tgz` plus matching `.tgz.sha256` to GitHub Releases, with npm publish/dist-tags deferred.
- **Pre-release mechanical gate (since 2026-09)**: `pnpm run release:preflight <version>` (`scripts/dev/release-preflight.mjs`) — version uniformity (incl. fork copies and the installer dsh constant), changelog zh/en parity, i18n, **every workflow action SHA resolves upstream**, conflict markers, clean git status, frozen install, test:release-workflow; the release checklist §1.5/§7 mandates it before commit and again before push.
- **Release flow (2026-09 optimization)**: local preflight + full battery on the exact release commit → commit+tag → **workflow_dispatch dry-run first** (new/modified workflows, script paths and action SHAs must pass one dry-run) → real tag push. Full steps in the release checklist.
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
  dsh-chamber-client-ui-sidebar/     Self-built sidebar plugin: multi-source session navigation + chamberBridge
  dsh-chamber-client-ui-layout/      Self-built ui-layout shell fork (persists sidebarWidth)
  dsh-chamber-client-ui-settings-connections/
                            Self-built connections settings plugin
  dsh-chamber-client-ui-settings-bridge/
                            Self-built settings shell plugin
  dsh-host-client-graph/    Self-built host-side package (read-only exposure of the client-plugin boot graph)
  dsh-chamber-client-ui-git/
                            Git worktree client (sidebar + coordinator + sagas)
  dsh-chamber-host-git-worktree/
                            In-instance Git worktree host Remote (guards + constrained Git)
  dsh-chamber-client-ui-open-in/
                            Open-in client plugin (session-header Finder/VS Code open)
docs/
  design/                   Design documents (01 is the entry point; 05 is the surface/architecture contract (v1))
  todo/                     Unimplemented feature ideas (one file each; implemented historical design records are kept here, see todo/README.md)
  progress/                 STATUS.md — the only progress overview (incomplete/partially-complete items only)
  checklists/               Operational checklists (release / dsh upgrade / packaging integrity)
  *.en-US.md                English mirrors of the root docs
vendor/
  harness-packages/         @deepseek-ai/* symlink tree into the dsh source
                            inside the submodule (bootstrapped by preinstall,
                            gitlink pinned at harness.commit)
  harness-checkout/         dsh source git submodule (fixed commit, gitlink is the pin)
```

## 7. Scripts

| Script | Description |
|---|---|
| `pnpm run dev:control-plane` | Start the control plane (management REST + static frontend) on port 17500 |
| `pnpm run dev:desktop` | Electron shell: full window (control plane + dsh frontend + desktop shell) |
| `pnpm run build:renderer` | Build the dsh-frontend bundle |
| `pnpm run build:host-graph` | Build the host-graph package (esbuild) |
| `pnpm run build:host-git` | Build the in-instance Git worktree host package (esbuild) |
| `pnpm run build:host-packages` | Build host-graph, then host-git-worktree |
| `pnpm run build:desktop` | Two host packages + renderer + control-plane compile/two-package copy + preload + dsh bundling |
| `pnpm run typecheck:git` | Type-check the Git worktree client plugin |
| `pnpm run typecheck:host-git` | Type-check the in-instance Git worktree host package |
| `pnpm run test:git` | Run the Git worktree client-plugin tests |
| `pnpm run test:host-git` | Run the Git host core lifecycle and safety-guard tests |
| `pnpm run dist:desktop:mac` | Package the macOS app (dmg + zip) |
| `pnpm run dist:desktop:win` | Package the Windows app (nsis + zip; must run on Windows) |
| `pnpm run cli -- <args>` | In-repo CLI thin shell (serve/status/connections/host logs) |
| `pnpm run verify:i18n` | Fail when an EN ↔ ZH pair drifts (re-record with `-- --write`) |
| `pnpm run gen:notices` | Regenerate THIRD_PARTY_NOTICES.md (Chinese root + docs/ English mirror) from the installed dependency tree |

Test commands live in [CONTRIBUTING.md](../CONTRIBUTING.md) "Testing" and "Before Submitting".

## 8. Documentation map

| Document | Purpose |
|---|---|
| [README.md](../README.md) | User docs (features/install/deploy/FAQ) |
| This file `docs/DEVELOPMENT.md` | Development: architecture/build/package/CI/release |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Contribution process (testing/commits/PR contract) |
| [AGENTS.md](../AGENTS.md) | Always-on repository rules (package boundaries/constraints/validation) |
| [CHANGELOG.md](../CHANGELOG.md) | Version history |
| [docs/design/01-overview.md](design/01-overview.md) | Design entry point & consolidation principles |
| [docs/progress/STATUS.md](progress/STATUS.md) | Progress overview (the only progress record) |
| [docs/checklists/release-checklist.md](checklists/release-checklist.md) | Pre-release checklist (version/changelog/tests/build/tag/CI) |
| [docs/checklists/dsh-upgrade-checklist.md](checklists/dsh-upgrade-checklist.md) | Pre-dsh-upgrade checklist (pin consistency/fork rebase/lockfile/regression) |
| [docs/checklists/packaging-closure-checklist.md](checklists/packaging-closure-checklist.md) | Packaging integrity checklist (module closure vs build.files, build-chain artifacts, packaged-app smoke) |
