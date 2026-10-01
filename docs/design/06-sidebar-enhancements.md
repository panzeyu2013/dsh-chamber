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
> `forkAt`）的契约在 05 §2.2/§9；视图选项三轴（分组 / 排序 / 归档筛选，含 per-source flat 单列表）见 §3.4。

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
  **子串匹配**（大小写不敏感；subagent 行不进投影，blank 行由 `deriveLocalSearchMatches` 显式
  跳过，故都不可能命中；
  archived 行按 `archivedFilter` 三态进出投影，故 show/only 下归档命中可现，
  见 §3.4），命中按 recency 排序（纯函数 `deriveLocalSearchMatches`）；
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
  `packages/dsh-chamber-client-core/src/search-state.ts` 共享单例（vite shared chunk，所有 ctx 同一实例）
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
  （浏览树同批补名，§7 a11y）；命中行在标题后渲染活动定时任务标记（上游 search 变体同址；
  会话行座席在标题之前，§4.3）。
- **取舍**：聚合拉取失败（`aggregateError`）的来源隐藏搜索入口（标题无法
  解析，与"错误行替换列表"一致）；已挂载来源标题随 store 事件即时更新；
  仅未挂载或 reconnect baseline 不完整的来源可能在 30s 兜底窗口内暂显兜底名。

### 1.3 代码落点

- `packages/dsh-chamber-client-core/src/instance-api.ts`：包装 `searchSessions(client, query, signal)`
  （信号透传——现有 helper 不带 signal；复用 `resultError`）。
- `SidebarRoot.tsx` + `sidebar-chamber.module.css` + `locales.ts`
  （`search.*` 键 zh/en 八组）。
- `types/vendor-modules.d.ts`（各包 `src/vendor-modules.d.ts` 为 /// reference 存根）：ambient 镜像补新导出。

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
  分组头。**不可拖**：未分组桶（无 wire 身份）、blank 占位行与归档行（上游 `Rows.tsx` 的
  `!row.blank && !row.archived` 门）、跨来源（代码层阻断：
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
  模式，勾选标记当前模式）。**updated = 手动序 + 活动置顶（本仓 `nextUpdatedOrder` 的账号
  语义；本 pin 的上游 updated 是纯 recency 重排 + 账号序，差异见 B1，不存在上游同名函数）**：
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
    故 updated 是**活动视图**而非持久手动排布层。另：上游 `setSessionOrder` 在拖拽时把 `orderBy` 切回
    `manual`（上游 `ui-workspace` 的 `stores.ts` 账号语义），本仓拖拽只写 mode 自身账号并留在 updated（登记偏差 B5）。
    （本仓 `reconciledSessionOrder` 对应上游 `reconcileManualOrder`（`ui-workspace` 的 `tree.ts`）的成员对账语义，
    非上游同名函数。）
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
- `packages/dsh-chamber-client-core/src/derive.ts`：新增纯函数 `reconciledSessionOrder(stored, wireIds)`
  （stored 序优先、未知 id 按 wire 序追加——官方 `reconciledSessionOrder`/
  `orderedUngrouped` 移植），`test/session-rows/derive.test.ts` 补用例。

### 2.4 来源级收拢 + 来源显示序

- **来源级收拢（server 折叠）**：来源头左侧新增折叠开关（与 workspace 头同款
  槽位：常态 **MONITOR 电脑字形**（folder = workspace、monitor =
  server；workspace 组头同槽的 folder 字形自带折叠状态——展开=开启 / 折叠=闭合，
  design 08 §3.2），行 hover/focus 换入折叠 chevron，16px 槽位无位移），点击收拢该来源
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
    groupBy?: Record<sourceId, 'workspace' | 'workspace-tree' | 'flat'>,
    archivedFilter?: Record<sourceId, 'default' | 'show' | 'only'>,
    flatOrder?: Record<sourceId, string[]>,
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
  `dsh-chamber.sidebar.v1`，所有 live boot 的 store 订阅并即时采纳（宽度尾写见下条）；替换官方
  ui-layout 注册（见 05 §6）。**宽度尾写（2026-02 性能修订）**：拖拽期仍是 150ms 防抖尾写
  （拖动热路径不落盘），但窗口 `pagehide`／`beforeunload` 会立即 flush 待写宽度并取消定时器
  （同一笔尾写恰好一次）——否则关窗会丢掉最后一次拖拽。**Rejected alternatives**：把防抖缩到 0
  （拖动期每帧写盘，写放大回到热路径）；只在 `beforeunload` 里同步写（WKWebView 的 unload 路径
  不保证执行，`pagehide` 才是可靠面）。
- **shell.leading 席位（rc.2）**：官方 AppFrame 在 `darwin && sidebarCollapsed` 时把窗口 chrome 的
  `shell.leading` 单席作为唯一的可见重开入口（折叠列宽=0 且 `.sidebarCol{overflow:hidden}` 会裁掉
  rail 内控件）。chamber sidebar fork 注册 `SidebarLeadingControls`（展开 + 新建，28px / `--dsw-radius-sm`；
  宽度与 `--dsh-frame-leading-clearance` 计价锁步），layout fork 在 SlotMap 声明该 root-scoped 单席。窗口侧的红绿灯行、材质与全屏让位（leading 160→84、`.leadingSeat` 12px）见 design 25 §5.6。
- **darwin 透明与窗口 vibrancy**：侧栏列 `.root` 在 darwin 下透明（规则体与上游 ui-sidebar 逐字同形：`.root` transparent + `.newSession` 白色洗染 + `.brand` cursor: default），让窗口材质从侧栏列透出；中列保持不透明 `--dsw-alias-bg-base`（同上游）。整条透明链（ui-web `html/body`、AppFrame `.frame`/`.sidebarCol`、本侧栏 `.root`、renderer 的 `.app`/`.instance-view`）统一按 `data-window-vibrancy` 门控——两 flavor 的 darwin 窗口都带材质，标记由各自 documentStart 落（Swift `bridge-shim.js` / Electron preload 的 darwin 分支）；无材质的 darwin 窗口形态不落标记，跟着透明会把它压到窗口底色上。窗口侧材质/灯位见 design 25 §5.6。
- **orderBy / groupBy / archivedFilter**：视图选项三轴，全部 per-source（详见 §3.4）；orderBy 两态
  `'manual' | 'updated'`，默认 `manual`；
  v 保持 1 兼容旧数据（无此键即全 manual，不重播种），sanitize 丢弃非法值。
  **默认 `manual`**（保持既有 wire 序呈现）与官方默认 `updated` 不同——有意
  取舍：多来源列表下 wire 序即用户/宿主排好的序；该默认不因官方活动提升（updated 排序）
  而改变：updated = 手动序 + 活动置顶（§2），wire 序仍是默认第一。
- `packages/dsh-chamber-client-core/src/view-prefs.ts`：`loadViewPrefs()`/`saveViewPrefs(prefs)`，JSON
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

- **渲染结构（性能修订，2026 对齐轮收尾）**：侧栏 context 的动作经 `useStableHandlers` 冻结身份
  （每属性缓存闭包、调用转发到每次渲染刷新的 ref），状态字段逐项进依赖——于是 `memo(ServerSection)` /
  `memo(SessionRow)` 真正生效；per-source 账号序**每渲染每工作区只算一次**（resetKey 与 walk 共用同一
  缓存），flat 账号只对账/分区一次且仅在 flat 态构建（walk 直接渲染 `flatSessions`）；工作区拖拽环境
  只在**本来源拖拽进行中**构建；树投影与三轴菜单条目各自 `useMemo`，且 ServerSection 以
  `useSyncExternalStore(subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, …)` **订阅** git flags
  版本（ctxValue 稳定后，只读 getter 的 memo 依赖不是响应式来源，家族锚点/main-fold/worktree 字形
  会冻结）。
  回归锁：`row-render-cost.test.ts` / `animated-rows.test.ts` / `workspace-tree.test.ts` /
  `flat-list.test.ts` / `pin-partition.test.ts`。**已知残余（登记）**：浏览分支专属派生（`orderedWorkspaces` /
  `visibleOrderedWorkspaces` / `rowKeys` / flat 对账）在搜索/聚合错误/折叠路径仍会计算；`__flat__` 的
  DOM/行键命名空间与真实工作区共用（宿主 UUID 下不可达）；只有 `folded`/`sessionRowsExpanded` 用哨兵键；
  only 空态缺上游 24px 归档/队列字形、非 only 空态复用 `list.noWorkspaces` 而非上游 `empty.none`；归档行的
  标题双击重命名未保留（上游只拒绝打开）；视图选项菜单未设上游 200px min-width 地板；归档悬停行是纯文本
  （上游带 14px 归档图标与 `.hoverArchived` 行类）；carry 只保留仍在归档集的隐藏 id，故 `only`→`default`
  时被隐藏的**非归档**行仍可能被当作首次观测提升一次（渲染侧拿不到未过滤成员集，无法与"已删除"区分）。

- `packages/dsh-chamber-client-core/src/view-prefs.ts` + `packages/dsh-chamber-client-core/src/index.ts` 再导出；`SidebarRoot.tsx`
  经 `getViewPrefs`/`subscribeViewPrefs`/`updateViewPrefs` 读写；
  `test/session-state/view-prefs.test.ts` 覆盖存储单例/通知/裁剪（node:test 风格）。

### 3.4 视图选项三轴（per-source，2026 对齐轮）

**比较单元**：单一来源的浏览面 = 上游单主机浏览器。三轴（`groupBy` / `orderBy` /
`archivedFilter`）逐条对齐上游 `ViewOptionsMenu`，per-source 是本仓把上游「整页一份」的视图
状态**实例化**到每个来源 section 的方式——**不计为与上游的偏差**。

- **菜单**（`ServerSectionHeader.tsx`，上游 `rows/WorkspaceBrowser.tsx` 的 `ViewOptionsMenu`
  形态副本）：分组方式（按工作区 / 按工作区树 / 单列表）→ 排序方式（手动排序 / 最近更新）→
  筛选会话（隐藏已归档 / 全部对话（显示已归档）/ 仅显示已归档）；label + separator + icon +
  `selectedIds` 三轴齐备，密度保持本仓 `compact`（§7，不随上游 dense）；触发钮用上游 sliders
  字形 + `viewOptions.label` tooltip/aria。**降级**：`archiveSetKnown !== true` 时筛选轴**三项
  整体禁用**（默认项若可点会把存储值写回 `default`）、选中按实际渲染态（隐藏已归档）呈现，
  存储值保留，集合恢复已知后自动生效。
- **归档筛选三态**（`client-core/derive.ts sessionVisible` 的逐分支移植）：default 隐藏归档行 /
  show 回原槽位混入并打稀疏 `archived` 标记 / only 仅归档行且丢弃无可见成员的 workspace；
  **列表与搜索同规则**（`deriveLocalSearchMatches` 同一参数）。投影输入链：renderer
  `deriveServers(..., archivedFilters)` 按来源解析 + 进按来源缓存键；App 只订阅**筛选映射签名**
  （其他 view-prefs 写不触发 App 重渲染）；发布签名带 `archived` 位。
- **归档行形态**（上游 `Rows.tsx` 归档分支 + `ArchiveSession.tsx` 的 unarchive 半支）：置灰、
  不可开（点击就地提示 `toast.archivedNotOpenable`）、不可拖（仍是合法落点）、状态槽留空、
  pin 两入口缺席、归档钮/菜单项翻转为「恢复」（官方 `workspace/unarchiveSession`，失败落
  `/unarchive` 行错误键）；**搜索命中行**同为归档形态，恢复入口以行后文本动作承载（搜索行是
  单一 button 的 a11y 结构，嵌套按钮非法——形态差异登记在 checklist §4.6 该行，行为面与上游一致）。
- **归档提示条**（上游 `RowActionToast` 的 section 内实例化）：落**触发来源**的 section 内、
  折叠门内、per-shell 瞬态（`sidebar-root-notices.ts`）；三态 archived / stoppedAndArchived /
  archivedNotOpenable；动作 = 撤销 + 筛选已归档会话（该来源已非 default **或归档集未知**时隐藏，
  后者保护降级期存储值）；归档成功两个
  相位（直接归档、第二段 stopActivity）都触达。
- **only 空态**：`empty.noneArchived` + 「查看其他会话」跳回 default（单一 `data-row-key="empty"`
  元素内分支，不新增 AnimatedRows 键位）。
- **按工作区树**（上游 `tree.ts owningParentFolder` 的行为镜像，`client-core/workspace-tree.ts`）：
  仅**已注册**工作区可作父节点、最近前缀胜出、大小写敏感、Windows 拼写按 `/` 比较、POSIX 反斜杠
  是字面字符；**家族优先**：派生 worktree 的显示父级取它 main 的父级（worktree 建在
  `$DSH_HOME/worktrees`，纯前缀会把家族拆开，design 08 §3.3），无 git 家族信息退化为纯前缀；
  `synthetic` / 未分组桶不参与。树只改缩进（`--chamber-tree-depth`）不解序：同级顺序仍由 wire
  序与家族约束决定，父组折叠只隐藏自己的会话行。
- **flat 单列表**（上游 `FLAT_SESSION_ORDER_KEY` 的 per-source 对应物，
  `client-core/flat-account.ts` 的 `FLAT_ACCOUNT_KEY`）：该来源一条平铺列表、伪账号替换分组
  列表（不渲染工作区表头/hover 卡、不接工作区拖拽）；manual 顺序 = `flatOrder[sourceId]`
  （缺省用合成序：各组显示序 → 组内会话序，`reconciledSessionOrder` 对账），updated 顺序 =
  `flatAccountKey(sourceId)` 哨兵账号（NUL 哨兵，同一条 `nextUpdatedOrder` 推导与防抖写回，仅该来源为 flat 时维护）；
  会话拖拽只写本地账号、**不发 wire**（上游 flat 账号同规则）。不做跨来源平铺（拒绝项见 §12）。
- **pin 渲染分区**（Phase 4 选项 1，上游 `sectionMembers` 的行为镜像，
  `client-core/pin-partition.ts`）：blank 占位 → pinned（非归档）→ 其余，各分区保序；工作区/树/
  flat 三态共用 `sessionsOf` 叠层；manual 的块内序取宿主 `pinnedSessionIds`（「最近置顶在前」），
  updated 保留本仓 account 序；集合出处门 `pinSetKnown`（未知 = **无置顶块**且不宣称，行标记同门；
  blank 占位行仍按上游无条件提前）；
  搜索结果不分区。**不做**：置顶块内拖拽、跨块守卫、把置顶写进本地账号（上游领先槽语义）——
  由此 `unpin` 后行回自然位（登记偏差 B2，§5）。**保守守卫**：涉及置顶行的拖放（源或目标是置顶
  行）一律不提交且不画 marker——未分区的锚点算不出分区显示序里的位置，放任会反向移动并写进
  账号/wire；blank 目标的落点半边归一为 after（上游同规则）。
