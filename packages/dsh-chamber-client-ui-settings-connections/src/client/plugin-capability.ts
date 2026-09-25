/**
 * Official Plugins page capability probe (design 05 §5 + design 21 §6.2 注;
 * C 分层 2026-09 用户裁决).
 *
 * After the C-layering narrowing the chamber owns NO user-facing plugin
 * management: install / remove / enable / configure belong to the instance's
 * own official Plugins page (upstream `ui-plugin-manager` + `dsh-plugin-manager`,
 * composed into `dsh-web-app` since dsh 0.1.6-alpha.2). The chamber's plugin
 * area only shows the host packages it seeds.
 *
 * Whether that official page EXISTS in a given instance is a fact about the
 * instance's client boot graph, not about a version string: the page is
 * reachable exactly when the graph carries the
 * `@deepseek-ai/dsh-client-ui-plugin-manager` row. The graph is served INSIDE
 * the managed instance by the chamber seed host package, so the same
 * per-instance proxy the inventory read uses answers it
 * (`{origin}/api/i/<sourceId>/api/clientGraph/graph`, Remote
 * `clientGraph/graph`; empty `args`).
 *
 * Verdict discipline: the probe NEVER guesses. A transport failure, a
 * non-2xx answer, a malformed envelope or a graph whose `entries` is not an
 * array is `unknown` — the UI then says nothing rather than claiming the
 * instance cannot manage plugins. `unavailable` is reserved for a READABLE
 * graph that simply has no such row (a pre-alpha.2 runtime), which is the
 * case the capability gate exists for: the chamber shows the honest note and
 * still does NOT grow a second writer.
 *
 * No dsh package import: the wire shape is a structural mirror
 * (renderer/src/host-graph.ts parses the same envelope; this module only
 * needs `result.value.entries[].id`).
 */
import {
  isRecord, postUnary,
  type UnaryPostOutcome,
} from '@dsh-chamber/dsh-chamber-client-core'

/** The upstream row id that makes the instance's official Plugins page reachable. */
export const PLUGIN_MANAGER_ROW_ID = '@deepseek-ai/dsh-client-ui-plugin-manager'

/** Capability verdict of one instance. `unknown` is never a claim. */
export type OfficialPluginsPageCapability = 'available' | 'unavailable' | 'unknown'

/**
 * The control-plane proxy source id of one dialog target (the id the shell and
 * the generic proxy speak): `local` for the managed local instance, and
 * `<kind>-<id>` for every transport-backed instance (the same spelling the
 * connections section already builds for its gateway/http targets; `dsh-<id>`
 * is the canonical id of an ssh-transported dsh instance, with `ssh-<id>`
 * accepted by the proxy as its legacy spelling).
 */
export function officialPluginsPageSourceId(
  target:
    | { kind: 'local' }
    | { kind: 'ssh'; spec: { kind: string; id: string } }
    | { kind: 'gateway'; sourceId: string }
    | { kind: 'http'; sourceId: string },
): string {
  switch (target.kind) {
    case 'local':
      return 'local'
    case 'ssh':
      return target.spec.kind + '-' + target.spec.id
    case 'gateway':
    case 'http':
      return target.sourceId
  }
}

/**
 * Pure verdict from one `result.value` graph payload.
 * @param value - the Remote's `result.value` (expected `{ entries: [...] }`).
 * @returns `available` / `unavailable` / `unknown` (malformed never claims).
 */
export function capabilityFromGraph(value: unknown): OfficialPluginsPageCapability {
  if (!isRecord(value) || !Array.isArray(value.entries)) return 'unknown'
  for (const raw of value.entries) {
    if (!isRecord(raw)) return 'unknown'
    if (raw.id === PLUGIN_MANAGER_ROW_ID) return 'available'
  }
  return 'unavailable'
}

/**
 * 能力探针的重探触发键：source id + source phase（对话框里 = client-plugin runtime
 * 诊断的 state）。effect 直接依赖它而不是裸 sourceId —— 启动窗口里相态会从
 * undefined/'not-injected' 走到 'ok'（实例已 serving），正是能力门必须重探的时刻；
 * 只依赖 sourceId 会让判词在该窗口内永久停在 unknown（升级计划 §22.4.3）。
 * @param sourceId - 控制面代理 source id（{@link officialPluginsPageSourceId}）。
 * @param sourcePhase - 该 source 的相态；undefined = 尚无相态。
 * @returns 相态变化即变化、其余不变的不透明键。
 */
export function capabilityProbeKey(sourceId: string, sourcePhase: string | undefined): string {
  return sourceId + '|' + (sourcePhase === undefined || sourcePhase === '' ? 'unknown' : sourcePhase)
}

/** Test seams for the transport (production passes neither). */
export interface OfficialPluginsCapabilityDeps {
  fetchImpl?: typeof fetch
  origin?: string
}

/**
 * Probe one instance's client boot graph for the official Plugins row.
 * @param sourceId - control-plane proxy source id (see {@link officialPluginsPageSourceId}).
 * @param deps - test seams only.
 * @returns the verdict; every unreadable path is `unknown`.
 */
export async function probeOfficialPluginsPage(
  sourceId: string,
  deps: OfficialPluginsCapabilityDeps = {},
): Promise<OfficialPluginsPageCapability> {
  let outcome: UnaryPostOutcome
  try {
    outcome = await postUnary(`/api/i/${sourceId}`, 'clientGraph/graph', {}, {
      fetchImpl: deps.fetchImpl,
      origin: deps.origin,
    })
  } catch {
    return 'unknown'
  }
  if (!outcome.ok || outcome.jsonError !== undefined) return 'unknown'
  const envelope = outcome.body
  if (!isRecord(envelope) || !isRecord(envelope.result)) return 'unknown'
  if (envelope.result.ok !== true) return 'unknown'
  return capabilityFromGraph(envelope.result.value)
}
