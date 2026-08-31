/**
 * Design 18 activation probes. This module owns the real, read-only probe
 * list while keeping the control-plane wire injectable for hermetic tests.
 *
 * Wire baseline: upstream dsh-v0.1.2-alpha.1. All unary endpoints moved from
 * dot to slash (`session.list` → `session/list`, `settings.describe` →
 * `settings/describe`) and typert remotes require `payload.args`; `host.describe`
 * was deleted (its host-capability role is served by the `session/list` probe)
 * and `workspace.list` became the `workspace/follow` stream (unary incompatible,
 * so the workspace-shape probe was removed; `data.sessions` validates the
 * session list only). `commands/execute` keeps the `{agentId, line, images}`
 * wire and its `session-not-found` lookup miss (audit W11).
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { REQUIRED_ACTIVATION_PROBES, type ProbeResult } from './activation-gate.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export interface RuntimeProbeRpcOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export type RuntimeProbeCall = (
  baseUrl: string,
  method: string,
  payload: unknown,
  options?: RuntimeProbeRpcOptions,
) => Promise<{ result?: { value?: unknown } }>

export interface RuntimeProbeOptions {
  baseUrl: string
  dshHome: string
  call: RuntimeProbeCall
  signal?: AbortSignal
  /** Whole compatibility window, including every RPC (default 60s). */
  windowMs?: number
  /** Per-RPC cap so one endpoint cannot consume the entire window. */
  rpcTimeoutMs?: number
}

export const SETTINGS_FILE_MAX_BYTES = 16 * 1024 * 1024
const MAX_TIMER_MS = 2_147_483_647
const SETTINGS_FILE_READ_CHUNK_BYTES = 64 * 1024
const COMMAND_SYNTAX_MISS = 'dsh-chamber-activation-probe'
const COMMAND_MISSING_SESSION = '__dsh_chamber_missing_session_probe__'

function renderError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return '<unrenderable error>'
  }
}

