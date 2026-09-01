/**
 * Per-instance plugin-inventory read face for the connections section: the
 * unary Typert Remote wire of dsh-v0.1.2-alpha.1 — the exact
 * `pluginInventory/list` endpoint the official 插件列表 settings tab consumes —
 * POSTed to `{origin}/api/i/<sourceId>/api/pluginInventory/list` through the
 * control-plane per-instance proxy (design 05 §5 / 03 §3).
 *
 * This is the plugin surface for connections WITHOUT the SSH plugin channel:
 * gateway targets (both transports — the desktop's SSH exec surface refuses
 * `kind !== 'dsh'`) and dsh+http direct endpoints. The managed instance's own
 * host serves the Loader snapshot, so the view needs no SSH exec, no local
 * manifest and no new authority — the host fact is only attached through the
 * existing generic proxy (AGENTS.md: host-native capabilities stay the host's
 * job; the control plane only attaches).
 *
 * Self-contained on purpose (the package's loose-ambient typecheck pattern):
 * the wire types below are structural mirrors of the vendored
 * `@deepseek-ai/dsh-host-plugin-inventory` types; no dsh package import.
 */

/** Lifecycle state of an entry's root Fiber, or null when it has no live root Fiber. */
export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** One non-group Loader entry exposed to trusted clients. */
export interface PluginInventoryEntry {
  readonly entryId: string
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  /** Effective Loader enablement, including disabled ancestor groups. */
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Effective enablement of one preset composition row. */
export type PresetPluginEnablement = boolean | 'conditional'

/** One plugin row an agent preset's composition names. */
export interface AgentPresetPluginRow {
  /** Composition row id, or null when the row declares none. */
  readonly entryId: string | null
  /** Module specifier the row names. */
  readonly moduleName: string
  readonly enabled: PresetPluginEnablement
  /** The row's own `!!js` disabled expression, when it carries one. */
  readonly condition?: string
  readonly fiberPhase: PluginFiberPhase
}

/** One agent preset's identity and flattened composition in the inventory. */
export interface AgentPresetPluginGroup {
  readonly id: string
  readonly trust: 'system' | 'user'
  readonly name?: string
  readonly isDefault: boolean
  /** Why this preset's composition cannot be read; absent when rows answer. */
  readonly broken?: string
  readonly rows: readonly AgentPresetPluginRow[]
}

/** Point-in-time inventory returned by the plugin inventory Remote. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
  /**
   * Per-preset compositions, present only when an agent-preset roster is
   * composed in this deployment.
   */
  readonly agentPresets?: readonly AgentPresetPluginGroup[]
}

/** The Remote failure union's error member (bridge wire mirror). */
export interface PluginInventoryRpcFailure {
  code: string
  message: string
  details?: object
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isPluginFiberPhase(value: unknown): value is PluginFiberPhase {
  return value === null || value === 'pending' || value === 'loading'
    || value === 'active' || value === 'failed' || value === 'unloading'
}

function parseEntry(value: unknown): PluginInventoryEntry {
  if (!isRecord(value) || !isString(value.entryId) || !isString(value.moduleName)
    || typeof value.enabled !== 'boolean' || !isPluginFiberPhase(value.fiberPhase)) {
    throw new TypeError('plugin-inventory: invalid inventory entry')
  }
  return {
    entryId: value.entryId,
    moduleName: value.moduleName,
    enabled: value.enabled,
    fiberPhase: value.fiberPhase,
  }
}

function parsePresetRow(value: unknown): AgentPresetPluginRow {
  if (!isRecord(value) || (value.entryId !== null && !isString(value.entryId))
    || !isString(value.moduleName)
    || (value.enabled !== true && value.enabled !== false && value.enabled !== 'conditional')
    || !isPluginFiberPhase(value.fiberPhase)) {
    throw new TypeError('plugin-inventory: invalid preset composition row')
  }
  return {
    entryId: value.entryId,
    moduleName: value.moduleName,
    enabled: value.enabled,
    ...(value.condition === undefined || !isString(value.condition) ? {} : { condition: value.condition }),
    fiberPhase: value.fiberPhase,
  }
}

function parsePresetGroup(value: unknown): AgentPresetPluginGroup {
  if (!isRecord(value) || !isString(value.id)
    || (value.trust !== 'system' && value.trust !== 'user')
    || typeof value.isDefault !== 'boolean' || !Array.isArray(value.rows)) {
    throw new TypeError('plugin-inventory: invalid preset group')
  }
  return {
    id: value.id,
    trust: value.trust,
    ...(value.name === undefined || !isString(value.name) ? {} : { name: value.name }),
    isDefault: value.isDefault,
    ...(value.broken === undefined || !isString(value.broken) ? {} : { broken: value.broken }),
    rows: value.rows.map(parsePresetRow),
  }
}

/** Validate the server-response envelope and project its `result` (mirror of
 *  the official parseConnectionResponse / settings-bridge bridge-api). */
function parseRemoteResult(value: unknown): { ok: true; value: PluginInventorySnapshot } | { ok: false; error: PluginInventoryRpcFailure } {
  if (!isRecord(value) || value.type !== 'server-response' || !isString(value.rpcId)) {
    throw new TypeError('plugin-inventory: invalid server-response envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('plugin-inventory: invalid server-response result')
  if (result.ok === true) {
    const snapshot = result.value
    if (!isRecord(snapshot) || !Array.isArray(snapshot.entries)) {
      throw new TypeError('plugin-inventory: invalid snapshot')
    }
    let value: PluginInventorySnapshot = { entries: snapshot.entries.map(parseEntry) }
    const agentPresets = snapshot.agentPresets
    if (agentPresets !== undefined) {
      if (!Array.isArray(agentPresets)) {
        throw new TypeError('plugin-inventory: invalid preset list')
      }
      value = { ...value, agentPresets: agentPresets.map(parsePresetGroup) }
    }
    return { ok: true, value }
  }
  const error = result.error
  if (result.ok !== false || !isRecord(error) || !isString(error.code) || !isString(error.message)) {
    throw new TypeError('plugin-inventory: invalid server-response failure')
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

/** One transport failure, folded with an honest prefix (proxy honesty, design 03 §3.3). */
function wrapWireError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`实例不可达：${message}`)
}

/**
 * Read the managed instance's plugin inventory through the per-instance
 * proxy. TRANSPORT failures (network, non-2xx, the proxy's explicit
 * `instance_unavailable` 503) and BUSINESS failures both throw loud errors —
 * the caller renders the message with a retry; a failure is never a silent
 * empty list.
 * @param sourceId - the proxy source id (`dsh-<id>` / `gateway-<id>`).
 */
export async function loadPluginInventory(sourceId: string): Promise<PluginInventorySnapshot> {
  // Bounded unary (official DEFAULT_TIMEOUT_MS): the control-plane proxy
  // forwards without an upstream timeout, so a silently hung host would
  // otherwise leave the view loading forever — fail loud instead.
  const origin = typeof location !== 'undefined' ? location.origin : undefined
  const base = origin !== undefined && origin !== 'null' ? origin : ''
  const url = `${base}/api/i/${sourceId}/api/pluginInventory/list`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'pluginInventory/list',
        payload: { args: {} },
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
  const result = parseRemoteResult(await response.json())
  if (!result.ok) {
    throw new Error(`pluginInventory/list failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}
