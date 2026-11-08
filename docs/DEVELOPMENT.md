# dsh-chamber 开发文档（Development）

>面向开发者：涵盖架构总览、环境搭建、运行、构建/打包、CI/发布与仓库结构。
>用户使用见[README.md](../README.md)，贡献流程见[CONTRIBUTING.md](../CONTRIBUTING.md)；常驻仓库规则见[AGENTS.md](../AGENTS.md)，文档地图见[docs/INDEX.md](./INDEX.md)，设计权威见[docs/design/INDEX.md](./design/INDEX.md)（总览 [01-overview.md](./design/01-overview.md)）。

> English: [docs/DEVELOPMENT.en-US.md](./DEVELOPMENT.en-US.md)

> **版本范围（2026-11 用户裁决）**：唯一出货 flavor = macOS Swift 原生壳；Electron flavor 已冻结归档
> （文件保留、可复活；Windows/Linux 桌面腿冻结、不发布）。默认开发 / 门禁 / 发布只以 macOS Swift 与共享
> 契约为范围；下方架构图按现行形态绘制（Swift 窗口 + 打包 Node sidecar，Electron 行标归档参考），壳入口是 `macos/` +
> sidecar（`packages/desktop/sidecar-entry.ts`）。范围与复活清单见
> [progress/electron-frozen.md](./progress/electron-frozen.md)。

## 1. 架构总览

```
┌───────────────────────────────────────────────────────────────────────┐
│ Swift 窗口（WKWebView，loadURL 控制面 origin；Electron 归档参考）       │
│ └─ dsh 官方前端（源码复用）                                             │
│     ├─ 自研侧边栏插件：dsh 原生侧边栏内多来源会话导航 + chamberBridge     │
│     ├─ Git worktree 客户端插件：仓库内 checkout 行 + 创建/删除           │
│     ├─ 桥接宿主（entry 级 React）：首屏 = 本地实例纯 dsh shell           │
│     └─ N-ctx：每实例一个 dsh shell，经 /api/i/<id>/* 同源访问            │
├───────────────────────────────────────────────────────────────────────┤
│ 控制面（127.0.0.1:17500）                                               │
│  ├─ 管理 REST：/health · /api/connections · /api/host/logs              │
│  ├─ 每实例反代：/api/i/local/* → 本地 dsh（web profile）                 │
│  │              /api/i/dsh-<id>/*、/api/i/gateway-<id>/* → 已注册传输    │
│  │              （普通桌面 v1 匿名可达，仅 loopback 监听）               │
│  ├─ 本地实例托管（spawn/健康/reaper）+ 四个 host 包 seed/单一 overlay     │
│  └─ 静态前端服务（dist + __DSH_BOOT__ 清单）                             │
├───────────────────────────────────────────────────────────────────────┤
│ 打包 Node sidecar（desktop host-assembly；Electron 归档）               │
│  ├─ transport-manager：目标 dsh|gateway × 传输 ssh|http                 │
│  │    SSH 隧道/systemd 或主进程 HTTP(S)，生命周期按 generation 隔离       │
│  ├─ 远端 ready-time host 包分发（不经 SSH 执行 Git；open-in 仅本地）    │
│  ├─ 实例注册表：<userData>/ssh-instances.json                           │
│  └─ IPC（preload 白名单）：dsh-chamber:info · desktop_ssh_*             │
└───────────────────────────────────────────────────────────────────────┘
```

一句话：控制面负责连接管理、每实例同源反代与静态前端服务；渲染层是dsh官方前端源码复用自建（单窗口单frame、N-ctx多实例）；桌面壳以 `dsh|gateway`×`ssh|http` 接入远程实例；显式启动的gateway在默认认证的公网边界后复用同一宿主核心。

Git worktree由chamber-bundled client插件与每实例内host插件配对（P5b：工作树是源仓库内 `.agents/worktrees` 的 checkout，官方 forge bundle 与本插件共用同一个池）；控制面/桌面只分发host包并挂loader row，不解析Git事实、不经SSH执行Git。

设计权威在 `docs/design/`（入口 [INDEX.md](./design/INDEX.md)，总览 01-overview；05 为 v1 表面/架构契约）；全局文档地图在 [docs/INDEX.md](./INDEX.md)。包职责与约束在 `AGENTS.md`「Runtime Boundaries」——本文件只做一行级导航。

