# 19 · 桌面通知：会话 complete / ask / request（设置可选项）

> **状态：M1–M2 已实现，合并前竞态加固与自动化复验已完成；M3 的 macOS
> 权限/打包态实机验收仍未完成（2026-09；实现与验证记录见
> `docs/progress/STATUS.md`，入口形态以 §3.4 的 2026-09 用户拍板为准）。
> **未读徽标（§3.7）M1–M2 已实现（2026-12）**：Dock/任务栏应用图标上的
> 红色数字气泡——renderer 未读计数投影 + `dsh-chamber:badge-count` IPC +
> 主进程设置裁决与平台门；Windows 任务栏 overlay 门控未接线（设计 23 排期）。
> 需求来源：用户要求「一个 session 在 complete、ask、request 时给用户推送通知」，
> 做成设置中的可选项。本文先给出
> **OpenChamber 通知功能调研**（外部参考，本地源码
> `/Users/panzeyu2013/Desktop/code/develop/OpenChamber`，同设计 14 的调研体例），
> 再给出 dsh-chamber 的移植设计契约。

---

## 1. 需求与设计前现状对照（dsh-chamber）

> 本节保留立项时的差距分析；现行实现以 §3–§5 为准。

| 项 | 现状 | 证据 |
|---|---|---|
| 桌面通知 | **当时无任何通知能力**：main.ts 无 `Notification` 导入、无通知 IPC、无权限处理 | 设计前 `packages/desktop/main.ts` |
| 会话状态检测 | **已具备事实源**：06 §4 运行时事实通道——每个已挂载 ctx 的侧边栏插件注册 generation-safe runtime producer，上报每会话 `{running, completed, pending}`（`pending = 'approval' \| 'plan-review' \| 'question'`，来自 vendor sessions store 的实时 mux 交互状态）；App 层另有 running→idle「完成未读」蓝点边沿机（`reconcileCompletedFacts`） | `packages/dsh-chamber-client-ui-sidebar/src/client/index.ts`；`packages/renderer/src/App.tsx` |
| 会话标题/来源 label | App 聚合已持有（`aggregates[sourceId].sessions[].title`、`server.label`） | `App.tsx` `deriveServers` |
| 窗口隐藏场景 | 设计 14 已落地：关窗 hide 到托盘 / macOS 无窗常驻 / 后台启动——**窗口不可见时用户对会话完成与等待输入一无所知**（蓝点/pending 徽标只在窗口内） | 设计 14 |
| 设置存储 | chamber 全局设置 `chamber-settings.json`（主进程权威、`dsh-chamber:settings-get/set` IPC + push、`validatePatch` 白名单） | `packages/desktop/chamber-settings.ts` |

**结论**：dsh-chamber 缺的是「呈现 + 裁决」两端——Electron 原生通知（桌面壳宿主能力，
与托盘/退出确认同层级）与设置入口；检测端**已有现成事实通道**，零控制面改动、
零新 host 插件即可接上。

**术语映射**（与用户需求对齐）：`complete` = 会话回合结束（running→idle 边沿，
或 vendor `completed` 武装）；`ask` = pending `'question'`（代理提问、等待回答）；
`request` = pending `'approval' | 'plan-review'`（工具调用/计划审批请求）。

---

## 2. OpenChamber 通知功能调研（外部参考）

> 源码：`packages/web/server/lib/notifications/`（服务端）+ `packages/electron/main.mjs`
> （桌面主进程）+ `packages/ui/src/`（渲染端：`sync/sync-context.tsx`、
> `hooks/useWebNotificationStream.ts`、`components/sections/openchamber/NotificationSettings.tsx`、
> `stores/useUIStore.ts`）。OpenChamber 的通知由**服务端事件消费 → 双通道分发 → 设置裁决**组成：

### 2.1 服务端事件源（notifications/runtime.js）

- 服务端（进程内 web 服务器）**消费 opencode 的会话生命周期事件**：会话完成
  （completion，含 subtask 区分）、`question.asked`、`permission.asked` 等。
