/**
 * dsh runtime installer (design 18 §4).
 *
 * The top-level package is downloaded exactly once from the source-bound
 * registry resolution, streamed through SRI verification, and handed to pnpm
 * as a local tarball. pnpm therefore cannot re-resolve the top-level package
 * from newer registry metadata between check and install. Transitive
 * dependencies remain pinned to the same explicit registry and their own npm
 * integrity records.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { ALLOW_BUILDS } from './allow-builds.mjs'
import { validateVersionTree } from './dsh-runtime-store.ts'
import type { RuntimeInstallResolution } from './dsh-runtime-updater.ts'
import { createIntegrityVerifier, isSupportedIntegrity } from './registry-integrity.ts'
import { fetchRegistryResponse } from './registry-metadata.ts'
import { canonicalRegistryOrigin, isAllowedRegistryUrl, registryRedirectOrigins } from './registry-url.ts'
import { sanitizeErrorText } from './sanitize-error.ts'
import { assertSafeVersion } from './version-safety.ts'

export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000
export const INSTALL_TERMINATE_GRACE_MS = 1_000
export const INSTALL_OUTPUT_LIMIT_BYTES = 64 * 1024
export const DEFAULT_TARBALL_MAX_BYTES = 512 * 1024 * 1024

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  stdoutTruncated?: boolean
  stderrTruncated?: boolean
}

export interface RunOptions {
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
  /** Records the actual direct child PID in the owning work directory. */
  onSpawn?: (pid: number) => void
}

export interface PruneResult {
  removedFiles: number
  removedDirs: number
}

export interface SmokeContext {
  signal: AbortSignal
  onSpawn: (pid: number) => void
}

/** Live install progress (design 18 M4 renderer progress bar): byte progress
 * during 'download' (total = content-length when the registry declares it),
 * stage-only milestones afterwards. The terminal 'done' clears the bar. */
export type RuntimeInstallProgress =
  | { stage: 'download'; received: number; total: number | null }
  | { stage: 'install' | 'prune' | 'smoke' | 'publish' | 'done' }

export interface InstallerDeps {
  /** Node executable used to run pnpm + the smoke check. */
  node: () => { file: string; args: string[]; env: Record<string, string> }
  /** Spawn a command to completion. */
  run: (args: string[], opts: RunOptions) => Promise<RunResult>
  /** Download and verify the already-bound top-level package tarball. */
  download: (
    resolution: RuntimeInstallResolution,
    destination: string,
    opts: { signal: AbortSignal; onProgress?: (received: number, total: number | null) => void },
  ) => Promise<void>
  /** Prune the installed tree (prune-runtime semantics, design 18 §4). */
  prune: (root: string) => Promise<PruneResult>
  /** Smoke: assert the installed CLI reports exactly `version`. */
  smoke: (workDir: string, version: string, context: SmokeContext) => Promise<void>
  /** Filesystem seams keep the publish transaction fault-injectable. */
  rename: (source: string, destination: string) => void
  makeReadOnly: (root: string) => void
  verifyPublished: (root: string, version: string) => void
}

export interface InstallOptions {
  /** `<userData>/dsh-runtime` — version trees, store and work dirs live here. */
  baseDir: string
  /** Metadata-origin + tarball + SRI tuple minted by bindRuntimeInstallResolution. */
  resolution: RuntimeInstallResolution
  /** Path to `pnpm.cjs` (embedded pnpm; resolved by the caller for dev vs packaged). */
  pnpmEntry: string
  /** Optional caller cancellation (application quit, explicit cancel). */
  signal?: AbortSignal
  /** One wall-clock budget across download, both install attempts, prune and smoke. */
  timeoutMs?: number
  /** Live progress callback (design 18 M4): the controller forwards it to
   * the renderer projection, throttled. */
  onProgress?: (progress: RuntimeInstallProgress) => void
  deps?: Partial<InstallerDeps>
}

export interface InstallResult {
  versionTreeDir: string
  resolvedVersion: string
}

type InstallFailureStage = 'prepare' | 'download' | 'install' | 'prune' | 'smoke' | 'manifest' | 'publish' | 'finalize'

const CRITICAL_RUNTIME_FILES = [
  'node_modules/@deepseek-ai/dsh/package.json',
  'node_modules/@deepseek-ai/dsh/lib/bin.js',
] as const
const FAILED_ERROR_LIMIT = 2_000

/** Only variables pnpm/network needs may cross the process boundary. */
const INSTALL_ENV_WHITELIST = /^(PATH|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)$/

export function scrubInstallEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (INSTALL_ENV_WHITELIST.test(key) && value !== undefined) out[key] = value
  }
  return out
}

function sanitizeInstallerOutput(raw: string, limit: number): string {
  const withoutUrlSecrets = raw.replace(/https?:\/\/[^\s"'<>]+/gi, (token) => {
    try {
      const url = new URL(token)
      // Signed registry URLs can carry a capability in userinfo, query, or a
      // path segment. The origin is enough for a renderer-facing diagnosis.
      return `${url.protocol}//${url.host}/[redacted]`
    } catch {
      return '[url]'
    }
  })
  const withoutNamedSecrets = withoutUrlSecrets.replace(
    /\b(token|password|passwd|secret|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
    '$1=[redacted]',
  )
  const sanitized = sanitizeErrorText(withoutNamedSecrets)
  if (Buffer.byteLength(sanitized) <= limit) return sanitized
  return Buffer.from(sanitized).subarray(0, limit).toString('utf8').replace(/\uFFFD$/u, '')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function criticalFilePath(root: string, relativePath: typeof CRITICAL_RUNTIME_FILES[number]): string {
  const rootReal = realpathSync(root)
  const candidate = join(root, relativePath)
  const info = lstatSync(candidate)
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`runtime critical file is not a regular file: ${relativePath}`)
  }
  const fileReal = realpathSync(candidate)
  const fromRoot = relative(rootReal, fileReal)
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    throw new Error(`runtime critical file escapes the version tree: ${relativePath}`)
  }
  return candidate
}

