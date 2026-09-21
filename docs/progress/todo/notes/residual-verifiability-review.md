# 残留闭合判据的对抗性复核（R1–R20 · 可验证性 / 反例 / 作弊面）

> 状态：复核（不实现、不改主计划）。对象：`docs/progress/todo/remote-session-state-and-switch.md`
> 的 §0 八条判据、§8 R1–R20、§9 验收矩阵、§10 测试与度量；锚定 `v0.4.0-beta.1`。
> 证据纪律：每条结论标注 **事实**（本次读过源码/跑过命令）或 **推断**（由事实推出、未验证）。
> 文件:行号均为本工作区当前内容；official-client 行为一律引打包 vendor
> `/Applications/dsh-chamber.app/Contents/Resources/sidecar/vendor/dsh/node_modules/@deepseek-ai/`。
> 只读审计：未改任何生产文件。

## 0. 结论摘要

1. **Track A 的立论前提在 pinned 源码里为假**（**事实**）：会话摘要的 `updatedAt` 是
   `Math.max(header.createdAt, metadata.lastPromptAt ?? 0)`
   （vendor `dsh-api-session-controller/lib/index.js:1969-1971`），而 `lastPromptAt` 只在
   `event.type === 'user/message' && event.data.source.kind === 'user'` 时推进
   （同包 `lib/types/list.js:30-35`、`lib/index.js:1751-1754`）；`api-session/activity`
   也只在同一条件下发出（`lib/index.js:2761-2768`）。⇒ **agent 产出不推进 `updatedAt`**，
   §3.1 的 A 轨（水位轨）不成立、可直接判为 B 轨，不需要 30 分钟实测定分支。
   打包 vendor 版本 `0.1.5-rc.2` 与运行线 pin 一致（**事实**：
   `packages/desktop/vendor/dsh/pnpm-lock.yaml:298`；`harness.commit = fb2c4b9e…` 同
   `todo/upstream-proposals.md:23` 引用的 pin）。
2. **§5-3「水位优先」的判定式在 B 轨下自我否定**（**事实**+**推断**）：`unread ⟺ updatedAt > readMark`
   在 B 轨永不成立（完成不推水位）；§3.1 说 B 轨「完成类需观察者」，§5-3 却说边沿
   「只作触发/回退」——两边不能同时成立。R1/R3/R12/R13 的判据全部建立在这个未定的判定式上。
3. **§0-4「四面同源同规则」与已登记的诚实分叉冲突**（**事实**）：design 19 §3.7 明确登记
   ① vendor-only 完成「窗口内有完成点、徽标恒 0」、② 断连「徽标按保留账本计数、窗口内该来源无行」
   ——「均为既有取舍的诚实边界，非分叉缺陷」（`docs/design/19-notifications.md:366-378`）。
   R14 又要求断连未读可见 ⇒ 三条（§0-4 / design 19 §3.7 / R14）必须择一重裁。
4. **§2-2 已被否决的「轮询级完成推导」在 R1/R9/R11 的降级路径里复活**（**事实**：`docs/design/06-sidebar-enhancements.md:597-602`
   明文否决：10s 粒度会漏掉更短任务，且与「running 点 wire 权威、completed 仅通道提供」契约冲突）。
   现有聚合 unary 兜底周期是 **30s**（`packages/renderer/src/App.tsx:208`），比被否的 10s 更粗。
   ⇒ §0-1/§8 R1/§8 R9 的「≤2s」只可能在 gateway-SSE 路径成立；R11 的 SSH 降级路径与判据矛盾。
5. **R7 的判据今天没有仪器**（**事实**）：全仓无 `Page.startScreencast`/像素采样（`scripts` 下
   grep 命中 0）；唯一逐帧仪器是遮罩层叠探针，只在 `.instance-loading` 可见时、每 4 个 rAF 采样一次，
   判的是 `elementFromPoint` 归属（`scripts/gui-acceptance/walkthrough.mjs:288-361`、
   `scripts/gui-acceptance/checks.mjs:770-803`）——它证明「谁在命中测试里胜出」，不证明「画了像素」。
   且 R7① 与 P2 的 `cut` 决策冲突（`packages/renderer/src/view-transition.ts:35-44`、
   `packages/renderer/src/styles.css:210-222`、`docs/design/05-connection-manager.md:440`）。
6. **R15/R16 两条没有仓内闭合路径**（R12 的判据工具在 pin 内已存在、缺的是样本与接线），
   §0-8「每条已发现残留都有闭合路径与判据，不以『接受』结案」因此不成立：R15②③ 未排期（mobile 入口 0 处 scoper 引用，**事实**：对
   `packages/dsh-chamber-client-ui-mobile` grep `scoper|svg-resource` = 0），R16 的根治在上游且
   STATUS 已登记为「按已知降级接受」（`docs/progress/STATUS.md:390`），R12 的第三方 CLI 停止依赖
   上游 turn-end reason（**事实**：该机制在同一 pin 里**已存在**——`turn/end.reason` 可区分
   completed/aborted+user，`lib/typert.host.js:1717,2056-2057,1292-1293`，客户端可 `session.follow`，
   `lib/client.js:385-387`；peer 同结论 `notes/remote-state-w0-protocol.md:137-171`——缺的是真机 abort
   样本与被观察者的接线，不是上游事实）。
7. **R6 的去重键两处自相矛盾，且在 B 轨上更严重**（**事实**）：§3.3-3 写「内容水位」、R6 写
   `completedAt`；主进程现有 claim 键是 `[sourceId, sourceFingerprint, sessionId, kind]`
   （`packages/desktop/notifications.ts:321`），renderer 只按 `sessionId` 去重
   （`packages/renderer/src/notification-edges.ts:71-88`）。B 轨下水位不推、`completedAt` 才存在，
   A/B 两支需要不同的键——同一段判据覆盖两支时必有一支不可判。同题已在
   `docs/progress/todo/notes/protocol-compat-blueprint.md:28-31,464-467` 登记统一口径，本节不重复结论，
   只补「可验证性」面。
8. **R1–R20 里有 6 组同根因**（见「遗漏与重复」）：`{R1,R3,R4}`=无服务端持久事实/水位；`{R2,R6}`=撤回分支
   删记忆；`{R5,R1}`=事实只在挂载 ctx 通道；`{R3,R12}`=同一 running→idle 边沿无法区分完成/停止；
   `{R10,R4}`=同一读水位机制的两个客户端；`{R17,R18,R19}`=同一能力协商机制。按 20 条计完成度会高估覆盖面。

---

## 1. 审计方法

### 1.1 三条判据标准

对每条 R 问四件事，任一不过即判「需新增仪表」或「不可」：

1. **可观测**：判据里的可观测量在今天的仓库里存在吗（DOM 契约 / CDP 能力 / 纯函数 / 契约测试）？
   没有则必须点名新仪表（§5 清单），不能把「跑一次看看」当判据。
2. **可反例**：这条判据在什么输入/环境下**必然为假**？若任何输入都不可能判红，它就是自证式判据。
3. **可作弊**：有没有一条「缺陷仍在、脚本仍绿」的路径（空跑、INFO、把起点取错、只测弱面）？
4. **可闭合**：闭合是否依赖未落地项（watcher/协议/mobile/上游）？依赖就必须显式登记为
   「未闭合 + 归属里程碑」，而不是与已可闭合项并列在 §8。

### 1.2 现有仪器盘点（**事实**）

