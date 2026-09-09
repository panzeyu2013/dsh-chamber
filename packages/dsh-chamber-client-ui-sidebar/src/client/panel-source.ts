/**
 * Global main-panel projection for the sidebar (alpha.2 `sidebar.panellist`).
 *
 * The slot ledger is the authority: every list registration into
 * `sidebar.panellist` addresses the matching key of the layout's keyed `main`
 * slot. This module mirrors those registrations into a serializable snapshot
 * the shell renders — id, order, and the label resolved at read time (the
 * ledger stores label thunks, which follow the active locale) — and notifies
 * only when the projection actually changes.
 *
 * The shell keeps the button; selection goes through `ctx.layout.selectPanel`,
 * which the sidebar's inject face probes (a gateway-hosted instance runs the
 * official ui-layout, whose `ILayout` has no `selectPanel`).
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelMetadata } from './contract/slots.ts'

/** One ledger entry as this projection reads it (loose: the slots seam). */
interface StoredEntryLike {
  options: {
    id?: string
    order?: number
    label?: string | (() => string)
  }
}

/** The slice of the slots service this projection reads. */
export interface SlotsReader {
  entriesOfSlot(key: string): readonly StoredEntryLike[]
}

/** Projection handle: the observable source plus the re-sync entry point. */
export interface PanelSource {
  /** Snapshot + subscribe pair bound to the shell's `usePanels` hook. */
  readonly source: HostObservable<readonly SidebarPanelMetadata[]>
  /** Re-read the ledger (called on slot and locale changes). */
  sync(slots: SlotsReader): void
}

/** Resolve a possibly-thunked ledger label at read time. Inlined mirror of
 *  the vendor `resolveSlotLabel` (ui-slots): this package deliberately avoids a
 *  runtime value import of the slots package beyond what it already consumes,
 *  and the rule is a one-liner (`typeof === 'function' ? label() : label`). */
function labelOf(label: string | (() => string) | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

/**
 * Build the sidebar's global-panel projection. Entries without an id are
 * skipped (a list entry must name the main key it addresses); the label falls
 * back to the id so a row is never nameless.
 * @returns the projection handle.
 */
export function createPanelSource(): PanelSource {
  let current: readonly SidebarPanelMetadata[] = []
  const listeners = new Set<() => void>()

  const sync = (slots: SlotsReader): void => {
    const next = slots.entriesOfSlot('sidebar.panellist')
      .flatMap((entry): SidebarPanelMetadata[] => {
        const id = entry.options.id
        if (typeof id !== 'string' || id === '') return []
        return [{ id: id as MainPanelId, order: entry.options.order ?? 0, label: labelOf(entry.options.label) ?? id }]
      })
      .sort((a, b) => a.order - b.order)
    const previous = current
    if (previous.length === next.length && previous.every((panel, index) => {
      const candidate = next[index] as SidebarPanelMetadata
      return panel.id === candidate.id && panel.order === candidate.order && panel.label === candidate.label
    })) return
    current = next
    for (const listener of listeners) listener()
  }

  return {
    source: {
      getSnapshot: () => current,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    sync,
  }
}
