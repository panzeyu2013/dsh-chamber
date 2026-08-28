# 10 · 侧边栏聚合改事件驱动（已实现，2026-08）

> **状态：已实现**——2026-08 前端性能排查（INP 232ms / 长时间运行变卡）后记录的
> **设计级改进**：把 App 层的 10s REST 聚合轮询改为**各来源 ctx 经 chamberBridge
> 推送投影**（轮询退化为未挂载来源的兜底）。本文记录动机、机制、契约影响、风险与
> 分期。最终实现严格限于 chamber 自有包：复用每个 ctx 已有 store/host-frame 链，
> **没有修改 vendor 或上游 dsh，也没有新增远端推送协议**。
>
> 背景性能修复（**已实现**，见 `docs/progress/STATUS.md` 代码收敛）：shell 销毁时
> cordis ctx 拆除（防僵尸 shell 泄漏）、publish 签名闸 + identity-preserving 状态
> （消除 10s 轮询触发的 N×侧边栏全量重渲染）、会话行 `content-visibility` 注入
> （缓解长会话 INP）。本文记录随后已完成的结构性改进。

## 1. 动机：10s 轮询是结构性开销

改造前现状（05 §3 旧契约）：App 层（`packages/renderer/src/App.tsx`）每 10s 对每个 ready
实例拉一次 `workspace.list` + `sessions.list`（经 `fetchInstanceSnapshot`），把
结果投影进 `chamberBridge` publish；每个已挂载 shell 的侧边栏插件订阅同一桥。

开销随使用时间与来源数增长：

1. **每 10s N×RPC**：每个 ready 来源（本地 + 每个远程隧道）两发 unary 调用，即使
   内容毫无变化（A/B/C 已把**渲染**侧去抖，但**网络与反代负载**仍在）。
2. **延迟**：会话列表新鲜度最多滞后一个轮询周期（10s）——壳内新建/归档/拖拽后的
   即时刷新走 `requestRefresh` 通道补丁，但外部（如另一窗口、直接 API）变更要等
   下一个 tick。
3. **N×重渲染在根上**：签名闸已挡住无意义 publish，但"变化才通知"的**推**通道比
   "每 10s 问一次再比对"更符合事件驱动语义，且消灭轮询本身的定时器与请求。

## 2. 机制：各来源 ctx 推投影，轮询降级为兜底

通道基建 = **06 §4 已实现的 tokenized runtime producer 模式**（每来源插件
`registerInstanceRuntimeProducer(sourceId, sourceFingerprint)` 后由 producer `report`，`inject`
订阅 `sessions.list` → 投影 → chamberBridge → App 层
`aggregate-store.ts`）。本次落地沿用并扩展同一通道：侧边栏插件（每来源 shell 各一份，
`inject` 含 `sessions`/`workspaces`）同时订阅 `sessions.list` 与 `workspaces.list`，
把事实投影通道推广为全量快照 producer，不另造订阅机制：

1. **`packages/dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts`**：新增
   generation-safe `registerInstanceSnapshotProducer(sourceId, sourceFingerprint)`（producer
   `report/clear`）/ `onInstanceSnapshot(listener)`
   通道；删除/传输身份编辑时 `retireInstanceProducers(sourceId)` 在异步 dispose 前
   同步撤销两类 token/cache——旧 shell 的迟到 report/cleanup 不会清除或污染同 id
   新来源代的快照。
2. **`packages/dsh-chamber-client-ui-sidebar/src/client/index.ts`** `sync()`：除
   runtime facts 外，把两个 store 经纯函数 `projectInstanceSnapshot` 投影；只有两份
   reconnect baseline 都 idle + ready 才上报；loading/error 即撤回快照、清内容签名
   并恢复兜底，所以相同内容的成功 reconnect baseline 也会重新上报。稳定代完整内容
   签名未变时不上报，subagent 行不进入导航快照。
3. **`packages/renderer/src/App.tsx`**：
   - 合并各来源上报（identity-preserving，复用
     `instanceSnapshotSignature`；publish 继续走 `serversProjectionSignature` 闸）；
   - `pollAggregates` 仅对**无完整生产者**来源（未挂载或重连基线不完整）30s 兜底；
     全部 ready 来源已有生产者时不创建聚合定时器；
   - 每个来源 not-ready → ready 的连接代边沿强制一次 unary；即使生产者因内容签名
     未变而不重复上报，也能恢复断线时被清空的 App 聚合，稳定 ready 代仍为零轮询；
   - 每次推送先递增来源序号，使较旧的在途 unary resolve/reject 均不能覆盖新快照；
   - `onRefresh` 通道保留（动作成功后的即时拉取仍可直接走一次 unary，语义不变）。

## 3. 契约影响（05 §3 需修订）

- 05 §3 现文（`docs/design/05-connection-manager.md`）："控制面不建会话索引、
  不消费宿主帧"（L106-107，主体是控制面）；App 层聚合轮询描述在其 §2.3 数据纪律
  与 §3 App 层写入职责（L168-172，"App 层轮询实例 API 获取每来源快照"）。本方案
  将 §2.3/§3 修订为：**App 层消费各来源 ctx 经 chamberBridge 的投影通道**；REST
  轮询退化为未挂载来源的兜底。
- 每来源推送需在 App 侧节流——`serversProjectionSignature` 闸已覆盖（同内容上报
  不触发 publish），但 App 的 state 更新仍要 identity-preserving（复用 B 批的
  signature 辅助函数）。
- 副作用：侧边栏新鲜度从"≤10s"变为"事件级"；10s 定时器与每来源两发 RPC 消失。

## 4. 风险

- **子 agent 高频生灭**：投影签名必须排除 subagent 起源行（现有 `sync()` 已按
  `origin !== 'subagent'` 过滤签名）——否则每次子 agent 生灭都触发一次上报。
- **未挂载来源的新鲜度**：兜底轮询间隔可放宽（如 30s），接受"未点开的来源列表稍
  旧"；挂载后首个投影立即替换。
- **多来源同时上报**：同渲染周期多份上报经函数式 updater 组合（沿用
  `reconcileCompletedFacts` 的配对纪律），签名闸保证最终只 publish 一次。

## 5. 落地结果

- M1：generation-safe snapshot producer + sessions/workspaces 双 store 完整投影；
- M2：App 合并推投影，旧 pull 失效，30s 兜底只覆盖无完整生产者来源；
- M3：子 agent 行从导航快照排除，同内容签名去重；
- M4：来源状态变化、重连基线失效/恢复、动作后单次刷新均保留；
- M5：纯函数/生产者代际单测、05 契约与 STATUS 同步。

## 6. 非依赖的上游长期方向（本方案不实施、不要求）

以下仅是独立观察，不属于本修复范围，也不是前置条件；chamber 保持上游纯净：

1. **会话列表虚拟化**：`dsh-client-ui-conversation` 的 ChatView 全量渲染
   `order.map(...)` 全部节点（`ChatView.tsx:382`），长会话 DOM/内存无界增长。
   chamber 的缓解是行级 `content-visibility:auto` 注入（纯 CSS，只省渲染不省
   DOM/内存）。上游正解：虚拟滚动或窗口化（`@tanstack/react-virtual` 已在
   trajectory 表用过）。
2. **单前端多数据适配器**：N-ctx 是「N × 完整 dsh 前端」常驻（各自身 cordis ctx、
   双 WS、store、DOM），成本随来源数线性放大。上游若能提供「单前端运行时 +
   每来源数据适配器」，可消除该结构成本——属于上游架构级变更，非 chamber 可改。
