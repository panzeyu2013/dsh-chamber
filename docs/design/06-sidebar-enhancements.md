# 06 · 侧边栏增强（第三轮：搜索 / 拖拽排序 / 视图持久化 / 运行时事实通道）

> 本设计将 05 §9 中 1/3/5/6/7 项落地为 v1 形态；第 2 项（fork）
> 经调研确认已被官方 conversation 回合尾部分支动作（ui-conversation turn-tail
> forkAt）覆盖，侧边栏不做；第 4 项（flat）与第 8 项（当前空白会话"新会话"
> 行）维持推迟。本文档 + 05 为实现契约。

## 0. 范围与来源

| 项 | 特性 | 状态 |
|---|---|---|
| 1 | 会话搜索（每来源） | 已落地 |
| 3 | 会话/workspace 拖拽排序（来源内） | 已落地 |
| 5 | 视图偏好 localStorage 持久化 | 已落地 |
| 6 | 完成/待交互状态点（dot） | 已落地 |
| 7 | 跨来源当前会话高亮 | 已落地 |
| 2 | fork 会话 | **已覆盖**：官方 conversation 回合尾部分支（ui-conversation turn-tail，`forkAt(atSeq, increaseTitle)` → `sessions.fork` → 打开子会话），chamber boot 图内常驻；侧边栏行内不做 |
| 4 | flat 单列表模式 | 推迟：与 05 §2.1"仅按来源分类"呈现原则张力 |
| 8 | 当前空白会话"新会话"行 | 推迟：05 §2.1 已声明空白会话不入列表 |

约束沿 05 §2.2/§9：不发明协议（只用 wire 既有方法）、不做跨来源移动
（拖拽按来源在代码层阻断）、运行时事实只经通道投影（控制面/App 不持有
会话权威）。

## 1. 会话搜索（每来源）

### 1.1 Wire 契约（零新增）

- `sessions.search { query }` → `{ items: SessionSearchItem[], hasMore }`；
  `SessionSearchItem = { sessionId, snippet }`（≤240 码点）；query 需 trim、
  非空、≤500 字符、无 `\0`（schema 校验）；结果 ≤20 条
  （`SESSION_SEARCH_RESULT_LIMIT`，经 `dsh-client-connection/client` api.ts
  再导出）；`hasMore` 提示用户缩小范围；AbortSignal 必传（30s 超时合并）。
- 标题/workspace 标签**不上 wire**——由客户端从该来源的聚合快照解析
  （投影已携带 per-session title；workspace 标题或未分组标签兜底）。
- 生成的 unary client 已含 `client.sessions.search({query}, signal)`
  （dsh-host-apiproxy fetch/client.ts），无需发明 wire。

### 1.2 UI 设计

- **位置**：每来源分组头内搜索图标按钮（`sourceHeader` 内、状态徽标旁），
  点击展开为头下新行（胶囊式 input + 清除按钮），wide 态专属（rail 不做）。
- **状态**（SidebarRoot 内按 sourceId 分键）：
  `searchExpanded: Record<sourceId, boolean>`、
  `searchQuery: Record<sourceId, string>`、
  `searchRemote: Record<sourceId, { query, status: 'idle'|'loading'|'ready'|'error', items, hasMore }>`。
- **流程**：输入 → sanitize（去 `\0`、500 UTF-16 截断、trim）→ 空则回 idle；
  非空则建 `AbortController` → 250ms 防抖 → `searchSessions(client, query, signal)`
  → 未中止则提交 ready/error。Escape 清空并收起；outside-click 仅在 query
  为空时收起（官方语义）。
- **结果渲染**：query 非空时该来源的 `workspaceList` 整体替换为结果列表
  （来源头与状态保留；折叠入口隐藏）。行 = 标题（聚合解析，
  缺失兜底"未命名会话"）+ snippet 行；点击 → `chamberBridge.requestOpenSession`。
  状态行：loading → `search.pending`；error → `search.unavailable` 横幅；
  空 → `search.noMatches`；`hasMore` → `search.hasMore`（n=20 取常量）。
- **取舍**：聚合拉取失败（`aggregateError`）的来源隐藏搜索入口（标题无法
  解析，且与"错误行替换列表"一致）；结果标题可能滞后于最新快照
  （10s 轮询窗口内新建会话显示兜底名，下轮轮询修正，可接受）。

