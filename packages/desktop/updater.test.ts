/**
 * updater.ts (design 11) unit tests — pure Node, no electron, no real
 * electron-updater. The controller's real-value deps (the electron `app`,
 * the require'd electron-updater `autoUpdater`, `process.platform`) are all
 * injected through the `createUpdateController` deps seam, so the suite
 * drives the state machine with a fake EventEmitter-based autoUpdater and a
 * fake app — nothing ever touches the real modules (which cannot even load
 * under plain node: `import { app } from 'electron'` fails to link there and
 * the real electron-updater main reads `app.getVersion()` at load time).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  betaReleaseDownloadBase,
  cachedUpdateVersion,
  cleanupStaleUpdateCache,
  compareChamberVersions,
  createUpdateController,
  isAllowedReleaseUrl,
  LINUX_UPDATE_UNSUPPORTED_REASON,
  openReleasePage,
  probeLinuxAppImage,
  resolveGithubBetaFeed,
  resolveUpdaterCacheDir,
  sanitizeErrorText,
  updaterCacheDirNameFromYaml,
  updaterCacheRoot,
} from './updater.ts'
import type { AutoUpdaterLike, UpdateController, UpdateControllerDeps, UpdatePhase, UpdateState } from './updater.ts'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

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

/** The electron-updater surface the controller touches, faked. */
class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = true
  autoInstallOnAppQuit = false
  allowPrerelease = false
  allowDowngrade = true
  channel: string | null = null
  forceDevUpdateConfig = false
  feedUrl: Record<string, unknown> | null = null
  checkCalls = 0
  downloadCalls = 0
  checkResult: Promise<unknown> = Promise.resolve({})
  downloadResult: Promise<unknown> = Promise.resolve({})

  setFeedURL(options: Record<string, unknown>): void {
    this.feedUrl = options
  }

  checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1
    return this.checkResult
  }

  downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1
    return this.downloadResult
  }

  quitAndInstallCalls = 0
  quitAndInstallArgs: [boolean | undefined, boolean | undefined][] = []
  /** When set, quitAndInstall throws synchronously (nothing armed). */
  quitAndInstallError: Error | null = null
  /** When set, quitAndInstall dispatches an 'error' event with this error
   *  (2026-12 review round F3 — real electron-updater 6.8.9 sync failures
   *  DISPATCH 'error' from install() and return false instead of throwing). */
  quitAndInstallDispatchError: Error | null = null
  /** What quitAndInstall returns after any dispatch; undefined mirrors the
   *  real 6.8.9 (declared void — an armed quit), false mirrors a refused
   *  arming without an event. */
  quitAndInstallResult: unknown = undefined
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): unknown {
    if (this.quitAndInstallError !== null) throw this.quitAndInstallError
    this.quitAndInstallCalls += 1
    this.quitAndInstallArgs.push([isSilent, isForceRunAfter])
    if (this.quitAndInstallDispatchError !== null) this.emit('error', this.quitAndInstallDispatchError)
    return this.quitAndInstallResult
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Default harness: win32 (no install block), dev app, stable channel. */
function makeController(overrides: {
  deps?: Partial<UpdateControllerDeps>
  version?: string
  env?: Record<string, string>
} = {}): { fake: FakeAutoUpdater; controller: UpdateController } {
  const fake = new FakeAutoUpdater()
  const deps: UpdateControllerDeps = {
    app: { isPackaged: false },
    autoUpdater: fake,
    platform: 'win32',
    // The default probe would touch the REAL process.env + fs; tests inject
    // the Linux shape explicitly (pure by construction) or keep it closed.
    linuxAppImage: null,
    ...overrides.deps,
  }
  const prevChannel = process.env.DSH_CHAMBER_UPDATE_CHANNEL
  if (overrides.env) {
    for (const [key, value] of Object.entries(overrides.env)) process.env[key] = value
  }
  const controller = createUpdateController(
    { version: overrides.version ?? '0.1.5', logger: silentLogger },
    deps,
  )
  if (overrides.env) {
    for (const key of Object.keys(overrides.env)) delete process.env[key]
  }
  if (prevChannel !== undefined) process.env.DSH_CHAMBER_UPDATE_CHANNEL = prevChannel
  return { fake, controller }
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
  // Linux packaged but NOT started from a writable AppImage (dev / unpacked
  // dir / deb): the historic inert reason — the renderer gate keys on it.
  const linuxUnpacked = makeController({ deps: { platform: 'linux', app: { isPackaged: true }, linuxAppImage: null } }).controller.state()
  assert.equal(linuxUnpacked.installBlockedReason, LINUX_UPDATE_UNSUPPORTED_REASON)
  const linuxDev = makeController({ deps: { platform: 'linux', app: { isPackaged: false } } }).controller.state()
  assert.equal(linuxDev.installBlockedReason, LINUX_UPDATE_UNSUPPORTED_REASON)
  // dev + a NON-NULL probe must still stay blocked: only the packaged shape
  // may open the gate (isPackaged is the second half of the AND).
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
  // Unpacked-dir / dev launch shapes never open the gate, even with a stale
  // inherited APPIMAGE pointing at a real writable file (quit-install must
  // never unlink a foreign file).
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
  // Parent-directory write denied → null (AppImageUpdater unlinks + moves
  // INTO the parent; the file's own mode is irrelevant to replacement).
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
  // A gate no-op still resolves {ok:true} — the renderer judges the outcome
  // from the state push, never from this return value (documented contract).
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

test('restartAndInstall refuses before a download completed (quitAndInstall never armed)', () => {
  const { fake, controller } = makeController()
  // `available` (and every earlier phase) is not a completed download.
  fake.emit('checking-for-update')
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'no downloaded update to install' })
  fake.emit('update-available', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'no downloaded update to install' })
  fake.emit('error', new Error('EAI_AGAIN https://github.com'))
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'no downloaded update to install' })
  assert.equal(fake.quitAndInstallCalls, 0)
})

