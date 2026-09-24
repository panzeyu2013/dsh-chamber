/**
 * Goal fact projection locks (design 19 §3.2.1, P1):
 * three-valued parsing of the nested `projectionValues.goal` value, the
 * producer-side last-known retention, the activation merge and the goal fields
 * of the runtime identity signature. Pure node:test, no vendor tree needed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetGoalProjectionWarningForTests,
  applyGoalActivation,
  mergeRuntimeFacts,
  parseGoalFact,
  projectRuntimeFacts,
  retainGoalFacts,
  runtimeReportSignature,
} from '../../src/shared/derive.ts'
/** One projection value as the wire carries it (nested, with updatedAt). */
const wireGoal = (over: { id?: unknown; revision?: unknown; phase?: unknown; updatedAt?: unknown } = {}) => ({
  goal: {
    id: over.id ?? 'g1',
    revision: over.revision ?? 3,
    phase: over.phase ?? 'active',
  },
  roundsStarted: 1,
  ...(over.updatedAt === undefined ? {} : { updatedAt: over.updatedAt }),
})

test('parseGoalFact is three-valued: absent/malformed = unknown, null = no goal, object = goal', () => {
  // Absent bag / absent key / undefined value: UNKNOWN, never "no goal".
  assert.equal(parseGoalFact(undefined), undefined)
  assert.equal(parseGoalFact({}), undefined)
  assert.equal(parseGoalFact({ goal: undefined }), undefined)
  // Explicit null: the projection said "no goal".
  assert.equal(parseGoalFact({ goal: null }), null)
  // The nested wire shape parses id/revision/phase + updatedAt only.
  assert.deepEqual(parseGoalFact({ goal: wireGoal({ updatedAt: 1_700 }) }), {
    goalId: 'g1', revision: 3, phase: 'active', updatedAt: 1_700,
  })
  // Other projections in the same bag are irrelevant; no objective/blockedReason is read.
  assert.deepEqual(
    parseGoalFact({ schedule: [], goal: { ...wireGoal(), objective: 'secret', blockedReason: 'secret' } }),
    { goalId: 'g1', revision: 3, phase: 'active' },
    'privacy: only id/revision/phase/updatedAt are extracted',
  )
  // All four phases are legal.
  for (const phase of ['active', 'paused', 'blocked', 'complete'] as const) {
    assert.equal(parseGoalFact({ goal: wireGoal({ phase }) })?.phase, phase)
  }
})

test('parseGoalFact: revision/updatedAt accept exactly the P2a/P2b safe-integer bounds', () => {
  // revision 的下界是 1（宿主的首个 revision），上界是安全整数。
  assert.equal(parseGoalFact({ goal: wireGoal({ revision: 1 }) })?.revision, 1)
  assert.equal(parseGoalFact({ goal: wireGoal({ revision: Number.MAX_SAFE_INTEGER }) })?.revision, Number.MAX_SAFE_INTEGER)
  // updatedAt 只要安全整数且 >= 0；不满足 = 水位不可用（丢字段，绝不因此把 goal 判成 unknown）。
  assert.deepEqual(
    parseGoalFact({ goal: wireGoal({ updatedAt: 0 }) }),
    { goalId: 'g1', revision: 3, phase: 'active', updatedAt: 0 },
  )
  assert.equal(parseGoalFact({ goal: wireGoal({ updatedAt: Number.MAX_SAFE_INTEGER }) })?.updatedAt, Number.MAX_SAFE_INTEGER)
  for (const updatedAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      parseGoalFact({ goal: wireGoal({ updatedAt }) }),
      { goalId: 'g1', revision: 3, phase: 'active' },
      'unusable watermark ' + String(updatedAt) + ' is dropped, the fact stays known',
    )
  }
})

