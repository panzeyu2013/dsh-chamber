/**
 * Read an existing desktop credential mirror without following symlinks and
 * tighten it to owner-only permissions BEFORE any secret bytes enter memory.
 *
 * Both ssh-passwords.json and gateway-secrets.json use this boundary. Keeping
 * it shared prevents one credential store from silently losing the 0600 /
 * regular-file / inode-race discipline (design 05 §8, design 17 S22).
 *
 * The mechanism is single-sourced in control-plane (private-file.ts, P2-2a,
 * reached through the desktop dual-path facade): the delegated read pins the
 * real parent directory, refuses a symlink / multi-link / non-regular leaf,
 * and `tightenMode` fchmods the already-pinned inode to 0600 before any bytes
 * enter memory (the legacy migration semantics: a looser pre-existing file is
 * tightened, then read — never read loose). A missing file surfaces as the
 * native ENOENT so callers can distinguish absence from unsafe evidence;
 * anything unsafe throws a plain Error.
 */

import { readPrivateFileNoFollow } from './control-plane-module.ts'

export function readOwnerOnlySecretFile(file: string): string {
  return readPrivateFileNoFollow(file, { tightenMode: 0o600 }).value
}
