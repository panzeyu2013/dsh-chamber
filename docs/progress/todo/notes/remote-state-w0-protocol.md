# W0 决策门实验协议（remote-session-state-and-switch §3.1 / §7-W0）

> 状态：协议 + **已执行的前置实测**（2026-12；运行中的 dsh-chamber 桌面 + 其托管的 local 实例；
> 结论见 §1.2、记录见 §5）。锚定与实验对象为当前 pinned dsh（packaged vendor）。
> 关联：主计划 §2-3、§3.1、§4、§5-12、§7-W0、R5/R12/R1/R3；design 05 §2.2.1/§4.2、design 17 §10。
> 标注约定：**【事实】**＝本次由我直接读源或跑命令验证；**【推断】**＝由事实推导、尚未直接观测。

## 1. 目的与背景

§3.1 的三问决定整改架构：Q1 决定「完成」事实来自 host 摘要水位还是观察者边沿（Track A/B）；
Q2 决定无壳时 pending 是否可观测（R5 的观察者形态）；Q3 决定手动停止能否与正常完成区分（R12），
并顺带决定 §4 行模型是否要携带「结束原因」。三问全部可在 30 分钟内用**已运行的应用**跑完，
不依赖 pnpm / node_modules（本 worktree 没有 node_modules，本协议全部只用了打包 node 的内建模块）。

### 1.1 现有可复用资产（先查后造；已核对）

| 资产 | 位置 | 用途 | 现成度 |
|---|---|---|---|
| unary 信封常量 / 裸 node:http carrier | `packages/control-plane/src/rpc-envelope.ts:223`（`postClientRequest`）、`:125/:142/:152/:158` | 直连 host 的 unary POST；只依赖 `node:http` | 可跑（需薄封装） |
| 带 cookie 的 fetch unary 客户端 | `packages/control-plane/src/dsh-client.ts:329`（`call`，`authCookieFor`） | 直连被 browser-auth 门保护的 host | 可跑（TS 导入需 type-strip） |
| legacy list 载荷 | `rpc-envelope.ts:158` → `{args:{_request:{}}}` | `session/list` 的确切 payload | 已实测 |
| 无鉴权实例代理 | `packages/control-plane/src/instance-proxy.ts:29`（v1 `/api/i/*` 无鉴权边界）、`:242` 前缀剥离 | `http://127.0.0.1:<cp>/api/i/local/api/<method>` 直通 host 且由控制面注入 cookie | 已实测 |
| WS mux 代理 | `packages/control-plane/src/proxy-forward.ts:212`（`WS_STREAM_PATHS={'/api/remote.mux'}`） | `ws://…/api/i/local/api/remote.mux` | 已实测 |
| gateway 侧 mux 路由 | `packages/gateway/src/dispatch.ts:1086-1087` | 网关/手机边界同样转发升级 | 静态 |
| mux 逻辑流协议常量 | `packages/dsh-api-gateway/src/stream-protocol.ts:6-18`（`/api/remote.mux`、`$events`、`$events/result`、ready 帧） | 裸 WS 脚本的帧契约 | 已实测 |
| 用 in-repo client 打开 `$events` 的测试 | `packages/dsh-api-gateway/test/behavior/mux-self-heal.test.ts:147` | 行为参照；依赖 node_modules，真机脚本改用裸 WS | 只读参照 |
| 真机 E2E harness | `scripts/dev/e2e-gateway-harness.ts`（`node scripts/dev/e2e-gateway-harness.ts proxy`） | 远端/网关线路（需主机与凭据） | 需外部前置 |
| CDP 升级探测 | `scripts/gui-acceptance/probe.mjs:238-241` | 验证 `/api/remote.mux` 升级可通 | 需桌面+CDP |
| unary 对 `/api/session/list` 的测试先例 | `packages/control-plane/test/protocol/rpc-envelope.test.ts:146` | 证明该 payload 形状 | 只读参照 |

**盘点结论**：unary 侧无需新造（`/api/i/local` 已经是现成通路）；`$events`/`session/follow` 侧没有可直接
运行的脚本，但帧协议已在 `stream-protocol.ts` 冻结，裸 WS 30 行即可（见 §3）。

### 1.2 结论先行（本次已实测）

