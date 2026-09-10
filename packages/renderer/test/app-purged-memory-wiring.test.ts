import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * App-side wiring contract for the purged-row archive-set memory (design 24
 * §12 F3). `App.tsx` cannot be imported by a node test (it renders the whole
 * shell), and the 2026-09 second scan proved that a wrong ORDER in this
 * handler silently turns the remembered-baseline closure into dead code: if
 * the memory is updated BEFORE `planSessionListRefresh` reads it, the
 * remembered set always equals the incoming snapshot's own set and
 * `archiveSetShrink` can never report a shrink. This source-text contract
 * pins the order plus the two consumption sites and the lifecycle retirement,
 * mirroring the sidebar package's `producer-purged-wiring.test.ts`.
 *
 * It guards WIRING, not semantics: a green run proves the shape, not the
 * behaviour (the pure decision logic is covered by `aggregate-refresh.test.ts`).
 */
const SOURCE = readFileSync(fileURLToPath(new URL('../src/App.tsx', import.meta.url)), 'utf8')

test('App wiring: the archive-set memory is captured BEFORE it is updated', () => {
  const capture = SOURCE.indexOf('const rememberedArchiveSet = authoritativeArchiveSetRef.current[sourceId]')
  const update = SOURCE.indexOf('authoritativeArchiveSetRef.current[sourceId] = snapshot.archivedSessionIds')
  assert.notEqual(capture, -1, 'the pre-update capture must exist')
  assert.notEqual(update, -1, 'the memory update must exist')
  assert.ok(
    capture < update,
    'ORDER IS LOAD-BEARING: capture the previous authoritative set before overwriting it',
  )
})

test('App wiring: the captured baseline and the memory feed both consumers', () => {
  // The convergence machine uses the PRE-update value as the shrink baseline.
  assert.match(SOURCE, /planSessionListRefresh\(\s*watchdogAggregatesRef\.current\[sourceId\],\s*snapshot,\s*sessionListRefreshPendingRef\.current\[sourceId\],\s*rememberedArchiveSet,\s*\)/s)
  // The degraded pull commit uses the memory as the archived-row filter.
  assert.match(SOURCE, /commitAggregatePull\(\s*current,\s*snapshot,\s*snapshotSourcesRef\.current\[instanceId\] === true,\s*authoritativeArchiveSetRef\.current\[instanceId\],\s*\)/s)
})

test('App wiring: the memory is reaped with the source lifecycle', () => {
  assert.match(SOURCE, /for \(const id of Object\.keys\(authoritativeArchiveSetRef\.current\)\) \{\s*if \(!servers\.some\(server => server\.id === id\)\) \{\s*delete authoritativeArchiveSetRef\.current\[id\]/s)
})