test('parseGoalFact: malformed shapes stay unknown and warn exactly once per page lifetime', () => {
  __resetGoalProjectionWarningForTests()
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  try {
    // Value not an object / goal not an object / missing or wrong fields.
    assert.equal(parseGoalFact({ goal: 'active' }), undefined)
    assert.equal(parseGoalFact({ goal: { goal: null } }), undefined)
    assert.equal(parseGoalFact({ goal: { updatedAt: 1 } }), undefined)
    assert.equal(parseGoalFact({ goal: wireGoal({ id: '' }) }), undefined)
    assert.equal(parseGoalFact({ goal: wireGoal({ revision: '3' }) }), undefined)
    // P2a/P2b 同规：revision 是安全整数且 >= 1（负数/0/浮点/不安全整数全拒）。
    assert.equal(parseGoalFact({ goal: wireGoal({ revision: -1 }) }), undefined)
    assert.equal(parseGoalFact({ goal: wireGoal({ revision: 0 }) }), undefined)
    assert.equal(parseGoalFact({ goal: wireGoal({ revision: 1.5 }) }), undefined)
    assert.equal(parseGoalFact({ goal: wireGoal({ revision: Number.MAX_SAFE_INTEGER + 1 }) }), undefined)
    assert.equal(parseGoalFact({ goal: wireGoal({ phase: 'running' }) }), undefined)
    assert.equal(warnings.length, 1, 'one warn per page lifetime, not one per malformed row')
    // A valid value after malformed rows still parses (the warning does not poison the parser).
    assert.equal(parseGoalFact({ goal: wireGoal() })?.goalId, 'g1')
  } finally {
    console.warn = original
    __resetGoalProjectionWarningForTests()
  }
})

test('projectRuntimeFacts carries the goal fact sparsely and keeps rows without a goal key byte-compatible', () => {
  const report = projectRuntimeFacts({
    current: 's1',
    byId: {
      s1: { running: true, projectionValues: { goal: wireGoal({ updatedAt: 9 }) } },
      s2: { running: false, projectionValues: { goal: null } },
      s3: { running: false, projectionValues: {} },
      s4: { running: false },
    },
  })
  assert.deepEqual(report.sessions.s1?.goal, { goalId: 'g1', revision: 3, phase: 'active', updatedAt: 9 })
  assert.equal(report.sessions.s2?.goal, null, 'explicit null survives the projection')
  assert.equal('goal' in (report.sessions.s3 ?? {}), false, 'unknown stays SPARSE (no fabricated null)')
  assert.equal('goal' in (report.sessions.s4 ?? {}), false)
  // Rows without goal facts keep the pre-goal bytes (no extra key, no churn).
  assert.deepEqual(projectRuntimeFacts({ byId: { s: { running: false } } }).sessions.s, {
    running: false, subagentActivity: 'unknown',
  })
})

test('retainGoalFacts restores the last known fact for unknown rows and drops vanished sessions', () => {
  const first = projectRuntimeFacts({ byId: {
    s1: { running: false, projectionValues: { goal: wireGoal() } },
    s2: { running: false, projectionValues: { goal: null } },
  } })
  const map = retainGoalFacts(first, new Map())
  assert.equal(map.get('s1')?.goalId, 'g1')
  assert.equal(map.get('s2'), null)

  // A pass where the projection key is absent must NOT erase the last known fact.
  const unknownPass = projectRuntimeFacts({ byId: { s1: { running: false }, s2: { running: false } } })
  const retained = retainGoalFacts(unknownPass, map)
  assert.deepEqual(unknownPass.sessions.s1?.goal, { goalId: 'g1', revision: 3, phase: 'active' })
  assert.equal(unknownPass.sessions.s2?.goal, null)
  assert.equal(retained.get('s1')?.goalId, 'g1')

  // An explicit null ALWAYS wins over the last known object (the projection spoke).
  const cleared = projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: null } } } })
  const clearedMap = retainGoalFacts(cleared, retained)
  assert.equal(cleared.sessions.s1?.goal, null)
  assert.equal(clearedMap.get('s1'), null)

  // A session that left the report leaves the map (行消失即 drop ⇒ bounded).
  const gone = retainGoalFacts(projectRuntimeFacts({ byId: {} }), retained)
  assert.equal(gone.size, 0)

  // A fresh Map is the generation change: no previous value is restored.
  const fresh = projectRuntimeFacts({ byId: { s1: { running: false } } })
  assert.equal('goal' in (fresh.sessions.s1 ?? {}), false)
  assert.equal(retainGoalFacts(fresh, new Map()).size, 0)
})

