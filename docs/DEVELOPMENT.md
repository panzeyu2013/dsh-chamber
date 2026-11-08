# dsh-chamber 开发文档（Development）

>面向开发者：涵盖架构总览、环境搭建、运行、构建/打包、CI/发布与仓库结构。
>用户使用见[README.md](../README.md)，贡献流程见[CONTRIBUTING.md](../CONTRIBUTING.md)；常驻仓库规则见[AGENTS.md](../AGENTS.md)，设计权威见[docs/design/01-overview.md](design/01-overview.md)。

> English: [docs/DEVELOPMENT.en-US.md](DEVELOPMENT.en-US.md)

> **版本范围（2026-11 用户裁决）**：唯一出货 flavor = macOS Swift 原生壳；Electron flavor 已冻结归档
> （文件保留、可复活；Windows/Linux 桌面腿冻结、不发布）。默认开发 / 门禁 / 发布只以 macOS Swift 与共享
> 契约为范围；下方架构图中的「Electron 窗口 / 桌面主进程」按**归档参考**阅读，现行壳入口是 `macos/` +
> sidecar（`packages/desktop/sidecar-entry.ts`）。范围与复活清单见
> [progress/electron-frozen.md](progress/electron-frozen.md)。

## 1. 架构总览

```
┌───────────────────────────────────────────────────────────────────────┐
│ Electron 窗口（单 frame，loadURL 控制面 origin）                        │
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
│ 桌面主进程（desktop）                                                   │
│  ├─ transport-manager：目标 dsh|gateway × 传输 ssh|http                 │
│  │    SSH 隧道/systemd 或主进程 HTTP(S)，生命周期按 generation 隔离       │
│  ├─ 远端 ready-time host 包分发（不经 SSH 执行 Git；open-in 仅本地）    │
│  ├─ 实例注册表：<userData>/ssh-instances.json                           │
│  └─ IPC（preload 白名单）：dsh-chamber:info · desktop_ssh_*             │
└───────────────────────────────────────────────────────────────────────┘
```

一句话：控制面负责连接管理、每实例同源反代与静态前端服务；渲染层是dsh官方前端源码复用自建（单窗口单frame、N-ctx多实例）；桌面壳以 `dsh|gateway`×`ssh|http` 接入远程实例；显式启动的gateway在默认认证的公网边界后复用同一宿主核心。

Git worktree由chamber-bundled client插件与每实例内host插件配对（P5b：工作树是源仓库内 `.agents/worktrees` 的 checkout，官方 forge bundle 与本插件共用同一个池）；控制面/桌面只分发host包并挂loader row，不解析Git事实、不经SSH执行Git。

设计权威在 `docs/design/`（01为入口，05为v1表面/架构契约），包职责与约束在 `AGENTS.md`「Runtime Boundaries」——本文件只做一行级导航。

包职责、边界与约束的唯一家是根 [`AGENTS.md`](../AGENTS.md)「Runtime Boundaries」；各包契约见 `packages/*/README.md`。本文件不复制包表，只保留上面的架构图。

## 2. 环境搭建

### 2.1 要求

- Node.js 24+（推荐LTS；TypeScript源码经Node原生类型擦除直接运行，见 `.nvmrc`）
- Swift 工具链（仅 `verify:stream-state-swift-parity` 需要；缺失时该门失败，可显式 `DSH_CHAMBER_SWIFT_PARITY_SKIP=1` 跳过）
- pnpm≥11（包管理器；锁文件 `pnpm-lock.yaml`）
- git
- macOS（`dist:desktop:mac` 打包dmg/zip需要）
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

根目录 `.npmrc` 是gitignored的本地配置，开发时可把Electron二进制下载指向镜像；正式构建不提交第三方 `electronDownload.mirror`，始终使用Electron官方源，避免镜像同时替换二进制与校验表后被正式签名。

### 2.3 封装 dsh 运行时

桌面将官方 `@deepseek-ai/dsh` 发布包封装进 `packages/desktop/vendor/dsh`（控制面默认dsh workspace，优先于可选的 `ref-dsh` 源码符号链接）：

```bash
pnpm --filter @dsh-chamber/desktop run bundle:dsh   # 默认精确 pin；覆盖也必须是精确 semver
```

`bundle:dsh` 也由 `build:desktop` 自动执行（Electron 的 `dist:desktop:mac` 已随冻结移除）——可直接跳到运行或打包。

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

打包产物在 `packages/desktop/release/` 下（electron-builder `directories.output`）。正式发布的macOS腿须具备五项Apple/Developer ID凭据，缺项即在任何GitHub Release变更前fail-closed；构建后还须过Developer ID签名、公证、stapler与spctl校验，任一失败阻断draft公开finalize。`workflow_dispatch dry_run` 即使配置正式secrets也无条件清空签名/公证环境与 `GH_TOKEN`，用 `--publish=never`，不创建/修改Release、不上传资产，并由afterPack钩子产生ad-hoc签名验证包。Windows首版仍未签名（SmartScreen警告，design 11 §7的明确权衡）。

