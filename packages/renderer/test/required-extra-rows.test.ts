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

test('the required set names exactly the extra-row-only service a composite plugin injects', () => {
  // 2026-09 三轮: `fileUpload` was removed (the upload client is now covered by
  // the composite) and `resources` was removed (it is a rendering-time seat no
  // composite plugin injects, and it can never go missing alone).
  assert.deepEqual([...REQUIRED_EXTRA_ROW_SERVICES], ['sidebarRight'])
})

test('missingRequiredServices reports unprovided services in declaration order', () => {
  const none = missingRequiredServices(() => false)
  assert.deepEqual(none, ['sidebarRight'])
  assert.deepEqual(missingRequiredServices(name => name === 'sidebarRight'), [])
  assert.deepEqual(missingRequiredServices(() => true), [])
  // A caller-supplied set is honoured (probe reuse for future rows).
  assert.deepEqual(missingRequiredServices(name => name === 'a', ['a', 'b']), ['b'])
})

test('requiredServiceProbeMessage names the services, the deadline, and the instance', () => {
  const withInstance = requiredServiceProbeMessage(['sidebarRight'], 'local')
  assert.ok(withInstance.includes('instance local'), 'the instance id must be named when known')
  assert.ok(withInstance.includes('sidebarRight'), 'the missing service must be named')
  assert.ok(withInstance.includes(`${REQUIRED_SERVICE_PROBE_DEADLINE_MS}ms`), 'the deadline must be named')
  assert.ok(withInstance.includes('conversation view may stay unregistered'), 'the consequence must be stated')
  assert.ok(withInstance.includes('ui-sidebar-right'), 'the responsible row must be named')
  const withoutInstance = requiredServiceProbeMessage(['sidebarRight'])
  assert.ok(!withoutInstance.includes('instance'), 'an unknown instance adds no clause')
})
