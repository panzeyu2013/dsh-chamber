/**
 * Local application catalog client (design 20 §4.2) — the instance-hosted pool.
 *
 * The catalog, the applications' real bundle icons and the launches are served
 * by the chamber host domain `openInApp/*` running INSIDE the managed instance
 * (`packages/dsh-chamber-seed-open-in`, the fork of upstream's open-in host
 * half). This module is the browser half of that contract: it owns the wire
 * parsing and nothing else — the transport is an injected call, which in
 * production is the page's machine catalog reading the LOCAL instance through
 * the page-level instance client (`sidebar/shared/instance-api.ts`, the same
 * route, envelope and trust fence every entry uses — design 20 §4.2/§5).
 *
 * Fail-closed, like the surrounding button: an unreachable, refusing, drifted
 * or hostile host reads as an EMPTY catalog and never as a thrown UI; a failed
 * icon reads as "no icon", which the button renders through upstream's rounded
 * square (the catalog answered no pixels for that id); only a launch rejects,
 * because that is the one outcome the user must see.
 *
 * TWO envelope levels, one owner each (2026-09-13 fix): the injected call is
 * the page-level instance client's `callUnary`, so its answer is the TRANSPORT
 * result `{ok:true,value}` / `{ok:false,error}`; `value` is then the host
 * domain's own carrier, because every `openInApp/*` method returns
 * `domainResult(…)` (`packages/dsh-chamber-seed-open-in/src/core.ts`). This
 * module consumes both levels — reading only the first one is what made the
 * production read answer an empty catalog while the unit stubs (which fed the
 * domain carrier directly) stayed green.
 */
import type { OpenInApp } from '../shared/capabilities.ts'
import {
  OPEN_IN_APP_APPS_METHOD,
  OPEN_IN_APP_ICON_METHOD,
  OPEN_IN_APP_ICON_MIME_ALLOWLIST,
  OPEN_IN_APP_OPEN_METHOD,
  type OpenInAppAppsValue,
  type OpenInAppDomainError,
  type OpenInAppDomainResult,
  type OpenInAppIconValue,
} from '../shared/open-in-wire.ts'

/**
 * One generic-RPC call against this entry's instance — in production the
 * page-level instance client's `callUnary` (`sidebar/shared/instance-api.ts`
 * `getInstanceClient('local')`). The carrier adds the per-instance base path
 * (`/api/i/<id>`) and the connection's own trust handling; `args` is the wire
 * envelope's argument map (parameter names). It answers the TRANSPORT result
 * `{ok:true,value}|{ok:false,error}`, whose `value` is the host domain's own
 * carrier — see `domainCarrierOf` below, which reads both levels.
 */
export type OpenInAppRpcCall = (
  endpoint: string,
  args: Readonly<Record<string, unknown>>,
  signal?: AbortSignal,
) => Promise<unknown>

export interface LocalCatalogOptions {
  readonly call: OpenInAppRpcCall
}

export interface LocalCatalog {
  /** Installed catalog entries; [] on any failure (fail-closed). */
  load(): Promise<OpenInApp[]>
  /** A `data:` URL for one catalog id, or null when the host serves no icon. */
  icon(appId: string): Promise<string | null>
  /** Launch one catalog app on one absolute directory path; rejects on failure. */
  launch(appId: string, path: string): Promise<void>
}

/**
 * Map a catalog id to the presentation family the chamber button knows:
 * file managers keep the neutral folder mark, the VS Code family keeps the
 * product mark, and every other catalog id is its own family (the label table
 * names it; unknown ids stay nameable-by-id and render the generic mark).
 */
export function displayKindOf(appId: string): string {
  if (appId === 'finder' || appId === 'explorer' || appId === 'filemanager') return 'file-manager'
  if (appId === 'vscode' || appId === 'vscodeinsiders') return 'vscode'
  return appId
}

