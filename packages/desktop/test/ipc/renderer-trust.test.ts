import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import {
  CHAMBER_PERMISSION_ALLOWLIST,
  createTrustedIpc,
  forwardFrameErrorFromElectronError,
  isAllowedBrowserDownloadUrl,
  isAllowedBrowserFrameUrl,
  isChamberPermissionGranted,
  isExternalLinkUrl,
  isTrustedIpcSender,
  isTrustedRendererUrl,
} from '../../renderer-trust.ts'
import type { IpcSenderLike } from '../../renderer-trust.ts'

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


test('T-13: a same-origin URL carrying userinfo is never the trusted shell document', () => {
  // Swift TrustGuard rejects any actual/expected userinfo; the Electron leg used
  // to accept http://u:p@127.0.0.1:port/ because WHATWG origin drops userinfo.
  // Closed in the safer direction: reject, because a credential-bearing URL is
  // never the chamber shell document and no capability is lost.
  assert.equal(isTrustedRendererUrl('http://u:p@127.0.0.1:17500/', origin), false)
  assert.equal(isTrustedRendererUrl('http://user@127.0.0.1:17500/', origin), false)
  assert.equal(isTrustedRendererUrl('http://:pass@127.0.0.1:17500/', origin), false)
  // The expected origin carrying userinfo is equally untrusted (Swift checks both).
  assert.equal(isTrustedRendererUrl(`${origin}/`, 'http://u:p@127.0.0.1:17500'), false)
  // ... and the exact shell document without userinfo stays trusted.
  assert.equal(isTrustedRendererUrl(`${origin}/`, origin), true)
  // The IPC sender predicate inherits the same strictness (main-frame userinfo
  // is rejected even when sender/identity match).
  const userinfoFrame = { url: 'http://u:p@127.0.0.1:17500/' }
  const userinfoContents = { mainFrame: userinfoFrame }
  assert.equal(isTrustedIpcSender({ sender: userinfoContents, senderFrame: userinfoFrame }, userinfoContents, origin), false)
})

