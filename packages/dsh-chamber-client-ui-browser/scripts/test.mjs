/**
 * @dsh-chamber/dsh-chamber-client-ui-browser test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). The shared runner
 * (scripts/lib/test-manifest.mjs) owns the semantics: a listed file that does
 * not exist fails, every file runs as its own node child, the first failure
 * ends the run, and a child that exits 0 without executing a node:test body
 * fails (a zero-case manifest is never a pass).
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 *
 * The Browser plugin keeps upstream `@deepseek-ai/dsh-client-ui-sidebar-browser`
 * (0.2.2-rc.2) chrome/address/history and drives the Swift shell's native guest
 * (one child WKWebView per tab, design 28 v3 / ADR-0004). The only behavior
 * difference is the SSH reverse proxy (forward recordRef + alias external exit).
 * The URL and navigation suites are node:test dialects of the upstream specs, the
 * forward resolver suite covers the one diff, the carrier suite pins the bridge
 * guard/geometry model, and the locks suite pins the fork surface.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTestManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

const GROUPS = {
  // url: upstream HTTP(S) address policy (default https, allowlist, refusals).
  url: [
    'test/url/url.test.ts',
  ],
  // navigation: upstream bounded application-known history + observation states.
  navigation: [
    'test/navigation/navigation.test.ts',
  ],
  // forward: the carrier's ONLY behavior diff — logical target → guest target recordRef.
  forward: [
    'test/forward/resolver.test.ts',
    'test/launcher/forward-bridge.test.ts',
  ],
  // carrier: the native guest bridge guard, push projections and placeholder geometry.
  carrier: [
    'test/carrier/native-guest.test.ts',
    'test/carrier/guest-state.test.ts',
    'test/carrier/popup-limit.test.ts',
  ],
  // lifecycle: the tab-occurrence forward lease the resolver drives.
  lifecycle: [
    'test/lifecycle/forward-controller.test.ts',
  ],
  // source: the chamber entry gate (local / ssh sources only; http stays absent).
  source: [
    'test/source/source-gate.test.ts',
  ],
  // registration: the readiness wait for the right-sidebar host services.
  registration: [
    'test/registration/registry-wait.test.ts',
  ],
  // locks: source-text locks over the fork surface and the stylesheet tokens.
  locks: [
    'test/locks/registration.test.ts',
  ],
}

runTestManifest({
  label: '@dsh-chamber/dsh-chamber-client-ui-browser',
  packageRoot: PACKAGE_ROOT,
  groups: GROUPS,
})