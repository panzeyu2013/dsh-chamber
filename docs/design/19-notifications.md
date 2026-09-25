# 19 · 桌面通知与未读徽标（会话 complete / ask / request，设置可选项）

> **桌面原生通知与未读徽标**——会话 complete / ask / request 时
> 推送原生通知，Dock/任务栏图标显示未读红气泡（均为主进程裁决的设置可选项）；检测端
> 复用 renderer 既有事实通道，控制面零改动、无新 host 插件；**未完成门禁**：macOS
> 权限/拒绝行为的**打包态实机走查**（拒绝态设置页提示与「打开系统设置」恢复入口存在，
> 见 §3.3/§4）、Windows 任务栏 overlay 门控（design 23 排期）——见
> `docs/progress/STATUS.md`。
> 需求来源：用户要求「一个 session 在 complete、ask、request 时推送通知」并做成设置
> 可选项；未读徽标是同一投影的被动指示。
> 本文先给 **OpenChamber 通知功能调研**（外部参考，源码
> `/Users/panzeyu2013/Desktop/code/develop/OpenChamber`，体例同设计 14），再给 dsh-chamber
> 的移植设计契约。

---

## 1. 事实源与术语（dsh-chamber）

| 项 | 事实 | 证据 |
|---|---|---|
| 会话状态检测 | **已有事实源**：06 §4 运行时事实通道——每个已挂载 ctx 的侧边栏插件注册 generation-safe runtime producer，上报每会话 `{running, pending}`（运行位按官方 `status?.running ?? row.running` 解析；`completed` **不在上报里**——官方 store 行没有该字段、官方完成位 `sessionStatus.completionUnread` chamber 今日不消费，该位由 App 账本在 `mergeRuntimeFacts` 合并时注入）（`pending = 'approval' \| 'plan-review' \| 'question'`，来自 vendor sessions store 的实时 mux 交互状态）；App 层另有 running→idle「完成未读」蓝点边沿机（`reconcileCompletedFacts`） | `packages/dsh-chamber-client-ui-sidebar/src/client/index.ts`；`packages/renderer/src/App.tsx` |
| 会话标题/来源 label | App 聚合已持有（`aggregates[sourceId].sessions[].title`、`server.label`） | `App.tsx` `deriveServers` |
| goal 活性事实 | 运行时事实行 `goal?: GoalFact \| null`（三值：缺席 = unknown / `null` = 明确无 goal / 对象 = 有 goal；`{goalId, revision, phase, activation?, updatedAt?}`）。P1 来自挂载壳的会话投影 `projectionValues.goal`，P2a/P2b 来自只读 `session/list` 投影 + `$events` 的 activation 事件 | `packages/dsh-chamber-client-core/src/derive.ts`、`packages/control-plane/src/session-state-protocol.ts`（06 §4.1、17 §10.7） |
| 窗口隐藏场景 | 设计 14：关窗 hide 到托盘 / macOS 无窗常驻——**窗口不可见时用户对会话完成与等待输入一无所知**（蓝点/pending 徽标只在窗口内） | 设计 14 |
| 设置存储 | chamber 全局设置 `chamber-settings.json`（主进程权威、`dsh-chamber:settings-get/set` IPC + push、`validatePatch` 白名单） | `packages/desktop/chamber-settings.ts` |

**结论**：本设计只补「呈现 + 裁决」两端（Electron 原生通知 + 设置入口，分层/纪律见
§3.1）；检测端**复用现成事实通道**（06 §4）。

**术语映射**（与需求对齐）：`complete` = 会话回合结束（running→idle 边沿，
或合并事实行上 App 账本武装的 `completed` 边沿）；`ask` = pending `'question'`（代理提问、等待回答）；
`request` = pending `'approval' | 'plan-review'`（工具调用/计划审批请求）。

---

## 2. OpenChamber 通知功能调研（外部参考）

> 源码：`packages/web/server/lib/notifications/`（服务端）+ `packages/electron/main.mjs`
> （桌面主进程）+ `packages/ui/src/`（渲染端：`sync/sync-context.tsx`、
> `hooks/useWebNotificationStream.ts`、`components/sections/openchamber/NotificationSettings.tsx`、
> `stores/useUIStore.ts`）。OpenChamber 的通知由**服务端事件消费 → 双通道分发 → 设置裁决**组成：

### 2.1 服务端事件源（notifications/runtime.js）

- 服务端消费 opencode 会话生命周期事件（completion 含 subtask、`question.asked`、
  `permission.asked` 等），按 `templates.completion/question/…` 模板（变量
  `{agent_name}` `{model_name}` `{last_message}` `{session_name}` 等）组装
  `{title, body, tag, kind, sessionId, directory, projectId}`。
- **双通道分发**（`notifications/emitter-runtime.js`）：
  `emitDesktopNotification` → 桌面形态直调 Electron 主进程回调（`onDesktopNotification`）；
  `broadcastUiNotification` → 经 SSE/WS 全局事件 `openchamber:notification` 广播给 UI，携带
  `desktopNotificationDelivered` 标志——**桌面已发过原生通知时 UI 不得再发**（防双发，
  `sync-context.tsx` L513–518）。

### 2.2 桌面端（main.mjs `maybeShowNativeNotification`）

- `normalizeNotificationInput`（IPC 包裹 `{payload}` 与 sidecar stdout 扁平形态归一）；
- `requireHidden && isAnyWindowFocused()` → 跳过（正在屏幕上看的会话不打扰）；
- `Notification.isSupported()` 检查；
- **去重 claim**：`nativeNotificationClaims` Map + 5s TTL，key = `workspaceId|tag`
  或 `workspaceId|sessionId|kind|title|body`——同键 5s 内只发一次（防风暴/双发）；
- `activeNotifications` 存活集合防 GC 吞 click（macOS 已知坑）；dsh-chamber 现行
  token-aware Map 见 §3.3；
- `new Notification({title, body, silent: false, sound: 'Glass'(darwin)})`；
- click → `focusForegroundWindow()`（macOS 先 `app.focus`）+ 广播 `openchamber:open-session`。

### 2.3 设置面（NotificationSettings.tsx + useUIStore）

- **主开关** `nativeNotificationsEnabled`（默认关）；**聚焦模式**
  `notificationMode: 'always' | 'hidden-only'`（默认 hidden-only：聚焦时不打扰，
  `always` 仍受「正在查看的会话」豁免——`requireHidden`）；**事件开关** ×4：
  completion / subtask / error / question（独立关）；**模板编辑**：每事件 title/message
  可自定义（变量插值）；「发送测试通知」直调 `notifications.notifyAgentCompletion`
  绕过开关；浏览器形态另有 Web Push（service worker + VAPID，桌面不用）；持久化经 UI
  store → 服务端 settings（OpenChamber 的服务器持有设置权威）。

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

- **控制面零改动**、**无新 host 插件**、**不消费宿主帧**（事实来自 chamber 既有
  侧边栏事实通道）。
- 「通知中心」在 01 §4 是**移出域**（宿主 UI 职责面）——本设计不建通知中心/列表/历史/
  管理面，只做**桌面壳原生通知呈现**（与设计 14 托盘、退出确认同级的宿主能力），
  不违反 P3。
- 设置 = chamber 全局设置（主进程权威），**绝不进任何实例的 dsh home**（15 D3）。

### 3.2 事件检测与 goal 收敛（renderer，`notification-edges.ts` / `notification-projection.ts`）

事实源：`chamberBridge.onRuntimeReport`（App 已有订阅）。**新增独立纯函数模块**
（与蓝点机 `reconcileCompletedFacts` 并存、互不耦合；蓝点机带「正在阅读」解除，
通知边沿**不受解除影响**——窗口隐藏到托盘时活动来源的当前会话完成也必须通知，见
§3.3 requireHidden）：

```ts
// 每来源每会话的边沿记忆（App effect 内 ref 持有，随来源生命周期收敛）
interface SessionFacts { running?: boolean; completed?: boolean; pending?: 'approval'|'plan-review'|'question' }
type NotificationKind = 'complete' | 'ask' | 'request'

// 纯函数：prev 事实 → next 事实 的边沿事件集
function detectNotificationEdges(
  prev: Record<string, SessionFacts> | undefined,   // 首份上报 = undefined（只播种，不发事件）
  next: Record<string, SessionFacts>): Array<{ sessionId: string; kind: NotificationKind }>
```

| 事件 | 边沿定义 | 说明 |
|---|---|---|
| `complete` | `running: true → false`，或合并事实行上的 `completed` 从无到有（该位由 App 账本注入，见 §3.7） | 同一 tick 两者同时成立只发一次；`completed` 只在「该会话先前未武装 completed」时补一次边沿（**不是**断连窗口内完成的补发通道：撤回后的首份上报是纯播种，见下条与 §3.5）；**父会话回合结束但子代理仍在运行（`runningSubagents > 0`）时不视为完成**（与官方 Rows / 侧边栏呈现优先级一致，抑制在去重之前、不记账） |
| `ask` | `pending` **值变化到 `'question'`** | 代理提问等待回答；含直切（question→approval 等不经 undefined 的切换——vendor 组合选择器会正常产生，每个新值都通知一次）；同值重放与清除（→undefined）不发 |
| `request` | `pending` **值变化到 `'approval' \| 'plan-review'`** | 工具/计划审批请求；直切/重放/清除语义同上 |

- **首报/撤回即播种**：`prev === undefined`（含通道撤回后的首份上报）只播种不发事件，
  窗口内完成/提问**不**补发（取舍与理由见 §3.5）；同内容重放不重复（边沿记忆按来源保留，
  与 `prevRunningRef` 同生命周期纪律；主进程 claim 兜底）。
- subagent 会话不产生事件（事实通道不含 subagent 行；父会话的 `runningSubagents`
  只驱动子代理计数徽标）。
- **P3 单入口修订**：生产裁决的唯一入口是 `packages/renderer/src/notification-projection.ts` 的
  `reconcile(state, observation)`——`completion-observation.ts` 把壳运行时 report 与 facts 快照两条
  独立到达的通道合并成每 (source, session) 一份可序列化观测；`App.tsx`（facts 轨）与
  `use-bridge-subscriptions.ts`（壳 report 轨）都只经 `observeSource` + `applyObservationBatch` 进入
  （接线锁 `test/wiring/session-authority-wiring.test.ts`），通知组装与 IPC 仍是 App 的单一
  `emitSessionNotification` 出口。`planRuntimeNotifications` / `planFactsNotifications` 只保留导出面给
  既有语义用例（生产调用点已全部迁走）；通知路径的 `usableFacts` 抑制分支与 App 内的第二完成循环已删除。

#### 3.2.1 goal 三值事实与两个门（P1/P2a/P2b）

运行时事实行新增 `goal?: GoalFact | null`（`packages/dsh-chamber-client-core/src/session-row-state.ts` 是唯一类型家）：

```ts
interface GoalFact {
  goalId: string
  revision: number
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  activation?: 'armed' | 'disarmed'   // §3.2.2 事件缓存；缺席 = unknown
  updatedAt?: number                  // host 域毫秒；诊断与身份签名，不参与门判定
}
// 字段缺席 = unknown（投影还没给出 goal 键）；null = 明确无 goal；对象 = 有 goal
```

- **解析（P1，挂载壳）**：`packages/dsh-chamber-client-core/src/derive.ts` 的 `parseGoalFact` 读会话行
  `projectionValues.goal` 的**嵌套**形 `{ goal: { id, revision, phase }, roundsStarted,
  updatedAt } | null`，只保留白名单字段（`objective`/`blockedReason` 永不读取——
  隐私条）；`revision` 必须是 safe integer ≥1、`updatedAt`（若在）必须是 safe integer
  ≥0，与控制面 P2a 的 `parseProjectedGoalFact` 及 P2b 的
  `source-mux-facts.parseProjectedGoalFact` 同规；键缺席/形状不符 = unknown +
  warn-once，**绝不折叠成 null**。生产者（`client/index.ts`）按来源代保留最后已知事实
  （`retainGoalFacts`）：unknown 行回填
  上一份已知值、行消失即 drop；ctx 重挂/来源指纹变化自然清空。P2a/P2b 的只读
  `session/list` 投影提供同一三值（§3.5、design 17 §10.7）。
- **身份签名**：`runtimeReportSignature` 的行编码必须包含 goal 的**全部五个字段**
  （`goalId/revision/phase/activation/updatedAt`），且**不得**落进 `includeRunning`
  分支——activation 是易失缓存，不入签名会被 App 的身份去重冻结在首见值。
- **两个门（刻意不同条件）**：零依赖叶模块 `packages/dsh-chamber-client-core/src/session-row-state.ts` 是**呈现门**的
  唯一出口（`goalSuppressesPresentation`，六面单源）；**通知门**没有生产消费者——
  `goalHoldsCompletion` 当前只由测试与文档引用，`reconcile` 在 §3.2.3 的 #5–#8 内联同条件
  （不 import 该谓词）：

  ```ts
  goalSuppressesPresentation(goal)  // phase === 'active'（含 activation unknown）
  goalHoldsCompletion(goal)         // phase === 'active' && activation === 'armed'（无生产调用点）
  ```

  呈现门更宽（activation unknown 也不得让用户先看到一次假完成，解析为 disarmed 后自愈
  重现）；通知门更窄（active+unknown 走 §3.2.3 的 unknown-hold，不冒充满足 armed）。
  `badge-count.ts` 保持零 import，只消费调用方预计算的布尔（§3.2.5）。

