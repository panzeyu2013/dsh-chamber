/**
 * Per-instance host boot-graph merge: the composite bundle registers the whole
 * official dsh client shell, so a boot needs no host graph EXCEPT the client
 * plugins (`dsh.client` packages) in the instance profile — their rows are
 * missing and their bundles load at runtime. The host composes the same graph it
 * would inject as `window.__DSH_BOOT__`; the chamber frontend fetches it via the
 * reverse proxy, drops the covered rows, and preloads the rest BEFORE the
 * AppWebEntry is constructed, so each factory is registered by loader.create.
 * Trust boundary (declared): remote client bundles execute in the local renderer
 * (the official model); a plugin missing its built `./client` bundle fails loud,
 * never silently dropped. Wire shapes: upstream manifest.ts helpers plus the
 * authoritative control-plane rpc-envelope.ts via the shared browser kernel.
 */

import { CHAMBER_COVERED_FACTORY_IDS, CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import { graphGapKindFor, type GraphGapKind } from './source-readiness.ts'
// Boot-graph wire validators are UPSTREAM's own — never hand-rolled — imported
// by real-source relative path because the renderer has no install-tree copy
// and plain-node tests must resolve the real module without a bundler.
// Keep the local parse LOOSER than upstream's — see the fetchHostGraph comment.
import { optionalStringArray, stripClientSuffix } from '../../../vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts'

import type { PluginGraphDiagnostic, PluginGraphDiagnosticState } from '@dsh-chamber/dsh-chamber-client-core'
import { hadSchedulingGap, recordEvidence } from '@dsh-chamber/dsh-chamber-client-core'
import { classifyObservation, isAdmissible } from '@dsh-chamber/dsh-stream-state'
import { postUnary, type UnaryPostOutcome } from '@dsh-chamber/dsh-chamber-client-core/wire-common'
// Envelope classification SINGLE SOURCE, also consumed by client-core's
// plugin-graph-recheck.ts: boot and self-heal verdicts for the same wire answer
// can never drift.
import {
  classifyPluginGraphOutcome, graphEntryImmediatelyMessage, graphEntryLabel, wrapGraphTransportFailure,
  type PluginGraphBaseEntry,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-graph-classify'
// Page-level client-plugin load kernel: the boot path and the settings bridge
// share ONE implementation of combo/id bookkeeping, timeout tombstones and
// rev-conflict facts; resolved through the client-core face.
import {
  clientPluginRowOwner,
  dedupeCoveredRows,
  loadClientPluginRows,
  type ClientRowOutcome,
} from '@dsh-chamber/dsh-chamber-client-core/client-plugin-loader'

/** One composed client entry row (mirror of upstream WebBootEntry): bundle urls
 *  use the single-id combo form; the graph's multi-id combo BATCHES are ignored
 *  (the fetch reads `entries` only). */
export interface HostGraphRow {
  id: string
  /** Bundle endpoint in the pin's single-id combo form, document-relative
   *  ('plugins/??<id>/client.js&rev=<rev>'; 0.1.6 and earlier were host-root-relative).
   *  Both shapes are accepted — see normalizeBundleUrl below. */
  url: string
  /** Opaque cache-busting build revision, NOT a content hash: the pinned host
   *  derives it from the bundle file's filesystem metadata (mtimeMs/ctimeMs/size —
   *  dsh-client-modules `artifactRevision`), so replacing/rebuilding that file
   *  invalidates its URL while a plain restart does not (an untouched bundle keeps
   *  its rev, so bundle urls stay valid). Two INDEPENDENT installs of the same
   *  bytes usually differ (ctime), while two hard links to one file share it. */
  rev: string
  /** Package-name dependency edges, informational. */
  inject?: string[]
  /** Exact non-inject module requests of this row (WebBootEntry.external):
   *  specifiers the bundle requires beyond its `inject` edges. Load-bearing: a
   *  request onto a covered id that no registration answers (no first-screen
   *  factory, not kernel-adopted) is an unsatisfiable edge this merge must name,
   *  not drop. */
  external?: string[]
  /** Stage-one prefetch mark (the chamber merge preloads everything it keeps). */
  immediately?: boolean
}

/** One extra module row handed to the boot kernel (mirror of the vendor
 *  BootModuleRow): `initialUrl` equals `url` (the merge preloads each entry's
 *  own combo), `inject` stays empty (the composite covers the shell), and
 *  `external` records the specifiers the factory will `require` from the module
 *  table at materialization — what {@link findUnsatisfiableExternalDependencies}
 *  judges. */
export interface ExtraModuleRow {
  id: string
  url: string
  initialUrl: string
  rev: string
  inject: string[]
  external: string[]
}

// Envelope shape is AUTHORITATIVE in packages/control-plane/src/rpc-envelope.ts:
// the browser builds the client-request half via the shared kernel and
// classifies responses locally; any contract change lands there first, then
// mirrors here.

class HostGraphChannelError extends Error {
  readonly diagnosticState: Extract<PluginGraphDiagnosticState, 'not-injected' | 'graph-unreachable'>

  constructor(diagnosticState: Extract<PluginGraphDiagnosticState, 'not-injected' | 'graph-unreachable'>, message: string) {
    super(message)
    this.name = 'HostGraphChannelError'
    this.diagnosticState = diagnosticState
  }
}

/**
 * Fetch the instance's host boot graph over the reverse proxy. Resolves the
 * composed `entries` rows, or null when the instance is not ready yet (proxy
 * 503 `instance_unavailable`; callers treat it as 'no extra plugins').
 * Everything else fails LOUD: transport errors, non-2xx and malformed
 * envelopes/rows all throw — a wrong graph is a boot hazard, not a candidate
 * for guesswork. The parse is deliberately LOOSER than upstream's
 * `parseBootManifest` (which also requires `batches` and one initial-load batch
 * per entry): the chamber reads `entries` only and ignores the graph batches;
 * everything it DOES check is upstream's own check.
 */

export async function fetchHostGraph(basePath: string): Promise<HostGraphRow[] | null> {
  // Shared transport: postUnary (bounded unary, 30s). The bare
  // crypto.randomUUID() rpcId stays explicit so its evaluation is inside this
  // try (a no-randomUUID environment folds the throw into the local wire error).
  let outcome: UnaryPostOutcome
  try {
    outcome = await postUnary(basePath, 'clientGraph/graph', {}, {
      rpcId: crypto.randomUUID(),
    })
  } catch (error) {
    throw new Error(wrapGraphTransportFailure(error))
  }
  // Shared HTTP/envelope classification; only this boot-policy mapping stays
  // local: 503 → null, channel failure → typed error, malformed → Error, ok → rows.
  const verdict = classifyPluginGraphOutcome(outcome)
  if (verdict.kind === 'instance-unavailable') return null
  if (verdict.kind === 'channel') throw new HostGraphChannelError(verdict.state, verdict.message)
  if (verdict.kind === 'malformed') throw new Error(verdict.message)
  return parseGraphRows(verdict.entries)
}

/**
 * 归一一个宿主图行的 bundle url：0.1.7 起上游 client-modules 的 combo url 是
 * **document-relative**（`comboReference = comboUrl().slice(1)`），0.1.6 及以前是
 * root-relative。两种形态都接，统一接在实例前缀之后，combo 语法原样随行（实例
 * 代理是透明的 path+query 直通）。
 *
 * 一律拒绝（毒化图绝不能把 module-script 引到外部 origin，也不能越出实例前缀）：
 *  - 协议相对 `//host/...` 与任何带 scheme 的绝对 url（`http:` / `data:` / `file:` …）；
 *  - 路径里任何一段是 `..` 的穿越，以及反斜杠与 NUL（Windows 风格绕过）。
 * @param url - 图行给出的 url（root-relative 或 document-relative）。
 * @param basePath - 实例代理前缀（如 `/api/i/<id>`）。
 * @returns 归一后的 url；null = 拒绝。
 */
export function normalizeBundleUrl(url: string, basePath: string): string | null {
  if (url.length === 0) return null
  if (url.startsWith('//')) return null
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(url)) return null
  if (url.includes('\\') || url.includes('\u0000')) return null
  const pathOnly = url.split('?', 1)[0].split('#', 1)[0]
  if (pathOnly.split('/').includes('..')) return null
  return basePath + (url.startsWith('/') ? url : '/' + url)
}

/**
 * Turn kept rows into module-table rows, injecting the per-instance proxy
 * prefix into the row's bundle url so the script element fetches same-origin
 * through the instance proxy. Absolute and traversal-shaped urls are dropped:
 * a poisoned host graph must never steer the loader to an external origin.
 */
export function toExtraRows(rows: readonly HostGraphRow[], basePath: string): ExtraModuleRow[] {
  const out: ExtraModuleRow[] = []
  for (const row of rows) {
    const url = normalizeBundleUrl(row.url, basePath)
    if (url === null) {
      console.warn(`[host-graph] dropping unsafe bundle url for ${row.id}`)
      continue
    }
    out.push({
      id: row.id,
      url,
      // initialUrl == url: the merge preloads each entry’s own combo, so
      // arrive() finds the factory already registered and does not re-fetch.
      initialUrl: url,
      rev: row.rev,
      // The composite covers the shell; kept extras have no inject edges to arrive first.
      inject: [],
      // The wire's non-inject requests travel UNCHANGED; this merge decides
      // which are unsatisfiable (findUnsatisfiableExternalDependencies).
      external: [...(row.external ?? [])],
    })
  }
  return out
}

/** One kept row's unsatisfiable create-time requires (see the predicate below). */
interface UnsatisfiableExternalRequests {
  rowId: string
  /** Every unsatisfiable id of this row: stripped form, first-seen order, deduped. */
  dependencies: string[]
}

/**
 * The covered ids the module table answers BESIDES the composite's own factories:
 * the two ids the boot kernel adopts for the shell itself BEFORE any extra row
 * runs (`packages/dsh-client-web/src/boot-rows.ts` `MODULES_ID`/`UI_RENDERER_ID`,
 * registered in `boot.ts` `ensureWebModuleSystem`). Both are page-own covered rows
 * with no composite factory, so without this set the predicate would call a
 * resolvable require unsatisfiable. A lockstep test pins both ends of this list.
 */
const KERNEL_ADOPTED_IDS: readonly string[] = [
  '@deepseek-ai/dsh-client-modules',
  '@deepseek-ai/dsh-client-ui-renderer',
]

/**
 * The `external` requests of the kept rows this page can NEVER satisfy: a request
 * naming a composite-COVERED id that no registration ever answers. Covered rows are
 * filtered out of the host graph, and the page's module table answers only:
 *  - the composite's FIRST-SCREEN factories (`COVERED_FACTORIES`), and
 *  - the kernel-adopted ids above.
 * Everything else covered is permanently unresolvable: the deliberate skips
 * (hmr / mobile / directory-picker-native / the desktop account family) are never
 * loaded; the deferred families are mounted with `ctx.plugin` but never register a
 * module-table factory; page-own and replaced official rows register nothing either.
 * This is NOT a timing claim — there is no later moment at which those ids resolve,
 * which is why every qualifying id is reported the same way. Only this merge knows
 * the covered/factory/kernel sets without a round trip, so it names the miss here.
 * Requests are matched suffix-stripped exactly as the kernel does; first-screen
 * factories and kernel-adopted ids are satisfied, not reported, while kept peers and
 * every other non-covered id are OUTSIDE the domain (the seed table must stay
 * disjoint from the covered non-factory ids — pinned by an invariant test). Three boundaries: only the `external` WIRE form is judged (a
 * bundle's bare `inject`-style require was already dropped by toExtraRows and stays
 * the kernel fix's failure face), and the verdict assumes the composite entry
 * EVALUATED — a failed prefetch is the composite path's report, not re-derived here.
 * Requests onto ids OUTSIDE the covered set are not judged either: a non-covered id
 * that never loads is the kernel `require`'s failure face.
 */
export function findUnsatisfiableExternalDependencies(
  rows: readonly ExtraModuleRow[],
): UnsatisfiableExternalRequests[] {
  const covered = new Set(CHAMBER_COVERED_IDS)
  const satisfied = new Set<string>([...CHAMBER_COVERED_FACTORY_IDS, ...KERNEL_ADOPTED_IDS])
  const out: UnsatisfiableExternalRequests[] = []
  for (const row of rows) {
    const dependencies: string[] = []
    for (const request of row.external) {
      const id = stripClientSuffix(request)
      if (!covered.has(id) || satisfied.has(id) || dependencies.includes(id)) continue
      dependencies.push(id)
    }
    if (dependencies.length > 0) out.push({ rowId: row.id, dependencies })
  }
  return out
}

/**
 * Preload registry keyed by BUNDLE URL (page-level, shared across instances):
 * the shared module table refuses a duplicate factory registration, and a combo
 * script registers EVERY id its query names, so one script URL must never
 * execute twice. First-load-wins: the first combo to execute a factory owns
 * that id forever; a later instance carrying it at a newer rev reuses the
 * factory and reports restart-required (same instance, rebuilt plugin) or
 * instance-version-conflict (cross-instance runtime drift) from the tables in
 * the client-core face, which the settings bridge shares.
 */
function reportDiagnostic(
  instanceId: string,
  state: PluginGraphDiagnosticState,
  extra: { message?: string; pluginId?: string } = {},
  listener?: CollectExtraRowsDeps['reportDiagnostic'],
): void {
  listener?.(instanceId, { state, ...extra, updatedAt: Date.now() })
}

/** The cross-instance bundle-rev drift fact text (shared by the boot projection and live sync):
 *  states only the FILE-METADATA fact (design 09 §3.5) — never "the versions differ". */
export function versionConflictMessage(id: string, ownerSourceId: string): string {
  return `实例间 ${id} 的 bundle rev 不同（rev 由 bundle 文件的 mtime/ctime/size 派生，不是内容哈希；独立安装/拷贝通常不同，仅当两侧指向同一底层文件时才相同）：页面已沿用实例 ${ownerSourceId} 先加载的版本`
}

/** The same-source rebuilt-bundle fact text (shared by the boot projection and live sync). */
export function restartRequiredMessage(id: string): string {
  return `页面已加载 ${id} 的另一版本，重启应用后才能切换`
}

/**
 * THE single row projection of one composed graph: the boot fetch (unary
 * `clientGraph/graph`) and the live SSE subscriber both validate through here,
 * so a wire shape can never be read two ways. Deliberately LOOSER than upstream's
 * `parseBootManifest` (which also requires `batches` and one initial-load batch
 * per entry): the chamber reads `entries` only and ignores the graph batches;
 * everything it DOES check is upstream's own check.
 * @param entries - wire rows that passed the shared base gate (string id/url/rev).
 * @returns validated rows in wire order.
 * @throws Error when a present optional field is malformed — a wrong graph is a
 *   boot hazard, never guesswork; live callers catch and drop the frame instead.
 */
export function parseGraphRows(entries: readonly PluginGraphBaseEntry[]): HostGraphRow[] {
  const rows: HostGraphRow[] = []
  for (const row of entries) {
    const where = graphEntryLabel(row)
    // Optional fields via upstream's helper; present-but-malformed THROWS (a
    // wrong graph is a boot hazard, not a candidate for guesswork) — a dropped
    // `external` would hide the one require edge the deferred diagnostic names.
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
      // Optional wire fields, carried through when well-formed (malformed throws
      // above); `external` is LOAD-BEARING for the deferred-dependency diagnostic.
      ...(inject === undefined ? {} : { inject: [...inject] }),
      ...(external === undefined ? {} : { external: [...external] }),
      ...(typeof row.immediately === 'boolean' ? { immediately: row.immediately } : {}),
    })
  }
  return rows
}

