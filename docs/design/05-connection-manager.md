# 05 · 连接管理器形态（v1：多来源会话统一导航）

> **状态：现行（连接管理器 v1 形态与四方契约，2026-12）**——本软件 =
> dsh 的**桌面连接管理器**：Electron 包装 dsh 官方前端，本地与远程实例
> 同等接入，**多来源 session/workspace 在 dsh 原生侧边栏内平等呈现**（仅按
> 来源分类，远程来源以颜色标注——codex 式"导航统一、执行按来源路由"）；
> 首屏 = 本地实例的完整 dsh shell（纯 dsh UI，无 chamber 外壳）；控制面 =
> 托管 + 反代 + 静态服务（v1 无认证/审计，loopback-only）；未完成门禁见
> docs/progress/STATUS.md。
> **连接模型 / 凭据 / 安全面以 `17-server-side-gateway.md`（连接模型 v2）为
> 权威**：kind dsh|gateway × transport ssh|http × 认证 ×
> 通道四维正交（17 §2）、注册表 schema v2（17 §9.1）、桌面凭据
> safeStorage（17 §12）与安全不变量 S21–S24（17 §17）。
> 本文档是 control-plane / desktop / renderer / 侧边栏插件四方契约。

## 1. 形态

```
Electron 窗口（BrowserWindow，单 frame，loadURL http://127.0.0.1:17500）
└─ dsh 前端（源码构建 · __DSH_BOOT__ 由我们注入；首屏 = 本地实例 dsh shell）
   ├─ apps/web 式入口 → AppWebEntry → 两阶段 boot（modules prefetch → cordis Loader → entries ACTIVE）
   ├─ ★ chamber 侧边栏插件（自研，替换官方 ui-sidebar 注册，默认打包）：
   │    所有来源（local + 各远程实例）的 session 平等呈现，仅按来源分组；
   │    远程来源以颜色徽标区分；行点击 → 切到该来源 shell 并打开会话；
   │    连接状态随来源分组展示（非秘密投影）
   ├─ ★ chamber bridge（renderer 共享单例）：各来源聚合投影 + 连接状态 + open 通道
   ├─ dsh 原生 ui-* 插件（conversation/goal/jobs/terminal/settings…）零修改
   └─ N-ctx 多实例：每个来源一个 AppWebEntry（独立 cordis ctx、全量 ui-* 树），
        隐藏/显示切换；★ 连接客户端补丁（base 路径参数）：rpc 的 origin 解析 +
        WS 路径前缀，使每个 ctx 经 /api/i/<id>/* 访问自己的实例；会话状态零改动
        控制面（127.0.0.1:17500）
        ├─ 前端静态服务：dist/ + 启动图清单 __DSH_BOOT__
        ├─ 通用反代（每实例路径前缀，HTTP+WS+SSE 全量透传，无方法白名单）
        │    /api/i/local/*  → 本地 dsh（--profile web --port X）
        │    /api/i/dsh-<id>/* → 隧道 localPort（ssh-<id> legacy 段）
        │    /api/i/gateway-<id>/* → 隧道/直连端点（认证头主进程注入，17 §9.3）
        │    v1 无认证门禁：匿名可达（仅 loopback 监听）
        ├─ 本地实例托管：spawn/健康状态机/reaper/host-logs
        └─ 管理 REST：/health、/api/connections(local)、/api/host/logs
        桌面主进程（main.ts）
        ├─ transport-manager：通用传输运行时（phase 机 / 两段式重连 —
        │    快速有界 jitter 退避突发 + 慢速周期重探 /
        │    环形日志 / 非秘密投影 / 子进程监督 SIGTERM→SIGKILL）
        ├─ TransportProvider 接口（transport-provider.ts）：来源无关契约 —
        │    spec 校验 / 传输进程 argv（或 direct-endpoint 直连模式）/
        │    stderr 分类与脱敏 / 可选 exec 通道；实现 `ssh` 与 `http`
        │    两个 transport provider（ssh-provider.ts：ssh -N -o ServerAlive…
        │    -L 隧道 + systemd exec；gateway-provider.ts：http 直连
        │    direct endpoint，17 §2.2/§9.2）
        ├─ 实例注册表：<userData>/ssh-instances.json {id,kind,transport,label,host,user,sshPort,remotePort,serviceName,remoteDshHome,insecureHttp,spkiPin}（schema v2 以 03 §2.2 = 17 §9.1 为准；凭据不进注册表）
        └─ IPC（preload 白名单）
        远程目标：dsh（API 面 profile）或 gateway；按需使用 SSH+systemd 或 HTTP(S) 直连
```

## 2. 侧边栏契约（核心：多来源会话统一导航）

### 2.1 形态与呈现

- 侧边栏 = **chamber 自研插件**，注册进 layout 的 `sidebar` 槽，**替换官方
  ui-sidebar 的注册**（官方包在 vendor 保持原样，不进启动图）。
- 呈现原则（参考 codex）：**所有来源的 session 平等**，不做独立"其他服务器"
  专区；列表**仅按来源分类**（来源分组），远程来源以**颜色徽标**标注（按
  来源 id 派生稳定 accent 色），本地来源默认色。
- 分组结构：来源分组（标签 + 连接状态色点/转圈——ready 绿点、error/stopped 红点、
  idle/unknown 灰点、connecting/starting/restarting/degraded 统一转圈；重试周期折叠为
  稳定「重连中」态，主界面不因每次重试在转圈/色点间闪烁；状态一律纯图标，相位文本仅在
  hover/aria 呈现，无恒显
  文字、无状态文案）→ 该来源的
  workspace（组头）→ session 行（**嵌套缩进**于 workspace 之下）。未连接来源只显示
  分组头 + 状态点（无会话数据）。
- 会话行带**运行指示点**（相对时间列不显示——见 06 §4.3）。
- **会话行标签 = 官方链**：`durable title → cwd 目录名 → 会话 id`，在侧边栏单点解析
  （`packages/dsh-chamber-client-ui-sidebar/src/shared/derive.ts` 的 `sessionDisplayTitle`， 两个快照构造都经它接线，并作为必需字段 `SessionRow.displayTitle` 携带）；该字段进
  **两个发布签名**（`instanceSnapshotSignature`、`serversProjectionSignature`），标签单独
  变化也重发布。「未命名会话」只保留三处声明的例外：归档管理器的 durable 名列（design 24
  语义)、待办条 `SessionTodoArea` 与通知体（`renderer/App.tsx`）在该行完全不在投影里时的
  字典化兜底（后者受 frame-locale 审计 T15 约束）。
- **`+` = 复用优先**：复用 workspace 中既有的空白成员（与上游 `connectWorkspace`
  同谓词：存在可复用空白行即不新建），并按 workspace 维护在飞 promise 以防双击重复新建。
- **当前来源的当前会话行高亮**（含所在 workspace 组着色）：当前会话 id 经
  运行时事实通道（`server.runtime?.current`，06 §4）——每个来源自己的 ctx
  上报自身 `sessions.list` 快照投影，任意来源均可达，组件不订阅任何 store。
- workspace 组可**折叠**（组头 chevron + 会话数徽标）：折叠态持久化于
  localStorage 视图偏好（`dsh-chamber.sidebar.v1`，06 §3——共享实时存储，
  跨 ctx 实时联动）。
- 不属任何 workspace 的游离会话落在来源末位合成的"未分组"桶（仅会话行，无 workspace 操作）；
  subagent 来源的子会话不进入导航列表；blank 会话按官方 `(!blank || current)` 规则——
  **活动来源的当前空白"新会话"行进入导航列表**（以 New Session 标签呈现；仅活动来源投影，
  与其他来源当前会话视觉的 06 §4.3 全局单选门控一致)，其余空白行不入列表。
- 已连接来源的聚合拉取失败时以错误行呈现（不冒充"无工作区"）；全部来源
  断开时显示空态提示。
- 保留官方侧边栏的：logo 行、New Session（作用于当前活动来源）、折叠（wide/rail）状态机、
  foot（footer.action + settings 孔位）。foot 的座位契约（2026-09-13 审计补记）：
  `sidebar.footer.action` 是 **list 座**（`contract/slots.ts`），多个注册项共用同一行 ⇒
  该行由 chamber 补 4px 间距（官方块无 gap，两个 occupant 会零间距相接；该 4px 是侧栏/本表
  的图标簇节奏——「4px = G1-4 两个 24px 命中盒的下限」一说已随 2026-09-14 的命中盒整体
  回退作废)；纵向（footer.action 行 ↔ settings 座）仍按官方契约由 occupant 自己的 margin
  承担（settings 触发器 `margin: 4px -2px` / rail `8px 0 10px` 即既有先例）。
- 当前活动来源以视觉强调（如行高亮/侧边标记），与其余来源同列表呈现。
- 来源分组头可**点击**（非当前来源）→ 切到该来源 shell（不打开会话；见 §2.2）。

### 2.2 交互

- **点击会话行**（任意来源）→ `chamberBridge.requestOpenSession(sourceId,
  sessionId)` → 桥接层切到该来源的 shell（若未 boot 先入队）并打开会话。
  打开尝试 settle 后（成功，或 dispatch 预算耗尽失败——§4 两种终态报告之
  一），App 层经 `chamberBridge.reportOpenSessionOutcome` 回报每个侧边栏
  shell：失败文案在目标会话行内呈现（复用 session action-error 槽，低优先
  级；10s 自动消退；再次点击/后续成功即提前清除）。该回报是**必需**通道：
  requestOpenSession 单向时失败仅 console.error，用户切换视图后看到的是
  未选中会话的目标服务器且无任何可见错误。
- **点击来源分组头**（非当前来源）= 切换活动来源视图：
  `chamberBridge.requestActivateSource(sourceId)` → App 层仅切换该来源
  shell（N-ctx），不打开会话。
- **归档会话立即从列表消失，且无确认**（2026-09-11 upstream-alignment T2a）：归档动词在
  会话行的 kebab 菜单里，执行即提交（上游理由：归档只隐藏该行、从不触碰会话日志，故既不
  破坏性也无需确认，vendor ui-workspace `Rows.tsx:412-421`)；`archivedSessionIds` 过滤在
  derive 层（`shared/derive.ts` 纯函数），不等聚合轮询。
- 会话行悬停操作（v1 最小集，走该来源自己的 API）：重命名/**fork**/归档（**kebab 菜单
  三项**；行内不再有独立归档按钮——2026-09-11 upstream-alignment T2a)——行内 fork 走 wire
  `sessions.fork` + 标题递增（increaseTitle，对齐官方 ui-workspace），成功后打开子会话，递增
  rename 失败非致命（子会话仍创建并打开）；官方 conversation 回合尾部的 `turn-tail forkAt`
  常驻可用，两者并存。workspace 行：新建会话（`+` 按钮，在该 workspace 下创建并打开）、
  重命名、删除（kebab 菜单）。**workspace 删除用应用内官方 `Modal` 确认**（2026-09-11
  upstream-alignment T2b)：outline 取消 + outline 危险确认 + 一句说明 + `role="status"`
  进行行，确认后才发 wire 调用；孤儿 workspace（路径已消失、只删注册）走同一确认、只换
  说明句——**全包不再有 `window.confirm`**（OS 样式弹窗无法使用 alias token）。wire 缺失的
  方法不做（如删除会话），不发明协议——**design 24 受界例外**（2026-12 用户批准，AGENTS 已
  登记)：来源头 hover 簇新增「删除已归档内容」动作，走 chamber 自有宿主域
  `archiveCleanup/{preview,purge}`(design 24 引入的宿主包，实例进程内权威清除归档集内容含
  subagent 级联；只删不读、运行中整棵跳过、幂等；域缺失 404 给诚实文案；host binding 已按
  design 24 §10 的 vendor 核对结论落地，见
  `packages/dsh-chamber-seed-archive-cleanup/src/binding.ts`)。详见 design 24 与 §6 宿主包清单。
- 已连接来源提供"添加工作区"（来源头部按钮，官方 project-add 字形 `IconProjectAddOutline16`，
  2026-09-11 upstream-alignment T7)：打开该来源的应用内目录浏览对话框（§4 同一 browse 表面，
  不做手敲路径表单)，确认的路径走该来源的 workspace.create（须为该实例宿主上已存在的目录；
  远程路径 = 远端服务器路径)。
- 悬停操作与新建工作区成功后，经 chamberBridge.requestRefresh(sourceId)
  立即重拉该来源聚合（v1 轮询 + 操作后刷新）。
- **交互面扩展（详见 06）**：来源头 hover 操作簇提供**会话排序
  切换**（显式排序菜单——官方 ViewOptionsMenu 模式，勾选标记当前模式，
  取代盲切循环，06 §2.2）；workspace 头/会话行**双击重命名**
  （会话行单击立即打开、二次点击进入重命名，06 §2.2）；workspace 头/会话行
  悬停显示**信息卡片**（标题/会话数/相对时间/状态点/复制标题，06 §7）。
- New Session → 当前活动来源新建会话。

#### 2.2.1 打开意图、工作区回声与会话回声（2026-12 修订；三项真机反馈）

> 背景：N-ctx 下"用户意图"比官方默认收敛**到得晚**：①切到远程 server 的会话时先闪出一个"新会话"；②在某来源上新建工作区后不立刻出现，必须手动点一下那个服务器。

**打开意图（open intent）= 唯一事实源**：`App.openSession` 是所有**带 sessionId** 打开路径的唯一漏斗——侧栏点击、待办条、git 插件都经 `chamberBridge.requestOpenSession` 进 App 的 `onOpenSession` 订阅，通知点击走通知 runner（App.tsx 里恰好这两处调用点）。**深链不在其中**：深链载荷没有 sessionId（16 §2），`settlePendingDeepLinkActivation` 只 `selectView` 激活该来源视图、不打开会话，故它既不 arm 意图也不受本节闸门约束。意图在切视图**之前** arm、在本次 open settle（成功或终态失败）后**按 sessionId 守卫地**释放（守卫保证"点 X 后马上点 Y"时 X 的迟到 `finally` 不撤掉 Y 的闸门）。意图槽位是**跨 ctx 单例**（`packages/dsh-chamber-client-ui-sidebar/src/shared/open-intent.ts`，与 `pending-click.ts` 同款：目标实例自己的 ctx 内也要读它），App 经 `useSyncExternalStore` 绑定；它同时驱动三道闸门：

1. **投影门**：意图在途**且该来源的 current 不是请求的那个会话**时，该来源不投影 `runtimeFacts.current`(`projectableCurrent`)——否则冷 boot 期官方初始导航选中的 blank 会话会被投影成高亮"新会话"（本文件 §2.1 的 `(!blank || current)` 规则）再消失，即①的可见形态。**幂等重开不受影响**：`current` 已是要打开的会话时投影本就正确，摘掉再装回是纯闪烁（`pending !== current` 才抑制）。
2. **揭示门**：壳体**显示的会话不是请求的那个**时，目标视图的 boot 遮罩在干净 settle 后继续保留（`shouldHoldViewVeil`，App 判定后把布尔值交给 `InstanceView`，与 P3 的会话面信号一起合成：`(!settled || (holdVeil === true && !surfaceRelease)) && !failureOverlayVisible`，见下面的 P3 段）；两个输入只有 App 有——壳状态镜像（settled/failed）与**原始** runtime current（投影门要隐藏的正是它，不能从投影结果反推）。三条边界：壳失败 ⇒ 永不持有（失败呈现归 App 覆盖层，也避免排在永不 settle 的 boot 后面的 open 把遮罩按 68s 队列预算钉住）；已显示请求会话 ⇒ 不遮（幂等重开；或 boot 期早开臂已抢先——此时 settle 即揭幕，比等 App 分发更快）；遮罩生命周期由 open 请求自身界定（dispatch 8s 预算 + App 的 `finally` 释放），无挂死加载层。持有判据（`shouldHoldViewVeil`）：①有在途 open ∧ 未失败 ∧ **屏上显示的会话 ≠ 请求的会话**；②**屏上没有正当内容**（该视图 current 未定或为 blank——未知按 blank 处理，冷 boot 因此照旧被遮）；已渲染正确内容的温壳不被盖，温壳正显示用户在读的真实会话时切换请求不再用不透明加载层盖它 8s（2026-09-11 review：原判据缺第②条，会把温暖壳连现有会话一起遮）。
3. **boot 期早开臂**：目标 ctx 内的侧栏插件读**活**意图，在 sessions 列表可寻址的瞬间调用本 ctx 的 `sessions.open`（`packages/dsh-chamber-client-ui-sidebar/src/client/early-open.ts`：预算 8s、50ms 节奏、按 id 探针（不物化 id 集合）、一次成功即退位、绝不自行上报终态——终态报告归 App 分发）。它抢官方 `UiWorkspaceService.watchNavigation()` 的初始导航策略：该策略需 workspace + session **两条**基线 ready 才"复用或新建（宿主侧 `session.create`！）blank 会话并打开"，本臂只需 session 列表。**诚实边界**：故它只在 workspace follow 基线晚于 session 列表时取胜（隧道下常见但**不保证**）；策略已先落地时 blank 会话已在宿主上存在，挡住可见性的是上面两道闸门而非本臂。
4. **被取代的请求不得再开**（`packages/renderer/src/shell.ts` 的 `lastRequestedSession`）：同一来源的 open 是**最后意图胜出**流，而官方 `sessions.open` 只是一次普通 select——用户已离开的旧请求会把壳**翻回**旧会话（冷 boot 期 X 后 Y 两次点击都在队列里，settle 的 FIFO flush 先开 X，早开臂已把 Y 打开，于是可见 Y→X→Y 抖动）。分发器因此丢弃被更新的请求：静默 resolve（被放弃不是失败，行内错误面归最新那次），记录随来源退役清除；首请求永远照常分发（记录为空时不判定）。

