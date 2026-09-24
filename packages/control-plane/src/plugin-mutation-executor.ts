/**
 * Restricted plugin-mutation child executor — the SINGLE implementation of the bounded
 * mutation-child protocol shared by the gateway server and the desktop main process.
 *
 * Env discipline: the caller builds the child env through {@link scrubMutationEnv} with the
 * canonical `INSTALL_ENV_WHITELIST` regex the dsh-runtime installer exports (PATH + the
 * proxy family); every other ambient variable — DSH_GATEWAY_* control vars, npm/NPM token
 * carriers and any other secret a lifecycle script or pnpm could read — is DROPPED. HOME is
 * never pinned: pnpm derives its store from the effective home the managed profile was
 * provisioned under (a pinned HOME silently moves the store and pnpm 11 then refuses every
 * mutation). The regex is a REQUIRED parameter because its single source is not a dependency
 * of this package.
 *
 * Spawn/capture: the default executor spawns a detached process-group leader and kills the
 * GROUP on timeout/cancel (SIGTERM, then SIGKILL after the grace); callers needing stronger
 * writer-safety supervision inject their own {@link MutationChildExecutor} — env/bounds/
 * timeout/terminal semantics stay here. stdout/stderr keep a bounded tail per stream with a
 * truncation marker; every failure is sanitized through the caller-supplied `sanitize`
 * BEFORE reaching a journal/task projection (its single source is dsh-runtime's
 * sanitizeInstallerOutput — no second sanitizer exists here).
 *
 * Never throws for its own failures: spawn errors, non-zero exits, signals and timeouts
 * resolve {@link PluginMutationResult}; an INJECTED executor that throws propagates.
 */

import { spawn as spawnCommand } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'

import { errorMessage } from './error-text.ts'

/** Default bounded capture ceiling per stream (tail kept). */
export const MUTATION_OUTPUT_CAPTURE_LIMIT_DEFAULT_BYTES = 512 * 1024
/** Default single-mutation timeout (design 21 §6.9: 10 minutes). */
export const MUTATION_TIMEOUT_DEFAULT_MS = 10 * 60 * 1000
/** Grace between SIGTERM and SIGKILL on timeout/dispose. */
export const MUTATION_SIGNAL_GRACE_MS = 1000
/** Marker prepended when captured output was truncated to its tail. */
export const MUTATION_OUTPUT_TRUNCATION_MARKER = '\n...[output truncated]...\n'
/** Timeout error text (shared by gateway journal errors and desktop notes). */
export const ERROR_MUTATION_TIMED_OUT = 'mutation timed out'

/** Env discipline: ONLY the variables pnpm/network needs may cross the process boundary —
 *  PATH + the proxy family, i.e. the canonical `INSTALL_ENV_WHITELIST` from the shared
 *  dsh-runtime core. Everything else (DSH_GATEWAY_* control variables, npm_config_* / NPM_*
 *  token carriers and any other ambient secret a third-party lifecycle script or pnpm could
 *  read) is DROPPED before the caller's pins apply. A denylist cannot enumerate every secret
 *  carrier; the whitelist can. Pins override an ambient value of the same name; the
 *  whitelist regex is required (no local default). */
export function scrubMutationEnv(
  source: Record<string, string | undefined>,
  pins: Record<string, string>,
  whitelist: RegExp,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (whitelist.test(key)) result[key] = value
  }
  for (const [key, value] of Object.entries(pins)) result[key] = value
  return result
}

/** Structural minimal child surface (real ChildProcess or test fake). */
export interface MutationProcessStream {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end', listener: () => void): unknown
}

export interface MutationChild {
  pid: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'error' | 'close', listener: (...args: any[]) => void): unknown
  stdout: MutationProcessStream | null
  stderr: MutationProcessStream | null
}

export type MutationSpawnFn = (command: string, args: string[], options: SpawnOptions) => MutationChild

/** One child execution request (the parameterized spawn/kill seam). */
export interface MutationChildExecution {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string | undefined
  timeoutMs: number
  stdoutLimit: number
  stderrLimit: number
  /** Pid hook for durable crash-orphan records; a throwing hook fails the execution loudly. */
  onSpawn?: (pid: number) => void
}

