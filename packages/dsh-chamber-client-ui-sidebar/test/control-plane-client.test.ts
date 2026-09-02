import { test } from 'node:test'
import assert from 'node:assert/strict'
import { controlPlaneUrl } from '../src/shared/control-plane-client.ts'

test('control-plane requests use the shell page origin before the async bridge', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://127.0.0.1:17520' },
      dshChamber: { controlPlaneUrl: 'http://127.0.0.1:17500' },
    },
  })

  try {
    assert.equal(controlPlaneUrl(), 'http://127.0.0.1:17520')
  } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', previous)
  }
})
