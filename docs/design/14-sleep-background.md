# 14 · 睡眠/后台常驻（窗口收起而 dsh 继续运行）

> **状态：现行（v1 范围）**——窗口隐藏/关闭到托盘时，**本地 dsh 实例、
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
  **更新退出腿例外（design 11 §3.1）**：`quitAndInstall` 在 macOS 上
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
- **隐藏窗口节流 = 保持 Chromium 默认（修订；实测换判，取代旧「不节流」定案）**：
  `createMainWindow` webPreferences **不再**设置 `backgroundThrottling: false`。旧判
  （对齐 OpenChamber main.mjs）担心「隐藏后计时器被节流 → D4 唤醒立即重连被拖慢」；
  在 Electron 43.4.0 / Chromium 150 / M5 Pro 120 Hz 上实测证伪该代价并给出
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

- **修订（用户拍板）**：远程隧道**不影响关闭**——风险只看**本地实例**；
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

> **单一所有者（会话链重构，Phase A + B1–B3 已落地）**：本节的判定与记忆不再散落在各执行器里。
> ① **载波**：四条替换入口收敛为 `RemoteStreamMuxClient.requestCarrierRebuild`，判定由共享 reducer
> （`packages/dsh-stream-state` 的 `reduceCarrier`/`decideRebuild` + `tables.json`）持有，执行器只执行返回的 effects；
> **静默判定也在 reducer（P3）**：执行器随 `rebuildRequested` 上报 `framesSinceSend`（本次发帧以来自当前 socket 收到的帧数），
> 零帧把 `openingStall` 归为 `socketNoFrame`（不受 streak 门限），有帧则任何显式静默 reason 都被拒绝；宿主只回读 effect 的
> reason 作为取证标签，不再自判。加宽预算/握手期限/静默下限与 `remote-retry-policy` 的常量副本已退役（G-G 锁步条目随之删除，17 锁/11 退役）。
> **加宽账本与期限装载也已归 reducer**：`openingStreaks`/`streamRequestKeys`（cap 256，最旧先逐）由 `openingSent`/`openingExpired`/
> `openingAnswered`/`episodeClosed`（`timedOut` 决定放宽是否留给重试道）维护，宿主只上报观测、执行 `armOpeningDeadline` 等 effects。
> **身份边界（本地无旁路）**：vendor 的 `open(signal)` 回调不携带流 token，跨重试道的稳定身份仍是 endpoint+payload 摘要
> （`streamOpeningKey`）；真正的 per-stream token 或宿主侧首帧期限见 `docs/progress/todo/upstream-proposals.md` §3/§8。
> **退役 tripwire**：`verify:upstream-lifecycle-contract`（四方注册）钉住 pin 源的两半——宿主 `follow` 仍以 opening snapshot 开帧且无期限、
> 客户端 `doOpen` 仍无界 await；上游任一半落地期限时该门禁转红并点名「退役客户端加宽阶梯」。
> ② **页面生命周期**：六个账本由**单世代注册表**（`sourceId → {epoch, incarnation, state}`，`packages/dsh-stream-state`）的投影持有——指纹变化只在权威 roster 刷新处 `reincarnate` 换代，事件携带捕获的 epoch（错代丢弃），退役经 `retainSourceIds` 出表；App 侧只剩活视图（P4：删 `incarnationKey`/`retainSources` 键式记录面）；
> ③ **露屏**：遮罩分类与会话面持有合为一次 `decidePresentation`；帧带 `veil`（released/held/actionable）与绝对 `releaseAtMonoMs`，
>    只有 `planVeilTimer` 能把期限换算成定时器（held 必 >0ms），hero/settling 越 70s 外层保险即 `actionable` 揭示租客、
>    absent/unknown 走 2s 兜底、未 settle 过了反馈窗给可操作面（P2：删除「越界后 0ms 重臂仍不出租客」的旧形态；`unknown` 不再折进 hero）；
> ④ **等待形状**：`withDeadline` / `waitForCondition` / `retryDelayMs` / `createSingleFlight` 四个原语替换手写计时器记账
> （B6 七站点中 W1/W2/W3/W5/W6 已迁；W4 不做，W7 因异步探测不适用）；
> ⑤ **阈值**：四条阶梯的值集中于 `tables.json` 的 `ladders`（`mobile` / `authority` / `streamHealth`），
>    消费方直接读表（producer probe、App escalation、mobile、open-in）；`scripts/gates/verify-ladder-table-parity.mjs`
>    保留为「未来本地声明」的漂移守卫（自测见同目录 `.test.mjs`）。阶梯**调度半**（tier/cooldown/配额/窗口/证据门）由
>    包内 `planLadder` 单源持有；**边界**：open-in 的具象 `resync()`、producer 权威执行端的 I/O 仍在宿主，
>    引擎只持调度（字段级注记见 `ladder.ts` 的工厂）。
> ⑥ **时间与账本**：`src/time.ts` 是「可用钟/滚动窗口」的唯一所有者——NaN/±Inf/回拨只保守持有（never release/0ms），
>    `rebuildsAt`/dispatch 账本只在窗口内保留；适配器不再各自比较时间戳（G-B/G-C/G-F）。
> ⑦ **取证**：包内 `forensics.ts` 是唯一常驻环形缓冲（默认 cap 256，记录时脱敏，非有限时间戳保守为 0）；api-gateway 的
>    `StreamForensicsReporter` 记录每次载波决策（含 `carrier-rebuild`/`carrier-throttled` 事实），探针经
>    `dsh-chamber:stream-forensics-request` 触发 `ForensicsSink` 导出（逐条 snapshot 事件），live 页事件不变（P5）。
>    对照数据以 `node scripts/refactor/stream-state-metrics.mjs --check` 的输出为准（集成后快照见
>    `scripts/refactor/stream-state-baseline.json`）。
>
> **会话事实单一权威（P0–P5）**：
> 运行位/「静默完成」不再有第二套判定。纯 reducer `session-authority.ts` 持有每会话 episode、
> N=2 权威确认与恰好一次的完成边沿；`ladder.ts` 的一个引擎以两个实例运行（producer 的 probe
> ladder + App 的 reconnect/notice escalation）；producer 执行端
> （`packages/dsh-chamber-client-core/src/session-fact-reconcile.ts`）只做官方 store 读、独立 unary 读与 tier-3 写回
> （只写 false、写后自校验）。旧 `renderer/src/session-liveness.ts` planner、190s 回执链
> （官方 refresh 相位 + 有界重试）、`authority-decision.ts`、`usableFacts` 抑制与第二完成入口
> 均已删除；完成通知由 `notification-projection.ts` 单点裁决（两条证据、一个账本键空间）。
> 异步读写的归属也由同一 reducer 签发：每次 running episode 有单调身份，`readRequested`
> 产生带来源代际与 episode 集的读票据；仅最新待读票据能提交基线，已结束或重跑的 episode
> 不消费旧读。`correct` 效果另带唯一写票据，结果须同时匹配写票据与 episode，旧写回不能
> 结算同名会话的新运行轮次或同轮重试。producer 保持单飞，但在途收到的请求会合并成下一次
> 官方 store tick；来源换代时清空 probe 配额/故障证据，在每次 await 后核对代际，销毁后
> 不再写回或发布快照。一个读轮中若形成多个独立 `correct` 效果，执行端逐个结算。
> probe ladder 的 `sticky` 直接取 reducer 保留的 episode：官方列表尚未完整时，原有运行轮次
> 不会因当次缺席而消失；独立列表只覆盖部分轮次时，未覆盖项保持故障证据，不能记健康进度。
> **缺席作证**：unary 全量列表缺席 + 两次独立读一致 ⇒ 判 stale 并可写回（此前「缺席一律
> unknown」的保守口径被裁决替换，由 N=2 与 host-wins 自愈兜底）。
> **被否替代**：① 保留官方 refresh 作为每轮首个相位——vendor `refreshList()` 对失败照常
> resolve（观察不到），等于第二层不透明兜底，且 refresh 成功路径不能替代独立读的证伪面；
> ② 保留 App 侧第二 planner——同一事实两个所有者，跨模块不变量锁不住；③ 用 TTL/latch 在
> 显示层覆盖 running 位——第二份权威，TTL 到期旧位复浮（首版方案已被否）。
> **Rejected alternatives（异步归属）**：只比较来源代际会放过同代快速重跑及同轮写回重试；
> 只在执行端加序号不能约束纯 reducer 的迟到结果，也不能让 `correct` 效果携带其归属；
> 丢弃在途新增的 tick 请求会让换代后的首个对账必须等下一次外部广播。票据与 episode
> 身份因此由 reducer 持有，执行端只执行票据并合并新的 tick。
> 仍未闭合：阈值真机校准（60s probe / 190s reconnect / 310s notice）、ssh 远端写回时延、
> macOS 腿、动作的**集中日志面**（机内 Local Storage 有界环 `dsh-chamber.authority-log.v1`
> 已落、跨重载可回读；控制面集中 verb 未做）。
> 校准程序见 [session-authority-calibration.md](../checklists/session-authority-calibration.md)。

**被否方案（重构评审）**：