- 每类事件套**模板**（`templates.completion/question/…`，变量 `{agent_name}`
  `{model_name}` `{last_message}` `{session_name}` 等），组装 `{title, body, tag, kind,
  sessionId, directory, projectId}`。
- **双通道分发**（`notifications/emitter-runtime.js`）：
  - `emitDesktopNotification` → 桌面形态直调 Electron 主进程回调（`onDesktopNotification`）；
  - `broadcastUiNotification` → 经 SSE/WS 全局事件 `openchamber:notification` 广播给 UI，
    携带 `desktopNotificationDelivered` 标志——**桌面已发过原生通知时，UI 侧不得再发**
    （防双发，`sync-context.tsx` L513–518）。

### 2.2 桌面端（main.mjs `maybeShowNativeNotification`）

- `normalizeNotificationInput`（IPC 包裹 `{payload}` 与 sidecar stdout 扁平形态归一）；
- `requireHidden && isAnyWindowFocused()` → 跳过（正在屏幕上看的会话不打扰）；
- `Notification.isSupported()` 检查；
- **去重 claim**：`nativeNotificationClaims` Map + 5s TTL，key = `workspaceId|tag`
  或 `workspaceId|sessionId|kind|title|body`——同键 5s 内只发一次（防事件风暴/双发）；
- OpenChamber 参考实现用 `activeNotifications` 存活集合防 GC 吞 click 事件
  （macOS 已知坑）；dsh-chamber 的现行 token-aware Map 见 §3.3；
- `new Notification({title, body, silent: false, sound: 'Glass'(darwin)})`；
- click → `focusForegroundWindow()`（macOS 先 `app.focus`）+ 广播
  `openchamber:open-session` 打开对应会话。

### 2.3 设置面（NotificationSettings.tsx + useUIStore）

- **主开关** `nativeNotificationsEnabled`（默认关）；
- **聚焦模式** `notificationMode: 'always' | 'hidden-only'`（默认 hidden-only：
  窗口聚焦时不打扰；`always` 仍受「正在查看的会话」豁免——`requireHidden`）；
- **事件开关** ×4：completion / subtask / error / question（每类可独立关）；
- **模板编辑**：每事件 title/message 可自定义（变量插值）；
- 「发送测试通知」按钮（直调 `notifications.notifyAgentCompletion`，绕过开关）；
- 浏览器形态另有 Web Push（service worker + VAPID）订阅（桌面形态不用）；
- 持久化经 UI store → 服务端 settings（OpenChamber 的服务器持有设置权威）。

### 2.4 与 dsh-chamber 的差异（移植要点）

| OpenChamber | dsh-chamber |
|---|---|
| 中心服务器消费 opencode 事件流 | 控制面**不消费宿主帧**（01 §4 硬纪律）→ 检测改在 chamber renderer 层，事实来自 chamber 自有通道（06 §4） |
| 设置权威在服务器 | chamber 全局设置权威在主进程（chamber-settings.json） |
| 模板可编辑 + web push | v1 只做固定文案 + 桌面原生通知（模板/推送列为后续扩展） |
| UI 经 SSE 收事件再调 runtime API | renderer 直接检测边沿 → 一条 IPC 直达主进程（无 SSE 中继） |

---

## 3. dsh-chamber 设计契约

### 3.1 分层与定位（纪律声明）

```
各实例 dsh 前端 runtime（每来源一个 ctx shell）
  └─ 侧边栏插件（chamber 自研，每 ctx 挂载）—— 06 §4 事实通道（现成，不改）
       registerInstanceRuntimeProducer(sourceId, sourceFingerprint).report({current, sessions: …})
            ↓ chamberBridge（renderer 共享单例，现成）
renderer App 层
  ├─ 通知边沿检测（新增纯函数模块，App effect 接线）→ 事件组装（title/body/requireHidden）
  └─ window.dshChamber.notifications.notify(payload)          ← 新 IPC（invoke）
            ↓
桌面主进程
  ├─ 设置裁决（chamber-settings.json 权威：主开关/事件开关/模式/聚焦豁免）
  ├─ 去重 claim（5s TTL）+ Electron Notification（原生）
  └─ click → 聚焦窗口 + 推送 dsh-chamber:notification-open → renderer openSession（既有路径）
```

