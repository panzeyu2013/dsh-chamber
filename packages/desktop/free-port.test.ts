/**
 * findFreePort tests: backoff over the dev control-plane port range.
 * Pure node:net — no Electron binary involved.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { findFreePort } from './free-port.ts'

/** Bind a real server on 127.0.0.1 and return its port (listening stays on). */
function occupyPort(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

test('returns start when the base port is free', async () => {
  // Use a just-freed ephemeral port as base instead of the fixed dev default
  // (17520): a dev instance running during the test would otherwise occupy it
  // and turn this into a spurious backoff failure.
  const ephemeral = await occupyPort()
  const base = ephemeral.port
  await ephemeral.close()
  const first = await findFreePort(base, { attempts: 1 })
  assert.equal(first, base)
})

test('backs off past an occupied port', async () => {
  const occupied = await occupyPort()
  try {
    const first = await findFreePort(occupied.port, { attempts: 3 })
    assert.equal(first, occupied.port + 1)
  } finally {
    await occupied.close()
  }
})

test('rejects when the whole range is occupied', async () => {
  const first = await occupyPort()
  try {
    await assert.rejects(
      () => findFreePort(first.port, { attempts: 1 }),
      (err: unknown) => err instanceof RangeError && /no free port/.test(err.message),
    )
  } finally {
    await first.close()
  }
})

test('validates start and attempts', async () => {
  await assert.rejects(() => findFreePort(-1), RangeError)
  // 0 means "OS-assigned ephemeral" and is not a probe base.
  await assert.rejects(() => findFreePort(0), RangeError)
  await assert.rejects(() => findFreePort(70000), RangeError)
  await assert.rejects(() => findFreePort(17520, { attempts: 0 }), RangeError)
})
