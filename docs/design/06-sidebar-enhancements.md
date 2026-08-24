# 06 · 侧边栏增强（第三轮：搜索 / 拖拽排序 / 视图持久化 / 运行时事实通道）

> 本设计将 05 §9 中 1/3/5/6/7 项落地为 v1 形态；第 2 项（fork）
> 已由官方 conversation 回合尾部分支动作（ui-conversation turn-tail
> forkAt）覆盖（会话内），且 2026-08 起侧边栏会话行菜单也提供行内 fork
> （wire `sessions.fork`，对齐官方 ui-workspace；两者并存，turn-tail 保留）；
> 第 4 项（flat）维持推迟。
> 本文档 + 05 为实现契约。

> **状态：已实现（2026-08）**——实现记录与验证见 `docs/progress/STATUS.md`
> （design 06 条目）；未落地项（flat）维持推迟。

## 0. 范围与来源

| 项 | 特性 | 状态 |
|---|---|---|
| 1 | 会话搜索（每来源） | 已落地（2026-08 扩展：本地元数据匹配 + 远程内容命中合并，本地优先、远程按投影可见集过滤） |
| 3 | 会话/workspace 拖拽排序（来源内） | 已落地（2026-08：会话排序切换 manual↔updated；updated 下拖拽只写瞬态 override 不落 wire） |
| 5 | 视图偏好 localStorage 持久化 | 已落地 |
| 6 | 完成/待交互状态点（dot） | 已落地 |
| 7 | 跨来源当前会话高亮 | 已落地 |
| 2 | fork 会话 | **已实现（侧边栏行内，2026-08）**：会话行 kebab 菜单分叉会话（`sessions.fork` + increaseTitle → 打开子会话，对齐官方 ui-workspace；fork 成功后子会话标题递增 rename（对齐官方 increasedForkTitle，rename 失败非致命——子会话仍创建并打开）；官方 turn-tail `forkAt` 仍常驻可用，两者并存） |
| 4 | flat 单列表模式 | 推迟：与 05 §2.1"仅按来源分类"呈现原则张力 |

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
- **本地元数据匹配（2026-08 扩展）**：本地腿对投影**可见集**做标题/所属
  workspace 标题**子串匹配**（大小写不敏感；archived/subagent/blank 行不
  进入投影故不可能命中），命中按 recency 排序（纯函数
  `deriveLocalSearchMatches`）；远程腿 = wire `sessions.search` 内容命中，
  **按投影可见集过滤**（投影之外的 archived/subagent/blank 会话不进入
  结果，对齐官方 deriveSearchResults）。合并（`mergeSearchResults`）：本地
  优先（保持 recency 序）→ 远程未覆盖行按后端序追加，跨腿/腿内去重；同
  会话双命中补远程 snippet（本地行 snippet 为空）。
- 生成的 unary client 已含 `client.sessions.search({query}, signal)`
  （dsh-host-apiproxy fetch/client.ts），无需发明 wire。

### 1.2 UI 设计

- **位置**：每来源分组头内搜索图标按钮（`sourceHeader` 内、状态徽标旁），
  点击展开为头下新行（胶囊式 input + 清除按钮），wide 态专属（rail 不做）。
- **状态（2026-08 修订——共享控制器）**：每来源搜索状态与防抖 job 整体
  移入 `shared/search-state.ts` 共享单例（vite shared chunk，所有 ctx 的
  侧边栏同一实例）——`expandSearch`/`collapseSearch`/`setSearchQuery`/
  `clearSearch`/`getSearchStates`/`subscribeSearch`；组件只镜像渲染 + 持有
  DOM ref（outside-click 包含判定与 focus）。取代早前「按 sourceId 分键的
  per-shell state + 组件内 job effect」：任一来源侧边栏发起的搜索在视图
  切换后仍存活（可见侧边栏换 shell，共享状态不换）；job 单一所有者，杜绝
  N 个 shell 对同一查询重复发起/互相中止（P2-6 语义原样保留：单来源击键
  不打扰其他来源在途搜索、30s 超时与「被替换」区分）。
- **流程**：输入 → sanitize（去 `\0`、500 UTF-16 截断、trim）→ 空则回 idle；
  非空则建 `AbortController` → 250ms 防抖 → `searchSessions(client, query, signal)`
  → 未中止则提交 ready/error。Escape 清空并收起；outside-click 仅在 query
  为空时收起（官方语义）。断连来源的搜索状态被裁剪（重连从干净收起态开始）。
- **结果渲染**：query 非空时该来源的 `workspaceList` 整体替换为结果列表
  （来源头与状态保留；折叠入口隐藏）。行 = 标题（聚合解析，
  缺失兜底"未命名会话"）+ 所属 workspace 标签（本地命中行）+ snippet 行
  （远程内容命中携带，同会话双命中时补入）；点击 →
  `chamberBridge.requestOpenSession`。
  状态行：loading → `search.pending`；error → `search.unavailable` 横幅
   （**本地命中仍显示**——内容搜索失败不吞本地元数据命中）；
  空 → `search.noMatches`；`hasMore` → `search.hasMore`（n=20 取常量）。
