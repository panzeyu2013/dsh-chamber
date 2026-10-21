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
- **I3** `suspect` 正常转发；只有 `down` 快速失败（沿用
  `instance_unavailable`）；health 更新绝不 re-register/revoke。
- **I4** 页面通道只在 link epoch 变化时清 timer/阶位并立即重订阅；普通
  `ready` 保留 30s 稳定窗，避免 flapping 热循环。
- **I5** 复用现有 `RemoteStream`/mux 重试道；v1 **不**新增 `$events` 软重试。
- **I6** 链路阈值在 desktop-only 的 `transport-health.ts`（唯一消费者是
  transport-manager）；代理超时留在 `proxy-forward.ts`；不建共享策略包、不改
  `dsh-stream-state` 的流表。
- **I7** mutation 不自动重试；body 已发出后的超时返回 `details.phase=after-body`，
  客户端映射 `MutationOutcomeUnknownError`。
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

旧 renderer/bridge/shim 缺省按 `healthy` 处理。

### 3.2 探测策略（LINK_POLICY）

- 一次网络失败（timeout/DNS/TCP/TLS）→ `suspect`，2s 后重探，不杀链；
- 连续第二次 → `down`，进入既有 reconnect；`nextProbeDelayMs=null`；
- 5xx/408/425/429 → `server`（可达、繁忙），401 → `auth`（可达，provider
  自行 re-auth 一次），都不计入网络失败；
- 403/404/身份不匹配/协议错误 → `protocol` terminal；
- 成功显式清空 streak；只有 down→healthy 才 `linkEpoch++`（新可用世代），
  suspect→healthy 不递增 epoch，避免每次探针抖动重置 30s 稳定窗；
- `resume`/`online` 对 `ready` 也强制一次复验，绕过用户 10s 静默窗；
- `reverifyAll` 按 120ms/实例错峰，60s 心跳加 ±10% jitter；
- 连续两次网络失败进入 down 后保留 `downGraceMs`（默认 5s）ready 确认窗，
  窗内继续按 suspect 节奏探针；恢复即取消 grace，窗满仍 down 才交给 reconnect；
- forced resume/online 探针若撞上 in-flight 探针，会在其 settle 后补跑一次。

### 3.3 代理 health

`registerInstanceTransport(..., { health })` + `setInstanceTransportHealth`。
`suspect` 不改变转发；`down` 新请求 503 `instance_unavailable`，并把该
connectionId 已建立的 page-channel 订阅以同一错误 fail（半开 SSE 没有第二
路径可失败）。desktop 在 down 后保留 `ready` 一个 `downGraceMs`（默认 5s）
确认窗：期间 health-only 更新不 revoke 在途；窗满仍 down 才进入既有
reconnect，phase 离开 ready 时 unregister 并 revoke。撤销时若请求 body 已
完成，代理先写 502 `upstream_failed` + `details.phase='after-body'` 再结束
响应，避免客户端拿到裸网络错误而误重试。超过 grace 的在途仍由 reconnect
收尾——这不是无限期保护。registration key 只在
url/transport/auth 指纹/pin/authority 变化时触发 re-register。

### 3.4 上传

- 请求体仍整体缓冲（v1 不改流式）；
- 体传输使用 `uploadTotalBudgetMs = clamp(max(60s, bytes/128KiB/s), 60s, 30min)`
  + `uploadIdleMs=30s`（按 socket write/drain 进度重置）；
- header/idle 计时在 `finish` 之后才启动；
- `x-chamber-rpc-budget-ms` 不进 v1；长路径继续走 `LONG_RPC_PATHS`。

### 3.5 Mutation unknown

代理在 body 已完整发出后超时/上游连接失败，返回 504 `upstream_timeout`
或 502 `upstream_failed` + `details:{phase:'after-body'}`；`instance-api`
对 mutation 抛 `MutationOutcomeUnknownError`，调用方不得自动重试（读接口
不受影响）。

### 3.6 页面通道恢复与载波 throttle

- `linkEpoch` 变化时清掉订阅阶梯、重订阅；同一 source 的等待订阅按
  首个立即、其余 120ms/槽（最多 16 槽）错峰释放，避免恢复瞬间风暴。
