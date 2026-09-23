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
 * Self-contained on purpose (no dsh package types, like the other self-built
 * wire carriers such as the client-core instance-api.ts):
 * the wire shapes here are the fetch-carrier envelope and the graph rows
 * (vendor dsh-client-modules src/client/manifest.ts `WebBootEntry` /
 * `WebBootGraph` are the authoritative shapes; the two pure WIRE HELPERS of
 * that module — `optionalStringArray` / `stripClientSuffix` — are imported by
 * real-source relative path). The
 * plugin-graph diagnostic
 * types are the chamber client-core face (client-core src/aggregate-store.ts,
 * the single source) — imported below and re-exported, never re-declared.
 *
 * The shared transport byte of fetchHostGraph — URL join +
 * client-request envelope + POST + body collection, bounded unary 30s — rides
 * the shared kernel postUnary (@dsh-chamber/dsh-chamber-client-core/wire-common),
 * and the HTTP-status/envelope classification rides the SHARED single source
 * plugin-graph-classify.ts (audit arch-03 P2-2): client-core's channel recheck
 * consumes the same module, so a boot verdict and a self-heal verdict for the
 * same wire answer can never drift. Since R4 P3 the renderer declares a real
 * dependency on client-core, so the package faces (wire-common /
 * plugin-graph-classify / client-plugin-loader / instance-api, plus the `.`
 * face for the diagnostic types) resolve through the workspace node_modules
 * link + the core package exports (source targets) — no alias, no ambient
 * table, no root tsconfig path. The envelope contract source remains
 * packages/control-plane/src/rpc-envelope.ts (the browser cannot import that
 * Node module; the client-request half is built by the shared kernel).
 */

import { CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import { graphGapKindFor, type GraphGapKind } from './source-readiness.ts'
// The boot-graph wire validators are
// UPSTREAM's own — never a hand-rolled copy. manifest.ts is the browser-safe
// contract face of the pinned dsh-client-modules (zero runtime imports), the
// very module whose `parseBootManifest` consumes this same wire shape, and it
// is imported HERE by real-source relative path: the renderer has no
// install-tree copy of the dsh packages, and its plain-node tests
// (host-graph.test.ts, no module loader) must resolve the real module without a
// bundler. Keep the local parse LOOSER
// than upstream's — see the fetchHostGraph comment.
import { optionalStringArray, stripClientSuffix } from '../../../vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts'
// The deferred-covered roster: the covered ids whose module-table
// factory exists only AFTER the boot settled — the single authority host-graph
// shares with the composite entry (chamber-entry.ts asserts its own roster
// against it at apply time).
import { DEFERRED_EXTRA_ROW_IDS } from './required-extra-rows.ts'
import type { PluginGraphDiagnostic, PluginGraphDiagnosticState } from '@dsh-chamber/dsh-chamber-client-core'
import { postUnary, type UnaryPostOutcome } from '@dsh-chamber/dsh-chamber-client-core/wire-common'
// The HTTP-status/envelope classification SINGLE SOURCE: also consumed by
// client-core's plugin-graph-recheck.ts, so boot and self-heal verdicts are
// word-for-word the same for the same wire answer (audit arch-03 P2-2).
import {
  classifyPluginGraphOutcome, graphEntryImmediatelyMessage, graphEntryLabel, wrapGraphTransportFailure,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-graph-classify'
// Page-level client-plugin load kernel:
// the boot path and the settings bridge share ONE implementation of combo/id
// bookkeeping, timeout tombstones and rev-conflict facts. Imported through the
// client-core face: the renderer's plain-node tests resolve it via the
// workspace node_modules link, the same way the build does.
import {
  clientPluginRowOwner,
  dedupeCoveredRows,
  loadClientPluginRows,
  type ClientRowOutcome,
} from '@dsh-chamber/dsh-chamber-client-core/client-plugin-loader'

/** Re-exported for existing consumers (the type lives in the chamber shared face). */
export type { PluginGraphDiagnostic, PluginGraphDiagnosticState }

/** One composed client entry row of the host boot graph (mirror of WebBootEntry).
 *  The wire's WebBootEntry carries `external?: string[]` and its
 *  bundle urls use the combo endpoint form (`/plugins/??<id>/client.js&rev=…`).
 *  The url form is the single-id combo (each row's own script); the graph's
 *  multi-id combo BATCHES are ignored by the chamber merge (host-graph fetch
 *  reads `entries` only, see the fetch comment). */
export interface HostGraphRow {
  id: string
  /** Bundle endpoint, '/plugins/??<id>/client.js&rev=<rev>' (host-root-relative). */
  url: string
  /** Opaque bundle revision (`<per-process nonce>-<ordinal>` upstream; a
   *  cache-busting consistency anchor, NOT a content hash — every instance
   *  restart reallocates every rev, invalidating all previous bundle URLs). */
  rev: string
  /** Package-name dependency edges, informational. */
  inject?: string[]
  /** Exact non-inject module requests of this row (WebBootEntry.external):
   *  the specifiers the bundle requires from the module table
   *  beyond its `inject` edges. The parse preserves the field: dropping it
   *  would erase the ONE unsatisfiable
   *  edge a third-party row can carry here: a request onto a covered id whose
   *  family the composite registers only AFTER the boot settled
   *  (`required-extra-rows.ts` DEFERRED_EXTRA_ROW_IDS → the named diagnostic in
   *  collectExtraRows / findDeferredExternalDependencies). */
  external?: string[]
  /** Stage-one prefetch mark (the chamber merge preloads everything it keeps). */
  immediately?: boolean
}

/** One extra module row handed to the boot kernel (mirror of the vendor
 *  BootModuleRow): `initialUrl` is the initial-load combo endpoint
 *  (the chamber preloads each entry's own combo, so it equals `url`), `inject`
 *  stays empty (the composite covers the whole official shell, so an extra has
 *  no inject edge to arrive first) and `external` carries the row's non-inject
 *  module requests exactly as the wire composed them ([] when the wire omitted
 *  them). The chamber kernel adopts these rows by ID (boot.ts: it preloads the
 *  bundles itself and has no graph row for them), so `external` is not an
 *  arrival schedule here — it is the record of which specifiers the row's
 *  factory will `require` from the shared module table at materialization,
 *  which is exactly what {@link findDeferredExternalDependencies} judges. */
export interface ExtraModuleRow {
  id: string
  url: string
  initialUrl: string
  rev: string
  inject: string[]
  external: string[]
}

// The client-request / server-response envelope shape is AUTHORITATIVE in
// the control-plane Node package (packages/control-plane/src/rpc-envelope.ts,
// cross-package protocol single-sourcing) — this renderer (browser-side)
// cannot import a Node package (the desktop main-process probes consume the
// shared module directly through packages/desktop/control-plane-module.ts),
// so the client-request half is built by the shared browser kernel
// (wire-common.ts postUnary) and the server-response classification
// below stays local; any change to the shared contract must land in
// rpc-envelope.ts first and be mirrored there.

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
 *
 * How this parse relates to upstream's:
 * the optional-field validation rides upstream's own helpers (`optionalStringArray`,
 * `stripClientSuffix`; manifest.ts, imported above) and the envelope/base-row
 * classification rides the shared single source (plugin-graph-classify.ts); the
 * PARSE ITSELF stays deliberately LOOSER than upstream's `parseBootManifest`
 * (manifest.ts:167-256): upstream parses the whole `window.__DSH_BOOT__`
 * manifest into its two consumer views and therefore also requires `batches` to
 * be an array (:186-188) and EVERY entry to belong to exactly one initial-load
 * batch (:238-253). The chamber reads `entries` only — the graph's multi-id
 * combo `batches` are ignored (each row carries its own single-id combo url;
 * see toExtraRows) — so a graph without batches, or with an entry the host did
 * not schedule into one, is still a usable chamber graph and must not fail the
 * boot's plugin set. Everything the local parse DOES check is upstream's check.
 */
export async function fetchHostGraph(basePath: string): Promise<HostGraphRow[] | null> {
  // Shared transport byte: URL join + client-request envelope + POST +
  // body collection with the bounded-unary 30s budget, postUnary in
  // wire-common.ts; the bare crypto.randomUUID() rpcId is kept
  // explicit so its evaluation stays inside this try (a no-randomUUID
  // environment folds the throw into the local wire error below). Transport
  // rejections propagate raw.
  let outcome: UnaryPostOutcome
  try {
    outcome = await postUnary(basePath, 'clientGraph/graph', {}, {
      rpcId: crypto.randomUUID(),
    })
  } catch (error) {
    // Proxy honesty (design 03 §3.3): fold the transport rejection with the
    // shared single-source prefix.
    throw new Error(wrapGraphTransportFailure(error))
  }
  // The HTTP-status + envelope classification is the SHARED single source
  // (plugin-graph-classify.ts, also consumed by client-core's recheck): only
  // this boot-policy mapping stays local. A 503 instance_unavailable is the
  // expected pre-ready state → null; a classified channel failure carries its
  // diagnostic state; a malformed answer is a plain Error; `ok` hands over the
  // rows that passed the shared base gate.
  const verdict = classifyPluginGraphOutcome(outcome)
  if (verdict.kind === 'instance-unavailable') return null
  if (verdict.kind === 'channel') throw new HostGraphChannelError(verdict.state, verdict.message)
  if (verdict.kind === 'malformed') throw new Error(verdict.message)
  const rows: HostGraphRow[] = []
  for (const row of verdict.entries) {
    const where = graphEntryLabel(row)
    // The optional fields are validated by
    // UPSTREAM's helper (manifest.ts `optionalStringArray`, which upstream's own
    // `parseBootManifest` uses for this exact wire). Present-but-malformed
    // THROWS instead of being dropped silently: a wrong graph is a boot hazard,
    // not a candidate for guesswork (this module's contract), and a dropped
    // `external` would hide the one require edge the deferred-dependency
    // diagnostic exists to name.
    const subject = `boot graph entry ${where}`
    const inject = optionalStringArray(subject, 'inject', row.inject)
    const external = optionalStringArray(subject, 'external', row.external)
    if (row.immediately !== undefined && typeof row.immediately !== 'boolean') {
      throw new Error(graphEntryImmediatelyMessage(row))
    }
    rows.push({
      id: row.id,
      url: row.url,
      rev: row.rev,
      // Optional wire fields, carried through when well-formed (same rule for
      // all three; a malformed one throws above). `inject`/`immediately` are
      // informational for the merge; `external` is LOAD-BEARING:
      // it is the field the deferred-dependency diagnostic below reads.
      ...(inject === undefined ? {} : { inject: [...inject] }),
      ...(external === undefined ? {} : { external: [...external] }),
      ...(typeof row.immediately === 'boolean' ? { immediately: row.immediately } : {}),
    })
  }
  return rows
}

/**
 * Turn kept rows into module-table rows for the boot kernel, injecting the
 * per-instance proxy prefix into root-relative bundle urls
 * ('/plugins/??<id>/client.js&rev=…' → '<basePath>/plugins/??<id>/client.js&rev=…')
 * so the script element fetches same-origin through the instance proxy. The
 * combo syntax (`??<id>/client.js,<id2>/client.js&rev=…`) travels inside the
 * url unchanged — the first `?` begins the query string, which the host's
 * /plugins combo handler decodes; the instance proxy is a transparent
 * path+query passthrough.
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
      // The wire's own non-inject requests travel UNCHANGED: the
      // kernel row type requires the field, and this merge is what decides
      // which of those requests this page can never satisfy (see
      // findDeferredExternalDependencies + the diagnostic in collectExtraRows).
      external: [...(row.external ?? [])],
    })
  }
  return out
}

/**
 * The `external` requests of the kept rows that this page can NEVER satisfy:
 * a request naming a composite-COVERED id whose family
 * registers after the boot settled (`DEFERRED_EXTRA_ROW_IDS`).
 *
 * Why it is unsatisfiable rather than merely late: the covered row is filtered
 * out of the host graph (design 09 §3.3 — loading it would double-register the
 * plugin), and the composite registers module-table factories for its
 * FIRST-SCREEN families only (COVERED_FACTORIES, chamber-entry.ts). The kernel
 * resolves a bundle's synchronous `require` through seed → loadCache →
 * registered factories (vendor system.ts makeRequire) and throws when the table
 * has no factory — so the consumer row's materialization fails at create time
 * with only boot.ts's tolerant `console.error` (extra-row degrade) as a trace.
 * The chamber merge is the only layer that knows the covered/deferred sets
 * without a round trip, so it names the miss here instead.
 *
 * Requests are matched in their canonical (suffix-stripped) form, exactly as
 * the kernel does: a `@scope/pkg/client` request and a bare `@scope/pkg`
 * request are the same module-table key. The normalization is UPSTREAM's own
 * `stripClientSuffix` (manifest.ts:156-158). Requests onto kept peer
 * extras (preloaded by the same call)
 * or onto registered first-screen factories are NOT reported — this page does
 * satisfy them.
 * @param rows - the kept rows (the merge's output, dedupe + url rewrite done).
 * @returns one entry per affected row, in row order, dependencies deduped and
 *   in request order (empty array when nothing is affected).
 */
export function findDeferredExternalDependencies(
  rows: readonly ExtraModuleRow[],
): { rowId: string; dependencies: string[] }[] {
  const deferred = new Set(DEFERRED_EXTRA_ROW_IDS)
  const out: { rowId: string; dependencies: string[] }[] = []
  for (const row of rows) {
    const hits: string[] = []
    for (const request of row.external) {
      const id = stripClientSuffix(request)
      if (!deferred.has(id) || hits.includes(id)) continue
      hits.push(id)
    }
    if (hits.length > 0) out.push({ rowId: row.id, dependencies: hits })
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
 * Bundle urls are combo endpoints (`/plugins/??…&rev=…`).
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
 * The combo/id tables, the timeout tombstone and the per-row load
 * verdicts live in the client-core face (`client-plugin-loader.ts`) so the
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
   * Instance-serving gate for the 503 path:
   * `503 instance_unavailable` means "the instance is not serving YET", not
   * "the graph is broken" — but the boot window is short, and a cold local
   * start or a restart-straddled attach routinely outlives it, which otherwise
   * costs the boot its whole client-plugin set (and silently: see
   * {@link onGraphUnavailable}). The App supplies this gate from its own
   * per-source phase projection; it resolves true once the source is serving
   * again, false when the source left / the gate's own deadline passed.
   * Omitted (pure-node tests, mobile shape) → the fixed budget only.
   */
  waitForServing?(instanceId: string): Promise<boolean>
  /**
   * This boot settled WITHOUT the host graph — the 503 budget + serving wait
   * were both exhausted (the source is expected to serve later), or the channel
   * answered a hard failure. The shell records the fact and the App re-boots
   * the instance once the source turns ready. `kind` is the
   * decision of {@link graphGapKindFor}: `graph-unavailable` for every channel
   * failure, `local-graph-not-injected` for the LOCAL instance's 404 /
   * method-missing (a chamber-side installation/seed fact).
   * Never called for a NON-LOCAL instance that does not inject the graph at all
   * (gateway/mobile shapes): that is legitimate, not degraded.
   */
  onGraphUnavailable?(message: string, kind: GraphGapKind): void
  /**
   * Awaited once the graph rows are known, BEFORE the
   * first extra-bundle load pass. The chamber composite entry evaluates
   * inside this window and its covered-factory registration answers the
   * `@deepseek-ai/dsh-client-ui-primitives` require edges the seed does not
   * serve (dsh-client-web seed.ts/platform.ts deviation). The graph fetch
   * itself stays concurrent with the chamber evaluation — the gate is only at
   * the load step, so a slow/503-retrying instance probe overlaps the chamber
   * entry's main-thread eval. Optional: absent callers keep the current ordering.
   */
  awaitBeforeLoad?(): Promise<void>
  /**
   * Retry budget for the transient 503 `instance_unavailable` pre-ready
   * signal (design 09 module C race: the shell may boot while the instance is
   * still starting; the proxy answers 503 fast and the graph appears moments
   * later). Only the fast 503-null path retries — a hung fetch (30s timeout)
   * or other channel failure still fails fast, so the budget is bounded by the
   * delay sum (~4.5s), never by per-attempt timeouts. Budget exhaustion means
   * no extra plugins for this boot; that outcome is
   * not silent — a non-404 channel failure reports a named
   * `graph-unreachable` diagnostic and upfloats the App-facing degrade fact
   * (see `graphGapKindFor`), and the boot-gap banner explains it.
   * The 10-attempt default covers the observed
   * local spawn→ready window of ~3s (control-plane host logs), which a
   * 2.5s delay sum would not cover for a shell boot starting at spawn
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

/**
 * Fetch the instance's host boot graph, drop the rows the chamber page already
 * covers (design 09 §3.2/§3.3), and preload the remaining bundles BEFORE the
 * AppWebEntry is constructed: a bundle registers its factory through the shared
 * module table at script execution, and boot-time entry creation materializes
 * entries through the table's factories branch — so the factory must exist
 * before loader.create runs, not after.
 *
 * Degrades to [] when the graph CHANNEL fails (fetch throws — network /
 * non-2xx / malformed graph): the boot proceeds without extra plugins. That
 * channel failure ALSO reports the App-facing degrade fact
 * (`onGraphUnavailable`) unless the channel answered 404 — the legitimate
 * "no graph endpoint" shapes (NON-LOCAL gateway/mobile) must never be labeled a
 * degrade; the LOCAL instance's 404 is the exception (chamber-side
 * installation/seed fact with its own kind) — while a 502/504
 * mount would otherwise ship a plugin-less shell with no user-visible
 * explanation at all (see the branch comment). That is
 * NOT a complete shell: the composite's
 * own first-screen families inject services that a non-covered official row
 * provides (the derived probe roster — `required-extra-rows.ts`, the single
 * authority; the motivating member
 * is `sidebarRight`, injected by ui-chat and provided by ui-sidebar-right). On
 * a degrade such a fiber stays
 * PENDING, so the conversation view disappears while boot still reports
 * success; the `assertRequiredExtraRowServices` probe in chamber-entry.ts turns
 * that into a loud, named diagnostic (design 09 §3.2). A 503
 * `instance_unavailable` is the expected pre-ready state: the fetch is
 * retried on a bounded budget (the instance's graph appears moments after the
 * proxy stops answering 503 — see CollectExtraRowsDeps.retry) and only then gives
 * up on this boot's extra rows: not a silent degrade — the non-404 channel
 * failure routes to a named `graph-unreachable`
 * diagnostic plus the App-facing degrade fact (`graphGapKindFor`),
 * so a shell that boots inside the spawn window still gets its profile plugins
 * instead of losing them for the rest of the boot.
 *
 * A kept row whose `external` requests a deferred-covered id
 * is reported as a NAMED diagnostic instead of the silent `ok`: the merge
 * preserves the field (see ExtraModuleRow.external) and
 * {@link findDeferredExternalDependencies} names the affected rows and their
 * unsatisfiable dependencies, so the operator sees the one require edge this
 * page can never answer — otherwise it surfaces only as boot.ts's tolerated
 * `console.error` when the row's create-time require misses the module table.
 * Still not a boot gate: the boot settles, the other rows keep working, and the
 * verdict is projected onto the per-source plugin diagnostic.
 *
 * A bundle that fails to LOAD is NOT a degrade: it throws, the instance's
 * boot fails loud and shows the error — a broken extra plugin must never
 * silently disappear (design 09 §4 fail-loud). Ordinary load failures get ONE
 * bounded recovery cycle first: upstream
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
 * success; a late error allows a later retry).
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
          // Non-503 channel failures are NOT transient — fail fast
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
    // This must not degrade in TOTAL
    // silence. The boot keeps succeeding (a gateway/mobile shape may legitimately
    // run without the graph, so a hard gate would be wrong), but a source that
    // is merely slow (a) names itself in the log, (b) publishes the
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
    deps.onGraphUnavailable?.(message, 'graph-unavailable')
    return []
  }
  if (firstFetch.error !== null) {
    console.error(`[shell] instance ${instanceId} host boot-graph fetch failed; booting without extra plugins`, firstFetch.error)
    const detail = firstFetch.error instanceof Error ? firstFetch.error.message : String(firstFetch.error)
    const state = firstFetch.error instanceof HostGraphChannelError
      ? firstFetch.error.diagnosticState
      : 'graph-unreachable'
    reportDiagnostic(instanceId, state, { message: detail }, deps.reportDiagnostic)
    // **通道失败（502/504/网络错误）也算一次可解释
    // 的降级**，不能只留一条诊断。把它当作 "documented silent skip" 的
    // 理由（gateway/mobile 形态合法地没有图端点）只适用于 404（`not-injected`）
    // 这一种，不是通道失败：隧道活着而远端 dsh 没起来时，本轮挂载会缺掉整套
    // profile 客户端插件（典型是 ui-chat 的 sidebarRight 永久 pending）。
    // 只把事实写进连接页的 pluginDiagnostic 一行（侧栏不渲染该诊断）时，
    // 用户停在 boot 表面看不到解释、也拿不到自愈。
    // 上浮成 ShellState.degraded 后，App 的非阻断 boot-gap 横幅才说得
    // 出口，且 graph-unavailable 的 retryable 裁决给出每个 ready 世代一次的冷重挂。
    // 边界：**非本地**来源的 `not-injected`（404 或通道答 method 缺失）
    // 仍然是"没注入图"的合法形态，绝不上浮；本地实例的同一形态相反——chamber 托管
    // 宿主总会注入客户端图（seed 行），404/method 缺失只可能是 chamber 自己的
    // 安装/seed 破损，因此走 local-graph-not-injected 并进入同一自愈面
    // （见 host-graph.test.ts 的两个 not-injected 用例）。
    const gapKind = graphGapKindFor(state, instanceId)
    if (gapKind !== null) {
      deps.onGraphUnavailable?.(
        `instance did not answer its client plugin graph request (${detail}); `
        + 'this boot carries no profile client plugins',
        gapKind,
      )
    }
    return []
  }
  // fetchWithRetry 的失败出口（starting / error）已在上方 return；此处 rows 必非 null。
  // 判别式在类型层无法关联，故显式断言——运行时不变式由三条出口穷尽。
  const firstRows = firstFetch.rows as HostGraphRow[]
  const rows = toExtraRows(dedupeCoveredRows(firstRows, CHAMBER_COVERED_IDS), basePath)
  // The chamber entry must have evaluated before any extra bundle executes
  // (its covered factory answers the ui-primitives platform-word require edges
  // the seed does not serve — see the deps comment). The gate promise was
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
   *  the kernel (fail loud). */
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
  // The gate (`deps.awaitBeforeLoad`) is NOT re-awaited here: it settled
  // before the first load pass above, and the recovery reloads only re-execute
  // bundle scripts (registering factories); the synchronous require edges they
  // carry run later, during run()'s loader.create materialization — by then
  // the chamber entry has evaluated (or its failure is loud via the known
  // create-side race, chamber-entry.ts header). Do not add a second gate here.
  // Bounded recovery cycle (module docstring):
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
        toExtraRows(dedupeCoveredRows(secondFetch.rows, CHAMBER_COVERED_IDS), basePath)
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
    // in the returned extra rows (the pass-1 urls carry the stale process
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
  // Deferred-dependency verdict of the rows this boot ACTUALLY hands to the
  // kernel (post-recovery, so a restarted instance's fresh rows are judged too).
  // Computed once, here, because the projection below reports one diagnostic per
  // boot.
  const deferredExternalMisses = findDeferredExternalDependencies(rows)
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
  } else if (deferredExternalMisses.length > 0) {
    // A kept row requests a covered id whose family the
    // composite registers only after the boot settled, so the synchronous
    // require during create can never be answered (see
    // findDeferredExternalDependencies). This is a BOOT fact — only a different
    // plugin set (or an upstream change to the deferred split) can change it —
    // so it must not be reported as `ok`, and it is projected through the
    // nearest existing state of the shared diagnostic union
    // (`bundle-load-failed`: "this row cannot materialize"), whose class the
    // settings-surface recheck never heals away (plugin-graph-recheck.ts heals
    // channel facts only). The message names the rows and the dependencies.
    const message = `额外行的模块依赖本 boot 无法满足：`
      + deferredExternalMisses.map(miss => `${miss.rowId} → ${miss.dependencies.join(', ')}`).join('; ')
      + ` — 该依赖已被复合入口覆盖但属延迟簇（boot 之后才注册，见 required-extra-rows.ts DEFERRED_EXTRA_ROW_IDS）；`
      + '相关功能在本 boot 缺失（extra 行的 create 期 require 落空）'
    console.error(`[shell] instance ${instanceId} ${message}`)
    reportDiagnostic(instanceId, 'bundle-load-failed', {
      pluginId: deferredExternalMisses[0]!.rowId,
      message,
    }, deps.reportDiagnostic)
  } else {
    reportDiagnostic(instanceId, 'ok', {}, deps.reportDiagnostic)
  }
  return rows
}