- **取舍**：聚合拉取失败（`aggregateError`）的来源隐藏搜索入口（标题无法
  解析，且与"错误行替换列表"一致）；已挂载来源标题随 store 事件即时更新；仅未挂载或
  reconnect baseline 不完整的来源可能在 30s 兜底窗口内暂显兜底名。

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
- **会话排序模式（2026-08，C档对齐官方）**：每来源排序偏好 manual（默认）|
  updated（§3.1 `orderBy`，来源头 hover 操作簇排序按钮打开**显式菜单**——官方
  ViewOptionsMenu 模式，勾选标记当前模式，取代早期盲切循环）。**updated =
  手动序 + 活动置顶（官方 ui-workspace nextSessionOrderAccount 语义，2026-08
  起不再是最初的"纯 recency 重排"）**：
  - 每个 account（真实 workspace 与未分组桶各一，键 `${sourceId}/${workspaceId}`）
    持有持久化活动序（`updatedOrder`）与上次观测时间戳簿记
    （`sessionUpdatedAtByAccount`），由侧边栏推导 effect 一起写回（diff 守卫，
    跨 shell 收敛）；
  - 首次观测 / 切回 updated（菜单动作清簿记 = 官方 switchedToUpdated）：整列
    一次 recency 排序；此后只把**自上次观测以来 updatedAt 增长的会话**置顶
    （互相 recency 排序），其余保持手动序——置顶会话被钉住（persisted account
    序）直到更新的活动或手动拖拽取代；
  - updated 模式下会话拖拽只写 account 序（共享 view-prefs 持久化，不提交
    wire、不 requestRefresh——官方「updated 排序时拖拽不落 wire」，promotion
    叠加其上）；未分组桶 updated 模式同样走 account 路径（manual 的
    `ungroupedOrder` 不受污染）。
    **有意的偏差（对齐声明的边界，2026-08 review 明确）**：切回 manual 时
    updated 模式下的拖拽位置**不保留**——manual 渲染 = override ?? wire，
    account 序被忽略，重新进入 updated 会整列 recency 重排。官方两种模式都
    渲染 account 序、拖拽跨模式保留；chamber 坚持 manual 的 wire 权威
    （P2-5 / AGENTS.md 宿主事实权威原则），故 updated 模式是**活动视图**而
    非持久的手动排布层。
  - 投影签名（`serversProjectionSignature`）**纳入会话 updatedAt**——会话活动
    时间戳变化会重发布投影，推导 effect 才能及时置顶（旧签名排除它是因为排序
    已物化为行序；2026-08 起排序由 account 推导驱动，排除理由不再成立）。
- **双击重命名（2026-08）**：workspace 头直接 dblclick 进入行内重命名
  （头本身不可点击，无延迟）；**会话行单击立即打开（零延迟，2026-08
  修订，对齐 OpenChamber 的 immediate-open 模型）**，双击重命名由
  同会话 350ms 内的二次点击判定（全局 pending 槽，按 sessionId 键控，
  跨 N-ctx shell 共享——跨来源双击时可见 shell 在两次点击之间切换，
  逐树 ref 会看不到第一次点击）；误判的双击只造成幂等重开、绝不误入
  重命名；kebab 菜单 rename 保留为 a11y 兜底；外部点击取消 pending。
  **2026-08 review 修订**：
  - **任何 stopPropagation 控件必须自己 clearPendingClick**（折叠/新建/
    kebab/归档 + 来源头排序/加工作区/搜索）——React 的 stopPropagation
    同时停掉原生事件，document 级监听看不到这些点击，残留的 pending 会
    让窗口内下一次同会话点击误入重命名。
  - **空白"新建会话"行不参与双击重命名**（P2-10 同款 `blank` 门控）——
    占位行无内容可改名，双击不得进入内联重命名（否则把暂存会话的改名
    写到 wire 上）。
  - **blank 行 ghost 槽（双击误中修复）**：双击空白行下方的真实会话时，
    click1 打开会话 → 空白行失去 current 立即消失 → 其下所有行在 350ms
    窗口内上移 ~30px → click2 落在目标行**下方**的那一行上，误开别的会话。
    修复：过渡点击（打开真实会话的 click）同步 arm 该空白行的 ghost 槽
    （`derive.ts armBlankGhost`，`BLANK_GHOST_GRACE_MS = 450` > 350ms），
    App 重派生时 `sessionVisible` 让该行在宽限期内留在投影里；侧边栏把
    它渲染为**非交互占位**（`visibility:hidden`，保留 26px 布局位），并在
    同一截止点（本地时钟 + 一次性定时器）停止渲染——即便 App 下个轮询
    周期才重派生，隐形空位也不会残留。宽限期后行才消失/列表才可位移，
    已安全越过双击窗口。
  - **跨 shell 滚动锚点同步（2026-08，`renderer/src/sidebar-scroll-sync.ts`，
    App selectView 接线）**：切换来源（N-ctx）时恢复该来源上次的侧边栏滚动
    位置；ghost 行带 `data-chamber-ghost`，锚点捕获跳过之（仅 arming shell
    渲染该行，入站 shell 没有——锚到 ghost 会空转到 8s 截止）；入站 shell
    在 `content-visibility:hidden` 时按 `checkVisibility` 门控重试，模块级
    generation 取消被取代的重试链。

