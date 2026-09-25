/**
 * dsh-chamber desktop update controller: silent startup/6h checks (failures are log-only,
 * never block startup), autoDownload = false (a check downloads nothing; the download starts
 * only on the user's「更新」click), autoInstallOnAppQuit = true (installs on quit, no dialog).
 * Once downloaded the settings section also offers「重启并安装」(quitAndInstall → quit + install
 * + relaunch through the normal before-quit/will-quit cleanup; the update-downloaded exemption
 * passes) — macOS + Windows only: on Linux AppImage electron-updater swaps the file and spawns
 * the new instance BEFORE quitting (single-instance lock cannot survive it). quitAndInstall
 * CLOSES EVERY WINDOW FIRST, so main.ts arms its close-to-tray exception via
 * onQuitAndInstallArmed/onNativeUpdaterQuitting. macOS install needs a Developer ID signature;
 * Linux is SHAPE-gated (only a writable AppImage updates). State projection is non-secret only.
 * upstream-shaped cadence owned by update-schedule.ts (single source for both flavors:
 * 600s base ±20% jitter + exponential failure backoff capped at 1h, env-tunable via
 * DSH_DESKTOP_UPDATE_CHECK_*), plus a coalesced foreground/resume nudge (noteActivity).
 * The self-rescheduling chain is WEDGE-PROOF: idle watchdogs abandon a check/download that
 * never settles (check 60s / download 30min) so the next round is armed, a round that could
 * not run re-arms at once, and an abandoned download keeps its check-exclusion latch until
 * its promise settles; the two network classes surface as failureKind, and the optional
 * forensic journal (DSH_DESKTOP_UPDATE_JOURNAL_DIR) writes allowlisted fields only.
 */
import { execFile } from 'node:child_process'
import { describeError } from './describe-error.ts'
import { accessSync, constants, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, posix as posixPath, win32 as win32Path } from 'node:path'
import { createRequire } from 'node:module'
import type { UpdateInfo } from 'electron-updater'
import { sanitizeErrorText } from './sanitize-error.ts'
import {
  nextCheckDelay,
  resolveUpdateIdleTimeout,
  resolveUpdateScheduleConfig,
  UPDATE_FIRST_CHECK_DELAY_MS,
} from './update-schedule.ts'
import { createUpdateJournal, resolveUpdateJournalDir } from './update-journal.ts'
export { sanitizeErrorText } from './sanitize-error.ts'
import {
  fetchGithubReleases,
  isBoundedReleasesList,
  releaseDownloadBase,
  selectReleaseCandidate,
  GITHUB_OWNER,
  GITHUB_REPO,
} from './update-discovery.ts'

// electron-updater's CJS main exposes `autoUpdater` via an Object.defineProperty
// getter — an ESM named import would resolve to undefined at runtime, require()
// preserves it. Resolved LAZILY (first real use only): an injected fake is never touched.
const require = createRequire(import.meta.url)
let realAutoUpdater: AutoUpdaterLike | null = null
function getRealAutoUpdater(): AutoUpdaterLike {
  if (realAutoUpdater === null) {
    // Same hard guard as getRealApp: electron-updater's main reads the real electron app
    // at load time, so loading it outside the Electron runtime can only go wrong.
    if (process.versions.electron === undefined) throw realElectronUnavailable('electron-updater autoUpdater')
    realAutoUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater
  }
  return realAutoUpdater
}

// electron's package main is CJS: under plain node it exports the binary path STRING,
// so an ESM named import would fail to LINK; require() works on both paths. HARD GUARD:
// the `electron` specifier must never be required outside the Electron runtime — under
// plain node its index.js can SPAWN A ~100MB BINARY DOWNLOAD on load. Resolved LAZILY;
// reaching the real branch outside Electron fails loudly instead of downloading.
function realElectronUnavailable(what: string): Error {
  return new Error(`the real ${what} is unavailable outside the Electron runtime; inject UpdateControllerDeps instead`)
}

let realApp: ElectronAppLike | null = null
function getRealApp(): ElectronAppLike {
  if (realApp === null) {
    if (process.versions.electron === undefined) throw realElectronUnavailable('electron app')
    // The surface is read defensively (`dock`/`on` optional): Electron's App
    // overloads are wider than this module's narrow read face, hence the cast.
    realApp = (require('electron') as typeof import('electron')).app as unknown as ElectronAppLike
  }
  return realApp
}

/** The slice of Electron's NATIVE `autoUpdater` this module subscribes to (mac/win
 *  binding); only the quit-order signal is read — never a download/install action. */
export interface NativeAutoUpdaterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

// Electron's native autoUpdater is absent on some platform shapes (Linux has none) and
// access can throw: resolved LAZILY, defensively, at most once — a missing binding (or
// non-Electron runtime) is a permanent null (no retry storms, no binary download).
let realNativeAutoUpdater: NativeAutoUpdaterLike | null = null
let realNativeAutoUpdaterResolved = false
function getRealNativeAutoUpdater(): NativeAutoUpdaterLike | null {
  if (realNativeAutoUpdaterResolved) return realNativeAutoUpdater
  realNativeAutoUpdaterResolved = true
  if (process.versions.electron === undefined) return null
  try {
    const candidate = (require('electron') as { autoUpdater?: unknown }).autoUpdater
    if (candidate !== null && typeof candidate === 'object'
      && typeof (candidate as NativeAutoUpdaterLike).on === 'function') {
      realNativeAutoUpdater = candidate as NativeAutoUpdaterLike
    }
  } catch {
    realNativeAutoUpdater = null
  }
  return realNativeAutoUpdater
}

/** Update lifecycle phase. `up-to-date` = a check ran and found nothing newer (distinct
 *  from `idle` = not checked yet). `installing` is the NATIVE (Swift/Sparkle) phase:
 *  the Electron controller never emits it, but both flavors render from this one Union. */
export type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'

/** Non-secret update state projection (preload + renderer mirror this shape). */
export interface UpdateState {
  phase: UpdatePhase
  /** The running chamber version (desktop package.json). */
  currentVersion: string
  /** Latest version on the configured channel; null = none known yet. */
  latestVersion: string | null
  /** Feed channel (stable release, intrinsic `-beta.N`, or explicit dev beta opt-in). */
  channel: 'stable' | 'beta'
  /** Download progress percent (0–100) while downloading. */
  downloadPercent: number | null
  /** GitHub release page for the latest version (manual-install path). */
  releaseUrl: string | null
  /** Why automatic installation cannot run (platform / mac signing / Linux non-AppImage
   *  shape — evaluated ONCE at creation; fixing the env needs an app restart); null = OK. */
  installBlockedReason: string | null
  /** Non-secret error text (check/download failure); null = none. */
  error: string | null
  /** Classified failure (upstream DesktopUpdateFailureKind subset): the two
   *  network classes this mode can actually detect (idle-timeout watchdog).
   *  The renderer keeps showing `error`; this field exists so the failure is a
   *  named phase instead of a vague stall. Absent = none. */
  failureKind?: 'check-network' | 'download-network'
  /** ONE-SHOT carry: a RESTART failure surfaced while the phase stayed `downloaded` —
   *  refused arming, an 'error' event after an armed restart, or the stall watchdog.
   *  Sanitized like `error`; absent = none. Clearing rule: every subsequent push resets
   *  it UNLESS that push itself carries the field. */
  restartFailureText?: string
}

/** The subset of electron's `App` the controller reads (test-injectable).
 *  `on`/`removeListener` are the optional foreground hook (window focus); a
 *  test double without them simply never receives the focus nudge. */
export interface ElectronAppLike {
  isPackaged: boolean
  on?(event: string, listener: (...args: any[]) => void): void
  removeListener?(event: string, listener: (...args: any[]) => void): void
  /** macOS Dock 注意力（上游 update-attention.ts 的等价物；可选）。 */
  dock?: {
    bounce(kind: 'critical' | 'informational'): number
    cancel(id: number): void
  }
}

/** Linux blocked reason: any non-AppImage Linux shape keeps this exact string — the
 *  renderer「检查更新」gate keys on it, so dev/unpacked/deb never offers a check. */
export const LINUX_UPDATE_UNSUPPORTED_REASON = 'auto-update is not supported on this platform'

/** Result of the Linux AppImage capability probe; null = updates impossible. */
export type LinuxAppImageProbe = { path: string } | null

