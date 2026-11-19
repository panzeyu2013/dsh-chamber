/**
 * Behavior tests for the patched-bundle loading half (design 09 §4): the loader
 * contract it must mirror (success / read failure / anchor refusal / 30s timeout with
 * BundleLoadTimeoutError + bundleOutcome / late success executes and settles the
 * outcome / no double settlement), the per-entry anchor-miss policy (`refuse` rejects;
 * `degrade-unpatched` reports through onAnchorMiss and delegates to the untouched
 * script-element fallback — never `new Function` on the served text), the served-text
 * fetch behavior (HTTP status, content-type, byte cap), and the new Function executor
 * (classic-script self-registration + sourceURL line-terminator hardening).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BUNDLE_TEXT_MAX_BYTES,
  executePatchedBundle,
  fetchPluginBundleText,
  loadPatchedBundle,
  type PatchedBundleLoadDeps,
} from '../../src/patched-bundle-load.ts'
import { CHAT_IMPORT_PACKAGE_ID } from '../../src/client-plugin-patches.ts'

/** Let queued microtasks (the loader's async operation) run. */
const tick = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

/** A promise with manually controlled settlement. */
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolveFn!: (value: T) => void
  let rejectFn!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => { resolveFn = resolve; rejectFn = reject })
  // keep the rejection observed even when a test does not await it yet
  promise.catch(() => undefined)
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/** The synthetic fail-closed patch: 'GOOD' patches to 'PATCHED', anything else refuses. */
const SYNTHETIC_PATCH = {
  packageId: '@scope/synthetic',
  anchors: 2,
  reason: 'synthetic reason for the loader-contract suite',
  anchorTexts: ['A', 'B'],
  anchorMiss: 'refuse' as const,
  probe: Object.freeze({ token: 'PATCHED', count: 1 }),
  apply: (text: string): string | null => (text === 'GOOD' ? 'PATCHED' : null),
}

/** The synthetic CORE-row degrade patch: an anchor miss delegates to the script fallback. */
const SYNTHETIC_DEGRADE_PATCH = { ...SYNTHETIC_PATCH, anchorMiss: 'degrade-unpatched' as const }

/** One loader harness: manual timers, recorded deps, controllable read and degrade fallback. */
function harness(options: { withAnchorMiss?: boolean } = {}): {
  deps: PatchedBundleLoadDeps
  setReadText(next: (url: string) => Promise<string>): void
  setUnpatched(next: (url: string) => Promise<void>): void
  executed: Array<{ text: string; url: string }>
  unpatched: string[]
  anchorMisses: Array<{ packageId: string; anchors: number; url: string }>
  timeoutErrors: Array<{ message: string; outcome: Promise<boolean> }>
  timers: { fire(): void; pending(): number; cleared(): number }
} {
  const executed: Array<{ text: string; url: string }> = []
  const unpatched: string[] = []
  const anchorMisses: Array<{ packageId: string; anchors: number; url: string }> = []
  const timeoutErrors: Array<{ message: string; outcome: Promise<boolean> }> = []
  const callbacks: Array<() => void> = []
  let cleared = 0
  let readImpl: (url: string) => Promise<string> = async () => 'GOOD'
  let unpatchedImpl: (url: string) => Promise<void> = async () => {}
  const deps: PatchedBundleLoadDeps = {
    readText: (url) => readImpl(url),
    execute: (text, url) => { executed.push({ text, url }) },
    loadUnpatched: (url) => { unpatched.push(url); return unpatchedImpl(url) },
    ...(options.withAnchorMiss === false
      ? {}
      : { onAnchorMiss: (info: { packageId: string; anchors: number; url: string }) => { anchorMisses.push(info) } }),
    createTimeoutError: (message, outcome) => {
      timeoutErrors.push({ message, outcome })
      const error = new Error(message)
      error.name = 'FakeBundleLoadTimeoutError'
      return error
    },
    setTimeout: (callback) => { callbacks.push(callback); return callbacks.length },
    clearTimeout: () => { cleared += 1 },
    timeoutMs: 30,
  }
  return {
    deps,
    setReadText: (next: (url: string) => Promise<string>) => { readImpl = next },
    setUnpatched: (next: (url: string) => Promise<void>) => { unpatchedImpl = next },
    executed,
    unpatched,
    anchorMisses,
    timeoutErrors,
    timers: {
      fire: () => { for (const callback of callbacks.splice(0)) callback() },
      pending: () => callbacks.length,
      cleared: () => cleared,
    },
  }
}