| 仪器 | 能测 | 边界（决定哪些 R 判不了） | 出处 |
|---|---|---|---|
| rAF 帧间隔采样器 | 帧间隔 delta → p95/worst | 只测「两次 rAF 之间隔了多久」，**不测内容是否绘制**；不 reload、点击目标是活动视图首个可交互元素 | `scripts/perf/measure-ui.mjs:88-100,170-177` |
| 遮罩层叠探针 | `.instance-loading` 可见帧里 `elementFromPoint` 归属（veil/tenant/portal） | 只在遮罩在 DOM 时采样；每 4 帧一次；20s/1200 帧自停；判命中测试不判像素；无遮罩帧记 **INFO** | `scripts/gui-acceptance/walkthrough.mjs:288-361,567`；`checks.mjs:770-803` |
| switch-measure | click → 首个「安静」轮询间隔（settle **下界**）、skeleton 窗 | 文档明写「不校验目标视图/内容确已切换」；来源标签**硬编码**（'本地实例'/'Desktop'、'test'/'test'） | `scripts/perf/switch-measure.mjs:95-100,109-110,126-133` |
| CDP 客户端 | Network 请求 URL 记录、响应 ≥400 计数、截图、真实鼠标/键盘 | 不暴露按 URL 计数；无 screencast、无像素读取 | `scripts/gui-acceptance/cdp.mjs:85-95,146-151` |
| 纯函数单测（node:test） | derive/水位/边沿/保留/待办派生 | 只能证明函数；证明不了 App 接线真的调用它 | `packages/dsh-chamber-client-ui-sidebar/test/**`、`packages/renderer/test/**` |
| 接线锁（读 App.tsx 源文本） | 字符串存在性 | 注释/死分支也能满足；2026-12 已批量退役视觉类源文本锁 | `packages/renderer/test/wiring/session-liveness-wiring.test.ts:1-40`；`scripts/dev/test-support/source-text.ts` |
| 契约测试 | gateway 路由级（harness）/注入式 fetcher | 需要装树（本工作区无 node_modules）；浏览器半的跨版本矩阵需新 harness | `packages/gateway/test/support/*.ts`；`packages/dsh-chamber-client-ui-sidebar/src/shared/search-state.ts` 的 `setSearchFetcher` 先例 |
| 官方单会话 follow 流（客户端半 `remote.session.follow`） | 该会话的持久事件：`turn/end.reason`（completed/aborted+user/…）、approval 的 asked/decided 对 | 需在 running→idle 边沿按会话开流（每次 turn 一条，不能常驻 N 条）；被动观察者**不得**发 `$events/result`；提问型在当前 pin **无持久事件** | vendor `dsh-api-session-controller/lib/client.js:385-387`、`lib/typert.host.js:1717,2056-2057`；`notes/remote-state-w0-protocol.md:123-135,155-165` |
| 性能数据 | boot/switch/eval/rapid 基线 JSON 入库 | `scripts/perf/data` 中**没有** measure-ui 基线（**事实**：目录 14 个 JSON，无 `measure-ui-*`） | `scripts/perf/data/`；`scripts/perf/README.md:39-46` |
| SVG 真机探针 | 注入 scoper 前后的不变量 + `--expect-artifact` | **人工工具、不进 CI、需控制面在跑**；触发序列是桌面 N-ctx 页（插第二份壳 + 开设置面板） | `scripts/dev/svg-resource-probe.mjs:12,339`；`docs/progress/STATUS.md:18` |
| 纯判据层（gui-acceptance） | 全部 pass/fail 逻辑，可 CI 单测 | 判的是**采集到的事实**；采集腿本身要 GUI + CDP，**不进 CI** | `scripts/gui-acceptance/README.md:18-22,191` |

### 1.3 环境纪律（对判据的直接后果）

- **事实**：GUI 腿不进 CI，且 `INFO = 没执行/没判过`，退出码 0；唯一的严格档是 `--require-hover`
  （`scripts/gui-acceptance/README.md:50-57`）。⇒ 任何「CDP 实测」判据都必须指定环境（`--dev` 一次性
  实例 vs `--attach` 真机）**并**登记严格旗标，否则一次未执行的运行会被读成绿色。
- **事实**：`--dev` 一次性实例默认只有 local 一个来源（`scripts/gui-acceptance/README.md:161` 明确
  「本机一次性实例是单壳，故真机多来源应用未复验」）。⇒ 所有多来源判据（R1 的「关掉全部远端壳」、
  R7 的「切到已打开过的 server」、R16 的「多源启动」）在 `--dev` 下**空跑**。
- **事实**：`document.visibilityState === 'hidden'` 时周期性/后台工作被门控
  （`packages/renderer/src/retention.ts:123-133`）；⇒ 「≤2s」必须在**可见窗**里测，否则判据与既有
  后台门控互相打脸。

---

## 2. 先决反证（读 R 表前必须接受的五条）

### 2.1 A/B 决策门（W0①）今天就可以用源码关闭，且答案是 B

**事实**：`updatedAt` 的构成与唯一推进源见 §0-1 引用。**推断**：`W0①` 仍值得跑，但它的作用
应从「决定轨道」改为「验证 pinned 实现与契约一致，并测出 `updatedAt` 的实际可观测推进面」；
如果结论仍是「只有 user/message 推进」，那么 §3.2 的「事实只有一个语义：内容水位」和 §5-3 的
「水位优先」都需要改写（否则 B 轨下未读恒为假）。

**立即要做的订正**（可直接粘贴到 §3.1 表下）：

> `updatedAt` 在 pin `0.1.5-rc.2` 的实现是 `max(createdAt, lastPromptAt)`，只在 user-authored durable
> message 上推进（`dsh-api-session-controller/lib/index.js:1969-1971,2761-2768`）。因此 A 轨的成立
> 条件应改为「host 明确承诺任何 durable message（含 agent 产出）推进 `updatedAt`」（即 W7①
> 落地），当前实现下默认走 B 轨；W0① 的作用收窄为「上游承诺前的实测复核 + 边界样本」。

### 2.2 §5-3 的判定式必须扩成双水位析取

B 轨在跑：完成事实由观察者给出 `completedAt`，而 `updatedAt` 不动。**推断**：`unread ⟺ updatedAt > readMark`
在 B 轨下必然把「完成了但没读」判成未读为假。改写（可直接粘贴）：

> 未读判定（B 轨）：`unread ⟺ max(updatedAt, completedAt) > readMark`；读动作把 `readMark` 推到
> 读取时刻该会话的 `max(updatedAt, completedAt)`。A 轨（上游承诺 `updatedAt` 全量推进）下退化为
> §5-3 原式。两支都必须在响应里同时携带 `updatedAt`/`completedAt`，判定式由 `features` 选择。

### 2.3 design 06 §5 的「不做轮询级完成推导」必须显式改判，否则 R9/R11 的降级路径违契约

**事实**：design 06 §5 否决轮询级完成推导（10s 粒度不够），现有兜底是 30s unary
（`App.tsx:208`；`instance-api.ts:1116`）。R9 说「polling 兜底并标 mode」，R11 说 SSH 无壳退化为
`session.list` 轮询，R1 判据说 ≤2s。**推断**：B 轨 + SSH 无 SSE 时，这两条不可能同时为真。
必须二选一：(a) SSH 也走事件通道（host seed 或桌面观察者的连接订阅），或 (b) 把 R11/R9 的判据
从「≤2s」改为「≤一个 unary 周期 + 可见模式标注」，并在 design 06 §5 补「被否方案的重新裁决」一节。

### 2.4 R7①（延迟揭示）与 P2 的 `cut` 决策冲突，必须先给不混色方案

**事实**：`cut` 的存在理由就是「旧快照（含输入栏）不与新遮罩 crossfade 混色 ~250ms」
（`view-transition.ts:35-44`；`styles.css:210-222`；`design 05:440`）。R7① 要求「旧视图保留绘制到新壳
首帧」——这正是 P2 的否决形态（「旧视图输入栏 × 新遮罩」）。**推断**：R7 必须写成
「旧视图保留 ⟹ 揭示前一直保留**整幅旧快照**、切换瞬间仍是 `cut`（零 crossfade），只有新壳首帧
可用后才做一次 crossfade」；否则它把 P2 修好的缺陷原样带回。

### 2.5 判据里「可见」「标注」「不劣化」这类词没有机器判据

**事实**：`INFO ≠ PASS` 是工具箱明文纪律（README:50-57）。⇒ 「有可见提示」（R17）、「明确标注」（R14）、
「同源」（R6）、「无假态」（R14）都必须落成**可查询的属性/DOM 标记**（§5 I1/I2/I13），否则只能目检，
而目检不是判据（`docs/checklists/gui-acceptance-checklist.md:53-60` 的目检腿只列了四类）。

---

## 3. R1–R20 逐条判定表

> 「可」=今天有仪器可判；「需新增仪表」=概念可判但仓内缺仪器/事实源；「不可」=按现文
> 在现架构内不可判或自相矛盾。每行给出**今天的最小实测方式**（存在时）。

