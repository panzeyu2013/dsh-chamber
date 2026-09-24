/**
 * Per-instance open-in host gateway: the fork of upstream's open-in host half, seeded into each
 * managed local dsh instance (catalog, real bundle icons, launching a directory in an app).
 *
 * TRUST MODEL: reached over the instance's own generic RPC channel (typert Remote namespace
 * `openInApp`) behind the same fence as every other instance API; no webServer route, no trust
 * logic of its own. The browser submits two untrusted values — a catalog id matched against the
 * closed catalog (never argv) and an absolute, non-empty existing directory — and no shell
 * string is ever constructed (`./core.ts` validates); only the catalog's own launcher argv can
 * run. `probe()` is the zero-cost probe; the others answer the explicit `{ok,value}|{ok:false,error}`
 * carrier (the generic gateway drops thrown fields); catalog/resolver/icons stay upstream copies.
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

/** Remote-only facade: all catalog, icon and launch policy lives in the pure core. */
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
            // `subprocess` rides the Context merge of the type-only import above.
            return await ctx.subprocess.resolveExecutable(name)
          } catch {
            // Swallow the not-found rejection: for detection, unresolvable = unavailable.
            return null
          }
        },
      },
    })
  }

  /** Zero-cost activation probe: platform plus protocol only, answered in the shared
   *  domain carrier so the runtime probe can shape-check it like every other domain. */
  @Remote('probe')
  probe(): Promise<OpenInAppDomainResult<OpenInAppProbeValue>> {
    return domainResult(async () => this.core.probe())
  }

  /** Installed catalog ids in menu order. */
  @Remote('apps')
  apps(): Promise<OpenInAppDomainResult<OpenInAppAppsValue>> {
    return domainResult(() => this.core.apps())
  }

  /** One application's real bundle icon, base64. */
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
