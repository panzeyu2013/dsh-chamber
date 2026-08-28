/**
 * VS Code deep-link core (design 16 §3/§4/§5, desktop main process).
 *
 * Electron-free by construction: this module imports only node built-ins
 * (node:fs / node:os / node:path / node:url) plus the INSTANCE_ID_PATTERN
 * constant from transport-provider.ts (which itself has no runtime imports),
 * so the pure-Node test suite (deep-link.test.ts) runs without electron or
 * any third-party dependency.
 *
 * Responsibilities — all deep-link validation happens here (design 16 §8,
 * the deep link is OS-level untrusted input):
 * - parseOpenVscodeIntent: parse `dsh-chamber://open-vscode` into a
 *   normalized launch request — scheme / host / instance / path all
 *   validated, loud failures only (§3.1).
 * - buildVscodeRemoteUrl: construct the `vscode://vscode-remote/ssh-remote+`
 *   target from registry metadata, decoupled from SSH_HOST_PATTERN (§3.2) —
 *   IPv6 bracketing, `host:port` rejection, sshPort≠22 rejection,
 *   segment-wise path encoding, hardcoded `vscode:` scheme (§3.3).
 * - detectVscodeAvailability: pure fs + PATH scan (never spawns / never
 *   executes anything) for a STABLE VS Code install (§5).
 * - runVscodeLaunch: the single execution pipeline shared by the OS deep
 *   link and the renderer button IPC (§3.4) — registry lookup → authority
 *   construction → availability re-check → openExternal; every failure is
 *   loud, never a silent success.
 *
 * main.ts only wires this module (open-url / pendingIntents / second-instance
 * argv / protocol registration / IPC handlers); it holds no deep-link logic.
 */

import { accessSync, constants as fsConstants, existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INSTANCE_ID_PATTERN } from './transport-provider.ts'

/** A normalized deep-link launch request (design 16 §3.1). */
export interface VscodeLaunchRequest {
  instanceId: string
  path: string
}

/**
 * Dependencies main.ts injects into runVscodeLaunch (design 16 §4). The
 * registry lookup returns the non-secret metadata the authority construction
 * needs; `kind` must be `'ssh'` (runVscodeLaunch re-checks it).
 */
export interface VscodeLaunchContext {
  /** Registry lookup; null = the instance does not exist. `kind` must be 'ssh'. */
  lookupInstance(id: string): { id: string; host: string; user: string | null; sshPort: number | null; kind: string } | null
  /** VS Code availability (the main-process probe, see detectVscodeAvailability). */
  vscodeAvailable(): boolean
  /** Open a vscode:// URL (main-process shell.openExternal wrapper; loud failure). */
  openVscodeUrl(url: string): Promise<{ ok: true } | { ok: false; error: string }>
}

/** Remote path budget (design 16 §3.1). */
const MAX_REMOTE_PATH_CHARS = 4096

/** Convert an arbitrary thrown value into a stable, non-empty diagnostic.
 * Even hostile proxies/getters/toString implementations must not make an
 * exception handler throw a second time and escape the structured result
 * channel. */
export function describeUnknownError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = typeof error.message === 'string' ? error.message : ''
      if (message !== '') return message
      const name = typeof error.name === 'string' ? error.name : ''
      if (name !== '') return name
    }
  } catch {
    // Fall through to the guarded String conversion below.
  }
  try {
    const text = String(error)
    return text === '' ? 'unknown error' : text
  } catch {
    return 'unknown error'
  }
}

/** A bounded, normalized single-flight queue for OS deep-link launches.
 * Keys remain tracked after shift() while the launch is in flight and are
 * released only by complete(), so argv/open-url duplicates cannot race past
 * each other. The hard limit covers pending + in-flight keys. Once complete,
 * a later deliberate invocation is accepted. */
export class BoundedVscodeIntentQueue {
  readonly #limit: number
  readonly #trackedKeys = new Set<string>()
  readonly #pending: Readonly<VscodeLaunchRequest>[] = []