| 方案 | 为什么否 |
|---|---|
| 保留各执行器的分散判定，只在其上加锁 | 锁只能串行化同一进程内的调用；被否是因为它锁不住**跨模块不变量**（同一时限两份记账、同一阈值两处取值、同一载波两个所有者）——本轮三类症状都出自这类不变量 |
| Swift 与 TS 各写一份载波契据、各自维护 | 漂移无法机器检出；载波阈值由纯 TS 包所有，Swift 的 `CarrierDecision` 只镜像所需决策，由 `scripts/gates/verify-stream-state-swift-parity.mjs` 与 `verify-ladder-table-parity.mjs` 钉住。Swift 窗口恢复由原生 `RendererHangWatchdog` 和 `RendererRecoveryPolicy` 所有。 |
| 把 DOM 适配与提示运行壳也收进纯包 | 纯包必须零 import（`packages/dsh-stream-state/scripts/test.mjs` 会红）；DOM 面是各宿主特有的、与「单一所有者」判据无关——mobile 的约 9 成行数正由此构成 |
| 把所有等待形状都换成原语 | `host-graph` 的异步探测重试环表达不了（`waitForCondition` 的谓词是同步的），`journal-stream` 的 `AbortSignal.timeout` 已是标准原语；故逐站记录「不迁」而非硬套 |
| 用「mobile 主模块 ≤150 行」作为阶梯单源的验收 | 原定值以「mobile 只保留薄适配」为前提，实测该模块约 9 成为 DOM 与运行壳；被否的理由是**压行只能靠把代码搬到兄弟文件（总行数不变）**——那正是本次重构要消除的自欺。改以「阈值与规则单源 + 决策核心无本地阈值」为判据 |

**Swift 载入状态所有权**：原先的 `LoadState` TS/Swift 镜像从未接入 Swift 生产恢复链，现已退役；原生探针、重载预算和失败页面的所有者是 `RendererHangWatchdog` 与 `RendererRecoveryPolicy`。保留 `CarrierDecision` 的跨语言锁步，因为载波阈值仍由 TS 表提供。**Rejected alternatives**：把 `LoadState` 再接到 Swift 恢复链会形成两套探针计数、重载预算和失败判定；只保留镜像与测试则继续让未执行的模型看似覆盖了原生行为。

**不变量契约（反补丁波次，门禁先行）**：下列七条是流状态链的验收不变量；每条都有机器门禁，
且门禁先于修复提交（红先于绿）、都带负控——「无门禁的修复」不进入本链。

| # | 不变量 | 判据 | 门禁 |
|---|---|---|---|
| I1 | 无出口不等待 | 每个等待有期限+触发者+可见出口；拒绝必须产生动作或状态迁移（禁止零动作） | G-B（时间纪律 fuzz）、G-E（遮罩释放） |
| I2 | 单一所有者 | 阈值只在 `tables.json`/`tables.ts`、决策只在包内；宿主不得持有可漂移副本 | G-G（阶梯/载波锁步）、G-H（导出无死面） |
| I3 | 世代封闭 | 事件只作用于产生它的世代；跨代投影不可表达 | G-D（incarnation fence；P4 注册表） |
| I4 | 时间可信 | 非有限/回拨只能保守不动作/保守持有，绝不解除保护、绝不 0ms | G-B、G-F（Swift 镜像锁步） |
| I5 | 可见性有上界 | 遮罩必有绝对 `releaseAtMonoMs` 或终局态，到期必须揭示 | G-E |
| I6 | 无死面 | 事件/效果/相位/导出字段 ↔ 生产消费者一一对应 | G-A（发射面覆盖）、G-H |
| I7 | 可证伪 | 每条不变量有门禁/测试且带负控（self-test / 负控用例 / 变异） | 各门的 `--self-test` 与负控用例 |

**反补丁波次被否方案**：

| 方案 | 为什么否 |
|---|---|
| 先修行为、门禁后补 | 修复的判据本身无人钉住，回归不可预防；改为门禁先行（P0 全部门禁先红，逐阶段转绿） |
| 在调用方加守卫（App 补一次 retainSources、渲染器给 0ms 加节流、api-gateway 加宽计时器） | 不变量留在调用方，任何新调用点都能绕过；改为所有权归位：阈值进表、决策进包、执行器只执行 effects（G-A/G-G/G-H） |
| 新旧路径并存过渡（运行时开关 / 影子实现 / 双写） | 双实现期间差分不可判定且旧路径仍可达；每阶段同一变更删除被替代实现（G-H 无新增豁免） |
| forensics 落盘做成 overlay / 新控制面写面 | 控制面 v1 只接入不新增执行面；overlay 另有 pin 升级负担与 C 门漂移；改为包内 bounded ring + `ForensicsSink` 经既有诊断通道导出，桌面复用 sidecar 崩溃路径 |
| 移动/触屏档靠客户端加宽超时兜底 | 根因在宿主 `session/follow` 无期限，客户端加宽只把等待拉长；服务端流级期限为主、共享客户端半边为辅，两层各自 fail-closed + flavor parity |
| 为让门禁变绿而放宽既有安全/parity/golden 断言 | 门禁是契约不是目标；红必须先给出修复或具名豁免+退役条件 |

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

