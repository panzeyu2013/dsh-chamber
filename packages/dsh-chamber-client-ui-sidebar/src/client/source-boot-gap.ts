/**
 * Sidebar copy for one source's settled-boot gap: the fact crosses the bridge
 * STRUCTURED (`ChamberServerAggregate.bootGap`: kind + ids) and this package writes
 * its own sentence from its own dictionary (`SidebarKey`) — the producer's diagnostic
 * text never arrives here. Kept out of `ServerSection.tsx` so the decision stays importable without JSX.
 */

import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { bootGapShape } from '@dsh-chamber/dsh-chamber-client-core/boot-gap-shape'
import type { SidebarKey } from './locales.ts'

/** The dictionary lookup the renderer passes in (`t` from the package locale). */
type Translate = (key: SidebarKey, params?: Record<string, string | number>) => string

/**
 * The source row's gap sentence, or '' when this source reports no gap.
 * Exhaustive by construction: the switch has no `default`, so a future
 * `ServerBootGapKind` is a COMPILE error here instead of silently inheriting
 * another kind's sentence. A kind whose structured payload is empty (a hand-built
 * or older-producer row) degrades to the generic sentence rather than rendering "缺少  ".
 */
export function sourceBootGapNote(server: ChamberServerAggregate, t: Translate): string {
  const gap = server.bootGap
  if (gap === undefined) return ''
  // Payload extraction is the shared projection (shared/boot-gap-shape.ts); this
  // switch maps the shape onto THIS package's keys. The LOCAL instance's 404/method-
  // missing is a chamber-side installation/seed fact, so it gets its own sentence.
  const shape = bootGapShape(gap)
  switch (shape.key) {
    case 'graph-unavailable':
      return t('source.bootGap.graphUnavailable')
    case 'local-graph-not-injected':
      return t('source.bootGap.localGraphNotInjected')
    case 'required-services-missing':
      return t('source.bootGap.requiredServicesMissing', { services: shape.services })
    case 'deferred-registration-failed':
      return t('source.bootGap.deferredRegistrationFailed', { n: shape.failed })
    case 'generic':
      return t('source.bootGap.generic')
  }
}
