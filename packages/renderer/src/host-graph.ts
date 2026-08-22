/**
 * Per-instance host boot-graph merge (design 09, module C): the chamber
 * composite bundle statically registers the whole official dsh client shell
 * (chamber-entry.ts), so a per-instance boot needs no host graph — EXCEPT for
 * client plugins (`dsh.client` packages) installed into the instance's
 * profile: their rows are missing from the composite and their bundles must
 * be loaded at runtime. The host composes the same graph it would inject as
 * `window.__DSH_BOOT__` (dsh-client-modules' ClientModuleRegistry, vendor)
 * and the chamber frontend fetches it per instance over the reverse proxy
 * (`/api/i/<id>` — the chamber host gateway `@dsh-chamber/dsh-host-client-graph`
 * exposes it as Remote `clientGraph/graph`), drops the rows the chamber page
 * covers (chamber-covered.ts), and preloads the rest (collectExtraRows below —
 * the bundle loader is injected by shell.ts, which owns the DOM; the preload
 * completes BEFORE the AppWebEntry is constructed so each factory is
 * registered in the shared module table when loader.create materializes
 * entries — the factories branch).
 *
 * Trust boundary (design 09 §4, declared): a remote instance's client bundles
 * execute in the local renderer — the official model (the official web
 * profile loads everything its host serves); the host is authoritative and
 * the control plane is loopback-only (v1 has no auth surface). A plugin
 * missing its built `./client` bundle fails loud on the host AND here — never
 * silently dropped.
 *
 * Self-contained on purpose (no dsh package types, mirroring bridge-api.ts):
 * the wire shapes here are the fetch-carrier envelope and the graph rows
 * (vendor dsh-client-modules src/client/manifest.ts `WebBootEntry` /
 * `WebBootGraph` are the authoritative shapes).
 */

import { CHAMBER_COVERED_IDS } from './chamber-covered.ts'

export type PluginGraphDiagnosticState =
  | 'ok' | 'not-injected' | 'graph-unreachable' | 'bundle-load-failed' | 'restart-required'
export interface PluginGraphDiagnostic {
  state: PluginGraphDiagnosticState
  message?: string
  pluginId?: string
  updatedAt: number
}

/** One composed client entry row of the host boot graph (mirror of WebBootEntry).
 *  rc.8 adds `external?: string[]` to WebBootEntry; this mirror deliberately
 *  omits it — the chamber merge preloads every kept row wholesale (the shared
 *  module-table factory branch covers cross-row require edges, boot.ts), so
 *  the field carries no meaning here and is dropped at parse (line ~151). */
export interface HostGraphRow {
  /** Entry name == package name (module-table key). */
  id: string
  /** Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>' (host-root-relative). */
  url: string
  /** Bundle content hash (cache-busting consistency anchor). */
  rev: string
  /** Package-name dependency edges, informational. */
  inject?: string[]
  /** Stage-one prefetch mark (the chamber merge preloads everything it keeps). */
  immediately?: boolean
}

/** One extra module row handed to the boot kernel (shape = BootModuleRow). */
export interface ExtraModuleRow {
  id: string
  url: string
  rev: string
}

/** The fetch-carrier wire envelope (as consumed by bridge-api.ts). */
interface HostGraphEnvelope {
  rpcId: string
  result: {
    ok: boolean
    value?: unknown
    error?: { code?: string; message?: string }
  }
}

/** Bounded unary (mirror of bridge-api's 30s): a silently hung host must not wedge a boot. */
const GRAPH_TIMEOUT_MS = 30000

/** One transport failure, folded with an honest prefix (proxy honesty, design 03 §3.3). */
function wrapGraphError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`宿主启动图不可达：${message}`)
}

class HostGraphChannelError extends Error {
  readonly diagnosticState: Extract<PluginGraphDiagnosticState, 'not-injected' | 'graph-unreachable'>

  constructor(diagnosticState: Extract<PluginGraphDiagnosticState, 'not-injected' | 'graph-unreachable'>, message: string) {
    super(message)
    this.name = 'HostGraphChannelError'
    this.diagnosticState = diagnosticState
  }
}

/**
 * Fetch the instance's host boot graph over the reverse proxy (Remote
 * `clientGraph/graph`). Resolves to the composed `entries` rows, or null when
 * the instance is not ready yet (proxy 503 `instance_unavailable` — the
 * expected pre-ready state; callers treat it as "no extra plugins").
 *
 * Everything else fails LOUD: transport errors and non-2xx responses throw
 * (the caller degrades to no extras and logs), and malformed envelopes/rows
 * throw (bad data must never be silently merged — a wrong graph is a boot
 * hazard, not a candidate for guesswork).
 */
