/**
 * Activation probes: the real, read-only probe list with an injectable wire.
 *
 * Wire shape is the pinned upstream dsh tree: unary endpoints use the slash form
 * (`session/list`, `settings/describe`) and typert remotes require `payload.args`. The
 * host-capability role is the fixed-size identity probe `session/canOpenWorkspacePath` — a
 * zero-arg boolean Remote that never reads session data, never activates an Agent and performs
 * no IO. Pre-identity trees answer 404 and fall back to `session/list` (old-tree behavior
 * unchanged, the REQUIRED `warn` sink fires); 0.1.7 settings use the active profile's
 * `hasDocument` fact while older trees retain a bounded legacy-file read; `commands/execute`'s third wire argument is
 * `submittedAttachments`, and drift is rejected loud with `gateway/arguments-invalid`.
 */
import { constants, type Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import {
  HOST_DOMAIN_PROBE_NAMES,
  REQUIRED_ACTIVATION_PROBES,
  activationProbeNamesForDomains,
  type ProbeResult,
} from './activation-gate.ts'
import {
  openPrivateNoFollowReadAsync,
  PrivateNoFollowOpenError,
  type NoFollowConstantsLike,
} from './private-fs.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export interface RuntimeProbeRpcOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Per-call response-body cap forwarded to the injected carrier. The settings/describe
   *  probe passes SETTINGS_FILE_MAX_BYTES so a legitimately large response is never
   *  mistaken for a misbehaving host. */
  maxResponseBytes?: number
}

/** Warning sink for the legacy identity-method fallback, fired only AFTER the legacy
 *  session/list fallback succeeded; a both-404 or a failing fallback stays quiet. */
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
  /** Warning sink fired when the legacy session/list fallback SUCCEEDS after an
   *  identity-method 404. REQUIRED: this layer is the only place the fallback is observable,
   *  so the type rejects omission up front instead of silently degrading the wire. */
  warn: RuntimeProbeWarn
  /**
   * Legacy-fallback value predicate seam: after an identity-method 404 the session/list value
   * must prove the old-tree session shape. The default (defaultLegacyShape) demands an object
   * carrying an `items` array; a host owning a different canonical predicate (the control
   * plane's isLegacyHostProbeValue) injects it here instead of editing this core.
   */
  legacyShape?: (value: unknown) => boolean
  /**
   * The EXACT chamber host domains this spawn carries, derived from the seeded host entries. An
   * empty list runs no chamber-domain probe (the reduced set), a partial list runs exactly those
   * domains, and the full list equals the all-domains shape; the returned probe set and the
   * verdict expectation both derive from this list.
   */
  hostDomainNames?: readonly string[]
  /**
   * Deterministic no-follow fallback seam (private-fs.ts NoFollowConstantsLike): win32 exports
   * neither O_NOFOLLOW nor O_DIRECTORY, so the settings reader re-proves the leaf in user space;
   * tests pass a constants table without O_NOFOLLOW.
   */
  settingsNoFollowConstants?: NoFollowConstantsLike
}

/**
 * The fixed-size host-identity wire method, mirrored textually from the control-plane's
 * `rpc-envelope.ts` (cross-package single-sourcing): this package must not depend on the
 * control plane, so the two constants are kept identical by hand.
 */
const HOST_IDENTITY_METHOD = 'session/canOpenWorkspacePath'
const LEGACY_HOST_PROBE_METHOD = 'session/list'
const HOST_IDENTITY_METHOD_SINCE = '0.1.2-rc.1'

/**
 * Probe-engine failure-text literals the shared path sanitizer must NOT read as filesystem
 * material. {@link sanitizeErrorText} matches `word/word` from inside a token, so without this
 * vocabulary `commands/execute` is republished as `commands[path]`. The legacy method is
 * included because the both-404 diagnosis names it while it is deliberately NOT required.
 */
export const PROBE_TEXT_KEEP_TOKENS = [...REQUIRED_ACTIVATION_PROBES, LEGACY_HOST_PROBE_METHOD] as const

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

