# 远程 dsh 实例（systemd）持久化

> 远程 dsh 实例的完整操作说明（用户面摘要见 README）。远程dsh实例推荐用systemd持久化（系统/用户单元，非root，文件落在其家目录）。服务器端部署统一入口见 [deploy-gateway.md](./deploy-gateway.md)。
>
> 文档地图：[docs/INDEX.md](../INDEX.md)；阶段矩阵与门禁入口：[docs/checklists/README.md](../checklists/README.md)。
>
> 改用Gateway？ 直连实例的历史数据不会自动跟随托管实例——装完gateway后按 [deploy-gateway.md §3](./deploy-gateway.md) 做一次停机态迁移，旧会话 / 工作区无缝延续。

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
