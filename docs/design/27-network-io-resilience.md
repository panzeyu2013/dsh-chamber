# 27 · 网络 IO 韧性（WAN 健康分级与恢复） - 设计

> 状态：**v1 代码面完成**；实机/组装态验收见 STATUS。本文是 2026-10 弱网评审后的收敛方案：
> 不新增包、不改 `TransportPhase` 五值、不新增 503 错误码；只加 link health
> 子态、注册边沿、down 快速失败、上传总预算、页面通道 link epoch、载波 closed
> 逃生与 mutation unknown 分类。未完成实机门禁见 `docs/progress/STATUS.md`。

## 1. 问题

内网/环回正常，外网（100–400ms RTT、1–5% 丢包、10–30s 黑洞、NAT 超时、
切网/睡眠唤醒）下卡顿。根因不是单个超时，而是：

1. 一次 5s 身份复验失败即杀隧道、注销代理、revoke 全部在途流；
2. 上游腿没有端到端活性，半开要等 60–90s（SSH keepalive）；
3. 传输/页面/订阅/流/日志阈值互不协调，抖动时退避棘轮；
4. 每次恢复全量重放，且一个实例全部流量共用一条 SSH TCP；
5. 45s 上游计时覆盖大上传的 socket flush；
6. mutation 超时后宿主可能已提交，客户端却当失败重试。

## 2. 不变量

- **I1** 单次非确定性探测失败只标 `suspect`；连续两次**网络级**失败才 `down`。
- **I2** `TransportPhase` 保持 `idle/connecting/ready/degraded/error`；健康是
  `ready` 子态，用 `link.state` + `linkEpoch` 表达。
- **I3** `suspect` 正常转发；只有 `down` 快速失败（新请求与新订阅，沿用
  `instance_unavailable`）；**已建立**的页面订阅在 down 边沿不失败，交给确认窗到期后的
  teardown（unregister/替换）撤销；health 更新绝不 re-register，也不直接 revoke 在途。
- **I4** 页面通道在 link epoch 变化时清掉待发 timer 并立即重订阅；**不清重试阶梯**
  （阶梯跨 epoch 继续爬升，只有稳定运行 30s 才归零，避免 flapping 时每次恢复都把
  退避打回 3s）。普通 `ready` 保留 30s 稳定窗。epoch 的递增点有两处且只有两处：
  任何进入 `ready` 的新化身（含重连），以及 ready 期内的 down→healthy 恢复；
  suspect→healthy 不递增。
- **I5** 复用现有 `RemoteStream`/mux 重试道；v1 **不**新增 `$events` 软重试。
- **I6** 链路阈值在 desktop-only 的 `transport-health.ts`（唯一消费者是
  transport-manager）；代理侧阈值留在 `proxy-forward.ts`；不建共享策略包、不改
  `dsh-stream-state` 的流表。唯一的跨 owner **契约**是上传/头窗/mutation 预算的推导
  （`dsh-chamber-wire/src/net-budget.ts`）：它不是策略包，而是代理与页面客户端必须共同
  守住的一条不等式（客户端预算 ≥ 代理最坏情形 + 余量）。
- **I7** mutation 不自动重试：分类是 **opt-in**（已知 mutation 表 + 调用点显式声明），
  默认端点按读处理。body 已发出后上游超时/断流返回 `details.phase=after-body`；mutation
  映射 `MutationOutcomeUnknownError`，非 mutation 映射 `ResponseLostError`（可重试）。
  已派发后的传输级丢失（超时/截断/连接失败）在客户端同样归为 unknown；调用方主动 abort 除外。
- **I8** SPKI pin 路径继续 `agent:false`；非 pin 使用显式 keep-alive agent。
- **I9** 观测复用现有 counters/logs；不新增 HTTP 诊断面。

## 3. 契约

### 3.1 TransportStatusProjection.link

```ts
interface TransportLinkProjection {
  state: 'healthy' | 'suspect' | 'down'
  linkEpoch: number       // 进入 ready/新可用世代时递增；页面重置键
}
interface TransportStatusProjection { /* existing fields */ link?: TransportLinkProjection }
```

旧 renderer/bridge/shim 缺省按 `healthy` 处理。epoch 递增语义见 I4（两处递增点）；
  §3.2 的「只有 down→healthy 才 bump」仅描述探针路径，不覆盖进入 ready 的新化身。

### 3.2 探测策略（LINK_POLICY）

- **探针期限**取 provider 声明的 `verifyUpBudgetMs`（复合流程：gateway 口令
  login 10s→probe 5s→401→relogin 10s→reprobe 5s，最坏 30s，声明 35s），未声明时回落
  `probeTimeoutMs`（5s，单次身份交换）；期限是 dead-man 兜底，不是预算——把可跑完的
  复合探针按 5s 判失败会把「慢但可达」记成网络失败。connect 期的 verifyUp 用同一预算。
- 一次网络失败（timeout/DNS/TCP/TLS）→ `suspect`，2s 后重探，不杀链（探针单飞：
  超时的探针要走完自己的期限才排下一次，所以「超时 + 2s」才是真实间隔，最大 ≈7s）；
  401 只有在 provider 能自愈时才走 `auth`；不可自愈的 401 由 provider 标 terminal，
  manager 先走 failTerminal——它结束传输，但不会伪装成链路死亡；
