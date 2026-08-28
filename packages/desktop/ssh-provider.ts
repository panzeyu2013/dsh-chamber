/**
 * The `ssh` transport provider (design 03 §2.2, transport-provider.ts):
 * everything source-specific about SSH tunnels and remote systemd exec,
 * packaged as a TransportProvider for the generic runtime.
 *
 * - Tunnels via the system `ssh` binary:
 *   `ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 [-p <sshPort>]
 *   -L <localPort>:127.0.0.1:<remotePort> <user@host>` — SSH-level keepalive
 *   (a dead/half-open connection makes ssh exit on its own within ~90s,
 *   which feeds the runtime's reconnect machinery, and the probes keep NAT
 *   mappings alive).
 * - systemctl exec (design 02 §3.9): `ssh user@host systemctl
 *   start|stop|is-active <serviceName>` — argument-array spawn (no shell),
 *   serviceName whitelisted `^(?!-)[a-zA-Z0-9_.:@-]+$` before anything runs
 *   (injection guard), bounded timeout, failures loud. Auth failures surface
 *   through the result error only — the exec channel never writes the tunnel
 *   state (a later routine drop is never mislabeled terminal). is-active is
 *   classified honestly from the exit code: 0 active, 4 = no such unit
 *   (explicit error, serviceActive falls back to null), 255/signal death =
 *   ssh exec failure (explicit error, never "inactive"), anything else =
 *   inactive — a failed exec must never masquerade as a stopped service.
 * - Endpoint identity verification (verifyUp): the tunnel destination must
 *   answer the dsh host.describe wire handshake before the runtime may
 *   declare the instance ready — a non-dsh service on the destination port
 *   never presents as a fake connection (same criterion as the local
 *   instance's readiness, design 02 §3.2).
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
 *   the stored value, deleted on transport stop). Platform note:
 *   Win32-OpenSSH askpass support is not reliable, so password auth is
 *   refused at the IPC gate on Windows (keys/agent remain the universal
 *   path).
 */