#### 3.2.2 activation：事件制（明确不调用 `goals/get`）

- **唯一来源**是转发事件 `goal/activation-changed`（已在 `$events` 转发 allow-list 内）。
  侧边栏插件**不新增 `inject` 成员**：经 `ctx.get('remote')` 访问并 try/catch——未
  provide 时 cordis 服务代理会 **throw**（不是返回 undefined）；订阅失败按 250ms 起、
  翻倍、上限 8 次的有界重试，耗尽后只 warn 一次并保持 inert（activation 永远 unknown ⇒
  通知层 unknown-hold，绝不伪造 disarmed）。实现里没有任何 `.goals` 访问（源码文本锁，
  `test/session-state/goal-activation.test.ts`）。订阅就绪时的「重扫」只针对**最后一份
  已观测事实的缓存**（没有 activation 读通路，无法凭空枚举在场 active 会话——这是
  §3.2.7 开放项的一部分；v5 的「就绪后扫描在场 active 会话」按代码收敛为此语义）。
  缓存有界（B4-1）：`MAX_ACTIVATION_CACHE = 2000`（与 P2a 的
  `MAX_PENDING_GOAL_ACTIVATIONS = MAX_SESSIONS` 同值，17 §10.7），超限淘汰**最久未
  更新**的一条（LRU：更新已有键 delete+set 刷新保留序，同 P2a），warn-once 并计入
  `evictedCount()` 诊断——ghost sessionId 事件洪泛不得无界增长（回归见 §4 `test:sidebar`）。
- **载荷与身份绑定（P1，2026-12 收敛）**：宿主载荷是嵌套
  `{sessionId, goal?: {id, revision, activation}}`（pin 上游
  `vendor/harness-checkout/packages/goal/goal/src/types.ts#GoalActivationChanged`）。
  `goal` 键缺席或显式 `undefined` = 宿主**明确无 goal**：清该会话缓存，值确有变化才
  `sync()`；`goal` 非对象、或 `activation` 不在词表 = 形状漂移 ⇒ 丢弃 + warn-once
  （绝不猜成 disarmed）。`goal.id` 做**身份绑定**：事件早于投影到达、**绑定 id 与当前投影不符时一律保留待匹配**，
  投影追上、id 匹配才应用（activation 永不转移，绝不落到投影里的另一个 goal 上）；边每
  会话至多一条、新事件覆盖，只随会话离开 report、显式 no-goal 事件、`reset()`/`dispose()`
  清除，绑定守卫（`activationOf` 仅在投影 id 匹配时合并）保证它绝不落到别的 goal 上。
  2026-12/F14 统一：旧的「换成第三个 goalId 才 drop」出口与 `awaitingBaselineOf` 已删，
  `scan` 对任何投影 id 都保留、绝不改写绑定。保留边纪律 P2a/P2b 同规——绑定 id 与基线
  不符一律保留待匹配、不直接 drop；no-goal 事件只清已知对象 goal、不缓存到 unknown 行、
  不落到新建行（P2b 见 §3.5，P2a 见 design 17 §10.7）。
  顶层 `activation`/`armed`/`active` 只是 legacy/test 兜底别名，不是主通路。
- **刷新触发**：running **双向**变化、每次 goal 投影变化、`connection/reset`；触发时重扫
  缓存（会话离开 report / 显式 null ⇒ drop；换 goalId 按上条保留边规则——绑定 id 与投影
  不符一律保留待匹配，投影换到任何其它 id 也不 drop；未绑定边在首个已知投影上落身份；
  unknown 保留最后已知）；
  `connection/reset` 整体清空缓存、丢弃死代的订阅并按 attempts 预算**重新订阅**（新代
  重获完整预算），且 `sync()` 重报。解析值一旦变化必须 `sync()` 重报——否则 App 的
  身份去重会冻结 activation（§3.2.1 签名纪律）。
- **禁止 `goals/get`（R3 逐行核实）**：宿主该 lookup 的 agent 解析被覆写为
  `resolveAgent → resume`，对冷会话等于**拉起 agent（写面）**，违反 design 17 §10.7
  「没有任何写面」；且 lookup 已保证 agent live，该 wire 永不返回
  `GOAL_AGENT_NOT_LIVE`，原「按错误码分级」的前提不成立。
- **unknown 语义（两级 unknown，绝不混同）**：
  - **activation unknown**（有 goal 对象、相位 active、事件未到）：完成候选 **hold**
    （进 pending 并吸收水位）、已有 pending **keep**；唯一确定性出口是收到 activation
    事件或相位离开 active。刻意代价：宿主重启后 active+disarmed 的会话在收到首个
    activation 事件前保持暂存（宁可不打扰，不误报）。
  - **goal 事实 unknown**（该来源代从未拿到 goal 键）：无 pending 时按 §3.2.3 #11
    fail-open 发中性「会话已完成」；已有 pending 时只吸收水位，既不结算也不 emit。
- **开放项**：向 dsh 提「只读 activation 读」上游提案（或 chamber seed 插件），落地后
  替换 unknown-hold 静默窗口（§3.2.7）。

#### 3.2.3 水平收敛器（状态 / 观测 / 前置门 / 裁决表）

**状态**（`complete-ledger.ts` 的 `CompletionDecisionState`；两级键
`source → session/goalId`）：

```ts
interface CompletionDecisionState {
  notified: Record<sourceId, Record<sessionId, Partial<Record<kind, number>>>> // durable
  pending:  Record<sourceId, Record<sessionId, { watermark?; goalId?; deferred?: 'subagent-busy'; at }>> // durable（deferred 随条目落盘，见 §3.2.4）
  outcomes: Record<sourceId, Record<goalId, number>>                           // durable
  armed:       Record<sourceId, Set<sessionId>>  // volatile（壳边沿武装位）
  armedFloor:  Record<sourceId, Record<sessionId, number>> // volatile（与 armed 同拍清理：该次消费的已消费水位上界，armSession 写；见 G5）
  settleFence: Record<sourceId, Record<sessionId, { boundary: number; seededSince?: number }>> // volatile（水位围栏：boundary + 播种补偿 seededSince，见下）
  generation:  Record<sourceId, number>          // volatile（G1 代际门）
  goalKnown:   Record<sourceId, Set<sessionId>>  // volatile（§3.2.4 结算点记忆）
}
```

页代 token 不属于账本状态：单源是 `boot-token.ts`（经 `completionIdentity` 进观测层
identity）；`CompleteLedgerOptions.bootToken` 只是 App 调用点继续按原签名传入的
**兼容入参**，账本既不读也不存它（新调用点无需提供）。

**观测**（`completion-observation.ts` 每份可序列化、含转移、每会话至多一个候选）：
每份观测 = 来源代 `generation`、`running` 三值、`subagents` 三值、goal 三值
（`GoalFact | null | 'unknown'`）、可选 `candidate`（`{ kind?, watermark?, evidence:
'shell-edge' | 'facts-watermark' }`；`kind` 缺省 = complete，承载 #12 的 ask/request）、
`baseline`、`boot: 'same' | 'fresh'`、可选 `factsMemory`（已吸收水位）。边沿所需的
prev 位不在观测里（F26 已删 `prevRunning`/`prevGoalPhase`），由观测层 per-session
转移记忆（`shellRunning`/`shellPending`；壳行的 `completed` 位**不参与**——通道行从不携带它，
完成证据只有运行位 true→false 边沿与 facts 水位）承担。running 权威：同代
**新鲜壳行**优先；否则非 stale 且 serviceable 的 facts 行；否则 unknown（不作废、
不产生候选）。
**stale 壳批（C4-X3）**：壳通道标记 `stale` 时，该批的整体观测在**候选生成层**关闭
complete 与 ask/request 边沿（stale = 断连来源仍附加的只读事实，不得作运行证据，
running 权威也随之降为 unknown）；行记忆照常推进，故 `stale` true→false 的同一行
不凭旧位补发一次边沿；非 stale 的 pending 真变化与新回合照常产边沿。
**观测层状态（D4）**：每来源 `SourceObservationState` 的 `baselineDone` 是 G2 基线与
boot 值闩锁的**合并字段**（原独立 `bootReported` 已删，二者机械同拍）：初值 false、
每批末尾置 true，`baseline = !baselineDone`、`boot = baselineDone ? 'same' : pageBoot`
——`pageBoot` 只到本代首批（含空首帧）。

**前置门**：

- **G1** 观测代际 ≠ 已记录代 ⇒ 整份丢弃（旧代迟到帧不得改状态）。
- **G2** baseline（该来源本代第一份**批次**，**空首帧也算**）不 emit：有待结算
  pending 时候选可用于水位吸收/静默结清；无 pending 时基线候选直接丢弃，不产生通知。
- **G3** unknown 只栅栏对应维度：goal unknown ⇒ 不结算/不 hold（候选照走 #9–#11）；
  running unknown ⇒ 不作废；subagents unknown ⇒ 不压制。
- **G4** 子代理 busy（仅运行证据，见 §3.5 的 facts-only 修正）⇒ complete 候选延迟：
  吸收进 pending，不 emit、不 flush、不推进 notified。busy **只延迟、不压制**：释放时
  goal unknown ⇒ fail-open 中性直发（#11）、已知 null/paused ⇒ 中性直发（#10），
  active/complete/blocked 不在此释放，继续走既有 pending 分支（#2/#4–#6）；释放消费
  pending、推进水位、arm，无 facts 水位时置 settleFence。**deferred 释放不受基线门
  （G2）约束**：`deferred:'subagent-busy'` 是「此刻本应直发」的 durable 身份，boot=fresh
  已在账本构造期丢弃 pending（不会补发离线完成），故基线观测同样释放（`baseline` 不参与
  判定）——goal unknown 走 #11、已知 null/paused 走 #10；否则同页 reload（boot same）后
  首次观测常是基线，延迟的完成会永久滞留。**非 deferred** 的基线行为不变：goal unknown
  只保留待下一份非基线观测、已知 null/paused 按 #3 静默结清（离线不补发）。延迟标记
  `pending.deferred:'subagent-busy'`
  只在**新建** pending 时采纳——已有 pending 保持自己的身份（目标 hold 不得被一次 busy
  改写为可释放的延迟）。
- **G5** facts 候选的水位必须相对 pending 吸收位与已通知位**严格前进**；壳候选已被
  armed ⇒ 无候选（同一次完成的延迟 completed 边沿不得再出）。无 pending 且壳已 armed 的
  facts 候选**按 `armedFloor` 分界**（armSession 在 arm 时记下该次消费的 candidate/notified
  水位上界，易失轨、与 armed 同拍清理）：水位 **≤ 界** ⇒ 同一次完成的重复上报，不 emit、
  单调记水位（防止重新 running 解除武装后重提旧完成）；水位**严格更高 ⇒ 新完成**，照常消费
  并 emit（`consumeCompleteCandidate` 顺带把界推进到本次消费水位）。没有水位界的旧无界
  入口（`setArmed`）保持原汇合语义。这条界是无 running=true 解除武装出口的 facts-only
  来源不被首次 arm 永久吞发的边界。**恢复批重播种（F30 精度）**：复位谓词 = 本批**显式携带**
  facts 输入、`usable=false`（stale/degraded/serviceable=false）**且来源级易失旗标
  `shellCompleteSinceFacts` 为真**——该旗标是「自上次可用 facts 批以来，壳轨确实 emit
  过无水位 complete」的单义证据，由 `applyObservationBatch` 依 reconcile 结果判定
  （`complete` 通知 + 本次新置/覆盖 `settleFence`）；任何**可用** facts 批清位，
  纯壳批（facts 输入缺席）既不清位也不复位，不可用批在批首按既有旗标复位、在批末按含本批
  置位的旗标由 `applyObservationBatch` 幂等补做。「壳轨在场 / `shellSeeded`」**不再是**
  复位条件（COR-1 收窄）：壳轨首报只播种、仅 stale（C4-X3 无 complete/ask 边沿）、会话只在
  facts 行——三者都没有壳通知可吞，复位会把从未通知过的 observed 水位当播种吸收（永久丢发）。
  复位时只有**确实复位了已播种状态**（`factsSeeded` 本为真）才挂 `factsReseedPending`；
  从未播种来源的恢复批仍是本代首份可用批次，按 G2 对全体会话播种。恢复后的首个可用批只在
  `factsReseedPending` 下对「确实通知过」的会话重新播种（per-session `shellNotifiedSinceFacts`
  为真者吸收水位、不产候选），其余会话照常按水位严格前进通知——复位不得株连从未通知过的
  facts-only 会话；不可用窗口内壳轨已通知的完成，facts 追平时水位会严格前进，不重播种就会以
  「已播种 + 水位前进」产出候选而二次通知。

**12 条裁决表 + G4 释放（#13）**（`reconcile` 逐条实现；每份观测都跑 pending 结算，不依赖跳变帧）：

