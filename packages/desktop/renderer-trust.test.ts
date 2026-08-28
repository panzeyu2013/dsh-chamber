import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts'

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

test('fatal main-process boundary claims ownership before every hostile host call', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function fatalMainError(reason: unknown): void {')
  const end = source.indexOf("process.on('uncaughtException'", start)
  assert.ok(start >= 0 && end > start, 'fatal boundary remains explicit and locally reviewable')
  const body = source.slice(start, end)
  const claim = body.indexOf('fatalExceptionInProgress = true;')
  assert.ok(claim >= 0, 'fatal ownership is claimed')
  for (const boundary of ['describeUnknownError(reason)', 'console.error(', 'app.exit(1)']) {
    assert.ok(body.indexOf(boundary) > claim, `${boundary} runs only after terminal ownership is claimed`)
  }
  assert.match(body, /if \(fatalExceptionInProgress\) \{[\s\S]*?try \{ process\.abort\(\); \} catch/)
  assert.match(source, /process\.on\('unhandledRejection', \(reason\) => \{\s+fatalMainError\(reason\);\s+\}\);/)
  assert.doesNotMatch(source, /process\.emit\('uncaughtException'/)
})

test('committed settings, registry and held-resume pushes use the non-throwing send boundary', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(source, /function pushSettingsChanged\(\): void \{[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{/)
  assert.match(source, /function pushHeldSystemResume\([\s\S]*?attemptCommittedRegistryPush\(\(\) => \{/)
  assert.match(source, /desktop_ssh_instances_changed[\s\S]*?return projectedSaved;/)
  assert.match(source, /const statusWindow = mainWindow;[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{[\s\S]*?desktop_ssh_status_changed/)
  assert.match(source, /const updateWindow = mainWindow;[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{[\s\S]*?dsh-chamber:update-state-changed/)
})

test('renderer ACK deliveries project and preload-validates the captured lifecycle proof', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('./preload.cts', import.meta.url), 'utf8')
  assert.match(main, /dsh-chamber:deep-link-intent[\s\S]*?sourceFingerprint: intent\.sourceFingerprint/)
  assert.match(main, /dsh-chamber:notification-open[\s\S]*?sourceFingerprint: delivery\.payload\.sourceFingerprint/)
  assert.match(preload, /const REMOTE_SOURCE_FINGERPRINT_PATTERN = \/\^\[a-f0-9\]\{64\}\$\//)
  assert.match(preload, /validSourceFingerprint\(intent\.instanceId, intent\.sourceFingerprint\)/)
  assert.match(preload, /validSourceFingerprint\(sourceId as string, req\.sourceFingerprint\)/)
})
