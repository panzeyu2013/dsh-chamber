# 25 · macOS Swift 原生壳（路线 A：WKWebView + Node sidecar 全复用）

> 状态：**方案草案 v2（未立项 / 未实现）**。本文按路线 A（Swift 写壳、Node
> sidecar 原样承载现有 control-plane 与 desktop 纯 Node 业务）给出详细设计，
> 作为立项与实施的技术底稿。
>
> **2026 打磨轮（v1 → v2）**：v1 定稿后经三个并行只读 subagent 分面打磨——
> ① 逐条设计评审（本文件 vs 代码，A/B/C/D/E 五维，40+ 条发现）；② 承重假设
> 核验（13 组，输出 文件:行号 证据与 9 条修正）；③ 实施细化计划（M0–M5 六门 +
> WBS W-01…W-32 + runbook + 门禁/中止条件，落于
> `docs/progress/todo/macos-swift-v1.md`）。评审裁决：**可立项性通过（无
> Blocker），核心复用面事实全部成立**；Major 级修正已并入本版（§0.1 闭合
> 清单），路线 A 前提未被推翻。§2 外部仓库事实为 GitHub 检索所得 [待核-外部]；
> 涉 vendor 官方 UI 的行为判断标 [待核]（vendor 未在本工作树物化）。
>
> 立项前需用户拍板的外部决策见 §10（平台策略、bundle id/共存、更新路线、
> 仓库落位、Node 版本钉住）；实施执行计划见 todo companion
> （docs/progress/todo/macos-swift-v1.md）。任何实施必须先过 §8.1 的 P0
> 验证门（G1–G5，**含 WebKit 后台节流与存储隔离实测，C1/C2**）。
>
> 相关既有契约：05（§7.4 IPC 白名单 / §7.5 本地实例）、11（自动更新）、13
> （远程插件编排）、14（休眠/唤醒/设置）、16（VS Code 深链）、17（gateway
> 会话与凭据）、18（dsh 运行时版本管理 + apply-now）、19（桌面通知投影）、20
> （open-in 注册表）、21（gateway 插件对齐）、24（归档清理）。

## 0. 摘要（给决策者的三分钟版）

- **路线 A 的定义**：Swift/AppKit 只实现"壳"（窗口、WKWebView、菜单/托盘/
  通知/角标/深链/对话框/外部打开），**壳内不承载任何业务**；业务 = 现有
  control-plane（纯 Node 12.1k 行）+ desktop 纯 Node 业务模块（约 15.5k 行），
  以**打包为独立 Node 可执行文件的 sidecar 子进程**原样运行，Swift 与它之间
  走一条受信的 stdio JSON-RPC 通道（B 桥）；Web UI 100% 复用，仅把 preload
  的 `window.dshChamber` 换成一个等价的注入 shim（A 桥）。
- **为什么可行（现状核实）**：① desktop 全部非测试代码约 23.5k 行，其中
  **真实依赖 Electron 的仅 3 个文件**（main.ts 5,802 + preload.cts 895 +
  updater.ts 1,232 ≈ 7.9k 行），其余业务模块零 Electron import、测试直接
  `node *.test.ts` 可跑（transport-manager.ts:56 提到 electron 的只是注释，
  不是导入）；② 控制面本来就是 loopback HTTP/WS 服务，与宿主只通过
  `createControlPlane(options)` 参数握手（options 全字段可选，
  control-plane/src/index.ts:159-227）；③ dsh 实例本身是 Node 进程，
  `spawn-dsh.ts` 的 node 解析在纯 Node 进程自动走 `process.execPath` 分支
  （前提：**捆绑二进制基名必须是 node**，见 §4.3）；④ 桥接面已收敛：60 个
  `ipcMain.handle` + 8 个 push 事件，通道名集中在 `ipc-events.ts` 的
  `IPC_CHANNELS`（68 键、当前全部恰用一次），由 `ipc-surface-mirror.test.ts`
  锁步（锁步范围 = 通道名字符串集合 + 类型/字段镜像，不含方向/命名空间归属
  ——manifest 生成器需补该维度，见 §4.4.3）。
