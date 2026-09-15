/**
 * Degraded-boot facts and their self-heal planner (design 05 §4 「降级呈现」;
 * 2026-09-10 sidebarRight self-heal; 2026-12 kind-aware retry verdicts).
 *
 * MERGED FILE (2026-12 test reorganization) — two specs that pin the SAME
 * degraded-boot chain, so a retryability change can no longer update one half
 * without the other:
 *  - test/boot-gap.test.ts: every kind's copy key + retry verdict, the fact
 *    IDENTITY (kind + payload), the notice projection, and the frame's
 *    auto-retry promise;
 *  - test/degraded-retry.test.ts: planDegradedRetries — exactly one re-mount
 *    per ready epoch, never for a non-ready/retired source, and never for a
 *    kind whose cause a cold re-mount cannot touch (it reads the table above).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOT_GAP_POLICY,
  bootGapNotice,
  bootGapSignature,
  isRetryableBootGap,
  toServerBootGap,
  type ShellDegradedFact,
  type ShellDegradedKind,
} from '../../src/boot-gap.ts'
import { en, zh } from '../../src/locales.ts'
import { planDegradedRetries, type DegradedMountFact } from '../../src/degraded-retry.ts'

// --- merged from test/boot-gap.test.ts ---

const KINDS: readonly ShellDegradedKind[] = [
  'graph-unavailable',
  'required-services-missing',
  'deferred-registration-failed',
]

test('BOOT_GAP_POLICY covers every kind with its own copy key and retry verdict', () => {
  assert.deepEqual(Object.keys(BOOT_GAP_POLICY).sort(), [...KINDS].sort())
  const bodyKeys = new Set<string>()
  for (const kind of KINDS) {
    const policy = BOOT_GAP_POLICY[kind]
    assert.notEqual(policy.bodyKey.trim(), '', kind)
    assert.equal(typeof policy.retryable, 'boolean', kind)
    assert.equal(bodyKeys.has(policy.bodyKey), false, `${kind} must not reuse another kind's copy key`)
    bodyKeys.add(policy.bodyKey)
    assert.equal(isRetryableBootGap(kind), policy.retryable)
  }
})

test('every current kind is retryable: a cold re-mount refetches the graph and re-applies the rows', () => {
  for (const kind of KINDS) {
    assert.equal(BOOT_GAP_POLICY[kind].retryable, true, kind)
  }
})

test('bootGapSignature: kind AND payload make the fact (same kind, richer payload = new fact)', () => {
  const base: ShellDegradedFact = { kind: 'required-services-missing', message: 'm', services: ['sidebarRight'] }
  assert.equal(bootGapSignature(base), bootGapSignature({ ...base, message: 'a DIFFERENT diagnostic line' }))
  assert.notEqual(
    bootGapSignature(base),
    bootGapSignature({ ...base, services: ['sidebarRight', 'resources'] }),
    'a larger missing set is a different fact',
  )
  assert.notEqual(
    bootGapSignature(base),
    bootGapSignature({ ...base, kind: 'deferred-registration-failed' }),
  )
  assert.notEqual(
    bootGapSignature({ kind: 'deferred-registration-failed', message: 'm', failedIds: ['a'] }),
    bootGapSignature({ kind: 'deferred-registration-failed', message: 'm', failedIds: ['a', 'b'] }),
  )
})

test('bootGapNotice: structured fields are carried whole, absent ones default to empty', () => {
  const notice = bootGapNotice(
    {
      kind: 'required-services-missing',
      message: 'composite service(s) still unprovided after 5000ms: sidebarRight (injected by @deepseek-ai/dsh-client-ui-chat)',
      services: ['sidebarRight'],
      injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    },
    { phase: 'ready', retried: false },
  )
  assert.equal(notice.bodyKey, 'bootGap.body.requiredServicesMissing')
  assert.deepEqual(notice.services, ['sidebarRight'])
  assert.deepEqual(notice.injectedBy, ['@deepseek-ai/dsh-client-ui-chat'])
  assert.deepEqual(notice.failedIds, [])
  assert.equal(notice.retryable, true)
  // The producer's line stays the DETAIL, never the copy.
  assert.match(notice.detail, /sidebarRight/)
  const sparse = bootGapNotice({ kind: 'graph-unavailable', message: 'no graph' }, { phase: undefined, retried: false })
  assert.deepEqual(sparse.services, [])
  assert.deepEqual(sparse.injectedBy, [])
  assert.deepEqual(sparse.failedIds, [])
})

test('bootGapNotice: the auto-retry promise needs a ready source with an unspent epoch', () => {
  const fact: ShellDegradedFact = { kind: 'graph-unavailable', message: 'no graph' }
  assert.equal(bootGapNotice(fact, { phase: 'ready', retried: false }).autoRetryArmed, true)
  assert.equal(
    bootGapNotice(fact, { phase: 'ready', retried: true }).autoRetryArmed,
    false,
    'the epoch already spent its one re-mount: the copy must not promise another',
  )
  // …and the promise must respect the retry POLICY, not just the phase: a kind the
  // self-heal skips must never advertise an automatic re-mount (2026-12 review NIT;
  // all three current kinds are retryable, so this pins the invariant for the next one).
  const flipped = BOOT_GAP_POLICY['graph-unavailable'].retryable
  try {
    BOOT_GAP_POLICY['graph-unavailable'].retryable = false
    assert.equal(
      bootGapNotice(fact, { phase: 'ready', retried: false }).autoRetryArmed,
      false,
      'a non-retryable kind must not promise an automatic re-mount',
    )
  } finally {
    BOOT_GAP_POLICY['graph-unavailable'].retryable = flipped
  }
  for (const phase of ['starting', 'connecting', 'degraded', 'error', 'idle', undefined]) {
    assert.equal(
      bootGapNotice(fact, { phase, retried: false }).autoRetryArmed,
      false,
      `the self-heal never re-mounts a ${String(phase)} source — no promise there`,
    )
  }
})

test('bootGapNotice: the deferred-cluster fact names its row ids, not services', () => {
  const notice = bootGapNotice(
    {
      kind: 'deferred-registration-failed',
      message: 'deferred plugin registration failed for 1 id(s): @deepseek-ai/dsh-client-ui-tool',
      failedIds: ['@deepseek-ai/dsh-client-ui-tool'],
    },
    { phase: 'ready', retried: true },
  )
  assert.equal(notice.bodyKey, 'bootGap.body.deferredRegistrationFailed')
  assert.deepEqual(notice.failedIds, ['@deepseek-ai/dsh-client-ui-tool'])
  assert.deepEqual(notice.services, [])
  assert.equal(notice.autoRetryArmed, false)
})

test('toServerBootGap: structured facts cross the bridge, the diagnostic sentence does not', () => {
  // The sidebar row and the connections card write their own copy from these
  // fields; handing them the producer's sentence would cross the copy boundary
  // (STATUS「跨边界诊断文案」) and make each package parse it for the ids.
  const projected = toServerBootGap({
    kind: 'required-services-missing',
    message: 'composite service(s) still unprovided after 5000ms: sidebarRight (injected by …)',
    services: ['sidebarRight'],
    injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
  })
  assert.deepEqual(projected, {
    kind: 'required-services-missing',
    services: ['sidebarRight'],
    injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
    failedIds: [],
  })
  assert.equal('message' in projected, false, 'the producer diagnostic must not cross the bridge')
  // Absent payloads become EMPTY ARRAYS: a consumer never distinguishes
  // "absent" from "empty" (and the projection signature stays stable).
  assert.deepEqual(toServerBootGap({ kind: 'graph-unavailable', message: 'no graph' }), {
    kind: 'graph-unavailable',
    services: [],
    injectedBy: [],
    failedIds: [],
  })
  // The projected copy is detached: mutating it cannot reach the shell's fact.
  const fact: ShellDegradedFact = { kind: 'deferred-registration-failed', message: 'm', failedIds: ['a'] }
  const copy = toServerBootGap(fact)
  assert.notEqual(copy.failedIds, fact.failedIds)
})

test('no frame gap key carries a placeholder — the frame renders facts as elements, not interpolation', () => {
  // The frame never passes params to `t` for these keys (see App.tsx: the
  // services/injectors/ids are their own DOM lines), so a `{service}` added to a
  // body sentence would render LITERALLY on screen. The two packages that DO
  // interpolate (sidebar, connections) assert their placeholders in their own
  // tests; here the correct lock is the absence of them.
  const keys = [
    'bootGap.title', 'bootGap.detail', 'bootGap.services', 'bootGap.injectedBy', 'bootGap.failedPlugins',
    'bootGap.action.autoRetry', 'bootGap.action.manual',
    'bootGap.body.graphUnavailable', 'bootGap.body.requiredServicesMissing', 'bootGap.body.deferredRegistrationFailed',
  ] as const
  for (const [locale, dict] of [['zh', zh], ['en', en]] as const) {
    for (const key of keys) {
      assert.doesNotMatch(dict[key], /\{[a-zA-Z0-9_]+\}/, `${locale} ${key} must not carry a placeholder`)
    }
  }
})

// --- merged from test/degraded-retry.test.ts ---

/** One degraded mount of the default (retryable) kind. */
const mount = (
  instanceId: string,
  kind: ShellDegradedKind = 'required-services-missing',
): DegradedMountFact => ({ instanceId, kind })

