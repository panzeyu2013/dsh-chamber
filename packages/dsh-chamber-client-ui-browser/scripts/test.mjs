/**
 * @dsh-chamber/dsh-chamber-client-ui-browser test manifest - authoritative file list for this package test script.
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
  // address: the pure host/scheme table of report v4 §1.
  address: [
    'test/address/address.test.ts',
  ],
  // source: the dsh+ssh entry gate (kind derived from the source id).
  source: [
    'test/source/source-gate.test.ts',
  ],
  // launcher: the local forward contract guards and the pure launcher model.
  launcher: [
    'test/launcher/forward-bridge.test.ts',
    'test/launcher/launcher-model.test.ts',
  ],
  // locks: source-text locks over the registration and the stylesheet tokens.
  locks: [
    'test/locks/registration.test.ts',
  ],
}

runTestManifest({
  label: '@dsh-chamber/dsh-chamber-client-ui-browser',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