- 连续第二次 → `down`；`nextProbeDelayMs=null`（down 分支自己排 2s 探针）；
- 5xx/408/425/429 → `server`（可达、繁忙），401 → `auth`（可达，provider
  自行 re-auth 一次），都不计入网络失败；两者把 link 置 `suspect`（0 streak），
  复探按表值 `reachableProbeIntervalMs`=10s（不是 2s：可达失败重试更密只会加压）；
- 403/404/身份不匹配/协议错误 → `protocol` terminal（manager 直接 failTerminal，
  不经过 reducer）；
- 成功显式清空 streak；
- **自己的大流量不算断链**：实例正在 flush ≥256KiB 的请求体时（窗口被上传 idle/
  总预算约束，见 NET_BUDGET：60s 下限、30min 上限；20MB 约 160s），或**下游响应体在最近 2s 内交付过字节**时（HTTP chunk 与 WS 帧），
  控制面代理的 `isLinkBusy` 为真（来源三处：实例代理的 HTTP chunk、remote.mux 的 WS 帧、
  **page-channel 自己的 SSE 下行**——后者的请求不在实例代理的 traffic 表里，经
  `onDownlink`→`noteDownlink` 并入同一窗口）；此时探针的网络失败只记录、不计数、不改
  health，2s 后重探。探针与业务共用同一条 SSH TCP（HOL），否则 20MB@2Mbps 上传/大文件
  下载/大 session 流会把自己的隧道判死。下游停流 2s 后 busy 自然失效——真死的链路仍会
  被判 down。每次注册递增该连接的**化身代数**，请求在派发时捕获代数：同 id 替换后旧化身
  的迟到 chunk/失败回调不得给新化身记 busy 或触发复探；
- **失败驱动复探**：一次真实转发的传输级失败（socket 错误/代理超时/握手不完成/响应体
  停流，即「没有完整 HTTP 应答」）会让控制面通知 desktop（`onTransportUpstreamFailure`
  → 按 `transport-identity.ts` 把 connectionId 还原成 raw id → `notifyLinkFailure`），
  manager 立刻做一次强制探针——这是心跳之外唯一的「现在就有证据」路径。约束：只在
  link 仍 `healthy` 时触发（suspect/down 已有自己的节奏）、本连接正在大上传时不触发、
  与在途探针互斥、每实例至少间隔 `failureProbeMinIntervalMs`（2s，一次请求风暴算一个
  事件）；完整的 HTTP 应答（任何状态码）与客户端 abort 都不是链路证据。
  控制面的 transport 面**一律用 connectionId**（`dsh:<raw>`，与 unregister/health 同一
  命名空间），raw id（manager/registry 的 `<raw>`）与 connectionId 的换算只允许走
  `packages/desktop/transport-identity.ts`（sourceId `dsh-<raw>` 归渲染器的
  `transport-source.ts`，desktop 不需要）——两侧自洽但命名空间错配会让 seam 静默 no-op。
- **心跳两级**：稳定链路 30s（旧值 60s 会让「零业务流量」的半开盲窗长达 ≈62s；30s
  是成本与盲窗的折中，每实例每半分钟一次小 RPC）；**ready 边沿或任何健康迁移后的 120s
  观察窗内收紧到 10s**（刚重连/刚抖过的路径最容易掉 NAT 状态），两档都带 ±10% jitter。
  显式注入 `readyVerifyIntervalMs` 时固定单档（测试确定性 seam）。
- **探针可取消**：`verifyUp(spec, endpoint, signal?)` 的 signal 在「探针期限到点」与
  「disconnect/retarget 撤销该 transport」时 abort：不再留孤儿请求，也不会在撤销之后
  再完成一次 gateway 会话轮换。两条腿都覆盖（ssh 口令腿走 `postClientRequest`、直连
  gateway 腿走 `boundedGatewayRequest`）；唯一例外是 **gateway 口令登录腿**（它不是
  一次探针，且登录完成即被 generation 围栏挡住）。provider 忽略 signal 仍然正确。
- `resume`/`online` 对 `ready` 也强制一次复验，绕过用户 10s 静默窗；`online`
  波次由 manager 合并并按 120ms/实例错峰（页面只报事件，不自己扇出）；
- `reverifyAll` 按 120ms/实例错峰，心跳两档（30s / 观察窗 10s）加 ±10% jitter；故障驱动的复探
  （2s/10s）不加 jitter——表值就是防风暴机制；
- 连续两次网络失败进入 down 后保留 `downGraceMs`（默认 **30s**，覆盖设计目标里的
  10–30s 黑洞）ready 确认窗：窗内新请求/新订阅快速失败，已建立的页面订阅与在途
  请求继续；**每次进入 down 都重开窗口**（down→可达失败→down 不得继承旧截止点）；
  窗内继续按 suspect 节奏探针，恢复即取消 grace；窗满仍 down 才交给 reconnect。
  到期时若有在途探针，最多顺延到「窗口 + 该 provider 的探针预算」这个硬截止点；
- forced resume/online 探针若撞上 in-flight 探针，会在其 settle 后补跑一次。

### 3.3 代理 health

