# 14 · 睡眠/后台常驻：窗口收起而 dsh 继续运行（已实现（v1 范围），2026-08）

> **状态：已实现（v1 范围，2026-08）——设计见本文；实现基线以 git 历史与
> CHANGELOG 为准**。需求来源：让 dsh-chamber「睡眠」（窗口
> 隐藏/后台）时，**本地 dsh 实例、远程隧道、控制面全部继续运行**——长时间
> 任务进行中收起窗口不被中断；OS 睡眠唤醒后快速恢复；登录自启后台常驻
> （可选）。本文先给出 **OpenChamber 桌面端实现调研**（外部参考，本地源码
> `/Users/panzeyu2013/Desktop/code/develop/OpenChamber`），再给出 dsh-chamber
> 的移植设计。

---

## 1. 现状对照（dsh-chamber）

| 项 | 现状 | 证据 |
|---|---|---|
| 关窗行为 | **non-darwin 关窗即退出**：`window-all-closed` → `app.quit()` → `will-quit` → `transportManager.disposeAsync()` + `controlPlane.stop()`——本地 dsh 实例与全部远程隧道**一次性终止** | `packages/desktop/main.ts`（关窗分支接线，见 §3.1 实现清单） |
| macOS 关窗 | 关窗不退出（darwin 惯例），应用**无窗常驻**，`activate`/`second-instance` 重建窗口 | `main.ts`（`showMainWindow()`，§3.1 实现清单） |
| 托盘 | 打包态防御式最小托盘：tooltip + 「显示窗口/退出」，无状态投影、无设置 | `main.ts`（`maybeCreateTray`） |
| 唤醒/防休眠 | 无 `powerMonitor` / `powerSaveBlocker` 任何处理 | `main.ts` 全量 |
| 后台启动 | 无 `--background` / 登录自启 | `main.ts` 全量 |
| 退出保护 | 无退出确认（活动隧道/实例直接被杀） | `main.ts` `will-quit` |
| 断链恢复 | **已具备**：transport-manager jittered 指数退避重连 + 慢速重探（隧道断线自动恢复）；dsh-client-connection 原生 connect/pump/reconnect 循环（SSE 断线自动重连） | `transport-manager.ts`（重连状态机）；`dsh-client-connection/src/client/connection.ts`（connect/pump/reconnect） |

**结论**：断链自愈机制已存在；缺的是**「窗口生命周期不杀进程」**（关窗 =
hide 而非 quit/destroy）、**「唤醒即时重连」**（powerMonitor resume）、以及
可选的**防休眠 / 后台启动 / 退出保护**。dsh-chamber 的进程拓扑（控制面、
传输层、本地 dsh 子进程全部由 Electron 主进程持有）与 OpenChamber 同构，
可直接移植其模型。

## 2. OpenChamber 实现调研（外部参考）

> 源码：`/Users/panzeyu2013/Desktop/code/develop/OpenChamber/packages/electron/`
> （主进程）+ `packages/ui/`（渲染端）。OpenChamber 的「睡眠连带运行」由
> **四个机制**组成：

### 2.1 关闭到托盘（窗口 hide，进程全活）——核心机制

- 设置项 `desktopMinimizeToTrayEnabled`（win32/linux）；关窗事件里
  `shouldHideMainWindowToTray(browserWindow)` 为真 → `event.preventDefault();
  browserWindow.hide()`——**窗口只是隐藏，Electron 主进程 + 进程内 web 服务器
  + 其管理的 sidecar/SSH 子进程全部继续运行**（`main.mjs`）。
- macOS 关窗默认 hide（`window-all-closed` 在 darwin 直接 return）；
  Cmd+W/红点关窗不退出，Cmd+Q 才是退出（`before-quit` + 退出确认）。
- 窗口全部关闭后应用**保持运行**（托盘常驻），`activate`/`second-instance`/
  托盘点击 → `show()` + `focus()` 恢复。

### 2.2 托盘控制器（常驻入口 + 状态投影）

- `tray.mjs` `createTrayController`：idle / breath（呼吸动画）/ unseen 状态图标
  帧 + 会话/审批快照菜单；点击 → `onAction` 回调回主进程路由。