| # | 条件 | 动作 |
|---|---|---|
| 1 | running 权威 = running（含 idle→running） | pending 作废：结清 `notified` 到 `pending.watermark` 后 drop；解除 armed、清 settleFence（`voided`） |
| 2 | pending + goal 已知 + complete/blocked | flush 一次：水位 = `max(pending.watermark, goal.updatedAt)`；标题按 outcomes（该 goalId 首见 ⇒「目标已完成/目标已受阻」，已见 ⇒「会话已完成」）；记 outcomes、消费 pending、arm；无 facts 水位的 flush 置 settleFence（`flushed`） |
| 3 | pending + goal 已知 + paused / null / goalId 变化 | drop：结清 notified，不通知（origin 命名仅 `goal-paused`/`goal-none`/`goal-changed` 三个；旧 `goal-drop` 兜底不可达，F14 已删） |
| 4 | pending + goal 已知 + active + disarmed（非基线） | flush 中性「目标未继续运行」**一次**（该 goalId 首见；已见 ⇒「会话已完成」）；记 outcomes、消费 pending、arm；无 facts 水位置 settleFence（`flushed`） |
| 5 | pending + goal 已知 + active + activation unknown | keep（等 activation 事件或相位变化），不 emit |
| 6 | pending + goal 已知 + active + armed | keep |
| 7 | 无 pending + 候选 + goal 已知 + active+armed | hold：水位吸收进 pending + arm（`held`，origin `goal-armed`） |
| 8 | 无 pending + 候选 + goal 已知 + active+unknown | hold + 等待 activation 事件（与 #5 同出口；origin `goal-activation-unknown`） |
| 9 | 无 pending + 候选 + goal 已知 + complete/blocked | 该 goalId 首见 ⇒ 目标标题 + 记 outcomes；已见 ⇒「会话已完成」（直接 emit，无 disposition） |
| 10 | 无 pending + 候选 + goal 已知 + active+disarmed / paused / null | 「会话已完成」（中性/目标标题只随 pending 消费一次） |
| 11 | 无 pending + 候选 + goal unknown（本代从未已知） | 「会话已完成」（fail-open 到现状；拿到 goal 事实后转 #7/#8） |
| 12 | ask / request 候选 | 直通 emit，仅受 G2 播种约束（INV4）——goal 状态不影响提问/审批 |
| 13 | G4 延迟的 pending（`deferred:'subagent-busy'`）遇释放（busy 结束后的首份观测，**基线也释放**） | goal unknown ⇒ #11 中性直发；null/paused ⇒ #10 中性直发；active/complete/blocked 不释放（继续走 #2/#4–#6）；释放消费 pending、推进水位、arm，无 facts 水位时置 settleFence；水位已被通知 ⇒ 只清不重发（settle-guard） |

- **每份观测可产两条通知**：ask/request 直通与 pending 结算**不互斥**——`reconcile`
  先按「无 complete 候选」跑本体（含每份观测的 pending 结算），再直发 ask/request，
  回执携带**有序** `notifications`（结算通知在前、直发在后；标量 `notification` 为
  结算优先、否则直发）。否则 hold(g1) → 观测（目标 outcome + ask）会只发 ask，pending
  要等下一份观测才 flush，期间撤回即丢一次。

**水位与围栏**：候选并入已有 pending 时 `pending.watermark = max(...)`，入场时刻
`at` 不被刷新（pendingAge 语义）；flush 水位 = `max(pending.watermark,
goal.updatedAt)`；`notified` 单调只升。**settleFence（A2/A3-3/B3-1 边界化）**：每次
**无 facts 水位的消费**——壳候选 #9/#10/#11 直发、无水位 flush（#2/#4）、无水位
releaseDeferred（#13）、基线/首见 outcome 的静默结清无水位路径——为该会话置一次性栏
`{ boundary, seededSince? }`，`boundary` = 置栏观测当时该会话**已吸收**的 facts 水位
（`observation.factsMemory`，不可知 = 0）。栏对 facts 候选的裁决按序：
① `W ≤ boundary`（含 `W == boundary`，R5/B4-3 用例钉扎）⇒ 必为被守卫的同一完成，
吞并推进 `notified`；② 否则
`seededSince !== undefined && W > seededSince` ⇒ 播种只到 ≤ boundary，这是被守卫完成
的首次上报，吞并推进 `notified`；③ 否则（严格高于 boundary 且无播种补偿）⇒ 真正的新
完成，清栏放行正常裁决。壳候选（无水位）遇栏 ⇒ 吞并清栏（延迟到达的同一次壳完成不得双
发）。栏无论如何都在一次裁决后清除（一次性）；running=true（#1）与撤回/遗忘/剪枝
（withdraw/forget/forgetSession/prune）同样清栏。**播种补偿（`fenceSeeds` /
`seedSettleFence`）**：`observeSource` 把「facts 播种 = 对同一完成的等价消费」的会话与
吸收水位列入批回执 `fenceSeeds`，`applyObservationBatch` 逐会话交账本裁决——
seededWatermark > boundary ⇒ 清栏（播种已吸收被守卫的完成）；否则
`seededSince = max(旧值, seededWatermark)` 并保留（其后首条严格更高的候选按 ①②吞
一次）。覆盖三处播种：本代首份可用 facts 快照（`factsSeeded` false→true 的播种批）、
重现会话带可用 facts 水位行的播种、`factsSeedPending` 消费的首个真正吸收 observed 水位
的 facts 行。**恢复播种批的第四处（C4-X2）**：恢复批里**没有可吸收 observed 水位**的
在场会话也登记播种（watermark = **播种前** memory 水位），两种形态都算：(a) 行在场但
`completedAt` 非 `observed` / 无水位行（在途快照）；(b) 行带 observed 水位但被 **I1** 挡下
（running 权威 = running，本批不吸收）。**实现边界**：facts 行**完全缺席**、会话仅经壳行在
场的形态同样按「该会话本批无可用水位」登记——有栏则其后首个严格更高的 observed 水位按 ②
吞一次，无栏是 no-op（`seedSettleFence` 无栏即返回），正常新完成（无论有无栏）不受影响。
语义是「被栏守卫的完成尚未在 facts 侧出现」；不这样做时，壳轨无水位 emit 置下的栏会吞掉
播种之后真正的新完成（且栏自清，该新完成永久漏发）。**同批清栏豁免
（`ReconcileOptions.keepFence`）**：`applyObservationBatch` 对同批登记了 `fenceSeed` 的
会话向 `reconcile` 传 `keepFence:true`，该批 **#1 running 权威**跳过 `settleFence` 清除
（播种补偿与本份观测同批落账，清栏会让它整条失效）；豁免**只覆盖清栏**——pending 作废
（结清 `notified` 后 drop）与解除 armed 的 #1 语义不变；缺省参数 / 单独重放同一观测时没有
该选项，仍按 #1 清栏。**I1 契约（running 权威不吸收水位）**：running 权威 = running 的观测
**不得**消费 facts 水位记忆——不推进 `memory.factsWatermark`、不把水位吸收进 pending，
facts 候选保持**可重提**（两通道可能相差一个 commit：facts 已报完成、壳仍停在上一回合
running，此刻 #1 早退丢弃候选；若已推进水位，壳追平 idle 后同一候选永不重提 ⇒ 丢发）。
真正的新回合以更高水位覆盖它；相邻 C4-X2 播种块对「被 I1 挡下的水位」只登记围栏播种补偿，
不改这条不吸收契约。**结算守卫**：flush/drop 前若 `notified ≥ pending.watermark` 视为
已消费，直接 drop（TL3 崩溃重放闭合）。

`reconcile` 幂等（INV6，精确边界）：**complete** 候选的幂等由候选消费保证
（facts ⇒ notified 单调前进；壳 ⇒ armed），相同 complete 观测重放不产生第二条通知；
**ask/request 的幂等不在 `reconcile` 内**——它由观测层 `observeSource` 的壳边沿记忆
（`shellPending` 同值不产生候选）承担，生产唯一接线即该入口：**直接重放同一份
ask/request 观测会再发一条**。幂等另有**批序前提**：成立需「批序无中断、不重放旧批」——
生产唯一接线即时消费每批，跨批易失状态（`settleFence` 等）只按当前批推进；若在一份
running 批之后重放更早的批，其 `keepFence` 早已随原批过去、围栏已按 #1 清掉，同一完成
会被再 emit 一次——该重放形态在生产接线之外（见 §3.2.7 跨批边界），不可达。

#### 3.2.4 交付契约（重载存活、离线不补发）

- **页代 token**：`sessionStorage` 键 `dsh-chamber.boot-token.v1`（`boot-token.ts`）
  ——读到同 token = reload（保留 pending/outcomes），缺失/坏值/新进程/新窗口 = fresh
  （丢弃 pending 并 loud；`notified/outcomes` 仍 durable）；storage 不可用降级为内存
  token 并判 fresh（宁可多丢一次 pending，不打断启动）。
- **结算点**：每 (source, session) 本代**第一份带已知 goal 事实**的观测是结算点（首份
  批次，含空首帧，同样是基线 G2）：若此时结论已定（complete/blocked ⇒ 静默结清并记
  outcomes；null/paused/goalId 变化 ⇒ 静默 drop），一律**不通知**。goal 仍 active 时按
  activation 分出口：armed / unknown ⇒ pending 继续 keep（§3.2.3 #5/#6，等激活事件或相位
  变化）；**例外（#4）**：该观测**不是本代基线**（`baseline === false`）且 activation 已是
  disarmed、且已有 pending ⇒ 立即 flush 中性「目标未继续运行」**一次**（该 goalId 首见 ⇒
  goal-stopped；已见 ⇒「会话已完成」），消费 pending 并 arm——这不是 keep。分界在
  `notification-projection.ts` 的 #4 分支条件 `activation === 'disarmed' && !baseline`：
  基线观测即使 disarmed 也走 #5/#6 keep（G2 更高优先，等下一份非基线观测结算）。
  离线「完成 + outcome 均已发生」⇒ 首份已知 goal 事实即 outcome/null ⇒ 静默结清，**不补发**。
  **例外（G4 deferred 释放）**：`pending.deferred === 'subagent-busy'` 的释放不受本结算点
  与基线门约束（§3.2.3 G4/#13）——延迟位是 durable 身份、boot=fresh 已在账本构造期丢弃
  pending，基线观测同样按 #10/#11 中性释放一次；否则同页 reload 后延迟完成永久滞留。
- **落盘**：pending 的每次变更（hold / 吸收 / 结清 / 清）都经 unread v2 的 `pending`/
  `outcomes` 增量持久化，与 `notified` 同一次写；flush、撤回与会话消失**立即**排盘
  （`persist(immediate=true)`），`voided`/`dropped`（#1 作废、#3 静默结清/结算守卫）同样立即
  （TL3：1s 节流窗口内崩溃重放不得复活已作废的 pending）；变更检测按三张 durable 表的
  写时复制引用，而不是只按 disposition（纯水位吸收也必须落盘）。**immediate 落盘经微任务
  合并（F28，`unread-store.createUnreadSaveCoalescer`）**：同一 tick 的多次 immediate 合并成
  一次全量落盘（`request()` 只排一次微任务，落盘时读当时最新内存权威——合并只推迟写、
  不改变写内容），避免一波 `voided`/`dropped`/`flushed` 各做一次全量 prune + stringify 阻塞主线程。
  **关键路径同步 flush**：`pagehide`、`visibilitychange`（hidden）与 unmount 调 `flush()`——
  取消待办微任务并同步落最新状态（不丢也不重复；无待办也照常落一次）；flush/voided/dropped 的
  关键路径语义不因合并被跳过。**`deferred` 是 pending
  的 durable 身份**（G4）：unread v2 的 `pending` 段逐字段持久化，`sanitizeUnreadPayload`
  接受合法值 `'subagent-busy'`、非法值只丢该字段而**绝不整条丢弃**（`at` 才是条目成立
  条件）；reload（boot same）后延迟待释放的完成仍能按 #10/#11/#13 中性释放——丢了它会在
  同页 reload 后既无法释放、又可能被 #3 静默 drop。