### 1.3 代码落点

- `shared/instance-api.ts`：`searchSessions(client, query, signal)` 包装
  （信号透传——现有 helper 不带 signal，需独立实现；复用 `resultError`）。
- `SidebarRoot.tsx` + `sidebar-chamber.module.css` + `locales.ts`
  （`search.*` 键 zh/en 八组）。
- `renderer/vendor-modules.d.ts`：ambient 镜像补新导出。

## 2. 拖拽排序（来源内）

### 2.1 Wire 契约

- `workspace.insertSessionBefore { workspaceId, sessionId, beforeSessionId? }`
  → 完整新 `WorkspaceView`；**省略 anchor = 追加到末尾**（null 非法，
  须 omit key）；校验成员资格（`workspace-move-invalid`/`workspace-not-found`）；
  位置未变/自身为 anchor → 无写入。写入后 `workspace.list` 即新序。
- `workspace.insertBefore { workspaceId, beforeWorkspaceId? }` → 完整显示序
  `workspaceIds[]`；省略 anchor = 追加末尾。
- 生成的 unary client 均已含两方法。

### 2.2 交互（镜像官方 HTML5 DnD）

- **可拖**：真实 workspace 组内会话行、未分组桶内会话行、真实 workspace
  分组头。**不可拖**：未分组桶（无 wire 身份）、跨来源（代码层阻断：
  `active = drag.sourceId === group.sourceId && drag.accountKey === group.key`）。
- **机制**：`draggable` 属性 + HTML5 DnD 事件；拖起时 document 级
  dragover/drop preventDefault（官方 `useNativeDragAcceptance` 移植）——
  拖出列表外不表现为拒绝；行半区（上/下半）即 marker 词汇
  （`rowHalf`：clientY 与行中线比较）。
- **状态机**（SidebarRoot 本地）：
  `SessionDragState { sourceId, accountKey, sessionId, over: { id, half } | null }`、
  `WorkspaceDragState { sourceId, workspaceId, over }`。
  同一账号组内 hover 行渲染 marker（`dropBefore`/`dropAfter` 2px 指示线）；
  drop/end 提交最后 marker。
- **提交算法**：目标行 `anchor = half==='before' ? over.id : nextId`
  （undefined = 末尾）；no-op 守卫（anchor===自身、位置未变）；乐观重排 +
  wire 调用 + 成功 `requestRefresh(sourceId)`；失败 inline `rowErrors`
  （下次拉取自愈，无需回滚机制——pull 模型天然收敛）。
- **未分组桶**：仅本地序（wire 无对应方法），提交后写入视图持久化模块
  （§3）的 `ungroupedOrder[sourceId]`。
- **workspace 拖拽**：`insertBefore` + `requestRefresh`，同样 no-op 守卫与
  inline 失败；列表首界渲染 drop 指示线。
- **边界**：拖到折叠组无目标行（自然无 marker）；轮询刷新中途拖拽
  （状态引用 id 不引用下标，行仍存在则有效）；touch/键盘排序不支持
  （官方亦然，注明已知限制）。

### 2.3 代码落点

- `SidebarRoot.tsx`：拖拽状态 + 事件 + marker 渲染；渲染期按
  `reconciledSessionOrder`（§3 纯函数）对未分组会话排序。
- `sidebar-chamber.module.css`：marker/指示线类。
- `shared/derive.ts`：新增纯函数 `reconciledSessionOrder(stored, wireIds)`
  （stored 序优先、未知 id 按 wire 序追加——官方 `reconciledSessionOrder`/
  `orderedUngrouped` 移植），`test/derive.ts` 补用例。

## 3. 视图偏好持久化

### 3.1 存储形状

- 单键 `dsh-chamber.sidebar.v1`（整页共享 localStorage；所有实例 ctx 共读
  共写，值幂等，last-writer-wins 无害）：
  ```ts
  { v: 1,
    folded: Record<`${sourceId}/${workspaceId}`, boolean>,
    ungroupedOrder: Record<sourceId, string[]> }
  ```
