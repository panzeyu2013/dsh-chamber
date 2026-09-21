# 协议兼容与跨版本契约测试 · 蓝图（工作流 6）

> 状态：**已实施**（2026-12，跨版本矩阵 6 条在网关组内；见 `remote-session-state-and-switch.md` §13）。
> 服务于 `docs/progress/todo/remote-session-state-and-switch.md` §6（版本与兼容）
> 与 W1/W2 的出口判据；锚定 `v0.4.0-beta.1`（本次允许破坏、落地即冻结，其后 0.4.x 只做加法）。
> 证据纪律：每条结论标注 **事实**（本次读过源码/跑过命令）或 **推断**（由事实推出、尚未验证）。
> 本文只读仓库，不改任何生产文件；文件:行号均指本工作区当前内容。

## 0. 结论摘要

1. **可探测的协议描述符是唯一版本判据**：产品版本号只作诊断，能力以 `features[]` 判定
   （todo §4:98「`protocol` 独立于产品版本」）。常量与纯判定放
   `packages/control-plane/src/session-state-protocol.ts`——沿用 `gateway-session-protocol.ts` 的
   「跨形态单一源」模式（**事实**：`packages/control-plane/src/gateway-session-protocol.ts:1-24`
   的模块头声明的正是这一角色；桌面经 `packages/desktop/control-plane-module.ts:87-89` 的双路径
   facade 再导出，`:202-221`）。
2. **降级判定必须区分「旧」与「坏」**：只有 `GET /chamber/session-state` 的 **404** 才是版本事实；
   **5xx/超时是 `unavailable`**（启动中/瞬时故障），绝不打上「旧网关」标签。这是对 todo §4:91
   「404 / 无 `protocol` ⇒ 旧网关」的必须收紧（见 §10-3）。
3. **三档矩阵可在仓内自动化，不需要构建两个产品**：A 档（新桌面×旧网关）用 HTTP stub + 路由缺席
   模拟；B 档（旧桌面×新网关）用**冻结的旧客户端调用序列 fixture** 在新网关上重放；C 档为完整集成。
   真实双版本验收（`install-gateway.sh update --version X`，**事实**：`scripts/install-gateway.sh:31-36`）
   保留为发布前人工/可选门，不进 CI。
4. **纯粹部分可离线跑**：本工作区无 `node_modules`。**事实**（命令输出）：bundled node 24.18.1 直跑
   `packages/renderer/test/aggregate/badge-count.test.ts` 全绿（11 tests）；而
   `packages/gateway/test/chamber-surface/chamber-installed.test.ts` 因值导入 `@dsh-chamber/control-plane`
   （`:25`；`src/routes.ts:47-54` 亦为值导入）报 `ERR_MODULE_NOT_FOUND`。⇒ 契约测试分两类：
   **纯模块测试**（相对导入、可离线红绿）与 **路由/桌面测试**（需装树，CI 权威）。
5. **主计划的去重键自相矛盾**（§3.3-3 用「内容水位」、R6 用 `completedAt`），且现有代码的主进程 claim
   键是 `[sourceId, sourceFingerprint, sessionId, kind]`（**事实**：`packages/desktop/notifications.ts:321`）、
   renderer 去重只按 `sessionId`（**事实**：`packages/renderer/src/notification-edges.ts:71-88`）。
   本蓝图给出统一口径（见 §10-4）。

---

## 1. 能力协商与降级时序

### 1.1 路由集合（全部在既有认证门内，不新增鉴权面）

| 路由 | 语义 |
|---|---|
| `GET /chamber/session-state` | 快照 + 协议描述符（**探测即此调用**，不设独立 `/capabilities` 路由） |
| `GET /chamber/session-state/stream` | SSE 增量（`id:` 单调 + `Last-Event-ID` 续传） |
| `POST /chamber/session-state/read` | 单会话读水位 upsert（按 client-install id，幂等取 max） |
| `POST /chamber/session-state/read-all` | 来源级 `through` 水位 upsert（幂等取 max） |

**事实**：`/chamber/*` 在 `packages/gateway/src/dispatch.ts:989-992` 被 chamber surface 认领
（`rejectStaleHttp` 守卫；`/chamber/runtime/*` 在 `:974-978` 先行认领、`/chamber` 在 `:963-967` 重定向）。
未知 `/chamber/*` 一律 404 且已认领（**事实**：`packages/gateway/src/routes.ts:90-94`、
`createChamberSurface` 在 `:1239`、`handle` 在 `:1628`）。⇒ 新路由挂进
`createChamberSurface`（`ChamberSurfaceDeps` 增一个可选的 `sessionState`）即继承同一 auth 门与
同一 404 语义，**dispatch.ts 不需要改动**。

**推断**：auth 门在 dispatch 之前完成（`authenticatedPrincipal` 已在 `:950/:964/:975/:990` 使用），
因此「未认证访问新路由 = 与未认证访问 `/chamber/plugins` 同一条 401 路径」；这一条必须由
§3 的 route-gates 测试钉住，而不是靠读代码下结论。

### 1.2 探测预算与单飞

- `SESSION_STATE_PROBE_TIMEOUT_MS = 5_000`（一次重试，退避 2s，之后 30s/60s/… 上限 5min）。
- **每来源单飞**：同一 `sourceId` 的在途探测共享一个 Promise（对照实现：`gateway-provider.ts`
  `:1862-1901` 的有界轮询与终态识别）。
- **探测绝不 gate 来源就绪**：gateway 来源的 `ready` 只证明 gateway 进程活着（**事实**：
  `docs/design/17-server-side-gateway.md:124-126`），能力是**独立字段**、不得从合并后的 `phase`
  反推（**事实**：同文件 `:151-157` 的 `managedRuntimeDown` 纪律）。
