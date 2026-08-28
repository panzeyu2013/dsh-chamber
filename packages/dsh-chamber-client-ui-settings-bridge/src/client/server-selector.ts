export interface ServerSelectorRow {
  id: string
  label: string
}

export interface ServerProjectionRow extends ServerSelectorRow {
  sourceFingerprint: string
  kind: 'local' | 'ssh'
  connected: boolean
  phase: string
  /** Transport refresh stamp; deliberately excluded from the rendered signature. */
  updatedAt?: number
  pluginDiagnostic?: {
    state: string
    message?: string
    pluginId?: string
  }
}

/** Rendered settings-roster signature; excludes timestamp-only refreshes. */
export function serverProjectionSignature(rows: readonly ServerProjectionRow[]): string {
  // JSON avoids collisions from user-controlled labels and diagnostic text;
  // pluginId is rendered in the plugins section and is therefore material.
  return JSON.stringify(rows.map(row => ({
    id: row.id,
    sourceFingerprint: row.sourceFingerprint,
    kind: row.kind,
    label: row.label,
    connected: row.connected,
    phase: row.phase,
    pluginDiagnostic: row.pluginDiagnostic === undefined ? null : {
      state: row.pluginDiagnostic.state,
      message: row.pluginDiagnostic.message ?? null,
      pluginId: row.pluginDiagnostic.pluginId ?? null,
    },
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
  // In unusually small windows the popup must shrink with the viewport;
  // enforcing the desktop 280px minimum would move its right edge offscreen.
  const availableWidth = Math.max(0, viewport.width - padding * 2)
  const width = Math.min(420, Math.max(280, rect.width), availableWidth)
  const left = Math.max(padding, Math.min(rect.left, viewport.width - width - padding))
  const below = Math.max(0, viewport.height - rect.bottom - gap - padding)
  const above = Math.max(0, rect.top - gap - padding)
  const useBelow = below >= 220 || below >= above
  // Do not impose a minimum taller than the actual free space: a tiny or
  // zoomed viewport should clip inside the popup, not outside the viewport.
  const maxHeight = Math.min(420, useBelow ? below : above)
  const top = useBelow ? rect.bottom + gap : Math.max(padding, rect.top - maxHeight - gap)
  return { top, left, width, maxHeight }
}
