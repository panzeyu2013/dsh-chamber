# 桌面事实接线蓝图（把 §3.3 六条落成可评审的编辑）

> 输入：`docs/progress/todo/remote-session-state-and-switch.md`（下称「主计划」）§3.3 / §4 / §6 / §7-W2。
> 定位：本文件只回答「改哪里、改成什么形状、怎么锁、怎么退」。不含排期与验收叙事。
> 行号基线：本工作树 HEAD 的工作区快照（`packages/renderer/src/App.tsx` 4519 行、
> `packages/dsh-chamber-client-ui-sidebar/src/shared/derive.ts` 1770 行、
> `packages/dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts` 911 行）。
> 所有引用逐行核对过；行号会随后续编辑漂移，接线锁一律按**文本锚点**而非行号断言
> （仓内既有纪律见 `packages/renderer/test/wiring/session-liveness-wiring.test.ts:48-57`）。
> 标注：**事实** = 本次工作树逐行核对；**推断** = 需 W0/实现期实测确认。

---

## 0. 证据基线核对（先纠正主计划 §1 的引用口径）

主计划 §1 的机制描述经逐行复核**成立**，但有两条引用需要回调（**事实**）：

| 主计划 §1 引用 | 实际（本工作树） | 判定 |
|---|---|---|
| `App.tsx:3937-3971`（完成事实只来自挂载壳） | handler 整体 3932-4088；撤回分支 3953-3971；蓝点对账 4062-4086 | 事实（引用可读，只是把 handler 头截掉了） |
| `retention.ts:39,42,99-120` | 39 = RETAINED_HIDDEN_VIEWS = 1；42 = VIEW_RECLAIM_GRACE_MS = 60_000；99-120 = excess/候选 | 事实（完全一致） |
| `client/index.ts:632-642` | effect 清理块 632-642，runtimeProducer.clear() 在 641 | 事实 |
| `derive.ts:868` | runningRingVisible 868-870（_channelRunning 参数**刻意不读**） | 事实 |
| `aggregate-store.ts:793-796` | 注册时若已有 report 则删缓存 + 广播 undefined | 事实 |
| `App.tsx:4118-4146` | 徽标 effect 4119-4146，projectBadgeCount(completedBySource, runtimeFacts) 在 4143 | 事实 |

**撤回链的完整 6 跳**（主计划未写全，W2 必须知道断在哪）（**事实**）：
reclaimView（`App.tsx:2953-3009`，disposeInstanceShell(id) 在 2989）
→ sidebar effect 清理（`client/index.ts:632-642`）
→ runtimeProducer.clear()（`client/index.ts:641`）
→ `aggregate-store.ts:803-811`（删 token/缓存并广播 undefined）
→ onRuntimeReport 监听（`App.tsx:3933`）
→ 撤回分支（`App.tsx:3953-3971`）：删 prevRunningRef(3962)/prevRuntimeFactsRef(3963)/
notifiedCompleteRef(3964)，并用 setCompletedBySource 删掉该来源账本(3965-3970)。

**两条必须写进 W2 计划书的现状事实：**

1. **仓内不存在任何未读持久化**（**事实**）。在 `packages/` 下做 grep（模式
   `dsh-chamber.unread` / `unread.v1` / `unread.v2`）**零命中**；唯一的中划线键常量是
   `view-prefs.ts:118` 的 `dsh-chamber.sidebar.v1`。⇒ 主计划 §0-3（重启未读不丢）在当前代码上
   **无存储载体**；`App.tsx:4148-4153` 明确写着「重载后 completedBySource 复位为 {}」。这也是本
   蓝图第 4 节必须先做持久化的原因——六条接线里第 2 条若只做派生不落盘，criterion 3 仍然是空的。
2. **「四面同源」在今天对 vendor-only 完成不成立**（主计划 §0-4 的隐含前提需修）（**事实**）：
   - 蓝点：mergeRuntimeFacts（`derive.ts:781-803`）对 vendor completed 与 App 账本取并集 →
     侧栏行渲染 .stateCompleted（`ServerSection.tsx:411-418`）；
   - 待办：读合并投影的 facts.completed（`todo-attention.ts:117`）→ 也显示；
   - 徽标：projectBadgeCount **只投影 App 账本**（`badge-count.ts:6-8,55-70`）→ **不显示**；
   - 通知：独立边沿机（`App.tsx:3973-4004`），且 notifiedCompleteRef 随撤回删除（3964）。
   该分歧在 `docs/design/19-notifications.md:366-371` 被**明文登记为既有取舍**。所以 §3.3-2 把账本
   改成派生**不会**自动闭合 criterion 4，必须同时决定徽标的投影输入（见 §7 修订建议 7）。

---

## 1. 现状盘点（带 file:line）

### 1.1 App 层（`packages/renderer/src/App.tsx`）

| 事实 | 位置 | 说明 |
|---|---|---|
| runtime 上报订阅 | 3932-4088（effect 依赖 []） | 唯一写 runtimeFacts/completedBySource 的入口 |
| 来源存活/指纹门 | 3934-3936 | 来源被删的 clear 走不到撤回分支 |
| runtimeFacts 提交（保 identity） | 3937-3952 | runtimeReportSignature 相同则不换对象 |
| **撤回分支** | 3953-3971 | R2 的爆炸点：删边沿记忆 + 删账本 |
| 通知边沿 + 组装 + notify | 3973-4061 | bridge.notify 单点在 4047-4055；requireHidden 4043-4046 |
| complete 去重记忆 | 3994-4004（dedupeCompleteEdges） | 与 prevRuntimeFactsRef(3981) 配对 |
| 蓝点对账 | 4062-4086 | reconcileCompletedFacts 在 4077-4083；readingCurrent 取 activeViewRef.current === sourceId ? report.current : undefined（4075） |
| 「切来源即已读」兜底 effect | 4094-4107 | 依赖 [activeView]，从 runtimeFacts[activeView].current 反查 |
| 徽标 effect | 4119-4146 | projectBadgeCount(completedBySource, runtimeFacts) 4143；桥迟到补推 4154-4165 |
| **connected 才附 runtime 的闸** | 475-485 | if (connected) { … mergeRuntimeFacts(runtimeFacts[id], completedBySource[id]) … } 483；断连即无 facts |
| ChamberServerAggregate 组装 | 460-474 | factsMode/factsDegraded 的落点 |
| unary 兜底 pull | 1541-1708 | fetchInstanceSnapshot 1587；commit 1625-1638；成功记 factsAtRef 1640 |
| **90s 未验证清 running 位** | 1669-1694 | shouldDropUnverifiedRunningFacts 1676-1679；只改 aggregates 1680-1692、置 unverified 1693；**不碰 runtimeFacts**（`docs/progress/STATUS.md:173-174` 事实） |
| unary 并发波 | AGGREGATE_POLL_CONCURRENCY 233、pollAggregates 1744+ | 刷新提示必须复用这套 seq/owner 去重（1544-1558） |
| 来源退役清理 | 1160-1277 | 清 completedBySource 1255-1265、prevRunningRef 1267-1269、prevRuntimeFactsRef 1272-1274、notifiedCompleteRef 1275-1277 |
| reclaimView | 2953-3009 | **不碰数据面**（头注 2941-2943）；只 dispose + 卸载 + 清诊断/抑制键 |
| reclaimHiddenViews | 3039-3137 | 后台相位门 3040；候选决策 3116-3129；设置面板 hold 3133-3136 |
| visibilitychange 监听 | 2128-2132 | **没有 focus/blur 监听**（全文件 hasFocus 只在 4046 出现一次）——item 5 要新增 |
| 会话停止入口 | 821 cancelSession | R12「自停标记已读」要在这里记 selfStopped |