- 判定按「传输化身指纹」缓存（`sourceFingerprint`，同 `notifications.ts:319-321` 的化身纪律）：
  同 id 重建的隧道不得继承旧判定。

### 1.3 降级时序（状态机）

```text
t0 ready 边沿（kind==='gateway'）⇒ 单飞探测 GET /chamber/session-state
   ├─ 404                              ⇒ legacy-gateway（A1：0.3.x 无路由；或 A2：0.4.0 前段）
   ├─ 503 code=session_state_disabled  ⇒ disabled（网关已升级但观察器被关；文案≠升级网关）
   ├─ 200，JSON 无 protocol 字段        ⇒ unversioned（不猜版本，按最保守路径）
   ├─ 200，protocol>已支持主版本        ⇒ forward-skew：按已知 features 工作 + 提示（不失败）
   ├─ 200，protocol 命中               ⇒ ok + features[]（逐能力判定）
   ├─ 超时/网络错                      ⇒ unavailable('timeout'|'network')（重试×1 后进入退避）
   └─ 5xx                              ⇒ unavailable('status')（绝不记成 legacy）
t1 能力级降级（逐能力，不做全有或全无）
   - stream 路由 404/405  ⇒ mode='poll'，features 去掉 stream/last-event-id
   - read/read-all 404    ⇒ 读水位仅本地（本地缓存兜底 + 可见提示），不再发 POST
   - 响应 mode==='poll' 或 features 缺 dsh-events ⇒ 轮询提示（R18）
t2 重探触发：来源 ready 边沿（连接/重连）、/chamber/runtime/status 的 ready↔stopped 迁移、
   流连续 5xx（有界，非每次轮询）、连接页手动刷新
t3 判定过期：指纹变化即时作废；ok→legacy 的降级立即呈现，legacy→ok 的升级立即恢复
     （fail-open，无粘滞）
```

「半升级网关」的四种可判形态（每一形态一条测试，见 §3）：

| 形态 | 触发 | 判定 | 提示方向 |
|---|---|---|---|
| 路由整体缺席 | pre-0.4.0 网关 | `legacy-gateway`(404) | 升级该 server 的网关 |
| 观察器被关 | `--no-session-state` / `DSH_GATEWAY_SESSION_STATE=0` | `disabled`(503) | 打开观察器（不是升级） |
| 路由在但依赖缺 | watcher 启动失败 | `unavailable`(5xx) | 看该 server 网关日志 |
| 与观察器无关的 in-minor 偏斜 | 0.4.x 前段网关缺后加 features | `ok` + 缺 feature 的局部降级 | 各 feature 的局部文案 |

**R17 判据的落点**：`legacy-gateway` / `disabled` / `unversioned` / `unavailable` 与非 `ok` 的
能力级降级都必须产出**恰好一条**来源级可见说明（§6）。

---

## 2. 协议描述符与兼容规则

### 2.1 描述符形状（`GET /chamber/session-state`）

```jsonc
{
  "protocol": 1,                 // 本接口版本，整数主版本；与产品版本无关
  "features": [                  // 点分稳定 id，主版本内只增不减
    "session-state.snapshot",
    "session-state.stream",
    "session-state.last-event-id",
    "session-state.read",
    "session-state.read-all",
    "session-state.host-clock",
    "session-state.dsh-events",
    "session-state.pending-graph"
  ],
  "mode": "sse",                 // 运行态（不是能力）："sse" | "poll"
  "degradation": null,           // { "reason": "dsh-events-absent", "detail"?: string } | null
  "cursor": 41,                  // 每来源单调事件号；观察器重启可重置（客户端按 id 比对）
  "host": { "now": 1760000000000 },   // 仅诊断；任何未读比较都不得使用
  "sessions": [ { "sessionId": "...", "running": false, "pendingKind": "approval",
                  "subagentCount": 0, "updatedAt": 1760000000000,
                  "completedAt": 1760000000000, "lastRunningAt": 1760000000000 } ],
  "read": { "clientId": "...", "marks": { "<sessionId>": 1760000000000 }, "floor": 0 }
}
```

行字段即 todo §4:87 的清单；`updatedAt` 是**唯一内容水位语义**，`completedAt` 只作边沿触发与诊断
（todo §3.2:71、§5-3:107）。

### 2.2 兼容规则（向后 = 新桌面读旧网关；向前 = 旧桌面读新网关）

| # | 规则 | 机械断言 |
|---|---|---|
| R1 | 主版本内**只做加法**：两侧都必须忽略未知字段 | 注入 `x_future` 字段后投影逐字段相等 |
| R2 | 未知 `features` id 一律忽略，绝不因未知 id 整体降级 | 注入未知 feature 后判定仍 `ok` |
| R3 | 客户端「未读必需集」= `snapshot`+`host-clock`；缺任一 ⇒ 该来源未读不可用（显式降级） | 两个子集矩阵 |
| R4 | `protocol` 字段缺席 ⇒ `unversioned`，按最保守路径（不猜版本、不报 `ok`） | 200 无字段 |
| R5 | `protocol > 已支持主版本` ⇒ 用已知 features 继续工作 + `forward-skew` 提示，**不失败、不清空事实** | `protocol:2` 描述符 |
| R6 | 语义删除/改动 ⇒ 升 `protocol` 主版本，并保留一个版本的双读（todo §6:124） | 版本常量断言 + 双读用例 |
| R7 | `mode==='sse'` ⇒ `features` 必含 `stream`+`last-event-id`；`poll` 恒合法 | 矛盾描述符判红 |
| R8 | `cursor` 是每来源不透明整数；只有 SSE 的 `id:` 可与它比较 | 纯函数 |
| R9 | 所有水位都是 **host 时钟域**整数毫秒；客户端墙钟不参与（todo §4:97、§5-13:117） | reducer 入参中不出现 `Date.now` |
| R10 | `features` 是**冻结元组**（单一源导出）；新增必须同时进描述符测试的覆盖网 | 覆盖网测试（每个 advertised feature 至少被一条测试引用） |