- **工作量（熟练工程师人-日；日历折算与三档排期见 todo companion §九）**：M0
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
| A1/A2/A11 | "4 个文件依赖 Electron"笔误；23.5k/21k 行口径高估 | §0/§4.2 改：Electron 仅 3 文件 ≈7.9k；纯 Node 业务 ≈15.5k（desktop 非测试全量 ≈23.5k 含三文件） |
| A3 | "port 从 17500 起试"与现状不符 | §3.3 改：**打包固定 17500 无退避**（main.ts:253-281）；dev 从 17520 起退避 200 次或 DSH_CHAMBER_CP_PORT 钉死；控制面 EADDRINUSE 即失败；**dsh 实例**从 17510 起 +1 ≤5 次 |
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
| C1 | Electron backgroundThrottling:false 无 WKWebView 等价物 | **P0 G2/G5 增子项**（hide ≥30s SSE 心跳/唤醒实测，失败=已知降级或 keep-alive 方案） |
| C2 | WebKit 存储隔离（WKWebsiteDataStore 独立 jar） | §6.2 共存语义写明；**P0 增实测**（双 flavor 交替同实例的会话 cookie/登录态） |
| C3/E6 | 剪贴板读写权限模型差异 | §5 E16 行文精确 + P0 对拍加"粘贴/剪贴板读" |
| D1 | shim 挂出时机 vs preload"先 info 后 expose"语义 | §4.4.1 二选一明确 + P0 对拍（两类 hydration 链等值） |
| D2 | sidecar stdout=协议流 与存量 console.log 冲突 | sidecar-entry 顶部 console→stderr 重定向；fail-loud 只针对重定向后意外泄漏 |
| D3 | 通知 click 需先激活窗口 | click 顺序 = NSApp.activate + orderFront（含无窗重建）→ 回 B 桥 → core 队列；HostEdges 补 focusMainWindow() |
| D4/D6 | 退出链三分支 + 5s 硬顶 + LOCAL_RUNNING_STATES 判据 | §3.3/§5 E9 补 |
| D8 | ready 帧与 INFO 双源漂移 | ready 帧最小化（port + shellVersion），其余全走既有 dsh-chamber:info |
| E1 | §7 v1 降级用 idle\|error 会让 UI 永不出现入口且显示失败态 | 改用现成 **blocked-available 形态**：真实 check（对比 GitHub Releases，复用 updater.ts 纯函数）→ phase='available' + releaseUrl + installBlockedReason='原生壳不支持自动安装'；update-restart 显式错误 |
| E2 | 共享 renderer 缺 shell-flavor 判别字段（platform 同为 darwin） | `dsh-chamber:info` 载荷增 **flavor: 'electron'\|'swift'**；同步 preload/global.d.ts/镜像测试；UI 门（更新文案等）加 flavor 条件 |
| E7 | W6 应注明无 backgroundThrottling 等价物 | §8.5 W6 注（同 C1） |
| E8 | shim 是第三处通道面，手写会漂移 | manifest 同时产出 Swift 枚举 + chamber-bridge.js 存根；测试断言两者 == 提交物 |

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
- **sidecar** = 打包产物：`node sidecar.js --user-data-dir <dir> [--dsh-path
  <dir>] [--pnpm-dir <dir>] [--stdio|--socket <path>]`；stdout/stderr 不混业务：
  **sidecar-entry 入口把存量 console.log/console.debug 重定向到 stderr**
  （main.ts 遍布业务日志如端口行 :1787、will-quit 清理完成串 :1673——实机
  门禁断言该串；不重定向则 B 桥首发即撞非协议行）；fail-loud 只针对重定向
  后的意外泄漏；stderr 是唯一日志通道（落 `~/Library/Logs/` 或
  userData/logs）。
- dsh 实例与控制面关系完全不变（05 §7.5：`PlaneHandle.startLocal()` 预启动、
  按需 spawn、reaper）；**迁移后 dsh 子进程的 node = sidecar 自身可执行文件**
  （须命名为 node，spawn-dsh 纯 Node 分支，§4.3）。
- **资源路径注入**：Swift 无 Electron 的 isPackaged/resourcesPath 概念——
  sidecar-entry 通过参数注入 .app 内路径：builtin dsh workspace
  （Resources/sidecar/vendor/dsh）、webDistDir（Resources/sidecar/dist/web）、
  三个宿主包 sourceDir、pnpm（Resources/sidecar/pnpm）。对应 main.ts 中
  ≈15 处直拼点（350-359/766/1813/1819-1827/4026-4028 等）的 P1 参数化
  （§4.1 B1/B13）。

### 3.2 仓库落位（待 §10 决策 4 定稿；本文按推荐）