test('restartAndInstall refuses when automatic installation is blocked even in the downloaded phase', () => {
  // Downloaded + blocked cannot be REACHED through download() (the download
  // gate refuses while blocked), but the restart gate double-checks the
  // install-block independently of the phase — enforcement at the IPC
  // boundary, not just UI hiding (same discipline as download()).
  const { fake, controller } = makeController({ deps: { platform: 'darwin', app: { isPackaged: false } } })
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().installBlockedReason, 'development build')
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'automatic installation blocked on this platform' })
  assert.equal(fake.quitAndInstallCalls, 0)
})

test('restartAndInstall refuses on linux even on an installable AppImage shape (H1 single-instance race)', () => {
  // AppImage quitAndInstall swaps the running file and spawns the new
  // instance BEFORE this process quits — the fresh instance collides with
  // the still-alive old one under Electron's single-instance lock and the
  // promised auto-restart cannot happen (2026-12 review H1). Linux keeps the
  // quit-install leg; the restart action is refused at the controller too.
  const { fake, controller } = makeController({
    deps: { platform: 'linux', app: { isPackaged: true }, linuxAppImage: { path: '/opt/dsh-chamber.AppImage' } },
  })
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().installBlockedReason, null, 'AppImage shape is installable — only the RESTART is refused')
  const result = controller.restartAndInstall()
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /linux/)
  assert.equal(fake.quitAndInstallCalls, 0)
})

test('restartAndInstall arms quitAndInstall once the download completed (fire-and-forget single-flight)', async () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  const download = controller.download()
  fake.emit('update-downloaded', { version: '0.2.0' })
  await download
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().installBlockedReason, null)
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 1, 'a completed download on an installable shape arms quitAndInstall')
  // Silent install + forced relaunch (design 11 low-key contract: the NSIS
  // installer must not pop a window; the controlled restart must end in the
  // new version — mac Squirrel relaunches regardless of the args).
  assert.deepEqual(fake.quitAndInstallArgs, [[true, true]])
  // The action is fire-and-forget: success is deliberately NOT reset (the app
  // is on its way out) — a second arming is refused.
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'restart already in progress' })
  assert.equal(fake.quitAndInstallCalls, 1)
})

test('restartAndInstall failure (sync throw) keeps the downloaded row and releases the single-flight', () => {
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.emit('update-downloaded', { version: '0.2.0' })
  fake.quitAndInstallError = new Error('Cannot read /opt/dsh-chamber/resources/app.asar')
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'Cannot read [path]' })
  assert.equal(fake.quitAndInstallCalls, 0, 'a throw means nothing was armed')
  // The phase deliberately stays `downloaded` (2026-12 review P3-1): the
  // settings row keeps the「重启并安装」button so the user retries the RESTART
  // in place — regressing to 'error' would mislabel this as a download
  // failure and offer the wrong retry action. The sanitized failure rides the
  // one-shot restartFailureText carry (review round F2/F3), never the generic
  // `error` field.
  assert.equal(controller.state().phase, 'downloaded')
  assert.equal(controller.state().error, null, 'no error state is pushed on a restart-only failure')
  assert.equal(controller.state().restartFailureText, 'Cannot read [path]')
  fake.quitAndInstallError = null
  assert.deepEqual(controller.restartAndInstall(), { ok: true }, 'the failure released the single-flight for an in-place retry')
  assert.equal(fake.quitAndInstallCalls, 1)
  // A successful re-arm clears the stale failure carry (the row can show the
  // honest in-progress line while the quit window runs).
  assert.equal(controller.state().restartFailureText, undefined)
})