### 1.2 sidebar 共享层（`packages/dsh-chamber-client-ui-sidebar/src/shared/`）

| 事实 | 位置 | 说明 |
|---|---|---|
| reconcileCompletedFacts | `derive.ts:494-532` | 武装 513-516；阅读解除 518-521；离表清扫 523-530（用 prevRunning/nextRunning） |
| projectRuntimeFacts | `derive.ts:560-598` | 行形状只有 running/completed/pending/runningSubagents（578-593）；pending 映射 589-592；**丢弃 updatedAt**（这是 Track A 在 channel-only 下也可用的低成本加法，见 §2-5） |
| mergeRuntimeFacts | `derive.ts:781-803` | 早退条件 787-789（runtime===undefined && !hasArmed → undefined）；并集 791-797；形状收敛注释 798-801 |
| runningRingVisible | `derive.ts:868-870` | 环只信 polled wire 位；_channelRunning 仅作契约可测 |
| runtimeReportSignature | `derive.ts:895-926` | includeRunning 双消费者；回执 916-919 只进身份路径 |
| serversProjectionSignature | `derive.ts:976-1010` | 渲染相关内容；includeRunning=false 995 |
| InstanceRuntimeReport | `aggregate-store.ts:365-386` | current + sessions + sessionFactReconcile；无 listComplete/factsMode |
| ChamberServerAggregate.runtime | `aggregate-store.ts:108-109` | 「attached, never polled」 |
| 注册时撤回广播 | `aggregate-store.ts:793-796` | R2 的注册半 |
| clear() | `aggregate-store.ts:803-811` | R2 的清理半 |
| retireInstanceProducers | `aggregate-store.ts:754-767` | 退役时同步撤销 + 广播 |
| runtimeReports 页内缓存 | `aggregate-store.ts:458` | 最后一个 report 在 store 里也留一份（撤回即删） |
| 跨 ctx 广播先例 | `client/index.ts:614-624`（onRequestSessionListRefresh） | App→各壳请求通道的现成形状，item 5 的读动作回写可照抄 |
| producer sync/clear | `client/index.ts:566-592 / 632-642` | runtimeProducer.report 590；清除 640-641 |
| pending 注册表注入 | `client/index.ts:494-510` | 无壳时该源必然缺席（R5 的直接证据） |
| 待办派生 | `todo-attention.ts:71-138` | 断连跳过 80；viewing 排除 86；pending 89-109；completed 110-117（子代理压制 115-116） |
| 徽标投影 | `renderer/src/badge-count.ts:55-70` | 只读 App 账本；子代理压制 65 |
| 保留策略 | `renderer/src/retention.ts:39,42,83-121,131-133` | 上限 1 / 宽限 60s / 后台相位门 |
| unary 行形状 | `shared/instance-api.ts:65-97`（updatedAt 72）、fetchInstanceSnapshot 617-692（updatedAt 635） | Track A 的水位来自这里 |
| 既有 REST 先例 | `shared/gateway-runtime-poll.ts:58`、`gateway-runtime.ts:456,506` | /api/i/<id>/chamber/* + 404 ⇒「网关没有该面」的降级口径 |

### 1.3 桌面层

| 事实 | 位置 | 说明 |
|---|---|---|
| NotificationRequest + requireHidden | `packages/desktop/notifications.ts:25-35` | item 3 要加 watermark |
| claim 键 | `notifications.ts:316-329`（键 321） | JSON.stringify([sourceId, sourceFingerprint, sessionId, kind])，5s TTL 表 273-343 |
| payload 校验 | `notifications.ts:640-704` | 白名单 + 上限；新字段必须进这里 |
| 纯边沿 | `renderer/src/notification-edges.ts:28-62 / 71-88` | detectNotificationEdges / dedupeCompleteEdges——item 3 要**复用**，不新写检测器 |
| 桌面单测 | `packages/desktop/test/desktop-shell/notifications.test.ts` | claim 行为用例的家 |

---

## 2. 六条接线（目标 / 改动点 / 签名 / 边界 / 降级 / 测试）

统一约定（六条共用）：

- 事实源接口 SessionFactsSource 只在 renderer 侧新增；宿主事实**永不进控制面**（`AGENTS.md:11-12`）。
- track（水位 / 边沿）是**能力事实**，来自 W0 结论 + 网关 features[]，缺省 'edge'（fail-safe）。
- 「正在阅读」只有一个谓词：activeView === sourceId && report.current === sessionId && document.hasFocus()
  （现实现 4075 与 4043-4046 各实现了一半；item 5 统一，见 §3.3）。
- 投影形状纪律：**只有渲染事实过桥**。updatedAt/completedAt 是判定输入，不进
  ChamberServerAggregate.runtime.sessions 的行（`derive.ts:798-801` 已立此纪律）。

---

### 接线 1 — 事实注入投影

**目标**：全部远端壳卸载/回收后，completed-unread、pending（approval/plan-review/question）
仍出现在侧栏行、待办与徽标；行（含 running 位）仍只由聚合提供（主计划 §12「行权威不变」）。

**改动点**

1. `derive.ts:781-803`：mergeRuntimeFacts 增加第三/第四参（overlay + stale），放宽早退条件
   787-789（有 overlay 行时不得返回 undefined），并保持 798-801 的形状收敛。
2. `aggregate-store.ts:365-386`：InstanceRuntimeReport 增 listComplete?: boolean（主计划 §6 点名）、
   factsMode?、factsDegraded?、stale?。
3. `App.tsx:475-485`：连接闸改为「connected 或 有事实 overlay」；断连但有事实时附 stale: true（R14）。
   `App.tsx:460-474` 写入 entry.factsMode/factsDegraded。
4. `App.tsx:3932-4088`：新增 factsBySource state 与 overlay 计算。
5. `todo-attention.ts:78-82`：断连跳过改为「无 runtime 才跳过；runtime.stale === true 仍出条目
   （离线未读/离线等待）」。
6. `derive.ts:982-1010`：factsMode/factsDegraded **必须**进 serversProjectionSignature
   （否则提示行冻结在首见值——同 832-845 的签名教训）。

**签名**

~~~ts
// derive.ts（overlay 是「只含渲染字段」的窄形状：判定字段不过桥）
export interface RuntimeFactsOverlayRow {
  pending?: 'approval' | 'plan-review' | 'question'
  runningSubagents?: number
}
export type RuntimeFactsOverlay = Readonly<Record<string, RuntimeFactsOverlayRow>>

export function mergeRuntimeFacts(
  runtime: InstanceRuntimeReport | undefined,
  completedBySource: Record<string, boolean> | undefined,
  overlay?: RuntimeFactsOverlay,       // 新
  stale?: boolean,                     // 新（R14：断连仍附只读事实并标 stale）
): InstanceRuntimeReport | undefined
~~~

**字段优先级（每字段单一权威，写进函数头注并锁住）**：
running：**不进投影**（环继续由 runningRingVisible 读 polled wire，`derive.ts:868-870`）；
pending：channel 有值则 channel，否则 overlay（overlay 是 headless 观察者，二者同源同注册表）；
runningSubagents：channel ?? overlay；completed：维持并集（vendor ∪ App 派生账本）；
current：只信 channel；stale：聚合级。

**边界**
- 断连来源：R14 放开 `App.tsx:480` 的连接闸，但只放「事实」不放「可动作」；todo-attention 出「离线」条目。
- 未知会话（overlay 有行、投影无行）：不渲染、不计数（可见行语义由 deriveUnread 的 listComplete 剪枝承担）。
- 已删会话：listComplete === true 时按缺席剪枝；false/缺省时保留（防假清）。
- 时钟/顺序：overlay 的所有时间值都是 host 域；客户端不产生任何用于比较的时间戳（主计划 §4）。

**降级**：无网关时 overlay === undefined && stale === undefined，二分行为与今天**逐字节一致**
（保 `derive.test.ts` 既有用例不动）。

**测试**
- `packages/dsh-chamber-client-ui-sidebar/test/session-rows/merge-runtime-facts.test.ts`（新，纯函数）：
  ① overlay-only（无 channel）出 pending 行；② channel pending 胜 overlay；③ completed 并集；
  ④ runningSubagents 回填；⑤ stale 透传；⑥ **反 churn 锁**：投影行里不得出现 updatedAt/completedAt；
  ⑦ 两参调用结果与改动前一致（兼容锁）。
- 接线锁：`packages/renderer/test/wiring/session-facts-wiring.test.ts` 断言
  `mergeRuntimeFacts(runtimeFacts[id], completedBySource[id],`（第三参存在）与 factsMode/factsDegraded
  进了投影签名输入。

---

### 接线 2 — 账本改派生（R2）

**目标**：completedBySource 是 deriveUnread() 的**投影**；撤回/同代重挂/崩溃后未读仍在。

**改动点**

1. `App.tsx:893`：completedBySource 保留为 state（渲染投影），新增 readMarksRef/edgeLedgerRef
   （v2 载入，见第 4 节）与 factsBySource。
2. `App.tsx:4062-4086`：把 reconcileCompletedFacts(...) 调用换成 deriveUnread(...)；
   同步写 edgeLedgerRef（唯一的 durable 边沿记忆）。
3. `App.tsx:3953-3971`：撤回分支**保留** 3962-3964 的易失记忆删除（prevRunning 是「转移」不是
   「状态」，持久化会伪造边沿），**删除 3965-3970 整段**（不再删来源账本），改为一次
   factsVerified: false 的 deriveUnread 重算（结果 = prevUnread 不变）。
4. `App.tsx:4094-4107`：从「删蓝点」改为「推进读标记」（item 5）。
5. `App.tsx:1255-1265`：来源**退役**（注册表删除）仍清账本，并新增清该来源的
   readMarks/edgeLedger/notifiedWatermarks；reclaimView（2953-3009）**一个都不清**。
6. `derive.ts:494-532`：reconcileCompletedFacts 保留为 deriveUnread 的**边沿轨内部实现**
   （不新写第二套武装/解除规则），头注标注「不再是唯一来源」。

**签名**

~~~ts
// sidebar/shared/unread.ts（新；纯函数，零 React/DOM 依赖）
export interface DeriveUnreadParams {
  rows: Readonly<Record<string, UnreadFactRow>>
  listComplete: boolean
  readMarks: Readonly<Record<string, number>>
  edgeLedger: Readonly<Record<string, boolean>>
  prevRunning: Readonly<Record<string, boolean>>
  prevUnread: Readonly<Record<string, boolean>>
  track: UnreadTrack
  viewingSessionId?: string
  selfStopped?: ReadonlySet<string>
  factsVerified: boolean
}
export function deriveUnread(p: DeriveUnreadParams): {
  unread: Record<string, boolean>
  completed: Record<string, boolean>      // 直接喂 mergeRuntimeFacts
  edgeLedger: Record<string, boolean>     // 待写回的 durable 边沿账本
  reasons: Record<string, UnreadReason>
  changed: boolean
}
~~~

**边界**
- 同代重挂：撤回不再删账本 ⇒ 重算立刻复现（R2 判据）。
- 崩溃/重启：账本 v2 + 读标记 v2 落盘 ⇒ 重启复现（criterion 3；这是 §0-事实 1 的补口）。
- 已删会话：只有 listComplete === true 的**权威缺席**才剪枝（否则列表短暂收缩会假清）。
- 手动停止（R12）：selfStopped 在 cancelSession（`App.tsx:821`）发起处登记，边沿轨下停止不出未读；
  水位轨构造性安全（无新内容即无未读），登记集合仍保留作双保险。

**降级**：无网关时 rows 来自壳通道 + unary 兜底；updatedAt 缺省 ⇒ 退回边沿账本（track 缺省 'edge'）。
账本持久化让「重启不丢」在**无网关**下也成立。

**测试**：`packages/dsh-chamber-client-ui-sidebar/test/session-state/unread.test.ts`（纯函数）
——水位升 ⇒ 武装；readMark >= updatedAt ⇒ 不武装；推进 readMark ⇒ 解除；updatedAt 缺失 ⇒ 退边沿；
水位已知且已读 ⇒ 同步清边沿（防两轨互斗）；listComplete=false 不剪枝；factsVerified=false 不得改变
prevUnread；selfStopped/viewing/running 三抑制。
接线锁：`packages/renderer/test/wiring/unread-derivation-wiring.test.ts` 断言 deriveUnread( 存在、
撤回分支的 setCompletedBySource 里**没有** delete next[sourceId]、readMarksRef/edgeLedgerRef 存在、
reclaimView 段内不出现 readMarks/edgeLedger。

---

### 接线 3 — 通知第二入口（R6）

**目标**：watcher 实时边沿走**同一个通知组装**，即使该来源没有壳；去重键
(sourceId, sessionId, 内容水位)；离线期间完成**只现未读、不补通知**。

**改动点**

1. `App.tsx:4005-4061`：把「文案 + 标题 + requireHidden + bridge.notify」抽成 handler 内的
   emitSessionNotification(request)，两个入口都走它；**bridge.notify( 全文只允许出现一次**
   （接线锁按调用点计数）。
2. 新 effect（与事实源启动同批）：对每个 gateway 来源把 GatewaySessionFact[] 映射成
   Record<string, SessionFacts>（completed: completedAt !== undefined），**复用**
   detectNotificationEdges（`notification-edges.ts:28-62`，prev === undefined ⇒ 只播种）与
   dedupeCompleteEdges 的语义；水位记忆用新 ref
   notifiedWatermarkRef: Record<string, Record<string, number>>，键 sourceId/sessionId/kind。
3. `notifications.ts:316-329`：claim 键加水位项；`notifications.ts:25-35` 的 NotificationRequest
   加 watermark?: number；校验（640-704）接受可选非负安全整数，非整数/负数响亮拒绝。
4. R12：selfStoppedRef 过滤 complete 边沿；running === true 时清除标记与水位记忆。
5. **协议缺口（必须回报主计划）**：completedAt 需要来源标注
   completedAtSource: 'observed' | 'reconstructed'。watcher 重启从落盘重建的缺口完成是
   reconstructed，第二入口**必须丢弃其通知**（只留未读）——否则违反主计划 §5-5。主计划 §4 的行
   字段里没有这个标注位。

**签名**

~~~ts
// renderer/src/notification-dedupe.ts（新，纯）
export function shouldNotifyWatermark(prev: number | undefined, watermark: number): boolean
export function nextNotifiedWatermark(prev: number | undefined, watermark: number): number

// App.tsx 局部（唯一组装点）
type SessionNotificationRequest = {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: 'complete' | 'ask' | 'request'
  /** 内容水位（host 域）：complete=completedAt ?? updatedAt；ask/request=updatedAt */
  watermark: number
  /** 'channel' | 'facts'——仅诊断，不进 IPC */
  origin: 'channel' | 'facts'
}

