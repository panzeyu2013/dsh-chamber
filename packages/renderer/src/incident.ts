/**
 * The renderer's resident incident instrument + injection harness (P1).
 *
 * ONE place every shell's evidence lands (ELECTRON/MAIN and Swift evidence arrive
 * through the same page globals) and ONE place an acceptance driver arms the
 * cross-shell faults. Both globals are function views over live objects, so CDP
 * or an acceptance script reads/arms them without a periodic object.
 */
import {
  IncidentInstrument,
  createInjectionHarness,
  installIncidentInstrument,
  installInjectionHarness,
  type IncidentDraft,
} from '@dsh-chamber/dsh-stream-state'

export const incidentInstrument = new IncidentInstrument()
installIncidentInstrument(globalThis, incidentInstrument)

/** Record one bounded incident entry (never throws; sanitization is in the ring). */
export function recordIncident(draft: IncidentDraft): void {
  try {
    incidentInstrument.record(draft)
  } catch { /* the instrument must never break the path it observes */ }
}

export const injectionHarness = createInjectionHarness()
installInjectionHarness(globalThis, injectionHarness)