| R | 判据可验证性 | 测量方法与工具（今天） | 被误判或作弊的方式 | 建议修正 |
|---|---|---|---|---|
| **R1** 壳回收后完成丢失 | **需新增仪表**（现状只能演示「丢失」，不能判「≤2s 出现」） | 现状反例：`retention.ts:39,42,99-120`（需 ≥2 个隐藏非 local 壳才触发）→ `App.tsx:3937-3971`（撤回删 `completedBySource`）→ `derive.ts:868`（环忽略通道）→ `badge-count.ts:55-70`（徽标只投影账本）。闭合后需：watcher 事实时间戳 + `data-chamber-session-state`（§5 I1）+ 徽标回读（I3） | ①「回收不触发」的机器（只挂 1 个隐藏壳）空跑通过；②只断言「蓝点存在」而不校验它因**这一次**完成而出现（陈旧蓝点顶替）；③延迟起点取测试自己的轮询时刻，`≤2s` 被量成 0；④只测蓝点（最易命中）不测待办/徽标三面 | 见 §4-R1；把「关壳」写进前置（脚本先断言 `dom.views.hidden ≥ 2` 且目标壳已回收，否则 FAIL 而非 PASS） |
| **R2** 已武装蓝点被同代重挂/撤回销毁 | **需新增仪表**（纯函数可测一半；「锁」是文本级） | 现状反例：`aggregate-store.ts:793-796`（重挂注册即广播 undefined）→ `App.tsx:3953-3971`（删账本）。纯函数 `reconcileCompletedFacts`（`derive.ts:494-532`）+ 撤回/重挂夹具可测「删了会重算」 | ①接线锁用正则匹配源码（`wiring/*.test.ts` 模式），注释/死分支即可满足；②只测 `reconcileCompletedFacts` 纯函数，不测 App 的撤回分支真的不再删账本；③B 轨下 `deriveUnread` 也可以「重算」出一个陈旧 `completedAt`（若 `completedAt` 不是事件产物而是从缺口推出） | 见 §4-R2；把 `deriveUnread` 做成**唯一输入=事实快照+读水位**的纯函数，并加一条**行为级**回归：注入 store → 撤回 → 重挂 → 断言账本由事实重算（不是文本锁） |
| **R3** 应用关闭期间完成丢失 | **需新增仪表**（watcher 持久化不存在） | `packages/gateway/src/session-state.ts` 与 `packages/renderer/src/App.tsx:3937-3971` 之间没有任何持久事实；关闭遍历 = 关桌面进程 + 期间在远端跑一轮 + 重启。需 watcher 快照/回放（§5 I5/I6） | ①「不补发通知」是**负断言**：通知路径整体坏掉时它也通过——必须有同一次运行内的**正对照**（实时完成必须发一条）；②启动即见未读可能来自本地旧账本（不是 watcher 回放），必须清 userData 或换 client id；③**缺口重建规则 `stored.running && !baseline.running ⇒ completedAt` 与 R12 同病**：期间被手动停止的会话会被记成完成未读（见 §4.1） | 见 §4-R3；把「不补发通知」的正对照写进判据 |
| **R4** 重启后未读丢失 | **需新增仪表**（`/read` 路由不存在） | 纯函数「读标记取 max」可单测；端到端需 `GET /chamber/session-state` 回读 + `POST /read`（§4 协议未落地）。重启腿 = 重启桌面；服务端腿 = 清本地存储后再断言 | ①只重启、不清本地缓存 ⇒ **只证明了本地缓存**（服务端腿没测）；②「重装后一致」与 §4「重装即新 id、旧标记 TTL 清理」**直接矛盾**（新 id 不可能与服务端一致）；③max 合并方向写成客户端墙钟会引入偏斜（§4 已禁止，需在判据里点名 `host updatedAt`） | 把判据拆成两条：重启（保留本地缓存）与服务端回读（清 localStorage/userData）；删「重装后一致」，改为「重装后新 clientId 无读标记 ⇒ 未读与服务端新 id 一致（可预期全未读）」 |
| **R5** pending 无壳时丢失 | **需新增仪表**（现状不可见） | 现状：pending 只来自挂载 ctx 注入的 `pendingInteractions`（`derive.ts:570,589-590`；`client/index.ts:631`），撤回即无（`todo-attention.ts:80,87-90`）。事实源可行性有证据：`approval/request`、`user-questions/request` 在**转发事件白名单**里（vendor `dsh-api-remotes/lib/types/remote-events.js:14,31`），但 `mode: waterfall` | ①headless 观察者若**参与 waterfall 回值**，可能替用户应答/「吃掉」这次审批=静默的产品行为变更（计划没写这条边界；同题已由 peer 定纪律：观察者不得发 `$events/result`，`notes/remote-state-w0-protocol.md:123-129`）；②只测「pending 出现」不测「解除」——解除才是容易漏的一半；③把「无壳」测成「壳在后台挂着」（`instance-pending` 仍挂载）；④**提问型 pending 在当前 pin 没有持久事件**（peer：`notes/remote-state-w0-protocol.md:132-134`）⇒ 若 waterfall 路径失败，回退方案只能覆盖 approval ⇒ R5 判据里的「提问」半条会静默不闭合 | 见 §4-R5；把「订阅不得参与 waterfall 决议」写成硬约束 + 一条「观察者存在时官方应答路径不变」的对照测试 |
| **R6** 撤回窗口通知丢失 | **需新增仪表**（负断言 + 同源无机器判据） | 纯函数 `detectNotificationEdges`/`dedupeCompleteEdges` 可单测；主进程 claim 键在 `notifications.ts:321`（5s TTL，`notifications.ts:250`）。端到端需「通知事件账本」（§5 I4） | ①「离线完成只有未读」= 负断言，通知面坏掉也绿；②「实时通知与蓝点同源」没有机器判据，只能看两条各自对；③去重键用 `completedAt` 在 A 轨不存在（§3.3-3 又要求水位）——**判据本身不可判** | 见 §4-R6；键统一按 peer 蓝图 `notes/protocol-compat-blueprint.md:464-467`（renderer 键 = `(sourceFingerprint, sessionId, 内容水位)`，主进程键不塞水位），判据加「同水位重放零事件 / 新水位一事件」正/负成对断言 |
| **R7** 切源白屏 / 首访无内容 | **不可**（无像素/绘制仪器） | 现有：遮罩探针（只判命中归属，遮罩可见帧）、rAF 间隔采样（不是绘制）、`Page.captureScreenshot`（单张，非逐帧）。需 screencast + 内容矩形 ink 采样（§5 I7）。环境：多来源 + 已打开目标（`--dev` 单源空跑） | ①把「没观察到白屏帧」当 PASS——探针只在遮罩在 DOM 时采样，白屏恰好可能发生在遮罩撤下之后；②`elementFromPoint` 命中租客≠画了内容（WebKit 丢绘正是「元素在、不画」）；③浅色主题下「白」是合法底色，与空白不可区分，没有像素判据时人/脚本都会误判；④无遮罩帧记 INFO ⇒ 未执行也退出 0 | 见 §4-R7；判据必须给出「内容区 = 哪个矩形、什么算绘制（ink 阈值）、从哪一帧到哪一帧」三要素 |
| **R8** 首访延迟 | **需新增仪表**（命中率无计数器） | `measure-ui` 有 DOM/heap/idle/帧间隔；无 `prewarmAttempts/Hits`（对 `packages/renderer/src` grep 无命中率字段）。`scripts/perf/data` **无 measure-ui 基线**（14 个 JSON 里没有） | ①`switch-measure` 的硬编码标签找不到第二个来源时返回 `NOROW:test`，随后「无骨架 + 安静」仍记结果 ⇒ **切换越快越绿**；②measure-ui 的 `--clicks` 打的是活动视图首个可交互元素，不是来源切换，用它证「切换 p95」是换尺；③只报数不设门（§5-9 分档预算未定义具体档位） | 见 §4-R8；把 `NOROW` 变 FAIL；加 `prewarmHits/Attempts` + measure-ui schema v2；基线用同环境 A/B（README:31-35 已定纪律） |
| **R9** 状态更新不及时 | **需新增仪表**（SSE 路由不存在；往返无计数） | 现状：挂载源由 ctx push，未挂载源只有 30s unary（`App.tsx:208`）；环忽略通道（`derive.ts:868`）。仪式可复用 CDP `Network.requestWillBeSent` 计数（`cdp.mjs:85`，需暴露按 URL 计数）+ 事实时间戳 | ①「≤2s」起点取错（同 R1）；②「新行 ≤1 次往返」在挂载源上天然成立（push），脚本若在有壳时测就是择易；③隐藏窗里测 ⇒ 与后台门控冲突（`retention.ts:123-133`） | 见 §4-R9；判据限定「可见窗 + 目标源无壳」，并给出往返计数的 URL 模式 |
| **R10** 跨端已读不同步 | **需新增仪表** + **协议语义未定** | mobile 包对 `unread` 0 处引用（grep）；`/read` 不存在。§4 数据模型是**按 clientId 存读标记**，而「手机读掉 → 桌面熄灭」需要「任一客户端的读都算数」⇒ 必须定义 `read` 是来源级 max 水位（§5 I14） | ①两个「客户端」共用一个 localStorage/clientId（同浏览器两标签页）⇒ 不经跨客户端语义也能过；②只测一个方向（手机→桌面）；③用墙钟比较（§4 已禁） | 见 §4-R10；把「不同 clientId 才能算跨端」写进前置，并回读 `read.clientId` |
| **R11** SSH（非 gateway）来源 | **需新增仪表** + **边界冲突未登记** | 现状：SSH/dsh 目标的 `/chamber/*` 被**代理层直接 404**（`packages/control-plane/src/instance-proxy.ts:432-435`），所以 SSH 源没有 watcher 面；主进程 headless 观察者=「桌面控制面消费 host 帧」，与 AGENTS.md 的边界声明（`AGENTS.md:11-12`）和 `docs/design/01-overview.md` 的移除域冲突（**推断**：至少需要 design 01/17 的例外登记） | ①「不依赖 gateway 版本」用 gateway 源冒充 SSH 源测；②只测「状态正确」不测「≤2s」（30s unary 下也正确）；③host seed 方案需重启生效（`upstream-proposals.md:118` 同款限制），未写进判据 | 见 §4-R11；二选一必须显式落成 design 变更：主进程只读观察者（登记为例外面）或 host seed（登记为需重启生效） |
| **R12** 手动停止被当完成 | **需新增仪表**（服务端**可判**，但真机 abort 样本尚未捕获；自停半条缺客户端钩子） | 事实：`api-session/status` 只有 running 位（vendor `lib/typert.host.js:2740-2742`）；但同一 pin 存在可区分的**持久**事实——`SessionEventMap` 的 `turn/end: {turn, reason: TurnEndReason}`（`typert.host.js:1717`）、`TurnEndReasonMap = completed \| aborted(reason: TurnEndCancelCause) \| blocked \| error \| …`（`:2056-2057`）、`AgentCancelCause = user \| parent \| hook \| disposed`（`:1292-1293`），客户端半可 `remote.session.follow(...)`（`lib/client.js:385-387`）。官方停止入口是 `Session.cancel()`（`lib/client.js:1738-1749`），chamber 自身没有 stop 控件（`packages/dsh-chamber-*` grep `cancel(` 无命中）⇒ 若走 follow 判定则**不需要**「发起端钩 stop」。peer 已给出同结论与最小实验（`notes/remote-state-w0-protocol.md:137-171`）。⇒「发起端立即置读」是**可选**而非唯一 seam | ①「不产生未读」是负断言：没有回合跑过也通过——必须配对正对照；②`aborted+user` 形态**尚未在真机样本上捕获过**（peer：14 个已结束会话全是 completed，`remote-state-w0-protocol.md:161`）⇒ 今天无样本时判据会空过，必须判 INCONCLUSIVE 而不是 PASS；③缺 cause（`{kind:'legacy'}`）路径必须落成「中立呈现」而不是「完成未读」；④若走 follow 判定，第三方 CLI 停止可在服务端闭合；若走 §5-12 的「自停标记已读」，判据第三分句不可判 | 见 §4-R12；判据里写明样本来源 + 无样本判 INCONCLUSIVE；若 follow 方案成立，删 §5-12 的自停标记已读与其客户端钩子需求 |
| **R13** 幽灵未读（host 已删会话） | **需新增仪表** | 现状：`api-session/removed` 只在挂载 ctx 里（`derive.ts` 无该事件消费；watcher 不存在）；桌面剪枝要靠 `listComplete`——而 `InstanceRuntimeReport` 增 `listComplete` 是 §6 破坏性变更、**§7 没有任何 W 认领生产者侧改动** | ①「≤2s 归零」只在 SSE 路径成立；polling 路径要等下个 30s unary；②「未读与徽标归零」可被 `标记全部已读`（人/脚本）代偿 ⇒ 必须断言**自动**归零；③host 删除一个「running 中」会话与「完成」会话的区别没写 | 见 §4-R13；把两条路径的时延分开写死；把 `listComplete` 生产者登记到 W1/W2 |
| **R14** 断连时未读不呈现 | **需新增仪表** + **与 §0-4/design 19 冲突** | 现状：`App.tsx:480-485` 只在 `connected` 附 runtime；`derive.ts:778-779` 文档化「not-connected 源永不携带事实」；`todo-attention.ts:80` 显式跳过断连源；而**徽标**（`badge-count.ts:55-70`）今天就会按保留账本计数（`design 19:369-371,376-378` 已登记）。「行缺席时只在待办区呈现」在 `todo-attention.ts:83-88` 没有基底（它**遍历行**；无行即无条目） | ①只测 Dock 徽标 ⇒ 今天可能已经「通过」（徽标本来就显示）；②「明确标注」无判据 ⇒ 任意文案/无标注都算过；③断连期间清掉未读（本地读动作）后重连，`max` 合并把服务端旧标记恢复 ⇒ 假复活（无判据） | 见 §4-R14；三个面（行/待办/徽标）分别列判据 + 新增 `data-chamber-stale` 标记；§0-4 的措辞必须为断连重裁 |
| **R15** SVG 丢绘空白 | **不可**（①人工；②③未排期且无仪器） | ①`svg-resource-probe --expect-artifact`：**人工、不进 CI、需控制面**（`STATUS.md:18`；`design 05:629`）；CI grep `svg-resource|scoper` = 0；②mobile 包 0 处 scoper；③无任何「产物含安装标记」的 CI 守卫 | ①`--expect-artifact` 依赖服务的是**重建产物**，在旧产物上跑会告警不判失败（脚本 :323-329 的例外分支）——「绿」可能只是没在判；②探针的触发序列是桌面 N-ctx 页（插第二份壳），对 mobile/gateway 单壳页无判别力；③「三处产物」的第三处（gateway 直连官方壳）**不加载任何 chamber 代码**（`design 17:776-779`）⇒ 没有安装点 | 见 §4-R15；把 ① 收窄成「桌面产物 + 真机 WKWebView」；② 降级为范围决策（单壳页无 N-ctx 重复定义根因）并在 design 05 §4.2④/STATUS 更新；③ 若无产品理由，删「三处」措辞 |
| **R16** 远端 blank 会话残留 | **不可**（判据与既有裁决矛盾；无归因仪表） | 现状：`STATUS.md:390` 明确「同工作区复用不增长，按已知降级接受」；根因（页面级单键 `dsh.sessions.current`）与官方行为在 `design 06:590-596`、`upstream-proposals.md:7-31`。`blank` 只在聚合行/echo 里（`derive.ts:838,1051`；`session-echo.ts:120-135`），**无「谁创建了它」的归因字段**；`data-chamber-ghost`（`ServerSection.tsx:1856`）只标「离场的 blank 占位」，不是新建计数 | ①「新增 blank = 0」被「同工作区复用」掩盖（第一源之后永远 0，仍可能每源第一次开机建 1 个）；②脚本自己点了「+」也会建 blank，无法与 hand-off 失败区分；③R16① 的 hand-off 写的是**共享单键**（`upstream-proposals.md:17-18` 明说 A 的 current 会被 B 读到、B 校验失败会清共享键）⇒ 多源启动时 hand-off 与判据互斥 | 见 §4-R16；判据改为「**无人为新建动作**时每源每代新建 blank ≤ 基线（含首次挂载 +1 的显式配额）」，并新增创建归因仪表（§5 I10） |
| **R17** 版本偏斜（旧网关） | **需新增仪表**（三档矩阵未落地；可见提示无标记） | 404 当版本事实的先例存在（`instance-proxy.ts:432-435` 用 404 `capability_not_found` 表达「无该能力」）；peer 蓝图已给出三档矩阵的可自动化方案（`notes/protocol-compat-blueprint.md:16-22`）。「可见提示」今天无 DOM 标记 | ①把 5xx/超时也当「旧网关」（peer 蓝图 :16-18 已点名）；②只测「不劣化」不测「有提示」；③用同一进程切 feature flag 冒充三档，绕过真实路由缺席 | 见 §4-R17；提示要落 `data-chamber-capability`（§5 I1 同族），并区分 404=旧 / 5xx=不可用 |
| **R18** dsh pin 事件契约变化 | **需新增仪表**（watcher 不存在）；纯函数/契约层可实现 | 事件族白名单**已可离线核对**：`dsh-api-remotes/lib/types/remote-events.js:12-32`（`approval/request`、`user-questions/request` 是 **waterfall**；`api-session/*` 是 emit）；`api-session/status` 只有 running 位（`typert.host.js:2740-2742`） | ①契约测试只断言事件**名字**在（typert 列表里就有），不断言 payload/到达语义 ⇒ 假绿；②降级路径全绿 = 只证明 polling 档能跑，不证明不劣化；③**丢帧/静默半死不在判据里**（`upstream-proposals.md:61-95`：emit 无重传、无应用级 keepalive、唯一收敛路径是连接代重置）——这是 watcher 自身的真实失效面（见 §5 遗漏 R21） | 见 §4-R18；契约测试要含 payload 形态 + 「无重放」负例 |
| **R19** 多 server 混合升级 | **需新增仪表**（能力状态一览 UI 无归属；无混合版本 harness） | 现状无「每来源能力状态」投影；三档矩阵若要真双版本需两个 gateway（peer 蓝图建议 stub；`install-gateway.sh update --version` 是人工门，:21-22） | ①「逐 server 签核」靠人填表 ⇒ 不可复现；②只读一个 server 的能力就推断混合态；③用「version 数字」而不是 `features[]` 判能力（§4 明文要求） | 见 §4-R19；把「能力状态一览」登记到 W4 并落 DOM 标记；混合态判定数据源统一走 `features[]` |
| **R20** 90s 未验证清位导致假完成 | **需新增仪表**（前提是**新 polling 档**的失效模式；今天无常量外的现网路径） | 事实：`packages/renderer/src/aggregate-refresh.ts:248`（`AGGREGATE_UNVERIFIED_FACTS_MS=90_000`）、`250-258`、`App.tsx:1673-1693` 只清**聚合 running 位**并进「无法确认」横幅；纯函数边界有单测（`packages/renderer/test/aggregate/aggregate-refresh.test.ts:721-747`）。而完成蓝点读的是**通道 running**（`derive.ts:494-532`），不是聚合行 ⇒ **今天 90s 清位不会武装蓝点**（**推断**：R20 标题描述的「假完成」是未来 polling 档的风险，不是现有缺陷） | ①判据「注入读取失败 ⇒ 零未读」今天**恒真**（没有能产生未读的 polling 路径）⇒ 自证式；②只注入读失败而不构造**候选假完成**（一个 running 中、事实被清位的会话）⇒ 测了个空；③把 watcher 可被杀与 host 停机混为一谈（R20 最需要的注入是「读通道失败但写通道/事件在」） | 见 §4-R20；判据改成「构造 running 会话 → 注入读失败到界限 → 断言未读不被武装，且**正常完成仍能武装**（正对照）」 |

