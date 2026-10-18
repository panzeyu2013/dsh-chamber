/**
 * Graph-return policy (graph-return.ts): the per-instance replacement for the retired window
 * reload. The App feeds exactly these facts (settled shell state + source phase + the plugin
 * diagnostic slot + the two marks), so this is the production truth table, and the wiring
 * lockstep below keeps the hook from drifting away from it.
 *
 * The probe is TIME-bounded on purpose: an ssh seed flow restarts the remote dsh without
 * flapping the tunnel phase (design 18 §3.6), so an epoch-counted probe would never fire again
 * after the first ready generation — the regression this suite exists to catch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  GRAPH_RETURN_REBOOT_BACKOFF_MAX, GRAPH_RETURN_PROBE_INTERVAL_MS, GRAPH_RETURN_REBOOT_RETRY_MS,
  decideGraphReturn, planGraphReturn, rebootRetryWindowMs,
  type GraphRebootMark, type GraphReturnFacts, type GraphReturnPassFacts,
} from '../../src/graph-return.ts'
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'

/** A settled clean boot that attempted the graph and got nothing. */
const graphless = { booted: true, error: null, degraded: null, graphAnswered: false } as const
const diagnostic = (state: PluginGraphDiagnostic['state'], updatedAt = 10): PluginGraphDiagnostic => ({ state, updatedAt })

const facts = (over: Partial<GraphReturnFacts> = {}): GraphReturnFacts => ({
  shell: graphless,
  phase: 'ready',
  diagnostic: diagnostic('not-injected'),
  nowMs: 1_000_000,
  lastProbeAt: undefined,
  reboot: undefined,
  ...over,
})

test('the channel re-check is time-bounded: one probe per interval, not one per pass', () => {
  const at = facts({ lastProbeAt: 1_000_000 })
  assert.deepEqual(decideGraphReturn(at), { kind: 'none' },
    'a fresh probe mark blocks the re-render / interval pass right after it')
  assert.deepEqual(
    decideGraphReturn({ ...at, nowMs: 1_000_000 + GRAPH_RETURN_PROBE_INTERVAL_MS - 1 }),
    { kind: 'none' },
    'one millisecond short of the interval is still inside the bound',
  )
  assert.deepEqual(
    decideGraphReturn({ ...at, nowMs: 1_000_000 + GRAPH_RETURN_PROBE_INTERVAL_MS }),
    { kind: 'probe' },
    'the interval earns the next probe (the ssh restart does not flap the phase)',
  )
  assert.deepEqual(decideGraphReturn(facts()), { kind: 'probe' }, 'a never-probed source probes at once')
})

test('a recheck that ran while the host was down (graph-unreachable) keeps the policy alive', () => {
  assert.deepEqual(decideGraphReturn(facts({ diagnostic: diagnostic('graph-unreachable') })), { kind: 'probe' })
  assert.deepEqual(decideGraphReturn(facts({ phase: 'connecting' })), { kind: 'none' },
    'a source that is not ready is never probed')
  assert.deepEqual(decideGraphReturn(facts({ diagnostic: undefined })), { kind: 'none' },
    'no recorded diagnostic = nothing to heal against')
  assert.deepEqual(decideGraphReturn(facts({ diagnostic: diagnostic('restart-required') })), { kind: 'none' },
    'boot/row facts are never a re-check candidate')
})

test('an ok record re-boots at most once per retry window', () => {
  const ok = { diagnostic: diagnostic('ok', 42) }
  assert.deepEqual(decideGraphReturn(facts(ok)), { kind: 'reboot' })
  assert.deepEqual(decideGraphReturn(facts({ ...ok, reboot: { at: 1_000_000, attempts: 1 } })), { kind: 'none' },
    'inside the window a re-render cannot re-boot')
  assert.deepEqual(decideGraphReturn(facts({
    ...ok, reboot: { at: 1_000_000 - GRAPH_RETURN_REBOOT_RETRY_MS * 2, attempts: 1 },
  })), { kind: 'reboot' },
  'the retry window earns another re-boot even if the refused boot wrote no new record')
})

