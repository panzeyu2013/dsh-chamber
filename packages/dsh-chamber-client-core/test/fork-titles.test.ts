/**
 * fork-titles.ts leaf suite: the upstream session-controller client's
 * `increasedForkTitle(title, taken)` skip-taken semantics (vendor
 * `packages/api/session-controller/src/client/sessions/service.ts:132-160`),
 * and the durable-title projection the funnel feeds it.
 *
 * The truth-table rows mirror the upstream client spec's increment cases
 * (`tests/sessions-service.client.spec.ts:984-1034`) plus the negative controls
 * the taken set must not over-match.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { increasedForkTitle, sessionDurableTitles } from '../src/fork-titles.ts'

test('incrementedTitle: half-width numbers increment; an unnumbered title starts at (1)', () => {
  assert.equal(increasedForkTitle('Roadmap', new Set()), 'Roadmap (1)')
  assert.equal(increasedForkTitle('Roadmap (1)', new Set()), 'Roadmap (2)')
  assert.equal(increasedForkTitle('计划 （9）', new Set()), '计划 （10）')
})

test('incrementedTitle: full-width parentheses keep their width; BigInt never loses precision', () => {
  assert.equal(increasedForkTitle('计划（9）', new Set()), '计划（10）')
  assert.equal(increasedForkTitle('x (9007199254740993)', new Set()), 'x (9007199254740994)')
})

test('skip-taken: the candidate increments past every taken number (skip-taken parity fix)', () => {
  assert.equal(increasedForkTitle('排障', new Set(['排障 (1)', '排障 (2)'])), '排障 (3)')
  // Upstream spec shape: source `Roadmap`, sibling `Roadmap (2)`.
  assert.equal(increasedForkTitle('Roadmap', new Set(['Roadmap (2)'])), 'Roadmap (1)')
  assert.equal(increasedForkTitle('Roadmap', new Set(['Roadmap (1)', 'Roadmap (2)'])), 'Roadmap (3)')
  // Dense runs skip whole blocks, not just one step.
  assert.equal(increasedForkTitle('x', new Set(['x (1)', 'x (2)', 'x (3)', 'x (4)'])), 'x (5)')
})

test('full-width and half-width candidates do not match each other (upstream semantics)', () => {
  // A half-width candidate never collides with a full-width title, and vice versa:
  // upstream increment regexes only match their own parenthesis width.
  assert.equal(increasedForkTitle('计划', new Set(['计划（1）'])), '计划 (1)')
  assert.equal(increasedForkTitle('计划（1）', new Set(['计划 (1)'])), '计划（2）')
})
test('skip-taken: only the exact candidate string counts (negative control)', () => {
  const nearMisses = new Set(['排障 (1) ', '排障(1)', '排障 (01)', '排障 (1)x'])
  assert.equal(increasedForkTitle('排障', nearMisses), '排障 (1)',
    'trailing space / missing space / zero-padding are different titles')
  assert.equal(increasedForkTitle('排障 (1)', nearMisses), '排障 (2)',
    'the incremented candidate "排障 (2)" is still free')
})

test('sessionDurableTitles: blank/absent titles never enter taken; duplicates collapse', () => {
  const rows: Array<{ sessionId?: string; title?: string }> = [
    { sessionId: 'a' },
    { title: '' },
    { title: 'One' },
    { title: 'One' },
    { title: 'Two' },
  ]
  const titles = sessionDurableTitles(rows)
  assert.deepEqual([...titles].sort(), ['One', 'Two'])
  assert.deepEqual([...sessionDurableTitles([])], [])
})