- **登记与偏差**：A 类（架构实例化，不登记）：三轴 per-source、每来源账号、提示条 section/
  per-shell、降级规则、无跨来源序。B 类（真实差异，STATUS 必要取舍）：B1 排序模型（默认
  `manual` vs 上游 `updated`；manual = 宿主 wire 序 vs 上游本地账号序；updated = 本仓活动视图
  vs 上游纯 recency）、B2 pin unpin 落点、B3 树模式家族优先、B4 树模式展开/折叠模型与拖拽父子
  约束未照搬（上游按 ancestor 自动展开、父组折叠隐藏子组、拖拽受父子约束；本仓 folded 缺席即
  展开、父组折叠只隐藏自己的行、拖拽无父子约束）、B5 会话拖拽不切换 `orderBy`（上游拖拽即切
  `manual`）、B6 本地账号（flatOrder / ungroupedOrder / updated account）的成员集 = **当前可见行**，
  拖拽提交会把隐藏（归档）成员写出账号（上游 `sessionMemberIds` 保留隐藏成员，恢复时回原槽位）、
  B7 本地搜索匹配链（displayTitle → cwd basename → session id；上游只匹配 summary.title + workspace
  标签）、B8 归档提示条的颜色 tone 与成功/警示字形未移植（role=alert 本就是上游 Toast 行为；文案/动作/
  TTL 仅 hold 层对齐——上游另有 1s 淡出尾巴）、B9 会话行窗口的配额语义（上游 5 行且 blank/running/有
  存活子代理的行豁免；本仓按位置窗口 200 行 + 当前行）、B10 本地账号中新 fork 子项落尾（上游
  `placeFork`：新普通分叉紧邻其源；本仓按对账把未知成员追加到尾部）。
  上游形态移植逐行登记在 checklist §4.6（ViewOptionsMenu / owningParentFolder /
  ArchiveSession 的 unarchive 半支 / Rows 归档行 / RowActionToast / sectionMembers——**六锚点
  五行**；另有 FLAT 账号一行）。

## 4. 运行时事实通道（完成/待交互点 + 跨来源当前会话高亮）

### 4.1 事实来源（每 ctx 运行时）

- **两个官方事实面，别混**（2026-01 校正）：
  - `ctx.sessions.list`（ObservableSnapshot）行字段就是客户端 store 行
    （`projectList()` 之后）：`id`、`displayTitle`、`running`、`blank`、
    `updatedAt`、`retainedBy`，稀疏的 `title`/`cwd`/`parentId`/`origin`/
    `projectionValues`。**没有 `completed`**，也没有 `pendingInteraction`。
  - `ctx.uiSession.sessionStatus` 是实时投影（**只在内容变化时发布**：真源
    `dsh-client-ui-session` 用 `sameSessionStatus` 去重后早退），行形状
    `{ running?: boolean; pendingInteraction?: { kind: 'approval'|'plan-review'|'question' };
    completionUnread: boolean }`；行 id 并集含「只因 pending 交互或完成提醒而存在」的
    行，所以 `running` 可能是 `undefined`。
  - 官方 nav 自己把两者合成一行：`running: status?.running ?? s.running`、
    `completed: status?.completionUnread === true`。chamber 两条都取官方口径：运行位按同一
    规则在生产者里解析（§4.3 第一条），**完成未读（蓝点）= `sessionStatus.completionUnread`
    官方位**——vendor 内存 Set 是唯一权威、不落盘、重载即空；生产者把它稀疏带进通道行
    `completed`，App 只追加一条 N-ctx 修正臂（§4.2）补官方 `isMain` 在隐藏来源上漏掉的
    那一格。
- **goal 三值事实**（design 19 §3.2.1，2026-12 落地）：行字段
  `goal?: GoalFact | null`——**字段缺席 = unknown**（投影还没给出 goal 键）、`null` =
  明确无 goal、对象 = 有 goal；
  `GoalFact = { goalId, revision, phase: 'active'|'paused'|'blocked'|'complete',
  activation?: 'armed'|'disarmed', updatedAt? }`。解析只读写
  `projectionValues.goal` 的白名单字段（`objective`/`blockedReason` 永不读取），
  形状不符 = unknown + warn-once（绝不折叠成 null）；生产者按来源代保留最后已知值
  （`retainGoalFacts`），行消失即 drop，activation 由事件缓存绑定同一 goalId。两个门与
  六面单源见 §4.3/§4.5；无壳来源的 facts overlay 见 §4.2。
- 每实例 boot = 独立 ctx、独立 store；侧边栏插件在每个 ctx 都挂载，即每个来源都有
  一个可订阅自身运行时的事实生产者。
- **插件 = 投影**：上报端只做快照投影——`current` + 每列出会话的实时 `running`
  位（按官方 `status?.running ?? s.running` 解析）+ 官方 `sessionStatus` 的
  `pendingInteraction` **与 `completionUnread`**，除 design 24 §12 的**purged
  墓碑抑制集 + 收敛链**（唯一自持状态：内容已删的 id 从上报中过滤）外**不自持
  状态**。官方完成位的武装/解除规则原样留在 vendor：`running→idle` 且
  `!isMain(id)` 武装（`isMain` = 本 ctx `retainedBy.mainView > 0`），重新
  running、成为本 ctx mainView 持有行、行离 `phase === 'ready'` 的列表即清除。
  chamber 每个已挂载实例视图都持着自己的 mainView retain（会话保活，§4.2），
  所以**隐藏来源的 `current` 行会一直停在「正在阅读」，其完成按官方规则不武装**
  ——那一格由 App 的修正臂补（§4.2），官方位本身照常经通道行 `completed`
  全量透传。插件侧无重复状态、不碰任何来源 selection（无竞态、会话保活不受
  影响）。
- **运行中子 agent 计数**：插件另上报每父会话 `runningSubagents`——chamber 纯函数
  `indexSubagentDescendants(byId)` 的 runningCount（经不间断 subagent 起源链统计的
  后代 running 数；与官方 tree.ts 的 `runningChildCount` **只同「子行运行位解析」这一条
  规则**，行集不同：官方读该父的直接子目录，本函数把后代归给全部祖先——见 §4.5 与
  STATUS ⑮），动机与语义见 §4.5：父会话 running 位只反映「agent 回合进行中」，后台
  子 agent 存活时父回合已结束（running=false）、子 agent 仍在工作——没有这条
  计数，完成蓝点会在子 agent 干活时提前亮起。
- **无壳来源的判定侧读回退（facts-only provenance，2026-12）**：没有任何官方 ctx 上报的
  来源（被 retention 回收、或从未 boot）没有壳行可读，但 facts 通道与挂载无关（P2a 镜像 /
  P2b 观察者，§4.2）。App 在**两个判定读取点**（修正臂步进与通知 reconcile 的 shell 输入）
  用纯投影 `packages/renderer/src/virtual-runtime-report.ts` 把 `SessionFactsSnapshot`
  投影成壳上报的结构子集：`{ sessions: { running 必填, pending?（仅 approval/question）,
  beforeBaseline? }, listComplete, listKnown, stale }`。**绝不物化**：不写 `factsStore`、不建第二张表、
  不新增写者（物化被否，§9）；投影只在无 ctx 上报时在场。provenance 因此显式三分：有 ctx
  上报 = `ctx`；无 ctx 上报且有可判 facts 快照 = `virtual`（臂输入 `factsOnly`）；
  其余 = `none`（不产壳输入）。`listComplete`/`listKnown` 复用已冻结的
  `diagnostics.baselines`（就绪 / 基数已知），**不动 wire、不加字段**（口径与闩锁规则见 §4.2）；
  子代理行在**源侧**排除（镜像不投递 `origin === 'subagent'` 的行、观察者本地跳过），
  行集 = 顶层会话。

### 4.2 通道 API（chamberBridge 扩展）

> 接口定义（`InstanceRuntimeReport` / `registerInstanceRuntimeProducer` /
> producer `report/clear` / `onRuntimeReport`）以 **05 §3** 为权威（v1 契约），
> 本节只描述**上报时机与对账规则**（不再重复 TS 定义）。

- 每 ctx 插件 apply 内先为该来源注册一代 runtime producer，再由 effect 订阅
  `ctx.sessions.list` **与 `ctx.uiSession.sessionStatus`**；订阅后立即 `report`
  一次当前快照（subscribe 不即时触发），其后每次变更继续上报投影
  （`{ current, sessions: { id: { running, completed?, pending?,
  runningSubagents? } } }`——`completed` = 官方 `completionUnread` 位，稀疏
  （仅 true 写字段），由通道携带；每列出会话都有 running 行，runningSubagents
  仅 >0 时出现——vendor `indexSubagentDescendants` 的 runningCount，见 §4.5）；
  effect 清理时调同一 producer 的 `clear`。注册时的单调 token 使旧 ctx 的迟到
  `report/clear` 全部失效，不能覆盖或清除同 id replacement ctx 的事实。
- App 侧：`runtimeFacts` state；**`correctionArms`（`packages/renderer/src/host/completed-store.ts`
  的 `completedStore`）——纯内存修正臂，本模型唯一新增状态**。每次上报对账一次，
  纯函数 `stepCompletionArm`（`packages/dsh-chamber-client-core/src/completion-arm.ts`，
  单测 `packages/dsh-chamber-client-ui-sidebar/test/session-rows/completion-arm.test.ts`）——
  - **provenance 与两类输入**：`stepCompletionArm` 新增 `factsOnly`（= provenance
    `virtual`：来源此刻**没有官方 ctx 上报**；**不得**由 `current === undefined` 推断
    ——有壳 ctx 也可合法无 `current`，那是 §9 第 5 条的被否形状；缺席 = false ⇒ 有壳路径
    逐字不变）与 `readIntent`（虚拟路径的「已读」事实 = App 的会话打开意图；有壳路径不用）。
    来源从 `ctx` 切到 `virtual` 的**撤回按 provenance 分域**（C1；语义见 design 19 §3.2.4/§3.5）：
    事实载体真正换代（抽壳 / facts 源退役换代 / aggregate notReady 删 runtime）删 running 边沿
    记忆与整份观测状态（`withdrawSource` 缺省 `scope='all'`），虚拟接管不把旧壳记忆当边沿证据；
    **桥面 `report === undefined`（facts 载体未换代）只清壳轨**——`withdrawSource(id, 'shell')`
    复位观测层 `shellSeeded` 与每会话壳运行/待决位（旧壳位不得当新边沿证据），但保留
    `prevRunning` 与 facts 轨水位：窗口内到达的 facts 完成仍恰好通知一次（清掉 facts 轨会让
    恢复批变 G2 播种批、通知与蓝点两面皆丢），虚拟接管按 facts 逐行边沿继续武装。反向
    （`virtual` → `ctx`：壳 boot 完成、桥面首份 report 到达）**不重播种记忆**：同一化身内 host
    running 位是同一条事实，保留 `prevRunning` 让 boot 窗口里发生的真完成（虚拟 running true →
    首份壳报 idle）仍被武装；若改成重播种，该行降为「首见 idle」，在有壳路径不武装——而有壳
    修正臂的存在理由正是补这类漏。只有事实载体换代/新化身才清整份记忆（壳上报撤回只清壳轨）。
  - 武装：该来源**不是屏上视图**（`paintedView !== sourceId`）且上报不 stale 时，按
    provenance 二选一——
    - **有壳路径**（无 `factsOnly`）：该来源 `current`（mainView 持有行）在新报里
      `running false`、上一份新鲜报为 `true`——即官方规则因陈旧 `isMain` 漏掉的那一格；
      **只有 `current` 可被武装，且绝不扫描其它行**（这是**有壳来源**的边界，仍成立）；
    - **无壳路径**（`factsOnly`）：没有官方 `current/isMain` 主场，**逐行**的 host
      `running true → false` 边沿是唯一证据（每行一格，与上游「N 个未读会话」同语义；
      该行等于 `readIntent` 时不武装——读到与完成同拍也不留点，因为无官方位可清）。
      该边沿的证据面只含**真实停止**：镜像的一次成功且完整基线缺席是**单阶段删除**（直接
      进 `removedSessionIds`，绝不投影 `running:false`；见 design 17 §10.7），离表清除由
      `listComplete` 门控，不产生边沿。首基线前的 status 行也进不了这份证据面——镜像侧
      的 origin 门（design 17 §10.7 S1）会在基线确认身份前扣下它们。
      两形态共享的 running 记忆**逐行保存观察到的布尔**：`false` 也写、`unknown`（行缺
      running 位）缺席，只有 `undefined` 才算「从未观察」——这是第二支（首见 idle）与
      「点击读清后不得重新武装」的共同判据（`stepCompletionArm` 用 `sameRunningMemory`
      逐值比较；只存 true 会让读清后的下一拍把 false 当首见重新武装，W11）。
      另有上游 `observeRunning` 的第二支：该行**首见即 idle**（`prevRunning` 无该行）、
      行自带 `firstSeenByDelta`（**无壳观察者的 status 事件首建**；列表播种与网关平面都不带）、
      且列表基数**已知**未就绪（`listKnown === true && listComplete === false`；未知 ≠ 未就绪）
      ⇒ 一并武装。该窗口今天两个平面实际上都到不了：P2b 可判即 ≥1 基线；P2a（网关平面）的
      行**永不带 `firstSeenByDelta`**（快照与增量帧都不赋该位）⇒ 第二支永不触发。登记为已知窗口。
    - 两形态都**按会话行键控**：读一行只清那一行，`current` 迁移或逐行完成各自保留。
  - 清除：该会话重新 running；**有壳**读清 = 来源成为 painted 且该行仍是其 `current`；
    **无壳**读清 = 该行等于 App 的打开意图 `readIntent`（因此壳 boot 失败、永不出现
    `current` 时点击也能消点）；权威列表里该行消失（`listComplete === true` 时缺席即删除）。
    来源退役不走步进：App 按同一批 id 对 `completedStore` 整表 `retire`（纯步进因此
    没有 retired 输入，见该模块头注）。
    facts 不可判（`virtualRuntimeReport` 返回 undefined：host stopped/disabled/forward-skew/legacy）
    时无壳读清与武装一并冻结，打开意图不消点——与冻结条款一致，登记为已知边界。
  - 冻结：**没有上报**（`rows === undefined`）时两表原样——既不武装也不清除；失败方向是
    「与上游一致地不亮」，不是旧实现的「fail-closed 到未读」。列表非权威（`listComplete
    === false`）时不按「缺席」清除（缺席不等于删除）。
  - stale 上报：**不武装**（不当作完成证据），但清除与 running 边沿记忆照常推进
    （`completion-arm.test.ts`「a stale report is never arm evidence but the edge memory
    still advances」钉住）——故断连期间的完成在重连后不补臂，fail-closed 方向与上游一致。
    有壳路径当前生产者不在**原始通道报告**上写 stale（stale 只作为合并事实的标记，servers.ts
    第四参），这条属预留语义；无壳路径的 `stale` 由 `virtual-runtime-report.ts` 从
    `isFactsDecisionUsable` 给出，是现役输入——facts 降级窗口（`disabled`/`forward-skew`/
    unversioned/曾探到协议载荷后的 404）保留既有行并标 stale，无壳路径因此冻结武装、保留记忆，
    不触发遗忘结算。
  - **五条不变式**：①不进口官方位（呈现 = 官方位 ∨ 臂；官方为真时臂无意义）；
    ②行键控、绝不扫描（**有壳**来源只有 `current` 可武装，**无壳**来源按逐行 host 运行边沿；
    两种形态都读一行不清另一行）；③纯内存、不落盘、不跨 reload（无
    localStorage 键、不进 `notifications.v1`）；④无水位（不比较
    `updatedAt`/`completedAt`，时间只用于诊断）；⑤无第二清除规则（不引入
    focus/遮挡判定，`document.hasFocus` 只留在通知门）。
- `deriveServers` 把 `correctionArms` 传入 `mergeRuntimeFacts(runtime,
  correctionArms, overlay?, stale?)`（`packages/dsh-chamber-client-core/src/derive.ts`）：
  合并语义写死为 **`completed = 通道官方位 || 臂`**——只在臂为真时补 `true`、从不清位，
  通道下拍不带官方位时自然消失；两参调用「无内容即 undefined」的逐字节相容保留。
  `pollAggregates` 的 not-connected 分支清空该来源**上报事实**（断连即清，generation
  级事实随断连失效）；臂在无上报时冻结，重连后按新上报重新对账。
