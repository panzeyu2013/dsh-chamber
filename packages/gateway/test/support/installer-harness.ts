/**
 * Shared installer harness for the split packaging suites: installer library
 * slicing, the host-safe systemctl stubs and the bash harness runners over it.
 * Extracted verbatim from install-script.test.ts.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const installer = fileURLToPath(new URL('../../../../scripts/install-gateway.sh', import.meta.url))
export const source = readFileSync(installer, 'utf8')
export const mainMarker = '\nSUBCOMMAND="install"\n'
export const mainOffset = source.indexOf(mainMarker)
assert.notEqual(mainOffset, -1, 'installer main marker must remain discoverable')
export const library = source.slice(0, mainOffset)

// The installer library registers `trap on_exit_cleanup EXIT` at top level:
// under the fail-closed guard, a clean rc=0 end only counts as success when
// the flow reached the EXITED_OK=1 marker (the real main sets it right before
// its final `exit`). Unit harnesses have no dispatcher, so the epilogue marks
// their natural end — mid-body crashes (die/set -u/expansion errors) abort
// before it and still fail closed through the trap.
export const LIB_EPILOGUE = '\nEXITED_OK=1\n'

/**
 * Host-global safety net prepended to every harness body.
 *
 * The installer's D2 cross-mode cleanup calls `systemctl` DIRECTLY — not the
 * `systemctl_for_mode` wrapper — with the FIXED unit name
 * `dsh-chamber-gateway.service` (`scripts/install-gateway.sh:2619-2623`:
 * "cross-mode overwrite install first cleans the old mode's residue"), and the
 * install/update paths reach it. A harness body that mocks only
 * `systemctl_for_mode` therefore lets the REAL systemctl through: running this
 * suite on a machine that has the real gateway service installed STOPS (and, on
 * a normal dev box, also DISABLES) that service. Observed on the project's own
 * Linux test rig — three `test:gateway` runs each stopped the host gateway
 * ~35-41 s in, triggered by the `do_install` test ("overlay install rollback…"),
 * taking their own agent session down with it (the suite runs inside the
 * gateway unit's cgroup, so its own `stop` killed the caller before `disable`).
 *
 * The stub is installed only where a real `systemctl` exists, so the macOS leg
 * keeps its previous "no systemd" behavior, and `systemctl_for_mode` is left to
 * the library (tests that assert scope routing still exercise it). A test that
 * wants to observe systemctl defines its own function in the body, which
 * overrides this stub.
 */
export const HOST_SAFE_STUBS = `
if command -v systemctl >/dev/null 2>&1; then
  systemctl() { printf 'systemctl-stubbed: %s\\n' "$*" >&2; return 0; }
fi
`

/** Compose one harness script: installer library + host-safe stubs + test body. */
export function harnessSource(body: string): string {
  return `${library}\n${HOST_SAFE_STUBS}\n${body}${LIB_EPILOGUE}`
}

export function runLibrary(body: string, env: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-test-'))
  const harness = join(dir, 'harness.sh')
  try {
    writeFileSync(harness, harnessSource(body), { mode: 0o700 })
    const result = spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_CHAMBER_BASE_DIR: env.DSH_CHAMBER_BASE_DIR ?? join(dir, 'base'),
        ...env,
      },
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`installer harness exited ${String(result.status)}\n${result.stdout}${result.stderr}`)
    }
    return result.stdout
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function runLibraryResult(body: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-installer-test-'))
  const harness = join(dir, 'harness.sh')
  try {
    writeFileSync(harness, harnessSource(body), { mode: 0o700 })
    return spawnSync('bash', [harness], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DSH_CHAMBER_BASE_DIR: env.DSH_CHAMBER_BASE_DIR ?? join(dir, 'base'),
        ...env,
      },
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function writeGatewayTree(root: string, version: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@dsh-chamber/gateway', version }))
  writeFileSync(join(root, 'dist', 'cli.js'), '#!/usr/bin/env node\n')
}
