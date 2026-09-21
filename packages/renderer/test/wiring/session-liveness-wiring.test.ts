/**
 * 运行位活性守卫的**跨模块接线锁**（design 14 §D4；2026-12 彻底修复）。
 *
 * design 14 声称这些跨模块不变量「由接线测试锁住」，但 `packages/renderer/test/wiring/`
 * 长期为空（STATUS ⑦ 登记的缺口）。本文件把它们落地，共五条——两侧默认值都直接 import
 * 生产模块，不复制数字：
 *  1. 对账链最坏回执时延 < 守卫的「等回执」期限（否则慢宿主 ⇒ 假 L2/假横幅）；
 *  2. verify 相位预算 ≥ **两次**独立 unary 探针自身的上限（N=2 确认要串行读两次）；
 *  3. 生产装配不得 override 任何对账预算（override 会让上面两条推导失效）；
 *  4. 保留视图 90s 界限的接线（判定 → 只清 running 位 → 进会话停滞横幅）；
 *  5. 「无法确认」的两条恢复路径都要「记水位 + 撤标记」（单边删除会把横幅焊死）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SESSION_LIVENESS_DEFAULTS } from '../../src/session-liveness.ts'
import { SESSION_FACT_RECONCILE_DEFAULTS } from '../../../dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts'
import { INSTANCE_UNARY_TIMEOUT_MS } from '../../../dsh-chamber-client-ui-sidebar/src/shared/instance-api.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'


test('对账链最坏回执时延必须小于守卫的等回执期限（慢宿主不得被误判）', () => {
  const d = SESSION_FACT_RECONCILE_DEFAULTS
  const worstReceiptMs = d.maxAttempts * (d.attemptTimeoutMs + d.verifyTimeoutMs) + d.retryMs
  assert.ok(
    worstReceiptMs < SESSION_LIVENESS_DEFAULTS.refreshOutcomeTimeoutMs,
    `最坏回执 ${worstReceiptMs}ms 必须 < 等回执期限 ${SESSION_LIVENESS_DEFAULTS.refreshOutcomeTimeoutMs}ms`,
  )
})

test('verify 相位预算必须 ≥ 两次独立探针自身的上限（N=2 串行读）', () => {
  assert.equal(INSTANCE_UNARY_TIMEOUT_MS, 30_000, '探针上限是预算推导的输入（单源）')
  assert.ok(
    SESSION_FACT_RECONCILE_DEFAULTS.verifyTimeoutMs >= 2 * INSTANCE_UNARY_TIMEOUT_MS,
    'verify 预算小于两次探针之和 ⇒ 慢宿主永远判 unknown、tier-3 写回不可达（2026-12 四轮复核抓出的缺陷）',
  )
})

test('生产装配不得 override 对账预算（内联值会让上面两条推导失效）', () => {
  const plugin = stripComments(readFileSync(
    fileURLToPath(new URL('../../../dsh-chamber-client-ui-sidebar/src/client/index.ts', import.meta.url)),
    'utf8',
  ))
  assert.doesNotMatch(plugin, /attemptTimeoutMs|verifyTimeoutMs|maxAttempts|retryMs/)
})

test('保留视图有界化的接线：判定 -> 只清 running 位 -> 进「无法确认」横幅（App.tsx）', () => {
  const app = stripComments(readFileSync(
    fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8'))
  assert.match(app, /shouldDropUnverifiedRunningFacts\(\{/,
    '失败保留分支必须消费界限判定，否则视图退回无限冻结（残留 2026-12）')
  assert.match(app, /sessions: current\.sessions\.map\(session => \(/,
    '界限到点必须清掉无法验证的 running 位（只清位、保留行与分组）')
  assert.match(app, /const visibleStalls = \[\.\.\.new Set\(\[\.\.\.stalledSources, \.\.\.unverifiedSources\]\)\]/,
    '「无法确认」来源必须共用停滞横幅（文案 = 无法确认会话状态）')
})

test('来源退役清理与 dismiss 剪枝都有锁（same-id 复挂不得继承旧忽略/旧水位）', () => {
  const app = stripComments(readFileSync(
    fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8'))
  // 2026-12 阶段 3：剪枝收口到 source-registry.ts 内核（live 外删除 +
  // identity-preserving），锁随之改为内核调用面；内核语义由
  // test/lifecycle/source-registry.test.ts 行为断言承担。
  assert.match(app, /const factsAtNext = pruneSourceRecord\(factsAtRef\.current, live\)/,
    '来源退役时必须清事实水位（否则复挂后 90s 界限按旧水位判定）')
  assert.match(
    app,
    /setUnverified\(prev => pruneSourceList\(prev, live\) \?\? prev\)/,
    '「无法确认」标记随来源退役清理（唯一写入口 setUnverified）',
  )
  assert.match(
    app,
    /setDismissedStalls\(prev => pruneSourceList\(prev, live\) \?\? prev\)/,
    '忽略列表也随来源退役清理：否则同 id 新代际会被旧忽略压住（2026-12 五轮复核）',
  )
  assert.match(app, /unverifiedSourcesRef\.current = unverifiedSources/,
    '渲染期镜像必须存在（同一 tick 的 dismiss 剪枝读它）')
})

test('保留视图的两条恢复路径都「记水位 + 撤标记」（单边删除会把横幅焊死）', () => {
  const app = stripComments(readFileSync(
    fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8'))
  assert.match(
    app,
    /snapshotAtRef\.current\[sourceId\] = Date\.now\(\)[\s\S]{0,200}factsAtRef\.current\[sourceId\] = Date\.now\(\)/,
    'push 成功必须记事实水位（否则活跃推送通道会被 90s 界限误清）',
  )
  assert.match(
    app,
    /factsAtRef\.current\[sourceId\] = Date\.now\(\)[\s\S]{0,200}setUnverified\(prev => \(prev\.includes\(sourceId\)/,
    'push 成功必须撤下「无法确认」',
  )
  assert.match(
    app,
    /factsAtRef\.current\[instanceId\] = Date\.now\(\)[\s\S]{0,200}setUnverified\(prev => \(prev\.includes\(instanceId\)/,
    'unary 成功必须撤下「无法确认」',
  )
})
