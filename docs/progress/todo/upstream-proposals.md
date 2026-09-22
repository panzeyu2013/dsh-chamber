# todo · 上游提案（chamber 不可改，等待 deepseek-harness 侧裁决）

> 状态：均为上游提案，未排期；chamber不等待、不绕过。本文只留最小改法、动机事实与开放问题；上游落地后按 `docs/progress/README.md` 移出本表。

合并来源（2026-12，三条独立todo）：① selection scope（`docs/design/05-connection-manager.md` §2.2.1、`06-sidebar-enhancements.md` §「client-store作用域」）；② 设置面贡献通道T3（`docs/design/05` §5、`09-client-plugin-runtime-loading.md` §4）；③ 归档wire草案（`docs/design/24-archived-session-cleanup.md` §2/§13根治面）。

## 1. N-壳宿主下持久化 selection 需要按 shell/入口作用域

上游「当前会话」是页面级单键持久化，N-ctx宿主下跨实例污染：

- `@deepseek-ai/dsh-api-session-controller`（pin `0.1.5-rc.2` 客户端半）`SessionRuntime` 构造里 `createSnapshotStore({}, { persist: { name: 'dsh.sessions.current' } })`（`packages/api/session-controller/src/client/sessions/service.ts:225-228`）；
- `@deepseek-ai/dsh-client-store` 的 `attachPersistence`（`packages/client/store/src/index.ts:146`）直接读写 `localStorage.getItem/setItem(name, …)`，无scope维度；
- 投影时selection校验后回写或清空（`current === undefined` ⇒ `this.selection.set({})`，同文件 `:628-645`）。

后果（2026-12真机问题1「切到远程server的会话时先闪出一个新会话」）：

1. 跨实例污染：A的current被B读到；B校验失败清空共享键（连A的持久化选择一起毁）。
2. 冷boot没有可恢复会话 ⇒ 官方 `UiWorkspaceService.watchNavigation()` 取「最近活跃工作区」→ `connectWorkspace()`（复用blank会话，否则 `sessions.create({ workspaceId })` 在宿主上真建）；每次挂壳（含后台预热/基线收割）都在远程宿主最近工作区留空白会话。
3. 单实例官方web形态无此问题（宿主形态特有）。

chamber已落地缓解（不动上游事实面）：design 05 §2.2.1的open意图本地回显（揭示门/投影门/boot意图早开）消掉可感中间态；`client/early-open.ts` 的boot期早开臂只抢时间、不担正确性。无法根治：store属vendor树（不在三个fork副本内）；「逐入口代理 `window.localStorage`」在多壳异步boot交错下不安全（作用域互见、注入无法与store构造同步）——不采用。

上游最小改法：`dsh-client-store` 已支持scope（`defineStore.create(scopeKey)` 里 `persistKey = scopeKey === undefined ? decl.persist : ``${decl.persist}.${scopeKey}`，`packages/client/store/src/index.ts:221-224`，pin `fb2c4b9e` = `dsh-v0.1.5-rc.2`），缺的只是调用点传scope：

1. scope来源给「每个entry/壳一份」的store（宿主注入basePath/instance id最自然；chamber已注入 `chamberBasePath`，官方侧可用boot参数或connection base path）；
2. 持久化名加scope后缀，或 `defineStore.create(scope)` 重建该store（`dsh.sessions.current.<scope>`）；
3. `current === undefined` 的清空分支**只**清自己的scope（比第2条更关键：跨实例破坏来源）。

收益：各壳恢复自己上次的会话，初始导航不再凭空建空白会话。

开放问题：scope权威来源与稳定性（base path随入口形式变化，是否作为持久化身份）；旧单键的迁移/丢弃（chamber接受弃用）；是否把「会话/工作区UI选择」整体纳入scope。

## 2. 设置面的上游声明式贡献通道（T3 提案）

2026-12完整桥接修订后chamber已不需要该通道：桌面设置面直接渲染选中来源自己boot ctx的 `settings.section` 台账与该ctx渲染器绑定的标准座（design 05 §5/09 §4）。保留供其他宿主参照——它们仍会撞上三条上游形态硬边界：

