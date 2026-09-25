/**
 * P2 wiring lock: the session-fact authority has exactly ONE policy owner (the pure
 * package) and one executor; the App holds no second planner/state machine.
 *
 * These are source-text locks, not behavior tests: the behavior lives in
 * packages/dsh-stream-state/test/authority/ and the executor's own suite. They exist
 * to make "a new repair function at the symptom layer" fail loudly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const app = stripComments(readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8'))
const sidebar = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-ui-sidebar/src/client/index.ts', import.meta.url)), 'utf8'))
const executor = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-core/src/session-fact-reconcile.ts', import.meta.url)), 'utf8'))
const hook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-bridge-subscriptions.ts', import.meta.url)), 'utf8'))
// 事实第二入口（planFactsNotifications）与升级 ladder 的执行端已随
// 通知/未读投影簇、聚合刷新簇抽到命名 hook；锁跨 App + 两个 hook 取并集
// （presence/absence 都不放松）。
const unreadHook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-unread-notifications.ts', import.meta.url)), 'utf8'))
const factsSource = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/session-facts-source.ts', import.meta.url)), 'utf8'))
const completionObservation = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/completion-observation.ts', import.meta.url)), 'utf8'))
const factsMode = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/session-facts-mode.ts', import.meta.url)), 'utf8'))
const clientCore = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-core/src/derive.ts', import.meta.url)), 'utf8'))
const aggregateHook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-aggregate-refresh.ts', import.meta.url)), 'utf8'))
const factsHook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8'))
const frame = app + '\n' + unreadHook + '\n' + aggregateHook + '\n' + factsHook
const projection = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/notification-projection.ts', import.meta.url)), 'utf8'))
const logStore = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-core/src/authority-log-store.ts', import.meta.url)), 'utf8'))

test('the App has no second liveness planner or state machine', () => {
  assert.doesNotMatch(frame, /planSessionLiveness|sessionLivenessRef|markSessionLiveness/)
  assert.match(frame, /sessionAuthorityEscalationLadder\(LADDER_TABLES\.authority\)/)
  assert.match(frame, /planLadder\(/)
  assert.match(frame, /chamberBridge\.requestSessionListRefresh\(id\)/, 'the tick drives the executor')
})

test('the producer executes the one authority reducer + probe ladder', () => {
  assert.match(sidebar, /new SessionAuthorityReconciler\(/)
  assert.match(sidebar, /readOfficial: readOfficialProjection/)
  assert.match(sidebar, /readAuthority: readAuthorityRunning/)
  assert.match(sidebar, /correct: correctAuthorityRunning/)
  assert.match(executor, /reduceSessionAuthority\(/)
  assert.match(executor, /sessionAuthorityProbeLadder\(LADDER_TABLES\.authority\)/)
  assert.doesNotMatch(executor, /maxAttempts|verifyTimeoutMs|SESSION_FACT_RECONCILE_DEFAULTS/)
})

test('the write-back only ever writes false, behind the capability guard', () => {
  assert.match(sidebar, /service\.handleSessionStatus\(id, false\)/)
  assert.doesNotMatch(sidebar, /handleSessionStatus\([^)]*true[^)]*\)/)
  assert.match(sidebar, /typeof service\.handleSessionStatus !== 'function'/)
})

test('authority actions persist to the machine-local ring (P5)', () => {
  assert.match(sidebar, /appendAuthorityLog\(storage, chamberInstanceId, entry\)/)
  assert.match(sidebar, /authorityLogStorage\(\)/)
  assert.match(logStore, /AUTHORITY_LOG_KEY = 'dsh-chamber\.authority-log\.v1'/)
  assert.match(logStore, /AUTHORITY_LOG_MAX_PER_SOURCE = 32/)
})

test('completion notifications have one policy entry (P3, goal-aware v5 migration)', () => {
  // Wave3 迁移后：壳 report 与 facts 快照都经 observeSource → applyObservationBatch
  // 喂**唯一**的 reconcile（notification-projection）；App 与两个接线 hook 都不得再建
  // 第二 planner，也不得在接线层重实现水位原语（nextNotifiedWatermark/shouldNotifyWatermark）。
  assert.match(hook, /observeSource\(/)
  assert.match(hook, /applyObservationBatch\(/)
  assert.match(unreadHook, /observeSource\(/)
  assert.match(unreadHook, /applyObservationBatch\(/)
  assert.doesNotMatch(
    frame,
    /planRuntimeNotifications|planFactsNotifications|detectNotificationEdges|dedupeCompleteEdges|shouldNotifyWatermark|nextNotifiedWatermark/,
  )
  assert.match(projection, /export function reconcile\(/)
  // 旧 planner 只为既有语义测试保留导出面（两个用例集仍直接测它们）；
  // 生产接线锁保证没有调用点（上面的 doesNotMatch）。
  assert.match(projection, /export function planRuntimeNotifications/)
  assert.match(projection, /export function planFactsNotifications/)
})

test('the notification association uses the facts host anchor, never the content watermark', () => {
  // The outbox associates a pending runtime edge with a facts completion through the
  // host `updatedAt` BOTH sides carry. Passing the content watermark (completedAt ??
  // updatedAt) as that anchor was the double-banner defect; the API now requires the
  // anchor object, and this lock pins the one caller's value and its single call.
  assert.match(unreadHook, /hostUpdatedAt: row\.updatedAt/)
  assert.match(unreadHook, /associateCompletion\(\s*\n?\s*sourceId, lifecycle\.fingerprint, row\.sessionId, observed,/)
  assert.match(unreadHook, /pendingSessions\.add\(row\.sessionId\)/)
})

test('the completion observation seam keeps its identity/page-boot/shell-report inputs (v5 §3.2/§3.5)', () => {
  // 两条通道必须用同一个 identity（来源指纹 + 页代 bootToken）与同一个 pageBoot
  // 判定，否则 G1 代际门会在通道之间互相丢弃、fresh 判定会吞掉本页新建的 pending。
  assert.match(hook, /observeSource\(\{[\s\S]{0,400}?identity: completionIdentity\(sourceFingerprint, bootToken\)/)
  assert.match(hook, /pageBoot: bootVerdict/)
  assert.match(hook, /shellReport: true/)
  assert.match(unreadHook, /identity: completionIdentity\(owner\.fingerprint, bootToken\)/)
  assert.match(unreadHook, /pageBoot: bootVerdict/)
  // App 把观测状态 / 落盘出口交给桥（P2a/P2b 的 goal 事实断链守卫）。
  assert.match(app, /completionObservationRef, persistCompletionLedger/)
  assert.match(app, /bootToken: unreadBoot\.boot\.token, bootVerdict: unreadBoot\.boot\.verdict/)
})

test('the badge is fed the merged runtime projection, never the raw channel report (design 19 §3.2.5/§3.7, INV7)', () => {
  // deriveServers 的 server.runtime 才是六面共用的合并投影（通道 ∪ 蓝点 ∪ facts
  // overlay ∪ stale）；原始通道报告（App 的 useState runtimeFacts）里没有 facts-only
  // 的 goal 压制输入，徽标退回它时点/待办/徽标分叉（M5 wiring lock，Wave6 收口）。
  assert.match(app, /record\[server\.id\] = server\.runtime/, '徽标 runtime 必须取 deriveServers 的合并投影')
  assert.match(app, /runtimeFacts: badgeRuntime/, 'useBadgeCount 必须收 badgeRuntime')
  const badgeCall = /useBadgeCount\(\{([\s\S]*?)\}\)/u.exec(app)
  assert.ok(badgeCall !== null, '必须存在 useBadgeCount 调用点')
  const badgeInputs = badgeCall[1]
  assert.doesNotMatch(badgeInputs, /\bruntimeFacts\s*,/u, '不得以 shorthand 把原始 runtimeFacts 传进徽标')
  assert.doesNotMatch(badgeInputs, /runtimeFacts:\s*runtimeFacts\b/u, '不得把原始 runtimeFacts 直接传给徽标')
})

test('the complete ledger persists when a prune/forget changes the durable tables (M6)', () => {
  // 内存是权威、磁盘是缓存：剪枝/退役删掉的 durable 表项（notified/pending/
  // outcomes）必须排一次写，否则重启后旧判定从磁盘复活。App 的早期 effect 在
  // schedulePersistUnread 定义之前就捕获它，所以走 ref 镜像（与 flushUnreadRef 同纪律）。
  assert.match(app, /if \(completeLedgerRef\.current\.prune\(live\)\) schedulePersistUnreadRef\.current\(\)/)
  assert.match(app, /notifiedTable\(\)\[sourceId\] !== undefined/)
  assert.match(app, /pendingTable\(\)\[sourceId\] !== undefined/)
  assert.match(app, /outcomesTable\(\)\[sourceId\] !== undefined/)
  assert.match(app, /ledger\.forget\(sourceId\)/)
  assert.match(app, /schedulePersistUnreadRef\.current = schedulePersistUnread/)
})

test('FINAL-C wiring: the observation-state prune withdraws the ledger scope before any rebuild', () => {
  // 观测状态删除 = 观测代终结：同一拍必须 scoped withdraw 账本易失轨（armed/
  // armedFloor/settleFence/goalKnown）+ pending。否则门关窗口（未结算/degraded/
  // rosterIncomplete）下 durable 剪枝不执行，残留的旧 pending 会被重建的新代首个
  // outcome 以旧 watermark flush。notified/outcomes 保持 durable，故用 withdraw
  // 而非 forget；pending 被删时必须排一次落盘。
  const loopMarker = 'for (const sourceId of [...completionObservationRef.current.keys()]) {'
  const start = app.indexOf(loopMarker)
  assert.notEqual(start, -1, 'the observation-state prune loop must exist')
  const end = app.indexOf('if (durableUnreadPruneAllowed(', start)
  assert.notEqual(end, -1, 'the loop must sit before the durable prune gate')
  const loop = app.slice(start, end)
  assert.match(loop, /completionObservationRef\.current\.delete\(sourceId\)/, 'the observation state is deleted')
  assert.match(
    loop,
    /withdrawObservationState\(completeLedgerRef\.current, sourceId\)/,
    'the same pass must scoped-withdraw the ledger (FINAL-C)',
  )
  assert.match(loop, /schedulePersistUnreadRef\.current\(\)/, 'a dropped durable pending must be persisted')
  assert.match(
    app,
    /import \{[\s\S]*?withdrawObservationState,[\s\S]*?\} from '\.\/completion-observation\.ts'/,
    'the helper is imported from the observation module (single source)',
  )
})

test('the badge push retry chain is cancelable on unmount (M4)', () => {
  const badge = stripComments(readFileSync(
    fileURLToPath(new URL('../../src/app-hooks/use-badge-count.ts', import.meta.url)), 'utf8'))
  // 重试链必须由 createBadgePushRetry 持有：调度前清旧 timer、卸载 cancel
  // （否则在途 reject 会在卸载后继续排 timer）。
  assert.match(badge, /createBadgePushRetry\(\{/)
  assert.match(badge, /badgeRetry\.start\(/)
  assert.match(badge, /useEffect\(\(\) => \(\) => \{ badgeRetry\.cancel\(\) \}, \[badgeRetry\]\)/)
  assert.doesNotMatch(badge, /badgeRetryTimerRef/)
})

test('the retained-view unverified-running arm stays wired (design 05)', () => {
  assert.ok(frame.includes('shouldDropUnverifiedRunningFacts('), 'the 90s bound must stay wired to the drop decision')
  assert.ok(frame.includes('...new Set([...stalledSources, ...unverifiedSources])'), 'both banner sources share one visible set')
  assert.ok(frame.includes('unverified: unverifiedSourcesRef.current.includes(sourceId)'), 'the report must mark unverified sources')
})

test('the escalation ladder gates both levers on stuck evidence', () => {
  assert.match(frame, /stuckEvidence: authority\?\.stuckSince !== undefined/)
  assert.match(frame, /escalationBlocked:/)
})

test('facts decidability has ONE owner: no consumer may re-spell the rule', () => {
  // 缺陷史：判定面曾有三份各写一遍的可用性规则——overlay 的 isFactsUsable、未读接线的
  // 恒真 factsVerified、completion-observation 内联的 !stale 变体。前者渲染用（含 stale），
  // 后两者判定用；一条规则三个写法两个答案，载体抖动时账本在两条通道间来回重算。
  // 现在 owner 唯一（session-facts-source 导出两支谓词），本锁保证没有第四份。
  assert.match(factsSource, /export function isFactsUsable\(/)
  assert.match(factsSource, /export function isFactsDecisionUsable\(/)
  assert.match(factsSource, /verdict === 'ok' && snapshot\.serviceable !== false && snapshot\.stale !== true/)
  // 判定面必须引用 owner，不得内联重写（stale 检查只能出现在 owner 里）。
  for (const [label, text] of [
    ['unread hook', unreadHook],
    ['completion observation', completionObservation],
    ['App read-watermark', app],
  ] as const) {
    assert.match(text, /isFactsDecisionUsable\(|factsDecisionInput\(/, label + ' 必须用唯一判据')
    assert.doesNotMatch(text, /stale !== true/, label + ' 不得内联可判性规则')
    // 判定面**不得**触及渲染支谓词：留着它就能用 isFactsUsable(x) && x.stale === false
    // 越过「唯一判据」的命名锁（审计 B 的已验证逃逸路径）。
    assert.doesNotMatch(text, /isFactsUsable/, label + ' 是判定面，不得引用渲染支谓词')
  }
  // 未读接线的两个消费点必须**同源**：facts 键与 factsVerified 取自同一个判据元组。
  assert.match(unreadHook, /const factsDecision = factsDecisionInput\(factsSnapshot\)/)
  assert.match(unreadHook, /const factsRows = factsDecision\.rows/)
  assert.match(unreadHook, /factsVerified: factsDecision\.verified/)
  // 回归锁：曾经那一行是「可用 ? serviceable!==false : true」——恒真，规则 0 成了死代码。
  assert.doesNotMatch(unreadHook, /\?\s*\w+\.serviceable !== false\s*:\s*true/)
  assert.doesNotMatch(unreadHook, /usableFacts/)
  // 只升不降的读水位不得从冻结/降级的行推进（读水位也走同一个判据元组）。
  assert.match(app, /const rows = factsDecisionInput\(factsStore\.getSnapshot\(\)\.session\[sourceId\]\)\.rows/)
  assert.doesNotMatch(app, /snapshot\.verdict === 'ok' \? snapshot\.rows/)
  // 能力一览（session-facts-mode）也不得内联重写可判性规则。
  assert.match(factsMode, /return isFactsDecisionUsable\(snapshot\) \? 'full' : 'degraded'/)
  assert.doesNotMatch(factsMode, /snapshot\.stale === true \? 'degraded'/)
})

test('every RENDERED runtime row field rides the report signature (factAt)', () => {
  // runtimeReportSignature 是 App 提交运行时事实前的去重键：漏签一个渲染字段，
  // 该字段的单独变化就被整个丢弃（factAt 冻结 ⇒ data-chamber-fact-at 永远首见值）。
  assert.match(clientCore, /\(facts\.factAt \?\? 0\) > 0 \? facts\.factAt : ''/, 'factAt 必须进行编码（0/缺席同为「无观察者事实」，不制造 churn）')
})