- **通道字段与判定面**：每条上报另带 `listComplete?: boolean`（vendor list store
  `phase === 'ready'`，即本客户端至少成功拉过一次基线——臂「缺席即删除」的唯一门控）
  与 `stale?: boolean`（断连/主机不可达时仍可附加的只读事实，R14）。**stale 只走渲染面**：
  overlay 的 `isFactsUsable` 保留 stale 行（读取只读事实 + 标 stale），而完成观测
  （通知候选）走更严的 `isFactsDecisionUsable`（额外 `!stale`）——载体已断的行不得
  当证据；臂的武装证据同样要求 `!stale`。facts 行/水位**不参与**完成点武装（对齐后
  无水位概念），只服务通知候选与渲染；`todo-attention` 对断连来源只渲染
  `runtime.stale === true` 的事实（R14 方案 A）。
- **facts 快照的行级输入（2026-12）**：`SessionFactsSnapshot.baselines` 从 wire
  `diagnostics.baselines` 闩锁——该值的单一来源是 **store** 的「成功且完整基线」计数
  （每次成功 `applyBaseline` 递增，**含 poll 档**；mux 自己的 reconcile 计数另放
  `SessionStateObserverStatus.muxBaselines`，不再进 wire，design 17 §10.7 S4/T2）。
  无诊断帧的增量帧沿用上一份闩锁值，来源指纹换代复位；无壳来源的
  `listComplete = (baselines ?? 0) > 0`——它是**离表清臂**的唯一闩锁（poll 档缺了它，
  已完成且随后离表的行会残留蓝点）。
  `SessionFactsRow.firstSeenByDelta` 是客户端本地位（**无壳观察者的 status 事件首建**；
  列表播种与网关平面——快照/增量——都**不赋该位**，基线合并保留、行退役即消失），只供无壳
  路径的 `beforeBaseline` 武装支（该支另要 `listKnown === true && listComplete === false`）。
  `SessionFactsRow.identityConfirmed` 是同一族的另一客户端本地位：**缺席 = 已确认**（网关
  平面与列表播种行不带），显式 `false` = 仅由 status/activity/waterfall 首建、尚未被任何
  列表事实确认的行——观察者快照与 `virtualRuntimeReport` 都跳过它（S1 的 P2b 等价门，
  design 19 §3.2/§3.5），直到 baseline/added 确认后同拍发布。
  行集变化产生 `onRowHint`（优先级 added > removed > changed）；消费者的
  「提示 → 四拒 → ≤1 次 unary 拉取」链路见 §4.3。
  降级窗口（`disabled`/`forward-skew`/2xx unversioned/曾探到协议载荷后的 404）**保留既有
  行并标 `stale`/`serviceable=false`，绝不是权威空行集**——空行集会让在场集判空、走遗忘
  结算、清 held pending 并撤掉已武装的行（design 19 §3.5）。
- **goal 事实过桥与身份签名**（v5 §2.1/§6 P2a；2026-12）：mounted 来源由插件生产者在
  `sync()` 里先回填最后已知值、再合并 activation 缓存（`applyGoalActivation`，门读它）；
  无壳来源的 goal 经 App 的 `factsOverlay` 走 `mergeRuntimeFacts` 的 overlay 行——通道行
  已给对象/显式 null 即权威，overlay 只在通道 unknown 时填补（含显式 null），缺席 = unknown
  **绝不伪造 null**。四处必须同批：`session-facts-source.ts` 行类型 + `RuntimeFactsOverlayRow.goal`
  + `mergeRuntimeFacts` 的填补分支 + `use-badge-count` 的合并 runtime 入参（否则无壳源的
  goal 到不了 `server.runtime`）。**签名**：goal 的五个字段
  （`goalId/revision/phase/activation/updatedAt`）必须整体进 `runtimeReportSignature` 的**行编码**，
  且**不得**落进 `includeRunning` 分支——activation 是易失缓存，不入签名会被 App 的身份
  去重冻结在首见值（`goalFactSignature`）。
- **facts 快照通道判定（`session-facts-source.ts` 单源，2026-12）**：
  `classifySessionFactsProbe` 判 2xx 无 `protocol`（解析失败 / 非协议载荷）=
  `degraded/unversioned`——通道**不可用（unknown）**：**保留既有行**（无既往行才给空行）
  并标 `serviceable=false`/`stale=true`；消费侧按原始行键判在场、按 `factsUsable=false`
  停判（不得当权威空行集，否则无壳来源整体遗忘）。404 = `legacy-gateway` 二分（2026-12）：
  **首探**（从未探到协议载荷）给空权威快照（路由不存在的版本事实，侧栏 legacy 档由它可达）；
  **曾探到协议载荷后转 404**（`protocolFactsSeen`，来源指纹换代清零）保留既有行/游标并标
  `serviceable=false`/`stale=true`（不可用但绝不当会话消失，held pending 不被清），404→ok 恢复权威。
  **2xx unversioned、404、5xx/超时统一排一次有界重探**（`scheduleProbe(reconnectMs)`，幂等 guard）
  ——unversioned 不再永久不可用，除非 connected false→true 或来源指纹变化才解围。

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
    **武装/解除事实 = 官方 `completionUnread` 位 ∪ 修正臂**（§4.1/§4.2；通知边沿继续走运行位，未变）。
    判据按此钉住：蓝点必须存在、
    `StateDot state="done"` 不得回归、运行环仍是官方 ongoing。
  - **活动定时任务标记**：会话行在行首座席（标题之前）渲染本仓的 `SessionScheduleIndicator`
    （官方 occupant 缺席时的回落；座席转移见 §3.4/checklist §4.6）；搜索结果行仍在标题之后
    （`ServerSectionSearch.tsx`）渲染同形标记（16px 闹钟字形 + `role="img"`，可访问名与
    title 都是本地化 `schedule.active`，行本身仍是唯一动作），事实 = 该会话
    `projectionValues.schedule` 非空（`derive.ts hasActiveScheduleOf`）。上游同事实源自共享
    Host 任务目录（`ui-schedule/src/client/SessionScheduleMark.tsx`；旧 `ActiveScheduleIndicator`
    的退役登记在 checklist §4.6 行 412）。**稀疏字段**：只有真有活动定时
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
    "等待回答/决策"与"等待批准"（有意不取全蓝）。三档的**来源**：running 位按官方
    规则在生产者里解析（`status?.running ?? s.running`，§4.3），pending 只来自官方
    `sessionStatus.pendingInteraction`，completed = 官方 `completionUnread` 位
    ∪ App 修正臂（§4.1/§4.2）。
- **悬停替换（真正替换，零占位）**：行/头操作静止时 `display:none`（不占布局
  空间），状态图标/徽标因此真正位于行/头末端；悬停时操作簇 `display:inline-flex`
  换入、状态槽 `display:none` 换出（session 行：状态环 ↔ **kebab 菜单（置顶/重命名/分叉/归档四项）+
  独立归档钮 + 独立置顶钮**（归档与置顶各是同源双出口，形态见 §7；静息置顶标记与状态槽一起换出；归档只隐藏行、不触碰会话日志；安静会话直接归档，宿主因
  仍有活跃工作而拒绝时才弹「停止并归档」确认，design 24 §5）；来源头：连接状态 ↔ 簇首的每条已注册
  `sidebar.panellist` 紧凑入口（条件成员，见 §4.7）+ 排序菜单 + 搜索 + 添加工作区（官方
  project-add 字形，`IconProjectAddOutlineRegular`）+ 归档清理；workspace：会话数徽标 ↔ `+`（新建
  会话）+ kebab（重命名/删除））。胶囊/菜单展开时操作簇保持显示
  （`.sourceActionsVisible`/`.rowActionsVisible`，`:has` 同步换出状态槽）。
  **键盘焦点（Tab）与 kebab 展开共用同一个 JS 揭示状态**：`ServerSection.tsx` /
  `ServerSectionHeader.tsx` 在头部行的 `onFocus`（React focusin）里按 `:focus-visible` 置位、
  焦点离开整行时清除；不发 blur 的卸载路径（行消失、行内重命名表单被替换）另按渲染/重命名
  状态过渡清理，否则悬留的键会把该行的簇永久钉在静息态。不能只靠 CSS 的 `:has(:focus-visible)` 揭示：Blink 的 Tab 导航不认
  `:has()` 失效出的 display 变化——同页 A/B（真实键事件、两侧 DOM/CSS 相同）里
  `:has(:focus-visible)` 揭示的簇已 `display:inline-flex` 却仍被 Tab 跳过，JS 类揭示的簇 Tab
  依次进入（`test/visual-lock/keyboard-reveal-reachability.test.ts` 钉住这条）。
  **Rejected alternatives**：① 只用 CSS `:has(:focus-visible)` 承担键盘揭示——视觉可见但键盘
  不可达（如上实证）；② 改用 `:focus-within`——指针点击后 Chromium 聚焦被点按钮，簇在鼠标
  移开后常驻（正是本条「真正替换」的由来，08 §3.2 同述）。
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
  running 环**；goal 呈现门不新增档位，而是**整体压掉 completed 档**（相位 active，
  含 activation unknown）。completed/pending/runningSubagents 来自 runtime facts，
  `running` 来自完整 aggregate snapshot；两者均由已挂载 ctx 的同一 sessions
  store 事件驱动，但独立 bridge state 可能相差一个 React commit。
  runningSubagents 同样压过 running 环与 completed 点（vendor 保证 completed 与
  running 互斥）。官方 sessionStatuses 的「有运行中子 agent 就显示 ongoing」语义
  原样对齐（chamber 为避免瞬时双通道错位把用户需处理状态前置）。
- **goal 呈现门与压制后 state（v5 §2.3/§4 单源，2026-12）**：唯一派生入口是
  `packages/dsh-chamber-client-core/src/session-row-state.ts` 的 `sessionRowState(facts)`（零依赖叶模块，同时是
  `GoalFact` / `goalSuppressesPresentation` / `goalHoldsCompletion` 的类型家）；label/dot、
  `data-chamber-session-state` / `data-chamber-state-source` 仪表属性、搜索结果行、待办条目
  与徽标计数全部消费同一个结果（INV7）。`goalSuppressesPresentation(goal)` 生效时 `state` 必须落
  `running`/`none`——**不得返回 completed**（否则仪表报一个用户看不到的完成点）；
  可选落 `data-chamber-goal-active`；`suppressedBy` 区分 `'goal'`（activation 已知）与
  `'unknown'`（activation 未知，静默窗口与通知层 unknown-hold 同态）。pending 档不标
  suppressedBy（等待输入不是压制）。
- **运行位解析：镜像官方规则、一处解析（2026-01，`resolveSessionRunning`）**：官方
  `dsh-client-ui-workspace` 的会话节点自己就写着 `running: status?.running ?? s.running`
  ——ui-session 实时 `sessionStatus` 投影优先、会话列表行兜底，且 `false` 是**真实观测**
  （`??` 承重）。chamber 的每个运行位消费点因此走**同一个实现**
  （`packages/dsh-chamber-client-core/src/session-row-state.ts resolveSessionRunning`）：
  侧栏运行环（`projectInstanceSnapshot`）、搜索行（同树行）、runtime facts 通道
  （`projectRuntimeFacts`；驱动完成位/通知边沿/修正臂/徽标）、运行身份 mint
  （`runningIds`）与子代理谱系计数（`indexSubagentDescendants`——其头注本就声明须与官方
  ui-workspace 语义一致）。挂载来源在有观测时取 status 位；未挂载/unary
  来源没有该投影，保持行自身位。**一次解析、两路同值**，所以下条的
  `runningRingVisible` 仍只取 snapshot 位、不与 runtime facts 做 OR/优先合并——它禁的是
  **渲染器**里再长出第二权威，而不是禁止生产者按官方规则解析。上游语义由 vendor 源
  lockstep 钉住（`vendor-session-fact-contract.test.ts`：`status?.running ?? s.running`、
  `completed: status?.completionUnread === true`、`publishStatus` 行形状、store 行无
  `completed`、`visiblePendingKind` 三档）。
- **显示面与修复面分工（同日）**：store 的**主张**读取保持原语义——
  `readOfficialProjection`（权威梯的官方读数）、`correctAuthorityRunning` 的自校验与
  `readAuthorityRunning`（独立 unary 传输）继续读 store 行，因为它们的职责是**修 store**
  而不是描述真相。副作用是写回不可能再把一个真在跑的会话显示成空闲（status 位优先于被改写的
  行位），而 store 仍会被修好；分歧只在渲染面按官方规则消解。取证：producer 在分歧集合
  **变化**时向既有 authority-log 有界环写一条 `status-divergence`（两侧取值 + 时刻，
  跨重载可回读）；DOM 仪表档位保持不变（新增档位要把标记穿过 snapshot/两条签名/侧栏行类型，
  收益不足——被否）。
- **运行环 snapshot 单一权威（`runningRingVisible`）**：运行环只取完整
  aggregate snapshot 的 running 位（该位即上条的解析结果），runtime facts 的 running
  不参与渲染。已挂载来源的 snapshot 由自身 ctx store 在 host-frame 事件上即时上报；
  未挂载或 reconnect baseline 未完成的 ready 来源走 30s unary 兜底。
  `runtimeReportSignature(includeRunning=false)` 保证 runtime 通道的 running-only 变化
  不重复驱动同一环渲染；通道 running 位仍保留在 `InstanceRuntimeReport` 中，供 App 完成
  修正臂（`stepCompletionArm`）推导 running→idle 边沿（App 内部逻辑，非侧边栏
  渲染）。
- **G1 的真实机制（2026-12）**：运行环的唯一权威仍是聚合快照行（`runningRingVisible`
  **不吃**通道/虚拟上报的 running 位）；实时性由「facts 行集变化提示（`onRowHint`，快照帧
  与增量帧都发）→ 既有 `requestFactsRefresh` 四拒 + 1s 底线 → **≤1 次 unary 聚合拉取**」
  承担（P2a 网关档与 P2b 观察者同规；poll 档为一个 poll 周期）；该次拉取与边沿轮询/watchdog
  共享同一个有界刷新波（队列按来源去重 + 4 并发帽，`drainAggregateWaves`，2026-12）。
  判定侧读回退（§4.1）只服务
  通知/修正臂，**不驱动环**；若将来要「通道 running 直接画环」，那是独立契约变更（需改
  `runningRingVisible` 与两条锁测试并登记第二权威例外），本轮不做。
- **被否方案（运行位解析）**：①**扩大 tier-3 写回去写 `true`**——要检测分歧就得先读
  `status.running`（读是必需的），却把 chamber 变成 running 的第二写入者（违反既有锁；
  上游 `refreshList` 才是契约内的修复路径），还会把渲染事实绑到 N=2/60s 门槛上；
  ②**只调阈值/频率**（90s 未验证丢弃、写回周期）——与官方 UI 的不一致窗口永远存在，治标；
  ③**UI 层各自兜**（侧栏与 App 各写一次优先级）——同一事实两处解析正是本次缺陷的形态；
  ④**只把 status 位并入事实通道、不动渲染面**——环与蓝点边沿会给出两个不同的运行位。
- **搜索结果行状态点**：结果行经投影解析 running 位（命中会话必在投影可见集内，
  查得到即用投影位，查不到回落 false）——状态槽优先级与 running 环 snapshot 权威
  同树行（只取投影位，runtime facts 的 running 不参与，`runningRingVisible`）。
  已知窗口（接受）：未挂载来源的兜底拉取失败期间树行整体消失（错误横幅替代），
  搜索结果行运行环随投影为空回落 false；槽**恒占位**。

### 4.4 代码落点

