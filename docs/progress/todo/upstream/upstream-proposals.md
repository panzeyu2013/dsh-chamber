# todo · 上游提案（chamber 不可改，等待 deepseek-harness 侧裁决）

> 分类：A · 上游依赖（等 deepseek-harness 裁决）｜状态权威：本文件 + STATUS 各对应条

> 均为上游提案，未排期；chamber不等待、不绕过。本文只留最小改法、动机事实与开放问题；上游落地后按 `docs/progress/README.md` 移出本表。

合并来源（三条独立todo）：① selection scope（`docs/design/05-connection-manager.md` §2.2.1、`06-sidebar-enhancements.md` §「client-store作用域」）；② 设置面贡献通道T3（`docs/design/05` §5、`09-client-plugin-runtime-loading.md` §4）；③ 归档wire草案（`docs/design/24-archived-session-cleanup.md` §2/§13根治面）。

## 1. N-壳宿主下持久化 selection 需要按 shell/入口作用域

上游「当前会话」是页面级单键持久化，N-ctx宿主下跨实例污染：

- 当前 pin 的取证：选择 store 在 `dsh-client-ui-workspace` 的客户端控制器构造里仍是 `createSnapshotStore({}, { persist: { name: 'dsh.sessions.current' } })`（`lib/client.js`，**无 scope 参数**；旧 pin 的取证位置 `dsh-api-session-controller` 已随上游重构迁移，第四类补丁见 design 09 §3.6）；
- `@deepseek-ai/dsh-client-store` 的 store 工厂**已支持 scope**（当前 pin 的 `create(scopeKey)` 在 scope 存在时把持久化名写成 `${persist}.${scopeKey}`，底层仍是 `localStorage` 单键读写）——缺的是调用点传 scope；
- 投影时 selection 校验后回写或清空（`current === undefined` ⇒ 清空该 store；今天清的是同一个共享单键）。

后果（真机问题1「切到远程server的会话时先闪出一个新会话」）：

1. 跨实例污染：A的current被B读到；B校验失败清空共享键（连A的持久化选择一起毁）。
2. 冷boot没有可恢复会话 ⇒ 官方 `UiWorkspaceService.watchNavigation()` 取「最近活跃工作区」→ `connectWorkspace()`（复用blank会话，否则 `sessions.create({ workspaceId })` 在宿主上真建）；每次挂壳（含后台预热/基线收割）都在远程宿主最近工作区留空白会话。
3. 单实例官方web形态无此问题（宿主形态特有）。

chamber侧缓解（不动上游事实面）：design 05 §2.2.1的open意图本地回显（揭示门/投影门/boot意图早开）消掉可感中间态；`client/early-open.ts` 的boot期早开臂只抢时间、不担正确性。无法根治：store属vendor树（不在三个fork副本内）；「逐入口代理 `window.localStorage`」在多壳异步boot交错下不安全（作用域互见、注入无法与store构造同步）——不采用。

上游最小改法：store 侧的 scope API 已落地（见上），**余下的只有调用点传 scope**：

1. scope来源给「每个entry/壳一份」的store（宿主注入basePath/instance id最自然；chamber注入 `chamberBasePath`，官方侧可用boot参数或connection base path）；
2. 持久化名加 scope 后缀，或按 scope 重建该 store（`dsh.sessions.current.<scope>`）；
3. `current === undefined` 的清空分支**只**清自己的scope（比第2条更关键：跨实例破坏来源）。

收益：各壳恢复自己上次的会话，初始导航不再凭空建空白会话。

开放问题：scope权威来源与稳定性（base path随入口形式变化，是否作为持久化身份）；旧单键的迁移/丢弃（chamber接受弃用）；是否把「会话/工作区UI选择」整体纳入scope。

## 2. 设置面的上游声明式贡献通道（T3 提案）

设置面完整桥接形态下chamber不需要该通道：桌面设置面直接渲染选中来源自己boot ctx的 `settings.section` 台账与该ctx渲染器绑定的标准座（design 05 §5/09 §4）。保留供其他宿主参照——它们仍会撞上三条上游形态硬边界：

