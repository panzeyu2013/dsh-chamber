/**
 * `pnpm run test:control-plane` — the control-plane unit-test set, exactly the
 * authoritative list in AGENTS.md (Validation). Each file runs as its own
 * `node <file>.ts` child with inherited stdio (the same semantics as the
 * former inline CI chain: a failure in one file stops the run non-zero).
 *
 * `reaper.ts` joins the set once it exists (agent-cp's orphan-reaper unit
 * test); it is skipped with a notice while absent so the script stays
 * runnable in the interim.
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const TEST_DIR = join(ROOT, 'packages', 'control-plane', 'test')

/** AGENTS.md Validation — the authoritative control-plane unit-test set. */
const FILES = [
  'protocol.ts',
  'storage.ts',
  'm1-dsh-client.ts',
  'host-logs.ts',
  'manager-api.ts',
  'local-connection.ts',
  'spawn-dsh.ts',
  'instance-proxy.ts',
  'ws-frames.ts',
  'static-serving.ts',
  'host-graph-seed.ts',
  // A2 cross-package protocol single-sourcing: the shared RPC envelope and
  // cordis insert modules (also consumed by the desktop through
  // control-plane-module.ts).
  'rpc-envelope.ts',
  'cordis-inserts.ts',
  'reaper.ts', // agent-cp: joins the set once the orphan-reaper test exists
]

for (const file of FILES) {
  const path = join(TEST_DIR, file)
  if (!existsSync(path)) {
    console.log(`[test:control-plane] skip ${file} (not present)`)
    continue
  }
  const result = spawnSync(process.execPath, [path], { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[test:control-plane] ${file} failed (exit ${result.status ?? `signal ${result.signal}`})`)
    process.exit(1)
  }
}
