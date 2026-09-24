/**
 * The `ssh` transport provider: everything source-specific about SSH tunnels and remote systemd exec,
 * packaged as a TransportProvider. It serves BOTH target kinds (`dsh`/`gateway`) over the `ssh` transport;
 * the kind decides verifyUp semantics only — `dsh` never carries auth headers, `gateway` may (a missing token
 * is NO pre-flight refusal; its own 401 is terminal); transport 'http' is refused here (see gateway-provider.ts).
 *
 * Tunnels: `ssh -N [-p <port>] -L <localPort>:127.0.0.1:<remotePort> <user@host>` with ServerAlive
 * keepalive; systemctl exec is an argument-array spawn (no shell, whitelisted serviceName, `--`
 * separator). verifyUp: `dsh` answers the host-identity handshake (404 → legacy re-probe), `gateway`
 * its /chamber/runtime/status. Password auth rides an ephemeral 0700 askpass helper (refused on win32);
 * no credential on the command line, stderr is redacted first.
 */

import type { SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants as fsConstants, fchmodSync, fsyncSync, lstatSync, mkdtempSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// The dsh RPC wire envelope is single-sourced in control-plane
// (rpc-envelope.ts, cross-package protocol single-sourcing) — consumed
// through control-plane-module.ts (the desktop dual-path facade: packaged →
// compiled dist/control-plane, dev → workspace source). The envelope shape
// AND the unified host-identity probe contract (method names, payloads,
// 64 KiB cap) can never drift from the control-plane unary client's.
import {
  atomicWritePrivateFileNoFollow,
  buildClientRequest,
  buildHostIdentityProbePayload,
  buildLegacyHostProbePayload,
  ensurePrivateDirectoryNoFollow,
  HOST_IDENTITY_METHOD,
  HOST_PROBE_MAX_RESPONSE_BYTES,
  isLegacyHostProbeValue,
  LEGACY_HOST_PROBE_METHOD,
  mintRpcId,
  parseServerResponse,
  postClientRequest,
} from './control-plane-module.ts'
// The plugin spec/name whitelist family (control-plane plugin-spec.ts, design
// 21 §6.2/§6.7 — the single source shared with the gateway; re-exported below
// for this provider's consumers).
import {
  MATERIALIZE_FILE_SPEC_PATTERN,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
} from './control-plane-module.ts'
import { CHILD_LINE_MAX_CHARS, createBoundedLineProcessor } from './bounded-lines.ts'
import { getGatewayPassword, getGatewaySessionHooks, getGatewayToken, verifyGatewayPasswordSession, verifyGatewayRuntimeIdentity } from './gateway-provider.ts'
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_LABEL_CHARS, signalChild } from './transport-provider.ts'
import { isCredentialBinding, sshCredentialBinding, sshCredentialBindingForEndpoint } from './credential-binding.ts'
import { isPlainRecord, preserveInvalidCredentialFile, preserveUnboundCredentialFile, removeLegacyTmpResidue } from './store-file-hygiene.ts'
import type { UnboundCredentialFileWording } from './store-file-hygiene.ts'
import type {
  SpawnedProcess,
  TransportExecAction,
  TransportExecDeps,
  TransportExecResult,
  TransportInstanceSpec,
  TransportProbeEndpoint,
  TransportProvider,
  TransportRunPayload,
  TransportSpawnLease,
  TransportVerifyResult,
} from './transport-provider.ts'
import { buildGatewaySessionOrigin, gatewaySessionScopeForConnection } from './gateway-session.ts'
import type { GatewaySessionOrigin } from './gateway-session.ts'
import { gatewayTunnelAuthority } from './gateway-session-refresh.ts'
import { readOwnerOnlySecretFile } from './owner-only-secret-file.ts'

/**
 * Registry metadata whitelists: id lands in /api/i/dsh-<id> / gateway-<id> path segments and
 * transport keys; host/user are placed on the ssh command line as the connection target — a
 * leading '-' would be parsed as an ssh option by getopt (e.g. -oProxyCommand=… → arbitrary
 * command execution), so the character classes never allow it (host allows dots/hyphens and
 * bracketed IPv6; user dots/underscores/hyphens). id additionally reserves 'local'.
 */
export const SSH_HOST_PATTERN = /^[a-zA-Z0-9.:\[][a-zA-Z0-9._:\[\]-]*$/
export const SSH_USER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** systemd unit-name whitelist: only plain unit-name characters reach the systemctl command line
 *  (no shell, no injection); a leading '-' is refused because systemctl would parse '--help' as an option. */
export const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/** Remote dsh home whitelist: `~/.dsh` or an absolute path, `~` only at word start, no spaces/
 *  metachars — shell-safe on the ssh command line and in a `DSH_HOME=<path>` prefix. `.`/`..`
 *  segments are refused so a crafted home cannot escape the intended subtree. */
export const REMOTE_DSH_HOME_PATTERN = /^~?(?:\/(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._-]+)+$/
export const MAX_SSH_HOST_CHARS = 253
export const MAX_SSH_USER_CHARS = 64
export const MAX_SERVICE_NAME_CHARS = 255
export const MAX_REMOTE_DSH_HOME_CHARS = 1024
export const MAX_SSH_PASSWORD_CHARS = 4096
/** Package-spec whitelist family, SINGLE-SOURCED in control-plane `plugin-spec.ts` (shared with the
 *  gateway) and consumed through control-plane-module.ts (packaged → compiled dist, dev → workspace
 *  source), the same rule as the rpc-envelope primitives; re-exported here so this provider's
 *  consumers keep one unchanged import surface. The reserved-name judgement lives in
 *  `protected-plugins.ts`. */
export {
  MATERIALIZE_FILE_SPEC_PATTERN,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
}

/** Bound of the redacted stderr detail attached to failed `run` errors. */
const RUN_STDERR_DETAIL_MAX_CHARS = 2048

/** stderr lines that mean the transport cannot come up without user action (credential/host-key
 *  problems). Terminal: never auto-retried. */
export const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /permission denied/i,
  /authentication failed/i,
  /no supported authentication methods/i,
  /too many authentication failures/i,
  /host key verification failed/i,
  /password:/i,
]

/**
 * A remote `cat` failure that means "the file does not exist" (vs an ssh failure), classified on
 * the RAW stderr line (never the redacted view): redactSshStderr replaces a whole line carrying a
 * `.ssh*`-named home path, and the absent-file signal must survive that. The coreutils message is
 * LOCALIZED, so every remote `cat` runs under `LC_ALL=C` (always English); the glibc zh_CN ENOENT
 * text stays as defense-in-depth for a remote that ignores the prefix. Shared with plugin-sync.ts.
 */
export const ENOENT_PATTERN = /(no such file or directory|没有那个文件|ENOENT|cat: .*no such file)/i

/** Redact private material from ssh stderr before it enters the ring buffer: ssh emits prompt lines
 *  (`Enter passphrase for key '…'`) and key-path diagnostics that would leak key locations into
 *  renderer-visible logs; matching lines become a fixed summary. Auth/ENOENT classification runs on
 *  the original text in classifyStderr, so redaction never loses those signals. */
export function redactSshStderr(text: string): string {
  // `host key:` only counts when a path follows (algorithm/fingerprint lines
  // like `host key: ssh-ed25519 SHA256:...` carry no location and stay).
  if (/passphrase|private key|identity|offering (public )?key|load key|host key: [^ ]*[\\/]|\.ssh(\d+)?\b|\.pem\b|\.key\b/i.test(text)) {
    return '[ssh material redacted]'
  }
  return text
}

/** SSH-level keepalive: ssh sends a channel probe when idle and exits after interval * countMax
 *  unanswered probes (~90s), so dead-tunnel detection happens inside ssh and its exit feeds the
 *  runtime's reconnect; the probes also keep NAT/firewall mappings alive (TCP keepalives cannot). */
export const SERVER_ALIVE_INTERVAL_SECONDS = 30
export const SERVER_ALIVE_COUNT_MAX = 3

/** Timeout of the one-shot dsh identity probe (verifyUp). */
export const VERIFY_UP_TIMEOUT_MS = 5_000

/** Default body cap of the verifyUp NON-identity arms — the legacy session/list re-answer (its answer
 *  grows with session data) and the gateway /chamber/runtime/status body: bounded memory on a
 *  misbehaving endpoint. The primary dsh identity probe uses HOST_PROBE_MAX_RESPONSE_BYTES (64 KiB). */
export const VERIFY_UP_MAX_BODY_BYTES = 1024 * 1024

/** Timeout of the secondary dsh-signature probe (identity + legacy re-answer cycle on a 404). */
export const VERIFY_UP_SIGNATURE_TIMEOUT_MS = 2_000

/**
 * Secondary dsh-signature probe: re-answer the unified host-identity handshake and classify by the
 * answer. A positive signature requires a matching server-response envelope with result.ok === true
 * AND a boolean value (false is equally positive — only method presence/protocol/controller assembly
 * are under test). A 404 means the runtime tree predates the identity method: re-answer the legacy
 * session/list probe (1 MiB cap) so an old-version dsh keeps a positive signature. Anything else is
 * no signature; a destination that failed the primary probe but answers here IS a dsh instance that
 * answered inconsistently, so the caller can say "check or upgrade" instead of "not dsh".
 */
