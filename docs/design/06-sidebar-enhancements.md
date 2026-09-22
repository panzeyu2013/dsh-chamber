# 06 · 侧边栏增强（搜索 / 拖拽排序 / 视图持久化 / 运行时事实通道）

> **v1 侧边栏增强契约**——本设计定义 chamber 自研侧边栏的
> 搜索、来源内拖拽排序、视图偏好持久化与运行时事实通道（完成/待交互状态点、
> 跨来源当前会话高亮、运行中子 agent 计数、会话待办区）；
> 进度记录见 docs/progress/STATUS.md。
> 本文档 + 05 为实现契约。
> **约束**：不发明协议（只用 wire 既有方法）、不做跨来源移动
> （拖拽按来源在代码层阻断）、运行时事实只经通道投影（控制面/App 不持有
> 会话权威）。
> fork 会话（侧边栏会话行 kebab 行内 fork + 官方 conversation turn-tail
> `forkAt`）的契约在 05 §2.2/§9；flat 单列表模式维持推迟（§5）。

## 1. 会话搜索（每来源）

### 1.1 Wire 契约（零新增）

- `sessions.search { query }` → `{ items: SessionSearchItem[], hasMore }`；
  `SessionSearchItem = { sessionId, snippet }`（≤240 码点）；query 需 trim、
  非空、≤500 字符、无 `\0`（schema 校验）；结果 ≤20 条
  （`SESSION_SEARCH_RESULT_LIMIT`，经 `dsh-client-connection/client` api.ts
  再导出）；`hasMore` 提示用户缩小范围；AbortSignal 必传（30s 超时合并）。
- 标题/workspace 标签**不上 wire**——由客户端从该来源聚合快照解析
  （投影已带 per-session title；workspace 标题或未分组标签兜底）。
- **本地元数据匹配**：本地腿对投影**可见集**做标题/所属 workspace 标题
  **子串匹配**（大小写不敏感；archived/subagent/blank 行不进投影故不可能
  命中），命中按 recency 排序（纯函数 `deriveLocalSearchMatches`）；
  远程腿 = wire `sessions.search` 内容命中，**按投影可见集过滤**（对齐官方
  deriveSearchResults）。合并（`mergeSearchResults`）：本地优先（recency
  序）→ 远程未覆盖行按后端序追加，跨腿/腿内去重；同
  会话双命中补远程 snippet（本地行 snippet 为空）。
- 生成的 unary client 已含 `client.sessions.search({query}, signal)`
  （dsh-host-apiproxy fetch/client.ts），无需发明 wire。

### 1.2 UI 设计

- **位置**：每来源分组头内搜索图标按钮（`sourceHeader` 内、状态徽标旁），
  点击在头下展开新行（胶囊 input + 清除按钮），wide 态专属（rail 不做）。
- **状态（共享控制器）**：每来源搜索状态与防抖 job 整体移入
  `shared/search-state.ts` 共享单例（vite shared chunk，所有 ctx 同一实例）
  ——`expandSearch`/`collapseSearch`/`setSearchQuery`/`clearSearch`/
  `getSearchStates`/`subscribeSearch`；组件只镜像渲染 + 持 DOM ref（outside-click
  包含判定与 focus）。视图切换后搜索仍存活（可见侧边栏换 shell，共享状态不换）；
  job 单一所有者，杜绝 N shell 对同一查询重复发起/互相中止（单来源击键不打扰其他
  来源在途搜索，30s 超时与「被替换」区分）。
- **流程**：输入 → sanitize（去 `\0`、500 UTF-16 截断、trim）→ 空则回
  idle；非空建 `AbortController` → 250ms 防抖 → `searchSessions(client, query, signal)`
  → 未中止则提交 ready/error。
  Escape 清空并收起；outside-click 仅在 query 为空时收起（官方语义）。
  断连来源的搜索状态被裁剪（重连从干净收起态开始）。
- **结果渲染**：query 非空时该来源的 `workspaceList` 整体替换为结果列表
   （来源头与状态保留；折叠入口隐藏）。行 = 标题（聚合解析：官方链
   `durable title → cwd 目录名 → 会话 id`，**永不为空**，见 design 05 §2.1）
   + 所属 workspace 标签（本地命中行）+ snippet 行
  （远程内容命中携带，同会话双命中时补入）；点击 →
  `chamberBridge.requestOpenSession`。
  状态行：loading → `search.pending`；error → `search.unavailable` 横幅
   （**本地命中仍显示**——内容搜索失败不吞本地元数据命中；文案为「仅显示名称匹配」）；
  空 → `search.noMatches`；`hasMore` → `search.hasMore`（n=20 取常量）。
  **结果树可访问名**：`role="tree"` + `search.results.aria`
  （浏览树同批补名，§7 a11y）；命中行在标题后与树行同样渲染活动定时任务标记
  （§4.3）。
- **取舍**：聚合拉取失败（`aggregateError`）的来源隐藏搜索入口（标题无法
  解析，与"错误行替换列表"一致）；已挂载来源标题随 store 事件即时更新；
  仅未挂载或 reconnect baseline 不完整的来源可能在 30s 兜底窗口内暂显兜底名。

### 1.3 代码落点

- `shared/instance-api.ts`：包装 `searchSessions(client, query, signal)`
  （信号透传——现有 helper 不带 signal；复用 `resultError`）。
- `SidebarRoot.tsx` + `sidebar-chamber.module.css` + `locales.ts`
  （`search.*` 键 zh/en 八组）。
- `renderer/vendor-modules.d.ts`：ambient 镜像补新导出。

## 2. 拖拽排序（来源内）

### 2.1 Wire 契约

- `workspace.insertSessionBefore { workspaceId, sessionId, beforeSessionId? }`
  → 完整新 `WorkspaceView`；**省略 anchor = 追加到末尾**（null 非法，
  须 omit key）；校验成员资格（`workspace-move-invalid`/`workspace/not-found`）；
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
- **拖柄排除按钮**：workspace/source header 的
  pointerdown 落在 header 内任意 button（折叠 / 排序 / 加工作区 / 搜索 /
  `+` / kebab / git 行内动作）上时，dragstart 即 preventDefault 取消拖拽
  （dragstart 的 target 是拖柄本身，故按压目标在 pointerdown 记录）——
  按钮保持纯点击语义，>4px 微拖不吞点击。会话行拖拽不受影响（行内动作
  沿用尾随 click 抑制）。
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
- **会话排序模式（对齐官方）**：每来源排序偏好 manual（默认）| updated（§3.1
  `orderBy`，来源头 hover 操作簇排序按钮打开**显式菜单**——官方 ViewOptionsMenu
  模式，勾选标记当前模式）。**updated = 手动序 + 活动置顶（官方 ui-workspace
  nextSessionOrderAccount 语义，不是"纯 recency 重排"）**：
  - 每个 account（真实 workspace 与未分组桶各一，键 `${sourceId}/${workspaceId}`）
    持有持久化活动序（`updatedOrder`）与上次观测时间戳簿记
    （`sessionUpdatedAtByAccount`），由侧边栏推导 effect 一起写回（diff 守卫，
    跨 shell 收敛）；
  - 首次观测 / 切回 updated（菜单动作清簿记 = 官方 switchedToUpdated）：整列一次
    recency 排序；此后只把**自上次观测以来 updatedAt 增长的会话**置顶（互相
    recency 排序），其余保持手动序——置顶会话被钉住（persisted account 序）直到
    更新的活动或手动拖拽取代；
  - updated 模式下会话拖拽只写 account 序（共享 view-prefs 持久化，不提交 wire、
    不 requestRefresh——官方「updated 排序时拖拽不落 wire」）；未分组桶 updated
    同样走 account 路径（manual 的 `ungroupedOrder` 不受污染）。**有意的偏差**：
    切回 manual 时 updated 模式下的拖拽位置**不保留**（manual 渲染 = override ??
    wire，account 序被忽略，重进 updated 整列 recency 重排）；官方两种模式都渲染
    account 序、拖拽跨模式保留，chamber 坚持 manual 的 wire 权威（design 01 §5），
    故 updated 是**活动视图**而非持久手动排布层。
  - 投影签名（`serversProjectionSignature`）**纳入会话 updatedAt**——时间戳变化
    会重发布投影，推导 effect 才能及时置顶（排序由 account 推导驱动，该字段不可
    从签名排除）。
- **双击重命名**：workspace 头直接 dblclick 进入行内重命名（头本身不可点击，无
  延迟）；**会话行单击立即打开（零延迟，对齐 OpenChamber immediate-open 模型）**，
  双击重命名由同会话 350ms 内的二次点击判定（全局 pending 槽按 sessionId 键控、跨
  N-ctx shell 共享，跨来源双击时可见 shell 在两次点击之间切换）；误判的双击只造成
  幂等重开、绝不误入重命名；kebab 菜单 rename 保留为 a11y 兜底；外部点击取消
  pending。
  **行内形态**：workspace 重命名编辑框**嵌入表头行本身**——标题/orphan 徽标/
  计数/git occupant/悬停动作原位替换为输入框 + 保存/取消，行首折叠钮与图标槽保留
  （行身份与位置不变，**不**在表头下方追加输入行；编辑期行高放宽（输入框为官方行内 14/20 + `padding: 0 2px`，21px 盒：编辑期表头只长 ≈1px，
  不再是 ±6px；进入/退出编辑时下方内容仍是一次性、单向位移）、折叠字形
  hover 切换抑制、悬停卡片禁用）；因此**折叠态 workspace 的 kebab 重命名同样
  可见**（编辑框随表头渲染，不依赖展开），rename/delete/拖拽失败的 inline 错误行
  也不受折叠门控。会话行重命名保持整行替换为编辑行（行槽原位 swap）。
  **停冒泡控件的 pending 清理纪律**：
  - **任何 stopPropagation 控件必须自己 clearPendingClick**（折叠/新建/
    kebab（含归档动词）+ 来源头排序/添加工作区/搜索）——React 的 stopPropagation
    同时停掉原生事件，document 级监听看不到这些点击，残留的 pending 会
    让窗口内下一次同会话点击误入重命名。
  - **空白"新建会话"行不参与双击重命名**（同款 `blank` 门控）——
    占位行无内容可改名，双击不得进入内联重命名（否则把暂存会话的改名
    写到 wire 上）。
  - **blank 行 ghost 槽（双击误中修复）**：双击空白行下方的真实会话时，click1
    打开会话 → 空白行失去 current 立即消失 → 其下所有行在 350ms 窗口内上移
    ~30px → click2 落在目标行**下方**那一行上，误开别的会话。修复：过渡点击同步
    arm 该空白行的 ghost 槽（`derive.ts armBlankGhost`，
    `BLANK_GHOST_GRACE_MS = 450` > 350ms），App 重派生时 `sessionVisible` 让该行在
    宽限期内留在投影里；
    侧边栏渲染为**非交互占位**（`visibility:hidden`，保留 26px 布局位），并在同一
    截止点（本地时钟 + 一次性定时器）停止渲染。宽限期后行才消失/列表才可位移，
    已安全越过双击窗口。
  - **跨 shell 滚动锚点同步（`renderer/src/sidebar-scroll-sync.ts`，App selectView
    接线）**：切换来源（N-ctx）时恢复该来源上次的侧边栏滚动位置；ghost 行带
    `data-chamber-ghost`，锚点捕获跳过之（仅 arming shell 渲染该行——锚到 ghost
    会空转到 8s 截止）；入站 shell 在 `content-visibility:hidden` 时按
    `checkVisibility` 门控重试，模块级 generation 取消被取代的重试链。