`registerInstanceTransport(..., { health })` + `setInstanceTransportHealth`。
`suspect` 不改变转发；`down` 新请求/新升级 503 `instance_unavailable`（与既有
错误体同形，无新增字段），**新**的 page-channel 订阅在定址时快速失败；已建立的
订阅不随 down 边沿失败——它们由确认窗到期后的 teardown（unregister/替换）以同一
错误撤销。理由：down 边沿立刻失败订阅会让 30s 确认窗对页面完全空转，而恢复即热
重订阅；把失败落到 teardown 后，「窗内恢复」不再产生任何页面抖动。
desktop 在 down 后保留 `ready` 一个 `downGraceMs`（默认 30s）确认窗：期间
health-only 更新不 revoke 在途；窗满仍 down 才进入既有 reconnect，phase 离开
ready 时 unregister 并 revoke。撤销时若请求 body 已完成，代理先写 502
`upstream_failed` + `details.phase='after-body'` 再结束响应，避免客户端拿到裸
网络错误而误重试；body 未完成的请求不写该标记（bodyless 的 GET/HEAD 在转发前即
视为「未写」，但带 framing body 的 GET/HEAD 与 POST 同规则）。**没有标记的 502/504
对 mutation 仍按「可能已生效」处理**：body 未完成只证明代理没写完，不能证明宿主没收到
前半个请求，保守归类宁可让用户多刷新一次，也不把一个可能已执行的操作报成「未转发」。
超过 grace
的在途仍由 reconnect 收尾——这不是无限期保护。registration key 只在
url/transport/auth 指纹/pin/authority 变化时触发 re-register（键与指纹用 JSON
编码的二元组，值里的分隔符不可能与另一组 header 碰撞）。

上游连接池是**每连接**的 keep-alive agent（非 pin 路径；pin 仍 `agent:false`），
在该连接的 unregister/替换处随在途流量一起销毁：进程级单池会让被替换隧道
（每次重连都是新 loopback 端口）的空闲 socket 永久滞留，还可能把半开 socket
交给下一个化身。gateway-proxy 自持一份并在 `closeAllStreams` 销毁。

### 3.4 上传

- 请求体仍整体缓冲（v1 不改流式）；
- 体传输使用 `proxyUploadBudgetMs(bytes) = clamp(max(60s, bytes/128KiB/s), 60s, 30min)`
  + `uploadIdleMs=30s`（按 socket write/drain 进度重置）；
- header/idle 计时在 `finish` 之后才启动；
- 预算推导的**唯一来源**是 `dsh-chamber-wire/src/net-budget.ts`：代理用
  `proxyUploadBudgetMs`，页面客户端用 `mutationCallBudgetMs = proxyWorstCaseMs + 5s`，
  一条 wire 用例按体积网格钉住「客户端 ≥ 代理最坏 + 余量」；
- `x-chamber-rpc-budget-ms` 不进 v1；长路径继续走 `LONG_RPC_PATHS`。

### 3.5 Mutation unknown

判据是 **opt-in** 而不是排除法：`MUTATION_ENDPOINTS`（14 个 chamber 端点）同时派生
长预算与 unknown 分类；表外的写调用（gitWorktree 的 create/rollbackCreate/remove）
用 `CallOptions.mutation=true` 显式声明；其余端点一律按读处理（重试安全）。
幂等破坏性调用（archiveCleanup/purge）刻意留在表外，保留「可能仍在运行、可重试」
的文案。

代理在 body 已完整发出后超时/上游连接失败，返回 504 `upstream_timeout` 或
502 `upstream_failed` + `details:{phase:'after-body'}`。客户端据此：
mutation → `MutationOutcomeUnknownError`（不得重试）；非 mutation →
`ResponseLostError`（可重试的「响应丢失」）。已派发后的传输级丢失（客户端超时、
连接失败、响应体截断且无法解析）在 mutation 上同样归为 unknown，读保持普通失败；
调用方主动 abort 保持 AbortError。响应头已写出后无法再改状态码，客户端对 mutation
的截断响应同样按 unknown 处理——这是 I7 的客户端侧另一半。

### 3.6 页面通道恢复与载波 throttle

- `linkEpoch` 变化时清掉待发 timer、立即重订阅（**不**清零重试阶梯）；同一 source 的等待订阅按
  首个立即、其余 120ms/槽（**槽 1..16 轮转**，第 18 条回到槽 1 而不是槽 0）
  错峰释放，避免恢复瞬间风暴；本地 source 没有 transport 投影，其 epoch 由
  `health.dsh.status` 的上升沿驱动（renderer 的 `localLinkEpochRef`）。
- 停放是**粘性**的：停放期间的迟到瞬态错误不再排阶梯、也不在投递时伪造
  `instance_unavailable`（已在调度时停放的通知仍照常投递——初始停放靠它）；
  30s 的 `PAGE_CHANNEL_LINK_PARK_FALLBACK_MS` 兜底重探一次，避免依赖未来投影边沿。
- 载波 socket **非 OPEN**（closed/closing 或仍在 CONNECTING）时绕过 60s rebuild
  窗：没有健康载波可保；多次非 OPEN 替换按 50ms 下限防抖（`replaceSocket` 自身也
  刷新该时间戳），并补一条 `carrier-rebuild-bypass` 取证。
