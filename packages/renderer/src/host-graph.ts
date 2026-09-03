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
 * `WebBootGraph` are the authoritative shapes). The plugin-graph diagnostic
 * types are the chamber shared face (sidebar shared/aggregate-store.ts, A4
 * single source) — imported below and re-exported, never re-declared.
 */

import { CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import type { PluginGraphDiagnostic, PluginGraphDiagnosticState } from '@dsh-chamber/dsh-client-ui-sidebar/shared'

/** Re-exported for existing consumers (the type lives in the chamber shared face). */
export type { PluginGraphDiagnostic, PluginGraphDiagnosticState }

/** One composed client entry row of the host boot graph (mirror of WebBootEntry).
 *  rc.8+ (dsh-v0.1.2-alpha.1) adds `external?: string[]` to WebBootEntry and
 *  moves bundle urls to the combo endpoint form (`/plugins/??<id>/client.js&rev=…`);
 *  this mirror deliberately omits `external` — the chamber merge preloads every
 *  kept row wholesale (the shared module-table factory branch covers cross-row
 *  require edges, boot.ts), so the field carries no meaning here and is dropped
 *  at parse (fetchHostGraph, line ~186). The url form is the single-id combo
 *  (each row's own script); the graph's multi-id combo BATCHES are ignored by
 *  the chamber merge (host-graph fetch reads `entries` only, see the fetch
 *  comment). */
export interface HostGraphRow {
  /** Entry name == package name (module-table key). */
  id: string
  /** Bundle endpoint, '/plugins/??<id>/client.js&rev=<rev>' (host-root-relative). */
  url: string
  /** Opaque bundle revision (`<per-process nonce>-<ordinal>` upstream; a
   *  cache-busting consistency anchor, NOT a content hash — every instance
   *  restart reallocates every rev, invalidating all previous bundle URLs). */
  rev: string
  /** Package-name dependency edges, informational. */
  inject?: string[]
  /** Stage-one prefetch mark (the chamber merge preloads everything it keeps). */
  immediately?: boolean
}

/** One extra module row handed to the boot kernel (shape = BootModuleRow
 *  minus `external`): dsh-v0.1.2-alpha.1 BootModuleRow requires `initialUrl`
 *  (the initial-load combo endpoint — the chamber preloads each entry's own
 *  combo, so it equals `url`) and `inject` (the chamber extras carry no
 *  package inject edges — the composite covers the whole official shell). */
export interface ExtraModuleRow {
  id: string
  url: string
  initialUrl: string
  rev: string
  inject: string[]
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

// The client-request / server-response envelope shape is AUTHORITATIVE in
// the control-plane Node package (packages/control-plane/src/rpc-envelope.ts,
// A2 cross-package protocol single-sourcing) — this renderer (browser-side)
// cannot import a Node package, so the envelope is hand-built here to the
// same wire shape; any change to the shared contract must land in
// rpc-envelope.ts first and be mirrored here (the desktop main-process
// probes consume the shared module directly through
// packages/desktop/control-plane-module.ts).

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
 * ('/plugins/??<id>/client.js&rev=…' → '<basePath>/plugins/??<id>/client.js&rev=…')
 * so the script element fetches same-origin through the instance proxy. The
 * combo syntax (`??<id>/client.js,<id2>/client.js&rev=…`) travels inside the
 * url unchanged — the first `?` begins the query string, which the host's
 * /plugins combo handler decodes; the instance proxy is a transparent
 * path+query passthrough (P2-13 runtime verification item).
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
    const url = `${basePath}${row.url}`
    out.push({
      id: row.id,
      url,
      // initialUrl == url: the chamber merge preloads each entry's own combo
      // (the graph's multi-id batches are ignored), so the row's initial-load
      // endpoint IS the preloaded script — the boot kernel's arrive() finds
      // the factory already registered and does not re-fetch.
      initialUrl: url,
      rev: row.rev,
      // The composite covers the whole official shell; kept extras are
      // standalone rows with no package inject edges to arrive first.
      inject: [],
    })
  }
  return out
}

