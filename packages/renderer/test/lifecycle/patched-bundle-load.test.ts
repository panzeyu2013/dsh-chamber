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

/**
 * The synthetic optional-profile patch: ANY pre-execution failure (read, rewrite,
 * compile) degrades to the untouched script path; an execution failure stays loud.
 */
const SYNTHETIC_OPTIONAL_PATCH = { ...SYNTHETIC_PATCH, anchorMiss: 'degrade-unpatched-optional' as const }

/** Optional-profile row whose rewrite itself throws: still a pre-execution fallback. */
const SYNTHETIC_THROWING_OPTIONAL_PATCH = {
  ...SYNTHETIC_OPTIONAL_PATCH,
  apply: (): string | null => { throw new Error('rewrite exploded') },
}

/** One loader harness: manual timers, recorded deps, controllable read and degrade fallback. */
function harness(options: { withAnchorMiss?: boolean } = {}): {
  deps: PatchedBundleLoadDeps
  setReadText(next: (url: string) => Promise<string>): void
  setUnpatched(next: (url: string) => Promise<void>): void
  setExecute(next: (text: string, url: string) => void): void
  setCompile(next: ((text: string) => void) | undefined): void
  setAnchorSink(next: ((info: { packageId: string; anchors: number; url: string }) => void) | undefined): void
  setFallbackSink(next: ((info: { packageId: string; reason: string; url: string }) => void) | undefined): void
  executed: Array<{ text: string; url: string }>
  unpatched: string[]
  anchorMisses: Array<{ packageId: string; anchors: number; url: string }>
  fallbacks: Array<{ packageId: string; reason: string; url: string }>
  timeoutErrors: Array<{ message: string; outcome: Promise<boolean> }>
  timers: { fire(): void; pending(): number; cleared(): number }
} {
  const executed: Array<{ text: string; url: string }> = []
  const unpatched: string[] = []
  const anchorMisses: Array<{ packageId: string; anchors: number; url: string }> = []
  const fallbacks: Array<{ packageId: string; reason: string; url: string }> = []
  const timeoutErrors: Array<{ message: string; outcome: Promise<boolean> }> = []
  const callbacks: Array<() => void> = []
  let cleared = 0
  let readImpl: (url: string) => Promise<string> = async () => 'GOOD'
  let unpatchedImpl: (url: string) => Promise<void> = async () => {}
  let executeImpl: ((text: string, url: string) => void) | undefined
  let compileImpl: ((text: string) => void) | undefined
  let anchorSinkImpl: ((info: { packageId: string; anchors: number; url: string }) => void) | undefined
    = (info) => { anchorMisses.push(info) }
  let fallbackSinkImpl: ((info: { packageId: string; reason: string; url: string }) => void) | undefined
    = (info) => { fallbacks.push(info) }
  const deps: PatchedBundleLoadDeps = {
    readText: (url) => readImpl(url),
    execute: (text, url) => {
      executed.push({ text, url })
      executeImpl?.(text, url)
    },
    loadUnpatched: (url) => { unpatched.push(url); return unpatchedImpl(url) },
    ...(options.withAnchorMiss === false
      ? {}
      : { onAnchorMiss: (info: { packageId: string; anchors: number; url: string }) => { anchorSinkImpl?.(info) } }),
    onFallback: info => { fallbackSinkImpl?.(info) },
    compile: (text) => { compileImpl?.(text) },
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
    setExecute: (next: (text: string, url: string) => void) => { executeImpl = next },
    setCompile: (next: ((text: string) => void) | undefined) => { compileImpl = next },
    setAnchorSink: (next) => { anchorSinkImpl = next },
    setFallbackSink: (next) => { fallbackSinkImpl = next },
    executed,
    unpatched,
    anchorMisses,
    fallbacks,
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

test('loadPatchedBundle: a degrade-unpatched core row read failure stays loud', async () => {
  const h = harness()
  const readError = new Error('served text unavailable')
  h.setReadText(async () => { throw readError })
  await assert.rejects(loadPatchedBundle('http://cp/x', SYNTHETIC_DEGRADE_PATCH, h.deps), error => error === readError)
  assert.equal(h.unpatched.length, 0, 'a read failure is not an anchor miss; the core row must not fall back')
  assert.equal(h.fallbacks.length, 0)
})

test('loadPatchedBundle: an official refuse row rewrite failure stays loud (fail-closed)', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  const throwingRefuse = { ...SYNTHETIC_PATCH, apply: (): string | null => { throw new Error('rewrite exploded') } }
  await assert.rejects(loadPatchedBundle('http://cp/x', throwingRefuse, h.deps), /rewrite exploded/u)
  assert.equal(h.unpatched.length, 0, 'only optional rows degrade; a refuse row must never run unpatched')
  assert.equal(h.fallbacks.length, 0)
})

test('loadPatchedBundle: a degrade-unpatched core row never consults the compile gate', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  const compiled: string[] = []
  h.setCompile(text => { compiled.push(text) })
  await loadPatchedBundle('http://cp/x', SYNTHETIC_DEGRADE_PATCH, h.deps)
  assert.deepEqual(h.executed, [{ text: 'PATCHED', url: 'http://cp/x' }])
  assert.deepEqual(compiled, [], 'compile is only the optional-profile pre-execution gate')
})

test('loadPatchedBundle: optional-profile read failure degrades before any execution', async () => {
  const h = harness()
  const readError = new Error('served text unavailable')
  h.setReadText(async () => { throw readError })
  const url = 'http://cp/api/i/local/plugins/??x/client.js'
  await loadPatchedBundle(url, SYNTHETIC_OPTIONAL_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url], 'the untouched script path carries the optional row')
  assert.deepEqual(h.fallbacks, [{ packageId: SYNTHETIC_OPTIONAL_PATCH.packageId, reason: 'read-failed', url }])
  assert.equal(h.executed.length, 0, 'a pre-execution failure never executes the patched text')
  assert.equal(h.timers.cleared(), 1)
})