- **重载存活纪律（disk-seeded 剪枝门）**：App 首帧**同步**载入 v2 的 read/edge
  （unread-store）与 complete 账本的 notified/pending/outcomes，而权威远端 roster 是异步
  事实（桥就绪 + `instances_get` 往返）。四类 disk-seeded 剪枝——`completedBySource`、
  completeLedger 的三张 durable 表（`prune`）、`readMarks`、`edgeLedger`——必须门控
  在**权威 roster 已结算**（`remoteRosterSettled`：refreshRemotes 成功结算且桥已就绪）
  之后；未结算不得剪枝、不得落盘——否则依据只含 local 的 live 集合，会把远端来源的
  durable 未读在首帧写盘删除（pending/outcomes/notified/read/edge 全部不可恢复）。结算
  那一拍的 state 变化重跑剪枝 effect，届时再按完整 live 收敛；易失轨（prevRunning /
  观测状态 / 水位记账）不在此门内。**无桥形态（F11）**：`durableUnreadPruneAllowed` 把
  桥面判定 `'absent'`（500ms 探测预算耗尽仍无 `desktopSsh`，浏览器/dev 直开）**视同已
  结算**放行——该形态没有远程来源，`live={local}` 即完整权威集合；预算内缺席
  （`'pending'`，桥可能迟到）与有桥未结算同样关门。**注册表加载降级（F13）**：
  `refreshRemotes` 在 roster 读取前先 invoke 只读健康通道 `desktop_ssh_instances_health`
  （载荷终态 `{degraded, reason?, rosterIncomplete, droppedCount?}`，非秘密；主进程记录
  最后一次注册表加载失败与行级丢弃，契约见 05 §7.4）：degraded 时空 roster 不是权威——
  **不安装、不置 `remoteRosterSettled`、warn-once**，保持「有桥但未结算」，且
  `durableUnreadPruneAllowed(settled, bridgeVerdict, registryDegraded, rosterIncomplete)`
  把 degraded / rosterIncomplete 作**同档优先否决**维：无论结算位与桥面判定为何（含
  `'absent'` 的防御性组合）一律关门，durable 键不剪、不落盘；注册表成功加载或权威
  `save_connection`（authoritative）原子重建后健康位清零，再按正常结算收敛——事务回滚
  （compensation）不清零、降级期间的回滚写只改内存不落盘、重启仍 degraded，直至一次
  authoritative 保存治愈（F16/A4/F19，契约见 05 §7.4）。**roster 行级丢弃（V5-A）**：
  JSON 数组解析成功但条目被丢弃——`validateSpec` 拒绝、null/非对象行、重复 id 首胜——
  时合法行**照常安装**（连接可见、结算照常），但 roster 只是磁盘内容的子集，健康位报
  `{degraded:false, rosterIncomplete:true, droppedCount:N}`（健康完整为
  `{degraded:false, rosterIncomplete:false}`，旧生产者缺字段按 false/0 读）；该维同样
  关死四类 durable 剪枝（与 degraded 同档、含 `'absent'` 防御性组合），且 incomplete
  期间 `compensation` 回滚也**跳过落盘**（部分快照写回会让下次启动把「部分」读成
  「完整」并重新放行剪枝）；一次**无丢弃**的成功 load 或 **authoritative** 重建后
  `rosterIncomplete=false`，剪枝 effect 在下一拍重跑收敛。诊断由
  `rosterIncompleteDiagnostic(droppedCount)` 单源、warn-once，与 degraded /
  health-unavailable 三角可区分。**健康探针不可用**（旧桥缺
  `instances_health` / invoke 抛错）同走 fail-closed：不安装、不置结算位、不折叠成
  degraded，按可区分诊断 warn-once（F16/A4）。**已知边界**：
  同页 reload 后观测状态为空表，`forgotten` 只对本代**观测过**的会话产生——两通道皆缺席的历史会话不会触发
  `forgetSession`，其 durable pending 留到下次 boot 的年龄卫生或来源级 `prune`
  （§3.2.7 ③）。
- **卫生上界**：加载时丢弃 `at` 超过 7 天的 pending 并 loud（`PENDING_MAX_AGE_MS`；
  卫生上界，不是判定计时器）；unread-store 剪枝与 read 同界（每来源 500），outcomes 按
  水位 LRU 同界。
- **撤回与遗忘语义**：通道撤回（壳重连/重 boot）清该来源 armed + armedFloor + pending +
  settleFence + goalKnown（B4-2：结算点记忆与会话身份同拍作废，撤回后恢复的首份已知
  goal 事实重新成为结算点；恢复后首份观测不补发窗口内完成，围栏也不得跨撤回存活；水位界与 armed 同拍
  清理，见 §3.2.3 G5），`notified/outcomes` 保持 durable；reload 不清；
  `forget/prune/归档/removed` 按既有作用域收敛账本（来源退役 `forget` 连 durable 表
  一并删除）。**会话级遗忘**：某会话从**在场集**消失时同拍清 armed + armedFloor +
  settleFence + pending + goalKnown（notified/outcomes durable；B4-2），并进入 `forgottenSessions` 重现
  播种集（FIFO 上界 500，`FORGOTTEN_SESSION_LIMIT`，重现即消费该记忆）。**重现播种完整
  规则**：重现批**不产候选**、facts 水位记为已见，避免消失前已通知的同一完成经壳
  completed 边沿或 facts 水位二次通知；重现批**无可用 facts 水位行**（通道不可用 / 行
  缺席 / 非 `observed`）的会话挂 per-session `factsSeedPending`，其**首个真正吸收
  observed 水位的 facts 行只播种**（不产候选、水位入 memory）后清除——行已可用但
  `completedAt=null` / 非 `observed`（暂无可判水位）**不清待决位**（A3-1：否则下一行会
  以「已播种 + 水位前进」把消失前已通知的同一完成二次通知）；之后严格前进的水位/新壳
  边沿照常通知。**已知边界（有界优先）**：同一来源在记忆窗口内
  遗忘超过 500 个不同会话时 FIFO 淘汰最旧键，被淘汰的会话重现不再播种；若是「先壳边沿
  通知、facts 后到同一完成」，极端 churn 下可能重复一次壳边沿通知——不做无界水位缓存，
  登记为已接受边界。
- **观测状态删除 = scoped withdraw（FINAL-C，F30 登记）**：App 从观测表删除一个来源
  （该来源不在 `live`）时同拍 `withdrawObservationState` 做 scoped withdraw——观测状态是
  易失轨，不随 durable 剪枝门（`durableUnreadPruneAllowed`）关门；若不同拍清账本，重建的
  新代（`freshState`，代际从 1 重算）首个 outcome 会拿旧 watermark flush 旧 pending。
  **取舍**：门关窗口（未结算 / degraded / rosterIncomplete）里 `live` 可能只是磁盘内容的
  子集，被剪来源的 durable pending 会被删掉且不补发（与通道撤回同语义；`notified/outcomes`
  保持 durable）；若该来源只是 roster 缺口、会话仍活跃，重新纳入 `live` 后由新代重新观测，
  其后的完成按 goal 状态重新 hold。有 pending 被清时必须排一次落盘，否则旧 pending 会从
  磁盘复活（页重载后以旧水位 flush）。相邻的 facts 输入缺席边界见 §3.2.7 ⑦。
- **在场集定义（原始通道行键）**：在场 = 壳行键 ∪ facts **原始**行键（不是可用/过滤后的
  facts 行）。通道不可用/stale/degraded 只降该维度为 unknown，**不得当作会话缺席**——
  否则断连会把 held pending / armed / settleFence 当成遗忘清掉（`factsChannelRows` 与
  `factsRows` 的分界；2xx unversioned / 404 legacy 的通道判定见 §3.5）。

#### 3.2.5 消费面（通知唯一出口 + 六面单源）

- **通知**：唯一组装/发送出口仍是 App 的 `emitSessionNotification`（`kind = 'complete'`），
  由 `notifications.onComplete` 开关管辖（目标标题不新增开关）。标题身份：
  `session-completed` → `notification.sessionComplete`（「会话已完成」）、
  `goal-completed/goal-blocked/goal-stopped` → `notification.goalCompleted/goalBlocked/
  goalStopped`（zh/en，`renderer/src/locales.ts`；`frame-locale` 用例钉住 key 与
  调用点）。ask/request 文案与 goal 无关。**实现偏差**：v5 曾提议把设置开关文案改为
  「完成（含目标结束）」，代码保持 settings-bridge locales 现状（`generalNotifyOnComplete` =
  「会话完成时 / When a session completes」）；若改需同步 `locales.ts` 与编译期配对门。
  **刻意分叉**：goal 转 `paused` 后呈现门不再压制（完成未读出现）而通知按 #3 drop——呈现
  与通知的门本来就不是同一个。
- **六面单源**：`packages/dsh-chamber-client-core/src/session-row-state.ts` 的 `sessionRowState` 是唯一派生源，六面
  全部由同一结果派生——`server-section-session-state.tsx` 的 `sessionStateLabel/
  sessionStateDot`、`ServerSectionRows.tsx` 的 `data-chamber-session-state` /
  `data-chamber-state-source` 仪表属性和可选 `data-chamber-goal-active`、
  `ServerSectionSearch.tsx` 的搜索结果
  行、`todo-attention.ts` 的待办条目、以及徽标计数。`goalSuppressesPresentation`
  生效时 `state` 必须落 `running`/`none`——**不得为 completed**；`suppressedBy` 区分
  `'goal'`（activation 已知）与 `'unknown'`（activation 未知）。
- **M5（已知分叉，留作后续收敛点）**：待办区的**阶梯**（`todo-attention.ts` 的
  pending-before-completed 分支序）与其它五面共享同一组谓词
  （`goalSuppressesPresentation`/`subagentActivityOf`），但**分支顺序不共享**——
  `sessionRowState` 只表达**单读数**（pending > 子代理 > completed > 运行/none），直接
  改由它派生待办条目会把「pending kind 开关关闭时**不得回退 completed**」的
  no-fallback 语义藏进分类器（`sessionRowState` 不掌握逐 kind 开关）。现状两处等价、
  用例各自钉住；收敛（或显式共享阶梯）留作后续。
- **徽标**：`badge-count.ts` 保持**零 import**，只消费调用方预计算的 `goalActive` 布尔
  （sidebar 叶谓词）与 `subagentActivity` 三值；`use-badge-count` 传入**合并后**的
  runtime（通道 ∪ 蓝点 ∪ facts overlay ∪ stale），与 `sessionRowState` 同拍（INV7）；
  断连/stale 来源的残留计数不算「在跑」（§3.7）。
- **独立计数**：收敛器的 `held/flushed/voided/dropped/deferred` 与 `origin`/`pendingAge`
  是独立诊断计数（`notification-ledger.ts`），与主进程 `sent/suppressed/skipped` 回执
  账本互不替代；实机正对照读 `held ≥ 1 && sent == 0` 这类判据（§4）。

#### 3.2.6 Rejected alternatives（goal 层）

1. **`goals/get` 播种 activation**：冷会话 resume = 写面，且错误码前提不成立（§3.2.2）。
2. **常驻 `session/control` 流**：基线只含 attached 会话、全投影隐私/流量越界——改走
   既有只读 `session/list` + `$events`。
3. **unknown 重试耗尽后自动判 disarmed**：会假报「目标未继续运行」；unknown 的唯一出口
   是事件或相位变化。
4. **目标标题随相位长期重放**：目标投影 complete/blocked 会持久保留，每次普通完成都会
   重播目标标题——由 outcomes 一次性身份闭合（R2-A/TL1）。
5. **通用 debounce 作主机制**：goal 活跃驱动的续跑不是频域问题，压制需要相位/身份而非
   时间窗。
6. **只修通知或只修呈现**：两门刻意不同（呈现门更宽），只修一侧会留下假完成或假通知。
7. **让 `session-state.goal` 成为 required capability**：旧 gateway/旧桌面须保持现状可用，
   只能可选宣告（design 17 §10.7）。
8. **为 goal 通知新增 kind/设置开关**：沿用 `complete` 与 `onComplete`，避免设置面无谓
   扩张。
9. **改上游 status 位或复用 `completed`**：上游事实的权威不可由 chamber 改写。
10. **pending 延迟全部完成通知**：那会让普通来源/普通回合也失去即时性；压制必须由 goal
    身份/相位触发，而不是延迟所有完成。
11. **蓝点不武装（只在通知层压制）**：呈现/待办/徽标会与通知分叉；本设计让蓝点账本照常
    武装，由六面同一个呈现谓词压制（§3.2.5）。

#### 3.2.7 开放项

1. **只读 activation 读**：上游提案或 chamber seed 插件（替换 §3.2.2 的 unknown-hold
   静默窗口）。
2. **实机验收与上游读**：打包态实机走查（同 §4）与「只读 activation 读」上游提案
   （本项第 1 条）仍是剩余面。
3. **侧边栏 goal 指示与 schedule/job 续跑扩展**：本期只做压制/标题/六面一致（goal 不新增
   独立视觉元素）；续跑类来源（schedule/job）不在收敛器输入内，扩展面留待后续（范围决策
   登记见 `docs/progress/STATUS.md`）。

**已知边界/取舍（2026-12 第三/四轮同步登记，逐条与实现核对；原第②条「ssh-instances 注册表损坏剪远端 durable 键」已随 F13/F16/A4/F19 闭合注销——degraded 期间不剪不落盘、补偿写不落空表、重启仍 degraded，契约见 05 §7.4 与本节 §3.2.4）**：

- ① **无桥形态的剪枝门视为已结算（F11 已修）**：500ms 探测预算耗尽仍无
  `desktopSsh` ⇒ `bridgeVerdict='absent'`，`durableUnreadPruneAllowed` 视同已结算放行
  （无远程来源，`live={local}` 即完整权威集合）；预算内缺席（`'pending'`，桥可能迟到）与
  有桥未结算同样关门。实现口径见 §3.2.4。
- ③ **reload 时两通道皆缺席的会话无 forget 事件**：`forgotten` 只对本代**观测过**的
  会话在两条通道都不再列出时产生；同页 reload 后观测状态是空表，历史缺席不会触发
  `forgetSession`——其 durable pending 留到下次 boot 的 7 天年龄卫生或来源级 `prune`
  （会话重现则按重现播种消费）。有界且不产生错误通知，登记为实现口径。
