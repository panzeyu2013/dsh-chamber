/**
 * Degraded-boot facts and their self-heal planner (design 05 「降级呈现」):
 *  - every kind's copy key + retry verdict, the fact
 *    IDENTITY (kind + payload), the notice projection, and the frame's
 *    auto-retry promise;
 *  - planDegradedRetries — exactly one re-mount
 *    per ready epoch, never for a non-ready/retired source, and never for a
 *    kind whose cause a cold re-mount cannot touch (it reads the table above).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BOOT_GAP_POLICY,
  bootGapPriority,
  shouldReplaceBootGap,
  bootGapClearMatchesFact,
  bootGapNotice,
  bootGapSignature,
  isRetryableBootGap,
  isShellDegradedClear,
  toServerBootGap,
  type ShellDegradedFact,
  type ShellDegradedKind,
} from '../../src/boot-gap.ts'
import { en, zh } from '../../src/locales.ts'

// --- boot-gap facts ---

const KINDS: readonly ShellDegradedKind[] = [
  'graph-unavailable',
  'local-graph-not-injected',
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

test('the local-graph-not-injected kind names the chamber-side cause, never a runtime upgrade (FIX 6)', () => {
  const policy = BOOT_GAP_POLICY['local-graph-not-injected']
  assert.equal(policy.retryable, true, 'a re-mount re-runs the graph fetch — one attempt is worth it')
  assert.equal(policy.bodyKey, 'bootGap.body.localGraphNotInjected')
  assert.notEqual(policy.bodyKey, BOOT_GAP_POLICY['graph-unavailable'].bodyKey)
  for (const [locale, dict] of [['zh', zh], ['en', en]] as const) {
    const body = dict['bootGap.body.localGraphNotInjected']
    assert.notEqual(body.trim(), '', locale)
    // The cause is chamber-side (installation/seed), so the ONLY repair path this
    // copy may point at is not a dsh runtime upgrade (read-only on Windows).
    assert.doesNotMatch(body, /升级|upgrade/i, `${locale} body must not advise a runtime upgrade`)
  }
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
  // self-heal skips must never advertise an automatic re-mount (
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

test('bootGapNotice: the manual next-step copy branches on the source kind (local vs remote, FIX 6c)', () => {
  const fact: ShellDegradedFact = { kind: 'required-services-missing', message: 'm', services: ['sidebarRight'] }
  // Remote (or unknown) sources keep the runtime-alignment advice; the local
  // instance gets the actions that actually exist there — restart the local dsh,
  // re-mount, report diagnostics. On Windows runtime management is read-only.
  assert.equal(bootGapNotice(fact, { phase: 'ready', retried: true }).manualKey, 'bootGap.action.manual')
  assert.equal(
    bootGapNotice(fact, { phase: 'ready', retried: true, instanceId: 'ssh-a' }).manualKey,
    'bootGap.action.manual',
  )
  assert.equal(
    bootGapNotice(fact, { phase: 'ready', retried: true, instanceId: 'local' }).manualKey,
    'bootGap.action.manualLocal',
  )
  for (const [locale, dict] of [['zh', zh], ['en', en]] as const) {
    assert.notEqual(dict['bootGap.action.manualLocal'].trim(), '', locale)
    assert.notEqual(
      dict['bootGap.action.manualLocal'],
      dict['bootGap.action.manual'],
      `${locale}: the local advice must not reuse the remote sentence`,
    )
  }
  assert.match(zh['bootGap.action.manualLocal'], /重启|重新挂载|诊断/)
  assert.match(en['bootGap.action.manualLocal'], /restart/i)
  assert.doesNotMatch(zh['bootGap.action.manualLocal'], /升级/, 'the local advice must not point at the read-only runtime upgrade')
  assert.doesNotMatch(en['bootGap.action.manualLocal'], /upgrade/i, 'the local advice must not point at the read-only runtime upgrade')
})

test('bootGapClearMatchesFact: a retraction clears exactly the fact it names (kind + payload, FIX 1)', () => {
  const fact: ShellDegradedFact = {
    kind: 'required-services-missing',
    message: 'm',
    services: ['sidebarRight'],
    injectedBy: ['@deepseek-ai/dsh-client-ui-chat'],
  }
  const clear = {
    cleared: true as const,
    kind: 'required-services-missing' as const,
    signature: bootGapSignature(fact),
  }
  assert.equal(isShellDegradedClear(clear), true)
  assert.equal(isShellDegradedClear(fact), false, 'a fact is not a retraction')
  assert.equal(bootGapClearMatchesFact(fact, clear), true)
  // A richer payload of the same kind is a DIFFERENT fact: an older retraction
  // must never erase the newer verdict.
  assert.equal(bootGapClearMatchesFact({ ...fact, services: ['sidebarRight', 'slots'] }, clear), false)
  // Another kind's fact is never touched by this retraction.
  assert.equal(bootGapClearMatchesFact({ kind: 'graph-unavailable', message: 'g' }, clear), false)
  // Nothing recorded → a retraction is a no-op.
  assert.equal(bootGapClearMatchesFact(null, clear), false)
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
    'bootGap.action.autoRetry', 'bootGap.action.manual', 'bootGap.action.manualLocal',
    'bootGap.body.graphUnavailable', 'bootGap.body.localGraphNotInjected',
    'bootGap.body.requiredServicesMissing', 'bootGap.body.deferredRegistrationFailed',
  ] as const
  for (const [locale, dict] of [['zh', zh], ['en', en]] as const) {
    for (const key of keys) {
      assert.doesNotMatch(dict[key], /\{[a-zA-Z0-9_]+\}/, `${locale} ${key} must not carry a placeholder`)
    }
  }
})

// ---

function factOf(kind: ShellDegradedKind, services?: readonly string[]): ShellDegradedFact {
  return { kind, message: `${kind} (test)`, ...(services === undefined ? {} : { services }) }
}

test('bootGapPriority: cause kinds strictly outrank the missing-service consequence', () => {
  assert.ok(bootGapPriority('local-graph-not-injected') > bootGapPriority('graph-unavailable'))
  assert.ok(bootGapPriority('graph-unavailable') > bootGapPriority('deferred-registration-failed'))
  assert.ok(bootGapPriority('deferred-registration-failed') > bootGapPriority('required-services-missing'))
  // The rank table is a total order over the union (no ties), so the shell's
  // "replace when >= current" rule can never flip-flop between two kinds.
  const ranks = KINDS.map(kind => bootGapPriority(kind))
  assert.equal(new Set(ranks).size, KINDS.length)
})

test('shouldReplaceBootGap: a recorded cause is not overwritten by its own symptom', () => {
  // Nothing recorded -> always replace.
  assert.equal(shouldReplaceBootGap(null, factOf('required-services-missing', ['sidebarRight'])), true)
  // Same kind -> replace (the payload may have grown).
  assert.equal(
    shouldReplaceBootGap(factOf('required-services-missing', ['sidebarRight']), factOf('required-services-missing', ['sidebarRight', 'slots'])),
    true,
  )
  // Cause recorded, consequence arrives 5s later -> keep the cause.
  assert.equal(shouldReplaceBootGap(factOf('local-graph-not-injected'), factOf('required-services-missing', ['sidebarRight'])), false)
  assert.equal(shouldReplaceBootGap(factOf('graph-unavailable'), factOf('required-services-missing', ['sidebarRight'])), false)
  assert.equal(shouldReplaceBootGap(factOf('deferred-registration-failed'), factOf('required-services-missing', ['sidebarRight'])), false)
  // Consequence recorded first, cause arrives later -> upgrade to the cause.
  assert.equal(shouldReplaceBootGap(factOf('required-services-missing', ['sidebarRight']), factOf('graph-unavailable')), true)
  assert.equal(shouldReplaceBootGap(factOf('graph-unavailable'), factOf('local-graph-not-injected')), true)
  // A lower-priority cause does not downgrade a higher-priority one either.
  assert.equal(shouldReplaceBootGap(factOf('local-graph-not-injected'), factOf('graph-unavailable')), false)
  assert.equal(shouldReplaceBootGap(factOf('graph-unavailable'), factOf('deferred-registration-failed')), false)
})

