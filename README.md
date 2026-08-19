# dsh-chamber（中文说明）

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-brightgreen)]()

**[dsh](https://github.com/deepseek-ai/deepseek-harness) 的本地桌面连接管理器。**

## 用户界面

![dsh-chamber 用户主界面](assets/page.png)

*用户主界面——单窗口，dsh 原生侧边栏平等列出各来源（本地 + 远程实例）的 session/workspace，主区为活动实例的纯 dsh shell。*

dsh-chamber 托管本地 dsh 实例（web profile），并经 SSH 隧道接入远程服务器上的 dsh 实例。界面 = **dsh 官方前端源码复用自建**——单窗口单 frame，多实例以 N-ctx shell 共存，**各来源的 session/workspace 在 dsh 原生侧边栏内统一导航**（首屏 = 本地实例的完整 dsh shell，纯 dsh UI）。控制面负责连接管理、每实例同源反代与静态前端服务（**v1 无认证/审计面**）。

> [!WARNING]
> **开发者预览（v0.1）**——协议与 API 正在快速迭代，将存在破坏性变更。

> English: [docs/README.en-US.md](docs/README.en-US.md) · 设计文档入口 [docs/design/01-overview.md](docs/design/01-overview.md) · 表面/架构契约 [docs/design/05-connection-manager.md](docs/design/05-connection-manager.md) · 模块进度 [docs/progress/STATUS.md](docs/progress/STATUS.md)

## dsh-chamber 是什么？

dsh harness 的设计哲学是**一切皆插件**：模型适配器、工具注册表、会话日志、agent loop、官方 Web UI 本身都是宿主插件；goals、jobs、terminals、schedule、settings、pluginInventory 等均为宿主原生能力——承载这一切的官方前端也不例外。

因此 dsh-chamber **不做**这些领域的第二套实现，也**不写**第二套界面。它只承担宿主插件**结构性做不到**的五件事：

| # | 核心职责 | 为什么插件做不到 |
|---|---|---|
| 1 | **本地宿主托管**：web profile spawn/就绪/reaper/健康/日志 | "管理 dsh 自己"是鸡生蛋问题：插件随宿主进程一起死 |
| 2 | **前端宿主与每实例反代** | dsh 前端要求同源 `/api` + WS（`location.origin` 硬编码）；跨实例同源访问只能由宿主服务端提供（v1 无认证边界——实例匿名可达，仅 loopback 监听） |
| 3 | **远程实例接入**：SSH 隧道 + systemd 起停 | 跨服务器的连接编排只能存在于服务器之外 |
| 4 | **管理 REST**：连接 CRUD、健康、日志 | 管理器自己的面 |
| 5 | **多来源会话统一导航** — 一个 dsh 原生侧边栏平等列出各来源的 session/workspace | 官方 dsh 侧边栏只认识本连接；"本地+远程同等公民"的导航层必须由 chamber 侧提供（自研侧边栏插件 + 桥接层） |

**会话业务完全由 dsh 前端 runtime 承担**（每个实例一个完整 dsh shell，N-ctx 共存）：控制面不消费任何宿主帧、不建会话索引、不参与聊天/审批。

## 特性

- **dsh 官方前端源码复用自建** — 单窗口、单 frame、单 origin；唯一允许的 dsh 源码修改是六个 chamber 包：仓库内拷贝 `packages/dsh-client-connection`（连接客户端 base 路径补丁）与 `packages/dsh-client-web`（boot.tsx N-ctx 模块表共享 seam + `runtimeCtx` getter），以及自研的 `packages/dsh-chamber-client-ui-sidebar`（替换官方 ui-sidebar 注册，见 05 §6）、`packages/dsh-chamber-client-ui-settings-connections` 与 `packages/dsh-chamber-client-ui-settings-bridge`（连接设置页及其设置壳，见 05 §5）、`packages/dsh-chamber-client-ui-layout`（官方 ui-layout 壳插件的 chamber fork：仅替换 layout store——把 `sidebarWidth` 持久化进侧边栏共享 view-prefs store；替换官方 ui-layout 注册，见设计 06）
- **N-ctx 多实例** — 多个 dsh shell 共存于一个窗口（每实例一个 AppWebEntry，独立 cordis ctx、全量 ui-* 树）；chamber 侧栏切换活动 ctx
- **侧边栏多来源导航** — 各来源（本地 + 远程实例）的 session/workspace 在 dsh 原生侧边栏内平等呈现，仅按来源分组（远程来源以颜色徽标标注）；首屏 = 本地实例的完整 dsh shell（纯 dsh UI，无 chamber 外壳）
- **chamber 桥接宿主** — v1 为 entry 级 React：首屏 = 本地实例的完整 dsh shell（纯 dsh UI，无 chamber 外壳）；App 宿主负责本地实例 auto-start、注册表远程实例 auto-connect、chamberBridge 投影发布与会话打开分发；多来源导航本身由自研侧边栏插件渲染；原 `chamber-auth` 登录插件随 v1 认证/审计移除
- **本地宿主托管** — web profile spawn、就绪、reaper、健康状态机、宿主日志
- **每实例同源反代** — `/api/i/<id>/*` HTTP/WS/SSE 透传（本地与隧道实例），匿名可达（仅 loopback；无隧道 → 明确 503）
- **远程实例** — 桌面传输运行时（`transport-manager` + `ssh` provider，`TransportProvider` 接口可扩展未来来源）：SSH 隧道（`ssh -N -o ServerAlive… -L`）+ 远端 systemd `start`/`stop`/`is-active`（serviceName 白名单校验）；可选的主机密码认证（设计 05 §8）：`desktop_ssh_set_password` + 临时 askpass 助手注入（见「安全」）
- **管理 REST** — `/health`、`/api/connections`、`/api/host/logs`，另有 `__DSH_BOOT__` 启动图清单的静态前端服务
- **桌面端更新提示（设计 11）** — 内置更新检查（静默，启动延迟 + 6h 周期），设置页「更新」部分展示新版本并**用户确认后下载、退出时安装**（无弹窗低打扰）；自动更新仅替换应用本体，`userData`（注册表/状态/密码存储）天然保留；macOS 自动安装依赖 Developer ID 签名（未配置时响亮提示手动安装）
- **睡眠/后台常驻（设计 14）** — 关窗行为可设（隐藏到托盘继续运行 / 退出，退出前对活动隧道与本地实例确认）；登录自启（mac/linux）；OS 唤醒即时重连（SSE 心跳不等 watchdog）；保持唤醒开关；设置持久化于主进程 `chamber-settings.json`
- **Chamber 设置页（设计 15，v1 平铺）** — 设置壳固定入口：连接 / 通用 / 更新（chamber 全局设置与实例配置平面严格分离）

## 架构

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron 窗口（单 frame，loadURL 控制面 origin）                        │
│ └─ dsh 官方前端（源码复用）                                             │
│     ├─ 自研侧边栏插件：dsh 原生侧边栏内多来源会话导航 + chamberBridge     │
│     ├─ 桥接宿主（entry 级 React）：首屏 = 本地实例纯 dsh shell           │
│     └─ N-ctx：每实例一个 dsh shell，经 /api/i/<id>/* 同源访问            │
├───────────────────────────────────────────────────────────────────────┤
│ 控制面（127.0.0.1:17500）                                               │
│  ├─ 管理 REST：/health · /api/connections · /api/host/logs              │
│  ├─ 每实例反代：/api/i/local/* → 本地 dsh（web profile）                 │
│  │              /api/i/ssh-<id>/* → 隧道 localPort                      │
│  │              （v1 匿名可达，仅 loopback 监听）                        │
│  ├─ 本地实例托管（spawn/健康/reaper）                                    │
│  └─ 静态前端服务（dist + __DSH_BOOT__ 清单）                             │
├───────────────────────────────────────────────────────────────────────┤
│ 桌面主进程（desktop）                                                   │
│  ├─ transport-manager + ssh provider（TransportProvider 接口）          │
│  │    ssh -N -o ServerAlive… -L 隧道 + systemctl start/stop/is-active    │
│  ├─ 实例注册表：<userData>/ssh-instances.json                           │
│  └─ IPC（preload 白名单）：dsh-chamber:info · desktop_ssh_*             │
└───────────────────────────────────────────────────────────────────────┘
```

| 包 | 职责 |
|---|---|
| `packages/control-plane` | 连接管理器核心：web profile 宿主托管、管理 REST、每实例反代、静态前端服务 |
| `packages/renderer` | 自建 dsh 前端（源码复用）：入口构建、纯 dsh 首屏桥接宿主（auto-start/auto-connect、chamberBridge）、N-ctx 编排、启动图清单 |
| `packages/desktop` | Electron 壳：单 frame、transport-manager + `ssh` transport provider（隧道 + systemd exec）、实例注册表、IPC |
| `packages/cli` | CLI 薄壳（serve/status/connections/host logs） |
| `packages/dsh-client-connection` | 拷贝的 dsh 源码：连接客户端 + base 路径补丁 |
| `packages/dsh-client-web` | 拷贝的 dsh 源码：web shell + boot.tsx N-ctx 共享 seam |
| `packages/dsh-chamber-client-ui-sidebar` | 自研（拷贝 ui-sidebar 结构改造）：chamber 侧边栏插件，替换官方 ui-sidebar 注册（见 05 §6） |
| `packages/dsh-chamber-client-ui-settings-connections` | 自研：连接设置插件（本地实例卡 + 远程主机 CRUD/连接/systemd/日志，settings.section、dsh 设计 token，见 05 §5） |
| `packages/dsh-chamber-client-ui-settings-bridge` | 自研：设置壳插件，以 priority −1 shadow 官方 SettingsRoot 注册（sidebar.settings）——所选实例官方设置分区上的服务器下拉 + 固定的 chamber 全局连接导航项（见 05 §5） |
| `packages/dsh-chamber-client-ui-layout` | 自研（官方 ui-layout 壳插件的 chamber fork）：仅替换 layout store——`sidebarWidth` 经侧边栏共享 view-prefs store 播种/回写（钳位 [264,420]），替换官方 ui-layout 注册（见设计 06） |
| `packages/dsh-host-client-graph` | 自研宿主侧包（非客户端插件）：Remote `clientGraph/graph` 只读暴露宿主组合的客户端插件 boot 图（设计 09）；控制面经 `--patch` seed 进本地 web profile |

## 快速开始

### 环境要求

- Node.js 22+（推荐 LTS；源码为 TypeScript，经 Node 原生类型擦除直接运行，见 `.nvmrc`）
- pnpm ≥ 11（包管理器；锁文件 `pnpm-lock.yaml`）
- git
- macOS（`dist:desktop:mac` 打包 dmg/zip 需要）
- dsh 宿主安装为可选——只在集成冒烟测试时需要，未安装时自动 SKIP

### 1 · 克隆

```bash
git clone <REPO-URL>
cd dsh-chamber
```

### 2 · dsh 源码树（preinstall 自动引导）

`vendor/harness-packages` 是**被 gitignore 的符号链接目录**，每个 dsh 包一个符号链接——链接名即包名，指向 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码树。它永不提交，且必须在 `pnpm install` **之前**建立：`pnpm-workspace.yaml` 经它解析未修改的 dsh 包。`scripts/ensure-harness-vendor.mjs` 负责引导；全新克隆需在 `pnpm install` **之前**显式运行一次（pnpm 在 `preinstall` 之前就捕获工作区快照，仅靠 preinstall 不够）：

```bash
node scripts/ensure-harness-vendor.mjs
pnpm install
```

脚本按以下顺序解析源码树：

1. `DSH_CHAMBER_HARNESS_ROOT` 环境变量——直接使用该检出；
2. `vendor/harness-checkout`——本脚本先前下载的受管快照（其 `.harness-pin` marker 与固定提交一致时复用）；
3. 兄弟检出 `<repo>/../deepseek-harness`（零网络本地开发；HEAD 与固定提交不一致时警告）；
4. 否则从 codeload 按固定提交下载快照（固定于 `harness.commit`，可用 `DSH_CHAMBER_HARNESS_COMMIT` 覆盖）。

被排除的两个包（`dsh-client-connection`、`dsh-client-web`）是仓库内的拷贝包——它们位于 `packages/`，遮蔽 workspace 条目；其余四个被修改的源码均为自研：`packages/dsh-chamber-client-ui-sidebar`（见 05 §6）、`packages/dsh-chamber-client-ui-settings-connections` 与 `packages/dsh-chamber-client-ui-settings-bridge`（见 05 §5），以及 `packages/dsh-chamber-client-ui-layout`（ui-layout 壳 fork——`sidebarWidth` 经侧边栏共享 view-prefs store 持久化，见设计 06）。

### 3 · 安装

```bash
pnpm install
```

根目录 `.npmrc` 是 gitignored 的本地便利配置，可将 Electron 二进制下载指向 npmmirror 镜像；没有它则从官方源下载。打包期的镜像已在 `packages/desktop/package.json`（`electronDownload.mirror`）提交。

### 4 · 封装 dsh 运行时

桌面需要将官方 `@deepseek-ai/dsh` 发布包封装进 `packages/desktop/vendor/dsh`（控制面的默认 dsh workspace，优先于可选的 `ref-dsh` 源码符号链接）：

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # 用 DSH_CHAMBER_DSH_VERSION 固定版本
```

`bundle:dsh` 也会由 `build:desktop` / `dist:desktop:mac` 自动执行——可直接跳到运行或打包步骤。

### 5 · 运行

```bash
pnpm run dev:control-plane   # 仅控制面——http://127.0.0.1:17500（管理 REST + 静态前端）
pnpm run dev:desktop         # 完整窗口：控制面 + dsh 前端 + 桌面壳
```

### 6 · 打包应用

```bash
pnpm run dist:desktop:mac    # build:renderer → build:control-plane → build:preload → bundle:dsh → electron-builder
pnpm run dist:desktop:win    # 同一条链，但须在 Windows 上运行——dsh 运行时封装按平台区分
```

打包产物在 `packages/desktop/release/` 下（electron-builder `directories.output`）：macOS 产出 `dsh-chamber-<version>-<arch>.dmg`；Windows 产出 NSIS 安装器（`.exe`）。产物**未签名**——未配置 Apple 签名/公证或 Windows 代码签名证书。

> **Windows 安装卡在“正在安装”界面/进度条来回反复的排障**
>
> 安装器内置的 dsh 运行时文件数较多，Windows Defender 实时防护会对每个新建文件
> 扫描，把解压拖到几十分钟；文件被锁时安装器还会进入“解压→拷贝失败→整体重解压”
> 的重试循环（进度条走满→清零→重走、任务管理器持续写盘），看起来就像永远卡死。
> 打包侧已做修复（zip 单趟直解 + hoisted 扁平布局 + 运行时裁剪，见
> `docs/progress/STATUS.md`）。若仍遇到卡住：
>
> 1. 安装前**关闭旧版 dsh-chamber**；若此前有过失败/中断的安装，先在“设置 → 应用 → 已安装的应用”里卸载残留版本（残留的旧卸载器会让新安装器卡在“等待旧版本卸载”的重试循环里）。
> 2. 安装期间为安装器与安装目录（默认 `%LOCALAPPDATA%\Programs\dsh-chamber`）临时添加 **Windows 安全中心 → 病毒和威胁防护 → 排除项**（或临时关闭实时防护，装完恢复）——这是“卡死”最快的解药。
> 3. 安装完成后可移除排除项。

### 7 · CI 与发布

- `.github/workflows/ci.yml`：每次 push/PR 运行——验证链（frozen install → typecheck → i18n → 控制面单测 → smoke → renderer 构建）+ 各平台桌面打包 sanity（macOS `dist:desktop:mac` + 真实 smoke；Windows `dist:desktop:win`，`windows-2022`）。
- `.github/workflows/release.yml`：产出可分发的发布版——推送 `v*` tag（或手动运行，带版本与可选 dry-run）。先建 draft GitHub Release，构建 macOS arm64（v1 仅 Apple Silicon——最后一个公开 Intel x64 runner `macos-13` 已被 GitHub 退役，见 `docs/progress/STATUS.md`）、在 `windows-2022` 上构建 Windows x64，产物上传进 draft 后翻转公开发布。
- 两个 workflow 都在 install 之前按 `harness.commit` 固定提交引导 vendor 源码树（见第 2 节）。

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

## 脚本

| 脚本 | 说明 |
|---|---|
| `pnpm run typecheck` | strict `tsc --noEmit`（预期 0 错误） |
| `pnpm run smoke` | 集成冒烟——dsh 未安装时自动 SKIP（正常） |
| `pnpm run build:renderer` | 构建 dsh 前端 bundle（vite 构建 dsh workspace 源码） |
| `pnpm run build:desktop` | renderer + 控制面编译 + dsh 封装 |
| `pnpm run dist:desktop:mac` | 打包 macOS 应用（dmg + zip） |
| `pnpm run dist:desktop:win` | 打包 Windows 应用（nsis + zip；须在 Windows 上运行——dsh 运行时封装按平台区分） |
| `pnpm run verify:i18n` | EN ↔ 中文对漂移时报错；同步后用 `-- --write` 重新记录 |
| `pnpm run gen:notices` | 按已安装依赖树重新生成 THIRD_PARTY_NOTICES.md |
| `pnpm run cli -- <args>` | 仓库内 CLI 薄壳（serve/status/connections/host logs） |

## 安全

- **v1 无认证边界** — 控制面仅监听 loopback（127.0.0.1）；全部 `/api/*` 路由与每实例反代匿名可达，CORS 仅限回环 origin + 显式 allowlist
- **隧道 URL 与 SSH 材料不进 renderer** — renderer 只见到非秘密投影（phase/localPort），永远看不到隧道 URL 或 SSH 凭据；日志同样不含隧道/SSH 材料。唯一许可例外（[设计 05 §8](docs/design/05-connection-manager.md)）：可选的主机 SSH 密码——表单瞬时输入、主进程内存持有、镜像到 `<userData>/ssh-passwords.json`（0600、原子写）、经临时 0600 askpass 助手注入系统 ssh——永不上命令行、永不进注册表/日志、永不回传 renderer；Windows v1 门禁关闭
- **systemctl 用参数数组 spawn**（无 shell）+ serviceName 白名单（`^[a-zA-Z0-9_.-]+$`）

## 常见问题

- **`pnpm run smoke` 为什么打印 SKIP？** — 冒烟测试需要 dsh 安装；找不到时打印 SKIP 并以 0 退出。这属正常，不是失败。
- **远程实例需要什么？** — 一个 API 面 profile 的 dsh 实例 + SSH 访问。远程服务器无需安装 web 前端：UI 来自本地复用的前端，经 `/api/i/ssh-<id>/*` 隧道访问。
- **agent preset / profile 在各实例间怎么工作？** — 按实例权威。每个实例的 `settings`/`credentials`/`llm`/`agentPreset` 配置平面只存在于该实例一侧（本地 = 本机，远程 = 远端服务器）。所有读写都经 `/api/i/<id>/*` 反代落到该实例自己的 API——新会话界面的 preset 选择器列出的是该 session 所属实例的 roster，选择也写回该实例。不存在跨来源的 profile 匹配/融合；编辑远程预设 = 切到该来源的 shell，在其 设置 → Agent presets 页操作。
- **前端从哪来？** — dsh 官方前端源码复用自建；dsh 源码改动仅限六个 chamber 包（connection base 路径补丁、web N-ctx seam，以及自研侧边栏/连接设置/设置壳/ui-layout 壳插件），每个实例保持原生 UI。

## 仓库结构

```
packages/
  control-plane/            控制面：宿主托管、管理 REST、
                            每实例反代、静态前端服务
  renderer/                 自建 dsh 前端（源码复用 + 桥接宿主 + N-ctx）
  desktop/                  Electron 壳：单 frame、transport-manager + ssh provider、实例注册表、IPC
  cli/                      CLI 薄壳
  dsh-client-connection/    被修改的 dsh 源码 #1（base 路径补丁）
  dsh-client-web/           被修改的 dsh 源码 #2（boot.tsx N-ctx seam）
  dsh-chamber-client-ui-sidebar/    自研侧边栏插件：多来源会话导航 + chamberBridge
                            （拷贝 ui-sidebar 结构改造，替换官方 ui-sidebar
                            注册——05 §6）
  dsh-chamber-client-ui-layout/     自研 ui-layout 壳 fork：仅替换 layout store——
                            经侧边栏共享 view-prefs store 持久化 sidebarWidth
                            （替换官方 ui-layout 注册——设计 06）
  dsh-chamber-client-ui-settings-connections/
                            自研连接设置插件（05 §5）
  dsh-chamber-client-ui-settings-bridge/
                            自研设置壳插件：shadow 官方 SettingsRoot 注册，
                            所选实例官方设置分区上的服务器下拉（05 §5）
  dsh-host-client-graph/    自研宿主侧 host 包：Remote clientGraph/graph
                            只读暴露宿主客户端插件 boot 图（设计 09，非
                            客户端插件；控制面 seed 进本地 web profile）
docs/
  design/                   设计文档（01 为入口；05 为表面/架构契约（v1）；
                             v2 时代薄壳文档（旧 05/10）随 v4 收口移除）
  todo/                     未实现功能想法（每条一个文件，见 todo/README.md）
  progress/                 STATUS.md——唯一进度总览
vendor/
  harness-packages/         @deepseek-ai/* 符号链接树，指向 dsh 源码
                            （preinstall 引导，固定于 harness.commit）
  harness-checkout/         受管 dsh 快照（下载兜底，gitignored）
```

## 文档

| 文档 | 用途 |
|---|---|
| [docs/design/01-overview.md](docs/design/01-overview.md) | 设计入口：收拢原则、范围、移除映射 |
| [docs/design/02-host-management-deployment.md](docs/design/02-host-management-deployment.md) | 宿主托管与部署（web profile） |
| [docs/design/03-connections-proxy.md](docs/design/03-connections-proxy.md) | 连接与每实例反代 |
| [docs/design/04-control-plane-api-data.md](docs/design/04-control-plane-api-data.md) | 管理 API 与数据模型 |
| [docs/design/05-connection-manager.md](docs/design/05-connection-manager.md) | 表面与架构契约（v1） |
| [docs/design/06-sidebar-enhancements.md](docs/design/06-sidebar-enhancements.md) | 侧边栏增强（搜索 / 拖拽排序 / 视图持久化 / 运行时事实通道） |
| [docs/design/07-models-params.md](docs/design/07-models-params.md) | 模型额外参数与默认推理等级（推迟项，等待上游） |
| [docs/design/09-client-plugin-runtime-loading.md](docs/design/09-client-plugin-runtime-loading.md) | dsh 客户端插件运行时加载（已实现，2026-08 方案 A；自 docs/todo/ 移入） |
| [docs/todo/08-todo-git-worktree-plugin.md](docs/todo/08-todo-git-worktree-plugin.md) | Git worktree 插件（设计定稿，实现未排期；已移至 docs/todo/） |
| [docs/progress/STATUS.md](docs/progress/STATUS.md) | 完成状态、剩余偏差与验证记录 |
| [README.en-US.md](docs/README.en-US.md) | English README |

## 相关项目

- [deepseek-harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) — 被管理的宿主
- [OpenChamber](https://github.com/openchamber/openchamber) — dsh-chamber 的 N-ctx 多实例设计与命名灵感来源，感谢启发！

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。开发约束见 [AGENTS.md](AGENTS.md)。

## License

MIT — 见 [LICENSE](LICENSE)。