包职责、边界与约束的唯一家是根 [`AGENTS.md`](../AGENTS.md)「Runtime Boundaries」；各包契约见 `packages/*/README.md`。本文件不复制包表，只保留上面的架构图。

## 2. 环境搭建

### 2.1 要求

- Node.js 24+（推荐LTS；TypeScript源码经Node原生类型擦除直接运行，见 `.nvmrc`）
- macOS + Swift/Xcode：`build:swift-app` / `test:swift` 是现行出货链路，必须可构建（parity 门可用 `DSH_CHAMBER_SWIFT_PARITY_SKIP=1` 显式跳过）
- pnpm≥11（包管理器；锁文件 `pnpm-lock.yaml`）
- git
- 发布链另需五项 Apple/Developer ID 凭据（缺项 fail-closed，见发布 checklist）
- dsh宿主可选——仅集成冒烟测试需要，未安装时自动SKIP

### 2.2 克隆与安装

```bash
git clone <REPO-URL> --recurse-submodules   # 一步物化 vendor/harness-checkout submodule
cd dsh-chamber
```

已clone而未带 `--recurse-submodules` 时用 `git submodule update --init` 物化（submodule是240包大仓库，全量拉取较慢；`--depth 1` 浅拉即可——gitlink固定commit）。

`vendor/harness-packages` 是被gitignore的符号链接目录：每个dsh包一个同名符号链接，指向固定commit的git submodule（`vendor/harness-checkout`，gitlink =上游commit，单一事实来源、无任何回退：不读环境变量、不复用兄弟检出、不从codeload下载）。它永不提交，必须在 `pnpm install` 之前建立（`pnpm-workspace.yaml` 经它解析未修改的dsh包）。`scripts/dev/ensure-harness-vendor.mjs` 引导：硬校验submodule HEAD == `harness.commit`（不一致即失败）、幂等差量建链（集合未变时零操作）、断言链接集合与锁文件vendor importer集合一致；`--check` 只校验不写盘。全新克隆后需在 `pnpm install` 之前运行一次：

```bash
git submodule update --init   # 物化 submodule（CI 由 checkout submodules: true 完成）
node scripts/dev/ensure-harness-vendor.mjs
pnpm install
```

升级上游pin**只**能走 `node scripts/upstream/update-vendor.mjs <tag>`（原子流程：fetch+校验tag →切submodule →更新 `harness.commit` →差量建链→重生成锁文件→ frozen验证），不要手工改gitlink/`harness.commit`。`pnpm-workspace.yaml` 设 `verifyDepsBeforeRun: false`：pnpm run不再隐式install（防非frozen install改写锁文件），依赖变更须显式 `pnpm install`；CI在frozen install后另有 `git diff --exit-code -- pnpm-lock.yaml` 漂移断言。

`.npmrc` 是 gitignored 的本地配置；正式构建不提交第三方镜像，始终使用官方源（Electron 归档面的本地镜像仅调试用，见 [progress/electron-frozen.md](./progress/electron-frozen.md)）。

### 2.3 封装 dsh 运行时