- 渲染端 `useTraySync.ts`：经 `desktop_tray_update` IPC 命令把**非秘密快照**
  （会话数、审批数、runtime key）推给主进程；托盘点击路由到**快照所属 runtime
  的窗口**（防会话 id 串台）。
- 托盘在 darwin/win32/linux 全部启用；macOS 菜单栏项默认开、可在 General 设置
  关闭（`main.mjs` / `electron/README.md`）。

### 2.3 后台启动（无窗口常驻，登录自启）

- `--background` 启动参数 + 登录项（`shouldStartInBackground`：argv 含该参数或
  `wasOpenedAtLogin`/`wasOpenedAsHidden`，`main.mjs`）。
- 无窗口启动时：进程内 web 服务器照常启动（`resolveInitialUrl` 等），
  `startupResolved` 置位；**窗口后开时重新探测远端**而非信任登录时刻的
  reachability。
- 登录自启：darwin/win32 `setLoginItemSettings`（带 `--background`）、Linux
  XDG autostart（`linux-autostart.mjs`）。

### 2.4 唤醒恢复 + 防休眠 + 退出保护

- **唤醒恢复**：`powerMonitor.on('resume')` → 广播 `openchamber:system-resume` →
  渲染端 event-pipeline（SSE 事件管线）监听该事件**立即重连**，无需等心跳
  看门狗超时（`main.mjs`；`packages/ui/src/sync/event-pipeline.ts`，
  另有 visibilitychange/online 兜底）。
- **防休眠**：`powerSaveBlocker.start('prevent-app-suspension')`（设置项
  `desktopKeepAwakeEnabled`，`setDesktopKeepAwakeActive`）。
- **退出保护**：`quitRisk`（活动隧道 / 运行中的定时任务）→ 退出确认对话框
  （"Quitting now will stop sidecar/background processes…"）；确认后
  `shutdownBackgroundServices`（kill sidecar + `sshManager.shutdownAll()`）；
  SIGINT/SIGTERM 硬信号同样走后台服务清理。
- 渲染设置面：General 设置页 `DesktopNetworkSettings.tsx`——keep-awake /
  minimize-to-tray / mac menu bar / launch-at-login / LAN access 开关，写
  app 自身配置（`/api/config/settings`）。

### 2.5 移植要点（差异）

OpenChamber 的 sidecar 与 web 服务器在**主进程内**（in-process server）；
dsh-chamber 的控制面同样是主进程内对象（`createControlPlane`），传输层与
dsh 子进程由主进程管理——**hide 窗口后无任何东西需要额外保活**，模型直接
成立。差异仅在：dsh-chamber 无「进程内服务器自启」（控制面由 `whenReady`
显式 start），无需 `startupResolved` 语义；dsh-chamber v1 不做会话级托盘
（会话业务是各实例前端 runtime 的，01 §5 / P2 纪律）。

## 3. 设计决策

### D1 关闭到托盘（v1 核心，跨平台一致）

- 新设置 `windowCloseBehavior`（**用户可设**，settings 壳固定入口「通用」
  `__general`，设计 15 平铺形态）：
  `hide-to-tray`（默认，关窗 → 托盘，dsh 继续运行）/ `quit`（关窗 = 退出应用，
  与现状行为一致）。
- 关窗分支（`browserWindow.on('close')`）：设置 = hide-to-tray 且非显式退出 →
  `event.preventDefault(); win.hide()`（不 destroy）；控制面/传输层/dsh 子进程
  继续运行。显式退出（托盘「退出」/ Cmd+Q / 应用菜单）走现有
  `will-quit` cleanup single-flight：先阻止新的 runtime 启动并中止在途 runtime
  operation，再并行等待 plugin-sync/本地插件子进程、transport、control-plane、
  runtime installer 与在途 runtime transaction；有界超时 fail-loud，不留下孤儿进程。
- 设置 = `quit` 时关窗仍受 D2 退出确认保护（本地实例运行中先确认再退出；
  远程隧道/连接不影响关闭——2026-08 修订，D2），
  非 darwin 行为与现状一致（关窗即退出）。
