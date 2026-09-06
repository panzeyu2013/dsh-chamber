/**
 * Shared startup-file hygiene for the main-process owner-only JSON stores —
 * the ssh password mirror (`<userData>/ssh-passwords.json`, design 05 §8),
 * the gateway secrets mirror (`<userData>/gateway-secrets.json`, design 17
 * §12), the chamber settings file (design 14 D7) and the ssh plugin journal
 * (design 21 §6.8). Pure Node — no Electron import. The mechanics were
 * previously duplicated verbatim inside each store module; each helper below
 * documents its own contract (corrupt-aside preserve, unbound-legacy
 * preserve with unique `.unbound-<ts>-<pid>` recovery naming, and the legacy
 * FIXED-`.tmp` crash-residue sweep).
 */

import { existsSync, renameSync, rmSync } from 'node:fs'

/** Plain-object guard shared by the store validators. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Preserve an INVALID/UNREADABLE store file as `<file>.corrupt` (renamed
 * aside — reversible evidence, never silently treated as empty) and return
 * the loud notice string. `invalidFile` names the file in the notice
 * ('password file', 'gateway secrets file') — the only per-store variance.
 */
export function preserveInvalidCredentialFile(file: string, invalidFile: string): string {
  const corruptPath = `${file}.corrupt`
  try {
    renameSync(file, corruptPath)
    return `invalid ${invalidFile} preserved at ${corruptPath}`
  } catch (error) {
    return `invalid ${invalidFile} at ${file}; preserve failed: ${String(error)}`
  }
}

/** Store-specific wording of an unbound-legacy preserve notice — the ONLY
 *  per-store variance (each mirror's legacy sentences differ in noun phrases
 *  and verb agreement; the unique-name loop, the rename and the message
 *  shapes are shared below). */
export interface UnboundCredentialFileWording {
  /** Sentence subject naming the legacy store, e.g. 'legacy SSH password
   *  file' / 'legacy gateway secrets'. */
  subject: string
  /** Agreement verb, e.g. 'has' / 'have'. */
  hasVerb: string
  /** Disabled-state auxiliary, e.g. 'is' / 'are'. */
  disabledAuxiliary: string
  /** Preserved-state auxiliary, e.g. 'was' / 'were'. */
  preservedAuxiliary: string
  /** The binding kind the legacy values lack, e.g. 'endpoint bindings' /
   *  'target bindings'. */
  bindingsNoun: string
  /** Re-entry hint noun, e.g. 'passwords' / 'credentials'. */
  reentryNoun: string
}

/**
 * Preserve a non-empty LEGACY (unbound) store file under a unique
 * `.unbound-<ts>-<pid>` recovery name (a `-<n>` suffix disambiguates a
 * same-ms collision) and return the loud notice string; on rename failure
 * the store stays in place, disabled, with the failure reported. The store
 * passes its own `wording` only — everything else is shared.
 */
export function preserveUnboundCredentialFile(file: string, wording: UnboundCredentialFileWording): string {
  const stem = `${file}.unbound-${Date.now()}-${process.pid}`
  let unboundPath = stem
  for (let index = 1; existsSync(unboundPath); index += 1) unboundPath = `${stem}-${index}`
  try {
    renameSync(file, unboundPath)
    return `${wording.subject} ${wording.hasVerb} no ${wording.bindingsNoun} and ${wording.preservedAuxiliary} preserved at ${unboundPath}; re-enter ${wording.reentryNoun} to use them`
  } catch (error) {
    return `${wording.subject} at ${file} ${wording.hasVerb} no ${wording.bindingsNoun} and ${wording.disabledAuxiliary} disabled; preserve failed: ${String(error)}`
  }
}

/**
 * One-time crash-residue sweep (2a follow-up): the pre-2a persist wrote a
 * FIXED `${file}.tmp` (open 'w' + rename), and a hard crash between the two
 * left that exact-name 0600 residue. The atomic replace since 2a uses a
 * random O_EXCL temp and never reuses or removes that legacy name — sweep
 * it once when the store is configured/loaded. Best-effort only: `force`
 * already swallows ENOENT, and any other failure (permissions…) must not
 * break store configuration, so the remainder is swallowed too.
 */
export function removeLegacyTmpResidue(file: string): void {
  try { rmSync(`${file}.tmp`, { force: true }) } catch { /* best-effort hygiene only */ }
}