- **Q1 = Track B（边沿轨）**。**【事实】**packaged 源中 `SessionSummary.updatedAt` 的唯一写入器是
  `sessionListMetadata.lastPromptAt`，而它只在 `user/message` 且 `source.kind === 'user'` 时推进
  （`@deepseek-ai/dsh-api-session-controller/lib/index.js:1749-1754`、`:1969-1971`）；
  **【事实】**实机双采样：会话 `164ae48f-…` 在 126s 内 agent 步数 54→65、
  `subagentTiming.active.through` 追到采样时刻，而 `updatedAt` 恒为 `1789977568048`
  （= `lastPromptAt`，提示词写入时刻）。即「摘要水位不随 agent 产出推进」。
- **Q2 = 无壳可观测（`$events` waterfall）**。**【事实】**`approval/request` 与 `user-questions/request`
  都在官方转发白名单里（`dsh-api-remotes/lib/types/remote-events.js:14,31`），且 host 会把每个 pending
  waterfall **投递给所有已连接客户端、并对新连接的客户端重放**（`dsh-api-gateway/lib/index.js:598,673,678-682`）；
  **【事实】**裸 WS 无壳客户端已实测收到 ready 帧。侧边栏读的 `uiSession.pendingInteractions` 只是
  **浏览器内**由 `ctx.remote.$on` 填充的注册表（`dsh-client-ui-session/lib/client.js:83-91,319-325`）——
  它不可无壳重建，但也不需要：同一条 wire 事实可直接订阅。
- **Q3 = 存在区分事实**。**【事实】**`turn/end` 持久化事件携带 `reason`，其联合含
  `completed | aborted{reason: TurnEndCancelCause} | blocked | error | max-tokens | interrupted`
  （`typert.host.js:2056-2057`、`:2571-2572`）；**【事实】**`session/cancel` → `agent.cancel({kind:'user'})`
  （`lib/index.js:872-877`）→ `phase.abort.abort(cause)`（`dsh-agent-loop/lib/index.js:798-804`）→
  `turnEnds={kind:'aborted',reason:signal.reason}` → `session.append('turn/end',…)`（`:976-1000`）；
  **【事实】**实机在 `session/follow` 快照尾看到 `{"turn":1,"reason":{"kind":"completed"}}`。
  即 `turn/end.reason.kind` 就是主计划 §2-6 说「只有 running 位」之外的缺失事实。
- **§4 行模型与 R12 的修正在 §6**：watcher 应该产出 `turnEnd:{kind,cause}` 而不是裸 `completedAt`。

## 2. 三个问题：假设 / 观测信号 / 最小实验 / 判读标准 / 失败与歧义处理

### 2.1 Q1：摘要 `updatedAt` 是否随 agent 产出推进

**假设**
- H1a（水位轨）：`updatedAt` 是「内容水位」，agent 每次产出（assistant/message、tool/result…）都会推进。
- H1b（边沿轨）：`updatedAt` 只是「最近一次 user-authored durable message 时间」+ `createdAt` 的 max。

**观测信号（字段路径，均为 unary `session/list` 的响应）**
- `result.value.items[].sessionId` / `.updatedAt` / `.running` / `.blank` / `.cwd`
- `result.value.items[].projections.values.sessionListMetadata.lastPromptAt`（`updatedAt` 的直接来源）
- `result.value.items[].projections.values.sessionStats.steps`（agent 产出的独立计数证据）
- 辅助：mux `$events` 上的 `api-session/activity` emit（**预期：只在 user 消息时出现**）
- 静态参照：`updatedAt = Math.max(header.createdAt, lastPromptAt)`（`lib/index.js:1969-1971`）

**最小实验（10 分钟；单会话，无需第二个客户端）**
1. 找到运行中的实例基址：本地托管实例走控制面代理
   `http://127.0.0.1:<控制面端口>/api/i/local`（本机实测 §5 行 1；直连 host 源
   `http://127.0.0.1:17510/api/session/list` **401**，因为 web profile 有 browser-auth 门）。
2. `session/list` 采样一次：记下目标会话的 `updatedAt`、`running`、`lastPromptAt`、`steps`（=S0）。
3. **不再发送任何用户消息**，让该会话持续产出 ≥120s（长任务；或对现成运行中的会话旁观）。
4. 再采样一次（=S1），同时（可选）在 `$events` 上旁观 `api-session/activity`。
5. 用 §3 `sample` 子命令自动算差值；用 §5 表格记录。

**判读标准**
- `S1.updatedAt === S0.updatedAt` 且 `S1.steps > S0.steps` 且 `S1.running === true`
  ⇒ **H1b 成立 ⇒ Track B**（且 `updatedAt === lastPromptAt` 在两次采样都成立时证据最强）。
