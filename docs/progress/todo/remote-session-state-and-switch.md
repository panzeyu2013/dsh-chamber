# todo · 远程来源会话状态与切源体验（彻底修复）

> 状态：方案（未实现、未排期）。记录于 2026-12；根因经三轮复核，外部对照为 Codex app-server 调研。
> 锚定版本：`v0.4.0-beta.1`——本次**允许破坏性变更**，落地即冻结；其后 0.4.x 只做加法，
> 且**网关与桌面允许版本不同**（能力协商 + 优雅降级，不要求版本相等）。
> 关联：design 05 §2.2.1/§4/§4.2/§9、design 06 §4/§5/§8、design 17 §10、design 19 §3.5/§3.7、
> design 24 §12；STATUS 第 18/173/222/386/388 行；`todo/upstream-proposals.md` §1。

## 0. 「彻底」的判据（全部可验证，缺一不算完成）

1. 关掉桌面全部远端壳后，**gateway-SSE 可见来源**的 running / waiting / 完成状态 ≤2s 正确反映；SSH/polling 档按 30s 基线另立判据（不得混用）。
2. 桌面关闭期间发生的完成，下次启动即呈现为未读（不补发通知，见 §5-6）。
3. 应用重启、壳崩溃重挂、同代重挂、保留策略回收：未读不丢、不假——**含落盘**（仓内今天没有任何未读持久化，零命中；`App.tsx:4148-4153` 明说重载即复位）。
4. 行尾蓝点、会话待办、通知三面同源；Dock 徽标以**合并投影**为输入（新增裁决 14）。与 `design 19:366-378` 已登记的两处诚实分叉一并重裁，落地时同步更新设计文档。
5. 切到任何**已打开过**的 server 不出现无内容白屏帧；首次进入有主题化进度面（不是纯白）。
6. 等待批准 / 提问（pending）在无壳时仍可见、可待办。
7. 桌面与网关版本偏斜（旧网关 / 新网关）下不劣化；混合升级的多 server 各自独立正确。
8. 每条已发现残留都有闭合路径与判据（§8），不以「接受」结案；**确实未闭合者（R15②③、R16①）单列「未闭合」小节并标注阻塞原因**，不得混在已闭合项里。

## 1. 症状 → 根因（证据）

| 症状 | 机制 | 证据 |
|---|---|---|
| 远程完成不推送待办/蓝点 | 完成事实只来自挂载壳的 runtime-facts 通道；壳被回收即撤回并删账本 | `App.tsx:3932-3971`、`retention.ts:39,42,45,83`、`client/index.ts:632-642` |
| 指示器从运行环直接变普通 | 环只信聚合 wire（刻意忽略通道），完成点只信通道 | `derive.ts:868`、`ServerSection.tsx:383,395`、`todo-attention.ts:110-117` |
| 「有概率」 | 需 ≥2 个隐藏非 local 壳才触发回收；同窗预热壳先被牺牲 | `retention.ts:83`（`decideReclaimCandidates`） |
| Dock 徽标 / 通知同丢 | 同一边沿（`completedBySource` / `prevRuntimeFactsRef`） | `App.tsx:3980`、`notification-edges.ts:28,71`、`badge-count.ts:55` |
| 重开不恢复 | 官方完成提醒为内存态，首见只播种 | `dsh-api-session-controller/.../manager.js:30-32,376-377,779-791` |
| 切 server 白屏 | 目标壳未挂载 → 冷 boot 全屏遮罩；底色取文档调色板（默认白，跟随上一活动视图） | `packages/renderer/src/components/InstanceView.tsx:401,447-461`、`styles.css:107,224-231`、`document-theme.ts:19-27`、design 05:784 |
| pending 同丢 | pending 只在通道投影（官方 ui-session 注册表） | `derive.ts:589-592`、`todo-attention.ts:87-90` |
| 已武装蓝点被销毁 | 同代重挂注册即广播撤回，撤回分支删账本 | `aggregate-store.ts:793-796`、`App.tsx:3953-3971` |

## 2. 已发现的问题（现方案为何不足）

1. 依赖挂载壳保活 = 以常驻换正确性：压力仍在客户端，且只覆盖「已打开过」的来源。
2. 未挂载来源的完成只能靠轮询推导，而 design 06 §5（`:597-602`）已否决「轮询级完成推导」——本方案在 gateway-SSE 档用事件订阅绕开；SSH/polling 档明确沿用 30s 基线（`App.tsx:208`），其判据不得写 ≤2s。
3. 摘要 `updatedAt` 的唯一写入器是 `sessionListMetadata.lastPromptAt`，且只在 `user/message && data.source.kind===user` 时推进（`dsh-api-session-controller/lib/index.js:1749-1754,1969-1971`）；实机双采样（126s、+11 steps、`updatedAt` 不变）确认 agent 产出不推进水位 ⇒ 按 §3.1 的 B 轨落地；`updatedAt` 只作未读次要信号与 pin 升级回归点。
4. 多事实源（壳通道 / 服务端观察 / 聚合轮询）若无单调水位合并，会重新引入双权威。
5. `listPhase` 初值 pending、仅在首次列表成功时置 ready、出错不回退（`manager.js:41,387`）：可防误剪，不能清幽灵。
6. `api-session/status` 只有 running 位，手动停止与完成不可区分（持久化后会放大为持久误报）。
7. 全量预载会放大远端 blank 会话创建（STATUS:388）与主线程压力（design 05 §9 已把多壳常驻列为需先有度量面的推迟项）。
8. 白屏是视图冷启动问题，与状态事实是两条轨道：watcher 不修白屏。

## 3. 目标架构

### 3.1 决策门（W0 实测已定轨：B 边沿轨）

| 轨道 | 条件 | 完成事实来源 | 影响的残留 |
|---|---|---|---|
| **B 边沿轨（默认，已实测）** | `updatedAt` 不随 agent 产出推进——`updatedAt = max(createdAt, sessionListMetadata.lastPromptAt)`，仅 `user/message(source.kind=user)` 推进（`dsh-api-session-controller/lib/index.js:1749-1754,1969-1971`）；实机双采样 126s / +11 steps 水位不变 | watcher 订阅 `$events` 的 `api-session/status` 边沿，true→false 时为该会话读一次 `turn/end.reason` ⇒ `{completedAt, lastTurnEnd}` | 完成类需观察者；R12 由 `reason.kind===aborted && cause===user` 直接闭合，不再需要「自停标记已读」 |
| **A 水位轨（备用）** | 摘要 `updatedAt` 随任意 durable 产出推进（当前 pin **不成立**；仅在 W7-① 被采纳或 pin 升级后重评） | `session.list`（轮询/SSE）即可 | 若成立，R1/R3/R9/R11/R12 可省观察者 |

> 两支都需要 watcher 的地方：pending（R5）、行刷新（R9）、跨端读水位（R10）、turn-end 分类（R12）。
> 当前 pin 实测为 B；A 是「上游若改 `updatedAt` 语义」的省观察者分支，本次不落地。
### 3.2 架构

```
[远端 gateway 进程]                                [桌面]
  dsh host ──本地 HTTP/WS──► session-state watcher
                                │ 状态机 + JSONL/快照 + 缺口重建
                                ▼
            GET  /chamber/session-state         ──► SessionFactsSource(gateway-sse)
            GET  /chamber/session-state/stream  ──► │
            POST /chamber/session-state/read    ──► │  未读判定（host 时钟域）：
[聚合 unary 轮询（行权威）] ─────────────────────►  │  unread ⟺ max(updatedAt, completedAt) > readMark
[壳通道 runtime-facts（现路径）] ────────────────►  ▼  （边沿轨：completedAt 作触发/回退）
                                                 行 / 待办 / Dock 徽标 / 通知
```

- 未读判定（B 轨）：`unread ⟺ max(updatedAt, completedAt) > readMark`——`updatedAt` 覆盖「他处新增的用户内容」，`completedAt` 覆盖「agent 完成」，且只有 `turn/end.reason===completed` 才置位。
- 行仍只由聚合提供；watcher 只发 `session-*` 变更提示并触发该来源一次 unary。
- 事实源策略化：`SessionFactsSource` 接口，优先级 gateway-SSE ＞ headless 观察者（SSH/旧网关）＞ 聚合轮询（`mode:poll`）。

### 3.3 桌面接线清单（不做就是「假修复」；可执行级细节见 notes/desktop-facts-wiring-blueprint.md）

1. **事实注入投影**：事实派生后进 `mergeRuntimeFacts`（`derive.ts:781-803` 加 overlay/stale 参数）；`todo-attention.ts:78-82` 收 stale；`App.tsx:475-485` 只对未读事实放开 connected 闸。
2. **账本改派生 + 落盘**：`completedBySource` 由 `deriveUnread()`（`App.tsx:4062-4086`）重算；**删掉撤回分支 `App.tsx:3965-3970`**（保留 3962-3964 的易失记忆删除）；新增落盘——仓内**今天没有任何未读持久化**（`dsh-chamber.unread*` 零命中，`App.tsx:4148-4153` 重载即复位），不落盘则判据 3 为空。
3. **通知第二入口（键分层）**：抽 `emitSessionNotification`（`App.tsx:4005-4061`）复用 `notification-edges.ts:28-88`；renderer 键 = `(sourceId, sourceFingerprint, sessionId, kind, 内容水位)`，主进程 claim 键加 `watermark` 且**保留 kind 与 fingerprint**（`packages/desktop/notifications.ts:321`）——只用 (sourceId, sessionId, watermark) 会吞 ask/complete、同 id 换宿主会继承旧 claim。
4. **行刷新提示**：新 `source-refresh-hint.ts`（floor 1s + connected/unverified/inFlight 三拒）→ `refreshAggregate()`；**`runningRingVisible`（`derive.ts:868-870`）不改**，≤2s 环时效由这条达成。
5. **读动作写标记**：`unread.ts` 的 `advanceReadMark` + `focus/blur` 监听（今天没有）；「正在阅读」谓词必须含 `document.hasFocus()`（对 `App.tsx:4075` 的行为变更：失焦完成会亮蓝点，需登记）；落盘 ≤1/s + `ackRead`。
6. **降级路径**：`planFactsMode` 探测 `/api/i/<id>/chamber/session-state`；`factsMode`/`factsDegraded` 进 entry 与投影签名，侧栏自写文案（`bootGap` 先例）——不劣化且有可见提示。
7. **徽标输入裁决**：`badge-count.ts:6-8,55-70` 现只投影 App 账本 → 改为读**合并投影**，否则判据 4 不成立（`design 19:366-371` 的既有取舍随之更新）。
8. **边界登记**：新只读路由须在 design 17 §10 补被否方案一节（`design 17:672-679` 明文禁止编排面回流），否则 review 可拒。
## 4. 协议（v0.4.0 起冻结；0.4.x 只做加法）