### 2.3 代码落点

- `SidebarRoot.tsx`：拖拽状态 + 事件 + marker 渲染；渲染期按
  `reconciledSessionOrder`（§3 纯函数）对未分组会话排序。
- `sidebar-chamber.module.css`：marker/指示线类。
- `shared/derive.ts`：新增纯函数 `reconciledSessionOrder(stored, wireIds)`
  （stored 序优先、未知 id 按 wire 序追加——官方 `reconciledSessionOrder`/
  `orderedUngrouped` 移植），`test/derive.ts` 补用例。

### 2.4 来源级收拢 + 来源显示序（2026-09，todo/server-drag-sort.md 方案 1）

- **来源级收拢（server 折叠）**：来源头左侧新增折叠开关（与 workspace 头
  同款槽位：常态 FOLDER 字形、行 hover/focus 换入折叠 chevron，16px 槽位
  无位移），点击收拢该来源**整个 workspace 列表**（搜索胶囊、来源级 git
  告警与 workspace 列表一并隐藏；搜索状态本身不动，展开后原查询恢复）。
  **刻意独立于每 workspace 的 `folded`**——收拢服务器**不折叠 workspace
  内的对话**（用户明确规则），展开后各 workspace 及其会话原样恢复。
- **来源拖拽排序（显示序偏好）**：来源头为拖柄（HTML5 DnD，镜像 §2.2
  状态机——`ServerDragState { sourceId, over }`，section 边界渲染
  `dropBefore`/`dropAfter` marker），提交把新序写入 §3 共享存储的
  `serverOrder[sourceId…]`（**纯显示偏好，无 wire、不动 App 层 N-ctx
  常驻/预热/注册表**——导航按 id 键控，与顺序无关）；锚点数学为纯函数
  `nextServerOrder`（no-op 返回 null，单测覆盖）；渲染期
  `orderServersForDisplay(servers, stored)` 应用（存储序优先、未知 id
  跳过、未列出 id 按投影序尾随——新来源出现在列表底部直到被拖走）。
  rail 圆点同序渲染。来源从注册表删除后其 id 由写时裁剪清出（与
  orderBy 同规则）。**2026-09 review 收窄**：dragend 时
  `dropEffect === 'none'`（ESC 取消）不提交最后 marker——§2.2"drop/end
  提交最后 marker"在来源级收窄为"仅非取消的结束提交"（取消即放弃）。

## 3. 视图偏好持久化

### 3.1 存储形状

- 单键 `dsh-chamber.sidebar.v1`（整页共享 localStorage；所有实例 ctx 共读
  共写）：
  ```ts
  { v: 1,
    folded: Record<`${sourceId}/${workspaceId}`, boolean>,
    ungroupedOrder: Record<sourceId, string[]>,
    orderBy: Record<sourceId, 'manual' | 'updated'>,
    updatedOrder: Record<`${sourceId}/${workspaceId}`, string[]>,
    sessionUpdatedAtByAccount: Record<`${sourceId}/${workspaceId}`, Record<sessionId, number>>,
    sidebarWidth: number,
    sourceFolded?: Record<sourceId, boolean>,
    serverOrder?: string[] }
  ```
- **sourceFolded / serverOrder（2026-09，todo/server-drag-sort.md 方案 1）**：
  来源级收拢 + 来源显示序（见 §2.4）。均为可选字段——旧数据无字段即视为
  全展开 / 投影序，v 保持 1 不重播种；裁剪规则同 orderBy（本会话见过、
  现已消失的来源才裁）。
- **updatedOrder / sessionUpdatedAtByAccount（2026-08 C档新增）**：updated 排序
  模式的活动序 account 与簿记（见 §2「会话排序模式」）。键与 folded 同为
  `${sourceId}/${workspaceId}`（未分组桶的 workspaceId 即
  `UNGROUPED_WORKSPACE_ID`），剪裁规则同 folded（本会话见过、现已消失的来源
  才裁）。manual 模式不读这两个字段；v 保持 1，旧数据无字段即视为从未进入
  updated。