### 2.3 代码落点

- `SidebarRoot.tsx`：拖拽状态 + 事件 + marker 渲染；渲染期按
  `reconciledSessionOrder`（§3 纯函数）对未分组会话排序。
- `sidebar-chamber.module.css`：marker/指示线类。
- `shared/derive.ts`：新增纯函数 `reconciledSessionOrder(stored, wireIds)`
  （stored 序优先、未知 id 按 wire 序追加——官方 `reconciledSessionOrder`/
  `orderedUngrouped` 移植），`test/session-rows/derive.test.ts` 补用例。

### 2.4 来源级收拢 + 来源显示序

- **来源级收拢（server 折叠）**：来源头左侧新增折叠开关（与 workspace 头同款
  槽位：常态 **MONITOR 电脑字形**（folder = workspace、monitor =
  server），行 hover/focus 换入折叠 chevron，16px 槽位无位移），点击收拢该来源
  **整个 workspace 列表**（搜索胶囊、来源级 git 告警与 workspace 列表一并隐藏；
  搜索状态本身不动，展开后原查询恢复）。**刻意独立于每 workspace 的 `folded`**
  ——收拢服务器**不折叠 workspace 内的对话**，展开后各 workspace
  及其会话原样恢复。
- **来源拖拽排序（显示序偏好）**：来源头为拖柄（HTML5 DnD，镜像 §2.2 状态机——
  `ServerDragState { sourceId, over }`，section 边界渲染 `dropBefore`/
  `dropAfter` marker），提交把新序写入 §3 共享存储的 `serverOrder[sourceId…]`
  （**纯显示偏好，无 wire、不动 App 层 N-ctx 常驻/预热/注册表**——导航按 id
  键控）；锚点数学为纯函数 `nextServerOrder`（no-op 返回 null，单测覆盖）；渲染期
  `orderServersForDisplay(servers, stored)` 应用（存储序优先、未知 id 跳过、
  未列出 id 按投影序尾随——新来源出现在列表底部直到被拖走）。rail 来源按钮同序
  渲染（§7；rail 每来源一个具名可操作按钮，颜色点与活动环几何
  不变）。来源从注册表删除后其 id 由写时裁剪清出（与 orderBy 同规则）。
  **取消即放弃**：dragend 时 `dropEffect === 'none'`（ESC 取消）不提交最后
  marker——§2.2"drop/end 提交最后 marker"在来源级收窄为"仅非取消的结束提交"。
  两条同向判据：① dragend 时 `dataTransfer` 为 null（Safari 曾有该行为）同样视为
  取消——null 无法读取 dropEffect，`?.` 会把 `undefined !== 'none'` 误判为已
  提交；② 拖拽期间指针离开所有来源 section（document 级 dragover 目标不在
  `[data-chamber-section]` 内）即清除 marker——**列表外释放 = 取消**。会话/
  workspace 拖拽保持 §2.2 语义不变（来源级拖拽移动整个分组、影响面大，故收窄；
  ESC 仍由 ① 覆盖）。

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
- **sourceFolded / serverOrder**：来源级收拢 + 来源显示序（§2.4）。可选字段，
  旧数据无字段即全展开 / 投影序，v 保持 1 不重播种；裁剪同 orderBy（本会话见过、
  现已消失的来源才裁）。
- **updatedOrder / sessionUpdatedAtByAccount**：updated 排序的活动序 account 与
  簿记（§2「会话排序模式」）。键与 folded 同为
  `${sourceId}/${workspaceId}`（未分组桶 workspaceId 即
  `UNGROUPED_WORKSPACE_ID`），剪裁同 folded；manual 模式不读；v 保持 1，旧数据
  无字段即从未进入 updated。
- **sidebarWidth（ui-layout fork）**：`packages/dsh-chamber-client-ui-layout`
  （官方 ui-layout 壳的 chamber fork，仅替换 layout store）把侧栏宽度经本 store
  播种/回写——`init` 从 `getViewPrefs().sidebarWidth` 播种（钳位 vendor
  `[SIDEBAR_MIN, SIDEBAR_MAX]` 拖拽范围 [264,420]，从未拖过回退
  `SIDEBAR_DEFAULT`），每次拖拽 `setSidebar` 经 `updateViewPrefs` 写回同键
  `dsh-chamber.sidebar.v1`，所有 live boot 的 store 订阅并即时采纳；替换官方
  ui-layout 注册（见 05 §6）。
- **orderBy**：每来源会话排序偏好 `'manual' | 'updated'`，默认 `manual`；
  v 保持 1 兼容旧数据（无此键即全 manual，不重播种），sanitize 丢弃非法值。
  **默认 `manual`**（保持既有 wire 序呈现）与官方默认 `updated` 不同——有意
  取舍：多来源列表下 wire 序即用户/宿主排好的序；该默认不因官方活动提升（updated 排序）
  而改变：updated = 手动序 + 活动置顶（§2），wire 序仍是默认第一。
- `shared/view-prefs.ts`：`loadViewPrefs()`/`saveViewPrefs(prefs)`，JSON
  解析/写入 try/catch 兜底（非致命）、版本号不匹配即弃用重播种（官方 persist
  引擎纪律）；纯函数，可单测。
- **共享实时存储（跨 ctx 实时联动）**：读写函数之上加
  `getViewPrefs()`/`subscribeViewPrefs()`/`updateViewPrefs()`——模块级单例
  缓存（vite shared chunk，所有 ctx 同一实例）+ 写透 localStorage + 通知全部
  订阅者。折叠/未分组序在**任一来源**变更即实时反映到**所有来源**，无每 ctx
  陈旧副本，也无「B 写回覆盖 A 新状态」的复活问题。
- 裁剪规则（写入时）：**空投影不裁剪**（未就绪投影绝不抹用户偏好）；只裁
  **本会话内见过、现已从投影消失**的来源键（断连来源的折叠/未分组序保留，
  重连恢复——渲染侧 `reconciledSessionOrder` 跳过未知 id）。**seenSources 为
  会话内内存簿记，绝不从存储恢复**：持久化它会令重启后首个写周期（roster 未到、
  投影仅 local）把上一会话见过、当前尚未加载的远程来源误判为「已删除」而永久
  抹掉其偏好；上一会话删除、本会话未写过的来源残留 ghost 键（渲染侧跳过未知
  id，体积可忽略，接受）。

### 3.2 未分组序

- `ungroupedOrder[sourceId]` 由 §2 拖拽提交写入（经 `updateViewPrefs`）；
  渲染期 `reconciledSessionOrder` 应用（stored 优先 + 新游离按 recency 追加）；
  未知 id 由渲染侧跳过。

### 3.3 代码落点

- `shared/view-prefs.ts` + `shared/index.ts` 再导出；`SidebarRoot.tsx`
  经 `getViewPrefs`/`subscribeViewPrefs`/`updateViewPrefs` 读写；
  `test/session-state/view-prefs.test.ts` 覆盖存储单例/通知/裁剪（node:test 风格）。

## 4. 运行时事实通道（完成/待交互点 + 跨来源当前会话高亮）

### 4.1 事实来源（每 ctx 运行时）

- `ctx.sessions.list`（ObservableSnapshot）行字段：`running`、`completed?`、
  `pendingInteraction?: 'approval'|'plan-review'|'question'`、`blank`、
  `updatedAt`；快照含 `current?: string`（当前会话 id）。（「蓝点」= 这条完成未读
  事实，渲染为 §4.3 的 chamber 品牌蓝点。）
- 每实例 boot = 独立 ctx、独立 store；侧边栏插件在每个 ctx 都挂载，即每个来源都有
  一个可订阅自身运行时的事实生产者。
- **插件 = 投影**：上报端只做快照投影——`current` + 每列出会话的实时 `running`
  位 + vendor 已武装的 `completed`/`pending`，除 design 24 §12 的**purged 墓碑
  抑制集 + 收敛链**（唯一自持状态：内容已删的 id 从上报中过滤）外**不自持
  状态**。官方 `completed` 提醒只在
  「运行→空闲」边沿且会话**非本 ctx selected** 时武装，而后台来源 shell 的
  selected 保持「最后打开」不随活动视图更新，会把
  后续完成误判为「正在阅读」而永久压制蓝点——因此**蓝点武装/解除整体上移到
  App 层**（它拥有活动视图与全部 open 请求，是唯一知道「谁在阅读什么」的
  地方），由 App 从上报的实时 running 位自行推导 running→idle 边沿（规则与
  vendor 提醒同构，仅把「正在阅读」从「本 ctx selected」换成「活动视图的
  current 会话」）。App 状态机见 §4.2；插件侧无重复状态、不碰任何来源
  selection（无竞态、会话保活不受影响）。
- **运行中子 agent 计数**：插件另上报每父会话 `runningSubagents`——vendor 纯函数
  `indexSubagentDescendants(byId)` 的 runningCount（经不间断 subagent 起源链统计
  的后代 running 数，官方 ui-workspace tree 的 `runningSubagentCount` 同一
  算法），动机与语义见 §4.5：父会话 running 位只反映「agent 回合进行中」，后台
  子 agent 存活时父回合已结束（running=false）、子 agent 仍在工作——没有这条
  计数，完成蓝点会在子 agent 干活时提前亮起。

### 4.2 通道 API（chamberBridge 扩展）

