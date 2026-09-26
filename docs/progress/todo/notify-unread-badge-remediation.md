# 通知 / 未读 / Dock 角标 结构整改（方案 · 证据 · 删除清单）

- **状态**：部分落地（W0a 未读仪表 + W0b `facts-health maxWatermark` + W0c 角标腿读数 + W0d 注释修正已落代码并过套件；Swift 腿与 W1+ 未落地）。本文是本项开放工作的唯一记录入口；落地后删除本文，结论回到 `docs/design/19-notifications.md`，发布说明另见 `CHANGELOG.md`。
- **范围**：`packages/renderer`、`packages/desktop`、`packages/dsh-chamber-client-ui-sidebar`、
  `packages/dsh-stream-state`、`macos/Sources/DSHChamber`。**不动** `packages/gateway`、不改进 vendor、不新增运行时依赖。
- **术语**：**facts 轨** = 来源事实快照（local 走 mux 观察者，gateway 走镜像）；**通道轨** = 壳运行时上报的
  `runtime[sessions]`；**易失态** = `armed/pending/settleFence` 等只活在内存/被撤回清空的态；
  **durable** = `notifiedRuns/outcomes/read` 等落盘且只允许显式动作改写的态。

## 0. 行为冻结（实施期间不得改变的用户可见行为）

1. 设置里的 `notifications.enabled / mode / badgeEnabled` 语义：关闭即不弹 / 关闭即清角标，重新开启恢复上一次计数。
2. 真实回合结束 → 恰好一条完成通知；通知的 `sourceId / sessionId / title / kind` 正确。
3. 未读点与 Dock 计数**同源同集合**（六面一致：侧栏点、搜索行、Dock、账……）。
4. local / gateway / SSH 多来源并行可用；单来源失效不影响其他来源。
5. 归档清理（purge）的判定与抑制行为不变——只是不再改写未读账本。
6. 关窗 / 退出清角标；诊断面保留（authority-log、facts-health、incident、notification-ledger）。
7. §6 的 4 个策略问题**裁决前保持现状**。

删除纪律：**先锁后删**——替代机制落地并通过验收后才删旧件；仅 §4「例外」两处现在就是错的断言/注释，可立即处理。

## 1. 证据与复现

### 1.1 活体证据（2026-09-26 UTC，本机 0.4.0-beta.4，页面 `http://localhost:17500/`）

| 观察 | 数值 | 含义 |
|---|---|---|
| 权威日志 | `status=0:row=1` → ~20s → `complete …(official-stop)`：11:07:03→11:07:23、11:11:34→11:11:53 | 假完成的签名 |
| 通知决策账 | 2/2 都指向当时**正在运行**的 `session-e440f9dc`：11:19:57 `sent`、11:25:31 `suppressed by focus` | 用户可见的假通知 |
| 未读载荷 | `{read:{}, edge:{}, notifiedRuns:{local:31,…}, pending:{}, outcomes:{…}}`（跨 6h、跨重载） | 未读面从未落账 |
| facts-health | `local ready=1 rows=113 baselines=1 baselineFailures=0 reason=-`（11:19:29） | facts 通道健康 |
| inspector | `BADGE_DESIRED=0` 而 OS Dock 值为大数 | 角标陈旧（呈现层） |
| 环饥饿 | kinds 只剩 `probe/status-divergence/complete`，`facts-health` 曾被挤出 | 观测面不可用 |

### 1.2 复现片段（无重建；Safari → 开发 → 本机 → dsh-chamber）

判别目标页（必须是 app 的 WKWebView，`keys≈280`）：

```js
({ href: location.href, shellFacts: typeof dshChamberFacts, keys: Object.keys(localStorage).length })
```

读通知/角标/未读现场：

```js
(() => {
  const N = window.__dshChamberNotifications, I = window.__dshChamberIncident, s = x => JSON.stringify(x).slice(0, 2200);
  console.log('BADGE_DESIRED=' + window.__dshChamberBadgeCount);
  console.log('NOTIF=' + s({ counts: N && N.counts(), reconcile: N && N.reconcile(), total: N && N.total() }));
  console.log('NOTIF_LAST=' + s(N && N.entries().slice(-8)));
  console.log('INCIDENTS=' + s(I && I.entries().slice(-12)));
  console.log('UNREAD=' + (localStorage.getItem('dsh-chamber.unread.v4') || '').slice(0, 900));
})()
```

读 facts-health 与来源表：

```js
(() => {
  const L = JSON.parse(localStorage.getItem('dsh-chamber.authority-log.v1') || '{}');
  for (const [src, arr] of Object.entries(L)) for (const e of arr) if (e.kind === 'facts-health')
    console.log(src, new Date(e.at).toISOString().slice(11,19), e.detail);
  const v4 = JSON.parse(localStorage.getItem('dsh-chamber.unread.v4') || '{}');
  console.log('readSources=' + Object.keys(v4.read||{}).join(',') + ' edgeSources=' + Object.keys(v4.edge||{}).join(','));
})()
```

读数口径：`__dshChamberBadgeCount` 是**渲染端派发前**发布的期望值（`use-badge-count.ts:187`），
不等于 OS 已应用值；「期望 == Dock 实际」是 W4 的验收判据，Dock 实际值在 W0 后进 shell 日志。

- **W4 实机读数（2026-09-26 新增）**：Swift 腿每次**真写**记一行 `<userData>/logs/shell.log` ——
  `[shell] badge write count=<N> applied=<B> label=<L>`；`applied=false` = 写后读回不等于意图（OS 未接受），
  `count=` 即 renderer 那一次的期望值（`__dshChamberBadgeCount` 同一时刻的值）。「期望 == Dock 实际」因此可直接比对：
  大数字陈旧 ⇒ 要么 `count=<大数>`（renderer 真的还在算全表未读，回 W1）要么 `count=0 applied=true` 而 Dock 未变（宿主/OS 侧，回 W4）；
  清 0 干净 ⇒ 最后一行为 `count=0 applied=true label=nil`。

盘侧核对（不依赖页面）：WebKit 存储 `~/Library/WebKit/com.dshchamber.native/WebsiteData/Default/*/*/LocalStorage/localstorage.sqlite3`
—— 用 `sqlite3` 取 `hex(value)` 后按 UTF-16LE 解码即可读 `dsh-chamber.unread.v4` / `authority-log.v1`（本方案全部读数均以此为准）。
注意 `node:sqlite` 返回 `Uint8Array`，须 `Buffer.from(v).toString('utf16le')`（`Uint8Array.toString('utf16le')` 会得到逗号字节串）。

- **W2 身份实机读数（2026-09-26 新增）**：`unread.v4` 的 `notifiedRuns[<source>][<session>]` **就是落盘的身份**——
  `host:turn%2F<seq>` = 宿主事件序身份在跑（W2 接线生效）；`chamber:<源>:<代>:<会话>:<水位>` = 回退族（该完成无 seq，或路径未走到）；
  `legacy:notified` = v4 迁移哨兵。台账的 `identity(identitySource)` 只在页内（`__dshChamberNotifications.entries()`），
  磁盘上读不到 ⇒ 持久判据用身份字符串本身。
- **W3 影子读数**：`dsh-chamber.unread.v5` 存在且页内 `__dshChamberUnread.shadow().ok === true` 是切换权威的**前置**；
  旧构建无此键（2026-09-26 复查：不存在 ⇒ 未重建，符合预期）。
- **一键复核脚本（scratch，随本文一起删）**：`.tmp/verify-remediation.mjs` —— 只读打出四项判定（M2 未读落盘 / v5 影子 / 身份族分布 /
  Dock 真写行）+ 权威日志环计数；**已在旧构建上干跑验证**：全部 FAIL/PARTIAL（无假 PASS），同一跑批实测 `notifiedRuns` 已 41 条
  （轮 19 是 35）而 `read`/`edge` 仍全空 ⇒ 「通知在动、未读面从未落账」又添一档现场证据。

## 2. 根因

| # | 结论 | 置信度 | 关键位置 |
|---|---|---|---|
| RC-1 | ~~未读面读到的行水位为 0~~ **已证伪（2026-09-26 实机）**：wire 的 `session/list` 123/123 项都带真实 `updatedAt`（0 个 0，max 1790424807252）；真正的形状是 **`read` 表从头为空 + `edge` 表空** ⇒ 未读集 ≈ 全表（`rows=123` ⇒ Dock 数字非常大），`deriveUnread` 不是「全 false」而是「全 true」。零水位行仍不得当内容证据（守侧改动保留，见 W1） | **高（实测）** | 实机 `POST /api/i/local/api/session/list`；`unread.v4={readSources:[],edgeSources:[],localRuns:35}`（`~/Library/WebKit/*/…/localstorage.sqlite3`）。
**2026-09-26 20:51 复读（app 运行中，旧构建）**：`read=0 / edge=0`，而 `notifiedRuns` 已覆盖 **5 个来源**（local + `gateway-pve-vm-develop` / `-ct-harness` / `-ct-kunquwiki_deploy` / `-ct-kunquwiki`）——通知轨在推进、未读面在所有来源上都没落过一拍；同批 `unread.v5` 不存在（旧构建）、别名表 11 行（W2 删除批的对象）；`unread-derivation.ts`（守侧） |
| RC-1' | **"水位为何为 0" 未定**，二选一：**M1** 行 `updatedAt` 确为 0；**M2** 行水位 >0 而写入路径未发生 | **待 W0 定案** | 见 §2.1 |
| RC-2 | 假完成：**候选水位取 `completionWatermark = max(completedAt, updatedAt)`**（内容水位），于是「同一老完成 + 新活动 / 运行位抖动」被重提成一次新完成 | 高（已修） | `completion-observation.ts` 候选门（`factsCompletionOf`） |
| RC-2′ | `episodeEnded('official-stop')`（`dsh-stream-state/session-authority.ts:201`）**只写权威日志**（`SessionAuthorityReconciler.attempt` 的唯一消费 = `note('complete')`），不进通知链——不是假通知的生产者（原判断已改判） | 高（读链核实） | `dsh-chamber-client-core/src/session-fact-reconcile.ts:205-207` |
| RC-3 | 角标陈旧：期望 0 未被应用（乐观成功 + 提交闸 + 无重放 + 静默丢写） | 高（**日志取证加证，2026-09-26**）：
①`shell.log.1` 里 544 次 `dsh-chamber:badge-count` invoke 集中在 **08:33:43–08:35:37 约 2 分钟**，其中 4ms 内 10+ 次（#2849–#2855）⇒ 推送风暴/闪烁；
②`sidecar.log.1:687-694` 同刻 8 条 `[node-edges] setBadge 宿主腿失败（有界排队 N/6 次后放弃）：swift-edge-ui-unavailable:setBadge`——**注意**：这是 `performUI` 的 `canShowUI()==false`（未打包 `swift run`）路径，**不是** `:no-window`（全库 `no-window` 计数 0），
即那批失败来自 dev 会话；③**打包会话自 09-26 09:44 起 shell.log 里连一条 badge 活动都没有**（旧构建只在失败时记，成功不记）——Dock 上的值因此自最后一次写入后**冻结**，没有任何一拍去纠正它。
⇒ 「期望 0 但 Dock 是大数字」的死结 = 陈旧值 + 无纠正尝试；本轮 W4 四片（电平 target + 重放 + 无窗不再拒写 + 真读回 + `shell.log` 记每次真写）正是补齐纠正链，重建后由 `badge write count=… applied=…` 一行定论。 | `use-badge-count.ts:182-192`、`node-edges.ts:398-421`、`shell-core.ts:1049-1057`、实机 `~/Library/Application Support/@dsh-chamber/desktop/logs/{shell,sidecar}.log*` |
| RC-4 | 打包态无观测面：`ShellDebug` 打包恒 false；Swift/Electron 无 incident 落盘；环被 divergence 挤出（**已修**：facts-health 保底 8 名额） | 高 | `ShellDebug.swift:29-33`；`authority-log-store.ts` |

