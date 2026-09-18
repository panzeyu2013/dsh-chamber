# 14 · 睡眠/后台常驻（窗口收起而 dsh 继续运行）

> **状态：现行（v1 范围，2026-12）**——窗口隐藏/关闭到托盘时，**本地 dsh 实例、
> 远程隧道、控制面全部继续运行**（长时间任务进行中收起窗口不被中断），OS 睡眠
> 唤醒后快速恢复，可选登录自启后台常驻；未完成门禁见 `docs/progress/STATUS.md`。
> 本文是睡眠/后台常驻的契约（关窗行为、托盘、退出确认、唤醒恢复与连接活性、
> 防休眠、登录自启、设置权威边界）；文中「OpenChamber 实现调研」为外部参考
> （本地源码 `/Users/panzeyu2013/Desktop/code/develop/OpenChamber`），移植设计在其后。

---

## 1. 依赖的现有事实（dsh-chamber）

| 项 | 事实 | 证据 |
|---|---|---|
| 进程拓扑 | 控制面（`createControlPlane`）、transport-manager 与全部 dsh 子进程都由 Electron 主进程持有；窗口只是视图 | `packages/desktop/main.ts` |
| 断链恢复 | **已具备**：transport-manager jittered 指数退避重连 + 慢速重探（隧道断线自动恢复）；dsh-client-connection 原生 connect/pump/reconnect 循环（SSE 断线自动重连） | `transport-manager.ts`（重连状态机）；`dsh-client-connection/src/client/connection.ts`（connect/pump/reconnect） |
| 托盘 | 打包态防御式最小托盘：tooltip + 「显示窗口/退出」，无状态投影、无设置 | `main.ts`（`maybeCreateTray`） |
| 退出清理所有权 | `will-quit` single-flight 完整 dispose 插件同步/本地插件子进程、传输层、控制面与 runtime 工作 | `main.ts`（`will-quit`） |

**结论**：进程拓扑与断链自愈已存在，本设计的全部内容都是**窗口生命周期与设置面**
（关窗不杀进程、唤醒即时重连、防休眠 / 登录自启 / 退出确认）——`hide` 窗口后没有
任何东西需要额外保活。dsh-chamber 的进程拓扑与 OpenChamber 同构，可直接移植其模型。

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
  **更新退出腿例外（design 11 §3.1，2026-12）**：`quitAndInstall` 在 macOS 上
  **先关闭全部窗口、再退出**（`before-quit` 晚于关窗），因此关窗裁决还接收
  `updateRestartArmed`——更新重启已武装时 `shouldHideToTray` 恒 false，关窗必须
  真正关闭；被 hide 吞掉会截断安装/重启链，留下「无窗口仍在运行」的进程。
- 设置 = `quit` 时关窗仍受 D2 退出确认保护（本地实例运行中先确认再退出；
  远程隧道/连接不影响关闭——D2），
  非 darwin 行为与现状一致（关窗即退出）。
- 三平台一致：macOS/win/linux 同走 `windowCloseBehavior`；macOS 系统惯例
  （红点/Cmd+W = hide、Cmd+Q = 退出）在 hide-to-tray 语义下天然一致。
- **前置门控：hide-to-tray 仅在托盘可用时生效**（对齐 OpenChamber
  `shouldHideMainWindowToTray` 先检查 `state.trayController` 非空）：托盘缺失
  （dev 模式 `app.isPackaged=false` / 图标资源缺失 → `maybeCreateTray` 跳过）时，
  非 darwin 回退现状（关窗即退出，仍受 D2 确认保护）——**绝不允许窗口被隐藏后
  无任何恢复入口**。macOS 无托盘也安全（Dock 图标常驻可恢复，hide 是系统惯例）。
- **隐藏窗口节流 = 保持 Chromium 默认（2026-12 修订；实测换判，取代旧「不节流」定案）**：
  `createMainWindow` webPreferences **不再**设置 `backgroundThrottling: false`。旧判
  （对齐 OpenChamber main.mjs）担心「隐藏后计时器被节流 → D4 唤醒立即重连被拖慢」；
  2026-12 在 Electron 43.4.0 / Chromium 150 / M5 Pro 120 Hz 上实测证伪该代价并给出
  反向成本：
  - 关闭节流的真实后果是 Electron **永久抑制隐藏态**（`disable_hidden_ = !backgroundThrottling_`，
    `shell/browser/api/electron_api_web_contents.cc`）：窗口隐藏后 rAF 仍 120/s、
    帧照画照交换、`document.visibilityState` 恒 `'visible'`、`visibilitychange` 0 次。
    于是 `retention.ts` 的 `shouldRunBackgroundPhase` 六处门控在 Electron 上
    **从不生效**，隐藏期 renderer CPU 最高 28.1%（上游常驻动画 19.0% + 发布 19.4%）。
  - 恢复默认节流后同一测量台：隐藏期 rAF 0、CSS 动画暂停、`visibilitychange` 恢复，
    renderer CPU 0.0–0.1%；**SSE 是网络流不受影响**（隐藏 9s 收 9/9 条、`maxGap`
    1005ms、0 错误），唤醒即时重连走 `powerMonitor.on('resume')` →
    `dsh-chamber:system-resume` 的 IPC 推送（非计时器，不受节流影响）。被节流的只有
    <1s 定时器（100ms→1Hz；1s 保持 1Hz），3s/15s/30s/60s/120s 各档看门狗节奏不变。
  - **Rejected alternatives**：① 保留 `backgroundThrottling: false` + 新增「窗口隐藏」
    IPC 推送由渲染侧暂停动画/发布——多一条宿主桥面（preload / bridge manifest / 锁步测试）
    而收益已被恢复节流完全覆盖（隐藏期已是 0.0%），故不采纳；② 运行时
    `webContents.backgroundThrottling = true`——实测对**已隐藏**窗口不生效（rAF 仍
    120/s、`visibilityState` 仍 visible），只在建窗时有效，故不作为恢复手段。