```
macos/                          # SwiftPM 可执行包（或 xcodeproj）
  Package.swift
  Sources/DSHChamberApp/…        # AppKit 壳（AppDelegate、窗口、WKWebView）
  Sources/DSHChamberBridge/…     # A 桥 shim 注入与消息处理、B 桥客户端、manifest
  Sources/DSHChamberEdges/…      # 通知/角标/托盘/深链/open-in/对话框/更新/登录项
  Sources/DSHChamberPoc/Generated/BridgeManifest.swift   # 构建脚本生成（随提交，防漂移）
  Tests/…                        # XCTest（信封解析、护栏、监督、协议）
  Resources/                     # 运行时占位（sidecar 由构建脚本拷入）
scripts/build-swift-app.mjs      # 调 pnpm 产物 + swift build + 资源装配
scripts/emit-bridge-manifest.mjs # IPC 通道 manifest → Swift 枚举 + shim 存根（§4.4.3）
```

sidecar 的 JS 面不动仓库布局：`packages/desktop` 继续是双 flavor 的宿主
（Electron entry `main.ts` 保留；新增 `sidecar-entry.ts` 及其 host-edge 适配，
§4.1）。sidecar 打包布局 = **tsc 编译产物（control-plane/dsh-runtime）+
dist/web + dist/host-*-package + 捆绑 node/pnpm**，复用 build-control-plane.mjs
的"双路径解析"机制（打包态 import 编译产物、dev/测试走 pnpm 符号链接，
control-plane-module.ts:5-30 同款注释）——sidecar 与 Electron 打包共享同一
产物目录族（packages/desktop/dist/{web,control-plane,host-*-package}）。

### 3.3 启动序列（状态机）

1. Swift `applicationDidFinishLaunching`：解析 argv/深链 → 计算 userData dir
   （§6.1）→ **目录锁**（§6.3）→ 启动 SidecarSupervisor。
2. Supervisor：spawn `node sidecar.js`；sidecar 自行完成今日 main.ts 的启动
   职责（端口裁决见下；目录锁在 sidecar 内复验但不二次 flock）→
   `createControlPlane`（**打包态固定 17500、无退避**（main.ts:253-281，
   EADDRINUSE 即 loud 失败）；dev 态 17520 起退避 200 次或
   `DSH_CHAMBER_CP_PORT` 钉死；**dsh 实例端口从 17510 起 +1 ≤5 次**——05
   §3.3 注）→ pre-spawn 本地实例 → 输出 **ready 帧最小化 {port,
   shellVersion}**（其余身份字段全走既有 `dsh-chamber:info` 通道，保留其
   10×50ms 重试与 null 兜底语义，防双源漂移，D8）。
3. Swift 收到 ready → 用 `http://127.0.0.1:<port>/` 建 WKWebView 并 loadURL
   （A 桥注入时机见 §4.4.1 D1：**Swift ready + origin 门开放后才定义
   dshChamber**，复刻 preload"先 info 后 expose"；或 documentStart 预定义但
   就绪前统一 reject——二选一写入 P0 对拍）。
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

- `shell-core.ts`（新，Electron-free）：从 main.ts 原样搬入全部业务装配、
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

HostEdges 接口草案（字段语义与今日一一对应；v2 较 v1 的补全见 §0.1）：

```ts
interface HostEdges {
  // 原生显示/系统集成
  showNativeNotification(n: NativeNotificationSpec): () => void  // 返回 click 回执（B4）
  notificationSupported(): boolean
  notifyClicked(openIntent: NotificationOpenIntent): void
  setBadge(count: number): boolean
  trayAvailable(): boolean
  setKeepAwake(on: boolean): void
  onSystemResume(cb: (ts: number) => void): void
  onMainWindowShown(cb: () => void): void                    // held-resume 补发点（B9）
  isFocused(): boolean
  focusMainWindow(): Promise<void>                            // 通知 click 激活腿（D3）
  webViewLoading(): boolean                                   // 渲染器可用性门（B3）
  webViewContentAlive(): boolean
  // 打开/拉起
  openExternal(url: string): Promise<void>                    // 预算/冷却/规范化在 core（B11）
  openPath(p: string): Promise<void>
  showItemInFolder(p: string): void
  launchApp(appId: string, path: string): Promise<boolean>    // open-in 原生拉起（§5 E12）
  // 对话框（E8：仅插件源 folder|.tgz 一体化 picker，design 21 §10 ⑧/13 §5.8）
  pickPluginSource(): Promise<{kind:'folder'|'tgz'; path:string} | null>
  showError(title: string, detail: string): void
  showMessage(opts): Promise<buttonId>
  // 系统/身份/资源
  setLoginItem(enabled: boolean): void
  isPackaged: boolean                                         // 能力位（B1）
  resolveResource(kind: 'builtin-dsh'|'pnpm'|'dist-web'|'host-package'|'icon'): string
}
```