test('an error event after an armed ok:true is a RESTART failure: phase stays downloaded, single-flight released, restartFailureText set', () => {
  const { fake, controller } = makeController()
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 1)
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'restart already in progress' })
  // Async failure AFTER the arm (mac staging-window click whose native fetch
  // errors later; BaseUpdater.install() returning false → dispatchError)
  // never reaches the synchronous call — the 'error' listener must release
  // the flag or every later click would be silently refused until restart.
  // It must ALSO keep the phase `downloaded`: an 'error' phase would be
  // misread by the settings section as a download failure (2026-12 review
  // round F2 — the failure rides restartFailureText instead, so the row can
  // show a restart-specific failure line and an enabled retry button).
  fake.emit('error', new Error('Cannot read /tmp/x/update.zip'))
  const state = controller.state()
  assert.equal(state.phase, 'downloaded', 'an armed-restart error must never regress the phase to error')
  assert.equal(state.error, null, 'not a download/check failure — the generic error field stays null')
  assert.equal(state.restartFailureText, 'Cannot read [path]', 'the sanitized restart failure rides restartFailureText')
  assert.ok(!state.restartFailureText!.includes('/tmp/'), 'no path material may reach the projection')
  // Phase is still `downloaded` — the retry needs no fresh update-downloaded:
  // the released single-flight + the still-valid downloaded phase arm again.
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 2)
  assert.equal(controller.state().restartFailureText, undefined, 'a successful re-arm clears the stale carry')
})

test('restartAndInstall: quitAndInstall returning false without an event is a not-armed failure on restartFailureText', () => {
  const { fake, controller } = makeController()
  fake.emit('update-downloaded', { version: '0.2.0' })
  // The real 6.8.9 non-dispatching refusal — install() returning false while
  // its quitAndInstallCalled latch is still set (BaseUpdater.js, round-2
  // review A2) — is stopped by the win32 restartStalled gate BEFORE this
  // call, so a silent falsy return here is a fake-seam-only shape; the seam
  // must still not mislabel a silent falsy return as an armed restart (F3).
  fake.quitAndInstallResult = false
  const result = controller.restartAndInstall()
  assert.equal(result.ok, false)
  const state = controller.state()
  assert.equal(state.phase, 'downloaded', 'no error-phase regression on a restart-only failure')
  assert.equal(state.error, null)
  assert.ok(state.restartFailureText !== undefined && state.restartFailureText.includes('did not proceed'),
    'a silent falsy return synthesizes the honest not-armed text')
  // The flight was released — with the seam cleared the very next click arms
  // in place (no reload, no fresh download).
  fake.quitAndInstallResult = undefined
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 2)
  assert.equal(controller.state().restartFailureText, undefined, 'a successful re-arm clears the stale carry')
})

test('restartAndInstall: quitAndInstall dispatching error mid-call (real 6.8.9 sync shape) is a not-armed failure with the dispatched text', () => {
  const { fake, controller } = makeController()
  fake.emit('update-downloaded', { version: '0.2.0' })
  // Real 6.8.9 sync failure: BaseUpdater.install() dispatches 'error' and
  // returns false; quitAndInstall returns without arming. The dispatch runs
  // SYNCHRONOUSLY inside the call — the controller must see it as not-armed
  // and surface the dispatched (sanitized) text, not a fake ok:true.
  fake.quitAndInstallDispatchError = new Error('Cannot read /opt/dsh-chamber/resources/app.asar')
  fake.quitAndInstallResult = false
  const result = controller.restartAndInstall()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'Cannot read [path]')
  const state = controller.state()
  assert.equal(state.phase, 'downloaded')
  assert.equal(state.error, null, 'never the generic download/check error field')
  assert.equal(state.restartFailureText, 'Cannot read [path]', 'the mid-call dispatch text rides restartFailureText')
  fake.quitAndInstallDispatchError = null
  fake.quitAndInstallResult = undefined
  assert.deepEqual(controller.restartAndInstall(), { ok: true }, 'the failure released the flight for an in-place retry')
  assert.equal(fake.quitAndInstallCalls, 2)
})

test('restart stall watchdog: an armed restart that neither quits nor errors releases the single-flight after the grace (F4)', async () => {
  // darwin leg: the stall releases the flight and a retry RE-ARMS (a mac
  // re-entry only re-registers the native staging listener — round-2 review
  // A2 keeps mac retry semantics unchanged). A packaged darwin controller
  // needs the injected signature probe to clear the install-block gate (the
  // real probe reads the running process.execPath and never resolves true
  // under plain node).
  const { fake, controller } = makeController({
    deps: { platform: 'darwin', app: { isPackaged: true }, probeMacSignature: async () => true, restartWatchdogMs: 30 },
  })
  assert.equal(await waitFor(() => controller.state().installBlockedReason === null), true,
    'the injected mac signature probe must clear the install block')
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 1)
  // Still armed immediately after the arm — the grace has not elapsed.
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'restart already in progress' })
  assert.equal(controller.state().restartFailureText, undefined)
  // The fake never quits and never errors: after ~the grace the watchdog must
  // release the flight and surface the honest stall text.
  assert.equal(await waitFor(() => controller.state().restartFailureText !== undefined), true,
    'the stall watchdog must release the flight and set restartFailureText')
  const state = controller.state()
  assert.equal(state.phase, 'downloaded', 'a stalled restart never regresses the phase to error')
  assert.equal(state.error, null)
  assert.ok(state.restartFailureText!.includes('stalled'), 'the watchdog text says the restart stalled')
  assert.deepEqual(controller.restartAndInstall(), { ok: true }, 'the watchdog released the flight for an in-place retry')
  assert.equal(fake.quitAndInstallCalls, 2)
})

