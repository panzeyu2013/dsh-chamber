/**
 * Per-instance open-in host gateway (design 20 §6, fork & supersede).
 *
 * WHAT THIS IS — the chamber fork of upstream's open-in host half
 * (`@deepseek-ai/dsh-host-open-in-app`, pin 183f08e9 = dsh-v0.1.5-rc.1),
 * running INSIDE each managed local dsh instance as a seeded host package. It
 * answers the local application catalog, the applications' real bundle icons
 * and the launch of one directory in one installed application, so the chamber
 * client plugin (`@dsh-chamber/dsh-chamber-client-ui-open-in`, the superset of
 * the official browser half) can present the same surface upstream's own
 * composition does — without chamber depending on any upstream decision.
 *
 * TRUST MODEL — the service runs in the instance process and is reached over
 * the instance's own generic RPC channel (typert Remote namespace `openInApp`),
 * i.e. behind the same connection/gateway fence as every other instance API
 * (`gitWorktree/*`, `archiveCleanup/*`). It registers no `webServer` route and
 * holds no trust logic of its own. The browser submits exactly two untrusted
 * values: a catalog id and an absolute directory path. The id is matched
 * against the closed catalog (never used as argv), the path must be absolute,
 * non-empty and name an existing directory, and no shell string is ever
 * constructed — `./core.ts` owns that validation. Only the launcher argv the
 * CATALOG declares is executed, so the wire cannot name a command.
 *
 * Fixed wire namespace: `openInApp/{probe,apps,icon,open}` (see ./shared.ts).
 * `probe()` is the zero-cost activation probe (platform only — no catalog
 * detection, no spawn, no filesystem walk); `apps()`/`icon()`/`open()` answer
 * the explicit `{ok,value}|{ok:false,error}` carrier because the generic dsh
 * gateway does not preserve thrown error fields.
 *
 * UPSTREAM DIVERGENCE (design 20 §6.1) — this file replaces upstream's
 * `src/index.ts` (three `webServer` routes + a required three-knob config
 * schema + the SSH dormancy gate). The catalog/icon/launch logic itself is
 * upstream's, kept byte-identical in `./catalog.ts`, `./resolver.ts` and
 * `./icons.ts`; `./core.ts` is where the two removed responsibilities used to
 * live. The fork is registered in the upstream-touchpoint gate
 * (`scripts/dev/verify-upstream-touchpoints.mjs` → `FORKS`) so any upstream
 * drift on those files fails CI instead of silently rotting here.
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only import carries the `subprocess` Context merge for the read below.
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { OpenInAppCore, domainResult } from './core.ts'
import {
  OPEN_IN_APP_REMOTE_NAMESPACE,
  type OpenInAppAppsValue,
  type OpenInAppDomainResult,
  type OpenInAppIconValue,
  type OpenInAppProbeValue,
} from './shared.ts'

export * from './shared.ts'
export {
  OpenInAppCore,
  OpenInAppError,
  domainResult,
  OPEN_IN_APP_ICON_TIMEOUT_MS,
  OPEN_IN_APP_LAUNCH_WATCH_MS,
  OPEN_IN_APP_PROBE_TIMEOUT_MS,
} from './core.ts'

/**
 * Remote-only facade: all catalog, icon and launch policy lives in the pure
 * core, so the wire surface stays a projection.
 */
export class OpenInAppGateway extends TypertRemoteService {
  static inject = ['subprocess']

  private readonly core: OpenInAppCore

  constructor(ctx: Context) {
    super(ctx, OPEN_IN_APP_REMOTE_NAMESPACE)
    this.core = new OpenInAppCore({
      host: {
        platform: process.platform,
        resolveExecutable: async (name) => {
          try {
            // `subprocess` rides the Context merge of the type-only import
            // above: the composition's own PATH resolver, never a copy.
            return await ctx.subprocess.resolveExecutable(name)
          } catch {
            // Swallows the provider's not-found rejection: for detection, a
            // name that does not resolve has exactly one meaning — unavailable.
            return null
          }
        },
      },
    })
  }

  /** Zero-cost activation probe (design 18 §3.4 probe contract). */
  @Remote('probe')
  probe(): OpenInAppProbeValue {
    return this.core.probe()
  }

  /** Installed catalog ids in menu order. */
  @Remote('apps')
  apps(): Promise<OpenInAppDomainResult<OpenInAppAppsValue>> {
    return domainResult(() => this.core.apps())
  }

  /** One application's real bundle icon as base64. */
  @Remote('icon')
  icon(app: string): Promise<OpenInAppDomainResult<OpenInAppIconValue>> {
    return domainResult(() => this.core.icon(app))
  }

  /** Launch one installed application on one absolute directory. */
  @Remote('open')
  open(app: string, path: string): Promise<OpenInAppDomainResult<Record<string, never>>> {
    return domainResult(async () => {
      await this.core.open(app, path)
      return {}
    })
  }
}

export default OpenInAppGateway