**揭示门的会话面信号（2026-12 P3 修订；"白屏 / 直接显示载入中"交替的真机反馈）**：上面第 2 条的持有判据完全建立在 App 侧两个**异步镜像事实**上——`runtimeFacts[viewId].current`（推送）与聚合里的 session `blank` 行（未知按 blank 处理）——两者迟到或抖动时，遮罩会挂在**已经渲染好的壳**上直到 open 预算烧完（单次 8s、排队 68s 后才失败），同一动作时快时慢。修订把它收敛到**壳自己暴露的 DOM 事实**：官方会话根 `div[data-phase]`（已登记的上游锚点，见 `docs/checklists/upstream-touchpoints.md` §4 与 `scripts/upstream/mobile-anchors.mjs` 的最小断言集）。语义按相位分档：

- `active`（上游值是 `settling ? 'settling' : hero ? 'hero' : 'active'` 的**兜底档**——非 hero 非 settling 即落到这里，所以 `shellPhase === 'blank'` 且 `openState ∈ {cold, error, undefined}` 而 `summaryBlank !== true`、以及会话快照缺失的组合也算 active，与"真实会话面已在屏"不是同义语，移动插件同样写作 "active (everything else)"）⇒ **立即揭幕**，即便历史仍在加载——那是壳自己的「载入历史…」面，比不透明加载层诚实；这个方向是 fail-open，取舍与残余见下；
- `hero`（无会话 / 空白新会话）与 `settling`（已选中但内容相位仍 blank 且载入中，或等待父目录可用 `parentAvailabilityPending`；典型形态是官方初始导航自建的 blank 会话）⇒ **保持遮罩**，第 2 条"不闪空白新会话"的目的不变；只留 70s 外层保险（`SURFACE_MAX_HOLD_MS`，> 68s 排队预算；正常路径由 App 的 open 生命周期先释放意图）；
- `absent`（会话根尚未出现，或 ui-chat 未注册的降级形态）⇒ 保持，但以**连续缺失起点**（相位从非 absent 变成 absent 的那一帧；根从未出现时即持有起点）起算的兜底窗（`SURFACE_ABSENT_FALLBACK_MS` = 2s）到期即揭幕，把解释交给壳自身的装载面与 `.boot-gap` 降级横幅——绝不出现无出口的加载层；未知 `data-phase` 取值 fail-closed 到 `hero`。

合取式（`packages/renderer/src/components/InstanceView.tsx`）：`veilVisible = (!settled || (holdVeil === true && !surfaceRelease)) && !failureOverlayVisible`——App 仍拥有"要不要持有"（失败、身份校验、open 生命周期），P3 只决定"壳已经画出真实会话面了就别再持有"。相位观察器在**整个持有窗**内运行（`MutationObserver` + 一帧 rAF 节流，窗口结束即断开），纯判定在 leaf 模块 `packages/renderer/src/session-surface.ts`（node 直测；契约锁 `test/lifecycle/session-surface.test.ts` 与 `test/wiring/veil-layering-invariants.test.ts`）。

**窗口基准与单调性（2026-12 review 修订）**：兜底窗以**本次持有开始时刻**（`settled` 且揭示门首次为真的那一帧）起算，**不是** shell 的 settle 时刻——温壳上 settle 早已是几分钟前，用它会让窗口在第一帧就过期、`holdVeil` 在温壳上整体退化为无操作（review 复现的 MAJOR：真机问题①"先闪一个新会话"在暖壳路径回归）。释放是**电平**而不是闩锁：相位若在窗口内回到 `hero`/`settling`（官方初始导航先显示持久化的真实会话、随后复用/新建 blank 会话），遮罩仍会回来——否则一次瞬时 `active` 会让空白"新会话"在整个剩余 open 窗内裸露。另记一条边界：`active` 只保证"不是 hero/settling"，**不保证"有正当内容"、更不保证"是请求的那个会话"**（相位推导与请求身份无关）；后者仍由 App 的 `showsRequestedSession` 与投影门负责，窗口内短暂看到"另一个有内容的会话"是本修订接受的取舍。

**第二版加固（2026-12 二轮 review）**：①**时基改单调钟**（`performance.now()`，`InstanceView.monotonicNow`）——墙钟被 NTP/休眠唤醒拉回时，一次性定时器算出的负 elapsed 会让判定拒绝释放且不再重臂，那次持有的"70s 外层保险"静默消失；②**定时器钳到 `[0, bound]` 并把到期 tick 纳入 effect 依赖**——被浏览器提前触发/判定当下不放行时要重臂，单调钟下不会空转（真到期后判定必然放行）；③**absent 的 2s 按"连续缺失"计**（`absentSinceMs`）——会话根中途短暂消失一帧不得让遮罩立刻揭幕、下一帧又回遮（"遮罩→露壳→遮罩"闪动）；④组件侧 6 个接线点（观察器作用域/deps/rAF 重采样/上升沿复位/定时器档位/单调钟）补了源码锁 + 突变验证（`test/wiring/veil-layering-invariants.test.ts`）。

**请求身份已绑进持有窗（二轮 review 后落实）**：`InstanceView` 收 `openIntentId`（App 传 `openIntents[viewId]`，即本次要打开的 session id），并把它并入持有窗复位与相位观察器的依赖——同一视图里"点 A 未结束又点 B"会**替换**意图而不产生持有上升沿，绑定后新请求从这一帧重新起算窗口、并立刻重采一次相位（原先会继承 A 的起点，极端时新请求的窗口立即过期）。同 id 重开身份不变，不重置（那是同一个请求）。剩下的唯一重开路径是 `failureOverlayVisible` 翻转——它是模态覆盖层事实，"看完失败报告再回到等待"重开窗口是正确语义，且被 App 的 68s 排队期限兜住。

**被否方案（P3）**：①只改进投影门的已知性（例如把 blank 未知当已知、或轮询对齐）——仍是异步镜像，抖动只是变慢；②只信 DOM 相位而不设兜底窗——ui-chat 未注册等降级形态会让遮罩永驻；③把 `settling` 也当真实会话面释放——正是"闪空白新会话"（第 2 条要修的缺陷）的回归；④向上游要一个"会话面已就绪"的新 seam——越过本仓边界，且 `data-phase` 已是登记锚点；⑤把释放做成**单向闩锁**（第一次 `active` 后不再回遮罩）——官方相位存在 `active → hero/settling` 回落，闩锁会把空白新会话裸露在剩余 open 窗内（review 的第二个 MAJOR）；改为电平 + 持有窗上界；⑥取"容器里第一个 `[data-phase]`"——官方 composer 的 contenteditable 也发该属性（值域 inert/plain/…），移动插件有过同款 first-match 事故；改为从恒在的 `[data-conversation-scroll]` 反查最近祖先。

**工作区回声（workspace echo）**：**应用内任何**工作区变更都走 chamber 侧的**唯一出口** `packages/dsh-chamber-client-ui-sidebar/src/shared/workspace-mutations.ts`——`createWorkspaceForSource` / `deleteWorkspaceForSource` / `renameWorkspaceForSource` 各做一次 wire 调用并上报对应事实（unary `workspace.create` 返回宿主 workspaceId ⇒ `chamberBridge.reportWorkspaceCreated`；delete / rename 成功后分别 `reportWorkspaceRemoved` / `reportWorkspaceRenamed`）。侧栏自己的对话框（添加工作区 / 删除确认 / 改名）与 **Git worktree 插件的 create / adopt / 两类 recovery** 都经它，不存在"某个入口忘了发事实"的形态（2026-12 **第二入口**真机反馈：用 Git 建的 worktree 行要等用户点开那个服务器才出现）。App 记入渲染端账本（不持久化 / 不轮询 / 不写宿主），并在**投影的唯一汇合点**（`deriveServerWorkspaces` 之前套一层 `withWorkspaceEcho`）并入该行；撤销 / 改名事实由 App 施加到同一账本（`removePendingWorkspace` 删条目 / `renamePendingWorkspace` 改标题），不新增读通道、不写宿主。为什么必须回声：未挂载来源只有 unary 兜底（工作区分组由会话 cwd 反推——**刚建的空工作区没有任何会话，结构上不可见**），已推送来源的工作区集又被 `commitAggregatePull` 的 mounted merge 冻结、`planAggregateRefreshes` 不再 unary 轮询它——新建后那次 `requestRefresh` 两条分支都刷不出这一行。回声**不是第二事实源**：

- 权威行**按 id 胜出**，该 id 出现在挂载 push 里即从账本退休（`reconcilePendingWorkspaces`，在 ready 门**之前**执行：身份来自该来源自己的 follow 基线，与聚合是否已提交无关）；
- **同 path 的合成组被原位替换**（真实 id 胜出；否则该目录一旦有会话就会渲染两行）；同 path 的真实行（别的 id）胜出且账本条目退休；
- 条目随来源生命周期 / TTL（10min）收敛（TTL 挂三处时钟：本次 create、权威 push、未挂载来源唯一的 30s unary 兜底拉取）；回声行**不带 `synthetic`**（id 是真的，工作区级动作照常可用）；
- **位置锚点（`afterWorkspaceId`，2026-12 第二入口修订）**：Git 插件在宿主上把新 worktree 插到其主 checkout 之后（`workspace.insertBefore`），该次 create 的事实因此带锚点，`withWorkspaceEcho` 把回声行插到该投影行之后；缺省（侧栏自己的创建）追加尾部。渲染序是 design 08 §3.3 连续家族不变式的载体（拖拽裁决器直接读它），不留"先渲染在末尾、挂载收敛后再跳上去"的窗口。边界：锚点行不在投影里（权威集尚无该行）时退化为追加尾部，**绝不丢行**；**同 path 合成组被原位替换时锚点不适用**——替换规则优先（目录不跳动，见上条），家族位置由挂载 push 收敛；
- **标题提示（`title?`，2026-12 复审修订）**：adopt 这类"宿主标题将由后续 rename 改写"的创建随事实带上**最终标题**（Git adopt 用分支名），回声行生来就是最终标签，不会先显示路径 basename、几个 RPC 后再翻转；缺省仍是路径 basename 规则，权威 follow 基线两者都压过；
- **装饰先于事实（`beforePublish`，2026-12 复审修订）**：任何"回声行首帧就必须成立"的事实（Git 的工作树 flag、adopt 的未注册块收敛）由唯一出口在**事实发布之前**的同一同步续体里写好，而不是等 create 返回后再补——否则两个更新分属 App 状态与外部 store，能否落在同一次提交取决于调度器，行会先以普通 workspace 形态出现再翻转。装饰抛错只记录不中止：宿主上的创建已提交，渲染期装饰绝不能把成功变成 saga 的失败/补偿分支；
- **替换的真实代价（已登记）**：换的是行的**身份**，按 `sourceId/workspaceId` 键控的 per-workspace 视图偏好（折叠态 `folded`、updated 模式的 `updatedOrder`/`sessionUpdatedAtByAccount`）不跟随新 id——旧合成键留在存储里不再命中（渲染侧跳过未知 id，属既有已接受残渣），该组可能一次性由折叠变展开；未分组序 `ungroupedOrder` 只按 sourceId 键控，不受影响。纯外观、一次性，换来"不会渲染同一目录两行"；
- **与 git 行的联动（顺带生效，非新机制）**：Git 插件本就按"投影里的工作区 id 集合变化"即时刷新（`workspaceKeyOf`——"新增/删除工作区必须立刻刷新，否则 git 行要等 30s 轮询"），取数是 unary（`/api/i/<id>/api/gitWorktree/*`，未挂载来源同样可用）；回声让投影 id 集合变化，新建工作区的 **git 行也随之立即出现**，不必等用户点开该来源。

**会话回声（session echo）**：**应用内任何**会话创建同样走唯一出口 `packages/dsh-chamber-client-ui-sidebar/src/shared/session-mutations.ts`——`createSessionForSource` / `forkSessionForSource` 各做一次 wire 调用并上报 `chamberBridge.reportSessionCreated`（宿主返回的 sessionId、目标 workspaceId 与官方 `blank` 事实；fork 另带 `parentSessionId` 与递增标题提示），`archiveSessionForSource` 上报 `reportSessionRemoved`（单一回声的**撤下半**：创建后立刻归档的行不会留到 TTL）。侧栏 workspace 行的「+」、会话行菜单的 fork 与 archive、Git 插件的会话创建（create / adopt / 两类 recovery）都经它（第二入口教训见下）。App 记入渲染端账本，并在同一汇合点按固定顺序并入：`withPendingArchives`（归档墓碑，最外层，先藏掉本页刚归档的 id）→ `withWorkspaceEcho`（补齐可能刚建的工作区行）→ `withSessionEcho`（把新会话挂进那一行），三步都在 `deriveServerWorkspaces` 之前。为什么必须回声：unary 侧新建的会话进投影的两条生产者路径都到不了——①挂载壳的官方 summaries 只在连接世代拉取，此后唯一外源是宿主 `api-session/added` 的**异步广播**，竞态窗内紧接着的挂载 push 会拿还不含它的 store **整份替换**聚合；②来源未挂载时（基线收割后的稳态：工作区行仍是上次推送的**真实**行，「+」照常可点）收不到广播，30s unary 兜底的 mounted merge 又保留被冻结的推送工作区成员位，新会话只能以**未归属散落行**出现，且它仍是官方临时 blank 行时（`!blank || current` 规则）不进导航。真机形态即
"新建的会话不出现，切到那个服务器（挂载 → follow 基线）才刷新出来"。回声**不是第二事实源**：

- **行 + 成员位一起并入**：成员位先按宿主 workspaceId 命中，其次按 canonical path 命中合成 cwd 组（未挂载来源没有宿主 id）；都不命中时行仍渲染，落在未分组桶。**成员位插在该工作区的头部**（宿主 `attachSession` 就是 `[sessionId, ...rest]`，manual 默认渲染序正是该数组）：追尾会让行先渲染在末尾、权威基线到达时再跳回头部——正是工作区回声用位置锚点消除的位置跳动。
- 权威**归属**胜出：该 id 出现在任一工作区的 `sessionIds` 里即从账本退休（`reconcilePendingSessions`）——挂载 push 在 ready 门之前执行；**未推送**来源的 30s 兜底拉取同样收敛（它的合成组就是该视图的工作区）。已推送来源**刻意不做**兜底收敛：那一支的投影工作区仍是被冻结的权威行，用合成行收敛会把行抛进未分组桶。
- **投影合并本身防御**：聚合已列出的 id 不重复插行，已被归属的 id 不插成员位——陈旧账本条目永远不会复制或搬移一行；blank 语义**照旧不覆盖**（回声只让行可达，「+」随后那次 open 会把该来源切为 current 而让暂存行可见）；fork 子会话继承内容，按普通行渲染。
- **收敛臂**：事实到达时 App 立刻请求该来源挂载壳的**官方 session-list 刷新**（`chamberBridge.requestSessionListRefresh`——只有挂载壳有这条 seam，它强制 summaries 重读宿主语料，同时覆盖"广播丢了"与"仍在竞态窗内"两种形态）；条目随来源生命周期与 TTL（10min，与工作区回声同量级）收敛。

**归档墓碑（local archive tombstone，同一修订）**：侧栏的归档动词经同一个唯一出口（`archiveSessionForSource`）发布 `reportSessionRemoved`，App 随即记一条本地墓碑（`shared/session-echo.ts` 的 `PendingArchive`）并入该来源的 `archivedSessionIds`（`withPendingArchives`，施加在**最外层**——同一 id 的创建回声行也一并被可见性规则藏掉）。为什么需要：**已挂载**来源的归档由宿主 follow upsert 收敛（生产端 push 带新归档集）；**未挂载**来源没有任何活通道（`commitAggregatePull` 的 mounted merge 冻结上次推送的 `archivedSessionIds`，unary 兜底根本没有归档 wire——已登记 KNOWN DEGRADATION），刚归档的行照样留下、可点，点开落入官方"当前会话已被清空"的空视图。墓碑**只覆盖本页自己归档的 id**：

- 收敛只认**权威**归档集（挂载 push 且 `archiveSetKnown === true`）命名该 id——degraded 视图的空集绝不能用来收敛（会把墓碑全撤掉）；
- 租约挂在 30s unary 兜底拉取上：只要那份（冻结/降级）视图还列该会话就继续藏它，且**每次列出该 id 的拉取都会续租**；回收是全账本的（任何一次拉取都清所有过期租约），故顺序是**先续租、再回收**——否则来源离线超过租约窗、重连后首个列表还没续租就被别的来源清掉。窗口 10min，故正常在线的未挂载来源上墓碑不会过期；唯一回浮路径是"离线超过窗口、其间被其它来源的全账本回收清掉"，结果与修复前相同（行重新可点），重挂载即收敛，来源退役同样回收。TTL 是泄漏护栏，不是收敛预算；
- `archiveSetKnown` 刻意不动：归档管理器仍只按权威集工作（它不列这条墓碑），墓碑只是**导航可见性**事实，不冒充归档集来源。

**登记残余（本修订不解决）**：
- 会话侧的**外部变更**（另一个客户端、宿主侧直接改动）仍只有两条收敛通道（已挂载来源的宿主广播 / 挂载 push、未挂载来源的 30s unary 兜底）——**未挂载来源上刚在别处出现的会话行仍要等该来源被点开**（其成员位只存在于挂载 follow 基线里，属 §2.3 已登记的整源降级面）；本修订覆盖的是**应用内**发起的创建。**别处归档**同理（本页自己归档的已由归档墓碑覆盖），且墓碑租约到期后那条行会回浮，直到该来源被挂载。
- 未被早开臂抢先时宿主上仍会留下一个 blank 会话（同一工作区复用，不增长；后台预热 / 基线收割 boot 也会各造一个）；根治需上游按 shell 作用域拆开"当前会话选择"的持久化——见 `docs/progress/todo/upstream-proposals.md` §1；
- 未挂载来源的**工作区集合**仍只有"回声 + 挂载 push"两个来源：**别处**创建 / 改名 / 删除的工作区与工作区**顺序**仍要等该来源被挂载（用户点开）才收敛（§2.3 已登记的降级面）；本修订刻意不引入"每次变更付一次后台 boot"的收敛臂。**应用内**发起的工作区变更已由唯一出口覆盖（2026-12 第二入口修订），不属于本残余。