function sha256File(root: string, relativePath: typeof CRITICAL_RUNTIME_FILES[number]): string {
  return `sha256-${createHash('sha256').update(readFileSync(criticalFilePath(root, relativePath))).digest('base64')}`
}

function assertRuntimePackageIdentity(root: string, version: string): void {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(criticalFilePath(root, CRITICAL_RUNTIME_FILES[0]), 'utf8')) as unknown
  } catch (error) {
    throw new Error(`runtime package manifest is missing or invalid: ${sanitizeInstallerOutput(errorMessage(error), 300)}`)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('runtime package manifest has an invalid shape')
  }
  const record = manifest as Record<string, unknown>
  if (record.name !== '@deepseek-ai/dsh' || record.version !== version) {
    throw new Error(`runtime package identity mismatch (wanted @deepseek-ai/dsh@${version})`)
  }
}

function computeCriticalDigests(root: string, version: string): Record<typeof CRITICAL_RUNTIME_FILES[number], string> {
  assertRuntimePackageIdentity(root, version)
  return Object.fromEntries(CRITICAL_RUNTIME_FILES.map((relativePath) => [relativePath, sha256File(root, relativePath)])) as Record<typeof CRITICAL_RUNTIME_FILES[number], string>
}

/** Re-read the published manifest and its execution-critical files. This is
 * deliberately exported so startup validation can adopt the same check
 * without changing the install format. */
export function verifyRuntimeTreeCriticalFiles(root: string, version: string): void {
  const safeVersion = assertSafeVersion(version)
  let rootManifest: unknown
  try {
    rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown
  } catch (error) {
    throw new Error(`published runtime manifest is missing or invalid: ${sanitizeInstallerOutput(errorMessage(error), 300)}`)
  }
  if (rootManifest === null || typeof rootManifest !== 'object' || Array.isArray(rootManifest)) {
    throw new Error('published runtime manifest has an invalid shape')
  }
  const dsh = (rootManifest as Record<string, unknown>).dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) {
    throw new Error('published runtime manifest is missing dsh metadata')
  }
  const rawDigests = (dsh as Record<string, unknown>).criticalFiles
  if (rawDigests === null || typeof rawDigests !== 'object' || Array.isArray(rawDigests)) {
    throw new Error('published runtime manifest is missing critical-file digests')
  }
  const expected = rawDigests as Record<string, unknown>
  const expectedKeys = Object.keys(expected).sort()
  const requiredKeys = [...CRITICAL_RUNTIME_FILES].sort()
  if (expectedKeys.length !== requiredKeys.length || expectedKeys.some((key, index) => key !== requiredKeys[index])) {
    throw new Error('published runtime critical-file set is incomplete')
  }
  assertRuntimePackageIdentity(root, safeVersion)
  for (const relativePath of CRITICAL_RUNTIME_FILES) {
    const digest = expected[relativePath]
    if (typeof digest !== 'string' || !/^sha256-[A-Za-z0-9+/]{43}=$/.test(digest)) {
      throw new Error(`published runtime has an invalid digest for ${relativePath}`)
    }
    if (sha256File(root, relativePath) !== digest) {
      throw new Error(`published runtime critical-file digest mismatch: ${relativePath}`)
    }
  }
}

/** Remove write bits without following symlinks. The runtime root lives below
 * an owner-only directory, so preserving existing read/execute bits is both
 * sufficient and safer for native executables than inventing modes. */
function makeRuntimeTreeReadOnly(root: string): void {
  const visit = (entryPath: string): void => {
    const info = lstatSync(entryPath)
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      for (const entry of readdirSync(entryPath)) visit(join(entryPath, entry))
    } else if (!info.isFile()) {
      throw new Error('runtime version tree contains an unsupported special file')
    }
    const readOnlyMode = info.isDirectory()
      ? (info.mode & ~0o222) | 0o500
      : (info.mode & ~0o222) | 0o400
    chmodSync(entryPath, readOnlyMode)
  }
  visit(root)
}

function makeOwnedTreeWritable(root: string): void {
  if (!existsSync(root)) return
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
  try { visit(root) } catch { /* rmSync below remains authoritative */ }
}

function removeOwnedTree(root: string): void {
  if (!existsSync(root)) return
  makeOwnedTreeWritable(root)
  rmSync(root, { recursive: true, force: true })
}

function failedScenePath(runtimeDir: string, version: string): string {
  return join(runtimeDir, `${assertSafeVersion(version)}.failed`)
}

/** Keep exactly one compact, path-free scene per failed version. Partial
 * node_modules/tarballs/PIDs are intentionally excluded, bounding both disk
 * use and accidental capability leakage. Failure recording is best effort and
 * never masks the installation error. */
