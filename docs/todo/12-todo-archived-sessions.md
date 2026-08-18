# 12 · 已归档会话管理（todo：设计待评审，实现未排期）

> **状态：todo**——2026-08 用户报告「归档会话无法清除、前端也看不到」后记录。
> 代码核实（dsh 上游 + chamber 双端）确认：**归档在 dsh 是单向且不可见的**——
> 唯一的 wire 方法 `workspace.archiveSession` 只把 id 追加进 registry-global
> 集合；所有表面（官方 ui-workspace 与 chamber 侧边栏）都过滤归档行；上游没有
> unarchive / 删除会话 / 归档可见查询，且注释自述 unarchive 是 "a future" 能力。
> 本文记录调研结论（OpenCode/OpenChamber 成熟范式）、方案决策（A 前端浏览区先行、
> C 上游 wire 根治、B 特权层冻结）与契约影响。**实现未排期**——A 落地改动 05 §3
> 桥契约（增量字段），需评审确认。

## 1. 背景与根因（代码核实）

用户报告：所有已归档的 session 无法清除，且前端看不到。

- **归档单向**：宿主 `WorkspaceRegistry.archiveSession`（`deepseek-harness/
  packages/workspace/workspace/src/index.ts` L244-255）只做「追加进
  `archivedSessionIds` + 幂等去重」，无反向操作；宿主 wire（`api-proxy.ts`
  workspace 处理器）只有 `archiveSession`，无 unarchive/delete-session；整个
  rpc-map 无会话删除方法。上游注释 `api/workspace.ts` L102 自述 unarchive 是
  "a future unarchive restores its position"——**上游缺口，不是 chamber bug**。
- **归档不可见**：官方 `ui-workspace/src/client/tree.ts` L118-120 `sessionVisible`
  与 chamber `packages/dsh-chamber-client-ui-sidebar/src/shared/derive.ts` L346-354
  同规则：`!archived.has(id)`；workspace 分组、未分组桶、搜索全部排除。归档行从
  App 层投影起就被丢弃（`ChamberServerAggregate` 无 archived 字段，05 §3）。
- **数据未丢**：`sessions.list`（`listVisibleSessionSummaries`）与宿主
  `sessions.search`（api-proxy.ts L2040-2110，授权集 = 可见摘要，不按归档过滤）
  都返回归档会话；chamber 聚合已拉到 `archivedSessionIds`（`instance-api.ts`
  L283-285），只是投影丢弃。归档集合持久化于 workspace 域全局态
  （`<DSH_HOME>/profiles/web/**/workspace.json` 的 `global.archivedSessionIds`）。

## 2. 调研：成熟 harness（OpenCode/OpenChamber）范式

本机 OpenChamber 源码（`/Users/panzeyu2013/Desktop/code/develop/OpenChamber`）核实：

- **OpenCode（harness 层，`@opencode-ai/sdk/v2`）**：会话记录带 `time.archived`
  时间戳（可逆标志）；`session.list` 支持 `archived` 查询标志（同时包含归档）；
  `session.update({ time: { archived } })` 归档/取消归档（取消 = 0）；`session.delete`
  服务端**永久删除**（级联子会话 + 删目录）。
- **OpenChamber（manager 层）只消费 harness API，从不自己动 harness 文件**：
  `ArchiveView.tsx` 独立归档页（目录过滤侧栏 + 全量搜索 + 每行恢复/删除 +
  分批加载 PAGE_SIZE=100）；侧边栏批量 archive/unarchive/delete
  （`useSidebarBulkActions`）；确认对话框（含子任务计数）；
  `SessionRetentionSettings`（默认动作 = 归档 or 删除）。动作实现全走
  `OpencodeService`（`packages/ui/src/lib/opencode/client.ts` L581-633）的
  `session.list/update/delete`。
- **结论**：范式 = **harness 提供可逆归档 + 删除 + 归档可见的查询，manager 只做
  UI 与编排**。dsh 三项全缺，chamber 无法只靠前端补全。

## 3. 方案决策

