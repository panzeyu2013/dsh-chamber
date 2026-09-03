/**
 * Channel-class plugin-diagnostic self-heal recheck (design 09 §3.5): the
 * connections surface (settings-bridge panel + plugin dialogs) re-checks the
 * per-instance host boot-graph channel when the LAST recorded diagnostic is a
 * CHANNEL fact — `not-injected` / `graph-unreachable` — and heals by writing
 * the current verdict back through chamberBridge.
 *
 * Why this is bounded: `bundle-load-failed`, `restart-required` and
 * `instance-version-conflict` are BOOT facts — only a re-boot of the instance
 * shell can change what the merge loaded, so a channel recheck must never
 * touch them (their honest fix guidance stays). A 404 `not-injected` /
 * `graph-unreachable`, by contrast, can heal WITHOUT a boot: a gateway's
 * managed dsh restarts with the desktop-synced chamber host packages moments
 * after the shell boot that recorded the 404, the ssh target's host package
 * seed lands, or the transport simply was not ready. Before this module the
 * stale banner survived until the next instance boot (the only other writer
 * of plugin diagnostics) — i.e. an app restart — while the inventory view
 * next to it already showed the live healed Loader state.
 *
 * Write discipline (loop-freedom + recency): the recheck reports ONLY when
 * the verdict STATE differs from the recorded diagnostic — a message-only
 * drift (non-deterministic host/network error text) never writes, so a
 * store-driven pass can never ping-pong on its own writes; a still-broken
 * channel re-verifies to the same state and writes nothing. The write itself
 * re-reads the store and bails when the record changed while the fetch was
 * in flight (a shell boot is the authoritative writer — a stale recheck
 * verdict must never clobber a fresher boot record, whatever its state). A
 * 503 `instance_unavailable` (instance starting / transport gone) is
 * "cannot judge" — never written.
 *
 * Wire mirror: the fetch/classification below mirrors the renderer's
 * boot-time fetch (`packages/renderer/src/host-graph.ts` fetchHostGraph —
 * same envelope, same status classification, same message literals), so a
 * recheck verdict is word-for-word what the next boot would report. The
 * envelope is hand-built to the same wire shape as bridge-api.ts (bounded
 * unary; the renderer cannot import the shared Node envelope module).
 */

import { chamberBridge } from './aggregate-store.ts'
import type { PluginGraphDiagnostic, PluginGraphDiagnosticState } from './aggregate-store.ts'

/** Channel facts a recheck may heal; boot facts never. */
const CHANNEL_CLASS_STATES: ReadonlySet<PluginGraphDiagnosticState> = new Set(['not-injected', 'graph-unreachable'])

/** True for the diagnostics that describe the host-graph CHANNEL at the last
 *  shell boot (self-heal candidates) — never for boot-fact classes. */
export function isChannelClassDiagnostic(state: PluginGraphDiagnosticState | undefined): boolean {
  return state !== undefined && CHANNEL_CLASS_STATES.has(state)
}

/** Bounded unary (mirror of the boot fetch's 30s): a silently hung host must
 *  not pin the connections page's recheck pass. */
const GRAPH_RECHECK_TIMEOUT_MS = 30000

export type PluginGraphRecheckOutcome =
  /** The channel answers a valid graph → reported `ok` (heal). */
  | 'reported-ok'
  /** The channel answers 404 / unknown method → reported `not-injected`. */
  | 'reported-not-injected'
  /** The channel failed otherwise → reported `graph-unreachable`. */
  | 'reported-graph-unreachable'
  /** No write: verdict STATE unchanged (message-only drift never writes),
   *  the record changed while the fetch was in flight, or a 503
   *  `instance_unavailable` made the channel unjudgeable. */
  | 'unchanged'
  /** No write: no recorded diagnostic, or it is not a channel-class state. */
  | 'skipped'

export interface PluginGraphRecheckDeps {
  /** Test seam; defaults to the ambient fetch. */
  fetchImpl?: typeof fetch
  /** Test seam; defaults to the page origin. */
  origin?: string
  /** Test seam; defaults to Date.now. */
  now?: () => number
}