---

## 4. 判据改写建议（可直接粘贴）

> 约定：每条给出「前置 / 动作 / 判据 / 反作弊」，直接替换主计划 §8 对应条目下的「判据：」行即可；
> 新仪表引用 §5 的 I 编号。

### R1

> **判据**：前置 = 目标远程源已挂载过并被保留策略回收（脚本先断言该源 `[data-instance]` 不存在、
> 且快照 `dom.views.hidden ≥ 2`，否则 FAIL）。动作 = 在该源上跑一个短回合（由远端 CLI/官方 API 触发），
> 记录 host 侧完成时刻 `t_c`（取 watcher 事实里的 `completedAt`/`updatedAt`，I5）。判据 = 在**可见窗**内，
> 行尾状态（I1 `data-chamber-session-state="completed"`）、待办条目（I2）、Dock 徽标（I3 回读）三面
> **都在 `t_c + 2s` 前**出现；三面缺一即 FAIL。反作弊 = 起点必须是 `t_c`（不是脚本轮询时刻）；
> 三面必须分别断言；前置不满足按 FAIL 不按 INFO。

### R2

> **判据**：①纯函数：对同一 `(sessions, completedAt, updatedAt, readMark)` 输入，`deriveUnread()` 的输出
> 与实际渲染的蓝点集逐项相等（node:test，含撤回/重挂夹具）。②行为级：注入 store 使目标源 armed →
> 触发 producer clear → 重新注册并推一份**无 completed 位**的事实 → 蓝点仍存在（由 `completedAt` 重算）。
> ③接线：`App.tsx` 撤回分支不得出现对账本的删除（源码锁允许存在，但它**只是附加**，不作主判据）。
> 反作弊 = 不得用文本锁替代 ②；`deriveUnread` 不得读取任何账本状态（其签名里不许有 `completedBySource`）。

