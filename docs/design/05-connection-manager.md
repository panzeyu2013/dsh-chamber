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
- 分组结构：来源分组（标签 + 连接状态色点/转圈——ready 绿点、error/
  stopped 红点、idle/unknown 灰点、connecting/starting/restarting/degraded
  统一转圈——重试周期折叠为稳定「重连中」态，主界面不因每次重试尝试在
  转圈/色点间闪烁；状态一律纯图标，相位文本仅在 hover/aria 呈现，无恒显
  文字、无状态文案）→ 该来源的
  workspace（组头）→ session 行（**嵌套缩进**于 workspace 之下）。未连接
  来源只显示分组头 + 状态点（无会话数据）。
- 会话行带**运行指示点**（相对时间列不显示——见 06 §4.3）。
- **当前来源的当前会话行高亮**（含所在 workspace 组着色）：当前会话 id 经
  运行时事实通道（`server.runtime?.current`，06 §4）——每个来源自己的 ctx
  上报自身 `sessions.list` 快照投影，任意来源均可达，组件不订阅任何 store。
- workspace 组可**折叠**（组头 chevron + 会话数徽标）：折叠态持久化于
  localStorage 视图偏好（`dsh-chamber.sidebar.v1`，06 §3——共享实时存储，
  跨 ctx 实时联动）。
- 不属任何 workspace 的游离会话落在来源末位合成的"未分组"桶（仅会话行，
  无 workspace 操作）；subagent 来源的子会话不进入导航列表；blank 会话按
  官方 `(!blank || current)` 规则——**活动来源的当前空白"新会话"行进入
  导航列表**（以 New Session 标签呈现；仅活动来源投影，与其他来源当前
  会话视觉的 06 §4.3 全局单选门控一致），其余空白行不入列表。
- 已连接来源的聚合拉取失败时以错误行呈现（不冒充"无工作区"）；全部来源
  断开时显示空态提示。
- 保留官方侧边栏的：logo 行、New Session（作用于当前活动来源）、折叠
  （wide/rail）状态机、foot（footer.action + settings 孔位）。
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
- **归档会话确认后立即从列表消失**：`archivedSessionIds` 过滤在 derive 层
  （`shared/derive.ts` 纯函数），不等聚合轮询。
