/**
 * ssh-socket.ts — POSIX Unix-domain-socket naming for the `ssh -L` tunnel.
 *
 * The tunnel's local listener is a filesystem socket instead of a loopback TCP
 * port: no ephemeral-port allocator, no port-reuse race and no other local
 * process can connect to it (the parent directory is 0700). The remote side of
 * the forward stays `127.0.0.1:<remotePort>`.
 *
 * Path shape (single source for argv, probes, proxy registration and cleanup):
 *   <tmpdir>/dsh-chamber-ssh-<uid>/<sha256(instance id)[0..16]>.sock
 *
 * - the per-uid directory keeps the file namespace owner-only even on a shared
 *   /tmp, and is created/verified 0700 before ssh may bind in it;
 * - the file name is a hash, never the raw instance id: an id is user-chosen
 *   and the file name must stay a bounded, case-insensitive-safe identifier
 *   that can never collide with a path separator or a dot-dot segment;
 * - the path is checked against SSH_SOCKET_PATH_MAX_BYTES before any use: a
 *   sockaddr_un has a hard platform cap (Linux 108 / macOS 104 bytes including
 *   the terminating NUL) and a silently truncated `-L` argument would forward
 *   nowhere or, worse, bind a DIFFERENT path.
 *
 * Windows keeps the loopback TCP forward (%TEMP% paths plus Windows ssh.exe
 * argument quirks are not worth a second data path; design 23).
 *
 * Pure Node: no electron, no child process.
 */
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Directory prefix (immediately followed by the numeric uid). */
export const SSH_SOCKET_DIR_PREFIX = 'dsh-chamber-ssh-'
/** Socket file suffix; cleanup only ever removes files carrying it. */
export const SSH_SOCKET_FILE_SUFFIX = '.sock'
/**
 * Name-length ceiling in BYTES: Linux uses sun_path[108] and macOS sun_path[104]
 * (both include the trailing NUL), so 107/103 are the real maxima; keep the
 * platform-specific value and fail loudly instead of binding a truncated path.
 */
export const SSH_SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 103 : 107
/** Hex characters of sha256(instance id) kept in the file name. */
export const SSH_SOCKET_ID_HASH_CHARS = 16
/** Per-runtime-root namespace (8 hex chars of sha256(runtimeBaseDir)). */
let socketNamespace = ''

/** Namespace the socket directory by the app's runtime root. Two chamber roots
 *  can run for the same uid (dev + packaged, two worktrees); without this both
 *  would bind the same <id> socket and the later one would steal the listener.
 *  Call once during host assembly, before any transport spawns. */
export function configureSshSocketNamespace(runtimeBaseDir: string | null): void {
  if (runtimeBaseDir === null || runtimeBaseDir === '') { socketNamespace = ''; return }
  socketNamespace = createHash('sha256').update(runtimeBaseDir, 'utf8').digest('hex').slice(0, 8)
}

export interface SshSocketPathOptions {
  /** Base tmp dir override (tests); defaults to os.tmpdir(). */
  tmpDir?: string
  /** UID override (tests); defaults to process.getuid() or 0 when unavailable. */
  uid?: number
  /** Platform override (tests); defaults to process.platform. */
  platform?: NodeJS.Platform
}

/** True on the platforms that use the UDS tunnel shape (everything but win32). */
export function sshUdsSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

function effectiveUid(uid: number | undefined): number {
  if (uid !== undefined) return uid
  return typeof process.getuid === 'function' ? process.getuid() : 0
}

/** The per-uid owner-only directory holding this user's tunnel sockets. */
export function sshSocketDir(options: SshSocketPathOptions = {}): string {
  const base = options.tmpDir ?? tmpdir()
  const suffix = socketNamespace === '' ? '' : `-${socketNamespace}`
  return join(base, `${SSH_SOCKET_DIR_PREFIX}${String(effectiveUid(options.uid))}${suffix}`)
}

/** The socket file name for one instance id (pure; deterministic). */
export function sshSocketFileName(id: string): string {
  if (typeof id !== 'string' || id === '') throw new TypeError('ssh socket: instance id must be a non-empty string')
  const digest = createHash('sha256').update(id, 'utf8').digest('hex')
  return `${digest.slice(0, SSH_SOCKET_ID_HASH_CHARS)}${SSH_SOCKET_FILE_SUFFIX}`
}

/** The full socket path for one instance id, with the sockaddr_un length check. */
export function sshSocketPath(id: string, options: SshSocketPathOptions = {}): string {
  const path = join(sshSocketDir(options), sshSocketFileName(id))
  const bytes = Buffer.byteLength(path, 'utf8')
  if (bytes > SSH_SOCKET_PATH_MAX_BYTES) {
    // Never echo the full path (it contains the user's tmpdir) — the dir is enough
    // to diagnose, and the instance id is already in the caller's context.
    throw new Error(`ssh UDS path is too long: ${String(bytes)} bytes exceeds the ${String(SSH_SOCKET_PATH_MAX_BYTES)}-byte sockaddr_un budget (tmpdir too deep)`)
  }
  return path
}

/**
 * Create/verify the owner-only directory for one ALREADY-RESOLVED socket path and
 * return that path. The path is re-checked against the sockaddr_un budget (the
 * caller may be a provider receiving a pre-resolved path); a symlink or a
 * non-directory at the directory is a loud failure (a planted symlink would
 * redirect the chmod/bind), and permissions are re-tightened to 0700.
 */
export function ensureSshSocketDirectory(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\u0000')) {
    throw new Error('ssh UDS path must be an absolute filesystem path')
  }
  const bytes = Buffer.byteLength(path, 'utf8')
  if (bytes > SSH_SOCKET_PATH_MAX_BYTES) {
    throw new Error(`ssh UDS path is too long: ${String(bytes)} bytes exceeds the ${String(SSH_SOCKET_PATH_MAX_BYTES)}-byte sockaddr_un budget (tmpdir too deep)`)
  }
  const dir = dirname(path)
  let stat: ReturnType<typeof lstatSync> | null = null
  try {
    stat = lstatSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (stat !== null) {
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('ssh UDS directory is not a plain directory (refusing a planted symlink/file)')
    }
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  chmodSync(dir, 0o700)
  return path
}