export function probeDshSignature(
  endpoint: { host: string; port: number },
  timeoutMs = VERIFY_UP_SIGNATURE_TIMEOUT_MS,
): Promise<'dsh' | 'none'> {
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const identityUrl = `http://${endpoint.host}:${endpoint.port}/api/${HOST_IDENTITY_METHOD}`
  const identityRpcId = mintRpcId()
  return postClientRequest({
    url: identityUrl,
    // The identity unary is a zero-arg Remote: the empty `{args}` payload, the same probe the
    // control-plane readiness uses.
    envelope: buildClientRequest(identityRpcId, HOST_IDENTITY_METHOD, buildHostIdentityProbePayload()),
    timeoutMs: remaining(),
    maxBodyBytes: HOST_PROBE_MAX_RESPONSE_BYTES,
  }).then(async outcome => {
    if (outcome.timeout || outcome.status === null) return 'none'
    if (outcome.status === 200) {
      if (outcome.oversized) return 'none'
      const parsed = parseServerResponse(outcome.body, identityRpcId)
      if (parsed.kind === 'ok' && parsed.envelope.result.ok === true
        && typeof parsed.envelope.result.value === 'boolean') {
        return 'dsh'
      }
      // Any other 200 answer is a deterministic non-signature — never retry the legacy arm against
      // a host that ANSWERED the identity method.
      return 'none'
    }
    // 404 = a runtime tree predating the identity method: re-answer the legacy session/list probe.
    if (outcome.status !== 404) return 'none'
    const legacyUrl = `http://${endpoint.host}:${endpoint.port}/api/${LEGACY_HOST_PROBE_METHOD}`
    const legacyRpcId = mintRpcId()
    const legacyOutcome = await postClientRequest({
      url: legacyUrl,
      envelope: buildClientRequest(legacyRpcId, LEGACY_HOST_PROBE_METHOD, buildLegacyHostProbePayload()),
      timeoutMs: remaining(),
      maxBodyBytes: VERIFY_UP_MAX_BODY_BYTES,
    })
    if (legacyOutcome.timeout || legacyOutcome.status === null
      || legacyOutcome.status !== 200 || legacyOutcome.oversized) return 'none'
    const legacyParsed = parseServerResponse(legacyOutcome.body, legacyRpcId)
    // A positive legacy signature must prove the legacy session/list shape (control-plane canonical
    // predicate), so a malformed old host is never taken for dsh.
    return legacyParsed.kind === 'ok' && legacyParsed.envelope.result.ok === true
      && isLegacyHostProbeValue(legacyParsed.envelope.result.value) ? 'dsh' : 'none'
  })
}

/**
 * One-shot dsh identity probe (POST /api/session/canOpenWorkspacePath, standard envelope):
 * - requires a valid echo with result.ok === true and a boolean value (true and false are both
 *   healthy); the fixed-size identity Remote (cap HOST_PROBE_MAX_RESPONSE_BYTES) is the same
 *   handshake the local readiness probe uses — a port that merely accepts TCP is rejected;
 * - classification is honest: an HTTP-level failure re-answers via probeDshSignature (on 404 the
 *   legacy session/list handshake) to separate "IS dsh but answered inconsistently" from
 *   "not a dsh instance"; anything that ANSWERED is terminal, only connection-level failures
 *   (no answer, timeout) stay transient for the bounded reconnect path.
 */
export async function verifyDshEndpoint(
  endpoint: { host: string; port: number },
  timeoutMs = VERIFY_UP_TIMEOUT_MS,
  maxBodyBytes = HOST_PROBE_MAX_RESPONSE_BYTES,
): Promise<TransportVerifyResult> {
  // Bracketed IPv6 literals already carry their brackets in the URL.
  const url = `http://${endpoint.host}:${endpoint.port}/api/${HOST_IDENTITY_METHOD}`
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const rpcId = mintRpcId()
  const outcome = await postClientRequest({
    url,
    envelope: buildClientRequest(rpcId, HOST_IDENTITY_METHOD, buildHostIdentityProbePayload()),
    timeoutMs,
    maxBodyBytes,
  })
  if (outcome.timeout) {
    return { ok: false, detail: `the destination did not answer the dsh identity probe within ${timeoutMs}ms` }
  }
  if (outcome.status === null) {
    return { ok: false, detail: 'the destination did not answer the dsh identity probe' }
  }
  // Non-200 (404 from a non-dsh web server or an old dsh without the identity method, 403, 5xx, …):
  // classify with the dsh-signature probe before choosing the message.
  if (outcome.status !== 200) {
    // Browser-auth gate: the web-profile host answers 401 without the signed cookie, and the launch
    // token is process-memory random printed only on the REMOTE console — unrecoverable over the
    // tunnel. Fail loud with the honest reason instead of "not a dsh"; the signature probe is gated
    // the same way, so the message hedges the non-dsh 401 case.
    if (outcome.status === 401) {
      return { ok: false, detail: 'the destination answered HTTP 401 — a 0.1.2 browser-auth-gated dsh (its launch token is unrecoverable over SSH; remote attach is blocked until upstream exposes a token retrieval mechanism) or a non-dsh server', terminal: true }
    }
    const signature = await probeDshSignature(endpoint, Math.min(VERIFY_UP_SIGNATURE_TIMEOUT_MS, remaining()))
    if (signature !== 'none') {
      return { ok: false, detail: 'the destination is a dsh instance, but it did not answer the dsh identity probe — check or upgrade the remote dsh', terminal: true }
    }
    return { ok: false, detail: `the destination answered HTTP ${outcome.status ?? '?'} to the dsh identity probe — it does not appear to be a dsh instance`, terminal: true }
  }
  if (outcome.oversized) {
    // Only the legacy fallback arm can carry a legitimately large answer; the primary identity arm's
    // fixed-size boolean can never approach its 64 KiB cap — oversized is deterministic non-dsh evidence.
    return { ok: false, detail: 'the destination answered an oversized dsh identity probe response — it does not appear to be a dsh instance', terminal: true }
  }
  const parsed = parseServerResponse(outcome.body, rpcId)
  if (parsed.kind !== 'ok' || parsed.envelope.result.ok !== true
    || typeof parsed.envelope.result.value !== 'boolean') {
    return { ok: false, detail: 'the destination answered an unexpected dsh identity probe response — it does not appear to be a dsh instance', terminal: true }
  }
  return { ok: true }
}

/**
 * One-shot GATEWAY identity probe over an SSH TUNNEL endpoint (GET /chamber/runtime/status, ALWAYS
 * plain http — the tunnel carries its own encryption) with the stored bearer token and/or password
 * Cookie (same session-hook flow as the direct provider).
 * - 401 → TERMINAL, message split by what was sent (cookie = password refused; nothing = configure
 *   token or password; token = check token); 403 → terminal (origin/Host policy); other non-200 →
 *   gatewayHttpFailureIsTerminal (5xx transient); 200 + identity marker → ready even while dsh is down;
 * - a missing token is NEVER a pre-flight refusal: the probe goes out without Authorization and the
 *   gateway's own answer is classified; the result carries `statusCode` for the raw-401 caller.
 */
export function verifyGatewayEndpointViaTunnel(
  endpoint: TransportProbeEndpoint,
  token: string | null,
  timeoutMs = VERIFY_UP_TIMEOUT_MS,
  maxBodyBytes = VERIFY_UP_MAX_BODY_BYTES,
  cookie: string | null = null,
  authority: string | undefined = undefined,
): Promise<TransportVerifyResult & { statusCode?: number }> {
  // The shared gateway runtime-identity probe core (gateway-provider.ts):
  // http + the tunnel Host-header override, with
  // the legacy ssh shape that carries `statusCode` on 403/non-200 answers.
  return verifyGatewayRuntimeIdentity({
    host: endpoint.host,
    port: endpoint.port,
    token,
    insecure: true,
    timeoutMs,
    maxBodyBytes,
    cookie,
    authority,
    carryStatusCodes: true,
  })
}

/** The password-session origin for an SSH tunnel endpoint: login and cookie are keyed to the LOOPBACK
 *  tunnel origin (`http://127.0.0.1:<localPort>`), the only origin the tunnel ever reaches.
 *  `insecureHttp: true` is the session manager's scheme selector for plain http, NOT an "insecure"
 *  judgement — the tunnel's ssh encryption protects the loopback hop. The exact connection/SSH-target
 *  scope prevents recycled local ports and shared remote authorities from crossing cookies between
 *  ids or hosts; a reconnect allocates a new port → fresh origin/login. */
function tunnelSessionOrigin(
  spec: TransportInstanceSpec,
  endpoint: TransportProbeEndpoint,
  authority: string | undefined,
): GatewaySessionOrigin {
  return buildGatewaySessionOrigin({
    baseUrl: `http://${endpoint.host}:${endpoint.port}`,
    insecureHttp: true,
    scope: gatewaySessionScopeForConnection(spec),
    authority,
  })
}