  constructor(limit = 64) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('intent queue limit must be a positive integer')
    this.#limit = limit
  }

  static key(intent: VscodeLaunchRequest): string {
    return JSON.stringify([intent.instanceId, intent.path])
  }

  enqueue(intent: VscodeLaunchRequest):
    | { accepted: true; dropped: Readonly<VscodeLaunchRequest> | null }
    | { accepted: false; dropped: null; reason: 'duplicate' | 'saturated' } {
    const normalized = Object.freeze({ instanceId: intent.instanceId, path: intent.path })
    const key = BoundedVscodeIntentQueue.key(normalized)
    if (this.#trackedKeys.has(key)) return { accepted: false, dropped: null, reason: 'duplicate' }

    let dropped: Readonly<VscodeLaunchRequest> | null = null
    // Capacity covers pending + in-flight keys, not only the array. Prefer
    // evicting the oldest pending item; an all-in-flight queue cannot safely
    // evict ownership and therefore rejects the newcomer explicitly.
    if (this.#trackedKeys.size >= this.#limit) {
      dropped = this.#pending.shift() ?? null
      if (dropped === null) return { accepted: false, dropped: null, reason: 'saturated' }
      this.#trackedKeys.delete(BoundedVscodeIntentQueue.key(dropped))
    }
    this.#pending.push(normalized)
    this.#trackedKeys.add(key)
    return { accepted: true, dropped }
  }

  /** Removes the next pending item but deliberately retains its tracked key
   * until complete() so an equivalent intent stays single-flight. */
  shift(): Readonly<VscodeLaunchRequest> | null {
    return this.#pending.shift() ?? null
  }

  /** Roll back the most recently shifted in-flight item to the FIFO head.
   * Its key deliberately remains tracked across shift/rollback, so this does
   * not consume capacity or open a duplicate-admission window. */
  rollbackShift(intent: VscodeLaunchRequest):
    | { restored: true }
    | { restored: false; reason: 'untracked' | 'already-pending' } {
    const key = BoundedVscodeIntentQueue.key(intent)
    if (!this.#trackedKeys.has(key)) return { restored: false, reason: 'untracked' }
    if (this.#pending.some(candidate => BoundedVscodeIntentQueue.key(candidate) === key)) {
      return { restored: false, reason: 'already-pending' }
    }
    this.#pending.unshift(Object.freeze({ instanceId: intent.instanceId, path: intent.path }))
    return { restored: true }
  }

  complete(intent: VscodeLaunchRequest): void {
    this.#trackedKeys.delete(BoundedVscodeIntentQueue.key(intent))
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  get trackedCount(): number {
    return this.#trackedKeys.size
  }
}

/** A renderer delivery remains owned by the main process until the current
 * renderer explicitly acknowledges the exact send attempt. `deliveryId` is
 * stable across reloads; `attempt` increments on every replay so a late ACK
 * from a dying document cannot commit work sent to its replacement. */
export interface AckDelivery<T> {
  deliveryId: number
  attempt: number
  payload: Readonly<T>
}

interface AckDeliveryRecord<T> {
  deliveryId: number
  attempt: number
  payload: Readonly<T>
  key: string | null
}

/** Bounded FIFO handoff queue with optional normalized single-flight keys.
 * Capacity covers pending plus sent-but-unacknowledged records. A renderer
 * generation change requeues the complete in-flight prefix before work that
 * arrived later, preserving global FIFO. */
export class BoundedAckDeliveryQueue<T extends object> {
  readonly #limit: number
  readonly #keyOf: ((payload: Readonly<T>) => string) | null
  readonly #trackedKeys = new Set<string>()
  #nextDeliveryId = 1
  #pending: AckDeliveryRecord<T>[] = []
  #inFlight: AckDeliveryRecord<T>[] = []

  constructor(limit = 64, keyOf: ((payload: Readonly<T>) => string) | null = null) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('delivery queue limit must be a positive integer')
    this.#limit = limit
    this.#keyOf = keyOf
  }

  enqueue(payload: T):
    | { accepted: true; deliveryId: number; dropped: Readonly<T> | null }
    | { accepted: false; dropped: null; reason: 'duplicate' | 'saturated' } {
    const frozen = Object.freeze({ ...payload }) as Readonly<T>
    const key = this.#keyOf?.(frozen) ?? null
    if (key !== null && this.#trackedKeys.has(key)) {
      return { accepted: false, dropped: null, reason: 'duplicate' }
    }

    let dropped: Readonly<T> | null = null
    if (this.trackedCount >= this.#limit) {
      const evicted = this.#pending.shift() ?? null
      if (evicted === null) return { accepted: false, dropped: null, reason: 'saturated' }
      dropped = evicted.payload
      if (evicted.key !== null) this.#trackedKeys.delete(evicted.key)
    }

    const deliveryId = this.#nextDeliveryId
    this.#nextDeliveryId += 1
    const record: AckDeliveryRecord<T> = { deliveryId, attempt: 0, payload: frozen, key }
    this.#pending.push(record)
    if (key !== null) this.#trackedKeys.add(key)
    return { accepted: true, deliveryId, dropped }
  }

  /** Move the FIFO head to in-flight ownership and mint a fresh attempt. */
  shift(): AckDelivery<T> | null {
    const record = this.#pending.shift() ?? null
    if (record === null) return null
    record.attempt += 1
    this.#inFlight.push(record)
    return { deliveryId: record.deliveryId, attempt: record.attempt, payload: record.payload }
  }

  /** A synchronous send failure was not handed off. Restore only that record
   * ahead of the still-pending suffix; earlier successful sends stay in-flight
   * awaiting their own ACKs. */
  rollback(delivery: Pick<AckDelivery<T>, 'deliveryId' | 'attempt'>): boolean {
    const index = this.#inFlight.findIndex(record =>
      record.deliveryId === delivery.deliveryId && record.attempt === delivery.attempt)
    if (index === -1) return false
    const [record] = this.#inFlight.splice(index, 1)
    this.#pending.unshift(record)
    return true
  }

  /** Commit only the exact current attempt. A stale ACK is a harmless false. */
  acknowledge(deliveryId: number, attempt: number): boolean {
    if (!Number.isSafeInteger(deliveryId) || deliveryId < 1 || !Number.isSafeInteger(attempt) || attempt < 1) return false
    const index = this.#inFlight.findIndex(record =>
      record.deliveryId === deliveryId && record.attempt === attempt)
    if (index === -1) return false
    const [record] = this.#inFlight.splice(index, 1)
    if (record.key !== null) this.#trackedKeys.delete(record.key)
    return true
  }

  /** Renderer reload/crash: replay every unacknowledged send before newer
   * pending work. Their stable ids remain tracked; the next shift increments
   * attempt, invalidating any ACK still arriving from the old document. */
  requeueInFlight(): number {
    if (this.#inFlight.length === 0) return 0
    const count = this.#inFlight.length
    this.#pending = [...this.#inFlight, ...this.#pending]
    this.#inFlight = []
    return count
  }

  /** Retire matching work from both pending and already-sent ownership. Used
   * when an authoritative registry lifecycle edge invalidates a source; a
   * same-id replacement must not inherit held work from the old incarnation. */
  discardWhere(predicate: (payload: Readonly<T>) => boolean): number {
    let discarded = 0
    const keep = (record: AckDeliveryRecord<T>) => {
      if (!predicate(record.payload)) return true
      discarded += 1
      if (record.key !== null) this.#trackedKeys.delete(record.key)
      return false
    }
    this.#pending = this.#pending.filter(keep)
    this.#inFlight = this.#inFlight.filter(keep)
    return discarded
  }

  get pendingCount(): number {
    return this.#pending.length
  }

  get inFlightCount(): number {
    return this.#inFlight.length
  }

  get trackedCount(): number {
    return this.#pending.length + this.#inFlight.length
  }
}