- 新建 `shared/view-prefs.ts`：`loadViewPrefs()`/`saveViewPrefs(prefs)`，
  JSON 解析/写入 try/catch 兜底（非致命）、版本号不匹配即弃用重播种
  （官方 persist 引擎纪律）；纯函数，可单测。
- 折叠状态改为：mount 时读取一次 + 变化时写回（现 `folded` 会话级
  state 键形不变，仅加持久化）；跨 ctx 实时联动**不做**（刷新/重开
  生效即可，注明）。

### 3.2 未分组序

- `ungroupedOrder[sourceId]` 由 §2 拖拽提交写入；渲染期 `reconciledSessionOrder`
  应用（stored 优先 + 新游离按 recency 追加）；下次聚合拉取时按成员
  修剪（跳未知 id）。

### 3.3 代码落点

- `shared/view-prefs.ts`（新）+ `shared/index.ts` 再导出；`SidebarRoot.tsx`
  读写；`test/view-prefs.ts` 或并入 derive 测试（node:test 风格）。

## 4. 运行时事实通道（完成/待交互点 + 跨来源当前会话高亮）

### 4.1 事实来源（每 ctx 运行时）

- `ctx.sessions.list`（ObservableSnapshot）行字段：`running`、`completed?`、
  `pendingInteraction?: 'approval'|'plan-review'|'question'`、`blank`、
  `updatedAt`；快照含 `current?: string`（当前会话 id）。
- 每个实例 boot = 独立 ctx、独立 store；侧边栏插件在每个 ctx 都挂载，
  即每个来源都有一个可订阅自身运行时的事实生产者。

### 4.2 通道 API（chamberBridge 扩展）

```ts
export interface InstanceRuntimeReport {
  current?: string
  sessions: Record<sessionId, { completed?: boolean; pending?: 'approval'|'plan-review'|'question' }>
}
reportInstanceRuntime(sourceId: string, report: InstanceRuntimeReport): void
clearInstanceRuntime(sourceId: string): void
onRuntimeReport(listener: (sourceId: string, report: InstanceRuntimeReport | undefined) => void): () => void
```

- 每 ctx 插件 apply 内新增 effect：订阅 `ctx.sessions.list`，订阅后立即
  上报一次当前快照（zustand subscribe 不即时触发），其后每次变更上报
  投影（`{ current, sessions: { id: { completed, pending } } }`）；
  effect 清理时 `clearInstanceRuntime`。
- App 侧：`runtimeFacts: Record<sourceId, InstanceRuntimeReport | undefined>`
  state；`deriveServers` 合并为 `ChamberServerAggregate.runtime?`（仅附加，
  不覆盖 polled 字段）；`pollAggregates` 的 not-connected 分支清空该来源
  事实（断连即清，含 completed——generation 级事实本应随断连失效）。

### 4.3 UI 语义（状态指示）

- 行尾为**固定 10px 状态槽**（非常驻身份点——来源身份由来源头圆点承担）：
  - 常态（不运行、未完成）：空槽，不显示任何图标（槽保留宽度，
    行右缘跨行对齐）；
  - 运行中：官方 `StateDot` **ongoing 圆环**
    （`--dsw-static-deepseek-450` 蓝色 chase ring）；
  - 运行结束未读（completed）：**长显示圆点**（持久蓝色点，tooltip
    "已完成"）。
  - **待交互（pending，2026-08 修订）**：不再与运行中同形——槽加宽至
    14px，按类型渲染**可辨识图标徽标**（会话在等用户，必须一眼可辨，
    ask-user 是动机场景）：`question` = 问号图标（business 蓝）、
    `plan-review` = 清单图标（business 蓝）、`approval` = 警示三角图标
    （warn 琥珀）。tooltip/aria 文案沿用
    `status.waitingAnswer/planReview/waitingApproval`。
  - **配色（2026-08 修订）**：运行/completed 仍统一为 dsh 标准 ongoing
    蓝；**pending 徽标例外**——business（蓝）/warn（琥珀）两个 state
    token 表达"等待回答/决策"与"等待批准"两级语义（06 §4.3 早前"全蓝"
    决定对 pending 行有意撤回）。wire running 与通道事实并存：running 点
    保留（wire 权威），completed/pending 仅通道提供。
