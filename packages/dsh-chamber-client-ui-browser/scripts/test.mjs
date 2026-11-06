/**
 * @dsh-chamber/dsh-chamber-client-ui-browser test manifest - authoritative file list for this package test script.
 * Grouped by subject area (mirrors test/<domain>/). The shared runner
 * (scripts/lib/test-manifest.mjs) owns the semantics: a listed file that does
 * not exist fails, every file runs as its own node child, the first failure
 * ends the run, and a child that exits 0 without executing a node:test body
 * fails (a zero-case manifest is never a pass).
 * Entries: a path, or { file, nodeArgs } when a loader (--import ...) is needed.
 *
 * This package is a faithful source fork of upstream
 * `@deepseek-ai/dsh-client-ui-sidebar-browser` (0.2.2-rc.1) iframe path; the
 * only behavior difference is the SSH reverse proxy (forward frame-src resolver
 * + the forwarded page's alias external exit). The URL and
 * navigation suites are node:test dialects of the upstream specs, the forward
 * resolver suite covers the one diff, and the locks suite pins the fork surface
 * (verbatim digests + the deleted self-built UI).
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
  // forward: the fork's ONLY behavior diff — logical target → exact iframe src.
  forward: [
    'test/forward/resolver.test.ts',
    'test/launcher/forward-bridge.test.ts',
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
