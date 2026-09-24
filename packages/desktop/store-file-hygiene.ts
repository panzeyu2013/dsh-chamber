/**
 * Shared startup-file hygiene for the main-process owner-only JSON stores —
 * the ssh password mirror (`<userData>/ssh-passwords.json`, design 05 §8),
 * the gateway secrets mirror (`<userData>/gateway-secrets.json`, design 17
 * §12), the chamber settings file (design 14 D7) and the ssh plugin journal
 * (design 21 §6.8). Pure Node — no Electron import. The mechanics are
 * shared here instead of duplicated inside each store module; each helper
 * documents its own contract (corrupt-aside preserve and the legacy
 * FIXED-`.tmp` crash-residue sweep).
 */

import { renameSync, rmSync } from 'node:fs'

/** Plain-object guard shared by the store validators. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * THE rename-aside primitive: one try/rename over the target file, returning
 * the actual aside path or the failure text.
 * Every corrupt/legacy preserve path (credential mirrors, chamber settings,
 * ssh plugin journal) builds on this instead of hand-writing the rename.
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
 * Preserve an INVALID/UNREADABLE store file as `<file>.corrupt` (renamed
 * aside — reversible evidence, never silently treated as empty) and return
 * the loud notice string. `invalidFile` names the file in the notice
 * ('password file', 'gateway secrets file') — the only per-store variance.
 */
export function preserveInvalidCredentialFile(file: string, invalidFile: string): string {
  const result = preserveFileAside(file, '.corrupt')
  return result.ok
    ? `invalid ${invalidFile} preserved at ${result.path}`
    : `invalid ${invalidFile} at ${file}; preserve failed: ${result.error}`
}

/**
 * One-time crash-residue sweep: the legacy fixed-name `${file}.tmp` persist
 * (open 'w' + rename) can leave that exact-name 0600 residue behind after a
 * hard crash between the two steps. The atomic replace uses a random O_EXCL
 * temp and never reuses or removes that legacy name — sweep it once when the
 * store is configured/loaded. Best-effort only: `force` already swallows
 * ENOENT, and any other failure (permissions…) must not break store
 * configuration, so the remainder is swallowed too.
 */
export function removeLegacyTmpResidue(file: string): void {
  try { rmSync(`${file}.tmp`, { force: true }) } catch { /* best-effort hygiene only */ }
}
