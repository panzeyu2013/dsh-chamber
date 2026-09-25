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

import { CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import { graphGapKindFor, type GraphGapKind } from './source-readiness.ts'
// Boot-graph wire validators are UPSTREAM's own — never hand-rolled — imported
// by real-source relative path because the renderer has no install-tree copy
// and plain-node tests must resolve the real module without a bundler.
// Keep the local parse LOOSER than upstream's — see the fetchHostGraph comment.
import { optionalStringArray, stripClientSuffix } from '../../../vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts'
// Deferred-covered roster, shared with the composite entry (which asserts its
// roster against it at apply time): covered ids whose module-table factory
// exists only AFTER the boot settled.
import { DEFERRED_EXTRA_ROW_IDS } from './required-extra-rows.ts'
import type { PluginGraphDiagnostic, PluginGraphDiagnosticState } from '@dsh-chamber/dsh-chamber-client-core'
import { postUnary, type UnaryPostOutcome } from '@dsh-chamber/dsh-chamber-client-core/wire-common'
// Envelope classification SINGLE SOURCE, also consumed by client-core's
// plugin-graph-recheck.ts: boot and self-heal verdicts for the same wire answer
// can never drift.
import {
  classifyPluginGraphOutcome, graphEntryImmediatelyMessage, graphEntryLabel, wrapGraphTransportFailure,
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

/** Re-exported for existing consumers (the type lives in the chamber shared face). */
export type { PluginGraphDiagnostic, PluginGraphDiagnosticState }

/** One composed client entry row (mirror of upstream WebBootEntry): bundle urls
 *  use the single-id combo form; the graph's multi-id combo BATCHES are ignored
 *  (the fetch reads `entries` only). */
export interface HostGraphRow {
  id: string
  /** Bundle endpoint, '/plugins/??<id>/client.js&rev=<rev>' (host-root-relative). */
  url: string
  /** Opaque cache-busting revision (`<per-process nonce>-<ordinal>`), NOT a
   *  content hash: every instance restart invalidates all previous bundle URLs. */
  rev: string
  /** Package-name dependency edges, informational. */
  inject?: string[]
  /** Exact non-inject module requests of this row (WebBootEntry.external):
   *  specifiers the bundle requires beyond its `inject` edges. Load-bearing: a
   *  request onto a deferred-covered id (DEFERRED_EXTRA_ROW_IDS) is the ONE
   *  unsatisfiable edge this merge must name, not drop. */
  external?: string[]
  /** Stage-one prefetch mark (the chamber merge preloads everything it keeps). */
  immediately?: boolean
}

/** One extra module row handed to the boot kernel (mirror of the vendor
 *  BootModuleRow): `initialUrl` equals `url` (the merge preloads each entry's
 *  own combo), `inject` stays empty (the composite covers the shell), and
 *  `external` records the specifiers the factory will `require` from the module
 *  table at materialization — what {@link findDeferredExternalDependencies}
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
  const rows: HostGraphRow[] = []
  for (const row of verdict.entries) {
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
      // which are unsatisfiable (findDeferredExternalDependencies).
      external: [...(row.external ?? [])],
    })
  }
  return out
}

/**
 * The `external` requests of the kept rows this page can NEVER satisfy: a
 * request naming a composite-COVERED id whose family registers only after the
 * boot settled (`DEFERRED_EXTRA_ROW_IDS`).
 * Unsatisfiable, not merely late: the covered row is filtered out of the graph,
 * the composite registers only its FIRST-SCREEN families, and the consumer
 * row's synchronous `require` misses the module table at create — only this
 * merge knows the covered/deferred sets without a round trip, so it names the
 * miss here. Requests are matched suffix-stripped exactly as the kernel does;
 * peer extras and first-screen factories are satisfied, not reported.
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
 * deferred-covered id is a NAMED diagnostic, not `ok`. A bundle that fails to
 * LOAD fails the boot loud after ONE bounded recovery pass: upstream revs are
 * opaque PER-PROCESS nonces, so a restart between graph fetch and loads 404s
 * every not-yet-loaded row; the pass re-fetches and retries at fresh URLs, and
 * only still-failing rows fail the boot. A DOM-script TIMEOUT is not recovery:
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
          // Non-503 channel failures are NOT transient: fail fast (a hung fetch
          // already consumed its 30s timeout; retrying would only stack them).
          lastError = error
          return { rows: null, error: lastError, starting: false }
        }
        if (attempt < retry.attempts) await retry.sleep(retry.delayMs)
      }
      // Budget gone and the channel never answered non-503 → the source is still
      // starting: wait for it (App-bounded) and retry on a fresh budget.
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
  // One bounded recovery cycle: revs are opaque per-process nonces, so an
  // instance restart between fetch and loads 404s every remaining row. Re-fetch
  // the graph and reload at fresh URLs; only still-failing rows fail the boot.
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
    // Surface the recovery's FRESH urls/revs: pass-1 urls carry the stale process
    // generation and must never reach the kernel as loadable sources.
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
  // Deferred-dependency verdict of the rows actually handed to the kernel
  // (post-recovery); computed once because the projection reports per boot.
  const deferredExternalMisses = findDeferredExternalDependencies(rows)
  if (versionConflict !== undefined) {
    // Cross-instance plugin version drift: a different instance first claimed
    // this id at another rev, and the page keeps the first-load-wins factory —
    // no restart can switch it. The fix is aligning the two instances' dsh
    // runtimes (or plugin versions); then the revs match and the diagnostic clears.
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
    // A kept row's create-time require can never be answered (see
    // findDeferredExternalDependencies). This is a BOOT fact, so it must not be
    // `ok`; projected as `bundle-load-failed` ("row cannot materialize"), which
    // the settings recheck never heals (it heals channel facts only).
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