/** verifyUp for a password-configured gateway-over-ssh target: the shared verifyGatewayPasswordSession
 *  flow (same 401 → invalidate → single re-login → terminal contract as the direct-endpoint provider)
 *  probing the loopback endpoint WITH the session Cookie. `authority` is the remote gateway host:port
 *  presented in the Host header (the gateway's request policy requires the authority port to equal its
 *  listen port).
 *
 *  The bearer token is NEVER frozen at entry — getGatewayToken is read immediately before EACH network
 *  exchange; a bearer fallback after the token was cleared returns non-ok instead of sending a
 *  credential-free probe whose 200 (--no-auth) would be misreported as bearer success. */
async function verifyGatewayWithPasswordViaTunnel(
  spec: TransportInstanceSpec,
  endpoint: TransportProbeEndpoint,
  password: string,
  authority: string | undefined,
): Promise<TransportVerifyResult> {
  return verifyGatewayPasswordSession(tunnelSessionOrigin(spec, endpoint, authority), password, cookie =>
    verifyGatewayEndpointViaTunnel(endpoint, getGatewayToken(spec.id), VERIFY_UP_TIMEOUT_MS, VERIFY_UP_MAX_BODY_BYTES, cookie, authority),
  () => {
    const token = getGatewayToken(spec.id)
    if (token === null) {
      return Promise.resolve({ ok: false, detail: 'no gateway bearer token configured', terminal: false })
    }
    return verifyGatewayEndpointViaTunnel(endpoint, token, VERIFY_UP_TIMEOUT_MS, VERIFY_UP_MAX_BODY_BYTES, null, authority)
  })
}

/**
 * One-shot RPC liveness probe of a chamber host Remote over the tunnel (the wire shape the
 * renderer's module-C boot uses), reached through probeChamberHostLive; file presence alone cannot
 * distinguish "booted after the injection" from "restart still pending". Three honest states:
 *   'live'     — HTTP 200 with result.ok true (a domain rejection rides inside result.ok:true);
 *   'not-live' — HTTP 404 (only claimed Remote namespaces are routed, so the boot row did not load)
 *                or result.ok !== true;
 *   'unknown'  — anything else (non-404/200, malformed envelope, timeout, connection failure,
 *                oversized body).
 */
export type LiveProbeResult = 'live' | 'not-live' | 'unknown'

async function probeRemoteMethod(
  endpoint: { host: string; port: number },
  method: string,
  args: unknown,
  timeoutMs: number,
  maxBodyBytes: number,
): Promise<LiveProbeResult> {
  const url = `http://${endpoint.host}:${endpoint.port}/api/${method}`
  const rpcId = mintRpcId()
  const outcome = await postClientRequest({
    url,
    // The client-request envelope is single-sourced in rpc-envelope.ts — the exact wire shape the
    // renderer's module-C boot uses.
    envelope: buildClientRequest(rpcId, method, { args }),
    timeoutMs,
    maxBodyBytes,
  })
  // No answer (timeout / connection failure / premature close): never a claimed 'live'/'not-live'.
  if (outcome.status === null) return 'unknown'
  if (outcome.status !== 200) {
    // The dsh gateway routes only claimed Remote namespaces: on a ready instance 404 is deterministic
    // "not loaded yet", never an unclassifiable answer.
    return outcome.status === 404 ? 'not-live' : 'unknown'
  }
  // Oversized body: not an RPC envelope — unclassifiable, never a claim.
  if (outcome.oversized) return 'unknown'
  const parsed = parseServerResponse(outcome.body, rpcId)
  if (parsed.kind !== 'ok') return 'unknown'
  // Any well-formed envelope is a deterministic answer: ok:true → resolved; else → not loaded yet.
  return parsed.envelope.result.ok === true ? 'live' : 'not-live'
}

/** Live-effect probe of ONE chamber host package: method/args come from the control-plane registry's
 *  probe descriptor (`CHAMBER_HOST_PACKAGES`), so every seeded package uses the same generic path.
 *  A 404 from the dsh gateway deterministically means "that boot row is not loaded yet". */
export function probeChamberHostLive(
  endpoint: { host: string; port: number },
  method: string,
  args: unknown,
  timeoutMs = CHAMBER_HOST_PROBE_TIMEOUT_MS,
  maxBodyBytes = CHAMBER_HOST_PROBE_MAX_BODY_BYTES,
): Promise<LiveProbeResult> {
  return probeRemoteMethod(endpoint, method, args, timeoutMs, maxBodyBytes)
}

/** Timeout of the generic chamber host-package liveness probe. */
export const CHAMBER_HOST_PROBE_TIMEOUT_MS = 5_000

/** Response-body cap of the liveness probe (an oversized answer is not an RPC envelope). */
export const CHAMBER_HOST_PROBE_MAX_BODY_BYTES = 1024 * 1024

/**
 * Instance spec validation (non-secret metadata only): id must match the runtime whitelist (it rides
 * the /api/i/dsh-<id> / gateway-<id> path segments); host/user must match the identifier whitelists
 * and never start with '-' (a leading '-' would be parsed as an ssh option — option-injection guard
 * enforced in core logic, not only the UI). serviceName is only type-checked here; its format
 * whitelist is enforced at exec time, where the value actually reaches a command line.
 *
 * v2: the ssh provider serves both target kinds over `ssh` only — transport 'http' is refused, and
 * insecureHttp is meaningless for a loopback tunnel (normalized to false).
 */
function isValidInstance(instance: unknown): instance is TransportInstanceSpec {
  if (instance === null || typeof instance !== 'object') return false
  const record = instance as Record<string, unknown>
  return typeof record.id === 'string' && INSTANCE_ID_PATTERN.test(record.id)
    && typeof record.label === 'string' && record.label.length >= 1 && record.label.length <= MAX_INSTANCE_LABEL_CHARS
    && typeof record.host === 'string' && record.host.length <= MAX_SSH_HOST_CHARS && SSH_HOST_PATTERN.test(record.host)
    && (record.user === undefined || record.user === null
      || (typeof record.user === 'string' && record.user.length <= MAX_SSH_USER_CHARS && SSH_USER_PATTERN.test(record.user)))
    && typeof record.remotePort === 'number'
    && Number.isInteger(record.remotePort)
    && record.remotePort >= 1 && record.remotePort <= 65535
    && (record.sshPort === undefined || record.sshPort === null
      || (typeof record.sshPort === 'number' && Number.isInteger(record.sshPort)
        && record.sshPort >= 1 && record.sshPort <= 65535))
    && (record.serviceName === undefined || record.serviceName === null
      || (typeof record.serviceName === 'string' && record.serviceName.length <= MAX_SERVICE_NAME_CHARS && SERVICE_NAME_PATTERN.test(record.serviceName)))
    && (record.remoteDshHome === undefined || record.remoteDshHome === null
      || (typeof record.remoteDshHome === 'string' && record.remoteDshHome.length <= MAX_REMOTE_DSH_HOME_CHARS && REMOTE_DSH_HOME_PATTERN.test(record.remoteDshHome)))
    && (record.kind === undefined || record.kind === null || record.kind === 'dsh' || record.kind === 'gateway')
    && (record.transport === undefined || record.transport === null || record.transport === 'ssh')
    && (record.insecureHttp === undefined || record.insecureHttp === null || record.insecureHttp === false)
    // Pins apply only to direct gateway HTTPS; silently dropping one from an SSH spec would claim
    // protection the tunnel provider never uses.
    && (record.spkiPin === undefined || record.spkiPin === null)
}

/** The registry id whitelist (single source: transport-provider.ts) is enforced by the ssh spec
 *  check: plain identifier, never the reserved 'local' source id. */

/**
 * Per-instance SSH passwords (plaintext-file fallback): held in main-process memory AND mirrored to
 * `<userData>/ssh-passwords.json` (0600, atomic write) so auto-connect works after a restart. Never
 * in the registry, logs, or any renderer payload. Each entry carries its exact authentication owner
 * (id/host/user/sshPort), compared to the current authoritative spec at every spawn, so two
 * separately atomic files cannot redirect an old credential after a crash. Dropped on removal/clear;
 * app quit leaves the file in place by design.
 */
const passwords = new Map<string, string>()
const passwordBindings = new Map<string, string>()

/** The plaintext persistence mirror path; null = memory-only. Configured once at startup. */
let passwordFile: string | null = null
let passwordSpecResolver: ((id: string) => TransportInstanceSpec | null) | null = null

/** One helper generation leased by one or more live ssh children. */
interface AskpassGeneration {
  path: string
  leases: number
}

/** id → every helper generation still referenced by an actual ssh child. Each spawn gets a fresh
 *  helper so a password change cannot affect an already-built environment; cleanup is driven solely
 *  by child lifecycle, so no concurrent tunnel/systemd/run work can delete a path another child
 *  still references. */
const askpassHelpers = new Map<string, Set<AskpassGeneration>>()

const UNBOUND_PASSWORD_FILE_WORDING: UnboundCredentialFileWording = {
  subject: 'legacy SSH password file',
  hasVerb: 'has',
  disabledAuxiliary: 'is',
  preservedAuxiliary: 'was',
  bindingsNoun: 'endpoint bindings',
  reentryNoun: 'passwords',
}