/** Read the `{ok,value}|{ok:false,error}` envelope without trusting its shape. */
function carrierOf(raw: unknown): OpenInAppDomainResult<unknown> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { ok } = raw as { ok?: unknown }
  if (ok === true) return { ok: true, value: (raw as { value?: unknown }).value }
  if (ok === false) {
    const error = (raw as { error?: unknown }).error
    if (typeof error !== 'object' || error === null) return null
    const { code, message, retryable } = error as { code?: unknown; message?: unknown; retryable?: unknown }
    if (typeof code !== 'string' || typeof message !== 'string') return null
    const parsed: OpenInAppDomainError = {
      code: code as OpenInAppDomainError['code'],
      message,
      ...(retryable === true ? { retryable: true } : {}),
    }
    return { ok: false, error: parsed }
  }
  return null
}

/**
 * Read one answer from the injected transport (`callUnary`, the page-level
 * instance client). Its result is the generic-RPC envelope: `{ok:true,value}`
 * when the Remote answered — `value` being the host domain's own carrier, see
 * the module header — and `{ok:false,error}` when the RPC layer itself refused
 * the call (the Remote threw, the gateway rejected the payload, internal
 * error). A real transport failure (unreachable instance, non-2xx without the
 * domain-missing opt-in, timeout) never reaches here: `callUnary` THROWS it,
 * which the callers below already catch.
 *
 * A refusal is projected onto the domain carrier's failure arm so the callers
 * keep ONE decision surface (`carrier.ok`): `load`/`icon` fail closed either
 * way, while `launch` reports what the RPC layer actually said instead of
 * calling a named failure "unrecognizable". Only the success arm can carry a
 * domain PAYLOAD, so a drifted result still reads as "no domain answer".
 */
function domainCarrierOf(raw: unknown): OpenInAppDomainResult<unknown> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { ok } = raw as { ok?: unknown }
  if (ok === true) return carrierOf((raw as { value?: unknown }).value)
  if (ok === false) return carrierOf({ ok: false, error: (raw as { error?: unknown }).error })
  return null
}

/** Parse one `apps()` value: a string array, filtered element by element. */
function parseApps(value: unknown): OpenInApp[] | null {
  if (typeof value !== 'object' || value === null) return null
  const apps = (value as Partial<OpenInAppAppsValue>).apps
  if (!Array.isArray(apps)) return null
  const seen = new Set<string>()
  const entries: OpenInApp[] = []
  for (const id of apps) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    seen.add(id)
    entries.push({ id, displayKind: displayKindOf(id), remoteCapable: false, available: true })
  }
  return entries
}

/** Parse one `icon()` value into a `data:` URL, or null when unusable. */
function parseIcon(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const { mime, dataBase64 } = value as Partial<OpenInAppIconValue>
  if (typeof mime !== 'string' || typeof dataBase64 !== 'string' || dataBase64 === '') return null
  if (!OPEN_IN_APP_ICON_MIME_ALLOWLIST.includes(mime)) return null
  return `data:${mime};base64,${dataBase64}`
}

/**
 * Build a per-entry local catalog client.
 * @param options - the injected RPC carrier (the page-level instance client's
 *   `callUnary`; both envelope levels are read here, see `domainCarrierOf`).
 * @returns the catalog client (pure over its injected call).
 */
export function createLocalCatalog(options: LocalCatalogOptions): LocalCatalog {
  return {
    async load(): Promise<OpenInApp[]> {
      try {
        const carrier = domainCarrierOf(await options.call(OPEN_IN_APP_APPS_METHOD, {}))
        if (carrier === null || !carrier.ok) return []
        return parseApps(carrier.value) ?? []
      } catch {
        // Unreachable/refusing instance = no local channel, never a broken button.
        return []
      }
    },

    async icon(appId: string): Promise<string | null> {
      try {
        const carrier = domainCarrierOf(await options.call(OPEN_IN_APP_ICON_METHOD, { app: appId }))
        if (carrier === null || !carrier.ok) return null
        return parseIcon(carrier.value)
      } catch {
        return null
      }
    },

    async launch(appId: string, path: string): Promise<void> {
      const carrier = domainCarrierOf(await options.call(OPEN_IN_APP_OPEN_METHOD, { app: appId, path }))
      if (carrier === null) throw new Error('open-in host answered an unrecognizable result')
      if (!carrier.ok) throw new Error(`${carrier.error.code}: ${carrier.error.message}`)
    },
  }
}
