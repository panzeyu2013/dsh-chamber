# dsh-chamber

[![License](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-brightgreen)]()

The desktop connection manager for [dsh](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness): one native window for dsh instances here and on any number of servers — local out of the box, remote in one step.

## User interface

![dsh-chamber user interface](../assets/page.png)

*Main user interface — one window with the dsh-native sidebar listing each source's sessions/workspaces and the active instance's dsh shell.*

> 中文版: [README.md](../README.md) · Development: [DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md) · Design: [01-overview.md](design/01-overview.md) · Progress: [STATUS.md](progress/STATUS.md)

## Quick start

### 1 · Download and install

Installers for every platform come from [GitHub Releases](https://github.com/panzeyu2013/dsh-chamber/releases):

- macOS: `dsh-chamber-<version>-<arch>.dmg`
- Windows: NSIS installer (`.exe`)
- Linux: `dsh-chamber-<version>.AppImage` (x64; needs FUSE or
  `APPIMAGE_EXTRACT_AND_RUN=1`; auto-update requires starting the AppImage
  from a writable path — see `docs/design/22-linux-desktop.md`)

### 2 · Open the app

The local dsh instance is hosted automatically (web profile auto-spawn/supervision/health, no command line); the first screen is its full dsh UI.

### 3 · Deploy the server side (before connecting remotely)

To reach a dsh instance on a remote server, deploy it there first; the app can only connect after that. Either way works:

#### Option A: one-shot script — Gateway (recommended)

The Gateway hosts a dsh instance behind one authenticated entry point. One command starts the interactive wizard (every option explained and validated; `q` quits, `ESC` or `back` goes back):

```bash
curl -fsSL -o install-gateway.sh \
  https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/main/scripts/install-gateway.sh
bash install-gateway.sh
```

The script completes automatically (defaults: loopback-only, `~/.dsh-chamber` install, gateway on 30801, managed dsh on 30800; all editable):

1. dsh readiness — probes for dsh: reuses a managed version, asks before taking over an unmanaged one, installs if absent
2. Download + verification — pulls the package from GitHub Releases and checks the sha256
3. Install — local by default; the gateway owns the dsh version, switchable at runtime via `/chamber/runtime`
4. Credentials — double entry with the character count shown, written to a 0600 config file
5. Service — systemd unit (system unit under root; non-root defaults to `systemctl --user`; auto-foreground without systemd)
6. Health check — polls `/health` until ready

After installation:

- Daily management: `install-gateway.sh status|logs|restart|update|uninstall`
- Public access: reverse-proxy HTTPS to `127.0.0.1:30801` with Nginx/Caddy — see [deploy/deploy-gateway.md](deploy/deploy-gateway.md)
- Desktop access: Settings → Connections, add a Gateway source (HTTP transport + proxy address); shared token / login password as needed

#### Option B: remote dsh instance + systemd

Without a gateway, persist the server's dsh instance with systemd (system or user unit, non-root) and connect over SSH; configuration and troubleshooting: [deploy/remote-dsh-instance.md](deploy/remote-dsh-instance.md).

Already on a direct instance and switching to the Gateway? Existing data does not follow; after installing the gateway, run the one-time migration in [deploy-gateway.md §3 "Migrating from a direct dsh instance to the Gateway"](deploy/deploy-gateway.md).

### 4 · Add a remote host

In Settings → Connections, pick a target (`dsh` / `gateway`) and a transport (`ssh` / `http`) — all four combinations: the app sets up SSH tunnels and can manage remote systemd; HTTP(S) connects from the main process (HTTPS by default; plaintext HTTP shows a permanent risk warning).

## Features

- Local dsh hosting, one click — the local instance auto-starts with readiness, supervision/reaping, health status and host logs; the first screen is its full dsh UI
- Runtime version management (hot reload) — switch/upgrade/roll back the dsh runtime per instance in Settings, effective immediately; plugin updates need no desktop-app restart (local and gateway alike)
- Remote instances over SSH — add a host and the app sets up an SSH tunnel and manages the remote systemd service; key or password auth
- Authenticated Gateway access — attach a deployed gateway as a `gateway` source; shared token / login password as needed, HTTPS by default
- Unified multi-source sidebar navigation — sessions/workspaces from every source (local + remote) listed equally in the dsh-native sidebar, grouped by source (remote ones carry a badge); single click opens, double click renames
- Sidebar collapse / drag / accent colors — source-level collapse toggles fold that source's workspace list; server groups drag-sort (persisted across instances); sources/workspaces carry accent bars
- Git worktree lifecycle — per-instance repository topology in the sidebar plus a closed worktree → workspace → session create flow; deletion is a retryable Git-first transaction: main/locked/running targets are hard-blocked, a dirty target is force-removed only after the dialog's explicit "discard uncommitted changes" consent (branches and commits stay), and the local branch can optionally go too
- Multiple instances in parallel (N-ctx) — several dsh shells in one window; switch the active instance any time
- Open-in registry — one open surface in the session header: reveal directories in Finder/file manager for local sources; launch VS Code for local (`vscode://file/`) or SSH remote (Remote-SSH) sources; supports `dsh-chamber://` deep links
- Desktop notifications — native notifications for session completion/question/approval, clicking opens the session; toggle in Settings "Notifications"
- Desktop updates — stable and beta use separate configs and feeds; silent checks, an "Update" section in Settings, download after confirmation, install on quit (low-noise, no dialogs)
- Sleep / background persistence — closing can hide to tray and keep running (or quit with confirmation); launch at login (macOS/Windows/Linux); reconnect on OS wake; keep-awake toggle
- Chamber settings page — fixed Settings-shell entries: Connections / General; chamber-global and per-instance settings strictly separate
- Backend version tolerance — instances whose backend dsh frontend version differs from the chamber shell keep working: extra plugin rows the shell does not cover degrade to absent features (never a whole-boot crash)

## FAQ

- **Why does `pnpm run smoke` print SKIP?** — the smoke test needs a dsh install; without one it prints SKIP and exits 0 — normal, not a failure.
- What does a remote instance need? — a reachable API-profile dsh target, or a deployed `@dsh-chamber/gateway`. Either can use an SSH tunnel or explicit HTTP(S); no remote web frontend is needed — the reused local UI reaches it via same-origin proxying.
- How do agent presets / profiles work across instances? — per-instance authoritative: each instance's `settings`/`credentials`/`llm`/`agentPreset` config plane lives only on that side (local = this machine, remote = the far server). To edit a remote preset, switch to that source's shell Settings → Agent presets.
- Where does the frontend come from? — the dsh official frontend, source-reused and self-built; every instance keeps its native UI.
- Windows install is slow / stuck on "Installing"? — Windows Defender scans the ~33k runtime files one by one — known tradeoff (design 23 F3): wait, or exclude `%APPDATA%\@dsh-chamber\desktop` from Defender for a large speedup; progress lines say so.
- Can I use an SSH password on Windows? — No (askpass needs a PE executable). Use a key or ssh-agent (Pageant); the save gate refuses passwords and guides you.
- dsh runtime version management on Windows? — in progress (design 23): read-only projection by default; dev validation uses `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1`; the official unlock waits for real-Windows records.
- Why does Windows show a SmartScreen warning? — the installer is not Authenticode-signed yet (known tradeoff, design 23 F6); sha512 only proves download integrity. From this repository's Releases, choose "More info → Run anyway".

## Documentation

|Document|Purpose|
|---|---|
|[docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md)|Development: architecture/setup/build/package/CI/release/repo layout|
|[deploy/deploy-gateway.md](deploy/deploy-gateway.md)|Server-side Gateway deployment guide|
|[deploy/remote-dsh-instance.md](deploy/remote-dsh-instance.md)|Remote dsh instance persistence with systemd|
|[CONTRIBUTING.en-US.md](CONTRIBUTING.en-US.md)|Contribution guide (testing/commits/PR contract)|
|[AGENTS.md](../AGENTS.md)|Development constraints (always-on repo rules)|
|[CHANGELOG.en-US.md](CHANGELOG.en-US.md)|Version history|
|[design/01-overview.md](design/01-overview.md)|Design entry: consolidation principles, scope, removals|
|[progress/STATUS.md](progress/STATUS.md)|Status, remaining deviations & validation record|
|[README.md](../README.md)|中文README|

## Related projects

- [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — the managed host
- [OpenChamber](https://github.com/openchamber/openchamber) — the multi-instance session model behind dsh-chamber's N-ctx design and name; thanks for the inspiration!

## Contributing

See [CONTRIBUTING.en-US.md](CONTRIBUTING.en-US.md). Constraints: [AGENTS.md](../AGENTS.md); setup and builds: [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md).

## License

MIT — see [LICENSE](../LICENSE).
