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
│  │                     /api/i/ssh-<id>/* → tunnel localPort            │
│  │                     (v1 anonymously reachable, loopback-only)       │
│  ├─ Local host hosting + two-host-package seed / one overlay           │
│  └─ Static frontend serving (dist + __DSH_BOOT__ manifest)             │
├───────────────────────────────────────────────────────────────────────┤
│ Desktop main process (desktop)                                         │
│  ├─ transport-manager + ssh provider (TransportProvider interface)     │
│  │    ssh -N -o ServerAlive… -L tunnel + systemctl start/stop/is-active │
│  ├─ Ready-time remote host-package seed (never SSH-executes Git)       │
│  ├─ Instance registry: <userData>/ssh-instances.json                   │
│  └─ IPC (preload allowlist): dsh-chamber:info · desktop_ssh_*          │
└───────────────────────────────────────────────────────────────────────┘
```

**In one sentence**: the control plane (connection-manager core) owns connection management, per-instance same-origin reverse proxying, and static frontend serving; the renderer is the dsh official frontend, source-reused and self-built (single window, single frame, multiple instances coexisting as N-ctx shells); the desktop shell attaches remote instances over SSH tunnels.

Git worktree support pairs a chamber-bundled client plugin with an **in-instance**
host plugin. The control plane and desktop only distribute the host package and
mount loader rows; they neither interpret Git facts nor execute Git over SSH.

**Design authority** lives in `docs/design/` (01 is the entry point, 05 is the v1 surface/architecture contract); **package responsibilities and constraints** live in `AGENTS.md` "Runtime Boundaries" — this file is a one-line navigation aid only and does not repeat the details.

| Package | Responsibility (one line) |
|---|---|
| `packages/control-plane` | Connection-manager core: web-profile host hosting, local two-host-package seed/overlay, management REST, per-instance proxy, static frontend serving |
| `packages/renderer` | Self-built dsh frontend (source reuse): entry build, pure-dsh first-screen bridge host, N-ctx orchestration, boot manifest |
| `packages/desktop` | Electron shell: single frame, transport-manager + ssh provider (tunnels + systemd), ready-time remote host-package seed, instance registry, IPC |
| `packages/cli` | CLI thin shell (serve/status/connections/host logs) |
| `packages/dsh-client-connection` | In-repo copy of the official connection client + base-path patch |
| `packages/dsh-client-web` | In-repo copy of the official web shell + boot.ts N-ctx module-table sharing seam |
| `packages/dsh-chamber-client-ui-sidebar` | Self-built sidebar plugin: multi-source session navigation + chamberBridge (replaces the official ui-sidebar registration) |
| `packages/dsh-chamber-client-ui-settings-connections` | Self-built connections settings plugin (local instance card + remote host CRUD/connect/systemd/logs) |
| `packages/dsh-chamber-client-ui-settings-bridge` | Self-built settings shell plugin (shadows the official SettingsRoot registration; server dropdown + fixed connections nav entry) |
| `packages/dsh-chamber-client-ui-layout` | Self-built ui-layout shell fork (layout-store replacement persisting sidebarWidth) |
| `packages/dsh-host-client-graph` | Host-side package: read-only exposure of the instance's client-plugin boot graph over a Typert Remote |
| `packages/dsh-chamber-client-ui-git` | Chamber-bundled Git worktree client: sidebar slot, per-instance topology, create/remove sagas; never executes Git directly |
| `packages/dsh-chamber-host-git-worktree` | In-instance host package: authoritative workspace/agent guards plus constrained, local-only Git worktree lifecycle |

## 2. Environment setup

### 2.1 Requirements

- Node.js 22+ (LTS recommended; sources are TypeScript run natively via Node type stripping, see `.nvmrc`)
- pnpm ≥ 11 (package manager; lockfile `pnpm-lock.yaml`)
- git
- macOS (needed for `dist:desktop:mac` dmg/zip packaging)
- A dsh host install is optional — only needed for the integration smoke test, which auto-SKIPs when absent

### 2.2 Clone and install

```bash
git clone <REPO-URL>
cd dsh-chamber
```

`vendor/harness-packages` is a **gitignored symlink directory** — one symlink per dsh package, named after the package, pointing at the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) source tree. It is never committed and must exist **before** `pnpm install` (the workspace resolves unmodified dsh packages through it). `scripts/ensure-harness-vendor.mjs` bootstraps it; on a fresh clone run it explicitly **before** `pnpm install`:

```bash
node scripts/ensure-harness-vendor.mjs
pnpm install
```

The script resolves the source tree in this order:

1. `DSH_CHAMBER_HARNESS_ROOT` env var — use that checkout directly;
2. `vendor/harness-checkout` — a previously downloaded managed snapshot (reused when its `.harness-pin` marker matches the pinned commit);
3. sibling checkout `<repo>/../deepseek-harness` (zero-network local dev; warns when HEAD differs from the pin);
4. otherwise download a snapshot from codeload at the pinned commit (pinned in `harness.commit`, overridable via `DSH_CHAMBER_HARNESS_COMMIT`).

The root `.npmrc` is a gitignored local convenience config that can point Electron binary downloads at the npmmirror mirror; without it they come from the official source. The packaging-time mirror is committed in `packages/desktop/package.json` (`electronDownload.mirror`).

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

Artifacts land in `packages/desktop/release/` (electron-builder `directories.output`). Ordinary CI/dry-run artifacts may be ad-hoc or unsigned. Public releases fail closed unless macOS Developer ID signing/notarization and Windows Authenticode credentials are present and the emitted artifacts pass signature verification.

`build:desktop` copies the two built host packages into
`packages/desktop/dist/host-graph-package/` and
`packages/desktop/dist/host-git-worktree-package/`. The packaged local
control-plane seed and the desktop's ready-time remote seed consume those same
artifacts.

> Windows install slowness/hangs on "Installing" (Windows Defender per-file scanning) — see the README FAQ.

## 5. CI & releases

- `.github/workflows/ci.yml`: runs on every push/PR — validation chain (frozen install → root/two-host-package/client-plugin type checks → i18n → control-plane/desktop/renderer/client/host tests, including `test:git` and `test:host-git` → smoke → renderer build) plus per-platform packaging sanity (macOS `dist:desktop:mac` + real smoke; Windows `dist:desktop:win` on `windows-2022`).
- `.github/workflows/release.yml`: produces distributable releases — push a `v*` tag (or run manually with a version and optional dry-run). Creates a draft GitHub Release, builds macOS arm64 (v1 is Apple Silicon only) and Windows x64, uploads artifacts into the draft, then flips it public. Version assertions cover the chamber packages in the release matrix; the `## [<version>]` section of `CHANGELOG.md` is extracted as the release body (a missing section fails loudly).
- Both workflows bootstrap the vendor source tree at the `harness.commit` pin before installing.

## 6. Repository layout

```
packages/
  control-plane/            Control plane: host hosting, management REST,
                            per-instance proxy, frontend serving
  renderer/                 Self-built dsh frontend (source reuse + bridge host + N-ctx)
  desktop/                  Electron shell: single frame, transport-manager + ssh provider, instance registry, IPC
  cli/                      CLI thin shell
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
docs/
  design/                   Design documents (01 is the entry point; 05 is the surface/architecture contract (v1))
  todo/                     Unimplemented feature ideas (one file each, see todo/README.md)
  progress/                 STATUS.md — the only progress overview
  *.en-US.md                English mirrors of the root docs
vendor/
  harness-packages/         @deepseek-ai/* symlink tree into the dsh source
                            (bootstrapped by preinstall, pinned at harness.commit)
  harness-checkout/         Managed dsh snapshot (download fallback, gitignored)
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
