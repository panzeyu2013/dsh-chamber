/**
 * Official host-catalog adapter (Batch 3 Phase 2, design 20 §2/§5).
 *
 * The instance's own host half (`@deepseek-ai/dsh-host-open-in-app`, part of
 * the default web bundle) serves the LOCAL application catalog over its own
 * origin: `GET /open-in-app/apps`, `GET /open-in-app/icon/<id>`,
 * `POST /open-in-app/open`. Under the chamber shell every instance is reached
 * through the control-plane per-instance proxy, so each request is prefixed
 * with the entry Context's `chamberBasePath` (`/api/i/<id>`); the proxy strips
 * the prefix, injects the instance's browser-auth cookie and forwards verbatim
 * — the control plane carries zero open-in code (design 03 §3.1).
 *
 * Fail-closed: an unreachable/refusing host reads as an empty catalog (the
 * official client's own policy), never a thrown UI. Launches reject so the
 * button can show its error dress.
 */
import {
  OPEN_IN_APP_APPS_ROUTE,
  OPEN_IN_APP_ICON_PREFIX,
  OPEN_IN_APP_OPEN_ROUTE,
  type OpenInAppAppsPayload,
  type OpenInAppOpenPayload,
} from '../shared/open-in-app-protocol.ts'
import type { OpenInApp } from '../shared/capabilities.ts'

type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface OfficialCatalogOptions {
  /** Per-entry proxy prefix (`/api/i/<id>`); '' = stock same-origin `/api` host. */
  readonly basePath: string
  /** Test seam; production uses the page's global fetch. */
  readonly fetcher?: Fetcher
  /** Test seam; production reads `location.origin` with the null-origin fallback. */
  readonly origin?: string
}

export interface OfficialCatalog {
  /** Probe the installed catalog once per call; [] on any failure (fail-closed). */
  load(): Promise<OpenInApp[]>
  /** Host-served PNG URL for one catalog id (the host answers 404 when absent). */
  iconUrl(appId: string): string
  /** Launch one catalog app on one absolute directory path; rejects on failure. */
  launch(appId: string, path: string): Promise<void>
}

/** Browser origin with the connection carrier's null-origin fallback (the
 *  same rule the official client uses for opaque origins). */
function defaultOrigin(): string {
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin
  return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
}

/**
 * Map a catalog id to the presentation family the chamber button knows:
 * file managers keep the neutral folder mark, the VS Code family keeps the
 * product mark, and every other catalog id is its own family (the absorbed
 * label table names it; unknown ids stay nameable-by-id and render the
 * generic mark).
 */
export function displayKindOf(appId: string): string {
  if (appId === 'finder' || appId === 'explorer' || appId === 'filemanager') return 'file-manager'
  if (appId === 'vscode' || appId === 'vscodeinsiders') return 'vscode'
  return appId
}

/**
 * Build a per-entry official catalog client.
 * @param options - per-entry base path plus test seams.
 * @returns the catalog client (pure over its injected fetcher/origin).
 */
export function createOfficialCatalog(options: OfficialCatalogOptions): OfficialCatalog {
  const base = options.origin ?? defaultOrigin()
  const prefix = options.basePath.replace(/\/+$/, '')
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init))
  const url = (path: string): string => `${base}${prefix}${path}`

  return {
    async load(): Promise<OpenInApp[]> {
      try {
        const response = await fetcher(url(OPEN_IN_APP_APPS_ROUTE), { headers: { accept: 'application/json' } })
        if (!response.ok) return []
        const payload = await response.json() as OpenInAppAppsPayload
        if (!Array.isArray(payload.apps)) return []
        return payload.apps
          .filter((id): id is string => typeof id === 'string' && id !== '')
          .map(id => ({ id, displayKind: displayKindOf(id), remoteCapable: false, available: true }))
      } catch {
        // Unreachable/refusing host = no official channel, never a broken button.
        return []
      }
    },

    iconUrl(appId: string): string {
      return url(`${OPEN_IN_APP_ICON_PREFIX}/${encodeURIComponent(appId)}`)
    },

    async launch(appId: string, path: string): Promise<void> {
      const body: OpenInAppOpenPayload = { app: appId, path }
      const response = await fetcher(url(OPEN_IN_APP_OPEN_ROUTE), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`open failed: HTTP ${String(response.status)}`)
    },
  }
}
