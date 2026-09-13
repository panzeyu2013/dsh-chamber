import type { ServerBootGap } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

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
  /** Renderer-published settled-boot gap (2026-12, design 05 §4 「降级呈现」):
   *  the connections card renders it, so it is MATERIAL to the roster signature.
   *  The type is the REAL one from the sidebar's shared contract (this package
   *  already imports that contract for the roster rows): a local re-declaration
   *  would be a third, lossy copy that only a new KIND could not slip past
   *  (2026-12 review F1). */
  bootGap?: ServerBootGap
}

/**
 * Field-GENERIC identity of a settled-boot gap for publish signatures: every
 * payload field takes part (so a field added to the fact later cannot freeze a
 * subscription), fields are order-normalized, array order is preserved (roster
 * order is meaningful) — and "no payload" is one thing: an absent field, an
 * empty array, `null` and an empty string all encode to nothing, so a producer
 * that omits vs materializes an empty field cannot churn the gate. The
 * producer's sentence is not part of the projection at all.
 */
function gapSignature(gap: ServerBootGap | undefined): string | null {
  if (gap === undefined) return null
  const encode = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (Array.isArray(value)) return value.length === 0 ? null : `[${value.map(item => String(item)).join('\u0000')}]`
    return JSON.stringify(value)
  }
  return Object.entries(gap)
    .flatMap(([key, value]) => {
      const encoded = encode(value)
      return encoded === null ? [] : [`${key}=${encoded}`]
    })
    .sort()
    .join('\u0001')
}

/** Rendered settings-roster signature; excludes timestamp-only refreshes. */
export function serverProjectionSignature(rows: readonly ServerProjectionRow[]): string {
  // JSON avoids collisions from user-controlled labels and diagnostic text;
  // pluginId is rendered in the plugins section and is therefore material.
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
    // The gap is rendered on the connections card, so a gap-only flip must wake
    // this subscription — otherwise the card freezes on the previous mount's
    // verdict (e.g. it still says "受限" after the self-heal cleared the gap).
    // Encoded field-GENERICALLY (see gapSignature): a payload field added to the
    // fact later must take part without anyone remembering this line.
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