- **控制面零改动**；**无新 host 插件**；**不消费宿主帧**（事实来自 chamber 已有的
  侧边栏事实通道，非控制面消费）。
- 「通知中心」在 01 §4 是**移出域**（宿主 UI 职责面）——本设计不建通知中心、不做
  通知列表/历史/管理面，只做**桌面壳原生通知呈现**（与设计 14 托盘、退出确认同为
  桌面宿主能力），不违反 P3。
- 设置 = chamber 全局设置（主进程权威），**绝不进任何实例的 dsh home**（15 D3）。

### 3.2 事件检测（renderer，`packages/renderer/src/notification-edges.ts`）

事实源：`chamberBridge.onRuntimeReport`（App 已有订阅）。**新增独立纯函数模块**
（与蓝点机 `reconcileCompletedFacts` 并存，互不耦合；蓝点机带「正在阅读」解除，
通知边沿需要**不受解除影响**——窗口隐藏到托盘时活动来源的当前会话完成也必须
通知，见 3.3 的 requireHidden 语义）：

```ts
// 每来源每会话的边沿记忆（App effect 内 ref 持有，随来源生命周期收敛）
interface SessionFacts { running?: boolean; completed?: boolean; pending?: 'approval'|'plan-review'|'question' }
type NotificationKind = 'complete' | 'ask' | 'request'

// 纯函数：prev 事实 → next 事实 的边沿事件集
function detectNotificationEdges(
  prev: Record<string, SessionFacts> | undefined,   // 首份上报 = undefined（只播种，不发事件）
  next: Record<string, SessionFacts>,
): Array<{ sessionId: string; kind: NotificationKind }>
```

| 事件 | 边沿定义 | 说明 |
|---|---|---|
| `complete` | `running: true → false`，或 vendor `completed` 从无到有 | 同一 tick 两者同时成立只发一次；`completed` 兜底断连窗口内完成的补发；**父会话回合结束但子代理仍在运行（`runningSubagents > 0`）时不视为完成**（与官方 Rows / 侧边栏呈现优先级一致，抑制在去重之前、不记账） |
| `ask` | `pending` **值变化到 `'question'`** | 代理提问等待回答；含直切（question→approval 等不经 undefined 的切换——vendor 组合选择器会正常产生，每个新值都通知一次）；同值重放与清除（→undefined）不发 |
| `request` | `pending` **值变化到 `'approval' \| 'plan-review'`** | 工具/计划审批请求；直切/重放/清除语义同上 |

- **首次上报静默播种**（`prev === undefined`）：应用启动/来源首挂载时，已 pending /
  已完成会话不轰炸（窗口内由侧边栏徽标呈现；参考 OpenChamber 的 boot 去抖语义）。
- **断连重连诚实补发**：断连期间完成/提问的会话在事实恢复后按边沿补触发（迟但
  正确）；同内容重放（mux 回放重加 pending 等）不重复——边沿记忆按来源保留
  （与 `prevRunningRef` 同生命周期纪律），主进程 claim 兜底。
- subagent 会话不产生事件（事实通道不含 subagent 行；父会话的 `runningSubagents`
  只驱动子代理计数徽标）。

### 3.3 通知事件与 IPC

**事件组装**（App effect 内，读 `activeViewRef` + `runtimeFacts` + `aggregates` ref）：

```ts
interface NotificationRequest {
  sourceId: string            // 'local' | 'dsh-<id>' | 'gateway-<id>'（'ssh-<id>' 为 v2 迁移前 legacy，17 §2.2/§9.1）
  sourceFingerprint: string   // 主进程签发的当前来源代 opaque proof
  sessionId: string
  kind: NotificationKind | 'test'
  title: string
  body: string
  requireHidden: boolean      // 正在屏幕上查看的会话（见下）
}
```

