/**
 * chamber per-boot instance knob (design 05 §4): shell.ts sets it while the
 * boot task owns `window.__DSH_BASE_PATH__`; the chamber sidebar plugin reads
 * it in apply() and highlights the current source.
 *
 * A dedicated module (not chamber-entry.ts) on purpose: chamber-entry's
 * top-level module-table handoff must run only when the boot kernel loads the
 * bundle — importing chamber-entry from the shell would pull that handoff
 * into the main chunk and execute it at page load, where
 * `window.__ModuleLoader__` is not installed yet. Both graphs import this
 * module instead; vite hoists it into a shared chunk, so the knob is a
 * runtime singleton (same pattern as chamberBridge, 05 §3).
 */

let chamberInstanceId: string | undefined

export function setChamberInstanceId(id: string | undefined): void {
  chamberInstanceId = id
}

export function getChamberInstanceId(): string | undefined {
  return chamberInstanceId
}