### 2.1 M1 / M2 决策点（W0 一条读数即可定案）

- **M1（行水位确为 0）：已证伪（实机读数）**。mux baseline 的原始响应（本机实测，2026-09-26）：
  `POST http://127.0.0.1:17500/api/i/local/api/session/list`（`source-mux-facts.ts:993` 的同一帧）→ 123 items，
  **123/123 带 `updatedAt`，0 个 0，max 1790424807252**；且 `rowFromListItem` 对非法/缺失 `updatedAt` **整行丢弃**、
  部分行被拒会整批拒（`baselineFailures`），本机 `baselineFailures=0`。⇒ 行水位不是 0，**M2 定案**。
  原推断的 RC-1「水位为 0」来自把 `read:{}`/`edge:{}` 误读成「行水位 0」，实测证伪（0 从未被测量过）。**原已排除**两条：
  ① status 行先建且基线合并不抬升——`mergeBaselineRow` 明确 `Math.max(previous.updatedAt, row.updatedAt)`
  （`source-mux-facts.ts:492-503`），基线只会抬升；② 列表项缺字段被整批拒——那会记 `baselineFailures>0`，与本机 `=0` 不符。
- **M2（水位 >0 而写入未发生）**：seed 被 `seededIncarnation === incarnation` 跳过（本机已排除，见 §2.2）、
  `keepUnread` 全命中（需上一拍全表武装，难成立）、`readMarks` 写回后被同拍覆盖（`use-unread-notifications.ts:235-255`）。
  **已定案（实机）**：`read` 表对所有来源都为空（`readSources:[]`）⇒ 不是「偶发漏写」而是**从未落地**；抛出点已找到：
  `derive-unread` 抛 React #185（更新环），被步骤守卫吞掉后整拍中止 ⇒ 见 W1 M2 分支与 §8 第 22 条。
  W0 读数（`verdict` + `seed{through,consumed}`）作为实机复核，不再是唯一裁决源。
- **定案读数**：W0 的 `__dshChamberUnread` 打印 `last()`，只看 `verdict`（record 时自算，见 §8 第 15 条）：
  - `m1-zero-watermark` ⇒ M1（行水位全 0，修来源）——**本机已证伪**；`m2-seed-not-consumed` ⇒ M2（有水位未消费，修 seed/read 路径）；
  - `all-rows-unread` ⇒ **本机实测形状**：未读数 == 行数（123/123 全表武装，`read` 表从未落地）⇒ 修 `factsBaselineSeed`/`seedReadFloor` 的写入与 `viewingReadWatermark` 的读动作推进（Dock 大数字的直因）；
  - `no-verified-facts` ⇒ 本拍 facts 不可判（等首个可用批再读）；`read-marks-only` ⇒ 全被读标记吸收（核对读标记语义）；`ok` ⇒ 本拍水位已消费。
  - W1 M2 复核读数（本批新增）：`last().gate = {runs, coalesced, deferrals}`——`coalesced > 0` 证明实机确实存在派生重入环**且已被闸吸收**；
  `readMarks > 0` 且持久化 `unread.v4.read` 非空即证明「未读面首次真正落盘」。
- 若需人读原始面：`maxWatermark`、`rows`、`seed{through,keepUnread,consumed}`、3 条行样本 `{sessionId, updatedAt, running, completedAt, completedAtDomain}` 同在 `last()` 里。
  - W3 影子面单独读 `__dshChamberUnread.shadow()`：`{written, ok, differences}`——`ok=false` 说明 v5 形状丢信息（本批不改判定，但会挡住权威切换）。
- vendor 侧已核对（避免误判）：宿主列表项 `updatedAt = Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)`
  （`dsh-api-session-controller/lib/types/list.js:293-294`），`listFields` 只带 `parentSessionId/origin/cwd`（`:296-302`），**不覆盖** `updatedAt`。

### 2.2 已排除的假设（复核留痕，勿重复立案）

- 「`incarnation` 双 `undefined` 使 seed 自锁」：`bootToken` 是必填 string（`use-unread-notifications.ts:95`）。
- 「来源退役删 `readMarks` 但留 seed 标记」：`readMarksRef` 全部访问点都在同一 hook（88/128/174/226-263/531-534），无外部删除点。
- 「派生没在跑」：`applySessionFactsNow` 所有路径都调 `recomputeSourceUnread`（525/571）。
- 「空 read 是剪枝造成」：`pruneUnreadPayload` 对 ≤500 条的 read 表原样保留（`unread-store.ts:260-270`）。

## 3. 工作包

### 3.0 建议的第一步（PR #1 范围，估算 1–2 天）

| 文件 | 改动 | 估算行量 |
|---|---|---|
| `packages/renderer/src/app-hooks/use-unread-notifications.ts` | 挂 `__dshChamberUnread`（派生出口）+ seed 读数 | +25 |
| `packages/renderer/src/facts-health.ts` | detail 增 `maxWatermark=`；与 divergence 分环 | +15 |
| `packages/renderer/src/app-hooks/use-badge-count.ts` | `applied:false` 先只记日志（不改判定） | +10 |
| `packages/desktop/node-edges.ts` | setBadge 每条腿落行（含 `no-window`） | +12 |
| `macos/.../SwiftEdgeHostLegs.swift` + `MainWindowController.swift` | runtime debug flag + setBadge 腿落行 | +20 |
| `packages/renderer/src/source-mux-facts.ts` | 修 `:497` 错误注释（§4 例外项） | +2 |

- 验证：`node scripts/gates/run-checks.mjs static`、`node scripts/gates/run-checks.mjs tests`；
  Swift 改动走 `pnpm run build:sidecar` + `pnpm run build:swift-app`，macOS 腿 `pnpm run test:macos`（AGENTS.md「Before changing the Swift native shell」）。
- PR #1 不改任何判定/投递逻辑 ⇒ §0 冻结项天然满足；它产出 §2.1 的定案读数。
- **已落（本轮）**：W0a `unread-instrument.ts`（`__dshChamberUnread`：分支/行数/`maxWatermark`/行样本/播种读数）+
  W0b `facts-health` detail `maxWatermark=` + W0c `use-badge-count` 的 `applied:false` incident（`badge-not-applied`）
  与 `node-edges` 无窗丢写日志 + W0d `source-mux-facts:497` 注释。验证：`test/session-state/unread-instrument.test.ts`、
  `test/wiring/unread-prune-roster-gate.test.ts`、`test/aggregate/badge-count.test.ts`、`desktop/test/desktop-shell/badge.test.ts` 全绿；
  `tsc -p tsconfig.json` 对本改动零错误（余下 10 条为本 worktree 的 vendor/harness 未物化引起的既有解析错误）。
- **已落（W2 首片）**：完成候选证据门 `factsCompletionOf`（只认 host 域 observed `completedAt`；活动水位只推记忆）+ `FactsObservationRow.completedAtDomain` 声明 + 2 条回归断言。验证：`completion-observation` / `notification-projection` / `notification-outbox` / `complete-ledger` 及 session-state+aggregate+wiring 共 27 个测试文件全绿；`tsc` 无新增错误。
- **已落（W0 补充）**：`AUTHORITY_LOG_FACTS_HEALTH_RESERVE = 8` 环保底（`authority-log-store.ts` + `trimEntries`），`loadAuthorityLog` 与 append 同用一条淘汰规则；2 条新测试（保底留痕 / 名额是上界且保最新）。
- **未落**：Swift 腿 `ShellDebug` 打包开关与 `setBadge` applied 回读（需 `pnpm run build:swift-app` 验证，随 W4 的前置一起做）；
  W2 余项 = **删除批**（旗标/围栏/别名/回退身份，矩阵见 §4）与 shell-edge 无水位边沿的收紧——**候选身份 `host:turn/<seq>` 已落（轮 21，见 W2 段『已落证据』）**；
  实机复核四项判据（M2 落盘 / 关窗清零 / `shadow().ok` / `notifiedRuns` 出现 `host:turn%2F`）待重建。

### W0 仪表（先做；不改行为）
- 改点
  1. `ShellDebug`：打包态也允许 `debug.enabled` 打开 invoke/角标日志（启动应用 + 设置变更两处记 runtime flag，日志点用 `env || runtimeFlag`）；`macos/.../MainWindowController.swift:1111-1126`。
  2. `setBadge` 每条腿落行 + 回读真实值：`node-edges.ts:583-592`、`SwiftEdgeHostLegs.swift:563-584`（含 `no-window`、`applied:false`）。
  3. 渲染端 `__dshChamberUnread`（幂等挂载，同 `publishNotificationInstrument` 形状）：
     `{at, sourceId, branch:'facts'|'channel'|'freeze', factsVerified, rows, maxWatermark, sample[3], readMarks, seed:{through,consumed,keepUnread}, armed[], disarmed[], withdraws, forgets}`；
     挂点 = `deriveSourceUnreadNow` 出口（`use-unread-notifications.ts:270` 之后），计数来自 `applyObservationBatch`（`completion-observation.ts:583-599`）。
  4. `facts-health` detail 增 `maxWatermark=`（已落）；环保护改为**保底名额**而非分环（`AUTHORITY_LOG_FACTS_HEALTH_RESERVE = 8`，`authority-log-store.ts`）——
     淘汰时先保最新 24 条任意 kind，再用剩余名额保最新 8 条 `facts-health`；未超限时逐字不变，无新存储键（已落 + 2 条测试）。
- 验收：§1.2 第 2/3 段片段能同时给出 `BADGE_DESIRED`、`maxWatermark`、行样本；据此在 §2.1 定案 M1/M2。
- 回退：纯增量，删除即回退。

