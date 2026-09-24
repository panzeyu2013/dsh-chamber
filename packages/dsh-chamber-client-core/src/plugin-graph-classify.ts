/**
 * Single source of the host boot-graph CHANNEL classification: one
 * `clientGraph/graph` unary answer (HTTP status + server-response envelope) -> the
 * channel verdict and the exact Chinese diagnostic copy.
 *
 * WHY: the boot fetch (`renderer/src/host-graph.ts` fetchHostGraph) and the
 * channel self-heal recheck (`plugin-graph-recheck.ts`) answer the same wire
 * question for the same instance, and the recheck's write-back discipline is that
 * its verdict is word-for-word what the next shell boot would report. Both used to
 * carry their own branch tree and message literals; this module is that tree once.
 * A consumer MUST classify through `classifyPluginGraphOutcome` and take its copy
 * from the verdict — neither may re-test a status code or re-spell a
 * `host-boot-graph` literal.
 *
 * CONSUMER MAPPING: `instance-unavailable` = 503 `instance_unavailable` (expected
 * pre-ready; fetchHostGraph resolves null, the recheck writes nothing); `channel` =
 * 404 (`not-injected`), another non-2xx (`graph-unreachable`) or a 2xx error copy
 * classified into one of those (fetchHostGraph throws
 * `HostGraphChannelError(state, message)`); `malformed` = a 2xx answer whose
 * envelope or rows fail the wire contract (fetchHostGraph throws a plain
 * `Error(message)`; the recheck reports `graph-unreachable` — a malformed graph
 * must never be healed to ok); `ok` = valid envelope + base fields, with `entries`.
 *
 * WIRE CONTRACT: the message literals are contract, verbatim in
 * classifyPluginGraphOutcome below. The base gate is the BOOT FETCH's own: a row
 * check of `typeof raw !== 'object' || raw === null` (an array row falls into the
 * field check with its JSON label), and a string `id` labels compactly as `"id"`.
 */
import { classifyGraphChannelFailure, isRecord, type UnaryPostOutcome } from './wire-common.ts'

/** The two channel-fact states of the shared plugin-diagnostic union
 *  (`aggregate-store.ts`): a channel that answered no graph endpoint
 *  (`not-injected`) and one that failed otherwise (`graph-unreachable`). */
export type PluginGraphChannelState = 'not-injected' | 'graph-unreachable'

/** One wire row that passed the shared base gate: `id` / `url` / `rev` are
 *  strings, every other wire field stays `unknown` for the consumer's own
 *  (looser or stricter) validation. */
export type PluginGraphBaseEntry = {
  readonly id: string
  readonly url: string
  readonly rev: string
} & Record<string, unknown>

/** The classification of one `clientGraph/graph` unary answer. See the module
 *  header for the mapping each consumer applies to every kind. */
export type PluginGraphChannelVerdict =
  /** 503 `instance_unavailable`: instance starting / transport gone. */
  | { readonly kind: 'instance-unavailable' }
  /** A channel failure with its state and the boot's own message copy. */
  | { readonly kind: 'channel'; readonly state: PluginGraphChannelState; readonly message: string }
  /** A 2xx answer that violates the envelope/row wire contract. */
  | { readonly kind: 'malformed'; readonly message: string }
  /** A valid graph; `entries` passed the shared base gate. */
  | { readonly kind: 'ok'; readonly entries: readonly PluginGraphBaseEntry[] }

/** The HTTP-failure copy of a non-2xx channel answer (contract literal). */
export function graphHttpFailureMessage(status: number): string {
  return `宿主启动图不可达：HTTP ${status}`
}

/** Fold one transport rejection into the channel-failure copy (contract literal);
 *  the caller decides the carrier (Error vs `graph-unreachable` message). */
export function wrapGraphTransportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `宿主启动图不可达：${message}`
}

/** The compact description of one graph row used in row-shape messages: a string
 *  `id` as a quoted id, anything else as its JSON. Also the optionalStringArray
 *  `subject` suffix. */
export function graphEntryLabel(row: unknown): string {
  const record = isRecord(row) ? row : null
  return record !== null && typeof record.id === 'string' ? `"${record.id}"` : JSON.stringify(row)
}

/** The renderer-only row-shape message for a malformed `immediately` flag
 *  (contract literal). It lives here so every boot-graph literal has one home;
 *  the recheck never validates optional fields. */
export function graphEntryImmediatelyMessage(row: unknown): string {
  return `宿主启动图：entry ${graphEntryLabel(row)} 的 immediately 必须是 boolean`
}

/**
 * Classify one `postUnary` answer of Remote `clientGraph/graph` into the shared
 * verdict (branch order and literals below). Pure: no fetch, no store, no logging.
 * @returns the verdict; consumers map it as documented in the module header.
 */
export function classifyPluginGraphOutcome(outcome: UnaryPostOutcome): PluginGraphChannelVerdict {
  // 503 pre-ready probe FIRST: only the explicit instance_unavailable code is 'the instance is starting'.
  if (outcome.status === 503 && isRecord(outcome.body) && outcome.body.code === 'instance_unavailable') {
    return { kind: 'instance-unavailable' }
  }
  if (!outcome.ok) {
    return {
      kind: 'channel',
      state: outcome.status === 404 ? 'not-injected' : 'graph-unreachable',
      message: graphHttpFailureMessage(outcome.status),
    }
  }
  if (outcome.jsonError !== undefined) {
    const error = outcome.jsonError
    return {
      kind: 'malformed',
      message: `宿主启动图：envelope 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  // The envelope gate is deliberately typeof-object: an array body has no object result and lands on the same message.
  const envelope = isRecord(outcome.body) ? outcome.body : null
  if (envelope === null || typeof envelope.result !== 'object' || envelope.result === null) {
    return { kind: 'malformed', message: '宿主启动图：envelope 缺少 result' }
  }
  const result = envelope.result as Record<string, unknown>
  if (result.ok !== true) {
    // The host's own error copy: `message ?? code ?? 'unknown'` is verbatim (a present-but-empty message stays '', exotic shapes drift the message only).
    // state classification). The state regex is wire-common's shared one.
    const error = isRecord(result.error) ? result.error : {}
    const hostError = error.message ?? error.code ?? 'unknown'
    const classification = `${error.code ?? ''} ${error.message ?? ''}`
    return {
      kind: 'channel',
      state: classifyGraphChannelFailure(classification),
      message: `宿主启动图：graph 调用失败：${hostError}`,
    }
  }
  const value = result.value
  // Combined gate: a non-object value, a missing entries array and a non-array entries are the same message.
  if (typeof value !== 'object' || value === null
    || !Array.isArray((value as Record<string, unknown>).entries)) {
    return { kind: 'malformed', message: '宿主启动图：result.value.entries 必须是数组' }
  }
  const entries = (value as { entries: unknown[] }).entries
  // Per-row base gate before an ok verdict: a host serving malformed rows must not be healed to ok when the next boot fails loud on them.
  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) {
      return { kind: 'malformed', message: '宿主启动图：entry 不是对象' }
    }
    const row = raw as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.url !== 'string' || typeof row.rev !== 'string') {
      return { kind: 'malformed', message: `宿主启动图：entry ${graphEntryLabel(row)} 必须携带 string id/url/rev` }
    }
  }
  return { kind: 'ok', entries: entries as PluginGraphBaseEntry[] }
}
