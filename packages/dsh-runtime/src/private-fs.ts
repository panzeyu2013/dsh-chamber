/**
 * Owner-private runtime filesystem primitives.
 *
 * Node does not expose mkdirat/renameat, so every path operation is bracketed
 * by no-follow identity checks. In particular, an existing `dsh-runtime`
 * entry must be a real directory: callers never chmod, write through, or
 * recursively delete a symlinked runtime root.
 *
 * Platforms without O_NOFOLLOW/O_DIRECTORY (win32) resolve portable flags
 * through resolveNoFollowFlags() instead of refusing to start; every open then
 * carries the no-follow guarantee through lstat identity checks immediately
 * before and after the descriptor (see openPrivateNoFollowSync).
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
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
  type Stats,
} from 'node:fs'
import { lstat as lstatAsync, open as openAsync, type FileHandle } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join, relative, sep } from 'node:path'

export const PRIVATE_RUNTIME_DIR_MODE = 0o700
export const PRIVATE_RUNTIME_FILE_MODE = 0o600

export interface RuntimeFileIdentity {
  dev: number | bigint
  ino: number | bigint
}

export type PrivateFileRead =
  | { kind: 'missing' }
  | { kind: 'unsafe' }
  | { kind: 'valid'; raw: string; identity: RuntimeFileIdentity }

/** Narrow durability seam for deterministic ordering/failure tests. Runtime
 * callers omit it and always reach the real fsyncSync implementation. */
export interface PrivateFsDurabilityDeps {
  fsync?: (fd: number) => void
  /** Namespace-commit seam: replaces the publish rename inside the atomic
   *  writers so tests can inject a rename failure at a named phase without
   *  faking the writer. Production callers omit it and reach renameSync. */
  rename?: (source: string, destination: string) => void
}