### W1 未读面定案修复（依赖 W0 读数）
- M1 分支（水位来源）：让行水位真实可用——status 行不得覆盖/压低基线水位，缺水位行不得当"内容位置 = 0"的证据；
  **已落（守侧，已落 2026-09-26）**：0 水位 = 「不知道内容在哪」而非「内容位置 0」（host 的 `updatedAt = max(header.createdAt, lastPromptAt ?? 0)`，合法来源恒 > 0；`watermark.ts:completionWatermark` 同判 0/0 ⇒ undefined）。`unread-derivation.ts` 改为：`hostWatermark(...) === 0` 的行**不产 `unread=false`、不 `delete edge[]`**，已武装/上一拍已判未读的会话原样保留（fail-closed 向未读；observer 域完成仍只武装不结算）。**未落**：源侧（`updatedAt` 恒 0 的成因）——谁喂给 facts 轨、为何 0，需 W0 实机读数或直读 wire 定案；源侧修好前，这些点只能等水位恢复。
  **源侧已排除/已收窄（本轮实机取证，只读）**：①`curl http://127.0.0.1:17500/chamber/session-state` = **200 + SPA HTML 回退**（本机只监听 17500/17510）⇒ 本机 local 来源**不是**走 gateway 只读镜像；②`isMuxObservableSourceKind('local') === true`（`source-mux-facts.ts:151-153`）⇒ local 的 facts 轨 = **mux 无壳观察者**，其 `$events` 逻辑流在本机实测只收到 ready 一帧、**无任何 emit**，事实全部来自 **30s 一次 unary baseline `session/list`**（同文件 `:1264-1276` 已登记）；③该 baseline 的行必须过 `rowFromListItem`（`source-mux-facts.ts:281-293`），`isWatermark(item.updatedAt)` 不通过整行被丢弃 ⇒ 能在册的行只有「wire 显式给了 `updatedAt`（含 0）」或「经 delta/parse 路径把缺失折成 0（`session-facts-source.ts:386 numberOrZero`）」。下一步决定性取证 = 读 mux 观察者的 baseline 入轨（`source-mux-facts.ts:1000-1060`）与 `applySessionFacts` 的字段映射，判断 0 是 wire 给的还是本侧折的。
  **无可用水位的行 ⇒ 不产 `unread=false`、不 `delete edge[]`**（`unread-derivation.ts:149-177`），必要时从 `handleActivity`/`sessionListMetadata` 补水位。
- M2 分支（写入路径，**本机已定位到抛出点**）：实机权威日志（local 环）有 `unread-derive-error`：
  `derive-unread: Minified React error #185`（= **Maximum update depth exceeded**）在 2026-09-26T11:55:18 抛出，
  被 `factsStepGuard.guard(sourceId, 'derive-unread', …)` 捕获 ⇒ **派生整拍中止**，`readMarks`/`completedStore` 永不写入：
  与「9 天 / 18 份 localStorage 全部 `read:{}` + `edge:{}`」完全一致（未读面不是偶发漏写，而是**从未成功过一拍**）。
  同一环里另有 `status-divergence`（`status=0:row=1` 等，官方运行位与 mux 行对不上）。
  **已落（第一片，重入闸）**：`unread-store.createUnreadStepGate`（纯叶子、注入 defer）——派生体**永不嵌套执行**：
  重入请求按 id 去重、按请求序排到微任务补跑；非重入路径（桥事件/effect）保持同步执行、行为不变。
  接线：`use-unread-notifications.ts` 的 `recomputeSourceUnread` 只 `request(sourceId)`，闸的 step 内仍是
  `factsStepGuard.guard(…, 'derive-unread', …)`（异常面不变）；经 ref 转发保证调用最新派生闭包。
  回归：`unread-store.test.ts` 新增「重入不嵌套 / 去重保序 / 补跑一次 / 抛错也释放闸」+ 源码锁改为
  「派生入口必须过闸」。**待实机复核**：重建后 `read`/`edge` 应首次落盘（`__dshChamberUnread.last().verdict !== 'no-verified-facts'` 时 `readMarks > 0`），
  且环里不再出现新的 `unread-derive-error`。
  **若仍报同一错误**：下一个同形嫌疑是 `apply-session-facts`（`factsStore.setSession` 同样是「被守卫的步骤内写 store」）——同一闸模式可直接套用；先读 `last().gate.coalesced` 区分「环还在派生」还是「环已转移到 apply」。
- 测试（**两条都已落**）：「零水位 baseline 不得清空通道臂」（`unread-derivation.test.ts` W1 M1 用例）与「水位可用时必须写 read / 首见批写回地板后不是全表武装（实机 123 行形状）」（`W1 M2 目标形状` 用例）。
- 验收：`readSources=local`、`edgeSources` 非空、有未读时 `BADGE_DESIRED>0`，侧栏出现未读点。
- 回退：单包 revert。

### W2 完成事件化（治假完成；本方案的主要删除项）
- 完成只认**正向 turn/end 证据**：候选水位 = host 域 observed 的 `completedAt`（**不取** `max(completedAt, updatedAt)`）；`completedAtDomain==='observer'` 与 `reconstructed` 一律只出未读。**已落**：`factsCompletionOf`（`completion-observation.ts:239`）+ 2 条回归断言（活动水位前进不是完成 / observer 域时刻无通知资格）。`lastTurnEnd.seq` 进候选身份（`host:turn/<seq>`）仍未落，随 W3 的 v5 身份一起做。
- **反证守卫（已落）**：facts 载体降级时壳 running→idle 边沿仍可通知（B3-2 / COR-1 语义保留），但**原始 facts 行说仍在 running** 时不得产候选
  （`factsContradictsIdle`，`completion-observation.ts:425`）——实测假通知形状 = 运行位抖动 + 降级窗口；原始行取自 `factsChannelRows`（不可用 ≠ 缺席，评审 B2 的键空间）。
- 身份 = 宿主事件 id（`host:turn/<seq>`），缺失时 = `chamber:<源化身>:<会话>:<提示水位 updatedAt>`；**不得含 `Date.now()`**。
  **已落（读数面）**：`notificationIdentityOf` 返回 `{runId, source}`（`run-id` / `host-turn` / `watermark` / `event-nonce` / `constant`），`notificationRunId` 委托它——同一处产出；每条通知台账（`__dshChamberNotifications.entries()`）带 `identity` + `identitySource`，incident detail 同步。**`constant` = 无任何 host 域判别符的兜底（同一会话所有此类完成共享一个身份，最可疑）**：幻影/漏发归因当场可读；身份本身的替换（`host:turn/<seq>` + 删 `Date.now()` 族）仍随 v5 权威切换同批。
  **已过时（2026-09-26 当时为真；轮 21 起被反证，轮 27 实机证据定案）**：~~`host-turn` 分支当时不可达——`completionSeq` 有消费、无生产者~~。以下是当时的普查原文，保留只为记录修复前的形状：全仓 `completionSeq` 只被 pass-through：
  `notification-identity.ts:94`（消费）、`notification-outbox.ts:30/60/105/221/228/237/282/300`（键与比对）、`notification-projection.ts:53`（类型）、
  `use-unread-notifications.ts:72/382/532`（转发）；**没有任何生产点写入它**。实机 `notifiedRuns` 值（`chamber:local:0:<session>:<watermark>`）
  正是水位族 ⇒ 现状所有完成都走回退身份。
  **数据其实已经有了**：本地观察者解析冻结 wire 时已抽出 `turn/end.seq`（`source-mux-facts.ts:402-409`，`FollowTailRead.turnEnd.seq`），
  且 facts 行携带 `lastTurnEnd`（`unread-derivation.ts:23` → `TurnEndFact.seq`，`dsh-chamber-client-core/src/derive.ts:449-455`）；
  gateway 侧 `SessionTurnEnd.seq` 也在协议里并被持久化（`control-plane/src/session-state-protocol.ts:243-248`、`gateway/src/session-state.ts:603`）。
  ⇒ **W2 身份替换可在不新增宿主面的前提下落地**，接线是 6 个点（**2026-09-26 已落**，见下方证据）：
  ① `completion-observation.ts` 候选带上 `completionSeq = factsRow.lastTurnEnd?.seq`（安全整数 ≥0 才带）；
  为此 `FactsObservationRow` 增了**只读判别符** `lastTurnEnd?: SessionFactsTurnEnd | null`（`SessionFactsRow` 本就携带它，
  只是观察子集没声明——它**不参与**可判性/水位/完成证据，只喂身份）；
  ② `notification-projection.ts:585`（直发路径）与 ③ `:797-801`（pending 写入）透传 `candidate.completionSeq`；
  ④ `complete-ledger.ts:49-63` 的 `PendingCompletion` 增可选 `completionSeq`（durable——延迟释放才不丢身份），
  ⑤ `unread-store.ts:160-169` 的 sanitizer 按同一数值域保留它（非法只丢字段）；
  ⑥ pending 释放出 `completeNotification(...)`（`:753-758` 等）带上该字段 + `use-unread-notifications.ts:557-567` 的 `emitSessionNotification` 透传。
  测试：候选带 seq / pending 往返不丢 / `notificationIdentityOf` 取 `host-turn` / sanitizer 拒非法值；读数面看 `identitySource='host-turn'` 比例。
  **已落证据（2026-09-26）**：①候选带 seq 与「无 seq/负 seq 形状逐字不变」——`completion-observation.test.ts`
  「W2 身份：候选带上宿主 turn/end.seq…」；②`completionSeq` 进 durable pending、已有 pending 身份不被改写、
  释放进通知、直接路径同——`notification-projection.test.ts`「W2 身份：completionSeq 进 durable pending…」；
  ③sanitizer 数值域与丢字段——`unread-store.test.ts`「pending.completionSeq…」；四套 140/140 绿。
  identity 解析面的 `host-turn` 分支原本就有契约测试（`notification-identity.test.ts:20,34`），本批补的是**生产者**。
  v5 载荷（`{v:5,records}`）不含 pending 段 ⇒ 影子面与 parity 不受影响。
  未验证项：本机 `session/follow` 是 stream 端点（unary POST 被 `gateway/signature-invalid` 拒），本地 seq **实际出现率**要等重建后从 `identitySource` 分布读；缺失时按现状回退，无回归。
- `session-authority.ts:201`：`episodeEnded('official-stop')` 只写权威日志、不进通知链（RC-2′ 改判）——是否删属 design 14 D4 权威轨道，不与本方案同批。
- 删除：§4 renderer / dsh-stream-state 段。
- 验收：运行中的会话 30 分钟**零**完成决策（读 `__dshChamberNotifications.entries()`）；一次真实 turn/end 恰好一条；重载 / 两通道 / 围栏场景不重复。
- 回退：单包 revert（删除项与替代机制同批）。

