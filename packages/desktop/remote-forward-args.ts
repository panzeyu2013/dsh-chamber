/**
 * SSH argv builder for one browser forward — W0/S1, design 28.
 *
 * ONE JOB: turn a validated forward spec into the exact argv array for
 * `ssh -N ... -L <alias>:<localPort>:127.0.0.1:<targetPort> user@host`. It never
 * runs anything, never formats a shell string and never reads ssh config: the
 * caller spawns the array with `shell: false`, so no payload byte can become a
 * shell word. The spec fields come from the main-process registry (never from a
 * renderer payload) and are re-validated here anyway — the builder is the last
 * place where a hostile host/user string could turn into an ssh option.
 *
 * DISCIPLINE MIRRORED FROM ssh-provider.ts's buildStartArgs (the transport
 * tunnel builder): `-N`, ConnectTimeout=8 + ExitOnForwardFailure=yes, the
 * ServerAlive keepalive, then `-p` (only when the daemon port is non-default),
 * then `-L`, then `[user@]host`. A lockstep test pins the keepalive constants to
 * the provider's exports, so the two ssh surfaces cannot drift.
 *
 * WHAT THIS BUILDER MUST NEVER EMIT (security review I9; asserted by the argv
 * golden test for every call shape):
 *   - StrictHostKeyChecking=no / UserKnownHostsFile=/dev/null (host-key trust
 *     downgrade — a forward carries the user's SSH identity),
 *   - LocalCommand / PermitLocalCommand / ProxyCommand (arbitrary local or
 *     proxy execution),
 *   - any `-o` whose value is built from an untrusted string (all `-o` values
 *     here are compile-time literals).
 *
 * IPv6 and non-loopback targets are not a builder concern: the manager's gate
 * refuses them before a target port reaches this module, and the target host is
 * the constant below (never a parameter). Redirecting the remote side would be
 * a different protocol decision, not a formatting option.
 *
 * TODO(W0): confirm the pinned ssh-provider constants and whether
 * this builder should be REUSED by the transport provider instead of mirrored
 * (design 28 records the temporary duplication; the keepalive lockstep test is
 * the retirement condition).
 */
import { hostKeyAliasFor, sshOptionValue, sshTrustPins } from './host-key.ts'
import {
  FORWARD_ALIAS_MAX_OCTET,
  FORWARD_ALIAS_MIN_OCTET,
  isForwardAliasHost,
} from './remote-forward-namespace.ts'

/** The only remote host a browser forward may target in v1. */
export const FORWARD_TARGET_HOST = '127.0.0.1'

/** Same connect ceiling as the transport tunnel: an unreachable host fails fast. */
export const FORWARD_CONNECT_TIMEOUT_SECONDS = 8

/**
 * SSH keepalive mirrored from ssh-provider.ts (SERVER_ALIVE_INTERVAL_SECONDS /
 * SERVER_ALIVE_COUNT_MAX). ssh exits on its own after interval*countMax
 * unanswered probes (~90s), so a dead forward feeds the manager's bounded
 * reconnect instead of lingering as a dead listener.
 */
export const FORWARD_SERVER_ALIVE_INTERVAL_SECONDS = 30
export const FORWARD_SERVER_ALIVE_COUNT_MAX = 3

/** Option names the builder must never produce (argv golden test asserts absence). */
export const FORWARD_SSH_FORBIDDEN_OPTION_NAMES = Object.freeze([
  'StrictHostKeyChecking=no',
  'UserKnownHostsFile=/dev/null',
  'LocalCommand',
  'PermitLocalCommand',
  'ProxyCommand',
] as const)

/** The app-owned known_hosts store every forward child must read (v2). */
export interface ForwardSshKnownHosts {
  readonly knownHostsFile: string
  readonly globalKnownHostsFile: string
}

/** Trusted SSH target fields (resolved from the registry, never from the renderer). */
export interface ForwardSshSpec {
  /** SSH host or alias as stored in the registry. */
  readonly host: string
  /** null = ssh's default user (the provider's convention). */
  readonly user: string | null
  /** null = ssh config/default port. */
  readonly sshPort: number | null
  /**
   * v2 host-key policy: the APP-OWNED known_hosts store. Present = the argv pins
   * StrictHostKeyChecking=yes + UserKnownHostsFile/GlobalKnownHostsFile +
   * HostKeyAlias + the shared trust pins (see host-key.ts). Absent = a pure
   * caller (tests) that keeps the historical argv.
   */
  readonly knownHosts?: ForwardSshKnownHosts
}

const HOST_PATTERN = /^[A-Za-z0-9._-]{1,255}$/u
const USER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/u

function assertPortRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError('invalid ' + label + ': ' + String(value))
  }
}

function assertHost(value: unknown): string {
  if (typeof value !== 'string' || !HOST_PATTERN.test(value) || CONTROL_OR_SPACE.test(value)) {
    throw new TypeError('invalid ssh host')
  }
  // A leading '-' would be consumed as an ssh option, not as the destination.
  if (value.startsWith('-')) throw new TypeError('ssh host may not start with "-"')
  return value
}

function assertUser(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !USER_PATTERN.test(value) || CONTROL_OR_SPACE.test(value)) {
    throw new TypeError('invalid ssh user')
  }
  return value
}

/**
 * Validate one app-owned known_hosts path. The path is quoted through
 * sshOptionValue (macOS userData contains a space) so only control bytes / NUL
 * can never be legitimate; an empty/oversized value is refused.
 */
function assertKnownHostsPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    throw new TypeError('invalid known_hosts path')
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('invalid known_hosts path')
  return value
}

function assertKnownHosts(value: unknown): ForwardSshKnownHosts | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') throw new TypeError('invalid known_hosts store')
  const record = value as Record<string, unknown>
  return {
    knownHostsFile: assertKnownHostsPath(record.knownHostsFile),
    globalKnownHostsFile: assertKnownHostsPath(record.globalKnownHostsFile),
  }
}

/**
 * Build the argv for one forward. Pure and total for valid inputs; throws
 * RangeError/TypeError for anything the manager must never spawn.
 *
 * @param spec registry-resolved SSH target.
 * @param localHost required alias host (127.0.0.2..254) — never defaults to
 *   127.0.0.1, because the whole isolation model rests on it.
 * @param localPort local listener port, >= 1024 (the manager's range).
 * @param targetPort remote loopback service port, 1..65535.
 */
export function buildForwardArgs(
  spec: ForwardSshSpec,
  localHost: string,
  localPort: number,
  targetPort: number,
): string[] {
  const rawSpec: unknown = spec
  if (typeof rawSpec !== 'object' || rawSpec === null) throw new TypeError('invalid ssh spec')
  const host = assertHost(spec.host)
  const user = assertUser(spec.user)
  const sshPort = spec.sshPort ?? null
  if (sshPort !== null) assertPortRange(sshPort, 1, 65535, 'ssh port')
  if (!isForwardAliasHost(localHost)) {
    throw new RangeError(
      'invalid forward bind host: expected 127.0.0.'
        + String(FORWARD_ALIAS_MIN_OCTET) + '..' + String(FORWARD_ALIAS_MAX_OCTET),
    )
  }
  assertPortRange(localPort, 1024, 65535, 'local port')
  assertPortRange(targetPort, 1, 65535, 'target port')

  const knownHosts = assertKnownHosts(spec.knownHosts)
  const target = user === null ? host : user + '@' + host
  const connectArgs = ['-o', 'ConnectTimeout=' + String(FORWARD_CONNECT_TIMEOUT_SECONDS), '-o', 'ExitOnForwardFailure=yes']
  const keepaliveArgs = [
    '-o', 'ServerAliveInterval=' + String(FORWARD_SERVER_ALIVE_INTERVAL_SECONDS),
    '-o', 'ServerAliveCountMax=' + String(FORWARD_SERVER_ALIVE_COUNT_MAX),
  ]
  // v2: ControlMaster is OFF for every forward child (the user's ~/.ssh/config
  // must not multiplex our -L onto a master that ignores a new forward).
  const controlArgs = ['-o', 'ControlMaster=no', '-o', 'ControlPath=none']
  // v2 host-key policy: the APP-OWNED known_hosts store + strict checking, the
  // same option set ssh-provider.ts passes to the tunnel (lockstep test).
  const hostKeyArgs = knownHosts === null
    ? []
    : [
      '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UserKnownHostsFile=' + sshOptionValue(knownHosts.knownHostsFile),
      '-o', 'GlobalKnownHostsFile=' + sshOptionValue(knownHosts.globalKnownHostsFile),
      '-o', 'HostKeyAlias=' + hostKeyAliasFor({ host, sshPort, user }),
      ...sshTrustPins(),
    ]
  // -L bind part: the alias host is mandatory and the remote side is the fixed
  // loopback. The port pair uses one colon grammar, validated above.
  const bind = localHost + ':' + String(localPort) + ':' + FORWARD_TARGET_HOST + ':' + String(targetPort)
  const args = ['-N', ...connectArgs, ...keepaliveArgs, ...controlArgs, ...hostKeyArgs]
  if (sshPort !== null) args.push('-p', String(sshPort))
  args.push('-L', bind, target)
  return args
}
