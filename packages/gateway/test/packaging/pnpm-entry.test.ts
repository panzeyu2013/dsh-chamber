/**
 * pnpm-entry: which pnpm entry the gateway hands to the control plane.
 *
 * Making that entry reachable to the managed host (upstream's plugin manager spawns
 * a literal `pnpm` from PATH) is the control plane's PATH provision (design 02
 * §3.1), covered by packages/control-plane/test/host-lifecycle/pnpm-shim.test.ts.
 * This case pins that the gateway resolves an existing entry script.
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { resolvePnpmEntry } from '../../src/pnpm-entry.ts'

test('resolvePnpmEntry returns an existing pnpm entry script', () => {
  const entry = resolvePnpmEntry()
  assert.ok(entry.endsWith('pnpm.cjs'), `unexpected entry: ${entry}`)
  assert.ok(existsSync(entry), `entry does not exist: ${entry}`)
})
