/**
 * Desktop login-shell environment (rc.2 parity; design 02 §3.1 sibling).
 *
 * WHY: a Dock/Finder/desktop launch inherits only launchd's (or the session
 * manager's) environment. PATH entries, proxies and API keys exported from
 * ~/.zprofile / ~/.zshrc never reach the managed dsh host, its agent shells or
 * its terminals — the same root cause that already forced the bundled-pnpm
 * shim (pnpm-shim.ts) for one artifact. The account's login shell is read once
 * per app process and the merged result is handed to every Host; the two
 * desktop entries (Electron main, Swift sidecar) call this module, so both
 * flavors share one implementation. The gateway/standalone shapes deliberately
 * do NOT call it: a service manages its own environment.
 *
 * Shape (upstream parity):
 *  - candidate order = the account record's login shell, then /bin/zsh,
 *    /bin/bash, /bin/sh (never $SHELL: a Dock launch inherits launchd's);
 *  - one `<shell> -ilc` run per candidate that PRINTS the environment with
 *    `command env -0` between two markers. The markers bound the payload
 *    because startup files may leave background processes holding stdout open —
 *    waiting for stdout to close would turn every read into a timeout;
 *  - shell values replace inherited ones EXCEPT the probe environment keys
 *    (PROBE_ENV), the probe-session variables and the `DSH_*` / `ELECTRON_*`
 *    namespaces (the caller resolves DSH_HOME before the read; a startup file
 *    must not move the host's home, and the probe's own prompt-suppression
 *    keys must not leak into every managed host);
 *  - a candidate that times out, is aborted, or exits without the closing
 *    marker is killed as a process GROUP and the next candidate is tried; a
 *    SUCCESSFUL candidate is left running to exit on its own (the probe never
 *    kills the user's rc-started background jobs);
 *  - every candidate failing returns the inherited environment unchanged.
 *    With the exception of an invalid %TIMEOUT_ENV% value (a configuration
 *    error, reported loudly), the read never throws and never blocks startup
 *    beyond the per-candidate budget — callers start it early and await it
 *    just before the first host spawn.
 */

import { spawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'

/** One candidate shell that did not answer the probe. */
export interface LoginShellEnvironmentFailure {
  shell: string
  reason: string
}

/** The merged environment plus the candidates that failed (diagnostics only). */
export interface LoginShellEnvironmentResult {
  environment: NodeJS.ProcessEnv
  failures: LoginShellEnvironmentFailure[]
}

/** Injectable timing/platform/probe options (tests own the candidates + budget). */
export interface LoginShellEnvironmentOptions {
  /** Candidate shells in order; defaults to the account shell + POSIX fallbacks. */
  shells?: readonly string[]
  /** Per-candidate budget in ms (default LOGIN_SHELL_TIMEOUT_MS). */
  timeoutMs?: number
  /** Abort the probe (app quit): the running group is killed, the base env returned. */
  signal?: AbortSignal
  /** Platform override for tests. */
  platform?: NodeJS.Platform
  /** Marker overrides for tests. */
  beginMarker?: string
  endMarker?: string
}

/** Begin/end markers of the delimited payload. */
export const LOGIN_SHELL_ENV_BEGIN = '__DSH_CHAMBER_LOGIN_ENV_BEGIN__'
export const LOGIN_SHELL_ENV_END = '__DSH_CHAMBER_LOGIN_ENV_END__'

/** Per-candidate budget (upstream's own default). */
export const LOGIN_SHELL_TIMEOUT_MS = 10_000
/** Optional budget override (same key upstream exposes), validated loudly. */
export const LOGIN_SHELL_TIMEOUT_ENV = 'DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS'

/**
 * Startup-file behaviours the probe neutralizes AND must never leak into the
 * host environment: prompt/auto-update suppression and tmux autostart. These
 * are exported so the merge test can assert their absence.
 */
export const PROBE_ENV: Readonly<Record<string, string>> = Object.freeze({
  DISABLE_AUTO_UPDATE: 'true',
  ZSH_TMUX_AUTOSTART: 'false',
  ZSH_TMUX_AUTOSTARTED: 'true',
})

/** Namespaces the shell must never override (caller-resolved host facts). */
const PROTECTED_PREFIX = /^(DSH|ELECTRON)_/
/** Session variables that describe the probe shell, not the user's environment. */
const PROBE_SESSION_VARS = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

/** Is one shell-provided name excluded from the merge (probe keys included)? */
function isProtectedName(name: string): boolean {
  return PROTECTED_PREFIX.test(name) || PROBE_SESSION_VARS.has(name) || Object.hasOwn(PROBE_ENV, name)
}

/**
 * Candidate login shells for the account, in probe order.
 * @param platform - current platform (POSIX only).
 * @param accountShell - the account record's shell (os.userInfo().shell), if any.
 * @returns absolute candidate paths without duplicates.
 */
export function loginShellCandidates(platform: NodeJS.Platform, accountShell: string | null | undefined): string[] {
  if (platform === 'win32') return []
  const candidates: string[] = []
  const push = (shell: string | null | undefined): void => {
    if (typeof shell !== 'string') return
    const trimmed = shell.trim()
    if (trimmed === '' || candidates.includes(trimmed)) return
    candidates.push(trimmed)
  }
  push(accountShell)
  push('/bin/zsh')
  push('/bin/bash')
  push('/bin/sh')
  return candidates
}

/**
 * Resolve the per-candidate budget from options/env.
 * @throws when an explicit env override is not an integer in [1000, 2^31-1].
 */
function resolveTimeoutMs(options: LoginShellEnvironmentOptions, baseEnv: NodeJS.ProcessEnv): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs
  const raw = baseEnv[LOGIN_SHELL_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return LOGIN_SHELL_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 2_147_483_647) {
    throw new Error(`${LOGIN_SHELL_TIMEOUT_ENV} must be an integer from 1000 through 2147483647`)
  }
  return value
}