function writeFailedScene(runtimeDir: string, version: string, stage: InstallFailureStage, error: unknown): void {
  const destination = failedScenePath(runtimeDir, version)
  const tmp = join(runtimeDir, `.${version}.failed-tmp-${randomBytes(4).toString('hex')}`)
  try {
    mkdirSync(tmp, { mode: 0o700 })
    const detail = sanitizeInstallerOutput(errorMessage(error), FAILED_ERROR_LIMIT)
    writeFileSync(join(tmp, 'failure.json'), `${JSON.stringify({
      schemaVersion: 1,
      version,
      stage,
      failedAt: new Date().toISOString(),
      error: detail,
    }, null, 2)}\n`, { mode: 0o600 })
    removeOwnedTree(destination)
    renameSync(tmp, destination)
    chmodSync(destination, 0o700)
  } catch {
    try { removeOwnedTree(tmp) } catch { /* best effort */ }
  }
}

/** Only a new-format, digest-verified tree receives overwrite protection.
 * Legacy/partial trees are replaced through the backup→publish transaction. */
function existingRuntimeTreeIsValid(baseDir: string, version: string): boolean {
  const structural = validateVersionTree(baseDir, version)
  if (!structural.ok) return false
  try {
    verifyRuntimeTreeCriticalFiles(structural.path, version)
    return true
  } catch {
    return false
  }
}

class BoundedOutput {
  private value = Buffer.alloc(0)
  truncated = false
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  append(raw: Uint8Array): void {
    const chunk = Buffer.from(raw)
    if (chunk.length >= this.limit) {
      this.value = chunk.subarray(chunk.length - this.limit)
      this.truncated = true
      return
    }
    const combined = Buffer.concat([this.value, chunk])
    if (combined.length > this.limit) {
      this.value = combined.subarray(combined.length - this.limit)
      this.truncated = true
    } else {
      this.value = combined
    }
  }

  text(): string {
    return this.value.toString('utf8')
  }
}

interface TrackedChild {
  child: ChildProcess
  /** Stable process-group id. `child.pid` may no longer describe a live
   * leader after pnpm exits while a lifecycle descendant keeps the group. */
  pid: number | null
  closed: Promise<void>
  resolveClosed: () => void
  childClosed: boolean
  settled: boolean
  quiescence: Promise<void> | null
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error(typeof signal.reason === 'string' ? signal.reason : 'runtime install aborted')
  error.name = 'AbortError'
  return error
}

function delay(ms: number): Promise<void> {
  // Reaping is a correctness barrier. A detached lifecycle descendant must
  // not outlive the process merely because no other handle keeps the loop up.
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

export const RUNTIME_INSTALLER_RESIDUAL_PROCESS_GROUP_ERROR = 'ERR_DSH_RESIDUAL_PROCESS_GROUP'
export const RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR = 'ERR_DSH_WRITER_UNSAFE'

function residualProcessGroupError(): Error & { code: string } {
  return Object.assign(new Error('runtime installer child process group did not exit'), {
    code: RUNTIME_INSTALLER_RESIDUAL_PROCESS_GROUP_ERROR,
  })
}

function writerUnsafeError(message: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    code: RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR,
  })
}

export function isRuntimeInstallerWriterSafetyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === RUNTIME_INSTALLER_RESIDUAL_PROCESS_GROUP_ERROR
    || code === RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR
}

/**
 * Owns every installer child. Unix children are process-group leaders so
 * TERM→KILL reaches lifecycle-script descendants as well as pnpm itself.
 */
export class RuntimeInstallerSupervisor {
  private readonly active = new Set<TrackedChild>()
  private disposing = false
  private readonly outputLimit: number
  private readonly terminateGraceMs: number

  constructor(outputLimit = INSTALL_OUTPUT_LIMIT_BYTES, terminateGraceMs = INSTALL_TERMINATE_GRACE_MS) {
    this.outputLimit = outputLimit
    this.terminateGraceMs = terminateGraceMs
  }

  get activeCount(): number {
    return this.active.size
  }

  /** Signal the whole Unix group. ESRCH alone proves that there is no writer;
   * EPERM means the group is alive but not signalable and must remain fenced. */
  private sendSignal(tracked: TrackedChild, signal: NodeJS.Signals): 'sent' | 'quiet' | 'alive' {
    const pid = tracked.pid
    if (pid === null) return tracked.childClosed ? 'quiet' : 'alive'
    try {
      if (process.platform !== 'win32') process.kill(-pid, signal)
      else tracked.child.kill(signal)
      return 'sent'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'quiet'
      if (code === 'EPERM') return 'alive'
      throw writerUnsafeError(`runtime installer could not signal child process group (${code ?? 'unknown error'})`, error)
    }
  }

  /** Probe writer liveness without treating an unknown failure as absence.
   * `kill(..., 0)` success and EPERM both mean alive; only ESRCH means quiet. */
  private processGroupState(tracked: TrackedChild): 'alive' | 'quiet' {
    const pid = tracked.pid
    if (pid === null) return tracked.childClosed ? 'quiet' : 'alive'
    try {
      process.kill(process.platform === 'win32' ? pid : -pid, 0)
      return 'alive'
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ESRCH') return 'quiet'
      if (code === 'EPERM') return 'alive'
      throw writerUnsafeError(`runtime installer could not verify child process group (${code ?? 'unknown error'})`, error)
    }
  }