export interface PrivateFileReadOptions {
  /** Existing authority readers tighten legacy modes by default. Callers that
   * have already surrendered writer ownership can opt into a side-effect-free
   * read instead. */
  tightenMode?: boolean
  /** Narrow deterministic test seam; production callers omit it. */
  read?: (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number
}

export interface PrivateFsRemoveDeps extends PrivateFsDurabilityDeps {
  /** Optional ownership proof for leases. A replacement inode is never
   * removed, even when it is otherwise a safe private file. */
  expectedIdentity?: RuntimeFileIdentity
}

export interface PrivateFsQuarantineDeps extends PrivateFsDurabilityDeps {
  expectedIdentity?: RuntimeFileIdentity
  /** Narrow deterministic namespace-race seam; production callers omit it. */
  beforeRename?: () => void
}

interface PinnedDirectory {
  path: string
  parentPath: string
  fd: number
  identity: RuntimeFileIdentity
  parentIdentity: RuntimeFileIdentity
}

function sameIdentity(left: RuntimeFileIdentity, right: RuntimeFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return sameIdentity(left, right)
    && left.isFile()
    && right.isFile()
    && left.nlink === 1
    && right.nlink === 1
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function samePreciseFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.isFile()
    && right.isFile()
    && left.nlink === 1n
    && right.nlink === 1n
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

/** The node:fs `constants` subset the no-follow strategy reads. Injectable
 *  so the POSIX branch (O_NOFOLLOW present) and the no-flag fallback branch are
 *  both unit-testable without a win32 host. */
export interface NoFollowConstantsLike {
  O_RDONLY?: number
  O_WRONLY?: number
  O_CREAT?: number
  O_EXCL?: number
  O_NOFOLLOW?: number
  O_DIRECTORY?: number
}

export type NoFollowOpenKind = 'read' | 'write' | 'directory'

export interface ResolvedNoFollowFlags {
  /** `open(2)` flags for the requested kind. */
  flags: number
  /** True when the kernel itself refuses a symlinked final component because
   *  O_NOFOLLOW rides in `flags`; false when the platform does not expose the
   *  constant and the open helper below must re-prove identity in user space. */
  kernelNoFollow: boolean
}

/**
 * Platform-aware no-follow strategy.
 *
 * POSIX keeps the historical O_NOFOLLOW/O_DIRECTORY flags byte-for-byte. Windows
 * exposes neither constant (`typeof undefined`); hard-failing there is what
 * made an existing <userData>/dsh-runtime unreadable and killed the gated
 * runtime transaction. The gateway already treats win32 as a separate shape and
 * skips the POSIX primitives rather than throwing
 * (packages/gateway/src/runtime-manager.ts:632-648), and control-plane's
 * identity-only pin proves the same guarantee without a descriptor
 * (packages/control-plane/src/private-file.ts:85-107,182-209). The fallback
 * flags therefore drop O_NOFOLLOW/O_DIRECTORY and openPrivateNoFollowSync()
 * restores the guarantee with lstat identity checks around the open.
 */
export function resolveNoFollowFlags(
  kind: NoFollowOpenKind,
  constantsLike: NoFollowConstantsLike = constants,
): ResolvedNoFollowFlags {
  const noFollow = typeof constantsLike.O_NOFOLLOW === 'number' ? constantsLike.O_NOFOLLOW : 0
  if (kind === 'write') {
    // O_WRONLY|O_CREAT|O_EXCL mirrors the historical writer flags. O_EXCL is
    // also the fallback freshness proof: an already-present leaf (symlink or
    // hard link included) fails the open itself with the raw EEXIST contention
    // signal, so there is no final component left to follow.
    return {
      flags: (constantsLike.O_WRONLY ?? 0)
        | (constantsLike.O_CREAT ?? 0)
        | (constantsLike.O_EXCL ?? 0)
        | noFollow,
      kernelNoFollow: noFollow !== 0,
    }
  }
  const directory = kind === 'directory' && typeof constantsLike.O_DIRECTORY === 'number'
    ? constantsLike.O_DIRECTORY
    : 0
  return {
    flags: (constantsLike.O_RDONLY ?? 0) | directory | noFollow,
    kernelNoFollow: noFollow !== 0,
  }
}

export interface NoFollowOpenOptions {
  /** Create mode for the 'write' kind (O_CREAT|O_EXCL is always included). */
  mode?: number
  /** Deterministic fallback-path seam; production callers omit it. */
  constantsLike?: NoFollowConstantsLike
}

/**
 * Open one private path through the platform no-follow strategy. POSIX hands
 * O_NOFOLLOW to open(2) itself, exactly as before. Without it the guarantee is
 * re-established in user space, mirroring control-plane private-file.ts:85-107:
 * (a) the leaf is lstat-ed immediately before the open and a symlinked final
 * component is refused, and (b) after the open the path is lstat-ed again and
 * must still name the exact inode (dev/ino) the descriptor returned. Anything
 * the fallback cannot prove throws, and every caller's fail-closed wrapper
 * turns that into a refusal or 'unsafe'.
 */
export function openPrivateNoFollowSync(
  path: string,
  kind: NoFollowOpenKind,
  options: NoFollowOpenOptions = {},
): { fd: number; stats: Stats } {
  const { flags, kernelNoFollow } = resolveNoFollowFlags(kind, options.constantsLike)
  if (!kernelNoFollow && kind !== 'write') {
    const before = lstatSync(path)
    if (before.isSymbolicLink()) {
      throw new Error(`私有路径的最终组件是符号链接，拒绝打开：${basename(path)}`)
    }
  }
  const fd = kind === 'write'
    ? openSync(path, flags, options.mode ?? PRIVATE_RUNTIME_FILE_MODE)
    : openSync(path, flags)
  try {
    const stats = fstatSync(fd)
    if (!kernelNoFollow) {
      const atPath = lstatSync(path)
      if (atPath.isSymbolicLink() || !sameIdentity(stats, atPath)) {
        throw new Error(`私有路径打开后身份复验失败：${basename(path)}`)
      }
    }
    return { fd, stats }
  } catch (error) {
    try { closeSync(fd) } catch { /* already closed */ }
    throw error
  }
}

function syncFd(fd: number, deps?: PrivateFsDurabilityDeps): void {
  const sync = deps?.fsync ?? fsyncSync
  sync(fd)
}

function verifyPinnedDirectory(pin: PinnedDirectory, message: string): Stats {
  const opened = fstatSync(pin.fd)
  const atPath = lstatSync(pin.path)
  const parent = lstatSync(pin.parentPath)
  if (!opened.isDirectory()
    || atPath.isSymbolicLink()
    || !atPath.isDirectory()
    || !sameIdentity(pin.identity, opened)
    || !sameIdentity(opened, atPath)
    || parent.isSymbolicLink()
    || !parent.isDirectory()
    || !sameIdentity(pin.parentIdentity, parent)) {
    throw new Error(message)
  }
  return atPath
}

/** Hold the directory inode across a namespace mutation. Node has no
 * mkdirat/renameat/unlinkat seam, so the path is re-proved against this
 * O_NOFOLLOW fd immediately before and after the mutation and fsync. */
function pinRealDirectory(path: string, tighten: boolean): PinnedDirectory {
  const parentPath = dirname(path)
  const parentBefore = lstatSync(parentPath)
  if (parentBefore.isSymbolicLink() || !parentBefore.isDirectory()) {
    throw new Error(`不安全的私有目录父级：${basename(path)}`)
  }
  const before = lstatSync(path)
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`不安全的私有目录：${basename(path)}`)
  }