/**
 * Parse the delimited `env -0` payload.
 * @param stdout - raw stdout captured from the probe.
 * @param beginMarker - opening marker.
 * @param endMarker - closing marker (also the completion signal).
 * @returns the parsed pairs, or null when the closing marker never arrived.
 */
export function parseLoginShellEnvironment(
  stdout: string,
  beginMarker: string = LOGIN_SHELL_ENV_BEGIN,
  endMarker: string = LOGIN_SHELL_ENV_END,
): Record<string, string> | null {
  const begin = stdout.indexOf(beginMarker)
  const end = stdout.indexOf(endMarker, begin === -1 ? 0 : begin + beginMarker.length)
  if (begin === -1 || end === -1) return null
  const payload = stdout.slice(begin + beginMarker.length, end)
  const values: Record<string, string> = {}
  for (const entry of payload.split('\u0000')) {
    if (entry === '') continue
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    values[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return values
}

/**
 * Merge the shell's environment over the inherited one.
 * @param baseEnv - the process environment the app inherited.
 * @param shellEnv - pairs parsed from the login shell.
 * @returns a new environment object; probe keys, `DSH_*`/`ELECTRON_*` and probe variables stay inherited.
 */
export function mergeLoginShellEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  shellEnv: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...baseEnv }
  for (const [name, value] of Object.entries(shellEnv)) {
    if (name === '' || isProtectedName(name)) continue
    merged[name] = value
  }
  return merged
}

/** The script the probe shell runs: markers plus a NUL-delimited environment. */
function probeScript(beginMarker: string, endMarker: string): string {
  return `printf %s '${beginMarker}'; command env -0 || exit $?; printf %s '${endMarker}'`
}

/** Outcome of one candidate probe. */
interface ProbeOutcome {
  stdout: string
  exit: string
}

/**
 * Run one candidate and capture stdout until the closing marker (or the budget).
 * A SUCCESSFUL probe leaves the shell to exit on its own; only a timeout/abort
 * kills the process group.
 */