- `showMainWindow()` 保留：隐藏 ≠ 销毁，`activate` / `second-instance` /
  托盘点击 → `show()+focus()`；销毁后才走重建分支（现有逻辑已覆盖）。

### D2 退出确认（quitRisk 投影）

- **2026-08 修订（用户拍板）**：远程隧道**不影响关闭**——风险只看**本地实例**；
  且退出确认成为**可设置开关** `quitConfirmation`（默认开；关 → 永不确认）。
- 开关开启且**本地实例运行中**——判据 = 状态机 running（含 starting/
  restarting 在途态）**且实际有存活进程**（`localProcessAlive`，经控制面
  `hasLiveProcess`；状态字符串不是存活事实——restart 序列中 restarting 期间
  新进程尚未 spawn、死亡进程在下次探活前滞留 ready/degraded）
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

### D3 托盘增强（可选）

- 状态 tooltip：`dsh-chamber · 控制面 http://127.0.0.1:<port> · <connectionState>
  · 连接 N/本地实例运行中`（非秘密投影，来自 transport-manager status push +
  control plane `/health`）。
- 菜单：显示窗口 / 退出（现状）+ 可选「N 个远程连接活动」只读行。
- 保持防御式构造（沿用 `maybeCreateTray` 的 try/catch 跳过语义：无图标资源/
  失败 → 跳过并日志，绝不阻塞启动）。
- **不做** OpenChamber 式会话级托盘（会话业务归各实例前端 runtime，P2 纪律）。

### D4 唤醒恢复与连接活性

- 主进程 `powerMonitor.on('resume')` → 向主窗口 push `dsh-chamber:system-resume`
  → renderer chamber App 层分发 → ① 当前实例连接 runtime 立即重连
  （dsh-client-connection 原生 reconnect 兜底，事件只消除心跳等待延迟）；
  ② transport-manager 对 `phase=degraded/error` 的实例立即触发一轮 retry
  （替代等慢速重探），sleep 断掉的隧道秒级恢复。
- 无窗口常驻期间（托盘态）resume 事件由主进程持有，窗口恢复时一次性补发。
- **为什么还需要连接活性机制**：连接泵只在 close/error 时重连，而睡眠/网络切换后
  半开 TCP 可以**静默死亡**——不触发任何事件 → 前端"已连接但失明"（POST 照常
  成功、事件永不抵达，UI 停在运行态）。下列两组机制互补，且都不依赖某个 OS 事件
  必然触发：
  1. **渲染侧活性触发器**（`dsh-client-connection/src/client/liveness-triggers.ts`，
     `attachLivenessTriggers`）：system-resume 之外增加 `online`（唤醒/网络恢复）
     与 `visibilitychange→visible`（隐藏 ≥30s 后回前台；短 alt-tab 不触发）
     触发**控制器原生 `reconnect()`** 立即重连（退役 stop()+start() 与 loopEpoch
     守卫）；`online` 与可见性触发受**离线门**约束（离线时上游
     `setNetworkAvailable(false)` 已挂起重试），而 **`system-resume` 旁路离线门**：
     页面跨挂起/恢复被冻结时可能整体错过 `online` 事件、持续误报 offline，而
     `reconnect()` 的 `immediateRetry` 会跳过挂起分支只强制一次有界尝试
     （真离线则快速失败并重新挂起）；**最小重启间隔去抖
     `DEFAULT_MIN_RESTART_INTERVAL_MS`（10s == recovery schema 默认 backoffMaxMs）**
     把 resume+online 同醒并发、online 抖动合并为一次。**远端就绪期限放宽**：
     ssh/http 来源经 `recovery-policy.ts` + `connection.start(sinks, config)`
     用 45s 期限 / 5s 告警（本地保持上游 15s/3s），避免冷隧道/慢链路握手超期后
     被无限重试。重连后 `handleConnected` 的 list 刷新 + resync 让卡死的
     running 位收敛。
  2. **控制面代理 WS 心跳，仅下游（浏览器）腿**（`control-plane/src/ws-frames.ts`
     + `ws-heartbeat.ts`，RFC 6455 §5.5.2/§5.5.3）：splice 建立后向浏览器周期
     发免掩码 ping（浏览器按 RFC 自动 pong，透明不上抛 app），`PongScanner`
     被动扫描浏览器 data 流（不消费字节、不动 pipe）；**参数对齐 `ws` README
     官方心跳示例（30s 间隔、一个周期未答即断）**→ tearDown → 浏览器 WS close
     → 泵重连重基线（检出 ~30s）。**上游（宿主）腿刻意无心跳**：远程断隧由
     SSH keepalive（`ServerAliveInterval=30 × CountMax=3` ≈90s，ssh-provider
     已配）覆盖，本地宿主死亡/重启由 socket error/close 覆盖，宿主自身发送
     失败即关——代理侧上游 ping 只会与 SSH keepalive 抢跑成"半开隧道上反复
     重连"的抖动环（严格容忍）或比它更晚（宽松容忍=无用）。
     **直连腿例外（S2）**：direct-http(s) 目标（非 loopback 上游，
     无 ssh keepalive 覆盖）经 instance-proxy 启用 OS 级 TCP keepalive
     （`tcpKeepAliveMsForUpstream`，初始空闲 30s；探测间隔/次数走 OS 默认
     → 半开发现约 ~10min 级，非 30s 裁决；现实快愈者 = renderer staleness
     看门狗的 120s 轻量 reconnect，见 STATUS.md「http 连接链路修复」）。
     **宿主侧心跳事实**：`/api/remote.mux` 宿主侧每
     `websocketHeartbeatIntervalMs`（默认 2s）ping 下游、2 次未答 terminate
     （~6s；`MAX_MISSED_HEARTBEATS = 2` **硬编码不可配**，仅间隔可配且有上界
     ——pinned vendor `api/gateway/src/stream-server.ts` 与 `api/gateway/src/index.ts`
     的 Config schema）——控制面 30s 浏览器腿心跳对 mux 已是睡眠/唤醒场景的
     冗余兜底；无心跳的只读下行流是 0.1.1 的 events.mux/events.host（本心跳的
     原始动机，那两个下行流在上游已删除，见 03 §3.1）。30s 三重合（TCP keepalive
     初始空闲 / WS_PING / ServerAlive）同值属巧合、理由各异，勿合并。