// desktop/notifications.ts
const key = JSON.stringify([
  request.sourceId, request.sourceFingerprint, request.sessionId, request.kind,
  request.watermark ?? null,
])
~~~

**边界**
- 双入口同一次完成：两边水位相同 ⇒ 桌面 5s claim 合并（键含水位）；水位不同（例如 complete 用
  completedAt、另一路用 updatedAt）⇒ 约定**同一行取同一个水位函数**（completedAt ?? updatedAt），
  并在锁测试里钉住。
- kind 与 sourceFingerprint **必须留在键里**：只按 (sourceId, sessionId, watermark) 会让同水位的
  ask 与 complete 互相吞掉，且 same-id 换宿主会继承旧 claim（`notifications.ts:319-321` 的既有理由）。
- 离线完成：baseline 只播种；reconstructed 不通知（改动点 5）。
- 子代理压制：沿用 `App.tsx:3987-3990` 的「complete 且 runningSubagents > 0 直接滤除、不记账」；
  第二入口用同一谓词，不得只在一路实现。

**降级**：无网关 ⇒ 第二入口不存在，通知退回壳通道（行为不劣化）；claim 键对无 watermark 的旧调用方
序列化 null，5s TTL 语义不变。

**测试**
- 纯：`packages/renderer/test/aggregate/notification-watermark.test.ts`（shouldNotifyWatermark 单调、
  同值不重复、回退不允许）。