- **sidebarWidth（2026-08，ui-layout fork）**：`packages/dsh-chamber-client-ui-layout`
  （官方 ui-layout 壳插件的 chamber fork，仅替换 layout store）把侧栏宽度经本
  store 播种/回写——`init` 从 `getViewPrefs().sidebarWidth` 播种（钳位 vendor
  `[SIDEBAR_MIN, SIDEBAR_MAX]` 拖拽范围 [264,420]，从未拖过时回退
  `SIDEBAR_DEFAULT`），每次拖拽 `setSidebar` 经 `updateViewPrefs` 写回（同键
  `dsh-chamber.sidebar.v1`），所有 live boot 的 store 订阅并即时采纳；替换官方
  ui-layout 注册（见 05 §6）。
- **orderBy（2026-08 新增）**：每来源会话排序偏好 `'manual' | 'updated'`，
  默认 `manual`；v 保持 1 兼容旧数据（旧数据无此键即视为全 manual，不重
  播种），sanitize 丢弃非法值。**默认值决策（2026-08）**：默认 `manual`
  （保持既有 wire 序呈现），与官方默认 `updated` 不同——有意取舍：多来源
  列表下 wire 序即用户/宿主排好的序。**2026-08 C档修订**：v1 已实现官方
  活动提升（promotion）语义（updated = 手动序 + 活动置顶，§2），"不实现
  promotion"的旧理由不再成立；默认值仍取 manual（wire 序第一）。
- `shared/view-prefs.ts`：`loadViewPrefs()`/`saveViewPrefs(prefs)`，
  JSON 解析/写入 try/catch 兜底（非致命）、版本号不匹配即弃用重播种
  （官方 persist 引擎纪律）；纯函数，可单测。
- **共享实时存储（2026-08 修订，跨 ctx 实时联动）**：在读写函数之上新增
  `getViewPrefs()`/`subscribeViewPrefs()`/`updateViewPrefs()`——模块级
  单例缓存（vite shared chunk，所有 ctx 的侧边栏共享同一实例）+ 写透
  localStorage + 通知全部订阅者。折叠/未分组序在**任一来源**的侧边栏里
  变更即实时反映到**所有来源**的侧边栏，不再有每 ctx 陈旧副本、不再有
  「B 写回时把 A 的新状态覆盖成旧值」的复活问题。**取代**早前「mount 读
  一次 + 变化时合并写回、跨 ctx 不联动」模型（§5 已知取舍相应删除）。
- 裁剪规则（写入时）：**空投影不裁剪**（未就绪投影绝不抹掉用户偏好）；
  只裁**本会话内见过、现已从投影消失**的来源键（断连来源的折叠/未分组
  序保留，重连后恢复——渲染侧 `reconciledSessionOrder` 本就跳过未知 id）。
  **seenSources 为会话内内存簿记（2026-08 复查修复），绝不从存储恢复**：
  持久化它会令重启后首个写周期（roster 未到、投影仅 local）把上一会话
  见过、当前尚未加载的远程来源误判为「已删除」而永久抹掉其偏好——正是
  本机制要防的启动窗口数据丢失；上一会话删除、本会话未写过的来源残留
  ghost 键（渲染侧跳过未知 id，体积可忽略，接受）。

### 3.2 未分组序

- `ungroupedOrder[sourceId]` 由 §2 拖拽提交写入（经 `updateViewPrefs`）；
  渲染期 `reconciledSessionOrder` 应用（stored 优先 + 新游离按 recency
  追加）；未知 id 由渲染侧跳过。

### 3.3 代码落点

- `shared/view-prefs.ts` + `shared/index.ts` 再导出；`SidebarRoot.tsx`
  经 `getViewPrefs`/`subscribeViewPrefs`/`updateViewPrefs` 读写；
  `test/view-prefs.ts` 覆盖存储单例/通知/裁剪（node:test 风格）。

## 4. 运行时事实通道（完成/待交互点 + 跨来源当前会话高亮）

### 4.1 事实来源（每 ctx 运行时）

- `ctx.sessions.list`（ObservableSnapshot）行字段：`running`、`completed?`、
  `pendingInteraction?: 'approval'|'plan-review'|'question'`、`blank`、
  `updatedAt`；快照含 `current?: string`（当前会话 id）。
- 每个实例 boot = 独立 ctx、独立 store；侧边栏插件在每个 ctx 都挂载，
  即每个来源都有一个可订阅自身运行时的事实生产者。
- **插件 = 无状态投影（2026-08 修订，远程完成未读蓝点修复）**：上报端只做
  快照直通——`current` + 每个列出会话的实时 `running` 位 + vendor 已武装的
  `completed`/`pending`，**不自持任何状态**。官方 `completed` 提醒只在
  「运行→空闲」边沿且会话**非本 ctx selected** 时武装，后台来源 shell 的
  selected 保持「最后打开」不随活动视图切换更新，会把后续完成误判为
  「正在阅读」而永久压制蓝点——因此**蓝点的武装/解除整体上移到 App 层**
  （它拥有活动视图与全部 open 请求，是唯一知道「谁在阅读什么」的地方），
  由 App 从上报里的实时 running 位自行推导 running→idle 边沿（规则与
  vendor 提醒同构，仅把「正在阅读」从「本 ctx selected」替换为「活动视图
  的 current 会话」）。App 侧状态机见 §4.2；插件侧无重复状态、不碰任何
  来源的 selection（无竞态、会话保活不受影响）。
