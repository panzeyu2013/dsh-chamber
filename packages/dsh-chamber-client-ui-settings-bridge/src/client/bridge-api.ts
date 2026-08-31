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
 * forwards it untouched. Self-contained on purpose (no dsh package types):
 * the bridge package keeps the loose-ambient typecheck pattern of the
 * connections package.
 */
export interface BridgeRpcFailure {
  code: string
  message: string
  details?: object
}

/** The `RemoteResult` union every bridged Remote method resolves to. */
export type BridgeRpcResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: BridgeRpcFailure }

/** One transport failure, folded with an honest prefix (proxy honesty, design 03 §3.3). */
function wrapWireError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`实例不可达：${message}`)
}

export class BridgeApiClient {
  private readonly basePath: string

  /** @param basePath - the per-instance proxy prefix ('/api/i/<id>'). */
  constructor(basePath: string) {
    this.basePath = basePath
  }

  private async call(method: string, args: Record<string, unknown>): Promise<BridgeRpcResult> {
    // Bounded unary (official DEFAULT_TIMEOUT_MS): the control-plane proxy
    // forwards without an upstream timeout, so a silently hung host would
    // otherwise leave the settings page loading forever — fail loud instead.
    const origin = typeof location !== 'undefined' ? location.origin : undefined
    const base = origin !== undefined && origin !== 'null' ? origin : ''
    const url = `${base}${this.basePath}/api/${method}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method,
          payload: { args },
        }),
        signal: AbortSignal.timeout(30000),
      })
    } catch (error) {
      throw wrapWireError(error)
    }
    if (response.status === 503) {
      let body: { code?: string; error?: string } | null = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (body?.code === 'instance_unavailable') {
        throw new Error(`实例未就绪：${body.error ?? '实例尚未就绪'}`)
      }
    }
    if (!response.ok) {
      throw wrapWireError(new Error(`HTTP ${response.status}`))
    }
    return parseRemoteResult(await response.json())
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

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
