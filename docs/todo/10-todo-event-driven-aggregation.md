# 10 · 侧边栏聚合改事件驱动（todo：设计待评审，实现未排期）

> **状态：todo**——2026-08 前端性能排查（INP 232ms / 长时间运行变卡）后记录的
> **设计级改进**：把 App 层的 10s REST 聚合轮询改为**各来源 ctx 经 chamberBridge
> 推送投影**（轮询退化为未挂载来源的兜底）。本文记录动机、机制、契约影响、风险与
> 分期。**实现未排期**——改动 05 §3 数据契约，需评审确认后实施。
>
> 背景性能修复（**已实现**，见 `docs/progress/STATUS.md` 代码收敛）：shell 销毁时
> cordis ctx 拆除（防僵尸 shell 泄漏）、publish 签名闸 + identity-preserving 状态
> （消除 10s 轮询触发的 N×侧边栏全量重渲染）、会话行 `content-visibility` 注入
> （缓解长会话 INP）。本文是**下一步结构性改进**，不是那批修复的一部分。

## 1. 动机：10s 轮询是结构性开销

现状（05 §3 契约）：App 层（`packages/renderer/src/App.tsx`）每 10s 对每个 ready
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

侧边栏插件（每来源 shell 各一份，`inject` 已含 `sessions`/`workspaces`）**已经**
是 `sessions.list` 的活订阅者（`client/index.ts` 的 `sync()` 订阅了 list store；
workspaces 数据目前来自 App 层 10s 轮询投影，插件侧尚未订阅——本方案的接入点）。
方案是把工作区/会话投影也走这条现成通道：

1. **`packages/dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts`**：新增
   通道 `reportInstanceSnapshot(sourceId, snapshot)` / `onInstanceSnapshot(listener)`
   ——镜像既有 `reportInstanceRuntime` 模式（写入方 = 各来源插件，消费方 = App 层）。
2. **`packages/dsh-chamber-client-ui-sidebar/src/client/index.ts`** `sync()`：除
   runtime facts 外，把 `ctx.sessions.list`（+ 按需补订阅 `ctx.workspaces`）的投影
   （复用 `deriveServerWorkspaces`）经新通道上报；**结构签名**（id 集合 + blank +
   workspace 成员序）未变时不上报（沿用现有签名纪律，防子 agent 生灭高频抖动）。
3. **`packages/renderer/src/App.tsx`**：
   - 新增 `snapshots` state 合并各来源上报（identity-preserving，复用
     `instanceSnapshotSignature`；publish 继续走 `serversProjectionSignature` 闸）；
   - `pollAggregates` 改为**仅对未挂载来源**（未 boot/预热未完成的来源）兜底轮询
     ——stale-while-revalidate 语义，挂载即切换推通道；
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

## 5. 分期

- M1：aggregate-store 新通道 + 插件侧投影上报（纯增量，不动轮询）；
- M2：App 合并推投影 + 轮询降级为未挂载来源兜底（契约修订，05 §3）；
- M3：验证与压测（多来源 + 子 agent 高频场景下的 publish 次数、侧边栏重渲染次数、
  网络请求数对比）。

## 6. 上游诉求（chamber 不可改，记录待提交上游）

性能排查（2026-08）确认的两个**结构性**瓶颈在 vendor（上游 dsh 前端）侧，chamber
只能缓解（见 `docs/progress/STATUS.md`「2026-08 性能排查」）：

1. **会话列表虚拟化**：`dsh-client-ui-conversation` 的 ChatView 全量渲染
   `order.map(...)` 全部节点（`ChatView.tsx:382`），长会话 DOM/内存无界增长。
   chamber 的缓解是行级 `content-visibility:auto` 注入（纯 CSS，只省渲染不省
   DOM/内存）。上游正解：虚拟滚动或窗口化（`@tanstack/react-virtual` 已在
   trajectory 表用过）。
2. **单前端多数据适配器**：N-ctx 是「N × 完整 dsh 前端」常驻（各自身 cordis ctx、
   双 WS、store、DOM），成本随来源数线性放大。上游若能提供「单前端运行时 +
   每来源数据适配器」，可消除该结构成本——属于上游架构级变更，非 chamber 可改。

