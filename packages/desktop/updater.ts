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
 * Linux is not covered: the release target is `dir` (no installer feed), so
 * the controller is inert there (installBlockedReason set, no checks).
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import type { UpdateInfo } from 'electron-updater'

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
  /** Feed channel (stable default; beta via DSH_CHAMBER_UPDATE_CHANNEL=beta). */
  channel: 'stable' | 'beta'
  /** Download progress percent (0–100) while downloading. */
  downloadPercent: number | null
  /** GitHub release page for the latest version (manual-install path). */
  releaseUrl: string | null
  /** Why automatic installation cannot run (platform / mac signing); null = OK. */
  installBlockedReason: string | null
  /** Non-secret error text (check/download failure); null = none. */
  error: string | null
}

/** The subset of electron's `App` the controller reads (test-injectable). */
export interface ElectronAppLike {
  isPackaged: boolean
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

function resolveChannel(): 'stable' | 'beta' {
  return process.env.DSH_CHAMBER_UPDATE_CHANNEL === 'beta' ? 'beta' : 'stable'
}

function releaseUrlFor(version: string): string {
  return `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${version}`
}

/**
 * Redact absolute paths (e.g. the updater cache dir, which electron-updater
 * embeds in some error messages) from the error text that rides the renderer
 * projection — the projection stays path-free (design 11 §7 non-secret
 * contract); the full detail stays in the main-process log. Covers Windows
 * drive paths and POSIX absolute paths rooted at any component (2026-08
 * review: broadened from the fixed root list — /opt, /usr/local, /Library,
 * /run, /root etc. all carry path material too). The POSIX branch refuses a
 * `/` preceded by `:`, `/`, OR a word char: that keeps a URL's `//host/...`
 * AND its path segments (`github.com/panzeyu2013/releases/...` — the
 * non-secret feed/release URL) intact, while real absolute-path roots
 * (preceded by whitespace, string start, or punctuation) are still redacted;
 * the Windows branch rejects `x://` (a scheme, e.g. `https://` — the drive
 * letter is followed by TWO slashes) so URLs survive it too.
 */
export function sanitizeErrorText(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:[\\/](?![/]))[^\s]*/g, '[path]')
    .replace(/(?<![:/\w])\/(?:[^\s/]+(?:[/\\][^\s]*)?)/g, '[path]')
}

/**
 * Platform-level install-block reason that is known WITHOUT probing
 * (linux / dev mac). macOS packaged is probed asynchronously (signature);
 * until the probe resolves it stays blocked. The security decision is
 * fail-closed: a renderer call racing startup cannot begin a download before
 * the Developer ID verdict exists.
 */
function platformBlockedReason(platform: NodeJS.Platform, app: ElectronAppLike): string | null {
  if (platform === 'linux') return 'auto-update is not supported on this platform'
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
  const channel = resolveChannel()

  let state: UpdateState = {
    phase: 'idle',
    currentVersion: version,
    latestVersion: null,
    channel,
    downloadPercent: null,
    releaseUrl: null,
    installBlockedReason: platformBlockedReason(platform, app),
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
  autoUpdater.allowPrerelease = channel === 'beta' || /^\d+\.\d+\.\d+-[0-9A-Za-z.-]+/.test(version)
  // Beta opt-in: only an explicit env override switches the channel. In the
  // PACKAGED app the channel is baked into app-update.yml (electron-builder
  // derives it from the version's semver prerelease tag: 0.2.0-beta.1 →
  // beta.yml, 0.2.0 → latest.yml) and must NOT be clobbered by a runtime
  // default. In dev there is no app-update.yml, so the feed is set explicitly
  // (same provider/owner/repo the build uses) and dev checks are force-enabled.
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
      if (state.installBlockedReason !== null && platform === 'linux') {
        logger.log('[updater] 跳过更新检查：当前平台不支持（linux dir target）');
        return
      }
      const initial = setTimeout(() => void runCheck(), CHECK_DELAY_MS)
      initial.unref?.()
      const interval = setInterval(() => void runCheck(), CHECK_INTERVAL_MS)
      interval.unref?.()
      logger.log(`[updater] 更新检查已启动（channel=${channel}，${CHECK_DELAY_MS / 1000}s 后首次检查，之后每 ${CHECK_INTERVAL_MS / 3_600_000}h）`);
    },
    async checkNow() {
      // Linux is inert (dir target — no installer feed): refuse loudly
      // instead of letting the feed lookup fail obscurely.
      if (platform === 'linux') {
        logger.log('[updater] 手动检查更新被跳过：当前平台不支持（linux dir target）')
        return { ok: false, error: 'auto-update is not supported on this platform' }
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
