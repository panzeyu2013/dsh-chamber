/**
 * In-memory re-entry registry for the manual gateway chamber-plugin sync: the
 * desktop stores the last ready registration's sync parameters per gateway id —
 * transport origin, registration auth headers, SPKI pin — so a later manual
 * `gateway_plugin_sync(id)` replays that same sync; entries are cleared when
 * the instance leaves ready or is removed.
 *
 * Main-process-only material (headers may carry Authorization/Cookie): never
 * crosses IPC, never persisted, logged or serialized. The renderer supplies
 * nothing but the instance id. Pure Node — no Electron imports.
 */

export interface GatewaySyncRegistration {
  /** Registered transport origin (the ready URL). */
  url: string
  /** Registration auth headers (Authorization/Cookie) — main-process only;
   *  may be empty when a `--no-auth` deployment registers headerless. */
  headers: Record<string, string>
  /** Registered SPKI certificate pin; null = unpinned. */
  spkiPin: string | null
}

const registrations = new Map<string, GatewaySyncRegistration>()

/** Store (or, with null, clear) one instance's manual-sync parameters: called
 *  on every ready registration (overwrite) and on leave-ready / removal. */
export function setGatewaySyncRegistration(id: string, reg: GatewaySyncRegistration | null): void {
  if (reg === null) registrations.delete(id)
  else registrations.set(id, reg)
}

/** Stored manual-sync parameters of one instance, or undefined when it has no
 *  active ready registration. */
export function getGatewaySyncRegistration(id: string): GatewaySyncRegistration | undefined {
  return registrations.get(id)
}

/** Test hook: reset the module state. */
export function clearGatewaySyncRegistrations(): void {
  registrations.clear()
}