- `GET /chamber/session-state` → `{ protocol:1, features:[...], cursor, sessions[], read }`。
  每行：`sessionId / running / pendingKind / subagentCount / updatedAt / completedAt / completedAtSource / lastRunningAt`。
- `GET /chamber/session-state/stream` → SSE 增量，`id:` 单调事件号，续传用 `Last-Event-ID`（**心跳事件不得带 `id:`**）；游标过期/超前 ⇒ 客户端整量重取快照；delta 需携带 `read`，否则 R10 跨端已读不收敛。
- `POST /chamber/session-state/read` 与 `/read-all` → 幂等 upsert、**只升不降**；`/read-all` 用**客户端 `through` 水位 + 来源 floor**（迟到行也判已读，闭合 R13），不接受服务端「取当下最大」。
- **`completedAtSource: observed | reconstructed`**：`reconstructed`（缺口重建出来的）只出未读、**不发通知**——这是 §5-5「离线完成不补通知」的实现前提。
- 能力探测（**只有 404 才是版本事实**）：404 ⇒ `legacy-gateway`（走现状路径）；503 `session_state_disabled` ⇒ `disabled`；有响应但无 `protocol` ⇒ `unversioned`；5xx/超时 ⇒ `unavailable`（**启动中的网关不得被判成「未升级」**）；`features[]` 缺项 ⇒ `forward-skew`（按缺失项降级）；全绿 ⇒ `ok`。响应 `mode` 区分 sse/poll。
- 路由挂在既有 `/chamber/*` auth 门内（`packages/gateway/src/routes.ts`）；不新增鉴权面。
- **host 停机语义**：三条路由仍返回 200 且 `serviceable:false`（不 5xx，避免桌面把停机误判成「未升级」）。
- **常量单一源**：`packages/control-plane/src/session-state-protocol.ts`（沿用 `gateway-session-protocol.ts` 的跨形态模式）；桌面**不能**从 node_modules 导入 workspace 包（`packages/desktop/control-plane-module.ts:1-12`），必须同 PR 经该 facade 再导出。
- **dsh pin 锁步**：构建期读 vendor 的 `API_REMOTE_FORWARDED_EVENTS` 做 fail-loud 锁步（与 sidebar 既有 vendor 测试同款 opt-out）；运行期 5s 握手失败 ⇒ `mode:poll` + `dsh-events-absent`，不留半订阅行。
- **观察者纪律（硬约束）**：watcher 经 `$events` 会成为 `approval/request` / `user-questions/request` waterfall 的交付目标（`dsh-api-gateway/lib/index.js:630,678,683,712`）——静默会挂起等待中的批准，无条件回 `next` 又会在无壳时把它判成 `unavailable`。规则：**仅当另有下游 mux 客户端在线**（`gateway-proxy.getDiagnostics().activeStreams > 0`）**且过 1.5s grace 才回 `next` 委派，否则保持等待（不 settle）**；写成契约测试 + W1 实机判据。
- **完成边沿取数形状**：`api-session/status` true→false 时为该会话开**一次** `session/follow` 读尾部 `turn/end`，随即关闭——不常驻 N 条 follow 流。
- **不要用 `session/control` 当 pending 源**：baseline 只有 `{queues,jobs,projections}`，且实测 301 帧/25s 的投影洪流。
- **（重）连必须对账**：emit 型事件无重传、`$events` 开场帧不重放会话状态（`upstream-proposals.md:66-69`）⇒ 每次重连做一次全量 `session/list` 基线对账；周期性对账是**正确性组件**，不是优化。
- **数据模型**：watcher 状态文件每会话 `{ running, pendingKind?, subagentCount?, updatedAt, lastRunningAt, completedAt?, completedAtSource, lastTurnEnd?: { kind, cause?, at, seq } }` + 单调 `cursor`；读标记 `{ clientId, sessionId, readThrough }`（单调完成游标；**key 不含 sourceId**——单网关即单来源，判定按来源内 effective max 以支撑跨端同步）。
- **client-install id**：桌面首启生成一次并登记（localStorage + 服务端）；重装即新 id（旧标记由服务端 TTL 清理）。
- **持久化格式**：`<stateDir>/session-state/state.json`（0600/0700，`createJsonStore` 的 corrupt≠空语义）；**不落 JSONL**，只保留内存 ring，重启靠基线对账重建。
- **WS 客户端落点**：`packages/control-plane/src/session-mux.ts`（`ws` 已是该包依赖，避免给 gateway 加 manifest 边）。
- **时钟无关**：读标记用单调完成游标（`readThrough`），不可得时用快照 host `now`；**不使用客户端墙钟**，跨机偏斜不成立。
- **版本标识**：`protocol`（本接口）独立于产品版本；`features[]` 表能力；产品版本偏斜由能力协商兜底。
- 隐私与安全：只存状态元数据，**不存标题/cwd/消息/批准与提问载荷**；日志脱敏；状态文件按用户目录权限落盘。
## 5. 裁决（按行业规范，不再留开放项）

| # | 裁决 | 依据 |
|---|---|---|
| 1 | gateway 新增**只读**会话状态投影服务（非执行面；gateway 仍非 dsh 事实权威，只镜像 host 事件） | VS Code Remote 服务端权威 / Codex app-server 订阅模型 |
| 2 | 事实源策略化 + 优先级；壳通道退为观察者之一 | LSP capabilities / DevTools 协议式能力协商 |
| 3 | 未读判定（B 轨）：`unread ⟺ max(updatedAt, completedAt) > readMark`；`completedAt` 只在 `turn/end.reason===completed` 时置位（aborted+user 不置、其余中立） | W0 实测；两个信号分别覆盖「他处新内容」与「agent 完成」 |
| 4 | 读标记**存储按 client-install、判定按来源取 max**（否则 R10「手机读掉桌面即灭」不成立）；本地缓存兜底 | 已读服务端化 + 多端一致的行业做法 |
| 5 | 离线期间完成**不回补通知**，只呈现未读；提供可选的启动聚合摘要 | 通知不伪造「刚发生」 |
| 6 | REST 快照 + SSE 增量 + Last-Event-ID 续传 + 事件游标 | 只读事实流标准；控制面已支持 SSE 透传 |
| 7 | 版本偏斜靠能力协商 + 优雅降级；0.4.x 只做加法 | semver + capabilities 共识 |
| 8 | 不做全量预载；白屏优先「延迟揭示 + 意图预热」，温壳档位仅在实测支持时开到 2 | VS Code 工作集 / Codex 不预热 |
| 9 | 度量口径改为分档预算：每壳 DOM + p95 帧时/长任务/堆，取代单一「全页 DOM ≤13,000」 | 性能预算实践（p95/长任务而非节点总数） |
| 10 | 待办区新增「标记全部已读」显式出口 | 幽灵条目的标准逃生门 |
| 11 | 手机端与 SSH 来源纳入彻底修复范围（见 W5/W6），不留口头承诺 | 目标为无残留 |
| 12 | **W0 已定轨：B 边沿制**（静态+实测双证）；边沿事实升级为 `turn/end.reason`；用户停止 ⇒ aborted+user ⇒ 不置未读；A 水位制保留为上游客改语义后的省观察者分支 | 见 `notes/remote-state-w0-protocol.md` |
| 13 | 读标记用**单调完成游标**（每会话 completion seq），不可得时用快照携带的 host `now`；**禁止客户端墙钟** | 分布式已读状态的标准做法，消除跨机时钟偏斜 |
| 14 | 徽标输入改为**合并投影**（点/待办/徽标/通知四面同源） | 现状分工被 `design 19:366-371` 登记为取舍，与判据 4 冲突 |
| 15 | 「正在阅读」谓词必须含 `document.hasFocus()`（失焦即视为未读） | 与 Slack/GitHub 语义一致；是对 `App.tsx:4075` 的行为变更，需登记 |
| 16 | 主进程通知 claim 键升为 `[sourceId, sourceFingerprint, sessionId, kind, watermark]` | kind 与 fingerprint 必须保留：否则 ask/complete 互吞、同 id 换宿主继承旧 claim |
| 17 | 延迟揭示以**新增 `paintedView` 事实**实现（VT 之外拆分可见性与选中），揭示回调须重验目标 | `view-transition.ts:6-11` 语义决定 VT 单独做不到 |
| 18 | 遮罩主题化走 `document-theme.ts` 的 per-source 快照 cache，**不加 CSS 颜色规则** | 既有钉子测试 `theme-fallback.test.ts:20` 禁止新增颜色回退规则 |
| 19 | **裁决：design 17 §10 开只读 carve-out**——watcher 是只读镜像（不写、不发命令、不成为控制路径、非 dsh 事实权威），须在 §20 补被否方案一节 | 边界扩张必须显式裁决（本仓 review 纪律） |
| 20 | **裁决：走上游提案「observer 角色 + `session/list` 的 pending 投影」**——让只读订阅者不必参与 waterfall、pending 直接可读，从根上消除本方案的瀑布风险面 | 行业做法：把只读订阅者与交互响应者分离 |
## 6. 版本与兼容