- **拆链取证日志**：`proxy-forward.ts` 的 WS splice 拆链必写一行有界日志
  `WebSocket stream <id> closed (<cause>, <ms>ms)`（cause 为无括号 token：
  `browser|upstream close|error`，或代理自身心跳的
  `heartbeat lost after N unanswered ping(s)`——整行可被
  `closed \(([^)]*), (\d+)ms\)` 解析）。代理自身心跳以外的拆链此前无日志，
  **实例侧** 2s 心跳判死在 gateway 侧完全无痕——该日志让「实例判死」与
  「客户端主动重连」在 journal 中可区分，是 design 17 §18 连接稳定性取证的
  第一手证据来源；行为（拆链顺序/计数/销毁）与之无关，且 logger 抛异常不会
  锁死拆链。**归因边界**：cause 记录的是「先观察到哪条腿结束」——
  代理**主动**撤销（`closeAllStreams`/revoke）也会记成 `upstream close`，
  故该行不可单独用于判定"实例侧判死"。

- **会话运行位活性守卫（2026-12，Swift 原生版「深度求索中」永久卡死修复）**：
  ui-chat 的运行指示器由官方 session 的 `running` 位驱动
  （`dsh-client-ui-chat`: `running = useSession(s => s.running)` → `TurnStatus` →
  `chat.deepDiving`），而该位只由 mux `$events` 流上一条 **emit 型转发事件**
  `api-session/status` 递送（`dsh-api-session-controller`: `handleSessionStatus` →
  `handleRunning`）。emit 无重传、`$events` 开场帧不重放会话状态（2026-12 独立复核
  逐行核实）。官方另有两条**非周期**写 running 的路径——会话物化时按缓存 summary
  播种、`refreshList()` 把权威 summary 的 running 回灌（`connection/reset` →
  `handleConnected`，以及首次 apply 期）——但**没有任何周期性触发点**（全树无官方
  `sessions.refresh()` 调用者、无 session.list 轮询）⇒ 稳态下丢一帧或 carrier 静默
  半死时该位永久为 true（客户端零超时、零出口）。**残留故障类要精确命名**：传输层已有
  周期性 liveness（宿主 mux 2s×2、控制面浏览器腿 30s×1），已覆盖的是「socket/心跳死亡」；
  本守卫针对的是「**socket 与心跳全健康、而宿主侧转发事件源停摆**」（fiber 被 dispose /
  源静默；emit 无重传也无游标）——这一类没有任何现成触发器。宿主侧无责：agent loop 在
  `finally` 必写 `turn/end`。**上述 §D4 的 liveness 触发器覆盖不到
  这一类**（它们全部要求 OS 级事件：唤醒/网络/可见性；窗口可见且机器未睡时一个都不响）。
  修复 = 三级阶梯（决策半 `renderer/src/session-liveness.ts` 纯模块，执行半
  `dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts` +
  producer 既有 refresh seam）：
  **状态机不变量**（2026-12 二轮复核后定稿）：时段按**每会话计时**（`runningSince`）
  起算——同一来源下短会话反复开始/结束**不得**重置一个真正卡住的长会话的时段；只有
  来源代际（registry fingerprint）变化、或当前运行集合与上一 tick 完全不相交时才重起
  算（挡住「A 结束、B 开始」继承旧配额与旧提示）。**L3 门 = 未收敛证据 + 宽限**：
  (`outcomeFailed`（最近一次**非 unknown** 结算 ok:false（且结算时刻晚于最近一次真实重连——重连前的 sticky 失败不算新证据，否则重连后一个宽限期就亮一条 30s 假横幅））或 `outcomeMissing`（等回执超过 150s = 对账链
   最坏回执时延 2×(20s+35s)+1.5s ≈111.5s 之上，见 sidebar 的相位预算）)
  ∧ **梯子到顶**（真实 L2 预算用尽 **或** 连续 no-op 派遣达 `maxNoopReconnects`——后者是「杠杆一直不可用」时的第二条出口）∧ 距**梯子到顶那一刻**（`ladderAnchorAt`，只记一次）≥ `noticeAfterMs` ∧ 本轮尚未提示。健康回执清除未收敛
  证据并撤下已亮提示，**新的**失败证据可再次武装——既不会被守卫自己的 L1 请求无限推迟，
  也不会被一次健康回执永久 latch，更不会在「配额间隙没发请求」时误报（只用时间锚点的
  版本正是这样产生周期性假横幅的，2026-12 二轮复核修复）。
  ① **L1 只读对账**：某来源持续 running ≥ 120s ⇒ 经既有
     `chamberBridge.requestSessionListRefresh` 请挂载 ctx 重跑官方
     `ctx.sessions.refresh()`（single-flight；其内部 `refreshList()` 把权威
     summary 的 running 回灌到已物化会话 ⇒ 卡死的位自然掉落）；节拍 = `refreshCoalesceMs`
     `200s`（**= refreshWindowMs / maxRefreshRequests**：把配额铺成均匀节拍——用 60s 会在
     120/180/240s 爆发用完窗口、之后失明 8 分钟；相等时平均成本不变而最坏未探测时长 = 200s），
     滚动窗口 10 分钟 ≤3 次。
  ② **L2 有界 reconnect**：仅当**对账回执**证明**对账通道**已坏（**非 `unknown` 的**失败回执 `ok:false`，或请求后 150s；与吸收 `unknown` 同一 tick 发出的 L1 也算"之前"——保守方向，最多多等一个 coalesce 窗；**第一次 `unknown` 被吸收**：在它之后再发出一次 L1 之前，期限一律不生效——见下
     无回执）才 `reconnectInstanceConnection`（复用 S2 watchdog 的杠杆与**同一份
     per-source 记账**：同 tick 去重集合 + 跨 tick 的 60s 账本；no-op 不消耗预算，但计入
     `noopReconnects` 供 L3 收口）；**local 刻意不排除**（本次缺陷现场就是
     本地实例）。回执由 `verify` seam 做**权威判定**——官方 `refreshList()` 对拉取
     失败照常 resolve（2026-12 独立复核：`result.ok===false` 只置 `listState='error'`），
     所以「promise 解决」不算成功：只有独立 unary 探针确认官方 running 位与权威快照
     一致才结算 `converged`；探针**正面证伪**（官方说 running 而权威说没在跑）或 refresh 相位自身失败/超时结算 `stale`（允许升级）；**探针自己失败/超时结算 `unknown`**——它走控制面 HTTP 代理，与被守卫的 WS 事实通道是两条载体，只推进水位、不升级也不清「等回执」计时；但**第一次 `unknown` 被吸收**：在它之后再发出一次 L1（并重新起算期限）之前，`outcomeMissing` 一律不生效——生产常量下等回执期限 150s < coalesce 200s，若不吸收，"探针无法裁决"必然抢在下一次 L1 之前被判成"对账通道已坏"，一次 502/代理重启就会制造假 L2 并吃掉该 running 时段唯一重连预算（2026-12 独立复核的时间线仿真；只从 unknown 时刻顺延对**快 unknown** 仍然不够——期限还是在下一次 L1 之前到点，二轮复核的 L1#1@120s→L2@330s→L1#2@360s 时间线）。第二次 unknown 不再吸收，持续无结论由那次 L1 的期限收口（有界）。
  ③ **L3 可见提示**：有未收敛证据且距梯子到顶（`ladderAnchorAt`）≥ 120s ⇒ 顶部非模态
     横幅（重连 / 重载应用页面 / 忽略），**绝不自动重载**（与 mobile `session-stall.ts`
     同纪律）；横幅只在有证据时出现，通道健康时不会因探测间隙反复亮灭。
  **核心取舍**：升级的唯一依据是「拿不到权威结论」，不是「沉默很久」——长工具/长推理
  的合法静默与真卡死在 App 层不可区分，误升级（每次 reconnect 重放全部会话 baseline）
  会引入比原缺陷更糟的风暴；L1 是读操作，可以廉价重复。实测依据：活跃 turn 期间宿主
  durable 进展 5–21s/次（median 11s，161s 13 次），而合法静默可达 75s（TTFT）到数分钟。
  **被否替代（Rejected alternatives，2026-12）**：
   - **把 L1 放进 mobile 的 `session-stall.ts`**：该插件只有 gateway/mobile flavor 加载，
     desktop 与 Swift 原生壳不挂它 ⇒ 缺陷现场打不到；且它自带一个未校准的 45s 阈值，
     会造出第二套「停滞」概念。
   - **只做 L3 横幅、不做 L1 对账**：`running` 位不会收敛，用户唯一出路是整页重载
     （丢页面状态），而真正的收敛动作其实只是一次只读 `session.list`。
   - **用 disconnected/close 事件驱动升级**：本次缺陷本体是「carrier 静态半死、socket
     不 close」，事件根本不发，按事件升级只覆盖已经自愈的那一半场景。
   - **决策机放进 client-plugin 直接盯官方 running 位**：插件拿不到 App 的 reconnect
     杠杆与 registry 代际，且每个挂载页各持一份预算（多 ctx 放大成 N 次对账）。
   - **改 vendor 在宿主侧加日志/心跳**：pin 升级即丢，违反「不改上游」边界；诊断价值
     已由 P1 的两处落盘（02 §3.8 与 25 §3.1）拿到。
   - **把 local 也纳入既有 S2 重连臂**（最省的想法）：S2 的判据是「mounted 快照静默」
     ——本缺陷里工作区/会话列表的推送照常活着（丢的只是 status 事件）⇒ 源看起来「新鲜」，
     该臂永远不响；守卫必须按**运行位本身**的收敛证据判定，不能复用快照静默。
   - **改用 App 每 30s 兜底 unary pull 的权威 running 行直接对表**（STATUS ⑪ 记录的
     下轮首选）：可删掉 reconcile/verify/回执整条链（≈450–500 行），但硬证据三条：
     ① 挂载源的 `aggregates` 会被 producer push **整块覆盖**，而 push 与 runtimeFacts
     同源于官方 store ⇒ 两份事实不独立；② push 会作废在途 pull；③ 该 pull 只在源
     stale 时发生，推流存活的源根本不拉。要覆盖「丢一帧而流仍活」必须另加旁路采样面，
     收益不足以承担新的 push/pull race，故选保留现形态。
   - **把 `unknown` 当失败立即升级**：辅助探针走控制面 HTTP 代理、被守卫的是 WS 事实
     通道，一次 502/代理重启就会拆流并把全部 baseline 重放一遍；改为 unknown 只推进
     水位、并忽略期限直到下一次 L1 发出（第一次 unknown 被吸收），持续无结论由那次
     L1 的期限收口（不吸收则期限必然抢在下一次 L1 之前到点，等于"立即升级"）。
   - **refresh/verify 共用一个尝试计时器（或沿用 90s 总预算）**：慢宿主上「refresh 用了
     十几秒 + 探针还没回」会被判成「拿不到权威结论」⇒ 假 L2；改为两相位各自计时
     （20s/35s），等回执期限随之抬到 150s，并由接线测试锁住三条不变量
     （最坏回执 < 等回执期限、verify 预算 ≥ 探针自身 30s 上限、生产构造点不得 override）。
  **未闭合**：**权威清单与逐条失效判据见 `docs/progress/STATUS.md`「会话运行位卡死」
  条（编号以 STATUS 为准）**；与本设计直接相关的形态摘要：① transcript 与运行位可能分别
  收敛（STATUS ②，需上游逐流交付统计/游标）；② 官方 `session.list` 单飞悬挂时本阶梯的
  「重新连接」也无效，只剩「重新加载」（STATUS ③）；③ 子代理会话不在事实通道
  （STATUS ④）；④ 隐藏期不 tick，恢复补偿 tick 按**累计** running 时长判定（STATUS ⑤）；
  ⑤ 守卫自身的三级动作目前只落 renderer console（STATUS ⑩，真机取证仍缺一条落盘链）。
  另：L1 对账把卡住的 running 位压回 false 时，官方完成通知/完成蓝点的边沿照常触发
  （`syncCompletedNotifications`），用户能看到这一回合确实结束了——这是修复的副产品，
  不需要额外机制。
