/**
 * @deepseek-ai/dsh-api-gateway test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). Every listed file runs as its own
 * node child with inherited stdio; the first failure ends the run - the same semantics
 * as the inline && chain this replaces. A listed file that does not exist is a failure,
 * never a silent skip.
 *
 * The retry-policy suites are dependency-free truth tables over the pure pacing
 * modules, and the patch-lock suites read source text, so the fork patch stays
 * covered even where the vendor install is absent. The behaviour suites import the
 * REAL fork modules against fakes (vendor leaves stubbed by
 * test/support/vendor-stub-loader.mjs) because a source lock pinned a runtime
 * blocker in the 2026-09 review; that file is the reason they run with
 * --experimental-transform-types (the mirrored upstream file keeps upstream's
 * constructor parameter properties, which strip-only mode rejects).
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // behavior: the REAL fork modules driven by fakes (vendor leaves stubbed) — the
  // arm a source lock cannot see (2026-09 review: a lock pinned a runtime blocker).
  behavior: [
    {
      file: 'test/behavior/journal-stall-probe.test.ts',
      // --experimental-transform-types: journal-stream.ts is the upstream file and
      // keeps upstream's constructor parameter properties, which strip-only mode
      // rejects; the production build type-strips anyway, so only this suite needs
      // the full transform.
      nodeArgs: ['--experimental-transform-types', '--import', './test/support/register-vendor-stubs.mjs'],
    },
    {
      file: 'test/behavior/mux-self-heal.test.ts',
      nodeArgs: ['--experimental-transform-types', '--import', './test/support/register-vendor-stubs.mjs'],
    },
    {
      // 2026-09 renderer-crash round: the retry lane's wait for a connection
      // generation is bounded, so a parked lane reopens instead of parking every
      // new logical stream forever (no error edge, nothing in the UI).
      file: 'test/behavior/remote-stream-generation-wait.test.ts',
      nodeArgs: ['--experimental-transform-types', '--import', './test/support/register-vendor-stubs.mjs'],
    },
  ],
  // retry-policy: chamber carrier-retry pacing (design 14 §D4).
  'retry-policy': [
    'test/retry-policy/remote-retry-policy.test.ts',
    'test/retry-policy/stream-carrier-fact.test.ts',
    'test/retry-policy/stream-forensics.test.ts',
    'test/retry-policy/stream-stall-policy.test.ts',
  ],
  // patch-lock: the fork patch's shape, pinned against an upstream re-sync.
  'patch-lock': [
    'test/patch-lock/remote-stream-carrier-retry-lock.test.ts',
    'test/patch-lock/remote-stream-opening-deadline-lock.test.ts',
    'test/patch-lock/journal-stall-watchdog-lock.test.ts',
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

let failed = 0
for (const [index, entry] of entries.entries()) {
  if (index === 0 || entries[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
  const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
    failed += 1
    break
  }
}
process.exit(failed === 0 ? 0 : 1)
