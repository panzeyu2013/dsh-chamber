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
┌ Swift 窗口（WKWebView，加载控制面 origin；Electron 归档参考）
│  └─ dsh 官方前端（源码复用）：自研侧边栏 / Git worktree 插件 / 桥接宿主 / N-ctx（每实例一壳，/api/i/<id>/* 同源）
├ 控制面（127.0.0.1:17500）
│  ├─ 管理 REST（/health、/api/connections、/api/host/logs）+ 每实例同源反代 /api/i/<id>/*
│  ├─ 本地实例托管（spawn/健康/reaper）+ host 包 seed/单一 overlay
│  └─ 静态前端服务（dist + __DSH_BOOT__ 清单）
└ 打包 Node sidecar（desktop host-assembly；Electron 归档）
   ├─ transport-manager：目标 dsh|gateway × 传输 ssh|http；远端 ready-time host 包分发
   └─ 实例注册表 <userData>/ssh-instances.json + IPC（preload 白名单）
```

一句话：控制面负责连接管理、每实例同源反代与静态前端服务；渲染层是dsh官方前端源码复用自建（单窗口单frame、N-ctx多实例）；桌面壳以 `dsh|gateway`×`ssh|http` 接入远程实例；显式启动的gateway在默认认证的公网边界后复用同一宿主核心。

Git worktree由chamber-bundled client插件与每实例内host插件配对（P5b：工作树是源仓库内 `.agents/worktrees` 的 checkout，官方 forge bundle 与本插件共用同一个池）；控制面/桌面只分发host包并挂loader row，不解析Git事实、不经SSH执行Git。

设计权威在 `docs/design/`（入口 [INDEX.md](./design/INDEX.md)，总览 01-overview；05 为 v1 表面/架构契约）；全局文档地图在 [docs/INDEX.md](./INDEX.md)。包职责与约束在 `AGENTS.md`「Runtime Boundaries」——本文件只做一行级导航。

包职责、边界与约束的唯一家是根 [`AGENTS.md`](../AGENTS.md)「Runtime Boundaries」；各包契约见 `packages/*/README.md`。本文件不复制包表，只保留上面的架构图。

## 2. 环境搭建

### 2.1 要求

- Node.js 版本须满足 `package.json` 的 `engines.node`（推荐值见 `.nvmrc`；CI 镜像同一版本；TypeScript 源码经 Node 原生类型擦除直接运行）
- macOS + Swift/Xcode：`build:swift-app` / `test:swift` 是现行出货链路，必须可构建（parity 门可用 `DSH_CHAMBER_SWIFT_PARITY_SKIP=1` 显式跳过）
- pnpm≥11（包管理器；锁文件 `pnpm-lock.yaml`）；git
- 发布链另需五项 Apple/Developer ID 凭据（缺项 fail-closed，见发布 checklist）
- dsh宿主可选——仅集成冒烟测试需要，未安装时自动SKIP

### 2.2 克隆与安装

```bash
git clone <REPO-URL> --recurse-submodules   # 一步物化 vendor/harness-checkout submodule
cd dsh-chamber
```

已clone而未带 `--recurse-submodules` 时用 `git submodule update --init` 物化（submodule是240包大仓库，全量拉取较慢；`--depth 1` 浅拉即可——gitlink固定commit）。

`vendor/harness-packages` 是被gitignore的符号链接目录：每个dsh包一个同名符号链接，指向固定commit的git submodule（`vendor/harness-checkout`，gitlink =上游commit，单一事实来源、无任何回退：不读环境变量、不复用兄弟检出、不从codeload下载）。它永不提交，必须在 `pnpm install` 之前建立（`pnpm-workspace.yaml` 经它解析未修改的dsh包）。`scripts/dev/bootstrap/ensure-harness-vendor.mjs` 引导：硬校验submodule HEAD == `harness.commit`（不一致即失败）、幂等差量建链（集合未变时零操作）、断言链接集合与锁文件vendor importer集合一致；`--check` 只校验不写盘。全新克隆后需在 `pnpm install` 之前运行一次：

```bash
git submodule update --init   # 物化 submodule（CI 由 checkout submodules: true 完成）
node scripts/dev/bootstrap/ensure-harness-vendor.mjs
pnpm install
```

升级上游pin**只**能走 `node scripts/upstream/pin/update-vendor.mjs <tag>`（原子流程：fetch+校验tag →切submodule →更新 `harness.commit` →差量建链→重生成锁文件→ frozen验证），不要手工改gitlink/`harness.commit`。`pnpm-workspace.yaml` 设 `verifyDepsBeforeRun: false`：pnpm run不再隐式install（防非frozen install改写锁文件），依赖变更须显式 `pnpm install`；CI在frozen install后另有 `git diff --exit-code -- pnpm-lock.yaml` 漂移断言。

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

> 平台排障（安装/权限）见 README「常见问题」；Windows/Linux 桌面腿随 Electron 冻结（不发布、不排期），冻结前支持矩阵与复活基线见 [progress/electron-frozen.md](./progress/electron-frozen.md) §6 与 design 23（ARCHIVED）。

## 5. CI 与发布

> **（Electron 冻结，2026-11）** 现行 CI = `ci.yml` 的 `test` / `test-macos` / `test-macos-pack`；现行发布 = `release.yml` 的 `build-swift` + `build-gateway`（三条 Electron 发布腿为 job 级恒 false 条件、恒 skipped）。门禁落位与 job 名单以 [release-checklist.md](./checklists/release/release-checklist.md)、[.github/workflows/](../.github/workflows) 与 `scripts/gates/registry/gate-surfaces.json` 为准，本文件不复制。

- `.github/workflows/ci.yml`：分支 push/PR 跑验证链（代码变更全跑；纯文档只跑 file-only 门，判类器 `scripts/gates/registry/classify-ci-changes.mjs`）；macOS 腿 `test-macos`（Swift 构建/测试）与 `test-macos-pack`（`test:macos` + compiled sidecar / native GUI 装配）在 macos-latest 跑。
- `.github/workflows/release.yml`：`v*` tag 或手动触发产出可分发版本（仅 stable `X.Y.Z` 与 beta `X.Y.Z-beta.N`）；发布正文 = `CHANGELOG.md` 的 `## [<version>]` 段；`validation` 跑 `scripts/release/preflight/verify-release-ci-proof.mjs` 证明该提交在 `main` 上有成功 `ci.yml` 运行；`build-gateway` 发布经干净前缀冒烟的 `.tgz` 与同名 `.sha256`。
- 发布机械门禁：`pnpm run release:preflight <版本>`（版本统一性、changelog 双语、i18n、actions SHA、冲突标记、git 干净、frozen install、test:release-workflow）；commit 前与 push 前各跑一次（发布 checklist §2/§7）。
- 发布流程：本地 preflight + 精确提交全量套件 → commit+tag → `workflow_dispatch` dry-run（新增/修改的 workflow、脚本路径、action SHA 必须先过一次）→ 正式 tag push；详细步骤与 proof/判类口径见发布 checklist。
- 两个 workflow 均在 install 前按 `harness.commit` 引导 vendor；`ci.yml` 以 `concurrency` 串行化同 ref 的推送，`release.yml` 不取消可能已建 draft 的发布。

## 6. 仓库结构

```
packages/   各包（清单与职责归属 = packages/ 目录 + 根 AGENTS.md「Runtime Boundaries」；契约 = 各包 README）
docs/       INDEX.md 全局地图；AGENTS.md 文档标准；design/ checklists/ progress/ deploy/
scripts/    dev/ gates/ release/ upstream/ perf/ gui-acceptance/ 与 install-gateway.sh（分类与接线见 scripts/README.md）
vendor/     harness-packages/（@deepseek-ai/* 符号链接树）→ harness-checkout/（dsh submodule，gitlink = pin）
```

## 7. 脚本

脚本清单以根 [`package.json`](../package.json) 的 `scripts` 为准（本文件不复制）；按改动面选门见 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 与 [`docs/AGENTS.md`](./AGENTS.md) §5，构建/发布链见 §4–§5。

## 8. 文档导航

文档清单与用途以 [docs/INDEX.md](./INDEX.md) 为唯一入口（本文件不手抄文档表）。