- **会话事实单一权威（P0–P5，Swift 原生版「深度求索中」永久卡死修复）**：
  ui-chat 的运行指示器由官方 session 的 `running` 位驱动
  （`dsh-client-ui-chat`: `running = useSession(s => s.running)` → `TurnStatus` →
  `chat.deepDiving`），而该位只由 mux `$events` 流上一条 **emit 型转发事件**
  `api-session/status` 递送（`dsh-api-session-controller`: `handleSessionStatus` →
  `handleRunning`）。emit 无重传、`$events` 开场帧不重放会话状态（独立复核
  逐行核实）。官方另有两条**非周期**写 running 的路径——会话物化时按缓存 summary
  播种、`refreshList()` 把权威 summary 的 running 回灌（`connection/reset` →
  `handleConnected`，以及首次 apply 期）——但**没有任何周期性触发点**（全树无官方
  `sessions.refresh()` 调用者、无 session.list 轮询）⇒ 稳态下丢一帧或 carrier 静默
  半死时该位永久为 true（客户端零超时、零出口）。**残留故障类要精确命名**：传输层已有
  周期性 liveness（宿主 mux 2s×2、控制面浏览器腿 30s×1），已覆盖的是「socket/心跳死亡」；
  本节针对的是「**socket 与心跳全健康、而宿主侧转发事件源停摆**」（fiber 被 dispose /
  源静默；emit 无重传也无游标）——这一类没有任何现成触发器。宿主侧无责：agent loop 在
  `finally` 必写 `turn/end`。**§D4 的 liveness 触发器覆盖不到这一类**（它们全部要求
  OS 级事件：唤醒/网络/可见性；窗口可见且机器未睡时一个都不响）。
  修复 = **单一权威链**：决策半是纯包 reducer `packages/dsh-stream-state/src/session-authority.ts`，
  调度半是同一个 `ladder.ts` 引擎的两个实例（producer 的 probe ladder + App 的 escalation
  ladder），执行端是 `packages/dsh-chamber-client-core/src/session-fact-reconcile.ts`
  （只做 I/O），通知面是 `packages/renderer/src/notification-projection.ts`（单入口）。
  旧 `renderer/src/session-liveness.ts` planner、190s 回执链（官方 refresh 相位 +
  有界重试 + verdict 分支）与 `authority-decision.ts` 已删除。
  **① probe（读，不是升级）**：某来源持续 running ≥ 60s ⇒ probe ladder 派遣一次独立
     unary `session.list`（控制面 HTTP 代理，与被守卫的 WS 事实通道是**两条载体**）；
     节拍 = 200s（= 滚动窗口 10min / 配额 3：均匀铺开，避免 60s 节拍在 120/180/240s
     爆发用完窗口后失明 8 分钟）；门槛 60s 只影响「丢帧 → 纠正」的最快可见窗口。
  **①b tier-3 写回（彻底修复；只写 false）**：独立读**正面证伪**（官方说 running、权威说
     没在跑）且**两次独立读数一致（N=2）**才写；目标 = 已确认证伪 ∩ 此刻 store 仍
     claiming running（幂等、最小写面）。写进官方 store 自己的公开写路径
     （`ClientSessions.handleSessionStatus(id, false)`；`ISessions` 契约只暴露
     `refresh()`，故此面属**上游公开但非契约**的方法）——一次调用同时改侧栏摘要、
     物化 Session 的 `running`（聊天面「深度求索中」）与子代理 activity。写后**自校验**
     （等一个宏任务让 store 投影 flush，迟一拍再等一拍；全部掉落才算成功）；写回缺失/
     失败/自校验不过 ⇒ 记 stuck 证据，允许升级。纪律：**只写 false、从不写 true**；
     **无 TTL、无 latch**——后续任何成功的官方基线与状态事件都能覆盖写入（host 永远赢）；
     方法面缺失 WARN 一次后降级升级阶梯。**为什么需要它**：官方 `refreshList()` 对拉取
     失败照常 resolve，且 store 快照**不暴露** `state`/`error`（`projectList()` 只投影
     ids/byId/current/phase/…），因此「refresh 成功而 running 未回灌」与「官方
     `session.list` 单飞悬挂」在契约内没有任何纠正路径——写回是仓内唯一不依赖上游修改的
     确定性修复动作（用户裁决：**不新增 fork、不改上游**）。
     **缺席作证**：unary 全量列表缺席 + 两次独立读一致 ⇒ 判 stale（此前「未覆盖一律
     unknown」的保守口径被裁决替换），残余是宿主返回**不完整列表**（无完整性信号），
     由 N=2 与 host-wins 自愈兜底。
  **② reconnect（App 升级 ladder，要求 stuck 证据）**：probe 读失败/写回失败产生
     `stuckSince`；只有带 stuck 证据、且症状年龄到 190s 才派发一次
     `reconnectInstanceConnection`（复用 S2 watchdog 的杠杆与**同一份 per-source 记账**：
     同 tick 去重集合 + 跨 tick 的 60s 账本；账单在 App，producer 用 `escalationBlocked`
     避免被丢弃的派遣吃掉 ladder 配额）；**local 刻意不排除**（本次缺陷现场就是本地实例）。
  **③ notice（App 升级 ladder）**：症状 310s（= reconnect 190s + 原 120s 宽限）、仍有 stuck
     证据 ⇒ 顶部非模态横幅（重连 / 重载应用页面 / 忽略），**绝不自动重载**（与 mobile
     `session-stall.ts` 同纪律）；`progressStamp` 前进（一次健康裁决）即撤销。
  **核心取舍**：升级的唯一依据是「拿不到权威结论」，不是「沉默很久」——长工具/长推理
  的合法静默与真卡死在 App 层不可区分，误升级（每次 reconnect 重放全部会话 baseline）
  会引入比原缺陷更糟的风暴；probe 只是读（+ 可能的写回），因此可以按配额廉价重复。
  实测依据：活跃 turn 期间宿主 durable 进展 5–21s/次（median 11s，161s 13 次），
  而合法静默可达 75s（TTFT）到数分钟。
  **被否替代（Rejected alternatives）**：
   - **显示层证伪覆盖（latch + TTL）**（第一版方案，已否）：在 App 渲染层把被证伪的
     `running` 位强制成 false 并设 TTL。否因：① 引入**第二份权威**（渲染层与 store 两份事实），
     与 design 06 §4.3「一个字段一个权威」冲突；② TTL 到期后 store 里的陈旧位会**重新浮上来**
     （把永久卡死换成周期性假「运行中」）；③ 下一次 producer push 会把渲染层修正整块写回原地；
     ④ 只治侧栏，聊天面与订阅同一 `running` 位的完成边沿/子代理计数照旧。改为**写进 store
     本身**（①b tier-3）：一次修复覆盖全部消费面，且无 TTL、无 latch。
   - **保留官方 refresh 作为 probe 的第一相位（或保留 receipt 计数/相位预算）**（否决）：vendor `refreshList()` 对失败**照常 resolve**（只置 `listState='error'`），
     `ISessions.refresh()` 又把结果抹平成 `Promise<void>` ⇒ 对账侧观察不到「这次 refresh
     其实没应用」；相位预算/重试/verdict 分支只增加了第二层不透明兜底，而独立 unary 读本来
     就是唯一可判定「官方位是否真的回灌」的证据面。删除后 probe 只剩一条载体、一次读
     （N=2 时两次），语义与成本都可单测。
   - **新增 `dsh-api-session-controller` fork**（用户裁决：不做）：根治「事件源丢失」
     要改 host 半的 emit 与 client 半的订阅（上游 `packages/api/session-controller`），而该包
     **仓内没有 fork**（现有三个 fork 是 connection / client-web / api-gateway-client），新增
     fork 要背 registry 单源登记 + C 门 + 每次 pin 升级的 rebase。裁决 = 先用仓内杠杆把
     「丢帧 → 纠正」做成确定性收敛，同时把两个契约诉求提上游（proposals §4）。
   - **在宿主内 seed 一个「状态再断言」包**（根治源端 暂缓）：`api-session/status`
     的转发白名单是 host 全局的（`dsh-api-remotes` 的 `remote-events.ts`），所以 chamber 的
     seed 宿主包本可监听 `agent/status` 并周期性再断言——不改上游即可让**所有**客户端（含
     官方 UI）免于丢帧。暂缓原因：只覆盖 chamber 能 seed 的实例、需重启生效，且与 design 13
     的保护集合/注入流程耦合；登记为后续根治选项，不阻塞本次仓内修复。
   - **把运行位权威下放进各宿主自己的停滞阶梯**：mobile/desktop/Swift 各有自己的停滞面；
     权威只允许一个所有者（纯包 reducer + producer 执行端），各宿主的阶梯只调度自己的面
     （mobile 的 DOM 停滞、open-in 的对话流健康），不复制 running 位判定。
   - **只做 ③ 横幅、不做 probe**：`running` 位不会收敛，用户唯一出路是整页重载
     （丢页面状态），而真正的收敛动作其实只是（最多）两次独立 `session.list`（N=2 确认后可能写回一次）。
   - **用 disconnected/close 事件驱动升级**：本次缺陷本体是「carrier 静态半死、socket
     不 close」，事件根本不发，按事件升级只覆盖已经自愈的那一半场景。
   - **决策机放进 client-plugin 直接盯官方 running 位**：插件拿不到 App 的 reconnect
     杠杆与 registry 代际，且每个挂载页各持一份预算（多 ctx 放大成 N 次对账）；现形态把
     决策放纯包、执行放挂载 producer、升级放 App。
   - **改 vendor 在宿主侧加日志/心跳**：pin 升级即丢，违反「不改上游」边界；诊断价值
     已由 P1 的两处落盘（02 §3.8 与 25 §3.1）拿到。
   - **把 local 也纳入既有 S2 重连臂**（最省的想法）：S2 的判据是「mounted 快照静默」
     ——本缺陷里工作区/会话列表的推送照常活着（丢的只是 status 事件）⇒ 源看起来「新鲜」，
     该臂永远不响；权威必须按**运行位本身的收敛证据**判定，不能复用快照静默。
   - **改用 App 每 30s 兜底 unary pull 的权威 running 行直接对表**：挂载源的 `aggregates`
     会被 producer push **整块覆盖**，而 push 与 runtimeFacts 同源于官方 store ⇒ 两份事实
     不独立；push 会作废在途 pull；该 pull 只在源 stale 时发生，推流存活的源根本不拉。
     要覆盖「丢一帧而流仍活」必须另加旁路采样面——现形态的 probe 就是那条旁路。
   - **把一次读失败当成失败事实立即升级/写回**：读走控制面 HTTP 代理、被守卫的是 WS 事实
     通道，一次 502/代理重启就会拆流并把全部 baseline 重放一遍；读失败只记 `stuckSince`，
     reconnect 仍要等 190s 的症状年龄，写回更要 N=2 一致。
  **未闭合**：**权威清单与逐条失效判据见 `docs/progress/STATUS.md`「会话运行位卡死」
  条（编号以 STATUS 为准）**；与本设计直接相关的形态摘要：
  ① transcript 与运行位可能分别收敛（STATUS ②，需上游逐流交付统计/游标）；
  ② 官方 `session.list` 单飞悬挂时 store 自身的 `listState` 永久 loading，只能靠
  「重新加载」收口——但侧栏/聊天面的**事实**仍由写回纠正（STATUS ③）；
  ③ 子代理会话不在事实通道（STATUS ④）；
  ④ 隐藏期不 tick，恢复补偿 tick 按**累计** running 时长判定（STATUS ⑤）；
  ⑤ 权威动作落有界 ring + renderer console，并写入机内 Local Storage 持久环
  （`dsh-chamber.authority-log.v1`，跨重载可回读）；控制面集中日志 verb 未做（可选增强，STATUS ⑩）；
  ⑥ `handleSessionStatus` 是非契约方法面，pin 升级移除/改名即降级为「WARN 一次 + 升级
     阶梯」——能力守卫 + 接线锁在 `packages/renderer/test/wiring/session-authority-wiring.test.ts`
     与 `packages/dsh-chamber-client-ui-sidebar/test/session-state/session-fact-reconcile.test.ts`，
     两个上游诉求见 `docs/progress/todo/upstream-proposals.md` §4；
  ⑦ probe/reconnect/notice 阈值（60s / 190s / 310s）与 ssh 远端写回时延未在真机校准——
     程序见 `docs/checklists/session-authority-calibration.md`；
  ⑧ 未挂载/已回收来源没有 producer ⇒ 不在权威输入内（其事实由 30s unary 兜底直供；
     读取失败导致的冻结保留仍是 STATUS 的未闭合门）；
  ⑨ 宿主返回**不完整列表**是唯一无法在仓内区分的残余（无完整性信号），由 N=2 与
     host-wins 自愈兜底。
  另：写回把卡住的 running 位压回 false 时，官方 store 的 `running` 边沿照常触发
  完成蓝点/通知——通知由 `notification-projection.ts` 单入口裁决（有可判 facts 的来源
  完成归 facts、其余归壳边沿），用户能看到这一回合确实结束了。
