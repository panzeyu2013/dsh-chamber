/**
 * Small owner-private filesystem primitives shared by the control plane and
 * the authenticated gateway state store. They deliberately operate on one
 * caller-owned final directory component: user home ancestors may legitimately
 * be symlinks, but the state directory itself and every leaf must be real.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface PrivateFileIdentity { dev: number; ino: number }

export interface PrivateFileRead {
  value: string
  identity: PrivateFileIdentity
  mtimeMs: number
}

interface PrivateFileModeOptions {
  mode?: number
}

/** Read-time permission policy. `requiredMode` is observation-only: a
 * mismatch fails the read without changing the file. `tightenMode` is the
 * explicit legacy-migration path and may fchmod the already pinned inode. */
export interface PrivateFileReadOptions {
  maxBytes?: number
  requiredMode?: number
  tightenMode?: number
}

interface PrivateDirectoryOptions {
  /** Existing directories historically converged to `mode`. Security
   * boundaries may instead require the caller to provision the exact mode,
   * or preserve an existing non-secret root without mutating it. Newly
   * created directories converge to `mode` on POSIX. Windows exposes only a
   * limited read-only attribute through chmod/stat, so directory modes there
   * are left to inherited OS ACLs after identity/no-follow verification.
   * `require` is legacy (fail-closed exact mode): since the 2026-09 gateway
   * auto-tighten decision no production caller uses it. */
  existingMode?: 'tighten' | 'require' | 'preserve'
}

/** Identity equality; the single source shared by audit-trail, host-logs and log-file. */
export function samePrivateIdentity(left: PrivateFileIdentity, right: PrivateFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** The shared (dev, ino) identity pair every private-file consumer compares. */
export function privateIdentityOf(stat: Stats): PrivateFileIdentity {
  return { dev: stat.dev, ino: stat.ino }
}

/** The platform O_NOFOLLOW flag, or 0 where the platform does not expose it
 *  (win32): every consumer uses this one probe so a missing guard is never
 *  silently compiled into a no-op. */
export function noFollowOpenFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
}

function stableFileSnapshot(left: Stats, right: Stats): boolean {
  return left.isFile() && right.isFile()
    && left.nlink === 1 && right.nlink === 1
    && samePrivateIdentity(privateIdentityOf(left), privateIdentityOf(right))
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

/** POSIX owner fail-closed: a pre-existing leaf owned by a different uid is
 *  never adopted (root could otherwise chmod a foreign leaf into
 *  "compliance"); Windows exposes no comparable owner fact and is skipped. */
function assertPrivateLeafOwner(path: string, stat: Stats): void {
  if (process.platform === 'win32') return
  const effectiveUid = process.geteuid?.() ?? -1
  if (stat.uid !== effectiveUid) {
    throw new Error('private state leaf is not owned by the current user (uid ' + String(stat.uid) + '): ' + path)
  }
}

/** One validated no-follow leaf. */
export interface PrivateLeafFacts {
  identity: PrivateFileIdentity
  size: number
  mtimeMs: number
  mode: number
  uid: number
}

/** Validate one already-lstat'ed leaf: single-link regular file, optional
 *  expected identity, optional POSIX owner check. Single source of the
 *  "unsafe leaf" rule shared by audit-trail, host-logs, log-file and every
 *  private-file write path. */
export function assertPrivateLeafStatNoFollow(
  path: string,
  stat: Stats,
  options: { expected?: PrivateFileIdentity; requireOwner?: boolean } = {},
): PrivateLeafFacts {
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error('private state leaf is not a single-link regular file: ' + path)
  }
  if (options.expected !== undefined && !samePrivateIdentity(options.expected, privateIdentityOf(stat))) {
    throw new Error('private state leaf identity changed: ' + path)
  }
  if (options.requireOwner === true) assertPrivateLeafOwner(path, stat)
  return {
    identity: privateIdentityOf(stat),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o777,
    uid: stat.uid,
  }
}

/** lstat + {@link assertPrivateLeafStatNoFollow}; only ENOENT is absence (a
 *  symlink/non-regular leaf is evidence and must throw, never read as absent). */
