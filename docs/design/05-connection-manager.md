# 05 · 连接管理器形态（v1 定稿：多来源会话统一导航）

> 本软件 = dsh 的**桌面连接管理器**（v1 定稿，2026-08-14）：Electron 包装
> dsh 官方前端，本地与远程实例同等接入；**多来源 session/workspace 在
> dsh 原生侧边栏内平等呈现**（仅按来源分类，远程来源以颜色标注——codex
> 式"导航统一、执行按来源路由"）。首屏 = 本地实例的完整 dsh shell
> （纯 dsh UI，无 chamber 外壳）。
> 控制面 = 托管 + 反代 + 静态服务（v1 无认证/审计，loopback-only）。
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
        │    /api/i/ssh-<id>/* → 隧道 localPort
        │    v1 无认证门禁：匿名可达（仅 loopback 监听）
        ├─ 本地实例托管：spawn/健康状态机/reaper/host-logs
        └─ 管理 REST：/health、/api/connections(local)、/api/host/logs
        桌面主进程（main.ts 薄引导 + ipc-*.ts 领域 wiring 装配；A1 拆分后
        IPC 面在各 ipc-*.ts，通道名与契约不变）
        ├─ transport-manager：通用传输运行时（phase 机 / 两段式重连 —
        │    快速有界 jitter 退避突发 + 慢速周期重探 /
        │    环形日志 / 非秘密投影 / 子进程监督 SIGTERM→SIGKILL）
        ├─ TransportProvider 接口（transport-provider.ts）：来源无关契约 —
        │    spec 校验 / 传输进程 argv（**必填**——无 direct-endpoint 直连
        │    模式，provider 恒拥有本地隧道子进程）/
        │    stderr 分类与脱敏 / 可选 exec 通道；v1 仅实现 `ssh` provider
        │    （ssh-provider.ts：ssh -N -o ServerAlive… -L 隧道 + systemd exec）
        ├─ 实例注册表：<userData>/ssh-instances.json {id,label,kind,host,user,sshPort,remotePort,serviceName,remoteDshHome}（schema 以 03 §2.2 为准）
        └─ IPC（preload 白名单；通道名常量单源 ipc-events.ts，§7.4）
        远程服务器：dsh（API 面 profile，无需 web 前端）+ systemd + SSH
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
  error。推快照按来源序号使较旧在途 pull 失效。**2026-10 修订（创建/fork
  延迟修复）**：用户动作的 `requestRefresh` 拉取改走独立的 mutation
  generation 域——帧推送不再作废它（推送可能携带 session-added 与
  workspace-changed 两条有序帧之间的中间态截面），只有更新的变更拉取或
  not-ready 清扫能作废；其失败路径仍保留共享序号守卫（在途期间的推送事件
  不得被 error 覆盖）。判定逻辑为纯函数
  `renderer/src/aggregate-refresh.ts` `refreshPullStillCurrent`（单测覆盖）；
  创建/fork 会话的「未分类」瞬时摆放由 06 §2.2 的成员宽限与
  parent-accounted 规则抑制。

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
  id: string                      // 'local' | 'ssh-<id>'
  kind: 'local' | 'ssh'
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
  reserveInstanceProducerGeneration(sourceId: string, generation: number): void // 异步 boot 前占代
  registerInstanceRuntimeProducer(sourceId: string, generation: number): { // 每个已挂载 ctx 一代生产者
    report(report: InstanceRuntimeReport): void        // generation + token 命中才发布（06 §4.2）
    clear(): void                                      // generation-safe teardown
  }
  onRuntimeReport(listener: (sourceId: string, report: InstanceRuntimeReport | undefined) => void): () => void  // App 层订阅
  registerInstanceSnapshotProducer(sourceId: string, generation: number): { // 每个已挂载 ctx 一代生产者
    report(snapshot: InstanceSnapshot | undefined): void // undefined = baseline 不完整，恢复兜底
    clear(): void                                         // generation-safe teardown
  }
  onInstanceSnapshot(listener: (sourceId: string, snapshot: InstanceSnapshot | undefined) => void): () => void
  reportPluginDiagnostic(sourceId: string, diagnostic: PluginGraphDiagnostic): void
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
- 订阅 `onOpenSession` → 激活对应来源视图 + `openInstanceSession`（§4）。
- 订阅 `onActivateSource` → 仅切换活动来源视图（不打开会话）。
- 订阅 `onRefresh` → 仅无完整生产者的来源立即重拉；已挂载完整生产者由同一
  host-store 变更直接推送，避免操作后重复 RPC。
- 订阅 `onRuntimeReport` → 把各来源的运行时事实合并进 `server.runtime`
  （仅附加、不覆盖轮询字段；来源断连即清，06 §4）。
- 订阅 `onInstanceSnapshot` → 以内容签名 identity-preserving 合并，并使旧 pull
  失效；订阅 `onPluginDiagnostic` → 合并到来源标题异常标记与插件设置页详情。

## 4. N-ctx 与切换（沿用，机制不变）

- N 个 AppWebEntry（共享一份静态模块表，v1 允许各自创建）；每来源一个 shell，
  hide/show 切换，会话保活。**视图生命周期 = 注册表条目生命周期**：只有
  来源从注册表删除才卸载其视图并 dispose shell（`disposeInstanceShell`，
  shell.ts）——连接失败/手动断开是瞬时事实（投影为图标/徽标），不回收
  视图：设置页卡片与侧边栏分组都锚定注册表，视图若随瞬时状态消失会
  造成三面不匹配（侧边栏分组头仍可激活一个立即被回收的视图）。boot
  排队/在途时被删除的实例在 settle 时拆掉新 entry（cancelledBoots，绝不
  遗留僵尸 ctx）；被回收的视图若是当前视图则回落到 local（常驻）。
  插件图诊断同样受 boot generation 门控：已取消/已被重试取代的旧 boot
  即使迟到完成 graph 请求，也不能覆盖新一代的诊断。
  **例外（2026-10，闲置预热回收）**：auto-prewarmed（从未被用户主动打开，
  `autoPrewarmedRef`）的视图可在**零 running 且零 pending**（运行时事实
  通道 06 §4；有运行/待交互会话即可能触发通知边沿，逐出不得丢通知——
  设计 19 §3.2 边沿定义依赖）且**闲置超过 IDLE_EVICT_MS（15 分钟）**后
  闲置回收（与注册表删除共用 `teardownView`：dispose shell + release
  client；逐出写 PREWARM_COOLDOWN_MS 冷却、冷却期内不重新预热防抖动），
  回收后该来源落入既有 30s unary 兜底与点击重挂路径；**用户主动打开过
  的视图保持常驻**（视图生命周期 = 注册表条目生命周期的语义对用户打开
  的视图不变）。
- **boot 预算与串行化（2026 audit H1/M1，契约）**：整个 boot 任务（含
  host-graph 通道与 `AppWebEntry.run()` 各阶段）受 `BOOT_TIMEOUT_MS` 预算
  约束——超时即取消（记录 cancelledBoots、立即 dispose 已构造的 entry、
  拒绝排队 opens），调用方与 admission 链都在预算内 settle；正常 boot 仍
  串行进入，但超时任务的底层异步工作可能在后台迟到恢复。路由事实因此绝不
  存在页面级可变旋钮中：shell 把 `{instanceId, basePath, generation}` 作为
  `AppWebEntryOptions.chamberContext` 传入，boot.ts 校验二者精确对应后，在任何
  loader entry 创建前绑定到**该 entry 自己的 Cordis root context**；
  chamber-entry 再把同一 `basePath` 显式传给 connection client。新 boot 与迟到
  的旧 continuation 即使短暂重叠，也不可能串用来源。`dispose()` 同时充当
  AppWebEntry 的取消信号：每个异步阶段恢复后都检查，已取消 entry 不得重新
  mount；迟到恢复再做一次幂等 root sweep。取消阈值**单调、永不删除**（与
  bootGenerations 同范式——注册成功清阈值依赖队列 FIFO，被超时打破；迟到
  settle 观察阈值后拆除而非注册）。
  dispose 串行化：
  `AppWebEntry.dispose()` 是异步 teardown，同 ID 重 boot 必须先 await 旧
  teardown 完成（pendingDisposes）；旧 boot 的底层 continuation 仍可能迟到，
  因此 shell 在 boot 开始/超时/销毁时先占单调 producer generation floor，
  ctx 内 runtime/snapshot producer 必须携带同一 generation，旧代迟到注册本身
  即为 no-op（不只防旧 clear）。timeout 与迟到 settle 对同一个 entry 的重复
  dispose 按 entry 身份去重且共享同一 Promise，绝不能用第二次调用覆盖仍在
  执行的真实 teardown Promise。
  **L2（来源域键）**：双击 pending 与 blank-ghost 宽限均按
  `(serverId, sessionId)` 建键——克隆实例携带相同 UUID 时跨来源点击/幽灵槽
  绝不串状态（`data-chamber-section` 提供点击目标的来源归属）。
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
  首次切换在点击时已就绪；预热与用户触发 boot 共享 shell.ts 串行队列。
  不支持 content-visibility 的浏览器降级为保留 layout 的 visibility 方案
  （同样无闪烁）（styles.css `.instance-view.instance-hidden`）。
- `openInstanceSession(sourceId, sessionId)`（shell.ts）：boot 未就绪先入队，
  原调用 Promise 保持 pending；settle 后经 `AppWebEntry.runtimeCtx.sessions`
  （拷贝包 seam，§6）分发，只有 runtime 接受才 resolve，dispatch/boot/dispose/
  68s 总等待超时均 reject；正常 boot 经共享 admission 链串行进入，预算过期
  后按上面的 immutable per-entry routing + cancellation 契约安全推进后续 boot。
- 当前来源判定：shell 在构造 AppWebEntry 时传入精确匹配的
  `{instanceId, basePath, generation}`；`packages/dsh-client-web/src/chamber-context.ts`
  在该 entry 的 Cordis root context 上提供 `ctx.chamberInstanceId` 与
  `ctx.chamberConnectionBasePath`、`ctx.chamberBootGeneration`。chamber-entry 在
  注册任何插件前 fail-closed 校验三者，并将 basePath 显式交给 connection
  plugin；不存在模块级或 window 级的 chamber 路由状态。
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
- 内容：本地实例卡（/health 状态徽标 + /api/connections 行端口/label +
  启动/停止（二次确认）+ host 日志只读）+ 远程主机卡片列表（label +
  user@host:port + phase 徽标 + 隧道 localPort + serviceName + logSummary；
  连接/断开 + systemd 起停/查询 + 日志 Modal（logs/logs_clear）+ 编辑 +
  删除 + dashed"添加主机"卡 → Modal 表单）。
- 操作全走现有 `desktop_ssh_*` IPC 与 `/api/connections`；表单收非秘密
  元数据（id/label/host/user/sshPort/remotePort/serviceName，id 白名单
  `^(?!local$)[a-zA-Z0-9_-]{1,64}$`（禁 `local`、限长 1–64，transport-provider
  常量），端口 1–65535），SSH 认证默认走系统 ssh-agent/
  默认密钥；**可选密码字段**（§8 例外）：经 `desktop_ssh_set_password`
  转发主进程（内存 + `<userData>/ssh-passwords.json` 明文镜像，0600 原子写），
  表单永不记录、编辑时永不回填——**SSH 材料（除该瞬时输入外）永不进
  renderer**。
- **`~/.ssh/config` 自动发现**：主进程读取并投影非秘密字段
  （alias/hostName/user/port，跳过通配符条目；IdentityFile/ProxyCommand/
  凭据不投影），经 `desktop_ssh_config_list` 供添加表单选择填充；
  手写解析器（无依赖），文件缺失 = 空集、不可读 = 响亮 {error}。
- **端口语义**：`remotePort` = 远端 127.0.0.1 上 dsh web 监听端口（隧道
  目标，必填）；`sshPort`（可选）= SSH 守护端口（null = ssh 默认 22 /
  config Port，非空时隧道与 systemd exec 均带 `-p`）。
- 样式遵循 dsh 设计语言：CSS modules + `--dsw-alias-*` token +
  ui-primitives（Button/Modal/Tooltip/Input/Pill/图标）。
- 实例默认仍按注册表自动连接、本地自动启动；本页提供显式管理与诊断入口。

## 6. 源码复用与构建链（拷贝补丁包 2 个 + 自研客户端插件 6 个 + 宿主包 2 个）

- pnpm + `vendor/harness-packages` 符号链接（外部 dsh 源码，**永不修改**）；
  要修改的包必须拷入本仓 `packages/`。
- 拷贝补丁包（保持官方包名 `@deepseek-ai/*`，遮蔽 vendor workspace 条目）：
  - `packages/dsh-client-connection/`——base 路径参数化补丁（`resolveInstanceBasePath`：
    显式参数 → `window.__DSH_BASE_PATH__` 兼容兜底 → 默认 `/api`；chamber
    一律从 entry root context 传显式参数，不读取 window 兜底）；
  - `packages/dsh-client-web/`——`boot.ts` N-ctx 模块表共享 seam + 公开
    `runtimeCtx` getter（实例 shell 打开会话的 seam）。
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
    服务器下拉 + 子 ctx 官方 settings 子集渲染）。
  - `packages/dsh-chamber-client-ui-layout/`——官方 ui-layout 壳插件的 chamber
    fork（仅替换 layout store：`sidebarWidth` 经侧边栏共享 view-prefs store
    播种/回写，钳位 [264,420]，覆盖 id；替换官方 ui-layout 注册，见设计 06）。
  - `packages/dsh-chamber-client-ui-git/`——设计 08 的 chamber 内建 Git
    Worktree 插件：占用 `sidebar.workspace.git`（v0.1.4 起，见设计 08 §4），
    页面级 singleton 以 30s 单飞读取各实例
    topology，并编排 create/workspace/session 与 Git-first remove saga；它不把
    Git 事实塞进 App aggregate，也不暴露任意 argv/path mutation。
  - `packages/dsh-chamber-client-ui-open-in/`——设计 16/17 的 chamber 内建
    open-in 插件（原 vscode 插件演进）：`conversation.session.header.utilities`
    槽 open-in 按钮（本地 Finder + 本地/远程 VS Code，主进程 OpenInApp 注册表 +
    `dsh-chamber://` OS 深链），零控制面执行面。
- 自研宿主包（随 chamber 分发、运行于每个 dsh 实例进程）：
  - `packages/dsh-host-client-graph/`——设计 09 的只读 client boot graph Remote；
  - `packages/dsh-chamber-host-git-worktree/`——设计 08 的领域限定 Git Remote，
    与该实例 `workspaceRegistry`/live agents 同用户、同文件系统做权威守卫；
    Desktop 与控制面均不执行 Git。
- 前端入口复用 `packages/renderer/`：vite 构建时把 workspace 包 alias 到源码；
  `chamber-entry.ts` 复合 entry 挂整棵 dsh 客户端树（connection→typert→
  gateway→remotes→runtime→locale→theme→**layout（chamber ui-layout fork 替换
  官方注册）**→**chamber 侧边栏（替换官方）**→**Git Worktree 插件**→
  settings×4→conversation→…→全量 ui-*）。
- **启动图清单 = 单 entry + 每实例宿主图额外 entry（设计 09）**：
  - 页面清单 `__DSH_BOOT__` = `{rev, entries:[{id, url, rev, immediately?}]}`
    （wire 契约以 vendor `dsh-client-modules/src/client/manifest.ts` 为权威）；
    构建期写死**单 entry**（`@dsh-chamber/app` chamber composite bundle），
    bundle = vite 产物 `/assets/chamber-<hash>.js`（**裸 URL，无 `?rev=`
    查询串**——2026-08 双执行修复后移除；下一行的每实例额外 entry 带
    `?rev=` 不受影响）。构建链 =
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
- **桌面消费控制面共享协议（A2，2026 重构批次）**：control-plane 的
  `rpc-envelope.ts` / `cordis-inserts.ts` 从 `src/index.ts` 导出；desktop 经
  `control-plane-module.ts` 双路径 facade 消费（打包态 → `build-control-plane.mjs`
  编译产物 `dist/control-plane/`，dev/测试 → workspace 源码）——ssh-provider 的
  信封探测与 plugin-sync 的 insert 渲染不再本地复刻，跨包逐字节一致由
  `cross-package-contract.test.ts` 守卫。

## 7. 控制面 / 桌面契约（沿用，无认证面）

### 7.1 代理路径（唯一入口面）

- `/api/i/local/*` → 本地实例；`/api/i/ssh-<id>/*` → 该实例隧道。
- HTTP 全量透传（响应头白名单收敛）、WS upgrade（events.mux/events.host）、
  SSE 直通；路径剥前缀转发；**v1 无认证边界**（loopback-only，03 §3.2）。
- 无隧道（phase != ready）→ 503 明确错误（不静默）。

### 7.2 REST（管理面）

- `GET /health`、`GET/POST/PATCH/DELETE /api/connections`（local）、
  `GET /api/host/logs`。认证/审计路由与模块已随 v1 收敛移除。

### 7.3 PlaneHandle

`{start(), stop(), startLocal(), localProcessAlive(), port, connectionState,
instanceId}` +
`registerInstanceTransport(connectionId, baseUrl)` /
`unregisterInstanceTransport(connectionId)`（隧道 ready/断开时主进程上报
`ssh:<id>` → `http://127.0.0.1:<隧道 localPort>`）；`webDistDir?` 静态服务
（`/`、`/assets/*`、`/manifest.json`、index.html 注入 `__DSH_BOOT__`）。

### 7.4 IPC（preload 白名单；2026-08 扩展插件编排面，设计 13）

- `dsh-chamber:info`；`desktop_ssh_instances_get/set`（spec 含 kind/sshPort、
  serviceName 与 remoteDshHome）、`desktop_ssh_set_password`（主进程内存 + 0600
  明文文件兜底，§8）、`desktop_ssh_config_list`（`~/.ssh/config` 非秘密投影）、
  `desktop_ssh_connect/disconnect/status/logs/logs_clear`、
  `desktop_ssh_start_service/stop_service/is_active/restart_service`（systemctl，
  serviceName 白名单 `^[a-zA-Z0-9_.-]+$`）；
- chamber 设置面（设计 14 D7，chamber 全局运行设置，非秘密）：
  `dsh-chamber:settings-get`（查询当前设置 + 平台能力门控）、
  `dsh-chamber:settings-set`（应用并持久化 `<userData>/chamber-settings.json`，
  失败 loud `{error}`，绝不落半个设置）、推送 `dsh-chamber:settings-changed`、
  推送 `dsh-chamber:system-resume`（OS 唤醒，载荷 `{timestamp}`，渲染端立即
  重连——设计 14 D4）；
- 插件同步面（设计 13，远端 dsh plugin 编排经 provider exec 通道，spec 白名单
  见 13 §7.2）：`desktop_ssh_plugin_list/plugin_apply`（add/remove/restart，
  restart 需布尔值）、`desktop_local_plugin_list/add/remove`（本地实例插件，
  另含 `desktop_local_plugin_add_file`——本地路径包物化）、`desktop_npm_search`
  （npm 搜索，best-effort）、`desktop_ssh_seed_host_graph`（远端 seed 模块 A
  宿主包）、`desktop_ssh_plugin_materialize_add`（本地路径包物化：pack → ssh
  传输 → 远端 `add file:`）与 `desktop_ssh_plugin_materialize_add_pick`（目录
  选择物化，主进程目录选择）；
  > 目录选择面统一为应用内 browse 对话框（§4）后，旧 `desktop_pick_directory`
  > 主进程通道已移除（2026-08），不再存在。
- `desktop_ssh_status_changed` 推送（隧道相位即时投影）、
  `desktop_ssh_instances_changed` 推送（注册表增删改后即时重拉 roster；
  renderer 另有 30s 轮询兜底）。
- 其余通道族（同属 preload 白名单，契约以各自设计文档为权威，此处不展开）：
  `dsh-chamber:update-state/check/download/open-release/update-state-changed`
  （设计 11）、`dsh-chamber:open-in-apps/open-in` + `dsh-chamber:deep-link-intent`
  （设计 16/17）、`dsh-chamber:notify/notifications-ready/notification-open`
  （设计 19）。
- 传输 URL 永不进 renderer；renderer 只见 localPort/phase 投影（含 `kind`）。
- **所有 invoke handler**（`dsh-chamber:*` 与 `desktop_*` 全部通道）必须同时
  满足：sender 是当前主窗口 WebContents、senderFrame 是其 mainFrame、frame
  URL 精确属于当前控制面 origin（pathname 恰为 `/`）；否则抛
  `ipc_sender_forbidden`。窗口拒绝新窗口，并在
  `will-navigate` / `will-redirect` 阶段阻断离开控制面 origin，防止 preload
  主机能力暴露给被导航页面。
- **通道名常量单源（2026 重构批次 B8）**：主进程侧通道名集中为
  `packages/desktop/ipc-events.ts` 的 `IPC_CHANNELS` 常量（handle 与 send
  全部通道）；preload 受单文件自包含构建约束（build-preload.mjs）不 import
  该模块，同名重复字面量由 `ipc-surface-mirror.test.ts` 字符串级守卫（主侧
  handle/send 集合 == 预加载侧 invoke/on 集合；主侧无裸字面量；预加载字面量
  均为已知常量值）。本节清单以该常量为准维护。

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

### 7.6 TransportProvider 契约（来源无关抽象，v1 仅 `ssh`）

- `transport-provider.ts` 定义 `TransportProvider`：`kind`、`validateSpec`
  （白名单收口，option-injection 安全）、`buildStartArgs`（**必填**——每个
  provider 恒拥有一个本地隧道子进程；v1 无 direct-endpoint 直连模式，运行时
  不探测 probeTarget、不暴露 endpointUrl）、`classifyStderr`（整行分类：
  脱敏 + 终态认证判定）、可选 `verifyUp`（端点身份验证：TCP 探测通过后、
  置 ready 前验证远端真是 dsh——ssh 实现为 `host.describe` 信封探测，
  与本地 02 §3.2 同判据，非 dsh 服务端口绝不呈现已连接）、可选 `exec`
  （远程服务通道）。
- `transport-manager.ts` 是通用运行时：phase 机 / **两段式重连**（快速有界
  半开 jitter 退避突发 + 突发耗尽后的慢速周期重探——瞬时故障是时变的，
  error 绝不停摆，条件修复自动恢复；手动 connect/disconnect 取消在途重探）/
  环形日志 / 非秘密投影与推送 / 子进程监督（SIGTERM→SIGKILL per-child）/
  注册表（kind 迁移、重复 id 首胜丢弃）/ 就绪探测（隧道本地端口 + 端点身份
  验证）。就绪判据（TCP + dsh 身份握手）、两段式重连与 `verifyUp`
  **确定性验证失败免重试**（`terminal` 分类——目标应答了探测但证明不是
  兼容 dsh → 第一次失败即落 error 终态，仅瞬时失败走重连）的机制细节见
  03 §2.2。**加固（2026 audit M2/M10）**：exec 子进程与隧道子进程同款
  SIGTERM→SIGKILL 升级且 `disposeAsync` 等待两者全部退出（SIGTERM 忽略型
  ssh exec 不残留孤儿）；本地端口分配瞬时失败（临时端口耗尽）进入慢速
  周期重探，不再永久停在 error。
- `ssh-provider.ts` 是 v1 唯一实现：`ssh -N -o ServerAliveInterval=30 -o
  ServerAliveCountMax=3 [-p <sshPort>] -L <localPort>:127.0.0.1:<remotePort>`
  隧道 + systemctl exec；认证特征/脱敏/白名单全在 provider 内。
- **exec 通道（2026-08 扩展，设计 13）**：`TransportExecPayload.op` 为
  `'exec'`（systemctl `start/stop/is-active/restart`、远端命令 `run`——命令名
  白名单 `dsh|cat|printf`（可分发；`base64`/`mkdir` 仅内联于 write-file 管线）
  + argv/路径白名单 + shell 元字符拒绝，见 13 §7.2）或 `'write-file'`（stdin base64 流式写 + **字节域** SHA-256 回读
  校验 + 目标前缀白名单 + **50MiB 大小上限**）。成功结果同时携带 stdout
  （UTF-8 视图）与 stdoutBytes（原始 Buffer）——二进制内容校验在字节域进行。
  plugin-sync 编排（apply/seed/materialize）全部经此通道，spec 在主进程二次
  白名单校验（applyPlugins + buildRemoteExecArgv）；materialize 的 `add file:`
  走独立的目录约束白名单分支（仅物化目录内绝对路径）。
- 新来源接入 = 新 provider + kind 注册；运行时与 UI 按 `kind` 分支即接。
  注意存量耦合点：反代路径映射（/api/i/<segment>/*，instance-proxy 目前
  硬编码 `ssh-<id>` 段）与 renderer 侧 base-path 构造（dsh-client-connection
  base-path patch）对新 kind 需要同步扩展。
  边界：tailscale 等网络层身份引入的是网络层访问控制，不构成 dsh 应用层
  认证面（v1 无认证边界不变）。

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

- 前端只连 127.0.0.1（本地 dsh 端口或隧道 localPort），任何实例流量不直接出网；
  就绪后的传输 URL（隧道 localPort 监听地址）同样只在主进程内部使用
  （`readyUrl`，transport-manager.ts），永不进 renderer；
- 传输 URL 与**私密 SSH 材料**（凭据/私钥/代理配置/IdentityFile/ProxyCommand）
  永不进 renderer/日志/持久层——renderer 只见 host/user/端口等**非秘密元数据
  投影**与 localPort/phase；ssh stderr 含密钥路径的行入环前脱敏（按行缓冲，
  跨 chunk 不绕过）；
- **可选密码认证（唯一例外，2026-08 用户需求；明文文件兜底——用户决策）**：
  表单密码字段为瞬时输入（编辑时永不回填），经 `desktop_ssh_set_password`
  转发后主进程**内存持有 + 明文镜像 `<userData>/ssh-passwords.json`**
  （0600、`.tmp`+fsync+rename 原子写；残留 `.tmp` 无论原 mode 为何都先
  fchmod 0600 再写秘密；写成功后才发布内存状态、启动时严格
  校验 schema——密码主机重启后自动连接可用；损坏/结构非法文件保留为
  `*.corrupt` 并响亮报告，绝不静默当空集）；
  保存顺序按注册表存在性（2026 final review）：**编辑**既有主机时密码先行、
  密码失败则注册表不动（无需回滚）；**新增**主机时注册表先行（主进程拒绝
  为未注册 id 存密码）再落密码，密码失败回滚本次元数据保存；回滚 IPC
  异常时重新读取权威注册表并按真实状态保留编辑态，避免重复新增；
  永不进注册表、永不记日志、实例删除/显式清除即删条目；隧道与 systemd
  exec 经 `SSH_ASKPASS_REQUIRE=force` + 临时 owner-only 0700 askpass 助手（OpenSSH
  直接执行该脚本；`<tmp>/
  dsh-chamber-ssh/askpass-<id>.pid-<pid>.<uuid>.sh`，传输停止即删；启动清理仅删除
  已退出进程或旧格式遗留，绝不误删并行 dev/打包实例的助手）把密码喂给系统 ssh
  ——**永不上命令行**；助手按提示文本区分「主机密钥确认 → yes」与「密码/
  口令 → 密码」，首次连接无需预先接受主机密钥。无可靠 askpass 的平台
  （v1 的 Windows：Win32-OpenSSH 助手须为 PE 可执行）在 `desktop_ssh_set_password`
  IPC 门禁处**显式拒绝**（返回错误，绝不静默走重试死循环），密钥/agent 为
  通用路径。
- systemctl 以参数数组 spawn（无 shell 拼接）+ serviceName 白名单；
- 控制面 HTTP 监听仅 loopback——v1 无认证边界，不变量靠监听面与 HTTP/WS
  来源门禁（Host 仅规范 loopback authority；Origin 仅限与当前 Host 精确同源
  或显式开发 allowlist，其他 localhost 端口也默认拒绝；`null` 一律拒绝；
  非法来源在副作用/转发前 403）维持；所有 HTTP 响应统一
  设置 CSP（`__DSH_BOOT__` 内联脚本使用逐响应随机 nonce，不开放 script
  `unsafe-inline`；`script-src` 开放 `unsafe-eval`——官方 dsh module loader
  （vendored `@deepseek-ai/loader`）对 boot manifest `__jsExpr` 配置求值依赖
  `new Function(…eval…)`，缺它渲染层主包在模块求值期即抛 EvalError、静态骨架
  永不进入 React，2026-08-20 实机排查）、`nosniff`、`DENY` frame、no-referrer
  与 COOP 安全头。

## 9. 分期

- 已落地范围：P1 基线（§2/§3）、P2 连接设备页（§5）、侧边栏完善三轮（06 §1-§7）。
- **已实现（2026-08）**：fork 会话——官方 conversation 回合尾部分支动作
  （turn-tail `forkAt`）常驻可用；侧边栏会话行 kebab 菜单亦提供行内 fork
  （wire `sessions.fork`，对齐官方 ui-workspace）。
- **推迟（维持不排期）**：flat 单列表模式（与"仅按来源分类"呈现原则有
  张力）。
- 不做（v1）：跨来源移动会话、单 store 真融合（fork runtime）、会话实时
  推送同步、远程实例管理 UI 外壳。
