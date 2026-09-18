# todo · 上游提案（chamber 不可改，等待 deepseek-harness 侧裁决）

> 状态：**均为上游提案，未排期**；chamber 侧不等待、不绕过。四条提案各有真实驱动面的
> 历史（见 git 历史），本文只保留**对上游的最小改法、动机事实与开放问题**。上游落地后按
> `docs/progress/README.md` 的纪律逐条移出本表。

合并来源（2026-12，本表由三条独立 todo 合并）：① N-壳宿主下的持久化 selection scope
（`docs/design/05-connection-manager.md` §2.2.1、`06-sidebar-enhancements.md` §「client-store 作用域」）；
② 设置面声明式贡献通道 T3（`docs/design/05` §5、`09-client-plugin-runtime-loading.md` §4）；
③ 已归档会话的 wire 契约草案（`docs/design/24-archived-session-cleanup.md` §2/§13 的根治面）。

## 1. N-壳宿主下持久化 selection 需要按 shell/入口作用域

上游的「当前会话」选择是**页面级单键持久化**，在 N-ctx 宿主下会跨实例互相污染：

- `@deepseek-ai/dsh-api-session-controller`（pin `0.1.5-rc.2` 客户端半）`SessionRuntime` 构造里
  `createSnapshotStore({}, { persist: { name: 'dsh.sessions.current' } })`
  （`packages/api/session-controller/src/client/sessions/service.ts:225-228`）；
- `@deepseek-ai/dsh-client-store` 的 `attachPersistence`（`packages/client/store/src/index.ts:146`）
  直接读写 `localStorage.getItem/setItem(name, …)`，**没有 scope 维度**；
- 投影时 selection 会被校验后**回写或清空**（`current === undefined` ⇒ `this.selection.set({})`，
  同文件 `:628-645`）。

后果（chamber 实机，2026-12 真机问题 1「切到远程 server 的会话时先闪出一个新会话」）：

1. **跨实例互相污染**：A 实例的 current 被 B 实例读到，B 校验失败即清空共享键（连 A 的持久化选择一起毁掉）；
2. **每次冷 boot 都「没有可恢复的会话」**⇒ 官方 `UiWorkspaceService.watchNavigation()` 取「最近活跃工作区」
   → `connectWorkspace()`（复用 blank 会话，否则 `sessions.create({ workspaceId })` **在宿主上真建一个**）；
   于是每次挂壳（含后台预热/基线收割）都在各远程宿主的最近工作区留下一枚空白会话；
3. 单实例官方 web 形态完全看不出这个问题——它是**宿主形态**特有的。

**chamber 侧已落地的缓解（不改变上游事实面）**：design 05 §2.2.1 修订的 open 意图本地回显
（揭示门 / 投影门 / boot 意图早开）把用户可感的中间态消掉；`client/early-open.ts` 的 boot 期早开臂
是「抢时间」，不承担正确性。**无法在 chamber 侧根治**：该 store 属 vendor 树（不在三个 fork 副本内），
而「逐入口代理 `window.localStorage`」在多壳异步 boot 交错下不安全（boot 之间会互相看到对方作用域，
注入时机也无法与 store 构造同步）——**明确不采用**。

**上游最小改法**：`dsh-client-store` 已支持 scope（`defineStore.create(scopeKey)` 里
`persistKey = scopeKey === undefined ? decl.persist : `${decl.persist}.${scopeKey}``，
`packages/client/store/src/index.ts:221-224`，pin `fb2c4b9e` = `dsh-v0.1.5-rc.2`），缺的只是调用点传 scope：

1. 给「每个 entry/壳一份」的 store 一个 scope 来源（宿主注入的 basePath / instance id 最自然；
   chamber 已把它作为 `chamberBasePath` 注入每个 entry 的 ctx，官方侧可等价地用 boot 参数或 connection 的 base path）；
2. 持久化名加 scope 后缀，或用 `defineStore.create(scope)` 重建该 store（`dsh.sessions.current.<scope>`）；
3. `current === undefined` 的**清空分支只清自己的 scope**（这条比第 2 条更关键：它是跨实例破坏的来源）。

收益：每个壳恢复「自己上次的会话」，初始导航策略不再凭空建空白会话。

