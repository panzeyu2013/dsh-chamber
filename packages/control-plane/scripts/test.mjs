/**
 * `pnpm run test:control-plane` (root) → `pnpm --filter @dsh-chamber/control-plane
 * run test` — the control-plane unit-test set, exactly the authoritative list
 * in AGENTS.md (Validation). Each file runs as its own `node <file>.ts` child
 * with inherited stdio (the same semantics as the former inline CI chain: a
 * failure in one file stops the run non-zero).
 *
 * Every listed file is required: silently skipping a deleted/renamed test
 * would make the aggregate command pass with less coverage than AGENTS.md and
 * CI claim.
 */

import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEST_DIR = join(PACKAGE_ROOT, 'test')

/** AGENTS.md Validation — the authoritative control-plane unit-test set. */
const FILES = [
  'protocol.test.ts',
  'storage.test.ts',
  'browser-auth-cookie.test.ts',
  'm1-dsh-client.test.ts',
  'host-logs.test.ts',
  'manager-api.test.ts',
  'lifecycle.test.ts',
  'local-connection.test.ts',
  'spawn-dsh.test.ts',
  'instance-proxy.test.ts',
  'gateway-transport.test.ts',
  'ws-frames.test.ts',
  'static-serving.test.ts',
  'host-graph-seed.test.ts',
  'restart-local.test.ts',
  // A2 cross-package protocol single-sourcing: the shared RPC envelope and
  // cordis insert modules (also consumed by the desktop through
  // control-plane-module.ts).
  'rpc-envelope.test.ts',
  'cordis-inserts.test.ts',
  'reaper.test.ts',
  // S0 twin-cap lockstep: proxy-forward MAX_HTML_INJECTION_BYTES vs the
  // gateway's html-inject HTML_INJECT_MAX_BYTES (soft comment pin — the test
  // imports the gateway source directly; precedent: desktop
  // plugin-tarball.test.ts pins gateway route literals the same way).
  'html-inject-lockstep.test.ts',
  // Windows probe parsers/classifiers run on every leg; the win32-only
  // lifecycle integration test self-skips on POSIX and runs on the Windows
  // CI leg (design 02 §5.1 parity work, M1).
  'win-probes.test.ts',
  'win32-lifecycle.integration.test.ts',
]

for (const file of FILES) {
  const path = join(TEST_DIR, file)
  const result = spawnSync(process.execPath, [path], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[test:control-plane] ${file} failed (exit ${result.status ?? `signal ${result.signal}`})`)
    process.exit(1)
  }
}