function isLegacyOwnedPasswordEntry(id: string, value: unknown): value is {
  password: string
  host: string
  user: string | null
  sshPort: number | null
} {
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id) || !isPlainRecord(value)) return false
  return typeof value.password === 'string'
    && value.password !== ''
    && value.password.length <= MAX_SSH_PASSWORD_CHARS
    && typeof value.host === 'string'
    && value.host.length <= MAX_SSH_HOST_CHARS
    && SSH_HOST_PATTERN.test(value.host)
    && (value.user === null
      || (typeof value.user === 'string' && value.user.length <= MAX_SSH_USER_CHARS && SSH_USER_PATTERN.test(value.user)))
    && (value.sshPort === null
      || (typeof value.sshPort === 'number' && Number.isInteger(value.sshPort)
        && value.sshPort >= 1 && value.sshPort <= 65535))
}

/** Point the password store at its persistence file (main.ts, once at startup) and load entries.
 *  Missing file = empty set; a corrupt file fails LOUDLY (preserved as `<file>.corrupt`, reported
 *  through the return value), never silently empty. Null keeps the store memory-only; the return is
 *  a loud notice string or null. */
export function configureSshPasswordStore(
  file: string | null,
  resolveSpec?: (id: string) => TransportInstanceSpec | null,
): string | null {
  passwordFile = file
  passwordSpecResolver = resolveSpec ?? null
  passwords.clear()
  passwordBindings.clear()
  if (file === null) return null
  // One-time crash-residue sweep of the legacy fixed `${file}.tmp` residue.
  removeLegacyTmpResidue(file)
  let text: string
  try {
    text = readOwnerOnlySecretFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Unreadable for another reason: loud, non-fatal — the app starts and password hosts fail auth.
    return `cannot read ${file}: ${String(error)}`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return preserveInvalidCredentialFile(file, 'password file')
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.passwords)) {
    return preserveInvalidCredentialFile(file, 'password file')
  }
  const entries = Object.entries(parsed.passwords)
  if (parsed.schemaVersion === 1) {
    // A non-empty legacy file cannot be bound safely from the current registry (it may be the
    // new-target half of a pre-registry crash): never guess — preserve for manual recovery.
    if (entries.length > 0) return preserveUnboundCredentialFile(file, UNBOUND_PASSWORD_FILE_WORDING)
    persistSshPasswords(new Map(), new Map())
    return null
  }
  // A schema-v2 shape with endpoint ownership embedded beside each password is already safely bound:
  // convert it in-place to the fingerprint representation instead of disabling credentials or guessing.
  if (parsed.schemaVersion === 2 && parsed.bindings === undefined
    && entries.every(([id, value]) => isLegacyOwnedPasswordEntry(id, value))) {
    const migratedPasswords = new Map<string, string>()
    const migratedBindings = new Map<string, string>()
    for (const [id, value] of entries) {
      const owned = value as { password: string; host: string; user: string | null; sshPort: number | null }
      migratedPasswords.set(id, owned.password)
      migratedBindings.set(id, sshCredentialBindingForEndpoint(owned.host, owned.user, owned.sshPort))
    }
    persistSshPasswords(migratedPasswords, migratedBindings)
    for (const [id, value] of migratedPasswords) passwords.set(id, value)
    for (const [id, binding] of migratedBindings) passwordBindings.set(id, binding)
    return null
  }
  if (parsed.schemaVersion !== 2 || !isPlainRecord(parsed.bindings)) {
    return preserveInvalidCredentialFile(file, 'password file')
  }
  if (entries.some(([id, value]) => id === 'local'
    || !INSTANCE_ID_PATTERN.test(id)
    || typeof value !== 'string'
    || value === ''
    || value.length > MAX_SSH_PASSWORD_CHARS)) {
    return preserveInvalidCredentialFile(file, 'password file')
  }
  const bindingEntries = Object.entries(parsed.bindings)
  if (bindingEntries.length !== entries.length
    || bindingEntries.some(([id, binding]) => !Object.hasOwn(parsed.passwords as Record<string, unknown>, id) || !isCredentialBinding(binding))) {
    return preserveInvalidCredentialFile(file, 'password file')
  }
  for (const [id, value] of entries) passwords.set(id, value as string)
  for (const [id, binding] of bindingEntries) passwordBindings.set(id, binding as string)
  return null
}

/** Set or clear the password for one instance (null/'' = clear); persists the plaintext mirror when
 *  configured. A non-empty durable value must carry the exact current SSH endpoint binding. */