function runProbeShell(
  shell: string,
  script: string,
  timeoutMs: number,
  baseEnv: NodeJS.ProcessEnv,
  endMarker: string,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...baseEnv, ...PROBE_ENV }
    let child
    try {
      child = spawn(shell, ['-ilc', script], {
        env,
        cwd: homedir(),
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: true,
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    const chunks: Buffer[] = []
    let tail = ''
    let exitLabel = 'exit unknown'
    let settled = false
    const killGroup = (): void => {
      try { if (typeof child.pid === 'number') process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ }
    }
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child.stdout?.removeListener('data', onData)
      child.stdout?.resume()
      if (error === undefined) resolve({ stdout: Buffer.concat(chunks).toString('utf8'), exit: exitLabel })
      else reject(error)
    }
    const onAbort = (): void => { killGroup(); finish(new Error('aborted')) }
    const timer = setTimeout(() => { killGroup(); finish(new Error(`timed out after ${timeoutMs}ms`)) }, timeoutMs)
    function onData(chunk: Buffer | string): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buffer)
      // Marker detection rides a byte-preserving tail so a UTF-8 sequence split
      // across chunks cannot hide the (ASCII) closing marker; the payload itself
      // is decoded once, from the concatenated buffers, at settle time.
      tail = (tail + buffer.toString('latin1')).slice(-(endMarker.length * 2 + 8))
      if (tail.includes(endMarker)) finish()
    }
    if (signal !== undefined) {
      if (signal.aborted) { killGroup(); finish(new Error('aborted')); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout?.on('data', onData)
    child.on('error', error => { finish(error instanceof Error ? error : new Error(String(error))) })
    child.on('exit', (code, exitSignal) => {
      exitLabel = exitSignal === null ? `exit ${code ?? '?'}` : `signal ${exitSignal}`
    })
    child.on('close', () => { finish() })
  })
}

/**
 * Read the login shell's environment once and merge it over `baseEnv`.
 * A failed read returns `baseEnv` unchanged with the failures listed; an invalid
 * timeout override rejects loudly (a configuration error).
 * @param baseEnv - the inherited process environment.
 * @param options - candidates/budget/abort/platform overrides.
 */
export async function readLoginShellEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  options: LoginShellEnvironmentOptions = {},
): Promise<LoginShellEnvironmentResult> {
  const platform = options.platform ?? process.platform
  // Windows has no POSIX login shell to read; skip before any probe option can spawn.
  if (platform === 'win32') return { environment: { ...baseEnv }, failures: [] }
  const timeoutMs = resolveTimeoutMs(options, baseEnv)
  const beginMarker = options.beginMarker ?? LOGIN_SHELL_ENV_BEGIN
  const endMarker = options.endMarker ?? LOGIN_SHELL_ENV_END
  const accountShell = (() => {
    try { return userInfo().shell } catch { return null }
  })()
  const shells = options.shells ?? loginShellCandidates(platform, accountShell)
  if (shells.length === 0) return { environment: { ...baseEnv }, failures: [] }
  const script = probeScript(beginMarker, endMarker)
  const failures: LoginShellEnvironmentFailure[] = []
  // Function form: keeps the abort check out of TS narrowing across the loop.
  const isAborted = (): boolean => options.signal?.aborted === true
  for (const shell of shells) {
    if (isAborted()) {
      failures.push({ shell, reason: 'aborted' })
      break
    }
    try {
      const outcome = await runProbeShell(shell, script, timeoutMs, baseEnv, endMarker, options.signal)
      const parsed = parseLoginShellEnvironment(outcome.stdout, beginMarker, endMarker)
      if (parsed !== null) return { environment: mergeLoginShellEnvironment(baseEnv, parsed), failures }
      failures.push({ shell, reason: `closing marker missing (${outcome.exit})` })
    } catch (error) {
      failures.push({ shell, reason: error instanceof Error ? error.message : String(error) })
      if (isAborted()) break
    }
  }
  return { environment: { ...baseEnv }, failures }
}

let onceRead: Promise<LoginShellEnvironmentResult> | undefined

/**
 * Process-lifetime memo of {@link readLoginShellEnvironment} — every host in one
 * app process shares ONE read (the account's startup files do not change under a
 * running app). The first call's baseEnv/options (including its signal) own the
 * probe; later callers get the same promise.
 */
export function readLoginShellEnvironmentOnce(
  baseEnv: NodeJS.ProcessEnv,
  options: LoginShellEnvironmentOptions = {},
): Promise<LoginShellEnvironmentResult> {
  onceRead ??= readLoginShellEnvironment(baseEnv, options)
  return onceRead
}

/** Test-only: forget the process-lifetime memo. */
export function __resetLoginShellEnvironmentOnceForTests(): void {
  onceRead = undefined
}