- ④ **silent-settle 无水位 pending 仍置栏（保守，保留旧行为）**：基线/首见 outcome 的
  静默结清在 `pending.watermark` 缺席时同样走无水位路径置栏（boundary = 当时已吸收
  水位）；该栏只吞掉同一次完成的下一条 facts 候选，不改变「离线不补发」语义。
- ⑤ **P1/P2a/P2b 保留边纪律统一（F14 已收口）**：三路一律「绑定 id 与当前投影/基线不符
  时保留待匹配」——P1（挂载壳，`goal-activation.ts`）的边每会话至多一条、新事件覆盖，
  只在会话/行离开、显式 no-goal、`reset()`/`dispose()` 时清除，绑定守卫（`activationOf`
  仅在投影 id 匹配时合并）保证绝不落到别的 goal 上；P2a（design 17 §10.7）与 P2b
  （§3.5）的行事实面同规。第三 goalId drop 出口与 `awaitingBaselineOf` 已删，P1 不再是
  刻意差异。
- ⑥ **跨批围栏重复（V5-B 已登记边界，2026-12）**：触发链——facts 不可用期间壳边沿
  通知 C1 并置栏（boundary=0）→ 新回合 running 观测在**另一批**先到，该批没有
  `fenceSeed`，围栏按 #1 原语义清掉 → facts 恢复批的 C4-X2 播种登记**无栏可依**
  （`seedSettleFence` 无栏即 no-op）→ facts 侧迟到的被守卫完成水位（旧 observed 水位，
  或行完成后补齐）按 rule ③ 判成新完成再通知一次。用例：
  `completion-observation.test.ts` 的 `KNOWN-BOUNDARY(C4-X2 cross-batch)` 与
  `KNOWN-BOUNDARY(I1 fence cross-batch)` 各钉住 2 个物理完成 / 3 条通知（水位序列
  `[undefined, 100, 200]`）；主进程 5s 去重 claim 键为五元组
  `[sourceId, sourceFingerprint, sessionId, kind, eventKey]`（§3.3），首条壳边沿
  与重复的 facts 完成各自持有独立的投递身份（eventKey）⇒ 键不同，因此不被其吞掉。**为何不做跨批
  围栏存活、计数式启发为何被否决**：见 §3.2.8；当前以有界重复接受，跨批时序/吞栏判定由
  上述 KNOWN-BOUNDARY 用例钉住。
- ⑦ **facts 输入缺席（纯壳批）不触发复位补偿（F30 登记，开放边界）**：触发链——来源
  已有可用 facts 批（`factsSeeded=true`）→ 某批 facts 输入**缺席**（`input.facts ===
  undefined`，与 §3.2.4 的显式不可用不同）→ 壳轨在该批 emit 无水位 complete 并置栏
  （`shellCompleteSinceFacts=true`，但没有可复位的「不可用窗口」）→ 随后恢复的第一个
  可用 facts 批因 `factsSeeded` 仍为真而是**非播种批**，不登记 `fenceSeed`/`seededSince`
  → facts 侧同一完成的水位严格高于栏 boundary，围栏 rule ③ 放行 ⇒ 同一物理完成双发
  （壳 1 条 + facts 1 条，TOTAL=2；两条 claim 键各带自己的投递身份 eventKey，
  主进程 5s 去重不吞）。与 ⑥ 的差别：⑥ 的栏被跨批 running 清掉，本项的栏还在，
  只是恢复批无从补种。**建议修法**（当前按 spec 边界未实施）：把「facts 缺席 → 可用」
  并入非可用窗口，触发 per-session 再次播种补偿（恢复批按 `shellNotifiedSinceFacts` 对
  确实通知过的会话登记 `fenceSeed`）；影响面 = 该窗口内恰发生一次壳轨通知的来源会话，
  每条重复一条横幅（会话事实与蓝点不受影响）。

#### 3.2.8 Rejected alternatives（完成身份与跨批围栏）

1. **跨批围栏存活**（让 `settleFence` 跨过中间的 running 批，等 facts 恢复后再裁决）：
   被否决。`boundary` 只有水位、没有完成身份——facts 恢复若直接报出严格更高的水位，
   这恰是「被守卫的完成从未在 facts 侧出现、这是一个真实新完成」，同一栏会把它吞掉
   （丢发）。
2. **计数式启发**（按「被守卫的完成必然后到」保留围栏 N 次、或等到下一个候选）：同样会
   误吞真实新完成，且把丢发概率换成可调猜测参数；不得为消例引入。