- **控制面日志落盘（2026-12，取证缺口修复）**：动机在本节——控制面自身日志
  （含 WS splice 的 `WebSocket stream <id> closed (<cause>, Nms)` 与
  `heartbeat lost …`）此前只交给注入的 logger（默认 console），而打包态从
  Finder/Dock 启动时 stdout/stderr 不落盘（实测 `log show --predicate
  'process == "DSHChamberPoc"'` 无输出）⇒ 两类 flavor 的这条归因证据都等于丢失。
  **落盘规格归 design 02 §3.8 拥有**（`<stateDir>/logs/control-plane.log`：JSONL、
  有界轮转、0700/0600 + 不跟随符号链接、写失败降级告警一次；控制面拥有 stateDir，
  故两 flavor 共用同一实现）；原生壳侧 sidecar stderr 的对应面归 design 25 §3.1
  （`<userData>/logs/sidecar.log`，见那里的规格）。**未闭合**：真机事故下
  「`WebSocket stream … closed` 行确实可检索」未经实测（见 STATUS）。

- **对话流健康臂（2026-12，纯 chamber 代码）**：本节阶梯覆盖不到的那类真机卡死的收口。
  - **缺陷本体（已复现）**：连接代际仍 ready 时连续载体丢失 ⇒ 上游
    `waitForRemoteStreamRetry` 把 `RemoteStreamCarrierError` 抛成终局 ⇒
    `Session.failEventStream()` 把 `openState` 锁成 `'error'`（窗口保留、流不再重开），
    官方聊天面只在列首渲染一行 `chat.loadError`。headless 复现：同一 mux socket 在
    1.2s 内被拆 4 次（`closeAll` + `killNext(3, 25ms)`），页面此后不再重发
    `session/follow`，DOM 冻结在 213 行 / 92 turn；对照跑（同一抖动、快照被接受）journal
    正常重开 ⇒ 是 race 不是必失败。真机同形证据：`13:35:47.689Z local closed
    (upstream close, 368803ms)`（用户报障前 91s）与该源两个子代理会话同时冻结。
  - **唯一杠杆与其硬边界**：公开 `ISession` 无 `open()/resync()`；`clear()` 不动 stage
    （`followCurrent()` 在 `current === undefined` 时直接 return），连接代际 reconnect 也
    不重开 journal。可用杠杆只有 stage 迁移：`open(neighbor)` → `open(target)` 同步两步，
    让 `followCurrent()` 在 `Session.open()` 上重跑 `doOpen()`——但只对
    `openState !== 'open'` 生效；`'loading'`（`openPromise` 在途）与 `'open'`（状态短路）
    都不可重开。
  - **落地**：`packages/dsh-chamber-client-ui-open-in`（既有的 per-instance 头排座席宿主）
    新增 `src/client/session-stream-health.ts`（纯决策：error 满 8s 自动 stage 迁移重开，
    冷却 120s、滚动窗口 10 分钟 ≤3 次；loading 满 20s、或阶梯无杠杆时给「重新加载」提示）、
    `src/client/session-stream-health-probe.ts`（stage 迁移与面形状读取，全部 fail-closed）、
    `src/client/SessionStreamHealthChip.tsx`（`conversation.session.header.actions`，
    list/session 作用域：只显示，绝不自行重载）、`src/client/session-stream-health-seat.ts`
    （座席注册 + **按会话持有的阶梯状态** + 非抛错的 vendor 面读取）。两条 review 修正写进
    契约：①**阶梯状态在座席而不在组件 ref**——会话子树按绑定 key 挂载，切会话即卸载，
    ref 会让同一会话每次访问重获 grace/冷却/预算，storm bound 失效；②stage 迁移有**前置
    条件**：target 必须“仍是 current 且在列表里”，否则拒绝（address-only 子代理会在首步
    失去 eligible 被 `pruneScopes()` 拆 scope 并 release 输入壳附件；masked gap 会让回程
    `open(target)` 抛错把用户留在邻居会话；未 flush 的旧 effect 会把 stage 抢回用户已切走的
    会话），退化为提示臂。控制面侧只保留一条取证日志：握手完成前下游腿离开时记
    `WebSocket upgrade <id> abandoned (downstream close before upstream handshake, Nms)`
    （归因边界：控制面自身 `revokeTransportTraffic`/`closeAllStreams` 拆 socket 也走这一行，
    不可单独据此判定“浏览器主动离开”）。
  - **触发面：做完又被否掉的一条（2026-12 review 证据链）**。原设想是让控制面在上游腿
    **代答宿主心跳 pong**（被动 `PingScanner` 扫宿主 ping → 自己写 pong），把宿主 2s×2 的
    判死从浏览器网络进程解耦。实现后被两处**协议级**证据否定，已整体回退（chamber 的
    “不改上游”边界下无从绕过）：①上游腿里代理是 **client**，RFC 6455 §5.3 要求 client 帧
    必须掩码，pinned `ws` 服务器对未掩码帧直接 1002（`WS_ERR_EXPECTED_MASK`）——代答反而
    在首个心跳（~2s）后杀掉每条 mux，正好制造它要消除的 churn；②pong 是在
    `socket.pipe(upstreamSocket)` 的字节流**中间**插入的，浏览器帧跨 chunk 时会被劈开，
    宿主解析器按 TCP 顺序读到 `[帧前半][pong][帧后半]`（实测 `invalid UTF-8 sequence`）。
    正确实现需要“浏览器方向帧边界感知的写入路径 + 掩码”，代价与风险都落在被保护的传输层
    上，收益只是降频，故不做。触发面的**残余选项**留在 STATUS「连接稳定性」条：托管实例
    的 patch overlay 增一行 config 调宽 `websocketHeartbeatIntervalMs`（宿主侧 schema 有该键，
    `api-gateway` 插件 `Config.websocketHeartbeatIntervalMs`，默认 2s；调宽它只动宿主自己的判死容错（~4–6s ⇒ 例如 30s×2），不注入任何字节。代理下行腿自己的心跳仍是 30s 周期、回答后才重新计时，最坏约 60s 才 onDead（`ws-heartbeat.ts`）。
  - **拒绝替代**：整页自动重载（丢页面状态，且只能由用户点——本节与移动端
    `session-stall.ts` 同纪律）；`session/follow` 盲空闲超时（合法长静默：实测 TTFT 75s
    起、工具可数分钟，必然误报）；fork `ui-chat` 改错误行（82 文件，design 09 已拒）；
    代理注入合成 `end`/未知帧逼客户端重试（未知帧会让客户端 `failAll` 并关 socket，且空闲
    会话被周期性重放）；代理透明重放客户端流开帧（新宿主 socket 无流上下文，重放会触发
    `RemoteJournalStream` 的「多次 opening cursor」协议错误）；**上游腿代答宿主 pong**
    （理由见上一段：掩码与帧边界两条协议约束）。
  - **未闭合**：`openState === 'open'` 但静默的半死形态仍无自动杠杆（无 applied cursor
    水位时与合法长静默不可区分），收口两条：宿主侧流级 keepalive 仍未做；「让 carrier 失败永不终局」已落地（见下条）；自动重开的**实机验收未做**（判据 = 真机抖动后自查恢复，且 `local closed (upstream close, …)` 的频率不再随浏览器卡顿波动），阶梯阈值（8s/20s/120s/≤3）与 `presented` 判据的近似（document 级 `[data-chat-flow]` 存在性，非「实际可见」）同样待真机校准

