/**
 * Design 18 activation probes. This module owns the real, read-only probe
 * list while keeping the control-plane wire injectable for hermetic tests.
 *
 * Wire baseline: the pinned upstream dsh tree (0.1.5-alpha.2). All unary
 * endpoints moved from dot to slash (`session.list` → `session/list`,
 * `settings.describe` → `settings/describe`) and typert remotes require
 * `payload.args`; `host.describe` was deleted (its host-capability role is
 * served by the fixed-size identity probe `session/canOpenWorkspacePath` —
 * the zero-arg boolean Remote of the upstream SessionController's `session`
 * namespace, which never reads session data, never activates an Agent and
 * performs no IO, so the probe response is a constant-size boolean no matter
 * how many sessions exist) and `workspace.list` became the `workspace/follow`
 * stream (unary incompatible, so the workspace-shape probe was removed).
 * Runtime trees that predate the identity method (dsh < 0.1.2-rc.1) answer
 * HTTP 404; the probe layer then falls back to the legacy `session/list`
 * probe (the exact call today's probe layer made), keeping old-tree
 * activation/rollback behavior identical. `data.sessions` was removed with
 * the session-data coupling: the identity probe deliberately never reads the
 * session list, so a session-readability row no longer exists. A legacy
 * fallback fires the optional `warn` sink when the caller wired one (the
 * desktop control-plane's own identity probes warn on the same condition via
 * their logger — see control-plane dsh-client probeHostIdentity).
 *
 * dsh-v0.1.3-alpha.1 delta (source line, 2026-09): the `commands/execute`
 * third wire argument was renamed `images` → `attachments` (`readonly
 * CommandSubmitAttachment[]` in the session-controller client projection;
 * host execute param `submittedAttachments`) — the probe payload below follows
 * the rename; upstream's generated typert wire key is not committed, so a
 * live 0.1.3 install re-verification is still owed before the runtime line
 * follows (see STATUS dsh 基线对齐记录).
 */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  HOST_DOMAIN_PROBE_NAMES,
  activationProbeNamesForDomains,
  type ProbeResult,
} from './activation-gate.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export interface RuntimeProbeRpcOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /**
   * Per-call response-body cap forwarded to the injected carrier (the
   * control-plane unary client enforces it in readBoundedJson). The
   * settings/describe probe passes SETTINGS_FILE_MAX_BYTES so a legitimately
   * large settings response can never be mistaken for a misbehaving host.
   */
  maxResponseBytes?: number
}

/** Optional warning sink for the legacy identity-method fallback. Fired only
 *  AFTER the legacy session/list fallback succeeded (same timing as the
 *  control-plane probeHostIdentity): a successful legacy answer proves the
 *  runtime tree predates session/canOpenWorkspacePath, while a both-404 or a
 *  failing fallback stays quiet — the failure itself is already loud. */
export type RuntimeProbeWarn = (line: string) => void

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
  /** Warning sink fired when the session probe's legacy session/list
   *  fallback SUCCEEDS after an identity-method 404 (upstream method drift
   *  must stay visible, never silent; a failing fallback is already loud). */
  warn?: RuntimeProbeWarn
  /**
   * 2026-12 shape-awareness: whether the spawned dsh is expected to carry the
   * chamber host packages (clientGraph/graph + gitWorktree/previewCreate +
   * archiveCleanup/probe domains). The desktop shape always verifies them;
   * the gateway shape only when a desktop has synced its host packages into
   * the seed cache — a fresh gateway with no synced cache hosts a plain dsh
   * whose activation must pass without the chamber domains. Default true.
   */
  hostDomains?: boolean
  /**
   * Design 24 §7 C (M2 derivation): the EXACT chamber host domains this
   * spawn actually carries, derived from the seeded host entries
   * (gateway: syncedHostDomainProbeNames). Takes precedence over
   * `hostDomains`; an empty list runs no chamber-domain probe (the reduced
   * set), a partial list runs exactly those domains (2-of-3 partial syncs
   * get a well-defined expectation instead of a binary all-or-none gate),
   * and the full list equals the all-domains shape. The returned probe set
   * and the verdict expectation are both derived from this list.
   */
  hostDomainNames?: readonly string[]
}

/**
 * The fixed-size host-identity wire method and the generation that introduced
 * it. Mirrored from control-plane's `rpc-envelope.ts` (A2 cross-package
 * single-sourcing): this package deliberately has no dependency on the control
 * plane, so the two constants are kept textually identical and the gate
 * `verify-upstream-touchpoints` C10 flags any live version literal outside the
 * registered anchors.
 */
const HOST_IDENTITY_METHOD = 'session/canOpenWorkspacePath'
const LEGACY_HOST_PROBE_METHOD = 'session/list'
const HOST_IDENTITY_METHOD_SINCE = '0.1.2-rc.1'

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