- **运行中子 agent 计数（2026-08 修订）**：除 running/completed/pending
   外，插件另上报每父会话的 `runningSubagents`——vendor 纯函数
   `indexSubagentDescendants(byId)` 的 runningCount（经不间断 subagent 起源
   链统计的后代 running 数，官方 ui-workspace tree 的
   `runningSubagentCount` 同一算法）。动机与语义见 §4.5：父会话的 running
   位只反映「agent 回合进行中」，后台子 agent 存活时父回合已结束
   （running=false），子 agent 仍在工作——没有这条计数，完成蓝点会在子
   agent 干活时提前亮起。

### 4.2 通道 API（chamberBridge 扩展）

> 接口定义（`InstanceRuntimeReport` / `reportInstanceRuntime` /
> `clearInstanceRuntime` / `onRuntimeReport`）以 **05 §3** 为权威（v1 契约），
> 本节只描述**上报时机与对账规则**（不再重复 TS 定义）。

- 每 ctx 插件 apply 内新增 effect：订阅 `ctx.sessions.list`，订阅后立即
  上报一次当前快照（zustand subscribe 不即时触发），其后每次变更上报
  投影（`{ current, sessions: { id: { running, completed?, pending?,
  runningSubagents? } } }`，每个列出会话都有 running 行；runningSubagents
  仅 >0 时出现——vendor `indexSubagentDescendants` 的 runningCount，插件在
  vendor 边界直接复用该纯函数，见 §4.5）；effect 清理时
  `clearInstanceRuntime`。
- App 侧：`runtimeFacts` state；**`completedBySource` state + `prevRunning`
  ref——App 自持的完成未读蓝点状态机**（06 §4.1）：每次上报对账——
  - 武装：running→idle 边沿，且该会话不是活动视图的 current（后台来源
    无阅读者，全部武装——正是 vendor 陈旧 selected 会漏掉的那一个）；
  - 解除：重新运行（running=true）、会话从列表消失、或用户开始阅读
    （该来源为活动视图且会话为其 current；视图切换生效时另有一处 effect
    兜底「激活但无新上报」路径，如点击来源头不打开会话）。
  - `deriveServers` 把 `completedBySource` 与上报里的 vendor `completed`
    取并集合并进 `ChamberServerAggregate.runtime?`（仅附加，不覆盖 polled
    字段）；`pollAggregates` 的 not-connected 分支清空该来源**上报事实**
    （断连即清，generation 级事实随断连失效）；App 自持的蓝点与边沿记忆
    跨断连保留——重连后重新挂载，且能捕获断连期间完成的会话（prevRunning
    持有断连前 running=true）。
- 对账逻辑是**纯函数** `shared/derive.ts reconcileCompletedFacts`（单测见
  `test/derive.ts`）：App 在 `setCompletedBySource` 的函数式 updater 里调用
  它，且每份上报各自捕获 `prevRunning` 快照——同来源两次上报落在同一渲染
  周期时按序组合，不会互相覆盖丢蓝点（2026-08 复查修复）。

### 4.3 UI 语义（状态指示）

- 行尾为**固定 10px 状态槽**（非常驻身份点——来源身份由来源头圆点承担）：
  - 常态（不运行、未完成、无子 agent）：空槽，不显示任何图标（槽保留
    宽度，行右缘跨行对齐）；
  - 运行中：官方 `StateDot` **ongoing 圆环**
    （`--dsw-static-deepseek-450` 蓝色 chase ring）；
  - **子 agent 运行中（2026-08 修订）**：同一 ongoing 圆环，tooltip/aria
    显示「N 个子代理运行中」——父回合已结束但后台子 agent 仍在工作时
    会话依旧"进行中"，**绝不在这个阶段亮起完成蓝点**（§4.5）；
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
  locale 键**保留供 hover 卡相对时间使用**；`relativeTimeBucket` 纯函数
  保留为共享工具）。
  2026-08 确认：相对时间列**暂不回归**，维持移除（多来源密度 + 行尾状态槽
  取代时间列）；若未来回归需同步修订 05 §2.1 的残留文案。
