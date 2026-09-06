/**
 * dsh-chamber desktop update controller (design 11 — 桌面端更新提示，无弹窗、
 * 低打扰：settings 部分展示，用户确认后下载、退出时安装，双平台一致)。
 *
 * Wraps electron-updater's autoUpdater (github provider, feed =
 * panzeyu2013/dsh-chamber releases) behind a small state machine that the
 * renderer consumes through the `dsh-chamber:update-state` IPC (query +
 * push). Contract:
 *
 * - Silent check on a startup delay and a 6h interval; failures are silent
 *   (main-process logs only) and never block startup.
 * - autoDownload = false: checking never downloads anything — the download
 *   starts ONLY after the user explicitly clicks「更新」in the settings
 *   update section (download()).
 * - autoInstallOnAppQuit = true: a completed download installs on quit —
 *   no dialog, no mid-session interruption (connection-manager courtesy).
 * - 2026-12 user decision: the settings section ALSO offers a user-triggered
 *   「重启并安装」action (restartAndInstall → electron-updater quitAndInstall)
 *   once the download completed — the quit-install leg alone is not a
 *   controllable flow (a plain quit may not install/relaunch on every
 *   platform/shape), so the user gets the deterministic restart right in the
 *   UI: quit + install + relaunch, still through the normal before-quit /
 *   will-quit cleanup path (the update-downloaded quit exemption passes).
 *   Offered on macOS + Windows only (2026-12 review H1): on Linux AppImage
 *   electron-updater swaps the file and spawns the new instance BEFORE this
 *   process quits, which structurally cannot survive the single-instance
 *   lock — Linux keeps the quit-install leg and no restart button.
 * - macOS: Squirrel.Mac (electron-updater's mac installer) requires a valid
 *   Developer ID signature. Without it the INSTALL step is blocked — that is
 *   a hard prerequisite, not a UX fork (design 11 §3.1/§6): the state
 *   carries installBlockedReason so the settings section can say「已下载
 *   （安装不可用，请手动安装）」loudly instead of pretending an install
 *   happened.
 * - Startup hygiene (2026-12): electron-updater never deletes its downloaded
 *   update files after a successful install (its clear() only runs on failed
 *   re-downloads) — a finished update leaves ~150-300 MB in the updater cache
 *   per cycle. On startup the controller resolves that cache dir the same way
 *   electron-updater does (platform cache root + the updaterCacheDirName
 *   baked into app-update.yml) and removes it when the pending update's
 *   version is NOT newer than the running version (already installed /
 *   obsolete); a genuinely newer pending update is never touched.
 *   Best-effort only: any resolution/read failure skips silently — cache
 *   hygiene never blocks startup and never fabricates success.
 * - The state projection is non-secret only: versions, channel, a release
 *   page URL, a short error text. Never credentials, never paths.
 *
 * Linux coverage is SHAPE-gated (design 21): electron-updater's AppImage
 * updater replaces the running .AppImage file, so updates are possible only
 * when the packaged app was started from a writable AppImage
 * (process.env.APPIMAGE — absolute, regular file, W_OK). Any other Linux
 * shape (dev, unpacked dir, deb) keeps the historic inert state — same
 * installBlockedReason string, so the settings「检查更新」gate (keyed on that
 * exact reason) never offers a pointless button.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import type { UpdateInfo } from 'electron-updater'
import { sanitizeErrorText } from './sanitize-error.ts'
export { sanitizeErrorText } from './sanitize-error.ts'

// electron-updater's CJS main exposes `autoUpdater` through an
// Object.defineProperty getter — cjs-module-lexer cannot detect it, so an ESM
// named import (`import { autoUpdater }`) would typecheck but resolve to
// undefined at runtime. require() preserves the getter; the cast keeps the
// package's own d.ts types. Resolved LAZILY (first real use only): the
// factory must not touch it when an injected fake is provided (design 11
// §3.2 testability — see UpdateControllerDeps).
const require = createRequire(import.meta.url)
let realAutoUpdater: AutoUpdaterLike | null = null
function getRealAutoUpdater(): AutoUpdaterLike {
  if (realAutoUpdater === null) {
    realAutoUpdater = (require('electron-updater') as typeof import('electron-updater')).autoUpdater
  }
  return realAutoUpdater
}

// electron's package main is CJS and exports the binary path STRING under
// plain node — a static `import { app } from 'electron'` would fail to LINK
// this module there (the named export does not exist) and a dynamic one
// yields undefined; require() returns the real electron module in the
// Electron runtime and the path string under plain node (`app` → undefined)
// — either way it never throws. Also resolved LAZILY: an injected test never
// touches the real app.
let realApp: ElectronAppLike | null = null
function getRealApp(): ElectronAppLike {
  if (realApp === null) {
    realApp = (require('electron') as typeof import('electron')).app
  }
  return realApp
}

/** Update lifecycle phase (design 11 §3.2). `up-to-date` = a check ran and
 *  found nothing newer (distinct from `idle`, which means not checked yet). */
