/**
 * The `ssh` transport provider (design 03 §2.2, 17 §2.2, transport-provider.ts):
 * everything source-specific about SSH tunnels and remote systemd exec,
 * packaged as a TransportProvider for the generic runtime. v2 semantics
 * (design 17 §2): this provider serves BOTH TARGET kinds — `dsh` and
 * `gateway` — over the `ssh` TRANSPORT method (the tunnel + exec machinery).
 * The target kind decides the verifyUp semantics only: a `dsh` target never
 * carries auth headers (design 17 §2.1), a `gateway` target may (a stored
 * bearer token rides the tunnel probe as Authorization; a missing token is
 * NO pre-flight refusal — the probe goes out without a header and the
 * gateway's own 401 is classified terminal, §2.3/§9.2). The direct-endpoint
 * `http` transport is a separate provider (gateway-provider.ts) and is
 * refused here loudly rather than mis-served.
 *
 * - Tunnels via the system `ssh` binary:
 *   `ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 [-p <sshPort>]
 *   -L <localPort>:127.0.0.1:<remotePort> <user@host>` — SSH-level keepalive
 *   (a dead/half-open connection makes ssh exit on its own within ~90s,
 *   which feeds the runtime's reconnect machinery, and the probes keep NAT
 *   mappings alive).
 * - systemctl exec (design 02 §3.9): `ssh user@host systemctl
 *   start|stop|is-active -- <serviceName>` — argument-array spawn (no shell),
 *   serviceName whitelisted `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` before anything
 *   runs and separated from options by `--` (injection guard), bounded timeout,
 *   failures loud. Auth failures surface
 *   through the result error only — the exec channel never writes the tunnel
 *   state (a later routine drop is never mislabeled terminal). is-active is
 *   classified honestly from the exit code: 0 active, 4 = no such unit
 *   (explicit error, serviceActive falls back to null), 255/signal death =
 *   ssh exec failure (explicit error, never "inactive"), anything else =
 *   inactive — a failed exec must never masquerade as a stopped service.
 * - Endpoint identity verification (verifyUp): a `dsh` target must answer the
 *   session/list unary handshake (slash-path wire, upstream 0.1.2-alpha.1 —
 *   host.describe is deleted there); a `gateway` target must answer its
 *   authenticated, gateway-owned `/chamber/runtime/status` identity, which
 *   deliberately stays available while managed dsh is blocked/down. An
 *   unrelated service never presents as a fake connection.
 * - Security discipline (design 05 §8): no credential material is ever
 *   placed on the command line (default ssh key/agent auth); stderr lines
 *   with key/passphrase material are redacted before they enter the ring
 *   buffer; logs carry hostnames/ports only.
 * - Optional password auth (design 05 §8, user request 2026-08): a password
 *   entered in the connections form is held in MAIN-PROCESS memory and —
 *   user decision 2026-08: plaintext-file fallback — mirrored to
 *   `<userData>/ssh-passwords.json` (0600, atomic write, loaded at startup),
 *   bound to the exact host/user/sshPort authentication peer so a registry
 *   edit or cross-file crash window cannot redirect it to another endpoint.
 *   It never enters the registry, logs, or any renderer payload beyond the
 *   transient input. The
 *   tunnel and systemd exec channels deliver it to the system `ssh` binary
 *   via an ephemeral askpass helper (SSH_ASKPASS_REQUIRE=force — no TTY and
 *   no command line involvement; the helper is a 0700 sh script that answers
 *   host-key confirmations with `yes` and password/passphrase prompts with
 *   the stored value, leased until its ssh child terminates). Platform note:
 *   Win32-OpenSSH askpass support is not reliable, so password auth is
 *   refused at the IPC gate on Windows (keys/agent remain the universal
 *   path).
 */

import type { SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// The dsh RPC wire envelope is single-sourced in control-plane
// (rpc-envelope.ts, A2 cross-package protocol single-sourcing) — consumed
// through control-plane-module.ts (the desktop dual-path facade: packaged →
// compiled dist/control-plane, dev → workspace source). The envelope shape
// can never drift from the control-plane unary client's.
import { buildClientRequest, mintRpcId, parseServerResponse, postClientRequest } from './control-plane-module.ts'
// The plugin spec/name whitelist family + reserved-name deny predicate
// (control-plane plugin-spec.ts, design 21 §6.2/§6.7 — the single source
// shared with the gateway; re-exported below for this provider's consumers).
import {
  isDeniedPluginName,
  MATERIALIZE_FILE_SPEC_PATTERN,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
} from './control-plane-module.ts'
import { CHILD_LINE_MAX_CHARS, createBoundedLineProcessor } from './bounded-lines.ts'
import { gatewayHttpFailureIsTerminal, getGatewayPassword, getGatewaySessionHooks, getGatewayToken, isGatewayRuntimeStatus, verifyGatewayPasswordSession } from './gateway-provider.ts'
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_LABEL_CHARS } from './transport-provider.ts'
import { isCredentialBinding, sshCredentialBinding, sshCredentialBindingForEndpoint } from './credential-binding.ts'
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
import { gatewaySessionScopeForConnection } from './gateway-session.ts'
import type { GatewaySessionOrigin } from './gateway-session.ts'
import { gatewayTunnelAuthority } from './gateway-session-refresh.ts'
import { readOwnerOnlySecretFile } from './owner-only-secret-file.ts'

/**
 * Registry metadata whitelists (design 03 §2.2 / 05 §8). id lands in
 * /api/i/dsh-<id> / gateway-<id> path segments and transport keys; host/user
 * are placed on the ssh command line as the connection target — a leading '-'
 * would be parsed as an ssh option by getopt (e.g. -oProxyCommand=... →
 * arbitrary command execution), so host/user must never start with '-'
 * (enforced by the character class: the first character is never '-'). host
 * allows dots/hyphens (hostnames) and [ ] for bracketed IPv6 literals; user
 * allows dots/underscores/hyphens. id additionally reserves 'local' (the
 * local-instance source id) and is validated by the runtime before the
 * provider sees it.
 */