- **本次允许的破坏**（落地即冻结）：未读改为**边沿制**（`completedAt` + `lastTurnEnd` 分类）；`InstanceRuntimeReport` 增 `listComplete`；桌面消费路径由「壳权威」改为「事实源优先」。
- **落盘是新建**：`dsh-chamber.unread.v2` 为首次落盘（仓内 `dsh-chamber.unread` / `unread.v1` / `unread.v2` 零命中；`App.tsx:4148-4153` 重载即复位）；**v1 在 HEAD 无写入者**，故 v1→v2 导入按防御代码处理并写明，不做迁移承诺。
- **新面（非破坏）**：`/chamber/session-state*` 全部为新增路由。
- **0.4.x 规则**：只做加法；新能力必须走 `features[]`；任何语义删除/改动进新 minor 并保留一个版本双读。
- **兼容矩阵（进 CI 契约测试）**：新桌面×旧网关、旧桌面×新网关、新桌面×新网关；实现见 `notes/protocol-compat-blueprint.md`（A=HTTP stub + 路由缺席；B=旧客户端调用序列冻结 fixture 在活路由表重放；C=完整集成），无需新增 CI 作业（改各包 `scripts/test.mjs` 即进 `run-checks tests`；Windows 腿须显式进 `WIN32_FILES`）。
- **dsh pin 锁步**：见 §4；升级按 `docs/checklists/dsh-upgrade-checklist.md` 跑；真实双版本验收用 `install-gateway.sh --version`，留发布前人工门。
- **混合升级**：修复按 server 逐个生效；发布说明与验收清单必须按 server 列出已升级/未升级。
- **pin 升级回归门**：`updatedAt` 语义与 `API_REMOTE_FORWARDED_EVENTS` 白名单分别是轨道判定与 pending 可得性的判据来源，pin 升级必须回归这两项（W7-①）。
- **文档落点**：design 17 §10.7 **只读 carve-out**（已落地：只读镜像、不发命令、非事实权威）与 §20 被否方案（已落地；`design 17:672-679` 明文禁止编排面回流）、§11/§12/§20 其余待随实现更新、05 §4/§5、06 §4.3/§4.4、19 §3.5/§3.7；STATUS 记 R17/R18 并更新 :392 的「代际过旧可见提示（未排期）」；CHANGELOG 只在发布时写。
## 7. 里程碑（W0–W7；W0 是决策门，先跑后定架构）

| W | 内容 | 出口判据 |
|---|---|---|
| W0 | **决策门（已定轨）**：① `updatedAt` 不随 agent 产出推进 ⇒ **Track B**（静态+实测双证）② 连接方式=复用控制面既有无鉴权 `/api/i/*` unary + 最小裸 WS mux（`$events` / 按需 `session/follow`）③ pending 可得：两 request 事件在官方转发白名单且对新连接重放 ④ SVG scoper 真机验收 | 轨道选定 + ①②③ 结论落地；**待跑项（真实 waterfall 帧、abort 样本）转 W1 契约测试**；不可得项立即转 W7 |
| W1 | watcher 服务端：状态机（含 `lastTurnEnd`）、持久化、缺口重建、host-down=unknown、三条路由（停机 200 + `serviceable:false`）、契约测试；WS 客户端落 `packages/control-plane/src/session-mux.ts` | 关壳事实仍准；网关重启不丢不乱；host 停机不伪造；**每个完成边沿恰好读一次 `turn/end`**；**`aborted+user` 不产生未读**；**瀑布委派实机判据**（有下游 mux 客户端时委派、无壳时保持等待） |
| W2 | 桌面消费：`SessionFactsSource`、边沿制 + 单调读游标、**账本改派生 + 落盘**、通知第二入口（键分层）、行刷新提示、读标记（含 `hasFocus`）、徽标改合并投影 | 关闭期间完成 → 启动即见未读；四面一致；**双入口单横幅**；**时钟 +1h 零假未读**；**channel-only 四面不回退**；接线锁 L1–L16 与兼容锁（`mergeRuntimeFacts` 两参结果逐字节一致）全绿 |
| W3 | 体验：`paintedView` 延迟揭示（含 7 处语义同步）、`document-theme.ts` per-source 快照 cache、`prewarm-intent.ts`（dwell 120ms、单槽重排 + 计费）、温壳默认 1、**分源选区 hand-off（R16①）** | 三形态白帧判据全绿（`switchFrameVerdict` + screencast Leg B）；首访主题化进度面；**预热命中率 ≥80%**；p95 不劣化 |
| W4 | 出口与仪表：`标记全部已读`、启动聚合摘要（可选，含「是否假报刚发生」判据）、断连未读呈现、`switchFrameMs` / blank 归因（I10）/ 能力一览（R19）/ 摘要仪器、验收脚本 | 残留中 W4 项与仪表 I1–I16 到位并进验收 |
| W5 | 手机端（gateway 服务的移动客户端）接入读水位 | 手机读掉 → 桌面不再亮（反之亦然） |
| W6 | SSH 来源：headless 观察者（桌面侧复用 dsh 客户端半）或 host seed，二选一 | 无壳仍能观察完成；不依赖 gateway 版本 |
| W7 | 上游提案（按价值排序）：① **`updatedAt` 语义**——若上游改为「任意 durable 产出推进」，A 水位轨可复活（当前 pin 不成立，作为 pin 升级回归门）；② **turn-end 语义冻结与转发**——`turn/end.reason` 已存在（`typert.host.js:2056-2057`），请保持稳定契约并考虑纳入 `API_REMOTE_FORWARDED_EVENTS`（现白名单无会话事件，watcher 只能逐会话 `session/follow`）；③ host 持久 unread/pending 事实与事件契约稳定；④ selection 按 shell/入口作用域（消除 blank 会话）；⑤ **observer 角色 + `session/list` 的 pending 投影**（消除 waterfall 参与，§5-20） | 仓内提案文本已落（`notes/../upstream-proposals.md` §6，四项）；**提交/跟踪需外部凭据（GitHub），2026-12 未做——开放项**（见 STATUS）；chamber 侧接口可承接 |
| W8 | 发布门与资产守卫：mobile/gateway 安装 scoper（R15②）、CI 守卫产物含 scoper 标记（R15③）、双版本人工门复核 | mobile committed bundle 含标记（测试锁）+ CI 在 `build:renderer` 后断言产物含标记（缺产物 exit 1）；**真实产物绿与真机判仍未做**（§13.7）；CI 守卫红即阻断发布 |


> 可执行级蓝图见 `docs/progress/todo/notes/`：`protocol-compat-blueprint.md`、`desktop-facts-wiring-blueprint.md`、`switch-experience-blueprint.md`、`gateway-session-state-blueprint.md`、`remote-state-w0-protocol.md`、`residual-verifiability-review.md`（六份全部到位）。
## 8. 残留闭合方案（逐项：方案 / 落点 / 判据；不以「接受」结案）

> W0 已定轨为 **B 边沿制**（§3.1 / §5-12）；下列方案按边沿制给出，A 水位轨仅作 pin 升级后的回归分支。
> 逐条判据改写与仪表清单 I1–I16 见 `notes/residual-verifiability-review.md`；未闭合项与无 W 归属清单见该文 §6.4。

#### R1 壳回收后完成丢失
- 方案：状态事实改由服务端 watcher 产出（事件订阅），与壳是否存在无关；桌面未读由「边沿事实 + 读标记」**派生**，不再依赖壳通道。
- 落点：`packages/gateway/src/session-state.ts`（新）、`routes.ts`、桌面 `SessionFactsSource` 与 `derive.ts` 投影注入。
- 判据：关掉全部远端壳后，完成在 ≤2s 内出现在蓝点/待办/徽标。

#### R2 已武装蓝点被同代重挂/撤回销毁
- 方案：`completedBySource` 由「边沿记忆」改为**派生态**（`deriveUnread(completedAt, lastTurnEnd, readThrough)` 纯函数），撤回分支无需保存账本——删了也会立即重算。
- 落点：`App.tsx:3953-3971` 撤回分支简化、`derive.ts` 新纯函数、接线锁。
- 判据：同代重挂/撤回/崩溃后未读仍在；锁保证「账本不再是唯一来源」。

#### R3 应用关闭期间完成丢失
- 方案：watcher 常驻落盘（JSONL + 快照）；桌面启动拉快照补齐；watcher 自身重启用 `stored.running && !baseline.running` 生成**候选**，每个候选必须再读一次 `turn/end.reason` 分类（`completed` 才置 `completedAt`，`aborted+user` 记用户停止，其余记中立）——否则会把窗口内的手动停止重建成假未读（与 R12 同形）。
- 落点：`session-state.ts` 的持久化/重建 + 分类；桌面启动序列。
- 判据：关闭桌面期间完成 → 启动即见未读、不补发通知；**窗口内手动停止 → 不产生未读**（负断言配正对照）。
#### R4 重启后未读丢失
- 方案：读标记写服务端（`POST /read`、`/read-all`，按 client-install id，幂等，单调游标）；本地缓存兜底；启动按 max 合并。
- 落点：§4 协议、桌面 `dsh-chamber.unread.v2`。
- 判据：桌面重启/重装后未读与服务端一致。