test('the real re-boot sequence grows the attempts (backoff is reachable)', () => {
  // The planner's own stamps drive the next pass: attempts 1 -> 2 -> 3 with the
  // window doubling each time. This is the behavior the pure window test cannot see.
  const base = {
    servers: [{ id: 'ssh-a', phase: 'ready' }],
    shells: { 'ssh-a': graphless } as GraphReturnPassFacts['shells'],
    diagnostics: { 'ssh-a': diagnostic('ok', 42) } as GraphReturnPassFacts['diagnostics'],
    probedAt: new Map<string, number>(),
  }
  let acted = new Map<string, GraphRebootMark>()
  const attempts: number[] = []
  // Due times: first attempt at t0 (window 60s applies only once a mark exists),
  // then +120s (attempt 2's window), then +240s (attempt 3's window).
  for (const nowMs of [1_000_000, 1_000_000 + 120_000, 1_000_000 + 120_000 + 240_000]) {
    const plan = planGraphReturn({ ...base, acted, nowMs })
    assert.equal(plan.reboots.length, 1, 'the source is due at the current window')
    acted = plan.acted
    attempts.push(acted.get('ssh-a')!.attempts)
  }
  assert.deepEqual(attempts, [1, 2, 3], 'consecutive re-boots increment the attempt counter')
  const tooEarly = planGraphReturn({ ...base, acted, nowMs: 1_000_000 + 120_000 + 240_000 + 60_000 })
  assert.deepEqual(tooEarly.reboots, [], 'the fourth attempt waits 480s, not the base 60s')
})

test('a sticky source backs off exponentially instead of re-mounting the shell every 60s', () => {
  // 60s, 120s, 240s, 480s, then flat at 480s.
  assert.equal(rebootRetryWindowMs(0), GRAPH_RETURN_REBOOT_RETRY_MS)
  assert.equal(rebootRetryWindowMs(1), GRAPH_RETURN_REBOOT_RETRY_MS * 2)
  assert.equal(rebootRetryWindowMs(2), GRAPH_RETURN_REBOOT_RETRY_MS * 4)
  assert.equal(rebootRetryWindowMs(3), GRAPH_RETURN_REBOOT_RETRY_MS * 8)
  assert.equal(rebootRetryWindowMs(99), GRAPH_RETURN_REBOOT_RETRY_MS * 2 ** GRAPH_RETURN_REBOOT_BACKOFF_MAX)
  const ok = { diagnostic: diagnostic('ok', 42) }
  const at = (attempts: number, ago: number): GraphRebootMark => ({ at: 1_000_000 - ago, attempts })
  // The third attempt waits 240s: one second short is blocked, the full window reboots.
  assert.deepEqual(decideGraphReturn(facts({ ...ok, reboot: at(2, GRAPH_RETURN_REBOOT_RETRY_MS * 4 - 1) })),
    { kind: 'none' })
  assert.deepEqual(decideGraphReturn(facts({ ...ok, reboot: at(2, GRAPH_RETURN_REBOOT_RETRY_MS * 4) })),
    { kind: 'reboot' })
})

test('an ok record never re-boots a source that is not ready', () => {
  const ok = { diagnostic: diagnostic('ok') }
  for (const phase of ['connecting', 'starting', 'error', 'stopped', undefined]) {
    assert.deepEqual(decideGraphReturn(facts({ ...ok, phase })), { kind: 'none' }, 'phase=' + String(phase))
  }
})

test('only an attempted-and-unanswered clean boot is in scope — the gate precedes the ok branch', () => {
  const ok = { diagnostic: diagnostic('ok', 42) }
  assert.deepEqual(decideGraphReturn(facts({ ...ok, shell: { ...graphless, graphAnswered: true } })), { kind: 'none' },
    'an answered boot armed its own subscriber')
  assert.deepEqual(decideGraphReturn(facts({ ...ok, shell: { ...graphless, graphAnswered: undefined } })), { kind: 'none' },
    'safe mode / module-system failure never attempted the graph')
  assert.deepEqual(
    decideGraphReturn(facts({ ...ok, shell: { ...graphless, degraded: { kind: 'graph-unavailable', message: 'no graph' } } })),
    { kind: 'none' },
    'a degraded boot belongs to the degraded self-heal (one owner)',
  )
  assert.deepEqual(decideGraphReturn(facts({ ...ok, shell: { ...graphless, booted: false } })), { kind: 'none' })
  assert.deepEqual(decideGraphReturn(facts({ ...ok, shell: { ...graphless, error: 'boot failed' } })), { kind: 'none' })
  assert.deepEqual(decideGraphReturn(facts({ ...ok, shell: undefined })), { kind: 'none' })
})

