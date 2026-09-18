# 25 · macOS Swift 原生壳（路线 A：WKWebView + Node sidecar 全复用）

> 状态：**已实现（路线 A 代码面）**——Swift 壳、A/B 桥、sidecar 装配与打包链已在
> `macos/` 与 `packages/desktop` 落地；正式 D1–D7 签核与 M5 实机/凭据门禁尚未闭合
> （开放项与失效判据见 `docs/progress/STATUS.md`）。本文按路线 A（Swift 写壳、Node
> sidecar 原样承载现有 control-plane 与 desktop 纯 Node 业务）给出契约与装配设计。
>
> **2026 打磨轮（v1 → v2）**：v1 定稿后经三个并行只读 subagent 分面打磨——
> ① 逐条设计评审（本文件 vs 代码，A/B/C/D/E 五维，40+ 条发现）；② 承重假设
> 核验（13 组，输出 文件:行号 证据与 9 条修正）；③ 实施细化计划（M0–M5 六门 +
> WBS W-01…W-32 + runbook + 门禁/中止条件，落于
> `docs/progress/todo/macos-swift-v1.md`）。评审裁决：**可立项性通过（无
> Blocker），核心复用面事实全部成立**；Major 级修正已并入本版（§0.1 闭合
> 清单），路线 A 前提未被推翻。§2 外部仓库事实为 GitHub 检索所得 [待核-外部]；
> 涉 vendor 官方 UI 的行为判断标 [待核]（打磨轮当时 vendor 未物化；
> `vendor/harness-packages` 现已物化，复核时按该树现取）。
>
> 外部决策见 §10（平台策略、bundle id/共存、更新路线、仓库落位、Node 版本钉住）
> ——实现按推荐默认值落位（共存、`com.dshchamber.native`、blocked-available、`macos/`、
> arm64），签核未闭合；实施执行计划见 todo companion
> （docs/progress/todo/macos-swift-v1.md）。§8.1 的 P0 验证门代码面已交付；
> G2–G5 与 **WebKit 后台节流/存储隔离（C1/C2）** 的实机判定仍开放。
>
> **行号锚点**：正文中涉及 `main.ts` 的 `:NNNN` 多数取自 P1 拆分前（5,802 行）
> 基线；拆分后行号已漂移，引用前按符号名/文件名 grep 现取（其余文件的锚点
> 为核对当时值）。
>
> 相关既有契约：05（§7.4 IPC 白名单 / §7.5 本地实例）、11（自动更新）、13
> （远程插件编排）、14（休眠/唤醒/设置）、16（VS Code 深链）、17（gateway
> 会话与凭据）、18（dsh 运行时版本管理 + apply-now）、19（桌面通知投影）、20
> （open-in 注册表）、21（gateway 插件对齐）、24（归档清理）。

## 0. 摘要（给决策者的三分钟版）

- **路线 A 的定义**：Swift/AppKit 只实现"壳"（窗口、WKWebView、菜单/托盘/
  通知/角标/深链/对话框/外部打开），**壳内不承载任何业务**；业务 = 现有
  control-plane（纯 Node ≈14.2k 行）+ desktop 纯 Node 业务模块族（包根 *.ts 的
  electron-free 家族，`electron-free-gate.test.ts` 传递闭包断言），
  以**打包为独立 Node 可执行文件的 sidecar 子进程**原样运行，Swift 与它之间
  走一条受信的 stdio JSON-RPC 通道（B 桥）；Web UI 100% 复用，仅把 preload
  的 `window.dshChamber` 换成一个等价的注入 shim（A 桥）。
- **为什么可行（现状核实）**：① **真实依赖 Electron 的仅 4 个文件**——
  main.ts（编排，3,982 行）、electron-edges.ts（HostEdges 的 Electron 实现，
  367 行）、preload.cts（941）、updater.ts（1,413），其余业务模块零 Electron
  import、测试直接 `node *.test.ts` 可跑（transport-manager.ts:56 提到 electron
  的只是注释，不是导入；`electron-free-gate.test.ts` 以传递闭包断言该边界）；
  ② 控制面本来就是 loopback HTTP/WS 服务，与宿主只通过
  `createControlPlane(options)` 参数握手（options 全字段可选，
  control-plane/src/index.ts:159-227）；③ dsh 实例本身是 Node 进程，
  `spawn-dsh.ts` 的 node 解析在纯 Node 进程自动走 `process.execPath` 分支
  （前提：**捆绑二进制基名必须是 node**，见 §4.3）；④ 桥接面已收敛：60 个
  `ipcMain.handle` + 8 个 push 事件，通道名集中在 `ipc-events.ts` 的
  `IPC_CHANNELS`（68 键 = 60 invoke + 8 push），由 `ipc-surface-mirror.test.ts`
  锁步（锁步范围 = 通道名字符串集合 + 类型/字段镜像）；桥 manifest
  （`bridge-manifest.json`，提交物）另带**通道 + 方向**两维，命名空间归属单源在
  preload/shim 暴露面并由 `bridge-shim-surface.test.ts` 锁步（§4.4.3）。
- **工作量（熟练工程师人-日；三档排期随执行收口，量级见本节末）**：M0
  1–2 → M1 5–10 → M2 10–15 → M3 15–20 → M4 10–15 → M5 5–10（单位均为人-日）；
  合计 **46–72 人-日（9–14 人周）**。Electron 版全程并行保留（P1 的前提），
  Win/Linux 不受影响。
- **不做什么**：不重写 UI（对照 luochenw/deepseek-harness-macos 的全原生
  路线，那是 3–6 人月起步并伴随永久 parity 维护）；不在 Swift 里重写宿主
  服务（对照 summer-521/deepseek-harness-swift 约 900KB Swift 服务层 + 自研
  JS desktop-host，它的路线是我们的路线 B，见 §2 对照）；不碰 gateway 服务端
  形态。
- **关键决策点**：macOS-only 意味着与 Electron 三平台版是**双壳共存**还是
  **替换**；bundle id 是否与 Electron 版区分（影响通知授权身份）；更新走
  「v1 诚实 blocked-available 形态 + v2 Sparkle」；双线防漂移纪律（§4.4.3 /
  §9 R1）。

### 0.1 v1 → v2 打磨轮闭合清单（评审 Major/Minor 处置摘要）

> 编号说明：本表「来源」沿用评审报告五维分类（A 事实 / B 完整性 / C WebKit /
> D 语义 / E 一致性），其中 E1/E2/E7/E8 与 §5 原生边沿表 E1–E20 **分属不同
> 编号域**；正文引用写作「§0.1-E1」等以示区分。

| 来源 | 发现 | 处置 |
|---|---|---|
| A1/A2/A11 | "4 个文件依赖 Electron"笔误；23.5k/21k 行口径高估 | §0/§4.2 口径（P1 拆分后重测）：真实依赖 Electron 4 文件（main.ts/electron-edges.ts/preload.cts/updater.ts）≈6.7k——打磨轮当时为 3 文件（electron-edges.ts 是 P1 新 seam）；纯 Node 业务模块零 import（electron-free-gate 传递闭包） |
| A3 | "port 从 17500 起试"与现状不符 | §3.3 改：**打包固定 17500 无退避**（`shell-core.ts:426-441` 的 resolveControlPlanePort）；dev 从 17520 起 bind 探测首个空闲端口（200 个候选），或按 `POC_PORT` > `DSH_CHAMBER_CP_PORT` 钉死（Swift 侧 ControlPlanePort.swift）；控制面 EADDRINUSE 即失败；**dsh 实例**从 17510 起 +1 ≤5 次 |
| A4 | Supervisor backoff 误引 "5×500ms"（那是 renderer-ready 握手语义） | §3.3 改：sidecar 重启退避另立；renderer 恢复 = 500ms 延迟 + 60s 窗口 ≤3 次 + 15s unresponsive（main.ts:1178-1267）参数化 |
| A5/4.3 | spawn-dsh 纯 Node 分支有 basename 门；Electron 分支另带 --expose-internals | §4.3 写明基名约束 + 解析断言测试；Swift 捆绑 `Resources/sidecar/node` 即满足 |
| A6 | "13 命名空间"实为 4 标量 + 9 命名空间 | §4.4.1 全篇改口径（companion 同） |
| A7 | "macOS 无 argv 扫描"不实（open-url + argv 防御双路径，main.ts:1479-1482/1687） | §4.5 改写 |
| A8 | Electron 从未 setApplicationMenu（Cmd+C/V 靠默认菜单） | §5 E3 现状列改正，Swift 结论不变（W2 必修） |
| A9 | §6.1/§6.4 验证项编号 E1/E2 与 §5 边沿表撞车 | 更名 **U1**（userData 实根）/ **S1**（safeStorage 判别单测） |
| A10 | E8 对话框归属错引 design 24；desktop_pick_directory 已不存在 | E8 = 插件源 folder\|.tgz 一体化 picker（design 21 §10 ⑧ / 13 §5.8）；**删除无消费方的 pickDirectory()** |
| A13 | userData 清单漏 ssh-plugin-journal 与 *.corrupt/.unbound-* | §6.1 补全 |
| B1/B13 | 资源/打包路径 seam 缺失；sidecar 打包双路径解析未写 | §4.1 HostEdges 补 `resolveResource`/`isPackaged` 能力位（≈15 处直拼点 P1 参数化）；§3.2 补 sidecar 打包布局同构（tsc 产物 + dist/web + host 包 + node/pnpm） |
| B2 | §6.3 互斥锁设计缺陷（pidfile stale 模式正是 STATUS 判死刑的；未提 Electron 侧同落地；二次 flock 自锁） | §6.3 改 **flock(LOCK_EX\|LOCK_NB)** + 双 flavor 同实现 + fd 常驻 + 复验不二次 flock |
| B3 | HostEdges 缺渲染器可用性门 | §4.1 补 `webViewLoading()`/`webViewContentAlive()`（或事件状态机进 core）；就绪握手"返回 false → 渲染端有界重试"语义保留 |
| B4 | BoundedActiveNotifications 持 Electron Notification 宿主对象，不能进 core | 对象登记/淘汰属 electron-edges；core 只留 click 回执绑定 + 有界 ACK 队列/去重/限速 |
| B5/D5 | 恢复/ready 复位是三事件面；WKWebView 无 unresponsive 事件 | §5 E19 改事件映射表；unresponsive 腿 v1 明示不可移植（或心跳探测替代） |
| B6 | E20 漏 darwin close-behavior='quit' 分支 | 补：'quit' 时经 NSApp.terminate 走完整确认链，绝不无窗常驻 |
| B7 | E9 缺 fatal 边界与退出码分级 | sidecar fatal 边界 + 非零退出码分级（启动失败 vs 崩溃），Supervisor 分流 NSAlert |
| B8 | E17 漏 child-process-gone | 注明留 electron-edges 不移植 |
| B9 | E6 漏窗口 'show' 补发点 | HostEdges 补 `onMainWindowShown(cb)` |
| B10/C4 | 网页 Notification 双路径风险（WKWebView 无等价预拒绝 API） | §5 E4 加注 + P0 检查项 |
| B11 | openExternal 预算/冷却/规范化语义 | 留 core；edge 只执行 NSWorkspace.open 并 loud 失败 |
| B12 | MAIN_SIDE_FILES/badge pin 测试锚点迁移 + 无死键断言 | §4.4.3/P1 增补 |
| C1 | Electron backgroundThrottling:false 无 WKWebView 等价物 | **2026-12 收敛**：design 14 §D1 修订把 Electron 侧恢复为 Chromium 默认节流（实测隐藏期 rAF 0 / SSE 不受影响），两 flavor 隐藏态行为同向，本项差异消除；**P0 G2/G5 的实机子项保留**（打包态 hide ≥30s SSE 心跳/唤醒 + 隐藏期 CPU，见 STATUS 实机门禁） |
| C2 | WebKit 存储隔离（WKWebsiteDataStore 独立 jar） | §6.2 共存语义写明；**P0 增实测**（双 flavor 交替同实例的会话 cookie/登录态） |
| C3/E6 | 剪贴板读写权限模型差异 | §5 E16 行文精确 + P0 对拍加"粘贴/剪贴板读" |
| D1 | shim 挂出时机 vs preload"先 info 后 expose"语义 | §4.4.1 按实现收敛：documentStart 定义内部管路（带令牌），`dsh-chamber:info` 成功后才暴露 `dshChamber`；未就绪/失败期 invoke 回 `ipc_not_ready`（1+10 次 50ms 重试），全败分支与 preload 同形（surface 在、标量 null） |
| D2 | sidecar stdout=协议流 与存量 console.log 冲突 | sidecar-entry 顶部 console→stderr 重定向；fail-loud 只针对重定向后意外泄漏 |
| D3 | 通知 click 需先激活窗口 | click 顺序 = NSApp.activate + orderFront（含无窗重建）→ 回 B 桥 → core 队列；HostEdges 补 focusMainWindow() |
| D4/D6 | 退出链三分支 + 5s 硬顶 + LOCAL_RUNNING_STATES 判据 | §3.3/§5 E9 补 |
| D8 | ready 帧与 INFO 双源漂移 | ready 帧最小化（port + shellVersion），其余全走既有 dsh-chamber:info |
| E1 | §7 v1 降级用 idle\|error 会让 UI 永不出现入口且显示失败态 | 改用现成 **blocked-available 形态**：真实 check（对比 GitHub Releases，复用 updater.ts 纯函数）→ phase='available' + releaseUrl + installBlockedReason='原生壳不支持自动安装'；update-restart 显式错误 |
| E2 | 共享 renderer 缺 shell-flavor 判别字段（platform 同为 darwin） | 字段已落地（`main.ts:3858` 载荷带 `flavor`，镜像面仍 4 标量）；**UI 能力门最终由 `installBlockedReason`/原生能力位驱动，renderer 未消费 flavor**（零消费者，保留字段不加条件） |
| E7 | W6 应注明无 backgroundThrottling 等价物 | §8.5 W6 注（同 C1） |
| E8 | shim 是第三处通道面，手写会漂移 | manifest 产出 Swift 枚举 + `Resources/chamber-bridge.stub.js` 锁步样本（不随 .app 打包）；真正注入的 `bridge-shim.poc.js` 由 `bridge-shim-surface.test.ts` 对 preload 面逐命名空间锁步 |