#### R5 pending 无壳时丢失
- 方案：watcher 订阅 `$events` 的 `approval/request`、`user-questions/request`（官方转发白名单 `remote-events.js:14,31`；新连接会被重放 `index.js:598,673,678-682`）派生 `pendingKind`，与浏览器壳同源；**绝不能回 `$events/result`**（会消费掉该审批）。
- 落点：`packages/gateway/src/session-state.ts` observer、协议 `pendingKind`。
- 判据：无任何壳时，等待批准/提问（含解除）在 pending 徽标与待办可见；**观察者存在时审批仍能被正常客户端回答**（被动纪律的契约测试）。
#### R6 撤回窗口通知丢失
#### R6 撤回窗口通知丢失
- 方案：通知边沿接 watcher 实时事实；**键分层统一**——renderer `(sourceId, sourceFingerprint, sessionId, kind, 内容水位)`，主进程 claim 键 `[sourceId, sourceFingerprint, sessionId, kind, watermark]`（与 §3.3-3、§5-16 一致；B 轨 watermark 取 `completedAt` + `lastTurnEnd.kind`）；离线完成不回补通知、改可选启动聚合摘要；本机发起的停止不发通知。
- 落点：`App.tsx` 通知组装、`packages/desktop/notifications.ts` claim 键。
- 判据：实时通知与蓝点同源；离线完成只有未读；**同一完成不双发、不同完成不互吞**（正负对照）。
- 方案：**可见性必须与「选中」解耦**——冷 boot 时 VT 的「新状态首帧」就是遮罩本身（`view-transition.ts:6-11`），仅靠 VT 做不到延迟揭示。新增 App 事实 `paintedView`：点击 → 目标 boot → 目标首帧可用 → 才切 `paintedView` 并 crossfade，期间旧视图保持可见。
- 遮罩主题化：**不加 CSS 颜色规则**（会被 `packages/renderer/test/frame-chrome/theme-fallback.test.ts:20` 拦下）；在 `document-theme.ts`（文档投影唯一写者）加 per-source 快照 cache，`onActiveSource` 时 prime；无缓存回退暗色快照；provisional 快照不入 cache。
- 落点：`App.tsx:2587-2613`（点击路径去 VT 化）+ 新增揭示 effect（**回调内必须重验 `activeViewRef.current===target`**，否则过期揭示会把已退役目标画回屏上）；`view-transition.ts` 不改；同步 7 处语义（reclaimView 守卫、retention 入参、hiddenSince、`deriveServers.projectableCurrent`、阅读/蓝点武装改用 `paintedView`；失败/控制面不可达仍用 `activeView` 并强制揭示）。
- 判据（三形态，取代「逐帧无空白」的口头判据）：① 无可见视图帧 ② 平坦 `#fff` 帧 ③ 主题失配进度面。Leg A：rAF DOM 逐帧 + 纯判据 `switchFrameVerdict`（进 CI）；Leg B：CDP `Page.startScreencast` PNG + 零依赖取样（从 `svg-resource-probe.mjs:193-263` 抽 `scripts/lib/png-ink.mjs`）；Leg C：WKWebView 人工。现有 `switch-measure.mjs:87` 与 `measure-ui.mjs:88-100` **不足以**判定白帧（只验 settle 下界与帧间隔）。
#### R8 首访延迟
- 方案：意图预热 = **重排既有单槽队列 + 计费**，不新增并发：`MAX_PREWARMED_REMOTE_VIEWS=1`（`App.tsx:243`）/ `RETAINED_HIDDEN_VIEWS=1`（`retention.ts:39`）。预算：每会话 2 次、冷却 60s、每来源 1 次；`harvestParked` 不得被 hover 解锁；投机温壳抢占默认关（需 A/B）。
- 仪器前置（审计 I7）：全仓今天没有 screencast / 像素采样；唯一逐帧仪器只在遮罩可见帧判 `elementFromPoint` 归属（`walkthrough.mjs:288-361`、`checks.mjs:770-803`），**证明不了「画了像素」** ⇒ W3 先落 I7（rAF 逐帧 + 可选 screencast）并给 GUI 腿加 `--require-switch` 严格旗标；R7① 与 `paint()` 的 `cut` 决策冲突（`view-transition.ts:35-44`、`design 05:440`）也须在 W3 一并重裁。
- 落点：新建 `packages/dsh-chamber-client-ui-sidebar/src/shared/prewarm-intent.ts`（dwell 120ms）——**不能复用 `hover-intent.ts`**（那是行悬浮卡机器：`HOVER_OPEN_DELAY_MS=500`、页级单卡槽）。
- 判据：切换 p95 首帧不劣于基线；预热命中率 ≥80%；温壳档位默认保持 1，任何提升须过 §10 的 6 项同环境 A/B（mountedShells / 每壳 DOM / pageHeap / idleLongTasks / 帧时 p95 / `switchFrameMs` p95）。
#### R9 状态更新不及时
- 方案：SSE 推送；watcher 发 `session-added/removed/changed` → 桌面立即触发该来源一次 unary（行权威仍归聚合）；polling 兜底并标 `mode`。
- 判据：事实 ≤2s；新行 ≤1 次往返。

#### R10 跨端已读不同步
- 方案：手机端（`packages/dsh-chamber-client-ui-mobile`，由 gateway 服务）接入同一 `/read`、`/read-all`；桌面订阅水位变化。
- 判据：手机读掉 2s 内桌面熄灭，反之亦然。

#### R11 SSH（非 gateway）来源
- 方案：桌面侧 headless 观察者（主进程复用 `dsh-client-connection` + 会话控制器，经既有隧道/代理）实现同一 `SessionFactsSource`；**A 轨不成立**，SSH 来源只能靠事件订阅，不可得时退化为 `session.list` 轮询并只在有观察者时计完成。
- 判据：SSH 来源无壳时状态与完成正确，不依赖 gateway 版本。

#### R12 手动停止被当完成（持久误报）
- 方案：watcher 在 running true→false 边沿为会话读一次 `turn/end.reason`：`aborted + reason.kind===user` ⇒ 记「用户停止」不武装未读；`completed` ⇒ 计完成；`blocked/error/max-tokens/interrupted` ⇒ 中立态，不计完成未读；旧 host/不可读 ⇒ 回退现状（自停置读 + 中立呈现）并在响应标 `degraded`。
- 落点：`packages/gateway/src/session-state.ts`（状态机 `lastTurnEnd`）、桌面 `deriveUnread` 入参。
- 判据：本机 / 其他客户端 / 第三方 CLI 的 stop 均不产生未读；正常完成照常。
#### R13 幽灵未读（host 已删会话）
- 方案：watcher 订阅 `api-session/removed` 即清 `completedAt`；桌面在 `listComplete` 报告的缺席上剪枝；`标记全部已读` 作显式出口。
- 判据：host 删除后 ≤2s 未读与徽标归零。

#### R14 断连时未读不呈现
- 方案：投影对未读事实放开 `connected` 门（断连仍附加只读 facts 并标 `stale`）；行存在时正常渲染；行缺席时**不假设待办区可承载**（`todo-attention.ts:83-88` 遍历行）——二选一：在待办区新增「离线未读」分组（带来源名 + `stale`），或明确本项只承诺「行仍在的断连来源」。
- 判据：断连来源未读仍可见且明确标注；行缺席分支按上述二选一落地并写进 §9。

#### R15 壳外/官方壳的 SVG 资源作用域缺失（切源后座席/字标空白）
- 方案：① 真机在**重新构建的产物**上重放触发序列确认不再空白；② 打包插件（mobile）安装同一 scoper；③ CI 在 `build:renderer` 之后断言产物含 scoper 标记。
- 判据：三处产物绿；CI 守卫红即阻断发布。
- **状态（2026-12）**：②③ 已落地——`packages/dsh-chamber-client-ui-mobile/src/client/index.ts` 装同一 scoper（import 自 renderer 源，不复制），committed `lib/client.js` 由 `packages/dsh-chamber-client-ui-mobile/scripts/artifact-scope-marker.test.mjs` 守卫（缺标记即红，含负控），`packages/desktop/dist/web/assets/*.js` 由 build:renderer 之后的 `scripts/assert-scoper-artifact.mjs` 在 CI 断言（缺产物时 exit 1 已实测）；① **真机验收仍未做**，且 gateway/mobile 独立部署的官方壳未覆盖（范围决策见 `docs/progress/STATUS.md`）。

#### R16 远端 blank 会话残留
- 方案：① 分源选区 hand-off——挂载来源前把该来源最近会话写入 `dsh.sessions.current`，让新壳恢复而非新建 blank；② 把「新增 blank 会话」计入验收指标（回归即红）；③ 根治走上游 selection scope（W7）。
- **未闭合（2026-12）**：① **未实现，且当前 pin 下不可实现**——会话选择是页面级单键（官方 `dsh.sessions.current` 无来源维度），壳冷 boot 前写入无法表达「这个来源」，强行写会串台；根治须上游给 selection 加 shell/入口作用域（W7④，STATUS「远端宿主上的空白会话残留」条）。② 已落地：in-app 创建按来源/标签计数，`blankByOrigin()` 与 `unlabeled()` 是判据（注入矩阵 `blank-attribution`，见 §13.2）；官方冷 boot 的 blank 属 vendor 创建，不在本账本口径内（账本只覆盖**应用内**创建）。③ 同上，走上游。
- 判据：多源启动/切换新增 blank = 0（对照基线）。