1. 贡献是代码非数据：`dsh.client` 清单只有 `inject`/`platform`（vendor `dsh-client-modules` `manifest.ts`），无 `contributes.*` ⇒ 重宿主面**必须**实例化插件才知道贡献了什么；
2. 无设置面服务契约：自建宿主面只能提供自拼服务集；插件root `inject` 含宿主没有的服务即不激活（旧chamber形态）；
3. 泛型Remote**不可行**：贡献由生成物（`TypertRemoteContribution`）提供，`TypertLocalRegistry/RemoteRegistry.list()` 是进程内注册表，api-gateway客户端未见descriptor上线通道（`dsh-typert-protocol/src/types.ts`、`packages/dsh-api-gateway/src/client/`）⇒ 只可手工 `remote` 面，调其他命名空间在调用时失败。

提议（按价值排序）：

- **P1 `dsh.client.contributes.settings` 声明式贡献描述符**——包清单声明「在哪些设置座位贡献什么」（`sections[{id,order,label}]`/`seats`/最小 `requires` 服务集）。价值：重宿主面先读清单再决定装载；`requires` 让宿主事前判断插件能否在当前能力面激活（不必等fiber停PENDING）；为schema驱动渲染铺路。
- P2设置面服务契约（最小可注入集合）——定义并文档化稳定服务子集（`settingsScope`/`settingsSchema`/`locale`/`theme`/`remote.settings`/`remote.credentials`/`remote.llm`/`remote.pluginInventory`），插件可声明只依赖该子集。chamber把契约写在design 09 §5（作者契约），但没有机器可读声明。
- P3 Remote descriptor上线通道（或「设置面Remote子集」协议）——typert握手下发descriptor目录（或只读 `typert/describe`），重宿主面即可构造泛型Remote客户端。代价：协议面扩张 + 权限模型需上游设计。

开放问题：`contributes.settings` 与运行时 `slots.register` 的一致性校验（不一致建议宿主报诊断、不阻断）；描述符版本兼容（座位名/schema与宿主SlotMap漂移如何降级）；重宿主面实例化第三方插件的信任边界（chamber现状见design 09 §4，本提案不改）；P3落地后 `remote` stub应换泛型面，`CAPABILITY_REMOTE_EVENTS` 一类降级报告随之收敛。

## 3. 已归档会话的 wire 契约草案（根治，对齐 OpenCode 模型）

> 上游 = `deepseek-harness`（本仓不可改；落地前以vendor `dsh-client-modules/src/client/manifest.ts` 为权威复查）。design 24的归档清理域随上游 `sessions.delete` wire落地后退休。

根因（0.1.7 复核）：dsh 归档面仍**无 delete-session、也无归档可见查询**——上游的 `workspace.archiveSession`
（registry-global集合，幂等追加）已在 0.1.7 由单条 `workspace.unarchiveSession` 补齐反向；官方与chamber
默认投影同规则排除归档行（`!archived.has(id)`）；数据未丢（`sessions.list/search` 返回归档会话，集合持久化于 `<DSH_HOME>/profiles/web/**/workspace.json` 的 `global.archivedSessionIds`）。OpenCode/OpenChamber有可逆归档 + 删除 + 归档可见查询；dsh仍缺删除与可见查询两项，chamber无法只靠前端补全。

> 第 1 条（单条 `workspace.unarchiveSession`）已落地并按文首规则移出本条；未排期的浏览过滤
> （`ArchivedFilter` 镜像）登记在 STATUS 范围决策节。

2. `sessions.delete({ sessionId })`（或workspace下同义）——服务端删会话目录 + 级联subagent起源子会话 + workspace成员账目自愈（header索引重建剔除已删id）+ 清archived集合；复用 `host/session-removed` 事件。
3. （可选）`sessions.list` 行加 `archived` 标志或查询参数。保持registry-set形态则仅补2（+可选3），即可让design 24的可选「已归档浏览区」补上恢复/删除——最小改动优先。