export const SSH_HOST_PATTERN = /^[a-zA-Z0-9.:\[][a-zA-Z0-9._:\[\]-]*$/
export const SSH_USER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * systemd unit name whitelist (design 02 §3.9): only plain unit-name
 * characters are ever placed on the systemctl command line (no shell, no
 * injection). A leading '-' is specifically refused because systemctl would
 * parse an otherwise valid-looking name such as '--help' as an option.
 */
export const SERVICE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/**
 * Remote dsh home whitelist (design 13 §7.2): `~/.dsh` or an absolute path,
 * `~` only at word start, no spaces/metachars — shell-safe on the ssh command
 * line and in a `DSH_HOME=<path>` environment prefix. Each path segment is
 * additionally guarded against exactly `.` / `..` (a `..` segment would let a
 * crafted remoteDshHome escape the intended home subtree into user-writable
 * locations when seed write-file builds its targets under it).
 */
export const REMOTE_DSH_HOME_PATTERN = /^~?(?:\/(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._-]+)+$/
export const MAX_SSH_HOST_CHARS = 253
export const MAX_SSH_USER_CHARS = 64
export const MAX_SERVICE_NAME_CHARS = 255
export const MAX_REMOTE_DSH_HOME_CHARS = 1024
export const MAX_SSH_PASSWORD_CHARS = 4096
/**
 * Package-spec whitelist family (design 13 §7.2) + reserved-name deny
 * predicate — SINGLE-SOURCED in control-plane `plugin-spec.ts` (design 21
 * §6.2/§6.7: the gateway executor and the desktop share one source; the
 * renderer's ADD_SPEC stays a hand mirror pinned by the lockstep test in
 * gateway/test/plugin-spec-lockstep.test.ts). Consumed through
 * control-plane-module.ts — the desktop dual-path facade (packaged →
 * compiled dist/control-plane, dev → workspace source), the same A2 rule as
 * the rpc-envelope/cordis-inserts primitives above — and re-exported here so
 * this provider's consumers and tests keep one unchanged import surface.
 */
export {
  isDeniedPluginName,
  MATERIALIZE_FILE_SPEC_PATTERN,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
}

/** Bound of the redacted stderr detail attached to failed `run` errors. */
const RUN_STDERR_DETAIL_MAX_CHARS = 2048

/**
 * stderr lines that mean the transport cannot come up without user action
 * (credential / host-key problems). Terminal: never auto-retried.
 */
export const AUTH_FAILURE_PATTERNS: RegExp[] = [
  /permission denied/i,
  /authentication failed/i,
  /no supported authentication methods/i,
  /too many authentication failures/i,
  /host key verification failed/i,
  /password:/i,
]

/**
 * A remote `cat` failure that means "the file does not exist" (vs an ssh
 * failure). Classified on the RAW stderr line (never the redacted view):
 * redactSshStderr replaces an entire line carrying a `.ssh*`-named home path
 * (design 13 §7.2 allows `~/.ssh`-style remoteDshHome segments), and the
 * absent-file signal must survive that redaction so a genuinely-missing file
 * is never misclassified as a loud ssh failure. Shared with plugin-sync.ts
 * (single source of truth for the caller-side error-text test AND the
 * provider-side raw-line classification).
 *
 * The remote coreutils message is LOCALIZED: on a zh_CN-locale host `cat`
 * prints `没有那个文件或目录` instead of `No such file or directory`.
 * The PRIMARY fix is locale-independent — every remote `cat` (buildRemoteExecArgv
 * and the write-file read-back) now runs under `LC_ALL=C`, so the message is
 * ALWAYS English regardless of the remote locale. This pattern stays as
 * defense-in-depth for paths that bypass the prefix or a remote that ignores
 * it: the glibc zh_CN ENOENT text (its truncated `没有那个文件` prefix
 * included) is matched so a genuinely-absent package is still never misread
 * as a loud ssh failure.
 */
export const ENOENT_PATTERN = /(no such file or directory|没有那个文件|ENOENT|cat: .*no such file)/i

/**
 * Redact private material from ssh stderr before it enters the ring buffer
 * (design 05 §8: logs never carry SSH material). ssh emits prompt lines such
 * as `Enter passphrase for key '/Users/x/.ssh/id_ed25519':` and key-path
 * diagnostics (`Load key "...": invalid format`, `Offering public key: ...`)
 * which would leak key locations into renderer-visible logs; matching lines
 * are replaced with a fixed summary. Auth and ENOENT classification both run
 * on the original text (classifyStderr), so a redacted line never loses the
 * caller's absent-file (ENOENT) signal.
 */
export function redactSshStderr(text: string): string {
  // `host key:` only counts when a path follows (algorithm/fingerprint lines
  // like `host key: ssh-ed25519 SHA256:...` carry no location and stay).
  if (/passphrase|private key|identity|offering (public )?key|load key|host key: [^ ]*[\\/]|\.ssh(\d+)?\b|\.pem\b|\.key\b/i.test(text)) {
    return '[ssh material redacted]'
  }
  return text
}

/**
 * SSH-level keepalive (industry practice, autossh/OpenSSH guidance):
 * ServerAliveInterval seconds + ServerAliveCountMax dead-miss threshold. ssh
 * sends an encrypted channel probe whenever no data arrives within the
 * interval and exits after interval * countMax unanswered probes (~90s) —
 * the dead-tunnel detection happens inside ssh, and its exit feeds the
 * runtime's reconnect machinery. The periodic probes also keep NAT/firewall
 * mappings alive that TCP-level keepalives cannot.
 */
export const SERVER_ALIVE_INTERVAL_SECONDS = 30
export const SERVER_ALIVE_COUNT_MAX = 3

/** Timeout of the one-shot dsh identity probe (verifyUp). */
export const VERIFY_UP_TIMEOUT_MS = 5_000

/** Response-body cap of the dsh identity probe (an oversized answer is not
 * a session/list reply; bounded memory on a misbehaving endpoint). */
export const VERIFY_UP_MAX_BODY_BYTES = 1024 * 1024

/** Timeout of the one-shot client-graph liveness probe (probeClientGraphLive). */
export const CLIENT_GRAPH_PROBE_TIMEOUT_MS = 5_000

/** Response-body cap of the client-graph liveness probe (an oversized answer
 *  is not a graph RPC envelope; bounded memory on a misbehaving endpoint). */
export const CLIENT_GRAPH_PROBE_MAX_BODY_BYTES = 1024 * 1024

/** Timeout of the secondary dsh-signature probe (POST /api/session/list). */
export const VERIFY_UP_SIGNATURE_TIMEOUT_MS = 2_000

/**
 * Secondary dsh-signature probe: re-answer the session/list unary handshake
 * (POST /api/session/list with the standard client-request envelope — the
 * same slash-path identity wire as verifyDshEndpoint; upstream 0.1.2-alpha.1
 * deleted host.describe and the events.mux/events.host arms, so a valid
 * session/list answer is the only remaining positive dsh wire evidence) and
 * classify by the answer. A matching server-response envelope with
 * result.ok === true is positive dsh evidence: a destination that failed the
 * primary identity probe but answers the re-probe IS a dsh instance that
 * answered the handshake inconsistently — the caller can then tell the user
 * the destination is dsh instead of claiming "not dsh". Anything else (404,
 * garbage, wrong envelope, no answer) is no signature. An old-version dsh is
 * no longer distinguishable from a non-dsh web server by design: that
 * required the deleted legacy wire paths, so the generic message is honest.
 */
export function probeDshSignature(
  endpoint: { host: string; port: number },
  timeoutMs = VERIFY_UP_SIGNATURE_TIMEOUT_MS,
): Promise<'dsh' | 'none'> {
  const url = `http://${endpoint.host}:${endpoint.port}/api/session/list`
  const rpcId = mintRpcId()
  return postClientRequest({
    url,
    // The session/list unary is a Typert Remote on the 0.1.2 wire: the
    // payload is the `{args}` form ({_request:{}} = no typed args), the same
    // probe payload the control-plane readiness uses (spawn-dsh).
    envelope: buildClientRequest(rpcId, 'session/list', { args: { _request: {} } }),
    timeoutMs,
    maxBodyBytes: VERIFY_UP_MAX_BODY_BYTES,
  }).then(outcome => {
    if (outcome.timeout || outcome.status === null || outcome.status !== 200 || outcome.oversized) return 'none'
    const parsed = parseServerResponse(outcome.body, rpcId)
    return parsed.kind === 'ok' && parsed.envelope.result.ok === true ? 'dsh' : 'none'
  })
}

/**
 * One-shot dsh identity probe (design 03 §2.2 / 05 §7.6): POST
 * /api/session/list with the standard client-request envelope and require
 * a valid server-response echo with result.ok === true — the same wire
 * handshake the control plane's local readiness uses (02 §3.2: "TCP 通但
 * describe 失败 = 端口被无关服务占用") and dsh's own connection client
 * performs on attach. The method is the slash-path session/list of the
 * upstream 0.1.2-alpha.1 wire (host.describe is deleted there). The envelope
 * is built
 * and validated by the shared rpc-envelope module (single-sourced in
 * control-plane, consumed through control-plane-module.ts — the packaged
 * app loads the compiled control-plane bundle, dev runs the workspace
 * source). A port that merely accepts TCP — a non-dsh service on the remote
 * dsh port — answers differently and is rejected, so the runtime never
 * presents a fake connection as ready.
 *
 * Failure classification (honest, never guessed): when the handshake fails
 * at the HTTP level, a secondary dsh-signature probe (probeDshSignature)
 * re-answers session/list to decide between "the destination IS dsh but
 * answered the identity probe inconsistently — tell the user to check or
 * upgrade" (positive signature: a valid session/list server-response) and
 * the generic "not a dsh instance". The legacy 426/SSE events.mux signature
 * arms are gone from the wire, so an old-version dsh that fails the
 * slash-path handshake is indistinguishable from a non-dsh web server by
 * design — the generic message stays.
 *
 * Retry classification: a destination that ANSWERED the probe (any HTTP
 * answer, wrong-shaped body) carries `terminal: true` — retrying cannot
 * change the answer, so the runtime lands on error immediately instead of
 * burning the bounded reconnect cycle on a deterministic failure. Only
 * connection-level failures (no answer, timeout) stay transient and go
 * through the bounded reconnect path.
 * @returns {ok: true} on a valid handshake, {ok: false, detail, terminal?}
 *   otherwise (renderer-safe reason: hostnames/ports only, never
 *   credentials; terminal = deterministic non-dsh evidence).
 */
export async function verifyDshEndpoint(
  endpoint: { host: string; port: number },
  timeoutMs = VERIFY_UP_TIMEOUT_MS,
  maxBodyBytes = VERIFY_UP_MAX_BODY_BYTES,
): Promise<TransportVerifyResult> {
  // Bracketed IPv6 literals already carry their brackets in the URL.
  const url = `http://${endpoint.host}:${endpoint.port}/api/session/list`
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const rpcId = mintRpcId()
  const outcome = await postClientRequest({
    url,
    // The session/list unary is a Typert Remote on the 0.1.2 wire: the
    // payload is the `{args}` form ({_request:{}} = no typed args), the same
    // probe payload the control-plane readiness uses (spawn-dsh).
    envelope: buildClientRequest(rpcId, 'session/list', { args: { _request: {} } }),
    timeoutMs,
    maxBodyBytes,
  })
  if (outcome.timeout) {
    return { ok: false, detail: `the destination did not answer the dsh identity probe within ${timeoutMs}ms` }
  }
  if (outcome.status === null) {
    return { ok: false, detail: 'the destination did not answer the dsh identity probe' }
  }
  // A non-200 answer (404 from a non-dsh web server or from an older dsh
  // that does not register the slash-path session/list method, 403, 5xx, …):
  // classify with the dsh-signature probe before choosing the message.
  if (outcome.status !== 200) {
    // 0.1.2 browser-auth gate (review-round3c P0): the web-profile host
    // answers 401 without the signed cookie; the launch token is
    // process-memory random and printed only on the REMOTE console, so it is
    // unrecoverable over the tunnel — fail loud with the honest reason
    // instead of misclassifying the instance as "not a dsh". The signature
    // probe is gated the same way, so it cannot discriminate (round5): the
    // message hedges the non-dsh 401 case.
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
    return { ok: false, detail: 'the destination answered an oversized dsh identity probe response — it does not appear to be a dsh instance', terminal: true }
  }
  const parsed = parseServerResponse(outcome.body, rpcId)
  if (parsed.kind !== 'ok' || parsed.envelope.result.ok !== true) {
    return { ok: false, detail: 'the destination answered an unexpected dsh identity probe response — it does not appear to be a dsh instance', terminal: true }
  }
  return { ok: true }
}

/**
 * One-shot GATEWAY identity probe over an SSH TUNNEL endpoint (design 17
 * §9.2: kind 'gateway' + transport 'ssh'): GET /chamber/runtime/status at the
 * loopback tunnel endpoint — ALWAYS plain http (the tunnel carries its own
 * encryption; `insecureHttp` is meaningless for a loopback tunnel) — with the
 * gateway's bearer token when one is stored for the instance, and/or the
 * password-session Cookie (design 17 §9.3: the ssh provider's tunnel branch
 * uses the SAME session-hook flow as the direct-endpoint provider).
 *
 * Classification mirrors the gateway provider's direct-endpoint probe
 * (gateway-provider.ts verifyGatewayEndpoint, design 17 §9.3):
 * - 401 → TERMINAL, message split by what was sent: a session Cookie was
 *   carried (password-refused: "re-enter the password"), or no cookie and no
 *   token ("configure the shared token or password"), or a token was sent
 *   ("check the shared token") — the cases are never conflated;
 * - 403 → terminal (origin/Host policy rejection);
 * - any other non-200 → gatewayHttpFailureIsTerminal (every 5xx transient:
 *   gateway startup/overload/upstream windows are time-dependent);
 * - 200 with the gateway runtime identity marker → ready, even while managed
 *   dsh is blocked/down (design 18 §9.3 recovery mounting discipline).
 *
 * A missing token is NEVER a pre-flight refusal (design 17 §2.3): the probe
 * goes out WITHOUT an Authorization header and the gateway's own answer is
 * classified — a `--no-auth` deployment answers 200 and is ready, an
 * auth-requiring deployment answers 401 terminal. Connection failures stay
 * transient. The result carries `statusCode` so the caller can act on the
 * raw 401 (the verifyUp session flow invalidates the rejected cookie).
 */
export function verifyGatewayEndpointViaTunnel(
  endpoint: TransportProbeEndpoint,
  token: string | null,
  timeoutMs = VERIFY_UP_TIMEOUT_MS,
  maxBodyBytes = VERIFY_UP_MAX_BODY_BYTES,
  cookie: string | null = null,
  authority: string | undefined = undefined,
): Promise<TransportVerifyResult & { statusCode?: number }> {
  return new Promise(resolve => {
    const url = `http://${endpoint.host}:${endpoint.port}/chamber/runtime/status`
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (ok: boolean, detail?: string, terminal?: boolean, statusCode?: number) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      req.destroy()
      // statusCode rides the result only when a real answer produced it — an
      // undefined key must never change the probe's wire shape for callers
      // that deep-compare the plain {ok:true} success form.
      const result: TransportVerifyResult & { statusCode?: number } = ok
        ? { ok: true }
        : { ok: false, detail, terminal }
      if (statusCode !== undefined) result.statusCode = statusCode
      resolve(result)
    }
    const headers: Record<string, string> = {}
    // Tunnel Host override (design 17 §9.3 隧道 Host 覆盖): the probe
    // CONNECTS to the loopback tunnel endpoint but presents the REMOTE
    // gateway authority in the Host header — the gateway's request policy
    // requires the authority port to equal its listen port, which the
    // tunnel's local port can never satisfy.
    if (authority !== undefined) headers.host = authority
    // No credentials → NO Authorization header on the probe (design 17 §2.3):
    // the gateway itself is the authority on whether auth is needed. A
    // password-session Cookie rides alongside (never a credential VALUE in
    // logs — the cookie is main-process memory only, design 17 §9.4).
    if (token !== null) headers.authorization = `Bearer ${token}`
    if (cookie !== null) headers.cookie = cookie
    const req = httpRequest(url, {
      method: 'GET',
      headers,
    }, res => {
      // A premature close after our destroy must never escape as an
      // uncaught error (main-process safety discipline).
      res.on('error', () => {})
      if (res.statusCode === 401) {
        res.resume()
        done(false, cookie !== null
          ? 'the gateway rejected the password authentication (401) — re-enter the password'
          : token === null
            ? 'the gateway requires authentication (401) — configure the shared token or password'
            : 'the gateway rejected the token (401) — check the shared token', true, 401)
        return
      }
      if (res.statusCode === 403) {
        res.resume()
        done(false, 'the gateway refused the request origin/Host policy (403) — check the gateway deployment origin settings', true, 403)
        return
      }
      if (res.statusCode !== 200) {
        const statusCode = res.statusCode ?? 0
        res.resume()
        // Deterministic client/protocol mistakes require user action; every
        // 5xx is a time-dependent condition the bounded retry can recover.
        const terminal = gatewayHttpFailureIsTerminal(statusCode)
        done(false, `the gateway answered HTTP ${res.statusCode ?? '?'} to the runtime identity probe`, terminal, statusCode)
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', chunk => {
        if (settled) return
        size += chunk.length
        if (size > maxBodyBytes) {
          done(false, 'the gateway answered an oversized runtime identity response', true)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let status: unknown = null
        try {
          status = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          status = null
        }
        if (!isGatewayRuntimeStatus(status)) {
          done(false, 'the gateway answered an unexpected runtime identity response — it does not appear to be a compatible dsh-chamber gateway', true)
          return
        }
        done(true)
      })
    })
    // TOTAL deadline, not the socket-idle timeout: an endpoint that answers
    // slowly must never hang the verification.
    timer = setTimeout(() => done(false, `the gateway did not answer the runtime identity probe within ${timeoutMs}ms`), timeoutMs)
    timer.unref?.()
    req.on('error', () => done(false, 'the gateway did not answer the runtime identity probe'))
    req.end()
  })
}