- `S1.updatedAt > S0.updatedAt` 且差值≈采样间隔且 `activity` emit 在产出时刻出现 ⇒ **H1a ⇒ Track A**。
- 若 `S1.updatedAt` 推进但恰好期间有用户消息：该轮无效，重跑（用 `lastPromptAt` 变化自证污染）。

**失败与歧义处理**
- 401/403：说明直连了 host 源而非控制面代理；改用 `/api/i/local`（或先用 launch token 换 cookie）。
- `updatedAt` 不动但 `running=false`（会话已结束）：换一个仍在运行的会话重跑；边界值不算证据。
- 两次采样间没有任何产出（steps 不变）：无效样本。
- 静态证据表明当前 pin 必为 H1b；**该实验的长期价值是 pin 升级后的回归门**：`updatedAt` 语义一旦改变，
  W7 提案 ① 即已满足，Track A 可重新评估（无需改协议）。

### 2.2 Q2：pending 请求事件（approval/request、user-questions/request）能否被无壳客户端观测

**假设**
- H2a：两类请求是 host 侧的 waterfall 事件，经官方转发白名单进 `$events`，任何持有 mux 的客户端可见（含重放）。
- H2b：它们只存在于浏览器插件图（`uiSession.pendingInteractions`），无壳不可得。

**观测信号**
- mux 帧：`{type:'waterfall', event:'approval/request'|'user-questions/request', eventId, agentId, request}`
  （`stream-protocol.ts:50-57`；`dsh-api-gateway/lib/index.js:654-673` 构造）。
- 首帧：`{type:'ready', clientId, host:{home}}`（`dsh-api-gateway/lib/index.js:600-604`）。
- 解除：`{type:'cancel', eventId}`（`:716-722`）；新客户端连接时 `pendingRemoteEvents` 全量重放（`:598`）。
- 静态白名单：【事实】`dsh-api-remotes/lib/types/remote-events.js:14,31`、
  `dsh-api-remotes/lib/index.js:108-126`（waterfall 桥接）。
- 反证：对不存在的端点开流会得到 `error` 帧（`gateway/invocation-unavailable`）——证明 mux 活着。

**最小实验（10 分钟）**
1. 裸 WS 连 `ws://127.0.0.1:<控制面端口>/api/i/local/api/remote.mux`，发
   `{type:'open',streamId:'ev',endpoint:'$events',payload:{args:{}}}`（§3 `watch`）。
2. 断言收到 `ready`（**已实测**：本机 25s 窗口只收到 ready；期间无 pending、无 user 消息，故无
   waterfall/activity 帧——这是预期的负结果，不是失败）。
3. 触发/等待一次 pending：任一会话执行需要审批的工具，或用 `ask_user_question`（提问型）。
   更省事的做法：在浏览器侧存在待审批卡片时 attach，验证 §3 的**重放**（无需自己触发）。
4. 断言（a）收到 waterfall 帧且 `request` 是 JSON 对象；（b）浏览器答复后同 `eventId` 收到 `cancel`；
   （c）再次 attach 时该 `eventId` 不再被重放。
5. 顺带做负对照：`session/control` 的 baseline **只含** `queues,jobs,projections`
   （`typert.host.js:1692-1693`；实机 baseline keys 同）——pending 不在控制流里，且该流是 301 帧/25s
   的投影洪流，**不要**用它推导 pending。

**判读标准**
- 收到任一 waterfall 帧 ⇒ **H2a**：gateway 侧 headless 观察者可行，R5 不需要浏览器插件图。
- 只有 `ready`、任何触发下都收不到 waterfall ⇒ 转向回退方案（下条）。

**失败与歧义处理**
- **观察者纪律**：观察者**不得**发 `$events/result`；被动观测不结算，pending 对浏览器壳保持可见。
  只有当观察者是唯一客户端且主动答 `{kind:'next'}` 时，host 才会把 waterfall 结算为 `next`
  （`dsh-api-gateway/lib/index.js:692`）——那会**吃掉**这次审批，绝不能在被动观察里做。
- **本轮不确认的点**（留待 §5 表格落地）：pin 升级后白名单是否仍含这两个事件；
  如果被移除 → 回退 (i) 复用官方 client 半的 headless 插件图（重，R5 已写明）；
  (ii) 用 `session/follow` 读**持久化**审批审计对：`approval/asked` 无对应 `approval/decided`
  （两者由 `dsh-user-approval/lib/index.js:135,142` 成对写入，且必须在 turn 内）；
  **提问型在当前 pin 没有持久事件**（`SessionEventMap` 无 question 事件），(ii) 只覆盖 approval；
  (iii) 浏览器壳中继在「无壳」前提下属自相矛盾，不可作回退。