- **载体故障的用户可见面（2026-12）**：治因 = `packages/dsh-api-gateway/src/client/remote-stream.ts` 在活世代下用有界退避（250ms 起翻倍、10s 封顶，与连接车道自身 `backoffMaxMs` 同值）重开而不逃逸为 `gateway/internal`；信号面 = 该包 `$stream` 工厂组合 `carrierFailed` 成有界页面事实
  `dsh-chamber:stream-carrier-failed`（`stream-carrier-fact.ts`：计数 + 时间 + 实例 id + 截断消息，dispatch 抛错被吞，绝不打断重连），由 open-in 的健康臂座席按实例过滤后喂进纯决策模块，chip 以 `role="status"` 显示「对话流正在重新连接…」（信息性、不给「重新加载」按钮，超过 `carrierChurnMs` 自行消退）。
  - **拒绝替代**：（a）不做可见面——拒：去掉终局逃逸后，用户再也分不清「流在重连」与「会话本来就安静」，这是本补丁引入的静默窗口；（b）客户端插件在打包期 import 该 fork 的事件常量——拒：client plugin 不应加深进 fork 的 import 路径，故字面量复制并由 `stream-health-wiring.test.ts` 把两处拼写钉在一起（vendor-lockstep 先例）；（c）ctx service seam（fork 消费 chamber 提供的服务）——拒：fork 的探针面会被 chamber 插件的存在绑住，而页面事实在座席缺席时也无害；（d）让 carrier 失败重新终局——拒：正是本次要修的根因。
  - **未闭合**：churn 提示窗口（10s）与按来源归属的粗粒度未在真机校准（STATUS ⑬）。