/**
 * The password-session origin for an SSH TUNNEL endpoint (design 17 §9.3):
 * the login and the session cookie are keyed to the LOOPBACK tunnel origin
 * (`http://127.0.0.1:<localPort>`) — the only origin the tunnel ever
 * reaches. `insecureHttp: true` is the SCHEME selector the session manager
 * requires for plain http (gateway-session.ts resolveOrigin gate), NOT an
 * "insecure" judgement: the tunnel's own ssh encryption protects the loopback
 * hop, and the ssh spec's insecureHttp stays false in the projection. The
 * registration-time cookie lookup (main.ts) derives the SAME origin from the
 * ready transport URL, so the session minted here is exactly the one the
 * proxy injects. The exact connection/SSH-target scope additionally prevents
 * recycled local ports and shared remote authorities from crossing cookies
 * between ids or hosts. A reconnect allocates a new local port → a fresh
 * origin/login (design 17 §9.3 重连即重登).
 */
function tunnelSessionOrigin(
  spec: TransportInstanceSpec,
  endpoint: TransportProbeEndpoint,
  authority: string | undefined,
): GatewaySessionOrigin {
  return {
    baseUrl: `http://${endpoint.host}:${endpoint.port}`,
    insecureHttp: true,
    scope: gatewaySessionScopeForConnection(spec),
    ...(authority === undefined ? {} : { authority }),
  }
}

/** verifyUp for a password-configured gateway-over-ssh target:
 * the shared password-session flow (gateway-provider.ts
 * verifyGatewayPasswordSession — the same 401 → invalidate → single re-login
 * → terminal contract as the direct-endpoint provider) probing the loopback
 * tunnel endpoint WITH the session Cookie. `authority` is the remote gateway
 * host:port the tunnel presents in the Host header (design 17 §9.3 隧道 Host
 * 覆盖 — the gateway's request policy requires the authority port to equal
 * its listen port). */
async function verifyGatewayWithPasswordViaTunnel(
  spec: TransportInstanceSpec,
  endpoint: TransportProbeEndpoint,
  password: string,
  authority: string | undefined,
  token: string | null,
): Promise<TransportVerifyResult> {
  return verifyGatewayPasswordSession(tunnelSessionOrigin(spec, endpoint, authority), password, cookie =>
    verifyGatewayEndpointViaTunnel(endpoint, token, VERIFY_UP_TIMEOUT_MS, VERIFY_UP_MAX_BODY_BYTES, cookie, authority),
  token === null ? undefined : () =>
    verifyGatewayEndpointViaTunnel(endpoint, token, VERIFY_UP_TIMEOUT_MS, VERIFY_UP_MAX_BODY_BYTES, null, authority))
}