1. 贡献是代码非数据：`dsh.client` 清单只有 `inject`/`platform`（vendor `dsh-client-modules` `manifest.ts`），无 `contributes.*` ⇒ 重宿主面**必须**实例化插件才知道贡献了什么；
2. 无设置面服务契约：自建宿主面只能提供自拼服务集；插件root `inject` 含宿主没有的服务即不激活（旧chamber形态）；
3. 泛型Remote**不可行**：贡献由生成物（`TypertRemoteContribution`）提供，`TypertLocalRegistry/RemoteRegistry.list()` 是进程内注册表，api-gateway客户端未见descriptor上线通道（2026-12调研：`dsh-typert-protocol/src/types.ts`、`packages/dsh-api-gateway/src/client/`）⇒ 只可手工 `remote` 面，调其他命名空间在调用时失败。

提议（按价值排序）：

- **P1 `dsh.client.contributes.settings` 声明式贡献描述符**——包清单声明「在哪些设置座位贡献什么」（`sections[{id,order,label}]`/`seats`/最小 `requires` 服务集）。价值：重宿主面先读清单再决定装载；`requires` 让宿主事前判断插件能否在当前能力面激活（不必等fiber停PENDING）；为schema驱动渲染铺路。
- P2设置面服务契约（最小可注入集合）——定义并文档化稳定服务子集（`settingsScope`/`settingsSchema`/`locale`/`theme`/`remote.settings`/`remote.credentials`/`remote.llm`/`remote.pluginInventory`），插件可声明只依赖该子集。chamber已把契约写在design 09 §5（作者契约），但没有机器可读声明。
- P3 Remote descriptor上线通道（或「设置面Remote子集」协议）——typert握手下发descriptor目录（或只读 `typert/describe`），重宿主面即可构造泛型Remote客户端。代价：协议面扩张 + 权限模型需上游设计。

开放问题：`contributes.settings` 与运行时 `slots.register` 的一致性校验（不一致建议宿主报诊断、不阻断）；描述符版本兼容（座位名/schema与宿主SlotMap漂移如何降级）；重宿主面实例化第三方插件的信任边界（chamber现状见design 09 §4，本提案不改）；P3落地后 `remote` stub应换泛型面，`CAPABILITY_REMOTE_EVENTS` 一类降级报告随之收敛。

## 3. 已归档会话的 wire 契约草案（根治，对齐 OpenCode 模型）

> 上游 = `deepseek-harness`（本仓不可改；落地前以vendor `dsh-client-modules/src/client/manifest.ts` 为权威复查）。design 24的归档清理域随上游 `sessions.delete` wire落地后退休。

根因：dsh归档单向不可见——上游只有 `workspace.archiveSession`（registry-global集合，幂等），无unarchive/delete-session；官方与chamber投影同规则排除归档行（`!archived.has(id)`）；数据未丢（`sessions.list/search` 返回归档会话，集合持久化于 `<DSH_HOME>/profiles/web/**/workspace.json` 的 `global.archivedSessionIds`）。OpenCode/OpenChamber有可逆归档 + 删除 + 归档可见查询，manager只做UI；dsh三项全缺，chamber无法只靠前端补全。

1. `workspace.unarchiveSession({ sessionId })`——与 `archiveSession` 对称、幂等移除；复用既有 `host/archived-sessions-changed` 事件与 `workspace.list.archivedSessionIds` 投影，客户端零新协议。
2. `sessions.delete({ sessionId })`（或workspace下同义）——服务端删会话目录 + 级联subagent起源子会话 + workspace成员账目自愈（header索引重建剔除已删id）+ 清archived集合；复用 `host/session-removed` 事件。
3. （可选）`sessions.list` 行加 `archived` 标志或查询参数。保持registry-set形态则仅补1+2，即可让design 24的可选「已归档浏览区」补上恢复/删除——最小改动优先。

> 其余与design 24相关的chamber侧剩余面（浏览区A未排期、控制面特权层直删B冻结）见 `docs/progress/STATUS.md` 范围决策节与 `docs/design/24-archived-session-cleanup.md`。

## 4. 会话事实通道的「静默丢帧」自愈（2026-12，Swift 原生版 ui-chat 卡死根因）