export function setSshPassword(
  idOrSpec: string | TransportInstanceSpec,
  password: string | null,
  spec?: TransportInstanceSpec | null,
): void {
  const id = typeof idOrSpec === 'string' ? idOrSpec : idOrSpec.id
  if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing password for invalid instance id ${JSON.stringify(id)}`)
  }
  if (password !== null && (typeof password !== 'string' || password.length > MAX_SSH_PASSWORD_CHARS)) {
    throw new Error(`refusing SSH password longer than ${MAX_SSH_PASSWORD_CHARS} characters`)
  }
  // Kind-agnostic deletion clears both credential stores; a gateway id with no SSH password needs
  // no unnecessary password-file write.
  if ((password === null || password === '') && !passwords.has(id) && !passwordBindings.has(id)) return
  const next = new Map(passwords)
  const nextBindings = new Map(passwordBindings)
  if (password === null || password === '') {
    next.delete(id)
    nextBindings.delete(id)
  } else {
    const bindingSpec = spec ?? (typeof idOrSpec === 'string' ? passwordSpecResolver?.(id) : idOrSpec) ?? null
    const binding = bindingSpec === null ? null : sshCredentialBinding(bindingSpec)
    if (binding === null && passwordFile !== null) {
      throw new Error('refusing to persist an SSH password without a matching SSH endpoint binding')
    }
    next.set(id, password)
    if (binding === null) nextBindings.delete(id)
    else nextBindings.set(id, binding)
  }
  // Write-through commit: the live auth state changes only after its durable mirror succeeds, so a
  // reported persistence failure cannot leave a secret in memory but absent on disk (or vice versa).
  persistSshPasswords(next, nextBindings)
  passwords.clear()
  for (const [entryId, entryPassword] of next) passwords.set(entryId, entryPassword)
  passwordBindings.clear()
  for (const [entryId, binding] of nextBindings) passwordBindings.set(entryId, binding)
  if (password === null || password === '') {
    // Cleanup begins only after the durable clear commits; a live ssh child still owns its leased
    // path until exit/error, and new spawns cannot acquire a password-backed helper.
    purgeSshAuth(id)
  }
}

/** The stored password for the exact current SSH endpoint, or null. Passing a spec performs the
 *  last-moment binding comparison used before every spawn. */
export function getSshPassword(idOrSpec: string | TransportInstanceSpec): string | null {
  const id = typeof idOrSpec === 'string' ? idOrSpec : idOrSpec.id
  const password = passwords.get(id)
  if (password === undefined) return null
  const binding = passwordBindings.get(id)
  // Memory-only tests use id-keyed behavior; every durable production value has a binding and is
  // invisible until the current registry spec matches it exactly.
  if (binding === undefined) return passwordFile === null ? password : null
  const current = typeof idOrSpec === 'string' ? (passwordSpecResolver?.(id) ?? null) : idOrSpec
  return current !== null && sshCredentialBinding(current) === binding ? password : null
}

/**
 * Mirror the in-memory map to the plaintext file via the control-plane atomic-replace primitive
 * (random O_EXCL tmp, mode 0600 → fsync → rename → parent fsync; refuses to follow or replace a
 * planted symlink / multi-link leaf, fail-closed). The parent directory is ensured 0700 first; the
 * file is only created on the first set/clear.
 */
function persistSshPasswords(next: ReadonlyMap<string, string>, nextBindings: ReadonlyMap<string, string>): void {
  if (passwordFile === null) return
  const payload = `${JSON.stringify({
    schemaVersion: 2,
    passwords: Object.fromEntries(next),
    bindings: Object.fromEntries(nextBindings),
  }, undefined, 2)}\n`
  ensurePrivateDirectoryNoFollow(dirname(passwordFile), 0o700)
  atomicWritePrivateFileNoFollow(passwordFile, payload, { mode: 0o600 })
}

/** Is password auth viable on this platform? Win32-OpenSSH askpass handling is not reliable (the
 *  helper must be a PE executable), so the IPC gate refuses storing a password on Windows — keys /
 *  ssh-agent remain the universal path. */
export function sshPasswordSupported(): boolean {
  return process.platform !== 'win32'
}

/**
 * The ephemeral askpass helper body: a sh script answering ssh's non-TTY prompts — host-key
 * confirmations with `yes`, password/passphrase prompts with the stored password, and EVERYTHING
 * ELSE with NO answer (fail-closed): a prompt that is not provably a credential prompt must never
 * receive the password. ssh passes the prompt as argv[1]; prompts are matched textually.
 */
export function buildAskpassScript(password: string): string {
  const escaped = password.replace(/'/g, `'\\''`)
  return [
    '#!/bin/sh',
    '# dsh-chamber ssh password helper (ephemeral, 0700, deleted after child exit)',
    // Normalize the prompt to lowercase ONCE (tr is POSIX): every pattern matches the NORMALIZED
    // text, so all branches are case-insensitive for any casing variant. A per-word bracket
    // approach would only cover the first character and leak the password for "One-time Password:".
    'case "$(printf "%s" "$1" | tr "A-Z" "a-z")" in',
    '  *"yes/no"*|*"fingerprint"*|*"authenticity"*|*"continue connecting"*)',
    '    echo yes',
    '    ;;',
    // Explicit non-credential exclusions BEFORE the password branch: prompts whose wording also
    // contains "password:" (OTP/verification code, password change) must never receive it. The otp
    // match is boundary-scoped so a host/user name like "otp-host" cannot shadow a real prompt.
    '  *"one-time password"*|*"otp:"*|*"otp "*|*"verification code"*|*"new password"*|*"change your password"*)',
    '    exit 0',
    '    ;;',
    '  *"password:"*|*"password for "*|*"passphrase"*)',
    `    printf '%s\\n' '${escaped}'`,
    '    ;;',
    '  *)',
    '    # Fail closed: any prompt that is not a host-key or password prompt',
    '    # (OTP/verification code, password change, unknown wording) gets NO',
    '    # answer — ssh fails auth instead of receiving the password.',
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

const ASKPASS_DIR_PREFIX = 'dsh-chamber-ssh-'
const LEGACY_ASKPASS_DIR_NAME = 'dsh-chamber-ssh'
let processAskpassDir: string | null = null

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
function privateAskpassDir(): string {
  if (processAskpassDir !== null) {
    chmodAskpassDirOwnerOnly(processAskpassDir)
    return processAskpassDir
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

/** Write one ephemeral askpass helper for an instance; returns its path. */
export function createAskpassHelper(id: string, password: string): string {
  // The id lands in the temp filename — refuse anything outside the registry whitelist (defense in
  // depth; the IPC gate already enforces this before a password can be stored).
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing askpass helper for invalid instance id ${JSON.stringify(id)}`)
  }
  const dir = privateAskpassDir()
  // The owner PID lets startup cleanup distinguish crash leftovers from a running chamber process.
  const path = join(dir, `askpass-${id}.pid-${process.pid}.${randomUUID()}.sh`)
  try {
    // Keep a partially written helper non-executable, then publish it as an owner-only executable:
    // the explicit chmod defeats a restrictive umask and O_EXCL prevents a same-name collision from
    // replacing the file. The executable mode is set last, on the already-open inode.
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, buildAskpassScript(password))
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

/** Remove password-bearing helpers left by a hard crash before transports start. */
export function cleanupStaleAskpassHelpers(): string | null {
  const tempRoot = tmpdir()
  const notices: string[] = []
  try {
    for (const dirName of readdirSync(tempRoot)) {
      if (dirName !== LEGACY_ASKPASS_DIR_NAME && !dirName.startsWith(ASKPASS_DIR_PREFIX)) continue
      const dir = join(tempRoot, dirName)
      try {
        // Cross-user/pre-claimed directories are reported and skipped: never used by
        // privateAskpassDir, and their files are never mutated.
        chmodAskpassDirOwnerOnly(dir)
      } catch (error) {
        notices.push(`refused untrusted SSH askpass directory ${dir}: ${String(error)}`)
        continue
      }
      for (const name of readdirSync(dir)) {
        const current = /^askpass-[a-zA-Z0-9_-]{1,64}\.pid-(\d+)\.[0-9a-f-]+\.sh$/i.exec(name)
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
        try { rmSync(dir) } catch { /* a concurrent owner may have populated it */ }
      }
    }
    return notices.length === 0 ? null : notices.join('; ')
  } catch (error) {
    return `cannot clean stale SSH askpass helpers: ${String(error)}`
  }
}

/** Best-effort delete of one askpass helper (no-op when already gone). */
function deleteAskpassHelper(path: string) {
  try {
    rmSync(path, { force: true })
  } catch { /* best effort */ }
}

function releaseAskpassGeneration(id: string, generation: AskpassGeneration): void {
  if (generation.leases === 0) return
  generation.leases -= 1
  if (generation.leases !== 0) return
  deleteAskpassHelper(generation.path)
  const generations = askpassHelpers.get(id)
  if (generations === undefined) return
  generations.delete(generation)
  if (generations.size === 0) askpassHelpers.delete(id)
}

/**
 * Acquire the askpass environment for exactly one ssh spawn (tunnel, systemd or run); null = key/
 * agent auth. The helper is fresh for this spawn and stays on disk until the idempotent lease
 * release — cleanup requests cannot invalidate a live child's SSH_ASKPASS path.
 */
export function acquireSshAuthLease(spec: TransportInstanceSpec): TransportSpawnLease | null {
  if (!sshPasswordSupported()) return null
  // The password file and registry are separately atomic: compare the persisted owner at the last
  // possible moment, so a crash between commits can only disable password auth, never send an old
  // secret to the new endpoint behind the same id.
  const password = getSshPassword(spec)
  if (password === null) return null
  const generation: AskpassGeneration = {
    path: createAskpassHelper(spec.id, password),
    leases: 1,
  }
  let generations = askpassHelpers.get(spec.id)
  if (generations === undefined) {
    generations = new Set()
    askpassHelpers.set(spec.id, generations)
  }
  generations.add(generation)
  let released = false
  return {
    env: { SSH_ASKPASS: generation.path, SSH_ASKPASS_REQUIRE: 'force' },
    release() {
      if (released) return
      released = true
      releaseAskpassGeneration(spec.id, generation)
    },
  }
}

/** Transport-stop cleanup that never deletes a generation leased by a tunnel or in-flight exec;
 *  every generation is single-spawn and removes itself when its child terminates. */
export function disposeSshAuth(spec: TransportInstanceSpec): void {
  const generations = askpassHelpers.get(spec.id)
  if (generations === undefined) return
  // Normally every tracked generation has a live lease; the defensive zero-count sweep keeps a
  // future multi-retain implementation from stranding an unreferenced helper at disconnect.
  for (const generation of generations) {
    if (generation.leases !== 0) continue
    deleteAskpassHelper(generation.path)
    generations.delete(generation)
  }
  if (generations.size === 0) askpassHelpers.delete(spec.id)
}

/** Final cleanup for instance removal / explicit password clear: a live child stays authoritative —
 *  its helper is deleted only when its lease releases; crash leftovers are reclaimed at startup. */
export function purgeSshAuth(id: string): void {
  const generations = askpassHelpers.get(id)
  if (generations === undefined) return
  for (const generation of generations) {
    if (generation.leases === 0) {
      deleteAskpassHelper(generation.path)
      generations.delete(generation)
    }
  }
  if (generations.size === 0) askpassHelpers.delete(id)
}

/** The ssh provider: validate → spawn args → stderr classification → exec. */
export const sshProvider: TransportProvider = {
  kind: 'dsh',
  redactOutput: redactSshStderr,

  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (!isValidInstance(input)) return null
    const record = input as unknown as Record<string, unknown>
    return {
      id: record.id as string,
      label: record.label as string,
      // The provider serves both target kinds over ssh; the spec's kind is preserved (default dsh).
      kind: record.kind === 'gateway' ? 'gateway' : 'dsh',
      transport: 'ssh',
      host: record.host as string,
      user: record.user === undefined || record.user === null ? null : (record.user as string),
      sshPort: record.sshPort === undefined || record.sshPort === null ? null : (record.sshPort as number),
      remotePort: record.remotePort as number,
      serviceName: record.serviceName === undefined || record.serviceName === null ? null : (record.serviceName as string),
      remoteDshHome: record.remoteDshHome === undefined || record.remoteDshHome === null ? null : (record.remoteDshHome as string),
      insecureHttp: false,
    }
  },

  buildStartArgs(spec: TransportInstanceSpec, localPort: number): readonly string[] {
    const target = spec.user ? `${spec.user}@${spec.host}` : spec.host
    // SSH keepalive (SERVER_ALIVE_*): ssh exits on its own within ~90s of a dead connection,
    // feeding the runtime's reconnect; probes also refresh NAT mappings TCP keepalives cannot.
    const keepaliveArgs = ['-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`, '-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`]
    return spec.sshPort === null
      ? ['-N', ...keepaliveArgs, '-L', `${localPort}:127.0.0.1:${spec.remotePort}`, target]
      : ['-N', ...keepaliveArgs, '-p', String(spec.sshPort), '-L', `${localPort}:127.0.0.1:${spec.remotePort}`, target]
  },

  /** Password auth: when a password is stored, return the askpass env so the tunnel spawn delivers
   *  it to ssh without a TTY or the command line. Null = key/agent auth or an unsupported platform. */
  buildStartEnv(spec: TransportInstanceSpec): TransportSpawnLease | null {
    return acquireSshAuthLease(spec)
  },

  /** Askpass cleanup request (stop/removal/quit) that never deletes a child-leased generation. The
   *  password itself survives disconnect and app quit by design — only an explicit clear or the
   *  main-owned save/delete transaction removes it. */
  disposeAuth(spec: TransportInstanceSpec): void {
    disposeSshAuth(spec)
  },

  /** Final askpass cleanup — called ONLY on instance removal, never on plain disconnect; live child
   *  leases still win and remove their own paths at termination. */
  purgeAuth(spec: TransportInstanceSpec): void {
    purgeSshAuth(spec.id)
  },

  classifyStderr(line: string) {
    const log = redactSshStderr(line).trimEnd()
    // Both classifications run on the RAW line, never the redacted view: redaction replaces a whole
    // `.ssh*`-named-path line, and terminal-auth/ENOENT signals must survive it.
    const terminalAuth = AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(line))
    const enoent = ENOENT_PATTERN.test(line)
    return { log, terminalAuth, enoent }
  },

  /**
   * Endpoint identity verification: the tunnel destination must answer the target-kind identity
   * before the runtime may declare it ready — a non-target service never presents as a fake
   * connection. `dsh` never carries auth headers (plain verifyDshEndpoint over the loopback
   * endpoint); `gateway` uses the authenticated runtime status marker, which proves the gateway
   * boundary independently of managed-dsh health, keeping recovery actions reachable. A stored
   * bearer token rides the probe; a MISSING token is no pre-flight refusal (the gateway's own
   * answer is classified). No token + stored password + wired session hooks rides the shared
   * password-session flow (login keyed to the tunnel origin, probe with its Cookie, one invalidate
   * + re-login on 401 before the terminal password-refused state).
   */
  verifyUp(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint) {
    if (spec.kind === 'gateway') {
      // Tunnel Host override: every request through the tunnel presents the remote LOOPBACK
      // destination authority — never spec.host, which may only be an SSH alias. The gateway's
      // policy (authority port == listen port) rejects the tunnel's local port otherwise.
      const authority = gatewayTunnelAuthority(spec.remotePort)
      const password = getGatewayPassword(spec.id)
      // Password + wired session hooks: the login session is keyed to the LOOPBACK tunnel origin
      // (the only origin the tunnel reaches) + exact connection/SSH-target scope; the remote
      // authority is only the Host the gateway sees. The probe carries its Cookie plus the
      // independent Bearer when present. Without hooks the token still probes normally and a
      // password-only target stays credential-free (the inert default).
      if (password !== null && getGatewaySessionHooks().ensureSession !== undefined) {
        return verifyGatewayWithPasswordViaTunnel(spec, endpoint, password, authority)
      }
      // Read at the use point (each network exchange), never at entry — a rotation after verifyUp
      // was invoked must be observed here.
      return verifyGatewayEndpointViaTunnel(endpoint, getGatewayToken(spec.id), VERIFY_UP_TIMEOUT_MS, VERIFY_UP_MAX_BODY_BYTES, null, authority)
    }
    return verifyDshEndpoint(endpoint)
  },

  exec(spec: TransportInstanceSpec, action: TransportExecAction, deps: TransportExecDeps, payload?: TransportRunPayload): Promise<TransportExecResult> {
    return runExec(spec, action, deps, payload)
  },
}

/**
 * One bounded short-lived ssh child lifecycle, shared by the systemctl exec (runExec) and the run
 * channel (spawnRemote). Caller-specific semantics stay in the callbacks (spawn/timeout wording,
 * stderr classification, stdout handling, exit classification); only the mechanical lifecycle is
 * single-sourced: settle + finish, the askpass auth lease, timeout SIGTERM → grace SIGKILL,
 * bounded stderr lines, spawn error.
 *
 * INVARIANT: finish() clears killTimer, so a bound-stop path must call finish() BEFORE arming the
 * SIGKILL fallback — arming first would let finish clear the fallback immediately.
 */
interface BoundedSshRun<T> {
  spec: TransportInstanceSpec
  args: readonly string[]
  spawnOptions: SpawnOptions
  timeoutMs: number
  deps: TransportExecDeps
  /** Optional stdin payload (write-file), written and ended right after spawn. */
  stdin?: string
  /** Caller-spelled spawn-failure log; `phase` separates the spawn throw from the child error event. */
  logSpawnFailure(errorText: string, phase: 'throw' | 'error'): void
  /** Caller-spelled spawn-failure result. */
  spawnFailureResult(errorText: string): T
  /** Caller-spelled timeout log line and result. */
  timeoutLog: string
  timeoutResult: T
  /** One complete stderr line, or the dropped-line signal. */
  onStderrLine(line: string, dropped: boolean): void
  /** One stdout chunk; a non-null return is a bound-stop (log + SIGTERM + finish + SIGKILL grace).
   *  `settled` lets a caller decide whether to drain/echo output after a teardown. */
  onStdout?: (bytes: Buffer, settled: boolean) => { log: string; result: T } | null
  /** Exit classification; the helper already flushed the bounded stderr processor and skipped timeout/settled exits. */
  onExit(code: number | null, exitSignal: NodeJS.Signals | null, finish: (result: T) => void): void
}

function spawnBoundedSsh<T>(options: BoundedSshRun<T>): Promise<T> {
  const { spec, args, spawnOptions, timeoutMs, deps } = options
  return new Promise<T>(resolve => {
    let settled = false
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: T) => {
      if (settled) return
      settled = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (killTimer !== null) { clearTimeout(killTimer); killTimer = null }
      resolve(result)
    }
    let child: SpawnedProcess
    // The exec spawn gets the same askpass env as the tunnel — a password-only host must answer
    // ssh exec/run too. Null = key/agent auth, no env merge.
    const authLease = acquireSshAuthLease(spec)
    if (authLease !== null) spawnOptions.env = { ...process.env, ...authLease.env }
    try {
      child = deps.spawnFn('ssh', args, spawnOptions)
    } catch (spawnError) {
      authLease?.release()
      const detail = String(spawnError)
      options.logSpawnFailure(detail, 'throw')
      finish(options.spawnFailureResult(detail))
      return
    }
    if (authLease !== null) {
      child.on('error', () => authLease.release())
      child.on('exit', () => authLease.release())
    }
    if (options.stdin !== undefined && child.stdin !== null) {
      child.stdin.write(options.stdin)
      child.stdin.end()
    }
    timer = setTimeout(() => {
      timedOut = true
      deps.log('error', options.timeoutLog)
      signalChild(child, 'SIGTERM')
      // INVARIANT: finish() clears killTimer - settle BEFORE arming the
      // SIGKILL fallback.
      finish(options.timeoutResult)
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), deps.disconnectGraceMs)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
    // Line-buffered stderr, mirroring the tunnel channel: redaction and auth detection run on
    // complete lines, never arbitrary chunks.
    const processStderr = createBoundedLineProcessor(
      line => options.onStderrLine(line, false),
      () => options.onStderrLine('', true),
    )
    if (child.stderr !== null) {
      child.stderr.on('data', chunk => processStderr(String(chunk)))
    }
    if (options.onStdout !== undefined && child.stdout !== null) {
      const onStdout = options.onStdout
      child.stdout.on('data', chunk => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        const stop = onStdout(bytes, settled)
        if (stop === null || settled) return
        deps.log('error', stop.log)
        signalChild(child, 'SIGTERM')
        finish(stop.result)
        killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), deps.disconnectGraceMs)
        killTimer.unref?.()
      })
    }
    child.on('error', error => {
      // Spawn failure (e.g. the ssh binary is missing): loud result, never swallowed; the tunnel's
      // terminal classification stays untouched.
      const detail = String(error)
      options.logSpawnFailure(detail, 'error')
      finish(options.spawnFailureResult(detail))
    })
    child.on('exit', (code, exitSignal) => {
      if (timedOut || settled) return
      processStderr('\n')
      options.onExit(code, exitSignal, finish)
    })
  })
}