test('win32 stall latch: after a stalled armed attempt a retry is refused BEFORE quitAndInstall (A2)', async () => {
  // Real 6.8.9 BaseUpdater.install() returns false WITHOUT dispatching while
  // its quitAndInstallCalled latch is still set (BaseUpdater.js — the quit
  // never completed), so a re-entry would report ok:true while nothing arms,
  // and a further retry would re-spawn a duplicate NSIS installer. The
  // per-boot restartStalled latch refuses win32 retries with an honest text.
  const { fake, controller } = makeController({ deps: { restartWatchdogMs: 30 } })
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 1)
  assert.equal(await waitFor(() => controller.state().restartFailureText !== undefined), true,
    'the stall watchdog must release the flight and set restartFailureText')
  assert.ok(controller.state().restartFailureText!.includes('stalled'))
  const refused = controller.restartAndInstall()
  assert.equal(refused.ok, false)
  if (!refused.ok) {
    assert.match(refused.error, /did not complete/, 'the refusal text says the previous quit never completed')
    assert.equal(refused.error, controller.state().restartFailureText, 'the refusal rides the same restartFailureText channel')
  }
  assert.equal(fake.quitAndInstallCalls, 1, 'quitAndInstall must NOT be re-entered after a win32 stall')
  const state = controller.state()
  assert.equal(state.phase, 'downloaded', 'the refusal never regresses the phase')
  assert.equal(state.error, null)
  // The latch is per-boot: further retries stay refused (only a real
  // quit/install — an app restart — clears it).
  assert.equal(controller.restartAndInstall().ok, false)
  assert.equal(fake.quitAndInstallCalls, 1)
})

test('restart stall watchdog does not interfere with the normal armed-ok path when the grace is large (F4)', async () => {
  const { fake, controller } = makeController({ deps: { restartWatchdogMs: 60_000 } })
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  // Well inside the 60s grace the single-flight must still be held and no
  // failure text may appear — the watchdog must not fire early.
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'restart already in progress' })
  assert.equal(controller.state().restartFailureText, undefined)
  assert.equal(controller.state().phase, 'downloaded')
})

test('a non-restart error (nothing armed, not at phase downloaded) still reaches phase error with latestVersion kept — only restart-channeled errors keep the downloaded phase', async () => {
  // During a DOWNLOAD the single-flight is not armed and the phase is not
  // `downloaded` — the classic behavior must be untouched (2026-12 review F2
  // + round-2 A1: only restart-channeled errors — armed, or at phase
  // `downloaded` — keep the downloaded phase).
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.emit('error', new Error('Cannot read C:\\Users\\foo\\AppData\\Local\\dsh-chamber-updater'))
  let state = controller.state()
  assert.equal(state.phase, 'error')
  assert.equal(state.error, 'Cannot read [path]')
  assert.equal(state.latestVersion, '0.2.0', 'a download-side error keeps latestVersion for the retry path')
  assert.equal(state.restartFailureText, undefined, 'a non-restart error never sets restartFailureText')
  // A CHECK error (armed restart impossible during a check too) keeps the
  // same phase-error path, and a LATER restart failure carry is cleared by
  // the next fresh phase push (the clearing rule).
  fake.emit('update-downloaded', { version: '0.2.0' })
  fake.quitAndInstallError = new Error('boom')
  controller.restartAndInstall() // restart failure → carry set
  state = controller.state()
  assert.equal(state.restartFailureText, 'boom')
  fake.quitAndInstallError = null
  fake.emit('checking-for-update') // a fresh phase push
  assert.equal(controller.state().restartFailureText, undefined, 'every non-failure push clears the carry')
  assert.equal(controller.state().phase, 'checking')
})

test('an error event at phase downloaded with NOTHING armed is still a restart failure (A1: late staging re-emission never regresses the phase)', () => {
  // Round-2 review A1: nothing else can error at phase `downloaded`
  // (runCheck() and download() gate on earlier phases), so an error there is
  // quit/staging-related by construction — including when the single-flight
  // was already released (MacUpdater's constructor-registered native-error
  // bridge re-emits staging failures indefinitely). It must ride the restart
  // channel — phase stays `downloaded`, `error` stays null — instead of the
  // historic not-armed branch regressing to phase 'error'.
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.equal(controller.state().phase, 'downloaded')
  // No restart was ever attempted in this controller — a plain late error
  // arrives (the mac staging re-emission shape).
  fake.emit('error', new Error('Cannot read /tmp/x/update.zip'))
  const state = controller.state()
  assert.equal(state.phase, 'downloaded', 'a downloaded-phase error must never regress the phase to error')
  assert.equal(state.error, null, 'not a download/check failure — the generic error field stays null')
  assert.equal(state.restartFailureText, 'Cannot read [path]', 'the sanitized error rides restartFailureText')
  assert.equal(state.latestVersion, '0.2.0', 'the downloaded projection stays intact')
  // The flight was never held — the next click arms cleanly and clears the
  // stale carry (the retry needs no fresh update-downloaded).
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.equal(fake.quitAndInstallCalls, 1)
  assert.equal(controller.state().restartFailureText, undefined, 'a successful arm clears the stale carry')
})