test('a pass probes at most the per-pass quota and rotates without starving', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const at = 1_000_000
  const base = {
    servers: ids.map(id => ({ id, phase: 'ready' })),
    shells: Object.fromEntries(ids.map(id => [id, graphless])) as GraphReturnPassFacts['shells'],
    diagnostics: Object.fromEntries(ids.map(id => [id, diagnostic('not-injected')])) as GraphReturnPassFacts['diagnostics'],
    acted: new Map<string, GraphRebootMark>(),
    nowMs: at,
  }
  let probedAt = new Map<string, number>()
  const waves: string[][] = []
  for (let index = 0; index < 4; index += 1) {
    const plan = planGraphReturn({ ...base, probedAt })
    waves.push([...plan.probes])
    probedAt = plan.probedAt
    assert.ok(plan.probes.length <= 2, 'the per-pass quota holds')
  }
  assert.deepEqual(waves[0], ['s1', 's2'], 'the head of the due set goes first')
  assert.deepEqual(waves[1], ['s3', 's4'], 'the next pass rotates to the deferred sources')
  assert.deepEqual(waves[2], ['s5'], 'the tail is reached without waiting out the interval')
  assert.deepEqual(waves[3], [], 'once every due source is stamped the pass is empty')
})

test('the quota rotates on the 60s timer cadence (no starvation without state churn)', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  let probedAt = new Map<string, number>()
  const waves: string[][] = []
  for (const nowMs of [0, 60_000, 120_000]) {
    const plan = planGraphReturn({
      servers: ids.map(id => ({ id, phase: 'ready' })),
      shells: Object.fromEntries(ids.map(id => [id, graphless])) as GraphReturnPassFacts['shells'],
      diagnostics: Object.fromEntries(ids.map(id => [id, diagnostic('not-injected')])) as GraphReturnPassFacts['diagnostics'],
      acted: new Map(),
      nowMs,
      probedAt,
    })
    probedAt = plan.probedAt
    waves.push([...plan.probes])
    assert.ok(plan.probes.length <= 2, 'the per-pass quota holds on the timer cadence too')
  }
  assert.equal(new Set(waves.flat()).size, 5, 'every due source is probed within three cadenced passes')
})

const pass = (over: Partial<GraphReturnPassFacts> = {}): GraphReturnPassFacts => ({
  servers: [{ id: 'ssh-a', phase: 'ready' }],
  shells: { 'ssh-a': graphless },
  diagnostics: { 'ssh-a': diagnostic('not-injected') },
  probedAt: new Map(),
  acted: new Map(),
  nowMs: 1_000_000,
  ...over,
})

test('the planner stamps a mark only in the branch that decides the action', () => {
  const probed = planGraphReturn(pass())
  assert.deepEqual(probed.probes, ['ssh-a'])
  assert.equal(probed.probedAt.get('ssh-a'), 1_000_000, 'the probe mark is the attempt itself')
  assert.deepEqual(probed.reboots, [])
  const again = planGraphReturn(pass({ probedAt: probed.probedAt }))
  assert.deepEqual(again.probes, [], 'the stamp is what bounds the next pass — no caller can set it early')
  const healed = planGraphReturn(pass({ diagnostics: { 'ssh-a': diagnostic('ok', 42) } }))
  assert.deepEqual(healed.reboots, [{ id: 'ssh-a' }])
  assert.deepEqual(healed.acted.get('ssh-a'), { at: 1_000_000, attempts: 1 },
    'the acted mark records WHEN and how many consecutive attempts')
})