- **控制面日志落盘（取证缺口修复）**：动机在本节——控制面自身日志
  （含 WS splice 的 `WebSocket stream <id> closed (<cause>, Nms)` 与
  `heartbeat lost …`）此前只交给注入的 logger（默认 console），而打包态从
  Finder/Dock 启动时 stdout/stderr 不落盘（实测 `log show --predicate
  'process == "DSHChamber"'` 无输出）⇒ 两类 flavor 的这条归因证据都等于丢失。
  **落盘规格归 design 02 §3.8 拥有**（`<stateDir>/logs/control-plane.log`：JSONL、
  有界轮转、0700/0600 + 不跟随符号链接、写失败降级告警一次；控制面拥有 stateDir，
  故两 flavor 共用同一实现）；原生壳侧 sidecar stderr 的对应面归 design 25 §3.1
  （`<userData>/logs/sidecar.log`，见那里的规格）。**未闭合**：真机事故下
  「`WebSocket stream … closed` 行确实可检索」未经实测（见 STATUS）。

- **对话流健康臂（纯 chamber 代码）**：本节阶梯覆盖不到的那类真机卡死的收口。
  - **缺陷本体（已复现）**：连接代际仍 ready 时连续载体丢失 ⇒ 上游
    `waitForRemoteStreamRetry` 把 `RemoteStreamCarrierError` 抛成终局 ⇒
    `Session.failEventStream()` 把 `openState` 锁成 `'error'`（窗口保留、流不再重开），
    官方聊天面只在列首渲染一行 `chat.loadError`。headless 复现：同一 mux socket 在
    1.2s 内被拆 4 次（`closeAll` + `killNext(3, 25ms)`），页面此后不再重发
    `session/follow`，DOM 冻结在 213 行 / 92 turn；对照跑（同一抖动、快照被接受）journal
    正常重开 ⇒ 是 race 不是必失败。真机同形证据：`13:35:47.689Z local closed
    (upstream close, 368803ms)`（用户报障前 91s）与该源两个子代理会话同时冻结。
  - **杠杆与其硬边界（rc.2 复核）**：`ISession` 公开契约无 `open()`；`Session.open()` 由
    呈现路径驱动——`service.retain(target, { source })` 会
    `reference.attachOpening(manager.get(id).open(), signal)`：rc.2 的 presentation 归官方
    view owner（ui-workspace `openSession` → `replaceMain` 的 retain/release），shell 只经它
    路由，但该路径只对 `openState !== 'open'` 生效（`'loading'` 的在途 promise 与 `'open'` 都短路）。
    健康臂的**唯一自动杠杆**是具体对象的 `Session.resync()`（公开于实现类、经 loose 结构切片读取；
    具象 Session 本身经 rc.2 契约入口 `ISessions.binding(id)` 取得——返回持有 `.session` 的
    retain binding——形状不符或抛错一律 fail-closed）：非
    `'cold'` 时递增代际、释放旧事件流、清 `openPromise` 并重跑 `open()`；rc.1 的 stage
    迁移（开邻居再开目标）随 `ISessions.open()`/`SessionListState.current` 一起删除，不存在
    第二条自动重开路径。呈现事实也不再读 `current`：以列表行的
    `retainedBy.mainView > 0`（与 ui-session 绑定中心列同一事实）判定 target 是否在台上；
    address-only 子代理同样经官方 retain 呈现，不再需要旧阶段“current 且在列表里”的前置。
  - **落地**：`packages/dsh-chamber-client-ui-open-in`（既有的 per-instance 头排座席宿主）
    新增 `src/client/session-stream-health.ts`（纯决策：error 满 8s 自动 resync 重开，
    冷却 120s、滚动窗口 10 分钟 ≤3 次；**已执行的 heal 过了 settle 窗（8s grace + 20s）
    而流仍是 error 即 latch「对话通道未恢复 + 重新加载」按钮**，自动重试照旧——修复前要等完整预算耗尽才出按钮，最坏 ~296s，期间 chip 显示「正在恢复对话…」。判据挂在
    `lastHealAt` 的 **settle 时钟**而非 `'healing'` 相位：重开自身会同步报 `loading`
    （vendor `doOpen()` 在首个 await 前写 `openState`），隐藏期会把相位清零——按相位判定
    会把按钮吞掉（评审实测：28s → >128s，flapping 重开甚至永不 latch）。latch 随
    loading 驻留、只有**观测到**恢复（open/cold）才清除并结束本次「回合」，之后的报错按新
    错误重新起 grace——若恢复发生在隐藏期（观测不到 `openState`），回前台第一帧即按 settle
    钟给出提示（那仍是唯一有效的动作）；loading 满 20s、或阶梯无杠杆时给同一提示）、
    `src/client/session-stream-health-probe.ts`（经 `ISessions.binding(id)` 的具象 `Session.resync()` 能力守卫、`retainedBy.mainView` 呈现判定与面形状读取，全部 fail-closed）、
    `src/client/SessionStreamHealthChip.tsx`（`conversation.session.header.actions`，
    list/session 作用域：只显示，绝不自行重载）、`src/client/session-stream-health-seat.ts`
    （座席注册 + **按会话持有的阶梯状态** + 非抛错的 vendor 面读取）。两条 review 修正写进
    契约：①**阶梯状态在座席而不在组件 ref**——会话子树按绑定 key 挂载，切会话即卸载，
    ref 会让同一会话每次访问重获 grace/冷却/预算，storm bound 失效；②自动 heal 有**前置
    条件**：target 必须仍是 main view 呈现的会话（`retainedBy.mainView > 0`）且具象
    `resync()` 经 `ISessions.binding(id)` 可达（rc.2 契约入口），否则 tier 被 blocked、由页面 delivery resync 兜底（`healRoute=false`
    证据；未 flush 的旧 effect 不得抢回用户已切走的会话）；address-only 子代理经官方 retain
    呈现，不再有旧 stage 迁移的 listed/邻居前置。控制面侧只保留一条取证日志：握手完成前下游腿离开时记
    `WebSocket upgrade <id> abandoned (downstream close before upstream handshake, Nms)`
    （归因边界：控制面自身 `revokeTransportTraffic`/`closeAllStreams` 拆 socket 也走这一行，
    不可单独据此判定“浏览器主动离开”）。
  - **触发面：做完又被否掉的一条（review 证据链）**。原设想是让控制面在上游腿
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
    （理由见上一段：掩码与帧边界两条协议约束）；**把滚动预算缩短/提前耗尽以换取更早的
    「重新加载」按钮**——拒：预算是防风暴的硬界（缩短等于允许更频繁的自动 `resync()`），而
    「按钮何时出现」是呈现问题，正确修法是首次判失败即 latch（见「落地」段）；
    **把 latch 判据挂在 `'healing'` 相位上**（首版实现 评审否决）——拒：重开自身
    会同步报 `loading`、隐藏期会把相位清零，相位门控实测让按钮被吞（28s → >128s，flapping
    重开甚至永不 latch），改为挂 `lastHealAt` 的 settle 时钟；**恢复后仍沿用旧回合的 settle
    钟**（评审发现的次生反例）——拒：会让新错误第一帧就出提示、跳过自己的 grace，改为
    `recoveredSinceHeal` 回合标记。
  - **未闭合**：`openState === 'open'` 但静默的半死形态仍无自动杠杆（无 applied cursor
    水位时与合法长静默不可区分），收口两条：宿主侧流级 keepalive 仍未做；「让 carrier 失败永不终局」已落地（见下条）；自动重开的**实机验收未做**（判据 = 真机抖动后自查恢复，且 `local closed (upstream close, …)` 的频率不再随浏览器卡顿波动），阶梯阈值（8s/20s/120s/≤3）与 `presented` 判据的近似（document 级 `[data-chat-flow]` 存在性，非「实际可见」）同样待真机校准

- **载体故障的用户可见面**：治因 = `packages/dsh-api-gateway/src/client/remote-stream.ts` 在活世代下用有界退避（250ms 起翻倍、10s 封顶，与连接车道自身 `backoffMaxMs` 同值）重开而不逃逸为 `gateway/internal`；信号面 = 该包 `$stream` 工厂组合 `carrierFailed` 成有界页面事实
  `dsh-chamber:stream-carrier-failed`（`stream-carrier-fact.ts`：计数 + 时间 + 实例 id + 截断消息，dispatch 抛错被吞，绝不打断重连），由 open-in 的健康臂座席按实例过滤后喂进纯决策模块，chip 以 `role="status"` 显示「对话流正在重新连接…」（信息性、不给「重新加载」按钮，超过 `carrierChurnMs` 自行消退）。**接线要求（修复，C1）**：事实落在座席闭包而非 props，座席必须把每次落地的 churn 广播给渲染侧（`subscribe(listener)`），chip 订阅后 bump tick 重规划——否则 `openState === 'open'` 时 ticker 停摆，提示既不出现也不会过期（原实现只有「事实进决策」没有「通知渲染」）。
  - **拒绝替代**：（a）不做可见面——拒：去掉终局逃逸后，用户再也分不清「流在重连」与「会话本来就安静」，这是本补丁引入的静默窗口；（b）客户端插件在打包期 import 该 fork 的事件常量——拒：client plugin 不应加深进 fork 的 import 路径，故字面量复制并由 `packages/dsh-chamber-client-ui-open-in/test/ui-lock/instance-view-guard.test.ts` 把两处拼写钉在一起（vendor-lockstep 先例）；（c）ctx service seam（fork 消费 chamber 提供的服务）——拒：fork 的探针面会被 chamber 插件的存在绑住，而页面事实在座席缺席时也无害；（d）让 carrier 失败重新终局——拒：正是本次要修的根因。
  - **未闭合**：churn 提示窗口（10s）与按来源归属的粗粒度未在真机校准（STATUS ⑬）。