> 其余与design 24相关的chamber侧剩余面（浏览区A未排期、控制面特权层直删B冻结）见 `docs/progress/STATUS.md` 范围决策节与 `docs/design/24-archived-session-cleanup.md`。

## 4. 会话事实通道的「静默丢帧」自愈（Swift 原生版 ui-chat 卡死根因）

> 驱动面：`dsh-client-ui-chat` 的 `chat.deepDiving`（`TurnStatus`）由官方 session 的
> `running` 位驱动，而该位只由 mux `$events` 上一条 **emit 型转发事件**
> `api-session/status` 递送（`dsh-api-session-controller` 客户端半
> `handleSessionStatus` → `handleRunning`；白名单见 `dsh-api-remotes` 的
> `remote-events.ts`，`mode: 'emit'`）。emit 无重传、`$events` 开场帧不重放会话
> 状态，而官方唯一的收敛路径 `handleConnected() → refreshList()` 只挂在**连接代际
> 重置**上 ⇒ 丢一帧或 carrier 静默半死（无 close/error）时运行位永久停在 true，
> 客户端零超时、零出口。chamber 侧阶梯见 `docs/design/14-sleep-background.md` §D4：
> L1 = 「对账 + 权威纠正」（tier-1.5 本地判定 + tier-3 用官方公开写面把权威结论
> 写进 store；只写 false、无 TTL），因此**症状在仓内确定性收敛**；但事件源本身仍会丢帧
> ——**源端根治仍在上游**（下面第 1、5、6 条）。

**上游最小改法（逐条独立、可组合）**：

1. **事实自愈**：emit 型会话事实改为周期性 summary 再断言，或客户端内建「running
   为真但 `$events` 静默 ≥N 秒 ⇒ 触发一次 `session.list` 对账」——即把 chamber 的
   L1 上移为默认行为（对上游是纯读）；
2. **可观测心跳**：`/api/remote.mux` 现只有 WS 级 ping/pong（服务端
   `websocketHeartbeatIntervalMs` 默认 2s、`MAX_MISSED_HEARTBEATS=2` 硬编码），
   浏览器完全观测不到——增加应用级 keepalive item 可让页面自判「连接是否还在投递」，
   不依赖任何 OS 事件；
3. **流期限**：`session/follow` 加首帧/空闲期限（现永久无首帧即永久 loading，见
   `STATUS.md`「会话打开停滞」）；**并把失败写成状态**：宿主/客户端任一环的首帧期限到期都应让
   `Session.openState` 落到 `'error'`（带原因），而不是停留在 `'loading'`。chamber 侧用「证据门自动重建 + 90 s 硬失败面」收敛客户端可修的部分（design 14 §D4），但宿主侧期限
   仍是「进入必有内容」的最后一块。**（已由发行版与真机证据复核：宿主仍无期限；客户端加宽阶梯已主动退役为单档 30 s，故本条仍是唯一根治。）**
   - **客户端可自修的最后一公里 = unary 引导通道**：宿主 `session/page` 是冷读，且 `session/control` baseline 的 `projections[sid].asOfSeq`（= `session.seq - 1`）是合法 `throughSeq` ⇒ 协议层存在不依赖 `session/follow` 开帧的引导路径，当前 pinned 客户端没有 unary→窗口写入者。chamber **未采纳**（与 follow 共用宿主 `sourceFor`，救不了宿主卡死；且属非契约窗口写入面），作为无 fork 档（触屏档）的候选兜底保留在此。（上面的 1/2 条同理）。
4. **让 `refresh()` 可判成败**（最便宜、且不新增 API 面）：`SessionManager.refreshList()`
   现在对「拉取失败」照常 resolve，只把 `listState` 置 `'error'`（`listError` 同存）。
   把结果显式化（`refresh(): Promise<{ ok: boolean; error?: … }>`）后，chamber 的独立 unary
   探针即可在「refresh 相位报失败」这一半分支省掉；代价是丢掉「refresh 成功但 running 未
   回灌」这一回归的检测面，故仍建议配合第 1 条。
   **更正（读 pin 源码核实）**：本提案旧文曾写「`buildListSnapshot()` 已把
   `state/phase/error` 放进快照」——不成立：客户端 `projectList()` 只把
   `ids/byId/current/phase/subagentsByParent/jobsBySession/currentAddress` 写进
   `ctx.sessions.list` 的 store 快照（`phase` 是到达生命周期），`state`/`error` 不在其中，
   因此 chamber **读不到**「refresh 是否成功」，只能靠第二条载体（独立 unary 探针）。