test('a pass re-boots at most the per-pass quota', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const base = {
    servers: ids.map(id => ({ id, phase: 'ready' })),
    shells: Object.fromEntries(ids.map(id => [id, graphless])) as GraphReturnPassFacts['shells'],
    diagnostics: Object.fromEntries(ids.map(id => [id, diagnostic('ok')])) as GraphReturnPassFacts['diagnostics'],
    probedAt: new Map<string, number>(),
    acted: new Map<string, GraphRebootMark>(),
    nowMs: 1_000_000,
  }
  const first = planGraphReturn(base)
  assert.deepEqual(first.reboots.map(reboot => reboot.id), ['s1', 's2'])
  assert.equal(first.acted.size, 2)
  const second = planGraphReturn({ ...base, acted: first.acted })
  assert.deepEqual(second.reboots.map(reboot => reboot.id), ['s3', 's4'])
  const third = planGraphReturn({ ...base, acted: second.acted })
  assert.deepEqual(third.reboots.map(reboot => reboot.id), ['s5'])
})

test('reboot candidates rotate by recency so a persistent head cannot starve the tail', () => {
  const ids = ['s1', 's2', 's3', 's4', 's5']
  const nowMs = 1_000_000
  const base = {
    servers: ids.map(id => ({ id, phase: 'ready' })),
    shells: Object.fromEntries(ids.map(id => [id, graphless])) as GraphReturnPassFacts['shells'],
    diagnostics: Object.fromEntries(ids.map(id => [id, diagnostic('ok')])) as GraphReturnPassFacts['diagnostics'],
    probedAt: new Map<string, number>(),
    acted: new Map<string, GraphRebootMark>([
      ['s1', { at: nowMs - 240_000, attempts: 1 }], ['s2', { at: nowMs - 240_000, attempts: 1 }],
    ]),
    nowMs,
  }
  const first = planGraphReturn(base)
  assert.deepEqual(first.reboots.map(reboot => reboot.id), ['s3', 's4'], 'never-rebooted sources go first')
  const second = planGraphReturn({ ...base, acted: first.acted })
  assert.deepEqual(second.reboots.map(reboot => reboot.id), ['s5', 's1'], 'oldest rebooted sources rotate next')
})

test('both marks converge on retirement, including an acted entry whose probe mark is gone', () => {
  // The reachable leak: probe -> reboot (acted) -> the source leaves ready (no epoch mark any
  // more) -> retire. Pruning only over the probe keys would keep the acted entry forever.
  const planned = planGraphReturn(pass({
    servers: [],
    probedAt: new Map(),
    acted: new Map<string, GraphRebootMark>([['ssh-gone', { at: 7, attempts: 1 }]]),
  }))
  assert.equal(planned.acted.has('ssh-gone'), false, 'an acted-only source must be pruned too')
  assert.equal(planned.probedAt.has('ssh-gone'), false)
  const kept = planGraphReturn(pass({
    // The re-boot ledger only means anything while the graph answers ok; keep the
    // diagnostic ok here so the assertion is about PRUNING, not about the reset.
    diagnostics: { 'ssh-a': diagnostic('ok', 9), 'ssh-gone': diagnostic('ok', 9) },
    probedAt: new Map([['ssh-a', 5], ['ssh-gone', 5]]),
    acted: new Map<string, GraphRebootMark>([['ssh-a', { at: 9, attempts: 1 }], ['ssh-gone', { at: 7, attempts: 2 }]]),
  }))
  assert.deepEqual([...kept.probedAt.keys()], ['ssh-a'], 'live marks survive the prune')
  assert.deepEqual([...kept.acted.keys()], ['ssh-a'])
  // A re-boot's own boot writes a fresh non-ok record, so the reset must key on the
  // graph ANSWERING (shell out of scope), not on the diagnostic leaving ok —
  // otherwise the exponential window is unreachable (attempts stuck at 1).
  const stillGraphless = planGraphReturn(pass({ acted: new Map<string, GraphRebootMark>([['ssh-a', { at: 9, attempts: 3 }]]) }))
  assert.equal(stillGraphless.acted.has('ssh-a'), true, 'a still-graphless source keeps its attempt counter')
  const answered = planGraphReturn(pass({
    shells: { 'ssh-a': { ...graphless, graphAnswered: true } },
    acted: new Map<string, GraphRebootMark>([['ssh-a', { at: 9, attempts: 3 }]]),
  }))
  assert.equal(answered.acted.has('ssh-a'), false, 'an answered shell ends the episode and resets the ledger')
})