  private async waitForProcessGroupQuiet(tracked: TrackedChild): Promise<boolean> {
    const deadline = Date.now() + this.terminateGraceMs
    for (;;) {
      if (this.processGroupState(tracked) === 'quiet') return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      // Never race a resolved direct-child `close` promise: a daemonized
      // descendant can keep the PGID alive after the leader is gone.
      await delay(Math.min(25, remaining))
    }
  }

  private async quiesceProcessGroup(tracked: TrackedChild): Promise<void> {
    if (tracked.settled) return
    if (this.processGroupState(tracked) === 'quiet') return

    const term = this.sendSignal(tracked, 'SIGTERM')
    if (term === 'quiet' || await this.waitForProcessGroupQuiet(tracked)) return

    const kill = this.sendSignal(tracked, 'SIGKILL')
    if (kill === 'quiet' || await this.waitForProcessGroupQuiet(tracked)) return
    throw residualProcessGroupError()
  }

  /** Coalesce concurrent abort/close/dispose reapers. A failed proof is not
   * cached: dispose may retry, but the tracked writer remains fenced. */
  private async ensureProcessGroupQuiet(tracked: TrackedChild): Promise<void> {
    if (tracked.settled) return
    if (tracked.quiescence !== null) return await tracked.quiescence
    const proof = this.quiesceProcessGroup(tracked)
    tracked.quiescence = proof
    try {
      await proof
    } finally {
      if (tracked.quiescence === proof) tracked.quiescence = null
    }
  }

  private finishTracked(tracked: TrackedChild): void {
    if (tracked.settled) return
    tracked.settled = true
    this.active.delete(tracked)
  }

  private async terminate(tracked: TrackedChild): Promise<void> {
    await this.ensureProcessGroupQuiet(tracked)
    this.finishTracked(tracked)
  }

  /** A lifecycle script may outlive a successfully-exited pnpm parent. Reap
   * the detached group before reporting completion or forgetting its pgid. */
  private async reapResidualGroup(tracked: TrackedChild): Promise<void> {
    await this.ensureProcessGroupQuiet(tracked)
    this.finishTracked(tracked)
  }

  private async disposeTracked(tracked: TrackedChild): Promise<void> {
    try {
      await this.terminate(tracked)
    } catch (error) {
      // Never translate a stable quiescence failure into a generic disposal
      // error: callers use this code to preserve work/PID or plugin ledgers.
      if (isRuntimeInstallerWriterSafetyError(error)) throw error
      throw writerUnsafeError('runtime installer could not prove writer quiescence during disposal', error)
    }
  }