> 接口定义（`InstanceRuntimeReport` / `registerInstanceRuntimeProducer` /
> producer `report/clear` / `onRuntimeReport`）以 **05 §3** 为权威（v1 契约），
> 本节只描述**上报时机与对账规则**（不再重复 TS 定义）。

- 每 ctx 插件 apply 内先为该来源注册一代 runtime producer，再由 effect 订阅
  `ctx.sessions.list`；订阅后立即 `report` 一次当前快照（subscribe 不即时触发），
  其后每次变更继续上报投影（`{ current, sessions: { id: { running, completed?,
  pending?, runningSubagents? } } }`，每列出会话都有 running 行，runningSubagents
  仅 >0 时出现——vendor `indexSubagentDescendants` 的 runningCount，见 §4.5）；
  effect 清理时调同一 producer 的 `clear`。注册时的单调 token 使旧 ctx 的迟到
  `report/clear` 全部失效，不能覆盖或清除同 id replacement ctx 的事实。
- App 侧：`runtimeFacts` state；**`completedBySource` state + `prevRunning`
  ref——App 自持的完成未读蓝点状态机**（06 §4.1），每次上报对账——
  - 武装：running→idle 边沿，且该会话不是活动视图 current（后台来源无阅读者，
    全部武装——正是 vendor 陈旧 selected 会漏掉的那个）；
  - 解除：重新运行（running=true）、会话从列表消失、或用户开始阅读（该来源为
    活动视图且会话为其 current；视图切换生效时另有一处 effect 兜底「激活但无
    新上报」路径，如点击来源头不打开会话）。
  - `deriveServers` 把 `completedBySource` 与上报的 vendor `completed` 取并集
    合并进 `ChamberServerAggregate.runtime?`（仅附加，不覆盖 polled 字段）；
    `pollAggregates` 的 not-connected 分支清空该来源**上报事实**（断连即清，
    generation 级事实随断连失效）；App 自持蓝点与边沿记忆跨断连保留——重连后
    重新挂载，且能捕获断连期间完成的会话（prevRunning 持有断连前 running=true）。
- 对账逻辑是**纯函数** `shared/derive.ts reconcileCompletedFacts`（单测见
  `test/session-rows/derive.test.ts`）：App 在 `setCompletedBySource` 的函数式
  updater 里调用，每份上报各自捕获 `prevRunning` 快照——同来源两次上报落在同一
  渲染周期时按序组合，不会互相覆盖丢蓝点。
- **未读判定与事实携带（plan §3.2/§5-3/§5-13、W2）**：`runtimeFacts` 每条上报另带
  `listComplete?: boolean`（vendor list store `phase === 'ready'`，即本客户端至少成功拉过一次基线——
  蓝点缺席剪枝的唯一门控）与 `stale?: boolean`（断连/主机不可达时仍可附加的只读事实，R14）；
  未读是**纯谓词** `shared/derive.ts deriveUnread(completedAt, lastTurnEnd, readThrough, updatedAt)`：
  `unread ⟺ max(updatedAt, completedAt) > readThrough`，`completedAt` 在 turn-end 分类为 `completed`
  **或分类缺失**（watcher 的降级标记，R12 回退现状）时计入，已知非完成（aborted 含 `user`、blocked、
  error、max-tokens、interrupted）抑制；全部比较都在 host 时间域，谓词不读账本、不读客户端墙钟。
  `mergeRuntimeFacts(runtime, completedBySource, overlay?, stale?)` 保留两参逐字节相容，第三/四参用于
  事实注入与 stale 附加；`todo-attention` 对断连来源只渲染 `runtime.stale === true` 的事实（R14 方案 A）。

### 4.3 UI 语义（状态指示）

- 行尾为**固定 10px 状态槽**（非常驻身份点——来源身份由来源头折叠字形
  accent + 激活左内边线 + rail 点承担；来源头身份圆点已移除）：
  - 常态（不运行、未完成、无子 agent）：空槽（保留宽度，行右缘跨行对齐）；
  - 运行中：官方 `StateDot` **ongoing 圆环**（`--dsw-static-deepseek-450` 蓝色
    chase ring）；
  - **子 agent 运行中**：同一 ongoing 圆环，tooltip/aria「N 个子代理运行中」
    ——父回合已结束但后台子 agent 仍在工作时会话依旧"进行中"，**绝不在这个阶段
    亮起完成蓝点**（§4.5）；
  - 运行结束未读（completed）：**chamber 品牌蓝点**（`.stateCompleted`，6px 实心
    圆点、`background: var(--dsw-static-deepseek-450)`，居中于 10px 状态槽；
    tooltip/aria "已完成"）——列表行与待办条带共用这一个类。**有意偏差**：官方
    `StateDot state="done"`（10px，success 绿 `--dsw-alias-state-success-primary`
    = `--dsw-static-green-500` `#22C55E`）与**来源头连接绿点同一 token**
    （`sidebar-chamber.module.css` `.statusOk`），同侧栏里"会话完成未读"与
    "服务器已连接"会同色，故**不用官方 done 色**；它与运行中同属
    品牌蓝（`--dsh-state-ongoing` 同为 `--dsw-static-deepseek-450`），但 6px 实心点
    与官方 10px 八格追逐环可区分。沿革：≤0.2.4 品牌蓝点 → 0.3.0-beta.1 官方 `done` 绿点 → **品牌蓝点**；
    武装/解除事实与通知边沿逻辑未变。判据按此钉住：蓝点必须存在、
    `StateDot state="done"` 不得回归、运行环仍是官方 ongoing。
  - **活动定时任务标记**：行标题之后渲染官方
    `ActiveScheduleIndicator` 同形标记（16px 闹钟字形 + `role="img"`，可访问名与
    title 都是本地化 `schedule.active`，行本身仍是唯一动作），事实 = 该会话
    `projectionValues.schedule` 非空（`derive.ts hasActiveScheduleOf`，
    镜像 vendor ui-workspace `tree.ts:161-163`）。**稀疏字段**：只有真有活动定时
    任务的行发布 `hasActiveSchedule`，且该位纳入 `instanceSnapshotSignature`
    （否则置位/清位重发布同一份字节会被 producer 去重闸吞掉、标记冻结在首见值）；
    未挂载来源的 unary 兜底行读 `projections.values` 的同一事实；无定时任务的行
    零足迹。
  - **待交互（pending）**：不与运行中同形——槽加宽至 14px，按类型渲染**可辨识
    图标徽标**（会话在等用户，必须一眼可辨，ask-user 是动机场景）：`question` = 问号（business 蓝）、`plan-review` = 清单（business
    蓝）、`approval` = 警示三角（warn 琥珀）。
    tooltip/aria 沿用 `status.waitingAnswer/planReview/waitingApproval`。**定稿**：官方对三种 pending 一律渲染
    `StateDot state="warning"`（10px 琥珀圆点，**形状不区分类别**，只有悬停卡与
    读屏文本区分）；chamber **保留**图标徽标形态，不随上游对齐而改。同批确认：
    ongoing（运行中/子代理进行中）与官方**同组件、同默认 10px**；completed 用
    chamber 品牌蓝点（有意偏差 = 与来源头连接绿点同 token）。**配色**：运行 =
    `--dsw-static-deepseek-450`；completed = 同一品牌蓝 6px 实心点（**不取**官方
    `done` 的 success 绿）；pending 徽标用 business/warn 两个 state token 表达
    "等待回答/决策"与"等待批准"（有意不取全蓝）。wire running 与通道事实并存：
    running 点保留（wire 权威），completed/pending 仅通道提供。
- **悬停替换（真正替换，零占位）**：行/头操作静止时 `display:none`（不占布局
  空间），状态图标/徽标因此真正位于行/头末端；悬停时操作簇 `display:inline-flex`
  换入、状态槽 `display:none` 换出（session 行：状态环 ↔ **kebab 菜单**（重命名/
  分叉/归档——归档动词移入行菜单；归档只隐藏行、
  不触碰会话日志）；来源头：连接状态 ↔ 排序菜单 + 搜索 + 添加工作区（官方
  project-add 字形，`IconProjectAddOutline16`）；workspace：会话数徽标 ↔ `+`（新建
  会话）+ kebab（重命名/删除））。胶囊/菜单展开时操作簇保持显示
  （`.sourceActionsVisible`/`.rowActionsVisible`，`:has` 同步换出状态槽）。
- **不再显示相对时间**：session 行不渲染"xx 前"时间单元格（`time.*` locale 键
  **保留供 hover 卡相对时间使用**；`relativeTimeBucket` 纯函数保留为共享工具）。
  相对时间列**暂不回归**（多来源密度 + 行尾状态槽取代时间列）；若未来回归需
  同步修订 05 §2.1 的文案。
- **当前会话高亮 = 全局单选**：`server.runtime?.current` 命中即高亮，但仅限
  **拥有当前可见 ctx 的来源**（渲染侧 `server.id === chamberInstanceId` 门控）
  ——各来源壳内"切换前最后一个"会话不全部高亮，全局只有一个高亮（正在查看的
  会话）。（组件不直连 store，订阅在插件上报端；boot 首帧无上报前不高亮，随首次
  上报补齐。跨来源 pending/completed 状态点仍全来源呈现。）
- **状态点优先级**：**pending 徽标 > runningSubagents 运行环 > completed 点 >
  running 环**。completed/pending/runningSubagents 来自 runtime facts，
  `running` 来自完整 aggregate snapshot；两者均由已挂载 ctx 的同一 sessions
  store 事件驱动，但独立 bridge state 可能相差一个 React commit。
  runningSubagents 同样压过 running 环与 completed 点（vendor 保证 completed 与
  running 互斥）。官方 sessionStatuses 的「有运行中子 agent 就显示 ongoing」语义
  原样对齐（chamber 为避免瞬时双通道错位把用户需处理状态前置）。
- **运行环 snapshot 单一权威（`runningRingVisible`）**：运行环只取完整
  aggregate snapshot 的 running 位，runtime facts 的 running 不参与渲染。已挂载
  来源的 snapshot 由自身 ctx store 在 host-frame 事件上即时上报；未挂载或
  reconnect baseline 未完成的 ready 来源走 30s unary 兜底。两条字段不做 OR/优先
  合并，避免同一渲染事实双权威。`runtimeReportSignature(includeRunning=false)`
  保证 runtime 通道的 running-only 变化不重复驱动同一环渲染；通道 running 位仍保留
  在 `InstanceRuntimeReport` 中，供 App 完成蓝点状态机
  （`reconcileCompletedFacts`）推导 running→idle 边沿（App 内部逻辑，非侧边栏
  渲染）。