- `packages/dsh-chamber-client-core/src/aggregate-store.ts`（通道 + `ChamberServerAggregate.runtime?` +
  `completed`/`runningSubagents` 行字段）、`client/index.ts`（订阅与投影上报 + design 24 §12
  墓碑抑制/收敛链 + `indexSubagentDescendants` 注入 + 官方 `completionUnread` 采集）、
  `App.tsx`（runtimeFacts + 修正臂对账/合并/清理；runningSubagents 随事实行透传）、
  `packages/dsh-chamber-client-core/src/completion-arm.ts` + `packages/renderer/src/host/completed-store.ts`
  （修正臂纯函数与其内存表：有壳 `current` 行 ∪ 无壳 `factsOnly` 逐行边沿）、
  `packages/renderer/src/virtual-runtime-report.ts`（无 ctx 来源的判定侧读回退投影——不物化、
  不写 `factsStore`）、`packages/renderer/src/app-hooks/use-notifications.ts`（两个判定读取点
  `stepArmNow`/`reconcileCompletionsNow` + 来源撤离 `withdrawSource`）、
  `packages/renderer/src/session-facts-source.ts`（`baselines`/`firstSeenByDelta`/`onRowHint`
  与降级保行）、`packages/renderer/src/app-hooks/use-session-facts-lifecycle.ts`
  （`stepRowHint` 是 `facts-row-hint` 的唯一 guard 调用点；两个 teardown 调 `withdrawSource`）、
  `SidebarRoot.tsx` + `sidebar-chamber.module.css`（dot 状态类 + 高亮 +
  runningSubagents 分支 + `.scheduleIndicator` + `.railDotButton`）、`ServerSectionRows.tsx`/`RowHoverCard.tsx`
  （A1 座席渲染：行首 `renderSlot('sidebar.session.row.leading')` 以自有 `.scheduleIndicator` 为 fallback、悬停卡内容位
  渲染 `sidebar.session.row.hover`；两席由本仓侧栏的 `children` 声明，上游注册里的两行由 vendor 补丁 13 号删除——
  座席所有权转移，design 09 §3.6 第四类第二形态）、
  `packages/dsh-chamber-client-core/src/derive.ts`（`hasActiveScheduleOf`；`hasActiveSchedule` 进
  `instanceSnapshotSignature`；goal 的 `parseGoalFact`/`retainGoalFacts`/
  `applyGoalActivation`/`goalFactSignature` 与 overlay 填补）、
  `packages/dsh-chamber-client-core/src/session-row-state.ts`（goal 三值 + 两个谓词 + `sessionRowState` 压制后 state 的
  零依赖叶模块）、`client/goal-activation.ts`（事件制 activation 缓存 + 有界重试；缓存上限
  `MAX_ACTIVATION_CACHE = 2000`，LRU 淘汰 + warn-once + `evictedCount` 诊断，B4-1；不调
  `goals/get`）、`packages/dsh-chamber-client-core/src/instance-api.ts`（unary 兜底行读 `projections.values` 同一
  事实）、`packages/dsh-chamber-client-core/src/session-row-window.ts`（`sessionRowWindow` + `sessionRowDisclosure`）、
  `locales.ts`（`status.waitingApproval/planReview/waitingAnswer/completed` +
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
- 插件（vendor 边界）在每次快照投影时调用 chamber 纯函数
  `indexSubagentDescendants(snapshot.byId)`，把每父会话的 runningCount（>0 稀疏）并入
  事实通道。**镜像范围**：子行运行位与官方 tree.ts `runningChildCount` 同规则
  （`status?.running ?? row.running`，经 `resolveSessionRunning` 一处解析）；**行集与归属
  不同**——官方读 `list.projectionsBySession[parentId].values.subagentCatalog`（该父的**直接**
  子行），本函数按 `parentId` 链把每个后代归给**全部**祖先，故嵌套委派（子代理再生子代理）
  时祖辈也会被计入：这是比官方更宽的压制面（祖辈回合结束后、孙辈仍在跑时，官方 nav 已显示
  completed 而侧栏仍显示运行环）。差异的裁决与失效判据见 STATUS ⑮；
  `packages/dsh-chamber-client-core/src/derive.ts projectRuntimeFacts` 保持纯
  （计数经参数注入，import 图不引入未构建 vendor 包）。
- 渲染优先级改为 **pending 徽标 > runningSubagents 运行环 > completed 点 >
  running 环**：子 agent 存活期间绝无完成蓝点（对齐官方 sessionStatuses）；
  子 agent 全部结束后蓝点正常浮现（官方位与修正臂的武装/解除都不看子代理计数
  ——完成位在子 agent 运行期间保持武装但被渲染压制，与官方「completed 保持
  武装、subagents 分支优先呈现」同构）。
- tooltip/aria：`status.subagentsRunning.one/other`
  （官方 copy：`{n} 个子代理运行中` / `{n} subagent(s) running`）。
- **可呈现性三值（P5）**：计数只说明「索引在场时算出了几个运行中的后代」，
  不是「正在干活」的证据。父行改带 `subagentActivity: none | running | unknown`：
  索引缺席或来源 stale（R14）时读数是 `unknown`，中性呈现——不点亮子代理圆环/播报，
  也不据此压制 completed/running 读数与待办条目；`runningSubagents` 保持稀疏计数供诊断。
  守卫单源 = `packages/dsh-chamber-client-core/src/session-row-state.ts` 的 `subagentActivityOf`（行读数、圆点、待办共用）；
  上游完整性信号落地后删除本地 fallback（见 `docs/progress/todo/upstream/upstream-proposals.md` §7）。
- **facts-only 源的 `subagentCount` 只在谱系已认证时是 busy 证据（I-12 修正 R2-G，2026-12）**：
  gateway/SSH facts 行的 `subagentCount` 是「在场子会话数」（宿主投影/谱系索引的
  cross-section），默认不是「正在干活」的证据。`completion-observation.ts` 只把**壳通道**的
  `runningSubagents + subagentActivity` 当运行证据；facts-only 行要成为运行证据须命中源侧认证——
  `lineageVerified`（每条 subagent 行都有可用父边）或保留表 `subagentKnown`（基线不可判时
  不清，durable 子代仍在官方列表里）：认证过 0 判 idle、>0 判 busy，认证位缺席但保留表命中按
  busy（列表不完整 ⇒ 抑制而非误报）；其余（watcher/无谱系证据）保持 presence/unknown，
  绝不据此压制完成（complete 通知延迟 G4 与徽标/待办压制同规——误判 busy 就是永久 hold）。
  口径与落点见 design 19 §3.5 与 `packages/renderer/src/source-mux-facts.ts` 的 `lineageFactsForRows`；
  goal 门的唯一出口同样是本模块的 `goalSuppressesPresentation`（§4.3），待办与徽标
  只消费它的结果，不得各写一遍。

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
  `packages/dsh-chamber-client-core/src/aggregate-store.ts`）；ui-layout fork 的 `document-theme.ts` 按
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
  （活动视图发布，`useLayoutEffect` 保证绘制前生效）、`packages/dsh-chamber-client-core/src/aggregate-store.ts`
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
    钩子：读 vendor LocaleFace 的 active，用 `ctx.configForms.get('locale')` 的
    status 判「设置面已敲定」）＋ `chamber-entry.ts` 挂载装饰器
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
  监听，属同一"N-ctx 单文档"缺陷族：①**文档级 `drop` 扇出（已修）**——vendor
  `ui-attachment` `ComposerAttachments.tsx` 在 document 挂 drop 监听且无
  containment/活动视图判定，local 与任一挂载远程同时在场时拖入图片会同时附到
  两个实例的草稿；已按「按 event.target 归属」落地：两条构建期 vendor 补丁
  （`scripts/vendor-patches.mjs` 的 drop-events + ComposerAttachments，按 drop 落点
  所属 `[data-instance]` 子树 containment，design 25 §5.7）；②**`document.title`**（机制上仍活着，被主进程冻结窗口标题掩盖）——
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
  `<style>`（同内容，随各自 fiber 移除，良性重复）。①（document 级 drop 扇出）已按「构建期
  vendor 补丁 + 按落点壳 containment」落地：drop/dragenter/dragover/dragleave 四副作用同归属、
  隐藏壳不再入稿或叠遮罩（design 25 §5.7，残余见 S-56）；④ 的 portal 逃逸仍未修（任意打开态
  在程序化切换后盖在别的视图上），其中 `ui-attachment` 的 N 层遮罩已随本批 containment 消除。

### 4.7 面板轴（`sidebar.panellist` 的宽态落点）

**契约与 Rejected alternatives 见 design 05 §2「来源级面板轴」**；本节只记实现面与副作用。

- **宽态**：入口渲染在 owning source 的 server 头内——`ServerSectionHeader.tsx` 的
  `.sourceActions` 动作簇首位（视图选项左侧），由 `server.id === chamberInstanceId` 门控
  （每个来源都会渲染 section，`panels` 却属于本壳 ctx，故只在 owning/活动来源头里挂载一次；
  与旧 36px 行同一道门，否则会 N 份且点击落回本壳面板），每个 `sidebar.panellist` 注册渲染成一个 20px
  `.actionIcon` 按钮（`PanelHeaderEntry`，`sidebar-root-chrome.tsx`）：`usePanelInfo` 只订阅
  自己条目的选中态，`renderSlot('sidebar.panellist', { size: 14, active }, { only: id })` 取
  注册者的字形，点击经 `selectPanel(id)` 转发 `ctx.layout.selectPanel`。它随簇静息
  `display:none`（hover / 键盘焦点 / 视图选项菜单或搜索胶囊展开才显形）——2026-09 用户裁决
  「可以接受 display:none 保持静止不可见」。
- **rail 态**：分组不渲染，保留上游全局面板字形行（`SidebarRoot.tsx` 的
  `!wide && panels.length > 0` 守卫；18px 字形、tooltip、`aria-current` 与上游 rail 形态逐字一致；
  `PanelRow` 的上游 wide 半支（16px / title / disabled tooltip）随入口进头部成为死分支，
  2026-10 清理时删除而非留作不可达代码）
  ⇒ 每个条目任一时刻**恰好挂载一次**（位置锁：`test/plugin-kernel/panel-entry-placement.test.ts`）。
- **折叠只收浏览区**（搜索胶囊 / 来源级 git 提示 / 工作区列表）：入口在来源头内，折叠不隐藏它；
  折叠钮只有 `aria-expanded`、**无 `aria-controls`**，故不构成「受控区域已折叠却仍渲染其内容」的矛盾。
- **可达性（既有约束 + 一个新依赖）**：侧栏由活动来源的 ctx 渲染、ledger 只含该 ctx 的注册，
  因此入口只在**拥有它的来源成为活动视图**时可见（全局轴时代同样如此）。另：宽态入口还要求该来源
  已进入 App 的 `servers` 投影；来源不在投影时 App 的 `InstanceView`（含侧栏）**整个不渲染**
  （`packages/renderer/src/App.tsx` 的 viewId 门），不是「只有入口缺失」，rail 轴不受影响
  （自愈，不设回退轴——那会重新引入双挂载）。
- **断连来源**：入口仍渲染（「注册即在」，**有意不过 `connected` 门**；随头部动作簇 hover 揭示），
  点开的页面自呈该 Host 的失败态——与其余头部动作的 connected 门不同，是对「断连来源只渲染
  header + 状态」的**有意例外**。
- **语言**：label thunk 由该实例自己的 locale 解析（per-ctx），与页面语言归属一致。
- **形态与已知副作用**：
  - 盒形：宽态入口用 `.actionIcon`（20px 命中盒 / 14px 字形 / tertiary 墨色，hover 只变色），
    选中态 `.actionPanelActive` 用品牌浅底（`.sortActive` 同族 token）；不复用上游 36px
    `.panelRow` 行几何（该行只在 rail 保留）。
  - 静息不可见：入口与视图选项同簇，不 hover 时不占位；代价是「注册即在」只在 hover / 键盘
    可达路径上兑现（owning 头自身**不可聚焦**——`sourceHeaderActivatable` 对活动来源为 false；
    真实键盘路径是恒在且可聚焦的折叠钮：Tab 落到它，focusin 冒泡置位 `.sourceActionsVisible`，
    再 Tab 进入本条）。
  - **a11y 分组壳的丢失（有意、已登记）**：上游宽态是 `nav[aria-label=panels.label]`（「全局面板」）
    包住面板行；本仓宽态改为来源头动作簇里的裸按钮（每个按钮用注册者 label 自带可访问名），
    `panels.label` 只在 rail 的 `nav` 上渲染。同时**选中态 `.actionPanelActive` 也只在簇现形时可见**
    （旧 `.panelActive` 底色是可静息感知的「当前面板」标记）——两者都是「入口进头部、静息 display:none」
    的直接后果。
  - **wide↔rail 重挂载**：入口的两个站点父级不同，收起/展开会卸载→重挂（上游是同一元素）⇒ 键盘
    焦点若正停在该入口，折叠后落回 `document.body`（需重新 Tab）。入口组件无状态，无可见状态丢失；
    接受，不为此改结构（rail 不渲染 section，单站点方案在本仓不成立）。
  - 位置锁按**源码文本**钉：入口在 `.sourceActions` 内、`cc.sortActive`（视图选项）之前，
    `ServerSectionPanels.tsx` 已删除且 `ServerSection.tsx` 不含任何面板轴挂载点（本包无 DOM）；
    「不过 `connected` 门」另有一条同文件锁——header 元素到入口之间无 `server.connected`，
    且动作簇以无条件兄弟节点打开（含 section 的 header 站点）。
  - `ui-schedule` 的**点击埋点**（上游 `selectPanel` 对 `plugins`/`schedules` 发
    `sidebar_menu_click{menu_name}`）**有意未复制**：它是遥测而非 UI 行为，且桌面壳是否上报
    产品分析是既有开放裁决（STATUS 遥测条）。若将来要逐字对齐，落点是
    `packages/dsh-chamber-client-ui-sidebar/src/client/index.ts` 的 `selectPanel`
    （实际可达的只有 `schedules → 'cron'` 一条，`plugins` 面板在本仓已迁设置页）。
- **Rejected alternatives**（实现面）：① 36px 面板行挂在来源头与浏览区之间（早期实现；行高使
  section 增高约 38–42px、把入口从头部动作簇割出来，拖拽中点与滚动回退锚都随之位移）——2026-09
  用户裁决删除；② 常驻显示在状态点旁——用户明确接受静息 `display:none`；③ 全局轴 + 分组内双渲染
  ——一条注册两个入口，上游只有一行；④ rail 不显示——丢掉上游「折叠后仍可达」；⑤ 26px 密度变体
  ——本批明确维持上游 rail 几何。

## 5. 已知取舍与开放项

- **置顶（pin）：渲染分区已落地（Phase 4 选项 1），残余 = 块内拖拽 + 跨块守卫 + 账号写入**——
  pin/unpin 写入口、静息标记、两个行入口与**置顶分区**都已按上游形态落地（§7）：置顶行在其所属
  分组、树节点与 flat 列表里领跑（上游 `sectionMembers` 的 blank → pinned → 其余三段语义，
  `pin-partition.ts`），manual 的块内序取宿主「最近置顶在前」的 `pinnedSessionIds`，updated 保留本仓
  account 序，搜索结果不分区（上游同）。**未做（登记）**：置顶块内拖拽与跨块守卫；把置顶写进本地
  账号（上游 `pinSessionOrder` 的持久领先槽语义）——本仓 `unpin` 后行回它自己的自然位，而不是停在
  非置顶块首位（登记偏差 B2，STATUS 必要取舍）。拖拽候选与残余见 `todo/upstream/upstream-ui-parity-plan.md` §1.1。
  来源级诚实不变：置顶集只有挂载 follow（基线 + `{type:'pinned'}` 增量）一条线源，单列表 unary 兜底
  来源不渲染任何标记、无置顶块（blank 占位行仍提前）（`pinSetKnown` 三态与归档集的 `archiveSetKnown` 同一条规矩）；
  ①**未挂载来源上的 pin 是"发送即忘"**（unary 兜底没有置顶线源，标记/分区只在该来源挂载、基线到达后
  才出现，延迟无界）；②**半开 follow 通道**（WS 冻结、HTTP 仍活）下 pin → HTTP 归档 → HTTP 恢复 会让
  本地置顶集仍指着该 id（宿主归档时已清、此后的 unpin 是 no-op），直到基线重放——本仓不做乐观回声，
  修法方向见 parity plan §1.1。行级失败槽每行只显示一条且不清陈旧键：pin 键插在 archive 与 unarchive
  之间，归档/恢复后陈旧键仍可能显示（既有族行为）。
