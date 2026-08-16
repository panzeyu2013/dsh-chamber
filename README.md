# dsh-chamber

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen)]()

**The local desktop connection manager for [dsh](https://github.com/deepseek-ai/deepseek-harness).**

## User interface

![dsh-chamber user interface](assets/page.png)

*Main user interface — a single window with the dsh-native sidebar listing every source's sessions/workspaces, and the pure-dsh shell of the active instance.*

dsh-chamber hosts the local dsh instance (web profile) and attaches dsh instances on remote servers over SSH tunnels. The UI is the **dsh official frontend, source-reused and self-built** — a single window with a single frame, where multiple instances coexist as N-ctx shells and their sessions/workspaces are navigated uniformly in the dsh-native sidebar (first screen = the local instance's full dsh shell, pure dsh UI). The control plane owns connection management, per-instance same-origin reverse proxying, and static frontend serving (v1 has no authentication/audit surface).

> [!WARNING]
> **Developer preview (v0.1)** — the protocol and API are iterating rapidly; expect breaking changes.

> Chinese: [docs/README.zh-CN.md](docs/README.zh-CN.md) · Design entry: [docs/design/01-overview.md](docs/design/01-overview.md) · Surface/architecture contract: [docs/design/05-connection-manager.md](docs/design/05-connection-manager.md) · Progress: [docs/progress/STATUS.md](docs/progress/STATUS.md)

## What is dsh-chamber?

dsh harness is built around an *everything-is-a-plugin* philosophy: model adapters, tool registry, session logs, agent loop, and the official Web UI itself are host plugins. Goals, jobs, terminals, schedule, settings, and plugin inventory are all native host capabilities — including the frontend that hosts them.

dsh-chamber therefore does **not** re-implement those domains and does **not** write a second UI. It only does the five things a host plugin structurally *cannot* do:

| # | Core responsibility | Why a plugin can't do it |
|---|---|---|
| 1 | **Local host hosting** — web-profile spawn, readiness, reaper, health, logs | "Managing dsh itself" is the chicken-and-egg problem: a plugin dies with its host process |
| 2 | **Frontend hosting & per-instance reverse proxy** | the dsh frontend requires same-origin `/api` + WS (`location.origin` is hardcoded); cross-instance same-origin access can only be served by a host-side server (v1 has no auth boundary — instances are anonymously reachable on loopback only) |
| 3 | **Remote instance access** — SSH tunnels + systemd start/stop | cross-server connection orchestration can only live outside the server |
| 4 | **Management REST** — connection CRUD, health, logs | the manager's own surface |
| 5 | **Multi-source session navigation** — one dsh-native sidebar listing the sessions/workspaces of every source equally | the official dsh sidebar only knows its own connection; a navigation layer treating local and remote sources as equal citizens must be supplied by the chamber side (self-built sidebar plugin + bridge layer) |

**Session business is entirely the dsh frontend runtime's job** (each instance gets a complete dsh shell, coexisting as N-ctx): the control plane consumes no host frames, builds no session index, and participates in no chat/approval.

## Features

- **dsh official frontend, source-reused and self-built** — one window, one frame, one origin; the only dsh source changes are the five chamber packages: the in-repo copies `packages/dsh-client-connection` (connection-client base-path patch) and `packages/dsh-client-web` (boot.tsx N-ctx module-table sharing seam + `runtimeCtx` getter), and the self-built `packages/dsh-chamber-client-ui-sidebar` (replacing the official ui-sidebar registration — see 05 §6), `packages/dsh-chamber-client-ui-settings-connections` and `packages/dsh-chamber-client-ui-settings-bridge` (the connections settings page and its settings shell — see 05 §5)
- **N-ctx multi-instance** — multiple dsh shells coexist in one window (one AppWebEntry per instance, each with its own cordis context and full ui-* tree); the chamber sidebar switches the active context
- **Multi-source sidebar navigation** — sessions/workspaces of every source (local + remote instances) are listed equally in the dsh-native sidebar, grouped by source with a color badge per remote source; the first screen is the local instance's full dsh shell (pure dsh UI, no chamber shell)
- **Chamber bridge host** — entry-level React (v1): first screen = the local instance's full dsh shell (pure dsh UI, no chamber shell); the App host auto-starts the local instance, auto-connects the registry's remote instances, publishes the chamberBridge projection and dispatches open-session requests; multi-source navigation itself is rendered by the self-built sidebar plugin; the former `chamber-auth` login plugin was removed with the v1 auth/audit removal
- **Local host hosting** — web-profile spawn, readiness, reaper, health state machine, host logs
- **Per-instance same-origin reverse proxy** — `/api/i/<id>/*` HTTP/WS/SSE passthrough for local and tunneled instances, anonymously reachable on loopback only (no tunnel → explicit 503)
- **Remote instances** — the desktop transport runtime (`transport-manager` + the `ssh` provider, `TransportProvider` interface open to future sources): SSH tunnels (`ssh -N -o ServerAlive… -L`) plus remote systemd `start`/`stop`/`is-active` with a serviceName whitelist; optional per-host password auth (design 05 §8) via `desktop_ssh_set_password` + an ephemeral askpass helper (see Security)
- **Management REST** — `/health`, `/api/connections`, `/api/host/logs`, plus static frontend serving with the `__DSH_BOOT__` boot manifest

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron window (single frame, loadURL the control-plane origin)      │
│ └─ dsh official frontend (source-reused)                              │
│     ├─ self-built sidebar plugin: multi-source session navigation +  │
│     │    chamberBridge in the dsh-native sidebar                     │
│     ├─ bridge host (entry-level React): first screen = the local     │
│     │    instance's pure dsh shell                                    │
│     └─ N-ctx: one dsh shell per instance, same-origin via            │
│          /api/i/<id>/*                                               │
├───────────────────────────────────────────────────────────────────────┤
│ Control plane (127.0.0.1:17500)                                      │
│  ├─ management REST: /health · /api/connections · /api/host/logs     │
│  ├─ per-instance reverse proxy: /api/i/local/* → local dsh (web      │
│  │    profile)                                                       │
│  │            /api/i/ssh-<id>/* → tunnel localPort                   │
│  │            (v1 anonymous, loopback-only)                          │
│  ├─ local instance hosting (spawn/health/reaper)                     │
│  └─ static frontend serving (dist + __DSH_BOOT__ manifest)           │
├───────────────────────────────────────────────────────────────────────┤
│ Desktop main process (desktop)                                       │
│  ├─ transport-manager + ssh provider (TransportProvider interface)   │
│  │    ssh -N -o ServerAlive… -L tunnel +                             │
│  │    systemctl start/stop/is-active                                 │
│  ├─ instance registry: <userData>/ssh-instances.json                 │
│  └─ IPC (preload whitelist): dsh-chamber:info · desktop_ssh_*        │
└───────────────────────────────────────────────────────────────────────┘
```

| Package | Role |
|---|---|
| `packages/control-plane` | Connection-manager core: web-profile host hosting, management REST, per-instance reverse proxy, static frontend serving |
| `packages/renderer` | The self-built dsh frontend (source reuse): entry build, pure-dsh first screen bridge host (auto-start/auto-connect, chamberBridge), N-ctx orchestration, boot manifest |
| `packages/desktop` | Electron shell: single frame, transport-manager + `ssh` transport provider (tunnels + systemd exec), instance registry, IPC |
| `packages/cli` | CLI thin shell (serve/status/connections/host logs) |
| `packages/dsh-client-connection` | Copied dsh source: the connection client with the base-path patch |
| `packages/dsh-client-web` | Copied dsh source: the web shell with the boot.tsx N-ctx module-table sharing seam |
| `packages/dsh-chamber-client-ui-sidebar` | Self-built (copied ui-sidebar structure): the chamber sidebar plugin replacing the official ui-sidebar registration (see 05 §6) |
| `packages/dsh-chamber-client-ui-settings-connections` | Self-built: the connections settings plugin (local instance card + remote host CRUD/connect/systemd/logs, settings.section, dsh design tokens — see 05 §5) |
| `packages/dsh-chamber-client-ui-settings-bridge` | Self-built: the settings shell plugin shadowing the official SettingsRoot registration (sidebar.settings at priority −1) — a server dropdown over the selected instance's official settings sections plus the fixed chamber-global connections nav entry (see 05 §5) |

## Quick start

### Prerequisites

- Node.js 22+ (LTS recommended; sources are TypeScript run natively via Node's type stripping, see `.nvmrc`)
- pnpm ≥ 11 (the package manager; lockfile `pnpm-lock.yaml`)
- git
- macOS for `dist:desktop:mac` (dmg/zip)
- A dsh host installation is optional — it is only needed for the integration smoke test, which auto-skips when dsh is absent

### 1 · Clone

```bash
git clone <REPO-URL>
cd dsh-chamber
```

### 2 · dsh source tree (automatic via preinstall)

`vendor/harness-packages` is a gitignored directory of symlinks, one per dsh package — each symlink is named after the package and points into a [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) source tree. It is never committed, and it must exist **before** `pnpm install`, because `pnpm-workspace.yaml` resolves the unmodified dsh packages through it. `scripts/ensure-harness-vendor.mjs` bootstraps it; on a fresh clone run it explicitly **before** `pnpm install` (pnpm captures the workspace snapshot before `preinstall` runs, so the link step alone is not enough there):

```bash
node scripts/ensure-harness-vendor.mjs
pnpm install
```

The script resolves the tree in this order:

1. `DSH_CHAMBER_HARNESS_ROOT` env var, if set — use that checkout as-is;
2. `vendor/harness-checkout` — a managed snapshot previously downloaded by the script (reused when its `.harness-pin` marker matches the pinned commit);
3. a sibling checkout at `<repo>/../deepseek-harness` (zero-network local dev; warns if its HEAD differs from the pin);
4. otherwise download the pinned commit snapshot from codeload (pinned in `harness.commit`, overridable with `DSH_CHAMBER_HARNESS_COMMIT`).

The two excluded packages (`dsh-client-connection`, `dsh-client-web`) are in-repo copies we modify — they live in `packages/` and shadow the workspace entries; the other three modified sources are self-built: `packages/dsh-chamber-client-ui-sidebar` (see 05 §6), `packages/dsh-chamber-client-ui-settings-connections` and `packages/dsh-chamber-client-ui-settings-bridge` (see 05 §5).

### 3 · Install

```bash
pnpm install
```

The root `.npmrc` is a gitignored local convenience that may point the Electron binary download at the npmmirror mirror; without it, Electron downloads from the official source. The packaging-time mirror is committed in `packages/desktop/package.json` (`electronDownload.mirror`).

### 4 · Bundle the dsh runtime

The desktop needs the official `@deepseek-ai/dsh` release bundled into `packages/desktop/vendor/dsh` (the control plane's default dsh workspace, after an optional `ref-dsh` source symlink):

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # pin a version with DSH_CHAMBER_DSH_VERSION
```

`bundle:dsh` is also run automatically by `build:desktop` / `dist:desktop:mac` — you can skip this step and go straight to run or package.

### 5 · Run

```bash
pnpm run dev:control-plane   # control plane only — http://127.0.0.1:17500 (management REST + static frontend)
pnpm run dev:desktop         # the full window: control plane + dsh frontend + desktop shell
```

### 6 · Package the app

```bash
pnpm run dist:desktop:mac    # build:renderer → build:control-plane → build:preload → bundle:dsh → electron-builder
pnpm run dist:desktop:win    # same chain, but run on Windows — the dsh runtime bundle is host-platform-specific
```

The packaged app lands in `packages/desktop/release/` (electron-builder `directories.output`): macOS produces `dsh-chamber-<version>-<arch>.dmg`; Windows produces the NSIS installer (`.exe`). Artifacts go out **unsigned** — no Apple signing/notarization or Windows code-signing certificates are configured.

### 7 · CI and releases

- `.github/workflows/ci.yml` runs on every push/PR: validation chain (frozen install → typecheck → i18n → control-plane unit tests → smoke → renderer build) plus per-platform desktop packaging sanity checks (macOS `dist:desktop:mac` + real smoke; Windows `dist:desktop:win` on `windows-2022`).
- `.github/workflows/release.yml` creates the distributable release: push a `v*` tag (or run it manually with a version + optional dry-run). It creates a draft GitHub Release, builds macOS arm64 + x64 on native runners and Windows x64 on `windows-2022`, uploads the artifacts into the draft, then flips it to public.
- Both workflows bootstrap the vendored dsh source tree from the pinned `harness.commit` before install (see section 2).

## Server-side deployment

### Remote dsh instance (systemd)

The remote server only runs dsh's API-facing web profile on loopback — no web frontend is needed there: the UI comes from the locally reused frontend through the `/api/i/ssh-<id>/*` tunnel.

1. **Requirements** — Linux with systemd, Node.js 22+, and SSH access from the machine running the chamber desktop (key-based: the desktop's transport runtime drives `systemctl` over the SSH channel).
2. **Install dsh** (official distribution):

   ```bash
   npm install -g @deepseek-ai/dsh
   dsh --version
   which dsh   # record the install path (npm-global, not /usr/bin) for ExecStart below
   which node  # record the node bin dir (nvm-managed, not in systemd's PATH) for the PATH line below
   ```

3. **Persist it with systemd** — create `/etc/systemd/system/dsh.service`:

   ```ini
   [Unit]
   Description=dsh web profile (remote instance)
   After=network.target

   [Service]
   Type=simple
   # Runs as root (simplest setup). For the hardened option, create a
   # dedicated non-root service account instead and own DSH_HOME to it:
   #   sudo useradd --system --home /var/lib/dsh/dsh-home dsh
   #   sudo chown -R dsh:dsh /var/lib/dsh/dsh-home
   # and set `User=dsh` / `Group=dsh` below.
   # The web profile serves the dsh API + frontend on loopback only. --port
   # and --trusted-host always agree (127.0.0.1:<P>): the browser trust fence
   # admits the Host header the chamber tunnel forwards (`dsh web` is the
   # hard alias of `--profile web`). Replace <DSH_PATH> with the path from
   # `which dsh` above — npm global installs put it under the user's npm
   # prefix (e.g. /usr/local/bin/dsh), not /usr/bin.
   ExecStart=<DSH_PATH> --profile web --host 127.0.0.1 --port 30800 --trusted-host 127.0.0.1:30800
   Restart=on-failure
   RestartSec=3
   # dsh is a node script (shebang `#!/usr/bin/env node`), and systemd's
   # default PATH does not include nvm's node → the service crash-loops with
   # status=127 ("/usr/bin/env: 'node': No such file or directory"). Replace
   # <NODE_BIN> with the dir of `which node` above (e.g.
   # /root/.nvm/versions/node/v22.22.3/bin). Note: Environment= is a literal
   # whole-line assignment (no append-to-existing-PATH syntax) and ExecStart
   # does no variable expansion — write the full absolute paths.
   Environment=PATH=<NODE_BIN>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   # The server shape uses a dedicated DSH_HOME (design 02 §5.6):
   Environment=DSH_HOME=/var/lib/dsh/dsh-home
   Environment=DSH_TELEMETRY_DISABLED=1
   Environment=DSH_PERMISSION_MODE=workspace-write
   # Pin the in-app directory browser for chamber's remote deployment. Without
   # this SSH marker, a Linux host with a display session may resolve the
   # directory picker to native and make remote workspace selection unusable.
   Environment="SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0"
   NoNewPrivileges=true
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now dsh
   sudo systemctl status dsh
   ```

   If it crash-loops, check the logs — a `status=127` + `/usr/bin/env: 'node': No such file or directory` means the PATH line above doesn't include the actual node bin dir.

   Loopback binding (`--host 127.0.0.1`) is deliberate: the chamber desktop reaches the instance through its SSH tunnel, so no extra attack surface is exposed. Only if you want to hit port 30800 directly from other machines (bypassing the chamber tunnel) would you change to `--host 0.0.0.0` — and then you must add real authentication (the v1 instance is anonymous) or front it with a reverse proxy instead.

4. **Connect from the chamber desktop** — in the connections settings page, add the remote host (label / host / user / SSH port / the dsh port (default 30800) / service name `dsh`). The desktop then owns the rest: `ssh -N -L` tunnel plus `systemctl start|stop|is-active dsh` (service name whitelist `^[a-zA-Z0-9_.-]+$`). The unit shape follows design 02 §3.9; the instance contract is 03 §2.2.

## Scripts

| Script | Description |
|---|---|
| `pnpm run typecheck` | strict `tsc --noEmit` (0 errors expected) |
| `pnpm run smoke` | integration smoke — auto-SKIPs when dsh is not installed (normal) |
| `pnpm run build:renderer` | build the dsh-frontend bundle (vite over the dsh workspace source) |
| `pnpm run build:desktop` | renderer + control-plane compile + dsh bundling |
| `pnpm run dist:desktop:mac` | package the macOS app (dmg + zip) |
| `pnpm run dist:desktop:win` | package the Windows app (nsis + zip; run on Windows — the dsh runtime bundle is platform-specific) |
| `pnpm run verify:i18n` | fail when an EN ↔ ZH pair drifts; re-record with `-- --write` |
| `pnpm run gen:notices` | regenerate THIRD_PARTY_NOTICES.md from the installed dependency tree |
| `pnpm run cli -- <args>` | the in-repo CLI thin shell (serve/status/connections/host logs) |

## Security

- **No auth boundary in v1** — the control plane listens on loopback only (127.0.0.1); every `/api/*` route and the per-instance proxy are anonymous, with CORS limited to loopback origins plus an explicit allowlist
- **Tunnel URLs and SSH material stay out of the renderer** — the renderer only ever sees non-secret projections (phase/localPort), never the tunnel URL or SSH credentials; logs carry no tunnel/SSH material either. The one sanctioned exception ([design 05 §8](docs/design/05-connection-manager.md)) is an optional per-host SSH password: transient form input, held in the main process, mirrored to `<userData>/ssh-passwords.json` (0600, atomic write) and fed to system ssh via an ephemeral 0600 askpass helper — never on the command line, never in the registry or logs, never back to the renderer; gated off on Windows in v1.
- **systemctl exec uses argument-array spawn** (no shell) with a serviceName whitelist (`^[a-zA-Z0-9_.-]+$`)

## FAQ

- **Why does `pnpm run smoke` print SKIP?** — the smoke test needs a dsh installation; when none is found it prints SKIP and exits 0. This is expected, not a failure.
- **What does a remote instance need?** — a dsh instance with an API-facing profile and SSH access. No web frontend needs to be installed on the remote server: the UI comes from the locally reused frontend through the `/api/i/ssh-<id>/*` tunnel.
- **How do agent presets / profiles work across instances?** — per instance, authoritative. Each instance's `settings`/`credentials`/`llm`/`agentPreset` planes live only on that instance (local = this machine, remote = the remote server). Every read/write goes through the `/api/i/<id>/*` proxy to that instance's own API: the preset picker on the new-session screen lists the roster of the instance the session will live on, and the choice is applied there. There is no cross-source profile matching or merging — edit a remote preset by switching to that source's shell and opening its Settings → Agent presets.
- **Where does the frontend come from?** — the dsh official frontend, source-reused and self-built; the dsh source changes are limited to the five chamber packages (connection base-path patch, web N-ctx seam, and the self-built sidebar / connections settings / settings-bridge plugins), so every instance keeps its native UI.

## Repository structure

```
packages/
  control-plane/            control plane: host hosting, management REST,
                            per-instance reverse proxy, static frontend serving
  renderer/                 self-built dsh frontend (source reuse + bridge host + N-ctx)
  desktop/                  Electron shell: single frame, transport-manager + ssh provider, instance registry, IPC
  cli/                      CLI thin shell
  dsh-client-connection/    modified dsh source #1 (base-path patch)
  dsh-client-web/           modified dsh source #2 (boot.tsx N-ctx seam)
  dsh-chamber-client-ui-sidebar/    self-built sidebar plugin: multi-source session
                            navigation + chamberBridge (copied ui-sidebar
                            structure, replaces the official ui-sidebar
                            registration — 05 §6)
  dsh-chamber-client-ui-settings-connections/
                            self-built connections settings plugin (05 §5)
  dsh-chamber-client-ui-settings-bridge/
                            self-built settings shell plugin: shadows the official
                            SettingsRoot registration, server dropdown over the
                            selected instance's official settings sections (05 §5)
docs/
  design/                   design documents (01 is the entry point; 05 is the
                            surface/architecture contract (v1); the v2-era
                            thin-shell docs, old 05/10, removed with v4)
  todo/                     unimplemented feature ideas (one file per item,
                            see todo/README.md)
  progress/                 STATUS.md — the only progress overview
vendor/
  harness-packages/         @deepseek-ai/* symlink tree into the dsh source
                            (bootstrapped by preinstall, pinned in harness.commit)
  harness-checkout/         managed dsh snapshot (download fallback, gitignored)
```

## Documentation

| Document | Purpose |
|---|---|
| [docs/design/01-overview.md](docs/design/01-overview.md) | Design entry point: consolidation principles, scope, removal map |
| [docs/design/02-host-management-deployment.md](docs/design/02-host-management-deployment.md) | Host management & deployment (web profile) |
| [docs/design/03-connections-proxy.md](docs/design/03-connections-proxy.md) | Connections & per-instance proxy |
| [docs/design/04-control-plane-api-data.md](docs/design/04-control-plane-api-data.md) | Management API & data model |
| [docs/design/05-connection-manager.md](docs/design/05-connection-manager.md) | Surface & architecture contract (v1) |
| [docs/design/06-sidebar-enhancements.md](docs/design/06-sidebar-enhancements.md) | Sidebar enhancements (search / drag-sort / view persistence / runtime facts) |
| [docs/design/07-models-params.md](docs/design/07-models-params.md) | Model extra params & default reasoning level (deferred, awaiting upstream) |
| [docs/todo/08-todo-git-worktree-plugin.md](docs/todo/08-todo-git-worktree-plugin.md) | Git worktree plugin (design finalized, implementation not scheduled; moved to docs/todo/) |
| [docs/todo/09-todo-client-plugin-runtime-loading.md](docs/todo/09-todo-client-plugin-runtime-loading.md) | dsh client-plugin runtime loading (design finalized, implementation not scheduled) |
| [docs/progress/STATUS.md](docs/progress/STATUS.md) | Completion status, deviations & validation record |
| [docs/README.zh-CN.md](docs/README.zh-CN.md) | Chinese README |

## Related projects

- [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — the managed host
- [OpenChamber](https://github.com/openchamber/openchamber) — the multi-instance session model that inspired dsh-chamber's N-ctx design and its name; thanks for the inspiration!

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and contribution guidelines. Development rules live in [AGENTS.md](./AGENTS.md).

## License

MIT — see [LICENSE](./LICENSE).
