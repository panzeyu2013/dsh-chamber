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
  /** Renderer-published settled-boot gap (design 05 §4 「降级呈现」):
   *  the connections card renders it, so it is MATERIAL to the roster signature.
   *  The type is the REAL one from the sidebar's shared contract (this package
   *  already imports that contract for the roster rows): a local re-declaration
   *  would be a third, lossy copy that only a new KIND could not slip past
   *  */
  bootGap?: ServerBootGap
}

// gapSignature is the client-core implementation (derive.ts), imported above:
// the bridge roster signature and the sidebar projection signature must be the
// same identity, so both use the one implementation.

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