/** Runtime protocol registration is packaged-only in this app. A packaged
 * Linux launch must not persist argv[1]: on a cold protocol start argv[1] can
 * itself be the URL. Electron's executable+script args form is only for the
 * `process.defaultApp` development shape, which this app deliberately skips. */
export function decideDeepLinkProtocolRegistration(input: {
  isPackaged: boolean
  platform: string
}): { action: 'skip' } | { action: 'register' } {
  if (!input.isPackaged || input.platform === 'win32') return { action: 'skip' }
  return { action: 'register' }
}

/** Every restore entry point shares the same terminal quit fence. */
export function canRestoreMainWindow(quitRequested: boolean): boolean {
  return !quitRequested
}

/** Wrap Electron's boolean protocol-registration API in the same loud,
 * exception-safe result discipline as the launch pipeline. */
export function attemptDeepLinkProtocolRegistration(register: () => boolean):
  { ok: true } | { ok: false; error: string } {
  try {
    return register()
      ? { ok: true }
      : { ok: false, error: 'setAsDefaultProtocolClient returned false' }
  } catch (error) {
    return { ok: false, error: `setAsDefaultProtocolClient failed: ${describeUnknownError(error)}` }
  }
}

/** Pure readiness decision shared by the renderer hold/replay drain and its
 * race tests. A ready handshake may legally arrive before did-finish-load;
 * that state must hold (not drop) the intent until loading becomes false. */