**推断**：R5 的「向前兼容」在主计划 §10:246 只写了「向前/向后兼容」而未给方向语义；本表把向前定义为
「新网关 + 旧桌面不调用新路由、旧路由逐字节不变」，向后定义为「新桌面 + 旧网关按 §1.3 降级」。
旧桌面不会被改，因此**向前方向的唯一可测形式是冻结调用序列重放**（§3 B 档）。

---

## 3. 三档矩阵的测试实现（文件级）

### 3.1 矩阵 → 实现映射

| 档 | 含义 | 实现方式 | 服务端/客户端落点 |
|---|---|---|---|
| **A1** 新桌面×旧网关（pre-0.4.0） | 四个路由全 404 | gateway 侧 `sessionState: undefined`（路由缺席）；desktop 侧 HTTP stub 全 404 | `skew-matrix.test.ts` + `session-facts-probe.test.ts` |
| **A2** 新桌面×0.4.x 前段网关 | 路由在、后续 feature 缺 / 观察器关 | 能力子集描述符 + 503 `session_state_disabled` | 同上 |
| **B** 旧桌面×新网关 | 旧调用序列行为不变；新路由零调用 | 冻结 fixture 重放 + 全量路由表子集断言 | `skew-matrix.test.ts` |
| **C** 新桌面×新网关 | 全功能 | 真实 surface + stub watcher deps（listen 0） | `descriptor-contract`/`stream-cursor`/`read-idempotency` |

**事实**：仓内已有两类真实监听/桩服务器先例——`packages/gateway/test/proxy/gateway-proxy.test.ts:106`
（`server.listen(0)`）、`packages/desktop/test/support/gateway-test-servers.ts:15-20`/`:34-56`
（`startHttpProbeServer` / `startSyncHttpServer`，后者 `connection: close` 防 keep-alive 解析错位）。
**推断**：A 档桌面侧必须用**真实 HTTP stub**而不是函数 mock，否则「404 判定」与「不退化成异常」这两件事
都没有证据。

### 3.2 新增测试文件清单（每个文件都要进对应包的 `scripts/test.mjs`）

| # | 文件（新增） | 包 | 关键断言 |
|---|---|---|---|
| 1 | `packages/control-plane/test/protocol/session-state-protocol.test.ts` | control-plane | 描述符解析：R1/R2/R4/R5/R7/R9；feature id 语法（点分、小写、冻结元组）；`sessionStateNoteKey(verdict)` 对每个 verdict 返回非空键、对 `ok` 返回 `null`（全函数，无 default） |
| 2 | `packages/control-plane/test/protocol/session-state-cursor.test.ts` | control-plane | 纯 reducer：`id` 单调、重复/更旧 id 丢弃、心跳不推进、`cursor-expired`/`cursor-ahead` ⇒ 要求全量重取；`mergeReadMark` 取 max 且幂等；`deriveUnread(updatedAt, readMark, readFloor)` 纯 host 域、签名无墙钟 |
| 3 | `packages/gateway/test/session-state/descriptor-contract.test.ts` | gateway | C 档：200 形状、`protocol`/`features`/`mode`/`cursor`/`read`；`cache-control: no-store`；方法纪律（`POST /stream`→405；未知 `/chamber/session-state/*`→404 且已认领）；`mode==='sse' ⇒ features⊇{stream,last-event-id}`；A1 形态：`sessionState` 缺席 ⇒ 四路由 404；disabled 形态 ⇒ 503+`session_state_disabled`（**不是** 404） |
| 4 | `packages/gateway/test/session-state/route-gates.test.ts` | gateway | 未认证访问四路由 = 与既有 `/chamber/plugins` 同一条 401 路径（无新鉴权面）；stale-http 守卫生效；路由只在 `/chamber/` 下被认领（`/session-state` 不认领）；`/chamber/runtime*` 不被抢占 |
| 5 | `packages/gateway/test/session-state/stream-cursor.test.ts` | gateway | §4 的 SSE 矩阵（fresh/exact/retained/expired/ahead/garbage + 心跳无 id + 背压 teardown） |
| 6 | `packages/gateway/test/session-state/read-idempotency.test.ts` | gateway | §4 的 read 矩阵（幂等/单调/隔离/边界/时钟域） |
| 7 | `packages/gateway/test/session-state/watcher-degradation.test.ts` | gateway | host 停机 ⇒ 状态 `unknown`、**零未读**、零 `completedAt`；观察器关闭 ⇒ `mode:'poll'` + `degradation.reason`；握手失败 ⇒ 不留半订阅行；N 个客户端只产生 **1 个**轮询器（单飞） |
| 8 | `packages/gateway/test/session-state/vendor-event-family-contract.test.ts` | gateway | §5(a) 的 vendor lockstep（fail-loud，`DSH_CHAMBER_VENDOR_ABSENT=skip` 才跳过） |
| 9 | `packages/gateway/test/session-state/skew-matrix.test.ts` | gateway | B 档：冻结调用序列 fixture 在新网关上状态码+形状子集不变；A2 档：能力子集描述符下新路由按缺失 feature 局部降级；路由表反向断言（fixture 中每条旧路由必须在活路由表中） |
| 10 | `packages/gateway/test/session-state/support/route-table-0.4.0.fixture.json` | gateway | 冻结的旧客户端调用序列（**不是**测试文件，不被 wiring 门扫描；放在 `support/`） |
| 11 | `packages/desktop/test/gateway/session-facts-probe.test.ts` | desktop | A1/A2 判定矩阵（404/503-disabled/200-无 protocol/超时/5xx）、单飞、有界重试、**legacy 判定下绝不发 `POST /read`**（断言请求记录）、探测不 gate 就绪 |
| 12 | `packages/desktop/test/gateway/session-facts-stream.test.ts` | desktop | SSE 客户端：重连带 `Last-Event-ID`；重复/更旧 id 幂等；`resync` ⇒ 一次快照 GET；abort 关 socket；指纹变化作废判定 |
| 13 | `packages/desktop/test/gateway/session-facts-capability-fact.test.ts` | desktop | verdict → IPC push 事实投影（含 `sourceFingerprint` 与 `noteKey`）；`ok ⇒ noteKey===null`；重探触发表（ready 边沿/runtime ready↔stopped/手动） |
| 14 | `packages/renderer/test/aggregate/session-state-capability-projection.test.ts` | renderer | 结构化事实并入 aggregate（独立字段，**不从 `phase` 反推**）；去重键改造（§10-4）后：同水位重放零事件、新水位一次事件、两入口同水位折叠为一条 |
| 15 | `packages/renderer/test/wiring/session-state-capability-surface.test.ts` | renderer | 接线锁：渲染路径对每个来源调用说明投影；非 `ok` ⇒ 非空、`ok` ⇒ 空（「不静默 / 不噪声」两向都钉） |
| 16 | `packages/dsh-chamber-client-ui-sidebar/test/source-runtime/source-capability-note.test.ts` | sidebar | 穷举 copy-key switch（新 verdict kind 编译错）、zh/en 词典键存在、generic 兜底不产出空串（对照 `source-boot-gap.ts:36-59` 的写法） |
| 17 | `packages/dsh-chamber-client-ui-settings-connections/test/gateway/session-state-capability-row.test.ts` | connections | 连接卡能力行：`unknown-pending`≠`degraded`、per-source 独立（R19 混合升级可读）、字段来自结构化事实（不解析文案） |