桌面将官方 `@deepseek-ai/dsh` 发布包封装进 `packages/desktop/vendor/dsh`（控制面默认dsh workspace，优先于可选的 `ref-dsh` 源码符号链接）：

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # 默认精确 pin；覆盖也必须是精确 semver
```

`bundle:dsh` 也由 `build:desktop` 自动执行；可直接跳到运行或打包。

## 3. 运行

> **（Electron 冻结，2026-11）** `pnpm run dev:desktop` 已从默认脚本面移除；现行开发面 = `pnpm run dev:control-plane`
> 与 macOS Swift 壳构建链（`build:sidecar` → `build:swift-app`）。下列 Electron dev 命令保留为复活参考。

```bash
pnpm run dev:control-plane   # 仅控制面——http://127.0.0.1:17500（管理 REST + 静态前端）
# ARCHIVED（Electron 冻结）：pnpm run dev:desktop   # 完整窗口：控制面 + dsh 前端 + 桌面壳
```

## 4. 构建与打包

> **（Electron 冻结，2026-11）** `dist:desktop:*`（dmg/zip/NSIS）已从默认脚本面移除、不再产出；
> `build:desktop` 仍现行（Swift sidecar 复用其 control-plane / renderer / host 包产物，且不再含 preload 步骤）。

```bash
pnpm run build:host-packages # 构建 host-graph / host-git-worktree / host-archive-cleanup / host-open-in 四个宿主包
pnpm run build:renderer      # 构建 dsh 前端 bundle（vite 构建 dsh workspace 源码）
pnpm run build:desktop       # host 包 → renderer → 控制面/host 包复制 → bundle:dsh（Electron preload 步骤已随冻结移除）
# ARCHIVED（Electron 冻结）：
# pnpm run dist:desktop:mac  # 打包 macOS 应用（dmg + zip）
# pnpm run dist:desktop:win  # 打包 Windows 应用（仅 nsis；须在 Windows 上运行）
```

现行 Swift 产物在 `macos/release/`（`.app` + dmg/zip + appcast；`.github/workflows/release.yml` 调 `build:swift-app --out macos/release`）。正式发布须五项 Apple/Developer ID 凭据（缺项在任何 Release 变更前 fail-closed），并过 Developer ID 签名、公证、stapler、spctl；`workflow_dispatch dry_run` 即使配置正式 secrets 也清空签名/公证环境与 `GH_TOKEN`（`--publish=never`，不创建/修改 Release、不上传资产）。Electron 的 `packages/desktop/release/` 为归档参考。

`build:desktop` 把已构建的host包（client-graph/git-worktree/archive-cleanup/open-in）复制到 `packages/desktop/dist/host-*-package/`；本地控制面由此seed打包态本地实例，桌面ready-time远端seed复用同一产物（open-in为 `localOnly`，只进本地seed，不进远端/gateway）。

> 平台排障（安装/权限）统一见 README「常见问题」；Windows 桌面腿已冻结，不再维护专属排障。

> Windows/Linux 桌面腿已随 Electron 冻结（不发布、不排期）；冻结前支持矩阵与复活基线见 [progress/electron-frozen.md](./progress/electron-frozen.md) §6 与 design 23（ARCHIVED）。

## 5. CI 与发布

> **（Electron 冻结，2026-11）** 现行 CI = `ci.yml` 的 `test` / `test-macos` / `test-macos-pack`；现行发布 = `release.yml` 的 `build-swift` + `build-gateway`（三条 Electron 发布腿为 job 级恒 false 条件、恒 skipped）。门禁落位与 job 名单以 [release-checklist.md](./checklists/release/release-checklist.md)、[.github/workflows/](../.github/workflows) 与 `scripts/gates/gate-surfaces.json` 为准，本文件不复制。

- `.github/workflows/ci.yml`：分支 push/PR 跑验证链（代码变更全跑；纯文档只跑 file-only 门，判类器 `scripts/gates/classify-ci-changes.mjs`）；macOS 腿 `test-macos`（Swift 构建/测试）与 `test-macos-pack`（`test:macos` + compiled sidecar / native GUI 装配）在 macos-latest 跑。
- `.github/workflows/release.yml`：`v*` tag 或手动触发产出可分发版本（仅 stable `X.Y.Z` 与 beta `X.Y.Z-beta.N`）；发布正文 = `CHANGELOG.md` 的 `## [<version>]` 段；`validation` 跑 `scripts/release/verify-release-ci-proof.mjs` 证明该提交在 `main` 上有成功 `ci.yml` 运行；`build-gateway` 发布经干净前缀冒烟的 `.tgz` 与同名 `.sha256`。
- 发布机械门禁：`pnpm run release:preflight <版本>`（版本统一性、changelog 双语、i18n、actions SHA、冲突标记、git 干净、frozen install、test:release-workflow）；commit 前与 push 前各跑一次（发布 checklist §2/§7）。
- 发布流程：本地 preflight + 精确提交全量套件 → commit+tag → `workflow_dispatch` dry-run（新增/修改的 workflow、脚本路径、action SHA 必须先过一次）→ 正式 tag push；详细步骤与 proof/判类口径见发布 checklist。
- 两个 workflow 均在 install 前按 `harness.commit` 引导 vendor；`ci.yml` 以 `concurrency` 串行化同 ref 的推送，`release.yml` 不取消可能已建 draft 的发布。

## 6. 仓库结构