- socket 仍 open 但 reducer 拒绝 rebuild 时，只有**证据型**请求在窗口/间距到期点做**一次**
  延迟替换（`carrier-throttle-expired` 取证；重试至少 1s 后，若窗口边不足 1s 则最多推迟 1s），
  随后交给下一次真实边沿；证据型拒绝仍先
  `reopenLogicalStream`（lane 拒绝没有 streamId，重开由连接泵完成，见下），不留空转。
  可到达的两条证据腿：opening 期限（reducer 的拒绝 reason 可为 `socketNoFrame`（零帧）或
  `openingStall`（有帧越阈值））与 teardown 的 `teardownNoFrame`；**arm 与 expired/rebuild
  的取证都取 reducer 的裁决 reason**（不取请求侧字面量），所以零帧与阈值型在延迟替换的
  detail 里可区分。`handshakeTimeout`
  虽是 union 成员，但本驱动没有发射点：握手到期只 reject 连接候选，pre-OPEN 的替换走
  non-OPEN bypass 或连接泵的 maintain 退避，不经本窗口。**lane reconnect 的拒绝不排期**：
  lane 请求是启发式（“代际丢了/可能陈旧”），不是载波证据——它已经由 non-OPEN bypass 或
  逻辑流重开满足，真实载波故障各有自己的证据腿重新入队。排期它会把“每窗口最多一次重建”
  的上限变成 60s 排期：延迟替换杀掉新 socket 上活着的代际 → lane 在窗口内再次被拒 → 再排期，
  形成健康载波上永久的一分钟一次重建（`mux-self-heal` 有 300s 虚拟时钟回归用例）。

## 4. 模块落点

| 模块 | 变更 |
|---|---|
| `packages/desktop/transport-health` | `LINK_POLICY`、纯 health reducer/probe 分类、单测；desktop 唯一阈值 owner |
| `packages/desktop/auth-recovery-policy` | auth 失败恢复的节流/延迟决策（纯函数 + 单测） |
| `packages/desktop/auth-recovery` | auth 恢复驱动器：计时器/节流记账/取消（注入时钟与计时器，组装态用例） |
| `packages/desktop/transport-identity` | raw id ⇄ connectionId 的唯一换算 + 两个 seam 适配器（失败驱动复探/busy 双向跨边界） |
| `packages/desktop/transport-manager` | health 子态、two-failure down、success clear、resume/online、`reverifyAll`、bind-race 重分配、5xx transient |
| `packages/desktop/transport-provider` | `link` 投影与 `failureKind` |
| `packages/desktop/ssh-provider/gateway-provider` | failureKind 分类；SSH `ConnectTimeout`/`ExitOnForwardFailure` |
| `packages/desktop/host-assembly` | registration key；health-only `setInstanceTransportHealth`；不 re-register |
| `packages/desktop/transport-registration` | 纯 registration key/fingerprint/decision 单测，锁住 health-only 边沿 |
| `packages/control-plane/instance-proxy` | health 记录/快速失败；`setInstanceTransportHealth`；每连接 keep-alive 池与生命周期销毁；`isLinkBusy`（≥256KiB 上传窗口 + 2s 下游字节窗口）；上游失败缝（connectionId） |
| `packages/control-plane/proxy-forward` | 上传总预算/IDLE（预算取值来自 wire 契约）、每 owner agent 池、body-transfer 信号、after-body details（只对真正发过体的请求） |
| `packages/dsh-chamber-wire/net-budget` | 上传/头窗/mutation 预算的唯一推导 + 排序不变量 |
| `packages/dsh-chamber-client-core` | page-channel link selector/epoch 唤醒/等待/错峰释放；`link-projection`（ready/epoch 投影的唯一解读）；`MutationOutcomeUnknownError`/`ResponseLostError` |
| `packages/dsh-client-connection`（vendor fork） | `[patch-mod]`：502/504 + after-body 的官方 unary 分类文案 |
| `packages/dsh-api-gateway` | closed socket 绕过 rebuild 窗；**证据型** denied 到期一次延迟替换（lane 拒绝不排期）；内部 carrier 事件（不发 wire） |
| `packages/dsh-stream-state` | 模块内穷尽 `REBUILD_REASON_KIND` + `isEvidenceBackedRebuild`：证据/启发式的分类归 reducer（新 reason 不分类即编译失败）；**表值/Swift 未动** |
| `packages/renderer` | `configurePageChannelLink`、online 重验、`reverify(id,reason)` |

## 5. 明确不做（v1）

- 不新增 `dsh-network-policy` 包；链路阈值放 desktop-only `transport-health.ts`，
  不复制 `dsh-stream-state` 的流表。跨 owner 的**预算推导**例外收进已有的
  `dsh-chamber-wire`（零依赖、两侧都已在运行期 import），因为它是一条双侧不等式，
  不是策略表。
- 不新增 `SourceLinkStore`；renderer 选择器 + page-channel 注入即可。
- 不新增 PinnedAgent；pin 仍每请求 `agent:false`。
- 不新增 FrameTap/代理上游心跳；半开由两次探针判定。
- 不新增官方 RPC 4 槽预算；保留 design 26 D7 的 2 槽头寸。
- 不新增通用 OperationLedger；只做 unknown 分类。
- 不新增 `instance_degraded` 错误码；down 复用 `instance_unavailable`。
- 不做 `$events` 软重试；需要宿主 `hostBootId` 后再评估。
- 不改 `TransportPhase` 联合；不重写 spawn/exec/credential 状态机。

## 6. 已知限制

