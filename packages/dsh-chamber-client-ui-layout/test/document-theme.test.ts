/**
 * Document theme projector unit tests (plain node:test, no DOM): the N-ctx
 * rule that only the ACTIVE view's instance may write the shared document's
 * theme state, that an inactive view's teardown never retracts it, and that an
 * unpublished active source fails open to the vendor's unconditional behavior.
 * The environment is injected exactly as the production wiring injects
 * chamberBridge + the vendor ThemePresenter (see document-theme.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDocumentThemeProjector, type DocumentThemeEnvironment } from '../src/client/document-theme.ts'

/** Fake page-wide environment recording every document write. */
function environment(active?: string): DocumentThemeEnvironment & {
  writes: string[]
  setActive: (sourceId: string | undefined) => void
  listeners: number
} {
  const writes: string[] = []
  const listeners = new Set<(sourceId: string | undefined) => void>()
  let current = active
  return {
    writes,
    get listeners() { return listeners.size },
    getActiveSource: () => current,
    onActiveSource: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    apply: snapshot => { writes.push((snapshot as { active: { id: string } }).active.id) },
    setActive: sourceId => {
      current = sourceId
      for (const listener of [...listeners]) listener(current)
    },
  }
}

const snapshot = (id: string) => ({ active: { id } }) as never

test('only the active view writes the document', () => {
  const env = environment('local')
  const local = createDocumentThemeProjector('local', env)
  const remote = createDocumentThemeProjector('ssh-dev', env)

  local.project(snapshot('light'))
  remote.project(snapshot('dark'))
  assert.deepEqual(env.writes, ['light'], 'the hidden view must not repaint the visible one')
})

test('becoming active re-projects the remembered snapshot without a new theme/change', () => {
  const env = environment('local')
  const remote = createDocumentThemeProjector('ssh-dev', env)
  remote.project(snapshot('dark'))
  assert.deepEqual(env.writes, [])

  env.setActive('ssh-dev')
  assert.deepEqual(env.writes, ['dark'])
})

test('teardown never retracts the document, and a disposed projector stops tracking', () => {
  const env = environment('ssh-dev')
  const remote = createDocumentThemeProjector('ssh-dev', env)
  remote.project(snapshot('dark'))
  assert.deepEqual(env.writes, ['dark'])
  remote.dispose()
  assert.equal(env.listeners, 0)
  assert.deepEqual(env.writes, ['dark'], 'dispose must not write (the vendor dispose would strip the palette)')
  env.setActive('local')
  assert.deepEqual(env.writes, ['dark'], 'a disposed projector no longer reacts to activation')
})

test('an unpublished active source or a boot without a chamber instance id fails open', () => {
  const unpublished = environment(undefined)
  const remote = createDocumentThemeProjector('ssh-dev', unpublished)
  remote.project(snapshot('dark'))
  assert.deepEqual(unpublished.writes, ['dark'])

  const chamberless = environment('local')
  const anonymous = createDocumentThemeProjector(undefined, chamberless)
  anonymous.project(snapshot('system'))
  assert.deepEqual(chamberless.writes, ['system'], 'official single-shell boot keeps the vendor behavior')
})

test('the production wiring keeps one page-wide presenter and reads the instance id from the ctx', () => {
  // Source-level pin (the unit tests above cannot see the wiring): a rename of
  // `chamberInstanceId` would silently fail OPEN and restore the original
  // N-ctx defect while every unit test above stays green.
  const index = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
  assert.match(index, /\.chamberInstanceId/, 'the instance id must come from the boot-installed ctx fact')
  assert.match(index, /createDocumentThemeProjector\(/, 'the effect must build the gated projector')
  assert.match(index, /let documentThemePresenter/, 'the presenter must be one page-wide module instance')
  assert.doesNotMatch(index, /documentThemePresenter[^\n]*\.dispose\(\)/,
    'teardown must never dispose the shared presenter (it would strip the active view palette)')
  // Dropping the theme/change subscription would freeze the document on the
  // boot snapshot with every test above still green.
  assert.match(index, /ctx\.on\('theme\/change'/, 'the projector must stay subscribed to theme changes')
})