export interface LinuxAppImageProbeDeps {
  /** Default: process.env. */
  env?: Record<string, string | undefined>
  /** Default: fs.statSync — must return a Stats-like object with isFile(). */
  stat?: (path: string) => { isFile(): boolean }
  /** Default: fs.accessSync. */
  access?: (path: string, mode: number) => void
  /** `process.execPath`; default: the real value. */
  execPath?: string
}

function realProbeStat(path: string): { isFile(): boolean } {
  return statSync(path)
}

function realProbeAccess(path: string, mode: number): void {
  accessSync(path, mode)
}

/** The AppImage runtime launches the inner binary from a per-launch squashfs mount
 *  (`/tmp/.mount_*`) or extraction (`/tmp/appimage_extracted_*`); only those shapes may
 *  hold a REAL APPIMAGE — a stale inherited APPIMAGE must never open the update gate. */
function launchedFromAppImage(execPath: string): boolean {
  const parent = basename(dirname(execPath))
  return parent.startsWith('.mount') || parent.startsWith('appimage_extracted_')
}

/** Linux AppImage update capability: electron-updater's AppImageUpdater replaces the
 *  RUNNING file on quit (unlink + move), so updates are possible only when the app
 *  really started from an AppImage (launch-shape check + absolute APPIMAGE that is a
 *  regular file in a writable parent). Any probe failure = loud-null (updates stay off). */
export function probeLinuxAppImage(deps: LinuxAppImageProbeDeps = {}): LinuxAppImageProbe {
  const env = deps.env ?? process.env
  const stat = deps.stat ?? realProbeStat
  const access = deps.access ?? realProbeAccess
  const execPath = deps.execPath ?? process.execPath
  const appImagePath = env.APPIMAGE
  if (typeof appImagePath !== 'string' || appImagePath === '' || !isAbsolute(appImagePath)) return null
  if (!launchedFromAppImage(execPath)) return null
  try {
    if (!stat(appImagePath).isFile()) return null
  } catch {
    return null
  }
  // The file's PARENT directory is what the quit-replacement writes into.
  try {
    access(dirname(appImagePath), constants.W_OK)
  } catch {
    return null
  }
  return { path: appImagePath }
}

/**
 * --- Startup stale-download-cache cleanup ---
 * electron-updater never deletes downloaded update files after a successful install,
 * leaving zip + pending/ (~150-300MB/cycle); the controller cleans that at startup only
 * when the cached pending version is NOT newer than the running one, fail-conservative
 * (unresolvable dir/meta/version → cache untouched).
 * WHY whole-dir deletion is safe: chamber feeds never publish blockmaps (mac
 * .zip.blockmap dropped before finalize; Windows differentialPackage=false), so
 * update.zip is never a differential base. LATENT COUPLING: if a future release ever
 * publishes blockmaps, the stale-cache removal must preserve that base. Cache dir =
 * join(<platform cache root>, updaterCacheDirName from packaged app-update.yml).
 */

/** Real fs seams (flavor/test injection points). */
function realReadFileUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
function realRemoveTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true })
}

/** Parse `updaterCacheDirName` from the baked app-update.yml (flat YAML scalar scan).
 *  Null when absent/unreadable; the value must be a bare directory NAME — separators
 *  or dot-names would escape the cache root and are refused. */
export function updaterCacheDirNameFromYaml(content: string): string | null {
  const match = /^updaterCacheDirName:[ \t]*("[^"]*"|'[^']*'|[^#\r\n]*)/m.exec(content)
  if (match === null) return null
  let value = match[1].trim()
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    value = value.slice(1, -1)
  }
  value = value.trim()
  if (value === '' || value === '.' || value === '..'
    || value.includes('/') || value.includes('\\')) {
    return null
  }
  return value
}

/** The platform cache root electron-updater derives its cacheDir from (getAppCacheDir); pure. */
export function updaterCacheRoot(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') return env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
  if (platform === 'darwin') return join(home, 'Library', 'Caches')
  return env.XDG_CACHE_HOME ?? join(home, '.cache')
}

export interface ResolveUpdaterCacheDirDeps {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  home?: string
  /** Packaged apps carry the baked yml in resources; dev has none. */
  isPackaged?: boolean
  /** Default: process.resourcesPath (undefined under plain node / dev). */
  resourcesPath?: string
  readFile?: (path: string) => Promise<string>
}

/** Resolve electron-updater's cache dir for the CURRENT app, or null when it cannot be
 *  derived safely (dev/unpacked, missing yml, refused name, or a path that is not
 *  ABSOLUTE on the target platform — no deletion may ever run against a relative path);
 *  the absoluteness verdict uses the TARGET platform's path rules. Never throws. */
export async function resolveUpdaterCacheDir(deps: ResolveUpdaterCacheDirDeps = {}): Promise<string | null> {
  const isPackaged = deps.isPackaged ?? true
  const platform = deps.platform ?? process.platform
  const resourcesPath = deps.resourcesPath ?? (typeof process !== 'undefined' ? process.resourcesPath : undefined)
  if (!isPackaged || typeof resourcesPath !== 'string' || resourcesPath === '') return null
  const readFileUtf8 = deps.readFile ?? realReadFileUtf8
  try {
    const yml = await readFileUtf8(join(resourcesPath, 'app-update.yml'))
    const dirName = updaterCacheDirNameFromYaml(yml)
    if (dirName === null) return null
    const cacheDir = join(updaterCacheRoot(platform, deps.env, deps.home), dirName)
    if (!(platform === 'win32' ? win32Path : posixPath).isAbsolute(cacheDir)) return null
    return cacheDir
  } catch {
    return null
  }
}

/** First canonical chamber version (X.Y.Z / X.Y.Z-beta.N) inside an electron-updater
 *  cache file name (`dsh-chamber-electron-0.2.2-arm64-mac.zip` → `0.2.2`); null when
 *  none. The greedy digit-adjacency parse is safe only under the artifact naming
 *  contract (no fourth segment, no other prerelease spellings): ANY future naming
 *  change must revisit this parser and compareChamberVersions together. */
export function cachedUpdateVersion(fileName: unknown): string | null {
  if (typeof fileName !== 'string') return null
  const match = /(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?/.exec(fileName)
  if (match === null) return null
  const [fragment] = match
  const before = match.index > 0 ? fileName[match.index - 1] : ''
  const after = fileName[match.index + fragment.length] ?? ''
  if (/[0-9]/.test(before) || /[0-9]/.test(after)) return null
  return fragment
}

const CANONICAL_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/

/** Compare two canonical chamber versions: negative/zero/positive, or null when either
 *  side is not canonical (callers must treat null as "do not act"). stable > same-base beta. */
export function compareChamberVersions(left: string, right: string): number | null {
  const a = CANONICAL_VERSION.exec(left)
  const b = CANONICAL_VERSION.exec(right)
  if (a === null || b === null) return null
  for (let part = 1; part <= 3; part += 1) {
    const diff = Number(a[part]) - Number(b[part])
    if (diff !== 0) return diff
  }
  const aBeta = a[4]
  const bBeta = b[4]
  if (aBeta === undefined && bBeta === undefined) return 0
  if (aBeta === undefined) return 1 // stable > beta of the same base
  if (bBeta === undefined) return -1
  return Number(aBeta) - Number(bBeta)
}

export interface CleanupStaleUpdateCacheDeps {
  readFile?: (path: string) => Promise<string>
  removeTree?: (path: string) => Promise<void>
}

/** Remove electron-updater's whole download cache dir when the cached pending update is
 *  NOT newer than `currentVersion` (installed/obsolete); true only when something was
 *  removed. Conservatively keeps the cache when dir/meta is absent or unreadable, the
 *  file name carries no canonical version, the comparison is null, or the pending update
 *  is still newer (a legit installable download must never be deleted). Never throws. */
export async function cleanupStaleUpdateCache(
  cacheDir: string,
  currentVersion: string,
  deps: CleanupStaleUpdateCacheDeps = {},
): Promise<boolean> {
  const readFileUtf8 = deps.readFile ?? realReadFileUtf8
  const removeTree = deps.removeTree ?? realRemoveTree
  let raw: string
  try {
    raw = await readFileUtf8(join(cacheDir, 'pending', 'update-info.json'))
  } catch {
    return false // absent/unreadable → nothing provably stale
  }
  // Shape-guard the parsed content: `null` / arrays / scalars are all valid JSON —
  // anything that is not an object with a string fileName keeps the cache untouched.
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const info = parsed as { fileName?: unknown }
  const version = cachedUpdateVersion(info.fileName)
  if (version === null) return false
  const comparison = compareChamberVersions(version, currentVersion)
  if (comparison === null || comparison > 0) return false // newer → keep
  try {
    await removeTree(cacheDir)
    return true
  } catch {
    return false
  }
}

/**
 * Open-external allowlist for the settings「前往下载页」link: only this repo's GitHub
 * pages may be opened. Parsed with URL (not startsWith) so scheme/host/path-root are
 * pinned; encoded traversal is decoded/normalized, nested encoding (`%25…`) is refused
 * outright, and credentialed URLs are rejected even though URL.origin ignores userinfo.
 */
export function isAllowedReleaseUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    if (url.origin !== 'https://github.com') return false
    if (url.username !== '' || url.password !== '') return false
    // One decode suffices only when the original path has no encoded percent; reject
    // nested encoding outright (`%252f` can become `%2f` at one layer and `/` at another,
    // defeating a single-pass traversal check downstream).
    if (/%25/i.test(url.pathname)) return false
    const normalized = new URL(`https://github.com${decodeURIComponent(url.pathname)}`).pathname
    return normalized.startsWith('/panzeyu2013/dsh-chamber/')
  } catch {
    return false
  }
}