> 注：v1 草案的 `pickDirectory()` 已删除——`desktop_pick_directory` 通道在
> IPC_CHANNELS（68 键）与 preload 中均已不存在（仅 05 §7.4 旧文残留，A10）；
> 宿主对象登记/淘汰（BoundedActiveNotifications 持 Electron Notification、
> 淘汰=evicted.close()）留在 electron-edges，core 只持有界 ACK 队列/去重/限速
> （B4）。

### 4.2 复用清单（现状核实）

| 资产 | 规模（非测试行） | Electron | 去向 |
|---|---|---|---|
| control-plane（含 proxy/ws/静态伺服/seed/reaper） | 12.1k | 无 | sidecar 原样（编译产物复用 build-control-plane 模式） |
| dsh-runtime | 11.4k | 无 | sidecar 原样 |
| transport-manager / ssh-provider / gateway-provider / gateway-session(+refresh) / plugin-sync / connection-save / ssh-config / plugin-tarball / notifications(裁决) / deep-link(解析) / audit-log / badge(裁决) / chamber-settings / dsh-runtime-controller / apply-now / disk-evidence / 凭据文件事务族 | ≈15.5k | 无 | core 原样 |
| open-in（分类/校验）+ 原生拉起 | 纯逻辑 | 拉起点在 main | 逻辑进 core；拉起走 HostEdges.launchApp |
| main.ts 编排 + preload + updater | ≈7.9k（5,802+895+1,232） | **3 文件，全部** | P1 拆分；updater 走 §7 |
| ipc-events.ts IPC_CHANNELS + ipc-surface-mirror 测试 | — | — | **manifest 单源**（§4.4.3），不动 |
| 资源/打包路径直拼点 | ≈15 处（main.ts:350-359/766/1813/1819-1827/4026-4028 等） | 部分 | P1 参数化进 HostEdges.resolveResource（B1） |

### 4.3 Node 运行时分发（sidecar 的运行时底座）

- **捆绑**：fetch 固定版本官方 Node（arm64 + x86_64，或按 §10 决策 6 决定
  单一架构/universal），SHA-256 校验后进 `.app/Contents/Resources/sidecar/
  node`。**基名必须叫 `node`**：`resolveNodeExecutable`（spawn-dsh.ts:435-447）
  的纯 Node 分支只在 `basename(execPath) ∈ {node,node.exe}` 时直用
  process.execPath，否则回落 PATH/knownNodeLocations（nvm 等）→ 裸 'node'
  （系统 node 版本不可控）——捆绑命名 `node` 即零改动成立；建议 P1 加一次
  解析断言测试钉死该前提（A5）。Electron 分支 = execPath +
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
  runtime/notifications/badge）**（preload.cts:861-875；合计 60 invoke + 8
  订阅）。Swift 注入 `chamber-bridge.js`（WKUserScript、.page world、
  documentStart）定义同形 API：
  - **挂出时机（D1）**：preload 是 `requestAppInfo` resolve 后才 expose
    （preload.cts:859-895），页面早期 dshChamber 完全缺失、渲染侧靠
    bridge-hydration"surface 缺失 + 100ms×20 快速链"自愈（update-store.ts
    注释）。shim 二选一：① Swift ready + origin 门开放后才注入定义（复刻
    "先 info 后 expose"）；② documentStart 预定义但所有方法就绪前统一
    reject。**P0 对拍两类的 hydration 行为等值性**。
  - 方法面：按 manifest 生成 `dshChamber.<ns>.<method>(args)` →
    postMessage({id, method, payload})，以 id 关联 Promise（含 info 的
    10×50ms 重试语义照搬——仅 reject 时重试）。
  - 事件面：8 个 push → shim 订阅表，Swift `evaluateJavaScript`
    ("__dshChamberEmit(event,payload)") 派发（通道名/载荷以 IPC_CHANNELS/
    05 §7.4 为权威）。
  - 防护：Object.defineProperty 非可配置挂载防页面覆盖。
