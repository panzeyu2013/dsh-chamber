/**
 * ConnectionsSection wiring drift (design 21 §5.1/§6.3/§6.8 r1).
 *
 * The card is a React component that cannot be rendered in this DOM-free
 * suite, so the gates it wires are pinned at the SOURCE level — the same
 * lockstep discipline as host-validation.test.ts / plugin-model.test.ts. Each
 * assertion here is a regression that was real:
 *
 * 1. The「重启 dsh」button was disabled on `!connected` (tunnel phase) only,
 *    while the core restart route accepts `ready`/`degraded` — a stopped
 *    runtime made the button a guaranteed 409 (English body.error on screen).
 * 2. The runtime probe RETURNED on a failed/non-200/missing-field read,
 *    leaving the previous entry in place: a stale `stopped` kept「启动实例」
 *    alive forever and every click was another guaranteed 409.
 * 3. The start flow reused the restart poll without telling it which action it
 *    followed, so a start failure was reported as "restart failed".
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(TEST_DIR, '..', 'src', 'client', 'ConnectionsSection.tsx'), 'utf8')

/** A source window around a marker (JSX call sites are matched in context). */
function window(marker: string, before = 900, after = 900): string {
  const index = source.indexOf(marker)
  assert.notEqual(index, -1, `ConnectionsSection.tsx no longer contains: ${marker}`)
  return source.slice(Math.max(0, index - before), index + after)
}

test('the「重启 dsh」button is gated by the runtime projection, not by the tunnel phase alone', () => {
  assert.match(source, /const restartBlocked = runtimeBlocksRestart\(runtimeConnectionState\)/u,
    'the card must project the runtime gate from the same entry the start action reads')
  const restartButton = window('setRestartConfirmFor(spec)')
  assert.match(restartButton, /disabled=\{[^}]*restartBlocked[^}]*\}/u,
    'the restart button must be disabled when the probe answered a state the route refuses')
  assert.match(restartButton, /restartNotConnected[\s\S]*restartBlocked[\s\S]*t\('restartManagedDsh'\)/u,
    'the disabled reason must name the not-running state (localized), not only the tunnel state')
})

test('a failed runtime probe DELETES the card entry and never returns early', () => {
  const body = /const probeGatewayRuntime = useCallback\(async \(specId: string\): Promise<void> => \{([\s\S]*?)\n {2}\}, \[\]\)/u.exec(source)?.[1]
  assert.ok(body !== undefined, 'probeGatewayRuntime must stay a single useCallback with no deps')
  assert.match(body, /setRuntimeConnectionById\(prev => applyRuntimeProbe\(prev, specId, connectionState\)\)/u,
    'the probe answer (including "unavailable" = null) must be applied through the shared projection')
  assert.equal(
    body.trimEnd().endsWith('setRuntimeConnectionById(prev => applyRuntimeProbe(prev, specId, connectionState))'),
    true,
    'the setter is the callback\'s last statement: no early return may skip the clearing write',
  )
  assert.equal(/if \(connectionState === null\) return/u.test(body), false,
    'an unavailable probe must clear the stale entry — it must not keep a stale stopped/error value')
})

test('the start flow polls with action:\'start\' so its failures are never reported as restart failures', () => {
  assert.match(source, /pollGatewayReady\(id, controller\.signal, \{ action: 'restart' \}\)/u,
    'the restart flow must name its action explicitly')
  assert.match(source, /pollGatewayReady\(id, controller\.signal, \{ action: 'start' \}\)/u,
    'the start action must reach the shared poll — restart wording on a start failure is a lie')
  assert.equal(/pollGatewayReady\(id, controller\.signal\)/u.test(source), false,
    'no runtime action may poll with an implicit action')
})