- **归档筛选（`archivedFilter` 三态）已落地**（§3.4）：default 隐藏 / show 原槽位混入 / only 仅归档行
  并丢弃无可见成员的 workspace；列表与搜索同规则；归档行置灰、不可开（点击就地提示）、不可拖（仍是
  落点）、状态槽留空、pin 两入口缺席、归档钮/菜单项翻转为「恢复」（官方 `workspace/unarchiveSession`）；
  归档后触发来源 section 内提示条给「撤销 / 筛选已归档会话」（上游 `RowActionToast` 的实例化，D5）；
  only 空态可一键跳回。**降级规则（本仓特有状态）**：`archiveSetKnown !== true` 时筛选轴三项整体禁用、
  按实际渲染态（隐藏已归档）显示选中、存储值保留，集合恢复已知后自动生效（点击默认项会把存储值写回
  `default`，故默认项也禁用）。管理器（design 24）仍是批量维护面，purge 是其独有能力。
- **flat 单列表已落地（per-source）**：该来源一条平铺列表（伪账号替换分组列表，不渲染工作区表头），
  manual 走 `flatOrder[sourceId]`、updated 走 `flatAccountKey(sourceId)` 哨兵账号；会话拖拽只写本地账号、
  不发 wire（上游 flat 账号同规则）。**不做跨来源平铺**（拒绝项见 §12）。
- **按工作区树已落地（家族优先）**：上游 `owningParentFolder` 的已注册父目录前缀嵌套；派生 worktree 的
  显示父级取它 main 的父级，家族不被拆开（design 08 §3.3 连续家族不变式）；无 git 家族信息时退化为
  纯前缀。树只改缩进不改序：同级顺序仍由 wire 序与家族约束决定，父组折叠只隐藏自己的会话行。
- 跨实例 `dsh.sessions.current` localStorage 共享键（last-writer-wins）：
  接受——镜像运行时既有行为，通道原样携带。**代价**：共享键使每个壳冷
  boot 都"没有可恢复的会话"，官方初始导航随即在其最近工作区复用/新建（宿主侧
  `session.create`）一个 blank 会话并打开——包括后台预热/基线收割这类用户没点过的
  挂载；chamber 的打开意图三闸门只消除**用户可感的中间态**，不阻止那次 create。
  偏差登记见 design 05 §2.2.1「登记残余」与 STATUS「远端宿主上的空白会话残留」，
  根治提案见 `docs/progress/todo/upstream/upstream-proposals.md` §1。
- **完成未读对齐的明确放弃（仍成立，发布说明素材）**——下列能力是「官方位唯一
  权威」的代价，逐条登记（判定/生命周期与上游相同，偏差只在呈现）：
  - **重载即忘**：官方位是 ctx 内存 Set，桌面 reload/重启后全空；chamber 不再有
    durable 账本，也不做任何恢复或播种。
  - **未挂载来源的官方完成位仍缺席**：无 ctx 即无官方 `completionUnread`（「正在阅读」的
    解除语义也只存在于挂载 ctx）；但本轮加了受控的**判定侧读回退**——facts-only provenance 的
    来源由修正臂按逐行 host 运行边沿补蓝点、facts 候选补完成通知（§4.1/§4.2、
    design 19 §3.2/§3.5），只在**无 ctx 上报**时生效。
  - **手机读不再清桌面**：跨端读回执（mobile `read-watermark` + gateway
    `POST /chamber/session-state/read|read-all`）随权威切换整体退役；桌面点/角标
    只由本端阅读解除。
  - **「全部已读」入口消失**：来源级批量已读（桥/菜单/文案）整体删除。
  - **facts 水位不再参与武装**：observer 域 `completedAt` 不武装未读（无水位、无
    播种、无时间域概念；facts 只服务通知候选与渲染）。无壳路径的 `beforeBaseline` 支也只用
    host running 边沿 + status 首发位，不引入 observer 戳。
- **有壳来源在 shell 首次观察之前的完成仍无官方位**（与上游相同）：官方位只在已挂载
  ctx 里产生。本轮起该窗口只在**没有 facts 载体**时才是完成的盲区：P2a 镜像 / P2b 观察者与
  挂载无关，被观察到的 host 运行边沿 + facts 候选可补完成点与通知（§4.1/§4.2）；采样粒度
  之间起止的短任务仍可能漏（P2b 30s 基线、poll 档一个周期，design 19 §3.5 与 STATUS）。
  空闲预热仍保证连接后尽快挂载。「不做轮询级完成推导（10s 粒度会漏掉更短任务）」仍是官方位的
  边界：无壳完成点来自 host 运行边沿，不是轮询采样推导。
- **修正臂跨断连冻结**：上报事实（runtimeFacts）断连即清（generation 级），修正臂
  在无上报时冻结（不武装也不清除）——断连期间该来源无行可显示，也不会有新完成；
  重连后按新上报重新对账。官方位照旧留在 vendor 内存 Set。无壳路径同规：facts 降级窗口
  保留行 + `stale` ⇒ 只冻结武装、保留边沿记忆；桥面上报撤回（`report === undefined`，
  facts 载体未换代）只清壳轨、保留 running 记忆与 facts 轨（§4.2 分域）；真正换代/退役由
  `withdrawSource` 缺省 `scope='all'` 删 running 记忆与观测状态、撤回账本易失轨，
  **臂表冻结不误清**（§4.2）。
- **保留的呈现偏差（仍成立）**：Dock/任务栏红气泡与桌面通知是 chamber 独有（上游
  无对应物），角标 = 官方位 ∪ 修正臂的投影 + 既有 goal/子代理压制（design 19
  §3.7）；品牌蓝点与 14px pending 徽标同 §4.3。
- 结果标题滞后 / 聚合错误源隐藏搜索 / rail 无搜索：接受（§1.2）。
- 拖拽无 touch/键盘：已知限制（官方亦然，Electron 桌面）；拖拽乐观重排不设回滚：
  pull 模型自愈 + inline 错误，接受。

## 6. 验证门

- 纯函数单测：`reconciledSessionOrder`、`view-prefs` 读写/单例通知/裁剪、
  搜索 sanitize、`todo-attention` 派生、`todo-prefs` 水合
  （`test/session-rows/derive.test.ts`、`test/session-state/view-prefs.test.ts`、`test/session-rows/todo-attention.test.ts`、
  `test/session-state/todo-prefs.test.ts`，node:test 风格）。
- **上游对齐判据**：以下对齐面仍是契约（判据见该包测试）——归档
  动词在行菜单，另有同一动词的行内悬停钮（§7「行内操作」）、全包无原生 confirm、workspace 删除是官方 `Modal` chrome（含对话框内
  `role="alert"` 失败行与「仅成功才关闭」）、**同一时刻至多一层 chamber Modal**（见下）、
  completed 走 chamber
  品牌蓝点（官方 `done` 绿点因与来源头连接点同 token 被否）、
  行窗口是双向 disclosure、行菜单 `closeOnPointerLeave` 且 `compact`
  （`compact` 一项由"非 compact"改回，见 §7 菜单密度口径）、
  `{name}` 参数化可访问名（pin 的行钮按上游用行菜单长名，是这条政策的**有意例外**，判据在
  `test/session-rows/session-row-actions.test.ts`）、**pin 面形态与行级漏斗**（同文件：座席顺序 100/200、静息标记的
  稀疏集合事实、`pin` 行错误键、in-flight 守卫与 toggle 方向）、上游 pin 形态/座席/文案/线协议的源码 lockstep
  （`test/session-state/vendor-session-fact-contract.test.ts`）、活动定时任务标记的位置、`data-git-action`
  属性钩子（`:disabled` 在方括号之外）；行为面单测在函数旁边
  （`test/session-rows/session-row-window.test.ts` 的 disclosure 窗口、`test/plugin-kernel/panel-source.test.ts`
  的 `createSnapshotStore` 投影与通知纪律）。
- **同一时刻至多一层 chamber Modal（对称门）**：
  官方 `Modal` **没有焦点陷阱**（vendor
  `ui-primitives/src/Modal.tsx`：一层 body portal 遮罩 + 每个打开实例各自一个
  document 级 **BUBBLE** Escape 监听），而「孤儿徽标」与行内孤儿清理钮都是常驻、可 Tab 到的
  按钮（`ServerSection.tsx` 的 `cc.orphanBadge` / `cc.orphanCleanup`，都在 hover 簇之外，
  且共用同一个 `onDeleteWorkspace` 打开方），键盘用户可 Tab 到
  任一遮罩之后武装第二层，两层各注册 Escape 监听、一次 Esc 双关（design 24 §6 项 7
  正是归档管理器拒绝第二层的理由）。真不变量落在**打开方**、不在遮罩：
  `SidebarRoot.tsx` 的单一谓词 `otherChamberDialogOpen(self)` 被**全部四个打开方**
  咨询——删除武装（`onDeleteWorkspace`）、归档管理器（`onOpenArchiveCleanup`）、
  归档活动确认（`openArchiveConfirm`：两段式第二调前的「停止并归档」层）、
  添加工作区浏览器（`openWorkspaceBrowser`；节 `ServerSection` 只拿得到这个带门的
  opener，拿不到裸 setter）——每个子句排除自己那一层，故**任一方向**最多只可能有一层；
  被拒的控件在该层消失（cancel / X / 遮罩 / Escape 均可）后立刻恢复，能力不丢。
- 包级门：`pnpm run typecheck`、根 `typecheck`、`typecheck:layout`、
  `typecheck:sidebar`、`pnpm run build:renderer`、
  `pnpm run verify:i18n`、`test:sidebar`、`test:layout`、
  `test:renderer-shell`；control-plane 套件为回归门。

## 7. 样式定稿（设计）

- **Token 契约**：状态色 `--dsw-alias-state-{success,warn,error,business}-primary`（completed 点 /
  connected 徽标、pending 点、错误文本）、运行中点 `--dsw-static-deepseek-450`、搜索胶囊 focus 边框
  `--dsw-alias-brand-primary`、折叠 chevron `--dsw-alias-label-caption`、来源头底色
  `--dsw-specific-sidebar-fill`；不存在的 `--dsw-alias-accent/success/danger/input-fill` 一律不得使用。
- **来源 accent**：每元素 `--chamber-source-accent` 承载远程来源 hue（柔和色板 `hsl(hue 34% 61%)`；
  本地省略、回退默认 ink），用于来源头激活左内边线与 rail 活动环；**workspace 组 chevron 不取来源
  accent**（workspace 图标自带确定性 accent）。**来源头身份圆点已移除**（折叠字形 accent 承担身份；
  rail 点保留）。
- **workspace 图标 accent**：workspace 头行内联 `--chamber-workspace-accent`（`.foldToggle` 基色/hover
  同取，图标 currentColor）——色相 = `(serverId, 家族种子)` 哈希 × 137.508 黄金角步进 mod 360，
  明度 56/61/66%（第二哈希抖动）；家族种子 = `repoKey`（worktree 与主检出共享色相，改名不漂移；
  `mainWorkspaceId` 仅作无 repoKey 回退），worktree 饱和 21%、主检出/普通 workspace 34%；未分组桶
  无 accent 回退 caption ink；来源首个 git 快照发布前不渲染 accent（默认 ink），
  `isSourceGitFlagsLoaded` 后整源一次性落定。纯函数 `workspaceAccentStyle`
  （`packages/dsh-chamber-client-core/src/derive.ts`）；无自定义、无持久化、**与选中态无关**（当前会话
  指示由 session 行官方 selected tint 承担）。
- **当前会话高亮**：session 行 = 官方 `.sessionRow.selected` 的浅 `interactive-bg-hover` 色调
  （无 inset 阴影、无深色调、无标题加粗）；所在 workspace 组无底色、图标色恒定；两组高亮永不相邻融合。
- **打开意图在途 ⇒ 不投影"非请求中"的 current**（05 §2.2.1）：来源还有在途 `openSession` 且其投影
  `current` 不是请求会话时不投影 `runtimeFacts.current`（`projectableCurrent` 纯函数）——消除
  「切远程会话先闪一行高亮」；**幂等重开保持高亮**；离开的活动来源的 blank 行仍由 ghost 槽保护位移。
- **回声工作区行**（05 §2.2.1）：新建工作区后立刻渲染一行回声行（真实宿主 id、`sessionIds: []`、
  标题 = 路径 basename）；**不带 `synthetic`**，workspace 级动作照常可用；与同路径合成组相遇时**原位
  替换**后者；权威 push 列出该 id（或同路径真实行）后由权威行接管。
- **排版**：字号下限 12px；会话标题 13/18（官方 14px，此为多来源密度折中）。**墨色 = v0.2.4 的静止/hover
  两级**（官方是常驻 `label-primary` 无 hover 覆盖，本页不取）：会话行标题静止 `label-secondary`、
  行 hover 转 `label-primary`（`.sessionRow:hover .sessionTitle`），搜索结果标题与待办条带同语言
  （`.todoRow` 自带次级墨色、`.todoRowTitle` 随行两级）——只按官方常驻主色时行 hover 只剩极低对比
  底色 wash，卡片出现前读不到反馈。**这是对官方的有意偏离**；搜索结果与结果行的 12/18 字号、结果行
  几何仍归 §1.2 待决。来源身份点 8px（**仅 rail**）；session 行首为固定 10px 状态槽（常态空）。
- **行几何**：圆角 8px（来源头/workspace 头/会话行一致）。
- **搜索胶囊**（§1）：`border-l4` 发丝边（= 官方 `.searchExpanded`；胶囊体 r-md、无填充）+ `:focus-within` 品牌墨色边框（官方 primitives `Input.module.css` 的 `.wrap:focus-within` 是 `state-business-primary`，本仓用 `brand-primary` 墨色，属登记的视觉档位）；`maxLength` 取
  `SEARCH_QUERY_MAX_CODE_UNITS`；30s 调用方 abort；结果分支优先于 aggregateError。
- **未连接来源呈现**：搜索入口按 `connected` 门控；状态徽标语义见 05 §2.1（色点/转圈枚举、重试折叠为
  稳定「重连中」、相位文本仅 hover/aria）；状态槽居来源头右端、hover 时被搜索/新建会话簇替换；全部断开时
  保留各来源分组、空态为列表底部一行；断连即清空该来源搜索状态。