`build:desktop` 把已构建的host包（client-graph/git-worktree/archive-cleanup/open-in）复制到 `packages/desktop/dist/host-*-package/`；本地控制面由此seed打包态本地实例，桌面ready-time远端seed复用同一产物（open-in为 `localOnly`，只进本地seed，不进远端/gateway）。

> Windows 安装慢/卡"正在安装"的排障（Windows Defender 逐文件扫描）见 README「常见问题」。

### Windows 支持矩阵（design 23；**ARCHIVED：Windows 腿冻结、不发布、不排期**）

> 下表为冻结前状态，保留为复活基线；当前不排期、不发布（见 [progress/electron-frozen.md](progress/electron-frozen.md)）。

|面|状态|
|-|-|
|目标形态|Windows 11 x64,NSIS打包(`dist:desktop:win`,须在Windows上运行)|
|CI|`test-windows`(windows-2022)契约腿已定义(ci.yml);打包在release.yml `build-windows`|
|生命周期(M1)|win-probes(CIM身份/netstat/taskkill树终止)+ reaper/spawn-dsh平台自适应:代码就绪,POSIX单测绿,win32-only集成测试就位|
|运行时管理(M2a/M2b)|默认**只读**;验证态 `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1`;M2b UI翻转纪律门禁|
|桌面能力(M3)|AUMID/托盘候选收敛/preload loud失败已接;实机矩阵待执行|
|决策解锁(M4)|登录自启、深链注册、open-in本地路径、SSH密码门引导已解锁(代码);NSIS卸载Run清理include已接|
|已知限制|未签名(SmartScreen);SSH密码禁用(keys/Pageant);运行时mutation只读;0700/0600以icacls/ACL表达|
|权威记录|`docs/design/23-windows-support.md`；开放实机门禁与进度归 `docs/progress/STATUS.md`|

## 5. CI 与发布

> **（Electron 冻结，2026-11）** 现行 CI = `ci.yml` 的 `test` / `test-macos` / `test-macos-pack`
> （Windows job 已删除、Electron 打包排练已移除）；现行发布 = `release.yml` 的 `build-swift` + `build-gateway`
> （三条 Electron 发布腿以 job 级 `if: ${{ false }}` 恒 skipped + ARCHIVED 头注）。下文涉及 Electron/Windows
> 发布与「多 job 全覆盖」的表述为**冻结前形态**；复活见 [progress/electron-frozen.md](progress/electron-frozen.md) §6。

- `.github/workflows/ci.yml`：`main` 分支推送与 PR 跑验证链（纯验证，不产出发布包）。**代码变更**跑 frozen install → 根/gateway/runtime/host包/client插件 typecheck → 控制面/runtime/desktop/gateway/renderer/client/host 单测〔含 `test:git`、`test:host-git`〕→ workflow action SHA 门禁（`release-preflight --actions-only`）→ smoke〔未捆绑运行时 SKIP〕→ renderer/host/desktop 子构建 → gateway 打包安装冒烟〔`pack` → 临时 prefix 安装 → `gateway --help`〕；**纯文档变更**只跑 file-only 门（判类见下条），不跑 install/typecheck/单测/构建。macOS 腿 `test-macos`（Swift 构建/测试）与 `test-macos-pack`（darwin 锁+打包脚本套件即 `test:macos`，compiled sidecar / native GUI 装配）在 macos-latest 跑；**Windows 腿已随 Electron 冻结删除**。桌面打包与真实 smoke 在 `release.yml`（tag/手动触发）。
- `.github/workflows/release.yml`：产出可分发版本——推送 `v*` tag（或手动运行，版本输入不带 `v`，可选dry-run）。发布版本仅限canonical stable `X.Y.Z` 与beta `X.Y.Z-beta.N`，`alpha`/`rc`/其他prerelease fail closed；stable用默认desktop打包配置且只发布 `latest.yml`/`latest-mac.yml`，beta用独立 `packages/desktop/electron-builder.beta.yml` 且只发布 `beta.yml`/`beta-mac.yml`，两通道资产互斥。正式流程先建draft，构建macOS arm64（v1仅Apple Silicon）与Windows x64，完成上述macOS fail-closed校验后才翻转公开；dry-run全程零Release写入。版本断言经 `release-preflight --versions-only` 动态覆盖根、全部非fork chamber包及三个fork基线；`CHANGELOG.md` 的 `## [<version>]` 段落被提取为发布正文（缺失会失败）。`validation` job 在本地链与构建之后、第三方声明校验之前运行发布提交的 CI 证明（刻意放在重活之后：证明轮询该 SHA 的 ci.yml 运行，先做本地校验可与等待重叠；`scripts/release/verify-release-ci-proof.mjs`：该commit在 `main` 上须有一条已完成且成功的 `ci.yml` push运行，`test`、`test-macos`、`test-macos-pack` 三个job都success（Windows/Linux 桌面腿随 Electron 冻结已 ARCHIVED）（两条契约腿各自拆出一个并行的打包job：排练/装配步骤仍被证明按名字钉住，删掉或判类跳过一样红灯）；运行中有界等待，失败或未经main一律fail closed）；本地链（gateway/runtime typecheck+tests、关键control-plane/desktop/renderer/plugin/CLI/policy门禁）在它之前完成；`build-gateway` 只在GitHub Release发布经干净临时前缀安装冒烟的 `.tgz` 与同名 `.tgz.sha256`，npm publish/dist-tag延后。
- 发布机械门禁：`pnpm run release:preflight <版本>`（`scripts/release/release-preflight.mjs`）——版本统一性（含fork副本与安装器dsh常量）、changelog中英对等、i18n、workflow action SHA上游可解析、冲突标记、git干净、frozen install、test:release-workflow；发布checklist §2/§7要求commit前与push前各跑一次。
- 发布流程（优化）：本地preflight +全量测试套件（精确发布提交）→
  commit+tag→workflow_dispatch dry_run先行（新增/修改的workflow/脚本路径/action SHA必须先dry-run验证过一次）→正式tag push。详细步骤见发布checklist。