#### R17 版本偏斜（旧网关）
- **冲突登记**：`STATUS:390` 现写明「按已知降级接受」，与本项「新增 blank = 0」冲突；且缺归因仪表（I10：无法区分冷 boot / 预载 / 用户操作）⇒ 先落 I10，再决定判据是否可达。
- 方案：调用即探测 + 降级路径 + 桌面显式标记「网关未升级、状态精度受限」（不静默）+ CI 三档契约矩阵。
- 判据：偏斜不劣化且有可见提示。

#### R18 dsh pin 事件契约变化
- 方案：watcher 启动握手校验事件族，失败降级 polling 并在响应报 `mode`；升级按 `docs/checklists/dsh-upgrade-checklist.md` 跑 watcher 契约测试。
- 判据：pin 升级后契约测试与降级路径全绿。

#### R19 多 server 混合升级
- 方案：发布说明列出「每个 server 的 gateway 需单独升级」；桌面提供各来源能力状态一览；验收按 server 逐个签核。
- 判据：混合态下每个 server 独立正确、状态可见。

#### R20 90s 未验证清位导致假完成
- 方案：优先事件订阅；polling 档仅在 `aggregate.state===ok`、非 `unverified`、读数新鲜时接受**完成边沿**；读取失败降级 unknown。
- 判据：注入读取失败故障，零未读产生。

#### R21 watcher 事件源丢帧 / 静默半死
- 现象：mux 连接活着但事件停投（上游同族见 `todo/upstream-proposals.md:61-95`），§10 故障注入未覆盖。
- 方案：心跳探针 + 事件静默超时 → 重订阅并整量重取快照；响应带 `mode` 与 `lastEventAt`；投影标 `stale`。
- 判据：注入「连接在、事件停」后 ≤1 个探针周期恢复，且期间不产生假未读。

#### R22 /read 写失败与读标记单调性
- 现象：读标记写失败/乱序会回退水位 ⇒ 未读反复亮。
- 方案：读标记只增不减（`max` 合并）；写失败进本地待发队列，恢复后重放；服务端按 client id 幂等 upsert。
- 判据：注入写失败后仍单调；恢复后与服务端一致。

#### R23 blank 会话创建归因
- 现象：无法区分 blank 由冷 boot / 预载 / 用户操作产生，R16 判据不可测。
- 方案：仪表 I10——每次 `session.create`（含 blank）记录触发路径标签（boot 队列 / 预热 / 用户），验收脚本按标签聚合。
- 判据：任一验收场景可给出按标签的 blank 计数；无标签外来源。
## 9. 验收矩阵（场景 × 判据）

- 关壳（全部远端壳卸载/回收）：状态、待办、徽标、行尾点仍正确。
- 桌面关闭期间完成 → 启动即见未读、无通知；打开会话后未读解除并同步服务端水位。
- 判据口径（审计要求）：时效判据必须给出窗口起点 `t_c` 与观测方式；「不产生假 X」的负断言必须配正对照（真 X 必须出现）；GUI 腿用严格旗标，`INFO` 不得读成绿。
- 网关重启 / 升级：不产生假未读；缺口内完成按重建规则计入。
- host 停机 / 托管 down：状态 unknown，无假完成、无假未读。
- 手动停止：不产生未读（R12 闭环后）。
- 版本偏斜矩阵：新×旧、旧×新、新×新全绿。
- 视图：已打开来源切换无白屏帧；首访有进度面；p95 帧时、长任务、堆、常驻壳数不劣化。

## 10. 测试与度量

- **纯函数**：状态机与 `turn/end` 分类判定（`deriveUnread`）、驻留回收判定（`decideReclaimCandidates`，`packages/renderer/src/retention.ts`）、读标记归并（max）、缺口重建、`pendingKind` 映射；全部 node 直跑。
- **契约（CI）**：桌面客户端 × 网关服务端的三档版本矩阵；SSE 游标/断线续传（`Last-Event-ID`）；`/read` 幂等；协议版本字段与 `features[]` 的向前/向后兼容。
- **故障注入**：watcher 被杀、host 停机、读取失败（`unverified`）、时钟偏斜（网关与桌面时钟差 ≥1 小时）、游标过期（强制全量重取）——每项都断言「不产生假未读 / 不丢真未读」。
- **故障注入补三条**：watcher 事件静默（连接在、事件停，R21）、`/read` 写失败与乱序（R22）、blank 创建归因（I10，R23）。
- **接线锁**：账本必须为派生（边沿记忆不得是唯一来源）；通知第二入口存在；行刷新触发存在；降级路径存在。
- **性能**：`scripts/perf/measure-ui.mjs` 增 `mountedShells`、每壳 DOM、pageHeap、idleLongTasks、switchFrameMs、watcher 统计；验收用分档预算（§5-9），同环境 A/B。；新增 `switchFrameMs` p95 与三形态白帧判据（`switchFrameVerdict`）。
- **实机矩阵**：多 server（2/4/8）×（空闲 / 单任务 / 多任务）×（桌面开关 / 网关升级 / host 停机 / 混合版本），逐格记结论。


## 11. 风险与对策

- watcher 成为新信任面：只读、最小元数据、auth 门内、可整体关闭。
- 保证是「有条件的」：只在该 server 网关已升级且在线时成立；离线回退现状路径（判据 7 要求不劣化）。
- 手动停止误报（R12）：**由 `turn/end.reason` 闭合**（`aborted`+`cause=user` 不计未读）；不可读 host 回退现状并标 `degraded`。
- **边界审查**：新只读路由与 `design 17:672-679` 的「编排面剥离、不得回流」正面相关，必须补被否方案一节并登记，否则 review 可拒。
- **无落盘即无判据**：仓内今天没有未读持久化（零命中），落盘缺失会让判据 3 成为空判据。
- **`Last-Event-ID` 经实例代理的透传未验证**（`instance-proxy.ts` 只约束注入头）⇒ W1 补一条代理用例，否则续传降级为整量重取。
- **去重键分层写错会静默丢事件**：只按 sessionId 或只按 (sourceId, sessionId, watermark) 会吞 ask/complete、或让同 id 换宿主继承 claim（§5-16）。
- **观察者会把审批吃掉**：watcher 若回 `$events/result` 会 settle/消费 pending（`dsh-api-gateway/lib/index.js:683-693`）⇒ 被动纪律写成契约测试。
- **`session/control` 不是 pending 源**且是投影洪流（实测 301 帧/25s）⇒ 只订 `$events`，需要事件内容时才开单条 `session/follow`。
- 复杂度：新增服务/协议/持久化/契约测试；review 需补 design 17/01 的**被否方案**一节。
## 12. 明确不做（附理由）

- **全量预载所有来源**：放大 blank 会话创建与主线程压力（STATUS:388、design 05 §9），且 Codex 亦不预热。
- **撤回时保留 `prevRunning` 去补发窗口内完成**：2026-09 既有裁决（无法区分手动停止）。
- **在 pin 升级前假定水位轨**：A 轨需上游改 `updatedAt` 语义，属回归门（§6），不得当作落地分支。
- **把行权威搬到 watcher**：行继续只由聚合提供，watcher 只发刷新提示。

## 13. 验收记录（2026-09-21，实施完成后的统一验收）

> 本节是**结果记录**（唯一一次全量验收），按 §9/§10 的清单执行；命令可原样复跑。
> 分阶段验收被明确禁止，因此这里只有这一次全量结果。

### 13.1 全量验收矩阵（§9）

命令：`node scripts/gates/remote-state-acceptance.mjs --json --out .tmp/acceptance/remote-state-final.json`
（`--out` 落盘的 `remote-state-acceptance/v1` 是本次结果的机器可读形态。）
记录口径：`capturedAt` 是快照时间；`renderer-state` 组用 `listFiles(...)` **动态**登记（该目录新增测试
文件即计数变化，2026-12 已从 18 变 19），所以本表必须与一次落盘的 JSON 一起读，不要跨时间对比。

| 组 | 文件 | pass | fail | blocked | 断言 |
|---|---|---|---|---|---|
| control-plane-protocol | 6 | 6 | 0 | 0 | 105 |
| gateway-session-state | 7 | 7 | 0 | 0 | 75 |
| sidebar-state | 29 | 28 | 0 | 1 | 436 |
| layout-theme | 3 | 2 | 0 | 1 | 13 |
| renderer-state | 18 | 18 | 0 | 0 | 166 |
| desktop-edges | 3 | 3 | 0 | 0 | 92 |
| mobile-guards | 1 | 1 | 0 | 0 | 4 |
| instruments | 3 | 3 | 0 | 0 | — |
| **合计** | **70** | **68** | **0** | **2** | **891** |

**审计修复后的复跑（2026-12，同一执行器；审计全部收口后的最终数）**：`75 文件 / pass 73 / fail 0 / blocked 2 / 947 断言`。
组分布：control-plane-protocol 7（+`test/proxy/sse-resume.test.ts`）、gateway-session-state 8（+旧桌面兼容矩阵）、
sidebar-state 30（+意图预热接线）、layout-theme 3、renderer-state 20（+通知/预热/归因/全读/事实档位/无壳观察者接线）、
desktop-edges 3、mobile-guards 1、instruments 3。blocked 仍是同一对（vendor 未物化 / 无 node_modules）。

**blocked=2 的性质（不得当作通过，CI 权威）**：
- `sidebar/test/session-state/vendor-session-fact-contract.test.ts`：vendor 树在本工作树**故意未物化**
  （`vendor/harness-packages` 悬空指向 `harness-checkout/packages`），锁定的是 vendor 侧行契约；
- `layout/test/layout-store.test.ts`：`ERR_MODULE_NOT_FOUND`（本工作树无 `node_modules`）。

### 13.2 故障注入（§10）

