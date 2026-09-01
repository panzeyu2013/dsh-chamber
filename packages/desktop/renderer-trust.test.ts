import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTrustedIpc, isExternalLinkUrl, isTrustedIpcSender, isTrustedRendererUrl } from './renderer-trust.ts'
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

test('external-link allowlist is external http(s) and mailto by scheme and origin', () => {
  // Same-origin http(s) targets are not external: opening the control plane in
  // the OS browser would only produce a preload-less duplicate shell.
  assert.equal(isExternalLinkUrl('https://example.com/a?b=c#d', origin), true)
  assert.equal(isExternalLinkUrl('http://example.com/', origin), true)
  assert.equal(isExternalLinkUrl('http://127.0.0.1:17501/', origin), true)
  assert.equal(isExternalLinkUrl('http://127.0.0.1:17500/some/path', origin), false)
  assert.equal(isExternalLinkUrl('http://127.0.0.1:17500/', origin), false)
  assert.equal(isExternalLinkUrl('mailto:user@example.com', origin), true)
  assert.equal(isExternalLinkUrl('MAILTO:user@example.com', origin), true)
  assert.equal(isExternalLinkUrl('mailto:', origin), false)
  assert.equal(isExternalLinkUrl('mailto:?subject=x', origin), true)
  assert.equal(isExternalLinkUrl('HTTPS://EXAMPLE.COM/', origin), true)
  // WHATWG URL parsing trims surrounding whitespace; padding cannot smuggle a scheme.
  assert.equal(isExternalLinkUrl('  https://example.com/  ', origin), true)
  assert.equal(isExternalLinkUrl('file:///etc/passwd', origin), false)
  assert.equal(isExternalLinkUrl('javascript:alert(1)', origin), false)
  assert.equal(isExternalLinkUrl('data:text/html,<b>hi</b>', origin), false)
  assert.equal(isExternalLinkUrl('chrome://settings', origin), false)
  assert.equal(isExternalLinkUrl('vscode://file/~/x', origin), false)
  assert.equal(isExternalLinkUrl('ssh://host', origin), false)
  assert.equal(isExternalLinkUrl('tel:+8612345678', origin), false)
  assert.equal(isExternalLinkUrl('', origin), false)
  assert.equal(isExternalLinkUrl('not a url', origin), false)
  assert.equal(isExternalLinkUrl('example.com/path', origin), false)
  assert.equal(isExternalLinkUrl('http://', origin), false)
  assert.equal(isExternalLinkUrl('//evil.com', origin), false)
  // Without a control-plane origin the predicate is scheme-only.
  assert.equal(isExternalLinkUrl('http://127.0.0.1:17500/some/path'), true)
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

test('trusted IPC rejects an untrusted sender before invoking the handler', () => {
  const trustedIpc = createTrustedIpc({
    isTrustedSender: () => false,
    isQuitting: () => false,
  })
  let called = false
  const wrapped = trustedIpc(() => { called = true })
  const event: IpcSenderLike = { sender: {}, senderFrame: { url: 'https://evil.example/' } }
  assert.throws(() => wrapped(event), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, 'ipc_sender_forbidden')
    return true
  })
  assert.equal(called, false)
})

test('trusted IPC rejects late work once application shutdown starts', () => {
  const trustedIpc = createTrustedIpc({
    isTrustedSender: () => true,
    isQuitting: () => true,
  })
  let called = false
  const wrapped = trustedIpc(() => { called = true })
  assert.throws(() => wrapped({ sender: {}, senderFrame: { url: `${origin}/` } }), (error: unknown) => {
    assert.equal((error as Error & { code?: string }).code, 'app_quitting')
    return true
  })
  assert.equal(called, false)
})

test('trusted IPC passes only invoke arguments to an accepted handler', () => {
  const trustedIpc = createTrustedIpc({
    isTrustedSender: () => true,
    isQuitting: () => false,
  })
  const seen: unknown[] = []
  const wrapped = trustedIpc((...args: unknown[]) => seen.push(...args))
  const event: IpcSenderLike = { sender: {}, senderFrame: { url: `${origin}/` } }
  wrapped(event, { id: 's1' }, 42)
  assert.deepEqual(seen, [{ id: 's1' }, 42])
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
  assert.match(source, /IPC_CHANNELS\.SSH_INSTANCES_CHANGED[\s\S]*?return projectedSaved;/)
  assert.match(source, /const statusWindow = mainWindow;[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{[\s\S]*?IPC_CHANNELS\.SSH_STATUS_CHANGED/)
  assert.match(source, /const updateWindow = mainWindow;[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{[\s\S]*?IPC_CHANNELS\.UPDATE_STATE_CHANGED/)
})

test('renderer ACK deliveries project and preload-validates the captured lifecycle proof', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('./preload.cts', import.meta.url), 'utf8')
  assert.match(main, /IPC_CHANNELS\.DEEP_LINK_INTENT[\s\S]*?sourceFingerprint: intent\.sourceFingerprint/)
  assert.match(main, /IPC_CHANNELS\.NOTIFICATION_OPEN[\s\S]*?sourceFingerprint: delivery\.payload\.sourceFingerprint/)
  assert.match(preload, /const REMOTE_SOURCE_FINGERPRINT_PATTERN = \/\^\[a-f0-9\]\{64\}\$\//)
  assert.match(preload, /validSourceFingerprint\(intent\.instanceId, intent\.sourceFingerprint\)/)
  assert.match(preload, /validSourceFingerprint\(sourceId as string, req\.sourceFingerprint\)/)
})

test('window-open and navigation fences share the external-link allowlist', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?isExternalLinkUrl\(url, rendererOrigin\)[\s\S]*?return \{ action: 'deny' \};/)
  assert.match(main, /will-navigate', \(event, url\) => \{[\s\S]*?handleUntrustedNavigation\(event, url, rendererOrigin\)/)
  assert.match(main, /will-redirect', \(event, url\) => \{[\s\S]*?handleUntrustedNavigation\(event, url, rendererOrigin\)/)
})