### D5 keep-awake（v1 设置项，默认关）

- `powerSaveBlocker.start('prevent-app-suspension')`；settings 壳「通用」入口
  开关（设计 15）；退出/停用时 stop。仅防应用挂起，不阻止显示器关闭，不引入
  后台任务。

### D6 登录自启（v1 设置项）+ 后台启动（v1 不做）

- 新设置 `launchAtLogin`（**用户可设**，settings 壳「通用」入口）：登录时自动
  启动 dsh-chamber（**开窗**启动；v1 不做无窗口后台启动）。
- 实现：macOS `app.setLoginItemSettings({ openAtLogin })`；Windows 同 API
  （HKCU Run 键，**design 23 M4 已解锁**；NSIS 卸载段清理 Run 值见
  `packages/desktop/scripts/nsis-uninstall-cleanup.nsh`）；Linux 写 XDG autostart `.desktop`
  （对齐 OpenChamber `linux-autostart.mjs` 形态）。
- `--background` 无窗口后台启动（对齐 OpenChamber `shouldStartInBackground`）
  **v1 明确不做**：登录自启 = 开窗启动；「无窗口常驻」由「关窗到托盘」覆盖。

### D7 设置存储与权威边界

- 全部 chamber 级运行设置 → 主进程新 **`<userData>/chamber-settings.json`**
  （原子写、0600、非秘密；`dsh-chamber:settings-get/set` IPC + 变更 push）。