### R3

> **判据**：前置 = 清空本地未读存储并按 I14 记录 `clientId`。动作 = 关桌面 → 期间在远端完成一个回合
> **并另起一个被手动停止的回合** → 重启桌面。判据 = ①完成会话在首帧后 ≤5s 呈现未读；②被停止会话
> **不得**呈现未读（这条是 R3 缺口重建的反例，与 R12 同源）；③同一运行内必须有一条实时完成通知作为
> **正对照**，否则「无补发通知」判 FAIL（证明不了通知面是活的）。反作弊 = 清本地存储；正对照缺失即 FAIL。

### R5

> **判据**：前置 = 目标源**无任何 `[data-instance]`**（不是 `instance-pending`，是未挂载）。动作 = 远端产生
> 一次审批请求 → 再解除。判据 = ①请求出现后 ≤2s 内待办区有 `pending=approval` 条目（I2）且行尾（若行在）
> 为 pending；②解除后 ≤2s 内条目消失；③观察者存在时，从**真实 UI 客户端**应答的往返行为与观察者缺席时
> 一致（对照）。反作弊 = 必须正反两向；必须证明观察者未参与 waterfall 决议（日志/契约断言）。

### R6

> **判据**：①纯函数：同一 `(sourceFingerprint, sessionId, 内容水位)` 重放 → 零事件；新水位 → 恰好一次
> 事件（renderer 层；键按 `notes/protocol-compat-blueprint.md:464-467`）。②端到端：实时完成既有蓝点又有
> 通知（正对照）；离线完成只有未读、无通知（负断言，依赖 ① 证明通知面活）；撤回窗口内完成与窗口内手动
> 停止各一例，前者不得产生假未读、后者不得产生未读。反作弊 = 负断言必须与正对照同批执行。

### R7

> **判据**：前置 = ≥2 个已打开过的来源（脚本断言两个 `[data-instance]` 均曾 settle）。动作 = A→B 切换 ×N
> （真实鼠标按 `[data-chamber-section]` 定位）。判据 = 过程逐帧采样（I7，`Page.startScreencast`，≥30fps）中，
> **内容区**（定义 = 活动 `.instance-view` 内 composer 座 ∪ 会话流 ∪ 侧栏的并集外接矩形）没有任何一帧
> **无 ink**（该矩形像素与同来源同主题的稳定帧差异 < 阈值，且该帧既有旧视图、也无遮罩、也无新内容）；
> 首访（从未打开源）当场有遮罩帧且遮罩底色取自目标来源缓存调色板或 chamber 暗色（I1 的
> `data-chamber-veil-palette` 或 `data-vt-intent` 同族标记）。反作弊 = 无 screencast 帧 / 切换未真实发生
> ⇒ FAIL（`--require-switch`），不得记 INFO；不得把「遮罩在 DOM」当「画了内容」。

### R9

> **判据**：前置 = 目标源无壳且窗口可见。动作 = 远端跑一个短回合 + 新建一个会话。判据 = ①`t_c`（I5）后
> ≤2s 内该源事实（行状态/待办）更新；②新会话在`t_new`（watcher 的 `session-added` 时间）后**恰好一次**
> 指向该源聚合端点的请求（CDP `Network.requestWillBeSent` 计数，URL 模式 `/api/i/<id>/api/session/list`），
> ≤2 次记 FAIL。反作弊 = 隐藏窗不测（另判）；挂载源不测（push 天然满足）。

### R10

