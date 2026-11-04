/**
 * Ephemeral SSH askpass material (design 05 §8): a fresh helper per ssh child, living in an
 * unguessable 0700 process-private directory, removed when the child's lease releases.
 *
 * Two transports, preferred order:
 * - FIFO (POSIX): a NON-SECRET helper script plus a 0600 FIFO in the same 0700 directory.
 *   The parent writes the password into the FIFO only after ssh actually runs the helper
 *   for a password/passphrase prompt, so the secret never lands on disk. A polling writer
 *   (non-blocking O_WRONLY opens) pairs with each askpass invocation and stops with the lease.
 * - Legacy script: the password is embedded in the 0700 helper (the documented fallback for
 *   platforms/filesystems without mkfifo). Selected automatically when FIFO creation fails.
 *
 * Prompt classification is shared and FAIL-CLOSED: only password/passphrase prompts are
 * answered; host-key confirmations, OTP/one-time-password, verification codes and
 * password-change prompts receive NO answer (P0-3: the app never auto-accepts a host key).
 *
 * v1 does NOT support keyboard-interactive (server-side 2FA / OTP / password change): such
 * hosts must use SSH key authentication. The helper deliberately answers every
 * keyboard-interactive sub-prompt with nothing, so ssh fails loudly instead of looping.
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, rmdirSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSTANCE_ID_PATTERN } from './transport-provider.ts'

/** Env var naming the FIFO the parent writes the password to (path only — never the secret). */
export const ASKPASS_PASSWORD_FIFO_ENV = 'DSH_CHAMBER_SSH_PASSWORD_FIFO'

const ASKPASS_DIR_PREFIX = 'dsh-chamber-ssh-'
const LEGACY_ASKPASS_DIR_NAME = 'dsh-chamber-ssh'
let processAskpassDir: string | null = null

/**
 * The ephemeral askpass helper body: a sh script answering ssh's non-TTY prompts — password/
 * passphrase prompts with the stored password, and EVERYTHING ELSE with NO answer (fail-closed).
 * Host-key confirmations are NOT answered: the app never auto-accepts a host key (P0-3); an
 * unknown/changed host must fail the tunnel and go through the app-owned known_hosts trust flow.
 * ssh passes the prompt as argv[1]; prompts are matched textually.
 *
 * Legacy transport: the password is embedded (sh-safely quoted) in this 0700 file.
 */
