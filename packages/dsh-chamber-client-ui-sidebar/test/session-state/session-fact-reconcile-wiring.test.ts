/**
 * 权威写回 seam 的接线锁（sidebar client/index.ts；design 14 §D4 tier-3）。
 *
 * 纯状态机的语义由 session-fact-reconcile.test.ts 钉住；本文件只锁**生产接线**，
 * 因为这些不变量在纯模块里看不见（下列非穷举，实际以本文件的测试为准）：
 *  1. producer 把 `correct` 接进对账链（没有它，stale 只升级、事实永不纠正）；
 *  2. 写回**只写 false** —— 源码里不得出现任何把 running 写成 true 的调用；
 *  3. 写回前有**能力守卫**（handleSessionStatus 是上游公开但非 ISessions 契约的方法面）；
 *  4. 写回后**自校验**（等一个宏任务再读 store；投影迟一拍时再等一拍）；
 *  5. 覆盖规则（未覆盖的 running 行 ⇒ unknown）、纵深防御栅栏与目标范围顺序。
 * 文本匹配前先剥注释（scripts/dev/test-support/source-text.ts），避免注释里的字符串
 * 把断言骗过（仓内既有纪律）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const plugin = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/client/index.ts', import.meta.url)), 'utf8'))
const reconcile = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/shared/session-fact-reconcile.ts', import.meta.url)), 'utf8'))

test('refresh 失败时的「权威沉默」不得回执成健康（五轮复核抓出的升级阶梯回归）', () => {
  assert.match(plugin, /uncovered: uncoveredRunningIds\(official, snapshot\.sessions\)/,
    '探针必须同时取「正面证伪集」与「未被覆盖的 running 行」')
  assert.match(plugin, /const firstVerdict = decideAfterFirstAuthorityRead\(\{/,
    '直接结论必须来自纯函数（单测钉住：refresh 失败 + 沉默 ⇒ unknown）')
  assert.match(plugin, /if \(firstVerdict !== 'needs-second-probe'\) return firstVerdict/,
    '官方 baseline 缺席 + 权威对运行行沉默 ⇒ unknown（不许 converged 关掉升级阶梯）')
})

test('相位结算后不得再有副作用：写回前必须有 attemptSettled/disposed 栅栏', () => {
  const fenceAt = reconcile.indexOf('if (this.disposed || attemptSettled) return')
  const convergedAt = reconcile.indexOf("if (verdict === 'converged') {")
  assert.ok(fenceAt >= 0,
    '被遗弃的 verify 晚到返回 stale 时回执已发布，写回不得再改官方 store（2026-12 五轮复核）')
  assert.ok(fenceAt < convergedAt, '栅栏必须排在收敛结算与写回之前，否则等于没有')
})

test('producer 把权威写回接进对账链（否则 stale 只升级、事实永不纠正）', () => {
  assert.match(plugin, /correct: writeBackDeniedRunning,/)
  assert.match(plugin, /const writeBackDeniedRunning = async \(\): Promise<boolean> => \{/)
})

test('写回只写 false：源码里不得出现任何 handleSessionStatus(…, true)', () => {
  assert.match(plugin, /service\.handleSessionStatus\(id, false\)/)
  assert.doesNotMatch(plugin, /handleSessionStatus\([^)]*true[^)]*\)/,
    '权威证伪只允许把 running 压成 false；写 true 会伪造「在跑」')
})

test('写回纪律：证伪集有新鲜度上界，且目标范围先于能力守卫判定', () => {
  assert.match(plugin, /let verifySeq = 0/,
    '证伪集必须带 verify 轮次序号（被遗弃的 verify 晚到发布的旧集要能被识别）')
  assert.match(plugin, /deniedRunning = \{ ids: confirmed, seq \}/)
  assert.match(plugin, /if \(denied\.seq !== verifySeq\) return false/,
    '纵深防御：只认当前轮 verify 发布的集（第一道栅栏是 reconciler 的 attemptSettled/disposed）')
  assert.match(plugin, /const targets = writeBackTargets\(denied\.ids, readStoreRunning\(\)\)/,
    '目标范围必须由纯函数给出（已确认证伪 ∩ 此刻仍 running），行为由单测钉住')
  assert.match(plugin, /if \(targets\.length === 0\) return true/,
    '已自然收敛 ⇒ 本轮按成功结算，绝不升级')
  assert.ok(
    plugin.indexOf('writeBackTargets(denied.ids')
      < plugin.indexOf("typeof service.handleSessionStatus !== 'function'"),
    '目标判定必须排在能力守卫之前：否则没有该方法的构建会把已收敛的轮次误判成失败',
  )
})

test('写回前有方法面能力守卫（handleSessionStatus 是公开但非契约的方法）', () => {
  assert.match(plugin, /typeof service\.handleSessionStatus !== 'function'/)
  assert.match(plugin, /warnedMissingHandleSessionStatus = true/)
})

test('写回后自校验（等一个宏任务再读 store；投影再迟一拍时重试一次）', () => {
  assert.match(plugin, /await new Promise\(resolve => \{ setTimeout\(resolve, 0\) \}\)/)
  assert.match(plugin, /if \(targets\.every\(id => after\[id\]\?\.running !== true\)\) return true/,
    '自校验必须比较写入目标集合，而不是「store 里没有 running 行」这种更宽的条件')
  assert.match(plugin, /for \(let attempt = 0; attempt < 2; attempt \+= 1\) \{/,
    '一次宏任务不够时重试一次，避免把「尚未 flush」记成失败而误升级')
})

test('tier-1.5 接线：store 无 running 行即不发探针（修复后的常见路径只花 1 次 host 读）', () => {
  assert.match(plugin, /if \(!hasReconcilableRunning\(readStoreRunning\(\)\)\) return 'converged'/,
    '无对账对象必须直接 converged（否则每个健康轮次都白付一次 host session.list）；'
    + '判定本身是纯函数（hasReconcilableRunning），行为由 session-fact-reconcile.test.ts 钉住')
})

test('N=2 确认接线：两次独立权威读的交集才是写入与升级的依据', () => {
  assert.match(plugin, /const first = await probeDeniedRunning\(\)/)
  assert.match(plugin, /const second = await probeDeniedRunning\(\)/)
  assert.match(plugin, /const confirmed = confirmDeniedRunningIds\(first\.denied, second\.denied\)/,
    '交集必须由纯函数给出（一次不完整列表不得触发写回或升级）')
  assert.match(plugin, /if \(confirmed\.size === 0\) return 'unknown'/,
    '两次读数不一致必须按 unknown 结算（不升级、不清等待）')
})