/**
 * One remote systemd exec: `ssh user@host systemctl <action> -- <serviceName>` — argument-array
 * spawn (no shell), serviceName whitelist-checked BEFORE anything spawns and separated from
 * systemctl options by `--` (defense in depth; a refused name logs and returns an error). Failures
 * are loud (ring buffer + error result), never swallowed; auth failures surface through the result
 * error only — this channel NEVER writes the tunnel state, so a routine tunnel drop after a failed
 * exec is never mislabeled terminal. Execs are never auto-retried; the timeout SIGTERMs the ssh
 * process (SIGKILL after the disconnect grace) and resolves as an error. It spawns its own
 * short-lived ssh process and never touches the tunnel child; serviceActive is written on demand.
 */
function runExec(
  spec: TransportInstanceSpec,
  action: TransportExecAction,
  deps: TransportExecDeps,
  payload?: TransportRunPayload,
): Promise<TransportExecResult> {
  if (action === 'run') return runRemoteExec(spec, payload, deps)
  if (spec.serviceName === null) {
    return Promise.resolve({ ok: false, error: 'no systemd service configured for this instance' })
  }
  if (!SERVICE_NAME_PATTERN.test(spec.serviceName)) {
    deps.log('error', `refused systemctl ${action}: invalid service name ${JSON.stringify(spec.serviceName)}`)
    return Promise.resolve({ ok: false, error: 'invalid service name' })
  }
  const target = spec.user ? `${spec.user}@${spec.host}` : spec.host
  const args = spec.sshPort === null
    ? [target, 'systemctl', action, '--', spec.serviceName]
    : ['-p', String(spec.sshPort), target, 'systemctl', action, '--', spec.serviceName]
  let authFailed = false
  const processStdout = createBoundedLineProcessor(
    line => {
      const redacted = redactSshStderr(line)
      if (redacted !== '') deps.log('info', redacted)
    },
    () => deps.log('error', `ssh output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`),
  )
  return spawnBoundedSsh<TransportExecResult>({
    spec,
    args,
    spawnOptions: { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    timeoutMs: deps.execTimeoutMs,
    deps,
    logSpawnFailure: (errorText, phase) => deps.log('error', phase === 'throw'
      ? `failed to spawn ssh for systemctl ${action}: ${errorText}`
      : `ssh spawn error for systemctl ${action}: ${errorText}`),
    spawnFailureResult: errorText => ({ ok: false, error: `failed to spawn ssh: ${errorText}` }),
    timeoutLog: `systemctl ${action} ${spec.serviceName} timed out after ${deps.execTimeoutMs}ms`,
    timeoutResult: { ok: false, error: `systemctl ${action} timed out after ${deps.execTimeoutMs}ms` },
    onStderrLine: (line, dropped) => {
      if (dropped) {
        deps.log('error', `ssh output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`)
        return
      }
      const { log, terminalAuth } = sshProvider.classifyStderr(line)
      if (log === '') return
      deps.log('info', log)
      if (terminalAuth) {
        authFailed = true
        deps.log('error', 'authentication failure detected (requires user action)')
      }
    },
    onStdout: bytes => {
      processStdout(String(bytes))
      return null
    },
    onExit: (code, exitSignal, finish) => {
      processStdout('\n')
      if (authFailed) {
        finish({ ok: false, error: 'authentication failure — requires user action' })
        return
      }
      if (code === 0) {
        if (action === 'is-active') {
          deps.setProjection(spec.id, 'serviceActive', true)
          deps.log('info', `systemctl is-active ${spec.serviceName}: active`)
        } else if (action === 'restart') {
          // restart: honest "restarted" — never touches serviceActive (the unit's prior state is
          // unchanged; restart does not define it).
          deps.log('info', `systemctl restart ${spec.serviceName}: exit 0`)
        } else {
          deps.setProjection(spec.id, 'serviceActive', action === 'start')
          deps.log('info', `systemctl ${action} ${spec.serviceName}: exit 0`)
        }
        const projection = deps.projection(spec.id)
        if (projection === null) {
          // The instance was removed while the exec was in flight.
          finish({ ok: false, error: 'ssh instance not found' })
          return
        }
        finish({ ok: true, status: projection })
        return
      }
      if (action === 'is-active') {
        // Honest is-active classification — a failure is never "inactive": exit 4 = no such unit
        // (explicit error; serviceActive falls back to null so a stale "active" never lingers);
        // exit 255/signal death = the ssh exec itself failed, NOT a unit state; any other non-zero
        // (1/3: inactive/failed) = a valid answer, the unit exists but is not active.
        if (code === 4) {
          deps.setProjection(spec.id, 'serviceActive', null)
          deps.log('error', `systemctl is-active ${spec.serviceName}: no such unit (exit 4)`)
          finish({ ok: false, error: `systemd unit ${spec.serviceName} not found — check the service name` })
          return
        }
        if (code === 255 || code === null) {
          deps.log('error', `systemctl is-active ${spec.serviceName}: ssh exec failed (exit ${code ?? exitSignal})`)
          finish({ ok: false, error: `systemctl is-active failed: the ssh exec could not reach the host (exit ${code ?? exitSignal})` })
          return
        }
        deps.setProjection(spec.id, 'serviceActive', false)
        deps.log('info', `systemctl is-active ${spec.serviceName}: not active (exit ${code ?? exitSignal})`)
        const projection = deps.projection(spec.id)
        if (projection === null) {
          finish({ ok: false, error: 'ssh instance not found' })
          return
        }
        finish({ ok: true, status: projection })
        return
      }
      deps.log('error', `systemctl ${action} ${spec.serviceName} failed (exit ${code ?? exitSignal})`)
      finish({ ok: false, error: `systemctl ${action} failed (exit ${code ?? exitSignal})` })
    },
  })
}

/** Build the ssh argv (everything after `ssh`) for a `run` exec, or null when command/argv fail
 *  the whitelist (refused BEFORE spawn). ssh concatenates these into one string for the REMOTE
 *  shell, so every argument must be shell-safe. */
export function buildRemoteExecArgv(spec: TransportInstanceSpec, payload: TransportRunPayload): string[] | null {
  const argv = payload.argv
  if (!Array.isArray(argv)) return null
  const prefix = spec.remoteDshHome !== null ? [`DSH_HOME=${spec.remoteDshHome}`] : []
  if (payload.command === 'dsh') {
    // argv = ['plugin', '--profile', 'web', 'add'|'remove', <spec>]
    if (argv.length !== 5 || argv[0] !== 'plugin' || argv[1] !== '--profile' || argv[2] !== 'web') return null
    if (argv[3] !== 'add' && argv[3] !== 'remove') return null
    const specArg = argv[4]
    if (typeof specArg !== 'string') return null
    // `add` accepts the registry spec OR the main-process materialize `file:` absolute-tarball form
    // (MATERIALIZE_FILE_SPEC_PATTERN; renderer input can never reach this branch — applyPlugins
    // re-validates against PLUGIN_SPEC_PATTERN, which refuses `file:`); `remove` is name-only.
    const ok = specArg.length <= MAX_PLUGIN_SPEC_CHARS && (argv[3] === 'add'
      ? PLUGIN_SPEC_PATTERN.test(specArg) || MATERIALIZE_FILE_SPEC_PATTERN.test(specArg)
      : PLUGIN_NAME_PATTERN.test(specArg))
    if (!ok) return null
    return [...prefix, 'dsh', ...argv]
  }
  if (payload.command === 'cat') {
    if (argv.length !== 1 || typeof argv[0] !== 'string') return null
    const home = spec.remoteDshHome ?? '~/.dsh'
    // Whitelisted cat targets: the profile manifest + patch file, plus the CONVERGED seed subtree
    // `<home>/profiles/node_modules/@dsh-chamber/<pkg>/<file>` — the same surface resolveWriteTarget
    // allows writes into, needed by the seed hash-skip read-back. No wildcards, no `.`/`..`
    // traversal (shared SEED_RELATIVE_PATTERN).
    const seedPrefix = `${home}/profiles/node_modules/@dsh-chamber/`
    const isSeedRead = argv[0].startsWith(seedPrefix)
      && argv[0].length > seedPrefix.length
      && SEED_RELATIVE_PATTERN.test(argv[0].slice(seedPrefix.length))
    if (argv[0] !== `${home}/profiles/web/package.json` && argv[0] !== `${home}/profiles/web/cordis.patch.yml` && !isSeedRead) return null
    // `LC_ALL=C` forces the REMOTE coreutils to emit English regardless of the remote locale (a
    // zh_CN host would otherwise print 没有那个文件或目录, which ENOENT classification would misread
    // as a loud ssh failure). Fixed literal env assignment; `DSH_HOME` rides the same prefix chain.
    return [...prefix, 'LC_ALL=C', 'cat', argv[0]]
  }
  if (payload.command === 'printf') {
    // Remote `$HOME` lookup for the materialize `file:` absolute path: a FIXED argv constructed here
    // in the main process only (never renderer input); `$HOME` is a literal the REMOTE shell expands.
    // (`$` is normally refused on the command line — this single constant is the sanctioned exception.)
    if (argv.length !== 2 || argv[0] !== '%s' || argv[1] !== '$HOME') return null
    return ['printf', '%s', '$HOME']
  }
  return null
}

/** A seed-subtree RELATIVE path (`@dsh-chamber/<pkg>/<file>`, prefix stripped before this check):
 *  `/`-joined segments each starting alphanumeric; `.`/`..` traversal and empty/dot segments are
 *  rejected. Shared by the write-file target whitelist and the cat seed read-back. */
const SEED_RELATIVE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/

/** Validate a write-file target against the fixed prefixes (materialized-tarball dir, seed dir,
 *  profile patch file); returns the target (`~` left for the remote shell) or null. */
export function resolveWriteTarget(spec: TransportInstanceSpec, path: string | undefined): string | null {
  if (typeof path !== 'string' || path === '') return null
  const home = spec.remoteDshHome ?? '~/.dsh'
  if (/^~\/\.dsh-chamber\/plugins\/[a-zA-Z0-9._-]+\.tgz$/.test(path)) return path
  const seedPrefix = `${home}/profiles/node_modules/@dsh-chamber/`
  if (path.startsWith(seedPrefix) && path.length > seedPrefix.length && SEED_RELATIVE_PATTERN.test(path.slice(seedPrefix.length))) return path
  if (path === `${home}/profiles/web/cordis.patch.yml`) return path
  return null
}

/** Spawn one short-lived `ssh` run and drive it to completion: bounded timeout (SIGTERM → SIGKILL),
 *  stderr redaction + auth classification, optional stdin write, and one bounded stdout mode —
 *  capture for whitelisted reads or streaming SHA-256 for write-file verification. Never auto-retried. */
function spawnRemote(
  spec: TransportInstanceSpec,
  remoteArgv: string[],
  deps: TransportExecDeps,
  opts: {
    stdin?: string
    stdoutMode?: 'capture' | 'sha256'
    quiet?: boolean
  },
): Promise<TransportExecResult & { stdoutSha256?: string }> {
  const timeoutMs = deps.runTimeoutMs ?? 120_000
  const target = spec.user ? `${spec.user}@${spec.host}` : spec.host
  const args = spec.sshPort === null
    ? [target, ...remoteArgv]
    : ['-p', String(spec.sshPort), target, ...remoteArgv]
  let authFailed = false
  let enoentDetected = false
  const stdoutChunks: Buffer[] = []
  const stdoutHash = opts.stdoutMode === 'sha256' ? createHash('sha256') : null
  let stdoutBytes = 0
  // Redacted stderr lines for the failure detail (classifyStderr already applied redactSshStderr).
  let stderrDetail = ''
  const appendStderrDetail = (line: string) => {
    if (stderrDetail.length >= RUN_STDERR_DETAIL_MAX_CHARS) return
    const separator = stderrDetail === '' ? '' : ' | '
    const remaining = RUN_STDERR_DETAIL_MAX_CHARS - stderrDetail.length
    stderrDetail += `${separator}${line}`.slice(0, remaining)
  }
  return spawnBoundedSsh<TransportExecResult & { stdoutSha256?: string }>({
    spec,
    args,
    spawnOptions: { stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true },
    stdin: opts.stdin,
    timeoutMs,
    deps,
    logSpawnFailure: (errorText, phase) => deps.log('error', phase === 'throw'
      ? `failed to spawn ssh for run: ${errorText}`
      : `ssh spawn error for run: ${errorText}`),
    spawnFailureResult: errorText => ({ ok: false, error: `failed to spawn ssh: ${errorText}` }),
    timeoutLog: `run timed out after ${timeoutMs}ms`,
    timeoutResult: { ok: false, error: `run timed out after ${timeoutMs}ms` },
    onStderrLine: (line, dropped) => {
      if (dropped) {
        const summary = `ssh output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`
        appendStderrDetail(summary)
        if (opts.quiet !== true) deps.log('error', summary)
        return
      }
      const { log, terminalAuth, enoent } = sshProvider.classifyStderr(line)
      if (log === '') return
      appendStderrDetail(log)
      // Quiet runs (expected-failure probes): the redacted stderr still rides the failure detail, but
      // the raw INFO echo is suppressed so an expected ENOENT probe cannot pollute the log panel.
      if (opts.quiet !== true) deps.log('info', log)
      if (terminalAuth) {
        authFailed = true
        deps.log('error', 'authentication failure detected (requires user action)')
      }
      if (enoent) enoentDetected = true
    },
    onStdout: (bytes, settled) => {
      if (opts.stdoutMode === undefined || settled) return null
      if (stdoutBytes + bytes.length > RUN_STDOUT_MAX_BYTES) {
        const detail = `run stdout exceeds the ${RUN_STDOUT_MAX_BYTES}-byte limit`
        return { log: detail, result: { ok: false, error: detail } }
      }
      stdoutBytes += bytes.length
      if (opts.stdoutMode === 'capture') stdoutChunks.push(bytes)
      else stdoutHash!.update(bytes)
      return null
    },
    onExit: (code, exitSignal, finish) => {
      if (authFailed) {
        finish({ ok: false, error: 'authentication failure — requires user action' })
        return
      }
      if (code !== 0) {
        // Run-class failures carry the redacted remote stderr (bounded, so a chatty remote never
        // bloats the error). A QUIET run (an expected-failure probe) is still `ok:false` with the same
        // error text — the caller's ENOENT classification keeps working — but the ERROR-level log is
        // skipped so an expected probe failure cannot pollute the log panel.
        let detail = stderrDetail
        // ENOENT is classified on the RAW stderr and a redacted detail may have lost the signal (a
        // `.ssh*`-named path makes redactSshStderr replace the whole line). Re-attach the marker so the
        // caller's ENOENT_PATTERN keeps classifying an absent file as absent while the path stays hidden.
        if (enoentDetected && !ENOENT_PATTERN.test(detail)) {
          detail = detail === '' ? 'No such file or directory' : `${detail}: No such file or directory`
        }
        const suffix = detail === '' ? '' : `: ${detail}`
        if (opts.quiet !== true) deps.log('error', `run command failed (exit ${code ?? exitSignal})${suffix}`)
        finish({ ok: false, error: `run command failed (exit ${code ?? exitSignal})${suffix}` })
        return
      }
      const projection = deps.projection(spec.id)
      if (projection === null) {
        finish({ ok: false, error: 'ssh instance not found' })
        return
      }
      // Whitelisted exec reads retain raw bytes plus their UTF-8 view; write-file selects sha256 mode
      // instead and never builds either full-size representation.
      const capturedStdout = opts.stdoutMode === 'capture' ? Buffer.concat(stdoutChunks, stdoutBytes) : undefined
      finish({
        ok: true,
        status: projection,
        stdout: capturedStdout !== undefined ? capturedStdout.toString('utf8') : undefined,
        stdoutBytes: capturedStdout,
        stdoutSha256: stdoutHash?.digest('hex'),
      })
    },
  })
}

/** The `run` exec dispatcher: `exec` runs a whitelisted remote command; `write-file` streams base64
 *  over ssh stdin to `mkdir -p <dir> && base64 -d > <path>` and verifies SHA-256 by reading the file
 *  back over `cat` (no platform-specific sha256sum). */
async function runRemoteExec(
  spec: TransportInstanceSpec,
  payload: TransportRunPayload | undefined,
  deps: TransportExecDeps,
): Promise<TransportExecResult> {
  if (payload === undefined) return Promise.resolve({ ok: false, error: 'run exec requires a payload' })
  if (payload.op === 'exec') {
    const argv = buildRemoteExecArgv(spec, payload)
    if (argv === null) {
      deps.log('error', `refused run exec: command/argv not whitelisted ${JSON.stringify(payload.command)} ${JSON.stringify(payload.argv)}`)
      return Promise.resolve({ ok: false, error: 'invalid run command or arguments (whitelist refused)' })
    }
    return spawnRemote(spec, argv, deps, { stdoutMode: 'capture', quiet: payload.quiet === true })
  }
  if (payload.op === 'write-file') {
    const target = resolveWriteTarget(spec, payload.path)
    if (target === null) {
      deps.log('error', `refused write-file: target not whitelisted ${JSON.stringify(payload.path)}`)
      return Promise.resolve({ ok: false, error: 'write-file target not allowed' })
    }
    if (typeof payload.contentBase64 !== 'string' || typeof payload.sha256 !== 'string') {
      return Promise.resolve({ ok: false, error: 'write-file requires contentBase64 and sha256' })
    }
    // Size cap: bounds the decoded payload before any write, covering the seed and materialize
    // payloads that flow through write-file. The base64 length is pre-checked so an oversized payload
    // is refused BEFORE allocating its decoded buffer (base64 of N bytes is ≤ ⌈N/3⌉·4 chars).
    const maxBase64Len = Math.ceil(WRITE_FILE_MAX_BYTES / 3) * 4 + 4
    if (payload.contentBase64.length > maxBase64Len) {
      deps.log('error', `refused write-file: content exceeds the ${WRITE_FILE_MAX_BYTES}-byte limit`)
      return Promise.resolve({ ok: false, error: `write-file content exceeds the ${WRITE_FILE_MAX_BYTES}-byte limit` })
    }
    const raw = Buffer.from(payload.contentBase64, 'base64')
    if (raw.length > WRITE_FILE_MAX_BYTES) {
      deps.log('error', `refused write-file: content exceeds the ${WRITE_FILE_MAX_BYTES}-byte limit`)
      return Promise.resolve({ ok: false, error: `write-file content exceeds the ${WRITE_FILE_MAX_BYTES}-byte limit` })
    }
    if (createHash('sha256').update(raw).digest('hex') !== payload.sha256.toLowerCase()) {
      return Promise.resolve({ ok: false, error: 'write-file content does not match sha256' })
    }
    const dir = dirname(target)
    const remoteCmd = dir === '.' || dir === '/' ? `base64 -d > ${target}` : `mkdir -p ${dir} && base64 -d > ${target}`
    const written = await spawnRemote(spec, [remoteCmd], deps, { stdin: payload.contentBase64, quiet: payload.quiet === true })
    if (!written.ok) return written
    // Same `LC_ALL=C` discipline as the buildRemoteExecArgv cat branch: ENOENT/probe failures must
    // read English regardless of the remote locale.
    const readBack = await spawnRemote(spec, ['LC_ALL=C', 'cat', target], deps, {
      stdoutMode: 'sha256',
      quiet: payload.quiet === true,
    })
    if (!readBack.ok) return readBack
    // Byte-domain verification stays streaming: write-file may be 50 MiB, and retaining chunks plus a
    // UTF-8 copy would multiply main-process memory for data no caller consumes.
    if (readBack.stdoutSha256 !== payload.sha256.toLowerCase()) {
      return { ok: false, error: 'write-file verification failed: remote SHA-256 mismatch' }
    }
    return { ok: true, status: readBack.status }
  }
  return Promise.resolve({ ok: false, error: 'unknown run payload op' })
}