- **当前会话高亮 = 全局单选（2026-08 修订）**：`server.runtime?.current`
  命中即高亮，但仅限**拥有当前可见 ctx 的来源**（渲染侧
  `server.id === chamberInstanceId` 门控）——各来源壳内"切换前最后一个"
  会话不再全部高亮，全局只有一个高亮（正在查看的那个会话）。
  （语义演进：第二轮"仅自身来源 useSyncExternalStore" → 第三轮"全来源
  高亮" → 本轮收敛为全局单选；通道机制不变——组件不再直连 store，
  订阅逻辑在插件 apply 上报端；boot 首帧无上报前不高亮，随首次上报
  补齐。跨来源的 pending/completed 状态点不受影响，仍全来源呈现。）
- **状态点优先级（2026-08 修订）**：
  **pending 徽标 > runningSubagents 运行环 > completed 点 > running 环**。
  completed/pending/runningSubagents 来自 runtime facts，`running` 来自完整
  aggregate snapshot；两者均由已挂载 ctx 的同一 sessions store 事件驱动，
  但独立 bridge state 可能相差一个 React commit。runningSubagents 同样压过
  running 环与 completed 点（vendor 自身保证 completed 与 running 互斥）。官方
  sessionStatuses 的「有运行中子 agent 就显示 ongoing」语义因此原样对齐
  （官方同快照无错位，其顺序 running > subagents > completed；chamber 为避免
  瞬时双通道错位把用户需处理状态压掉，将交互/子 agent/完成事实前置）。
- **运行环 snapshot 单一权威（`runningRingVisible`）**：运行环只取完整
  aggregate snapshot 的 running 位，runtime facts 的 running 位不参与渲染。
  已挂载来源的 snapshot 由自身 ctx store 在 host-frame 事件上即时上报；未挂载或
  reconnect baseline 未完成的 ready 来源走 30s unary 兜底。两条字段不做 OR/优先
  合并，避免同一渲染事实出现双权威。`runtimeReportSignature(includeRunning=false)`
  继续保证 runtime 通道的 running-only 变化不重复驱动同一环渲染。
  通道 running 位仍保留在 `InstanceRuntimeReport` 中，供 App 完成蓝点
  状态机（`reconcileCompletedFacts`）推导 running→idle 边沿（App 内部
  逻辑，非侧边栏渲染）。
- **搜索结果行状态点（2026-08 修订）**：结果行经投影解析 running 位
  （搜索命中会话必在投影可见集内，查得到即用投影位；查不到回落 false）——
  状态槽渲染优先级同树行（pending 徽标 > runningSubagents 环 > completed
  点 > running 环）；**running 环 snapshot 权威（与树行一致）：只取投影位，
  runtime facts 的 running 不参与渲染**（`runningRingVisible`，单一权威见上）。
  已知窗口（接受）：未挂载来源的兜底拉取失败期间树行整体消失（错误横幅替代），
  搜索结果行保留但运行环随投影为空回落 false——纯 cosmetic 的瞬时窗口；
  槽**恒占位**保持标题对齐。

### 4.4 代码落点

- `shared/aggregate-store.ts`（通道 + `ChamberServerAggregate.runtime?` +
  `runningSubagents` 行字段）、`client/index.ts`（订阅与无状态上报 +
  `indexSubagentDescendants` 注入）、`App.tsx`（runtimeFacts +
  completedBySource 对账 + 合并 + 清理 + 激活兜底；runningSubagents 随
  事实行透传，状态机无需感知）、
  `SidebarRoot.tsx` + `sidebar-chamber.module.css`（dot 状态类 + 高亮 +
  runningSubagents 分支）、`locales.ts`
  （`status.waitingApproval/planReview/waitingAnswer/completed` +
  `status.subagentsRunning.one/other`）。

### 4.5 运行中子 agent（runningSubagents 圆环，2026-08 修复）

**问题**：agent 状态是二元的——`status = phase.kind === 'idle' |
'maintenance' ? 'idle' : 'running'`，driver 在工具调用 await 期间不释放
running 相位；会话 running 位 = agent.status === 'running'。subagent 工具
两种运行模式：**one-shot（默认，前台等待）**——父回合在 await 子 agent，
父 running 位保持 true；**后台（run_in_background: true / continuable
默认）**——工具立即返回，父回合先结束（running=false），子 agent 继续
在后台工作。官方 `completed` 提醒在父 running→idle 边沿武装
（manager.ts syncCompletedNotifications），官方 UI 的 sessionStatuses 把
「有运行中子 agent」（runningSubagentCount > 0）排在 node.completed 之前
——官方保证「子 agent 在跑就显示 ongoing」，即使父会话自身已 completed。

**我们的缺口**：侧边栏状态链此前只有 pending > completed > running 三档，
没有任何 subagent 信号——后台模式下父回合结束即武装完成蓝点，子 agent
仍在干活时蓝点就亮了（且会一直保持到用户阅读或父再次运行）。