export function canDeliverRendererDeepLink(state: {
  ready: boolean
  currentWindow: boolean
  destroyed: boolean
  loading: boolean
  crashed: boolean
}): boolean {
  return state.ready
    && state.currentWindow
    && !state.destroyed
    && !state.loading
    && !state.crashed
}

/**
 * Remote path validation shared by both entry points (the parsed deep link
 * and the renderer-button IPC — the renderer path is equally untrusted,
 * design 16 §8). Must be absolute (leading `/`), ≤ 4096 chars, and free of
 * control characters / CR / LF / NUL.
 */
export function validateRemotePath(path: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'path is required' }
  }
  if (!path.startsWith('/')) {
    return { ok: false, error: 'path must be an absolute path (leading /)' }
  }
  if (path.length > MAX_REMOTE_PATH_CHARS) {
    return { ok: false, error: `path exceeds ${MAX_REMOTE_PATH_CHARS} characters` }
  }
  // C0 control characters (incl. CR/LF/NUL) + DEL are never valid in a
  // remote path and are a classic URI-smuggling / argv-injection vector.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return { ok: false, error: 'path contains control characters' }
  }
  return { ok: true, path }
}

/** Local workspace path validation. Chamber ships on Windows as well as
 * POSIX platforms, so local paths accept POSIX absolute, drive-absolute and
 * UNC forms. Remote dsh paths continue to use validateRemotePath and remain
 * POSIX-only. */
export function validateLocalPath(localPath: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof localPath !== 'string' || localPath.length === 0) {
    return { ok: false, error: 'path is required' }
  }
  if (localPath.length > MAX_REMOTE_PATH_CHARS) {
    return { ok: false, error: `path exceeds ${MAX_REMOTE_PATH_CHARS} characters` }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(localPath)) {
    return { ok: false, error: 'path contains control characters' }
  }
  const absolute = localPath.startsWith('/')
    || /^[a-zA-Z]:[\\/]/.test(localPath)
    || /^\\\\[^\\]+\\[^\\]+/.test(localPath)
  if (!absolute) return { ok: false, error: 'path must be an absolute path' }
  return { ok: true, path: localPath }
}

/**
 * Minimal IPv6 literal check (no node:net import — the module stays within
 * its sanctioned node built-ins). Accepts the standard 8-group,
 * `::`-compressed and embedded-IPv4 forms an SSH host field can carry. Zone
 * ids (`%eth0`) are rejected — never a valid SSH target literal. This is a
 * security guard against `host:port` ambiguity (design 16 §3.2), not a full
 * RFC 4291 parser.
 */