**开放问题**：scope 的权威来源与稳定性（base path 会随入口形式变化，上游是否愿把它作为持久化身份的一部分）；
既有单键的一次性迁移/丢弃（chamber 接受直接弃用旧键）；是否顺带把「会话/工作区的 UI 选择」整体纳入 scope 模型。

## 2. 设置面的上游声明式贡献通道（T3 提案）

**2026-12 完整桥接修订后，chamber 不再需要这条通道**：桌面设置面直接渲染选中来源自己 boot ctx 的
`settings.section` 台账与该 ctx 渲染器绑定的标准座（design 05 §5 / 09 §4），既不二次装载插件、
也不提供缩小服务集。保留本文的理由是**其他宿主**（任何想在不实例化插件的前提下渲染贡献、或想拿到
一份文档化设置面服务契约的宿主）仍会撞上同样三条由上游形态决定的硬边界：

1. **贡献是代码，不是数据**：`dsh.client` 清单只有 `inject` / `platform`（vendor `dsh-client-modules`
   `manifest.ts`），没有 `contributes.*` 描述符 ⇒ 任何重宿主面**必须实例化插件**才知道它贡献了什么；
2. **没有设置面服务契约**：自建宿主面只能提供自己拼的服务集，插件 root `inject` 一旦包含该宿主没有的
   服务就不激活（旧 chamber 形态即如此）；
3. **泛型 Remote 客户端不可行**：客户端 Remote 贡献由生成物提供（`TypertRemoteContribution`），
   `TypertLocalRegistry/RemoteRegistry.list()` 是进程内注册表，api-gateway 客户端**未见 descriptor 上线通道**
   （2026-12 调研：`dsh-typert-protocol/src/types.ts`、`packages/dsh-api-gateway/src/client/`）⇒ 自建 ctx 的宿主
   只能提供手工 `remote` 面，插件调用其他命名空间会在**调用时**失败。

**提议（按价值排序）**：

- **P1 `dsh.client.contributes.settings` 声明式贡献描述符**——在包清单声明「我在哪些设置座位贡献什么」
  （`sections[{id,order,label}]` / `seats` / 最小 `requires` 服务集）。价值：重宿主面可先读清单再决定装载；
  `requires` 让宿主**事前**判断某插件能否在当前能力面激活，而不是等 fiber 停在 PENDING 再猜；
  为将来的 schema 驱动渲染（无 UI 代码的纯声明式设置）铺路。
- **P2 设置面服务契约（最小可注入集合）**——定义并文档化稳定服务子集（如 `settingsScope` / `settingsSchema` /
  `locale` / `theme` / `remote.settings` / `remote.credentials` / `remote.llm` / `remote.pluginInventory`），
  允许插件在清单里声明自己只依赖该子集。chamber 已把该契约写在 design 09 §5（作者契约），但**没有机器可读的声明**。
- **P3 Remote descriptor 上线通道（或「设置面 Remote 子集」协议）**——typert 握手时下发 descriptor 目录
  （或提供只读 `typert/describe`），重宿主面即可构造泛型 Remote 客户端。代价：协议面扩张 + 权限模型需上游设计。

**开放问题**：`contributes.settings` 与运行时 `slots.register` 的一致性校验（不一致时建议宿主报诊断、不阻断）；
描述符的版本兼容（座位名/schema 与宿主 SlotMap 版本漂移如何降级）；重宿主面实例化第三方插件代码的信任边界
（chamber 现状由 design 09 §4 声明，本提案不改变该边界）；P3 若落地，chamber 的 `remote` stub 应替换为泛型面，
`CAPABILITY_REMOTE_EVENTS` 一类能力降级报告随之收敛。

## 3. 已归档会话的 wire 契约草案（根治，对齐 OpenCode 模型）

> 上游 = `deepseek-harness`（本仓不可改；落地前以 vendor `dsh-client-modules/src/client/manifest.ts` 为权威复查）。
> design 24 的归档清理域随上游 `sessions.delete` wire 落地后**退休**。

根因：dsh 归档**单向且不可见**——上游只有 `workspace.archiveSession`（追加进 registry-global 集合，幂等），
无 unarchive/delete-session；官方与 chamber 投影同规则排除归档行（`!archived.has(id)`）；数据未丢
（`sessions.list/search` 均返回归档会话，集合持久化于 `<DSH_HOME>/profiles/web/**/workspace.json` 的
`global.archivedSessionIds`）。OpenCode/OpenChamber 范式对照：harness 提供可逆归档 + 删除 + 归档可见查询，
manager 只做 UI——dsh 三项全缺，chamber 无法只靠前端补全。