/** Await the OS handoff and report its real outcome to the renderer. */
export async function openReleasePage(
  raw: unknown,
  openExternal: (url: string) => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isAllowedReleaseUrl(raw)) return { ok: false, error: 'url not allowed' }
  try {
    await openExternal(raw)
    return { ok: true }
  } catch {
    return { ok: false, error: 'open release page failed' }
  }
}

/** The subset of electron-updater's `AppUpdater` surface the controller uses. */
export interface AutoUpdaterLike {
  on(event: string, listener: (...args: any[]) => void): unknown
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  channel: string | null
  forceDevUpdateConfig: boolean
  /** `any` (not `Record<string, unknown>`): the real AppUpdater's parameter is
   *  `PublishConfiguration | AllPublishOptions`, so a narrower type breaks structural assignment. */
  setFeedURL(options: any): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  /** electron-updater's restart-into-the-downloaded-update: quits (through
   *  before-quit/will-quit), installs and relaunches; fire-and-forget from the caller.
   *  REAL 6.8.9 SHAPE: quitAndInstall is declared void and does NOT throw on a sync
   *  failure — BaseUpdater.install() DISPATCHES 'error' and returns false (after which
   *  quitAndInstall returns without arming); MacUpdater may return with staging not yet
   *  armed (ok = "armed", quit later). Declared `unknown`: the real updater yields
   *  undefined (armed) while a fake may signal a refused arming with `false`. */
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): unknown
}

/** Test-injection seam: each member falls back to the real value, resolved LAZILY inside
 *  the factory only when the member is absent (the module stays loadable under plain node). */
export interface UpdateControllerDeps {
  /** Electron `app` (`isPackaged` + the optional focus subscription); default:
   *  the real app. Tests inject `{ isPackaged: false }` — no focus wiring. */
  app?: {
    isPackaged: boolean
    on?(event: string, listener: (...args: any[]) => void): void
    removeListener?(event: string, listener: (...args: any[]) => void): void
    dock?: {
      bounce(kind: 'critical' | 'informational'): number
      cancel(id: number): void
    }
  }
  /** Schedule/journal environment (default: process.env; tests inject). */
  env?: Record<string, string | undefined>
  /** Jitter source for the backoff (default Math.random; tests inject). */
  random?: () => number
  /** Check/download idle deadline override (default: env, then 60s; tests inject ms). */
  updateIdleTimeoutMs?: number
  /** Windows 任务栏闪烁（上游 update-attention.ts 的 flashFrame 等价物）：窗口归
   *  宿主所有，故由宿主注入；缺省 = 不闪。 */
  flashFrame?: (on: boolean) => void
  /** 主窗是否已聚焦（上游 DesktopUpdateAttention 的 parent.isFocused() 检查）：缺省 = 未知，
   *  按「没聚焦」处理；聚焦时该版本只消费提醒闩锁、不打扰（窗口归宿主所有）。 */
  isWindowFocused?: () => boolean
  /** electron-updater's `autoUpdater`; default: the real instance. */
  autoUpdater?: AutoUpdaterLike
  /** `process.platform`; default: the real platform. */
  platform?: NodeJS.Platform
  /** Linux AppImage capability (shape gate). Default: probed from real process.env.APPIMAGE + fs. */
  linuxAppImage?: LinuxAppImageProbe
  /** Resolve the exact GitHub release download base for beta checks (default = bounded releases API); a rejection fails closed before electron-updater's unsafe latest-channel fallback. */
  resolveBetaFeed?: () => Promise<string>
  /** Startup stale-download-cache override (see cleanupStaleUpdateCache). Absent →
   *  resolved at runtime from the packaged shape (resources app-update.yml + platform
   *  cache root); `{ cacheDir: null }` disables. */
  staleCache?: { cacheDir: string | null }
  /** Restart stall watchdog grace: after an armed quitAndInstall returns ok, the
   *  single-flight is released again when the process is still alive after this many ms
   *  (a no-event mac stall). 0/undefined = default 60s. */
  restartWatchdogMs?: number
  /** macOS Developer ID signature probe (default: real codesign). Injectable so the
   *  darwin restart arm and stall-retry paths are testable. */
  probeMacSignature?: () => Promise<boolean>
  /** Electron's NATIVE `autoUpdater` (mac/win binding electron-updater drives
   *  internally), read only for `before-quit-for-update` — see onNativeUpdaterQuitting. */
  nativeAutoUpdater?: NativeAutoUpdaterLike | null
}

/** Controller surface wired into main.ts (IPC handlers) and started at boot. */
export interface UpdateController {
  state(): UpdateState
  subscribe(listener: (state: UpdateState) => void): () => void
  /** Schedule the silent checks (startup delay + upstream-shaped cadence). */
  start(): void
  /** Foreground/resume nudge (window focus / powerMonitor resume). */
  noteActivity(reason: 'focus' | 'resume'): void
  /** User-confirmed download (the「更新」button): resolve {ok} or {error}. */
  download(): Promise<{ ok: true } | { ok: false; error: string }>
  /** User-initiated check (the「检查更新」button): the SAME check path as the silent check (autoDownload stays off). */
  checkNow(): Promise<{ ok: true } | { ok: false; error: string }>
  /** User-triggered restart into the downloaded update (quitAndInstall: quit + install +
   *  relaunch through the normal quit path; will-quit disposes transports/dsh first).
   *  Only a COMPLETED download on an install-capable shape may start it — core-logic enforced. */
  restartAndInstall(): { ok: true } | { ok: false; error: string }
  /** 原生更新器（Swift flavor）的异步「重启并安装」：语义同 restartAndInstall，但结果跨进程等
   *  （转发给壳内 Sparkle 标准更新窗口）；省略 = 该 flavor 无原生安装腿。 */
  restartAndInstallAsync?(): Promise<{ ok: true } | { ok: false; error: string }>
}

/** The update feed repository (single source: update-discovery.ts). */
export { GITHUB_OWNER, GITHUB_REPO } from './update-discovery.ts'
/** Windows 任务栏注意力（2026-12 复审方向 E F8）：`UpdateControllerDeps.flashFrame`
 *  的宿主 seam。窗口归宿主所有（updater.ts 不 import electron），宿主在
 *  createUpdateController 的构造对象里接上它，注意力路径只负责调用（调用点已有
 *  try/catch，宿主 seam 自身绝不把异常反噬进更新状态机）。
 *
 *  - 只在 win32 驱动窗口：macOS 的注意力由既有的 app.dock.bounce 承担，
 *    BrowserWindow.flashFrame 在 darwin 同样会弹 Dock——再调用一次就是双触发；
 *  - 无窗口 / 窗口已销毁：静默（绝不抛）——更新检查在窗口生命周期之外照常运行；
 *  - platform 与 window 都是注入参数，故 win32 / darwin / 无窗三分支可直测。 */
export interface FlashFrameWindowLike {
  flashFrame(on: boolean): void
  isDestroyed?(): boolean
}

export function flashUpdateAttentionWindow(
  on: boolean,
  deps: { platform?: NodeJS.Platform; window?: FlashFrameWindowLike | null } = {},
): void {
  const platform = deps.platform ?? process.platform
  if (platform !== 'win32') return
  const window = deps.window ?? null
  if (window === null) return
  if (window.isDestroyed?.() === true) return
  window.flashFrame(on)
}


