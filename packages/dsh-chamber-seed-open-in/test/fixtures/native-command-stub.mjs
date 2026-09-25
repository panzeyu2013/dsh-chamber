/**
 * Fail-loud `@deepseek-ai/dsh-native-command` stand-in for this package's node
 * unit tests (see ../support/vendor-loader.mjs).
 *
 * The vendored dsh tree is source-only (no `lib/`), so the real adapter cannot
 * be imported by a plain `node test/…` run without a full workspace build —
 * the same reason `packages/dsh-client-connection/test/fixtures/
 * schemastery-stub.mjs` exists for the connection chain.
 *
 * The domain core under test never reaches the host ADAPTERS: `open()` is
 * exercised with an injected `launch` seam, and the hermetic catalog fixtures
 * resolve through `cli`/`desktop` locators, never through the OS open verb. A
 * real call therefore throws instead of silently doing nothing, so a test that
 * starts depending on the host adapter fails loudly and gets a real seam instead.
 * The Linux desktop-entry helpers are pure file/string logic with no host
 * command, so they are re-exported from the pinned vendor source below rather
 * than stubbed — the Linux fixture exercises the logic the instance runs.
 */

const MESSAGE = '@deepseek-ai/dsh-native-command is stubbed in this package\'s node unit tests; '
  + 'inject a `launch`/`run` seam instead of exercising the OS adapter'

/** Real runner entry point (upstream `runner.ts`) — not part of the seam. */
export function runNativeCommand() {
  throw new Error(MESSAGE)
}

/** Real Windows/macOS/Linux open-verb path (upstream `path-opener.ts`). */
export function openNativePath() {
  throw new Error(MESSAGE)
}

/**
 * Availability probe for the OS open verb. This one ANSWERS instead of
 * throwing: the forked resolver consults it while resolving `cli` locators
 * that require a desktop session (`resolver.ts:520-524`), and a probe is not an
 * action — "this test host has no desktop open verb" is the honest answer, and
 * detection then falls through to the next locator exactly as it would on a
 * headless host.
 * @returns false, always.
 */
export function canOpenNativePath() {
  return false
}

/**
 * Linux desktop-entry/icon helpers (upstream `desktop-entry.ts`): pure
 * string/path/file logic with no host command and no `lib/` import, re-exported
 * from the pinned vendor source so the hermetic Linux fixture (temp XDG data
 * dir plus a real tiny PNG) exercises the same reader the instance runs.
 */
export { desktopEntryFields, desktopDataDirectories, desktopApplicationIcon }
  from '../../../../vendor/harness-packages/@deepseek-ai/dsh-native-command/src/desktop-entry.ts'
