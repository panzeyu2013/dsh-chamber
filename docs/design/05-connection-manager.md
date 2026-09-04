# 05 · 连接管理器形态（v1 定稿：多来源会话统一导航）

> 本软件 = dsh 的**桌面连接管理器**（v1 定稿，2026-08-14）：Electron 包装
> dsh 官方前端，本地与远程实例同等接入；**多来源 session/workspace 在
> dsh 原生侧边栏内平等呈现**（仅按来源分类，远程来源以颜色标注——codex
> 式"导航统一、执行按来源路由"）。首屏 = 本地实例的完整 dsh shell
> （纯 dsh UI，无 chamber 外壳）。
> 控制面 = 托管 + 反代 + 静态服务（v1 无认证/审计，loopback-only）。
> **连接模型 / 凭据 / 安全面以 `17-server-side-gateway.md`（2026-09
> 连接模型 v2）为权威**：kind dsh|gateway × transport ssh|http × 认证 ×
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
- 会话行带**运行指示点**（相对时间列不显示——见 06 §4.3，2026-08 确认
  暂不回归）。
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
- **点击来源分组头**（非当前来源）= 切换活动来源视图：
  `chamberBridge.requestActivateSource(sourceId)` → App 层仅切换该来源
  shell（N-ctx），不打开会话。
- **归档会话确认后立即从列表消失**：`archivedSessionIds` 过滤在 derive 层
  （`shared/derive.ts` 纯函数），不等聚合轮询。
- 会话行悬停操作（v1 最小集，走该来源自己的 API）：重命名/归档（kebab
  菜单 + 独立归档按钮）；workspace 行：新建会话（`+` 按钮，在该
  workspace 下创建并打开）、重命名、删除（kebab 菜单）。wire 缺失的
  方法不做（如删除会话），不发明协议。
- 已连接来源提供"新建工作区"（来源头部 `+` 按钮）：打开该来源的应用内
  目录浏览对话框（§4
  同一 browse 表面，不做手敲路径表单），确认的路径走该来源的
  workspace.create（路径须为该实例宿主上已存在的目录；远程路径 = 远端
  服务器路径）。
- 悬停操作与新建工作区成功后，经 chamberBridge.requestRefresh(sourceId)
  立即重拉该来源聚合（v1 轮询 + 操作后刷新）。
- **v1 交互面扩展（2026-08，详见 06）**：来源头 hover 操作簇新增**会话排序
  切换**（显式排序菜单——官方 ViewOptionsMenu 模式，勾选标记当前模式，
  取代早期盲切循环，06 §2.2）；workspace 头/会话行**双击重命名**
  （会话行单击立即打开、二次点击进入重命名，06 §2.2）；workspace 头/会话行
  悬停显示**信息卡片**（标题/会话数/相对时间/状态点/复制标题，06 §7）。
- New Session → 当前活动来源新建会话。

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
  ready 来源都有完整生产者时不创建聚合定时器。连接/生产者状态变化立即重估，
  用户动作的 `requestRefresh` 只对无完整生产者来源单次拉取；已挂载完整生产者由同一
  host-store 变更直接推送，避免动作成功后再补 RPC。每个来源的 not-ready → ready
  连接代边沿固定执行一次 unary：生产者会对同内容快照去重，而 App 在断线时已清空
  聚合，该单次权威拉取保证“内容未变”的重连也恢复列表；稳定 ready 代仍为零轮询。
  若该拉取瞬时失败，生产者的 loading 撤回 + idle baseline 重发负责恢复，不会永久停在
  error。推快照按来源序号使较旧在途 pull 失效。

## 3. 桥接层（chamberBridge，renderer 共享单例）