export function buildAskpassScript(password: string): string {
  const escaped = password.replace(/'/g, "'\\''")
  return [
    '#!/bin/sh',
    '# dsh-chamber ssh password helper (ephemeral, 0700, deleted after child exit)',
    // Normalize the prompt to lowercase ONCE (tr is POSIX): every pattern matches the NORMALIZED
    // text, so all branches are case-insensitive for any casing variant. A per-word bracket
    // approach would only cover the first character and leak the password for "One-time Password:".
    'case "$(printf "%s" "$1" | tr "A-Z" "a-z")" in',
    // Explicit non-credential exclusions BEFORE the password branch: prompts whose wording also
    // contains "password:" (OTP/verification code, password change) must never receive it. The otp
    // match is boundary-scoped so a host/user name like "otp-host" cannot shadow a real prompt.
    '  *"one-time password"*|*"otp:"*|*"otp "*|*"verification code"*|*"new password"*|*"change your password"*)',
    '    exit 0',
    '    ;;',
    '  *"password:"*|*"password for "*|*"passphrase"*)',
    '    printf \'%s\\n\' \'' + escaped + '\'',
    '    ;;',
    '  *)',
    '    # Fail closed: any prompt that is not a password/passphrase prompt',
    '    # (host-key yes/no, OTP/verification code, password change, unknown',
    '    # wording) gets NO answer — ssh fails instead of receiving the password',
    '    # or silently trusting a host key.',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

/**
 * FIFO transport helper body: identical prompt classification, but the answer is read from the
 * private FIFO the parent writes into. The file itself carries no secret; the prompt is only
 * answered when a password/passphrase prompt is classified, so a host-key/OTP prompt never
 * causes the parent to write at all.
 */
export function buildAskpassFifoScript(): string {
  const fifoReference = '"$' + ASKPASS_PASSWORD_FIFO_ENV + '"'
  return [
    '#!/bin/sh',
    '# dsh-chamber ssh password helper (ephemeral, 0700, deleted after child exit)',
    '# The password is NOT in this file: the parent answers through the private 0600 FIFO',
    '# named by ' + ASKPASS_PASSWORD_FIFO_ENV + ' only for a classified password prompt.',
    'case "$(printf "%s" "$1" | tr "A-Z" "a-z")" in',
    '  *"one-time password"*|*"otp:"*|*"otp "*|*"verification code"*|*"new password"*|*"change your password"*)',
    '    exit 0',
    '    ;;',
    '  *"password:"*|*"password for "*|*"passphrase"*)',
    '    cat ' + fifoReference,
    '    ;;',
    '  *)',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

/** One created askpass credential pair: the executable ssh runs plus the optional secret FIFO. */
export interface AskpassArtifact {
  /** SSH_ASKPASS executable (carries no secret in FIFO mode). */
  path: string
  /** Private 0600 FIFO the parent writes the password into; null = legacy embedded script. */
  fifo: string | null
  /** Idempotent removal of every artifact (FIFO + script). */
  cleanup(): void
}

/** Knobs for the two transports; both exist so the fallback is testable, not inferred. */
export interface AskpassArtifactOptions {
  /** 'script' forces the documented no-FIFO fallback (platform/filesystem without mkfifo). */
  transport?: 'fifo' | 'script'
  /** mkfifo seam (diagnostics/tests): a throwing implementation exercises automatic fallback. */
  createFifo?: (path: string) => void
}

/** Fail-closed ownership/type/mode gate for an askpass directory: a helper is password-bearing
 *  executable code, so chmod-ing a directory pre-created by another OS user is not enough and EPERM
 *  must never degrade into continuing inside it. The before/after inode check detects replacement. */
export function chmodAskpassDirOwnerOnly(dir: string): void {
  const before = lstatSync(dir)
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`SSH askpass path must be a private directory (symlinks/non-directories are refused): ${dir}`)
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
  if (currentUid !== null && before.uid !== currentUid) {
    throw new Error(`SSH askpass directory is owned by uid ${before.uid}, expected ${currentUid}: ${dir}`)
  }
  // Deliberately let EPERM propagate: continuing would let the directory owner
  // replace our helper between creation and OpenSSH execution.
  chmodSync(dir, 0o700)
  const after = lstatSync(dir)
  if (!after.isDirectory() || after.isSymbolicLink()
    || after.dev !== before.dev || after.ino !== before.ino
    || (currentUid !== null && after.uid !== currentUid)
    || (after.mode & 0o077) !== 0) {
    throw new Error(`SSH askpass directory failed owner-only inode verification: ${dir}`)
  }
}

/** Create one unguessable process-private leaf (the global `<tmpdir>/dsh-chamber-ssh` is never
 *  reused, so another OS user cannot pre-claim the directory). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function privateAskpassDir(): string {
  if (processAskpassDir !== null) {
    try {
      chmodAskpassDirOwnerOnly(processAskpassDir)
      return processAskpassDir
    } catch (error) {
      // tmpfiles cleanup or another root can remove the (empty) leaf; a cached
      // path must not poison every later spawn. Drop it and create a new leaf.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ESTALE') throw error
      processAskpassDir = null
    }
  }
  const created = mkdtempSync(join(tmpdir(), `${ASKPASS_DIR_PREFIX}${process.pid}-`))
  try {
    chmodAskpassDirOwnerOnly(created)
  } catch (error) {
    try { rmSync(created, { recursive: true, force: true }) } catch { /* best effort */ }
    throw error
  }
  processAskpassDir = created
  return created
}

/**
 * Publish one helper file: O_EXCL, mode 0600 while the body is written, then 0700 only after
 * fsync — a partially written helper is never executable, and a restrictive umask can never
 * strip the execute bit OpenSSH requires.
 */
function writeAskpassHelperFile(id: string, token: string, body: string): string {
  const dir = privateAskpassDir()
  const path = join(dir, `askpass-${id}.pid-${process.pid}.${token}.sh`)
  try {
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, body)
      fsyncSync(fd)
      fchmodSync(fd, 0o700)
    } finally {
      closeSync(fd)
    }
    return path
  } catch (error) {
    // Never strand an untracked password-bearing helper after a failed write or chmod.
    rmSync(path, { force: true })
    throw error
  }
}

