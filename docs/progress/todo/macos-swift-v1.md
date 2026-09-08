# macOS Swift 原生壳 v1 实施细化计划（design 25 路线 A companion）

> 契约与决策：`docs/design/25-macos-swift-native-shell.md`（design 25，路线 A：
> WKWebView + Node sidecar 全复用，方案草案 **未立项**）。本文件是其 companion 实施
> 计划（windows-v1.md 先例）：把 design 25 的 P0–P4 细化为 **M0–M5 六道门** + WBS
> 任务表 + runbook + 施工单 + 门禁清单 + 中止条件，随里程碑推进同步更新 STATUS。
> 命令/脚本/测试名以 swift 分支当前 HEAD 为准（代码面自 258d6ab 起未变）；**需新增**均标注（新增）。
> 本文档本身不实现任何功能——执行须先过 M0 决策包与 M1 P0 证伪门（design 25 §8.1
> G1–G5），任一实质失败即回 design 25 §10 决策 1 重审，不硬着头皮继续（中止点见 §七）。

**基线假设**：① 单人 = JS/Swift 双栖熟练工程师，1 人-日 = 8 专注小时（含自带单测与
本地验证，不含评审等待/外部凭据阻塞）；② 3 人分工 = JS×2 + Swift×1，日历按利用率
≈0.7 折算；③ P0 验证门过才续投；④ 总估时 **46–72 人-日（9–14 人周）**，对齐
design 25。

## 已核实关键事实（本计划锚点；行号以 swift 分支当前 HEAD 为准，代码面自 258d6ab 起未变）

- 桥面：`packages/desktop/ipc-events.ts` IPC_CHANNELS 共 **68 条 = 60 个
  `ipcMain.handle`（main.ts，全包 trustedIpc）+ 8 条 `webContents.send` 推送**
  （SETTINGS_CHANGED/NOTIFICATION_OPEN/UPDATE_STATE_CHANGED/DEEP_LINK_INTENT/
  SYSTEM_RESUME/SSH_STATUS_CHANGED/SSH_INSTANCES_CHANGED/RUNTIME_STATE_CHANGED）；
  68/68 全部恰用一次（当前是事实，非测试保证）。
- preload 暴露 `window.dshChamber` = **4 顶层标量**（controlPlaneUrl/dshVersion/
  version/platform）+ **9 命名空间**（desktopSsh/update/settings/systemResume/
  openIn/deepLink/runtime/notifications/badge）；info 带 10×50ms 重试（仅 reject
  时重试）；事件订阅返回退订函数。60 invoke + 8 on。
- `ipc-surface-mirror.test.ts` 的 `MAIN_SIDE_FILES=['main.ts']`（:527）：断言 main
  handle/send 集合 == preload invoke/on 集合、无裸字面量、字面量 ∈ IPC_CHANNELS，
  另做 preload↔renderer global.d.ts↔settings-connections 结构镜像。**只锁通道名字符串
  集合 + 类型/字段镜像**——不覆盖方向/命名空间归属，不保证无死成员 → manifest 生成器
  仍需新增维度（design 25 §4.4.3 措辞已按此精确）。P1 迁 handle 出 main.ts 必须同步
  增补 MAIN_SIDE_FILES（见 §四 W-10）。
- Electron 依赖面：**真实 import electron 仅 3 个文件**——main.ts:29（静态）、
  preload.cts:1/11、updater.ts:86/101/677（惰性 require）；其余业务模块零 electron
  import、desktop 测试 node *.test.ts 直跑（Node ≥24 类型擦除）。
- main.ts 锚点：pick 对话框:336；通知构造:972/readNotificationHostBoolean:924/947；
  keep-awake:1029–1040；登录项:1046–1057；installRendererRecovery:1178–1234；
  openExternally:1283–1300；单实例锁:1458、second-instance:1462–1474、open-url:
  1479–1482；SIGTERM/SIGINT:1496–1502（Electron 43 下 mac 死代码，注释:1488–1494）；
  before-quit 退出确认:1528–1600、will-quit 回收:1602–1676；cp 装配 ≈:1790 起
  （webDistDir=<pkg>/dist/web:1813、stateDir=<userData>/state:1790）；handle 区散布
  :1898–5568；updateController 注入 ≈:3990–4000（已有抽象控制器 seam）；resume:
  2007–2016、held lastResume:894–905/1434–1440；端口裁决 resolveControlPlanePort:
  264–281。
- 端口语义（修正）：控制面 listen 单次绑定、EADDRINUSE 即失败**不重试**（control-plane
  index.ts:895–918）；**打包态固定 17500**（main.ts:270–272）；dev 态从 17520 起
  findFreePort 探测 200 个（free-port.ts:65–90），或 `DSH_CHAMBER_CP_PORT` 钉死。
- spawn-dsh node 解析（spawn-dsh.ts:435–447）：Electron 分支 :435–436（execPath +
  `--expose-internals` + ELECTRON_RUN_AS_NODE=1）；纯 Node 分支 :438–441 **仅当
  basename(execPath) ∈ {node,node.exe}** 才直用 execPath，否则 PATH/nvm 回退 →
  **Swift 捆绑 node 必须命名为 node**。dsh-runtime 默认执行器恒纯 Node
  （runtime-installer.ts:777）。plugin-sync.ts:2102–2108 的 electron 分支纯 Node 下
  自动走 execPath 零参分支（零改动成立）。
- **control-plane-module.ts:39–58 的 isPackaged 门**（electronVersion 且
  !defaultApp）纯 Node 恒判"非打包"→ 会动态 import 工作区 TS 源码；sidecar 需 flavor
  化此门或由 sidecar-entry 直连 dist/control-plane/index.js（产物已存在，
  build-control-plane.mjs:24）——**新增改造点，P1 账内**。
- 资源路径依赖（Swift 打包输入，design 25 未列全）：main.ts:350–352 打包态 builtin
  dsh=resourcesPath/vendor/dsh（非打包回退 repoRoot/ref-dsh || pkgDir/vendor/dsh——
  后者是 Swift 可直接利用形态）；:4026–4027 pnpm 双路径；:766 托盘 icon；
  updater.ts:316–330 resourcesPath/app-update.yml；**plugin-sync.ts:2023–2041
  resolvePnpmBinDir 只查 PATH/nvm/volta/homebrew/usr、不感知 bundled pnpm** → sidecar
  需注入 bundled pnpm bin 目录。
