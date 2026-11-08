# dsh-chamber Development

> For developers: architecture, environment setup, running, building/packaging, CI/releases, repository layout.
> User docs: [README.md](../README.md); contribution: [CONTRIBUTING.md](../CONTRIBUTING.md); repo rules: [AGENTS.md](../AGENTS.md); docs map: [docs/INDEX.md](./INDEX.md); design authority: [docs/design/INDEX.md](./design/INDEX.md) (overview [01-overview.md](./design/01-overview.md)).

> 中文版: [docs/DEVELOPMENT.md](./DEVELOPMENT.md)

> **Version scope (2026-11 user ruling)**: the only shipped flavor is the macOS Swift native shell; the Electron
> flavor is frozen and archived (files kept, revivable; Windows/Linux desktop legs frozen and not published).
> Default development, gates and releases cover macOS Swift plus shared contracts only; the diagram below reflects the
> shipped shape (Swift window + packaged Node sidecar, Electron rows marked archival) — the shipped shell entry is `macos/`
> plus the sidecar (`packages/desktop/sidecar-entry.ts`). Scope and revival checklist:
> [progress/electron-frozen.md](./progress/electron-frozen.md).

## 1. Architecture overview

```
┌───────────────────────────────────────────────────────────────────────┐
│ Swift window (WKWebView, loadURL the control-plane origin; Electron archived)│
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
│ Packaged Node sidecar (desktop host-assembly; Electron archived)       │
│  ├─ transport-manager: target dsh|gateway × transport ssh|http         │
│  │    SSH tunnel/systemd or main-process HTTP(S), generation-isolated  │
│  ├─ Ready-time remote host-package seed (never SSH-executes Git)       │
│  ├─ Instance registry: <userData>/ssh-instances.json                   │
│  └─ IPC (preload allowlist): dsh-chamber:info · desktop_ssh_*          │
└───────────────────────────────────────────────────────────────────────┘
```

In one sentence: the control plane owns connection management, per-instance same-origin reverse proxying and static frontend serving; the renderer is the source-reused, self-built dsh official frontend (single window, single frame, N-ctx shells); the desktop composes `dsh|gateway` targets with `ssh|http` transports, while the explicitly started Gateway reuses the same local-host core behind an authenticated-by-default public boundary.

Git worktree support pairs a chamber-bundled client plugin with an in-instance host plugin (P5b: a worktree is a checkout inside the source repository under `.agents/worktrees`, and the official forge bundle shares that same pool with this plugin). The control plane and desktop only distribute the host package and mount loader rows; they neither interpret Git facts nor execute Git over SSH.

Design authority: `docs/design/` (entry [INDEX.md](./design/INDEX.md), overview 01-overview; 05 is the v1 surface/architecture contract); the global docs map is [docs/INDEX.md](./INDEX.md). Package responsibilities and constraints: `AGENTS.md` "Runtime Boundaries"—this file navigates only.

Package responsibilities, boundaries and constraints have one home: root [`AGENTS.md`](../AGENTS.md) "Runtime Boundaries"; each package contract lives in `packages/*/README.md`. This file does not copy the package table; it keeps only the architecture diagram above.

## 2. Environment setup

### 2.1 Requirements

- Node.js 24+ (LTS recommended; TypeScript sources run natively via Node type stripping, see `.nvmrc`)
- macOS + Swift/Xcode: `build:swift-app` / `test:swift` are the shipped build chain and must work (the parity gate can be skipped explicitly with `DSH_CHAMBER_SWIFT_PARITY_SKIP=1`)
- pnpm≥11 (package manager; lockfile `pnpm-lock.yaml`)
- git
- Release chain additionally needs five Apple/Developer ID credentials (fail-closed when missing; see the release checklist)
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

`.npmrc` is a gitignored local config; formal builds commit no third-party mirror and always use the official source (a local mirror is debug-only for the archived Electron surface, see [progress/electron-frozen.md](./progress/electron-frozen.md)).

### 2.3 Bundle the dsh runtime

