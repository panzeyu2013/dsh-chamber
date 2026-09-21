/**
 * @dsh-chamber/dsh-chamber-client-ui-open-in test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its
 * own node child with inherited stdio; the first failure ends the run - the same
 * semantics as the inline && chain this replaces. A listed file that does not
 * exist is a failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // catalog: the host open-in app catalog (RPC + machine readers) and its label table
  catalog: [
    'test/catalog/local-catalog.test.ts',
    'test/catalog/machine-catalog.test.ts',
    'test/catalog/open-in-labels.test.ts',
  ],
  // wire-protocol: the capability projection parsers and the client/host wire lockstep
  'wire-protocol': [
    'test/wire-protocol/capabilities.test.ts',
    'test/wire-protocol/open-in-wire-lockstep.test.ts',
  ],
  // launch-flow: the shared app probe, the per-source view model + gates, and the launch adapter/choice memory
  'launch-flow': [
    'test/launch-flow/coordinator.test.ts',
    // Merged view model + gates (test/open-in-view-model.test.ts + test/open-in-gates.test.ts):
    // open-in-gates.ts consumes buildOpenInViewModel, one decision chain.
    'test/launch-flow/open-in-view-model.test.ts',
    'test/launch-flow/source-adapter.test.ts',
    'test/launch-flow/choice-store.test.ts',
  ],
  // ui-lock: the OpenInButton menu/owner guard + the T5 console ban over every
  // src/client/*.ts(x). The historical batch2 menu-density visual lock was never
  // merged; its decision is asserted in place (compact 26px/12px) by this same file.
  'ui-lock': [
    'test/ui-lock/instance-view-guard.test.ts',
  ],
  // session-health: the conversation stream-health ladder (error ⇒ stage-move
  // heal, parked loading ⇒ reload notice) and its imperative half
  'session-health': [
    'test/session-health/session-stream-health.test.ts',
    'test/session-health/stream-health-chip-face.test.ts',
    'test/session-health/stream-health-wiring.test.ts',
    // Vendor lockstep: reads vendor/harness-packages (needs an installed tree,
    // like every other vendor-reading test) and fails loudly if the three facts
    // the heal depends on ever change with a pin upgrade.
    'test/session-health/vendor-heal-contract.test.ts',
  ],
}

const entries = Object.entries(GROUPS).flatMap(([group, list]) =>
  list.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry })),
)
const missing = entries.filter(entry => !existsSync(join(PACKAGE_ROOT, entry.file)))
if (missing.length > 0) {
  console.error('[test] listed test file(s) missing:')
  for (const entry of missing) console.error('  - ' + entry.file)
  process.exit(1)
}
for (const [index, entry] of entries.entries()) {
  if (index === 0 || entries[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
  const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], { cwd: PACKAGE_ROOT, stdio: "inherit" })
  if (result.status !== 0) {
    console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
    process.exit(1)
  }
}