### W3 账本一次性未读（治点被抹/复活）
- 记录创建时一次性决定 `unread`；此后只有显式读 / 全部已读可改；`forgetSession/withdraw` 只清易失 `pending`。
- 删除源级地板（`seedReadFloor` 的源级用法；原普查行号 `unread-store.ts:503-519` 已失效，现定义在 `:796` 附近——**按符号搜索**）与重复判据——**未落**（随权威切换，须先有 W1 读数证明水位可用）。
- v4→v5：**已落**影子写 + 投影/importer（`UNREAD_V5_KEY`、`projectUnreadV5`（旧 `edge`→记录、旧 `readMarks`→已读/记录水位、旧 `notifiedRuns`→身份）、`sanitizeUnreadV5Payload`（白名单 + `unread&&read` 折算已读）、`pruneUnreadV5Payload`（水位 LRU）、`saveUnreadShadow`（只写不读、失败只 loud））；
  接线点 = `flushUnread`（v4 之后同一意图写 v5）；回退 = 忽略 v5（测试钉住「只有 v5 时 `loadUnread` 仍空」）。
- **先锁（已落）**：`unreadV5Parity(v4, v5)` 逐会话比对未读/已读/通知身份（差异文本有界 8 条、未读位优先）；`saveUnreadShadow` 写成功后**立刻 JSON 往返 + 净化读回**再比对，结果进 `__dshChamberUnread.shadow()`（`{at, phase, written, ok, differences}`）。**切换权威的前置条件 = `shadow().ok === true`**；`ok=false` 时只报告（权威仍 v4），绝不静默切换。
  **启动期对账（已落）**：`reconcileUnreadShadowOnLoad(storage, v4)`（`App.tsx` 载入点调用）比对盘上 v4 与 v5，`phase='startup'`；它捕捉写时对账抓不到的**影子漂移**（某条 v4 写路径没走 `flushUnread`）。
  **未落**：权威切换到 v5、记录创建时一次性决定 `unread` 的运行时语义；
  `LEGACY_NOTIFIED_RUN_ID`（`notification-identity.ts:62`、`unread-store.ts:203`）的前置（importer/投影）**已满足**，删除动作随 v5 权威切换同批。
- 验收：重载 / 关窗重开 / 载体扇动不改变未读集合；Dock 与点集合同源。
- 影子期成本：每拍多一次 `setItem`（1s 节流下 ≤1/s；v5 载荷同样有界——每来源 500 条、白名单键，隐私条无新增面）。

### W4 呈现电平化（治角标大数/闪烁）
- desktop：**已落** `badgeTarget` 重命名（意图=电平，quit 清理由它守护）；**已落**真实回执 `applyBadgePresentation` 改 async：宿主提供 `setBadgeAndWait`（Swift）时等腿应答，Electron 缺省走同步叶（本身即真实结果），BADGE_COUNT 处理器因此 async；
  **已落** show / did-finish-load 重放钩子（`replayBadgeIntent`，`shell-core.ts:448,497,1064`）——无窗期/腿失败期丢弃的值不必等下一次计数变化。
- `node-edges.ts`：**已落**合流吞值修复（在飞时新值落第 2 槽，成功后的 shift 不再吞新值；失败头过时才丢弃、给最新值一次机会——`node-edges.test.ts:453` 旧口径的"靠覆盖在飞队首"语义因此改为失败路径丢弃）；
  **已落** `setBadgeAndWait` 真实回执（ok=已写入；放弃/无窗/被取代如实回 `applied:false`+原因；7 例）；**已落** `badgeCountApiAvailable` 随 `__host.hostFacts` 刷新。
  **已落（W4 四片）**：本侧不再预判窗口——`badgeBlockedResult`/`badgeNoWindowLogged` 整段删除（无窗不是失败），
  排队的成功路径改为转达宿主读回（`badgeReadbackReceipt`：`{applied:false}` ⇒ `swift-setBadge-readback-mismatch`，无读回 ⇒ 入队乐观）。
  余下：status 型腿的"确定性放弃"策略（`isRetryableLegError` 只重试 `main-thread-busy`；`no-window` 这一类已从角标面消失）。
- Swift：**已落（W4 四片）** `setBadge` 三改：① **去无窗守卫**——`NSApp.dockTile` 是应用级状态，主窗关闭后
  app 仍在运行、Dock 图标仍在，旧守卫让**清 0 写被拒**（`no-window`）⇒ Dock 陈旧大数字永远清不掉；
  ② **同值不写**（`lastBadgeLabel`，重复上报不再刷 Dock，**回执仍如实**：`applied = 写后读回 == 意图`，
  所以 renderer 的重试不会变成空转）；③ **写后真读回** `{count, applied}`——nil 宿主应答/旧宿主保持入队乐观（向后兼容）。
  新增注入 seam `Config.badgeLabel/setBadgeLabel`（headless 单测不碰 NSApp）+ 2 例（无窗落地/同值跳过/清 0 走通、读回不一致如实报 `applied:false`）。
  同批改判：`resetHostFactsBookkeeping`（`MainWindowController.swift:1015-1018`）与 `didBecomeKey`（`:1053-1058`）**已是真实窗口状态**
  （`window?.isKeyWindow ?? false`；重开推 `mainWindowAlive:true`），**无需改动**；且角标路径已不再消费 `mainWindowAlive`，窗口簿记不再能影响 Dock 值。
- 渲染端：**已落** `applied:false` 视为未派发（与 rejection 同一条有界重试链；预算耗尽释放计数变化闸并 loud；`badgeLegApplied`/`badgeLegFailure` + 2 例）；
  **改判（§8 第 14 条）**：`pushedCountRef` 与桥迟到 interval **保留不删**——删闸会拿回实测 4.8 Hz 冗余 IPC，而闸的唯一缺陷（按派发而非按应用提交）已由真实回执链修掉；
  **已落**桥迟到兜底收窄：仅挂载时桥缺席才启动、经同一闸提交（此前桥正常时它每挂载多推一次同值 IPC 且绕过闸）。
- 测试：**（已定）** `badge.test.ts:129-131` 的"主进程不做值去重"锁**保持原样**——同值跳过落在**宿主腿**这一层，
  且跳过不改变回执（`applied = readback == intent`），重推同值仍拿真话回执、不是空转；主进程仍是「照单接收 + 呈现」。
  合流失败分支已由 `node-edges.test.ts:453` 覆盖；"任意触发后 desired==OS 值"仍待实机。
- 验收：§5 矩阵全绿。

### W5 护栏
- **已落（前置）**：`test/wiring/unread-single-authority.test.ts` 三条只读源码门 —— ①未读单一实现（`deriveUnread` / `reconcileCompletedFacts` 的引用模块只允许 `use-unread-notifications.ts`，注释已剥离）；
  ②页面代身份（`notification-identity.ts` 的 `Date.now()` 计数**恒为 0**，页代必须取自 `globalThis.crypto.getRandomValues`、页内事件计数 `localEventSequence` 必须保留）；③v5 权威锁（`loadUnread` 函数体内不得出现 `UNREAD_V5_KEY`——切权威必须连同等价性守卫一起改）。
- 剩余静态门：除 ledger 外不得再实现"未读"（已由①覆盖主体）；`completion-observation` 旗标数 = 0（待 W2 删除项落地后再立，否则现在就是红）。

### W6 文档
- **已落（第一批，2026-09-26）**：design 19 更新为落地后的契约——
  ①§3.2.3 增「**候选的完成证据**（只认 host 域 observed `completedAt`）」规范句（RC-2 收窄）；
  ②§3.2.8 增 rejected 第 4 条「用内容水位当候选」（假通知生产者）；
  ③§3.7 的 rejected 列表增三条：**按窗口状态门控 Dock 写**（已删除，实机陈旧大数字的直因）、
  **按本地记忆跳过同值写**（会把写永久锁死，必须取写后读回）、**允许派生在 React 更新相位内重入**
  （嵌套更新环 #185 ⇒ 整拍作废、`read`/`edge` 从未落盘）；
  ④§3.7 呈现链改为**真实回执**契约（async 处理器 + `setBadgeAndWait` + 写后读回 + `applied:false` 走重试链）；
  ⑤§3.7.1 的实机证据改为 2026-09-26 实测（9 天 18 份存储 `read`/`edge` 全空 + `localRuns=35`）。
  `verify:anchors` 复跑：唯一失败仍是既存的 vendor 锚（见 §9 注），新增文字无锚点问题。
- **已落**：别名表 rejected 条目（design 19 §3.7，随轮 27 删除同批）。
- **待落**：围栏 / 双表 的 rejected 条目要等各自删除批真正落地后再补（否则文档会先于代码宣告「出局」）；
  本文删除；CHANGELOG 仅发布时写。

**依赖关系**：W0 → W1；W2 独立（可与 W1 并行）；W3 依赖 W2（先有稳定身份）；W4 独立（可与 W1 并行）；W5 最后。

## 4. 删除清单（先锁后删）

**renderer**（状态：**锁已在**——下列符号都已被告为行为钉住，删除的前提是 v5 权威切换；§8 第 26 条的普查给了逐项引用数）
- [ ] `completion-observation.ts`：`factsSeedPending`、`shellNotifiedSinceFacts`、`factsReseedPending`、
      `shellCompleteSinceFacts`、`factsSeeded`、`shellSeeded`、`baselineDone`、
      `forgottenSessions` + `FORGOTTEN_SESSION_LIMIT`、`fenceSeeds`/`FenceSeed`
      （**别信行号**：轮 26/27 的编辑已让 §8 普查里的行号 +7 漂移，按符号名搜索定位）
      —— src 引用全部限于本模块（`factsSeeded` 另有 `host/source-ledger.ts` 4 处、`fenceSeeds` 有 `notification-projection.ts` 1 处）；
      `completion-observation.test.ts` 对每个旗标都有直接断言（`factsSeeded` 23 处、`shellSeeded` 8 处、`fenceSeeds` 6 处…）
- [ ] `complete-ledger.ts`：`settleFence`、`armedFloor`、`seedSettleFence`、`withdraw`、`forgetArmed`（`withdrawSource` 的公开别名）（**别信行号**：同 A 行，可能 +5 漂移）
      —— 引用面广（`settleFence` 51 处 src / 88 处测试；`armedFloor` 28/14；`withdraw` 15/39），删除必须与 `notification-projection.ts`、
      `use-unread-notifications.ts`、`use-bridge-subscriptions.ts`、`host/mounted-sources-store.ts` 同批改
