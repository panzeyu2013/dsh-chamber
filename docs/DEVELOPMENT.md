# dsh-chamber 开发文档（Development）

>面向开发者：涵盖架构总览、环境搭建、运行、构建/打包、CI/发布与仓库结构。
>用户使用见[README.md](../README.md)，贡献流程见[CONTRIBUTING.md](../CONTRIBUTING.md)；常驻仓库规则见[AGENTS.md](../AGENTS.md)，设计权威见[docs/design/01-overview.md](design/01-overview.md)。

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

Git worktree由chamber-bundled client插件与每实例内host插件配对；控制面/桌面只分发host包并挂loader row，不解析Git事实、不经SSH执行Git。

设计权威在 `docs/design/`（01为入口，05为v1表面/架构契约），包职责与约束在 `AGENTS.md`「Runtime Boundaries」——本文件只做一行级导航。

|包|职责（一行）|
|-|-|
|`packages/control-plane`|连接管理器核心：web profile宿主托管、host包seed/overlay、管理REST、每实例反代、静态前端服务|
|`packages/renderer`|自建dsh前端（源码复用）：入口构建、纯dsh首屏桥接宿主、N-ctx编排、启动图清单|
|`packages/desktop`|Electron壳：单frame、正交目标/传输provider、远端ready-time host包分发、实例注册表、IPC、运行时管理与原生边缘|
|`packages/cli`|CLI薄壳（serve/status/connections/host logs）|
|`packages/gateway`|独立认证server形态（design 17）：强制认证公网边界+单本地dsh反代+运行时管理/凭据面板/种子注册表|
|`packages/dsh-runtime`|desktop/gateway共用的纯Node dsh版本树、安装、激活、探针与两阶段回滚核心；状态仍归两宿主|
|`packages/dsh-client-connection`|官方连接客户端仓库内拷贝+ base路径补丁|
|`packages/dsh-client-web`|官方web shell仓库内拷贝+ boot.ts N-ctx模块表共享seam|
|`packages/dsh-chamber-client-ui-sidebar`|自研侧边栏插件：多来源会话导航+ chamberBridge（替换官方ui-sidebar注册）|
|`packages/dsh-chamber-client-ui-settings-connections`|自研连接设置插件（本地实例卡+远程主机CRUD/连接/systemd/日志）|
|`packages/dsh-chamber-client-ui-settings-bridge`|自研设置壳插件（shadow官方SettingsRoot注册，服务器下拉+固定连接导航项）|
|`packages/dsh-chamber-client-ui-layout`|自研ui-layout壳fork（layout store替换，持久化sidebarWidth）|
|`packages/dsh-chamber-seed-client-graph`|宿主侧包：经Typert Remote只读暴露实例的客户端插件boot图|
|`packages/dsh-chamber-client-ui-git`|chamber内建Git worktree客户端：sidebar座位、每实例拓扑、创建/删除saga；不直接执行Git|
|`packages/dsh-chamber-client-ui-open-in`|chamber内建open-in客户端插件（官方客户端半的超集并替换其注册）：会话头部utilities槽打开按钮——本地应用目录+本地/远程VS Code，主进程OpenInApp注册表+ `dsh-chamber://` 深链|
|`packages/dsh-chamber-seed-git-worktree`|实例内host包：按workspace/agent权威校验并执行受限、本地-only Git worktree生命周期|
|`packages/dsh-chamber-seed-archive-cleanup`|实例内host包：已归档会话内容清理 `archiveCleanup/{preview,purge,probe}`（只删不读、幂等；design 24）|
|`packages/dsh-chamber-seed-open-in`|实例内host包（仅本地形态）：上游 `dsh-host-open-in-app` 的fork，经 `openInApp/*` Typert Remote提供本机应用目录、真实bundle图标与拉起（design 20 §6）|

## 2. 环境搭建

### 2.1 要求

- Node.js 24+（推荐LTS；TypeScript源码经Node原生类型擦除直接运行，见 `.nvmrc`）
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

`bundle:dsh` 也由 `build:desktop`/`dist:desktop:mac` 自动执行——可直接跳到运行或打包。

## 3. 运行

```bash
pnpm run dev:control-plane   # 仅控制面——http://127.0.0.1:17500（管理 REST + 静态前端）
pnpm run dev:desktop         # 完整窗口：控制面 + dsh 前端 + 桌面壳
```

## 4. 构建与打包

