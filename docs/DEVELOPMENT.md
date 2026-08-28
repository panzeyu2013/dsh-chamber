# dsh-chamber 开发文档（Development）

> 面向**开发者**：本文件涵盖架构总览、环境搭建、运行、构建/打包、CI/发布与仓库结构。
> 用户使用见 [README.md](../README.md)，贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)，
> 常驻仓库规则见 [AGENTS.md](../AGENTS.md)，设计权威见 [docs/design/01-overview.md](design/01-overview.md)。

> English: [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md)

## 1. 架构总览

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron 窗口（单 frame，loadURL 控制面 origin）                        │
│ └─ dsh 官方前端（源码复用）                                             │
│     ├─ 自研侧边栏插件：dsh 原生侧边栏内多来源会话导航 + chamberBridge     │
│     ├─ Git worktree 客户端插件：实例内拓扑 + 安全创建/删除 saga           │
│     ├─ 桥接宿主（entry 级 React）：首屏 = 本地实例纯 dsh shell           │
│     └─ N-ctx：每实例一个 dsh shell，经 /api/i/<id>/* 同源访问            │
├───────────────────────────────────────────────────────────────────────┤
│ 控制面（127.0.0.1:17500）                                               │
│  ├─ 管理 REST：/health · /api/connections · /api/host/logs              │
│  ├─ 每实例反代：/api/i/local/* → 本地 dsh（web profile）                 │
│  │              /api/i/ssh-<id>/* → 隧道 localPort                      │
│  │              （v1 匿名可达，仅 loopback 监听）                        │
│  ├─ 本地实例托管（spawn/健康/reaper）+ 双 host 包 seed/单一 overlay       │
│  └─ 静态前端服务（dist + __DSH_BOOT__ 清单）                             │
├───────────────────────────────────────────────────────────────────────┤
│ 桌面主进程（desktop）                                                   │
│  ├─ transport-manager + ssh provider（TransportProvider 接口）          │
│  │    ssh -N -o ServerAlive… -L 隧道 + systemctl start/stop/is-active    │
│  ├─ 远端 ready-time 双 host 包分发（不经 SSH 执行 Git）                  │
│  ├─ 实例注册表：<userData>/ssh-instances.json                           │
│  └─ IPC（preload 白名单）：dsh-chamber:info · desktop_ssh_*             │
└───────────────────────────────────────────────────────────────────────┘
```

**一句话**：控制面（连接管理器核心）负责连接管理、每实例同源反代与静态前端服务；渲染层是 dsh 官方前端源码复用自建（单窗口单 frame，多实例以 N-ctx 共存）；桌面壳经 SSH 隧道接入远程实例。

Git worktree 功能由 chamber-bundled client 插件与**每实例内** host 插件配对；
控制面/桌面只分发 host 包和挂 loader row，不解析 Git 事实，也不经 SSH 执行 Git。

**设计权威**在 `docs/design/`（01 为入口，05 为 v1 表面/架构契约），**包职责明细与约束**在 `AGENTS.md`「Runtime Boundaries」——本文件只做一行级导航，不重复细节。

| 包 | 职责（一行） |
|---|---|
| `packages/control-plane` | 连接管理器核心：web profile 宿主托管、双 host 包本地 seed/overlay、管理 REST、每实例反代、静态前端服务 |
| `packages/renderer` | 自建 dsh 前端（源码复用）：入口构建、纯 dsh 首屏桥接宿主、N-ctx 编排、启动图清单 |
| `packages/desktop` | Electron 壳：单 frame、transport-manager + ssh provider（隧道 + systemd）、远端 ready-time host 包分发、实例注册表、IPC |
| `packages/cli` | CLI 薄壳（serve/status/connections/host logs） |
| `packages/gateway` | 独立认证 server 形态（design 17）：强制认证公网边界 + 单本地 dsh 反代 + 派生编排 |
| `packages/dsh-client-connection` | 官方连接客户端仓库内拷贝 + base 路径补丁 |
| `packages/dsh-client-web` | 官方 web shell 仓库内拷贝 + boot.ts N-ctx 模块表共享 seam |
| `packages/dsh-chamber-client-ui-sidebar` | 自研侧边栏插件：多来源会话导航 + chamberBridge（替换官方 ui-sidebar 注册） |
| `packages/dsh-chamber-client-ui-settings-connections` | 自研连接设置插件（本地实例卡 + 远程主机 CRUD/连接/systemd/日志） |
| `packages/dsh-chamber-client-ui-settings-bridge` | 自研设置壳插件（shadow 官方 SettingsRoot 注册，服务器下拉 + 固定连接导航项） |
| `packages/dsh-chamber-client-ui-layout` | 自研 ui-layout 壳 fork（layout store 替换，持久化 sidebarWidth） |
| `packages/dsh-chamber-client-ui-open-in` | open-in 打开注册表（design 20）：Finder/VS Code 统一打开面 |
| `packages/dsh-host-client-graph` | 宿主侧包：经 Typert Remote 只读暴露实例的客户端插件 boot 图 |
| `packages/dsh-chamber-client-ui-git` | chamber 内建 Git worktree 客户端：sidebar 座位、每实例拓扑、创建/删除 saga；不直接执行 Git |
| `packages/dsh-chamber-client-ui-open-in` | chamber 内建 open-in 客户端插件：会话头部 utilities 槽打开按钮（本地 Finder + 本地/远程 VS Code，主进程 OpenInApp 注册表 + `dsh-chamber://` 深链） |
| `packages/dsh-chamber-host-git-worktree` | 实例内 host 包：按 workspace/agent 权威校验并执行受限、本地-only Git worktree 生命周期 |

## 2. 环境搭建

### 2.1 要求

- Node.js 22+（推荐 LTS；源码为 TypeScript，经 Node 原生类型擦除直接运行，见 `.nvmrc`）
- pnpm ≥ 11（包管理器；锁文件 `pnpm-lock.yaml`）
- git
- macOS（`dist:desktop:mac` 打包 dmg/zip 需要）
- dsh 宿主安装为可选——只在集成冒烟测试时需要，未安装时自动 SKIP

### 2.2 克隆与安装

```bash
git clone <REPO-URL>
cd dsh-chamber
```

`vendor/harness-packages` 是**被 gitignore 的符号链接目录**，每个 dsh 包一个符号链接——链接名即包名，指向 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码树。它永不提交，且必须在 `pnpm install` **之前**建立（`pnpm-workspace.yaml` 经它解析未修改的 dsh 包）。`scripts/dev/ensure-harness-vendor.mjs` 负责引导；全新克隆需在 `pnpm install` **之前**显式运行一次：

```bash
node scripts/dev/ensure-harness-vendor.mjs
pnpm install
```

脚本按以下顺序解析源码树：

1. `DSH_CHAMBER_HARNESS_ROOT` 环境变量——直接使用该检出；
2. `vendor/harness-checkout`——先前下载的受管快照（`.harness-pin` marker 与固定提交一致时复用）；
3. 兄弟检出 `<repo>/../deepseek-harness`（零网络本地开发；HEAD 与固定提交不一致时警告）；
4. 否则从 codeload 按固定提交下载快照（固定于 `harness.commit`，可用 `DSH_CHAMBER_HARNESS_COMMIT` 覆盖）。

根目录 `.npmrc` 是 gitignored 的本地便利配置，本地开发可自行把 Electron 二进制下载指向镜像；正式构建配置不提交第三方 `electronDownload.mirror`，始终使用 Electron 官方源，避免镜像同时替换二进制与校验表后被正式签名。

### 2.3 封装 dsh 运行时

桌面需要将官方 `@deepseek-ai/dsh` 发布包封装进 `packages/desktop/vendor/dsh`（控制面的默认 dsh workspace，优先于可选的 `ref-dsh` 源码符号链接）：

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # 默认精确 pin；覆盖也必须是精确 semver
```

`bundle:dsh` 也会由 `build:desktop` / `dist:desktop:mac` 自动执行——可直接跳到运行或打包步骤。

## 3. 运行

```bash
pnpm run dev:control-plane   # 仅控制面——http://127.0.0.1:17500（管理 REST + 静态前端）
pnpm run dev:desktop         # 完整窗口：控制面 + dsh 前端 + 桌面壳
```

## 4. 构建与打包

```bash
pnpm run build:host-packages # 构建 host-graph + host-git-worktree 两个宿主包
pnpm run build:renderer      # 构建 dsh 前端 bundle（vite 构建 dsh workspace 源码）
pnpm run build:desktop       # 双 host 包 → renderer → 控制面/双包复制 → preload → bundle:dsh
pnpm run dist:desktop:mac    # 打包 macOS 应用（dmg + zip）
pnpm run dist:desktop:win    # 打包 Windows 应用（nsis + zip；须在 Windows 上运行——dsh 运行时封装按平台区分）
```

打包产物在 `packages/desktop/release/` 下（electron-builder `directories.output`）。发布模型（2026-08 起）：仓库未配置 Apple Developer ID / Windows Authenticode 密钥——macOS 由 afterPack 钩子（`packages/desktop/scripts/after-pack-adhoc-sign.mjs`）ad-hoc 签名（结构合法签名，Gatekeeper 宽松系统可直开，默认 Gatekeeper 需右键打开/「仍要打开」）、Windows 未签名（SmartScreen 警告，design 11 §7 记录权衡）；macOS 自动安装腿因无 Developer ID 签名被阻塞（design 11 §3.1）。若日后在 GitHub Secrets 配置 `MAC_CSC_LINK`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`/`WIN_CSC_LINK`，可恢复正式签名 + 公证发布路径。

`build:desktop` 会把两个已构建 host 包复制到
`packages/desktop/dist/host-graph-package/` 与
`packages/desktop/dist/host-git-worktree-package/`；本地控制面从这里 seed
打包态本地实例，桌面 ready-time 远端 seed 也复用同一份产物。

> Windows 安装慢/卡"正在安装"的排障（Windows Defender 逐文件扫描）见 README「常见问题」。

## 5. CI 与发布

- `.github/workflows/ci.yml`：每次 push/PR 运行——纯验证链（frozen install → 根/gateway/runtime/两个 host 包/client 插件 typecheck → i18n → 控制面/runtime/desktop/gateway/renderer/client/host 单测〔含 `test:git`、`test:host-git`〕→ **workflow action SHA 门禁**（`release-preflight --actions-only`，2026-09 起）→ smoke〔未捆绑运行时 SKIP〕→ renderer/host/desktop 子构建 → gateway 打包安装冒烟〔`pack` → 临时 prefix 安装 → `gateway --help`〕），**不产出发布包**；桌面打包与真实 smoke 验证在 `release.yml`（tag/手动触发）进行。
- `.github/workflows/release.yml`：产出可分发的发布版——推送 `v*` tag（或手动运行，带版本与可选 dry-run）。先建 draft GitHub Release，构建 macOS arm64（v1 仅 Apple Silicon）与 Windows x64，产物上传进 draft 后翻转公开发布。版本断言经 `release-preflight --versions-only` 动态覆盖根、全部非 fork chamber 包及两个 fork 基线；`CHANGELOG.md` 的 `## [<version>]` 段落被提取为发布正文（缺失会失败）。`validation` job 自验证 gateway/runtime typecheck+tests、关键 control-plane/desktop/renderer/plugin/CLI/policy 门禁；`build-gateway` 执行 gateway tgz 打包冒烟（npm 发布暂缓，2026-08 决策）。
- **发布机械门禁（2026-09 起）**：`pnpm run release:preflight <版本>`
  （`scripts/dev/release-preflight.mjs`）——版本统一性（含 fork 副本与安装器 dsh
  常量）、changelog 中英对等、i18n、**workflow action SHA 上游可解析**、冲突标记、
  git 干净、frozen install、test:release-workflow；发布 checklist §1.5/§7 强制
  commit 前与 push 前各跑一次。
- **发布流程（2026-09 优化）**：本地 preflight + 全量炮组（精确发布提交）→
  commit+tag → **workflow_dispatch dry_run 先行**（新增/修改的 workflow/脚本
  路径/action SHA 必须先 dry-run 验证过一次）→ 正式 tag push。
  详细步骤见发布 checklist。
- 两个 workflow 都在 install 之前按 `harness.commit` 固定提交引导 vendor 源码树。

## 6. 仓库结构

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
  dsh-chamber-client-ui-layout/     自研 ui-layout 壳 fork（持久化 sidebarWidth）
  dsh-chamber-client-ui-settings-connections/
                            自研连接设置插件
  dsh-chamber-client-ui-settings-bridge/
                            自研设置壳插件
  dsh-host-client-graph/    自研宿主侧 host 包（只读暴露客户端插件 boot 图）
  dsh-chamber-client-ui-git/
                            Git worktree 客户端（sidebar + coordinator + saga）
  dsh-chamber-client-ui-open-in/
                            open-in 客户端插件（会话头部 Finder/VS Code 打开）
  dsh-chamber-host-git-worktree/
                            实例内 Git worktree host Remote（权威校验 + 受限 Git）
docs/
  design/                   设计文档（01 为入口；05 为表面/架构契约（v1））
  todo/                     未实现功能想法（每条一个文件；已实现的历史设计记录
                            保留于此，见 todo/README.md）
  progress/                 STATUS.md——唯一进度总览（只记未完成/部分完成项）
  checklists/               操作清单（发布 / dsh 升级 / 打包完整性）
  *.en-US.md                各根文档的英文镜像
vendor/
  harness-packages/         @deepseek-ai/* 符号链接树，指向 dsh 源码
                            （preinstall 引导，固定于 harness.commit）
  harness-checkout/         受管 dsh 快照（下载兜底，gitignored）
```

## 7. 脚本

| 脚本 | 说明 |
|---|---|
| `pnpm run dev:control-plane` | 启动控制面（管理 REST + 静态前端），端口 17500 |
| `pnpm run dev:desktop` | Electron 壳：完整窗口（控制面 + dsh 前端 + 桌面壳） |
| `pnpm run build:renderer` | 构建 dsh 前端 bundle |
| `pnpm run build:host-graph` | 构建 host-graph 包（esbuild） |
| `pnpm run build:host-git` | 构建实例内 Git worktree host 包（esbuild） |
| `pnpm run build:host-packages` | 依次构建 host-graph 与 host-git-worktree |
| `pnpm run build:desktop` | 双 host 包 + renderer + 控制面编译/双包复制 + preload + dsh 封装 |
| `pnpm run typecheck:git` | 类型检查 Git worktree 客户端插件 |
| `pnpm run typecheck:host-git` | 类型检查实例内 Git worktree host 包 |
| `pnpm run test:git` | 运行 Git worktree 客户端插件测试 |
| `pnpm run test:host-git` | 运行 Git host core 生命周期与安全守卫测试 |
| `pnpm run dist:desktop:mac` | 打包 macOS 应用（dmg + zip） |
| `pnpm run dist:desktop:win` | 打包 Windows 应用（nsis + zip；须在 Windows 上运行） |
| `pnpm run cli -- <args>` | 仓库内 CLI 薄壳（serve/status/connections/host logs） |
| `pnpm run verify:i18n` | EN ↔ 中文对漂移时报错（同步后用 `-- --write` 重新记录） |
| `pnpm run gen:notices` | 按已安装依赖树重新生成 THIRD_PARTY_NOTICES.md（根中文 + docs/ 英文镜像） |

测试命令见 [CONTRIBUTING.md](../CONTRIBUTING.md)「测试」与「提交前验证」。

## 8. 文档导航

| 文档 | 用途 |
|---|---|
| [README.md](../README.md) | 用户使用（功能/安装/部署/FAQ） |
| 本文件 `docs/DEVELOPMENT.md` | 开发：架构/构建/打包/CI/发布 |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | 贡献流程（测试/Commit/PR 契约） |
| [AGENTS.md](../AGENTS.md) | 常驻仓库规则（包边界/约束/验证清单） |
| [CHANGELOG.md](../CHANGELOG.md) | 版本变更记录 |
| [docs/design/01-overview.md](design/01-overview.md) | 设计入口与收拢原则 |
| [docs/progress/STATUS.md](progress/STATUS.md) | 进度总览（唯一进度记录） |
| [docs/checklists/release-checklist.md](checklists/release-checklist.md) | 发布前 Checklist（版本/changelog/测试/构建/tag/CI） |
| [docs/checklists/dsh-upgrade-checklist.md](checklists/dsh-upgrade-checklist.md) | dsh 版本更新前 Checklist（pin 一致性/fork rebase/锁文件/回归） |
| [docs/checklists/packaging-closure-checklist.md](checklists/packaging-closure-checklist.md) | 打包完整性 Checklist（模块闭包 vs build.files、构建链产物、打包态冒烟） |
