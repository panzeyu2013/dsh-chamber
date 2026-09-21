/**
 * Document theme projector + source theme cache tests (plain node:test, no DOM):
 * the N-ctx rule that only the ACTIVE view's instance may write the shared
 * document's theme state, that an inactive view's teardown never retracts it,
 * and that an unpublished active source fails open to the vendor's
 * unconditional behavior; plus the page-wide per-source palette cache
 * (cold-boot priming, mounted/provisional guards, per-activation de-dup; design
 * 06 §4.6, W3 切源体验). The environment is injected exactly as the production
 * wiring injects chamberBridge + the vendor ThemePresenter (see
 * document-theme.ts / theme-cache.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDocumentThemeProjector, type DocumentThemeEnvironment } from '../src/client/document-theme.ts'
import { createSourceThemeCache, decidePrime } from '../src/client/theme-cache.ts'

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
// ---- source theme cache + cold-boot priming (merged from document-theme-cache.test.ts) ----

test('the pure priming decision covers self, mounted, cached, fallback and de-dup', () => {
  const base = { active: 'ssh' as string | undefined, self: 'local', hasCached: false, activeMounted: false, primedFor: undefined as string | undefined, hasFallback: false }
  assert.equal(decidePrime({ ...base, active: undefined }), 'self')
  assert.equal(decidePrime({ ...base, active: 'local' }), 'self')
  assert.equal(decidePrime(base), 'none', 'no cache and no fallback: nothing to prime with')
  assert.equal(decidePrime({ ...base, hasFallback: true }), 'fallback')
  assert.equal(decidePrime({ ...base, hasCached: true, hasFallback: true }), 'cached')
  assert.equal(decidePrime({ ...base, hasCached: true, activeMounted: true }), 'none', 'a mounted target repaints itself')
  assert.equal(decidePrime({ ...base, hasCached: true, primedFor: 'ssh' }), 'none', 'one prime per activation')
})

test('a cold switch to a previously seen source primes its last-known palette', () => {
  const cache = createSourceThemeCache()
  const env = environment('local')
  const local = createDocumentThemeProjector('local', env, { cache })
  local.project(snapshot('light'))
  assert.deepEqual(env.writes, ['light'])

  const remote = createDocumentThemeProjector('ssh', env, { cache })
  remote.project(snapshot('dark'))
  remote.dispose()
  assert.deepEqual(env.writes, ['light'], 'a hidden view never repaints the document')

  env.setActive('ssh')
  assert.deepEqual(env.writes, ['light', 'dark'], 'the cold target is primed with its own palette')
})

test('a never-seen cold target falls back to the last palette actually applied', () => {
  const cache = createSourceThemeCache()
  const env = environment('local')
  const local = createDocumentThemeProjector('local', env, { cache })
  local.project(snapshot('light'))
  env.setActive('never-seen')
  assert.deepEqual(env.writes, ['light', 'light'], 'the document never stays on an unknown palette')
})

test('a mounted target is not cross-written by hidden views', () => {
  const cache = createSourceThemeCache()
  const env = environment('local')
  const local = createDocumentThemeProjector('local', env, { cache })
  local.project(snapshot('light'))
  const remote = createDocumentThemeProjector('ssh', env, { cache })
  remote.project(snapshot('dark'))
  env.setActive('ssh')
  assert.deepEqual(env.writes, ['light', 'dark'], 'only the active view writes on activation')
})

test('priming is de-duplicated across hidden instances', () => {
  const cache = createSourceThemeCache()
  const env = environment('local')
  const local = createDocumentThemeProjector('local', env, { cache })
  const other = createDocumentThemeProjector('other', env, { cache })
  local.project(snapshot('light'))
  other.project(snapshot('other-palette'))
  const remote = createDocumentThemeProjector('ssh', env, { cache })
  remote.project(snapshot('dark'))
  remote.dispose()
  env.setActive('ssh')
  assert.deepEqual(env.writes, ['light', 'dark'], 'exactly one hidden instance primes the cold target')
})

test('provisional snapshots are never remembered as a source palette', () => {
  const cache = createSourceThemeCache()
  const env = environment('local')
  const local = createDocumentThemeProjector('local', env, { cache })
  local.project(snapshot('light'))
  const remote = createDocumentThemeProjector('ssh', env, { cache, isSettled: () => false })
  remote.project(snapshot('provisional'))
  remote.dispose()
  assert.equal(cache.snapshotOf('ssh'), undefined)
  env.setActive('ssh')
  assert.deepEqual(env.writes, ['light', 'light'], 'the provisional palette was not primed')
})

test('a reclaimed view keeps its palette for the next cold open', () => {
  const cache = createSourceThemeCache()
  const env = environment('local')
  // Production topology: the local view stays mounted, so exactly one live
  // listener is left to prime a reclaimed target.
  const local = createDocumentThemeProjector('local', env, { cache })
  local.project(snapshot('light'))
  const remote = createDocumentThemeProjector('ssh', env, { cache, isSettled: () => true })
  remote.project(snapshot('dark'))
  remote.dispose()
  assert.equal(cache.snapshotOf('ssh') !== undefined, true)
  assert.equal(cache.isMounted('ssh'), false)
  env.setActive('ssh')
  assert.deepEqual(env.writes, ['light', 'dark'])
})

test('omitting the cache keeps the legacy behavior (compatibility lock)', () => {
  const env = environment('local')
  const local = createDocumentThemeProjector('local', env)
  const remote = createDocumentThemeProjector('ssh', env)
  local.project(snapshot('light'))
  remote.project(snapshot('dark'))
  assert.deepEqual(env.writes, ['light'])
  env.setActive('ssh')
  assert.deepEqual(env.writes, ['light', 'dark'])
})