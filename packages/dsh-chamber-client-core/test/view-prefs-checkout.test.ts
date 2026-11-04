/**
 * view-prefs checkoutOrder tests (design 08 PR2 §4/§5.1): the nested
 * `__checkout__:<sourceId>/<canonicalMainPath>` schema, canonical values, the
 * absent-field compatibility rule (v stays 1), and the nested-key prune (source
 * gone, or main row gone under an authoritative layout projection).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getViewPrefs,
  updateViewPrefs,
  type ChamberSidebarViewPrefs,
  type StorageLike,
} from '../src/view-prefs.ts'
import {
  __resetViewPrefsForTests,
  loadViewPrefs,
  saveViewPrefs,
  VIEW_PREFS_KEY,
} from '../src/view-prefs.ts'
import { chamberBridge, type ChamberServerAggregate, type ChamberServerWorkspace } from '../src/aggregate-store.ts'
import { checkoutOrderKey } from '../src/checkout-placement.ts'
import { clearWorkspaceGitFlags, markSourceGitFlagsLoaded } from '../src/workspace-git-flags.ts'

class MemoryStorage implements StorageLike {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
  peek(key: string): string | undefined { return this.map.get(key) }
}

function server(id: string, overrides: Partial<ChamberServerAggregate> = {}): ChamberServerAggregate {
  return {
    id,
    sourceFingerprint: id === 'local' ? 'local' : 'a'.repeat(64),
    kind: id === 'local' ? 'local' : 'dsh',
    transport: id === 'local' ? 'local' : 'ssh',
    label: id,
    connected: true,
    phase: 'ready',
    workspaces: [],
    updatedAt: 0,
    ...overrides,
  }
}

function workspaceRow(id: string, path: string, overrides: Partial<ChamberServerWorkspace> = {}): ChamberServerWorkspace {
  return { id, title: id, path, sessions: [], ...overrides }
}

test('checkoutOrder: absent payload keeps v1 defaults and produces NO key', () => {
  const loaded = loadViewPrefs(new MemoryStorage())
  assert.equal('checkoutOrder' in loaded, false)
  assert.equal(loaded.v, 1)
})

test('checkoutOrder: schema keeps the nested shape, canonicalizes values and drops malformed entries', () => {
  const storage = new MemoryStorage()
  const expected = { [checkoutOrderKey('local', '/repo')]: ['/repo/wt-b', '/repo/wt-a'] }
  storage.setItem(VIEW_PREFS_KEY, JSON.stringify({
    v: 1,
    checkoutOrder: {
      [checkoutOrderKey('local', '/repo/')]: ['/repo/wt-b', 7, '/repo/wt-a/', '/repo/wt-a', ''],
      'not-a-checkout-key': ['/repo/wt-c'],
      '__checkout__:': ['/repo/wt-c'],
      '__checkout__:/repo': ['/repo/wt-c'],
      [checkoutOrderKey('local', '/other')]: 'not-an-array',
    },
  }))
  assert.deepEqual(loadViewPrefs(storage).checkoutOrder, expected)
})

test('checkoutOrder: save/load round-trips canonical paths', () => {
  const storage = new MemoryStorage()
  const prefs: ChamberSidebarViewPrefs = {
    v: 1, folded: {}, ungroupedOrder: {}, orderBy: {}, groupBy: {}, archivedFilter: {},
    updatedOrder: {}, flatOrder: {}, sessionUpdatedAtByAccount: {},
    checkoutOrder: { [checkoutOrderKey('ssh-a', 'C:/repo')]: ['C:/repo/wt'] },
    seenSources: [],
  }
  saveViewPrefs(prefs, storage)
  assert.deepEqual(loadViewPrefs(storage), prefs)
})

test('checkoutOrder prune: a source that vanished from the projection loses its nested keys', () => {
  __resetViewPrefsForTests()
  chamberBridge.publish([server('local'), server('ssh-a')])
  updateViewPrefs(prev => ({
    ...prev,
    checkoutOrder: {
      [checkoutOrderKey('local', '/repo')]: ['/repo/wt'],
      [checkoutOrderKey('ssh-a', '/repo')]: ['/repo/wt'],
    },
  }))
  assert.deepEqual(Object.keys(getViewPrefs().checkoutOrder ?? {}).sort(),
    [checkoutOrderKey('local', '/repo'), checkoutOrderKey('ssh-a', '/repo')].sort())
  chamberBridge.publish([server('local')])
  updateViewPrefs(prev => ({ ...prev }))
  assert.deepEqual(getViewPrefs().checkoutOrder, { [checkoutOrderKey('local', '/repo')]: ['/repo/wt'] })
})

test('checkoutOrder prune: only an authoritative, layout-loaded projection proves the main row gone', () => {
  __resetViewPrefsForTests()
  // Not authoritative (aggregate not ready): even a missing main row keeps the order.
  chamberBridge.publish([server('local', { workspaces: [workspaceRow('m1', '/repo')] })])
  updateViewPrefs(prev => ({
    ...prev,
    checkoutOrder: { [checkoutOrderKey('local', '/gone')]: ['/gone/wt'] },
  }))
  updateViewPrefs(prev => ({ ...prev }))
  assert.deepEqual(getViewPrefs().checkoutOrder, { [checkoutOrderKey('local', '/gone')]: ['/gone/wt'] },
    'a degraded projection is not evidence of deletion')

  // Authoritative + git layouts loaded: the main row missing from the current
  // projection is a real family disappearance. Add the live main's key in the
  // SAME authoritative round so the pre-write value is observable first.
  clearWorkspaceGitFlags('local')
  markSourceGitFlagsLoaded('local')
  chamberBridge.publish([server('local', {
    aggregateReady: true,
    archiveSetKnown: true,
    workspaces: [workspaceRow('m1', '/repo')],
  })])
  updateViewPrefs(prev => ({
    ...prev,
    checkoutOrder: { ...prev.checkoutOrder, [checkoutOrderKey('local', '/repo')]: ['/repo/wt-a'] },
  }))
  assert.deepEqual(getViewPrefs().checkoutOrder, { [checkoutOrderKey('local', '/repo')]: ['/repo/wt-a'] },
    'the live main keeps its order; the vanished /gone key was pruned in the same write')
  clearWorkspaceGitFlags('local')
})

test('checkoutOrder prune: values survive partial projection rounds (orderCheckoutRows ignores unknown paths)', () => {
  __resetViewPrefsForTests()
  clearWorkspaceGitFlags('local')
  markSourceGitFlagsLoaded('local')
  const main = workspaceRow('m1', '/repo')
  const checkoutA = workspaceRow('__checkout__:/repo/wt-a', '/repo/wt-a', {
    kind: 'checkout', repoKey: 'r1', familyMainId: 'm1',
  })
  chamberBridge.publish([server('local', {
    aggregateReady: true,
    archiveSetKnown: true,
    workspaces: [main, checkoutA],
  })])
  updateViewPrefs(prev => ({
    ...prev,
    checkoutOrder: { [checkoutOrderKey('local', '/repo')]: ['/repo/wt-a/', '/repo/wt-gone'] },
  }))
  assert.deepEqual(getViewPrefs().checkoutOrder, { [checkoutOrderKey('local', '/repo')]: ['/repo/wt-a', '/repo/wt-gone'] },
    'a partial layout round is not deletion evidence; values are kept and unknown paths are ignored at render time')

  // No derived checkout row yet (layout published, App not re-derived): the
  // stored values must NOT be read as deletions.
  chamberBridge.publish([server('local', {
    aggregateReady: true,
    archiveSetKnown: true,
    workspaces: [main],
  })])
  updateViewPrefs(prev => ({
    ...prev,
    checkoutOrder: { [checkoutOrderKey('local', '/repo')]: ['/repo/wt-z'] },
  }))
  assert.deepEqual(getViewPrefs().checkoutOrder, { [checkoutOrderKey('local', '/repo')]: ['/repo/wt-z'] })
  clearWorkspaceGitFlags('local')
})