test('planDegradedRetries: a degraded mount on a ready source is re-booted once', () => {
  const first = planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'ready', retried: {} })
  assert.deepEqual(first.retry, ['local'])
  assert.deepEqual(first.retried, { local: true })
  // Second pass with the mark carried over: no second re-boot (no loop).
  const second = planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'ready', retried: first.retried })
  assert.deepEqual(second.retry, [])
  assert.deepEqual(second.retried, { local: true })
})

test('planDegradedRetries: a source that is not ready yet is left alone and earns a later attempt', () => {
  const starting = planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'starting', retried: { local: true } })
  assert.deepEqual(starting.retry, [])
  // The stale mark is dropped while the source is down, so the ready
  // transition that follows retries again (a real restart must re-heal).
  assert.deepEqual(starting.retried, {})
  const ready = planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'ready', retried: starting.retried })
  assert.deepEqual(ready.retry, ['local'])
})

test('planDegradedRetries: a retired source (no phase) is never re-booted', () => {
  const plan = planDegradedRetries({ degraded: [mount('ssh-gone')], phaseOf: () => undefined, retried: {} })
  assert.deepEqual(plan.retry, [])
  assert.deepEqual(plan.retried, {})
})

test('planDegradedRetries: healthy mounts are ignored and the plan is stable', () => {
  const plan = planDegradedRetries({
    degraded: [mount('ssh-b'), mount('local'), mount('ssh-a')],
    phaseOf: (id) => (id === 'ssh-b' ? 'starting' : 'ready'),
    retried: {},
  })
  assert.deepEqual(plan.retry, ['local', 'ssh-a'])
  assert.deepEqual(plan.retried, { local: true, 'ssh-a': true })
})