- [x] ~~`notification-outbox.ts` 别名表：`COMPLETION_ALIAS_KEY`/`WINDOW_MS`/`LIMIT`、`readAliases`、`persistAliases`、`aliasFor`、`rememberAlias`、`hostKeyOf`、`CompletionAlias`~~ —— **已删（轮 27，先锁后删）**。
      **普查更正（2026-09-26 轮 27）**：写路径不叫 `writeAliases`（全仓无此名），是 `rememberAlias` + `persistAliases` 内联落盘；
      src 引用数 KEY 3 / `readAliases` 2 / `aliasFor` 2 / `rememberAlias` 4 / LIMIT 3 / WINDOW 2 / 类型 7。**「测试引用 0」是错的**：
      符号引用确实 0，但有两个**行为锁**（`a settled completion seen through another identity family reuses the first event`、
      `the completion alias survives a journal reload`）——删除时改写为替代锁（`删除批替代锁：身份是唯一 run key…`、
      `删除批：存量别名键在构造时被清掉，且不再写入`），而不是直接删掉。
      证据：实机 mux `session/follow` 快照的 `turn/end` 记录带 `seq`（106/2877，见 §8 第 33 条）⇒ facts 完成恒有身份；
      残留键 `dsh-chamber.notification-outbox.aliases.v1` 在 outbox 构造时一次性 `removeItem`（回归锁：`删除批：存量别名键在构造时被清掉，且不再写入`）。
- [x] ~~`notification-identity.ts` 的 `Date.now()` 时钟族（当时叫 `LOCAL_EVENT_GENERATION`，轮 27 随页代语义改名 `PAGE_GENERATION`）~~ —— **已删（轮 26）**：页代判别符改为
      **CSPRNG 抽取的 53 位安全整数**（跨页唯一、页内稳定），页内事件仍由 `localEventSequence` 计数区分；源码门预算同步 **1 → 0**。
- [ ] `notification-identity.ts`：`chamber:` 回退族（水位族 + `constant`；原普查行号 37-42 已失效——那是 `isSessionRunId` 的校验，回退族现在 `:127-146`，**按符号搜索**；`LEGACY_NOTIFIED_RUN_ID` 随 v5，7 处 src）—— 仍待 v5 权威切换
- [ ] `unread-derivation.ts`：`factsBaselineSeed`（原普查 233-249）、无条件 `delete edge[]`（原普查 159，现 172 —— **别信行号**：按符号搜索）—— **注意**：M1 守侧（0 水位不清臂）已落，
      剩余删除只能在 v5 接管「记录创建时一次性未读」之后；现有 7 处测试锁住当前语义
- [ ] `unread-store.ts`：`seedReadFloor` 的源级地板用法（9 处测试）

**删除批就绪矩阵（2026-09-26 建，锁侧逐条对账；执行时按行整批改，不拆）**

| 目标族 | 行为锁（测试文件:引用数） | 同批动作 | 前置 |
|---|---|---|---|
| A 观察旗标族（`factsSeedPending`/`shellNotifiedSinceFacts`/`factsReseedPending`/`shellCompleteSinceFacts`/`factsSeeded`/`shellSeeded`/`baselineDone`/`forgottenSessions`/`fenceSeeds`） | `completion-observation.test.ts` 53 | 该文件内断言旗标的用例随实现一并删/重写（每旗标都有直接断言） | v5 权威切换 |
| B 账本围栏族（`settleFence`/`armedFloor`/`seedSettleFence`/`withdraw`/`forgetArmed`） | `completion-observation.test.ts` 42、`complete-ledger.test.ts` 33、`notification-projection.test.ts` 32、`session-authority-wiring.test.ts` 1、`mounted-sources-store.test.ts` 3 | 三主体文件同批重写 + §4 已列的 4 个调用方模块；`withdraw`/`forgetArmed` 的公开面随 `withdrawSource` 一起收 | v5 权威切换 |
| C 别名表（KEY/WINDOW/LIMIT/`readAliases`/`persistAliases`/`aliasFor`/`rememberAlias`/`hostKeyOf`）**已删（轮 27）** | 符号引用 0，但 2 个**行为锁**（`another identity family…`、`alias survives a journal reload`）→ 已改写为替代锁（身份唯一 + 存量键清理） | 删实现 + 存量键一次性 `removeItem`（回归锁已立） | ~~实机 `notifiedRuns` 出现 `host:turn%2F`~~ → **已由实机 mux 快照直接证实**：`turn/end` 记录带 `seq`（106/2877，§8 第 33 条）——比读 `notifiedRuns` 更强（不依赖旧构建是否接线） |
| D 身份回退族（`chamber:` 非稳定族、`LEGACY_NOTIFIED_RUN_ID`）；~~`Date.now()` 时钟族~~ **已删（轮 26，门 1→0）** | `unread-store.test.ts` 4、`unread-single-authority.test.ts` 3、`notification-projection.test.ts` 2 | 删回退族 + 改 `LEGACY_*` 断言；时钟族已按原计划「删除带着锁走」完成 | v5 权威切换 |
| E 派生播种/清臂（`factsBaselineSeed`、无条件 `delete edge[]`） | `unread-derivation.test.ts` 4、`unread-store.test.ts` 7、`unread-prune-roster-gate.test.ts` 4 | 重写派生回归（现语义被判为错，不能只删测试） | v5「记录创建时一次性未读」 |
| F `seedReadFloor` 源级地板 | `unread-store.test.ts` 7 + `wiring/unread-prune-roster-gate.test.ts` 2（合计 9） | 删用例 + 删源级地板使用点 | v5 权威切换 |

**矩阵注（防止误删/误改）**：①sidebar 五个测试文件里的 `withdraw` 是**领域动词**（会话撤回/归档），**不是**账本 API ⇒ 本批不动；
②`session-authority.ts:201` 的 `episodeEnded('official-stop')` 属 design 14 权威轨道，**不与本方案同批删**；
③D 行的源码门在自己文件里，删 `Date.now()` 族后若不同步改门，门会因预算变松而失去意义（这是「删除也要带着锁走」的一条）。

- [x] ~~`use-badge-count.ts`：`pushedCountRef` 提交闸、桥迟到 interval 兜底~~ **改判：保留**（§8 第 14 条）——闸防的是实测 4.8 Hz 冗余 IPC，
      且本仓 lock test 已把「同计数不得二次 push / 缺桥不提交」钉成意图行为；闸的**谎**已由 W4 真实回执 + 重试链 + 预算耗尽释放闸修掉。
      桥迟到 interval 已收窄：仅挂载时桥缺席才启动，且经同一闸提交（见 §3 W4）。
- [x] `source-mux-facts.ts:497` 错误注释假设 —— **已修**（注释改为实测口径：`updatedAt` = 最近一次用户内容时间戳，证明「有更新」不证明「有一轮结束」）

**desktop**
- [x] ~~`shell-core.ts`/`shell-ipc-settings.ts`：`pendingBadgeCount` 与"仅设置翻转才 reconcile"的形状~~ —— 已落（W4 前四片：`badgeTarget` 重命名 + 重放钩子）
- [x] ~~`node-edges.ts`：合流覆盖路径(214-215,239-247)、`badgeCountApiAvailable` 缓存(583-592)~~ —— 已落（W4 前四片）；
      status 型腿的确定性放弃 → **已定**：只重试 `main-thread-busy`，其余（unimplemented/payload）立即 loud 放弃且回执诚实（`applied:false`+原因）
- [x] ~~`node-edges.ts`：按 `mainWindowAlive` 预判拒写（`badgeBlockedResult`）~~ —— **已删除**（W4 四片；源码锁 ⑳ 防复活）
- [x] `sidecar-entry.ts:322-327` 无条件 alive 种子 —— **已查**：与启动态一致（Swift 建窗时同值推送、幂等无害），不是谎报；关窗后的真相由本轮的 `mainWindowDeliverable` 快照负责

**Swift**
- [x] ~~`SwiftEdgeHostLegs.swift`：setBadge 无窗守卫 / `int(...) ?? 0` / 无条件赋值~~ —— **已落**（W4 四片：去守卫 + 坏载荷 loud 拒绝 + 按读回值同值跳过 + 写后真读回 + `shell.log` 记 `applied`）
- [x] `MainWindowController.swift` 的 alive 谎报 —— **已修**：`resetFacts` 原**硬编码** `mainWindowAlive: true`，与 `willClose` 注释的语义（"关窗期间同步门一律不过，重开由 didBecomeKey 推回"）矛盾：sidecar 在窗口关着时重启，
      新 sidecar 会以为可投递 ⇒ 通知/深链在关窗时段被静默丢。修法：新增 `mainWindowDeliverable`（建窗/`didBecomeKey` → true、`willClose` → false），
      重启快照按它推；`resetFacts(isKeyWindow:mainWindowAlive:)` 纯函数 + 测试钉住两种状态。`focused` 一栏本就取 `window?.isKeyWindow ?? false` 实时值 ✓。

**dsh-stream-state**
- [ ] `session-authority.ts:201` `episodeEnded('official-stop')` —— **仅日志**（不进通知链，见 RC-2′）；属权威轨道，不与本方案同批删

**测试**
- [x] ~~`packages/desktop/test/desktop-shell/badge.test.ts:129-131`「主进程不做值去重」锁~~ —— **改判为保持原样**（见上方「测试：**（已定）**」：同值跳过落在宿主腿、不改回执；主进程仍是照单接收 + 呈现）。此条已由该裁决取代，不再算未落项。
- [ ] 钉住旗标 / 围栏 / 非稳定身份的用例（随 W2 同批）；~~别名用例~~ **已随轮 27 删除改写为替代锁**。

## 5. 验收矩阵

| 场景 | 观测量 | 期望 |
|---|---|---|
| 真实回合结束（我在别的会话发一条） | `NOTIF_LAST` / `edge` / `BADGE_DESIRED` | 恰一条完成；该会话点武装；角标 +1 |
| 长活会话持续运行 30 分钟 | `__dshChamberNotifications.total()` | 0 条完成决策 |
| 窗口恢复（最小化→显示） | Dock 值 vs `BADGE_DESIRED` | 1s 内相等 |
| 腿失败注入（主线程忙 / 读回不一致 `applied:false`） | 日志行 + Dock 值 | 重试后一致；日志含真实 applied |
| **关窗后推 0**（Dock 是应用级，W4 四片） | Dock 值 | 清零（旧行为：`no-window` 拒收 ⇒ 陈旧大数字常驻） |
| 页面重载 | `read/edge/notifiedRuns` | 集合不变（只应恢复） |
| 载体扇动（facts-health ready 0↔1） | `edge` | 不变（不再误抹） |
| 归档清理不收敛（89 行场景） | `edge/notifiedRuns` | 已结算完成不被清 |
| 退出 / 关窗 | Dock | 清零 |

**覆盖对账（2026-09-26；纯层锁 ← 实机行）**：

