import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTrustedIpc, isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts'
import type { IpcSenderLike } from './renderer-trust.ts'

const origin = 'http://127.0.0.1:17500'

test('renderer URL trust is the exact shell document, not the whole control-plane origin', () => {
  assert.equal(isTrustedRendererUrl(`${origin}/`, origin), true)
  assert.equal(isTrustedRendererUrl(`${origin}/#settings`, origin), true)
  assert.equal(isTrustedRendererUrl(`${origin}/settings?tab=connections`, origin), false)
  assert.equal(isTrustedRendererUrl(`${origin}/?next=/`, origin), false)
  assert.equal(isTrustedRendererUrl(`${origin}/api/i/ssh-evil/landing.html`, origin), false)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1:17501/', origin), false)
  assert.equal(isTrustedRendererUrl('http://127.0.0.1.evil.example:17500/', origin), false)
  assert.equal(isTrustedRendererUrl('https://evil.example/', origin), false)
  assert.equal(isTrustedRendererUrl('file:///tmp/index.html', origin), false)
  assert.equal(isTrustedRendererUrl('not a url', origin), false)
})

test('IPC trust requires the current webContents main frame and trusted URL', () => {
  const mainFrame = { url: `${origin}/` }
  const webContents = { mainFrame }
  assert.equal(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, webContents, origin), true)
  assert.equal(isTrustedIpcSender({ sender: {}, senderFrame: mainFrame }, webContents, origin), false)
  assert.equal(isTrustedIpcSender({ sender: webContents, senderFrame: { url: `${origin}/child` } }, webContents, origin), false)
  assert.equal(isTrustedIpcSender({ sender: webContents, senderFrame: null }, webContents, origin), false)
  mainFrame.url = 'https://evil.example/'
  assert.equal(isTrustedIpcSender({ sender: webContents, senderFrame: mainFrame }, webContents, origin), false)
})

test('createTrustedIpc: an untrusted sender throws ipc_sender_forbidden and never reaches the handler', () => {
  const trustedIpc = createTrustedIpc({
    isTrustedSender: () => false,
    isQuitting: () => false,
  })
  let called = false
  const wrapped = trustedIpc(() => { called = true; return 'ok' })
  const event: IpcSenderLike = { sender: {}, senderFrame: { url: 'https://evil.example/' } }
  assert.throws(() => wrapped(event, 1, 'x'), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, 'ipc_sender_forbidden')
    return true
  })
  assert.equal(called, false, 'the handler must never run for an untrusted sender')
})

test('createTrustedIpc: a quitting app throws app_quitting even for a trusted sender', () => {
  const trustedIpc = createTrustedIpc({
    isTrustedSender: () => true,
    isQuitting: () => true,
  })
  let called = false
  const wrapped = trustedIpc(() => { called = true; return 'ok' })
  assert.throws(() => wrapped({ sender: {}, senderFrame: { url: 'http://127.0.0.1:17500/' } }), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, 'app_quitting')
    return true
  })
  assert.equal(called, false, 'the handler must never run while quitting')
})

test('createTrustedIpc: a trusted sender while not quitting reaches the handler with the invoke args (event not passed)', () => {
  const trustedIpc = createTrustedIpc({
    isTrustedSender: () => true,
    isQuitting: () => false,
  })
  const seen: unknown[] = []
  const wrapped = trustedIpc((...args: unknown[]) => {
    seen.push(...args)
    return { ok: true }
  })
  const event: IpcSenderLike = { sender: {}, senderFrame: { url: 'http://127.0.0.1:17500/' } }
  const result = wrapped(event, { id: 's1' }, 42)
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(seen, [{ id: 's1' }, 42], 'only the invoke args reach the handler — never the event object')
})

test('createTrustedIpc: the sender predicate is evaluated per invocation (window may appear/disappear)', () => {
  let trusted = true
  const trustedIpc = createTrustedIpc({
    isTrustedSender: () => trusted,
    isQuitting: () => false,
  })
  const wrapped = trustedIpc(() => 'ok')
  assert.equal(wrapped({ sender: {}, senderFrame: { url: 'x' } }), 'ok')
  trusted = false
  assert.throws(() => wrapped({ sender: {}, senderFrame: { url: 'x' } }), /forbidden IPC sender/)
  trusted = true
  assert.equal(wrapped({ sender: {}, senderFrame: { url: 'x' } }), 'ok', 'a later trusted invocation is accepted again')
})