/**
 * One-shot RPC liveness probe of a chamber host Remote over the tunnel
 * endpoint (the exact wire shape the renderer's module-C boot uses, design
 * 09 §3.5 / design 08 §11.6). Shared by probeClientGraphLive (module A:
 * `clientGraph/graph`) and probeGitWorktreeLive (the git-worktree host
 * package: `gitWorktree/previewCreate`). File presence alone (the
 * `installed`/`patched` probe) cannot distinguish "booted after the
 * injection" from "restart still pending" — this answers the
 * plugin-management UI's "已生效 vs 重启后生效" question per package.
 *
 * Same discipline as verifyDshEndpoint: a destination that ANSWERED the
 * probe is classified deterministically; a destination that did not answer
 * (or an unreadable/garbage body) is 'unknown' — never a guessed claim.
 *
 * Classification (honest, three states):
 *   'live'     — HTTP 200 with a server-response envelope whose result.ok is
 *                true: the running instance resolved the method. For
 *                gitWorktree/previewCreate a domain rejection (invalid-input
 *                on the empty probe input) rides INSIDE result.ok:true — the
 *                row being loaded is exactly what the probe detects, and no
 *                git work is performed (input validation fails first).
 *   'not-live' — HTTP 404 (the dsh gateway routes only claimed Remote
 *                namespaces — a plain 404 on a ready instance deterministically
 *                means the boot row did not load: injected, restart pending)
 *                or a server-response envelope with result.ok !== true (the
 *                gateway answered but the method is not resolvable).
 *   'unknown'  — anything else (non-404 non-200, malformed/missing envelope,
 *                timeout, connection failure, oversized body): the probe
 *                cannot classify — never 'live'/'not-live' from a non-answer.
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
    // The client-request envelope is single-sourced in rpc-envelope.ts
    // (consumed through control-plane-module.ts) — the exact wire shape the
    // renderer's module-C boot uses (design 09 §3.5).
    envelope: buildClientRequest(rpcId, method, { args }),
    timeoutMs,
    maxBodyBytes,
  })
  // No answer (timeout / connection failure / premature close): never a
  // claimed 'live'/'not-live' from a non-answer.
  if (outcome.status === null) return 'unknown'
  if (outcome.status !== 200) {
    // The dsh gateway routes only claimed Remote namespaces (vendored
    // gateway test: an unclaimed route answers 404) — on a ready instance
    // that is deterministic "not loaded yet", never an unclassifiable answer.
    return outcome.status === 404 ? 'not-live' : 'unknown'
  }
  // Oversized body: not an RPC envelope — unclassifiable, never a claim.
  if (outcome.oversized) return 'unknown'
  const parsed = parseServerResponse(outcome.body, rpcId)
  if (parsed.kind !== 'ok') return 'unknown'
  // Any well-formed server-response envelope is a deterministic answer:
  // ok:true → the remote resolved the method; anything else (error envelope
  // for an unresolved method) → not loaded yet.
  return parsed.envelope.result.ok === true ? 'live' : 'not-live'
}

/**
 * Live-effect probe of module A (design 09 module A): POST the
 * `clientGraph/graph` RPC — the exact wire call the renderer's module C boot
 * merge performs (renderer/src/host-graph.ts) — directly to the tunnel
 * endpoint, answering whether the RUNNING remote dsh instance has actually
 * loaded the seeded `@dsh-chamber/dsh-host-client-graph` module.
 */
export function probeClientGraphLive(
  endpoint: { host: string; port: number },
  timeoutMs = CLIENT_GRAPH_PROBE_TIMEOUT_MS,
  maxBodyBytes = CLIENT_GRAPH_PROBE_MAX_BODY_BYTES,
): Promise<LiveProbeResult> {
  return probeRemoteMethod(endpoint, 'clientGraph/graph', {}, timeoutMs, maxBodyBytes)
}

/** Timeout of the one-shot git-worktree liveness probe (probeGitWorktreeLive). */
export const GIT_WORKTREE_PROBE_TIMEOUT_MS = 5_000

/** Response-body cap of the git-worktree liveness probe (an oversized answer
 *  is not an RPC envelope; bounded memory on a misbehaving endpoint). */
export const GIT_WORKTREE_PROBE_MAX_BODY_BYTES = 1024 * 1024

/**
 * Live-effect probe of the chamber git-worktree host package (design 08
 * §11.6): POST `gitWorktree/previewCreate` with an EMPTY input to the tunnel
 * endpoint. The dsh gateway routes only claimed Remote namespaces, so:
 *   - 404 → the running instance never loaded the git-worktree boot row —
 *     injected, restart pending (the exact case a host-graph-live probe
 *     misses: host-graph can be live from an older boot while the newer
 *     git-worktree row still awaits the restart that seeded it);
 *   - 200 → the gateway resolved the method; the empty input fails the
 *     domain validation FIRST (parsePreviewInput), before any git call, and
 *     the rejection rides inside result.ok:true — cheap, no repo scan.
 */
export function probeGitWorktreeLive(
  endpoint: { host: string; port: number },
  timeoutMs = GIT_WORKTREE_PROBE_TIMEOUT_MS,
  maxBodyBytes = GIT_WORKTREE_PROBE_MAX_BODY_BYTES,
): Promise<LiveProbeResult> {
  return probeRemoteMethod(endpoint, 'gitWorktree/previewCreate', { input: {} }, timeoutMs, maxBodyBytes)
}

/**
 * Instance spec validation (non-secret metadata only). id must match the
 * runtime whitelist (it rides /api/i/dsh-<id> / gateway-<id> path segments);
 * host/user must match the identifier whitelists and never start with '-' (a
 * leading '-' on the ssh command line would be parsed as an option —
 * option-injection guard, enforced here in core logic, not only in the UI).
 * serviceName is only type-checked here (string | null); the format whitelist
 * is enforced at exec time, where the value is actually placed on a command
 * line.
 *
 * v2 (design 17 §2): the ssh provider serves BOTH target kinds (`dsh` and
 * `gateway`) over the `ssh` transport only — a spec with transport 'http' is
 * refused (the direct-endpoint semantics belong to gateway-provider.ts), and
 * insecureHttp is meaningless for a loopback tunnel (normalized to false).
 * The provider's kind dimension (design 17 §2.1) is decided by the spec.
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
    // S23 pins apply only to direct gateway HTTPS. Silently dropping a pin
    // from an SSH spec would claim protection the tunnel provider never uses.
    && (record.spkiPin === undefined || record.spkiPin === null)
}

/**
 * The registry id whitelist lives in transport-provider.ts (single source);
 * it is enforced here as part of the ssh spec check: id must be a plain
 * identifier and must not collide with the reserved 'local' source id.
 */

/**
 * Per-instance SSH passwords (design 05 §8, user decision 2026-08 —
 * plaintext-file fallback): entered in the connections form, forwarded over
 * IPC, held in main-process memory AND mirrored to a plaintext file at
 * `<userData>/ssh-passwords.json` (0600, atomic write) so auto-connect works
 * after a restart. Never written to the registry (ssh-instances.json stays
 * non-secret metadata), never logged, never exposed back to the renderer.
 * Each entry carries its exact authentication owner (id/host/user/sshPort).
 * Every ssh spawn compares that owner to the current authoritative spec, so
 * two separately atomic files cannot redirect an old credential if the app
 * crashes between their commits. The entry is dropped on instance removal
 * and on explicit clear; app quit leaves the file in place by design.
 */
const passwords = new Map<string, string>()
const passwordBindings = new Map<string, string>()

/** The plaintext persistence mirror path; null = memory-only (tests, or a
 * platform without persistence). Configured once at startup. */
let passwordFile: string | null = null
let passwordSpecResolver: ((id: string) => TransportInstanceSpec | null) | null = null

/** One helper generation leased by one or more live ssh children. */
interface AskpassGeneration {
  path: string
  leases: number
}

/**
 * id → every helper generation still referenced by an actual ssh child.
 * Each spawn gets a fresh helper so a password change cannot affect an
 * already-built environment. Unlike the historical fixed retired-generation
 * cap, cleanup is driven solely by child lifecycle: no amount of concurrent
 * tunnel/systemd/run work can delete a path another child still references.
 */
const askpassHelpers = new Map<string, Set<AskpassGeneration>>()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function preserveInvalidPasswordFile(file: string): string {
  const corruptPath = `${file}.corrupt`
  try {
    renameSync(file, corruptPath)
    return `invalid password file preserved at ${corruptPath}`
  } catch (error) {
    return `invalid password file at ${file}; preserve failed: ${String(error)}`
  }
}

