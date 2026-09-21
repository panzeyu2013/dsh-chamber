# 网关侧会话状态观察服务（watcher）实施蓝图

> 状态：**已实施**（2026-12）；验收记录与仍开放的实机项见 `docs/progress/todo/remote-session-state-and-switch.md` §13
> 与 `docs/progress/STATUS.md`「远端完成未读 / 切源体验」条。工作流：主计划 W1 服务端面。
> 锚定：dsh pin `0.1.5-rc.2`（`packages/gateway/package.json:4` 的 dshAnchorVersion）、chamber `0.3.2-beta.5`。
> 关联：`docs/progress/todo/remote-session-state-and-switch.md` §3.2（:56）/§4（:85）/W1（:136）/§10（:247）/§11（:257）；
> design 17 §10（:670，编排面剥离不得回流）、§12（:886）、§20（:1677）；
> design 19 §3.5（:305）与 §3.7（:345，未读徽标）；`docs/progress/todo/upstream-proposals.md` §4（:61）。
> 证据标记：**【事实】**=本次在仓内源码或打包 vendor 源码中直接读到；**【推断】**=由事实推导但未实测（W0/实机门待验）。

## 0. 结论摘要（先给决策）

1. **连接路线选 (b)**：最小 mux WebSocket 客户端 + `$events` 转发事件流（pending/运行边沿）+ unary `session/list`（基线/对账）。不采用 (a) 官方客户端半 headless，不把 (c) 轮询当主路径。理由与证伪条件见 §2。
2. **【事实·致命】pin 上摘要 `updatedAt` 只随「用户消息」推进**，agent 产出不推进（vendor `dsh-api-session-controller/lib/index.js:1969-1971` + `lib/types/list.js:30-33`）。⇒ 主计划 §3.1 的「水位轨 A」在 pin 上不成立，**完成事实必须走边沿轨 B**（watcher 产出 `completedAt`）。这同时改写 §4/§5-3 的未读判定与 `readMark` 定义（见 §11-①）。
3. **【事实·致命】watcher 一旦打开 `$events`，就成为 `approval/request` / `user-questions/request` waterfall 的交付目标**（vendor `dsh-api-gateway/lib/index.js:630,678,683,712`）。静默会把「等待批准」永久挂起；无条件回 `{kind:'next'}` 会在**无浏览器壳时把等待中的批准立刻判成 `unavailable`**。必须实现「仅当另有下游 mux 客户端在线时才委派」的规则（§5.4、§9-R1）。
4. **【事实】emit 型事件无重传、`$events` 开场帧不重放会话状态**（`docs/progress/todo/upstream-proposals.md:66-69`；vendor `dsh-api-gateway/lib/index.js:585-609` 只 yield ready+队列）。⇒ 每次（重）连必须做一次全量 `session/list` 基线对账；周期性对账是正确性组件而非优化。
5. **读水位必须按「来源内最大已读」求值**：计划 §4 按 client-install 存读标记，但 R10 要求手机读掉桌面即灭（:190-192）。二者只在「存储按 client、判定按 source 取 max」下同时成立（§6.3、§11-⑤）。
6. 新增路由全部落在既有 `/chamber/*` auth 门内（`dispatch.ts:989-993`），不新增鉴权面；watcher 只存状态元数据，**不存标题/cwd/消息/批准与提问载荷**（§7）。

---

## 1. 现状盘点（带 file:line）

### 1.1 组装与生命周期：`packages/gateway/src/index.ts`

- `createGateway`（:134）在一个同步构造事务里装配：store（:184）→ auth（:188）→ requestPolicy（:211）→ channels（:212）→ 同步插件缓存 `createChamberPlugins`（:216）→ A0 只读投影 `createChamberInstalled`（:224）→ A1 编排器 `createChamberPluginTasks`（:238）→ chamber surface（:282）→ runtime 路由（:292）→ 审计文件（:300）→ dispatch（:301）→ 控制面 `createdPlane`（:356）→ 代理（:430）。
- **前向引用是本仓既有模式**：`chamberSurface`（:282）与 `dispatch`（:301）都在 `createdPlane`（:356）之前建立，靠 `() => createdPlane.getLocalDshPort()` 之类的惰性闭包取值【事实，见 :324-333 的 warmup 依赖与 :392-396 的 workspace 闭包】。watcher 可复用同一模式。
- 生命周期：`start()`（:475）→ `store.reacquire()` + `dispatch.resume()` + `createdPlane.start()`（:487-489）→ runtimeManager 构造（:492）→ `startupTransaction()`（:501）→ 阻断分支（:512-555）→ `unsubscribeLocalState = createdPlane.onLocalStateChange(snapshot => syncFeatures(snapshot.status))`（:562）→ `createdPlane.startLocal()`（:565）。
- `syncFeatures(status)`（:443-467）是现成的**状态边沿消费点**：先 `runtimeManager.observeLocalState`，再在 `ready|degraded` 排空 deferred intents。watcher 的「host ready 就开流、host 停就断流」边沿应挂在这里或同一订阅上。
- `stop()`（:634）：先 `dispatch.quiesce()`（:649）→ `unsubscribeLocalState?.()`（:652）→ `proxy?.closeAllStreams()`（:654）→ runtime/executor dispose → `createdPlane.stop()`。watcher 必须在此插入：**关闭 SSE 流 → 停 mux → flush 快照落盘**，且顺序要在 `store.close()`（:721）之前。
- host 暴露门：`canExposeLocal: () => !stopping && !runtimeExposureQuarantined()`（:408、:437），`runtimeExposureQuarantined()`（:166-171）覆盖激活事务窗口（:170）。**watcher 必须吃同一门**：候选 runtime 树在激活判定前不得被观察【推断，但与 D3/F4 纪律一致（:434-437 注释）】。
- `GatewayHandle` 只暴露 port/connectionState/localProcessAlive/instanceId/authKind（:73-83、:743-751）——watcher 状态不进 public handle；诊断面走路由（§6.1 的 `observer` 字段）。

### 1.2 `/chamber/*` 面与路由认领：`packages/gateway/src/routes.ts`

- 面装配：`ChamberSurfaceDeps`（:72-88：logger/channels/plugins/installed/tasks/stateDir）、`ChamberSurface.handle(req,res,pathname): Promise<boolean>`（:90-94，「认领即 true，含未知 /chamber 路由的 404」）。
- 路由认领是**顺序 exact-match**：`/chamber/channels`（:1243）→ `/chamber/plugins`（:1257）→ `/chamber/plugins/installed`（:1347）→ `install`（:1374）→ `remove`（:1402）→ `tasks`（:1427）→ `materialize`（:1441）→ 仪表盘与静态资源（:1556-1590）→ **末尾兜底 404 且 return true**（:1593-1594）。
- 方法纪律：非法的 GET/HEAD 资产用 `methodNotAllowed`（:1063-1066，405 + `{error:'method_not_allowed',code:'method_not_allowed'}`）；JSON 路由各自判 `req.method`。
- 响应工具：`jsonResponse(res,status,body)`（`http-utils.ts:34-38`，固定 `content-type: application/json` + `cache-control: no-store`）、`readBoundedBody`（:72，通用有界体内核）、`readUploadJsonBody`（routes.ts:101-112，8 MiB + 413/400 码）、`codedError`（http-utils.ts:21）。
- 本仓 SSE 先例在控制面而非 routes：`packages/control-plane/src/api.ts:362-469`（`/api/host/health-events`）——**应当照抄的写法**：`writeHead(200,{content-type:'text/event-stream','cache-control':'no-store',connection:'keep-alive'})`（:374-379）、有界背压队列 `MAX_HEALTH_EVENT_PENDING_FRAMES=32`（:66）、`res.write()===false` 才挂 `drain`（:404-432）、keepalive 20s `: keepalive`（:464-468）、`res.on('close') && !res.writableEnded ⇒ teardown`（:441-448）、并发流上限 `MAX_HEALTH_EVENT_STREAMS=32`（:64、:364-367）。**新增 SSE 必须逐条镜像这套纪律**。

### 1.3 鉴权与路由分发：`packages/gateway/src/dispatch.ts`

- `middleware`（:572）：请求策略（:578-588）→ 预检（:592-601）→ warmup 前门（:614-626）→ **auth 门**（:641-690：`auth.verify`、`auth_busy` 503、401 + 审计 :671-673、generation 复审 :678-682、`trackHttp` :689）→ login（:698）→ 凭据管理（:823、:911）→ 管理面向 fall through（:948-960）→ `/chamber` 302（:963-968）→ **`/chamber/runtime*` 控制器（:974-978）** → **`/chamber/*` 面（:989-993，先 `rejectStaleHttp` 再 `getFeatures().handle`）** → UA 分流（:1008-1017）→ 兜底代理（:1022-1031）。
- **登录跳转不会吞掉新路由**：`shouldRedirectToLogin`（:132-144）只对非 `/api`、非 `/plugins`、非 `/auth/`、且 `!(pathname.startsWith('/chamber/') && pathname !== '/chamber/')` 的 HTML 导航生效（:140-143）⇒ `Accept: text/event-stream` 的 `/chamber/session-state/stream` 稳定走 JSON/SSE 分支【事实，读条件式】。
- `auditPathCategory`（:84-90）已把 `/chamber/*` 归为 `chamber` 类；新路由的 401/403 审计自动落类，无需改动。
- WS 升级面：`upgradeMiddleware`（:1034）只有 `/api/remote.mux` 会代理（:1087-1100）；新路由**不新增 WS 面**。
- `dispatch.quiesce()`（:320）会 destroy 已认证的 HTTP 响应与 socket（`closeAuthenticatedTraffic` :392-407）⇒ SSE 长连接在 stop 时会被 dispatch 主动销毁，watcher 自己也应主动 `end()`（幂等）。

### 1.4 配置：`packages/gateway/src/config.ts`