1. `workspace.unarchiveSession({ sessionId })`——与 `archiveSession` 对称、幂等移除；复用既有
   `host/archived-sessions-changed` 事件与 `workspace.list.archivedSessionIds` 投影，客户端零新协议。
2. `sessions.delete({ sessionId })`（或 workspace 下同义）——服务端删会话目录 + 级联 subagent 起源子会话 +
   workspace 成员账目自愈（header 索引重建剔除已删 id）+ 从 archived 集合清理；复用 `host/session-removed` 事件。
3. （可选）`sessions.list` 行加 `archived` 标志或查询参数。若保持 registry-set 形态，仅补 1+2 即可让
   design 24 的可选「已归档浏览区」补上恢复/删除——最小改动优先。

> 其余与 design 24 相关的**chamber 侧**剩余面（浏览区 A 未排期、控制面特权层直删 B 冻结）见
> `docs/progress/STATUS.md` 范围决策节与 `docs/design/24-archived-session-cleanup.md`。

## 4. 会话事实通道的「静默丢帧」自愈（2026-12，Swift 原生版 ui-chat 卡死根因）

> 驱动面：`dsh-client-ui-chat` 的 `chat.deepDiving`（`TurnStatus`）由官方 session 的
> `running` 位驱动，而该位只由 mux `$events` 上一条 **emit 型转发事件**
> `api-session/status` 递送（`dsh-api-session-controller` 客户端半
> `handleSessionStatus` → `handleRunning`；白名单见 `dsh-api-remotes` 的
> `remote-events.ts`，`mode: 'emit'`）。emit 无重传、`$events` 开场帧不重放会话
> 状态，而官方唯一的收敛路径 `handleConnected() → refreshList()` 只挂在**连接代际
> 重置**上 ⇒ 丢一帧或 carrier 静默半死（无 close/error）时运行位永久停在 true，
> 客户端零超时、零出口。chamber 侧缓解（L1 只读对账 → L2 有界 reconnect → L3 用户
> 可见提示）见 `docs/design/14-sleep-background.md` §D4；**这是缓解不是根治**。

**上游最小改法（三选一或组合）**：

1. **事实自愈**：emit 型会话事实改为周期性 summary 再断言，或客户端内建「running
   为真但 `$events` 静默 ≥N 秒 ⇒ 触发一次 `session.list` 对账」——即把 chamber 的
   L1 上移为默认行为（对上游是纯读）；
2. **可观测心跳**：`/api/remote.mux` 现只有 WS 级 ping/pong（服务端
   `websocketHeartbeatIntervalMs` 默认 2s、`MAX_MISSED_HEARTBEATS=2` 硬编码），
   浏览器完全观测不到——增加应用级 keepalive item 可让页面自判「连接是否还在投递」，
   不依赖任何 OS 事件；
3. **流期限**：`session/follow` 加首帧/空闲期限（现永久无首帧即永久 loading，见
   `STATUS.md`「会话打开停滞」）。
4. **让 `refresh()` 可判成败**（最便宜、且不新增 API 面）：`SessionManager.refreshList()`
   现在对「拉取失败」照常 resolve，只把 `listState` 置 `'error'`（`listError` 同存）——
   `buildListSnapshot()` 其实已经把 `state/phase/error` 放进快照，但没有作为返回契约。
   把结果显式化（`refresh(): Promise<{ ok: boolean; error?: … }>`，或文档化「失败看
   `listState`」）后，chamber 一侧的独立 unary 探针即可删除（每次对账 2 次 host
   `session.list` → 1 次）；代价是丢掉「refresh 成功但 running 未回灌」这一回归的检测面，
   故仍建议配合第 1 条。

**开放问题**：应用级 keepalive 的版本兼容（未知 item 必须被旧客户端忽略，而现客户端
对未知帧会 `failAll` 并关 socket）；心跳的隐私/体积边界；`session.list` 对账在大会话
语料上的宿主成本（chamber 一次 refresh = per-call disk walk）。