/** One fetch failure, folded with the same honest prefix as the boot fetch. */
function wrapRecheckError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `宿主启动图不可达：${message}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Re-check one source's host boot-graph channel and write the verdict back
 * through chamberBridge WHEN it differs from the recorded diagnostic.
 *
 * Never writes for boot-fact states, for an absent diagnostic, when the
 * verdict STATE is unchanged (a heal is always a state flip), or when the
 * record changed while the fetch was in flight (a shell boot is the
 * authoritative writer; a stale verdict never clobbers it); a 503
 * `instance_unavailable` (pre-ready instance / missing transport) is
 * "cannot judge" and also never writes. The report carries the same
 * state/message literals the next shell boot would produce.
 *
 * @param sourceId - the proxy source id (`local` | `<kind>-<id>`), matching
 *   the plugin-diagnostic store keys.
 * @returns what happened, for tests and diagnostics.
 */
export async function recheckPluginGraphDiagnostic(
  sourceId: string,
  deps: PluginGraphRecheckDeps = {},
): Promise<PluginGraphRecheckOutcome> {
  const current = chamberBridge.getPluginDiagnostics()[sourceId]
  if (current === undefined || !isChannelClassDiagnostic(current.state)) return 'skipped'

  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? (() => Date.now())
  const origin = deps.origin !== undefined
    ? deps.origin
    : typeof location !== 'undefined' && location.origin !== 'null' ? location.origin : ''
  const url = `${origin}/api/i/${sourceId}/api/clientGraph/graph`

  // Verdict write-back. Recency gate: the store is re-read at WRITE time (no
  // await between re-read and write) — a record changed while the fetch was
  // in flight (a shell boot is the authoritative writer; retirement clears
  // mid-flight) is never clobbered by this stale verdict. Write decision:
  // only a STATE change writes — a message-only drift (non-deterministic
  // host/network error text) never writes, so no self-triggered ping-pong.
  const report = (state: PluginGraphDiagnostic['state'], message?: string): PluginGraphRecheckOutcome => {
    const recorded = chamberBridge.getPluginDiagnostics()[sourceId]
    if (recorded === undefined
      || recorded.state !== current.state
      || recorded.message !== current.message
      || recorded.updatedAt !== current.updatedAt
      || recorded.pluginId !== current.pluginId) return 'unchanged'
    if (state === recorded.state) return 'unchanged'
    chamberBridge.reportPluginDiagnostic(sourceId, {
      state,
      message,
      updatedAt: now(),
      ...(recorded.pluginId === undefined ? {} : { pluginId: recorded.pluginId }),
    })
    return state === 'ok' ? 'reported-ok'
      : state === 'not-injected' ? 'reported-not-injected'
        : 'reported-graph-unreachable'
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'clientGraph/graph',
        payload: { args: {} },
      }),
      signal: AbortSignal.timeout(GRAPH_RECHECK_TIMEOUT_MS),
    })
  } catch (error) {
    return report('graph-unreachable', wrapRecheckError(error))
  }

  if (response.status === 503) {
    let body: { code?: unknown } | null = null
    try {
      body = (await response.json()) as { code?: unknown }
    } catch {
      body = null
    }
    // Pre-ready instance / missing transport: cannot judge — never write.
    if (body?.code === 'instance_unavailable') return 'unchanged'
    return report('graph-unreachable', `宿主启动图不可达：HTTP ${response.status}`)
  }
  if (response.status === 404) {
    return report('not-injected', `宿主启动图不可达：HTTP ${response.status}`)
  }
  if (!response.ok) {
    return report('graph-unreachable', `宿主启动图不可达：HTTP ${response.status}`)
  }

  let envelope: unknown
  try {
    envelope = await response.json()
  } catch (error) {
    return report('graph-unreachable', `宿主启动图：envelope 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  const envelopeRecord = isRecord(envelope) ? envelope : null
  // Mirror the boot's result gate exactly (typeof-object lets ARRAYS through —
  // an array result then falls into the ok !== true branch below).
  if (envelopeRecord === null
    || typeof envelopeRecord.result !== 'object' || envelopeRecord.result === null) {
    return report('graph-unreachable', '宿主启动图：envelope 缺少 result')
  }
  const result = envelopeRecord.result
  const resultRecord = isRecord(result) ? result : null
  if (resultRecord === null || resultRecord.ok !== true) {
    // Mirror the boot's `??` chain verbatim (a present-but-empty message
    // stays '', a truthy non-string value interpolates as-is — the real
    // Remote always emits string {code,message}, exotic shapes only drift in
    // the message literal, never in the state classification).
    const error: Record<string, unknown> = resultRecord !== null && isRecord(resultRecord.error)
      ? resultRecord.error
      : {}
    const hostError = error.message ?? error.code ?? 'unknown'
    const classification = `${error.code ?? ''} ${error.message ?? ''}`
    const state = /not.?found|unknown.?method|method.+(?:missing|unknown|unsupported)/i.test(classification)
      ? 'not-injected'
      : 'graph-unreachable'
    return report(state, `宿主启动图：graph 调用失败：${hostError}`)
  }
  const value = resultRecord.value
  if (typeof value !== 'object' || value === null || !Array.isArray((value as Record<string, unknown>).entries)) {
    return report('graph-unreachable', '宿主启动图：result.value.entries 必须是数组')
  }
  // Mirror the boot's per-row parse before the ok verdict: a host serving
  // malformed rows must not be healed to ok by the recheck when the next
  // boot fails loud on exactly these rows (design 09 §3.5 mirror contract).
  for (const raw of (value as { entries: unknown[] }).entries) {
    if (!isRecord(raw)) {
      return report('graph-unreachable', '宿主启动图：entry 不是对象')
    }
    if (typeof raw.id !== 'string' || typeof raw.url !== 'string' || typeof raw.rev !== 'string') {
      return report('graph-unreachable', `宿主启动图：entry ${JSON.stringify(raw)} 必须携带 string id/url/rev`)
    }
  }
  return report('ok')
}