**被否方案（Rejected alternatives，2026-12 第二入口修订）**：
- **逐调用点各发一次回声**（2026-12 修复的原形态，只挂在侧栏对话框上）：正是缺陷成因——Git 的 create / adopt / 两类 recovery 四个调用点漏发，未来新入口也可能再漏；由单一出口取代。
- **新增"工作区读通道"**（让未挂载来源直接列工作区）：`workspace.list` 已被上游删除，在 chamber 侧重造读面等于把执行面事实搬进侧栏/控制面（违 §2.3 数据纪律与 AGENTS 边界）；被否。
- **每次工作区变更付一次后台挂载**：与"稳态 ≤1 常驻壳 / 首启每源一次后台 boot"的成本政策冲突（STATUS 已登记"不做"）；被否。
- **回声行一律追加尾部**（锚点引入前的行为）：会把 Git 新建的 worktree 先渲染在列表末尾、挂载收敛时再跳一次，并让 design 08 §3.3 的连续家族不变式在窗口内失真；被锚点方案取代。
- **会话侧只依赖宿主 `api-session/added` 广播收敛**（不加本地回声）：广播与那次 open/挂载 push 是竞态，未挂载来源收不到广播；被否。
- **会话侧缩短 unary 兜底周期 / 每次创建后再拉一次**：mounted merge 保留被冻结的推送工作区成员位，新会话只能落到未归属桶（位置跳动）、blank 行不进导航；只多了 RPC；被否。
- **每次会话创建付一次后台挂载（复用基线收割）**：与"稳态 ≤1 常驻壳"的成本政策冲突（与工作区回声同款裁决），且温壳场景下不解决 summaries 竞态；被否。
- **归档侧不加本地墓碑、只等挂载收敛**：未挂载来源没有通道带出新归档集（mounted merge 冻结、兜底无归档 wire），真机形态即"归档了但那一行还在"、可点且点开是空视图；被否。
- **为归档侧新建一条读通道 / 每次归档付一次后台挂载**：上游不存在会话级归档 wire，自建读面违 §2.3 数据纪律；后台挂载与"稳态 ≤1 常驻壳"的成本政策冲突（与其它回声同款裁决）；被否。


### 2.3 数据纪律

- 会话/workspace 数据**只来自各实例自己的 API**（经 `/api/i/<id>/*` 同源 unary：workspace.list / sessions.list），控制面不建会话索引、不消费宿主帧。
- 连接状态 = 非秘密投影（本地：控制面 /health；远程：desktopSsh status 推送），永不用持久化/推断值冒充。
- 数据节奏：状态与已挂载来源聚合均走现有事件链。本地 `/health` 由 health-events EventSource 驱动；远程隧道相位走 onStatusChanged；每个已挂载 ctx 订阅自己的 `sessions.list` + `workspaces.list`，两份 reconnect baseline 于 idle + ready 后经 chamberBridge 上报完整快照；任一 store 进入 loading/error 即撤回旧快照并清除内容签名，使同内容 reconnect baseline 也重新上报。远端 ctx 的 host frames 仍经既有 SSH 隧道/实例反代 WebSocket 到达，**不增加协议、不修改上游 dsh**。
- 只有未挂载或 reconnect baseline 不完整的 ready 来源走 30s unary 兜底；全部 ready 来源都有完整生产者时不建聚合定时器。连接/生产者状态变化立即重估；`requestRefresh` 对每个 live 来源无条件执行一次即时 mutation-pull（合并会话行、保留分组/归档集），mounted 来源亦然（host-store 推送为主，unary pull 并行通道）。not-ready → ready 连接代边沿固定执行一次 unary。App 断线分支**不清空**已推送来源的聚合（`shouldRetainPushedAggregate`；行渲染以 connected 为门，断连不显示；ready-edge 拉取为 sessions-only merge，归档集/工作区不丢失）。稳定 ready 代非零轮询：30s unary 兜底 watchdog 照常拉取 stale 来源；卡在降级视图（合成行）的来源由限流自愈臂（S2）重连并重放 workspace follow，使 producer 重发真实基线（`shouldRebaselineFallbackView`）。S2 臂陈旧阈值按传输分级（`packages/renderer/src/aggregate-refresh.ts`）：`http` = 120s（上游腿无应用心跳、仅 ~10min OS TCP keepalive）；`ssh` 隧道 = 300s（三个独立探活：反代浏览器腿 30s WS ping、host mux 2s/2-miss 心跳、ssh `ServerAliveInterval=30 × CountMax=3` ≈90s；故只作最后手段）；`local` 与未知传输取 `null`（本地由权威直接服务；未知传输已 fail-closed），该臂**不得触碰**它们。该拉取瞬时失败由 loading 撤回 + idle baseline 重发恢复，不永久停在 error。推快照按来源序号使较旧在途 pull 失效。
  **保留视图有界化（2026-12 残留修复）**：已推送来源的聚合在 unary 反复失败时保留最后视图
  （上面 `shouldRetainPushedAggregate`），此前是**无限**保留——旧 `running` 位会一直渲染成
  「运行中」。现在：距最后一次**成功验证**（push 或 unary 提交，`factsAtRef`）**达到**
  `AGGREGATE_UNVERIFIED_FACTS_MS`（90s ≈3 个 watchdog 周期；判定含边界）后，App 丢掉一个
  **无法验证**的 running 断言（只清 running 位；行/分组/归档集照旧保留，不触发归档回流），并把
  该来源交给既有的会话停滞横幅（`sessionStall.text` =「无法确认会话状态」）——横幅的三条出口
  （重新连接 / 重新加载 / 忽略）对「无法验证」与停滞来源同权；下一次成功读取（push 或 unary）
  立即恢复事实并撤下呈现。判定与界限在 `packages/renderer/src/aggregate-refresh.ts`
  （`shouldDropUnverifiedRunningFacts`，纯函数 + 单测），接线（判定 → 只清 running 位 → 进同一
  横幅）由 `packages/renderer/test/wiring/session-liveness-wiring.test.ts` 钉住。**取舍**：无法
  验证时保留断言等于陈述一个没有证据的事实，而清位 + 可见提示是「不知道」的诚实表达，且恢复路径
  无条件幂等；已知残余 = 宿主其实仍在跑、只是读路径坏掉时用户会暂时看不到运行环（由横幅的
  「重新加载」收口；「重新连接」只对仍持有壳的来源有效——已回收来源的该出口是 no-op，见 STATUS ⑭）。
- **首屏基线收割（`packages/renderer/src/baseline-harvest.ts`）**：首启仅 local 挂载 + 1 个不轮转预热槽、被回收来源点击前禁预热 ⇒ N-1 个 ready 远程源稳态停留在 unary 兜底视图（合成 cwd 分组 + 空归档集），自愈臂均要求 `mounted===true`（至少推过一次快照）。收割把这类来源在同一后台预热槽挂一次，首个权威推送（真实分组 + 归档集，`archiveSetKnown:true`）后即回收，转入"已回收来源"态（保留权威聚合，会话行由 30s unary merge 刷新）。纪律：收割候选优先于普通预热且不受"回收后禁预热"抑制；每源尝试上限 2 次、失败退避 120s、挂载后 `BOOT_TIMEOUT_MS+15s` 无推送且壳已 settle 判失败并释放槽位（截止值由 `boot-budget.ts` 的 boot 预算推导且高于它）；`HARVEST_ABANDON_MS`（截止值 + boot 预算）为绝对放弃上限：壳始终不 settle（挂死的 loader/fetch）时回收并停用该源（`harvestParked`）。语义边界：回收只拆**已注册**壳；从未注册的 boot 只能自行 settle 时拆除（页面生命周期内可残留），同 id 后续挂载不受影响（shell.ts 对"上一代 boot"的等待有 boot 预算上限）。同一上限也独立看管"在途挂载"（按挂载时刻、仅未 settle 的挂载，不依赖收割意图；已 settle 者仍走截止臂）。同 id boot 尾从不提前释放（generation 记录持有者，提前释放会致同号注册覆盖）；改由 shell.ts 对"等待上一代 boot"设绝对上限（前代起始 + 两个 boot 预算，后继共享同一截止）；producer 注册表按代际栅栏（`chamberBootGeneration` 经 ctx 注入），迟到的老 boot 注册作废，teardown 不能清空健康后继通道。活动/待开视图不可回收——标记失败，让既有失败覆盖层与「重试」出现；在途壳不计入 retention 隐藏壳数。存在任一收割候选时，候选集独占后台槽（`prewarmCandidates` 只返回收割候选且返回全部候选，含排在退避候选之后的"退避已满"者）；尝试耗尽且从未拿到基线的源（`harvestParked`）不得退回普通预热；托管 dsh 终态停机或瞬态 starting/restarting 的 gateway 源（投影事实 `managedRuntimeUnusable`）不预热/不收割（boot 必然 503）；用户点开正在收割的视图 = 采用（撤销收割意图，绝不回收）；来源退役时账本同源收敛。稳态 ≤1 个后台壳（含预热）。**收割独立预算线**：温壳使普通预热槽位预算恒为 0（retention 只保 1 个隐藏壳），收割壳不受其约束；代价是最坏多一个隐藏壳（用户温壳 + 收割壳）在收割窗口内共存。**代价与已知取舍**：首启每个 ready 来源各付一次后台 boot（N 次，串行于全局 boot 链，最坏受 60s boot 预算约束）；最后收割的壳保留为温壳（不额外付预热 boot，挂载期状态事实 pending/完成点保持在线），但遇到新收割候选必须**让位**（`shouldReclaimHarvestedShell`）——否则它作为 `autoPrewarmed` 占住唯一槽位（`remaining` 恒 0）。
- **未挂载来源的 unary 兜底表达不了"空工作区"**（2026-12 修订，§2.2.1）：`fetchInstanceSnapshot` 只调 `session.list`，工作区分组由会话 cwd 反推（`__cwd__:` 合成行），刚建好、无会话的工作区在结构上不可见；已推送来源更彻底：聚合保留 pushed 工作区集（mounted merge），`planAggregateRefreshes` 只刷新"刚 ready"或"从未推送过"的来源，对它连 unary 轮询都不再发生。根因是**读通道缺失**：权威工作区集合只存在于挂载壳的 `workspace/follow` 基线（宿主把 `upsert` 广播给所有活跃 follower），chamber 补法是用户那次创建的回声（§2.2.1）——不新增 wire 读通道，也不把工作区事实搬进控制面。
- **本修订的代码落点**：`packages/dsh-chamber-client-ui-sidebar/src/shared/open-intent.ts`（意图槽 + 投影/揭示纯规则）、`.../src/shared/aggregate-store.ts`（桥接单例 + 回声事实通道：`WorkspaceCreatedFact`/`reportWorkspaceCreated` 等）、`.../src/shared/workspace-echo.ts`（回声账本 + union/去重/锚点插入纯规则）、`.../src/shared/workspace-mutations.ts`（**唯一事实出口**：create/delete/rename 的 wire 调用与回声事实，2026-12 第二入口收口）、`.../src/client/early-open.ts`（boot 期早开臂）、`.../src/client/index.ts`（每个 ctx 挂一次早开臂）、`.../src/client/SidebarRoot.tsx`（三个变更点经唯一出口，自身不再直接上报）、`packages/dsh-chamber-client-ui-git/src/shared/coordinator.ts`（Git create / adopt / recovery 经唯一出口；create 带位置锚点，flag/未注册块由 beforePublish 装饰）、`packages/renderer/src/App.tsx`（arm/release、账本与退休含锚点、投影门、揭示门判定、holdVeil 传入）、`packages/renderer/src/components/InstanceView.tsx`（遮罩合成）、`packages/renderer/src/shell.ts`（被取代请求的丢弃：`lastRequestedSession`）。

## 3. 桥接层（chamberBridge，renderer 共享单例）

放在自研侧边栏包的 `shared/` 下；chamber App 层（main entry）、侧边栏插件
（chamber bundle entry）与 ui-layout fork（文档级主题投影）共同 import，
vite 共享 chunk 保证运行时单例。

```ts
interface ChamberServerWorkspace {
  id: string
  title: string
  ungrouped?: boolean             // 仅合成"未分组"桶为 true
  sessions: { id: string; title: string }[]
}
interface ChamberServerAggregate {
  id: string                      // 'local' | 'dsh-<id>' | 'gateway-<id>'（ssh-<id> legacy）
  sourceFingerprint: string       // 该精确来源代的权威 proof（local='local'）
  kind: 'local' | 'dsh' | 'gateway'
  label: string
  connected: boolean              // 本地：dsh ready；远程：隧道 phase ready
  phase: string                   // 状态文本（ready/connecting/… 投影）
  workspaces: ChamberServerWorkspace[]
  aggregateError?: string         // 最近一次聚合拉取错误文本；缺失 = 正常/未连接
  runtime?: InstanceRuntimeReport // 该来源自身 ctx 上报的运行时事实（06 §4，仅附加、不轮询）
  pluginDiagnostic?: PluginGraphDiagnostic // 客户端插件图/额外 bundle 的用户可见诊断
  updatedAt: number
}
interface OpenSessionRequest { sourceId: string; sessionId: string }
interface WorkspaceCreatedFact {
  sourceId: string; workspaceId: string; path: string
  afterWorkspaceId?: string        // 位置锚点（Git 新 worktree 紧跟其主 checkout）；缺省 = 追加尾部
  title?: string                   // 创作意图标题（Git adopt 的分支名）；缺省 = 路径 basename
}
interface WorkspaceRemovedFact { sourceId: string; workspaceId: string; path: string }  // path 尽力而为（快照未报告该行时为空串；账本同时按 workspaceId 匹配）
interface WorkspaceRenamedFact { sourceId: string; workspaceId: string; title: string }
interface InstanceRuntimeReport {
  current?: string                // 当前会话 id（06 §4.3 全局单选高亮）
  sessions: Record<string, {
    running?: boolean             // 实时 running 位（App 完成蓝点边沿推导）
    completed?: boolean
    pending?: 'approval'|'plan-review'|'question'
    runningSubagents?: number     // 运行中子 agent 计数（>0 稀疏；06 §4.5）
  }>
  sessionFactReconcile?: {        // design 14 §D4：运行位活性守卫的 L1 对账回执（可选；旧 producer 不带）
    requestedAt: number           // producer 时钟；仅诊断（守卫只用 settledAt 水位）
    settledAt?: number            // 缺省 = 在途（守卫忽略未结算回执）
    ok: boolean                   // 是否拿到权威结论（false ≠ 一定失败，见 verdict）
    attempts: number
    verdict?: 'converged'|'stale'|'unknown'  // converged = 权威一致（可能经写回纠正）；stale = 权威正面证伪，或 refresh 相位失败/超时且缺 verify seam；unknown（探针失败/超时/两次读数不一致）不升级也不清等待
    corrected?: boolean           // 本轮结束时 store 已无陈旧 running 位（写过 store，或 probe 与写回之间已自然收敛）⇒ 与 ok:true + converged 同现；守卫不据此升级
  }
}
export const chamberBridge: {
  getServers(): ChamberServerAggregate[]
  subscribe(listener: () => void): () => void
  publish(servers: ChamberServerAggregate[]): void        // App 层调用
  requestOpenSession(sourceId: string, sessionId: string): void
  onOpenSession(listener: (req: OpenSessionRequest) => void): () => void
  reportOpenSessionOutcome(outcome: OpenSessionOutcome): void  // App 层调用：一次打开尝试的终态回报（失败带文案）
  onOpenSessionOutcome(listener: (outcome: OpenSessionOutcome) => void): () => void  // 侧边栏订阅：失败行内呈现/成功清残留
  requestRefresh(sourceId: string): void                  // 侧边栏动作成功后调用
  onRefresh(listener: (sourceId: string) => void): () => void  // App 层订阅
  reportWorkspaceCreated(fact: WorkspaceCreatedFact): void     // 侧栏 create 成功后上报宿主 workspaceId（§2.2.1 回声事实；单向，绝不请求宿主改动）
  onWorkspaceCreated(listener: (fact: WorkspaceCreatedFact) => void): () => void  // App 层订阅：并入回声账本
  reportWorkspaceRemoved(fact: WorkspaceRemovedFact): void     // 侧栏 delete 成功后上报（撤销回声）
  onWorkspaceRemoved(listener: (fact: WorkspaceRemovedFact) => void): () => void
  reportWorkspaceRenamed(fact: WorkspaceRenamedFact): void     // 侧栏 rename 成功后上报（改名回声）
  onWorkspaceRenamed(listener: (fact: WorkspaceRenamedFact) => void): () => void
  requestSessionListRefresh(sourceId: string): void       // design 24 §12：请求该来源挂载 ctx 重跑官方 session.list（purge 幽灵行收敛；§12 由生产端校验式收敛链处理：reject/hung 有界重试，越界一律保持抑制——resolve 不构成权威）。**第二消费者（design 14 §D4）**：运行位活性守卫的 L1 也经本通道请求对账；producer 订阅端另驱动 SessionFactReconciler，回执经上面的 sessionFactReconcile 字段回流
  onRequestSessionListRefresh(listener: (sourceId: string) => void): () => void // 各挂载 ctx 的 sidebar 插件订阅；仅 chamberInstanceId === sourceId 者动作（§12：插件自身观测到归档集收缩也会直接触发同一链，不依赖本通道送达）
  requestActivateSource(sourceId: string): void           // 点击来源分组头调用
  onActivateSource(listener: (sourceId: string) => void): () => void  // App 层订阅
  registerInstanceRuntimeProducer(sourceId: string, sourceFingerprint: string,
                                  bootGeneration?: number): { // 每个已挂载 ctx 一代生产者（代际栅栏）
    report(report: InstanceRuntimeReport): void         // token 命中才发布
    clear(): void                                       // generation-safe teardown
  }
  onRuntimeReport(listener: (sourceId: string, report: InstanceRuntimeReport | undefined,
                             sourceFingerprint: string | undefined) => void): () => void
  registerInstanceSnapshotProducer(sourceId: string, sourceFingerprint: string,
                                   bootGeneration?: number): { // 每个已挂载 ctx 一代生产者（代际栅栏）
    report(snapshot: InstanceSnapshot | undefined): void // undefined = baseline 不完整，恢复兜底
    clear(): void                                         // generation-safe teardown
  }
  retireInstanceProducers(sourceId: string): void          // roster 退役时同步撤销 token/cache
  getInstanceSnapshots(): Readonly<Record<string, InstanceSnapshot>>
  onInstanceSnapshot(listener: (sourceId: string, snapshot: InstanceSnapshot | undefined,
                                sourceFingerprint: string | undefined) => void): () => void
  reportPluginDiagnostic(sourceId: string, diagnostic: PluginGraphDiagnostic): void
  clearPluginDiagnostic(sourceId: string): void
  getPluginDiagnostics(): Readonly<Record<string, PluginGraphDiagnostic>>
  onPluginDiagnostic(listener: (sourceId: string, diagnostic: PluginGraphDiagnostic | undefined) => void): () => void
  // 活动视图事实（design 06 §4.6）：文档级状态只有活动视图的实例可以写
  // ——已落地两条：主题投影（ui-layout fork 的 document-theme）与页面语言
  // （`<html lang>`，renderer/src/page-language.ts 的页级归属器）。
  // App 是「谁在屏上」的唯一权威。
  setActiveSource(sourceId: string | undefined): void     // 同值重发为 no-op；undefined = 未发布
  getActiveSource(): string | undefined                   // 未发布时 undefined（消费者 fail open）
  onActiveSource(listener: (sourceId: string | undefined) => void): () => void  // 仅变化时通知
}
```