- Swift 端 `WKScriptMessageHandler` 护栏（只做传输层，语义校验在 sidecar）：
  1. 主 frame；2. origin === 当前控制面 origin（port 只在 ready 帧后放开）；
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
- 护栏：Swift 只接受自己 spawn 的进程 fd；帧长上限与超时；非协议帧 fail-loud
  （重定向后仍泄漏说明有 console 直写，须修）。
- 事件推送经 B 桥到 Swift → A 桥 emit，事件名清单 = manifest。

#### 4.4.3 通道 manifest（防双份漂移）

- 单源：`IPC_CHANNELS`（ipc-events.ts）+ preload 的 invoke/on 字面量集。
  现有 `ipc-surface-mirror.test.ts` 锁步的是**通道名字符串集合 + 类型/字段
  镜像**；它**不**提供每通道"方向/命名空间归属"、**不**保证 IPC_CHANNELS
  无死成员（当前 68/68 恰用一次是事实非断言）。
- 新增 `scripts/emit-bridge-manifest.mjs`：解析两侧 → 产出
  `bridge-manifest.json`（通道名 + **方向 invoke|push + 归属命名空间**）→
  Swift 构建期生成 `BridgeManifest.swift` **和 chamber-bridge.js 存根**
  （§0.1-E8：shim 是第三处通道面，方法/事件面自动产出，防手写漂移）→ 新增
  `bridge-manifest.test.ts`：生成物 == 提交物 + **通道数守恒（68 = 60+8）+
  无死键断言**（每个 IPC_CHANNELS 常量至少被 main 侧使用一次，B12/E8）——
  三侧（main/preload/Swift+shim）永不漂移。
- P1 配套：`ipc-surface-mirror.test.ts` 的 `MAIN_SIDE_FILES=['main.ts']`
  （:527）扩为新的注册者文件集（['main.ts','shell-core.ts']），badge pin
  断言等源码文本锚点随迁（renderer-trust.test.ts:106-141、
  transport-manager.test.ts:2185-2188 同族）。

### 4.5 通知点击与深链去重语义（design 19 §3.3 / 16 §4.2 的宿主移植）