**最小落地子集**（若资源受限）：1、2、3、5、6、8、11、16 —— 覆盖描述符/兼容、SSE、read、pin 握手、
A 档判定与可见呈现；B 档（9）与向前兼容可延后到 `v0.4.0-beta.1` 冻结时。

### 3.3 接线纪律（否则门会红）

- `scripts/gates/verify-test-wiring.mjs:356-373` 按「仓库相对路径 / 包相对路径 / 裸文件名」三形态匹配
  **拥有包自己的 `scripts/test.mjs`** 文本（`:30` 扫描 `packages`+`scripts`；`:49` 只认
  `*.test.ts|mjs`）。⇒ 每个新文件必须出现在对应 manifest 的 GROUPS 里；`support/*.ts`/fixture **不要**
  取 `.test.ts` 后缀（support 目录的 `gateway-test-servers.ts` 就是这样注释「never registered」的，
  **事实**：`packages/desktop/test/support/gateway-test-servers.ts:5`）。
- 同文件 `:387-393` 会抓「同名 group key 重复」——向 `packages/gateway/scripts/test.mjs` 加
  `'session-state'` 组时不得与既有键重名（现有键：auth/boundary/proxy/runtime/plugins/chamber-surface/packaging，
  **事实**：`packages/gateway/scripts/test.mjs:16-81`）。
- 每个 manifest 都有「列出的文件不存在即失败」与零测试守卫（**事实**：
  `packages/gateway/scripts/test.mjs:86-91`；`packages/control-plane/scripts/test.mjs:191-195`；
  `packages/renderer/scripts/test.mjs:157-160`）。

### 3.4 离线可跑性分层

| 层 | 文件 | 本工作区（无装树） |
|---|---|---|
| 纯模块 | 1、2、14、15、16、17 | **事实**：相对导入的 `badge-count.test.ts` 在 bundled node 24.18.1 下全绿 ⇒ 推断同类可跑 |
| 需装树 | 3–9、11–13 | **事实**：`chamber-installed.test.ts` 值导入 workspace 包即 `ERR_MODULE_NOT_FOUND` ⇒ CI/装树后跑 |

⇒ 本地 `node packages/control-plane/test/protocol/session-state-protocol.test.ts` 可作为快速红绿；
路由级证据以 CI `run-checks.mjs tests` 为准（`.github/workflows/ci.yml:174`）。

---

## 4. SSE 与 read 的契约测试

### 4.1 SSE 帧契约

```text
event: sync | session-state | resync
id: <cursor>            ← 仅数据帧；注释/心跳绝无 id
data: {...}
: keepalive             ← 注释帧，不推进 cursor
```

断言（文件 5 + 桌面侧 12）：

1. 响应头 `content-type: text/event-stream`、`cache-control: no-store`、`connection: keep-alive`
   （对照实现：`packages/control-plane/src/api.ts:374-379` 的 `/api/host/health-events`）。
2. **心跳不带 `id:`**：否则客户端会用「心跳后的 id」做 `Last-Event-ID`，跳过真实事件（本仓
   SSE 先例有心跳与有界 pending/teardown：`api.ts:392-408`，但**没有** `Last-Event-ID` 语义——
   **事实**：全仓 `Last-Event-ID` 检索 0 命中），这是本契约相对既有 SSE 的**新增不变量**。
3. 无 `Last-Event-ID` 首连 ⇒ 恰好一帧 `sync`（整快照，`cursor === descriptor.cursor`），随后增量。
4. `Last-Event-ID: <当前 cursor>` ⇒ `resync {from, cursor}`，零重放、无快照体。
5. 保留窗内旧 id ⇒ 按序补齐 `n+1..cursor`，无空洞无重复。
6. 过期 id ⇒ `resync {reason:'cursor-expired'}`；**客户端必须整量重取**
   （断言客户端请求日志，而不是只看服务端帧）。