export type UpdatePhase = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

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
  /** Why automatic installation cannot run (platform / mac signing / Linux
   *  non-AppImage shape — evaluated ONCE at controller creation; fixing the
   *  environment at runtime requires an app restart to re-probe); null = OK. */
  installBlockedReason: string | null
  /** Non-secret error text (check/download failure); null = none. */
  error: string | null
}

/** The subset of electron's `App` the controller reads (test-injectable). */
export interface ElectronAppLike {
  isPackaged: boolean
}

/** Linux blocked reason (design 21): any non-AppImage Linux shape keeps this
 *  exact string — the renderer「检查更新」button gate keys on it, so a dev /
 *  unpacked-dir / deb install never offers a check that could not install. */
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

/** The AppImage runtime launches the inner binary from a per-launch squashfs
 *  mount (`/tmp/.mount_*`) or extraction (`/tmp/appimage_extracted_*`). Only
 *  those launch shapes may hold a REAL APPIMAGE; an unpacked-dir/dev process
 *  with a stale inherited APPIMAGE env must never open the update gate (its
 *  quit-install would unlink an unrelated foreign file). */
function launchedFromAppImage(execPath: string): boolean {
  const parent = basename(dirname(execPath))
  return parent.startsWith('.mount') || parent.startsWith('appimage_extracted_')
}

/** Linux AppImage update capability (design 21 / 11 §3.1 shape gate):
 *  electron-updater's AppImageUpdater replaces the RUNNING file on quit
 *  (`unlink` + move — both parent-directory operations), so updates are
 *  possible only when the app really was started from an AppImage
 *  (launch-shape check + absolute APPIMAGE that is a regular file inside a
 *  writable parent directory). Any probe failure is a loud-null (updates
 *  stay off; never a silent partial enable). */
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
 * --- Startup stale-download-cache cleanup (design 11, 2026-12) ---
 *
 * electron-updater 6.x NEVER deletes its downloaded update files after a
 * successful install: `DownloadedUpdateHelper.clear()` (the only cleanup
 * path) is invoked only when a re-download FAILS. A finished update therefore
 * leaves the downloaded zip + `pending/` + differential blockmap artifacts in
 * the updater cache (~150-300 MB per cycle on this app) until a later cycle
 * overwrites them. The controller cleans that up at startup — but only when
 * the cache provably belongs to an update that is NOT newer than the running
 * version (already installed / superseded). Everything is fail-conservative:
 * an unresolvable dir name, missing metadata or an unparsable version keeps
 * the cache untouched.
 *
 * Cache dir derivation mirrors electron-updater exactly (verified against
 * 6.8.9): cacheDir = join(<platform cache root>, updaterCacheDirName), where
 * the root is `~/Library/Caches` (darwin), `%LOCALAPPDATA%` (win32) or
 * `$XDG_CACHE_HOME`/`~/.cache` (linux), and updaterCacheDirName is baked by
 * electron-builder into the packaged app's app-update.yml (e.g.
 * `@dsh-chamberdesktop-updater`). Only the PACKAGED shape resolves (dev runs
 * cannot install anything on mac anyway and have no baked yml).
 */

/** Real fs seams (tests inject their own — no real filesystem in unit tests
 *  beyond explicit temp dirs). */
function realReadFileUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8')
}
function realRemoveTree(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true })
}

/** Parse `updaterCacheDirName` from electron-builder's baked app-update.yml
 *  (plain YAML scalar scan — electron-builder emits only flat scalars here).
 *  Null when absent/unreadable. The value must be a bare directory NAME:
 *  separators or dot-names would escape the cache root, so they are refused
 *  (the yml ships inside our own bundle, but the guard is free). */
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