- 通知 click：`pendingNotificationOpens` 有界 ACK 队列与去重/限速留在 core；
  **对象登记/淘汰（BoundedActiveNotifications 持 Electron Notification 宿主
  对象，淘汰=evicted.close() main.ts:984-988）属 electron-edges**（B4——core
  不能持有宿主对象；UNUserNotificationCenter 的 delegate 由系统持有、Swift
  无防 GC 坑也无 close 事件需淘汰登记）。HostEdges showNativeNotification
  返回 click 回执绑定；**click 顺序（D3）** = NSApp.activate + 窗口 orderFront
  （含无窗重建，applicationShouldHandleReopen 同路）→ 回 B 桥
  notification-clicked → core 队列 → 窗口就绪后 push。就绪/重建竞态兜底 =
  **三事件映射**（§5 E19，B5/D5）：didStartProvisionalNavigation（复位 ready
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
| E3 | **未自定义应用菜单**（默认菜单含 Edit role，Cmd+C/V 靠它；Menu 只用于托盘 :779） | NSMenu 标准菜单 + **Edit 项（copy/paste/selectAll 走 first responder → WKWebView）** | 缺菜单会丢 Cmd+C/V/全选，**必须做**（W2） |
| E4 | `Notification` + `Notification.isSupported`；**session 权限 handler 显式拒绝网页 Notification**（:5693-5695） | `UNUserNotificationCenter`；授权请求时机与现状一致 | **网页 Notification 双路径风险（B10）**：WKWebView 无等价预拒绝 API，网页 requestPermission 会绕过 chamber 裁决直发——P0 实测官方 UI 是否存在网页通知入口并处置 |
| E5 | `app.setBadgeCount`（平台门 + badgeEnabled 裁决在 core） | `NSApp.dockTile.badgeLabel` | 门控逻辑留 core（badge.ts） |
| E6 | `powerMonitor.on('resume')` + held lastResume 补发（挂在 win.on('show') :1434-1441） | `NSWorkspace.didWakeNotification` + HostEdges.onMainWindowShown（窗口显示/恢复事件）→ core 补发语义原样 | 推送 `dsh-chamber:system-resume {timestamp}` |
| E7 | `powerSaveBlocker`（keep-awake 断言） | `ProcessInfo.beginActivity(.idleSystemSleepDisabled…)` 或 IOKit 断言 | 触发条件随 core 状态机原样（网关会话保持等，14） |
| E8 | `dialog.showOpenDialog`（唯一 = 插件源 folder\|.tgz 一体化 picker :334-347，darwin 双模式，**design 21 §10 ⑧ / 13 §5.8**） | `NSOpenPanel`（canChooseDirectories + canChooseFiles 双模式） | 归档清理（design 24）无任何文件对话框 |
| E9 | `dialog.showErrorBox/showMessageBox`（fatal 启动/前端崩溃/退出确认 D2）+ fatal 边界（uncaughtException → app.exit(1) :230-251） | `NSAlert`（sheet 或 app-modal）+ **sidecar fatal 边界：stderr + 非零退出码分级，Supervisor 分流文案** | 退出确认三分支与 5s 硬顶（§3.3/4） |
| E10 | `shell.openExternal`（外链/发布页/`openVscodeUrl`） | `NSWorkspace.shared.open(URL)`（URL 规范化/预算/冷却在 core，main.ts:1269-1303） | open-release 亦此 |
| E11 | `shell.openPath/showItemInFolder` | NSWorkspace `open(_:)` / `activateFileViewerSelecting` | 失败模式语义照搬 |
| E12 | open-in 拉起 Finder/VS Code/应用 | `launchApp` 走 HostEdges：NSWorkspace 按 bundle id/path 启动 + activate | 分类/校验逻辑留 core（open-in.test.ts 继续覆盖） |
| E13 | 深链注册（打包态 `dsh-chamber://`） | Info.plist `CFBundleURLTypes` + `application(_:open:)` | 冷/热启动入队语义见 §4.5 |
| E14 | `app.setLoginItemSettings(openAtLogin)` | macOS 13+ `SMAppService.mainApp`；旧系统 NSLoginItem 兜底 | 设置面语义不变（14） |
| E15 | `safeStorage`（gateway-secrets v3） | **不移植**：Swift flavor 走既有"诚实 0600 明文"回退；旧 safeStorage 密文"保留禁用待重录"（判别单测 **S1**，编号避开 §5 E 表） | 更强者加密 → 决策 7 |
| E16 | `session` 权限 handler：只放行 clipboard-sanitized-write（**写**） | WebKit：写 = 用户手势自动放行（无需弹窗）；**读走 NSPasteboard 用户授权** | P0 对拍加"粘贴（富文本/图片）与剪贴板读"（C3） |
| E17 | `crashReporter.start` + `child-process-gone` 诊断（:287/:295-301） | 不移植（macOS 崩溃报告原生 + Supervisor 日志）；child-process-gone 留 electron-edges | — |
| E18 | `requestSingleInstanceLock`/second-instance | NSRunningApplication 或锁文件二次激活（bundle id 相同时 LaunchServices 已保证） | 双 flavor 互斥见 §6.3 |
| E19 | renderer 崩溃恢复（installRendererRecovery :1178-1267：500ms + 60s≤3 次 + 15s unresponsive + render-process-gone :1235-1240） | **三事件映射**：didStartProvisionalNavigation（复位 + requeue）/ didFinish（drain）/ webViewWebContentProcessDidTerminate（复位 + requeue + 500ms 有界重载，60s ≤3 次 + NSAlert） | **unresponsive 腿 v1 明示不可移植**（WKWebView 无该事件）或换心跳探测 |
| E20 | `app.on('activate'/'window-all-closed')`（darwin 且 close-behavior='quit' 时也必须 quit :1510-1516） | `applicationShouldHandleReopen` 等 + windowShouldClose 判 close-behavior：'quit' → NSApp.terminate 走完整确认链，绝不无窗常驻 | 14 D1 语义 |

## 6. 数据、状态兼容与共存

### 6.1 userData 目录

- 目录名机制：Electron userData = appData + `app.getName()` = 打包
  productName 'dsh-chamber'（desktop package.json:31-32）→ 实际根
  `~/Library/Application Support/dsh-chamber`（dev identity =
  @dsh-chamber/desktop，用 --user-data-dir 隔离）。Swift 版默认**同根**，
  sidecar 以 `--user-data-dir` 参数接收，内部零改动。