放在自研侧边栏包的 `shared/` 下；chamber App 层（main entry）与侧边栏插件
（chamber bundle entry）共同 import，vite 共享 chunk 保证运行时单例。

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
  requestRefresh(sourceId: string): void                  // 侧边栏动作成功后调用
  onRefresh(listener: (sourceId: string) => void): () => void  // App 层订阅
  requestActivateSource(sourceId: string): void           // 点击来源分组头调用
  onActivateSource(listener: (sourceId: string) => void): () => void  // App 层订阅
  registerInstanceRuntimeProducer(sourceId: string, sourceFingerprint: string): { // 每个已挂载 ctx 一代生产者
    report(report: InstanceRuntimeReport): void         // token 命中才发布
    clear(): void                                       // generation-safe teardown
  }
  onRuntimeReport(listener: (sourceId: string, report: InstanceRuntimeReport | undefined,
                             sourceFingerprint: string | undefined) => void): () => void
  registerInstanceSnapshotProducer(sourceId: string, sourceFingerprint: string): { // 每个已挂载 ctx 一代生产者
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
}
```

**App 层（renderer main entry）写入职责**：
- 启动即 auto-start 本地实例（连接行不存在则 `POST /api/connections`）；
  按注册表 auto-connect 远程实例（`desktopSsh.connect`）。
- 状态合并发布：控制面 `/health`（health-events 推送流）+
  `/api/connections`（30s）+ desktopSsh status 推送（onStatusChanged）+
  已挂载 ctx 的完整快照上报；仅无完整生产者的 ready 来源 30s unary 兜底 →
  `chamberBridge.publish`；另在每个 not-ready → ready 连接代边沿执行一次 unary，
  收敛生产者同内容去重后的聚合空窗。拉取失败的来源带 `aggregateError` 文本发布。
  每行同时携带当前权威 `sourceFingerprint`；共享发布签名必须纳入该字段，
  使“同 id、其余投影不变”的 replacement 仍会通知来源所有者。
- 订阅 `onOpenSession` → 激活对应来源视图 + `openInstanceSession`（§4）。
- 订阅 `onActivateSource` → 仅切换活动来源视图（不打开会话）。
- 订阅 `onRefresh` → 仅无完整生产者的来源立即重拉；已挂载完整生产者由同一
  host-store 变更直接推送，避免操作后重复 RPC。
- 订阅 `onRuntimeReport` → 把各来源的运行时事实合并进 `server.runtime`
  （仅附加、不覆盖轮询字段；来源断连即清，06 §4）。runtime 与 snapshot 两条
  producer 均以注册时单调 token + 主进程下发的 opaque `sourceFingerprint` 认领
  **精确来源代**：App 只接收仍与当前权威 roster proof 相等的报告。来源删除或传输
  身份编辑时，App 在等待异步 shell dispose 前先同步调用
  `retireInstanceProducers(sourceId)` 撤销 token/cache 并广播 withdraw；旧 ctx 随后的
  异步 `report/clear` 全部失效，即使 replacement 尚未注册也不能污染同 id 新代。
- 订阅 `onInstanceSnapshot` → 以内容签名 identity-preserving 合并，并使旧 pull
  失效；订阅 `onPluginDiagnostic` → 合并到来源标题异常标记与插件设置页详情。

## 4. N-ctx 与切换（沿用，机制不变）

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
- **boot 串行与 teardown 纪律（2026-08-28）**：页面级模块物化仍由全局 boot
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
- **切换实现（修正：即时隐藏 + View Transition + 骨架屏，content-visibility）**：
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
  任何时刻无黑帧；`prefers-reduced-motion`、transition 在途或不支持时降级
  即时切换。未就绪视图（首次打开/仍在 boot）进入**骨架屏**
  （`.instance-loading`：rail + sidebar + 主区占位块 + 转圈与服务器名文案，
  `--dsw-alias-*` 主题 token 底色，z-index 盖住 shell 内 dsh 启动页——不再
  需要 opacity 隐藏技巧），settle 后第二次 View Transition 换入真实内容
  （失败则 chamber 覆盖层呈现 + 重试 + 服务器切换，见下；`bootInstanceShell` 的 settle 态经 `.then(setShell)`
  落地）。**失败呈现修订（2026-08）**：
   失败不再由各 InstanceView 自绘（旧 `.instance-fatal`，仅有重试、无导航），
   而是由 App 在活动视图上统一渲染 `.fatal-overlay` 覆盖层——失败报告 +
   重试（`retryToken` 递增 → InstanceView 复位重 boot）+ **服务器切换行**
   （`.fatal-servers`：chamber 级逃生通道，不依赖任何 shell 挂载）。原因：
   boot 失败 = 该视图的 dsh shell 从未挂载，而侧边栏（多来源导航）在 shell
   内——若不提供 chamber 级覆盖层，用户会被失败报告困在当前视图（只能整页
   刷新），违反「一个实体的失败不得抹除/阻断无关健康实体」不变量。dsh 壳
   内自绘的失败页（`AppWebEntry` 加载页的 fail-loud 报告）也统一经
   `AppWebEntry.bootError`（拷贝包 seam）上浮为 chamber 可见的失败态
   （shell.ts 失败分支 dispose 该 entry，重试干净重 boot）。**首启竞态修复
   （2026-08，05 §4）**：模块表（`window.__DSH_MODULES__` + `__ModuleLoader__`
   sink）经 boot.ts 导出的幂等 `ensureWebModuleSystem` 在**任何 bundle 脚本
   执行前**装好（shell.ts 在 collectExtraRows 预加载之前调用，run() 经同一
   helper 收编）——旧顺序下首个带额外行的 boot 会让官方 bundle 在 sink 安装
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
  timer/cancel handle，不能把 timer-driven open 永久挂起。
- **每 entry Context 私有注入（2026-08-28 N-ctx 复核）**：`AppWebEntry`
  提供 `configureContext(ctx)` seam；shell.ts 创建 entry 时用闭包把该视图自己的
  `chamberInstanceId`、`chamberBasePath` 与主进程签发的
  `chamberSourceFingerprint` 写入其 cordis Context，chamber-entry
  再从该 Context 读取 basePath 并显式配置 `ConnectionPlugin`。不同 entry 不再通过
  `window.__DSH_BASE_PATH__` 或页面级 `chamber-knob.ts` 交换 boot 参数，因此并行/
  交错 boot 不会串用来源或代理前缀；shell 在任何 graph/module 副作用之前仅接受
  精确 `local`、规范 `dsh-<raw-id>` / `gateway-<raw-id>` 或兼容迁移的 legacy
  `ssh-<raw-id>`（raw id 明确排除保留字 `local`），且强制 basePath 等于
  `/api/i/<instanceId>`；`chamber-knob.ts` 随该修复删除。
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
  表单——2026-07-31 one-route 简化与 2026-07-27 native picker note
  明确否定手敲路径交互）。

## 5. 连接设备页

- chamber 自研插件包 `packages/dsh-chamber-client-ui-settings-connections`
  （`@dsh-chamber/dsh-client-ui-settings-connections`），注册进 dsh 设置模态
  的 `settings.section` 槽（id `connections`，order 30，在 agent-presets 之后）。
- 「dsh 运行时」段（design 18 §3.6/§9，2026-09 per-server 修订）：同为
  chamber 自研 `settings.section`（id `dsh-runtime`，order 31），注册在选中
  服务器的子上下文 ledger、紧随 agent-presets 渲染；**connections 是壳的
  固定 nav 入口**（在分隔线之下、不占 ledger order），故「dsh 运行时」在
  视觉上位于 server 段列表内 agent-presets 之后。local = 完整运行时管理面，
  gateway = 经反代触达该 gateway 的 `/chamber/runtime`，**dsh 直连（ssh/http）
  = 不挂载**（dsh 直连无 `/chamber` 面、无 ssh exec 管理通道——「ssh = 版本只读
  行」为过期表述，2026-12 审计 F4 勘误：18 §3.6/AGENTS/design 17 §3 一致口径；
  该来源设置段不渲染 dsh-runtime 分节）。**不再位于 chamber 全局「通用」视图**
  （design 15 的 `__general` 控制组不含运行时块）。
- **「重启 dsh」动作只在本地与 gateway 两源**（2026-12 审计 F4 勘误——「三种来源
  均含」为过期表述；design 18 §3.6 项 8，刷新插件挂载）：local = 控制面事务接口
  `restartLocal()`（design 18 §9.3，与健康状态机重启单飞行串行化——**不是**连接页
  裸 启动/停止 的组合）；gateway = `POST /chamber/runtime/restart`（经
  `/api/i/gateway-<id>/chamber/*` 反代，202 + status 轮询）+ `POST
  /chamber/runtime/start`（design 21 决策 12 停机恢复：stopped/error/
  restart-exhausted，卡片「启动实例」入口）。二次确认 + 状态行，与健康状态机
  `restarting` 单飞行互斥、applying 期间禁用。ssh（dsh 直连）的 systemd
  `restart_service` 属**连接管理面**（重启 gateway/dsh 服务本身，非插件模型动词，
  design 21 §3 目标语境差异登记），dsh（ssh/http）直连不挂载 dsh-runtime 段、无
  插件模型重启动作。（http 直连来源无任何重启动作，design 17 §3。）
- **职责划分**：连接页本地卡的 启动/停止 = 连接生命周期（开机常驻与否）；
  「dsh 运行时」段的 重启 dsh = 运行时维护（刷新插件挂载、恢复服务）——两者
  不合并、文案不混用（起停不改运行时事实，重启不改指针/版本）。
- 内容：本地实例卡（/health 状态徽标 + /api/connections 行端口/label +
  启动/停止（二次确认）+ host 日志只读）+ 远程主机卡片列表（label +
  user@host:port + phase 徽标 + 隧道 localPort + serviceName + logSummary；
  连接/断开 + systemd 起停/查询 + 日志 Modal（logs/logs_clear）+ 编辑 +
  删除 + dashed"添加主机"卡 → Modal 表单）。
- **design 21 增补（2026-12）**：卡片日志入口命名区分（「连接日志」= 本机连接
  通道事件 / gateway 卡「网关主机日志」= 服务器侧 gateway 进程与托管 dsh spawn
  日志；图标去重）+ gateway 卡「重启 dsh」/「启动实例」动作（phase 门控 + 每卡
  单飞 + 共享 pollGatewayReady 轮询，多用户中断确认文案）+ **单一插件管理模型
  视图（2026-12 plan 24 已合体为唯一 `PluginDialog` 组件）**：统一区域 = 诊断横幅
  （状态名 + message 去重）→ chamber 内建组件表（client-graph / git-worktree /
  mobile 移动端入口三行，badge 化；mobile 仅 gateway 源显示、标注网关随发行物
  注入）→ 第三方插件区（已安装列表 + 逐行卸载 + 添加：spec 输入 + npm 搜索 +
  文件夹导入）→ 恢复/动作行；gateway 添加双通道（registry spec 直装 +
  文件夹直推）已接线；「变更记录」区已移除（后端 journal/备份保留）；恢复撤销
  仅 gateway（崩溃/恢复态恢复横幅）；http 直连只读不变；恢复提示 r0–r4 文案双
  后端同权；契约与余留见 design 21 §6.6/§10 勘误⑥⑦。
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

## 6. 源码复用与构建链（拷贝补丁包 2 个 + 自研客户端插件 6 个 + 宿主包 2 个）

- pnpm + `vendor/harness-packages` 符号链接（外部 dsh 源码，**永不修改**）；
  要修改的包必须拷入本仓 `packages/`。
- 拷贝补丁包（保持官方包名 `@deepseek-ai/*`，遮蔽 vendor workspace 条目）：
  - `packages/dsh-client-connection/`——base 路径参数化补丁；chamber N-ctx 由
    chamber-entry 从每个 `AppWebEntry` 私有 Context 的 `chamberBasePath` 显式配置
    `ConnectionPlugin`，构造时一次解析不可变 prefix，并同时传给 HTTP unary、两条
    WebSocket downlink 与 generic RPC/Typert carrier；页面 transport 覆盖 HTTP/WS 时，
    generic RPC 仍收到同一 prefix 与该 transport 的 fetch。未配置时保留官方 web
    兼容顺序（legacy `window.__DSH_BASE_PATH__`，再回落空 prefix 直连 `/api`），但
    chamber 运行链不再写该全局。该接缝由
    `test:connection` 的 carrier-assembly 行为门与独立 `typecheck:connection` 源码门
    固定，不能只靠字符串/AST 检查；
  - `packages/dsh-client-web/`——`boot.ts` N-ctx 模块表共享 seam + 公开
    `runtimeCtx` getter（实例 shell 打开会话的 seam）+ `configureContext` 同步注入
    seam + 可等待的异步 `dispose()`。真实 `AppWebEntry.run()` 的 Context 注入顺序由
    `test:client-web` 的 configure-context boot 用例固定（不是模拟 shell 文本断言）。
- 自研插件包（`@dsh-chamber/*` 前缀，替换/扩展官方插件注册）：
  - `packages/dsh-chamber-client-ui-sidebar/`——**chamber 自研侧边栏插件**（包名
    `@dsh-chamber/dsh-client-ui-sidebar`，拷贝官方 ui-sidebar 结构改造：保留
    几何/折叠/孔位声明，会话区改为多来源统一列表）+ `shared/aggregate-store.ts`
    （chamberBridge）+ `shared/instance-api.ts`（每实例 unary 客户端，
    App 层与插件共享一份，vite 共享 chunk）；
  - `packages/dsh-chamber-client-ui-settings-connections/`——自研连接设置插件
    （§5，`settings.section` id `connections`）；
  - `packages/dsh-chamber-client-ui-settings-bridge/`——自研设置壳插件（§5 同款
    讨论，`sidebar.settings` 槽 priority -1 shadow 官方 SettingsRoot，
    服务器下拉 + 子 ctx 官方 settings 子集渲染）。子 ctx 缓存所有权绑定
    `(sourceId, sourceFingerprint)`：权威 roster 删除来源或在同 id 下更换 proof 时，
    立即退役并 dispose 所有受影响的已选/未选缓存；异步装配结果提交前再校验
    捕获的 proof 与当前 roster，迟到的旧代结果只 dispose、不进入缓存。
  - `packages/dsh-chamber-client-ui-layout/`——官方 ui-layout 壳插件的 chamber
    fork（仅替换 layout store：`sidebarWidth` 经侧边栏共享 view-prefs store
    播种/回写，钳位 [264,420]，覆盖 id；替换官方 ui-layout 注册，见设计 06）。
  - `packages/dsh-chamber-client-ui-git/`——设计 08 的 chamber 内建 Git
    Worktree 插件：占用 `sidebar.git`，页面级 singleton 以 30s 单飞读取各实例
    topology，并编排 create/workspace/session 与 Git-first remove saga；它不把
    Git 事实塞进 App aggregate，也不暴露任意 argv/path mutation。
  - `packages/dsh-chamber-client-ui-open-in/`——设计 17 的 chamber 内建桌面打开
    插件：占用 `conversation.session.header.utilities`，按当前 N-ctx 的 source/workspace
    选择本机 Finder 或 VS Code；能力探测与执行只经 preload 的 trusted IPC 到
    Desktop 主进程，无 host 插件、无 seed、无控制面执行面。
- 自研宿主包（随 chamber 分发、运行于每个 dsh 实例进程）：
  - `packages/dsh-host-client-graph/`——设计 09 的只读 client boot graph Remote；
  - `packages/dsh-chamber-host-git-worktree/`——设计 08 的领域限定 Git Remote，
    与该实例 `workspaceRegistry`/live agents 同用户、同文件系统做权威守卫；
    Desktop 与控制面均不执行 Git。
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
    （`/api/i/<id>`）调 chamber host 包 `@dsh-chamber/dsh-host-client-graph` 的
    Remote `clientGraph/graph` 取该实例宿主组合的客户端插件 boot 图，按
    `CHAMBER_COVERED_IDS`（`packages/renderer/src/chamber-covered.ts`：复合已覆盖
    + 页面自有 id）去重，预加载剩余 bundle
    （`/api/i/<id>/plugins/<pkg>/client.js?rev=…`），经 boot.ts `extraRows` seam
    合并进 boot rows（详见设计 09）。
  - **双 host 包与 seed（设计 08/09）**：`packages/dsh-host-client-graph` 与
    `packages/dsh-chamber-host-git-worktree` 都提交 esbuild `dist/index.js`
    （`@deepseek-ai/*` external）；控制面 `host-graph-seed.ts` 幂等 seed 所有
    已构建包进 `$DSH_HOME/profiles/web/node_modules/@dsh-chamber/*/`，并把
    `client-graph` / `git-worktree` insert 合并到单一
    `<stateDir>/dsh-chamber-graph.patch.yml`。每次 spawn 注入同一 `--patch`
    （`webProfileArgs(port, patchPath?)`）；任一产物缺失只跳过对应行，不产生
    悬空 insert。远程 ready-time seed 同样一次探测/一次 overlay 合并写，见设计 13。

## 7. 控制面 / 桌面契约（沿用，无认证面）

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

### 7.4 IPC（preload 白名单；2026-08 扩展插件编排面，设计 13）

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
- 桌面 open-in 面（设计 16/20，无实例内执行面）：
  `dsh-chamber:open-in-apps`（本机 app 能力协商，非秘密投影）与
  `dsh-chamber:open-in`（appId/instanceId/path/sourceFingerprint 主进程统一校验后
  拉起 Finder/VS Code）。`sourceFingerprint` 是主进程内存签发、随 roster 投影的
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
  （远端 seed 模块 A 宿主包）、`desktop_ssh_plugin_materialize_add`
  （本地路径包物化：pack → ssh 传输 → 远端 `add file:`）、`desktop_pick_directory`
  （主进程目录选择）；
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
  置 ready 前验证目标身份——dsh 使用 `host.describe` 信封探测，与本地 02 §3.2
  同判据；gateway 使用认证后 `/chamber/runtime/status` 固定 identity，使 managed
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
  03 §2.2。**加固（2026 audit M2/M10）**：exec 子进程与隧道子进程同款
  SIGTERM→SIGKILL 升级且 `disposeAsync` 等待两者全部退出（SIGTERM 忽略型
  ssh exec 不残留孤儿）；本地端口分配瞬时失败（临时端口耗尽）进入慢速
  周期重探，不再永久停在 error。
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
- **exec 通道（2026-08 扩展，设计 13）**：`TransportExecPayload.op` 为
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

### 7.7 窗口生命周期与崩溃恢复（2026-08-17 落地）

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

## 8. 安全不变量（沿用 AGENTS.md）

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
- **可选密码认证（唯一例外，2026-08 用户需求；明文文件兜底——用户决策）**：
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
  永不进入 React，2026-08-20 实机排查）、`nosniff`、`DENY` frame、COOP 安全头。
  Referrer policy 用 `same-origin` 而非 no-referrer（2026-09 实机定位：no-referrer
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

## 9. 分期

- 已落地范围：P1 基线（§2/§3）、P2 连接设备页（§5）、侧边栏完善三轮（06 §1-§7）。
- **已实现（2026-08）**：fork 会话——官方 conversation 回合尾部分支动作
  （turn-tail `forkAt`）常驻可用；侧边栏会话行 kebab 菜单亦提供行内 fork
  （wire `sessions.fork`，对齐官方 ui-workspace）。
- **推迟（维持不排期）**：flat 单列表模式（与"仅按来源分类"呈现原则有
  张力）。
- 不做（v1）：跨来源移动会话、单 store 真融合（fork runtime）、会话实时
  推送同步、远程实例管理 UI 外壳。
