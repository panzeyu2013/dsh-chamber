/**
 * Per-instance unary RPC client for the settings bridge — the Typert Remote
 * wire protocol of dsh-v0.1.2-alpha.1 (the `ctx.remote.*` namespaces the
 * official settings plugins consume): POST `{base}/api/<namespace>/<method>`
 * with a client-request envelope whose payload is exactly one `{args}` field
 * (the host method's positional parameter names), answered by a
 * server-response envelope whose result is the `RemoteResult` union
 * `{ok:true,value}` | `{ok:false,error:{code,message,details}}`. Controllers
 * read `response.ok / .value / .error` themselves and do NOT expect business
 * failures to throw. Only TRANSPORT failures throw here (network, non-2xx,
 * the proxy's explicit `instance_unavailable` 503) — the official client
 * throws for those too.
 *
 * The base path is the chamber per-instance proxy prefix (`/api/i/<id>`), so
 * every call lands on the TARGET instance's host — the control plane
 * forwards it untouched. P4-2 (N6): the transport byte (URL join +
 * client-request envelope + POST + body collection, bounded unary 30s) rides
 * the shared kernel postUnary (`@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`,
 * wire-common.ts) — the SAME source copy the renderer bundles; the
 * envelope/server-response classification ('bridge:' validation, ok-value
 * shaping) stays local, while the C≡D wrapWireError fold + 503
 * instance_unavailable classifier come from the shared wire-error module of
 * the same face (a policy-free constructor + predicate — the shared kernel
 * itself still performs no classification, and A/B/F keep their own
 * actions/copies per the wire-common audit).
 * Self-contained on purpose (no dsh package types): the bridge package keeps
 * the loose-ambient typecheck pattern of the connections package.
 */

import {
  isRecord, postUnary, throwIfInstanceUnavailable, wrapWireError,
  type UnaryPostOutcome,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

export interface BridgeRpcFailure {
  code: string
  message: string
  details?: object
}

/** The `RemoteResult` union every bridged Remote method resolves to. */
export type BridgeRpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: BridgeRpcFailure }

export class BridgeApiClient {
  private readonly basePath: string

  /** @param basePath - the per-instance proxy prefix ('/api/i/<id>'). */
  constructor(basePath: string) {
    this.basePath = basePath
  }

  private async call(method: string, args: Record<string, unknown>): Promise<BridgeRpcResult> {
    // Shared transport byte (P4-2, postUnary in wire-common.ts): bounded
    // unary on the official 30s budget — the control-plane proxy forwards
    // without an upstream timeout, so a silently hung host would otherwise
    // leave the settings page loading forever — fail loud instead. The
    // pre-migration bare crypto.randomUUID() rpcId stays explicit so its
    // evaluation remains inside this try (a no-randomUUID environment folds
    // the throw into the shared wrapWireError below, exactly as before).
    // Transport rejections propagate raw and are folded via the shared
    // wire-error module (the C≡D copy).
    let outcome: UnaryPostOutcome
    try {
      outcome = await postUnary(this.basePath, method, args, {
        rpcId: crypto.randomUUID(),
      })
    } catch (error) {
      throw wrapWireError(error)
    }
    // 503 instance_unavailable (not-ready instance — proxy honesty, design 03
    // §3.3): the shared C≡D classifier throws the byte-identical error.
    throwIfInstanceUnavailable(outcome)
    if (!outcome.ok) {
      throw wrapWireError(new Error(`HTTP ${outcome.status}`))
    }
    if (outcome.jsonError !== undefined) throw outcome.jsonError
    return parseRemoteResult(outcome.body)
  }