- **逻辑流开帧丢失与首帧期限（ui-chat 卡死排查的根因修复，chamber fork）**：
  - **缺陷（已实证）**：本地实例的 mux socket 在负载期被页面每 ~20 s 重连一次（`control-plane.log` 3 天 233 次 `WebSocket stream local closed (browser close, …)`；09:04–09:10 七分钟内 15 次，寿命 17.4–21.1 s；远端实例同时段 socket 活数分钟），而 `RemoteStreamMuxClient.open()` 的 `waitForSocket → send` 之间存在窗口：socket 若已被替换或正在关闭，RFC 6455 只在 CONNECTING 抛错，CLOSING/CLOSED 上 `send()` **静默丢弃**载荷 ⇒ 该逻辑流既收不到任何帧、也不会有任何错误。首开场景下 `openState` 永停 `loading`——vendor chat 视图**仅在该态**渲染 `chat.loadingHistory`（`dsh-client-ui-chat/lib/client.js:2515`）——而已开启流表现为 transcript 静默截断；载体、unary 读、`RemoteJournalStream.open()` 三处**都没有期限**，健康臂又全部以 `'error'` 边沿为条件，于是唯一出口是 ⌘R。子代理视图同形：宿主对已结束子代理也能 73 ms 返回快照（本次实测），`loading` 卡死与目录/mode 无关。
  - **落地**：① `stream-client.ts` 开帧前校验（socket 非当前或非 OPEN ⇒ `RemoteStreamCarrierError`，进既有退避重开道）；② **逻辑流首帧期限**（30 s 起，连续超时 ×2 放宽、封顶 300 s（30→60→120→240→300）；失败**绑定 inbox**，绝不 abort generation signal——那会让重试道终局化）；③ `journal-stream.ts` **静默看门狗**：已开启 journal 静默 ≥45 s 时开一条旁路 sibling follow（20 s 期限），只读 opening cursor，**仅当宿主确已前进**才替换物理世代（新 opening 走 `replace` 收敛全窗口），未前进即判合法静默、不动；④ `dsh-chamber:stream-forensics` 有界页面事实（socket lost/reconnect/attempt-failed/disposed、opening-timeout、generation ready/lost）补上「谁在抖」的取证面（attempt-failed 让「没有任何逻辑流在等、却一直被静默重连」也可见）。独立复核后的加固：首帧预算按 **endpoint + payload 摘要** 分账（一个慢会话不再被别的流重置，也不再重置别人）；mux 在 socket 丢失后自行**重排**重连（最小间隔 1 s，仅真实失败翻倍、封顶 10 s，成功开帧即复位；**连接泵下令的重连不计失败**、从基线上重新计），并给**握手本身**加 30 s 期限（构造抛错也转成同一类失败），不再等连接泵（连接泵的世代源正跑在同一 mux 上，等待它是循环依赖；而「只补一次」的节流会让「开帧后 1 s 内死亡」与「补连自身失败」两种情况永久停摆——复核实测）；`prepend`（历史翻页）的用户触发读带 60 s 期限（它走 lifetime signal，世代重启无法中止它）；探针节奏上限收到 **90 s**（初版 300 s，复核两轮收紧），且**探针自身失败/超时**与「宿主未前进」同样放宽节奏，探针收尾有界（否则坏探针路径会每 45 s 常驻一条 sibling follow，或让 `probing` 永久为真、静默关掉整条自愈臂）；新增 `test/behavior/journal-stall-probe.test.ts` 与 `test/behavior/mux-self-heal.test.ts` 行为用例（真实模块 + 假流/假 socket；源文本锁曾在复核中把 `next.value.value` 这个致命双层取值钉成「正确」，事故证明锁必须配行为测试），两套用例都用变异验证过真的会红（双层取值 → test 3 红；`> 0` 改成 `!== 0` → 旧游标用例红）。⑤ 会话头座席新增**用户触发**的「重建对话通道」控制：经运行时能力守卫读具象 `Session.resync()`（非契约面；缺失/形状不符/抛错一律按「无杠杆」fail-closed），与自动 heal 共用同一 cooldown + 滚动预算账本，且计划只**arm**控制、点击是唯一执行路径。它在**两个臂**里都会 arm——`loading` 停滞，以及自动 heal 被 blocked 的 `error` 状态（目标不是 main view 呈现的会话，或具象 `resync()` 不可达）——把「只能 ⌘R/重新加载」换成一次点击（armed 时必须同时给出 `heal-failed` 提示——chip 只在有提示时渲染动作区，否则按钮永远不可见且连重新加载都消失）；同时观测字段 `healRoute` 只认「target 是 main view 呈现的会话」，不再为没有台上位置的目标空耗账本。
  - **被否替代**：盲空闲超时（TTFT 75 s 起、工具可数分钟 ⇒ 必然误报并周期性重放窗口）；journal 级 open 失败闩锁（只把 loading 换成 error，不给自愈）；整连接 reconnect（不重开 journal）；把上游 `Session.resync()` 当作**自动或必需**杠杆（非契约面 + 跨包 seam，且自动重开在 'open'/'loading' 下没有合法触发条件）——它只作为**用户触发 + 能力守卫**的兜底控制落地（见 ⑤）。
  - **未闭合**：抖动触发源未钉死（ready 握手已证快速：`$events` 25 ms）；取证事实的**持久消费面**仍缺（STATUS「会话打开停滞」残余项；新增的 `opening-stall-escalation` 同此缺口，仍只在页面事件里）；首帧期限与探针阈值未经真机校准；**升级阈值同样未经真机校准**（零帧判定的「一帧未收」、第二入口的「连续 2 次超时 / 60 s 冷却」；第二入口的代价 = live socket 上每 60 s 一次载波重建，其余流被重开、实测 ~30 ms）；宿主侧首帧期限仍缺（`docs/progress/todo/upstream-proposals.md` §4.3）；`AbortSignal.any/timeout` 恰好压在文档基线的 macOS 14.4 / Safari 17.4 门槛上（仓内 sidebar 已同款无守卫使用），需一次真机冒烟；错误臂在「刚恢复后的 cooldown 窗口」内只显示「正在恢复…」无按钮（≤120 s，cooldown 到期自动重试），是否再给一个手动出口待真机观感。