/** archiveCleanup/probe accept predicate (design 24 §7 C): the method must
 *  answer a well-formed domain carrier — ok:true with an object value is
 *  healthy; a well-formed ok:false (binding-pending / registry-unreadable /
 *  busy) is present-but-abnormal and fails closed with a distinct message in
 *  the probe leg itself (a business answer on empty input is never a
 *  protocol success). */
function archiveCleanupProbeShape(value: unknown): 'ok' | 'business-failure' | 'malformed' {
  if (!objectValue(value)) return 'malformed'
  const domain = value as Record<string, unknown>
  if (domain.ok === true) return objectValue(domain.value) ? 'ok' : 'malformed'
  if (domain.ok === false) return objectValue(domain.error) ? 'business-failure' : 'malformed'
  return 'malformed'
}

/**
 * The legacy-fallback signal: an injected carrier error carrying transport
 * status 404 (the control-plane unary client's RpcTransportError.status) —
 * the HTTP bridge answers 404 exactly when the runtime tree does not
 * register the identity method. Any other carrier failure (401 auth gate,
 * 5xx, timeout, malformed body) or business error fails loud and never
 * downgrades to the session-data probe.
 */
function identityMethodNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { status?: unknown }).status === 404
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
  const call = (method: string, payload: unknown, maxResponseBytes?: number) => {
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
      ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
    }))
    return raceWithSignal(operation, rpcSignal).finally(() => clearTimeout(timer))
  }

  let settingsRpcOk = false

  const probe = async (
    name: string,
    method: string,
    payload: unknown,
    accept?: (value: unknown) => boolean,
    maxResponseBytes?: number,
  ): Promise<ProbeResult> => {
    try {
      const response = await call(method, payload, maxResponseBytes)
      const value = response.result?.value
      if (accept !== undefined && !accept(value)) {
        return { name, ok: false, error: 'malformed probe response' }
      }
      return { name, ok: true }
    } catch (error) {
      return { name, ok: false, error: resultError(error) }
    }
  }

  // Design 24 §7 C (M2 derivation): the chamber domains actually expected are
  // `hostDomainNames` when the caller derived them from the seeded host
  // entries (gateway partial syncs), else the legacy binary shape
  // (hostDomains=false runs NO chamber-domain probe; default = all domains).
  const hostDomainNames = opts.hostDomainNames ?? (opts.hostDomains === false ? [] : [...HOST_DOMAIN_PROBE_NAMES])
  const wantsDomain = (domain: string): boolean => hostDomainNames.includes(domain)
  const [sessions, graph, settings, git, archiveCleanup] = await Promise.all([
    // The fixed-size host-identity probe: session/canOpenWorkspacePath is a
    // zero-arg boolean Remote of the upstream SessionController (`session`
    // namespace, dsh ≥ 0.1.2-rc.1). Value true AND value false are both
    // healthy — only method presence / protocol correctness / controller
    // assembly is under test. A runtime tree that predates the identity
    // method answers HTTP 404 and is served by the legacy session/list probe
    // (the same call this layer made before), which keeps old-tree
    // activation/rollback behavior identical; the fallback fires the warn
    // sink so upstream method drift never goes silent.
    (async (): Promise<ProbeResult> => {
      const name = HOST_IDENTITY_METHOD
      try {
        const response = await call(name, { args: {} })
        return typeof response.result?.value === 'boolean'
          ? { name, ok: true }
          : { name, ok: false, error: 'malformed probe response' }
      } catch (error) {
        if (identityMethodNotFound(error)) {
          try {
            const legacy = await call(LEGACY_HOST_PROBE_METHOD, { args: { _request: {} } })
            // IDENTITY-LEG DIVERGENCE (stage2 ruling, 2026): the cp twin
            // (dsh-client.ts probeHostIdentity) only requires an object; this
            // core leg demands Array.isArray(items) — align only via a probe-
            // seam shape injection (dsh-runtime cannot import cp); do not
            // relax this check without a ruling.
            // Restore the pre-migration session/list row's shape check (the
            // old activation row failed a value without the {items} session
            // list as 'malformed session list'): an ok:true legacy envelope
            // carrying no list is a damaged host, not a healthy old tree —
            // "old-tree activation identical" includes this check.
            const legacyValue = legacy.result?.value
            if (typeof legacyValue !== 'object' || legacyValue === null
              || !Array.isArray((legacyValue as { items?: unknown }).items)) {
              return { name, ok: false, error: 'malformed session list' }
            }
            // Warn only after the fallback SUCCEEDED — same timing as the
            // control-plane probeHostIdentity; a both-404 or failing legacy
            // fallback is already loud on its own.
            opts.warn?.(`runtime activation session probe: ${name} answered HTTP 404 while the legacy ${LEGACY_HOST_PROBE_METHOD} probe succeeded — the runtime tree predates the identity method (dsh < ${HOST_IDENTITY_METHOD_SINCE}); the legacy probe response grows with session data`)
            return { name, ok: true }
          } catch (legacyError) {
            if (identityMethodNotFound(legacyError)) {
              return { name, ok: false, error: `neither ${name} nor the legacy session/list method is registered (HTTP 404)` }
            }
            return { name, ok: false, error: resultError(legacyError) }
          }
        }
        return { name, ok: false, error: resultError(error) }
      }
    })(),
    wantsDomain('clientGraph/graph')
      ? probe('clientGraph/graph', 'clientGraph/graph', { args: {} }, graphValue)
      : Promise.resolve(null),
    (async () => {
      // B1: per-call response cap aligned with SETTINGS_FILE_MAX_BYTES — a
      // legitimately large settings response (a 16 MiB settings.yaml renders
      // an equally large describe payload) must never be misread as a
      // misbehaving host by the default 1 MiB unary cap.
      const outcome = await probe('settings/describe', 'settings/describe', { args: {} }, settingsValue, SETTINGS_FILE_MAX_BYTES)
      settingsRpcOk = outcome.ok
      return outcome
    })(),
    // Empty input is rejected by domain validation before any git process or
    // repository scan. Require that exact business miss; a success value would
    // no longer prove the request stayed on the side-effect-free path.
    wantsDomain('gitWorktree/previewCreate')
      ? probe(
        'gitWorktree/previewCreate',
        'gitWorktree/previewCreate',
        { args: { input: {} } },
        expectedGitValidationMiss,
      )
      : Promise.resolve(null),
    // archiveCleanup/probe (design 24, M1 execution leg): zero-arg, no
    // side effects. Presence = a well-formed domain carrier answer; a
    // well-formed business failure means the domain IS mounted but abnormal
    // (binding-pending / registry-unreadable / busy) → fail-closed. A
    // success without an object value is malformed. No legacy fallback —
    // chamber host domains never downgrade (gitWorktree parity).
    wantsDomain('archiveCleanup/probe')
      ? (async (): Promise<ProbeResult> => {
        const name = 'archiveCleanup/probe'
        try {
          const response = await call(name, { args: {} })
          const shape = archiveCleanupProbeShape(response.result?.value)
          if (shape === 'ok') return { name, ok: true }
          if (shape === 'business-failure') {
            return { name, ok: false, error: 'archiveCleanup domain answered a business failure on empty input' }
          }
          return { name, ok: false, error: 'malformed probe response' }
        } catch (error) {
          return { name, ok: false, error: resultError(error) }
        }
      })()
      : Promise.resolve(null),
  ])

  let commands: ProbeResult
  try {
    // Never address a real persisted session: Typert's Agent lookup may cold-
    // resume it before CommandRuntime sees even a syntax-miss line. A fixed
    // nonexistent identity must fail at the read-only persistence lookup with
    // session/not-found, before Agent publication or command/run appends.
    // dsh-v0.1.3-alpha.1 projection execute(agentId, line, attachments, signal):
    // the Agent parameter is a typert lookup wired as `agentId`
    // (session-controller resolveAgent) whose cold miss still surfaces
    // session/not-found; the third argument was renamed images -> attachments
    // (CommandSubmitAttachment[]) on the 0.1.3 wire.
    await call('commands/execute', {
      args: {
        agentId: COMMAND_MISSING_SESSION,
        line: COMMAND_SYNTAX_MISS,
        attachments: [],
      },
    })
    commands = { name: 'commands/execute', ok: false, error: 'missing-session command probe unexpectedly executed' }
  } catch (error) {
    const code = typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined
    // The exact domain miss proves the execute Remote decoded its Agent
    // argument while guaranteeing CommandRuntime itself was never entered.
    commands = code === 'session/not-found'
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

  const byName = new Map<string, ProbeResult>()
  byName.set(commands.name, commands)
  byName.set(sessions.name, sessions)
  if (wantsDomain('clientGraph/graph')) {
    if (graph === null) throw new Error('internal: chamber host-domain probes did not run')
    byName.set(graph.name, graph)
  }
  if (wantsDomain('gitWorktree/previewCreate')) {
    if (git === null) throw new Error('internal: chamber host-domain probes did not run')
    byName.set(git.name, git)
  }
  if (wantsDomain('archiveCleanup/probe')) {
    if (archiveCleanup === null) throw new Error('internal: chamber host-domain probes did not run')
    byName.set(archiveCleanup.name, archiveCleanup)
  }
  byName.set(settings.name, settings)
  byName.set(dataSettings.name, dataSettings)
  // Return in the contract order, making exact-set drift visible in tests.
  // The expected set is derived from the ACTUALLY expected chamber domains
  // (empty list = the reduced set; partial lists = base + listed domains),
  // so a caller's probeExpectedNames must match activationProbeNamesForDomains
  // of the same list (partial 2-of-3 syncs no longer trip an exact-set miss).
  const expected = activationProbeNamesForDomains(hostDomainNames)
  return expected.map(name => byName.get(name) ?? ({ name, ok: false, error: 'probe not wired' }))
}
