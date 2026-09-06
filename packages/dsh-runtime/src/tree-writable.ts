/**
 * Best-effort owner-mode tree walk shared by the runtime store's eviction /
 * explicit-cleanup paths and the runtime installer's removal paths: re-add
 * the write bits that read-only hardening removed so the tree becomes
 * removable again. A missing/raced tree or a mid-walk error is fine — every
 * caller's `rmSync(..., { force: true })` remains authoritative.
 *
 * Deliberately NOT re-exported by index.ts (dist-sync lockstep); module-local
 * imports only.
 */
import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function makeOwnedTreeWritable(treePath: string): void {
  if (!existsSync(treePath)) return
  const visit = (entryPath: string): void => {
    const info = lstatSync(entryPath)
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      chmodSync(entryPath, info.mode | 0o700)
      for (const entry of readdirSync(entryPath)) visit(join(entryPath, entry))
    } else if (info.isFile()) {
      chmodSync(entryPath, info.mode | 0o600)
    }
  }
  try { visit(treePath) } catch { /* rmSync below remains authoritative */ }
}
