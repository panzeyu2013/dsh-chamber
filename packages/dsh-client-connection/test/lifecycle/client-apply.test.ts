/**
 * node:test for the chamber apply seam (`src/client/index.ts`, design 05 §6/§4):
 * the per-entry `chamberBasePath` bound on the entry Context reaches the generic
 * RPC carrier as its URL prefix — no plugin config and no page-global knob
 * participate. The carrier class is pinned here too (design 14 §D4): a `local`
 * carrier is exempt from the browser network gate — it makes its first attempt
 * while `navigator.onLine` is false and never parks on `offline` — while a
 * remote carrier keeps the stock parking loop. The wake-event
 * constant is pinned here too: the shell's App layer dispatches exactly this
 * window event. The fixture path is locked here as well: a `?fixture` page
 * URL must not swap the production transport, and the scaffold file
 * must stay absent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import {
  apply,
  SYSTEM_RESUME_EVENT,
  type ConnectionGenerationSource,
  type ConnectionHandle,
  type ConnectionLoop,
  type ConnectionState,
} from '../../src/client/index.ts'

interface FakeHandle {
  readonly rpc: { call(...args: unknown[]): Promise<unknown> }
  reconnect(): void
}

function fakeContext(
  chamberBasePath: string | undefined,
  chamberTransport?: 'local' | 'ssh' | 'http',
): { ctx: never; handle: () => FakeHandle } {
  let handle: unknown
  const ctx = {
    chamberBasePath,
    chamberTransport,
    // Real Cordis hands provided services out through `ctx.get`; the fake mirrors
    // that face so the apply seam's production carrier read is exercised.
    get: (name: string): unknown => (name === 'chamberTransport' ? chamberTransport : undefined),
    provide: (name: string, value: unknown): void => { if (name === 'connection') handle = value },
  }
  return { ctx: ctx as never, handle: () => handle as FakeHandle }
}

/**
 * Run one carrier call through a recording fetch and return the request path.
 * Replacing the global for one call is the only seam: the real
 * `createWebConnectionRpc` reads `globalThis.fetch` lazily at call time, so the
 * recorded URL is the per-entry prefix the apply seam actually installed.
 */