const resultError = (error: unknown, method = ''): string => {
  // Strip quoted absolute paths first so spaces cannot defeat the shared token-oriented
  // sanitizer; the probe's method name is kept as RPC vocabulary, not path material.
  // `method` is empty only for the data.settings probe, which holds no method name.
  const withoutQuotedPaths = renderError(error)
    .replace(/(['"])(?:[A-Za-z]:[\\/]|\/)[^'"\r\n]*\1/gu, '[path]')
  return sanitizeErrorText(withoutQuotedPaths, method === '' ? [] : [method]).slice(0, 2_000)
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
 * Read one regular, non-symlink UTF-8 file without allocating from an attacker-controlled size:
 * `fstat` happens before allocation and reads stop at the validated size plus one byte, so
 * growth races fail closed too.
 *
 * Without O_NOFOLLOW (win32) the leaf is lstat-ed immediately before the open, a symlink is
 * refused, and afterwards the path must still name the exact (dev, ino); POSIX keeps
 * O_RDONLY|O_NOFOLLOW. The strategy itself is single-sourced in private-fs.ts.
 */
async function readBoundedRegularUtf8File(
  filePath: string,
  signal: AbortSignal,
  constantsLike: NoFollowConstantsLike = constants,
): Promise<void> {
  signal.throwIfAborted()
  // The no-follow strategy is single-sourced in private-fs.ts; this wrapper keeps probe-local
  // sanitized messages, since the OS error would embed the absolute userData path.
  let handle: FileHandle
  let info: Stats
  try {
    const opened = await openPrivateNoFollowReadAsync(filePath, constantsLike)
    handle = opened.handle
    info = opened.stats
  } catch (error) {
    if (error instanceof PrivateNoFollowOpenError) {
      if (error.phase === 'symlink') throw new Error('settings.yaml is a symbolic link')
      if (error.phase === 'identity-mismatch') {
        throw new Error('settings.yaml changed while being opened or is a symbolic link')
      }
      if (error.phase === 'inspect-failed') {
        throw new Error(`settings.yaml could not be inspected${safeFsCode(error.detail ?? error)}`)
      }
      throw new Error(`settings.yaml could not be opened${safeFsCode(error.detail ?? error)}`)
    }
    throw new Error(`settings.yaml could not be opened${safeFsCode(error)}`)
  }
  try {
    if (!info.isFile()) throw new Error('settings.yaml is not a regular file')
    if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > SETTINGS_FILE_MAX_BYTES) {
      throw new Error('settings.yaml is unexpectedly large')
    }

    // One extra byte detects growth beyond the fstat snapshot; the allocation is bounded by
    // SETTINGS_FILE_MAX_BYTES + 1, never by a later file size.
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

function settingsValue(value: unknown): value is { namespaces: unknown[]; hasDocument?: unknown } {
  return objectValue(value) && Array.isArray((value as Record<string, unknown>).namespaces)
}

function expectedGitValidationMiss(value: unknown): boolean {
  if (!objectValue(value)) return false
  const result = value as Record<string, unknown>
  if (result.ok !== false || !objectValue(result.error)) return false
  return (result.error as Record<string, unknown>).code === 'invalid-input'
}

/** archiveCleanup/probe accept predicate: a well-formed carrier with ok:false is
 *  present-but-abnormal and fails closed; a business answer on empty input is never a success. */
function archiveCleanupProbeShape(value: unknown): 'ok' | 'business-failure' | 'malformed' {
  if (!objectValue(value)) return 'malformed'
  const domain = value as Record<string, unknown>
  if (domain.ok === true) return objectValue(domain.value) ? 'ok' : 'malformed'
  if (domain.ok === false) return objectValue(domain.error) ? 'business-failure' : 'malformed'
  return 'malformed'
}

/** openInApp/probe accept predicate: ok:true with the platform object; a well-formed ok:false
 *  is present-but-abnormal and fails closed with a distinct message. */
function openInAppProbeShape(value: unknown): 'ok' | 'business-failure' | 'malformed' {
  if (!objectValue(value)) return 'malformed'
  const domain = value as Record<string, unknown>
  if (domain.ok === true) {
    return objectValue(domain.value) && typeof (domain.value as Record<string, unknown>).platform === 'string'
      ? 'ok'
      : 'malformed'
  }
  if (domain.ok === false) return objectValue(domain.error) ? 'business-failure' : 'malformed'
  return 'malformed'
}

/**
 * The legacy-fallback signal: an injected carrier error carrying transport status 404, which the
 * HTTP bridge answers exactly when the runtime tree does not register the identity method. Any
 * other carrier failure (401, 5xx, timeout, malformed body) or business error fails loud.
 */
function identityMethodNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  return (error as { status?: unknown }).status === 404
}

/**
 * The default legacy-fallback predicate: the pre-migration session/list row demanded an object
 * carrying an `items` array, and "old-tree activation identical" includes that check. Differing
 * canonical predicates are injected through RuntimeProbeOptions.legacyShape.
 */
function defaultLegacyShape(value: unknown): boolean {
  // Same predicate as the control-plane isLegacyHostProbeValue: a plain record carrying an
  // items array. The array exclusion matters — an ARRAY owning an `items` property is not a
  // legacy session row.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Array.isArray((value as { items?: unknown }).items)
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
  let settingsHasDocument: boolean | null = null

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
      return { name, ok: false, error: resultError(error, name) }
    }
  }

  // hostDomainNames is the chamber domains the caller actually expects mounted;
  // an empty list is the reduced shape, omitting the option keeps all domains.
  const hostDomainNames = opts.hostDomainNames ?? [...HOST_DOMAIN_PROBE_NAMES]
  const wantsDomain = (domain: string): boolean => hostDomainNames.includes(domain)
  const [sessions, graph, settings, git, archiveCleanup, openInApp] = await Promise.all([
    // Both true and false values are healthy: only method presence, protocol
    // correctness and controller assembly are under test. A pre-identity tree
    // answers 404 here and is served by the legacy session/list probe below.
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
            // This core leg's DEFAULT demands Array.isArray(items) — stricter than the
            // control-plane twin's object-only check and not relaxed without a ruling
            // (dsh-runtime cannot import the control plane); alignment rides the
            // legacyShape injection seam. An ok:true legacy envelope without the items
            // list is a damaged host, not a healthy old tree.
            const legacyValue = legacy.result?.value
            if (!(opts.legacyShape ?? defaultLegacyShape)(legacyValue)) {
              return { name, ok: false, error: 'malformed session list' }
            }
            // Warn only after the fallback SUCCEEDED; a both-404 or failing fallback is
            // already loud.
            opts.warn(`runtime activation session probe: ${name} answered HTTP 404 while the legacy ${LEGACY_HOST_PROBE_METHOD} probe succeeded — the runtime tree predates the identity method (dsh < ${HOST_IDENTITY_METHOD_SINCE}); the legacy probe response grows with session data`)
            return { name, ok: true }
          } catch (legacyError) {
            if (identityMethodNotFound(legacyError)) {
              // Sanitized with the probe vocabulary: the diagnosis names BOTH methods, and a
              // pass without it republishes them as path material.
              return {
                name,
                ok: false,
                error: sanitizeErrorText(
                  `neither ${name} nor the legacy ${LEGACY_HOST_PROBE_METHOD} method is registered (HTTP 404)`,
                  PROBE_TEXT_KEEP_TOKENS,
                ),
              }
            }
            return { name, ok: false, error: resultError(legacyError, name) }
          }
        }
        return { name, ok: false, error: resultError(error, name) }
      }
    })(),
    wantsDomain('clientGraph/graph')
      ? probe('clientGraph/graph', 'clientGraph/graph', { args: {} }, graphValue)
      : Promise.resolve(null),
    (async () => {
      // Cap aligned with SETTINGS_FILE_MAX_BYTES: a legitimately large settings response
      // must never be misread as a misbehaving host.
      const outcome = await probe('settings/describe', 'settings/describe', { args: {} }, (value) => {
        if (!settingsValue(value)) return false
        settingsHasDocument = typeof value.hasDocument === 'boolean' ? value.hasDocument : null
        return true
      }, SETTINGS_FILE_MAX_BYTES)
      settingsRpcOk = outcome.ok
      return outcome
    })(),
    // Empty input is rejected by domain validation before any git process or repository scan;
    // require that exact business miss, since a success value would not prove the request stayed
    // on the side-effect-free path.
    wantsDomain('gitWorktree/previewCreate')
      ? probe(
        'gitWorktree/previewCreate',
        'gitWorktree/previewCreate',
        { args: { input: {} } },
        expectedGitValidationMiss,
      )
      : Promise.resolve(null),
    // archiveCleanup/probe: zero-arg, no side effects. A well-formed business failure means the
    // domain IS mounted but abnormal (binding-pending / registry-unreadable / busy) → fail-closed;
    // a success without an object value is malformed. No legacy fallback.
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
          return { name, ok: false, error: resultError(error, name) }
        }
      })()
      : Promise.resolve(null),
    // openInApp/probe: zero-arg and zero-cost (platform only — no detection, no spawn). A
    // well-formed business failure = mounted but abnormal → fail-closed; no legacy fallback
    // (chamber host domains never downgrade).
    wantsDomain('openInApp/probe')
      ? (async (): Promise<ProbeResult> => {
        const name = 'openInApp/probe'
        try {
          const response = await call(name, { args: {} })
          const shape = openInAppProbeShape(response.result?.value)
          if (shape === 'ok') return { name, ok: true }
          if (shape === 'business-failure') {
            return { name, ok: false, error: 'openInApp domain answered a business failure on empty input' }
          }
          return { name, ok: false, error: 'malformed probe response' }
        } catch (error) {
          return { name, ok: false, error: resultError(error, name) }
        }
      })()
      : Promise.resolve(null),
  ])

  let commands: ProbeResult
  try {
    // Never address a real persisted session: the Agent lookup may cold-resume it before
    // CommandRuntime sees even a syntax-miss line, so a fixed nonexistent identity must fail at
    // the read-only persistence lookup with session/not-found. The projection is
    // execute(agentId, line, submittedAttachments, signal); the typert gateway rejects a drifted
    // third field name with `gateway/arguments-invalid` BEFORE the controller runs.
    await call('commands/execute', {
      args: {
        agentId: COMMAND_MISSING_SESSION,
        line: COMMAND_SYNTAX_MISS,
        submittedAttachments: [],
      },
    })
    commands = { name: 'commands/execute', ok: false, error: 'missing-session command probe unexpectedly executed' }
  } catch (error) {
    const code = typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined
    // The exact domain miss proves the execute Remote decoded its Agent argument while
    // guaranteeing CommandRuntime itself was never entered.
    commands = code === 'session/not-found'
      ? { name: 'commands/execute', ok: true }
      : { name: 'commands/execute', ok: false, error: resultError(error, 'commands/execute') }
  }

  let dataSettings: ProbeResult
  try {
    if (!settingsRpcOk) throw new Error('settings RPC could not parse the active profile')
    if (settingsHasDocument === false) throw new Error('settings RPC reports no active document')
    // New dsh imports settings.yaml into the active profile and renames the old
    // file to settings.yaml.imported. Its settings RPC has already loaded that
    // profile and explicitly reports a document. Older trees omit the flag and
    // retain the legacy file, so keep the bounded read for those trees.
    if (settingsHasDocument === null) {
      await readBoundedRegularUtf8File(join(opts.dshHome, 'settings.yaml'), signal, opts.settingsNoFollowConstants)
    }
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
  if (wantsDomain('openInApp/probe')) {
    if (openInApp === null) throw new Error('internal: chamber host-domain probes did not run')
    byName.set(openInApp.name, openInApp)
  }
  byName.set(settings.name, settings)
  byName.set(dataSettings.name, dataSettings)
  // Return in contract order so exact-set drift is visible; the expected set derives from the
  // actually expected chamber domains, matching a caller's probeExpectedNames to
  // activationProbeNamesForDomains of the same list.
  const expected = activationProbeNamesForDomains(hostDomainNames)
  return expected.map(name => byName.get(name) ?? ({ name, ok: false, error: 'probe not wired' }))
}