/** The platform cache root electron-updater derives its cacheDir from
 *  (getAppCacheDir, verified against 6.8.9). Pure; tests inject platform/env. */
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

/** Resolve electron-updater's cache dir for the CURRENT app, or null when it
 *  cannot be derived safely (dev/unpacked shape, missing yml, refused name).
 *  Never throws — cleanup is best-effort hygiene. */
export async function resolveUpdaterCacheDir(deps: ResolveUpdaterCacheDirDeps = {}): Promise<string | null> {
  const isPackaged = deps.isPackaged ?? true
  const resourcesPath = deps.resourcesPath ?? (typeof process !== 'undefined' ? process.resourcesPath : undefined)
  if (!isPackaged || typeof resourcesPath !== 'string' || resourcesPath === '') return null
  const readFileUtf8 = deps.readFile ?? realReadFileUtf8
  try {
    const yml = await readFileUtf8(join(resourcesPath, 'app-update.yml'))
    const dirName = updaterCacheDirNameFromYaml(yml)
    if (dirName === null) return null
    return join(updaterCacheRoot(deps.platform, deps.env, deps.home), dirName)
  } catch {
    return null
  }
}

/** First canonical chamber version (X.Y.Z or X.Y.Z-beta.N) inside an
 *  electron-updater cache file name (e.g. `dsh-chamber-0.2.2-arm64-mac.zip`
 *  → `0.2.2`). Null when none. Numeric groups are greedy, so a glued digit
 *  run parses as one (possibly longer) canonical version; the digit-
 *  adjacency guard only rejects a fragment that would START right after a
 *  digit the engine could not extend (not our artifact naming — treated as
 *  absent, conservatively). */
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

/** Compare two canonical chamber versions (X.Y.Z / X.Y.Z-beta.N): negative /
 *  zero / positive; null when either side is not canonical (callers must
 *  treat null as "do not act" — never guess). A stable version is newer than
 *  the same base with a beta suffix; beta.N compares numerically. */
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

/** Remove electron-updater's whole download cache dir when the cached pending
 *  update is NOT newer than `currentVersion` (installed / obsolete). Returns
 *  true only when something was removed. Conservatively keeps the cache when:
 *  the dir/meta is absent or unreadable, the file name carries no canonical
 *  version, the version cannot be compared, or the pending update is still
 *  NEWER than the running version (a legit installable download must never be
 *  deleted). Never throws (best-effort hygiene). */
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
  // Shape-guard the parsed content: `null` / arrays / scalars are all valid
  // JSON that JSON.parse happily returns — reading `.fileName` off them would
  // throw and break the "never throws" contract of this hygiene path
  // (2026-12 review). Anything that is not an object with a string fileName
  // keeps the cache untouched.
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
 * Open-external allowlist for the settings「前往下载页」link (design 11 §7):
 * only this repo's GitHub pages may ever be opened. Parsed with URL (not a
 * startsWith string check) so scheme/host/path-root are pinned exactly.
 * Encoded traversal is decoded and normalized before the path check, and
 * credentialed URLs are refused even though URL.origin ignores userinfo.
 */
