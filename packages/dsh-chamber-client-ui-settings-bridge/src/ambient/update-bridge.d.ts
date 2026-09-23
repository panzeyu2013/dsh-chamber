/**
 * window.dshChamber.update — the desktop update surface consumed by the
 * settings shell's「更新」section (desktop preload.cts, design 11).
 * Non-secret projections only: versions, channel, a release-page URL, a
 * short error text.
 *
 * Type source: @dsh-chamber/renderer/global.d.ts (the renderer package's
 * single declared face) is the authoritative full-shape declaration of
 * window.dshChamber (interface merging requires IDENTICAL property types, so a
 * partial/subset declaration could never merge with it). The update types are
 * re-exported from that face.
 */
import type { DshChamberBridge, UpdatePhase, UpdateState, UpdateSurface } from '@dsh-chamber/renderer/global.d.ts'

export type { UpdatePhase, UpdateState, UpdateSurface }

declare global {
  interface Window {
    dshChamber?: DshChamberBridge
  }
}

export {}
