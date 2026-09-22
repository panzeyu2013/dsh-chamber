/**
 * updater.ts (design 11) part 1: release-page allowlist, the controller state
 * machine over the injected fake electron-updater (check/download/error/
 * subscribe, install-shape gates, single-flight) and start(). Pure Node.
 * Sibling part: updater-restart-install.test.ts. The cache-maintenance suite was
 * merged in as part 1b (round-2 trim).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { betaReleaseDownloadBase, cachedUpdateVersion, cleanupStaleUpdateCache, compareChamberVersions, createUpdateController, isAllowedReleaseUrl, LINUX_UPDATE_UNSUPPORTED_REASON, openReleasePage, probeLinuxAppImage, resolveGithubBetaFeed, resolveUpdaterCacheDir, sanitizeErrorText, updaterCacheDirNameFromYaml, updaterCacheRoot } from '../../updater.ts'
import type { UpdateController, UpdatePhase, UpdateState } from '../../updater.ts'
import { FakeAutoUpdater, makeController, waitFor } from '../support/updater-harness.ts'
test('release-page allowlist pins scheme/origin/repository and rejects encoded traversal or userinfo', () => {
  assert.equal(isAllowedReleaseUrl('https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.0'), true)
  assert.equal(isAllowedReleaseUrl('http://github.com/panzeyu2013/dsh-chamber/releases'), false)
  assert.equal(isAllowedReleaseUrl('https://evil.example/panzeyu2013/dsh-chamber/releases'), false)
  assert.equal(isAllowedReleaseUrl('https://user:pass@github.com/panzeyu2013/dsh-chamber/releases'), false)
  assert.equal(isAllowedReleaseUrl('https://github.com/panzeyu2013/dsh-chamber/%2e%2e/%2e%2e/settings'), false)
  assert.equal(isAllowedReleaseUrl('https://github.com/panzeyu2013/dsh-chamber/..%252f..%252fsettings'), false)
  assert.equal(isAllowedReleaseUrl(null), false)
})
test('openReleasePage awaits the OS handoff and reports rejection instead of false success', async () => {
  const url = 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.0'
  let opened: string | null = null
  assert.deepEqual(await openReleasePage(url, async value => { opened = value }), { ok: true })
  assert.equal(opened, url)
  assert.deepEqual(await openReleasePage(url, async () => { throw new Error('/private/path') }), {
    ok: false,
    error: 'open release page failed',
  })
  opened = null
  assert.deepEqual(await openReleasePage('https://evil.example/', async value => { opened = value }), {
    ok: false,
    error: 'url not allowed',
  })
  assert.equal(opened, null, 'a refused URL never reaches the OS')
})


function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}


function collect(controller: UpdateController): UpdateState[] {
  const states: UpdateState[] = []
  controller.subscribe(state => states.push(state))
  return states
}
test('initial state is idle with the injected version/channel (win32: no install block)', () => {
  const { controller } = makeController()
  const state = controller.state()
  assert.equal(state.phase, 'idle')
  assert.equal(state.currentVersion, '0.1.5')
  assert.equal(state.latestVersion, null)
  assert.equal(state.channel, 'stable')
  assert.equal(state.downloadPercent, null)
  assert.equal(state.releaseUrl, null)
  assert.equal(state.installBlockedReason, null)
  assert.equal(state.error, null)
})
test('installBlockedReason follows platform/install shape (linux AppImage vs other shapes, darwin dev)', () => {
  // Linux packaged but not from a writable AppImage (dev/unpacked/deb): inert.
  const linuxUnpacked = makeController({ deps: { platform: 'linux', app: { isPackaged: true }, linuxAppImage: null } }).controller.state()
  assert.equal(linuxUnpacked.installBlockedReason, LINUX_UPDATE_UNSUPPORTED_REASON)
  const linuxDev = makeController({ deps: { platform: 'linux', app: { isPackaged: false } } }).controller.state()
  assert.equal(linuxDev.installBlockedReason, LINUX_UPDATE_UNSUPPORTED_REASON)
  // dev + a NON-NULL probe stays blocked: only the packaged shape opens the gate.
  const linuxDevWithProbe = makeController({
    deps: { platform: 'linux', app: { isPackaged: false }, linuxAppImage: { path: '/opt/dsh-chamber.AppImage' } },
  }).controller.state()
  assert.equal(linuxDevWithProbe.installBlockedReason, LINUX_UPDATE_UNSUPPORTED_REASON)
  // Linux packaged AppImage: the shape gate passes — updates are possible.
  const linuxAppImage = makeController({
    deps: { platform: 'linux', app: { isPackaged: true }, linuxAppImage: { path: '/opt/dsh-chamber.AppImage' } },
  }).controller.state()
  assert.equal(linuxAppImage.installBlockedReason, null)
  const darwinDev = makeController({ deps: { platform: 'darwin', app: { isPackaged: false } } }).controller.state()
  assert.equal(darwinDev.installBlockedReason, 'development build')
})
test('probeLinuxAppImage requires an AppImage launch shape with an absolute regular file in a writable parent', () => {
  const mountExec = '/tmp/.mount_dsh-chamberAbC123/dsh-chamber'
  const extractExec = '/tmp/appimage_extracted_a119dd1b0/dsh-chamber'
  const file = () => ({ isFile: () => true })
  const notFile = () => ({ isFile: () => false })
  const ok = { access: () => {} }
  const base = { env: { APPIMAGE: '/opt/dsh-chamber.AppImage' }, stat: file, ...ok }
  assert.deepEqual(probeLinuxAppImage({ ...base, execPath: mountExec }), { path: '/opt/dsh-chamber.AppImage' })
  assert.deepEqual(probeLinuxAppImage({ ...base, execPath: extractExec }), { path: '/opt/dsh-chamber.AppImage' })
  // Unpacked-dir / dev shapes never open the gate, even with a stale inherited
  // APPIMAGE (quit-install must never unlink a foreign file).
  assert.equal(probeLinuxAppImage({ ...base, execPath: '/opt/dsh-chamber/linux-unpacked/dsh-chamber' }), null)
  assert.equal(probeLinuxAppImage({ ...base, execPath: '/home/user/bin/dsh-chamber' }), null)
  // Missing / relative / non-file APPIMAGE → null.
  assert.equal(probeLinuxAppImage({ env: {}, stat: file, ...ok, execPath: mountExec }), null)
  assert.equal(probeLinuxAppImage({ env: { APPIMAGE: '' }, stat: file, ...ok, execPath: mountExec }), null)
  assert.equal(probeLinuxAppImage({ env: { APPIMAGE: 'dsh-chamber.AppImage' }, stat: file, ...ok, execPath: mountExec }), null)
  assert.equal(probeLinuxAppImage({ env: { APPIMAGE: '/opt/x' }, stat: notFile, ...ok, execPath: mountExec }), null)
  // stat failure → null.
  assert.equal(
    probeLinuxAppImage({ env: { APPIMAGE: '/opt/x' }, stat: () => { throw new Error('ENOENT') }, ...ok, execPath: mountExec }),
    null,
  )
  // Parent-dir write denied → null (AppImageUpdater moves INTO the parent).
  assert.equal(
    probeLinuxAppImage({
      env: { APPIMAGE: '/opt/dsh-chamber.AppImage' },
      stat: file,
      access: () => { throw new Error('EACCES') },
      execPath: mountExec,
    }),
    null,
  )
  // File writable but parent read-only → null (the operative permission).
  assert.equal(
    probeLinuxAppImage({
      env: { APPIMAGE: '/opt/dsh-chamber.AppImage' },
      stat: file,
      access: (target, _mode) => {
        if (String(target).endsWith('.AppImage')) return
        throw new Error('EACCES')
      },
      execPath: mountExec,
    }),
    null,
  )
})
test('contract invariants are asserted on the injected fake (stable channel + dev app)', () => {
  const { fake } = makeController()
  assert.equal(fake.autoDownload, false, 'autoDownload must be false (design 11: downloads only after user confirmation)')
  assert.equal(fake.autoInstallOnAppQuit, true, 'autoInstallOnAppQuit must be true (install on quit)')
  assert.equal(fake.allowPrerelease, false, 'stable channel + stable version: no prereleases')
  assert.equal(fake.allowDowngrade, false, 'no-silent-downgrade invariant (design 11 §5)')
  assert.equal(fake.forceDevUpdateConfig, true, 'dev app: the dev feed is force-enabled')
  assert.deepEqual(fake.feedUrl, { provider: 'github', owner: 'panzeyu2013', repo: 'dsh-chamber' })
  assert.equal(fake.channel, null, 'stable: no channel assignment')
})
test('packaged app: the dev feed is NOT force-enabled (app-update.yml bakes the channel)', () => {
  const { fake } = makeController({ deps: { app: { isPackaged: true } } })
  assert.equal(fake.forceDevUpdateConfig, false)
  assert.equal(fake.feedUrl, null)
})
test('beta env opt-in: channel + allowPrerelease set, allowDowngrade re-asserted AFTER the channel assignment', () => {
  const { fake, controller } = makeController({ env: { DSH_CHAMBER_UPDATE_CHANNEL: 'beta' } })
  assert.equal(controller.state().channel, 'beta')
  assert.equal(fake.channel, 'beta')
  assert.equal(fake.allowPrerelease, true, 'beta needs allowPrerelease (design 11 §4)')
  // electron-updater's channel setter RESETS allowDowngrade to true — the
  // controller must re-assert false after any channel assignment (§5).
  assert.equal(fake.allowDowngrade, false)
})
test('a prerelease running version is intrinsically pinned to the beta channel', () => {
  const { fake, controller } = makeController({ version: '0.2.0-beta.1' })
  assert.equal(controller.state().channel, 'beta')
  assert.equal(fake.allowPrerelease, true)
  assert.equal(fake.channel, 'beta')
})
test('beta release discovery selects numeric beta.10 over beta.2 and rejects non-canonical tags', () => {
  assert.equal(betaReleaseDownloadBase([
    { tag_name: 'v9.0.0', draft: false, prerelease: false },
    { tag_name: 'v0.2.0-beta.2', draft: false, prerelease: true },
    { tag_name: 'v0.2.0-beta.99', draft: true, prerelease: true },
    { tag_name: '0.2.0-beta.100', draft: false, prerelease: true },
    { tag_name: 'v0.2.0-beta.10', draft: false, prerelease: true },
    { tag_name: 'v0.2.0-beta.11/../../latest', draft: false, prerelease: true },
  ]), 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0-beta.10/')
  assert.throws(() => betaReleaseDownloadBase([
    { tag_name: 'v0.2.0', draft: false, prerelease: false },
  ]), /no published beta release/)
})
test('beta discovery uses only the bounded releases-list API', async () => {
  let requestedUrl = ''
  const feed = await resolveGithubBetaFeed(async (input, init) => {
    requestedUrl = String(input)
    assert.ok(init?.signal instanceof AbortSignal)
    return {
      ok: true,
      status: 200,
      json: async () => [{ tag_name: 'v0.2.0-beta.3', draft: false, prerelease: true }],
    } as Response
  })
  assert.equal(requestedUrl, 'https://api.github.com/repos/panzeyu2013/dsh-chamber/releases?per_page=100')
  assert.equal(feed, 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0-beta.3/')
  assert.doesNotMatch(requestedUrl + feed, /\/latest(?:[./?]|$)|latest[-.]\w+\.yml/)
})
test('beta check switches to an exact generic beta feed and never offers the GitHub latest fallback', async () => {
  let resolutions = 0
  const { fake, controller } = makeController({
    version: '0.2.0-beta.7',
    deps: {
      resolveBetaFeed: async () => {
        resolutions += 1
        return 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0-beta.8/'
      },
    },
  })
  await controller.checkNow()
  assert.equal(resolutions, 1)
  assert.equal(fake.checkCalls, 1)
  assert.deepEqual(fake.feedUrl, {
    provider: 'generic',
    url: 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0-beta.8/',
    channel: 'beta',
  })
  assert.equal(fake.channel, 'beta')
  assert.equal(fake.allowDowngrade, false)
})
test('beta discovery failure is fail-closed before updater check; stable never invokes beta discovery', async () => {
  const beta = makeController({
    version: '0.2.0-beta.3',
    deps: { resolveBetaFeed: async () => { throw new Error('beta feed unavailable') } },
  })
  await beta.controller.checkNow()
  assert.equal(beta.fake.checkCalls, 0)
  assert.equal(beta.controller.state().phase, 'error')
  assert.match(beta.controller.state().error ?? '', /beta feed unavailable/)

  let stableResolutions = 0
  const stable = makeController({
    version: '0.2.0',
    deps: { resolveBetaFeed: async () => { stableResolutions += 1; throw new Error('must not run') } },
  })
  await stable.controller.checkNow()
  assert.equal(stableResolutions, 0)
  assert.equal(stable.fake.checkCalls, 1)
  assert.equal(stable.fake.channel, null)
  assert.deepEqual(stable.fake.feedUrl, { provider: 'github', owner: 'panzeyu2013', repo: 'dsh-chamber' })
})
test('plain-node beta discovery refuses at the electron net.fetch guard instead of requiring electron (4.5)', async () => {
  // The default resolver is the only path that touches the real `electron`
  // specifier; outside the Electron runtime it must fail loudly (the former
  // code could trigger a ~100MB binary download) instead of silently falling
  // back to globalThis.fetch.
  const { fake, controller } = makeController({ version: '0.2.0-beta.3' })
  await controller.checkNow()
  assert.equal(fake.checkCalls, 0, 'the beta feed was never resolved — no updater check may run')
  assert.equal(controller.state().phase, 'error')
  assert.match(controller.state().error ?? '', /electron net\.fetch is unavailable outside the Electron runtime/)
})
test('checking-for-update transitions to checking and clears error', () => {
  const { fake, controller } = makeController()
  const states = collect(controller)
  fake.emit('checking-for-update')
  const state = controller.state()
  assert.equal(state.phase, 'checking')
  assert.equal(state.error, null)
  assert.equal(states.at(-1)?.phase, 'checking')
})
test('update-available transitions to available with latestVersion/releaseUrl and null progress', () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  const state = controller.state()
  assert.equal(state.phase, 'available')
  assert.equal(state.latestVersion, '0.2.0')
  assert.equal(state.releaseUrl, 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.0')
  assert.equal(state.downloadPercent, null)
  assert.equal(state.error, null)
})
test('download-progress transitions to downloading with the percent', () => {
  const { fake, controller } = makeController()
  fake.emit('download-progress', { percent: 42 })
  const state = controller.state()
  assert.equal(state.phase, 'downloading')
  assert.equal(state.downloadPercent, 42)
})
test('update-downloaded transitions to downloaded with 100% and the version', () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.emit('update-downloaded', { version: '0.2.0' })
  const state = controller.state()
  assert.equal(state.phase, 'downloaded')
  assert.equal(state.latestVersion, '0.2.0')
  assert.equal(state.downloadPercent, 100)
})
test('update-not-available transitions to up-to-date and clears latestVersion/releaseUrl', () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.emit('update-not-available')
  const state = controller.state()
  assert.equal(state.phase, 'up-to-date')
  assert.equal(state.latestVersion, null)
  assert.equal(state.releaseUrl, null)
})
test('error event: phase error, message sanitized, latestVersion KEPT (download-retry semantics)', () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.emit('error', new Error('Cannot read /Users/example/Library/Caches/dsh-chamber-updater/x'))
  const state = controller.state()
  assert.equal(state.phase, 'error')
  assert.equal(state.error, 'Cannot read [path]')
  assert.ok(!state.error!.includes('/Users/'), 'no path material may reach the projection')
  assert.equal(state.latestVersion, '0.2.0', 'a download-side error keeps latestVersion for the retry path')
})
test('subscribe pushes every transition and unsubscribe stops them', () => {
  const { fake, controller } = makeController()
  const seen: UpdatePhase[] = []
  const unsubscribe = controller.subscribe(state => seen.push(state.phase))
  fake.emit('checking-for-update')
  fake.emit('update-available', { version: '0.2.0' })
  assert.deepEqual(seen, ['checking', 'available'])
  unsubscribe()
  fake.emit('update-not-available')
  assert.deepEqual(seen, ['checking', 'available'], 'an unsubscribed listener must not be called')
})
test('checkNow refuses loudly on linux non-AppImage shapes without touching the fake', async () => {
  const { fake, controller } = makeController({ deps: { platform: 'linux', linuxAppImage: null } })
  const result = await controller.checkNow()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, LINUX_UPDATE_UNSUPPORTED_REASON)
  assert.equal(fake.checkCalls, 0)
})
test('checkNow runs the shared check path on a linux AppImage build (shape gate open)', async () => {
  const { fake, controller } = makeController({
    deps: { platform: 'linux', app: { isPackaged: true }, linuxAppImage: { path: '/opt/dsh-chamber.AppImage' } },
  })
  const result = await controller.checkNow()
  assert.equal(result.ok, true)
  assert.equal(fake.checkCalls, 1, 'AppImage linux must reach electron-updater like mac/win')
})
test('checkNow is a no-op once a download completed (downloaded is final)', async () => {
  const { fake, controller } = makeController()
  fake.emit('update-downloaded', { version: '0.2.0' })
  const result = await controller.checkNow()
  // A gate no-op still resolves {ok:true}: the renderer judges the state push.
  assert.equal(result.ok, true)
  assert.equal(fake.checkCalls, 0, 'runCheck must not start a re-check in the downloaded state')
  assert.equal(controller.state().phase, 'downloaded')
})
test('checkNow single-flights an in-flight check (second call is a no-op)', async () => {
  const { fake, controller } = makeController()
  const gate = deferred<void>()
  fake.checkResult = gate.promise
  const first = controller.checkNow()
  assert.equal(fake.checkCalls, 1)
  const second = await controller.checkNow()
  assert.equal(second.ok, true)
  assert.equal(fake.checkCalls, 1, 'no second checkForUpdates while one is in flight')
  gate.resolve()
  await first
})
test('checkNow is a no-op while a download is in flight', async () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  const gate = deferred<void>()
  fake.downloadResult = gate.promise
  const download = controller.download()
  assert.equal(fake.downloadCalls, 1)
  const result = await controller.checkNow()
  assert.equal(result.ok, true)
  assert.equal(fake.checkCalls, 0, 'no re-check while the download is in flight')
  gate.resolve()
  const downloadResult = await download
  assert.equal(downloadResult.ok, true)
})
test('download refuses when no update is available', async () => {
  const { fake, controller } = makeController()
  const result = await controller.download()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'no update available')
  assert.equal(fake.downloadCalls, 0)
})
test('download refuses after a check failure (latestVersion cleared — never a stale download)', async () => {
  const { fake, controller } = makeController()
  fake.checkResult = Promise.reject(new Error('Cannot find module /opt/dsh-chamber/resources/app.asar'))
  await controller.checkNow()
  const state = controller.state()
  assert.equal(state.phase, 'error')
  assert.equal(state.latestVersion, null, 'a CHECK failure clears latestVersion (settings:「无法检查更新」)')
  assert.equal(state.error, 'Cannot find module [path]')
  const result = await controller.download()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'no update available')
  assert.equal(fake.downloadCalls, 0)
})
test('download refuses when automatic installation is blocked (linux non-AppImage shape)', async () => {
  const { fake, controller } = makeController({ deps: { platform: 'linux', linuxAppImage: null } })
  fake.emit('update-available', { version: '0.2.0' })
  const result = await controller.download()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'automatic installation blocked on this platform')
  assert.equal(fake.downloadCalls, 0)
})
test('download proceeds on a linux AppImage build (shape gate open)', async () => {
  const { fake, controller } = makeController({
    deps: { platform: 'linux', app: { isPackaged: true }, linuxAppImage: { path: '/opt/dsh-chamber.AppImage' } },
  })
  fake.emit('update-available', { version: '0.2.0' })
  const result = await controller.download()
  assert.equal(result.ok, true)
  assert.equal(fake.downloadCalls, 1, 'AppImage linux must reach the electron-updater download like mac/win')
})
test('download single-flights (a second click before the first progress event is refused)', async () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  const gate = deferred<void>()
  fake.downloadResult = gate.promise
  const first = controller.download()
  assert.equal(fake.downloadCalls, 1)
  const second = await controller.download()
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.error, 'download already in progress')
  assert.equal(fake.downloadCalls, 1)
  gate.resolve()
  await first
})
test('download failure: phase error, sanitized message, latestVersion KEPT for retry', async () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.downloadResult = Promise.reject(new Error('Cannot read C:\\Users\\foo\\AppData\\Local\\dsh-chamber-updater'))
  const result = await controller.download()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'Cannot read [path]')
  const state = controller.state()
  assert.equal(state.phase, 'error')
  assert.equal(state.error, 'Cannot read [path]')
  assert.equal(state.latestVersion, '0.2.0', 'a DOWNLOAD failure keeps latestVersion for the retry path')
})
test('full happy path: available → download-progress → update-downloaded in sequence', async () => {
  const { fake, controller } = makeController()
  const states = collect(controller)
  fake.emit('checking-for-update')
  fake.emit('update-available', { version: '0.2.0' })
  assert.equal(controller.state().phase, 'available')
  assert.equal(controller.state().latestVersion, '0.2.0')
  const download = controller.download()
  fake.emit('download-progress', { percent: 42 })
  assert.equal(controller.state().phase, 'downloading')
  assert.equal(controller.state().downloadPercent, 42)
  fake.emit('update-downloaded', { version: '0.2.0' })
  await download
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().downloadPercent, 100)
  assert.equal(controller.state().latestVersion, '0.2.0')
  assert.equal(controller.state().error, null)
  // The downloaded phase is terminal: a late progress event is ignored.
  fake.emit('download-progress', { percent: 50 })
  assert.equal(controller.state().downloadPercent, 100, 'late progress after downloaded is ignored')
  assert.equal(states.at(-1)?.phase, 'downloaded')
})
test('after a check failure, checkNow retries from error and can reach available again', async () => {
  const { fake, controller } = makeController()
  fake.emit('error', new Error('EAI_AGAIN https://github.com'))
  assert.equal(controller.state().phase, 'error')
  const check = controller.checkNow()
  assert.equal(fake.checkCalls, 1, 'checkNow retries from the error phase')
  await check
  fake.emit('update-available', { version: '0.3.0' })
  const state = controller.state()
  assert.equal(state.phase, 'available')
  assert.equal(state.latestVersion, '0.3.0')
  assert.equal(state.error, null, 'a successful retry clears the error')
})
test('start() on linux non-AppImage shapes is inert (no timers, just a log)', () => {
  const logs: string[] = []
  const fake = new FakeAutoUpdater()
  const controller = createUpdateController(
    {
      version: '0.1.5',
      logger: { log: (...args: unknown[]) => logs.push(args.join(' ')), warn: () => {}, error: () => {} },
    },
    { app: { isPackaged: true }, autoUpdater: fake, platform: 'linux', linuxAppImage: null },
  )
  controller.start()
  assert.ok(logs.some(line => line.includes('跳过更新检查')), 'non-AppImage linux start must log the skip and never schedule')
  assert.equal(fake.checkCalls, 0)
})
test('start() schedules checks on a linux AppImage build (shape gate open)', () => {
  const logs: string[] = []
  const fake = new FakeAutoUpdater()
  const controller = createUpdateController(
    {
      version: '0.1.5',
      logger: { log: (...args: unknown[]) => logs.push(args.join(' ')), warn: () => {}, error: () => {} },
    },
    {
      app: { isPackaged: true },
      autoUpdater: fake,
      platform: 'linux',
      linuxAppImage: { path: '/opt/dsh-chamber.AppImage' },
    },
  )
  assert.equal(controller.state().installBlockedReason, null)
  controller.start()
  assert.ok(logs.some(line => line.includes('更新检查已启动')), 'AppImage linux start must schedule the periodic checks')
})

// ---------------------------------------------------------------------------
// part 1b — cache maintenance, compressed from updater-cache-maintenance.test.ts
// (round-2 trim: same production module updater.ts, sibling suite deleted).
// Whitelist-class assertions (path traversal / relative-root / never-delete-
// newer / never-throw) are carried over verbatim in semantics.
// ---------------------------------------------------------------------------

test('sanitizeErrorText redacts absolute paths on both platforms and leaves URLs intact', () => {
  assert.equal(sanitizeErrorText('Cannot read /Users/example/Library/Caches/dsh-chamber-updater/x'), 'Cannot read [path]')
  assert.equal(sanitizeErrorText('a /opt/x and /usr/local/bin/y'), 'a [path] and [path]')
  assert.equal(sanitizeErrorText('/root/x at start'), '[path] at start')
  assert.equal(sanitizeErrorText('Cannot read C:\\Users\\foo\\AppData\\Local\\dsh-chamber-updater'), 'Cannot read [path]')
  assert.equal(sanitizeErrorText('err D:/workspace/x'), 'err [path]')
  const tagUrl = 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.0'
  assert.equal(sanitizeErrorText(`failed ${tagUrl}`), `failed ${tagUrl}`)
  assert.equal(
    sanitizeErrorText(`Cannot download ${tagUrl}: ENOENT /Users/x/Library/Caches/y`),
    `Cannot download ${tagUrl}: ENOENT [path]`,
  )
})

test('updaterCacheDirNameFromYaml reads the baked scalar and refuses traversal names', () => {
  assert.equal(updaterCacheDirNameFromYaml("updaterCacheDirName: '@dsh-chamberdesktop-updater'\n"), '@dsh-chamberdesktop-updater')
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: "dsh-chamberdesktop-updater"\n'), 'dsh-chamberdesktop-updater')
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: x-updater # keep\n'), 'x-updater')
  assert.equal(updaterCacheDirNameFromYaml('owner: panzeyu2013\nprovider: github\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName:\n'), null)
  for (const bad of ['../evil', 'a/b', 'a\\b', '..', '.']) {
    assert.equal(updaterCacheDirNameFromYaml(`updaterCacheDirName: ${bad}\n`), null, bad)
  }
})

test('updaterCacheRoot follows the electron-updater platform branches', () => {
  const env = (extra: Record<string, string> = {}) => ({ HOME: '/h', ...extra })
  assert.equal(updaterCacheRoot('darwin', env(), '/Users/t'), '/Users/t/Library/Caches')
  assert.equal(updaterCacheRoot('win32', env({ LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }), 'C:\\Users\\t'), 'C:\\Users\\t\\AppData\\Local')
  assert.equal(updaterCacheRoot('win32', env(), 'C:\\Users\\t'), join('C:\\Users\\t', 'AppData', 'Local'))
  assert.equal(updaterCacheRoot('linux', env(), '/home/t'), join('/home', 't', '.cache'))
  assert.equal(updaterCacheRoot('linux', env({ XDG_CACHE_HOME: '/var/cache/x' }), '/home/t'), '/var/cache/x')
})

test('resolveUpdaterCacheDir: packaged resolves; dev/unreadable/traversal/relative roots all fail closed to null', async () => {
  const yml = "owner: panzeyu2013\nrepo: dsh-chamber\nprovider: github\nupdaterCacheDirName: '@dsh-chamberdesktop-updater'\n"
  const read = async (path: string) => {
    assert.ok(path.endsWith(join('Resources', 'app-update.yml')) || path.endsWith('app-update.yml'), `unexpected read: ${path}`)
    return yml
  }
  assert.equal(
    await resolveUpdaterCacheDir({ isPackaged: true, platform: 'darwin', home: '/Users/t', resourcesPath: '/Applications/dsh-chamber.app/Contents/Resources', readFile: read }),
    '/Users/t/Library/Caches/@dsh-chamberdesktop-updater',
  )
  assert.equal(
    await resolveUpdaterCacheDir({ isPackaged: true, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, home: 'C:\\Users\\t', resourcesPath: 'C:\\dsh-chamber\\resources', readFile: read }),
    join('C:\\Users\\t\\AppData\\Local', '@dsh-chamberdesktop-updater'),
  )
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: false, readFile: read }), null, 'dev never resolves')
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: true, resourcesPath: '/nonexistent', readFile: async () => { throw new Error('ENOENT') } }), null, 'unreadable yml')
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: true, home: '/Users/t', resourcesPath: '/r', readFile: async () => 'updaterCacheDirName: ../../evil\n' }), null, 'traversal name refused')
  // A relative XDG_CACHE_HOME / LOCALAPPDATA / home must never yield a relative deletion target (F7).
  const rel = async () => "updaterCacheDirName: '@dsh-chamberdesktop-updater'\n"
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: true, platform: 'linux', env: { XDG_CACHE_HOME: 'relative/cache' }, home: 'relative/home', resourcesPath: '/opt/dsh-chamber/resources', readFile: rel }), null)
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: true, platform: 'win32', env: { LOCALAPPDATA: 'Relative\\AppData\\Local' }, resourcesPath: 'C:\\dsh-chamber\\resources', readFile: rel }), null)
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: true, platform: 'linux', env: {}, home: 'home-relative', resourcesPath: '/opt/dsh-chamber/resources', readFile: rel }), null)
})

test('cachedUpdateVersion reads the first canonical version and refuses non-strings', () => {
  assert.equal(cachedUpdateVersion('dsh-chamber-electron-0.2.2-arm64-mac.zip'), '0.2.2')
  assert.equal(cachedUpdateVersion('dsh-chamber-electron-0.2.2-beta.1-arm64-mac.zip'), '0.2.2-beta.1')
  assert.equal(cachedUpdateVersion('dsh-chamber-electron-0.2.2.1-arm64.zip'), '0.2.2')
  assert.equal(cachedUpdateVersion('0.2.2'), '0.2.2')
  assert.equal(cachedUpdateVersion('dsh-chamber-latest-mac.zip'), null)
  assert.equal(cachedUpdateVersion(null), null)
  assert.equal(cachedUpdateVersion(undefined), null)
  assert.equal(cachedUpdateVersion(42), null)
})

test('compareChamberVersions is numeric, beta-aware and refuses non-canonical input', () => {
  assert.equal(compareChamberVersions('0.2.2', '0.2.2'), 0)
  assert.ok((compareChamberVersions('0.2.10', '0.2.9') ?? 0) > 0)
  assert.ok((compareChamberVersions('0.2.2', '0.2.2-beta.1') ?? 0) > 0)
  assert.ok((compareChamberVersions('0.2.2-beta.2', '0.2.2-beta.1') ?? 0) > 0)
  for (const bad of ['0.2', 'v0.2.2', '0.2.2-rc.1', 'abc']) {
    assert.equal(compareChamberVersions(bad, '0.2.2'), null, bad)
  }
})

async function makeCacheTree(dirName: string): Promise<{ root: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updater-cache-test-'))
  return { root, cacheDir: join(root, dirName) }
}

async function writePendingInfo(cacheDir: string, fileName: string): Promise<void> {
  await mkdir(join(cacheDir, 'pending'), { recursive: true })
  await writeFile(join(cacheDir, 'pending', 'update-info.json'),
    JSON.stringify({ fileName, sha512: 'abc', isAdminRightsRequired: false }), 'utf8')
}

test('cleanupStaleUpdateCache deletes only a provably stale pending tree (installed/older/beta-superseded)', async () => {
  for (const [name, pendingName, running] of [
    ['equal', 'dsh-chamber-electron-0.2.2-arm64-mac.zip', '0.2.2'],
    ['older', 'dsh-chamber-electron-0.2.1-arm64-mac.zip', '0.2.2'],
    ['beta-stale', 'dsh-chamber-electron-0.2.2-beta.1-arm64-mac.zip', '0.2.2'],
  ] as const) {
    const { root, cacheDir } = await makeCacheTree(name)
    try {
      await writePendingInfo(cacheDir, pendingName)
      await writeFile(join(cacheDir, 'update.zip'), 'x', 'utf8')
      assert.equal(await cleanupStaleUpdateCache(cacheDir, running), true, name)
      assert.equal(existsSync(cacheDir), false, `${name} cache dir (incl. update.zip) must be removed`)
    } finally { await rm(root, { recursive: true, force: true }) }
  }
  // A genuinely newer pending (0.2.3 > 0.2.2; stable pending > running beta) is never deleted.
  for (const [name, pendingName, running] of [
    ['newer', 'dsh-chamber-electron-0.2.3-arm64-mac.zip', '0.2.2'],
    ['beta-fresh', 'dsh-chamber-electron-0.2.2-arm64-mac.zip', '0.2.2-beta.1'],
  ] as const) {
    const { root, cacheDir } = await makeCacheTree(name)
    try {
      await writePendingInfo(cacheDir, pendingName)
      await writeFile(join(cacheDir, 'update.zip'), 'x', 'utf8')
      assert.equal(await cleanupStaleUpdateCache(cacheDir, running), false, name)
      assert.equal(existsSync(join(cacheDir, 'update.zip')), true, `${name} cache must stay untouched`)
      assert.ok((await readFile(join(cacheDir, 'pending', 'update-info.json'), 'utf8')).includes(pendingName.slice(0, 0) || 'dsh-chamber'), 'pending metadata must stay')
    } finally { await rm(root, { recursive: true, force: true }) }
  }
})

async function expectCacheKept(name: string, setup: (cacheDir: string) => Promise<void>): Promise<void> {
  const { root, cacheDir } = await makeCacheTree(name)
  try {
    await setup(cacheDir)
    assert.equal(await cleanupStaleUpdateCache(cacheDir, '0.2.2'), false, name)
    assert.equal(existsSync(join(cacheDir, 'update.zip')), true, `${name} must keep the cache`)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('cleanupStaleUpdateCache keeps the cache when nothing is provably stale (fail-closed, never throws)', async () => {
  const withZip = async (cacheDir: string) => { await writeFile(join(cacheDir, 'update.zip'), 'x', 'utf8') }
  await expectCacheKept('no-info', async c => { await mkdir(c, { recursive: true }); await withZip(c) })
  await expectCacheKept('no-file', async c => { await mkdir(join(c, 'pending'), { recursive: true }); await withZip(c) })
  await expectCacheKept('corrupt', async c => {
    await mkdir(join(c, 'pending'), { recursive: true })
    await writeFile(join(c, 'pending', 'update-info.json'), '{not json', 'utf8')
    await withZip(c)
  })
  await expectCacheKept('no-version', async c => { await writePendingInfo(c, 'dsh-chamber-latest-arm64-mac.zip'); await withZip(c) })
  const shapes = ['null', '[]', '"a string"', '42', '{}', '{"sha512":"abc"}', '{"fileName":42}']
  for (const [index, content] of shapes.entries()) {
    await expectCacheKept(`shape-${index}`, async c => {
      await mkdir(join(c, 'pending'), { recursive: true })
      await writeFile(join(c, 'pending', 'update-info.json'), content, 'utf8')
      await withZip(c)
    })
  }
  // A failing removal reports false, leaves the cache intact and never throws.
  const failing = await makeCacheTree('rm-fail')
  try {
    await writePendingInfo(failing.cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(failing.cacheDir, '0.2.2', {
      removeTree: async () => { throw new Error('EACCES /private/var') },
    }), false)
    assert.equal(existsSync(failing.cacheDir), true, 'a failed removal leaves the cache intact')
  } finally { await rm(failing.root, { recursive: true, force: true }) }
})

test('controller startup cleans a stale injected cache dir and a null override disables it', async () => {
  const stale = await makeCacheTree('controller-stale')
  try {
    await writePendingInfo(stale.cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    const { controller } = makeController({ version: '0.2.2', deps: { staleCache: { cacheDir: stale.cacheDir } } })
    assert.equal(controller.state().phase, 'idle', 'controller construction is not affected by the cleanup')
    assert.equal(await waitFor(() => !existsSync(stale.cacheDir)), true, 'the controller must asynchronously remove the stale cache dir')
  } finally { await rm(stale.root, { recursive: true, force: true }) }
  const kept = await makeCacheTree('controller-kept')
  try {
    await writePendingInfo(kept.cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    const { controller } = makeController({ version: '0.2.2', deps: { staleCache: { cacheDir: null } } })
    assert.equal(controller.state().phase, 'idle')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(existsSync(kept.cacheDir), true, 'a null staleCache override must disable the cleanup')
  } finally { await rm(kept.root, { recursive: true, force: true }) }
})