async function recordedCallPath(handle: FakeHandle): Promise<string> {
  const originalFetch = globalThis.fetch
  let url = ''
  globalThis.fetch = (async (input: string | URL, init: RequestInit): Promise<Response> => {
    url = String(input)
    const request = JSON.parse(String(init.body)) as { rpcId: string }
    return {
      ok: true,
      // rc.2 reads the response media type before choosing the JSON envelope path.
      headers: { get: () => 'application/json' },
      json: async () => ({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: null } }),
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  try {
    await handle.rpc.call('/api', 'session/follow', { args: {} })
  } finally {
    globalThis.fetch = originalFetch
  }
  // rc.2 sends the document-relative route for the stock base; resolve it the way a page would.
  return new URL(url, 'http://dsh.internal').pathname
}

test('apply reads ctx.chamberBasePath into the generic RPC carrier prefix', async () => {
  const { ctx, handle } = fakeContext('/api/i/ssh-right')
  apply(ctx)
  assert.equal(await recordedCallPath(handle()), '/api/i/ssh-right/api/session/follow')
  assert.equal(typeof handle().rpc.call, 'function')
  assert.equal(typeof handle().reconnect, 'function')
})

test('apply without a ctx base path keeps the stock no-prefix surface', async () => {
  const { ctx, handle } = fakeContext(undefined)
  apply(ctx)
  assert.equal(await recordedCallPath(handle()), '/api/session/follow')
})

test('an explicit transport rpc keeps upstream precedence over the base-path carrier', () => {
  // rc.2's ClientTransportHooks.rpc replaces the HTTP caller outright; the
  // per-entry prefix must not be assembled on top of a decoded carrier.
  const globals = globalThis as { __DSH_TRANSPORT__?: unknown }
  const previous = globals.__DSH_TRANSPORT__
  const explicit = { call: async () => ({ ok: true as const, value: null }) }
  globals.__DSH_TRANSPORT__ = { rpc: explicit }
  try {
    const { ctx, handle } = fakeContext('/api/i/ssh-right')
    apply(ctx)
    assert.equal(handle().rpc, explicit)
  } finally {
    if (previous === undefined) delete globals.__DSH_TRANSPORT__
    else globals.__DSH_TRANSPORT__ = previous
  }
})

test('the wake-event name is the canonical chamber export', () => {
  assert.equal(SYSTEM_RESUME_EVENT, 'dsh-chamber:system-resume')
})

test('a ?fixture page URL no longer selects a fixture transport (retired with src/client/fixture.ts)', async () => {
  // The apply seam must always
  // build the real per-entry carrier, so a stale bookmark cannot swap the
  // production transport for fabricated data. A fixture branch
  // keyed on the page URL fails here (the fixture RPC never reaches fetch).
  const globals = globalThis as { location?: unknown }
  const previousLocation = globals.location
  globals.location = { search: '?fixture', origin: 'http://dsh.internal', hostname: '127.0.0.1' }
  try {
    const { ctx, handle } = fakeContext('/api/i/local')
    apply(ctx)
    assert.equal(await recordedCallPath(handle()), '/api/i/local/api/session/follow')
  } finally {
    if (previousLocation === undefined) delete globals.location
    else globals.location = previousLocation
  }
})

test('the browser fixture scaffold stays out of the fork (registry dropped entry)', () => {
  // The file itself must not come back without a registry decision: reappearing
  // would put its 4037 lines and dsh-llm value imports back into the composite
  // boot chunk.
  assert.equal(existsSync(new URL('../../src/client/fixture.ts', import.meta.url)), false)
})

// ── chamber carrier class: a local loopback carrier is exempt from the browser
// network gate (design 14 §D4); remote carriers keep the stock parking loop ──

type CarrierTransport = 'local' | 'ssh' | 'http'

interface FakeBrowserWindow {
  readonly navigator: { onLine: boolean }
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  emit(type: string): void
  listenerTypes(): string[]
}

/** Browser window stub: `navigator.onLine` plus online/offline listener recording. */
function fakeBrowserWindow(onLine: boolean): FakeBrowserWindow {
  const listeners = new Map<string, Array<() => void>>()
  return {
    navigator: { onLine },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = listeners.get(type)
      if (list === undefined) return
      const next = list.filter(candidate => candidate !== listener)
      if (next.length === 0) listeners.delete(type)
      else listeners.set(type, next)
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
    listenerTypes: () => [...listeners.keys()],
  }
}

/**
 * Run one probe with the page globals the real seam reads: `window` (the browser
 * network target), `location` (the page location apply forwards) and
 * `navigator` (the liveness network gate). All three are restored afterwards, so
 * every fixture leaves the process-global as it found it.
 */
async function withFakePage<T>(onLine: boolean, body: (win: FakeBrowserWindow) => Promise<T>): Promise<T> {
  const win = fakeBrowserWindow(onLine)
  const globals = globalThis as Record<string, unknown>
  const previousWindow = globals.window
  const previousLocation = globals.location
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  globals.window = win
  globals.location = { search: '', origin: 'http://dsh.internal', hostname: '127.0.0.1' }
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
  try {
    return await body(win)
  } finally {
    if (previousWindow === undefined) delete globals.window
    else globals.window = previousWindow
    if (previousLocation === undefined) delete globals.location
    else globals.location = previousLocation
    if (previousNavigator === undefined) delete (globalThis as Record<string, unknown>).navigator
    else Object.defineProperty(globalThis, 'navigator', previousNavigator)
  }
}

interface ProbedConnection {
  readonly handle: ConnectionHandle
  readonly attempts: () => number
  readonly states: ConnectionState[]
  start(): ConnectionLoop
}

/**
 * Install the real apply seam over a recording fake Context and register a probe
 * generation source: attempts are counted, and every established generation stays
 * open until the connection aborts it (the contract the controller expects).
 */
function probedConnection(options: {
  basePath: string
  chamberTransport?: CarrierTransport
  /** false = a pre-fact shell that exposes only the Context property, no `ctx.get`. */
  providedRead?: boolean
}): ProbedConnection {
  let handle: ConnectionHandle | undefined
  const ctx: Record<string, unknown> = {
    chamberBasePath: options.basePath,
    provide: (name: string, value: unknown): void => {
      if (name === 'connection') handle = value as ConnectionHandle
    },
  }
  if (options.providedRead === false) ctx.chamberTransport = options.chamberTransport
  else ctx.get = (name: string): unknown => (name === 'chamberTransport' ? options.chamberTransport : undefined)
  apply(ctx as never)
  if (handle === undefined) throw new Error('apply did not provide the connection service')
  const connection = handle
  const attempts = { count: 0 }
  const states: ConnectionState[] = []
  const source: ConnectionGenerationSource = (signal, ready) => {
    attempts.count += 1
    const stopped = new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new Error('probe source aborted')) }, { once: true })
    })
    ready({ home: '/home/probe' })
    return stopped
  }
  connection.registerGenerationSource(source)
  return {
    handle: connection,
    attempts: () => attempts.count,
    states,
    start: () => connection.start({ onStateChange: state => states.push(state) }),
  }
}

