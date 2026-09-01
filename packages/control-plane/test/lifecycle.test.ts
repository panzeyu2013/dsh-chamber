import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlPlane } from '../src/index.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const reaped = { reclaimed: 0, kept: 0, errors: [] as string[] }
const stateDir = (): string => mkdtempSync(join(tmpdir(), 'dsh-plane-lifecycle-'))

test('concurrent start calls share one reaper/bind flight', async () => {
  const dir = stateDir()
  let release!: () => void
  let entered!: () => void
  let calls = 0
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const plane = createControlPlane({
    port: 0,
    stateDir: dir,
    logger: silentLogger,
    reaper: async () => {
      calls += 1
      entered()
      await gate
      return reaped
    },
  })
  try {
    const first = plane.start()
    const second = plane.start()
    await enteredPromise
    assert.equal(calls, 1)
    release()
    await Promise.all([first, second])
    assert.ok((plane.port ?? 0) > 0)
  } finally {
    release()
    await plane.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bind failure leaves start retryable', async () => {
  const blocker = createServer()
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const port = (blocker.address() as AddressInfo).port
  const dir = stateDir()
  const plane = createControlPlane({ port, stateDir: dir, logger: silentLogger, reaper: async () => reaped })
  try {
    await assert.rejects(plane.start(), (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE')
    assert.equal(plane.port, null)
    await new Promise<void>(resolve => blocker.close(() => resolve()))
    await plane.start()
    assert.equal(plane.port, port)
  } finally {
    if (blocker.listening) await new Promise<void>(resolve => blocker.close(() => resolve()))
    await plane.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stop invalidates an in-flight start and a start requested during stop begins the next lifecycle', async () => {
  const dir = stateDir()
  let release!: () => void
  let entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const plane = createControlPlane({
    port: 0,
    stateDir: dir,
    logger: silentLogger,
    reaper: async () => {
      entered()
      await gate
      return reaped
    },
  })
  try {
    const starting = plane.start()
    await enteredPromise
    const stopping = plane.stop()
    const restarting = plane.start()
    release()
    await assert.rejects(starting, /start cancelled by stop/)
    await stopping
    await restarting
    assert.ok((plane.port ?? 0) > 0)
  } finally {
    release()
    await plane.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