```
packages/
  control-plane/ renderer/ desktop/ cli/ gateway/ dsh-runtime/
  dsh-client-connection/ dsh-client-web/ dsh-api-gateway/
  dsh-chamber-client-core/ dsh-chamber-wire/ dsh-stream-state/
  dsh-chamber-client-ui-*/ dsh-chamber-seed-*/
                            每个包的职责、边界、主要模块、测试入口与已知限制见包 README；
                            包清单以 packages/ 目录为准，职责归属见根 AGENTS.md「Runtime Boundaries」
docs/
  INDEX.md                  全局文档地图（所有文档的唯一入口）
  AGENTS.md                 文档标准（类型 / 放置 / 写作 / 流程）
  design/                   INDEX.md（领域 × 状态 × owner）+ 01-overview.md 总览
                            + 领域目录（runtime/ control-plane/ gateway/ client/ desktop/ plugins/ archive/）
                            + decisions/（ADR：背景 / 决定 / 被否方案 / 后果）
  checklists/               README.md 阶段矩阵（唯一阶段清单）+ release/ upgrade/ acceptance/
  progress/                 STATUS.md 唯一进度记录；TODO.md；deviations.md；electron-frozen.md；README.md 规则
  deploy/                   Gateway 部署 / 远程 dsh 实例持久化
  *.en-US.md                各根文档的英文镜像
scripts/
  install-gateway.sh        Gateway 一键安装器（用户/运维面；入口 docs/deploy/deploy-gateway.md）
  dev/                      开发期工具链（安装引导 / typecheck 垫片 / 测试 loader 桩 / test-support）
  gates/                    每次 push 的仓库门（run-checks 单入口 + verify-* + CI 判类 + workflow 门）
  release/                  发布链（release-preflight/semver/artifacts + 工作流策略 + 打包清单锁步）
  upstream/                 上游 pin 与触点（update-vendor / pin 预检 / registry.json 单一来源与生成视图 /
                            触点门全量 / 符号锚与遗留锚预算门 / C8 产物门）
  perf/                     性能实测工具箱（boot/switch/eval/measure-ui/disk-walk + data/）
  gui-acceptance/           GUI 验收工具箱（probe/walkthrough/mobile-walkthrough/checks）
                            （分类规则与接线纪律见 scripts/README.md）
vendor/
  harness-packages/         @deepseek-ai/* 符号链接树，指向 submodule 内的 dsh 源码
                            （preinstall 引导，gitlink 固定于 harness.commit）
  harness-checkout/         dsh 源码 git submodule（固定 commit，gitlink 即 pin）
```

## 7. 脚本

脚本清单以根 [`package.json`](../package.json) 的 `scripts` 为准（本文件不复制）；按改动面选门见 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 与 [`docs/AGENTS.md`](./AGENTS.md) §5，构建/发布链见 §4–§5。

## 8. 文档导航

|文档|用途|
|-|-|
|[README.md](../README.md)|用户使用（功能/安装/部署/FAQ）|
|本文件 `docs/DEVELOPMENT.md`|开发：架构/构建/打包/CI/发布|
|[CONTRIBUTING.md](../CONTRIBUTING.md)|贡献流程（测试/Commit/PR契约）|
|[AGENTS.md](../AGENTS.md)|常驻仓库规则（Purpose/Hard Facts/执行流/包职责）|
|[docs/AGENTS.md](./AGENTS.md)|文档标准（分层/写作/篇幅预算/文档门/评审检查表）|
|[.agents/skills/](../.agents/skills)|可复用工作流：chamber-doc / chamber-pre-push / chamber-code-review|
|[CHANGELOG.md](../CHANGELOG.md)|版本变更记录|
|[docs/INDEX.md](./INDEX.md)|**全局文档地图**：入口 / 设计 / 清单 / 进度 / 运维的唯一导航|
|[docs/design/INDEX.md](./design/INDEX.md)|设计索引（领域 × 状态 × owner；总览 [01-overview.md](./design/01-overview.md)）|
|[docs/design/decisions/README.md](./design/decisions/README.md)|跨域决策记录（ADR）|
|[docs/progress/README.md](./progress/README.md)|进度体系规则（STATUS / TODO / deviations / electron-frozen 的所有权与写法）|
|[docs/progress/STATUS.md](./progress/STATUS.md)|进度总览（唯一进度记录；开放项 / 判据 / 指针）|
|[docs/progress/electron-frozen.md](./progress/electron-frozen.md)|Electron 冻结登记（范围 / 归档清单 / 共享契约 / 禁用面 / 复活清单）|
|[docs/checklists/README.md](./checklists/README.md)|检查清单阶段矩阵（阶段 → 门禁 → 清单入口的唯一来源）|
