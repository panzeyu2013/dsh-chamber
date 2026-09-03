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
 * - macOS: Squirrel.Mac (electron-updater's mac installer) requires a valid
 *   Developer ID signature. Without it the INSTALL step is blocked — that is
 *   a hard prerequisite, not a UX fork (design 11 §3.1/§6): the state
 *   carries installBlockedReason so the settings section can say「已下载
 *   （安装不可用，请手动安装）」loudly instead of pretending an install
 *   happened.
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
import { basename, dirname, isAbsolute } from 'node:path'
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
  autoUpdater.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn('[updater]', message)
    setState({ phase: 'error', downloadPercent: null, error: sanitizeErrorText(message) })
  })

  let checking = false
  // 2026-08 review fix: a download in flight keeps phase `available` until the
  // first progress event (or `downloaded` on completion) — a periodic re-check
  // started in that window would pass the phase gate below and, resolving
  // after the download, clobber `downloaded` back to `available`/`up-to-date`
  // (losing the settings「已下载，退出时安装」row AND the before-quit
  // exemption while electron-updater still installs on quit). The flag makes
  // the download exclusion explicit and covers the whole in-flight window.
  let downloadInFlight = false
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
  }
}