- 三平台一致：macOS/win/linux 同走 `windowCloseBehavior`；macOS 系统惯例
  （红点/Cmd+W = hide、Cmd+Q = 退出）在 hide-to-tray 语义下天然一致。
- **前置门控：hide-to-tray 仅在托盘可用时生效**（对齐 OpenChamber
  `shouldHideMainWindowToTray` 先检查 `state.trayController` 非空）：托盘缺失
  （dev 模式 `app.isPackaged=false` / 图标资源缺失 → `maybeCreateTray` 跳过）时，
  非 darwin 回退现状（关窗即退出，仍受 D2 确认保护）——**绝不允许窗口被隐藏后
  无任何恢复入口**。macOS 无托盘也安全（Dock 图标常驻可恢复，hide 是系统惯例）。
- **隐藏窗口不节流**：`createMainWindow` webPreferences 增加
  `backgroundThrottling: false`（对齐 OpenChamber main.mjs）——否则窗口
  隐藏后渲染进程计时器被 Chromium 节流（隐藏 5 分钟后钳制到 ~1 次/秒），
  D4 唤醒「立即重连」会被拖慢。仅 dsh-chamber 单窗口 + 控制面 origin + 无第三
  方内容，安全。
- `showMainWindow()` 保留：隐藏 ≠ 销毁，`activate` / `second-instance` /
  托盘点击 → `show()+focus()`；销毁后才走重建分支（现有逻辑已覆盖）。

### D2 退出确认（quitRisk 投影）

- **2026-08 修订（用户拍板）**：远程隧道**不影响关闭**——风险只看**本地实例**；
  且退出确认成为**可设置开关** `quitConfirmation`（默认开；关 → 永不确认）。
- 开关开启且**本地实例运行中**——判据 = 状态机 running（含 starting/
  restarting 在途态）**且实际有存活进程**（`localProcessAlive`，经控制面
  `hasLiveProcess`；状态字符串不是存活事实——restart 序列中 restarting 期间
  新进程尚未 spawn、死亡进程在下次探活前滞留 ready/degraded，2026-08 加固）
  → `dialog.showMessageBox` 确认：「退出将停止正在
  运行的本地 dsh 实例」。确认后走既有退出路径。
- 对齐 OpenChamber quitRisk；这是**唯一允许的退出确认对话框**，与设计 11
  「更新无弹窗」纪律不冲突（更新提示仍不弹窗）。
- **豁免：更新安装退出不确认**——updater 状态为 `downloaded` 且未
  install-blocked 时（设计 11 `autoInstallOnAppQuit`：用户已点过「更新」并被告知
  「退出时安装」），**跳过退出确认直接退出**（对齐 OpenChamber
  `if (state.installingUpdate) return;`），避免确认框阻塞/误导已确认的安装流程。
- **单飞**：`quitRequested` 标志置位后不再重复弹确认（防连点/双路径触发两次
  对话框）；异步 will-quit 清理也有独立 single-flight，第二次 quit 事件继续
  `preventDefault`，不能因首轮已把 controlPlane holder 清空而提前退出。
- renderer 崩溃/无响应恢复 timer 全部由窗口生命周期持有：新导航、恢复或窗口
  close 会清旧 timer，quit 在途禁止 reload/show/loadURL 失败路径复活窗口或重入
  teardown。

### D3 托盘增强（P1，可选）

- 状态 tooltip：`dsh-chamber · 控制面 http://127.0.0.1:<port> · <connectionState>
  · 连接 N/本地实例运行中`（非秘密投影，来自 transport-manager status push +
  control plane `/health`）。
- 菜单：显示窗口 / 退出（现状）+ 可选「N 个远程连接活动」只读行。
- 保持防御式构造（沿用 `maybeCreateTray` 的 try/catch 跳过语义：无图标资源/
  失败 → 跳过并日志，绝不阻塞启动）。
- **不做** OpenChamber 式会话级托盘（会话业务归各实例前端 runtime，P2 纪律）。

### D4 唤醒恢复（M2）