import type { SpawnOptions } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { chmodSync, closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
// The dsh RPC wire envelope is single-sourced in control-plane
// (rpc-envelope.ts, A2 cross-package protocol single-sourcing) — consumed
// through control-plane-module.ts (the desktop dual-path facade: packaged →
// compiled dist/control-plane, dev → workspace source). The envelope shape
// can never drift from the control-plane unary client's.
import { buildClientRequest, mintRpcId, parseServerResponse, postClientRequest } from './control-plane-module.ts'
import { INSTANCE_ID_PATTERN, MAX_INSTANCE_LABEL_CHARS } from './transport-provider.ts'
import { CHILD_LINE_MAX_CHARS, createBoundedLineProcessor } from './bounded-lines.ts'
import type {
  SpawnedProcess,
  TransportExecAction,
  TransportExecDeps,
  TransportExecResult,
  TransportInstanceSpec,
  TransportProbeEndpoint,
  TransportProvider,
  TransportRunPayload,
  TransportVerifyResult,
} from './transport-provider.ts'

/**
 * Registry metadata whitelists (design 03 §2.2 / 05 §8). id lands in
 * /api/i/ssh-<id> path segments and transport keys; host/user are placed on
 * the ssh command line as the connection target — a leading '-' would be
 * parsed as an ssh option by getopt (e.g. -oProxyCommand=... → arbitrary
 * command execution), so host/user must never start with '-' (enforced by
 * the character class: the first character is never '-'). host allows
 * dots/hyphens (hostnames) and [ ] for bracketed IPv6 literals; user allows
 * dots/underscores/hyphens. id additionally reserves 'local' (the
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
// `@` (template instances) and `:` are valid, shell-safe systemd unit-name
// characters. Backslash escapes remain out because OpenSSH joins the remote
// argv through a shell; a leading '-' remains an option-injection shape.
export const SERVICE_NAME_PATTERN = /^(?!-)[a-zA-Z0-9_.:@-]+$/

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
export const MAX_PLUGIN_SPEC_CHARS = 512

/**
 * Package spec whitelist (design 13 §7.2): registry name (+ optional scope)
 * with an optional `@version` (exact / `^`range / `~`range / dist-tag). The
 * character class is deliberately shell-safe — NO `| < > *` space quotes `$`
 * `; & ( )` backtick — because ssh hands the argument to the REMOTE shell
 * verbatim. Ranges (`>=1.2.3 <2`), `||`, wildcards, `npm:` aliases, `git+` /
 * URL specs and `file:`/`link:`/relative paths are all REFUSED here (they are
 * injection surface, or are materialized via a separate path, design 13 §4.6).
 */
export const PLUGIN_SPEC_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*(@(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next))?$/

/** Name-only form for `dsh plugin remove <name>`. */
export const PLUGIN_NAME_PATTERN = /^(@[a-zA-Z0-9][a-zA-Z0-9._-]*\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/**
 * The materialize-add `file:` spec whitelist (design 13 §4.6 / §7.2): only the
 * ABSOLUTE form of the materialized-tarball stable dir may reach the remote
 * `dsh plugin add` command — `<remote-home>/.dsh-chamber/plugins/<name>-<hash>.tgz`.
 * The path is constrained to the `.dsh-chamber/plugins/` subtree (the same
 * fixed surface resolveWriteTarget allows writes into), shell-safe, and the
 * argv is only ever constructed by the main-process materialize orchestration
 * (the renderer has no channel that forwards a `file:` spec to a remote
 * `run` — applyPlugins re-validates against PLUGIN_SPEC_PATTERN, which
 * refuses `file:`). `~` is never accepted here: a word-middle `~` is not
 * expanded by the remote shell/pnpm, so the absolute form is mandatory.
 */
export const MATERIALIZE_FILE_SPEC_PATTERN = /^file:\/([a-zA-Z0-9._-]+\/)*\.dsh-chamber\/plugins\/[a-zA-Z0-9._-]+\.tgz$/

/**
 * write-file content cap (design 13 §4.1: 50MiB suggested): bounds both the
 * base64 payload decoded in the main process and the materialize/seed
 * orchestration payloads that flow through write-file.
 */
export const WRITE_FILE_MAX_BYTES = 50 * 1024 * 1024

/** Captured stdout cap for whitelisted remote reads. Remote profile files
 * are not trusted to be small; without a byte budget a corrupt/malicious
 * remote `cat` could exhaust Electron's main-process memory. The cap also
 * admits the largest write-file read-back exactly. */
export const RUN_STDOUT_MAX_BYTES = WRITE_FILE_MAX_BYTES

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
 * a host.describe reply; bounded memory on a misbehaving endpoint). */
export const VERIFY_UP_MAX_BODY_BYTES = 1024 * 1024

/** Timeout of the one-shot client-graph liveness probe (probeClientGraphLive). */
export const CLIENT_GRAPH_PROBE_TIMEOUT_MS = 5_000

/** Response-body cap of the client-graph liveness probe (an oversized answer
 *  is not a graph RPC envelope; bounded memory on a misbehaving endpoint). */
export const CLIENT_GRAPH_PROBE_MAX_BODY_BYTES = 1024 * 1024

/** Timeout of the secondary dsh-signature probe (GET /api/events.mux). */
export const VERIFY_UP_SIGNATURE_TIMEOUT_MS = 2_000

/**
 * Secondary dsh-signature probe: GET /api/events.mux and classify by the
 * answer — the dsh connection plugin answers 426 + Upgrade: websocket
 * (documented dsh-client-connection contract); an older dsh without that
 * arm falls through to the apiProxy SSE arm and answers 200
 * text/event-stream. Either answer is positive dsh evidence: a destination
 * that fails the host.describe handshake but carries one of these
 * signatures IS a dsh instance with an incompatible/old version — the
 * caller can then tell the user to upgrade instead of claiming "not dsh".
 * Anything else (404, garbage, no answer) is no signature.
 */
export function probeDshSignature(
  endpoint: { host: string; port: number },
  timeoutMs = VERIFY_UP_SIGNATURE_TIMEOUT_MS,
): Promise<'connection-plugin' | 'sse' | 'none'> {
  return new Promise(resolve => {
    let settled = false
    const done = (signature: 'connection-plugin' | 'sse' | 'none') => {
      if (settled) return
      settled = true
      // The response head is all we need — a 200 SSE signature is an
      // open-ended stream that must not be kept connected past the probe
      // (a destroyed request's late 'error' is consumed by the handler
      // below; the settled guard makes it a no-op).
      req.destroy()
      resolve(signature)
    }
    const req = httpRequest(`http://${endpoint.host}:${endpoint.port}/api/events.mux`, {
      method: 'GET',
      timeout: timeoutMs,
    }, res => {
      // A premature close after our destroy must never escape as an
      // uncaught error (main-process safety discipline).
      res.on('error', () => {})
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase()
      const upgrade = String(res.headers.upgrade ?? '').toLowerCase()
      res.resume()
      if (res.statusCode === 426 && upgrade === 'websocket') done('connection-plugin')
      else if (res.statusCode === 200 && contentType.startsWith('text/event-stream')) done('sse')
      else done('none')
    })
    req.on('timeout', () => {
      req.destroy()
      done('none')
    })
    req.on('error', () => done('none'))
    req.end()
  })
}

/**
 * One-shot dsh identity probe (design 03 §2.2 / 05 §7.6): POST
 * /api/host.describe with the standard client-request envelope and require
 * a valid server-response echo with result.ok === true — the same wire
 * handshake the control plane's local readiness uses (02 §3.2: "TCP 通但
 * describe 失败 = 端口被无关服务占用") and dsh's own connection client
 * performs on attach. A port that merely accepts TCP — a non-dsh service
 * on the remote dsh port — answers differently and is rejected, so the
 * runtime never presents a fake connection as ready. The envelope is built
 * and validated by the shared rpc-envelope module (single-sourced in
 * control-plane, consumed through control-plane-module.ts — the packaged
 * app loads the compiled control-plane bundle, dev runs the workspace
 * source).
 *
 * Failure classification (honest, never guessed): when the handshake fails
 * at the HTTP level, a secondary dsh-signature probe (probeDshSignature)
 * decides between "the destination IS dsh but too old/incompatible — tell
 * the user to upgrade" (positive signature: the 426 connection-plugin arm
 * or the apiProxy SSE arm) and the generic "not a dsh instance". A dsh so
 * old that it carries NEITHER signature is indistinguishable from a
 * non-dsh web server by design — the generic message stays.
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
  const url = `http://${endpoint.host}:${endpoint.port}/api/host.describe`
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const rpcId = mintRpcId()
  const outcome = await postClientRequest({
    url,
    envelope: buildClientRequest(rpcId, 'host.describe', {}),
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
  // that does not register host.describe, 403, 5xx, …): classify with the
  // dsh-signature probe before choosing the message.
  if (outcome.status !== 200) {
    const signature = await probeDshSignature(endpoint, Math.min(VERIFY_UP_SIGNATURE_TIMEOUT_MS, remaining()))
    if (signature !== 'none') {
      return { ok: false, detail: 'the destination is a dsh instance, but its version does not answer the host.describe handshake — upgrade the remote dsh', terminal: true }
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
 * runtime whitelist (it rides /api/i/ssh-<id> path segments); host/user must
 * match the identifier whitelists and never start with '-' (a leading '-' on
 * the ssh command line would be parsed as an option — option-injection guard,
 * enforced here in core logic, not only in the UI). serviceName is only
 * type-checked here (string | null); the format whitelist is enforced at
 * exec time, where the value is actually placed on a command line.
 */
function isValidInstance(instance: unknown, kind: TransportProvider['kind']): instance is TransportInstanceSpec {
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
    && (record.kind === undefined || record.kind === null || record.kind === kind)
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
export type SshPasswordOwner = Pick<TransportInstanceSpec, 'id' | 'host' | 'user' | 'sshPort'>

export interface SshPasswordReplacement {
  owner: SshPasswordOwner
  password: string
}

interface StoredSshPassword extends SshPasswordOwner {
  password: string
}

const passwords = new Map<string, StoredSshPassword>()

/** The plaintext persistence mirror path; null = memory-only (tests, or a
 * platform without persistence). Configured once at startup. */
let passwordFile: string | null = null

/** id → path of the live ephemeral askpass helper (0700, deleted on dispose). */
// id → every helper file ever baked for it (a password change creates a new
// helper; the old one stays until dispose/clear so an in-flight spawn that
// already captured its env keeps working — 2026 review: deleting the previous
// helper on every sshAuthEnv call raced concurrent tunnel+exec).
const askpassHelpers = new Map<string, string[]>()
/** The password each id's helpers were baked with (reuse key). */
const askpassHelperPasswords = new Map<string, string>()

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

/** Schema v1 stored only id → password and therefore cannot prove which SSH
 * peer owns a credential. Preserve it for manual recovery but never guess an
 * owner from the current registry: that registry may be the newer half of an
 * interrupted cross-file commit. */
function retireUnownedPasswordFile(file: string): string {
  const retiredPath = `${file}.v1-retired`
  try {
    renameSync(file, retiredPath)
    return `legacy password file without endpoint ownership retired at ${retiredPath}; re-enter SSH passwords`
  } catch (error) {
    return `legacy password file has no endpoint ownership and was not loaded; preserve failed: ${String(error)}; re-enter SSH passwords`
  }
}

function isValidPasswordOwner(owner: unknown): owner is SshPasswordOwner {
  if (!isPlainRecord(owner)) return false
  return typeof owner.id === 'string'
    && owner.id !== 'local'
    && INSTANCE_ID_PATTERN.test(owner.id)
    && typeof owner.host === 'string'
    && owner.host.length <= MAX_SSH_HOST_CHARS
    && SSH_HOST_PATTERN.test(owner.host)
    && (owner.user === null
      || (typeof owner.user === 'string' && owner.user.length <= MAX_SSH_USER_CHARS && SSH_USER_PATTERN.test(owner.user)))
    && (owner.sshPort === null
      || (typeof owner.sshPort === 'number' && Number.isInteger(owner.sshPort)
        && owner.sshPort >= 1 && owner.sshPort <= 65535))
}

function samePasswordOwner(stored: StoredSshPassword, owner: SshPasswordOwner): boolean {
  return stored.id === owner.id
    && stored.host === owner.host
    && stored.user === owner.user
    && stored.sshPort === owner.sshPort
}

/**
 * Point the password store at its persistence file (main.ts, once at
 * startup) and load existing entries. Missing file = empty set (first run).
 * A corrupt file fails LOUDLY — preserved as `<file>.corrupt` and reported
 * through the return value — never silently treated as empty (the registry's
 * corrupt-file discipline). Passing null keeps the store memory-only. The
 * return value is a loud notice string (corrupt-preserved path) or null.
 */
export function configureSshPasswordStore(file: string | null): string | null {
  passwordFile = file
  passwords.clear()
  if (file === null) return null
  let text: string
  let fd: number | null = null
  try {
    // O_NOFOLLOW prevents a local symlink from redirecting credential reads.
    // Windows password auth is disabled; lstat still rejects a symlink there
    // because O_NOFOLLOW is not consistently supported by Win32 filesystems.
    if (process.platform === 'win32' && lstatSync(file).isSymbolicLink()) {
      return `refusing non-regular password file ${file}`
    }
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW
    fd = openSync(file, fsConstants.O_RDONLY | noFollow)
    const info = fstatSync(fd)
    if (!info.isFile()) return `refusing non-regular password file ${file}`
    const getuid = process.getuid
    if (typeof getuid === 'function' && info.uid !== getuid()) {
      return `refusing password file not owned by the current user: ${file}`
    }
    if (process.platform !== 'win32' && (info.mode & 0o777) !== 0o600) {
      // A legacy/manual 0644 store is already exposed. Tighten the opened
      // inode before reading any secret and continue only if chmod succeeds.
      fchmodSync(fd, 0o600)
    }
    text = readFileSync(fd, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    // Unreadable for another reason (permissions…): loud, non-fatal — the
    // app starts and password hosts fail auth until the user re-enters.
    return `cannot read ${file}: ${String(error)}`
  } finally {
    if (fd !== null) closeSync(fd)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return preserveInvalidPasswordFile(file)
  }
  if (isPlainRecord(parsed) && parsed.schemaVersion === 1) {
    return retireUnownedPasswordFile(file)
  }
  if (!isPlainRecord(parsed) || parsed.schemaVersion !== 2 || !isPlainRecord(parsed.passwords)) {
    return preserveInvalidPasswordFile(file)
  }
  const entries = Object.entries(parsed.passwords)
  const loaded = new Map<string, StoredSshPassword>()
  for (const [id, value] of entries) {
    if (!isPlainRecord(value)) return preserveInvalidPasswordFile(file)
    const owner = { id, host: value.host, user: value.user, sshPort: value.sshPort }
    if (!isValidPasswordOwner(owner)
      || typeof value.password !== 'string'
      || value.password === ''
      || value.password.length > MAX_SSH_PASSWORD_CHARS) {
      return preserveInvalidPasswordFile(file)
    }
    loaded.set(id, { ...owner, password: value.password })
  }
  for (const [id, value] of loaded) passwords.set(id, value)
  return null
}

/** Set or clear the password for one instance (null/'' = clear). Persists
 * the plaintext mirror when configured. A non-empty password always receives
 * the current authoritative SSH authentication owner from main.ts. */
export function setSshPassword(owner: SshPasswordOwner, password: string | null): void {
  if (!isValidPasswordOwner(owner)) {
    throw new Error(`refusing password for invalid SSH owner ${JSON.stringify(owner)}`)
  }
  if (password !== null && (typeof password !== 'string' || password.length > MAX_SSH_PASSWORD_CHARS)) {
    throw new Error(`refusing SSH password longer than ${MAX_SSH_PASSWORD_CHARS} characters`)
  }
  const clearing = password === null || password === ''
  if (clearing) {
    updateSshPasswords([owner.id])
    return
  }
  updateSshPasswords([], { owner, password })
}

/**
 * Apply retirements plus an optional replacement in ONE password-file write.
 * Either the complete next credential map is durable and then published, or
 * the old map/helpers remain untouched. Setting happens after clears, so an
 * authentication-peer edit may retire and replace the same id atomically.
 */
export function updateSshPasswords(
  ids: readonly string[],
  replacement?: SshPasswordReplacement,
): void {
  const unique = [...new Set(ids)]
  for (const id of unique) {
    if (id === 'local' || !INSTANCE_ID_PATTERN.test(id)) {
      throw new Error(`refusing password clear for invalid instance id ${JSON.stringify(id)}`)
    }
  }
  if (replacement !== undefined) {
    if (!isValidPasswordOwner(replacement.owner)) {
      throw new Error(`refusing password for invalid SSH owner ${JSON.stringify(replacement.owner)}`)
    }
    if (typeof replacement.password !== 'string'
      || replacement.password === ''
      || replacement.password.length > MAX_SSH_PASSWORD_CHARS) {
      throw new Error(`refusing invalid SSH replacement password`)
    }
  }
  if (unique.length === 0 && replacement === undefined) return
  const present = unique.filter(id => passwords.has(id))
  if (present.length === 0 && replacement === undefined) {
    // There is no durable secret to rewrite. A registry deletion must not be
    // refused merely because an unrelated/empty password file is unwritable.
    for (const id of unique) clearAskpassHelpers(id)
    return
  }
  const next = new Map(passwords)
  for (const id of present) next.delete(id)
  if (replacement !== undefined) {
    const { owner, password } = replacement
    next.set(owner.id, { ...owner, password })
  }
  persistSshPasswords(next)
  passwords.clear()
  for (const [entryId, entryPassword] of next) passwords.set(entryId, entryPassword)
  // Helper cleanup is part of the committed clear, not its preparation: if
  // the durable replace above fails, the old passwords remain authoritative
  // and in-flight ssh spawns keep their existing helpers too.
  for (const id of unique) clearAskpassHelpers(id)
}

/** Clear multiple removed instances in one password-file transaction. */
export function clearSshPasswords(ids: readonly string[]): void {
  updateSshPasswords(ids)
}

/** The stored password for the exact authentication peer, or null. This is
 * the final fail-closed gate used immediately before every ssh spawn. */
export function getSshPassword(owner: SshPasswordOwner): string | null {
  const stored = passwords.get(owner.id)
  return stored !== undefined && samePasswordOwner(stored, owner) ? stored.password : null
}

/**
 * Mirror the in-memory map to the plaintext file (design 05 §8): write
 * `.tmp` with mode 0600 → fsync → rename (the repo's atomic-write
 * convention — the rename keeps the tmp file's 0600 mode). Empty maps still
 * write an empty file; the file is only created on the first set/clear.
 */
function persistSshPasswords(next: ReadonlyMap<string, StoredSshPassword>): void {
  if (passwordFile === null) return
  const persistedEntries = [...next].map(([id, entry]) => [id, {
    password: entry.password,
    host: entry.host,
    user: entry.user,
    sshPort: entry.sshPort,
  }])
  const payload = `${JSON.stringify({ schemaVersion: 2, passwords: Object.fromEntries(persistedEntries) }, undefined, 2)}\n`
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
    '# dsh-chamber ssh password helper (ephemeral, 0700, deleted on transport stop)',
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

/** Write one ephemeral askpass helper for an instance; returns its path. */
export function createAskpassHelper(id: string, password: string): string {
  // The id lands in the temp filename — refuse anything outside the registry
  // whitelist (defense in depth; the IPC gate already enforces this before a
  // password can be stored).
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(`refusing askpass helper for invalid instance id ${JSON.stringify(id)}`)
  }
  const dir = join(tmpdir(), 'dsh-chamber-ssh')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  // Include the owner PID so startup cleanup can distinguish crash leftovers
  // from a simultaneously running dev/packaged chamber process.
  const path = join(dir, `askpass-${id}.pid-${process.pid}.${randomUUID()}.sh`)
  try {
    // Keep a partially written helper non-executable, then publish it as an
    // owner-only executable. The explicit chmod also defeats a restrictive
    // process umask that would otherwise strip the owner execute bit.
    writeFileSync(path, buildAskpassScript(password), { mode: 0o600 })
    chmodSync(path, 0o700)
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
  const dir = join(tmpdir(), 'dsh-chamber-ssh')
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
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
    return null
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

/**
 * The askpass environment for one instance's ssh spawn (tunnel AND systemd
 * exec): null when the instance has no stored password or the platform does
 * not support it. The helper is REUSED while the password is unchanged —
 * never deleted and recreated per call (a concurrent tunnel+exec would
 * delete each other's in-use helper and produce a fake auth failure; 2026
 * review). A changed password bakes a NEW helper; the old file stays until
 * dispose/clear so an in-flight spawn keeps working.
 */
export function sshAuthEnv(spec: TransportInstanceSpec): NodeJS.ProcessEnv | null {
  if (!sshPasswordSupported()) return null
  // The password file and instance registry are separately atomic. Compare
  // the persisted owner at the last possible moment so a crash between their
  // commits can only disable password auth, never send an old secret to the
  // new endpoint behind the same id.
  const password = getSshPassword(spec)
  if (password === null) return null
  const existing = askpassHelpers.get(spec.id) ?? []
  if (existing.length > 0 && askpassHelperPasswords.get(spec.id) === password) {
    return { SSH_ASKPASS: existing[existing.length - 1], SSH_ASKPASS_REQUIRE: 'force' }
  }
  const helper = createAskpassHelper(spec.id, password)
  askpassHelpers.set(spec.id, [...existing, helper])
  askpassHelperPasswords.set(spec.id, password)
  return { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force' }
}

/** Remove every baked helper for one instance (password clear / removal / quit). */
export function clearAskpassHelpers(id: string): void {
  const helpers = askpassHelpers.get(id)
  if (helpers !== undefined) {
    for (const helper of helpers) deleteAskpassHelper(helper)
    askpassHelpers.delete(id)
  }
  askpassHelperPasswords.delete(id)
}

/**
 * Delete the instance's ephemeral askpass helper (transport stop / removal
 * / app quit). The in-memory password itself survives a plain disconnect
 * (the user may reconnect without retyping) and is only cleared by
 * setSshPassword(owner, null), instance removal, or app quit.
 */
export function disposeSshAuth(spec: TransportInstanceSpec): void {
  clearAskpassHelpers(spec.id)
}

/** The ssh provider: validate → spawn args → stderr classification → exec. */
export const sshProvider: TransportProvider = {
  kind: 'ssh',

  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (!isValidInstance(input, 'ssh')) return null
    const record = input as unknown as Record<string, unknown>
    return {
      id: record.id as string,
      label: record.label as string,
      kind: 'ssh',
      host: record.host as string,
      user: record.user === undefined || record.user === null ? null : (record.user as string),
      sshPort: record.sshPort === undefined || record.sshPort === null ? null : (record.sshPort as number),
      remotePort: record.remotePort as number,
      serviceName: record.serviceName === undefined || record.serviceName === null ? null : (record.serviceName as string),
      remoteDshHome: record.remoteDshHome === undefined || record.remoteDshHome === null ? null : (record.remoteDshHome as string),
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
  buildStartEnv(spec: TransportInstanceSpec): NodeJS.ProcessEnv | null {
    return sshAuthEnv(spec)
  },

  /**
   * Delete the instance's ephemeral askpass helper (transport stop /
   * removal / app quit). The in-memory password itself survives a plain
   * disconnect (the user may reconnect without retyping) and is only
   * cleared by setSshPassword(owner, null), instance removal, or app quit.
   */
  disposeAuth(spec: TransportInstanceSpec): void {
    disposeSshAuth(spec)
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
   * Endpoint identity verification: the tunnel destination (or direct
   * endpoint) must answer the dsh host.describe wire handshake before the
   * runtime may declare the instance ready — a non-dsh service on the
   * destination port never presents as a fake connection.
   */
  verifyUp(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint) {
    return verifyDshEndpoint(endpoint)
  },

  exec(spec: TransportInstanceSpec, action: TransportExecAction, deps: TransportExecDeps, payload?: TransportRunPayload): Promise<TransportExecResult> {
    return runExec(spec, action, deps, payload)
  },
}

/**
 * One remote systemd exec (design 02 §3.9): `ssh user@host systemctl
 * <action> <serviceName>`, argument-array spawn (no shell), serviceName
 * whitelist-checked BEFORE anything spawns (injection guard; a name that
 * fails is refused with a log entry and an error result). Failures are
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
    ? [target, 'systemctl', action, spec.serviceName]
    : ['-p', String(spec.sshPort), target, 'systemctl', action, spec.serviceName]
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
    const authEnv = sshAuthEnv(spec)
    if (authEnv !== null) spawnOptions.env = { ...process.env, ...authEnv }
    try {
      child = deps.spawnFn('ssh', args, spawnOptions)
    } catch (spawnError) {
      deps.log('error', `failed to spawn ssh for systemctl ${action}: ${String(spawnError)}`)
      finish({ ok: false, error: `failed to spawn ssh: ${String(spawnError)}` })
      return
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
    const authEnv = sshAuthEnv(spec)
    if (authEnv !== null) spawnOptions.env = { ...process.env, ...authEnv }
    try {
      child = deps.spawnFn('ssh', args, spawnOptions)
    } catch (spawnError) {
      deps.log('error', `failed to spawn ssh for run: ${String(spawnError)}`)
      finish({ ok: false, error: `failed to spawn ssh: ${String(spawnError)}` })
      return
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