7. `id > cursor`（观察器重启）⇒ `resync {reason:'cursor-ahead'}` + 整量重取；**不得伪造增量**。
8. `Last-Event-ID` 非法 ⇒ 与缺席同义（视为首连），恰一种行为。
9. reducer 幂等：同批帧重放两次状态不变；`id ≤ appliedCursor` 丢弃（纯函数，文件 2）。
10. 断连/溢出 ⇒ 释放订阅而不是无界缓冲（有界流计数、teardown 路径；先例 `api.ts:364-366`）。

### 4.2 read / read-all 契约

```jsonc
POST /chamber/session-state/read       { "clientId": "...", "sessionId": "...", "updatedAt": 176... }
POST /chamber/session-state/read-all   { "clientId": "...", "through": 176... }
```

断言（文件 6 + 纯函数 2）：

1. `clientId` 必填且有界（client-install id，todo §4:96）；`updatedAt`/`through` 必须是非负有限整数、
   ≤ host now + 允许偏斜；**载荷里没有「客户端当前时间」这种字段**（时钟域纪律 R9）。
2. **幂等**：同 body 两次 ⇒ 存量相同、响应回显生效水位（max）。
3. **单调**：更旧的 `updatedAt` 绝不降低存量（`readMark = max(existing, requested)`）。
4. `read-all` 语义 = 来源级 `floor = max(existing, through)` + 对 `updatedAt ≤ through` 的会话写逐会话
   mark；`unread ⟺ updatedAt > max(readMark[session], floor)`。重复/更旧 `through` 为 no-op。
5. **迟到行已读**：`read-all` 之后才被发现的会话，若 `updatedAt ≤ floor`，一开始就是已读
   （R13 幽灵/竞态的构造性闭合）。
6. **隔离**：两个 `clientId` 互不可见；未知 `sessionId` upsert 接受（204/200），但**绝不**创建会话行。
7. **有界**：超限 body ⇒ 413；缺字段 ⇒ 400；未知 JSON 字段忽略（R1）。
8. **重启**：观察器重启不影响读标记（标记属于客户端，不属观察器）；cursor 重置不清标记。
9. **替代方案（写明被否）**：`read-all` 由服务端「取当下最大 updatedAt」而不是客户端给 `through`——
   被否，因为服务端时钟域里「当下」包含客户端从未看过的内容，会把未见内容标已读（假已读）。

---

## 5. dsh pin 握手与降级

### 5.1 三层

**(a) 构建期（CI vendor lockstep）** —— 新文件 8，读 pin 住的 vendor 源，逐条钉：

- `API_REMOTE_FORWARDED_EVENTS` 必须仍含 `{ event: 'api-session/added', mode: 'emit' }`、
  `api-session/removed`、`api-session/status`、`api-session/activity`（**事实**：打包 vendor
  `@deepseek-ai/dsh-api-remotes/lib/types/remote-events.js` 的清单；其头注释明说该数组是
  「`ctx.remote.$on` 的合法键集」，且 submodule 源路径 `…/src/remote-events.ts` 由既有测试以
  同形断言读取，**事实**：`packages/dsh-chamber-client-ui-sidebar/test/session-state/vendor-session-fact-contract.test.ts:56-63`）。
- `approval/request`、`user-questions/request` 必须仍以 `waterfall` 存在——但**pending 的运行时来源
  是 headless 客户端图的 `pendingInteractions`**（todo R5:167），这两条只是「该事件族仍随 pin 发行」的
  构建期证据；运行时若图不可用则走 `pending-unavailable` 降级。
- **分工（避免第二份弱拷贝）**：语义锁（`$on` 订阅体、`handleSessionStatus` 三写、`mergeOrderedBaseline`）
  继续由 sidebar 既有文件拥有（**事实**：同文件 `:65-114`）；新文件只锁**事件族集合与 mode**。
- **fail-loud**：缺树默认红，只有显式 `DSH_CHAMBER_VENDOR_ABSENT=skip` 才跳过；CI 不设该变量
  （**事实**：同文件 `:20-23`、`:37-54`；STATUS 同口径 `docs/progress/STATUS.md:118-121`）。
  ⇒ 本工作区 vendor 树未物化（**事实**：`vendor/` 下只有空的 `harness-checkout`），该文件在本地默认红，
  这是设计而不是缺陷。

**(b) 运行期握手（watcher 启动）** —— 文件 7：

- 订阅四个 `api-session/*` 族后，在 `WATCHER_HANDSHAKE_WINDOW_MS = 5_000` 内要求**可观察活性证据**
  （观察到至少一条会话事件，或订阅面就绪且首次 `session.list` 权威读成功）。
- 失败 ⇒ `mode:'poll'`、features 去掉 `session-state.dsh-events`/`pending-graph`、
  `degradation.reason='dsh-events-absent'`；**不得留下半订阅的观察者写行**（文件 7 断言）。
- dsh 重启 / watcher 重启后重跑握手；成功即升级为 `sse`，桌面在 ready 边沿重探（判定不粘滞）。

**(c) 版本只作诊断**：响应可带观测到的 dsh 版本（`0.1.5-rc.2`，**事实**：打包
`@deepseek-ai/dsh/package.json` 版本；`harness.commit:10` 为 pin 提交），但契约**从不比较版本号**，
只比较 feature id（todo §4:98）。

### 5.2 稳定降级码（结构化、可断言）

`dsh-events-absent` · `watcher-disabled` · `pending-unavailable` · `cursor-expired` ·
`cursor-ahead` · `read-unsupported` · `legacy-gateway` · `unversioned` · `unavailable` ·
`forward-skew`。

---

## 6. 降级的用户可见呈现（绝不静默）

### 6.1 一条事实、三处呈现