`node scripts/gates/remote-state-injection-matrix.mjs` → **covered=20 / lost=0 / open=0**。
负控（自检）：`--self-test` → `injection-matrix self-test: ok（负控 watcher-restart 被判 LOST，恰一条）`。
每条注入的证据都指向**具名断言**：矩阵按标题在该测试文件里精确查找（`text.includes(title)`），命中即 covered；
少数标注「文件级」的条目只有文件存在性证据（已在矩阵输出里显式标出）。因此矩阵证明的是「判据有具名断言在位」，
**不是**「刚刚跑过并通过」——执行结果由 §13.1 的矩阵给出。
负控：`--self-test` 会把一条 covered 条目的证据标题改坏，矩阵必须恰判该条 LOST ——
`injection-matrix self-test: ok（负控 watcher-restart 被判 LOST，恰一条）`。

### 13.3 度量门与资产守卫

- `node scripts/perf/budget-check.mjs --self-test` → `6 cases ok`（分档预算门自身可失败）；
- `node scripts/gates/verify-test-wiring.mjs` → **395 个测试文件全部被脚本接线**（Swift 43 文件经 `test:swift`）；
- `node scripts/gates/remote-state-acceptance.mjs --self-test` → 顶层验收器的两级负控：合成失败用例判 fail/exit 1，
  合成通过用例判 pass（`acceptance self-test: ok`）；未知分组 exit 2；
- W6 观察者可观测性：`source-mux-facts` 的 `baselineFailures / followFailures / socketErrors` 计数 + `__dshChamberSourceMux` 仪器，
  重连指数退避（1s→30s 封顶）——「观察者坏了」不再与「这段时间没有完成」同形（见 `packages/renderer/test/session-state/source-mux-facts.test.ts`）；
- `node packages/dsh-chamber-client-ui-mobile/scripts/assert-scoper-artifact.mjs` → 缺 `packages/desktop/dist/web/assets`
  时**退出 1 并写明先跑 `build:renderer`**（CI 在 `build:renderer` 之后断言）；本工作树无法构建 ⇒ 该守卫的**绿**由 CI 权威。

### 13.4 本机可跑并**已跑绿**的非 CDP 腿（2026-12 环境可行性审计后新增）

`ws` 不再构成阻断：`ws@8.21.3` 在侧车内（`/Applications/dsh-chamber.app/Contents/Resources/sidecar/vendor/dsh/node_modules/ws`），
`NODE_PATH=<该目录>` 对 `createRequire` 生效。实测：

```sh
SIDE=/Applications/dsh-chamber.app/Contents/Resources/sidecar
# ① 控制面/壳资源/实例反代/来源就绪/Origin 围栏/401 的只读实机腿（本机真绿）
$SIDE/node scripts/gui-acceptance/run.mjs --live --out /tmp/gui-live
# ⇒ 25 pass / 0 fail / 26 checks，exit 0（报告 /tmp/gui-live/gui-live-report.md）
# ② 确认 cdp 工具链可加载（cdp-lib 的 ws 依赖已可解析）
NODE_PATH=$SIDE/vendor/dsh/node_modules $SIDE/node -e "import('./scripts/perf/cdp-lib.mjs').then(()=>console.log('OK'))"
```

同 pin 物化树的**旁证**（非树内运行，不得充作 CI 权威，仅用于 CI 前预判）：
`vendor-session-fact-contract.test.ts` 6/6、`layout-store.test.ts` 20/20 —— 用 /tmp 临时 loader 把 vendor 基址重定向到
harness.commit = fb2c4b9e698e30edb738bca4cf0618587db7d203 的另一工作树（三个关键 vendor 文件 md5 逐字节一致）。
**树内缺席时该测试 exit 1 且 6 fail 是正确行为**；`DSH_CHAMBER_VENDOR_ABSENT=skip` 得到的 6 skipped **不是绿**。

### 13.6 真实部署上的跨版本实测（W8 的一半，2026-12）

本机控制面（`127.0.0.1:17500`）注册了 6 个**真实 gateway 来源**（`gateway-test-http`、`gateway-pve-vm-develop`、
`gateway-kunquwiki_deploy`、`gateway-pve-ct-docker`、`gateway-pve-ct-harness`、`gateway-pve-ct-kunquwiki`），
全部 `ready`。对它们逐个打只读探针（经同源实例代理）：

```sh
B=http://127.0.0.1:17500
curl -s -o /dev/null -w '%{http_code}\n' $B/api/i/<id>/chamber/runtime/status     # → 200
curl -s -o /dev/null -w '%{http_code}\n' $B/api/i/<id>/chamber/session-state    # → 404
curl -s -o /dev/null -w '%{http_code}\n' $B/api/i/<id>/chamber/session-state/read # → 404
curl -s $B/api/i/local/chamber/session-state   # → 404 {"code":"capability_not_found"}
```

实测结果：

| 探针 | 结果 |
|---|---|
| `/chamber/runtime/status`（对照：进程活着） | **200**，`{"kind":"dsh-chamber-gateway-runtime","activeVersion":"0.1.5-rc.2",...}` |
| `/chamber/session-state`（6/6） | **404** `{"error":"not_found","code":"not_found"}` |
| `/chamber/session-state/read`（6/6） | **404** 同上 |
| 本地 dsh 来源 `/api/i/local/chamber/session-state` | **404** `{"error":"the dsh target does not expose gateway capabilities","code":"capability_not_found"}` |

**这条证据说明什么**：这批网关是**本次改动之前**的构建（有 runtime 面、没有镜像面）——正是 W8 的
「旧版 gateway + 新版桌面」现场。按 §4/§6 的规则，HTTP 404 是**版本事实**：桌面侧应把它们判为
`legacy-gateway`（无镜像），行为回落到本次改动之前（不白屏、不假装 full），能力一览显示 legacy 档位；
dsh 来源的 `capability_not_found` 同理，并由 W6 的无壳观察者提供事实通道。
**仍未覆盖的一半**：503 `session_state_disabled` 与「2xx 但响应无 `protocol`」两种降级形态在真实部署上尚未出现
（只由 `packages/gateway/test/session-state/session-state-version-matrix.test.ts` 的 6 条夹具验证）；
以及**新版 gateway**（带镜像）与新版桌面的端到端联通未实测。

### 13.7 本环境无法执行、必须由实机/CI 权威的部分（如实列出，不充作通过）

1. **实机矩阵（I14）**：`node scripts/perf/measure-ui.mjs`（含 `prewarm` 命中率、`watcher` 统计与
   `mountedShells`）、`node scripts/perf/switch-measure.mjs 2 --require-switch`（严格档：未绘制目标实例即失败）、
   白屏/切换目检序列 —— **精确阻断点：没有带 CDP 的 Electron 实例**：
   `curl -s http://127.0.0.1:9333/json/version` → 000（exit 7），且安装态 `/Applications/dsh-chamber.app` 是
   **Swift 原生壳**（`Contents/Frameworks` 只有 `Sparkle.framework`，无 Electron/asar）⇒ 结构上不存在 CDP 通道。
   需以 `--remote-debugging-port=9333` 启动 dev Electron + 至少两个可切换来源；`ws` 已不构成阻断（见 13.4）。
2. **SSH 无壳观察者（W6）**：需真实 SSH 远端 + 关闭该来源的壳后观察完成落入未读（判据：无壳仍出蓝点/todo）；
3. **双版本实机门（W8）**：旧版 gateway + 新版桌面同跑，验证 404/503/无 `protocol` 三种降级形态；
4. **移动端 scoper 产物绿**：需 `build:renderer` 产物（见 13.3）；
5. **vendor 树 lockstep**：需物化 vendor 树（CI 的 `ensure-harness-vendor` 前置）。

6. **W5 跨端已读的真实双客户端 E2E**：两端单元均 live，但没有两个真实 clientId 的端到端对照；
7. **§9 的场景级时序判据**：`t_c + 2s`、≤2s 等判据目前只有单元/纯函数代理，没有场景级执行器；
   §13.1 应读作**组件测试汇总**，场景级执行器仍是开放项；
8. **I1/I2/I5/I13 的 DOM 层断言**：现为源码正则 + 生产代码路径（本环境无 DOM）；标记随状态变化的真判据在 GUI 腿；
9. **性能面**：`measure-ui` 尚无 `switchFrameMs`（该字段只在 `switch-frame-probe`）、没有同环境 A/B 基线落 `perf/data`。

以上 1–9 均为**开放验收项**，已同步登记在 `docs/progress/STATUS.md`；本节的其余部分为已闭合证据。

### 13.8 审计发现的缺陷与修复（2026-12，实施后审计）

实施完成后的只读审计（计划覆盖核验 / 残留缺陷狩猎 / 环境可行性）发现并修复如下——审计的价值在于把「看起来闭合」拆开：

