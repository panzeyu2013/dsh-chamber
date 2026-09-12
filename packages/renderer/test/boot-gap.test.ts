/**
 * Settled-boot gap presentation + retryability verdicts (2026-12, design 05 §4
 * 「降级呈现」).
 *
 * What is pinned here, and why each link is silent when it goes missing:
 *
 *  - every kind has a copy key and a retry verdict (the `Record` type already
 *    makes a missing entry a compile error; this test reads the table so a
 *    re-badged kind cannot quietly reuse another kind's sentence);
 *  - the fact's IDENTITY is kind + payload — a kind-only identity is what let
 *    the second of two same-kind producers be dropped (2026-12 review);
 *  - the frame is allowed to promise an automatic re-mount ONLY when the source
 *    is `ready` and the epoch has not retried yet: `planDegradedRetries` never
 *    touches a non-ready source, so promising it there would be a lie.
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
} from '../src/boot-gap.ts'
import { en, zh } from '../src/locales.ts'

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