test('loadPatchedBundle: optional-profile rewrite that throws degrades with the rewrite-threw reason', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  const url = 'http://cp/x'
  await loadPatchedBundle(url, SYNTHETIC_THROWING_OPTIONAL_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url])
  assert.deepEqual(h.fallbacks, [{ packageId: SYNTHETIC_THROWING_OPTIONAL_PATCH.packageId, reason: 'rewrite-threw', url }])
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: official rows never consult the optional compile gate', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  const compiled: string[] = []
  h.setCompile(text => { compiled.push(text) })
  await loadPatchedBundle('http://cp/x', SYNTHETIC_PATCH, h.deps)
  assert.deepEqual(h.executed, [{ text: 'PATCHED', url: 'http://cp/x' }])
  assert.deepEqual(compiled, [], 'compile is only the optional-profile pre-execution gate')
})

test('loadPatchedBundle: optional-profile guard mismatch degrades with the mismatch reason', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  const url = 'http://cp/x'
  await loadPatchedBundle(url, SYNTHETIC_OPTIONAL_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url])
  assert.deepEqual(h.fallbacks, [{ packageId: SYNTHETIC_OPTIONAL_PATCH.packageId, reason: 'guards-mismatched', url }])
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: optional-profile compile failure degrades before execution', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  h.setCompile(() => { throw new SyntaxError('patched text does not compile') })
  const url = 'http://cp/x'
  await loadPatchedBundle(url, SYNTHETIC_OPTIONAL_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url])
  assert.deepEqual(h.fallbacks, [{ packageId: SYNTHETIC_OPTIONAL_PATCH.packageId, reason: 'compile-failed', url }])
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: an unavailable compile executor degrades under its own reason', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  // A page CSP without 'unsafe-eval' makes `new Function` throw EvalError: the rewrite is
  // not at fault, so the diagnostic must not blame it (only SyntaxError is compile-failed).
  h.setCompile(() => { throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script") })
  const url = 'http://cp/x'
  await loadPatchedBundle(url, SYNTHETIC_OPTIONAL_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url])
  assert.deepEqual(h.fallbacks, [{ packageId: SYNTHETIC_OPTIONAL_PATCH.packageId, reason: 'eval-unavailable', url }])
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: optional-profile success compiles then executes, never falls back', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  const compiled: string[] = []
  h.setCompile(text => { compiled.push(text) })
  await loadPatchedBundle('http://cp/x', SYNTHETIC_OPTIONAL_PATCH, h.deps)
  // The gate must validate the REWRITTEN text; compiling the served text (or nothing) would
  // let a broken rewrite through to execution and turn an optional row into a boot failure.
  assert.deepEqual(compiled, ['PATCHED'], 'the pre-execution compile gate sees the patched text')
  assert.deepEqual(h.executed, [{ text: 'PATCHED', url: 'http://cp/x' }])
  assert.equal(h.unpatched.length, 0)
  assert.equal(h.fallbacks.length, 0)
})

test('loadPatchedBundle: optional-profile execution failure stays loud and never degrades', async () => {
  const h = harness()
  h.setReadText(async () => 'GOOD')
  const executeError = new Error('classic script threw while evaluating')
  h.setExecute(() => { throw executeError })
  await assert.rejects(loadPatchedBundle('http://cp/x', SYNTHETIC_OPTIONAL_PATCH, h.deps), error => error === executeError)
  assert.equal(h.unpatched.length, 0, 'a started execution is never replayed through the script path')
  assert.equal(h.fallbacks.length, 0)
})

test('loadPatchedBundle: a late optional-profile read failure after the timeout settles the fallback outcome true', async () => {
  const h = harness()
  const read = deferred<string>()
  h.setReadText(() => read.promise)
  const url = 'http://cp/x'
  const promise = loadPatchedBundle(url, SYNTHETIC_OPTIONAL_PATCH, h.deps)
  h.timers.fire()
  await assert.rejects(promise)
  const outcome = h.timeoutErrors[0]!.outcome
  read.reject(new Error('late read failure'))
  await tick()
  assert.deepEqual(h.unpatched, [url], 'the late failure degrades through the untouched script path')
  assert.equal(await outcome, true, 'the fallback success settles the tombstone outcome loaded')
})

test('loadPatchedBundle: a throwing optional-profile fallback sink never breaks the degrade', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  h.setFallbackSink(() => { throw new Error('diagnostic sink exploded') })
  const url = 'http://cp/x'
  await loadPatchedBundle(url, SYNTHETIC_OPTIONAL_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url], 'the fallback still runs when its diagnostic sink throws')
  assert.equal(h.fallbacks.length, 0)
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: a throwing core-row anchor sink never breaks the degrade', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  h.setAnchorSink(() => { throw new Error('diagnostic sink exploded') })
  const url = 'http://cp/x'
  await loadPatchedBundle(url, SYNTHETIC_DEGRADE_PATCH, h.deps)
  assert.deepEqual(h.unpatched, [url], 'the fallback still runs when its diagnostic sink throws')
  assert.equal(h.anchorMisses.length, 0)
  assert.equal(h.executed.length, 0)
})

test('loadPatchedBundle: an optional-profile fallback that itself fails rejects with that failure', async () => {
  const h = harness()
  h.setReadText(async () => 'DRIFTED')
  const scriptFailure = new Error('script element failed')
  h.setUnpatched(async () => { throw scriptFailure })
  await assert.rejects(loadPatchedBundle('http://cp/x', SYNTHETIC_OPTIONAL_PATCH, h.deps), error => error === scriptFailure)
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