- **搜索结果行状态点**：结果行经投影解析 running 位（命中会话必在投影可见集内，
  查得到即用投影位，查不到回落 false）——状态槽优先级与 running 环 snapshot 权威
  同树行（只取投影位，runtime facts 的 running 不参与，`runningRingVisible`）。
  已知窗口（接受）：未挂载来源的兜底拉取失败期间树行整体消失（错误横幅替代），
  搜索结果行运行环随投影为空回落 false；槽**恒占位**。

### 4.4 代码落点

- `shared/aggregate-store.ts`（通道 + `ChamberServerAggregate.runtime?` +
  `runningSubagents` 行字段）、`client/index.ts`（订阅与投影上报 + design 24 §12
  墓碑抑制/收敛链 + `indexSubagentDescendants` 注入）、`App.tsx`（runtimeFacts +
  completedBySource 对账/合并/清理/激活兜底；runningSubagents 随事实行透传）、
  `SidebarRoot.tsx` + `sidebar-chamber.module.css`（dot 状态类 + 高亮 +
  runningSubagents 分支 + `.scheduleIndicator` + `.railDotButton`）、
  `shared/derive.ts`（`hasActiveScheduleOf`；`hasActiveSchedule` 进
  `instanceSnapshotSignature`）、`shared/instance-api.ts`（unary 兜底行读
  `projections.values` 同一事实）、`shared/session-row-window.ts`
  （`sessionRowWindow` + `sessionRowDisclosure`）、`locales.ts`
  （`status.waitingApproval/planReview/waitingAnswer/completed` +
  `status.subagentsRunning.one/other`）。

### 4.5 运行中子 agent（runningSubagents 圆环）

**问题**：agent 状态是二元的——`status = phase.kind === 'idle' |
'maintenance' ? 'idle' : 'running'`，driver 在工具调用 await 期间不释放
running 相位；会话 running 位 = agent.status === 'running'。subagent 工具两种
运行模式：**one-shot（默认，前台等待）**——父回合 await 子 agent，父 running
保持 true；**后台（run_in_background: true / continuable 默认）**——工具立即
返回，父回合先结束（running=false），子 agent 继续在后台工作。官方
`completed` 提醒在父 running→idle 边沿武装（manager.ts
syncCompletedNotifications），官方 UI 的 sessionStatuses 把「有运行中子
agent」（runningSubagentCount > 0）排在 node.completed 之前——官方保证
「子 agent 在跑就显示 ongoing」，即使父会话自身已 completed。

**缺口**：侧边栏状态链只有 pending > completed > running 三档，
无 subagent 信号——后台模式下父回合结束即武装完成蓝点，子 agent 仍在干活时
蓝点就亮了（且保持到用户阅读或父再次运行）。

**修复**：
- 插件（vendor 边界）在每次快照投影时调用 vendor 纯函数
  `indexSubagentDescendants(snapshot.byId)`，把每父会话的 runningCount
  （>0 稀疏）并入事实通道——与官方 tree.ts 的 `runningSubagentCount` 同一
  算法同一输入，语义不可能漂移；`shared/derive.ts projectRuntimeFacts` 保持纯
  （计数经参数注入，import 图不引入未构建 vendor 包）。
- 渲染优先级改为 **pending 徽标 > runningSubagents 运行环 > completed 点 >
  running 环**：子 agent 存活期间绝无完成蓝点（对齐官方 sessionStatuses）；
  子 agent 全部结束后蓝点正常浮现（App 的 completedBySource 边沿状态机无需
  改动——蓝点在子 agent 运行期间保持武装但被渲染压制，与官方「completed 保持
  武装、subagents 分支优先呈现」同构）。
- tooltip/aria：`status.subagentsRunning.one/other`
  （官方 copy：`{n} 个子代理运行中` / `{n} subagent(s) running`）。
- **可呈现性三值（P5，2026-12）**：计数只说明「索引在场时算出了几个运行中的后代」，
  不是「正在干活」的证据。父行改带 `subagentActivity: none | running | unknown`：
  索引缺席或来源 stale（R14）时读数是 `unknown`，中性呈现——不点亮子代理圆环/播报，
  也不据此压制 completed/running 读数与待办条目；`runningSubagents` 保持稀疏计数供诊断。
  守卫单源 = `shared/session-row-state.ts` 的 `subagentActivityOf`（行读数、圆点、待办共用）；
  上游完整性信号落地后删除本地 fallback（见 `docs/progress/todo/upstream-proposals.md` §7）。

**残留（记录）**：one-shot await 期间父回合与子 agent 同活，我们只显示子 agent
计数文案（官方显示「运行中」主标签 + 计数次标签；圆环同形，仅 tooltip 单值取舍）；
聚合轮询陈旧（≤一个轮询周期）时两环瞬时同形，取实时通道为真。

### 4.6 文档级全局量的活动视图归属（N-ctx）

- **缺陷**：官方 `ThemePresenter`（vendor
  `packages/client/ui-layout/src/client/theme-presenter.ts`）把主题投影到
  **文档级**状态——`html{color-scheme}`（原生控件/滚动条）、
  `body[data-ds-dark-theme]`（token 调色板）、`--dsh-content-font-size`、
  一个 `theme-color` meta——且 `dispose()` **无条件回收**它们。chamber 把 N 个
  实例壳挂同一份文档，每个挂载视图各跑自己的 ui-layout fiber ⇒ N 个 presenter 争夺
  同一组全局量：隐藏视图（空闲预热）的 apply 重绘可见视图，其 teardown（retention
  回收）**抹掉可见视图的投影**，把 dsh 浅色默认调色板（`design-platform.css` 的
  `body` 块，无属性即浅色）与 chamber 壳的 `:root{color-scheme}` 兜底拼在一起
  ——「浅色界面 + 深色原生 checkbox」到某次 theme/change 或重挂载才自愈（用户观察：
  点服务器/切主题后刷新才恢复）。
- **归属规则**：文档级全局量只由**活动视图**的实例写。纳入该规则的两条——**主题**
  （以下各条）与**页面语言 `<html lang>`**（见下方「页面语言（`<html lang>`）
  归属」）——共用同一份「谁在屏上」权威与 producer+projector 模式；其余写入者见
  下方「同族残留」。App 是「谁在屏上」的唯一权威，经 page-wide chamberBridge
  发布（`setActiveSource`/`getActiveSource`/`onActiveSource`，
  `shared/aggregate-store.ts`）；ui-layout fork 的 `document-theme.ts` 按
  `ctx.chamberInstanceId` 门控：非活动视图**不写**文档，变为活动视图时用最近
  快照重投影（无需新的 theme/change），teardown **永不回收**文档（全页单例
  presenter 交给下一个活动视图复用，retraction 集天然是"上一个 applier 的 token
  集"）；活动来源未发布、或 boot 无 `chamberInstanceId`（官方单壳形态）时**失败
  开放**为旧的无条件行为。
- **兜底值**：chamber `styles.css` 的 `:root{color-scheme}` 与「无属性即浅色」
  的调色板默认对齐（`light`）；活动实例投影落地后由 `html` 内联值覆盖。
- **代码落点**：`packages/dsh-chamber-client-ui-layout/src/client/document-theme.ts`
  （纯投影器 + 单测 `test/document-theme.test.ts`）、`src/client/index.ts`
  （全页单例 presenter + effect）、`packages/renderer/src/App.tsx`
  （活动视图发布，`useLayoutEffect` 保证绘制前生效）、`shared/aggregate-store.ts`
  （活动来源事实 + 单测）、`packages/renderer/src/styles.css`（兜底值，
  源码级钉子 `packages/renderer/test/frame-chrome/theme-fallback.test.ts`）。