test('an error arriving AFTER the stall watchdog fired replaces the stall text with the real error (A1)', async () => {
  const { fake, controller } = makeController({ deps: { restartWatchdogMs: 30 } })
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  // The armed attempt stalls (no quit, no error): the watchdog releases the
  // flight and pushes the honest stall text.
  assert.equal(await waitFor(() => controller.state().restartFailureText !== undefined), true,
    'the stall watchdog must release the flight and set restartFailureText')
  assert.ok(controller.state().restartFailureText!.includes('stalled'))
  // A LATE native staging error now arrives — the flight is already released
  // but the phase is still `downloaded`: it must REPLACE the generic stall
  // text with the real sanitized error and keep the phase. The pre-A1
  // not-armed branch would have regressed to phase 'error' and wiped the
  // carry — the exact download-failure mislabel round 1 abolished.
  fake.emit('error', new Error('Cannot read /tmp/x/update.zip'))
  const state = controller.state()
  assert.equal(state.phase, 'downloaded', 'a late error after the stall must never regress the phase')
  assert.equal(state.error, null)
  assert.equal(state.restartFailureText, 'Cannot read [path]', 'the real error text replaces the stall text')
  assert.equal(controller.state().downloadPercent, 100, 'the downloaded projection stays intact')
})

test('an error during downloading keeps the historic phase-error path (A1: only downloaded-phase errors are restart-channeled)', async () => {
  // A download failure while the flow is mid-flight (nothing armed, phase is
  // NOT downloaded) must keep the exact historic behavior — the restart
  // channel is reserved for downloaded-phase/staging errors only.
  const { fake, controller } = makeController()
  fake.emit('update-available', { version: '0.2.0' })
  fake.emit('download-progress', { percent: 42 })
  assert.equal(controller.state().phase, 'downloading')
  fake.emit('error', new Error('Cannot read C:\\Users\\foo\\AppData\\Local\\dsh-chamber-updater'))
  const state = controller.state()
  assert.equal(state.phase, 'error')
  assert.equal(state.error, 'Cannot read [path]')
  assert.equal(state.latestVersion, '0.2.0', 'a download-side error keeps latestVersion for the retry path')
  assert.equal(state.restartFailureText, undefined, 'a downloading-phase error never touches the restart channel')
})