```bash
pnpm run build:host-packages # 构建 host-graph + host-git-worktree 两个宿主包
pnpm run build:renderer      # 构建 dsh 前端 bundle（vite 构建 dsh workspace 源码）
pnpm run build:desktop       # host 包 → renderer → 控制面/host 包复制 → preload → bundle:dsh
pnpm run dist:desktop:mac    # 打包 macOS 应用（dmg + zip）
pnpm run dist:desktop:win    # 打包 Windows 应用（仅 nsis；须在 Windows 上运行——dsh 运行时封装按平台区分）
```

打包产物在 `packages/desktop/release/` 下（electron-builder `directories.output`）。正式发布的macOS腿须具备五项Apple/Developer ID凭据，缺项即在任何GitHub Release变更前fail-closed；构建后还须过Developer ID签名、公证、stapler与spctl校验，任一失败阻断draft公开finalize。`workflow_dispatch dry_run` 即使配置正式secrets也无条件清空签名/公证环境与 `GH_TOKEN`，用 `--publish=never`，不创建/修改Release、不上传资产，并由afterPack钩子产生ad-hoc签名验证包。Windows首版仍未签名（SmartScreen警告，design 11 §7的明确权衡）。

`build:desktop` 把已构建的host包（client-graph/git-worktree/archive-cleanup/open-in）复制到 `packages/desktop/dist/host-*-package/`；本地控制面由此seed打包态本地实例，桌面ready-time远端seed复用同一产物（open-in为 `localOnly`，只进本地seed，不进远端/gateway）。

> Windows 安装慢/卡"正在安装"的排障（Windows Defender 逐文件扫描）见 README「常见问题」。

### Windows 支持矩阵（design 23,推进中）

|面|状态|
|-|-|
|目标形态|Windows 11 x64,NSIS打包(`dist:desktop:win`,须在Windows上运行)|
|CI|`test-windows`(windows-2022)契约腿已定义(ci.yml);打包在release.yml `build-windows`|
|生命周期(M1)|win-probes(CIM身份/netstat/taskkill树终止)+ reaper/spawn-dsh平台自适应:代码就绪,POSIX单测绿,win32-only集成测试就位|
|运行时管理(M2a/M2b)|默认**只读**;验证态 `DSH_CHAMBER_WINDOWS_RUNTIME_MUTATIONS=1`;M2b UI翻转纪律门禁|
|桌面能力(M3)|AUMID/托盘候选收敛/preload loud失败已接;实机矩阵待执行|
|决策解锁(M4)|登录自启、深链注册、open-in本地路径、SSH密码门引导已解锁(代码);NSIS卸载Run清理include已接|
|已知限制|未签名(SmartScreen);SSH密码禁用(keys/Pageant);运行时mutation只读;0700/0600以icacls/ACL表达|
|权威记录|`docs/design/23-windows-support.md`、`docs/progress/todo/windows-v1.md`（含基线口径）|

## 5. CI 与发布

- `.github/workflows/ci.yml`：每次push/PR跑纯验证链（frozen install →根/gateway/runtime/host包/client插件typecheck→i18n →控制面/runtime/desktop/gateway/renderer/client/host单测〔含 `test:git`、`test:host-git`〕→ workflow action SHA门禁（`release-preflight --actions-only`，2026-09起）→ smoke〔未捆绑运行时SKIP〕→ renderer/host/desktop子构建→ gateway打包安装冒烟〔`pack` →临时prefix安装→ `gateway --help`〕），不产出发布包；桌面打包与真实smoke在 `release.yml`（tag/手动触发）。
- `.github/workflows/release.yml`：产出可分发版本——推送 `v*` tag（或手动运行，版本输入不带 `v`，可选dry-run）。发布版本仅限canonical stable `X.Y.Z` 与beta `X.Y.Z-beta.N`，`alpha`/`rc`/其他prerelease fail closed；stable用默认desktop打包配置且只发布 `latest.yml`/`latest-mac.yml`，beta用独立 `packages/desktop/electron-builder.beta.yml` 且只发布 `beta.yml`/`beta-mac.yml`，两通道资产互斥。正式流程先建draft，构建macOS arm64（v1仅Apple Silicon）与Windows x64，完成上述macOS fail-closed校验后才翻转公开；dry-run全程零Release写入。版本断言经 `release-preflight --versions-only` 动态覆盖根、全部非fork chamber包及三个fork基线；`CHANGELOG.md` 的 `## [<version>]` 段落被提取为发布正文（缺失会失败）。`validation` job第一步是发布提交的CI证明（`scripts/release/verify-release-ci-proof.mjs`：该commit在 `main` 上须有一条已完成且成功的 `ci.yml` push运行，`test`、`test-windows`、`test-macos` 三个job都success；运行中有界等待，失败或未经main一律fail closed），随后自验证gateway/runtime typecheck+tests、关键control-plane/desktop/renderer/plugin/CLI/policy门禁；`build-gateway` 只在GitHub Release发布经干净临时前缀安装冒烟的 `.tgz` 与同名 `.tgz.sha256`，npm publish/dist-tag延后。
- 发布机械门禁（2026-09起）：`pnpm run release:preflight <版本>`（`scripts/release/release-preflight.mjs`）——版本统一性（含fork副本与安装器dsh常量）、changelog中英对等、i18n、workflow action SHA上游可解析、冲突标记、git干净、frozen install、test:release-workflow；发布checklist §1.5/§7要求commit前与push前各跑一次。
- 发布流程（2026-09优化）：本地preflight +全量测试套件（精确发布提交）→
  commit+tag→workflow_dispatch dry_run先行（新增/修改的workflow/脚本路径/action SHA必须先dry-run验证过一次）→正式tag push。详细步骤见发布checklist。