- **静默载波升级：首帧期限必须能换掉物理 socket（chamber fork 第 4 个补丁）**：
  - **缺陷（上一轮修复的剩余缺口）**：首帧期限只把「没有 opening」变成一次**重发**，而重发仍落在**同一条物理 socket** 上。浏览器视角 OPEN、而载波后段静默死亡（SSH 隧道/直连 http 网关的**部分半开**：宿主→页面方向静默死亡而页面→宿主方向仍可写——代理 30 s 浏览器腿心跳由浏览器自动 pong 仍通过，宿主 2 s×2 心跳因 pong 回不到宿主而 terminate，其 FIN 同样走不回代理，于是页面收不到任何事件）时，每一条逻辑流（含 `$events`）都收不到帧：会话打开停在 `chat.loadingHistory`，而**页面内没有任何东西看得见它**——连接车道的 generation 就绪握手早已成功（车道不会因静默掉世代），健康臂的「重建对话通道」也只是在同一 socket 上再发一次；恢复只剩传输层看门狗（http ~120 s / ssh ~300 s）或 OS 级唤醒事件。此时首帧预算的**放宽**（30→60→120→240→300 s）把等待越拉越长，与「更快恢复」相反。
  - **落地**：`stream-client.ts` 的 `open()` 在发送开帧时记录**当前 socket 已收帧数基线**；首帧期限到期时若该 socket 一帧未收（`socketFrames` 未前进），按载波 reducer 的静默判定（`socketFrames` 增量；该判定已随加宽账本归共享表与 reducer，宿主侧的静默替换纯函数已退役），并走 `replaceSocket()`：与连接泵 `reconnect()` 共用同一条拆除道（bump revision、丢弃旧 socket、`failAll` 把每条逻辑流交给各自的重试道、以基线节拍立刻补连），页面事实 `dsh-chamber:stream-forensics` 记 `socket-silent`。**放宽预算刻意保留**：同一 socket 上的慢宿主仍按 30→60→120→240→300 s 拿机会；判定只看「是否收过帧」（socket 级存活证据），不看帧内容或流身份；升级不额外限速——它只能由 ≥30 s 的首帧期限触发，天然 ≥30 s 一次。
  - **teardown 分支（第 4 补丁的第二入口，独立评审 B2）**：首帧期限不是唯一的证据出口——journal 静默看门狗的 sibling follow 在 `probeTimeoutMs`=20 s 主动 abort，早于 30 s 预算，因此**已开启会话**的静默载波原样漏过（评审用仓内 fake-timer 复现：不 abort 时 30 s 换 socket，20 s abort 后 150 s 仍零替换、零事实）。现在任意逻辑流 teardown（abort / dispose / 消费者 break）时，若该 stream 的**整个生命期内该 socket 一帧未收**（`socketFrames - framesAtSend <= 0`，已收开帧自身也会推进计数 ⇒ 零增量即「始终未被应答」）且生命期 ≥ 共享表的 `SILENT_TEARDOWN_MIN_MS`（15 s），走同一条 `replaceSocket()`；`!timedOut` 保证一条 stream 一个判决，`carrier === this.socket && OPEN` 保证判决只落在它发过帧的那条 socket 上，`this.running && !this.disposed` 保证 dispose 不触发。**15 s 最短生命是必需的**：`socketFrames` 每次换 socket 归零，若只看「零帧」，任何在 socket 首帧之前被取消的流（会话切换、请求 abort、组件重挂）都会换掉一条健康载波；15 s 远高于实测应答（~25–75 ms）、又低于看门狗 20 s 探针窗口，故「探针放弃」这一目标场景仍能触发。
  - **第二个入口：同一请求连续两次未应答（第二次排查）** —— 本条此前的缺口还有「期限只失败 inbox，重试道只能在同一物理世代上重发同一个请求」：`stream-client.ts` 的开帧期限回调在同一请求连续第 2 次超时（30 s + 60 s 已放宽预算）且 socket 仍为 OPEN 时走同一条 `replaceSocket()` 拆除道（退休当前 socket、以普通 `RemoteStreamCarrierError` 失败全部待决流、从基线节奏立刻补连），并留一条 `opening-stall-escalation` 取证事实；「第一次超时永不升级」与「60 s 冷却内不重复重建」两条规则由共享 reducer（`@dchamber/dsh-stream-state` 的 `decideRebuild`，纯函数、表驱动）钉死在真值表里：载波判定在 B1/B7 收敛为单一所有者后，fork 侧的同名谓词已随常量退役。它覆盖的正是**宿主侧无期限**的那类卡死（`session/follow` 无首帧、宿主 fiber 挂住、静默半死 socket、`$events` 世代卡住）——chamber 不改宿主，于是把期限权威放在客户端载波层；宿主一旦作答即删除该请求的 streak，慢而健康的宿主（本次实测开局帧 14–273 ms，含并发/大会话/缺 maxMessages 各形态）永不被升级。行为用例 `mux-self-heal.test.ts`「an opening that is never answered rebuilds the physical carrier and recovers」与「a slow-but-answering Host keeps its carrier」，并已变异验证（关掉升级 → 前一条红）。
  - **升级的被否替代**：①只在第 1 次超时后重建——拒：慢而健康的宿主会丢掉在途答案（30 s 首额本就是为它设的）；②把 `connection.reconnect()`（整代际重建）接进 mux——拒：车道代际源自身跑在这条 mux 上，升级应停在载波层。
  - **被否替代**：(a) 盲空闲超时/无条件重开世代——拒：TTFT 与长工具调用是合法静默，必然误报（同上一条理由）；(b) 每次首帧超时都换 socket——拒：`$events` 健康而某一条 `session/follow` 宿主读得慢时，会把一次慢打开升级成载波 churn，而放宽预算正是为这种宿主设的；(c) fork 侧新增应用层心跳协议——拒：远端可跑任意 dsh 版本，改协议即引入兼容面，且代理腿已有 30 s 浏览器腿心跳、宿主腿已有 2 s×2；(d) 升级时清空放宽预算——拒：一条 socket 上的连续超时正是「单次宿主读需要 31–300 s」的保护对象，清空会饿死该形态。
  - **未闭合**：① 阈值（一帧未收 + 一次期限）**未经真机校准**：判决只证明「该 socket 静默 ≥ 一个预算窗」，一个合法静默又恰逢慢打开的宿主会被多换一次 socket（代价 = 一次载波重启 + 基线重放）；② 宿主**永不回答**（socket 活着、宿主侧 follow 卡死）不是本杠杆能治的形态，恢复面仍是座席的「重建对话通道 / 重新加载」+ 上游首帧期限诉求；③ `socket-silent` 事实的持久消费面仍缺（STATUS「会话打开停滞」残余项）。

- **首帧预算上限 = 客户端能加载的上界（校正）**：首帧期限超时不是「再等一次」，而是**取消宿主侧 follow、由重试道开一条新流**（`stream-client.ts` 的 finally 发 `cancel`），宿主因此每次从零重读 —— 于是**放宽上限本身就等于「客户端能加载的最长单次宿主读」**。原上限 120 s（4×）把「单次宿主读 > 120 s 的大会话」变成**永不收敛**：客户端在宿主快读完时把它杀掉，重试再从头读 —— 这是客户端自己造的 livelock，也是「大会话+远端+有概率一直 loading」的最后一条自伤路径。现放宽为 30→60→120→240→300 s（共享表 `OPENING_TIMEOUT_LADDER_MS`，逐级 = 连续超时数）
  - **episode 语义（独立评审后修正）**：放宽账本键是 endpoint + payload 摘要，而重建（`resync()`/heal/重载）用**逐字相同的 payload** 重开同一个键 ⇒ 修复前它会继承旧流挣来的放宽（最坏 300 s 才拿到首帧，恰好拖慢本轮新增的自动/手动重建）。现在 mux 为每条活逻辑流记录其键，**消费者离开（非开帧超时）且无同键活流 ⇒ 该键清零**：重建后的首帧回到 30 s，而重试道自己的重发仍保留放宽；账本加 256 条上限；另修一条正分析得到的停放点（同一 task 内 open+close 时 lost() 的重排因 keepAlive 尚未释放而返回）已加 queueMicrotask 补排。任何能在单次窗口内读完的宿主都收敛到内容，首次尝试仍是 30 s（丢帧路径的延迟不变）。
  - **仍未闭合（触屏档与「无按钮」窗口）**：桌面侧「已开启会话的载波半死」已由 teardown 分支收口（20 s 探针 abort 即可换 socket，行为用例 + 变异验证见 `test/behavior/mux-self-heal.test.ts`）；但移动档跑实例自带客户端栈、**没有 chamber fork** ⇒ 首帧期限与静默升级在该档都不存在，其载波半死仍无页面级恢复；桌面 `open` 臂在那 ~20 s 窗口内也**没有任何按钮**（静默 socket 不发 carrier-churn 事实），用户在这段窗口里仍只看到静默截断（真机未验收）。擦除该形态的最后一条路径仍是传输层看门狗（http ~120 s / ssh ~300 s）。
  - **被否替代**：(a) 超时后不 cancel 宿主侧流 —— 拒：消费者已离开，迟到帧无人接收，纯浪费带宽且不产生内容；(b) 重试挂接到原在途流、不重发开帧 —— 拒：与「开帧真的丢了」不可区分，后者会因永不重发而彻底不收敛（正是 修掉的原始缺陷）；(c) 无上限持续放宽 —— 拒：一个死宿主会把重试节奏拖到小时级，恢复反而更慢。
  - **仍未覆盖**：单次宿主读 > 300 s 的宿主（病态形态）；根治 = 宿主侧首帧期限（上游 §4.3），客户端到那时只剩显式失败面。
