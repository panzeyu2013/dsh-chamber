/**
 * Per-instance host boot-graph merge (design 09, module C): the chamber
 * composite bundle statically registers the whole official dsh client shell
 * (chamber-entry.ts), so a per-instance boot needs no host graph — EXCEPT for
 * client plugins (`dsh.client` packages) installed into the instance's
 * profile: their rows are missing from the composite and their bundles must
 * be loaded at runtime. The host composes the same graph it would inject as
 * `window.__DSH_BOOT__` (dsh-client-modules' ClientModuleRegistry, vendor)
 * and the chamber frontend fetches it per instance over the reverse proxy
 * (`/api/i/<id>` — the chamber host gateway `@dsh-chamber/dsh-chamber-seed-client-graph`
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
 *
 * P4-2 (N6): the shared transport byte of fetchHostGraph — URL join +
 * client-request envelope + POST + body collection, bounded unary 30s — rides
 * the shared kernel postUnary (sidebar shared/wire-common.ts), imported HERE
 * by real-source relative path rather than the
 * '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared' specifier: the renderer has no
 * install-tree copy of the sidebar package, and its plain-node tests
 * (host-graph.test.ts, no module loader) must resolve the real module without
 * a bundler. Specifier imports from other renderer files resolve to the same
 * real source through the root tsconfig paths added in P4-4 (the former
 * vendor-modules.d.ts ambient overlay was deleted in the same step — no
 * ambient table is involved any more). Every status/envelope classification
 * below stays local — the envelope contract source remains
 * packages/control-plane/src/rpc-envelope.ts (the browser cannot import that
 * Node module; the client-request half is now built by the shared kernel).
 */

import { CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import type { PluginGraphDiagnostic, PluginGraphDiagnosticState } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import {
  classifyGraphChannelFailure, postUnary, type UnaryPostOutcome,
} from '../../dsh-chamber-client-ui-sidebar/src/shared/wire-common.ts'
// Page-level client-plugin load kernel (2026-12 settings-surface extension):
// the boot path and the settings bridge share ONE implementation of combo/id
// bookkeeping, timeout tombstones and rev-conflict facts. Imported by real
// relative source path for the same reason wire-common is (the renderer has no
// install-tree copy of the sidebar package and its plain-node tests must
// resolve the real module without a bundler).
import {
  BundleLoadTimeoutError,
  clientPluginRowOwner,
  dedupeCoveredRows,
  loadClientPluginRows,
  publishSourceClientGraph,
  type ClientRowOutcome,
} from '../../dsh-chamber-client-ui-sidebar/src/shared/client-plugin-loader.ts'

export { BundleLoadTimeoutError }

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
// cannot import a Node package (the desktop main-process probes consume the
// shared module directly through packages/desktop/control-plane-module.ts),
// so the client-request half is built by the shared browser kernel
// (wire-common.ts postUnary, P4-2) and the server-response classification
// below stays local; any change to the shared contract must land in
// rpc-envelope.ts first and be mirrored there.

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
  // Shared transport byte (P4-2): URL join + client-request envelope + POST +
  // body collection with the bounded-unary 30s budget, postUnary in
  // wire-common.ts; the pre-migration bare crypto.randomUUID() rpcId is kept
  // explicit so its evaluation stays inside this try (a no-randomUUID
  // environment folds the throw into the local wire error below, exactly as
  // the hand-built fetch did). Transport rejections propagate raw.
  let outcome: UnaryPostOutcome
  try {
    outcome = await postUnary(basePath, 'clientGraph/graph', {}, {
      rpcId: crypto.randomUUID(),
    })
  } catch (error) {
    throw wrapGraphError(error)
  }
  if (outcome.status === 503) {
    const body = outcome.body as { code?: string } | null
    if (body?.code === 'instance_unavailable') return null
  }
  if (!outcome.ok) {
    const state = outcome.status === 404 ? 'not-injected' : 'graph-unreachable'
    throw new HostGraphChannelError(state, `宿主启动图不可达：HTTP ${outcome.status}`)
  }
  if (outcome.jsonError !== undefined) {
    const error = outcome.jsonError
    throw new Error(`宿主启动图：envelope 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const envelope = outcome.body as HostGraphEnvelope
  if (typeof envelope !== 'object' || envelope === null || typeof envelope.result !== 'object' || envelope.result === null) {
    throw new Error('宿主启动图：envelope 缺少 result')
  }
  if (envelope.result.ok !== true) {
    const hostError = envelope.result.error?.message ?? envelope.result.error?.code ?? 'unknown'
    const state = classifyGraphChannelFailure(`${envelope.result.error?.code ?? ''} ${envelope.result.error?.message ?? ''}`)
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
  // Single-sourced with the settings bridge (sidebar shared face): the same
  // first-load-wins union-table rule decides what the page may load again.
  return dedupeCoveredRows(entries, covered)
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
 *
 * 2026-12: the combo/id tables, the timeout tombstone and the per-row load
 * verdicts MOVED to the sidebar shared face (`client-plugin-loader.ts`) so the
 * settings bridge mounts a source's plugins through the exact same
 * bookkeeping. This module keeps the BOOT policy: fail loud, one bounded
 * recovery pass, and the per-boot diagnostic projection.
 */
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
   * Instance-serving gate for the 503 path (2026-09-10, sidebarRight 彻底修复):
   * `503 instance_unavailable` means "the instance is not serving YET", not
   * "the graph is broken" — but the boot window is short, and a cold local
   * start or a restart-straddled attach routinely outlives it, which used to
   * cost the boot its whole client-plugin set (and silently: see
   * {@link onGraphUnavailable}). The App supplies this gate from its own
   * per-source phase projection; it resolves true once the source is serving
   * again, false when the source left / the gate's own deadline passed.
   * Omitted (pure-node tests, mobile shape) → the legacy fixed budget only.
   */
  waitForServing?(instanceId: string): Promise<boolean>
  /**
   * This boot settled WITHOUT the host graph (503 budget + serving wait both
   * exhausted). The rows are gone for this boot, but the source is expected to
   * serve later, so the shell records the fact and the App re-boots the
   * instance once the source turns ready (2026-09-10). Never called for a
   * non-503 channel failure: an instance that does not inject the graph at all
   * (gateway/mobile shapes) is legitimate, not degraded.
   */
  onGraphUnavailable?(message: string): void
  /**
   * The authoritative roster proof this boot belongs to (2026-12): the fetched
   * graph is published into the page-level cache under it, so the settings
   * panel only reuses the rows for the SAME source incarnation. Omitted
   * callers publish under '' (never reused across an incarnation change).
   */
  sourceFingerprint?: string
  /**
   * C3 (2026-09 性能审计): awaited once the graph rows are known, BEFORE the
   * first extra-bundle load pass. The chamber composite entry evaluates
   * inside this window and its covered-factory registration answers the
   * `@deepseek-ai/dsh-client-ui-primitives` require edges the seed no longer
   * serves (dsh-client-web seed.ts/platform.ts deviation). The graph fetch
   * itself stays concurrent with the chamber evaluation — the gate is only at
   * the load step, so a slow/503-retrying instance probe overlaps the chamber
   * entry's main-thread eval. Optional: absent callers keep today's ordering.
   */
  awaitBeforeLoad?(): Promise<void>
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
 * non-2xx / malformed graph): the boot proceeds without extra plugins. That is
 * NOT a complete shell any more (2026-09 二轮, alpha.2 sources): three inject
 * members of the composite's own first-screen families are provided by
 * non-covered official rows — `sidebarRight` (ui-sidebar-right, required by
 * ui-chat), `fileUpload` (client-file-upload, required by ui-conversation's
 * root inject), and `resources` (client-resources, the global `useResource`
 * seat). On a degrade those fibers stay PENDING, so the conversation view or
 * the whole centre column disappears while boot still reports success; the
 * `assertRequiredExtraRowServices` probe in chamber-entry.ts turns that into a
 * loud, named diagnostic (design 09 §3.2). A 503
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
/**
 * How many times one boot may wait for the source to start serving before it
 * gives up on the graph. ONE is the honest bound: the wait is already as long
 * as the App's readiness gate (60s), and a source that serves but still has no
 * answerable graph is a channel problem, not a serving problem. A source that
 * restarts *while* this boot waits therefore ends degraded — and the App's
 * self-heal re-boots it on the next ready transition, which is the layer that
 * owns repeated attempts.
 */
const MAX_SERVING_WAITS = 1

/**
 * Backstop wall-clock ceiling for the serving wait of one boot (the gate itself
 * is capped at 60s by the App; parallel to the shell's 60s page-level slot).
 */
const SERVING_HEAL_BUDGET_MS = 70_000

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
  /** Fetch the host graph on the bounded 503-retry budget, then (when the App
   *  gave us a serving gate) wait for the source to actually serve and retry on
   *  a fresh budget. Resolves the rows, `{ rows: null, error }` when the
   *  channel failed (non-503 — fail fast, a hung fetch already consumed its own
   *  30s timeout), and `{ rows: null, error: null, starting: true }` when both
   *  the budget and the serving waits ran out (instance still not serving). */
  const fetchWithRetry = async (): Promise<{ rows: HostGraphRow[] | null; error: unknown; starting: boolean }> => {
    let lastError: unknown = null
    let servingWaits = 0
    const healDeadline = deps.waitForServing === undefined ? 0 : Date.now() + SERVING_HEAL_BUDGET_MS
    for (;;) {
      for (let attempt = 1; attempt <= retry.attempts; attempt++) {
        try {
          const entries = await fetchHostGraph(basePath)
          if (entries !== null) return { rows: entries, error: null, starting: false }
        } catch (error) {
          // Non-503 channel failures are NOT transient — fail fast as before
          // (a hung fetch already consumed its own 30s timeout; retrying would
          // only stack them).
          lastError = error
          return { rows: null, error: lastError, starting: false }
        }
        // 503 instance_unavailable: instance still starting. Bounded retry.
        if (attempt < retry.attempts) await retry.sleep(retry.delayMs)
      }
      // The budget is gone and the channel never answered non-503 → the source
      // is still starting. Wait for it (App-bounded) and retry on a fresh
      // budget; a source that never serves ends here with `starting: true`.
      if (deps.waitForServing === undefined
        || servingWaits >= MAX_SERVING_WAITS
        || Date.now() >= healDeadline) {
        return { rows: null, error: lastError, starting: true }
      }
      servingWaits += 1
      const serving = await deps.waitForServing(instanceId)
      if (!serving) return { rows: null, error: lastError, starting: true }
    }
  }
  const firstFetch = await fetchWithRetry()
  if (firstFetch.rows === null && firstFetch.error === null && firstFetch.starting) {
    // 2026-09-10 (sidebarRight 彻底修复): this used to degrade in TOTAL
    // silence. The boot keeps succeeding (a gateway/mobile shape may legitimately
    // run without the graph, so a hard gate would be wrong), but a source that
    // is merely slow now (a) names itself in the log, (b) publishes the
    // `graph-unreachable` diagnostic the connections page renders, and (c) tells
    // the shell, which hands the fact to the App so the instance is re-booted
    // once the source turns ready — instead of losing its client plugins (and,
    // through ui-chat's `sidebarRight` inject, the whole conversation view) for
    // the lifetime of the mount.
    const message = `instance did not serve its client plugin graph inside the boot window `
      + `(${retry.attempts}×${retry.delayMs}ms${deps.waitForServing === undefined ? '' : ' + serving wait'}); `
      + 'this boot carries no profile client plugins'
    console.error(`[shell] instance ${instanceId} boot-graph unavailable: ${message}`)
    reportDiagnostic(instanceId, 'graph-unreachable', { message }, deps.reportDiagnostic)
    deps.onGraphUnavailable?.(message)
    return []
  }
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
  if (firstFetch.rows === null) {
    // Non-503 channel failure already logged + published above; the boot
    // continues without profile plugins (the documented gateway/mobile shape).
    return []
  }
  // The RAW rows the page-level cache will publish (2026-12). Kept in a
  // variable so the bounded recovery pass below can replace it with the FRESH
  // read: publishing the pre-recovery rows would hand the settings panel stale
  // bundle revs (per-process nonces) that 404 after a restart-straddled boot.
  let rawRows = firstFetch.rows
  const rows = toExtraRows(dedupeHostEntries(firstFetch.rows, CHAMBER_COVERED_IDS), basePath)
  // C3: the chamber entry must have evaluated before any extra bundle executes
  // (its covered factory answers the ui-primitives platform-word require edges
  // the seed no longer serves — see the deps comment). The gate promise was
  // already fired by the shell in parallel with this graph fetch.
  if (deps.awaitBeforeLoad !== undefined && rows.length > 0) {
    await deps.awaitBeforeLoad()
  }
  let restartConflict: ExtraModuleRow | undefined
  let versionConflict: ExtraModuleRow | undefined
  /** Rows whose FRESH load failed with an ordinary error (not a DOM-script
   *  timeout): candidates for the single bounded recovery pass below. */
  const failedRows: { row: ExtraModuleRow; error: unknown }[] = []

  /** Shared-kernel seams for this boot: the shell's transport plus the
   *  page-level diagnostic sink (the kernel reports a shared-load failure and
   *  a DOM-script timeout itself; the boot maps the rest). */
  const rowLoadDeps = {
    loadBundle: deps.loadModuleBundle,
    ...(deps.reportDiagnostic === undefined ? {} : { reportDiagnostic: deps.reportDiagnostic }),
  }
  /** Map one kernel verdict into this boot's policy: a rev conflict is
   *  recorded (the loaded factory is reused; the diagnostic is projected at the
   *  end of the boot), an ordinary first-pass failure defers to the recovery
   *  pass below. A DOM-script timeout and a non-deferred failure reject inside
   *  the kernel exactly as the boot has always required (fail loud). */
  const applyOutcome = (outcome: ClientRowOutcome<ExtraModuleRow>): void => {
    if (outcome.state === 'rev-conflict') {
      if (outcome.conflict === 'version') versionConflict ??= outcome.row
      else restartConflict ??= outcome.row
      return
    }
    if (outcome.state === 'failed') failedRows.push({ row: outcome.row, error: outcome.error })
  }
  for (const outcome of await loadClientPluginRows(instanceId, rows, rowLoadDeps, {
    ordinary: 'defer',
    timeout: 'throw',
  })) {
    applyOutcome(outcome)
  }
  // The C3 gate (`deps.awaitBeforeLoad`) is NOT re-awaited here: it settled
  // before the first load pass above, and the recovery reloads only re-execute
  // bundle scripts (registering factories); the synchronous require edges they
  // carry run later, during run()'s loader.create materialization — by then
  // the chamber entry has evaluated (or its failure is loud via the known
  // create-side race, chamber-entry.ts header). Do not add a second gate here.
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
    if (secondFetch.error === null && secondFetch.rows !== null) rawRows = secondFetch.rows
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
          await loadClientPluginRows(instanceId, [fresh], rowLoadDeps, {
            ordinary: 'throw',
            timeout: 'throw',
          })
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
    const ownerSourceId = clientPluginRowOwner(versionConflict.id) ?? '—'
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
  // Publish the source's LATEST raw rows into the page-level cache: the
  // settings panel reuses this exact read for the same source incarnation
  // instead of paying another round trip, and both consumers then agree on the
  // plugin set (post-recovery, so the revs are the live ones).
  publishSourceClientGraph(instanceId, {
    sourceFingerprint: deps.sourceFingerprint ?? '',
    rows: rawRows,
  })
  return rows
}