5. **把回执/状态暴露到 store 快照**（新增诉求，最便宜）：把 `listState`/`listError`
   （或 `refresh()` 的显式结果）投影进 `ctx.sessions.list` 的 store 快照。落地后 chamber 的
   独立 unary 探针只需在「store 仍说 running」这一歧义支保留，「refresh 成功而 running 未回灌」
   的检测也不再依赖第二条载体（现每次对账的 host 读：健康路径 = 官方 `refresh` 1 次（tier-1.5
   本地判定直接收敛）；store 仍说 running 时 = `refresh` + 两次独立探针；两次尝试都不收敛的
   病态路径上界 = 2 次 `refresh` + 4 次探针 = 6 次 host 读（外加 N=2 确认后至多一次
   `handleSessionStatus` 写回）。落地本诉求后，探针只在「store 仍说 running」这一歧义支保留。
6. **把客户端状态写面提升为契约**（新增诉求）：`ClientSessions.handleSessionStatus(
   sessionId, running)` 是具体类的公开方法（`src/client/sessions/service.ts`），一次调用
   同时写 list summaries、物化 Session 的 `running`（聊天面）与 catalog activity；但
   `ISessions` 契约只暴露 `refresh()`。把它（或语义等价的 `reconcileSummaries(rows)`）写进
   `contract/sessions.ts`，chamber 的 tier-3 写回即从「上游公开但非契约」变成受契约保护的面。chamber 侧现已把该面
   探测为 contract/concrete/none 三分（`packages/dsh-chamber-client-ui-sidebar/src/client/status-write-face.ts`，I-10）：
   契约成员一落地即走 contract 支（把真实名字加进 `CONTRACT_STATUS_WRITE_METHODS`），不再依赖具体成员名；
   vendor 契约锁在契约长出写面时先红。
7. **把「打开是否在途」暴露到契约/快照**（新增诉求）：`Session.doOpen()` 有三条
   静默留在 `loading` 的路径（非 `isRemoteFailure` 抛错；`events.open()` 返回前
   `openGeneration`/`events` 推进），而重开只有 `followCurrent()` 的 stage 移动一条**外部**
   触发。chamber 现在以共享引擎的 `open-stall = loading && openInFlight === false`（读具象成员 `Session.openPromise`：`null` = 无在途、
   缺失 = unknown）作证据门自动重开，属「上游公开但非契约」的读取；把 `openState` + 在途标志（或 `open(): Promise<…>` 的
   显式结果）写进 `SessionSnapshot`/契约后，这条自动臂即可去掉 structural slice，且上游自己也能
   在 `doOpen` 收敛时优先补一次 `open()`。**（已由发行版与真机证据复核：`doOpen` 仍只对 `isRemoteFailure` 写 `error`、其余原样 rethrow；该形态在真机与发行版均产生过永久 `loading`。）**

> **chamber 侧现状**：在**不改上游、不新增 fork**的前提下，
> chamber 用两条仓内杠杆把「丢帧 → 纠正」做成确定性收敛——① tier-1.5 本地判定（refresh 后
> store 已无 running 行即收工，**省掉一次 host 读**，并据此确认 refresh 真的回灌了）；② tier-3
> 写回（用上面第 6 条的公开方法把独立权威读的证伪结论写进官方 store；只写 false、写后自校验、
> 无 TTL，host 基线永远可以覆盖回去）。第 1/5/6 条落地后 chamber 的写回与探针都可删除（上游事实
> 通道自身可自愈）；第 2/3 条是另外两条正交的可见面/期限缺口。**曾评估但未采纳的第三条路**：
> chamber 的 seed 宿主包监听 host 的 `agent/status` 并周期性再断言 `api-session/status`
> （转发白名单是 host 全局的，`dsh-api-remotes` 的 `remote-events.ts`）——不改上游即可让所有
> 客户端免于丢帧，但只覆盖能 seed 的实例且需重启生效，暂缓（见 design 14 §D4 被否替代）。