| 路径 | 内容 | 能做什么 | 状态 |
|---|---|---|---|
| **A** | chamber 前端「已归档」浏览区（桥契约增量 + derive + 侧边栏组） | 列出/打开/重命名/搜索归档会话 | **可做（本文设计）**，不动 05 §2.2 红线 |
| **C** | 上游补 wire：`workspace.unarchiveSession` + `sessions.delete` + 归档可见查询（对齐 OpenCode） | 取消归档/永久删除 | 根治方向；上游外部仓库不可改，本文产出契约草案 |
| **B** | 控制面/主进程特权层直接清（编辑 `workspace.json` / 删会话目录） | 现在就能真正清除 | **冻结**：违反 05 §2.2「wire 缺失的方法不做（如删除会话），不发明协议」、AGENTS.md「会话业务是 dsh 前端运行时的事」、2026-08-14 收敛移出项（P3 纪律不回流）；且 OpenChamber 的「服务端动作」只是转发 harness 已有 API，不自己动文件 |

推荐：**A 先行（解决「看不到」，为 C 铺 UI 底座）+ C 设计稿（本文 §5 草案）**；
B 除非用户明确拍板改契约，否则不做。

## 4. chamber 侧设计（A：已归档浏览区）

### 4.1 桥契约扩展（05 §3 增量，需评审）

`ChamberServerAggregate` 新增每来源已归档桶（最小投影，不破坏现有字段）：

```ts
interface ChamberServerAggregate {
  // …既有字段不变…
  archived?: { id: string; title: string; workspaceId?: string; updatedAt: number }[]
}
```

- 归档行按 workspace 归属投影（无归属 → 未分组），仅含 id/title/updatedAt——
  与现有可见行投影（`ChamberServerWorkspace.sessions`）同构，标题复用
  `sessions.list` 行内 title 投影（chamber 聚合本就按行取标题，见
  `instance-api.ts`）。
- App 层 `deriveServers`（`packages/renderer/src/App.tsx`）不再丢弃归档行，
  改投进 `archived` 桶；`instanceSnapshotSignature` / `serversProjectionSignature`
  计入该桶（归档动作后 requestRefresh 走既有即时刷新通道）。
- 定夺点：桶形态取「每来源一个平铺桶（含 workspaceId）」还是「workspace 下
  嵌套已归档子组」。前者渲染灵活（可独立视图/分组折叠），推荐前者。

### 4.2 derive（`shared/derive.ts`）

- 新增纯函数把归档行投影为 4.1 桶（`deriveArchivedRows`，单测覆盖）；
- 搜索：本地标题匹配允许命中归档桶（现有 `deriveLocalSearchMatches` 排除
  归档——归档视图用独立查询或参数放开）；远程内容搜索**直接复用**
  `sessions.search`（宿主不排除归档，官方过滤在客户端 derive——chamber 侧
  归档视图不过滤即可，已核实 api-proxy.ts L2040-2110）。
- blank / subagent 起源行不投影（沿用官方规则）。

### 4.3 侧边栏 UI（`packages/dsh-chamber-client-ui-sidebar`）

- 呈现：每来源组尾新增「已归档」组头（计数徽标，折叠态复用 `view-prefs` 共享
  实时存储，06 §3）；或来源头 hover 簇新增「查看已归档」入口进入独立视图
  （OpenChamber ArchiveView 式：目录/来源过滤 + 搜索 + 分批加载）。推荐后者
  （列表密度高、不与来源主列表混排；PAGE_SIZE=100 防长列表卡顿，呼应 06/10
  记录的上游虚拟化诉求）。
- 行动作（v1 最小集，走该来源自己的 API，05 §2.2 纪律）：
  - 打开：`chamberBridge.requestOpenSession(sourceId, sessionId)`（归档会话
    `sessions.open` 有效，host 不拦截）；
  - 重命名：`session.rename`（行内 rename 复用现有 commitRename 流）；
  - 搜索：本地标题 + 远程内容（4.2）；
  - **不做**：恢复/删除（等 C 的 wire 落地后补按钮 + 确认对话框，对齐
    OpenChamber）。
- locales：新增 `section.archived` / `action.restore` / `confirm.deleteSession`
  等键（en/zh 双语言，`verify:i18n` 纪律）。

### 4.4 契约/交互细节