> 驱动面：`dsh-client-ui-chat` 的 `chat.deepDiving`（`TurnStatus`）由官方 session 的
> `running` 位驱动，而该位只由 mux `$events` 上一条 **emit 型转发事件**
> `api-session/status` 递送（`dsh-api-session-controller` 客户端半
> `handleSessionStatus` → `handleRunning`；白名单见 `dsh-api-remotes` 的
> `remote-events.ts`，`mode: 'emit'`）。emit 无重传、`$events` 开场帧不重放会话
> 状态，而官方唯一的收敛路径 `handleConnected() → refreshList()` 只挂在**连接代际
> 重置**上 ⇒ 丢一帧或 carrier 静默半死（无 close/error）时运行位永久停在 true，
> 客户端零超时、零出口。chamber 侧阶梯见 `docs/design/14-sleep-background.md` §D4：
> 2026-12 起 L1 变成「对账 + 权威纠正」（tier-1.5 本地判定 + tier-3 用官方公开写面把权威结论
> 写进 store；只写 false、无 TTL），因此**症状已能在仓内确定性收敛**；但事件源本身仍会丢帧
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
   `Session.openState` 落到 `'error'`（带原因），而不是停留在 `'loading'`。chamber 侧 2026-09-21
   起用「证据门自动重建 + 90 s 硬失败面」收敛客户端可修的部分（design 14 §D4），但宿主侧期限
   仍是「进入必有内容」的最后一块。
   - **（2026-09-21 评审）客户端可自修的最后一公里 = unary 引导通道**：宿主 `session/page` 是冷读，且 `session/control` baseline 的 `projections[sid].asOfSeq`（= `session.seq - 1`）是合法 `throughSeq` ⇒ 协议层已存在不依赖 `session/follow` 开帧的引导路径，当前 pinned 客户端没有 unary→窗口写入者。chamber 本轮**未采纳**（与 follow 共用宿主 `sourceFor`，救不了宿主卡死；且属非契约窗口写入面），作为无 fork 档（触屏档）的候选兜底保留在此。（上面的 1/2 条同理）。
4. **让 `refresh()` 可判成败**（最便宜、且不新增 API 面）：`SessionManager.refreshList()`
   现在对「拉取失败」照常 resolve，只把 `listState` 置 `'error'`（`listError` 同存）。
   把结果显式化（`refresh(): Promise<{ ok: boolean; error?: … }>`）后，chamber 的独立 unary
   探针即可在「refresh 相位已判失败」这一半分支省掉；代价是丢掉「refresh 成功但 running 未
   回灌」这一回归的检测面，故仍建议配合第 1 条。
   **更正（2026-12 读 pin 源码核实）**：本提案旧文曾写「`buildListSnapshot()` 已把
   `state/phase/error` 放进快照」——不成立：客户端 `projectList()` 只把
   `ids/byId/current/phase/subagentsByParent/jobsBySession/currentAddress` 写进
   `ctx.sessions.list` 的 store 快照（`phase` 是到达生命周期），`state`/`error` 不在其中，
   因此 chamber **读不到**「refresh 是否成功」，只能靠第二条载体（独立 unary 探针）。

5. **把回执/状态暴露到 store 快照**（2026-12 新增诉求，最便宜）：把 `listState`/`listError`
   （或 `refresh()` 的显式结果）投影进 `ctx.sessions.list` 的 store 快照。落地后 chamber 的
   独立 unary 探针只需在「store 仍说 running」这一歧义支保留，「refresh 成功而 running 未回灌」
   的检测也不再依赖第二条载体（现每次对账的 host 读：健康路径 = 官方 `refresh` 1 次（tier-1.5
   本地判定直接收敛）；store 仍说 running 时 = `refresh` + 两次独立探针；两次尝试都不收敛的
   病态路径上界 = 2 次 `refresh` + 4 次探针 = 6 次 host 读（外加 N=2 确认后至多一次
   `handleSessionStatus` 写回）。落地本诉求后，探针只在「store 仍说 running」这一歧义支保留。
