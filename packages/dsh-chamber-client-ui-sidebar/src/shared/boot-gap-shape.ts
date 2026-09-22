/**
 * Settled-boot gap -> copy-shape projection (2026-12 single-sourcing pass).
 *
 * Two client packages render a sentence for the same structured fact from their
 * own dictionaries: the sidebar (src/client/source-boot-gap.ts, `source.bootGap.*`)
 * and the connections section (plugin-diagnostic.ts, `bootGap*`). Both carried
 * the same payload extraction — which kind selects which key, and which
 * structured params survive — so the extraction lives here and each package
 * keeps only its key mapping (the namespace/wording split is deliberate,
 * design 05 §5).
 *
 * Exhaustive by construction: no `default` and a closed return union, so a future
 * ServerBootGapKind is a COMPILE error here instead of silently inheriting
 * another kind's shape. A kind whose structured payload is empty (a hand-built
 * or older-producer row) degrades to 'generic' rather than rendering
 * "缺少  " / "0 个插件家族".
 */
import type { ServerBootGap } from './aggregate-store.ts'

/** The shape of the sentence one consumer must render for a settled-boot gap. */
export type BootGapShape =
  | { key: 'graph-unavailable' }
  | { key: 'local-graph-not-injected' }
  | { key: 'required-services-missing'; services: string }
  | { key: 'deferred-registration-failed'; failed: number }
  | { key: 'generic' }

/**
 * Project a settled-boot gap to its copy shape.
 * @param gap - the structured gap fact (cross-package contract).
 * @returns the discriminant plus the params the sentence interpolates.
 */
export function bootGapShape(gap: ServerBootGap): BootGapShape {
  switch (gap.kind) {
    case 'graph-unavailable':
      return { key: 'graph-unavailable' }
    case 'local-graph-not-injected':
      return { key: 'local-graph-not-injected' }
    case 'required-services-missing': {
      const services = gap.services ?? []
      return services.length === 0
        ? { key: 'generic' }
        : { key: 'required-services-missing', services: services.join(', ') }
    }
    case 'deferred-registration-failed': {
      const failed = (gap.failedIds ?? []).length
      return failed === 0
        ? { key: 'generic' }
        : { key: 'deferred-registration-failed', failed }
    }
  }
}
