import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts'

const origin = 'http://127.0.0.1:17500'

test('renderer URL trust is exact-origin and rejects lookalikes/non-http URLs', () => {
  assert.equal(isTrustedRendererUrl(`${origin}/settings?tab=connections`, origin), true)
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
