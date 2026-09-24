/**
 * Settled-boot gap -> copy-shape projection. Both consuming packages (sidebar
 * `source.bootGap.*`, connections `bootGap*`) render from their own dictionaries
 * but share the payload extraction — which kind selects which key, which
 * structured params survive; each keeps only its key mapping and wording.
 *
 * Exhaustive by construction: no `default` and a closed return union, so a new
 * ServerBootGapKind is a COMPILE error instead of silently inheriting another
 * kind's shape; an empty structured payload degrades to 'generic' rather than
 * rendering "缺少  " / "0 个插件家族".
 */
import type { ServerBootGap } from './aggregate-store.ts'

/** The shape of the sentence one consumer must render for a settled-boot gap. */
export type BootGapShape =
  | { key: 'graph-unavailable' }
  | { key: 'local-graph-not-injected' }
  | { key: 'required-services-missing'; services: string }
  | { key: 'deferred-registration-failed'; failed: number }
  | { key: 'generic' }

/** Project a settled-boot gap (the cross-package contract) to its copy shape. */
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