- **行内操作（图标化 + 悬停替换）**：workspace 组头 = 新建会话钮（官方 new-chat 字形 `IconNewChatOutlineRegular`，16px 默认）+ 官方 16px 横排三点 kebab
  （重命名/删除，`Menu` portal）；横排省略号按官方 16px（不旋转 90° 成竖排 14px），`.actionIcon` 20×20
  命中盒不变。**动作簇间距**：统一走图标节奏 **4px**（`.rowActions` 与 workspace 头自身），不取官方
  `Rows .rowActions` 的 12px（只描述无 git occupant 的两项簇，含 `.headerGit` 的三项簇会被切成
  4px+12px）；`.headerGit`/`.sourceActions` 的 4px 出自命中盒 pass、随该 pass 回到 v0.2.4 的 2px。
  **孤儿行例外**：`.orphanCleanup` 是**常驻**（不在 `.rowActions` 内、不吃 hover 揭示）的
  20×20 `.actionIcon` 垃圾篓，静息取 `state-warn-primary` 墨色（与 `.orphanBadge` 同一条告警语言）、
  hover 交 `.actionIconDanger`；只在 **orphaned 且 isWorktree** 的真实 workspace 行渲染
  （`!ungrouped && !synthetic`，与头内其它控件同门）——worktree 行没有 kebab（design 08 §3.2），
  且工作树记录消失后 Git occupant 不再挂载（`SidebarWorkspaceGitLine.tsx` 读到 `gitFactsForWorkspace`
  为空即整块 `return null`），它是该行唯一的显式删除动词，因此**不得**收进任何 hover 揭示。
  旗标历史缺失（记录已 prune 之后的冷启动）时 `isWorktree` 回落为 false，本钮不渲染、该行按普通
  workspace 形态带 kebab，入口不丢；Git 来源整轮失败期间的入口缺席是已登记残余（design 08 §6.4）。
  细节与被否方案见 §11。
  session 行簇 = **置顶/重命名/分叉/归档四项菜单的 kebab** + **独立归档钮** + **独立置顶钮**（上游 ui-workspace
  `session-actions/ArchiveSession.tsx` 的 `ArchiveSessionRowButton` 形态移植：同一簇里 kebab 之后的第二个成员，
  `IconArchiveOutlineRegular` 14px / 20px `.actionIcon` 命中盒、tooltip 用上游键 `actions.archive`
  （`side="bottom" align="end" delayMs={500}`）、无障碍名按本仓行级政策**参数化行名**（`action.archive.aria`；
  上游同座席用的是行菜单同款泛化名，本仓记为有意分歧——菜单项仍是 `menu.archiveSession`），点击走既有两段式
  归档出口（标题随行传入）；归档筛选落地后（§3.4）归档行随三态进投影，该钮与 kebab 归档项在归档行上
  **翻转为「恢复」**（官方 `workspace/unarchiveSession`，图标/文案/aria 同步切换，即上游同文件的 unarchive 半支）；
  kebab 里的归档项保留（快捷方式入口）。**pin 面**（上游 `session-actions/PinSession.tsx` 的两个入口 + `PinnedIndicator`，见
  checklist §4.6）：菜单项 order 100 = 菜单首项（键 `menu.pinSession`/`menu.unpinSession`）；行悬停钮 order 200 =
  归档钮之后的最右成员（tooltip 上游短名 `actions.pin`/`actions.unpin`，无障碍名**照上游**用行菜单长名——
  行名参数化只留在归档钮上；14px 实心/空心双字形）；静息标记 = 上游 `PinnedIndicator` 形态（非交互
  `role="img"` + `row.pinned` 双名 + 14px 实心针，`.pinSlot` 跟齐本仓动作盒 20×20、caption 墨色、
  **不另加左边距**——间距由本仓行的 6px gap 供给；对照上游 16×20 + `margin-left:6px`，两处差异都只源于本仓
  行结构（上游 row gap 为 0，那 6px 就是它的全部间距；上游两个盒都是 16px），已登记 checklist §4.6），
  落在状态槽之后、与状态槽共用同一条 hover 换出规则——复现上游「静息标记与悬停钮共用行右缘同一格」的替换语义
  （盒宽跟齐动作盒使 hover 换入不跳字）。
  **置顶分区已落地（Phase 4 选项 1）**：置顶行领跑所属分组、树节点与 flat 列表（上游 `sectionMembers` 语义，
  `pin-partition.ts`）；manual 块内按宿主「最近置顶在前」，updated 保留本仓 account 序；
  `pinSetKnown !== true`（老宿主形状 / unary 兜底）时无置顶块（blank 占位行仍提前）、标记不出现、动作按 pin 方向出（宿主 pin 幂等，
  重复 pin 无害；反向才会造成假断言）；块内拖拽与账号写入未做（§5）。
  **会话行簇是纯指针出口**：行自身无 focus 座席
  （无 tabIndex/roving），揭示只有 `:hover` 与 kebab 展开两半（要键盘可达需先给行加 focus 路径，属未决取舍）；
  键盘焦点那一半属于 workspace 行与来源头部（JS 揭示态）。悬停替换行尾状态槽；**不显示
  相对时间**）。**添加工作区** = 来源头部按钮（官方 project-add 字形，与搜索/排序成簇、悬停替换连接
  状态槽，胶囊展开时簇保持可见）；文案在 aria 与**官方 `Tooltip`**（来源头内建动作——簇首的每条
  `sidebar.panellist` 入口、排序菜单、添加工作区、搜索、归档清理——由原生 `title` 换成设计系统
  Tooltip，形状串 `side="bottom" delayMs={500}`；workspace 新建会话钮的
  label 用官方的独立键 `actions.newSession`（zh「新会话」/ en "New session"，不共用 `session.new`）；行与状态槽
  仍原生 title）。替换为真正 display 交换；kebab 展开或**键盘焦点（Tab）**期间行操作保持可见（`.rowActionsVisible`，键盘态见上条「悬停替换」；键盘路径只有 workspace 行与来源头部——会话行不可聚焦，其 kebab 没有键盘入口，见 STATUS「范围决策与必要取舍」）；行内
  图标按钮全量 reset（`appearance:none`/`outline:none`/grid 居中，focus-visible 用 brand 自绘环）。
  **菜单密度 = primitives `compact` 档**：三个菜单（session kebab / workspace kebab / 排序）一律原语
  `compact`（= `.compactList`），`closeOnPointerLeave` 保留（v0.2.4 即此档，属恢复发布行为）。**pin 实测值**
  （`ui-primitives/lib/Menu.module.css`）：`.compactList .item` min-height 24px / padding 2px 6px /
  圆角 `--dsw-radius-sm`=8px / 11px·17px / gap 5px；`.list.compactList` min-width 156px / padding 4px；
  `.compactList .label` padding 3px 6px / 10px·15px；`.compactList .itemIcon svg`/`.check` 12px（`.compactList .itemIcon` 这个 wrapper 本身即 12px，14px 只是原语默认：
  item 34px / 13px·20px / r-md / padding 6px 8px、itemIcon 14px、`.list` min-width 144px）。**不把菜单行抬到
  侧栏列表行的 26px/13px**：pin 无 item 级钩子、无 CSS 变量，抬行只能 `:global` 覆盖哈希类名或改
  `listClassName` 后的后代选择器；两个 kebab 菜单与设置页下拉因此比列表行矮 2px，属**接受的偏差**（不追官方
  默认 34px，也不自建 26px）。设置页服务器下拉是自家 markup：`padding:7px 10px`、13px、行框 18px，圆角/背景 = 官方
  （item r10、列表 r20 + `bg-layer-3` + elevation）。
- **图标钮命中区 = 视觉盒（回退命中盒 pass）**：小于 24px 的六个图标钮（`.actionIcon` 20 /
  `.searchButton` 20 / `.searchClear` 18 / `.foldToggle`、`.sourceFoldToggle`、`.railDotButton` 16）
  连同 `.sourceActions` 2→4px gap 一起回到 v0.2.4 几何：**命中区就是视觉盒**。机制与「缓解而非根治」
  的完整说明在 `sidebar-chamber.module.css` 的 `.actionIcon` 注释块（唯一权威处）；一句话：rim 把
  行/头部「纯行」带压到 ≈0–1px，指针离开该行时 Chromium 只发 native `pointerleave`、不发
  `pointerout`，React 不合成 `onPointerLeave` ⇒ `hover-intent` 的 `inside` 保持 true ⇒ 卡片
  「关不掉/异常打开」。它缓解排名第一的触发（从动作簇离开该行）；无指针位移触发与「极快甩动跨过
  ≈3px 带」仍在，根治需不依赖 React 合成的投递通道（**未实现**，见下方悬停卡片条与
  `dsh-chamber-client-core/src/hover-intent.ts`）。代价：24px 目标尺寸重新成为本模块偏差
  （design 24 §13 第 17 条、design 08 §3.4）。**簇间距**：`.rowActions` 4px 与 footer 4px 保留；
  `.sourceActions` 与 `.headerGit` 回到 2px。**rail**：只回退该 pass 加宽的 `gap`（16→12px），点按钮
  自带 `margin: -4px 0` 保留 ⇒ 20px 点距 / 12px 可见间隙；**不要只删 margin 不改 gap**（点距会松成
  28px/20px）。该几何以 `sidebar-chamber.module.css` 的注释块为唯一权威处；**不要再加回 rim**。小图标钮圆角 = `--dsw-radius-xs`
  （=4px，官方 rows 图标钮角色值；官方 WorkspaceBrowser 的 28px 搜索钮与 24px 清除钮用 r-sm=8px，本模块因回退到
  20/18/16px 视觉盒而用 xs；`.railDotButton` 是 8px 点的无圆角热区，不声明 radius）。
- **会话行窗口与展开条**：每个 workspace 只展开前 N 行（`sessionRowWindow`），其余由展开条揭示；
  与上游的**配额语义差异**（登记见 §3.4 的 B9）：上游把 blank/running/有存活子代理的行排除在
  空闲配额之外（运行中的行永不被折叠），本仓按位置窗口（首个窗口 + 当前行），第 N+1 行若在运行
  会落在展开条之后；
  展开条用官方 `sessionOverflowButton` 几何：28px 高 / r8 / `0 12px 0 26px`（左内距取会话标题列
  26px，官方 28px）/ 12px 字 / hover 次级色。展开条是**双向 disclosure**：`aria-expanded` 报告状态，
  展开后同一控件给出 `sessions.collapse`；隐藏计数由与展开位无关的 `sessionRowDisclosure` 窗口算出
  （按展开后的 hiddenCount 决定去留会使点开一次再无收起入口）。
- **悬停卡片**：workspace 头与真实会话行悬停显示卡片——workspace 卡 = 标题 + 展示路径 + 绝对创建时间
  （上游 `WorkspaceHoverContent` 逐字：`path` 与 `Date.parse(createdAt)` 进投影；`createdAt === undefined`
  的合成 ungrouped 桶不挂卡，且 derive 对不可解析的 wire 值做**稀疏写入**——`''`（unary 兜底的 cwd 派生组）
  不产出 `NaN`，否则逐字的 `createdLabel` 会画出「NaN年NaN月NaN日」），点卡片复制 cwd；展示路径为**绝对路径**
  （官方在宿主给出 home 时缩写；本仓**选择**绝对路径——`dsh-api-remotes` 的 home 事实可达，非外部约束，收敛记录见
  `todo/upstream/upstream-ui-parity-plan.md` §2）；
  会话行卡 = 标题 + 相对时间 + 状态点列表 + 复制标题按钮
  （blank 行不显示时间）。开卡 dwell = 上游行内值 **800ms**（`RowHoverCard` 机器默认 500ms = vendor
  `HoverCard` 默认值；两处 call site 显式传 800，与上游 `openDelayMs: 800` 一致）。
  disabled = 菜单打开、拖拽中或行内重命名进行中（`menuOpen`/`sessionDrag`/`workspaceDrag`/
  `serverDrag`/`renamingThisWorkspace`）。
- **会话标题跑马灯**：`session-title-marquee.ts` 逐字拷自上游 `rows/Rows.tsx`
  （`MIN_TITLE_REVEAL_PX = 8`、`TITLE_MARQUEE_PX_PER_MS = 0.03`、`placeTitle`/`restTitle`/`useTitleMarquee`：
  range ≤ 下限不动、reduced-motion 直跳端点、rAF 等速爬行、卸载 `cancelAnimationFrame`）；行把
  `enter/leave` 挂指针、`ref` 挂标题 span，CSS 三条 `[data-scrolled]`/`[data-clipped]`/两者规则画双端 12px
  渐隐（hover 与菜单打开时 `text-overflow: clip`）。行为锁：`test/session-rows/session-title-marquee.test.ts`。
  - **实现归属**：卡片由本包 `client/RowHoverCard.tsx` 渲染（不用 vendor `ui-primitives HoverCard`）；
    **开合状态机**在 `packages/dsh-chamber-client-core/src/hover-intent.ts`。原因：vendor 版
    （`onPointerLeave` = `clearTimer()` + `if (open) armClose()`，arm 宽限由**上一次已提交的 open** 决定）
    在 dwell 到 React 提交之间落下的 pointerleave 什么都不 arm，卡片挂载后指针已离开，只能靠「再悬停
    并移开」清除（本仓每实例一个大 React root + N-ctx 多壳共用调度器）。本包机器以**同步指针在场标志**
    为准（dwell 触发时复查、leave 无条件 arm 宽限），与提交时机无关，且**开合事实只有一份**（机器即
    store，组件经 `useSyncExternalStore` 渲染）；修正落在本包（vendor 只读）。**退役条件 = 上游修掉该
    竞态**，机器判据 = `verify-upstream-touchpoints.mjs` C15（两侧形状 + 时间常数逐值锁步），登记行见
    `docs/checklists/upstream-touchpoints.md` §4，偏差本体与剩余实机验收见 `docs/progress/STATUS.md`。
  - **相对官方原子的有意增量**：卡片盒（244 宽 / r12 / pad 12-16 / `--dsw-shadow-lv3` / `#2C2C2E`）、
    8px 右偏移、200ms 宽限、按下即收与「点卡片复制」契约与官方等价；差异：①**同一文档只允许一张行卡片
    可见**（页面级 slot，跨 N-ctx 壳共享，后开者关先开者，也是「leave 没送达」的自愈路径）；②**窗口
    blur / 文档 hidden 关闭可见卡片**；③**N-ctx 视图隐藏即关**：卡片 portal 到 `document.body`、非所属
    视图后代 ⇒ renderer 的 view-hide 路径在同一 commit 调 `dismissVisibleRowCard()`
    （`packages/dsh-chamber-client-core/src/hover-intent.ts#dismissVisibleRowCard` 的调用点在
    `packages/renderer/src/components/InstanceView.tsx:548-552`）；④**两轴定位 + 越界即关**：水平仍夹取，
    垂直**不设**官方「贴视口上缘钉住」地板，锚点滚出视口即关，位置由 `ResizeObserver` 重算（上游只有
    scroll/resize）；⑤**复制纪元与上游对齐**：关闭路径（唯一出口 `open === false`，三路都经过）先自增
    copyEpoch 再清理，否则关闭时在飞的剪贴板写入会在新卡上亮一瞬 `copiedLabel`；⑥会话卡状态行
    **0–1 行**，上游 **1–2 行且至少一行**（兜底常驻 `status.idle`；本包只在有状态时渲染，状态优先级
    见 §4.3）。workspace 卡已与上游同形（标题 + 展示路径 + 绝对创建时间，点卡片复制 cwd 及其
    a11y/键盘复制），会话行卡复制的标题 = 上游 `sessionNode.title = sessionTitle(s)` 的同一展示标题
    （blank 行不复制），都不再是偏差。
    **Rejected alternatives**：保留只读 workspace 卡、不新增投影字段——否决，用户报告的原始症状就是卡片缺
    path/创建时间；新增字段只进投影（`ChamberServerWorkspace.path/createdAt`），wire 与宿主契约不变。
    **vendor 的 Tooltip 抑制契约不可达**：上游 `HoverCard` 用模块私有的 `TooltipSuppression` context 包 anchor，
    锚点内 Tooltip 显示时抑制卡片（`card = open && pos !== null && !suppressed`）；该 context 不在
    `ui-primitives` 的导出面（`createContext` 私有），本包无法接入 ⇒ 悬停 workspace 头的 `+`、会话行的归档钮与
    置顶钮（tooltip 500ms）时卡片（800ms）仍会同时出现。退役条件 = 上游导出该 context 或本仓自持 tooltip。
  - **同形状但不搁浅的先例（勿误记为竞态）**：vendor `Menu` 的 pointerleave 同形
    （`closeOnPointerLeave ? () => { if (open) armClose() } : undefined`），本包两处 kebab 菜单也显式
    opt-in；但菜单是**点击即同步提交**的受控 `open`（无 dwell 定时器），且另有外部 pointerdown /
    Escape / 窗口 blur 三条关闭路径，同一个 `if (open)` 不会搁浅。
