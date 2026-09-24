/**
 * openInApp domain core — the fork's platform logic and state machine (no upstream
 * counterpart): upstream's `apply()` body minus two transport/trust responsibilities.
 * No SSH dormancy gate — upstream empties the catalog when the environment carries
 * `SSH_CONNECTION`/`SSH_TTY`, but chamber pins that marker on its managed local instance
 * as the directory-picker pin, so the fork never passes an `ssh` fact. No route fence —
 * the fork is reached through the instance's own generic RPC channel, so its trust
 * boundary is that fence and payload validation happens here. Everything else is upstream
 * semantics: lazy once-per-life catalog resolution into one map of verified launchers,
 * apps read in menu order, ENOENT launch refreshes that entry and retries once, icons
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

/** Per-command deadline for catalog-resolution host commands (upstream's deployed
 *  value, kept as a constant because a seed row carries no config). */
export const OPEN_IN_APP_PROBE_TIMEOUT_MS = 10_000


export const OPEN_IN_APP_ICON_TIMEOUT_MS = 10_000

/** Early-failure watch window per launch: a launcher still running when it closes
 *  counts as launched, so this bounds how long the request is held — never app lifetime. */
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

/** Convert only known domain failures into the wire carrier; unexpected programming
 *  failures keep throwing (the host's problem, never the caller's). */
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
  /** The platform the catalog is resolved for. */
  readonly platform: NodeJS.Platform
  /** PATH-name resolution through the composition's `subprocess` service; null means
   *  not on PATH (the provider's not-found rejection is swallowed — for detection,
   *  nothing else is possible). */
  resolveExecutable(name: string): Promise<string | null>
}

/** Construction options. */
export interface OpenInAppCoreOptions {
  readonly host: OpenInAppHostFacts
  /** Platform/host seams merged LAST (deterministic tests). */
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

  /** The cheap activation answer: platform plus protocol, no detection. */
  probe(): OpenInAppProbeValue {
    return { platform: String(this.internals().platform ?? this.options.host.platform) }
  }

  /** Catalog ids probed as installed on this host, in menu order. */
  async apps(): Promise<OpenInAppAppsValue> {
    return { apps: [...(await this.availability()).keys()] }
  }

  /** One application's real bundle icon, base64-encoded. `app` is untrusted wire input. */
  async icon(app: unknown): Promise<OpenInAppIconValue> {
    const { entry, resolved } = await this.resolvedEntry(app)
    const icon = await this.iconOf(entry, resolved)
    if (icon === null) {
      throw new OpenInAppError('icon-unavailable', `no icon for ${entry.id}`)
    }
    return { mime: icon.contentType, dataBase64: icon.bytes.toString('base64') }
  }

  /** Launch one installed application on one absolute directory. Both arguments are
   *  untrusted wire input; resolves after the host acknowledged the launch. */
  async open(app: unknown, path: unknown): Promise<void> {
    const { entry, resolved } = await this.resolvedEntry(app)
    if (typeof path !== 'string' || path === '' || !isAbsolute(path)) {
      throw new OpenInAppError('invalid-path', 'path must be an absolute directory path')
    }
    let directory: boolean
    try {
      directory = (await stat(path)).isDirectory()
    } catch {
      directory = false
    }
    if (!directory) {
      throw new OpenInAppError('directory-missing', `directory does not exist: ${path}`)
    }
    let outcome = await launchResolved(resolved, path, this.launchWatchMs, this.internals())
    if (outcome === 'missing') {
      // The verified launcher is gone: refresh this one entry and retry once.
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

  /** Resolve one wire app id to its installed launcher (icon/open share this leg). */
  private async resolvedEntry(app: unknown): Promise<{ entry: OpenInAppApp; resolved: OpenInAppResolvedLaunch }> {
    const entry = this.catalogEntry(app)
    const resolved = (await this.availability()).get(entry.id)
    if (resolved === undefined) {
      throw new OpenInAppError('unavailable-app', `${entry.id} is not installed on this host`)
    }
    return { entry, resolved }
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

  private iconOf(app: OpenInAppApp, resolved: OpenInAppResolvedLaunch): Promise<OpenInAppIcon | null> {
    let cached = this.icons.get(app.id)
    if (cached === undefined) {
      cached = extractAppIcon(app, resolved, this.iconTimeoutMs, this.internals())
      this.icons.set(app.id, cached)
    }
    return cached
  }

  /** Replace one stale resolution after a missing-executable launch: the entry (and
   *  its icon) re-resolves once; one that no longer resolves leaves the map. */
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
