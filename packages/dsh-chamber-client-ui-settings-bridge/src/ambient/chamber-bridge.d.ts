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

/** One server row as published by the renderer App layer (aligned with the
 *  REAL aggregate-store.ts ChamberServerAggregate — 2026 review T2: the old
 *  mirror carried a phantom `hint` and missed workspaces / aggregate / runtime). */
export interface ChamberServerAggregate {
  /** 'local' | 'ssh-<id>' */
  id: string
  kind: 'local' | 'ssh'
  label: string
  /** Local: dsh ready; remote: tunnel phase ready. */
  connected: boolean
  /** Status text (ready/connecting/… projection). */
  phase: string
  workspaces: Array<{
    id: string
    title: string
    /** True only for the synthetic trailing ungrouped bucket. */
    ungrouped?: boolean
    sessions: { id: string; title: string; running?: boolean; updatedAt?: number; blank?: boolean }[]
  }>
  /** True when the per-instance aggregate snapshot has actually landed. */
  aggregateReady?: boolean
  /** Snapshot-fetch error text from the last per-instance pull. */
  aggregateError?: string
  /** Runtime facts from the source's own ctx (design 06 §4). */
  runtime?: {
    current?: string
    sessions: Record<string, {
      running?: boolean
      completed?: boolean
      pending?: 'approval' | 'plan-review' | 'question'
      runningSubagents?: number
    }>
  }
  /** Renderer-local client-plugin boot health for this source. */
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
