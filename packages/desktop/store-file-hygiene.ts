/**
 * Shared startup-file hygiene for the main-process owner-only JSON stores (ssh
 * password mirror, gateway secrets mirror, chamber settings, ssh plugin journal).
 * Pure Node — no Electron import. Shared instead of duplicated per store; each
 * helper owns its contract: corrupt-aside preserve, unbound-legacy preserve under
 * unique `.unbound-<ts>-<pid>` recovery naming, and the legacy FIXED-`.tmp`
 * crash-residue sweep.
 */

import { existsSync, renameSync, rmSync } from 'node:fs'

/** Plain-object guard shared by the store validators. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * THE rename-aside primitive: one try/rename over the target file, returning
 * the actual aside path or the failure text; every corrupt/legacy preserve path
 * (credential mirrors, chamber settings, plugin journal) builds on this.
 */
export function preserveFileAside(file: string, suffix: string): { ok: true; path: string } | { ok: false; error: string } {
  const aside = `${file}${suffix}`
  try {
    renameSync(file, aside)
    return { ok: true, path: aside }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * Preserve an INVALID/UNREADABLE store file as `<file>.corrupt` (renamed aside —
 * reversible evidence, never silently treated as empty) and return the loud
 * notice naming `invalidFile` — the only per-store variance.
 */
export function preserveInvalidCredentialFile(file: string, invalidFile: string): string {
  const result = preserveFileAside(file, '.corrupt')
  return result.ok
    ? `invalid ${invalidFile} preserved at ${result.path}`
    : `invalid ${invalidFile} at ${file}; preserve failed: ${result.error}`
}

/** Store-specific wording of an unbound-legacy preserve notice — the ONLY
 *  per-store variance (unique-name loop, rename and message shapes are shared). */
export interface UnboundCredentialFileWording {
  subject: string
  hasVerb: string
  disabledAuxiliary: string
  preservedAuxiliary: string
  bindingsNoun: string
  reentryNoun: string
}

/**
 * Preserve a non-empty LEGACY (unbound) store file under a unique
 * `.unbound-<ts>-<pid>` recovery name (a `-<n>` suffix disambiguates a same-ms
 * collision) and return the loud notice; on rename failure the store stays in
 * place, disabled, with the failure reported.
 */
export function preserveUnboundCredentialFile(file: string, wording: UnboundCredentialFileWording): string {
  const stem = `${file}.unbound-${Date.now()}-${process.pid}`
  let unboundPath = stem
  for (let index = 1; existsSync(unboundPath); index += 1) unboundPath = `${stem}-${index}`
  const result = preserveFileAside(file, unboundPath.slice(file.length))
  return result.ok
    ? `${wording.subject} ${wording.hasVerb} no ${wording.bindingsNoun} and ${wording.preservedAuxiliary} preserved at ${result.path}; re-enter ${wording.reentryNoun} to use them`
    : `${wording.subject} at ${file} ${wording.hasVerb} no ${wording.bindingsNoun} and ${wording.disabledAuxiliary} disabled; preserve failed: ${result.error}`
}

/**
 * One-time crash-residue sweep: the legacy fixed-name `${file}.tmp` persist
 * (open 'w' + rename) can leave that exact-name 0600 residue behind after a
 * hard crash between the two steps; the atomic replace uses a random O_EXCL
 * temp and never reuses that legacy name. Best-effort only: `force` swallows
 * ENOENT and any other failure (permissions…) must not break store configuration.
 */
export function removeLegacyTmpResidue(file: string): void {
  try { rmSync(`${file}.tmp`, { force: true }) } catch { /* best-effort hygiene only */ }
}