/** Write one ephemeral legacy askpass helper (password embedded) for an instance; returns its path. */
export function createAskpassHelper(id: string, password: string): string {
  // The id lands in the temp filename — refuse anything outside the registry whitelist (defense in
  // depth; the IPC gate already enforces this before a password can be stored).
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing askpass helper for invalid instance id ${JSON.stringify(id)}`)
  }
  return writeAskpassHelperFile(id, randomUUID(), buildAskpassScript(password))
}

/**
 * Create the FIFO the parent writes the password into: mode 0600, owned by this process, and
 * verified to really be a FIFO (a pre-planted file/symlink is refused, never chmod'd into trust).
 * `mkfifo` is the POSIX utility (Node has no FIFO API); its absence is the documented fallback.
 */
function createPrivateFifo(path: string): void {
  const result = spawnSync('mkfifo', ['-m', '600', path], { stdio: 'ignore' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`mkfifo exited with status ${String(result.status)} for ${path}`)
  // `-m` is subject to the umask; make the owner-only 0600 guarantee explicit.
  chmodSync(path, 0o600)
  const stats = lstatSync(path)
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null
  if (!stats.isFIFO() || (currentUid !== null && stats.uid !== currentUid) || (stats.mode & 0o077) !== 0) {
    throw new Error(`SSH askpass FIFO failed owner-only verification: ${path}`)
  }
}

function makeAskpassArtifact(path: string, fifo: string | null): AskpassArtifact {
  let cleaned = false
  return {
    path,
    fifo,
    cleanup() {
      if (cleaned) return
      cleaned = true
      if (fifo !== null) {
        try { rmSync(fifo, { force: true }) } catch { /* best effort */ }
      }
      try { rmSync(path, { force: true }) } catch { /* best effort */ }
    },
  }
}

/**
 * Create one ephemeral askpass credential for a single ssh child. FIFO transport is preferred;
 * any FIFO creation failure (mkfifo missing/not permitted, exotic filesystem) falls back to the
 * legacy embedded script in the SAME 0700 directory — never to a plaintext file elsewhere.
 */
export function createAskpassArtifact(
  id: string,
  password: string,
  options: AskpassArtifactOptions = {},
): AskpassArtifact {
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing askpass helper for invalid instance id ${JSON.stringify(id)}`)
  }
  if (options.transport !== 'script') {
    const token = randomUUID()
    const dir = privateAskpassDir()
    const fifo = join(dir, `askpass-${id}.pid-${process.pid}.${token}.fifo`)
    try {
      ;(options.createFifo ?? createPrivateFifo)(fifo)
      const path = writeAskpassHelperFile(id, token, buildAskpassFifoScript())
      return makeAskpassArtifact(path, fifo)
    } catch {
      // Fall back to the documented 0700 embedded script; never strand a half-created FIFO.
      try { rmSync(fifo, { force: true }) } catch { /* best effort */ }
    }
  }
  return makeAskpassArtifact(createAskpassHelper(id, password), null)
}

/** The env handed to exactly one ssh spawn; null FIFO = the legacy script carries the answer. */
export function askpassLeaseEnvironment(artifact: AskpassArtifact): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { SSH_ASKPASS: artifact.path, SSH_ASKPASS_REQUIRE: 'force' }
  if (artifact.fifo !== null) env[ASKPASS_PASSWORD_FIFO_ENV] = artifact.fifo
  return env
}

/** A running FIFO writer: one per ssh child, stopped by the auth lease at child exit. */
export interface AskpassFifoWriter {
  stop(): void
}

const FIFO_WRITER_INITIAL_DELAY_MS = 25
const FIFO_WRITER_MAX_DELAY_MS = 1000

/**
 * Answer askpass invocations for one live ssh child without ever writing the password to disk.
 * The FIFO is opened O_WRONLY|O_NONBLOCK: ENXIO simply means ssh has not run the helper yet, so
 * the writer retries with backoff (unref'd timer). Once a reader appears the payload is written
 * and the writer keeps polling for a later prompt (ssh may retry authentication). The lease stops
 * it at child exit; the payload is bounded by MAX_SSH_PASSWORD_CHARS and handled with a
 * partial-write loop so a non-blocking pipe can never truncate a long password.
 */
