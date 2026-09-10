/**
 * node:test for the chamber apply seam (`src/client/index.ts`, design 05 §6/
 * §4): the per-entry `chamberBasePath` bound on the entry Context reaches the
 * generic RPC carrier and the exposed `handle.basePath` — no plugin config and
 * no page-global knob participate (2026-09 Batch 2 retired the config-passing
 * form). The wake-event constant is pinned here too: the shell's App layer
 * dispatches exactly this window event.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, SYSTEM_RESUME_EVENT } from '../src/client/index.ts'

interface FakeHandle {
  readonly basePath: string
  readonly rpc: { call(...args: unknown[]): unknown }
  reconnect(): void
}

function fakeContext(chamberBasePath: string | undefined): { ctx: never; handle: () => FakeHandle } {
  let handle: unknown
  return {
    ctx: {
      chamberBasePath,
      provide(name: string, value: unknown): void {
        if (name === 'connection') handle = value
      },
    } as never,
    handle: () => handle as FakeHandle,
  }
}

test('apply reads ctx.chamberBasePath into the RPC carrier and the handle', () => {
  const { ctx, handle } = fakeContext('/api/i/ssh-right')
  apply(ctx)
  assert.equal(handle().basePath, '/api/i/ssh-right')
  assert.equal(typeof handle().rpc.call, 'function')
  assert.equal(typeof handle().reconnect, 'function')
})

test('apply without a ctx base path keeps the stock no-prefix surface', () => {
  const { ctx, handle } = fakeContext(undefined)
  apply(ctx)
  assert.equal(handle().basePath, '')
})

test('the wake-event name is the canonical chamber export', () => {
  assert.equal(SYSTEM_RESUME_EVENT, 'dsh-chamber:system-resume')
})
