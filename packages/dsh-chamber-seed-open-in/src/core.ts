/**
 * openInApp domain core — the chamber fork's platform logic and state machine
 * (design 20 §6; own file, upstream has no counterpart).
 *
 * This is upstream's `apply()` body (`@deepseek-ai/dsh-host-open-in-app`,
 * pin 183f08e9 = dsh-v0.1.5-rc.1, `src/index.ts:138-183,241-310`) with the
 * two transport/trust responsibilities removed and nothing else changed:
 *
 *   - **no SSH dormancy gate**: upstream resolves an EMPTY catalog whenever the
 *     launcher's environment carries `SSH_CONNECTION`/`SSH_TTY`
 *     (`src/index.ts:139`, `resolver.ts:630,656-667`) — chamber pins that very
 *     marker on its managed local instance as the directory-picker pin
 *     (design 02 §3.1/§3.9), so the official host half can never serve this
 *     host. The fork simply never passes an `ssh` fact (upstream's
 *     `resolveInternals` defaults it to false) and does not import
 *     `@deepseek-ai/dsh-launch-environment` at all;
 *   - **no route fence**: upstream registers three `webServer` routes behind
 *     `ctx.connection.requestRejection` and parses HTTP bodies itself. The
 *     chamber fork is reached through the instance's own generic RPC channel,
 *     so the trust boundary is the instance's connection/gateway fence and the
 *     payload validation lives where the payload enters (below).
 *
 * Everything else is upstream semantics, deliberately preserved: the catalog
 * resolves lazily ONCE per plugin life into one map of verified launchers, the
 * apps read serves its keys in menu order, a launch whose executable is gone
 * (`ENOENT`) refreshes exactly that one entry and retries once, and icons are
 * cached per application.
 */

import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { OPEN_IN_APP_CATALOG, type OpenInAppApp } from './catalog.ts'
import { extractAppIcon, type OpenInAppIcon } from './icons.ts'
import {
  launchResolved, resolveLaunch, resolveOpenInAppApps,
  type OpenInAppInternals, type OpenInAppResolvedLaunch,
} from './resolver.ts'
import {
  type OpenInAppAppsValue,
  type OpenInAppDomainResult,
  type OpenInAppErrorCode,
  type OpenInAppIconValue,
  type OpenInAppProbeValue,
} from './shared.ts'

/**
 * Per-command deadline for catalog-resolution host commands. Mirrors the value
 * upstream's default web composition deploys
 * (`packages/bundle/web-app/cordis.patch.yml:68`) — the fork keeps upstream's
 * knobs as constants instead of a required config schema, because a seed row
 * carries no config and a wrong/missing schema would fail the host boot.
 */
export const OPEN_IN_APP_PROBE_TIMEOUT_MS = 10_000

/** Per-command deadline for icon extraction (upstream: same patch, `:69`). */
export const OPEN_IN_APP_ICON_TIMEOUT_MS = 10_000

/**
 * Early-failure watch window per launch (upstream: same patch, `:70`). A
 * launcher still running when the window closes counts as launched and keeps
 * running, so this bounds how long a launch request is held — never how long
 * an application may live.
 */
export const OPEN_IN_APP_LAUNCH_WATCH_MS = 1_000

/** One domain failure; only these cross the wire (see `domainResult`). */
export class OpenInAppError extends Error {
  readonly code: OpenInAppErrorCode
  readonly retryable: boolean

  constructor(code: OpenInAppErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'OpenInAppError'
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Convert only known domain failures into the wire carrier; unexpected
 * programming failures keep throwing (they are the host's problem, never the
 * caller's).
 * @param operation - the domain call.
 * @returns the explicit carrier.
 */
export async function domainResult<T>(operation: () => Promise<T>): Promise<OpenInAppDomainResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (!(error instanceof OpenInAppError)) throw error
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable ? { retryable: true } : {}),
      },
    }
  }
}

/** Host facts this domain consumes, injected by the facade (never imported). */
export interface OpenInAppHostFacts {
  /** The platform the catalog is resolved for (`process.platform` at plugin init). */
  readonly platform: NodeJS.Platform
  /**
   * PATH-name resolution through the composition's `subprocess` service.
   * Answers null when the name is not on PATH; the facade swallows the
   * provider's not-found rejection, because for detection a name that does not
   * resolve has exactly one meaning — unavailable.
   */
  resolveExecutable(name: string): Promise<string | null>
}

/** Construction options. */
export interface OpenInAppCoreOptions {
  readonly host: OpenInAppHostFacts
  /**
   * Platform/host seams merged LAST (deterministic tests: `platform`,
   * `applicationRoots`, `env`, `home`, `run`, `launch`, `resolveExecutable`).
   */
  readonly internals?: OpenInAppInternals
  readonly probeTimeoutMs?: number
  readonly iconTimeoutMs?: number
  readonly launchWatchMs?: number
}

/** The domain: catalog detection, icons and launches for one instance. */
export class OpenInAppCore {
  private readonly options: OpenInAppCoreOptions
  private readonly probeTimeoutMs: number
  private readonly iconTimeoutMs: number
  private readonly launchWatchMs: number
  /** Lazy once-per-plugin-life resolution; the map is the mutable authority. */
  private resolutions: Promise<Map<string, OpenInAppResolvedLaunch>> | undefined
  /** Per-app icon promise cache (null = resolved as unavailable). */
  private readonly icons = new Map<string, Promise<OpenInAppIcon | null>>()