  async run(args: string[], opts: RunOptions): Promise<RunResult> {
    if (this.disposing) {
      // Classified as a writer-safety failure (review fix): a disposal that
      // could not prove quiescence must refuse new work with the stable code,
      // so owners can distinguish 'closed because a writer is unproven' from
      // a benign shutdown.
      throw writerUnsafeError('runtime installer is shutting down')
    }
    if (this.active.size > 0) {
      // This supervisor is a single-writer boundary. In particular, a prior
      // residual group must poison new work until dispose proves it quiet.
      throw writerUnsafeError('runtime installer still has an unverified active writer')
    }
    const [file, ...rest] = args
    if (file === undefined || file === '') throw new Error('runtime installer command is empty')
    opts.signal?.throwIfAborted()

    const child = spawn(file, rest, {
      cwd: opts.cwd,
      env: { ...scrubInstallEnv(process.env), ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    let resolveClosed!: () => void
    const tracked: TrackedChild = {
      child,
      pid: child.pid ?? null,
      closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
      resolveClosed: () => resolveClosed(),
      childClosed: false,
      settled: false,
      quiescence: null,
    }
    this.active.add(tracked)

    const stdout = new BoundedOutput(this.outputLimit)
    const stderr = new BoundedOutput(this.outputLimit)
    child.stdout?.on('data', (chunk: Buffer) => stdout.append(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.append(chunk))

    const completion = new Promise<RunResult>((resolve, reject) => {
      let forcedError: Error | null = null
      let timer: NodeJS.Timeout | null = null
      const cleanup = (): void => {
        if (timer !== null) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      const markChildClosed = (): void => {
        if (tracked.childClosed) return
        tracked.childClosed = true
        tracked.resolveClosed()
      }
      const terminateFor = (reason: Error): void => {
        forcedError = reason
        // A failed TERM/KILL proof is itself the terminal result. Waiting for
        // the direct child's `close` event can hang forever precisely when a
        // process-group writer is still unverified. Keep the tracked entry
        // active/evidence intact and reject as soon as quiescence is decided.
        void this.terminate(tracked).then(() => {
          cleanup()
          reject(reason)
        }, (quiescenceError: unknown) => {
          cleanup()
          reject(quiescenceError)
        })
      }
      const onAbort = (): void => {
        terminateFor(abortError(opts.signal!))
      }
      if (opts.signal !== undefined) {
        if (opts.signal.aborted) onAbort()
        else opts.signal.addEventListener('abort', onAbort, { once: true })
      }
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          terminateFor(new Error(`runtime installer child timed out after ${opts.timeoutMs}ms`))
        }, opts.timeoutMs)
      }
      child.once('error', (error) => {
        cleanup()
        markChildClosed()
        void this.reapResidualGroup(tracked).then(() => {
          reject(forcedError ?? error)
        }, (quiescenceError: unknown) => {
          // An unknown writer is more important than the ordinary child error.
          reject(quiescenceError)
        })
      })
      child.once('close', (code) => {
        cleanup()
        markChildClosed()
        void this.reapResidualGroup(tracked).then(() => {
          if (forcedError !== null) reject(forcedError)
          else resolve({
            status: code,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          })
        }, (error: unknown) => {
          // Abort/timeout must never hide a failed writer-quiescence proof.
          reject(error)
        })
      })
    })
    try {
      if (child.pid !== undefined) opts.onSpawn?.(child.pid)
    } catch (onSpawnError) {
      try {
        await this.terminate(tracked)
      } catch (quiescenceError) {
        // Durable PID/ledger recording failed and the writer could not be
        // proven gone. Preserve the stable safety code and all caller-owned
        // crash evidence; never let the writer fence observe normal success.
        if (isRuntimeInstallerWriterSafetyError(quiescenceError)) throw quiescenceError
        throw writerUnsafeError('runtime installer onSpawn failed and writer quiescence is unknown', quiescenceError)
      }
      // Drain the completion path after the ESRCH proof. If it independently
      // discovers a safety failure, that failure still outranks onSpawn.
      const completionError = await completion.then(() => null, error => error)
      if (isRuntimeInstallerWriterSafetyError(completionError)) throw completionError
      throw onSpawnError
    }
    return await completion
  }

  /** App-quit hook: stop accepting work and reap every pnpm/process group. */
  async dispose(): Promise<void> {
    this.disposing = true
    const results = await Promise.allSettled([...this.active].map((tracked) => this.disposeTracked(tracked)))
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (failures.length > 0) {
      if (failures.length === 1) throw failures[0]
      throw Object.assign(new AggregateError(failures, 'runtime installer writers did not become quiescent'), {
        code: RUNTIME_INSTALLER_WRITER_UNSAFE_ERROR,
      })
    }
    if (this.active.size > 0) {
      throw writerUnsafeError('runtime installer disposal completed without proving every writer quiescent')
    }
  }

  /** Reopen the supervisor after a disposal that PROVED writer quiescence
   * (same-process host restart, e.g. gateway stop → start). Only a fully
   * settled disposal may reset: while any writer is still tracked, the
   * shutting-down latch must stay so an unproven writer never gets
   * concurrent work (review fix — the module latch reset alone left
   * `defaultSupervisor.disposing` true forever, rejecting every later
   * install/prune in the same process). */
  reset(): void {
    if (this.active.size > 0) throw writerUnsafeError('runtime installer cannot reset while writers are still tracked')
    this.disposing = false
  }
}

const defaultSupervisor = new RuntimeInstallerSupervisor()

interface ActiveInstallerOperation {
  controller: AbortController
  closed: Promise<void>
  resolveClosed: () => void
}

const activeInstallerOperations = new Set<ActiveInstallerOperation>()
let runtimeInstallerDisposing = false

/** Exported lifecycle hook; main's will-quit cleanup must await this. */
export async function disposeRuntimeInstaller(): Promise<void> {
  runtimeInstallerDisposing = true
  const operations = [...activeInstallerOperations]
  try {
    for (const operation of operations) {
      operation.controller.abort(new Error('runtime installer is shutting down'))
    }
    await Promise.all([
      defaultSupervisor.dispose(),
      Promise.allSettled(operations.map((operation) => operation.closed)),
    ])
    // The host may legitimately restart the manager in the same process
    // (gateway stop → start). A disposal that PROVED writer quiescence
    // reopens the supervisor for later installs/prunes; a FAILED disposal
    // throws above and keeps the shutting-down latch, so an unproven writer
    // never gets concurrent work (review fix).
    defaultSupervisor.reset()
  } finally {
    runtimeInstallerDisposing = false
  }
}

function resolveInstallerNodeExecutable(): { file: string; args: string[]; env: Record<string, string> } {
  // Plain-node default (design 18 §9.1): the shared core carries NO Electron
  // branch. The desktop host injects its Electron-as-node executor through
  // `deps.node`; the gateway's plain-node path is this default.
  return { file: process.execPath, args: [], env: {} }
}

function assertInstallResolution(resolution: RuntimeInstallResolution): RuntimeInstallResolution {
  if (resolution.packageName !== '@deepseek-ai/dsh') {
    throw new Error(`unexpected runtime package: ${resolution.packageName}`)
  }
  assertSafeVersion(resolution.version)
  const origin = canonicalRegistryOrigin(resolution.registryOrigin)
  if (origin === null || origin !== resolution.registryOrigin) {
    throw new Error(`invalid bound registry origin: ${resolution.registryOrigin}`)
  }
  if (!isAllowedRegistryUrl(resolution.tarball, registryRedirectOrigins(origin))) {
    throw new Error('bound runtime tarball is outside the registry whitelist')
  }
  if (!isSupportedIntegrity(resolution.integrity)) {
    throw new Error('bound runtime tarball has no supported integrity')
  }
  return resolution
}

/** Stream one tarball to disk and fail before pnpm if its SRI does not match. */
export async function downloadVerifiedRegistryTarball(
  rawResolution: RuntimeInstallResolution,
  destination: string,
  opts: {
    signal: AbortSignal
    maxBytes?: number
    fetchImpl?: typeof globalThis.fetch
    onProgress?: (received: number, total: number | null) => void
  },
): Promise<void> {
  const resolution = assertInstallResolution(rawResolution)
  const maxBytes = opts.maxBytes ?? DEFAULT_TARBALL_MAX_BYTES
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error(`invalid registry tarball limit: ${maxBytes}`)
  const verifier = createIntegrityVerifier(resolution.integrity)
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    const { response } = await fetchRegistryResponse(resolution.tarball, {
      allowedOrigins: registryRedirectOrigins(resolution.registryOrigin),
      signal: opts.signal,
      fetchImpl: opts.fetchImpl,
    })
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`registry tarball fetch failed: HTTP ${response.status}`)
    }
    const rawLength = response.headers.get('content-length')
    const declaredLength = rawLength === null ? Number.NaN : Number(rawLength)
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body.cancel().catch(() => {})
      throw new Error(`registry tarball exceeds ${maxBytes} bytes`)
    }
    // Absent/undeclared content-length → unknown total (indeterminate bar).
    const total = Number.isFinite(declaredLength) && declaredLength >= 0 ? declaredLength : null
    file = await open(destination, 'wx', 0o600)
    let received = 0
    for await (const raw of response.body) {
      opts.signal.throwIfAborted()
      const chunk = Buffer.from(raw)
      received += chunk.length
      if (received > maxBytes) throw new Error(`registry tarball exceeds ${maxBytes} bytes`)
      verifier.update(chunk)
      await file.write(chunk)
      // Byte progress for the design-18 M4 bar; the controller throttles.
      opts.onProgress?.(received, total)
    }
    opts.signal.throwIfAborted()
    verifier.assertMatch()
    await file.sync()
  } catch (error) {
    await file?.close().catch(() => {})
    file = null
    rmSync(destination, { force: true })
    throw error
  } finally {
    await file?.close().catch(() => {})
  }
}