- **悬停替换（真正替换，零占位）**：行/头操作在静止时 `display:none`（不占
  布局空间）——状态图标/徽标因此真正位于行/头末端；悬停时操作簇
  `display:inline-flex` 换入、状态槽 `display:none` 换出（session 行：
  状态环 ↔ kebab+归档；来源头：连接状态 ↔ 搜索 + 新建工作区 `+`；
  workspace：会话数徽标 ↔ `+` + kebab）。胶囊展开/菜单展开时操作簇保持
  显示（`.sourceActionsVisible`/`.rowActionsVisible`，`:has` 同步换出
  状态槽）。
- **不再显示相对时间**：session 行不渲染"xx 前"时间单元格（`time.*`
  locale 键移除；`relativeTimeBucket` 纯函数保留为共享工具）。
- **当前会话高亮 = 全局单选（2026-08 修订）**：`server.runtime?.current`
  命中即高亮，但仅限**拥有当前可见 ctx 的来源**（渲染侧
  `server.id === chamberInstanceId` 门控）——各来源壳内"切换前最后一个"
  会话不再全部高亮，全局只有一个高亮（正在查看的那个会话）。
  （语义演进：第二轮"仅自身来源 useSyncExternalStore" → 第三轮"全来源
  高亮" → 本轮收敛为全局单选；通道机制不变——组件不再直连 store，
  订阅逻辑在插件 apply 上报端；boot 首帧无上报前不高亮，随首次上报
  补齐。跨来源的 pending/completed 状态点不受影响，仍全来源呈现。）

### 4.4 代码落点

- `shared/aggregate-store.ts`（通道 + `ChamberServerAggregate.runtime?`）、
  `client/index.ts`（订阅与上报）、`App.tsx`（state + 合并 + 清理）、
  `SidebarRoot.tsx` + `sidebar-chamber.module.css`（dot 状态类 + 高亮）、
  `locales.ts`（`status.waitingApproval/planReview/waitingAnswer/completed`）。

## 5. 已知取舍与开放项（已决）

- 跨实例 `dsh.sessions.current` localStorage 共享键（last-writer-wins）：
  接受——镜像运行时既有行为，通道原样携带。
- 结果标题滞后 / 聚合错误源隐藏搜索 / rail 无搜索：接受（§1.2）。
- 拖拽无 touch/键盘：已知限制（官方亦然，Electron 桌面）。
- 折叠与未分组序不跨 ctx 实时联动：刷新生效，接受。
- 拖拽乐观重排不设回滚：pull 模型自愈 + inline 错误，接受。

## 6. 验证计划

- 纯函数单测：`reconciledSessionOrder`、`view-prefs` 读写、搜索 sanitize
  （并入 `test/derive.ts` 或新增 test 文件，node:test 风格）。
- `pnpm run typecheck`、`pnpm run build:renderer`、`pnpm run verify:i18n`
  全绿；control-plane 套件不回退。
- 实机：拖拽持久化跨重启（真实 workspace 序经 wire、未分组序经
  localStorage）；搜索命中/abort/错误横幅；另一来源会话运行/完成/
  待交互点在本地来源的侧边栏正确呈现（真机 SSH 隧道验证）。

## 7. 样式定稿（设计）

- **Token 契约**：以 dsh 设计平台 token 为准——状态色
  `--dsw-alias-state-{success,warn,error,business}-primary`（completed 点 /
  connected 徽标、pending 点、错误文本）、运行中点 `--dsw-static-deepseek-450`
  （running 蓝）、搜索胶囊 focus 边框 `--dsw-alias-brand-primary`、折叠
  chevron `--dsw-alias-label-caption`、来源头底色 `--dsw-specific-sidebar-fill`；
  不存在的 `--dsw-alias-accent/success/danger/input-fill` 一律不得使用。
- **来源 accent**：每元素 `--dsh-source-accent` CSS 变量承载远程来源 hue
  （`hsl(hue 65% 52%)`），本地来源省略、回退默认 ink；用于来源头激活左
  内边线、rail 活动环与当前会话所在 workspace 组的折叠 chevron 标记。
- **当前会话高亮（对齐官方 selected 处理）**：session 行 = 官方
  `.sessionRow.selected` 的浅 `interactive-bg-hover` 色调（无 inset 阴影、
  无深色调、无标题加粗）；所在 workspace 组 = 无底色，折叠 chevron 取
  来源 accent（镜像官方 project 行 folderActive 品牌色文件夹图标）——
  两组高亮永不相邻融合，色调全为官方 token 浅档。