- 主进程 `powerMonitor.on('resume')` → 向主窗口 push `dsh-chamber:system-resume`
  → renderer chamber App 层分发 → ① 当前实例连接 runtime 立即重连
  （dsh-client-connection 原生 reconnect 兜底，事件只消除心跳等待延迟）；
  ② transport-manager 对 `phase=degraded/error` 的实例立即触发一轮 retry
  （替代等慢速重探），sleep 断掉的隧道秒级恢复。
- 无窗口常驻期间（托盘态）resume 事件由主进程持有，窗口恢复时一次性补发。

#### D4 扩展（2026-08，stuck-deep-diving 根因修复）

> 现象：合盖再打开后有概率向某 session 输入，前端卡在 "Deep diving..." 而
> 后端实际已在处理。根因：`events.mux`/`events.host` 是**无心跳的只读
> WebSocket**（宿主从不 ping；宿主 ws server 对任何客户端消息 1008 关闭
> "downlink only"），连接泵只在 close/error 时重连——睡眠/网络切换后半开 TCP
> 静默死亡不触发任何事件 → 前端"已连接但失明"，POST 照常成功、事件永不抵达。
> 补充两个互补机制（均不依赖 OS 事件必然触发）：
>
> 1. **渲染侧活性触发器**（`dsh-client-connection/src/client/liveness-triggers.ts`，
>    `attachLivenessTriggers`）：system-resume 之外增加 `online`（唤醒/网络恢复）
>    与 `visibilitychange→visible`（隐藏 ≥30s 后回前台；短 alt-tab 不触发）
>    触发 stop()+start() 立即重连；**最小重启间隔去抖，值代码级绑定
>    `CONNECTION_BACKOFF_MAX_MS`（10s）**（resume+online 同醒并发、online 抖动
>    合并为一次）。重连后 `handleConnected` 的 list 刷新 + resync 让卡死的
>    running 位收敛。
> 2. **控制面代理 WS 心跳，仅下游（浏览器）腿**（`control-plane/src/ws-frames.ts`
>    + `ws-heartbeat.ts`，RFC 6455 §5.5.2/§5.5.3）：splice 建立后向浏览器周期
>    发免掩码 ping（浏览器按 RFC 自动 pong，透明不上抛 app），`PongScanner`
>    被动扫描浏览器 data 流（不消费字节、不动 pipe）；**参数对齐 `ws` README
>    官方心跳示例（30s 间隔、一个周期未答即断）**→ tearDown → 浏览器 WS close
>    → 泵重连重基线（检出 ~30s）。**上游（宿主）腿刻意无心跳**：远程断隧由
>    SSH keepalive（`ServerAliveInterval=30 × CountMax=3` ≈90s，ssh-provider
>    已配）覆盖，本地宿主死亡/重启由 socket error/close 覆盖，宿主自身发送
>    失败即关——代理侧上游 ping 只会与 SSH keepalive 抢跑成"半开隧道上反复
>    重连"的抖动环（严格容忍）或比它更晚（宽松容忍=无用）。

### D5 keep-awake（v1 设置项，默认关）

- `powerSaveBlocker.start('prevent-app-suspension')`；settings 壳「通用」入口
  开关（设计 15）；退出/停用时 stop。仅防应用挂起，不阻止显示器关闭，不引入
  后台任务。

### D6 登录自启（v1 设置项）+ 后台启动（v1 不做）

- 新设置 `launchAtLogin`（**用户可设**，settings 壳「通用」入口）：登录时自动
  启动 dsh-chamber（**开窗**启动；v1 不做无窗口后台启动）。
- 实现：macOS `app.setLoginItemSettings({ openAtLogin })`；Linux 写 XDG
  autostart `.desktop`（对齐 OpenChamber `linux-autostart.mjs` 形态）；
  **Windows 首版门控**（`supported=false` 置灰并说明，与 STATUS「Windows
  首版支持暂缓」一致）。
- `--background` 无窗口后台启动（对齐 OpenChamber `shouldStartInBackground`）
  **v1 明确不做**：登录自启 = 开窗启动；「无窗口常驻」由「关窗到托盘」覆盖。

### D7 设置存储与权威边界

- 全部 chamber 级运行设置 → 主进程新 **`<userData>/chamber-settings.json`**
  （原子写、0600、非秘密；`dsh-chamber:settings-get/set` IPC + 变更 push）。