**App 层（renderer main entry）写入职责**：
- 启动即 auto-start 本地实例（连接行不存在则 `POST /api/connections`）；
  按注册表 auto-connect 远程实例（`desktopSsh.connect`）。
- 活动视图发布：`useLayoutEffect` 在**绘制前**把 `activeView` 写入
  `setActiveSource`（延迟到 passive effect 会先画一帧旧主题）。
- 状态合并发布：控制面 `/health`（health-events 推送流）+
  `/api/connections`（30s）+ desktopSsh status 推送（onStatusChanged）+
  已挂载 ctx 的完整快照上报；仅无完整生产者的 ready 来源 30s unary 兜底 →
  `chamberBridge.publish`；另在每个 not-ready → ready 连接代边沿执行一次 unary，
  收敛生产者同内容去重后的聚合空窗。拉取失败的来源带 `aggregateError` 文本发布。
  每行同时携带当前权威 `sourceFingerprint`；共享发布签名必须纳入该字段，
  使“同 id、其余投影不变”的 replacement 仍会通知来源所有者。
- 订阅 `onOpenSession` → 激活对应来源视图 + `openInstanceSession`（§4）；
  每次尝试 settle 后经 `reportOpenSessionOutcome` 回报所有侧边栏 shell
  （成功清残留失败文本；失败携带 §4 终态报告文案，行内呈现见 §2.2）。
- 订阅 `onActivateSource` → 仅切换活动来源视图（不打开会话）。
- 订阅 `onRefresh` → 每个 live 来源无条件执行一次即时 mutation-pull（与
  §2.3 同规：mounted 来源 host-store 推送为主、requestRefresh 即时 unary
  pull 双通道并行，不是 mounted no-op）。
- 订阅 `onWorkspaceCreated` → 记入渲染端**工作区回声账本**（只记录、不拉取：
  侧栏自己的 create 成功后照旧 `requestRefresh`，两条通道职责不重叠；权威收敛
  点是挂载 push 的 `reconcilePendingWorkspaces`，见 §2.2.1）。同族的
  `onWorkspaceRemoved` / `onWorkspaceRenamed` 是**同一账本**的撤销/改名回声：
  App 分别经 `removePendingWorkspace` / `renamePendingWorkspace` 就地删条目 /
  改标题——没有它们，未挂载来源的 create → delete 会留下一个挂着真 id 动作的
  幽灵行直到 TTL 到期，未挂载来源的 rename 则看起来完全没生效（回声行标题是
  `basenameOf(path)`）。
- 订阅 `onRuntimeReport` → 把各来源的运行时事实合并进 `server.runtime`
  （仅附加、不覆盖轮询字段；来源断连即清，06 §4）。runtime 与 snapshot 两条
  producer 均以注册时单调 token + 主进程下发的 opaque `sourceFingerprint` 认领
  **精确来源代**：App 只接收仍与当前权威 roster proof 相等的报告。来源删除或传输
  身份编辑时，App 在等待异步 shell dispose 前先同步调用
  `retireInstanceProducers(sourceId)` 撤销 token/cache 并广播 withdraw；旧 ctx 随后的
  异步 `report/clear` 全部失效，即使 replacement 尚未注册也不能污染同 id 新代。
- 订阅 `onInstanceSnapshot` → 以内容签名 identity-preserving 合并，并使旧 pull
  失效；订阅 `onPluginDiagnostic` → 合并到来源标题异常标记与**连接页该来源卡片上的
  插件状态行**（`plugin-diagnostic.tsx`；报客户端插件图 boot 健康，与设置面是否可渲染是不同事实面；
  装配诊断块已于 2026-12 完整桥接修订退役)。

## 4. N-ctx 多实例与视图切换

- **视图保留策略（chamber retention）**：除 local 恒留外，隐藏壳最多保留
  `RETAINED_HIDDEN_VIEWS=1` 个（`src/retention.ts`），超限回收"已 settle +
  连续隐藏 ≥60s"的最久者；回收 = dispose shell + 卸载 UI 壳（App 层
  reclaimView，与注册表删除同原语），实例进程/隧道/后台任务不受影响，重开走
  冷 boot + entry 重放；被回收源的侧栏聚合落到 30s unary 兜底（§2.3）。取舍：被回收壳内运行中任务的完成蓝点/通知边沿暂停至该源重开
  （预热/可见性门控与偏差登记见 STATUS.md 与 `scripts/perf/README.md`）。
- N 个 AppWebEntry（共享一份静态模块表，v1 允许各自创建）；每来源一个 shell，hide/show
  切换，会话保活。**视图生命周期 = 注册表来源代生命周期**：来源删除，或
  `kind/host/user/sshPort/remotePort` 任一传输身份字段变化，都通过权威 `retiredIds` 同步
  退役旧视图并 dispose shell（`disposeInstanceShell`，shell.ts）；label 编辑不触碰运行时。
  `serviceName`/`remoteDshHome` 编辑虽不轮换 renderer 的来源 proof、也不退役 shell，却属于
  live transport + exec generation 字段：必须按 §7.6 撤销旧 transport/exec 工作、清理子进程
  并隔离迟到结果。连接失败/手动断开只是瞬时事实（投影为图标/徽标），不回收视图——设置页卡片
  与侧边栏分组都锚定注册表，视图若随瞬时状态消失会造成三面不匹配（侧边栏分组头仍可激活一个
  立即被回收的视图)。boot 排队/在途时被删除的实例在 settle 时拆掉新 entry
  （cancelledBoots，绝不遗留僵尸 ctx）；被回收的视图若是当前视图则回落到 local（常驻）。
  插件图诊断同样受 boot generation 门控：已取消/已被重试取代的旧 boot 即使迟到完成 graph
  请求，也不能覆盖新一代的诊断。
- **boot 串行与 teardown 纪律**：页面级模块物化仍由全局 boot
  chain 串行；某次 `run()` 60s 不 settle 时，全局 chain 只放行**其他 instance**，
  避免一个坏来源永久阻塞无关来源。相同 instance 另有 per-id boot tail：新代必须
  等前代 `run()` settle，并等其 `AppWebEntry.dispose()` 的异步 `ctx.fiber.dispose()`
  完成后才可启动本代 host-graph/extra-bundle 副作用并构造新 Context；60s 护栏不得让
  same-id 两代重叠（共享模块表交错、同容器双 React root、producer 注册顺序反转）。
  无同 id 前代的其他来源仍可 eager prefetch。每 id teardown barrier 在 dispose 一开始即登记，
  replacement/重试/删除路径都等待它；disposer 抛错或 reject 会 loud 记录但被收敛，
  不把该来源永久楔死。取消阈值 + current generation 继续守住迟到 graph/boot 结果，
  runtime/snapshot producer token 则守住异步 effect cleanup。boot/run catch 必须用
  never-throw 描述器收敛任意 thrown value（含自身反射/字符串化也抛错的 Proxy），
  不能让 boot Promise 悬挂。
- **切换实现（即时隐藏 + View Transition + 骨架屏，content-visibility）**： 非活动视图用 `visibility:hidden + opacity:0 + pointer-events:none` 即时隐藏，
  且 `.instance-shell` 同时置 `content-visibility:hidden`——跳过整棵 shell 的
  style/layout/paint 并**缓存渲染状态**（切回复用缓存布局、空闲成本≈零；尺寸不变
  使 vendor 内 ResizeObserver 不触发，无二次重排/列宽 transition 跳动)。切换经 `renderer/src/view-transition.ts`
  的 `runViewTransition` 包装（`document.startViewTransition` + `flushSync`
  同步提交 React 状态）：旧视图先拍**静态快照**，新视图渲染就绪（reveal
  重排长任务完成）后短 crossfade（~250ms 浏览器默认）——隐藏期间仍在流式
  更新的 shell 的增量重排被旧快照遮盖，
  任何时刻无黑帧。**并发语义（键控单槽合并）**：
  `runViewTransition(update, key)` 按意图键（视图切换 'view' / settle 揭幕
  'settle')各保留一个最新意图——同键突发连点只替换意图、被取代意图不进快照、不起过渡节（实际过渡 ≤ 在途 1 节 + 补发 1 节），跨键按首达序 FIFO 补发（settle
  与视图切换互不吞并，骨架 veil 绝不因合并而永驻)；降级路径（prefers-reduced-motion /
  不支持)也走同一单槽队列即时执行，偏好恰在过渡在途期间翻转时不会被在途节的旧意图覆盖。 未就绪视图（首次打开/仍在 boot）进入**骨架屏**（`.instance-loading`）：全屏同底色 veil +
  居中转圈/服务器名文案，`--dsw-alias-*` 主题 token 底色，z-index 盖住 shell 内 dsh 启动页。
  **骨架/框架文案进 typed 字典（T16，2026-09-11 upstream-alignment）**：框架（App / InstanceView /
  `index.html` 的静态首帧)自身没有 `t` 席位，chrome 文案集中在 `packages/renderer/src/locales.ts`
  （zh 为键集权威 + en 完整校验），按**文档语言** `document.documentElement.lang` 解析；该属性由
  页级归属器（`page-language.ts`，design 06 §4.6「页面语言归属」）持有——每个实例壳的官方 locale
  服务都会写它（激活 + 每次字典注册，无 teardown），归属器只让**屏上来源设置面已敲定**的语言落地、
  其余就地回写，故不再 last-writer-wins；未设置时回落到**服务端 markup 自己的默认**
  （`index.html` 的 `lang="zh-CN"`）而非 OS 语言。`index.html` 的静态骨架文案由 `main.tsx` 在
  React 挂载前用同一字典覆盖（`data-chamber-boot-hint` 是唯一挂钩），英文文档首帧即英文。转圈是
  纯装饰（`aria-busy` 承载忙碌事实），已 `aria-hidden`。**骨架屏无几何主张（D1=A）**：骨架不以固定 rail 56 + sidebar 224 = 280px 占位块模仿 dsh
  布局几何——真实侧栏宽度由 layout store 持久化，任何占位几何都会在 settle 揭幕时失配；
  骨架只承诺同底色占位，settle 后第二次 View Transition（键 'settle'）
  换入真实内容——可见视图经 `runViewTransition(..., 'settle')`、后台 boot 直落
  （无过渡，点击切入时的过渡由 App 层覆盖）；失败则 chamber 覆盖层呈现 + 重试 +
  服务器切换（见下），`bootInstanceShell` 的 settle 态经 `.then(setShell)` 落地。

**遮罩不被租客穿透的结构保证（2026-12 P0/P1/P2）**：`.instance-loading` 是 `z-index:1` 的绝对定位面，而官方 composer 座位在 `[data-phase=active]` 下是 `position:sticky; z-index:7`；两者此前同处 `.instance-view` 这一个 stacking context、中间没有任何边界（`.instance-shell` 是静态元素），于是**输入栏画在遮罩之上**（真机形态："白屏里出现输入栏"）。修法是把边界画在**租客根**上：`.instance-shell{isolation:isolate}`——壳内任何 z-index（含未来值）都被压平到这一层，遮罩按结构获胜，不再依赖对上游 z 值的假设（已知边界：原生 **top-layer**——`showModal`/`showPopover`/`::backdrop`——不受 stacking context 约束，任何 isolation 都盖不住；当前上游产物 0 处使用，登记为边界而不是漏洞）；`.instance-view` 自身的 `isolation` 保留，但只用于视图之间互不竞争（原注释把"公共父级隔离"误当成"压平壳内 z"，已订正）。配套两条：①**遮罩期隐藏租客**（`.instance-view.instance-veil-held .instance-shell{visibility:hidden}`，判定 `settled && veilVisible`，与 `.instance-pending` 同法只取 visibility、保留 style/layout）——即便有人删掉上面那条边界，持有期也不会露出租客；该状态并入"隐藏壳不创建动画/过渡"门（门现在是三条选择器：`.instance-hidden` / `.instance-pending` / `.instance-veil-held` 各配 `.instance-shell *`）；②**过渡作用域**：只有活动视图带 `view-transition-name: active-instance`（非活动显式 `none`，名字必须唯一），且 `runViewTransition(update, key, paint)` 在"**落地面是遮罩**的切换"上取 `cut`——判据是目标视图**落地后**的 DOM 事实（其 `.instance-loading` 是否在场，故传 resolver 在认领/flushSync 之后求值，起节前先写保守的 `cut`；认领到更新的意图时覆盖，见 `view-transition.ts` 的 `claimAndApply`），宿主写 `html[data-vt-intent='cut']`——该命名组硬切（旧快照立即不可见），否则 root/命名组的 crossfade 会把**旧视图的输入栏**与新遮罩混色约 250ms；温壳互切保持默认 crossfade（旧快照仍遮盖 reveal 重排）。判据不能是"目标是否已 settle"：已 settle 的温壳同样可以被上面的持有门罩着。

