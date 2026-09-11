# todo · 上游：N-壳宿主下的持久化 selection 需要按 shell/入口作用域

> 状态：**上游提案**（未排期；chamber 侧不等待它）。记录于 2026-12。
> 动机来自 2026-12 真机问题 1（切到远程 server 的会话时先闪出一个"新会话"）。

## 动机

chamber 是 **N-ctx 宿主**：一个 document 里同时挂着 local + 每个远程实例的完整
dsh 前端壳（各自独立 cordis ctx / store / React 树，经
`docs/design/09-client-plugin-runtime-loading.md` 的 boot re-base 各自挂到
`/api/i/<id>`）。这些壳共享同一个 origin，因此也共享同一份 `localStorage`。

上游的"当前会话"选择是**页面级单键持久化**：

- `@deepseek-ai/dsh-api-session-controller`（pin `0.1.5-rc.1`，客户端半）
  `SessionRuntime` 构造里 `createSnapshotStore({}, { persist: { name:
  'dsh.sessions.current' } })`（`packages/api/session-controller/src/client/sessions/service.ts:225-228`）；
- `@deepseek-ai/dsh-client-store` 的 `attachPersistence`
  （`packages/client/store/src/index.ts:146`）：直接读写
  `localStorage.getItem(name)` / `setItem(name, …)`，**没有 scope 维度**；
- 投影时该 selection 会被校验后**回写或清空**：`current === undefined` 时
  `this.selection.set({})`（清掉共享键），有 current 时写回该 current
  （`packages/api/session-controller/src/client/sessions/service.ts:628-645`）。

后果（chamber 实机）：

1. **跨实例互相污染**：A 实例的 current 会被 B 实例读到；B 校验失败 →
   清空共享键（连 A 的持久化选择一起毁掉）；
2. **每次冷 boot 都"没有可恢复的会话"** → 官方
   `UiWorkspaceService.watchNavigation()`（`@deepseek-ai/dsh-client-ui-workspace`，
   pin 同版本）走初始导航策略：取"最近活跃工作区"→
   `connectWorkspace()`（复用该工作区的 blank 会话，否则
   `sessions.create({ workspaceId })` **在宿主上真建一个**）→ `sessions.open`。
   于是每挂一次壳（含**后台预热/基线收割**这种用户没点过的挂载）都会在各个
   远程宿主的最近工作区里留下一枚空白会话，并让目标壳先以"新会话"形态露出来；
3. 单实例 dsh 前端（上游 web 形态）完全看不出这个问题——它是**宿主形态**
   特有的（一个 document 里多份同一套 store）。

## 现状对照（chamber 侧）

- 已落地的 chamber 侧缓解（不改变上游事实面）：
  `docs/design/05-connection-manager.md` §2.2.1 修订——open 意图的本地回显
  （揭示门 / 投影门 / boot 意图早开），把"用户可感的中间态"消掉。
- **无法在 chamber 侧根治**：该 store 属于 vendor 树（
  `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-api-session-controller`
  都不在 chamber 的三个 fork 副本里），而"逐入口代理 `window.localStorage`"
  这类 workaround 在多壳异步 boot 交错下不安全（boot 之间会互相看到对方的
  作用域，且注入时机无法与 store 构造同步）——**明确不采用**。

## 上游最小改法（提案）

`dsh-client-store` 已经支持 scope：持久化键带 scope 后缀的逻辑在
`defineStore.create(scopeKey)` 里——
`persistKey = scopeKey === undefined ? decl.persist : \`${decl.persist}.${scopeKey}\``
（vendor 树内 `packages/client/store/src/index.ts:221-224`，pin `183f08e9` = `dsh-v0.1.5-rc.1`；
上游把它从 `packages/client/runtime/src/client/contract/store.ts` 改名迁到此处，
`packages/client/runtime` 整包其后已被删除）。缺的只是**调用点传 scope**：
`createSnapshotStore` 本身没有 scope 参数（同上 `:103-105`），
`SessionRuntime` 的 selection 正是直接由它建的（`createSnapshotStore({}, { persist: { name:
'dsh.sessions.current' } })`，不经过 `defineStore`）：

1. 给"每个 entry/壳一份"的 store 一个 scope 来源（宿主注入的
   `basePath` / instance id 最自然；chamber 已把它作为 `chamberBasePath`
   注入每个 entry 的 ctx，官方侧可等价地用 boot 参数或 connection 的 base
   path）；
2. 给该调用点的持久化名加 scope 后缀，或用 `defineStore.create(scope)`
   重建该 store（`dsh.sessions.current.<scope>`）——两条路都要求上游先接受
   "selection 的持久化身份含入口 scope"；
3. `current === undefined` 的**清空分支只清自己的 scope**（这一条比第 2 条更
   关键：它是跨实例破坏的来源）。

收益：每个壳恢复"自己上次的会话"，初始导航策略不再凭空建空白会话；chamber
侧的 boot 期早开臂（`client/early-open.ts`）也会从"抢时间"退化为"锦上添花"。

## 开放问题

- scope 的权威来源与稳定性：base path 会随入口形式变化（`/api/i/<id>` vs
  官方单实例 `/`），上游是否愿意把它作为持久化身份的一部分；
- 迁移：既有 `dsh.sessions.current` 单键如何一次性迁移/丢弃（chamber 接受
  直接弃用旧键）；
- 是否顺带把"会话/工作区的 UI 选择"整体纳入 scope 模型（chamber 只依赖
  selection 这一项）。
