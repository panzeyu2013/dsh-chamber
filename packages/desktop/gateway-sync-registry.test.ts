/**
 * gateway-sync-registry unit tests (design 21 §6.5, Phase 3b): the pure
 * in-memory store of manual gateway_plugin_sync re-entry parameters —
 * set/get roundtrip, overwrite on re-registration, clear-on-null, and the
 * test-only full reset. Security property pinned: the stored headers are
 * exactly what was stored (never widened); nothing else is exported.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearGatewaySyncRegistrations,
  getGatewaySyncRegistration,
  setGatewaySyncRegistration,
} from './gateway-sync-registry.ts'
import type { GatewaySyncRegistration } from './gateway-sync-registry.ts'

const REG: GatewaySyncRegistration = {
  url: 'http://127.0.0.1:3939',
  headers: { authorization: 'Bearer test-token' },
  spkiPin: 'a'.repeat(64),
}

test('set/get roundtrip returns the stored registration for that instance id', () => {
  clearGatewaySyncRegistrations()
  setGatewaySyncRegistration('gateway-1', REG)
  assert.deepEqual(getGatewaySyncRegistration('gateway-1'), REG)
  assert.equal(getGatewaySyncRegistration('gateway-2'), undefined)
})

test('set overwrites the previous registration of the same instance id', () => {
  clearGatewaySyncRegistrations()
  const replacement: GatewaySyncRegistration = { url: 'http://127.0.0.1:4949', headers: {}, spkiPin: null }
  setGatewaySyncRegistration('gateway-1', REG)
  setGatewaySyncRegistration('gateway-1', replacement)
  assert.deepEqual(getGatewaySyncRegistration('gateway-1'), replacement)
  // Distinct ids stay independent.
  setGatewaySyncRegistration('gateway-2', REG)
  assert.deepEqual(getGatewaySyncRegistration('gateway-2'), REG)
})

test('set with null clears the entry (leaves-ready / instance-removed path)', () => {
  clearGatewaySyncRegistrations()
  setGatewaySyncRegistration('gateway-1', REG)
  setGatewaySyncRegistration('gateway-1', null)
  assert.equal(getGatewaySyncRegistration('gateway-1'), undefined)
  // Clearing an absent id is a harmless no-op.
  setGatewaySyncRegistration('gateway-absent', null)
  assert.equal(getGatewaySyncRegistration('gateway-absent'), undefined)
})

test('clearGatewaySyncRegistrations resets the whole module state', () => {
  setGatewaySyncRegistration('gateway-1', REG)
  setGatewaySyncRegistration('gateway-2', { url: 'http://127.0.0.1:5959', headers: {}, spkiPin: null })
  clearGatewaySyncRegistrations()
  assert.equal(getGatewaySyncRegistration('gateway-1'), undefined)
  assert.equal(getGatewaySyncRegistration('gateway-2'), undefined)
})