- **页面语言（`<html lang>`）归属**：官方 locale 服务的
  `syncDocumentLanguage` 在**每个实例壳**的 ctx 里无条件写
  `document.documentElement.lang`——激活时一次、之后**每次字典注册**再写一次
  （`@deepseek-ai/dsh-client-locale` 的 `apply()` → `sync()`），无 teardown、
  无活动来源判定。N 壳同文档即 last-writer-wins：预热/收割壳的 en
  （`detectBrowserLocale` 只认已注册语言，`navigator.languages` 指不到 zh 时
  回落 en——**运行形态相关**：打包配置按平台拼写裁剪 locales（mac 腿 = 实际 lproj
  基名 `zh_CN`，win/linux 顶层 = `zh-CN`；见 S-47），dev/整包形态可能直接报
  zh-CN）会把可见中文文档翻成 `lang=en`；**框架 chrome 也按该属性解析**
  （`renderer/src/locales.ts`），用户可感形态是「本地实例 / Local instance」在
  boot 期间来回闪烁，最终由"谁最后写"决定。
  - **归属规则**：页面语言 = **屏上来源**（App 的 `activeView`，默认恒为本地
    实例）**设置面已敲定**之后的语言；**设置面未敲定期间**的 provisional 永不
    拥有页面（含屏上来源自己的）；后台/预热壳的任何写入一律被就地回写；切到
    尚未敲定的来源时保持当前页面语言，等它敲定再切一次（敲定后该实例的**有效
    语言**才成为页面语言——没有存过偏好时即其仍在用的浏览器兜底值）。
  - **机制**：`renderer/src/page-language.ts`（纯投影 + 页级 owner，带
    MutationObserver 兜底）＋ `renderer/src/locale-ownership.ts`（每 entry 上报
    钩子：读 vendor LocaleFace 的 active，用 `ctx.settingsScope.bind({namespace:
    'locale'})` 的 status 判「设置面已敲定」）＋ `chamber-entry.ts` 挂载装饰器
    （`decorateMount` 在 vendor `apply()` **之后同栈**运行，"vendor 写 →
    归属器回写"落在同一同步任务、中间不可能绘制；首屏 `register` 与 `registerDeferred`
    **两条挂载路径**都过装饰器）＋ `main.tsx` 在任何壳 boot 前安装 owner（served
    markup 的 `lang` 即冷启动值）＋ `App.tsx` 在发布活动来源的同一
    `useLayoutEffect` 里发布给它。三处加固：① owner 在**页级
    全局槽**（`globalThis` 上的 `__dshChamberPageLanguageOwner__`）——frame 与
    composite 入口是两个 chunk，重估（HMR）或未来拆构建不得产生第二个
    owner/观察者；② 事实带**挂载世代**（`mountGeneration`），退出的旧挂载不能
    抹掉同 id 新挂载的事实；③ 绑到的 settings scope 与 LocaleFace 一样做**形状
    检查**，坏形状 fail-open 而不是把异常抛进 vendor fiber。
  - **失败开放**：无 `chamberInstanceId`（官方单壳
    形态）/读不到 LocaleFace/绑不到 settings scope 时该壳**不参与归属**，其语言
    永不被采纳（页面停在当前语言，直到出现可归属来源），但页级归属器仍把它的写入
    回写为当前页面语言（不会闪）；"vendor 行为完全不变"只对**根本不装归属器**的
    官方单壳形态成立。`registerDeferred` 挂载同样过 `decorateMount`，未来把受
    装饰 id 移进 `DEFERRED_ROWS` 时不静默失去归属。
  - **既定结果**：设置桥可编辑**非活动**来源的设置，其中 ctx-free 时间戳渲染
    （`DshRuntimeSection.tsx` 的 `formatTimestamp`）按页面语言（= 屏上来源）
    取值——"只有屏上实例能拥有页面语言"的直接推论，不是缺陷；要让设置面跟随被
    编辑来源的语言需另立规则（未采纳，本版不做）。
  - **被否的替代方案**：**vendor fork 门控**（`dsh-client-locale` 纳入 in-repo
    fork 并按 `chamberInstanceId` 门控）语义等价、写入点更干净，但该包要进受保护
    集合与 upstream-touchpoints 登记、每次升级背维护，而 composite 已有同栈挂载缝
    （`decorateMount`）；**构建期 vendor patch**（`scripts/vendor-patches.mjs` 加
    C9 锚点，在 `syncDocumentLanguage` 里门控 `ctx.get('chamberInstanceId')`）同样
    更干净，但埋进 vendor 文本重写、锚点是每次升级的常驻成本，仅在观察者回写被证明
    不够时升级；**只在框架侧解耦**
    （框架改读来源事实而非 `document.lang`）只消框架 chrome 闪烁、`document.lang`
    本身仍错（a11y `:lang`、语言相关 CSS、settings-bridge 的 ctx-free 读取点仍
    跳），属症状级；**页面语言长期归本地实例**与 design 05 §4「文档级全局量由活动
    视图独占」冲突；**只按活动来源门控、不判"设置面已敲定"** 会让本地实例自己的
    provisional 把默认进入闪一次。
  - **证据**：`packages/renderer/test/frame-chrome/page-language-hook.test.ts`
    （真实 decorator + 真实归属器、stub DOM 端到端：locale 映射与 writer/reader
    配对、规则状态机与挂载世代、同栈回写 / 后台壳 / 切换等待 / fail-open 形状、
    安装顺序与接线锁）、`frame-locale.test.ts`（frame 读者映射）、
    `theme-fallback.test.ts`（活动来源发布锁）、`required-extra-rows.test.ts`
    （两条挂载路径的装饰器形状锁）。
- **同族残留（非本节修复面）**：同一文档里其它 document-global 状态被逐实例写/
  监听，属同一"N-ctx 单文档"缺陷族：①**文档级 `drop` 扇出（真实缺陷）**——vendor
  `ui-attachment` `ComposerAttachments.tsx` 在 document 挂 drop 监听且无
  containment/活动视图判定，local 与任一挂载远程同时在场时拖入图片会同时附到
  **两个**实例的草稿（修法需 vendor patch：按 event.target 归属或按活动来源
  门控）；②**`document.title`**（机制上仍活着，被主进程冻结窗口标题掩盖）——
  ui-layout fork deep-import 官方 `AppFrame`，其 `DocumentTitle` 每个壳竞争写/清；
  它**不**并入页面语言归属器（被拥有值是语言，没有会话标题投影），将来归属点是
  与 `document-theme` 同址的 ui-layout fork（按 `chamberBridge` 活动来源门控）或
  ui-layout vendor patch；
  ③**`--dsh-content-font-size` 播种**（vendor `bootstrapFontSize` 读 body 变量）
  会读到"上一个 applier"的值，下一次投影自愈；④**portal 逃逸（真实缺陷，部分
  收窄）**——vendor `ui-primitives/Modal`（含 backdrop）与 chamber 的
  SettingsShell 都 portal 到 `document.body`，而 `.instance-hidden` 只隐藏视图
  子树：视图 A 里打开的模态在程序化切换（深链/通知/注册表回落）后仍盖在 B 上；
  **唯一收窄的是 open-in 的 chevron 菜单**（design 20 §5）：菜单本体是官方 `ui-primitives` `Menu`（portal 到 body），但
  N-ctx 归属守卫 `instance-view-guard.ts` 在菜单所属 `.instance-view` 失活
  （`instance-hidden`/`instance-pending`/`hidden`/`aria-hidden`/断开）时立刻
  关闭它；SettingsShell Modal 与其它官方 portal 面仍未修，同族
  `ui-attachment/DropOverlay` 每个挂载中的 ComposerAttachments 各渲染一份（N 层
  遮罩）；⑤**主题样式表重复**——vendor `installThemeStyles` 每个实例 ctx 各插 6 个
  `<style>`（同内容，随各自 fiber 移除，良性重复）。① 的治本同本节：按活动来源
  门控，但落在 vendor 源码，需 seed/patch 路线裁定后实施。

## 5. 已知取舍与开放项

- **flat 单列表模式：推迟（维持不排期）**——与 05 §2.1「仅按来源分类」呈现
  原则有张力。
- 跨实例 `dsh.sessions.current` localStorage 共享键（last-writer-wins）：
  接受——镜像运行时既有行为，通道原样携带。**代价**：共享键使每个壳冷
  boot 都"没有可恢复的会话"，官方初始导航随即在其最近工作区复用/新建（宿主侧
  `session.create`）一个 blank 会话并打开——包括后台预热/基线收割这类用户没点过的
  挂载；chamber 的打开意图三闸门只消除**用户可感的中间态**，不阻止那次 create。
  偏差登记见 design 05 §2.2.1「登记残余」与 STATUS「远端宿主上的空白会话残留」，
  根治提案见 `docs/progress/todo/upstream-proposals.md` §1。
- **完成发生在来源 shell 首次观察之前仍无蓝点**：App 蓝点与 vendor 提醒同受
  「首次观察只记录 running 位」规则，来源 shell 未挂载（预热排队中/首次打开前）
  期间的完成边沿两者都看不到。空闲预热
  保证连接后尽快挂载，该窗口为「实例就绪 → shell boot 完成」，活动来源完成即时
  可见。不做轮询级完成推导（10s 粒度会漏掉
  更短任务，且与「running 点 wire 权威、completed 仅通道提供」契约冲突）。
- **App 侧蓝点跨断连保留**：上报事实（runtimeFacts）断连即清（generation 级），
  App 自持的 completedBySource/prevRunning 跨断连保留——断连期间完成的会话重连后
  仍正确武装（prevRunning 持有断连前 running=true，重连基线 running=false 触发
  边沿）；侧边栏断连时本就无行可显示，蓝点不闪烁。
- 结果标题滞后 / 聚合错误源隐藏搜索 / rail 无搜索：接受（§1.2）。
- 拖拽无 touch/键盘：已知限制（官方亦然，Electron 桌面）；拖拽乐观重排不设回滚：
  pull 模型自愈 + inline 错误，接受。

## 6. 验证门

- 纯函数单测：`reconciledSessionOrder`、`view-prefs` 读写/单例通知/裁剪、
  搜索 sanitize、`todo-attention` 派生、`todo-prefs` 水合
  （`test/session-rows/derive.test.ts`、`test/session-state/view-prefs.test.ts`、`test/session-rows/todo-attention.test.ts`、
  `test/session-state/todo-prefs.test.ts`，node:test 风格）。
- **上游对齐判据**：以下对齐面仍是契约（判据见该包测试）——归档
  动词只在行菜单、全包无原生 confirm、workspace 删除是官方 `Modal` chrome（含对话框内
  `role="alert"` 失败行与「仅成功才关闭」）、**同一时刻至多一层 chamber Modal**（见下）、
  completed 走 chamber
  品牌蓝点（官方 `done` 绿点因与来源头连接点同 token 被否）、
  行窗口是双向 disclosure、行菜单 `closeOnPointerLeave` 且 `compact`
  （`compact` 一项由"非 compact"改回，见 §7 菜单密度口径）、
  `{name}` 参数化可访问名、活动定时任务标记的位置、`data-git-action`
  属性钩子（`:disabled` 在方括号之外）；行为面单测在函数旁边
  （`test/session-rows/session-row-window.test.ts` 的 disclosure 窗口、`test/plugin-kernel/panel-source.test.ts`
  的 `createSnapshotStore` 投影与通知纪律）。
- **同一时刻至多一层 chamber Modal（对称门）**：
  官方 `Modal` **没有焦点陷阱**（vendor
  `ui-primitives/src/Modal.tsx`：一层 body portal 遮罩 + 每个打开实例各自一个
  document 级 **BUBBLE** Escape 监听），而「孤儿徽标」是常驻、可 Tab 到的按钮
  （`ServerSection.tsx` 的 `cc.orphanBadge`，在 hover 簇之外），键盘用户可 Tab 到
  任一遮罩之后武装第二层，两层各注册 Escape 监听、一次 Esc 双关（design 24 §6 项 7
  正是归档管理器拒绝第二层的理由）。真不变量落在**打开方**、不在遮罩：
  `SidebarRoot.tsx` 的单一谓词 `otherChamberDialogOpen(self)` 被**全部三个打开方**
  咨询——删除武装（`onDeleteWorkspace`）、归档管理器（`onOpenArchiveCleanup`）、
  添加工作区浏览器（`openWorkspaceBrowser`；节 `ServerSection` 只拿得到这个带门的
  opener，拿不到裸 setter）——每个子句排除自己那一层，故**任一方向**最多只可能有一层；
  被拒的控件在该层消失（cancel / X / 遮罩 / Escape 均可）后立刻恢复，能力不丢。
- 包级门：`pnpm run typecheck`、根 `typecheck`、`typecheck:layout`、
  `typecheck:sidebar`、`pnpm run build:renderer`、
  `pnpm run verify:i18n`、`test:sidebar`、`test:layout`、
  `test:renderer-shell`；control-plane 套件为回归门。

## 7. 样式定稿（设计）