- 排序：dsh 归档集合无时间戳（registry set 无序）→ 归档桶按 `updatedAt` 降序
  （wire 序不可得），与 OpenChamber 按 `time.archived` 排序的语义近似。
- 打开归档会话后 current 高亮：沿用既有 `server.runtime?.current` 通道，无需
  特殊处理；官方 workspaces service 对「当前会话被归档」会清除 selection
  （`workspaces/service.ts` L342）——chamber 跟随投影即可，不重复实现。
- 断连来源：归档桶随聚合快照走同一生命周期（未连接来源无数据，只有分组头）。

## 5. 上游 wire 契约草案（C：根治，对齐 OpenCode 模型）

> 上游 = `deepseek-harness`（外部仓库，chamber 不可改；wire 契约以 vendor
> `dsh-client-modules/src/client/manifest.ts` 为权威，落地前需复查）。本文只
> 记录请求草案，供上游实现或后续 chamber 跟随。

1. **`workspace.unarchiveSession({ sessionId })`** → `{ archivedSessionIds }`：
   与 `archiveSession` 完全对称；host `WorkspaceRegistry` 从集合移除（幂等）；
   复用既有 `host/archived-sessions-changed` 事件（集合变化即发）与
   `workspace.list.archivedSessionIds` 投影，客户端零新协议。
2. **`sessions.delete({ sessionId })`**（或 `workspace.deleteSession`）：
   服务端删会话目录（`<sessions-root>/<project>/<id>/`，format.ts 布局）+
   级联 subagent 起源子会话 + workspace 成员账目自愈（header 索引重建即剔除
   已删 id）+ 从 archived 集合清理；复用 `host/session-removed` 事件（现由
   `session/disposed` 驱动）。
3. **归档可见查询（可选）**：`sessions.list` 行加 `archived` 标志字段或
   `archived` 查询参数（对齐 OpenCode `time.archived` 模型）。若采用 registry
   set 形态（保持现状），仅补 1+2 即可让 chamber 的 A 区补上恢复/删除——
   最小改动优先。

## 6. 风险

- **B 的内存覆盖**：运行中宿主在内存持有域全局态，特权层直接编辑
  `workspace.json` 会被宿主下一次 `setState` 覆盖 → B 必须停宿主操作，且与
  05/AGENTS 契约冲突（§3 已冻结）。
- **删除级联语义**：dsh 子会话（`origin === 'subagent'`）与父会话目录布局、
  workspace `sessionIds` 账目引用——上游实现需确认级联与账目清理；chamber
  只消费结果，不发明。
- **归档桶性能**：长归档列表不虚拟化（既有上游虚拟化诉求，todo 10 §6）——
  分批渲染兜底；归档桶计入投影签名，避免 10s 轮询触发无意义 publish（沿用
  2026-08 性能批的签名闸）。
- **契约漂移**：A 落地需同步修订 05 §3（桥形状）、05 §2.2（交互表新增已归档
  区）、06（若入视图偏好）；STATUS.md 更新。

## 7. 分期

- **M1（chamber，纯增量）**：桥契约 `archived` 桶 + `deriveArchivedRows` +
  侧边栏已归档视图（列出/打开/重命名/本地标题搜索）；单测
  （derive 可见性/分组/签名/搜索）+ `typecheck:sidebar` / `test:sidebar` /
  `build:renderer` / `verify:i18n`。
- **M2（chamber）**：远程内容搜索放开归档命中 + 分批渲染 + 折叠偏好接入
  view-prefs。
- **M3（上游 C 落地后）**：A 区补「恢复 / 删除」按钮 + 确认对话框（含子会话
  计数，对齐 OpenChamber ConfirmDialogs）；wire 以 vendor manifest 复查。
- **B（冻结）**：除非用户明确拍板范围变更并经设计评审，否则不实施。

## 8. 验证

- 单测：`deriveArchivedRows`（归档行按 workspace 归属/未分组、blank/subagent
  排除、签名计入）、搜索命中归档、桥契约类型。
- 实机：归档 → 出现在已归档视图 → 打开/重命名/搜索命中；断连来源归档桶随
  聚合生命周期；C 落地后恢复/删除端到端（含当前会话被删除的 selection 回退）。