- 构建/CI：renderer vite **直写** ../desktop/dist/web（renderer/vite.config.mjs:216；
  gen-boot-manifest 写 dist/web/manifest.json）——无人"拷进"；electron-dev.mjs:11/53
  探测 `dist/index.html` 是**陈旧路径**（实产 dist/web/index.html）→ dev 每次全量重建
  （小 bug，runbook 已修正）；build:preload→dist/preload.cjs；build:control-plane
  →dist/control-plane/（tsconfig.control-plane.build.json）；host 包三个 →
  dist/host-{graph,git-worktree,archive-cleanup}-package；根 typecheck 覆盖
  packages/desktop/*.ts 平铺新文件；desktop test 是 package.json 内联链 = 文件清单
  单源（新测试必须入链，ci.yml 免改）。
- **dev 后端实况**：`pnpm run dev:control-plane`（standalone.ts）与 `pnpm cli serve`
  **都不接 webDistDir**（→静态 404），main.ts:1813 是唯一接线点；renderer dev server
  被设计禁用（vite.config.mjs:30–36 rejectStandaloneServe throw）。→ P0 后端 = 现有
  Electron dev（electron-dev.mjs，.dev-user-data + 17520 起/DSH_CHAMBER_CP_PORT 钉死 +
  懒构建）；P1 起 sidecar dev = 新 dev:sidecar（node sidecar-entry.ts），或给 standalone
  加 --web-dist（小改造，P1 账内候选）。
- CI：ci.yml test/test-windows 腿**无 macOS**；mac 打包只在 release.yml build-macos
  （macos-latest=arm64 macOS26、Developer ID keychain 自举、notarize、dry-run 剥离
  凭据）。发布 tag v* → create-release → 各腿传 draft。根命令：dist:desktop:mac、
  test:release-workflow、verify:i18n。
- userData 根：userData 名 = app.getName() = 打包 productName 'dsh-chamber'（desktop
  package.json:31–32）→ 实际根 ~/Library/Application Support/dsh-chamber；dev identity
  = @dsh-chamber/desktop（electron-dev.mjs:14–16）→ dev 用 --user-data-dir 隔离。
- 更新面：UpdatePhase（updater.ts:108）= idle|checking|up-to-date|available|
  downloading|downloaded|error；UpdateState :111–134；消费面 settings-bridge
  UpdateSection.tsx + update-store/update-gate；**通道 6 个与接口方法/字段集在 v1 降级下
  全部不变，仅控制器语义收窄** → §7 契约面零改动。**v1 形态 = blocked-available
  （真实 check + installBlockedReason，§0.1-E1 修订，禁用 idle|error 假降级）；info 载荷增
  flavor: 'electron'|'swift'（§0.1-E2）；before-quit 的 updateDownloadReady 豁免恒 false
  属预期（D4）**。

## 0. M0 决策包与执行入口（签核即开工）

### 0.1 D1–D7 决策签核表

| 决策 | 一句话含义 | 推荐默认值（引用 §八） | 最迟拍板门 | 签核 |
|---|---|---|---|---|
| D1 路线确认 + P0 先行 | 是否按路线 A（WKWebView + Node sidecar 全复用）启动 1–2 周 POC | 启动 P0；G1–G5 + C1/C2 全过才续投（§八 D1；design 25 §8.1） | M0 出口（启动）；**M1 出口复核（继续门）** | ☐ |
| D2 双壳共存 + bundle id | Swift 与 Electron 长期共存还是 mac 替换；授权/打包身份是否区分 | **共存**；bundle id `com.dshchamber.native`（§八 D2；后改 = 通知授权重来 R4 + 打包身份返工） | M0（立项即定） | ☐ |
| D3 更新路线 | Swift 壳更新走哪种形态 | v1 **blocked-available** 诚实形态（真实 check → phase='available'+releaseUrl+installBlockedReason）→ v2 Sparkle（§八 D3；design 25 §7「§0.1-E1」） | M2 出口（W-14 同批） | ☐ |
| D4 仓库落位 | Swift 代码放哪 | `macos/`（SwiftPM，§八 D4；design 25 §3.2 同布局） | **M1 前**——POC 建目录即定（W-03 起生效） | ☐ |
| D5 原生 UI 渐进（路线 B/C） | 是否排期 Swift 原生 UI | 不做；HostEdges 边界即未来接缝（§八 D5） | M2 出口（登记范围外即可） | ☐ |
| D6 Node 版本/架构/来源 | sidecar 捆绑 node 的版本、架构与获取方式 | 大版本对齐 desktop Electron 43.4.0 内置 Node（确切 minor 以安装态 `process.versions.node` 核实）；**v1 arm64-only**（x64 登记后续）；来源见表下实证 | M3 入口（W-23 sidecar 捆绑落地前） | ☐ |
| D7 静态凭据加密 | v1 是否做 Keychain 协助加密 | 不做：诚实 0600 明文 + 旧 safeStorage「保留禁用待重录」（判别单测 S1；§八 D7） | M4 出口复查 | ☐ |

补充决策输入（§八 没有的两条）：

- **D6 Node 来源两派实证**（市面参考仓库实况，design 25 §2 [待核-外部]，2026 源码级核实）：
  summer-521/deepseek-harness-swift 派 = **构建期 fetch 官方固定版本 + SHA-256 校验**后落
  `.app/Contents/Resources/node/bin/node`（`scripts/fetch-node.sh` +
  `NodeRuntime.swift` 解析链；产物可复现、确定性，与本仓固定 pin/ensure 惯例同向）——
  **推荐前者**；luochenw/deepseek-harness-macos 派 = 取构建机 node + `lipo` 验架构
  （`scripts/build-macos-app.sh`；省一次下载，但构建机漂移不可复现）。
- **D4 落位推荐 `macos/`**：与 design 25 §3.2、§八 D4、W-03 三者一致；后移 = 全部
  路径/CI/脚本返工。

**签核方式：在 companion 此表打勾并提交，即 M0 启动**（M0 出口必须：D1=启动 P0、
D2=共存 + `com.dshchamber.native`、D4=`macos/`，D6 至少初定；D3/D5/D6/D7 到门复核）。

> 表关系：§0.1 = **签核视图**（本执行入口），§八 = **契约视图**（最迟拍板门与错过
> 后果）——两表同源，改动必须两处同步。

### 0.2 M0 → M1 执行入口 Checklist（W-01…W-08）

> 标记约定：**[用户机]** = 需 node/pnpm 或 GUI 交互，执行沙箱不可跑；**[沙箱可跑]** =
> 工具链实测支持（swift 6.3.3 / xcodebuild / `xcode-select -p` 正常，零依赖 `swift build`
> 已 dry-run 通过）。命令逐一核实自 root/desktop/renderer package.json scripts 或 SwiftPM
> 内建；M0/M1 需新增脚本 = 0 条（root 新命令 `dev:sidecar` 属 M2，届时标 🆕）。

**① 环境验证（W-01 G0 部分）**
- [用户机] 定位/安装 **node ≥24 与 pnpm**（M0 环境门第一条；沙箱实测 node/npm/pnpm 全
  MISSING；root engines `node>=24.0.0`、packageManager `pnpm@11.21.0`）：装 node ≥24 后
  `corepack enable`（或 `npm i -g pnpm@11.21.0`），验 `node --version`（≥v24）、
  `pnpm --version`（=11.21.0）。
- [沙箱可跑] `swift --version`（=6.3.3）；`xcode-select -p`。
- [用户机] `node scripts/dev/ensure-harness-vendor.mjs` —— **必须在 pnpm install 之前显式
  跑**（脚本头注释明示 preinstall 快照捕获过早；沙箱 vendor/harness-packages 链接树未
  物化，仅 submodule 检出）。
- [用户机] `pnpm install --frozen-lockfile`（preinstall 幂等复跑 ensure + postinstall
  ensure-electron 拉 Electron 43.4.0）。
- [用户机] `pnpm run typecheck`；[用户机] `pnpm run build:renderer`（vite 直写 → 预期产物
  `packages/desktop/dist/web/index.html` + `packages/desktop/dist/web/manifest.json`）。
- **门禁判据**：六条全 0 退出且产物文件存在；node/pnpm 缺失是前置安装问题，不在沙箱误跑。

**② W-01 决策表签核 + U1 实根核验（0.5–1 人-日）**
- 0.1 决策表打勾提交（D1/D2/D4 + D6 初定）＝ M0 退出条件之一。
- [用户机] U1：`ls "$HOME/Library/Application Support/"`；`ls "$HOME/Library/Application
  Support/dsh-chamber"` —— 实测实根不存在（仅 `@dsh-chamber`）→ 登记「无打包版历史
  userData，C2 对比需先有 Electron 打包/隔离会话」；若存在则核对 `state/dsh-home`、
  `dsh-runtime/`、`chamber-settings.json` 布局。锚点：desktop package.json
  `build.productName='dsh-chamber'` / `appId='com.dshchamber.desktop'`（已核实）。
- **门禁判据**：签核 commit 存在 + U1 记录入库 → M0 出口达成。

**③ W-02 文档动作（0.5 人-日）**
- 改 3 文件：本文件（§0 合入 + 头部锚点更新 + 状态行注明「M0 已签核」）；
  `docs/progress/STATUS.md`「设计未决」macos Swift 词条补一句「D1–D7 已签核（日期）、M0
  过、执行中（M1）」；`docs/progress/todo/README.md` 目录表第 4 行状态列 →「M0 已签核；
  执行中（M1）」。
- 本清单自检：复核 0.1/0.2 全部命令与文件路径（需新增命令 = 0 条）。
- **门禁判据**：三文件 diff 合入、零产品代码改动。

**④ W-03 SwiftPM 骨架 + 最小窗口（1.5–2.5 人-日）**
- 新建：`macos/Package.swift`（executableTarget `DSHChamberPoc`、platforms macOS 13+、零
  第三方依赖）+ `macos/Sources/DSHChamberPoc/{main.swift, AppDelegate.swift,
  MainWindowController.swift}` 三件套（最小窗口 + WKWebView 载 `http://127.0.0.1:17520/`）。
- [沙箱可跑] `cd macos && swift build` → 产物 `macos/.build/debug/DSHChamberPoc`。
- [用户机 GUI] 前置起共享 dev 后端：`DSH_CHAMBER_CP_PORT=17520 pnpm run dev:desktop`
  （背景进程；首启懒构建 renderer；`.dev-user-data` 隔离）；再跑
  `.build/debug/DSHChamberPoc`（或 `swift run DSHChamberPoc`）目测。
- ATS：[待核] 字面 IP 通常入 NSAllowsLocalNetworking 豁免；被拦 → `-Xlinker -sectcreate
  __TEXT __info_plist <临时 plist>` 或改 `http://localhost:17520/`。
- **门禁判据**：swift build 0 退出（沙箱可验）；窗口渲染 dsh 主界面（veil → 侧栏）。

**⑤ W-04 A 桥雏形（1–1.5 人-日）**
- 新建：`macos/Sources/DSHChamberPoc/{BridgeShimInjector.swift, MessageHandler.swift}` +
  注入脚本 `bridge-shim.poc.js`（WKUserScript、.page world、documentStart；4 标量 + 9 面
  形状，只实现 desktopSsh/settings 最小集，其余统一 loud `{error:'poc-unimplemented'}`
  绝不静默；info 10×50ms 重试照搬 preload）；主 frame + origin（port 仅 ready 后放开）
  护栏雏形。
- 对拍（不设门，登记结论）：shim 挂出时机二选一——Swift ready 后注入 vs documentStart
  预定义统一 reject（design 25 §4.4.1 D1）。
- **门禁判据**：页面 console 见 info 返回 + `window.dshChamber.controlPlaneUrl === cp
  origin`（[用户机 GUI]）；swift build 仍绿。

**⑥ W-05 垂直切片（1.5–2.5 人-日）**
- 新建：`packages/desktop/poc-sidecar.ts`（NDJSON 原型 B 桥服务端；P1 由 sidecar-entry.ts
  替换）+ Swift 侧 B 桥客户端原型（`BridgeProto.swift`：spawn `node packages/desktop/
  poc-sidecar.ts`，信封 `{id,method,payload}/{id,ok,result|error}/{event,payload}`）。
- 语义：instances_get 直读 `.dev-user-data` registry（预期文件
  `packages/desktop/.dev-user-data/ssh-instances.json`，由 dev 会话写入；无 →
  `{error:'poc-no-registry'}`）；状态推送优先真实 transport-manager，最小伪造须 loud
  标注；通知 edge 打桩：点击 → notification-clicked → sidecar 日志 → push
  notification-open 回 web。
- **门禁判据**：三拓扑全通——invoke 拿结果 / 订阅收 push 且 UI 有反应 / 通知点击有 click
  日志（[用户机 GUI]；沙箱只跑 swift build 静态验证）。

**⑦ W-06/W-07 G 门走查（2 人-日，S6/S7 清单）**
- W-06（G1/G3）：多实例/会话/设置页逐页目测；git 侧栏、open-in、settings-bridge chamber
  全局页可用。
- W-07（G2/G5 + C1/C2）：富文本复制粘贴保格式（外部富文本 app 验证）、文件拖 composer、
  外链 → 系统浏览器、**非 http(s) scheme 外链导航（mailto:/vscode://，design 25 G2/C6）**、
  Cmd+Q/红点关窗/唤醒即时重连；**C1** hide ≥30s 后 SSE/WS 心跳不断、
  唤醒即时（backgroundThrottling:false 无 WKWebView 等价物）；**C2** 双 flavor 交替同一
  userData/dsh 实例时 WebKit 独立存储 jar 会话 cookie/登录态实测并定共存语义。
- **门禁判据**：G1/G3 无实质缺口（minor 样式可归类）；剪贴板/拖拽不过 → 归因 1–2 天，
  仍不过 = A2 → 回 D1 重审；C1/C2 结论显式登记（不过按 W6 判定表 = 已知降级登记）。

**⑧ W-08 G4 + P0 报告 + D1 门复核（0.5–1 人-日）**
- G4：深链冷启动——dev 无 bundle，模拟三候选 [待核]（① 临时 Info.plist + 最小打包；
  ② NSAppleEventManager 注入；③ 直调 deep-link intent 队列打桩，三选一）；通知点击激活
  会话。
- 报告：0.3 登记表填 W-01…W-08 全部行 + 证据文件；STATUS/todo README 同步；**D1 门评审**：
  G1–G5 全过 → 续投 M2（W-09 起）；任一实质失败 → 中止 A1/A2 → 回 design 25 §10 决策 1
  重审，不硬续。
- **门禁判据**：G1–G5 证据齐全、登记表结论入库、评审记录可查。

**沙箱内可做/不可做分界**：凡 `node …`/`pnpm …` 前缀与 JS 侧动作（install/typecheck/
build:renderer、`dev:desktop`、poc-sidecar 起动）全部 **[用户机]**（沙箱无 node/pnpm）；
Swift 侧 `swift build`/`swift test`/`swift run` 为 SwiftPM 内建且工具链沙箱实证可用 →
W-03 起骨架文件落地即可在沙箱执行验证；窗口目测/剪贴板/拖拽/通知/深链/心跳走查 =
**[用户机 GUI]**。

### 0.3 首轮执行登记模板 + 开工前风险提示

**门禁登记模板**（自 W-01 起逐门补行；结论用 STATUS 惯用「过 / 不过 / 全勾或显式
残余」，禁止空白门禁；证据文件写精确路径或 [GUI 目测 + 记录于本行]）：

| 日期 | 门（W-xx） | 证据文件 | 结论 | 残余与后续 |
|---|---|---|---|---|
| （示例）2026-XX-XX | W-01 | 0.1 表签核 commit <sha>；U1 记录；G0 命令日志 | 过 | D3/D5 待 M2 出口、D6 minor 待安装态核实 |
| | W-02 | | | |
| 2026-09-07 | W-03 | macos/ SwiftPM 骨架 + 窗口壳；`swift build` 0 警告 0 错误；scratch 运行时冒烟（ATS 未拦 loopback、资源注入成功） | 代码过 | 窗口视觉/外链/退出语义待 [用户机 GUI] |
| 2026-09-07 | W-04 | TrustGuard/BridgeShimInjector/MessageHandler + bridge-shim.poc.js；46 项行为断言（/tmp/dsh-verify）+ 框架单测并入 | 代码过 | 真页 hydration 对拍（shim 挂出时机）待 GUI |
| 2026-09-07 | W-05 | AnyCodable/FrameCodec/BridgeClient + poc-sidecar.ts；`swift test` 19/19；sidecar NDJSON 驱动 33/33；**真链冒烟：真实 chamber UI → shim → Swift 护栏 → B 桥 → sidecar `desktop_ssh_instances_get` 回包** | 代码过；invoke 拓扑真链通 | push/edge 拓扑补集成测试中（B 桥 XCTest 直驱，无 GUI）；`info` 未在真链日志观测（待查 shim 触发时机） |
| 2026-09-07 | W-06/G1 | [用户实机目测] 本地实例正常显示、主界面可用（用户确认，非沙箱取证） | **G1 过（用户确认）** | G3 侧栏插件走查与其余 G 门按用户指示暂缓（登记：G2/G4/G5/C1/C2 待补实机矩阵） |
| | W-07 | | | |
| | W-08 | | | |

**自主推进轮注记（2026-09-07）**：本环境经 Electron-RUN_AS_NODE（
/Applications/dsh-chamber.app 内置 Node 24.18.1）+ 主检出 pnpm store 解锁 JS
工具链；vendor 已物化（ensure-harness-vendor，submodule a66e4702）、`pnpm install
--frozen-lockfile --ignore-scripts` 5.9s 完成（Electron 下载跳过）。上述 W-03…W-05
为**代码交付级**完成；**所有门禁判定（G1–G5/C1/C2）仍属未过**：截图取证被系统
录屏权限拒绝，UI 目测项全部待 [用户机 GUI]。D1–D7 未签核（§0.1 表）——M0 未启动，
本表行不等同于门通过。
**同日补（静态审查 + 集成测试轮）**：P0 静态审查结论 0 Blocker / 1 Major /
约 20 Minor-Info——Major #1（instances_get 缺 registry 伪装空成功，抵触
AGENTS proxy-honesty）已修：sidecar 现答 `{error:'poc-no-registry'}` 诚实错误帧，
集成测试改判抛错；Minor 已修：#2 注释/命名漂移（3 通道→7 通道、BridgeProto→
BridgeClient）、#3 注释次序、#4 JSON 预扫描加深度上限 512、#11 导航/消息护栏统一
走 TrustGuard、#12 AppDelegate 补 Dock reopen 恢复、#16 jsStringLiteral 补
U+2028/29 转义、#17 shim 桩 reject 统一 Error 形态；其余 #5–#10/#13–#15/#18–#24
登记级（fail-closed 无安全影响；P1/M2 语义前移处代码注释已声明）。**B 桥集成测试
5 例入库**（BridgeClientIntegrationTests.swift；全量 swift test 24/24）——
push 拓扑（事件先于响应）已无 GUI 闭环，edge 反向通道留 M2/P1。三方通道差集：
Swift 白名单 7 == shim 7 == sidecar 7（+edge:notification-clicked 不可达死桩）；
shim PUSH_EVENTS 8 与 ipc-events.ts 字面量逐字一致。
**同日补（W-09 批 1 执行，M2/P1 首搬）**：`shell-core.ts` 新建（247 行，Electron-free
零 seam），main.ts 5802→5663 行：K1 端口决议/K2 runtime 决议（resolveActiveRuntime
+ readDshVersion）/K3 proxyTransport/K4 三常量/K5 scanDeepLinkUrls/K6 七路径模板 +
14 调用点改写；门禁全绿：ipc-surface-mirror 24/24、renderer-trust 10/10、
transport-manager 126/126、typecheck 0 诊断、**test:desktop 892/892**。已注记偏差：
K2 原实现引用 main 模块级 `version`（shouldInvalidate 实参），shell-core 改为模块级
读兄弟 package.json 同值自足（dev/打包同目录布局，值恒等）；若后续改第三参注入代价小。
W-10 seam 化批（HostEdges/60 handle 迁入/mirror MAIN_SIDE_FILES 扩展）为下一大块。
**W-10 收口（同日 S0–S11 十二批全部提交）**：60/60 ipcMain.handle 全迁 shell-core
installIpcHandlers（S0 装配/S1 info+settings/S2 notify+badge+ready+投递状态机/
S3 registry+凭据/S4 ssh 连接状态/S5 ssh 服务/S6 ssh 插件/S7 gateway 插件/S8
local+npm/S9 open-in+update+深链合龙/S10 runtime A/S11 runtime B）；HostEdges
seam 落位（electron-edges.ts：rendererPush/通知/badge/keep-awake/showMessage/
pickPluginSource/openExternal/openPath/showItemInFolder/showError/三可用性门）；
main.ts 5663→3803（剩余=装配/窗口 glue/生命周期/启动事务宿主/publishRegistry
Transition，W-10 边界内）；ipc-surface-mirror 增 B12/E8 无死键断言（68/68）；
electron-free-gate 面 A/B/C 全绿；每批门禁 test:desktop 全绿（收官 896/896）。
**下一大块（暂停待命点）**：W-11/12/13——sidecar-entry/node-edges/B 桥服务端/
stdio 冒烟（installIpcHandlers 现可被 node-edges 复用；electron-edges 为唯一
Electron 面）→ M3 Swift edges。
**W-11/12/13 已交付（同日提交 a669124）**：node-edges.ts（HostEdges Swift-flavor：
edge 往返 + 同步门缓存/hostFacts 刷新 + clickRoute 回灌表 + __host.* 路由）；
sidecar-entry.ts（B 桥 NDJSON 服务端 + console→stderr D2 + 目录锁复验 + 无头 ctx
【settingsIO/audit/hostFacts 真实；transportManager/runtime/update/plugin/gateway
宿主字段为**递归 loud stub（sidecar-ctx-unavailable:*，绝不静默）**——真实化计划：
transportManager 装配 W-13 续、宿主线 M3】+ cp 装配 + ready 帧 {port,shellVersion}
D8 + 信号优雅）；sidecar-stdio.test.ts 6/6（ready/info/settings-set→rendererPush
推送采样/代表通道 loud/未知通道/SIGTERM exit 0）接入 desktop 链。门禁：typecheck
0、electron-free-gate 3/3（coreFamily 含新文件）、test:desktop 全链绿（36 文件）。
**登记为后续（不省略）**：① 60 通道全量冒烟需 Swift 侧应答 edges（属 M3 harness
范围，stdio 侧对 NOTIFY 类 edge-await 通道无 Swift 必挂起——已注释）；② dev 起
sidecar 的便捷命令未加（机器相关 node 路径，命令见 §0.2 ③ 语义可手拼）；③ 无头
ctx 真实化逐项列于 sidecar-entry.ts 注释。
**M3 已交付切片（同日）**：
- **BridgeClient edge/notify/ready 扩展 + 60 通道无 GUI 全量冒烟**（c612382）：
  outbound 帧分类、onEdgeRequest/onNotify/onReady、默认 edge 应答器（同步门
  真值/showMessage 0/其余 swift-edge-unimplemented 绝不挂起）、edge 恰好一次
  + 会话代际、stop 收尸竞态修复（有界轮询替代挂死 waitUntilExit）；
  BridgeClientEdgeIntegrationTests 3 例（60/60 零超时 ok13/loud47、自定义应答
  两路等价、settings-set→rendererPush + SIGTERM exit0）；swift test 27/27。
- **W-17 manifest 管线**（2c3cfc4）：emit-bridge-manifest.mjs（IPC_CHANNELS +
  三 main-side 文件注册点扫描，校验链死键/双引用/表外 loud）；提交物
  bridge-manifest.json + BridgeManifest.swift；bridge-manifest.test 6/6 接入
  desktop 链；两次生成字节一致。
- **W-18 前半**（3e082f6/06165cd）：生成物迁入 macos/Sources/DSHChamberPoc/
  Generated/（target 内编译接线，Package 零改动）；BridgeManifestConsistency
  Tests 5 例（60/8/68/golden）；swift test 32/32；docs 路径引用同步。
- **W-18 后半 A**（9d06caa）：renderShimStub + CLI 三产物 →
  Resources/chamber-bridge.stub.js（GENERATED manifest 常量单源桥 + assert
  助手，与手写 bridge-shim.poc.js 并存）；bridge-shim.test.ts 6/6 接入链。
- **W-13 缺口闭合**：60 通道全量冒烟经 Swift harness 应答 edges 已无 GUI 闭环。
- **E2 flavor 字段前哨**（645a654）：hostFacts.flavor 'electron'|'swift' →
  INFO 载荷透传（main/sidecar 双装配），renderer 更新/通知宿主机制分派依据。
- **W-19/20 宿主腿骨架**（4ec76ce/9f19d0e）：SwiftEdgeHostLegs（统一 respond
  分派；canShowUI false → swift-edge-ui-unavailable；未实现 →
  swift-edge-unimplemented 回落默认表；focusMainWindow/showMessage
  pendingAlerts 队列/openExternal|openPath 窗口守卫）+ PendingAlertQueue 纯
  逻辑 + BridgeClient.edgeHostLegs 注入点 + AppDelegate 主窗上下文接线；
  swift test 38/38、build 0 警告。
- **W-21 前置**（b7bcacd）：BridgeClient 异步 edge 应答通道（canHandleAsync →
  respondAsync；legs 回落仅限 unimplemented 前缀，ui-unavailable 诚实传播）
  + 真实 UNUserNotificationCenter 通知调度腿（失败 loud）；swift test 39/39。
  click 回灌 delegate（954323d：授权/前台横幅/didReceive 聚焦+__host.
  notifyClicked 回灌）/前台展示 = M3 集成硬门禁（待实机）。GUI 腿实机验收（UNUserNotificationCenter
  click 回灌/NSAlert 消费等）= M3 集成硬门禁。
- **W-21 续/picker/error/launch**（0a939b6/0800db2/045a33d）：setBadge
  （dockTile）/setKeepAwake（ProcessInfo activity）/showItemInFolder/
  pickPluginSource（NSOpenPanel folder|.tgz 一体模态主线程）/showError
  （NSAlert critical）/launchApp（.app openApplication 或 NSWorkspace.open）
  真实腿——全带窗口守卫（headless 诚实降级）；swift build 0 警告、swift
  test 40/40。**剩余腿**：setLoginItem（SMAppService 需签名）、
  appId→应用映射（M3 集成）——GUI/签名硬门禁。
- **P3 打包重跑完成（当前 HEAD 全量产物基底）**：产物
  packages/desktop/release/{dsh-chamber-0.2.2-arm64-mac.zip (155MB),
  .blockmap, mac-arm64/dsh-chamber.app (418MB, adhoc 签名)}。验证：
  ELECTRON_RUN_AS_NODE node 模式 24.18.1/43.4.0、Identifier
  com.dshchamber.desktop、version 0.2.2。构建过程踩坑记录：
  ① 沙箱无外网 → electron-builder 下载 Electron zip 挂起 → 用缓存
  ~/Library/Caches/electron/<hash>/electron-v43.4.0-darwin-arm64.zip 解压
  为 /tmp/pristine-electron 并以 -c.electronDist 注入；
  ② 模块收集器需 npm → PATH 加 nvm bin；
  ③ distribution 签名 --timestamp 需网络 → CSC_IDENTITY_AUTO_DISCOVERY
  =false 走 after-pack adhoc（脚本已自验证）；DMG 目标子步离线挂起被终止
  （登记为受阻：需联网或后续重试 dmgbuild）。**离线 DMG 已用 hdiutil 补齐**
  （release/dsh-chamber-0.2.2-arm64.dmg 199MB，UDZO；无 /Applications
  快捷方式版式——标准 dmgbuild 版式待联网重跑）。asar 抽查：main.ts/
  shell-core.ts/node-edges.ts/sidecar-entry.ts 均在包内。产物不自动替换
  /Applications（等用户确认，吸取事故纪律）。
**POC dev 循环打通（方案 B，用户在场实机联调）**：swift run 壳 + 真
sidecar-entry + 独立 userData/17520 + 本地 dsh 实例（POC_DSH_PATH →
packages/desktop/vendor/dsh 离线 workspace，dsh ready 17511）。修复链：
无 bundle id 通知崩溃守卫 → 首载竞态退避重试 → console/onerror 回传 +
渲染快照诊断 → transportManager.listInstances 真实化（registry 文件读）→
A 桥白名单扩 BridgeManifest 全集（60/60）→ shim readiness/badge 真实通道
化（deep-link-ready/notifications-ready/badge-count 实调成功，零
poc-unimplemented、零 handshake 报错）。全程隔离现网实例。
**全量占位实现批（parity，同日多线）**：S-A hostFacts 推送（9ece802，46/66 系
列）；S-B shim 全表面 67 方法（48eaa49，零 stub）；S-C-1 ctx 真化第一片
（8e6c2d9：registry/凭据/审计/确认框 56 断言）；S-D notify 路由+legs 补全
（5414f1f，66/66；rendererPush 解包补上页面 push 断链）；S-C-2 ctx 收口
（c9c2133：F/G/H/J/K 全组 + runtime 控制器族 + 门族，914/914）；dev 快捷门
（e1ca9eb：DSH_SIDECAR_LEGACY_START=1 离线 pre-spawn——全新 profile 离线探针
阻塞为 Electron 同语义，legacy 门仅供 dev）。
**parity 边界登记（有意保留+责任方）**：updateController 有意 loud（electron-
updater 需 Electron app 上下文；Swift W-22 Sparkle 线）；keep-awake/login-item 异步 leg 失败的 settings-set 级回滚已收口（S-E
8b988eb：applySettingsPatch async + sendEdge 异步面 + 失败回滚不持久化，与
Electron 同步 throw 同路径）；全新离线 profile 本地实例需运行时安装（网络）——与 Electron 一致；
实机门禁：SMAppService 真调用/launchApp 拉起/notify GUI 闭环。
**跨层残留审计收口（52e919e）**：只读审计（A×3/B×12/C×4）——A-1/A-2 唤醒
（didWake→__host.systemResume）与窗口显示（didBecomeActive→__host.
mainWindowShown）发送方落地（E6 对偶）；A-3 接线先于 start + onReady 消费 +
cpURL 派生自 POC_PORT；B-5 PendingAlertQueue 死代码删除；swift 65/65、build 0
警告。B 类登记：resolveResource 零消费（预留）、retireNotifications no-op 改接
点注释、updateController 有意 loud（W-22）、深链整链归 POC/打包（G4）、崩溃
自动重载归 M3；C 类：通知闭环/Sparkle/SMAppService/实机走查（打包+凭据）。
- **showMessage 真实模态腿**（95275cc）：NSAlert 主线程 runModal 一次、
  按钮序 raw-1000 夹取回传、style 映射、无 buttons→['OK']；无窗诚实降级。
  **M3 代码级宿主腿至此全部完成**（focus/open/openPath/reveal/badge/keep-
  awake/error/launch/picker/notification 调度+delegate 回灌/message）——
  全部 0 警告 + 40/40；剩余均属实机/签名硬门禁。
**剩余路线**（不省略登记）：W-18 后半 B（manifest 运行时白名单消费决策：POC
白名单 7 收窄暂维持，全量放行待 shim 全量生成时评审）→ W-19…W-21
（窗口/菜单/生命周期/通知/角标/深链/对话框/外链/登录项/崩溃恢复——Swift 宿主腿
替换默认应答分支，GUI 门禁待实机）→ W-22…（更新 v1 blocked-available + info
flavor）→ M5 台账收口。
## 当前状态快照（2026-09-08 17:26，用户要求记录）
- **分支/HEAD**：swift @ b1c19c8（工作树干净；vendor/harness-checkout 子模块
  untracked 噪音不提交）。
- **门禁基线**：swift test 65/65、build 0 警告；desktop test:desktop 914/914（38
  文件）；typecheck 0；electron-free-gate 3/3、sidecar-stdio 6/6、
  bridge-manifest 6/6、bridge-shim 6/6、chamber-settings 30/30。
- **里程碑**：M2/P1 ✅（W-09…W-14）；M3 代码级 ✅（W-15…W-21 宿主腿全集 +
  manifest + shim）；P3 打包 ✅（adhoc zip/app/DMG 于 packages/desktop/release/，
  8-27 产物仍占 /Applications，未刷新——事故纪律）；parity 批 ✅（S-A…S-E：
  hostFacts/shim 67 方法/ctx 全真化/notify 路由/settings async 化）；跨层审计
  ✅（A×3 收口 52e919e、B×12 登记、C×4 门禁）。
- **POC dev 验收环境**：macos/ swift run（或直跑 .build/arm64-apple-macosx/
  debug/DSHChamberPoc）带环境：POC_SIDECAR=<repo>/packages/desktop/
  sidecar-entry.ts、POC_NODE_BIN=/Applications/dsh-chamber.app/Contents/
  MacOS/dsh-chamber、POC_DSH_PATH=<repo>/packages/desktop/vendor/dsh、
  DSH_SIDECAR_LEGACY_START=1（离线快捷门）、NSUnbufferedIO=YES；独立
  userData dsh-chamber-poc-dev、端口 17520/实例 17511——与现网实例全隔离。
  最近一轮 POC 已被退出（POC_STOPPED），需验收时重拉。
- **硬门禁（C 类，解锁条件已登记）**：①通知/更新/SMAppService 真实闭环 =
  打包 .app + Apple 凭据（W-22 Sparkle/notarization，A6）；②全新离线 profile
  本地实例需网络装运行时（与 Electron 同语义）；③G 门 walkthrough/截屏（系统
  曾拒屏幕录制）；④/Applications 刷新等用户明确指令。
- **验收清单（用户逐流对照用）**：设置页（keep-awake/登录项失败回滚）、runtime
  管理（离线 loud 与 Electron 一致）、SSH CRUD、本地实例会话、设置变更即时
  回显、开关窗口后 held resume/唤醒重连。

**环境事故登记（同日 18:23–18:30）**：`/Applications/dsh-chamber.app/Contents/MacOS/
dsh-chamber` 可执行文件被误替换为「exec nvm node」跳转 shim（推测为某 subagent 建
PATH shim 时写错目标路径；真二进制无备份、stub 与框架配对校验失败）。处置：从主检出
`packages/desktop/release/mac-arm64/dsh-chamber.app` **整包恢复**到 /Applications
（ad-hoc 签名、Electron 43.4.0 验证 24.18.1 通过；运行中 GUI 进程为内存旧版不受
影响，但磁盘上 app 代码回到 8-27 构建，后续需用新构建重装刷新）。**纪律追加**：
所有 subagent 提示词明令「禁止写仓库根之外的任何路径（含 /Applications、/usr、
/tmp 系统区之外的自建工具链只允许 /tmp 专属目录）」；门禁工具链统一 nvm node
（~/.nvm/versions/node/v24.20.0，真 node 24.20.0）或恢复后的 /Applications 二进制。

**开工前风险提示（8 条）**：
1. **node/pnpm 缺位**（沙箱实测 MISSING）——W-01 首步用户机装 node ≥24 + pnpm@11.21.0；
   带 [用户机] 标记的命令一律不在沙箱跑，缺 node 不误判为仓库故障。
2. **vendor/harness-packages 未物化**（沙箱仅 submodule 检出，链接树缺失）——
   `pnpm install` 前显式 `node scripts/dev/ensure-harness-vendor.mjs`（脚本头明示 preinstall
   快照过早）；失败先查 submodule HEAD vs `harness.commit`。
3. **`.dev-user-data` 脏目录**（旧 registry/端口/单实例残留）——`rm -rf
   packages/desktop/.dev-user-data` 后重启 dev（runbook S2 排查同款）；P0 全程单目录顺序
   使用，不并发。
4. **dev 端口 17520 冲突 / 双后端竞态（R10）**——`DSH_CHAMBER_CP_PORT` 钉死并同步 Swift
   常量；被占改 17521；Electron dev 与 POC sidecar 分时启动。
5. **electron-dev.mjs:11/53 陈旧 `dist/index.html` 探测**（实产 `dist/web/index.html`）——
   每次 dev 全量重建 renderer：正常但慢，runbook 已登记，勿当死循环故障排查。
6. **A1/A2 中止门含义**——P0 G1 实质缺口 = 承载面证伪；G2 剪贴板/拖拽硬伤给 1–2 天
   归因修复、仍不过即中止；两者都回 design 25 §10 决策 1 重审，绝不硬续；沉没上限 ≈ 2–3
   人-日（W-05 切片论证）。
7. **Apple 凭据缺位只影响 M4/M5 发布门**——M0–M3 零阻塞；发布门按 A6 语义 dry-run 全链
   绿即推进代码、登记外部阻断，不声称完成。
8. **未决实证项别提前锁死**——C1/C2 是 G 门实测项（P0 前不投打包/纵深）；D6 确切 minor
   在用户机依赖装好后以 `ELECTRON_RUN_AS_NODE=1` 跑 Electron 读 `process.versions.node`
   钉入决策记录，M3 入口前闭合即可。

## 一、里程碑 M0–M5 与 WBS

映射：M0 立项门 → M1(P0 POC) → M2(P1 core 拆分) → M3(P2 Swift 壳 v1) →
M4(P3 边沿 + 打包/CI) → M5(P4 实机门禁 + 发布)。

### M0 立项核验与决策包（1–2 人-日）

- 目标：D1–D7 收敛为决策记录（§八 / §0.1 签核表）；核验 design 25 §6.1 验证项 U1
  （userData 实根）；P0 runbook 定稿。
- 做：决策登记表 + G0 环境清单（swift 工具链、`pnpm install --frozen-lockfile`、
  `pnpm run build:renderer` 验证 dev 资产）+ 本机既有 dsh-chamber 目录/bundle id 实况归档。
- 不做：不写产品代码、不改 design 25 正文。
- 前置：design 25 评审过；用户对 D1/D2/D4 方向（可默认先行、M1 出口复核）。
- 产出：本文件（W-02 起即随里程碑更新）；STATUS 词条措辞更新。
- 退出标准：决策表签核（D1=启动 P0、D2=共存 + bundle id `com.dshchamber.native`、
  D4=落位 `macos/`）；`swift --version` ≥6、`xcode-select -p` 有值、`pnpm run typecheck`
  绿、`pnpm run build:renderer` 产出 packages/desktop/dist/web/index.html。

### M1 P0 POC「证伪门」（5–10 人-日；JS+Swift 双人 ≈3–6 日历日）

- 目标：最小 Swift 壳 + 手写 A 桥 + 原型 B 桥 + stub sidecar，在现有 Electron dev
  控制面（真实 control-plane + 静态前端）跑通 G1–G5，并完成 **1 invoke + 1 push +
  1 原生 edge 垂直切片**（W-05）。
- 做：`macos/` SwiftPM 骨架、WKWebView 载 http://127.0.0.1:<dev-port>/、ATS、A 桥 3
  通道手接（info、desktop_ssh_instances_get、desktop_ssh_status_changed 推送）、通知
  click 打桩回环、导航/新窗护栏雏形、W1/W3 预检、G 门走查登记。
- 不做：不拆 main.ts、不写 Swift 业务、不做 manifest 管线（手写常量）、不做打包；其余
  57 通道按 **loud 拒绝 {error:'poc-unimplemented'}**（绝不静默，UI 按既有错误投影呈现）。
- 产出：`macos/` SwiftPM 骨架与 Poc target（AppDelegate/MainWindowController/
  BridgeShimInjector/MessageHandler/BridgeProto）+ `packages/desktop/poc-sidecar.ts`
  （P1 由 sidecar-entry.ts 替换）；Electron 侧零改动。
- 退出标准：G1 主界面无功能缺口；G2 剪贴板/拖拽/外链正常；G3 侧栏 git/open-in/
  settings-bridge 可用；G4 深链冷启动不丢、通知点击激活（打桩语义）；G5 退出/隐藏/唤醒
  与 Electron 一致——全部手动走查 + 证据登记（P0 不加自动化门禁）。任一实质失败 → 停止，
  回 §七 A1/A2，重审 D1。

### M2 P1 core 拆分（10–15 人-日；JS×2 ≈7–10 日历日）

- 目标：main.ts 拆 `shell-core.ts`（业务 + 60 handle + 8 事件源 + 退出/深链/通知/裁决
  状态机）+ `electron-edges.ts`（Electron HostEdges）+ `node-edges.ts`（B 桥
  HostEdges）+ `sidecar-entry.ts`（纯 Node 装配）；Electron 零回归；
  `stdio-driver.ts` + 60 通道冒烟——**先于任何 Swift 把 B 桥协议用 JS 测试资产钉死**。
- 做：design 25 §4.1 HostEdges 全量注入化；mirror 测试同步（MAIN_SIDE_FILES）；
  core 禁 electron 门禁测试（挂 desktop test 链）；**control-plane-module isPackaged 门
  flavor 化**；sidecar 由假 Swift 驱动跑全量冒烟。
- 不做：不改语义/状态机顺序、不新增 IPC 通道、不动 control-plane/renderer/插件、
  不做 Swift。
- 产出：`packages/desktop/{shell-core.ts,electron-edges.ts,node-edges.ts,
  sidecar-entry.ts,stdio-driver.ts}` + `electron-free-gate.test.ts` +
  `sidecar-stdio.test.ts` + `tsconfig.sidecar.build.json` + `scripts/build-sidecar.mjs`；
  改 main.ts（变薄）、ipc-surface-mirror.test.ts、desktop package.json（test 链 +
  scripts）、根 package.json（新增 dev:sidecar）。
- 退出标准：`pnpm run test:desktop` 绿（含扩展 mirror）+ `pnpm run typecheck` +
  build:preload 绿；dev 双跑手测清单过（§四批 2）；`node packages/desktop/
  sidecar-stdio.test.ts` 绿（60 invoke 回包 + 8 push 采样）。**D3 此出口拍板。**

### M3 P2 Swift 壳 v1（15–20 人-日；Swift×1 + JS 辅助 ≈11–14 日历日）

- 目标：E1–E14、E16–E20 落地（E15 走"保留禁用待重录"），manifest 生成管线 + Swift 护栏
  全量、A 桥 9+4 面全通道对拍、双端冒烟 harness 跑通。
- 做：Supervisor/启动状态机/目录锁；B 桥客户端 + XCTest；A 桥完整 shim + 四护栏（主
  frame/origin/尺寸上限/白名单）+ 导航三段阻断；窗口与菜单；通知/角标/深链；唤醒/
  keep-awake/对话框/外链/open-in/登录项/崩溃恢复；E15 判别路径 + 判别单测。
- 不做：不做 Sparkle、不做打包/签名/公证、不改 JS 业务语义、不做 Swift 原生 UI 渐进
  （路线 B/C，D5 范围外）。
- 前置：M2（shell-core/HostEdges/stdio-driver 定稿）；**D6 此入口拍板**。
- 产出：`macos/Sources/DSHChamberApp|DSHChamberBridge|DSHChamberEdges` +
  `Sources/DSHChamberPoc/Generated/BridgeManifest.swift`（生成物、提交）+ XCTest + `packages/desktop/
  scripts/emit-bridge-manifest.mjs` + `bridge-manifest.json`（提交物）+
  `bridge-manifest.test.ts` + `bridge-shim.ts` + build-bridge-shim.mjs +
  bridge-shim.test.ts + swift-harness-driver.test.ts（node 拉起 Swift harness）。
- 退出标准：`swift build` + `swift test` 全绿（负例：伪造 frame/超大帧/非协议流/伪造
  事件名）；bridge-manifest.test.ts 绿（生成物 == 提交物）；harness 真窗口断言
  invoke/事件/edge 往返；`pnpm run test:desktop` 照旧绿。

### M4 P3 边沿完整 + 发布管线（10–15 人-日；双人 ≈8–11 日历日）

- 目标：更新 v1 **blocked-available 诚实形态**（真实 check + installBlockedReason，D3
  默认）或 v2 Sparkle（按决策）；sidecar Node 捆绑与装配；
  build-swift-app.mjs（swift release + 资源 + 签名 + dmg/zip）；CI 新增 macOS 腿
  （push 门禁）与 release Swift 产物腿；双端同 tag 发布演练。
- 做：更新 seam Swift adapter（**blocked-available：真实 check → phase='available' +
  installBlockedReason='原生壳不支持自动安装'、update-restart 明确错误**、UI 文案诚实，
  禁用 idle|error 假降级与「检查=打开发布页」合并——design 25 §7 E1 语义）；Node fetch
  （arm64、SHA-256）→ .app/Contents/Resources/
  sidecar/node（**必须命名 node**）；签名/公证照抄 release.yml mac 腿既有做法；ci.yml
  新增 test-macos job；release.yml 新增 Swift 产物腿；test:release-workflow 同步。
- 不做：不做 x64（v1 arm64-only）；不做 Keychain 加密 edge（D7 默认推迟）；不做 Sparkle
  除非 D3 反转。
- 前置：M3；Apple 凭据（无则 dry-run 登记、发布门挂起——STATUS 已登记 Electron mac
  同款外部阻断，A6）。
- 产出：`macos/scripts/build-swift-app.mjs`、macos/Info.plist 模板；改 ci.yml、
  release.yml；sidecar 装配目录约定 `.app/Contents/Resources/sidecar/{node,sidecar.js,
  dist/}`。
- 退出标准：dry-run 全链绿——`pnpm run dist:desktop:mac` 与新增 build:swift 在 macOS
  runner 均出 dmg；swift test 在 CI 绿；draft release 双产物齐备；
  `pnpm run test:release-workflow` 绿。

### M5 P4 实机门禁 + 双端同 tag 发布（5–10 人-日）

- 目标：design 25 §8.5 打包态全链矩阵 + W1–W6 parity 判定 + 性能基线对照（§七双端
  性能/产物体积验收协议）；双端同 tag 正式发布；STATUS/todo 收口。
- 做：按 STATUS 既有清单风格登记残余；性能对照 docs/progress/performance-baseline.md
  方法（启动/切换；内存与体积见 §七双端协议）；W1–W6 判定（§七标准）；CHANGELOG。
- 不做：新功能；非阻断残余只登记。
- 退出标准：门禁矩阵全勾或残余显式登记；双端产物同 tag 发布且冒烟过。

**3 人并行压缩与串行依赖总览**：M0 单人 1–2 → M1 双人（JS sidecar 线 ∥ Swift 壳线）
→ **串行点① M1 出口 G 门** → M2 双 JS（A 线 W-09→10；B 线 W-11→13）→ **串行点②
M2 出口（Swift 开工前置：B 桥协议定稿 + sidecar 可起 + HostEdges 定稿）** → M3 Swift
主链 + JS 辅助（W-17/18 JS 半、harness node 侧、打包脚本预研）→ **串行点③ M3 出口**
→ M4 双人（打包/CI）→ **串行点④ M4 dry-run 绿** → M5 单人收口。单人全链合计
46–72 人-日。

## 二、WBS 任务表（W-01…W-32）

| ID | 里程碑 | 依赖 | 动作要点 | 验收 | 估时(人-日) |
|---|---|---|---|---|---|
| W-01 | M0 | design25 评审 | 核验 U1 实根 + G0 环境清单 + 决策包（D1/D2/D4/D6 初定）+ **登记 .lock 秘密文件纪律项（design 25 §6.3，随 D1 立项）** | 决策表签核；G0 命令全绿 | 1–1.5 |
| W-02 | M0 | W-01 | 本文件建立 + STATUS 词条更新 | 文档合入 | 0.5 |
| W-03 | M1 | W-01/02 | SwiftPM 骨架 + 最小窗口 WKWebView loadURL dev 控制面 + ATS；swift build 绿 | 窗口渲染 dsh UI | 1.5–2.5 |
| W-04 | M1 | W-03 | 手写 A 桥 shim 雏形（info/instances_get + status 订阅），mainFrame/origin 护栏雏形 | 页面 console 见 info 返回 | 1–1.5 |
| W-05 | M1 | W-04 | 最小垂直切片（论证见下） | 三拓扑全通 | 1.5–2.5 |
| W-06 | M1 | W-03 | G1 主界面 + G3 侧栏插件走查登记 | G1/G3 过或无实质缺口 | 1 |
| W-07 | M1 | W-03 | G2（剪贴板/拖拽/外链/非 http(s) scheme）+ G5（退出/隐藏/唤醒）= W1/W3 预检 | G2/G5 过 | 1 |
| W-08 | M1 | W-05/06/07 | G4 深链冷启动 + 通知点击（打桩）；POC 报告 + D1 门评审 | G1–G5 全过；否则中止流程 | 0.5–1 |
| W-09 | M2 | M1 出口 | B1 纯搬运：shell-core.ts 骨架；main.ts 无 Electron 依赖的纯逻辑整段机械迁入（语义零变） | test:desktop 绿 + typecheck | 2–3 |
| W-10 | M2 | W-09 | B2 seam 化 + 处理器迁入：HostEdges 定稿（v2 字段集含 resolveResource/isPackaged/webViewLoading/webViewContentAlive/onMainWindowShown/focusMainWindow，E8 的 picker=插件源 folder\|.tgz，无 pickDirectory）；Electron 副作用点注入化；60 handle + 8 事件源迁入 shell-core；同批改 ipc-surface-mirror MAIN_SIDE_FILES；electron-edges.ts 实现 | test:desktop（含扩展 mirror）绿 + dev 双跑手测清单 | 3–4 |
| W-11 | M2 | W-09 | B3a B 桥服务端（NDJSON/帧长/id 纪律/edge: 往返）+ node-edges.ts | 信封单测 | 2 |
| W-12 | M2 | W-11 | B3b sidecar-entry.ts：--user-data-dir/--dsh-path/--stdio\|--socket、目录锁复验（**flock 不二次**，B2）、cp 装配（同 main 值）、**control-plane-module isPackaged 门 flavor 化/直连 dist**、pre-spawn、**入口 console.* → stderr 重定向（D2）**、**ready 帧最小化 {port,shellVersion}（D8）**、SIGTERM/SIGINT 优雅 | 纯 Node 起 sidecar 出 ready；退出回收干净 | 1.5–2 |
| W-13 | M2 | W-11/12 | stdio-driver.ts 用具 + sidecar-stdio.test.ts：假 Swift 驱动 60 invoke 回包 + 8 push 采样 | node packages/desktop/sidecar-stdio.test.ts 绿（先于任何 Swift） | 1.5–2 |
| W-14 | M2 | W-10/13 | CI 门禁：electron-free-gate.test.ts（core 禁 electron + 白名单正例）挂 desktop test 链；拆分评审 + D3 拍板 | test:desktop 含新测试绿；评审记录 | 1 |
| W-15 | M3 | W-12 | Swift Supervisor：spawn/守护/restartBackoff/退出码/日志；目录锁先取 | XCTest（假进程起停/backoff） | 2–3 |
| W-16 | M3 | W-11/15 | B 桥客户端（Swift）：行解析/帧长/超时/edge 回执；主队列串行 dispatch | XCTest：信封/乱序/超大帧/非协议流负例 | 2 |
| W-17 | M3 | W-10（可∥15/16） | manifest 管线：emit-bridge-manifest.mjs（输入 ipc-events.ts + preload.cts → bridge-manifest.json + BridgeManifest.swift）+ bridge-manifest.test.ts；通道数守恒断言（68 = 60+8） | 生成物==提交物绿；Swift 白名单 XCTest | 2（JS1+Swift1） |
| W-18 | M3 | W-17 | A 桥完整化：bridge-shim.ts（9 面全通道 + 4 标量 + 订阅 + 10×50ms info 重试 + 防覆盖）+ build-bridge-shim.mjs + bridge-shim.test.ts；Swift 四护栏 + 导航三段 | bridge-shim.test.ts 绿；负例 XCTest 绿 | 2.5–3.5 |
| W-19 | M3 | W-15 | 窗口/菜单/生命周期 E1/E2/E3/E20：orderOut、Dock 恢复、单窗重建、NSMenu+Edit、applicationShouldTerminate 复刻 before/will-quit + 本地实例在跑 NSAlert | Cmd+C/V/A、关窗隐藏、退出确认手测 + 单测 | 2–3 |
| W-20 | M3 | W-16/18 | 通知/角标/深链 E4/E5/E13 + click 回环（click→B 桥→core 队列） | 通知点击激活、深链冷热不丢 | 2 |
| W-21 | M3 | W-18/20（可拆∥） | 唤醒/keep-awake/对话框/外链/open-in/登录项/崩溃恢复 E6–E12/E14/E18/E19 + E15 判别路径（保留禁用 + 单测） | 每 edge 手测 + 单测 | 2.5–3.5 |
| W-22 | M4 | W-10+D3 | 更新 v1 **blocked-available 形态**（§0.1-E1）：Swift 控制器真实 check（复用 updater.ts 纯函数 + isAllowedReleaseUrl）→ phase='available'+releaseUrl+installBlockedReason='原生壳不支持自动安装'；update-restart 显式错误；**info 载荷增 flavor（§0.1-E2）**同步 preload/global.d.ts/镜像测试；UpdateSection blockedCopy 本地化（zh 源 key） | 设置页 blocked 行 + releaseLink 诚实呈现（非失败态）；verify:i18n 绿 | 1.5–2.5 |
| W-23 | M4 | W-13+D6 | sidecar 打包：tsconfig.sidecar.build.json + build-sidecar.mjs（编译 shell-core 全家 + 复用 build-control-plane 产物）+ Node fetch（SHA-256、**命名 node**）+ vendor-dsh/pnpm 装配 + **spawn-dsh 基名解析断言测试（design 25 §4.3 A5：纯 Node 直用 execPath 的前提 = basename ∈ {node,node.exe}）** | 打包态 node sidecar.js --user-data-dir … 出 ready 帧 | 2–3 |
| W-24 | M4 | W-23 | build-swift-app.mjs：swift release + Info.plist/entitlements/资源（icon.icns、bridge-shim、sidecar 拷入）+ codesign + dmg/zip | 本机出可双击运行的签名 app | 2–3 |
| W-25 | M4 | D3 | Sparkle v2（D3=默认「blocked-available → v2」则登记后续 + appcast 预研） | 按决策登记或 appcast 样例 | 0.5–2 |
| W-26 | M4 | W-24 | CI：ci.yml 新增 test-macos（swift build + test + manifest 门禁）；release.yml 新增 Swift 产物腿；test:release-workflow/action-pins 同步 | dry-run 全链绿 | 2–3 |
| W-27 | M4 | W-26 | 双端同 tag 发布演练（产物命名 -native 防碰撞/无冲突/appcast/回归顺序） | 演练记录 + 产物清单 | 1 |
| W-28 | M5 | M4 | 打包态全链矩阵（cp 起动/预启动/连接/网关凭据重录/运行时管理与回退/插件同步/归档对话框/通知点击/深链/隐藏恢复/唤醒/退出确认） | STATUS 风格登记全勾或显式残余 | 2–3 |
| W-29 | M5 | W-28 | W1–W6 parity 逐项判定（§七标准） | 判定记录 | 1.5–2.5 |
| W-30 | M5 | W-28 | 性能基线对照（performance-baseline.md 方法 + §七双端验收协议：注入式探针平移 boot/切换/rapid/eval 四场景）+ **双端产物体积对比登记**（.app/dmg/zip，同机同架构同 tag，目标 ≤ Electron × 0.75） | 数据与体积记录入库（scripts/perf/data/*.json 同族） | 1 |
| W-31 | M5 | W-29/30 | 双端同 tag 正式发布 + CHANGELOG + STATUS/todo 收口 | 发布产物双端可用 | 1 |
| W-32 | M5 | W-31 | R1–R13 实际化复盘 + D1–D7 复核 | 复盘记录 | 0.5 |

### 最小垂直切片（W-05）论证

**切片定义**：一条链路五层全通——① web 页（shim 方法面，如 desktopSsh.instances_get
或 info）→ ② Swift（WKScriptMessageHandler 护栏）→ ③ B 桥原型（NDJSON 往返）→
④ stub sidecar（复用真实纯 Node 模块：注册表 JSON 直读 + transport-manager 的 status
投影事件源——今天就是零 Electron 模块）→ ⑤ 回程两条：invoke resolve 原路返回 + push
经 B 桥 → Swift → evaluateJavaScript emit 回 web；再加 ⑥ 反向 edge：Swift 通知点击打桩
→ B 桥 notification-clicked → core 队列（打桩）→ push 回 web。

**为何选 1+1+1**：60 条 invoke 只有三种拓扑——请求/响应（info 代表：带 10×50ms 启动
重试，是唯一"先 ready 后可用"敏感通道）、单向 push（desktop_ssh_status_changed 代表：
源是真实 transport-manager，载荷 {id,status} 非伪造）、反向 edge（通知 click 代表：
原生能力进 core）。三条各通 = 传输与信任链的形状被证明；余下 57+7 是同一形状的数据
填充。三类失败模式（启动竞态/事件路由与订阅表/edge 回执丢失）都可在切片内观测。

**为何先横切后纵深**：本方案最大假设不是"60 处理器搬得动"（纯体力），而是
"WKWebView + 受信 shim + 进程桥信任链形状成立"。横切（切片）在 P0 用 1–2 周验证
形状；纵深（P1/P2 全通道搬移对拍）若放前面，一旦 G 门暴露 WebKit 拓扑/剪贴板/权限
硬伤，报废整批 60 通道工作量。切片成本 ≈2–3 人-日，沉没成本上限 ≈1–2 周——正是
design 25「先证伪再立项」的工程化表达。**P0 stub 边界**：切片里 3 通道语义校验是
"照搬 main.ts 最小子集 + loud 拒绝其余"的打桩；真正的语义链由 P1 sidecar-stdio.test.ts
（60 通道接真处理器）钉死——切片证「传输与信任链」，P1 证「语义链」，两条证据线互补。

## 三、P0 runbook（M1，从建目录到 G1–G5）

原则：POC 不引入新 root 命令；复用 dev 后端 = 现有 Electron dev 控制面
（electron-dev.mjs：.dev-user-data 隔离 + 17520 起退避 / `DSH_CHAMBER_CP_PORT` 钉死 +
懒构建）。注意：standalone / cli serve 不伺服静态前端（无 --web-dist），不能当 POC
后端；electron-dev.mjs:11/53 探测的 `dist/index.html` 是陈旧路径（实产
dist/web/index.html），每次 dev 会全量重建 renderer——正常但慢，无需处理。

- **S0 环境**：`swift --version`（≥6）、`xcode-select -p`、`pnpm install
  --frozen-lockfile`、`pnpm run typecheck`、`pnpm run build:renderer`。预期：各项 0
  退出；packages/desktop/dist/web/index.html 存在。排查：vendor 未建 →
  `node scripts/dev/ensure-harness-vendor.mjs`；TS 错 → 先修基线。
- **S1 建目录 + 脚手架**：`macos/Package.swift`（executable target DSHChamberPoc，
  平台 macOS 13+，零第三方依赖——AppKit/WebKit 是系统框架）+ main/AppDelegate/
  MainWindowController。预期：`cd macos && swift build` 0 退出。
- **S2 起共享 dev 后端（背景）**：`DSH_CHAMBER_CP_PORT=17520 pnpm run dev:desktop`。
  预期：首次懒构建 renderer → Electron 窗口开，逻辑地址 http://127.0.0.1:17520/。
  排查：端口占 → 换 17521 并同步 Swift 常量；.dev-user-data 脏 → 删除重来。
- **S3 Swift 壳加载 UI**：webView.load http://127.0.0.1:17520/；ATS：[待核] 字面 IP 在
  NSAllowsLocalNetworking 语义下通常豁免；被拦时候选① swift run 挂临时 Info.plist
  （-Xlinker -sectcreate __TEXT __info_plist <plist>）、候选② 改用 http://localhost:
  17520。预期：渲染同款主界面（veil → 侧栏）。排查：白屏 → 确认根路径 /（__DSH_BOOT__
  只在 / 注入）；仍白 → Safari 开同 URL 对照；debug 构建开 developerExtrasEnabled 看
  inspector。
- **S4 A 桥雏形**：bridge-shim.poc.js（WKUserScript、.page world、documentStart）：
  挂 9+4 面形状（标量 null + 面中只实现 desktopSsh 最小集与 settings 最小集，其余方法
  统一 loud `Promise.reject({error:'poc-unimplemented'})`，绝不静默）；info 10×50ms
  重试照搬 preload；postMessage({id,method,payload})；**shim 挂出时机二选一对拍
  （Swift ready 后注入 vs documentStart 预定义统一 reject，design 25 §4.4.1 D1）**。
  预期：MessageHandler 收到 info；
  window.dshChamber.controlPlaneUrl === cp origin。排查：未注入 → userScript 时机/world；
  收不到 → handler 名与 WKUserContentController 注册。
- **S5 垂直切片（W-05）**：Swift 接原型 B 桥：spawn `node packages/desktop/
  poc-sidecar.ts`（stdin/stdout NDJSON）；invoke 转发；instances_get 直读 .dev-user-data
  下 registry JSON（无则 {error:'poc-no-registry'}）；状态推送优先真实
  transport-manager，poc 允许最小伪造但必须 loud 标注；通知 edge：打桩点击 → B 桥
  notification-clicked → sidecar 记日志并 push notification-open 回 web。预期：三拓扑
  全通（invoke 拿结果/订阅收 push 且 UI 有反应/点通知有 click 日志）。
- **S6 G1/G3（W-06）**：多实例/会话/设置页逐页目测；git 侧栏项、open-in 项、
  settings-bridge chamber 全局页（settings 面 get/set 走真实 chamber-settings.json
  直读写最简，语义打桩）。
- **S7 G2/G5（W-07）**：富文本复制（代码块）→ 外部富文本 app 粘贴保格式；文件拖
  composer；外链 → 系统浏览器；**非 http(s) scheme（mailto:/vscode://）导航**；
  Cmd+Q/红点关窗/睡眠唤醒后 UI 即时重连；**C1：hide
  ≥30s 后 SSE/WS 心跳不断、唤醒即时重连（backgroundThrottling:false 无 WKWebView
  等价物，design 25 §8.1）；C2：双 flavor 交替使用同一 userData/dsh 实例时 WebKit
  独立存储 jar 的会话 cookie/登录态表现实测**。
- **S8 G4 + 报告（W-08）**：`open "dsh-chamber://…"` 冷启动——dev 态无 bundle 的深链
  模拟 [待核：候选① 临时 Info.plist + 最小打包；候选② NSAppleEventManager 注入；
  候选③ 直调 deep-link intent 队列打桩]；通知点击激活会话。汇总证据 → M1 出口评审
  （D1 门）。

## 四、P1 拆分施工单（M2，先纯搬运后 seam 化）

总顺序：B1 纯搬运（零 seam、零行为变化）→ B2 seam 化 + 处理器迁入 → B3 双 flavor
适配 + sidecar 可跑 → B4 CI 门禁。每批结束跑同一组门禁 + dev 双跑，零回归逐批可归因。

- **批 1（W-09，纯搬运）**：shell-core.ts 建立，自 main.ts 迁入无 Electron 依赖的纯
  逻辑段：深链 intent 队列/归一化去重、通知裁决队列（pendingNotificationOpens/
  BoundedActiveNotifications 语义）、badge 裁决、退出状态机纯逻辑、audit/settings/
  journal 装配数据流、路径族（<userData> 直拼点参数化收口为入参）。形态：只搬不改，
  main.ts 调用顺序不变（先以导出函数被调用，不引入注入）。门禁：`pnpm run test:desktop`
  全绿（此批不触发 mirror 改动——handle 还在 main.ts）+ typecheck。
- **批 2（W-10，seam 化）**：HostEdges 按 design 25 §4.1 **v2 字段集**定稿（含
  resolveResource/isPackaged 能力位 B1、webViewLoading/webViewContentAlive B3、
  onMainWindowShown B9、focusMainWindow D3、pickPluginSource=插件源 folder|.tgz
  design 21 §10 ⑧——**无 pickDirectory** A10）；main.ts 全部
  Electron 副作用点改经注入 edges（通知构造/显示/isSupported、badge 平台门、窗口焦点/
  重建/隐藏、tray 存在性、keep-awake、登录项、openExternal（白名单判定留 core）/
  openPath/showItemInFolder、launchApp、showError/showMessage、
  resume 事件回灌、崩溃恢复回灌、single-instance 仲裁结果、info 的 app 身份字段
  version/dshVersion 注入 + flavor 字段 E2）。60 个 trustedIpc handle 注册体 + 8 个
  send 源按原顺序迁入 shell-core（installIpcHandlers(edges) 装配函数；main.ts 只装配
  并传 electron-edges）。
  **本批必须同 commit 改 ipc-surface-mirror.test.ts 的 MAIN_SIDE_FILES
  （['main.ts'] → ['main.ts','shell-core.ts']，注释说明 shell-core 是实际 owner）**——
  mirror 测试自己是本批受测对象；badge pin 等源码文本断言（renderer-trust.test.ts:
  106-141、transport-manager.test.ts:2185-2188 同族）随迁；同批新增「每个
  IPC_CHANNELS 常量至少被 main 侧使用一次」无死键断言（B12/E8）。门禁：
  test:desktop（含扩展 mirror）+ typecheck + build:preload。
- **批 3（W-11/12/13，双 flavor + sidecar）**：node-edges.ts（HostEdges → B 桥
  edge:request/response/notify）；sidecar-entry.ts（--user-data-dir/--dsh-path/
  --stdio|--socket、目录锁复验（flock 不二次，B2）、cp 装配 webDistDir/stateDir/seed
  源同 main 值、control-plane-module isPackaged 门 flavor 化、pre-spawn、**入口
  console.* → stderr 重定向（D2）**、**ready 帧最小化 {port,shellVersion}（D8）**、
  SIGTERM/SIGINT 显式优雅——Electron 43 下死代码的路径在纯
  Node 真实可达）；B 桥服务端（stdout 唯一协议流、stderr 唯一日志、帧长上限、id 纪律、
  信封 {id,method,payload}/{id,ok,result|error}/{event,payload}/edge:*）；stdio-driver.ts
  （假 Swift：行读写/超时/edge 应答桩）；sidecar-stdio.test.ts（60 invoke 真处理器 + 8
  push 采样，如 settings-set → SETTINGS_CHANGED）。门禁：`node packages/desktop/
  sidecar-stdio.test.ts` 绿（先于任何 Swift）+ 全套既有桌面测试绿。
- **批 4（W-14，CI 门禁）**：electron-free-gate.test.ts（挂 desktop test 链末尾）：
  断言面 A（禁止）shell-core.ts/node-edges.ts/sidecar-entry.ts 及迁移后业务模块（白名单
  之外 packages/desktop/*.ts）源码不含 from 'electron'/require('electron')/
  import('electron')；断言面 B（白名单正例防腐化）main.ts、electron-edges.ts、
  preload.cts、updater.ts 确实含 electron；scripts 目录豁免。CI 触发零额外改动（ci.yml
  已跑 pnpm run test:desktop——desktop test 链即清单单源）。

**Electron 零回归证明（三层）**：① 自动——P1 不改测试文件集，test:desktop 每批绿
（同一 JS 代码面）；② 双跑——窗口 A `DSH_CHAMBER_CP_PORT=17520 pnpm run dev:desktop`
（拆分后 main.ts）；窗口 B 新增 `pnpm run dev:sidecar`（= node packages/desktop/
sidecar-entry.ts --user-data-dir packages/desktop/.dev-user-data --dsh-path
<repo>/ref-dsh）；独立 user-data 或先后启动（顺带验证目录互斥）；同一份用户操作脚本
（连接一例远程/本地、设置读写、通知、深链、退出确认）两窗口各跑一遍行为一致；③ 发行
——M4/M5 同 tag 双产物冒烟（§六）。

## 五、Swift 壳施工顺序（M3–M4）与分工线

**脚手架取舍**：SwiftPM（macos/Package.swift）而非 xcodeproj——单文件描述、无
pbxproj 合并冲突、swift build/test 直接进 CI；代价是 Info.plist/entitlements/资源由
build-swift-app.mjs 后处理注入（-Xlinker -sectcreate 或打包时写入 .app），Xcode GUI
调试经 SPM 打开可接受（luochenw 无 Xcode 工程先例）。

**顺序（每步最小验证）**：1. 脚手架 + 最小窗口（W-03 已证）→ 2. Supervisor（W-15；
XCTest 用假长跑进程断言起停与 backoff）→ 3. B 桥协议与解析（W-16；解析器单测先行，
纯文本驱动不 spawn）→ 4. A 桥 shim + 护栏（W-18 前半；先 info，四护栏 + 导航三段）→
5. 首批 edges（openExternal/showError/showMessage/通知 click 回环；每 edge 手动冒烟 +
负例）→ 6. 窗口与菜单（W-19；Cmd+C/V/A 依赖 Edit first-responder）→ 7. 通知/角标/深链
（W-20）→ 8. 对话框/外链/唤醒/keep-awake/登录项/崩溃恢复 + E15 判别（W-21）→
9. 更新 v1（W-22）→ 10. 打包/签名/公证/CI（W-23/24/26）。

**可并行线**：Swift 单链 1→2→3→4→5 为串行地基（B 桥客户端依赖协议定稿、护栏依赖
shim）；6/7/8 在 4/5 后可拆三人并行。JS 侧并行任务（M3 期间 JS 资源不闲置）：
manifest 生成管线 + 测试（W-17 JS 半）；bridge-shim.ts + 产线 + 测试（W-18 JS 半）；
harness node 驱动侧（swift-harness-driver.test.ts，loopback-http-test-server.ts 同款
思路）；更新 seam JS 半（W-22 adapter 桩 + 文案/locales）；打包脚本 JS 半（W-23/24
node 部分）；release-workflow 策略测试预研（W-26 JS 半）。红线：JS 侧任务不得改
shell-core 语义或新增 IPC 通道而不走 mirror/manifest 双锁步（§六）。

## 六、双线防漂移门禁清单与同 tag 发布草案

| 门禁 | 文件（除注明均新增） | 触发点 | 断言什么 | 挂载 |
|---|---|---|---|---|
| IPC 面镜像锁步 | 改 ipc-surface-mirror.test.ts（MAIN_SIDE_FILES 增 shell-core.ts） | 每次 push（desktop test 链） | main handle/send 集合 == preload invoke/on 集合；无裸字面量；字面量 ∈ IPC_CHANNELS；preload/renderer global.d.ts/settings-connections 结构镜像 | desktop test 链 |
| bridge-manifest 一致 | bridge-manifest.test.ts + scripts/emit-bridge-manifest.mjs + 提交物 packages/desktop/bridge-manifest.json + 生成物 macos/Sources/DSHChamberPoc/Generated/BridgeManifest.swift（提交） | 每次 push | 重新生成的 JSON/Swift == 提交物（通道增删改必须同 PR 提交新 manifest）；通道数守恒 68=60+8 | desktop test 链；macOS CI 另跑 swift test 断言 Swift 白名单 == JSON |
| core 禁 electron | electron-free-gate.test.ts | 每次 push | 面 A core 家族无 electron import；面 B 白名单文件有 | desktop test 链（ci.yml 免改） |
| A 桥 shim 一致 | bridge-shim.test.ts | 每次 push | shim method→channel 映射 == manifest invoke 集；on 通道 == push 集；info 重试常量与信封 {id,method,payload} 钉死 | desktop test 链 |
| sidecar 全通道冒烟 | sidecar-stdio.test.ts | 每次 push | 假 Swift 驱动 60 invoke 回包 + 8 push 采样（真处理器） | desktop test 链 |
| Swift 负例护栏 | macos/Tests（XCTest） | swift test（macOS push CI + 本地） | 伪造 frame/超大帧/非协议流/伪造事件名/越 origin 全拒 | 新增 ci.yml test-macos |
| 双端 harness | swift-harness-driver.test.ts（node 侧） | 手动/发布前（需 mac + GUI，不进普通 push 链） | 拉起 Swift harness 断言真实窗口/桥/通知/深链 | release 演练 + M5 |

职责划分：ipc-surface-mirror 管 JS 面（main/preload 两侧字面量与结构）；bridge-manifest
管 JS↔Swift 面（通道全集、方向 invoke|push、归属命名空间、Swift 可执行白名单）——两者
同源派生自 IPC_CHANNELS + preload 字面量；mirror 验证"两侧相等"，manifest 验证"Swift
侧是同一集合的可执行投影且不漂移"。**Swift 产品代码禁止手写通道字符串**（测试 fixture
除外）。通道增删改 = 一次 PR 内三侧同改：ipc-events/preload（+ renderer 镜像）→
bridge-manifest 重生成 → Swift 引用点，漏改由上述测试红掉。

**双端同 tag 发布流程草案**（D2=共存默认）：单 repo 单 tag vX.Y.Z。顺序：push CI 全绿
（含上述全部 JS 门禁）→ release.yml create-release（Apple 凭据 fail-closed 门照抄）→
Electron mac 腿（现 build-macos：dmg/zip/latest-mac.yml）与 Swift mac 腿
（build-swift-app.mjs：`dsh-chamber-native-<ver>-macos-<arch>.dmg/.zip` + appcast-native
.xml（v2 起）并行构建上传 draft（产物名带 -native 防碰撞，appcast 独立 EdDSA 密钥）→
双产物齐 → 双端冒烟（M5 矩阵 + harness）→ publish。回滚预案：Swift 产物出问题 → draft
不 publish、Electron 照发（Electron 是共存主通道，Swift 可晚一 tag 跟上）；Electron 出
问题 → 同 tag Swift 不单独发（防版本错位）。Win/Linux 腿不受影响。

## 七、风险与中止条件

**风险登记（design 25 §9 R1–R13 同源；companion 侧展开，措辞以 design 25 §9 为准）**：
- R10 开发期双后端竞态：Electron dev（17520+）与 sidecar dev 共享 cp 起始端口
  族 → 各自退避 + `DSH_CHAMBER_CP_PORT` 钉死 + .dev-user-data 双目录（或先后启动）；
  目录锁在 M3 前以单进程假锁演练。
- R11 Swift 侧人手单点：壳 + 桥 + 护栏 ≈25–35 个 Swift 文件的长期维护面；
  缓解 = 护栏规则集中于 DSHChamberBridge 单 target、XCTest 覆盖率门、Generated 产物
  减少手写面。
- R12 manifest 生成脚本解析脆弱性：若用正则扫 preload 字面量（mirror 同款
  手法），新写法（模板串/别名）会漏检 → 生成脚本复用 mirror 解析函数并加「通道数守恒」
  断言（68=60+8），防静默漏一条。
- R13 WKWebView devtools：debug 构建才开 developerExtrasEnabled，发布态由
  build 脚本保证关闭（inspector 属信任边界）。

**WKWebView 实测项 W1–W6 判定标准（过/不过）**：

| 项 | 过 | 不过 | 不过处置 |
|---|---|---|---|
| W1 剪贴板（E16，富文本复制/粘贴） | 会话复制富文本（代码块/表格）粘贴进外部富文本 app 保结构；页内粘贴正常 | 仅纯文本/结构丢/粘贴被吞；或写剪贴板需弹权限而 UI 无流程 | 归因（渲染 vs 权限），修复预算 ≤2–3 人-日；超预算或 P0 期失败 → 中止 A2 |
| W2 菜单快捷键（E3） | Cmd+C/V/A/全选与 Electron 一致 | 快捷键无响应（first-responder 断） | 必修（design 25 明示），修菜单/响应链 |
| W3 富文本粘贴 + 文件拖拽（G2） | 拖文件进 composer 成附件；拖进归档对话框入口可用 | 拖拽无反应或触发导航 | 同 W1 |
| W4 打印/查找 | Cmd+P 弹系统打印对话框且内容合理；Cmd+F 若 dsh UI 未实现查找则 N/A（登记不视为失败） | 打印无对话框/空白 | N/A 不阻断；真失败按渲染差异排查 |
| W5 字体/滚动/IME | 中文输入无吞字/乱序；长会话滚动无感卡顿；无方块字 | IME 丢字；滚动明显劣于 Electron；字体破损 | 归因 WebKit 渲染差异 → 按 W1 预算 |
| W6 后台节流对 SSE/WS | 隐藏/失焦后 SSE/WS 心跳不断、恢复即时（≤现 Electron 语义） | 后台 WS 掉线且无法自动重连或恢复 >30s | 归因 WebKit 节流 → 改 keep-alive/唤醒补发（core 已具备） |

### 双端性能与产物体积验收协议（P0 预检 / M4–M5 定标）

> 依据 performance-baseline.md 纪律——**"前后对照只在同环境 A/B 内可信，跨环境
> 绝对值不可比"**：双端所有对比必须同机、同脚本顺序、同会话窗口执行，数据落
> `scripts/perf/data/*.json` 同族（Swift 侧新增注入式采集，见下）。

**方法学平移（不换尺）**：现有 `scripts/perf/{boot,switch,eval,cdp-lib}-measure.mjs`
是 CDP 驱动（Electron 专属）。Swift 侧用 **WKUserScript 注入同一套
PerformanceObserver('longtask'/'paint'/'layout-shift') 探针 + evaluateJavaScript
驱动合成 MouseEvent**（与现脚本同源注入代码，引擎无关），四场景平移：boot（骨架 →
内容 wall/长任务/CLS）、跨来源切换、rapid×10 连点、eval 归因。页面驱动脚本与数据
schema 双端共用一份，差异只在注入通道（CDP ↔ WKUserScript）。

**阈值三形态**（数值为建议初值，P0 双端首测后校准登记，不作跨环境承诺）：

| 形态 | 指标 | 建议预算 |
|---|---|---|
| 相对门（同机 A/B） | boot wall / 切换 / rapid×10 | 原生 ≤ Electron × 1.3 / × 1.5（长任务与 CLS 结构只登记不设硬门） |
| 绝对预算 | IPC invoke p95（60 通道抽测代表组） | ≤ 20ms |
| 绝对预算 | 事件推送突发 | 100 事件/秒不丢序（core 有界队列语义） |
| 能力门 | 后台隐藏 ≥30s SSE/WS 心跳 + 唤醒恢复（C1） | 心跳不断、恢复 ≤ 现 Electron 语义；不过 → keep-alive/唤醒补发，登记已知降级或修复 |
| 能力门 | 内存峰值 / 空闲唤醒次数与进程数 | 内存 ≤ Electron × 0.7；进程数/唤醒登记对比 |
| 能力门 | **产物体积（M5 定标；M0 起可 dry-run 先采 Electron 基线）** | .app 安装体积 / dmg / zip / 磁盘展开，目标 ≤ Electron × 0.75（口径 `du -sh` + 文件大小） |

**数据纪律**：P0 只做"数量级异常预检"（引擎级灾难性回归早暴露，不定标）；正式
定标在 M4/M5；任何跨会话/跨环境数字不得直接作差异结论。

**中止/回退触发点（任一失败即回 design 25 §10 决策 1 重审，不硬着头皮继续）**：
- A1：P0 G1 主界面实质功能缺口（不能归类 minor 样式）——WKWebView 承载面证伪。
- A2：P0 G2 剪贴板/拖拽硬伤（W1/W3 不过，G3=侧栏插件不受影响）——先试 1–2 天归因修复，
  仍不过即重审。
- A3：B 桥护栏负例可击穿（伪造 frame/超大帧/非协议流/伪造事件名任一穿透）——信任模型
  fail-closed 无法保证 → 立即停止，P2 出口前必须闭合。
- A4：P1 拆分后 test:desktop 连续 2 个批次无法收敛绿——拆分粒度/顺序错 → 回退上一绿
  commit（保序机械搬移保证可回退）重排批次。
- A5：M3 双端 harness 在真实窗口无法稳定（排除 harness 环境因素后 >1 周）——壳缺陷深
  → 重审壳层策略（Electron 退守不受影响）。
- A6：M4/M5 发布门因 Apple 凭据缺失挂起——不中止路线：dry-run 全链绿即可推进代码，
  发布登记为外部阻断（STATUS 既有语义），但不得声称"完成"。
- A7：P4 性能基线结构性不达标且非修复可解——回 D1 重审。
- A8：bridge-manifest 生成物 ≠ 提交物连续 3 个 PR 反复红——纪律问题 → 暂停 Swift 大
  PR，先修 manifest 流程再继续。

## 八、决策门日程（design 25 §10 D1–D7）

| 决策 | 最迟拍板点 | 默认建议 | 错过后果 |
|---|---|---|---|
| D1 路线确认 + P0 先行 | M0 出口（启动）；M1 出口复核（继续门） | 按路线 A 启动 P0，G1–G5 全过才继续 | 无 P0 门即投 P1/P2，沉没成本上限 1–2 周 → 4–6 周 |
| D2 双壳共存 + bundle id | M0（立项即定） | 共存；com.dshchamber.native | 后改 = 通知授权重来（R4）+ 打包身份返工 + 重复授权 |
| D3 更新路线 | M2 出口（core 更新 seam 形态） | v1 **blocked-available**（真实 check → phase='available'+releaseUrl+installBlockedReason）→ v2 Sparkle | P2 的 update 通道/UI 文案按 Electron 语义误做，P3 返工 |
| D4 仓库落位 | M1 前（POC 建目录即定） | macos/（SwiftPM） | 后移目录 = 全部路径/CI/脚本返工 |
| D5 原生 UI 渐进（路线 B/C） | M2 出口（登记范围外即可） | 不做；HostEdges 边界即未来 B/C 接缝 | 不登记 = 边沿越界无据可依 |
| D6 Node 版本/架构 | M3 入口（sidecar 捆绑落地前） | Node = 与 desktop Electron 43.4.0 内置 Node 大版本对齐 [待核：确切 minor 以安装态 process.versions 为准，候选 = 该大版本最新 patch]；架构 v1 arm64-only（对照 release mac 腿现状）；x64 登记后续 | 捆绑脚本/装配返工；架构后改影响 CI 与产物名 |
| D7 静态凭据加密 | M4 出口复查（v1 默认不做） | v1 诚实 0600 明文 + 旧 safeStorage「保留禁用待重录」；Keychain edge 不排期 | 无后果（HostEdges 扩展向后兼容）；先做则 P1 seam 多 encrypt/decrypt 注入面 |

## 九、总时间线（三档）

> A = 单人全链（最坏串行）；B = 3 人并行（JS×2 + Swift×1，利用率 ≈0.7）关键链日历。
> 外部阻塞不计入，悲观档单列缓冲。

| 里程碑 | 工作量(人-日) | A 单人累计(周) | B 关键链(日历周) | 关键路径说明 |
|---|---|---|---|---|
| M0 | 1–2 | 0.4 | 0.4 | 决策门，串行起点 |
| M1(P0) | 5–10 | 2.4 | 1.2（双人） | 队尾 = W-05 切片；G 门串行 |
| M2(P1) | 10–15 | 5.4 | 1.6（双 JS；串行点②） | W-09→10（JS-A）与 W-11→13（JS-B）汇合 W-14 |
| M3(P2) | 15–20 | 9.4 | 2.6（Swift 单链 + JS 辅助） | Swift 链 15→16→4→6→7→8 最长 |
| M4(P3) | 10–15 | 12.4 | 1.8（双人） | 打包/CI 依赖 M3 全通道可用 |
| M5(P4) | 5–10 | 14.4 | 1.2 | 实机 + 发布，串行收口 |
| 合计 | 46–72 | ≈9.2–14.4 周 | ≈8.8 周 | — |

- 乐观：A ≈9.2 周 / B ≈7 周（门一次过、无 parity 修复、凭据就绪）。
- 基准：A ≈11.6 周 / B ≈8.8 周（每门含 1 次返工迭代）。
- 悲观：A ≈14.4 周 + 外部缓冲 1–2 周 / B ≈11–12 周（W1/W3 各 2–3 人-日、A3 护栏
  迭代、公证往返 2–3 次、M5 补测）。
- 最长链（关键路径）：M0 → M1（G 门）→ M2 JS-A 链（搬运/seam/评审）→ 串行点② →
  M3 Swift 链（Supervisor → B 桥 → A 桥 → 窗口/菜单 → 通知/深链 → harness）→ 串行点③
  → M4 打包/签名/CI → 串行点④ → M5 实机/发布。B 档下 JS-B 线（B 桥服务端/stdio/冒烟）
  在 M2 内并行后汇入 M3 前置，不延长主链；M4 双人并行后收于 M5。

**一句话总结**：M0 先定决策、M1 用「1 invoke + 1 push + 1 edge」五层垂直切片以最便宜的
方式证伪 WKWebView 信任链、M2 把 60+8 通道语义原样搬进纯 Node core 并用 stdio-driver
在写任何 Swift 前钉死 B 桥、M3–M4 让 Swift 只做「边缘执行器 + 护栏 + 窗口」并按
manifest 三侧锁步、M5 双端同 tag 出门；任何一道门不过，回 D1 重审而不是硬着头皮继续。
