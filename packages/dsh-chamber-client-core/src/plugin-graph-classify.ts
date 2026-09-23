/**
 * Single source of the host boot-graph CHANNEL classification: one
 * `clientGraph/graph` unary answer (HTTP status + server-response envelope) ->
 * the channel verdict and the exact Chinese diagnostic copy.
 *
 * WHY THIS MODULE EXISTS (audit arch-03 P2-2). The boot fetch
 * (`packages/renderer/src/host-graph.ts` fetchHostGraph) and the channel
 * self-heal recheck (`client-core/src/plugin-graph-recheck.ts`) answer the same
 * wire question for the same instance, and the recheck's whole write-back
 * discipline is that its verdict is word-for-word what the next shell boot
 * would report (design 09 section 3.5). Both used to carry their own
 * status/envelope branch tree and their own copies of every message literal,
 * kept in step only by a comment and two test files that each pinned their own
 * strings. This module is that branch tree, once: a consumer must classify
 * through `classifyPluginGraphOutcome` and take its copy from the returned
 * verdict; neither consumer may re-test a status code or re-spell a
 * `host-boot-graph` literal (locked by plugin-graph-classify.test.ts).
 *
 * EXPECTED CONSUMER MAPPING (each surface keeps its own post-processing; only
 * the wire classification and the copy are shared):
 * - `instance-unavailable`: the proxy answered 503 `instance_unavailable` (the
 *   expected pre-ready state). `fetchHostGraph` resolves null; the recheck
 *   writes nothing ("cannot judge").
 * - `channel`: an HTTP 404 (`not-injected`), another non-2xx
 *   (`graph-unreachable`), or a 2xx envelope whose `result.ok !== true` error
 *   copy classified into one of those two states. `fetchHostGraph` throws
 *   `HostGraphChannelError(state, message)`; the recheck reports
 *   `(state, message)`.
 * - `malformed`: a 2xx answer whose envelope or rows fail the wire contract.
 *   `fetchHostGraph` throws a plain `Error(message)`; the recheck reports
 *   `graph-unreachable` with the same message (a malformed graph must never be
 *   healed to ok). Each consumer may still run its OWN additional row
 *   validation: fetchHostGraph validates the optional `inject` / `external` /
 *   `immediately` fields through upstream's `optionalStringArray`, the recheck
 *   has no such pass.
 * - `ok`: the envelope and every row's base fields (`id` / `url` / `rev`
 *   strings) are valid; `entries` is that validated list.
 *
 * WIRE CONTRACT (the message literals are contract - verbatim):
 * - transport rejection    -> `host boot-graph unreachable: <error.message>`
 * - HTTP <status>          -> `host boot-graph unreachable: HTTP <status>`
 * - 2xx body not JSON      -> `host boot-graph: envelope is not valid JSON: <message>`
 * - no object `result`     -> `host boot-graph: envelope is missing result`
 * - `result.ok !== true`   -> `host boot-graph: graph call failed: <message ?? code ?? 'unknown'>`
 * - bad `value.entries`    -> `host boot-graph: result.value.entries must be an array`
 * - entry not an object    -> `host boot-graph: entry is not an object`
 * - entry base fields      -> `host boot-graph: entry <"id" | JSON> must carry string id/url/rev`
 *
 * The Chinese literals above are summarized in English here on purpose: the
 * module header must not become a second copy of the copy. The authoritative
 * literals are the template strings in classifyPluginGraphOutcome below.
 *
 * The base gate is the BOOT FETCH's own (renderer/src/host-graph.ts before this
 * extraction): the row check is `typeof raw !== 'object' || raw === null` (an
 * ARRAY row therefore falls into the field check and is reported with its JSON
 * label), and the fields message labels a string `id` compactly as `"id"` and
 * anything else as its JSON. Both consumers now agree on that one label; the
 * recheck's previous unconditional `JSON.stringify(raw)` is retired with its
 * local branch tree.
 *
 * The regex that maps the envelope's error copy (code + message) onto the two
 * channel states is `classifyGraphChannelFailure` in wire-common.ts - imported
 * here, never re-implemented per consumer.
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

/** Fold one transport rejection into the channel-failure copy (contract
 *  literal). The caller decides the carrier: `fetchHostGraph` wraps it in an
 *  `Error`, the recheck reports it as the `graph-unreachable` message. */
export function wrapGraphTransportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return `宿主启动图不可达：${message}`
}

/** The compact description of one graph row used in row-shape messages: a
 *  string `id` renders as a quoted id, anything else as its JSON (the boot
 *  fetch's own label). Also used as the optionalStringArray `subject` suffix. */
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
 * verdict (see the module header for the branch order and every literal). Pure:
 * no fetch, no store, no logging.
 * @param outcome - the collected unary answer from wire-common's postUnary.
 * @returns the verdict; consumers map it as documented in the module header.
 */
export function classifyPluginGraphOutcome(outcome: UnaryPostOutcome): PluginGraphChannelVerdict {
  // 503 pre-ready probe FIRST: only the explicit instance_unavailable code is
  // `the instance is starting`; any other 503 is a channel failure.
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
  // The server-response envelope gate is deliberately typeof-object: an ARRAY
  // body has no object `result` and lands on the same message.
  const envelope = isRecord(outcome.body) ? outcome.body : null
  if (envelope === null || typeof envelope.result !== 'object' || envelope.result === null) {
    return { kind: 'malformed', message: '宿主启动图：envelope 缺少 result' }
  }
  const result = envelope.result as Record<string, unknown>
  if (result.ok !== true) {
    // The host's own error copy: `message ?? code ?? 'unknown'` is verbatim
    // (a present-but-empty message stays '', a truthy non-string value
    // interpolates as-is; exotic shapes drift the message only, never the
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
  // Mirror the boot's combined gate: a non-object value, a missing entries
  // array and a non-array entries field are the same message.
  if (typeof value !== 'object' || value === null
    || !Array.isArray((value as Record<string, unknown>).entries)) {
    return { kind: 'malformed', message: '宿主启动图：result.value.entries 必须是数组' }
  }
  const entries = (value as { entries: unknown[] }).entries
  // Per-row base gate before an ok verdict: a host serving malformed rows must
  // not be healed to ok when the next boot fails loud on exactly these rows
  // (design 09 section 3.5 mirror contract).
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
