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
  /** 'local' | '<target-kind>-<id>' (`ssh-` remains a legacy dsh id). */
  id: string
  /** Opaque authoritative lifecycle proof for this exact source incarnation. */
  sourceFingerprint: string
  kind: 'local' | 'dsh' | 'gateway'
  transport: 'local' | 'ssh' | 'http'
  rawId?: string
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
  /** Live dsh version (0.1.2: host.describe was deleted; the local instance
   *  version comes from the desktop bridge, remote stays hidden). */
  dshVersion?: string
  /** Renderer-local client-plugin boot health for this source. */
  pluginDiagnostic?: {
    state: PluginGraphDiagnosticState
    message?: string
    pluginId?: string
    updatedAt: number
  }
  updatedAt: number
}

/** One source's client-plugin runtime-loading outcome (design 09 §3.5) —
 *  mirror of the REAL PluginGraphDiagnosticState (aggregate-store.ts). */
export type PluginGraphDiagnosticState =
  | 'ok'
  | 'not-injected'
  | 'graph-unreachable'
  | 'bundle-load-failed'
  | 'restart-required'
  | 'instance-version-conflict'

/** Outcome of one host-graph channel recheck (design 09 §3.5 recheck
 *  contract) — mirror of the REAL PluginGraphRecheckOutcome
 *  (plugin-graph-recheck.ts). */
export type PluginGraphRecheckOutcome =
  | 'reported-ok'
  | 'reported-not-injected'
  | 'reported-graph-unreachable'
  | 'unchanged'
  | 'skipped'

/** True for the diagnostics that describe the host-graph CHANNEL at the last
 *  shell boot (self-heal candidates) — never for boot-fact classes. Mirror of
 *  the REAL isChannelClassDiagnostic (plugin-graph-recheck.ts). */
export function isChannelClassDiagnostic(state: PluginGraphDiagnosticState | undefined): boolean

/** Re-check one source's host boot-graph channel and write the verdict back
 *  through chamberBridge when the verdict STATE differs from the recorded
 *  diagnostic. Mirror of the REAL recheckPluginGraphDiagnostic
 *  (plugin-graph-recheck.ts) — this ambient face is a COMPATIBLE SUBSET of
 *  the real signature `(sourceId, deps?: PluginGraphRecheckDeps)`; a real
 *  signature change would not surface as a settings-bridge type error. */
export function recheckPluginGraphDiagnostic(sourceId: string): Promise<PluginGraphRecheckOutcome>

/** The renderer-shared chamberBridge singleton (non-authoritative projection). */
export const chamberBridge: {
  getServers(): ChamberServerAggregate[]
  subscribe(listener: () => void): () => void
} = undefined as never