**开放问题**：应用级 keepalive 的版本兼容（未知 item 必须被旧客户端忽略，而现客户端
对未知帧会 `failAll` 并关 socket）；心跳的隐私/体积边界；`session.list` 对账在大会话
语料上的宿主成本（chamber 一次 refresh = per-call disk walk）。

## 5. 图标资源 id 应作为组件实例私有（useId）而不是写死的 Figma id

当前 pin 已把**代码图标一族**改为实例私有 id（`useId` 产出的 `__DSH_CODE_ICON_INSTANCE__*` 前缀，
见 `dsh-client-ui-primitives` 的 `url(#…)`）——本条这一半已落地。仍写死为文档级 id 的只剩
`BrandWordmark` 的 `dsh-wordmark-whale-clip`/`-badge-clip`（`dsh-client-ui-primitives`）与附件拖拽浮层的
`dshDropOverlayClip`（`dsh-client-ui-attachment`），而 `url(#id)`/`mask` 的解析是**文档级**的。

宿主把同一个文档用于多个实例壳（chamber 的 N-ctx）时，同一 id 被逐壳重复定义；macOS WKWebView
在「新建形状首次绘制解析到未布局子树里的 clipper/mask」时整块失绘并把结果缓存住（重建元素才自愈，
属性回写/揭示都不行）。真机对照与判据见 `docs/design/05-connection-manager.md` §4.2。

上游最小改法（任一，范围已收窄到上面两族）：
1. `BrandWordmark` 的 whale/badge clip 与附件拖拽浮层的 `dshDropOverlayClip` 也按图标一族的先例用
   `useId()` 前缀/后缀化资源 id；
2. 或让这些 clip/mask 只依赖 `viewBox` 与路径本身，保留真实裁剪的那几处改用实例私有 id。

chamber 侧缓解（`packages/dsh-chamber-client-core/src/svg-resource-scope.ts`，design 05 §4.2）：不改上游、
在每个 `<svg>` 内把「自定 ∩ 自用」的资源 id 改名到文档唯一 token，外部引用复制进消费方。
未覆盖的是 gateway/mobile 独立部署的官方壳（由实例自带 bundle 渲染，见 STATUS）。

## 6. 会话状态的只读观察者与未读事实（design 17 §10.7 只读镜像 carve-out 的上游根治诉求）

背景：chamber 的 gateway 侧 watcher 需要一个**不渲染任何界面**的进程持续观察会话状态，才能在桌面关壳/关闭期间仍观察到会话状态的完成边沿（完成通知候选的 host 域证据）。当前 pin 下这条路能走通（`$events` + 每条完成边沿一次 `session/follow` 读尾巴），但有三处本可由上游消掉的尖锐面——每处的 chamber 侧现状与判据在 design 17 §10.7 与本文登记。