/**
 * Extra host-graph bundles already preloaded for this page, keyed by BUNDLE
 * URL (page-level, shared across instances — the shell boot queue is
 * serialized, but the Maps keep the once-only rule explicit and record the
 * loaded rev parallel path). The shared module table refuses a duplicate
 * factory registration (the `__ModuleLoader__.load` sink throws on a repeat —
 * system.ts), so one script URL must never execute twice on a page.
 *
 * dsh-v0.1.2-alpha.1: bundle urls are combo endpoints (`/plugins/??…&rev=…`).
 * A combo script registers EVERY id its query names, so multiple graph rows
 * can share one url — the preload is therefore keyed by URL (each combo
 * loads once, registering all its rows' factories), and a second table
 * records which combo registered each id, so a LATER instance carrying the
 * same id at a NEWER rev cannot re-execute a second factory for it
 * (duplicate-registration sink) — that case reuses the loaded factory and
 * reports the honest diagnostic (restart-required for a rebuilt plugin on
 * the owning instance, instance-version-conflict for cross-instance dsh
 * runtime version drift — see below). A row that reappears at the same rev is
 * already covered by the shared load, whatever instance proxy its url was
 * fetched through (the module table is page-level).
 *
 * The in-flight promise is published BEFORE the load (so concurrent/duplicate
 * ids await the same execution instead of merely observing a premature
 * "loaded" mark). Ordinary load failures delete the url record AND the id
 * records it owned, so a retry re-preloads; a DOM-script timeout is
 * different: its tagged rejection remains a tombstone while the original
 * element can still execute. The loader exposes that element's eventual
 * result: a late load converts the entry to success; a late error deletes it
 * so a later boot may retry safely.
 * A failed preload must not otherwise be treated
 * as done — the module system does NOT re-fetch extra bundles on its own (an
 * extra row has no boot-graph row; a later system.ts import() would throw
 * "cannot resolve"), so a permanent mark would strand the plugin for the rest
 * of the page lifetime. An ordinary failed load is therefore recovered once
 * inside the SAME boot (a fresh graph re-fetch + reload, see collectExtraRows
 * below — upstream revs are opaque per-process nonces, so an instance
 * restart between graph fetch and bundle loads 404s every not-yet-loaded
 * row on a stale rev); a load that still fails then fails THIS instance's
 * boot loud (design 09 §4 fail-loud) and a retry boot re-preloads the bundle.
 *
 * First-load-wins (union-table model, design 09 §3.2): the combo that first
 * executed a factory owns the id forever; a later instance carrying the id at
 * a newer rev (a rebuilt plugin → different script) reuses the loaded factory
 * but gets an explicit diagnostic. The diagnostic distinguishes WHO owns the
 * id: the same instance at a newer rev (a rebuilt plugin, fixed by a restart
 * of that instance) reports restart-required; a DIFFERENT instance at a
 * newer rev (cross-instance dsh runtime version drift — the two hosts serve
 * the same plugin from different dsh runtimes) cannot be fixed by any
 * restart and reports instance-version-conflict instead (honest copy over
 * the misleading "restart the app to switch").
 */
interface PreloadedCombo {
  /** The ids whose factories this combo script registers (failure rollback set). */
  ids: Set<string>
  load: Promise<void>
}

const preloadedCombos = new Map<string, PreloadedCombo>()

/** The combo record whose script registered one id's factory, plus the row
 *  rev it was seen at (restart-conflict + failure rollback) and the instance
 *  that first claimed the id on this page (ownerSourceId — the first-load-
 *  wins owner; a LATER instance at a different rev is a cross-instance dsh
 *  runtime version drift when the owner is a different instance, vs. a
 *  restart-fixable rebuilt plugin when the owner is this same instance). The
 *  combo reference is held (not a promise snapshot) so a late-success
 *  conversion of the shared load is observed by later boots. */
interface PreloadedIdRecord {
  rev: string
  combo: PreloadedCombo
  /** Instance id that first claimed this id on this page (page-level map). */
  ownerSourceId: string
}

const preloadedIds = new Map<string, PreloadedIdRecord>()

/** A module element can still execute after its request-level timeout. The
 * explicit type keeps that one exceptional lifecycle distinct from ordinary
 * load failures without inspecting arbitrary thrown objects. */
export class BundleLoadTimeoutError extends Error {
  readonly bundleOutcome: Promise<boolean>

