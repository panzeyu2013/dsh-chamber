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

> 驱动面：`dsh-client-ui-chat` 的 `chat.deepDiving`（`TurnStatus`）由官方session的 `running` 位驱动，而该位只由mux `$events` 上一条emit型转发事件 `api-session/status` 递送（`dsh-api-session-controller` 客户端半 `handleSessionStatus`→`handleRunning`；白名单见 `dsh-api-remotes` 的 `remote-events.ts`，`mode: 'emit'`）。emit无重传、开场帧不重放会话状态，唯一收敛路径 `handleConnected() → refreshList()` 只挂连接代际重置 ⇒ 丢帧或carrier静默半死（无close/error）时运行位永停true，客户端零超时、零出口。chamber缓解（L1只读对账→L2有界reconnect→L3用户可见提示）见 `docs/design/14-sleep-background.md` §D4；缓解不是根治。

上游最小改法（三选一或组合）：

1. 事实自愈：emit型会话事实改周期性summary再断言，或客户端内建「running为真但 `$events` 静默 ≥N秒 ⇒ 触发一次 `session.list` 对账」——把chamber的L1上移为默认（对上游是纯读）。
2. 可观测心跳：`/api/remote.mux` 现只有WS级ping/pong（`websocketHeartbeatIntervalMs` 默认2s、`MAX_MISSED_HEARTBEATS=2` 硬编码），浏览器观测不到——加应用级keepalive item，页面可自判「连接是否还在投递」，不依赖OS事件。
3. 流期限：`session/follow` 加首帧/空闲期限（现永久无首帧即永久loading，见 `STATUS.md`「会话打开停滞」）。
4. **让 `refresh()` 可判成败**（最便宜、不新增API面）：`SessionManager.refreshList()` 对「拉取失败」照常resolve，只把 `listState` 置 `'error'`（`listError` 同存）——`buildListSnapshot()` 已把 `state/phase/error` 放进快照，但没作为返回契约。显式化（`refresh(): Promise<{ ok: boolean; error?: … }>` 或文档化「失败看 `listState`」）后，chamber的独立unary探针可删（每次对账2次host `session.list`→1次）；代价是丢掉「refresh成功但running未回灌」的检测面，故仍建议配合第1条。

开放问题：应用级keepalive的版本兼容（未知item必须被旧客户端忽略，而现客户端对未知帧会 `failAll` 并关socket）；心跳的隐私/体积边界；`session.list` 对账在大会话语料上的宿主成本（chamber一次refresh = per-call disk walk）。
