/**
 * Graph-return policy (graph-return.ts): the per-instance replacement for the retired window
 * reload. The App feeds exactly these facts (settled shell state + source phase + the plugin
 * diagnostic slot + the two per-source marks), so this is the production truth table, and the
 * wiring lockstep below keeps App.tsx from drifting away from it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { decideGraphReturn, type GraphReturnFacts } from '../../src/graph-return.ts'
import type { PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'

/** A settled clean boot that attempted the graph and got nothing. */
const graphless = { booted: true, error: null, degraded: null, graphAnswered: false } as const
const diagnostic = (state: PluginGraphDiagnostic['state'], updatedAt = 10): PluginGraphDiagnostic => ({ state, updatedAt })

const facts = (over: Partial<GraphReturnFacts> = {}): GraphReturnFacts => ({
  shell: graphless,
  phase: 'ready',
  diagnostic: diagnostic('not-injected'),
  probedThisEpoch: false,
  actedUpdatedAt: undefined,
  ...over,
})

test('a graph-less clean boot probes once per ready epoch', () => {
  assert.deepEqual(decideGraphReturn(facts()), { kind: 'probe' })
  assert.deepEqual(decideGraphReturn(facts({ probedThisEpoch: true })), { kind: 'none' },
    'the epoch mark is the bound: one re-check, not one per render')
  assert.deepEqual(decideGraphReturn(facts({ phase: 'connecting' })), { kind: 'none' },
    'a source that is not ready is never probed')
})

test('an ok record re-boots once, and a later ok record earns a new attempt', () => {
  const ok = { diagnostic: diagnostic('ok', 42) }
  assert.deepEqual(decideGraphReturn(facts(ok)), { kind: 'reboot' })
  assert.deepEqual(decideGraphReturn(facts({ ...ok, actedUpdatedAt: 42 })), { kind: 'none' },
    'the consumed record is the bound: a re-render cannot re-boot')
  assert.deepEqual(decideGraphReturn(facts({ ...ok, actedUpdatedAt: 41 })), { kind: 'reboot' },
    'a NEW ok record (another heal after another loss) is a new attempt')
})

test('only an attempted-and-unanswered clean boot is in scope', () => {
  assert.deepEqual(decideGraphReturn(facts({ shell: { ...graphless, graphAnswered: true } })), { kind: 'none' },
    'an answered boot armed its own subscriber')
  assert.deepEqual(decideGraphReturn(facts({ shell: { ...graphless, graphAnswered: undefined } })), { kind: 'none' },
    'safe mode / module-system failure never attempted the graph')
  assert.deepEqual(decideGraphReturn(facts({ shell: { ...graphless, degraded: { kind: 'graph-unavailable', message: 'no graph' } } })), { kind: 'none' },
    'a degraded boot belongs to the degraded self-heal (one owner)')
  assert.deepEqual(decideGraphReturn(facts({ shell: { ...graphless, booted: false } })), { kind: 'none' })
  assert.deepEqual(decideGraphReturn(facts({ shell: { ...graphless, error: 'boot failed' } })), { kind: 'none' })
  assert.deepEqual(decideGraphReturn(facts({ shell: undefined })), { kind: 'none' })
})

test('a diagnostic that is neither not-injected nor ok is left alone', () => {
  assert.deepEqual(decideGraphReturn(facts({ diagnostic: undefined })), { kind: 'none' },
    'no recorded diagnostic = nothing to heal against')
  assert.deepEqual(decideGraphReturn(facts({ diagnostic: diagnostic('graph-unreachable') })), { kind: 'none' })
  assert.deepEqual(decideGraphReturn(facts({ diagnostic: diagnostic('restart-required') })), { kind: 'none' },
    'boot/row facts are never a re-check candidate')
})

test('wiring lockstep: App delegates to the hook, the hook drives policy + bounds + sink', async () => {
  // App keeps only the call site (the god-file ratchet forbids growing the container).
  const app = stripComments(await readFile(new URL('../../src/App.tsx', import.meta.url), 'utf8'))
  assert.match(app, /useShellRetry\(\{ servers, shellStates, pluginDiagnostics, dispatchLifecycle, setRetryTokens \}\)/)
  const hook = stripComments(await readFile(new URL('../../src/app-hooks/use-shell-retry.ts', import.meta.url), 'utf8'))
  // The decision comes from the pure module (no inlined second copy of the truth table).
  assert.match(hook, /decideGraphReturn\(\{/, 'the hook must call the pure decision')
  // The probe goes through the shared channel recheck, not a private fetch.
  assert.match(hook, /void recheckPluginGraphDiagnostic\(sourceId\)/)
  // Both bounds exist and are per-source.
  assert.match(hook, /graphProbedRef\.current\.(set|delete|has)\(server\.id\)/)
  assert.match(hook, /graphRebootActedRef\.current\.set\(server\.id, diagnostic\.updatedAt\)/)
  // The ready-epoch bound: leaving ready clears the probe mark.
  assert.match(hook, /if \(server\.phase !== 'ready'\) \{ graphProbedRef\.current\.delete\(server\.id\); continue \}/)
  // Both policies feed the App's ONE re-mount sink (retryTokens), never a page reload.
  assert.match(hook, /for \(const instanceId of reboots\) next\[instanceId\] = \(next\[instanceId\] \?\? 0\) \+ 1/,
    'the graph-return re-boot goes through the retry sink')
  assert.match(hook, /if \(effect\?\.e === 'degradedSelfHeal'\) retry\.push\(instanceId\)/,
    'the degraded self-heal decision still comes from the container effect')
})