  let fd: number | null = null
  try {
    const openedDirectory = openPrivateNoFollowSync(path, 'directory')
    fd = openedDirectory.fd
    const opened = openedDirectory.stats
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      throw new Error(`私有目录身份不稳定：${basename(path)}`)
    }
    if (tighten && (opened.mode & 0o777) !== PRIVATE_RUNTIME_DIR_MODE) {
      fchmodSync(fd, PRIVATE_RUNTIME_DIR_MODE)
    }
    const pin: PinnedDirectory = {
      path,
      parentPath,
      fd,
      identity: { dev: opened.dev, ino: opened.ino },
      parentIdentity: { dev: parentBefore.dev, ino: parentBefore.ino },
    }
    verifyPinnedDirectory(pin, `私有目录身份复验失败：${basename(path)}`)
    fd = null
    return pin
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function closePinnedDirectory(pin: PinnedDirectory): void {
  closeSync(pin.fd)
}

/** A namespace mutation is not reported successful until the exact parent
 * inode held across that mutation has been fsynced and re-verified. */
function syncPinnedDirectory(pin: PinnedDirectory, deps?: PrivateFsDurabilityDeps): void {
  verifyPinnedDirectory(pin, `私有目录 fsync 前身份复验失败：${basename(pin.path)}`)
  syncFd(pin.fd, deps)
  verifyPinnedDirectory(pin, `私有目录 fsync 后身份复验失败：${basename(pin.path)}`)
}

/** Pin a real directory, optionally tightening the inode through its fd. */
function inspectRealDirectory(path: string, tighten: boolean): Stats {
  const pin = pinRealDirectory(path, tighten)
  try {
    return verifyPinnedDirectory(pin, `私有目录身份复验失败：${basename(path)}`)
  } finally {
    closePinnedDirectory(pin)
  }
}

/** Create exactly one child directory; recursive symlink traversal is banned. */
export function ensurePrivateDirectoryNoFollow(path: string, deps?: PrivateFsDurabilityDeps): void {
  const parent = dirname(path)
  const parentPin = pinRealDirectory(parent, false)
  let childPin: PinnedDirectory | null = null
  try {
    verifyPinnedDirectory(parentPin, `私有目录创建前父目录身份复验失败：${basename(path)}`)
    try {
      mkdirSync(path, { recursive: false, mode: PRIVATE_RUNTIME_DIR_MODE })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    childPin = pinRealDirectory(path, true)
    // Also fsync on the EEXIST retry path: a previous call may have completed
    // mkdir but surfaced a parent-fsync failure. No later success may silently
    // adopt that directory without re-establishing the durability proof.
    syncPinnedDirectory(parentPin, deps)
    verifyPinnedDirectory(childPin, `私有目录创建后身份复验失败：${basename(path)}`)
  } finally {
    if (childPin !== null) closePinnedDirectory(childPin)
    closePinnedDirectory(parentPin)
  }
}

/** Create a fresh private directory; an existing leaf is never adopted. */
export function createPrivateDirectoryNoFollow(path: string, deps?: PrivateFsDurabilityDeps): void {
  const parentPin = pinRealDirectory(dirname(path), false)
  let childPin: PinnedDirectory | null = null
  try {
    verifyPinnedDirectory(parentPin, `私有目录创建前父目录身份复验失败：${basename(path)}`)
    mkdirSync(path, { recursive: false, mode: PRIVATE_RUNTIME_DIR_MODE })
    childPin = pinRealDirectory(path, true)
    syncPinnedDirectory(parentPin, deps)
    verifyPinnedDirectory(childPin, `私有目录创建后身份复验失败：${basename(path)}`)
  } finally {
    if (childPin !== null) closePinnedDirectory(childPin)
    closePinnedDirectory(parentPin)
  }
}

export function runtimeRootPath(baseDir: string): string {
  return join(baseDir, 'dsh-runtime')
}

/** Ensure the owned runtime root exists and is a real 0700 directory. */
export function ensureRuntimeRootNoFollow(baseDir: string, deps?: PrivateFsDurabilityDeps): string {
  inspectRealDirectory(baseDir, false)
  const root = runtimeRootPath(baseDir)
  ensurePrivateDirectoryNoFollow(root, deps)
  return root
}

/** Require an existing real runtime root without creating any state. */
export function assertRuntimeRootNoFollow(baseDir: string): string {
  inspectRealDirectory(baseDir, false)
  const root = runtimeRootPath(baseDir)
  inspectRealDirectory(root, true)
  return root
}

/** Create a private directory chain below the verified runtime root. */
export function ensureRuntimeSubdirectoryNoFollow(baseDir: string, ...segments: string[]): string {
  let current = ensureRuntimeRootNoFollow(baseDir)
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || basename(segment) !== segment) {
      throw new Error(`不安全的 runtime 子目录名：${JSON.stringify(segment)}`)
    }
    current = join(current, segment)
    ensurePrivateDirectoryNoFollow(current)
  }
  return current
}