## 1. 背景、目标与非目标

### 1.1 背景

dsh-chamber desktop 的 Electron 使用面已收敛为薄壳（AGENTS.md 运行时边界 +
§3 现状核实）：单窗口 `loadURL(http://127.0.0.1:<cp.port>/)`、域限定 IPC、
原生边沿（通知/角标/深链/open-in/托盘/唤醒）+ 运行时管理。全部"重逻辑"
（连接/隧道/会话/插件同步/凭据事务/审计/运行时激活）都住在纯 Node 侧。
这给出了一个罕见的移植条件：**把壳换掉，业务与测试资产原样保留**。

### 1.2 目标

1. macOS 上交付与 Electron 版**功能对等**的原生应用：原生窗口/菜单/Dock/
   通知/深链/系统集成，去掉 Electron/Chromium 运行时（内存、启动、包体）。
2. **零业务重写**：control-plane、desktop 纯 Node 模块、dsh-runtime 及其
   测试全部原样进 sidecar；现有单测/镜像测试继续在同一 JS 代码面上运行。
3. 单一业务源码：Electron 版与 Swift 版共享同一份 core（P1 拆分为前提），
   行为差异只允许出现在"宿主边沿适配层"，且有镜像测试与双端冒烟背书。
4. 信任模型不弱化：B 桥语义校验仍发生在 sidecar（今日 main 所在处），
   Swift 只做传输层护栏；凭据依旧 write-only、永不进 renderer。

### 1.3 非目标（明确不做）

- 不重写任何 Web UI/插件（renderer、dsh 官方前端、chamber 插件面）。
- 不做 Swift 原生 UI 渐进替换（那是路线 B/C，§10 决策 5 单独评估）。
- 不覆盖 Win/Linux（Electron 版继续承担）。
- 不做第二个 gateway、不进匿名控制面的执行域（AGENTS.md 硬纪律不变）。
- v1 不做 Sparkle 全自动安装（见 §7；先诚实 blocked-available 形态）。

## 2. 市场参考仓库对照 [待核-外部]

> 本表为 GitHub Search API 检索所得（2026-08/09 实况，外部事实，无法在本
> 工作树二次核实）。

