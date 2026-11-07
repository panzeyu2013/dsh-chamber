/**
 * Negative control for the upstream lifecycle-contract gate (P6): the detector must
 * flag a fabricated first-frame bound and stay quiet without one, `evaluate` must
 * name the retirement when the vendor half flips, and the documentation half must
 * locate the design 14 §D4 tripwire stanza by its machine identifier — a reworded
 * sentence is a warning, while losing the contract reference is a failure.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  FIRST_FRAME_BOUND,
  LIFECYCLE_GATE_NAME,
  clientOpenContract,
  documentedRetirement,
  evaluate,
  forkRetirementPins,
  hostFirstFrameContract,
} from './verify-upstream-lifecycle-contract.mjs'

const HOST = "async *follow(request, signal) { yield { type: 'snapshot' } }"
const CLIENT = 'private async doOpen(g) { await events.open({}) }\n  /** Apply one contiguous journal update'
const FORK = "kind: 'openingSent' ... armOpeningDeadline"
const CONTRACT = [
  '> **退役 tripwire**：`' + LIFECYCLE_GATE_NAME + '`（四方注册）钉住 pin 源的两半——宿主 `follow` 仍以 opening snapshot 开帧且无期限、',
  '> 客户端 `doOpen` 仍无界 await；客户端侧钉的是单档 30 s 开帧期限。',
  '> 上游宿主携带首帧期限后，才轮到重新评估**客户端期限本身**是否退役。',
  '> ② **页面生命周期**：其它段落里的退役经 retainSourceIds 出表。',
].join('\n')

/** File-reader seam over the fabricated sources above. */
function readSources(overrides = {}) {
  return (path) => {
    if (path.endsWith('web/controller.ts') || path.includes('history.ts')) return overrides.host ?? HOST
    if (path.includes('session.ts')) return overrides.client ?? CLIENT
    if (path.includes('stream-client.ts')) return overrides.fork ?? FORK
    return overrides.contract ?? CONTRACT
  }
}

test('the bound detector flags the shapes upstream would land', () => {
  assert.equal(FIRST_FRAME_BOUND.test('AbortSignal.timeout(30_000)'), true)
  assert.equal(FIRST_FRAME_BOUND.test('const firstFrameDeadline = now + 30_000'), true)
  assert.equal(FIRST_FRAME_BOUND.test("async *follow() { yield { type: 'snapshot' } }"), false)
})

test('the host half requires an opening snapshot and no bound', () => {
  const clean = hostFirstFrameContract(HOST)
  assert.deepEqual(clean, { hasFollow: true, hasSnapshot: true, hasBound: false })
  assert.equal(hostFirstFrameContract('const x = 1').hasFollow, false)
  assert.equal(hostFirstFrameContract("async *follow() { yield { type: 'snapshot' }; AbortSignal.timeout(1) }").hasBound, true)
})

test('the client half requires the unbounded await', () => {
  const clean = clientOpenContract(CLIENT)
  assert.equal(clean.awaitsOpen, true)
  assert.equal(clean.hasBound, false)
  assert.equal(clientOpenContract('private async doOpen(g) { await Promise.race([events.open(), AbortSignal.timeout(1)]) }').hasBound, true)
})

test('documentedRetirement locates the tripwire stanza by its machine identifier', () => {
  assert.deepEqual(documentedRetirement(CONTRACT), { registered: true, statesRetirement: true })
  // The gate reference disappeared: the design contract no longer points at its tripwire.
  assert.deepEqual(documentedRetirement('> unrelated prose about 退役'), { registered: false, statesRetirement: false })
  // A 退役 in the NEXT block must not satisfy the stanza-scoped wording check.
  const nextBlockHoldsTheWord = [
    '> **退役 tripwire**：`' + LIFECYCLE_GATE_NAME + '` 钉住两半',
    '> ② **页面生命周期**：退役经 retainSourceIds 出表',
  ].join('\n')
  assert.deepEqual(documentedRetirement(nextBlockHoldsTheWord), { registered: true, statesRetirement: false })
  assert.deepEqual(documentedRetirement(null), { registered: false, statesRetirement: false })
})

test('a stray gate mention does not register the stanza, and a title-only stanza warns', () => {
  // Registration needs the gate id and the tripwire label on the same line.
  const strayMentionBeforeStanza = [
    '> 别处提到 `' + LIFECYCLE_GATE_NAME + '` 一次。',
    '',
    '> **退役 tripwire**：`' + LIFECYCLE_GATE_NAME + '` 钉住 pin 源的两半——宿主 follow 仍无期限。',
    '> 上游宿主携带首帧期限后，才轮到重新评估客户端期限是否退役。',
  ].join('\n')
  assert.deepEqual(documentedRetirement(strayMentionBeforeStanza), { registered: true, statesRetirement: true })
  // A stanza that keeps only the label loses the condition: warning, not a failure.
  const titleOnly = '> **退役 tripwire**：`' + LIFECYCLE_GATE_NAME + '` 钉住 pin 源的两半。'
  assert.deepEqual(documentedRetirement(titleOnly), { registered: true, statesRetirement: false })
  // The stanza disappearing while a stray mention survives is a failure.
  const stanzaGone = '> 别处提到 `' + LIFECYCLE_GATE_NAME + '` 一次。\n> ① 其它内容。'
  assert.deepEqual(documentedRetirement(stanzaGone), { registered: false, statesRetirement: false })
})

test('evaluate passes a clean contract and names the retirement when the vendor half lands a bound', () => {
  assert.deepEqual(evaluate(readSources()), { failures: [], warnings: [] })
  const flips = evaluate(readSources({ host: "async *follow() { yield { type: 'snapshot' }; AbortSignal.timeout(1) }" }))
  assert.equal(flips.failures.length, 1)
  assert.match(flips.failures[0] ?? '', /UPSTREAM LANDED A FIRST-FRAME BOUND/u)
  assert.deepEqual(flips.warnings, [])
})

test('a lost contract reference fails, a reworded retirement sentence only warns', () => {
  const lost = evaluate(readSources({ contract: '> prose without the gate identifier' }))
  assert.equal(lost.failures.length, 1)
  assert.match(lost.failures[0] ?? '', /no longer registers verify:upstream-lifecycle-contract/u)
  assert.deepEqual(lost.warnings, [])
  const reworded = evaluate(readSources({
    contract: ['> **退役 tripwire**：`' + LIFECYCLE_GATE_NAME + '` 钉住两半', '> 上游若改变契约，按此门复核'].join('\n'),
  }))
  assert.deepEqual(reworded.failures, [])
  assert.equal(reworded.warnings.length, 1)
  assert.match(reworded.warnings[0] ?? '', /no longer states the retirement condition/u)
})

test('an unreadable documentation home fails without a stack trace', () => {
  const read = (path) => {
    if (path.endsWith('14-sleep-background.md')) throw new Error('ENOENT: simulated')
    return readSources()(path)
  }
  const verdict = evaluate(read)
  assert.equal(verdict.failures.length, 1)
  assert.match(verdict.failures[0] ?? '', /no longer registers/u)
})

test('the fork half pins the arming', () => {
  assert.deepEqual(forkRetirementPins(FORK), { armsDeadline: true })
  assert.equal(forkRetirementPins('nothing').armsDeadline, false)
})