1. `$events` 结束仍会导致连接代际重连 + 全量重放；根治需宿主 boot id/首帧期限。
2. 单 SSH TCP HOL 未解决；第二隧道只在仿真证明 HOL 为主因后另案。
3. 浏览器 6 槽池仍全局；快速失败只缩短占槽，不增加并发。
4. Pinned gateway 仍每请求 TLS；>10% pin 请求占比再评估 per-socket pin agent。
5. 宿主 mux 2s×2 心跳可能误杀；可 vendor patch 调宽，不在代理代答 pong。
6. gateway/mobile 不消费 page-channel link；本设计为 desktop 形态。
7. 大 session list 仍受 page-channel 4MiB 单帧/256KiB 信用窗约束；需另案分片。
8. 入站地板是 30s 的 client-body idle，不是 35s `requestTimeout`：loopback 实测（Node 24）连续 49s 上传与 40s 中途停顿都不触发 35s 上限，故慢上传的真风险只在「读请求体超时」。打包态 Electron 主进程未复测。
9. down grace 默认 30s；超过该窗的在途仍会被 reconnect revoke（不是无限期保护）。确认窗到期时若有在途探针，最多顺延一个 provider 预算。
10. “尚未判 down 的半开”仍无服务端 idle watchdog（pluginGraph 无 keepalive 契约），只能靠探针/重订阅收敛；down 边沿不再失败已建立订阅，半开 SSE 在确认窗内保持安静。
11. mutation 客户端预算 = 代理最坏（上传预算 + 45s 头窗）+ 5s 余量（下限 110s、上限 30min50s），由 wire 契约唯一推导；上传 flush 慢于 128KiB/s 假设时客户端仍可能先 abort（客户端侧已把该传输丢失归为 unknown）。
12. `reverifyAll` 已按 120ms/实例错峰、心跳两档（30s/10s 观察窗）都加 ±10% jitter；仍未对连接尝试本身做全局配额。
13. `linkEpoch` 有两处递增点（进入 ready 的新化身、ready 期内的 down→healthy）；suspect→healthy 不 bump。down 恢复仍会让页面通道立即重置，这是“恢复即唤醒”与“30s 稳定窗防抖”的取舍。
14. manager 的兜底分类会从 detail 的 `HTTP nnn` 取 statusCode；shipped provider 的普通失败都显式声明 `failureKind`（gateway 口令 401 的终态走 `terminal:true`，不声明 failureKind），该兜底只对旧/自定义 provider 生效（防御性双写）。
15. host-assembly 的 auth 恢复接线已抽成可测驱动器（`auth-recovery.ts`：节流/延迟/取消/取消后重试，注入时钟的组装态用例）与纯守卫 `authRecoveryStillApplies`（phase/readyUrl/kind/口令/scope 五轴 fail-closed 用例）；**每个注册边沿**（状态推送 register / sessionRefresh.register / onVerified）都会取消待发的延迟恢复，尝试本身延后一个 microtask 以避开 onStatusChanged 重入。装配侧只剩观测取值，没有 fake plane+sm 的整链集成用例。
16. 下载拥塞已有第二信号：下游字节（实例代理的 HTTP chunk / remote.mux 的 WS 帧 / page-channel SSE 经 `onDownlink`）进入 2s busy 窗口，窗口内探针失败只记录不计判；残余是 2s 窗口本身的代价——真死链路在下游停流后最多 2s 才恢复计数，且任何活跃流量都会短暂抑制判定。
17. `file-budgets.json` 的 `lines` 只降不升（棘轮；`--update-budget` 拒绝上调）；`target` 是评审判定的收口目标，下调直接改，**上调必须在该行 `note` 写出边界理由**（结构性切分后允许把 note 写成结构说明，但不得用它替代 `lines` 的算术）。`kind: ceiling` 标「不指望缩」，`FROZEN` 是「已登记为有意保留的边界」；`proxy-forward` 与 client `page-channel` 未上棘轮。
18. 页面的 `reverify(reason)` 是提示而非授权：IPC 边界把非枚举值归一为 `user`，shim 原样转发；这是信任边界上的规范化，不做跨进程校验。
19. 零业务流量时的半开仍只能靠心跳发现：稳定档 30s（最坏 ≈32s + 30s 确认窗），ready 边沿/健康迁移后的 120s 观察窗内 10s。没有「不探就知」的本地信号（宿主 mux 无 keepalive 契约、ssh 层 keepalive 只判 TCP 死且调快会误杀可自愈的黑洞），故这是成本与盲窗的折中；一次真实转发的传输级失败仍会立刻触发受节流的强制探针（2s 一次、仅 healthy、避开 busy）。
20. 官方前端自己的 mutation（message/send、goals/*、approval/*、commands/execute 等）走 vendor 客户端：`dsh-client-connection` 的 `[patch-mod]` 现在识别 502/504 + `details.phase=after-body`，把错误写成「可能已生效、刷新后再重试」。官方 unary 本来没有自动重试，故这只是诚实分类，不改变重试语义；客户端 UI 是否展示该措辞由官方决定。
21. epoch 变化会立即释放停放/待重试订阅（「恢复即唤醒」），但**不再清零阶梯**：极差链路按 epoch 频率恢复时，失败订阅按自己的阶梯退避，只有稳定运行 30s 才归零。
22. link 投影的 ready/epoch 判定已收口到 client-core 的 `link-projection.ts`（有单测），渲染器只保留 local/未知 source 两个事实分支（本地实例没有 link 投影，不在 client-core 的输入里）；`becameSuspect` 已删除。
23. registration key 的**编码**已对象化（`registrationKey({url,transport,headers,spkiPin,authority})`）：位置漂移在类型上不可能，五个字段都是 string（spkiPin/authority 互换仍能编译），由 key 的字段顺序编码、碰撞用例与四调用点的字段映射测试兜住；四个调用点的**字段装配**仍来自不同事实源（状态推送 / refresh facts / onVerified），只共享编码与指纹。onVerified 的指纹门仍只比较 headers 子集，其余字段变化由状态推送的 key 比较兜住。
24. connect 期 verifyUp 有与 ready 探针相同的外层期限（provider 声明预算）与可取消 signal（期限到点/disconnect 都会 abort）；两条 provider 腿都已透传（ssh：`verifyDshEndpoint`/`probeDshSignature`/`verifyGatewayEndpointViaTunnel`；gateway：`verifyGatewayRuntimeIdentity`→`boundedGatewayRequest`），provider 若忽略 signal 仍只会跑到自己的超时。该期限（gateway 35s）**可以长于** `READY_TIMEOUT_MS`（10s，只管端口/可达性）：一个慢但成功的复合复验不应被 ready 期限杀掉；若失败，重试路径照常。gateway 的**口令登录腿**（`ensureSession`）不在 signal 覆盖内：会话管理器只在 `invalidate` 时递增 generation，围栏（`generationIsCurrent`/`verifiedCookieIsCurrent`）能挡住的正是「探针失败后又被外部 invalidate」的迟到登录；一个从未 invalidate 的迟到登录可能完成并写缓存，这是登录腿的已知边界（它不写注册态，下一次探针会重新判定）。
25. 每连接 agent 池已有**真实 socket** 用例（同连接复用、两条连接各自成池、替换/注销后新开连接）；auth 恢复有驱动器级组装用例（见 §6.15）；veth+netem 真实链路验收已入库（13 项断言 + opt-in 上传 3 项，含「宽限期内恢复不重连」「reverifyAll 在 ready+down 上 <1.5s 恢复」「20MB@2Mbit 上传期间不判 down」），但真实 WAN/ssh 中继与真机睡眠仍只能人工跑。
26. `dsh-api-gateway` 的 opening 拒绝后「窗口边缘一次替换」只有代码路径与短窗口用例（mux-self-heal 覆盖替换/防抖/帧增量刷新），没有 60s **真时钟**用例：真实窗口长度由 `dsh-stream-state` 的 reducer 表决定，测试用注入时钟覆盖该表。**2026-10 修订**：lane 腿已移出延迟替换（§3.6），新增 300s 虚拟时钟回归用例证明“lane 拒绝不排期”，并新增一条证据型拒绝（opening 期限 → 窗口边缘替换）的**注入时钟完整窗口**用例（仍无真时钟/真机用例）；证据腿的真机 soak 仍开放。
27. **lane 拒绝不排期后的取舍（2026-10）**：半开载波的兜底从“窗口边必补一次”变为“证据腿之一”——30s 开帧期限（零帧 ⇒ `socketNoFrame`）与 15s 静默 teardown（握手期限不在此列：pre-OPEN 的失败走 non-OPEN bypass 或泵的 maintain 退避，见 §3.6）；最坏多等一个证据预算（合成时序探针 +≈28s；该探针未入库，仓内可复核的只有注入时钟下的窗口边用例与表值上界 30s/15s），之后立即或下一窗口边缘替换，未发现永久恢复洞。“已 ready 后静默、且没有新流”的偶发自愈不在载波层：它由渲染器聚合臂的 staleness 常量兜底（http ≈120s / ssh ≈300s，`packages/renderer/src/aggregate-refresh.ts` 的 `AGGREGATE_RECONNECT_HTTP_STALE_MS`/`..._SSH_STALE_MS`；design 14 §D4 把这形态记为传输层看门狗），本改动不改变它。该兜底有前置：源 **`mounted`**（本代际至少 push 过一次）、transport ∈ {http, ssh} 且非 local（`reconnectStalenessMsForTransport`/`shouldReconnectStaleMounted`）；`mounted=false` 或 local/unknown 的源没有载波级自动恢复，恢复 = 下一次新流的 30s 证据或消费者动作（用户可见面 = 未打开会话），登记为该条的窄边界。**已知边界（边界赛跑，不是“必漏”）**：`SILENT_TEARDOWN_MIN_MS`（15s）与本地/unknown 的 `generationReadyTimeoutMs`（15s）同值，teardown 判定是 `Date.now() − sentAt`，而 `sentAt` 在握手之后才打 ⇒ readiness 超时中止时该差值 `= 15000 − 握手时延`。虚拟钟下第二轮（socket 已 OPEN、同毫秒）必过；真机取决于定时器迟到是否 ≥ open 发送延迟，**不保证**。登记为开放项，本次不改阈值（改值可做但会扩大“短命零帧”的误判面）。

**被否方案（预算账本的口径）**：

- **恢复逐行增量账本**（每行 `+N/−M` 复算）：结构切分后同一行的增量跨多个提交，逐字复算不再可行，账本会与 `--report` 的实测值打架。
- **只许下调 `target`、不许上调**：会把「已登记为有意保留的边界」逼回一个永远达不到的目标，读者继续按目标找行数，反而失真。
- **由门禁自动推导 `target`**：`target` 是评审判定（拆到哪一层为止），机器推不出来；门禁只能校验形状（`lines` 不升、ceiling 的 target > lines）。

选：`lines` 仍只降不升，`target` 上调必须在 `note` 写出理由（本轮 38 条里只有 App 与 host-assembly 两行上调，其余下行或不动）。

## 7. 测试与门禁

- `desktop/transport-health`：link reducer 单测（suspect/down/可达失败 10s 节奏/NaN/恢复）。
- `desktop`：suspect 不累积可达失败、两次 down + 确认窗（测试用短窗 override；生产 30s 由 LINK_POLICY 字面量钉住）、resume/online 复验、reverifyAll 与 online 波次 120ms 错峰、**bind 重分配**（stderr 命中 → 换端口、retryAttempt 不增、第 4 次回退阶梯）、探针复合预算（ready 与 connect 两处 + provider 35s/5s 断言）、**失败驱动强制探针**（节流/仅 healthy/避开 busy/非 ready no-op）、**心跳两级**（ready 后 10s 观察窗 → 稳定档；相邻两拍 180–700ms 判别两档）、**探针取消与链续接**（期限到点的 abort 发生在相位仍 ready 时；in-flight tick 之后心跳链继续）、grace 重开、busy 抑制、linkEpoch 三点、SSH argv、registration key 对象签名/health-only 决策/分隔符碰撞、auth 恢复决策（纯函数）、驱动器（注入时钟的节流/延迟/取消）与恢复守卫（五轴 fail-closed）、口令会话 proof 在瞬时失败后恢复。
  代理注册层的「单次失败不 unregister」**没有组装态用例**（host-assembly 无 fake plane+sm 测试）：manager 层的 status 单测只能证明失败只到 suspect；proof 恢复把该路径在 provider 层钉住（见 §6.15）。
- `dsh-stream-state`：流表/Swift parity 保持不变（本设计不改其表）；本设计新增的 `REBUILD_REASON_KIND` + `isEvidenceBackedRebuild`（§4）由 `test/carrier/carrier-lifecycle.test.ts` 的逐 reason 分类用例与 tsc 的穷尽 Record 双重钉住。
- `control-plane`：suspect 转发（含 suspect 下新订阅可成立）/down 503 与既有同形/health 不 revoke、body-less 与未完成体都不带 after-body、上传 idle 与预算、wire 预算排序不变量、bulk 上传的 busy 事实（≥256KiB 置位、小体不置位、结束即清）、**上游失败缝**（socket 错误、mid-body RST 与“头已到但体停流”通知一次；完整 HTTP 应答与客户端 abort 从不通知）、**下游字节的 busy 窗口**（流中为真、窗口到期为假）、**每连接池真实 socket 复用/销毁**、**page-channel 下行并入同一窗口**（每 chunk 一次、带 connectionId）。
- `renderer`：page-channel 既有阶梯/握手/信用测试 + link epoch/初始 park/错峰释放（含 18 条 > 16 槽的轮转与“epoch 不清阶梯”）。
- `dsh-client-connection`（vendor fork）：502/504 + after-body ⇒「可能已生效」分类文案；无 mark/非 JSON/超长体（边读边判 4KiB 上限）保持原 transport 文案。
- `desktop/transport-identity`：raw id ⇄ connectionId 的换算 + 两个 seam 适配器（manager ⇄ plane 双向，含连字符 id 与畸形 id）。
- `desktop/gateway-provider`：abort 的探测归类（`boundedGatewayRequest` → network、`timedOut=false`；`verifyGatewayRuntimeIdentity` → 非终态 network failure）。
- `dsh-api-gateway`：mux self-heal 用例（非 OPEN bypass + `carrier-rebuild-bypass` 取证 + **lane 拒绝不排期（300s 虚拟时钟回归）** + **证据型拒绝仍在窗口边缘替换一次（60s 注入时钟）** + 防抖）；opening/teardown 证据腿的真机 soak 仍开放（见 §6.26/§6.27）。
- **veth+netem 真实链路验收**（`pnpm run acceptance:netem`，root+CAP_NET_ADMIN，不入 CI，13 项断言 + opt-in 上传 3 项）：300ms RTT+2% 丢包下 ready、never down、heals；黑洞 → suspect → down 且相位在宽限期内保持 ready；宽限期内强制探针恢复**且相位历史无 connecting**；超宽限期离 ready 且**距观测到的 down 边沿 ≥ 2.5s**（实测 3005ms vs grace 3000ms）；恢复后重连成功；`reverifyAll`（OS resume/online）在 ready+down 上 **<1.5s** 恢复（周期节奏为 5s，故只可能来自强制 seam）；**opt-in `NETEM_BULK_UPLOAD=1`**：20MB@2mbit 经真实实例代理完成、busy 窗口观测为真、上传期间链路从不判 down（manager 的 `linkBusy` 即生产接线）。真实 WAN/ssh 中继与真机睡眠仍需一次人工确认。

## 8. Rejected alternatives

- **只调大超时**：长期占槽、恢复更慢、掩盖故障；拒绝。
- **新建 dsh-network-policy 包 / 复制流表**：双源且 Swift parity 需跟着改；拒绝，
  链路阈值留在 desktop-only `transport-health.ts`。
- **完整 SourceLinkStore/第四套重试**：重复现有 owner；拒绝，选择器 + epoch。
- **$events 软重试**：ready 去重/clientId 绑定/宿主 boot 身份未解决；推迟。
- **PinnedAgent**：逐 socket pin 门未证明，复用 socket 会绕过/悬挂；拒绝。
- **FrameTap/代理代答 pong**：协议层风险且非所有 family 有 keepalive；拒绝。
- **官方 RPC 进 4 槽预算**：会饿死交互，且官方不读 transport.fetch；拒绝。
- **通用 OperationLedger**：宿主无幂等键，只能记 unknown；拒绝，仅分类。
- **新 503 码**：四类既有分类器只认 instance_unavailable；拒绝。
- **改 phase 五值**：打穿 host-assembly/transport-reconnect/renderer；拒绝。
- **mutation unknown 用排除法**（不在读白名单即 mutation）：读面远大于白名单，
  `gitWorktree/snapshot` 这类读会被标成“可能已执行”；改为 opt-in 表 + 调用点声明。
- **客户端预算继续独立推导**：两侧各写一份公式已破过一次不等式；改为 wire 契约单源。
- **5s 确认窗**：与设计自己列出的 10–30s 黑洞尺度不符，15s 就拆掉可自愈的隧道；
  30s 窗 + 探针驱动的恢复是同一复杂度下的更优取值。
- **down 边沿失败页面订阅**：让确认窗对页面完全空转；失败改在 teardown 边沿。
- **按连接销毁 agent 池之外再在 health=down 时清池**：会杀掉确认窗内在途上传的
  上游 socket，与“grace 保护在途”直接冲突；只在 unregister/替换处销毁。
- **为 header 已写出后的 mutation 缓存整个响应体再转发**：改变了所有非 SSE 响应的
  首字节语义与内存预算；改为客户端把截断响应归为 unknown。
- **心跳降到 10s 来提速发现**：把周期成本换成 3–6 倍探针流量，且对「有流量但
  半开」并不更准；改为「30s 稳定档 + 事件后 120s 的 10s 观察窗 + 真实请求失败即强制
  一次探针」（有证据才付费，盲窗只在零流量时存在）。
- **把 ssh keepalive 调快到 15s 来加速零流量发现**：ssh 进程死亡是破坏性判定，黑洞
  自愈会因此被重连；改为非破坏性的 HTTP 探针分级（suspect → down → 30s 确认窗）。
- **用 epoch 变化清零订阅阶梯**：flapping 链路会把退避反复打回 3s；改为 epoch 只唤醒、
  阶梯跨 epoch 继续爬升，30s 稳定窗才归零。
- **registration key 继续用五个位置参数**：五个字符串互换在类型上合法，会把真实重注册
  静默变成 health-only；改为对象签名，位置错误变成类型错误。
- **给 lane 拒绝也排一次延迟替换**（旧形态）：把“每窗口最多一次重建”的上限变成 60s
  排期；每次排期执行都杀掉新 socket 上活着的代际，制造下一次 lane 拒绝，健康载波上形成
  一分钟一次重建（真实模块 + 生产退避复现为 5 次/5 分钟，socket 寿命恒 60000ms）。拒绝。
- **把“证据 vs 启发式”的分类留在执行器**（denylist）：看似只动 fork 一行，但把共享包的
  判定搬进执行器，违反 design 14 §D4 ① 与 `dsh-stream-state` 的“消费方不得自带策略”；
  且 denylist 对**未来新增的启发式 reason** 是 fail-open（会静默复发同类节拍器）。改为
  `dsh-stream-state` 的模块内穷尽表（`REBUILD_REASON_KIND`）+ 导出谓词
  `isEvidenceBackedRebuild`（新 reason 不分类即编译失败），执行器只剩一行判定。
- **用帧增量单独判“载波健康”并据此跳过/强制重试**（例如 arm 时 `socketFrames > 0`）：
  arm 时新 socket 恰好 0 帧（generation source 在 sink 之后才 open），production 时序下与
  旧形态逐项相同；若挪到到期点单独判，又会按“30s 前有过 ready 帧”误判静默载波。拒绝。
  （实现保留的是另一件事：parked 期间到达的帧作为 **fresh delta 交给 reducer 观察**
  （`framesAtArm`/`arrivedWhileParked`/`freshFrames`），由 `delivered` 判定决定是否
  `silent-not-proven`，那是既有语义，不是本方案的健康判据。）
- **用 `phase === 'silent'` 判静默**：reducer 没有任何事件写入 `'silent'`（`carrier.ts`
  里唯一提到它的分支只会 silent→open），OPEN 的静默 socket 仍是 `'open'`，等价于“窗口边一律不重试”，会吞掉
  证据型替换（实测把真死载波的重建从 91s 推到 96.6s）。拒绝。
- **把重试原因（timeout/lost/manual）下传到载波层**：就绪超时不是载波证据（慢宿主同样
  超时）；pending retry 只在新 socket open 时被清、generation 恢复不清，超时后宿主变 ready
  仍会在边缘重建健康 socket——把同一类假阳性换个成因，且要跨 fork 改公开类型。拒绝
  （若将来要做，先做“generation ready 取消 pending retry”）。
- **让官方 unary 自动重试 after-body 失败**：官方链路本来无重试，且重试会复制 mutation；
  只在 fork 侧把该 502/504 分类成「可能已生效」，不改重试语义。