test('G21 permission posture: deny-by-default with the single clipboard-sanitized-write exception', () => {
  assert.deepEqual([...CHAMBER_PERMISSION_ALLOWLIST], ['clipboard-sanitized-write'])
  assert.equal(isChamberPermissionGranted('clipboard-sanitized-write'), true)
  for (const denied of [
    'clipboard-read', 'media', 'geolocation', 'notifications', 'midi', 'midiSysex',
    'pointerLock', 'fullscreen', 'openExternal', 'display-capture', 'idle-detection', '',
  ]) {
    assert.equal(isChamberPermissionGranted(denied), false, `${denied} must stay denied`)
  }
  // main.ts wiring lock: the request handler and the permissions.query check
  // handler consume the same predicate, and no stray literal can re-introduce a
  // second posture. (The handlers cannot be imported here — main.ts loads electron.)
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.match(main, /setPermissionRequestHandler\(\(_wc, permission, callback\) =>\s*callback\(isChamberPermissionGranted\(permission\)\)\)/)
  assert.match(main, /setPermissionCheckHandler\(\(_wc, permission\) => isChamberPermissionGranted\(permission\)\)/)
  assert.doesNotMatch(main, /permission === 'clipboard-sanitized-write'/)
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
  const source = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  const start = source.indexOf('function fatalMainError(reason: unknown): void {')
  const end = source.indexOf("process.on('uncaughtException'", start)
  assert.ok(start >= 0 && end > start, 'fatal boundary remains explicit and locally reviewable')
  const body = source.slice(start, end)
  const claim = body.indexOf('fatalExceptionInProgress = true;')
  assert.ok(claim >= 0, 'fatal ownership is claimed')
  // 描述器升级为有界致命描述 describeFatalError（含 code/syscall/path/cause，
  // §22.3.1）；**顺序纪律不变**：任何 hostile host 调用都必须在 ownership 之后。
  for (const boundary of ['describeFatalError(reason)', 'noteFatalReport(', 'console.error(', 'app.exit(1)']) {
    assert.ok(body.indexOf(boundary) > claim, `${boundary} runs only after terminal ownership is claimed`)
  }
  assert.match(body, /if \(fatalExceptionInProgress\) \{[\s\S]*?try \{ process\.abort\(\); \} catch/)
  assert.match(source, /process\.on\('unhandledRejection', \(reason\) => \{\s+fatalMainError\(reason\);\s+\}\);/)
  assert.doesNotMatch(source, /process\.emit\('uncaughtException'/)
})

test('committed settings, registry and held-resume pushes use the non-throwing send boundary', () => {
  // pushSettingsChanged, the held-resume push and the updater state push live in
  // shell-core.installIpcHandlers (their send leaves go through HostEdges rendererPush with the
  // non-throwing attemptCommittedRegistryPush wrapper); the assertions read shell-core.ts. The
  // remaining push anchors (instances / status) live in the SINGLE shared assembly consumed by
  // both flavors: host-assembly.ts keeps the status push, the committed-registry push moved to
  // host-registry-transition.ts (B4-2a), so the assertion reads their union — still requiring
  // the window-liveness gate, the race re-check inside the closure and the non-throwing boundary.
  const core = readFileSync(new URL('../../shell-core.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../shell-ipc-update.ts', import.meta.url), 'utf8')
  const assembly = readFileSync(new URL('../../host-assembly.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../host-registry-transition.ts', import.meta.url), 'utf8')
  assert.match(core, /function pushSettingsChanged\(\): void \{[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{/)
  assert.match(core, /function pushHeldSystemResume[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{/)
  assert.match(assembly, /IPC_CHANNELS\.SSH_INSTANCES_CHANGED[\s\S]*?return projectedSaved;/)
  assert.match(assembly, /if \(deps\.edges\.mainWindowAlive\(\)\) \{[\s\S]*?attemptCommittedRegistryPush\(\(\) => \{[\s\S]*?IPC_CHANNELS\.SSH_STATUS_CHANGED/)
  assert.match(assembly, /if \(!deps\.edges\.mainWindowAlive\(\)\) \{\s*throw new Error\('status renderer changed before push'\)/,
    'the status push must re-check window liveness inside the closure (replaced-window race)')
  // alpha.3 review follow-up: the push is extracted into pushState so a refused (stale)
  // confirmation can re-push. The lock slices pushState's OWN body — a lazy wildcard could find
  // the three anchors in a later sibling — and pins the subscribe→pushState wiring.
  const pushStart = core.indexOf('const pushState = (updateState: UpdateState): void => {')
  assert.ok(pushStart >= 0, 'the update push must stay extracted as pushState')
  const pushEnd = core.indexOf('\n  };', pushStart)
  assert.ok(pushEnd > pushStart, 'pushState must keep a closed body')
  const pushBody = core.slice(pushStart, pushEnd)
  assert.match(pushBody, /if \(!deps\.edges\.mainWindowAlive\(\)\) return;/)
  assert.match(pushBody, /attemptCommittedRegistryPush\(\(\) => \{/)
  assert.equal((pushBody.match(/IPC_CHANNELS\.UPDATE_STATE_CHANGED/g) ?? []).length, 1)
  assert.match(core, /updater\.subscribe\(\(updateState\) => \{[\s\S]*?pushState\(updateState\)/)
})

test('renderer ACK deliveries project and preload-validates the captured lifecycle proof', () => {
  // DEEP_LINK_INTENT / NOTIFICATION_OPEN 的 send 源（drain 内投影构造）位于
  // shell-core——fingerprint 投影断言的读取源指向 shell-core.ts（payload 只带
  // 非秘密投影字段）。
  const core = readFileSync(new URL('../../shell-core.ts', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../../preload.cts', import.meta.url), 'utf8')
  assert.match(core, /IPC_CHANNELS\.DEEP_LINK_INTENT[\s\S]*?sourceFingerprint: intent\.sourceFingerprint/)
  assert.match(core, /IPC_CHANNELS\.NOTIFICATION_OPEN[\s\S]*?sourceFingerprint: delivery\.payload\.sourceFingerprint/)
  assert.match(preload, /const REMOTE_SOURCE_FINGERPRINT_PATTERN = \/\^\[a-f0-9\]\{64\}\$\//)
  assert.match(preload, /validSourceFingerprint\(intent\.instanceId, intent\.sourceFingerprint\)/)
  assert.match(preload, /validSourceFingerprint\(sourceId as string, req\.sourceFingerprint\)/)
})

test('window-open and navigation fences share the external-link allowlist', () => {
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.match(main, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*?isExternalLinkUrl\(url, rendererOrigin\)[\s\S]*?return \{ action: 'deny' \};/)
  assert.match(main, /will-navigate', \(event, url\) => \{[\s\S]*?handleUntrustedNavigation\(event, url, rendererOrigin\)/)
  // v2: will-redirect fires for subframes too. A framed page's redirect must use
  // the browser frame gate (cancel non-web/credentialed targets) and NEVER the
  // main-document external-open fence; only the main frame keeps the shell fence.
  assert.match(main, /will-redirect', \(details\) => \{[\s\S]*?if \(!details\.isMainFrame\) \{[\s\S]*?isAllowedBrowserFrameUrl\(details\.url\)[\s\S]*?details\.preventDefault\(\);[\s\S]*?handleUntrustedNavigation\(details, details\.url, rendererOrigin\)/)
})

test('v2 browser child-frame gate: any http(s) subframe, credentials/non-web refused, preview carriers kept', () => {
  // Upstream ui-sidebar-browser iframe behavior: the embedded browser browses the
  // web, so main must not narrow it back to the loopback/alias set.
  for (const url of [
    'http://127.0.0.1:5173/', 'https://localhost:8443/app', 'http://127.0.0.2:51234/x?y=1',
    'https://example.com/', 'https://example.com:8443/a?b=1', 'http://192.168.1.2/',
    'blob:http://127.0.0.1:17500/uuid', 'about:blank', 'about:srcdoc',
  ]) {
    assert.equal(isAllowedBrowserFrameUrl(url), true, url)
  }
  // Still-refused classes: non-web schemes, credential URLs, malformed targets.
  for (const url of [
    'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'chrome://settings',
    'ftp://example.com/', 'http://user:pass@127.0.0.1:5173/', 'https://user@example.com/',
    'about:config', 'http://127.0.0.1:17500.evil.example/', 'not a url', '',
  ]) {
    assert.equal(isAllowedBrowserFrameUrl(url), false, url)
  }
})

test('v2 download gate: only the shell origin blob exports may be saved', () => {
  assert.equal(isAllowedBrowserDownloadUrl('blob:http://127.0.0.1:17500/uuid', origin), true)
  assert.equal(isAllowedBrowserDownloadUrl('blob:http://127.0.0.1:17501/uuid', origin), false)
  assert.equal(isAllowedBrowserDownloadUrl('blob:https://example.com/uuid', origin), false)
  assert.equal(isAllowedBrowserDownloadUrl('http://127.0.0.1:17500/file.txt', origin), false)
  assert.equal(isAllowedBrowserDownloadUrl('data:text/plain,x', origin), false)
  assert.equal(isAllowedBrowserDownloadUrl('not a url', origin), false)
})

test('did-fail-load classification for the v2 frameError projection', () => {
  assert.equal(forwardFrameErrorFromElectronError(-3), null, 'superseded navigation is not a failure')
  assert.equal(forwardFrameErrorFromElectronError(-27), 'blocked_by_response')
  for (const code of [-200, -202, -299]) assert.equal(forwardFrameErrorFromElectronError(code), 'certificate_error')
  assert.equal(forwardFrameErrorFromElectronError(-105), 'load_failed')
  assert.equal(forwardFrameErrorFromElectronError(Number.NaN), null)
})

test('main.ts wires the v2 child-frame / download / did-fail-load gates', () => {
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.match(main, /will-frame-navigate', \(details\) => \{\s*if \(!details\.isMainFrame && !isAllowedBrowserFrameUrl\(details\.url\)\) details\.preventDefault\(\);/)
  // W-15: a local-loopback child frame has no forward record, so the same
  // did-fail-load observation is routed to the bounded local store; alias frames
  // keep the record projection (an empty validatedURL falls back to the exact
  // failing child frame). A committed child navigation clears both.
  assert.match(main, /did-fail-load', \(_event, errorCode, _description, validatedURL, isMainFrame, frameProcessId, frameRoutingId\) => \{\s*if \(isMainFrame\) return;[\s\S]*?framesInSubtree\.find\([\s\S]*?if \(resolvedUrl === ''\) return;[\s\S]*?const frameError = forwardFrameErrorFromElectronError\(errorCode\);[\s\S]*?if \(isLocalBrowserFrameUrl\(resolvedUrl\)\) noteLocalFrameError\(resolvedUrl, frameError\);[\s\S]*?else noteForwardFrameError\(resolvedUrl, frameError\);/)
  assert.match(main, /did-frame-navigate', \(_event, url, httpResponseCode, _httpStatusText, isMainFrame\) => \{\s*if \(isMainFrame \|\| httpResponseCode < 200 \|\| httpResponseCode >= 400\) return;\s*if \(isLocalBrowserFrameUrl\(url\)\) noteLocalFrameError\(url, null\);\s*else noteForwardFrameError\(url, null\);/);
  assert.match(main, /will-download', \(event, item\) => \{\s*if \(!isAllowedBrowserDownloadUrl\(item\.getURL\(\), rendererOrigin\)\) event\.preventDefault\(\);/)
})

test('v2 CSP enable chain: only the two desktop entries pass frameSources', async () => {
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  const sidecar = readFileSync(new URL('../../sidecar-entry.ts', import.meta.url), 'utf8')
  assert.match(main, /frameSources: \[\.\.\.forwardFrameSources\(\), 'http:', 'https:'\]/)
  assert.match(sidecar, /frameSources: \[\.\.\.forwardFrameSources\(\), 'http:', 'https:'\]/)
  // gateway / cli / standalone must keep the v1 short claim (no opt-in).
  const roots = ['../../../gateway/src', '../../../cli/src']
  for (const root of roots) {
    const dir = new URL(root + '/', import.meta.url)
    for (const entry of readdirSync(dir)) {
      const file = new URL(entry, dir)
      if (!entry.endsWith('.ts')) continue
      assert.equal(readFileSync(file, 'utf8').includes('frameSources'), false, root + '/' + entry + ' must not pass frameSources')
    }
  }
})

test('v2 revoke funnel is wired exactly once in shell-core.onRendererLifecycle', () => {
  const shellCore = readFileSync(new URL('../../shell-core.ts', import.meta.url), 'utf8')
  const onLifecycle = shellCore.slice(shellCore.indexOf('export function onRendererLifecycle'))
  assert.match(onLifecycle, /revokeForwardRenderer\(event\)/)
  // did-finish-load must not revoke (it renders, it does not start a document);
  // the guard lives in the funnel implementation, not the shell-core entry.
  const openIn = readFileSync(new URL('../../shell-ipc-open-in.ts', import.meta.url), 'utf8')
  assert.match(openIn, /if \(event !== 'did-start-loading' && event !== 'crashed' && event !== 'closed'\) return/)
})

test('v2 forward revoke runs only for a top-level document load, never an iframe load', () => {
  // Electron emits did-start-loading for child-frame loads too; without the
  // main-frame guard a remote-loopback attach would revoke its own SSH forward
  // immediately (W-14b caught this: alias listener closed right after bind).
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.match(
    main,
    /did-start-loading', \(\) => \{\s*if \(mainWindow !== win\) return;\s*\/\/[\s\S]*?if \(!win\.webContents\.isLoadingMainFrame\(\)\) return;\s*onRendererLifecycle\('did-start-loading'\);/,
  )
})