**被否方案（P0/P1/P2）**：①把遮罩 z 提到壳内所有值之上、或让官方 composer 降 z——数值军备竞赛，且要 fork 官方包（越界）；②顶层（popover/dialog）幕布——实测能压过 body portal 的 z=1100，但它是**文档全局层**，会同时盖住所有视图与 chamber 自己的 chrome（含 `.boot-gap` 非模态降级横幅）；③每个视图实例各自一个 `view-transition-name`——旧/新快照名字不同，配不成组，等于没有命名过渡；④`View Transition types`（`:active-view-transition-type()`）——WebKit 支持面不确定，改用宿主 `data-vt-intent` 属性达到同样作用域；⑤租客 **body portal**（ui-chat 4 处 + chamber 2 处，z-index ≤1100）渲染在文档 body 上，**在任何 stacking 边界之外**——边界内不可消除，作为残余登记（STATUS）。 **失败呈现**：失败不由各 InstanceView 自绘（旧 `.instance-fatal` 仅重试、无导航），而由 App 在
  活动视图上统一渲染 `.fatal-overlay`——失败报告 + 重试（`retryToken` 递增 → InstanceView 复位
  重 boot)+ **服务器切换行**（`.fatal-servers`：chamber 级逃生通道，不依赖任何 shell 挂载）。
  原因：boot 失败 = 该视图的 dsh shell 从未挂载，而侧边栏（多来源导航）在 shell 内——没有
  chamber 级覆盖层，用户会被困在当前视图（只能整页刷新），违反「一个实体的失败不得
  抹除/阻断无关健康实体」不变量。dsh 壳内自绘的失败页（`AppWebEntry` 加载页的 fail-loud 报告）
  也经 `AppWebEntry.bootError`（拷贝包 seam）上浮为 chamber 可见的失败态（shell.ts 失败分支
  dispose 该 entry，重试干净重 boot)。**失败报告内容与官方同源（T15，2026-09-11
  upstream-alignment)**：除标题 + boot 失败文本外，还列出该次 boot 里**未激活的插件 id**
  （官方失败页 `Failed to load plugins` 的同一份清单）：`shell.ts` 的 `collectFailedEntries`
  在 entry 销毁**之前**读仍存活的 loader（上游 `assertEntriesActive` 的同一 fact，
  `packages/client/web/src/boot.ts:138-158`)，id 搭已有的 `ShellState.failedEntries` 到 App
  ——不新开通道；被容忍的 per-instance extra row 不在清单内（版本歪斜不得判 boot 失败）。
  失败/控制面不可达两块文案与重试/切换按钮同批改为框架 typed 字典（`renderer/src/locales.ts`，
  按文档语言解析)+ 官方 `Button variant="primary|outline"`，控制面不可达块同样是 `role="alert"`。**框架的 `Button` 走深路径导入**（`@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx`，2026-09-11
   upstream-alignment)：包 barrel 连带 primitives 的 markdown/CodeBlock 家族会把约 87 KB 带进
   **主图**（实测 raw 1,226,775 → 1,313,736，即 +86,961 B），深路径把它们留在 chamber 复合入口
   ——主图在 App 挂载前整体求值，正是 `chamber-entry.ts` 的 C3 注记要把 ui-primitives 挡在主图外
   的理由。**实测门值（`pnpm run build:renderer` 写入 `packages/desktop/dist/web/perf-sizes.json`，
   门值在 `packages/renderer/scripts/check-chunk-budgets.mjs`)**：主图 raw **1,228,157**
   （gzip 339,212）对 `mainGraphRaw.warn = 1,350,000`，余量 121,843 B ≈ **9.0%**；复合入口 raw
   **1,989,208**（gzip 552,563）对 `chamberEntryRaw.warn = 2,000,000`，余量 10,936 B ≈ **0.5%**
   （表头 CSS 244,059 对 warn 300,000；再加一个首屏家族就会触 warn，拆分需先评估）。**模块表安装顺序**：
   模块表（`window.__DSH_MODULES__` + `__ModuleLoader__`
   sink）经 boot.ts 导出的幂等 `ensureWebModuleSystem` 在**任何 bundle 脚本
   执行前**装好（shell.ts 在 collectExtraRows 预加载之前调用，run（） 经同一
   helper 收编）——否则首个带额外行的 boot 会让官方 bundle 在 sink 安装
   前求值、顶层交接抛错，boot 以难懂的 "cannot resolve" 失败。
  ready 远程实例**空闲预热**：按序一次一个后台 boot(`instance-pending` 态仅 visibility 隐藏、
  保留 layout——vendor 测量/IntersectionObserver 在 boot 期间正常)，settle 推进下一个，使多数
  首次切换在点击时已就绪；预热与用户触发复用同一 entry 的 boot promise，不依赖页面级
  base-path/source 全局旋钮。不支持 content-visibility 的浏览器降级为保留 layout 的 visibility
  方案（同样无闪烁）（styles.css `.instance-view.instance-hidden`）。**2026-12 追加纪律
  （「看不到但能点」的空白图标）**：CSS 动画/过渡只在子树被渲染时推进，隐藏壳里创建的入场动画
  被钉在首帧（`opacity: 0`）——元素仍可命中、除重挂载外不自愈（WKWebView 实测见 STATUS）。故
  隐藏壳内**不得创建任何动画/过渡**（`packages/renderer/src/styles.css` 的
  `.instance-hidden/.instance-pending .instance-shell *` 门)，必要内容不得依赖入场动画才可见
  （侧栏/设置壳已整组退役，源文本锁在 `dsh-chamber-client-ui-sidebar/test/visual-lock/`）。
  **降级呈现（2026-12 修订）**：boot **成功**但已知缺口（来源在启动窗口内没有提供客户端插件图／图到了
  但复合首屏 inject 的服务始终没有 provide——典型是 `ui-chat` 等 `sidebarRight`，整个会话视图不注册)
  时，事实经 `ShellState.degraded`（`ShellDegradedFact`，形状在叶模块 `renderer/src/boot-gap.ts`）到
  App：判词经 `bootInstanceShell` 的 `options.onRepublish` 上报（InstanceView 转发 `onStateChange`；shell 的
  `onState` 形参只是**视图本地 setter**，只发它 App 镜像收不到)，结算前的判词按 boot 序号暂存、settle 时补放。
  App 在**活动视图**上渲染非阻断的 `.boot-gap` 横幅：标题 + 按 kind 的正文 + 结构化事实行（缺哪些服务、
  哪些插件在等它们／哪些插件没注册)+ 下一步 + 产出方诊断原文 + 重试。三条纪律：
  ①**归属**：文案属框架面，走 `renderer/src/locales.ts` typed 字典；产出方只发 kind 与结构化事实，
  诊断原文只作诊断行（STATUS「跨边界诊断文案」）。②**可重试性由事实裁决**：`BOOT_GAP_POLICY` 是
  `Record<kind, …>`，新增 kind 不带文案与 retryable 裁决即编译失败；`planDegradedRetries` 只重挂
  retryable 的 kind（每 ready 世代一次，见 `degraded-retry.ts`）。③**不撒谎**：kind 不能判定
  「暂时／结构性」，故文案一律"常见原因…"，且**只有在来源 ready 且本 ready 世代尚未重挂过**时才承诺
  "会自动重挂一次"（非 ready 时 self-heal 永不会来）；a11y 用 `role="status"`（不是 `alert`——几秒的
  竞态不该打断读屏)。提示**非阻断**：层 `pointer-events:none`、只有卡片接收命中；`z-index: 900` 明确
  低于 `.fatal-overlay` 的 1000，boot 失败态与它结构互斥；**控制面不可达**那张覆盖层与壳状态无关，
  由 App 侧显式门（`!controlUnreachable`）拦住，不靠 z-index；body portal（STATUS 已登记的未修缺陷）
  仍可盖住它，属既有边界。重试与失败覆盖层**共用唯一入口** `retryView`（探测 + 隧道再试 + 令牌递增），
  自己写一套会漏掉最后那条探测臂。
  **降级事实的第二批座位（2026-12，同一修订）**：事实还经**既有投影通道**过桥——
  `ChamberServerAggregate.bootGap`（结构化：`kind` + `services`/`injectedBy`/`failedIds`，**不含**
  产出方诊断句)，由 App 的 `deriveServers` 从 `shellStates[*].degraded` 投射，进
  `serversProjectionSignature` 发布门（缺口单独翻转必须重发布）。两个座位：①**侧栏来源行**
  (`ServerSection` 的 `sourceNote`)——并入既有的**单一 live region**，按优先级 `托管不可用 >
  前端能力受限 > 托管瞬态 > 基线未就绪` 取一句，`sourceNoteBootGap` 修饰类给警示色；**活动来源那一行**
  把区域降为 `aria-live="off"`（同一事实已由框架横幅播报），非活动行保持 `polite`（那些来源没有横幅，
  侧栏是唯一用户面)；②**连接页**（`PluginDiagnosticLine` + 插件对话框）——与 `pluginDiagnostic` 是
  **两条独立事实**：图通道的 `ok` 不代表服务都在（缺 `sidebarRight` 时图通道恰好是 `ok`），因此**缺口
  在场时抑制 `ok` 那一行**（problem/info 照旧渲染），缺口行取**警示色**（`pluginDiagnosticWarn`，与
  框架横幅、侧栏来源行同一色阶)，并给 `bootGapHint` 行动提示（与
  `pluginDiagnosticVersionConflictHint` 同形)。词汇表由侧栏 shared 契约单点拥有（`ServerBootGapKind`），
  渲染包只 import 类型、各出各的文案——即 STATUS「跨边界诊断文案」那条"产出方发结构化事实、渲染方出
  文案"的落地形态。
- `openInstanceSession(sourceId, sessionId)`（shell.ts）：boot 未就绪先入队，原调用 Promise
  保持 pending；enqueue 当刻固定 **68s absolute deadline**(60s boot queue 预算 + 最多 8s
  session-list 可见性轮询)，flush 不重置预算，只用剩余时间且上限 8s。settle 后经
  `AppWebEntry.runtimeCtx.sessions`（拷贝包 seam，§6）分发，只有 runtime 接受才 resolve；
  dispatch poller 归属精确 `ShellHolder`，每次 snapshot/重试/最终 `sessions.open()` 前复验
  holder 身份，replacement/dispose/disposeAll 会同步清 timer 并 reject 全部 holder-owned
  在途 dispatch。boot/dispose/总截止时间到达同样 loud reject，旧 runtime 永不能在 teardown
  后迟到执行 open；runtimeCtx/list/open 的 getter/调用若抛任意 hostile value，也必须经同一
  never-throw 描述器 reject 并清理 timer/cancel handle，不能把 timer-driven open 永久挂起。
  **sessions 服务就绪与列表可见性共用同一轮询预算**：boot settle(loader.await +
  assertEntriesActive)只等 entry **根** fiber，`ctx.sessions` 由 composite 的**子** fiber
  提供（child 在异步 api-remotes 命名空间 mount 后才激活）——queued open 的 flush
  （entries.set 同刻）或就绪窗内的点击可能落在 holder 已注册而 sessions 服务尚未注册的窗口。
  该状态是**瞬态**：poller 按 400ms 节奏在 deadline 内等待服务就绪与目标会话可见，绝不
  fail-fast；deadline 到达才 loud reject，且区分
  两种终态报告（服务从未就绪 → 「boot 未完全就绪」；服务就绪但会话始终未列出 →
  「等待超时」）。终态失败文案经 `reportOpenSessionOutcome` 回报侧边栏并在
  目标会话行内呈现（§2.2），不再 console-only——fail-fast 会让跨服务器
  冷壳/回收重 boot 后的首次会话点击在视图已切换后瞬间失败，用户落在目标服务器
  UI 而未选中会话（呈现为该 workspace 的新对话输入框）。
- **每 entry Context 私有注入**：`AppWebEntry` 提供 `configureContext(ctx)` seam；shell.ts
  创建 entry 时用闭包把该视图自己的 `chamberInstanceId`、`chamberBasePath` 与主进程签发的
  `chamberSourceFingerprint` 写入其 cordis Context，chamber-entry 只做事实校验；**两个
  base-path fork 的 `apply(ctx)` 各自从该 Context 读 `chamberBasePath`**(connection：RPC
  载波 + `handle.basePath`；api-gateway：`/api/remote.mux` 路由)，不再经插件 config 传参。
  不同 entry 不通过 `window.__DSH_BASE_PATH__` 或页面级 `chamber-knob.ts`（已删除）交换 boot
  参数，因此并行/交错 boot 不会串用来源或代理前缀；shell 在任何 graph/module 副作用之前仅接受
  精确 `local`、规范 `dsh-<raw-id>` / `gateway-<raw-id>` 或兼容迁移的 legacy `ssh-<raw-id>`
  （raw id 明确排除保留字 `local`），且强制 basePath 等于 `/api/i/<instanceId>`。
- 目录选择面统一为应用内浏览对话框（browse）：**所有实例一律注册 `UiDirectoryPickerBrowse`**，
  与宿主能力恒一致——本地宿主经 spawn 环境 pin `SSH_CONNECTION`（02 §3.1）令其
  directory-picker-auto 解析 `browse`（服务 `host.listDirectory`/`host.createDirectory`）；
  远程宿主按 02 §3.9 部署（单元含同款 pin；headless linux 服务器无显示会话，缺行也天然
  browse)；OS 原生选择器（native）对 chamber 用户永不出现，添加工作区的唯一路由 = 应用内
  对话框 pick 一个宿主目录（含弹窗内新建文件夹）。侧边栏"添加工作区"打开的就是同一对话框，
  按来源分派（每来源 unary client 驱动，见侧边栏包 README）。
- 官方 ui-workspace 的 hero "Add workspace…" 与 chamber 侧边栏共用同一
  browse 表面，样式与交互完全统一（上游 one-route 哲学：不做手敲路径
  表单——native picker note 与 one-route 简化均已否定手敲路径交互）。

### 4.1 未 settle boot 的呈现与逃生（2026-12 boot 死区收敛）

远程来源未就绪时点开会话，活动视图停在全屏遮罩上；导航（侧栏）在**壳内部**、
App 级失败覆盖层只在已 settle 失败时出现——"boot 不 settle"窗口零导航，此前只
能整页刷新（两 flavor 菜单有 Reload），唯一自动兜底是收割放弃臂（`HARVEST_ABANDON_MS`
= 135s，只对未 settle 挂载生效)。实现：`renderer/src/source-readiness.ts` 纯
决策 + `App.tsx` / `components/InstanceView.tsx` 接线（另涉 `host-graph.ts` 通
道失败上浮、`locales.ts` 新键、`styles.css` 遮罩动作样式)：

- **遮罩可操作化（W1）**：遮罩在反馈窗（`VEIL_ACTIONS_AFTER_MS` = 10s）后从"纯
  转圈"变为可操作态——已等待时长 +「重试」+「切换到其他服务器」行（同失败覆盖
  层 `.fatal-servers`，chamber 级、不依赖 shell 挂载)+ ⌘R/Ctrl+R 提示。它
  **不是失败声明**，失败呈现归覆盖层专有（互斥：`error !== null` 才画覆盖层，
  未 settle 才给遮罩动作)，慢 boot 不谎报成失败。动作出现时 `aria-busy` 翻假，
  动作行 `role="status"` 播报一次；队列事实（见下条）不受反馈窗门约束，一成立
  即现。
- **返回/切换的顺序（W4）**：「切换来源」只登记"用户放弃"意图并切视图，
  **等切换落地**再由 App 回收（`reclaimView` 拒绝活动/待开视图；`selectView`
  的 apply 经 View Transition 单槽队列可能延迟)。已知取舍：从未注册成功、永不
  settle 的 boot 其 ctx/容器仍等它自己 settle 才拆，本轮不改；被拆的是**视图**
  与挂载位。
- **相位感知的就绪门（W2）**：`waitForServing` 仍以 `BOOT_TIMEOUT_MS` 为绝对上
  界，但**终态相位持续 `SERVING_TERMINAL_GRACE_MS`（1.5s） 后立即判"不可服务"**，
  不再烧满 60s。终态词汇 = `error` + `stopped`/`restart-exhausted`（快速重试耗
  尽或托管 dsh 停机；门读**合并后**的 `phase`，本地托管停机同词，SSH 无此两相)，
  与姊妹门 `shared/serving-gate.ts` 的 `TERMINAL_PHASES` 对齐；gateway 自动回
  滚期 `restart-exhausted` 可能已在自愈，代价一次无图挂载 + ready 世代自愈。
  **`degraded`（重连在途）与 `connecting` 一样等满预算**。
  **原始 transport 投影只决定在场与否；相位取合并后的派生 `phase`**：`undefined`
  （投影未到）不是断开事实，预算内继续等；只有真正的 `idle` 立即判不可服务——
  `deriveServers` 的 `?? 'idle'` 折叠值会把投影延迟/状态拉取失败秒判成"未连接"
  （2026-12 独立复核修正）。`idle`（手动断开）**不启动 boot**：遮罩给「未连接」
  +「连接」（显式意图，同设置页 Connect）；离开 idle 后按正常路径 boot。
  **被推迟的视图从不参与放弃臂计时**，但**必须回收**：后台挂载（设置面板选来源）
  不经 active 变化臂，故**挂载时刻**起隐藏计时，过保留宽限（60s）由推迟回收臂
  拆（2026-12 复核 F1）。裁决（`isDeferredReclaimDue`）：**只接管从未 settle 的推迟挂载**
  （已 settle 的推迟壳是真壳，回 retention 候选窗），且
  **设置面板正在编辑的来源绝不回收**（design 05 §5 面板 hold，缺守卫会钉死面板）；
  活动/待开视图同样不回收。手动断开前已起过的在途 boot 仍由放弃臂看管（起表只
  跳过、绝不删除)。
- **重试的诚实（W4）**：同 id 新 boot 先等同 id boot 尾（绝对上限两个 boot 预
  算，`INSTANCE_TAIL_WAIT_CAP_MS`)。遮罩只在**前一次尝试尚未 settle**（才真排
  队)时播报"排队 + 上限"——失败 settle 后同 id 尾已释放，按"第几次尝试"播报
  会在"失败后重试"里撒谎（2026-12 复核 F3）。
- **通道失败进入降级事实（W3）**：图通道失败（非 `not-injected`：502/504、网络
  错误、图形非法等)也上浮 `ShellState.degraded`（kind `graph-unavailable`），
  由 App 非阻断 `.boot-gap` 横幅解释，沿用该 kind 的「每个 ready 世代自动重挂
  一次」。旧契约只在连接页 `pluginDiagnostic` 一行；W3 增益是
  **boot 表面的可见性 + 自愈**，不是"从零到一"（2026-12 复核 M3 更正了口径）。
  豁免 = `not-injected`（HTTP 404 或通道答 method 缺失）：gateway/mobile 形态
  合法无图端点，不是降级。

**Rejected alternatives（本轮权衡）**：⓪ 以"进度信号"（帧/心跳/rAF 计数）判前
台停滞——死区无可信进度源，误杀健康启动；① 取消在途 boot——需动 `shell.ts`
的 boot 世代/teardown 契约（同 id 尾等待、一容器一 root 不变量、ctx 只在
settle 时拆除)，风险超窗，登记后续项；② 只下调 `HARVEST_ABANDON_MS`——它是收
割账本停用/释放槽位判据（退避是另一个常量 `HARVEST_RETRY_BACKOFF_MS`），不解决
死区零导航；③ 切换器搬到壳外——推翻 §1 的 N-ctx 与"导航在壳内"契约，成本远超
收益；④ 60s 墙钟硬判失败——"graph 4.5s（9×500ms 重试预算）+ 60s serving 门"已
超它，**必然误杀合法慢启动**（还有 30s bundle 加载与 15s mount 上界），正是"截
止/放弃值必须高于 boot 预算"要防的形态；⑤ 复用 `.fatal-overlay` /
`markAbandonedShellFailed` 在反馈窗判失败——把"慢"谎报成"失败"（放弃臂会重算
预算)，违反"不撒谎"纪律；⑥ 遮罩点击穿透露出壳内侧栏——死区没有已 boot 的壳，
穿透只点在启动页上；⑦ 新增原生桥面让 Swift 监督 boot——代价 A 桥通道 + manifest
+ shim/ipc 锁步测试；唯一残余场景（页面 JS 主线程冻结）
**未被既有看门狗完整覆盖**（看门狗需 15s 无输入 + 3 次探测，点按钮即重置；
`didFinish` 前未武装而窗口已呈现)，故登记为原生侧开放项（见 STATUS），页面级
逃生已覆盖用户面。

## 5. 连接设备页