function isIpv6Literal(host: string): boolean {
  if (host.length === 0 || host.length > 45 || host.includes('%')) return false
  // Split off an optional embedded-IPv4 tail (after the LAST colon).
  const lastColon = host.lastIndexOf(':')
  let head = host
  let hasIpv4Tail = false
  if (lastColon !== -1 && host.slice(lastColon + 1).includes('.')) {
    const tail = host.slice(lastColon + 1)
    const octets = tail.split('.')
    if (octets.length !== 4) return false
    if (!octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false
    head = host.slice(0, lastColon)
    hasIpv4Tail = true
  }
  if (!/^[0-9A-Fa-f:]*$/.test(head)) return false
  const parts = head.split('::')
  if (parts.length > 2) return false
  const left = parts[0] === '' ? [] : parts[0].split(':')
  const right = parts.length === 2 ? (parts[1] === '' ? [] : parts[1].split(':')) : null
  const hexGroup = /^[0-9A-Fa-f]{1,4}$/
  if (!left.every(group => hexGroup.test(group))) return false
  if (right !== null && !right.every(group => hexGroup.test(group))) return false
  // An embedded IPv4 tail consumes two 16-bit groups (32 bits).
  const maxHexGroups = hasIpv4Tail ? 6 : 8
  if (right === null) return left.length === maxHexGroups
  return left.length + right.length < maxHexGroups
}

/**
 * Encode a remote absolute path segment-by-segment (design 16 §3.3): the
 * leading `/` is preserved, each subsequent segment is `encodeURIComponent`-
 * encoded (space / CJK / `#` / `?` / `&` / `%` all covered). The `/`
 * separators stay literal so VS Code still sees the directory structure.
 */
function encodeRemotePath(remotePath: string): string {
  return '/' + remotePath.slice(1).split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/**
 * Parse the OS-level deep link into a normalized launch request
 * (design 16 §3.1). `new URL()` parsing; scheme must be `dsh-chamber:` and
 * hostname must be exactly `open-vscode` (anything else is refused, never
 * guessed or normalized). `instance` passes INSTANCE_ID_PATTERN; `path` is
 * absolute / control-char-free / ≤ 4096. Every failure is loud.
 */
export function parseOpenVscodeIntent(raw: string): { ok: true; intent: VscodeLaunchRequest } | { ok: false; error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: 'invalid deep-link URL' }
  }
  if (url.protocol !== 'dsh-chamber:') {
    return { ok: false, error: `unsupported deep-link scheme: ${url.protocol}` }
  }
  if (url.hostname !== 'open-vscode') {
    return { ok: false, error: `unsupported deep-link host: ${url.hostname}` }
  }
  // Strictness (security-review P2-2): userinfo and port are meaningless in
  // our scheme — reject them like isAllowedReleaseUrl rejects credentialed
  // URLs instead of silently discarding the fields.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, error: 'deep-link must not carry userinfo' }
  }
  if (url.port !== '') {
    return { ok: false, error: 'deep-link must not carry a port' }
  }
  const instance = url.searchParams.get('instance')
  if (instance === null) {
    return { ok: false, error: 'missing instance' }
  }
  // 'local' is the reserved local-instance id (excluded from INSTANCE_ID_PATTERN
  // because the ssh registry never holds it) — the deep link may target the
  // local instance too (opens vscode://file/, user decision 2026-08).
  if (instance !== 'local' && !INSTANCE_ID_PATTERN.test(instance)) {
    return { ok: false, error: 'invalid instance id' }
  }
  const pathParam = url.searchParams.get('path')
  if (pathParam === null) {
    return { ok: false, error: 'missing path' }
  }
  const validatedPath = instance === 'local'
    ? validateLocalPath(pathParam)
    : validateRemotePath(pathParam)
  if (!validatedPath.ok) return validatedPath
  return { ok: true, intent: { instanceId: instance, path: validatedPath.path } }
}

/**
 * Construct the `vscode://vscode-remote/ssh-remote+` target from registry
 * metadata (design 16 §3.2/§3.3), decoupled from SSH_HOST_PATTERN.
 *
 * - authority = `[<user>@]<host>`; a null user is omitted (registry metadata
 *   is non-secret).
 * - a host with a colon must be a valid IPv6 literal and is (re-)bracketed;
 *   `host:port` ambiguity is rejected deterministically.
 * - `sshPort` other than null/22 is rejected with the ~/.ssh/config guidance
 *   (VS Code resolves `ssh-remote+` targets via ~/.ssh/config aliases — a URL
 *   cannot reliably carry a non-default port).
 * - the scheme is hardcoded `vscode:` — the raw deep-link URL is never
 *   passed through to shell.openExternal.
 * - host/user are still encodeURIComponent-encoded defensively; the path is
 *   encoded segment-wise.
 */
export function buildVscodeRemoteUrl(
  host: string,
  user: string | null,
  sshPort: number | null,
  remotePath: string,
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof host !== 'string' || host.length === 0) {
    return { ok: false, error: 'host is required' }
  }
  if (sshPort !== null && sshPort !== 22) {
    return { ok: false, error: `sshPort ${sshPort} 不受支持（Remote-SSH 无法可靠携带端口）——请在 ~/.ssh/config 配置该主机别名后重试` }
  }
  const validatedPath = validateRemotePath(remotePath)
  if (!validatedPath.ok) return validatedPath

  let authorityHost: string
  if (host.includes(':')) {
    const bracketed = host.startsWith('[')
    const inner = bracketed
      ? (host.endsWith(']') ? host.slice(1, -1) : null)
      : host
    if (bracketed && inner === null) {
      return { ok: false, error: 'unterminated bracketed IPv6 host' }
    }
    if (!isIpv6Literal(inner as string)) {
      return { ok: false, error: 'host 含冒号但不是合法 IPv6 字面量（疑似 host:port 误填）' }
    }
    authorityHost = `[${inner}]`
  } else {
    authorityHost = encodeURIComponent(host)
  }

  const userPart = user === null || user === '' ? '' : `${encodeURIComponent(user)}@`
  return { ok: true, url: `vscode://vscode-remote/ssh-remote+${userPart}${authorityHost}${encodeRemotePath(validatedPath.path)}` }
}