- **绝不进任何实例的 dsh home**（01 §2 P2：每实例配置平面权威，控制面只
  透传；chamber 设置是 app 级，与实例配置平面不相交）。
- 不新增依赖：`powerMonitor` / `powerSaveBlocker` / `Tray` 均为 Electron 内置。

## 4. 面与接线（契约）

| 面 | 改动 |
|---|---|
| `packages/desktop/main.ts` | 关窗分支（hide vs quit，**托盘可用门控**）；隐藏态节流 = Chromium 默认（2026-12 修订，见 D1）；`powerMonitor.on('resume')` → push；`powerSaveBlocker`；退出确认（仅本地实例实际 live process，远程隧道/连接不影响关闭；**含更新安装豁免 + 单飞**）；will-quit single-flight 并行等待 plugin-sync/本地插件子进程、transport、control-plane 与 runtime 工作；`chamber-settings.json` store + `dsh-chamber:settings-get/set` IPC + push |
| `packages/desktop/preload.cts` | `settings` 面（get/set/onChanged，覆盖 chamber 级全部设置键）+ `systemResume` 订阅；`DshChamberBridge` 扩展 |
| `packages/renderer` | App 层订阅 system-resume → 分发实例重连 + transport 即时重探；**D4 运行位活性守卫的决策与呈现**：`src/session-liveness.ts`（纯决策，含阈值/每会话计时/预算）+ App 内接线（staleness watchdog 内规划 → L1 广播 / L2 共享账本重连 / L3 横幅 + 忽略集合） |
| `packages/dsh-chamber-client-ui-sidebar` | **D4 的执行半**：`shared/session-fact-reconcile.ts`（单飞 + 有界重试 + 相位超时 + 三值权威判定回执）；producer 订阅既有刷新通道并驱动它，回执经 `InstanceRuntimeReport.sessionFactReconcile` 回流（05 §3） |
| `packages/dsh-chamber-client-ui-open-in` | **D4 对话流健康臂的座席宿主**（2026-12）：`src/client/session-stream-health.ts`（纯决策）+ `session-stream-health-probe.ts`（stage 迁移与面形状，fail-closed）+ `SessionStreamHealthChip.tsx`、`session-stream-health-seat.ts`（注册进 `conversation.session.header.actions`，list/session 作用域） |
| settings-bridge 壳 | 「通用」视图（见设计 15：固定入口 `__general` 平铺） |
| 测试 | `test:desktop`（关窗行为/退出确认/设置 store 单测）、`typecheck`、`build:renderer`（§6 验证门） |
| 控制面 | loopback-only 与对外契约**无改动**；D4 的日志落盘包装（`createControlPlane` 无条件把注入 logger 包成 `<stateDir>/logs/control-plane.log`，规格见 02 §3.8）。2026-12 另加一处：「握手完成前下游腿离开」的取证日志（`WebSocket upgrade <id> abandoned (downstream close before upstream handshake, Nms)`，不动计数器；代答宿主 pong 的设想按同段证据整体回退） |