| 行 | 纯层锁（新增/现有） | 仍需实机 |
|---|---|---|
| 1 真实回合结束 | — | ✅（需真发一条） |
| 2 长活 30 分钟零完成 | **新**：`completion-observation.test.ts`「长活会话：running 不变 + 内容水位连推 12 拍 + 无 turn/end ⇒ 零完成候选」+ 反向对照（真 turn/end 必须成候选，含 `completionSeq`） | — |
| 3 窗口恢复 1s 内相等 | **新**：`badge.test.ts`「main-window show is a badge replay edge…」（show→重放钩子、装配期绑定、初值 null 幂等）+ `node-edges.test.ts` 的 `mainWindowShown` 入站面 | ✅（真实 Dock 值） |
| 4 腿失败注入 | 现有：`node-edges.test.ts` ⑲/⑲b + desktop-shell queue + `SwiftEdgeHostLegsTests` 4 例 | — |
| 5 关窗后推 0 清零 | 现有：queue「已关窗仍须入队」+ Swift「无窗不跳同值/读回」面 | ✅（唯一实机判据） |
| 6 页面重载集合不变 | 现有：store 载入/保存往返 + `reconcileUnreadShadowOnLoad` | — |
| 7 载体扇动不误抹 | 现有：M1 守侧回归 | — |
| 8 归档清理不收敛 | 现有：89 行列表抖动回归 | — |
| 9 退出/关窗清零 | **新**：`badge.test.ts`「quit clear: guarded by an existing intent…」（曾有意图才触碰 / 复位 / best-effort / `main.ts` will-quit 接线） | ✅（真实退出） |

⇒ 九行里**纯层已锁 6 行**（4/6/7/8 现有 + 2/3/9 本轮补），剩 1/3/5/9 的真机面合并为重建后的四项读数（§1 口径）。

## 6. 待裁决（未裁决前保持现状；括号内为我的建议）

1. 通知策略：每回合一条（现状）/ 只报"该回来看的" / 同会话聚合。（建议：先保持现状，W2 落地后再单独裁决聚合。）
2. `requireHidden` 语义：窗口前台就不弹 vs 仅"正在看的那个会话"不弹。（建议：后者——与"未读点只在没看时提醒"同语义。）
3. delegated（子代理）会话是否作为通知单位。（建议：不作为独立通知单位，但在侧栏保留未读点。）
4. v5 迁移 UX：允许一次性丢失点/角标 vs 必须完整继承。（建议：完整继承——importer 已有明确映射。）

## 7. 非目标

不改 gateway 形状 / 不动 vendor / 不新增运行时依赖 / 不重做通知 UI / 不引入定时兜底与"迟发补偿"类补丁。

## 8. 本轮复核修正记录（避免重复立案）

1. RC-1' 拆成 M1/M2 并加"定案读数"，不再宣称已证。
2. 排除 `incarnation` 自锁（`bootToken` 必填 string）。
3. 排除 `readMarksRef` 外部删除点。
4. 补证：派生必跑（525/571）、read 未被剪枝（260-270）、基线**原子接受**（`source-mux-facts.ts:1022-1031`）。
5. 删除清单修正：`LEGACY_NOTIFIED_RUN_ID` 随 v5 才删。
6. 删除清单修正：`reconcileBadge` → 真名 `reconcileBadgeCount`（`shell-core.ts:1050`）。
7. 新增 §0 行为冻结、§5 验收矩阵、§7 非目标与"先锁后删"纪律。
8. 复核 `mergeBaselineRow`（`source-mux-facts.ts:492-503`）：基线合并用 `Math.max` 抬升水位 ⇒ 排除「status 行压低水位」，M2 权重上升。
9. **改判 RC-2**：读 `SessionAuthorityReconciler.attempt`（`session-fact-reconcile.ts:205-207`）确认 `episodeEnded` 只调 `note()`（写权威日志），通知链不消费它 ⇒ 假通知的生产者是候选水位规则；已用 `factsCompletionOf` 修复并补回归（27 个受影响测试文件 + 2 个 W2 断言全绿）。
10. W2 第二片：壳边沿加 facts 行反证守卫（降级窗口保留通知语义，仅当原始行说 running 时不产候选）+ 1 条对照回归（59 例全绿）。
11. W0 补充：权威日志环 facts-health 保底 8 名额（不改存储键、不改未超限时的逐字行为）；侧栏 session-state 组除「vendor 未物化」的 lockstep（有 `DSH_CHAMBER_VENDOR_ABSENT=skip` 逃生口）外全绿。
12. W4 首片（已落）：合流吞值修复（desktop 队列）+ show/finish 徽标重放钩子 + 渲染端 `applied:false` 重试链；desktop-shell 组（含新 queue 测试）+ renderer aggregate 组 21 文件全绿（本 worktree 先 `node packages/dsh-runtime/scripts/build.mjs` 补上缺失产物）。
13. W4 二片（已落）：`badgeTarget` 重命名 + `setBadgeAndWait` 真实回执链 + 能力事实刷新 + 合流失败路径丢弃过时头；desktop 35 文件 + renderer aggregate 全绿、tsc 无新增。
14. **W4 三片 + 计划改判**：桥迟到兜底收窄（仅挂载缺席才启动 + 走闸）与其 lock test；`pushedCountRef`/桥迟到 interval 的**删除项改判为保留**——依据是本仓已有 lock test（`badge-count.test.ts:543-568`，注释记载实测 4.8 Hz 冗余 IPC）与 W4 真实回执已消解闸的提交语义缺陷；
15. W0 仪表增**自判词** `verdict`（`unreadVerdict`：`no-verified-facts` / `m1-zero-watermark` / `m2-seed-not-consumed` / `read-marks-only` / `ok`，record 时自算）——W1 定案不再需要人读代码推断（2 例）。
16. **W3 首片（已落）**：v5 影子写（`UNREAD_V5_KEY` + 投影/净化/有界化/`saveUnreadShadow`）接在 `flushUnread` 的 v4 写之后，只写不读、失败不影响 v4；3 条新测试（投影语义、影子键写序与「只有 v5 时读面仍空」、敌意载荷白名单与写失败 never-throw）。**未落**：v5 权威切换、记录创建时一次性未读、源级地板删除、`LEGACY_NOTIFIED_RUN_ID` 删除（importer 前置已满足，等权威切换同批）。
17. **W3 先锁（已落）**：v5 等价性守卫 + 影子报告面。`saveUnreadShadow` 返回 `{written, parity}`；`parity` = 写后读回（JSON 往返 + 净化）与 v4 的逐会话比对（未读位 → 读位 → 身份，最多 8 条差异）。报告挂 `__dshChamberUnread.shadow()`，**切换权威的前置是 `ok===true`**。测试：投影自洽零差异、裁剪/翻位点名到会话、未读位优先于读位、报告面与发布视图同源（store 39 例 + instrument 7 例）。
18. **W2 身份读数面（已落，只读）**：`notificationIdentityOf` 分类身份来源（`run-id`/`host-turn`/`watermark`/`event-nonce`/`constant`），`notificationRunId` 委托它保证单一产出；通知台账与 incident 带 `identity(identitySource)`。测试：分支优先级（宿主事件 id > kind 分支）、ask/request 同页两次身份不同、`constant` 兜底标注、全部身份可 `isSessionRunId` 载入（新 3 例）。**未落**：身份替换（需 host `lastTurnEnd.seq` 进候选 + 删 `Date.now()` 族），随 v5 权威切换。
19. **W3 启动期影子对账 + W5 前置护栏（已落）**：`reconcileUnreadShadowOnLoad`（`App.tsx` 载入点，`phase='startup'`，漂移只 loud 不改判定）+ 新护栏测试文件三条只读源码门（未读单一实现 / `Date.now()` 预算 ≤1 / `loadUnread` 不得引用 v5 键）；store 40 例 + instrument 7 例 + wiring 全绿。

20. **W1 M1 守侧（已落）**：`unread-derivation.ts` 增加「无可用 host 水位 ⇒ 不结算」分支（不产 `unread=false`、不 `delete edge[]`、保留已武装与上一拍未读），配 1 例新回归 + 改判 1 例旧 pin（旧行为会抹掉刚武装的点）；源侧成因仍待定案。
21. **W1 实机定案（2026-09-26，只读取证）**：①mux baseline 原始响应 123/123 带真实 `updatedAt`（0 个 0）⇒ RC-1「行水位为 0」证伪，**M2 定案**；②WKWebView localStorage 实测 `unread.v4` = `{readSources:[],edgeSources:[],localRuns:35}` ⇒ 读表/臂表全空、只有已通知身份 ⇒ 未读集 ≈ 全表（Dock 大数字直因）；③W0 读数面增判词 `all-rows-unread`（`unread === rows`），让下一次读数一眼给出该形状（+3 断言）。
22. **W1 实机定案（续，2026-09-26）：M2 抛出点已定位** —— 本机权威日志（`~/Library/WebKit/*/…/localstorage.sqlite3` 的 `dsh-chamber.authority-log.v1`.local 环）实测 32 条：`unread-derive-error: derive-unread: Minified React error #185`（Maximum update depth exceeded）+ 一串 `status-divergence`；`facts-health` 显示 `ready=1 rows=126 baselines=125 baselineFailures=4`（载体在超时窗口间闪烁）。跨 9 天 18 份 localStorage 的 `unread.v4` **全部** `read:{}`+`edge:{}`（`notifiedRuns.local` 35）⇒ 未读派生从未成功落过一拍。
23. **W1 M2 第一片（已落）：派生重入闸** —— `createUnreadStepGate`（`unread-store.ts`）+ hook 接线 + 3 条回归 + 源码锁更新；32 文件全绿、`tsc` 无新增。语义：派生体永不嵌套，重入请求去重后排微任务；非重入路径行为不变（§0 冻结内）。
24. **W1 M2 读数面（已落）**：闸带计数 `stats={runs,coalesced,deferrals}` 并随每次派生进 `__dshChamberUnread` 记录（`last().gate`）——实机复核不必再猜「环还在不在」：`coalesced > 0` 即环存在且被吸收，`read` 表非空即未读面首次落盘。测试：闸统计（3 重入/1 补跑/2 次执行）与记录字段。
25. **W4 四片（已落，需实机复核）：Dock 陈旧大数字的三重闸拆除** —— ①节点侧不再以 `mainWindowAlive` 预判拒写（`badgeBlockedResult` 删除）；②Swift 腿去掉 `no-window` 守卫（dockTile 应用级）；③Swift 腿同值跳过 + 写后真读回 `{count, applied}`，节点侧如实转达读回不一致。证据：`node-edges.test.ts` ⑲/⑲b/⑳（24 例全绿，⑳ 为源码锁）、`test/desktop-shell/node-edges-queue.test.ts`（「已关窗仍须入队」改写）、
`SwiftEdgeHostLegsTests` 新增 4 例；**Swift release 门已绿**（`node scripts/gates/run-swift-tests.mjs` → `582 executed, 0 failures, 0 skipped`，
scratch 日志不入库），其中新路径实跑证据：`[shell] badge write count=3 applied=true label=3`、`count=0 applied=true label=nil`（清 0 通路）、
`count=4 applied=false label=999`（读回不一致如实报）、`count=4 applied=true label=4`（按读回改写）。**待实机**：重建后关闭主窗再让 renderer 推 0，Dock 数字必须消失。
26. **删除清单普查（2026-09-26，先锁后删的"锁"侧证据）**：对 §4 全部符号做了 src/测试引用普查——`settleFence` 51/88、`armedFloor` 28/14、`seedSettleFence` 7/10、`withdraw` 15/39、`forgetArmed` 4/2、`factsSeeded` 19+4/23、`fenceSeeds` 10+1/6、`factsBaselineSeed` 5/7、`seedReadFloor` 5/9、`associateCompletion` 4/11、`LEGACY_NOTIFIED_RUN_ID` 7/6、`LOCAL_EVENT_GENERATION` 2/3。结论：**每个删除目标都已有行为锁**（测试直接引用），删除的剩余前提只有 v5 权威切换；`clearSettleFence` 经普查**不存在**（原清单笔误，已删该条）；`writeAliases` 名不存在（落盘是 `readAliases` 邻内的内联写）。
27. **W4 续（已落，Swift 门绿）：`resetFacts` 的 alive 谎报** —— 原实现硬编码 `mainWindowAlive: true`，与 `willClose` 的文档语义（关窗期间同步门一律不过）矛盾：
  sidecar 在窗口关着时重启 ⇒ 新 sidecar 以为可投递 ⇒ 通知/深链在关窗时段被静默丢。修法：`mainWindowDeliverable`（建窗/`didBecomeKey`→true、`willClose`→false）+ `resetFacts(isKeyWindow:mainWindowAlive:)` 参数化 + 测试；
  同时把手写 `doNotMatch` 之外的坏载荷纪律补进 `setBadge`（缺 `count` = 协议违例 loud 拒绝，绝不 `?? 0` 清空 Dock）。Swift release 门 582 例 0 失败 0 跳过。
