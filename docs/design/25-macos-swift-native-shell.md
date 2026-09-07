# 25 · macOS Swift 原生壳（路线 A：WKWebView + Node sidecar 全复用）

> 状态：**方案草案（未立项 / 未实现）**。本文按路线 A（Swift 写壳、
> Node sidecar 原样承载现有 control-plane 与 desktop 纯 Node 业务）给出详细
> 设计，作为立项与实施的技术底稿。所有代码级引用以 v0.2.2 时代仓库为准
> （行号/文件名已在正文标注）；正文「复用清单」只陈述经核实的现状事实，
> 不臆造尚未存在的模块。
>
> 立项前需用户拍板的外部决策见 §10（平台策略、bundle id/共存、更新路线、
> 仓库落位、Node 版本钉住）。任何实施必须先过 §8.1 的 P0 验证门。
>
> 相关既有契约：05（§7.4 IPC 白名单 / §7.5 本地实例）、11（自动更新）、
> 13（远程插件编排）、14（休眠/唤醒/设置）、16（VS Code 深链）、17
> （gateway 会话与凭据）、18（dsh 运行时版本管理 + apply-now）、19（桌面
> 通知投影）、20（open-in 注册表）、21（gateway 插件对齐）。

## 0. 摘要（给决策者的三分钟版）

- **路线 A 的定义**：Swift/AppKit 只实现"壳"（窗口、WKWebView、菜单/托盘/
  通知/角标/深链/对话框/外部打开），**壳内不承载任何业务**；业务 = 现有
  control-plane（纯 Node 12.1k 行）+ desktop 纯 Node 业务模块（约 23.5k 行，
  其中仅 `main.ts`/`preload.cts`/`updater.ts` 4 个文件依赖 Electron），以
  **打包为独立 Node 可执行文件的 sidecar 子进程**原样运行，Swift 与它之间
  走一条受信的 stdio JSON-RPC 通道（B 桥）；Web UI 100% 复用，仅把 preload
  的 `window.dshChamber` 换成一个等价的注入 shim（A 桥）。
- **为什么可行（现状核实）**：① desktop 业务模块全部无 Electron import、
  测试直接 `node *.test.ts` 可跑；② 控制面本来就是 loopback HTTP/WS 服务，
  与宿主只通过 `createControlPlane(options)` 参数握手；③ dsh 实例本身是
  Node 进程，`spawn-dsh.ts` 的 node 解析在纯 Node 进程里自动走
  `process.execPath` 分支（Electron 分支只多了 `ELECTRON_RUN_AS_NODE`），
  sidecar 即自带 node，**零改动**；④ 桥接面已收敛：60 个 `ipcMain.handle`
  invoke + 8 个 push 事件，通道名集中在 `ipc-events.ts` 的 `IPC_CHANNELS`
  （single source），并由 `ipc-surface-mirror.test.ts` 锁步。
- **工作量（熟练工程师人-周，单人 ×2.5）**：P0 POC 1–2 → P1 core
  拆分/edge 化 2–3 → P2 Swift 壳 v1 3–4 → P3 边沿完整 + 打包/公证/CI 2–3
  → P4 实机门禁 1–2；合计 **9–14 人周**。Electron 版全程并行保留（P1 的
  前提），Win/Linux 不受影响。
- **不做什么**：不重写 UI（对照 luochenw/deepseek-harness-macos 的全原生
  路线，那是 3–6 人月起步并伴随永久 parity 维护）；不在 Swift 里重写宿主
  服务（对照 summer-521/deepseek-harness-swift 约 900KB Swift 服务层 +
  自研 JS desktop-host，它的路线是我们的路线 B，见 §2 对照）；不碰 gateway
  服务端形态。
- **关键决策点**：macOS-only 意味着与 Electron 三平台版是**双壳共存**还是
  **替换**；bundle id 是否与 Electron 版区分（影响通知授权身份）；更新走
  「v1 打开发布页 + v2 Sparkle」。

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
- v1 不做 Sparkle 全自动安装（见 §7；先诚实"打开发布页"）。

## 2. 市场参考仓库对照（2026-08/09 GitHub 实况）