/** The shell-owned bundle loader, injected so pure-node tests can stub it (shell.ts owns the DOM). */
export interface CollectExtraRowsDeps {
  loadModuleBundle(url: string): Promise<void>
  reportDiagnostic?(sourceId: string, diagnostic: PluginGraphDiagnostic): void
  /**
   * Instance-serving gate for the 503 path: `instance_unavailable` means "not
   * serving YET", and a cold start or restart-straddled attach can outlive the
   * boot window. Resolves true once the source serves again, false when it left
   * or the gate deadline passed; omitted → the fixed retry budget only.
   */
  waitForServing?(instanceId: string): Promise<boolean>
  /**
   * This boot settled WITHOUT the host graph — budget and serving wait both
   * exhausted (the source is expected to serve later), or the channel answered
   * a hard failure. `kind` comes from {@link graphGapKindFor}. Never called for
   * a NON-LOCAL instance that does not inject the graph at all (gateway/mobile
   * shapes): that is legitimate, not degraded.
   */
  onGraphUnavailable?(message: string, kind: GraphGapKind): void
  /**
   * The channel ANSWERED a valid graph for this boot (the fetch resolved rows —
   * an all-covered/empty row set counts). Fired once, after the first non-null
   * fetch; the recovery fetch never re-fires it. This is the live-sync arm
   * condition: the subscriber only exists for a source whose host graph answers,
   * and `not-injected`/unreachable boots never arm (they wait for the App's
   * readiness self-heal to re-boot the shell instead).
   */
  onGraphAnswered?(): void
  /**
   * Awaited once the rows are known, BEFORE the first extra-bundle load pass:
   * the composite entry must have evaluated so its covered factories answer the
   * ui-primitives require edges the seed does not serve. The graph fetch itself
   * stays concurrent; absent callers keep the current ordering.
   */
  awaitBeforeLoad?(): Promise<void>
  /**
   * Retry budget for the transient 503 `instance_unavailable` pre-ready signal
   * (the shell may boot while the instance is starting). Only the fast 503-null
   * path retries — a hung fetch (30s timeout) or other channel failure fails
   * fast, so the budget is bounded by the delay sum, never by per-attempt
   * timeouts. Exhaustion is not silent: a non-404 channel failure reports a
   * named `graph-unreachable` diagnostic and upfloats the App-facing degrade
   * fact. The 10-attempt default spans the observed local spawn→ready window
   * of ~3s, which a 2.5s delay sum would not cover.
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
 * Cancellation evidence: the observation never completed, so it CANNOT be read as a
 * source fact (`dsh-stream-state` 的 I5「缺席不作证据」推广到**活性证据**，design 14 §D4).
 * WebKit reports an aborted fetch as `TypeError: Fetch is aborted` and a signal-fired
 * abort as an `AbortError` DOMException, so both the name and the message count.
 * `TimeoutError` is deliberately NOT a cancellation: a fetch that outlived its own 30s
 * deadline is an admissible channel observation, and hiding it would hide a hung source.
 */
export function isCancellationEvidence(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const { name, message } = error as { name?: unknown; message?: unknown }
  if (name === 'TimeoutError') return false
  if (name === 'AbortError') return true
  return typeof message === 'string' && /abort/i.test(message)
}

/**
 * Serving waits per boot. ONE is the honest bound: the wait already spans the
 * App's readiness gate (60s), and a source that serves but still has no
 * answerable graph is a channel problem, not a serving problem. A source that
 * restarts during the wait ends degraded; the App's self-heal re-boots it on
 * the next ready transition and owns repeated attempts.
 */
const MAX_SERVING_WAITS = 1

/**
 * Backstop ceiling for one boot's serving wait (the App's readiness gate is capped at 60s).
 */
const SERVING_HEAL_BUDGET_MS = 70_000

/**
 * Fetch the host boot graph, drop the covered rows, and preload the rest BEFORE
 * the AppWebEntry is constructed: a bundle registers its factory through the
 * shared module table at script execution, and entry creation consumes that
 * factory — so it must exist before loader.create runs.
 * A channel failure degrades to [] but is not silent: unless the channel
 * answered 404 (legitimate for non-local gateway/mobile; the LOCAL instance's
 * 404 is a chamber-side installation/seed fact with its own kind), it reports
 * the App-facing degrade fact — a composite first-screen family injecting a
 * service a covered-away official row provides stays PENDING while boot still
 * reports success (derived probe roster, `required-extra-rows.ts`). A 503 is
 * the expected pre-ready state: bounded retries + one serving wait, then a
 * named `graph-unreachable` diagnostic. A kept row whose `external` requests a
 * covered id with no module-table factory is a NAMED diagnostic, not `ok`. A
 * bundle that fails to LOAD fails the boot loud after ONE bounded recovery pass:
 * a bundle rewritten between the graph fetch and its load (dev rebuild,
 * reinstall) takes a new metadata rev while the fetched url still names the old
 * one, and a transient 404 lands here too; the pass re-fetches and retries at
 * fresh URLs, and only still-failing rows fail the boot. A DOM-script TIMEOUT is not recovery:
 * its tombstone observes the original element.
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
  /** Fetch the host graph on the bounded 503-retry budget, then (with a serving
   *  gate) wait for the source to serve and retry on a fresh budget. Resolves
   *  rows, a channel error (non-503 fails fast), or `starting: true` on timeout. */
  const fetchWithRetry = async (): Promise<{ rows: HostGraphRow[] | null; error: unknown; starting: boolean; cancelled: boolean }> => {
    let lastError: unknown = null
    /** True when at least one attempt ended in a cancelled (non-admissible) observation. */
    let cancelled = false
    let servingWaits = 0
    const healDeadline = deps.waitForServing === undefined ? 0 : Date.now() + SERVING_HEAL_BUDGET_MS
    for (;;) {
      for (let attempt = 1; attempt <= retry.attempts; attempt++) {
        const attemptStartedAt = Date.now()
        try {
          const entries = await fetchHostGraph(basePath)
          if (entries !== null) return { rows: entries, error: null, starting: false, cancelled: false }
        } catch (error) {
          // The evidence classifier owns "is this a source fact?": a WebKit cancellation
          // (superseded) or a deadline that expired while the page was not scheduled
          // (unscheduled) is NOT one (design 14 §D4) — book nothing, retry in budget.
          const verdict = classifyObservation({
            outcome: 'error',
            errorName: error instanceof Error ? error.name : undefined,
            errorMessage: error instanceof Error ? error.message : String(error),
            schedulingGap: hadSchedulingGap(attemptStartedAt, Date.now()),
          })
          const detail = {
            instance: instanceId,
            attempt,
            windowMs: Date.now() - attemptStartedAt,
            reason: error instanceof Error ? error.message : String(error),
          }
          if (!isAdmissible(verdict) || isCancellationEvidence(error)) {
            // 取消不是来源事实（挂载被取代 / 我们自己的拆除 / 页面被节流）：不落任何判定，
            // 在同一有界预算内重试。旧形态把它读成通道失败，把 graph-unreachable 钉在来源上
            // 交给一次性自愈，留下一个只能手动重载的空壳（实机 P5）。
            recordEvidence('host-graph', verdict, detail, false)
            cancelled = true
          } else {
            // Non-503 channel failures are NOT transient: fail fast (a hung fetch
            // already consumed its 30s timeout; retrying would only stack them).
            recordEvidence('host-graph', verdict, detail, true)
            lastError = error
            return { rows: null, error: lastError, starting: false, cancelled: false }
          }
        }
        if (attempt < retry.attempts) await retry.sleep(retry.delayMs)
      }
      // Budget gone and the channel never answered non-503 → the source is still
      // starting: wait for it (App-bounded) and retry on a fresh budget.
      if (deps.waitForServing === undefined
        || servingWaits >= MAX_SERVING_WAITS
        || Date.now() >= healDeadline) {
        return { rows: null, error: lastError, starting: true, cancelled }
      }
      servingWaits += 1
      const serving = await deps.waitForServing(instanceId)
      if (!serving) return { rows: null, error: lastError, starting: true, cancelled }
    }
  }
  const firstFetch = await fetchWithRetry()
  if (firstFetch.cancelled && firstFetch.rows === null) {
    // 预算在"只有取消"的情况下走完：来源从未得到说话的机会，因此关于它不能有任何结论。
    // 无图启动是合法形态（gateway/mobile 本来就没有图），既有 graph-return 探测会在图真的
    // 可答时重挂；**绝不上浮 onGraphUnavailable**——那正是让缺口粘住的路径（实机 P5）。
    const message = `instance ${instanceId} client plugin graph observation was cancelled before it completed `
      + '(superseded mount / aborted request); no gap recorded'
    console.error(`[shell] instance ${instanceId} boot-graph cancelled: ${message}`)
    reportDiagnostic(instanceId, 'graph-unreachable', { message }, deps.reportDiagnostic)
    return []
  }
  if (firstFetch.rows === null && firstFetch.error === null && firstFetch.starting) {
    // Must not degrade in TOTAL silence: the boot keeps succeeding (gateway/
    // mobile may legitimately run without the graph), but a merely slow source
    // names itself in the log, publishes the `graph-unreachable` diagnostic,
    // and tells the shell to re-boot the instance once the source turns ready.
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
    // 通道失败（502/504/网络错误）也是可解释的降级，不能只留诊断：非本地来源
    // 的 404（not-injected）合法，但通道失败会缺掉整套 profile 客户端插件
    // （典型是 ui-chat 的 sidebarRight 永久 pending）；上浮成 ShellState.degraded
    // 后 App 横幅才说得出口并获得 ready 世代冷重挂；本地实例的 404/method 缺失
    // 只可能是 chamber 安装/seed 破损，走 local-graph-not-injected。
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
  // 上方三条失败出口已 return，此处 rows 必非 null；判别式无法跨类型层关联，显式断言。
  const firstRows = firstFetch.rows as HostGraphRow[]
  // The channel answered: the live subscriber may arm for this source (once per boot).
  deps.onGraphAnswered?.()
  const rows = toExtraRows(dedupeCoveredRows(firstRows, CHAMBER_COVERED_IDS), basePath)
  // The chamber entry must have evaluated before any extra bundle executes (it
  // answers the ui-primitives require edges the seed does not serve); the shell
  // already fired this gate in parallel with the graph fetch.
  if (deps.awaitBeforeLoad !== undefined && rows.length > 0) {
    await deps.awaitBeforeLoad()
  }
  let restartConflict: ExtraModuleRow | undefined
  let versionConflict: ExtraModuleRow | undefined
  /** Rows whose fresh load failed ordinary (not a DOM-script timeout): recovery candidates. */
  const failedRows: { row: ExtraModuleRow; error: unknown }[] = []

  /** Kernel seams for this boot: the shell's transport plus the page-level
   *  diagnostic sink (the kernel reports shared-load failures and timeouts itself). */
  const rowLoadDeps = {
    loadBundle: deps.loadModuleBundle,
    ...(deps.reportDiagnostic === undefined ? {} : { reportDiagnostic: deps.reportDiagnostic }),
  }
  /** Map one kernel verdict into this boot's policy: a rev conflict is recorded
   *  (loaded factory reused, diagnostic projected at the end), an ordinary
   *  first-pass failure defers to recovery; the kernel throws on timeouts. */
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
  // No second gate: it settled before the first pass, and recovery only
  // re-executes scripts (their synchronous requires run later, during run()'s
  // loader.create materialization, after the chamber entry has evaluated).
  // One bounded recovery cycle: a bundle rebuilt/replaced between fetch and load
  // (its fetched URL still names the old metadata rev) — or a transient 404 —
  // fails its row. Re-fetch the graph and reload at fresh URLs; only still-failing
  // rows fail the boot.
  if (failedRows.length > 0) {
    const secondFetch = await fetchWithRetry()
    const keptFailures: { row: ExtraModuleRow; error: unknown }[] = []
    const recoveredRows: ExtraModuleRow[] = []
    if (secondFetch.error !== null || secondFetch.rows === null) {
      // No fresh verdict (channel failed again or budget ran out): keep all failures.
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
          // No further recovery to defer to — throw so the kept-failure set is exact.
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
    // Surface the recovery's FRESH urls/revs: pass-1 urls carry the SUPERSEDED
    // metadata rev (not a per-process identity) and must never reach the kernel
    // as loadable sources.
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
  // Unsatisfiable-dependency verdict of the rows actually handed to the kernel
  // (post-recovery); computed once because the projection reports per boot. The
  // single diagnostic slot can carry only one state and a rev conflict wins it, so
  // the boot fact is ALSO logged: a row whose create-time require can never be
  // answered must not go silent just because another row conflicted.
  const unsatisfiableExternal = findUnsatisfiableExternalDependencies(rows)
  const unsatisfiableMessage = unsatisfiableExternal.length === 0
    ? null
    : `额外行的模块依赖本 boot 无法满足：${unsatisfiableExternal
        .map(miss => `${miss.rowId} → ${miss.dependencies.join(', ')}`).join('; ')}`
      + ' — 这些 id 在覆盖集内，而覆盖集内可被模块表应答的只有首屏 factory 与内核收编的 '
      + `${KERNEL_ADOPTED_IDS.join(' / ')}；有意跳过行、延迟族（只以 ctx.plugin 挂载）、页面自有/被替换的`
      + '官方行都不注册 factory，任何时刻都拿不到；相关功能在本 boot 缺失（extra 行的 create 期 require 落空）'
  if (unsatisfiableMessage !== null) console.error(`[shell] instance ${instanceId} ${unsatisfiableMessage}`)
  if (versionConflict !== undefined) {
    // Cross-instance rev drift: a different instance first claimed this id at
    // another rev, and the page keeps the first-load-wins factory — no restart
    // switches it. rev is a FILE-METADATA fact, not a version or content fact:
    // the pinned host hashes mtimeMs/ctimeMs/size, so two independent installs of
    // byte-identical bundles usually differ (ctime; hard links share it). The
    // message therefore states only the fact; the
    // user-facing hint (locales) carries the conditional "if it misbehaves" copy.
    const ownerSourceId = clientPluginRowOwner(versionConflict.id) ?? '—'
    reportDiagnostic(instanceId, 'instance-version-conflict', {
      pluginId: versionConflict.id,
      message: versionConflictMessage(versionConflict.id, ownerSourceId),
    }, deps.reportDiagnostic)
  } else if (restartConflict !== undefined) {
    reportDiagnostic(instanceId, 'restart-required', {
      pluginId: restartConflict.id,
      message: restartRequiredMessage(restartConflict.id),
    }, deps.reportDiagnostic)
  } else if (unsatisfiableMessage !== null) {
    // A kept row's create-time require can never be answered (see
    // findUnsatisfiableExternalDependencies). This is a BOOT fact, so it must not
    // be `ok`; projected as `bundle-load-failed` ("row cannot materialize"), which
    // the settings recheck never heals (it heals channel facts only). One entry per
    // boot with the first row id is deliberate: the message names every edge.
    reportDiagnostic(instanceId, 'bundle-load-failed', {
      pluginId: unsatisfiableExternal[0]!.rowId,
      message: unsatisfiableMessage,
    }, deps.reportDiagnostic)
  } else {
    reportDiagnostic(instanceId, 'ok', {}, deps.reportDiagnostic)
  }
  return rows
}