- **进入会话必须收敛：loading 的自动重建 + 硬失败面（用户裁决）**：
  - **裁决与「100%」的工程含义**：进入一个会话必须看到内容，不接受「大概率」。可证伪的表述是——① 客户端**永不停止**重试，且每一层可检出的失效都被自动升级（载波 → 请求 → 会话 → 连接代际）；② **绝不出现静默无限 spinner**：走到尽头必须是显式失败 + 动作；③ 宿主确实不能供数时（进程卡死/数据丢失）没有客户端魔法，此时给出诚实失败而不是假进度。
  - **当前所有权**：renderer 的页面级 `InstanceView` 是桌面 `loading` 自动重建的唯一执行者，独立于 vendor 会话 header 的挂载；它从 `shell.ts` 读取具象 `Session.openPromise`，只有确认为 `null`（`openInFlight === false`）、状态仍为 `loading`、且 `resync()` 可调用时才执行。页面账本按会话限制为 5 分钟内最多 2 次、间隔至少 15 s，进入停滞 2 s 后才可尝试；自动尝试在调用异步方法前记账。`resync()` 在等待旧流 `dispose()` 时尚未启动 `open()`，此时 `openPromise` 仍为空；共用能力入口按具象 Session 阻止页面与 header 重复调用，页面探针也跳过这一在途窗口，避免空耗自动预算。header 座席保留 `error` 的自动 `resync()` 及用户点击重建，但不再执行第二个 `loading` 自动臂。页面级 20 s/90 s 状态与手动重建、整页重载出口因此覆盖 header 缺席的 blank/loading。真正的 `openPromise` 在途或形状不可读时不打断；慢宿主仍吃 30→60→120→240→300 s 的逻辑流预算。
  - **为什么这条证据门是必需的**：pin 住的 `Session.doOpen()` 有三条静默留在 `loading` 的缝——非 `isRemoteFailure` 抛错（原样 rethrow）、以及 `events.open()` 成功返回时 `openGeneration`/`events` 已被推进（dispose/resync 竞争）都直接 `return`，而 rc.2 客户端只在再次呈现或 `resync()` 时才重跑 `open()`；此时 `openPromise` 已清空 = 没人在等 = 重建既不打断任何东西、也是唯一出口。
  - **Rejected alternatives / 被否替代**：(a) 盲超时自动重建（不看 `openInFlight`）会取消慢宿主的真实读；(b) 把 `loading` 一律当失败会误报；(c) 用自动重建替代 `doOpen` 状态机修复救不了宿主侧 `follow` 永不回答；(d) 继续把自动臂只放在 header，即使该臂正确也无法覆盖 header 不渲染的空白态；(e) 页面与 header 同时自动执行会产生两本独立账本和重复重建，因此桌面执行权集中在页面。
  - **unary 引导通道（评审证伪修正）**：此前「内容只有一个来源 = 宿主对 `session/follow` 的开帧快照，不存在 unary 引导通道」的论断**是错的**：`session/page` 在宿主是**冷读**（`sourceFor(..., false)`，不激活 Agent），而 `session/control` baseline 为每个 listed 会话给出 `projections[sid].asOfSeq`（= `cursorBefore(session.seq)` = `session.seq - 1`），是**合法 `throughSeq`**；`session/list` 行也带 `asOfSeq`（仅缓存行水位）。当前 pinned 客户端**没有** unary→窗口写入者（`eventSource` 只由 journal 变更管线写，`page` 只在已开启后的 `prepend` 里用）。**裁决：本轮未采纳**（收益 = 不依赖 follow 开帧，是触屏档唯一可能的自动内容引导；代价 = 与 follow 共用同一个宿主 `sourceFor`、**救不了宿主卡死**，只救「开帧在宿主→页面之间丢失」类，且属**非契约窗口写入面**），作为候选登记在上游提案 §4.3。
  - **已知近似（评审 B5/B6）**：① 桌面 `open` 臂一律 `action='none'`/`notice=null`（静默 socket 不发 carrier-churn 事实）⇒ 已开启会话的静默截断在页面上**没有任何按钮**（teardown 升级让恢复在 ~20 s 内发生，但那段窗口无信号）；② header chip 的 `presented` 是 document 级 `[data-chat-flow]` 近似，renderer 的非活动来源靠 CSS visibility 保活 ⇒ 隐藏实例可能对用户没在看的 `error` 会话执行自动 `resync()`（rc.2 唯一自动杠杆）；`loading` 的自动重建已收归 `InstanceView.active` 页面座席，不再由隐藏 header 执行。
  - **未闭合**：① 90 s 失败阈值与 20 s 停滞阈值未经真机校准（误报代价 = 一次自动重建）；② **宿主永不回答**（socket 正常、宿主侧 `session/follow` 卡死）仍只能落到显式失败 + 手动重建，根治在上游（首帧期限 + `doOpen` 必须写 `error`，见上游提案 §4.3/§4.7）；③ 移动端 `session-stall.ts` 已接同一证据门自动臂（：`sessionStallFace` 读具象 `openPromise`，`false` 才自动调 pinned `resync()`，共用同类 cooldown/预算账本，`STALL_FAILED_MS` 后文案转「会话内容未能载入」），呈现读取经 `presentedSessionId()`（只认 `byId` 里 `retainedBy.mainView>0`），但触屏档跑的是实例自带客户端栈、**没有 chamber fork** ⇒ 载波层（开帧校验/首帧期限/静默 socket 升级）在该档不存在，其恢复面只有该自动臂 + 手动重载；阈值同样未经真机校准。**注（评审 B4）**：`openPromise` 恒非空（在途 open：载波静默 / 宿主不答）时该自动臂按设计**不可达**，该形态的恢复面实际**只有手动重载** —— 真机验收不要指望自动臂兜住静默载波。

- **第三次排查（渲染进程崩溃归因轮）：两条新事实 + 三处收敛**
    1. **渲染进程在 JavaScriptCore 里崩溃，并被静默重载**（Apple 崩溃报告硬证据）：`~/Library/Logs/DiagnosticReports` 共 10 份 WebContent 报告，其中**当前构建 2 份**（`responsibleProc=dsh-chamber`）都发生在**页面加载完成后 21.0 s / 33.9 s** 的 boot 窗口内，符号化栈为 `WTFCrashWithInfoImpl ← CodeBlock::setOptimizationThresholdBasedOnCompilationResult ← …JITWorklist::completeAllReadyPlansForVM ← llint_entry_osr_function_for_call ← JSRequestAnimationFrameCallback::invoke`（**入口是 rAF 回调里一个被 OSR 编译的热函数**）；更早构建 8 份同族，走 `ScriptExecutable::newReplacementCodeBlockFor`（空指针 0x78）而入口是**嵌套 async generator 驱动链**（`asyncGeneratorUnwrapYieldResumption` ×4 + `operationEnqueueAsyncGeneratorDriver`）。崩溃后 WebKit 秒级重启 WebContent 并**整页重载**：页面重新 boot 全部 shell 与会话，这段窗口就是用户看到的「载入历史…」+ 20 s 后健康 chip；10 次里只有 2 次留下过 shell 侧 `crashed` 痕迹，其余完全静默——这是「有概率一直加载历史」的第二个独立机制，也是前几轮流层兜底**修不到**的原因。
    2. **落地（客户端热路径收敛 + 载波等待有界 + 壳侧归因）**：
       - `remote-stream.ts`：`waitForRemoteStreamRetry` 的「无活跃 generation」等待**加上界**（`REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS = 30_000`，纯策略常量）；到期**以 `'expired'` 正常 resolve**（不是终局 error），调用方随即重开——实测"车道报无世代时，mux 开流本身仍然可用"，所以重开是真正能恢复的动作；同一次到期还经既有 `carrierFailed` seam 落一条事实，把"无进展的等待"从不可见变成可见。**这推翻了上一轮 ②③ 的"拒"**：旧理由（"只会把永久 loading 换成永久 error"）针对的是抛错，而这里是 resolve+重开，且保留本集退避，不可恢复的车道退化为每上限一次尝试而不是热循环。
       - `sidebar-scroll-sync.ts`：容器未就位时的**帧内重试链加上界**（`FRAME_TIGHT_BUDGET_MS = 200`，之后回 80 ms 定时器节奏；boot 窗口里原本每帧一次 DOM 走访），并把锚行定位从"全量遍历行"改为一次属性选择器（`CSS.escape`，无 `CSS` 环境回落原扫描）。
       - `components/InstanceView.tsx` + 新纯模块 `frame-coalescer.ts`：相位采样的"每次变更排一帧"改为**合并采样**（首帧一次 + 间隔合并 + 尾部必采，`SURFACE_SAMPLE_MIN_INTERVAL_MS = 100`）——boot 窗口里原本等于每帧一次 React 同步 commit（正是崩溃栈的入口形态），语义不变（遮罩判定只依赖最终相位）。
       - Swift 壳：`RendererCrashAttribution`（纯值）+ `MainWindowController` 接线——崩溃行现在带「距上次加载完成 X.XXs（boot 窗口内/已稳定）+ 本窗口第 N 次崩溃」，恢复落地再记一条「崩溃后 X.XXs 重载完成」。归因量是静默崩溃唯一能被事后判定的依据。
    3. **仍未闭合**：JSC 崩溃本身是引擎缺陷（WebKit 22625），仓内只能降低触发概率与把状态可见化，不能消除；vendor 侧自身的 rAF 循环（chat/conversation/layout/trajectory）仍在同一批次里；页面事实的持久消费面仍是 STATUS「会话打开停滞」残余项；10:19 那次没有崩溃报告的流层卡死仍属本 D4 前三段的范围。

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
| `packages/desktop/main.ts` | 关窗分支（hide vs quit，**托盘可用门控**）；隐藏态节流 = Chromium 默认（修订，见 D1）；`powerMonitor.on('resume')` → push；`powerSaveBlocker`；退出确认（仅本地实例实际 live process，远程隧道/连接不影响关闭；**含更新安装豁免 + 单飞**）；will-quit single-flight 并行等待 plugin-sync/本地插件子进程、transport、control-plane 与 runtime 工作；`chamber-settings.json` store + `dsh-chamber:settings-get/set` IPC + push |
| `packages/desktop/preload.cts` | `settings` 面（get/set/onChanged，覆盖 chamber 级全部设置键）+ `systemResume` 订阅；`DshChamberBridge` 扩展 |
| `packages/renderer` | App 层订阅 system-resume → 分发实例重连 + transport 即时重探；**D4 升级 ladder 的宿主与呈现**：30s tick 请求 producer 对账；`planLadder` + `sessionAuthorityEscalationLadder`（阈值读 `tables.json` 的 `ladders.authority`）决定 reconnect / notice；共享 per-source 重连账本；notice 横幅 + 忽略集合 |
| `packages/dsh-chamber-client-ui-sidebar` | **D4 的执行端**：`packages/dsh-chamber-client-core/src/session-fact-reconcile.ts`（唯一 I/O：官方 store 读、独立 unary 读、tier-3 写回、probe ladder 单飞、有界动作 ring）；producer 订阅 App 的 tick 通道并驱动它，快照经 `InstanceRuntimeReport.sessionAuthority` 回流（05 §3） |
| `packages/dsh-chamber-client-ui-open-in` | **D4 对话流健康臂的座席宿主**：`src/client/session-stream-health.ts`（纯决策）+ `session-stream-health-probe.ts`（经 `binding(id)` 的具象 `Session.resync()`、`retainedBy.mainView` 呈现判定与面形状，全部 fail-closed）+ `SessionStreamHealthChip.tsx`、`session-stream-health-seat.ts`（注册进 `conversation.session.header.actions`，list/session 作用域）；error 臂自动执行具象 resync，另含用户触发的「重建对话通道」控制 |
| settings-bridge 壳 | 「通用」视图（见设计 15：固定入口 `__general` 平铺） |
| 测试 | `test:desktop`（关窗行为/退出确认/设置 store 单测）、`typecheck`、`build:renderer`（§6 验证门） |
| 控制面 | loopback-only 与对外契约**无改动**；D4 的日志落盘包装（`createControlPlane` 无条件把注入 logger 包成 `<stateDir>/logs/control-plane.log`，规格见 02 §3.8）。另加一处：「握手完成前下游腿离开」的取证日志（`WebSocket upgrade <id> abandoned (downstream close before upstream handshake, Nms)`，不动计数器；代答宿主 pong 的设想按同段证据整体回退） |

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
**D4 附加门**：`pnpm run test:stream-state`（`test/authority/session-authority.test.ts` 运行位真相语料、
`test/ladder/ladder-engine.test.ts` 引擎与工厂）、`pnpm run test:renderer-shell`
（`test/wiring/session-authority-wiring.test.ts` 架构守卫：无第二 planner / 无第二通知入口、
`test/aggregate/notification-projection.test.ts` 单通知投影）、`test:sidebar`
（`test/session-state/session-fact-reconcile.test.ts`（执行端：probe 节流 / N=2 / 写回 / 恢复）、
`test/session-state/session-authority-escalation.test.ts`（真实执行端 × App 升级 ladder 的端到端时序）、
`test/session-state/vendor-session-fact-contract.test.ts`（读 vendor 源的六条语义 lockstep；缺树默认失败）、
`test/session-rows/derive.test.ts`（含原 completed-dots-signatures / workspace-membership 的回执投影边界））、`test:control-plane`
（`test/log-file.test.ts`、`test/host-lifecycle/lifecycle.test.ts` 的落盘/reopen 端到端、
`test:open-in`
（`test/session-health/session-stream-health.test.ts` 阶梯真值表 + `test/ui-lock/instance-view-guard.test.ts` 座席接线锁 +
`vendor-heal-contract.test.ts`：retain/resync 所依赖的三条 vendor 事实的 lockstep，pin 升级语义变化即红）、
`verify:test-wiring`（**仓内全部 test manifest 必须登记在案**）、`test:swift`（ShellLogTests 全部用例，含新增的 sidecar 文件名/轮转名/落盘三条
+ CrossLanguageLockstepTests 的 sidecar sink 锁步）；
手工清单：关窗 → 隧道存活 → 托盘恢复 → 退出确认（含**更新已下载时退出不弹
确认**）→ 唤醒秒级重连 → 无窗口常驻期间 resume 补发 → **托盘缺失回退**
（dev 模式关窗即退、窗口不消失）→ **对话流健康臂可见性**（对同一来源反复拆 mux socket，制造
`openState='error'`：不整页刷新即自动恢复，恢复后聊天面继续渲染；无第二个会话时只出现
「重新加载」提示；`loading` 停滞满 20s 才出提示）→ **单一权威可见性**（按
`docs/checklists/session-authority-calibration.md` 注入丢帧/载波半死：位在 probe 预算内掉落、
完成通知恰好一条；横幅出现后「重新连接」生效、「忽略」在来源恢复前不再弹、「重新加载」才丢页面态；
判据回 STATUS「会话运行位卡死」）。