test('wiring lockstep: App delegates to the hook, the hook drives the planner and ONE sink', async () => {
  const app = stripComments(await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8'))
  assert.match(app, /useShellRetry\(\{ servers, shellStates, pluginDiagnostics, dispatchLifecycle, setRetryTokens \}\)/)
  const hook = stripComments(await readFile(new URL('../../src/app-hooks/use-shell-retry.ts', import.meta.url), 'utf8'))
  // The truth table stays in the pure module (nothing inlined in the hook).
  assert.match(hook, /planGraphReturn\(\{/)
  assert.doesNotMatch(hook, /decideGraphReturn\(/, 'the hook must not re-implement the truth table')
  // The probe goes through the shared channel recheck, on the planner's decision.
  assert.match(hook, /for \(const sourceId of plan\.probes\) void recheckPluginGraphDiagnostic\(sourceId\)/)
  // The re-boot goes through the App's ONE re-mount sink, and the sink call is the enclosing one.
  assert.match(hook, /setRetryTokens\(prev => \{/)
  assert.match(hook, /for \(const \{ id \} of plan\.reboots\) next\[id\] = \(next\[id\] \?\? 0\) \+ 1/)
  // The cadence is time-driven with the shared constant (the ssh restart does not flap the phase).
  assert.match(hook, /setInterval\(graphReturnPass, GRAPH_RETURN_PROBE_INTERVAL_MS\)/)
  // The degraded feed delegates to the pure planner that owns the dispatch sequence.
  assert.match(hook, /planDegradedSelfHeal\(\{ servers, shellStates, dispatch: dispatchLifecycle \}\)/)
  // The self-heal effect is ONE-SHOT: it must be read from the dispatch that emits it. The
  // behavioral proof lives in degraded-retry-decision.test.ts (real registry); this lock keeps
  // the two-pass shape from reappearing in the module that would silently lose the re-boot.
  const readiness = stripComments(await readFile(new URL('../../src/source-readiness.ts', import.meta.url), 'utf8'))
  // BOTH arms read the effect back: the phase arm pays the arm a settle left PENDING
  // (a settle that landed before ready used to lose the re-boot entirely), and the
  // settle arm covers a source that was already ready when the settle arrived.
  assert.match(readiness, /const effect = facts\.dispatch\(server\.id, \{ kind: 'phaseChanged', phase: server\.phase \}\)/)
  assert.match(readiness, /if \(effect\?\.e === 'degradedSelfHeal'\) retry\.push\(server\.id\)/)
  assert.match(readiness, /const effect = facts\.dispatch\(sourceId, \{\s*kind: 'bootSettled',\s*outcome: 'degraded',\s*gapKind: state\.degraded\.kind,\s*\}\)/)
  assert.match(readiness, /if \(effect\?\.e === 'degradedSelfHeal' && !retry\.includes\(sourceId\)\) retry\.push\(sourceId\)/)
  // (Only the CALL counts: the event union in the type above carries the same literal.)
  const dispatchCalls = /facts\.dispatch\(sourceId, \{\s*kind: 'bootSettled'/g
  assert.equal((readiness.match(dispatchCalls) ?? []).length, 1,
    'a second bootSettled dispatch would return no effect (the reducer marks in the same reduction) and lose the self-heal')
  // Non-vacuity: that count is what discriminates the old two-pass shape.
  const duplicated = readiness.replace("kind: 'phaseChanged'",
    "kind: 'phaseChanged', phase: 'ready' })\n  facts.dispatch(sourceId, { kind: 'bootSettled'")
  assert.equal((duplicated.match(dispatchCalls) ?? []).length, 2,
    'the lock would fail on a re-dispatch, which is exactly the regression it exists for')
})
