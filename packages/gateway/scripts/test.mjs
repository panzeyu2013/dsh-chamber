/**
 * @dsh-chamber/gateway test manifest - authoritative file list for this package test script.
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
  // auth: the identity faces (providers, CLI, login page) and the credential/state store.
  auth: [
    'test/auth/auth.test.ts',
    'test/auth/cli-auth.test.ts',
    'test/auth/login-page.test.ts',
    'test/auth/warmup-login-page.test.ts',
    'test/auth/store-permissions.test.ts',
  ],
  // boundary: the public request boundary - exposure config, policy/dispatch chain, audit trail, error redaction.
  boundary: [
    'test/boundary/config.test.ts',
    'test/boundary/warmup.test.ts',
    'test/boundary/warmup-dispatch.test.ts',
    'test/boundary/public-boundary.test.ts',
    'test/boundary/mobile-ua-redirect.test.ts',
    'test/boundary/dispatch-composition.test.ts',
    'test/boundary/dispatch-credential-routes.test.ts',
    'test/boundary/boundary-login-page.test.ts',
    'test/boundary/audit.test.ts',
    'test/boundary/sanitize-route-error.test.ts',
  ],
  // proxy: the single-target reverse proxy, the S0 HTML trust injection, and the full-chain unary RPC proof.
  proxy: [
    'test/proxy/html-inject.test.ts',
    'test/proxy/gateway-proxy.test.ts',
    'test/proxy/plugin-inventory-proxy.test.ts',
  ],
  // runtime: managed-dsh boot/lifecycle, the /chamber/runtime controller, workspace path resolution and spawn guards.
  runtime: [
    'test/runtime/dsh-path.test.ts',
    'test/runtime/spawn-guards.test.ts',
    'test/runtime/lifecycle.test.ts',
    'test/runtime/runtime-routes.test.ts',
    'test/runtime/runtime-ownership.test.ts',
    'test/runtime/runtime-registry-status.test.ts',
    'test/runtime/runtime-apply-now-preflight.test.ts',
    'test/runtime/runtime-activation-probes.test.ts',
    'test/runtime/runtime-apply-now-recovery.test.ts',
    'test/runtime/runtime-builtin-selection.test.ts',
    'test/runtime/runtime-restart-exhausted.test.ts',
    'test/runtime/runtime-route-gates.test.ts',
    'test/runtime/runtime-start-lease-invalidation.test.ts',
  ],
  // plugins: the managed-profile plugin pipeline - journal, executor, tgz scan, orchestrator, spec lockstep.
  plugins: [
    'test/plugins/plugins-journal.test.ts',
    'test/plugins/plugins-exec.test.ts',
    'test/plugins/tgz-scan.test.ts',
    'test/plugins/plugins-tasks.test.ts',
    'test/plugins/plugin-spec-lockstep.test.ts',
  ],
  // chamber-surface: the /chamber/* route surface - installed read projection, write mutations, dashboard assets.
  'chamber-surface': [
    'test/chamber-surface/chamber-installed.test.ts',
    'test/chamber-surface/chamber-plugins-mutations.test.ts',
    'test/chamber-surface/feature-lifecycle.test.ts',
  ],
  // packaging: the shipped artifact surface - pnpm PATH shim, installer script, dist bundle smoke.
  packaging: [
    'test/packaging/pnpm-entry.test.ts',
    'test/packaging/install-script.test.ts',
    'test/packaging/install-anchor.test.ts',
    'test/packaging/build-smoke.test.ts',
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