const resultError = (error: unknown): string => {
  // Strip quoted absolute paths first so spaces cannot defeat the shared
  // token-oriented sanitizer; then apply the repository-wide fallback.
  const withoutQuotedPaths = renderError(error)
    .replace(/(['"])(?:[A-Za-z]:[\\/]|\/)[^'"\r\n]*\1/gu, '[path]')
  return sanitizeErrorText(withoutQuotedPaths).slice(0, 2_000)
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error(typeof signal.reason === 'string' ? signal.reason : 'runtime probe aborted')
}

/** Enforce a deadline even when an injected/misbehaving caller ignores AbortSignal. */
function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function safeFsCode(error: unknown): string {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(code) ? ` (${code})` : ''
}

/**
 * Read one regular, non-symlink UTF-8 file without ever allocating from an
 * attacker-controlled size. `fstat` happens before allocation; reads stop at
 * the validated size plus one byte, so growth races fail closed too.
 */
async function readBoundedRegularUtf8File(filePath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let handle
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    // Never project the OS message: it embeds the absolute userData path and
    // generic regex redaction cannot perfectly cover quoted paths with spaces.
    throw new Error(`settings.yaml could not be opened${safeFsCode(error)}`)
  }
  try {
    let info
    try {
      info = await handle.stat()
    } catch (error) {
      throw new Error(`settings.yaml could not be inspected${safeFsCode(error)}`)
    }
    if (!info.isFile()) throw new Error('settings.yaml is not a regular file')
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > SETTINGS_FILE_MAX_BYTES) {
      throw new Error('settings.yaml is unexpectedly large')
    }

    // One extra byte detects growth beyond the fstat snapshot. This allocation
    // is bounded by SETTINGS_FILE_MAX_BYTES + 1, never by a later file size.
    const capacity = Math.min(SETTINGS_FILE_MAX_BYTES + 1, Math.max(1, info.size + 1))
    const bytes = Buffer.allocUnsafe(capacity)
    let offset = 0
    while (offset < capacity) {
      signal.throwIfAborted()
      const length = Math.min(SETTINGS_FILE_READ_CHUNK_BYTES, capacity - offset)
      let bytesRead: number
      try {
        const readResult = await handle.read(bytes, offset, length, null)
        bytesRead = readResult.bytesRead
      } catch (error) {
        throw new Error(`settings.yaml could not be read${safeFsCode(error)}`)
      }
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== info.size || offset > SETTINGS_FILE_MAX_BYTES) {
      throw new Error('settings.yaml changed while being read or is unexpectedly large')
    }
    signal.throwIfAborted()
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
    } catch {
      throw new Error('settings.yaml is not valid UTF-8')
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

function sessionItems(value: unknown): Array<Record<string, unknown>> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const items = (value as Record<string, unknown>).items
  if (!Array.isArray(items) || !items.every(item => (
    item !== null && typeof item === 'object' && !Array.isArray(item)
  ))) return null
  return items as Array<Record<string, unknown>>
}

function objectValue(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function graphValue(value: unknown): boolean {
  return objectValue(value) && Array.isArray((value as Record<string, unknown>).entries)
}

function settingsValue(value: unknown): boolean {
  return objectValue(value) && Array.isArray((value as Record<string, unknown>).namespaces)
}

function expectedGitValidationMiss(value: unknown): boolean {
  if (!objectValue(value)) return false
  const result = value as Record<string, unknown>
  if (result.ok !== false || !objectValue(result.error)) return false
  return (result.error as Record<string, unknown>).code === 'invalid-input'
}

/** Execute the exact closed probe set required by activation-gate.ts. */
export async function runRuntimeActivationProbes(opts: RuntimeProbeOptions): Promise<ProbeResult[]> {
  const windowMs = opts.windowMs ?? 60_000
  const rpcTimeoutMs = opts.rpcTimeoutMs ?? 7_500
  if (!Number.isInteger(windowMs) || windowMs <= 0 || windowMs > MAX_TIMER_MS) {
    throw new Error('probe window must be a positive timer-safe integer')
  }
  if (!Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0 || rpcTimeoutMs > MAX_TIMER_MS) {
    throw new Error('RPC timeout must be a positive timer-safe integer')
  }

  const windowSignal = AbortSignal.timeout(windowMs)
  const signal = opts.signal === undefined ? windowSignal : AbortSignal.any([opts.signal, windowSignal])
  const perCallTimeoutMs = Math.min(windowMs, rpcTimeoutMs)
  const call = (method: string, payload: unknown) => {
    if (signal.aborted) return Promise.reject(abortReason(signal))
    // AbortSignal.timeout is unref'd in Node. The explicit timer keeps a
    // short-lived probe process alive until an injected forever-pending call
    // has been rejected, then is always cleared.
    const rpcDeadline = new AbortController()
    const timer = setTimeout(
      () => rpcDeadline.abort(new Error('runtime RPC probe timed out')),
      perCallTimeoutMs,
    )
    const rpcSignal = AbortSignal.any([signal, rpcDeadline.signal])
    const operation = Promise.resolve().then(() => opts.call(opts.baseUrl, method, payload, {
      signal: rpcSignal,
      timeoutMs: perCallTimeoutMs,
    }))
    return raceWithSignal(operation, rpcSignal).finally(() => clearTimeout(timer))
  }

  let sessionsValue: unknown
  let settingsRpcOk = false

  const probe = async (
    name: string,
    method: string,
    payload: unknown,
    accept?: (value: unknown) => boolean,
  ): Promise<ProbeResult> => {
    try {
      const response = await call(method, payload)
      const value = response.result?.value
      if (accept !== undefined && !accept(value)) {
        return { name, ok: false, error: 'malformed probe response' }
      }
      return { name, ok: true }
    } catch (error) {
      return { name, ok: false, error: resultError(error) }
    }
  }

  const [sessions, graph, settings, git] = await Promise.all([
    // host.describe was deleted upstream (dsh-v0.1.2-alpha.1); the surviving
    // session/list read-only unary doubles as the host-capability probe
    // proving the installed dsh answers the business wire.
    (async () => {
      try {
        const response = await call('session/list', { args: { _request: {} } })
        sessionsValue = response.result?.value
        return sessionItems(sessionsValue) === null
          ? { name: 'session/list', ok: false, error: 'malformed session list' }
          : { name: 'session/list', ok: true }
      } catch (error) {
        return { name: 'session/list', ok: false, error: resultError(error) }
      }
    })(),
    probe('clientGraph/graph', 'clientGraph/graph', { args: {} }, graphValue),
    (async () => {
      const outcome = await probe('settings/describe', 'settings/describe', { args: {} }, settingsValue)
      settingsRpcOk = outcome.ok
      return outcome
    })(),
    // Empty input is rejected by domain validation before any git process or
    // repository scan. Require that exact business miss; a success value would
    // no longer prove the request stayed on the side-effect-free path.
    probe(
      'gitWorktree/previewCreate',
      'gitWorktree/previewCreate',
      { args: { input: {} } },
      expectedGitValidationMiss,
    ),
  ])

  let commands: ProbeResult
  try {
    // Never address a real persisted session: Typert's Agent lookup may cold-
    // resume it before CommandRuntime sees even a syntax-miss line. A fixed
    // nonexistent identity must fail at the read-only persistence lookup with
    // session-not-found, before Agent publication or command/run appends.
    // dsh-v0.1.2-alpha.1 keeps execute(agent: Agent, line, images, signal): the
    // Agent parameter is a typert lookup wired as `agentId` (session-controller
    // resolveAgent) whose cold miss still surfaces session-not-found.
    await call('commands/execute', {
      args: {
        agentId: COMMAND_MISSING_SESSION,
        line: COMMAND_SYNTAX_MISS,
        images: [],
      },
    })
    commands = { name: 'commands/execute', ok: false, error: 'missing-session command probe unexpectedly executed' }
  } catch (error) {
    const code = typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined
    // The exact domain miss proves the execute Remote decoded its Agent
    // argument while guaranteeing CommandRuntime itself was never entered.
    commands = code === 'session-not-found'
      ? { name: 'commands/execute', ok: true }
      : { name: 'commands/execute', ok: false, error: resultError(error) }
  }

  let dataSettings: ProbeResult
  try {
    await readBoundedRegularUtf8File(join(opts.dshHome, 'settings.yaml'), signal)
    if (!settingsRpcOk) throw new Error('settings RPC could not parse the active profile')
    dataSettings = { name: 'data.settings', ok: true }
  } catch (error) {
    dataSettings = { name: 'data.settings', ok: false, error: resultError(error) }
  }

  const dataSessions: ProbeResult = sessionItems(sessionsValue) !== null
    ? { name: 'data.sessions', ok: true }
    : { name: 'data.sessions', ok: false, error: 'session data is unreadable' }

  const byName = new Map<string, ProbeResult>([
    [commands.name, commands],
    [sessions.name, sessions],
    [graph.name, graph],
    [settings.name, settings],
    [git.name, git],
    [dataSettings.name, dataSettings],
    [dataSessions.name, dataSessions],
  ])
  // Return in the contract order, making exact-set drift visible in tests.
  return REQUIRED_ACTIVATION_PROBES.map(name => byName.get(name) ?? ({ name, ok: false, error: 'probe not wired' }))
}
