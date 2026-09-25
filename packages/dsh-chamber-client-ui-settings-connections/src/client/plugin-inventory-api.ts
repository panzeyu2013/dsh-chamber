/**
 * Per-instance plugin-inventory read face for the connections section: the unary Typert
 * Remote wire — the exact `pluginInventory/list` endpoint the official 插件列表 settings tab
 * consumes — POSTed to `{origin}/api/i/<sourceId>/api/pluginInventory/list` through the
 * control-plane per-instance proxy.
 *
 * This is the plugin surface for connections WITHOUT the SSH plugin channel: gateway targets
 * (the desktop's SSH exec surface refuses `kind !== 'dsh'`) and dsh+http direct endpoints. The
 * managed instance's own host serves the Loader snapshot, so the view needs no SSH exec and no
 * local manifest — the host fact rides the existing generic proxy.
 * The transport byte (URL join + envelope + POST + body collection, bounded unary 30s) rides the
 * shared kernel postUnary; the envelope/server-response classification stays local, while the
 * wrapWireError fold + 503 instance_unavailable classifier come from the shared wire-error module
 * (the shared kernel itself performs no classification).
 * Self-contained on purpose: the wire types below are structural mirrors of the rc.2 vendored
 * `@deepseek-ai/dsh-host-plugin-inventory` result type (its `src/types.ts`); no dsh package
 * import. Only the members this read-only view projects are declared: the Loader `entries`
 * (entryId / moduleName / enabled / fiberPhase). Host display metadata (`meta`),
 * `managementAvailable` and the per-agent-preset `agentPresets` compositions have no consumer in
 * this repo and are dropped at parse.
 */

import {
  isRecord, postUnary, throwIfInstanceUnavailable, wrapWireError,
  type UnaryPostOutcome,
} from '@dsh-chamber/dsh-chamber-client-core'

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

/** Point-in-time inventory returned by the plugin inventory Remote; only the Loader entries. */
export interface PluginInventorySnapshot {
  readonly entries: readonly PluginInventoryEntry[]
}

/** The Remote failure union's error member (bridge wire mirror). */
export interface PluginInventoryRpcFailure {
  code: string
  message: string
  details?: object
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

/** Validate the server-response envelope and project its `result` (mirror of the official parseConnectionResponse). */
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
    // `meta` / `managementAvailable` / `agentPresets` carry no consumer here and are not read:
    // projecting only `entries` keeps the snapshot = exactly what this view renders.
    return { ok: true, value: { entries: snapshot.entries.map(parseEntry) } }
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

/**
 * Read the managed instance's plugin inventory through the per-instance proxy. TRANSPORT
 * failures (network, non-2xx, the proxy's explicit `instance_unavailable` 503) and BUSINESS
 * failures both throw loud errors — never a silent empty list.
 * @param sourceId - the proxy source id (`dsh-<id>` / `gateway-<id>`).
 */
export async function loadPluginInventory(sourceId: string): Promise<PluginInventorySnapshot> {
  // Shared transport byte (postUnary): bounded unary on the official 30s budget — the proxy
  // forwards without an upstream timeout, so a silently hung host would otherwise leave the view
  // loading forever; fail loud instead. The bare crypto.randomUUID() rpcId stays inside this try.
  let outcome: UnaryPostOutcome
  try {
    outcome = await postUnary(`/api/i/${sourceId}`, 'pluginInventory/list', {}, {
      rpcId: crypto.randomUUID(),
    })
  } catch (error) {
    throw wrapWireError(error)
  }
  // 503 instance_unavailable (not-ready instance, proxy honesty): the shared classifier throws the byte-identical error.
  throwIfInstanceUnavailable(outcome)
  if (!outcome.ok) {
    throw wrapWireError(new Error(`HTTP ${outcome.status}`))
  }
  if (outcome.jsonError !== undefined) throw outcome.jsonError
  const result = parseRemoteResult(outcome.body)
  if (!result.ok) {
    throw new Error(`pluginInventory/list failed: ${result.error.code}: ${result.error.message}`)
  }
  return result.value
}