### 2.3 Q3：是否存在区分「用户主动停止」与「正常完成」的事实

**假设**
- H3a：只有 `api-session/status(sessionId, running)` 布尔位 ⇒ 不可区分（主计划 §2-6 的现状判断）。
- H3b：持久化的 `turn/end.reason` 足以区分（且用户停带有 cause=`user`）。

**候选表面（逐个核对）**
| 表面 | 位置 | 是否可区分 |
|---|---|---|
| `api-session/status` 转发事件 | `dsh-api-session-controller/lib/index.js:2755-2757` | 否，只有布尔 running |
| `SessionSummary`（list 行） | `typert.host.js:1877`（updatedAt/running/blank/parent/origin/cwd/projections） | 否，无结束原因 |
| `session/control` 流 | `SessionControlBaseline`（queues/jobs/projections） | 否 |
| **`turn/end` 会话事件** | `SessionEventMap`（`typert.host.js:1717`）；`TurnEndReasonMap`（`:2056-2057,2571-2572`） | **是**：`completed/aborted/blocked/error/max-tokens/interrupted` |
| aborted 的 cause | `TurnEndCancelCause = AgentCancelCause | {kind:'legacy'}`（`:2048-2049`）；`AgentCancelCause={user,parent,hook,disposed}`（`:1292-1293`） | **是**：用户停止=`{kind:'user'}` |
| `assistant/message.interrupted?: true` | `SessionEventMap`（`:1717`） | 部分：仅「流被截断」标记 |
| `agent/inbox/spliced.outcome?:'canceled'` | 同上 | 部分：队列被取消，非 turn 结论 |
| 最后一条消息 role/id | 会话日志 | 否：无 stop 标记语义（不推荐） |

**最小实验（5 分钟）**
1. `session/follow`（§3 `follow`）打开任一**已结束**的普通会话，读快照尾：预期 `turn/end` +
   `{"kind":"completed"}`（**已实测**，见 §5 行 4）。
2. 在任一受控会话上发起一次长 turn，然后从 UI/其他客户端发 `session/cancel`
   （或点「停止」按钮），同一条 `session/follow` 流里等 `turn/end`：预期
   `{"turn":n,"reason":{"kind":"aborted","reason":{"kind":"user"}}}`。
   **（本轮未能在他人会话上捕获 abort 样本；14 个已结束会话全是 completed。）**
3. 从运行中的会话集合上做**成本可接受的**watcher 形态验证：仅在 `api-session/status` 的
   `true → false` 边沿为**该会话**开一条 `session/follow`，读到最后一条 `turn/end` 后关闭
   （每次 turn 恰好一条流，避免 N 条常驻流）。
4. 记录：`reason.kind` + `reason.reason.kind`（aborted 时）+ 该 turn 的 `seq`。

**判读标准**
- 正常完成 `reason.kind==='completed'`；用户停止 `reason.kind==='aborted'` 且
  `reason.reason.kind==='user'` ⇒ **H3b**：R12 可在服务端闭合（不必依赖「自停标记已读」）。
- 若实机 abort 样本出现 `{kind:'legacy'}` 或缺失 cause ⇒ 退化为「aborted 即停止」的宽松判定，
  并把 cause 缺失记入 W7 上游提案 ②。

**失败与歧义处理**
- `aborted` 也可能来自 `parent`（父会话取消子代理）/ `disposed`（宿主关闭）/ `hook`；
  只有 `reason.kind==='user'` 才是用户主动停止——**不要把 `aborted` 全当用户停止**。
- 第三方 CLI 若用别的路径杀 turn，可能得到别的 cause；这正是 W7 ② 应该冻结的契约面。
- 读 `turn/end` 需要能打开 `session/follow`；旧 host 不支持时回退到 R12 现状分支
  （自停置读 + 中立项），并标 `degraded`。
- `session/page` 不适合做这件事：【事实】`throughSeq:-1` 在本机对所有会话返回空页
  （`throughSeq+1` 参与分页起点，`lib/index.js:1602`），且它需要真实 cursor；用 `session/follow`。

## 3. 可运行脚本骨架（仅内建模块）