- **a11y**：来源分组 `role="group"`、列表 `role="tree"`（可访问名 `section.sessions`，与搜索结果树
  `search.results.aria` 成对）、workspace 头 `role="treeitem"` + `aria-expanded`、会话行
  `role="treeitem"` + `aria-selected`、搜索结果行 `button` + `role="treeitem"`；来源头（非当前）
  `role="button"` 可键盘激活。**行级动作可访问名带行名**（`action.newSession.aria`/
  `action.menu.workspace`/`action.menu.session` 以 `{name}` 带行标题）——一排同读作「新建会话/更多
  操作」对 AT 毫无信息。**折叠 rail 每来源一个具名可操作按钮**：`aria-label` = 来源名 + 激活提示
  （复用 `sourceHeaderTitle`/`sourceHeaderActivatable` 单一判定）、当前来源 `aria-current`、
  **非当前且不可激活**（托管停机等）来源 `aria-disabled` 且点击不动作；点/环仍是内层 span 既有几何
  （点 8px、间距 12px），`aria-hidden`。**快捷键提示**：带命令的按钮/菜单项读目录行的生效绑定——toggle、
  New Session、workspace 新建会话钮、搜索、添加工作区在 Tooltip 上传 `shortcutKeys` 并在按钮上传
  `aria-keyshortcuts`；session 菜单的重命名/分叉/归档作为 `MenuItem.shortcut` 画键帽。键帽是官方目录行的**只读镜像**，
  不代表该命令在本仓控件上可达。四条命令的**回调接线**：`session.search`/`workspace.add` 写被覆盖的官方浏览器 store
  （无可见消费者 ⇒ 键帽只是只读镜像）；`session.rename`/`session.archive` 打开官方 `SessionRenameDialog`/
  `SessionArchiveConfirmDialog`——两者是 `shell.overlay` 的座席，本仓 layout fork 声明该座席并用官方 AppFrame 渲染，
  故模态真的出现（详见 `todo/upstream/upstream-ui-parity-plan.md` §1.3）。
  **Rejected alternatives**（键帽面）：①不给回调不通的命令画键帽——否决：官方目录四键同面展示，本仓按官方席位
  重实现控件，只在本仓侧隐藏会让同一条命令的来源可见性不一致；②自建 `chamber.*` 复用同一默认键——否决：注册表
  在 :602 对默认键重叠抛 `Conflicting shortcut defaults`；③覆盖注册同名官方 id——否决：`ShortcutRegistry.register`
  在 :589 对重复 id 抛 `Duplicate shortcut command`。
- **blank 行**：当前空白"新会话"行隐藏操作簇（对齐官方 `!row.blank &&` 门控）；双击同样被 `blank`
  门控（不进入内联重命名）；离开 current 后的 450ms 宽限 ghost 占位（`visibility:hidden` 非交互、
  保留布局位，`derive.ts armBlankGhost` + `.sessionGhost`）——双击窗口内列表绝不位移。
- **会话状态指示**：固定 10px 行尾状态槽——常态空、运行中 = 官方 `StateDot` ongoing 蓝圆环、运行结束
  未读 = **chamber 品牌蓝点** `.stateCompleted`（6px 实心；官方 `done` 绿点因与来源头连接绿点同 token
  被否，沿革见 §4.3）；**待交互 = 14px 图标徽标**（问号/清单/警示三角；几何与配色契约见 §4.3）。token：
  运行/completed = `--dsw-static-deepseek-450`（同一品牌蓝，形状区分），pending 徽标用
  `--dsw-alias-state-{business,warn}-primary`。状态槽非身份标记（身份由来源头折叠字形 accent + 激活左
  内边线 + rail 按钮/色点承担；连接状态点/转圈保留在头部右端）。
- **嵌套缩进（收紧）**：workspace 列表距来源头 10+1+6 = 17px；session 行左 padding 26px——session 标题
  相对 workspace 标题（24px）深 18px，server→session 标题级联 ~59px（原 73px）；会话级重命名表单与
  错误行同缩进。