| 编号 | 缺陷 | 严重度 | 处置 |
|---|---|---|---|
| W6-1 | 无壳观察者基线不重推已完成态：`$events` 开场不重放 status，R21 重订阅后基线是唯一证据 ⇒ 跨缺口完成永久丢 | 高 | 修：基线对 `previous.running===true && row.running===false` 走同一条 `readTail` 边沿路径，并由基线播种 `runningBefore` |
| W6-2 | 基线合并 `{...previous, ...row}` 用 `null` 覆盖已完成字段 ⇒ 任何重连/45s 静默重基线都会洗掉真未读蓝点 | 高 | 修：基线只合 running/updatedAt(max)/factAt，保留既有完成字段 |
| W6-3 | `connect()` 关旧 socket 但旧 `onclose` 仍调度重连、ready 又复位退避 ⇒ 一次静默后进入约 1s 自激重订阅 | 高 | 修：代际守卫（旧代际回调不得调度或改状态） |
| W6-4 | 不为未知会话建档、忽略 `added/removed` ⇒ 基线后新建会话的完成不可见 | 中 | 修：status 未知会话 upsert；`removed` 清 rows/runningBefore |
| W6-5 | 观察者 unary 无超时 ⇒ 半死隧道下永久挂起、计数器不动 | 中 | 修：`session/list` 5s / `session/follow` 2s 预算 + 计数 |
| W6-6 | `completedAt` 用客户端墙钟（违反 §4/I12 的 host 域纪律，SSH 路径无 clamp） | 中 | 修：优先取 follow 尾部 host 时间（epoch ms）；拿不到时用观察者戳但记 `reconstructed`（诚实标注降级） |
| W6-7 | `stop()` 后在途请求仍 emit、仪器项不摘 | 低 | 修：stopped 守卫 + 摘除 `__dshChamberSourceMux` 项 |
| CP-8 | `$events` 的 `end` 帧被当 no-op ⇒ ready 仍 true，只能等 45s 静默；窗口内完成边沿永久丢且仪器不动 | 中低 | 修：end 帧按 error 同款（标记降级 + dropSocket + armReconnect） |
| CL-6 | 读 ack 把任何 HTTP 响应当成功（400/401/403/503 静默通过）⇒ 跨端已读不收敛且零信号 | 中 | 修：检查 `response.ok`，非 2xx 走 onError + `ackFailures` 计数 |
| CL-11 | SSE 增量坏游标降到 0 后当重复帧静默丢弃（与「坏载荷⇒refetch」契约矛盾） | 低 | 修：非法游标返回 `refetch: true` |
| APP-9 | 来源退役/指纹变化不收敛 mux 观察者 ⇒ rows/runningBefore 跨化身串味 | 低中 | 修：退役与身份变化时 teardown + 重建 |

**仪表假绿（G 组，均已修）**：

| 编号 | 假绿路径 | 处置 |
|---|---|---|
| G1 | 验收器整组来自 `listFiles/existsSync`：目录改名或清空 ⇒ 0 项仍 exit 0 | 修：空组一律报错 exit 2 |
| G2 | 预算门全部指标 `skip` 时 `ok: true` ⇒ exit 0 | 修：判过必须至少有一条被判过的指标（`judged > 0`） |
| G3 | `switch-measure` 相位异常全吞、`results=[]` 也 exit 0（空基线被当数据） | 修：0 结果不写盘直接 exit 1；有相位异常则落盘后 exit 1 |
| G4 | `BLOCKED` 子串启发式把含环境标记的**真断言失败**降级为 blocked（不计 fail ⇒ exit 0） | 修：`AssertionError` 或 `ℹ fail>0` 优先判 fail |

**审计 M10 / §11 风险条（Last-Event-ID 续传）**：补行为级用例 `packages/control-plane/test/proxy/sse-resume.test.ts`
（2/2）：① 新连不伪造该头 → 三帧（含心跳注释帧）按序原样到达 → 断开后重连带 `Last-Event-ID: 8`，断言上游确实收到该头且
续传帧继续；② mid-stream 断开 → 上游 request 被 abort、`activeHttpRequests`/`bufferedRequestBytes`/`activeStreams` 归零、
重复 close 不重复释放。**生产代码无需修复**：请求头走拒绝名单（`proxy-forward.ts:215-248` 的 `STRIPPED_REQUEST_HEADERS`
不含 `last-event-id`，`:911` 跳过、`:926` 原值写入，大小写不敏感），SSE 不写 content-length、不重新武装 idle 超时，
每个 chunk 原样写入并处理背压。用例自带负向对照（fresh 连接断言该头为 undefined，故 `'8'` 的断言非空洞）。

**W6-1…W6-7 的验证（修复后复跑）**：`source-mux-facts` **17/17**（既有 8 + 新增 9，每条修复都有**先红后绿**的复现用例：
B1 基线边沿 `edges must open exactly one follow` → ✔、B2 基线覆盖 `null !== 900` → ✔、B3 代际 `'degraded' !== 'ok'` → ✔、
B4 `status must open a row the baseline never saw` → ✔、B5 载荷形 → ✔、B7 挂起 → ✔、B10 stop 后 emit/仪器 → ✔）；
`unread-derivation` **12/12**（新增「observer 域完成只武装、不推进 host 读水位」）。
**B5 的域判据**：不用 `completedAtSource==='reconstructed'` 当域判据（gateway 的 reconstructed 是 host now()，按 source 剔除会误伤），
改用观察者内部附加 `completedAtDomain:'host'|'observer'`（**不进 wire**，gateway 行不携带 ⇒ 行为逐字节不变，`deriveUnread` 四参判据一字未动）；
`factsWatermark` 仅剔除 observer 域。代价已注明：observer 域完成的未读**只能靠时间流逝/新事实清掉，不能靠「只阅读」**（fail-closed），
真正闭合需 host 域 completion seq（§5-13），属判据级改动。

**两处载体/语义裁决（上层拍板，均有测试）**：① `session/follow` 仍走 unary POST（载荷已改为冻结协议形
`{args:{request:{address:{kind:'session',sessionId},maxMessages:8}}}`）——改走 mux 逻辑流会动到 `.send` 次数，
而「观察者只发一次开场帧」的接线锁是本设计的核心纪律，故保留 unary 载体并在此登记；② `follow` 期限内**没有 turn/end**
⇒ 与 gateway `followTurnEndOnce` 同规判 **unreadable 并武装**（不再判 neutral）——判 neutral 会让「跨缺口完成」在唯一证据缺失时
静默丢失；该路径同时计 `followFailures` 并标 `reconstructed/observer`，用例覆盖。

**审计 M4 / R22（客户端待发请求重放，已落地并验证）**：新增有界发件箱（`UNREAD_PENDING_MAX = 64`，同键合并只留最高水位，
仍超限则 FIFO 淘汰并报诊断），乐观入队先于发送（at-least-once 直到 2xx），出队按对象身份核对（迟到成功不会删掉更新的水位），
永久 4xx 出队防毒条目；恢复触发点复用既有通道证据（probe/poll 快照、resync 整量重取、SSE 每块含心跳注释）→ `replay()`（单飞、绝不阻塞）。
幂等依据：服务端 `mergeReadMark` 逐字 max、`markAllRead` floor max、`clampReadThrough` 钉上界。测试：`unread-store` 22/22、
`session-facts-source` 16/16（新增 12 条 R22/游标用例）。

**审计 CL-11（坏游标静默丢弃，已修）**：SSE 增量的非法/缺失游标过去被降到 0 后按「更旧帧」丢弃（真丢帧被当重复），
现返回 `refetch: true`（与模块自身「坏载荷⇒refetch」契约一致）；用例覆盖 `undefined/null/'7'/1.5/-3/NaN/0` 七种坏值。


**审计 M2 / R8（意图预热接线，已落地并验证）**：此前 `createPrewarmIntent` 只有定义与测试、**无消费者**（命中率无从测）。
现接线：侧栏来源头 hover（120ms dwell）→ `chamberBridge.requestIntentPrewarm`（单向、可取消订阅）→ App 订阅后过
**eligibility 门**（不在预热候选集合即原样返回）与**计费门**（预算/冷却/每源一次）→ 只对既有 `prewarmQueueRef` 置顶 →
既有 `drainPrewarm`/`pickPrewarmTarget` 选人 → 既有 `setMountedViews` 挂载；drain 真正选中时计费。
**不触碰的纪律**：`prewarmSuppressedRef` 绝不被意图清除（否则「回收→立刻重 boot」空转）、不加槽位、不动 `MAX_PREWARMED_REMOTE_VIEWS`、
收割候选在场时意图只能排队；hover 无任何网络副作用。测试：侧栏 `prewarm-intent` 14/14 + 新 `prewarm-intent-wiring` 5/5（含桥投递/取消订阅/唯一触点），
renderer 新 `prewarm-intent-wiring` 8/8（用**真实** `pickPrewarmTarget` 证明重排改变选取结果、被抑制源不进重排、收割预留压过意图）。

**审计 M3 / §6「旧桌面 × 新网关」cell（已落地并验证）**：新增冻结调用序列 `support/compat/route-table-0.4.0.fixture.json`
（4 条路由 + 旧客户端请求体 + frozenKeys/嵌套键集 + 基线/冻结后新增词汇表 + 客户端解析路径表；usage 头写明**永久冻结**、
只可向后追加、如何更新）与 `packages/gateway/test/session-state/session-state-old-desktop-matrix.test.ts`（6/6），经真实 surface 逐条重放：
① 状态码/内容类型按 fixture；② live 键集 == frozenKeys ∪ additiveKeys（精确相等，命名层/嵌套层/行/read/SSE 帧都查）；
③ 旧解析路径（只按 frozen 键集读取）出确定事实，且 `diagnostics`/`row.factAt` 确实在原始响应里而不在旧投影里；
④ `full \ base` 恰好等于 fixture 记录的词汇表、`SESSION_STATE_ROUTES` 反查 == fixture.routes ∪ routesAddedAfterFreeze。
**负控**（每次跑都执行 + 一次临时红验证）：rename / delete / unrecorded-add 三个变异必须 `assert.throws`；临时把 fixture 的
`protocol` 改名后新测试 exit 1（pass 3 / fail 3），从 `.tmp` 备份回滚后 `cmp` 字节相同、6/6 复绿。
> 路径说明（有意偏离）：蓝图 §3.2 曾规划该 fixture 放 `packages/gateway/test/session-state/support/`；本次落在仓库根
> `support/compat/`（跨包契约的产物，不专属 gateway）。蓝图里的旧路径为历史记录，不追改。