- chamber 自研插件包 `packages/dsh-chamber-client-ui-settings-connections`（`@dsh-chamber/dsh-chamber-client-ui-settings-connections`）：连接页是设置壳的**固定 nav 入口**（`__connections`，分隔线之下、不占 ledger order），**不是** `settings.section` 注册（该 host-ctx 注册已移除，无第二个连接页）；插件只提供该页字典命名空间与分节组件（`ConnectionsSection.tsx`）。
- 「dsh 运行时」段（design 18 §3.6/§9，per-server）：chamber 自研 `settings.section`（id `dsh-runtime`，order 31，由设置壳 settings-bridge 的 `registerRuntimeSection` 注册）挂在**该来源自己 boot ctx 的 ledger**（2026-12 完整桥接修订；随 `chamberBridge` roster 投影 reconcile），紧随 agent-presets 渲染。local = 完整运行时管理面；gateway = 经反代触达该 gateway 的 `/chamber/runtime`；**dsh 直连（ssh/http）= 不挂载**（无 `/chamber` 面、无 ssh exec 管理通道，不渲染该分节；18 §3.6 / AGENTS / design 17 §3 同口径），也不再位于 chamber 全局「客户端」视图（design 15 的 `__general` 控制组不含运行时块）。
- **「重启 dsh」动作只在本地与 gateway 两源**（design 18 §3.6 项 8，刷新插件挂载）：local = 控制面事务接口 `restartLocal()`（design 18 §9.3，与健康状态机重启单飞行串行化——**不是**连接页裸启动/停止的组合）；gateway = `POST /chamber/runtime/restart`（经 `/api/i/gateway-<id>/chamber/*` 反代，202 + status 轮询）+ `POST /chamber/runtime/start`（design 21 决策 12 停机恢复：stopped/error/restart-exhausted，卡片「启动实例」入口）。二次确认 + 状态行，与健康状态机 `restarting` 单飞行互斥、applying 期间禁用。**确认门只有一个**（2026-09-11 upstream-alignment T2；accept 复验与时限见 2026-09-11 review-fix F2/F4b）：本地重启与**全部** gateway 变更动作共用应用内官方 `Modal`(`RuntimeConfirmDialog` + 纯机器 `confirm-machine.ts`)——武装不跑任何东西，取消在 runner 调用前丢请求，**accept 先按 live 事实复验**（每个 request 带 `stillValid`，与武装同一谓词、读每次渲染重写的 `liveFacts`；失败即 `outcome:'dropped'`，由本段错误行如实报「已过期」而非静默，因对话框跨过 `~3s` 状态轮询）；**gateway 侧动作另有 12 分钟墙钟上限**（`REMOTE_ACTION_TIMEOUT_MS = REMOTE_STATUS_POLL_TIMEOUT_MS`(11 min) + 60s，与轮询预算同源），否则 pending 期忽略取消/Escape/遮罩的对话框会被永不 settle 的动作锁死；**本地腿（`restartLocal()` 经 IPC 到主进程事务）没有 abort 句柄**，缺口登记在 STATUS。ssh（dsh 直连）的 systemd `restart_service` 属**连接管理面**（重启 gateway/dsh 服务本身，非插件模型动词，design 21 §3 目标语境差异登记）；dsh（ssh/http）直连不挂载 dsh-runtime 段、无插件模型重启动作（http 直连来源无任何重启动作，design 17 §3）。
- **写者静默通知与「清理并接管」（2026-09-10，02 §3.4 / 04 §3.2）**：本地卡在 `GET /api/connections/local/writers` 报非静默时，卡片内点名阻塞写者（`pid <n> · <原因>`，附机器 token）并给「清理并接管」按钮（`POST …/reclaim`）：清除**本状态目录自己的**陈旧/孤儿托管写者记录后启动本地实例；owner 仍活的另一应用实例永不被影响（控制面拒 409，原因带 `detail` 返回、卡片原样呈现）。写入期终止失败（`sticky`）只提示重启应用、不给按钮（无证据可依）。判定是纯函数 `writer-diagnosis.ts`（有单测），卡片只渲染。
- **职责划分**：连接页本地卡的 启动/停止 = 连接生命周期（开机常驻与否）；「dsh 运行时」段的 重启 dsh = 运行时维护（刷新插件挂载、恢复服务）——两者不合并、文案不混用（起停不改运行时事实，重启不改指针/版本）。
- **每来源设置面 = 该来源自己的设置面（权威口径，2026-12 完整桥接修订）**：设置壳不再装配「缩小版前端」，而是**渲染该来源自己 boot ctx 的 `settings.section` 台账**，条目用**该 ctx 渲染器绑定的标准座**渲染（实现见 `packages/dsh-chamber-client-ui-settings-bridge/src/client/`）：
  - **台账来源**：选中来源自己的 cordis ctx(`AppWebEntry` 的 boot ctx)——官方 settings 全族由 chamber 复合 bundle 挂在那里（`chamber-entry.ts` 首屏 `ui-settings` + deferred general/models/plugins/plugin-inventory/agent-preset），该来源自己的客户端插件由 host-graph extra rows 挂在那里（design 09 §3），chamber 自研分节（「dsh 运行时」）也由本包在该 ctx 上注册。**面板不挂载任何插件**：无第二次挂载、无桩 remote、无能力降级，也没有「未激活」可报。
  - **面（face）注册表**（`settings-source-face.ts`）：每个实例的桥接插件在该 ctx `apply` 时发布 `{slots, locale, chamberSourceFingerprint}`；该实例的设置壳组件（`sidebar.settings` occupant，唯一被渲染器绑定完整标准座的 chamber 条目）发布渲染器给它的标准座（`useSessions` / `useWorkspaces` / `usePanelInfo` / `useResource` / `useSessionPendingInteraction` / root `props`）。两半都发布齐（`settingsSourceFaceReady`）才可渲染；半发布的 face 不可渲染。
  - **渲染**（`bridge-outlet.tsx`）：面板按 `settings.section` 台账的 list/keyed 语义渲染条目：标准座 + `t`（该来源 locale face 的命名空间）+ `useStore`/`actions` + `renderSlot`（子座位）+ 条目 `inject` 面 + owner props。**座位来自该来源自己的渲染器绑定**，绝不伪造空桩：某个座缺席是那台服务器的事实，不是可补空 observable 的缺口。observable 管线用上游 `bindings.tsx` 导出的 `observableHook`（vendor `ui-renderer/src/client/bindings.tsx:57`；不再自带 per-source 选择器 hook 缓存），nav 行标签用上游 `resolveSlotLabel`（vendor `ui-slots/src/index.ts:620`；不再内联同一规则）。**槽锚点与单元派发照上游**：每个槽渲染点外恒有 `<div data-slot="<key>">`（`display:contents`，不占布局）——官方样式表寻址的稳定缝（如 `settings.general.item` 的 `> :last-child` 规则）；它挂在**出口**而非派发结果上，胜出条目、fallback、占用但无胜出者的**死单元**、未声明槽都在内渲染，锚点不随注册抖动闪断。死单元渲染可寻址的 `<div data-slot-error="<key>">`，与「该键从未注册」的 fallback 区分开（纯判定 `cell-dispatch.ts`）。
  - **归因不上面**：`StoredEntry.registrant`（cordis fiber-name 戳）**不渲染**——上游官方壳也只渲染 `navIcon(row.id)` + 分节标签，该戳在上游是纯诊断字段。本仓因此退役曾经的「插件」来源标记（2026-09-11，用户拍板）：插件提供的分节与官方分节在 nav 上完全同形。
  - **来源必须在挂载中**：面板打开期间 App 层保证该来源
    的壳**已挂载**——`chamberBridge.setSettingsTarget(sourceId)`（面板→App 单通道）未挂载则后台挂载（**不切 active view**），已挂载则**排除出一切回收路径**：保留策略候选、唯一拆除入口 `reclaimView` 与推迟回收臂都拒收该来源（否则隐藏 60s、135s 放弃臂、收割失败/放弃任一臂拆壳都会让正在编辑的设置面消失）；面板关闭即撤除。来源退役的卸载走注册表删除臂（不经 `reclaimView`），该 hold 不拦退役。未挂载时面板显示「正在启动该实例的前端」，离线来源显示既有不可达占位并给连接管理入口（不触发挂载）。
  - **来源化身守卫**：face 携带交付给该 ctx 的 `chamberSourceFingerprint`；面板只在它与权威 roster 的同一字段相等时渲染（同 id 替换/传输字段变更后的旧 face 绝不渲染一帧）。
  - **座位矩阵**：壳渲染 `settings.section` + `settings.action`（action 保持既有「仅本地来源」限定），子座位（`settings.general.item` / `plugins.tab` / keyed 卡片）随所属分节渲染；`trigger/header/close` 属**壳 chrome**，`settings.onboarding` 由壳**自己协调**（2026-09-11 upstream-alignment，见下条）。壳 chrome 同批对齐上游：面板圆角 **32px**（上游 `SettingsRoot.module.css` 的 `.panel` 规则本体，此前抄的 r24 来自该规则的过时注释）、触发器行 **42px**（上游 `.triggerRow`/`.trigger`；chamber 只渲染按钮）、关闭后焦点还给触发器（上游 `wasOpen` effect）、头部**不再重复分节标题**（每个内容分支自己渲染 `<h2>`，壳只留「选中服务器」副行——chamber 的 N 来源补充）。chamber 全局入口从「通用」改名 **「客户端 / Desktop」**（`clientNav`）：官方分节 `general.nav` 就叫「通用设置 / General」，同名会让两个不同的面在 nav 上不可分辨；nav 单元与页面自己的 `<h2>` 共用这一个键。
  - **`settings.onboarding` 协调器（chamber 的 N 来源适配，2026-09-11 upstream-alignment）**：上游 `SettingsRoot` 在**当前会话为 blank 或缺席**时挂载台账里**有序的第一个未完成步骤**，以步骤自己的 owner props（`stepId` / `complete` / `openSection`）渲染——步骤组件住在同一个 boot ctx 里，自带 ctx 读取、就绪门与对话框 chrome（`#root` inert 归它），壳不画任何自己的东西。chamber 壳**就是**该实例 ctx 的 `sidebar.settings` occupant，故只协调**自己 ctx** 的台账 + 自己 ctx 的 `useSessions` 座，并额外串一道 App 发布的**活动视图事实**（`chamberBridge.getActiveSource`，与 ui-layout 文档级主题投影同一道门）：一页挂多个实例壳而首启对话框是文档级的（portal 到 body + 持有 `#root` inert），不串门会把另一实例的首启弹到当前视图；未发布（undefined）读作关闭。**刻意不按"选中来源"协调**：跨 ctx 步骤只能靠跨 ctx hook 驱动，两个同选一源的壳还会重复挂载同一步骤。渲染走 `BridgeEntryBoundary containAll slotKey="settings.onboarding"`（外来步骤崩溃也不夺走 `sidebar.settings` 座位）。**两个坐标各管一半（2026-09-11 review-fix F1）**：活动视图门只门**挂载**（`onboardingStage` 的 `step` = 两事实的合取），**完成集重置只跟 sessions 事实**（上游 `SettingsRoot` 的 reset effect 原文 `if (onboardingActive) return; setCompletedOnboarding(new Set())`，`onboardingActive` = sessions 选择器）；早先把活动视图门折进重置，一次普通**切视图**就抹掉全部确认。**残留（登记偏差）**：完成集是组件局部的，壳被**重新挂载**（App 回收该实例再挂起）仍从空集重跑；收口需要跨挂载存活的每实例状态（新的 chamberBridge/持久化通道），不在本轮范围。两个坐标各由**独立 hook 调用**读取（合取写成 `useOnboardingActive(...) && useActiveView(...)` 会在 sessions 事实为 false 时短路掉第二个 hook，是 React 拒绝的钩子序列）。
  - **`sectionsEmpty` 占位保留**：上游在空台账处渲染空的选项列（其单 ctx 壳不可能「有面板无分节」）；chamber 保留这句诚实占位，因为未发布的 `settings.section` 台账是**可达的 N 来源状态**（该来源的设置簇尚未落到它自己的 boot ctx，或外来 dsh 目标的插件图部分失败），空列会被读成「这台服务器没有设置」。
  - **错误containment**：外来条目（该来源自己的插件贡献）的渲染失败经 `BridgeEntryBoundary containAll` 收口成 `<div data-slot-error="…">`，绝不夺走 chamber 自己的 `sidebar.settings` 条目（那会回落到没有服务器下拉的官方 SettingsRoot）。该崩溃面连同胜出/fallback/死单元/未声明四条派发路径都在同一 `[data-slot="<key>"]` 锚点内（见上「槽锚点」）。
  - **保留优先级 + 看门狗**：设置壳注册在保留 shadow 优先级（shared face `settings-shell.ts` `SETTINGS_SHELL_SHADOW_PRIORITY = -1000`）；chamber 侧边栏监视 `sidebar.settings` 的 cell winner，若有注册者低于该区间（即顶掉设置壳）则 `console.error` 报告（检测而非改写 slot 语义）。
  - **`settings-connections` 座位**：该插件只提供字典命名空间（无 host-ctx `settings.section` 注册）；固定入口 `__connections` 渲染同一组件。连接页内该来源卡片上的「客户端插件状态」仍由 chamber 的 boot/extra-row 诊断通道供给（`pluginDiagnostic`），与设置面是否可渲染无关。
  - **上游可选项（非前置）**：声明式贡献描述符 / 设置面服务契约 / Remote descriptor 上行通道仍是上游提案（`docs/progress/todo/upstream-proposals.md` §2）；完整桥接不依赖它们——它复用上游既有的「来源自己的前端」这一事实。
- 内容：本地实例卡（/health 状态徽标 + /api/connections 行端口/label + 启动/停止（二次确认）+ host 日志只读）+ 远程主机卡片列表（label + user@host:port + phase 徽标 + 隧道 localPort + serviceName + logSummary；连接/断开 + systemd 起停/查询 + 日志 Modal（logs/logs_clear）+ 编辑 + 删除 + dashed"添加主机"卡 → Modal 表单）。
- **design 21 插件管理面**：卡片日志入口命名区分（「连接日志」= 本机连接通道事件 / gateway 卡「网关主机日志」= 服务器侧 gateway 进程与托管 dsh spawn 日志；图标去重）+ gateway 卡「重启 dsh」/「启动实例」动作（phase 门控 + 每卡单飞 + 共享 pollGatewayReady 轮询，多用户中断确认文案）+ **单一插件管理模型视图（唯一 `PluginDialog` 组件）**：统一区域 = 诊断横幅
  （状态名 + message 去重）→ chamber 内建组件表（注册表驱动的宿主包行，
注册表现有四行 client-graph / git-worktree / archive-cleanup / open-in，其中 open-in 标 `localOnly`：**该行只列在本地目标**，非本地目标的行集 = 该目标适用行（local 4 行 / ssh·gateway·http 3 行；2026-12 裁决，详见 design 21 §6.6）；另有 gateway 源才出现的
  移动端 client 行，随发行物注入）→ 第三方插件区（已安装列表 + 逐行卸载 + 添加：spec 输入 + npm 搜索 +
文件夹导入；**行集 = 该目标 profile 的依赖表**（local/ssh/gateway；http 直连没有 `rows` 面，只有 Loader 清单分类）——安装自带组合与 chamber 播种物不在此列，它们分别属于运行时基线与上面的 chamber 内建组件表，详见 design 21 §6.11.5 的 2026-09 行集修订))
  → 恢复/动作行；gateway 添加双通道（registry spec 直装 +
文件夹直推)已接线；「变更记录」区不渲染（后端 journal/备份保留）；恢复撤销仅 gateway（崩溃/恢复态恢复横幅）；http 直连只读不变；恢复提示 r0–r4 文案双后端同权；契约与余留见 design 21 §6.6/§7；**受保护集合与代耦合**（官方 opt-in 层可装可卸、受保护行只读可见、角色徽标、代不匹配提示、旧 gateway 只读回退）见 design 21 §6.11。
- 操作全走现有 `desktop_ssh_*` IPC 与 `/api/connections`；表单收非秘密元数据（id/label/kind/transport/insecureHttp/host/user/sshPort/remotePort/serviceName，id 白名单 `^(?!local$)[a-zA-Z0-9_-]{1,64}$`（禁 `local`、限长 1–64，transport-provider 常量），端口 1–65535；transport 表单 schema 按注册表驱动，17 §2.2），SSH 认证默认走系统 ssh-agent/默认密钥；**可选密码字段**（§8 例外）：与元数据一起经 `desktop_ssh_save_connection` 转发主进程（内存 + `<userData>/ssh-passwords.json` schema v2 binding 明文镜像，0600 原子写），表单永不记录、编辑时永不回填——**SSH 材料（除该瞬时输入外）永不进 renderer**。
- **`~/.ssh/config` 自动发现**：主进程读取并投影非秘密字段（alias/hostName/user/port，跳过通配符条目；IdentityFile/ProxyCommand/凭据不投影），经 `desktop_ssh_config_list` 供添加表单选择填充；手写解析器（无依赖），文件缺失 = 空集、不可读 = 响亮 {error}。
- **端口语义**：`remotePort` = 远端目标端口（ssh 隧道远端 / http 直连端口，必填）；`sshPort`（可选）= SSH 守护端口（null = ssh 默认 22 / config Port，非空时隧道与 systemd exec 均带 `-p`）。
- 样式遵循 dsh 设计语言：CSS modules + `--dsw-alias-*` token + ui-primitives（Button/Modal/Tooltip/Input/Pill/图标）。
- **状态胶囊与告警条 = 官方 Tag tone 的淡底配方（2026-09 batch 1 F1/F2 登记，含对比度实测）**：`.badgeOk/.badgeBad` 用 `color-mix(in srgb, var(--dsw-alias-state-{success,error}-primary) 10%, transparent)` + 同色字，`.pluginKindClient` 用 warn 12%，告警条（`.recoveryBanner`/`.writerBlocked`）用 warn 12% 淡底 + `state-warn-label` 字——与官方 `_tag_brmue_4[data-tone=success|danger|warning]` 逐字符同配方（此前是实心填充）。**代价（按 pin 的 token 值用 WCAG 公式算，非浏览器实测）**：`.badgeBad` light 4.50→3.80、dark 4.35→3.28；`.recoveryBanner` warn 字 dark 4.99→3.99、light 2.79→2.55（light 侧改前即低于 AA）；`.badgeOk` dark 4.53、`.pluginKindClient` dark 4.58。**本页表单字段同期对齐官方 Input 原子**（`.input`：32px / l4 / r8 / 14-22，15 处；与 git 对话框的 `.fieldSelect`/`.fieldInput` 同族，2026-09 batch 1 G3 follow-up）：**dark 侧错误胶囊与告警条跌破 4.5:1**，官方自身同款同值——取"与官方一致"而接受该下降；若要 AA，把 light/dark 字色改走 `state-*-label`（或浅色主题下调深），属下一轮改动，勿当漏改收回。
- 实例默认仍按注册表自动连接、本地自动启动；本页提供显式管理与诊断入口。