**修复**：
- 插件（vendor 边界）在每次快照投影时调用 vendor 纯函数
  `indexSubagentDescendants(snapshot.byId)`，把每父会话的 runningCount
  （>0 稀疏）并入事实通道——与官方 tree.ts 的 `runningSubagentCount`
  同一算法同一输入，语义不可能漂移；`shared/derive.ts projectRuntimeFacts`
  保持纯（计数经参数注入，import 图不引入未构建 vendor 包）。
- 渲染优先级改为 **pending 徽标 > runningSubagents 运行环 > completed 点
  > running 环**：子 agent 存活期间绝无完成蓝点（对齐官方
  sessionStatuses）；子 agent 全部结束后蓝点正常浮现（App 的
  completedBySource 边沿状态机无需改动——蓝点在子 agent 运行期间保持
  武装但被渲染压制，与官方「completed 保持武装、subagents 分支优先
  呈现」完全同构）。
- tooltip/aria：`status.subagentsRunning.one/other`
  （官方 copy：`{n} 个子代理运行中` / `{n} subagent(s) running`）。

**残留（记录）**：父回合与子 agent 同活的短暂前台窗口（one-shot
await 中），我们单点只显示子 agent 计数文案，官方同快照显示
「运行中」主标签 + 计数次标签——圆环同形，仅 tooltip 文案单值取舍；
聚合轮询陈旧（≤一个轮询周期）时 running 环与子 agent 环瞬时同形，
取实时通道为真。

## 5. 已知取舍与开放项（已决）

- 跨实例 `dsh.sessions.current` localStorage 共享键（last-writer-wins）：
  接受——镜像运行时既有行为，通道原样携带。
- **完成发生在来源 shell 首次观察之前仍无蓝点（2026-08 记录）**：App 侧
  蓝点与 vendor 提醒同受「首次观察只记录 running 位」规则——来源 shell
  尚未挂载（预热排队中/首次打开前）期间的完成边沿两者都看不到。空闲预热
  保证连接后尽快挂载，该窗口为「实例就绪 → shell boot 完成」；活动来源
  的完成即时可见（预热/打开必先挂载）。不做轮询级完成推导（10s 粒度会
  漏掉更短任务，且与「running 点 wire 权威、completed 仅通道提供」契约
  冲突）。
- **App 侧蓝点跨断连保留（2026-08）**：上报事实（runtimeFacts）断连即清
  （generation 级），App 自持的 completedBySource/prevRunning 跨断连保留
  ——断连期间完成的会话在重连后仍正确武装（prevRunning 持有断连前
  running=true，重连基线 running=false 触发边沿）；侧边栏断连时本就无行
  可显示，蓝点不闪烁。
- 结果标题滞后 / 聚合错误源隐藏搜索 / rail 无搜索：接受（§1.2）。
- 拖拽无 touch/键盘：已知限制（官方亦然，Electron 桌面）。
- 拖拽乐观重排不设回滚：pull 模型自愈 + inline 错误，接受。

## 6. 验证计划

- 纯函数单测：`reconciledSessionOrder`、`view-prefs` 读写、搜索 sanitize
  （并入 `test/derive.ts` 或新增 test 文件，node:test 风格）。
- `pnpm run typecheck`、`pnpm run build:renderer`、`pnpm run verify:i18n`
  全绿；control-plane 套件不回退。

## 7. 样式定稿（设计）

- **Token 契约**：以 dsh 设计平台 token 为准——状态色
  `--dsw-alias-state-{success,warn,error,business}-primary`（completed 点 /
  connected 徽标、pending 点、错误文本）、运行中点 `--dsw-static-deepseek-450`
  （running 蓝）、搜索胶囊 focus 边框 `--dsw-alias-brand-primary`、折叠
  chevron `--dsw-alias-label-caption`、来源头底色 `--dsw-specific-sidebar-fill`；
  不存在的 `--dsw-alias-accent/success/danger/input-fill` 一律不得使用。
- **来源 accent**：每元素 `--dsh-source-accent` CSS 变量承载远程来源 hue
  （`hsl(hue 65% 52%)`），本地来源省略、回退默认 ink；用于来源头激活左
  内边线与 rail 活动环（**2026-09 起 workspace 组 chevron 不再取来源
  accent**——workspace 图标自带确定性 accent，见下条）。
- **workspace 图标 accent（2026-09）**：workspace 头行内联
  `--dsh-workspace-accent`（`.foldToggle` 基色/hover 同取，图标走
  currentColor）——色相 = `(serverId, 家族种子)` 哈希 × 137.508 黄金角
  步进 mod 360，明度 = 44/49/54%（第二哈希抖动，近色相兜底）；家族种子
  = `repoKey`（worktree 与主检出共享家族色相，主检出未注册/改名不漂移；
  `mainWorkspaceId` 仅为无 repoKey 时的回退），worktree 降饱和 45%、
  主检出/普通 workspace 62%；未分组桶无 accent 回退 caption ink。无用户
  自定义、无持久化、**与选中态无关**（纯函数 `workspaceAccentStyle`，
  shared/derive.ts；当前会话指示完全由 session 行官方 selected tint 承担）。