- **Token 契约**：取 dsh 设计平台 token——状态色
  `--dsw-alias-state-{success,warn,error,business}-primary`（completed 点 /
  connected 徽标、pending 点、错误文本）、运行中点 `--dsw-static-deepseek-450`
  （running 蓝）、搜索胶囊 focus 边框 `--dsw-alias-brand-primary`、折叠
  chevron `--dsw-alias-label-caption`、来源头底色 `--dsw-specific-sidebar-fill`；
  不存在的 `--dsw-alias-accent/success/danger/input-fill` 一律不得使用。
- **来源 accent**：每元素 `--chamber-source-accent` 承载远程来源 hue
（**柔和色板：`hsl(hue 34% 61%)`**；本地来源省略、回退默认
  ink），用于来源头激活左内边线与 rail 活动环（**workspace 组 chevron 不取来源
  accent**——workspace 图标自带确定性 accent，见下条）。**来源头身份圆点移除**
  （折叠字形 accent 承担身份；rail 点保留）。
- **workspace 图标 accent**：workspace 头行内联 `--chamber-workspace-accent`
  （`.foldToggle` 基色/hover 同取，图标走 currentColor）——色相 =
  `(serverId, 家族种子)` 哈希 × 137.508 黄金角步进 mod 360，明度 = 56/61/66%
  （第二哈希抖动，近色相兜底）；家族种子 = `repoKey`（worktree 与主检出共享
  家族色相，主检出未注册/改名不漂移；`mainWorkspaceId` 仅为无 repoKey 时的
  回退），worktree 降饱和 **21%**、主检出/普通 workspace **34%**（低饱和高明
  柔和色板）；未分组桶无 accent 回退 caption ink。来源首个 git 快照发布前
  accent 一律不渲染（默认 ink），`isSourceGitFlagsLoaded` 后整源一次性落定
  最终色；无用户自定义、无持久化、**与选中态无关**（纯函数
  `workspaceAccentStyle`，shared/derive.ts；当前会话指示由 session 行官方
  selected tint 承担）。
- **当前会话高亮（对齐官方 selected 处理）**：session 行 = 官方
  `.sessionRow.selected` 的浅 `interactive-bg-hover` 色调（无 inset 阴影、无
  深色调、无标题加粗）；所在 workspace 组 = 无底色、图标色恒定（来源 accent
  不参与 workspace 级高亮），两组高亮永不相邻融合，色调全为官方 token 浅档。
- **打开意图在途 ⇒ 不投影"非请求中"的 current（05 §2.2.1）**：来源
  还有在途 `openSession` 且其投影 `current` **不是**请求会话时，不投影
  `runtimeFacts.current`（`projectableCurrent` 纯函数）——"切到远程会话先闪一行
  高亮新会话"的侧栏半边（冷 boot 期间官方初始导航先选中 blank 会话，
  `(!blank || current)` 随即渲染出高亮 New Session 行，下一次分发（最多 400ms）又
  消失）。**幂等重开保持高亮**（current 已是目标会话 ⇒ 投影本就正确，摘掉再装回只是
  闪烁）；离开的活动来源的 blank 行仍由 ghost 槽（§2.2）保护列表位移。
- **回声工作区行（05 §2.2.1）**：新建工作区后侧栏立刻渲染一行
  "回声"工作区（真实宿主 id、`sessionIds: []`、标题 = 路径 basename，同合成组
  规则）；它**不带 `synthetic`**，重命名/删除/新建会话等 workspace 级动作照常
  可用；与同路径合成组相遇时**原位替换**后者（绝不重复渲染同一目录）；来源挂载壳
  的权威 push 列出该 id（或同路径真实行）后由权威行接管。
- **排版**：字号下限 12px；会话标题 13/18——官方行 14px，13/18 是 chamber
  多来源密度的刻意折中。**墨色 = v0.2.4 的静止/hover 两级**（官方形态是"常驻
  `label-primary` 且无 hover 覆盖"，本页不取）：**会话行标题**静止 `label-secondary`、行 hover 转 `label-primary`
  （`.sessionRow:hover .sessionTitle`），**搜索结果标题**同规则
  （`.searchResultRow:hover .searchResultTitle`），**待办条带**同语言（`.todoRow`
  自带次级墨色、hover 转主色；`.todoRowTitle` 不自带墨色，随行两级）。理由：
  只按官方常驻主色时行 hover 只剩极低对比度底色 wash，500ms 卡片出现前读不到反馈。
  这是**对官方的有意偏离**（官方 `.title` 继承行墨、从不降级）：**字号仍是
  chamber 折中，墨色回 v0.2.4**；搜索结果与结果行的 **12/18 字号、结果行几何**
  仍归 §1.2 待决。来源身份点 8px（**仅 rail**——来源头身份
  圆点已移除，见上方来源 accent 条），session 行首为固定 10px 状态槽（常态空）。
- **行几何**：圆角 8px（来源头/workspace 头/会话行一致）；密度为多来源列表的有意取舍。
- **搜索胶囊**（§1）：`border-l2` + `:focus-within` brand 边框；`maxLength` 取
  `SEARCH_QUERY_MAX_CODE_UNITS`；30s 调用方 abort；结果分支优先于 aggregateError。
- **未连接来源呈现**：搜索入口按 `connected` 门控；**状态徽标语义见 05 §2.1**
  （色点/转圈枚举、重试折叠为稳定「重连中」态、相位文本仅在 hover/aria）；
  06 增量：状态槽居来源头右端、hover 时被搜索/`+` 簇替换显示；全部断开时保留
  各来源分组、空态提示为列表底部一行；断连即清空该来源搜索状态（重连从干净
  状态开始）。
- **行内操作（图标化 + 悬停替换）**：workspace 组头 = `+`（新建会话）+
  官方 16px 横排三点 kebab 菜单（重命名/删除，`Menu` primitive portal 模式；
  **排版修订**：横排省略号按官方原样 16px 横排（不旋转 90° 成竖排 14px），`.actionIcon` 20×20 命中盒不变；`+` 同期由 14px 提到官方
  16px）。**动作簇间距修订**：不取官方
  `Rows .rowActions` 的 12px（该 12px 只描述无 git occupant 的两项簇；含 occupant
  揭示态动作 `.headerGit`（同一行兄弟 flex 子项，08 §3.2）的三项簇会被切成 4px +
  12px）。簇统一走头部/本表图标节奏 **4px**（`.rowActions` 与 workspace 头部自身
  的 4px；`.headerGit`/`.sourceActions` 不在此列：其 4px 出自命中盒
  pass，现随该 pass 回到 v0.2.4 的 2px，见下方命中区条；session
  行簇只有单个 kebab），悬停替换会话数徽标；session 行 =
  **三点 kebab 菜单三项（重命名/分叉/归档，归档无独立图标按钮）**（悬停替换
  行尾状态槽；**session 不显示相对时间**）；**添加工作区** = 来源头部按钮
  （官方 project-add 字形，与搜索/排序图标并排成簇，悬停替换连接状态槽，
  胶囊展开时簇保持可见；文案在 aria 与**官方 `Tooltip`**——同批把来源头四个
  动作（排序/添加工作区/搜索/归档清理）从原生 `title` 换成设计系统 Tooltip
  （`ServerSection.tsx` 四处 `<Tooltip label=… side="bottom" delayMs={500}>`
  包装的头部按钮；按形状锚定，可 grep 的形状串是
  `side="bottom" delayMs={500}`），行与状态槽仍用原生 title）。替换为真正 display
  交换（静止不占位，状态图标真正居行/头末尾）；kebab 展开期间该行操作保持可见
  （`.rowActionsVisible`）；行内图标按钮全量 reset（`appearance:none`/
  `outline:none`/grid 居中，focus-visible 用 brand 自绘环）。**菜单密度 = chamber 档（取代"照上游"口径）**：三个菜单（session kebab /
  workspace kebab / 排序）一律用原语 `compact`——item 26px / 12px（= 列表行高），
  容器 r7/padding 2px/min-width 164、item r5；`closeOnPointerLeave` 保留。理由：
  "照上游"的官方默认（40px/14px，相对官方 32px 行高）与 `dense`（34px）对 26px 的行
  过大；v0.2.4 用的是 `compact`，本档即**恢复发布行为**（证据：`git show v0.2.4:…/ServerSection.tsx`
  三处 `<Menu>` 全为 `compact`；v0.3.0-beta.1 为
  0 处 compact + 1 处 `dense`）。**取舍**：`compact` 把圆角一并带回 r7/r5；pin 的
  `Menu` 虽收 `className` 但只落在根 `<span>` 上、**没有 list/item 钩子**，
  compact 规则也无 CSS 变量，故"26px 行 + r20/r10"不可得（不做 `:global` 覆盖哈希
  类名）。**compact 档里唯一低于 12px 的自家面**：排序菜单 `{type:'label'}` 取官方
  原值 `padding:4px 7px; font-size:11px; line-height:16px`（dense 档 12px）。另两点
  连带：**item 图标槽 14px**（默认 16px；唯一例外是 session 行菜单的 **20-native
  归档字形仍画 16px**——与 16-native 重命名/分叉的 14px 同视觉重量，几何锁按 16
  钉住）与**列表最小宽 164px / 内距 2px**（默认 218px / 4px）。设置页服务器下拉是
  自家 markup：`padding:7px 10px`、`font-size:13px`（v0.2.4 原值）、显式行框 18px
  （chamber 13/18 惯用），圆角/背景 = 官方（item r10、列表 r20 + `bg-layer-3` +
  elevation）。
- **图标钮命中区 = 视觉盒（回退命中盒 pass `33238ffe`）**：本页
  小于 24px 的六个图标钮（`.actionIcon` 20 / `.searchButton` 20 / `.searchClear` 18 /
  `.foldToggle`、`.sourceFoldToggle`、`.railDotButton` 16）连同该 pass 顺带加宽的
  `.sourceActions` 2→4px gap 一起回到 v0.2.4 几何：**命中区就是视觉盒，不再有不可见
  命中盒**。机制/实测与"缓解而非根治"的完整说明在 `sidebar-chamber.module.css` 的
  `.actionIcon` 注释块（唯一权威处）；一句话：rim 把按钮所在行/头部的"纯行"带压到
  ≈0–1px，指针离开该行时 Chromium 只发 native `pointerleave`、不发 `pointerout`，
  React 不合成 `onPointerLeave` ⇒ `hover-intent` 的 `inside` 保持 true ⇒ 悬停卡
  「关不掉 / 异常打开」。**它缓解的是排名第一的触发（日常从动作簇
  离开该行）**；无指针位移的触发（轮子/重排/插入、blur+dwell）与"极快甩动跨过恢复后
  的 ≈3px 带"仍在，根治需要不依赖 React 合成的投递通道（**未实现**，见 §7 悬停移植条
  与 `src/shared/hover-intent.ts`）。代价：24px 目标尺寸重新成为本模块偏差
  （design 24 §13 第 17 条、design 08 §3.4）。**簇间距**：`.rowActions` 4px
  与 footer 4px 保留；`.sourceActions` 与 git 的
  `.headerGit` 回到 v0.2.4 的 2px（其 4px 只出自该 pass，`46b522c9` 没碰它们）。
  **rail**：只回退该 pass 加宽的 `gap`（16→12px），点按钮化
  自带的 `margin: -4px 0` 保留 ⇒ 20px 点距 / 12px 可见间隙 = v0.2.4 节奏；**不要只删
  margin 而不改 gap**（点距会松成 28px/20px 间隙）。该几何有测试钉住（含「scoped
  重加 rim 也红」的选择器扫描）。**不要再加回 rim**：加之前必须重测按钮命中盒与
  行/头部边缘之间的纯行带。
