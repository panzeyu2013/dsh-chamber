/**
 * Read an existing desktop credential mirror without following symlinks and
 * tighten it to owner-only permissions BEFORE any secret bytes enter memory.
 *
 * Both ssh-passwords.json and gateway-secrets.json use this boundary. Keeping
 * it shared prevents one credential store from silently losing the 0600 /
 * regular-file / inode-race discipline (design 05 §8, design 17 S22).
 */

import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs'

export function readOwnerOnlySecretFile(file: string): string {
  const pathStat = lstatSync(file)
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`credential path must be a regular file (symlinks are refused): ${file}`)
  }

  // O_NOFOLLOW closes the lstat/open symlink race on platforms that expose
  // it. The opened inode comparison remains mandatory on every platform and
  // rejects a regular-file replacement between lstat and open.
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const fd = openSync(file, fsConstants.O_RDONLY | noFollow)
  try {
    const openedStat = fstatSync(fd)
    if (!openedStat.isFile()
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino) {
      throw new Error(`credential path changed while opening: ${file}`)
    }
    fchmodSync(fd, 0o600)
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}