- **当前会话高亮（对齐官方 selected 处理）**：session 行 = 官方
  `.sessionRow.selected` 的浅 `interactive-bg-hover` 色调（无 inset 阴影、
  无深色调、无标题加粗）；所在 workspace 组 = 无底色、图标色恒定
  （2026-09：曾取来源 accent 的 `.groupContainsCurrent .foldToggle` 规则
  已移除）——当前指示不重复编码于 workspace 级，两组高亮永不相邻融合，
  色调全为官方 token 浅档。
- **排版**：字号下限 12px；会话标题 13/18——官方行 14px，13/18 是 chamber
  多来源密度的刻意折中；来源身份点 8px（仅来源头/rail），session 行首为
  固定 10px 状态槽（常态空）。
- **行几何**：圆角 8px（来源头/workspace 头/会话行一致）；密度为多来源
  列表的有意取舍。
- **搜索胶囊**（§1）：`border-l2` 边框 + `:focus-within` brand 边框；30s
  调用方 abort；per-source 任务隔离（一个来源击键不重启其他来源在途搜索）；
  结果分支优先于 aggregateError；`maxLength` 取共享常量
  `SEARCH_QUERY_MAX_CODE_UNITS`。
- **未连接来源呈现**：搜索入口按 `connected` 门控；**状态徽标语义（色点/转圈
  枚举、重试折叠为稳定「重连中」态、相位文本仅在 hover/aria）见 05 §2.1**，
  本节不再重复；06 增量：状态槽居来源头右端、hover 时被搜索/`+` 簇替换
  显示；全部断开时保留各来源分组、空态提示为列表底部一行；
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
- **悬停卡片（2026-08）**：workspace 头与真实会话行悬停显示官方
  `HoverCard` 移植卡片——workspace 卡 = 标题 + 会话数（投影无
  path/createdAt 故省略）；会话行卡 = 标题 + 相对时间 + 状态点列表 + 复制
  标题按钮（blank 行不显示时间）。disabled = 菜单打开或拖拽中
  （`menuOpen`/`sessionDrag`/`workspaceDrag` 任一成立即禁用）。
- **a11y（2026-08）**：来源分组 `role="group"`、列表 `role="tree"`、
  workspace 头 `role="treeitem"` + `aria-expanded`、会话行 `role="treeitem"`
  + `aria-selected`、搜索结果行 `button` + `role="treeitem"`；来源头
  （非当前来源）`role="button"` 可键盘激活（Enter/Space 切换视图）。
- **blank 行（2026-08）**：当前空白"新会话"行隐藏操作簇（kebab/分叉/归档，
  对齐官方 `!row.blank &&` 门控）——空白行无重命名/分叉/归档语义。**2026-08
  review 补充**：双击同样被 `blank` 门控（不进入内联重命名，见 §2.2）；离开
  current 后的 450ms 宽限期 ghost 占位机制见 §2.2（`visibility:hidden`
  非交互、保留布局位，`derive.ts armBlankGhost` + `.sessionGhost`）——双击
  窗口内列表绝不位移。
- **会话状态指示（2026-08 修订）**：固定 10px 行尾状态槽——常态空、
  运行中 = 官方 `StateDot` ongoing 蓝圆环、运行结束未读 = 持久蓝圆点；
  **待交互（pending）= 14px 图标徽标**（问号/清单/警示三角）——几何与配色
  契约见 §4.3，本节只定稿 token：运行与 completed 颜色一律
  `--dsw-static-deepseek-450`，pending 徽标用
  `--dsw-alias-state-{business,warn}-primary`（不再有 green/red 状态色）；
  状态槽非身份标记（来源身份由来源头圆点承担）。
- **当前会话高亮（含 workspace 组标记）**：session 行 = 官方 selected 的
  浅 hover 色调（无阴影无加粗）；workspace 组 = 图标恒定自有色
  （2026-09 起，曾取来源 accent 的 chevron 规则已移除）——无底色融合、
  无深色调。
- **嵌套缩进（收紧）**：workspace 列表距来源头 10+1+6 = 17px；session 行
  左 padding 26px——session 标题相对 workspace 标题（24px）深 18px，
  server→session 标题级联 ~59px（原 73px）；会话级重命名表单与错误行
  同缩进。
- **拖拽鲁棒性**：行内控件（kebab/归档/`+`/折叠/搜索/来源头激活）复用
  `suppressClickRef` 抑制拖拽结束后的尾随 click（拖到按钮上不会误触发
  确认弹窗/菜单/建会话/切视图）；`rowHalf` 对零高行防御；chamber 列表
  区域包一层 `ChamberListBoundary`——意外渲染错误只让列表区显示错误
  文本，绝不带走整个 shell（应用级 ErrorBoundary 不再触发）。