/** Poll until the predicate holds; a test-local wait never races a fixed sleep. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('a local carrier makes its first attempt while the browser reports offline', async () => {
  await withFakePage(false, async (win) => {
    const probe = probedConnection({ basePath: '/api/i/local', chamberTransport: 'local' })
    const loop = probe.start()
    await until(() => probe.states.at(-1) === 'connected', 'the local carrier to connect')
    assert.equal(probe.attempts(), 1, 'navigator.onLine === false must not delay the first attempt')
    assert.deepEqual(probe.states, ['connected'])
    assert.equal(win.listenerTypes().includes('offline'), false, 'a local carrier installs no browser network gate')
    assert.equal(win.listenerTypes().filter(type => type === 'online').length, 1, 'only the liveness online trigger remains')
    loop.stop()
  })
})

test('a remote carrier still parks before its first attempt while the browser reports offline', async () => {
  await withFakePage(false, async (win) => {
    const probe = probedConnection({ basePath: '/api/i/ssh-one', chamberTransport: 'ssh' })
    const loop = probe.start()
    await until(() => probe.states.at(-1) === 'disconnected', 'the remote carrier to park')
    assert.equal(probe.attempts(), 0, 'the stock network gate parks before the first attempt')
    assert.deepEqual(probe.states, ['disconnected'])
    assert.ok(win.listenerTypes().includes('offline'), 'a remote carrier keeps the browser network gate')
    // The stock restore path is intact: an online event resumes the parked loop.
    win.navigator.onLine = true
    win.emit('online')
    await until(() => probe.states.at(-1) === 'connected', 'the restored link to reconnect')
    assert.equal(probe.attempts(), 1)
    loop.stop()
  })
})

test('offline events and the wake bypass leave a local carrier un-parked', async () => {
  await withFakePage(false, async (win) => {
    const probe = probedConnection({ basePath: '/api/i/local', chamberTransport: 'local' })
    const loop = probe.start()
    await until(() => probe.states.at(-1) === 'connected', 'the local carrier to connect')
    const firstGeneration = probe.handle.generation.getSnapshot()?.id
    // No offline listener exists, so the event cannot park the loop.
    win.emit('offline')
    // An online event while the browser still reports offline stays behind the
    // liveness gate: it must not churn a healthy local loop.
    win.emit('online')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(probe.states.at(-1), 'connected')
    assert.equal(probe.attempts(), 1, 'offline/online events add no attempt')
    // The OS-wake bypass is unchanged for local: exactly one bounded reconnect,
    // never a parked ('disconnected') loop.
    win.emit(SYSTEM_RESUME_EVENT)
    await until(() => probe.attempts() === 2, 'the wake bypass to force one attempt')
    await until(() => probe.states.at(-1) === 'connected', 'the woken loop to reconnect')
    assert.equal(probe.states.includes('disconnected'), false, 'a local loop never parks')
    assert.notEqual(probe.handle.generation.getSnapshot()?.id, firstGeneration, 'the wake replaced the generation')
    loop.stop()
  })
})

test('a carrier fact absent from the Context keeps the stock remote gate', async () => {
  await withFakePage(false, async (win) => {
    // The instance path is a routing fact, not a carrier fact: with the provided
    // chamberTransport fact missing, the page keeps today's parking behaviour
    // instead of inferring locality from /api/i/local.
    const probe = probedConnection({ basePath: '/api/i/local' })
    const loop = probe.start()
    await until(() => probe.states.at(-1) === 'disconnected', 'the fallback carrier to park')
    assert.equal(probe.attempts(), 0)
    assert.ok(win.listenerTypes().includes('offline'))
    loop.stop()
  })
})

test('a legacy shell without ctx.get still resolves the local carrier from the Context property', async () => {
  await withFakePage(false, async (win) => {
    const probe = probedConnection({ basePath: '/api/i/local', chamberTransport: 'local', providedRead: false })
    const loop = probe.start()
    await until(() => probe.states.at(-1) === 'connected', 'the property-only carrier to connect')
    assert.equal(probe.attempts(), 1)
    assert.equal(win.listenerTypes().includes('offline'), false)
    loop.stop()
  })
})