- `requireHidden = (sourceId === activeViewRef.current && sessionId === report.current
  && document.hasFocus())`——用户正看着这个会话（无论主开关/模式如何都豁免，
  与 OpenChamber `requireHidden && isAnyWindowFocused()` 同语义；单窗口下
  renderer 的 `document.hasFocus()` 与主进程 `isAnyWindowFocused()` 等价，主进程
  再查一次作为权威）。
- 文案（v1 固定，renderer 组装，zh 字面量——沿 App.tsx 既有风格；i18n 列为扩展）：
  - complete：「会话已完成」/ `{来源 label} · {会话标题}`
  - ask：「代理正在等待你的回答」/ `{来源 label} · {会话标题}`
  - request：「代理请求你的批准」/ `{来源 label} · {会话标题}`
  - 会话标题查 `aggregates[sourceId]`（无标题/空白会话回落「未命名会话」）。
- 发送：`window.dshChamber?.notifications?.notify(payload)`；桥未就绪静默跳过 +
  console.warn（与 desktopSsh 桥探测同节奏，500ms 探测已有先例）。
- `sourceFingerprint` 来自生产该份 runtime facts 的 ctx：local 固定为 `local`，远程
  是主进程随 roster 投影的 64 位小写十六进制 opaque proof。App 只接受 proof 与当前
  权威来源代相等的 producer report；renderer 不从可复用 registry 字段推导 proof。

**主进程**（`packages/desktop/main.ts` + 新增 `packages/desktop/notifications.ts`
纯逻辑模块，electron-free 便于单测）：

- 新 IPC：`dsh-chamber:notify`（`trustedIpc` invoke，payload 字段白名单校验
  sourceId/sourceFingerprint/sessionId/kind/title/body/requireHidden，长度上限；sourceId 只接受精确
  `local`、规范 `dsh-<raw-id>` / `gateway-<raw-id>`，以及迁移兼容的 legacy
  `ssh-<raw-id>`；raw id 必须匹配 `INSTANCE_ID_PATTERN`，显式拒绝保留字 `local`、空值、
  非法字符或超过 64 位；proof 还必须与主进程当前来源代精确匹配）；
- 主进程以两组**仅保留 active roster** 的 Map 管理远程 proof 与 ownership token：
  删除即删项；renderer 来源身份（kind/host/user/sshPort/remotePort）编辑轮换
  proof/generation，同 id 重建也不会复用旧 proof。`transport`、`serviceName`、
  `remoteDshHome` 可触发各自 live/exec generation teardown，但不单独退役 N-ctx
  来源 proof（05 §4/§7.6）；
  历史 id 不留 tombstone，内存上界随当前远程实例数而非历史 churn 增长；