> **判据**：前置 = 手机端与桌面端 **clientId 不同**（各自回读 I14）。动作 = 手机上打开会话 A 并停留 → 桌面
> 未读应 ≤2s 熄灭；反向再来一遍。判据 = 两个方向都在 ≤2s 内、且服务端 `read` 回读的新 `readMark` 等于
> 该会话当时的 `max(updatedAt, completedAt)`。反作弊 = 同一 clientId 的两标签页不算跨端；只测单向记 FAIL。

### R11

> **判据**：前置 = 该来源 transport = ssh/dsh（不是 gateway），无壳。动作 = 远端完成一个回合 + 一次审批请求。
> 判据 = ①完成与 pending 都在 ≤2s（若选事件通道）或 ≤1 个 unary 周期且 UI 显示「状态精度受限」（若选
> polling）内正确呈现；②不依赖该来源的 gateway 版本（`features[]` 里无对应能力也成立）；③方案选择
> （主进程只读观察者 / host seed）已在 design 文档登记为**有界例外**或「需重启生效」的显式约束。
> 反作弊 = 不得用 gateway 源冒充；两类延迟必须择一写死，不得「≤2s 或 30s 都算过」。

### R12

> **判据**：拆三条。①本机停止：一个 running 回合 → 本机点官方停止 → 断言本机**不产生未读**（I1/I2/I3 三面）
> 且同批一个正常完成**产生**未读（正对照）。②另一客户端停止：手机/第二 clientId 停止 → 桌面不得产生未读。
> ③第三方 CLI 停止：watcher 在 `api-session/status` 的 true→false 边沿为该会话开一条 `session.follow`，
> 读到最后一条 `turn/end.reason`（vendor `lib/typert.host.js:1717,2056-2057`；客户端 `lib/client.js:385-387`）：
> `completed` ⇒ 可武装未读；`aborted+user` ⇒ 不武装；`aborted` 缺 cause/`legacy` ⇒ **中立呈现**（不武装、不误报）；
> 判据 = 三种样本各一，缺 abort 样本时判 INCONCLUSIVE（**不得 PASS**，peer 记录该样本尚未捕获：
> `notes/remote-state-w0-protocol.md:161`）。反作弊 = ①② 必须带正对照；③不得用「UI 呈中立项」替代「不产生未读」；
> 不得以「上游未给 reason」为由跳过（reason 已在 pin 内）。

### R13

> **判据**：①SSE 路径：host 删除会话后 ≤2s 内该会话的未读与徽标自动归零（不借助 `标记全部已读`）；
> ②polling 路径：≤1 个 unary 周期 + 2s；两条分开记。反作弊 = 脚本不得调用「标记全部已读」；
> 必须断言是**自动**归零（记录归零发生在无用户动作的窗口里）。

### R14

> **判据**：前置 = 某来源断开（tunnel 停/托管 down），且断开前该源有 1 条未读。判据 = ①连接页/侧栏该源带
> `data-chamber-stale="1"`（I13）；②若行仍在：行尾状态仍呈现未读；③若行缺席：待办区出现「离线未读」条目
> （I2 `stale=1`，显示 `sessionId` 兜底标签，`derive.ts:104-122`）；④Dock 徽标与 ①—③ 的集合一致
> （三面同源），或 §0-4 为断连场景显式改写为「徽标暂时计、行/待办不显示」并同步 design 19 §3.7。
> 反作弊 = 只测徽标不算过；「明确标注」必须是可查询属性，不是文案。

### R15

> **判据**：①桌面产物：重跑 `build:renderer` 后 `node scripts/dev/svg-resource-probe.mjs --expect-artifact`
> 在**打包/重建产物**上 fix 组不变量全过且 `artifactPrewired=true`（脚本 :339）；控制组不适用例外必须显式
> 打印（:323-329）。②CI 守卫（**新**）：`packages/desktop/dist/web/assets/chamber-*.js` 必须含 scoper 安装
> 标记，缺失即失败——这是唯一能进 CI 的一条。③mobile/gateway 覆盖：作为**范围决策**显式登记
> （单壳页无 N-ctx 重复定义根因，`design 05:624-631`④），默认**不做**；若做，需自己的触发序列脚本，
> 不得把桌面探针的结果当它。反作弊 = 「三处产物绿」删掉，改为「①+② 绿；③ 未做也要写未做」。

### R16

> **判据**：前置 = 脚本断言本次运行**没有任何人为新建**（不点「+」、不提交 prompt）。判据 = 每个来源
> 在「首次挂载 +1 配额」之外的 blank 新建数 = 0（归因仪表 I10 提供 `createdBlank` 计数与 `origin`）；
> 首次挂载若建 blank 必须记 `origin=boot-handoff-fallback` 并计入配额。反作弊 = 不得只测第二个源
> （同工作区复用天然为 0）；不得用「侧栏看不到 blank」代替计数（非 current 的 blank 行按官方规则
> 不在投影里，`derive.ts:1157-1174`）；hand-off 在多源并发挂载下的共享键互踩必须在判据里留反例条目。

### R20

> **判据**：前置 = 目标源有一个 running 会话（真实回合在跑）。动作 = 让该源的**读路径**失败（unary 恒错或
> watcher 读被注入失败，I12）并持续到 `AGGREGATE_UNVERIFIED_FACTS_MS` 界限（`aggregate-refresh.ts:248`）；
> 期间让该回合**正常结束**。判据 = ①未读**只在**权威事实（事件/成功读）到达后产生，失败窗口内零未读；
> ②同一运行里另一个正常源完成必须能产生未读（正对照）；③界限后聚合 running 位按既有语义被清并进
> 「无法确认」横幅（既有行为，不回归）。反作弊 = 没有 ② 则 FAIL；只注入「读失败」而不构造候选假完成
> （running 事实被清）等于没测。

---

## 5. 新增仪表清单

| # | 仪表 | 落点（建议） | 服务的 R | 判据形态 |
|---|---|---|---|---|
| **I1** | 行状态稳定标记 `data-chamber-session-state`：`none|running|subagents:N|pending:approval|pending:plan-review|pending:question|completed` + `data-chamber-state-source=wire|channel|derived|stale` | `ServerSection.tsx:2072-2079` 的状态槽（与既有 `title/aria-label` 并存，不改渲染） | R1/R2/R5/R12/R13/R14/R17 | DOM 断言，免文案/哈希类名 |
| **I2** | 待办条目标记 `data-chamber-todo="sourceId:sessionId:kind"` + `data-chamber-stale` | `SessionTodoArea.tsx`（条目组件） | R1/R5/R13/R14 | 同上 |
| **I3** | 徽标计数回读 `window.__dshChamberBadgeCount`（dev/debug 门控）或主进程 getter | `App.tsx:4126-4145` 的推送点 / `packages/desktop/badge.ts` | R1/R2/R13/R14 | 与 I1/I2 集合逐项相等 |
| **I4** | 通知事件账本（dev 门控环形缓冲）：`{sourceId,sessionId,kind,watermark,decision:sent|suppressed|deduped|skipped}` | `App.tsx` 通知组装点 + `notifications.ts:316-330` claim 结果 | R6/R3 | 「同源」+ 正/负对照的机器判据 |
| **I5** | 事实时间戳：watcher 响应每行带 `factAt`；前端把每行/条目的 `factAt` 落 `data-chamber-fact-at` | 协议 §4 行字段 + I1/I2 元素 | R1/R3/R9/R10/R13 | `t_c + 2s` 可测 |
| **I6** | watcher 自诊断：`features.diagnostics = {eventsReceived,lastEventAt,gapsDetected,resyncs}`（只读） | `GET /chamber/session-state` | R18 + 遗漏 R21 | 丢帧可见、可注入 |
| **I7** | 逐帧绘制采样器：`Page.startScreencast` + 内容矩形 ink 采样（新增 `scripts/gui-acceptance/paint-probe.mjs` 或在 `walkthrough.mjs` 增腿，判据进 `checks.mjs` 纯函数） | `scripts/gui-acceptance/` | R7（+R8 首帧） | 见 §4-R7；`--require-switch` 严格档 |
| **I8** | 预热命中率计数 `prewarmAttempts/prewarmHits/prewarmCancelled`（分来源） | `App.tsx` 预热队列 + measure-ui schema v2 | R8 | ≥80% 可判 |
| **I9** | `switch-measure` 参数化 + 失败响亮：来源/工作区按 `[data-chamber-section]` 定位；`NOROW/HIDDEN` 即 FAIL；补 `paintSeen` | `scripts/perf/switch-measure.mjs:46-62,109-110` | R8/R7 | 消除「点不中反而更快」 |
| **I10** | blank 新建归因：`session.create` 回声里带 `origin=user|boot-handoff|boot-fallback|unknown` 与每源计数 | `packages/dsh-chamber-client-ui-sidebar/src/shared/session-mutations.ts:42-53` + `session-echo.ts` | R16 | 「配额外的 blank 新建 = 0」 |
| **I11** | 契约矩阵 harness：桌面 `SessionFactsSource` 注入式 transport（`search-state.ts` 的 `setSearchFetcher` 先例）+ gateway harness 三档 | `packages/renderer/test/**` + `packages/gateway/test/support/**` | R17/R18/R19 | CI 可红绿 |
| **I12** | 故障注入钩子：①watcher 读失败（unary 恒错）②watcher 被杀/重启 ③**host→watcher 事件流丢弃/半死**（关闭 mux 或丢帧）④`/read` 写失败 | gateway harness + 桌面注入；GUI 侧可复用 `Network` 域拦截 | R3/R4/R9/R12/R20 + 遗漏 R21/R22 | 「不假未读 / 不丢真未读」成对断言 |
| **I13** | `data-chamber-stale`（来源节/行/待办条目） | I1/I2 同族 | R14/R17 | 「明确标注」机器化 |
| **I14** | `read` 回读含 `{clientId, readMark, updatedAt, completedAt}` 与来源级有效水位 | 协议 `GET /chamber/session-state` | R4/R10/R14 | 跨端/重启可判 |
| **I15** | GUI 腿严格旗标 `--require-switch`（同 `--require-hover` 语义） | `scripts/gui-acceptance/run.mjs` | R7/R8/R1/R14 | INFO 未执行不得读成绿 |
| **I16** | follow 完成分类器：running→idle 边沿为会话开一条 `session.follow`，读最后一条 `turn/end.reason` ⇒ `completed` / `aborted+user` / `legacy/缺 cause ⇒ 中立`；计入 watcher 诊断（每条 turn 一条流、成本可见） | gateway watcher（W1）或桌面只读观察者（W6） | R12（+R3 缺口重建） | 三类样本各一；缺 abort 样本判 INCONCLUSIVE |

