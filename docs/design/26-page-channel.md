# 26 · 页面级多路复用通道（一条长连接承载所有长活流）

## 0. 摘要

页面在任一时刻只开**一条属于 HTTP 连接池的长连接**（同源 WebSocket `/api/page-channel`），把原先三类**长活 HTTP 流**收敛成它的逻辑订阅（升级后的每实例 Remote mux WS 不占池，不计入这一条）：

| 流 | 迁移前 | 迁移后 |
|---|---|---|
| 宿主健康（health） | 2 条 SSE（`/api/host/health-events`，App 与设置页各一条） | 通道内 `health` 订阅（控制面原生生产者） |
| 每实例客户端插件图（pluginGraph） | 每个已挂载实例 1 条 EventSource（`<prefix>/plugins/events`） | 通道内 `pluginGraph` 订阅（控制面上游 GET 目标 `/plugins/events`） |
| gateway 会话事实镜像（sessionFacts） | 每个 gateway 来源 1 条 SSE（`/chamber/session-state/stream`） | 通道内 `sessionFacts` 订阅（控制面上游 GET 目标同路径） |

实例在**通道内部**用 `instanceId` 定址；页面侧的连接数**与实例数无关**。容量属于控制面的上游管理器：一个订阅 = 一条上游连接，N 个实例 = N 条上游（在控制面，而不是在浏览器 6 个槽位里）。

## 1. 背景与实测证据

### 1.1 症状

- 冷启动/重载后，部分远端来源"无法连接"（同一配置下有时是 kunquwiki、有时是 harness）；
- 页面里 unary 请求（模型目录、boot graph、`session/list`）周期性 5s 超时；
- 会话事实降级提示反复出现且无法自愈；
- ⌘R 之后短暂恢复，几十秒后再次退化。

### 1.2 实测（同一台机器、同一套 WebKit 网络栈）

同一 origin 上开 N 条 SSE 后再发 unary 请求：

| 长连接形态 | SSE/WS 建立 | unary 请求 |
|---|---|---|
| 12 条 SSE（请求） | **只有 6 条建立** | 报告 0 个到达 |
| 6 条 SSE | 6/6（占满） | **0/5 完成**（20s 内连 30ms 的 POST 都发不出去） |
| 3 条 SSE | 3/3 | 5/5 通过，33–65ms |
| **16 条 WS + 3 条 SSE** | 16/16 + 3/3 | **5/5 通过，35–69ms** |

结论：**HTTP/1.1 同源并发上限是 6，SSE 占槽，升级后的 WebSocket 不占槽**。到 6 是悬崖而非斜坡——不是变慢，是请求一个都出不去。

### 1.3 归属：谁在占槽

迁移前页面最多持有 `1（App 健康）+ 1（设置页健康）+ N（live-graph EventSource）+ G（gateway 事实镜像）` 条长活 HTTP 流；5 个来源时即 10 条 ⇒ 必然 ≥ 6。

旁证：页面在报 5s 超时的同时，控制面到上游（本地 dsh / SSH 隧道）并无对应请求；而同一路径由独立客户端探测时是 4–98ms。这不是网络、不是服务端，是浏览器连接池被长活流占满后对 unary 的饿死。

## 2. 目标与非目标

**目标**

1. 页面侧长活 HTTP 流 = 0，**属于 HTTP 池的长连接** = 0，页面级 WS 恰好 1 条；升级后的 WS（每实例 Remote mux、官方客户端）不占池、不计入该不变量，其数量随来源数增长；实例数增长不改变页面的池内连接预算。
2. 每条流有独立失败域与独立流控：一个慢实例/慢上游不队头阻塞其它实例。
3. 通道自己是**唯一**的重连所有者和订阅所有者；消费方只保留"标脏/未知"语义与各自的 generation 栅栏。
4. 可事后定位：socket close code、每次退避的毫秒数与"第几次重连"、订阅错误码都落日志，关键失败落证据账本（`page-channel`）。

**非目标（明确不做）**

- 不把 Remote mux（`/api/remote.mux`）搬到通道上（见 §6 拒绝的备选）。
- 不改官方客户端协议、不改 gateway 的会话事实协议；控制面只做**上游消费者/转发者**。
- 不为页面引入 HTTP/2（见 §6）。
- 不在 gateway 形态挂载页面通道（本轮的页面（控制面 origin）是唯一消费方；`packages/gateway` 的升级面仍只认 `/api/remote.mux`。移动端当前不使用 health/pluginGraph/sessionFacts 三族；将来要用，必须在 gateway 的升级分发注册同一端点，而不是另起一条长活 HTTP 流）。
- 不设"最多几个实例"的容量旋钮（见 §3 D5）。

## 3. 设计决策

### D1 一条页面级 WebSocket