- `maybeShowNativeNotification(payload)` 裁决链（设置权威在主进程内存状态，随
  `dsh-chamber:settings-changed` 更新）：
  1. `kind === 'test'` 跳过设置门禁（设置页「发送测试通知」按钮）；
  2. `notifications.enabled === false` → 跳过；kind 对应事件开关关 → 跳过；
  3. `requireHidden && isAnyWindowFocused()` → 跳过；
  4. `mode === 'hidden-only' && isAnyWindowFocused()` → 跳过（`always` 放行）；
  5. `Notification.isSupported()` → 否则跳过（记日志）；
  6. **去重 claim**：key =
     `JSON.stringify([sourceId, sourceFingerprint, sessionId, kind])`，5s TTL、
     64 条硬上限，Map + 时间序列只清理过期前缀（防同一事件双路径/重放双发，
     不再对每个新 key 全表扫描；claim 在裁决之后；'test' 不走 claim）；
  7. **全局呈现预算**：所有实际呈现尝试（**含 `test`**）共享 5s/8 次滑窗硬上限
     （1.6 次/秒，容纳适度多来源同时完成但不允许 banner 风暴）；
     `BoundedActiveNotifications`（`activeNotifications`）把跨多个速率窗口仍不
     close 的存活通知对象硬上界在 16 条。上界约束「存活引用/OS 监听器」数量而
     非投递配额：**满员时不拒发**——macOS 横幅进入通知中心后不触发 Electron
     close（通常只有用户手动清除才触发），若满员 fail-closed，16 条未清除的
     存量横幅就会永久卡死通知流（2026-09 实机复现：第 16 条横幅后设置页
     「发送测试通知」与事件通知全部返回 false，OS 侧无任何请求记录）。因此
     满员时按插入序 loud 淘汰最旧一条（close 退役）并继续登记新通知——硬上界
     不变、通知流不被存量横幅卡死，仅最旧（价值最低）条目的 click 随之失效。
     该宿主预算不读取 session roster（控制面/主进程仍不成为 session consumer）；
  8. `new Notification({title, body, silent: false, sound: 'Glass'(darwin)})`，
     `BoundedActiveNotifications` Map 持有 notification → 来源 token（既防 GC
     吞 click，又允许按退役来源关闭旧 banner）；IPC 的 `true` 只在原生
     `show` 事件后返回，异步 `failed`、同步 throw、show 前 close 或 5s 超时均返回
     `false` 并释放 claim，绝不把“调用了 void show()”冒充“已显示”；
  9. click → 先复验创建 banner 时捕获的 ownership token，再聚焦/显示窗口（macOS
     先 `app.focus`，同设计 14 恢复路径；退出在途
     `quitRequested` 则终止恢复/重建；'test'
     通知只聚焦不打开会话）+ 推送 `dsh-chamber:notification-open`
     `{sourceId, sourceFingerprint, sessionId, deliveryId, attempt}`。来源删除或上述 renderer
     来源身份编辑会同步 close 旧 banner，并丢弃该来源全部 pending/in-flight open；旧 click
     closure 即使迟到也不能打开 replacement。

**点击打开会话**（renderer）：App 订阅 `window.dshChamber.notifications.onOpen` →
`openSession(sourceId, sessionId)`（既有路径：挂载视图 → `ensureRemoteConnected` →
`openInstanceSession`）。**窗口重建竞态**：主进程对 notification-open 使用 64 条
硬上限 FIFO + reentrancy guard——renderer 注册监听后 invoke
`dsh-chamber:notifications-ready` 置位（`did-start-loading` 与
`render-process-gone` 时重置），就绪后才放行。一次 drain 只提交成功发送的前缀；
  每条 push 携带稳定 `deliveryId`、逐次递增 `attempt` 与来源 proof；`webContents.send` 返回只把
  记录移入 in-flight，**不算消费成功**。renderer 在完整 payload 已执行/入有界 roster
  队列后调用 trusted `notification-open-ack(deliveryId,attempt)`；仅精确当前 attempt
  释放容量。reload/crash/start-loading/closed 把全部未 ACK 前缀按 FIFO 放回队首，旧
  document 的迟到 ACK 因 attempt 不匹配而无效；同步 send throw 只 rollback 当前项，
  早先已发送项继续等各自 ACK。pending+in-flight 总计 64；满时 loud 淘汰最旧 pending，
  若全为 in-flight 则 loud 拒绝新点击。

主进程 replay 之后还有 renderer 的**权威 roster + proof 二级门**：`local` 立即打开；规范
`dsh-<id>` / `gateway-<id>`（及迁移兼容的 legacy `ssh-<id>`）远程来源在当前
generation 首次 `instances_get` 成功前以完整
`{sourceId,sourceFingerprint,sessionId,deliveryId,attempt}` 的 64 条有界 FIFO hold，
roster settle 后按序 replay，目标缺失或 proof 已过期才逐项 loud 丢弃并 ACK。串行
runner 捕获精确来源 token，旧代排队项不能在 same-id replacement 上执行。该门与深链
的单槽 last-intent-wins 不同：每一次通知点击都必须保留。`deliveryId` 是 ACK/重放
坐标，不建立 renderer 持久去重账本；精确 `attempt` 防止旧 document 的 ACK 误提交新发送。

**preload / 类型**（`preload.cts` + `renderer/src/global.d.ts`）：

