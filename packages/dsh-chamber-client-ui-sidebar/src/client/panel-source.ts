/**
 * Global main-panel projection for the sidebar (`sidebar.panellist`). The slot
 * ledger is the authority: each list registration addresses the matching key
 * of the layout's keyed `main` slot. This module mirrors registrations into a
 * serializable snapshot the shell renders — id, order, and the label resolved
 * at read time (the ledger stores label thunks, which follow the active
 * locale) — and notifies only when the projection actually changes. Selection
 * goes through `ctx.layout.selectPanel` directly; a missing method is a
 * misconfiguration that must fail loud instead of silently dropping the click.
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// 复用 dsh store 引擎的 createSnapshotStore（上游 ui-sidebar 同款构造，由
// 复合 bundle 编译进本包）。
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SidebarPanelMetadata } from './contract/slots.ts'

/** One ledger entry as this projection reads it (loose: the slots seam). */
interface StoredEntryLike {
  options: {
    id?: string
    order?: number
    label?: string | (() => string)
  }
}

export interface SlotsReader {
  entriesOfSlot(key: string): readonly StoredEntryLike[]
}

export interface PanelSource {
  /** Snapshot + subscribe pair bound to the shell's `usePanels` hook. */
  readonly source: HostObservable<readonly SidebarPanelMetadata[]>
  /** Re-read the ledger (called on slot and locale changes). */
  sync(slots: SlotsReader): void
}

/** Resolve a possibly-thunked ledger label at read time — inlined mirror of
 *  the vendor `resolveSlotLabel` (ui-slots); this package avoids a runtime
 *  value import of the slots package. */
function labelOf(label: string | (() => string) | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

/**
 * Build the sidebar's global-panel projection. Entries without an id are
 * skipped (a list entry must name the main key it addresses); the label falls
 * back to the id so a row is never nameless. Notify-only-on-change is OURS:
 * `set` runs only after the shallow row comparison, and always with a plain
 * array — never `update`, whose immer draft + dev freeze would change what
 * React observes.
 */
export function createPanelSource(): PanelSource {
  const panels = createSnapshotStore<readonly SidebarPanelMetadata[]>([])

  const sync = (slots: SlotsReader): void => {
    const next = slots.entriesOfSlot('sidebar.panellist')
      .flatMap((entry): SidebarPanelMetadata[] => {
        const id = entry.options.id
        if (typeof id !== 'string' || id === '') return []
        return [{ id: id as MainPanelId, order: entry.options.order ?? 0, label: labelOf(entry.options.label) ?? id }]
      })
      .sort((a, b) => a.order - b.order)
    const previous = panels.getSnapshot()
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index] as SidebarPanelMetadata
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
    })) return
    panels.set(next)
  }

  return { source: panels, sync }
}