- **绝不进任何实例的 dsh home**（01 §2 P2：每实例配置平面权威，控制面只
  透传；chamber 设置是 app 级，与实例配置平面不相交）。
- 不新增依赖：`powerMonitor` / `powerSaveBlocker` / `Tray` 均为 Electron 内置。

## 4. 改动清单

| 面 | 改动 |
|---|---|
| `packages/desktop/main.ts` | 关窗分支（hide vs quit，**托盘可用门控**）；`backgroundThrottling: false`；`powerMonitor.on('resume')` → push；`powerSaveBlocker`；退出确认（仅本地实例实际 live process，远程隧道/连接不影响关闭；**含更新安装豁免 + 单飞**）；will-quit single-flight 并行等待 plugin-sync/本地插件子进程、transport、control-plane 与 runtime 工作；`chamber-settings.json` store + `dsh-chamber:settings-get/set` IPC + push |
| `packages/desktop/preload.cts` | `settings` 面（get/set/onChanged，覆盖 windowCloseBehavior / launchAtLogin / keepAwake）+ `systemResume` 订阅；`DshChamberBridge` 扩展 |
| `packages/renderer` | App 层订阅 system-resume → 分发实例重连 + transport 即时重探 |
| settings-bridge 壳 | 「通用」视图（见设计 15：固定入口 `__general` 平铺） |
| 测试 | `test:desktop`（关窗行为/退出确认/设置 store 单测扩展）、`typecheck`、`build:renderer` |
| 控制面 | **无改动**（loopback-only 不变，契约不动） |

## 5. 安全与纪律

- 无新秘密面：托盘/设置只投影非秘密状态（连接数/phase/版本）；传输 URL、私钥与
  代理配置永不进 renderer，密码只有表单瞬时 write-only 输入且绝不返回/回填
  （05 §8 不变）。
- close-to-tray **不改变 will-quit 清理所有权**：退出完整 dispose plugin-sync/
  本地插件子进程、传输层、控制面及 runtime 工作，不留孤儿 pack/install、隧道、
  installer 或 dsh 子进程。
- keep-awake 仅 prevent-app-suspension，无后台执行面。
- 退出确认是唯一新增 dialog，与 01 §4 移出项（notifications 等）无冲突。

## 6. 分期与 v1 范围

**v1 范围（定稿）**：`windowCloseBehavior`（hide-to-tray 默认 / quit，可设）、
`launchAtLogin`（可设；mac/linux，win 门控）、关窗到托盘 + 托盘显示/退出、
退出确认、`chamber-settings.json` store + IPC、唤醒即时重连（powerMonitor
resume）、keep-awake 设置项（默认关）。
**v1 不做**：`--background` 无窗口后台启动；会话级托盘（P2 纪律）。

- **M1（核心）**：close-to-tray + 托盘显示/退出 + 退出确认 +
  `chamber-settings.json` store（`windowCloseBehavior`）+ 「通用」设置视图。
- **M2（唤醒与防休眠）**：`powerMonitor` resume → IPC → renderer 重连 +
  transport 即时重探；keep-awake 设置项（默认关）。
- **M3（登录自启）**：`launchAtLogin` 设置项（mac/linux；win 门控）。
- 验证：`pnpm run test:desktop`、`pnpm run typecheck`、`pnpm run build:renderer`；
  手工清单：关窗 → 隧道存活 → 托盘恢复 → 退出确认（含**更新已下载时退出不弹
  确认**）→ 唤醒秒级重连 → 无窗口常驻期间 resume 补发 → **托盘缺失回退**
  （dev 模式关窗即退、窗口不消失）。

## 7. 关联

- 设计 15（Chamber 设置呈现，v1 平铺形态）：睡眠/运行设置的呈现面
  （`__general` 固定入口）；
- `docs/progress/STATUS.md`（进度唯一记录）；
- OpenChamber 参考：本地 `/Users/panzeyu2013/Desktop/code/develop/OpenChamber`
  `packages/electron/main.mjs`、`tray.mjs`、`packages/ui/src/sync/event-pipeline.ts`、
  `packages/ui/src/components/sections/openchamber/DesktopNetworkSettings.tsx`。
