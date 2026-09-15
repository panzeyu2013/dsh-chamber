/**
 * updater.ts — part 2: the restart-and-install leg — quitAndInstall arming
 * rules, the native before-quit-for-update bridge, restart-failure reporting
 * and the stall watchdog / win32 latch.
 *
 * Sibling parts: updater.test.ts, updater-cache-maintenance.test.ts
 * (shared harness in test/support/updater-harness.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createUpdateController } from '../../updater.ts'
import { silentLogger, FakeAutoUpdater, makeController, waitFor } from '../support/updater-harness.ts'

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

test('restartAndInstall fires the arming hook immediately before quitAndInstall, never on refusals', async () => {
  // 2026-12 macOS close-order fix: the host's close-to-tray exception must be
  // armed by the LAST synchronous instruction before quitAndInstall (macOS
  // closes every window INSIDE that call), and only when the restart is really
  // being armed — otherwise a refusal would arm a quit that never happens.
  const fake = new FakeAutoUpdater()
  const order: string[] = []
  const controller = createUpdateController(
    {
      version: '0.1.5',
      logger: silentLogger,
      onQuitAndInstallArmed: () => order.push(`hook(quitAndInstallCalls=${fake.quitAndInstallCalls})`),
    },
    {
      app: { isPackaged: true },
      autoUpdater: fake,
      platform: 'darwin',
      linuxAppImage: null,
      probeMacSignature: async () => true,
    },
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(controller.state().installBlockedReason, null, 'the injected Developer ID probe cleared the mac gate')
  fake.emit('update-available', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'no downloaded update to install' })
  assert.deepEqual(order, [], 'a phase refusal must never reach the hook')
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: true })
  assert.deepEqual(order, ['hook(quitAndInstallCalls=0)'],
    'the hook must run immediately BEFORE quitAndInstall — arming after the returned ok:true would be too late on macOS')
  assert.equal(fake.quitAndInstallCalls, 1)
  assert.deepEqual(controller.restartAndInstall(), { ok: false, error: 'restart already in progress' })
  assert.equal(order.length, 1, 'the already-armed refusal must not re-fire the hook')
})

test('native autoUpdater before-quit-for-update is bridged to the host (close-order + quit fallback)', () => {
  // 2026-12 macOS fix: Electron's native updater emits this INSIDE
  // quitAndInstall(), before it closes every window — the host arms its
  // close-to-tray exception and bounds the quit on it.
  const fake = new FakeAutoUpdater()
  const native = new EventEmitter()
  const calls: string[] = []
  createUpdateController(
    { version: '0.1.5', logger: silentLogger, onNativeUpdaterQuitting: () => calls.push('native-quitting') },
    {
      app: { isPackaged: true },
      autoUpdater: fake,
      platform: 'darwin',
      linuxAppImage: null,
      nativeAutoUpdater: native,
      probeMacSignature: async () => true,
    },
  )
  assert.deepEqual(calls, [], 'the bridge must not fire without a native quit')
  native.emit('before-quit-for-update')
  native.emit('before-quit-for-update')
  assert.deepEqual(calls, ['native-quitting', 'native-quitting'], 'every occurrence is reported (a late native quit must re-arm the host)')
  // No callback (or no native updater at all — the Linux shape) is a silent
  // no-op: the bridge must never manufacture host work on its own.
  const other = new EventEmitter()
  createUpdateController(
    { version: '0.1.5', logger: silentLogger },
    { app: { isPackaged: true }, autoUpdater: new FakeAutoUpdater(), platform: 'darwin', linuxAppImage: null, nativeAutoUpdater: other, probeMacSignature: async () => true },
  )
  other.emit('before-quit-for-update')
})

test('the native quit event RE-ANCHORS the stall watchdog: it must not fire mid-exit, but must still fire', async () => {
  // Two properties, and a fix that only satisfies one is a bug:
  //  (a) the Click-anchored 60s deadline must not land inside the native quit leg
  //      (a stall push there makes the host release the arming and cancels the
  //      only thing that finishes the quit — review B4);
  //  (b) the watchdog stays the ONLY release for `restartInFlight` on a native leg
  //      that neither quits nor errors, so it must still fire eventually —
  //      disabling it leaves the restart button answering "already in progress"
  //      for the rest of the process (self-review round 2).
  const fake = new FakeAutoUpdater()
  const native = new EventEmitter()
  const calls: string[] = []
  const controller = createUpdateController(
    { version: '0.1.5', logger: silentLogger, onNativeUpdaterQuitting: () => calls.push('native-quitting') },
    {
      app: { isPackaged: true },
      autoUpdater: fake,
      platform: 'darwin',
      linuxAppImage: null,
      nativeAutoUpdater: native,
      probeMacSignature: async () => true,
      restartWatchdogMs: 1000,
    },
  )
  assert.equal(await waitFor(() => controller.state().installBlockedReason === null), true,
    'the injected mac signature probe must clear the install block')
  fake.emit('update-downloaded', { version: '0.2.0' })
  assert.deepEqual(controller.restartAndInstall(), { ok: true }, 'the restart arms the fallback path')
  await new Promise(resolve => setTimeout(resolve, 600))
  native.emit('before-quit-for-update')
  assert.deepEqual(calls, ['native-quitting'], 'the host is still told the native leg is quitting')
  // Past the CLICK-anchored deadline (1000ms), before the re-anchored one (1600ms).
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.equal(controller.state().restartFailureText, undefined,
    'the watchdog must not publish a stall while the native quit leg is in flight — its deadline moves with the event')
  // ...and it must still publish one: this is the flight's only release here.
  assert.equal(await waitFor(() => controller.state().restartFailureText !== undefined), true,
    'a native leg that never completes must still end in the honest stall surface')
  assert.ok(controller.state().restartFailureText!.includes('stalled'), 'the watchdog text says the restart stalled')
  assert.deepEqual(controller.restartAndInstall(), { ok: true },
    'the release must leave an in-place retry available (never a permanently "in progress" restart)')
})

test('a native-updater subscription failure is loud but never breaks controller creation', () => {
  const warnings: string[] = []
  const controller = createUpdateController(
    {
      version: '0.1.5',
      logger: { log: () => {}, warn: (...args: unknown[]) => warnings.push(args.join(' ')), error: () => {} },
      onNativeUpdaterQuitting: () => { throw new Error('must never be reached') },
    },
    {
      app: { isPackaged: false },
      autoUpdater: new FakeAutoUpdater(),
      platform: 'darwin',
      linuxAppImage: null,
      nativeAutoUpdater: { on() { throw new Error('no native updater here') } },
    },
  )
  assert.equal(controller.state().phase, 'idle', 'the controller still works — the hook path covers the click itself')
  assert.ok(warnings.some(line => line.includes('无法订阅原生更新器退出事件')), 'the failure is logged, not swallowed')
})

test('real-electron resolution is guarded: the electron package is never loaded outside the Electron runtime', () => {
  // The `electron` npm specifier, when its dist/ is absent (the shared-dist
  // worktree shape), SPAWNS A ~100MB BINARY DOWNLOAD on load. Every real-value
  // path in updater.ts is therefore gated: tests inject deps, and a wiring bug
  // that reaches the real branch must fail loudly instead of downloading.
  if (process.versions.electron !== undefined) return // inside Electron the real branch is the legitimate one
  assert.throws(
    () => createUpdateController({ version: '0.1.5', logger: silentLogger }),
    /unavailable outside the Electron runtime/,
    'a controller without injected deps must refuse to load the electron package',
  )
  // Requesting the native quit bridge without an injected native updater
  // resolves to null (no bridge) instead of loading the package.
  const controller = createUpdateController(
    { version: '0.1.5', logger: silentLogger, onNativeUpdaterQuitting: () => {} },
    { app: { isPackaged: false }, autoUpdater: new FakeAutoUpdater(), platform: 'linux', linuxAppImage: null },
  )
  assert.equal(controller.state().phase, 'idle')
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

test('restartAndInstall: every post-hook not-armed result republishes, even over a stale carry (host release rule)', () => {
  // The host's close-to-tray exception (2026-12 macOS fix) is armed by the
  // hook and released by a restartFailureText PUSH. A silent falsy return with
  // a stale carry standing must therefore still publish — otherwise a host
  // latch keyed on the push would stay armed forever.
  const { fake, controller } = makeController()
  fake.emit('update-downloaded', { version: '0.2.0' })
  let publishes = 0
  controller.subscribe(state => { if (state.restartFailureText !== undefined) publishes += 1 })
  fake.quitAndInstallResult = false
  assert.equal(controller.restartAndInstall().ok, false)
  assert.equal(publishes, 1)
  // The stale carry is still standing (only a successful arm clears it) — the
  // second refusal must publish again instead of reusing it silently.
  assert.equal(controller.restartAndInstall().ok, false)
  assert.equal(publishes, 2, 'a post-hook refusal must always publish, never hide behind an earlier carry')
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