```ts
// window.dshChamber.notifications
interface NotificationSurface {
  notify(payload: NotificationRequest): Promise<boolean>          // invoke 'dsh-chamber:notify'
  ready(): Promise<boolean>                                       // invoke 'dsh-chamber:notifications-ready'
  ack(deliveryId: number, attempt: number): Promise<boolean>       // accepted/queued 后精确提交
  onOpen(listener: (req: { sourceId: string; sessionId: string;
                           sourceFingerprint: string;
                           deliveryId: number; attempt: number }) => void): () => void
                                                                  // 'dsh-chamber:notification-open' push
}
```

### 3.4 设置模型与 UI

**chamber-settings.json 扩展**（`packages/desktop/chamber-settings.ts` +
`renderer/src/global.d.ts` 结构镜像同步）：

```ts
interface ChamberSettings {
  // …既有 4 键不变
  notifications: {
    enabled: boolean          // 主开关；默认 false（低打扰，用户显式开启）
    mode: 'hidden-only' | 'always'  // 默认 hidden-only
    onComplete: boolean       // 默认 true
    onAsk: boolean            // 默认 true
    onRequest: boolean        // 默认 true
  }
}
```

- `normalizeSettings` / `validatePatch` / `SETTINGS_KEYS` 扩展（嵌套对象校验，
  未知键拒绝；`chamber-settings.test.ts` 补用例）；
- 主进程在 `dsh-chamber:notify` 裁决时读取内存设置（同一次 settings-set 即生效）。

**设置 UI**（`packages/dsh-chamber-client-ui-settings-bridge`）：

- 决策（2026-09 用户拍板，实现以此为准）：**并入 `__general` 通用页**，新增
  「通知」控制组（不新增设置壳固定入口——设计 15 v1 平铺形态的入口数保持
  2 个不变）；通用页各控制组之间用**分割线**（`.generalGroup + …` hairline，
  `--dsw-alias-border-l2`）分隔，通知组插在「运行」与「更新」之间。备选
  （未采纳）：独立 `__notifications` 固定入口。
- 通知组内容（settings-panel 设计语言 + `settings-store` 复用）：
  - 控制组「通知」：主开关行；
  - 「通知时机」：模式单选（仅窗口隐藏时 / 始终）+ 事件开关 ×3（完成 / 提问 /
    审批请求）；「始终」下注明「正在查看的会话除外」；
  - 「发送测试通知」按钮（调 `notifications.notify({sourceId:'local',
    sourceFingerprint:'local', kind:'test', …})`，主进程
    绕过门禁直接显示；'test' 豁免空 sessionId 白名单，click 不触发打开会话）；
  - i18n zh/en（`locales.ts` 扩展；配对由 `typecheck:settings-bridge` 的
    `Record<keyof typeof zh, string>` 编译期强制）。

**UI 修订注（2026-12，纯展示层）**：通知组边框收敛——主开关改为无边框披露行
（`.generalSwitchRow`），启用后展开的子设置（通知时机 / 事件开关 ×3 / 测试按钮）
整体收入唯一一张卡片（`.generalNotifyCard`），内部行不再自带边框（`.generalLinePlain`
/ `.generalEventRow`）；通知组从五层边框降到一层。开关关闭时子设置仍整体收起。

### 3.5 覆盖边界与诚实性

- **仅已挂载来源**可检测 ask/request（实时 mux 事实只在 ctx 内存在）；未挂载且
  未预热的远程来源（预热槽 ≤3 + 用户打开过的 N-ctx 常驻之外）v1 不产生通知——
  文档化限制，后续可选「unary 完成检测」（30s 延迟、无 pending 信息）扩展。
- 断连/重连：事实恢复后诚实补发；同内容重放不重复（边沿记忆 + 主进程 claim）。
- 窗口内提醒职责仍由侧边栏蓝点/pending 徽标承担，通知只在「用户看不到窗口时
  值得打扰」（hidden-only 默认）或用户显式选择 always。
- **被裁决跳过的完成不补发**（设计取舍）：hidden-only + 窗口聚焦时主进程跳过
  （focused-hidden-only），而 renderer 的 complete 去重记忆在边沿通过时已记账，
  窗口稍后隐藏不会重新触发该完成——与「仅窗口隐藏时打扰」语义一致，侧边栏
  蓝点仍覆盖，故不补发。