6. **把客户端状态写面提升为契约**（2026-12 新增诉求）：`ClientSessions.handleSessionStatus(
   sessionId, running)` 已是具体类的公开方法（`src/client/sessions/service.ts`），一次调用
   同时写 list summaries、物化 Session 的 `running`（聊天面）与 catalog activity；但
   `ISessions` 契约只暴露 `refresh()`。把它（或语义等价的 `reconcileSummaries(rows)`）写进
   `contract/sessions.ts`，chamber 的 tier-3 写回即从「上游公开但非契约」变成受契约保护的面。
7. **把「打开是否在途」暴露到契约/快照**（2026-09-21 新增诉求）：`Session.doOpen()` 有三条
   静默留在 `loading` 的路径（非 `isRemoteFailure` 抛错；`events.open()` 返回时
   `openGeneration`/`events` 已被推进），而重开只有 `followCurrent()` 的 stage 移动一条**外部**
   触发。chamber 现在以具象成员 `Session.openPromise`（`null` = 无在途、缺失 = unknown）作证据门
   自动重开，属「上游公开但非契约」的读取；把 `openState` + 在途标志（或 `open(): Promise<…>` 的
   显式结果）写进 `SessionSnapshot`/契约后，这条自动臂即可去掉 structural slice，且上游自己也能
   在 `doOpen` 收敛时优先补一次 `open()`。

> **chamber 侧现状与裁决（2026-12）**：在**不改上游、不新增 fork**（用户裁决）的前提下，
> chamber 已用两条仓内杠杆把「丢帧 → 纠正」做成确定性收敛——① tier-1.5 本地判定（refresh 后
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

上游图标组件把 Figma 导出 id 写死在 JSX 里（`IconSettingsOutline16`/`-14`=`clip0_1450_63327`/
`clip0_2580_121189`、`IconCordisPluginOutline14`=`clip0_1840_45990`、`IconAgentPresetOutline16`=
`mask0_agent_preset_16`、`BrandWordmark`=`dsh-wordmark-whale-clip`/`-badge-clip`、
`dshDropOverlayClip`），而 `url(#id)`/`mask` 的解析是**文档级**的。

宿主把同一个文档用于多个实例壳（chamber 的 N-ctx）时，同一 id 被逐壳重复定义；macOS WKWebView
在「新建形状首次绘制解析到未布局子树里的 clipper/mask」时整块失绘并把结果缓存住（重建元素才自愈，
属性回写/揭示都不行）。真机对照与判据见 `docs/design/05-connection-manager.md` §4.2。

上游最小改法（任一）：
1. 每个图标实例用 `useId()` 前缀/后缀化它定义的资源 id（`icons/index.tsx` 的 `clipPath:"url(#clip0_…)"`
   与同文件里的 `defs` 成对生成）；`BrandWordmark` 的 whale/badge clip 与附件拖拽浮层的
   `dshDropOverlayClip` 同理；
2. 或让这些 clip/mask 只依赖 `viewBox` 与路径本身（该文件里三处 `clip0_*` 矩形与 viewBox 等值，
   删掉后无视觉差），保留真实裁剪的那几处改用实例私有 id。

chamber 侧已落地缓解（`packages/renderer/src/svg-resource-scope.ts`，design 05 §4.2）：不改上游、
在每个 `<svg>` 内把「自定 ∩ 自用」的资源 id 改名到文档唯一 token，外部引用复制进消费方。
未覆盖的是 gateway/mobile 独立部署的官方壳（由实例自带 bundle 渲染，见 STATUS）。

## 6. 会话状态的只读观察者与未读事实（2026-12，design 17 §10.7 只读镜像 carve-out 的上游根治诉求）

背景：chamber 的 gateway 侧 watcher 需要一个**不渲染任何界面**的进程持续观察会话状态，才能在桌面关壳/关闭期间仍把「完成未读」带到下次启动。当前 pin 下这条路能走通（`$events` + 每条完成边沿一次 `session/follow` 读尾巴），但有三处本可由上游消掉的尖锐面——每处的 chamber 侧现状与判据都已在 plan 里登记。

