# 远程 dsh 实例（systemd）持久化

> 从 README 移出的完整操作说明。远程服务器上的 dsh 实例推荐用 systemd
> 持久化（系统单元或 user 单元，以非 root 用户运行，所有文件落在该用户
> 自己的家目录）。服务器端部署统一入口另见
> [deploy-gateway.md](deploy-gateway.md)。

---

## 远程 dsh 实例（systemd）

远程服务器只需在 loopback 上运行 dsh 的 API 面 web profile——那里无需 web 前端：UI 来自本地复用的前端，经 `/api/i/dsh-<id>/*` 同源反代访问（这里采用 SSH transport）。

1. **环境要求** — 装有 systemd 的 Linux、Node.js 24+、运行 chamber 桌面的机器对该服务器的 SSH 访问（密钥认证：桌面传输运行时经 SSH 通道驱动 `systemctl`）。
2. **安装 dsh**（官方发行）：

   ```bash
   npm install -g @deepseek-ai/dsh
   dsh --version
   which dsh   # 记下安装路径（npm 全局，不在 /usr/bin）供下方 ExecStart 使用
   which node  # 记下 node bin 目录（nvm 托管，systemd 的 PATH 里没有）供下方 PATH 行使用
   ```

3. **用 systemd 持久化** — 两种形态任选，dsh 都以非 root 用户身份运行，
   所有文件都落在该用户自己的家目录。dsh 默认 `$HOME/.dsh`，因此完全
   不需要设置 DSH_HOME。

   **形态 A —— 系统单元（推荐）。** 创建 `/etc/systemd/system/dsh.service`
   （root 只在安装单元时用一次）：

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
   # 上面 `which node` 的目录（如 /home/<你的用户名>/.nvm/versions/node/v24.20.0/bin）。
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

   **形态 B —— 用户单元（完全无需 root）。** 服务器上没有 root（或不想
   申请）时，systemd 用户单元同样能持久化 dsh。创建
   `~/.config/systemd/user/dsh.service`——单元形状相同，只是没有
   `User=` 行（以你自己身份运行），`WantedBy=default.target`：

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

   创建和管理 `--user` 单元不需要 root；但**没有 linger 时**，用户管理器
   （连同你的服务）会在登出时停止。`loginctl enable-linger` 让它在开机时
   启动、登出后继续运行。

   **归属规则。** dsh 把所有文件写到单元运行用户自己的家目录（默认
   `~/.dsh`）——该用户只需要有真实的家目录即可。不需要 mkdir、不需要
   chown，"root 写的文件我的用户读不了"的问题根本不会出现。运行账号三选一：

   - **你的登录用户**（形态 A）：`User=<你的用户名>`，家目录本就是你的。
   - **专用服务账号**（更安全）：建号时带上家目录——
     `sudo useradd --system --create-home dsh`（注意：`useradd --system`
     默认**不创建**家目录，必须加 `--create-home`）——然后设
     `User=dsh` / `Group=dsh`，dsh 使用该账号自己的 `~/.dsh`。
   - **root**：可行但**不推荐**——dsh 会写到 `/root/.dsh`，归 root 所有，
     你的用户不可读。

   **形态 B 的注意点**：chamber 桌面的 systemd 起停按钮驱动的是**系统**
   管理器（`systemctl ...` 不带 `--user`，设计 02 §3.9），看不到用户单元——
   请在服务器上改用 `systemctl --user` 管理。隧道/连接本身不受影响
   （linger 保证实例常驻）。若希望桌面按钮可用，请用形态 A。

   若服务崩溃重启，先看日志（`journalctl -u dsh`；用户单元用
   `journalctl --user -u dsh`）：`status=127` + `/usr/bin/env: 'node': No
   such file or directory` 说明上面的 PATH 行没包含实际的 node bin 目录。

   `--host 127.0.0.1`（loopback 绑定）是刻意为之：chamber 桌面经自身 SSH
   隧道访问实例，不额外暴露攻击面。只有想从其他机器直接访问 30800（绕过
   chamber 隧道）时才需改成 `--host 0.0.0.0`——且必须配套真实鉴权（v1
   实例是匿名的），或改用反向代理前置。

4. **从 chamber 桌面接入** — 在连接设置页选择目标 `dsh|gateway` 与传输
   `ssh|http`（四组合均支持），填写目标端点；SSH 可配 user/SSH 端口/systemd
   服务与可选密码，Gateway 可独立配置 token 和/或 Unicode 登录密码，HTTPS 可选
   SPKI pin。SSH 形态由桌面接管 `ssh -N -L` 与按需 systemd；HTTP 形态由主进程
   直连，renderer 始终只见同源反代。单元形态遵循设计 02 §3.9，完整契约见
   03 §2.2 / 17 §9。

---

## English version

> Extracted from the README. For a dsh instance on a remote server, systemd is
> the recommended way to persist it (system or user unit, running as a non-root
> user with all files in that user's own home). The server-side deployment
> entry point is [deploy-gateway.md](deploy-gateway.md).

## Remote dsh instance (systemd)

The remote server only needs the dsh API-side web profile on loopback — no web frontend there: the UI comes from the locally reused frontend through the `/api/i/dsh-<id>/*` same-origin proxy (using the SSH transport in this setup).

1. **Requirements** — a systemd Linux host, Node.js 24+, and SSH access from the machine running the chamber desktop (key auth: the desktop transport runtime drives `systemctl` over the SSH channel).
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
   # the `which node` dir above (e.g. /home/<YOUR_USERNAME>/.nvm/versions/node/v24.20.0/bin).
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