| 面 | 内容 | 依据 |
|---|---|---|
| 侧栏来源头一行 | 短说明 + 恢复动作；沿用托管停机那条**唯一 live region**（`role="status" aria-live="polite"`，容器常驻只换文本） | **事实**：`docs/design/17-server-side-gateway.md:133-144` |
| 连接页 gateway 卡 | 完整能力行：verdict / protocol / features / mode / 观测 dsh 版本（混合升级按 server 可读） | **事实**：连接页形态 `docs/design/05-connection-manager.md:632-668` |
| 未读/待办 | 降级期走现状路径（壳通道 + 本地标记），说明里写明，蓝点不得静默消失 | todo §3.3-6:82、§0-7:17 |

### 6.2 机制（可测）

1. **结构化字段**：aggregate 增独立字段（建议 `sessionState?: { verdict: ...; noteKey: ...; fingerprint }`），
   **不得从 `phase` 反推**（同 `managedRuntimeDown` 纪律，design 17:151-157）。
2. **穷举 copy-key switch**：新纯模块 `packages/dsh-chamber-client-ui-sidebar/src/client/source-capability.ts`，
   写法对照 `source-boot-gap.ts:36-59`（无 `default`，新增 kind 编译错）；renderer 侧只做
   「verdict → aggregate 字段」的投影。
3. **不静默 / 不噪声两向锁**（文件 15）：每个来源渲染都调用说明投影；非 `ok` ⇒ 非空；`ok` ⇒ 空。
4. **冷启动不误报**：`unavailable` 需连续 2 次判定或超过 1 次退避窗才呈现（对照 `SERVING_TERMINAL_GRACE_MS`，
   **事实**：`packages/renderer/src/source-readiness.ts:74-76`），否则会闪。
5. **化身边界**：说明只在 `fingerprint` 与权威 roster 一致时渲染（同设置面纪律，design 05:646）。
6. **文案**（新增词典键，zh/en 同步）：
   - legacy：`该网关版本较旧，未升级；未读/待办精度受限——升级该 server 的网关后自动恢复`
   - disabled：`网关状态观察器已关闭；未读/待办不可用`
   - unversioned / forward-skew / poll / read-unsupported：各自独立短句（不合并成一句「状态受限」，
     否则恢复动作无从选择）。
7. **i18n 门边界**：`verify:i18n` 只覆盖 5 对顶层文档（**事实**：`scripts/gates/verify-i18n.mjs:14-24`），
   词典键的 zh/en 一致性由各包 typed 字典 + 文件 16/17 钉住。

---

## 7. CI 接线与脚本

### 7.1 不需要新 CI 作业

新文件进各包 manifest 后即自动进 CI：`.github/workflows/ci.yml:174` 跑
`node scripts/gates/run-checks.mjs tests` → `scripts/gates/run-checks.mjs:34-54` 的 `PACKAGE_TESTS`
（`test:control-plane`/`test:gateway`/`test:desktop`/`test:renderer-shell`/`test:sidebar`/`test:connections`）。
`check:full` 额外并入 `STATIC_CHECKS`（含 `verify:test-wiring`，run-checks.mjs:104-119）。

### 7.2 需要编辑的 manifest（精确落点）

| manifest | 动作 |
|---|---|
| `packages/gateway/scripts/test.mjs` | 新增 `'session-state'` 组（`:16-81` 的 GROUPS 内，放在 `chamber-surface` 后） |
| `packages/desktop/scripts/test.mjs` | 扩既有 `gateway` 组（`:53-63`） |
| `packages/control-plane/scripts/test.mjs` | 扩 `protocol` 组（`:47-53`）；把文件 1 加进 `WIN32_FILES`（`:112-124`）作为平台无关契约 |
| `packages/renderer/scripts/test.mjs` | 扩 `aggregate`（`:56-61`）与 `wiring`（`:68-74`） |
| `packages/dsh-chamber-client-ui-sidebar/scripts/test.mjs` | 扩 `source-runtime`（`:72-81`） |
| `packages/dsh-chamber-client-ui-settings-connections/scripts/test.mjs` | 扩 `gateway` 组（`:41-44`） |

**事实**：Windows 腿只跑各包 `test:win32` 清单（ci.yml:354-368），不跑 `run-checks tests`
⇒ 若某契约必须在 Windows 上绿，必须显式进 `WIN32_FILES`（`--win32` 集合必须是 GROUPS 子集，
否则 manifest 直接失败：`packages/control-plane/scripts/test.mjs:161-170`）。

### 7.3 可选的真实双版本验收（不进 CI）

`scripts/install-gateway.sh update --version <前一个正式版>`（**事实**：`scripts/install-gateway.sh:31-36`
的 `--version V` 精确 pin 与 `VERSION=local --tgz FILE` 离线形态）在带 systemd/受管 dsh 的机器上做
A 档真机验收，按 server 逐个签核（todo §6:127）。**不进 CI 的理由**：安装器管理 system user/systemd 与
真实托管 dsh（同文件 `:18`、`:94`、`:233-251` 的锁与私有布局），需要网络/root，成本与稳定性都不适合
每个 push。**推断**：若要设一个 release 专属门，挂 `release:preflight`（root package.json:105）比新开
workflow 更符合「发布路径同证据」的口径。

### 7.4 不需要新脚本

本工作流不新增 `scripts/` 下的测试文件，因此 `scripts/gates/run-script-tests.mjs:36-74` 的 GROUPS
与 `test:scripts` 不动。

---

## 8. 常量与文档落点

### 8.1 单一源

**新文件**：`packages/control-plane/src/session-state-protocol.ts`，导出：

- `SESSION_STATE_PROTOCOL_VERSION = 1`、`SESSION_STATE_ROUTES`（四条路径）、
  `SESSION_STATE_FEATURES`（冻结元组 + 派生 union）、`SESSION_STATE_READ_BODY_MAX_BYTES`、
  `SESSION_STATE_PROBE_TIMEOUT_MS`、`WATCHER_HANDSHAKE_WINDOW_MS`；
