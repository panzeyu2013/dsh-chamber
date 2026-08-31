/**
 * Pure per-server runtime capability derivation (design 17 §2/§3,
 * design 18 §3.6). Capability comes from the explicitly projected target
 * kind AND transport — never from a source-id prefix heuristic.
 */

export type DshRuntimeSource = 'local' | 'gateway' | 'ssh'

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

const RAW_ID = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/

/**
 * Runtime section mounting matrix:
 * - local/local: complete local management;
 * - gateway over either transport: complete proxied management;
 * - dsh/ssh: read-only version + systemd restart;
 * - dsh/http: no section (no /chamber and no systemd channel).
 *
 * `null` is also the fail-closed result for malformed/impossible tuples; the
 * plugin factory distinguishes the intentional dsh/http no-mount tuple from
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
  if (server.kind === 'dsh') {
    if (server.transport === 'ssh') return 'ssh'
    if (server.transport === 'http') return null
  }
  return null
}

/** The one intentional `null` capability: a direct dsh HTTP target. */
export function runtimeSectionIntentionallyAbsent(server: RuntimeServerProjection): boolean {
  return server.kind === 'dsh' && server.transport === 'http'
}

/**
 * Resolve the desktop IPC host id for the dsh/ssh branch. Prefer the explicit
 * raw registry projection. The exact-prefix fallback only supports older
 * producers and handles canonical `dsh-` and legacy `ssh-` independently —
 * it never relies on their coincidentally equal prefix lengths.
 */
export function runtimeSshHostId(server: RuntimeServerProjection): string | null {
  if (server.kind !== 'dsh' || server.transport !== 'ssh') return null

  const fromSourceId = (): string | null => {
    let candidate: string | null = null
    if (server.id.startsWith('dsh-')) candidate = server.id.slice('dsh-'.length)
    else if (server.id.startsWith('ssh-')) candidate = server.id.slice('ssh-'.length)
    return candidate !== null && RAW_ID.test(candidate) ? candidate : null
  }

  if (server.rawId === undefined) return fromSourceId()
  if (!RAW_ID.test(server.rawId)) return null
  const parsed = fromSourceId()
  return parsed === server.rawId ? server.rawId : null
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