- 会话行悬停操作（v1 最小集，走该来源自己的 API）：重命名/归档/**fork**
  （kebab 菜单 + 独立归档按钮）——行内 fork 走 wire `sessions.fork` + 标题
  递增（increaseTitle，对齐官方 ui-workspace），成功后打开子会话，递增
  rename 失败非致命（子会话仍创建并打开）；官方 conversation 回合尾部的
  `turn-tail forkAt` 常驻可用，两者并存。workspace 行：新建会话（`+` 按钮，在该
  workspace 下创建并打开）、重命名、删除（kebab 菜单）。wire 缺失的
  方法不做（如删除会话），不发明协议——**design 24 受界例外**（2026-12
  用户批准，AGENTS 已登记）：来源头 hover 簇新增「删除已归档内容」动作，
  走 chamber 自有宿主域 `archiveCleanup/{preview,purge}`（design 24 引入的宿主包，
  实例进程内权威清除归档集内容含 subagent 级联；只删不读、运行中整棵
  跳过、幂等；域缺失 404 给诚实文案；host binding 已按 design 24 §10 的 vendor
  核对结论落地，见 `packages/dsh-chamber-seed-archive-cleanup/src/binding.ts`）。
  详见 design 24 与 §6 宿主包清单。
- 已连接来源提供"新建工作区"（来源头部 `+` 按钮）：打开该来源的应用内
  目录浏览对话框（§4
  同一 browse 表面，不做手敲路径表单），确认的路径走该来源的
  workspace.create（路径须为该实例宿主上已存在的目录；远程路径 = 远端
  服务器路径）。
- 悬停操作与新建工作区成功后，经 chamberBridge.requestRefresh(sourceId)
  立即重拉该来源聚合（v1 轮询 + 操作后刷新）。
- **交互面扩展（详见 06）**：来源头 hover 操作簇提供**会话排序
  切换**（显式排序菜单——官方 ViewOptionsMenu 模式，勾选标记当前模式，
  取代盲切循环，06 §2.2）；workspace 头/会话行**双击重命名**
  （会话行单击立即打开、二次点击进入重命名，06 §2.2）；workspace 头/会话行
  悬停显示**信息卡片**（标题/会话数/相对时间/状态点/复制标题，06 §7）。
- New Session → 当前活动来源新建会话。

#### 2.2.1 打开意图与工作区回声（2026-12 修订；两项真机反馈）

> 背景：N-ctx 下"用户意图"比官方运行时的默认收敛**到得晚**，两条真实反馈都由
> 此产生：①切到远程 server 的会话时先闪出一个"新会话"；②在某来源上新建工作区
> 后不立刻出现，必须手动点一下那个服务器。

**打开意图（open intent）= 唯一事实源**：`App.openSession` 是所有打开路径的唯一
漏斗（侧栏点击、通知点击、深链、待办条、git 插件）。它在切视图**之前** arm 一条
意图、在本次 open settle（成功或终态失败）后**按 sessionId 守卫地**释放——守卫
保证"点 X 后马上点 Y"时 X 的迟到 `finally` 不撤掉 Y 的闸门。意图槽位是
**跨 ctx 单例**（`packages/dsh-chamber-client-ui-sidebar/src/shared/open-intent.ts`，
与 `pending-click.ts` 同款：目标实例自己的 ctx 内也要读它），App 经
`useSyncExternalStore` 绑定。它同时驱动三道闸门：

1. **投影门**：意图在途**且该来源的 current 不是请求的那个会话**时，该来源不投影
   `runtimeFacts.current`（`projectableCurrent`）。否则冷 boot 期间官方初始导航策略
   给自己选中的 blank 会话会被投影成一行高亮的"新会话"（06 §4.3 的 `(!blank ||
   current)` 规则），下一次分发后又消失——正是①的可见形态。**幂等重开不受影响**：
   `current` 已经是要打开的那个会话时投影本就正确，为一次分发把高亮摘掉再装回去是
   纯闪烁、零信息（`pending !== current` 才抑制）。
2. **揭示门**：壳体**显示的会话不是请求的那个**时，目标视图的 boot 遮罩在干净
   settle 之后继续保留（`shouldHoldViewVeil`，App 判定后把布尔值交给
   `InstanceView` 合成 `!settled || holdVeil`）。两个输入只有 App 有：壳状态镜像
   （settled/failed）与**原始** runtime current（投影门要隐藏的正是那个值，所以绝不
   能从投影结果反推）。三条边界：
   - 壳失败 ⇒ 永不持有（失败呈现归 App 覆盖层；也避免一个排在永不 settle 的 boot
     后面的 open 把遮罩按 68s 队列预算钉住）；
   - 已经显示请求会话 ⇒ 不遮（幂等重开；或 boot 期早开臂已抢先——此时 settle 即揭幕，
     比等 App 分发更快）；
   - 遮罩生命周期由 open 请求自身界定（dispatch 8s 预算 + App 的 `finally` 释放），
     不存在挂死的加载层；**不会**因为"有在途 open"就给一个已经渲染好的温壳盖遮罩。
3. **boot 期早开臂**：目标 ctx 内的侧栏插件读**活**意图，在 sessions 列表可寻址
   的瞬间调用本 ctx 的 `sessions.open`
   （`packages/dsh-chamber-client-ui-sidebar/src/client/early-open.ts`：预算 8s、
   50ms 节奏、按 id 探针（不物化 id 集合）、一次成功即退位、绝不自行上报终态——
   终态报告归 App 分发）。
   它抢的是官方 `UiWorkspaceService.watchNavigation()` 的初始导航策略：该策略
   需要 workspace + session **两条**基线 ready 才会"复用或新建（宿主侧
   `session.create`！）blank 会话并打开"，而本臂只需要 session 列表。
   **诚实边界**：因此它只在 workspace follow 基线晚于 session 列表时取胜（隧道下
   常见但**不保证**）；策略已先落地时 blank 会话已在宿主上存在，挡住可见性的
   是上面两道闸门，而不是这条臂。
4. **被取代的请求不得再开**（`packages/renderer/src/shell.ts` 的
   `lastRequestedSession`）：同一来源的 open 请求是**最后意图胜出**流，而官方
   `sessions.open` 只是一次普通 select——一个用户已经离开的旧请求会把壳**翻回**
   旧会话。冷 boot 期两次点击同来源（X 后 Y）时两者都在队列里，settle 的 FIFO
   flush 会先开 X，而早开臂此时已经把 Y 打开了，于是可见 Y→X→Y 抖动。分发器
   因此丢弃被更新的请求：静默 resolve（被放弃不是失败，行内错误面归最新那次），
   记录随来源退役清除。首请求永远照常分发（记录为空时不判定）。

**工作区回声（workspace echo）**：侧栏在某来源上建好工作区后（unary
`workspace.create` 返回宿主 workspaceId），经 `chamberBridge.reportWorkspaceCreated`
上报，App 记入渲染端账本（不持久化 / 不轮询 / 不写宿主），并在**投影的唯一汇合点**
（`deriveServerWorkspaces` 之前套一层 `withWorkspaceEcho`）把该行并入。为什么
必须回声：未挂载来源只有 unary 兜底（工作区分组由会话 cwd 反推——**刚建的空
工作区没有任何会话，结构上不可见**），已推送来源的工作区集又被
`commitAggregatePull` 的 mounted merge 冻结、且 `planAggregateRefreshes` 根本不再
unary 轮询它——所以新建后那次 `requestRefresh` 两条分支都刷不出这一行。回声
**不是第二事实源**：

- 权威行**按 id 胜出**，该 id 出现在挂载 push 里即从账本退休
  （`reconcilePendingWorkspaces`，在 ready 门**之前**执行：工作区身份来自该来源
  自己的 follow 基线，与聚合是否已提交无关）；
- **同 path 的合成组被原位替换**（真实 id 胜出；否则该目录一旦有会话就会渲染
  两行）；同 path 的真实行（别的 id）胜出且账本条目退休；
- 条目随来源生命周期 / TTL（10min）收敛（TTL 挂在三处时钟上：本次 create、权威
  push、以及未挂载来源唯一的 30s unary 兜底拉取）；回声行**不带 `synthetic`**——
  它的 id 是真的，工作区级动作照常可用。
- **替换的真实代价（已登记）**：换的是行的**身份**，因此按
  `sourceId/workspaceId` 键控的 per-workspace 视图偏好（折叠态、未分组序）不会跟随
  新 id——旧合成键留在存储里不再命中（渲染侧跳过未知 id，属既有已接受残渣），该组
  可能一次性由折叠变展开。纯外观、一次性，且换来的是"不会渲染同一目录两行"。
- **与 git 行的联动（顺带生效，非新机制）**：Git 插件本就按"投影里的工作区 id 集合
  变化"即时刷新（`workspaceKeyOf`——"新增/删除工作区必须立刻刷新，否则 git 行要等
  30s 轮询"），而它的取数是 unary（`/api/i/<id>/api/gitWorktree/*`，未挂载来源同样
  可用）。回声让投影的 id 集合发生变化，因此新建工作区的 **git 行也随之立即出现**，
  而不是等用户点开该来源。

**登记残余（本修订不解决）**：

- 未被早开臂抢先时，宿主上仍会留下一个 blank 会话（同一工作区复用，不增长；后台
  预热 / 基线收割 boot 本来也会各造一个）。根治需要上游把"当前会话选择"的持久化
  按 shell 作用域拆开——见 `docs/progress/todo/client-store-scoping-upstream.md`；
- 未挂载来源的**工作区集合**仍然只有"回声 + 挂载 push"两个来源：别处创建 / 改名 /
  删除的工作区、以及工作区**顺序**，仍要等该来源被挂载（用户点开）才收敛——这是
  §2.3 已登记的降级面；本修订刻意不引入"每次变更付一次后台 boot"的收敛臂。

### 2.3 数据纪律

- 会话/workspace 数据**只来自各实例自己的 API**（经 `/api/i/<id>/*` 同源
  unary：workspace.list / sessions.list 等），控制面不建会话索引、不消费宿主帧。
- 连接状态 = 非秘密投影（本地：控制面 /health；远程：desktopSsh status 推送），
  永不用持久化/推断值冒充。
- 数据节奏：**状态与已挂载来源聚合均走现有事件链**。本地 `/health` 由
  health-events EventSource 驱动；远程隧道相位走 onStatusChanged；每个已挂载
  ctx 订阅自己的 `sessions.list` + `workspaces.list`，两份 reconnect baseline
  均为 idle + ready 后经 chamberBridge 上报完整快照；任一 store 进入 loading/error
  即撤回旧快照并清除内容签名，使同内容 reconnect baseline 也重新上报。远端 ctx
  的 host frames 仍经既有 SSH 隧道/实例反代 WebSocket 到达，**不增加协议、不修改上游 dsh**。
- 只有未挂载或 reconnect baseline 不完整的 ready 来源使用 30s unary 兜底；所有
  ready 来源都有完整生产者时不创建聚合定时器。连接/生产者状态变化立即重估；
  用户动作的 `requestRefresh` 对**每个 live 来源**无条件执行一次即时
  mutation-pull（合并会话行、保留分组/归档集）——不是 mounted 来源的 no-op：
  mounted 来源以 host-store 事件推送为主、`requestRefresh` 即时 unary pull 为
  并行第二通道。每个来源的 not-ready → ready
  连接代边沿固定执行一次 unary：生产者会对同内容快照去重。App 断线分支
  **不清空**已推送来源的聚合（`shouldRetainPushedAggregate`——行渲染
  以 connected 为门，断连不显示；ready-edge 拉取为 sessions-only merge，归档集/
  工作区不丢失）；稳定 ready 代亦非零轮询——30s unary 兜底 watchdog 对 stale
  来源照常拉取，卡在降级视图（合成行）的来源由限流自愈臂（S2）重连并重放 workspace
  follow，使 producer 重发带归档集的真实基线（`shouldRebaselineFallbackView`）。
  **S2 臂的陈旧阈值按传输分级**（`packages/renderer/src/aggregate-refresh.ts`）：
  `http` 直连 = 120s（上游腿无应用心跳、仅 ~10min OS TCP keepalive，app 级冻结
  否则可长时间不可见——120s 是仍让健康空闲源每两分钟最多弹一次的最紧节奏）；
  `ssh` 隧道 = 300s（隧道已有三个独立探活——反代浏览器腿 30s WS ping、host mux
  2s/2-miss 心跳、ssh `ServerAliveInterval=30 × CountMax=3` ≈90s——故该臂只作
  **最后手段**：较长阈值避免健康空闲隧道源每两分钟付一次 baseline 重放，仍能治愈
  挺过全部心跳却停止推送的通道）；`local` 与未知传输取 `null`（本地聚合由权威直接
  服务、无会冻结的推送通道；未知传输已在别处 fail-closed），该臂**不得触碰**它们。
  若该拉取瞬时失败，生产者的 loading 撤回 + idle baseline 重发负责恢复，不会永久停在
  error。推快照按来源序号使较旧在途 pull 失效。
- **首屏基线收割（`packages/renderer/src/baseline-harvest.ts`）**：
  首启只有 local 挂载 + 1 个预热槽且不轮转、被回收来源在用户点击前禁预热
  （"每个 ready 来源最终串行挂载"的旧通道已移除）⇒ N-1 个 ready 远程源
  **稳态停留**在 unary 兜底视图（合成 cwd 分组 + 空归档集 ⇒ 已归档会话按普通行
  浮出、无真实工作区动作），而全部自愈臂都要求 `mounted===true`（至少推过一次
  快照），对从未挂载的来源永不生效。收割把这类来源在**同一个后台预热槽**里挂一次，
  拿到首个权威推送（真实分组 + 归档集，`archiveSetKnown:true`）即回收——回收后
  来源转入"已回收来源"态（保留权威聚合，会话行由 30s unary merge 刷新）。
  纪律：收割候选优先于普通预热且**不受**"回收后禁预热"抑制（抑制只为防止回收空转，
  不能把降级源永久钉住）；每源尝试上限 2 次、失败退避 120s、挂载后
  `BOOT_TIMEOUT_MS+15s` 无推送**且壳已 settle** 判失败并释放槽位（截止值由
  `boot-budget.ts` 的 boot 预算推导，**高于**它，否则慢隧道上的健康 boot 会被
  中途回收——正是收割要治的形态）；另有**绝对放弃上限** `HARVEST_ABANDON_MS`
  （截止值 + boot 预算）：壳始终不 settle（挂死的 loader/fetch）时截止臂永远
  不可达，此上限回收并**停用**该源（`harvestParked`），避免重试撞进同一挂死
  （注意语义边界：回收拆的是**已注册**的壳；一个从未 settle 的 boot 若从未注册，
  其 ctx/容器只能等它自己 settle 时才被拆除，页面生命周期内可能残留——同 id 的
  后续挂载不受影响，因为 shell.ts 对"上一代 boot"的等待有 boot 预算上限）；
  **同一上限也独立看管"在途挂载"本身**（按挂载时刻、且仅对**未 settle** 的挂载，
  不依赖收割意图——用户点开收割壳会撤销意图、普通温壳预热从不写意图，否则挂死
  boot 会永久占住后台槽；已 settle 的仍由上面的截止臂判定）。同 id boot 尾**从不
  提前释放**（它是 generation 记录的持有者，提前释放会让迟到的前代与后继同号并
  注册覆盖），改由 shell.ts 对"等待上一代 boot"设**绝对**上限（前代起始 + 两个
  boot 预算，所有后继共享同一截止）解耦；同族加固——页面的 producer 注册表按
  **代际**栅栏（`chamberBootGeneration` 经 ctx 注入）：迟到的老 boot 注册一律作废，
  其 teardown 不再可能清空健康后继的通道；
  且活动/待开视图不可回收——改为标记失败，让既有失败覆盖层与「重试」出现；
  在途壳不计入 retention 的隐藏壳数（它此刻不可回收，计进去会挤掉用户的温壳）；
  候选集在**存在任一收割候选时独占后台槽**（`prewarmCandidates` 只返回收割
  候选，且返回**全部**候选，让 drain 能取到排在退避候选之后的"退避已满"者）——
  若让温壳顶上来，它会成为 `autoPrewarmed` 而隐藏 1 壳时 retention 不回收它，
  `remaining` 恒 0，本会话剩余来源永远拿不到基线（一个失败源阻塞全部，违反
  正确性不变量）；**尝试耗尽且从未拿到基线**的源（`harvestParked`）不得退回
  普通预热——否则白拿第三次 boot 并同样长期占用唯一槽位；托管 dsh **终态停机或
  瞬态 starting/restarting** 的 gateway 源（投影事实 `managedRuntimeUnusable`）
  不预热/不收割——壳 boot 必然 503，只白烧尝试次数；用户点开正在收割的视图 = 采用（撤销收割意图，绝不回收）；来源退役时
  账本同源收敛。稳态仍是 ≤1 个后台壳（与预热共享槽位）。**收割另有独立预算线**：
  用户保留的隐藏温壳会让普通预热的槽位预算恒为 0（retention
  只保 1 个隐藏壳），而收割壳是瞬时的（推送即回收 / 仅最后一个保留 / 有截止与
  放弃上限），不能被它永久挡死——否则用户点开过任何来源之后，后变 ready 的来源
  永远停在兜底视图；代价是最坏多一个隐藏壳（用户温壳 + 收割壳）在收割窗口内共存。
  **代价与已知取舍**：
  首启每个 ready 来源各付一次后台 boot（N 次，串行于全局 boot 链——启动窗口内
  用户首次点击的排队概率上升，最坏仍受 60s boot 预算约束）；**最后收割的壳被保留
  为温壳**（不再额外付一次预热 boot，且该源的挂载期状态事实——pending/完成点
  ——保持在线），但它一旦遇到新的收割候选必须**让位**
  （`shouldReclaimHarvestedShell`）——否则温壳会以 `autoPrewarmed` 身份长期占住
  唯一槽位，后变 ready 的来源永远拿不到基线。
- **未挂载来源的 unary 兜底表达不了"空工作区"**（2026-12 修订，§2.2.1）：
  `fetchInstanceSnapshot` 只调 `session.list`，工作区分组由会话 cwd 反推
  （`__cwd__:` 合成行）——刚建好、没有任何会话的工作区在结构上不可见；已推送过的
  来源更彻底：聚合保留 pushed 工作区集（mounted merge），且
  `planAggregateRefreshes` 只刷新"刚 ready"或"从未推送过"的来源，对它连 unary
  轮询都不再发生。因此"新建工作区后侧栏要等用户点开该服务器才出现"不是刷新时机
  问题，而是**读通道缺失**：权威工作区集合只存在于挂载壳的 `workspace/follow`
  基线（宿主把 `upsert` 广播给所有活跃 follower），chamber 侧的补法是用户自己
  那次创建的回声（§2.2.1）——不新增 wire 读通道，也不把工作区事实搬进控制面。
- **本修订的代码落点**：`packages/dsh-chamber-client-ui-sidebar/src/shared/open-intent.ts`
  （意图槽 + 投影/揭示纯规则）、`.../src/shared/workspace-echo.ts`（回声账本 +
  union/去重纯规则）、`.../src/client/early-open.ts`（boot 期早开臂）、
  `.../src/client/index.ts`（每个 ctx 挂一次早开臂）、
  `.../src/client/SidebarRoot.tsx`（create 成功后上报回声）、
  `packages/renderer/src/App.tsx`（arm/release、账本与退休、投影门、揭示门判定、
  holdVeil 传入）、`packages/renderer/src/components/InstanceView.tsx`（遮罩合成）、
  `packages/renderer/src/shell.ts`（被取代请求的丢弃：`lastRequestedSession`）。

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
interface InstanceRuntimeReport {
  current?: string                // 当前会话 id（06 §4.3 全局单选高亮）
  sessions: Record<string, {
    running?: boolean             // 实时 running 位（App 完成蓝点边沿推导）
    completed?: boolean
    pending?: 'approval'|'plan-review'|'question'
    runningSubagents?: number     // 运行中子 agent 计数（>0 稀疏；06 §4.5）
  }>
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
  requestSessionListRefresh(sourceId: string): void       // design 24 §12：请求该来源挂载 ctx 重跑官方 session.list（purge 幽灵行收敛；§12 由生产端校验式收敛链处理：reject/hung 有界重试，越界一律保持抑制——resolve 不构成权威）
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
  // 活动视图事实（design 06 §4.6）：文档级状态（主题投影、后续的
  // lang 投影）只有活动视图的实例可以写，App 是「谁在屏上」的唯一权威。
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
- 订阅 `onRuntimeReport` → 把各来源的运行时事实合并进 `server.runtime`
  （仅附加、不覆盖轮询字段；来源断连即清，06 §4）。runtime 与 snapshot 两条
  producer 均以注册时单调 token + 主进程下发的 opaque `sourceFingerprint` 认领
  **精确来源代**：App 只接收仍与当前权威 roster proof 相等的报告。来源删除或传输
  身份编辑时，App 在等待异步 shell dispose 前先同步调用
  `retireInstanceProducers(sourceId)` 撤销 token/cache 并广播 withdraw；旧 ctx 随后的
  异步 `report/clear` 全部失效，即使 replacement 尚未注册也不能污染同 id 新代。
- 订阅 `onInstanceSnapshot` → 以内容签名 identity-preserving 合并，并使旧 pull
  失效；订阅 `onPluginDiagnostic` → 合并到来源标题异常标记与**连接页该来源卡片上的
  插件状态行**（`plugin-diagnostic.tsx`；它报的是客户端插件图 boot 健康，与设置面
  是否可渲染是不同事实面——设置壳的装配诊断块已于 2026-12 完整桥接修订退役）。

## 4. N-ctx 多实例与视图切换

- **视图保留策略（chamber retention）**：除 local 恒留外，隐藏壳最多保留
  `RETAINED_HIDDEN_VIEWS=1` 个（`src/retention.ts`），超限回收"已 settle +
  连续隐藏 ≥60s"的最久者；回收 = dispose shell + 卸载 UI 壳（App 层
  reclaimView，与注册表删除同原语），实例进程/隧道/后台任务不受影响，重开走
  冷 boot + entry 重放；被回收源的侧栏聚合落到 30s unary 兜底（§2.3）。
  取舍：被回收壳内运行中任务的完成蓝点/通知边沿暂停至该源重开。预热/可见性
  门控等细节与偏差登记见 STATUS.md、performance-baseline.md §10。
- N 个 AppWebEntry（共享一份静态模块表，v1 允许各自创建）；每来源一个 shell，
  hide/show 切换，会话保活。**视图生命周期 = 注册表来源代生命周期**：来源删除，
  或 `kind/host/user/sshPort/remotePort` 任一传输身份字段变化，都会通过权威
  `retiredIds` 同步退役旧视图并 dispose shell（`disposeInstanceShell`，shell.ts）；
  label 编辑不触碰运行时。`serviceName`/`remoteDshHome` 编辑虽不轮换 renderer 的
  来源 proof、也不退役 shell，却属于 live transport + exec generation 字段：必须按
  §7.6 撤销旧 transport/exec 工作、清理子进程并隔离迟到结果。连接失败/手动断开只是
  瞬时事实（投影为图标/徽标），不回收
  视图：设置页卡片与侧边栏分组都锚定注册表，视图若随瞬时状态消失会
  造成三面不匹配（侧边栏分组头仍可激活一个立即被回收的视图）。boot
  排队/在途时被删除的实例在 settle 时拆掉新 entry（cancelledBoots，绝不
  遗留僵尸 ctx）；被回收的视图若是当前视图则回落到 local（常驻）。
  插件图诊断同样受 boot generation 门控：已取消/已被重试取代的旧 boot
  即使迟到完成 graph 请求，也不能覆盖新一代的诊断。
- **boot 串行与 teardown 纪律**：页面级模块物化仍由全局 boot
  chain 串行；某次 `run()` 60s 不 settle 时，全局 chain 只放行**其他 instance**，
  避免一个坏来源永久阻塞无关来源。相同 instance 另有 per-id boot tail：新代必须
  等前代 `run()` settle，并等其 `AppWebEntry.dispose()` 的异步 `ctx.fiber.dispose()`
  完成后才可启动本代 host-graph/extra-bundle 副作用并构造新 Context；60s 护栏不得让
  same-id 两代重叠，避免共享模块表交错、同容器双 React root 与 producer 注册顺序反转。
  无同 id 前代的其他来源仍可 eager prefetch。每 id teardown barrier 在 dispose 一开始即登记，
  replacement/重试/删除路径都等待它；disposer 抛错或 reject 会 loud 记录但被收敛，
  不把该来源永久楔死。取消阈值 + current generation 继续守住迟到 graph/boot 结果，
  runtime/snapshot producer token 则守住异步 effect cleanup。boot/run catch 必须用
  never-throw 描述器收敛任意 thrown value（含自身反射/字符串化也抛错的 Proxy），
  不能让 boot Promise 悬挂。
- **切换实现（即时隐藏 + View Transition + 骨架屏，content-visibility）**：
  非活动视图用 `visibility:hidden + opacity:0 + pointer-events:none` 即时隐藏，
  且 `.instance-shell` 同时置 `content-visibility:hidden`——跳过整棵 shell 的
  style/layout/paint 并**缓存渲染状态**：隐藏期间内容未变的 shell 切回时
  复用缓存布局（只 paint，无全树重排长任务空窗）；隐藏 shell 空闲成本≈零；
  尺寸不变使 vendor 内 ResizeObserver 不触发（无二次重排风暴、无 AppFrame
  列宽 transition 导致的侧边栏跳动）。切换经 `renderer/src/view-transition.ts`
  的 `runViewTransition` 包装（`document.startViewTransition` + `flushSync`
  同步提交 React 状态）：旧视图先拍**静态快照**，新视图渲染就绪（reveal
  重排长任务完成）后短 crossfade（~250ms 浏览器默认）——隐藏期间仍在流式
  更新的 shell（活跃会话的 DOM 变更使缓存失效）的增量重排被旧快照遮盖，
  任何时刻无黑帧。**并发语义（键控单槽合并）**：
  `runViewTransition(update, key)` 按意图键（视图切换 'view' / settle 揭幕
  'settle'）各保留一个最新意图——同键突发连点只替换意图、被取代意图不进
  快照不起过渡节（实际过渡 ≤ 在途 1 节 + 补发 1 节），跨键按首达序 FIFO
  补发（settle 与视图切换互不吞并，骨架 veil 绝不因合并而永驻）；降级路径
  （prefers-reduced-motion / 不支持）也走同一单槽队列即时执行——偏好恰在
  过渡在途期间翻转时，不会出现"直通落地后被在途节的旧意图覆盖"。
  未就绪视图（首次打开/仍在 boot）进入**骨架屏**（`.instance-loading`）：全屏
  同底色 veil + 居中转圈/服务器名文案，`--dsw-alias-*` 主题 token 底色，z-index
  盖住 shell 内 dsh 启动页——不再需要 opacity 隐藏技巧。**骨架屏无几何主张
  （D1=A）**：骨架不以固定 rail 56 + sidebar 224 = 280px 占位块模仿 dsh
  布局几何——真实侧栏宽度由 layout store 持久化、用户可拖到任意值，任何占位
  几何都会在 settle 揭幕时失配（默认观感路径被 View Transition 快照遮盖，
  reduced-motion/降级路径则产生主区左缘位移、可入 CLS 数值分）；骨架零
  布局主张、只承诺同底色占位，settle 后第二次 View Transition（键 'settle'）
  换入真实内容——可见视图经 `runViewTransition(..., 'settle')`、后台 boot 直落
  （无过渡，点击切入时的过渡由 App 层覆盖）；失败则 chamber 覆盖层呈现 + 重试 +
  服务器切换（见下），`bootInstanceShell` 的 settle 态经 `.then(setShell)` 落地。
  **失败呈现**：
   失败不由各 InstanceView 自绘（旧 `.instance-fatal`，仅有重试、无导航），
   而是由 App 在活动视图上统一渲染 `.fatal-overlay` 覆盖层——失败报告 +
   重试（`retryToken` 递增 → InstanceView 复位重 boot）+ **服务器切换行**
   （`.fatal-servers`：chamber 级逃生通道，不依赖任何 shell 挂载）。原因：
   boot 失败 = 该视图的 dsh shell 从未挂载，而侧边栏（多来源导航）在 shell
   内——若不提供 chamber 级覆盖层，用户会被失败报告困在当前视图（只能整页
   刷新），违反「一个实体的失败不得抹除/阻断无关健康实体」不变量。dsh 壳
   内自绘的失败页（`AppWebEntry` 加载页的 fail-loud 报告）也统一经
   `AppWebEntry.bootError`（拷贝包 seam）上浮为 chamber 可见的失败态
   （shell.ts 失败分支 dispose 该 entry，重试干净重 boot）。**模块表安装顺序**：
   模块表（`window.__DSH_MODULES__` + `__ModuleLoader__`
   sink）经 boot.ts 导出的幂等 `ensureWebModuleSystem` 在**任何 bundle 脚本
   执行前**装好（shell.ts 在 collectExtraRows 预加载之前调用，run() 经同一
   helper 收编）——否则首个带额外行的 boot 会让官方 bundle 在 sink 安装
   前求值、顶层交接抛错，boot 以难懂的 "cannot resolve" 失败。
   ready 远程实例**空闲预热**：按序一次一个后台
  boot（`instance-pending` 态仅 visibility 隐藏、保留 layout——vendor
  测量/IntersectionObserver 在 boot 期间正常），settle 推进下一个，使多数
  首次切换在点击时已就绪；预热与用户触发复用同一 entry 的 boot promise，
  不依赖页面级 base-path/source 全局旋钮。
  不支持 content-visibility 的浏览器降级为保留 layout 的 visibility 方案
  （同样无闪烁）（styles.css `.instance-view.instance-hidden`）。
- `openInstanceSession(sourceId, sessionId)`（shell.ts）：boot 未就绪先入队，
  原调用 Promise 保持 pending；enqueue 当刻固定 **68s absolute deadline**（60s boot
  queue 预算 + 最多 8s session-list 可见性轮询），flush 不重置预算，只使用剩余时间
  且上限 8s。settle 后经 `AppWebEntry.runtimeCtx.sessions`（拷贝包 seam，§6）分发，
  只有 runtime 接受才 resolve；dispatch poller 归属精确 `ShellHolder`，每次 snapshot/
  重试/最终 `sessions.open()` 前复验 holder 身份，replacement/dispose/disposeAll 会同步
  清 timer 并 reject 全部 holder-owned 在途 dispatch。boot/dispose/总截止时间到达同样
  loud reject，旧 runtime 永不能在 teardown 后迟到执行 open；runtimeCtx/list/open 的
  getter/调用若抛任意 hostile value，也必须经同一 never-throw 描述器 reject 并清理
  timer/cancel handle，不能把 timer-driven open 永久挂起。**sessions 服务就绪与列表
  可见性共用同一轮询预算**：boot settle（loader.await +
  assertEntriesActive）只等 entry **根** fiber，`ctx.sessions` 由 composite 的
  **子** fiber 提供（child 在异步 api-remotes 命名空间 mount 后才激活）——queued
  open 的 flush（entries.set 同刻）或就绪窗内的点击可能落在 holder 已注册而
  sessions 服务尚未注册的窗口。该状态是**瞬态**：poller 按 400ms 节奏在 deadline 内
  等待服务就绪与目标会话可见，绝不 fail-fast；deadline 到达才 loud reject，且区分
  两种终态报告（服务从未就绪 → 「boot 未完全就绪」；服务就绪但会话始终未列出 →
  「等待超时」）。终态失败文案经 `reportOpenSessionOutcome` 回报侧边栏并在
  目标会话行内呈现（§2.2），不再 console-only——fail-fast 会让跨服务器
  冷壳/回收重 boot 后的首次会话点击在视图已切换后瞬间失败，用户落在目标服务器
  UI 而未选中会话（呈现为该 workspace 的新对话输入框）。
- **每 entry Context 私有注入**：
  `AppWebEntry` 提供 `configureContext(ctx)` seam；shell.ts 创建 entry 时用闭包把该
  视图自己的 `chamberInstanceId`、`chamberBasePath` 与主进程签发的
  `chamberSourceFingerprint` 写入其 cordis Context，chamber-entry 只做事实校验；
  **两个 base-path fork 的 `apply(ctx)` 各自从该 Context 读 `chamberBasePath`**
  （connection：RPC 载波 + `handle.basePath`；api-gateway：`/api/remote.mux` 路由），
  不再经插件 config 传参。不同 entry 不通过
  `window.__DSH_BASE_PATH__` 或页面级 `chamber-knob.ts`（已删除）交换 boot 参数，因此并行/
  交错 boot 不会串用来源或代理前缀；shell 在任何 graph/module 副作用之前仅接受
  精确 `local`、规范 `dsh-<raw-id>` / `gateway-<raw-id>` 或兼容迁移的 legacy
  `ssh-<raw-id>`（raw id 明确排除保留字 `local`），且强制 basePath 等于
  `/api/i/<instanceId>`。
- 目录选择面统一为应用内浏览对话框（browse）：**所有实例一律注册
  `UiDirectoryPickerBrowse`**，与宿主能力恒一致——本地宿主经 spawn 环境
  pin `SSH_CONNECTION`（02 §3.1）令其 directory-picker-auto 解析
  `browse`（服务 `host.listDirectory`/`host.createDirectory`）；远程宿主
  按 02 §3.9 部署（单元含同款 pin；headless linux 服务器无显示会话，
  缺行也天然 browse）；OS 原生选择器（native）对 chamber 用户永不出现，
  添加工作区的唯一路由 = 应用内对话框 pick 一个宿主目录（含弹窗内新建
  文件夹）。侧边栏"新建工作区"打开的就是同一对话框，按来源分派（每来源
  unary client 驱动，见侧边栏包 README）。
- 官方 ui-workspace 的 hero "Add workspace…" 与 chamber 侧边栏共用同一
  browse 表面，样式与交互完全统一（上游 one-route 哲学：不做手敲路径
  表单——native picker note 与 one-route 简化均已否定手敲路径交互）。

## 5. 连接设备页

- chamber 自研插件包 `packages/dsh-chamber-client-ui-settings-connections`
  （`@dsh-chamber/dsh-chamber-client-ui-settings-connections`）：连接页是设置壳的
  **固定 nav 入口**（`__connections`，在分隔线之下、不占 ledger order），**不是**
  `settings.section` 注册——host-ctx 的 `settings.section` 注册已移除（消除
  "第二个连接页"隐患），插件只提供该页的字典命名空间与分节组件
  （`ConnectionsSection.tsx`）。
- 「dsh 运行时」段（design 18 §3.6/§9，per-server）：chamber 自研
  `settings.section`（id `dsh-runtime`，order 31，由设置壳 settings-bridge 的
  `registerRuntimeSection` 注册），注册在**该来源自己 boot ctx 的 ledger** 上
  （2026-12 完整桥接修订；随 `chamberBridge` roster 投影 reconcile）、紧随
  agent-presets 渲染；connections 是壳的
  固定 nav 入口，故「dsh 运行时」在
  视觉上位于 server 段列表内 agent-presets 之后。local = 完整运行时管理面，
  gateway = 经反代触达该 gateway 的 `/chamber/runtime`，**dsh 直连（ssh/http）
  = 不挂载**（dsh 直连无 `/chamber` 面、无 ssh exec 管理通道，该来源设置段
  不渲染 dsh-runtime 分节；与 18 §3.6 / AGENTS / design 17 §3 同口径）。
  **不再位于 chamber 全局「通用」视图**
  （design 15 的 `__general` 控制组不含运行时块）。
- **「重启 dsh」动作只在本地与 gateway 两源**（design 18 §3.6 项 8，刷新插件挂载）：
  local = 控制面事务接口
  `restartLocal()`（design 18 §9.3，与健康状态机重启单飞行串行化——**不是**连接页
  裸 启动/停止 的组合）；gateway = `POST /chamber/runtime/restart`（经
  `/api/i/gateway-<id>/chamber/*` 反代，202 + status 轮询）+ `POST
  /chamber/runtime/start`（design 21 决策 12 停机恢复：stopped/error/
  restart-exhausted，卡片「启动实例」入口）。二次确认 + 状态行，与健康状态机
  `restarting` 单飞行互斥、applying 期间禁用。ssh（dsh 直连）的 systemd
  `restart_service` 属**连接管理面**（重启 gateway/dsh 服务本身，非插件模型动词，
  design 21 §3 目标语境差异登记），dsh（ssh/http）直连不挂载 dsh-runtime 段、无
  插件模型重启动作。（http 直连来源无任何重启动作，design 17 §3。）
- **写者静默通知与「清理并接管」（2026-09-10，02 §3.4 / 04 §3.2）**：本地卡在
  `GET /api/connections/local/writers` 报非静默时，于卡片内点名阻塞写者
  （`pid <n> · <原因>`，附机器 token）并给出「清理并接管」按钮（`POST …/reclaim`）：
  清除**本状态目录自己的**陈旧/孤儿托管写者记录后启动本地实例；owner 仍活的另一个
  应用实例永不被影响（控制面拒 409 并把原因带 `detail` 回来，卡片原样呈现）。
  写入期终止失败（`sticky`）时只提示重启应用、不给按钮——无证据可依。
  判定是纯函数 `writer-diagnosis.ts`（有单测），卡片只渲染。
- **职责划分**：连接页本地卡的 启动/停止 = 连接生命周期（开机常驻与否）；
  「dsh 运行时」段的 重启 dsh = 运行时维护（刷新插件挂载、恢复服务）——两者
  不合并、文案不混用（起停不改运行时事实，重启不改指针/版本）。
- **每来源设置面 = 该来源自己的设置面（权威口径，2026-12 完整桥接修订）**：
  设置壳不再为选中来源装配「缩小版前端」，而是**渲染该来源自己 boot ctx 的
  `settings.section` 台账**，条目用**该 ctx 自己的渲染器绑定的标准座**渲染。
  规则（实现见 `packages/dsh-chamber-client-ui-settings-bridge/src/client/`）：
  - **台账来源**：选中来源自己的 cordis ctx（`AppWebEntry` 的 boot ctx）。官方 settings
    全族由 chamber 复合 bundle 挂在那里（`chamber-entry.ts` 首屏 `ui-settings` +
    deferred general/models/plugins/plugin-inventory/agent-preset），该来源自己的客户端
    插件由 host-graph extra rows 挂在那里（design 09 §3），chamber 自研分节
    （「dsh 运行时」）也由本包在该 ctx 上注册。**面板不挂载任何插件**，因此不存在
    第二次挂载、没有桩 remote、没有能力降级，也没有「未激活」可报。
  - **面（face）注册表**（`settings-source-face.ts`）：每个实例的桥接插件在该 ctx
    `apply` 时发布 `{slots, locale, chamberSourceFingerprint}`；该实例的设置壳组件
    （`sidebar.settings` 的 occupant，是唯一被渲染器绑定完整标准座的 chamber 条目）
    发布渲染器给它的标准座（`useSessions` / `useWorkspaces` / `usePanelInfo` /
    `useResource` / `useSessionPendingInteraction` / root `props`）。两半都发布齐
    （`settingsSourceFaceReady`）才可渲染；半发布的 face 不可渲染。
  - **渲染**（`bridge-outlet.tsx`）：面板按 `settings.section` 台账的 list/keyed 语义
    渲染条目：标准座 + `t`（该来源 locale face 的命名空间）+ `useStore`/`actions`
    + `renderSlot`（子座位）+ 条目 `inject` 面 + owner props。**座位来自该来源自己的
    渲染器绑定**，绝不伪造空桩：某个座缺席是那台服务器的事实，不是可以补一个空
    observable 的缺口。
  - **归因不上面**：`StoredEntry.registrant`（cordis fiber-name 戳）**不渲染**——上游
    官方壳也只渲染 `navIcon(row.id)` + 分节标签，该戳在上游是纯诊断字段（控制台
    错误文本 + 动态 cordis 崩溃归因）。本仓因此退役了曾经的「插件」来源标记
    （2026-09-11，用户拍板）：插件提供的分节与官方分节在 nav 上完全同形，与实例
    自己的前端一致。
  - **来源必须在挂载中**：面由该来源自己的壳发布，所以面板打开期间 App 层保证该来源
    的壳**已挂载**——`chamberBridge.setSettingsTarget(sourceId)`（面板→App 单通道）
    未挂载则后台挂载（**不切 active view**），已挂载则排除出保留策略回收候选
    （否则隐藏 60s 后壳被拆、正在编辑的设置面消失）；面板关闭即撤除两条保证。
    未挂载完成时面板显示「正在启动该实例的前端」中间态；离线来源显示既有不可达占位
    并给连接管理入口（不触发挂载）。
  - **来源化身守卫**：face 携带交付给该 ctx 的 `chamberSourceFingerprint`；面板只在
    它与权威 roster 的同一字段相等时渲染（同 id 替换/传输字段变更后的旧 face 绝不
    渲染一帧）。
  - **座位矩阵**：壳渲染 `settings.section` + `settings.action`（action 保持既有
    「仅本地来源」限定），子座位（`settings.general.item` / `plugins.tab` / keyed 卡片）
    随所属分节渲染；`trigger/header/close` 属**壳 chrome**（自绘标题/关闭/触发器），
    `settings.onboarding` 则是**内容座**（官方 `ui-settings-models` 真的往里注册首启
    引导步骤）——chamber 壳不实现官方 onboarding 协调器，故它同样不被渲染。这三类
    都不由壳渲染，且组装诊断块退役后**不再逐条报告**：某来源插件贡献的 onboarding
    步骤在桌面面板里不会出现，这是已知的最小可见性损失（见 STATUS.md 残余登记）。
  - **错误containment**：外来条目（该来源自己的插件贡献）的渲染失败经
    `BridgeEntryBoundary containAll` 收口成 `<div data-slot-error="…">`，绝不夺走
    chamber 自己的 `sidebar.settings` 条目（那会回落到没有服务器下拉的官方 SettingsRoot）。
  - **保留优先级 + 看门狗**：设置壳注册在保留 shadow 优先级（shared face
    `settings-shell.ts` `SETTINGS_SHELL_SHADOW_PRIORITY = -1000`）；chamber 侧边栏
    监视 `sidebar.settings` 的 cell winner，若有注册者低于该区间（即顶掉设置壳）则
    `console.error` 报告（检测而非改写 slot 语义）。
  - **`settings-connections` 座位**：该插件只提供字典命名空间（无 host-ctx
    `settings.section` 注册）；固定入口 `__connections` 渲染同一组件。连接页内该来源
    卡片上的「客户端插件状态」仍由 chamber 的 boot/extra-row 诊断通道供给
    （`pluginDiagnostic`），与设置面是否可渲染无关。
  - **上游可选项（非前置）**：声明式贡献描述符 / 设置面服务契约 / Remote descriptor
    上行通道仍是上游提案（`docs/progress/todo/settings-surface-upstream-contributions.md`）；
    完整桥接不依赖它们——它复用上游既有的「来源自己的前端」这一事实。
- 内容：本地实例卡（/health 状态徽标 + /api/connections 行端口/label +
  启动/停止（二次确认）+ host 日志只读）+ 远程主机卡片列表（label +
  user@host:port + phase 徽标 + 隧道 localPort + serviceName + logSummary；
  连接/断开 + systemd 起停/查询 + 日志 Modal（logs/logs_clear）+ 编辑 +
  删除 + dashed"添加主机"卡 → Modal 表单）。
- **design 21 插件管理面**：卡片日志入口命名区分（「连接日志」= 本机连接
  通道事件 / gateway 卡「网关主机日志」= 服务器侧 gateway 进程与托管 dsh spawn
  日志；图标去重）+ gateway 卡「重启 dsh」/「启动实例」动作（phase 门控 + 每卡
  单飞 + 共享 pollGatewayReady 轮询，多用户中断确认文案）+ **单一插件管理模型
  视图（唯一 `PluginDialog` 组件）**：统一区域 = 诊断横幅
  （状态名 + message 去重）→ chamber 内建组件表（注册表驱动的宿主包行，
  当前四行 client-graph / git-worktree / archive-cleanup / open-in，badge 化；另有 gateway 源才出现的
  移动端 client 行，随发行物注入）→ 第三方插件区（已安装列表 + 逐行卸载 + 添加：spec 输入 + npm 搜索 +
  文件夹导入）→ 恢复/动作行；gateway 添加双通道（registry spec 直装 +
  文件夹直推）已接线；「变更记录」区不渲染（后端 journal/备份保留）；恢复撤销
  仅 gateway（崩溃/恢复态恢复横幅）；http 直连只读不变；恢复提示 r0–r4 文案双
  后端同权；契约与余留见 design 21 §6.6/§7。
- 操作全走现有 `desktop_ssh_*` IPC 与 `/api/connections`；表单收非秘密
  元数据（id/label/kind/transport/insecureHttp/host/user/sshPort/remotePort/
  serviceName，id 白名单
  `^(?!local$)[a-zA-Z0-9_-]{1,64}$`（禁 `local`、限长 1–64，transport-provider
  常量），端口 1–65535；transport 表单 schema 按注册表驱动，17 §2.2），
  SSH 认证默认走系统 ssh-agent/
  默认密钥；**可选密码字段**（§8 例外）：与元数据一起经
  `desktop_ssh_save_connection` 转发主进程（内存 +
  `<userData>/ssh-passwords.json` schema v2 binding 明文镜像，0600 原子写），
  表单永不记录、编辑时永不回填——**SSH 材料（除该瞬时输入外）永不进
  renderer**。
- **`~/.ssh/config` 自动发现**：主进程读取并投影非秘密字段
  （alias/hostName/user/port，跳过通配符条目；IdentityFile/ProxyCommand/
  凭据不投影），经 `desktop_ssh_config_list` 供添加表单选择填充；
  手写解析器（无依赖），文件缺失 = 空集、不可读 = 响亮 {error}。
- **端口语义**：`remotePort` = 远端目标端口（ssh 隧道远端 / http 直连
  端口，必填）；`sshPort`（可选）= SSH 守护端口（null = ssh 默认 22 /
  config Port，非空时隧道与 systemd exec 均带 `-p`）。
- 样式遵循 dsh 设计语言：CSS modules + `--dsw-alias-*` token +
  ui-primitives（Button/Modal/Tooltip/Input/Pill/图标）。
- 实例默认仍按注册表自动连接、本地自动启动；本页提供显式管理与诊断入口。

## 6. 源码复用与构建链（拷贝补丁包 2 个 + 自研客户端插件 6 个 + 宿主包 3 个）

- pnpm + `vendor/harness-packages` 符号链接（外部 dsh 源码，**永不修改**）；
  要修改的包必须拷入本仓 `packages/`。
- 拷贝补丁包（保持官方包名 `@deepseek-ai/*`，遮蔽 vendor workspace 条目）：
  - `packages/dsh-client-connection/`——base 路径参数化补丁；`apply(ctx)` 从每个
    `AppWebEntry` 私有 Context 的 `chamberBasePath` 一次解析不可变 prefix，并同时传给
    HTTP unary、两条 WebSocket downlink 与 generic RPC/Typert carrier；页面 transport
    覆盖 HTTP/WS 时，generic RPC 仍收到同一 prefix 与该 transport 的 fetch。未配置时
    保留官方 web 兼容顺序（legacy `window.__DSH_BASE_PATH__`，再回落空 prefix 直连
    `/api`），但 chamber 运行链不再写该全局。该接缝由
    `test:connection` 的 client-apply / carrier-assembly 行为门与独立
    `typecheck:connection` 源码门固定，不能只靠字符串/AST 检查；
    **连接层职责边界**：
    ① **连接层是 push 通道（`/api/remote.mux`）的唯一重开者**——控制面/桌面各层只
    「发现」（心跳/探针/相位/看门狗）与「撤销或重注册传输」，从不重开一条流；mux 客户端
    （`dsh-api-gateway`）自身无退避，其重试节拍由连接循环的 `onReconnectRequested` 驱动。
    ② **禁止同实例 `stop()+start()`**：上游 `reconnect()` 已覆盖立即重连语义且不产生第二个
    泵循环；若未来重新引入 stop+start，必须同时恢复代际守卫（`loopEpoch` 语义）。
    ③ **每来源恢复时序**由 `recovery-policy.ts` 决定并经上游支持的
    `connection.start(sinks, config)` 传入（远端 ssh/http 45s 就绪期限 / 5s 告警；本地与
    未知来源保持上游 15s/3s）——chamber 页面拿不到宿主注入的
    `__DSH_CONNECTION_RECOVERY__` 页面全局，故不能依赖页面级配置。
    ④ 活性触发集合 = `system-resume`（**旁路离线门**，见 design 14 D4）+ `online` +
    隐藏 ≥30s 回前台（两者受离线门约束），共享 10s 去抖；
  - `packages/dsh-client-web/`——`boot.ts` N-ctx 模块表共享 seam + 公开
    `runtimeCtx` getter（实例 shell 打开会话的 seam）+ `configureContext` 同步注入
    seam + 可等待的异步 `dispose()`。真实 `AppWebEntry.run()` 的 Context 注入顺序由
    `test:client-web` 的 configure-context boot 用例固定（不是模拟 shell 文本断言）。
- 自研插件包（`@dsh-chamber/*` 前缀，替换/扩展官方插件注册）：
  - `packages/dsh-chamber-client-ui-sidebar/`——**chamber 自研侧边栏插件**（包名
    `@dsh-chamber/dsh-chamber-client-ui-sidebar`，拷贝官方 ui-sidebar 结构改造：保留
    几何/折叠/孔位声明，会话区改为多来源统一列表）+ `shared/aggregate-store.ts`
    （chamberBridge）+ `shared/instance-api.ts`（每实例 unary 客户端，
    App 层与插件共享一份，vite 共享 chunk）；
  - `packages/dsh-chamber-client-ui-settings-connections/`——自研连接设置插件
    （§5，连接页固定入口 `__connections` 的字典命名空间与分节组件）；
  - `packages/dsh-chamber-client-ui-settings-bridge/`——自研设置壳插件（§5 同款
    讨论，注册进 `sidebar.settings` 槽、以 `SETTINGS_SHELL_SHADOW_PRIORITY = -1000`
    shadow 官方 SettingsRoot，
    服务器下拉 + 渲染选中来源自己 boot ctx 的 `settings.section` 台账，条目用该 ctx
    渲染器绑定的标准座）。面的所有权绑定 `(sourceId, sourceFingerprint)`：权威 roster
    删除来源或在同 id 下更换 proof 时，旧面立即不可渲染（面板只在 face 指纹与 roster
    同一字段相等时渲染），来源重 boot 时由新 ctx 的 `apply` 重新发布；发布/撤除都按
    slots/locale 身份校验，迟到的旧代撤除不会清掉新代的面。
  - `packages/dsh-chamber-client-ui-layout/`——官方 ui-layout 壳插件的 chamber
    fork（①替换 layout store：`sidebarWidth` 经侧边栏共享 view-prefs store
    播种/回写，钳位 [264,420]，覆盖 id；②**文档级主题投影的唯一写入者**：
    全页单例 `ThemePresenter` + 按活动视图门控的 `document-theme.ts`，见设计 06
    §4.6；替换官方 ui-layout 注册）。
  - `packages/dsh-chamber-client-ui-git/`——设计 08 的 chamber 内建 Git
    Worktree 插件：占用 per-workspace 座位 `sidebar.workspace.git`，页面级 singleton
    以 30s 单飞读取各实例 topology，并编排 create/workspace/session 与 Git-first
    remove saga；它不把
    Git 事实塞进 App aggregate，也不暴露任意 argv/path mutation。
  - `packages/dsh-chamber-client-ui-open-in/`——设计 16/20 的 chamber 内建桌面打开
    插件（**2026-09-11 用户裁决：fork & supersede**）：占用
    `conversation.session.header.utilities`，按当前 N-ctx 的 source 经 per-source
    视图模型选择入口——**本地**来源走**实例进程内的 chamber host 包**
    （`@dsh-chamber/dsh-chamber-seed-open-in`，见下「自研宿主包」）+ 桌面主进程的
    VS Code 覆盖项；**远程 ssh** 来源只有主进程的 VS Code Remote（trusted IPC +
    来源代 proof）；http/未知来源无入口。官方客户端行沿用 page-own 跳过纪律
    （我们的 fork **替换**官方注册），官方宿主行保持挂载但永不被调用；无控制面执行面
    （主进程亦已收窄为 vscode-only，见设计 20 §2.2/§4）。
- 自研宿主包（随 chamber 分发、运行于每个 dsh 实例进程）：
  - `packages/dsh-chamber-seed-client-graph/`——设计 09 的只读 client boot graph Remote；
  - `packages/dsh-chamber-seed-git-worktree/`——设计 08 的领域限定 Git Remote，
    与该实例 `workspaceRegistry`/live agents 同用户、同文件系统做权威守卫；
    Desktop 与控制面均不执行 Git。
  - `packages/dsh-chamber-seed-archive-cleanup/`——设计 24 的已归档会话内容清理域
    （`archiveCleanup/{preview,purge}`，AGENTS 已登记的有界例外）：实例进程内
    经宿主权威状态 children-first 级联清除归档集内容（含 subagent 起源后代、
    官方事件发射），只删不读、绝不触碰运行中/未归档内容；上游 delete wire
    落地后退役。
  - `packages/dsh-chamber-seed-open-in/`——**设计 20 §6（本地形态专用，`localOnly`）**：
    上游 `dsh-host-open-in-app` 宿主半的 fork（本机应用目录 + 真实 bundle 图标 +
    绝对目录校验 + 拉起，`openInApp/{probe,apps,icon,open}`），删去上游的 SSH 休眠门、
    `webServer` 路由与连接栅栏（改走实例自身通用 RPC 通道）；不读启动标记，
    因此与目录选择 pin 解耦。
- 前端入口复用 `packages/renderer/`：vite 构建时把 workspace 包 alias 到源码；
  `chamber-entry.ts` 复合 entry 挂整棵 dsh 客户端树（connection→typert→
  gateway→remotes→runtime→locale→theme→**layout（chamber ui-layout fork 替换
  官方注册）**→**chamber 侧边栏（替换官方）**→**Git Worktree 插件**→
  **open-in 插件**→settings×4→conversation→…→全量 ui-*）。
- **启动图清单 = 单 entry + 每实例宿主图额外 entry（设计 09）**：
  - 页面清单 `__DSH_BOOT__` = `{rev, entries:[{id, url, rev, immediately?}]}`
    （wire 契约以 vendor `dsh-client-modules/src/client/manifest.ts` 为权威）；
    构建期写死**单 entry**（`@dsh-chamber/app` chamber composite bundle），
    bundle = vite 产物 `/assets/chamber-<hash>.js?rev=<rev>`。构建链 =
    gen-typert-remotes → vite build → gen-boot-manifest。
  - **每实例宿主图额外 entry（设计 09，2026-08 落地）**：boot 时前端经反代
    （`/api/i/<id>`）调 chamber host 包 `@dsh-chamber/dsh-chamber-seed-client-graph` 的
    Remote `clientGraph/graph` 取该实例宿主组合的客户端插件 boot 图，按
    `CHAMBER_COVERED_IDS`（`packages/renderer/src/chamber-covered.ts`：复合已覆盖
    + 页面自有 id）去重，预加载剩余 bundle
    （`/api/i/<id>/plugins/<pkg>/client.js?rev=…`），经 boot.ts `extraRows` seam
    合并进 boot rows（详见设计 09）。
  - **host 包与 seed（设计 08/09/20/24）**：`packages/dsh-chamber-seed-client-graph`、
    `packages/dsh-chamber-seed-git-worktree`、`packages/dsh-chamber-seed-archive-cleanup`
    与 `packages/dsh-chamber-seed-open-in`（后者 `localOnly`：只 seed 进本地 profile，
    不进远端 seed 也不随 gateway 上传，design 20 §6）都提交 esbuild `dist/index.js`
    （`@deepseek-ai/*` external）；控制面 `host-graph-seed.ts` 幂等 seed 所有
    已构建包进 `$DSH_HOME/profiles/web/node_modules/@dsh-chamber/*/`，并把
    `client-graph` / `git-worktree` / `archive-cleanup` / `open-in` insert 合并到单一
    `<stateDir>/dsh-chamber-graph.patch.yml`。每次 spawn 注入同一 `--patch`
    （`webProfileArgs(port, patchPath?)`）；任一产物缺失只跳过对应行，不产生
    悬空 insert。远程 ready-time seed 同样一次探测/一次 overlay 合并写，见设计 13。

## 7. 控制面 / 桌面契约（无认证面）

### 7.1 代理路径（唯一入口面）

- `/api/i/local/*` → 本地实例；`/api/i/dsh-<id>/*` → 该实例隧道
  （ssh-<id> legacy 段）；`/api/i/gateway-<id>/*` → 该 gateway
  （隧道/直连端点，认证头由主进程注入，17 §9.3）。
- HTTP 全量透传（响应头白名单收敛）、WS upgrade（events.mux/events.host）、
  SSE 直通；路径剥前缀转发；**v1 无认证边界**（loopback-only，03 §3.2）。
- 无隧道（phase != ready）→ 503 明确错误（不静默）。

### 7.2 REST（管理面）

- `GET /health`、`GET/POST/PATCH/DELETE /api/connections`（local）、
  `GET /api/host/logs`。认证/审计路由与模块已随 v1 收敛移除。

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

- `dsh-chamber:info`；`desktop_ssh_instances_get`（spec v2：kind/
  transport/insecureHttp、sshPort、serviceName 与 remoteDshHome，03 §2.2）、
  `desktop_ssh_save_connection`（元数据 + SSH password + gateway token/password 的主进程
  crash-safe 原子/补偿事务；write-only 旧值只在主进程快照，renderer 不可读）、
  `desktop_ssh_delete_connection(id)`（精确 id-addressed 主进程删除事务；不存在 id 为幂等
  no-op）、legacy `desktop_ssh_instances_set`（只接受与当前规范化 roster 同长度、同顺序、
  逐字段完全相同的 exact no-op，任何删除/add/edit/reorder 都拒绝）；三个单项 credential
  setter 仅接受显式 clear；add/edit/delete/非空凭据写不能绕过各自主进程事务；`desktop_ssh_config_list`
  （`~/.ssh/config` 非秘密投影）、
  `desktop_ssh_connect/disconnect/status/logs/logs_clear`、
  `desktop_ssh_start_service/stop_service/is_active/restart_service`（固定参数数组
  `systemctl <action> -- <serviceName>`，serviceName 白名单
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`、首字符必须为字母或数字）；
- gateway 凭据（write-only，design 17 §9.1/§7.2/§12）：表单瞬时收集并作为
  `desktop_ssh_save_connection` 的 write-only 字段经受信 IPC 转发主进程（内存持有 +
  `<userData>/gateway-secrets.json` 0600 原子写、
  safeStorage 加密 blob 优先，17 §12）；永不返回 renderer、不进注册表/日志，
  删除实例/显式清除即删；只注入已注册 gateway transport 的 0..2 白名单头
  （§8 / 17 §9.3）；
- chamber 设置面（设计 14 D7，chamber 全局运行设置，非秘密）：
  `dsh-chamber:settings-get`（查询当前设置 + 平台能力门控）、
  `dsh-chamber:settings-set`（应用并持久化 `<userData>/chamber-settings.json`，
  失败 loud `{error}`，绝不落半个设置）、推送 `dsh-chamber:settings-changed`、
  推送 `dsh-chamber:system-resume`（OS 唤醒，载荷 `{timestamp}`，渲染端立即
  重连——设计 14 D4）；设计 19 的 notifications 嵌套设置仍属于该 chamber 全局面，
  不进入任何实例配置平面；
- 桌面 open-in 面（设计 16/20；主进程为 vscode-only）：
  `dsh-chamber:open-in-apps`（本机 app 能力协商，非秘密投影，现只投影 vscode）与
  `dsh-chamber:open-in`（appId/instanceId/path/sourceFingerprint 主进程统一校验后
  拉起 VS Code；本地文件管理器等应用由实例官方宿主路由执行，不经该 IPC）。`sourceFingerprint` 是主进程内存签发、随 roster 投影的
  非秘密 opaque proof（local 固定为 `local`，远程为 64 位小写十六进制）；renderer
  不得自行构造。主进程在接受请求、异步宿主调用边界及排入 renderer intent 前复验
  精确来源所有权，旧 shell 按钮不能操作同 id replacement；
  app 能力首次真实 IPC reject 在同一 page-wide single-flight 内最多 3 次、间隔
  500ms，最终仍 fail-closed；vscode 成功 intent 进入 64 上限有界 ACK 队列，push
  携带 `{instanceId,path,sourceFingerprint,deliveryId,attempt}`，send 只转 in-flight；
  renderer 完成/有意放弃激活后用精确 deliveryId+attempt ACK，reload/crash 会重发未
  ACK 项，旧 attempt 或旧 proof 不能提交 replacement；
  renderer 先注册 `dsh-chamber:deep-link-intent` 监听、再 invoke
  `dsh-chamber:deep-link-ready` 才放行（握手失败 5×500ms 有界重试）。主进程 send
  抛错把失败项 rollback 到未发送队首、保持 key 在途与 FIFO/去重，且仅失败的当前
  窗口可撤销 ready；远程激活在 renderer 等当前 generation 权威 roster + proof，期间
  单槽 last-intent-wins（被替换的旧 delivery 也须 ACK），目标权威缺失或 proof 过期才
  loud 丢弃。激活失败不回滚已经完成的本机拉起；
- 桌面原生通知面（设计 19 受限 carve-out，无通知中心/历史/控制面 runtime）：
  `dsh-chamber:notify`（严格 `local | dsh-<raw-id> | gateway-<raw-id>` 规范来源，
  并仅为迁移兼容接受 legacy `ssh-<raw-id>`；事件/文本/长度白名单后由
  主进程设置与焦点裁决；请求必须携带与当前来源代匹配的 `sourceFingerprint`）+
  `dsh-chamber:notifications-ready` 握手 +
  `dsh-chamber:notification-open` push。click payload 在主进程用 64 上限 FIFO hold；
  每条 push 携带 `{sourceId,sourceFingerprint,sessionId,deliveryId,attempt}`；send 只转
  in-flight，renderer 完成路由或有意丢弃后用精确 deliveryId+attempt ACK 才消费。
  send 失败只回滚当前项；reload/crash 把未 ACK 项按 FIFO 重发，旧 attempt ACK 无效。
  renderer listener-before-ready（5×500ms 有界重握手）后仍以 proof + 当前 generation
  权威 roster 作二级门，权威缺失或 proof 过期才逐项 loud 丢弃；
- 插件同步面（设计 13，远端 dsh plugin 编排经 provider exec 通道，spec 白名单
  见 13 §7.2）：`desktop_ssh_plugin_list/plugin_apply`（add/remove/restart，
  restart 需布尔值）、`desktop_local_plugin_list/add/remove`（本地实例插件）、
  `desktop_npm_search`（npm 搜索，best-effort）、`desktop_ssh_seed_host_graph`
  （远端 seed 宿主包）、`desktop_ssh_plugin_materialize_add` 与
  `desktop_ssh_plugin_materialize_add_pick`
  （本地路径包物化：主进程 pick 目录 → pack → ssh 传输 → 远端 `add file:`；
  renderer 不提供路径）、`desktop_gateway_plugin_materialize`（gateway 侧同款
  主进程 pick + 直推）；
- `desktop_ssh_status_changed` 推送（隧道相位即时投影）、
  `desktop_ssh_instances_changed` 推送（载荷 `{removedIds,retiredIds}`；`removedIds`
  仅物理删除，`retiredIds` = 删除 + 传输身份编辑，renderer 先同步退役旧来源代再重拉
  roster；另有 30s 轮询兜底）。
- 传输 URL 永不进 renderer；renderer 只见 localPort/phase 投影（含 `kind`）。
- 所有 invoke（含 `dsh-chamber:info` / `desktop_ssh_*` / chamber settings /
  `dsh-chamber:open-in-apps` / `dsh-chamber:open-in` / `dsh-chamber:deep-link-ready` /
  `dsh-chamber:notify` / `dsh-chamber:notifications-ready`）必须同时满足：sender 是当前
  主窗口 WebContents、senderFrame 是其 mainFrame、frame URL 精确属于当前
  控制面 origin；否则抛 `ipc_sender_forbidden`。窗口拒绝新窗口，并在
  `will-navigate` / `will-redirect` 阶段阻断离开控制面 origin，防止 preload
  主机能力暴露给被导航页面。

### 7.5 本地实例

- `--profile web --host 127.0.0.1 --port <port> --trusted-host 127.0.0.1:<port>`
  （浏览器信任栅栏）；端口占用重试/pid 记录/instance-id 仲裁/resolveDshEntry 保留；
  node 可执行经 resolveNodeExecutable 解析（Electron → execPath + ELECTRON_RUN_AS_NODE
  + `--expose-internals`，见 02 §3.1）。
- **桌面预启动（pre-spawn）**：主进程在窗口加载前调用 `PlaneHandle.startLocal()`
  （与 renderer 的 POST /api/connections 同一幂等路径，绝不重复 spawn）——spawn 的
  数秒启动时间与页面/bundle 加载重叠，首屏看到本地实例时已 ready；失败非致命
  （renderer 仍会自行尝试，实例错误态照常呈现）。CLI/standalone 形态不预启动
  （控制面契约保持按需 spawn）。

### 7.6 TransportProvider 契约（来源无关抽象，双 transport provider）

- `transport-provider.ts` 定义 `TransportProvider`：`kind`、`validateSpec`
  （白名单收口，option-injection 安全）、`buildStartArgs`（**缺省 = direct
  endpoint 模式**：无子进程，运行时探测 `probeTarget()` 并暴露
  `endpointUrl()`，如 tailnet 直连宿主）、`classifyStderr`（整行分类：
  脱敏 + 终态认证判定）、可选 `verifyUp`（端点身份验证：TCP 探测通过后、
  置 ready 前验证目标身份——dsh 使用统一身份握手
  `session/canOpenWorkspacePath`（固定小体积 boolean；老 runtime 树 404 →
  signature 路径回退 legacy `session/list` 识别为 "check or upgrade"），与本地
  02 §3.2 同判据；gateway 使用认证后 `/chamber/runtime/status` 固定 identity，使 managed
  dsh blocked/down 时恢复面仍可达；非目标服务端口绝不呈现已连接）、可选 `exec`
  （远程服务通道）。
- `transport-manager.ts` 是通用运行时：phase 机 / **两段式重连**（快速有界
  半开 jitter 退避突发 + 突发耗尽后的慢速周期重探——瞬时故障是时变的，
  error 绝不停摆，条件修复自动恢复；手动 connect/disconnect 取消在途重探）/
  环形日志 / 非秘密投影与推送 / 子进程监督（SIGTERM→SIGKILL per-child）/
  注册表（kind 迁移、重复 id 首胜丢弃）/ 就绪探测（隧道端口或直连端点 +
  端点身份验证）。就绪判据（TCP + 目标身份握手）、两段式重连与 `verifyUp`
  **确定性验证失败免重试**（`terminal` 分类——目标应答了探测但证明不是
  兼容 dsh → 第一次失败即落 error 终态，仅瞬时失败走重连）的机制细节见
  03 §2.2。**子进程加固**：exec 子进程与隧道子进程同款
  SIGTERM→SIGKILL 升级且 `disposeAsync` 等待两者全部退出（SIGTERM 忽略型
  ssh exec 不残留孤儿）；本地端口分配瞬时失败（临时端口耗尽）进入慢速
  周期重探，不停在 error。
- registry 编辑以 transport + exec generation 隔离旧异步工作：`serviceName` 与
  `remoteDshHome` 都属于 live transport fields 和 exec identity，变化时先提升
  generation/`execEpoch`，撤销旧隧道/直连尝试与所有 exec child（SIGTERM→SIGKILL），
  旧连接原先非 idle 才以新参数重启；多步 exec 下一次 spawn 以及迟到日志、状态投影、
  `serviceActive`/结果提交前都复验 generation，不能让旧代工作污染新配置。
- `ssh-provider.ts` 与 `gateway-provider.ts` 是两个 transport provider
  （按 transport 注册，17 §2.2/§9.2）：`ssh-provider.ts` 实现 `ssh`
  （`ssh -N -o ServerAliveInterval=30 -o
  ServerAliveCountMax=3 [-p <sshPort>] -L <localPort>:127.0.0.1:<remotePort>`
  隧道 + systemctl exec；认证特征/脱敏/白名单全在 provider 内）；
  `gateway-provider.ts` 实现 `http`（direct endpoint 直连，无子进程：
  端点 = 目标的 http(s) URL，scheme 由 `insecureHttp` 决定，两种 kind
  都服务——dsh 目标不注入认证头、gateway 目标按 spec kind 可注入
  `Authorization`，17 §2.1/§9.2）。
- **exec 通道（设计 13）**：`TransportExecPayload.op` 为
  `'exec'`（systemctl `start/stop/is-active/restart`、远端命令 `run`——命令名
  白名单 `dsh|cat|printf` + argv/路径白名单 + shell 元字符拒绝（`base64 -d`/
  `mkdir -p` 仅存在于固定 write-file 管线，不是可分发命令），
  见 13 §7.2）或 `'write-file'`（stdin base64 流式写 + **字节域** SHA-256 回读
  校验 + 目标前缀白名单 + **50MiB 大小上限**）。白名单 `exec` 结果同时携带
  stdout（UTF-8 视图）与 stdoutBytes（原始 Buffer）；`write-file` 回读直接流式
  计算 SHA-256，成功仅返回 status，不在主进程保留整份回读。
  plugin-sync 编排（apply/seed/materialize）全部经此通道，spec 在主进程二次
  白名单校验（applyPlugins + buildRemoteExecArgv）；materialize 的 `add file:`
  走独立的目录约束白名单分支（仅物化目录内绝对路径）。
- 新来源接入 = 新 provider + kind 注册；运行时与 UI 按 `kind` 分支即接。
  反代路径段按 kind 派生（connectionId `${kind}:${id}` → `/api/i/dsh-<id>` /
  `/api/i/gateway-<id>`，`ssh-` legacy 映射保留，17 §9.3）；renderer 侧
  base-path 构造（dsh-client-connection base-path patch）随 kind 同步。
  边界：tailscale 等网络层身份引入的是网络层访问控制，不构成 dsh 应用层
  认证面（v1 无认证边界不变；gateway 目标的认证由注册 transport 头注入
  承载，17 §9.3）。

### 7.7 窗口生命周期与崩溃恢复

- **单窗口可重建**：窗口被关闭（macOS 红色按钮）后应用保持运行（darwin 的
  `window-all-closed` 不退出）；`app.on('activate')`（Dock 图标点击）、
  `second-instance`、托盘「显示窗口」统一走 `showMainWindow()`——窗口不存在
  时按控制面 origin 重建（`createMainWindow`；启动期加载失败仍为大声失败 +
  退出，重建路径只记录不退出）。
- **渲染进程有界自动恢复**：`render-process-gone`（clean-exit 除外）或 15s
  无响应 → 60s 窗口内至多重载 3 次，超出显示错误框停止自动恢复——绝不静默
  白屏；会话数据在实例侧，重载后前端自动重连恢复。
- **崩溃留痕**：`crashReporter`（`uploadToServer:false`）落盘
  `<userData>/Crashpad`；GPU/Utility 异常退出经 `child-process-gone` 记日志。

## 8. 安全不变量

- 本节不变量与 `AGENTS.md`「Hard Facts」互为镜像（凭据纪律、loopback 边界），
  两处同源；本节为契约正文。
- 前端只连 127.0.0.1（本地 dsh 端口或隧道 localPort），**任何实例流量不直接
  出网（限定 renderer）**——renderer 只见非秘密投影，任何出网仅由主进程
  承载；**gateway http 直连例外**：直连端点为用户配置的 http(s) origin，
  由主进程 transport 直接访问，renderer 仍只见 localPort/phase 投影
  （17 §9.3）；direct-endpoint provider 的端点 URL 同样只在主进程
  （`readyUrl`），永不进 renderer；
- 传输 URL 与**私密 SSH 材料**（凭据/私钥/代理配置/IdentityFile/ProxyCommand）
  永不进 renderer/日志/持久层——renderer 只见 host/user/端口等**非秘密元数据
  投影**与 localPort/phase；ssh stderr 含密钥路径的行入环前脱敏（按行缓冲，
  跨 chunk 不绕过）；分类器可检查的单行上限为 64KiB，脱敏/分类后真正保留到每实例
  200 行 ring 的展示文本再裁到 4KiB，避免 32 个实例的最坏驻留内存按 64KiB/行放大；
- **可选密码认证（唯一例外，用户需求；明文文件兜底——用户决策）**：
  表单密码字段为瞬时输入（编辑时永不回填），经 `desktop_ssh_save_connection`
  转发后主进程**内存持有 + 明文镜像 `<userData>/ssh-passwords.json`**
  （0600、`.tmp`+fsync+rename 原子写；残留 `.tmp` 无论原 mode 为何都先
  fchmod 0600 再写秘密；写成功后才发布内存状态、启动时严格
  校验 schema；现存文件先 no-follow/普通文件/inode 校验，以打开 fd 收紧 0600 后
  才读取——密码主机重启后自动连接可用；损坏/结构非法文件保留为
  `*.corrupt` 并响亮报告，绝不静默当空集）；
  保存已收敛为主进程 `desktop_ssh_save_connection` 单事务：registry 与三类 write-only
  凭据先在主进程拍快照，按目标域验证并提交，任一步失败补偿恢复全部旧值；补偿失败
  安全 scrub 相关凭据且响亮返回，renderer 不再靠串联 setter 假装可回滚。SSH 镜像
  schema v2 将每个值绑定 `host+user+sshPort` 并在读取/注入时复验当前 registry；secret
  先落盘、registry 后落盘的崩溃只会失去可用性，不会把新口令发给旧 SSH endpoint。
  非空 legacy schema v1 无法安全证明目标，移动为唯一 `.unbound-*` 恢复文件并要求重录；
  新增/进入/离开/retarget 即使留空也强制清理隐藏的半事务值。删除只走精确
  `desktop_ssh_delete_connection(id)`：先停活连接、撤销 exact connection-target scope 的
  gateway 会话、清 durable secrets，最后删 metadata；不存在 id 为幂等 no-op；legacy
  `instances_set` 只能原样提交当前规范化 roster，不能删除；
  永不进注册表、永不记日志、实例删除/显式清除即删条目；隧道与 systemd
  exec 经 `SSH_ASKPASS_REQUIRE=force` + 临时 owner-only 0700 askpass 助手（OpenSSH
  直接执行该脚本；助手位于 `mkdtemp` 创建的每进程不可猜 0700 私有目录，目录必须
  为当前 uid 的普通目录且 inode/mode 复验通过；历史全局 `<tmp>/dsh-chamber-ssh`
  永不用于写入，EPERM/属主异常 fail closed，不在他人可替换目录继续；`<tmp>/
  dsh-chamber-ssh-<pid>-<random>/askpass-<id>.pid-<pid>.<uuid>.sh`。每次 tunnel/systemd/run
  spawn 独占一个 lease，真实 child 的 exit/error/spawn-fail 才释放并删除对应 helper；
  disconnect/removal/显式 clear 先阻止新 lease 并请求 purge，仍被 child 引用的文件延迟
  到引用归零，绝不用固定代际上限提前删在途 helper。异常进程退出后的残留由下一次
  启动清理；启动清理仅删除
  已退出进程或旧格式遗留，绝不误删并行 dev/打包实例的助手）把密码喂给系统 ssh
  ——**永不上命令行**；助手按提示文本区分「主机密钥确认 → yes」与「密码/
  口令 → 密码」，首次连接无需预先接受主机密钥。无可靠 askpass 的平台
  （v1 的 Windows：Win32-OpenSSH 助手须为 PE 可执行）在 `desktop_ssh_save_connection`
  IPC 门禁处**显式拒绝**（返回错误，绝不静默走重试死循环），密钥/agent 为
  通用路径。
- systemctl 以固定参数数组 `systemctl <action> -- <serviceName>` spawn（无 shell 拼接，
  `--` 终止 option 解析）+ serviceName 白名单
  `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`（首字符必须为字母或数字）；
- 控制面 HTTP 监听仅 loopback——v1 无认证边界，不变量靠监听面与 HTTP/WS
  来源门禁（Host 仅规范 loopback authority；Origin 仅限与当前 Host 精确同源
  或显式开发 allowlist，其他 localhost 端口也默认拒绝；`null` 一律拒绝；
  非法来源在副作用/转发前 403）维持；所有 HTTP 响应统一
  设置 CSP（`__DSH_BOOT__` 内联脚本使用逐响应随机 nonce，不开放 script
  `unsafe-inline`；`script-src` 开放 `unsafe-eval`——官方 dsh module loader
  （vendored `@deepseek-ai/loader`）对 boot manifest `__jsExpr` 配置求值依赖
  `new Function(…eval…)`，缺它渲染层主包在模块求值期即抛 EvalError、静态骨架
  永不进入 React——实机排查确认）、`nosniff`、`DENY` frame、COOP 安全头。
  Referrer policy 用 `same-origin` 而非 no-referrer（no-referrer
  下现代浏览器把同源表单提交的 Origin 序列化为 null，被本机来源门禁
  fail-closed 拒掉——登录/运维表单自锁；这些页面无跨站出站文档请求，同源策略
  对第三方同样不外泄 Referer，隐私意图不变）。
- **gateway 凭据（design 17 v2 连接模型例外，同款 write-only 纪律）**：settings 表单
  可瞬时收集 gateway token/密码并经受信 IPC（新增/更新走
  `desktop_ssh_save_connection`，单项 setter 只清除，§7.4）转发主进程；主进程仅内存持有 +
  `<userData>/gateway-secrets.json`（schema v3，0600 原子写，safeStorage 加密 blob
  优先、不可用时 0600 明文回退，17 §12），永不返回 renderer、不进注册表/
  日志；只注入已注册 gateway transport 的 `Authorization`/`Cookie` 头
  （0..2 白名单，17 §9.3）。Cookie/session key = 网络 origin + `Host` authority +
  稳定的 connection-target scope（connection id 与目标摘要）；authority 只负责路由，
  不是 ownership，因此相同 origin 的不同 direct id、复用 localPort 的不同 SSH 目标也
  绝不共享 session。exact-scope invalidation 会提升每个历史 key 的 generation，并在
  登录、Cookie 探针、Bearer fallback、401 重登每次 await 后阻止旧结果改 cache/backoff/
  auth proof 或继续联网；refresh 另有按 id 的 arm/disarm/dispose epoch，并在重试、重注册、
  重连前复验密码/token/URL/pin/authority/scope，阻止同 id 重建的迟到结果。
  `configureGatewaySessionProvider` 的 `ensureSession` / `generation` /
  `registrationAuthProof` / `setRegistrationAuthProof` / `cachedCookie` / `invalidate` hooks
  必须 all-or-none；ready 注册要求
  当前 generation 的 `cookie|bearer` auth proof，密码型目标若
  Cookie 消失且没有已验证的 Bearer fallback 则 fail closed 重连，绝不无头注册。
  gateway+HTTPS 配置 SPKI pin 时，登录、探针及 HTTP/WS 反代在 peer SPKI 匹配前不调用
  请求 `write/end`，不发送 handshake/header/credential/body 等任何应用层字节；mismatch
  显式失败。删除实例/显式清除即删凭据并撤销对应 scope。对应安全不变量
  S22（safeStorage 加密落盘）/ S23（SPKI 证书固定）/ S24（审计只记非秘密
  事件）见 design 17 §17。

## 9. 范围边界（推迟与不做）

- **推迟（维持不排期）**：flat 单列表模式（与"仅按来源分类"呈现原则有
  张力）。
- 不做（v1）：跨来源移动会话、单 store 真融合（fork runtime）、会话实时
  推送同步、远程实例管理 UI 外壳。
- fork 会话**在范围内**：官方 conversation 回合尾部分支动作（turn-tail
  `forkAt`）常驻可用；侧边栏会话行 kebab 菜单亦提供行内 fork
  （wire `sessions.fork`，对齐官方 ui-workspace），两者并存（§2.2）。