/**
 * Build the `vscode://file/<path>` target for the LOCAL instance (user decision
 * 2026-08: the button/deep link also work for the local source — its workspace
 * paths live on this machine, so VS Code opens them as local folders). Same
 * path discipline as the remote URL: absolute, control-char-free, ≤ 4096,
 * segment-wise encoded; the scheme is hardcoded `vscode:`.
 */
export function buildVscodeFileUrl(remotePath: string): { ok: true; url: string } | { ok: false; error: string } {
  const validatedPath = validateLocalPath(remotePath)
  if (!validatedPath.ok) return validatedPath
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(validatedPath.path) || validatedPath.path.startsWith('\\\\')
  const normalized = windowsStyle ? validatedPath.path.replace(/\\/g, '/') : validatedPath.path
  const absolute = normalized.startsWith('/') ? normalized : `/${normalized}`
  // VS Code documents drive targets as vscode://file/c:/...; keep only that
  // drive colon literal while encoding every user-controlled segment.
  const encoded = encodeRemotePath(absolute).replace(/^\/([a-zA-Z])%3A(?=\/|$)/i, '/$1:')
  return { ok: true, url: `vscode://file${encoded}` }
}

/** Default executable-FILE check: access(X_OK) + isFile(). On POSIX a
 *  directory passes X_OK (execute/search bit), so the file check is what
 *  keeps a PATH entry named `code` that is actually a directory from being
 *  misdetected as VS Code (security-review P1-2). */