## 5. 安全与纪律

- 无新秘密面：托盘/设置只投影非秘密状态（连接数/phase/版本）；传输 URL、私钥与
  代理配置永不进 renderer，密码只有表单瞬时 write-only 输入且绝不返回/回填
  （05 §8 不变）。
- close-to-tray **不改变 will-quit 清理所有权**：退出完整 dispose plugin-sync/
  本地插件子进程、传输层、控制面及 runtime 工作，不留孤儿 pack/install、隧道、
  installer 或 dsh 子进程。
- keep-awake 仅 prevent-app-suspension，无后台执行面。
- 退出确认是本设计新增的 dialog，与 01 §4 移出项（notifications 等）无冲突；
  其余原生确认框各有其归属设计（插件动作确认、dsh 运行时版本源切换与
  mutation 确认、VS Code 拉起失败等），更新提示本身仍不弹窗（设计 11）。

## 6. 范围与验证门

**v1 范围（定稿）**：`windowCloseBehavior`（hide-to-tray 默认 / quit，可设）、
`launchAtLogin`（可设；mac/linux/win，win 门控）、关窗到托盘 + 托盘显示/退出、
退出确认（`quitConfirmation`）、`chamber-settings.json` store + IPC、唤醒即时重连
（powerMonitor resume）、keep-awake 设置项（默认关）。
**v1 明确不做**：`--background` 无窗口后台启动（登录自启 = 开窗启动；「无窗口常驻」
由「关窗到托盘」覆盖）；会话级托盘（P2 纪律）。

验证门：`pnpm run test:desktop`、`pnpm run typecheck`、`pnpm run build:renderer`；
**D4 附加门**：`pnpm run test:renderer-shell`（`test/lifecycle/session-liveness.test.ts`（行为契约；后续裁决已移除源码文本接线锁））、`test:sidebar`
（`test/session-state/session-fact-reconcile.test.ts`、`test/session-rows/completed-dots-signatures.test.ts`、
`test/session-rows/workspace-membership.test.ts` 的回执投影边界）、`test:control-plane`
（`test/log-file.test.ts`、`test/host-lifecycle/lifecycle.test.ts` 的落盘/reopen 端到端、
`test:open-in`
（`test/session-health/session-stream-health.test.ts` 阶梯真值表 + `stream-health-wiring.test.ts` 座席接线锁 +
`vendor-heal-contract.test.ts`：stage 迁移所依赖的三条 vendor 事实的 lockstep，pin 升级语义变化即红）、
`verify:test-wiring`（**仓内全部 test manifest 必须登记在案**）、`test:swift`（NativeShellLogTests 全部用例，含新增的 sidecar 文件名/轮转名/落盘三条
+ CrossLanguageLockstepTests 的 sidecar sink 锁步）；
手工清单：关窗 → 隧道存活 → 托盘恢复 → 退出确认（含**更新已下载时退出不弹
确认**）→ 唤醒秒级重连 → 无窗口常驻期间 resume 补发 → **托盘缺失回退**
（dev 模式关窗即退、窗口不消失）→ **对话流健康臂可见性**（对同一来源反复拆 mux socket，制造
`openState='error'`：不整页刷新即自动恢复，恢复后聊天面继续渲染；无第二个会话时只出现
「重新加载」提示；`loading` 停滞满 20s 才出提示）→ **运行位守卫可见性**（故意让某来源的 running 位不收敛：
不自动重载；横幅出现后「重新连接」生效、「忽略」在来源恢复前不再弹、「重新加载」才丢页面态；
判据回 STATUS「会话运行位卡死」①）。

## 7. 关联

- 设计 15（Chamber 设置呈现，v1 平铺形态）：睡眠/运行设置的呈现面
  （`__general` 固定入口）；
- `docs/progress/STATUS.md`（进度唯一记录）；
- OpenChamber 参考：本地 `/Users/panzeyu2013/Desktop/code/develop/OpenChamber`
  `packages/electron/main.mjs`、`tray.mjs`、`packages/ui/src/sync/event-pipeline.ts`、
  `packages/ui/src/components/sections/openchamber/DesktopNetworkSettings.tsx`。