function ensureOwnedParent(baseDir: string, filePath: string, deps?: PrivateFsDurabilityDeps): void {
  const root = ensureRuntimeRootNoFollow(baseDir, deps)
  const parent = dirname(filePath)
  const rel = relative(root, parent)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('runtime 私有文件越出受控根目录')
  }
  if (rel === '') {
    inspectRealDirectory(root, true)
    return
  }
  const segments = rel.split(sep)
  ensureRuntimeSubdirectoryNoFollow(baseDir, ...segments)
}

function assertReplaceableLeaf(filePath: string): void {
  try {
    const info = lstatSync(filePath)
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
      throw new Error(`runtime 私有文件不是单链接普通文件：${basename(filePath)}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

/** Best-effort cleanup may run only while the original parent and the exact
 * leaf created by this operation are still proved. In particular, never let
 * an error path traverse a parent symlink that appeared during the mutation. */
function removePinnedLeafBestEffort(
  parentPin: PinnedDirectory,
  filePath: string,
  identity: RuntimeFileIdentity | null,
): void {
  if (identity === null) return
  try {
    verifyPinnedDirectory(parentPin, 'runtime 临时文件清理前父目录身份复验失败')
    const leaf = lstatSync(filePath)
    if (leaf.isSymbolicLink()
      || !leaf.isFile()
      || leaf.nlink !== 1
      || !sameIdentity(identity, leaf)) return
    unlinkSync(filePath)
    verifyPinnedDirectory(parentPin, 'runtime 临时文件清理后父目录身份复验失败')
  } catch {
    // The primary operation already failed. An unproved cleanup is skipped so
    // it cannot mutate a replacement directory; stale private evidence is the
    // fail-closed outcome.
  }
}

/** Atomic 0600 replacement that never opens the destination leaf for write. */
export function atomicWriteRuntimeFileNoFollow(
  baseDir: string,
  filePath: string,
  data: string | Buffer,
  deps?: PrivateFsDurabilityDeps,
): void {
  ensureOwnedParent(baseDir, filePath, deps)
  assertReplaceableLeaf(filePath)
  const parent = dirname(filePath)
  const tmp = join(parent, `.${basename(filePath)}.tmp-${randomBytes(6).toString('hex')}`)
  const parentPin = pinRealDirectory(parent, true)
  let fd: number | null = null
  let tmpIdentity: RuntimeFileIdentity | null = null
  try {
    fd = openPrivateNoFollowSync(tmp, 'write').fd
    fchmodSync(fd, PRIVATE_RUNTIME_FILE_MODE)
    const created = fstatSync(fd)
    if (!created.isFile() || created.nlink !== 1) throw new Error('runtime 临时文件身份不安全')
    tmpIdentity = { dev: created.dev, ino: created.ino }
    writeFileSync(fd, data)
    syncFd(fd, deps)
    const written = fstatSync(fd)
    if (!written.isFile() || written.nlink !== 1 || !sameIdentity(tmpIdentity, written)) {
      throw new Error('runtime 临时文件身份不安全')
    }
    closeSync(fd)
    fd = null

    verifyPinnedDirectory(parentPin, 'runtime 原子写提交前父目录身份复验失败')
    const tmpAtCommit = lstatSync(tmp)
    if (tmpAtCommit.isSymbolicLink()
      || !tmpAtCommit.isFile()
      || tmpAtCommit.nlink !== 1
      || !sameIdentity(tmpIdentity, tmpAtCommit)) {
      throw new Error('runtime 原子写提交前身份复验失败')
    }
    ;(deps?.rename ?? renameSync)(tmp, filePath)
    const published = lstatSync(filePath)
    const parentAfter = lstatSync(parent)
    if (published.isSymbolicLink()
      || !published.isFile()
      || published.nlink !== 1
      || !sameIdentity(tmpIdentity, published)
      || parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || !sameIdentity(parentPin.identity, parentAfter)) {
      throw new Error('runtime 原子写发布后身份复验失败')
    }
    syncPinnedDirectory(parentPin, deps)
    const publishedAfterSync = lstatSync(filePath)
    if (publishedAfterSync.isSymbolicLink()
      || !publishedAfterSync.isFile()
      || publishedAfterSync.nlink !== 1
      || !sameIdentity(tmpIdentity, publishedAfterSync)) {
      throw new Error('runtime 原子写 fsync 后文件身份复验失败')
    }
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* already closed */ }
      fd = null
    }
    removePinnedLeafBestEffort(parentPin, tmp, tmpIdentity)
    throw error
  } finally {
    closePinnedDirectory(parentPin)
  }
}

/**
 * Create a fresh owner-private file without a read-check-write race.
 *
 * This intentionally leaves a created leaf in place if a later write/fsync
 * step fails: callers cannot claim ownership, while the remaining O_EXCL
 * evidence prevents another writer from silently entering after an ambiguous
 * durable-commit outcome.
 */
export function createRuntimeFileExclusiveNoFollow(
  baseDir: string,
  filePath: string,
  data: string | Buffer,
  deps?: PrivateFsDurabilityDeps,
): void {
  ensureOwnedParent(baseDir, filePath, deps)
  const parent = dirname(filePath)
  const parentPin = pinRealDirectory(parent, true)
  let fd: number | null = null
  let identity: RuntimeFileIdentity | null = null
  try {
    verifyPinnedDirectory(parentPin, 'runtime 独占创建前父目录身份复验失败')
    // Keep the raw EEXIST from O_EXCL: owners use it as the authoritative
    // contention signal, including for existing symlink/hard-link leaves.
    fd = openPrivateNoFollowSync(filePath, 'write').fd
    const created = fstatSync(fd)
    if (!created.isFile() || created.nlink !== 1) {
      throw new Error('runtime 独占创建文件身份不安全')
    }
    identity = { dev: created.dev, ino: created.ino }
    fchmodSync(fd, PRIVATE_RUNTIME_FILE_MODE)
    writeFileSync(fd, data)
    syncFd(fd, deps)

    const written = fstatSync(fd)
    const atPath = lstatSync(filePath)
    if (!written.isFile()
      || written.nlink !== 1
      || !sameIdentity(identity, written)
      || atPath.isSymbolicLink()
      || !atPath.isFile()
      || atPath.nlink !== 1
      || !sameIdentity(identity, atPath)) {
      throw new Error('runtime 独占创建文件写入后身份复验失败')
    }
    verifyPinnedDirectory(parentPin, 'runtime 独占创建后父目录身份复验失败')
    syncPinnedDirectory(parentPin, deps)

    const after = fstatSync(fd)
    const atPathAfterSync = lstatSync(filePath)
    if (!after.isFile()
      || after.nlink !== 1
      || !sameIdentity(identity, after)
      || atPathAfterSync.isSymbolicLink()
      || !atPathAfterSync.isFile()
      || atPathAfterSync.nlink !== 1
      || !sameIdentity(identity, atPathAfterSync)) {
      throw new Error('runtime 独占创建 fsync 后文件身份复验失败')
    }
  } finally {
    if (fd !== null) closeSync(fd)
    closePinnedDirectory(parentPin)
  }
}

function assertLeafMissing(filePath: string, message: string): void {
  try {
    lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new Error(message)
}

/** Remove only a verified, single-link regular file below a real runtime root. */
export function removeRuntimeFileNoFollow(
  baseDir: string,
  filePath: string,
  deps?: PrivateFsRemoveDeps,
): void {
  inspectRealDirectory(baseDir, false)
  const root = runtimeRootPath(baseDir)
  let rootInfo: Stats
  try {
    rootInfo = lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error('dsh-runtime 根目录不安全，拒绝删除私有文件')
  }
  inspectRealDirectory(root, true)
  const parent = dirname(filePath)
  const rel = relative(root, parent)
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('runtime 私有文件越出受控根目录')
  let parentPin: PinnedDirectory
  try {
    parentPin = pinRealDirectory(parent, true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    let leaf: Stats
    try {
      leaf = lstatSync(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (leaf.isSymbolicLink() || !leaf.isFile() || leaf.nlink !== 1) {
      throw new Error(`runtime 私有文件不安全，拒绝删除：${basename(filePath)}`)
    }
    if (deps?.expectedIdentity !== undefined && !sameIdentity(leaf, deps.expectedIdentity)) {
      throw new Error(`runtime 私有文件身份已替换，拒绝删除：${basename(filePath)}`)
    }
    verifyPinnedDirectory(parentPin, 'runtime 私有文件删除前父目录身份复验失败')
    const leafAtCommit = lstatSync(filePath)
    if (leafAtCommit.isSymbolicLink()
      || !leafAtCommit.isFile()
      || leafAtCommit.nlink !== 1
      || !sameIdentity(leaf, leafAtCommit)
      || (deps?.expectedIdentity !== undefined && !sameIdentity(leafAtCommit, deps.expectedIdentity))) {
      throw new Error(`runtime 私有文件删除提交前身份已替换：${basename(filePath)}`)
    }
    unlinkSync(filePath)
    assertLeafMissing(filePath, 'runtime 私有文件删除后仍存在')
    verifyPinnedDirectory(parentPin, 'runtime 私有文件删除后父目录身份复验失败')
    syncPinnedDirectory(parentPin, deps)
    assertLeafMissing(filePath, 'runtime 私有文件 fsync 后重新出现')
  } finally {
    closePinnedDirectory(parentPin)
  }
}

function sameLeafKind(left: Stats, right: Stats): boolean {
  return left.isFile() === right.isFile()
    && left.isSymbolicLink() === right.isSymbolicLink()
    && left.isDirectory() === right.isDirectory()
}

/**
 * Durably move an untrusted authority leaf to a caller-chosen evidence name
 * in the same verified private directory. The source leaf is inspected with
 * lstat only, so a symlink or hard-link record can be preserved without ever
 * opening/chmodding its target. Directory leaves are refused.
 */
export function quarantineRuntimeFileNoFollow(
  baseDir: string,
  filePath: string,
  destinationPath: string,
  deps?: PrivateFsQuarantineDeps,
): RuntimeFileIdentity {
  inspectRealDirectory(baseDir, false)
  const root = assertRuntimeRootNoFollow(baseDir)
  const parent = dirname(filePath)
  if (dirname(destinationPath) !== parent || destinationPath === filePath) {
    throw new Error('runtime 隔离目标必须是同一私有目录中的不同文件')
  }
  const rel = relative(root, parent)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('runtime 隔离文件越出受控根目录')
  }
  if (rel !== '') {
    let current = root
    for (const segment of rel.split(sep)) {
      if (segment === '' || segment === '.' || segment === '..' || basename(segment) !== segment) {
        throw new Error('runtime 隔离文件父目录不安全')
      }
      current = join(current, segment)
      inspectRealDirectory(current, true)
    }
  }

  const parentPin = pinRealDirectory(parent, true)
  try {
    const source = lstatSync(filePath)
    if (source.isDirectory()) throw new Error(`runtime 隔离源不能是目录：${basename(filePath)}`)
    if (deps?.expectedIdentity !== undefined && !sameIdentity(source, deps.expectedIdentity)) {
      throw new Error(`runtime 隔离源身份已替换：${basename(filePath)}`)
    }
    const identity: RuntimeFileIdentity = { dev: source.dev, ino: source.ino }
    assertLeafMissing(destinationPath, `runtime 隔离目标已存在：${basename(destinationPath)}`)
    verifyPinnedDirectory(parentPin, 'runtime 隔离提交前父目录身份复验失败')
    const sourceAtCommit = lstatSync(filePath)
    if (!sameIdentity(sourceAtCommit, identity) || !sameLeafKind(source, sourceAtCommit)) {
      throw new Error(`runtime 隔离提交前源身份已替换：${basename(filePath)}`)
    }
    deps?.beforeRename?.()
    renameSync(filePath, destinationPath)
    assertLeafMissing(filePath, 'runtime 隔离提交后源文件仍存在')
    const moved = lstatSync(destinationPath)
    if (!sameIdentity(moved, identity) || !sameLeafKind(source, moved)) {
      throw new Error('runtime 隔离提交后证据身份复验失败')
    }
    syncPinnedDirectory(parentPin, deps)
    assertLeafMissing(filePath, 'runtime 隔离 fsync 后源文件重新出现')
    const movedAfterSync = lstatSync(destinationPath)
    if (!sameIdentity(movedAfterSync, identity) || !sameLeafKind(source, movedAfterSync)) {
      throw new Error('runtime 隔离 fsync 后证据身份复验失败')
    }
    return identity
  } finally {
    closePinnedDirectory(parentPin)
  }
}

/** Bounded no-follow read for secondary runtime metadata. */
export function readPrivateFileNoFollow(
  filePath: string,
  maxBytes: number,
  options: PrivateFileReadOptions = {},
): PrivateFileRead {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { kind: 'unsafe' }
  const parent = dirname(filePath)
  let parentBefore: Stats
  try {
    parentBefore = inspectRealDirectory(parent, options.tightenMode !== false)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' }
  }
  let leafBefore: Stats
  try {
    leafBefore = lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unsafe' }
    try {
      const parentAfter = lstatSync(parent)
      return parentAfter.isDirectory()
        && !parentAfter.isSymbolicLink()
        && sameIdentity(parentBefore, parentAfter)
        ? { kind: 'missing' }
        : { kind: 'unsafe' }
    } catch {
      return { kind: 'unsafe' }
    }
  }
  if (leafBefore.isSymbolicLink() || !leafBefore.isFile() || leafBefore.nlink !== 1 || leafBefore.size > maxBytes) {
    return { kind: 'unsafe' }
  }

  let fd: number | null = null
  try {
    const openedFile = openPrivateNoFollowSync(filePath, 'read')
    fd = openedFile.fd
    const opened = openedFile.stats
    if (!opened.isFile() || opened.nlink !== 1 || !sameIdentity(leafBefore, opened) || opened.size > maxBytes) {
      return { kind: 'unsafe' }
    }
    if (options.tightenMode !== false && (opened.mode & 0o777) !== PRIVATE_RUNTIME_FILE_MODE) {
      fchmodSync(fd, PRIVATE_RUNTIME_FILE_MODE)
    }
    const beforeRead = fstatSync(fd)
    const beforeReadPrecise = fstatSync(fd, { bigint: true })
    if (!beforeRead.isFile() || beforeRead.nlink !== 1 || beforeRead.size > maxBytes) {
      return { kind: 'unsafe' }
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1)
    const read = options.read ?? readSync
    let offset = 0
    while (offset <= maxBytes) {
      const count = read(fd, buffer, offset, maxBytes + 1 - offset, null)
      if (count === 0) break
      offset += count
    }
    if (offset > maxBytes || offset !== beforeRead.size) return { kind: 'unsafe' }
    const after = fstatSync(fd)
    const afterPrecise = fstatSync(fd, { bigint: true })
    const leafAfter = lstatSync(filePath)
    const parentAfter = lstatSync(parent)
    if (!sameFileSnapshot(beforeRead, after)
      || !samePreciseFileSnapshot(beforeReadPrecise, afterPrecise)
      || !sameIdentity(after, leafAfter)
      || parentAfter.isSymbolicLink()
      || !parentAfter.isDirectory()
      || !sameIdentity(parentBefore, parentAfter)) return { kind: 'unsafe' }
    return {
      kind: 'valid',
      raw: buffer.subarray(0, offset).toString('utf8'),
      identity: { dev: after.dev, ino: after.ino },
    }
  } catch {
    return { kind: 'unsafe' }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* best effort */ }
    }
  }
}

/** Classify one leaf for destructive/selection decisions without following it:
 *  'regular' only for a uniquely-linked real file, 'missing' only for ENOENT;
 *  every other shape (symlink, directory, hard-linked, unreadable) is 'unsafe'
 *  so callers fail closed. */
export function classifyPrivateFileNoFollow(filePath: string): 'missing' | 'regular' | 'unsafe' {
  try {
    const info = lstatSync(filePath)
    return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 ? 'regular' : 'unsafe'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
  }
}

/** Fsync one uniquely-linked private regular file, re-proving the leaf identity
 *  across the open (kernel O_NOFOLLOW where available, the win32 user-space
 *  fallback otherwise) and again after the sync. Symlinked, non-regular and
 *  multiply-linked leaves are refused. */
export function syncPrivateFileNoFollow(
  filePath: string,
  label = 'runtime 私有文件',
  deps?: PrivateFsDurabilityDeps,
): void {
  const before = lstatSync(filePath)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error(`${label} 不是单链接普通文件`)
  }
  const opened = openPrivateNoFollowSync(filePath, 'read')
  try {
    const info = fstatSync(opened.fd)
    if (!info.isFile() || info.nlink !== 1 || !sameIdentity(before, info)) {
      throw new Error(`${label} fsync 前身份复验失败`)
    }
    syncFd(opened.fd, deps)
    const after = fstatSync(opened.fd)
    const atPath = lstatSync(filePath)
    if (!after.isFile()
      || after.nlink !== 1
      || atPath.isSymbolicLink()
      || !atPath.isFile()
      || atPath.nlink !== 1
      || !sameIdentity(after, atPath)) {
      throw new Error(`${label} fsync 后身份复验失败`)
    }
  } finally {
    closeSync(opened.fd)
  }
}

/** Fsync one real directory, re-proving the directory AND its parent identity
 *  across the sync (no mode tightening). Directory fsync is a filesystem
 *  property, not a platform one: NFS/CIFS/FUSE mounts may reject it with
 *  EINVAL/ENOTSUP on any platform, so exactly those two codes are tolerated —
 *  every other failure, and any identity drift, is thrown. */
export function syncPrivateDirectoryNoFollow(
  dirPath: string,
  label = 'runtime 私有目录',
  deps?: PrivateFsDurabilityDeps,
): void {
  const pin = pinRealDirectory(dirPath, false)
  try {
    verifyPinnedDirectory(pin, `${label} fsync 前身份复验失败：${basename(dirPath)}`)
    try {
      syncFd(pin.fd, deps)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error
    }
    verifyPinnedDirectory(pin, `${label} fsync 后身份复验失败：${basename(dirPath)}`)
  } finally {
    closePinnedDirectory(pin)
  }
}

/** Failure phase of {@link openPrivateNoFollowReadAsync}: callers map it onto
 *  their own error surface without re-implementing the fallback strategy. */
export type PrivateNoFollowOpenPhase =
  | 'symlink'
  | 'precheck-failed'
  | 'open-failed'
  | 'inspect-failed'
  | 'identity-mismatch'

/** Typed open failure of the async no-follow reader. `detail` carries the raw
 *  OS error for the caller's own sanitizer. */
export class PrivateNoFollowOpenError extends Error {
  readonly phase: PrivateNoFollowOpenPhase
  readonly detail: unknown

  constructor(phase: PrivateNoFollowOpenPhase, message: string, detail?: unknown) {
    super(message)
    this.name = 'PrivateNoFollowOpenError'
    this.phase = phase
    this.detail = detail
  }
}

/**
 * Async sibling of openPrivateNoFollowSync for callers that must not block
 * (the activation probe reads settings.yaml inside a bounded transaction
 * window). Same platform strategy: the kernel O_NOFOLLOW where available, and
 * otherwise an lstat immediately before the open plus an lstat identity
 * re-proof (dev/ino) immediately after it. The returned handle is owned by the
 * caller; the accompanying stats are the post-open snapshot.
 */
export async function openPrivateNoFollowReadAsync(
  filePath: string,
  constantsLike: NoFollowConstantsLike = constants,
): Promise<{ handle: FileHandle; stats: Stats }> {
  const { flags, kernelNoFollow } = resolveNoFollowFlags('read', constantsLike)
  if (!kernelNoFollow) {
    let before: Stats
    try {
      before = await lstatAsync(filePath)
    } catch (error) {
      throw new PrivateNoFollowOpenError('precheck-failed', `私有路径打开前检查失败：${basename(filePath)}`, error)
    }
    if (before.isSymbolicLink()) {
      throw new PrivateNoFollowOpenError('symlink', `私有路径的最终组件是符号链接，拒绝打开：${basename(filePath)}`)
    }
  }
  let handle: FileHandle
  try {
    handle = await openAsync(filePath, flags)
  } catch (error) {
    throw new PrivateNoFollowOpenError('open-failed', `私有路径打开失败：${basename(filePath)}`, error)
  }
  try {
    let stats: Stats
    try {
      stats = await handle.stat()
    } catch (error) {
      throw new PrivateNoFollowOpenError('inspect-failed', `私有路径打开后检查失败：${basename(filePath)}`, error)
    }
    if (!kernelNoFollow) {
      let atPath: Stats
      try {
        atPath = await lstatAsync(filePath)
      } catch (error) {
        throw new PrivateNoFollowOpenError('inspect-failed', `私有路径打开后检查失败：${basename(filePath)}`, error)
      }
      if (atPath.isSymbolicLink() || !sameIdentity(stats, atPath)) {
        throw new PrivateNoFollowOpenError('identity-mismatch', `私有路径打开后身份复验失败：${basename(filePath)}`)
      }
    }
    return { handle, stats }
  } catch (error) {
    await handle.close().catch(() => { /* best effort */ })
    throw error
  }
}