---

## 6. 遗漏与重复

### 6.1 同根因重复计数（**事实**级证据，**推断**级归并）

| 根因 | 被判为独立残留 | 证据 |
|---|---|---|
| 完成事实只在挂载壳的通道里，撤回即删 | R1（回收）、R2（重挂/撤回）、R6（撤回窗口通知） | `App.tsx:3937-3971`、`client/index.ts:641`、`aggregate-store.ts:793-796` |
| 没有服务端持久事实与读水位 | R3（关闭）、R4（重启）、R10（跨端） | `/chamber/session-state*` 不存在（glob 无文件、`gateway/src/routes.ts:3-30` 无该路由） |
| 只按 running 位推结论、不用结束原因 | R12（手动停止）、R3 的缺口重建 | `api-session/status` 只有 running（vendor `typert.host.js:2740-2742`）；**同 pin 的 `turn/end.reason` 可区分**（`typert.host.js:1717,2056-2057`）却未被任何残留用作判据 ⇒ R3 的缺口重建式与 R12 是同形缺陷，可用同一事实（follow）修掉 |
| 事实面只在挂载 ctx | R1、R5（pending） | `derive.ts:570,589-590`、`todo-attention.ts:80,87-90` |
| 版本/能力协商 | R17（网关协议）、R18（dsh pin）、R19（混合升级） | 三者共用 `features[]` + 契约矩阵（§4/§6） |
| 视图/绘制 | R7（白屏）、R8（首访延迟） | 同一冷 boot 窗口的两个指标；R7 无仪器、R8 有帧间隔指标 |

**推断**：§8 的「20 条」在完成度叙事上会重复计入同一根因；建议 §8 增加「根因簇」列，
出口判据按簇（事实源簇 / 持久化簇 / 停止判据簇 / 协商簇 / 体验簇）计数，或明确写出「R1–R4 由 W1+W2
一次性闭合」。

### 6.2 建议新增的残留

- **R21 watcher 事件源自身丢帧 / 静默半死**（**事实**：`api-session/status` 是 emit 型、无重传、
  `$events` 开场帧不重放，官方唯一收敛路径挂在连接代重置上；`/api/remote.mux` 只有 WS 级 ping/pong，
  浏览端观测不到——`docs/progress/todo/upstream-proposals.md:61-95`；转发白名单
  `dsh-api-remotes/lib/types/remote-events.js:12-32`）。§10 的故障注入列表只有「watcher 被杀 / host 停机 /
  读取失败 / 时钟偏斜 / 游标过期」，**没有**「流还在但帧丢了」。判据：丢帧注入后 watcher 必须在
  `≤N s` 内自愈（`session.list` 对账）或把该源标 `unknown`，不得沉默地把 running 停在 true / 停在 false。
- **R22 读动作与读水位的失败/单调性**：`POST /read` 失败或断连时本地标记如何回滚；重连后 `max` 合并
  是否会把「断连期间的本地清除」抹掉；`readMark` 是否严格单调（host 时钟回拨 / 会话时间戳倒退）。
  今天 §4 只写了「幂等 upsert」，§10 只注入「读取失败」不注入「写标失败」。判据：写失败 ⇒ 本地兜底生效
  且**不假未读**；读水位单调不降。
- **R23 blank 会话的创建归因面**（R16 的仪表缺口）：没有归因就区分不了「官方冷 boot 自建」与
  「用户新建」，R16 的「回归即红」不可判定。判据见 §4-R16 + I10。

### 6.3 §0 八条判据 → 残留 / 里程碑覆盖检查

| §0 判据 | 覆盖残留 | 覆盖 W | 缺口 |
|---|---|---|---|
| 1 关壳后 running/waiting/完成 ≤2s | R1（完成）、R5（pending）、R9（事实） | W1/W2/W3 | **running 环**无残留：`derive.ts:868` 的环只信聚合 wire，未挂载源只有 30s unary ⇒ §0-1 的 running 与 R9 的 ≤2s 互斥（见 §2.3）；且「≤2s」未限定可见窗 |
| 2 关闭期间完成 → 启动即未读 | R3 | W1/W2 | 「不补发通知」缺正对照（§4-R3） |
| 3 重启/崩溃/重挂/回收：不丢不假 | R2、R3、R12、R13 | W1/W2/W4 | 「不假」的三条反例（期间被停止、host 删除、读失败）分散在 R3/R12/R13/R20，§8 没有把它们收进同一判据 |
| 4 四面同源同规则 | R1/R2（蓝点+徽标）、R6（通知） | W2 | **与 design 19 §3.7 的两处已登记分叉冲突**（§0-3 摘要）；「同源」无机器判据（I4） |
| 5 切源无白屏帧 / 首访有主题化进度面 | R7 | W3 | 无仪器（I7）；`--dev` 单源空跑；R7①与 P2 `cut` 冲突 |
| 6 pending 无壳可见可待办 | R5 | W1 | 「解除」方向与 waterfall 参与边界未写 |
| 7 偏斜不劣化 / 混合升级各自正确 | R17/R18/R19 | W1/W2/W4 | R19 的「能力一览」无 W 认领；R18 不含丢帧（R21） |
| 8 每条残留都有闭合路径与判据 | — | — | **R12③/R15②③/R16 没有仓内闭合路径**（§0-6 摘要），本判据自相矛盾；且「不以接受结案」与 STATUS:390 的已知降级并存 |

### 6.4 §8 中无 W0–W7 归属的条目（**事实**：§7 各 W 的「内容/出口判据」逐条比对）

| 无归属项 | 说明 |
|---|---|
| R15② mobile/gateway 安装 scoper | W5 只写「手机端接入读水位」；W0④ 只写「SVG scoper 真机验收」 |
| R15③ CI 守卫（产物含 scoper 标记） | 无任何 W |
| R16① 分源选区 hand-off | W7 只写「根治走上游 selection scope」；缓释实现无归属 |
| R16②「计入验收指标」 | W4 有「度量面与验收脚本」，但无 blank 计数仪表（I10） |
| R13 的 `InstanceRuntimeReport.listComplete` 生产者侧 | §6 列为破坏性变更，§7 无 W；W1 只写 watcher 三条路由 |
| R19 的「各来源能力状态一览」 | W4 只有验收脚本；无 UI 归属 |
| R6 的「启动聚合摘要（可选）」 | W4 有；但其判据（摘要是否假报「刚发生」）无仪器 |
| R8 的「预热命中率 ≥80%（度量面记录）」 | W3 出口判据不含命中率；度量面在 W4 |

