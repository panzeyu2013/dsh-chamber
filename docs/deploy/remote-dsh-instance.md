# 远程 dsh 实例（systemd）持久化

> 从README移出的完整操作说明。远程dsh实例推荐用systemd持久化（系统/用户单元，非root，文件落在其家目录）。服务器端部署统一入口见 [deploy-gateway.md](deploy-gateway.md)。
>
> 改用Gateway？ 直连实例的历史数据不会自动跟随托管实例——装完gateway后按 [deploy-gateway.md §3](deploy-gateway.md) 做一次停机态迁移，旧会话 / 工作区无缝延续。

---

## 远程 dsh 实例（systemd）

远程服务器只需在loopback运行dsh的API面web profile，无需web前端：UI来自本地复用前端，
经 `/api/i/dsh-<id>/*` 同源反代访问（SSH transport）。

1. 环境要求 — systemd Linux、Node.js 22+、chamber桌面机器对该服务器的SSH访问
（密钥认证；桌面经SSH驱动 `systemctl`）。
2. 安装dsh（官方发行）：

   ```bash
   npm install -g @deepseek-ai/dsh
   dsh --version
   which dsh   # 记下安装路径（npm 全局，不在 /usr/bin）供下方 ExecStart 使用
   which node  # 记下 node bin 目录（nvm 托管，systemd 的 PATH 里没有）供下方 PATH 行使用
 ```

3. 用systemd持久化 — 两种形态任选，dsh均以非root运行、文件落在其家目录（默认 `$HOME/.dsh`，无需DSH_HOME）。

   形态A —— 系统单元（推荐）。 创建 `/etc/systemd/system/dsh.service`（root仅在装单元时用一次）：

   ```ini
   [Unit]
   Description=dsh web profile (remote instance)
   After=network.target

   [Service]
   Type=simple
   # 以你 SSH 登录的用户身份运行 dsh（把 <你的用户名> 换成实际账号）。
   # dsh 会把所有文件写到该用户自己的家目录（默认 ~/.dsh）——不需要
   # mkdir/chown，也不会有 root 属主文件。web profile 仅在 loopback 提供
   # dsh API + 前端。--port 与 --trusted-host 恒一致（127.0.0.1:<P>）：
   # 浏览器信任栅栏只认 chamber 隧道转发来的 Host 头（`dsh web` 是
   # `--profile web` 的硬别名，两者等价）。将 <DSH_PATH> 换成上面
   # `which dsh` 的路径 —— npm 全局安装位于用户的 npm prefix 下
   # （如 /usr/local/bin/dsh），不是 /usr/bin。
   User=<你的用户名>
   ExecStart=<DSH_PATH> --profile web --host 127.0.0.1 --port 30800 --trusted-host 127.0.0.1:30800
   Restart=on-failure
   RestartSec=3
   # dsh 是 node 脚本（shebang 为 `#!/usr/bin/env node`），而 systemd 默认
   # PATH 不含 nvm 的 node → 服务会以 status=127 崩溃重启（日志：
   # "/usr/bin/env: 'node': No such file or directory"）。将 <NODE_BIN> 换成
   # 上面 `which node` 的目录（如 /home/<你的用户名>/.nvm/versions/node/v22.22.3/bin）。
   # 注意：Environment= 是整行字面赋值、完全覆盖旧值，没有"追加到已有 PATH"
   # 的语法，ExecStart 内也不做变量展开——必须写全绝对路径。
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

   形态B —— 用户单元（完全无需root）。 无root时用用户单元：创建 `~/.config/systemd/user/dsh.service`——形状相同，没有 `User=` 行（以你自己身份运行）， `WantedBy=default.target`：

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
   # 登出后与开机后仍然存活——一次性操作，需要 root（或 polkit 授权）：
   sudo loginctl enable-linger <你的用户名>
 ```

   创建/管理 `--user` 单元不需root；无linger时用户管理器（连同服务）登出即停。 `loginctl enable-linger` 让它在开机时启动、登出后继续运行。

   归属规则。 运行用户只需有真实家目录：无需mkdir/chown，不会出现"root写的文件我的用户读不了"。账号三选一：

   - 你的登录用户（形态A）：`User=<你的用户名>`，家目录本就是你的。
   - 专用服务账号（更安全）：`sudo useradd --system --create-home dsh` 建号（`useradd --system` 默认不创建家目录，必须加 `--create-home`），再设 `User=dsh` / `Group=dsh`，dsh用其 `~/.dsh`。
   - root：可行但不推荐——dsh写到 `/root/.dsh`，归root，你的用户不可读。

   形态B的注意点：chamber桌面的systemd起停按钮驱动系统管理器（`systemctl ...` 不带 `--user`，设计02 §3.9），看不到用户单元——请在服务器上用 `systemctl --user` 管理。 隧道/连接不受影响；要用桌面按钮请用形态A。

   服务崩溃重启先看日志（`journalctl -u dsh`；用户单元 `journalctl --user -u dsh`）： `status=127` + `/usr/bin/env: 'node': No such file or directory` 说明PATH行未含实际node bin目录。

   `--host 127.0.0.1`（loopback绑定）是刻意为之：chamber桌面经自身SSH隧道访问，不额外 暴露攻击面。要从其他机器直连30800（绕过隧道）才改为 `--host 0.0.0.0`——且必须配套真实鉴权 （v1实例匿名）或反向代理前置。

4. 从chamber桌面接入 — 连接设置页选择目标 `dsh|gateway` 与传输 `ssh|http`（四组合均支持） 并填端点；SSH可配user/SSH端口/systemd服务与可选密码，Gateway可独立配置token和/或Unicode登录密码，HTTPS可选SPKI pin。SSH由桌面接管 `ssh -N -L` 与按需systemd；HTTP由 主进程直连，renderer只见同源反代。单元形态遵循设计02 §3.9，契约见03 §2.2 / 17 §9。

---

## English version

> Extracted from the README. For a remote-server dsh instance, systemd is the recommended persistence (system or user unit, non-root, files in that user's home). Server-side entry point: [deploy-gateway.md](deploy-gateway.md).
>
> Switching to the Gateway? Existing data does not follow the managed instance automatically — after installing the gateway, run the one-time quiescent migration in [deploy-gateway.md §3](deploy-gateway.md) so sessions/workspaces carry over.

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