- **子代理运行期不视为完成**：父会话回合结束但 `runningSubagents > 0` 时抑制
  complete 通知（与官方 Rows / 侧边栏呈现优先级一致；抑制在去重之前、不记账，
  vendor 若在子代理全部结束后才武装 completed，届时正常补发）。
- 通知失败（isSupported false / 系统权限拒绝）**静默降级不误报**：会话业务不受
  影响，蓝点照常。
- notification-open 的 `send()` 返回不等于消费成功：所有未 ACK 项跨 renderer
  rebuild replay；稳定 deliveryId + attempt 只作为精确 ACK 坐标，来源 proof 隔离
  same-id replacement，FIFO 不因并发 click 或窗口替换乱序。
- renderer 的来源 ownership/producer 账本同样只保留 active Map 项，退役即删除；
  单调 serial 只生成 token，不按历史 sourceId 留 generation tombstone。权威 delta 到达时
  `retireInstanceProducers` 同步撤销 runtime/snapshot token 与缓存，再异步 dispose shell。

### 3.6 安全与纪律

- IPC 沿用 `trustedIpc` 全部门禁（sender = 主窗口 mainFrame + 控制面 origin）；
  payload 白名单 + 长度上限（防异常 title/body 刷屏）。
- 载荷全为非秘密投影（会话 id/标题/来源 label + 主进程签发的 opaque 生命周期
  proof——侧边栏同源数据，无隧道 URL、无 SSH 材料）；proof 不持久化，也不含可逆
  host/user/port 信息。
- 控制面零改动；无新 host 插件；不消费宿主帧；设置不落实例 dsh home。

### 3.7 未读徽标：Dock/任务栏应用图标红气泡（2026-12，M1–M2）

OpenChamber 参考实现：`packages/electron/main.mjs` 的 `desktop_tray_update`
分支读 `args.dockBadgeCount` → `app.setBadgeCount(Math.max(0, Math.floor(count)))`
（0 = 清除）；计数由 `packages/ui/src/hooks/useTraySync.ts` 计算——**有未读活动的
会话数**（`unseenCount > 0`，`dockBadgeEnabled` 开关控制）。dsh-chamber 移植要点：

```
completedBySource（App 完成未读蓝点集，06 §4.1，只读复用——徽标与蓝点同源同
规则，两面永不分叉）
  → projectBadgeCount()（renderer 纯函数，跨来源求未读会话数，0 = 清除）
  → window.dshChamber.badge.set(count)                 ← 新 IPC（invoke）
  → 主进程：白名单校验 → 记录意图 → 设置裁决（badgeEnabled 关 → 强制 0）
    → 平台门（app.setBadgeCount：darwin/linux；win32 overlay 门控）→ 呈现
```

- **计数语义**：一个未读会话 = 1（与 OpenChamber「chats with unseen activity」
  同款，不是通知条数）；pending（ask/request）不计数（蓝点面不覆盖，侧边栏
  pending 徽标仍承担窗口内提醒）。
- **主进程裁决与状态**：`pendingBadgeCount`（最近一次 renderer 意图）+ 设置
  权威裁决——`badgeEnabled` 关闭即强制清零，重新开启经 `reconcileBadgeCount`
  恢复当前未读数（settings-set 后即时收敛，不等下一次推送）；quit 在途兜底
  清零。renderer 始终推真实计数（开关裁决在主进程，与横幅通知同纪律）。
- **平台门**（`badgePlatformGate`，诚实不假装）：darwin = Dock 红气泡；
  linux = Unity launcher DBus API（GNOME 的 Dash to Dock 等消费同一 API 的
  扩展同样可见；无消费方的桌面环境无可见效果——文档化平台限制，返回 true
  表示已提交给 OS API 而非可见性保证）；win32 = v1 门控跳过 + loud 记一次
  日志（`setOverlayIcon` 数字角标图属设计 23 排期；平台判定先于 API 可用性
  判定，win32 上 setBadgeCount 恒为 undefined，专属原因不被泛化吞掉）。
