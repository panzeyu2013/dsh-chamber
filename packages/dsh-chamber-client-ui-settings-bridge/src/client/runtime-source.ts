/**
 * Pure per-server runtime capability derivation (design 17 §2/§3,
 * design 18 §3.6). Capability comes from the explicitly projected target
 * kind AND transport — never from a source-id prefix heuristic.
 */

export type DshRuntimeSource = 'local' | 'gateway'

export interface RuntimeServerProjection {
  id: string
  /** Authoritative lifecycle proof for this exact registry incarnation. */
  sourceFingerprint: string
  kind: 'local' | 'dsh' | 'gateway'
  transport: 'local' | 'ssh' | 'http'
  /** Raw desktop registry id. Required for remote rows in the v2 producer. */
  rawId?: string
  /** Live dsh 实例版本 (0.1.2 起由运行时管理面提供;host.describe 已删); absent means honestly unknown. */
  dshVersion?: string
}

/**
 * Runtime section mounting matrix (design 18 §3.6; 2026-09 修订：dsh 直连不挂载):
 * a section exists exactly when a chamber dsh-runtime management surface is
 * reachable:
 * - local/local: complete local management (desktop main-process projection);
 * - gateway over either transport: complete proxied management
 *   (`/chamber/runtime` through the instance proxy);
 * - dsh over ssh or http: no section — the remote runtime is systemd-deployed
 *   (design 13/18 口径) and there is no `/chamber` channel, so no management
 *   surface exists.
 *
 * `null` is also the fail-closed result for malformed/impossible tuples; the
 * plugin factory distinguishes the intentional dsh no-mount tuples from
 * malformed input and throws for the latter.
 */
export function deriveRuntimeSource(server: RuntimeServerProjection | undefined): DshRuntimeSource | null {
  if (server === undefined) return null
  if (server.kind === 'local') {
    return server.id === 'local' && server.transport === 'local' ? 'local' : null
  }
  if (server.kind === 'gateway') {
    return server.transport === 'ssh' || server.transport === 'http' ? 'gateway' : null
  }
  return null
}

/**
 * The intentional `null` capabilities: any direct dsh target (ssh or http) —
 * no runtime management surface and no `/chamber` channel. A local/gateway
 * source with an impossible transport stays malformed and fails loud.
 */
export function runtimeSectionIntentionallyAbsent(server: RuntimeServerProjection): boolean {
  return server.kind === 'dsh'
}

/** Identity of every fact captured by the per-server runtime plugin props. */
export function runtimeServerProjectionKey(server: RuntimeServerProjection): string {
  return JSON.stringify({
    id: server.id,
    sourceFingerprint: server.sourceFingerprint,
    kind: server.kind,
    transport: server.transport,
    rawId: server.rawId ?? null,
    dshVersion: server.dshVersion ?? null,
  })
}