- **会话行窗口与展开条**：每个 workspace 只展开前 N 行（`sessionRowWindow`），其余由展开条
  揭示。展开条用官方 `sessionOverflowButton` 几何：28px 高 / r8 /
  `0 12px 0 26px`（左内距取 chamber 会话标题列 26px，官方 28px）/ 12px 字 /
  hover 停留次级色（不取 3px 4px 内距、无高度无圆角的纯文本行形态）。展开条是
  **双向 disclosure**：`aria-expanded` 报告状态，展开后同一控件给出
  `sessions.collapse`（收起），隐藏计数由与展开位无关的 `sessionRowDisclosure`
  窗口算出——按展开后的 hiddenCount 决定去留会使点开一次再无收起入口；
  文案取上游 `sessions.expand` / `sessions.collapse`。
- **悬停卡片**：workspace 头与真实会话行悬停显示卡片——workspace 卡 = 标题 +
  会话数（投影无 path/createdAt 故省略）；会话行卡 = 标题 + 相对时间 + 状态点
  列表 + 复制标题按钮（blank 行不显示时间）。disabled = 菜单打开、拖拽中或行内
  重命名进行中（`menuOpen`/`sessionDrag`/`workspaceDrag`/`serverDrag`/
  `renamingThisWorkspace` 任一成立即禁用——编辑期卡片不盖住行内输入框；该枚举只
  描述 workspace 头卡片）。
  - **实现归属**：卡片由本包 `client/RowHoverCard.tsx` 渲染，
    不再直接用 vendor `ui-primitives HoverCard`；**开合状态机**在
    `shared/hover-intent.ts`。原因：vendor 版
    （`ui-primitives/HoverCard.tsx:183-188`：`onPointerLeave` = `clearTimer()` +
    `if (open) armClose()`，arm 宽限由**上一次已提交的 `open`** 决定）在 dwell
    到 React 提交之间落下的 pointerleave 什么都不 arm，卡片挂载后指针已离开，只能
    靠「再悬停该行并移开」清除（本仓每实例一个大 React root：侧栏 poll/`now` 轮询 +
    N-ctx 多壳共用调度器）。本包机器以**同步指针在场标志**为准（dwell 触发时复查、
    leave 无条件 arm 宽限），与 React 提交时机无关，且**开合事实只有一份**——机器即
    store（`isOpen()`/`subscribe`），组件经 `useSyncExternalStore` 直接渲染。
    修正落在本包（vendor 只读）；**退役条件 = 上游修掉该竞态**，机器判据 =
    `scripts/upstream/verify-upstream-touchpoints.mjs` C15（断言竞态**两侧**形状
    仍在：CLOSE 侧 `onPointerLeave` 的 arm 仍由已提交 `open` 守卫，OPEN 侧 dwell
    回调仍不复查指针在场——只锁 CLOSE 侧会漏掉「上游在 `setOpen(true)` 前加 inside
    复查」这一最小修复；外加时间常数逐值锁步），登记行见
    `docs/checklists/upstream-touchpoints.md` §4、偏差本体与剩余实机验收见
    `docs/progress/STATUS.md`。
  - **相对官方原子的有意增量**：卡片盒（244 宽 / r12 / pad 12-16 /
    `--dsw-shadow-lv3` / `#2C2C2E`）、8px 右偏移、200ms 宽限、按下即收与
    「点卡片复制」契约与官方等价；差异：①**同一文档只允许一张行卡片可见**（页面级
    slot，跨 N-ctx 壳共享，后开者关先开者；也是「leave 根本没送达」的自愈路径）；
    ②**窗口 blur / 文档 hidden 关闭可见卡片**（切走应用时浏览器不保证补发边界
    事件）；③**N-ctx 视图隐藏即关**：卡片 portal 到 `document.body`、不是所属视图
    后代，视图 `visibility/opacity/pointer-events` 隐藏不藏卡片也不投递指针事件，
    故 renderer 的 view-hide 路径在同一 commit 显式调用
    `dismissVisibleRowCard()`（`packages/renderer/src/components/InstanceView.tsx:187-191`）；
    ④**两轴定位 + 越界即关**：水平仍夹取（卡 244 宽、侧栏贴左缘），垂直**不设**
    官方「贴视口上缘钉住」的地板（上游只夹下缘：`ui-primitives/HoverCard.tsx:100`），
    锚点整体滚出视口即关，位置由 `ResizeObserver` 重算（上游只有 scroll/resize，
    `HoverCard.tsx:104-105`）；⑤**复制纪元与上游对齐**：关闭路径（唯一出口
    `open === false`，宽限关闭/按下即收/禁用三路都经过）先自增 copyEpoch 再清理，
    否则卡片关闭时仍在飞的剪贴板写入会在关闭→重开后在**新卡**上亮一瞬
    `copiedLabel`；
    上游 `close()` 做同一件事（`HoverCard.tsx:54-58`），本包移植需补上这一步。两处
    **内容差异（有意保留）**：⑥workspace 卡是**只读卡**——投影不带 path/createdAt，
    上游「点卡片复制 cwd」入口（上游 `ui-workspace` `Rows.tsx:201-212`，
    `copyText={row.cwd}`）连同其 a11y/键盘复制一起没有（`role="button"`/
    `tabIndex`/`aria-label`/Enter-Space 只在 `copyText` 存在时渲染，
    `client/RowHoverCard.tsx:205` 与 `:220-240`）；会话行卡复制**标题**（上游
    `Rows.tsx:508` 复制 `row.title`）；⑦会话卡状态行 **0–1 行**，上游
    **1–2 行且至少一行**（上游 `sessionStatuses` 兜底常驻 `status.idle` 行，
    `Rows.tsx:268`；本包只在有状态时渲染，`client/ServerSection.tsx:2096-2103`；
    状态优先级见 §4.3）。
  - **同形状但不搁浅的先例（勿误记为竞态）**：vendor `Menu` 的 pointerleave 同形
    （`ui-primitives/Menu.tsx:319`：`closeOnPointerLeave ? () => { if (open) armClose() } : undefined`），
    本包两处 kebab 菜单也显式 opt-in（`client/ServerSection.tsx:1645`、`:1985`）；
    但菜单是**点击即同步提交**的受控 `open`（无 dwell 定时器，`Menu.tsx` 内无
    开门 `setTimeout`），且另有外部 pointerdown / Escape / 窗口 blur 三条关闭路径
    （`Menu.tsx:170-211`，`:175`/`:183`/`:200`），同一个 `if (open)` 不会搁浅。
- **a11y**：来源分组 `role="group"`、列表 `role="tree"`（**浏览树带可访问名
  `section.sessions`**，与搜索结果树 `search.results.aria` 成对）、workspace 头 `role="treeitem"` + `aria-expanded`、
  会话行 `role="treeitem"` + `aria-selected`、搜索结果行 `button` +
  `role="treeitem"`；来源头（非当前来源）`role="button"` 可键盘激活（Enter/Space
  切换视图）。**行级动作的可访问名带行名**：
  新建会话 `action.newSession.aria`、workspace kebab `action.menu.workspace`、
  会话 kebab `action.menu.session` 都以 `{name}` 参数带上行标题（上游
  `actions.newSession.aria`/`actions.workspace.aria`/`actions.session.aria`）——
  一排同读作「新建会话/更多操作」对 AT 毫无信息。**折叠 rail 每来源一个具名可操作
  按钮**：`aria-label` = 来源名 + 激活提示（复用来源头
  `sourceHeaderTitle`/`sourceHeaderActivatable` 单一判定）、当前来源
  `aria-current`、**非当前且不可激活**（托管停机等）的来源 `aria-disabled` 且点击
  不动作；颜色点与活动环仍是内层 span 既有几何（点 8px、间距 12px 不变），
  点/环 `aria-hidden`。
- **blank 行**：当前空白"新会话"行隐藏操作簇（kebab——重命名/分叉/归档全在其内，
  对齐官方 `!row.blank &&` 门控）——空白行无重命名/分叉/归档语义。双击同样被
  `blank` 门控（不进入内联重命名，见 §2.2）；离开 current 后的 450ms 宽限期
  ghost 占位见 §2.2（`visibility:hidden` 非交互、保留布局位，`derive.ts armBlankGhost`
  + `.sessionGhost`）——双击窗口内列表绝不位移。
- **会话状态指示**：固定 10px 行尾状态槽——常态空、
  运行中 = 官方 `StateDot` ongoing 蓝圆环、运行结束未读 = **chamber 品牌蓝点**
   `.stateCompleted`（6px 实心；官方 `done` 绿点因
   与来源头连接绿点同 token 被否——沿革与理由见 §4.3）；
  **待交互（pending）= 14px 图标徽标**（问号/清单/警示三角）——几何与配色
  契约见 §4.3，本节只定稿 token：运行 = `--dsw-static-deepseek-450`、
  completed = `--dsw-static-deepseek-450`（同一品牌蓝，形状区分），
  pending 徽标用
  `--dsw-alias-state-{business,warn}-primary`；
  状态槽非身份标记（来源身份由来源头折叠字形 accent + 激活左内边线 +
  rail 按钮/色点承担——来源头身份圆点已移除，连接状态点/转圈
  保留在头部右端）。
- **当前会话高亮（含 workspace 组标记）**：同上方「当前会话高亮」条——session 行
  官方 selected 浅色调（无阴影无加粗），workspace 组仅图标恒定自有色（chevron
  不取来源 accent），无底色融合、无深色调。
