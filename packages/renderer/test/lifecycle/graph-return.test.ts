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
  GRAPH_RETURN_PROBE_INTERVAL_MS, decideGraphReturn, planGraphReturn,
  type GraphReturnFacts, type GraphReturnPassFacts,
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
  actedUpdatedAt: undefined,
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

test('an ok record re-boots once, and a later ok record earns a new attempt', () => {
  const ok = { diagnostic: diagnostic('ok', 42) }
  assert.deepEqual(decideGraphReturn(facts(ok)), { kind: 'reboot' })
  assert.deepEqual(decideGraphReturn(facts({ ...ok, actedUpdatedAt: 42 })), { kind: 'none' },
    'the consumed record is the bound: a re-render cannot re-boot')
  assert.deepEqual(decideGraphReturn(facts({ ...ok, actedUpdatedAt: 41 })), { kind: 'reboot' },
    'a NEW ok record (another heal after another loss) is a new attempt')
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
  assert.deepEqual(healed.reboots, [{ id: 'ssh-a', updatedAt: 42 }])
  assert.equal(healed.acted.get('ssh-a'), 42, 'the acted mark is stamped with the consumed record')
})

test('both marks converge on retirement, including an acted entry whose probe mark is gone', () => {
  // The reachable leak: probe -> reboot (acted) -> the source leaves ready (no epoch mark any
  // more) -> retire. Pruning only over the probe keys would keep the acted entry forever.
  const planned = planGraphReturn(pass({
    servers: [],
    probedAt: new Map(),
    acted: new Map([['ssh-gone', 7]]),
  }))
  assert.equal(planned.acted.has('ssh-gone'), false, 'an acted-only source must be pruned too')
  assert.equal(planned.probedAt.has('ssh-gone'), false)
  const kept = planGraphReturn(pass({
    probedAt: new Map([['ssh-a', 5], ['ssh-gone', 5]]),
    acted: new Map([['ssh-a', 9], ['ssh-gone', 7]]),
  }))
  assert.deepEqual([...kept.probedAt.keys()], ['ssh-a'], 'live marks survive the prune')
  assert.deepEqual([...kept.acted.keys()], ['ssh-a'])
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