只用 Node 内建：`fetch`、`WebSocket`（Node ≥ 22）、`crypto.randomUUID`、`AbortSignal.timeout`。
**不需要 pnpm / node_modules。** 用打包 node 直跑（已对本机运行中实例验证过 `list` 模式）：

```bash
/Applications/dsh-chamber.app/Contents/Resources/sidecar/node w0-probe.mjs list
/Applications/dsh-chamber.app/Contents/Resources/sidecar/node w0-probe.mjs sample auto 150 5000
/Applications/dsh-chamber.app/Contents/Resources/sidecar/node w0-probe.mjs watch 90
/Applications/dsh-chamber.app/Contents/Resources/sidecar/node w0-probe.mjs follow <sessionId> 60
W0_BASE=http://127.0.0.1:17500/api/i/local /Applications/…/node w0-probe.mjs list
```

```js
// w0-probe.mjs — W0 protocol probe. Built-ins only (node >= 22: global fetch + WebSocket).
// Base: the chamber control-plane proxy for the managed local instance (v1 /api/i/* has no
// auth boundary; the proxy injects the host browser-auth cookie). A direct host origin
// (http://127.0.0.1:17510) answers 401 on /api without the launch-token cookie.
const BASE = process.env.W0_BASE ?? 'http://127.0.0.1:17500/api/i/local'
const MUX = BASE.replace(/^http/, 'ws') + '/api/remote.mux'

async function rpc(method, payload, timeoutMs = 15000) {
  const rpcId = 'w0-' + crypto.randomUUID()
  const res = await fetch(BASE + '/api/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.json()
  if (body.type !== 'server-response' || body.rpcId !== rpcId) throw new Error(method + ': envelope mismatch')
  if (body.result.ok !== true) throw new Error(method + ': ' + JSON.stringify(body.result.error))
  return body.result.value
}
const row = s => ({ id: s.sessionId, updatedAt: s.updatedAt, running: s.running, blank: s.blank,
  lastPromptAt: s.projections?.values?.sessionListMetadata?.lastPromptAt,
  steps: s.projections?.values?.sessionStats?.steps })

// Q1: sample the same row twice while the agent produces output and no user message is sent.
async function sample(sid, seconds, intervalMs) {
  const target = (sid === 'auto' || !sid) ? process.env.DSH_SESSION_ID : sid
  const until = Date.now() + seconds * 1000
  const samples = []
  while (Date.now() <= until) {
    const list = await rpc('session/list', { args: { _request: {} } })
    const mine = list.items.find(i => i.sessionId === target)
    if (!mine) throw new Error('session not found: ' + target)
    samples.push({ at: Date.now(), ...row(mine) }); console.log(JSON.stringify(samples.at(-1)))
    await new Promise(r => setTimeout(r, intervalMs))
  }
  const [a, b] = [samples[0], samples.at(-1)]
  console.log('# Q1 VERDICT', JSON.stringify({ elapsedMs: b.at - a.at, deltaUpdatedAt: b.updatedAt - a.updatedAt,
    deltaSteps: (b.steps ?? 0) - (a.steps ?? 0), running: b.running }))
}

// Q2/Q3: one raw mux socket. The passive observer NEVER sends `$events/result` (answering would
// settle a pending approval for every client — see dsh-api-gateway/lib/index.js:683-693).
function openMux(opens) {
  const ws = new WebSocket(MUX)
  ws.onopen = () => { for (const [sid, endpoint, payload] of opens)
    ws.send(JSON.stringify({ type: 'open', streamId: sid, endpoint, payload })) }
  ws.onclose = e => console.log('# CLOSE', e.code, e.reason)
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data)
    if (m.type !== 'item') return console.log(JSON.stringify({ mux: m.type, error: m.error?.message ?? null }))
    const v = m.value
    if (!v || typeof v !== 'object') return
    if (v.type === 'ready') return console.log(JSON.stringify({ stream: m.streamId, ready: true, clientId: v.clientId, host: v.host }))
    if (v.type === 'emit') return console.log(JSON.stringify({ stream: m.streamId, emit: v.event, args: v.args }))
    if (v.type === 'waterfall') return console.log(JSON.stringify({ stream: m.streamId, WATERFALL: v.event, eventId: v.eventId, agentId: v.agentId, request: v.request }))
    if (v.type === 'cancel') return console.log(JSON.stringify({ stream: m.streamId, cancel: v.eventId }))
    if (v.type === 'snapshot') { const recs = v.records ?? []
      return console.log(JSON.stringify({ stream: m.streamId, snapshot: true, cursor: v.cursor,
        last: recs.at(-1)?.event?.type, tail: recs.slice(-3).map(r => ({ seq: r.event.seq, type: r.event.type, reason: r.event.data?.reason })) })) }
    if (v.type === 'event') return console.log(JSON.stringify({ stream: m.streamId, live: v.event.type, seq: v.event.seq, reason: v.event.data?.reason }))
    if (v.type === 'error') return console.log(JSON.stringify({ stream: m.streamId, error: v.error?.message }))
  }
  return ws
}

const [cmd, a, b, c] = process.argv.slice(2)
if (cmd === 'list') { for (const s of (await rpc('session/list', { args: { _request: {} } })).items.slice(0, 20)) console.log(JSON.stringify(row(s))) }
else if (cmd === 'sample') { await sample(a, Number(b ?? 150), Number(c ?? 5000)) }
else if (cmd === 'watch') { openMux([['ev', '$events', { args: {} }]]); await new Promise(r => setTimeout(r, Number(a ?? 60) * 1000)); process.exit(0) }
else if (cmd === 'follow') { openMux([['f0', 'session/follow', { args: { request: { address: { kind: 'session', sessionId: a }, maxMessages: 4 } } }]]); await new Promise(r => setTimeout(r, Number(b ?? 30) * 1000)); process.exit(0) }
else if (cmd === 'control') { openMux([['ctl', 'session/control', { args: {} }]]); await new Promise(r => setTimeout(r, Number(a ?? 10) * 1000)); process.exit(0) }
else console.log('usage: list | sample <sessionId|auto> <seconds> <intervalMs> | watch <seconds> | follow <sessionId> <seconds> | control <seconds>')
```

