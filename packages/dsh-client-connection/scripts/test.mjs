/**
 * @deepseek-ai/dsh-client-connection test manifest - authoritative file list for this package test script.
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
  // base-path: the per-instance base path and the generic RPC carrier assembly.
  'base-path': [
    'test/base-path/api-path.test.ts',
    'test/base-path/carrier-assembly.test.ts',
  ],
  // lifecycle: the apply/start seam it installs (the former liveness-wiring
  // source lock was removed by the 2026-12 ruling).
  lifecycle: [
    {
      file: 'test/lifecycle/client-apply.test.ts',
      nodeArgs: ['--import', '../../scripts/dev/test-connection-register.mjs'],
    },
  ],
  // recovery: the sleep/wake recovery triggers and the per-source recovery policy.
  recovery: [
    {
      file: 'test/recovery/liveness-triggers.test.ts',
      nodeArgs: ['--import', '../../scripts/dev/test-connection-register.mjs'],
    },
    'test/recovery/recovery-policy.test.ts',
  ],
}

runTestManifest({
  label: '@deepseek-ai/dsh-client-connection',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