  constructor(message: string, bundleOutcome: Promise<boolean>) {
    super(message)
    this.bundleOutcome = bundleOutcome
  }
}

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
  /**
   * Retry budget for the transient 503 `instance_unavailable` pre-ready
   * signal (design 09 module C race: the shell may boot while the instance is
   * still starting; the proxy answers 503 fast and the graph appears moments
   * later). Only the fast 503-null path retries — a hung fetch (30s timeout)
   * or other channel failure still fails fast, so the budget is bounded by the
   * delay sum (~4.5s), never by per-attempt timeouts. Budget exhaustion keeps
   * today's silent-degrade contract (no extra plugins for this boot). The
   * 10-attempt default was widened from 6 (2026-08 review): the observed
   * local spawn→ready window is ~3s (control-plane host logs), which the
   * former 2.5s delay sum did not cover for a shell boot starting at spawn
   * time — the extra attempts are pure sleep on the fast 503 path, so a
   * genuinely failing channel (non-503) is unaffected.
   */
  retry?: {
    /** Total fetch attempts including the first. Default 10. */
    attempts?: number
    /** Delay between attempts. Default 500ms. */
    delayMs?: number
    /** Sleep implementation (test seam). Defaults to setTimeout. */
    sleep?(ms: number): Promise<void>
  }
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
 * `instance_unavailable` is the expected pre-ready state: the fetch is
 * retried on a bounded budget (the instance's graph appears moments after the
 * proxy stops answering 503 — see CollectExtraRowsDeps.retry) and only then
 * degrades silently, so a shell that boots inside the spawn window still gets
 * its profile plugins instead of losing them for the rest of the boot.
 *
 * A bundle that fails to LOAD is NOT a degrade: it throws, the instance's
 * boot fails loud and shows the error — a broken extra plugin must never
 * silently disappear (design 09 §4 fail-loud). Ordinary load failures get ONE
 * bounded recovery cycle first (2026-09, restart-straddle fix): upstream
 * bundle revs are opaque PER-PROCESS nonces (`<random>-<ordinal>`,
 * dsh-client-modules `allocateInitialRevision`), so every dsh instance
 * restart invalidates every bundle URL of the previous process generation —
 * a boot whose graph fetch and bundle loads straddle a restart (runtime
 * switches / restart-dsh / plugin-sync restarts are normal chamber
 * lifecycle) 404s every not-yet-loaded row. The recovery pass re-fetches the
 * host graph on the same bounded retry budget and reloads every failed row at
 * its fresh URL — a restart-stale rev re-resolves at the new one, a transient
 * transport blip gets one more attempt at the same one; only rows that STILL
 * fail (a genuine plugin problem — the unchanged-rev retry failed too — or
 * another restart during recovery) fail the boot loud. A DOM
 * script TIMEOUT is not part of the recovery cycle: its tagged tombstone
 * keeps observing the original element's eventual outcome (a late load is
 * success; a late error allows a later retry), exactly as before.
 */
