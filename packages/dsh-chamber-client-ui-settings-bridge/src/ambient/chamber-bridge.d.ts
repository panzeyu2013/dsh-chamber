/**
 * Local declaration for the chamberBridge shared face
 * (packages/dsh-client-ui-sidebar/src/shared): the renderer-published
 * multi-source projection (design 05 §3). This package resolves the specifier
 * to THIS file via tsconfig paths — the sidebar package's own sources are
 * never compiled here; at runtime vite's shared chunk keeps one instance.
 *
 * MIRROR WARNING: keep in sync with the REAL ChamberServerAggregate /
 * chamberBridge members (aggregate-store.ts) — this package reads roster
 * identity/connectivity plus the client-plugin diagnostic projection.
 */

/** One server row as published by the renderer App layer. */
export interface ChamberServerAggregate {
  /** 'local' | 'ssh-<id>' */
  id: string
  kind: 'local' | 'ssh'
  label: string
  /** Local: dsh ready; remote: tunnel phase ready. */
  connected: boolean
  /** Status text (ready/connecting/… projection). */
  phase: string
  hint?: string
  pluginDiagnostic?: {
    state: 'ok' | 'not-injected' | 'graph-unreachable' | 'bundle-load-failed' | 'restart-required'
    message?: string
    pluginId?: string
    updatedAt: number
  }
  updatedAt: number
}

/** The renderer-shared chamberBridge singleton (non-authoritative projection). */
export const chamberBridge: {
  getServers(): ChamberServerAggregate[]
  subscribe(listener: () => void): () => void
} = undefined as never