端点 `/api/page-channel`（与页面同源，注册在控制面 `defaultUpgrade` 的 origin 栅栏之后、逐实例代理之前）。为什么是 WebSocket 而不是继续用 SSE：

- 升级后的 socket 不占 6 个 HTTP 槽（实测 16 条 WS 与 unary 共存无影响）；
- 双向：订阅、退订、信用确认都在同一条连接上，不需要第二条控制通路；
- 双向控制帧与仓库其它流协议同形：客户端 → 控制面 `subscribe` / `unsubscribe` / `ack`，控制面 → 客户端 `ready` / `item` / `error` / `end`（§4 的 wire 契约是唯一来源）。

### D2 实例在通道内定址

帧里带 `instanceId`（与 `/api/i/<id>` 同一套 id：`local` / `dsh-*` / `gateway-*`）。控制面按 id 解析目标（本地 dsh 端口或已注册的 tunnel/gateway 传输记录），为每个订阅独立打开上游。页面侧不存在"每个实例一条 socket"的概念，因此**新增实例只增加控制面的上游连接**。

上游路由的单一来源：`sessionFacts` 走 `SESSION_STATE_STREAM_PATH`（`session-state-protocol.ts` 的常量，模块内不再写第二份字面量）；`pluginGraph` 的 `/plugins/events` 与 vendor `@deepseek-ai/dsh-client-hmr` 的 `EVENTS_ENDPOINT` 锁步（registry `mirror.dsh-client-hmr-events-endpoint`，由 flow 用例断言）。

上游订阅与实例反代共用同一套传输登记：目标被替换/注销时（tunnel 重注册、gateway 传输失效），控制面按登记连接撤销该连接上的订阅并回 `instance_unavailable`，客户端按自己的阶梯重订阅到新传输——旧 incarnation 的流不会被继续消费。

### D3 每订阅信用窗口

客户端在消费完一条 item 后按 UTF-8 字节回 `ack`；控制面在某订阅未确认字节超过 `PAGE_CHANNEL_CREDIT_WINDOW_BYTES`（256KiB）时暂停该订阅的上游读取，收到确认后恢复。这是 HTTP/2 per-stream window / SSH channel window 的同一条性质：**隔离而非限流**——慢消费者只暂停自己的上游。

真实边界（诚实口径）：`pause()` 停的是**之后的读取**，不是当前块——Node 一次最多交出一个读取块（默认 ~64KiB 水位），控制面会先把这一块里**已解析完的事件全部发出**再停下。所以任意时刻未确认量的上界是 `窗口 + 一个读取块 + 一帧（≤帧上限）`，仍然有界；这是流控（隔离慢消费者），不是计量。

口径：两侧都按 item 的 `data` UTF-8 字节记账（不是整帧），否则会永久漂移。原生 `health` 是完整快照，超过信用窗口后只保留最新快照，ACK 恢复信用后补发；它不适用 SSE 的逐事件停读。待发快照归订阅所有，退订、替换与 socket 关闭时丢弃。传输写缓冲超过一个最大 UTF-8 帧加信用窗口的安全边界，或发送失败时回收 socket 与所有上游，客户端按既有阶梯重建。

### D4 失败语义：通道拥有唯一重连阶梯

- 订阅级失败（上游结束、上游报错、通道断开）只通知该订阅（`onError(code,message)`），消费方据此标脏；
- 通道按有界阶梯重连 socket（1s→30s），并自动重订阅仍活跃的订阅；订阅级失败按 3s→30s 阶梯重发 `subscribe`；
- 客户端有**建连期限**（3s）：socket 从构造到 open 的超时由通道自己退役并走阶梯——环回握手实测 1–5ms，而页面「不可达」的可见阈值是 10s，所以挂起的握手总在用户看见遮罩前自愈；此路径不通知消费方（没有订阅失败，可见性由消费方自己的看门狗负责）；
- 消费方回调一律**异步**到达（`subscribe()` 返回之前绝不回调）：句柄形态的消费方（`subscribeHostHealth`）拿到返回值之后才绑 `onError`，同步投递会丢掉第一条——对没有 WebSocket/页面 origin 的宿主，那也是唯一一条；
- 消费方**禁止**再排自己的重连阶梯（避免重连风暴与"各自为政"的恢复）；boot graph/官方客户端的 unary 仍是权威，插件图只负责机会性更新；
- 上游单帧超帧上限、上游非 200、上游 200 但 content-type 明确不是 `text/event-stream`、上游响应头超时，一律按**瞬态** `upstream_failed` 处理并继续按阶梯重订阅（帧上限是内存安全线，不是能力判定）；上游流**结束**（正常或提前）走 `end` 帧，客户端映射 `upstream_end`，同样是瞬态并按阶梯重订阅——「有头无体」没有单独的失败路径（连响应头都没到才是 `upstream_timeout`，有头之后的结束就是一次 `end`）；本协议唯一的**永久**错配是 `capability_not_found`（例如对 non-gateway 目标订阅 sessionFacts），只有它不再重试。

