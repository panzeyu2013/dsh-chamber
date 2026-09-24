# 25 · macOS Swift 原生壳（路线 A：WKWebView + Node sidecar 全复用）

> **路线 A 代码面**——Swift 壳、A/B 桥、sidecar 装配与打包链位于 `macos/` 与
> `packages/desktop`；正式 D1–D7 签核与 M5 实机/凭据门禁尚未完成（开放项见
> `docs/progress/STATUS.md`）。本文按路线 A（Swift 写壳、Node sidecar 原样承载 control-plane 与
> desktop 纯 Node 业务）给出契约与装配设计。
>
> **2026 打磨轮（v1 → v2）**：v1 定稿后评审裁决**可立项性通过（无 Blocker）、核心复用面事实成立**；
> Major 级修正并入本版（§0.1），路线 A 前提未被推翻。§2 外部仓库事实为 GitHub 检索所得
> [待核-外部]；涉 vendor 官方 UI 的行为判断标 [待核]（按已物化的 `vendor/harness-packages` 现取）。
>
> 外部决策见 §10（平台策略/bundle id/更新路线/仓库落位/Node 版本），实现按推荐默认值落位（共存、
> `com.dshchamber.native`、blocked-available、`macos/`、arm64），签核尚未完成；执行计划见
> `docs/progress/todo/macos-swift-v1.md`。§8.1 的 P0 验证门代码面已交付；G2–G5 与 **WebKit 后台
> 节流/存储隔离（C1/C2）** 的实机判定仍开放。
>
> **行号锚点**：正文中 `main.ts` 的 `:NNNN` 多数取自 P1 拆分前（5,802 行）基线；拆分后行号已漂移，
> 引用前按符号名/文件名 grep 现取。
>
> 相关契约：05（§7.4 IPC 白名单 / §7.5 本地实例）、11（自动更新）、13、14（休眠/唤醒/设置）、16、
> 17（gateway 会话与凭据）、18（dsh 运行时版本管理 + apply-now）、19（桌面通知投影）、20（open-in
> 注册表）、21、24（归档清理）；§5.3 原生席位 = `macos/Sources/DSHChamber/NativeText.swift#NativeTextKey`
> （文案键表）与 `macos/Sources/DSHChamber/NativeText.swift#NativeText`（取值链）+
> `macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageFacts`（页面语言/主题事实载波）。

## 0. 摘要（给决策者的三分钟版）

- **路线 A**：Swift/AppKit 只做"壳"（窗口、WKWebView、菜单/托盘/通知/角标/深链/对话框/外部打开），**壳内不承载业务**；业务 = control-plane + desktop 纯 Node 模块，打包为 sidecar 子进程（B 桥 stdio JSON-RPC）；Web UI 100% 复用，仅把 preload 的 `window.dshChamber` 换成 shim（A 桥）。
- **可行性**：真实依赖 Electron 仅 main.ts、electron-edges.ts、preload.cts、updater.ts 4 文件；其余纯 Node 模块零 import、测试直接 `node *.test.ts` 可跑（`transport-manager.ts:56` 仅注释；`electron-free-gate.test.ts` 传递闭包断言）；控制面经 `createControlPlane(options)` 握手（`control-plane/src/index.ts:159-227`）；dsh 实例是 Node 进程（`spawn-dsh.ts` → `process.execPath`，基名必须 node，§4.3）；桥接面 60 个 `ipcMain.handle` + 8 push，键集单源 `ipc-events.ts` 的 `IPC_CHANNELS`（68 键），`ipc-surface-mirror.test.ts` / `bridge-manifest.json` / `bridge-shim-surface.test.ts` 锁步（§4.4.3）。
- **工作量（人-日）**：M0 1–2 → M1 5–10 → M2 10–15 → M3 15–20 → M4 10–15 → M5 5–10，合计 **46–72 人-日（9–14 人周）**；Electron 版并行保留，Win/Linux 不受影响。
- **不做**：不重写 UI（luochenw/deepseek-harness-macos 全原生 = 3–6 人月 + parity 维护）；不在 Swift 重写宿主服务（summer-521/deepseek-harness-swift ≈900KB Swift + 自研 JS desktop-host = 路线 B，见 §2）；不碰 gateway。
- **决策点**：双壳**共存**还是**替换**；bundle id 区分（通知授权身份）；更新「v1 blocked-available + v2 Sparkle」；双线防漂移（§4.4.3 / §9 R1）。

### 0.1 v1 → v2 打磨轮闭合清单（评审 Major/Minor 处置摘要）

> 编号说明：本表「来源」沿用评审报告五维分类（A 事实 / B 完整性 / C WebKit /
> D 语义 / E 一致性），其中 E1/E2/E7/E8 与 §5 原生边沿表 E1–E20 **分属不同
> 编号域**；正文引用写作「§0.1-E1」等以示区分。

| 来源 | 发现 | 处置 |
|---|---|---|
| A1/A2/A11 | "4 个文件依赖 Electron"笔误；23.5k/21k 行口径高估 | §0/§4.2 口径（P1 拆分后重测）：真实依赖 Electron 4 文件（main.ts/electron-edges.ts/preload.cts/updater.ts）≈6.7k——打磨轮当时为 3 文件（electron-edges.ts 是 P1 新 seam）；纯 Node 业务模块零 import（electron-free-gate 传递闭包） |
| A3 | "port 从 17500 起试"与现状不符 | §3.3 改：**打包固定 17500 无退避**（`shell-core.ts:426-441` 的 resolveControlPlanePort）；dev 从 17520 起 bind 探测首个空闲端口（200 个候选），或按 `DSH_CHAMBER_SHELL_PORT` > `DSH_CHAMBER_CP_PORT` 钉死（Swift 侧 ControlPlanePort.swift）；控制面 EADDRINUSE 即失败；**dsh 实例**从 17510 起 +1 ≤5 次 |
| A4 | Supervisor backoff 误引 "5×500ms"（那是 renderer-ready 握手语义） | §3.3 改：sidecar 重启退避另立；renderer 恢复 = 500ms 延迟 + 60s 窗口 ≤3 次 + 15s unresponsive（main.ts:1178-1267）参数化 |
| A5/4.3 | spawn-dsh 纯 Node 分支有 basename 门；Electron 分支另带 --expose-internals | §4.3 写明基名约束 + 解析断言测试；Swift 捆绑 `Resources/sidecar/node` 即满足 |
| A6 | "13 命名空间"实为 4 标量 + 9 命名空间 | §4.4.1 全篇改口径（companion 同） |
| A7 | "macOS 无 argv 扫描"不实（open-url + argv 防御双路径，main.ts:1479-1482/1687） | §4.5 改写 |
| A8 | Electron 从未 setApplicationMenu（Cmd+C/V 靠默认菜单） | §5 E3 现状列改正，Swift 结论不变（W2 必修） |
| A9 | §6.1/§6.4 验证项编号 E1/E2 与 §5 边沿表撞车 | 更名 **U1**（userData 实根）/ **S1**（safeStorage 判别单测） |
| A10 | E8 对话框归属错引 design 24；desktop_pick_directory 已不存在 | E8 = 插件源 folder\|.tgz 一体化 picker（design 21 §10 ⑧ / 13 §5.8）；**删除无消费方的 pickDirectory()** |
| A13 | userData 清单漏 ssh-plugin-journal 与 *.corrupt | §6.1 补全 |
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
| C1 | Electron backgroundThrottling:false 无 WKWebView 等价物 | **收敛**：design 14 §D1 修订把 Electron 侧恢复为 Chromium 默认节流（实测隐藏期 rAF 0 / SSE 不受影响），两 flavor 隐藏态行为同向，本项差异消除；**P0 G2/G5 的实机子项保留**（打包态 hide ≥30s SSE 心跳/唤醒 + 隐藏期 CPU，见 STATUS 实机门禁） |
| C2 | WebKit 存储隔离（WKWebsiteDataStore 独立 jar） | §6.2 共存语义写明；**P0 增实测**（双 flavor 交替同实例的会话 cookie/登录态） |
| C3/E6 | 剪贴板读写权限模型差异 | §5 E16 行文精确 + P0 对拍加"粘贴/剪贴板读" |
| D1 | shim 挂出时机 vs preload"先 info 后 expose"语义 | §4.4.1 按实现收敛：documentStart 定义内部管路（带令牌），`dsh-chamber:info` 成功后才暴露 `dshChamber`；未就绪/失败期 invoke 回 `ipc_not_ready`（1+10 次 50ms 重试），全败分支与 preload 同形（surface 在、标量 null） |
| D2 | sidecar stdout=协议流 与存量 console.log 冲突 | sidecar-entry 顶部 console→stderr 重定向；fail-loud 只针对重定向后意外泄漏 |
| D3 | 通知 click 需先激活窗口 | click 顺序 = NSApp.activate + orderFront（含无窗重建）→ 回 B 桥 → core 队列；HostEdges 补 focusMainWindow() |
| D4/D6 | 退出链三分支 + 5s 硬顶 + LOCAL_RUNNING_STATES 判据 | §3.3/§5 E9 补 |
| D8 | ready 帧与 INFO 双源漂移 | ready 帧最小化（port + shellVersion），其余全走既有 dsh-chamber:info |
| E1 | §7 v1 降级用 idle\|error 会让 UI 永不出现入口且显示失败态 | 改用现成 **blocked-available 形态**：真实 check（对比 GitHub Releases，复用 updater.ts 纯函数）→ phase='available' + releaseUrl + installBlockedReason='原生壳不支持自动安装'；update-restart 显式错误 |
| E2 | 共享 renderer 缺 shell-flavor 判别字段（platform 同为 darwin） | 字段存在（`main.ts:3858` 载荷带 `flavor`，镜像面仍 4 标量）；**UI 能力门最终由 `installBlockedReason`/原生能力位驱动，renderer 未消费 flavor**（零消费者，保留字段不加条件） |
| E7 | W6 应注明无 backgroundThrottling 等价物 | §8.5 W6 注（同 C1） |
| E8 | shim 是第三处通道面，手写会漂移 | manifest 产出 Swift 枚举 + `Resources/chamber-bridge.stub.js` 锁步样本（不随 .app 打包）；真正注入的 `bridge-shim.js` 由 `bridge-shim-surface.test.ts` 对 preload 面逐命名空间锁步 |

## 1. 背景、目标与非目标

### 1.1 背景

dsh-chamber desktop 的 Electron 使用面已收敛为薄壳（AGENTS.md 运行时边界 + §3 现状核实）：
单窗口 `loadURL(http://127.0.0.1:<cp.port>/)`、域限定 IPC、原生边沿（通知/角标/深链/open-in/
托盘/唤醒）+ 运行时管理；"重逻辑"（连接/隧道/会话/插件同步/凭据事务/审计/运行时激活）全在纯
Node 侧。移植条件因此罕见：**把壳换掉，业务与测试资产原样保留**。

### 1.2 目标

1. macOS 上交付与 Electron 版**功能对等**的原生应用（原生窗口/菜单/Dock/通知/深链/系统集成），
   去掉 Electron/Chromium 运行时（内存、启动、包体）。
2. **零业务重写**：control-plane、desktop 纯 Node 模块、dsh-runtime 及其测试原样进 sidecar；
   现有单测/镜像测试继续跑同一 JS 代码面。
3. 单一业务源码：两 flavor 共享同一份 core（P1 拆分为前提），行为差异**只允许**出现在"宿主边沿
   适配层"，且有镜像测试与双端冒烟背书。
4. 信任模型不弱化：B 桥语义校验仍在 sidecar（今日 main 所在处），Swift 只做传输层护栏；凭据
   依旧 write-only、永不进 renderer。

### 1.3 非目标（明确不做）

- 不重写任何 Web UI/插件（renderer、dsh 官方前端、chamber 插件面）。
- 不做 Swift 原生 UI 渐进替换（那是路线 B/C，§10 决策 5 单独评估）。
- 不覆盖 Win/Linux（Electron 版继续承担）。
- 不做第二个 gateway、不进匿名控制面的执行域（AGENTS.md 硬纪律不变）。
- v1 不做 Sparkle 全自动安装（见 §7；先诚实 blocked-available 形态）。

## 2. 市场参考仓库对照 [待核-外部]

> 本表为 GitHub Search API 检索所得（外部实况，无法在本
> 工作树二次核实）。