28. **RC-3 日志取证（2026-09-26，只读）**：`shell.log.1` 544 次 badge-count invoke（08:33:43–08:35:37，含 4ms 内 10+ 次）；`sidecar.log.1:687-694` 同刻 8 条 setBadge 腿失败，原因是 `canShowUI()==false`（未打包 dev 会话）**而非** `no-window`（全库 no-window=0，我第 15 轮的猜想在那批日志里**未被证实**）；打包会话自 09:44 起 badge 活动为零 ⇒ Dock 值冻结且无纠正尝试。结论：不清值的主因是**缺少纠正链**（电平 target/重放/真读回），不是单点丢写——W4 四片按此落地，重建后以 `[shell] badge write count=… applied=…` 定论。
29. **W2 身份前置调查（2026-09-26，只读，无代码改动）**：`host:turn/<seq>` 身份**可达但未接线**——`completionSeq` 有消费无生产（唯一消费 `notification-identity.ts:94`；实机 `notifiedRuns` 全是水位族 `chamber:local:0:<session>:<watermark>`）；数据面其实齐备（本地 `source-mux-facts.ts:402-409` 已抽 `turn/end.seq`、facts 行带 `lastTurnEnd`、gateway 协议有 `SessionTurnEnd.seq`）。**已于轮 21 落地**（W2 段『已落证据』：候选/pending/释放/直传 + 3 条测试，四套 140/140，`tsc` 基线 10 无新增）；本地 seq 出现率待重建后由 `identitySource` 分布读。
30. **durable 键普查（2026-09-26，只读）**：把实机 localStorage 的每个 `dsh-chamber.*` 键映射到符号所有者，纠正两处普查误差：
①别名表所有者是 `notification-outbox.ts` 的 `rememberAlias`/`persistAliases`（**不是**不存在的 `writeAliases`），src 引用 3/2/2/4/3/2/7；**「测试引用 0」于轮 27 更正**：符号引用 0，但存在 2 个行为锁（随删除改写成替代锁）。角色已被 W2 收窄（带 `completionSeq` 的意图直接跳过别名改写，`:221-223`）⇒ 轮 27 删除；
②`dsh-chamber.purged-sessions.v1:*`（48 个键、最大 34 KB）属 **sidebar 插件的归档清理**（`dsh-chamber-client-ui-sidebar/src/client/purged-session-store.ts`），**不是**本方案对象（登记以免误删/误判）。
另：`notification-outbox.v2` 实机 4 B（空）、`unread.v5` 不存在 ⇒ 旧构建符合预期。
31. **W2 身份接线（已落，轮 21）**：`completionSeq` 生产者补齐（候选 ← `lastTurnEnd.seq`）→ durable `pending` → 释放/直发通知 → outbox 键与台账；缺席时形状与修复前逐字一致（水位族回退）。测试：`completion-observation`（候选带/不带 seq）、`notification-projection`（pending 往返 + 身份不被改写 + 释放）、`unread-store`（sanitizer 数值域）；renderer 70 文件 809 例仅 1 个既存环境失败（`required-extra-rows`），`tsc` 10 基线 0 新增。
32. **W2 时钟族删除（已落，轮 26）**：`LOCAL_EVENT_GENERATION = Date.now() * 1_000` 删除，页代判别符改为 **CSPRNG 抽取的 53 位安全整数**（`globalThis.crypto.getRandomValues`，21 位高位掩码 + 32 位低位；`chamberRunId` 以十进制存、`isSessionRunId` 要求安全非负整数）。WHY：墙钟既**跨页会撞**（同毫秒两次加载）也**会被 NTP 回拨**，而页内非事件只需要「跨页唯一、页内稳定」；页内两次 ask 仍由 `localEventSequence` 区分（语义不变）。源码门按就绪矩阵要求同步收紧 **`Date.now() ≤1` → `0`**，并新增 CSPRNG 形状断言；身份套件 4 + 门 3 + 投影 35 + outbox 24 全绿。剩余回退族（`chamber:` 水位/constant + `LEGACY_NOTIFIED_RUN_ID`）仍随 v5。
33. **实机 mux `session/follow` 取证（2026-09-26 轮 27，只读、不需要 WebView 授权）**：`/api/i/local/api/remote.mux` 的 WS 升级**在 loopback 上不要求签名 cookie**（`$events` → `ready` 直接返回），据此对 4 个已完成会话各开一条 `session/follow`，快照记录的形状与 `turnEndFromRecord` 的解析契约**逐字一致**：`{"type":"event","event":{"type":"turn/end","seq":106,"time":1790427628838,"data":{"reason":{"kind":"completed"}}}}`，另一会话 `seq=2877`/`time=1790427573133`。
    结论：**本地 `turn/end` 恒带宿主事件序**（这是 W2 身份生产者的数据面，比读 `notifiedRuns` 前缀更强——不依赖旧构建是否接线）；`host:turn/<seq>` 不是理论可达，而是线上现实。脚本：一次性只读探针（取证后即删，不入库）；可复现配方 = 上面的 WS 帧形状 + item 39 的 `session/prompt` HTTP 帧。