test('planDegradedRetries: the mark survives the retry\'s own idle reset (no re-boot loop)', () => {
  // boot degrades → App re-boots (mark set) → the mount goes idle while the
  // source still serves → boot degrades AGAIN. The mark must still be there,
  // otherwise a source that answers ready but never serves its graph would be
  // re-booted forever.
  const afterRetry = planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'ready', retried: {} })
  assert.deepEqual(afterRetry.retry, ['local'])
  const idle = planDegradedRetries({ degraded: [], phaseOf: () => 'ready', retried: afterRetry.retried })
  assert.deepEqual(idle.retry, [])
  assert.deepEqual(idle.retried, { local: true }, 'the mark is kept while the source still serves')
  const degradedAgain = planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'ready', retried: idle.retried })
  assert.deepEqual(degradedAgain.retry, [], 'a second degrade inside the same ready epoch must not re-boot again')
  // …and a real restart (leaving ready) earns the next attempt.
  const left = planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'starting', retried: degradedAgain.retried })
  assert.deepEqual(left.retried, {})
  assert.deepEqual(planDegradedRetries({ degraded: [mount('local')], phaseOf: () => 'ready', retried: left.retried }).retry, ['local'])
})

test('planDegradedRetries: marks of retired sources are dropped', () => {
  const plan = planDegradedRetries({ degraded: [], phaseOf: () => undefined, retried: { gone: true } })
  assert.deepEqual(plan.retried, {})
})

test('planDegradedRetries: a kind a re-mount cannot fix never earns a re-mount', () => {
  // The verdict lives in boot-gap.ts's table, so this test flips a kind's
  // verdict instead of inventing a fourth kind the union does not have — the
  // point IS the wiring between that table and this planner. Restored in
  // `finally`: the table is module state shared by every test in this file.
  const original = BOOT_GAP_POLICY['deferred-registration-failed'].retryable
  try {
    BOOT_GAP_POLICY['deferred-registration-failed'].retryable = false
    const plan = planDegradedRetries({
      degraded: [mount('local', 'deferred-registration-failed'), mount('ssh-a', 'graph-unavailable')],
      phaseOf: () => 'ready',
      retried: {},
    })
    assert.deepEqual(plan.retry, ['ssh-a'], 'only the retryable kind may be re-booted')
    assert.deepEqual(plan.retried, { 'ssh-a': true }, 'a skipped kind must not spend the epoch mark either')
  } finally {
    BOOT_GAP_POLICY['deferred-registration-failed'].retryable = original
  }
})
