/**
 * window.dshChamber.settings — the chamber-global settings surface consumed
 * by the settings shell's「通用」section (desktop preload.cts, design 14 D7).
 * Non-secret projections only: settings values + platform capability gates.
 *
 * Type source: packages/renderer/src/global.d.ts is the authoritative
 * full-shape declaration of window.dshChamber (interface merging requires
 * IDENTICAL property types, so a partial/subset declaration could never
 * merge with it). The settings types are re-exported from that file, and the
 * Window property is declared with the FULL imported DshChamberBridge type —
 * identical to the renderer's own declaration, never a subset.
 */
import type {
  ChamberSettings,
  ChamberSettingsStatus,
  DshChamberBridge,
  NotificationRequest,
  NotificationSurface,
  SettingsSurface,
} from '../../../../packages/renderer/src/global.d.ts'

export type {
  ChamberSettings,
  ChamberSettingsStatus,
  NotificationRequest,
  NotificationSurface,
  SettingsSurface,
}

declare global {
  interface Window {
    dshChamber?: DshChamberBridge
  }
}

export {}