3. **本地伪造完成身份**（按水位区间/会话时间窗给围栏补一个本地身份，避开上游依赖）：
   被否决——本地输入只有水位，任何身份都是猜测，重复与丢发只会在两种误判间搬家；正确
   出口是上游只读「完成身份」面，在其落地前接受有界重复（§3.2.7 ⑥ 用例钉住时序与吞栏
   边界）。

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
  watermark?: number          // 内容水位（host 域），complete=completedAt，ask/request=updatedAt；只作内容记账，不进去重身份
  eventKey?: string           // 投递身份（renderer 待投递账本条目键）；complete/ask/request 必填（IPC 校验强制），仅 'test' 可缺省
}
```

- **身份与去重键**：主进程 claim 键 = **五元组** `[sourceId, sourceFingerprint,
  sessionId, kind, eventKey]`（`packages/desktop/notifications.ts` 的 `notificationDeliveryKey`
  与 `NotificationClaimWindow.claim`；`eventKey` 是 renderer 待投递账本条目的稳定身份，重试间不变：
  同一次完成经壳通道与 facts 源两个入口到达时由同一 outbox 身份派生出同一 `eventKey`
  ⇒ 合并成一条横幅，新一轮完成是新身份 ⇒ 不得被吞）——`kind` 与 `sourceFingerprint`
  必须保留，否则同一会话的 ask/complete 互吞、或 same-id 换宿主继承旧 claim；
  `'test'` 无身份、不走 claim（每次点击都是新请求）。镜像定义见
  `packages/renderer/src/global.d.ts`。
- `requireHidden = (sourceId === activeViewRef.current && sessionId === report.current
  && document.hasFocus())`——用户正看着这个会话（无论主开关/模式都豁免，与 OpenChamber `requireHidden && isAnyWindowFocused()` 同语义；单窗口下
  `document.hasFocus()` 与主进程 `isAnyWindowFocused()` 等价，主进程再查一次作权威）。
- 文案（v1 固定，renderer 组装）——**不再用
  zh 字面量**，改取 App 框架的 typed 字典 `packages/renderer/src/locales.ts`（该 effect
  依赖为 `[]`、拿不到 render 作用域的 `t`，故按**文档语言** `<html lang>` 用
  `readDocumentLocale()` 解析）：
  - complete：「会话已完成」/ `{来源 label} · {会话标题}`（`notification.sessionComplete`）
  - ask：「代理正在等待你的回答」/ `{来源 label} · {会话标题}`（`notification.awaitingAnswer`）
  - request：「代理请求你的批准」/ `{来源 label} · {会话标题}`（`notification.awaitingApproval`）
  - 会话标题查 `aggregates[sourceId]`（无标题/空白会话回落「未命名会话」，
    即 `session.untitled`）。
- 发送：`window.dshChamber?.notifications?.notify(payload)`；桥未就绪记为可重试失败，
  待投递账本保留事件并退避重试（§6）。
- `sourceFingerprint` 来自生产该份 runtime facts 的 ctx：local 固定 `local`，远程是主
  进程随 roster 投影的 64 位小写十六进制 opaque proof；App 只接受 proof 与当前权威来源代
  相等的 report，renderer 不从 registry 字段推导 proof。

**主进程**（`packages/desktop/main.ts` + 新增 `packages/desktop/notifications.ts`
纯逻辑模块，electron-free 便于单测）：

- 新 IPC：`dsh-chamber:notify`（`trustedIpc` invoke，payload 白名单校验
  sourceId/sourceFingerprint/sessionId/kind/title/body/requireHidden + 可选
  watermark/eventKey（complete/ask/request 的 `eventKey` 必填）+ 长度上限；
  sourceId 只接受精确 `local`、规范 `dsh-<raw-id>` / `gateway-<raw-id>` 及迁移兼容
  legacy `ssh-<raw-id>`，raw id 必须匹配 `INSTANCE_ID_PATTERN`，显式拒绝保留字
  `local`、空值、非法字符、超过 64 位；proof 还必须与主进程当前来源代精确匹配）；
- 主进程以两组**仅保留 active roster** 的 Map 管理远程 proof 与 ownership token：
  删除即删项；renderer 来源身份（kind/host/user/sshPort/remotePort）编辑轮换
  proof/generation，同 id 重建也不复用旧 proof；`transport`、`serviceName`、
  `remoteDshHome` 可触发各自 live/exec generation teardown，但不单独退役 N-ctx
  来源 proof（05 §4/§7.6）；历史 id 不留 tombstone，内存上界随当前远程实例数而非
  历史 churn 增长；
- `maybeShowNativeNotification(payload)` 裁决链（设置权威在主进程内存，随
  `dsh-chamber:settings-changed` 更新）：
  1. `kind === 'test'` 跳过设置门禁（设置页「发送测试通知」按钮）；
  2. `notifications.enabled === false` → 跳过；kind 对应事件开关关 → 跳过；
  3. `requireHidden && isAnyWindowFocused()` → 跳过；
  4. `mode === 'hidden-only' && isAnyWindowFocused()` → 跳过（`always` 放行）；
  5. `Notification.isSupported()` → 否则跳过（记日志）；
  6. **去重 claim**：key = 五元组
     `JSON.stringify([sourceId, sourceFingerprint, sessionId, kind, eventKey ?? null])`
     （与本节「身份与去重键」同形；同一次完成的两个入口共用一个 `eventKey` ⇒ 合并，
     同键重放才被吞；新一轮完成是新 `eventKey` ⇒ 仍各自发一条），5s TTL、64 条硬上限，
     Map + 时间序列只清理过期前缀（防同一事件双路径/重放双发，claim 在裁决之后；
     'test' 不走 claim）；
  7. **全局呈现预算**：所有实际呈现尝试（**含 `test`**）共享 5s/8 次滑窗硬上限
     （1.6 次/秒，容纳多来源同时完成但不允许 banner 风暴）；
     `BoundedActiveNotifications`（`activeNotifications`）把跨多个速率窗口仍不 close 的
     存活通知对象硬上界在 16 条。上界约束「存活引用/OS 监听器」数量而非投递配额：
     **满员时不拒发**——macOS 横幅进通知中心后不触发 Electron close（通常只有用户手动
     清除才触发），满员 fail-closed 会让 16 条存量横幅永久卡死通知流（第 16 条后设置页「发送测试通知」与事件通知全部返回 false，OS 无任何请求记录）。故
     满员按插入序 loud 淘汰最旧一条（close 退役）并继续登记——硬上界不变，仅最旧条目
     click 失效。该宿主预算不读取 session roster（控制面/主进程仍不成为 session consumer）；
  8. `new Notification({title, body, silent: false, sound: 'Glass'(darwin)})`，
     `BoundedActiveNotifications` Map 持有 notification → 来源 token（既防 GC
     吞 click，又允许按退役来源关闭旧 banner）；IPC 只在原生 `show` 事件后回报
     `{shown:true, outcome:'shown'}`，异步 `failed`、同步 throw、show 前 close 或
     5s 超时则释放 claim 并回报 `shown:false` + `retryable`/`permanent`
     （`failureClass`，缺省 retryable；不推进已通知水位，交由待投递账本重试），
     绝不把“调用了 void show()”冒充“已显示”；
  9. click → 先复验创建 banner 时捕获的 ownership token，再聚焦/显示窗口（macOS 先
     `app.focus`，同设计 14 恢复路径；退出在途 `quitRequested` 则终止恢复/重建；'test'
     通知只聚焦不打开会话）+ 推送 `dsh-chamber:notification-open`
     `{sourceId, sourceFingerprint, sessionId, deliveryId, attempt}`。来源删除或身份编辑
     同步 close 旧 banner 并丢弃该来源全部 pending/in-flight open；旧 click closure 迟到也
     不能打开 replacement。

**点击打开会话**（renderer）：App 订阅 `window.dshChamber.notifications.onOpen` →
`openSession(sourceId, sessionId)`（既有路径：挂载视图 → `ensureRemoteConnected` →
`openInstanceSession`）。**窗口重建竞态**：主进程对 notification-open 用 64 条硬上限
FIFO + reentrancy guard——renderer 注册监听后 invoke `dsh-chamber:notifications-ready`
置位（`did-start-loading`/`render-process-gone` 重置），就绪后才放行。一次 drain 只提交
成功发送的前缀；每条 push 携带稳定 `deliveryId`、逐次递增 `attempt` 与来源 proof；
`webContents.send` 返回只把记录移入 in-flight，**不算消费成功**。renderer 在完整 payload
已执行/入有界 roster 队列后调 trusted `notification-open-ack(deliveryId,attempt)`；仅精确
当前 attempt 释放容量。reload/crash/start-loading/closed 把全部未 ACK 前缀按 FIFO 放回
队首，旧 document 的迟到 ACK 因 attempt 不匹配而无效；同步 send throw 只 rollback 当前项，
早先已发送项继续等各自 ACK。pending+in-flight 总计 64；满时 loud 淘汰最旧 pending，全为
in-flight 则 loud 拒绝新点击。

主进程 replay 之后还有 renderer 的**权威 roster + proof 二级门**：`local` 立即打开；规范
`dsh-<id>` / `gateway-<id>`（及 legacy `ssh-<id>`）远程来源在当前 generation 首次
`instances_get` 成功前，以完整 `{sourceId,sourceFingerprint,sessionId,deliveryId,attempt}`
的 64 条有界 FIFO hold，roster settle 后按序 replay，目标缺失或 proof 过期才逐项 loud 丢弃
并 ACK；串行 runner 捕获精确来源 token，旧代排队项不能在 same-id replacement 上执行。与
深链的单槽 last-intent-wins 不同，这里每一次点击都必须保留。`deliveryId` 是 ACK/重放坐标，
不建立 renderer 持久去重账本；精确 `attempt` 防止旧 document 的 ACK 误提交新发送。

**preload / 类型**（`preload.cts` + `renderer/src/global.d.ts`）：

```ts
// window.dshChamber.notifications
interface NotificationSurface {
  notify(payload: NotificationRequest): Promise<{ shown: boolean; outcome: 'shown' | 'suppressed' | 'retryable' | 'permanent'; error?: string }>
                                                                  // invoke 'dsh-chamber:notify'；未显示时 error 说明原因（裁决抑制 / 宿主或 OS 拒绝原文）
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
  // …既有 chamber 级键不变（设计 14/16/18 的设置段）
  notifications: {
    enabled: boolean          // 主开关；默认 false（低打扰，用户显式开启）
    mode: 'hidden-only' | 'always'  // 默认 hidden-only
    onComplete: boolean       // 默认 true
    onAsk: boolean            // 默认 true
    onRequest: boolean        // 默认 true
    badgeEnabled: boolean     // 未读徽标（§3.7）；默认 true
  }
}
```

- `normalizeSettings` / `validatePatch` / `SETTINGS_KEYS` 扩展（嵌套对象校验、未知键
  拒绝；`test/local-state/chamber-settings.test.ts` 补用例）；主进程在
  `dsh-chamber:notify` 裁决时读内存设置（同一次 settings-set 即生效）。
- `notifications.onComplete` 是**全部 complete 类通知**（含目标标题
  `goal-completed/goal-blocked/goal-stopped`）的总开关；目标标题不新增事件开关（§3.2.5）。

**设置 UI**（`packages/dsh-chamber-client-ui-settings-bridge`）：

- 决策（实现以此为准）：**并入 `__general`（客户端 / Desktop 页；
  由「通用」改名，见 design 15 §D1）**，新增
  「通知」控制组（不新增设置壳固定入口——设计 15 平铺形态的入口数保持
  2 个不变）；客户端页各控制组之间用**分割线**（`.generalGroup + …` hairline，
  `--dsw-alias-border-l2`）分隔，通知组插在「运行/会话待办区」与「更新」之间。
  备选（未采纳）：独立 `__notifications` 固定入口。
- 通知组内容（settings-panel 设计语言 + `settings-store` 复用）：
  - 控制组「通知」：主开关行 + 未读徽标开关行（§3.7）；
  - 「通知时机」：模式单选（仅窗口隐藏时 / 始终）+ 事件开关 ×3（完成 / 提问 /
    审批请求）；「始终」下注明「正在查看的会话除外」；
  - 「发送测试通知」按钮（调 `notifications.notify({sourceId:'local',
    sourceFingerprint:'local', kind:'test', …})`，主进程
    绕过门禁直接显示；'test' 豁免空 sessionId 白名单，click 不触发打开会话）；
  - i18n zh/en（`locales.ts` 扩展；配对由 `typecheck:settings-bridge` 的
    `Record<keyof typeof zh, string>` 编译期强制）。
- **展示层契约**：主开关是无边框披露行（`.generalSwitchRow`），启用后展开的子设置
  （通知时机 / 事件开关 ×3 / 测试按钮）整体收入唯一一张卡片（`.generalNotifyCard`），
  内部行不再自带边框（`.generalLinePlain` / `.generalEventRow`）——通知组只保留一层
  边框；开关关闭时子设置整体收起。

### 3.5 覆盖边界与诚实性

- **仅已挂载来源**可检测 ask/request（实时 mux 事实只在 ctx 内存在）；未挂载且未预热
  的远程来源（预热槽 ≤3 + 用户打开过的 N-ctx 常驻之外）v1 不产生通知——文档化限制，
  后续可选「unary 完成检测」（30s 延迟、无 pending 信息）扩展。
- **goal 活性事实的覆盖边界（2026-12）**：压制与目标标题需要 goal 事实，通路按来源形态
  分三档——
  - **P1（有挂载壳的来源）**：插件从会话投影 `projectionValues.goal` 读三值，零新增
    wire；被 retention/收割回收的源在 P1 下没有 goal 事实（无壳即无投影）⇒ P2a/P2b。
  - **P2a（gateway 来源）**：只读 `/chamber/session-state` 镜像——`session/list` 投影的
    `projections.values.goal` 白名单（goalId/revision/phase/updatedAt；加上进程内
    activation）+ `$events` 的 `goal/activation-changed`；能力
    `session-state.goal` **可选**（旧端缺它 = 现状，不降级）。隐私白名单在 gateway 解析
    处丢弃 objective/blockedReason（design 17 §10.7）。
  - **P2b（SSH/dsh 来源）**：`source-mux-facts.ts` 讲**实例自己的**远程协议
    （`session/list` 投影 + `$events` + 每边沿一次 `session/follow`），
    **不消费 gateway 镜像**；两条事实源在 renderer 侧汇成同一份 `SessionFactsSnapshot`。
    其 `goalActivations` 保留边与 P1/P2a 同纪律：绑定 id 与基线不符**保留待匹配、不直接
    drop**（由后续 baseline/added 携带匹配 identity 时消费），no-goal 事件只把**已知对象**
    goal 即时清成 null——不缓存、不落到 unknown 行、不新建行。
  - **浏览器/mobile（gateway web 直连）**只服务 mobile 插件，无 chamber sidebar/renderer
    ⇒ 不存在 goal 压制/通知面；而 **chamber renderer 被浏览器/dev 直开**是另一形态：
    渲染器与 durable 剪枝门都在（无桥按 §3.2.4 F11 视同已结算放行），只是没有远程来源、
    压制面为空。两者分述，不得合并成「浏览器一律没有渲染器」。
  - 行缺席的 offline-unread 分支无行事实即无 goal 相位，不压制；`schedule`/job/队列
    followup 本期不覆盖（收敛器输入可后续扩展）。activation unknown 的静默窗口（§3.2.2）
    是文档化取舍。**facts-only 源忽略 `subagentCount`**（在场子会话数不是 busy 证据，
    对 06 §4.5 的有意修正，见 §3.2.3 G4）。通知账本的
    `held/flushed/voided/dropped/deferred` 与 `origin` 是独立计数，不替代主进程
    `sent/suppressed/skipped` 回执账本（§3.2.5）。
- **facts 通道可用性语义（2xx unversioned / 404 legacy 二分）**：2xx 但无 `protocol`（解析失败 /
  非协议载荷）⇒ 通道**不可用（unknown）**，绝不是「权威空行集」：既有行原样保留（无既往行
  才给空行），快照标 `verdict='degraded'`、`degradation='unversioned'`、
  `serviceable=false`、`stale=true`。消费侧按 §3.2.4 的在场集纪律仍用**原始行键**判在场、
  按 `factsUsable=false` 停判——否则无壳来源的会话会被整体遗忘。404 是**版本事实**
  （网关没有该镜像路由），按本代是否曾探到协议载荷（`session-facts-source.ts` 的
  `protocolFactsSeen`：ok 或带协议载荷的降级档投递过即置位，来源指纹换代清零）二分：
  - **首探 404（从未探到协议载荷）**：给 `rows` 空、`cursor` 0、`stale=false`、
    `serviceable=false`、`mode=null` 的空快照 + `verdict/degradation='legacy-gateway'`——
    这是**权威空行集**（该网关确实没有镜像协议）；侧栏 `session-facts-mode` 的 `legacy` 档位
    由它可达，且仍走有界低频重探（网关可能升级）。
  - **ok→404（曾探到协议载荷后转 404）**：网关回滚/路由拆除，行集不再**权威**，但行本身仍是
    无壳来源唯一的在场证据——**保留**既有行/游标/read，只把 `verdict/degradation` 仍标
    `legacy-gateway`、`serviceable=false`、`stale=true`（不可用但**不触发遗忘**、held pending
    不被清）；持续 404 的重探不得清掉这些行，行与水位也绝不推进。消费侧按 §3.2.4 的在场集
    纪律仍用**原始行键**判在场；**404→ok 恢复**时由新的协议快照重新成为权威行集（自愈）。
  **恢复纪律**：2xx unversioned 不是永久不可用——三条出口
  （首探空快照 / 已表达同事实 / 保留既有行）都在置快照后排一次有界重探
  （`scheduleProbe(reconnectMs)`），与 404 legacy、5xx/网络失败同一纪律
  （`scheduleProbe` 自带幂等 guard）；否则一次坏载荷就让 facts 永久停在 unknown，
  只有 connected false→true 或来源指纹变化才解围。**恢复批重播种（B3-2/COR-1，F30 精度）**：
  复位谓词 = 本批**显式携带** facts 输入、`usable=false`（stale/degraded/serviceable=false）
  **且来源级易失旗标 `shellCompleteSinceFacts` 为真**（「自上次可用 facts 批以来壳轨确实
  emit 过无水位 complete」，由 `applyObservationBatch` 依 reconcile 结果/置栏判定；任何
  **可用** facts 批清位）。复位时只有确实复位了已播种状态（`factsSeeded` 本为真）才挂
  `factsReseedPending`，恢复后的首个可用批才对 per-session `shellNotifiedSinceFacts` 为真的
  会话重新播种（吸收水位、不产候选）；其余 facts-only 会话照常按水位严格前进通知（否则永久
  丢发），从未播种来源的恢复批仍按 G2 对全体会话播种。无壳轨/壳轨在场但从未通知的形态不再
  触发复位（COR-1 收窄），详见 §3.2.3 G5。
  **已闭合契约（2026-12 F24）**：此前登记的「运行中由 `ok` 转 404 时旧行随空行集消失」
  不再是开放项——`buildEmptySnapshot` 只在**首探 404** 出口使用；曾探到协议载荷后的 404
  一律走「保留既有行 + 标不可用」出口（上二分），无壳来源不被整体遗忘、held pending 不被清，
  404→ok 恢复为权威行集。**被否决的替代**：404 一律清成空权威集——它把无壳来源唯一的在场
  证据清成「会话消失」（触发遗忘结算、清 held pending），而「路由不存在」只证明镜像协议
  不权威，不能证明会话不存在。
- **可判性唯一谓词（渲染 vs 判定两支）**：一份 facts 快照的可判性由 `session-facts-source.ts`
  拥有，**不得**被任何消费点重写：
  - `isFactsUsable(snapshot) = verdict==='ok' && serviceable!==false`——**渲染**面（侧栏
    overlay）用；stale 仍可渲染只读事实并明确标注（`mergeRuntimeFacts` 的 stale OR）。
  - `isFactsDecisionUsable(snapshot) = verdict==='ok' && serviceable!==false && !stale`——
    **判定**面（未读账本、读水位推进、完成观测的 `factsChannelOf(...).usable`）用；stale
    快照的行不得当证据。
  未读接线的 `facts` 行键与 `factsVerified` 必须**同源同拍**，取自同一函数
  `factsDecisionInput(snapshot)`（`session-facts-source.ts` 拥有，返回 `{ rows, verified }`）：
  `{undefined, true}`（快照缺席）/ `{rows, true}`（可判）/ `{undefined, false}`（在场但不可判）。
  **快照缺席**（断连/未观察）
  ⇒ channel-only 照常派生；**快照在场但不可判** ⇒ 走 `deriveSourceUnread` 的规则 0
  （`prevLedger` 原样保留，不剪枝、不 clobber）——「冻结的未知」。
  **冻结窗口的读水位纪律（fail-closed，明确接受）**：判定不可用时，`factsDecisionInput` 不返回
  行，`markSourceAllRead` 与「正在阅读」两处读水位推进都拿不到输入 ⇒ **不推进**。后果：断连期间
  点开会话不会立刻清掉它的未读。载体恢复后，首个可判批会对**仍被查看**的会话照常推进并清点，
  已切走的会话在再次打开时清。代价是断连窗口的未读多挂一会儿；收益是**绝不**用载体已断的行推进
  只升不降的 durable 水位（那正是旧的恒真 gate 干的事）。来源退役时账本按既有 durable
  剪枝/遗忘路径移除，不留永久残留。
  **缺陷史（2026-12）**：该接线曾写成 `factsVerified: usableFacts!==undefined ?
  usableFacts.serviceable!==false : true`——两支恒真，规则 0 在生产是死代码；于是不可判窗口
  改用通道-only 重算，已武装的完成点被 `listComplete` 唯一剪枝门删掉、载体恢复时又武装，
  Dock 徽标与行点随每次载体抖动闪一次。**被否决的替代**：①继续按通道重算（现状缺陷）；
  ②把 stale 排除在判定面之外（只能渲染）——载体已断的行仍被当证据，旧完成被反复判未读（假亮）。
  **载体终结纪律**：观察者退役（`stop()`/指纹换代/来源拆除）必须让 store 里**不再存在**
  可判快照——要么发布一份「保留最后一批行 + `degraded/unavailable/stale:true`」的退役快照
  （无壳观察者 `source-mux-facts.ts` 的 `stop()`），要么清掉该来源的快照（gateway 生命周期
  teardown 的 `factsStore.dropSession`）。否则最后一份 readable 快照会被判定面继续当证据：
  `emit()` 在 `stopped` 后拦下所有后续刷新，死载体的行就永久「可判」了（round-2 红队坐实的
  半死载体竞态）。退役快照只在 `ready()` 时发（其余时刻 store 里本就是 degraded，不发噪音）。
  接线锁 `test/wiring/session-authority-wiring.test.ts` 钉住「不得再出现第二个可用性表达式」。
- **`factAt` 是渲染字段，必须骑运行时上报签名**：`runtimeReportSignature` 是 App 提交运行时
  事实前的去重键，漏签一个渲染字段即该字段单独变化被整个丢弃（行的 `data-chamber-fact-at`
  证据锚冻结在首见值）。`factAt` 编码为稀疏（0/缺席同为空串，不制造 churn），两条签名路径
  （身份与投影）都签。**被否决的替代**：①不签 `factAt`、把证据锚改成不渲染的诊断字段——
  代价是失去「这一行事实有多新」的机内取证面，而它正是 06 §4.3 行状态的排障入口；
  ②把 `factAt` 量化成粗粒度桶（如秒级）再签——省下的重发布（网关轮询 ≤1 次/30s，无壳
  观察者只随真实状态边沿，见 `source-mux-facts.ts` 的 `handleStatus`）远小于「锚点被吞」的
  代价，且引入第二个时间语义，不值得。
- **断连/重连：撤回即播种，窗口内完成/提问不补发**（设计取舍，与实现一致）：通道撤回
  （shell 重连/重 boot，来源移除的 clear 由 liveServerIds/指纹检查挡在前面）时，`App.tsx`
  的 report 撤回分支删除该来源的 `runtimeFactsRef`/`prevRunningRef`/观测状态
  （`completionObservationRef`），并 `completeLedger.withdraw(sourceId)`（清 armed +
  armedFloor + pending + settleFence，`notified/outcomes` 保持 durable，§3.2.4）后重算蓝点；
  恢复后首份上报按代际
  重新播种（`shellSeeded/factsSeeded` 尚未置位、G2 基线）→ 只播种、不发通知事件。理由：
  wire 只有 `running` 位，无法区分「窗口内完成」与「窗口内被手动停止」，保留
  记忆会把后者误报成完成；窗口只持续到重连完成，窗口内状态在 UI（Rows / pending 徽标）
  照常可见，通知不补发即不撒谎。同内容重放仍不重复（边沿记忆 + 主进程 claim）。
- 窗口内提醒仍由侧边栏蓝点/pending 徽标承担；通知只在窗口不可见（hidden-only 默认）或
  显式 always 时打扰。
- **被裁决跳过的完成不补发**（设计取舍）：hidden-only + 窗口聚焦时主进程跳过
  （focused-hidden-only），而 renderer 的 complete 去重记忆在边沿通过时已记账，窗口稍后
  隐藏不会重新触发——与「仅窗口隐藏时打扰」语义一致，侧边栏蓝点仍覆盖。
- **子代理运行期不视为完成**：父会话回合结束但 `runningSubagents > 0` 时抑制
  complete 通知（与官方 Rows / 侧边栏优先级一致；抑制在去重之前、不记账）。补发语义依赖
  **账本武装 `completed` 的时序**（账本在 running→idle 边沿武装，与子代理存活无关），均为文档化行为：边沿 **晚到**（子代理全部结束后父会话才回到 idle）→ completed 边沿届时正常补发横幅；边沿 **早到**（父会话先 idle、子代理仍在跑，
  期间 completed 已为 true）→ 滤除的边沿不记账、子代理结束后无新 completed 边沿，该完成不再有
  横幅补发（窗口内完成点与未读徽标不受影响）。未读徽标（§3.7）应用同一压制——蓝点账本保持武装（与官方「completed 保持武装、subagents 分支优先呈现」同构），徽标投影同一并集（App 账本武装 ∪ 合并事实行的 `completed`——同一个来源，通道永不携带，见 §2；且未被运行环压制；收口为单一权威——此前「点/待办有、徽标无」的分工已消除）；呈现边界见
  §3.7 计数语义。
- 通知失败（isSupported false / 系统权限拒绝）按永久或可重试结果保留在待投递账本，
  不推进已通知水位；会话业务不受影响，蓝点照常。
- notification-open 的可靠投递（`send()` 返回不等于消费成功、未 ACK replay、deliveryId/
  attempt ACK 坐标、FIFO、proof 隔离 same-id replacement）见 §3.3。
- renderer 来源 ownership/producer 账本同样只保留 active Map 项，退役即删除；单调 serial
  只生成 token，不按历史 sourceId 留 tombstone；权威 delta 到达时
  `retireInstanceProducers` 同步撤销 runtime/snapshot token 与缓存，再异步 dispose shell。

### 3.6 安全与纪律

- IPC 沿用 `trustedIpc` 全部门禁（sender = 主窗口 mainFrame + 控制面 origin）；
  payload 白名单 + 长度上限（防异常 title/body 刷屏）。
- 载荷全为非秘密投影（会话 id/标题/来源 label + 主进程签发的 opaque 生命周期
  proof——侧边栏同源数据，无隧道 URL、无 SSH 材料）；proof 不持久化，也不含可逆
  host/user/port 信息。
- 纪律见 §3.1。

### 3.7 未读徽标：Dock/任务栏应用图标红气泡

OpenChamber 参考实现：`packages/electron/main.mjs` 的 `desktop_tray_update` 分支读
`args.dockBadgeCount` → `app.setBadgeCount(Math.max(0, Math.floor(count)))`（0 = 清除），
计数由 `packages/ui/src/hooks/useTraySync.ts` 算——**有未读活动的会话数**（`unseenCount > 0`，
`dockBadgeEnabled` 控制）。dsh-chamber 移植要点：

```
completedBySource（App 完成未读蓝点集，06 §4.1，只读复用——徽标与窗口内蓝点
同源同规则，并同样应用子代理运行环压制（06 §4.5）与 goal 呈现门（§3.2.5）；对 App 账本驱动的完成
两面永不分叉；合并事实行的 `completed` 与账本是同一来源（通道永不携带），故并集 `ledger || row.completed` 只是注入后的读取形态，断连窗口的呈现边界见「计数语义」）
  → projectBadgeCount(completedBySource, runtimeFacts)（renderer 纯函数，跨来源
    求「用户实际可见」的未读会话数——最新事实行 runningSubagents > 0（后台子
    代理存活）的武装蓝点不计入；0 = 清除）
  → window.dshChamber.badge.set(count)                 ← 新 IPC（invoke）
  → 主进程：白名单校验 → 记录意图 → 设置裁决（badgeEnabled 关 → 强制 0）
    → 平台门（app.setBadgeCount：darwin/linux；win32 overlay 门控）→ 呈现