- 类型：`SessionStateRow` / `SessionStateDescriptor` / `SessionStateVerdict` / `SessionStateFeature`；
- 纯函数：`parseSessionStateDescriptor`、`sessionStateFeatureSupport`、`sessionStateNoteKey`、
  `applySessionStateFrame`、`mergeReadMark`、`deriveUnread`。

**为什么必须放这里**：gateway 与 desktop 两侧都要用，且桌面**打包态无法从 node_modules 导入 workspace 包**
（**事实**：`packages/desktop/control-plane-module.ts:5-11` 明文说明），必须经 facade 再导出
（`:87-89`，再导出清单形态见 `:202-221`）。这是硬约束，不是风格偏好。
**事实**：control-plane 的导出面已有同款先例（`packages/control-plane/src/index.ts:1465-1468` 的
`export * from './proxy-forward.ts'` 等）。

### 8.2 生产落点

| 层 | 文件 | 内容 |
|---|---|---|
| gateway | `packages/gateway/src/session-state.ts`（新） | watcher 状态机/持久化/缺口重建/三条路由 handler（todo R1 落点:148） |
| gateway | `packages/gateway/src/routes.ts` | `ChamberSurfaceDeps` 增可选 `sessionState`；`createChamberSurface`（:1239）内认领四路由；无需动 dispatch |
| gateway | `packages/gateway/src/config.ts` + `cli.ts` | `--no-session-state` / `DSH_GATEWAY_SESSION_STATE=0` kill switch（对照 warmup 的既有形态，**事实**：`docs/design/17-server-side-gateway.md:802-853`）⇒ 503 `session_state_disabled` |
| desktop | `packages/desktop/session-facts.ts`（新） | 探测（单飞/退避/指纹缓存）+ SSE 消费 + verdict 事实 |
| desktop | `packages/desktop/ipc-events.ts` + `bridge-manifest.json` | 新增 push 通道；manifest 的 `counts.total`（现 69，**事实**）与 `bridge-manifest.test.ts`/`ipc-surface-mirror.test.ts` 锁步必须同步（**事实**：ipc-events.ts:6-8 的锁步声明） |
| renderer | `packages/renderer/src/*`（App 投影） | 结构化事实进 aggregate + 通知第二入口 |
| sidebar | `src/client/source-capability.ts` + `locales.ts` | 说明文案（穷举 switch） |
| connections | `src/client/ConnectionsSection.tsx` | gateway 卡能力行 |

**被否方案**：把能力事实搭既有 `desktop_ssh_status_changed` 便车——被否：语义与版本化都寄生在既有通道上，
且 manifest 锁步（counts、mirror 测试）本来就把「加通道」当作一次性、可审的动作。

### 8.3 必须更新的文档（由实现者，不在本工作流）

| 文档 | 改什么 |
|---|---|
| `docs/design/17-server-side-gateway.md` §10 | 新增小节（建议 §10.7「会话状态观察器与能力协商」）：四条路由、描述符、降级时序、kill switch；并修 §10.5 的存活面清单（`:797-800` 现在只列 channels/plugins/runtime/dashboard）。按 AGENTS.md:109-113 补 **Rejected alternatives**（独立 `/capabilities` 探测路由；比较产品版本号；给 `/chamber/session-state` 免鉴权） |
| `docs/design/05-connection-manager.md` | §4（来源呈现）/§5（连接页能力行） |
| `docs/design/06-sidebar-enhancements.md` | §4.3（状态槽/说明行语义）、§4.4（代码落点） |
| `docs/design/19-notifications.md` | §3.5/§3.7：watcher 第二入口的诚实边界 + 去重键口径修正（§10-4） |
| `docs/progress/STATUS.md` | 登记/更新 R17（版本偏斜可见提示）、R18（pin 握手契约测试）为开放项；落地后删除。**并更新 `:392` 的「chamber 侧把代际过旧变成可见诚实提示（未排期）」**——本工作流的 legacy/unversioned 判定正是该口的闭合物，落地后该句应改写为「已闭合」并移出 |
| `CHANGELOG.md` | **不写**。按 AGENTS.md:59-60，CHANGELOG（含 en-US 镜像与 `verify:i18n` 记录）只在发布时写；实现期不得加 `[Unreleased]` |

---

## 9. 风险

| # | 风险 | 对策 / 判据 |
|---|---|---|
| 1 | 探测调用在重连风暴里放大（N 来源 × 重试） | 每来源单飞 + 抖动退避 + 指纹缓存；文件 11 断言「一次 ready 边沿 = 至多 2 次探测请求」 |
| 2 | **5xx/超时被误判成「旧网关」**（启动中的 gateway 会被打上升级标签） | §1.3 分类表 + 文件 11 的 503/超时用例；这是本蓝图最重要的一条 |
| 3 | `mode:'poll'` 退化为对宿主的轮询风暴 | 观察器**共享**一个轮询器（不是每客户端一个）：文件 7 断言 N 客户端 1 轮询器；退避与前台门另记 |
| 4 | 读水位被有 bug 的客户端写成「未来已读」 | 只影响该 `clientId`（隔离断言）；结构上有界；「标记全部已读」仍是显式动作（todo 裁决 10:114） |
| 5 | `features` 元组膨胀、无人维护 | 冻结元组 + 覆盖网（文件 1 断言每个 advertised feature 至少被一条测试引用） |
| 6 | vendor lockstep 在无 submodule 的本地 worktree 默认红，被误当回归 | 注释与 STATUS:118-121 同口径；PR 说明里必须写「本机红=设计」 |
| 7 | B 档 fixture 腐烂（旧路由被悄悄删掉而无人发现） | 文件 9 反向断言：fixture 里每条旧路由必须在活路由表中（删旧路由即红） |
| 8 | **SSE 经两级代理时 `Last-Event-ID` 是否透传未验证** | **推断**：实例代理转发调用方普通头（**事实**：`packages/control-plane/src/instance-proxy.ts:27` 注册头随上游、`:610`/`:656` 只约束**注入**的凭据头），但全仓无 `Last-Event-ID` 断言（**事实**：检索 0 命中）。必须在 `packages/control-plane/test/proxy/` 补一条「SSE 请求头与 `Last-Event-ID` 原样上行」的用例，或明确桌面走 provider 直连网关 origin（design 17 §9.1）从而绕开该腿 |
| 9 | 判定/说明在降级↔恢复间抖动 | 2 次判定宽限 + 指纹绑定 + fail-open 恢复（§6.2-4/5） |
| 10 | 「只做加法」被破坏而 CI 无感 | R10 覆盖网 + 文件 9 的路由表反向断言；语义删除必须升主版本（R6） |

