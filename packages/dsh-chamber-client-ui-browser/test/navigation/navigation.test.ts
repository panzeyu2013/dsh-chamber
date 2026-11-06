/**
 * Upstream BrowserNavigation state machine (node:test dialect of
 * ui-sidebar-browser 0.2.2-rc.1 tests/browser-navigation.client.spec.ts).
 *
 * The fork keeps the upstream bounded application-known history: first frame
 * load after a controlled request is `known`, a second one turns `unknown`
 * (cross-origin navigation unreadable), and Back/Forward are disabled while the
 * address is unknown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserNavigation, MAX_BROWSER_HISTORY } from '../../src/client/browser/BrowserNavigation.ts'
import type { BrowserTarget } from '../../src/client/browser/url.ts'

function httpsTarget(index: number): BrowserTarget {
  return { kind: 'https', url: 'https://example.test/' + String(index), title: 'page ' + String(index) }
}

test('owns bounded history, branch replacement and reload revisions', () => {
  const navigation = new BrowserNavigation()
  assert.equal(BrowserNavigation.current(navigation.snapshot), undefined)
  assert.equal(navigation.back(), undefined)
  assert.equal(navigation.forward(), undefined)
  assert.equal(navigation.reload(), undefined)

  for (let index = 0; index <= MAX_BROWSER_HISTORY; index += 1) navigation.navigate(httpsTarget(index))
  assert.equal(navigation.snapshot.entries.length, MAX_BROWSER_HISTORY)
  assert.equal(navigation.snapshot.entries[0]?.url, 'https://example.test/1')
  assert.equal(navigation.canGoBack, true)
  assert.equal(navigation.canGoForward, false)

  const back = navigation.back()
  assert.equal(back?.target.url, 'https://example.test/99')
  assert.equal(navigation.canGoForward, true)
  navigation.navigate(httpsTarget(200))
  assert.equal(navigation.snapshot.entries.at(-1)?.url, 'https://example.test/200')
  assert.equal(navigation.snapshot.entries.some((entry) => entry.url === 'https://example.test/100'), false)

  const beforeReload = navigation.snapshot.request?.revision
  navigation.reload()
  assert.equal(navigation.snapshot.request?.revision, (beforeReload ?? 0) + 1)
})

test('classifies only the first current frame load as known', () => {
  const navigation = new BrowserNavigation()
  navigation.navigate(httpsTarget(1))
  const revision = navigation.snapshot.request?.revision ?? 0
  navigation.frameLoaded(revision - 1)
  assert.deepEqual(navigation.snapshot.navigation, { status: 'loading', revision })
  navigation.frameLoaded(revision)
  assert.deepEqual(navigation.snapshot.navigation, { status: 'known', revision })
  navigation.frameLoaded(revision)
  assert.deepEqual(navigation.snapshot.navigation, { status: 'unknown', revision })
  navigation.frameLoaded(revision)
  assert.deepEqual(navigation.snapshot.navigation, { status: 'unknown', revision })
  assert.equal(navigation.back(), undefined)
  assert.equal(navigation.forward(), undefined)

  const reload = navigation.reload()
  assert.deepEqual(navigation.snapshot.navigation, { status: 'loading', revision: reload?.revision })
})

test('ignores frame observations before a controlled request', () => {
  const navigation = new BrowserNavigation()
  navigation.frameLoaded(1)
  assert.deepEqual(navigation.snapshot, BrowserNavigation.empty())
  navigation.navigate(httpsTarget(1))
  const revision = navigation.snapshot.request?.revision ?? 0
  assert.equal(navigation.snapshot.failure, undefined)
  navigation.frameLoaded(revision)
  assert.deepEqual(navigation.snapshot.navigation, { status: 'known', revision })
})

test('restoring a persisted checkpoint resumes from its selected entry', () => {
  const initial = new BrowserNavigation()
  initial.navigate(httpsTarget(1))
  initial.navigate(httpsTarget(2))
  const restored = new BrowserNavigation(initial.snapshot)
  assert.equal(BrowserNavigation.current(restored.snapshot)?.url, 'https://example.test/2')
  assert.equal(restored.canGoBack, true)
  assert.equal(restored.canGoForward, false)
})
