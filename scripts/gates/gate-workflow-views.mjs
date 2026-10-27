const NL = String.fromCharCode(10)

/**
 * gate-workflow-views.mjs — render the per-gate workflow steps from the registry.
 *
 * The step list in ci.yml/release.yml is not hand-maintained: each gate entry that
 * declares a workflow placement renders one step (an optional note as a YAML comment,
 * the title as the step name, the command as run). The block is bounded by marker
 * comments; --check proves the committed text equals the rendering (the freshness
 * control) and --write rewrites it.
 *
 * Rendering is pure: no clock, no environment, no fs at import time.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gateInvocation, loadGateRegistry } from './gate-registry.mjs'

/** Workflow surfaces the generator owns (extend when a new block is generated). */
export const WORKFLOW_VIEWS = Object.freeze([
  { file: '.github/workflows/ci.yml', marker: 'ci.test.pre', placement: 'ciJob', job: 'test', order: 'pre' },
  { file: '.github/workflows/ci.yml', marker: 'ci.test.post', placement: 'ciJob', job: 'test', order: 'post' },
  { file: '.github/workflows/release.yml', marker: 'release.validation.pre', placement: 'releaseJob', job: 'validation', order: 'pre' },
  { file: '.github/workflows/release.yml', marker: 'release.validation.post', placement: 'releaseJob', job: 'validation', order: 'post' },
])

/** YAML plain scalars the renderer refuses to guess at (quote-or-fail, never silent). */
const UNSAFE = /: |(?:^|\s)#/u

/** One step block (six-space indent) for one gate. */
export function renderGateStep(gate, indent = '      ') {
  if (gate.title.includes(String.fromCharCode(10)) || gate.command.includes(String.fromCharCode(10))) throw new Error('gate ' + gate.id + ' spans lines')
  if (UNSAFE.test(gate.title) || UNSAFE.test(gate.command)) throw new Error('gate ' + gate.id + ' needs YAML quoting; add it to the renderer')
  const out = []
  if (typeof gate.note === 'string' && gate.note !== '') out.push(indent + '# ' + gate.note)
  out.push(indent + '- name: ' + gate.title)
  out.push(indent + '  run: ' + gateInvocation(gate))
  return out
}

/** Gates rendered into one workflow surface, in registry order. */
export function gatesForView(registry, view) {
  return registry.gates.filter(gate => gate.workflow !== undefined
    && gate.workflow[view.placement] === view.job
    && (gate.workflow.order ?? 'post') === view.order)
}

/** Full marked block text (markers included) for one view. */
export function renderViewBlock(registry, view) {
  const begin = '      # GENERATED:gates:' + view.marker + ':begin'
  const end = '      # GENERATED:gates:' + view.marker + ':end'
  const body = gatesForView(registry, view).flatMap(gate => renderGateStep(gate))
  return [begin, ...body, end].join(NL)
}

/** Locate the marked block; null when a marker is missing (never silently absent). */
export function findViewBlock(text, view) {
  const begin = '      # GENERATED:gates:' + view.marker + ':begin'
  const end = '      # GENERATED:gates:' + view.marker + ':end'
  const start = text.indexOf(begin)
  const stop = text.indexOf(end)
  if (start === -1 || stop === -1 || stop < start) return null
  return { start, stop: stop + end.length }
}

/** Compare the committed block with the rendering; returns a problem text or null. */
export function checkView(registry, view, text) {
  const found = findViewBlock(text, view)
  if (found === null) return view.file + ': missing GENERATED:gates:' + view.marker + ' markers'
  const expected = renderViewBlock(registry, view)
  const actual = text.slice(found.start, found.stop)
  return actual === expected ? null : view.file + ': GENERATED:gates:' + view.marker + ' is stale (run node scripts/gates/gate-workflow-views.mjs --write)'
}

/** Rewrite every view block in place; returns the files touched. */
export function writeViews(registry) {
  const touched = []
  for (const view of WORKFLOW_VIEWS) {
    const path = new URL('../../' + view.file, import.meta.url)
    const text = readFileSync(path, 'utf8')
    const found = findViewBlock(text, view)
    if (found === null) throw new Error(view.file + ': missing GENERATED:gates:' + view.marker + ' markers')
    const next = text.slice(0, found.start) + renderViewBlock(registry, view) + text.slice(found.stop)
    if (next !== text) { writeFileSync(path, next); touched.push(view.file) }
  }
  return touched
}

/** CLI: --check (default) / --write. */
const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invokedDirectly) {
  const registry = loadGateRegistry()
  if (process.argv.includes('--write')) {
    const touched = writeViews(registry)
    console.log('gate-workflow-views: ' + (touched.length === 0 ? 'nothing (already fresh)' : touched.join(', ')))
  } else {
    const problems = []
    for (const view of WORKFLOW_VIEWS) {
      const text = readFileSync(new URL('../../' + view.file, import.meta.url), 'utf8')
      const problem = checkView(registry, view, text)
      if (problem !== null) problems.push(problem)
    }
    if (problems.length > 0) { console.error(problems.join(NL)); process.exit(1) }
    console.log('gate-workflow-views: ' + WORKFLOW_VIEWS.length + ' block(s) fresh')
  }
}
