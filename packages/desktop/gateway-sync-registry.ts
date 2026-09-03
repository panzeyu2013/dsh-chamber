/**
 * Manual gateway chamber-plugin sync re-entry registry (design 21 §6.5,
 * Phase 3b): the desktop syncs the chamber host packages into the gateway
 * seed cache automatically after every gateway ready registration. A later,
 * manual `gateway_plugin_sync(id)` re-runs that same sync, so this module
 * retains the LAST ready-registration sync parameters per gateway instance
 * id — the registered transport origin, the registration auth headers and
 * the SPKI pin — purely in memory.
 *
 * These parameters are main-process-only material (headers may carry
 * Authorization/Cookie values): they never cross IPC, are never persisted,
 * logged or serialized, and are cleared when the instance leaves ready or
 * is removed. The renderer supplies nothing but the instance id.
 *
 * Pure Node — no Electron imports (unit-testable standalone).
 */

export interface GatewaySyncRegistration {
  /** Registered transport origin (the ready URL). */
  url: string
  /** Registration auth headers (Authorization/Cookie) — main-process only.
   *  May be empty: a `--no-auth` deployment registers headerless. */
  headers: Record<string, string>
  /** Registered SPKI certificate pin; null = unpinned. */
  spkiPin: string | null
}

const registrations = new Map<string, GatewaySyncRegistration>()

/** Store (or, with null, clear) the manual-sync re-entry parameters of one
 *  gateway instance: called on every ready registration (overwrite) and
 *  whenever the instance leaves ready / is removed (clear). */
export function setGatewaySyncRegistration(id: string, reg: GatewaySyncRegistration | null): void {
  if (reg === null) registrations.delete(id)
  else registrations.set(id, reg)
}

/** The stored manual-sync re-entry parameters of one gateway instance, or
 *  undefined when it has no active ready registration. */
export function getGatewaySyncRegistration(id: string): GatewaySyncRegistration | undefined {
  return registrations.get(id)
}

/** Test hook: reset the module state. */
export function clearGatewaySyncRegistrations(): void {
  registrations.clear()
}