/** The silent re-check cadence (first delay / interval / jitter / failure
 *  backoff) is owned by update-schedule.ts (upstream DSH_DESKTOP_UPDATE_CHECK_*
 *  envs) so the Electron and Swift flavors cannot drift apart. */
/** Restart stall-watchdog grace: the armed quit (win: setImmediate app.quit; mac: native
 *  staging) is normally imminent; after this window the single-flight must not stay armed. */
const RESTART_WATCHDOG_DEFAULT_MS = 60_000
/** Honest text for the watchdog stall / a silent falsy arming refusal. Constant, sanitized. */
const RESTART_NOT_ARMED_TEXT = 'the app restart did not proceed (quitAndInstall returned without arming); the restart button is re-enabled — try again'
/** Watchdog-stall text: armed restart produced no quit AND no error within the grace window. */
const RESTART_STALL_TEXT = 'the app restart stalled (no quit and no error within the grace period); the restart button is re-enabled — try again'
/** win32 post-stall refusal text: the previous armed attempt's quit never completed, so
 *  re-entering quitAndInstall cannot arm anything (BaseUpdater's internal quit latch is
 *  still set) and could re-spawn a duplicate installer; the per-boot latch keeps the refusal. */
const RESTART_STALLED_REFUSAL_TEXT = 'the app quit from the previous restart did not complete; close the app to finish the install, then retry'

function isBetaVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-beta\.(0|[1-9]\d*)$/.test(version)
}

function resolveChannel(version: string): 'stable' | 'beta' {
  // A packaged beta prerelease is intrinsically a beta install; requiring an env override would make a real beta silently query stable.
  return isBetaVersion(version) || process.env.DSH_CHAMBER_UPDATE_CHANNEL === 'beta'
    ? 'beta'
    : 'stable'
}

/** Select an exact prerelease asset base: never contains a `latest` path and a
 *  malformed/draft/stable release can never become a feed; shared selection comes from
 *  update-discovery.ts, only the no-candidate failure is updater-specific. */
export function betaReleaseDownloadBase(releases: unknown): string {
  if (!isBoundedReleasesList(releases)) throw new Error('invalid GitHub releases response')
  const selected = selectReleaseCandidate(releases, 'beta')
  if (selected === null) throw new Error('no published beta release is available')
  return releaseDownloadBase(selected.tag)
}

/** Public GitHub discovery used only for beta: query the bounded releases collection,
 *  then switch electron-updater to an exact-tag GenericProvider so GitHubProvider can
 *  never fall back from beta.yml to latest.yml. */
export async function resolveGithubBetaFeed(
  request: typeof fetch = globalThis.fetch,
  timeoutMs = 10_000,
): Promise<string> {
  const releases = await fetchGithubReleases(request, {
    timeoutMs,
    unavailableMessage: 'beta update discovery is unavailable',
    failureLabel: 'beta update discovery failed',
  })
  return betaReleaseDownloadBase(releases)
}

function resolveRuntimeBetaFeed(): Promise<string> {
  // Electron net.fetch inherits the app's proxy/session policy; resolved lazily so
  // injected tests never load Electron. HARD GUARD: requiring `electron` outside the
  // Electron runtime can spawn a ~100MB binary download, so fail loudly here.
  if (process.versions.electron === undefined) throw realElectronUnavailable('electron net.fetch')
  const electron = require('electron') as typeof import('electron')
  const request = typeof electron === 'object' && typeof electron.net?.fetch === 'function'
    ? electron.net.fetch.bind(electron.net) as typeof fetch
    : globalThis.fetch
  return resolveGithubBetaFeed(request)
}

/** Build the release-page projection from the FEED's version — untrusted, so a
 *  non-semver-shaped version yields null (no fabricated URL); opening is gated by isAllowedReleaseUrl. */