要点（写脚本时别踩）：
- `session/list` 的零参载荷是 `{args:{_request:{}}}`；`session/follow`/`session/page` 的载荷是
  `{args:{request:{…}}}`（参数名 = Remote 形参名；写错会得到 `gateway/arguments-invalid`）。
- `session/page` **不要用**：`throughSeq:-1` 实测返回空页；要 cursor 就从 `session/follow` 快照拿。
- 观察者只读：不发 `$events/result`。
- `$events` 里的 `$` 在 `bash -c "…node -e …"` 下会被 shell 吃掉（第一次实测因此得到 `endpoint:""` + close 1008）；写进文件或改用 `\u0024events`。
- 直连 host 源（17510）需要 launch-token cookie；本协议统一走控制面 `/api/i/local`。

## 4. 时间盒与所需前置

**总时间盒：30 分钟**（对齐主计划 §5-12「一次 30 分钟实测定分支」）：
| 段 | 分钟 | 内容 |
|---|---|---|
| 前置 | 3 | 找到控制面端口 / 确认实例在线 / 打开脚本 |
| Q1 | 10 | 双采样 ≥120s 间隔（可与 Q2/Q3 旁观并行，等待时间用来做 Q2/Q3） |
| Q2 | 8 | attach `$events`；有 pending 时重放即可判定，无 pending 时触发一次 |
| Q3 | 4 | `session/follow` 读一个已完成会话；再抓一个 abort 样本（无则记为待办） |
| 收尾 | 5 | 填 §5 表、按 §6 落结论 |

**所需前置**
- 正在运行的 dsh-chamber 桌面（或 gateway），且有至少一个托管实例在线；
  `lsof -nP -iTCP -sTCP:LISTEN | grep node` 确认控制面端口（本机为 17500，local dsh 为 17510）。
- 打包 node：`/Applications/dsh-chamber.app/Contents/Resources/sidecar/node`（v24.18.1，实测）。
- Q1：一个能在无新用户消息下持续产出 ≥120s 的会话（长任务；或旁观现成运行中的会话）。
- Q2：任一待审批/待提问的会话（或可控的 `ask_user_question` 触发）；没有也无妨——attach 时会重放。
- Q3：一个已结束会话（拿 completed 基线）+ 一个可控的停止动作（拿 aborted 样本）。
- 不需要：pnpm、node_modules、浏览器调试端口、远端主机凭据（那些只用于 SSH/网关线路的回归）。

## 5. 实验记录模板（表格）