## 6. 源码复用与构建链（拷贝补丁包 2 个 + 自研客户端插件 6 个 + 宿主包 4 个）

- pnpm + `vendor/harness-packages` 符号链接（外部 dsh 源码，**永不修改**）；要改的包必须拷入本仓 `packages/`。
- 拷贝补丁包（保持官方包名 `@deepseek-ai/*`，遮蔽 vendor workspace 条目）：
  - `packages/dsh-client-connection/`——base 路径参数化补丁：`apply(ctx)` 从每个 `AppWebEntry` 私有 Context 的 `chamberBasePath` 一次解析不可变 prefix，传给 HTTP unary、两条 WebSocket downlink 与 generic RPC/Typert carrier；页面 transport 覆盖 HTTP/WS 时 generic RPC 仍取同一 prefix 与该 transport 的 fetch。未配置时保持官方 web 兼容顺序（legacy `window.__DSH_BASE_PATH__`，再回落空 prefix 直连 `/api`），chamber 运行链不再写该全局。接缝由 `test:connection` 的 client-apply / carrier-assembly 行为门与独立 `typecheck:connection` 源码门固定，不能只靠字符串/AST 检查；**连接层职责边界**：
    ① **连接层是 push 通道（`/api/remote.mux`）的唯一重开者**——控制面/桌面各层只「发现」（心跳/探针/相位/看门狗）与「撤销或重注册传输」，从不重开流；mux 客户端（`dsh-api-gateway`）无退避，重试节拍由连接循环的 `onReconnectRequested` 驱动。
    ② **禁止同实例 `stop()+start()`**：上游 `reconnect()` 已覆盖立即重连且无第二泵循环；若重新引入 stop+start，必须恢复代际守卫（`loopEpoch` 语义）。
    ③ **每来源恢复时序**由 `recovery-policy.ts` 决定，经上游支持的 `connection.start(sinks, config)` 传入（远端 ssh/http 45s 就绪期限 / 5s 告警；本地与未知来源保持上游 15s/3s）——页面拿不到宿主注入的 `__DSH_CONNECTION_RECOVERY__` 全局，故不依赖页面级配置。
    ④ 活性触发集合 = `system-resume`（**旁路离线门**，见 design 14 D4）+ `online` + 隐藏 ≥30s 回前台（两者受离线门约束），共享 10s 去抖；
  - `packages/dsh-client-web/`——`boot.ts` N-ctx 模块表共享 seam + 公开 `runtimeCtx` getter（实例 shell 打开会话的 seam）+ `configureContext` 同步注入 seam + 可等待的异步 `dispose()`。真实 `AppWebEntry.run()` 的 Context 注入顺序由 `test:client-web` 的 configure-context boot 用例固定。
- 自研插件包（`@dsh-chamber/*` 前缀，替换/扩展官方插件注册）：
  - `packages/dsh-chamber-client-ui-sidebar/`——**自研侧边栏插件**（包名 `@dsh-chamber/dsh-chamber-client-ui-sidebar`，照官方 ui-sidebar 结构改造：保留几何/折叠/孔位声明，会话区改多来源统一列表）+ `shared/aggregate-store.ts`(chamberBridge)+ `shared/instance-api.ts`（每实例 unary 客户端，App 层与插件共享一份，vite 共享 chunk）；
  - `packages/dsh-chamber-client-ui-settings-connections/`——自研连接设置插件（§5，连接页固定入口 `__connections` 的字典命名空间与分节组件）；
  - `packages/dsh-chamber-client-ui-settings-bridge/`——自研设置壳插件（§5）：注册进 `sidebar.settings` 槽，以 `SETTINGS_SHELL_SHADOW_PRIORITY = -1000` shadow 官方 SettingsRoot；服务器下拉渲染选中来源自己 boot ctx 的 `settings.section` 台账，条目用该 ctx 渲染器绑定的标准座。面所有权绑定 `(sourceId, sourceFingerprint)`：权威 roster 删除来源或同 id 换 proof 时旧面立即不可渲染（face 指纹与 roster 同字段相等才渲染），来源重 boot 由新 ctx 的 `apply` 重新发布；发布/撤除按 slots/locale 身份校验，迟到旧代撤除不清新代的面。
  - `packages/dsh-chamber-client-ui-layout/`——官方 ui-layout 壳插件的 chamber fork：①替换 layout store，`sidebarWidth` 经侧边栏共享 view-prefs store 播种/回写并钳位 [264,420]、覆盖 id；②**文档级主题投影的唯一写入者**，全页单例 `ThemePresenter` + 按活动视图门控的 `document-theme.ts`（见设计 06 §4.6），替换官方 ui-layout 注册。
  - `packages/dsh-chamber-client-ui-git/`——设计 08 的内建 Git Worktree 插件：占 per-workspace 座位 `sidebar.workspace.git`，页面级 singleton 以 30s 单飞读各实例 topology，编排 create/workspace/session 与 Git-first remove saga；Git 事实不进 App aggregate，也不暴露任意 argv/path mutation。
  - `packages/dsh-chamber-client-ui-open-in/`——设计 16/20 的内建桌面打开插件（**2026-09-11 用户裁决：fork & supersede**）：占 `conversation.session.header.utilities`，按当前 N-ctx 的 source 经 per-source 视图模型选入口——**本地**来源走**实例进程内的 chamber host 包**（`@dsh-chamber/dsh-chamber-seed-open-in`）+ 桌面主进程 VS Code 覆盖项；**远程 ssh** 来源只有主进程 VS Code Remote（trusted IPC + 来源代 proof）；http/未知来源无入口。官方客户端行沿用 page-own 跳过纪律（本 fork **替换**官方注册），官方宿主行保持挂载但永不被调用；无控制面执行面（主进程已收窄为 vscode-only，见设计 20 §2.2/§4）。
- 自研宿主包（随 chamber 分发、运行于每个 dsh 实例进程）：
  - `packages/dsh-chamber-seed-client-graph/`——设计 09 的只读 client boot graph Remote；
  - `packages/dsh-chamber-seed-git-worktree/`——设计 08 的领域限定 Git Remote，与该实例 `workspaceRegistry`/live agents 同用户、同文件系统做权威守卫；Desktop 与控制面均不执行 Git。
  - `packages/dsh-chamber-seed-archive-cleanup/`——设计 24 的已归档会话内容清理域（`archiveCleanup/{preview,purge}`，AGENTS 登记的有界例外）：实例进程内经宿主权威状态 children-first 级联清除归档集内容（含 subagent 起源后代、官方事件发射），只删不读、绝不触碰运行中/未归档内容；上游 delete wire 落地后退役。
  - `packages/dsh-chamber-seed-open-in/`——**设计 20 §6（本地形态专用，`localOnly`）**：上游 `dsh-host-open-in-app` 宿主半的 fork（本机应用目录 + 真实 bundle 图标 + 绝对目录校验 + 拉起，`openInApp/{probe,apps,icon,open}`），删去上游 SSH 休眠门、`webServer` 路由与连接栅栏（改走实例自身通用 RPC 通道）；不读启动标记，与目录选择 pin 解耦。
- 前端入口复用 `packages/renderer/`：vite 构建时把 workspace 包 alias 到源码；`chamber-entry.ts` 复合 entry 挂整棵 dsh 客户端树（connection→typert→
  gateway→remotes→runtime→locale→theme→**layout（chamber ui-layout fork 替换
  官方注册）**→**chamber 侧边栏（替换官方）**→**Git Worktree 插件**→
  **open-in 插件**→settings×4→conversation→…→全量 ui-*）。
- **启动图清单 = 单 entry + 每实例宿主图额外 entry（设计 09）**：
  - 页面清单 `__DSH_BOOT__` = `{rev, entries:[{id, url, rev, immediately?}]}`（wire 契约以 vendor `dsh-client-modules/src/client/manifest.ts` 为权威）；构建期写死**单 entry**（`@dsh-chamber/app` chamber composite bundle），bundle = vite 产物 `/assets/chamber-<hash>.js?rev=<rev>`。构建链 =
    gen-typert-remotes → vite build → gen-boot-manifest。
  - **每实例宿主图额外 entry（设计 09，2026-08 落地）**：boot 时经反代（`/api/i/<id>`）调 chamber host 包 `@dsh-chamber/dsh-chamber-seed-client-graph` 的 Remote `clientGraph/graph` 取该实例宿主组合的客户端插件 boot 图，按 `CHAMBER_COVERED_IDS`（`packages/renderer/src/chamber-covered.ts`：复合已覆盖 + 页面自有 id）去重，预加载剩余 bundle（`/api/i/<id>/plugins/<pkg>/client.js?rev=…`），经 boot.ts `extraRows` seam 合并进 boot rows（详见设计 09）。
  - **host 包与 seed（设计 08/09/20/24）**：`packages/dsh-chamber-seed-client-graph`、`packages/dsh-chamber-seed-git-worktree`、`packages/dsh-chamber-seed-archive-cleanup` 与 `packages/dsh-chamber-seed-open-in`（后者 `localOnly`：只 seed 进本地 profile，不进远端 seed、不随 gateway 上传，插件页仅在本地目标列出该行；非本地目标的行集 = 该目标适用行，design 20 §6）都提交 esbuild `dist/index.js`（`@deepseek-ai/*` external）；控制面 `host-graph-seed.ts` 幂等 seed 所有已构建包进 `$DSH_HOME/profiles/web/node_modules/@dsh-chamber/*/`，把 `client-graph` / `git-worktree` / `archive-cleanup` / `open-in` insert 合并到单一 `<stateDir>/dsh-chamber-graph.patch.yml`。每次 spawn 注入同一 `--patch`（`webProfileArgs(port, patchPath?)`）；任一产物缺失只跳过对应行，不产生悬空 insert。远程 ready-time seed 同样一次探测/一次 overlay 合并写，见设计 13。

## 7. 控制面 / 桌面契约（无认证面）

### 7.1 代理路径（唯一入口面）

- `/api/i/local/*` → 本地实例；`/api/i/dsh-<id>/*` → 该实例隧道
  （ssh-<id> legacy 段）；`/api/i/gateway-<id>/*` → 该 gateway（隧道/直连端点，认证头由主进程注入，17 §9.3）。
- HTTP 全量透传（响应头白名单收敛）、WS upgrade（events.mux/events.host）、SSE 直通；路径剥前缀转发；**v1 无认证边界**（loopback-only，03 §3.2）。
- 无隧道（phase != ready）→ 503 明确错误。

### 7.2 REST（管理面）

- `GET /health`、`GET/POST/PATCH/DELETE /api/connections`（local）、`GET /api/host/logs`；认证/审计路由与模块已在 v1 移除。

### 7.3 PlaneHandle

`{start(), stop(), startLocal(), localProcessAlive(), port, connectionState,
instanceId}` +
`restartLocal()`（design 18 §9.3 事务化用户重启：与健康状态机重启单飞行
串行化、canStartLocal 门控、restart-exhausted 窗口共享）+
`refreshLocalExposure()`（重新发布本地公共快照，供事务后解除 quarantine）+
`registerInstanceTransport(connectionId, baseUrl)` /
`unregisterInstanceTransport(connectionId)`（隧道 ready/断开时主进程上报
`${kind}:<id>` → baseUrl——ssh 隧道 = loopback http origin；http 直连 =
用户配置的 http(s) origin；connectionId 由 kind 派生
（`dsh:<id>` / `gateway:<id>`，17 §9.3））；`webDistDir?` 静态服务
（`/`、`/assets/*`、`/manifest.json`、index.html 注入 `__DSH_BOOT__`）。

### 7.4 IPC（preload 白名单；插件编排面见设计 13）

- `dsh-chamber:info`；`desktop_ssh_instances_get`（spec v2：kind/transport/insecureHttp、sshPort、serviceName 与 remoteDshHome，03 §2.2）、`desktop_ssh_save_connection`（元数据 + SSH password + gateway token/password 的 crash-safe 主进程原子/补偿事务；write-only 旧值仅主进程快照，renderer 不可读）、`desktop_ssh_delete_connection(id)`（精确 id-addressed 主进程删除事务；不存在 id 即幂等 no-op）、legacy `desktop_ssh_instances_set`（仅接受与当前规范化 roster 同长度、同顺序、逐字段全同的 exact no-op；删除/add/edit/reorder 一律拒绝）；三个单项 credential setter 仅接受显式 clear；add/edit/delete/非空凭据写不得绕过各自主进程事务；`desktop_ssh_config_list`（`~/.ssh/config` 非秘密投影）、`desktop_ssh_connect/disconnect/status/logs/logs_clear`、`desktop_ssh_start_service/stop_service/is_active/restart_service`（固定参数数组 `systemctl <action> -- <serviceName>`，serviceName 白名单 `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`、首字符必须为字母或数字）；
- gateway 凭据（write-only，design 17 §9.1/§7.2/§12）：表单瞬时收集，以 write-only 字段经 `desktop_ssh_save_connection` 转主进程（内存持有 + `<userData>/gateway-secrets.json` 0600 原子写、safeStorage 加密 blob 优先，17 §12）；永不返回 renderer、不进注册表/日志，删除实例或显式清除即删；只注入已注册 gateway transport 的 0..2 白名单头（§8 / 17 §9.3）；
- chamber 设置面（设计 14 D7，chamber 全局非秘密运行设置）：`dsh-chamber:settings-get`（查询当前设置 + 平台能力门控）、`dsh-chamber:settings-set`（应用并持久化 `<userData>/chamber-settings.json`，失败 loud `{error}`，绝不落半个设置）、推送 `dsh-chamber:settings-changed` / `dsh-chamber:system-resume`（OS 唤醒，载荷 `{timestamp}`，渲染端立即重连——设计 14 D4）；设计 19 的 notifications 嵌套设置仍属该 chamber 全局面，不进任何实例配置平面；
- 桌面 open-in 面（设计 16/20；主进程为 vscode-only）：`dsh-chamber:open-in-apps`（本机 app 能力协商，非秘密投影，现只投影 vscode）与 `dsh-chamber:open-in`（appId/instanceId/path/sourceFingerprint 主进程统一校验后拉起 VS Code；本地文件管理器等应用走实例官方宿主路由，不经该 IPC）。`sourceFingerprint` 为主进程内存签发、随 roster 投影的非秘密 opaque proof（local 固定为 `local`，远程 64 位小写十六进制），renderer 不得自行构造；主进程在接受请求、异步宿主调用边界及排入 renderer intent 前复验精确来源所有权，旧 shell 按钮不能操作同 id replacement。app 能力首次真实 IPC reject 在同一 page-wide single-flight 内最多 3 次、间隔 500ms，最终仍 fail-closed；vscode 成功 intent 进入 64 上限有界 ACK 队列，push 携带 `{instanceId,path,sourceFingerprint,deliveryId,attempt}`，send 只转 in-flight；renderer 完成或有意放弃激活后按精确 deliveryId+attempt ACK，reload/crash 重发未 ACK 项，旧 attempt 或旧 proof 不得提交 replacement。renderer 先注册 `dsh-chamber:deep-link-intent` 监听、再 invoke `dsh-chamber:deep-link-ready` 才放行（握手失败 5×500ms 有界重试）；主进程 send 抛错把失败项 rollback 到未发送队首、保持 key 在途与 FIFO/去重，仅失败的当前窗口可撤销 ready；远程激活在 renderer 等当前 generation 权威 roster + proof，期间单槽 last-intent-wins（被替换的旧 delivery 也须 ACK），目标权威缺失或 proof 过期才 loud 丢弃；激活失败不回滚已完成的本机拉起；
- 桌面原生通知面（设计 19 受限 carve-out，无通知中心/历史/控制面 runtime）：`dsh-chamber:notify`（严格 `local | dsh-<raw-id> | gateway-<raw-id>` 规范来源，仅为迁移兼容接受 legacy `ssh-<raw-id>`；事件/文本/长度白名单后由主进程按设置与焦点裁决；请求必须携带与当前来源代匹配的 `sourceFingerprint`）+ `dsh-chamber:notifications-ready` 握手 + `dsh-chamber:notification-open` push。click payload 在主进程用 64 上限 FIFO hold；每条 push 携带 `{sourceId,sourceFingerprint,sessionId,deliveryId,attempt}`；send 只转 in-flight，renderer 完成路由或有意丢弃后用精确 deliveryId+attempt ACK 才消费；send 失败只回滚当前项；reload/crash 把未 ACK 项按 FIFO 重发，旧 attempt ACK 无效；renderer listener-before-ready（5×500ms 有界重握手）后仍以 proof + 当前 generation 权威 roster 作二级门，权威缺失或 proof 过期才逐项 loud 丢弃；
- 插件同步面（设计 13，远端 dsh plugin 编排经 provider exec 通道，spec 白名单见 13 §7.2）：`desktop_ssh_plugin_list/plugin_apply`（add/remove/restart，restart 需布尔值）、`desktop_local_plugin_list/add/remove`（本地实例插件）、`desktop_npm_search`（npm 搜索，best-effort）、`desktop_ssh_seed_host_graph`（远端 seed 宿主包）、`desktop_ssh_plugin_materialize_add` 与 `desktop_ssh_plugin_materialize_add_pick`（本地路径包物化：主进程 pick 目录 → pack → ssh 传输 → 远端 `add file:`；renderer 不提供路径）、`desktop_gateway_plugin_materialize`（gateway 侧同款主进程 pick + 直推）；
- `desktop_ssh_status_changed` 推送（隧道相位即时投影）、`desktop_ssh_instances_changed` 推送（载荷 `{removedIds,retiredIds}`；`removedIds` 仅物理删除，`retiredIds` = 删除 + 传输身份编辑，renderer 先同步退役旧来源代再重拉 roster；另有 30s 轮询兜底）。
- 传输 URL 永不进 renderer；renderer 只见 localPort/phase 投影（含 `kind`）。
- 所有 invoke（含 `dsh-chamber:info` / `desktop_ssh_*` / chamber settings / `dsh-chamber:open-in-apps` / `dsh-chamber:open-in` / `dsh-chamber:deep-link-ready` / `dsh-chamber:notify` / `dsh-chamber:notifications-ready`）须同时满足：sender 为当前主窗口 WebContents、senderFrame 为其 mainFrame、frame URL 精确属于当前控制面 origin；否则抛 `ipc_sender_forbidden`。窗口拒绝新窗口，并在 `will-navigate` / `will-redirect` 阶段阻断离开控制面 origin，防止 preload 主机能力暴露给被导航页面。