- **嵌套缩进（收紧）**：workspace 列表距来源头 10+1+6 = 17px；session 行
  左 padding 26px——session 标题相对 workspace 标题（24px）深 18px，
  server→session 标题级联 ~59px（原 73px）；会话级重命名表单与错误行
  同缩进。
- **拖拽鲁棒性**：行内控件（kebab/`+`/折叠/搜索/添加工作区/来源头激活/rail 来源
  按钮）复用 `suppressClickRef` 抑制拖拽结束后的尾随 click（拖到按钮上不会误触发
  确认对话框/菜单/建会话/切视图）；`rowHalf` 对零高行防御；chamber 列表区域包一层
  `ChamberListBoundary`——意外渲染错误只让列表区显示错误文本，绝不带走整个 shell
  （应用级 ErrorBoundary 不再触发）。

---

- **入场动画退役（可见性不变式）**：侧栏的 `wide-in`/`rail-in`/`rail-fade-in`
  整组删除（`SidebarRoot.module.css`）。它们都以 `opacity: 0` 为首帧，而 CSS 时间线只在
  子树被渲染时推进：隐藏实例壳（`content-visibility: hidden`）或窗口被遮挡时字标与设置
  座席会停在首帧——不可见、仍可命中、除重挂载外不自愈（WKWebView 实测见 STATUS）。
  必要内容不再参与入场动画；折叠的位移/裁剪仍由 AppFrame 轨道过渡承担，`.fading` 保留
  （类驱动 + settle 定时器界定）。回归锁：`test/visual-lock/`（该包）+ 渲染器隐藏壳门
  （design 05 §4）。设置壳按来源重放的 `contentFadeIn` 同批退役。
   注意：同一「切源后座席/字标空白」症状另有根因，本段只覆盖**入场动画特有**的失绘风险；当前根因（文档级重复 SVG 资源 id × 隐藏壳的 WebKit 丢绘）与修复契约见 design 05 §4.2。

## 8. 会话待办区（sidebar todo area）

**问题**：会话多时行尾状态指示随列表滚出视野，用户需频繁滑动检查「哪个会话完成 / 在等
批准 / 在等回答」；缺一个**常驻、免滚动**的侧边栏内呈现面（桌面通知与 Dock 徽标已有）。

### 8.1 机制（镜子，非盒子）

待办区是对 chamberBridge 投影的**纯派生视图**（`shared/todo-attention.ts`），不持有
任何条目记忆：输入 = 每来源每会话的**合并运行时事实**（App `completedBySource` 蓝点
∪ vendor `completed` ∪ `pending` 注册表——与行尾指示同一事实源）；输出 =
「此刻需要你注意」的条目（来源 + 会话 + kind：`approval / plan-review / question /
completed`）；出现/消失 = 投影刷新后的重算：断连来源无 runtime → 不臆造条目（重连后按
真实状态重现或不再出现）；会话重新 running / 已读解除 / pending 注册表清除 → 自动
消失。**移除从来不是动作，而是重算。**

派生纪律（与 `sessionStateDot` 同优先级，待办区绝不声称行指示未呈现的注意）：

1. `pending` 压过一切；`question` 归 ask 门，`approval`/`plan-review` 归 request 门；
2. completed 仅在 `runningSubagents === 0`、合并 completed 为真时出现，且受
   completed 门控——**completed 优先于运行环**（sessionStateDot 同序：pending >
   子代理 > completed > running；wire running 只在无 completed 时渲染环，vendor
   completed 与 wire running 的通道错位窗口内不得漏报）；
3. 正在查看的会话（`server.id === chamberInstanceId && current`，同高亮 currentId
   单选纪律）不进入；
4. 排序：等待类在前（阻塞 agent）、完成未读在后，组内保持列表扫描序（确定、跨 ctx
   一致）；上限 3 条 +「还有 N 项」展开（组件本地态，条目数回到上限即自动收起；
   展开侧有界——行区内部滚动约 8 行，「收起」常驻行区之外，积压再多也不挤压会话
   列表或埋掉折叠钮）。

### 8.2 交互：点击即跳转，权威式移除

点击条目 = `chamberBridge.requestOpenSession(sourceId, sessionId)` —— 与列表行点击、
通知点击同一条权威路径：目标来源未常驻自动挂载 boot，跨来源自动切活动视图。

- **completed 条目**：目标会话真正打开（成为活动来源 current）→ App 已读状态机解除
  → 条目随投影消失。打开失败（断连/来源移除）→ 条目保留、可重试，绝不丢提醒。
- **pending 条目**：打开**不**移除——只有交互被真正处理（批了/答了/agent 继续，
  ui-session pending 注册表清除）才消失；切走看别的会话条目仍在，直到处理完毕。

**不做**自动展开/滚动定位：跳转目的地是会话正文；折叠/滚动是用户布局状态（跨 ctx
共享持久偏好），跳转从不改写；方位感由条目上下文（tooltip 见 §8.5：完整标题 +
状态 · 来源 · 工作区）、多来源时的来源色点与既有 current 高亮提供。业界同构
（GitHub/Linear inbox：跳转与树可见性解耦，树状态归用户；显式 reveal 不进 v1）。

### 8.3 设置（chamber 全局，客户端页新组）

`sessionTodo` 嵌套块（`ChamberSessionTodoSettings`：`enabled/onComplete/onAsk/
onRequest`），**默认全开**——被动呈现（空时零占用），区别于通知的 opt-in 默认关。
客户端页「运行」与「通知」组之间新增「会话待办区」组：主开关（无边框披露行）+ 展开后
三类事件开关（卡片内行，通知组同节奏）。持久化在主进程 chamber-settings.json（白名单
+ 嵌套校验 + 损坏保留纪律同 notifications；main `applySettingsPatch` 嵌套 deep-merge）；
三处类型镜像（preload ↔ renderer 由 ipc-surface-mirror 守护；desktop store 手工镜像
——与 notifications 同纪律同缺口）。侧边栏经 `shared/todo-prefs.ts` 只读订阅
（get + onChanged；值域校验 + 未知键过滤 + 未水合回落默认——漂移最坏退化为默认，绝不假 off/假 on 之外的状态）。

### 8.4 代码落点

- 派生：`packages/dsh-chamber-client-ui-sidebar/src/shared/todo-attention.ts`
  （纯函数 + `test/session-rows/todo-attention.test.ts`）；
- 设置订阅：同包 `shared/todo-prefs.ts`（只读水合 + `test/session-state/todo-prefs.test.ts`）；
- UI：同包 `client/SessionTodoArea.tsx` + `sidebar-chamber.module.css` `.todo*` 类；
  `SidebarRoot` 在 `regionArea` 内、滚动容器**外**渲染（`wide` 门控；rail 无待办区；
  在 `ChamberListBoundary` **之内**——region 渲染错误纪律覆盖待办区）。打开经
  SidebarRoot 守卫回调（拖拽尾随 click 抑制 + 同会话内联重命名保护），来源色点复用
  `shared/derive.ts sourceAccentColor`（列表/rail/待办共用）；
- 设置面：`desktop/chamber-settings.ts`（类型/默认/校验）、`desktop/main.ts`
  （deep-merge）、`desktop/preload.cts` + `renderer/src/global.d.ts`（镜像）、
  `settings-bridge`（`session-todo-settings.ts` 助手 + `GeneralView` 新组 +
  `settings-store.ts` 乐观 overlay 嵌套合并扩展 + zh/en 各 6 键）、sidebar
  zh/en 各 5 键（`todo.*`）。

### 8.5 行序与列

**行列定格**（状态槽一律在行尾，与普通会话行同列；左右缩进与会话行对齐；
代码注释与本节同步）：

- **条带边界**：`.todoArea` 取**下边一条**
  `0.5px solid var(--dsw-alias-border-l2)`——与下方滚动列表分界，不引入第二套边框
  语言（官方 TodoPanel 是 `.5px l1` 描边 + `--dsw-specific-tip` 底 + r12 整卡，
  我们只取"分隔"这一半）。**只保留下边线**：条带上方 8px 处是
  自带圆角描边的 New Session 卡，上边线没有可分隔的邻居且会随条带 mount/unmount
  忽隐忽现。
- **行几何**：行高 26px + 2px 间距（间距由 `.todoRows` 的
  flex gap 提供，行自身 `margin: 0`；「还有 N 项」是该容器之外的兄弟节点，用自身
  2px 外边距接同一节奏）、计数 pill 12px——与会话行同节距、同 12px 字号下限
  （§7 排版条）。
- **行序** = 行首来源点（多来源才渲染点；空槽恒占位，标题列不跳动，与来源头字形列
  同列）→ 标题 → **行尾状态槽**：直接复用会话行的 `.sessionStateSlot` /
  `.sessionStateSlotPending`（10/14px 槽）与标记类——`StateDot state="ongoing"`
  （运行中/子代理）、`.stateCompleted`（完成未读品牌蓝点，
  官方 `done` 绿点因与来源头连接点同 token 被否，见 §4.3）与 `.statePending*`
  标记，蓝点/徽章与会话行行尾**同列同像素带**（两行容器共享同一右缘与 8px 滚动条
  槽位；展开溢出时 `.todoRows` 的 −8/+8 外扩把滚动条带保持在内容右侧，不压尾槽）。
- **文字列** = 40px（来源标签列）：表头标题、「还有 N 项」与行标题同列；表头计数
  pill 右缘与行尾状态槽/工作区计数同列。
- **墨色** = 会话行纪律（v0.2.4 两级）：`.todoRow` 自带
  `label-secondary`、hover 转 `label-primary`；`.todoRowTitle` 不自带墨色（v0.2.4
  亦然），随行两级；条带头部标题 `.todoTitle` 与计数 pill 在 `.todoHeader`
  （行外，`SessionTodoArea.tsx:118-119`），两级同为 `label-secondary`。hover 另画
  行底色；行与「还有 N 项」按钮均带 brand focus-visible 自绘环（§7）。
- **a11y 取舍（记录）**：装饰性槽位 aria-hidden；可访问名 = 状态 · 标题 · 来源
  （region 名带条目数）；tooltip = 完整标题 + 状态 · 来源 · 工作区——截断标题由此
  可复现（vendor tooltip 无 aria-describedby，hover 卡片不进读屏，不重复播报）。
  待办区**不做**列表行式条件 `role="status"` 实时宣告——固定区是投影镜像，每次投影
  变化播报噪音大于价值；未读状态在聚焦条目时仍可听到。
