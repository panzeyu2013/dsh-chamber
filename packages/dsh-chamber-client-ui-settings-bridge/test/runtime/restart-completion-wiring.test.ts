/**
 * 「重启 dsh」 completion wiring lock (2026-12, design 18 §3.6 item 8).
 *
 * The page-owned restart→reload completion lives in the sidebar shared face
 * (\`restart-window-reload.ts\`, unit-tested in the sidebar package); this lock
 * pins the RUNTIME SECTION's wiring to it, because dropping the arm would
 * silently restore the original defect: the plugin mounts refresh on the host
 * while the window keeps running the pre-restart client-plugin set.
 *
 * Plain node + source text on purpose (same technique the package already uses
 * for its other contract locks).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Read one source file of this package. */
function code(relative: string): string {
  return readFileSync(join(HERE, relative), 'utf8')
}

test('the runtime section arms the page-owned completion on both restart shapes', () => {
  const section = code('../../src/client/DshRuntimeSection.tsx')
  const gatewayAt = section.indexOf("instanceSource === 'gateway'")
  const localLeg = section.slice(section.indexOf("instanceSource === 'local'"), gatewayAt)
  const gatewayLeg = section.slice(gatewayAt)
  assert.ok(localLeg.includes('armLocalDshRestartCompletion()'),
    'the local leg must arm the shared completion (wait for serving, then reload the window)')
  assert.ok(localLeg.includes("dshRuntimeRestartNotServed"),
    'a restart that never serves must report honestly instead of reloading onto a dead instance')
  assert.ok(gatewayLeg.includes('armWindowReloadWhenServed('),
    'the gateway leg must arm the same page-owned completion so an unmount cannot cancel it')
  assert.ok(gatewayLeg.includes('RESTART_RELOAD_BUDGET_MS'),
    'the gateway arm keeps its page-level budget (the 120s readiness poll runs inside it)')
})

test('the local restarting transactions arm the same completion', () => {
  const section = code('../../src/client/DshRuntimeSection.tsx')
  // apply-now / retry-apply / retry-restore all stop and respawn the instance:
  // a plugin set change rides the same window-boot rule.
  const arms = section.match(/armLocalDshRestartCompletion\(\)/gu) ?? []
  assert.ok(arms.length >= 4,
    'the restart button plus apply-now / retry-apply / retry-restore must each arm the local completion')
  assert.ok(section.includes('if (ran) void armLocalDshRestartCompletion()'),
    'the runtime transactions must arm only on success')
})

test('the completion is imported from the shared face, never re-implemented here', () => {
  const section = code('../../src/client/DshRuntimeSection.tsx')
  assert.ok(section.includes("from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'"),
    'the completion must come from the sidebar shared face (both client plugins arm the same one)')
  for (const banned of ['window.location.reload', 'location.reload()']) {
    assert.ok(!section.includes(banned),
      `the section must not navigate itself (${banned}) — the completion owns the single reload`)
  }
})