| 仓库 | 路线 | 形态 | 对我们的可借鉴点 | 不借鉴点 |
|---|---|---|---|---|
| [luochenw/deepseek-harness-macos](https://github.com/luochenw/deepseek-harness-macos) | 全原生 UI | SwiftUI/AppKit 重写整个 dsh 客户端 UI + 内嵌 Node + JS runtime-extras 注入 | `scripts/prepare-dsh-runtime.sh`/runtime 钉版思路；`WEB_PARITY.md` 式功能对等清单；无 Xcode 工程也可行（swiftc 直接构建 + ad-hoc 公证） | 全原生 UI 的工程量（对照 §0）；UI 重写后的永久上游 parity 维护 |
| [summer-521/deepseek-harness-swift](https://github.com/summer-521/deepseek-harness-swift) | WKWebView 壳 + Swift 原生服务层 | AppKit/WebKit 壳；Swift 版版本管理（35KB）、插件管理（131KB）、恢复（61KB）、设置（110KB）、`NodeRuntime.swift`、Sparkle appcast | **壳层实现形态与路线 A 高度同构**：`NodeRuntime.swift` + fetch-node/fetch-pnpm 脚本、WKScriptMessageHandler 消息校验、`swift-*-harness.swift` + node 集成测试双端模式、`appcast-swift.xml` | 它自研的 `assets/dsh-desktop-host/*.js`（desktop-host/webserver/broker ≈ 90KB）正是我们**不需要**的：我们用现成 control-plane 替代 |
| [wheam/deepseek-harness-mac-app](https://github.com/wheam/deepseek-harness-mac-app)、[aibinghezzz-stack/deepseek-harness-macos](https://github.com/aibinghezzz-stack/deepseek-harness-macos)、[guanyifang344/dsh-launcher-mac](https://github.com/guanyifang344/dsh-launcher-mac) | 最小壳 | 几百行 WKWebView 加载 dsh web | POC 下限证明：WKWebView + `NSAllowsLocalNetworking` 跑通 dsh web GUI 无障（含 ATS 例外先例，本仓库 electron-builder mac 配置已含同款） | 无 IPC/凭据/运行时管理，不可直接作为 chamber 壳 |

结论：市场上**没有** chamber 能力的 Swift 参考实现（SSH 隧道、gateway
会话、宿主包种子、N-ctx 编排），这些在路线 A 中不重写而是复用 sidecar，
因此参考仓库只能校准"壳与打包"部分的成本；任何声称能"直接抄"chamber
Swift 化的说法都不成立。

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
│  SidecarSupervisor（spawn/守护/重启/日志）                    │
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
│    ssh-passwords.json, gateway-secrets.json, chamber-settings.json, │
│    audit-log.jsonl, dsh-runtime trees, 日志}                  │
└───────────────┬─────────────────────────────────────────────┘
                │ spawn（resolveNodeExecutable 纯 Node 分支）
        ┌───────▼────────┐        ┌──────────────────────┐
        │ dsh web profile │  …N 个  │ 远程宿主（ssh/gateway） │
        │ 实例（Node）     │        │ 经系统 ssh / HTTP      │
        └────────────────┘        └──────────────────────┘
```

- **Swift 壳**不 import 任何业务模块；它是"边缘执行器 + 传输层护栏 +
  窗口"，业务状态全部在 sidecar。
- **sidecar** = 打包产物：`node sidecar.js --user-data-dir <dir>`；stdout/
  stderr 不混业务：stdout 是 B 桥协议流，stderr 是日志（Swift 侧落盘
  `~/Library/Logs/` 或 userData/logs）。开发态允许 `--stdio` 之外的
  `--socket <path>` 调试变体（同一协议，便于 `node` 侧独立测试）。
- dsh 实例与控制面关系完全不变（05 §7.5：`PlaneHandle.startLocal()`
  预启动、按需 spawn、reaper）；**迁移后 dsh 子进程的 node = sidecar
  自身可执行文件**（spawn-dsh 纯 Node 分支，§4.3）。

### 3.2 仓库落位（待 §10 决策 4 定稿；本文按推荐）

```
macos/                          # SwiftPM 可执行包（或 xcodeproj）
  Package.swift
  Sources/DSHChamberApp/…        # AppKit 壳（AppDelegate、窗口、WKWebView）
  Sources/DSHChamberBridge/…     # A 桥 shim 注入与消息处理、B 桥客户端、manifest
  Sources/DSHChamberEdges/…      # 通知/角标/托盘/深链/open-in/对话框/更新/登录项
  Sources/Generated/BridgeManifest.swift   # 由构建脚本生成，不手写
  Tests/…                        # XCTest（信封解析、护栏、监督、协议）
  Resources/                     # 运行时占位（sidecar 由构建脚本拷入）
scripts/build-swift-app.mjs      # 调 pnpm 产物 + swift build + 资源装配
scripts/emit-bridge-manifest.mjs # IPC 通道 manifest → Swift 代码（§4.4.3）
```

sidecar 的 JS 面不动仓库布局：`packages/desktop` 继续是双 flavor 的宿主
（Electron entry `main.ts` 保留；新增 `sidecar-entry.ts` 及其 host-edge
适配，§4.1），打包脚本复用 `build-control-plane.mjs`（tsc project）的模式
新增 `tsconfig.sidecar.build.json`。

### 3.3 启动序列（状态机）

1. Swift `applicationDidFinishLaunching`：解析 argv/深链 → 计算 userData
   dir（§6.1）→ **目录锁**（§6.3）→ 启动 SidecarSupervisor。
2. Supervisor：spawn `node sidecar.js`；sidecar 自行完成今日 main.ts 的
   启动职责（single-instance 检查在壳层做，见 §5.4；目录锁在 sidecar 内
   复验并持锁）→ `createControlPlane`（port 从 17500 起试，05 现状）→
   pre-spawn 本地实例 → 输出 `ready {port, version, dshVersion,…}` 帧。
3. Swift 收到 ready → 用 `http://127.0.0.1:<port>/` 建 WKWebView 并
   loadURL（A 桥注入先于任何页面脚本）。
4. 运行时故障分级：sidecar 崩溃 → Supervisor 按 `restartBackoff`（同
   今日 renderer 恢复的 5×500ms 有界语义类比）重启；WebView 进程终止 →
   `webViewWebContentProcessDidTerminate` 恢复循环（对照
   `installRendererRecovery`，重复崩溃 → NSAlert 停止自动恢复，与
   `dialog.showErrorBox('前端异常'…)` 文案同义）；二者都对齐今日 quit
   状态机语义（D2：退出确认、will-quit 回收顺序：传输层 → 控制面 →
   本地 dsh 实例），Swift 侧实现 `applicationShouldTerminate` 复刻
   before-quit/will-quit 链（含"本地实例在跑且需确认时弹 NSAlert"）。
5. SIGTERM/SIGINT：Swift 捕获后转 `terminate` 优雅路径；sidecar 自身也
   处理信号（纯 Node 下 `process.on('SIGTERM')` 真实可达——不再像
   Electron 43 那样是死代码，需要显式转优雅回收，见 main.ts 该处注释）。

## 4. 复用与拆分（核心工程）

### 4.1 main.ts 拆分：core / host-edge 契约（P1，Electron 版不回归）

现状：`main.ts`（5802 行）把 ① 业务装配（transport/gateway/runtime/
plugin/settings/audit/journals/凭据事务/通知裁决队列/深链 intent 队列）与
② Electron 边沿调用（窗口、Notification、shell.*、dialog.*、safeStorage、
powerMonitor、tray、badge、ipcMain 收发）交织在一起。P1 拆分原则：
**只做搬运与参数化，不改语义、不重排状态机**。

目标形态：

- `shell-core.ts`（新，Electron-free）：从 main.ts 原样搬入
  - 全部业务装配与 60 个 invoke 处理器体 + 8 个事件源（语义校验原地保留）；
  - 退出状态机、深链 intent 队列、通知 click 队列/去重（这些是纯逻辑，
    现只依赖少量"宿主布尔"回调，如 `readNotificationHostBoolean`）；
  - 依赖注入面 `HostEdges`（下述），全部以函数/接口注入，与今日
    `readNotificationHostBoolean(…)` 模式同构——**该 seam 已存在**，只需
    补齐其余边沿（badge 平台门、通知显示、外部打开、对话框、唤醒事件、
    托盘存在性、keep-awake 断言、登录项、单实例仲裁结果）。
- `electron-edges.ts`（Electron flavor 适配）：把 HostEdges 接到
  Electron API（即今日 main.ts 中 ② 的全部调用点，原样搬迁）；
  `main.ts` 变薄壳：装配 `shell-core + electron-edges`。
- `node-edges.ts`（Swift flavor 适配）：HostEdges 接到 B 桥（Swift 执行
  边沿，sidecar 发 `edge:request`、收 `edge:response/notify`）。

判定标准：core 目录对 `electron` 零 import（用与 control-plane-module.ts
相同的 import 纪律测试或 lint 门禁）；Electron 版全部桌面测试继续绿
（含 `ipc-surface-mirror`、`renderer-trust`、连接/会话/通知/深链套件）。

HostEdges 接口草案（字段名以实施时定稿为准，语义与今日一一对应）：

```ts
interface HostEdges {
  showNativeNotification(n: NativeNotificationSpec): void   // 现状 main.ts 972 行构造点
  notificationSupported(): boolean                          // Notification.isSupported
  notifyClicked(openIntent: NotificationOpenIntent): void   // → sidecar 通知队列消费
  setBadge(count: number): boolean                          // 平台门 + setBadgeCount
  trayAvailable(): boolean                                  // 关窗隐藏判定（mac 恒 true）
  setKeepAwake(on: boolean): void                           // powerSaveBlocker 语义
  onSystemResume(cb: (ts: number) => void): void            // 补发 heldResume 语义在 core
  openExternal(url: string): Promise<void>                  // shell.openExternal（含白名单判定留 core）
  openPath(p: string): Promise<void>                        // shell.openPath
  showItemInFolder(p: string): void                         // shell.showItemInFolder
  launchApp(appId: string, path: string): Promise<boolean>  // open-in 原生拉起（§5.5）
  pickDirectory(): Promise<string | null>                   // desktop_pick_directory
  pickFiles(opts): Promise<string[] | null>                 // archive 管理器 file+folder（24）
  showError(title: string, detail: string): void            // showErrorBox
  showMessage(opts): Promise<buttonId>                      // showMessageBox（退出确认等）
  setLoginItem(enabled: boolean): void                      // 14 D-*
  isFocused(): boolean                                      // 通知裁决用
}
```

### 4.2 复用清单（现状核实）

| 资产 | 规模（非测试行） | Electron | 去向 |
|---|---|---|---|
| control-plane（含 proxy/ws/静态伺服/seed/reaper） | 12.1k | 无 | sidecar 原样（编译产物复用 build-control-plane 模式） |
| dsh-runtime | 11.4k | 无 | sidecar 原样 |
| transport-manager / ssh-provider / gateway-provider / gateway-session(+refresh) / plugin-sync / connection-save / ssh-config / plugin-tarball / notifications(裁决) / deep-link(解析) / audit-log / badge(裁决) / chamber-settings / dsh-runtime-controller / apply-now / disk-evidence / 凭据文件事务族 | ~21k | 无 | core 原样 |
| open-in（分类/校验）+ 原生拉起 | 纯逻辑 | 拉起点在 main | 逻辑进 core；拉起走 HostEdges.launchApp |
| notifications.ts `showNativeNotificationHonestly` 的宿主执行 | — | main 注入 | HostEdges.showNativeNotification |
| main.ts 其余编排 + preload + updater + 窗口/菜单/托盘/dialog 直用点 | ~7.9k | 全部 | P1 拆分；updater 走 §7 |
| ipc-events.ts IPC_CHANNELS + ipc-surface-mirror 测试 | — | — | **manifest 单源**（§4.4.3），不动 |

### 4.3 Node 运行时分发（sidecar 的运行时底座）

- **捆绑**：fetch 固定版本官方 Node（arm64 + x86_64，或按 §10 决策 6
  决定单一架构/universal），SHA-256 校验后进 `.app/Contents/Resources/
  sidecar/node`。签名/公证时按惯例排除 runtime 签名问题（对照
  summer-521 fetch-node.sh / luochenw prepare-dsh-runtime.sh 的既有做法）。
- **为什么必须绑 Node**：dsh 实例本身是 Node 进程（vendor dsh 以 npm
  包形态由 pnpm 安装），控制面 spawn 它、dsh-runtime 安装它——Swift
  壳无论如何绕不开。捆绑后可复用 spawn-dsh 的纯 Node 分支
  （`process.versions.electron` 不存在 → `file: process.execPath`），
  **零改动**；pnpm 11.21.0 已随 desktop 依赖，改由 sidecar 目录内嵌
  （现 electron-builder extraResources 的做法平移）。
- Node 版本策略：与 desktop 的 Electron 内置 Node 大版本对齐或取 LTS，
  决策 6。

### 4.4 桥接设计（本方案的信任核心）

#### 4.4.1 A 桥（web ↔ Swift，preload 等价物）

- Electron preload 的职责：`contextBridge.exposeInMainWorld('dshChamber',
  {…13 个命名空间…})` + invoke 包装 + 事件订阅。Swift 侧没有 contextBridge；
  注入一个 **`chamber-bridge.js`**（WKUserScript，.page world、
  documentStart）在页面脚本前定义同形 API：

  - 方法面：按 manifest 生成 `dshChamber.<ns>.<method>(args)` →
    `window.webkit.messageHandlers.dshChamber.postMessage({id, method,
    payload})`，以 `id` 关联回调 Promise（含 `info` 的启动重试语义：
    preload 现有 10×50ms 重试照搬进 shim）。
  - 事件面：manifest 的 8 个 push 事件 → shim 维护订阅表，Swift 侧
    `evaluateJavaScript("__dshChamberEmit(event,payload)")` 派发（通道
    名与载荷结构以 IPC_CHANNELS/05 §7.4 为权威）。
  - 防护：`Object.defineProperty` 非可配置挂载防页面覆盖；消息体
    `{id,method,payload}` 扁平信封（method 为通道名本身，Swift 不做
    语义理解，只做护栏——语义校验在 sidecar，与今日一致）。
- Swift 端 `WKScriptMessageHandler` 护栏（**只做传输层，不复制业务
  校验**）：
  1. 消息必须来自主 frame（`WKScriptMessage.frameInfo.isMainFrame`）；
  2. `webView.url` 解析后 origin === 当前控制面 origin
     `http://127.0.0.1:<port>`（对照 `isTrustedRendererUrl`；端口只在
     ready 帧后放开，天然满足"先 ready 后放行"）；
  3. 信封结构/尺寸上限（如 ≤4 MiB）、method 必须命中 manifest 通道白名单；
  4. 不响应任何"新窗口/导航"意图（WKUIDelegate 建窗返回 nil +
   `decidePolicyFor` 阻断离开 origin，外链交 NSWorkspace——复刻
   `setWindowOpenHandler`/`will-navigate`/`will-redirect` 三段护栏）。
- 语义校验（payload schema、来源指纹、generation、ACK 队列……）**全部
  留在 sidecar 原处理器**——这是"零重写"与"信任不弱化"的交点。

#### 4.4.2 B 桥（Swift ↔ sidecar，进程内本机受信通道）

- 传输：sidecar stdin/stdout 的行式 JSON-RPC（NDJSON）；stderr 独立为
  日志。Swift 是客户端，sidecar 是服务端（与 gateway 形态方向相反，
  但信封可复用 rpc-envelope.ts 的 buildClientRequest/parseServerResponse
  语义——**注意**：那是实例 RPC 协议，B 桥信封独立定义，仅借鉴其
  64KiB→上限与 id 纪律）。
- 信封（草案，实施定稿）：`{id, method, payload}` 请求 /
  `{id, ok, result|error}` 响应 / `{event, payload}` 单向推送 /
  `edge:*` 是 sidecar→Swift 的 HostEdge 请求（Swift 执行后回响应）；
  id 单调、无并发上限默认 1（Swift 串行 dispatch 到主队列）。
- 护栏：Swift 只接受自己 spawn 的进程 fd；帧长上限与超时；sidecar
  写 stdout 的任何非协议输出（console.log 泄漏）由 Swift 侧
  fail-loud（协议帧校验），stderr 为唯一日志通道——与现桌面一致地把
  日志与协议分开。
- 推送事件经 B 桥原样到 Swift → A 桥 emit，**事件名清单 = manifest**。

#### 4.4.3 通道 manifest（防双份漂移）

- 单源：`IPC_CHANNELS`（ipc-events.ts）+ preload 的 invoke/on 字面量集
  （现有 `ipc-surface-mirror.test.ts` 已断言两侧相等）。新增
  `scripts/emit-bridge-manifest.mjs`：解析两侧 → 产出
  `bridge-manifest.json`（通道名 + 方向 + 归属命名空间）→ Swift 构建期
  生成 `BridgeManifest.swift`（枚举 + 白名单常量）。新增
  `bridge-manifest.test.ts` 断言"生成物 == 提交物"，通道增删改必须在
  同一 PR 提交新 manifest——三侧（main/preload/Swift）永不漂移。

### 4.5 通知点击与深链去重语义（design 19 §3.3 / 16 §4.2 的宿主移植）

- 通知 click：sidecar 的 `pendingNotificationOpens` 有界 ACK 队列与
  `BoundedActiveNotifications`（持 Notification 引用防 GC 吞 click）留在
  core；HostEdges.showNativeNotification 返回"点击回调"绑定：Swift 侧
  `UNUserNotificationCenterDelegate` 收到 click → 回 B 桥
  `notification-clicked(payload)` → core 走原队列/去重/重发逻辑；窗口
  重建竞态兜底（did-start-loading 重发语义）由 Swift 在
  `didStartProvisionalNavigation` 时通知 core（等价事件点）。
- 深链：Swift `application(_:open:)`（冷启动先于 ready → Swift 暂存，
  ready 后按序转交）→ B 桥 `deep-link(url)` → core `enqueueDeepLink`
  原逻辑（归一化去重、VS Code intent、proof 队列不动）；macOS
  无 argv 扫描路径（LauncherServices 已接管），Win/Linux 的
  second-instance argv 扫描仅 Electron flavor 保留。

## 5. 原生边沿逐项设计（Electron → Swift 映射）

| # | Electron 现状（main.ts/…） | Swift 对应 | 备注 |
|---|---|---|---|
| E1 | `BrowserWindow` + `loadURL` + hide-to-tray/close 语义 | `NSWindow` + `WKWebView`；`windowShouldClose` 按 14 D1（hide 而非关；mac Dock 恒为恢复入口 → `orderOut`），真正退出走 E12 | 关窗隐藏/恢复、重建窗口只允许单窗 |
| E2 | `Tray`（打包态，resources/icon.png） | v1：mac 用 Dock 常驻即可，`trayAvailable()=true`；可选 NSStatusItem（菜单：显示窗口/退出） | 镜像现状：托盘缺失回退关窗即退（mac 不会缺） |
| E3 | 菜单（Menu 模板：编辑剪贴板等） | NSMenu 标准菜单 + Edit 项（copy/paste/selectAll 走 first responder → WKWebView） | 缺菜单会丢 Cmd+C/V/全选，**必须做**（验证项 W2） |
| E4 | `Notification` + `Notification.isSupported` | `UNUserNotificationCenter`；授权请求时机与今日一致（有授权才 show） | bundle id 改变 → 授权重置提示（§6.2/风险 R4） |
| E5 | `app.setBadgeCount`（平台门 + badgeEnabled 裁决在 core） | `NSApp.dockTile.badgeLabel`（count>0 → String(count)，0 → nil） | 门控逻辑留 core（badge.ts） |
| E6 | `powerMonitor.on('resume')` + held lastResume 补发 | `NSWorkspace.didWakeNotification` → B 桥 → core 补发语义原样 | 推送 `dsh-chamber:system-resume {timestamp}` |
| E7 | `powerSaveBlocker`（keep-awake 断言） | `ProcessInfo.beginActivity(.idleSystemSleepDisabled…)` 或 IOKit 断言 | 触发条件随 core 状态机原样（网关会话保持等，14） |
| E8 | `dialog.showOpenDialog`（pick dir / archive file+folder） | `NSOpenPanel`（canChooseDirectories 等，macOS-v1 对话框语义 24） | A 桥 invoke → B 桥 edge → panel → 回传 |
| E9 | `dialog.showErrorBox/showMessageBox`（fatal 启动/前端崩溃/退出确认 D2） | `NSAlert`（sheet 或 app-modal） | 退出确认（本地实例在跑）语义照搬 before-quit 链 |
| E10 | `shell.openExternal`（外链/发布页/`openVscodeUrl`） | `NSWorkspace.shared.open(URL)`（URL 规范化与白名单判定在 core，见 main.ts 1279 行注释纪律） | open-release 亦此 |
| E11 | `shell.openPath/showItemInFolder` | NSWorkspace `open(_:)` / `NSWorkspace.activateFileViewerSelecting` | open-in 失败模式（Win/Linux reject 路径）mac 侧照搬语义 |
| E12 | open-in 拉起 Finder/VS Code/应用 | `NSWorkspace`：按 bundle id/path 启动 + `activate`；`launchApp` 走 HostEdges | 现有 `open-in.test.ts` 纯逻辑测试继续覆盖分类/校验，原生拉起为薄适配 |
| E13 | 深链注册（打包态 `dsh-chamber://`） | Info.plist `CFBundleURLTypes` + `application(_:open:)` | 冷/热启动入队语义见 §4.5 |
| E14 | `app.setLoginItemSettings(openAtLogin)` | macOS 13+ `SMAppService.mainApp`；旧系统 NSLoginItem 兜底 | 设置面语义不变（14） |
| E15 | `safeStorage`（gateway-secrets v3） | **不移植**：Swift flavor 走既有"诚实 0600 明文"回退（范围决策已批准的 S22 例外非 win32），旧 safeStorage 密文按"不可解密 → 保留禁用待重录"语义处理（§6.4） | 若需更强静态加密 → 决策 7（Keychain 协助加解密 edge） |
| E16 | `session.setPermissionRequestHandler/Check`（clipboard-sanitized-write） | WebKit 无同 API；剪贴板写不需要弹窗（仅读需授权） | **验证项 W1**：dsh 富文本复制/粘贴实测 |
| E17 | `crashReporter.start` | 不移植（macOS 崩溃报告原生）；sidecar 崩溃走 Supervisor 日志 | — |
| E18 | `requestSingleInstanceLock`/second-instance | `NSRunningApplication` 或锁文件二次激活（bundle id 相同时 LaunchServices 已保证） | 双 flavor 互斥见 §6.3 |
| E19 | renderer 崩溃恢复（installRendererRecovery） | `webViewWebContentProcessDidTerminate` + 有界重载 + NSAlert | 语义照搬（§3.3 4） |
| E20 | `app.on('activate'/'window-all-closed')` | `applicationShouldHandleReopen` 等标准生命周期 | 14 D1 语义 |

## 6. 数据、状态兼容与共存

### 6.1 userData 目录

- Electron 版实际根 = `~/Library/Application Support/dsh-chamber`
  （electron-builder productName；实施前以实机确认，验证项 E2）。Swift
  版默认**同根**：全部相对路径来自 main.ts 中 `app.getPath('userData')`
  直拼点（chamber-settings.json、ssh-instances.json、ssh-passwords.json、
  gateway-secrets.json、audit-log.jsonl、state/、dsh 运行时树），sidecar
  以 `--user-data-dir` 参数接收同一根，**内部零改动**。

### 6.2 bundle id 与双 flavor 共存

- Swift 版新 bundle id（推荐 `com.dshchamber.native`；决策 2）：与
  Electron 版（`com.dshchamber.desktop`）区分是硬前提——同 id 会导致
  LaunchServices/通知身份互相顶替。代价：通知授权按新 id 重新请求
  （风险 R4，UX 文案说明）。
- 不迁移既有目录（避免任何改写/降级风险）；旧 id 的授权与状态原样保留。

### 6.3 互斥与单实例

- 同一 userData 根**绝不允许 Electron 版与 Swift 版并发**（registry/
  凭据事务/runtime 树无跨进程锁，STATUS「多控制面无跨进程 CAS」登记）。
  在根目录持 **advisory 锁文件**（owner pid + 启动时间；读取前 no-follow/
  inode 检查 + stale 判定，沿用 owner-only-secret-file/private-file 纪律）；
  锁被占 → 弹"另一版本正在运行"并退出。锁在 Swift 侧先取（快），sidecar
  启动后再复验（防竞态），生命周期归 Supervisor 释放。

### 6.4 凭据与安全文件

- SSH 密码镜像（ssh-passwords.json v2）：本来就是 endpoint-bound 0600
  明文（2026-08 用户决策），Swift flavor 语义不变。
- gateway-secrets（v3，safeStorage|plaintext 判别）：Swift flavor 无
  safeStorage → 新写一律 plaintext 判别 + 0600 原子写（既有诚实回退）；
  读旧 safeStorage 判别条目 → 解密不可用 → **保留文件与绑定、标记禁用待
  重录**（复用"legacy 保留禁用"既有语义；实施时补该判别路径的单测 E1）。
- 若用户希望静态加密，走决策 7：HostEdges 加 `encrypt/decrypt`（Swift
  Keychain 持随机文件密钥，sidecar 用 node crypto AES-GCM），gateway-secrets
  判别器加新值。v1 不排期。

## 7. 更新（design 11 的 Swift 侧形态）

- Electron 版维持 electron-updater（GitHub provider、zip target）不动。
- Swift 版 v1：**诚实降级**——`dsh-chamber:update-state` 只报
  `idle|error` 语义的可用性；`update-check`/`update-download` 合并为
  "检查并打开发布页"（HostEdges.openExternal 到 GitHub Releases），
  `update-restart` 返回"本版本不支持自动安装"的明确错误（绝不做静默
  假安装）；设置 UI 的更新行文案按"打开发布页"呈现。理由：避免 v1 引入
  自更新签名/回滚的整面新风险。
- v2（P3 末，决策 3）：Sparkle（对照 summer-521 appcast 先例）——发布
  CI 在打 dmg/zip 时生成 appcast.xml（现 electron-builder 已出 dmg+zip），
  Swift 版订阅同一 GitHub Releases；Sparkle 的 EdDSA 签名密钥独立于
  Electron 侧。v2 落地前完成状态机与 settings UI 文案的对拍。

## 8. 实施阶段、测试与验收

### 8.1 P0 POC（1–2 人周）——先证伪再立项

1. `macos/` 最小壳：WKWebView 加载**现成 Electron 版启动的控制面**
   （dev 模式共用：先起 Electron 或 node standalone 控制面拿 port）。
2. 手写 shim 接通 3 个通道：`info`、`desktop_ssh_instances_get`、
   `desktop_ssh_connect/status` 推送；通知 click 回 core 语义打桩。
3. 验收门（全过才继续）：
   - G1 主界面（多实例/会话/设置页）在 WebKit 渲染无功能缺口；
   - G2 剪贴板复制粘贴、文件拖拽（附件/archive 对话框入口）、外链跳转；
   - G3 侧栏插件（git/open-in/settings-bridge）可用；
   - G4 深链冷启动不丢、通知点击可激活会话；
   - G5 退出/隐藏/唤醒补发语义与 Electron 版一致（目测 + 脚本断言）。
   任何一项失败 → 回到本文档重审路线（§10 决策 1）。

### 8.2 P1 core 拆分（2–3 人周，Electron 不回归）

- §4.1 拆分 + HostEdges 全量定义；Electron 版跑全量测试（desktop 全部
  `pnpm --filter @dsh-chamber/desktop run test` + renderer + control-plane
  相关套件）作为门禁；core 对 electron 的 import 零容忍（CI lint）。
- 产出 `sidecar-entry.ts`（Swift flavor 装配）+ `node-edges.ts`；
  sidecar 可在纯 Node 下以"假 Swift"驱动（`stdio-driver.ts` 测试用具）
  跑通全量 60 通道冒烟——**在写任何 Swift 前先把 B 桥协议用现有 JS
  测试资产钉住**。

### 8.3 P2 Swift 壳 v1（3–4 人周）

- E1–E20 按 §5 实现（v1 覆盖 E1–E14、E16–E20；E15 走 §6.4）；manifest
  生成与护栏；Supervisor 与启动序列（§3.3）；A 桥 shim 全通道对拍。
- 双端冒烟：借鉴 summer-521 的 `swift-*-harness.swift` +
  `*.integration.test.js` 模式——Swift 壳以测试 harness 身份被 node 集成
  测试拉起，断言真实窗口/桥行为（`loopback-http-test-server.ts` 先例
  同款思路）。

### 8.4 P3 边沿完整 + 发布管线（2–3 人周）

- v2 更新（Sparkle，或按决策 3 维持 v1 形态）；打包脚本（§3.2 落位 +
  pnpm 产物装配）；Xcode 工程/CI：GitHub Actions macOS runner 跑
  `swift build` + XCTest + 打包 + ad-hoc/Developer ID 签名与 notarize
  （STATUS 已登记 mac 正式发布缺 Apple 凭据会阻断——Swift 版同此门禁）；
  图标/资源复用（现有 icon.icns 平移）。

### 8.5 P4 实机门禁矩阵（1–2 人周）

逐项走查（对照 STATUS 既有清单风格登记残余）：打包态全链（控制面起动/
本地实例预启动/连接/网关凭据重录/运行时版本管理与回退/插件同步/归档
对话框/通知点击/深链/隐藏恢复/唤醒补发/退出确认）；WKWebView parity
清单（W1 剪贴板、W2 菜单快捷键、W3 富文本粘贴与拖拽、W4 打印/查找、
W5 WebKit 下字体/滚动/IME、W6 后台节流对 SSE/WS 的影响）；性能基线对照
`docs/progress/performance-baseline.md`（启动、内存、会话切换）。

### 8.6 测试策略汇总

| 层 | 内容 | 现状 |
|---|---|---|
| JS 业务 | desktop/control-plane/runtime 现有单测与镜像测试 | **原样复用**（P1 后依旧跑同一文件集） |
| B 桥 | 信封/帧长/超时/乱序/edge 往返——node 侧用 stdio-driver，Swift 侧 XCTest | 新增 |
| A 桥/护栏 | shim 与 manifest 一致性（bridge-manifest.test.ts）、origin 门、尺寸门 | 新增 |
| 集成 | node 集成测试拉起 Swift harness 断言真实窗口/通知/深链 | 新增（照 summer-521 模式） |
| 实机 | §8.5 矩阵 | 新增，发布前执行 |

## 9. 风险与开放问题

- R1 **双业务源码漂移**：core 拆分后 Electron 版若独立演进，Swift 版
  会滞后。缓解：单 repo 单 core；host-edge 契约评审门禁；
  `ipc-surface-mirror` + `bridge-manifest` 双锁步测试；发布时双 flavor
  同 tag。
- R2 **WKWebView 差异**（对应验证项 W1–W6）：无 Chromium 渲染引擎、
  权限模型不同、devtools 用 WebKit inspector（debug 构建开
  `developerExtrasEnabled`）。P0 先行证伪。
- R3 **Node 捆绑与架构**：arm64/x86_64 双架构 × 两 flavor 的 CI 成本；
  universal2 或按机器下载的取舍（决策 6）。
- R4 **通知授权身份变更**：新 bundle id → 用户需重新授权通知；升级文案
  与首次授权时机照搬现逻辑。
- R5 **目录并发互斥**：advisory 锁的 stale 判定与三方 takeover 对抗
  （STATUS 已记录此类坑）；锁实现必须 no-follow + inode + owner 校验。
- R6 **旧 safeStorage 密文迁移**：Swift flavor 首启即遇旧 gateway
  凭据不可解密——语义按 §6.4"保留禁用待重录"，UI 文案明确原因。
- R7 **Swift 代码面安全评审**：桥护栏（§4.4）是新信任边界；护栏规则
  需要独立评审与负例测试（伪造 frame/超大帧/非协议流/伪造事件名）。
- R8 **更新双轨**：v1 无自动安装是**有意**降级，设置 UI 文案必须诚实
  （绝不做假状态）；Sparkle 密钥/回滚策略在 v2 单独评审。
- R9 维护负担：Swift 壳新增一门语言/一条 macOS CI；对照参考仓库实证，
  壳+桥（非 UI）单飞可行，但需有人持续负责 Swift 侧。

## 10. 待用户决策清单（立项输入）

1. **路线确认与 P0 先行**：是否按路线 A 启动 P0（1–2 周 POC）？P0 任一
   验证项失败即回到路线评估。
2. **双壳共存形态**：Swift 版与 Electron 版长期共存（各自发布）还是
   macOS 上替换（Electron mac 停更）？推荐**共存**（共享 core、共享 CI
   门禁，mac 用户二选一），bundle id `com.dshchamber.native` 立项即定。
3. **更新路线**：v1 打开发布页 → v2 Sparkle（推荐）；或 v1 直接 Sparkle。
4. **仓库落位**：`macos/`（SwiftPM，推荐）vs `packages/swift-shell`。
5. **原生 UI 渐进**（路线 B/C）：本文不覆盖；若后续要把设置/连接管理等
   高频面 Swift 化，需按 §4.1 的 HostEdges 边界另立设计（防止边沿越界）。
6. **Node 版本与架构**：与 Electron 43 内置 Node 对齐 vs LTS；
   arm64-only vs universal2。
7. **静态凭据加密**：v1 走诚实 0600 明文（推荐）；或提前排 Keychain
   协助加密 edge。