1. **`updatedAt` 语义请给一个契约级承诺**。当前 pin 的摘要是 `updatedAt = max(header.createdAt, sessionListMetadata.lastPromptAt)`，而 `lastPromptAt` 只在 `user/message && data.source.kind === 'user'` 推进（vendor `dsh-api-session-controller/lib/index.js` 的 `applySessionListMetadata` / `updatedAt`；事件自述见 `typert.host.js` 的 `api-session/activity` JSDoc）。若上游把「任意 durable 产出都推进 `updatedAt`」写成契约，只读客户端就能用**内容水位**（`unread ⟺ updatedAt > 已读标记`）判定未读：不需要观察者、轮询就够、手动停止天然不产生未读——这是本族问题里性价比最高的一处改动。不承诺也可以，但请明确「只在用户消息推进」为契约，以便下游按边沿轨设计（chamber 现按此口径）。
2. **turn-end 的稳定性与转发**。`turn/end.reason`（`completed | aborted{reason} | blocked | error | max-tokens | interrupted`）已在 pin 存在（`typert.host.js` 的 `SessionEventMap` 与 `TurnEndReasonMap`），chamber 用它区分「完成」与「用户停止」以闭合误报。请求两点：① 冻结为稳定契约（含 `aborted` 的 `TurnEndCancelCause` 取值域）；② 考虑把 `turn/end` 纳入 `API_REMOTE_FORWARDED_EVENTS`——现白名单没有任何会话事件（`dsh-api-remotes` 的 `remote-events.js` 仅有 `api-session/*` 与两个 request 瀑布），观察者因此必须为每条完成边沿开一次 `session/follow` 才能读到尾巴。
3. **观察者角色 / pending 投影**。经 `$events` 接入的客户端会成为 `approval/request`、`user-questions/request` 瀑布的交付目标（`dsh-api-gateway/lib/index.js` 的 `deliverRemoteEvent` / `receiveRemoteEventResult`）：静默会挂起等待中的批准，而无条件回 `{kind:'next'}` 会在没有其他下游客户端时把它结算成 unavailable。chamber 的规则是「仅当另有 mux 客户端在线且过 1.5s grace 才委派，否则保持等待」，但这本质是把上游缺失的角色区分补在了下游。请求任一：① 给只读订阅者一个 **observer 角色**（不参与 waterfall 交付）；② 或在 `session/list` 上提供 pending 投影，让只读方无需接触瀑布即可知道「等待输入」。
4. **宿主侧持久 unread/pending 事实**。当前只有「有人正在观察」时才能记录完成边沿；桌面关闭且无观察者运行的窗口内完成的会话仍会丢。若宿主为每个会话持久化「最后完成水位 + 是否未读」（或至少给出稳定的 per-session unread 投影），这类丢失就能被根除，下游无需再各自维护观察者。

   > **下游现状注记（完成未读上游对齐后）**：chamber 本地的 durable 未读账本与读水位（以及跨端读回执）已随上游对齐**整体移除**——完成未读的唯一权威是官方内存 `uiSession.sessionStatus.completionUnread`，「重载即忘」是接受的行为（design 06 §4.1/§5）。因此本条回到**纯上游诉求**：请宿主提供持久的 per-session unread/pending 投影；下游不再维护第二套观察者来补这个洞。

chamber 侧现状（非上游阻塞项，供参照）：只读镜像的边界与验收判据见 `docs/design/17-server-side-gateway.md` §10.7 与 §20；协议单一源 `packages/control-plane/src/session-state-protocol.ts`；watcher `packages/gateway/src/session-state.ts`（`/chamber/session-state*`，能力协商 + 优雅降级）。
## 7. 子代理生命周期/计数与完整性信号（P5）

背景：侧边栏父会话行的「N 个子代理运行中」读数来自 vendor 纯函数
`indexSubagentDescendants` 对当前 `session/list` 快照的投影（design 06 §4.5）。它有两个
下游无法自行消除的不确定性：

1. **没有完整性信号**：索引是对「本快照里还在的会话行」求的，缺席既可能是「没有运行中的
   子代理」，也可能是「列表不完整/超时/断连」。chamber 只能把「索引缺席」读作 unknown
   （P5 本地收口：`subagentActivity: none | running | unknown`，stale 来源上的残留计数降为
   unknown，中性呈现）。请求：在 `session/list`（或 `subagentsByParent` 旁）给出一个
   显式的完整/新鲜度位（如 `lineageAsOf`/`complete`），让客户端能区分这两者。
2. **没有生命周期边沿**：子代理结束（或行离开列表）后计数才消失，客户端无法从边沿判断
   「刚刚结束」与「从未开始」。请求：把子代理的 start/end 作为稳定事件（或纳入
   `API_REMOTE_FORWARDED_EVENTS` 的白名单），侧边栏就不必每 tick 重算谱系。

