import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  acknowledgeRendererDelivery,
  authoritativeSourceRetirements,
  canReplayRosterIntents,
  classifyRosterGatedSource,
  deliveryMatchesCurrentSource,
  enqueueBoundedRosterIntent,
  parseAuthoritativeSourceFingerprint,
  routeDeepLinkActivation,
  SerialIntentRunner,
  SourceOwnershipRegistry,
  type SourceOwnershipToken,
  settlePendingDeepLinkActivation,
  subscribeRosterBeforeRefresh,
} from '../src/deep-link-activation.ts'

test('authoritative source proof accepts only local or 32-byte lowercase remote hex', () => {
  const proof = 'ab'.repeat(32)
  assert.equal(parseAuthoritativeSourceFingerprint('local', 'local'), 'local')
  assert.equal(parseAuthoritativeSourceFingerprint('local', proof), null)
  assert.equal(parseAuthoritativeSourceFingerprint('ssh-alpha', proof), proof)
  for (const invalid of [undefined, null, '', 'local', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) {
    assert.equal(parseAuthoritativeSourceFingerprint('ssh-alpha', invalid), null)
  }
})

test('a delivery already in the IPC pipe cannot cross remove then same-id re-add', () => {
  const owners = new SourceOwnershipRegistry()
  const sourceId = 'ssh-same'
  const oldProof = 'a'.repeat(64)
  const newProof = 'b'.repeat(64)
  owners.activate(sourceId, oldProof)
  const sentDelivery = { sourceId, sourceFingerprint: oldProof }
  assert.equal(deliveryMatchesCurrentSource(owners, sentDelivery.sourceId, sentDelivery.sourceFingerprint), true)

  owners.retire([sourceId])
  owners.activate(sourceId, newProof)
  assert.equal(
    deliveryMatchesCurrentSource(owners, sentDelivery.sourceId, sentDelivery.sourceFingerprint),
    false,
    'late old delivery must be ACKed and dropped rather than routed to the replacement',
  )
  assert.equal(deliveryMatchesCurrentSource(owners, sourceId, newProof), true)
  assert.equal(deliveryMatchesCurrentSource(owners, 'local', 'local'), false, 'inactive local fails closed')
})

test('renderer delivery ACK retries transient invoke rejection with exact coordinates', async () => {
  const calls: Array<[number, number]> = []
  const waits: number[] = []
  const acknowledged = await acknowledgeRendererDelivery(
    { deliveryId: 17, attempt: 3 },
    async (deliveryId, attempt) => {
      calls.push([deliveryId, attempt])
      if (calls.length < 3) throw new Error('transient IPC failure')
      return true
    },
    {
      maxAttempts: 3,
      retryDelayMs: 25,
      wait: async delay => { waits.push(delay) },
    },
  )
  assert.equal(acknowledged, true)
  assert.deepEqual(calls, [[17, 3], [17, 3], [17, 3]])
  assert.deepEqual(waits, [25, 25])
})

test('a stale ACK false is terminal and is not retried against a newer attempt', async () => {
  let calls = 0
  const acknowledged = await acknowledgeRendererDelivery(
    { deliveryId: 9, attempt: 1 },
    async () => { calls += 1; return false },
    { wait: async () => { throw new Error('must not wait') } },
  )
  assert.equal(acknowledged, false)
  assert.equal(calls, 1)
})

test('a stale committed replay is vetoed after event-side roster invalidation', () => {
  assert.equal(canReplayRosterIntents(true, false), false)
  assert.equal(canReplayRosterIntents(false, true), false)
  assert.equal(canReplayRosterIntents(true, true), true)
})

test('remote cold-start activation is held and replayed after the authoritative roster arrives', () => {
  const beforeRoster = routeDeepLinkActivation('ssh-alpha', false, new Set(['local']), null)
  assert.deepEqual(beforeRoster, {
    pendingSourceId: 'ssh-alpha',
    activateSourceId: null,
    discarded: null,
  })
  assert.deepEqual(
    settlePendingDeepLinkActivation(beforeRoster.pendingSourceId, new Set(['local', 'ssh-alpha'])),
    { pendingSourceId: null, activateSourceId: 'ssh-alpha', discarded: null },
  )
})

test('a failed roster refresh keeps the remote activation held for a later retry', () => {
  const first = routeDeepLinkActivation('ssh-alpha', false, new Set(['local']), null)
  // A refresh rejection does not call settlePendingDeepLinkActivation and does
  // not change rosterSettled; receiving the same replay remains a bounded
  // single slot rather than growing a queue.
  const retryWindow = routeDeepLinkActivation('ssh-alpha', false, new Set(['local']), first.pendingSourceId)
  assert.deepEqual(retryWindow, first)
  assert.deepEqual(
    settlePendingDeepLinkActivation(retryWindow.pendingSourceId, new Set(['local', 'ssh-alpha'])),
    { pendingSourceId: null, activateSourceId: 'ssh-alpha', discarded: null },
  )
})

test('an authoritative roster without the target drops a removed remote instead of mounting a zombie', () => {
  assert.deepEqual(
    settlePendingDeepLinkActivation('ssh-removed', new Set(['local', 'ssh-other'])),
    {
      pendingSourceId: null,
      activateSourceId: null,
      discarded: { sourceId: 'ssh-removed', reason: 'missing' },
    },
  )
})

test('local activation never waits for the SSH roster and supersedes an older held remote', () => {
  assert.deepEqual(
    routeDeepLinkActivation('local', false, new Set(['local']), 'ssh-alpha'),
    {
      pendingSourceId: null,
      activateSourceId: 'local',
      discarded: { sourceId: 'ssh-alpha', reason: 'superseded' },
    },
  )
})

test('the pending slot is bounded and last-intent-wins while the roster is unsettled', () => {
  const first = routeDeepLinkActivation('ssh-alpha', false, new Set(['local']), null)
  const second = routeDeepLinkActivation('ssh-beta', false, new Set(['local']), first.pendingSourceId)
  assert.deepEqual(second, {
    pendingSourceId: 'ssh-beta',
    activateSourceId: null,
    discarded: { sourceId: 'ssh-alpha', reason: 'superseded' },
  })
})

test('after roster settlement a live remote activates immediately and a missing one is refused', () => {
  const live = new Set(['local', 'ssh-alpha'])
  assert.deepEqual(
    routeDeepLinkActivation('ssh-alpha', true, live, null),
    { pendingSourceId: null, activateSourceId: 'ssh-alpha', discarded: null },
  )
  assert.deepEqual(
    routeDeepLinkActivation('ssh-removed', true, live, null),
    {
      pendingSourceId: null,
      activateSourceId: null,
      discarded: { sourceId: 'ssh-removed', reason: 'missing' },
    },
  )
})

test('notification roster gate holds remote payloads, keeps local immediate, and rejects removed sources', () => {
  const coldLive = new Set(['local'])
  assert.equal(classifyRosterGatedSource('ssh-alpha', false, coldLive), 'hold')
  assert.equal(classifyRosterGatedSource('local', false, coldLive), 'activate')
  const settledLive = new Set(['local', 'ssh-alpha'])
  assert.equal(classifyRosterGatedSource('ssh-alpha', true, settledLive), 'activate')
  assert.equal(classifyRosterGatedSource('ssh-removed', true, settledLive), 'missing')
})

test('payload-bearing notification pending FIFO is bounded and preserves session ids', () => {
  const one = { sourceId: 'ssh-alpha', sessionId: 'session-1' }
  const two = { sourceId: 'ssh-beta', sessionId: 'session-2' }
  const three = { sourceId: 'ssh-gamma', sessionId: 'session-3' }
  let pending: typeof one[] = []
  let result = enqueueBoundedRosterIntent(pending, one, 2)
  assert.equal(result.dropped, null)
  pending = result.pending
  result = enqueueBoundedRosterIntent(pending, two, 2)
  assert.equal(result.dropped, null)
  pending = result.pending
  result = enqueueBoundedRosterIntent(pending, three, 2)
  assert.deepEqual(result.dropped, one)
  assert.deepEqual(result.pending, [two, three])
  assert.throws(() => enqueueBoundedRosterIntent([], one, 0), /limit must be positive/)
})

test('notification opens stay serial across delayed completion and one failure does not poison the tail', async () => {
  const runner = new SerialIntentRunner<string>()
  const started: string[] = []
  const opened: string[] = []
  const errors: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const run = async (intent: string): Promise<void> => {
    started.push(intent)
    if (intent === 'A') await firstGate
    if (intent === 'failed') throw new Error('expected failure')
    opened.push(intent)
  }
  const report = (error: unknown, intent: string): void => {
    errors.push(`${intent}:${error instanceof Error ? error.message : String(error)}`)
  }

  const first = runner.enqueue('A', run, report)
  const second = runner.enqueue('B', run, report)
  await Promise.resolve()
  assert.deepEqual(started, ['A'])
  assert.deepEqual(opened, [])

  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(started, ['A', 'B'])
  assert.deepEqual(opened, ['A', 'B'])

  await Promise.all([
    runner.enqueue('failed', run, report),
    runner.enqueue('C', run, report),
  ])
  assert.deepEqual(errors, ['failed:expected failure'])
  assert.deepEqual(opened, ['A', 'B', 'C'])
})

test('notification serial backlog cannot cross a remove then same-id re-add incarnation', async () => {
  type Open = { label: string; sourceId: string; token: SourceOwnershipToken | null }
  const runner = new SerialIntentRunner<Open>()
  const owners = new SourceOwnershipRegistry(['local'])
  owners.activate('ssh-readd', 'a'.repeat(64))
  const opened: string[] = []
  const errors: string[] = []
  const acknowledged: string[] = []
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const run = async (open: Open): Promise<void> => {
    if (open.label === 'A') await firstGate
    if (!owners.owns(open.token)) {
      throw new Error(`retired source generation: ${open.sourceId}`)
    }
    opened.push(open.label)
  }
  const report = (error: unknown, open: Open): void => {
    errors.push(`${open.label}:${error instanceof Error ? error.message : String(error)}`)
  }
  const sourceId = 'ssh-readd'
  const oldToken = owners.capture(sourceId)
  const first = runner.enqueue({ label: 'A', sourceId: 'local', token: owners.capture('local') }, run, report)
  const second = runner.enqueue({ label: 'B', sourceId, token: oldToken }, run, report)
  void second.then(() => { acknowledged.push('B') })
  await Promise.resolve()

  owners.retire([sourceId])
  const replacementToken = owners.activate(sourceId, 'b'.repeat(64))
  assert.notEqual(replacementToken, oldToken)
  assert.equal(owners.owns(oldToken), false)
  releaseFirst()
  await Promise.all([first, second])

  assert.deepEqual(opened, ['A'])
  assert.deepEqual(errors, ['B:retired source generation: ssh-readd'])
  assert.deepEqual(acknowledged, ['B'], 'a loud-dropped delivery still settles and is ACKed')
})

test('source ownership is active-only across unique churn and never reuses a same-id token', () => {
  const owners = new SourceOwnershipRegistry(['local'])
  for (let index = 0; index < 10_000; index += 1) {
    const sourceId = `ssh-churn-${index}`
    const token = owners.activate(sourceId)
    assert.equal(owners.owns(token), true)
    owners.retire([sourceId])
    assert.equal(owners.owns(token), false)
  }
  assert.equal(owners.size, 1, 'only the active local source remains; historical ids leave no tombstones')

  const first = owners.activate('ssh-same')
  owners.retire(['ssh-same'])
  const second = owners.activate('ssh-same')
  assert.notEqual(second, first)
  assert.ok(second.serial > first.serial)
  assert.equal(owners.owns(first), false)
  assert.equal(owners.owns(second), true)
})

test('authoritative snapshot retires a same-id fingerprint mismatch before replacement activation', () => {
  const owners = new SourceOwnershipRegistry()
  const oldFingerprint = 'a'.repeat(64)
  const newFingerprint = 'b'.repeat(64)
  const stableFingerprint = 'c'.repeat(64)
  const oldOwner = owners.activate('ssh-edit', oldFingerprint)
  owners.activate('ssh-stable', stableFingerprint)
  const retired = authoritativeSourceRetirements(
    new Set(['local', 'ssh-edit', 'ssh-stable', 'ssh-removed']),
    owners,
    [
      { sourceId: 'local', fingerprint: 'local' },
      { sourceId: 'ssh-edit', fingerprint: newFingerprint },
      { sourceId: 'ssh-stable', fingerprint: stableFingerprint },
      { sourceId: 'ssh-initial', fingerprint: 'd'.repeat(64) },
    ],
  )
  assert.deepEqual([...retired].sort(), ['ssh-edit', 'ssh-removed'])

  owners.retire(retired)
  const replacement = owners.activate('ssh-edit', newFingerprint)
  assert.equal(owners.owns(oldOwner), false)
  assert.notEqual(replacement, oldOwner)
})

test('authoritative roster installs its change listener before the initial refresh', () => {
  const events: string[] = []
  let onChanged: (() => void) | undefined
  let unsubscribed = false
  const unsubscribe = subscribeRosterBeforeRefresh(
    listener => {
      events.push('subscribe')
      onChanged = listener
      return () => { unsubscribed = true }
    },
    () => { events.push('refresh') },
  )

  assert.deepEqual(events, ['subscribe', 'refresh'])
  onChanged?.()
  assert.deepEqual(events, ['subscribe', 'refresh', 'refresh'])
  unsubscribe()
  assert.equal(unsubscribed, true)
})

test('App wires bounded listener-before-ready retry for deep-link and notifications', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(source, /setTimeout\(signalNotificationReady, LISTENER_READY_RETRY_MS\)/)
  assert.match(source, /setTimeout\(signalReady, LISTENER_READY_RETRY_MS\)/)
  assert.match(source, /subscribeRosterBeforeRefresh/)
  assert.match(source, /enqueueNotificationOpen\(open, 'live'\)/)
  assert.match(source, /enqueueNotificationOpen\(open, 'held'\)/)
  assert.match(source, /acknowledgeDeepLink\(current\)/)
  assert.match(source, /acknowledgeNotificationOpen\(delivery\)/)
  assert.match(source, /deliveryMatchesCurrentSource\(/)
  assert.match(source, /ignored stale deep-link source proof/)
  assert.match(source, /ignored stale source proof/)
  assert.match(source, /notifications\] readiness handshake exhausted its retry budget/)
  assert.match(source, /deep-link readiness handshake exhausted its retry budget/)
  assert.doesNotMatch(source, /notifications\?\.ready\?\.\(\)\.catch\(\(\) => \{\}\)/)
  const deepLinkListener = source.slice(
    source.indexOf('const unsubscribe = deepLink.onIntent'),
    source.indexOf('// Listener-before-ready is the ordering contract'),
  )
  assert.ok(
    deepLinkListener.indexOf('ignored stale deep-link source proof before routing')
      < deepLinkListener.indexOf('const previous = pendingDeepLinkDeliveryRef.current'),
    'a stale delivery must be ACKed before it can supersede the valid held slot',
  )
  const refreshRemotes = source.slice(
    source.indexOf('const refreshRemotes = useCallback'),
    source.indexOf('const aggregatePollRunningRef'),
  )
  assert.match(refreshRemotes, /authoritativeSourceRetirements\(/)
  assert.match(refreshRemotes, /parseAuthoritativeSourceFingerprint\(sourceId, instance\.sourceFingerprint\)/)
  assert.match(refreshRemotes, /if \(fingerprint === null\)/)
  assert.ok(
    refreshRemotes.indexOf('retireSources(retired)')
      < refreshRemotes.indexOf("sourceLifecyclesRef.current!.activate(LOCAL_INSTANCE_ID, 'local')"),
    'snapshot fingerprint retirement must happen before replacement activation',
  )
})