/** Raw outcome of one child execution. `error` is the supervision-level failure (spawn error,
 *  timeout, quiescence); `code`/`signal`/`stdout`/`stderr` describe a child that ran. */
export interface MutationChildOutcome {
  code: number | null
  signal: NodeJS.Signals | string | null
  stdout: string
  stderr: string
  error?: string
}

/** Injectable child executor (desktop: the supervisor adapter with its writer-quiescence proof). */
export type MutationChildExecutor = (execution: MutationChildExecution) => Promise<MutationChildOutcome>

export interface PluginMutationParams {
  /** Executable to spawn (gateway: the resolved node executable; desktop: `process.execPath`). */
  command: string
  /** Arguments after the optional prefix. */
  argv: string[]
  /** Optional argv prefix spliced between the executable and `argv` (gateway: node args + CLI entry). */
  argvPrefix?: string[]
  env: Record<string, string>
  /** Working directory for the child (the active runtime workspace root; absent inherits the host cwd). */
  cwd?: string
  timeoutMs?: number
  stdoutLimit?: number
  stderrLimit?: number
  /** Error-text sanitizer (REQUIRED — see the module header). */
  sanitize: (text: string) => string
  /** Spawn seam (tests inject a fake); the default executor uses it. */
  spawn?: MutationSpawnFn
  /** Child hook right after spawn (gateway records `childPid` for dispose kills). Default executor only. */
  onSpawn?: (child: MutationChild) => void
  /** Execution seam; when present the built-in spawn is not used. */
  childExecutor?: MutationChildExecutor
}

export type PluginMutationResult = { ok: true } | { ok: false; error: string }

/** Rolling bounded capture: keeps the last `limit` bytes of pushed chunks. */
class BoundedOutput {
  private parts: string[] = []
  private length = 0
  private dropped = false
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (text.length === 0) return
    this.parts.push(text)
    this.length += text.length
    while (this.parts.length > 1 && this.length - this.parts[0]!.length >= this.limit) {
      this.length -= this.parts.shift()!.length
      this.dropped = true
    }
    if (this.length > this.limit) {
      const excess = this.length - this.limit
      this.parts[0] = this.parts[0]!.slice(excess)
      this.length -= excess
      this.dropped = true
    }
  }

  text(): string {
    const joined = this.parts.join('')
    // push() keeps the retained tail within the limit; when anything was
    // dropped the tail is surfaced with the truncation marker up front.
    return this.dropped ? `${MUTATION_OUTPUT_TRUNCATION_MARKER}${joined}` : joined
  }
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/u)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (line !== '') return line
  }
  return null
}


/** Real spawn: detached child + process-group kill wrapper (POSIX), so a hung install child can
 *  be reaped as a group. The gateway wraps it to record the crash-orphan pid. */
export function spawnMutationChild(command: string, args: string[], options: SpawnOptions): MutationChild {
  const child = spawnCommand(command, args, { ...options, detached: process.platform !== 'win32' })
  return {
    pid: child.pid,
    kill(signal) {
      if (process.platform === 'win32' || child.pid === undefined) return child.kill(signal)
      try {
        process.kill(-child.pid, signal)
        return true
      } catch {
        return child.kill(signal)
      }
    },
    once(event, listener) {
      child.once(event as never, listener as never)
    },
    stdout: child.stdout,
    stderr: child.stderr,
  }
}

