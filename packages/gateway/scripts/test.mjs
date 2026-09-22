/**
 * @dsh-chamber/gateway test manifest - authoritative file list for this package test script.
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
  // auth: the identity faces (providers, CLI, login page) and the credential/state store.
  auth: [
    'test/auth/auth.test.ts',
    'test/auth/cli-auth.test.ts',
    'test/auth/warmup-login-page.test.ts',
    'test/auth/store-permissions.test.ts',
  ],
  // boundary: the public request boundary - exposure config, policy/dispatch chain, audit trail, error redaction.
  boundary: [
    'test/boundary/config.test.ts',
    'test/boundary/warmup.test.ts',
    'test/boundary/public-boundary.test.ts',
    'test/boundary/mobile-ua-redirect.test.ts',
    'test/boundary/dispatch-composition.test.ts',
    'test/boundary/dispatch-credential-routes.test.ts',
    'test/boundary/boundary-login-page.test.ts',
    'test/boundary/audit.test.ts',
    'test/boundary/dashboard-semver-lockstep.test.ts',
  ],
  // proxy: the single-target reverse proxy, the S0 HTML trust injection, and the full-chain unary RPC proof.
  proxy: [
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
    'test/runtime/runtime-metadata-fail-closed.test.ts',
  ],
  // plugins: the managed-profile plugin pipeline - journal, executor, tgz scan, orchestrator, spec lockstep.
  plugins: [
    'test/plugins/plugins-journal.test.ts',
    'test/plugins/plugins-exec.test.ts',
    'test/plugins/tgz-scan.test.ts',
    'test/plugins/plugins-tasks.test.ts',
    'test/plugins/plugin-spec-lockstep.test.ts',
  ],
  // session-state: the read-only watcher - store/state machine + persistence,
  // the observer over the real control-plane mux (fake socket/call seams),
  // routes + SSE, and the /chamber/* claim + config kill switch. These files
  // import the workspace packages by name, so they run through the test-only
  // resolver that maps them onto the real source entries (no node_modules in a
  // bare worktree; the production bundle is unaffected).
  'session-state': [
    { file: 'test/session-state/session-state-store.test.ts', nodeArgs: ['--import', './test/session-state/workspace-loader.mjs'] },
    { file: 'test/session-state/session-state-persistence.test.ts', nodeArgs: ['--import', './test/session-state/workspace-loader.mjs'] },
    { file: 'test/session-state/session-state-observer.test.ts', nodeArgs: ['--import', './test/session-state/workspace-loader.mjs'] },
    { file: 'test/session-state/session-state-routes.test.ts', nodeArgs: ['--import', './test/session-state/workspace-loader.mjs'] },
    { file: 'test/session-state/session-state-surface.test.ts', nodeArgs: ['--import', './test/session-state/workspace-loader.mjs'] },
    { file: 'test/session-state/session-state-old-desktop-matrix.test.ts', nodeArgs: ['--import', './test/session-state/workspace-loader.mjs'] },
    { file: 'test/session-state/session-state-diagnostics.test.ts', nodeArgs: ['--import', './test/session-state/workspace-loader.mjs'] },
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

runTestManifest({
  label: '@dsh-chamber/gateway',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
