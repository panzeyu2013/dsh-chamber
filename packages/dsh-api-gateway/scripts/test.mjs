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
 * test/support/vendor-stub-loader.mjs) because a source lock cannot catch a runtime
 * blocker; that file is the reason they run with
 * --experimental-transform-types (the mirrored upstream file keeps upstream's
 * constructor parameter properties, which strip-only mode rejects).
 */
// Runner semantics (missing listed file, zero-test guard, first-failure stop,
// platform legs) are the shared engine's: scripts/lib/test-manifest.mjs.
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // behavior: the REAL fork modules driven by fakes (vendor leaves stubbed) — the
  // arm a source lock cannot see.
  behavior: [
    {
      // client/index.ts is upstream-shaped and resolves the cordis Service seam
      // plus the client-connection barrel, so this suite runs with the stubs.
      file: 'test/behavior/client-uplink-rejection.test.ts',
      nodeArgs: ['--experimental-transform-types', '--import', './test/support/register-vendor-stubs.mjs'],
    },
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
      // F1 opening phase machine: the mux/RemoteStream pair over a fake socket and
      // clock - orphaned openings, terminal budget exhaustion, generations that keep
      // their widening across replacement, and the domain face's own bound.
      file: 'test/behavior/opening-phase-machine.test.ts',
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
  // injection: cross-shell acceptance - the page harness drives the SHIPPED
  // carrier composition ($stream's wrapper + RemoteStreamCarrierError) and the
  // evidence lands in the one incident ring.
  injection: [
    {
      // stream-client.ts is upstream-shaped (constructor parameter properties) and
      // resolves vendor leaves, exactly like the behavior group.
      file: 'test/injection/stream-injection.test.ts',
      nodeArgs: ['--experimental-transform-types', '--import', './test/support/register-vendor-stubs.mjs'],
    },
  ],
  // patch-lock: the fork patch's shape, pinned against an upstream re-sync.
  'patch-lock': [
    'test/patch-lock/remote-stream-carrier-retry-lock.test.ts',
    'test/patch-lock/journal-stall-watchdog-lock.test.ts',
    // The per-entry base-path normalization is locked against the connection
    // package's resolveInstanceBasePath (source text + runtime table); loading
    // stream-client needs the vendor stubs + the upstream parameter properties.
    {
      file: 'test/patch-lock/base-path-normalization-lock.test.ts',
      nodeArgs: ['--experimental-transform-types', '--import', './test/support/register-vendor-stubs.mjs'],
    },
  ],
}

runTestManifest({
  label: 'dsh-api-gateway',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})
