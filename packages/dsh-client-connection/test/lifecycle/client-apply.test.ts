/**
 * node:test for the chamber apply seam (`src/client/index.ts`, design 05 §6/§4):
 * the per-entry `chamberBasePath` bound on the entry Context reaches the generic
 * RPC carrier as its URL prefix — no plugin config and no page-global knob
 * participate. The wake-event
 * constant is pinned here too: the shell's App layer dispatches exactly this
 * window event. The fixture path is locked here as well: a `?fixture` page
 * URL must not swap the production transport, and the scaffold file
 * must stay absent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { apply, SYSTEM_RESUME_EVENT } from '../../src/client/index.ts'

interface FakeHandle {
  readonly rpc: { call(...args: unknown[]): Promise<unknown> }
  reconnect(): void
}

function fakeContext(chamberBasePath: string | undefined): { ctx: never; handle: () => FakeHandle } {
  let handle: unknown
  const ctx = {
    chamberBasePath,
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
  globalThis.fetch = (async (input: URL, init: RequestInit): Promise<Response> => {
    url = String(input)
    const request = JSON.parse(String(init.body)) as { rpcId: string }
    return {
      ok: true,
      json: async () => ({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: null } }),
    } as unknown as Response
  }) as unknown as typeof globalThis.fetch
  try {
    await handle.rpc.call('/api', 'session/follow', { args: {} })
  } finally {
    globalThis.fetch = originalFetch
  }
  return new URL(url).pathname
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