**审计 S3（产物链，已修）**：

| 编号 | 缺陷 | 处置 |
|---|---|---|
| S3-1 | 页面产物守卫的第三个标记是裸调用文本 `installSvgResourceScope()`，esbuild 压缩后调用被改名 ⇒ 守卫对**任何真实构建恒红** | 入口改锚定赋值 + 标记改为「属性名 + 右侧必须是调用」的模式判定；负控（右侧改非调用）仍红；压缩/未压缩两态各有正向用例 |
| S3-2 | Swift 装配步只断 `index.html`，**无标记门** | `build-swift-app.mjs` 在 `cpSync` 后对已拷入字节断言标记并 fail-closed；`build-swift-app.test.mjs` ⑭ 增两条负控（无 chunk / 无标记 chunk） |
| S3-3 | `release.yml` **零 scoper 门** | `build:renderer` 后断源产物；「Verify native app」步对 `.app` 内实际字节再断一次 |

**门接线（审计 M9）**：`remote-state-injection-matrix.mjs` 进入 `scripts/gates/run-checks.mjs` 的静态门清单；
`remote-state-acceptance.mjs` 成为 CI 的一个 step（`--node "$(command -v node)"`；vendor 与 node_modules 就位后 blocked 项应全部转绿）。


### 13.10 Swift 原生壳（design 25）复查（2026-12，用户目标 = Swift 版本彻底修复）

此前的验证几乎全在 Electron 路径上；本节专门回答「这些修复在 Swift 形态生效吗」。

**① 自动生效（两形态共用同一实现，逐条有证据）**

| 面 | 证据 |
|---|---|
| 通知核心与五元组去重 | 共用 `packages/desktop/shell-core.ts`（claim 编排含 watermark 键）与 `notifications.ts` 的 claim 类；Swift 形态经 `sidecar-entry.ts` + `node-edges.ts` 走同一 core |
| 焦点豁免（requireHidden） | `shell-core` 读 `deps.edges.isFocused()`；`node-edges.ts:502-503` 读 `hostFacts.focused`；Swift 宿主 `MainWindowController.swift:13-17/473-481` 观察 key/resign/close 后推送 `__host.hostFacts` |
| 失败诚实性 | `{shown:false,error}` 释放 claim 的路径在共享 core 内；Swift 侧 `SwiftEdgeHostLegs.swift` 只负责投递与回执 |
| 桥面存在性 | `Generated/BridgeManifest.swift` 含 `dsh-chamber:notify` / `badge-count` / `notifications-ready` / `notification-open-ack` / `system-resume` |
| 事实通道与 W6 观察者 | Swift 侧控制面是同一个 `packages/control-plane`（sidecar 产物）；WKWebView 加载 `http://127.0.0.1:17520`（dev）/ `http://localhost:17500`（打包），W6 从 `window.location.origin` 派生同源 `ws://…/api/i/<id>/api/remote.mux`，与官方客户端自身 mux 同路 ⇒ `connect-src 'self'` 不构成新阻断 |
| 白屏/揭示修复 | 纯 renderer 状态机（`reveal-gate.ts` 无 rAF/Observer；`perf-marks` 的 `performance.mark` 有守卫）⇒ 与引擎无关 |
| 渲染层全部改动（I3/I4/W4/R19 等） | 页面级（`.tsx`/`.ts`），两形态同一份产物 |

**② 本次复查新发现并修复的 Swift 侧缺口（真缺陷）**

| 缺陷 | 影响 | 处置 |
|---|---|---|
| 产物守卫的第三个标记是**裸调用文本** `installSvgResourceScope()`，esbuild 压缩后调用被改名 | 页面产物守卫对**任何真实构建恒红**（守卫形同废纸），而 Swift 装配步与 release.yml **完全没有**标记门 ⇒「构建把 scoper 摇掉」的空壳可以一路装进正式 `.app`，切源白屏复发 | 入口改为**锚定赋值**（`globalThis.__chamberSvgScopeInstalled = installSvgResourceScope()`，点号名不被压缩改写），标记改为「属性名 + 右侧必须是调用」的模式判定（压缩/未压缩两态通吃，右侧改成非调用即失配）；`main.tsx` 与 mobile 入口同步、committed bundle 重建 |
| Swift 装配步只断言 `index.html` | 装配出的 `.app` 可以缺 scoper 而不报错 | `macos/scripts/build-swift-app.mjs` 在 `cpSync` **之后**对已拷入字节断言标记，缺失即 throw（含「没有可检查 chunk」与「无 chunk 携带标记」两条负控测试） |
| release.yml 零 scoper 门 | 正式发布腿不检查 | `build:renderer` 后加源产物断言；「Verify native app」步 `index.html` 之后对 **.app 内实际字节**再断一次 |

**③ Swift 套件实测（本机跑了真实 XCTest）**

`node scripts/gates/run-swift-tests.mjs`（release 配置，swift 6.4）→ **Executed 453 tests, with 30 failures**，失败**全部集中在 6 个用例**：
`BridgeClientEdgeIntegrationTests`（3 个：customEdgeResponder / settingsSetRendererPush / sixtyChannelSmoke）与 `BridgeClientRealEntryIntegrationTests`（3 个：RealEntry 的三个），
根因是这些用例要**启动真实 sidecar**（错误行：`超时（30s）未等到：sidecar ready notify`），而本工作树没有 `build:sidecar` 产物（同 pnpm/node_modules/vendor 阻断）⇒ **环境因，属 CI 的 test-macos 腿（先装配再测）**。
其余 **450 个用例全绿**，包含与本次改动直接相关的锁：`BridgeManifestConsistencyTests`、`CrossLanguageLockstepTests`、`NotifyRouteTests`、`SwiftEdgeHostLegsTests`、`HostFactsDiffTests`、`MessageHandlerTests`、`BridgeShimInjectorTests`。

**③b 独立复核（审计 S4）与三项新发现**

- **F1（实机面最重要）**：安装态 `/Applications/dsh-chamber.app` 是 **0.3.2-beta.5（2026-09-21 构建）**，其 `Resources/dist/web/assets/*.js`
  对本次修复标记 **0 命中**（`dsh:app:view-request/view-reveal`、`requestMarkAllRead`、`requestIntentPrewarm`、`__dshChamberSourceMux`、
  `__chamberSvgScopeInstalled`、`data-chamber-session-state` 全无；只有更早 W8 的 `data-chamber-svg-scope`）⇒ **这台机器上的 Swift 形态目前没有吃到本次修复**，
  「自动生效」只在重新 `build:renderer` + `build:sidecar` + `build:swift-app` 并**安装**之后成立。这也是「彻底修复 Swift」的唯一剩余动作面。
- **F2（Swift-only 接线缺口，已修）**：`mainWindowShown` 在 Electron 来自窗口 `'show'`（`main.ts:1002-1009`），Swift 只在 `NSApplication.didBecomeActive` 发；
  唤醒时若渲染器不可投递（crashed/reloading），`lastResume` 会被 hold 到**下一次应用激活**（即时重连退化成等 15–45s 看门狗）。
  修复落在**共享 core**：`onRendererLifecycle('did-finish-load')` 分支先 `handleMainWindowShown()` 再 drain（flavor 无关、幂等，Electron 同样受益）；
  锁：`packages/desktop/test/runtime/main-decision-gates.test.ts` 新增一条（本工作树因工作区包缺 `node_modules` 无法就地运行，CI 权威）。
- **F3（待实机判）**：`design 19:166-167` 假设 `document.hasFocus()` ≡ 宿主焦点，而 `macos/` 全树 0 处焦点观测；该假设驱动「正在阅读」清蓝点与 `requireHidden`。
  若 WebKit 不等价，最坏是「看着会话蓝点不清」或 always 模式下正在看的会话也弹通知 ⇒ 与 S-10 同批实测或登记 deviation。
- 复核还指出：`bridge-manifest.test.ts:22` 与 `MessageHandler.swift:69` 的注释计数（60/68）与断言值（61/69）漂移——注释面待合并修正。
- S4 独立确认父结论 A–E 成立（修正细节：五元组键定义在 `notifications.ts:340-346`，编排/裁决在 `shell-core.ts:2266`；TrustGuard/白名单不构成阻断，
  两个新通道是页面内 listener 总线、仪器与 shim 全局无重名；通知点击链两形态等价；`systemResume` 在 Swift 真的会发；页面资产单一来源成立）。

**④ Swift 侧仍需实机/CI 的开放门**（并入 §13.7 的口径，与 `STATUS.md:11/:357` 同源）：

1. WKWebView **无 `backgroundThrottling:false` 等价物**下的 SSE/WS 心跳与恢复、静默看门狗（45s）与 App Nap 语义——已登记；
2. 打包态 `.app` 的实机验收（冷启动首载、通知权限时机与点击激活、唤醒补发、ATS loopback、最小化/完全覆盖）；
3. sidecar 装配依赖的集成测试（上表 6 例）与 `build:sidecar` 相关门在 CI 的 macos 腿；
4. 真机重放「切来源 + 开设置面板」确认不再空白（判据与命令见 `design 05 §4.2`）。

### 13.9 已登记的必要取舍（不可恢复子集）

**网关整段停机期间开始并完成的会话**：事实通道在停机窗口内不存在任何证据（镜像没观察到、壳也未挂载），
重启后的重建只能基于现存事实 ⇒ 该子集不可恢复。这是**按设计接受**的降级（不是缺陷）：R3 的缺口重建覆盖
「重启后仍能看到的事实」，零证据窗口没有任何可重建的输入。已登记于 `docs/progress/STATUS.md`。