---

## 10. 对主计划 §6 与 W1/W2 的修订建议

1. **§6 兼容矩阵（todo:125）**：「旧桌面×新网关（新路由不被调用）」在仓内无法用「旧桌面」证明
   （不构建旧产品）。改写为「**冻结的旧调用序列 fixture 在新网关上状态码与响应形状子集不变**」，
   并**补 A2 子格**（0.4.x 前段网关缺后加 feature）——否则「0.4.x 只做加法」（todo:124）没有测试锚点。
2. **§6「能力探测」（todo:126）**：`watcher 握手失败 ⇒ 降级 polling 并在响应标注` 需要「标注」的确切形状。
   建议补 `degradation: { reason, detail? }` 与稳定码表（§5.2），否则 R18 的「在响应报 mode」（todo:223）
   只有半个事实。
3. **§4（todo:91）**：「404 / 无 `protocol` ⇒ 旧网关」必须收紧为「**404 on `GET /chamber/session-state`
   ⇒ 旧网关；5xx/超时 ⇒ `unavailable`，不是旧网关**」。启动中的 gateway 与瞬时故障会被现有措辞
   误标为「未升级」，直接违反 R17「不静默/不撒谎」。
4. **§3.3-3 与 R6 的去重键自相矛盾**（todo:79 用「内容水位」、todo:172 用 `completedAt`）。
   统一口径：**renderer 层去重键 = `(sourceFingerprint, sessionId, 内容水位 updatedAt)`**；
   主进程 `NotificationClaimWindow` 的键保持 `[sourceId, sourceFingerprint, sessionId, kind]`
   （**事实**：`packages/desktop/notifications.ts:321`）作为 5s TTL 最后兜底，**不要**把水位塞进主进程键
   ——壳通道的边沿没有 `updatedAt`，塞进去会让两个入口**无法折叠**成一条通知。
   W2 需裁决：壳通道的完成边沿要么从 aggregate 行取同一水位，要么由 watcher 成为完成边沿的唯一入口
   （壳通道仅保留 pending/降级）。**这条需要一条锁测试**（文件 14）。
5. **§7 W1 出口判据（todo:134）**：把「契约测试」具体化为「描述符 + features 兼容规则 + 三档矩阵 +
   `Last-Event-ID` 续传 + `/read` 幂等全绿（文件 1–9）」；**W2 出口判据（todo:135）**补「降级 verdict
   进入 aggregate 且侧栏可见（文件 13–16）」。当前 R17/R18/R19 没有里程碑归属，落地会悬空。
6. **§10 测试（todo:246）**：「向前/向后兼容」补方向语义：**向后** = 新桌面按 §1.3 降级；
   **向前** = 新网关保持旧路由逐字节不变、旧客户端零调用新路由（R1/R5/R6）。
7. **W0 出口（todo:133）**：watcher 的 pending 来源（headless 客户端图 vs 直接订阅 request 族）
   直接决定 `session-state.pending-graph` 这个 feature 是否存在；W0 ③ 若判「request 族不可直接订阅」，
   则 `pending-graph` 缺席必须是**可见降级**（`pending-unavailable`），不能只落成 `mode:'poll'`。
   建议把这一条写进 W0 出口判据。
8. **常量落点现在就定名**：`packages/control-plane/src/session-state-protocol.ts`，并要求
   「gateway 路由」与「桌面 facade 再导出」在**同一个 PR** 内落地——桌面打包态无法导入 workspace 包
   （**事实**：`packages/desktop/control-plane-module.ts:5-11`），只做一半会让打包产物在运行期炸，
   而且这是 CI 单测覆盖不到的面（打包门在 macOS 腿，ci.yml:485-512）。
9. **协议冻结的登记位置**：`protocol:1` 的冻结与 feature 元组属于「设计契约」，应写进 design 17 §10
   （不是 CHANGELOG）；发布时的对外表述由 release 时的 CHANGELOG 承担（AGENTS.md:59-60）。

---

## 附：本工作流未验证/未能验证的点

- 未运行任何路由级测试（本工作区无 `node_modules`；**事实**：值导入 workspace 包即
  `ERR_MODULE_NOT_FOUND`）。§3 的「关键断言」列是**设计**，不是已执行证据。
- 未验证 `Last-Event-ID` 经实例代理 / gateway 反代的真实透传（§9-8，**推断**）。
- 未验证 SSE 在 Electron 主进程（而非 renderer `EventSource`）下的实现形态；建议直接用
  `node:http` 消费流而不是 `EventSource`（主进程无 DOM），这是 W2 的实现选择，本蓝图不预设库。
- vendor 树未物化，文件 8 的断言列表来自**打包 vendor 的 lib/**（同名清单）；CI 读的是 submodule
  源码（src/），两者同源但未逐字节对比。