- 桌面：`packages/desktop/test/desktop-shell/notifications.test.ts` 增 ①同水位 5s 内第二次被 claim 拒；
  ②水位更高则放行；③无 watermark 的旧形状行为不变；④watermark: 1.5 / -1 / 'x' 被校验拒。
- 接线锁：`packages/renderer/test/wiring/notification-second-entry.test.ts` 断言 bridge.notify( 出现
  次数 === 1、shouldNotifyWatermark( 存在、completedAtSource 消费存在、emitSessionNotification( 被两处调用。

---

### 接线 4 — 行刷新提示（R9）

**目标**：watcher session-added/removed/changed → 该来源立刻一次 unary；行与 running 环仍是聚合权威
（runningRingVisible 不改，`derive.ts:868-870`），靠这条把「关壳后 running ≤2s」做成**一次往返**
而不是 30s 轮询。

**改动点**

1. `packages/renderer/src/session-facts-source.ts`（新）暴露 onRowHint；收到 delta 的 upserts/removed 即触发。
2. `App.tsx:3932-4088` 之外的**新** effect：为每个事件源订阅 onRowHint，经纯函数
   shouldDispatchRefreshHint 判定后调用既有 refreshAggregate(sourceId)（1541+；其 aggregatePollSeqRef /
   aggregateRequestOwnersRef / refreshPullStillCurrent 1544-1558 已能压掉被超越的拉取，无需新并发原语）。
3. 隐藏期：shouldRunBackgroundPhase（`retention.ts:131-133`）已有语义——但提示是「事件驱动的一次拉取」，
   与 30s watchdog 的隐藏暂停不同；建议**照旧在隐藏期丢弃提示**（恢复可见由 visibilitychange 补偿，
   2128-2132），并在头注写明取舍。

**签名**

~~~ts
// renderer/src/source-refresh-hint.ts（新，纯）
export const SOURCE_REFRESH_HINT_FLOOR_MS = 1_000
export interface SourceRefreshHintInput {
  connected: boolean
  unverified: boolean          // App.tsx:1669-1694 / STATUS:173-174 的「无法确认」
  inFlight: boolean            // 该来源已有在途 pull
  lastHintAt: number | undefined
  now: number
}
export function shouldDispatchRefreshHint(input: SourceRefreshHintInput, floorMs?: number): boolean

// session-facts-source.ts
onRowHint(listener: (sourceId: string) => void): () => void
~~~

**边界**
- 未连接 / unverified / 在途：不发（R20；避免把一次读取失败放大成拉取风暴或假水位）。
- 高频 delta：floor 1s + 既有并发波（AGGREGATE_POLL_CONCURRENCY = 4，`App.tsx:233`）双保险。
- 已挂载来源：也照发（幂等；commitAggregatePull 的 mounted merge 与 instanceSnapshotSignature 去重会吸收，
  `App.tsx:1617-1638`）。
- 新行 ≤1 次往返（R9 判据）：hint → pull → commit，无第二轮。

**降级**：SSH 来源/旧网关无 watcher ⇒ 提示通道不存在，退回 30s watchdog（今天的行为）；
factsMode === 'channel-only' 时 onRowHint 永不触发（不是空转轮询）。

**测试**：`packages/renderer/test/lifecycle/source-refresh-hint.test.ts`（纯）——floor 边界、断连、
unverified、in-flight 四拒 + 正常放行；接线锁断言 App 里 shouldDispatchRefreshHint( 存在且其真值分支
调用 refreshAggregate(。

---

### 接线 5 — 读动作写标记（R4/R10/R12）

**目标**：正在查看的 current 会话持续推进 readMark = 当前 updatedAt；切走/失焦即停；
「标记全部已读」取当前最大值；服务端按 client-install id 幂等 upsert，本地 v2 兜底。

**改动点**

1. `packages/dsh-chamber-client-ui-sidebar/src/shared/unread.ts`（新）：advanceReadMark 与
   planReadAdvance（批量，见 §3）。
2. `App.tsx:4094-4107`：effect 改为「激活即推进一次 + 之后由上报驱动推进」。
3. **新增 focus/blur 监听**（今天没有，只有 visibilitychange 2128-2132）：focused state 参与
   「正在阅读」谓词与推进调度。
4. `App.tsx:4142-4146` 附近：读标记写盘调度（≤1 次/秒；pagehide 与 visibilitychange→hidden 立即 flush；
   localStorage.setItem 同步，可在 pagehide 里安全落盘）。
5. session-facts-source.ts：ackRead(sessionId, readMark) / ackAllRead(marks) 走
   POST /api/i/<id>/chamber/session-state/read、/read-all（幂等；失败只 warn，本地为准）。
6. chamberBridge 新通道 onMarkAllRead（照 `client/index.ts:614-624` / `aggregate-store.ts:816-821` 的形状
   加一组 listener + 广播函数），待办区按钮触发；App 收到后对每个会话 readMark = max(readMark, updatedAt)。
   **这是 W4 项，但桥通道要在 W2 一次性加完**（否则 W4 又要动一次跨包契约）。
7. 回调：事实源 baseline/delta 带 read 时，readMarks = mergeReadMarks(local, remote) 并触发一次重算
   （手机读掉 ⇒ 桌面熄灭，R10）。

**签名**

~~~ts
// unread.ts
export function advanceReadMark(
  current: number | undefined,
  row: UnreadFactRow | undefined,
  track: UnreadTrack,
): number | undefined

export function planReadAdvance(params: {
  rows: Readonly<Record<string, UnreadFactRow>>
  viewingSessionId: string | undefined        // 谓词见 §3.3；undefined ⇒ 不推进
  track: UnreadTrack
}): { marks: Record<string, number>; changed: boolean }

export function maxWatermark(rows: Readonly<Record<string, UnreadFactRow>>): Record<string, number>

// unread-storage.ts
export function mergeReadMarks(
  local: Readonly<Record<string, number>>,
  remote: Readonly<Record<string, number>> | undefined,
): Record<string, number>   // 逐会话 max；remote 缺席不改本地
~~~

**边界**
- 失焦：只**停止推进**，不回退标记、不重新武装（「已读」是单向的）。
- current 在缺失 updatedAt 的行上：不推进水位，只清该会话的边沿账本（用户确实看到了）。
- 推进与服务端迟到：本地内存是权威、v2 是缓存、服务端是跨端权威；合并永远取 max（时钟偏斜下仍单调，
  因为比较全在 host 域）。
- 手动停止（R12）：停止时若该会话正被查看，标记照常推进到停止前的 updatedAt（用户看到了停止动作本身）；
  不改内容水位 ⇒ 无假未读。
- 读标记不得下传比服务端更旧的值造成回退：POST 只发 max，服务端 upsert 亦为 max 语义。

**降级**：无网关 ⇒ 只写本地 v2（ackRead 跳过）；updatedAt 不可得 ⇒ 只清边沿账本；
window.dshChamber 桥缺失（web/dev）不影响读标记（纯 renderer 事实）。

**测试**：unread.test.ts 增 advanceReadMark（单调、0/undefined 安全、> 而非 >=）、maxWatermark、
mergeReadMarks（远端更高取远端、远端更低不回退、远端缺席不变）；
`packages/dsh-chamber-client-ui-sidebar/test/session-state/unread-storage.test.ts` 覆盖 1s 节流与 flush
（注入 storage 假实现，照 `view-prefs.test.ts:185-206` 的写法）；接线锁断言
window.addEventListener('focus' / 'blur' 与 ackRead( 存在。

---

### 接线 6 — 降级路径（R17/R19）

**目标**：旧网关 / 观察者不可用 ⇒ 现状路径（壳通道 + 本地标记），行为不劣化，且**有结构化可见提示**。

**改动点**

1. session-facts-source.ts（新）：每次「来源就绪」探一次 GET /api/i/<sourceId>/chamber/session-state
   （AbortSignal.timeout，一次性，不重试）。判定为纯函数；404 / 无 protocol ⇒ channel-only；
   401/403 ⇒ channel-only + warn 一次。
2. `App.tsx:460-474` 把 factsMode/factsDegraded 写进 entry；`derive.ts:982-1010` 纳入投影签名。
3. 侧栏提示：**结构化事实 + 消费方自写文案**（`aggregate-store.ts:140-157` 的 bootGap 纪律）：
   新增 ChamberServerAggregate.factsDegraded?: 'unsupported' | 'unreachable' | 'protocol'，
   ServerSection 出本地化句子；词典加在 `packages/dsh-chamber-client-ui-sidebar/src/client/locales.ts`
   （zh 141-145 / en 273-277 邻近区）。
4. 判定缓存按 sourceFingerprint（既有身份证明，`App.tsx:3935-3936`）：重连/重挂 = 新指纹 ⇒ 重探；
   同代不反复打 404。
5. 来源退役：stop() 事件源（在 1160-1277 的清理里），并照 releaseInstanceClient
   （`instance-api.ts:468-470`）释放缓存。

**签名**

~~~ts
export type SessionFactsMode = 'gateway-sse' | 'gateway-poll' | 'channel-only'
export function planFactsMode(probe:
  | { kind: 'answered'; protocol: unknown; mode: unknown }
  | { kind: 'http'; status: number }
  | { kind: 'network' }
): { mode: SessionFactsMode; degraded: 'unsupported' | 'unreachable' | 'protocol' | undefined }
~~~

**边界**
- mode: 'poll'（dsh pin 事件契约握手失败，R18）：仍算「有事实」，但 factsDegraded: 'protocol' 且只走
  轮询；不得静默当成 sse。
- 混合升级（R19）：判定与提示都是**按来源**（entry 级字段），不引入全局开关。
- 网络抖动：network ⇒ channel-only，但**不**永久缓存（下次连接代际重探）；与 404（能力性结论，
  可缓存到指纹变更）区别对待。
- 提示只描述能力，不暴露网关版本号（factsDegraded 是枚举，不是字符串）。

**降级**：这本身就是降级路径；其承诺是「不劣化」——所有六条的缺省行为都必须在
factsMode === 'channel-only' 下与今天一致（锁测试：两参 mergeRuntimeFacts + 无 overlay + 边沿账本
+ 本地读标记）。

**测试**：`packages/dsh-chamber-client-ui-sidebar/test/source-runtime/session-facts-mode.test.ts`（纯，
planFactsMode 全分支）+ `.../session-facts-source.test.ts`（注入 fetch/EventSource，照
gateway-runtime-poll 的注入形状）：baseline 解析、delta 解析、Last-Event-ID 续传、坏载荷 ⇒ 全量重取、
probe 404 ⇒ channel-only、poll 降级；接线锁断言 factsDegraded 进 entry 且进投影签名。

---

## 3. 未读判定与读标记的纯函数设计

### 3.1 输入行与状态

~~~ts
export type UnreadTrack = 'watermark' | 'edge'
export type UnreadReason = 'watermark' | 'completedAt' | 'edge'
  | 'running' | 'viewing' | 'self-stop' | 'unverified'

export interface UnreadFactRow {
  sessionId: string
  running?: boolean
  /** host 域内容水位（epoch ms）。缺省/0 = 未知（0 与旧口径「无时间」一致）。 */
  updatedAt?: number
  /** host 域完成边沿（边沿轨触发/诊断）。 */
  completedAt?: number
  /** 该 completedAt 是 watcher 实时观察还是重启后重建（重建不得通知）。 */
  completedAtSource?: 'observed' | 'reconstructed'
  /** 行是否来自一次可验证读取；false 的行不得武装。 */
  verified?: boolean
}
~~~

readMarks / edgeLedger 是**跨重启持久**的两张表；prevRunning 是**易失**的转移记忆
（撤回即删，见接线 2 改动点 3）。

### 3.2 判定规则（deriveUnread，判定顺序即优先级，写进函数头注）

对每个 row ∈ rows（按 sessionId 升序，保证确定性）：

| # | 条件 | 结果 | reason |
|---|---|---|---|
| 0 | factsVerified === false | **整体返回 prevUnread**（不 clobber、不剪枝） | unverified |
| 1 | row.running === true | 不未读；清该会话边沿账本；水位标记不动 | running |
| 2 | sessionId === viewingSessionId | 不未读；清边沿账本（读标记由调用方推进） | viewing |
| 3 | selfStopped.has(sessionId) | 不未读；清边沿账本 | self-stop |
| 4 | track === 'watermark' 且 updatedAt > 0 | updatedAt > (readMarks[id] ?? 0) 即未读；**否则清边沿账本**（两轨不互斗） | watermark |
| 5 | track === 'watermark' 且 updatedAt 未知 | 退化为边沿账本 | edge |
| 6 | track === 'edge' 且 completedAt > 0 | completedAt > (readMarks[id] ?? 0) 即未读；否则看边沿账本 | completedAt |
| 7 | track === 'edge' 且 completedAt 未知 | 边沿账本 | edge |

对 rows 缺席的会话：
- listComplete === true ⇒ 从 unread 与 edgeLedger 剪除（R13；≤2s 判据的实现位）；
- 否则保留 prevUnread 中为 true 的项（列表收缩/重连窗口不得假清）。

比较一律 >（同水位不重复武装），且只用 host 域值（主计划 §5-13）。

### 3.3 「正在阅读」的唯一谓词

~~~ts
const viewingSessionId =
  activeViewRef.current === sourceId && document.hasFocus()
    ? runtimeFactsRef.current[sourceId]?.current       // 或 facts baseline 的 current（若有）
    : undefined
~~~

- 与 reconcileCompletedFacts 的 readingCurrent（`derive.ts:498-499`，现由 `App.tsx:4075` 传入）
  **同一个谓词**，只是补上 document.hasFocus()（主计划 §3.3-5「失焦即停」）。单窗口下
  document.hasFocus() 与主进程 isAnyWindowFocused() 等价（`App.tsx:4041-4042` 事实）。
- **行为变更必须显式登记**（**事实 + 推断**）：今天失焦状态下的活动 current 会话完成**不会**亮蓝点
  （readingCurrent 不看焦点，`App.tsx:4075`）；改后会给它亮蓝点（用户没在看）。这与通知的
  requireHidden（`App.tsx:4043-4046`）方向一致，属「同源同规则」的收紧。

### 3.4 读标记推进

~~~ts
advanceReadMark(current, row, track):
  if row === undefined → current
  const w = track === 'edge' ? (row.completedAt ?? row.updatedAt) : row.updatedAt
  if w === undefined || w === 0 → current              // 未知不臆造
  return current === undefined || w > current ? w : current   // 单调
~~~

- 只有 viewingSessionId !== undefined 时才调用；
- 推进后立即用新标记重算该来源（同一 commit 内），保证「点开的下一帧蓝点已灭」；
- 写盘节流 ≤1 次/秒；pagehide/隐藏 flush；POST /read 去抖 1s、单飞。

### 3.5 「标记全部已读」

maxWatermark(rows) 给出每个会话的当前水位；对 rows 里每个会话 readMark = max(readMark, watermark)；
无水位行只清边沿账本；随后 ackAllRead(marks)。**语义边界**：不在 rows 里的（当前不可见来源）不动
——「全部已读」只作用于当前已知事实（诚实不臆测）。

---

## 4. 持久化与迁移

### 4.1 localStorage 键（全部 dsh-chamber. 前缀，与 `view-prefs.ts:118` 同族）

| 键 | 内容 | 生命周期 |
|---|---|---|
| dsh-chamber.client-install-id.v1 | {"v":1,"id":"<uuid>","createdAt":<ms>} | 首启生成一次；重装 = 新 id（旧标记交服务端 TTL） |
| dsh-chamber.unread.v1 | 旧边沿账本 {"<sourceId>":{"<sessionId>":true}} | **只读一次 + 迁移后删**；HEAD 无写入者（§0-事实 1） |
| dsh-chamber.unread.v2 | {"v":2,"read":{…},"edge":{…},"notified":{…}} | 当前；唯一被持续写入的未读键 |

~~~ts
export interface UnreadV2Payload {
  v: 2
  /** sourceId → sessionId → host 域水位（读标记） */
  read: Record<string, Record<string, number>>
  /** sourceId → sessionId → true（边沿轨回退账本） */
  edge: Record<string, Record<string, boolean>>
  /** sourceId → sessionId → kind → 已通知水位（第二入口去重） */
  notified: Record<string, Record<string, Record<'complete' | 'ask' | 'request', number>>>
}
~~~

**纪律**：载荷里**不得出现 title/cwd/消息内容**（主计划 §4 隐私条）；序列化前剪除空表，
maxSessionsPerSource = 500（按水位 LRU），来源退役整表删。这条要有一把锁测试（对 payload 的键集合
断言只允许 id/sourceId/sessionId/watermark 类值）。

### 4.2 client-install id 生成

crypto.randomUUID() → 失败退 crypto.getRandomValues(new Uint8Array(16)) 十六进制 → 再失败退
Math.random 拼装 + warn 一次（不静默）。写失败（私有模式/配额）⇒ 仅内存态并 warn，**不影响本地未读**；
服务端登记随 /read 请求隐式完成（主计划 §4「localStorage + 服务端」）。

### 4.3 v1 → v2 迁移（幂等、单向、可重入）

~~~
loadUnread(storage):
  raw2 = getItem(UNREAD_V2_KEY)
  if raw2 可解析且 v===2 → 逐字段 lenient sanitize；**顺手** getItem(V1) 非空则删；
                             返回 payload（不跑迁移）
  v2 缺失/损坏:
      v1 = getItem(UNREAD_V1_KEY)
      payload = { v:2, read:{}, edge: sanitizeEdge(v1), notified:{} }
      saveUnread(payload)         // 失败则保留 v1 原样，下次再试（不许先删后写）
      若 v2 写入成功 → removeItem(V1)
      return payload
~~~

- **顺序是契约：先写后删**（v1 是唯一数据时不丢）。
- 损坏 v2 与「合法但部分字段坏」分开：整包 JSON 坏了当 v2 缺失（跑迁移）；字段坏了就地剥掉坏项
  （不整包丢弃），warn 一次。
- **本仓真实迁移的对象只有「中间版本」**：如果 W2 先落 item 2（边沿账本）+ 本地写 v1、后落 item 5
  （读标记）才升 v2，则 v1 有写入者；若 W2 一次到 v2，此迁移在 HEAD 上恒为 {edge:{}} no-op。
  两种走法都要能被这条纯函数覆盖（测试同时钉住两条路径）。
- 存储访问器沿用 `view-prefs.ts:234-240` 的 lazy + never-throw 形状；并且**必须**采用
  `view-prefs.ts:274-304` 的「单一 live 缓存 + 订阅通知」模式——N 个 ctx 同页共享一个 localStorage，
  逐调用点 setItem 会 last-writer-wins 丢标记。

### 4.4 读标记推进规则（服务端 + 本地）

1. 内存是权威：readMarksRef 是唯一比较源；v2 是缓存；服务端是跨端权威。
2. 推进条件：§3.3 的 viewing 谓词为真（active source ∩ 其 current ∩ 焦点）。
3. 落盘：合并写（≤1 次/秒），pagehide 与 visibilitychange→hidden 同步 flush。
4. 服务端：ackRead(sessionId, mark) 去抖 1s + 单飞/来源；/read-all 只在显式动作时发。
5. 合并：readMarks = mergeReadMarks(local, server)（逐会话 max）；服务端更低**永不**回退本地。
6. 启动顺序：载入 v2 → 立即用账本渲染未读（不等网络） → 事实 baseline 到达后 merge 服务端 read 并
   重算 → 若服务端更高则原地熄灭。
7. 时钟域：所有值都是 host updatedAt。桌面墙钟只用于节流与去抖，**不进任何相等/大于比较**；
   测试注入「网关时钟 +1h」应产生零假未读（主计划 §10 故障注入项下沉到 W2 出口）。

---

## 5. 接线锁测试清单

仓内模式：纯函数行为测试（node:test 直跑）+ 对 `App.tsx` 这类不可 import 的文件用
**stripComments + 文本锚点**（`scripts/dev/test-support/source-text.ts`）。文本匹配前一律剥注释
（`session-fact-reconcile-wiring.test.ts:11-12` 既有纪律）。

| # | 锁文件（新/改） | 断言 | 挡住什么错修 |
|---|---|---|---|
| L1 | `renderer/test/wiring/unread-derivation-wiring.test.ts` | deriveUnread( 存在；撤回分支（prevRuntimeFactsRef.current[sourceId] = report.sessions 附近的 setCompletedBySource）里 delete next[sourceId] **不存在** | 「派生」但撤回仍删账本 ⇒ R2 原样复发 |
| L2 | 同上 | readMarksRef.current / edgeLedgerRef.current 存在且被写回 | 只算不存 ⇒ 重启丢失（criterion 3） |
| L3 | 同上 | reclaimView 函数体内不出现 readMarks/edgeLedger（数据面不随拆壳清） | 拆壳顺手清标记 ⇒ 假未读/丢未读 |
| L4 | `renderer/test/wiring/session-facts-wiring.test.ts` | mergeRuntimeFacts(runtimeFacts[id], completedBySource[id], 第三参存在；factsMode/factsDegraded 进 entry 且进投影签名输入 | overlay 没进投影 ⇒ 关壳后 pending/未读消失 |
| L5 | 同上 | createSessionFactsSource( / planFactsMode( 存在；factsDegraded 有消费点 | 降级无提示 ⇒ R17「不静默」失守 |
| L6 | `renderer/test/wiring/notification-second-entry.test.ts` | bridge.notify( 全文出现次数 === 1；shouldNotifyWatermark( 存在；completedAtSource 被消费 | 两套组装漂移 ⇒ 文案/豁免分叉；重建完成乱发通知 |
| L7 | 同上 | emitSessionNotification( 被 >= 2 处调用 | 「第二入口」写成注释不接线 |
| L8 | `renderer/test/wiring/source-refresh-hint-wiring.test.ts` | shouldDispatchRefreshHint( 存在且真值分支调 refreshAggregate( | 提示接了但空转 |
| L9 | 同上 | runningRingVisible( 的调用点仍是两参 polled-wire 形状（`ServerSection.tsx:383,395` 不变） | 顺手让环读 channel/overlay ⇒ 破坏 06 §4.3 已评审契约 |
| L10 | `renderer/test/wiring/read-mark-wiring.test.ts` | addEventListener('focus'、'blur'、pagehide 存在；ackRead( 存在 | 失焦即停/落盘/服务端写标记漏接 |
| L11 | `sidebar/test/session-state/unread-wiring.test.ts` | UNREAD_V2_KEY === 'dsh-chamber.unread.v2'、UNREAD_V1_KEY === 'dsh-chamber.unread.v1'、CLIENT_INSTALL_ID_KEY 常量；loadUnread 里 saveUnread 的调用序早于 removeItem(V1) | 先删后写 ⇒ 老用户标记清零 |
| L12 | 同上 | v2 payload 的键白名单（无 title/cwd/content） | 隐私面回归（§4 纪律） |
| L13 | `desktop/test/desktop-shell/notifications.test.ts` | 键含 watermark ?? null；watermark 缺省时与旧 4 元组行为一致 | IPC 破坏性变更 |
| L14 | `desktop/test/ipc/cross-package-contract.test.ts` / `ipc-surface-mirror.test.ts` | NotificationRequest.watermark?: number 双侧镜像 | 桥两侧签名漂移 |
| L15 | `sidebar/test/session-rows/todo-attention.test.ts`（改） | stale: true 的 runtime 在断连来源出「离线未读」条目；stale 缺省时行为不变 | R14 只改了 App 没改消费方 |
| L16 | `sidebar/test/session-state/unread.test.ts`（新） | §3.2 判定表逐行；factsVerified=false 不 clobber；listComplete 才剪枝 | 假清/假未读（R13/R20） |

> 兼容锁（必须存在）：mergeRuntimeFacts 两参调用的输出与改动前逐字节一致；
> dedupeCompleteEdges / detectNotificationEdges 既有用例一字不改（复用而非重写）。

---

## 6. 风险

| # | 风险 | 依据 | 对策 |
|---|---|---|---|
| K1 | **W0 未跑就选轨道**：updatedAt 是否随 agent 产出推进无公开保证 | 主计划 §2-3 / §3.1 | track 缺省 'edge'；水位轨只在 features[] 显式声明时开启；两轨都留验收判据（主计划 §5-12） |
| K2 | **派生账本被陈旧事实武装**：读标记是 host 域但事实可能来自失败读 | `App.tsx:1669-1694`；`STATUS.md:173-174` | factsVerified 总闸 + deriveUnread 规则 0（不 clobber）；接线 4 的 unverified 拒发 |
| K3 | **存储无界增长 / 隐私**：每来源每会话一条 read + edge + notified | 新面 | 来源退役整表删；listComplete 剪枝；500/来源上限；键白名单锁（L12） |
| K4 | **N-ctx 并发写同一 localStorage**：逐调用点 setItem 会 last-writer-wins 丢标记 | `view-prefs.ts:283-285` 的既有教训 | 单一 live 缓存 + 订阅（接线 5 改动点 4） |
| K5 | **两个通知入口双发** | 接线 3 | 同一水位函数 + 桌面 claim 键含水位 + notifiedWatermark 单调记忆 + L6 |
| K6 | **design 17 §10 明文「编排面已整体剥离（用户决策），不得回流」** | `docs/design/17-server-side-gateway.md:672-679` | 新路由虽为只读投影，仍必须走 `AGENTS.md:109-113` 的**被否方案一节**并显式登记到 design 17；否则 review 有权按「回流」拒绝 |
| K7 | **设计文档与实现分叉**：design 19 §3.5「仅已挂载来源」/§3.7 徽标口径、design 06 §5「首观察之前无蓝点」「蓝点跨断连保留」在新模型下不再字面成立 | `19-notifications.md:307-316,366-378`；`06-sidebar-enhancements.md:597-606` | W2 同 PR 更新这三处（主计划 §11 只记了 design 17/01） |
| K8 | **criterion 4 不会自动闭合**：徽标只投影 App 账本，vendor-only completed 存在分歧 | `badge-count.ts:6-8,55-70`；`derive.ts:791-797`；`design 19:366-371` | §7 修订建议 7：徽标改投影合并后的 completed（或显式接受并改判据措辞） |
| K9 | **runningRingVisible 被误解为需要改**：主计划 §3.2 图把 running 路由到 watcher | `derive.ts:856-870`；`STATUS.md:173-174` | 接线 4 是 running ≤2s 的载体；L9 锁住两参形状；W2 计划书加一句「环不改」 |
| K10 | **桥/IPC 破坏面**：watermark 加进通知请求；factsDegraded 加进聚合 | 契约测试家族 | 两侧镜像 + 兼容锁（L13/L14/L15） |
| K11 | 撤回窗口内的完成仍可能丢（无网关、纯壳通道） | `App.tsx:3953-3961` 的既有裁决 | 不撤销 2026-09 裁决（主计划 §12）；账本持久化把「窗口内**已武装**者」保住，未武装者仍丢——在 W2 计划书里如实写为残余而非修复 |

---

## 7. 对主计划 §3.3 与 W2 的修订建议

1. **§3.2 架构图 + §3.3-4 改口径**：运行环**不**改由 watcher 驱动（runningRingVisible，
   `derive.ts:868-870`），watcher 只发 session-added/removed/changed 提示，靠 §3.3-4 的「一次 unary」
   把 running 的 ≤2s 判据做成。否则实现者会去改环的权威源，破坏 06 §4.3 与
   `test/session-rows/completed-dots-signatures.test.ts`。
2. **§3.3-1 补机械锚点**：点名 mergeRuntimeFacts（`derive.ts:781-803`）与第三/第四参；并加一条
   「判定字段（updatedAt/completedAt）不进投影形状」的反 churn 规则（`derive.ts:798-801` 的既有纪律）。
3. **§3.3-2 补实现约束**：reconcileCompletedFacts 保留为 deriveUnread 内的边沿轨实现（**一套规则**）；
   撤回分支保留 prevRunning 的删除（转移记忆易失），只停止删 durable 账本；deriveUnread 必须落盘
   （§0-事实 1：今天仓内零持久化，criterion 3 无载体）。
4. **§3.3-3 修正去重键**：写全 (sourceId, sourceFingerprint, sessionId, kind, 内容水位)——主计划的
   (sourceId, sessionId, 内容水位) 会让 ask 与 complete 在同水位互吞，且 same-id 换宿主会继承旧 claim
   （`notifications.ts:319-321` 的既有理由）。
5. **§3.3-5 补谓词定义**：把「正在查看」定义为 activeView ∩ activeView 的 current ∩ document.hasFocus()，
   并声明这是对今天 readingCurrent（`App.tsx:4075`，不含焦点）的**行为变更**（失焦时的完成会亮蓝点）。
   同时明确「推进标记」与「解除蓝点」是同一个谓词，否则两面会分叉。
6. **§3.3-6 补提示的所有权规则**：降级提示必须是**结构化事实**（factsMode/factsDegraded）过桥、
   由侧栏自写文案（`aggregate-store.ts:140-157` 的 bootGap 先例），并纳入 serversProjectionSignature
   （否则冻结在首见值）。
7. **新增一条 §3.3-7（四面同源的决定）**：徽标要不要计入 vendor-only completed？建议改为「徽标投影
   **合并后的 completed**（= 蓝点事实）并沿用子代理压制」，这样 criterion 4 才真成立；若决定保留今天
   「徽标只认 App 账本」的取舍，则 §0-4 的判据措辞必须改写为「四面**同规则**（完成未读的武装/解除同一
   状态机），vendor-only 兜底为文档化例外」。
8. **§4 协议补两个字段**：
   - 行级 completedAtSource: 'observed' | 'reconstructed'（否则 §5-5「离线完成不回补通知」无法实现——
     桌面无法区分实时边沿与重启重建）；
   - SSE delta 可携带 read（跨端已读 R10 需要读通道推送，不能只靠快照）。
9. **§6 破坏性变更清单更正**：dsh-chamber.unread.v1 在 HEAD **没有写入者**（§0-事实 1）。要么在 W2
   计划里写明「v1 = 只落边沿账本的中间版本」，要么承认 v1→v2 导入是防御性代码（仍建议保留 + 单测，
   成本约 30 行）；两种走法必须选一个，不能留「一次性导入」的模糊语句。
10. **W2 出口判据补三条可测项**（主计划 W2 只写「启动即见未读；四面一致」）：
    (a) 双入口对同一次完成只出一次横幅（claim 键含水位）；
    (b) 网关时钟 +1h 的注入下零假未读（读标记全在 host 域）；
    (c) channel-only（旧网关 / SSH）下蓝点/待办/徽标/通知四面不回退（对照今天的行为基线）。
11. **W2 计划书加一条非回归**：runningRingVisible 的两参形状与 detectNotificationEdges /
    dedupeCompleteEdges 的既有用例**一字不改**（复用纪律）。
12. **W1 契约测试提前一件**：completedAtSource 的重建语义由 W1 的缺口重建路径产出，不能在 W2 才补
    ——建议 W1 的契约测试就断言「watcher 重启后重建出的完成标 reconstructed」。