  constructor(options: OpenInAppCoreOptions) {
    this.options = options
    this.probeTimeoutMs = options.probeTimeoutMs ?? OPEN_IN_APP_PROBE_TIMEOUT_MS
    this.iconTimeoutMs = options.iconTimeoutMs ?? OPEN_IN_APP_ICON_TIMEOUT_MS
    this.launchWatchMs = options.launchWatchMs ?? OPEN_IN_APP_LAUNCH_WATCH_MS
  }

  /**
   * The cheap activation answer: platform plus protocol, no detection at all.
   * @returns the probe value.
   */
  probe(): OpenInAppProbeValue {
    return { platform: String(this.internals().platform ?? this.options.host.platform) }
  }

  /**
   * Catalog ids probed as installed on this host, in menu order.
   * @returns the apps value.
   */
  async apps(): Promise<OpenInAppAppsValue> {
    return { apps: [...(await this.availability()).keys()] }
  }

  /**
   * One application's real bundle icon, base64-encoded.
   * @param app - catalog id (untrusted wire input).
   * @returns the icon value.
   */
  async icon(app: unknown): Promise<OpenInAppIconValue> {
    const entry = this.catalogEntry(app)
    const resolved = (await this.availability()).get(entry.id)
    if (resolved === undefined) {
      throw new OpenInAppError('unavailable-app', `${entry.id} is not installed on this host`)
    }
    const icon = await this.iconOf(entry, resolved)
    if (icon === null) {
      throw new OpenInAppError('icon-unavailable', `no icon for ${entry.id}`)
    }
    return { mime: icon.contentType, dataBase64: icon.bytes.toString('base64') }
  }

  /**
   * Launch one installed application on one absolute directory.
   * @param app - catalog id (untrusted wire input).
   * @param path - absolute directory (untrusted wire input).
   * @returns after the host acknowledged the launch.
   */
  async open(app: unknown, path: unknown): Promise<void> {
    const entry = this.catalogEntry(app)
    const resolved = (await this.availability()).get(entry.id)
    if (resolved === undefined) {
      throw new OpenInAppError('unavailable-app', `${entry.id} is not installed on this host`)
    }
    if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
      throw new OpenInAppError('invalid-path', 'path must be an absolute directory path')
    }
    let directory: boolean
    try {
      directory = (await stat(path)).isDirectory()
    } catch {
      // Swallows ENOENT/EACCES: both mean there is no directory to open.
      directory = false
    }
    if (!directory) {
      throw new OpenInAppError('directory-missing', `directory does not exist: ${path}`)
    }
    let outcome = await launchResolved(resolved, path, this.launchWatchMs, this.internals())
    if (outcome === 'missing') {
      // The verified launcher is gone (uninstalled since resolution): refresh
      // this one entry and retry once with the fresh launcher.
      const fresh = await this.refreshResolution(entry)
      outcome = fresh === undefined
        ? 'failed'
        : await launchResolved(fresh, path, this.launchWatchMs, this.internals())
    }
    if (outcome !== 'launched') {
      throw new OpenInAppError('launch-failed', `failed to launch ${entry.id}`, true)
    }
  }

  /** Resolve one catalog id at the wire, before any host work happens. */
  private catalogEntry(app: unknown): OpenInAppApp {
    const id = typeof app === 'string' ? app : ''
    const entry = OPEN_IN_APP_CATALOG.find(candidate => candidate.id === id)
    if (entry === undefined) {
      throw new OpenInAppError('unknown-app', `unknown open-in application: ${JSON.stringify(app)}`)
    }
    return entry
  }

  /** The internals every resolver call receives (host facts first, seams last). */
  private internals(): OpenInAppInternals {
    return {
      platform: this.options.host.platform,
      resolveExecutable: name => this.options.host.resolveExecutable(name),
      ...this.options.internals,
    }
  }

  /** Lazy once-per-plugin-life catalog resolution. */
  private availability(): Promise<Map<string, OpenInAppResolvedLaunch>> {
    return this.resolutions ??= resolveOpenInAppApps(this.probeTimeoutMs, this.internals())
  }

  /** Per-app icon promise cache (null = resolved as unavailable). */
  private iconOf(app: OpenInAppApp, resolved: OpenInAppResolvedLaunch): Promise<OpenInAppIcon | null> {
    let cached = this.icons.get(app.id)
    if (cached === undefined) {
      cached = extractAppIcon(app, resolved, this.iconTimeoutMs, this.internals())
      this.icons.set(app.id, cached)
    }
    return cached
  }

  /**
   * Replace one stale resolution after a missing-executable launch: the entry
   * (and its icon) re-resolves once; an entry that no longer resolves leaves
   * the map and the next apps read no longer offers it.
   */
  private async refreshResolution(app: OpenInAppApp): Promise<OpenInAppResolvedLaunch | undefined> {
    const map = await this.availability()
    const fresh = await resolveLaunch(app, this.probeTimeoutMs, this.internals())
    this.icons.delete(app.id)
    if (fresh === null) {
      map.delete(app.id)
      return undefined
    }
    map.set(app.id, fresh)
    return fresh
  }
}
