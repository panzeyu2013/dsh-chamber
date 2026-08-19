/**
 * shell.ts boot-failure tests (05 §4 failure-presentation revision + 2026-08
 * first-boot race fix).
 *
 * The renderer has no install-tree copy of the dsh workspace packages, so
 * `@deepseek-ai/dsh-client-web` is mapped by `scripts/test-shell-loader.mjs`
 * (registered via `--import scripts/test-shell-register.mjs`, see the
 * test:renderer-shell script) to the committed fixture
 * `test-fixtures/dsh-client-web.mjs`, whose AppWebEntry reports a controlled
 * `bootError` through the test knobs. The host-graph channel is stubbed to 503
 * `instance_unavailable` (no bundle preloads, no DOM needed).
 *
 * Covered: the resolved-but-failed boot (run() resolves, bootError set → the
 * chamber sees a failure and disposes the failed entry so a retry re-boots
 * cleanly), the clean settle, and the legacy run()-rejection path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

// Test knobs — same module instance shell.ts sees (the loader maps the bare
// specifier to this URL; the relative import resolves to the same file).
import {
  __testDisposedCount, __testEventLog, __testResetDisposed, __testResetEventLog,
  __testSetBootError, __testSetModuleSystemError, __testSetRunError,
} from '../test-fixtures/dsh-client-web.mjs'

const { bootInstanceShell } = await import('./shell.ts')

// ── Plumbing ───────────────────────────────────────────────────────────────

/** Host-graph channel resolves 503 instance_unavailable (expected pre-ready; no bundle preloads). */
function stubUnavailableGraph(onFetch?: () => void): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    onFetch?.()
    return new Response(
      JSON.stringify({ code: 'instance_unavailable', error: 'instance not ready' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** shell.ts reads the `window` global for the per-boot knob; mirror it onto globalThis. */
function stubWindow(): () => void {
  const g = globalThis as Record<string, unknown>
  const original = g.window
  g.window = globalThis
  return () => {
    if (original === undefined) delete g.window
    else g.window = original
  }
}

test('bootInstanceShell: a resolved-but-failed run (bootError set) settles as a failure and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError('client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table')
  __testSetRunError(undefined)
  try {
    const state = await bootInstanceShell('test-fail-1', '/api/i/test-fail-1', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table')
    // The failed entry was disposed: a retry re-boots the container cleanly
    // (no duplicate React root / zombie ctx).
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetBootError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a clean run settles booted with no error and keeps the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  try {
    const state = await bootInstanceShell('test-clean-2', '/api/i/test-clean-2', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    assert.equal(state.error, null)
    assert.equal(__testDisposedCount(), 0)
  } finally {
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a throwing run settles as a failure (legacy rejection path) and disposes the entry', async () => {
  const restoreFetch = stubUnavailableGraph()
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(new Error('loader exploded'))
  try {
    const state = await bootInstanceShell('test-throw-3', '/api/i/test-throw-3', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'loader exploded')
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetRunError(undefined)
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: installs the module system BEFORE any host-graph fetch (first-boot race fix)', async () => {
  // The race: an extra bundle's script evaluates at load and registers its
  // factory through the __ModuleLoader__ sink, so the sink must exist before
  // the host-graph channel is even contacted (collectExtraRows's first step is
  // the graph fetch; bundle scripts are only appended after it resolves).
  const restoreFetch = stubUnavailableGraph(() => { __testEventLog().push('fetch') })
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetEventLog()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
  try {
    const state = await bootInstanceShell('test-order-5', '/api/i/test-order-5', {} as HTMLElement, () => {})
    assert.equal(state.booted, true)
    // The fixture's ensureWebModuleSystem records 'ensure' synchronously at
    // bootInstanceShell entry; the fetch is collectExtraRows's first step.
    assert.deepEqual(__testEventLog(), ['ensure', 'fetch'])
  } finally {
    __testResetEventLog()
    restoreFetch()
    restoreWindow()
  }
})

test('bootInstanceShell: a module-system install failure skips the host-graph channel and settles with the same error', async () => {
  // Malformed/missing boot manifest: ensureWebModuleSystem throws → the extras
  // preload is skipped (no sink ⇒ no bundle must execute) and run() rethrows
  // the same parse error (simulated here via the run knob with the same text).
  const restoreFetch = stubUnavailableGraph(() => { __testEventLog().push('fetch') })
  const restoreWindow = stubWindow()
  __testResetDisposed()
  __testResetEventLog()
  __testSetBootError(undefined)
  __testSetModuleSystemError(new Error('missing boot manifest'))
  __testSetRunError(new Error('missing boot manifest'))
  try {
    const state = await bootInstanceShell('test-manifest-6', '/api/i/test-manifest-6', {} as HTMLElement, () => {})
    assert.equal(state.booted, false)
    assert.equal(state.error, 'missing boot manifest')
    // No host-graph fetch at all: with no sink, no bundle may be requested.
    assert.deepEqual(__testEventLog(), ['ensure'])
    // The entry was constructed and disposed via the run()-rejection path.
    assert.equal(__testDisposedCount(), 1)
  } finally {
    __testSetModuleSystemError(undefined)
    __testSetRunError(undefined)
    __testResetEventLog()
    restoreFetch()
    restoreWindow()
  }
})