chamber 侧现状（非上游阻塞项）：`packages/dsh-chamber-client-ui-sidebar/src/shared/derive.ts`
的 `projectRuntimeFacts` 把缺席索引写成 `unknown`、`mergeRuntimeFacts` 在 stale 报告上把
`running` 降为 `unknown`，呈现层（`server-section-session-state.tsx`、`session-row-state.ts`、
`todo-attention.ts`）共用 `subagentActivityOf` 一个守卫。上游给出完整性信号后，删除该
fallback 与 `test/session-rows/session-row-state.test.ts` 里钉住它的契约测试。



## 8. 载波 open 的稳定 episode 身份（P3）

背景：chamber 曾按「请求 episode」放宽开帧预算（30 → 60 → 120 → 240 → 300 s；现已主动退役为单档 30 s），跨重试道
（`RemoteStream` 重发 → mux 新 streamId）必须保持同一身份。vendor 的 `$stream({ open: signal => … })`
回调只传一个 `AbortSignal`，generated invocation 也不接受额外参数，因此本地唯一稳定的身份是
`streamOpeningKey`（endpoint + payload 的 FNV 摘要）。后果：① 同一 endpoint+payload 的两个不同
逻辑流会共享连续超时计数（只影响节奏，不影响行为）；② 客户端无法把「同一条逻辑流的重试」与
「新的一次请求」从调用面上区分开，只能靠摘要与生命周期清理近似。

请求：给 stream 打开一个可携带的稳定身份（例如 `open(signal, { episodeId })`，或宿主为每次逻辑流
分配并在重发间保持的 token）；或直接由宿主承担首帧期限（见 §4.3 的首帧期限诉求）——客户端加宽阶梯已主动退役（单档 30 s），
上游落地后只剩客户端期限本身可再评估是否退役。

## 9. 桌面专属客户端家族的门应以宿主能力为准（非桌面宿主上的整页浮层劫持）

现象（chamber 0.4.0-beta.6 实测，Electron 与 Swift 两 flavor 同源页面均复现）：`dsh-client-ui-settings-account`
的 apply 门是 `'dshDesktop' in globalThis`（载体**存在性**），而 chamber 两 flavor 为官方快捷键/更新座位必须
常驻该载体（S-52/S-54）⇒ 家族激活，并在同一载体门下注册 `shell.overlay` 的 `desktop-onboarding` 全屏浮层
（`OnboardingSurface`）：portal 到 `document.body`、把 `#root` 置 `opacity: 0` + `inert`，而浮层状态由
桌面 account/configForms 事实驱动——非官方桌面宿主上没有表单把它结算，于是整页停在「正在加载设置…」
（`onboardingLoading`），且 `displayed === null && status === 'loading'` 时**无视 `visible`** 渲染 ⇒ 永久
接管页面（chamber 侧触发面 = 连接任意实例后的冷启动）。

上游最小改法（二选一或并用）：① 门改成**宿主能力就绪**（`dshOnboarding`/桌面 configForms 有值）而不是载体
存在性；② 控制器给 `host.status === 'loading' || account === undefined` 的 loading 态一个期限或 error 收敛，
不要无期限渲染 loading 面。收益：任何未来以 `dshDesktop` 为门的桌面专属客户端家族都不会在非官方桌面宿主上
夺屏。chamber 侧现状 = 覆盖集跳过（design 09 §3.5 有意跳过名单③），上游落地后该覆盖条目可删（同处已写退出
条件）。

## 10. bundle rev 应由内容派生（跨宿主/跨安装稳定）

现象：pin 的 `dsh-client-modules` 用 `artifactRevision` 对 bundle 文件求
`sha1(mtimeMs, ctimeMs, size)`（前 12 hex），并把它写回被服务 bundle 的 `sourceMappingURL`。两个后果：
① **同内容跨宿主/跨安装 rev 通常不同**（ctime；仅同一底层文件的硬链接例外），而页级 first-load-wins 按 id+rev 认领，于是同一个插件
挂在两个实例（本地 + gateway 等）时永久报 `instance-version-conflict`——chamber 只能把诊断中性化并说明
rev 是文件元数据派生的构建标识；② rev 只在**重建/替换**bundle 文件时变化，因此 chamber 的额外行加载必须
保留一轮有界恢复（重拉宿主图 + 按 fresh URL 重载），否则一次重建就会让旧 URL 404 掉整轮 boot。