1. **`updatedAt` 语义请给一个契约级承诺**。当前 pin 的摘要是 `updatedAt = max(header.createdAt, sessionListMetadata.lastPromptAt)`，而 `lastPromptAt` 只在 `user/message && data.source.kind === 'user'` 推进（vendor `dsh-api-session-controller/lib/index.js` 的 `applySessionListMetadata` / `updatedAt`；事件自述见 `typert.host.js` 的 `api-session/activity` JSDoc）。若上游把「任意 durable 产出都推进 `updatedAt`」写成契约，只读客户端就能用**内容水位**（`unread ⟺ updatedAt > 已读标记`）判定未读：不需要观察者、轮询就够、手动停止天然不产生未读——这是本族问题里性价比最高的一处改动。不承诺也可以，但请明确「只在用户消息推进」为契约，以便下游按边沿轨设计（chamber 现按此落地）。
2. **turn-end 的稳定性与转发**。`turn/end.reason`（`completed | aborted{reason} | blocked | error | max-tokens | interrupted`）已在 pin 存在（`typert.host.js` 的 `SessionEventMap` 与 `TurnEndReasonMap`），chamber 用它区分「完成」与「用户停止」以闭合误报。请求两点：① 冻结为稳定契约（含 `aborted` 的 `TurnEndCancelCause` 取值域）；② 考虑把 `turn/end` 纳入 `API_REMOTE_FORWARDED_EVENTS`——现白名单没有任何会话事件（`dsh-api-remotes` 的 `remote-events.js` 仅有 `api-session/*` 与两个 request 瀑布），观察者因此必须为每条完成边沿开一次 `session/follow` 才能读到尾巴。
3. **观察者角色 / pending 投影**。经 `$events` 接入的客户端会成为 `approval/request`、`user-questions/request` 瀑布的交付目标（`dsh-api-gateway/lib/index.js` 的 `deliverRemoteEvent` / `receiveRemoteEventResult`）：静默会挂起等待中的批准，而无条件回 `{kind:'next'}` 会在没有其他下游客户端时把它结算成 unavailable。chamber 的规则是「仅当另有 mux 客户端在线且过 1.5s grace 才委派，否则保持等待」，但这本质是把上游缺失的角色区分补在了下游。请求任一：① 给只读订阅者一个 **observer 角色**（不参与 waterfall 交付）；② 或在 `session/list` 上提供 pending 投影，让只读方无需接触瀑布即可知道「等待输入」。
4. **宿主侧持久 unread/pending 事实**。当前只有「有人正在观察」时才能记录完成边沿；桌面关闭且无观察者运行的窗口内完成的会话仍会丢。若宿主为每个会话持久化「最后完成水位 + 是否未读」（或至少给出稳定的 per-session unread 投影），这类丢失就能被根除，下游无需再各自维护观察者。

chamber 侧现状（非上游阻塞项，供参照）：只读镜像的边界与验收判据见 `docs/design/17-server-side-gateway.md` §10.7 与 §20；协议单一源 `packages/control-plane/src/session-state-protocol.ts`；watcher `packages/gateway/src/session-state.ts`（`/chamber/session-state*`，能力协商 + 优雅降级）。
## 7. 子代理生命周期/计数与完整性信号（2026-12，P5）

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



## 8. 载波 open 的稳定 episode 身份（2026-12，P3）

背景：chamber 的开帧预算按「请求 episode」放宽（30 → 60 → 120 → 240 → 300 s），跨重试道
（`RemoteStream` 重发 → mux 新 streamId）必须保持同一身份。vendor 的 `$stream({ open: signal => … })`
回调只传一个 `AbortSignal`，generated invocation 也不接受额外参数，因此本地唯一稳定的身份是
`streamOpeningKey`（endpoint + payload 的 FNV 摘要）。后果：① 同一 endpoint+payload 的两个不同
逻辑流会共享放宽预算（只影响节奏，不影响行为）；② 客户端无法把「同一条逻辑流的重试」与
「新的一次请求」从调用面上区分开，只能靠摘要与生命周期清理近似。

请求：给 stream 打开一个可携带的稳定身份（例如 `open(signal, { episodeId })`，或宿主为每次逻辑流
分配并在重发间保持的 token）；或直接由宿主承担首帧期限（见 §3 的首帧期限诉求）——后者落地后
客户端整条放宽阶梯即可退役。

