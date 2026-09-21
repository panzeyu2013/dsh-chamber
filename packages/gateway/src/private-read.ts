/**
 * Shared private-file read wrappers (2026-12 audit F9): every gateway state
 * leaf is read through the control-plane no-follow/inode discipline, and an
 * absent file (ENOENT) is the only outcome callers may treat as "not there" —
 * every other failure is rethrown loud, never flattened into a default.
 */
import { readPrivateFileNoFollow, type PrivateFileIdentity, type PrivateFileReadOptions } from '@dsh-chamber/control-plane'

export interface PrivateFileReadEntry {
  value: string
  mtimeMs: number
  identity: PrivateFileIdentity
}

/** Read one private file; ENOENT → null (absent), everything else rethrown. */
export function readPrivateEntryOrNull(file: string, options: PrivateFileReadOptions): PrivateFileReadEntry | null {
  try {
    return readPrivateFileNoFollow(file, options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Text projection of {@link readPrivateEntryOrNull} (the common case). */
export function readPrivateTextOrNull(file: string, options: PrivateFileReadOptions): string | null {
  return readPrivateEntryOrNull(file, options)?.value ?? null
}
