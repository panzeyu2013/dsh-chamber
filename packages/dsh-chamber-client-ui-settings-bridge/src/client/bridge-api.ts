/**
 * Per-instance unary RPC client for the settings bridge (the wire protocol of
 * dsh-host-apiproxy's fetch carrier, as consumed by the official settings
 * plugins' controllers): POST `{base}/api/<method>` with a client-request
 * envelope. Responses resolve to the FULL wire envelope `{rpcId, result}`
 * exactly like the official IApiClient (`fetch/client.ts`): controllers read
 * `response.result.ok / .value / .error` themselves and do NOT expect
 * business failures to throw. Only TRANSPORT failures throw here (network,
 * non-2xx, the proxy's explicit `instance_unavailable` 503) — the official
 * client throws for those too.
 *
 * The base path is the chamber per-instance proxy prefix (`/api/i/<id>`), so
 * every call lands on the TARGET instance's host — the control plane
 * forwards it untouched. Self-contained on purpose (no dsh package types):
 * the bridge package keeps the loose-ambient typecheck pattern of the
 * connections package.
 */
export interface BridgeRpcResult {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

/** The resolved wire envelope (shape mirror of the official RpcResponse). */
export interface BridgeRpcResponse {
  rpcId: string
  result: BridgeRpcResult
}

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

  private async call(method: string, payload: Record<string, unknown> = {}): Promise<BridgeRpcResponse> {
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
        body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload }),
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
    const envelope = await response.json()
    return envelope as BridgeRpcResponse
  }

  /** Settings namespace face (describe/update/mutate — the official controllers' set). */
  readonly settings = {
    describe: (payload: Record<string, unknown> = {}) => this.call('settings.describe', payload),
    update: (payload: Record<string, unknown>) => this.call('settings.update', payload),
    mutate: (payload: Record<string, unknown>) => this.call('settings.mutate', payload),
    openDocument: (payload: Record<string, unknown>) => this.call('settings.openDocument', payload),
  }

  /** Credential face (structural describe; key plaintext crosses only inside set). */
  readonly credentials = {
    describe: (payload: Record<string, unknown>) => this.call('credentials.describe', payload),
    set: (payload: Record<string, unknown>) => this.call('credentials.set', payload),
    unset: (payload: Record<string, unknown>) => this.call('credentials.unset', payload),
  }

  /** LLM provider/model directory face. */
  readonly llm = {
    providers: (payload: Record<string, unknown> = {}) => this.call('llm.providers', payload),
    models: (payload: Record<string, unknown>) => this.call('llm.models', payload),
    discoverModels: (payload: Record<string, unknown>) => this.call('llm.discoverModels', payload),
  }

  /**
   * Agent-preset roster face — the OFFICIAL controllers call `api.agentPresets`
   * (plural, the IApiClient member name); the wire method ids stay the
   * singular `agentPreset.*` (rpc-map).
   */
  readonly agentPresets = {
    list: (payload: Record<string, unknown> = {}) => this.call('agentPreset.list', payload),
    select: (payload: Record<string, unknown>) => this.call('agentPreset.select', payload),
    read: (payload: Record<string, unknown>) => this.call('agentPreset.read', payload),
    copy: (payload: Record<string, unknown>) => this.call('agentPreset.copy', payload),
    openDocument: (payload: Record<string, unknown>) => this.call('agentPreset.openDocument', payload),
    remove: (payload: Record<string, unknown>) => this.call('agentPreset.remove', payload),
  }

  /**
   * Host plugin inventory (the plugin-inventory settings tab's read face).
   * Typert Remote wire: endpoint `namespace/method` and a payload of exactly
   * one `{args}` field (verified against the live host).
   */
  readonly pluginInventory = {
    list: (payload: Record<string, unknown> = {}) => this.call('pluginInventory/list', { args: payload }),
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