/** The built-in executor: bounded capture + timeout, TERM→KILL on the process group, deterministic mapping. */
function runDefaultMutationChild(
  execution: MutationChildExecution,
  spawnFn: MutationSpawnFn,
  onSpawnChild: ((child: MutationChild) => void) | undefined,
): Promise<MutationChildOutcome> {
  return new Promise(resolve => {
    let settled = false
    let child: MutationChild | null = null
    const stdout = new BoundedOutput(execution.stdoutLimit)
    const stderr = new BoundedOutput(execution.stderrLimit)
    let timedOut = false
    let timeoutHandle: NodeJS.Timeout | undefined
    let graceHandle: NodeJS.Timeout | undefined

    const finish = (outcome: MutationChildOutcome): void => {
      if (settled) return
      settled = true
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      if (graceHandle !== undefined) clearTimeout(graceHandle)
      resolve(outcome)
    }

    try {
      child = spawnFn(execution.command, execution.args, {
        env: execution.env,
        cwd: execution.cwd,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ code: null, signal: null, stdout: '', stderr: '', error: `failed to spawn dsh plugin command: ${errorMessage(error)}` })
      return
    }
    const running = child

    try {
      onSpawnChild?.(running)
      if (running.pid !== undefined) execution.onSpawn?.(running.pid)
    } catch (error) {
      // A hook failure must not leave an unsupervised child behind.
      try {
        running.kill('SIGTERM')
      } catch {
        // best effort
      }
      finish({ code: null, signal: null, stdout: '', stderr: '', error: `mutation child hook failed: ${errorMessage(error)}` })
      return
    }

    timeoutHandle = setTimeout(() => {
      timedOut = true
      try {
        running.kill('SIGTERM')
      } catch {
        // kill is best effort; the grace timer settles the outcome.
      }
      graceHandle = setTimeout(() => {
        try {
          running.kill('SIGKILL')
        } catch {
          // ignore
        }
        finish({ code: null, signal: null, stdout: stdout.text(), stderr: stderr.text(), error: ERROR_MUTATION_TIMED_OUT })
      }, MUTATION_SIGNAL_GRACE_MS)
    }, execution.timeoutMs)

    running.once('error', error => {
      finish({ code: null, signal: null, stdout: stdout.text(), stderr: stderr.text(), error: `failed to spawn dsh plugin command: ${errorMessage(error)}` })
    })
    running.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({ code: null, signal: null, stdout: stdout.text(), stderr: stderr.text(), error: ERROR_MUTATION_TIMED_OUT })
        return
      }
      finish({ code, signal, stdout: stdout.text(), stderr: stderr.text() })
    })
    running.stdout?.on('data', chunk => stdout.push(chunk))
    running.stderr?.on('data', chunk => stderr.push(chunk))
  })
}

/** Map a raw child outcome to the shared mutation result vocabulary. */
export function mutationOutcomeToResult(
  outcome: MutationChildOutcome,
  sanitize: (text: string) => string,
): PluginMutationResult {
  if (outcome.error !== undefined) return { ok: false, error: sanitize(outcome.error) }
  if (outcome.code === 0) return { ok: true }
  const line = lastNonEmptyLine(outcome.stderr) ?? lastNonEmptyLine(outcome.stdout)
  let error: string
  if (outcome.code === null) {
    error = `dsh plugin command was terminated by ${outcome.signal ?? 'unknown signal'}`
  } else if (line === null) {
    error = `dsh plugin command exited with code ${outcome.code}`
  } else {
    error = line
  }
  return { ok: false, error: sanitize(error) }
}

/** Run one restricted mutation child under the shared discipline. Never throws for its own
 * failures; an injected executor's rejection propagates by design. */
export async function runPluginMutation(params: PluginMutationParams): Promise<PluginMutationResult> {
  const timeoutMs = params.timeoutMs ?? MUTATION_TIMEOUT_DEFAULT_MS
  const stdoutLimit = params.stdoutLimit ?? MUTATION_OUTPUT_CAPTURE_LIMIT_DEFAULT_BYTES
  const stderrLimit = params.stderrLimit ?? MUTATION_OUTPUT_CAPTURE_LIMIT_DEFAULT_BYTES
  const execution: MutationChildExecution = {
    command: params.command,
    args: [...(params.argvPrefix ?? []), ...params.argv],
    env: params.env,
    cwd: params.cwd,
    timeoutMs,
    stdoutLimit,
    stderrLimit,
  }
  const execute: MutationChildExecutor = params.childExecutor
    ?? (request => runDefaultMutationChild(request, params.spawn ?? spawnMutationChild, params.onSpawn))
  const outcome = await execute(execution)
  return mutationOutcomeToResult(outcome, params.sanitize)
}