## 7. 关联

- 设计 15（Chamber 设置呈现，v1 平铺形态）：睡眠/运行设置的呈现面
  （`__general` 固定入口）；
- `docs/progress/STATUS.md`（进度唯一记录）；
- OpenChamber 参考：本地 `/Users/panzeyu2013/Desktop/code/develop/OpenChamber`
  `packages/electron/main.mjs`、`tray.mjs`、`packages/ui/src/sync/event-pipeline.ts`、
  `packages/ui/src/components/sections/openchamber/DesktopNetworkSettings.tsx`。

## 8. 观察者对账与页面恢复

无壳 `$events` 观察者把 socket 握手与可信基线分开。每次基线携带连接代际、请求序号和事件修订号；旧请求不能覆盖新状态，取样期间收到状态事件必须重新对账。`session/list` 只有完整 `items` 数组且每行的 `sessionId`、布尔 `running`、host `updatedAt` 均合法才是可信基线；任何坏行使整份基线失败，不能把缺字段当 `running=false` 或空列表。此契约同样用于控制面 mux 和 gateway 轮询。除静默重连外，低频独立对账找回单条丢失的 status。`session/follow` 读尾绑定会话运行轮次，重跑后旧读尾作废；没有 `turn/end` 时保留待分类状态并在后续基线重试。

两次基线都显示 `running=false` 时，host 的 `updatedAt` 仍可能前进：当前宿主实现把它定义为最近用户提示时间。这代表两帧 status 可能都落在基线间。观察者撤销旧完成，发起有界读尾；只有 `turn/end.time` **严格晚于**该提示时刻，才把新尾巴归到这次候选活动并分类。旧尾巴、无 host 时间、读尾失败都维持未知并重试，不生成完成通知；单凭提示水位也不武装未读，因为它可能只是排队的用户消息。同一会话缺少跨通道运行轮次键，故时间同毫秒、无新提示水位及并发重排仍是证据边界，不能用 `running=false` 补出完成。

**Rejected alternatives（基线解析）**：逐行跳过坏记录会把部分会话的缺席误判为可信事实；把坏信封视为空列表会压制运行时后备边沿。两者都不能作为通知事实源。

实例页面在会话 header 缺席时仍能显示打开停滞状态与本会话重建、整页重载入口。`loading` 与“当前会话应在场但具象 Session 面缺席”都从同一次未就绪窗口计时，反馈窗与失败窗分别为 20 秒、90 秒；暂时探测不到 Session 不会重置已走过的加载期限。已知空白会话可合法地没有物化 Session，只豁免“缺席”提示，实际 `loading` 或 `error` 仍显示恢复面。这些期限是用户可见的等待上界，不是宿主已停止工作的证明。当前流回调只证明客户端消费，DOM 提交和 WKWebView 绘制仍需分层真机取证，不能用 JS ping 充当画面进度。

`Session.resync()` 先等待旧 journal `dispose()` 再发起新 `open()`，所以取消完成也是恢复链的一部分。`RemoteStream` 对每个 source 的 `next()` 同时监听该物理代的 abort：即使生成端忽略取消，旧代也停止向 domain 交付；旧迭代器的 `return()` 最多等待 2 秒，随后释放本地取消链，让具象 `resync()` 能进入新开流。迟到的旧代结果由 lifetime/revision 栅栏丢弃。这个上界只针对页面事件循环仍能调度的本地取消；宿主无法提供新快照时，页面仍应显示失败状态。**Rejected alternatives**：仅在页面用按钮节流不能释放一个永不结算的 `dispose()`；无限等待旧迭代器完全释放会把一条失联的传输实现变成整个会话恢复的阻塞条件。

Journal 的旁路探针以**已应用的 durable 尾游标**为活动性证据：opening window 与 live append 重置 45 秒静默窗；历史 prepend 和无游标的 assistant-stream 通知不会重置它。这样在 assistant-stream 仍有通知、但 `turn/end` 等 durable record 丢失时，旁路 `follow` 仍能比较宿主 opening cursor 并重建当前流。探针计时使用单调时钟，防止系统校时把静默窗推向未来。这里的“已应用”只到 domain 的同步消费回调；React 提交与像素绘制另需独立证据。**Rejected alternatives**：把所有 publish 回调都视为 durable 进度会让无游标通知长期遮蔽丢帧；按固定空闲时间盲重启则会打断合法的长工具调用。

Electron 主进程在主窗聚焦、可见且加载完成后按 5 秒节奏采样页面的低频 rAF 心跳；连续三次探针出现 3 秒无 JS 应答、求值失败或 rAF 未前进，进入已有的有界渲染重载预算。窗口失焦、隐藏、导航或进程退出时证据复位，迟到的求值回执不能洗掉故障。Swift 使用同一类前台可见性条件与低频 rAF 证据；两条探针证明 JS/帧调度活动，均不能证明最终像素合成。宿主游标、客户端已应用游标、DOM 提交与实际绘制仍需分层取证，不能把页面心跳等同于会话内容前进。

**Rejected alternatives**：socket `ready` 后直接宣布 facts 可用会压制运行时完成边沿；只在 socket 静默时取基线找不到活跃连接中丢失的一条 status；旧读尾不按运行轮次围栏会把上一轮完成写到新一轮 running 行；把 `false→false` 或仅更新的提示水位直接认定为完成，会把旧 `turn/end` 或用户停止误报为完成；在 90 秒时自动取消所有在途打开会误伤大会话的合法慢读。只用 JS 求值应答会漏掉仍可应答但帧调度停下的页面；逐帧运行额外心跳会增加 60/120Hz 热路径负担；窗口不可见时计 rAF 停止会把正常后台节流误判为卡死。