- `GatewayConfig`（:31-80）与 `GatewayConfigInput`（:84-101）；`parseGatewayConfig(input, stateDir, dshWorkspacePath)`（:206）负责一切校验与 env 回退。
- env 读取范式：`firstEnv(...)`（:111-117）、严格布尔 `envBoolean`（:122-129，非法值抛 `GatewayConfigError`）；`warmup` 的写法（:79 字段、:260 `input.warmup ?? envBoolean('DSH_GATEWAY_WARMUP') ?? true`）就是新开关 `sessionState` 的模板。
- S1 暴露硬门（:266-269）与 `allowAnonymousExternal`（:251）不改；新开关与鉴权无关（只读元数据，默认开）。
- `buildGatewayConfig`（index.ts:89）默认 `stateDir = DEFAULT_STATE_DIR`、`dshWorkspacePath = defaultDshWorkspacePath()`。

### 1.5 网关今天怎么访问本地 dsh：`packages/gateway/src/runtime-manager.ts`

- 单点入口是控制面的 unary 客户端：`import { call as dshCall, type Logger, type PlaneHandle } from '@dsh-chamber/control-plane'`（:33）。
- **baseUrl 范式（watcher 唯一需要的 host 地址来源）**：
  - `spawnAndProbeCandidate`：`await plane.startLocal(); const port = plane.getLocalDshPort(); ... const baseUrl = http://127.0.0.1:<port>`（:850-853）；
  - `probeEnvOverrideRuntime`：同一写法的第二处（:908-912）；
  - 两处都用 `dshCall(url, method, payload, {signal,timeoutMs,maxResponseBytes})`（:872、:932）。
- 探针层传入的 payload 形状是 `{args:{…}}`（`packages/dsh-runtime/src/runtime-probes.ts:429,478,485,496,538`），与 typert 的 `remoteRequest` 要求一致（vendor `dsh-api-gateway/lib/index.js:929-936`：payload 必须恰有一个 plain-object `args`）。
- 控制面 unary 契约（`packages/control-plane/src/dsh-client.ts`）：`call(baseUrl, method, payload, opts)`（:329）POST `/api/<method>`（:371），体是 `{type:'client-request',rpcId,method,payload}`（:21-24、:378），并**自动带 host 的 browser-auth cookie**（:370 `authCookieFor(baseUrl)`）；默认响应上限 1 MiB（:107）、默认 30s 超时（:104）。
- **本地 host 的 auth 门**：0.1.2+ 的 web-profile host 对每个 `/api` 请求**与每个 `/api/remote.mux` 升级**都要求一枚经 launch token 兑换的签名 cookie（`packages/control-plane/src/browser-auth-cookie.ts:4-18`）；cookie 由 spawn 路径在读到 `dsh web: <url>?token=...` 后兑换并**只存内存**（`spawn-dsh.ts:1004-1006`），停止/回收即清（`spawn-dsh.ts:724,1090,1394`；`local-connection.ts:611,937`）。⇒ watcher **不得缓存** cookie，必须在每次连接时重新 `authCookieFor(baseUrl)`【事实 + 推断：缓存会跨 spawn 复活旧会话】。
- 代理侧已证明 cookie 必须注入 upgrade 握手：`gateway-proxy.ts:319-321`（`forwardUpgrade(..., {cookie})`）；控制面 `forwardUpgrade` 只允许额外透传 `authorization`/`cookie`（`proxy-forward.ts:1277-1283`）。WS 白名单只有 `/api/remote.mux`（`proxy-forward.ts:212`）。

### 1.6 网关今天怎么写状态（`DEFAULT_STATE_DIR` 与既有落盘纪律）

- `DEFAULT_STATE_DIR = join(homedir(), '.dsh-chamber')`（`packages/control-plane/src/index.ts:92`）；网关 CLI 解析 `args.stateDir ?? process.env.DSH_GATEWAY_STATE ?? DEFAULT_STATE_DIR`（`packages/gateway/src/cli.ts:248` 与 :315 两处），`buildGatewayConfig` 也以它为默认（index.ts:89）。
- 状态文件都在 `<stateDir>` 下的**网关自有**文档：`tokens.json`（`store.ts:564`）、`password-credential`（:566）、`.gateway.lock`（:331，独占锁）；根目录 0700、文档 0600、原子 no-follow 写（design 17 §12:886-915）。
- 可复用原语（控制面导出）：`createJsonStore`（`packages/control-plane/src/json-store.ts:209`；协议见 :1-43：**主→备→初始**的加载序、备份优先持久化、**corrupt≠空**、revision 计数、`fileMode` :111）与 `atomicWritePrivateFileNoFollow`（`private-file.ts:335`）、`ensurePrivateDirectoryNoFollow`（:163）、`readPrivateFileNoFollow`（:224）；再导出点 `packages/control-plane/src/index.ts:1467,1470`。
- 插件域给了一个完整的「状态目录 + journal + 不变量」样例：
  - `plugins.ts`：cache root `chamber-plugins`（:48）、`createChamberPlugins`（:163），上传校验（:189-227），落盘前 `mkdirSync(...,0o700)` + `ensurePrivateDirectoryNoFollow`（:232-234）+ `atomicWritePrivateFileNoFollow(..., {mode:0o600})`（:250），尺寸上限（:88-90、:111-114）；
  - `plugins-journal.ts`：`chamber-plugins/third-party/journal.json`（:61-65）、读上限 256 KiB（:68）、`createPluginsJournal`（:207）、**corrupt 移边 + 粘滞 `integrity()`**（:262-278、:447-464）、`persistOps` 拒绝覆盖不可读原始件（:312-321）；
  - `plugins-tasks.ts`：deferred 存储 `deferred.json` + 64 KiB 上限 + 复用同一原子写纪律（:82-86、:1-49 头注）；
  - `plugins-installed.ts`：托管 profile 路径 `dsh-home/profiles/web`（:53、:58）与 1 MiB 读上限（:62）。
  ⇒ **watcher 的状态文件应当是 `<stateDir>/session-state/state.json`，并复用 `createJsonStore` 的 corrupt/backup 语义**，而不是自造一套（§4）。

### 1.7 测试组织：`packages/gateway/test`

- **清单制**：`packages/gateway/scripts/test.mjs` 的 `GROUPS`（:16-81）是权威文件表，每个文件单独 `node <file>` 子进程（:92-98）；表内文件不存在即失败（:86-91）。仓库另有 `verify:test-wiring` 门要求磁盘上每个测试都可达【事实，见 AGENTS.md 执行流与 `scripts/gates/run-checks.mjs` 单入口】⇒ **新增测试必须同时登记进这个 GROUPS**。
- 风格：文件头注释 + `Run directly: node packages/gateway/test/<domain>/<x>.test.ts`（`test/chamber-surface/chamber-installed.test.ts:1-9`）；`node:test` + `assert/strict`（:10-11）；本地 no-op logger（:38-42）；结构假件 `channels`（:44-51）；临时 stateDir 用 `mkdtempSync` + `t.after`（:58-62）；请求/响应假件统一来自 `test/support/utils.ts`（`FakeRequest` :20、`FakeResponse` :78、`gatewayRequest` :133、`stubPluginTasks` :145）；路由直调 `host.handle(new FakeRequest(...), response, path)`（:90-95）。
- 现有分组：auth / boundary / proxy / runtime / plugins / chamber-surface / packaging（test.mjs:16-81）。新增分组建议 `session-state`。

### 1.8 官方 dsh 侧：可用事实面（打包 vendor 为权威）

> 路径前缀 `@vendor` = `/Applications/dsh-chamber.app/Contents/Resources/sidecar/vendor/dsh/node_modules/@deepseek-ai/`。