function preserveUnboundPasswordFile(file: string): string {
  const stem = `${file}.unbound-${Date.now()}-${process.pid}`
  let unboundPath = stem
  for (let index = 1; existsSync(unboundPath); index += 1) unboundPath = `${stem}-${index}`
  try {
    renameSync(file, unboundPath)
    return `legacy SSH password file has no endpoint bindings and was preserved at ${unboundPath}; re-enter passwords to use them`
  } catch (error) {
    return `legacy SSH password file at ${file} has no endpoint bindings and is disabled; preserve failed: ${String(error)}`
  }
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

/**
 * Point the password store at its persistence file (main.ts, once at
 * startup) and load existing entries. Missing file = empty set (first run).
 * A corrupt file fails LOUDLY — preserved as `<file>.corrupt` and reported
 * through the return value — never silently treated as empty (the registry's
 * corrupt-file discipline). Passing null keeps the store memory-only. The
 * return value is a loud notice string (corrupt-preserved path) or null.
 */
export function configureSshPasswordStore(
  file: string | null,
  resolveSpec?: (id: string) => TransportInstanceSpec | null,
): string | null {
  passwordFile = file
  passwordSpecResolver = resolveSpec ?? null
  passwords.clear()
  passwordBindings.clear()
  if (file === null) return null
  let text: string
  try {
    text = readOwnerOnlySecretFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Unreadable for another reason (permissions…): loud, non-fatal — the
    // app starts and password hosts fail auth until the user re-enters.
    return `cannot read ${file}: ${String(error)}`
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return preserveInvalidPasswordFile(file)
  }
  if (!isPlainRecord(parsed) || !isPlainRecord(parsed.passwords)) {
    return preserveInvalidPasswordFile(file)
  }
  const entries = Object.entries(parsed.passwords)
  if (parsed.schemaVersion === 1) {
    // A non-empty legacy file cannot be bound safely from the current
    // registry: it may be the new-target half of a pre-registry crash. Never
    // guess. Preserve it for manual recovery and require explicit re-entry.
    if (entries.length > 0) return preserveUnboundPasswordFile(file)
    persistSshPasswords(new Map(), new Map())
    return null
  }
  // The main lifecycle branch previously shipped schema v2 with endpoint
  // ownership embedded beside each password. That shape is already safely
  // bound, so convert it in-place to the fingerprint representation instead
  // of disabling credentials or guessing from the current registry.
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
    return preserveInvalidPasswordFile(file)
  }
  if (entries.some(([id, value]) => id === 'local'
    || !INSTANCE_ID_PATTERN.test(id)
    || typeof value !== 'string'
    || value === ''
    || value.length > MAX_SSH_PASSWORD_CHARS)) {
    return preserveInvalidPasswordFile(file)
  }
  const bindingEntries = Object.entries(parsed.bindings)
  if (bindingEntries.length !== entries.length
    || bindingEntries.some(([id, binding]) => !Object.hasOwn(parsed.passwords as Record<string, unknown>, id) || !isCredentialBinding(binding))) {
    return preserveInvalidPasswordFile(file)
  }
  for (const [id, value] of entries) passwords.set(id, value as string)
  for (const [id, binding] of bindingEntries) passwordBindings.set(id, binding as string)
  return null
}

/** Set or clear the password for one instance (null/'' = clear). Persists
 * the plaintext mirror when configured. A non-empty durable value must carry
 * the exact current SSH endpoint binding. */
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
  // Kind-agnostic instance deletion clears both credential stores. A gateway
  // id with no SSH password must not force an unnecessary password-file write.
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
  // Write-through commit: the live auth state changes only after its durable
  // mirror succeeds, so a reported persistence failure cannot leave a secret
  // active in memory but absent on disk (or vice versa).
  persistSshPasswords(next, nextBindings)
  passwords.clear()
  for (const [entryId, entryPassword] of next) passwords.set(entryId, entryPassword)
  passwordBindings.clear()
  for (const [entryId, binding] of nextBindings) passwordBindings.set(entryId, binding)
  if (password === null || password === '') {
    // Cleanup begins only after the durable clear commits. A live ssh child
    // still owns its leased path until exit/error; new spawns can no longer
    // acquire a password-backed helper.
    purgeSshAuth(id)
  }
}

/** The stored password for the exact current SSH endpoint, or null. Passing a
 * spec performs the last-moment binding comparison used before every spawn;
 * id-only callers resolve the authoritative registry spec configured by main. */
export function getSshPassword(idOrSpec: string | TransportInstanceSpec): string | null {
  const id = typeof idOrSpec === 'string' ? idOrSpec : idOrSpec.id
  const password = passwords.get(id)
  if (password === undefined) return null
  const binding = passwordBindings.get(id)
  // Memory-only tests retain the historical id-keyed behavior. Every durable
  // production value has a binding and is invisible until the current
  // registry spec matches it exactly.
  if (binding === undefined) return passwordFile === null ? password : null
  const current = typeof idOrSpec === 'string' ? (passwordSpecResolver?.(id) ?? null) : idOrSpec
  return current !== null && sshCredentialBinding(current) === binding ? password : null
}

/**
 * Mirror the in-memory map to the plaintext file (design 05 §8): write
 * `.tmp` with mode 0600 → fsync → rename (the repo's atomic-write
 * convention — the rename keeps the tmp file's 0600 mode). Empty maps still
 * write an empty file; the file is only created on the first set/clear.
 */