- **拖拽鲁棒性**：行内控件（kebab/`+`/折叠/搜索/添加工作区/来源头激活/rail 按钮/**行内动作钮（归档、置顶）**）复用
  `suppressClickRef` 抑制拖拽结束后的尾随 click；`rowHalf` 对零高行防御；列表区域包一层
  `ChamberListBoundary`——意外渲染错误只让列表区显示错误文本，绝不带走整个 shell。

---

- **入场动画退役（可见性不变式）**：侧栏的 `wide-in`/`rail-in`/`rail-fade-in` 整组删除
  （`SidebarRoot.module.css`）——它们以 `opacity: 0` 为首帧，而 CSS 时间线只在子树被渲染时推进：
  隐藏实例壳（`content-visibility: hidden`）或窗口被遮挡时字标与设置座席会停在首帧（不可见、仍可命中、
  除重挂载外不自愈，WKWebView 实测见 STATUS）。必要内容不再参与入场动画；折叠的位移/裁剪仍由
  AppFrame 轨道过渡承担，`.fading` 保留（类驱动 + settle 定时器界定）。回归锁：`test/visual-lock/`
  + 渲染器隐藏壳门（design 05 §4）；设置壳按来源重放的 `contentFadeIn` 同批退役。类钩子 `css.wide`/`css.railIn`
  与 `everWide` 记账 ref 随动画同批删除（CSS Modules 对未定义的类返回 `undefined` ⇒ 幽灵引用；锁改为「不再出现」）。同一「切源后座席/
  字标空白」症状另有根因，本段只覆盖**入场动画特有**的失绘风险；当前根因（文档级重复 SVG 资源 id ×
  隐藏壳的 WebKit 丢绘）与修复契约见 design 05 §4.2。

- **行位移动效（自持移植上游 `AnimatedRows`，与入场退役不矛盾）**：浏览树的行增删/换位由
  `src/client/rows/animated-rows.tsx`（上游 ui-workspace `rows/AnimatedRows.tsx` 逐字移植，含来源头注）
  承担——换位的行 FLIP 滑到位（`ROW_GLIDE_MS = 200`，ease-out），进入行淡入，退出行克隆成 `inert` 覆盖层
  淡出（`ROW_FADE_MS = 100`，`fill: 'forwards'`）。**接入面只有浏览树**：`ServerSection` 用
  `<AnimatedRows className={cc.workspaceList} label={t('section.sessions')}>` 取代原列表容器 div，搜索分支
  与聚合错误分支各自保留裸 `cc.workspaceList`（搜索结果自带 `role="tree"`，不参与动画）。**key 契约**：
  `rowKeys` 在渲染 walk 中按同一 DOM 序 push（`workspace:` / `error:workspace:` / `error:workspace-drag:` /
  `error:open:` / `session:` / `more:`，空列表初始化 `empty`），与元素上的 `data-row-key` 一一对应
  ——例外有三类（都不是本轮引入）：过期 ghost 行与内联重命名的会话行**有键无可见元素**（ghost 只 `visibility:hidden`，
  仍占位、仍参与 FLIP），列表顶部拖拽指示 `listTopDropIndicator` **有元素无键**；尾部还有
  「未注册 worktree 的 git 块」与「添加工作区错误」不带 key（上游同批也不动插件渲染内容）：它们**自身**的位置跳变
  不可见，但上方行被删时 keyed 行会向上滑过它们已就位的新位置，存在 100–200ms 交叠——仅在存在未注册 worktree
  （git 块可见）时可感知；要消除得给插件内容加 keyed wrapper 并纳入 `rowKeys`，本轮按上游口径不做。另一处按
  上游口径接受的退化：上游以 list 自身 rect 做视口裁剪，本仓 `.workspaceList` 不是滚动容器（滚动在 `.chamberList`）
  ⇒ 裁剪退化为「全部相交」，屏外被删行同样克隆 + 动画（`finish` 即回收，无残留）。同类边界：**行集与 key 集来自不同判据**
  ——过期 ghost 行（键仍在、`visibility:hidden` 仍占位）与自动窗口上限外的行（键仍在、组件不渲染）都不会触发退出淡出，
  下方行瞬移；要消除得让 key 集跟着渲染判定走，本轮按上游口径接受。**门控**（照抄上游语义）：
  首次指针/键盘输入才 arm；`ready = aggregateReady && 无来源/会话拖拽`；
  `resetKey = JSON.stringify([orderBy, groupByMode, archivedFilter, sessionRowsExpanded, sessionRowWindowMotionKey(…)])`——排序/分组/筛选切换、会话窗口
  展开条与**被放大的自动窗口**都属「视图替换」，立即 settle 不滑动。窗口分量由 client-core
  `session-row-window.ts` 的纯函数给出，规则是**只有窗口被放大且放大后仍藏行的工作区**才记一条分量，且**只带
  workspace id**（判据 `visibleFirst < renderCount < total`：当前行落在截断区外迫使窗口长大——正是上游
  `sessionLimits` 的那一半语义）。**renderCount 绝不入键**：它由当前行下标派生，钳制组里"归档当前行上面一行"这类
  churn 会让下标上移、签名漂移，吃掉同提交的退出淡出/入场；进出放大态仍然翻键 ⇒ settle。
  **已登记边界**：窗口由当前行派生 ⇒ 当前行换到别处（例如在别的组点 `+`）会让原放大组的窗口收缩、**同一提交里整列
  settle**，那次 `+` 的入场被这次真正的视图替换取代（要改成"窗口伸缩只走逐行 fade/exit"，须先接受大跳转时整批测量的代价）。两端都不签：未钳制的组（`renderCount === total`）行数就是行数；**默认上限本身**
  （`renderCount === visibleFirst`）也不是视图替换——一个恰好 200 行的组点 + 后变 201 行、新空行成为当前行时，
  `renderCount` 仍是 200 却从"未钳制"翻成"被钳制"，签它会在同一提交里改键、取消这次入场（201→200 归档同理）。
  组数/顺序同样不进串。签名还只取**本提交真正渲染的组**：`visibleOrderedWorkspaces` 里再滤掉 per-workspace 折叠的组
  （它只渲染组头，窗口分量对视图无影响，却会因当前行移走而翻键）。
  **当前会话 id 不在键上**：官方 blank 可见性规则让新建行恰在成为 current 的那一刻出现，把 `currentId` 入键会在
  同一提交里取消它的入场动画（「在 workspace 上点 `+` 整列瞬移」的成因）。**也不能把每个工作区的渲染行数直接入键**
  （首版写法的实测缺陷）：未钳制组的行数就是行数，新建行出现的那次提交必然改键 ⇒ 又走 settle，而且数组形状还会把
  「新增 workspace 行」一起降级为 settle；上游的 `sessionLimits` 只在用户视图动作里变（折叠组 / reveal / 展开条
  步进，见 vendor `WorkspaceBrowser`），对数据抖动免疫——本仓的这两维（视图键 + 钳制窗口签名）正是同一效果。
  **已知偏差（登记）**：本仓的**来源折叠**（`folded`）不进键，折叠时下方行滑移而不是 settle（上游折叠组会把
  `sessionLimits` 重置为 `COLLAPSED_SESSION_LIMIT` ⇒ settle）；属既有行为，本轮不改。**重复维**：
  `sessionRowsExpanded` 与签名里的 `expanded` 输入重叠——保留是为了让窗口规则只由 `sessionRowWindowMotionKey`
  定义（这里不手写窗口语义），行为上无影响；`prefers-reduced-motion: reduce` 整体跳过；每次动画 `finish` 即 `cancel()`，静止态永远是元素自身样式。
  回归锁：`test/session-rows/animated-rows.test.ts`（移植体与 pin 住的上游逐字一致 + 常量/key 契约/门控）。
- **行位移期间的指针门控（`hover-motion-gate.ts` + `data-hover-gate`）**：一次提交把某 keyed 行搬到**静止指针**下时，浏览器会为该行合成 boundary 事件——本机 headless Chromium 149 实测：提交后 t≈347ms 收到 `pointerover`/`pointerenter`/`mouseover`/`mouseenter`（`clientX/Y` 与按下时相同，同期 0 个 `pointermove`），随后 `:hover` 也命中它。于是三条"指针进入"路径在用户并未指向该行时被触发：① `:hover` 揭示树（整行洗色占该行盒 93.19% 像素 + 文件夹→chevron + 计数徽标换 `+`/kebab + git 占位者换入）——即「删除会话时对应的 workspace 闪一下」；② `RowHoverCard` 的 `onPointerEnter` → 800ms 停留后卡片自己弹开；③ 会话标题跑马灯 `onPointerEnter` → 标题自己开始爬行。修法是**门控而非改动画**：机器在提交后的 layout 阶段（早于本帧 hover 更新，故 `matches(':hover')` 仍是位移前的真相）用 `getAnimations({ subtree: true })` 取候选，只给**本帧正在位移且扫描时不在 `:hover`** 的 keyed 行加 `data-hover-gate`（机器不读指针坐标；这正是本帧会 latch `:hover` 的那批）；下一个真实 `pointermove`（坐标变化）或 `pointerdown` 摘门控，并对仍在指针下的行补一次 `pointerover` 让 React 重算 enter（`pointerenter/leave` 不冒泡，React 由 `pointerover/out` 合成），卡片与跑马灯语义不丢。样式侧只给**行级** `:hover` 揭示加 `:not([data-hover-gate])` 条件（含 `more:` 披露行；归档管理器、JS 揭示半边 `:has(.rowActionsVisible)`、未分组桶的 transparent 复位都不在面内；重命名态的**抑制**规则不是揭示面，但其 hover 半边必须带同一条款——`:not()` 计一个额外伪类，不带上就会被 `(0,5,0)` 的揭示反超、改名中仍交换字形）；门控行仍可点击、kebab 与键盘揭示照旧。**实测边界**：退出克隆体不是本现象成因（后继组头的标题行框与克隆体重叠始于 t≈60ms，彼时克隆体透明度已 ≤0.215，t≥83ms 像素差 ≤maxΔ7），故动画器移植体与常量一律不动；残余 = 常驻可见控件的子元素级 hover（`.foldToggle:hover` 的墨色台阶、`.orphanBadge:hover`）与原生 `title` 提示不可门控；另一类 = **无 key 的行表面**（来源表头 `.sourceHeader:hover .sourceActions`、面板行 `.panelRow:hover`、git 未注册行 `.unregisteredRow:hover`、归档管理器组头 `.archiveManagerGroupHeader:hover`）在相邻 section 因折叠/增删行瞬时变高变矮（无动画）时被搬到静止指针下，机器只认带 `data-row-key` 的动画目标、看不见它们——两类一并登记为已知边界，实机复核与 STATUS 第 ⑤ 项同看。回归锁：`test/session-rows/hover-motion-gate.test.ts`（纯判定真值表 + 机器/接线/样式条款漂移锁）与 `test/visual-lock/git-occupant-rest-flow.test.ts`、`test/session-rows/session-row-actions.test.ts` 的揭示选择器对拍（容器与动作两侧必须同时带门控，漏一侧即红）。
- **Rejected alternatives（行位移动效）**：①*深引 vendor 源码*（`@deepseek-ai/dsh-client-ui-workspace/src/client/rows/AnimatedRows.tsx`）——registry C16 的 vendor 直穿只收「相对 import + `export function` 符号」，而原件是 `export class`，登记进 `vendorSourceConsumers` 会红；改用裸包说明符则绕开 C16 的双向登记（无登记的 vendor 直穿本仓不允许）。②*只加 CSS transition*——CSS 做不出退出克隆（被删除的行没有元素可过渡）与"仅重排才动"的 FLIP 测量，也表达不了 armed/ready/resetKey 门控。③*不做*——在 workspace 上点 `+` 新建会话时整列瞬移，正是本轮要修的观感。④*把每个工作区的渲染行数（`renderCount`）直接放进 resetKey*（首版实现，已被替换）——`total ≤ visibleFirst` 且未展开时 `renderCount === total`，于是任何行增删（新建行出现、归档、ghost 到期）都会改键、把入场动画取消掉，且数组形状让「新增 workspace」也退化为 settle；被「只有被钳制的组按 id 贡献分量」取代。⑤*由渲染层手写窗口语义*（在键里自己判断 >200 / 当前行位置）——同一规则就有了第二份实现，`sessionRowWindow` 一改就漂移；被抽出纯函数 `sessionRowWindowMotionKey` 取代。
- **Rejected alternatives（行位移指针门控）**：①*改退出克隆体的画序*（给 `.workspaceList` 加 `z-index`，或把覆盖层挂进列表）——实测克隆体不是成因（重叠时间线与透明度见上），改了只把叠影从"盖住"变成"透出"，还要调用方耦合 vendor 未导出的覆盖层结构。②*改 vendor 动画器退出段*——`AnimatedRows` 是逐字移植体（byte-fidelity 锁 + registry/design 登记成本），且同样不针对成因。③*容器级 `pointer-events: none` 锁*——会吞掉门控行上的真实点击（门控行必须仍是可点目标）。④*只把揭示延后到动画结束*——仍是"无指令揭示"，且会把位移前已悬停的行打断成"闪掉再回来"。

- **视图选项三轴的新增几何（2026 对齐轮）**：树模式嵌套缩进 = `--chamber-tree-depth × 12px`
  （`calc()`，任意层数一条规则，§3.4）；归档提示条 `.archiveNotice` = header 之下的内联行
  （12/18 字级、caption 墨色、可换行；`.archiveNoticeAction` 是无胶囊文本动作，hover 下划线）；
  归档行 `.sessionArchived` 只把行标题落到 caption 墨色，**不新增行高/命中盒档位**。

## 8. 会话待办区（sidebar todo area）

**问题**：会话多时行尾状态指示随列表滚出视野，用户需频繁滑动检查「哪个会话完成 / 在等
批准 / 在等回答」；缺一个**常驻、免滚动**的侧边栏内呈现面（桌面通知与 Dock 徽标已有）。

### 8.1 机制（镜子，非盒子）

待办区是对 chamberBridge 投影的**纯派生视图**（`packages/dsh-chamber-client-core/src/todo-attention.ts`），不持有
任何条目记忆：输入 = 每来源每会话的**合并运行时事实**（官方 `completionUnread` 位
∪ App 修正臂 ∪ `uiSession.sessionStatus` 中的 `pendingInteraction`——与行尾指示同一事实源）；输出 =
「此刻需要你注意」的条目（来源 + 会话 + kind：`approval / plan-review / question /
completed`）；出现/消失 = 投影刷新后的重算：断连来源无 runtime → 不臆造条目（重连后按
真实状态重现或不再出现）；会话重新 running / 已读解除 / `pendingInteraction` 清除 → 自动
消失。**移除从来不是动作，而是重算。**

pending 的客户端权威输入是官方 ui-session 服务公开的 `sessionStatus` observable；每个
session status 的 `pendingInteraction` 进入运行时事实投影。不要读取 ui-session 内部的
pending registry：它不属于服务接口，缺席时会让同步函数抛错，而 sidebar 插件 fiber 的
错误回滚会同时撤销该来源的所有 sidebar slot。

**Rejected alternatives**：直接访问 `uiSession.pendingInteractions` 可以复用内部 Map，代码
看起来更短，但该字段不是公开服务契约，实际服务未暴露它，导致首次同步抛错并整棵侧栏卸载；
改读公开 `sessionStatus` 并提取 `pendingInteraction` 保留官方投影语义，也让状态变化经服务的
observable 显式传播。

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

- **completed 条目**：目标会话真正打开（成为活动来源 current = mainView 持有行）
  → vendor 在 `isMain` 解除时清掉自己的官方位 → 条目随投影消失。打开失败（断连/来源移除）
  → 条目保留、可重试，绝不丢提醒。
- **pending 条目**：打开**不**移除——只有交互被真正处理（批了/答了/agent 继续，
  `uiSession.sessionStatus` 中的 `pendingInteraction` 清除）才消失；切走看别的会话条目仍在，直到处理完毕。

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
——与 notifications 同纪律同缺口）。侧边栏经 `packages/dsh-chamber-client-core/src/todo-prefs.ts` 只读订阅
（get + onChanged；值域校验 + 未知键过滤 + 未水合回落默认——漂移最坏退化为默认，绝不假 off/假 on 之外的状态）。

### 8.4 代码落点

- 派生：`packages/dsh-chamber-client-core/src/todo-attention.ts`
  （纯函数 + `test/session-rows/todo-attention.test.ts`）；
- 设置订阅：`packages/dsh-chamber-client-core/src/todo-prefs.ts`（只读水合 + `test/session-state/todo-prefs.test.ts`）；
- UI：同包 `client/SessionTodoArea.tsx` + `sidebar-chamber.module.css` `.todo*` 类；
  `SidebarRoot` 在 `regionArea` 内、滚动容器**外**渲染（`wide` 门控；rail 无待办区；
  在 `ChamberListBoundary` **之内**——region 渲染错误纪律覆盖待办区）。打开经
  SidebarRoot 守卫回调（拖拽尾随 click 抑制 + 同会话内联重命名保护），来源色点复用
  `packages/dsh-chamber-client-core/src/derive.ts sourceAccentColor`（列表/rail/待办共用）；
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
  （行外，`SessionTodoArea.tsx:79-81`），两级同为 `label-secondary`。hover 另画
  行底色；行与「还有 N 项」按钮均带 brand focus-visible 自绘环（§7）。
- **a11y 取舍（记录）**：装饰性槽位 aria-hidden；可访问名 = 状态 · 标题 · 来源
  （region 名带条目数）；tooltip = 完整标题 + 状态 · 来源 · 工作区——截断标题由此
  可复现（vendor tooltip 无 aria-describedby，hover 卡片不进读屏，不重复播报）。
  待办区**不做**列表行式条件 `role="status"` 实时宣告——固定区是投影镜像，每次投影
  变化播报噪音大于价值；未读状态在聚焦条目时仍可听到。

## 9. Rejected alternatives（完成未读：官方位 + 修正臂）

被否路线台账（评审判据：任何让 chamber 独立产生完成状态、引入第二时钟/第二水位、或
复制官方规则的方案都落在此列）。契约与边界表见 §4.1–§4.3。

1. **保留 durable 账本**（App 落盘状态机）：旧实机「点卡死、点击不消」的成因；与上游
   内存语义双重分叉（跨重载/跨端保留都变成必须维护的能力），且账本可独立产生
   completed = 影子权威。删。
2. **补 host 域完成游标**（前一轮候选）：引入第二时钟与第二水位，上游无此概念；
   「已完成」的判定会再次落到水位比较上。
3. **observer 戳有界推进**（同族补丁）：observer 域时刻不在 host 域，要让水位推进就必须
   再定义域/边界规则，仍是第二套判定。
4. **切源释放 mainView retain（让官方规则自洽）**：实证否决，不做 spike。①vendor
   `dsh-api-session-controller` 的引用计数归零即 `retireScope` → `manager.drop` →
   `Session.dispose()`——历史分页与实时流一起拆掉，重开是 cold（只重拉尾部一页）；
   ②公开可调用的是 `ui-workspace` 的 `clearMain()`，它同时清掉**持久选择**并关闭右侧
   面板，冷 boot 的 restoreSelection 会改走 host 新建 blank；③`sidebarView`/
   `sidebarChat` 是兄弟持有者，释放可能落空（`retainedBy` 仍 > 0）；④chamber 全仓无
   `.retain(` 调用，释放面无既有接线。
5. **逐 ctx 复制官方规则**（把 `isMain` 换成 App 的 reading、不 OR 官方位）：重复规则，
   上游改一处即漂移；官方位的武装/清除本就由 vendor 拥有。**边界 = 有壳来源**：无壳来源
   没有官方位可复制、也没有 `isMain` 主场，走的是逐行 host 运行边沿 + facts 候选（§4.2）。
6. **用 focus/隐藏收紧官方位**（失焦即未读）：与上游 `isMain` 语义分叉；
   `document.hasFocus` 只留在通知的 `requireHidden` 门。
7. **保留 facts 轨武装**（observer 域戳）：旧「点击消不掉」的根因链，整条删除。**边界 =
   有壳来源**：无壳来源没有官方位可用，本轮实现的上游 `beforeBaseline` 支只用 host running
   边沿 + status 首发位（列表基数已知未就绪），不引入 observer 戳/水位。
8. **把通知候选也改成官方位边沿**：会让「开着但失焦的会话完成」不再通知（官方位被
   `isMain` 抑制），与通知既有 gates 语义冲突；通知继续用运行边沿（本已独立）。
9. **物化写者**（把虚拟投影写进 `factsStore` 或新建「判定事实表」）：引入第二写者与第二套
   生命周期/撤回次序，渲染 stale 与判定 stale 混用、共享壳轨记忆、第二个壳边沿裁决点；
   对渲染零贡献（环不吃通道 running，`server.runtime.current` 补不出官方 current，pending
   已由 facts overlay 供给）⇒ 改为判定侧两读取点回退（§4.1）。
10. **wire 加字段**（`listPhase`/`origin`/`completionUnread` 位）：`listComplete` 用已冻结的
    `diagnostics.baselines`、子代理在源侧过滤即可闭合，加字段要动冻结协议、fixture 与旧端
    矩阵，收益不足（design 17 §10.7 同裁）。
11. **全量 `SourceSessionStatus` 店**（第二未读权威 + 全来源常驻）：有壳来源已由官方位 ∪
    修正臂承担，新建权威要维护交接/去重/持久化语义；复访条件 = 决定收敛有壳路径时。

## 10. Rejected alternatives（pin 面：会话行置顶）

1. **渲染官方两座席**（`sidebar.workspaces.session.menu.item` / `.row.action`）：与「`sidebar.workspaces` 洞只声明
   不渲染」的既有裁决（design 24 §1、STATUS）直接冲突，且本仓行簇是自己的组件；改为按上游文件形态**手工移植**
   两个入口 + 静息标记（checklist §4.6 登记；这两个官方座席本仓不注册，只声明 `sidebar.workspaces` 洞）。
2. **只做展示半**（标记 + 置顶序，无写入口）：无人能 pin，等于永远空的集合。
3. **走官方 `ctx.uiWorkspace.pinSession`**（本包已能取到该服务）：它同时写客户端 `pinSessionOrder`（本仓首落不接
   置顶序）并用 `notify` 弹失败提示（本仓行级动作失败归 `rowErrors` 槽），会把两条已定边界一起破掉；改为
   直接消费 unary Remote（`workspace/pinSession`/`unpinSession`），失败走既有行级漏斗。
4. **乐观回声**（本地先改标记集）：置顶集只有挂载 follow（基线 + 增量）一条线源，本地回声要与未知集合、并发 unpin、推送竞态
   三处对账，而对已挂载来源收益只是一次推送延迟（未挂载来源上标记要等挂载，见 §5）；改为 wire 成功后
   `requestRefresh` + 权威推送落定（与归档墓碑不同：
   pin 不移除行，没有非回声不可的可见性理由）。
5. **把 pin 序写进本地账号 + 块内拖拽（上游完整版，一次性全对齐）**：需要一个持久的手动账号（本仓
   manual 权威是宿主 wire）、跨分区拖拽守卫与 `unpin` 的领先槽语义；2026 对齐轮裁决先落**渲染分区**
   （选项 1：不写账号、不改拖拽、`unpin` 回自然位），残余登记 parity plan §1.1 与 STATUS 必要取舍（B2）。

## 11. Rejected alternatives（孤儿 workspace 的删除入口）

背景（2026-09 用户报告）：注册 workspace 的路径消失后，行显示 `orphaned` 的「已消失」徽标。若该
工作树的 Git 记录也已被外部 prune，快照里没有对应 worktree 行，**Git occupant 整块不渲染**
（`SidebarWorkspaceGitLine.tsx` 读到 `gitFactsForWorkspace` 为空即 `return null`）——行上没有任何 Git 侧删除
控件；worktree 行又按 §7 / design 08 §3.2 没有 kebab，于是「已消失」徽标曾是唯一出口。被否方案：

1. **启用 Git occupant 那个被禁用的垃圾桶**（把 `removeBlockReason` 的 missing 从 `unhealthy`
   拆成独立原因再放行）：只覆盖"记录还在"的状态；记录已被 prune 时该控件根本不存在，且会把
   同一图标从"Git 删除"扩到"仅注销注册"两个语义域。另注：「记录仍在、仅目录消失」态下静止时
   只有本钮，hover 揭示后同行的 occupant 会再出一个**灰色禁用**垃圾桶（`status!=='ready'` ⇒
   `removeBlockReason='unhealthy'`）——两种语义并存是既知成本，不是可用入口。
2. **给 worktree 行恢复 kebab**（全量或仅孤儿态）：全量会让健康态的「删除工作区」变成绕过
   running/dirty/locked 守卫的 registration-only 删除，或被迫转发进同一条 saga（第二扇门）；
   仅孤儿态则把删除藏进"只有坏状态才出现"的菜单，发现性没有变好，却换来随状态变化的行形态。
3. **只改徽标形态**（按钮外观 / 常驻提示）：零语义风险，但仍是"标签当按钮"，治标。
4. **把徽标降级为纯状态标记**（只留新清理钮）：不可取的理由不是"唯一出口"——新钮同样常驻、
   可 Tab，两条入口各自都够用——而是**冗余是刻意的**：徽标把"状态陈述"本身留作入口（也继续是
   §6 单层 Modal 论证引用的常驻 opener），新钮补上通用删除字形，同一动作、同一 opener、同一层
   闸门，故都保留。
5. **一键链**（注销后自动接着清 Git 记录）：registration-first 是宿主不变量（注册仍在时未注册清理
   被 `workspace-registered` 拒绝），链式动作要跨两步新增 recovery 类别；第二步交给未注册 missing
   行的垃圾桶或外部 prune 即可（design 08 §5.5）。

**已登记残余**（不进被否方案清单，见 design 08 §6.4）：只有 Git 来源的 unary 调用**直接抛错**这一
支（客户端拿不到任何新快照）时，本轮新出现的 `path-unavailable` 无从合并出 `orphaned`；若该行
旗标历史是 worktree，则徽标与本钮都缺席、kebab 也在 `isWorktree` 门上关闭，直到下一轮成功快照或
按 design 08 §6.3 重启来源。空快照的 deadline/`git-unavailable` 支已由 `effectiveSnapshot`
（`git-facts.ts`：保留上一轮 repos、合并本轮 `errors`）收口。来源健康时不可达，余下这一支按已接受
残余登记。

## 12. Rejected alternatives（视图选项三轴）

1. **页面级全局提示条 / 全局置顶区**：与「全局跨来源面只有待办提醒」的裁决冲突；归档提示条改为落
   触发来源的 section 内（per-shell 瞬态，与 `rowErrors` 同纪律）。
2. **在 sidebar 侧后处理插入归档行**（不改进 derive）：归档行的原槽位与行形态在 renderer 投影里已被
   过滤，后处理拿不到「记账槽位」；改为把 `archivedFilter` 作为**投影输入**（renderer `deriveServers`
   参数 + 按来源缓存键 + 发布签名 `archived` 位）。
3. **树模式纯前缀（完全上游）**：会把 git 家族拆开（worktree 建在 `$DSH_HOME/worktrees`，与主 checkout
   不同父）；改**家族优先**（design 08 §3.3）。
4. **全局 flat（跨来源一条列表）**：需要跨来源排序权威与跨来源拖拽（后者本就是 v1 不做项），与
   per-source 实例化原则冲突；改**每来源平铺**。
5. **降级时清掉筛选存储值**：把瞬时可用性问题固化成偏好改写；改禁用三项 + 按默认渲染 + 保留存储值
   （并因此整体禁用——点击默认项也会把存储值写回 `default`）。
6. **归档/置顶动作失败也弹来源提示条**：失败面仍归行级 `rowErrors` 槽（既有族约定），提示条只承载
   归档完成/停止并归档/不可打开三种瞬态通知。