### 7.5 本地实例

- `--profile web --host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>`（浏览器信任栅栏）；端口占用重试/pid 记录/instance-id 仲裁/resolveDshEntry 保留；node 可执行经 resolveNodeExecutable 解析（Electron → execPath + ELECTRON_RUN_AS_NODE + `--expose-internals`，见 02 §3.1）。
- **桌面预启动（pre-spawn）**：主进程在窗口加载前调用 `PlaneHandle.startLocal()`（与 renderer 的 POST /api/connections 同一幂等路径，绝不重复 spawn）——spawn 数秒与页面/bundle 加载重叠、首屏即 ready；失败非致命（renderer 仍会自行尝试，实例错误态照常呈现）。CLI/standalone 形态不预启动（控制面契约保持按需 spawn）。

### 7.6 TransportProvider 契约（来源无关抽象，双 transport provider）

- `transport-provider.ts` 定义 `TransportProvider`：`kind`、`validateSpec`（白名单收口，option-injection 安全）、`buildStartArgs`（**缺省 = direct endpoint 模式**：无子进程，运行时探测 `probeTarget()` 并暴露 `endpointUrl()`）、`classifyStderr`（整行分类：脱敏 + 终态认证判定）、可选 `verifyUp`（端点身份验证：TCP 探测通过、置 ready 前验证目标身份——dsh 用统一身份握手 `session/canOpenWorkspacePath`（固定小体积 boolean；老 runtime 树 404 → signature 路径回退 legacy `session/list`，识别为 "check or upgrade"），与本地 02 §3.2 同判据；gateway 用认证后 `/chamber/runtime/status` 固定 identity，使 managed dsh blocked/down 时恢复面仍可达；非目标服务端口绝不呈现已连接）、可选 `exec`（远程服务通道）。
- `transport-manager.ts` 是通用运行时：phase 机 / **两段式重连**（有界半开 jitter 退避突发 + 耗尽后慢速周期重探；error 绝不停摆，条件修复自动恢复；手动 connect/disconnect 取消在途重探）/ 环形日志 / 非秘密投影与推送 / 子进程监督（SIGTERM→SIGKILL per-child）/ 注册表（kind 迁移、重复 id 首胜丢弃）/ 就绪探测（隧道端口或直连端点 + 端点身份验证）。就绪判据（TCP + 目标身份握手）、两段式重连与 `verifyUp` **确定性验证失败免重试**（`terminal` 分类：目标应答了探测但证明不是兼容 dsh → 第一次失败即落 error 终态，仅瞬时失败走重连）的机制细节见 03 §2.2。**子进程加固**：exec 与隧道子进程同款 SIGTERM→SIGKILL 升级，`disposeAsync` 等待两者全部退出（SIGTERM 忽略型 ssh exec 不残留孤儿）；本地端口分配瞬时失败（临时端口耗尽）进入慢速周期重探，不停在 error。
- registry 编辑以 transport + exec generation 隔离旧异步工作：`serviceName` 与 `remoteDshHome` 同属 live transport fields 与 exec identity，变化时先提升 generation/`execEpoch`，撤销旧隧道/直连尝试与所有 exec child（SIGTERM→SIGKILL），
  旧连接原先非 idle 才以新参数重启；多步 exec 下一次 spawn 以及迟到日志、状态投影、`serviceActive`/结果提交前均复验 generation，旧代工作不得污染新配置。
- `ssh-provider.ts` 与 `gateway-provider.ts` 是两个 transport provider（按 transport 注册，17 §2.2/§9.2）：`ssh-provider.ts` 实现 `ssh`(`ssh -N -o ServerAliveInterval=30 -o
  ServerAliveCountMax=3 [-p <sshPort>] -L <localPort>:127.0.0.1:<remotePort>`
  隧道 + systemctl exec；认证特征/脱敏/白名单全在 provider 内)；`gateway-provider.ts` 实现 `http`（direct endpoint 直连，无子进程：端点 = 目标 http(s) URL，scheme 由 `insecureHttp` 决定，两种 kind 都服务——dsh 目标不注入认证头、gateway 目标按 spec kind 可注入 `Authorization`，17 §2.1/§9.2）。
- **exec 通道（设计 13）**：`TransportExecPayload.op` 为 `'exec'`（systemctl `start/stop/is-active/restart`、远端命令 `run`——命令名白名单 `dsh|cat|printf` + argv/路径白名单 + shell 元字符拒绝（`base64 -d`/`mkdir -p` 仅存在于固定 write-file 管线，不是可分发命令），见 13 §7.2）或 `'write-file'`（stdin base64 流式写 + **字节域** SHA-256 回读校验 + 目标前缀白名单 + **50MiB 大小上限**）。白名单 `exec` 结果同时携带 stdout（UTF-8 视图）与 stdoutBytes（原始 Buffer）；`write-file` 回读直接流式计算 SHA-256，成功仅返回 status，不在主进程保留整份回读。plugin-sync 编排（apply/seed/materialize）全部经此通道，spec 在主进程二次白名单校验（applyPlugins + buildRemoteExecArgv）；materialize 的 `add file:` 走独立的目录约束白名单分支（仅物化目录内绝对路径）。
- 新来源接入 = 新 provider + kind 注册；运行时/UI 按 `kind` 分支即接。反代路径段按 kind 派生（connectionId `${kind}:${id}` → `/api/i/dsh-<id>` / `/api/i/gateway-<id>`，`ssh-` legacy 映射保留，17 §9.3）；renderer 侧 base-path 构造（dsh-client-connection base-path patch）随 kind 同步。边界：tailscale 等网络层身份只是网络层访问控制，不构成 dsh 应用层认证面（v1 无认证边界不变；gateway 目标的认证由注册 transport 头注入承载，17 §9.3）。

### 7.7 窗口生命周期与崩溃恢复

- **单窗口可重建**：窗口被关闭（macOS 红色按钮）后应用保持运行（darwin 的 `window-all-closed` 不退出）；`app.on('activate')`（Dock 图标点击）、`second-instance`、托盘「显示窗口」统一走 `showMainWindow()`——窗口不存在时按控制面 origin 重建（`createMainWindow`；启动期加载失败仍为大声失败 + 退出，重建路径只记录不退出）。
- **渲染进程有界自动恢复**：`render-process-gone`（clean-exit 除外）或 15s 无响应 → 60s 窗口内至多重载 3 次，超出显示错误框停止自动恢复——绝不静默白屏；会话数据在实例侧，重载后前端自动重连恢复。
- **崩溃留痕**：`crashReporter`（`uploadToServer:false`）落盘 `<userData>/Crashpad`；GPU/Utility 异常退出经 `child-process-gone` 记日志。

## 8. 安全不变量

- 本节不变量与 `AGENTS.md`「Hard Facts」互为镜像（凭据纪律、loopback 边界），本节为契约正文。
- 前端只连 127.0.0.1（本地 dsh 端口或隧道 localPort），**任何实例流量不直接出网（限定 renderer）**——renderer 只见非秘密投影，任何出网仅由主进程承载；**gateway http 直连例外**：直连端点为用户配置的 http(s) origin，由主进程 transport 直接访问，renderer 仍只见 localPort/phase 投影（17 §9.3）；direct-endpoint provider 的端点 URL（`readyUrl`）同样只在主进程，永不进 renderer；
- 传输 URL 与**私密 SSH 材料**（凭据/私钥/代理配置/IdentityFile/ProxyCommand）永不进 renderer/日志/持久层——renderer 只见 host/user/端口等**非秘密元数据投影**与 localPort/phase；ssh stderr 含密钥路径的行入环前脱敏（按行缓冲，跨 chunk 不绕过）；分类器单行上限 64KiB，脱敏/分类后保留进每实例 200 行 ring 的展示文本再裁到 4KiB，避免 32 个实例按 64KiB/行放大驻留内存；
- **可选密码认证（唯一例外，用户需求；明文文件兜底——用户决策）**：表单密码为瞬时输入（编辑时永不回填），经 `desktop_ssh_save_connection` 转发后主进程**内存持有 + 明文镜像 `<userData>/ssh-passwords.json`**（0600、`.tmp`+fsync+rename 原子写；残留 `.tmp` 无论原 mode 为何都先 fchmod 0600 再写秘密；写成功后才发布内存状态、启动时严格校验 schema；现存文件先 no-follow/普通文件/inode 校验，以打开 fd 收紧 0600 后才读取——密码主机重启后自动连接可用；损坏/结构非法文件保留为 `*.corrupt` 并响亮报告，绝不静默当空集）。保存收敛为主进程 `desktop_ssh_save_connection` 单事务：registry 与三类 write-only 凭据先拍快照、按目标域验证并提交，任一步失败补偿恢复全部旧值；补偿失败安全 scrub 相关凭据且响亮返回，renderer 不再靠串联 setter 假装可回滚。SSH 镜像 schema v2 把每个值绑定 `host+user+sshPort` 并在读取/注入时复验当前 registry；secret 先落盘、registry 后落盘的崩溃只会失去可用性，不会把新口令发给旧 SSH endpoint。非空 legacy schema v1 无法安全证明目标，移动为唯一 `.unbound-*` 恢复文件并要求重录；新增/进入/离开/retarget 即使留空也强制清理隐藏的半事务值。删除只走精确 `desktop_ssh_delete_connection(id)`：先停活连接、撤销 exact connection-target scope 的 gateway 会话、清 durable secrets，最后删 metadata；不存在 id 为幂等 no-op；legacy `instances_set` 只能原样提交当前规范化 roster，不能删除；永不进注册表、永不记日志，实例删除/显式清除即删条目。隧道与 systemd exec 经 `SSH_ASKPASS_REQUIRE=force` + 临时 owner-only 0700 askpass 助手（OpenSSH 直接执行该脚本；助手位于 `mkdtemp` 创建的每进程不可猜 0700 私有目录，目录必须为当前 uid 的普通目录且 inode/mode 复验通过；历史全局 `<tmp>/dsh-chamber-ssh` 永不用于写入，EPERM/属主异常 fail closed，不在他人可替换目录继续；`<tmp>/dsh-chamber-ssh-<pid>-<random>/askpass-<id>.pid-<pid>.<uuid>.sh`。每次 tunnel/systemd/run spawn 独占一个 lease，真实 child 的 exit/error/spawn-fail 才释放并删除对应 helper；disconnect/removal/显式 clear 先阻止新 lease 并请求 purge，仍被 child 引用的文件延迟到引用归零，绝不用固定代际上限提前删在途 helper。异常进程退出后的残留由下一次启动清理；启动清理仅删已退出进程或旧格式遗留，绝不误删并行 dev/打包实例的助手）把密码喂给系统 ssh
  ——**永不上命令行**；助手按提示文本区分「主机密钥确认 → yes」与「密码/
口令 → 密码」，首次连接无需预先接受主机密钥。无可靠 askpass 的平台（v1 的 Windows：Win32-OpenSSH 助手须为 PE 可执行）在 `desktop_ssh_save_connection` IPC 门禁处**显式拒绝**（返回错误，绝不静默走重试死循环），密钥/agent 为通用路径。
- systemctl 以固定参数数组 `systemctl <action> -- <serviceName>` spawn（无 shell 拼接，`--` 终止 option 解析）+ serviceName 白名单 `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`（首字符必须为字母或数字）；
- 控制面 HTTP 监听仅 loopback——v1 无认证边界靠监听面与 HTTP/WS 来源门禁维持（Host 仅规范 loopback authority；Origin 仅限与当前 Host 精确同源或显式开发 allowlist，其他 localhost 端口也默认拒绝；`null` 一律拒绝；非法来源在副作用/转发前 403）；所有 HTTP 响应统一设置 CSP（`__DSH_BOOT__` 内联脚本使用逐响应随机 nonce，不开放 script `unsafe-inline`；`script-src` 开放 `unsafe-eval`——官方 dsh module loader（vendored `@deepseek-ai/loader`）对 boot manifest `__jsExpr` 配置求值依赖 `new Function(…eval…)`，缺它渲染层主包在模块求值期即抛 EvalError、静态骨架永不进入 React——实机排查确认）、`nosniff`、`DENY` frame、COOP 安全头。Referrer policy 用 `same-origin` 而非 no-referrer（no-referrer 下现代浏览器把同源表单提交的 Origin 序列化为 null，被本机来源门禁 fail-closed 拒掉——登录/运维表单自锁；这些页面无跨站出站文档请求，同源策略对第三方同样不外泄 Referer，隐私意图不变）。
- **gateway 凭据（design 17 v2 连接模型例外，同款 write-only 纪律）**：settings 表单可瞬时收集 gateway token/密码并经受信 IPC（新增/更新走 `desktop_ssh_save_connection`，单项 setter 只清除，§7.4）转发主进程；主进程仅内存持有 + `<userData>/gateway-secrets.json`（schema v3，0600 原子写，safeStorage 加密 blob 优先、不可用时 0600 明文回退，17 §12），永不返回 renderer、不进注册表/日志；只注入已注册 gateway transport 的 `Authorization`/`Cookie` 头（0..2 白名单，17 §9.3）。Cookie/session key = 网络 origin + `Host` authority + 稳定的 connection-target scope（connection id 与目标摘要）；authority 只负责路由、不是 ownership，故相同 origin 的不同 direct id、复用 localPort 的不同 SSH 目标也绝不共享 session。exact-scope invalidation 会提升每个历史 key 的 generation，并在登录、Cookie 探针、Bearer fallback、401 重登每次 await 后阻止旧结果改 cache/backoff/auth proof 或继续联网；refresh 另有按 id 的 arm/disarm/dispose epoch，并在重试、重注册、重连前复验密码/token/URL/pin/authority/scope，阻止同 id 重建的迟到结果。`configureGatewaySessionProvider` 的 `ensureSession` / `generation` / `registrationAuthProof` / `setRegistrationAuthProof` / `cachedCookie` / `invalidate` hooks 必须 all-or-none；ready 注册要求当前 generation 的 `cookie|bearer` auth proof，密码型目标若 Cookie 消失且没有已验证的 Bearer fallback 则 fail closed 重连，绝不无头注册。gateway+HTTPS 配置 SPKI pin 时，登录、探针及 HTTP/WS 反代在 peer SPKI 匹配前不调用请求 `write/end`，不发送 handshake/header/credential/body 等任何应用层字节；mismatch 显式失败。删除实例/显式清除即删凭据并撤销对应 scope。对应安全不变量 S22（safeStorage 加密落盘）/ S23（SPKI 证书固定）/ S24（审计只记非秘密事件）见 design 17 §17。

## 9. 范围边界（推迟与不做）

- **推迟（维持不排期）**：flat 单列表模式（与"仅按来源分类"呈现原则有张力）。
- 不做（v1）：跨来源移动会话、单 store 真融合（fork runtime）、会话实时推送同步、远程实例管理 UI 外壳。
- fork 会话**在范围内**：官方 conversation 回合尾 `forkAt` 常驻可用；侧边栏会话行 kebab 菜单亦提供行内 fork（wire `sessions.fork`，对齐官方 ui-workspace），两者并存（§2.2）。
- **残余（本版不消除）**：租客 **body portal** 浮层（官方 ui-chat 4 处 `createPortal` + chamber 2 处，z-index ≤1100）渲染到文档 body，位于**任何 stacking 边界之外**——遮罩期内这类浮层仍可能可见；顶层幕布可压过它，但会覆盖全部视图与 chamber chrome（§4 已否）。登记而非修复。
- **推迟**：每实例**进程 / 视图隔离**（Electron `WebContentsView` / 独立 WKWebView）——只有它能同时消除"一个壳的长任务卡住整页"；当前 N-ctx 规模下代价不成比例（实测整页渲染进程 ≈9.2MB vs 单视图进程基线数十 MB），仅在来源规模或隔离需求变化时再评估。
- **推迟**：多壳常驻策略放宽（保留位 1 → 3 / 粘性常驻 + 压力淘汰）——渲染端内存实测不构成约束（整页 9.2MB / 峰值 40MB），约束在主线程与后台流；需先有帧时/权重预算的度量面，本版不做。
- **残余（本版不消除）**：相位观察器的成本面——持有窗内用 `MutationObserver({subtree, childList, attributes, attributeFilter:[data-phase]})` + 一帧 rAF 节流；`characterData` 未开（流式 token 不产生记录），但虚拟列表插入/替换行仍会按帧产生 childList 记录，而窗口上界 70s。同仓移动插件 `session-stall.ts` 以"官方 DOM 在会话加载期产生上千次变更"为由改用 3s 轮询，是本设计的反证。判定 API 与观察器解耦（leaf 是纯函数），若实机长持有出现掉帧，第一刀是把采样降为 250ms 轮询（相位是粗状态，多 250ms 延迟无感）。失效判据：改成轮询后删除本条。
- **残余（本版不消除）**："首访某个来源"的冷 boot 白屏（该来源从未挂载 ⇒ 必须付一次 boot + 遮罩）：不做启动时全量预挂载（启动风暴），只能由 P3 把遮罩压到"会话面绘制后一帧"、以及既有预热槽缓解。失效判据：若引入"全部来源常驻"策略，本残余随之消失，需同步删除本条。