- 直拼点全集（P1 参数化收口）：chamber-settings.json（:747）；runtime 基目录
  = userData 本体（:1688，dsh-runtime 树在 <userData>/dsh-runtime/…）；
  stateDir = userData/state（:1790，localDshHome=state/dsh-home）；ssh-plugin-
  journal.json（:1891-1894）；ssh-passwords.json（:2039）；gateway-secrets.json
  （:2080）；audit-log.jsonl（:2123）；ssh-instances.json（:2135/:2149）。
- 旧版 Electron 产物兼容：`*.corrupt` / `*.unbound-*` 保留物（A13）在 Swift
  首启前决定处置（预期：沿现有语义保留禁用，不主动清理）。
- 验证项 **U1**（实机）：确认 Swift 计算的根与 Electron 打包实根一致
  （编号避开 §5 E 表，A9）。

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
  - 文件内 pid/启动时间只作诊断，不作仲裁；
  - **Electron 版于 P1 同 PR 落地该锁**（现状 v0.2.2 Electron 无锁；落地前
    的并发属文档化不防护窗口）；
  - **防自锁陷阱**：sidecar"复验持锁"若在新 fd 上再 flock 会与 Swift 首锁
    互斥（flock 按 open file description 计）——sidecar 复验 = 读锁文件记录
    校验父 pid，**绝不二次 flock**；
  - 锁文件与秘密文件同纪律（0600、no-follow、原子创建）；新增 .lock 需随
    立项登记进 AGENTS/STATUS 秘密文件纪律清单（随 D1 立项登记）。
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
- **Swift 版 v1 = 诚实 blocked-available 形态（§0.1-E1 修订，不用 idle|error）**：
  UpdateState.phase 七值与接口方法/字段集（6 通道）**全部不变**（消费面
  settings-bridge UpdateSection.tsx/update-store/update-gate 零契约改动），
  只换控制器实现：真实 check（对比 GitHub Releases，可复用 updater.ts 纯
  函数 + isAllowedReleaseUrl 白名单）→ phase='available' + releaseUrl +
  installBlockedReason='原生壳不支持自动安装'——设置 UI 的 blocked 行 +
  releaseLink 零改动直接诚实呈现（新增该 known reason 的本地化映射）；
  update-restart 返回显式错误；updateDownloadReady 豁免恒 false（before-quit
  腿自然豁免，文档明示该差异）。**禁止**把检查合并为"打开发布页"——那会让
  UI 永不出现入口且每次检查显示失败态。
- **shell-flavor 判别字段（§0.1-E2）**：共享 renderer 无法用 platform 区分两 flavor
  （同为 'darwin'）→ `dsh-chamber:info` 载荷增 `flavor: 'electron'|'swift'`
  （或能力位 updateAutoInstall/notificationPermission），同步
  preload.cts/global.d.ts/L3 镜像测试；UI 能力门（更新文案/重启安装按钮等）
  加 flavor 条件。
- v2（P3 末，决策 3）：Sparkle（appcast 独立 EdDSA 密钥）——发布 CI 打
  dmg/zip 时生成 appcast。

## 8. 实施阶段、测试与验收

> 详细执行计划（M0–M5 六门、WBS W-01…W-32、P0 runbook、P1 四批施工单、
> Swift 施工顺序、防漂移门禁清单、R10–R13/A1–A8/W1–W6 判定、D1–D7 日程、
> 三档时间线 46–72 人-日）见 `docs/progress/todo/macos-swift-v1.md`，本节只
> 留契约性要点。

### 8.1 P0 POC（1–2 人周）——先证伪再立项

1. `macos/` 最小壳：WKWebView 加载**现成 Electron 版启动的控制面**（dev
   模式共用；注意 standalone/cli serve **不接 webDistDir**——现成唯一后端 =
   `pnpm run dev:desktop`，vite 直写 dist/web 由控制面伺服；P1 起可给
   standalone 加 --web-dist 或走 dev:sidecar）。
2. 手写 shim 接通 3 个通道：`info`、`desktop_ssh_instances_get`、
   `desktop_ssh_status_changed` 推送；通知 click 回 core 语义打桩。shim 挂出
   时机二选一对拍（§4.4.1 D1）。
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

### 8.2 P1 core 拆分（2–3 人周，Electron 不回归）

- §4.1 拆分 + HostEdges 全量定义（v2 字段集）；Electron 版跑全量测试作为
  门禁；core 对 electron 的 import 零容忍（CI lint）。
