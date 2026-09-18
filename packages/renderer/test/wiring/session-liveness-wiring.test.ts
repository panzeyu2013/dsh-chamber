/**
 * 运行位活性守卫的接线契约（2026-12；Swift 原生版 ui-chat「深度求索中」修复）。
 *
 * App.tsx 渲染整个壳、无法被 node 测试导入，因此这里沿用仓内的**源码文本
 * 契约**范式（见 test/support/source-text.ts 的说明）：绿只证明 SHAPE。
 * 行为由两侧纯模块测试覆盖——
 *  - renderer/test/lifecycle/session-liveness.test.ts（决策：门槛/限频/封顶/
 *    升级依据/清除）；
 *  - dsh-chamber-client-ui-sidebar/test/session-state/session-fact-reconcile.test.ts
 *    （执行：单飞/有界重试/回执）。
 *
 * 每一条链都是**静默 no-op**：少了 planSessionLiveness 调用，守卫永不触发；
 * 少了 requestSessionListRefresh 派发，L1 只读对账不会发生（running 位永久
 * 停留）；少了 reconnectInstanceConnection 派发，对账通道坏掉时没有 L2；
 * 少了回执字段，守卫无法区分「宿主确实还在跑」与「拿不到权威结论」（会变成
 * 按静默时长升级的 reconnect 风暴）；少了清理/dispose，来源退役后状态与链
 * 泄漏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../support/source-text.ts'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('App：守卫在既有 staleness watchdog 内规划，并把三级动作派发到既有 seam', () => {
  const code = stripComments(read('../../src/App.tsx'))
  const watchdogAt = code.indexOf('const runStalenessWatchdogNow = useCallback(')
  const planAt = code.indexOf('planSessionLiveness(sessionLivenessRef.current')
  assert.notEqual(watchdogAt, -1, '既有 staleness watchdog 回调存在')
  assert.ok(planAt > watchdogAt, '守卫在 watchdog 回调内规划（复用它的 30s 节拍与隐藏期门控）')
  const refreshDispatch = code.indexOf('chamberBridge.requestSessionListRefresh(action.sourceId)')
  const reconnectDispatch = code.indexOf('reconnectInstanceConnection(action.sourceId)')
  assert.ok(refreshDispatch > planAt, 'L1 只读对账经既有刷新通道派发')
  assert.ok(reconnectDispatch > planAt, 'L2 经既有 reconnect 杠杆派发')
  assert.match(code, /action\.kind === 'refresh'/, '按动作种类分派')
  assert.match(code, /action\.kind === 'reconnect'/, '按动作种类分派')
  assert.match(code, /setStalledSources\(prev =>/, '停滞来源回写 App 状态')
  // 代际指纹进输入（跨会话/跨代际不得继承旧时段的配额与提示）。
  assert.match(code, /generation: generationBySourceId\.get\(id\)/)
  // L2 记账移到能拿到返回值处：no-op 不得消耗预算；且与既有 S2 臂共用账本。
  assert.match(code, /if \(reconnectInstanceConnection\(action\.sourceId\)\) \{/)
  assert.match(code, /markSessionLivenessReconnect\(/)
  assert.match(code, /lastReconnectAtRef\.current = \{ \.\.\.lastReconnectAtRef\.current, \[action\.sourceId\]: now \}/,
    '与 S2 臂共享同一份 per-source 重连账本（L2 之后 S2 的退避必须看得到）')
  // 同 tick 去重必须用本 tick 的局部集合（墙钟窗口会把已到期的 L2 推迟一个退避周期）。
  assert.match(code, /const reconnectedThisTick = new Set<string>\(\)/)
  assert.match(code, /if \(reconnectedThisTick\.has\(action\.sourceId\)\) continue/)
  // **另有两条臂也要登记**：fallback-view 重建臂漏登记就会被守卫再重连一次
  // （三轮复核抓出的同 tick 双重重连）。断言必须**切片到该臂内部**：同形状的登记块
  // 在 S2 臂里同样成立，不切片时删掉这条臂的登记仍然全绿（2026-12 独立复核）。
  const fallbackArmAt = code.lastIndexOf('if (!shouldRebaselineFallbackView({')
  assert.ok(fallbackArmAt > 0, 'fallback-view 臂必须存在（本条锁的切片锚）')
  assert.match(code.slice(fallbackArmAt),
    /if \(reconnectInstanceConnection\(id\)\) \{\s*lastReconnectAtRef\.current\[id\] = now\s*reconnectedThisTick\.add\(id\)/,
    'fallback-view 臂执行 reconnect 后必须登记本 tick 集合')
  // 跨 tick：L2 必须看 S2/fallback 臂的 per-source 账本（否则几十秒内连发两次）。
  assert.match(code, /now - lastReconnectAt < AGGREGATE_RECONNECT_BACKOFF_MS/)
  // no-op 也要记账：连续 no-op 是 L3 的第二条出口。
  assert.match(code, /markSessionLivenessReconnectNoop\(/)
  // 守卫读的是**原始** runtimeFacts（投影 mergeRuntimeFacts 刻意丢掉回执）。
  assert.match(code, /watchdogRuntimeFactsRef\.current\[id\]/)
  assert.match(code, /sessions: report\?\.sessions/)
  // App 必须把共享重连账本喂进守卫（同 tick 集合 + 跨 tick 退避两条子句都要在）：
  // 缺任何一条都会让"派遣后被 App 丢弃"的记账缺口回来（2026-12 二轮独立复核）。
  assert.match(code,
    /reconnectBlocked: reconnectedThisTick\.has\(id\)\s*\|\| \(lastReconnectAtRef\.current\[id\] !== undefined\s*&& now - lastReconnectAtRef\.current\[id\] < AGGREGATE_RECONNECT_BACKOFF_MS\)/,
    'the App must feed both ledger clauses into the planner')
  // 镜像写入本身也必须存在：删掉它守卫读到的永远是空事实（静默失效），
  // 而此前没有任何锁覆盖这一行（2026-12 独立复核）。
  assert.match(code, /watchdogRuntimeFactsRef\.current = runtimeFacts/,
    '原始回执必须在渲染期写进镜像')
  assert.match(code, /\{ reconcile: report\.sessionFactReconcile \}/)
  // 隐藏期门控继承：visibilitychange 补偿 tick 必须走同一个 watchdog 回调，
  // 否则隐藏期间到期的回执要等到下一次可见性变化才被消费。
  assert.match(code, /const onVisibilityChange[\s\S]{0,400}runStalenessWatchdogRef\.current\(\)/,
    'visibilitychange 补偿 tick 必须驱动同一个 watchdog（守卫继承隐藏期门控）')
})

test('App：L3 提示是非模态横幅，动作全部是用户选择（绝不自动重载）', () => {
  const code = stripComments(read('../../src/App.tsx'))
  assert.match(code, /className="session-stall-layer"/)
  // role=status 只包文本（交互后代进 live region 会被整体重播）。
  assert.match(code, /className="session-stall-text" role="status"/)
  // 与 boot-gap 横幅同规：致命覆盖层出现时横幅不得渲染（视觉被盖住但仍可
  // 聚焦/被读屏播报是本仓已修过的 MINOR）。
  assert.match(code, /visibleStalls\.length > 0 && !controlUnreachable && activeShellError === null/)
  assert.match(code, /t\('sessionStall\.text', \{/)
  assert.match(code, /t\('sessionStall.reconnect'\)/)
  assert.match(code, /window\.location\.reload\(\)/, '重载只作为显式按钮动作存在')
  assert.match(code, /t\('sessionStall.dismiss'\)/, '误报可被用户忽略（与 mobile session-stall 同纪律）')
  assert.match(code, /const visibleStalls = stalledSources\.filter\(id => !dismissedStalls\.includes\(id\)\)/)
  // 手动重连也必须有界：60s per-source 退避（连点会各自重放完整 baseline），
  // 且记账必须发生（否则自动臂立刻补一次）。
  assert.match(code, /lastReconnectAt !== undefined && at - lastReconnectAt < AGGREGATE_RECONNECT_BACKOFF_MS/)
  assert.match(code, /markSessionLivenessReconnect\(\n\s*sessionLivenessRef\.current, id, at\)/)
  // 自动重载必须不存在：reload 只出现在按钮的 onClick 里。
  const reloadSites = code.split('window.location.reload()').length - 1
  assert.equal(reloadSites, 1, 'reload 只有一个调用点（按钮动作）')
})

test('producer：对账链以官方 refresh 为执行面，回执进运行时事实，dispose 随 effect 清理', () => {
  const producer = stripComments(read('../../../dsh-chamber-client-ui-sidebar/src/client/index.ts'))
  assert.match(producer, /import \{\n\s*SessionFactReconciler,\n\s*sessionFactsConverged,\n\s*type SessionFactVerdict,\n\} from '\.\.\/shared\/session-fact-reconcile\.ts'/)
  assert.match(producer, /new SessionFactReconciler\(\{/)
  assert.match(producer, /refresh: officialSessionRefresh/, '执行面就是既有的官方 refresh（含方法调用形态的坑）')
  // 权威判定 seam：官方 refreshList 对「拉取失败」照常 resolve，没有 verify 就
  // 会把失败记成健康回执（守卫永不升级）。
  assert.match(producer, /verify: verifySessionFactConvergence/)
  // 三值判定：探针失败 = unknown（不升级），只有权威正面证伪才 stale。
  assert.match(producer, /const verifySessionFactConvergence = async \(\): Promise<SessionFactVerdict>/)
  assert.match(producer, /return 'unknown'/)
  assert.match(producer, /return sessionFactsConverged\(byId, snapshot\.sessions\) \? 'converged' : 'stale'/)
  assert.match(producer, /onSettled: \(\) => \{ sync\(\) \}/, '结算后重发运行时事实')
  assert.match(producer, /sessionFacts\?\.request\(\)/, '既有 refresh 广播通道同时驱动对账链')
  assert.match(producer, /purgedRows\.converge\(\)/, '归档清理的幽灵行收敛链保持原样')
  assert.match(producer, /sessionFacts\?\.dispose\(\)/, 'effect 清理必须 dispose 对账链')
  assert.match(producer, /sessionFactReconcile: reconcile/, '回执与事实同源上报')
})

test('契约：运行时事实通道带可选回执字段（类型面）', () => {
  const store = stripComments(read('../../../dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts'))
  assert.match(store, /sessionFactReconcile\?: SessionFactReconcileSnapshot/)
  assert.match(store, /import type \{ SessionFactReconcileSnapshot \} from '\.\/session-fact-reconcile\.ts'/)
})

test('跨模块不变量：等回执期限必须 > 对账链最坏回执时延（否则慢宿主假升级）', () => {
  const planner = stripComments(read('../../src/session-liveness.ts'))
  const reconcile = stripComments(read('../../../dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts'))
  const number = (source: string, name: string): number => {
    // 两种形态都要认：对象字面量字段（`name: 150_000`）与模块常量（`NAME = 35_000`）。
    const match = new RegExp(`${name}\\s*[:=]\\s*([0-9_]+)`).exec(source)
    assert.notEqual(match, null, `${name} 必须存在（默认值被改名会让本锁失效）`)
    return Number(match![1]!.replaceAll('_', ''))
  }
  const attempts = number(reconcile, 'DEFAULT_MAX_ATTEMPTS')
  const retryMs = number(reconcile, 'DEFAULT_RETRY_MS')
  const refreshPhase = number(reconcile, 'DEFAULT_ATTEMPT_TIMEOUT_MS')
  const verifyPhase = number(reconcile, 'DEFAULT_VERIFY_TIMEOUT_MS')
  const outcomeTimeout = number(planner, 'refreshOutcomeTimeoutMs')
  const worstCase = attempts * (refreshPhase + verifyPhase) + retryMs
  // 第二条不变量：verify 相位的预算必须 ≥ 探针自身的 AbortSignal 上限（否则相位
  // 超时会抢在探针超时之前结算——现在这会落成 unknown，但探针就永远没机会给出
  // 权威结论；探针预算在 instance-api.ts 的 DEFAULT_TIMEOUT_MS）。
  const instanceApi = stripComments(read('../../../dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts'))
  const probeBudget = number(instanceApi, 'DEFAULT_TIMEOUT_MS')
  assert.ok(verifyPhase >= probeBudget,
    `verify 相位预算 ${verifyPhase}ms 必须 >= 探针自身上限 ${probeBudget}ms`)
  // 生产构造点不得 override 这些预算（锁只读模块默认值；override 会让上面两条锁失效）。
  const producerSource = stripComments(read('../../../dsh-chamber-client-ui-sidebar/src/client/index.ts'))
  const constructionAt = producerSource.indexOf('new SessionFactReconciler(')
  const construction = producerSource.slice(constructionAt, constructionAt + 800)
  assert.ok(!/attemptTimeoutMs|verifyTimeoutMs|maxAttempts|retryMs/.test(construction),
    '生产构造点不得 override 相位/重试预算（否则与守卫的等回执期限脱钩）')
  assert.ok(outcomeTimeout > worstCase,
    `等回执期限 ${outcomeTimeout}ms 必须 > 最坏回执 ${worstCase}ms（相位预算拆开后 90s 不够）`)
  // 第三条前提：等回执期限 < L1 coalesce —— 正是"单次 unknown 必须被吸收"的存在理由
  // （期限比下一次探测还短时，一次 502 就会被判成"对账通道已坏"）。若将来翻转这组常量，
  // 吸收逻辑可以撤，但必须**有意识**地撤（本锁会红；2026-12 二轮独立复核）。
  const coalesce = number(planner, 'refreshCoalesceMs')
  assert.ok(outcomeTimeout < coalesce,
    `等回执期限 ${outcomeTimeout}ms 必须 < L1 coalesce ${coalesce}ms（否则 unknown 吸收无意义）`)
  // 第四条前提：吸收之后必须等"下一次 L1 已发出"才允许期限生效（快 unknown 同判）。
  assert.match(planner, /unknownAwaitingNextL1/, '吸收后的期限必须由"下一次 L1 已发出"门控')
})

test('文案与样式：双语字典齐备，横幅类名全部有样式', () => {
  const locales = read('../../src/locales.ts')
  for (const key of ['sessionStall.text', 'sessionStall.reconnect', 'sessionStall.reload', 'sessionStall.dismiss']) {
    const hits = locales.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 必须同时存在于 zh 与 en 字典`)
  }
  assert.equal(locales.split("'sessionStall.separator':").length - 1, 2,
    '分隔符键必须双语齐备（zh 、 / en ", "）')
  const app = read('../../src/App.tsx')
  assert.match(app, /\.join\(t\('sessionStall\.separator'\)\)/,
    '横幅必须用 locale 感知的分隔符（硬编码 、 会让英文界面串味；2026-12 三轮复核 R13）')
  const styles = stripComments(read('../../src/styles.css'))
  for (const cls of ['.session-stall-layer', '.session-stall', '.session-stall-text', '.session-stall-actions']) {
    assert.ok(styles.includes(`${cls} {`), `${cls} 必须有样式规则（verify:styles 的 S6 反向要求）`)
  }
})