function defaultAccessX(target: string): boolean {
  try {
    accessSync(target, fsConstants.X_OK)
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** Default regular-file check (Windows Code.exe branch; a same-named
 *  directory must not count as installed). */
function defaultIsFile(target: string): boolean {
  try {
    return statSync(target).isFile()
  } catch {
    return false
  }
}

/** Scan a PATH-style string for an executable `name` (design 16 §5). Missing /
 *  empty PATH → false; empty entries are skipped. */
function hasExecutableInPath(
  name: string,
  pathEnv: string | undefined,
  delimiter: string,
  accessX: (target: string) => boolean,
): boolean {
  if (typeof pathEnv !== 'string' || pathEnv === '') return false
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue
    if (accessX(path.join(dir, name))) return true
  }
  return false
}

/**
 * VS Code availability probe (design 16 §5) — pure fs + PATH scan, never
 * spawns / never executes anything. Only the STABLE VS Code is recognized
 * (the binary is `code` / `Code.exe` / the `Visual Studio Code.app` bundle;
 * Insiders / Cursor / VSCodium are deliberately not probed).
 *
 * `platform` selects the probe shape (macOS app bundles + `code`; Linux PATH
 * `code` + common install paths; Windows `%LOCALAPPDATA%` Code.exe + PATH
 * `code.cmd`). The optional `deps` lets the pure-Node test suite inject the
 * PATH / LOCALAPPDATA environment and fs stubs (platform + fs injection —
 * design 16 §5.1 testability); production calls it with the platform alone.
 */
export function detectVscodeAvailability(
  platform: string,
  deps: {
    /** PATH-like string; undefined falls back to process.env.PATH. */
    pathEnv?: string
    /** %LOCALAPPDATA% (win32); undefined falls back to process.env.LOCALAPPDATA. */
    localAppData?: string
    /** Home dir for `~/Applications`; defaults to os.homedir(). */
    homeDir?: string
    /** Existence check; defaults to fs.existsSync. */
    exists?: (target: string) => boolean
    /** Executable-FILE check (X_OK + isFile); defaults to access(X_OK)+stat.isFile(). */
    accessX?: (target: string) => boolean
    /** Regular-file check for the Windows Code.exe branch; defaults to stat.isFile(). */
    isFile?: (target: string) => boolean
  } = {},
): { available: boolean } {
  const pathEnv = deps.pathEnv !== undefined ? deps.pathEnv : process.env.PATH
  const exists = deps.exists ?? existsSync
  const accessX = deps.accessX ?? defaultAccessX
  const isFile = deps.isFile ?? defaultIsFile
  const homeDir = deps.homeDir ?? os.homedir()
  const localAppData = deps.localAppData !== undefined ? deps.localAppData : process.env.LOCALAPPDATA

  if (platform === 'darwin') {
    if (exists('/Applications/Visual Studio Code.app')) return { available: true }
    if (exists(path.join(homeDir, 'Applications', 'Visual Studio Code.app'))) return { available: true }
    return { available: hasExecutableInPath('code', pathEnv, ':', accessX) }
  }
  if (platform === 'linux') {
    if (hasExecutableInPath('code', pathEnv, ':', accessX)) return { available: true }
    // Common install paths as a PATH-independent fallback (deb / snap).
    for (const candidate of ['/usr/share/code/bin/code', '/snap/bin/code']) {
      if (accessX(candidate)) return { available: true }
    }
    return { available: false }
  }
  if (platform === 'win32') {
    if (localAppData !== undefined && localAppData !== '' && isFile(path.join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe'))) {
      return { available: true }
    }
    return { available: hasExecutableInPath('code.cmd', pathEnv, ';', accessX) }
  }
  return { available: false }
}

/**
 * The single deep-link execution pipeline (design 16 §3.4) — shared verbatim
 * by the OS deep link and the renderer-button IPC: registry lookup (unknown
 * instance or non-ssh kind → loud error) → authority construction
 * (buildVscodeRemoteUrl) → availability re-check (defense in depth, §5.2) →
 * openVscodeUrl. Every failure is loud; there is no silent success path.
 */
async function runVscodeLaunchUnchecked(req: VscodeLaunchRequest, ctx: VscodeLaunchContext): Promise<{ ok: true } | { ok: false; error: string }> {
  // Symmetric validation for the renderer-button IPC path (security-review
  // P2-3): the OS deep link already pattern-checks instance at parse time;
  // the IPC carries an equally untrusted string and must not skip the gate.
  // 'local' is the reserved local-instance id (not in the ssh registry).
  if (typeof req.instanceId !== 'string' || (req.instanceId !== 'local' && !INSTANCE_ID_PATTERN.test(req.instanceId))) {
    return { ok: false, error: 'invalid instance id' }
  }
  // Local instance branch (user decision 2026-08): the workspace path lives on
  // this machine — open it as a local folder (vscode://file/), no registry
  // lookup, no sshPort/authority. Availability is still re-checked.
  if (req.instanceId === 'local') {
    const built = buildVscodeFileUrl(req.path)
    if (!built.ok) return built
    if (!ctx.vscodeAvailable()) {
      return { ok: false, error: 'vscode not detected' }
    }
    try {
      return await ctx.openVscodeUrl(built.url)
    } catch (error) {
      return { ok: false, error: `open vscode url failed: ${describeUnknownError(error)}` }
    }
  }
  const instance = ctx.lookupInstance(req.instanceId)
  if (instance === null) {
    return { ok: false, error: `instance not found: ${req.instanceId}` }
  }
  if (instance.kind !== 'ssh') {
    return { ok: false, error: `instance ${req.instanceId} is not an ssh instance (kind=${instance.kind})` }
  }
  const built = buildVscodeRemoteUrl(instance.host, instance.user, instance.sshPort, req.path)
  if (!built.ok) {
    return { ok: false, error: built.error }
  }
  if (!ctx.vscodeAvailable()) {
    return { ok: false, error: 'vscode not detected' }
  }
  try {
    return await ctx.openVscodeUrl(built.url)
  } catch (error) {
    return { ok: false, error: `open vscode url failed: ${describeUnknownError(error)}` }
  }
}

/** Public exception boundary for every host adapter and URI-construction step.
 * The OS deep-link path calls this function directly (without open-in's outer
 * provider boundary), so it must never reject on its own. */
export async function runVscodeLaunch(req: VscodeLaunchRequest, ctx: VscodeLaunchContext): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await runVscodeLaunchUnchecked(req, ctx)
  } catch (error) {
    return { ok: false, error: `vscode launch failed: ${describeUnknownError(error)}` }
  }
}
