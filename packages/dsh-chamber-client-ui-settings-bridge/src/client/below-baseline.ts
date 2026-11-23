/**
 * Design 18 §3.4 compatibility-floor copy at the version picker: the selected
 * version's below-baseline sentence. A CSS-free leaf (imports only the client-core
 * pure helper + types) so node tests exercise the projection without a DOM/CSS
 * loader — the boot gate itself stays the first-screen fatal overlay; this is the
 * warning the picker owes before the switch.
 */
import { selectedBelowBaselineVersion, type RuntimeVersionEntry } from '@dsh-chamber/dsh-chamber-client-core/runtime-management'
import type { RuntimeTranslate } from './runtime-display.ts'

/** The selected version's below-baseline warning sentence, or null when the
 *  selection is not below the compatibility baseline (or is unknown). */
export function selectedBelowBaselineNotice(
  versions: readonly Pick<RuntimeVersionEntry, 'version' | 'belowBaseline'>[],
  selected: string | null,
  t: RuntimeTranslate,
): string | null {
  const version = selectedBelowBaselineVersion(versions, selected)
  return version === null ? null : t('dshRuntimeBelowBaselineHint', { version })
}