### D4.1 收尾闩锁：停止窗口内的 upgrade 一律拒绝

`stop()`（以及启动失败的收尾）先关掉 `accepting`：此后到达的 upgrade 一律销毁，重启监听成功后才重新打开。为什么需要：升级过的 socket **不在 HTTP server 的连接跟踪里**（`closeAllConnections()` 收不回它），而 `pageChannel.closeAll()` 与 `srv.close()` 之间天然存在一个同 tick 窗口——没有闩锁时，一条已经排队/已挂起的 upgrade 事件足以让通道在 `stop()` 之后"复活"。闩锁必须在重启后打开（`wiring` 用例锁着两个方向）。闩锁之外还有一条**合并语义**：`stop()` 的每一次调用都推进 `lifecycleEpoch`——包括合并进进行中 stop 的那次；排队等 stop 结算的 `start()` 发现 epoch 前进就放弃复活。否则 `stop(); start(); stop()` 的最后一次意图是停，控制面却停在运行（`wiring` 的合并用例锁住这个方向）。

### D5 不变量 I-1（替代"写死超参数"）

> **I-1**：页面对自身 origin 的长活 HTTP 流数 = 0，**属于 HTTP 连接池的长连接** = 0，页面级 WS 恰好 1 条（升级后的 WS 不占池、不计入；与实例数无关）。

守它的三件东西：**静态断言**（`packages/*/src` 里任何 `EventSource` 引用——限定名/别名/字符串键都算——与流式 `getReader` 都算违例；白名单只有审计器实现文件与三处有界的一次性响应体读取，且判据自带正控语料与扫描文件数下限，避免"扫描空转也算绿"；剥离器按表达式位置识别正则字面量，正则里的 `/` 不再截断该行——那是"反向源锁假绿"的入口，正控语料钉着它）、**运行期报警器** `installPageChannelEventSourceAudit()`（页面里任何 `EventSource` 构造都记一条 `page-channel` 证据并告警；入口以锚定赋值 `__chamberPageChannelAuditInstalled` 安装，压缩产物可判定）、**socket 级 ping/pong 活性回收**（半个死连接不长期占着上游）。另外两件是**检测器**而非守卫，如实登记：`assertSingletonModule('page-channel')`（同一 bundle 里出现第二份模块实例时 `console.error`；它不会阻止第二条 socket，共享状态需要 `Symbol.for` 键控——暂列 STATUS 的观测缺口）与 `stats()`（订阅/上游计数的现场读数）。容量常量只允许出现在控制面（上游连接数 = O(活跃订阅数)），页面侧没有任何"最多 N 个实例"的配额。

### D6 健康 SSE 端点的退役

两条页面健康 SSE 迁走之后，`/api/host/health-events` 不再有生产消费方；保留它等于给 I-1 留一条回归通道，因此**删除**该 HTTP 路由（控制面内部生产者 `subscribeHealthEvents` 保留，供通道使用）。

## 4. 契约

- wire：`packages/dsh-chamber-wire/src/page-channel.ts`——路径、族、帧、信用窗口、出/入站帧上限、解析器与构造器（两侧唯一来源）。
- 客户端内核：`packages/dsh-chamber-client-core/src/page-channel.ts`——`subscribePageChannel(options)` 返回只影响本订阅的句柄；模块独占 socket、重连阶梯、重订阅与信用确认；`installPageChannelEventSourceAudit()` 是 I-1 的运行期报警器。
- 控制面：`packages/control-plane/src/page-channel.ts`——WS 服务端 + 三类上游适配（health 原生 / pluginGraph 与 sessionFacts 走上游 SSE）+ 信用窗口暂停恢复 + 关停清理。

## 5. 迁移与删除清单

**迁移**：renderer 的 `api.ts`（健康）、`live-graph.ts` + `shell.ts`（插件图）、`session-facts-source.ts` + `use-session-facts-lifecycle.ts`（事实镜像）、`dsh-chamber-client-ui-settings-connections` 的健康访问器、`main.tsx`（安装 I-1 报警器）。

**删除**：每实例 EventSource 工厂与重订阅阶梯（live-graph 的 `LiveEventSourceFace`/`LIVE_RESUBSCRIBE_DELAYS_MS`/`scheduleResubscribe`/readyState 分支）、`api.ts` 与设置页的 `new EventSource`、事实镜像的 fetch+reader 流循环与客户端连接期限时器、`/api/host/health-events` HTTP 路由及其测试、文档里的旧描述。

**保留**：Remote mux（每实例 WS，官方协议）、unary HTTP（本地/远端会话列表、官方客户端 RPC）、事实镜像的 unary 快照对账（权威仍在 unary）。

