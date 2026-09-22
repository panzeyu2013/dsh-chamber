/**
 * The sidebar's copy for one source's settled-boot gap (2026-12, design 05 §4
 * 「降级呈现」second batch).
 *
 * Kept OUT of `ServerSection.tsx` on purpose: the render file is JSX and cannot
 * be imported by the package's plain-node tests, so the decision (which
 * dictionary key, with which structured params) lives here and the JSX only maps
 * it into the source note line. Same split as `plugin-diagnostic.ts` in the
 * connections package.
 *
 * Boundary: the fact crosses the bridge STRUCTURED
 * (`ChamberServerAggregate.bootGap`: kind + ids) and this package writes its own
 * sentence from its own dictionary (`SidebarKey`) — the producer's diagnostic
 * text never arrives here (STATUS「跨边界诊断文案」).
 */

import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { bootGapShape } from '../shared/boot-gap-shape.ts'
import type { SidebarKey } from './locales.ts'

/** The dictionary lookup the renderer passes in (`t` from the package locale). */
type Translate = (key: SidebarKey, params?: Record<string, string | number>) => string

/**
 * The source row's gap sentence, or '' when this source reports no gap.
 *
 * Exhaustive by construction: the switch has no `default` and the declared
 * `string` return type makes the fall-through path unreachable-invalid, so a
 * future `ServerBootGapKind` is a COMPILE error here instead of silently
 * inheriting another kind's sentence. A kind whose structured payload is empty
 * (a hand-built or older-producer row) degrades to the generic sentence rather
 * than rendering "缺少  " / "0 个插件家族".
 * @param server - the projected source row.
 * @param t - this package's dictionary lookup.
 * @returns the sentence, already localized, or ''.
 */
export function sourceBootGapNote(server: ChamberServerAggregate, t: Translate): string {
  const gap = server.bootGap
  if (gap === undefined) return ''
  // Payload extraction is the shared projection (shared/boot-gap-shape.ts): the
  // exhaustiveness that used to live in this switch now lives there (a future
  // ServerBootGapKind is a compile error at the shared function), and this switch
  // maps the shape onto THIS package's keys.
  // 2026-12 FIX 6: the LOCAL instance's 404/method-missing is a chamber-side
  // installation/seed fact, so it gets its own sentence (no "upgrade that
  // source's runtime" advice — the copy boundary keeps that in the frame).
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