test('loadPatchedBundle: success reads, patched-executes and resolves once', async () => {
  const h = harness()
  await loadPatchedBundle('http://cp/api/i/local/plugins/??x/client.js', SYNTHETIC_PATCH, h.deps)
  assert.deepEqual(h.executed, [{ text: 'PATCHED', url: 'http://cp/api/i/local/plugins/??x/client.js' }])
  assert.equal(h.timers.cleared(), 1, 'the loader budget must be cleared on success')
})

test('loadPatchedBundle: a read failure rejects with that error and never executes', async () => {
  const h = harness()
  const readError = new Error('network down')
  h.setReadText(async () => { throw readError })
  await assert.rejects(loadPatchedBundle('http://cp/x', SYNTHETIC_PATCH, h.deps), error => error === readError)
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: a missing anchor refuses the load (reason + anchors in the message)', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  await assert.rejects(
    loadPatchedBundle('http://cp/api/i/local/plugins/??x/client.js', SYNTHETIC_PATCH, h.deps),
    error => error instanceof Error
      && error.message.includes(SYNTHETIC_PATCH.packageId)
      && error.message.includes(SYNTHETIC_PATCH.reason)
      && error.message.includes('anchors: 2')
      && error.message.includes('refusing to load the unpatched bundle'),
  )
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: a degrade row falls back to the untouched script path (never new Function)', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  const url = 'http://cp/api/i/local/plugins/??x/client.js'
  await loadPatchedBundle(url, SYNTHETIC_DEGRADE_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url], 'the served bundle loads through the untouched script path')
  assert.deepEqual(h.anchorMisses, [{ packageId: SYNTHETIC_DEGRADE_PATCH.packageId, anchors: 2, url }])
  assert.equal(h.executed.length, 0, 'degrade must NOT execute the served text via new Function')
  assert.equal(h.timers.cleared(), 1, 'the loader budget is cleared when the fallback settles')
})

test('loadPatchedBundle: degrade works without an onAnchorMiss sink (the callback is optional)', async () => {
  const h = harness({ withAnchorMiss: false })
  h.setReadText(async () => 'DRIFTED')
  await loadPatchedBundle('http://cp/x', SYNTHETIC_DEGRADE_PATCH, h.deps)
  assert.deepEqual(h.unpatched, ['http://cp/x'])
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: a failing degrade fallback rejects with the script-path error', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  const failure = new Error('script element failed')
  h.setUnpatched(async () => { throw failure })
  await assert.rejects(
    loadPatchedBundle('http://cp/x', SYNTHETIC_DEGRADE_PATCH, h.deps),
    error => error === failure,
  )
  assert.deepEqual(h.unpatched, ['http://cp/x'])
  assert.equal(h.anchorMisses.length, 1)
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: the loader timeout still owns a hung degrade fallback', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  const fallback = deferred<void>()
  h.setUnpatched(() => fallback.promise)
  const promise = loadPatchedBundle('http://cp/x', SYNTHETIC_DEGRADE_PATCH, h.deps)
  await tick()
  assert.deepEqual(h.unpatched, ['http://cp/x'])
  h.timers.fire()
  await assert.rejects(promise, error => (error as Error).name === 'FakeBundleLoadTimeoutError')
  const outcome = h.timeoutErrors[0]!.outcome
  fallback.resolve()
  await tick()
  assert.equal(await outcome, true, 'a late degrade success settles the tombstone outcome loaded')
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: timeout rejects with the injected error carrying bundleOutcome, then late success executes and settles the outcome true', async () => {
  const h = harness()
  const read = deferred<string>()
  h.setReadText(() => read.promise)
  const promise = loadPatchedBundle('http://cp/x', SYNTHETIC_PATCH, h.deps)
  assert.equal(h.timers.pending(), 1)
  h.timers.fire()
  await assert.rejects(promise, error => (error as Error).name === 'FakeBundleLoadTimeoutError')
  assert.equal(h.timeoutErrors.length, 1)
  assert.ok(h.timeoutErrors[0]!.message.includes('timed out after 30ms'))
  assert.ok(h.timeoutErrors[0]!.message.includes('dsh-chamber: patched bundle http://cp/x'))
  const outcome = h.timeoutErrors[0]!.outcome
  // The operation is still pending: a late success executes the bundle and settles TRUE.
  assert.equal(h.executed.length, 0)
  read.resolve('GOOD')
  await tick()
  assert.deepEqual(h.executed, [{ text: 'PATCHED', url: 'http://cp/x' }])
  assert.equal(await outcome, true)
})

