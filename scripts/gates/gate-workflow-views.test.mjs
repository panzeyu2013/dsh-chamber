/**
 * gate-workflow-views.test.mjs — the generated workflow block must equal the registry.
 *
 * The freshness check is the only thing standing between 'the registry is the source' and
 * 'someone hand-edited the block'; these controls prove it catches each failure shape.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { loadGateRegistry } from './gate-registry.mjs'
import { WORKFLOW_VIEWS, checkView, findViewBlock, gatesForView, renderGateStep, renderViewBlock } from './gate-workflow-views.mjs'

const view = WORKFLOW_VIEWS[0]
const registry = loadGateRegistry()

test('a bare script renders through pnpm run, an explicit command stays verbatim', () => {
  assert.deepEqual(renderGateStep({ id: 'x.one', title: 'One', command: 'verify:registry' }),
    ['      - name: One', '        run: pnpm run verify:registry'])
  assert.deepEqual(renderGateStep({ id: 'x.two', title: 'Two', command: 'node scripts/gates/x.mjs --flag' }),
    ['      - name: Two', '        run: node scripts/gates/x.mjs --flag'])
})

test('a note renders as a YAML comment above the step', () => {
  const lines = renderGateStep({ id: 'x.three', title: 'Three', command: 'node a.mjs', note: 'why it exists' })
  assert.equal(lines[0], '      # why it exists')
  assert.equal(lines.length, 3)
})

test('a scalar YAML would mis-parse is refused, never silently emitted', () => {
  assert.throws(() => renderGateStep({ id: 'x.four', title: 'Bad: title', command: 'node a.mjs' }), /quoting/u)
  assert.throws(() => renderGateStep({ id: 'x.five', title: 'Ok', command: 'node a.mjs # trailing' }), /quoting/u)
})

test('every generated block is a bijection with the registry gates placed on its job', () => {
  for (const view of WORKFLOW_VIEWS) {
    const committed = readFileSync(new URL('../../' + view.file, import.meta.url), 'utf8')
    const found = findViewBlock(committed, view)
    assert.ok(found !== null, view.marker + ' block must exist')
    const titles = [...committed.slice(found.start, found.stop).matchAll(/^      - name: (.+)$/gmu)].map(match => match[1])
    const expected = gatesForView(registry, view).map(gate => gate.title)
    assert.deepEqual(titles, expected, view.marker + ': every rendered step must be a registry gate on this job, in registry order')
  }
  // A gate that is not placed on a job must never leak into ANY block.
  const unplaced = registry.gates.filter(gate => gate.workflow === undefined).map(gate => gate.title)
  for (const view of WORKFLOW_VIEWS) {
    const committed = readFileSync(new URL('../../' + view.file, import.meta.url), 'utf8')
    const found = findViewBlock(committed, view)
    assert.ok(found !== null, view.marker + ' block must exist')
    const titles = [...committed.slice(found.start, found.stop).matchAll(/^      - name: (.+)$/gmu)].map(match => match[1])
    for (const title of unplaced) assert.ok(!titles.includes(title), title + ' is not placed on ' + view.marker + ' but the block carries it')
  }
})

test('every committed block is fresh against the registry', () => {
  for (const view of WORKFLOW_VIEWS) {
    const committed = readFileSync(new URL('../../' + view.file, import.meta.url), 'utf8')
    assert.equal(checkView(registry, view, committed), null, view.marker + ' is stale')
    // The rendered block must exist and carry the marker guard (a bare equality of two
    // production calls is tautological and can never fail).
    const rendered = renderViewBlock(registry, view)
    assert.ok(rendered.includes('GENERATED:gates:' + view.marker + ':begin'), view.marker + ' renders no begin marker')
    assert.ok(rendered.includes('GENERATED:gates:' + view.marker + ':end'), view.marker + ' renders no end marker')
  }
})

test('every declared workflow placement is renderable, and the view set is a golden', () => {
  const renderedIds = new Set()
  for (const view of WORKFLOW_VIEWS) for (const gate of gatesForView(registry, view)) renderedIds.add(gate.id)
  const renderedForJob = new Map()
  for (const view of WORKFLOW_VIEWS) {
    const job = view.placement + ':' + view.job
    for (const gate of gatesForView(registry, view)) {
      const set = renderedForJob.get(gate.id) ?? new Set()
      set.add(job)
      renderedForJob.set(gate.id, set)
    }
  }
  for (const gate of registry.gates) {
    if (gate.workflow === undefined) continue
    assert.ok(renderedIds.has(gate.id), gate.id + ' declares a workflow placement that no view renders (dead data)')
    // Both placements must be rendered: a gate that declares a release job but only
    // appears in the ci block is dead data on the release side.
    for (const [placement, job] of [['ciJob', gate.workflow.ciJob], ['releaseJob', gate.workflow.releaseJob]]) {
      assert.ok((renderedForJob.get(gate.id) ?? new Set()).has(placement + ':' + job),
        gate.id + ' declares job ' + job + ' but no view renders it there')
    }
  }
  assert.deepEqual(WORKFLOW_VIEWS.map(view => view.marker),
    ['ci.test.pre', 'ci.test.post', 'release.validation.pre', 'release.validation.post'],
    'the generated-block set is a contract: adding/removing a view must be a deliberate edit here')
})

test('a hand-edited block, a stale block and missing markers are all reported', () => {
  const text = renderViewBlock(registry, view)
  const edited = text.replace('run: pnpm run verify:workflows', 'run: pnpm run verify:styles')
  assert.match(checkView(registry, view, edited), /is stale/u)
  const begin = '      # GENERATED:gates:' + view.marker + ':begin'
  const withoutBlock = text.slice(0, text.indexOf(begin))
    + text.slice(text.indexOf('      # GENERATED:gates:' + view.marker + ':end') + ('      # GENERATED:gates:' + view.marker + ':end').length)
  assert.match(checkView(registry, view, withoutBlock), /missing/u)
  assert.equal(findViewBlock('no markers here', view), null)
})