- 载波 socket 已 closed 时绕过 60s rebuild 窗；socket 仍 open 但 reducer
  拒绝 rebuild 时，只在窗口/间距到期点做**一次**延迟替换，随后交给下一次
  真实边沿；拒绝本身仍先 `reopenLogicalStream`，不留空转。

## 4. 模块落点

| 模块 | 变更 |
|---|---|
| `packages/desktop/transport-health` | `LINK_POLICY`、纯 health reducer/probe 分类、单测；desktop 唯一阈值 owner |
| `packages/desktop/transport-manager` | health 子态、two-failure down、success clear、resume/online、`reverifyAll`、bind-race 重分配、5xx transient |
| `packages/desktop/transport-provider` | `link` 投影与 `failureKind` |
| `packages/desktop/ssh-provider/gateway-provider` | failureKind 分类；SSH `ConnectTimeout`/`ExitOnForwardFailure` |
| `packages/desktop/host-assembly` | registration key；health-only `setInstanceTransportHealth`；不 re-register |
| `packages/desktop/transport-registration` | 纯 registration key/fingerprint/decision 单测，锁住 health-only 边沿 |
| `packages/control-plane/instance-proxy` | health 记录/快速失败；`setInstanceTransportHealth` |
| `packages/control-plane/proxy-forward` | 上传总预算/IDLE、keep-alive agents、after-body details |
| `packages/dsh-chamber-client-core` | page-channel link selector/epoch 重置/等待/错峰释放；`MutationOutcomeUnknownError` |
| `packages/dsh-api-gateway` | closed socket 绕过 rebuild 窗；denied 到期一次延迟替换；内部 carrier 事件（不发 wire） |
| `packages/renderer` | `configurePageChannelLink`、online 重验、`reverify(id,reason)` |

## 5. 明确不做（v1）

- 不新增 `dsh-network-policy` 包；链路阈值放 desktop-only `transport-health.ts`，
  不复制 `dsh-stream-state` 的流表。
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
8. 35s `requestTimeout` 是下游接收时限；慢上传测试需在真机确认，不改无证据的时限。
9. down grace 默认 5s；超过该窗的在途仍会被 reconnect revoke（不是无限期保护）。
10. page-channel 的 down 现在会 fail 已建立订阅；但“尚未判 down 的半开”仍无服务端 idle watchdog（pluginGraph 无 keepalive 契约），只能靠探针/重订阅收敛。
11. mutation 客户端预算按 body 大小推导（50s 起，最高 31min，留 60s 余量），覆盖目标 20MB 级慢上传；超过代理 30min+45s 窗口的 body 才可能先被客户端 abort。
12. `reverifyAll` 已按 120ms/实例错峰、60s 心跳已加 10% jitter；仍未对连接尝试本身做全局配额。
13. 只有 down→healthy 才 bump `linkEpoch`（suspect→healthy 已不 bump）；down 恢复仍会让页面通道立即重置，这是“恢复即唤醒”与“30s 稳定窗防抖”的取舍。
14. manager 的兜底分类现在会从 detail 的 `HTTP nnn` 取 statusCode；但 provider 仍各自判定 5xx/401，规则存在双写风险。
15. host-assembly 只有 registration decision 纯函数单测，没有 fake plane+sm 的组装态测试。

## 7. 测试与门禁

- `desktop/transport-health`：link reducer 单测（suspect/down/可达失败/NaN/恢复）。
- `desktop`：单次失败不 unregister、两次 down + down grace、5xx/HTTP status transient、resume/online 复验、reverifyAll 错峰、bind 重分配、SSH argv、registration key/health-only 决策。
- `dsh-stream-state`：流表/ Swift parity 保持不变（本设计不改其表）。
- `control-plane`：suspect 转发/down 503/health 不 revoke、上传预算、proxies 既有 timeout 套件。
- `renderer`：page-channel 既有阶梯/握手/信用测试 + link epoch/初始 park/错峰释放行为用例。
- `dsh-api-gateway`：mux self-heal 23 用例（closed bypass + denied 到期一次替换 + 非 OPEN 连发防抖）。
- 实机：netem 100/300ms、1/5% 丢包、10s 黑洞、20s flap、20MB@2Mbps 上传、睡眠/切网。

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