export function releaseUrlFor(version: string): string | null {
  if (typeof version !== 'string' || version === '' || version.length > 128
    || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    return null
  }
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${version}`
}

/**
 * Platform/install-shape-level install-block reason known WITHOUT probing (linux
 * non-AppImage / dev mac). macOS packaged is probed asynchronously (signature); until it
 * resolves it stays blocked — fail-closed, so a renderer call racing startup cannot begin
 * a download before the Developer ID verdict exists. Linux AppImage passes the shape gate.
 */
function platformBlockedReason(platform: NodeJS.Platform, app: ElectronAppLike, linuxAppImage: LinuxAppImageProbe): string | null {
  if (platform === 'linux') {
    return app.isPackaged && linuxAppImage !== null ? null : LINUX_UPDATE_UNSUPPORTED_REASON
  }
  if (platform !== 'darwin') return null
  if (!app.isPackaged) return 'development build'
  return 'verifying Developer ID signature'
}

/**
 * Whether the running macOS app carries a Developer ID signature. Squirrel.Mac requires
 * one for auto-install (ad-hoc builds cannot); `codesign -dv` writes its verdict to
 * STDERR, so both streams are read.
 */
function probeMacDeveloperIdSignature(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('codesign', ['-dv', '--verbose=4', process.execPath], { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error !== null) {
        resolve(false)
        return
      }
      resolve((stdout + stderr).includes('Authority=Developer ID'))
    })
  })
}

export interface UpdateControllerOptions {
  /** The running chamber version (desktop package.json, read by main.ts). */
  version: string
  logger: {
    log: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  /** User-triggered「重启并安装」arming hook, called SYNCHRONOUSLY immediately before
   *  quitAndInstall — the moment the updater starts shutting the app down. On macOS that
   *  call CLOSES EVERY WINDOW FIRST (before-quit then runs only once they are closed), so
   *  the host arms its close-to-tray exception here: a hidden close aborts the
   *  install/relaunch and strands the process. Never called on a refusal path (nothing
   *  armed); after arming, failures publish the one-shot restartFailureText carry. */
  onQuitAndInstallArmed?: () => void
  /** Electron's NATIVE updater is shutting the app down right now (its
   *  `before-quit-for-update`, emitted inside quitAndInstall before it closes every
   *  window). Two host duties: (1) arm the close-to-tray exception for THIS close too,
   *  even if an earlier arming was released; (2) bound the quit — the native macOS leg
   *  closes the windows and does NOT reliably reach app.quit(), and this event only fires
   *  once Squirrel has the update STAGED, so terminating installs it. Called every
   *  occurrence, never gated on a prior click. */
  onNativeUpdaterQuitting?: () => void
  /** Windows taskbar attention seam (upstream update-attention.ts flashFrame): the window
   *  belongs to the host, so the host injects it here; absent = no flash. Off win32 the
   *  seam is a no-op — macOS keeps its own app.dock.bounce. */
  flashFrame?: (on: boolean) => void
  /** Whether the host window is focused right now (upstream parent.isFocused()): the
   *  host owns the window; absent = unknown, treated as not focused. */
  isWindowFocused?: () => boolean
}

export function createUpdateController(options: UpdateControllerOptions, deps?: UpdateControllerDeps): UpdateController {
  const { version, logger } = options
  // Real values resolved LAZILY only when the corresponding dep is absent: an injected
  // test never touches the real electron app/updater or process.platform.
  const app = deps?.app ?? getRealApp()
  const autoUpdater = deps?.autoUpdater ?? getRealAutoUpdater()
  const platform = deps?.platform ?? process.platform
  const linuxAppImage = deps?.linuxAppImage !== undefined ? deps.linuxAppImage : probeLinuxAppImage()
  const channel = resolveChannel(version)
  // Upstream-shaped cadence + opt-in evidence journal (both env-tunable; see the
  // module headers). Invalid env never throws at boot: loud warning + defaults.
  const scheduleEnv = deps?.env ?? process.env
  const scheduleResolution = resolveUpdateScheduleConfig(scheduleEnv)
  for (const problem of scheduleResolution.problems) {
    logger.warn('[updater] ' + problem + '（已回退默认检查节奏）')
  }
  const schedule = scheduleResolution.config
  const journalDir = resolveUpdateJournalDir(scheduleEnv)
  if (journalDir.problem !== null) logger.warn('[updater] ' + journalDir.problem + '（更新取证关闭）')
  const journal = createUpdateJournal({ dir: journalDir.dir, version, logger })
  const random = deps?.random ?? Math.random
  const idleResolution = resolveUpdateIdleTimeout(scheduleEnv)
  if (idleResolution.problem !== null) logger.warn('[updater] ' + idleResolution.problem + '（已回退默认 60s）')
  const idleTimeoutMs = deps?.updateIdleTimeoutMs ?? idleResolution.timeoutMs
  // Host-injected attention seam: the options object is the public shape main.ts uses,
  // the deps object is the test/embedding seam — either may carry it.
  const flashFrame = options.flashFrame ?? deps?.flashFrame
  const isWindowFocused = options.isWindowFocused ?? deps?.isWindowFocused
  // Late events from an abandoned (timed-out) check must not resurrect its
  // result; cleared when a new check starts. Download events are unaffected.
  let ignoreAbandonedCheckEvents = false
  const checkScoped = <A extends unknown[]>(handler: (...args: A) => void): ((...args: A) => void) =>
    (...args: A) => {
      if (ignoreAbandonedCheckEvents) {
        logger.warn('[updater] 忽略超时检查的迟到事件')
        return
      }
      handler(...args)
    }
  const resolveBetaFeed = deps?.resolveBetaFeed ?? resolveRuntimeBetaFeed
  const probeMacSignature = deps?.probeMacSignature ?? probeMacDeveloperIdSignature
  // Resolved ONLY when the host asked for the native quit bridge: a controller without
  // that callback must not touch electron at all (the specifier's load can download a binary).
  const nativeAutoUpdater = options.onNativeUpdaterQuitting === undefined
    ? null
    : deps?.nativeAutoUpdater !== undefined ? deps.nativeAutoUpdater : getRealNativeAutoUpdater()

  // Native quit-order bridge: the native updater emits `before-quit-for-update` INSIDE
  // quitAndInstall — before it closes every window and long before any `before-quit`; the
  // host needs that instant to keep closes from hiding and to drive a real quit. Subscription
  // failures are loud-but-harmless: the arming hook still covers the click.
  if (nativeAutoUpdater !== null) {
    try {
      nativeAutoUpdater.on('before-quit-for-update', () => {
        // The quit leg is REAL: the native updater is closing the windows, so the no-event
        // stall watchdog must not fire DURING it — its deadline is anchored on the CLICK
        // while the host fallback is anchored on THIS event. RE-ANCHOR, never disable: this
        // watchdog is the ONLY release for restartInFlight when the native leg neither quits
        // nor errors; clearing it would leave the single-flight armed forever (the restart
        // button answering "in progress" with no stall text and no retry). Re-arming the same
        // grace keeps both properties: it cannot fire inside the quit window, yet a leg that
        // never completes still ends in the honest stall surface with an in-place retry.
        armRestartWatchdog()
        options.onNativeUpdaterQuitting?.()
      })
    } catch (error) {
      const message = describeError(error)
      logger.warn('[updater] 无法订阅原生更新器退出事件（本次重启只能依赖 arming hook）：', sanitizeErrorText(message))
    }
  }

  let state: UpdateState = {
    phase: 'idle',
    currentVersion: version,
    latestVersion: null,
    channel,
    downloadPercent: null,
    releaseUrl: null,
    installBlockedReason: platformBlockedReason(platform, app, linuxAppImage),
    error: null,
  }
  const listeners = new Set<(state: UpdateState) => void>()
  const setState = (patch: Partial<UpdateState>): void => {
    // restartFailureText clearing rule: EVERY push resets it UNLESS the push itself carries
    // the field (failure push or explicit undefined clear); a stale restart failure can
    // never leak into a later phase's projection.
    const next = { ...state, ...patch }
    if (!('restartFailureText' in patch)) next.restartFailureText = undefined
    // Same one-shot rule for the classified failure: every push clears it
    // unless that push itself carries failureKind (the watchdog failures).
    if (!('failureKind' in patch)) next.failureKind = undefined
    state = next
    for (const listener of listeners) listener(state)
    journal?.record(state)
  }
  // macOS packaged: probe asynchronously without blocking startup, but keep download fail-closed until a valid Developer ID verdict.
  if (platform === 'darwin' && app.isPackaged) {
    void probeMacSignature().then((hasDeveloperId) => {
      setState({ installBlockedReason: hasDeveloperId ? null : 'missing Developer ID signature' })
    })
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // Beta channel: without allowPrerelease, electron-updater's GitHub provider resolves the
  // latest NON-PRERELEASE release and looks for the channel yml there — a beta build would
  // 404 on beta.yml and never find updates; enable it for prerelease builds or env opt-in.
  autoUpdater.allowPrerelease = channel === 'beta'
  // A packaged `-beta.N` build is pinned to beta from its own version. Before every beta
  // check runCheck replaces the baked GitHub provider with an exact-tag GenericProvider so
  // electron-updater cannot fall back from beta.yml to latest.yml.
  if (channel === 'beta') autoUpdater.channel = 'beta'
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO })
  }
  // electron-updater's channel setter RESETS allowDowngrade: the no-silent-downgrade invariant must be re-asserted AFTER any channel assignment.
  autoUpdater.allowDowngrade = false

  // The「重启并安装」action is fire-and-forget: on success the flag is deliberately NOT
  // reset (the process is quitting); only a FAILURE path resets it for an in-place retry.
  let restartInFlight = false
  // win32 stall latch: set when the watchdog fires, i.e. an ARMED quit never completed.
  // electron-updater's own quit latch is still set while this process is alive, so a win32
  // re-entry of quitAndInstall cannot arm anything and must not even be attempted.
  // NEVER cleared in-process — only a real quit/install (per-boot controller) can reset it.
  let restartStalled = false
  // No-event stall watchdog: armed on every successful restart arming; fires once if the
  // process is still alive after the grace; unref'd, cleared on every release/re-arm so a
  // stale deadline can never kill a LATER attempt (the fire re-checks the flag).
  let restartWatchdog: ReturnType<typeof setTimeout> | null = null
  const restartWatchdogMs = deps?.restartWatchdogMs !== undefined && deps.restartWatchdogMs > 0
    ? deps.restartWatchdogMs
    : RESTART_WATCHDOG_DEFAULT_MS
  function clearRestartWatchdog(): void {
    if (restartWatchdog !== null) {
      clearTimeout(restartWatchdog)
      restartWatchdog = null
    }
  }
  function releaseRestartFlight(): void {
    restartInFlight = false
    clearRestartWatchdog()
  }
  function armRestartWatchdog(): void {
    clearRestartWatchdog()
    restartWatchdog = setTimeout(() => {
      restartWatchdog = null
      // Only act when THIS attempt is still in flight — a release/re-arm invalidates the stale deadline.
      if (!restartInFlight) return
      // Record the stall BEFORE releasing — a win32 retry is then refused at
      // restartAndInstall's gate (electron-updater's own quit latch is still set).
      restartStalled = true
      releaseRestartFlight()
      logger.warn('[updater] 重启停滞：宽限期内既未退出也未报错，已释放重启单飞（可重试）')
      setState({ restartFailureText: RESTART_STALL_TEXT })
    }, restartWatchdogMs)
    restartWatchdog.unref?.()
  }

  // C2 residual race (2026-12 复审方向 C): a check that was already in flight
  // BEFORE the download finished — the post-stall latch cannot stop it, it
  // started earlier — may still deliver its result. A check RESULT must never
  // clobber the terminal download phases (exactly the two phases runCheck gates
  // on: `downloaded` is final for this version, `downloading` is
  // mid-transition). Without this guard a late `update-not-available` after a
  // late `update-downloaded` regresses `downloaded` to `up-to-date` and wipes
  // latestVersion — losing the「重启并安装」row and the before-quit exemption,
  // the exact regression the 2026-08 downloadInFlight flag exists to prevent.
  // The result is dropped (loud), never projected.
  const downloadPhaseIsFinal = (): boolean => state.phase === 'downloaded' || state.phase === 'downloading'
  autoUpdater.on('checking-for-update', checkScoped(() => setState({ phase: 'checking', error: null })))
  autoUpdater.on('update-available', checkScoped((info: UpdateInfo) => {
    if (downloadPhaseIsFinal()) {
      logger.warn('[updater] 忽略迟到的检查结果：下载相位 ' + state.phase + ' 已是终局')
      return
    }
    setState({
      phase: 'available',
      latestVersion: info.version,
      downloadPercent: null,
      releaseUrl: releaseUrlFor(info.version),
      error: null,
    })
  }))
  autoUpdater.on('update-not-available', checkScoped(() => {
    if (downloadPhaseIsFinal()) {
      logger.warn('[updater] 忽略迟到的检查结果：下载相位 ' + state.phase + ' 已是终局')
      return
    }
    setState({ phase: 'up-to-date', latestVersion: null, downloadPercent: null, releaseUrl: null, error: null })
  }))
  autoUpdater.on('download-progress', (progress) => {
    lastDownloadProgressAt = Date.now()
    // 停滞判定之后又来了分片：如实撤回判定（setState 不带 failureKind 即清掉它），
    // 并且不重排计时器也仍然受保护——计时器在判定时没有停表。
    if (downloadTimedOut) {
      logger.warn('[updater] 判定停滞之后下载恢复——撤回失败判定并继续观察')
      downloadTimedOut = false
      // 判定时放开了单飞（允许用户重试）；恢复意味着下载确实还在跑，收回单飞语义。
      downloadInFlight = true
      // C2: 下载确实活着 → 停滞待决撤销（检查排除交回给在飞单飞）。
      stalledDownloadGeneration = null
    }
    // `downloaded` is terminal (the checkNow/download phase gates rely on
    // it): a progress event racing AFTER update-downloaded (electron-updater
    // normally never emits one, but an out-of-order delivery costs nothing to
    // guard) must not regress the phase back to `downloading`.
    if (state.phase === 'downloaded') return
    setState({ phase: 'downloading', downloadPercent: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    if (downloadTimedOut) {
      logger.warn('[updater] 看门狗判定停滞之后仍收到下载完成——接受这次成功（不隐藏真实结果）')
    }
    stopDownloadWatchdog()
    downloadTimedOut = false
    // C2: 下载已真实完成 → 该代际的停滞待决终结（底层 promise 的结算由
    // download() 的 finally 兜底；此后相位 downloaded 本来就排除一切检查）。
    stalledDownloadGeneration = null
    setState({ phase: 'downloaded', latestVersion: info.version, downloadPercent: 100, error: null })
    // 就绪注意力（上游 update-attention.ts）：每目标一次，聚焦即清。
    raiseUpdateAttention(info.version)
  })
  // Single error path for check AND download failures. LatestVersion is kept: a check
  // error leaves it null, a download error keeps it (settings shows the retry kind).
  // An error while the restart single-flight is ARMED — or at phase `downloaded` with
  // nothing armed — is a RESTART failure, not a download/check failure: the phase stays
  // `downloaded` (never regress to 'error', which settings would misread as a DOWNLOAD
  // failure) and the sanitized text rides the one-shot restartFailureText carry. Covers
  // the async shapes (mac staging-window click; BaseUpdater dispatching 'error' + false
  // inside quitAndInstall) and the late native re-emit; releasing here unblocks in-place
  // retry. Nothing else can error at `downloaded` — runCheck()/download() gate earlier.
  autoUpdater.on('error', (error) => {
    const message = describeError(error)
    logger.warn('[updater]', message)
    if (restartInFlight || state.phase === 'downloaded') {
      releaseRestartFlight()
      setState({ restartFailureText: sanitizeErrorText(message) })
      return
    }
    setState({ phase: 'error', downloadPercent: null, error: sanitizeErrorText(message) })
  })

  // Startup hygiene: fire-and-forget best-effort cleanup — deletes only when the cached
  // pending version is NOT newer than this run's, resolves nothing in dev, never blocks boot.
  if (deps?.staleCache !== undefined) {
    const cacheDir = deps.staleCache.cacheDir
    if (cacheDir !== null) {
      void cleanupStaleUpdateCache(cacheDir, version).then((removed) => {
        if (removed) logger.log('[updater] 已清理已安装版本的更新缓存：', cacheDir)
        // Guarded catch mirroring the real-branch hygiene: cleanup never throws by
        // contract, but a seam/logger must not turn it into an unhandled rejection.
      }).catch((error) => {
        const message = describeError(error)
        logger.warn('[updater] 更新缓存清理失败（已忽略）：', message)
      })
    }
  } else {
    void (async () => {
      try {
        const cacheDir = await resolveUpdaterCacheDir({
          isPackaged: app.isPackaged,
          platform,
          resourcesPath: typeof process !== 'undefined' ? process.resourcesPath : undefined,
        })
        if (cacheDir === null) return
        const removed = await cleanupStaleUpdateCache(cacheDir, version)
        if (removed) logger.log('[updater] 已清理已安装版本的更新缓存：', cacheDir)
      } catch (error) {
        const message = describeError(error)
        logger.warn('[updater] 更新缓存清理失败（已忽略）：', message)
      }
    })()
  }

  let checking = false
  // A download in flight keeps phase `available` until the first progress event: a
  // periodic re-check started in that window would pass the phase gate and, resolving
  // after the download, clobber `downloaded` back (losing the row AND the quit exemption).
  let downloadInFlight = false
  // C2 (2026-12 复审方向 C): a stalled download's underlying electron-updater
  // promise CANNOT be aborted. The stall judgment must release `downloadInFlight`
  // (the user has to be able to retry) — but it must NOT release the
  // check-exclusion: a check started in the post-stall window races the
  // abandoned download, and its late `update-not-available` would clobber the
  // `downloaded` phase that a late `update-downloaded` legitimately produced
  // (losing the「重启并安装」row and the before-quit exemption — exactly the
  // regression the 2026-08 downloadInFlight flag exists to prevent).
  // `stalledDownloadGeneration` names the abandoned attempt whose promise is
  // still pending; checks stay excluded until that promise settles (success or
  // failure), until the download demonstrably resumes (a progress event), or
  // until the user explicitly retries download() (which clears the latch and
  // re-arms the watchdog). `downloadGeneration` stamps every attempt so a
  // settling OLD promise can never release a NEW retry's flight/watchdog.
  let downloadGeneration = 0
  let stalledDownloadGeneration: number | null = null
  const downloadStallPending = (): boolean => stalledDownloadGeneration !== null
  // Upstream-shaped scheduling (update-schedule.ts owns the policy): a
  // self-rescheduling timer whose delay grows on consecutive failures and is
  // jittered, plus a coalesced foreground/resume nudge. Replaces the fixed
  // 6h setInterval (2026-09 parity batch).
  let started = false
  let scheduleTimer: ReturnType<typeof setTimeout> | null = null
  let lastCheckCompletedAt: number | null = null
  let checkAttempt = 0

  // Update attention (upstream update-attention.ts): an update that finished
  // downloading bounces the Dock / flashes the taskbar once, and the signal is
  // cleared as soon as the window gains focus. Deliberately NO modal overlay —
  // design 11 §2 (no dialog / no system notification) still holds.
  let attentionBounceId: number | null = null
  // 上游 DesktopUpdateAttention 的版本闩锁：每个「已下载的目标版本」只提醒一次；聚焦清除
  // 只释放原生提醒、**不**重置闩锁（同一版本不会因为一次聚焦/失焦再打扰一遍）。
  // 上游另有 reset() 供「新的下载世代」重开提醒——chamber 的相位机里不需要：相位
  // downloaded 之后检查/下载都被门挡住，一个版本在本进程内只可能完成一次下载世代。
  let attentionVersion: string | null = null
  // Download idle watchdog: the download phase must not stay 'downloading'
  // forever when the feed goes silent. electron-updater cannot be aborted, so a
  // late success is accepted (logged) instead of being hidden.
  let downloadWatchdogTimer: ReturnType<typeof setInterval> | null = null
  let lastDownloadProgressAt: number | null = null
  let downloadTimedOut = false
  const stopDownloadWatchdog = (): void => {
    if (downloadWatchdogTimer !== null) {
      clearInterval(downloadWatchdogTimer)
      downloadWatchdogTimer = null
    }
    lastDownloadProgressAt = null
  }
  const startDownloadWatchdog = (): void => {
    stopDownloadWatchdog()
    downloadTimedOut = false
    lastDownloadProgressAt = Date.now()
    const tickMs = Math.max(250, Math.min(Math.floor(idleTimeoutMs / 4), 15_000))
    downloadWatchdogTimer = setInterval(() => {
      // 判定已经给过就不再重复推送；但计时器继续留着，以便抓「停滞之后又恢复」的
      // 分片（electron-updater 无法中止，下载可能还在后台跑）。
      if (downloadTimedOut || !downloadInFlight || lastDownloadProgressAt === null) return
      if (Date.now() - lastDownloadProgressAt < idleTimeoutMs) return
      downloadInFlight = false
      downloadTimedOut = true
      // C2: 只放开「用户可重试」的单飞，不放开检查排除——底层 downloadUpdate()
      // 仍在飞（无法中止），并发检查的迟到事件会覆盖它随后真实落下的 downloaded。
      stalledDownloadGeneration = downloadGeneration
      logger.warn('[updater] 下载停滞（' + Math.round(idleTimeoutMs / 1000) + 's 无进展）')
      setState({
        phase: 'error',
        downloadPercent: null,
        error: 'the update download stalled for ' + Math.round(idleTimeoutMs / 1000)
          + 's with no progress from the update feed',
        failureKind: 'download-network',
      })
    }, tickMs)
    downloadWatchdogTimer.unref?.()
  }

  const raiseUpdateAttention = (version: string): void => {
    // 每目标一次：闩锁先落，聚焦分支也要消费它（上游同序：version 赋值在 isFocused 检查之前）。
    if (attentionVersion === version) return
    const superseding = attentionVersion !== null
    attentionVersion = version
    // 用户已经在这个窗口里看着：不打扰，但该版本已消费。
    if (isWindowFocused?.() === true) return
    // 更新的目标版本取代旧提醒：先撤掉旧的 Dock 弹跳/闪烁，再抬新的（否则旧弹跳会一直挂着）。
    if (superseding) clearUpdateAttention()
    if (attentionBounceId === null) {
      try {
        attentionBounceId = app.dock?.bounce('critical') ?? null
      } catch (error) {
        logger.warn('[updater] Dock 注意力失败（忽略）：', error instanceof Error ? error.message : String(error))
      }
    }
    try {
      flashFrame?.(true)
    } catch (error) {
      logger.warn('[updater] 任务栏闪烁失败（忽略）：', error instanceof Error ? error.message : String(error))
    }
  }
  const clearUpdateAttention = (): void => {
    if (attentionBounceId !== null) {
      try {
        app.dock?.cancel(attentionBounceId)
      } catch { /* 注意力清除失败绝不反噬 */ }
      attentionBounceId = null
    }
    try {
      flashFrame?.(false)
    } catch { /* 同上 */ }
  }

  const arm = (delayMs: number): void => {
    if (scheduleTimer !== null) clearTimeout(scheduleTimer)
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null
      void runScheduledCheck()
    }, delayMs)
    scheduleTimer.unref?.()
  }

  const runScheduledCheck = async (): Promise<void> => {
    const checkRan = await runCheck()
    if (!checkRan) {
      // A3 (2026-12 复审方向 A): 本轮「没跑成」（在飞检查 / 在飞下载 / 停滞待决）
      // 不是静默链的终点——旧实现只看相位，撞上在飞下载时直接 return 且不 arm，
      // 一次碰撞就整条静默链死掉。这里按当前退避档位重排一轮（本轮既非成功也非
      // 失败，不退避也不重置）；downloaded 是终局（退出时安装），不再排。
      if (state.phase === 'downloaded') return
      arm(nextCheckDelay({ attempt: checkAttempt, config: schedule, random }))
      return
    }
    lastCheckCompletedAt = Date.now()
    if (state.phase === 'error') checkAttempt += 1
    else checkAttempt = 0
    // A completed download is final for this version and an in-flight download
    // is mid-transition: neither is rescheduled (same gates as runCheck).
    if (state.phase === 'downloaded' || state.phase === 'downloading') return
    arm(nextCheckDelay({ attempt: checkAttempt, config: schedule, random }))
  }

  /** Coalesced foreground/resume nudge: only when the last completed check is
   *  older than the configured interval and nothing is final/in flight. */
  const noteActivity = (reason: 'focus' | 'resume'): void => {
    if (!started) return
    if (state.phase === 'downloaded' || state.phase === 'downloading'
      || checking || downloadInFlight || downloadStallPending()) return
    if (lastCheckCompletedAt !== null && Date.now() - lastCheckCompletedAt < schedule.intervalMs) return
    logger.log('[updater] 前台/唤醒触发静默检查（' + reason + '）')
    void runScheduledCheck()
  }

  /** Electron's window-focus event is the foreground half of upstream's check
   *  triggers; resume is wired by the host through noteActivity('resume'). */
  const attachFocusListener = (): void => {
    if (typeof app.on !== 'function') return
    try {
      app.on('browser-window-focus', () => {
        clearUpdateAttention()
        noteActivity('focus')
      })
    } catch (error) {
      logger.warn('[updater] 焦点订阅失败（忽略）：', error instanceof Error ? error.message : String(error))
    }
  }

  // The single check path shared by the silent scheduled checks (start /
  // focus / resume) and the user-initiated「检查更新」action (checkNow()). The phase
  // gates make it idempotent: an in-flight check/download or a completed
  // download is never clobbered. Returns false when the round was SKIPPED by
  // one of those gates (nothing attempted — runScheduledCheck's A3 leg uses
  // this to keep the silent chain alive), true when a check really ran
  // (success, named failure, or timeout).
  async function runCheck(): Promise<boolean> {
    if (checking || downloadInFlight || downloadStallPending()) return false
    // The「已下载，退出时安装」state is final for this version, and an
    // in-flight download is mid-transition — a re-check must not clobber
    // either back to `available`.
    if (state.phase === 'downloaded' || state.phase === 'downloading') return false
    checking = true
    ignoreAbandonedCheckEvents = false
    // Idle watchdog (upstream DSH_DESKTOP_UPDATE_HTTP_IDLE_TIMEOUT_MS): a check
    // that produces no response within the deadline becomes a NAMED failure
    // instead of an endless 'checking'. electron-updater cannot be aborted, so
    // the abandoned attempt's late events are ignored until the next check.
    // A2 (2026-12 复审方向 A): the watchdog ALSO unblocks runCheck through
    // `watchdogFired` — electron-updater dedupes an in-flight check (a user
    // retry just re-awaits the same promise), so without the race a
    // checkForUpdates() that never settles would park runScheduledCheck on
    // `await runCheck()` forever: no next arm, the silent chain dies, and
    // checkNow() never resolves either. The abandoned promise gets a no-op
    // catch so its late rejection can never surface as unhandled.
    let settleWatchdog: (() => void) | null = null
    const watchdogFired = new Promise<void>((resolve) => { settleWatchdog = resolve })
    const checkWatchdog = setTimeout(() => {
      settleWatchdog?.()
      if (!checking) return
      checking = false
      ignoreAbandonedCheckEvents = true
      logger.warn('[updater] 检查超时（' + Math.round(idleTimeoutMs / 1000) + 's 无响应）')
      setState({
        phase: 'error',
        latestVersion: null,
        downloadPercent: null,
        releaseUrl: null,
        error: 'the update check timed out after ' + Math.round(idleTimeoutMs / 1000)
          + 's with no response from the update feed',
        failureKind: 'check-network',
      })
    }, idleTimeoutMs)
    checkWatchdog.unref?.()
    try {
      setState({ phase: 'checking', error: null })
      if (channel === 'beta') {
        // electron-updater's GitHub provider falls back to latest.yml when a prerelease
        // channel file is unavailable: resolve a concrete beta tag and use GenericProvider
        // so a missing beta feed fails closed and never emits a stable-feed query.
        const betaFeed = await resolveBetaFeed()
        autoUpdater.setFeedURL({ provider: 'generic', url: betaFeed, channel: 'beta' })
        autoUpdater.channel = 'beta'
        // Both channel and provider mutation may reset this; preserve the no-silent-downgrade invariant.
        autoUpdater.allowDowngrade = false
      }
      const pending = autoUpdater.checkForUpdates()
      // A2: 被放弃的 promise 的迟到 reject 必须被消费（绝不产生未处理拒绝）；
      // 它的迟到事件由 checkScoped 抑制。
      void pending.catch(() => { /* abandoned by the idle watchdog */ })
      await Promise.race([pending, watchdogFired])
    } catch (error) {
      // A CHECK failure must NOT keep the stale latestVersion: the settings section infers
      // the failure kind from it (null →「无法检查更新」, set →「更新下载失败」+ retry), and a
      // retry must never download stale cached info without a fresh successful check.
      const message = describeError(error)
      logger.warn('[updater] check failed:', message)
      setState({ phase: 'error', latestVersion: null, downloadPercent: null, releaseUrl: null, error: sanitizeErrorText(message) })
    } finally {
      clearTimeout(checkWatchdog)
      checking = false
    }
    return true
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      // A6 (2026-12 复审方向 A): 幂等门。重复 start() 曾重复 attach focus 监听
      // 并把 15s 首检重新计时（整条静默节奏被推后），故第二次起一律空操作。
      if (started) return
      // Linux shape gate (design 21): a packaged writable AppImage may
      // schedule checks; every other Linux shape stays inert (no timers) —
      // the renderer gate keys on the same installBlockedReason string, so
      // nothing is offered that could not install.
      if (platform === 'linux' && state.installBlockedReason !== null) {
        logger.log('[updater] 跳过更新检查：当前 Linux 运行形态不支持自动更新（需从可写 AppImage 启动）');
        return
      }
      started = true
      attachFocusListener()
      arm(UPDATE_FIRST_CHECK_DELAY_MS)
      logger.log(
        '[updater] 更新检查已启动（channel=' + channel + '，' + UPDATE_FIRST_CHECK_DELAY_MS / 1000
        + 's 后首次检查，之后每 ' + Math.round(schedule.intervalMs / 60_000) + 'min ±'
        + Math.round(schedule.jitter * 100) + '%，失败退避封顶 '
        + Math.round(schedule.maxBackoffMs / 60_000) + 'min）',
      )
    },
    noteActivity,
    async checkNow() {
      // Linux shape gate: refuse loudly for non-AppImage shapes instead of letting the
      // feed lookup fail obscurely; AppImage falls through to the shared check path.
      if (platform === 'linux' && state.installBlockedReason !== null) {
        logger.log('[updater] 手动检查更新被跳过：当前 Linux 运行形态不支持自动更新（需从可写 AppImage 启动）')
        return { ok: false, error: LINUX_UPDATE_UNSUPPORTED_REASON }
      }
      // Same guarded path as the periodic check: an in-flight check/download or a completed
      // download is a no-op — the state push still tells the renderer what happened.
      // A gate no-op still resolves {ok:true}; the renderer judges from the update-state push.
      await runCheck()
      return { ok: true }
    },
    async download() {
      // 用户已在处理更新：Dock/任务栏注意力立即清除。
      clearUpdateAttention()
      // Only an update actually found (or a retry of a DOWNLOAD failure, which keeps
      // latestVersion) may start a download; a check failure must never download stale info.
      if (state.latestVersion === null || (state.phase !== 'available' && state.phase !== 'error')) {
        return { ok: false, error: 'no update available' }
      }
      // Core-logic enforcement (not just UI hiding): when installation is blocked (mac
      // without Developer ID, linux), refuse at the IPC handler even against a racy renderer.
      if (state.installBlockedReason !== null) {
        return { ok: false, error: 'automatic installation blocked on this platform' }
      }
      // Controller-level single-flight: a double click within the pre-progress window would
      // start two downloads; electron-updater dedupes internally but we must not rely on it.
      if (downloadInFlight) {
        return { ok: false, error: 'download already in progress' }
      }
      // C2: 每次尝试一个代际号——被停滞判定放弃的旧 promise 结算时，不得释放
      // 新一次重试的单飞/看门狗。
      downloadGeneration += 1
      const generation = downloadGeneration
      // C2: 用户显式重试就是停滞待决的终点——检查排除交回给在飞单飞，看门狗由
      // startDownloadWatchdog 重新武装（lastDownloadProgressAt 重新锚定）。
      stalledDownloadGeneration = null
      downloadInFlight = true
      startDownloadWatchdog()
      try {
        await autoUpdater.downloadUpdate()
        return { ok: true }
      } catch (error) {
        const message = describeError(error)
        logger.warn('[updater] download failed:', message)
        setState({ phase: 'error', error: sanitizeErrorText(message) })
        return { ok: false, error: sanitizeErrorText(message) }
      } finally {
        // 只有当前代际能清算：旧代际的迟到结算不得关掉新代际的保护。
        if (generation === downloadGeneration) {
          stopDownloadWatchdog()
          downloadInFlight = false
        }
        // C2: 底层 download promise 结算（成功/失败都算）→ 该代际的停滞待决终结。
        if (stalledDownloadGeneration === generation) stalledDownloadGeneration = null
      }
    },
    restartAndInstall() {
      // Core-logic enforcement (same discipline as download()): only a COMPLETED download
      // on an install-capable shape may arm quitAndInstall — never a partial/doomed install.
      // Linux is refused entirely: AppImageUpdater replaces the running file and SPAWNS the
      // new instance synchronously at click time BEFORE this app quits, while the chamber
      // quit path keeps the old process alive for ~1-2s of async cleanup — the fresh
      // instance collides with the single-instance lock and quits itself. The quit-install
      // leg stays (installs at exit; relaunch manually).
      if (platform === 'linux') {
        return { ok: false, error: 'automatic restart is not supported on linux (single-instance race); the update installs on quit' }
      }
      if (state.phase !== 'downloaded') {
        return { ok: false, error: 'no downloaded update to install' }
      }
      if (state.installBlockedReason !== null) {
        return { ok: false, error: 'automatic installation blocked on this platform' }
      }
      if (restartInFlight) {
        return { ok: false, error: 'restart already in progress' }
      }
      // A win32 retry after a STALLED armed attempt must not re-enter quitAndInstall:
      // BaseUpdater.install() returns false WITHOUT dispatching while its quitAndInstallCalled
      // latch is set, and quitAndInstall then yields undefined — the arming proof below would
      // misreport ok:true, and that refusal clears the latch so a second retry re-spawns a
      // duplicate NSIS installer. mac retry stays allowed; linux has no restart action.
      if (restartStalled && platform === 'win32') {
        releaseRestartFlight()
        setState({ restartFailureText: RESTART_STALLED_REFUSAL_TEXT })
        return { ok: false, error: RESTART_STALLED_REFUSAL_TEXT }
      }
      restartInFlight = true
      try {
        // electron-updater quitAndInstall: Windows NSIS spawns the silent installer then
        // app.quit() (through before-quit's update-downloaded exemption and will-quit, which
        // disposes transports/dsh first); macOS hands off to native Squirrel.Mac. Window
        // order: 'before-quit-for-update' fires, then every window closes, and only then the
        // quit — window 'close' arrives INSIDE this call, so the arming hook (fired right
        // before) keeps a close from hiding to tray, which would strand the process.
        // REAL 6.8.9 SYNC FAILURE: no throw — BaseUpdater.install() DISPATCHES 'error' and
        // returns false; our listener then runs synchronously (releases the flight,
        // publishes the failure, phase stays `downloaded`). Arming proof = flight held AND
        // no explicit false (the win32 latch refusal gated out before the call).
        options.onQuitAndInstallArmed?.()
        // Snapshot for the not-armed proof: a mid-call 'error' dispatch REPLACES this carry,
        // which distinguishes "already published" from "this result still owes a push".
        const carryBeforeCall = state.restartFailureText
        const armed = autoUpdater.quitAndInstall(true, true)
        if (restartInFlight && armed !== false) {
          // Armed — the quit is on its way; deliberately NOT released (fire-and-forget
          // single-flight). Clear a stale failure carry so the row shows in-progress.
          if (state.restartFailureText !== undefined) {
            setState({ restartFailureText: undefined })
          }
          // No-event stall watchdog: neither quit nor error within the grace releases the flight and surfaces the stall.
          armRestartWatchdog()
          return { ok: true }
        }
        // NOT armed. When the mid-call 'error' dispatch already ran, the listener pushed the
        // sanitized text; a silent falsy return (fake seam — the real non-dispatching falsy
        // path is ONLY the latch refusal gated out above) synthesizes the same surface. The
        // comparison is against the PRE-CALL carry, not undefined: the hook already fired, so
        // the host armed its close-to-tray exception and only a restartFailureText PUSH can
        // release it — a stale carry must not swallow this push.
        releaseRestartFlight()
        if (state.restartFailureText === carryBeforeCall) {
          setState({ restartFailureText: RESTART_NOT_ARMED_TEXT })
        }
        return { ok: false, error: state.restartFailureText ?? RESTART_NOT_ARMED_TEXT }
      } catch (error) {
        // A synchronous throw means nothing was armed — release for an in-place retry and
        // surface the sanitized failure on the same restartFailureText channel (phase stays
        // `downloaded`, `error` stays null: a restart failure is never a download failure).
        const message = describeError(error)
        logger.warn('[updater] restart failed (nothing armed):', message)
        releaseRestartFlight()
        setState({ restartFailureText: sanitizeErrorText(message) })
        return { ok: false, error: sanitizeErrorText(message) }
      }
    },
  }
}