1. **mux 与帧协议**【事实】：`REMOTE_STREAM_MUX_PATH='/api/remote.mux'`（`@vendor/dsh-api-gateway/lib/types/stream-protocol.js:3`）；客户端→host 只接受 `{type:'open',streamId,endpoint,payload}` 与 `{type:'cancel',streamId}`（:155-173）；host→客户端只发 `{type:'item',streamId,value?}` / `{type:'end',streamId}` / `{type:'error',streamId,error:{code,message,details}}`（:175-195）。心跳：服务端 `websocketHeartbeatIntervalMs` 默认值 + `MAX_MISSED_HEARTBEATS=2`（`@vendor/dsh-api-gateway/lib/index.js:197,433`）。
2. **`$events` 流**【事实】：端点 `'$events'`、结果 RPC `'$events/result'`、开场 item `{type:'ready',clientId,host:{home}}`（`types/stream-protocol.js:5,7,10`）；host 侧 `openRemoteEvents(payload)` 要求 payload 恰为 `{args:{}}`（`lib/index.js:586`），并**把当前所有 pending 事件补投给新客户端**（:602-603）；`dispatchRpc` 对 `$events/result` 单独分支（:566-579），payload 必须是 `{args:{clientId,eventId,outcome}}`（:922-924）。
3. **waterfall 交付语义**【事实】：`emit` 广播给所有客户端（:621-628）；`waterfall` 交付给所有客户端并记入 `pending.deliveries`（:678-681）；客户端回 `result` 立即结算、回 `rejected` 取消、回 `next` 仅当 `deliveries.size===0` 才结算为 next（:683-696）；`finishRemoteEvent` 向所有交付方推 `{type:'cancel',eventId}`（:712-726）。**没有任何 per-client 过滤或观察者角色**（`claimsEndpoint` :508-513 只判 endpoint 归属）。
4. **转发白名单**【事实】：`API_REMOTE_FORWARDED_EVENTS`（`@vendor/dsh-api-remotes/lib/index.js:17-93`）恰好包含 `approval/request`（waterfall，:23）、`api-session/activity`（emit，:27）、`api-session/added`（:31）、`api-session/error`（:35）、`api-session/removed`（:39）、`api-session/status`（:43）、`user-questions/request`（waterfall，:91）等。host 半边在 `apply` 里 `registerRemoteEvents(...)`（:102-105），即 **`$events` 的可用性取决于 profile 是否挂了 `dsh-api-remotes`**。
5. **web profile 确实挂它**【事实】：`@vendor/dsh-web-app/cordis.patch.yml` 的 host/browser 名册含 `session-controller`(:105-106)、`connection`(:181-182)、`api-remotes`(:195-196)、`ui-approval`(:252-253)、`ui-user-questions`(:345-346)。
6. **事件产生点**【事实】：`@vendor/dsh-api-session-controller/lib/index.js`——`session/created ⇒ api-session/added`（:2749-2750）、`session/disposed ⇒ api-session/removed`（:2753）、`agent/status ⇒ api-session/status(agent.id, status==='running')`（:2756）、`agent/error ⇒ api-session/error(agent.id, errorChain)`（:2759，**消息文本，禁止落盘**）、用户消息 ⇒ `api-session/activity`（:2764-2767）。**agent.id === session.id** 在此模型内成立（`agents.get(session.id)`，:1818）。
7. **`session/list` 是唯一 unary 基线**【事实】：描述符 `session/list`（`lib/typert.host.js:899`），请求 `{cursor?:string}`（:409-411）、结果 `{items: SessionSummary[]}`（:412、:1768-1769）；实现一次返回全量并按 `updatedAt` 降序（`lib/index.js:1829-1846`），冷会话 `running:false`（:1848-1858）；`SessionSummary` 声明见 `typert.host.js:1877`。**没有分页游标回传，也没有 pending 投影**（schemas :412-500 与 :1877）。
8. **`updatedAt` 语义（W0 轨道的静态答案）**【事实】：`updatedAt(header, metadata) = Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)`（`lib/index.js:1969-1971`）；`lastPromptAt` 仅在 `event.type==='user/message' && event.data.source.kind==='user'` 时推进（`lib/types/list.js:30-33`；`lib/index.js:1745-1754`）。事件自述也是「One **user-authored** durable message advanced Session list activity」（`typert.host.js:2640-2646`）。⇒ **当前 pin 下 agent 产出不推进摘要 `updatedAt`**，完成必须由 `api-session/status` 的 true→false 边沿给出。
9. **pending 的语义只在客户端注册表**【事实】：`ctx.uiSession.pendingInteractions` 是客户端聚合（`@vendor/dsh-client-ui-session/lib/client.js:83`），由 `ui-approval` 注册（`@vendor/dsh-client-ui-approval/lib/client.js:282`；结算/委派逻辑 :150-245），host 侧批准瀑布在 `@vendor/dsh-user-approval/lib/index.js:179`、提问在 `@vendor/dsh-user-questions/lib/index.js:69`。⇒ 想「无壳也看得见 pending」，要么跑整张客户端插件图（路线 a），要么订阅 `$events` 的 waterfall 帧（路线 b）。
10. **空闲/丢帧史**【事实】：`docs/progress/todo/upstream-proposals.md:66-69`（emit 无重传、开场不重放、唯一收敛路径是连接代际重置）与 :77-90（自愈提案）；本仓已在该文件记录「客户端读不到 refresh 是否成功」等既有限制。

---

## 2. 连接路线评估与推荐

| 维度 | (a) 官方客户端半 headless（`dsh-client-connection` + api-gateway client + 会话控制器 client + 可能的 ui-session 图） | **(b) 最小 mux `$events` 订阅 + unary `session/list`（推荐）** | (c) 仅 `session.list` 轮询 |
|---|---|---|---|
| 能否拿 running 边沿 | 能（`api-session/status` 经同一 mux） | 能（同一事件） | 只能由相邻两次基线差推边沿（精度=轮询间隔） |
| 能否拿 pending | 能，且是官方同源语义（`pendingInteractions`） | 能，但需处理 waterfall 委派（§5.4） | **不能**（`session/list` 无 pending 投影，事实 §1.8-7/9） |
| 依赖面 | 需 cordis `Context` + `typert` + `connection` 服务图（`@vendor/dsh-api-gateway/lib/client.js` 的 `inject=['typert','connection']`；`packages/dsh-api-gateway/src/client/index.ts:144`），WS 基址取自 `globalThis.location` 否则 `http://dsh.internal`（`stream-client.ts:33,322-328`）⇒ Node 侧要造 location/typert stub；再叠客户端插件图才等价 | 只需 WS 客户端 + 两个 unary（`session/list`、`$events/result`），两者都有控制面现成原语（`call`+cookie） | 只需一个 unary |
| 与 pin 升级的耦合 | 高（客户端半的 descriptor/服务图逐版漂移；本仓已有 api-gateway/renderer 的锁步测试与 fork 维护成本） | 低（三个 wire 名字 + 帧 schema，均有 vendor 单一来源可钉死） | 最低 |
| 与「网关不得成为 dsh 事实权威」边界 | 在网关进程内跑整张前端插件图，语义上最接近「把前端搬进服务端」 | 只读镜像 host 事件，符合计划 §5-1 裁决 | 同 b |
| 失效面 | 任一 cordis 服务缺失即整图 PENDING（本仓 `STATUS.md:392` 已记录过同类事故） | `$events` 不可用（未挂 api-remotes / 旧 runtime 树）⇒ 降 `mode:'poll'`，pending 缺失但其余不劣化 | 一直可用但不满足 W1 出口（pending 不可见） |

**推荐：(b)**，理由按权重排序：

1. 【事实 §1.8-4/5】pending 所需的两条 waterfall 与全部 session 事实都在同一 `$events` 白名单里，而 host 端**只提供这一条**订阅通道（`openWireStream` 对 `$events` 特判，:581-585）——(b) 与 (a) 拿到的是**同一份事实**，差别只在客户端解析成本。
2. 【事实 §1.8-7】(b) 需要的两个 unary 已经在本进程被生产使用（`runtime-manager.ts:872,932` 的 `dshCall`），payload 形状（`{args}`）与 cookie 注入都有现成实现。
3. 【推断】路线 a 的成本与风险与 W1 的出口（状态机/持久化/缺口重建/三路由）正交；(a) 会把 W1 变成「在 gateway 里复刻前端插件运行时」，既扩大信任面（计划 :255 对新信任面敏感）又与 design 17 §10「编排面剥离」的精神冲突。
4. 计划 §R5（:170）已经预留了这条路径：「若 W0 证明 request 事件可直接订阅，则退化为轻量订阅实现同一接口」——本蓝图就是那条「轻量订阅」，并给出它的语义保全条件（§5.4）。

**什么证据会改变推荐（写死在 W1 开工前的复核项）**：

- 【会翻向 (a)】实测发现 `$events` 的 waterfall/emit 帧在**同一 mux 连接上被别的消费者共享状态**（例如未来 pin 引入 per-client 事件过滤、或 waterfall 交付不再 fan-out 到全部客户端），或者 host 明确不给观察者回 `next` 的合法路径（即 §5.4 无法做到语义保全）。
- 【会翻向 (a)/(c) 混合】实测发现 `api-session/status` 有可观测缺失（例如 turn 结束时没有 true→false 边沿，而是长时间停在 true——`upstream-proposals.md:77-90` 描述的丢帧病态）：此时必须再加一条 `session/list` 对账（本蓝图已有）并在桌面侧保留 L1 纠正；若对账也无法收敛，则需要在 host 侧跑客户端图以复刻官方自愈。
- 【会翻向 (c) 仅为】(b) 的 waterfall 交付目标无法与「无浏览器时等待批准」共存，且上游拒绝提供观察者角色——这时 pending 只能回到「有壳才有」，W1 降级为完成轨道（(c) + 边沿推导）。
- 【会调整 (b) 的形态】`session/list` 在真实大会话量上单次耗时超预算（design 19 §3.5 已批评 30s 轮询级推导；`STATUS.md:386` 的壳回收语义说明状态面要轻）：则把周期对账降到「每次重连一次 + 5min tick」并依赖 emit 帧。

---

## 3. 模块与接口设计

### 3.1 新增文件

```text
packages/control-plane/src/session-mux.ts        新增：把 ws 依赖留在它已有的归属包；对 gateway 暴露结构类型与打开函数
packages/gateway/src/session-state/protocol.ts   新：wire/帧 类型与解析器（纯函数）
packages/gateway/src/session-state/store.ts      新：状态机 + 持久化 + 读标记 + 订阅/游标
packages/gateway/src/session-state/observer.ts   新：mux/轮询观察者（重连、基线对账、waterfall 委派）
packages/gateway/src/session-state/routes.ts     新：三条路由 + SSE（含游标/续传/背压）
packages/gateway/src/session-state/index.ts      新：createSessionStateService 组装与生命周期
packages/gateway/test/session-state/*.test.ts    新：见 §8（必须登记进 packages/gateway/scripts/test.mjs GROUPS）
```

修改（不在本文件作者范围，但 W1 必须改）：`packages/gateway/src/routes.ts`（`ChamberSurfaceDeps` 增 `sessionState`，`handleRoute` 在 404 兜底前认领 `/chamber/session-state*`）、`packages/gateway/src/index.ts`（组装 + `syncFeatures`/stop 接线）、`packages/gateway/src/config.ts`（`sessionState?: boolean` + `DSH_GATEWAY_SESSION_STATE`）、`packages/gateway/scripts/test.mjs`（新分组）、`docs/design/17-server-side-gateway.md`（§10/§10.5/§12/§20）、`docs/progress/STATUS.md`。

**`ws` 归属【事实 + 推断】**：`ws` 只声明在 `packages/control-plane/package.json:19`；`packages/gateway/package.json` 的 dependencies 只有 pnpm（:33-35），control-plane/dsh-runtime 是 devDependencies（:36-40，esbuild 打包进 dist，`scripts/build.mjs:38-39`）。pnpm 隔离布局下 `packages/gateway` 直接 `import 'ws'` 解析不到（网关构建脚本自己的注释就提到 `ws's websocket.js`，`build.mjs:22-32`）⇒ **把 WS 客户端放进控制面** `session-mux.ts`（该包已有 `ws`，且它是「访问 dsh 的 wire 客户端」这一职责的既有家），网关只 import 结构类型与工厂——零新依赖、零 manifest 改动。附带收益：W6（SSH 来源的桌面侧 headless 观察者）可直接复用同一原语。