| # | 时间 | 场景 / 命令 | 观测（原始值） | 结论（A/B、可得性、可区分性） | 证据（file:line 或输出） |
|---|---|---|---|---|---|
| 1 | （已填）启动检查 | fetch `http://127.0.0.1:17510/api/session/list`（无 cookie） | HTTP **401 unauthorized**；`GET /` 亦 401 | 直连 host 必须 cookie；实验统一走 `/api/i/local` | 运行输出；`browser-auth-cookie.ts:1-22`【事实】 |
| 2 | （已填）`session/list` via `/api/i/local` | POST `…/api/i/local/api/session/list` `{args:{_request:{}}}` | 200，182 行；每行 `updatedAt === projections.values.sessionListMetadata.lastPromptAt` | payload 形状确认；`updatedAt` 直接来自 `lastPromptAt` | 运行输出；`lib/index.js:1969-1971`【事实】 |
| 3 | （已填）Q1 双采样（会话 `164ae48f-…`） | S0: NOW=1789977775324 updatedAt=**1789977568048** running=true steps=54 active.through=1789977775291；S1: NOW=1789977901388 updatedAt=**1789977568048** running=true steps=65 active.through=1789977901277 | ΔNOW=126s、Δsteps=+11、**ΔupdatedAt=0** | **Q1=Track B** | 运行输出；`lib/index.js:1749-1754,1969-1971`【事实】 |
| 4 | （已填）Q3 completed 基线 | `session/follow` 快照（`session-50c8b022`，已结束） | cursor=257，尾记录 `turn/end` `{"turn":1,"reason":{"kind":"completed"}}` | `turn/end.reason` 在 wire 上 | 运行输出；`typert.host.js:1717,2056-2057`【事实】 |
| 5 | （已填）Q2 通路 | 裸 WS `$events` + `session/control` attach 25s | `{type:'ready',clientId,host:{home}}`；`ctl` baseline keys=`queues,jobs,projections`；301 帧/25s、无 waterfall（窗口内无 pending） | 无壳 mux 通路成立；控制流不是 pending 源 | 运行输出；`dsh-api-gateway/lib/index.js:585-608`、`typert.host.js:1692-1693`【事实】 |
| 6 | 待跑 | Q2 waterfall 帧（触发一次审批/提问） | 期望 `{type:'waterfall',event:'approval/request'｜'user-questions/request',eventId,agentId,request}` + 解除时 `cancel` | H2a 确认/否定 | §2.2 步 3-4【推断→事实】 |
| 7 | 待跑 | Q3 abort 样本（受控停止） | 期望 `{"kind":"aborted","reason":{"kind":"user"}}` | H3b 确认 | §2.3 步 2【推断→事实】 |
| 8 | 待跑 | pin 升级回归 | 白名单是否仍含两事件；`updatedAt` 语义是否改变 | A/B 是否需要重评 | `remote-events.js:12-32`、`lib/index.js:1749-1754` |

## 6. 对主计划 W0 与 §3.1 的具体文字修订建议

> 只给可替换文字；主计划本体由 Lead 合并。

**(1) §3.1 决策表**：A 行条件改为「pin 相关」，B 行补上 `turn/end` 事实来源。

原文（A/B 两行）：
```text
| **A 水位轨** | 摘要 `updatedAt` 随 agent 产出推进 | `session.list`（轮询/SSE）即可 | R1/R3/R9/R11/R12 无需观察者 |
| **B 边沿轨** | `updatedAt` 不推进 | watcher / headless 观察者产出 `completedAt` | 完成类需观察者；R12 靠「自停标记已读」闭合 |
```
建议改为：
```text
| **A 水位轨（备用）** | 摘要 `updatedAt` 随任意 durable 产出推进（当前 pin **不成立**，见 §2-3 实测；仅在 W7-① 被 host 采纳或 pin 升级后重评） | `session.list`（轮询/SSE）即可 | R1/R3/R9/R11/R12 无需观察者 |
| **B 边沿轨（默认）** | `updatedAt` 不推进（**当前 pin 已实测**：`updatedAt=max(createdAt,lastPromptAt)`，仅 user 消息推进） | watcher 订阅 `$events` 的 `api-session/status` 边沿，并在 true→false 时为该会话读 `turn/end.reason` ⇒ 产出 `{completedAt, turnEnd:{kind,cause}}` | 完成类需观察者；R12 由 host 事实 `reason.kind=aborted & cause=user` 直接闭合，不再需要「自停标记已读」兜底 |
```
并把表下注释（第 52-54 行）替换为：
```text
> 两支都需要 watcher 的地方：pending（R5）、行刷新（R9）、跨端读水位（R10）。
> **当前 pin 实测为 B**（§2-3 与 W0 记录表）：水位轨只是「若上游 future 推进 updatedAt」的省观察者分支，
> 不是本次落地轨道；观察者同时提供 pending 与 turn-end 分类，A 省不掉它。
```