async function defaultPrune(root: string): Promise<PruneResult> {
  const mod = await import('./prune-runtime.mjs') as { pruneRuntimeArtifacts: (r: string) => PruneResult }
  return mod.pruneRuntimeArtifacts(root)
}

function createOperationDeadline(external: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal
  cleanup: () => void
} {
  if (runtimeInstallerDisposing) {
    // Same classification as the supervisor's disposing guard (round-3 fix):
    // owners switching on ERR_DSH_WRITER_UNSAFE see one consistent code for
    // every 'shutting down' refusal.
    throw writerUnsafeError('runtime installer is shutting down')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid install timeout: ${timeoutMs}`)
  const controller = new AbortController()
  let resolveClosed!: () => void
  const tracked: ActiveInstallerOperation = {
    controller,
    closed: new Promise<void>((resolve) => { resolveClosed = resolve }),
    resolveClosed: () => resolveClosed(),
  }
  activeInstallerOperations.add(tracked)
  const forwardAbort = (): void => controller.abort(external?.reason)
  if (external?.aborted) forwardAbort()
  else external?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new Error(`dsh runtime install timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref?.()
  let cleaned = false
  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      clearTimeout(timer)
      external?.removeEventListener('abort', forwardAbort)
      activeInstallerOperations.delete(tracked)
      tracked.resolveClosed()
    },
  }
}

export interface PruneRuntimeStoreOptions {
  baseDir: string
  pnpmEntry: string
  signal?: AbortSignal
  timeoutMs?: number
  deps?: Partial<Pick<InstallerDeps, 'node' | 'run'>>
}

/**
 * Reclaim unreferenced pnpm content after version eviction. The caller owns
 * the durable `store-prune-needed` marker and must clear it only after this
 * promise resolves. The command shares the install supervisor, bounded
 * output, source-scrubbed environment and shell-managed empty userconfig.
 */
export async function pruneRuntimeStore(opts: PruneRuntimeStoreOptions): Promise<void> {
  const deadline = createOperationDeadline(opts.signal, opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS)
  const runtimeDir = join(opts.baseDir, 'dsh-runtime')
  const storeDir = join(runtimeDir, '.pnpm-store')
  const installHome = join(runtimeDir, '.install-home')
  const xdgCacheDir = join(runtimeDir, '.xdg-cache')
  const npmrc = join(runtimeDir, '.npmrc')
  const nodeFn = opts.deps?.node ?? resolveInstallerNodeExecutable
  const runFn = opts.deps?.run ?? ((args, runOpts) => defaultSupervisor.run(args, runOpts))
  try {
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    mkdirSync(installHome, { recursive: true, mode: 0o700 })
    mkdirSync(xdgCacheDir, { recursive: true, mode: 0o700 })
    writeFileSync(npmrc, '', { mode: 0o600 })
    const node = nodeFn()
    deadline.signal.throwIfAborted()
    const result = await runFn([
      node.file,
      ...node.args,
      opts.pnpmEntry,
      'store',
      'prune',
      '--store-dir',
      storeDir,
    ], {
      cwd: runtimeDir,
      env: {
        ...node.env,
        HOME: installHome,
        XDG_CACHE_HOME: xdgCacheDir,
        NPM_CONFIG_USERCONFIG: npmrc,
      },
      signal: deadline.signal,
    })
    deadline.signal.throwIfAborted()
    if (result.status !== 0) {
      const detail = sanitizeInstallerOutput((result.stderr || result.stdout).trim(), 800)
      throw new Error(`dsh runtime store prune failed (exit ${result.status}): ${detail}`)
    }
  } finally {
    deadline.cleanup()
  }
}

