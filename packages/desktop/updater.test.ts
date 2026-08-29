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
import {
  betaReleaseDownloadBase,
  createUpdateController,
  isAllowedReleaseUrl,
  openReleasePage,
  resolveGithubBetaFeed,
  sanitizeErrorText,
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

test('installBlockedReason follows the injected platform/app (linux / darwin dev build)', () => {
  const linux = makeController({ deps: { platform: 'linux' } }).controller.state()
  assert.equal(linux.installBlockedReason, 'auto-update is not supported on this platform')
  const darwinDev = makeController({ deps: { platform: 'darwin', app: { isPackaged: false } } }).controller.state()
  assert.equal(darwinDev.installBlockedReason, 'development build')
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
    version: '0.2.0-beta.3',
    deps: {
      resolveBetaFeed: async () => {
        resolutions += 1
        return 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0-beta.4/'
      },
    },
  })
  await controller.checkNow()
  assert.equal(resolutions, 1)
  assert.equal(fake.checkCalls, 1)
  assert.deepEqual(fake.feedUrl, {
    provider: 'generic',
    url: 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0-beta.4/',
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

test('checkNow refuses loudly on linux (dir target) without touching the fake', async () => {
  const { fake, controller } = makeController({ deps: { platform: 'linux' } })
  const result = await controller.checkNow()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'auto-update is not supported on this platform')
  assert.equal(fake.checkCalls, 0)
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

test('download refuses when automatic installation is blocked (linux)', async () => {
  const { fake, controller } = makeController({ deps: { platform: 'linux' } })
  fake.emit('update-available', { version: '0.2.0' })
  const result = await controller.download()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'automatic installation blocked on this platform')
  assert.equal(fake.downloadCalls, 0)
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

test('start() on linux is inert (no timers, just a log)', () => {
  const logs: string[] = []
  const fake = new FakeAutoUpdater()
  const controller = createUpdateController(
    {
      version: '0.1.5',
      logger: { log: (...args: unknown[]) => logs.push(args.join(' ')), warn: () => {}, error: () => {} },
    },
    { app: { isPackaged: true }, autoUpdater: fake, platform: 'linux' },
  )
  controller.start()
  assert.ok(logs.some(line => line.includes('跳过更新检查')), 'linux start must log the skip and never schedule')
  assert.equal(fake.checkCalls, 0)
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