- **3 个测试把 main.ts/preload.cts 当源码文本断言**（ipc-surface-mirror
  :527 MAIN_SIDE_FILES、renderer-trust.test.ts:106-141、
  transport-manager.test.ts:2185-2188）→ 锚点随处理器迁移 shell-core.ts
  （属搬运账内工作，非"测试原样绿"）；**control-plane-module.ts:39-58
  isPackaged 门 flavor 化**（纯 Node 恒判非打包 → 走 workspace TS 源码
  import；sidecar 需直连编译产物或改造门）。
- 产出 `sidecar-entry.ts` + `node-edges.ts`；sidecar 可在纯 Node 下以"假
  Swift"驱动（`stdio-driver.ts`）跑通全量 60 通道冒烟——**在写任何 Swift 前
  先把 B 桥协议用现有 JS 测试资产钉住**。

### 8.3 P2 Swift 壳 v1（3–4 人周）

E1–E20 按 §5 实现（E15 走 §6.4）；manifest 生成与护栏；Supervisor 与启动
序列（§3.3）；A 桥 shim 全通道对拍；双端冒烟（swift-harness-driver：node
集成测试拉起 Swift harness 断言真实窗口/桥，loopback-http-test-server.ts
同款思路）。

### 8.4 P3 边沿完整 + 发布管线（2–3 人周）

- v2 更新（Sparkle，或按决策 3）；sidecar 打包布局 = tsc 产物 + dist/web +
  host 包 + node/pnpm（§3.2 双路径解析同构）；build-swift-app.mjs；CI：
  GitHub Actions macOS runner（swift build + XCTest + 打包 + ad-hoc/
  Developer ID + notarize——STATUS 已登记 mac 发布缺 Apple 凭据会阻断，
  Swift 版同此门禁，dry-run 不阻断路线）；图标/资源复用（icon.icns 平移）。

### 8.5 P4 实机门禁矩阵（1–2 人周）

逐项走查（对照 STATUS 清单风格登记残余）：打包态全链（控制面起动/本地实例
预启动/连接/网关凭据重录/运行时版本管理与回退/插件同步/归档清理入口（无
对话框）/通知点击/深链/隐藏恢复/唤醒补发/退出确认）；WKWebView parity 清单
（W1 剪贴板、W2 菜单快捷键、W3 富文本粘贴与拖拽、W4 打印/查找、W5 字体/
滚动/IME、W6 后台节流对 SSE/WS——**无 backgroundThrottling 等价物（C1）**，
判定标准见 todo companion §七）；性能基线对照 performance-baseline.md + **双端
性能/产物体积验收协议**（companion §七：相对门/绝对预算/能力门三形态、注入式探针
平移四场景、M5 双端同 tag 产物并排入库——.app/dmg/zip 体积目标 ≤ Electron × 0.75）。

### 8.6 测试策略汇总

| 层 | 内容 | 现状 |
|---|---|---|
| JS 业务 | desktop/control-plane/runtime 现有单测与镜像测试 | **原样复用**（P1 后跑同一文件集 + 3 个文本锚点测试随迁） |
| B 桥 | 信封/帧长/超时/乱序/edge 往返——node 侧 stdio-driver，Swift 侧 XCTest | 新增 |
| A 桥/护栏 | shim 与 manifest 一致性（bridge-manifest.test.ts，含 shim 存根）、origin 门、尺寸门 | 新增 |
| 集成 | node 集成测试拉起 Swift harness 断言真实窗口/通知/深链 | 新增 |
| 实机 | §8.5 矩阵 + C1/C2 | 新增，发布前执行 |

## 9. 风险与开放问题

- R1 **双业务源码漂移**：core 拆分后 Electron 版若独立演进，Swift 版会滞后。
  缓解：单 repo 单 core；host-edge 契约评审门禁；mirror + bridge-manifest 双
  锁步测试（含 shim 存根一致性）；同 tag 双壳发布。
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
- R11 Swift 侧人手单点：护栏规则集中 DSHChamberBridge 单 target + Generated
  产物减少手写面。
- R12 manifest 解析脆弱性：正则扫字面量会漏新写法 → 复用 mirror 解析函数 +
  通道数守恒断言（68=60+8）。
- R13 WKWebView devtools：仅 debug 构建开启（inspector 属信任边界）。

## 10. 待用户决策清单（立项输入；日程见 companion §八）

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