export async function fetchHostGraph(basePath: string): Promise<HostGraphRow[] | null> {
  const origin = typeof location !== 'undefined' ? location.origin : undefined
  const base = origin !== undefined && origin !== 'null' ? origin : ''
  const url = `${base}${basePath}/api/clientGraph/graph`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'clientGraph/graph',
        payload: { args: {} },
      }),
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    })
  } catch (error) {
    throw wrapGraphError(error)
  }
  if (response.status === 503) {
    let body: { code?: string } | null = null
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (body?.code === 'instance_unavailable') return null
  }
  if (!response.ok) {
    const state = response.status === 404 ? 'not-injected' : 'graph-unreachable'
    throw new HostGraphChannelError(state, `宿主启动图不可达：HTTP ${response.status}`)
  }
  let envelope: HostGraphEnvelope
  try {
    envelope = await response.json()
  } catch (error) {
    throw new Error(`宿主启动图：envelope 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof envelope !== 'object' || envelope === null || typeof envelope.result !== 'object' || envelope.result === null) {
    throw new Error('宿主启动图：envelope 缺少 result')
  }
  if (envelope.result.ok !== true) {
    const hostError = envelope.result.error?.message ?? envelope.result.error?.code ?? 'unknown'
    const classification = `${envelope.result.error?.code ?? ''} ${envelope.result.error?.message ?? ''}`
    const state = /not.?found|unknown.?method|method.+(?:missing|unknown|unsupported)/i.test(classification)
      ? 'not-injected'
      : 'graph-unreachable'
    throw new HostGraphChannelError(state, `宿主启动图：graph 调用失败：${hostError}`)
  }
  const value = envelope.result.value
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>).entries)) {
    throw new Error('宿主启动图：result.value.entries 必须是数组')
  }
  const rows: HostGraphRow[] = []
  for (const raw of (value as { entries: unknown[] }).entries) {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error('宿主启动图：entry 不是对象')
    }
    const row = raw as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
      throw new Error(`宿主启动图：entry ${JSON.stringify(row)} 必须携带 string id/url/rev`)
    }
    rows.push({
      id: row.id,
      url: row.url,
      rev: row.rev,
      // Optional wire fields are informational for the merge; carry them
      // through when well-formed, drop otherwise.
      ...(Array.isArray(row.inject) && row.inject.every(i => typeof i === 'string') ? { inject: row.inject as string[] } : {}),
      ...(typeof row.immediately === 'boolean' ? { immediately: row.immediately } : {}),
    })
  }
  return rows
}

/**
 * Drop the rows the chamber page already covers (design 09 §3.3): composite
 * registration (chamber-entry.ts) plus page-own rows (chamber-covered.ts).
 * Loading a covered row again would double-register the same plugin on one
 * cordis ctx — this filter is load-bearing, not an optimization.
 */
export function dedupeHostEntries(entries: readonly HostGraphRow[], covered: readonly string[]): HostGraphRow[] {
  const coveredIds = new Set(covered)
  return entries.filter(row => !coveredIds.has(row.id))
}

/**
 * Turn kept rows into module-table rows for the boot kernel, injecting the
 * per-instance proxy prefix into root-relative bundle urls
 * ('/plugins/<id>/client.js?rev=…' → '<basePath>/plugins/<id>/client.js?rev=…')
 * so the script element fetches same-origin through the instance proxy.
 * Non-root-relative urls (protocol-relative '//', absolute http(s)/blob/data:,
 * or relative) are dropped: a poisoned host graph must never steer the
 * module-script loader to an external origin.
 */
export function toExtraRows(rows: readonly HostGraphRow[], basePath: string): ExtraModuleRow[] {
  const out: ExtraModuleRow[] = []
  for (const row of rows) {
    // Only root-relative bundle urls ('/plugins/...') are valid: they are
    // proxied same-origin through basePath. Reject protocol-relative ('//'),
    // absolute (http(s)/blob/data:) and relative urls — a poisoned host graph
    // must never steer the module-script loader to an external origin.
    if (!row.url.startsWith('/') || row.url.startsWith('//')) {
      console.warn(`[host-graph] dropping non-root-relative bundle url for ${row.id}`)
      continue
    }
    out.push({ id: row.id, url: `${basePath}${row.url}`, rev: row.rev })
  }
  return out
}

/**
 * Extra host-graph bundles already preloaded for this page, keyed by entry id
 * (page-level, shared across instances — the shell boot queue is serialized,
 * but the Map keeps the once-only rule explicit and records the loaded rev
 * parallel path). The shared module table refuses a duplicate factory
 * registration (the `__ModuleLoader__.load` sink throws on a repeat —
 * system.ts), so one id must never execute its bundle twice on a page.
 *
 * The in-flight promise is published BEFORE the load (so concurrent/duplicate
 * ids await the same execution instead of merely observing a premature
 * "loaded" mark) and DELETED on failure — net effect: only a successful load
 * stays marked. A failed preload must not be treated
 * as done — the module system does NOT re-fetch extra bundles on its own (an
 * extra row has no boot-graph row; a later system.ts import() would throw
 * "cannot resolve"), so a permanent mark would strand the plugin for the rest
 * of the page lifetime. A failed load instead fails THIS instance's boot loud
 * (design 09 §4 fail-loud) and a retry boot re-preloads the bundle.
 *
 * Keyed by id — first-rev-wins (union-table model, design 09 §3.2). A later
 * instance carrying another rev reuses the loaded factory but gets an explicit
 * restart-required diagnostic.
 */
interface PreloadedExtraBundle {
  rev: string
  load: Promise<void>
}

const preloadedExtraBundles = new Map<string, PreloadedExtraBundle>()

function reportDiagnostic(
  instanceId: string,
  state: PluginGraphDiagnosticState,
  extra: { message?: string; pluginId?: string } = {},
  listener?: CollectExtraRowsDeps['reportDiagnostic'],
): void {
  listener?.(instanceId, { state, ...extra, updatedAt: Date.now() })
}

/** The shell-owned bundle loader, injected so pure-node tests can stub it (shell.ts owns the DOM). */
export interface CollectExtraRowsDeps {
  loadModuleBundle(url: string): Promise<void>
  reportDiagnostic?(sourceId: string, diagnostic: PluginGraphDiagnostic): void
}

/**
 * Fetch the instance's host boot graph, drop the rows the chamber page already
 * covers (design 09 §3.2/§3.3), and preload the remaining bundles BEFORE the
 * AppWebEntry is constructed: a bundle registers its factory through the shared
 * module table at script execution, and boot-time entry creation materializes
 * entries through the table's factories branch — so the factory must exist
 * before loader.create runs, not after.
 *
 * Degrades to [] when the graph CHANNEL fails (fetch throws — network /
 * non-2xx / malformed graph): the boot proceeds without extra plugins; the
 * composite still provides the entire official shell, only profile-installed
 * client plugins are lost (graph-channel failure degrade). A 503
 * `instance_unavailable` is the expected pre-ready state and stays silent
 * (fetchHostGraph resolves null). A bundle that fails to LOAD is NOT a
 * degrade: it throws, the instance's boot fails loud and shows the error —
 * a broken extra plugin must never silently disappear (design 09 §4 fail-loud).
 */
export async function collectExtraRows(
  instanceId: string,
  basePath: string,
  deps: CollectExtraRowsDeps,
): Promise<ExtraModuleRow[]> {
  let entries: HostGraphRow[] | null
  try {
    entries = await fetchHostGraph(basePath)
  } catch (error) {
    console.error(`[shell] instance ${instanceId} host boot-graph fetch failed; booting without extra plugins`, error)
    reportDiagnostic(
      instanceId,
      error instanceof HostGraphChannelError ? error.diagnosticState : 'graph-unreachable',
      { message: error instanceof Error ? error.message : String(error) },
      deps.reportDiagnostic,
    )
    return []
  }
  if (entries === null) return []
  const rows = toExtraRows(dedupeHostEntries(entries, CHAMBER_COVERED_IDS), basePath)
  let restartConflict: ExtraModuleRow | undefined
  await Promise.all(rows.map(async (row) => {
    let loaded = preloadedExtraBundles.get(row.id)
    if (loaded !== undefined) {
      if (loaded.rev !== row.rev) restartConflict ??= row
    } else {
      // Promise.resolve().then also normalizes a synchronously throwing test /
      // alternate loader into the same shared rejected promise.
      loaded = {
        rev: row.rev,
        load: Promise.resolve().then(() => deps.loadModuleBundle(row.url)),
      }
      preloadedExtraBundles.set(row.id, loaded)
    }
    try {
      await loaded.load
    } catch (error) {
      // 预加载失败不永久标记（见 Map 注释：模块系统不会自取 extra bundle，
      // 永久标记会把该插件在本页面永久卡死）——删除标记后重抛，本次 boot
      // 响亮失败，重试 boot 会重新预加载。
      // Only the owner still installed in the map may clear it. This guards a
      // retry installed after a rejection from being deleted by a later catch
      // in another waiter of the old promise.
      if (preloadedExtraBundles.get(row.id) === loaded) preloadedExtraBundles.delete(row.id)
      reportDiagnostic(instanceId, 'bundle-load-failed', {
        pluginId: row.id,
        message: error instanceof Error ? error.message : String(error),
      }, deps.reportDiagnostic)
      throw error
    }
  }))
  if (restartConflict !== undefined) {
    reportDiagnostic(instanceId, 'restart-required', {
      pluginId: restartConflict.id,
      message: `页面已加载 ${restartConflict.id} 的另一版本，重启应用后才能切换`,
    }, deps.reportDiagnostic)
  } else {
    reportDiagnostic(instanceId, 'ok', {}, deps.reportDiagnostic)
  }
  return rows
}