34. **别名表删除（已落，轮 27）**：见 §4 第 300 行与矩阵 C 行；两个行为锁改写为替代锁，outbox 24/24。
35. **app 重建在本轮被环境阻塞（2026-09-26 轮 27，证据）**：`vendor/harness-checkout/` **存在但为空**（无 `.git/modules/vendor/harness-checkout`），`pnpm --filter @dsh-chamber/desktop run bundle:dsh` 因此报 `[upstream-patches] 读不到上游 patch 源 …/vendor/harness-checkout/pnpm-workspace.yaml：ENOENT（先跑 ensure-harness-vendor）`；而 `curl -sSI -m 6 https://github.com` **6s 超时无响应**（无外网），`ensure-harness-vendor.mjs` 只认这一个 submodule 源（明示「不从 codeload 下载、不复用兄弟检出」），`git submodule update --init` 因此也不可达（且 AGENTS.md 禁止未经明确要求跑 git）。⇒ 实机四项读数只能等一个物化了 vendor 树的环境（或你手动 `git submodule update --init vendor/harness-checkout` 后再 `pnpm run build:desktop && pnpm run build:sidecar && pnpm run build:swift-app`）。已安装 bundle（`/Applications/dsh-chamber.app`）仍是 09-26 旧构建，且**不能重启它**：进程树是本会话的祖先（`dsh-chamber(7498) → sidecar(7501) → dsh harness(7507) → 本工具`），杀掉即杀掉本会话。
36. **四路评审（正确性/完整性/最优性/简洁性，轮 27）结论**：无 blocker、无 major 回滚项；两处删除「完整、无孤儿、锁已换」。三条已修：页代抽到 0 的概率性断言（抽到 0 归一为 1，断言变精确）、门放宽到 `Date.now|new Date|performance.now`、跨页唯一性行为锁（cache-busted 二次 import）。两条已记录：①**别名表对 facts↔壳从未生效**（facts intent 从不带 `hostObservedAt` ⇒ 键族不同；细节见 design 19 §3.7），②**壳 sink 缺 `runtimeSettled` 锚点检查**（facts sink 有 `use-unread-notifications.ts:540-555`；壳 sink `use-bridge-subscriptions.ts:774-797` 没有）⇒ 残余重复窗口 =「同页、非首批、producer 状态被重置的壳完成重放」双发。**修复配方（未实施，属行为变更，需裁决）**：把 ~10 行锚点判定搬进壳 sink（`completeLedgerRef` + `factsSnapshot` 都在作用域内；锚点/行缺失即让行 = fail-open，方向仍是重复不是丢失）。**不要恢复别名表**（会重新引入第二事实源 + 60s 窗，且它与 seq 身份冲突）。
37. **轮 27 收尾验证（收尾口径）**：`desktop badge.test.ts` 15/15；renderer 70 文件 / 811 用例，唯一红 = 既存 vendor 用例 `required-extra-rows`（`@deepseek-ai/dsh-typert-registry` 无 client entry）；`tsc` = 10 条既存环境错误 / 0 新增；`check:static` = **1/20 失败**（`verify:registry`，vendor 未物化）。**顺带修掉一条真实门红**：`verify:file-budgets` 曾因本会话早前几轮的净增行而红（`App.tsx` 2463>2446、`shell-core.ts` 1329>1318）——本轮把**自己加的行**压缩回 ratchet 之内（2446 / 1318 整数回到 ratified，未上调任何预算），门恢复绿色；同时删掉失败构建留下的半成品装配 `packages/desktop/release/`（缺 `node`/`pnpm`/`vendor/dsh`，会让 `scripts/gui-acceptance` 在不可运行的装配上报错）。
38. **vendor 树物化 + 全量门绿（2026-09-26 轮 28）**：用户授权 checkout 并给出代理 `192.168.110.143:10000`。代理下 `git submodule update --init` 的 pack 传输**中途停滞**（`tmp_pack_*` 停在 97.8 MB、git 进程 0% CPU、12s 内零增长）⇒ 改用**本地克隆**：主检出早已在 pin 上物化过该 submodule（`.git/modules/vendor/harness-checkout` 236 MB，HEAD = pin）、且 `submodule.<name>.url/active` 已在 config 里；于是 `git clone --no-checkout --separate-git-dir <worktree modules> <main modules> vendor/harness-checkout` + `git checkout --detach <pin>`（**零网络**，146 MB 工作树，HEAD 校验通过），再 `node scripts/dev/ensure-harness-vendor.mjs`（补 329 条链接，pin 硬校验通过）。`pnpm install --frozen-lockfile` 首次因 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止（工作区从 25 → 354 个项目，pnpm 要重建 `node_modules`）⇒ `CI=true` 重跑成功。**随后 `node scripts/gates/run-checks.mjs full --continue` = 61/61 步全过**（含此前 25 条 vendor 失败、typecheck、Swift 套件、electron-artifacts smoke）；此前记录的「vendor 未物化 ⇒ 25 步红」基线就此作废。
39. **隔离实机跑通（2026-09-26 轮 28）**：`macos/release/dsh-chamber.app`（新构建）以**未打包 dev 二进制**（`macos/.build/release/DSHChamber`，env 覆盖生效；打包 .app 故意过滤 `DSH_CHAMBER_SHELL_*`，见 `BridgeClient.filteredShellEnvironment`）起隔离实例：独立 userData + `DSH_CHAMBER_CP_PORT=17570` + `DSH_CHAMBER_SHELL_DSH_PATH=<repo>/packages/desktop/vendor/dsh`，4 s ready。**真实 turn 跑通**（`POST /api/i/local/api/session/prompt`，体 `{type:'client-request',rpcId:'…'(字符串!),method:'session/prompt',payload:{args:{request:{requestId,sessionId,mode:'queue',content:[{type:'text',text}],clientTimeZone}}}}` → `accepted:true` → `turns=1` → idle）。读数：新键 **`dsh-chamber.unread.v5` 出现**（旧版没有）；`authority-log` 记下 `facts-health ready=1 baselines=1` 与 `status-divergence …:status=1:row=0`；把同一 origin 装进 headless Chrome（CDP）后读到**真实派生输入**：`branch=facts rows=2 maxWatermark=1790430804219(>0，M1 不成立) unread=1`、`shadow={phase:'write',written:true,ok:true,differences:[]}`（v5 影子等价**实测通过**）、判词 `m2-seed-not-consumed`。**限制（不得当结论）**：该环境缺壳侧通道（无 `dshChamberFacts`），WKWebView 侧窗口报 `mainWindowAlive=false` 且 sidecar 随后退出；v4 `read/edge` 在两条环境里都仍为空 ⇒ 「落盘为何仍空」**只能在打包 .app（真壳 + 真 Dock）里定论**，本工作树无法重启正在运行的安装态（进程树 = 本会话祖先）。
40. **实测揪出的仪表语义缺陷（已修）**：`factsRead.consumed` 原先只在**刚播种那一拍**置 true，之后每拍都报 `consumed=false` ⇒ 健康稳态被判成 `m2-seed-not-consumed`（隔离实机逐拍实测复现），判词从此分不清「已消费」与「未消费」。修法：**下沉到纯模块**——`factsBaselineSeed` 的返回面加 `alreadySeeded`（`seededIncarnation !== undefined && seededIncarnation === incarnation`，未播种分支同样给出），hook 置 `consumed = seed.seeded || seed.alreadySeeded`；`unread-instrument.ts` 的判词/字段 JSDoc 同步。首版改法曾把 `incarnation` 提前成局部量，撞上 `unread-prune-roster-gate.test.ts:572` 的**源码形状锁**（该锁要求 `incarnation: sourceLifecyclesRef.current?.capture(sourceId) ?? bootToken` 内联）⇒ 已改回内联形态，锁与语义两全。这是**修正仪表读数**，不改产品判定路径。
41. **全量门重跑与唯一红步（2026-09-26 轮 28）**：vendor 物化后首轮 `run-checks full --continue` = **61/61**；仪表语义缺陷修完后重跑 = **60/61**，唯一红步 `test:control-plane`，失败点 `spawn-dsh.test.ts:738` 的 `assert.equal(files.length > 0, true)`（等 `host-logs/*.log` 落盘）——负载下的时序竞态，**非本改动引入**（该测试文件与本次改动无交集，mtime 09-26 18:41 = 检出时间；单独跑 `node packages/control-plane/scripts/test.mjs` exit 0、606 例全过；同轮两处先前红步 `unread-prune-roster-gate` 已随源码形状锁复原转绿）。**确认轮（第 4 次）`run-checks full --continue` = 61/61 全过**（同一代码、空载环境），坐实该红步是负载时序竞态而非缺陷。产物：`macos/release/dsh-chamber.app`（489 MB，09-26 21:42，`Contents/Resources/dist/web/index.html` 在场）+ `packages/desktop/release/sidecar`（装配）。

## 9. 证据索引（文件:行 → 结论）

| 位置 | 结论 |
|---|---|
| `watermark.ts:24-26` | 合法水位含 0（根因放大器） |
| `source-mux-facts.ts:281-293` | 列表项解析：`running` 布尔 + `updatedAt` 水位 |
| `source-mux-facts.ts:1015-1031` | 基线原子接受；失败会记 `baselineFailures` |
| `source-mux-facts.ts:1225-1245` | `api-session/activity` 是 host 水位入口 |
| `unread-derivation.ts:159,233-249` | 删通道臂；播种只在 `through>0` |
| `unread-store.ts:477-519` | host 水位口径 / 源级地板 |
| `use-unread-notifications.ts:235-255,519-572` | 播种与 apply 入口（派生必跑） |
| `completion-observation.ts:583-599` | withdraw / forgetSession 抹易失态 |
| `complete-ledger.ts:81-113,203-228` | 围栏与撤回 API |
| `notification-outbox.ts:15-21` | 别名表**已删（轮 27）**：只剩存量键一次性清理位点（删除记录见 §4 C 行 / §8 第 34 条） |
| `notification-identity.ts:62,79-97` | 迁移哨兵与页面代身份 |
| `use-badge-count.ts:182-192` | 提交闸 + 计数 publish |
| `node-edges.ts:200-247,342-353,583-592` | 队列覆盖 / 无窗丢写 / 能力缓存 |
| `shell-core.ts:487-493,1049-1057` | 窗口恢复不重放；仅设置翻转 reconcile |
| `SwiftEdgeHostLegs.swift:563-584`；`MainWindowController.swift:1015-1023,1053-1058` | 无窗丢弃 / alive 谎报 |
| `session-authority.ts:201` | 假完成源头 |
| `ShellDebug.swift:29-33` | 打包态无观测面 |
| vendor `list.js:293-302`、`manager.js:670-685` | 水位派生规则与投影前提 |
| `source-mux-facts.ts:492-503` | 基线合并用 `Math.max` 抬升水位（"status 行压低水位"被排除） |
| `unread-instrument.ts` | W0a 仪表：分支/行数/最大水位/行样本/播种读数（`__dshChamberUnread`） |
| `facts-health.ts:26-60` | W0b：健康环 detail 增 `maxWatermark=` |
| `SwiftEdgeHostLegs.swift:575-596`、`node-edges.ts:398-421` | W4 四片：角标三闸拆除（无窗守卫 ×2 + 同值 + 真读回）；旧行为 = `no-window` 丢弃清 0 写 |
| `unread-store.ts:649-724` | W1 M2：派生重入闸（`coalesced/runs/deferrals` 读数）|

**已知的既存门失败（非本方案引入，勿再当回归）**：`node scripts/gates/run-checks.mjs static` 的 `verify:registry`（内部 `verify:styles` S4/S6）
在本 worktree 恒红，命中 `packages/dsh-client-web/src/base.css:29-30`、`packages/gateway/src/login-page.ts`、
`ui-sidebar`/`ui-settings-bridge`/`ui-settings-connections` 的 CSS module 死声明；这些文件本轮零改动，mtime（09-26 18:41，
工作树物化时刻）早于本方案全部改动（20:29+）。`pnpm run verify:anchors` 同批恒红：唯一失败锚在 `docs/design/19-notifications.md`
指向 `vendor/harness-checkout/…`（本 worktree 无该 vendor 路径；同 `vendor-session-fact-contract` 的 `DSH_CHAMBER_VENDOR_ABSENT` 家族），
本方案新增的文件引用不在失败项内。本方案的验收证据以定向套件 + `tsc` 为准（§5）。

**全量门基线（2026-09-26，`node scripts/gates/run-checks.mjs full --continue`）：61 步 / 25 步失败。**
注意 `full` **默认 fail-fast**（首跑只执行 2 步就停，日志却写「1 of 33」——不要据此宣称其余通过）；要完整基线必须加 `--continue`。
25 条失败**全部**归因同一个环境因：本 worktree 未物化 vendor 树（`vendor/harness-checkout`、`vendor/harness-packages` 缺失）。
签名证据：`ERR_MODULE_NOT_FOUND` **28 处**、`Cannot find module '…/vendor/harness-packages/@deepseek-ai/{dsh-typert-protocol,dsh-client-modules,dsh-client-ui-layout,dsh-client-ui-chat,dsh-client-ui-conversation,…}'`、
`verify:registry` 的 9 条「upstream 路径在 pin 住的 vendor 树里不存在」、`verify:styles` 首行「上游 token 集为空——vendor 树未 bootstrap」。
失败步：`verify:{styles,registry,file-budgets,anchors,upstream-lifecycle-contract}`、`typecheck{,layout,client-web,connection,api-gateway}`、
`test:{scripts,renderer-shell,layout,api-gateway,host-open-in,host-archive-cleanup,connection,open-in,settings-bridge,sidebar,runtime,control-plane}`。
**与本次改动无关的两条独立证据**：①失败原因签名是 vendor 路径缺失（不是行为断言失败）；②本方案改动过的面直接单跑全绿——
renderer 70 文件 809 例（唯一失败 `required-extra-rows` 亦为同类 vendor 缺失）、desktop 65 文件 1012 例 0 失败、
Swift release 门 582/0/0、`tsc -p tsconfig.json` 恰好 10 条既有 vendor 解析错误（0 新增）。
逃生口：`node scripts/dev/ensure-harness-vendor.mjs` 物化 vendor 树后可复跑（本会话未执行——§7 非目标「不动 vendor」）。
一键实机复核脚本：`.tmp/verify-remediation.mjs`（只读；已在旧构建上干跑验证无假 PASS）。