The desktop bundles official `@deepseek-ai/dsh` into `packages/desktop/vendor/dsh` (the control plane's default dsh workspace, preferred over the optional `ref-dsh` symlink):

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # exact pin by default; overrides must also be exact semver
```

`bundle:dsh` also runs in `build:desktop`; jump straight to running or packaging.

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

Shipped Swift artifacts land in `macos/release/` (`.app` + dmg/zip + appcast; `.github/workflows/release.yml` runs `build:swift-app --out macos/release`). A formal release needs all five Apple/Developer ID credentials (missing values fail closed before any GitHub Release mutation) and must pass Developer ID signing, notarization, stapler and spctl; even with formal secrets, `workflow_dispatch dry_run` clears signing/notarization variables and `GH_TOKEN` (`--publish=never`, writes no Release or asset). The Electron `packages/desktop/release/` path is an archival reference.

`build:desktop` copies the four built host packages into `packages/desktop/dist/host-*-package/` (`host-graph-package/`, `host-git-worktree-package/`, `host-archive-cleanup-package/`, `host-open-in-package/`); the packaged local control-plane seed and the desktop's ready-time remote seed consume those artifacts (open-in is `localOnly`: local seed only, never the remote/gateway seed).

> Platform troubleshooting (install/permissions) lives in the README FAQ; the Windows desktop leg is frozen and no longer maintained.

> The Windows/Linux desktop legs are frozen with Electron (not published, not scheduled); the pre-freeze support matrix and revival baseline live in [progress/electron-frozen.md](./progress/electron-frozen.md) §6 and design 23 (ARCHIVED).

## 5. CI & releases

> **(Electron frozen, 2026-11)** Current CI = `ci.yml` jobs `test` / `test-macos` / `test-macos-pack`; current release = `release.yml` `build-swift` + `build-gateway` (the three Electron release legs carry a job-level always-false condition and stay skipped). Gate placement and job rosters have their single sources in [release-checklist.md](./checklists/release/release-checklist.md), [.github/workflows/](../.github/workflows) and `scripts/gates/gate-surfaces.json`; this file does not copy them.

- `.github/workflows/ci.yml`: branch pushes/PRs run the validation chain (a code change runs everything; prose-only runs the file-only gates, classifier `scripts/gates/classify-ci-changes.mjs`); the macOS legs `test-macos` (Swift build/test) and `test-macos-pack` (`test:macos` + compiled sidecar / native GUI assembly) run on macos-latest.
- `.github/workflows/release.yml`: a `v*` tag or manual run produces distributable releases (stable `X.Y.Z` or beta `X.Y.Z-beta.N` only); the release body is the `## [<version>]` section of `CHANGELOG.md`; `validation` runs `scripts/release/verify-release-ci-proof.mjs` to prove a successful `ci.yml` run on `main` for that commit; `build-gateway` publishes the clean-prefix-smoked `.tgz` plus matching `.sha256`.
- Pre-release mechanical gate: `pnpm run release:preflight <version>` (version uniformity, changelog zh/en parity, i18n, action SHAs, conflict markers, clean git status, frozen install, test:release-workflow); the release checklist §2/§7 mandates it before commit and before push.
- Release flow: local preflight + full battery on the exact commit → commit+tag → `workflow_dispatch` dry-run (new/modified workflows, script paths and action SHAs must pass one dry-run) → real tag push; detailed steps and the proof/classification rules live in the release checklist.
- Both workflows bootstrap the vendor tree at the `harness.commit` pin before installing; `ci.yml` serializes pushes per ref via `concurrency`, while `release.yml` never cancels a run that may already have created a draft.

## 6. Repository layout

```
packages/
  control-plane/ renderer/ desktop/ cli/ gateway/ dsh-runtime/
  dsh-client-connection/ dsh-client-web/ dsh-api-gateway/
  dsh-chamber-client-core/ dsh-chamber-wire/ dsh-stream-state/
  dsh-chamber-client-ui-*/ dsh-chamber-seed-*/
                            Each package contract (responsibilities, boundaries, modules, test entry, known limits) lives in its README;
                            the package roster is the packages/ directory and ownership is root AGENTS.md "Runtime Boundaries"
docs/
  INDEX.md                  Global docs map (the single entry for all documents)
  AGENTS.md                 Documentation standard (types / placement / writing / flow)
  design/                   INDEX.md (domain × status × owner) + 01-overview.md overview
                            + domain directories (runtime/ control-plane/ gateway/ client/ desktop/ plugins/ archive/)
                            + decisions/ (ADR: context / decision / rejected alternatives / consequences)
  checklists/               README.md stage matrix (the only stage list) + release/ upgrade/ acceptance/
  progress/                 STATUS.md only progress record; TODO.md; deviations.md; electron-frozen.md; README.md rules
  deploy/                   Gateway deployment / remote dsh instance persistence
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

The script list has one home: root [`package.json`](../package.json) `scripts` (not copied here). For gate selection by change surface see [`CONTRIBUTING.md`](../CONTRIBUTING.md) and [`docs/AGENTS.md`](./AGENTS.md) §5; build/release chains are in §4–§5.

## 8. Documentation map

|Document|Purpose|
|-|-|
|[README.md](../README.md)|User docs (features/install/deploy/FAQ)|
|This file `docs/DEVELOPMENT.md`|Development: architecture/build/package/CI/release|
|[CONTRIBUTING.md](../CONTRIBUTING.md)|Contribution process (testing/commits/PR contract)|
|[AGENTS.md](../AGENTS.md)|Always-on repository rules (purpose/hard facts/execution flows/package map)|
|[docs/AGENTS.md](./AGENTS.md)|Documentation standard (layering/writing/word budgets/doc gates/review checklist)|
|[.agents/skills/](../.agents/skills)|Reusable workflows: chamber-doc / chamber-pre-push / chamber-code-review|
|[CHANGELOG.md](../CHANGELOG.md)|Version history|
|[docs/INDEX.md](./INDEX.md)|**Global docs map**: the single navigation entry for entries / design / checklists / progress / ops|
|[docs/design/INDEX.md](./design/INDEX.md)|Design index (domain × status × owner; overview [01-overview.md](./design/01-overview.md))|
|[docs/design/decisions/README.md](./design/decisions/README.md)|Cross-domain decision records (ADR)|
|[docs/progress/README.md](./progress/README.md)|Progress-system rules (ownership and writing rules for STATUS / TODO / deviations / electron-frozen)|
|[docs/progress/STATUS.md](./progress/STATUS.md)|Progress overview (the only progress record; open items / criteria / pointers)|
|[docs/progress/electron-frozen.md](./progress/electron-frozen.md)|Electron freeze registry (scope / archived inventory / shared contracts / forbidden surfaces / revival checklist)|
|[docs/checklists/README.md](./checklists/README.md)|Checklist stage matrix (the single source for stage → gate → checklist entries)|
