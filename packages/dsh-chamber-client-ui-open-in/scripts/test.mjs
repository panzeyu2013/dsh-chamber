/**
 * @dsh-chamber/dsh-chamber-client-ui-open-in test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). The shared runner
 * (scripts/lib/test-manifest.mjs) owns the semantics: a listed file that does
 * not exist fails, every file runs as its own node child, the first failure
 * ends the run, and a child that exits 0 without executing a node:test body
 * fails (a zero-case manifest is never a pass).
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

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
    // Merged view model + gates: open-in-gates.ts consumes buildOpenInViewModel,
    // one decision chain.
    'test/launch-flow/open-in-view-model.test.ts',
    'test/launch-flow/source-adapter.test.ts',
    'test/launch-flow/choice-store.test.ts',
  ],
  // ui-lock: the OpenInButton menu/owner guard + the console ban over every
  // src/client/*.ts(x). The menu-density decision (compact 26px/12px) is asserted
  // in place by this same file.
  'ui-lock': [
    // 错误文本单源锁：域内名 == sidebar describeThrown + 按钮不得使用朴素格式化。
    'test/ui-lock/hostile-error-text.test.ts',
    'test/ui-lock/instance-view-guard.test.ts',
  ],
  // session-health: the conversation stream-health ladder (error ⇒ automatic
  // heal; parked loading ⇒ stall notice — the page delivery ladder re-issues it)
  // and its imperative half
  'session-health': [
    'test/session-health/session-stream-health.test.ts',
    'test/session-health/stream-health-chip-face.test.ts',
    // Vendor lockstep: reads vendor/harness-packages (needs an installed tree,
    // like every other vendor-reading test) and fails loudly if the three facts
    // the heal depends on ever change with a pin upgrade.
    'test/session-health/vendor-heal-contract.test.ts',
  ],
}

runTestManifest({
  label: '@dsh-chamber/dsh-chamber-client-ui-open-in',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