- **设置**：`notifications.badgeEnabled`（默认 **true**——被动指示，镜像蓝点
  「始终开启」与 OpenChamber 默认开启；与横幅主开关 `enabled` 独立）。设置 UI
  在通用页「通知」组加一条始终可见的无边框开关行（主开关下方、子设置卡上方），
  不增加边框层数；zh/en i18n。
- **renderer 推送**：`[completedBySource]` effect 每次变化推当前计数（蓝点
  武装/阅读解除/来源退役自然驱动徽标增减）；挂载时推 0 兜底（窗口重载后蓝点
  复位为 {}，主进程遗留徽标必须清除）+ 桥迟到有界重试（复用
  `LISTENER_READY_RETRY_*` 预算）。桥缺失（web/dev）静默跳过。
- **校验**：`{ count }` 必须为有限数（结构化克隆可携带 NaN/Infinity，显式
  拒绝）、非负、≤ 9999（超上限响亮拒绝不静默截断）；小数 `Math.floor` 归一
  （OpenChamber 同款容忍）。返回 boolean = 是否实际应用；渲染端静默容忍
  false（主进程已 loud 记平台/失败原因，重复推送不刷屏）。
- **纪律**：控制面零改动、无新 host 插件、不消费宿主帧、不建通知历史/中心
  （01 §4 移出域不变）；计数是瞬时投影，绝不持久化。

---

## 4. 分期

- **M1 主链路**：`desktop/notifications.ts`（裁决/去重/决策纯逻辑 + 单测）→
  main.ts IPC 接线（notify + notification-open + pending drain +
  notifications-ready 就绪信号）→ preload + global.d.ts → renderer
  `notification-edges.ts`（边沿检测 + complete 去重）+ App effect 接线 →
  chamber-settings 扩展 + 测试。
- **M2 设置 UI**：通用页「通知」控制组（GeneralView 内联，无新入口）+
  分组分割线 + i18n + 测试按钮。
- **M3 打磨**：macOS 通知权限（未授权时的设置页提示）、文案定稿、
  打包态实机验收（关窗/托盘/后台三形态 + 点击打开 + 窗口重建）。

## 5. 测试与验证门

- `test:desktop`：chamber-settings 新键 normalize/validate/corrupt 用例；
  notifications 覆盖裁决链 enabled/kind/mode/requireHidden、claim/rate/active
  hard cap、honest show/failed/timeout/hostile error、严格 `local | ssh-<raw-id>` 来源、
  opaque proof 校验与 same-id replacement、active-only Map churn、notification-open
  retain-until-ACK/FIFO/reload replay/旧 attempt 隔离；最终 HEAD 数字只见 STATUS。
- `test:renderer-shell`：`notification-edges` 纯函数单测（complete 边沿与
  dedupe 去重、ask/request 值变化边沿（含直切）、首报播种、断连补发、
  同 tick 去重）。
- `test:sidebar`：`projectRuntimeFacts` 的 subagent 行排除用例。
- `test:settings-bridge`：通知设置纯函数（notifications-settings：缺省回落/
  partial patch/未知键过滤/默认值镜像）+ 既有套件（入口解析不变——通知组
  不新增固定入口）。
- `verify:i18n` 无 DRIFTED（settings-bridge 命名空间配对由
  `typecheck:settings-bridge` 编译期强制）；`typecheck`；
  `build:renderer`；`dist:desktop:mac` 打包态通知冒烟（macOS 权限 + 点击打开）。

## 6. 关联

- 设计 06 §4：运行时事实通道（检测事实源，本设计不改其契约）。
- 设计 14：关窗/托盘/后台常驻（通知的主要使用场景——窗口不可见时才打扰）。
- 设计 15：settings 壳平铺固定入口形态（通知并入 `__general`，入口数不变）。
- 设计 16：`pendingIntents` 队列 + drain 模式（notification-open 重建竞态复用）。
- 01 §4：通知中心为移出域；本设计仅桌面壳原生通知，控制面零改动。