export function startAskpassFifoWriter(fifo: string, password: string): AskpassFifoWriter {
  const payload = Buffer.from(`${password}\n`, 'utf8')
  let stopped = false
  let fd: number | null = null
  let offset = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = FIFO_WRITER_INITIAL_DELAY_MS
  const closeFd = (): void => {
    if (fd === null) return
    try { closeSync(fd) } catch { /* best effort */ }
    fd = null
  }
  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(attempt, delay)
    timer.unref?.()
  }
  const attempt = (): void => {
    timer = null
    if (stopped) return
    try {
      if (fd === null) {
        fd = openSync(fifo, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK)
        offset = 0
      }
      while (offset < payload.length) {
        const written = writeSync(fd, payload, offset, payload.length - offset)
        if (written <= 0) throw Object.assign(new Error('askpass FIFO write returned no progress'), { code: 'EAGAIN' })
        offset += written
      }
      closeFd()
      offset = 0
      delay = FIFO_WRITER_INITIAL_DELAY_MS
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (fd !== null && (code === 'EAGAIN' || code === 'EINTR')) {
        // The reader is alive but the pipe is momentarily full: keep the fd and finish next tick.
        delay = FIFO_WRITER_INITIAL_DELAY_MS
      } else {
        // ENXIO (no askpass reader yet) / EPIPE (reader exited before reading) / ENOENT:
        // start over for the next reader. The lease, not an individual attempt, owns the lifetime.
        closeFd()
        offset = 0
        delay = Math.min(delay * 2, FIFO_WRITER_MAX_DELAY_MS)
      }
    }
    schedule()
  }
  schedule()
  return {
    stop() {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      closeFd()
    },
  }
}

/** Remove password-bearing helpers/FIFOs left by a hard crash before transports start. */
export function cleanupStaleAskpassHelpers(tempRoot: string = tmpdir()): string | null {
  // Test seam: callers may inject an isolated root; production always uses tmpdir().
  const root = tempRoot
  const notices: string[] = []
  try {
    for (const dirName of readdirSync(root)) {
      // Only askpass leaves: <prefix><pid>-<6 random> (and the historical exact
      // directory). Socket dirs are <prefix><uid> or <prefix><uid>-<8 hex> and
      // must never be chmod'd or rmdir'd here (R4 blocker: shared prefix).
      // mkdtemp appends exactly six random alphanumerics; the UDS namespace is
      // <prefix><uid>-<8 hex>, so a shape check keeps the two trees disjoint.
      const askpassDir = dirName === LEGACY_ASKPASS_DIR_NAME
        || /^dsh-chamber-ssh-\d+-[A-Za-z0-9]{6}$/.test(dirName)
      if (!askpassDir) continue
      const ownerPid = /^dsh-chamber-ssh-(\d+)-/.exec(dirName)
      if (ownerPid !== null && processAlive(Number(ownerPid[1]))) {
        // A live process owns this leaf; even an empty moment is not a crash
        // leftover (its next helper may be about to be written).
        continue
      }
      const dir = join(root, dirName)
      try {
        // Cross-user/pre-claimed directories are reported and skipped: never used by
        // privateAskpassDir, and their files are never mutated.
        chmodAskpassDirOwnerOnly(dir)
      } catch (error) {
        notices.push(`refused untrusted SSH askpass directory ${dir}: ${String(error)}`)
        continue
      }
      for (const name of readdirSync(dir)) {
        const current = /^askpass-[a-zA-Z0-9_-]{1,64}\.pid-(\d+)\.[0-9a-f-]+\.(?:sh|fifo)$/i.exec(name)
        // Legacy names predate PID ownership and can only be crash leftovers.
        if (current === null) {
          if (/^askpass-[a-zA-Z0-9_-]{1,64}-[0-9a-f-]+\.sh$/i.test(name)) rmSync(join(dir, name), { force: true })
          continue
        }
        const pid = Number(current[1])
        let ownerAlive = false
        try {
          process.kill(pid, 0)
          ownerAlive = true
        } catch (probeError) {
          // EPERM means a live process we may not signal; only ESRCH makes deletion safe.
          ownerAlive = (probeError as NodeJS.ErrnoException).code !== 'ESRCH'
        }
        if (!ownerAlive) rmSync(join(dir, name), { force: true })
      }
      // Reclaim an empty crash directory, but keep this process's private leaf stable.
      if (dir !== processAskpassDir && readdirSync(dir).length === 0) {
        try { rmdirSync(dir) } catch { /* a concurrent owner may have populated it */ }
      }
    }
    return notices.length === 0 ? null : notices.join('; ')
  } catch (error) {
    return `cannot clean stale SSH askpass helpers: ${String(error)}`
  }
}
