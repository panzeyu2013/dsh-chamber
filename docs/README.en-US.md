# dsh-chamber

[![License](https://img.shields.io/badge/license-MIT-blue)](../LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen)]()

**The local desktop connection manager for [dsh](https://github.com/deepseek-ai/deepseek-harness).**

## User interface

![dsh-chamber user interface](../assets/page.png)

*Main user interface — a single window with the dsh-native sidebar listing every source's sessions/workspaces, and the pure-dsh shell of the active instance.*

> [!WARNING]
> **Public beta (v0.2.0-beta.x)** — the protocol and API are still evolving and may introduce breaking changes.

> 中文版: [README.md](../README.md) · Development: [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md) · Design entry: [design/01-overview.md](design/01-overview.md) · Progress: [progress/STATUS.md](progress/STATUS.md)

## Quick start

### 1 · Download and install

Grab the installer for your platform from [GitHub Releases](https://github.com/panzeyu2013/dsh-chamber/releases):

- **macOS**: `dsh-chamber-<version>-<arch>.dmg`
- **Windows**: NSIS installer (`.exe`) — see the FAQ if install is slow or hangs on "Installing"

### 2 · Open the app

The **local dsh instance is hosted automatically** (web profile auto-spawn/health), and the first screen is the local instance's full dsh UI.

### 3 · Add a remote host

In Settings → Connections, select a `dsh|gateway` target and an `ssh|http`
transport in any of the four combinations. The app owns SSH tunnels and may
manage remote systemd; the main process connects HTTP(S) directly (HTTPS by
default, with a persistent risk warning for explicit plaintext HTTP). Gateway
token and login-password fields are configured independently. See
"Server-side deployment" for both forms.

### 4 · Running from source?

See the development docs at [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md).

## Features

- **Local dsh hosting, one click** — works out of the box: the local instance auto-starts with readiness/health/logs; the first screen is the local instance's full dsh UI
- **Remote instances over SSH** — add a host in the connections settings and the app sets up an SSH tunnel and manages the remote systemd service; optional password auth (stored securely, see Security)
- **Authenticated gateway access** — publish a device's loopback dsh through the standalone HTTPS-fronted gateway and attach it to desktop N-ctx as a `gateway` source; the token enters only a target-bound, main-process-owned secret store (safeStorage preferred, with an honest 0600 plaintext-file fallback when unavailable) and never enters the registry or logs
- **Unified multi-source sidebar navigation** — sessions/workspaces from every source (local + remote instances) are listed equally in the dsh-native sidebar, grouped by source (remote sources carry a colored badge); single click opens a session, double click renames
- **Sidebar collapse / drag / accent colors** — source-level collapse toggles fold the whole source's workspace list; server groups can be drag-sorted (persisted across instances); sources/workspaces carry soft accent color bars (Design 06 §2.4/§3.1)
- **Git worktree lifecycle** — a bundled, independent chamber plugin shows per-instance repository topology in the sidebar and closes the worktree → workspace → session create flow; deletion is a retryable Git-first transaction that hard-blocks main/locked/running targets, force-removes a dirty target only after the dialog's explicit "discard uncommitted changes" consent (branches and commits stay untouched), and may also delete the local branch from the dialog
- **Multiple instances in parallel (N-ctx)** — several dsh shells coexist in one window; switch the active instance at any time
- **Open-in registry** — one unified open surface in the session header: reveal directories in Finder/file manager for local sources, and launch VS Code for local (`vscode://file/`) or SSH-transport remote sources (Remote-SSH; HTTP-direct sources have no SSH authority and show no remote button; `dsh-chamber://` OS deep link; requires a local VS Code install); availability is probed live and failures are loud (Design 20)
- **Desktop notifications** — native notifications when a session completes or asks/requests approval; clicking opens the session; toggle per the Settings "Notifications" group (Design 19)
- **Desktop updates** — stable and beta use independent configuration and feeds; checks stay silent, Settings shows a low-key "Update" section, download starts only after confirmation, and installation happens on quit
- **Sleep / background persistence** — close behavior is configurable (hide to tray and keep running, or quit with confirmation); launch at login (mac/linux); immediate reconnect on OS wake; keep-awake toggle
- **Chamber settings page** — fixed Settings-shell entries: Connections / General; chamber-global settings stay strictly separate from per-instance config planes
- **Backend version tolerance (rc.2 compatible)** — instances whose backend dsh frontend version differs from the chamber shell keep working: extra plugin rows the shell does not cover degrade to absent features (never a whole-boot crash); headless-verified against an rc.2 backend
- **Security & privacy** — the control plane listens on loopback only
  (127.0.0.1). SSH passwords reach ssh through owner-only askpass leases;
  a Gateway token enters only a bounded Authorization header, while the raw
  login password enters only that bound Gateway's `/auth/login` JSON body and
  only the derived Cookie enters proxy headers. Credentials are transient form inputs, never
  prefilled or returned to the renderer, and persist only in owner-only,
  target-bound mirrors—never in logs or the registry. Public reachability exists
  only in the explicitly started, mandatory-auth Gateway process by default
  (`--no-auth` is a trusted-network bounded deviation).
- **Plugin actions need a main-process confirmation (design 09 §4)** — local/remote plugin installs & removals and the materialize transfer require a user confirmation dialog; local plugin-manifest dependency values are path-redacted

## Server-side deployment

### Authenticated gateway (Design 17)

The Gateway hosts one loopback dsh and proxies HTTP/WS/SSE through a single
authenticated boundary. In production, keep it on loopback and terminate TLS
at Nginx/Caddy. Desktop defaults to HTTPS; explicit plaintext HTTP is a bounded
trusted-network choice with a persistent risk indicator.

**Install (one-shot script)** — pulls the package from GitHub Releases (works before npm publishing), with an interactive wizard (defaults: gateway listens on **30801**, managed dsh on **30800**; both editable):

```bash
curl -fsSL -o install-gateway.sh \
  https://raw.githubusercontent.com/panzeyu2013/dsh-chamber/main/scripts/install-gateway.sh
bash install-gateway.sh          # interactive wizard (Enter = default, type to change)
```

The script auto-detects/installs dsh (reuses an existing one), downloads the tgz + sha256 check, npm-global install, writes credentials to a 0600 env file, sets up systemd (root) / foreground (non-root), and health-checks; management: `install-gateway.sh status|logs|update|uninstall`.
Public access: reverse-proxy HTTPS to `127.0.0.1:30801` and configure `--origin` /
`--trusted-proxy` (see [docs/deploy-gateway.md](docs/deploy-gateway.md)). Desktop:
Settings → Connections → Gateway + HTTP transport, enter the proxy address,
and optionally configure the shared token and/or login password (HTTPS by
default; plaintext HTTP requires an explicit choice).

### Remote dsh instance (systemd)

The remote server only needs the dsh API-side web profile on loopback — no web frontend there: the UI comes from the locally reused frontend through the `/api/i/dsh-<id>/*` same-origin proxy (using the SSH transport in this setup).

1. **Requirements** — a systemd Linux host, Node.js 22+, and SSH access from the machine running the chamber desktop (key auth: the desktop transport runtime drives `systemctl` over the SSH channel).
2. **Install dsh** (official release):

   ```bash
   npm install -g @deepseek-ai/dsh
   dsh --version
   which dsh   # note the install path (npm global, not /usr/bin) for ExecStart below
   which node  # note the node bin dir (nvm-managed, absent from systemd's PATH) for the PATH line below
   ```

3. **Persist with systemd** — either form below runs dsh as a non-root user, with all files landing in that user's own home. dsh defaults to `$HOME/.dsh`, so no DSH_HOME is needed.

   **Form A — system unit (recommended).** Create `/etc/systemd/system/dsh.service`
   (root is only needed once, to install the unit):

   ```ini
   [Unit]
   Description=dsh web profile (remote instance)
   After=network.target

   [Service]
   Type=simple
   # Run dsh as your SSH login user (replace <YOUR_USERNAME> with the real account).
   # dsh writes everything to that user's own home (default ~/.dsh) — no
   # mkdir/chown needed, no root-owned files. The web profile serves the dsh
   # API + frontend on loopback only. --port and --trusted-host always match
   # (127.0.0.1:<P>): the browser trust fence only accepts the Host header
   # forwarded by the chamber tunnel (`dsh web` is a hard alias of
   # `--profile web`; the two are equivalent). Replace <DSH_PATH> with the
   # `which dsh` path above — npm global installs live under the user's npm
   # prefix (e.g. /usr/local/bin/dsh), not /usr/bin.
   User=<YOUR_USERNAME>
   ExecStart=<DSH_PATH> --profile web --host 127.0.0.1 --port 30800 --trusted-host 127.0.0.1:30800
   Restart=on-failure
   RestartSec=3
   # dsh is a node script (shebang `#!/usr/bin/env node`), and systemd's default
   # PATH has no nvm node → the service crash-loops with status=127 (log:
   # "/usr/bin/env: 'node': No such file or directory"). Replace <NODE_BIN> with
   # the `which node` dir above (e.g. /home/<YOUR_USERNAME>/.nvm/versions/node/v22.22.3/bin).
   # Note: Environment= is a whole-line literal assignment that fully replaces
   # the old value — there is no "append to existing PATH" syntax, and no
   # variable expansion inside ExecStart — write full absolute paths.
   Environment=PATH=<NODE_BIN>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   Environment=DSH_TELEMETRY_DISABLED=1
   Environment=DSH_PERMISSION_MODE=workspace-write
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

   **Form B — user unit (no root at all).** When the server has no root (or you
   don't want to ask), a systemd user unit persists dsh just as well. Create
   `~/.config/systemd/user/dsh.service` — the unit shape is the same, just no
   `User=` line (runs as yourself) and `WantedBy=default.target`:

   ```ini
   [Unit]
   Description=dsh web profile (remote instance)
   After=network.target

   [Service]
   Type=simple
   ExecStart=<DSH_PATH> --profile web --host 127.0.0.1 --port 30800 --trusted-host 127.0.0.1:30800
   Restart=on-failure
   RestartSec=3
   Environment=PATH=<NODE_BIN>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   Environment=DSH_TELEMETRY_DISABLED=1
   Environment=DSH_PERMISSION_MODE=workspace-write
   NoNewPrivileges=true
   PrivateTmp=true

   [Install]
   WantedBy=default.target
   ```

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now dsh
   systemctl --user status dsh
   # Survives logout and boot — one-time step, needs root (or polkit):
   sudo loginctl enable-linger <YOUR_USERNAME>
   ```

   Creating and managing `--user` units needs no root; but **without linger**,
   the user manager (and your service) stops at logout. `loginctl enable-linger`
   makes it start at boot and survive logout.

   **Ownership rules.** dsh writes all files to the unit's running user's own
   home (default `~/.dsh`) — the user just needs a real home directory. No
   mkdir, no chown, and the "root wrote files my user can't read" problem never
   arises. Pick one of three accounts:

   - **Your login user** (Form A): `User=<YOUR_USERNAME>`, the home is already yours.
   - **A dedicated service account** (more secure): create it with a home —
     `sudo useradd --system --create-home dsh` (note: `useradd --system` does
     **not** create a home by default; `--create-home` is required) — then set
     `User=dsh` / `Group=dsh`; dsh uses that account's own `~/.dsh`.
   - **root**: possible but **not recommended** — dsh writes to `/root/.dsh`,
     owned by root and unreadable by your user.

   **Form B caveat**: the chamber desktop's systemd start/stop buttons drive the
   **system** manager (`systemctl ...` without `--user`, design 02 §3.9) and
   cannot see user units — manage them on the server with `systemctl --user`
   instead. Tunnels/connections are unaffected (linger keeps the instance
   resident). Use Form A if you want the desktop buttons to work.

   If the service crash-restarts, check the logs first (`journalctl -u dsh`;
   user units: `journalctl --user -u dsh`): `status=127` +
   `/usr/bin/env: 'node': No such file or directory` means the PATH line above
   doesn't include the actual node bin dir.

   `--host 127.0.0.1` (loopback binding) is deliberate: the chamber desktop
   reaches the instance through its own SSH tunnel, adding no extra attack
   surface. Only change it to `--host 0.0.0.0` to reach port 30800 from other
   machines (bypassing the chamber tunnel) — and then you must pair it with
   real auth (v1 instances are anonymous) or put a reverse proxy in front.

4. **Attach from the chamber desktop** — choose a `dsh|gateway` target and an
   `ssh|http` transport (all four combinations ship), then enter its endpoint.
   SSH may carry user/port/systemd metadata and an optional password; Gateway
   independently accepts a token and/or Unicode login password, with optional
   SPKI pinning for HTTPS. Desktop owns SSH tunnels and on-demand systemd;
   main connects HTTP directly while the renderer still sees only same-origin
   proxying. See designs 03 §2.2 and 17 §9.

## Security

- **v1 has no auth boundary** — the control plane listens on loopback only (127.0.0.1); all `/api/*` routes and the per-instance proxy are anonymously reachable; HTTP/WS origins must exactly match the current Host or an explicit development allowlist, while other loopback ports and `Origin: null` are rejected
- **Transport URLs never reach the renderer; credentials are transient write-only inputs** — renderer returns, events, and projections are non-secret. Bounded exceptions ([design 05 §8](design/05-connection-manager.md), [design 17 §12](design/17-server-side-gateway.md)) keep SSH passwords in 0600 `ssh-passwords.json` schema v2 endpoint bindings and inject them through one owner-only 0700 askpass lease per real ssh child. Gateway token/password values live in `gateway-secrets.json` schema v3 target bindings (safeStorage preferred, honest 0600 fallback) and are injected only into that Gateway transport. Both are collected transiently by the form, owned by main, registry-checked before use, never returned/prefilled or persisted by the renderer, and never enter argv, logs, or the registry; nonempty unbound legacy files fail closed and require re-entry. Gateway cookie sessions are isolated by network origin, `Host` authority, and a stable connection-id-plus-target scope; generations and refresh epochs fence late login, fallback, and refresh results after invalidation. With an HTTPS SPKI pin, login, probes, and HTTP/WS proxying complete the certificate match before sending any application request byte. Add/edit/nonempty credential writes use main's `desktop_ssh_save_connection`; deletion uses exact `desktop_ssh_delete_connection(id)` (an absent id is an idempotent no-op). Legacy `instances_set` permits only the exact unchanged normalized current roster, and all three old setters are clear-only. SSH passwords remain disabled on Windows v1.
- **systemctl is spawned with an argument array** (no shell), with fixed argv `systemctl <action> -- <serviceName>` and serviceName allowlist `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` (the first character must be alphanumeric)
- **Git is not relayed through Desktop/SSH commands** — the Git host plugin runs inside each dsh instance process, under the same OS user and filesystem as the workspace authority; it exposes only fixed worktree-domain operations with `shell:false` and bounded output/time, and provides no network Git verbs such as fetch, pull, or push. Checkout during creation still honors repository filters configured by that OS user (for example Git LFS, which may access the network); the confirmation UI states this trusted boundary explicitly

## FAQ

- **Why does `pnpm run smoke` print SKIP?** — the smoke test needs a dsh install; when it can't find one it prints SKIP and exits 0. This is normal, not a failure.
- **What does a remote instance need?** — a reachable API-profile dsh target, or
  a deployed `@dsh-chamber/gateway` target. Either may use an SSH tunnel or an
  explicitly configured HTTP(S) endpoint. No separate remote web frontend is
  needed: the reused local UI reaches it through `/api/i/dsh-<id>/*` or
  `/api/i/gateway-<id>/*` same-origin proxying.
- **How do agent presets / profiles work across instances?** — per-instance authoritative. Each instance's `settings`/`credentials`/`llm`/`agentPreset` config plane lives only on that instance's side (local = this machine, remote = the far server). All reads/writes land on that instance's own API through the `/api/i/<id>/*` proxy — the new-session preset picker lists the roster of the session's owning instance and writes back to it. There is no cross-source profile matching/merging; to edit a remote preset, switch to that source's shell and use its Settings → Agent presets page.
- **Where does the frontend come from?** — the dsh official frontend, source-reused and self-built; every instance keeps its native UI.

> **Windows install stuck on "Installing" / progress bar looping**
>
> The installer bundles many dsh runtime files, and Windows Defender real-time
> protection scans each newly created file, stretching extraction to tens of
> minutes; when files are locked, the installer enters an "extract → copy
> fails → full re-extract" retry loop (progress bar fills → resets → refills,
> constant disk writes in Task Manager), looking permanently stuck. The
> packaging side is already fixed (single-pass zip extraction + hoisted flat
> layout + runtime pruning). If you still hit a hang:
>
> 1. **Quit any older dsh-chamber before installing**; if a failed/interrupted install happened before, uninstall the leftover version first (Settings → Apps → Installed apps) — a leftover old uninstaller makes the new installer loop on "waiting for the old version to uninstall".
> 2. During installation, temporarily add the installer and the install directory (default `%LOCALAPPDATA%\Programs\dsh-chamber`) as **Windows Security → Virus & threat protection → exclusions** (or temporarily disable real-time protection and restore it after) — the fastest fix for the "hang".
> 3. You can remove the exclusions after installation.

## Documentation

| Document | Purpose |
|---|---|
| [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md) | Development: architecture/setup/build/package/CI/release/repo layout |
| [CONTRIBUTING.en-US.md](CONTRIBUTING.en-US.md) | Contribution guide (testing/commits/PR contract) |
| [AGENTS.md](../AGENTS.md) | Development constraints (always-on repository rules) |
| [CHANGELOG.en-US.md](CHANGELOG.en-US.md) | Version history |
| [design/01-overview.md](design/01-overview.md) | Design entry point: consolidation principles, scope, removals |
| [design/05-connection-manager.md](design/05-connection-manager.md) | Surface/architecture contract (v1) |
| [progress/STATUS.md](progress/STATUS.md) | Completion status, remaining deviations & validation record |
| [README.md](../README.md) | 中文 README |

## Related projects

- [deepseek-harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) — the managed host
- [OpenChamber](https://github.com/openchamber/openchamber) — the multi-instance session model that inspired dsh-chamber's N-ctx design and its name; thanks for the inspiration!

## Contributing

See [CONTRIBUTING.en-US.md](CONTRIBUTING.en-US.md). Development constraints live in [AGENTS.md](../AGENTS.md); environment setup and builds are in [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md).

## License

MIT — see [LICENSE](../LICENSE).