| 仓库 | 路线 | 形态 | 对我们的可借鉴点 | 不借鉴点 |
|---|---|---|---|---|
| [luochenw/deepseek-harness-macos](https://github.com/luochenw/deepseek-harness-macos) | 全原生 UI | SwiftUI/AppKit 重写整个 dsh 客户端 UI + 内嵌 Node + JS runtime-extras 注入 | `scripts/prepare-dsh-runtime.sh`/runtime 钉版思路；`WEB_PARITY.md` 式功能对等清单；无 Xcode 工程也可行（swiftc 直接构建 + ad-hoc 公证） | 全原生 UI 的工程量（对照 §0）；UI 重写后的永久上游 parity 维护 |
| [summer-521/deepseek-harness-swift](https://github.com/summer-521/deepseek-harness-swift) | WKWebView 壳 + Swift 原生服务层 | AppKit/WebKit 壳；Swift 版版本管理、插件管理、恢复、设置、`NodeRuntime.swift`、Sparkle appcast | **壳层实现形态与路线 A 高度同构**：NodeRuntime + fetch-node/fetch-pnpm 脚本、WKScriptMessageHandler 消息校验、`swift-*-harness.swift` + node 集成测试双端模式 | 它自研的 `assets/dsh-desktop-host/*.js`（≈90KB）正是我们**不需要**的：我们用现成 control-plane 替代 |
| [wheam/deepseek-harness-mac-app](https://github.com/wheam/deepseek-harness-mac-app)、[aibinghezzz-stack/deepseek-harness-macos](https://github.com/aibinghezzz-stack/deepseek-harness-macos)、[guanyifang344/dsh-launcher-mac](https://github.com/guanyifang344/dsh-launcher-mac) 等最小壳 | 最小壳 | 几百行 WKWebView 加载 dsh web | POC 下限证明：WKWebView + NSAllowsLocalNetworking 跑通 dsh web GUI 无障 | 无 IPC/凭据/运行时管理，不可直接作为 chamber 壳 |

结论：市场上**没有** chamber 能力的 Swift 参考实现（SSH 隧道、gateway
会话、宿主包种子、N-ctx 编排），这些在路线 A 中不重写而是复用 sidecar，
因此参考仓库只能校准"壳与打包"部分的成本。

## 3. 总体架构

### 3.1 进程模型

```
┌─────────────────────────────────────────────────────────────┐
│ Swift 应用进程（新：macos/ 壳）                                │
│  AppDelegate / MainWindowController                          │
│  WKWebView ── A 桥（注入 shim ↔ WKScriptMessageHandler）      │
│  原生边沿：菜单/托盘(可选)/UNUserNotificationCenter/角标/     │
│            NSWorkspace(open-in/外链)/NSOpenPanel/NSAlert/     │
│            SMAppService(登录项)/深链 application(_:open:)     │
│  SidecarSupervisor（spawn/守护/重启/日志/fatal 分流）          │
└───────────────┬─────────────────────────────────────────────┘
                │ B 桥：stdin/stdout 行式 JSON-RPC（受信，本机）
┌───────────────▼─────────────────────────────────────────────┐
│ sidecar 子进程（打包的 Node + JS bundle，纯 Node 无 Electron）│
│  = main.ts 拆分出的 core（§4.1）                             │
│    transport-manager / ssh-provider / gateway-provider/…     │
│    60 invoke 处理器 + 8 push 事件源（语义校验原样）           │
│  + control-plane（createControlPlane，loopback HTTP/WS）      │
│  + dsh-runtime / pnpm（运行时版本管理、安装）                 │
│  + 数据面：userData/{state, ssh-instances.json,              │
│    ssh-plugin-journal.json, ssh-passwords.json,              │
│    gateway-secrets.json, chamber-settings.json, audit-log.jsonl, │
│    dsh-runtime trees, 日志}                                  │
└───────────────┬─────────────────────────────────────────────┘
                │ spawn（resolveNodeExecutable 纯 Node 分支）
        ┌───────▼────────┐        ┌──────────────────────┐
        │ dsh web profile │  …N 个  │ 远程宿主（ssh/gateway） │
        │ 实例（Node）     │        │ 经系统 ssh / HTTP      │
        └────────────────┘        └──────────────────────┘
```

- **Swift 壳**不 import 任何业务模块；它是"边缘执行器 + 传输层护栏 +
  窗口"，业务状态全部在 sidecar。
- **sidecar** = 打包产物，传输恒为 **stdio**（无 socket 传输：壳始终以管道 spawn，
  未实现的 `--socket` 不再列为接口面）。实参形状与 `sidecar-entry.ts` 一致：
  `node sidecar.js --user-data-dir <dir> [--dsh-path <dir>] [--web-dist-dir <dir>]
  [--host-graph-dir <dir>] [--host-git-dir <dir>] [--host-archive-dir <dir>]
  [--host-open-in-dir <dir>] [--port <n>] [--native-updater <feed|off>]`
  （pnpm/host 包路径由 sidecar 内部布局解析决定，不再有 `--pnpm-dir` 入参）。
  stdout/stderr 不混业务：
  **sidecar-entry 入口把存量 console.log/console.debug 重定向到 stderr**
  （main.ts 遍布业务日志如端口行 :1787、will-quit 清理完成串 :1673——实机
  门禁断言该串；不重定向则 B 桥首发即撞非协议行）；fail-loud 只针对重定向
  后的意外泄漏；stderr 是唯一日志通道（落 `~/Library/Logs/` 或
  userData/logs）。**sidecar stderr 的透传行另有一份独立有界落盘**：
  `<userData>/logs/sidecar.log`（`NativeShellLog.sidecar.configureSidecar` +
  `BridgeClient.sidecarLogSink`；**规格**：单文件 256 KiB、单份轮转
  `sidecar.log.1`（轮转名按实例文件名派生）、目录 0700 / 文件 0600、写失败静默退
  stdout——与 design 02 §3.8 的控制面 sink 同一种权限纪律，但保留量更小）。
  **两条链的关系（2026-12 复核修正）**：控制面 `<stateDir>/logs/control-plane.log`
  是 WS splice 归因行的**权威**去向，**两个 flavor 都有**（`createControlPlane` 无条件
  包装，02 §3.8 明说共用实现）；`sidecar.log` 是原生壳的**兜底**——它额外覆盖控制面
  sink 建立之前的 stderr（如 fatal 启动输出），代价是同一批 console 行在两处各存一份。
  **flavor 偏差（已登记 deviations）**：Electron 只有 1 份文件、原生壳 2 份（保留量
  Electron 只有 `control-plane.log`（2 MiB × 3 = 6 MiB）；原生壳另有 `sidecar.log`
  （256 KiB × 2 轮转环 = 512 KiB），合计 6 MiB + 512 KiB）。
- dsh 实例与控制面关系完全不变（05 §7.5：`PlaneHandle.startLocal()` 预启动、
  按需 spawn、reaper）；**迁移后 dsh 子进程的 node = sidecar 自身可执行文件**
  （须命名为 node，spawn-dsh 纯 Node 分支，§4.3）。
- **资源路径注入**：Swift 无 Electron 的 isPackaged/resourcesPath 概念——
  sidecar-entry 通过参数注入 .app 内路径：builtin dsh workspace
  （Resources/sidecar/vendor/dsh）、webDistDir（**Resources/dist/web**，由
  AppDelegate 按候选解析：resourceURL/dist/web → sidecar/dist/web）、
  四个宿主包 sourceDir（Resources/sidecar/dist/<pkg>；含 localOnly 的 open-in）、pnpm
  （Resources/sidecar/pnpm；sidecar-ctx 依次探测 moduleDir/pnpm →
  moduleDir/../pnpm → dev node_modules/pnpm）。对应 main.ts 中
  ≈15 处直拼点（350-359/766/1813/1819-1827/4026-4028 等）的 P1 参数化
  （§4.1 B1/B13）。

### 3.2 仓库落位（§10 决策 4 的推荐 `macos/` 已落位）

```
macos/                          # SwiftPM 可执行包（或 xcodeproj）
  Package.swift
  Sources/DSHChamberPoc/…        # 可执行 target（P0 从简；AppKit 壳 + A 桥/B 桥 + 宿主腿同 target，
                                 #  product 化拆 target 未排期——见 Package.swift 头注释）
  Sources/DSHChamberWebKitSupport/… # 静态 C support target（§5.1：关 WebKit prefer-60fps 偏好）
                                 #  ——不是 product 化拆 target，目标文件链进同一可执行文件
  Sources/DSHChamberPoc/Generated/BridgeManifest.swift   # 构建脚本生成（随提交，防漂移）
  Tests/…                        # XCTest（信封解析、护栏、监督、协议）
  Resources/bridge-shim.poc.js   # A 桥注入 shim 真身（bridge-shim-surface 锁步）
  Resources/chamber-bridge.stub.js # manifest 生成物（锁步样本，不随 .app 打包）
  Info.plist.template / entitlements*.plist # W-24 渲染/签名输入
  Resources/                     # 其余运行时占位（sidecar 由构建脚本拷入）
macos/scripts/build-swift-app.mjs       # 调 pnpm 产物 + swift build + 资源装配（W-24 已落地）
packages/desktop/scripts/build-sidecar.mjs  # sidecar 装配（W-23 已落地）
packages/desktop/scripts/emit-bridge-manifest.mjs # IPC 通道 manifest → Swift 枚举 + chamber-bridge.stub.js 锁步样本（§4.4.3）
```

sidecar 的 JS 面不动仓库布局：`packages/desktop` 继续是双 flavor 的宿主
（Electron entry `main.ts` 保留；`sidecar-entry.ts` 及其 host-edge 适配在
§4.1）。sidecar 打包布局 = **编译产物 `dist/control-plane/` + host 包
`dist/dsh-chamber-seed-*/` + 内嵌 `vendor/dsh/` 与 `pnpm/` + 捆绑 `node`**；
renderer 产物 `dist/web` 属 .app 的 `Contents/Resources/dist/web`（不在 sidecar
目录内）。复用 build-control-plane.mjs 的"双路径解析"机制（打包态 import 编译
产物、dev/测试走 pnpm 符号链接，control-plane-module.ts:5-30 同款注释）——
sidecar 与 Electron 共享 `packages/desktop/dist/control-plane`；**host 包不同源**：Electron 走
`build-host-graph-package.mjs` 产的 `dist/host-*-package` 产物，sidecar 直接读
`packages/dsh-chamber-seed-*/{package.json,dist/index.js}` 拷进自己的
`dist/dsh-chamber-seed-*/`（两条腿各自成对，别把一侧的目录名当成另一侧）。

**装配目录（`scripts/build-sidecar.mjs` 的 `sidecarLayout`，:156-172）**：
`<out>/{node, sidecar.js, package.json, dist/control-plane/,
dist/dsh-chamber-seed-*/, vendor/dsh/, pnpm/}`。
要点：
- `sidecar.js` = esbuild 打包的入口（含 shell-core 全家 + sidecar-ctx +
  node-edges + dsh-runtime）；`@dsh-chamber/control-plane`、`electron` 与
  `./dist/control-plane/index.js` 为运行期外部；
- 装配目录必须带 `package.json`（`{type:'module'}` + chamber 版本）——shell-core
  的模块级 `version` 读取（`new URL('./package.json', import.meta.url)`）与 ESM
  判定依赖它；
- **四个 chamber host 包**（T2 包名，`packages/dsh-chamber-seed-{client-graph,
  git-worktree,archive-cleanup,open-in}`）：拷贝进 `<out>/dist/<同名>/`，Swift 侧按
  `--host-graph-dir/--host-git-dir/--host-archive-dir/--host-open-in-dir` 注入
  同一基名（`BuildSidecar.HOST_PACKAGES` 单源；`sidecar-ctx` 的
  `hostPackageSourceDir` dev 兜底也按同名在 `packages/` 下探测）——
  `scripts/release/packaging-manifest-lockstep.test.mjs` 把这组清单在 build-sidecar /
  control-plane / 根构建链 / `HOST_PACKAGE_BUILD_ROWS` / AppDelegate 五处锁步；
  改名/加包要一起改。
- **open-in 是 localOnly 行（design 20 §6）**：它随 .app 分发、**只**喂本地实例
  播种（`sidecar-entry --host-open-in-dir` → control-plane 的
  `hostOpenInPackageSourceDir`）。**远端（SSH）种子表永不携带它**——`sidecar-ctx`
  的远端种子仍是三项可移植行（`portableChamberHostPackageSeeds` 按 registry 的
  `localOnly` 过滤；与 Electron 侧 `chamberHostSourceDirs` 的同款注记同源）；
  把 open-in 加进远端 seed 会把本地形态专属域上传到别人的机器。
- **运行期标记**：Swift Supervisor 在装配态 spawn 时注入
  `DSH_CHAMBER_SIDECAR_COMPILED=1`（`control-plane-module.isPackagedSidecarRuntime`）
  → control-plane 走相对编译入口；装配目录没有 node_modules 树，裸说明符不可解析；
- Node 捆绑落位 `<out>/node`（**基名必须是 `node`**，§4.3 A5），SHA-256 校验
  后才落盘（摘要来源 = 仓库固定表，见 §4.3）。

**`.app` 装配（W-24 定稿，`macos/scripts/build-swift-app.mjs`）**：
`<App>.app/Contents/{Info.plist, MacOS/DSHChamberPoc, Resources/{icon.icns,
DSHChamberPoc_DSHChamberPoc.bundle, sidecar/, dist/web}}`。三条实跑约束：
- **SwiftPM 资源包必须放 `Contents/Resources`**：放 .app 根会被 codesign 判为
  「unsealed contents present in the bundle root」；SwiftPM 生成的
  `Bundle.module` 访问器只查 `Bundle.main.bundleURL`（= .app 根）与构建目录，
  打包态因此改用 `ChamberResources`（resourceURL → bundleURL → 可执行目录）；
- **entitlements plist 不能带 XML 注释**（codesign 的 AMFIUnserializeXML 直接
  报解析失败）；壳侧最小集 = `disable-library-validation`（加载装配目录内
  独立签名的 node 与运行时安装的未签名原生模块），捆绑 node 另加
  `allow-jit` / `allow-unsigned-executable-memory`；
- **control-plane 只能经 `control-plane-module` facade 取**：装配目录没有
  node_modules 树，任何 runtime 裸说明符 `@dsh-chamber/control-plane` 都会
  `ERR_MODULE_NOT_FOUND`；facade 在装配态（`DSH_CHAMBER_SIDECAR_COMPILED=1`）
  加载 `<sidecar>/dist/control-plane/index.js`。
签名顺序 = 嵌套 node 先、主 app 后；Developer ID 时两者均带 hardened runtime
（公证前置），ad-hoc 路径不带 runtime。正式发布仍缺 Apple 凭据（外部阻断）。

### 3.3 启动序列（状态机）

1. Swift `applicationDidFinishLaunching`：解析 argv/深链 → 计算 userData dir
   （§6.1）→ **目录锁**（§6.3）→ 启动 SidecarSupervisor；启动链内 reconcile
   `<userData>/chamber-settings.json` 的 `keepAwake`（缺文件 = off 且无日志、
   损坏 = loud + off、合法 = 经与 settings UI 同一个 `setKeepAwake` 宿主腿应用；
   AppDelegate.swift:322-328 / StartupSettings.swift）。
2. Supervisor：spawn `node sidecar.js`；sidecar 自行完成今日 main.ts 的启动
   职责（目录锁在 sidecar 内复验但不二次 flock）→ `createControlPlane`
   （**端口由 Swift 宿主解析后以 `--port` 注入**：打包态固定 17500、无退避
   （main.ts:253-281，EADDRINUSE 即 loud 失败）；dev 态按 `POC_PORT` >
   `DSH_CHAMBER_CP_PORT` > 17520 起 bind 探测首个空闲端口（200 个候选；
   ControlPlanePort.swift）；**dsh 实例端口从 17510 起 +1 ≤5 次**——05
   §3.3 注）→ pre-spawn 本地实例 → 输出 **ready 帧最小化 {port,
   shellVersion}**（其余身份字段全走既有 `dsh-chamber:info` 通道，保留其
   10×50ms 重试与 null 兜底语义，防双源漂移，D8）。
3. Swift 收到 ready → 用 `http://127.0.0.1:<port>/` 建 WKWebView 并 loadURL
   （A 桥注入时机 = §4.4.1 D1：**documentStart 定义内部管路，`dsh-chamber:info`
   成功后才暴露 `dshChamber`**；info 未就绪/失败期间 invoke 回 `ipc_not_ready`
   （1 次 + 10 次 50ms 重试），渲染端按既有 surface 缺失链自愈）。
4. 运行时故障分级：
   - sidecar 崩溃/非零退出 → Supervisor 按重启退避重启（**sidecar 无 Electron
     先例，退避语义另立**：cp.start 失败 = fatal 退出；运行中崩溃 = 退避重启，
     上限与 renderer 恢复参数化同族）；sidecar fatal 边界 = stderr 记录 +
     非零退出码分级（启动失败 vs 崩溃），Supervisor 据码分流 NSAlert 文案
     （对照现"启动失败/前端异常/打开 VS Code 失败"三个对话框，B7）；
   - WebView 进程终止 → `webViewWebContentProcessDidTerminate` 恢复循环 +
     ready 位复位 + in-flight requeue（§5 E19 三事件映射，对照
     `installRendererRecovery` main.ts:1178-1267：500ms 延迟重载、**60s 滚动
     窗口内至多 3 次**、15s unresponsive 探测——Swift v1 无 unresponsive
     事件，该腿显式不可移植或换心跳探测）；重复崩溃 → NSAlert 停止自动恢复
     （与 `dialog.showErrorBox('前端异常'…)` 同义）。**注意：5×500ms 是
     renderer-ready 握手（deep-link-ready/notifications-ready）的重试语义
     （05 §7.4），不是崩溃恢复语义——勿混用（A4）**。
   - 退出链复刻 before-quit/will-quit（§5 E9/E12/E20 + D6）：确认-取消-重建
     三分支（mac close-behavior='quit' 时窗口已关 → 取消后重建）、keep-awake
     停 → badge 清 → 并行回收（传输层 → 控制面 → 本地 dsh 实例 →
     runtime 资源）→ **5s 硬顶强退**（Swift terminate 超时 = exit(_:)）；
     "本地实例在跑"判据 = cp.localProcessAlive + LOCAL_RUNNING_STATES 同款，
     勿只看 connectionState（main.ts:1544）。
5. SIGTERM/SIGINT：Swift 捕获后转 `terminate` 优雅路径；sidecar 自身也处理
   信号——纯 Node 下 `process.on('SIGTERM')` 真实可达（Electron 43 下是死
   代码，注释 main.ts:1488-1494 自证），需显式转优雅回收。

## 4. 复用与拆分（核心工程）

### 4.1 main.ts 拆分：core / host-edge 契约（P1，Electron 版不回归）

现状：`main.ts`（5802 行）把 ① 业务装配与 ② Electron 边沿调用交织在一起。
P1 拆分原则：**只做搬运与参数化，不改语义、不重排状态机**。

目标形态：

- `shell-core.ts`（Electron-free）：从 main.ts 原样搬入全部业务装配、
  60 个 invoke 处理器体 + 8 个事件源（语义校验原地保留）、退出状态机、深链
  intent 队列、通知 click 有界 ACK 队列/去重/限速（notifications.ts 纯逻辑 +
  main.ts 队列语义）、资源路径参数化收口。
- 依赖注入面 `HostEdges`（下述），以函数/接口注入。判定标准：core 对
  `electron` 零 import（CI lint 门禁，electron-free-gate.test.ts）；Electron
  版全部桌面测试继续绿。
- `electron-edges.ts`（Electron flavor）：HostEdges → Electron API（即今日
  main.ts 中全部 Electron 调用点，原样搬迁）。**Electron 应用菜单现状 = 未
  自定义（默认菜单含 Edit role，Cmd+C/V 靠它）**——保持不动（A8）。
- `node-edges.ts`（Swift flavor）：HostEdges → B 桥（Swift 执行边沿）。

HostEdges 落定契约（字段语义与今日一一对应；v2 较 v1 的补全见 §0.1）：

```ts
// 落定契约（packages/desktop/shell-core.ts:679-762，逐成员 doc 注释）
interface HostEdges {
  // 渲染器投递（W-10 S0 新增；单窗身份，返回 false = 当前无存活主窗）
  rendererPush(channel: string, payload: unknown): boolean
  // 原生显示/系统集成
  showNativeNotification(spec, clickRoute): {
    dispose(): void
    shown: Promise<{shown:true} | {shown:false; error:string}>
  }
  notificationSupported(): boolean
  notifyClicked(openIntent: NotificationOpenIntent): void
  setBadge(count: number): HostSetBadgeResult                  // 判别形态，替代草案 boolean
  badgeCountApiAvailable(): boolean
  trayAvailable(): boolean
  setKeepAwake(on: boolean): void
  onSystemResume(cb: (ts: number) => void): void
  onMainWindowShown(cb: () => void): void                    // held-resume 补发点（B9）
  isFocused(): boolean
  focusMainWindow(): Promise<void>                            // 通知 click 激活腿（D3）
  webViewLoading(): boolean                                   // 渲染器可用性门（B3）
  webViewContentAlive(): boolean
  mainWindowAlive(): boolean                                  // W-10 S2 新增（B3 族）
  retireNotificationsForSources(ids: ReadonlySet<string>): number // W-10 S2 新增（B4 registry 私有）
  // 打开/拉起
  openExternal(url: string): Promise<void>                    // 预算/冷却/规范化在 core（B11）
  openPath(p: string): Promise<void>
  showItemInFolder(p: string): void
  launchApp(appId: string, path: string): Promise<boolean>    // 契约保留；**两 flavor 均无实现**（S-05 复裁决：等第一个消费者，§5 E12）
  // 对话框（E8：仅插件源 folder|.tgz 一体化 picker，design 21 §10 ⑧/13 §5.8）
  pickPluginSource(): Promise<HostPluginSourcePick>           // {status:'cancelled'}|{status:'picked';path}
  showError(title: string, detail: string): void
  showMessage(opts: HostMessageOptions): Promise<number>      // buttonId 收敛为 number
  // 系统/身份/资源
  setLoginItem(enabled: boolean): void
  isPackaged: boolean                                         // 能力位（B1）
  resolveResource(kind: HostResourceKind): string
}
```

> 注：与 v2 草案的差异 = 新增 `rendererPush`/`mainWindowAlive`/
> `badgeCountApiAvailable`/`retireNotificationsForSources`；
> `showNativeNotification` 带 `clickRoute` 参数并返回 `{dispose, shown}`；
> `setBadge` 判别形态、`showMessage` 归 number、`pickPluginSource` 归
> `HostPluginSourcePick`；v1 草案的 `pickDirectory()` 已删除——
> `desktop_pick_directory` 通道在 IPC_CHANNELS（68 键）与 preload 中均已不存在
> （仅 05 §7.4 旧文残留，A10）。宿主对象登记/淘汰（BoundedActiveNotifications
> 持 Electron Notification、淘汰=evicted.close()）留在 electron-edges，core 只
> 持有界 ACK 队列/去重/限速（B4）。零 core 消费者的保留面（`resolveResource`、
> `isPackaged`、`notifyClicked`、`trayAvailable`、`focusMainWindow`、
> `launchApp`、HostEdges 同步 `setKeepAwake`/`setLoginItem`——settings 路径走
> 装配 ctx 的 async 叶）在 STATUS 登记为有意保留。

### 4.2 复用清单（现状核实）

| 资产 | 规模（非测试行） | Electron | 去向 |
|---|---|---|---|
| control-plane（含 proxy/ws/静态伺服/seed/reaper） | ≈14.2k | 无 | sidecar 原样（编译产物复用 build-control-plane 模式） |
| dsh-runtime | ≈11.5k | 无 | sidecar 原样 |
| transport-manager / ssh-provider / gateway-provider / gateway-session(+refresh) / plugin-sync / connection-save / ssh-config / plugin-tarball / notifications(裁决) / deep-link(解析) / audit-log / badge(裁决) / chamber-settings / dsh-runtime-controller / apply-now / disk-evidence / 凭据文件事务族 / sidecar-ctx / shell-core | 零 Electron import（electron-free-gate.test.ts 传递闭包断言） | 无 | core 原样 |
| open-in（分类/校验）+ 本地拉起 | 纯逻辑 | 拉起点在 edges | 决策全在 core；**本地拉起由实例内 host 包 `openInApp/*` 负责，壳不实现 launchApp**（S-05 复裁决） |
| main.ts 编排 + electron-edges + preload + updater | ≈6.7k（3,982+367+941+1,413） | **4 文件，全部** | P1 拆分；updater 走 §7 |
| ipc-events.ts IPC_CHANNELS + ipc-surface-mirror 测试 | — | — | **manifest 单源**（§4.4.3），不动 |
| 资源/打包路径直拼点 | main.ts 内残余直拼点（builtin dsh / pnpm / webDistDir / 图标等） | 部分 | P1 参数化进 HostEdges.resolveResource（B1） |

### 4.3 Node 运行时分发（sidecar 的运行时底座）

- **捆绑**：fetch 固定版本官方 Node（arm64 + x86_64，或按 §10 决策 6 决定
  单一架构/universal），SHA-256 校验后进 `.app/Contents/Resources/sidecar/
  node`。**摘要的信任基座在仓库内**（`build-sidecar.mjs` 的
  `PINNED_NODE_SHA256`，逐字取自官方 `SHASUMS256.txt`）：默认版本的两个
  darwin 归档都必须在表内，`--node-sha256` 与固定值冲突即拒绝；未固定版本
  （`--node-version`）回退联网 SHASUMS256.txt 并响亮说明——「没固定」不得
  呈现为「已校验」。升级默认 Node 版本 = 同一提交更新该表
  （`build-sidecar.test.mjs` 门禁会红）。**基名必须叫 `node`**：`resolveNodeExecutable`（spawn-dsh.ts:435-447）
  的纯 Node 分支只在 `basename(execPath) ∈ {node,node.exe}` 时直用
  process.execPath，否则回落 PATH/knownNodeLocations（nvm 等）→ 裸 'node'
  （系统 node 版本不可控）——捆绑命名 `node` 即零改动成立；建议 P1 加一次
  解析断言测试钉死该前提（A5；`build-sidecar.test.mjs` 断言归档成员名 + 解包后
  基名 + `resolveNodeExecutable` 直用分支）。Electron 分支 = execPath +
  ELECTRON_RUN_AS_NODE=1 + `--expose-internals`（dsh loader 的
  node-addon-require-builtin 需要；updater 的 runtimeNodeExecutor 同构，
  main.ts:4034-4037）。
- **为什么必须绑 Node**：dsh 实例本身是 Node 进程（vendor dsh 以 npm 包形态
  由 pnpm 安装），控制面 spawn 它、dsh-runtime 安装它——Swift 壳无论如何
  绕不开。pnpm 11.21.0 已随 desktop 依赖，改由 sidecar 目录内嵌 + 注入
  （**plugin-sync resolvePnpmBinDir 不感知 bundled pnpm**，需 PATH 前置或
  env 注入，plugin-sync.ts:2023-2041）。
- **dsh-runtime 默认执行器恒纯 Node**（{file: process.execPath}，
  runtime-installer.ts:777）不受影响。
- Node 版本策略：与 desktop 的 Electron 内置 Node 大版本对齐或取 LTS，
  决策 6。

### 4.4 桥接设计（本方案的信任核心）

#### 4.4.1 A 桥（web ↔ Swift，preload 等价物）

- preload 职责：`contextBridge.exposeInMainWorld('dshChamber', {…})` =
  **4 个 info 标量（controlPlaneUrl/dshVersion/version/platform）+ 9 个
  命名空间面（desktopSsh/update/settings/systemResume/openIn/deepLink/
  runtime/notifications/badge）**（preload.cts:888-925；合计 60 invoke + 8
  订阅）。Swift 注入 `bridge-shim.poc.js`（WKUserScript、.page world、
  documentStart；资源名 = MainWindowController.swift:42）定义同形 API：
  - **挂出时机（D1，已按实现收敛）**：documentStart 定义内部管路（resolve/emit/
    rehydrate，带窗口随机令牌），**`dsh-chamber:info` 成功后**才暴露 `dshChamber`
    面；info 未就绪/失败期间 invoke 回 `ipc_not_ready`（1 次 + 10 次 50ms 重试），
    渲染端走既有 surface 缺失链自愈。全败分支与 preload 同形（surface 在、标量
    null）——即 preload「先 info 后 expose」的真正等价物（bridge-shim.poc.js、
    BridgeShimInjector.swift；G22/T-12 有对应门禁与登记）。
  - 方法面：按 manifest 生成 `dshChamber.<ns>.<method>(args)` →
    postMessage({id, method, payload})，以 id 关联 Promise（含 info 的
    10×50ms 重试语义照搬——仅 reject 时重试）。
  - 事件面：8 个 push → shim 订阅表，Swift `evaluateJavaScript`
    ("__dshChamberEmit(event,payload)") 派发（通道名/载荷以 IPC_CHANNELS/
    05 §7.4 为权威）。
  - 防护：Object.defineProperty 非可配置挂载防页面覆盖。
- Swift 端 `WKScriptMessageHandler` 护栏（只做传输层，语义校验在 sidecar）：
  1. 主 frame；2. **壳文档判定**（origin === 当前控制面 origin **且** pathname == "/"
     且无 query——与 Electron `isTrustedRendererUrl` 对齐；port 只在 ready 帧后放开）；
  3. 信封结构/尺寸上限（≤4 MiB）、method ∈ manifest 白名单；4. 不响应
    "新窗口/导航"（WKUIDelegate 建窗返回 nil + decidePolicyFor 阻断离开
    origin；外链交 NSWorkspace——含 **mailto:/vscode:// 等非 http(s) scheme
    导航策略实测**，C6）。语义校验（payload schema、来源指纹、generation、
    ACK 队列……）全部留在 sidecar 原处理器。

#### 4.4.2 B 桥（Swift ↔ sidecar，本机受信通道）

- 传输：sidecar stdin/stdout 行式 JSON-RPC（NDJSON）；stderr 独立为日志。
  **sidecar-entry 入口必须把存量 console.* 重定向到 stderr**——main.ts 的
  端口行（:1787）、will-quit 清理完成串（:1673，实机门禁断言该串）等遍布
  代码，不重定向则"业务原样复用"与协议纪律直接冲突（D2）。
- 信封：{id, method, payload} / {id, ok, result|error} / {event, payload} /
  edge:*（sidecar→Swift 的 HostEdge 请求，Swift 执行后回响应）；id 单调。
- **保留入站 method（Swift → sidecar，不在 68 通道 manifest 内；单源 =
  `packages/desktop/node-edges.ts` `HOST_INBOUND`）**：
  `__host.hostFacts`（同步门事实缓存）、`__host.notifyClicked`（通知点击回灌）、
  `__host.systemResume`、`__host.mainWindowShown`、
  `__host.deepLink {url}`（§4.5：Swift `application(_:open:)` 冷/热启动统一入口
  → core `enqueueDeepLink`）、
  `__host.rendererLifecycle {event}`（§5 E19 三事件映射：did-start-loading /
  did-finish-load / crashed / closed → core `onRendererLifecycle` 复位 ready 位
  + in-flight requeue/drain）、
  `__host.quitFacts {quitRequested, recoveryAvailable}` → **决策投影**（§5
  E1/E9/E20：core 依 chamber settings 的 `windowCloseBehavior`/`quitConfirmation`
  + `LOCAL_RUNNING_STATES × localProcessAlive` 用既有纯函数
  `shouldHideToTray`/`computeQuitRisk` 合成，返回
  `{hideOnClose, quitNeedsConfirm, quitReasons}`——判据单源在 core，Swift 只执行
  隐藏/退出链，绝不复制决策）。Swift 侧拼写单源 = `HostInboundMethod`，
  与 TS 表锁步由 `HostInboundMethodTests` 断言。
- 退出纪律：sidecar 进入清理后入站 invoke 一律回
  `{error:'app is quitting', code:'app_quitting'}`（sidecar-entry.ts:396-400；
  与 renderer-trust 的 `createTrustedIpc` 同码同语义），清理自身有 4.5s 硬顶
  （`QUIT_CLEANUP_TIMEOUT_MS=5_000` − 500，早于宿主 5s SIGKILL grace、留
  500ms 余量；shell-core.ts:691 / sidecar-entry.ts:691）。
- 护栏：Swift 只接受自己 spawn 的进程 fd；帧长上限与超时；非协议帧 fail-loud
  （重定向后仍泄漏说明有 console 直写，须修）。
- 事件推送经 B 桥到 Swift → A 桥 emit，事件名清单 = manifest。

#### 4.4.3 通道 manifest（防双份漂移）

- 单源：`IPC_CHANNELS`（ipc-events.ts）+ preload 的 invoke/on 字面量集。
  `ipc-surface-mirror.test.ts` 锁步**通道名字符串集合 + 类型/字段镜像**；
  `packages/desktop/scripts/emit-bridge-manifest.mjs` 解析三处 main 侧注册点，
  产出提交物 `packages/desktop/bridge-manifest.json`（**通道 + 方向
  invoke|push + IPC_CHANNELS 键**）→ 生成 `macos/Sources/DSHChamberPoc/Generated/
  BridgeManifest.swift`（提交物）与 `Resources/chamber-bridge.stub.js`（提交物；
  **不进 Swift target、不随 .app 打包**，仅作锁步样本，见 `Package.swift`
  的 `exclude`）。**命名空间归属不由 manifest 承载**：preload/shim 暴露面是
  唯一单源，`bridge-shim-surface.test.ts` 逐命名空间断言 shim 方法集与 preload
  一一对应（W-04 时代别名/漏方法即红）。
- 三件锁步测试：`bridge-manifest.test.ts`（重新生成 == 提交物 +
  **通道数守恒 68 = 60+8 + 无死键断言**，B12/E8）、`bridge-shim.test.ts`
  （`chamber-bridge.stub.js` 重生成逐字节 == 提交物 + invoke/push 数组与计数）、
  `BridgeManifestConsistencyTests`（Swift 白名单 == JSON）。Swift 产品代码禁止
  手写通道字符串（测试 fixture 除外）。
- `ipc-surface-mirror.test.ts` 的
  `MAIN_SIDE_FILES = ['main.ts', 'shell-core.ts', 'electron-edges.ts']` 覆盖
  三处注册者文件，badge pin 断言等源码文本锚点随之（renderer-trust.test.ts、
  transport-manager.test.ts 同族）。

### 4.5 通知点击与深链去重语义（design 19 §3.3 / 16 §4.2 的宿主移植）

- 通知 click：`pendingNotificationOpens` 有界 ACK 队列与去重/限速留在 core；
  **click 回执路由的存活期 = 到 dispose / 来源退役 / 被有界淘汰**——显示成功
  本身不得注销（否则 Swift flavor 的点击永远命中不到路由、静默返回 ok；
  `node-edges.ts:198-260` 的 2026-12 审计修复）。来源退役经 `sourceId` 集合
  扣掉路由（`showNativeNotification` 载荷携带 `sourceId`，:233-239），Swift
  侧 `NotificationDeliveryRegistry`（sourceId → identifier，FIFO 16）在
  retire 时用 `removeDeliveredNotifications` 真正移除已投递横幅
  （MainWindowController.swift:1004）。非 silent 通知用系统默认声
  （Electron darwin 的具名 `Glass` 在 UNUserNotificationCenter 无对应资源——
  平台等价物差异已登记，SwiftEdgeHostLegs.swift:219-222）。
  **对象登记/淘汰（BoundedActiveNotifications 持 Electron Notification 宿主
  对象，淘汰=evicted.close() main.ts:984-988）属 electron-edges**（B4——core
  不能持有宿主对象；UNUserNotificationCenter 的 delegate 由系统持有、Swift
  无防 GC 坑也无 close 事件需淘汰登记）。HostEdges showNativeNotification
  返回 click 回执绑定；**click 顺序（D3）** = NSApp.activate + 窗口 orderFront
  （含无窗重建，applicationShouldHandleReopen 同路）→ 回 B 桥
  notification-clicked → core 队列 → 窗口就绪后 push。就绪/重建竞态兜底 =
  **事件映射**（§5 E19，B5/D5；WKWebView 三个触发点 → 4 个 wire 事件，
含窗口关闭 `closed`）：didStartProvisionalNavigation（复位 ready
  位 + requeue in-flight）/ didFinish（drain）/ webViewWebContentProcess
  DidTerminate（复位 + requeue + 有界重载）。
- 深链：**macOS 现状 = open-url 事件 + argv 防御式扫描双路径**（main.ts:
  1479-1482 + 1687，归一化 intent key 去重，A7）——Swift 侧只走
  `application(_:open:)`（冷启动先于 ready → Swift 暂存，ready 后按序转交）
  → B 桥 deep-link(url) → core enqueueDeepLink 原逻辑（归一化去重、VS Code
  intent、proof 队列不动）；Win/Linux 的 second-instance argv 扫描仅 Electron
  flavor 保留。

## 5. 原生边沿逐项设计（Electron → Swift 映射）

| # | Electron 现状（main.ts/…） | Swift 对应 | 备注 |
|---|---|---|---|
| E1 | `BrowserWindow` + `loadURL` + hide-to-tray/close 语义 | `NSWindow` + `WKWebView`；`windowShouldClose` 按 14 D1（hide 而非关；mac Dock 恒为恢复入口 → orderOut） | 关窗隐藏/恢复、重建窗口只允许单窗 |
| E2 | `Tray`（打包态，resources/icon.png） | v1：mac 用 Dock 常驻即可，`trayAvailable()=true`；可选 NSStatusItem | 现状镜像：托盘缺失回退关窗即退（mac 不会缺） |
| E3 | **未自定义应用菜单**（默认菜单含 Edit role，Cmd+C/V 靠它；Menu 只用于托盘 :779） | NSMenu 标准菜单 + **Edit 项（copy/paste/selectAll 走 first responder → WKWebView）** + **窗口项（Cmd+M 最小化 / Cmd+W 关闭，AppDelegate.swift:659-700）** | 缺菜单会丢 Cmd+C/V/全选；Edit + 窗口菜单已落地（W2） |
| E4 | `Notification` + `Notification.isSupported`；**session 权限 handler 显式拒绝网页 Notification**（:5693-5695） | `UNUserNotificationCenter`；授权请求时机与现状一致 | **网页 Notification 双路径风险（B10）**：WKWebView 无等价预拒绝 API，网页 requestPermission 会绕过 chamber 裁决直发——P0 实测官方 UI 是否存在网页通知入口并处置 |
| E5 | `app.setBadgeCount`（平台门 + badgeEnabled 裁决在 core） | `NSApp.dockTile.badgeLabel` | 门控逻辑留 core（badge.ts） |
| E6 | `powerMonitor.on('resume')` + held lastResume 补发（挂在 win.on('show') :1434-1441） | `NSWorkspace.didWakeNotification` + HostEdges.onMainWindowShown（窗口显示/恢复事件）→ core 补发语义原样 | 推送 `dsh-chamber:system-resume {timestamp}` |
| E7 | `powerSaveBlocker`（keep-awake 断言） | `ProcessInfo.beginActivity(.idleSystemSleepDisabled…)` 或 IOKit 断言 | 触发条件随 core 状态机原样（网关会话保持等，14）；**启动期 reconcile** `<userData>/chamber-settings.json` 的 `keepAwake`（缺省 off / 损坏 loud+off；AppDelegate.swift:322-328） |
| E8 | `dialog.showOpenDialog`（唯一 = 插件源 folder\|.tgz 一体化 picker :334-347，darwin 双模式，**design 21 §10 ⑧ / 13 §5.8**） | `NSOpenPanel`（canChooseDirectories + canChooseFiles 双模式） | 归档清理（design 24）无任何文件对话框 |
| E9 | `dialog.showErrorBox/showMessageBox`（fatal 启动/前端崩溃/退出确认 D2）+ fatal 边界（uncaughtException → app.exit(1) :230-251） | `NSAlert`（sheet 或 app-modal）+ **sidecar fatal 边界：stderr + 非零退出码分级，Supervisor 分流文案** | 退出确认三分支与 5s 硬顶（§3.3/4） |
| E10 | `shell.openExternal`（外链/发布页/`openVscodeUrl`） | `NSWorkspace.shared.open(URL)`（URL 规范化/预算/冷却在 core，main.ts:1269-1303） | open-release 亦此 |
| E11 | `shell.openPath/showItemInFolder` | NSWorkspace `open(_:)` / `activateFileViewerSelecting` | 失败模式语义照搬 |
| E12 | open-in 拉起 Finder/VS Code/应用 | **实例内 host 包** `dsh-chamber-seed-open-in`（`openInApp/*`，design 20 §6）负责目录/图标/拉起；壳只执行 `openExternal`（vscode 远程深链等）；`HostEdges.launchApp` 契约保留但两 flavor 均无实现（S-05 复裁决，等第一个消费者） | 注册表/设置/可用性/URL 规则只在 core（`open-in.ts`/`deep-link.ts`） |
| E13 | 深链注册（打包态 `dsh-chamber://`） | Info.plist `CFBundleURLTypes` + `application(_:open:)` | 冷/热启动入队语义见 §4.5 |
| E14 | `app.setLoginItemSettings(openAtLogin)` | macOS 14.4+ `SMAppService.mainApp`；旧系统 NSLoginItem 兜底在新下限下不可达（无实现，见 deviations T-26） | 设置面语义不变（14） |
| E15 | `safeStorage`（gateway-secrets v3） | **不移植**：Swift flavor 走既有"诚实 0600 明文"回退；旧 safeStorage 密文"保留禁用待重录"（判别单测 **S1**，编号避开 §5 E 表） | 更强者加密 → 决策 7 |
| E16 | `session` 权限 handler：只放行 clipboard-sanitized-write（**写**） | WebKit：写 = 用户手势自动放行（无需弹窗）；**读走 NSPasteboard 用户授权** | P0 对拍加"粘贴（富文本/图片）与剪贴板读"（C3） |
| E17 | `crashReporter.start` + `child-process-gone` 诊断（:287/:295-301） | 不移植（macOS 崩溃报告原生 + Supervisor 日志）；child-process-gone 留 electron-edges | — |
| E18 | `requestSingleInstanceLock`/second-instance | NSRunningApplication 或锁文件二次激活（bundle id 相同时 LaunchServices 已保证） | 双 flavor 互斥见 §6.3 |
| E19 | renderer 崩溃恢复（installRendererRecovery :1178-1267：500ms + 60s≤3 次 + 15s unresponsive + render-process-gone :1235-1240） | **三事件映射**：didStartProvisionalNavigation（复位 + requeue）/ didFinish（drain）/ webViewWebContentProcessDidTerminate（复位 + requeue + 500ms 有界重载，60s ≤3 次 + NSAlert） | **unresponsive 腿 v1 明示不可移植**（WKWebView 无该事件）→ 已按 S-02 以心跳探针替代（`RendererHangWatchdog`：didFinish 后武装，需 15s 无输入 + 3 次探测）；2026-12 boot 死区收敛后，**前端 boot 不 settle 的逃生由页面侧拥有**（design 05 §4.1：可操作遮罩 + 相位感知就绪门 + ⌘R 提示），原生仍不观察/不超时前端 boot 状态——该探针覆盖不到"整页存活但前端卡住/首帧求值期冻结"，两条原生缺口登记在 STATUS（可选收口：didCommit 后武装首载超时；运行期 `/health` +「重启 sidecar」） |
| E20 | `app.on('activate'/'window-all-closed')`（darwin 且 close-behavior='quit' 时也必须 quit :1510-1516） | `applicationShouldHandleReopen` 等 + windowShouldClose 判 close-behavior：'quit' → NSApp.terminate 走完整确认链，绝不无窗常驻 | 14 D1 语义 |

### 5.1 刷新率（ProMotion 120Hz，2026-12 实机裁决）

**问题**：原生壳在 120Hz ProMotion 机器上跑不出 120fps（思考流式滚动明显发涩），而同机
Electron/Chromium flavor 是 120fps。实测（M5 Pro / 内置 3024×1964 120Hz 屏 / macOS 26.5，
单位 = 页面 rAF 实测 fps，屏幕 vsync 与 `CVDisplayLink` 均为 120Hz）：

| 引擎与配置 | 低电量模式 | 实测 |
|---|---|---|
| WKWebView 默认配置 | 关 | 60.0fps |
| WKWebView（关闭 prefer-60fps 偏好） | 关 | 120.0fps |
| WKWebView 默认配置 | 开 | 30.0fps |
| Chromium（同机同时刻，Chrome 152） | 开 | 120fps |

**根因（WebKit 源码定位）**：

1. `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml` 的
   `PreferPageRenderingUpdatesNear60FPSEnabled`：`defaultValue: default: true` —— WKWebView
   默认把页面渲染更新压到「靠近 60fps」而不是显示器刷新率；**只在 nominal > 60 且整数商 > 1 时
   才有影响**——61–119Hz 屏（如 100Hz）本就不受限，120Hz 上才表现为 60fps。（Safari 在 ProMotion
   上跑满 120Hz 属实测推断，未在源码里定位到它显式关该偏好的位置；不碰它的 WKWebView 按缺省受压。）
2. `ScriptedAnimationController::preferredScriptedAnimationInterval()` 调
   `preferredFrameInterval(throttlingReasons(), page->displayNominalFramesPerSecond(),
   settings().preferPageRenderingUpdatesNear60FPSEnabled())`；常量在 `AnimationFrameRate.h`
   （`FullSpeedFramesPerSecond = 60`、`IntervalThrottlingFactor = 2`、
   `FullSpeedAnimationInterval = 15ms`），半速集合在 `AnimationFrameRate.cpp` 顶部
   （`{ LowPowerMode, NonInteractedCrossOriginFrame, VisuallyIdle, AggressiveThermalMitigation }`）；
   低电量模式经 `Page::handleLowPowerModeChange()` → `adjustRenderingUpdateFrequency()` 生效。
   本仓折算（`RefreshRatePolicy`）与上游 `framesPerSecondNearestFullSpeed` 同式（含其整数除法）。
   代入本机：默认偏好 + 120Hz → 1/60；关闭偏好 + 120Hz → 1/120；再叠低电量模式 ×2。

**决议**：

- **关闭该偏好**：`WKPreferences` 只有私有 SPI（`WKPreferencesPrivate.h` 的 `_features` /
  `_setEnabled:forFeature:`，`_features` 需 macOS 13.3+）可改，Swift 侧没有直调面 ⇒ 新增独立
  C target `macos/Sources/DSHChamberWebKitSupport`（唯一职责 = 关偏好；读回只做内部自检，
  公共 C 面只有一个函数，零状态、零第三方依赖）。**必须在构造
  `WKWebView(frame:configuration:)` 之前调用**：实测页面创建后再改不生效（**稳态**：未换屏、
  未发生节流原因变化、未重启 WebProcess 前）——机理是偏好变更
  虽会实时下发到 WebProcess，但**偏好变更路径不会重设刷新节奏**：节奏只在
  `RenderingUpdateScheduler::adjustRenderingUpdateFrequency()` 的既有触发点（页面创建、换屏、
  节流原因变化）更新，`Page::settingsDidChange()` 不做这件事。装配点 =
  `MainWindowController.setupWindow()`；折算与日志在 `RefreshRatePolicy`（纯逻辑，可单测）。
- **低电量模式的 ×2 不覆盖（accepted）**：该状态由 WebContent 进程内的
  `WebCore::LowPowerModeNotifier` 直读系统状态（`Page::handleLowPowerModeChange()` →
  `adjustRenderingUpdateFrequency()`）。WebKit 内**确有**能强制「关」的钩子
  （`Page::setLowPowerModeEnabledOverrideForTesting(false)` + `m_throttlingReasonsOverridenForTesting`），
  但它只经 `Internals`（`window.internals`）暴露给布局测试，未发现 WKWebView / UI 进程可达面。
  三条候选杠杆的逐一体检见 Rejected alternatives 第 5 条（注入面存在但所属类已 deprecated、未采用；
  UI 进程不转发；interpose 探针不可复核）。⇒ 结论是「**无应用级开关**」，而不是「不存在能强制关的钩子」。
  ⇒ **关闭偏好后**低电量模式下页面更新上限 = 显示器刷新率 ÷ 2（120Hz 屏 = 60fps；偏好仍开时是
  nearest(nominal) ÷ 2 = 30fps）；要满 120fps 只能退出
  低电量模式（系统设置 > 电池）。壳只如实写日志，不假装消除。**用户裁决（2026-12）**：确认为
  系统级限制（WebKit 在 WebContent 进程内直读系统状态、应用侧无出口），按 accepted 登记差异，
  **不追求注入 bundle 覆盖原型**（唯一候选与其代价见 Rejected alternatives 第 5 条）。
- **POC_DEBUG 帧率观测**：`POC_DEBUG=1` 时注入 rAF 计数（每 2s 一行 `[native-fps]`，走既有
  pocConsole 回传）；缺省 / 打包态不注入（S14/T-11 调试面纪律不变）。

**Rejected alternatives**（本决策的备选与其被否原因）：

1. **接受 60fps、不做**：同机 Electron/Chromium 是 120fps，双 flavor 在同一台机器上刷新率不同且原生侧
   更差，没有任何产品理由保留；且关闭偏好是**一个 SPI 调用**的成本，代价与收益不成比例。
2. **等 WebKit 提供公开开关再动**：无时间表；期间用户可感的 60fps 上限持续存在（S-48），且公开 API 出现
   前无法验证。落地方式已按「SPI 缺失即 Unknown 降级」设计，将来换公开 API 只需替换 `apply(to:)` 一处。
3. **页面内规避**（用 CSS 合成动画/自绘替代页面渲染更新）：不适用——节流点在引擎调度器
   （`Page::preferredRenderingUpdateInterval()` 与 `ScriptedAnimationController`），页面拿不到旁路；
   流式文本必须走渲染更新，任何页面内改写都改变不了上限。
4. **按显示器能力门控**（仅 `NSScreen.maximumFramesPerSecond > 60` 时关偏好）：以三个理由否决——
   ① 实测页面创建后再改偏好**不生效**，窗口拖到另一块屏后无法重配（门控会永久停在旧屏的取值）；
   ② 60Hz 屏上 `nominal = 60`，`framesPerSecondNearestFullSpeed(60) = 60`，该偏好本就不额外限制，门控无收益；
   ③ 建窗前的 `NSScreen.main` 未必是窗口最终所在屏，门控判据本身不可靠。
5. **覆盖低电量模式**（injected bundle / UI 进程转发 / dyld interpose 三条候选）：**本壳不采用**——
   注入面（`_WKProcessPoolConfiguration.injectedBundleURL`；所属类自 macOS 12 起 deprecated，
   属性本身无单独注解。链路：`initializeNewWebProcess`（`createNewWebProcess` 调用）赋
   `parameters.injectedBundlePath`）存在但未实测，
   要用它做覆盖需自建 bundle 并链接 WebCore 的测试钩子（`Page::setLowPowerModeEnabledOverrideForTesting`），
   代价与风险远超收益（仅省电工况下多 2× 帧率）；UI 进程不转发（已核对）；interpose 探针得 0 但
   探针未入库、不可复核。系统省电策略本身没有应用侧出口，残余按 accepted 登记（决议第 2 条）。
6. **换渲染引擎**（把原生壳改成 Chromium/CEF 内核）：唯一能在低电量模式下也拿满 120fps 的路径
   （实测 Chromium 不受该策略影响），但超出 design 25 路线 A（WKWebView 壳 + 复用官方前端）的定义，
   工程量与发布/签名面代价巨大——**移出本决策范围**；电池场景的替代品是 Electron flavor。

**启动日志（唯一对照口径）**：`[native] 刷新率：显示器刷新率 120fps（当前模式）；prefer-60fps
偏好=已关闭(跟随显示器刷新率)；低电量模式=开 → 页面更新上限约 60fps（…）`——由
`RefreshRatePolicy.startupLogLine` 产出。刷新率取**窗口所在屏的当前模式**
（`CGDisplayCopyDisplayMode`；取不到时回落面板上限 `NSScreen.maximumFramesPerSecond` 并在日志里
标注「面板上限」）——与 WebKit 的 nominal **同源但不等价**（WebKit 用 CVDisplayLink 名义周期、在
display link 初始化时只缓存一次，取不到时回落 60），建窗后立即
记一次，并在换屏 / 屏幕参数变化（同屏改刷新率）/ 低电量模式切换 / 首次获得 key（上屏兜底）时按值去重补记
（`MainWindowController.logRefreshRateIfChanged`；低电量通知在全局队列投递，处理器回主线程）。
三个实测点为单次实机记录、**探针未入库**（复测方式 = 打包态 `POC_DEBUG=1` 的 `[native-fps]`）。
`RefreshRatePolicyTests` 钉住 60/120/30 三个实测点、上游整数除法折算、接线时序（apply 先于
`WKWebView` 构造）与 SPI 不可用时的诚实降级（unknown 按 WebKit 默认折算，绝不虚报 120）。
注意：同屏改刷新率时 WebKit 是否重读 nominal 未证实（DisplayLink 名义周期只在初始化取一次），
该场景的验收以 `[native-fps]` 实测为准，别只对日志。

**验收（未完成）**：插电 120fps、电池 + 低电量模式 60fps、60Hz 外接屏不回退；日志标「面板上限」
（模式读数取不到时的回落）或界面为 100Hz 类非整数倍屏时，判定以 `[native-fps]` 实测为准，
别只对日志。见 STATUS.md 与 deviations.md S-48。

### 5.2 视口越界（根级弹性回弹）与壳侧策略

macOS WebKit 在**视口层**实现弹性越界：指针停在不可滚动的 chrome（顶栏、侧栏头部）上滚动，或某个滚动器滚到端点后继续滚时，越界量落在视口，**整页（含 position: fixed 层）被整体平移再弹回**。按 CSS Overscroll Behavior 规范，**视口的越界效果由根元素的 overscroll-behavior 决定**，故策略由壳在 configuration 段以 WKUserScript（documentStart、仅主 frame）注入根规则 `html, body { overscroll-behavior: none !important; }`（`ShellOverscrollPolicy.swift`，装配点 `MainWindowController.swift:233-241`）：

- **只落文档根**：不改任何滚动容器的滚动范围，也不改文档内链式滚动（`none` 管的是视口越界效果与向视口外链接）；页面结构、上游代码零改动。
- **`!important` + 样式元素标记**（`data-dsh-shell-overscroll`）：`!important` 压过页面的普通声明；**层叠边界**（2026-12 对抗复核修正）——页面若在根上再声明同属性的 `!important`（同特异性、文档序靠后）或在根元素上设内联 `!important`，仍可翻转。当前上游**没有任何根级声明**（`packages/dsh-client-web` 全目录 `overscroll` 命中 0；其余命中都是滚动容器的 `contain`——移动端子树与设置确认框，无一定在文档根），故这是理论边界而非现状；author 源内也没有手段挡住页面 JS 主动改。若将来上游在根上声明该属性，升级手段是 documentEnd 再追加一次（文档序靠后）或对 documentElement 设内联 `important`。打包态可用一条 JS（`getComputedStyle(document.documentElement).overscrollBehavior`）自检，单测钉住注入契约（`ShellOverscrollPolicyTests.swift`）。
- **时机与作用域**：documentStart、仅主 frame（iframe 子文档保持自身行为）；崩溃/卡死恢复只 reload，注入随每次导航生效。本机实测 documentStart 时序为 readyState=loading、documentElement 已存在、head 尚不存在；落点**始终优先 documentElement**（即使将来 head 已存在也不落 head，保住"页面重写 head 也删不掉"的免疫），两者都取不到时才走一次 DOMContentLoaded。
- **证据（可复跑）**：效果面 = 手动 `node macos/scripts/overscroll-probe/run.mjs --assert`（需 GUI 会话；探针与 `ShellOverscrollPolicy.swift` 一同编译，注入串即 `makeUserScript()` 真实产出，无手抄步骤）；编译面 = darwin 门禁 `node macos/scripts/overscroll-probe/typecheck.mjs`（无需 GUI，策略源 API 漂移或探针烂掉即红）。断言的精确集合：baseline 三场景出现位移（`bar-up`/`content-top-up` 负向 `vvTopMin ≤ −8`、`content-bottom-down` 正向 `vvTopMax ≥ 8`）；policy 四场景 `visualViewport.pageTop` 为 0（判据 |vvTop| ≤ 1pt 容差）；**正常滚动**用同一条确实驱动内层滚动器的手势（`bar-down`：`#main` 0→810）比对两态位移一致；`scope` 场景（无手势）要求主文档 `styleCount ≥ 1`/computed `none`、iframe 子文档 `styleCount = 0`/computed `auto`（`forMainFrameOnly` 的可观测面）；causal 三步（策略在 0 → 运行时移除注入样式位移立刻回来 → 重新执行策略源回 0）；`content-mid` 只打印不设断言；采样超时/异常一律按 `HARNESS-ERROR` 非零退出、绝不当 0 用；`policyBytes`/`policySHA256` 与 `run.mjs` 里签入的 `POLICY_SHA256_PIN` 比对（有意改注入串必须同步改锚）。判据不用 0×0 合成层 position（同场景在 0..40 抖动，单用会假阴性）；合成事件的 NSEvent windowNumber=0，指针落点语义不由装置保证，故场景名只表示方向与滚动器状态、不作位置断言。
- **范围**：只关视口越界与链式越界；内层滚动器自身的局部回弹（若有）不在本策略范围内，勿当回归。
- **CSP 依赖（指令级守卫）**：注入的 `<style>` 依赖控制面 CSP 的 `style-src 'self' 'unsafe-inline'`（`packages/control-plane/src/index.ts:1136-1143`：注释 :1136-1142、指令 :1143）。页面当前**没有** meta CSP（全仓 0 处）；即便将来加入 meta `style-src 'self'`，documentStart 注入也早于其解析（本地 fixture 实测），唯一真实耦合是响应头 CSP。对抗复核用本地 HTTP fixture + 真实 WKWebView 实测出**三种同样静默失效**的改法：① 删掉 `'unsafe-inline'`；② 在同一 `style-src` 里再加 `'nonce-…'`/`'sha256-…'`（CSP3：出现 nonce/hash 即忽略 unsafe-inline）；③ 新增 `style-src-elem`（它覆盖 style-src 对 `<style>` 的管辖）——三者都让 computed 回 `auto`、整页回弹复现。现状安全：CSP 形成点有注释，`packages/control-plane/test/proxy/static-serving.test.ts` **按指令解析**响应头（同一 policy 内重复指令首次生效；逗号分隔的每个 policy 都同时生效），并要求**每一条生效的 style-src 都保留 `'unsafe-inline'`**、不得带 nonce/hash、不得出现 `style-src-elem`/`style-src-attr`——解析器本身另有自证用例（三种形态 + 逗号多 policy 全都判红）。2026-12 二轮独立复核：子串正则会被 "`style-src 'self' 'unsafe-inline', style-src 'none'`" 这类多 policy 写法整类绕过。改 CSP 必须同时复核本策略与 S-50。
- **双 flavor 差异**：Electron 未同步，登记见 deviations S-50。

**Rejected alternatives**（本策略的选择依据）：

- 逐个滚动容器加 `overscroll-behavior: contain`（含按上游类名选择）：覆盖不全（管不到"指针停在非滚动 chrome 上"这条路径），且要按上游结构改上游的滚动语义——破坏性变更，拒。
- 改 `packages/dsh-client-web/src/base.css` 等上游 shell 副本：等于给上游打补丁，还要重建前端产物、重新打包；本方案零页面改动，拒。
- 私有 SPI `_setRubberBandingEnabled:`：不属公开接口（既无公开文档也无兼容承诺），发行风险与逐系统复核成本都高于一条标准 CSS，拒。
- JS `wheel` 事件拦截：逐事件逻辑，且 WebKit 对合成/惯性相位事件的可取消性不由页面保证，最易回归，拒。
- 把固定 chrome 移出 WKWebView（原生分层自绘）：不阻止内容区自身位移，且要重做命中测试/主题投影，代价与收益不成比例，拒。

## 6. 数据、状态兼容与共存

### 6.1 userData 目录

- 目录名机制：Electron userData = appData + `app.getName()`，而 `app.getName()`
  取 package.json 的**顶层** `productName`、其次 `name`。本仓 `productName` 只在
  electron-builder 的 `build.productName`（只影响 .app/DMG 名），顶层没有 →
  实际取到包名 → **实根 `~/Library/Application Support/@dsh-chamber/desktop`**
  （2026-09 GUI 验收实机核实：运行中的打包宿主 `--user-data-dir=…/@dsh-chamber/
  desktop`；同源声明见 `packages/desktop/scripts/electron-dev.mjs:14-23`）。
  Swift 版**同根**（`PackagedLayout.userDataDir`，由
  `packages/desktop/chamber-lock.test.ts` ⑦ 的 lockstep 断言钉住：Swift 常量
  必须等于 `顶层 productName ?? name` 推导；改 identity 必须同步两侧）。
  sidecar 以 `--user-data-dir` 参数接收，内部零改动。
- 直拼点全集（P1 参数化收口）：chamber-settings.json；runtime 基目录 = userData
  本体（dsh-runtime 树在 <userData>/dsh-runtime/…）；stateDir = userData/state
  （localDshHome=state/dsh-home）；ssh-plugin-journal.json；ssh-passwords.json；
  gateway-secrets.json；audit-log.jsonl；ssh-instances.json（引用前 grep 现取）。
- 旧版 Electron 产物兼容：`*.corrupt` / `*.unbound-*` 保留物（A13）在 Swift
  首启前决定处置（预期：沿现有语义保留禁用，不主动清理）。
- 验证项 **U1**（实机）：确认 Swift 计算的根与 Electron 打包实根一致
  （编号避开 §5 E 表，A9）。**实施现状（2026-09 GUI 验收修正）**：`PackagedLayout`
  已按 `isPackaged` 解析——装配态 userData =
  `~/Library/Application Support/@dsh-chamber/desktop`（与 Electron
  `app.getPath('userData')` 同根，见 §6.1 的实根推导），node/sidecar/vendor-dsh/
  web-dist 全部 bundle-relative；`POC_*` 环境变量仍优先，dev 态保持
  `dsh-chamber-poc-dev` 隔离。**代码侧已闭合**（`PackagedLayoutTests` +
  `chamber-lock.test.ts` ⑦ 跨语言 lockstep），残余仅为实机双 flavor 并发互斥的
  **C2 实机门禁**——注意互斥成立的前提是 Electron 侧**装的是含锁的构建**
  （2026-09 实测：本机 /Applications 内的旧构建无 `chamber-lock`，因此不会持锁）。

### 6.2 bundle id 与双 flavor 共存

- Swift 版新 bundle id（推荐 `com.dshchamber.native`；决策 2）：与 Electron
  版（`com.dshchamber.desktop`）区分是硬前提。代价：通知授权按新 id 重新请求
  （风险 R4）。
- **WebKit 存储隔离（C2）**：WKWebView 默认 WKWebsiteDataStore 落
  `~/Library/WebKit/<新 bundle id>/`，与 Electron userData cookie/缓存是
  **不同 jar**；§6.1"同根零改动"只覆盖文件面、不含 WebKit 存储。共存语义 =
  双 flavor 各自独立 WebKit jar（无跨进程共享开关），dsh web profile 的
  launch-token 登录流程在 WebKit jar 下的保持/重建属 **P0 实测项**（G 门）。
- 不迁移既有目录（避免任何改写/降级风险）。

### 6.3 互斥与单实例（v2 修订：flock）

- 同一 userData 根**绝不允许 Electron 版与 Swift 版并发**（registry/凭据
  事务/runtime 树无跨进程锁）。实现（**B2，采纳 STATUS「多控制面无跨进程
  CAS」登记的 kernel-backed lock 建议，不用 pidfile/mkdir stale 模式**）：
  - 双 flavor 同持 `<userData>/.dsh-chamber.lock` 的 **flock(LOCK_EX|LOCK_NB)**
    （O_CREAT|O_NOFOLLOW，0600，原子创建）；fd 常驻进程寿命，进程死亡内核
    自动释放——天然免 stale；
  - 文件内 pid/启动时间**只作诊断与 sidecar 复验**（不是锁的仲裁依据——仲裁
    始终是 flock 本身）；sidecar 用记录 pid 判定「是否我方父进程持锁」，见下条；
  - **防自锁陷阱**：sidecar"复验持锁"若在新 fd 上再 flock 会与 Swift 首锁
    互斥（flock 按 open file description 计）——sidecar 复验 = 读锁文件记录
    校验父 pid，**绝不二次 flock**。**复验语义（2026-09 实施定稿）**：记录里的
    pid 是**持锁方**（Swift 壳）的 pid，而 sidecar 是它直接 spawn 的子进程 →
    正常形态 `record.pid === process.ppid` 属「我方父进程持锁」，放行；只有
    `record.pid ∉ {self, ppid}` **且**该 pid 仍存活才是「另一 flavor/实例占用」
    → loud `exit 3`（Swift Supervisor 对 exit 3 走 fatal、不重启）；
    `record.pid` 已死 = 陈旧记录（flock 随进程死亡由内核释放）→ 放行。
  - 锁文件与秘密文件同纪律（0600、no-follow、原子创建）；已随立项登记进
    `AGENTS.md` 秘密文件纪律清单（AGENTS.md 锁纪律句）。
  - **Electron 侧同锁已落地（2026-09，`packages/desktop/chamber-lock.ts`）**：
    Node 没有 flock API，但 Darwin `open(2)` 的 `O_EXLOCK|O_NONBLOCK` 可经
    `fs.open` 的数值 flags 使用（实测：同进程第二次 open 得 EAGAIN、close 后
    可重取）——Electron main 在 whenReady 首步取同一把锁，失败 fail-closed
    弹窗退出（`dialog.showErrorBox` + `app.exit(1)`），`app.on('quit')` 释放
    （清理链 settle 之后；2026-09 二审把释放点从 will-quit 迁到 quit）。
    **平台范围（有意收窄）**：`O_EXLOCK` 为 BSD/Darwin 专有，Linux 需 flock(2)
    （Node 未导出）、Windows 无等价物；Swift flavor 仅 macOS 存在，故非 darwin
    返回 `unsupported` 并放行（调用方 loud 记录该范围，绝不假装已互斥）。
- 与既有机制关系：RuntimeOperationFence/RuntimeWriterFence（进程内单飞，
  dsh-runtime/runtime-operation-fence.ts）与跨进程 flock **正交互补**。

### 6.4 凭据与安全文件

- SSH 密码镜像（ssh-passwords.json v2）：endpoint-bound 0600 明文（2026-08
  用户决策），Swift flavor 语义不变。
- gateway-secrets（v3，safeStorage|plaintext 判别）：Swift flavor 无
  safeStorage → 新写一律 plaintext 判别 + 0600 原子写（既有诚实回退）；读旧
  safeStorage 判别条目 → 解密不可用 → **保留文件与绑定、标记禁用待重录**
  （复用"legacy 保留禁用"既有语义；判别路径补单测 **S1**）。
- 若用户希望静态加密，走决策 7（Keychain 持随机文件密钥 + HostEdges
  encrypt/decrypt edge）。v1 不排期。

## 7. 更新（design 11 的 Swift 侧形态）

- Electron 版维持 electron-updater（GitHub provider、zip target）不动。
- **Swift 版更新链 = Sparkle 2（2026-12 用户裁决「D-1 选 B」，取代原 v1
  blocked-available）**：壳内 `AppUpdater`（`macos/Sources/DSHChamberPoc/AppUpdater.swift`）
  持一个 `SPUStandardUpdaterController`，承担**检查 → 下载 → 重启并安装**。安装必须由
  bundle 外的 helper 完成（运行中的 .app 不能覆盖自己），更新包来源用 **EdDSA 公钥**
  （`SUPublicEDKey`）鉴权——注意它与 Developer ID 签名/公证是两件事：后者是分发信任，
  前者是更新通道鉴权。
  - 装配面：`Info.plist` 的 `SUFeedURL`/`SUPublicEDKey` 由 `build-swift-app` 的
    `--sparkle-feed`/`--sparkle-public-key` 注入（模板占位符 `__SPARKLE_FEED_URL__` /
    `__SPARKLE_PUBLIC_ED_KEY__`）；两键任一为空 = 更新不可用：菜单「检查更新…」禁用，
    且不向 sidecar 声明 `--native-updater sparkle`。`SUEnableAutomaticChecks` 模板常量
    **true**：原生腿每次启动强制一次后台检查（S-37），之后由 Sparkle 调度器按
    `SUScheduledCheckInterval=21600`（6h）继续，与 Electron 的 6h 节奏同量级；
    scheduled 更新的标准窗在壳内被抑制（`SPUStandardUserDriverDelegate` 把展示权
    收回壳 → 相位进设置页），用户手动的「检查更新…」仍走标准窗。
  - 最低系统版本：Electron 与原生壳同为 **macOS 14.4**（`build.mac.minimumSystemVersion` 与
    `LSMinimumSystemVersion` 写精确 14.4；`Package.swift` 的 `.macOS` 只能写 major，故写
    `.macOS(.v14)`，精确下限由 Info.plist 承担；三处一致由 release 策略测试钉住）。**为什么是
    14.4**：原生壳跑 OS WebKit，出货 bundle 在审批决策、用户提问/计划评审、PDF 预览等构造路径
    直接调用 `Promise.withResolvers`（A3-1），该 API 自 Safari 17.4 / macOS 14.4 才存在——
    macOS 13.x 与 14.0–14.3 会在构造期 TypeError；Electron 自带 V8 不受影响，但同一支持矩阵只
    保留一个下限（2026-12 用户裁决：抬高下限，不为旧系统加 polyfill）。
  - feed 为什么必须是 appcast：Sparkle 的更新协议只有 appcast（XML feed + 每条目的
    EdDSA 签名）一种读取方式，它不消费 GitHub REST API 或 electron-updater 的
    `latest-mac.yml`；`SUFeedURL` 因此指向**本仓 release 自带资产**（同一发布供应链，
    无第三方托管）：稳定通道 `releases/latest/download/appcast-swift.xml`，beta 通道
    `releases/download/appcast-swift-beta/appcast-swift-beta.xml`（滚动 prerelease tag
    `appcast-swift-beta`，每个 beta `--clobber` 覆盖 ⇒ beta.N 能看到 beta.N+1）。
  - 双 flavor 分工（2026-12 单源化）：**壳声明原生更新器可用时，检查也由壳承担**——
    页面的「检查更新」经 `updateNativeAction kind=check` 转发给 Sparkle，页面只消费
    壳推回的 `dsh-chamber:update-state-changed` 相位（checking/available/downloading/
    downloaded/installing/failed），**不再并行发起 GitHub Releases 查询**（无双源、无回退）；
    Electron（无原生腿）保留既有 headless GitHub 检查 —— 那是它自己的 feed 源。
    sidecar 把 `installBlockedReason` 清空，「更新 / 重启并安装」经 edge
    （`updateNativeCapability` / `updateNativeAction`）落地：`kind=check` → 壳内检查，
    `kind=download|install` → Sparkle 标准窗口（Sparkle 2 无「仅下载」公开 API），
    忙碌/未配置/未知 kind 一律如实拒绝；能力查询回 `{available, error}`，坏 feed/坏
    密钥不再是「假装可用」（S-38/S-39）——页面因此落到诚实错误相位，绝不卡在 checking。
    壳侧确认无原生腿时仍回显 `原生壳不支持自动安装`。
  - 安装前清理：`SPUUpdaterDelegate.updater(_:willInstallUpdate:)` 先停受管 sidecar、
    收 keep-awake 与 Dock 角标（安装路径不保证先走我们的退出链）。
  - 打包：`build-swift-app` 把 `Sparkle.framework` 嵌入 `Contents/Frameworks`、补
    `@executable_path/../Frameworks` rpath 并校验；嵌入在签名之前（嵌套先于主签名）。
  - 发布：`SPARKLE_PUBLIC_ED_KEY` 存在时注入 feed/公钥；正式腿在 `SPARKLE_PRIVATE_KEY`
    存在时用 Sparkle 的 `generate_appcast` 生成并签名 appcast，随 release 上传。
    **enclosure 必须可解析**：beta appcast 输入目录同时放当前 beta zip 与最新 final zip，
    并以 `--download-url-prefix` 指向滚动 tag；verify 之后把**每个被引用的 zip**先传到
    滚动 release，再传 appcast（S-36：此前 enclosure 相对滚动 tag 解析、zip 只在
    `v<version>` ⇒ beta 下载 404）。稳定通道保持单条、无前缀、不写滚动 release；
    稳定发布也会在 verify 后刷新滚动 beta appcast（保留最新 beta 条目）——所以
    beta.N 既能看到 beta.N+1，也能看到后发的 final（S-22/S-23）。两把钥匙都缺失 =
    该构建的自动更新保持关闭（照常出包，只是没有安装腿），loud 警告。
  - 契约：`UpdateController.restartAndInstallAsync?()` 为原生腿提供异步面（IPC 处理
    器优先用它），Electron 的同步实现与页面契约不变。
- **shell-flavor 判别字段（§0.1-E2）**：`dsh-chamber:info` 载荷带 `flavor`
  （`main.ts:3858`；镜像面仍 4 标量），但**共享 renderer 至今没有消费者**——
  UI 能力门（更新文案/重启安装按钮）实际由 `installBlockedReason` 与原生能力位驱动。
  字段保留备查；将来要用它做 UI 条件时，须先补消费者与 preload.cts/global.d.ts
  镜像测试。
- **检查腿的宿主叶（2026-12 审计修复）**：headless 控制器在 `setState` 时逐个
  listener 走 try/catch，推送腿抛错绝不反噬控制器（`update-headless.ts:134-148`）；
  sidecar-ctx 的 HostEdges 必须**显式**提供惰性 `disarmUpdaterQuit: () => {}`
  （`sidecar-ctx.ts:2768`）——该文件的 methodStub 把「缺失成员」变成调用即抛的
  `sidecar-ctx-unavailable:*` 递归 stub（`sidecar-ctx.ts:2774-2784`，抛错点 `:2777`），省略该叶
  会让首次「检查更新」在订阅回调里抛错、控制器 checking 卡死。这是有意的惰性
  契约叶，不是死代码。
- v2（P3 末，决策 3）：Sparkle（appcast 独立 EdDSA 密钥）——发布 CI 打
  dmg/zip 时生成 appcast。

### 7.1 差异复核方法：可达性优先（2026-12 复核）

双端差异的复核顺序固定为 **可达性 → 用户可见性 → 最小改动位置**（来源：open-in 复核，见
`docs/progress/deviations.md` §7）：

1. 先查调用点/消费者（`grep "edges\.<member>("`、A 桥通道消费者、host 包域真实使用者）；没有调用点的
   差异记为**潜伏差异**，不进修复队列。
2. 只修「可达且用户可见」的差异，修复位置优先 `macos/`。
3. 跨出 `macos/` 必须给出调用点证据：只有新增能力/通道/契约才动共享面，否则只登记。
4. **契约面 ≠ 功能面**：`HostEdges` 里有成员不等于用户路径上有行为（当前潜伏 10 / 可达 6）。

`SwiftEdgeHostLegs` 的能力据此分三栏：**共享执行面（可达，必须与 Electron 逐字一致）**、
**壳侧执行面（shell-internal/超集，不宣称共享契约）**、**潜伏契约面（保留形状，等第一个消费者）**。

## 8. 实施阶段、测试与验收

> 详细执行计划（M0–M5 六门、WBS W-01…W-32、P0 runbook、P1 四批施工单、
> Swift 施工顺序、防漂移门禁清单、R10–R13/A1–A8/W1–W6 判定、D1–D7 日程、
> 三档时间线 46–72 人-日）见 `docs/progress/todo/macos-swift-v1.md`，本节只
> 留契约性要点。

### 8.1 P0 POC（1–2 人周）——先证伪再立项

> P0 代码面已交付（`macos/` 壳 + `bridge-shim.poc.js` + B 桥 + dev 直跑
> `sidecar-entry.ts`）；G1 经用户实机目测确认，**G2–G5 与 C1/C2 的实机判定
> 仍开放**（STATUS 登记）。以下保留门定义与判据。

1. `macos/` 最小壳：WKWebView 加载控制面 origin 的壳文档（`/`）；dev 后端 =
   `sidecar-entry.ts`（standalone/cli serve **不接 webDistDir**，故不经它们；
   `POC_*` 环境可覆盖 userData/port/dsh path）。
2. A 桥 shim 接通代表通道：`info`、`desktop_ssh_instances_get`、
   `desktop_ssh_status_changed` 推送；通知 click 走真实回环。shim 挂出时机的
   D1 判决见 §4.4.1（方案②：documentStart 预定义 + ready 前统一拒绝）。
3. 验收门（**G1–G5 + C1/C2，全过才继续**）：
   - G1 主界面（多实例/会话/设置页）在 WebKit 渲染无功能缺口；
   - G2 剪贴板复制粘贴（含富文本）、文件拖拽（附件/file input）、外链跳转、
     **非 http(s) scheme 导航**；
   - G3 侧栏插件（git/open-in/settings-bridge）可用；
   - G4 深链冷启动不丢、通知点击可激活会话；
   - G5 退出/隐藏/唤醒补发语义与 Electron 版一致；**hide 后 ≥30s 的 SSE/
     WS 心跳与唤醒即时重连实测（C1：backgroundThrottling:false 无 WKWebView
     等价物）**；
   - C2 双 flavor 交替使用同一 userData/dsh 实例时，WebKit 独立存储 jar 下
     会话 cookie/登录态表现实测并定共存语义；
   - P0 预检：双端同机跑 boot 参考点（方法见 companion §七「双端性能与产物体积
     验收协议」），只为尽早暴露引擎级数量级异常，**不作定标**。
   G1–G5 任一实质失败 → 回到本文档重审路线（§10 决策 1）；**C1/C2 除外**——
   按 §0.1 闭合清单处置（C1 失败 = 登记已知降级或走 keep-alive/唤醒补发方案；
   C2 = 定共存语义记录后继续），不触发路线重审。

### 8.2 P1 core 拆分（2–3 人周，Electron 不回归；已落地）

- §4.1 拆分 + HostEdges 全量定义（v2 字段集）；Electron 版跑全量测试作为
  门禁；core 对 electron 的 import 零容忍（CI lint）。
- **3 个测试把 main.ts/preload.cts 当源码文本断言**
  （`packages/desktop/test/ipc/ipc-surface-mirror.test.ts:449` 的 MAIN_SIDE_FILES、
  renderer-trust、transport-manager 同族）→ 锚点随处理器迁移 shell-core.ts
  （属搬运账内工作，非"测试原样绿"）；**control-plane-module.ts 的 isPackaged 门
  flavor 化**：`isPackagedSidecarRuntime()`（`DSH_CHAMBER_SIDECAR_COMPILED=1`，
  Swift Supervisor 装配态注入）时加载 `<sidecar>/dist/control-plane/index.js`
  编译产物，否则走 workspace 源码 import（:47-90）。
- 产出 `sidecar-entry.ts` + `node-edges.ts`；sidecar 可在纯 Node 下以"假
  Swift"驱动（`sidecar-stdio.test.ts` 内置驱动器）跑通全量 60 通道冒烟——
  **在写任何 Swift 前先把 B 桥协议用现有 JS 测试资产钉住**。

### 8.3 P2 Swift 壳 v1（3–4 人周；已落地）

E1–E20 按 §5 实现（E15 走 §6.4）；manifest 生成与护栏；Supervisor 与启动
序列（§3.3）；A 桥 shim 全通道对拍；双端 harness 冒烟（`swift-harness-driver`：
node 集成测试拉起 Swift harness 断言真实窗口/桥，loopback-http-test-server.ts
同款思路）**未实施——需 GUI 会话，见 §8.6**。

### 8.4 P3 边沿完整 + 发布管线（2–3 人周；已落地，真实 runner/凭据仍为外部阻断）

- 更新 v1 blocked-available 已落地（§7）；v2 Sparkle 按决策 3 未排期。sidecar
  打包布局 = `dist/control-plane/` + host 包 `dist/dsh-chamber-seed-*/` +
  内嵌 `vendor/dsh`/`pnpm` + 捆绑 `node`（§3.2）；build-swift-app.mjs；CI：
  GitHub Actions macOS runner（swift build + XCTest + 打包 + ad-hoc/
  Developer ID + notarize——STATUS 已登记 mac 发布缺 Apple 凭据会阻断，
  Swift 版同此门禁，dry-run 不阻断路线）；图标/资源复用（icon.icns 平移）。

### 8.5 P4 实机门禁矩阵（1–2 人周）

逐项走查（对照 STATUS 清单风格登记残余）：打包态全链（控制面起动/本地实例
预启动/连接/网关凭据重录/运行时版本管理与回退/插件同步/归档清理入口（无
对话框）/通知点击/深链/隐藏恢复/唤醒补发/退出确认）；WKWebView parity 清单
（W1 剪贴板、W2 菜单快捷键、W3 富文本粘贴与拖拽、W4 打印/查找、W5 字体/
滚动/IME、W6 后台节流对 SSE/WS——**无 backgroundThrottling 等价物（C1）**、
W7 刷新率三工况（插电 120fps / 电池 + 低电量模式 60fps / 60Hz 外接屏不回退；判据见 §5.1、
登记 deviations S-48；100Hz 类非整数倍屏不在三工况内，以 `[native-fps]` 实测为准），
判定标准见 todo companion §七）；性能测量方法与同环境 A/B 纪律见 `scripts/perf/README.md` + **双端
性能/产物体积验收协议**（companion §七：相对门/绝对预算/能力门三形态、注入式探针
平移四场景、M5 双端同 tag 产物并排入库——.app/dmg/zip 体积目标 ≤ Electron × 0.75）。
原生壳专项再加一条：**最低支持版本 macOS 14.4 上跑一次首载 + 视口越界策略（§5.2）复验**，
通过后 S-50 的退役判据才算闭环。

### 8.6 测试策略汇总

| 层 | 内容 | 现状 |
|---|---|---|
| JS 业务 | desktop/control-plane/runtime 现有单测与镜像测试 | **原样复用**（P1 后跑同一文件集 + 3 个文本锚点测试随迁） |
| B 桥 | 信封/帧长/超时/乱序/edge 往返——node 侧假 Swift 驱动（`sidecar-stdio.test.ts`），Swift 侧 XCTest | 已落地（`sidecar-stdio.test.ts` + `BridgeClient*Tests`） |
| A 桥/护栏 | shim 与 manifest 一致性（bridge-manifest / bridge-shim / bridge-shim-surface）、origin 门、尺寸门 | 已落地 |
| 集成 | node 集成测试拉起 Swift harness 断言真实窗口/通知/深链 | 无 GUI 通道冒烟（60/60）已落地；真实窗口 harness（`swift-harness-driver`）未实施——需 GUI 会话 |
| 壳视图策略 | 视口越界策略（§5.2）的注入契约、装配点与效果：`ShellOverscrollPolicyTests`（11 例：根规则与选择器只落文档根、注入契约字面量锁步、无未解析占位符、selector 角色、JavaScriptCore + DOM 桩真执行、host 缺失的就绪防护及其生效面、标记幂等、install 幂等且不挤 A 桥 shim、documentStart/仅主 frame、装配锁步（install 调用早于 `WKWebView(frame:`）、design 25 字面量锁步）+ 探针 `macos/scripts/overscroll-probe/`（编译面 = darwin 门禁 `typecheck.mjs`，无需 GUI；效果面 = 手动 `run.mjs --assert`，判据 `visualViewport.pageTop`/`scrollTop`：baseline 三场景出现位移、policy 四场景 0（≤1pt 容差）、`bar-down` 正常滚动两态一致、`scope` 主文档有而 iframe 无、causal 三步、`content-mid` 仅打印） | 单测已落地（2026-12）；效果断言**手动运行、不进 CI**（需 GUI 会话）；打包态 `.app` 实机走查与最低版本 macOS 14.4 复验归 §8.5 矩阵与 STATUS 未完成清单 |
| 实机 | §8.5 矩阵（含 W7 刷新率三工况，S-48）+ C1/C2 | 未判，发布前执行（STATUS） |

## 9. 风险与开放问题

- R1 **双业务源码漂移**：core 拆分后 Electron 版若独立演进，Swift 版会滞后。
  缓解：单 repo 单 core；host-edge 契约评审门禁；mirror + bridge-manifest 双
  锁步测试（含 `bridge-shim-surface.test.ts` 的 shim 表面一致性）；同 tag 双壳发布。
- R2 **WKWebView 差异**：渲染引擎/权限模型/devtools 不同；无
  backgroundThrottling/unresponsive 等价物（C1/B5）；无网页 Notification
  预拒绝 API（B10）；存储独立 jar（C2）。P0 先行证伪（G1–G5 + C1/C2）。
- R3 **Node 捆绑与架构**：arm64/x86_64 × 两 flavor 的 CI 成本（决策 6）。
- R4 **通知授权身份变更**：新 bundle id → 用户需重新授权通知。
- R5 **目录并发互斥**：§6.3 flock 方案为仓库首个跨进程锁，协议需新定义
  （格式/诊断字段/双进程复验）；与进程内围栏正交。
- R6 **旧 safeStorage 密文迁移**：Swift flavor 首启即遇旧 gateway 凭据不可
  解密——"保留禁用待重录"（S1 单测）。
- R7 **Swift 代码面安全评审**：桥护栏（§4.4）是新信任边界；护栏规则独立
  评审 + 负例测试（伪造 frame/超大帧/非协议流/伪造事件名/越 origin）。
- R8 **更新双轨**：v1 blocked-available 诚实形态；Sparkle 密钥/回滚在 v2
  单独评审。
- R9 维护负担：Swift 壳新增一门语言/一条 macOS CI；需有人持续负责 Swift 侧。
- R10 开发期双后端竞态：Electron dev 与 sidecar dev 共享 cp 端口族 → 各自
  退避 + 端口钉死 + 独立 .dev-user-data（详见 companion）。
- R11 Swift 侧人手单点：护栏规则集中 DSHChamberPoc 单 target + Generated
  产物减少手写面。
- R12 manifest 解析脆弱性：正则扫字面量会漏新写法 → 复用 mirror 解析函数 +
  通道数守恒断言（68=60+8）。
- R13 WKWebView devtools：仅 debug 构建开启（inspector 属信任边界）。

## 10. 外部决策清单（签核未闭合；日程见 companion §八）

1. **路线确认与 P0 先行**：是否按路线 A 启动 P0（1–2 周 POC）？P0 验证门
   （G1–G5 + C1/C2）任一失败即回到路线评估（中止点 A1–A8 见 companion）。
2. **双壳共存形态**：Swift 版与 Electron 版长期共存（各自发布）还是 macOS 上
   替换？推荐**共存**，bundle id `com.dshchamber.native` 立项即定。
3. **更新路线**：v1 blocked-available 诚实形态 → v2 Sparkle（推荐）；或 v1
   直接 Sparkle。
4. **仓库落位**：`macos/`（SwiftPM，推荐）vs `packages/swift-shell`。
5. **原生 UI 渐进**（路线 B/C）：本文不覆盖；HostEdges 边界即未来接缝，侵蚀
   需另立设计。
6. **Node 版本与架构**：与 Electron 43 内置 Node 大版本对齐 vs LTS；
   arm64-only vs universal2。
7. **静态凭据加密**：v1 诚实 0600 明文（推荐）；或提前排 Keychain 协助加密
   edge。