export async function collectExtraRows(
  instanceId: string,
  basePath: string,
  deps: CollectExtraRowsDeps,
): Promise<ExtraModuleRow[]> {
  const retry = {
    attempts: deps.retry?.attempts ?? 10,
    delayMs: deps.retry?.delayMs ?? 500,
    sleep: deps.retry?.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms))),
  }
  /** Fetch the host graph on the bounded 503-retry budget. Resolves the rows,
   *  or `{ rows: null, error }` when the channel failed (non-503 — fail fast,
   *  a hung fetch already consumed its own 30s timeout) and `{ rows: null,
   *  error: null }` when the 503 budget ran out (instance still starting). */
  const fetchWithRetry = async (): Promise<{ rows: HostGraphRow[] | null; error: unknown }> => {
    let lastError: unknown = null
    for (let attempt = 1; attempt <= retry.attempts; attempt++) {
      try {
        const entries = await fetchHostGraph(basePath)
        if (entries !== null) return { rows: entries, error: null }
      } catch (error) {
        // Non-503 channel failures are NOT transient — fail fast as before
        // (a hung fetch already consumed its own 30s timeout; retrying would
        // only stack them).
        lastError = error
        break
      }
      // 503 instance_unavailable: instance still starting. Bounded retry.
      if (attempt < retry.attempts) await retry.sleep(retry.delayMs)
    }
    return { rows: null, error: lastError }
  }
  const firstFetch = await fetchWithRetry()
  if (firstFetch.error !== null) {
    console.error(`[shell] instance ${instanceId} host boot-graph fetch failed; booting without extra plugins`, firstFetch.error)
    reportDiagnostic(
      instanceId,
      firstFetch.error instanceof HostGraphChannelError ? firstFetch.error.diagnosticState : 'graph-unreachable',
      { message: firstFetch.error instanceof Error ? firstFetch.error.message : String(firstFetch.error) },
      deps.reportDiagnostic,
    )
    return []
  }
  if (firstFetch.rows === null) return []
  const rows = toExtraRows(dedupeHostEntries(firstFetch.rows, CHAMBER_COVERED_IDS), basePath)
  let restartConflict: ExtraModuleRow | undefined
  let versionConflict: ExtraModuleRow | undefined
  /** Rows whose FRESH load failed with an ordinary error (not a DOM-script
   *  timeout): candidates for the single bounded recovery pass below. */
  const failedRows: { row: ExtraModuleRow; error: unknown }[] = []

  /** Load one row's bundle once (shared-combo discipline). Throws for the
   *  non-recoverable classes — a DOM-script timeout (its tagged tombstone
   *  keeps observing the original element's eventual outcome), a failure of
   *  an already-claimed shared load, and (with `deferOrdinary = false`, the
   *  recovery pass) an ordinary failure. Ordinary fresh-load failures in the
   *  FIRST pass are recorded in `failedRows` and resolved by the recovery
   *  pass instead of failing the boot immediately. */
  const loadRow = async (row: ExtraModuleRow, deferOrdinary = true): Promise<void> => {
    // A script already executed a factory for this id (the id's combo record
    // is published at preload). A DIFFERENT rev (the combo query carries the
    // rev, so a newer plugin revision means a different script) cannot swap
    // the loaded factory without a restart: re-executing a second bundle for
    // the same id would hit the duplicate-registration sink. Reuse the loaded
    // factory and report the honest diagnostic; the merged row still surfaces.
    // NOTE: the shared module table is PAGE-level, so the id's factory — and
    // the original load — is shared across every instance; the per-instance
    // basePath prefix in `row.url` must NOT be treated as a different script
    // (same id + same rev = same factory, whatever instance proxy it was
    // fetched through).
    // The diagnostic distinguishes the owner (design 09 §3.5): a rebuilt
    // plugin on THIS same instance (ownerSourceId === instanceId) is fixed by
    // restarting that instance → restart-required; a DIFFERENT instance
    // serving the same plugin from another dsh runtime version is a
    // cross-instance version drift that no restart can fix →
    // instance-version-conflict (restarting the app would only re-run the
    // same first-load-wins claim).
    const owned = preloadedIds.get(row.id)
    if (owned !== undefined) {
      if (owned.rev !== row.rev) {
        if (owned.ownerSourceId !== instanceId) versionConflict ??= row
        else restartConflict ??= row
        return
      }
      // Await the ORIGINAL load (read live off the combo record): a
      // still-pending or tombstoned load must fail THIS boot loud too, and a
      // late-success conversion of the shared load is observed by later boots.
      try {
        await owned.combo.load
      } catch (error) {
        reportDiagnostic(instanceId, 'bundle-load-failed', {
          pluginId: row.id,
          message: error instanceof Error ? error.message : String(error),
        }, deps.reportDiagnostic)
        throw error
      }
      return
    }
    let combo = preloadedCombos.get(row.url)
    if (combo === undefined) {
      // Promise.resolve().then also normalizes a synchronously throwing test /
      // alternate loader into the same shared rejected promise.
      combo = {
        ids: new Set(),
        load: Promise.resolve().then(() => deps.loadModuleBundle(row.url)),
      }
      preloadedCombos.set(row.url, combo)
    }
    // Publish the ownership BEFORE the load (a concurrent row for the same
    // id must await the shared execution, never start its own) and fold this
    // id into the combo's rollback set. The url-level map is what dedupes a
    // multi-id combo: rows sharing one url await ONE load (each combo script
    // registers every id its query names).
    combo.ids.add(row.id)
    preloadedIds.set(row.id, { rev: row.rev, combo, ownerSourceId: instanceId })
    try {
      await combo.load
    } catch (error) {
      // 预加载失败不永久标记（见 Map 注释：模块系统不会自取 extra bundle，
      // 永久标记会把该插件在本页面永久卡死）。The combo record is the owner:
      // a retry installs a NEW record for the same url, so a later catch in
      // another waiter of the old promise must not clear the new one.
      const bundleOutcome = error instanceof BundleLoadTimeoutError ? error.bundleOutcome : null
      const clearCombo = (): void => {
        if (preloadedCombos.get(row.url) !== combo) return
        preloadedCombos.delete(row.url)
        for (const id of combo.ids) {
          if (preloadedIds.get(id)?.combo === combo) preloadedIds.delete(id)
        }
      }
      if (bundleOutcome === null) {
        // Ordinary failure — records are cleared so a later load of the same
        // or a newer URL is safe. The FIRST pass defers to the recovery pass
        // below; a recovery retry (`deferOrdinary = false`) has no further
        // recovery to defer to and fails loud.
        clearCombo()
        if (deferOrdinary) {
          failedRows.push({ row, error })
        } else {
          throw error
        }
      } else {
        // DOM-script timeout: removing the element does not reliably cancel
        // its fetch, so leave the tagged tombstone attached and observe the
        // eventual outcome (late load → success, late error → a later retry
        // is safe). A timeout is NOT part of the recovery cycle.
        void bundleOutcome.then(
          succeeded => {
            if (preloadedCombos.get(row.url) !== combo) return
            if (succeeded) combo.load = Promise.resolve()
            else clearCombo()
          },
          () => { clearCombo() },
        )
        reportDiagnostic(instanceId, 'bundle-load-failed', {
          pluginId: row.id,
          message: error instanceof Error ? error.message : String(error),
        }, deps.reportDiagnostic)
        throw error
      }
    }
  }
  await Promise.all(rows.map(row => loadRow(row)))
  // Bounded recovery cycle (2026-09 restart-straddle fix, module docstring):
  // upstream bundle revs are opaque per-process nonces, so an instance
  // restart between the graph fetch and the bundle loads makes every
  // not-yet-loaded row 404 on a stale rev. Re-fetch the host graph on the
  // same retry budget and reload every failed row at its fresh URL (a stale
  // rev re-resolves; a transient blip gets one more attempt at the same
  // URL). Only rows that STILL fail — a genuine plugin problem, or the
  // instance restarted again mid-recovery; a row missing from the fresh
  // graph was removed mid-boot — fail this boot loud with their (latest)
  // error. One cycle only: a boot that straddles another restart during
  // recovery fails loud and the shell's manual retry re-boots cleanly.
  if (failedRows.length > 0) {
    const secondFetch = await fetchWithRetry()
    const keptFailures: { row: ExtraModuleRow; error: unknown }[] = []
    const recoveredRows: ExtraModuleRow[] = []
    if (secondFetch.error !== null || secondFetch.rows === null) {
      // The graph channel failed again (or the 503 budget ran out): no fresh
      // verdict is available — keep every original failure loud.
      keptFailures.push(...failedRows)
    } else {
      const freshById = new Map(
        toExtraRows(dedupeHostEntries(secondFetch.rows, CHAMBER_COVERED_IDS), basePath)
          .map(fresh => [fresh.id, fresh] as const),
      )
      for (const failure of failedRows) {
        const fresh = freshById.get(failure.row.id)
        if (fresh === undefined) {
          keptFailures.push(failure)
          continue
        }
        try {
          // A recovery retry failing ordinary has no further recovery to
          // defer to — fail loud so the kept-failure set below is exact.
          await loadRow(fresh, false)
          recoveredRows.push(fresh)
        } catch (error) {
          keptFailures.push({ row: fresh, error })
        }
      }
    }
    // The recovered rows were loaded at their FRESH urls/revs — surface those
    // in the returned extra rows (the pass-1 urls died with the old process
    // generation and must never reach the boot kernel as loadable sources).
    if (recoveredRows.length > 0) {
      const recoveredById = new Map(recoveredRows.map(fresh => [fresh.id, fresh] as const))
      for (let index = 0; index < rows.length; index++) {
        const fresh = recoveredById.get(rows[index]!.id)
        if (fresh !== undefined) rows[index] = fresh
      }
    }
    if (keptFailures.length > 0) {
      for (const failure of keptFailures) {
        reportDiagnostic(instanceId, 'bundle-load-failed', {
          pluginId: failure.row.id,
          message: failure.error instanceof Error ? failure.error.message : String(failure.error),
        }, deps.reportDiagnostic)
      }
      throw keptFailures[0]!.error
    }
  }
  if (versionConflict !== undefined) {
    // Cross-instance plugin version drift (design 09 §3.5): a different
    // instance first claimed this id at another rev — the page keeps the
    // first-load-wins factory, and NO restart of the app can switch it
    // (the same first-load-wins claim would re-run). The honest copy names
    // the actual fix: align the two instances' dsh runtimes (or their
    // installed plugin versions — a rev is an opaque per-process bundle
    // revision, so a different dsh runtime generation or content change can
    // both produce the drift), after which the plugin revs
    // match and the diagnostic disappears.
    const ownerSourceId = preloadedIds.get(versionConflict.id)?.ownerSourceId ?? '—'
    reportDiagnostic(instanceId, 'instance-version-conflict', {
      pluginId: versionConflict.id,
      message: `实例间 ${versionConflict.id} 插件版本不同：已使用实例 ${ownerSourceId} 先加载的版本；对齐两个实例的 dsh 运行时（或插件）版本后可切换`,
    }, deps.reportDiagnostic)
  } else if (restartConflict !== undefined) {
    reportDiagnostic(instanceId, 'restart-required', {
      pluginId: restartConflict.id,
      message: `页面已加载 ${restartConflict.id} 的另一版本，重启应用后才能切换`,
    }, deps.reportDiagnostic)
  } else {
    reportDiagnostic(instanceId, 'ok', {}, deps.reportDiagnostic)
  }
  return rows
}