```

- **计数语义**：一个未读会话 = 1（同 OpenChamber「chats with unseen activity」，非通知条数）；
  pending（ask/request）不计数（窗口内提醒仍由侧边栏 pending 徽标承担）。
- **呈现边界（既有窗口，徽标投影同一并集）**：窗口内完成点 = App 账本经
  `mergeRuntimeFacts` 注入行后的 `completed`，徽标投影**同一读取形态**——`badge-count.ts` 的
  `armed = ledger || row.completed`（`projectBadgeCount`）——账本武装而窗口内行尚未出现的会话
  （首观察/撤回窗口内完成、从未被 App 观察到 running→idle 边沿）同样计入，不再是「窗口内
  有点而徽标恒为 0」；断连（来源 not-ready）清空运行时事实而蓝点账本跨断连保留（06 §4.2），
  徽标按保留账本计数、窗口内该来源无行可显示——这是既有取舍的诚实边界，非分叉缺陷
  （并集收口见 §3.5）。
- **子代理压制（同窗口内蓝点语义，§3.2/§3.5）**：父会话回合结束但后台子代理仍存活
  （`runningSubagents > 0`，06 §4.5 后台模式）时，该会话已武装的完成蓝点**不计入徽标**
  ——徽标投影必须与窗口内蓝点一致，否则「主分支闲置等子代理」期间 Dock 误亮红气泡。
  badge effect 同时依赖 `completedBySource` 与 `runtimeFacts`，压制取来源最新事实行，
  子代理计数归零即重推；父会话重新运行（蓝点解除）自然归零。**断连窗口**：来源 not-ready
  即清运行时事实（压制数据随 generation 事实失效，06 §4.2）而蓝点账本保留——断连期间已
  武装蓝点短暂计入；重连后事实行带回 `runningSubagents > 0` 自动回到 0，自愈窗口，接受。
- **goal 压制（同窗口内蓝点语义，§3.2.5）**：会话 goal 相位为 `active`（**含 activation
  unknown**）时，该会话已武装的完成蓝点不在窗口内呈现，徽标同样**不计入**——否则 Dock 会为
  一个用户看不到的完成点亮红气泡。`use-badge-count` 用 sidebar 零依赖叶谓词
  `goalSuppressesPresentation(row.goal)` 预计算 `goalActive` 布尔（`badge-count.ts`
  保持零 import），输入是**合并后** runtime（通道 ∪ 蓝点 ∪ facts overlay ∪ stale），与
  `sessionRowState` 同拍（INV7）；断连来源上残留的 `subagentActivity` 照旧降
  unknown 不压制。
- **主进程裁决与状态**：`pendingBadgeCount`（最近一次 renderer 意图）+ 设置权威裁决——
  `badgeEnabled` 关闭即强制清零，重开经 `reconcileBadgeCount` 恢复当前未读数（settings-set
  后即时收敛，不等下一次推送）；quit 在途兜底清零。renderer 始终推真实计数，开关裁决在
  主进程（与横幅同纪律）。
- **平台门**（`badgePlatformGate`，诚实不假装）：darwin = Dock 红气泡；linux = Unity launcher
  DBus API（GNOME Dash to Dock 等消费同一 API 的扩展同样可见；无消费方时无可见效果——
  文档化平台限制，返回 true 表示已提交给 OS API 而非可见性保证）；win32 = v1 门控跳过 + loud
  记一次日志（`setOverlayIcon` 数字角标图属设计 23 排期；平台判定先于 API 可用性判定，win32
  上 setBadgeCount 恒为 undefined，专属原因不被泛化吞掉）。
- **设置**：`notifications.badgeEnabled`（默认 **true**——被动指示，镜像蓝点「始终开启」与
  OpenChamber 默认；与横幅主开关 `enabled` 独立）。设置 UI 在客户端页「通知」组加一条始终
  可见的无边框开关行（主开关下方、子设置卡上方），不增加边框层数；zh/en i18n。
- **renderer 推送**：`[completedBySource, runtimeFacts]` effect 每次变化推当前计数（蓝点
  武装/阅读解除/来源退役/子代理计数归零自然驱动；通道-only 变化重推同值——主进程
  setBadgeCount 幂等）；挂载推 0 兜底（窗口重载后蓝点复位为 {}，主进程遗留徽标必须清除）+
  桥迟到有界重试（复用 `LISTENER_READY_RETRY_*` 预算）。桥缺失（web/dev）静默跳过。
- **校验**：`{ count }` 必须为有限数（结构化克隆可携带 NaN/Infinity，显式拒绝）、非负、
  ≤ 9999（超上限响亮拒绝不静默截断）；小数 `Math.floor` 归一（OpenChamber 同款容忍）。返回
  boolean = 是否实际应用；渲染端静默容忍 false（主进程已 loud 记平台/失败原因，重复推送不刷屏）。
- **纪律**：同 §3.1；计数是瞬时投影，绝不持久化。

---

## 4. 验证门与实机验收

- `test:desktop`：chamber-settings 新键 normalize/validate/corrupt 用例；notifications
  覆盖裁决链 enabled/kind/mode/requireHidden、claim/rate/active hard cap、honest
  show/failed/timeout/hostile error、严格 `local | dsh-<raw-id> | gateway-<raw-id>` 来源
  （`ssh-<raw-id>` 仅 legacy 输入别名，归一为 `dsh-<raw-id>`）、opaque proof
  校验与 same-id replacement、active-only Map churn、notification-open
  retain-until-ACK/FIFO/reload replay/旧 attempt 隔离；badge 校验/裁决/平台门用例。
- `test:renderer-shell`：`notification-projection` 单点裁决单测（两条证据、水位/武装两轨去重、首报播种、
  INV1/#7 hold 与水位吸收、#2/#4 flush 与一次性标题、#3/#10/#11 drop/fail-open（#3 可达
  origin 仅 `goal-none`/`goal-paused`/`goal-changed` 三个，旧 `goal-drop` 兜底已删）、
  #9 直接 outcome、#12 ask/request 直通、#13 G4 释放、G1–G5、settleFence/结算守卫（围栏
  边界含 `W == boundary` 必吞的 R5/B4-3 钉扎）
  （含 releaseDeferred 已被通知时的 settle-guard、boot=fresh 的 `forgetGoalKnown` 回归）、
  INV6 幂等、TL1/TL2 窗口）；
  `notification-edges` 纯函数单测（complete 边沿与 dedupe 去重、ask/request 值变化边沿
  （含直切）、首报播种、断连重连的重放不重复——注意**不是**「断连补发」，见 §3.5、同 tick
  去重）；`completion-observation` 观测组装单测（壳/facts 权威合并、候选归属、
  baseline 空首帧与 `baselineDone` 合并后 pageBoot 只到首批（D4）、facts-only
  subagentCount、C4-X3 stale 壳批不产 complete/ask/request 边沿（含 stale true→false
  不补发）、C4-X2 恢复播种批对无 observed 水位行两种形态（行非 observed / 被 I1 挡下）
  及行完全缺席也登记围栏（含无栏 no-op 对照、同批 `keepFence` 清栏豁免、跨批
  `KNOWN-BOUNDARY` 各一条 2 完成/3 条钉住）、I1 不吸收水位与候选可重提、
  代际门与批次落盘，含 `FORGOTTEN_SESSION_LIMIT + 1` 会话的 FIFO 越界用例）；
  `complete-ledger`（账本状态/围栏边界 + 撤回/卫生，含 B4-2 forgetSession/withdraw
  同步清 goalKnown）与 `unread-store`（v2 pending/outcomes 增量与清洗）用例；
  `badge-count` 投影用例（goal 与子代理压制、stale 守卫）；`frame-locale` 锁住
  三条 goal 标题 key 与 App 调用点；`session-authority-wiring` 锁住唯一 reconcile 接线；
  `unread-prune-roster-gate` 锁住 durable 剪枝门（degraded 与 rosterIncomplete 同档
  优先否决、无桥缺席视同已结算、健康探针不可用 fail-closed，F13/F16/A4/V5-A）；
  `session-facts-source` 的 legacy 404 二分用例：首探 404 空权威
  （`404 producer: the probe delivers an EMPTY legacy snapshot (not undefined) so mode legacy is reachable`：
  `rows` 空 / `cursor` 0 / `stale=false` / `serviceable=false`、`legacy` 档位可达）与
  ok→404 保留既有行/游标/read 并标不可用——持续 404 不清行、**同一用例内**再断言网关
  恢复协议载荷后新快照重新成为权威行集（404→ok 自愈），恢复不是独立用例
  （`404 after a good snapshot keeps the rows as presence evidence: unavailable legacy, never an authoritative empty set`）。
- `test:sidebar`：`projectRuntimeFacts` 的 subagent 行排除用例；`goal-facts`（三值
  解析/最后已知/activation 合并/身份签名）、`goal-activation`（事件制、有界重试、
  触发矩阵、绑定 id 与投影不符时保留待匹配——含「第三个 goalId 期间保留、投影回到匹配 id
  仍应用」的 F14 回归、B4-1 缓存上限 2000/LRU/warn-once/`evictedCount` 诊断回归、
  禁 `goals/get` 源文本锁）、`session-row-state`（两个门与压制后
  state）与 `todo-attention` 的 goal 压制用例。
- `test:control-plane`：`session-state-protocol` 的可选 capability（
  `session-state.goal` 绝不进 BASE/缺失不降级）与 `session-mux` 的 goal 白名单投影/
  activation 路由用例。`test:gateway`：`session-state` 的 goal 合并/持久化（activation
  剥除）、ready 边沿清空、旧端矩阵 fixture 的 additive 步与 features 宣告。
- `test:settings-bridge`：通知设置纯函数（模块 `notifications-settings.ts`；用例在
  `test/settings/settings-groups.test.ts`：缺省回落/partial patch/未知键过滤/默认值
  镜像）+ 通知失败原因映射（`test/settings/notify-test-result.test.ts`：成功不带原因、
  失败保留宿主/OS 原文、空串不制造假原因、reject 路径同样如实）+ 既有套件（入口解析
  不变——通知组不新增固定入口）。
- `verify:i18n` 无 DRIFTED（settings-bridge 命名空间配对由
  `typecheck:settings-bridge` 编译期强制）；`typecheck`；`build:renderer`；
  `dist:desktop:mac` 打包态通知冒烟。
- 最终 HEAD 的验证证据按 `CONTRIBUTING.md`/PR 模板给出；`docs/progress/STATUS.md`
  只记未完成与取舍，不记测试计数。

**实机验收（未完成）**：macOS 通知权限的打包态走查（拒绝态 → 设置页原因 +
「打开系统设置」→ 用户打开后重试成功这条闭环，代码面完成）；文案定稿、
打包态三形态（关窗/托盘/后台）+ 点击打开会话 + 窗口重建；徽标 macOS Dock 打包态
三态（武装/解除/退役 + 重载与退出清零）；Windows 任务栏 overlay 门控（design 23 排期）。

### 4.1 拒绝态的可见性与恢复入口（含被否决方案）

现象：macOS 通知权限一旦落到 denied，系统**不再允许 App 弹出授权框**
（`UNUserNotificationCenter.requestAuthorization` 只在 `.notDetermined` 弹），用户
看到「测试通知发送失败」，真正原因（未授权/调度失败/超时）只进 sidecar 日志——设置页
无从解释、无恢复入口。

契约（两个 flavor 共用，Swift 与 Electron 同一条 IPC 面）：

- `dsh-chamber:notify` 应答由 `boolean` 升级为 `{shown, outcome, error?}`：宿主/OS 原文
  （Swift 的 `swift-edge-notification-*` 码、Electron 的
  `describeNativeNotificationFailure` 文案）与裁决侧抑制原因（设置/焦点/去重/速率）都
  随应答返回；`error` 是**结果**而非拒绝（沿用 P-06 的 honest-show）。
- `dsh-chamber:open-notification-settings`（新 invoke，无载荷）：主进程用**固定常量**
  URL（`x-apple.systempreferences:com.apple.Notifications-Settings.extension`）
  打开「系统设置 → 通知」，非 darwin 诚实回 false。renderer 不能传 URL——不把
  `OPEN_RELEASE` 的白名单纪律扩成任意 URL 打开面。
- 设置页失败态展示：原因原文（不翻译）+ 权限提示 + 「打开系统设置」按钮；打开失败也
  loud 展示。

**Rejected alternatives**：

1. **只在 Swift 侧加日志/对话框**：Electron 侧同一失败面同样静默，会造出一条未登记的
   双端差异（deviations S 行），且原因已在 sidecar 算出、只在 IPC 边界被丢掉——修错层。
2. **把授权申请提前到启动/进设置页**：违反 design 25 S3·V1 的既定双端时机（首次真正
   投递才申请），且对已 denied 的账户零作用（macOS 不会二次弹框）。
3. **新增任意 URL 打开通道（复用一个通用 openUrl）**：把 release 页的严格白名单扩成
   通用打开面，安全面净增；固定常量 + 单用途通道是更小的能力面。
4. **denied 时回退成「应用内提示/响铃」**：超出 design 19 的投影边界（本设计不做通知
   中心/历史），且与 Electron 现状不等价；本设计只做「诚实 + 可恢复」。

## 5. 关联

- 设计 06 §4：运行时事实通道（检测事实源）。goal 行字段/三值解析/两个谓词/六面单源见
  06 §4.1–§4.5（本设计 §3.2.1/§3.2.5 与之同一契约）。
- 设计 17 §10.7：P2a goal 事实增量面（只读 `session/list` 投影 + `$events` activation、
  可选 `session-state.goal` capability、隐私白名单）；P2b 的 SSH/dsh 通路见本设计 §3.5。
- 设计 14：关窗/托盘/后台常驻——通知只在窗口不可见时打扰。
- 设计 15：settings 壳平铺入口形态（通知并入 `__general`，入口数不变）。
- 设计 16：`pendingIntents` 队列 + drain（notification-open 重建竞态复用）。
- 01 §4：通知中心为移出域；本设计仅桌面壳原生通知，控制面零改动。

## 6. 投递账本与回执

完成边沿先写入 renderer 的有界待投递账本，键包含来源化身、会话、类别与 host 水位；无水位的运行时边沿保留独立事件键，后到的可信 host 水位可补充该条记录。账本在重载后恢复；原生回执明确区分 `shown`、策略性 `suppressed`、`retryable` 与 `permanent`。只有前两类结算通知水位。暂时读不到 `turn/end` 的事实保持待分类，后续基线继续读尾；观察者时间只用于未读，不能伪装成 host 完成水位。主进程用稳定 `eventKey` 识别回执丢失后的重试；设置页 `test` 每次点击都是新请求，不进入已显示回执表。

账本另为每次 renderer→原生尝试签发单调回执票据；`eventKey` 在重试间保持稳定供原生防重，回执票据只准结算当前在途尝试。记录被撤销后即使同键重新入队，旧回执也不能删除或封锁新记录。过期回执不计入投递诊断与通知水位。

gateway 镜像与无壳观察者在**已观察到停止边沿**但读不到 `turn/end` 时只能报告 `reconstructed` 未读；只有后续读到可归属的新 `completed` 尾巴才升级到 `observed`，进入通知账本。若只知道最近用户提示水位前进，连运行和停止都没有观察到，就保留待分类且不凭该提示武装未读：它也可能只是排队的用户消息。提示水位前进时仍要撤销旧完成，避免 `max(updatedAt, completedAt)` 把旧完成伪装成新通知水位。

无壳观察者在已经知道本轮最近用户提示的 host 时间时，也不得把 `session/follow` 返回的上一轮尾巴归给本轮：`turn/end.time` 必须严格晚于该提示水位。等于水位、缺少 host 时间或读尾失败均保留待分类并由独立基线再次读尾；观察者的 `pendingClassifications` 仪表显示待分类数量。`session/list` 的 `running=false`、authority 的 `episodeEnded` 只能证明停止，不能在缺少可归属 `turn/end.reason` 时生成完成通知。

`session/list` 是 HTTP unary，`session/follow` 是同一 remote.mux 载波上的逻辑流：按独立 `streamId` 打开，只消费该流的 opening snapshot 与后续 event，读到 `turn/end` 即发 cancel；无尾巴的 snapshot 保持流至有界期限，载波替换和观察者停止也结算并取消在途流。把 follow 当作 HTTP unary 会使真实宿主拒绝读尾，完成永远只能降级为 reconstructed。`updatedAt` 来自最近用户消息的事件时间（空会话回退创建时间），与 `turn/end.time` 都是毫秒精度；两事件同毫秒无法仅凭时间比较区分先后，故保留待分类，不把等值尾巴用于通知。要消除该漏报边界，需要能关联用户消息和 turn/end 的序号或轮次键。

无壳观察者的可信全量 `session.list` 连续两次缺席同一会话，才将该行退役；一次缺席保留原行，但暂停其在途读尾分类，期间收到该会话的 status/added/activity 会重置缺席计数。退役与显式 `removed` 走同一清理路径，删除不生成完成边沿。观察者 `stop()` 清除行、运行轮次及待分类读尾；同一对象再次 `start()` 必须从新基线建立事实，旧生命周期的读尾不能写入新行。

待投递与事实水位按**同一次完成**匹配：旧水位的 `permanent` 记录留作失败证据，但不得压住同会话更高水位的新完成。运行时 armed 只代表边沿已经入队；无水位运行时边沿收到 `shown` / 策略性 `suppressed` 后，另记易失的已结算待归属位，后到的 host 水位才可据此播种已通知水位。观察到重新 running 即清除该位；单凭 armed 不得将新的 host 水位当成已投递。

原生系统显示与 renderer 落盘之间没有原子事务。宿主进程在显示后、回执记录前崩溃时，静态测试不能证明跨进程恰好一次；该窗口由打包态故障注入验收。

运行时边沿没有 host 运行轮次 ID。若旧运行时通知仍待投递，且新一轮运行的 true/false 两个状态都丢失，后到的 host 水位不能无歧义地归属旧或新完成。该混合证据窗口需端到端故障注入；要消除歧义须由宿主提供两通道共有的运行轮次键。

**Rejected alternatives**：提前推进通知水位会把投递失败变成永久漏报；把所有原生 `shown:false` 当策略压制会吞掉暂时性权限、速率和 IPC 故障；把重试仅交给 5 秒去重窗会在其到期后重复显示；把同会话任一 pending 或 armed 当作已通知，会让旧永久失败吞掉新一轮完成。仅用稳定 `eventKey` 归属异步回执会让已撤销记录的旧结果结算同键新记录，因此投递尝试另有票据。无壳基线首次缺席就删除会把短暂不完整列表误判为删除；永不按基线缺席收敛则让丢失 `removed` 帧的旧 running 行永久存在。连续两次完整缺席与网关镜像的删除判据一致。把 `running=false` 或 authority 的纠偏边沿升级成 complete 会将用户停止误报为完成；把 `session/follow` 的最近尾巴无条件归给当前运行会复用旧 `turn/end`，因此必须按 host 提示时间校验。
