# dsh-chamber（中文说明）

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen)]()

**[dsh](https://github.com/deepseek-ai/deepseek-harness) 的本地桌面连接管理器。**

## 用户界面

![dsh-chamber 用户主界面](assets/page.png)

*用户主界面——单窗口，dsh 原生侧边栏平等列出各来源（本地 + 远程实例）的 session/workspace，主区为活动实例的纯 dsh shell。*

> [!WARNING]
> **开发者预览（v0.1.x）**——协议与 API 正在快速迭代，将存在破坏性变更。

> English: [docs/README.en-US.md](docs/README.en-US.md) · 开发文档 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · 设计入口 [docs/design/01-overview.md](docs/design/01-overview.md) · 进度 [docs/progress/STATUS.md](docs/progress/STATUS.md)

## 快速开始

### 1 · 下载安装

从 [GitHub Releases](https://github.com/panzeyu2013/dsh-chamber/releases) 下载对应平台的安装包：

- **macOS**：`dsh-chamber-<version>-<arch>.dmg`
- **Windows**：NSIS 安装器（`.exe`）——安装慢/卡"正在安装"的排障见「常见问题」

### 2 · 打开应用

启动后**本地 dsh 实例自动托管**（web profile 自动启动/守护/健康检查），首屏即本地实例的完整 dsh 界面。

### 3 · 添加远程主机

「设置 → 连接」添加远程主机：label / host / user / SSH 端口 / dsh 端口（默认 `30800`）/ 服务名（默认 `dsh`）。其余由应用接管：自动建立 SSH 隧道 + 管理远端 systemd 服务（启动/停止/状态）。远程服务器端部署见「服务器端部署」。

### 4 · 从源码运行？

见开发文档 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 功能特性

- **本地 dsh 一键托管** — 打开即用：本地实例自动启动、就绪检测、守护/回收、健康状态与宿主日志；首屏就是本地实例的完整 dsh 界面
- **远程实例 SSH 接入** — 连接设置页添加主机后，自动建立 SSH 隧道并管理远端 systemd 服务；支持可选的主机密码认证（安全存储，见「安全」）
- **统一侧边栏多来源导航** — 本地 + 远程各实例的 session/workspace 在同一个 dsh 原生侧边栏内平等列出、按来源分组（远程来源带颜色徽标）；单击打开会话、双击重命名
- **Git Worktree 生命周期** — chamber 内建独立插件在侧边栏按实例展示仓库拓扑，并闭环创建 worktree → workspace → session；删除采用 Git-first 可重试事务，拒绝主工作树、dirty/locked/运行中目标，不归档会话、不 force、不删分支
- **多实例并行（N-ctx）** — 一个窗口内多个 dsh shell 共存，随时切换活动实例
- **Open in（Finder / VS Code）** — 会话头部一键打开对应目录：本地用 Finder
  显示/打开，本地与远程均可用 VS Code Remote-SSH 拉起（`dsh-chamber://` OS
  深链，需本机安装 VS Code）
- **桌面端更新** — 静默检查新版本，设置页「更新」展示，确认后下载、退出时安装（低打扰、无弹窗）
- **睡眠/后台常驻** — 关窗可隐藏到托盘继续运行（或退出并确认）；登录自启（mac/linux）；OS 唤醒即时重连；保持唤醒开关
- **Chamber 设置页** — 设置壳固定入口：连接 / 通用 / 更新；chamber 全局设置与各实例配置严格分离
- **后端版本容忍（rc.2 兼容）** — 实例后端 dsh 官方前端版本与 chamber 壳不同步时照常可用：壳未覆盖的额外插件行以「特性缺席」降级（绝不整 boot 崩溃），rc.2 后端已无头验证
- **安全与隐私** — 控制面仅监听 loopback（127.0.0.1）；SSH 密码 0600 权限存储、经临时 askpass 助手注入，永不进日志/注册表/界面

## 服务器端部署

### 远程 dsh 实例（systemd）

远程服务器只需在 loopback 上运行 dsh 的 API 面 web profile——那里无需 web 前端：UI 来自本地复用的前端，经 `/api/i/ssh-<id>/*` 隧道访问。

1. **环境要求** — 装有 systemd 的 Linux、Node.js 22+、运行 chamber 桌面的机器对该服务器的 SSH 访问（密钥认证：桌面传输运行时经 SSH 通道驱动 `systemctl`）。
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

4. **从 chamber 桌面接入** — 在连接设置页添加远程主机（label / host / user / SSH 端口 / dsh 端口（默认 30800）/ 服务名 `dsh`）。其余由桌面接管：`ssh -N -L` 隧道 + `systemctl start|stop|is-active dsh`（服务名白名单 `^[a-zA-Z0-9_.-]+$`）。单元形态遵循设计 02 §3.9，实例契约见 03 §2.2。

## 安全

- **v1 无认证边界** — 控制面仅监听 loopback（127.0.0.1）；全部 `/api/*` 路由与每实例反代匿名可达；HTTP/WS 来源必须与当前 Host 精确同源或命中显式开发 allowlist，其他回环端口与 `Origin: null` 均拒绝
- **隧道 URL 与 SSH 材料不进 renderer** — renderer 只见到非秘密投影（phase/localPort），永远看不到隧道 URL 或 SSH 凭据；日志同样不含隧道/SSH 材料。唯一许可例外（[设计 05 §8](docs/design/05-connection-manager.md)）：可选的主机 SSH 密码——表单瞬时输入、主进程内存持有、镜像到 `<userData>/ssh-passwords.json`（0600、原子写）、经临时 owner-only 0700 askpass 助手注入系统 ssh——永不上命令行、永不进注册表/日志、永不回传 renderer；Windows v1 门禁关闭
- **systemctl 用参数数组 spawn**（无 shell）+ serviceName 白名单（`^[a-zA-Z0-9_.-]+$`）
- **Git 不经过 Desktop/SSH 命令转发** — Git host 插件运行在每个 dsh 实例进程内，与 workspace 权威使用同一 OS 用户和文件系统；只开放固定 worktree 领域操作、`shell:false` 参数数组和有界输出/超时，不提供 fetch/pull/push 等网络 Git 动词。创建时的 checkout 仍会遵从该 OS 用户已配置的仓库 filter（例如 Git LFS，可能访问网络），确认界面会显式提示这一受信边界

## 常见问题

- **`pnpm run smoke` 为什么打印 SKIP？** — 冒烟测试需要 dsh 安装；找不到时打印 SKIP 并以 0 退出。这属正常，不是失败。
- **远程实例需要什么？** — 一个 API 面 profile 的 dsh 实例 + SSH 访问。远程服务器无需安装 web 前端：UI 来自本地复用的前端，经 `/api/i/ssh-<id>/*` 隧道访问。
- **agent preset / profile 在各实例间怎么工作？** — 按实例权威。每个实例的 `settings`/`credentials`/`llm`/`agentPreset` 配置平面只存在于该实例一侧（本地 = 本机，远程 = 远端服务器）。所有读写都经 `/api/i/<id>/*` 反代落到该实例自己的 API——新会话界面的 preset 选择器列出的是该 session 所属实例的 roster，选择也写回该实例。不存在跨来源的 profile 匹配/融合；编辑远程预设 = 切到该来源的 shell，在其 设置 → Agent presets 页操作。
- **前端从哪来？** — dsh 官方前端源码复用自建；每个实例保持原生 UI。

> **Windows 安装卡在"正在安装"界面/进度条来回反复的排障**
>
> 安装器内置的 dsh 运行时文件数较多，Windows Defender 实时防护会对每个新建文件
> 扫描，把解压拖到几十分钟；文件被锁时安装器还会进入"解压→拷贝失败→整体重解压"
> 的重试循环（进度条走满→清零→重走、任务管理器持续写盘），看起来就像永远卡死。
> 打包侧已做修复（zip 单趟直解 + hoisted 扁平布局 + 运行时裁剪）。若仍遇到卡住：
>
> 1. 安装前**关闭旧版 dsh-chamber**；若此前有过失败/中断的安装，先在"设置 → 应用 → 已安装的应用"里卸载残留版本（残留的旧卸载器会让新安装器卡在"等待旧版本卸载"的重试循环里）。
> 2. 安装期间为安装器与安装目录（默认 `%LOCALAPPDATA%\Programs\dsh-chamber`）临时添加 **Windows 安全中心 → 病毒和威胁防护 → 排除项**（或临时关闭实时防护，装完恢复）——这是"卡死"最快的解药。
> 3. 安装完成后可移除排除项。

## 文档

| 文档 | 用途 |
|---|---|
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 开发文档：架构总览/环境搭建/构建打包/CI 发布/仓库结构 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南（测试/Commit/PR 契约） |
| [AGENTS.md](AGENTS.md) | 开发约束（常驻仓库规则） |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |
| [docs/design/01-overview.md](docs/design/01-overview.md) | 设计入口：收拢原则、范围、移除映射 |
| [docs/design/05-connection-manager.md](docs/design/05-connection-manager.md) | 表面/架构契约（v1） |
| [docs/progress/STATUS.md](docs/progress/STATUS.md) | 完成状态、剩余偏差与验证记录 |
| [docs/README.en-US.md](docs/README.en-US.md) | English README |

## 相关项目

- [deepseek-harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) — 被管理的宿主
- [OpenChamber](https://github.com/openchamber/openchamber) — dsh-chamber 的 N-ctx 多实例设计与命名灵感来源，感谢启发！

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。开发约束见 [AGENTS.md](AGENTS.md)，开发环境与构建见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