- 推送路径的判类：`ci.yml` 的linux链按事件分档——分支push/PR：纯文档变更（`docs/**`、根级prose白名单；判类器 `scripts/gates/classify-ci-changes.mjs`）只跑 file-only 门（`ci.test.pre`/`post` 生成块的全部步骤，单源见 `scripts/gates/gate-surfaces.json`：action SHA、上游触点、workflow 策略、工具单测、i18n 等（pre 块在 install 前、post 块在 install 后）；md-links/test-wiring/styles/no-dead-exports 仍是 local-only，只在本地 check:static 跑），跳过install/typecheck /单测/构建/打包冒烟与已冻结的 Windows 腿；代码变更全跑。tag push：`ci.yml` 没有tag触发（CI触发策略修订）——发布改为证明而非重跑：`release.yml` 的 `validation` 跑 `verify-release-ci-proof.mjs`，要求该提交在 `main` 上已有成功的完整 `ci.yml` 运行（linux `test`、`test-macos`+`test-macos-pack` 各腿连同其承载步都绿；Windows/Linux 腿 ARCHIVED），运行中有限等待、失败即阻断。旧形态（linux链让位、windows腿在tag上照跑）既重复windows运行，又留下漏洞——给不在 `main` 上的提交打tag会跳过整条linux链；该漏洞现由证明堵住。release.yml与ci.yml的门禁对齐契约仍由 `release-workflow-policy.test.mjs` 从ci.yml派生断言（往ci.yml加门禁而忘了release.yml会直接红灯）。判类器fail-safe：无法证明是prose一律按代码跑；prose白名单被policy test冻结，放宽须显式改该测试。
- `ci.yml` 用 `concurrency: ci-${{ github.ref }}` 串行化同ref的推送，且**只**取消PR的旧运行：分支推送排队——纯文档推送若取消前一轮，会让被跟随的代码提交失去验证（判类器已让文档推送不跑重活，但没有"零验证"档）。`release.yml` 保持 `release-publish`+`cancel-in-progress: false`，绝不取消可能已建draft的发布。
-两个workflow都在install之前按 `harness.commit` 固定提交引导vendor源码树。

## 6. 仓库结构