| 仓库 | 路线 | 形态 | 对我们的可借鉴点 | 不借鉴点 |
|---|---|---|---|---|
| [luochenw/deepseek-harness-macos](https://github.com/luochenw/deepseek-harness-macos) | 全原生 UI | SwiftUI/AppKit 重写整个 dsh 客户端 UI + 内嵌 Node + JS runtime-extras 注入 | `scripts/prepare-dsh-runtime.sh`/runtime 钉版思路；`WEB_PARITY.md` 式功能对等清单；无 Xcode 工程也可行（swiftc 直接构建 + ad-hoc 公证） | 全原生 UI 的工程量（对照 §0）；UI 重写后的永久上游 parity 维护 |
| [summer-521/deepseek-harness-swift](https://github.com/summer-521/deepseek-harness-swift) | WKWebView 壳 + Swift 原生服务层 | AppKit/WebKit 壳；Swift 版版本管理、插件管理、恢复、设置、`NodeRuntime.swift`、Sparkle appcast | **壳层实现形态与路线 A 高度同构**：NodeRuntime + fetch-node/fetch-pnpm 脚本、WKScriptMessageHandler 消息校验、`swift-*-harness.swift` + node 集成测试双端模式 | 它自研的 `assets/dsh-desktop-host/*.js`（≈90KB）正是我们**不需要**的：我们用现成 control-plane 替代 |
| [wheam/deepseek-harness-mac-app](https://github.com/wheam/deepseek-harness-mac-app)、[aibinghezzz-stack/deepseek-harness-macos](https://github.com/aibinghezzz-stack/deepseek-harness-macos)、[guanyifang344/dsh-launcher-mac](https://github.com/guanyifang344/dsh-launcher-mac) 等最小壳 | 最小壳 | 几百行 WKWebView 加载 dsh web | POC 下限证明：WKWebView + NSAllowsLocalNetworking 跑通 dsh web GUI 无障 | 无 IPC/凭据/运行时管理，不可直接作为 chamber 壳 |

结论：市场**没有** chamber 能力的 Swift 参考实现（SSH 隧道、gateway 会话、宿主包种子、N-ctx
编排）；这些在路线 A 复用 sidecar，参考仓库只能校准"壳与打包"成本。

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
│    61 invoke 处理器（含 info）+ 8 push 事件源（语义校验原样）│
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

- **Swift 壳**不 import 业务模块，只是"边缘执行器 + 传输层护栏 + 窗口"；业务状态全在 sidecar。
- **sidecar** = 打包产物，传输恒为 **stdio**（未实现的 `--socket` 不作接口面）。实参同 `sidecar-entry.ts`：
  `node sidecar.js --user-data-dir <dir> [--dsh-path <dir>] [--web-dist-dir <dir>] [--host-graph-dir <dir>]
  [--host-git-dir <dir>] [--host-archive-dir <dir>] [--host-open-in-dir <dir>] [--port <n>]
  [--native-updater <feed|off>]`
  （pnpm/host 路径由内部布局解析，无 `--pnpm-dir`）。stdout/stderr 不混业务：**入口把存量
  console.log/console.debug 重定向到 stderr**（main.ts 业务日志如端口行 :1787、will-quit 完成串 :1673——实机
  门禁断言该串），否则 B 桥首发即撞非协议行；fail-loud 只针对重定向后泄漏；stderr 是唯一日志通道（`~/Library/Logs/` 或 userData/logs）。**sidecar stderr 透传行另有独立有界落盘** `<userData>/logs/sidecar.log`（`ShellLog.sidecar.configureSidecar` + `BridgeClient.sidecarLogSink`；**规格**：单文件 256 KiB、单份轮转 `sidecar.log.1`（名按实例文件名派生）、目录 0700 / 文件 0600、写失败静默退 stdout——同 design 02 §3.8 控制面 sink 的权限纪律、保留量更小）。**壳自身日志** `<userData>/logs/shell.log`（`ShellLog.shared`，同 256 KiB / 单份 `.1` / 0700-0600）记启动、sidecar spawn/退出、导航失败、更新相位与退出链关键行（经 `shellLog` 同写），是 T-25「原生壳本地 dump」的主角（由 `native-shell.log` 改名，见 deviations T-17）。**两链关系**：控制面 `<stateDir>/logs/control-plane.log` 是 WS splice 归因行的**权威**去向（两 flavor 都有，`createControlPlane` 无条件包装，02 §3.8）；`sidecar.log` 是原生壳**兜底**（覆盖控制面 sink 建立前的 stderr，如 fatal 启动输出；同批 console 行存两份）。**flavor 偏差（已登记 deviations）**：Electron 1 份 `control-plane.log`（2 MiB × 3 = 6 MiB），原生壳 2 份（另有 `sidecar.log` 256 KiB × 2 轮转环 = 512 KiB），合计 6 MiB + 512 KiB。
- dsh 实例与控制面关系不变（05 §7.5：`PlaneHandle.startLocal()` 预启动、按需 spawn、reaper）；**迁移后 dsh
  子进程 node = sidecar 自身可执行文件**（须命名为 node，§4.3）。
- **资源路径注入**：Swift 无 isPackaged/resourcesPath 概念，sidecar-entry 以参数注入 .app 内路径：builtin dsh
  workspace（Resources/sidecar/vendor/dsh）、webDistDir（**Resources/dist/web**，由 AppDelegate 按候选解析：resourceURL/dist/web → sidecar/dist/web）、
  四个宿主包 sourceDir（Resources/sidecar/dist/<pkg>；含 localOnly 的 open-in）、pnpm
  （Resources/sidecar/pnpm；sidecar-ctx 探测 moduleDir/pnpm →
  moduleDir/../pnpm → dev node_modules/pnpm）。对应 main.ts ≈15 处直拼点（350-359/766/1813/1819-1827/4026-4028
  等）的 P1 参数化（§4.1 B1/B13）。

### 3.2 仓库落位（§10 决策 4 的推荐 `macos/` 已落位）

```
macos/                          # SwiftPM 可执行包（或 xcodeproj）
  Package.swift
  Sources/DSHChamber/…        # 可执行 target（P0 从简；AppKit 壳 + A 桥/B 桥 + 宿主腿同 target，
                                 #  product 化拆 target 未排期——见 Package.swift 头注释）
  Sources/DSHChamberWebKitSupport/… # 静态 C support target（§5.1：关 WebKit prefer-60fps 偏好）
                                 #  ——不是 product 化拆 target，目标文件链进同一可执行文件
  Sources/DSHChamber/Generated/BridgeManifest.swift   # 构建脚本生成（随提交，防漂移）
  Tests/…                        # XCTest（信封解析、护栏、监督、协议）
  Resources/bridge-shim.js   # A 桥注入 shim 真身（bridge-shim-surface 锁步）
  Resources/chamber-bridge.stub.js # manifest 生成物（锁步样本，不随 .app 打包）
  Info.plist.template / entitlements*.plist # W-24 渲染/签名输入
  Resources/                     # 其余运行时占位（sidecar 由构建脚本拷入）
macos/scripts/build-swift-app.mjs       # 调 pnpm 产物 + swift build + 资源装配
packages/desktop/scripts/build-sidecar.mjs  # sidecar 装配
packages/desktop/scripts/emit-bridge-manifest.mjs # IPC 通道 manifest → Swift 枚举 + chamber-bridge.stub.js 锁步样本（§4.4.3）
```

sidecar 的 JS 面不动仓库布局：`packages/desktop` 仍是双 flavor 宿主（Electron entry `main.ts` 保留；
`sidecar-entry.ts` 及 host-edge 适配在 §4.1）。sidecar 打包布局 = **编译产物 `dist/control-plane/` + host 包
`dist/dsh-chamber-seed-*/` + 内嵌 `vendor/dsh/` 与 `pnpm/` + 捆绑 `node`**；renderer 产物 `dist/web` 属 .app 的
`Contents/Resources/dist/web`（不在 sidecar 目录内）。复用 build-control-plane.mjs 的"双路径解析"（打包态 import
编译产物、dev/测试走 pnpm 符号链接，control-plane-module.ts:5-30 注释）——sidecar 与 Electron 共享
`packages/desktop/dist/control-plane`；**host 包不同源**：Electron 走 `build-host-graph-package.mjs` 产的
`dist/host-*-package`，sidecar 直接读 `packages/dsh-chamber-seed-*/{package.json,dist/index.js}` 拷进自己的
`dist/dsh-chamber-seed-*/`（两条腿别混目录名）。

**装配目录（`scripts/build-sidecar.mjs` 的 `sidecarLayout`，:156-172）**：
`<out>/{node, sidecar.js, package.json, dist/control-plane/, dist/dsh-chamber-seed-*/, vendor/dsh/, pnpm/}`。要点：
- `sidecar.js` = esbuild 入口（shell-core 全家 + sidecar-ctx + node-edges + dsh-runtime）；
  `@dsh-chamber/control-plane`、`electron` 与 `./dist/control-plane/index.js` 为运行期外部；
- 装配目录必须带 `package.json`（`{type:'module'}` + chamber 版本）——shell-core 模块级 `version` 读取
  （`new URL('./package.json', import.meta.url)`）与 ESM 判定依赖它；
- **四个 chamber host 包**（T2 包名，`packages/dsh-chamber-seed-{client-graph,
  git-worktree,archive-cleanup,open-in}`）：拷贝进 `<out>/dist/<同名>/`，Swift 侧按
  `--host-graph-dir/--host-git-dir/--host-archive-dir/--host-open-in-dir` 注入同一基名
  （`BuildSidecar.HOST_PACKAGES` 单源；`sidecar-ctx` 的 `hostPackageSourceDir` dev 兜底按同名在
  `packages/` 探测）——`scripts/release/packaging-manifest-lockstep.test.mjs` 在 build-sidecar /
  control-plane / 根构建链 / `HOST_PACKAGE_BUILD_ROWS` / AppDelegate 五处锁步，改名/加包要一起改。
- **open-in 是 localOnly 行（design 20 §6）**：随 .app 分发、**只**喂本地实例播种
  （`sidecar-entry --host-open-in-dir` → control-plane 的 `hostOpenInPackageSourceDir`）；**远端（SSH）种子表
  永不携带它**（`sidecar-ctx` 远端种子仍三项可移植行，`portableChamberHostPackageSeeds` 按 registry 的
  `localOnly` 过滤，与 Electron 侧 `chamberHostSourceDirs` 同源）——加进远端 seed 会把本地形态专属域上传到
  别人的机器。
- **运行期标记**：Swift Supervisor 装配态 spawn 注入 `DSH_CHAMBER_SIDECAR_COMPILED=1`
  （`control-plane-module.isPackagedSidecarRuntime`）→ control-plane 走相对编译入口；装配目录无 node_modules，
  裸说明符不可解析。
- Node 捆绑落位 `<out>/node`（**基名必须是 `node`**，§4.3 A5），SHA-256 校验后才落盘（摘要来源 = 仓库固定表，
  见 §4.3）。

**`.app` 装配（W-24 定稿，`macos/scripts/build-swift-app.mjs`）**：
`<App>.app/Contents/{Info.plist, MacOS/dsh-chamber, Resources/{icon.icns, DSHChamber_DSHChamber.bundle, sidecar/, dist/web}}`。约束：
- **SwiftPM 资源包必须放 `Contents/Resources`**：放 .app 根会被 codesign 判为「unsealed contents present in the
  bundle root」；`Bundle.module` 只查 `Bundle.main.bundleURL`（= .app 根）与构建目录，故打包态改用
  `ChamberResources`（resourceURL → bundleURL → 可执行目录）；
- **entitlements plist 不能带 XML 注释**（codesign 的 AMFIUnserializeXML 报解析失败）；壳侧最小集 =
  `disable-library-validation`（加载装配目录内独立签名的 node 与运行时安装的未签名原生模块），捆绑 node 另加
  `allow-jit` / `allow-unsigned-executable-memory`；
- **control-plane 只能经 `control-plane-module` facade 取**：装配目录无 node_modules，裸说明符
  `@dsh-chamber/control-plane` 会 `ERR_MODULE_NOT_FOUND`；facade 在装配态加载
  `<sidecar>/dist/control-plane/index.js`。
签名顺序 = 嵌套 node 先、主 app 后；Developer ID 带 hardened runtime（公证前置），ad-hoc 不带；正式发布仍缺
Apple 凭据（外部阻断）。

### 3.3 启动序列（状态机）

1. Swift `applicationDidFinishLaunching`：解析 argv/深链 → 计算 userData dir
   （§6.1）→ **目录锁**（§6.3）→ 启动 SidecarSupervisor；启动链 reconcile
   `<userData>/chamber-settings.json` 的 `keepAwake`（缺文件 = off 且无日志、损坏 = loud + off、
   合法 = 经与 settings UI 同一个 `setKeepAwake` 宿主腿应用；AppDelegate.swift:322-328 /
   StartupSettings.swift）。
2. Supervisor：spawn `node sidecar.js`；sidecar 完成今日 main.ts 的启动职责（目录锁在 sidecar 内复验
   但不二次 flock）→ `createControlPlane`
   （**端口由 Swift 解析后以 `--port` 注入**：打包态固定 17500、无退避
   （main.ts:253-281，EADDRINUSE 即 loud 失败）；dev 态按 `DSH_CHAMBER_SHELL_PORT` >
   `DSH_CHAMBER_CP_PORT` > 17520 起 bind 探测首个空闲端口（200 个候选；ControlPlanePort.swift）；
   **dsh 实例端口从 17510 起 +1 ≤5 次**——05
   §3.3 注）→ pre-spawn 本地实例 → 输出 **ready 帧最小化 {port,
   shellVersion}**（其余身份字段走既有 `dsh-chamber:info`，保留其 10×50ms 重试与 null 兜底，
   防双源漂移，D8）。
3. Swift 收到 ready → 用 `http://127.0.0.1:<port>/` 建 WKWebView 并 loadURL（A 桥注入时机见 §4.4.1 D1）。
4. 运行时故障分级：
   - sidecar 崩溃/非零退出 → Supervisor 按重启退避重启（**无 Electron 先例，退避语义另立**：
     cp.start 失败 = fatal 退出；运行中崩溃 = 退避重启，上限与 renderer 恢复参数化同族）；fatal 边界
     = stderr 记录 + 非零退出码分级（启动失败 vs 崩溃），Supervisor 据码分流 NSAlert 文案（对照
     "启动失败/前端异常/打开 VS Code 失败"三个对话框，B7）；
   - WebView 进程终止 → `webViewWebContentProcessDidTerminate` 恢复循环 + ready 位复位 + in-flight
     requeue（§5 E19 三事件映射，对照 `installRendererRecovery` main.ts:1178-1267：500ms 延迟重载、
     **60s 滚动窗口内至多 3 次**、15s unresponsive 探测——Swift v1 无 unresponsive
     事件，该腿显式不可移植或换心跳探测）；重复崩溃 → NSAlert 停止自动恢复（同 `dialog.showErrorBox('前端异常'…)`）。**5×500ms 是
     renderer-ready 握手（deep-link-ready/notifications-ready）重试语义（05 §7.4），不是崩溃恢复
     ——勿混用（A4）**。
   - 退出链复刻 before-quit/will-quit（§5 E9/E12/E20 + D6）：确认-取消-重建
     三分支（mac close-behavior='quit' 时窗口已关 → 取消后重建）、keep-awake
     停 → badge 清 → 并行回收（传输层 → 控制面 → 本地 dsh 实例 →
     runtime 资源）→ **5s 硬顶强退**（Swift terminate 超时 = exit(_:)）；"本地实例在跑"判据 = cp.localProcessAlive + LOCAL_RUNNING_STATES 同款，勿只看
     connectionState（main.ts:1544）。
5. SIGTERM/SIGINT：Swift 捕获后转 `terminate` 优雅路径；sidecar 自身也处理信号——纯 Node 下
   `process.on('SIGTERM')` 真实可达（Electron 43 下是死代码，注释 main.ts:1488-1494 自证）。

## 4. 复用与拆分（核心工程）

### 4.1 main.ts 拆分：core / host-edge 契约（P1，Electron 版不回归）

现状：`main.ts`（5802 行）把业务装配与 Electron 边沿调用交织。P1 原则：**只做搬运与参数化，不改
语义、不重排状态机**。目标形态：
- `shell-core.ts`（Electron-free）：原样搬入全部业务装配、61 个 invoke 处理器体（含 info）+ 8 个事件源（语义
  校验原地保留）、退出状态机、深链 intent 队列、通知 click 有界 ACK 队列/去重/限速（notifications.ts
  纯逻辑 + main.ts 队列语义）、资源路径参数化收口。
- `HostEdges` 依赖注入面（下述）。判定标准：core 对 `electron` 零 import（CI lint 门禁，
  electron-free-gate.test.ts）；Electron 版全部桌面测试继续绿。
- `electron-edges.ts`（Electron flavor）：HostEdges → Electron API（今日 main.ts 全部 Electron 调用点
  原样搬迁）。**Electron 应用菜单现状 = 未自定义（默认菜单含 Edit role，Cmd+C/V 靠它）**——保持不动（A8）。
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

> 注：与 v2 草案差异 = 新增 `rendererPush`/`mainWindowAlive`/`badgeCountApiAvailable`/
> `retireNotificationsForSources`；`showNativeNotification` 带 `clickRoute` 并返回 `{dispose, shown}`；
> `setBadge` 判别形态、`showMessage` 归 number、`pickPluginSource` 归 `HostPluginSourcePick`；v1 草案的
> `pickDirectory()` 已删除——`desktop_pick_directory` 在 IPC_CHANNELS（69 键）与 preload 中均已不存在
> （仅 05 §7.4 旧文残留，A10）。宿主对象登记/淘汰（BoundedActiveNotifications 持 Electron Notification、
> 淘汰=evicted.close()）留 electron-edges，core 只持有界 ACK 队列/去重/限速（B4）。零 core 消费者的保留面
> （`resolveResource`、`isPackaged`、`notifyClicked`、`trayAvailable`、`focusMainWindow`、`launchApp`、
> 同步 `setKeepAwake`/`setLoginItem`——settings 路径走装配 ctx 的 async 叶）在 STATUS 登记为有意保留。

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

- **捆绑**：fetch 固定版本官方 Node（arm64 + x86_64，或按 §10 决策 6 单一架构/universal），SHA-256 校验后进
  `.app/Contents/Resources/sidecar/
  node`。**摘要的信任基座在仓库内**（`build-sidecar.mjs` 的
  `PINNED_NODE_SHA256`，逐字取自官方 `SHASUMS256.txt`）：默认版本两个 darwin 归档必须在表内，`--node-sha256` 与固定值冲突即拒绝；未固定版本（`--node-version`）回退联网 SHASUMS256.txt 并响亮说明——「没固定」不得呈现为「已校验」；升级默认版本 = 同一提交更新该表（`build-sidecar.test.mjs` 会红）。**基名必须叫 `node`**：`resolveNodeExecutable`（spawn-dsh.ts:435-447）的纯 Node 分支只在 `basename(execPath) ∈ {node,node.exe}` 时直用 process.execPath，否则回落 PATH/knownNodeLocations（nvm 等）→ 裸 'node'（系统版本不可控）；P1 加解析断言测试钉死该前提（A5；`build-sidecar.test.mjs` 断言归档成员名 + 解包后基名 + `resolveNodeExecutable` 直用分支）。Electron 分支 = execPath + ELECTRON_RUN_AS_NODE=1 + `--expose-internals`（dsh loader 的 node-addon-require-builtin 需要；updater 的 runtimeNodeExecutor 同构，main.ts:4034-4037）。
- **必须绑 Node**：dsh 实例本身是 Node 进程（vendor dsh 由 pnpm 安装），控制面 spawn 它、dsh-runtime 安装它；pnpm 11.21.0 已随 desktop 依赖，改由 sidecar 目录内嵌 + 注入（**plugin-sync resolvePnpmBinDir 不感知 bundled pnpm**，需 PATH 前置或 env 注入，plugin-sync.ts:41）。
- **dsh-runtime 默认执行器恒纯 Node**（{file: process.execPath}，runtime-installer.ts:777）。
- Node 版本策略：与 desktop 的 Electron 内置 Node 大版本对齐或取 LTS（决策 6）。

### 4.4 桥接设计（本方案的信任核心）

#### 4.4.1 A 桥（web ↔ Swift，preload 等价物）

- preload 职责：`contextBridge.exposeInMainWorld('dshChamber', {…})` = **4 个 info 标量（controlPlaneUrl/dshVersion/version/platform）+ 9 个命名空间面（desktopSsh/update/settings/systemResume/openIn/deepLink/runtime/notifications/badge）**（preload.cts:929-965；命名空间成员口径合计 **60 invoke + 8 订阅**，不含顶层 `dsh-chamber:info`；manifest 全量 = 61 invoke + 8 push = 69，其中 `desktopSsh` 面 32 invoke（含 `instances_health`））。Swift 注入 `bridge-shim.js`（WKUserScript、.page world、documentStart；资源名 = MainWindowController.swift:42）定义同形 API：
  - **挂出时机（D1）**：documentStart 定义内部管路（resolve/emit/rehydrate，带窗口随机令牌），**`dsh-chamber:info` 成功后**才暴露 `dshChamber`；info 未就绪/失败期 invoke 回 `ipc_not_ready`（1 次 + 10 次 50ms 重试），渲染端走既有 surface 缺失链自愈；全败分支与 preload 同形（surface 在、标量 null）（bridge-shim.js、BridgeShimInjector.swift；G22/T-12 有门禁与登记）。
  - 方法面：按 manifest 生成 `dshChamber.<ns>.<method>(args)` → postMessage({id, method, payload})，以 id 关联 Promise（info 的 10×50ms 重试照搬——仅 reject 时重试）。事件面：8 个 push → shim 订阅表，Swift `evaluateJavaScript` ("__dshChamberEmit(event,payload)") 派发（通道名/载荷以 IPC_CHANNELS/05 §7.4 为权威）。防护：Object.defineProperty 非可配置挂载防页面覆盖。
- Swift `WKScriptMessageHandler` 护栏（只做传输层，语义校验在 sidecar）：1. 主 frame；2. **壳文档判定**（origin === 当前控制面 origin **且** pathname == "/" 且无 query——与 Electron `isTrustedRendererUrl` 对齐；port 只在 ready 帧后放开）；3. 信封结构/尺寸上限（≤4 MiB）、method ∈ manifest 白名单；4. 不响应"新窗口/导航"（WKUIDelegate 建窗返回 nil + decidePolicyFor 阻断离开 origin；外链交 NSWorkspace——含 **mailto:/vscode:// 等非 http(s) scheme 导航策略实测**，C6）。语义校验（payload schema、来源指纹、generation、ACK 队列……）全部留在 sidecar 原处理器。

#### 4.4.2 B 桥（Swift ↔ sidecar，本机受信通道）

- 传输：sidecar stdin/stdout 行式 JSON-RPC（NDJSON）；stderr 独立为日志。**sidecar-entry 入口必须把存量 console.* 重定向到 stderr**——main.ts 端口行（:1787）、will-quit 完成串（:1673，实机门禁断言该串）等遍布代码，否则"业务原样复用"与协议纪律冲突（D2）。
- 信封：{id, method, payload} / {id, ok, result|error} / {event, payload} / edge:*（sidecar→Swift 的 HostEdge 请求，Swift 执行后回响应）；id 单调。
- **保留入站 method（Swift → sidecar，不在 69 通道 manifest 内；单源 = `packages/desktop/node-edges.ts` `HOST_INBOUND`）**：`__host.hostFacts`、`__host.notifyClicked`、`__host.systemResume`、`__host.mainWindowShown`、`__host.deepLink {url}`（§4.5：`application(_:open:)` 冷/热启动统一入口 → core `enqueueDeepLink`）、`__host.rendererLifecycle {event}`（§5 E19 三事件映射：did-start-loading / did-finish-load / crashed / closed → core `onRendererLifecycle` 复位 ready 位 + in-flight requeue/drain）、`__host.quitFacts {quitRequested, recoveryAvailable}` → **决策投影**（§5 E1/E9/E20：core 依 chamber settings 的 `windowCloseBehavior`/`quitConfirmation` + `LOCAL_RUNNING_STATES × localProcessAlive` 用既有纯函数 `shouldHideToTray`/`computeQuitRisk` 合成，返回 `{hideOnClose, quitNeedsConfirm, quitReasons}`——判据单源在 core，Swift 只执行隐藏/退出链，绝不复制决策）。Swift 拼写单源 = `HostInboundMethod`，与 TS 表锁步由 `HostInboundMethodTests` 断言。
- 退出纪律：清理后入站 invoke 一律回 `{error:'app is quitting', code:'app_quitting'}`（sidecar-entry.ts:396-400；与 renderer-trust 的 `createTrustedIpc` 同码同语义）；清理自身 4.5s 硬顶（`QUIT_CLEANUP_TIMEOUT_MS=5_000` − 500，早于宿主 5s SIGKILL grace 留 500ms 余量；shell-core.ts:691 / sidecar-entry.ts:691）。
- 护栏：Swift 只接受自己 spawn 的进程 fd；帧长上限与超时；非协议帧 fail-loud。事件推送经 B 桥到 Swift → A 桥 emit，事件名清单 = manifest。
- **出站写与期限**：Swift 的 invoke 和 edge 应答共用每个 sidecar 会话独立的串行写器；排队上限为 64 帧 / 16 MiB（另有正在写的单帧 ≤4 MiB）。edge 应答越过尚未写出的普通请求，满队列时可淘汰排队请求并将其明确结算为写失败。invoke 在登记 pending 时启动全程期限（缺省 60s，页面普通 45s、长交互 720s），涵盖排队、管道背压、sidecar 执行与响应读取；过期排队帧在真正写入前丢弃。单次物理写超过 20s 时重建 sidecar；stop / 自然退出立即作废旧写器，重启使用新写器。写抛错可能留下半帧，因此同样作废整条出站传输并终止本代 sidecar，由 Supervisor 建立新协议会话。已经进入内核的写不能撤回，超时后的远端副作用须靠宿主事实对账；sidecar 对未收到 edge 应答另设普通 30s / 交互 660s 期限。

  **Rejected alternatives**：继续在 invoke / stdout 回调线程持锁直接写 stdin，会让满管道绕过 invoke 期限并堵住 edge 应答；只把同步写包进全局串行队列，会让旧会话的阻塞写占住新会话；写失败后继续使用同一 NDJSON 管道，可能把新帧拼到半帧后面。每会话有界写器把这些风险分别收敛到请求期限、会话代际和协议重建。

#### 4.4.3 通道 manifest（防双份漂移）

- 单源：`IPC_CHANNELS`（ipc-events.ts）+ preload 的 invoke/on 字面量集。`ipc-surface-mirror.test.ts` 锁步
  **通道名字符串集合 + 类型/字段镜像**；`packages/desktop/scripts/emit-bridge-manifest.mjs` 解析三处
  main 侧注册点，产出提交物 `packages/desktop/bridge-manifest.json`（**通道 + 方向 invoke|push +
  IPC_CHANNELS 键**）→ 生成 `macos/Sources/DSHChamber/Generated/
  BridgeManifest.swift`（提交物）与 `Resources/chamber-bridge.stub.js`（提交物；**不进 Swift target、
  不随 .app 打包**，仅锁步样本，见 `Package.swift` 的 `exclude`）。**命名空间归属不由 manifest 承载**：
  preload/shim 暴露面是唯一单源，`bridge-shim-surface.test.ts` 逐命名空间断言 shim 方法集与 preload 一一对应。
- 三件锁步测试：`bridge-manifest.test.ts`（重生成 == 提交物 + **通道数守恒 69 = 61+8 + 无死键断言**（61 == 60 命名空间成员 + `info`），
  B12/E8）、`bridge-shim.test.ts`（`chamber-bridge.stub.js` 重生成逐字节 == 提交物 + invoke/push 数组与
  计数）、`BridgeManifestConsistencyTests`（Swift 白名单 == JSON）；Swift 产品代码禁止手写通道字符串。
- `ipc-surface-mirror.test.ts` 的 `MAIN_SIDE_FILES = ['main.ts', 'shell-core.ts', 'electron-edges.ts']`
  覆盖三处注册者文件，badge pin 断言等源码锚点随之（renderer-trust.test.ts、transport-manager.test.ts）。


### 4.5 通知点击与深链去重语义（design 19 §3.3 / 16 §4.2 的宿主移植）

- 通知 click：`pendingNotificationOpens` 有界 ACK 队列与去重/限速留 core；**click 回执路由的存活期 = dispose / 来源退役 / 有界淘汰**——显示成功不得注销（否则 Swift flavor 点击命中不到路由；`node-edges.ts:198-260` 的审计修复）。来源退役经 `sourceId` 扣掉路由（`showNativeNotification` 载荷携带 `sourceId`，:233-239），Swift `NotificationDeliveryRegistry`（sourceId → identifier，FIFO 16）在 retire 时用 `removeDeliveredNotifications` 移除已投递横幅（MainWindowController.swift:1004）。非 silent 通知用系统默认声（Electron darwin 具名 `Glass` 在 UNUserNotificationCenter 无对应资源——差异已登记，SwiftEdgeHostLegs.swift:219-222）。**对象登记/淘汰（BoundedActiveNotifications 持 Electron Notification 宿主对象，淘汰=evicted.close() main.ts:984-988）属 electron-edges**（B4——core 不能持有宿主对象；UNUserNotificationCenter 的 delegate 由系统持有、Swift 无防 GC 坑也无 close 事件需登记）。HostEdges showNativeNotification 返回 click 回执绑定；**click 顺序（D3）** = NSApp.activate + 窗口 orderFront（含无窗重建，applicationShouldHandleReopen 同路）→ 回 B 桥 notification-clicked → core 队列 → 窗口就绪后 push。就绪/重建竞态兜底 = **事件映射**（§5 E19，B5/D5；WKWebView 三个触发点 → 4 个 wire 事件，含窗口关闭 `closed`）：didStartProvisionalNavigation（复位 ready 位 + requeue in-flight）/ didFinish（drain）/ webViewWebContentProcess DidTerminate（复位 + requeue + 有界重载）。
- 深链：**macOS 现状 = open-url 事件 + argv 防御式扫描双路径**（main.ts:1479-1482 + 1687，归一化 intent key 去重，A7）——Swift 侧只走 `application(_:open:)`（冷启动先于 ready → Swift 暂存，ready 后按序转交）→ B 桥 deep-link(url) → core enqueueDeepLink 原逻辑（归一化去重、VS Code intent、proof 队列不动）；Win/Linux 的 second-instance argv 扫描仅 Electron flavor 保留。

## 5. 原生边沿逐项设计（Electron → Swift 映射）

| # | Electron 现状（main.ts/…） | Swift 对应 | 备注 |
|---|---|---|---|
| E1 | `BrowserWindow` + `loadURL` + hide-to-tray/close 语义 | `NSWindow` + `WKWebView`；`windowShouldClose` 按 14 D1（hide 而非关；mac Dock 恒为恢复入口 → orderOut） | 关窗隐藏/恢复、重建窗口只允许单窗 |
| E2 | `Tray`（打包态，resources/icon.png） | v1：mac 用 Dock 常驻即可，`trayAvailable()=true`；可选 NSStatusItem | 现状镜像：托盘缺失回退关窗即退（mac 不会缺） |
| E3 | **未自定义应用菜单**（默认菜单含 Edit role，Cmd+C/V 靠它；Menu 只用于托盘 :779） | NSMenu 标准菜单 + **Edit 项（copy/paste/selectAll 走 first responder → WKWebView）** + **窗口项（Cmd+M 最小化 / Cmd+W 关闭，AppDelegate.swift:659-700）** | 缺菜单会丢 Cmd+C/V/全选；Edit + 窗口菜单 |
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
| E19 | renderer 崩溃/卡死恢复（installRendererRecovery：render-process-gone、unresponsive 与前台 JS/rAF 进度探针；共用有界重载预算） | **三事件映射**：didStartProvisionalNavigation（复位 + requeue）/ didFinish（drain）/ webViewWebContentProcessDidTerminate（复位 + requeue + 500ms 有界重载，60s ≤3 次 + NSAlert） | **unresponsive 腿 v1 明示不可移植**（WKWebView 无该事件）→ 已按 S-02 以心跳探针替代（`RendererHangWatchdog`：didFinish 后武装，前台可见且无导航时每 5s 取 JS 回执与主动 rAF 计数；连续 3 次 3s 超时/求值失败/帧计数不前进后共用有界重载；键鼠输入不清除证据，隐藏或导航复位，迟到回调按探针编号丢弃；期限使用单调系统 uptime，免受系统时钟调整影响；导航抢先发生时取消待执行重载并退还该次预算）；boot 死区收敛后，**前端 boot 不 settle 的逃生由页面侧拥有**（design 05 §4.1：可操作遮罩 + 相位感知就绪门 + ⌘R 提示），原生仍不观察/不超时前端 boot 状态——该探针覆盖不到"整页存活但前端卡住/首帧求值期冻结"，两条原生缺口登记在 STATUS（可选收口：didCommit 后武装首载超时；运行期 `/health` +「重启 sidecar」）。**崩溃归因轮**：崩溃日志行改为带「距上次加载完成 X.XXs（boot 窗口内/已稳定）+ 本窗口第 N 次崩溃」，恢复落地再记一条「崩溃后 X.XXs 重载完成」（`RendererCrashAttribution` 纯值 + `RendererRecoveryTests` 单测；`MainWindowController` 记 `lastLoadFinishedAt`/`crashesSinceLoad`/`recoveringFromCrash`）——本机 10 份 WebContent 崩溃报告中当前构建的 2 份都落在**加载完成后 21–34s**，符号化栈是 JSC 代码块替换/JIT tier-up（rAF 回调入口），而其余 8 份连 `crashed` 行都没有：**静默整页重载**正是"应用自己回到载入历史"的来源，归因量是唯一的事后判据。 |
| E20 | `app.on('activate'/'window-all-closed')`（darwin 且 close-behavior='quit' 时也必须 quit :1510-1516） | `applicationShouldHandleReopen` 等 + windowShouldClose 判 close-behavior：'quit' → NSApp.terminate 走完整确认链，绝不无窗常驻 | 14 D1 语义 |

### 5.1 刷新率（ProMotion 120Hz，裁决）

**问题**：原生壳在 120Hz ProMotion 机器上跑不出 120fps（思考流式滚动发涩），同机
Electron/Chromium 为 120fps。实测（M5 Pro / 内置 3024×1964 120Hz 屏 / macOS 26.5，单位 = 页面 rAF
实测 fps，vsync 与 `CVDisplayLink` 均 120Hz）：

| 引擎与配置 | 低电量模式 | 实测 |
|---|---|---|
| WKWebView 默认配置 | 关 | 60.0fps |
| WKWebView（关闭 prefer-60fps 偏好） | 关 | 120.0fps |
| WKWebView 默认配置 | 开 | 30.0fps |
| Chromium（同机同时刻，Chrome 152） | 开 | 120fps |

**根因（WebKit 源码定位）**：① `Source/WTF/Scripts/Preferences/UnifiedWebPreferences.yaml` 的
`PreferPageRenderingUpdatesNear60FPSEnabled`：`defaultValue: default: true` —— WKWebView 默认把页面渲染
更新压到「靠近 60fps」而不是显示器刷新率；**只在 nominal > 60 且整数商 > 1 时才有影响**——61–119Hz 屏
（如 100Hz）本就不受限，120Hz 上才表现为 60fps。
② `ScriptedAnimationController::preferredScriptedAnimationInterval()` 调
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
  `_setEnabled:forFeature:`，`_features` 需 macOS 13.3+），Swift 无直调面 ⇒ 新增独立 C target
  `macos/Sources/DSHChamberWebKitSupport`（唯一职责 = 关偏好；公共 C 面只一个函数，零状态、零第三方依赖）。
  **必须在构造 `WKWebView(frame:configuration:)` 之前调用**（创建后再改不生效；稳态前提 = 未换屏、未发生节流原因
  变化、未重启 WebProcess）：偏好变更会下发 WebProcess，但**偏好变更路径不重设刷新节奏**——节奏只在
  `RenderingUpdateScheduler::adjustRenderingUpdateFrequency()` 的既有触发点（页面创建、换屏、节流原因变化）更新，
  `Page::settingsDidChange()` 不做。装配点 = `MainWindowController.setupWindow()`；折算与日志在
  `RefreshRatePolicy`（纯逻辑，可单测）。
- **低电量模式 ×2 不覆盖（accepted）**：该状态由 WebContent 进程内 `WebCore::LowPowerModeNotifier` 直读系统
  状态；WebKit 内**确有**强制「关」的钩子（`Page::setLowPowerModeEnabledOverrideForTesting(false)` +
  `m_throttlingReasonsOverridenForTesting`），但只经 `Internals`（`window.internals`）暴露给布局测试，
  WKWebView/UI 进程无可达面（三条候选见 Rejected alternatives 第 5 条）。⇒ 结论是「**无应用级开关**」，不是「不
  存在能强制关的钩子」。**关闭偏好后**低电量模式页面更新上限 = 显示器刷新率 ÷ 2（120Hz 屏 = 60fps；偏好仍开时是
  nearest(nominal) ÷ 2 = 30fps）；要满 120fps 只能退出低电量模式（系统设置 > 电池），壳只如实写日志。
  **系统级限制确认**：应用侧无出口，按 accepted 登记差异，**不追求注入 bundle 覆盖原型**。
- **DSH_CHAMBER_SHELL_DEBUG 帧率观测**：`DSH_CHAMBER_SHELL_DEBUG=1` 注入 rAF 计数（每 2s 一行
  `[shell-fps]`，走既有 shellConsole 回传）；缺省 / 打包态不注入（S14/T-11 调试面纪律不变）。

**Rejected alternatives**（本决策的备选与其被否原因）：

1. **接受 60fps、不做**：同机 Electron/Chromium 是 120fps，双 flavor 刷新率不同且原生侧更差，无产品理由保留；
   关闭偏好只是一个 SPI 调用的成本。
2. **等 WebKit 公开开关**：无时间表，期间 60fps 上限持续（S-48）且无法验证；落地已按「SPI 缺失即 Unknown 降级」
   设计，换公开 API 只需替换 `apply(to:)` 一处。
3. **页面内规避**（CSS 合成/自绘）：不适用——节流点在引擎调度器（`Page::preferredRenderingUpdateInterval()` 与
   `ScriptedAnimationController`），页面拿不到旁路；流式文本必须走渲染更新。
4. **按显示器能力门控**（仅 `NSScreen.maximumFramesPerSecond > 60` 时关偏好）：① 页面创建后再改偏好**不生效**，换屏
   后无法重配；② 60Hz 屏 `nominal = 60`，`framesPerSecondNearestFullSpeed(60) = 60`，本不额外限制；③ 建窗前
   `NSScreen.main` 未必是最终屏。拒。
5. **覆盖低电量模式**（injected bundle / UI 进程转发 / dyld interpose）：**不采用**——注入面
   （`_WKProcessPoolConfiguration.injectedBundleURL`，所属类自 macOS 12 deprecated；链路 `initializeNewWebProcess`
   （`createNewWebProcess` 调用）赋 `parameters.injectedBundlePath`）存在但未实测，覆盖需自建 bundle 并链接 WebCore
   测试钩子（`Page::setLowPowerModeEnabledOverrideForTesting`），代价远超收益；UI 进程不转发（已核对）。残余按
   accepted 登记。
6. **换渲染引擎**（Chromium/CEF）：唯一能在低电量模式拿满 120fps 的路径，但超出 design 25 路线 A 定义，发布/签名
   代价巨大——**移出本决策范围**；电池场景替代品是 Electron flavor。

**启动日志（唯一对照口径）**：`[shell] 刷新率：显示器刷新率 120fps（当前模式）；prefer-60fps
偏好=已关闭(跟随显示器刷新率)；低电量模式=开 → 页面更新上限约 60fps（…）`——由
`RefreshRatePolicy.startupLogLine` 产出。刷新率取**窗口所在屏的当前模式**（`CGDisplayCopyDisplayMode`；取不到回落
面板上限 `NSScreen.maximumFramesPerSecond` 并标「面板上限」）——与 WebKit nominal **同源但不等价**（WebKit 用
CVDisplayLink 名义周期、display link 初始化时只缓存一次，取不到回落 60）；建窗后立即记一次，并在换屏 / 屏幕参数
变化（同屏改刷新率）/ 低电量模式切换 / 首次获得 key（上屏兜底）时按值去重补记
（`MainWindowController.logRefreshRateIfChanged`）。三个实测点为单次实机记录、**探针未入库**（复测 = 打包态
`DSH_CHAMBER_SHELL_DEBUG=1` 的 `[shell-fps]`）。`RefreshRatePolicyTests` 钉住 60/120/30 三个实测点、上游整数
除法折算、接线时序（apply 先于 `WKWebView` 构造）与 SPI 不可用时的诚实降级（unknown 按 WebKit 默认折算，绝不虚报
120）；同屏改刷新率时 WebKit 是否重读 nominal 未证实，验收以 `[shell-fps]` 实测为准。

**验收（未完成）**：插电 120fps、电池 + 低电量模式 60fps、60Hz 外接屏不回退；日志标「面板上限」或界面为 100Hz 类
非整数倍屏时，判定以 `[shell-fps]` 实测为准。见 STATUS.md 与 deviations.md S-48。

### 5.2 视口越界（根级弹性回弹）与壳侧策略

macOS WebKit 在**视口层**实现弹性越界：指针停在不可滚动 chrome（顶栏、侧栏头部）上滚动，或滚动器到端点后继续滚
时，越界量落在视口，**整页（含 position: fixed 层）被平移再弹回**。按 CSS Overscroll Behavior 规范，**视口越界效果
由根元素的 overscroll-behavior 决定**，故壳在 configuration 段以 WKUserScript（documentStart、仅主 frame）注入根规则
`html, body { overscroll-behavior: none !important; }`（`ShellOverscrollPolicy.swift`，装配点
`MainWindowController.swift:233-241`）：

- **只落文档根**：不改任何滚动容器的滚动范围，也不改文档内链式滚动（`none` 管的是视口越界效果与向视口外链接）；页面结构、上游代码零改动。
- **`!important` + 样式元素标记**（`data-dsh-shell-overscroll`）：`!important` 压过页面普通声明；**层叠边界**
  （对抗复核修正）——页面若在根上再声明同属性 `!important`（同特异性、文档序靠后）或根元素内联
  `!important` 仍可翻转。当前上游**无根级声明**（`packages/dsh-client-web` 全目录 `overscroll` 命中 0；其余命中是
  滚动容器的 `contain`，无一定在文档根），故为理论边界；author 源内也挡不住页面 JS。将来上游若在根声明，升级手段
  = documentEnd 再追加一次（文档序靠后）或对 documentElement 设内联 `important`；打包态可用
  `getComputedStyle(document.documentElement).overscrollBehavior` 自检。
- **时机与作用域**：documentStart、仅主 frame（iframe 子文档保持自身行为）；崩溃/卡死恢复只 reload，注入随每次
  导航生效。本机实测 documentStart 时序 = readyState=loading、documentElement 已存在、head 尚不存在；落点**始终优先
  documentElement**（保住"页面重写 head 也删不掉"的免疫），两者都取不到时才走一次 DOMContentLoaded。
- **证据**：**无自动化断言**——实机目检：滚到端点或指针停在不可滚动 chrome 上滚动，整页不得平移；注入串、时机/
  作用域与 CSP 依赖仍是实现契约，行为判据归 §8.5 矩阵与 S-50。
- **范围**：只关视口越界与链式越界；内层滚动器局部回弹不在范围内，勿当回归。
- **CSP 依赖（指令级守卫）**：注入的 `<style>` 依赖控制面 CSP 的 `style-src 'self' 'unsafe-inline'`
  （`packages/control-plane/src/index.ts:1136-1143`：注释 :1136-1142、指令 :1143）。页面当前**没有** meta CSP；即便
  将来加入 meta `style-src 'self'`，documentStart 注入也早于其解析（本地 fixture 实测），唯一真实耦合是响应头 CSP。
  对抗复核（本地 HTTP fixture + 真实 WKWebView）实测**三种同样静默失效**的改法：① 删掉 `'unsafe-inline'`；
  ② 同一 `style-src` 再加 `'nonce-…'`/`'sha256-…'`（CSP3：出现 nonce/hash 即忽略 unsafe-inline）；③ 新增
  `style-src-elem`（覆盖 style-src 对 `<style>` 的管辖）——都让 computed 回 `auto`、回弹复现。守卫：
  `packages/control-plane/test/proxy/static-serving.test.ts` **按指令解析**响应头（同一 policy 内重复指令首次
  生效；逗号分隔的每个 policy 都生效），要求**每一条生效的 style-src 保留 `'unsafe-inline'`**、不带 nonce/hash、
  不出现 `style-src-elem`/`style-src-attr`；复核：子串正则会被
  "`style-src 'self' 'unsafe-inline', style-src 'none'`" 这类多 policy 写法整类绕过。改 CSP 必须同时复核本策略
  与 S-50。
- **双 flavor 差异**：Electron 未同步，登记见 deviations S-50。

**Rejected alternatives**（本策略的选择依据）：

- 逐个滚动容器加 `overscroll-behavior: contain`（含按上游类名选择）：管不到"指针停在非滚动 chrome 上"，且要按上游
  结构改上游滚动语义——破坏性变更，拒。
- 改 `packages/dsh-client-web/src/base.css` 等上游 shell 副本：给上游打补丁 + 重建前端产物，本方案零页面改动，拒。
- 私有 SPI `_setRubberBandingEnabled:`：非公开接口，发行风险与逐系统复核成本高于一条标准 CSS，拒。
- JS `wheel` 事件拦截：逐事件逻辑，WebKit 对合成/惯性相位事件的可取消性不由页面保证，最易回归，拒。
- 把固定 chrome 移出 WKWebView（原生分层自绘）：不阻止内容区位移，且要重做命中测试/主题投影，代价与收益不成比例，拒。

### 5.3 原生席位：语言与外观跟随

**控件与事实源**：语言与主题的**唯一权威是页面 document 事实**（控件 = 页面设置面，壳不是事实源）；
语言 = `documentElement.lang`（zh 族 → zh，其它非空 → en，空 = 无事实），主题 =
`body[data-ds-dark-theme]` 存在或 html 内联 `color-scheme` 以 dark 开头（`macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageLanguage`、`macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageFacts`）。
壳**只读、不回写页面**：事实单向 DOM → 壳，页面自身语言/主题仍由页面决定；无事实（首次安装/从未记录）
时壳不猜测、保持系统默认。

**载波（脚本 + 独立 handler + 对账 + last-known）**：
- **脚本**：`macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageFactsScript` 以 WKUserScript
  （documentStart、仅主 frame、page world）安装 MutationObserver，观察 html[lang]、html 内联 style
  （color-scheme）、body[data-ds-dark-theme]、meta[theme-color]（后者只是变化触发面，不参与 dark 判定）；
  同文档一次性安装 + (lang, dark) 快照去重，全部 try/catch，异常退化为不上报；只在 document 上留一次性安装标记 `__dshChamberFactsState__`，不改任何 DOM 事实、不读页面变量、绝不回写语言/主题；
  装配点 = `macos/Sources/DSHChamber/MainWindowController.swift#setupWindow`。
- **独立 handler**：上报走独立消息名 `ShellPageFactsScript.messageName`（dshChamberFacts），由
  `macos/Sources/DSHChamber/MainWindowController.swift#ShellPageFactsMessageHandler` 消费——**不**进 A 桥
  白名单/就绪门链路（事实必须在 sidecar ready 前可用）；护栏 = 名称 + 主 frame（该 handler 的 `accepts`）
  + 同源文档面 `macos/Sources/DSHChamber/MainWindowController.swift#isSameOriginDocument`（委托
  `macos/Sources/DSHChamber/TrustGuard.swift#isTrustedOrigin`：仅 scheme/host/port 全等，**不**限定
  pathname=`/`、**不**限定无 query）。严格壳文档判定 `macos/Sources/DSHChamber/TrustGuard.swift#isTrustedDocument`
  只留给 A 桥（首载 URL 归一化 `macos/Sources/DSHChamber/AppDelegate.swift#applicationDidFinishLaunching`
  与 A 桥消息门）。理由：本通道只带 lang/dark 两个非敏感事实、且与 A 桥白名单/
  就绪门完全解耦；页面一旦用 history.pushState/replaceState（SPA 路由、`/api/i/*`），WKWebView 的
  frameInfo.request.url 随之变化，严格壳文档门会把同一文档判成不可信 ⇒ 事实通道静默断链到下一次 didFinish
  才靠对账恢复。主 frame + 同源 + 导航护栏（同源非壳文档的主 frame 导航仍被 cancel）足以挡住失败页/about:blank
  与异源文档。
- **对账**：`macos/Sources/DSHChamber/MainWindowController.swift#reconcilePageFacts` 在 didFinish 以
  `snapshotSource()` 再读一次（与脚本同一 dark 判定），覆盖首次上报窗口；回调先过
  `macos/Sources/DSHChamber/MainWindowController.swift#acceptsReconcile`（与观察器路径共用
  `isSameOriginDocument`）才 ingest，失败页/about:blank 静默丢弃（不误报成「对账失败」）；
  **loud 只针对 `evaluateJavaScript` 错误**（错误不致命，观察器路径仍在，不报警）。
- **last-known**：`macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageFactsStore` 合并上报并持久化
  （lang 空/dark 缺失 = 保留旧值；不变则幂等；revision = max(夹紧后的上报值, 旧值 + 1)，
  取值夹在 [0, \`maxRevision\`=1_000_000]——上报值由页面 postMessage 提供，可构造出
  \`Int.max\`，未夹紧时下一次 \`旧值 + 1\` 就是整型溢出**陷阱**（审计实证 SIGTRAP），
  且该值会被持久化，故落盘载入同样夹紧），键
  `native-shell.page-facts`；启动早期只读入口 =
  `macos/Sources/DSHChamber/MainWindowController.swift#lastKnownPageFacts`。

**本地化资源与装配**：壳内建文案走 `macos/Sources/DSHChamber/NativeText.swift#NativeTextKey`（键表以 NativeTextKey 为准，当前 121 键）
与 `macos/Sources/DSHChamber/NativeText.swift#NativeText`（取值链**优先语言覆盖包**：语言覆盖包 → Bundle.main → SwiftPM 资源包 → rawValue；
缺资源显示键名，不谎报翻译）。两份 `Localizable.strings` 在
`macos/Sources/DSHChamber/Resources/{en,zh-Hans}.lproj/`，经
`macos/Package.swift#=literal:defaultLocalization: "en"` 与两个 `.process("…lproj")` 进资源包；装配腿
`macos/scripts/build-swift-app.mjs#LOCALIZATIONS` 机械校验的**三处同源** = 该常量、Info.plist.template 的
`CFBundleLocalizations`（dry-run 逐字比对）、以及 Package.swift 两个 `.process` 的产物（装配期断言 SwiftPM
资源包内两个 `.lproj` 都在；不做 Package.swift 文本解析）；装配腿据此把 `.lproj` **平移到 `<App>.app/Contents/Resources`**
——Bundle.main 与系统框架的 preferredLocalizations 只看这一层，资源包内那份只服务 Bundle.module；
`macos/scripts/build-swift-app.mjs#assertLocalizationsPresent` 在装配期缺席即 fail，
`macos/scripts/build-swift-app.mjs#plistLocalizations` 让 dry-run 的声明面与资源面同源。
壳内标识符以 `macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageLanguage` 的 `localizationIdentifier`
为**唯一入口**（zh 用 Apple 拼写 `zh-Hans`，不再散落字面量）；Y1 起该集合由
`macos/Tests/DSHChamberTests/ShellIdentityTests.swift#testLocalizationIdentifiersLockstepAcrossBuildInputs`
机械锁步——读源码逐集合比对上述三处 + `macos/scripts/build-swift-app.mjs#LOCALIZATIONS`，少一项/多一项/
拼写变体即红；`NativeTextLanguageOverrideTests` 只再作「两个方向都能解析到随包 `.lproj`」的隐式兜底。
**`CFBundleLocalizations` 是「进程偏好集合的声明面」**（不是翻译清单）：它是 Bundle/系统框架解析
preferredLocalizations 时允许的本地化全集；盘上的 `.lproj` 本身也参与 Foundation 的 localizations/
preferredLocalizations 解析，两者叠加会让 localizations 出现重复项（无功能影响），真正的文案来自
随包的 `.lproj`。

**应用点与生效时机**（两个入口：启动期 `macos/Sources/DSHChamber/AppDelegate.swift#applicationWillFinishLaunching`（last-known）与事实变化 `macos/Sources/DSHChamber/AppDelegate.swift#pageFactsDidChange`）：
- **自建文案即时**：页面语言变化 → `macos/Sources/DSHChamber/NativeText.swift#setLanguageOverride`
  先换**运行期语言覆盖**（显式加载目标语言 `.lproj`；因 CFBundle 的 preferredLocalizations 是**进程启动期**
  解析并缓存的，只写 `AppleLanguages` 不会让运行期取串换语言——这是「重建菜单」真正换文案的前提），
  再由 `macos/Sources/DSHChamber/AppDelegate.swift#installMainMenu` 重建主菜单
  （接线一律按 tag：appSectionTag…helpSectionTag/servicesItemTag，绝不按本地化后的标题查找）；托盘标题同由
  `macos/Sources/DSHChamber/AppDelegate.swift#refreshStatusItemTitles` 在事实变化时按 key 重取，对话框/
  失败页在下一次取串时跟随。启动期同样先设覆盖（`macos/Sources/DSHChamber/AppDelegate.swift#applicationWillFinishLaunching`），
  早于 didFinishLaunching 的主菜单构造。
- **进程级 = 下次启动生效**：框架与 Sparkle 标准窗的本地化在进程启动时按 bundle 偏好集合解析，运行期不可变；
  `macos/Sources/DSHChamber/AppDelegate.swift#applyLanguage` 把页面语言写进本 app 域的 `AppleLanguages`，
  **仅当页面语言族与系统语言族不同**才写，且所有权以**本壳写入的确切值**为准
  （记录键 \`native-shell.appleLanguagesWritten\`）：app 域已有值且 ≠ 记录 ⇒ 视为用户/系统设置的语言，
  **不覆盖**；回收仅当"当前值 == 记录"才删，值被外部改过就作废记录、绝不删值；旧布尔标记
  \`native-shell.appleLanguagesOwned\` 只清理、不作依据。
  系统设置「语言与地区 → 应用程序」写的是**同一个 app 域键**；**已知边界**：用户显式设置的语言恰好等于
  我们上次写入的值时，无法与"我们自己的覆盖"区分（同键双写者的固有歧义，代码注释已登记）；启动期应用点 =
  `macos/Sources/DSHChamber/AppDelegate.swift#applicationWillFinishLaunching`（last-known，早于
  didFinishLaunching 的主菜单构造）；系统语言读取显式排除本 app 自己写过的覆盖
  （`macos/Sources/DSHChamber/AppDelegate.swift#systemLanguageIdentifiers`）。
- **右键菜单同属进程级**（语言随 `AppleLanguages`；平台默认项集不可定制，见下）。

**两层语义（不再重开）**：**壳自建文案跟随应用内设置**（页面语言，切换即生效——
菜单/托盘/对话框/失败页/面板；托盘标题的运行期重取 = `macos/Sources/DSHChamber/AppDelegate.swift#refreshStatusItemTitles`）；**系统与框架面默认跟随系统语言**（Sparkle 标准窗与其提示、AppKit 内建
按钮与 About 标签、WebKit 右键菜单、Services 子项与帮助搜索框）。只有**语言族不同**（中文 ↔ 非中文）
时，本壳才写 `AppleLanguages` 把这些面一起切到应用内语言（下次启动生效）；**同族不覆盖是有意选择**——
系统语言优先服务系统面（例：日/韩/法/德系统 + 英文页面 ⇒ 框架面保持系统语言，不强制英文；zh-Hant 系统 +
简体页面 ⇒ 框架面保持繁体）。该链路的**语言匹配已本机实测**（`Bundle.preferredLocalizations`）：
`["zh-Hans"]→zh_CN`、`["zh-Hans-CN"]→zh_CN`、`["en"]→en`、`["ja-JP"]→ja`、`["zh-Hant-TW"]→zh_TW`。

**外观**：默认 nil（跟系统；HIG 不鼓励 app 专属外观开关）；仅页面显式主题与系统主题不同才覆盖为
darkAqua/aqua（`macos/Sources/DSHChamber/ShellPageFacts.swift#ShellAppearancePolicy` 的 appearanceName，
应用点 `macos/Sources/DSHChamber/AppDelegate.swift#applyAppearance`）；页面回到「跟随系统」即重置 nil。
系统深浅读 `AppleInterfaceStyle`，不读被覆盖后的 effectiveAppearance。
**露底色的两段语义（W4a；F1/X2 修正）**：
① **建窗即按 last-known 对账**：`macos/Sources/DSHChamber/MainWindowController.swift#setupWindow` 末尾调
`macos/Sources/DSHChamber/MainWindowController.swift#reconcileThemedBackground`（读 `ShellPageFactsStore.lastKnown`
并幂等收敛），其后启动起首帧不再是骨架常量而是上次页面主题色；只有**无事实**时才用骨架常量 `#0f1115`
——页面自身骨架与主题无关（`packages/renderer/index.html` 明示「不跟随 prefers-color-scheme：dsh 主题按实例
投影、骨架期不可知」），此时跟着骨架走才不会首帧反向闪色。
② **透明露底经异常安全包装**：WKWebView 缺省白底会首帧/重载白闪，故经**异常安全包装**置 `drawsBackground` = false，
让页面透明区露出窗口底色；包装设置失败仅降级为 WebKit 默认白底 + 日志，**绝不崩**（`responds(to:)` 探测实测
恒 false，不再作门）。
③ 页面事实到达后按主题换 `underPageBackgroundColor` 与窗口底色
（`macos/Sources/DSHChamber/MainWindowController.swift#themedBackgroundColor`：light → 浅色内容底、
dark/无事实 → 骨架常量），缩放/全屏/重载的露底因此与页面一致。

**右键菜单不可定制的取舍**：WKWebView（macOS）公开面无右键菜单定制 API——`contextMenu*` 修饰符属
UIKit/SwiftUI 控件层、不作用于网页右键菜单（`macos/Sources/DSHChamber/MainWindowController.swift#setupWindow`
无任何 menu/contextmenu 覆写）；AppKit `NSView` 的同名回调 `willOpenMenu:withEvent:`/`didCloseMenu:withEvent:`
（macOS 10.11+）属视图自有 NSMenu，对网页内部菜单是否生效未验证（实机待确认）；故保持
平台默认项集（剪切/拷贝/粘贴/查询/翻译/服务…），不改项、不禁用。语义命令（Cmd+C/V/全选等）由
`macos/Sources/DSHChamber/AppDelegate.swift#installMainMenu` 的 Edit 主菜单承担，不依赖右键菜单存在；
语言随进程、外观随 `NSApp.appearance`。**退役判据** = Apple 在 macOS 侧为 WKWebView 放出右键菜单
API（或 NSView 回调对网页菜单确实生效）时，重评「覆写项集」并回写本节与 [deviations.md](../progress/deviations.md) S-11。

**Rejected alternatives**（本节的选择依据）：

- **在 `chamber-settings.json` 加 chamber-global 的 `language`/`theme` 键**：页面语言/主题是**按实例投影**的，
  全局键与「页面 document 是唯一事实源」直接冲突（同一窗口切换实例即失配），且会与布局 store 的文档级投影互写。拒。
- **壳写回页面**（把壳解析出的语言/主题写进 `documentElement`）：制造第二个事实源，页面重载即被自身投影覆盖，
  还会跟 active view 的主题所有权打架。壳只读、不回写。拒。
- **语言只靠 `AppleLanguages`（不设运行期覆盖）**：CFBundle 的 preferredLocalizations 在**进程启动期**解析并缓存
  （实测：写 AppleLanguages 后同进程取串不变），主菜单重建也不会换文案——那等于"语言下次启动才跟随"。
  故自建文案另加显式 `.lproj` 覆盖（`NativeText.setLanguageOverride`），框架/Sparkle/右键菜单保持进程级。拒前者单用。
- **把框架面也一律强制成应用内语言（跨"族"也写覆盖）**：会让日/韩/法/德系统的 Sparkle 与 AppKit 内建串
  被强制成英文，也会给"页面是 ja/ko（远端实例注册的语言）"的情形制造错误覆盖（系统本已能正确服务它）。
"族比较 + 同族不覆盖"的两层语义保留：**应用内面跟随设置、系统面跟随系统**。拒。
- **首帧就按系统外观解析动态露底色**：页面骨架恒为 `#0f1115` 且与主题无关，浅色系统上会在页面深色骨架前
  **反向闪色**；故取两段语义（先按 last-known 收敛、无事实才骨架常量，事实到达后换主题色）。拒"一次解析"。
- **暴露 app 专属外观开关（含 `NSApp.appearance` 常驻值）**：HIG 不鼓励，且会让"页面说了算"变成"壳说了算"；
  默认 nil 跟系统，只在页面显式主题与系统不同才覆盖。拒。
- **覆写 WKWebView 右键菜单项集**：WKWebView（macOS）公开面无右键菜单 API（NSView 同名回调对网页菜单是否生效未验证，见上"取舍"），任何实现都是私有 SPI 或重做上下文菜单，
  发行风险与逐系统复核成本不成比例。拒（退役判据见上）。

**相关契约**：`macos/Sources/DSHChamber/NativeText.swift#NativeTextKey`（键表）与 `macos/Sources/DSHChamber/NativeText.swift#NativeText`（取值链，优先语言覆盖包）、
`macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageFacts`（事实定义）、
`macos/Sources/DSHChamber/ShellPageFacts.swift#ShellPageFactsScript`（注入/对账脚本）、
`macos/scripts/build-swift-app.mjs#assertLocalizationsPresent`（装配 fail-closed）。

**待完成的实机门禁**（只记仍开放项）：右键菜单语言、Sparkle 标准窗语言与外观、`zh-Hans.lproj` 与 `zh_CN` 的**匹配已本机实测确认**（`Bundle.preferredLocalizations` → `zh_CN`；
剩余为打包态实机目视）、页面内切主题的即时性——判定以打包态实机为准（STATUS 登记）。
另有一条**已知边界**：本壳只随包 en/zh-Hans，而 `ShellPageLanguage.resolve` 把
`zh-*`（含 zh-Hant）折叠为 zh ⇒ zh-Hant 页面/系统下，壳自建文案按简体渲染（与页面 frame 自身的折叠
规则一致：`packages/renderer/src/locales.ts` 的 zh 字典即简体），未覆盖的系统框架/Sparkle 则按系统
zh-Hant 显示；简繁混排是否可接受需实机判断，若要收口须先决定是否随包 zh-Hant。

## 6. 数据、状态兼容与共存

### 6.1 userData 目录

- 目录名机制：Electron userData = appData + `app.getName()`（取 package.json **顶层** `productName`、其次
  `name`）。本仓 `productName` 只在 electron-builder 的 `build.productName`（只影响 .app/DMG 名），顶层没有 →
  实际取到包名 → **实根 `~/Library/Application Support/@dsh-chamber/desktop`**（GUI 验收：
  运行中的打包宿主 `--user-data-dir=…/@dsh-chamber/
  desktop`；同源声明见 `packages/desktop/scripts/electron-dev.mjs:14-23`）。Swift 版**同根**
  （`PackagedLayout.userDataDir`，由 `packages/desktop/chamber-lock.test.ts` ⑦ lockstep 断言钉住：Swift 常量
  必须等于 `顶层 productName ?? name` 推导；改 identity 同步两侧）；sidecar 以 `--user-data-dir` 接收。
- 直拼点全集（P1 参数化收口）：chamber-settings.json；runtime 基目录 = userData 本体（dsh-runtime 树在
  <userData>/dsh-runtime/…）；stateDir = userData/state（localDshHome=state/dsh-home）；ssh-plugin-journal.json；
  ssh-passwords.json；gateway-secrets.json；audit-log.jsonl；ssh-instances.json（引用前 grep 现取）。
- 旧版 Electron 保留物 `*.corrupt`（A13）在 Swift 首启前决定处置（预期：保留禁用，不主动清理）。
- 验证项 **U1**（实机）：Swift 计算的根与 Electron 打包实根一致（编号避开 §5 E 表，A9）。**实施现状**：`PackagedLayout`
  已按 `isPackaged` 解析——装配态 userData 与 Electron `app.getPath('userData')` 同根，node/sidecar/vendor-dsh/
  web-dist 全 bundle-relative；`DSH_CHAMBER_SHELL_*` 仍优先，dev 态保持 `dsh-chamber-dev` 隔离。**代码侧已闭合**
  （`PackagedLayoutTests` + `chamber-lock.test.ts` ⑦ 跨语言 lockstep），残余仅为 **C2 实机门禁**（互斥成立前提是
  Electron 侧装的是含锁的构建；实测：本机 /Applications 旧构建无 `chamber-lock`，不会持锁）。

### 6.2 bundle id 与双 flavor 共存

- Swift 版新 bundle id（推荐 `com.dshchamber.native`；决策 2），与 Electron 版（`com.dshchamber.desktop`）区分是硬前提；
  代价 = 通知授权按新 id 重新请求（风险 R4）。
- **WebKit 存储隔离（C2）**：WKWebView 的 WKWebsiteDataStore 落 `~/Library/WebKit/<新 bundle id>/`，与 Electron
  userData cookie/缓存是**不同 jar**——§6.1"同根零改动"不含 WebKit 存储；无跨进程共享开关；dsh web profile 的
  launch-token 登录态在 WebKit jar 下的保持/重建属 **P0 实测项**（G 门）。
- 不迁移既有目录（避免改写/降级风险）。

### 6.3 互斥与单实例（v2 修订：flock）

- 同一 userData 根**绝不允许两 flavor 并发**（registry/凭据事务/runtime 树无跨进程锁）。实现（**B2，采纳 STATUS
  「多控制面无跨进程 CAS」登记的 kernel-backed lock 建议，不用 pidfile/mkdir stale 模式**）：
  - 双 flavor 同持 `<userData>/.dsh-chamber.lock` 的 **flock(LOCK_EX|LOCK_NB)**（O_CREAT|O_NOFOLLOW，0600，原子
    创建）；fd 常驻进程寿命，进程死亡内核自动释放——天然免 stale；
  - 文件内 pid/启动时间**只作诊断与 sidecar 复验**（不是仲裁依据——仲裁始终是 flock 本身）；
  - **防自锁**：sidecar 若在新 fd 上再 flock 会与 Swift 首锁互斥（flock 按 open file description 计）——复验 = 读
    锁文件记录校验父 pid，**绝不二次 flock**。**复验语义**：记录 pid 是**持锁方**（Swift 壳）的
    pid，sidecar 是其直接子进程 → `record.pid === process.ppid` = 「我方父进程持锁」放行；
    `record.pid ∉ {self, ppid}` 且该 pid 仍存活 = 「另一 flavor/实例占用」
    → loud `exit 3`（Supervisor 对 exit 3 走 fatal、不重启）；`record.pid` 已死 = 陈旧记录（flock 随进程死亡由内核释放）→ 放行。
  - 锁文件与秘密文件同纪律（0600、no-follow、原子创建）；已登记进 `AGENTS.md` 秘密文件纪律清单。
  - **Electron 侧同锁（`packages/desktop/chamber-lock.ts`）**：Node 无 flock API，但 Darwin
    `open(2)` 的 `O_EXLOCK|O_NONBLOCK` 可经 `fs.open` 数值 flags 使用（实测：同进程再次 open 得 EAGAIN、close 后可重取）——Electron main 在 whenReady 首步取同一
    把锁，失败 fail-closed 弹窗退出（`dialog.showErrorBox` + `app.exit(1)`），`app.on('quit')` 释放（清理链 settle 之后；二审把释放点从 will-quit 迁到 quit）。**平台范围
    （有意收窄）**：`O_EXLOCK` 为 BSD/Darwin 专有，Linux 需 flock(2)（Node 未导出）、Windows 无等价物；Swift
    flavor 仅 macOS，故非 darwin 返回 `unsupported` 并放行（调用方 loud 记录该范围，绝不假装已互斥）。
- 与既有机制：RuntimeOperationFence/RuntimeWriterFence（进程内单飞，dsh-runtime/runtime-operation-fence.ts）与
  跨进程 flock **正交互补**。
- **state 根写者租约（L2）**：与上方 app 实例锁（L1，`<userData>/.dsh-chamber.lock`）不同 scope——L2 的单一文件是 `<stateRoot>/owner.json`（桌面/CLI 默认 `<userData>/state/owner.json`；host-root 另取 `<userData>/owner.json`，`scope` 字段区分），契约模块 `packages/control-plane/src/state-root-lease.ts`：no-follow O_EXCL + 回读终验、活 pid 拒绝（结构化 `state_root_locked` + holder pid/flavor）、死 pid rename 认领 + 字节/identity 证明、token+inode 精确 release（不匹配 `state_root_not_owner` 且绝不删除）、未知 `schemaVersion` fail-closed、同进程同根 `state_root_duplicate`。gateway 在首次 store 写之前取锁并把**同一 handle** 传 store/plane/runtime-manager（它们只 `assertCurrent`，仅顶层 owner 在其写者静止后 release）；**同一 state 根只有一个写者**，第二写者 fail-closed 退出 1，逃生口由单一 `resolveStateRoot` 承担（`--state-dir` > `DSH_<FLAVOR>_STATE` > `DSH_CHAMBER_STATE` > `~/.dsh-chamber`）。Swift 时序：壳先持 L1 flock → spawn sidecar → sidecar 取 host-root（L2）→ 装配期经 plane 取 state-root（L2，严格先于 `start` 的 reaper）；host-root 冲突时 sidecar stderr 输出 `state_root_locked` + holder pid/flavor + root 并以 `EXIT_STARTUP_FAILURE=70` 退出（Supervisor 按 fatal 不重启）。

### 6.4 凭据与安全文件

- SSH 密码镜像（ssh-passwords.json v2）：endpoint-bound 0600 明文，Swift flavor 语义不变。
- gateway-secrets（v3，safeStorage|plaintext 判别）：Swift flavor 无 safeStorage → 新写一律 plaintext 判别 + 0600 原子写（既有诚实回退）；读旧 safeStorage 判别条目 → 解密不可用 → **保留文件与绑定、标记禁用待重录**
  （复用"legacy 保留禁用"语义；判别路径补单测 **S1**）。
- 静态加密走决策 7（Keychain 持随机文件密钥 + HostEdges encrypt/decrypt edge）；v1 不排期。

## 7. 更新（design 11 的 Swift 侧形态）

- Electron 版维持 electron-updater（GitHub provider、zip target）不动。
- **Swift 版更新链 = Sparkle 2（「D-1 选 B」，取代原 v1 blocked-available）**：壳内
  `AppUpdater`（`macos/Sources/DSHChamber/AppUpdater.swift`）持 `SPUStandardUpdaterController`，承担**检查 → 下载 → 重启并安装**。安装必须由
  bundle 外 helper 完成（运行中的 .app 不能覆盖自己），更新包以 **EdDSA 公钥**（`SUPublicEDKey`）鉴权（与
  Developer ID 签名/公证两回事：后者分发信任，前者更新通道鉴权）。
  - 装配：`Info.plist` 的 `SUFeedURL`/`SUPublicEDKey` 由 `build-swift-app` 的 `--sparkle-feed`/
    `--sparkle-public-key` 注入（占位符 `__SPARKLE_FEED_URL__` / `__SPARKLE_PUBLIC_ED_KEY__`）；任一为空 = 更新
    不可用（菜单「检查更新…」禁用，不声明 `--native-updater sparkle`）。`SUEnableAutomaticChecks` 模板常量
    **true**：每次启动强制一次后台检查（S-37），此后 `SUScheduledCheckInterval=21600`（6h）；scheduled 标准窗被
    壳内抑制（`SPUStandardUserDriverDelegate` 把展示权
    收回壳 → 相位进设置页），用户手动的「检查更新…」仍走标准窗。
  - 最低系统版本：两 flavor 同为 **macOS 14.4**（`build.mac.minimumSystemVersion` 与
    `LSMinimumSystemVersion` 写精确 14.4；`Package.swift` 的 `.macOS` 只能写 major，故写 `.macOS(.v14)`，
    精确下限由 Info.plist 承担；三处一致由 release 策略测试钉住）。**为什么 14.4**：OS WebKit 的出货 bundle 在
    多处构造路径直接调 `Promise.withResolvers`（A3-1），该 API 自 Safari 17.4 / macOS 14.4 才有（13.x 与
    14.0–14.3 会构造期 TypeError）；Electron 自带 V8 不受影响，但同一支持矩阵只保留一个下限（抬高下限，不加 polyfill）。
  - feed 必须 appcast：Sparkle 只读 appcast（XML feed + EdDSA 签名），不消费 GitHub REST API 或
    `latest-mac.yml`；`SUFeedURL` 指向**本仓 release 自带资产**：稳定通道
    `releases/latest/download/appcast-swift.xml`，beta 通道
    `releases/download/appcast-swift-beta/appcast-swift-beta.xml`（滚动 tag `appcast-swift-beta`，每 beta
    `--clobber` 覆盖 ⇒ beta.N 见 beta.N+1）。
  - 双 flavor 分工：**壳声明原生更新器可用时检查也由壳承担**——页面「检查更新」经
    `updateNativeAction kind=check` 转 Sparkle，页面只消费壳推回的 `dsh-chamber:update-state-changed` 相位
    （checking/available/downloading/downloaded/installing/failed），**不再发 GitHub Releases 查询**；Electron
    （无原生腿）保留 headless GitHub 检查。sidecar 清空 `installBlockedReason`，「更新 / 重启并安装」经 edge
    （`updateNativeCapability` / `updateNativeAction`）：`kind=check` → 壳内检查，
    `kind=download|install` → Sparkle 标准窗口（无「仅下载」公开 API），忙碌/未配置/未知 kind 如实拒绝；能力查询
    回 `{available, error}`，坏 feed/密钥不再「假装可用」（S-38/S-39）；无原生腿时仍回显 `原生壳不支持自动安装`。
  - 安装前清理：`SPUUpdaterDelegate.updater(_:willInstallUpdate:)` 先停受管 sidecar、收 keep-awake 与 Dock 角标
    （安装路径不保证先走我们的退出链）。打包：`build-swift-app` 把 `Sparkle.framework` 嵌入
    `Contents/Frameworks`、补 `@executable_path/../Frameworks` rpath 并校验（嵌入先于签名）。
  - 发布（增量更新）：`SPARKLE_PUBLIC_ED_KEY` 注入 feed/公钥、`SPARKLE_PRIVATE_KEY` 签名 appcast；
    **单钥匙是发布 FAIL**（公钥在而私钥缺 = 壳会轮询没人签的 feed；私钥在而公钥缺 = 会发布一个
    「带签名 appcast 却检查不到更新」的包，而且它的 zip 之后会被当成产不出 delta 的基线），两钥匙都缺才是
    loud 降级（照常出包、自动更新关闭）。**stable 与 beta 的收件目录/feed 上传面完全分开**（`/tmp/appcast-in-stable` /
    `/tmp/appcast-in-beta`）：generate_appcast 按归档内嵌 `SUFeedURL` 的文件名分组，两通道归档同目录 + `-o`
    会直接失败 `multiple appcasts found`。每通道 stage 本通道前 K 个历史 zip（`SPARKLE_DELTA_SOURCES`，默认 2、
    上限 5；两个通道都要求基线**自带与当前发布公钥一致的非空 `SUPublicEDKey`**、且与当前 app **同分支**
    （同 `LSMinimumSystemVersion`；解包主 app 的 `Info.plist` 判定，stable 侧再要求那次 release 带过
    `appcast-swift.xml` 作廉价预筛）——没有公钥的旧 app，Sparkle 既不产 delta 也不写放弃标记；空 key/密钥轮换
    后的旧 key 会产出「任何公钥都验不过」的 delta；跨分支的历史包会让 feed 出现第二个条目。这些都只降覆盖率、
    不作基线（loud notice））→ 产出 `<sparkle:deltas>`（Sparkle 原生增量，客户端零改动、失败回退整包）：stable 用
    `--maximum-versions 1` 保持单条目（历史 zip 只当 delta 基线、不进 feed，避免 `releases/latest` 死链），
    beta 保留最近 3 条（合并时把旧 feed 的 beta 条目也并回来并以 `--beta-item-limit` 截断：staging 少收归档时
    旧 beta 不许消失）；verify 在**没有任何放弃/丢失**时按最新基线精确断言 `deltaFrom` 且 delta 条数 = staged
    基线数，否则只要求已核实的匹配数；并另有**逐基线账目**——每个 staged 基线要么在 appcast 里有它自己的
    `deltaFrom`、要么 Sparkle 为 (新构建号, 它) 写了放弃标记 `*.ignore`，两者都不是即点名 FAIL
    （逐条归因才挡得住「多 branch / 多条 feed 的标记互相顶替」，且全部被放弃时门禁也不退化）；此外 verify 会用 `SPARKLE_PUBLIC_ED_KEY` 对**本版本 zip 与每个 delta 逐条做 Ed25519
    真验签**（`--signatures-dir` 提供真实字节）——只查「签名存在」挡不住密钥轮换后那个任何公钥都验不过的
    签名（真实 Sparkle 2.10.0 复现：旧包内嵌 A、新包/签名用 B 时 delta 签名两边都不成立）。**Sparkle 主动放弃 ≠ 链路退化**：它按体积
    规则（delta > 7/8 整包）放弃时只在收件缓存写 `*.ignore`、stdout 无提示——发布腿据此把那些基线降级为
    loud 警告 + 整包下载，只有「没有放弃标记却没产出 delta」才 FAIL（否则体积规则会误红正式发布）。**enclosure 必须可解析**：beta 生成时
    `--download-url-prefix` 指向滚动 tag，当前 beta zip 与本次新 delta 先传滚动 release 再传 appcast（S-36）；
    stable 不传前缀（形状除新增 `<sparkle:deltas>` 外不变），delta 随 draft 上传。**stable appcast 从不发布到
    滚动 release**；S-23 刷新只把 final zip + stable delta 推到滚动 release（先归档后 feed），并覆盖滚动 beta
    feed。**S-23 改法**：beta feed 的 final 条目由 `scripts/release/merge-native-feed.mjs` 从已发布 stable feed
    复制并改挂**版本固定**前缀 `releases/download/<stable-tag>/`（缺 stable feed 时保留上次滚动 feed 里的
    final 条目，绝不删可见性）；stable 发布时以「已发布滚动 feed 的 beta 条目 + 本次 final 条目（URL 改写为
    滚动前缀）」合并刷新滚动 feed。**两个前缀是契约**：beta 期抄来的 final 走版本固定前缀（`releases/latest`
    会被后续正式版移走 ⇒ 404），stable 刷新后的 final 走滚动前缀；beta.N 见 beta.N+1 与后发 final
    （S-22/S-23）。契约：
    `UpdateController.restartAndInstallAsync?()` 为原生腿提供异步面（IPC 处理器优先用它），Electron 的同步实现与
    页面契约不变。
    **被否决的替代方案**：① 两通道共用一个收件目录（原状）——首个正式版原生包落地时必报
    `multiple appcasts found`，否决；② beta 腿下载最新正式版 zip 放进收件目录（S-36 旧做法）——每次 beta 多下
    83MB，且 final 条目 URL 依赖可变的 `releases/latest`，改为从已发布 stable feed 复制条目；③ 用「放弃标记
    计数」精确复现 Sparkle 的 7/8 体积规则并硬 FAIL——合法的大改版会误红正式发布，改为标记存在即 loud 降级、
    无标记才 FAIL（签名失败另行硬失败）；④ 把 delta 期望逐条绑到每个基线——`--maximum-deltas` 与 branch point
    会让合法放弃变成红，改为「最新基线精确 + 条数 ≥ 剩余基线数 + 账目守恒」；⑤ stable 保留多条历史条目——
    历史条目会引用 `releases/latest/download/<旧 zip>` 死链，改为 `--maximum-versions 1`。
    **同版本重跑**：滚动 release 是公开面，重跑时先比对同名 zip 的字节——一致才允许覆盖（幂等重跑），
    不一致直接 FAIL 并提示提升 beta 号（否则已发布 feed 的签名指向的字节变了，客户端先验签失败）。
    **draft 面顺序**：appcast 在 zip/delta 之后才上传到 draft（S-36 的「归档先于 feed」不再依赖「draft 不可见」）。
- **shell-flavor 判别字段（§0.1-E2）**：`dsh-chamber:info` 载荷带 `flavor`（`main.ts:3892` 的 `hostFacts`；镜像面仍 4 标量），
  但**共享 renderer 至今无消费者**——UI 能力门（更新文案/重启安装按钮）实际由 `installBlockedReason` 与原生能力
  位驱动；字段保留备查（用前须补消费者与 preload.cts/global.d.ts 镜像测试）。
- **检查腿的宿主叶**：headless 控制器 `setState` 时逐个 listener 走 try/catch，推送腿抛错绝不反噬控制器
  （`update-headless.ts:212-224`）；sidecar-ctx 的 HostEdges 必须**显式**提供惰性 `disarmUpdaterQuit: () => {}`
  （`sidecar-ctx.ts:2768`）——methodStub 把「缺失成员」变成调用即抛的 `sidecar-ctx-unavailable:*` 递归 stub
  （`sidecar-ctx.ts:2774-2784`，抛错点 `:2777`），省略会让首次「检查更新」抛错、checking 卡死；这是有意的惰性
  契约叶，不是死代码。
- v2（P3 末，决策 3）：Sparkle 独立 EdDSA appcast 由发布 CI 生成。

### 7.1 差异复核方法：可达性优先

双端差异复核顺序固定为 **可达性 → 用户可见性 → 最小改动位置**（来源：open-in 复核，见 `docs/progress/deviations.md` §7）：
1. 先查调用点/消费者（`grep "edges\.<member>("`、A 桥通道消费者、host 包域使用者）；无调用点 = **潜伏差异**，不进修复队列。
2. 只修「可达且用户可见」的差异，位置优先 `macos/`。
3. 跨出 `macos/` 必须给出调用点证据：只有新增能力/通道/契约才动共享面，否则只登记。
4. **契约面 ≠ 功能面**：`HostEdges` 有成员不等于用户路径有行为（潜伏 10 / 可达 6）。
`SwiftEdgeHostLegs` 能力分三栏：**共享执行面（可达，必须与 Electron 逐字一致）**、**壳侧执行面（shell-internal/超集，不宣称共享契约）**、**潜伏契约面（保留形状，等第一个消费者）**。

## 8. 实施阶段、测试与验收

> companion `docs/progress/todo/macos-swift-v1.md` 持有 WBS 编号索引（W-01…W-32）、双线防漂移门禁清单、W1–W7 判定
> 标准、双端性能/产物体积 A/B 协议、中止点 A1–A8 与 dev 侧约定；分批顺序、runbook 与工期估算已随收口删除（git
> 历史），本节只留契约性要点。

### 8.1 P0 POC（1–2 人周）——先证伪再立项

> P0 代码面已交付（`macos/` 壳 + `bridge-shim.js` + B 桥 + dev 直跑 `sidecar-entry.ts`）；G1 经用户实机目测确认，
> **G2–G5 与 C1/C2 的实机判定仍开放**（STATUS 登记）。以下保留门定义与判据。

1. `macos/` 最小壳：WKWebView 加载控制面 origin 的壳文档（`/`）；dev 后端 = `sidecar-entry.ts`
   （standalone/cli serve **不接 webDistDir**，故不经它们；`DSH_CHAMBER_SHELL_*` 可覆盖 userData/port/dsh path）。
2. A 桥 shim 接通代表通道：`info`、`desktop_ssh_instances_get`、`desktop_ssh_status_changed` 推送；通知
   click 走真实回环。shim 挂出时机的 D1 判决见 §4.4.1（方案②：documentStart 预定义 + ready 前统一拒绝）。
3. 验收门（**G1–G5 + C1/C2，全过才继续**）：
   - G1 主界面（多实例/会话/设置页）在 WebKit 渲染无功能缺口；
   - G2 剪贴板复制粘贴（含富文本）、文件拖拽（附件/file input）、外链跳转、**非 http(s) scheme 导航**；
   - G3 侧栏插件（git/open-in/settings-bridge）可用；
   - G4 深链冷启动不丢、通知点击可激活会话；
   - G5 退出/隐藏/唤醒补发语义与 Electron 版一致；**hide 后 ≥30s 的 SSE/WS 心跳与唤醒即时重连实测（C1：
     backgroundThrottling:false 无 WKWebView 等价物）**；
   - C2 双 flavor 交替用同一 userData/dsh 实例时，WebKit 独立存储 jar 下会话 cookie/登录态实测并定共存语义；
   - P0 预检：双端同机跑 boot 参考点（方法见 companion §七），只为尽早暴露引擎级数量级异常，**不作定标**。
   G1–G5 任一实质失败 → 回到本文档重审路线（§10 决策 1）；**C1/C2 除外**——按 §0.1 闭合清单处置（C1 失败 = 登记
   已知降级或走 keep-alive/唤醒补发；C2 = 定共存语义后继续）。

### 8.2 P1 core 拆分（2–3 人周，Electron 不回归）

- §4.1 拆分 + HostEdges 全量定义（v2 字段集）；Electron 版跑全量测试作为门禁；core 对 electron 的 import
  零容忍（CI lint）。
- **3 个测试把 main.ts/preload.cts 当源码文本断言**（`packages/desktop/test/ipc/ipc-surface-mirror.test.ts:449`
  的 MAIN_SIDE_FILES、renderer-trust、transport-manager 同族）→ 锚点随处理器迁移 shell-core.ts；**control-plane-module.ts
  的 isPackaged 门 flavor 化**：`isPackagedSidecarRuntime()`（`DSH_CHAMBER_SIDECAR_COMPILED=1`）时加载
  `<sidecar>/dist/control-plane/index.js`，否则走 workspace 源码 import（:47-90）。
- 产出 `sidecar-entry.ts` + `node-edges.ts`；sidecar 可在纯 Node 下以"假 Swift"驱动（`sidecar-stdio.test.ts`）跑通
  全量 61 通道冒烟——**写 Swift 前先用现有 JS 测试资产钉住 B 桥协议**。

### 8.3 P2 Swift 壳 v1（3–4 人周）

E1–E20 按 §5 实现（E15 走 §6.4）；manifest 生成与护栏；Supervisor 与启动序列（§3.3）；A 桥 shim 全通道对拍；
双端 harness 冒烟（`swift-harness-driver`：node 集成测试拉起 Swift harness 断言真实窗口/桥，
loopback-http-test-server.ts 同款思路）**未实施——需 GUI 会话，见 §8.6**。

### 8.4 P3 边沿完整 + 发布管线（2–3 人周；真实 runner/凭据仍为外部阻断）

- **DMG 拖拽引导**：原生 DMG 早先只有 `.app + /Applications` 快捷方式、无引导，现改为与 Electron
  **同款**：背景用 `electron-builder` 模板的双 rep TIFF（540×380@72dpi + 1080×760@144dpi；
  `macos/resources/dmg-background.tiff`，署名见 THIRD_PARTY_NOTICES），图标坐标取 electron-builder 默认 contents
  （app 130,220 / Applications 410,220），窗口尺寸 = 背景 1x 尺寸。单一来源 = `macos/scripts/dmg.mjs`（本地装配腿
  import，release.yml 正式腿调 CLI）：UDRW 可写镜像 → 挂载 `/Volumes/<卷名>` → osascript 驱动 Finder 写
  `.DS_Store` → 等**内容级**布局落盘（`.icvp` 的 `backgroundType=2` + 指向卷内背景图的别名）→ detach →
  UDZO → 产物级校验（只读挂载成品读 `.DS_Store`：`backgroundType=2`、非空且指向卷内背景图的别名、`iconSize`、
  窗口尺寸、两条图标坐标；`.app`/`/Applications` 软链/`.background` 的存在性只是前置）。
  **Rejected alternatives**：① `dmg-builder` 下载的 dmgbuild（不驱动 Finder；要引入 electron-builder 内部下载器/缓存
  路径，本机缓存实测为空）；② 手绘 1x PNG（「分辨率低、不像 Electron」，放弃）；③ 静态
  `.DS_Store` 模板 + `hdiutil -srcfolder`（alias 与卷名/CNID 绑定，跨构建脆弱）；④ 只留软链不做引导（用户报的
  问题本身）；⑤ 用 `plutil -extract <key> raw -o -`（stdin，实测可用、约 24 行）逐键读布局事实而不自写二进制
  plist 读取器——为让事实提取成为零子进程、可注入的纯函数（单测可直接构造 facts）而否；代价是自写读取器要自己
  守住语义（修正有符号整数读取）。失败一律 loud：回退成「没有提示的 DMG」等于把缺陷重新发出。
  别名的**可解析性**由 审查用 Carbon `FSResolveAliasWithMountFlags` 在最终 UDZO 上实测确认（挂载态
  RESOLVED；Finder 自己并不校验别名，删掉背景图后仍保留 `backgroundType=2`），因此门禁只断言必要条件：
  别名字节同时含卷内相对路径与本卷卷名。
- **SwiftPM 资源包形态**：包内形态随后端——`native` 扁平 `<bundle>/bridge-shim.js`，`swiftbuild`
  （Swift 6.4+ 默认）为 `<bundle>/Contents/Resources/bridge-shim.js`。装配腿 `resourceBundleResourcesDir()` 统一
  收敛为扁平（与 release.yml 的资源断言、运行期查找同契约），运行期 `ChamberResources.candidateURLs()` 兼容
  嵌套形态（dev `swift run`）。备选 ① 显式 `--build-system native`（已 deprecated、且管不到 dev/test 与
  `swift run`）、② 重指 `macos/.build/release` 到 native 产物（只治标、两种形态照旧）——都被否。
- 更新 v1 blocked-available（§7）；v2 Sparkle 按决策 3 未排期。sidecar 打包布局 = `dist/control-plane/` + host 包
  `dist/dsh-chamber-seed-*/` + 内嵌 `vendor/dsh`/`pnpm` + 捆绑 `node`（§3.2）；build-swift-app.mjs；CI：GitHub
  Actions macOS runner（swift build + XCTest + 打包 + ad-hoc/Developer ID + notarize——mac 发布缺 Apple 凭据阻断，
  Swift 版同门禁）；图标/资源复用（icon.icns 平移）。

### 8.5 P4 实机门禁矩阵（1–2 人周）

逐项走查：打包态全链（控制面起动/本地实例预启动/连接/网关凭据重录/运行时版本管理与回退/插件同步/归档清理入口（无
对话框）/通知点击/深链/隐藏恢复/唤醒补发/退出确认）；WKWebView parity 清单（W1 剪贴板、W2 菜单快捷键、W3 富文本粘贴
与拖拽、W4 打印/查找、W5 字体/滚动/IME、W6 后台节流对 SSE/WS——**无 backgroundThrottling 等价物（C1）**、W7 刷新率
三工况（插电 120fps / 电池 + 低电量模式 60fps / 60Hz 外接屏不回退；判据见 §5.1、登记 deviations S-48；100Hz 类非
整数倍屏以 `[shell-fps]` 实测为准），判定标准见 companion §七）。性能与同环境 A/B 纪律见
`scripts/perf/README.md` + **双端性能/产物体积验收协议**（companion §七：相对门/绝对预算/能力门、注入式探针平移
四场景、M5 双端同 tag 的 .app/dmg/zip 目标 ≤ Electron × 0.75）。原生壳专项：**最低支持版本 macOS 14.4 上首启 +
视口越界策略（§5.2）复验**，通过后 S-50 退役判据才闭环。

### 8.6 测试策略汇总

| 层 | 内容 | 现状 |
|---|---|---|
| JS 业务 | desktop/control-plane/runtime 现有单测与镜像测试 | **原样复用**（P1 后跑同一文件集 + 3 个文本锚点测试随迁） |
| B 桥 | 信封/帧长/超时/乱序/edge 往返——node 侧假 Swift 驱动（`sidecar-stdio.test.ts`），Swift 侧 XCTest | `sidecar-stdio.test.ts` + `BridgeClient*Tests` |
| A 桥/护栏 | shim 与 manifest 一致性（bridge-manifest / bridge-shim / bridge-shim-surface）、origin 门、尺寸门 | 有测试覆盖 |
| 集成 | node 集成测试拉起 Swift harness 断言真实窗口/通知/深链 | 无 GUI 通道冒烟（61/61）；真实窗口 harness（`swift-harness-driver`）未实施——需 GUI 会话 |
| 壳视图策略 | 视口越界策略（§5.2）的注入契约与装配点 | 探针与 Swift 锁测试已按 裁决从正式测试面移除；效果只做实机目检（§8.5 矩阵 / S-50） |
| 实机 | §8.5 矩阵（含 W7 刷新率三工况，S-48）+ C1/C2 | 未判，发布前执行（STATUS） |

## 9. 风险与开放问题

- R1 **双业务源码漂移**：core 拆分后 Electron 版独立演进会让 Swift 版滞后。缓解：单 repo 单 core；host-edge 契约评审
  门禁；mirror + bridge-manifest 双锁步（含 `bridge-shim-surface.test.ts`）；同 tag 双壳发布。
- R2 **WKWebView 差异**：渲染引擎/权限模型/devtools 不同；无 backgroundThrottling/unresponsive 等价物（C1/B5）；无网页
  Notification 预拒绝 API（B10）；存储独立 jar（C2）。P0 先行证伪（G1–G5 + C1/C2）。
- R3 **Node 捆绑与架构**：arm64/x86_64 × 两 flavor 的 CI 成本（决策 6）。
- R4 **通知授权身份变更**：新 bundle id → 用户需重新授权通知。
- R5 **目录并发互斥**：§6.3 flock 为仓库首个跨进程锁，协议需新定义（格式/诊断字段/双进程复验）；与进程内围栏正交。
- R6 **旧 safeStorage 密文迁移**：Swift flavor 首启遇旧 gateway 凭据不可解密——"保留禁用待重录"（S1 单测）。
- R7 **Swift 代码面安全评审**：桥护栏（§4.4）是新信任边界； + 负例测试（伪造 frame/超大帧/非协议流/伪造事件名/
  越 origin）。
- R8 **更新双轨**：v1 blocked-available 诚实形态；Sparkle 密钥/回滚在 v2 单独评审。
- R9 维护负担：Swift 壳新增一门语言/一条 macOS CI；需有人持续负责 Swift 侧。
- R10 开发期双后端竞态：Electron dev 与 sidecar dev 共享 cp 端口族 → 各自
  退避 + 端口钉死 + 独立 .dev-user-data（companion）。
- R11 Swift 侧人手单点：护栏规则集中 DSHChamber 单 target + Generated 产物减少手写面。
- R12 manifest 解析脆弱性：正则扫字面量会漏新写法 → 复用 mirror 解析函数 + 通道数守恒断言（69=61+8）。
- R13 WKWebView devtools：仅 debug 构建开启（inspector 属信任边界）。

## 10. 外部决策清单（签核尚未完成；日程见 companion §八）

1. **路线确认与 P0 先行**：是否按路线 A 启动 P0（1–2 周 POC）？验证门（G1–G5 + C1/C2）任一失败即回路线评估（中止点
   A1–A8 见 companion）。
2. **双壳共存形态**：Swift 与 Electron 长期共存（各自发布）还是 macOS 替换？推荐**共存**，bundle id
   `com.dshchamber.native`。
3. **更新路线**：v1 blocked-available 诚实形态 → v2 Sparkle（推荐）；或 v1 直接 Sparkle。
4. **仓库落位**：`macos/`（SwiftPM，推荐）vs `packages/swift-shell`。
5. **原生 UI 渐进**（路线 B/C）：本文不覆盖；HostEdges 边界即未来接缝，侵蚀需另立设计。
6. **Node 版本与架构**：与 Electron 43 内置 Node 大版本对齐 vs LTS；arm64-only vs universal2。
7. **静态凭据加密**：v1 诚实 0600 明文（推荐）；或提前排 Keychain 协助加密 edge。

### Rejected alternatives（架构调整）

- **装配保持两份**（main.ts 与 sidecar-ctx.ts 各自维护整套装配）：否决——去空白后 186 行逐字重复且已出现微差漂移；改为 `packages/desktop/host-assembly.ts` 的 `createHostAssembly(deps)` 单实现，两 flavor 只留各自 edge 接线（实测重复 186→3；差异全部经 `HostAssemblyDeps` 显式注入，体内零 flavor 分支）。
- **深链 scheme 放 shell-core、deep-link 反向 import**：否决——shell-core 顶层 `new BoundedVscodeIntentQueue(...)` 来自 deep-link.ts，反向 import 形成 ESM 值依赖环并命中 class TDZ；改为零依赖 leaf `deep-link-scheme.ts`，两侧比较收敛为 `isDeepLinkUrl`/`isDeepLinkProtocol`。
- **state 根沿用三把锁**（gateway `.gateway.lock` + `dsh-runtime/owner.json` + serve/standalone 无锁入口）：否决——三处语义不同，且无锁入口可与运行中 gateway 双写同一 state 根；改为单一 `<stateRoot>/owner.json` 租约模块（`state-root-lease.ts`，§6.3 的 L2），L1 app 实例 flock 保持不动（不同文件、不同 scope）。
- **把 Swift 布局锚点迁移与 R1/R2 同批做**：推迟——`PackagedLayoutTests.swift:156-205` 文本锁 sidecar-ctx 的七个助手与 `resolvePnpmEntry` 候选顺序，迁移属 macOS 实机门；本批保持锚点逐字成立（静态复核 17/17）。

### A 桥导航与 sidecar 重启的时序契约

每个注入文档生成独立 `documentId`，与请求 ID 一起进入信封并由 Swift 回显。页面只接受同文档回执，避免重载后旧文档的 `id=1` 结算新文档的 `id=1`。B 桥调用按方法设置期限；导航只需丢弃旧文档回执，sidecar 退出会作废全部在途调用。新 ready 帧触发 `info` 再水化、通知监听重新握手与会话事实对账。WebContent 自动重载期间窗口标题显示本地化恢复状态，导航完成后清除。

**Rejected alternatives**：只用请求 ID 无法区分导航前后的重复编号；只重新读取 `info` 会让通知打开监听与事实基线保持在旧 sidecar 世代；把普通调用无限等待会让宿主重启后页面永久悬挂；用 `evaluateJavaScript("1")` 证明内容已绘制不成立，它只证明 JS 上下文应答。可见页的主动 rAF 心跳证明帧调度仍在前进，但 WKWebView 不向宿主暴露最终合成帧的提交游标；JS 与 rAF 同时正常而像素仍停滞时，宿主依旧无法单凭该探针自动重载。

**Rejected alternatives（恢复预算）**：把排定后被新导航取消的重载仍计入 60s 配额，会让零次实际重载也耗尽三次预算；取消时退还该次计数，并用排程代际阻断取消后迟到执行的 work item。