export function isAllowedReleaseUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  try {
    const url = new URL(raw)
    if (url.origin !== 'https://github.com') return false
    if (url.username !== '' || url.password !== '') return false
    // One decode is sufficient only when the original path does not contain
    // an encoded percent. Reject nested encoding outright: `%252f` can become
    // `%2f` at one layer and `/` at another, defeating a single-pass
    // traversal check in downstream URL/server stacks.
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

/** The subset of electron-updater's `AppUpdater` surface the controller uses
 *  (test-injectable; the real autoUpdater is structurally compatible). */
export interface AutoUpdaterLike {
  on(event: string, listener: (...args: any[]) => void): unknown
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  channel: string | null
  forceDevUpdateConfig: boolean
  /** `any` (not `Record<string, unknown>`): the real AppUpdater's parameter
   *  is `PublishConfiguration | AllPublishOptions` and a narrower interface
   *  type would break the structural assignment of the real autoUpdater. */
  setFeedURL(options: any): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  /** electron-updater's restart-into-the-downloaded-update (quitAndInstall):
   *  quits the app (through before-quit/will-quit) and installs + relaunches.
   *  Fire-and-forget from the controller's perspective — the process is on
   *  its way out when it succeeds. */
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

/** Test-injection seam (design 11 §3.2 testability): each member falls back
 *  to the real value — the electron `app`, the require'd electron-updater
 *  `autoUpdater`, `process.platform` — resolved LAZILY inside the factory and
 *  only when the member is absent; an injected value is never touched by the
 *  real path (the module stays loadable under plain node for unit tests). */
export interface UpdateControllerDeps {
  /** Electron `app` (only `isPackaged` is read); default: the real app. */
  app?: { isPackaged: boolean }
  /** electron-updater's `autoUpdater`; default: the real instance. */
  autoUpdater?: AutoUpdaterLike
  /** `process.platform`; default: the real platform. */
  platform?: NodeJS.Platform
  /** Linux AppImage capability (design 21 shape gate). Default: probed from
   *  the real process.env.APPIMAGE + fs; tests inject to stay pure. */
  linuxAppImage?: LinuxAppImageProbe
  /** Resolve the exact GitHub release download base for beta checks. The
   * default uses the bounded public releases-list API; tests inject this so
   * no network is touched. A rejection fails closed before electron-updater
   * can invoke its GitHub provider's unsafe latest-channel fallback. */
  resolveBetaFeed?: () => Promise<string>
  /** Startup stale-download-cache override (design 11 — see
   *  cleanupStaleUpdateCache). Absent → resolved at runtime from the real
   *  packaged shape (resources app-update.yml + platform cache root); tests
   *  inject `{ cacheDir: null }` to disable or a temp dir to assert the
   *  behavior through the controller. */
  staleCache?: { cacheDir: string | null }
}

/** Controller surface wired into main.ts (IPC handlers) and started at boot. */
export interface UpdateController {
  state(): UpdateState
  subscribe(listener: (state: UpdateState) => void): () => void
  /** Schedule the silent periodic checks (startup delay + 6h interval). */
  start(): void
  /** User-confirmed download (the「更新」button): resolve {ok} or {error}. */
  download(): Promise<{ ok: true } | { ok: false; error: string }>
  /** User-initiated check (the「检查更新」button in the settings update
   *  section): the SAME check path as the silent periodic check
   *  (autoDownload stays off — a check never downloads). */
  checkNow(): Promise<{ ok: true } | { ok: false; error: string }>
  /** User-triggered restart into the downloaded update (2026-12 user
   *  decision — the「重启并安装」button): electron-updater quitAndInstall —
   *  quit + install + relaunch through the normal quit path (before-quit's
   *  update-downloaded exemption passes; will-quit still disposes transports
   *  and the local dsh instance first). Only a COMPLETED download on a
   *  shape where automatic installation is possible may start it — same
   *  core-logic enforcement as download(), never just UI hiding. */
  restartAndInstall(): { ok: true } | { ok: false; error: string }
}

/** The update feed repository (release.yml uploads the same repo's artifacts). */
export const GITHUB_OWNER = 'panzeyu2013'
export const GITHUB_REPO = 'dsh-chamber'

/** Startup delay before the first silent check (let the app settle). */
const CHECK_DELAY_MS = 15_000
/** Periodic silent re-check. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function isBetaVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-beta\.(0|[1-9]\d*)$/.test(version)
}

function resolveChannel(version: string): 'stable' | 'beta' {
  // A packaged beta prerelease is intrinsically a beta installation. Requiring an
  // environment override would make a real beta silently query stable.
  return isBetaVersion(version) || process.env.DSH_CHAMBER_UPDATE_CHANNEL === 'beta'
    ? 'beta'
    : 'stable'
}

type GithubRelease = { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
type BetaVersion = readonly [bigint, bigint, bigint, bigint]
const BETA_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/

function betaVersion(tag: unknown): BetaVersion | null {
  if (typeof tag !== 'string' || tag.length > 128) return null
  const match = BETA_TAG_PATTERN.exec(tag)
  return match === null ? null : [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), BigInt(match[4])]
}

function compareBetaVersion(left: BetaVersion, right: BetaVersion): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1
    if (left[index] > right[index]) return 1
  }
  return 0
}

/** Select an exact prerelease asset base. The returned URL never contains a
 * `latest` path and a malformed/draft/stable release can never become a feed. */
export function betaReleaseDownloadBase(releases: unknown): string {
  if (!Array.isArray(releases) || releases.length > 100) throw new Error('invalid GitHub releases response')
  let selected: { tag: string; version: BetaVersion } | null = null
  for (const candidate of releases as GithubRelease[]) {
    if (candidate === null || typeof candidate !== 'object'
      || candidate.draft !== false || candidate.prerelease !== true) continue
    const version = betaVersion(candidate.tag_name)
    if (version === null) continue
    if (selected === null || compareBetaVersion(version, selected.version) > 0) {
      selected = { tag: candidate.tag_name as string, version }
    }
  }
  if (selected === null) throw new Error('no published beta release is available')
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${encodeURIComponent(selected.tag)}/`
}

/** Public GitHub discovery used only for beta. It deliberately queries the
 * bounded releases collection, then switches electron-updater to a generic
 * exact-tag feed; the GitHubProvider never gets a chance to fall back from
 * beta.yml to latest.yml. */
export async function resolveGithubBetaFeed(
  request: typeof fetch = globalThis.fetch,
  timeoutMs = 10_000,
): Promise<string> {
  if (typeof request !== 'function') throw new Error('beta update discovery is unavailable')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await request(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' }, signal: abort.signal },
    )
    if (!response.ok) throw new Error(`beta update discovery failed (HTTP ${response.status})`)
    return betaReleaseDownloadBase(await response.json())
  } finally {
    clearTimeout(timer)
  }
}

function resolveRuntimeBetaFeed(): Promise<string> {
  // Electron net.fetch inherits the app's proxy/session policy. Resolve it
  // lazily so pure-Node tests with an injected resolver never load Electron.
  const electron = require('electron') as typeof import('electron')
  const request = typeof electron === 'object' && typeof electron.net?.fetch === 'function'
    ? electron.net.fetch.bind(electron.net) as typeof fetch
    : globalThis.fetch
  return resolveGithubBetaFeed(request)
}

/** Build the release-page projection from the FEED's version string — feed
 * data is untrusted input, so a version that is not semver-shaped yields
 * null (no fabricated URL) instead of an openable link; the open action is
 * additionally gated by isAllowedReleaseUrl. */
function releaseUrlFor(version: string): string | null {
  if (typeof version !== 'string' || version === '' || version.length > 128
    || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    return null
  }
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${version}`
}

/**
 * Platform/install-shape-level install-block reason that is known WITHOUT
 * probing (linux non-AppImage / dev mac). macOS packaged is probed
 * asynchronously (signature); until the probe resolves it stays blocked. The
 * security decision is fail-closed: a renderer call racing startup cannot
 * begin a download before the Developer ID verdict exists. Linux packaged
 * AppImage builds pass the gate (shape probe, see probeLinuxAppImage); every
 * other Linux shape keeps LINUX_UPDATE_UNSUPPORTED_REASON.
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
 * Whether the running macOS app carries a Developer ID signature. Squirrel.Mac
 * (electron-updater's mac installer) requires one for auto-install; ad-hoc
 * signed builds cannot install automatically. `codesign -dv` writes its
 * verdict to STDERR, so both streams are read.
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
}

export function createUpdateController(options: UpdateControllerOptions, deps?: UpdateControllerDeps): UpdateController {
  const { version, logger } = options
  // Real values are resolved LAZILY inside the factory and only when the
  // corresponding dep is absent (design 11 §3.2 testability): an injected
  // test never touches the real electron app, the real electron-updater
  // instance, or process.platform — and the module itself stays loadable
  // under plain node (no electron named imports at module top).
  const app = deps?.app ?? getRealApp()
  const autoUpdater = deps?.autoUpdater ?? getRealAutoUpdater()
  const platform = deps?.platform ?? process.platform
  const linuxAppImage = deps?.linuxAppImage !== undefined ? deps.linuxAppImage : probeLinuxAppImage()
  const channel = resolveChannel(version)
  const resolveBetaFeed = deps?.resolveBetaFeed ?? resolveRuntimeBetaFeed

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
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }
  // macOS packaged: probe asynchronously without blocking startup, but keep
  // download fail-closed until a valid Developer ID verdict clears the gate.
  if (platform === 'darwin' && app.isPackaged) {
    void probeMacDeveloperIdSignature().then((hasDeveloperId) => {
      setState({ installBlockedReason: hasDeveloperId ? null : 'missing Developer ID signature' })
    })
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  // Beta channel (design 11 §4): without allowPrerelease, electron-updater's
  // GitHub provider resolves the latest NON-PRERELEASE release and looks for
  // the channel yml there — a beta build (version 0.2.0-beta.1) would 404 on
  // beta.yml and never find updates. Enable the Atom-feed channel lookup when
  // the running version is itself a prerelease (packaged beta builds) or the
  // env opt-in is set (dev).
  autoUpdater.allowPrerelease = channel === 'beta'
  // A packaged `-beta.N` build is pinned to beta from its own version; the env
  // remains a dev/stable-build opt-in. Before every beta check runCheck below
  // replaces the baked GitHub provider with an exact-tag GenericProvider so
  // electron-updater cannot fall back from beta.yml to latest.yml. In dev the
  // initial GitHub feed keeps the normal injected seam; the same exact beta
  // replacement happens before the first network check.
  if (channel === 'beta') autoUpdater.channel = 'beta'
  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
    autoUpdater.setFeedURL({ provider: 'github', owner: GITHUB_OWNER, repo: GITHUB_REPO })
  }
  // electron-updater's channel setter RESETS allowDowngrade to true — the
  // design's no-silent-downgrade invariant (design 11 §5) must be re-asserted
  // AFTER any channel assignment.
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking', error: null }))
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    setState({
      phase: 'available',
      latestVersion: info.version,
      downloadPercent: null,
      releaseUrl: releaseUrlFor(info.version),
      error: null,
    })
  })
  autoUpdater.on('update-not-available', () => {
    setState({ phase: 'up-to-date', latestVersion: null, downloadPercent: null, releaseUrl: null, error: null })
  })
  autoUpdater.on('download-progress', (progress) => {
    // `downloaded` is terminal (the checkNow/download phase gates rely on
    // it): a progress event racing AFTER update-downloaded (electron-updater
    // normally never emits one, but an out-of-order delivery costs nothing to
    // guard) must not regress the phase back to `downloading`.
    if (state.phase === 'downloaded') return
    setState({ phase: 'downloading', downloadPercent: progress.percent })
  })
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    setState({ phase: 'downloaded', latestVersion: info.version, downloadPercent: 100, error: null })
  })
  // Single error path for check AND download failures. latestVersion is kept:
  // a check error leaves it null (settings:「无法检查更新」), a download error
  // keeps it (settings:「更新下载失败」+ retry).
  // 2026-12 review (M2): this event ALSO releases the「重启并安装」single-
  // flight. A restart can fail on an ASYNC path that never reaches
  // restartAndInstall's synchronous catch — mac staging-window click (the
  // native Squirrel fetch errors later) or BaseUpdater.install() returning
  // false internally (missing installer file → dispatchError). Without the
  // reset the flag would stay armed forever and every later click would be
  // silently refused ('restart already in progress') until the app restarts.
  // Safe to reset here unconditionally: an 'error' event means the current
  // quit/install did NOT proceed, and a SUCCESSFULLY armed restart quits the
  // process (no further events can matter).
  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('[updater]', message)
    restartInFlight = false
    setState({ phase: 'error', downloadPercent: null, error: sanitizeErrorText(message) })
  })

  // Startup hygiene (design 11, 2026-12): electron-updater keeps downloaded
  // update files forever after a successful install (see
  // cleanupStaleUpdateCache). Fire-and-forget best-effort cleanup — it only
  // deletes when the cached pending version is NOT newer than this run's
  // version, resolves nothing in dev, and never blocks or throws into boot.
  if (deps?.staleCache !== undefined) {
    const cacheDir = deps.staleCache.cacheDir
    if (cacheDir !== null) {
      void cleanupStaleUpdateCache(cacheDir, version).then((removed) => {
        if (removed) logger.log('[updater] 已清理已安装版本的更新缓存：', cacheDir)
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
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[updater] 更新缓存清理失败（已忽略）：', message)
      }
    })()
  }

  let checking = false
  // 2026-08 review fix: a download in flight keeps phase `available` until the
  // first progress event (or `downloaded` on completion) — a periodic re-check
  // started in that window would pass the phase gate below and, resolving
  // after the download, clobber `downloaded` back to `available`/`up-to-date`
  // (losing the settings「已下载，退出时安装」row AND the before-quit
  // exemption while electron-updater still installs on quit). The flag makes
  // the download exclusion explicit and covers the whole in-flight window.
  let downloadInFlight = false
  // The「重启并安装」action is fire-and-forget: a successful quitAndInstall
  // means the process is quitting — the flag is deliberately NOT reset on
  // success (a second restart click after the first one armed the quit would
  // otherwise re-enter electron-updater while the app is already on its way
  // out). Only a FAILURE path resets it so the user can retry.
  let restartInFlight = false
  // The single check path shared by the silent periodic checks (start / 6h
  // interval) and the user-initiated「检查更新」action (checkNow()). The phase
  // gates make it idempotent: an in-flight check/download or a completed
  // download is never clobbered.
  async function runCheck(): Promise<void> {
    if (checking || downloadInFlight) return
    // The「已下载，退出时安装」state is final for this version, and an
    // in-flight download is mid-transition — a re-check must not clobber
    // either back to `available`.
    if (state.phase === 'downloaded' || state.phase === 'downloading') return
    checking = true
    try {
      setState({ phase: 'checking', error: null })
      if (channel === 'beta') {
        // electron-updater's GitHub provider deliberately falls back to
        // latest.yml when a prerelease channel file is unavailable. Resolve a
        // concrete beta tag first and use GenericProvider for this check so a
        // missing beta feed fails closed and never emits a stable-feed query.
        const betaFeed = await resolveBetaFeed()
        autoUpdater.setFeedURL({ provider: 'generic', url: betaFeed, channel: 'beta' })
        autoUpdater.channel = 'beta'
        // Both channel and provider mutation may reset this in updater
        // implementations; preserve the no-silent-downgrade invariant.
        autoUpdater.allowDowngrade = false
      }
      await autoUpdater.checkForUpdates()
    } catch (error) {
      // A CHECK failure (a 6h re-check after a previous `available`, or the
      // first check) must NOT keep the stale latestVersion: the settings
      // section infers the failure kind from it (null →「无法检查更新」, set →
      // 「更新下载失败」+ retry), and a retry must never download stale cached
      // update info without a fresh successful check. The 'error' event above
      // preserves latestVersion (download errors need it for retry); this
      // catch clears it because we KNOW the failure was a check.
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('[updater] check failed:', message)
      setState({ phase: 'error', latestVersion: null, downloadPercent: null, releaseUrl: null, error: sanitizeErrorText(message) })
    } finally {
      checking = false
    }
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start() {
      // Linux shape gate (design 21): a packaged writable AppImage may
      // schedule checks; every other Linux shape stays inert (no timers) —
      // the renderer gate keys on the same installBlockedReason string, so
      // nothing is offered that could not install.
      if (platform === 'linux' && state.installBlockedReason !== null) {
        logger.log('[updater] 跳过更新检查：当前 Linux 运行形态不支持自动更新（需从可写 AppImage 启动）');
        return
      }
      const initial = setTimeout(() => void runCheck(), CHECK_DELAY_MS)
      initial.unref?.()
      const interval = setInterval(() => void runCheck(), CHECK_INTERVAL_MS)
      interval.unref?.()
      logger.log(`[updater] 更新检查已启动（channel=${channel}，${CHECK_DELAY_MS / 1000}s 后首次检查，之后每 ${CHECK_INTERVAL_MS / 3_600_000}h）`);
    },
    async checkNow() {
      // Linux shape gate (design 21): refuse loudly for non-AppImage shapes
      // instead of letting the feed lookup fail obscurely; an AppImage build
      // (installBlockedReason === null) falls through to the shared check path.
      if (platform === 'linux' && state.installBlockedReason !== null) {
        logger.log('[updater] 手动检查更新被跳过：当前 Linux 运行形态不支持自动更新（需从可写 AppImage 启动）')
        return { ok: false, error: LINUX_UPDATE_UNSUPPORTED_REASON }
      }
      // Same guarded path as the periodic check: a check/download already in
      // flight or a completed download (phase gates in runCheck) are no-ops —
      // the state push still tells the renderer what actually happened.
      // Contract note (2026-08 review): a gate no-op still resolves {ok:true}
      // here — the renderer must judge the outcome from the `update-state`
      // push (phase stays checking/downloaded/…), never from this return value.
      await runCheck()
      return { ok: true }
    },
    async download() {
      // Only an update that was actually found (or a retry of a DOWNLOAD
      // failure, which keeps latestVersion) may start a download — a check
      // failure (latestVersion cleared) must never download stale cached
      // update info without a fresh successful check.
      if (state.latestVersion === null || (state.phase !== 'available' && state.phase !== 'error')) {
        return { ok: false, error: 'no update available' }
      }
      // Core-logic enforcement (not just UI hiding — repo invariant): when
      // automatic installation is blocked (mac without Developer ID, linux),
      // a download is a doomed install path; refuse at the IPC handler too,
      // even if a compromised/racy renderer calls inside the probe window.
      if (state.installBlockedReason !== null) {
        return { ok: false, error: 'automatic installation blocked on this platform' }
      }
      // Controller-level single-flight (2026-08 review): a double click within
      // the pre-progress window would otherwise start two downloads (phase is
      // still `available` until the first progress event). electron-updater
      // dedupes via its internal downloadPromise, but the controller must not
      // rely on that — the flag also feeds the checkNow() exclusion above.
      if (downloadInFlight) {
        return { ok: false, error: 'download already in progress' }
      }
      downloadInFlight = true
      try {
        await autoUpdater.downloadUpdate()
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[updater] download failed:', message)
        setState({ phase: 'error', error: sanitizeErrorText(message) })
        return { ok: false, error: sanitizeErrorText(message) }
      } finally {
        downloadInFlight = false
      }
    },
    restartAndInstall() {
      // Core-logic enforcement (same discipline as download()): the「重启并
      // 安装」action is only meaningful for a COMPLETED download on a shape
      // where automatic installation is possible. The gates are enforced here
      // too — a compromised/racy renderer calling outside the rendered state
      // must never arm electron-updater's quitAndInstall against a partial or
      // doomed install.
      // Linux is refused entirely (2026-12 review H1): electron-updater's
      // AppImageUpdater replaces the running file and SPAWNS the new instance
      // synchronously at click time, BEFORE this app quits (BaseUpdater
      // quitAndInstall → install() → app.quit()); the chamber quit path keeps
      // the old process alive for its async cleanup (~1-2s), so the fresh
      // instance collides with the still-running one under Electron's
      // single-instance lock (main.ts requestSingleInstanceLock) and quits
      // itself — the promised「自动重启」structurally cannot happen on
      // AppImage. The quit-install leg stays (installs at exit; the app is
      // relaunched manually). Renderer gate mirrors this (update-gate).
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
      restartInFlight = true
      try {
        // electron-updater quitAndInstall: Windows NSIS spawns the silent
        // installer (/S --force-run, detached) and then app.quit() — the quit
        // runs through before-quit (the update-downloaded exemption, design 14
        // D2) and will-quit (transports and the local dsh instance are
        // disposed first), the app exits with code 0, and the installer (which
        // waits for this process) installs and relaunches the new version.
        // isForceRunAfter=true makes that relaunch deterministic.
        // macOS hands off to the NATIVE Squirrel.Mac updater
        // (MacUpdater.quitAndInstall → autoUpdater.quitAndInstall, no
        // app.quit() from electron-updater): Squirrel installs and relaunches.
        // Whether the native termination sequence runs through Electron's
        // before-quit/will-quit cleanup (so transports/dsh are disposed before
        // the swap) is a REAL-MACHINE gate, not statically provable here —
        // design 11 §9 lists the assertion checklist. Also: when the click
        // lands before Squirrel finished its own staging fetch, the mac call
        // only registers a listener and returns — the quit happens later when
        // the native download completes (ok:true then means "armed", with a
        // seconds-long window until the actual quit).
        // A synchronous throw here means nothing was armed — reset the flag
        // for an in-place retry. The phase is deliberately NOT regressed to
        // 'error': the downloaded row keeps its「重启并安装」button so the user
        // retries the RESTART (an 'error' state would be misread by the
        // settings section as a DOWNLOAD failure and offer the wrong retry —
        // unless electron-updater already emitted its own 'error' event, which
        // moves the phase on the event channel; we must not clobber that).
        autoUpdater.quitAndInstall(true, true)
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.warn('[updater] restart failed (nothing armed):', message)
        restartInFlight = false
        return { ok: false, error: sanitizeErrorText(message) }
      }
    },
  }
}