---

## 7. 对主计划 §0 / §8 / §9 / §10 的修订建议

### §0（八条判据）

1. 判据 1 改为：「**在窗口可见、目标源无壳**时，完成事实 ≤2s 反映到行尾/待办/徽标三面；running 位的
   反映时延另计并写明通道（挂载 push / watcher 事件 / unary 兜底及其周期）」——把 running 与完成分开，
   否则与 `derive.ts:868` 的 wire 权威 + 30s 兜底互斥。
2. 判据 4 与 design 19 §3.7 二选一：要么为断连与 vendor-only 完成重裁（写进 design 19 修订），
   要么判据 4 加限定「在同一事实源可及的面上同源同规则」。**推断**：不重裁就会在 R14 落地时把
   design 19 的诚实边界判成缺陷。
3. 判据 8 改为：「每条残留必须给出**仪器 + 环境 + 严格旗标**三件套；(a) 依赖未落地项的残留必须在 §8
   标注『未闭合 + 归属 W/上游』并**不计入完成度**；(b) 至少 R15②③/R16 按此标注；R12③ 归「待样本」
   （缺真机 abort 样本 ⇒ INCONCLUSIVE，同样不计入完成度）。」
4. 新增第 9 条（可执行性判据）：「任何以 CDP/真机为环境的判据，必须登记一条 `--require-*` 严格档或
   一个 CI 可判的替代；只写『CDP 采样』而没有仪器/严格旗标的条目视为未定义判据。」

### §8（残留表）

1. 每 R 增加三列：**仪器**（I 编号或「无」）、**环境**（CI / dev / attach / 真机 / 上游）、**归属 W**
   （缺失即标 unowned）。§6.4 的表可直接并入。
2. R1–R4 合并为一个「事实源与持久化」簇，出口判据共用（但保留各自的触发场景作为验收矩阵行），
   避免把同一根因计 4 次。
3. R3 的缺口重建式与 R12 的口径必须一致：重建只能产出「**疑似完成**」并在无 turn-end reason 时
   呈中立位（不得武装未读），否则 R3 的判据与 R12 互相拆台。**推断**：这条不改，B 轨下必然在
   watcher 重启/桌面关闭窗口引入假未读。
4. R6 去重键统一到 peer 蓝图（`notes/protocol-compat-blueprint.md:464-467`），删掉 R6 里的
   `completedAt` 键或改为「内容水位 ∪ completedAt 的单调合并值」并写进 §4 协议。
5. R7 增加「与 P2 `cut` 的关系」一句（旧视图保留不得与新遮罩 crossfade），并把判据改为 §4-R7。
6. R15②③/R16 移入新的「未闭合（上游 / 范围决策）」小节；R12③ 移入「待样本（INCONCLUSIVE）」小节，
   两者都不计入 §8 完成度。

### §9（验收矩阵）

1. 每行补「仪器 / 环境 / 严格旗标」三列；「≤2s」「≤1 次往返」等量词必须带起点定义（`t_c` = 哪一个
   时间戳，I5）。
2. 「关壳」行补前置：断言回收真的发生（`dom.views.hidden ≥ 2` 且目标 `[data-instance]` 不存在），
   否则 FAIL 而非 INFO。
3. 新增两行：①watcher 事件流丢帧/半死（R21）；②`/read` 写失败与断连读动作（R22）。
4. 「视图：已打开来源切换无白屏帧」行改为引用 §4-R7 的判据与 I7，并声明无 screencast 帧即 FAIL。

### §10（测试与度量）

1. 故障注入补三项：**host→watcher 事件流丢帧/半死**、**`/read` 写失败**、**watcher 重启窗口内发生停止**
   （R3/R12 交叉反例）。每项都要有正对照（同一运行里一次正常完成必须产生未读/通知）。
2. 「接线锁」条目降级为**附加**证据，明确「源码文本锁不得作为唯一判据」（现行 `wiring/*.test.ts`
   模式可继续用，但主判据必须是行为级：§4-R2）。
3. 「性能」条目补：measure-ui schema v2（`mountedShells` 已有语义、新增 `prewarmHits`、`switchPaint`）；
   基线按同环境 A/B（`scripts/perf/README.md:31-35`），且 `switch-measure` 的 `NOROW` 必须 FAIL（I9）。
4. 新增「仪器与严格档」小节：登记 I1–I16，并写明「GUI 腿未执行记 INFO ⇒ 不得作为完成证据」。
5. 「实机矩阵」补一列「该格用哪条 I 判」；矩阵里「网关升级 / host 停机」两格要各自写明用的是
   404（旧）/5xx（不可用）哪一种探测（peer 蓝图 :16-18）。

---

## 8. 证据索引（便于复核）

- vendor（**打包 `0.1.5-rc.2`**，与 `packages/desktop/vendor/dsh/pnpm-lock.yaml:298`、`harness.commit` 同 pin）：
  `dsh-api-session-controller/lib/index.js:1969-1971`（updatedAt）、`:1751-1754`（lastPromptAt）、
  `:2761-2768`（activity）、`:218-239`（added/removed/status/activity 映射）；
  `lib/types/list.js:30-35`；`lib/typert.host.js:2740-2742`（status 只有 running 位）、
  `:1717,2056-2057,1292-1293`（`turn/end` + reason + cancel cause）；
  `lib/client.js:385-387`（客户端 `session.follow`）；
  `lib/types/index.js:238`（activity 条件）；`lib/types/client/sessions/manager.js:30-32,376-377,775-801`
  （内存态完成提醒）；`lib/client.js:1738-1749`（`Session.cancel()`，官方停止入口）；
  `dsh-api-remotes/lib/types/remote-events.js:12-32`（转发白名单；approval/user-questions 是 waterfall）；
  `dsh-client-ui-theme/lib/client.js`（`body{--dsw-alias-bg-base:…00 #fff}` 与 `body[data-ds-dark-theme]…`）。
- 本仓：`App.tsx:208,460-500,1645-1695,2560-2588,3930-4088,4090-4146`；
  `retention.ts:39,42,99-133`；`derive.ts:104-122,494-532,560-598,778-803,868-870,895-926,1143-1174`；
  `todo-attention.ts:71-138`；`badge-count.ts:38-70`；`ServerSection.tsx:367-419,2058-2109`；
  `aggregate-store.ts:769-813`；`aggregate-refresh.ts:228-258`；`session-liveness.ts:58,174`；
  `packages/renderer/src/notification-edges.ts:64-88`；`packages/desktop/notifications.ts:250-330`；
  `packages/control-plane/src/instance-proxy.ts:428-436`；`packages/gateway/src/routes.ts:3-30`；
  `packages/dsh-chamber-client-ui-sidebar/src/client/index.ts:600-642`；
  `styles.css:36,100-133,205-231`；`view-transition.ts:35-44,104-145`。
- 文档：`docs/design/05-connection-manager.md:440-442,624-631,782-784`；
  `docs/design/06-sidebar-enhancements.md:590-602`；`docs/design/19-notifications.md:305-334,345-384`；
  `docs/design/17-server-side-gateway.md:774-800`；`docs/progress/STATUS.md:18,23,388,390`；
  `docs/progress/todo/upstream-proposals.md:7-31,61-118`；
  `docs/progress/todo/notes/protocol-compat-blueprint.md:16-31,464-467`；
  `docs/progress/todo/notes/remote-state-w0-protocol.md:100-135`（pending waterfall 与观察者纪律、提问型无持久事件）、
  `:137-171`（turn/end reason 与最小实验）。
- 工具：`scripts/perf/measure-ui.mjs:88-100,170-177`；`scripts/perf/switch-measure.mjs:46-62,95-100,109-110`；
  `scripts/perf/data/`（无 measure-ui 基线）；`scripts/gui-acceptance/walkthrough.mjs:288-361,567`；
  `checks.mjs:770-803`；`scripts/gui-acceptance/cdp.mjs:85-95,146-151`；`scripts/gui-acceptance/README.md:50-57,161`；
  `scripts/dev/svg-resource-probe.mjs:12,323-339`；`packages/renderer/test/wiring/session-liveness-wiring.test.ts:1-40`。
