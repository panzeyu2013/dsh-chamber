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
 * The shell keeps the button; selection goes through `ctx.layout.selectPanel`
 * directly (both the chamber layout fork and the alpha.2 official ui-layout
 * declare it, so a missing method is a misconfiguration that must fail loud
 * instead of silently dropping the click).
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// 2026-09-11 upstream-alignment A5: the observable plumbing is the store
// engine's, not hand-rolled — upstream builds this exact projection with
// `createSnapshotStore`
// (vendor/harness-checkout/packages/client/store/src/index.ts:103, and its own
// use of it at
// vendor/harness-checkout/packages/client/ui-sidebar/src/client/index.ts:3,46),
// and the composite bundle compiles that factory for this package (the renderer
// aliases @deepseek-ai/* to vendor source; `instance-list-face.ts` already
// type-imports the same module).
// 2026-09-11 review-fix (stale-path sweep): the citations used to give the bare
// upstream-monorepo layout with only a "vendor" prefix, which resolves to
// nothing from this repo root; both facts and both line numbers were
// re-verified against the pinned checkout and are unchanged.
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
 *  and the rule is a one-liner (`typeof === 'function' ? label() : label`).
 *  2026-09-11 upstream-alignment A2: audit recommendation is KEEP with this
 *  reason (the vite-composited bundle inlines value imports, and the slots
 *  package is the renderer's seam, not this shell's). */
function labelOf(label: string | (() => string) | undefined): string | undefined {
  return typeof label === 'function' ? label() : label
}

/**
 * Build the sidebar's global-panel projection. Entries without an id are
 * skipped (a list entry must name the main key it addresses); the label falls
 * back to the id so a row is never nameless.
 *
 * 2026-09-11 upstream-alignment A5: the snapshot/subscribe plumbing is the dsh
 * store engine's `createSnapshotStore` — the same construction upstream's
 * ui-sidebar uses (vendor ui-sidebar/src/client/index.ts:46). Only the chamber
 * projection inside `sync` is this package's (the id filter + label fallback +
 * order sort), and the notify-only-on-change rule stays OURS: `set` is called
 * only after the shallow row comparison below, so React sees exactly the array
 * identity behaviour it saw before (`set` with a plain array — never `update`,
 * whose immer draft + dev freeze would change what React observes).
 * @returns the projection handle.
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