test('applyGoalActivation merges only into known object facts and never churns identity', () => {
  const report = projectRuntimeFacts({ byId: {
    s1: { running: false, projectionValues: { goal: wireGoal() } },
    s2: { running: false, projectionValues: { goal: null } },
    s3: { running: false },
  } })
  const before = report.sessions.s1?.goal
  applyGoalActivation(report, () => undefined)
  assert.equal(report.sessions.s1?.goal, before, 'unknown activation changes nothing (no new object)')
  applyGoalActivation(report, () => 'armed')
  assert.deepEqual(report.sessions.s1?.goal, { goalId: 'g1', revision: 3, phase: 'active', activation: 'armed' })
  const armed = report.sessions.s1?.goal
  applyGoalActivation(report, () => 'armed')
  assert.equal(report.sessions.s1?.goal, armed, 'same value keeps object identity (anti-churn)')
  applyGoalActivation(report, () => 'disarmed')
  assert.deepEqual(report.sessions.s1?.goal, { goalId: 'g1', revision: 3, phase: 'active', activation: 'disarmed' })
  assert.equal(report.sessions.s2?.goal, null, 'null (no goal) never gets an activation')
  assert.equal('goal' in (report.sessions.s3 ?? {}), false)
})

test('runtimeReportSignature encodes goalId/revision/phase/activation/updatedAt on BOTH signature paths', () => {
  const base = projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal() } } } })
  // The projection path (includeRunning=false) MUST move with goal facts — the
  // sidebar suppresses its completed dot from this signature.
  assert.notEqual(
    runtimeReportSignature(base, undefined, false),
    runtimeReportSignature(projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal({ phase: 'complete' }) } } } }), undefined, false),
    'a phase flip must re-sign the projection path',
  )
  const encode = (report: Parameters<typeof runtimeReportSignature>[0]): string => runtimeReportSignature(report, undefined, false)
  // Unknown vs null vs object are three distinct values.
  const unknown = projectRuntimeFacts({ byId: { s1: { running: false } } })
  const none = projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: null } } } })
  assert.notEqual(encode(unknown), encode(none))
  assert.notEqual(encode(none), encode(base))
  // An activation-only change (a durable-state-free event) must re-sign —
  // otherwise the App identity dedupe freezes the goal at its first activation.
  const armed = projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal() } } } })
  applyGoalActivation(armed, () => 'armed')
  assert.notEqual(encode(base), encode(armed), 'an activation-only landing is content')
  const disarmed = projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal() } } } })
  applyGoalActivation(disarmed, () => 'disarmed')
  assert.notEqual(encode(armed), encode(disarmed))
  // goalId / revision / updatedAt each move the signature.
  assert.notEqual(encode(base), encode(projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal({ id: 'g2' }) } } } })))
  assert.notEqual(encode(base), encode(projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal({ revision: 4 }) } } } })))
  assert.notEqual(encode(base), encode(projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal({ updatedAt: 1 }) } } } })))
  // The running bit still obeys the includeRunning split (unchanged contract).
  const running = projectRuntimeFacts({ byId: { s1: { running: true, projectionValues: { goal: wireGoal() } } } })
  assert.equal(encode(base), encode(running), 'running stays out of the projection signature')
  assert.notEqual(runtimeReportSignature(base), runtimeReportSignature(running), 'the identity path keeps running')
})

test('mergeRuntimeFacts preserves goal facts through the App-merged projection', () => {
  const runtime = projectRuntimeFacts({ byId: { s1: { running: false, projectionValues: { goal: wireGoal() } } } })
  const merged = mergeRuntimeFacts(runtime, { s1: true })
  assert.deepEqual(merged?.sessions.s1?.goal, { goalId: 'g1', revision: 3, phase: 'active' })
  assert.equal(merged?.sessions.s1?.completed, true)
  // The stale downgrade path rebuilds the row — the goal fact must survive it.
  const stale = mergeRuntimeFacts(runtime, undefined, undefined, true)
  assert.deepEqual(stale?.sessions.s1?.goal, { goalId: 'g1', revision: 3, phase: 'active' })
  assert.equal(stale?.stale, true)
})