test('win32 retry after a NORMAL sync failure (no stall) is not blocked by the stall latch (A2)', async () => {
  // Only a WATCHDOG stall sets restartStalled; a plain sync failure (a
  // synchronous throw here) releases the flight WITHOUT it, so the win32
  // in-place retry must still arm — the A2 refusal is about stalled quits
  // only (where the real updater's own latch would refuse the re-entry).
  const { fake, controller } = makeController()
  fake.emit('update-downloaded', { version: '0.2.0' })
  fake.quitAndInstallError = new Error('Cannot read C:\\Users\\foo\\AppData\\Local\\dsh-chamber-updater\\pending')
  const failed = controller.restartAndInstall()
  assert.equal(failed.ok, false)
  if (!failed.ok) assert.equal(failed.error, 'Cannot read [path]')
  fake.quitAndInstallError = null
  assert.deepEqual(controller.restartAndInstall(), { ok: true }, 'a no-stall sync failure leaves the win32 in-place retry open')
  assert.equal(fake.quitAndInstallCalls, 1)
  assert.equal(controller.state().restartFailureText, undefined, 'a successful re-arm clears the stale carry')
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

test('sanitizeErrorText replaces POSIX absolute paths', () => {
  assert.equal(sanitizeErrorText('Cannot read /Users/example/Library/Caches/dsh-chamber-updater/x'), 'Cannot read [path]')
  assert.equal(sanitizeErrorText('a /opt/x and /usr/local/bin/y'), 'a [path] and [path]')
  assert.equal(sanitizeErrorText('/root/x at start'), '[path] at start')
})

test('sanitizeErrorText replaces Windows drive paths (backslash and forward slash)', () => {
  assert.equal(sanitizeErrorText('Cannot read C:\\Users\\foo\\AppData\\Local\\dsh-chamber-updater'), 'Cannot read [path]')
  assert.equal(sanitizeErrorText('err D:/workspace/x'), 'err [path]')
})

test('sanitizeErrorText leaves URLs intact (scheme, host and path segments)', () => {
  const tagUrl = 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.0'
  assert.equal(sanitizeErrorText(`failed ${tagUrl}`), `failed ${tagUrl}`)
  const downloadUrl = 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0/latest.yml'
  assert.equal(sanitizeErrorText(`Cannot download ${downloadUrl}: 404`), `Cannot download ${downloadUrl}: 404`)
})

test('sanitizeErrorText redacts paths next to URLs without touching the URL', () => {
  const downloadUrl = 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0/latest.yml'
  assert.equal(
    sanitizeErrorText(`Cannot download ${downloadUrl}: ENOENT /Users/x/Library/Caches/y`),
    `Cannot download ${downloadUrl}: ENOENT [path]`,
  )
})

// ---- Startup stale-download-cache cleanup (design 11, 2026-12) ----

test('updaterCacheDirNameFromYaml reads the baked scalar (plain/quoted) and refuses escapes', () => {
  assert.equal(
    updaterCacheDirNameFromYaml('owner: panzeyu2013\nprovider: github\nupdaterCacheDirName: \'@dsh-chamberdesktop-updater\'\n'),
    '@dsh-chamberdesktop-updater',
  )
  assert.equal(
    updaterCacheDirNameFromYaml('updaterCacheDirName: "dsh-chamberdesktop-updater"\n'),
    'dsh-chamberdesktop-updater',
  )
  assert.equal(updaterCacheDirNameFromYaml('owner: panzeyu2013\nprovider: github\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName:\n'), null)
  // A value must be a bare dir NAME — separators/dot-names would escape the
  // cache root and are refused (defense in depth even for a bundled yml).
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: ../evil\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: a/b\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: a\\b\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: ..\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: .\n'), null)
  // Inline comments are not part of the scalar.
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: x-updater # keep\n'), 'x-updater')
})

test('updaterCacheRoot follows the electron-updater platform branches', () => {
  const env = (extra: Record<string, string> = {}) => ({ HOME: '/h', ...extra })
  assert.equal(updaterCacheRoot('darwin', env(), '/Users/t'), '/Users/t/Library/Caches')
  assert.equal(updaterCacheRoot('win32', env({ LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }), 'C:\\Users\\t'),
    'C:\\Users\\t\\AppData\\Local')
  assert.equal(updaterCacheRoot('win32', env(), 'C:\\Users\\t'), join('C:\\Users\\t', 'AppData', 'Local'))
  assert.equal(updaterCacheRoot('linux', env(), '/home/t'), join('/home', 't', '.cache'))
  assert.equal(updaterCacheRoot('linux', env({ XDG_CACHE_HOME: '/var/cache/x' }), '/home/t'), '/var/cache/x')
})

test('resolveUpdaterCacheDir: packaged + baked yml resolves the real cache dir; dev never resolves', async () => {
  const yml = 'owner: panzeyu2013\nrepo: dsh-chamber\nprovider: github\nupdaterCacheDirName: \'@dsh-chamberdesktop-updater\'\n'
  const read = async (path: string) => {
    assert.ok(path.endsWith(join('Resources', 'app-update.yml')) || path.endsWith('app-update.yml'), `unexpected read: ${path}`)
    return yml
  }
  const darwin = await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'darwin', home: '/Users/t', resourcesPath: '/Applications/dsh-chamber.app/Contents/Resources', readFile: read,
  })
  assert.equal(darwin, '/Users/t/Library/Caches/@dsh-chamberdesktop-updater')
  const win = await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, home: 'C:\\Users\\t',
    resourcesPath: 'C:\\dsh-chamber\\resources', readFile: read,
  })
  assert.equal(win, join('C:\\Users\\t\\AppData\\Local', '@dsh-chamberdesktop-updater'))
  // Dev / unpacked shapes have no baked yml — nothing resolves.
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: false, readFile: read }), null)
  // Unreadable yml → null (never throws).
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, resourcesPath: '/nonexistent', readFile: async () => { throw new Error('ENOENT') },
  }), null)
  // A refused (traversal) dir name → null.
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, home: '/Users/t', resourcesPath: '/r',
    readFile: async () => 'updaterCacheDirName: ../../evil\n',
  }), null)
})

test('resolveUpdaterCacheDir refuses a RELATIVE derived cache dir (crafted env roots → null, no deletion possible)', async () => {
  const yml = 'updaterCacheDirName: \'@dsh-chamberdesktop-updater\'\n'
  const read = async () => yml
  // A relative XDG_CACHE_HOME / LOCALAPPDATA / home would make the derived
  // dir relative too — the resolver must return null (2026-12 review round
  // F7: conservative, like the dev/unresolvable cases) so no deletion can
  // ever be pointed at a relative path.
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'linux', env: { XDG_CACHE_HOME: 'relative/cache' }, home: 'relative/home',
    resourcesPath: '/opt/dsh-chamber/resources', readFile: read,
  }), null)
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'win32', env: { LOCALAPPDATA: 'Relative\\AppData\\Local' },
    resourcesPath: 'C:\\dsh-chamber\\resources', readFile: read,
  }), null)
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'linux', env: {}, home: 'home-relative',
    resourcesPath: '/opt/dsh-chamber/resources', readFile: read,
  }), null)
})