  /**
   * Settings namespace face — the exact `remote.settings` method set the
   * official settings plugins consume (`SettingsRemote`):
   * describe/update/replace/mutate plus the two native openers. `undefined`
   * `expectedRevision`/`name` are omitted from the wire args (the generated
   * client skips undefined parameters).
   */
  readonly settings = {
    describe: () => this.call('settings/describe', {}),
    update: (ns: string, patch: Record<string, unknown>, expectedRevision?: number) =>
      this.call('settings/update', {
        ns,
        patch,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    replace: (ns: string, section: Record<string, unknown>, expectedRevision?: number) =>
      this.call('settings/replace', {
        ns,
        section,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    mutate: (
      ns: string,
      ops: readonly { op: string; path: readonly string[]; value?: unknown }[],
      expectedRevision?: number,
    ) =>
      this.call('settings/mutate', {
        ns,
        ops,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }),
    openSettingsDocument: () => this.call('settings/openSettingsDocument', {}),
    openAgentPresetDirectory: (agentPreset: string) =>
      this.call('settings/openAgentPresetDirectory', { agentPreset }),
    canOpenAgentPresetDirectory: () => this.call('settings/canOpenAgentPresetDirectory', {}),
  }

  /** Credential namespace face (structural describe; key plaintext crosses only inside set). */
  readonly credentials = {
    describe: (refs: readonly string[]) => this.call('credentials/describe', { refs }),
    set: (ref: string, value: string) => this.call('credentials/set', { ref, value }),
    unset: (ref: string) => this.call('credentials/unset', { ref }),
  }

  /** LLM provider/model directory face (the official models section's directory). */
  readonly llm = {
    listProviders: () => this.call('llm/listProviders', {}),
    listConfigurableProviders: () => this.call('llm/listConfigurableProviders', {}),
    discoverModels: (settingsNs: string, request: Record<string, unknown>) =>
      this.call('llm/discoverModels', { settingsNs, request }),
  }

  /**
   * Agent-preset roster face — the new `agentPresets` namespace: `list`
   * (roster + authoring capability), `read`, `copy`, `deletePreset`, and
   * `select`. Upstream `select(agent: Agent, agentPreset: string)` — the
   * typert wire projects the Agent parameter as the `agentId` lookup key
   * (the seat's session identity string), so the args are exactly
   * `{agentId, agentPreset}` (review-round7a P2-1; the round-3 fix guessed
   * `{agent:{id:''}}`, which the generated descriptor disproves). The
   * bridged child context has no session identity, so `agentId` is sent
   * empty — the host lookup fails loudly if the seat fiber ever reaches it
   * (it does not activate here).
   */
  readonly agentPresets = {
    list: () => this.call('agentPresets/list', {}),
    read: (agentPreset: string) => this.call('agentPresets/read', { agentPreset }),
    copy: (from: string, id: string, name?: string) =>
      this.call('agentPresets/copy', {
        from,
        id,
        ...(name === undefined ? {} : { name }),
      }),
    deletePreset: (id: string) => this.call('agentPresets/deletePreset', { id }),
    select: (agentPreset: string) => this.call('agentPresets/select', { agentId: '', agentPreset }),
  }

  /** Session catalog read face (the plugins section's model-catalog card). */
  readonly session = {
    modelCatalog: () => this.call('session/modelCatalog', {}),
  }

  /** Host plugin inventory (the plugin-inventory settings tab's read face). */
  readonly pluginInventory = {
    list: () => this.call('pluginInventory/list', {}),
  }

  /**
   * Host client-plugin boot graph face (chamber host gateway
   * `dsh-chamber-seed-client-graph`, Remote `clientGraph/graph`): the composed
   * `dsh.client` rows of THIS source, the same graph the host injects as
   * `window.__DSH_BOOT__`. The settings bridge reads it to mount the selected
   * source's own plugin contributions into the child context (2026-12) —
   * read-only, no execution surface on the host side.
   */
  readonly clientGraph = {
    graph: () => this.call('clientGraph/graph', {}),
  }
}

/** Validate the server-response envelope and project its `result` (mirror of the official parseConnectionResponse). */
function parseRemoteResult(value: unknown): BridgeRpcResult {
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('bridge: invalid server-response envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('bridge: invalid server-response result')
  if (result.ok === true) return { ok: true, value: result.value }
  if (result.ok !== false || !isRecord(result.error)) {
    throw new TypeError('bridge: invalid server-response result')
  }
  const error = result.error
  if (typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw new TypeError('bridge: invalid server-response failure')
  }
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(isRecord(error.details) ? { details: error.details } : {}),
    },
  }
}

const clients = new Map<string, BridgeApiClient>()

/** One cached client per instance (the base path is the identity). */
export function getBridgeApiClient(instanceId: string): BridgeApiClient {
  let client = clients.get(instanceId)
  if (client === undefined) {
    client = new BridgeApiClient(`/api/i/${instanceId}`)
    clients.set(instanceId, client)
  }
  return client
}