export function inspectPrivateLeafNoFollow(
  path: string,
  options: { expected?: PrivateFileIdentity; requireOwner?: boolean } = {},
): PrivateLeafFacts | null {
  try {
    return assertPrivateLeafStatNoFollow(path, lstatSync(path), options)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

interface PinnedParent {
  path: string
  before: Stats
  fd: number | null
}

/** Pin a real final directory where the platform exposes a no-follow directory
 * descriptor. Windows lacks O_NOFOLLOW/O_DIRECTORY, so the same identity is
 * instead checked immediately before and after each namespace operation. */
function pinParent(path: string): PinnedParent {
  const before = lstatSync(path)
  if (before.isSymbolicLink()) {
    throw new Error(`private state parent is not a real directory: ${path}`)
  }
  if (!before.isDirectory()) {
    throw Object.assign(new Error(`private state parent is not a directory: ${path}`), { code: 'ENOTDIR' })
  }
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_DIRECTORY !== 'number') {
    return { path, before, fd: null }
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  try {
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || !samePrivateIdentity(privateIdentityOf(before), privateIdentityOf(opened))) {
      throw new Error(`private state parent changed while opening: ${path}`)
    }
    return { path, before, fd }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

function verifyParent(pin: PinnedParent): void {
  const atPath = lstatSync(pin.path)
  if (atPath.isSymbolicLink() || !atPath.isDirectory()
    || !samePrivateIdentity(privateIdentityOf(pin.before), privateIdentityOf(atPath))) {
    throw new Error(`private state parent identity changed: ${pin.path}`)
  }
  if (pin.fd !== null) {
    const opened = fstatSync(pin.fd)
    if (!opened.isDirectory() || !samePrivateIdentity(privateIdentityOf(atPath), privateIdentityOf(opened))) {
      throw new Error(`private state parent descriptor changed: ${pin.path}`)
    }
  }
}

function closeParent(pin: PinnedParent): void {
  if (pin.fd !== null) closeSync(pin.fd)
}

function syncParent(pin: PinnedParent): void {
  verifyParent(pin)
  // Windows cannot open a directory through Node's portable fs flags. Rename
  // durability there is delegated to CreateFile/MoveFile semantics; POSIX must
  // fsync the exact pinned directory before success is reported.
  if (pin.fd !== null) {
    try {
      fsyncSync(pin.fd)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Directory fsync is a filesystem property, not a Windows one: NFS /
      // CIFS / FUSE mounts commonly reject an O_RDONLY directory fsync with
      // EINVAL/ENOTSUP (e.g. Linux desktops with network/encrypted home
      // directories). That is a durability fallback, never an identity
      // failure — tolerate those two codes on every platform.
      if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error
    }
  }
  verifyParent(pin)
}

function assertReplaceableLeaf(path: string): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error(`private state leaf is not a single-link regular file: ${path}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/** Create/verify a caller-owned final directory without following that final
 * component. Ancestor creation is intentionally allowed for ordinary symlinked
 * home layouts; callers invoke this once per directory they own. */
export function ensurePrivateDirectoryNoFollow(
  path: string,
  mode = 0o700,
  options: PrivateDirectoryOptions = {},
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let created = false
  try {
    mkdirSync(path, { recursive: false, mode })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const pin = pinParent(path)
  try {
    const opened = pin.fd === null ? null : fstatSync(pin.fd)
    const existing = opened ?? pin.before
    const currentMode = existing.mode & 0o777
    const existingMode = options.existingMode ?? 'tighten'
    const posixModeSemantics = process.platform !== 'win32'
    // Owner fail-closed: a pre-existing directory the current user does not
    // own must never be adopted. Root could chmod a foreign loose directory
    // into "compliance" and then read/execute its content as install input
    // (design 18 runtime trees); a non-root fchmod would instead fail with a
    // cryptic EPERM crash loop. Both directions fail loudly here.
    const effectiveUid = process.geteuid?.() ?? -1
    if (posixModeSemantics && !created && existingMode !== 'preserve' && existing.uid !== effectiveUid) {
      throw new Error(`private state directory is not owned by the current user (uid ${existing.uid}): ${path}`)
    }
    if (posixModeSemantics && !created && existingMode === 'require' && currentMode !== mode) {
      throw new Error(
        `private directory must already have mode ${mode.toString(8).padStart(4, '0')}: ${path}`,
      )
    }
    if (posixModeSemantics && currentMode !== mode && (created || existingMode === 'tighten')) {
      if (pin.fd !== null) {
        fchmodSync(pin.fd, mode)
        // Mode re-verification: filesystems that silently ignore chmod
        // (vfat/exfat/CIFS/FUSE) must not let a "tightened" directory stay
        // loose while the gateway believes it is 0700.
        if (!created && (fstatSync(pin.fd).mode & 0o777) !== mode) {
          throw new Error(`cannot tighten private directory mode (filesystem ignored chmod): ${path}`)
        }
      } else {
        throw new Error(`cannot safely tighten private directory mode: ${path}`)
      }
    }
    verifyParent(pin)
  } finally {
    closeParent(pin)
  }
}

/** Durably commit namespace changes already made in one verified directory. */
export function syncPrivateDirectoryNoFollow(path: string): void {
  const pin = pinParent(path)
  try { syncParent(pin) } finally { closeParent(pin) }
}

/** Stable, bounded, no-follow read. Missing is reported with the native ENOENT
 * so callers can distinguish absence from unsafe/corrupt evidence. */
export function readPrivateFileNoFollow(path: string, options: PrivateFileReadOptions = {}): PrivateFileRead {
  if (options.requiredMode !== undefined && options.tightenMode !== undefined
    && options.requiredMode !== options.tightenMode) {
    throw new Error('private file requiredMode and tightenMode must agree when both are provided')
  }
  const parent = pinParent(dirname(path))
  let fd: number | null = null
  try {
    verifyParent(parent)
    const leafBefore = lstatSync(path)
    if (leafBefore.isSymbolicLink() || !leafBefore.isFile() || leafBefore.nlink !== 1) {
      throw new Error(`private state leaf is unsafe: ${path}`)
    }
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || leafBefore.size > maxBytes) {
      throw new Error(`private state leaf exceeds its read bound: ${path}`)
    }
    const noFollow = noFollowOpenFlag()
    fd = openSync(path, constants.O_RDONLY | noFollow)
    const opened = fstatSync(fd)
    if (!stableFileSnapshot(leafBefore, opened)) {
      throw new Error(`private state leaf changed while opening: ${path}`)
    }
    if (options.tightenMode !== undefined && (opened.mode & 0o777) !== options.tightenMode) {
      fchmodSync(fd, options.tightenMode)
    }
    // fchmod changes ctime, so capture the authoritative pre-read snapshot only
    // after the optional one-time permission tightening.
    const beforeRead = fstatSync(fd)
    if (!beforeRead.isFile() || beforeRead.nlink !== 1 || beforeRead.size > maxBytes) {
      throw new Error(`private state leaf became unsafe before read: ${path}`)
    }
    if (options.requiredMode !== undefined && (beforeRead.mode & 0o777) !== options.requiredMode) {
      throw new Error(
        `private state leaf must have mode ${options.requiredMode.toString(8).padStart(4, '0')}: ${path}`,
      )
    }
    const value = readFileSync(fd, 'utf8')
    const afterRead = fstatSync(fd)
    const atPath = lstatSync(path)
    verifyParent(parent)
    if (!stableFileSnapshot(beforeRead, afterRead)
      || !stableFileSnapshot(afterRead, atPath)
      || Buffer.byteLength(value) !== afterRead.size) {
      throw new Error(`private state leaf changed during read: ${path}`)
    }
    return { value, identity: privateIdentityOf(afterRead), mtimeMs: afterRead.mtimeMs }
  } finally {
    if (fd !== null) closeSync(fd)
    closeParent(parent)
  }
}

/** Exclusively create one final regular leaf and durably publish its initial
 * contents. The O_EXCL name becomes visible before the write is complete, so
 * readers of protocols using this primitive must treat a short-lived empty
 * or changing file as an in-progress competing create. */
export function createPrivateFileExclusiveNoFollow(
  path: string,
  value: string | Buffer,
  options: PrivateFileModeOptions = {},
): PrivateFileIdentity {
  const parent = pinParent(dirname(path))
  const createMode = options.mode ?? 0o666
  let fd: number | null = null
  let identity: PrivateFileIdentity | null = null
  try {
    verifyParent(parent)
    const noFollow = noFollowOpenFlag()
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, createMode)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error(`private exclusive leaf is unsafe: ${path}`)
    }
    identity = privateIdentityOf(opened)
    if (options.mode !== undefined && (opened.mode & 0o777) !== options.mode) {
      fchmodSync(fd, options.mode)
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written === 0) throw new Error(`private exclusive write made no progress: ${path}`)
      offset += written
    }
    fsyncSync(fd)
    const written = fstatSync(fd)
    if (!written.isFile() || written.nlink !== 1
      || !samePrivateIdentity(identity, privateIdentityOf(written)) || written.size !== bytes.length) {
      throw new Error(`private exclusive leaf changed during write: ${path}`)
    }
    closeSync(fd)
    fd = null
    verifyParent(parent)
    const atPath = lstatSync(path)
    if (atPath.isSymbolicLink() || !atPath.isFile() || atPath.nlink !== 1
      || !samePrivateIdentity(identity, privateIdentityOf(atPath)) || atPath.size !== bytes.length) {
      throw new Error(`private exclusive leaf identity verification failed: ${path}`)
    }
    syncParent(parent)
    return identity
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort; retain fail-closed evidence */ }
    }
    closeParent(parent)
  }
}

/** Options for {@link openPrivateAppendNoFollow}. */
export interface PrivateAppendOpenOptions {
  /** Open with O_CREAT (default true). */
  create?: boolean
  /** Add O_EXCL; implies an exclusive create and requires `create`. */
  exclusive?: boolean
  /** Required identity when the caller already inspected the leaf. */
  expected?: PrivateFileIdentity | null
  /** Re-prove the namespace still names the opened inode (default true). */
  verifyPathIdentity?: boolean
  /** POSIX mode enforced through the descriptor; null disables. Default 0o600. */
  tightenMode?: number | null
  /** true = a mode that cannot be tightened is an error (audit trail);
   *  false = best effort (the control-plane log keeps writing on filesystems
   *  that ignore chmod). */
  strictTighten?: boolean
  /** Extra open flags (log-file passes O_NONBLOCK so a FIFO leaf cannot block). */
  extraFlags?: number
}

/** The opened append handle: descriptor, authoritative identity, current size
 *  and whether this call created the leaf (exclusive-create only). */
export interface PrivateAppendHandle {
  fd: number
  identity: PrivateFileIdentity
  size: number
  created: boolean
}

/** Open an existing or append-or-created leaf under the shared no-follow +
 *  identity + mode-tightening discipline. Single source for audit-trail's
 *  per-append handle and log-file's persistent handle. */
export function openPrivateAppendNoFollow(path: string, options: PrivateAppendOpenOptions = {}): PrivateAppendHandle {
  const create = options.create ?? true
  const exclusive = options.exclusive ?? false
  if (exclusive && !create) throw new Error('private append exclusive open requires create')
  const expected = options.expected ?? null
  const verifyPathIdentity = options.verifyPathIdentity ?? true
  const tightenMode = options.tightenMode === undefined ? 0o600 : options.tightenMode
  const strictTighten = options.strictTighten ?? true
  const flags = constants.O_WRONLY | constants.O_APPEND | noFollowOpenFlag() | (options.extraFlags ?? 0)
    | (create ? constants.O_CREAT : 0)
    | (exclusive ? constants.O_EXCL : 0)
  const fd = openSync(path, flags, tightenMode ?? 0o666)
  try {
    const opened = assertPrivateLeafStatNoFollow(path, fstatSync(fd))
    if (expected !== null && !samePrivateIdentity(expected, opened.identity)) {
      throw new Error('private append leaf changed while opening: ' + path)
    }
    if (verifyPathIdentity) {
      const atPath = inspectPrivateLeafNoFollow(path, { expected: opened.identity })
      if (atPath === null) throw new Error('private append leaf path does not match its descriptor: ' + path)
    }
    if (tightenMode !== null && process.platform !== 'win32') {
      if ((fstatSync(fd).mode & 0o777) !== tightenMode) {
        try {
          fchmodSync(fd, tightenMode)
        } catch (error) {
          if (strictTighten) throw error
        }
      }
      if (strictTighten) {
        const tightened = assertPrivateLeafStatNoFollow(path, fstatSync(fd))
        if (!samePrivateIdentity(tightened.identity, opened.identity) || tightened.mode !== tightenMode) {
          throw new Error('private append leaf became unsafe while tightening mode: ' + path)
        }
        if (verifyPathIdentity) {
          const recheck = inspectPrivateLeafNoFollow(path, { expected: opened.identity })
          if (recheck === null) throw new Error('private append leaf path does not match its descriptor: ' + path)
        }
      }
    }
    return { fd, identity: opened.identity, size: fstatSync(fd).size, created: exclusive }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Write every byte through one descriptor; a zero-progress write fails loudly. */
export function writePrivateFdAll(fd: number, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written === 0) throw new Error('private file append made no write progress')
    offset += written
  }
}

/** Atomically replace one regular leaf through a random, exclusive temp file;
 * never opens the destination or a predictable temp path for writing. */
export function atomicWritePrivateFileNoFollow(path: string, value: string | Buffer, options: PrivateFileModeOptions = {}): void {
  const parent = pinParent(dirname(path))
  // An omitted mode follows ordinary open(2) semantics: 0666 filtered by the
  // process umask. Only an explicit owner policy (for example 0600 secrets)
  // is allowed to override that result with fchmod. Unconditionally forcing
  // 0666 here would undo the caller's umask and make generic JSON stores
  // world-writable.
  const createMode = options.mode ?? 0o666
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`)
  let tempIdentity: PrivateFileIdentity | null = null
  let fd: number | null = null
  let published = false
  try {
    verifyParent(parent)
    assertReplaceableLeaf(path)
    const noFollow = noFollowOpenFlag()
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, createMode)
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`private temp leaf is unsafe: ${temp}`)
    tempIdentity = privateIdentityOf(opened)
    if (options.mode !== undefined && (opened.mode & 0o777) !== options.mode) {
      fchmodSync(fd, options.mode)
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (written === 0) throw new Error(`private temp write made no progress: ${temp}`)
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    verifyParent(parent)
    const tempAtPath = lstatSync(temp)
    if (tempAtPath.isSymbolicLink() || !tempAtPath.isFile() || tempAtPath.nlink !== 1
      || !samePrivateIdentity(tempIdentity, privateIdentityOf(tempAtPath))) {
      throw new Error(`private temp leaf changed before publish: ${temp}`)
    }
    assertReplaceableLeaf(path)
    renameSync(temp, path)
    published = true
    verifyParent(parent)
    const publishedStat = lstatSync(path)
    if (publishedStat.isSymbolicLink() || !publishedStat.isFile() || publishedStat.nlink !== 1
      || !samePrivateIdentity(tempIdentity, privateIdentityOf(publishedStat))) {
      throw new Error(`private state publish identity verification failed: ${path}`)
    }
    syncParent(parent)
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
    if (!published && tempIdentity !== null) {
      try {
        verifyParent(parent)
        const tempStat = lstatSync(temp)
        if (!tempStat.isSymbolicLink() && tempStat.isFile() && tempStat.nlink === 1
          && samePrivateIdentity(tempIdentity, privateIdentityOf(tempStat))) unlinkSync(temp)
      } catch { /* fail-closed residue; never traverse a replaced parent */ }
    }
    closeParent(parent)
  }
}

/** Bounded ring rotation over `path` and its `.1 .. .<files-1>` archives.
 *
 *  Every existing slot is validated (single-link regular file, no symlink,
 *  optional POSIX owner check) BEFORE any namespace change, and re-validated
 *  immediately before it is touched, so a pre-planted symlink / multi-link /
 *  foreign file aborts the whole rotation as evidence instead of being
 *  deleted or renamed over. Missing slots are normal. Throws on any unsafe
 *  slot or failed rename; callers own the fail-soft policy. */
export function rotatePrivateFileRingNoFollow(
  path: string,
  options: { files: number; requireOwner?: boolean },
): void {
  const files = Math.max(2, options.files)
  const requireOwner = options.requireOwner ?? true
  const parent = pinParent(dirname(path))
  try {
    verifyParent(parent)
    // Full scan first: no slot is touched until every existing slot is proven.
    for (let index = 1; index < files; index += 1) {
      inspectPrivateLeafNoFollow(path + '.' + String(index), { requireOwner })
    }
    const active = inspectPrivateLeafNoFollow(path, { requireOwner })
    const revalidate = (candidate: string): PrivateLeafFacts | null =>
      inspectPrivateLeafNoFollow(candidate, { requireOwner })
    const oldest = path + '.' + String(files - 1)
    const oldestFacts = revalidate(oldest)
    verifyParent(parent)
    if (oldestFacts !== null) removePrivateFileNoFollow(oldest, oldestFacts.identity)
    for (let index = files - 2; index >= 1; index -= 1) {
      const source = path + '.' + String(index)
      if (revalidate(source) === null) continue
      revalidate(path + '.' + String(index + 1))
      verifyParent(parent)
      renameSync(source, path + '.' + String(index + 1))
    }
    if (active !== null) {
      revalidate(path)
      verifyParent(parent)
      renameSync(path, path + '.1')
    }
    verifyParent(parent)
    syncParent(parent)
  } finally {
    closeParent(parent)
  }
}

/** Remove a verified regular leaf and durably commit the directory entry on
 * platforms where Node exposes a pin-able directory descriptor. */
export function removePrivateFileNoFollow(path: string, expected?: PrivateFileIdentity): void {
  const parent = pinParent(dirname(path))
  try {
    verifyParent(parent)
    let leaf: Stats
    try {
      leaf = lstatSync(path)
    } catch (error) {
      // Idempotent absence made no namespace change, so a directory fsync
      // here is both unnecessary and harmful on otherwise-readable media.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1
      || (expected !== undefined && !samePrivateIdentity(expected, privateIdentityOf(leaf)))) {
      throw new Error(`private state leaf is unsafe or no longer owned: ${path}`)
    }
    unlinkSync(path)
    verifyParent(parent)
    syncParent(parent)
  } finally {
    closeParent(parent)
  }
}