```
packages/
  control-plane/            控制面：宿主托管、管理 REST、
                            每实例反代、静态前端服务
  renderer/                 自建 dsh 前端（源码复用 + 桥接宿主 + N-ctx）
  desktop/                  Electron 壳：单 frame、正交目标/传输 providers、实例注册表、IPC
  cli/                      CLI 薄壳
  gateway/                  独立认证 server 形态 + 单本地 dsh + 运行时管理/凭据面板/种子注册表
  dsh-runtime/              desktop/gateway 共用的纯 Node dsh 运行时管理核心
  dsh-client-connection/    被修改的 dsh 源码 #1（base 路径补丁）
  dsh-client-web/           被修改的 dsh 源码 #2（boot.tsx N-ctx seam）
  dsh-chamber-client-core/  共享chamber客户端内核（source-only；多来源投影 / 页面级加载内核 / unary / 多路复用通道 / settings座席）
  dsh-chamber-wire/         host↔client中性wire契约（session-state / json-guards / mux-frame；零运行时依赖）
  dsh-stream-state/         纯函数、无时钟的session/stream生命周期状态（design 14 §D4）
  dsh-api-gateway/          官方api-gateway客户端半的第二实现fork（G43；按fork重放）
  dsh-chamber-client-ui-sidebar/    自研侧边栏插件：多来源会话导航 + chamberBridge
  dsh-chamber-client-ui-layout/     自研 ui-layout 壳 fork（持久化 sidebarWidth）
  dsh-chamber-client-ui-settings-connections/
                            自研连接设置插件
  dsh-chamber-client-ui-settings-bridge/
                            自研设置壳插件
  dsh-chamber-client-ui-settings-plugin-manager/
                            设置页 plugin manager section（design 05；不占侧栏面板）
  dsh-chamber-seed-client-graph/    自研宿主侧 host 包（只读暴露客户端插件 boot 图）
  dsh-chamber-client-ui-git/
                            Git worktree 客户端（sidebar + coordinator + saga）
  dsh-chamber-client-ui-open-in/
                            open-in 客户端插件（会话头部本地应用 / VS Code 打开）
  dsh-chamber-client-ui-browser/
                            远端浏览器客户端插件（右栏内嵌 iframe 浏览器：上游 ui-sidebar-browser 的忠实 fork；非 seed）
  dsh-chamber-seed-open-in/
                            实例内 open-in host Remote（本机应用目录 + 图标 + 拉起；仅本地形态）
  dsh-chamber-seed-git-worktree/
                            实例内 Git worktree host Remote（权威校验 + 受限 Git）
  dsh-chamber-seed-archive-cleanup/
                            实例内归档清理 host Remote（design 24）
docs/
  design/                   设计文档（01 为入口；05 为表面/架构契约（v1））
  progress/                 STATUS.md——唯一进度记录；TODO.md——未排期计划（A 上游/B 平台/C 功能/D 工程）；
                            deviations.md——双 flavor 偏差
  checklists/               操作清单（发布 / dsh 升级 / 打包完整性 / GUI 验收 / 远端浏览器 / 会话权威校准 / 上游触点）
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

脚本清单以根 [`package.json`](../package.json) 的 `scripts` 为准（本文件不复制）；按改动面选门见 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 与 [`docs/AGENTS.md`](AGENTS.md) §5，构建/发布链见 §4–§5。

## 8. 文档导航

|文档|用途|
|-|-|
|[README.md](../README.md)|用户使用（功能/安装/部署/FAQ）|
|本文件 `docs/DEVELOPMENT.md`|开发：架构/构建/打包/CI/发布|
|[CONTRIBUTING.md](../CONTRIBUTING.md)|贡献流程（测试/Commit/PR契约）|
|[AGENTS.md](../AGENTS.md)|常驻仓库规则（Purpose/Hard Facts/执行流/包职责）|
|[docs/AGENTS.md](AGENTS.md)|文档标准（分层/写作/篇幅预算/文档门/评审检查表）|
|[.agents/skills/](../.agents/skills/)|可复用工作流：chamber-doc / chamber-pre-push / chamber-code-review|
|[CHANGELOG.md](../CHANGELOG.md)|版本变更记录|
|[docs/design/01-overview.md](design/01-overview.md)|设计入口与收拢原则|
|[docs/progress/STATUS.md](progress/STATUS.md)|进度总览（唯一进度记录）|
|[docs/checklists/release-checklist.md](checklists/release-checklist.md)|发布前Checklist（版本/changelog/测试/构建/tag/CI）|
|[docs/checklists/dsh-upgrade-checklist.md](checklists/dsh-upgrade-checklist.md)|dsh版本更新前Checklist（pin一致性/fork rebase/锁文件/回归）|
|[docs/checklists/packaging-closure-checklist.md](checklists/packaging-closure-checklist.md)|打包完整性Checklist（模块闭包vs build.files、构建链产物、打包态冒烟）|
|[docs/checklists/gui-acceptance-checklist.md](checklists/gui-acceptance-checklist.md)|GUI 验收流程（跑什么 / 看什么 / 留什么证据）|
|[docs/checklists/remote-browser-acceptance.md](checklists/remote-browser-acceptance.md)|右栏浏览器 v2 验收程序（本机 CDP + 真机双 flavor）|
|[docs/checklists/session-authority-calibration.md](checklists/session-authority-calibration.md)|会话事实单一权威的真机校准（design 14 §D4）|
|[docs/checklists/upstream-touchpoints.md](checklists/upstream-touchpoints.md)|上游触点登记与每 tag 保鲜循环（registry 生成视图；§2/§9 禁手改）|
