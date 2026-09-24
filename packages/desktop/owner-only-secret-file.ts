/**
 * Read an existing desktop credential mirror without following symlinks and
 * tighten it to owner-only 0600 BEFORE any secret bytes enter memory: a looser
 * pre-existing file is tightened, never read loose. Shared by both credential
 * stores (ssh passwords and gateway secrets) so neither silently loses the
 * no-symlink / regular-file / single-link / inode-race discipline. The
 * mechanism is single-sourced in control-plane private-file.ts, reached
 * through the desktop dual-path facade: the read pins the real parent
 * directory, refuses a symlink / multi-link / non-regular leaf, then fchmods
 * the pinned inode. A missing file surfaces as the native ENOENT so callers
 * can tell absence from unsafe evidence; anything unsafe throws a plain Error.
 */

import { readPrivateFileNoFollow } from './control-plane-module.ts'

export function readOwnerOnlySecretFile(file: string): string {
  return readPrivateFileNoFollow(file, { tightenMode: 0o600 }).value
}
