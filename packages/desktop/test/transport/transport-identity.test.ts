import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  connectionIdForRawInstance,
  instanceIdFromConnectionId,
  linkBusyAdapter,
  linkFailureAdapter,
} from '../../transport-identity.ts'

test('the raw id and the connectionId convert in both directions', () => {
  assert.equal(connectionIdForRawInstance('abc', 'dsh'), 'dsh:abc')
  assert.equal(instanceIdFromConnectionId('dsh:abc'), 'abc')
})

test('an id containing a dash survives the conversion', () => {
  // The raw id grammar allows '-'; the separator scan must not cut it.
  for (const kind of ['dsh', 'gateway', 'ssh']) {
    const raw = 'a-b-c'
    assert.equal(instanceIdFromConnectionId(connectionIdForRawInstance(raw, kind)), raw)
  }
})

test('malformed ids read as null, never as a different existing id', () => {
  assert.equal(instanceIdFromConnectionId(''), null)
  assert.equal(instanceIdFromConnectionId('dsh'), null)
  assert.equal(instanceIdFromConnectionId('dsh:'), null)
  assert.equal(instanceIdFromConnectionId(':abc'), null)
})

test('the manager ⇄ plane adapters translate ids in both directions', () => {
  // The plane speaks connectionIds; the manager speaks raw ids. A mismatch here is
  // SILENT (states.get(unknown) === undefined), so the composed contract is pinned.
  const rows = [{ id: 'abc', kind: 'dsh' }, { id: 'a-b', kind: 'gateway' }]
  const busy = new Set(['dsh:abc'])
  const linkBusy = linkBusyAdapter(() => rows, connectionId => busy.has(connectionId))
  assert.equal(linkBusy('abc'), true, 'the raw id reached the plane as its connectionId')
  assert.equal(linkBusy('a-b'), false)
  assert.equal(linkBusy('missing'), false, 'an unknown raw id is never busy')

  const seen: string[] = []
  const onFailure = linkFailureAdapter(id => seen.push(id))
  onFailure('dsh:abc')
  onFailure('gateway:a-b')
  onFailure('malformed')
  assert.deepEqual(seen, ['abc', 'a-b'], 'only well-formed connectionIds reach the manager, as raw ids')
})