上游最小改法：`artifactRevision` 改为对 bundle **字节**求内容哈希（combo/整图 rev 随之稳定）。收益：同内容
跨宿主/重装 rev 一致，跨实例冲突诊断整类消失，恢复轮只剩"文件真的变了"这一种情形。

chamber 侧现状 = 中性诊断文案（design 09 §3.5）+ 一轮有界恢复。退出条件：上游落地后，删 design 09 §5 的
「vendor 侧根治」开放项与 §3.5 的恢复轮必要性说明（保留超时/迟到语义）。

## 11. 座席声明应可转移：注册所有者与渲染者分离

现象（chamber N-ctx 壳实测）：`sidebar.session.row.leading` / `sidebar.session.row.hover` 只能由**注册所有者**在其 `children` 表里声明，
而实际渲染它们的是另一份行组件。上游 ui-workspace 把两座席签进自己的 workspace-browser 注册，同时只有该注册的 `Rows.tsx` 会渲染它们；
chamber 用自建多来源侧栏渲染会话行（不挂载官方 workspace-browser），既不能转交声明、也不能用未声明的座席——重复声明按上游语义抛错，
于是官方 schedule 插件的行标记与悬停卡任务列表在 chamber 恒不渲染。chamber 现行解法 = 构建期删掉上游注册里的两行，再由 chamber 侧栏声明并渲染
（vendor 补丁第四类第二形态，design 09 §3.6）。

上游最小改法（任一）：① 座席声明可转移/可委托——所有者能声明「由 X 渲染」（`register` 返回可转交的声明句柄，或声明时指定 renderer 而不绑定自身行实现）；
② 把这类行座席提升为**页面级**座席（无所有者，任何会话行实现都可渲染；同 id 声明幂等合并）。
收益：任何自建行/自建侧栏的宿主壳都能渲染官方插件的行贡献，不必构建期改写上游注册；chamber 侧该 vendor 补丁可随之退役。

## 12. workspace 删除的 order/remove 两帧应原子化（client store 的 unranked-sink）

现象（chamber 真机）：删除一个 workspace / git worktree 时，侧栏对应行**先滑到本 section 最后一行、再消失**。

根因链（pinned 0.2.0-rc.2 取证）：宿主 `dsh-workspace` 的 `deleteKnown` 先以 pending-delete 标记落盘
"不含该 id 的 `workspaceIds`"，随后才删表行；`dsh-api-workspace-controller` 的 `WorkspaceFeed.changed`
在第一次 state 变化上就发 `order` 帧，`remove` 帧要等表删除。客户端
`ClientWorkspaceModel.installOrder` 把新 order 未列的项按 `rank.get(id) ?? Number.MAX_SAFE_INTEGER` 排到最后
——两帧之间被删行仍在 `items` 里、却站在列表末尾（`items` 是宿主壳与侧栏渲染序的唯一来源），keyed 行动效
于是把它 FLIP 到尾部；`remove` 帧到达再淡出。

上游最小改法（任一）：① `WorkspaceFeed.changed` 的 state 变化分支里，若 pending-delete 的 id 已不在
`nextOrder` 却仍在 `knownIds`，当场补发 `remove`（与 order 变化同步发布；客户端 store 的微任务代际合并
会把中间态整帧吃掉，所有 follower 一并修好）；② `installOrder` 对不在 `workspaceIds` 里的项保留其当前位置，
而不是沉底（该规则同时承担 `upsert` 新行的落点语义，需与创建流程一并裁决）。

chamber 侧现状 = 删除意图（pre-delete 半边，design 05 §2.2.1；`packages/dsh-chamber-client-core/src/workspace-removal.ts`）：
wire 之前发布意图，投影只摘"观察到下沉"时尾部 pending 段中真正沉下来的那部分；外部/他端删除没有本仓事实、仍是未补偿面。
退出条件：上游落地后删除该补偿与 STATUS「无法控制的差异」条，本节移出本表。