- **排版**：字号下限 12px；会话标题 13/18——官方行 14px，13/18 是 chamber
  多来源密度的刻意折中；来源身份点 8px（仅来源头/rail），session 行首为
  固定 10px 状态槽（常态空）。
- **行几何**：圆角 8px（来源头/workspace 头/会话行一致）；密度为多来源
  列表的有意取舍。
- **搜索胶囊**（§1）：`border-l2` 边框 + `:focus-within` brand 边框；30s
  调用方 abort；per-source 任务隔离（一个来源击键不重启其他来源在途搜索）；
  结果分支优先于 aggregateError；`maxLength` 取共享常量
  `SEARCH_QUERY_MAX_CODE_UNITS`。
- **未连接来源呈现**：搜索入口按 `connected` 门控；状态徽标 = 色点/转圈
  （ready 绿点、error/stopped 红点、idle/unknown 灰点、
  connecting/starting/restarting/degraded 统一转圈——重试周期折叠为一个
  稳定「重连中」态，主界面绝不因每次重试尝试在转圈/色点间闪烁；相位文本
  只在 hover/aria，无恒显文字、无状态文案——状态一律纯图标，原因/细节在
  连接设置页；状态槽居来源头右端，hover 时被搜索/`+` 簇替换显示）；全部
  断开时保留各来源分组、空态提示为列表底部一行；
  断连即清空该来源搜索状态（重连从干净状态开始）。
- **行内操作（图标化 + 悬停替换）**：workspace 组头 = `+`（新建会话）+
  三点竖排 kebab 菜单（重命名/删除，`Menu` primitive portal 模式），
  悬停时替换会话数徽标；session 行 = 三点 kebab 菜单（重命名）+ 独立归档
  图标按钮（悬停替换行尾状态槽；**session 不显示相对时间**）；**新建工作区**
  = 来源头部 `+`（与搜索图标
  并排成簇，悬停替换连接状态槽，胶囊展开时簇保持可见；文案只在
  aria/title，无列表行）。替换为真正 display 交换（静止不占位，状态图标
  真正居行/头末尾）。kebab
  展开期间该行操作保持可见（`.rowActionsVisible`）。行内图标按钮全量
  reset（`appearance:none`/`outline:none`/grid 居中，focus-visible 用
  brand 自绘环）——无 UA 外框、无偏移。
- **会话状态指示（2026-08 修订）**：固定 10px 行尾状态槽——常态空、
  运行中 = 官方 `StateDot` ongoing 蓝圆环、运行结束未读 = 持久蓝圆点；
  **待交互（pending）= 14px 图标徽标**（问号/清单/警示三角，见 §4.3），
  配色 business（蓝）/warn（琥珀）两级；运行与 completed 颜色一律
  `--dsw-static-deepseek-450`，pending 徽标用
  `--dsw-alias-state-{business,warn}-primary`（不再有 green/red 状态色）；
  状态槽非身份标记（来源身份由来源头圆点承担）。
- **当前会话高亮（含 workspace 组标记）**：session 行 = 官方 selected 的
  浅 hover 色调（无阴影无加粗）；workspace 组 = 折叠 chevron 取来源
  accent（镜像官方 folderActive）——无底色融合、无深色调。
- **嵌套缩进（收紧）**：workspace 列表距来源头 10+1+6 = 17px；session 行
  左 padding 26px——session 标题相对 workspace 标题（24px）深 18px，
  server→session 标题级联 ~59px（原 73px）；会话级重命名表单与错误行
  同缩进。
- **拖拽鲁棒性**：行内控件（kebab/归档/`+`/折叠/搜索/来源头激活）复用
  `suppressClickRef` 抑制拖拽结束后的尾随 click（拖到按钮上不会误触发
  确认弹窗/菜单/建会话/切视图）；`rowHalf` 对零高行防御；chamber 列表
  区域包一层 `ChamberListBoundary`——意外渲染错误只让列表区显示错误
  文本，绝不带走整个 shell（应用级 ErrorBoundary 不再触发）。
