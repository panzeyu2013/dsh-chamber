# Remote dsh instance (systemd) persistence

>
> Switching to the Gateway? Existing data does not follow the managed instance automatically — after installing the gateway, run the one-time quiescent migration in [deploy-gateway.md §3](./deploy-gateway.md) so sessions/workspaces carry over.

## Remote dsh instance (systemd)

The remote server only needs the dsh API-side web profile on loopback — no web frontend: the UI
comes from the locally reused frontend through the `/api/i/dsh-<id>/*` same-origin proxy (SSH transport).

1. Requirements — a systemd Linux host, Node.js 22+, and SSH access from the chamber-desktop
machine (key auth; the desktop drives `systemctl` over SSH).
2. Install dsh (official release):

   ```bash
   npm install -g @deepseek-ai/dsh
   dsh --version
   which dsh   # note the install path (npm global, not /usr/bin) for ExecStart below
   which node  # note the node bin dir (nvm-managed, absent from systemd's PATH) for the PATH line below
 ```

3. Persist with systemd — either form runs dsh as a non-root user, files landing in its home
(default `$HOME/.dsh`; no DSH_HOME needed).

   Form A — system unit (recommended). Create `/etc/systemd/system/dsh.service` (root needed once, to install):

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

   Form B — user unit (no root at all). With no root, create `~/.config/systemd/user/dsh.service` — same shape, no `User=` line (runs as yourself), `WantedBy=default.target`:

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

   Creating/managing `--user` units needs no root; but without linger the user manager (and your service) stops at logout. `loginctl enable-linger` starts it at boot and keeps it past logout.

   Ownership rules. The running user needs only a real home directory: no mkdir, no chown, no "root wrote files my user can't read". Three accounts:

   - Your login user (Form A): `User=<YOUR_USERNAME>`, the home is already yours.
   - A dedicated service account (more secure): `sudo useradd --system --create-home dsh` (`useradd --system` does not create a home by default; `--create-home` is required), then set `User=dsh` / `Group=dsh`; dsh uses that account's own `~/.dsh`.
   - root: possible but not recommended — dsh writes to `/root/.dsh`, root-owned and unreadable by your user.

   Form B caveat: the desktop's start/stop buttons drive the system manager (`systemctl ...` without `--user`, design 02 §3.9) and cannot see user units — manage them with `systemctl --user` on the server. Tunnels are unaffected (linger keeps the instance resident); use Form A for desktop buttons.

   If the service crash-restarts, check the logs (`journalctl -u dsh`; user units `journalctl --user -u dsh`): `status=127` + `/usr/bin/env: 'node': No such file or directory` means the PATH line lacks the node bin dir.

   `--host 127.0.0.1` (loopback) is deliberate: the chamber desktop reaches the instance through its own SSH tunnel, adding no attack surface. Only change it to `--host 0.0.0.0` to reach port 30800 from other machines directly (bypassing the tunnel) — and pair it with real auth (v1 instances are anonymous) or a reverse proxy.

4. Attach from the chamber desktop — choose a `dsh|gateway` target and `ssh|http` transport (all four combinations ship) and enter the endpoint. SSH may carry user/port/systemd metadata and an optional password; Gateway independently accepts a token and/or Unicode login password, with optional SPKI pinning. Desktop owns SSH tunnels and on-demand systemd; main connects HTTP directly while the renderer sees only same-origin proxying. Designs 03 §2.2, 17 §9.