### 3.2 关键接口（可直接照抄签名）

```ts
// packages/control-plane/src/session-mux.ts
export interface MuxSocket {
  readonly readyState: 'connecting' | 'open' | 'closed'
  send(text: string): void
  close(code?: number, reason?: string): void
  onMessage(listener: (text: string) => void): () => void
  onClose(listener: (info: { code: number; reason: string }) => void): () => void
  onError(listener: (error: Error) => void): () => void
}
/** 打开 host 的 /api/remote.mux。cookie 由调用方在每次连接时经 authCookieFor(baseUrl) 取得（绝不缓存）。 */
export function openRemoteMuxSocket(
  baseUrl: string,                          // 'http://127.0.0.1:<port>'
  options: { cookie: string | undefined; signal: AbortSignal; handshakeTimeoutMs?: number },
): MuxSocket
```

```ts
// packages/gateway/src/session-state/protocol.ts
export const SESSION_STATE_PATH = '/chamber/session-state'
export const SESSION_STATE_PROTOCOL = 1
export type SessionHostState = 'ready' | 'degraded' | 'starting' | 'stopped'
  | 'error' | 'restart-exhausted' | 'quarantined' | 'unknown'
export type SessionPendingKind = 'approval' | 'question'
export type SessionCompletedBy = 'edge' | 'gap' | null
export type SessionFeature = 'sse' | 'resume' | 'baseline' | 'pending-kind'
  | 'subagent-count' | 'read-watermark' | 'host-state' | 'gap-reconstruction'

export interface SessionBaselineItem {          // 摘自 host session/list，仅保留非敏感字段
  sessionId: string
  running: boolean
  updatedAt: number
  parentSessionId?: string
  origin?: 'subagent'
}
export function parseBaselineItems(value: unknown): SessionBaselineItem[]      // 严格，丢弃敏感字段
export function parseForwardedFrame(value: unknown): ForwardedFrame | null    // ready|emit|waterfall|cancel
export function parseReadBody(value: unknown): ReadRequest | null
```

```ts
// packages/gateway/src/session-state/store.ts
export interface SessionStateStore {
  load(): void
  snapshotFor(clientId: string | null): SessionStateSnapshot
  setHost(host: { state: SessionHostState; serviceable: boolean; at: number }): void
  setMode(mode: 'sse' | 'poll' | 'off'): void
  /** 基线合并：含缺口重建（§5.2）。返回本批是否有变更（决定是否推进游标）。 */
  applyBaseline(items: readonly SessionBaselineItem[], opts: { at: number; complete: boolean }): boolean
  applyStatus(sessionId: string, running: boolean, at: number): boolean
  applyActivity(sessionId: string, updatedAt: number, at: number): boolean
  applyAdded(item: SessionBaselineItem, at: number): boolean
  applyRemoved(sessionId: string, at: number): boolean
  applyError(sessionId: string, at: number): boolean        // 只置 error:true，绝不存 message
  applyPending(sessionId: string, kind: SessionPendingKind, at: number): boolean
  clearPending(sessionId: string, at: number): boolean
  markRead(clientId: string, sessionId: string, readMark: number, at: number): { changed: boolean; stored: boolean }
  markAllRead(clientId: string, readMark: number | null, at: number): { readMark: number; updated: number }
  subscribe(listener: (delta: SessionStateDelta, cursor: number) => void): () => void
  /** 从 ring 重放 > sinceCursor 的增量；不可满足返回 null（调用方回 snapshot）。 */
  replayFrom(sinceCursor: number): readonly SessionStateEvent[] | null
  flush(): void
  dispose(): void
}
export function createSessionStateStore(stateDir: string, logger: Logger): SessionStateStore
```

```ts
// packages/gateway/src/session-state/observer.ts
export interface SessionStateObserver {
  start(): void
  stop(): Promise<void>
  /** host ready / 行刷新触发（桌面事件驱动路径）：立刻做一次增量对账。 */
  kick(reason: 'host-ready' | 'resync' | 'tick' | 'frame-removed'): void
  status(): { mode: 'sse' | 'poll'; baselineAt: number | null; lastFrameAt: number | null
    reconnects: number; lastError: string | null }
}
export function createSessionStateObserver(deps: {
  logger: Logger
  store: SessionStateStore
  getBaseUrl(): string | null
  getHostState(): SessionHostState
  getExposureOk(): boolean
  /** 下游（浏览器/桌面）mux 客户端是否存在：gateway-proxy.getDiagnostics().activeStreams>0 */
  otherMuxClientsConnected(): boolean
  call: typeof import('@dsh-chamber/control-plane').call
  authCookieFor(baseUrl: string): string | undefined
  openSocket?: (baseUrl: string, opts: { cookie: string | undefined; signal: AbortSignal }) => MuxSocket
  now?: () => number
  reconnectMinMs?: number      // 默认 500
  reconnectMaxMs?: number      // 默认 15_000
  reconcileMs?: number         // sse 模式对账间隔，默认 60_000；poll 模式基线间隔，默认 15_000
  waterfallGraceMs?: number    // §5.4 默认 1_500
}): SessionStateObserver
```

```ts
// packages/gateway/src/session-state/routes.ts
export interface ChamberSessionState {
  handle(req: ApiRequest, res: ApiResponse, pathname: string): boolean   // true = 已认领（含 404）
  closeAllStreams(): void
}
export function createChamberSessionState(deps: {
  logger: Logger
  store: SessionStateStore
  observer: Pick<SessionStateObserver, 'kick' | 'status'>
  now?: () => number
  maxStreams?: number      // 默认 32（对齐 control-plane/src/api.ts:64）
  keepaliveMs?: number     // 默认 20_000（对齐 api.ts:468）
}): ChamberSessionState
```

```ts
// packages/gateway/src/session-state/index.ts
export interface SessionStateService {
  surface: ChamberSessionState
  start(): void
  stop(): Promise<void>
}
export function createSessionStateService(deps: {
  stateDir: string
  logger: Logger
  enabled: boolean
  getLocalDshPort(): number | null
  getConnectionState(): string
  canExposeLocal(): boolean
  otherMuxClientsConnected(): boolean
}): SessionStateService
```

### 3.3 index.ts 接线（不改变既有时序）

```ts
// `index.ts:282 之前（与 chamberSurface 同批；闭包惰性，createdPlane 尚未赋值——与 warmup 依赖同一范式）
const sessionState = createSessionStateService({
  stateDir: options.config.plane.stateDir,
  logger,
  enabled: options.config.sessionState !== false,
  getLocalDshPort: () => createdPlane.getLocalDshPort(),
  getConnectionState: () => createdPlane.connectionState,
  canExposeLocal: () => !stopping && !runtimeExposureQuarantined(),
  otherMuxClientsConnected: () => (proxy?.getDiagnostics().activeStreams ?? 0) > 0,
})
chamberSurface = createChamberSurface({ /* … 既有五参 … */, sessionState: sessionState.surface })
```

- **启动**：在 `syncFeatures(status)`（:443）末尾追加 `if (status === 'ready' || status === 'degraded') sessionState.start()`，否则 `sessionState.stop()`（幂等）。这样与 runtime 激活门共用同一边沿（:462 的 deferred drain 同理）。
- **停止**：`stop()` 内 `proxy?.closeAllStreams()`（:654）之前插 `sessionState.stop()`（内部先结束 SSE，再关 mux，最后 `store.flush()`）；**必须在 `store.close()`（:721）之前**。
- **启动重试/回滚路径**：`start()` 的 catch 分支（:575-625）隐含 `syncFeatures('error')`（:586）⇒ 已有 `sessionState.stop()`；无需额外处理。
- **运行时激活事务**（:501-555、:562-565）：`canExposeLocal` 在 quarantine 期间为 false，watcher 不开流，与代理/观察者的 D3/F4 门一致。

---

## 4. 数据与持久化

### 4.1 每会话记录（持久化行）

```ts
export interface SessionStateRow {
  sessionId: string
  running: boolean | null          // null = 未知（host 停机/从未观察）；host 不可用时客户端不得信它
  lastRunningAt: number | null     // watcher 时钟域（观察到 running=true 的时刻）
  updatedAt: number | null         // host 时钟域（summary.updatedAt；pin 上=用户消息水位）
  completedAt: number | null       // watcher 时钟域（收到 running true→false 边的时刻）
  completedBy: SessionCompletedBy  // 'edge'=实时观察；'gap'=重启缺口重建；只影响通知（gap 不补发）
  pendingKind: SessionPendingKind | null
  pendingSince: number | null      // watcher 时钟域
  subagentCount: number            // 由基线里 parentSessionId/origin='subagent' 行计数（不存 catalog 内容）
  present: boolean                 // 最近一次完整基线里有它
  error: boolean                   // 见过 api-session/error（只存布尔）
  observedAt: number               // watcher 时钟域（最后一次应用事实）
}
```

- **`lastRunningAt`**：`updatedAt` 无法表达运行开始（pin 上它只在用户消息时动，事实 §1.8-8）⇒ 定义 `lastRunningAt = 观察到 running=true 时的 watcher 时刻`，与 `completedAt` 同时钟域，并在字段注释里写清。两处时钟域必须显式标注：`updatedAt`=host；`lastRunningAt/completedAt/pendingSince/observedAt`=watcher。
- **时钟偏斜**：未读判定只用**服务端产出的水位自比较**：`factWatermark(row) = max(row.updatedAt ?? 0, row.completedAt ?? 0)`，客户端把 `readMark` 设为读取时刻它看到的 `factWatermark`（§11-①）。**绝不使用客户端墙钟**；跨会话之间的水位大小不承诺可比（两域混合），只承诺**同一会话**上的单调。

### 4.2 状态机

```text
          baseline/added                status(true)
absent ───────────────► idle ─────────────────────────► running
   ▲                     ▲  │                              │
   │ baseline 缺失        │  │ status(false)                │ status(false)
   │ (grace 后 prune)     │  ▼                              ▼
   └── removed ◄── present=false                     completed(edge|gap)
                                                     （completedAt 置位）
   pending: 任意存活态上叠加 pendingKind；clearPending / cancel 帧 / status(true) / removed 清它