- 推送路径的判类（2026-09）：`ci.yml` 的linux链按事件分档——分支push/PR：纯文档变更（`docs/**`、根级prose白名单；判类器 `scripts/gates/classify-ci-changes.mjs`）只跑file-only门（action SHA门禁、i18n、设计token、上游触点登记表、release-workflow策略、工具单测），跳过install/typecheck /单测/构建/打包冒烟与windows腿；代码变更全跑。tag push：`ci.yml` 没有tag触发（2026-09 CI触发策略修订）——发布改为证明而非重跑：`release.yml` 的 `validation` 跑 `verify-release-ci-proof.mjs`，要求该提交在 `main` 上已有成功的完整 `ci.yml` 运行（linux `test`+`test-windows`+`test-macos` 三腿都绿），运行中有限等待、失败即阻断。旧形态（linux链让位、windows腿在tag上照跑）既重复windows运行，又留下漏洞——给不在 `main` 上的提交打tag会跳过整条linux链；该漏洞现由证明堵住。release.yml与ci.yml的门禁对齐契约仍由 `release-workflow-policy.test.mjs` 从ci.yml派生断言（往ci.yml加门禁而忘了release.yml会直接红灯）。判类器fail-safe：无法证明是prose一律按代码跑；prose白名单被policy test冻结，放宽须显式改该测试。
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
  dsh-chamber-client-ui-sidebar/    自研侧边栏插件：多来源会话导航 + chamberBridge
  dsh-chamber-client-ui-layout/     自研 ui-layout 壳 fork（持久化 sidebarWidth）
  dsh-chamber-client-ui-settings-connections/
                            自研连接设置插件
  dsh-chamber-client-ui-settings-bridge/
                            自研设置壳插件
  dsh-chamber-seed-client-graph/    自研宿主侧 host 包（只读暴露客户端插件 boot 图）
  dsh-chamber-client-ui-git/
                            Git worktree 客户端（sidebar + coordinator + saga）
  dsh-chamber-client-ui-open-in/
                            open-in 客户端插件（会话头部本地应用 / VS Code 打开）
  dsh-chamber-seed-open-in/
                            实例内 open-in host Remote（本机应用目录 + 图标 + 拉起；仅本地形态）
  dsh-chamber-seed-git-worktree/
                            实例内 Git worktree host Remote（权威校验 + 受限 Git）
  dsh-chamber-seed-archive-cleanup/
                            实例内归档清理 host Remote（design 24）
docs/
  design/                   设计文档（01 为入口；05 为表面/架构契约（v1））
  progress/                 STATUS.md——唯一进度总览（只记未完成/部分完成项、设计未决、
                            范围决策与必要取舍）；deviations.md——Electron↔Swift 双 flavor
                            偏差登记与可达性纪律
  progress/todo/            未实现功能想法（每条一个文件；只保留未完成项）
  checklists/               操作清单（发布 / dsh 升级 / 打包完整性）
  *.en-US.md                各根文档的英文镜像
scripts/
  install-gateway.sh        Gateway 一键安装器（用户/运维面；入口 docs/deploy/deploy-gateway.md）
  dev/                      开发期工具链（安装引导 / typecheck 垫片 / 测试 loader 桩 / test-support）
  gates/                    每次 push 的仓库门（run-checks 单入口 + verify-* + CI 判类 + workflow 门）
  release/                  发布链（release-preflight/semver/artifacts + 工作流策略 + 打包清单锁步）
  upstream/                 上游 pin 与触点（update-vendor / pin 预检 / registry.json 单一来源与生成视图 /
                            C1–C15 触点门 / 符号锚与遗留锚预算门 / C8 产物门）
  perf/                     性能实测工具箱（boot/switch/eval/measure-ui/disk-walk + data/）
  gui-acceptance/           GUI 验收工具箱（probe/walkthrough/mobile-walkthrough/checks）
                            （分类规则与接线纪律见 scripts/README.md）
