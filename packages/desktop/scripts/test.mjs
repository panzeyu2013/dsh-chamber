/**
 * @dsh-chamber/desktop test manifest — authoritative file list for this
 * package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as
 * its own node child with inherited stdio; the first failure ends the run — the
 * same semantics as the inline && chain this replaces. A listed file that does
 * not exist is a failure, never a silent skip.
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 *
 * Platform split (same precedent as packages/control-plane/scripts/test.mjs):
 * `test` runs GROUPS below; `test:win32` runs WIN32_FILES via --win32.
 * win-acl.test.ts exercises the icacls argument builders / output verifiers on
 * every leg (the win32 exec helper is platform-gated inside the module), so it
 * is both part of the full set and the package's Windows CI leg.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // transport: instance transport specs, connection save/credential binding and the ssh transport provider
  transport: [
    'test/transport/transport-manager.test.ts',
    'test/transport/transport-connection-recovery.test.ts',
    'test/transport/transport-exec-and-registry.test.ts',
    'test/transport/transport-providers.test.ts',
    'test/transport/transport-spec-binding.test.ts',
    'test/transport/connection-save.test.ts',
    'test/transport/ssh-provider.test.ts',
    'test/transport/ssh-provider-exec.test.ts',
    'test/transport/ssh-provider-endpoint-auth.test.ts',
    'test/transport/ssh-config.test.ts',
    'test/transport/free-port.test.ts',
  ],
  // gateway: gateway provider/session and the manual gateway plugin sync apply path
  gateway: [
    'test/gateway/gateway-provider.test.ts',
    'test/gateway/gateway-session-spki.test.ts',
    'test/gateway/gateway-chamber-sync.test.ts',
    'test/gateway/gateway-chamber-apply-materialize.test.ts',
    'test/gateway/gateway-ipc-shared.test.ts',
    'test/gateway/gateway-sync-registry.test.ts',
    'test/gateway/gateway-session.test.ts',
    'test/gateway/gateway-session-lifecycle.test.ts',
    'test/gateway/gateway-session-refresh.test.ts',
  ],
  // plugins: remote plugin sync/tarball, the ssh apply increment rows + journal, and the main.ts plugin wiring gates
  plugins: [
    'test/plugins/plugin-sync.test.ts',
    'test/plugins/plugin-sync-remote-read.test.ts',
    'test/plugins/plugin-sync-apply.test.ts',
    'test/plugins/plugin-sync-seed.test.ts',
    'test/plugins/plugin-sync-renderer-projection.test.ts',
    'test/plugins/main-wiring-guards.test.ts',
    'test/plugins/plugin-tarball.test.ts',
    'test/plugins/ssh-apply-rows.test.ts',
    'test/plugins/ssh-plugin-journal.test.ts',
  ],
  // runtime: managed dsh runtime controller, renderer<->main action lockstep, and the main.ts decision gates
  runtime: [
    'test/runtime/runtime-lockstep.test.ts',
    'test/runtime/dsh-runtime-controller.test.ts',
    'test/runtime/main-decision-gates.test.ts',
  ],
  // ipc: preload/renderer IPC surface mirror, cross-package protocol lockstep and IPC sender trust
  ipc: [
    'test/ipc/renderer-trust.test.ts',
    'test/ipc/cross-package-contract.test.ts',
    'test/ipc/ipc-surface-mirror.test.ts',
  ],
  // desktop-shell: OS-facing shell surfaces (deep links, open-in, notifications, badge) and the update lifecycle
  'desktop-shell': [
    'test/desktop-shell/notifications.test.ts',
    'test/desktop-shell/badge.test.ts',
    'test/desktop-shell/deep-link.test.ts',
    'test/desktop-shell/open-in.test.ts',
    'test/desktop-shell/updater.test.ts',
    'test/desktop-shell/updater-restart-install.test.ts',
    'test/desktop-shell/updater-cache-maintenance.test.ts',
    'test/desktop-shell/update-restart-quit.test.ts',
  ],
  // local-state: durable local files — settings, audit log and owner-private ACLs
  'local-state': [
    'test/local-state/audit-log.test.ts',
    'test/local-state/chamber-settings.test.ts',
    'test/local-state/win-acl.test.ts',
  ],
  // scripts: package build/packaging helper tests (stay in scripts/ by design)
  scripts: [
    'scripts/bundle-swap.test.mjs',
    'scripts/after-pack-adhoc-sign.test.mjs',
    'scripts/before-pack.test.mjs',
    'scripts/build-host-graph-package.test.mjs',
    'scripts/electron-shared.test.mjs',
    'scripts/control-plane-freshness.test.mjs',
  ],
}

/** Windows CI leg (`test:win32` / `--win32`): win32-real or platform-neutral units only. */
const WIN32_FILES = [
  'test/local-state/win-acl.test.ts',
]

const win32 = process.argv.includes('--win32')
const entries = (
  win32
    ? WIN32_FILES.map(file => ({ group: 'win32', file, nodeArgs: [] }))
    : Object.entries(GROUPS).flatMap(([group, list]) =>
        list.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry })),
      )
)
const missing = entries.filter(entry => !existsSync(join(PACKAGE_ROOT, entry.file)))
if (missing.length > 0) {
  console.error('[test] listed test file(s) missing:')
  for (const entry of missing) console.error('  - ' + entry.file)
  process.exit(1)
}
for (const [index, entry] of entries.entries()) {
  if (index === 0 || entries[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
  const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], { cwd: PACKAGE_ROOT, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
    process.exit(1)
  }
}
