/**
 * Remotes store contract (host/remotes-store.ts): ONE snapshot for the
 * authoritative instance list and the per-raw-id tunnel projections. Pins the
 * synchronous read (what the event callbacks used the render-time ref mirrors
 * for), the identity contract, and a source lock that those mirrors do not
 * come back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createRemotesStore } from '../../src/host/remotes-store.ts'
import type { SshInstanceSpec, SshStatusProjection } from '../../src/global.d.ts'

const spec = (id: string): SshInstanceSpec => ({
  id,
  label: id,
  kind: 'dsh',
  transport: 'ssh',
  host: '127.0.0.1',
  user: null,
  sshPort: null,
  remotePort: 22,
  serviceName: null,
  remoteDshHome: null,
  sourceFingerprint: 'fp',
  insecureHttp: false,
})

const projection = (phase: SshStatusProjection['phase']): SshStatusProjection => ({
  kind: 'dsh',
  transport: 'ssh',
  insecureHttp: false,
  phase,
  localPort: null,
  sshPort: null,
  remotePort: 22,
  remoteDshHome: null,
  retryAttempt: 0,
  requiresUserAction: false,
  userActionKind: null,
  serviceActive: null,
  logSummary: '',
})

test('a fresh store is an empty registry', () => {
  assert.deepEqual(createRemotesStore().getSnapshot(), { instances: [], status: {} })
})

test('setInstances/setStatus are visible to the synchronous read', () => {
  const store = createRemotesStore()
  const list = [spec('a')]
  store.setInstances(list)
  assert.equal(store.getSnapshot().instances, list)
  store.setStatus(prev => ({ ...prev, a: projection('ready') }))
  assert.equal(store.getSnapshot().status.a?.phase, 'ready', 'the event-side read sees the push immediately')
})

test('identity-preserving writes stay silent, real changes notify once', () => {
  const store = createRemotesStore()
  const list = [spec('a')]
  store.setInstances(list)
  let notifications = 0
  store.subscribe(() => { notifications += 1 })
  store.setInstances(list)
  store.setStatus(prev => prev)
  assert.equal(notifications, 0, 'same list / same table is not a change')
  store.setStatus(prev => ({ ...prev, a: projection('connecting') }))
  assert.equal(notifications, 1)
})

test('the App and the bridge hook keep ONE remotes store, not ref mirrors', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  const app = read('../../src/App.tsx')
  assert.match(app, /createRemotesStore/, 'one store instance')
  assert.match(app, /remotesStore\.getSnapshot\(\)/, 'event-side reads go through the store snapshot')
  for (const file of [app, read('../../src/app-hooks/use-bridge-subscriptions.ts')]) {
    assert.doesNotMatch(file, /remoteInstancesRef|remoteStatusRef|setRemoteInstances|setRemoteStatus/,
      'the render-time ref mirrors and their setters must not come back')
  }
})