vendor/
  harness-packages/         @deepseek-ai/* 符号链接树，指向 submodule 内的 dsh 源码
                            （preinstall 引导，gitlink 固定于 harness.commit）
  harness-checkout/         dsh 源码 git submodule（固定 commit，gitlink 即 pin）
```

## 7. 脚本

|脚本|说明|
|-|-|
|`pnpm run dev:control-plane`|启动控制面（管理REST+静态前端），端口17500|
|`pnpm run dev:desktop`|Electron壳：完整窗口（控制面+ dsh前端+桌面壳）|
|`pnpm run acceptance:gui`|GUI验收（`--live` 只读探测／`--attach`／`--dev` 走查）；流程见 `docs/checklists/gui-acceptance-checklist.md`，边界见 `scripts/gui-acceptance/README.md`|
|`pnpm run test:gui-acceptance`|工具箱纯判据层单测（= `test:scripts:gui-acceptance`；CI跑；GUI驱动层不进CI）|
|`pnpm run test:scripts`|`scripts/` 下全部单测单入口（组：gates/upstream/release/gui-acceptance；清单与命名规则见 `scripts/README.md` §分类规则3，兼容别名见同条）|
|`pnpm run build:renderer`|构建dsh前端bundle|
|`pnpm run build:host-graph`|构建host-graph包（esbuild）|
|`pnpm run build:host-git`|构建实例内Git worktree host包（esbuild）|
|`pnpm run build:host-packages`|依次构建host-graph与host-git-worktree|
|`pnpm run build:desktop`|host包+ renderer +控制面编译/host包复制+ preload+dsh封装|
|`pnpm run typecheck:git`|类型检查Git worktree客户端插件|
|`pnpm run typecheck:host-git`|类型检查实例内Git worktree host包|
|`pnpm run test:git`|运行Git worktree客户端插件测试|
|`pnpm run test:host-git`|运行Git host core生命周期与安全守卫测试|
|`pnpm run dist:desktop:mac`|打包macOS应用（dmg+zip）|
|`pnpm run dist:desktop:win`|打包Windows应用（仅nsis；须在Windows上运行）|
|`pnpm run cli -- <args>`|仓库内CLI薄壳（serve/status/connections/host logs）|
|`pnpm run verify:i18n`|EN ↔中文对漂移时报错（同步后用 `-- --write` 重新记录）|
|`pnpm run verify:styles`|上游设计token合规门（S1未声明 `--dsw-*` 引用/ S2命名空间越界/ S3 0.5px发丝线/ S4字面量fallback/S5边框+阴影配对/ S6死声明/ S7全圆角配对），扫全部chamber包与可承载CSS的文件类型|
|`pnpm run gen:notices`|按已安装依赖树重新生成THIRD_PARTY_NOTICES.md（根中文+ docs/英文镜像）|

## 8. 文档导航

|文档|用途|
|-|-|
|[README.md](../README.md)|用户使用（功能/安装/部署/FAQ）|
|本文件 `docs/DEVELOPMENT.md`|开发：架构/构建/打包/CI/发布|
|[CONTRIBUTING.md](../CONTRIBUTING.md)|贡献流程（测试/Commit/PR契约）|
|[AGENTS.md](../AGENTS.md)|常驻仓库规则（包职责/硬性约束/STATUS记录要求）|
|[CHANGELOG.md](../CHANGELOG.md)|版本变更记录|
|[docs/design/01-overview.md](design/01-overview.md)|设计入口与收拢原则|
|[docs/progress/STATUS.md](progress/STATUS.md)|进度总览（唯一进度记录）|
|[docs/checklists/release-checklist.md](checklists/release-checklist.md)|发布前Checklist（版本/changelog/测试/构建/tag/CI）|
|[docs/checklists/dsh-upgrade-checklist.md](checklists/dsh-upgrade-checklist.md)|dsh版本更新前Checklist（pin一致性/fork rebase/锁文件/回归）|
|[docs/checklists/packaging-closure-checklist.md](checklists/packaging-closure-checklist.md)|打包完整性Checklist（模块闭包vs build.files、构建链产物、打包态冒烟）|