async function defaultSmoke(
  node: () => { file: string; args: string[]; env: Record<string, string> },
  run: InstallerDeps['run'],
  workDir: string,
  version: string,
  context: SmokeContext,
): Promise<void> {
  const n = node()
  const bin = join(workDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const res = await run([n.file, ...n.args, bin, '--version'], {
    cwd: workDir,
    env: n.env,
    signal: context.signal,
    onSpawn: context.onSpawn,
  })
  if (res.status !== 0 || res.stdout.trim() !== version) {
    const detail = sanitizeInstallerOutput((res.stderr || res.stdout).trim(), 500)
    throw new Error(`dsh smoke check failed (exit ${res.status}, want ${version}): ${detail}`)
  }
}

export async function installRuntimeVersion(opts: InstallOptions): Promise<InstallResult> {
  const resolution = assertInstallResolution(opts.resolution)
  const version = resolution.version
  const runtimeDir = join(opts.baseDir, 'dsh-runtime')
  const versionTreeDir = join(runtimeDir, version)
  if (existsSync(versionTreeDir) && existingRuntimeTreeIsValid(opts.baseDir, version)) {
    throw new Error(`dsh runtime ${version} is already installed and valid; refusing to overwrite it`)
  }
  const workDir = join(runtimeDir, `.work-${randomBytes(4).toString('hex')}`)
  const backupDir = join(runtimeDir, `.${version}.publish-backup-${randomBytes(4).toString('hex')}`)
  let stage: InstallFailureStage = 'prepare'
  let deadline: ReturnType<typeof createOperationDeadline> | null = null
  let previousTreeBackedUp = false
  let workPublished = false
  let completed = false
  let preserveWorkDir = false

  const restorePreviousTree = (renameFn: InstallerDeps['rename']): void => {
    if (workPublished && existsSync(versionTreeDir)) {
      removeOwnedTree(versionTreeDir)
      workPublished = false
    }
    if (previousTreeBackedUp && existsSync(backupDir)) {
      renameFn(backupDir, versionTreeDir)
      previousTreeBackedUp = false
    }
  }

  try {
    deadline = createOperationDeadline(opts.signal, opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS)
    const nodeFn = opts.deps?.node ?? resolveInstallerNodeExecutable
    const runFn = opts.deps?.run ?? ((args, runOpts) => defaultSupervisor.run(args, runOpts))
    const downloadFn = opts.deps?.download ?? downloadVerifiedRegistryTarball
    const pruneFn = opts.deps?.prune ?? defaultPrune
    const renameFn = opts.deps?.rename ?? renameSync
    const makeReadOnlyFn = opts.deps?.makeReadOnly ?? makeRuntimeTreeReadOnly
    const verifyPublishedFn = opts.deps?.verifyPublished ?? verifyRuntimeTreeCriticalFiles
    const storeDir = join(runtimeDir, '.pnpm-store')
    const cacheDir = join(runtimeDir, '.pnpm-cache')
    const installHome = join(runtimeDir, '.install-home')
    const xdgCacheDir = join(runtimeDir, '.xdg-cache')
    const npmrc = join(runtimeDir, '.npmrc')
    const pidPath = join(workDir, 'pid')
    const tarballPath = join(workDir, 'dsh-runtime-package.tgz')
    // Work-dir lifecycle marker consumed by startup stale-work cleanup:
    // 'preparing' proves no child ever existed (a hard crash during the long
    // download window is reclaimable), 'spawning'/'spawned' mean a child may
    // exist even without PID evidence (startup must fail closed), 'failed' is
    // a spawn error with no child (reclaimable). The marker is the FIRST file
    // written into the work dir; without it, non-empty work + missing pid is
    // indistinguishable from a post-spawn scene and blocks startup forever.
    const statePath = join(workDir, 'state')
    const writeState = (value: 'preparing' | 'spawning' | 'spawned' | 'failed'): void => {
      writeFileSync(statePath, `${value}\n`, { mode: 0o600 })
    }
    const noteChildPid = (pid: number): void => {
      writeFileSync(pidPath, String(pid), { mode: 0o600 })
      // PID evidence is written BEFORE the marker flips to 'spawned' — the
      // marker alone never authorizes cleanup.
      writeState('spawned')
    }
    const runCommand = async (args: string[], runOpts: Omit<RunOptions, 'signal' | 'onSpawn'>): Promise<RunResult> => {
      writeState('spawning')
      try {
        return await runFn(args, {
          ...runOpts,
          signal: deadline!.signal,
          onSpawn: noteChildPid,
        })
      } catch (error) {
        // A failed spawn must not strand a 'spawning' marker that would
        // block startup cleanup as if a child might exist.
        writeState('failed')
        throw error
      }
    }
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
    mkdirSync(workDir, { recursive: true, mode: 0o700 })
    mkdirSync(installHome, { recursive: true, mode: 0o700 })
    mkdirSync(xdgCacheDir, { recursive: true, mode: 0o700 })
    writeFileSync(npmrc, '', { mode: 0o600 })
    writeState('preparing')
    writeFileSync(join(workDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-runtime-install',
      version: '0.0.0',
      private: true,
      dependencies: { '@deepseek-ai/dsh': 'file:./dsh-runtime-package.tgz' },
    }, null, 2)}\n`)
    writeFileSync(join(workDir, 'pnpm-workspace.yaml'), `minimumReleaseAge: 0\nallowBuilds:\n${ALLOW_BUILDS.map((name) => `  ${JSON.stringify(name)}: true`).join('\n')}\n`)

    const nodeWithSandbox = () => {
      const resolved = nodeFn()
      return {
        ...resolved,
        env: {
          ...resolved.env,
          HOME: installHome,
          XDG_CACHE_HOME: xdgCacheDir,
        },
      }
    }
    const smokeFn = opts.deps?.smoke ?? ((work: string, ver: string, context: SmokeContext) => (
      defaultSmoke(nodeWithSandbox, runFn, work, ver, context)
    ))
    const node = nodeWithSandbox()
    const installArgs = [
      node.file, ...node.args, opts.pnpmEntry, 'install',
      '--config.node-linker=hoisted',
      '--store-dir', storeDir,
      '--cache-dir', cacheDir,
      '--registry', resolution.registryOrigin,
      '--fetch-retries=0',
    ]
    const installEnv = { ...node.env, NPM_CONFIG_USERCONFIG: npmrc }

    stage = 'download'
    deadline.signal.throwIfAborted()
    // Byte progress rides the default downloader's per-chunk callback; the
    // controller throttles the renderer pushes. Stage-only milestones follow
    // for install/prune/smoke/publish (no reliable byte source).
    const reportStage = (next: RuntimeInstallProgress): void => opts.onProgress?.(next)
    reportStage({ stage: 'download', received: 0, total: null })
    await downloadFn(resolution, tarballPath, {
      signal: deadline.signal,
      onProgress: (received, total) => reportStage({ stage: 'download', received, total }),
    })
    deadline.signal.throwIfAborted()
    stage = 'install'
    reportStage({ stage: 'install' })
    let res = await runCommand(installArgs, { cwd: workDir, env: installEnv })
    if (res.status !== 0) {
      deadline.signal.throwIfAborted()
      res = await runCommand(installArgs, { cwd: workDir, env: installEnv })
    }
    if (res.status !== 0) {
      const detail = sanitizeInstallerOutput((res.stderr || res.stdout).trim(), 800)
      throw new Error(`dsh runtime install failed (exit ${res.status}): ${detail}`)
    }

    rmSync(tarballPath, { force: true })
    stage = 'prune'
    reportStage({ stage: 'prune' })
    await pruneFn(workDir)
    deadline.signal.throwIfAborted()
    stage = 'smoke'
    reportStage({ stage: 'smoke' })
    await smokeFn(workDir, version, {
      signal: deadline.signal,
      onSpawn: noteChildPid,
    })
    deadline.signal.throwIfAborted()

    stage = 'manifest'
    const manifest = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8'))
    manifest.dependencies = { '@deepseek-ai/dsh': version }
    manifest.dsh = {
      platform: `${process.platform}-${process.arch}`,
      registryOrigin: resolution.registryOrigin,
      integrity: resolution.integrity,
      criticalFiles: computeCriticalDigests(workDir, version),
    }
    writeFileSync(join(workDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    rmSync(pidPath, { force: true })
    deadline.signal.throwIfAborted()
    stage = 'publish'
    reportStage({ stage: 'publish' })
    // Re-check at the commit point: a concurrent installer may have published
    // after our early refusal check. Valid trees are never replaced or reused.
    if (existsSync(versionTreeDir)) {
      if (existingRuntimeTreeIsValid(opts.baseDir, version)) {
        throw new Error(`dsh runtime ${version} became valid during install; refusing to overwrite it`)
      }
      renameFn(versionTreeDir, backupDir)
      previousTreeBackedUp = true
    }
    try {
      renameFn(workDir, versionTreeDir)
      workPublished = true
    } catch (publishError) {
      try {
        restorePreviousTree(renameFn)
      } catch (restoreError) {
        throw new Error(`runtime publish failed and the previous tree could not be restored: ${sanitizeInstallerOutput(errorMessage(restoreError), 500)}`, { cause: publishError })
      }
      throw publishError
    }

    stage = 'finalize'
    try {
      makeReadOnlyFn(versionTreeDir)
      verifyPublishedFn(versionTreeDir, version)
      deadline.signal.throwIfAborted()
    } catch (finalizeError) {
      try {
        restorePreviousTree(renameFn)
      } catch (restoreError) {
        throw new Error(`runtime finalization failed and the previous tree could not be restored: ${sanitizeInstallerOutput(errorMessage(restoreError), 500)}`, { cause: finalizeError })
      }
      throw finalizeError
    }

    completed = true
    if (previousTreeBackedUp) {
      try { removeOwnedTree(backupDir) } catch { /* stale hidden backup is safer than failing a verified publish */ }
      previousTreeBackedUp = false
    }
    try { removeOwnedTree(failedScenePath(runtimeDir, version)) } catch { /* stale failure evidence is non-authoritative */ }
    reportStage({ stage: 'done' })
    return { versionTreeDir, resolvedVersion: version }
  } catch (error) {
    preserveWorkDir = isRuntimeInstallerWriterSafetyError(error)
    if (!completed) {
      // `restorePreviousTree` is normally performed at the exact failure site
      // so its error can be reported. This covers unexpected exceptions after
      // backup/publish without hiding the original failure.
      if (previousTreeBackedUp || workPublished) {
        const renameFn = opts.deps?.rename ?? renameSync
        try { restorePreviousTree(renameFn) } catch { /* backup remains durable for manual recovery */ }
      }
      try {
        mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
        writeFailedScene(runtimeDir, version, stage, error)
      } catch { /* never mask the original install failure */ }
    }
    throw error
  } finally {
    deadline?.cleanup()
    if (!preserveWorkDir) {
      try { removeOwnedTree(workDir) } catch { /* startup stale-work cleanup is the final fallback */ }
    }
  }
}