```

转移表（实现即此表）：

| 触发 | 前置 | 动作 |
|---|---|---|
| 基线含行 | — | `updatedAt=max(old,new)`；`present=true`；`running=b.running`；若 `b.running` ⇒ `lastRunningAt=at`、`completedAt=null`、`completedBy=null`；若旧态 `running===true && b.running===false` ⇒ `completedAt=at, completedBy='gap'`；`observedAt=at` |
| 基线缺行 | 旧 `present===true` | `present=false, running=null`；**不置 completedAt**（删除≠完成，R13:206）；超过 `ABSENT_GRACE_MS=30_000` 或下一次完整基线仍缺 ⇒ prune + 发 `session-removed` |
| `api-session/added` | — | 建行（`running` 取 summary；`updatedAt` 取 summary） |
| `api-session/status(id,false)` | 旧 `running===true` | `running=false; completedAt=at; completedBy='edge'` |
| `api-session/status(id,true)` | — | `running=true; lastRunningAt=at; completedAt=null; completedBy=null; pendingKind=null`（新运行消解旧边沿） |
| `api-session/activity(id,updatedAt)` | — | `updatedAt=max(old,event.updatedAt)` |
| `api-session/removed(id)` | — | `present=false; running=null; pendingKind=null; completedAt=null`（R13 幽灵未读归零） |
| `api-session/error(id)` | — | `error=true`（**丢弃 message**） |
| `approval/request` / `user-questions/request` waterfall | — | `pendingKind='approval'` 或 `'question'`；`pendingSince=at`（**不回写 request 内容**）；并按 §5.4 应答 |
| `{type:'cancel',eventId}` | 对应 waterfall | `pendingKind=null; pendingSince=null` |

### 4.3 持久化格式与位置

```text
<stateDir>/session-state/            # 0700（ensurePrivateDirectoryNoFollow）
└─ state.json                       # 0600、原子、主+备（createJsonStore）
```

```jsonc
{
  "schemaVersion": 1,
  "revision": 42,
  "cursor": 1843,                 // 单调，跨网关重启不回落（决定 Last-Event-ID 是否可满足）
  "watcherEpoch": "2026-12-21T09:00:00.000Z",
  "host": { "state": "ready", "serviceable": true, "since": 1766000000000,
            "lastBaselineAt": 1766000012345, "baselineOk": true },
  "sessions": [ /* SessionStateRow[]，按 updatedAt/observedAt 降序，≤ MAX_SESSIONS */ ],
  "readMarks": { "<clientId>": { "<sessionId>": { "readMark": 1765999999000, "at": 1766000000000 } } },
  "dropped": { "sessions": 0, "readMarks": 0 }   // 绝不静默（对齐 json-store 的 dropped 纪律）
}
```

- **写入时机**：任何变更 `markDirty()`；`flush()` 由 (a) 1s 去抖定时器（unref）、(b) SSE 游标推进（每批）、(c) `stop()`、(d) `process.on('exit')`（best-effort）触发。**SSE 每帧不做同步 fsync**——避免 `dispatch.ts:100` 注释点名的「单线程事件循环被同步盘 I/O 钉住」类问题。
- **为何不落 JSONL（对计划 §4/R3 的收敛建议）**：SSE 续传只需**内存 ring**（重启即失效 → 客户端全量重取，正是计划 §4:88 允许的行为）；持久化的唯一职责是「重启后重建未读」，快照已含 `updatedAt/completedAt/readMarks` 的全部信息。JSONL 会引入无界增长与第二份真相。若 review 坚持 journal，必须带轮转上限并把 ring 与 journal 定义为同一物（§11-③）。
- **限额**：`MAX_SESSIONS=2000`（超出按 `observedAt` 淘汰并累加 `dropped.sessions`）、`MAX_READ_CLIENTS=64`（按最后写入 LRU）、`MAX_MARKS_PER_CLIENT=5000`、`SNAPSHOT_MAX_BYTES=2 MiB`（写前裁剪）、`READ_BODY_MAX_BYTES=16 KiB`、ring `SSE_RING_MAX=1024` 事件。
- **读标记 TTL（计划 §4:96「旧标记由服务端 TTL 清理」）**：客户端级 90 天未活动即整块删除；会话级在会话被 prune 时一并删除。
- **corrupt 处理**：复用 `createJsonStore` 的语义（主坏读备、双坏响亮失败、`recoveryState` 暴露给 `observer.status()` 与日志），**绝不当空**（对齐 `plugins-journal.ts:447-464` 的 A3-9 纪律）。
- **权限**：目录 0700、文件 0600、no-follow（`private-file.ts:163/224/335`）；Windows 继承 ACL、不伪报 0700（design 17 §12:906-908）。

### 4.4 SSE 游标与内存 ring

- `cursor` 是**全局单调整数**（不是 per-session），持久化。每个 `SessionStateDelta` 提交时 `++cursor` 并入 ring：`{ cursor, event: 'session'|'session-removed'|'host'|'mode', data }`。
- 客户端 `Last-Event-ID: N`：`N >= ring[0].cursor - 1` ⇒ 重放 `cursor > N` 的事件；否则（过期/缺失/大于当前 cursor）⇒ 发 `snapshot`（含当前 cursor）。**N 大于当前 cursor（伪造/网关回滚）同样走 snapshot**。

---

## 5. 缺口重建与故障语义

### 5.1 基线协议（每次连/重连一次；对账 tick 复用同一路径）

```text
1. open mux socket（cookie 现取）→ send {type:'open',streamId,endpoint:'$events',payload:{args:{}}}
2. 帧到达：若 baselineInFlight 则入队；否则立即应用
3. baselineInFlight=true; await call(baseUrl,'session/list',{args:{}})   # 一次全量
4. 应用响应 → store.applyBaseline(items,{at:now,complete:true})
5. baselineInFlight=false; 依次应用步骤 2 中排队的帧（它们按到达序晚于基线快照）
6. 若步骤 4 失败 ⇒ hostState='unknown'（不触碰 completedAt），退避重试
```

- 步骤 2-5 是标准 snapshot+replay：排队帧只可能来自基线请求发出之后（本地 loopback，投递延迟亚毫秒级），因此后应用安全。
- **残余窗口**：帧在基线快照生成之后、请求发出之前产生（顺序：host 生成帧 → 快照 → 我们发请求）会在步骤 5 被当作「更新」应用，可能把一个已完成的会话暂时写回 running=true。缓解：(a) 对账 tick 覆盖；(b) 若同一会话在 `RESYNC_SETTLE_MS=250` 内既有 status(true) 又有基线 running=false，以基线为准。**该残余由契约测试锁定**（§8-3）。
- `session/list` 是无游标全量（`typert.host.js:409-419`）【事实】⇒ 不需要分页循环；但大会话量下耗时可能到秒级，因此对账**串行单飞**（in-flight 期间到达的 tick 合并）。

### 5.2 重启缺口重建规则（`stored.running && !baseline.running ⇒ completedAt`）

| 场景 | 存储态 | 基线态 | 规则 |
|---|---|---|---|
| 会话在 watcher 停机期间完成 | `running=true` | 行在，`running=false` | `completedAt=at, completedBy='gap'`（判据同 R3:160；**不补发通知**，计划 §5-5:109） |
| 会话停机期间继续跑 | `running=true` | 行在，`running=true` | 不置 `completedAt`；`lastRunningAt=at` |
| 会话停机期间新建 | 无行 | 行在 | 新建（`completedAt=null`）；发 `added` 提示（触发一次桌面 unary 行刷新，R9:186-188） |
| 会话停机期间被删除 | 任意 | 行缺 | `present=false, running=null`；**不置 completedAt**；grace 后 prune + `session-removed`（R13:206） |
| host 在停机期间被重启（不是完成，是 turn 被腰斩） | `running=true` | 行在，`running=false` | 同第 1 行：产生 `gap` 未读。**已知的假阳性方向**：宁可多一次未读（可被「标记全部已读」/自停标记清掉），不可丢真未读；下游不得为 `gap` 发通知（§9-R3） |
| 快照文件 corrupt | `integrity=corrupt` | 任意 | 不假装空：`dropped` 计数 + loud warn + 坏文件移边（createJsonStore 语义），本轮基线按冷启动处理（所有行 `completedBy=null`），**只牺牲未读、不伪造未读** |
| watcher 回退版本/重启后 cursor 回退 | — | — | cursor 持久化 ⇒ 不回落；文件丢失则冷启动（客户端 Last-Event-ID 不可满足 → snapshot） |

### 5.3 host 不可用语义（host-down = unknown，不伪造）

- `host.serviceable` 由 `getLocalDshPort()!=null && getExposureOk() && (state==='ready'||state==='degraded')` 派生；`host.state` 投影 plane 的 `connectionState`（含 `quarantined`/`unknown` 兜底）。
- 不可用期间：**三条路由仍 200**（绝不 503）；行照常返回但**必须按 `host.serviceable=false` 解读为 unknown**；`running` 保留最后已知值仅供 UI 展示，语义权威是 host 门。满足 R14（断连仍呈现未读）与验收矩阵「host 停机：状态 unknown，无假完成、无假未读」（计划 :238）。
- host 门翻转只发**一个 `host` 事件**（不逐行 fan-out，防 N 行洪泛）；行不重发。
- 恢复：走 §5.1 基线；由 `syncFeatures('ready'|'degraded')` 触发。
- 激活 quarantine（`index.ts:166-171`）：`state='quarantined'`、serviceable=false；候选 runtime 树的会话事实一律不采信。
- 与 `/chamber/runtime` 一样，本面**不随 ready detach**（保持在 auth 门内可轮询），这是计划 §4 与 design 17 §10.3（:725）对 runtime 面的既有纪律，watcher 沿用【推断：一致性收益大于成本】。

### 5.4 waterfall 委派（pending 观测的语义保全，**本设计最脆的一处**）

问题【事实 §1.8-3】：host 把每个 `approval/request`/`user-questions/request` waterfall 投给**所有**打开 `$events` 的客户端，结算条件是「所有交付方都已应答，或任一方给出 result」。因此：

- watcher 静默 ⇒ 当浏览器（唯一真正的人类应答者）回 `next` 委派时，瀑布因 watcher 未答而**永久挂起**；
- watcher 无条件回 `next` ⇒ 无浏览器时 `deliveries.size===0` 立即结算为 `next` ⇒ host 落到 `() => 'unavailable'`（`@vendor/dsh-user-approval/lib/index.js:179`），**把「等待人批准」变成「自动不可用」**，破坏网关形态的批准语义。

规则（实现即此表）：

| 条件 | 动作 |
|---|---|
| 收到 waterfall 帧 | 记录 `pendingKind` + `pendingSince`，把 `{eventId, agentId, kind, receivedAt}` 放进 `unansweredWaterfalls` |
| `otherMuxClientsConnected()===true` 且帧龄 ≥ `waterfallGraceMs`（默认 1500ms） | 回 `{kind:'next'}`（语义等价于「本观察者不存在」：浏览器给 result 会先结算；浏览器给 next 时由 watcher 补齐计数） |
| 无其他下游客户端 | **保持不应答**（复刻「没人连接时批准等待人类」的现状）；一旦检测到新下游客户端接入（对账 tick 读 `activeStreams` 由 0→>0），对存量未答帧补回 `next` |
| 收到 `cancel` 帧 | 从 `unansweredWaterfalls` 移除、清 `pendingKind`，**不再应答**（已结算或已被他人结算） |
| stream 断开 | 未答帧全部丢弃（host 侧 `removeRemoteEventClient` 会把该客户端从 deliveries 移除，:698-706） |

- 应答走 unary：`call(baseUrl,'$events/result',{args:{clientId,eventId,outcome:{kind:'next'}}})`（payload 形状由 host `parseRemoteEventResultPayload` 钉死，`@vendor/dsh-api-gateway/lib/index.js:922-924`；端点 `$events/result` 由 `claimsEndpoint` 单独认领，:508）。失败重试 1 次后放弃并 loud warn（此后瀑布由 host 的超时/中止路径收敛）。
- `otherMuxClientsConnected` 的**唯一来源**是网关代理的 WS 计数：`packages/gateway/src/gateway-proxy.ts:330-341` 的 `getDiagnostics().activeStreams`（由 `counters.activeStreams` 维护，上限 `MAX_CONCURRENT_WS_STREAMS`）。watcher 的 mux 直连 127.0.0.1，不经过代理 ⇒ **不会把自己算进去**【事实 + 推断，依赖 gateway-proxy 只统计下游 splice】。W1 需加一条接线锁测试断言「watcher 直连不计入 activeStreams」。
- 备选（写进 §11-⑦ 的上游提案）：让 host 支持 observer 语义（`$events?observer=1` 或 watermark 声明），使观察者不进入 waterfall deliveries。落地前必须用本规则兜底。

## 6. 路由契约（含 JSON 示例）

三条路由全部挂在既有 `/chamber/*` auth 门内（`dispatch.ts:989-993`），前缀认领放在 `routes.ts` 的 404 兜底（:1593）之前：

```ts
if (pathname === SESSION_STATE_PATH || pathname.startsWith(SESSION_STATE_PATH + '/')) {
  sessionState.handle(req, res, pathname)   // 内部自行判子路径/方法，未知子路径 404
  return true
}
```

### 6.1 `GET /chamber/session-state`（快照）

请求：`GET /chamber/session-state?clientId=<id>&sourceId=<label>`（两个 query 都可选；`clientId` 只用于挑选 `read.mine`）。

```json
{
  "protocol": 1,
  "features": ["sse","resume","baseline","pending-kind","subagent-count","read-watermark","host-state","gap-reconstruction"],
  "mode": "sse",
  "cursor": 1843,
  "sourceId": "gateway-abc123",
  "observedAt": 1766000012400,
  "host": {
    "state": "ready",
    "serviceable": true,
    "since": 1766000000000,
    "lastBaselineAt": 1766000012345,
    "baselineOk": true
  },
  "observer": { "mode": "sse", "lastFrameAt": 1766000012300, "reconnects": 0, "lastError": null },
  "read": {
    "clientId": "install-7f3c9a",
    "mine":      { "s_abc": { "readMark": 1765999999000, "at": 1766000000000 } },
    "effective": { "s_abc": 1765999999000 }
  },
  "sessions": [
    {
      "sessionId": "s_abc",
      "running": false,
      "lastRunningAt": 1766000012000,
      "updatedAt": 1765999999000,
      "completedAt": 1766000012200,
      "completedBy": "edge",
      "pendingKind": null,
      "pendingSince": null,
      "subagentCount": 0,
      "present": true,
      "error": false,
      "observedAt": 1766000012200
    },
    {
      "sessionId": "s_def",
      "running": true,
      "lastRunningAt": 1766000011000,
      "updatedAt": 1766000009000,
      "completedAt": null,
      "completedBy": null,
      "pendingKind": "approval",
      "pendingSince": 1766000011800,
      "subagentCount": 2,
      "present": true,
      "error": false,
      "observedAt": 1766000011800
    }
  ]
}
```

- `sessions` 不含 `title/cwd/prompt/todos/消息`（§7）。
- host 不可用时同形状，`host.serviceable=false`、`host.state='stopped'|'quarantined'|…`，行照旧（解读为 unknown，§5.3）。
- `mode:'poll'` 时 `features` 去掉 `pending-kind`；`mode:'off'` 时 `features:[]`、`sessions:[]`。
- `observer` 为**可选**诊断块（默认存在于 gateway 形态；旧桌面忽略未知字段）。

### 6.2 `GET /chamber/session-state/stream`（SSE + Last-Event-ID 续传）

请求头：`Accept: text/event-stream`，可选 `Last-Event-ID: 1842`；可选 query `clientId`（用于订阅 `read` 事件）。

```text
HTTP/1.1 200 OK
content-type: text/event-stream
cache-control: no-store
connection: keep-alive

id: 1843
event: snapshot
data: {"protocol":1,"mode":"sse","cursor":1843,"host":{"state":"ready","serviceable":true},"sessions":[],"read":{}}

id: 1844
event: session
data: {"sessionId":"s_abc","running":false,"lastRunningAt":1766000012000,"updatedAt":1765999999000,"completedAt":1766000012200,"completedBy":"edge","pendingKind":null,"pendingSince":null,"subagentCount":0,"present":true,"error":false,"observedAt":1766000012200}

id: 1845
event: host
data: {"state":"stopped","serviceable":false,"since":1766000200000,"lastBaselineAt":1766000012345,"baselineOk":true}

id: 1846
event: read
data: {"clientId":"install-7f3c9a","sessionId":"s_abc","readMark":1766000012200,"at":1766000210000}

id: 1847
event: session-removed
data: {"sessionId":"s_ghi"}

: keepalive
```

- `id:` 恒为推进后的全局 cursor（每条事件一个，单调）。续传规则见 §4.4：可满足则**不重发 snapshot**，只补 `id > Last-Event-ID` 的事件；不可满足则发 `snapshot`（即计划 §4:88「缓冲窗口不足时客户端全量重取」的服务端等价物）。
- 事件类型：`snapshot | session | session-removed | host | mode | read`。未知事件类型客户端必须忽略（为 0.4.x 加法留缝）。
- 背压/上限：并发流 ≤ `maxStreams=32`（超出 503 `resource_exhausted`）、待发帧 ≤ 32（超出即 teardown）、keepalive 20s；逐条镜像 `control-plane/src/api.ts:64,66,364-468`。
- 半死连接：host 的 mux 心跳（默认 2s、2 次未答 terminate，`@vendor/dsh-api-gateway/lib/index.js:197,433`）在物理层断开；SSE 侧只靠 keepalive 写失败/close 发现客户端死亡——与既有 health-events 同构。

### 6.3 `POST /chamber/session-state/read` 与 `/read-all`（幂等水位 upsert）

```jsonc
// POST /chamber/session-state/read
{ "clientId": "install-7f3c9a", "sessionId": "s_abc", "readMark": 1766000012200, "sourceId": "gateway-abc123" }
// 200
{ "ok": true, "clientId": "install-7f3c9a", "sessionId": "s_abc", "readMark": 1766000012200,
  "changed": true, "stored": true }

// POST /chamber/session-state/read-all   （readMark 省略 ⇒ 服务端取 max(updatedAt, completedAt)）
{ "clientId": "install-7f3c9a", "readMark": 1766000012200 }
// 200
{ "ok": true, "clientId": "install-7f3c9a", "readMark": 1766000012200, "changed": true, "updated": 3 }
```

- **幂等且只升不降**：存储 `readMark = max(stored, incoming)`；低值/等值重复提交返回 `changed:false`（R4:162 的幂等判据）。
- `stored:false` 用于「未知会话 id」：接受请求、不建行、不落盘（防无界积累）。`read-all` 的 `readMark` 缺省时用服务端当前所有行的 `factWatermark` 最大值。
- 校验：body ≤ 16 KiB（超出 413 + `req.destroy()`，镜像 `dispatch.ts:898-902`）；`clientId` 匹配 `^[A-Za-z0-9._:-]{1,64}$`；`sessionId` 为 1–128 字符、无控制字符；`readMark` 必须为非负有限整数。任一不满足 → 400 `bad_request`。
- **判定口径**：客户端未读用 `effective`（本来源所有客户端读标记的逐会话 max），不是 `mine`；这是 R10:190-192「手机读掉桌面即灭」唯一能成立的算法（§11-⑤）。
- `sourceId` **只回显、不参与 key**（key = `clientId` + `sessionId`）。
- 写成功后向所有 SSE 订阅者广播 `read` 事件（携带 `clientId`）。

### 6.4 方法与状态码总表

| 路由 | 方法 | 成功 | 其他 |
|---|---|---|---|
| `/chamber/session-state` | GET/HEAD | 200 JSON | 405 `method_not_allowed`（带 `allow: GET, HEAD`）；400（非法 query） |
| `/chamber/session-state/stream` | GET | 200 `text/event-stream` | 405；503 `resource_exhausted`（流上限）；400（非法 query） |
| `/chamber/session-state/read` | POST | 200 JSON | 400 `bad_request` / 413 `body_too_large` / 405 |
| `/chamber/session-state/read-all` | POST | 200 JSON | 同上 |
| `/chamber/session-state/<其它>` | * | 404 `not_found`（沿用 routes.ts:1593 的码） | 面已认领，不会落到 dsh 代理 |
| 未认证 | 任意 | — | 401 `unauthorized`（dispatch :672 既有路径统一给出，不新增） |
| 禁用（`sessionState:false`） | 任意 | 200 `{protocol:1,features:[],mode:'off',sessions:[]}` | **不返回 404**：让新桌面能区分「旧网关」与「网关显式关闭」（§11-④） |

### 6.5 能力广告

- **调用即探测**（不新增探测端点）：客户端一旦 404 或响应无 `protocol` ⇒ 旧网关 ⇒ 走现状路径（计划 §4:91）。
- `protocol: 1` 是本接口版本；`features[]` 是加法面；`mode` 是运行时降级面：
  - `mode:'sse'`：`$events` 已连接，含 `pending-kind`；
  - `mode:'poll'`：mux 不可用（未挂 api-remotes / 异常），只剩 `baseline` 与轮询边沿，`features` 去掉 `pending-kind`（R18:222-224 的降级标注）；
  - `mode:'off'`：配置关闭（`DSH_GATEWAY_SESSION_STATE=0` 或 `--no-session-state`）；`features:[]`。
- `mode` 变化会作为 `mode` 事件推给 SSE 订阅者，并随每次 `snapshot` 重报 ⇒ 客户端不需要额外轮询。
- 未来加字段规则（计划 §6:124）：只加字段/加 feature 名；语义变更必须换新 feature 名并保留一版双读。

---

## 7. 鉴权与隐私

- **鉴权**：路由在 `dispatch.ts:989-993` 的门内，与 `/chamber/plugins`、`/chamber/runtime` 同一门；401/403/421 分类与审计（`auditPathCategory='chamber'`，:84-90）零改动。SSE 连接同样受 `trackHttp`（:369-381）与 `dispatch.quiesce()`（:320、:421-）约束：凭据轮换/stop 会主动断开。
- **不新增秘密**：路由不接收/返回 token；响应 `cache-control: no-store`（`jsonResponse` 固定，`http-utils.ts:35`）。
- **脱敏清单（写进代码注释 + 测试锁定）**：
  1. 不存 `title`、`cwd`、`agentPreset`、`todos`、`projects`、`modelSelection`、`subagentCatalog`（`session/list` 里都有——**投影必须逐字段白名单**，白名单即 §3.2 的 `SessionBaselineItem`）；
  2. `api-session/error` 的 `errorChain` 文本丢弃，只留 `error:true`；
  3. waterfall 的 `request` 载荷（工具名/命令/问题文本）**只在内存中存活到应答**，不落盘、不进日志、不进 SSE；
  4. 日志只写 sessionId/kind/计数；需要错误文本时经 `sanitizeRouteError`（`sanitize-route-error.ts:20-27`，含 URL userinfo/query 与 token/password/secret 模式脱敏）；
  5. `credentials/reference-updated`、`settings/document-updated`、`cordis/*`、`llm/adapters-updated` 等白名单里的其它事件一律**即时丢弃**（不解析、不缓存、不日志）。
- **多客户端隐私**：快照的 `read.mine` 只回请求方自己的标记；`read.effective` 只回水位数值（不含是哪个 client 读的）；SSE 的 `read` 事件含 `clientId`（跨端同步必需），因此 `clientId` 必须被定义为**不可猜测的随机 install id**（计划 §4:96 的「首启生成一次」满足）。
- **文件权限**：`<stateDir>/session-state/` 0700、`state.json` 0600、no-follow 原子写；快照含 sessionId 与时间，不含内容，仍按 stateDir 的 S15 纪律（design 17 §12:899-911）。
- **本地 host cookie**：watcher 复用进程内 `authCookieFor`（内存态），**只用于 WS/HTTP 出站**；绝不写入自身状态文件、日志、SSE 或任何路由响应（AGENTS.md 凭据纪律）。
- **整体关闭**：配置开关（默认开）可让服务端不建立任何到 host 的 mux 连接（`mode:'off'`），对应计划 §11:257 的「可整体关闭」。

---

## 8. 测试清单（沿用 `packages/gateway/test` 现有风格，全部登记进 `scripts/test.mjs` 新分组 `session-state`）

1. `test/session-state/session-state-store.test.ts`（纯模块；临时 stateDir + `node:test`）
   - 基线合并：新行/更新/子代理计数（`origin:'subagent'` 与 `parentSessionId`）；
   - 边沿：`status(true)` 消解 `completedAt`；`status(false)` 仅在旧 running=true 时置 `completedAt/completedBy='edge'`；
   - 读标记：max 语义、`changed:false` 幂等、未知会话 `stored:false`、`read-all` 缺省取 max(factWatermark)、effective=max over clients；
   - 限额：`MAX_SESSIONS`/每客户端标记上限/LRU+TTL，`dropped` 计数非沉默；
   - 持久化：原子写、0600/0700（非 win32 断言 mode）、reload 后 cursor 不回落、corrupt 主文件→读备、双坏 loud throw；
   - `replayFrom`：ring 内/过期/未来 cursor 三态。
2. `test/session-state/session-state-protocol.test.ts`（纯解析）
   - `parseBaselineItems` **丢弃** title/cwd/todos/agentPreset/projections（喂一份真实形状的 `session/list` JSON，断言输出对象的键集合恰好等于白名单）；
   - `parseForwardedFrame` 对 ready/emit/waterfall/cancel 的正例与畸形帧；
   - `parseReadBody` 边界（非对象、超长、控制字符、NaN/负值）。
3. `test/session-state/session-state-observer.test.ts`（注入 `openSocket`/假计时器的假 mux，不依赖真实 `ws`）
   - open 帧形状：`{type:'open',streamId,endpoint:'$events',payload:{args:{}}}`；
   - 帧路由：ready 取 clientId；emit/waterfall/cancel 分流；`api-session/status` 驱动 store；
   - **waterfall 委派三态**：无其他客户端 ⇒ 不应答且 `unansweredWaterfalls` 有记录；`otherMuxClientsConnected()===true` 且过 grace ⇒ 发 `{args:{clientId,eventId,outcome:{kind:'next'}}}` 到 `$events/result`；0→>0 检出后补答存量；
   - 重连退避与 `reconnects` 计数；`gateway/service-unavailable` ⇒ `mode='poll'`；
   - 基线协议：open 先于基线、期间帧入队、基线后按序应用；`session/list` 失败不改 `completedAt`；
   - 单飞：tick 在 in-flight 期间合并。
4. `test/session-state/session-state-routes.test.ts`（FakeRequest/FakeResponse 直调 surface）
   - 快照 200 形状 + 键白名单 + host 门字段；
   - 405/400/404、`body_too_large` 413 + 请求被 destroy、`read`/`read-all` 200 与幂等；
   - SSE：header、首帧 snapshot、`id:` 严格单调、`Last-Event-ID` 可满足→只补增量、过期→snapshot、未知事件名不炸客户端；
   - 并发上限 503、待发帧溢出即 teardown、`res.on('close')` 清理、`closeAllStreams()` 幂等；
   - `sessionState:false` ⇒ `mode:'off'` 且不建 mux（observer 假件未被调用）。
5. `test/session-state/session-state-restart.test.ts`（状态文件 + 假基线）
   - §5.2 全表逐行：gap 完成、继续运行、新建、删除、host 重启腰斩、corrupt 快照冷启动；
   - `completedBy:'gap'` 的判定与「不得为 gap 发通知」的投影标志（服务端只给标志，通知抑制在桌面侧）；
   - host 停机窗口：serviceable=false、行不重发、恢复后一次基线收敛。
6. `test/session-state/session-state-privacy.test.ts`（序列化文件 + 日志捕获）
   - 喂含 title/cwd/todos/error chain/waterfall request 的帧，断言落盘 JSON 与捕获日志**不含**这些子串；
   - 断言 cookie 不出现在任何文件/日志/响应里（用哨兵 cookie 字符串）。
7. `test/boundary/config.test.ts`（**扩充既有文件**）：`DSH_GATEWAY_SESSION_STATE` 的 `1/0/true/false` 与非法值 loud 报错；默认 true。
8. 接线锁（可并入 5 或新文件）：`gateway-proxy.getDiagnostics().activeStreams` 不计 watcher 直连；`stop()` 顺序（SSE 结束 → mux 关闭 → flush → store.close）；`canExposeLocal=false` 时不开流。
9. 契约/降级：以假 surface 模拟旧网关（404 / 无 `protocol`）与 `mode:'poll'`，断言客户端可见字段集合；三档版本矩阵的客户端一侧在桌面 W2 落地，本包只锁服务端形状。

---

## 9. 风险

| # | 风险 | 影响 | 对策 / 判据 |
|---|---|---|---|
| R1 | **waterfall 交付目标语义**（§5.4）：应答策略做错 ⇒ 无浏览器时批准被自动判 unavailable，或浏览器委派时批准永挂 | 高（宿主可用性） | §5.4 规则 + 接线锁（`activeStreams` 真值）+ 假 mux 三态测试；**W1 出口增一条实机判据：无浏览器时发起一次需批准的工具，批准必须仍处于等待态**；上游 observer 角色提案（§11-⑦） |
| R2 | `updatedAt` 不含 agent 产出（已验证）⇒ 任何仍按「水位优先」实现未读的调用方会漏掉全部完成 | 高（功能主线） | §11-① 的 factWatermark/未读谓词修订；W2 必须同步；CI 契约测试断言 `completedAt` 进入未读 |
| R3 | gap 边沿在下述场景产生假未读：host 重启腰斩 turn；watcher 停机期间 host 侧状态变化 | 中 | `completedBy:'gap'` 不发通知；「标记全部已读」出口；桌面自停标记已读（R12:199-201）；判据「注入 host 停机，零通知、未读可一键清」 |
| R4 | emit 丢帧（无重传）⇒ running 位可能长时间停在 true | 中 | 周期对账（§5.1）+ 每次重连基线；间隔可配；与 design 14 §D4 的 L1 纠正并存 |
| R5 | `session/list` 是一次磁盘走查（大会话量耗时） | 中 | 单飞 + 可配间隔 + 只在 boot/重连/tick 调用；`observer.status()` 暴露基线耗时 |
| R6 | 新增本地 mux 长连接 + cookie 出站 = 新信任面/新失败面 | 中 | 只读元数据、不落内容、可整体关闭、cookie 内存态；断线退避不刷日志；stop 顺序锁 |
| R7 | 帧解析：vendor 对帧做 exactKeys 严格校验，上游加字段会整帧解析失败 | 中 | 解析器对**未知字段宽容、已知字段严格**（有意偏离 vendor 的 exactKeys；只对消费的 4 个事件做严格解析），并在注释里记录该偏离 |
| R8 | SSE 广播在慢客户端上拖累事件循环 | 低 | 镜像 `api.ts` 的有界背压（32 帧）+ keepalive 不占队列 + 流上限 32 |
| R9 | 会话 id 数无界增长 ⇒ 状态文件膨胀 | 低 | `MAX_SESSIONS` + prune + `dropped` 计数 + 2 MiB 写前裁剪 |
| R10 | 版本偏斜：旧网关 404 / 新网关关闭 / pin 升级后事件白名单变化 | 中 | 调用即探测 + `mode` + `features`；「`$events` open 失败或首帧非 ready ⇒ poll」（R18:222-224 的握手降级在此具体化） |
| R11 | 与 design 17 §10「编排面剥离不得回流」的冲突被 review 判为回流 | 中（流程） | §11-⑥ 的 design 17 §10 明文 carve-out + §20 被否方案条目 |

---

## 10. 工作量估计

单人估算（不含 W0 实测与桌面 W2/W3）：

| 工作项 | 人日 |
|---|---|
| `packages/control-plane/src/session-mux.ts`（ws 接入、cookie、结构类型、握手超时） | 1.0 |
| `session-state/protocol.ts`（帧/基线解析 + 白名单投影） | 0.5 |
| `session-state/store.ts`（状态机、json-store 持久化、读标记、游标/ring、限额/TTL） | 2.5 |
| `session-state/observer.ts`（mux/轮询、基线协议、重连退避、waterfall 委派、对账 tick） | 3.5 |
| `session-state/routes.ts`（三路由 + SSE 背压/续传/上限） | 2.0 |
| `index.ts`/`routes.ts`/`config.ts` 接线与生命周期 | 1.0 |
| 隐私/权限/脱敏收口（含日志哨兵） | 1.0 |
| 测试 6–7 文件（≈1200 行） | 3.0 |
| 契约/故障注入/降级（旧网关、网关重启、host 停机/quarantine） | 1.5 |
| 文档（design 17 §10/§10.5/§12/§20、STATUS 增删、W1 出口改写） | 1.0 |
| **合计** | **≈17 人日**（含约 20% buffer；两人并行（观察者/存储 ∥ 路由/测试）约 8–10 个工作日） |

里程碑切分建议（供 Lead 排期）：M1 = protocol + store + 纯测试（约 3 天，可独立 review）；M2 = control-plane mux + observer + 假 mux 测试（约 4 天）；M3 = routes + SSE + 接线（约 3 天）；M4 = 故障注入/契约/文档收口（约 3 天）。

---

## 11. 对主计划 W1 与 4 的修订建议

> 每条给出「现状 → 建议」与依据；不改计划文档本身，由 Lead 裁决合并。

① **【最重要】未读判定与 `readMark` 定义必须按事实水位改写（§4:94-96、§5-3:107、§5-13:117）**
   - 现状：`unread ⟺ updatedAt > readMark`，`readMark` = 读取时刻的 `updatedAt`，「水位优先、`completedAt` 只作触发/回退」。
   - 依据【事实 §1.8-8】：pin 上 `updatedAt` 只在 user-authored 消息时推进 ⇒ 「水位优先」会把 **agent 产出的完成**漏成「无未读」；反之，用户读完一条消息后再等 agent 跑完，`updatedAt` 一动不动 ⇒ 蓝点永不亮。
   - 建议：
     1. 定义 `factWatermark(row) = max(row.updatedAt ?? 0, row.completedAt ?? 0)`；
     2. `unread ⟺ factWatermark > readMark`，`readMark` 写为**读取时刻该会话的 factWatermark**（不是单取 updatedAt）；
     3. `completedAt` 由 Edge 轨产出（本蓝图），并带 `completedBy`；把「水位优先」改为「**事实并集，边沿负责完成**」；
     4. 时钟域条款（§5-13）改为：`updatedAt` = host 域；`completedAt/pendingSince/lastRunningAt` = watcher 域；**只做服务端产出的水位自比较**，禁止客户端墙钟与跨域数值比较。
   - 影响面：R4（:160-164）、R6（:175-177，去重键 `(sourceId,sessionId,completedAt)` 应改为 `(sourceId,sessionId,factWatermark)`）、R12（:199-201，「自停标记已读」读作 `readMark := factWatermark`）、W2/W4 的桌面实现。

② **【重要】W1 的启动依赖应从「W0 二分」改为「W0 只做 E2E 复核」（§3.1:46-54、W0:134）**
   - 静态证据已给出 ① 的答案（不推进）；建议 W1 立即按 Track B 开工，W0 的 30 分钟实测降为**复核门**（确认线上无额外推进 `updatedAt` 的路径，例如未来 pin 或插件补写）。

③ **持久化形态建议改为「单快照 + 内存 ring」，取消 JSONL（§4:94、R3:158-159）**
   - 依据：SSE 续传只需内存 ring，重启后全量重取本就是契约（§4:88）；JSONL 会引入无界增长与第二份真相，而 `createJsonStore` 已提供 corrupt≠空/备份/回收语义。若 review 坚持 journal，把它定义为 ring 的落盘镜像并共用同一游标与轮换上限。

④ **`sessionState:false` 的降级语义建议选「注册但不建流」而不是 404（§4:91「调用即探测」）**
   - 理由：404 无法区分「旧网关」与「新网关显式关闭」，会让桌面显示错误的「网关未升级」提示（R17:218-220 要求可见且不静默）。建议 `mode:'off'` + 空 `features[]`；若 Lead 选择 404，请在 R17 文案里补一档「网关存在但状态面被关闭」。

⑤ **读标记的键与求值（§4:95-96）**
   - 建议：存储 key = `(clientId, sessionId)`；**判定用 source 内 effective max**（R10:190-192 的跨端同步只有这样才能成立）；`sourceId` 在网关侧为只读回显字段，不参与 key（网关不知道桌面的 `gateway-<id>` 命名，把它当 key 会制造错配）。

⑥ **design 17 必须开一个显式 carve-out（§10:670-678「编排面剥离不得回流」、:799-800 路由清单、§20:1677）**
   - 事实：被剥离的是「会话索引（唯一消费者是仪表盘）」，含内容与执行动作。本面是**只读状态镜像**（无标题/无 cwd/无消息/无执行面），与计划 §5-1:105 的裁决一致。
   - 建议：§10 增加「只读会话状态镜像（watcher）」小节，说明它是 dsh 事实的只读投影、可整体关闭、三条路由、隐私与权限纪律；§10.5 的存活路由列表加三条；§20 追加被否方案（「网关侧跑官方客户端图」与「只轮询 `session.list`」，即本蓝图 §2 的两条 rejected）。

⑦ **新增一条上游提案（按价值插入 `docs/progress/todo/upstream-proposals.md`）**
   - **观察者角色**：`$events` 支持 observer 声明（或 `?observer=1`），使该客户端不进入 waterfall `deliveries`，或允许其以「水位/附带信息」方式订阅 pending 而不承担应答责任。理由即 §5.4——本蓝图是本仓第一个必须依赖该语义的消费者。落地前 §5.4 的委派规则是唯一合规兜底。
   - **pending 的 unary 投影**：`session/list` 增加 `pendingKind`/`pendingCount`（只读、无内容），使 (c) 路线也能满足 R5 的判据，并让 `mode:'poll'` 不丢 pending。

⑧ **W1 出口判据的补充（W1:136）**
   - 增补：(i) 「无浏览器时批准仍处于等待态」；(ii) 「watcher 不在任何情况下把 waterfall 判成 unavailable」的接线锁；(iii) 「`mode` 降级可见」；(iv) 「watcher 重启后 `cursor` 不回落、`Last-Event-ID` 过期走全量」；(v) 「host 停机期间三条路由仍 200 且 `serviceable:false`」。
   - 保留既有出口：「关壳事实仍准；网关重启不丢不乱；host 停机不伪造」。

---

### 附：本蓝图未覆盖（留给 W2/W3/W4/W6）

- 桌面侧 `SessionFactsSource`、账本派生、通知第二入口、事件驱动行刷新、读动作写水位：调用范式可直接照抄 `packages/dsh-chamber-client-ui-sidebar/src/shared/gateway-runtime.ts` 的 `/api/i/gateway-<id>/chamber/...` 路径构造（:502-520）与错误分类（:445-469）。
- 手机端（`/read`、`/read-all` 消费与桌面一致；同源 cookie 会话）。
- SSH 来源的 headless 观察者（本蓝图 §3.1 的 `openRemoteMuxSocket` 是它的可复用件，但隧道/cookie 与「无 gateway」语义属 W6）。
- 实机验收脚本与度量面（计划 §10:247-250）。