test('loadPatchedBundle: a late failure after the timeout settles the outcome false', async () => {
  const h = harness()
  const read = deferred<string>()
  h.setReadText(() => read.promise)
  const promise = loadPatchedBundle('http://cp/x', SYNTHETIC_PATCH, h.deps)
  h.timers.fire()
  await assert.rejects(promise)
  const outcome = h.timeoutErrors[0]!.outcome
  read.reject(new Error('late read failure'))
  await tick()
  assert.equal(h.executed.length, 0)
  assert.equal(await outcome, false)
})

test('loadPatchedBundle: double settlement is guarded (repeated timer fires reject once and execute once)', async () => {
  const h = harness()
  const read = deferred<string>()
  h.setReadText(() => read.promise)
  let rejections = 0
  const promise = loadPatchedBundle('http://cp/x', SYNTHETIC_PATCH, h.deps)
  promise.catch(() => { rejections += 1 })
  h.timers.fire()
  h.timers.fire()
  await assert.rejects(promise)
  assert.equal(rejections, 1, 'the request must reject exactly once')
  read.resolve('GOOD')
  await tick()
  assert.equal(h.executed.length, 1, 'the late success must execute the bundle exactly once')
})

/** Install one fetch stub; returns the restore. */
function stubFetch(handler: (url: string) => Promise<Response>): () => void {
  const globals = globalThis as { fetch: typeof fetch }
  const previous = globals.fetch
  globals.fetch = ((input: string | URL | Request) => handler(String(input))) as typeof fetch
  return () => { globals.fetch = previous }
}

test('fetchPluginBundleText: a 200 JavaScript answer returns its text', async () => {
  const restore = stubFetch(async () => new Response('bundle source', {
    status: 200,
    headers: { 'content-type': 'text/javascript; charset=utf-8' },
  }))
  try {
    assert.equal(await fetchPluginBundleText('http://cp/x', { budget: 'caller-held', timeoutMs: 1_000 }), 'bundle source')
  } finally {
    restore()
  }
})

test('fetchPluginBundleText: non-200 and non-JavaScript answers are refused', async () => {
  let restore = stubFetch(async () => new Response('boom', { status: 500 }))
  try {
    await assert.rejects(
      fetchPluginBundleText('http://cp/x', { budget: 'caller-held', timeoutMs: 1_000 }),
      /answered HTTP 500/,
    )
  } finally {
    restore()
  }
  restore = stubFetch(async () => new Response('<html></html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }))
  try {
    await assert.rejects(
      fetchPluginBundleText('http://cp/x', { budget: 'caller-held', timeoutMs: 1_000 }),
      /is not JavaScript/,
    )
  } finally {
    restore()
  }
})

test('fetchPluginBundleText: a declared size above the text cap is refused', async () => {
  const restore = stubFetch(async () => new Response('small body', {
    status: 200,
    headers: {
      'content-type': 'text/javascript',
      'content-length': String(BUNDLE_TEXT_MAX_BYTES + 1),
    },
  }))
  try {
    await assert.rejects(
      fetchPluginBundleText('http://cp/x', { budget: 'caller-held', timeoutMs: 1_000 }),
      /declares .* bytes/,
    )
  } finally {
    restore()
  }
})

test('executePatchedBundle: a classic-script bundle self-registers through the page loader', () => {
  const loaded: { id?: string } = {}
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  globals.window = { __ModuleLoader__: { load: (handoff: { id: string }) => { loaded.id = handoff.id } } }
  try {
    executePatchedBundle('window.__ModuleLoader__.load({id:`smoke`,factory:()=>({})});', 'http://cp/x')
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
  assert.equal(loaded.id, 'smoke')
})

test('executePatchedBundle: U+2028/U+2029 (and CRLF/LF) in the URL cannot escape the sourceURL comment', () => {
  const globals = globalThis as { __patchProbe?: number; __patchInjected?: number }
  try {
    for (const separator of ['\u2028', '\u2029', '\r\n', '\n']) {
      delete globals.__patchProbe
      delete globals.__patchInjected
      executePatchedBundle('globalThis.__patchProbe = 1', 'http://cp/x' + separator + 'globalThis.__patchInjected = 1')
      assert.equal(globals.__patchProbe, 1, 'the bundle body itself must execute')
      assert.equal(globals.__patchInjected, undefined, 'the URL tail must never execute as code (' + JSON.stringify(separator) + ')')
    }
  } finally {
    delete globals.__patchProbe
    delete globals.__patchInjected
  }
})

// Keep the imported package id referenced: the loader tests use a synthetic patch, while
// the real table is covered by client-plugin-patches.test.ts.
void CHAT_IMPORT_PACKAGE_ID
