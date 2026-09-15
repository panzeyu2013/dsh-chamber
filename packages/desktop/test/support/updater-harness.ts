/**
 * Shared updater test harness: the silent logger, the fake EventEmitter
 * electron-updater surface and the controller factory (injected app/deps/
 * version), plus the bounded condition poll.
 * Bare helper file — never registered in scripts/test.mjs.
 */

import { EventEmitter } from 'node:events'
import { createUpdateController } from '../../updater.ts'
import type { AutoUpdaterLike, UpdateController, UpdateControllerDeps } from '../../updater.ts'

export const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

/** The electron-updater surface the controller touches, faked. */
export class FakeAutoUpdater extends EventEmitter implements AutoUpdaterLike {
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

/** Default harness: win32 (no install block), dev app, stable channel. */
export function makeController(overrides: {
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

export async function waitFor(condition: () => boolean, tries = 100): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  return condition()
}
