import { existsSync, renameSync, rmSync } from 'node:fs';

/**
 * Recover the only interrupted directory-swap state: the old bundle has
 * already moved to backup but the verified work tree has not reached dest.
 * A stale backup beside a live destination is safe to remove.
 */
export function recoverBundleSwap(dest, backup) {
  if (!existsSync(dest) && existsSync(backup)) {
    renameSync(backup, dest);
    return 'restored';
  }
  if (existsSync(dest) && existsSync(backup)) {
    rmSync(backup, { recursive: true, force: true });
    return 'cleaned';
  }
  return 'clean';
}

/**
 * Publish a fully verified work tree while preserving the last-known-good
 * destination. If the final rename fails, restore the previous bundle before
 * surfacing the error.
 */
export function commitBundleSwap(work, dest, backup) {
  recoverBundleSwap(dest, backup);
  const hadPrevious = existsSync(dest);
  if (hadPrevious) renameSync(dest, backup);
  try {
    renameSync(work, dest);
  } catch (error) {
    if (!existsSync(dest) && existsSync(backup)) renameSync(backup, dest);
    throw error;
  }
  if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
}
