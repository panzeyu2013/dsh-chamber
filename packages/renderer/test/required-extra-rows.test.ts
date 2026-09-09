/**
 * Required extra-row service probe decisions (alpha.2).
 *
 * The probe itself lives in chamber-entry.ts (which no node test can import —
 * its imports resolve to source), so the decision and the message are pure
 * functions here and pinned by these cases.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  missingRequiredServices,
  requiredServiceProbeMessage,
  REQUIRED_EXTRA_ROW_SERVICES,
  REQUIRED_SERVICE_PROBE_DEADLINE_MS,
} from '../src/required-extra-rows.ts'

test('the required set names the services the composite first-screen plugins inject', () => {
  assert.deepEqual([...REQUIRED_EXTRA_ROW_SERVICES], ['sidebarRight', 'resources'])
})

test('missingRequiredServices reports unprovided services in declaration order', () => {
  const none = missingRequiredServices(() => false)
  assert.deepEqual(none, ['sidebarRight', 'resources'])
  assert.deepEqual(missingRequiredServices(name => name === 'sidebarRight'), ['resources'])
  assert.deepEqual(missingRequiredServices(name => name === 'resources'), ['sidebarRight'])
  assert.deepEqual(missingRequiredServices(() => true), [])
  // A caller-supplied set is honoured (probe reuse for future rows).
  assert.deepEqual(missingRequiredServices(name => name === 'a', ['a', 'b']), ['b'])
})

test('requiredServiceProbeMessage names the services, the deadline, and the instance', () => {
  const withInstance = requiredServiceProbeMessage(['sidebarRight'], 'local')
  assert.ok(withInstance.includes('instance local'), 'the instance id must be named when known')
  assert.ok(withInstance.includes('sidebarRight'), 'the missing service must be named')
  assert.ok(withInstance.includes(`${REQUIRED_SERVICE_PROBE_DEADLINE_MS}ms`), 'the deadline must be named')
  assert.ok(withInstance.includes('conversation surface may stay unregistered'), 'the consequence must be stated')
  const withoutInstance = requiredServiceProbeMessage(['resources'])
  assert.ok(!withoutInstance.includes('instance'), 'an unknown instance adds no clause')
})