function persistSshPasswords(next: ReadonlyMap<string, string>, nextBindings: ReadonlyMap<string, string>): void {
  if (passwordFile === null) return
  const payload = `${JSON.stringify({
    schemaVersion: 2,
    passwords: Object.fromEntries(next),
    bindings: Object.fromEntries(nextBindings),
  }, undefined, 2)}\n`
  const tmpPath = `${passwordFile}.tmp`
  mkdirSync(dirname(passwordFile), { recursive: true })
  try {
    const fd = openSync(tmpPath, 'w', 0o600)
    try {
      // open(..., mode) only applies the mode when the file is created. A
      // pre-existing tmp file (for example after a hard crash) may be wider,
      // so force owner-only permissions before writing any secret bytes.
      fchmodSync(fd, 0o600)
      writeSync(fd, payload)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, passwordFile)
  } catch (error) {
    // A failed atomic replace must not strand an extra plaintext secret.
    try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/**
 * Is password auth viable on this platform? Win32-OpenSSH's askpass
 * handling is not reliable (the helper must be a PE executable; .cmd/.sh
 * are not), so the IPC gate refuses storing a password on Windows — keys /
 * ssh-agent remain the universal path there.
 */
export function sshPasswordSupported(): boolean {
  return process.platform !== 'win32'
}

/**
 * The ephemeral askpass helper body (design 05 §8): a sh script that
 * answers ssh's non-TTY prompts — host-key confirmations with `yes` (so a
 * first connect to a new host works), password/passphrase prompts with the
 * stored password, and EVERYTHING ELSE with NO answer (fail-closed): a
 * prompt that is not provably a credential prompt (OTP/verification-code,
 * password-change, unknown host-key wording) must never receive the
 * password. ssh passes the prompt text as argv[1] and reads the answer
 * from stdout; prompts are matched textually, not by position, so
 * reordered prompt strings stay covered.
 */
export function buildAskpassScript(password: string): string {
  const escaped = password.replace(/'/g, `'\\''`)
  return [
    '#!/bin/sh',
    '# dsh-chamber ssh password helper (ephemeral, 0700, deleted after child exit)',
    // Normalize the prompt to lowercase ONCE (tr is POSIX, present on the
    // local macOS/Linux host): every pattern below matches the NORMALIZED
    // text, so all branches are case-insensitive for any casing variant
    // ("Password:", "PASSWORD:", "One-time Password:", "ONE-TIME PASSWORD:"
    // …). Non-ASCII text passes through unchanged (patterns are ASCII).
    // 2026-11 round-2 review: a per-word bracket-expression approach only
    // covered the first character and leaked the password for
    // "One-time Password:" — normalization fixes the whole matrix.
    'case "$(printf "%s" "$1" | tr "A-Z" "a-z")" in',
    '  *"yes/no"*|*"fingerprint"*|*"authenticity"*|*"continue connecting"*)',
    '    echo yes',
    '    ;;',
    // Explicit non-credential exclusions BEFORE the password branch: prompts
    // whose wording also contains "password:" (OTP/verification-code,
    // password change) must never receive the stored password (fail-closed,
    // 2026-11 reviews — "One-time Password:" would otherwise match below).
    // The otp match is boundary-scoped (colon or space) so a host/user name
    // like "otp-host" cannot shadow a real password prompt.
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

/**
 * Fail-closed ownership/type/mode gate for an askpass directory. A helper is
 * password-bearing executable code: merely attempting chmod on a directory
 * pre-created by another OS user is not enough, and EPERM must never degrade
 * into continuing inside that untrusted directory. The before/after inode
 * check detects replacement around chmod; standard sticky temp-directory
 * semantics then prevent a different OS user from swapping our owned leaf.
 */
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

/** Create one unguessable process-private leaf. We never reuse the historical
 * global `<tmpdir>/dsh-chamber-ssh`, so another OS user cannot pre-claim the
 * directory in which password-bearing executables are published. */
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
  // The id lands in the temp filename — refuse anything outside the registry
  // whitelist (defense in depth; the IPC gate already enforces this before a
  // password can be stored).
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing askpass helper for invalid instance id ${JSON.stringify(id)}`)
  }
  const dir = privateAskpassDir()
  // Include the owner PID so startup cleanup can distinguish crash leftovers
  // from a simultaneously running dev/packaged chamber process.
  const path = join(dir, `askpass-${id}.pid-${process.pid}.${randomUUID()}.sh`)
  try {
    // Keep a partially written helper non-executable, then publish it as an
    // owner-only executable. The explicit chmod also defeats a restrictive
    // process umask that would otherwise strip the owner execute bit.
    // O_EXCL prevents even a same-name collision from replacing a file. Keep
    // it non-executable until the complete script is durable, then publish the
    // exact owner-only executable mode on the already-open inode.
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
    // Never strand an untracked password-bearing helper after a failed write
    // or chmod; callers cannot dispose a path that was never returned.
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
        // Cross-user/pre-claimed directories are reported and skipped. They
        // are never used by privateAskpassDir and we never mutate their files.
        chmodAskpassDirOwnerOnly(dir)
      } catch (error) {
        notices.push(`refused untrusted SSH askpass directory ${dir}: ${String(error)}`)
        continue
      }
      for (const name of readdirSync(dir)) {
        const current = /^askpass-[a-zA-Z0-9_-]{1,64}\.pid-(\d+)\.[0-9a-f-]+\.sh$/i.exec(name)
        // Legacy names predate PID ownership and can only be crash leftovers:
        // every normal shutdown already deletes them.
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
          // EPERM means a live process we may not signal; only ESRCH proves the
          // owner is gone and makes deletion safe.
          ownerAlive = (probeError as NodeJS.ErrnoException).code !== 'ESRCH'
        }
        if (!ownerAlive) rmSync(join(dir, name), { force: true })
      }
      // Reclaim an empty crash directory, but keep this process's private leaf
      // stable for later helpers.
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
 * Acquire the askpass environment for exactly one ssh spawn (tunnel,
 * systemd, or run). Null means key/agent auth. The returned helper is fresh
 * for this spawn and remains on disk until the idempotent lease release;
 * disconnect/removal/password-clear may request cleanup, but the live child
 * lease remains authoritative and none can invalidate its SSH_ASKPASS path.
 */
export function acquireSshAuthLease(spec: TransportInstanceSpec): TransportSpawnLease | null {
  if (!sshPasswordSupported()) return null
  // The password file and instance registry are separately atomic. Compare
  // the persisted owner at the last possible moment so a crash between their
  // commits can only disable password auth, never send an old secret to the
  // new endpoint behind the same id.
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

/**
 * Handle a plain transport-stop cleanup request without deleting any
 * generation leased by a tunnel or an in-flight exec. Every generation is
 * single-spawn and removes itself as soon as that child terminates.
 */
export function disposeSshAuth(spec: TransportInstanceSpec): void {
  const generations = askpassHelpers.get(spec.id)
  if (generations === undefined) return
  // Normally every tracked generation has a live lease. Keep the defensive
  // zero-count sweep so a future multi-retain implementation cannot strand
  // an already-unreferenced helper at disconnect.
  for (const generation of generations) {
    if (generation.leases !== 0) continue
    deleteAskpassHelper(generation.path)
    generations.delete(generation)
  }
  if (generations.size === 0) askpassHelpers.delete(spec.id)
}

/**
 * Request final cleanup for instance removal / explicit password clear.
 * A live child remains authoritative: its helper is deleted only when its
 * lease releases. The cleared credential (or removed registry entry) blocks
 * legitimate future acquisition; crash leftovers are reclaimed at startup.
 */
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
      // v2 (design 17 §2.1): the provider serves both target kinds over the
      // ssh transport — the spec's kind is preserved (default dsh).
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
    // SSH-level keepalive (SERVER_ALIVE_*): a dead/half-open connection makes
    // ssh exit on its own within interval * countMax (~90s), feeding the
    // runtime's reconnect machinery; periodic probes also refresh NAT/firewall
    // mappings that TCP keepalives cannot reach.
    const keepaliveArgs = ['-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`, '-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`]
    return spec.sshPort === null
      ? ['-N', ...keepaliveArgs, '-L', `${localPort}:127.0.0.1:${spec.remotePort}`, target]
      : ['-N', ...keepaliveArgs, '-p', String(spec.sshPort), '-L', `${localPort}:127.0.0.1:${spec.remotePort}`, target]
  },

  /**
   * Password auth (design 05 §8): when a password is stored for this
   * instance, return the askpass env so the tunnel spawn delivers it to ssh
   * without a TTY or the command line. Null = key/agent auth (the universal
   * default) or an unsupported platform.
   */
  buildStartEnv(spec: TransportInstanceSpec): TransportSpawnLease | null {
    return acquireSshAuthLease(spec)
  },

  /**
   * Process an askpass cleanup request (transport stop / removal / app quit)
   * without deleting any child-leased generation (see disposeSshAuth). The
   * password itself survives disconnect and app quit: its bound persistent
   * mirror is intentionally reloaded on the next startup. Only an explicit
   * clear or the main-owned save/delete transaction removes it.
   */
  disposeAuth(spec: TransportInstanceSpec): void {
    disposeSshAuth(spec)
  },

  /**
   * Request final askpass helper cleanup — called by the runtime ONLY on
   * instance removal (never on a plain disconnect). Live child leases still
   * win and remove their own paths at termination (see purgeSshAuth).
   */
  purgeAuth(spec: TransportInstanceSpec): void {
    purgeSshAuth(spec.id)
  },

  classifyStderr(line: string) {
    const log = redactSshStderr(line).trimEnd()
    // Both classifications run on the RAW line, never the redacted view:
    // redaction (a `.ssh*`-named home path, design 13 §7.2) replaces the
    // whole line, and the signals the `run` channel relies on — terminal
    // auth (→ loud result) and ENOENT (→ absent file) — must survive it.
    const terminalAuth = AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(line))
    const enoent = ENOENT_PATTERN.test(line)
    return { log, terminalAuth, enoent }
  },

  /**
   * Endpoint identity verification (design 17 §9.2 / design 18 §9.3): the
   * tunnel destination must answer the target-kind identity before the runtime
   * may declare it ready — a non-target service never presents as a fake
   * connection. The probe semantics branch on the
   * TARGET kind:
   * - kind 'dsh': NEVER carries auth headers (design 17 §2.1) — plain
   *   verifyDshEndpoint over the loopback tunnel endpoint;
   * - kind 'gateway': the authenticated gateway-owned runtime status marker
   *   proves the gateway boundary independently of managed-dsh health, keeping
   *   recovery actions reachable. A stored bearer token rides the probe as Authorization;
   *   a MISSING token is no pre-flight refusal — the probe goes out without
   *   a header and the gateway's own answer is classified (a `--no-auth`
   *   deployment is ready; an auth-requiring deployment answers 401
   *   terminal, design 17 §2.3/§7.3). No token + a stored password + wired
   *   session hooks (configureGatewaySessionProvider, main.ts) rides the
   *   SHARED password-session flow instead (verifyGatewayPasswordSession,
   *   gateway-provider.ts): ensure a login session keyed to the TUNNEL
   *   endpoint origin, probe WITH its Cookie, and on a rejected 401
   *   invalidate + re-login exactly once before the terminal password-
   *   refused state (§9.3 — the gateway-over-ssh + password-only form shape,
   *   S1 gap fixed here).
   */
  verifyUp(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint) {
    if (spec.kind === 'gateway') {
      // Tunnel Host override (design 17 §9.3 隧道 Host 覆盖): every request
      // through the tunnel presents the remote LOOPBACK destination authority
      // — never spec.host, which may only be an SSH alias. The
      // gateway's request policy (authority port == listen port) rejects the
      // tunnel's local port otherwise (verified on the 172 实机: 421).
      const authority = gatewayTunnelAuthority(spec.remotePort)
      const token = getGatewayToken(spec.id)
      const password = getGatewayPassword(spec.id)
      // A configured password + wired session hooks: the login
      // session is keyed to the LOOPBACK tunnel origin (the only origin the
      // tunnel ever reaches) + exact connection/SSH-target scope; the remote
      // authority is only the Host the gateway sees. The probe carries its
      // Cookie plus the independent Bearer
      // when present. Without hooks, the token still probes normally and a
      // password-only target stays credential-free (the inert default).
      if (password !== null && getGatewaySessionHooks().ensureSession !== undefined) {
        return verifyGatewayWithPasswordViaTunnel(spec, endpoint, password, authority, token)
      }
      return verifyGatewayEndpointViaTunnel(endpoint, token, VERIFY_UP_TIMEOUT_MS, VERIFY_UP_MAX_BODY_BYTES, null, authority)
    }
    return verifyDshEndpoint(endpoint)
  },

  exec(spec: TransportInstanceSpec, action: TransportExecAction, deps: TransportExecDeps, payload?: TransportRunPayload): Promise<TransportExecResult> {
    return runExec(spec, action, deps, payload)
  },
}

/**
 * One remote systemd exec (design 02 §3.9): `ssh user@host systemctl
 * <action> -- <serviceName>`, argument-array spawn (no shell), serviceName
 * whitelist-checked BEFORE anything spawns and separated from systemctl
 * options by `--` (defense in depth; a name that fails is refused with a log
 * entry and an error result). Failures are
 * loud: logged to the instance ring buffer and returned as an error
 * result, never swallowed. Auth failures (AUTH_FAILURE_PATTERNS) surface
 * through the result error only — the exec channel NEVER writes the
 * tunnel state (requiresUserAction stays the tunnel's own terminal
 * classification, so a routine tunnel drop after a failed exec is never
 * mislabeled terminal). Execs are never auto-retried.
 * Timeout (execTimeoutMs) SIGTERMs the ssh process (SIGKILL after the
 * disconnect grace) and resolves as an error. The exec spawns its own
 * short-lived ssh process and never touches the tunnel child. Results are
 * written to the projection's serviceActive on-demand (no polling).
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
  return new Promise(resolve => {
    let settled = false
    let timedOut = false
    let authFailed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const finish = (result: TransportExecResult) => {
      if (settled) return
      settled = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (killTimer !== null) {
        clearTimeout(killTimer)
        killTimer = null
      }
      resolve(result)
    }
    let child: SpawnedProcess
    const spawnOptions: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] }
    // Password auth (design 05 §8): the exec spawn gets the same askpass env
    // as the tunnel — a password-only host must answer `systemctl` over ssh
    // just like the tunnel connects. Null = key/agent auth, no env merge.
    const authLease = acquireSshAuthLease(spec)
    if (authLease !== null) spawnOptions.env = { ...process.env, ...authLease.env }
    try {
      child = deps.spawnFn('ssh', args, spawnOptions)
    } catch (spawnError) {
      authLease?.release()
      deps.log('error', `failed to spawn ssh for systemctl ${action}: ${String(spawnError)}`)
      finish({ ok: false, error: `failed to spawn ssh: ${String(spawnError)}` })
      return
    }
    if (authLease !== null) {
      child.on('error', () => authLease.release())
      child.on('exit', () => authLease.release())
    }
    timer = setTimeout(() => {
      timedOut = true
      deps.log('error', `systemctl ${action} ${spec.serviceName} timed out after ${deps.execTimeoutMs}ms`)
      signalChild(child, 'SIGTERM')
      finish({ ok: false, error: `systemctl ${action} timed out after ${deps.execTimeoutMs}ms` })
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), deps.disconnectGraceMs)
      killTimer.unref?.()
    }, deps.execTimeoutMs)
    timer.unref?.()
    // Line-buffered stderr, mirroring the tunnel channel: redaction and
    // auth detection run on complete lines, never on arbitrary chunks.
    const processStderr = createBoundedLineProcessor(
      line => {
        const { log, terminalAuth } = sshProvider.classifyStderr(line)
        if (log === '') return
        deps.log('info', log)
        if (terminalAuth) {
          authFailed = true
          deps.log('error', 'authentication failure detected (requires user action)')
        }
      },
      () => deps.log('error', `ssh output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`),
    )
    const processStdout = createBoundedLineProcessor(
      line => {
        const redacted = redactSshStderr(line)
        if (redacted !== '') deps.log('info', redacted)
      },
      () => deps.log('error', `ssh output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`),
    )
    if (child.stdout !== null) {
      child.stdout.on('data', chunk => processStdout(String(chunk)))
    }
    if (child.stderr !== null) {
      child.stderr.on('data', chunk => processStderr(String(chunk)))
    }
    child.on('error', error => {
      // Spawn failure (e.g. the ssh binary is missing): loud result, never
      // swallowed; the tunnel's terminal classification stays untouched.
      deps.log('error', `ssh spawn error for systemctl ${action}: ${String(error)}`)
      finish({ ok: false, error: `failed to spawn ssh: ${String(error)}` })
    })
    child.on('exit', (code, exitSignal) => {
      if (timedOut || settled) return
      processStdout('\n')
      processStderr('\n')
      if (authFailed) {
        finish({ ok: false, error: 'authentication failure — requires user action' })
        return
      }
      if (code === 0) {
        if (action === 'is-active') {
          deps.setProjection(spec.id, 'serviceActive', true)
          deps.log('info', `systemctl is-active ${spec.serviceName}: active`)
        } else if (action === 'restart') {
          // restart: honest "restarted" — never touches serviceActive (the
          // unit's prior state is unchanged; restart does not define it).
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
        // Honest is-active classification — a failure is never "inactive":
        //  - exit 0: active (handled above);
        //  - exit 4: no such unit — the service name is wrong (or the unit
        //    was removed): an explicit error, and serviceActive falls back
        //    to null so a stale "active" never lingers beside the error;
        //  - exit 255 / signal death: the ssh exec itself failed (host
        //    unreachable, process killed) — NOT a unit state;
        //  - any other non-zero (e.g. 1/3: inactive/failed): a valid answer,
        //    the unit exists but is not active.
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
    })
  })
}

/**
 * Build the ssh argv (everything after `ssh`) for a `run` exec, or null when
 * the command/argv fail the design 13 §7.2 whitelist (refused BEFORE spawn).
 * ssh concatenates these into one string for the REMOTE shell, so every
 * argument must be shell-safe.
 */
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
    // `add` accepts the registry spec (design 13 §7.2) OR the main-process
    // materialize `file:` absolute-tarball form (design 13 §4.6,
    // MATERIALIZE_FILE_SPEC_PATTERN — renderer input can never reach this
    // branch: applyPlugins re-validates against PLUGIN_SPEC_PATTERN, which
    // refuses `file:`); `remove` is name-only.
    const ok = specArg.length <= MAX_PLUGIN_SPEC_CHARS && (argv[3] === 'add'
      ? PLUGIN_SPEC_PATTERN.test(specArg) || MATERIALIZE_FILE_SPEC_PATTERN.test(specArg)
      : PLUGIN_NAME_PATTERN.test(specArg))
    if (!ok) return null
    return [...prefix, 'dsh', ...argv]
  }
  if (payload.command === 'cat') {
    if (argv.length !== 1 || typeof argv[0] !== 'string') return null
    const home = spec.remoteDshHome ?? '~/.dsh'
    // Whitelisted cat targets: the profile manifest + patch file, plus the
    // CONVERGED seed subtree `<home>/profiles/node_modules/@dsh-chamber/<pkg>/<file>`
    // — the same fixed surface resolveWriteTarget allows writes into, needed
    // by the seed hash-skip read-back (design 13 §4.6). No wildcards, no
    // `.`/`..` traversal (shared SEED_RELATIVE_PATTERN).
    const seedPrefix = `${home}/profiles/node_modules/@dsh-chamber/`
    const isSeedRead = argv[0].startsWith(seedPrefix)
      && argv[0].length > seedPrefix.length
      && SEED_RELATIVE_PATTERN.test(argv[0].slice(seedPrefix.length))
    if (argv[0] !== `${home}/profiles/web/package.json` && argv[0] !== `${home}/profiles/web/cordis.patch.yml` && !isSeedRead) return null
    // `LC_ALL=C` forces the REMOTE coreutils to emit English messages
    // regardless of the remote locale (a zh_CN-locale host would otherwise
    // print 没有那个文件或目录 for a missing file, which the ENOENT
    // classification would misread as a loud ssh failure — the general fix,
    // not a per-language whitelist). `LC_ALL=C` is a fixed literal env
    // assignment the remote shell applies to the cat command; `DSH_HOME`
    // (when set) already rides the same prefix chain.
    return [...prefix, 'LC_ALL=C', 'cat', argv[0]]
  }
  if (payload.command === 'printf') {
    // Remote `$HOME` lookup for the materialize `file:` absolute path (todo
    // 13 §4.6): a FIXED argv — `printf %s $HOME` — constructed here in the
    // main process only (never renderer input). `$HOME` is a literal the
    // REMOTE shell expands; the captured stdout is the remote user's home.
    // (`$` is normally refused on the command line; this single fixed
    // constant is the sanctioned exception, gated by the exact argv match.)
    if (argv.length !== 2 || argv[0] !== '%s' || argv[1] !== '$HOME') return null
    return ['printf', '%s', '$HOME']
  }
  return null
}

/**
 * A seed-subtree RELATIVE path (`@dsh-chamber/<pkg>/<file>` — the prefix is
 * stripped before this check): one or more `/`-joined segments, each starting
 * with an alphanumeric. Rejects `.`/`..` traversal segments and any other
 * empty/dot segment — shared by the write-file target whitelist and the cat
 * seed read-back whitelist so the seed surface stays converged on both sides.
 */
const SEED_RELATIVE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/

/**
 * Validate a write-file target against the fixed prefixes (design 13 §7.2):
 * the materialized-tarball dir, the seed dir, or the profile patch file.
 * Returns the target (with `~` left for the remote shell to expand) or null.
 */
export function resolveWriteTarget(spec: TransportInstanceSpec, path: string | undefined): string | null {
  if (typeof path !== 'string' || path === '') return null
  const home = spec.remoteDshHome ?? '~/.dsh'
  if (/^~\/\.dsh-chamber\/plugins\/[a-zA-Z0-9._-]+\.tgz$/.test(path)) return path
  const seedPrefix = `${home}/profiles/node_modules/@dsh-chamber/`
  if (path.startsWith(seedPrefix) && path.length > seedPrefix.length && SEED_RELATIVE_PATTERN.test(path.slice(seedPrefix.length))) return path
  if (path === `${home}/profiles/web/cordis.patch.yml`) return path
  return null
}

/**
 * Spawn one short-lived `ssh` run (design 13 §4.1) and drive it to completion:
 * bounded `run` timeout (SIGTERM → SIGKILL), stderr redaction + auth
 * classification, optional stdin write (write-file), and one bounded stdout
 * mode: capture for whitelisted reads or streaming SHA-256 for write-file
 * verification. Never auto-retried, never touches the tunnel's terminal
 * classification.
 */
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
  return new Promise<TransportExecResult & { stdoutSha256?: string }>(resolve => {
    let settled = false
    let timedOut = false
    let authFailed = false
    let enoentDetected = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const stdoutChunks: Buffer[] = []
    const stdoutHash = opts.stdoutMode === 'sha256' ? createHash('sha256') : null
    let stdoutBytes = 0
    const finish = (result: TransportExecResult & { stdoutSha256?: string }) => {
      if (settled) return
      settled = true
      if (timer !== null) { clearTimeout(timer); timer = null }
      if (killTimer !== null) { clearTimeout(killTimer); killTimer = null }
      resolve(result)
    }
    let child: SpawnedProcess
    const spawnOptions: SpawnOptions = { stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] }
    const authLease = acquireSshAuthLease(spec)
    if (authLease !== null) spawnOptions.env = { ...process.env, ...authLease.env }
    try {
      child = deps.spawnFn('ssh', args, spawnOptions)
    } catch (spawnError) {
      authLease?.release()
      deps.log('error', `failed to spawn ssh for run: ${String(spawnError)}`)
      finish({ ok: false, error: `failed to spawn ssh: ${String(spawnError)}` })
      return
    }
    if (authLease !== null) {
      child.on('error', () => authLease.release())
      child.on('exit', () => authLease.release())
    }
    if (opts.stdin !== undefined && child.stdin !== null) {
      child.stdin.write(opts.stdin)
      child.stdin.end()
    }
    timer = setTimeout(() => {
      timedOut = true
      deps.log('error', `run timed out after ${timeoutMs}ms`)
      signalChild(child, 'SIGTERM')
      finish({ ok: false, error: `run timed out after ${timeoutMs}ms` })
      killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), deps.disconnectGraceMs)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
    // Redacted stderr lines collected for the failure detail (never raw —
    // classifyStderr already applies redactSshStderr, so no key/password
    // material can ride the error string).
    let stderrDetail = ''
    const appendStderrDetail = (line: string) => {
      if (stderrDetail.length >= RUN_STDERR_DETAIL_MAX_CHARS) return
      const separator = stderrDetail === '' ? '' : ' | '
      const remaining = RUN_STDERR_DETAIL_MAX_CHARS - stderrDetail.length
      stderrDetail += `${separator}${line}`.slice(0, remaining)
    }
    const processStderr = createBoundedLineProcessor(
      line => {
        const { log, terminalAuth, enoent } = sshProvider.classifyStderr(line)
        if (log === '') return
        appendStderrDetail(log)
        // Quiet runs (expected-failure probes): the redacted stderr still
        // rides the failure detail, but the raw INFO echo is suppressed so
        // an expected ENOENT probe cannot pollute the instance log panel.
        if (opts.quiet !== true) deps.log('info', log)
        if (terminalAuth) {
          authFailed = true
          deps.log('error', 'authentication failure detected (requires user action)')
        }
        if (enoent) enoentDetected = true
      },
      () => {
        const summary = `ssh output line dropped: exceeds ${CHILD_LINE_MAX_CHARS} characters`
        appendStderrDetail(summary)
        if (opts.quiet !== true) deps.log('error', summary)
      },
    )
    if (child.stdout !== null) {
      child.stdout.on('data', chunk => {
        if (opts.stdoutMode === undefined || settled) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (stdoutBytes + bytes.length > RUN_STDOUT_MAX_BYTES) {
          deps.log('error', `run stdout exceeds the ${RUN_STDOUT_MAX_BYTES}-byte limit`)
          signalChild(child, 'SIGTERM')
          finish({ ok: false, error: `run stdout exceeds the ${RUN_STDOUT_MAX_BYTES}-byte limit` })
          killTimer = setTimeout(() => signalChild(child, 'SIGKILL'), deps.disconnectGraceMs)
          killTimer.unref?.()
          return
        }
        stdoutBytes += bytes.length
        if (opts.stdoutMode === 'capture') stdoutChunks.push(bytes)
        else stdoutHash!.update(bytes)
      })
    }
    if (child.stderr !== null) {
      child.stderr.on('data', chunk => processStderr(String(chunk)))
    }
    child.on('error', error => {
      deps.log('error', `ssh spawn error for run: ${String(error)}`)
      finish({ ok: false, error: `failed to spawn ssh: ${String(error)}` })
    })
    child.on('exit', (code, exitSignal) => {
      if (timedOut || settled) return
      processStderr('\n')
      if (authFailed) {
        finish({ ok: false, error: 'authentication failure — requires user action' })
        return
      }
      if (code !== 0) {
        // Run-class failures carry the redacted remote stderr text — the
        // `cat` ENOENT signal (`profile not initialized`, design 13 §4.3) among
        // others — bounded so a chatty remote never bloats the error. A QUIET
        // run (an expected-failure probe, e.g. the first-seed `cat` ENOENT) is
        // still an `ok:false` with the same error text — the caller's ENOENT
        // classification keeps working — but the ERROR-level log is skipped:
        // an expected probe failure must not pollute the instance log panel.
        let detail = stderrDetail
        // ENOENT is classified on the RAW stderr; a redacted detail may have
        // lost the signal (a `.ssh*`-named home path, design 13 §7.2, makes
        // redactSshStderr replace the whole line). Re-attach the marker so
        // the caller's ENOENT_PATTERN contract keeps classifying an absent
        // file as absent — never as a loud ssh failure — while the display
        // text still hides the path.
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
      // Whitelisted exec reads retain raw bytes plus their UTF-8 view. The
      // write-file path selects sha256 mode instead and never builds either
      // full-size representation.
      const capturedStdout = opts.stdoutMode === 'capture' ? Buffer.concat(stdoutChunks, stdoutBytes) : undefined
      finish({
        ok: true,
        status: projection,
        stdout: capturedStdout !== undefined ? capturedStdout.toString('utf8') : undefined,
        stdoutBytes: capturedStdout,
        stdoutSha256: stdoutHash?.digest('hex'),
      })
    })
  })
}

/**
 * The `run` exec dispatcher (design 13 §4.1): `exec` runs a whitelisted
 * remote command; `write-file` streams base64 content over ssh stdin to
 * `mkdir -p <dir> && base64 -d > <path>` and verifies SHA-256 by reading the
 * file back over `cat` (no platform-specific sha256sum).
 */
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
    // Size cap (design 13 §4.1: 50MiB suggested) — bounds the decoded payload
    // before any write, covering the seed and materialize orchestration
    // payloads that flow through write-file. Refused loudly, never truncated.
    // Pre-check the base64 length so an oversized payload is refused BEFORE
    // allocating its decoded buffer (base64 of N bytes is ≤ ⌈N/3⌉·4 chars).
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
    // Same `LC_ALL=C` discipline as the buildRemoteExecArgv cat branch: the
    // read-back verifies what was written, and its ENOENT/probe failures
    // must read English regardless of the remote locale.
    const readBack = await spawnRemote(spec, ['LC_ALL=C', 'cat', target], deps, {
      stdoutMode: 'sha256',
      quiet: payload.quiet === true,
    })
    if (!readBack.ok) return readBack
    // Byte-domain verification stays streaming: write-file may be 50 MiB,
    // so retaining chunks, concatenating a Buffer, and then decoding a UTF-8
    // copy would multiply main-process memory for data no caller consumes.
    if (readBack.stdoutSha256 !== payload.sha256.toLowerCase()) {
      return { ok: false, error: 'write-file verification failed: remote SHA-256 mismatch' }
    }
    return { ok: true, status: readBack.status }
  }
  return Promise.resolve({ ok: false, error: 'unknown run payload op' })
}

/** Best-effort kill (no-op when the process is already gone). */
function signalChild(child: SpawnedProcess | null, signal: NodeJS.Signals) {
  if (child === null) return
  try {
    child.kill(signal)
  } catch { /* already gone */ }
}
