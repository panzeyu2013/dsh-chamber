import { gapSignature, type ServerBootGap } from '@dsh-chamber/dsh-chamber-client-core'

export interface ServerSelectorRow {
  id: string
  label: string
}

export interface ServerProjectionRow extends ServerSelectorRow {
  sourceFingerprint: string
  kind: 'local' | 'dsh' | 'gateway'
  transport: 'local' | 'ssh' | 'http'
  rawId?: string
  connected: boolean
  phase: string
  /** Gateway managed dsh terminal-down fact (render-relevant: copy branch). */
  managedRuntimeDown?: boolean
  dshVersion?: string
  /** Transport refresh stamp; deliberately excluded from the rendered signature. */
  updatedAt?: number
  pluginDiagnostic?: {
    state: string
    message?: string
    pluginId?: string
  }
  /** Renderer-published settled-boot gap: the connections card renders it, so it is
   *  MATERIAL to the roster signature. The type is the REAL one from the sidebar's
   *  shared contract (a local re-declaration would be a lossy third copy). */
  bootGap?: ServerBootGap
}

// gapSignature is the client-core implementation (derive.ts): the bridge roster
// signature and the sidebar projection signature must be the same identity.

/** Rendered settings-roster signature; excludes timestamp-only refreshes. */
export function serverProjectionSignature(rows: readonly ServerProjectionRow[]): string {
  // JSON avoids collisions from user-controlled labels; pluginId is rendered in the plugins section.
  return JSON.stringify(rows.map(row => ({
    id: row.id,
    sourceFingerprint: row.sourceFingerprint,
    kind: row.kind,
    transport: row.transport,
    rawId: row.rawId ?? null,
    label: row.label,
    connected: row.connected,
    phase: row.phase,
    managedRuntimeDown: row.managedRuntimeDown === true,
    dshVersion: row.dshVersion ?? null,
    pluginDiagnostic: row.pluginDiagnostic === undefined ? null : {
      state: row.pluginDiagnostic.state,
      message: row.pluginDiagnostic.message ?? null,
      pluginId: row.pluginDiagnostic.pluginId ?? null,
    },
    // The gap is rendered on the connections card, so a gap-only flip must wake this
    // subscription — otherwise the card freezes on the previous mount's verdict.
    // Encoded field-GENERICALLY (gapSignature): a payload field added later takes part
    // without anyone remembering this line.
    bootGap: gapSignature(row.bootGap),
  })))
}

/** Minimal ownership face for any source-bound settings child context. */
export interface SourceOwnedSession {
  sourceFingerprint: string
}

/** True only while the projected roster still owns this exact source incarnation. */
export function sourceFingerprintIsCurrent(
  rows: readonly Pick<ServerProjectionRow, 'id' | 'sourceFingerprint'>[],
  sourceId: string,
  sourceFingerprint: string,
): boolean {
  return rows.some(row => row.id === sourceId && row.sourceFingerprint === sourceFingerprint)
}

/** Cached child contexts whose source was deleted or replaced under the same id. */
export function staleOwnedSessionIds(
  sessions: Readonly<Record<string, SourceOwnedSession>>,
  rows: readonly Pick<ServerProjectionRow, 'id' | 'sourceFingerprint'>[],
): string[] {
  const currentOwners = new Map(rows.map(row => [row.id, row.sourceFingerprint]))
  return Object.entries(sessions)
    .filter(([sourceId, session]) => currentOwners.get(sourceId) !== session.sourceFingerprint)
    .map(([sourceId]) => sourceId)
}

export function filterServerRows<T extends ServerSelectorRow>(rows: readonly T[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized === '') return [...rows]
  return rows.filter(row => `${row.label}\n${row.id}`.toLocaleLowerCase().includes(normalized))
}

export function serverDropdownPlacement(
  rect: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  viewport: { width: number; height: number },
): { top: number; left: number; width: number; maxHeight: number } {
  const padding = 8
  const gap = 4
  // In small windows the popup must shrink with the viewport; a 280px minimum would move its right edge offscreen.
  const availableWidth = Math.max(0, viewport.width - padding * 2)
  const width = Math.min(420, Math.max(280, rect.width), availableWidth)
  const left = Math.max(padding, Math.min(rect.left, viewport.width - width - padding))
  const below = Math.max(0, viewport.height - rect.bottom - gap - padding)
  const above = Math.max(0, rect.top - gap - padding)
  const useBelow = below >= 220 || below >= above
  // Do not impose a minimum taller than the free space: a tiny/zoomed viewport should clip inside the popup.
  const maxHeight = Math.min(420, useBelow ? below : above)
  const top = useBelow ? rect.bottom + gap : Math.max(padding, rect.top - maxHeight - gap)
  return { top, left, width, maxHeight }
}