**(2) §2 第 3 条**：把「实测前不得把内容水位当作唯一判据」改成已实测的定论：
```text
3. 摘要 `updatedAt` 的唯一写入器是 `sessionListMetadata.lastPromptAt`，且只在
   `user/message && data.source.kind==='user'` 时推进（`dsh-api-session-controller/lib/index.js:1749-1754,1969-1971`）；
   实机双采样（126s、+11 steps、`updatedAt` 不变）确认 agent 产出不推进水位 ⇒ 本次按 §3.1 的 B 轨落地。
   `updatedAt` 只作「未读水位」的次要信号与 pin 升级回归点，不作完成判据。
```

**(3) §5-12 裁决**：
```text
| 12 | **W0 已定轨：B=边沿制**（`updatedAt` 不随 agent 产出推进，静态+实测双证）；边沿事实升级为
  `turn/end.reason`（completed/aborted{cause}/interrupted/…），用户停止 ⇒ aborted+user ⇒ 不置未读；
  A 的水位制保留为「上游改语义后」的省观察者分支 | 见 W0 协议 §1.2/§2 |
```

**(4) §7-W0 里程碑**：三问收敛为实测结论 + 两个待跑确认：
```text
| W0 | **决策门（已定轨）**：① `updatedAt` 不随 agent 产出推进 ⇒ **Track B**（已实测）
  ② 连接方式 = 复用控制面既有无鉴权 `/api/i/*` unary + 最小裸 WS mux（`$events`/`session/follow`）
  ③ pending 可得性：`approval/request`/`user-questions/request` 在官方转发白名单且对新客户端重放
  ⇒ 无壳观察者可行（待抓一次真实 waterfall 帧）④ SVG scoper 真机验收 |
  轨道选定 + ①②③ 结论落地；待跑项（真实 waterfall 帧、abort 样本）转为 W1 契约测试用例；
  不可得项立即转 W7，不静默降级 |
```

**(5) R12**：改为服务端事实闭合：
```text
#### R12 手动停止被当完成
- 方案：watcher 在 running true→false 边沿为会话读 `turn/end.reason`：
  `aborted + reason.kind==='user'` ⇒ 记「用户停止」不武装未读；`completed` ⇒ 计完成；
  `blocked/error/max-tokens/interrupted` ⇒ 中立态（可配文案），不计完成未读。
  旧 host/不可读 ⇒ 回退「自停置读 + 中立项」（现状），响应标 `degraded`。
- 落点：`packages/gateway/src/session-state.ts`（状态机 `turnEnd`）、桌面 `deriveUnread` 的入参。
- 判据：本机/其他客户端/第三方 CLI 的 stop 均不产生未读；完成项照常。
```

**(6) §4 数据模型**：在行模型里加 `turnEnd`（加法，0.4.x 允许）：
```text
- **数据模型**：watcher 状态文件每会话
  `{ running, pendingKind?, subagentCount?, updatedAt, lastRunningAt, completedAt?,
     lastTurnEnd?: { kind: 'completed'|'aborted'|'blocked'|'error'|'max-tokens'|'interrupted',
                     cause?: 'user'|'parent'|'hook'|'disposed'|'legacy', at, seq } }` + 单调 `cursor`；
```

**(7) W7 提案 ②**：turn-end reason **已经存在**，提案应从「补 reason」改为「冻结/转发」：
```text
② turn-end 语义冻结与转发：`turn/end.reason`（含 aborted 的 `TurnEndCancelCause`）已在 pin 存在
  （`typert.host.js:2056-2057`）；请上游 ① 保证其为稳定契约、② 考虑把 `turn/end` 纳入
  `API_REMOTE_FORWARDED_EVENTS`（现白名单无会话事件，watcher 只能逐会话 `session/follow`）。
```

**(8) W1 出口判据补一条**：「每个完成边沿恰好读一次 `turn/end`（不常驻 N 条 follow 流），
且 `aborted+user` 不产生未读」作为契约测试。

**(9) 新增（可选）风险条**：「`session/control` 不能当 pending 源」：baseline 无 approvals/questions，
且是投影洪流（实测 301 帧/25s）；watcher 只订阅 `$events`（emit+waterfall），需要事件内容时才开
`session/follow`。