test('cachedUpdateVersion reads the first canonical chamber version out of a cache file name', () => {
  assert.equal(cachedUpdateVersion('dsh-chamber-0.2.2-arm64-mac.zip'), '0.2.2')
  assert.equal(cachedUpdateVersion('dsh-chamber-0.2.2-beta.1-arm64-mac.zip'), '0.2.2-beta.1')
  assert.equal(cachedUpdateVersion('dsh-chamber-0.10.2-x64.zip'), '0.10.2')
  assert.equal(cachedUpdateVersion('dsh-chamber-latest-mac.zip'), null)
  assert.equal(cachedUpdateVersion('0.2.2'), '0.2.2')
  // An extra dotted tail does not confuse the version read (patch stops at
  // the separator) and non-string input yields null.
  assert.equal(cachedUpdateVersion('dsh-chamber-0.2.2.1-arm64.zip'), '0.2.2')
  assert.equal(cachedUpdateVersion(null), null)
  assert.equal(cachedUpdateVersion(undefined), null)
  assert.equal(cachedUpdateVersion(42), null)
})

test('compareChamberVersions is numeric, beta-aware and refuse non-canonical input', () => {
  assert.equal(compareChamberVersions('0.2.2', '0.2.2'), 0)
  assert.ok((compareChamberVersions('0.2.3', '0.2.2') ?? 0) > 0)
  assert.ok((compareChamberVersions('0.2.2', '0.2.3') ?? 0) < 0)
  assert.ok((compareChamberVersions('0.2.10', '0.2.9') ?? 0) > 0, 'patch parts compare numerically')
  assert.ok((compareChamberVersions('1.0.0', '0.9.9') ?? 0) > 0)
  // Stable > beta of the same base; beta.N numeric.
  assert.ok((compareChamberVersions('0.2.2', '0.2.2-beta.1') ?? 0) > 0)
  assert.ok((compareChamberVersions('0.2.2-beta.1', '0.2.2') ?? 0) < 0)
  assert.ok((compareChamberVersions('0.2.2-beta.2', '0.2.2-beta.1') ?? 0) > 0)
  assert.equal(compareChamberVersions('0.2.2-beta.1', '0.2.2-beta.1'), 0)
  // Non-canonical → null (callers must not act).
  assert.equal(compareChamberVersions('0.2', '0.2.2'), null)
  assert.equal(compareChamberVersions('v0.2.2', '0.2.2'), null)
  assert.equal(compareChamberVersions('0.2.2-rc.1', '0.2.2'), null)
  assert.equal(compareChamberVersions('abc', '0.2.2'), null)
})

/** A fresh fake electron-updater cache tree under os.tmpdir(). */
async function makeCacheTree(dirName: string): Promise<{ root: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updater-cache-test-'))
  return { root, cacheDir: join(root, dirName) }
}

async function writePendingInfo(cacheDir: string, fileName: string): Promise<void> {
  await mkdir(join(cacheDir, 'pending'), { recursive: true })
  await writeFile(join(cacheDir, 'pending', 'update-info.json'),
    JSON.stringify({ fileName, sha512: 'abc', isAdminRightsRequired: false }), 'utf8')
}