## 6. 拒绝的备选

**Rejected alternatives（原生生产者背压）**：① 只记账而继续发送——没有可暂停响应的原生生产者会持续积压；② 为每次健康转移建立无限队列——消费者需要当前完整状态，中间快照可被最新状态取代；③ 发送失败后只记日志——客户端会等待从未收到的帧，信用停读也可能永久悬留。传输缓冲保护是异常连接的回收边界，不是实例或订阅数量配额。

1. **继续每实例一条 SSE，只调小数量**：容量必须随实例数增长，任何固定上限都会静默剥夺第 N+1 个实例的实时通道——把"饿死"换成"看起来连上但永不更新"。
2. **把 Remote mux 也搬到通道**：mux 已经是升级后的 WS（不占 HTTP 池），搬它不解决任何池问题，却把整套交互式 UI 的 RPC 绑到新通道的失败域上（相关性故障从"单来源"放大到"整页"）。
3. **loopback HTTP/2（一条 TCP 多 stream，流控白送）**：WebKit 没有 h2c（明文 HTTP/2），要上就得处理 TLS 证书与信任；而且 RFC 8441（WebSocket over HTTP/2）在 WebKit 上也拿不到，连 Remote mux 都搭不上这条 h2 连接——它能省掉槽位竞争，却要为此改掉整条协议栈。留作将来可选。
4. **运行时配额（例如"最多 3 条长连接"）**：见 D5——配额是错的表述，正确表述是不变量 + 静态/运行期断言。
5. **把 SSE 的 5s 期限改成更长/去掉期限**：只把失败推迟，不改变请求排不到 socket 的事实（本设计之前的版本已经验证过这条路无效）。
6. **把逐实例反代的转发核心（`proxy-forward.ts`）与通道的上游适配合并成一份实现**：两者的下游形状根本不同——反代把上游流原样写给浏览器的 HTTP 响应（体上限、HTML 注入、计数器、pending upgrade 租约），通道是**服务端消费者**（逐订阅信用窗口、按帧重封、订阅级拆除）。合并要在 ws 下游重建整套反代语义，收益只是十几行头构造；真正需要共享的是**传输登记**（撤销与计数），那已按 F2 用 `onTransportRevoked` 接上，而不是靠复制转发核心。
7. **一条多路复用 SSE 承载全部三族**：它只占 6 个槽里的 1 个，却仍然占着池——一旦这条流写阻塞/半开，unary 与它自己一起被拖住（正是要消灭的耦合）；订阅/退订/信用确认需要第二条控制通路（POST），服务端也无法发 ping，只能靠注释保活。池内长连接 = 0 是比"少占几个槽"更强的性质，所以选 WS。

## 7. 验证门

- CI 静态断言：shipped 源码中 `EventSource` 引用与流式 `getReader` 均不得出现（白名单与正控见 §D5）。
- 单元/集成：wire 解析与构造（族必须是字符串本身，拒绝类型混淆；keepalive 判据 = 事件名 + 空 data）；客户端通道（单 socket、订阅帧、item 分发、信用确认、断线重连后重订阅、关闭语义、宿主不可用/构造失败的如实通知、**通知按轮次去重**：可恢复失败每轮一次、宿主永久属性只一次、**快照迭代**：`onError` 里同步新建的订阅不得继承旧 socket 的关闭、建连 3s 期限退役挂起的 CONNECTING socket、阶梯只在稳定运行后归零、最后一条关闭不遗留零订阅重连、回调一律异步到达）；控制面（health 生产者转发、**同步生产者的帧序恒为 [ready, 快照, …]**、订阅即快照、SSE 上游转发、跨块 CRLF/裸 CR、非 SSE 200 拒绝、逐行增量的规模上限、信用暂停/恢复且**只在成功发送后记账**、退订/断线/关停清理、传输撤销、非法帧忽略、非 gateway 的 sessionFacts 拒绝、`logger` 抛错不得打断流、attach 中途失败不留孤儿 socket）。
- 生命周期：`stop()`/启动失败之后的 upgrade 一律拒绝（accepting 闩锁），重启后恢复服务（闩锁不得变成一次性）；任一 server 收尾路径都必须 `closeAll()`。
- 现场可观测：`[page-channel]` 日志（socket close code、订阅错误码、重连）、证据账本 `page-channel` 行。

## 8. 关联

- [14](14-sleep-background.md) §D4：证据有效性层（`unscheduled` 不再被当作来源事实）。
- [04](04-control-plane-api-data.md)：控制面 REST 与逐实例反代形状（本设计新增一个页面级 WS 端点）。
- [05](05-connection-manager.md)：多来源会话导航与 Remote mux 的客户端契约。
- [09](09-client-plugin-runtime-loading.md)：客户端插件图与 `plugins/events` 上游。