test('cleanupStaleUpdateCache removes the whole cache dir when the pending update is already installed', async () => {
  const { root, cacheDir } = await makeCacheTree('equal')
  try {
    await writePendingInfo(cacheDir, 'dsh-chamber-0.2.2-arm64-mac.zip')
    await writeFile(join(cacheDir, 'update.zip'), 'x', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(cacheDir, '0.2.2'), true, 'pending == running → stale (already installed)')
    assert.equal(existsSync(cacheDir), false, 'the whole cache dir (incl. update.zip) must be removed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanupStaleUpdateCache removes an older pending update but keeps a newer one', async () => {
  const older = await makeCacheTree('older')
  try {
    await writePendingInfo(older.cacheDir, 'dsh-chamber-0.2.1-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(older.cacheDir, '0.2.2'), true, 'pending older than running → stale')
    assert.equal(existsSync(older.cacheDir), false)
  } finally {
    await rm(older.root, { recursive: true, force: true })
  }
  const newer = await makeCacheTree('newer')
  try {
    await writePendingInfo(newer.cacheDir, 'dsh-chamber-0.2.3-arm64-mac.zip')
    await writeFile(join(newer.cacheDir, 'update.zip'), 'x', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(newer.cacheDir, '0.2.2'), false,
      'a genuinely newer pending update must never be deleted')
    assert.equal(existsSync(join(newer.cacheDir, 'update.zip')), true, 'cache must stay untouched')
    const kept = await readFile(join(newer.cacheDir, 'pending', 'update-info.json'), 'utf8')
    assert.ok(kept.includes('0.2.3'), 'pending metadata must stay untouched')
  } finally {
    await rm(newer.root, { recursive: true, force: true })
  }
})

test('cleanupStaleUpdateCache keeps the cache when nothing is provably stale', async () => {
  // No pending metadata at all (only the squirrel-serving zip).
  const noInfo = await makeCacheTree('no-info')
  try {
    await mkdir(noInfo.cacheDir, { recursive: true })
    await writeFile(join(noInfo.cacheDir, 'update.zip'), 'x', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(noInfo.cacheDir, '0.2.2'), false)
    assert.equal(existsSync(join(noInfo.cacheDir, 'update.zip')), true)
  } finally {
    await rm(noInfo.root, { recursive: true, force: true })
  }
  // Missing metadata file.
  const noFile = await makeCacheTree('no-file')
  try {
    assert.equal(await cleanupStaleUpdateCache(noFile.cacheDir, '0.2.2'), false)
  } finally {
    await rm(noFile.root, { recursive: true, force: true })
  }
  // Corrupt JSON.
  const corrupt = await makeCacheTree('corrupt')
  try {
    await mkdir(join(corrupt.cacheDir, 'pending'), { recursive: true })
    await writeFile(join(corrupt.cacheDir, 'pending', 'update-info.json'), '{not json', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(corrupt.cacheDir, '0.2.2'), false)
    assert.equal(existsSync(join(corrupt.cacheDir, 'pending', 'update-info.json')), true)
  } finally {
    await rm(corrupt.root, { recursive: true, force: true })
  }
  // Version-less file name.
  const noVersion = await makeCacheTree('no-version')
  try {
    await writePendingInfo(noVersion.cacheDir, 'dsh-chamber-latest-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(noVersion.cacheDir, '0.2.2'), false)
  } finally {
    await rm(noVersion.root, { recursive: true, force: true })
  }
  // Beta semantics: running stable 0.2.2 makes a pending 0.2.2-beta.1 stale
  // (superseded); running 0.2.2-beta.1 keeps a pending stable 0.2.2.
  const betaStale = await makeCacheTree('beta-stale')
  try {
    await writePendingInfo(betaStale.cacheDir, 'dsh-chamber-0.2.2-beta.1-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(betaStale.cacheDir, '0.2.2'), true)
    assert.equal(existsSync(betaStale.cacheDir), false)
  } finally {
    await rm(betaStale.root, { recursive: true, force: true })
  }
  const betaFresh = await makeCacheTree('beta-fresh')
  try {
    await writePendingInfo(betaFresh.cacheDir, 'dsh-chamber-0.2.2-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(betaFresh.cacheDir, '0.2.2-beta.1'), false,
      'a pending stable 0.2.2 is still newer than a running 0.2.2-beta.1')
  } finally {
    await rm(betaFresh.root, { recursive: true, force: true })
  }
})

async function waitFor(condition: () => boolean, tries = 100): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return condition()
}

test('cleanupStaleUpdateCache tolerates shape-less JSON content and removal failures (never throws)', async () => {
  // `null`, arrays and scalars are all VALID JSON that JSON.parse returns
  // happily — reading `.fileName` off them used to throw, breaking the
  // "never throws / keep when not provably stale" contract (2026-12 review).
  for (const content of ['null', '[]', '"a string"', '42', '{}', '{"sha512":"abc"}', '{"fileName":42}']) {
    const { root, cacheDir } = await makeCacheTree('shape-guard')
    try {
      await mkdir(join(cacheDir, 'pending'), { recursive: true })
      await writeFile(join(cacheDir, 'pending', 'update-info.json'), content, 'utf8')
      await writeFile(join(cacheDir, 'update.zip'), 'x', 'utf8')
      assert.equal(await cleanupStaleUpdateCache(cacheDir, '0.2.2'), false, `content ${content} must keep the cache`)
      assert.equal(existsSync(join(cacheDir, 'update.zip')), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  // A failing removal reports false instead of throwing.
  const failing = await makeCacheTree('rm-fail')
  try {
    await writePendingInfo(failing.cacheDir, 'dsh-chamber-0.2.2-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(failing.cacheDir, '0.2.2', {
      removeTree: async () => { throw new Error('EACCES /private/var') },
    }), false)
    assert.equal(existsSync(failing.cacheDir), true, 'a failed removal leaves the cache intact')
  } finally {
    await rm(failing.root, { recursive: true, force: true })
  }
})

test('controller startup cleans a stale injected cache dir and skips when disabled', async () => {
  const stale = await makeCacheTree('controller-stale')
  try {
    await writePendingInfo(stale.cacheDir, 'dsh-chamber-0.2.2-arm64-mac.zip')
    const { controller } = makeController({ version: '0.2.2', deps: { staleCache: { cacheDir: stale.cacheDir } } })
    assert.equal(controller.state().phase, 'idle', 'controller construction is not affected by the cleanup')
    assert.equal(await waitFor(() => !existsSync(stale.cacheDir)), true,
      'the controller must asynchronously remove the stale cache dir')
  } finally {
    await rm(stale.root, { recursive: true, force: true })
  }
  // { cacheDir: null } disables the cleanup entirely.
  const kept = await makeCacheTree('controller-kept')
  try {
    await writePendingInfo(kept.cacheDir, 'dsh-chamber-0.2.2-arm64-mac.zip')
    const { controller } = makeController({ version: '0.2.2', deps: { staleCache: { cacheDir: null } } })
    assert.equal(controller.state().phase, 'idle')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(existsSync(kept.cacheDir), true, 'a null staleCache override must disable the cleanup')
  } finally {
    await rm(kept.root, { recursive: true, force: true })
  }
})
