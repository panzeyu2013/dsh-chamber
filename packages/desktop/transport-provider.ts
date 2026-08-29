/**
 * Transport-provider abstraction (design 03 §2.2 / 05 §7-§8 / 17 §2): the
 * connection-manager runtime (`transport-manager.ts`) is source-agnostic.
 *
 * v2 four-dimensional model (design 17 §2): the spec's TARGET TYPE (`kind`)
 * and TRANSPORT METHOD (`transport`) are ORTHOGONAL dimensions:
 * - `kind` = the target's semantics: `dsh` (a dsh web profile, loopback,
 *   no auth surface — never injects auth headers, never mounts `/chamber/*`)
 *   or `gateway` (a gateway deployment with an auth surface — may inject
 *   `Authorization`/`Cookie` headers and mounts gateway capabilities);
 * - `transport` = the mechanism: `ssh` (tunnel subprocess + systemd exec)
 *   or `http` (direct endpoint, no child process).
 * Every registry instance carries both; the runtime resolves ONE
 * TransportProvider per spec BY TRANSPORT (design 17 §2.2: providers are
 * registered `{ ssh, http }` and a single provider serves both target kinds),
 * with a legacy kind-keyed fallback retained (transport-manager.ts). The
 * provider owns everything source-specific:
 * - spec validation (whitelist-gated, option-injection safe),
 * - either transport-process argv (`ssh`) or a direct endpoint (`http`),
 * - stderr classification (terminal auth vs transient) and redaction,
 * - the optional remote-service exec channel (`ssh`: systemd over ssh).
 *
 * The generic runtime owns the phase machine, bounded jittered reconnect,
 * ring-buffer logs, non-secret status projection, status pushes, child
 * supervision (SIGTERM → SIGKILL escalation) and the instance registry.
 *
 * v1 compat: the preload/renderer wire typings keep the `Ssh*` names (the
 * `SshInstanceInput`/`SshInstanceSpec`/`SshStatusProjection`/`SshLogEntry`
 * aliases below); desktop internals use the `Transport*` names. Legacy
 * persisted entries (`kind:'ssh'` conflating transport with target) migrate
 * in transport-manager.ts (design 17 §2.2/§9.1).
 */

/** Target kinds shipped (design 17 §2.1): the spec `kind` field — `dsh`
 * (web profile, no auth surface) or `gateway` (authenticated server shape,
 * design 17 §7). Future targets extend the union. */
export const TARGET_KINDS = ['dsh', 'gateway'] as const

/** Transport methods shipped (design 17 §2.2): the spec `transport` field —
 * `ssh` (tunnel subprocess + systemd exec) or `http` (direct endpoint).
 * Providers register BY transport (`providers: { ssh, http }`); the spec's
 * `kind` decides target semantics (auth-header injection, `/chamber/*`). */
export const TRANSPORT_METHODS = ['ssh', 'http'] as const

/**
 * Legacy v1 name: `kind` used to conflate the transport with the target
 * ('ssh' | 'gateway'). Kept as a compat alias of TARGET_KINDS for any
 * external mirror still referencing the symbol — nothing ships against the
 * old meaning anymore (the transport dimension is `transport`).
 */
export const TRANSPORT_KINDS = TARGET_KINDS

/** Renderer/registry resource budgets, enforced again in the main process. */
export const MAX_TRANSPORT_INSTANCES = 32
export const MAX_INSTANCE_LABEL_CHARS = 128

/**
 * The registry id whitelist (design 03 §2.2): id rides the per-instance
 * reverse-proxy connectionId (`<kind>:<id>` → source id `dsh-<id>` /
 * `gateway-<id>`, design 17 §2.1/§9.3) and transport keys, so it must be a
 * plain identifier and must not collide with the reserved 'local' source id.
 * Single source of truth — enforced by every provider's validateSpec via the
 * shared check.
 */
export const INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/

/**
 * Open-ended kind union: the TARGET TYPE (design 17 §2.1) — autocompletes
 * the shipped kinds while still accepting a future target string. The
 * provider `kind` field and the providers registry reuse this union via the
 * open end (a provider declares the target/transport it serves; the runtime
 * resolves the registry by `spec.transport` first, transport-manager.ts).
 */
export type TransportKind = (typeof TARGET_KINDS)[number] | (string & {})

/** Open-ended transport-method union (design 17 §2.2): autocompletes the
 * shipped methods while accepting a future transport string. */
export type TransportMethod = (typeof TRANSPORT_METHODS)[number] | (string & {})

/** Tunnel lifecycle phase machine（隧道生命周期 phase 机）. */
export type TransportPhase = 'idle' | 'connecting' | 'ready' | 'degraded' | 'error'

/** Instance spec as accepted on save (kind, transport, user, sshPort,
 * serviceName and insecureHttp are optional input; legacy kinds migrate in
 * transport-manager). */
export interface TransportInstanceInput {
  id: string
  label: string
  /** Target type (design 17 §2.1): 'dsh' | 'gateway'. Omitted / legacy
   * entries migrate in transport-manager (kind:'ssh'→dsh, missing→dsh). */
  kind?: TransportKind
  /** Transport method (design 17 §2.2): 'ssh' | 'http'. Optional input —
   * inferred from kind when omitted (dsh→ssh, gateway→http); legacy kinds
   * migrate. */
  transport?: TransportMethod
  host: string
  user?: string | null
  /** SSH daemon port; null = ssh default (22 or the host's ~/.ssh/config Port). */
  sshPort?: number | null
  /** The remote dsh web profile port on the host (the tunnel destination). */
  remotePort: number
  serviceName?: string | null
  /** Remote dsh home (design 13 §4.2); `~/.dsh` or an absolute path, null = remote default `~/.dsh`. Non-secret. */
  remoteDshHome?: string | null
  /** transport='http' only: true = plaintext http origin (default false =
   * https). Non-secret; never part of transportTargetChanged — an http↔https
   * switch keeps the target's credentials (design 17 §9.1, D3 decision). */
  insecureHttp?: boolean
  /** transport='http' gateway targets only (S23): optional SPKI certificate
   * pin — hex sha256 of the peer certificate's SPKI DER, format
   * `^[0-9a-fA-F]{64}$` (validateSpec refuses anything else). https-only:
   * the pin makes the peer's public key the connection's trust anchor, so an
   * internal CA (e.g. Caddy `tls internal`) needs no NODE_EXTRA_CA_CERTS;
   * a mismatch is terminal (「gateway 证书已更换或 pin 错误」). Never part of
   * transportTargetChanged — it is not a credential. */
  spkiPin?: string
}

/** Normalized non-secret instance spec as held by the registry. */
export interface TransportInstanceSpec {
  id: string
  label: string
  /** Target type (design 17 §2.1): 'dsh' | 'gateway'. Decides target
   * semantics (auth-header injection, /chamber/* mounting), NOT the
   * transport — see `transport`. */
  kind: TransportKind
  /** Transport method (design 17 §2.2): 'ssh' | 'http'. The runtime resolves
   * the provider by this field (legacy kind-keyed fallback retained). */
  transport: TransportMethod
  host: string
  user: string | null
  /** SSH daemon port; null = ssh default (22 or the host's ~/.ssh/config Port). */
  sshPort: number | null
  /** The remote dsh web profile port on 127.0.0.1 / the host (the tunnel destination). */
  remotePort: number
  /** Remote systemd unit name; null = the instance's start/stop is not managed. */
  serviceName: string | null
  /** Remote dsh home (design 13 §4.2); normalized `~/.dsh` or absolute path, null = default `~/.dsh`. Non-secret. */
  remoteDshHome: string | null
  /** transport='http' only: true = plaintext http origin (default false =
   * https). Non-secret, normalized required. Excluded from
   * transportTargetChanged (http↔https keeps credentials, design 17 §9.1). */
  insecureHttp: boolean
  /** transport='http' gateway targets only (S23): optional SPKI certificate
   * pin (hex sha256 of the peer cert's SPKI DER); absent = no pinning. See
   * TransportInstanceInput.spkiPin. Non-secret, normalized optional. */
  spkiPin?: string
}

/** Canonical v1→v2 input normalization shared by registry load/save and the
 * authoritative save IPC. Keeping this in one place makes the optional
 * `transport` wire contract real instead of accepting it in TypeScript while
 * rejecting it at the main-process boundary. */
export function canonicalizeTransportInstanceInput(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry
  const record = entry as Record<string, unknown>
  const kind = record.kind
  const hasTransport = record.transport !== undefined && record.transport !== null
  let nextKind: unknown = kind
  let nextTransport: unknown = record.transport
  if (kind === 'ssh') {
    nextKind = 'dsh'
    nextTransport = 'ssh'
  } else if (kind === 'gateway') {
    nextKind = 'gateway'
    if (!hasTransport) nextTransport = 'http'
  } else if (kind === undefined || kind === null) {
    nextKind = 'dsh'
    nextTransport = 'ssh'
  } else if (!hasTransport) {
    nextTransport = kind === 'dsh' ? 'ssh' : undefined
  }
  return { ...record, kind: nextKind, transport: nextTransport }
}

/**
 * The non-secret status projection (design 05 §8): phase, local ports,
 * retryAttempt, requiresUserAction, serviceActive, logSummary. Never a
 * tunnel URL, never credential material. `kind` lets the renderer branch
 * per target type; `transport` per mechanism (design 17 §2); `insecureHttp`
 * enters the projection for the honest 明文 badge (design 17 §13.1).
 */
export interface TransportStatusProjection {
  kind: TransportKind
  /** Transport method (design 17 §2.2): the mechanism of the live transport
   * ('ssh' tunnel vs 'http' direct endpoint). Non-secret. */
  transport: TransportMethod
  /** transport='http': true = plaintext http origin (design 17 §13.1 诚实
   * 状态 — the 明文 badge stays visible after configuring). Non-secret. */
  insecureHttp: boolean
  phase: TransportPhase
  localPort: number | null
  sshPort: number | null
  remotePort: number
  retryAttempt: number
  requiresUserAction: boolean
  /**
   * Last known remote-service activation state (ssh: systemd); null = no
   * serviceName configured, or start/stop/is-active has not run yet
   * (on-demand writes only — no polling).
   */
  serviceActive: boolean | null
  /** Remote dsh home (non-secret metadata, design 13 §4.2). */
  remoteDshHome: string | null
  logSummary: string
}

/**
 * Remote-service exec outcome (ssh: systemctl): ok carries the fresh status
 * projection (serviceActive included), failure carries an error string.
 * Never thrown.
 *
 * `run` exec captures: `stdout` is the UTF-8-decoded view of the remote
 * stdout (lossy for binary content — replacement chars), and `stdoutBytes`
 * is the RAW captured bytes for byte-domain consumers. Both are only present
 * for the whitelisted `exec` reads. `write-file` verifies its read-back with
 * a streaming SHA-256 digest and returns status only.
 */
export type TransportExecResult =
  | { ok: true; status: TransportStatusProjection; stdout?: string; stdoutBytes?: Buffer }
  | { ok: false; error: string }

/** One ring-buffer log line. */
export interface TransportLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error'
  message: string
}

/**
 * The spawn-result surface the runtime needs — satisfied both by the real
 * node:child_process ChildProcess and by the tests' fake.
 */
export interface SpawnedProcess {
  stdin: { write(chunk: string | Buffer): unknown; end(): unknown } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** The endpoint a transport exposes for the readiness/identity probes
 *  (always the local tunnel listener: 127.0.0.1:<localPort>). */
export interface TransportProbeEndpoint {
  host: string
  port: number
}

/**
 * One-shot endpoint identity verification outcome.
 */
export interface TransportVerifyResult {
  ok: boolean
  /** Non-secret reason (hostnames/ports only, never credentials); shown in
   * logs and the status projection's logSummary. */
  detail?: string
  /**
   * True = deterministic failure: the destination ANSWERED the probe and
   * proved it is not (a compatible) dsh — e.g. wrong HTTP answer, wrong
   * version, wrong protocol. Retrying cannot change the answer, so the
   * runtime lands on error immediately (requiresUserAction, no reconnect
   * cycle). Absent/false = transient failure (connection error, timeout):
   * the bounded reconnect path applies.
   */
  terminal?: boolean
}

/** One complete stderr line, classified by the provider. */
export interface StderrClassification {
  /**
   * Redacted display text (already trimEnd'ed); empty lines are dropped by
   * the runtime. PRECEDENCE: when `log` is empty the runtime skips the line
   * entirely — `terminalAuth` is only evaluated on non-empty lines, so a
   * provider must never return { log: '', terminalAuth: true }.
   */
  log: string
  /** True = terminal auth/host-key failure: never auto-retried, requiresUserAction. */
  terminalAuth: boolean
  /**
   * True = the RAW line is an "absent file" signal (remote `cat` ENOENT).
   * Classified on the UNREDACTED text — redaction can replace the whole line
   * (a `.ssh*`-named remote home path, design 13 §7.2), which would erase the
   * signal the `run` caller's ENOENT classification relies on.
   */
  enoent: boolean
}

/** Remote-service exec channel action (ssh: systemctl start|stop|restart|is-active;
 *  `run` = a whitelisted remote command, design 13 §4.1). */
export type TransportExecAction = 'start' | 'stop' | 'restart' | 'is-active' | 'run'

/** The `run`-channel remote command whitelist (design 13 §4.1). Single source
 *  of truth — plugin-sync's contract A types import this instead of copying
 *  (the copy used to drift). The union equals the EXECUTABLE set enforced by
 *  buildRemoteExecArgv (ssh-provider.ts): 'base64'/'mkdir' are NOT exec
 *  commands — write-file builds them internally into its remote shell
 *  template — so they are deliberately absent here. */
export type TransportRunCommand = 'dsh' | 'cat' | 'printf'

/**
 * The `run` action payload (design 13 §4.1): either a whitelisted remote
 * command (`exec`) or a file write over ssh stdin (`write-file`).
 */
export interface TransportRunPayload {
  op: 'exec' | 'write-file'
  /** op='exec': remote command name (whitelisted). */
  command?: TransportRunCommand
  /** op='exec': argv after the command name (whitelisted per command). */
  argv?: string[]
  /** op='write-file': target path (whitelisted prefixes, design 13 §7.2). */
  path?: string
  /** op='write-file': file bytes, base64-encoded (no shell quoting needed). */
  contentBase64?: string
  /** op='write-file': expected SHA-256 hex of the decoded content (verified after write). */
  sha256?: string
  /**
   * True = a non-zero exit is EXPECTED (a first-seed probe of a file that
   * does not exist yet, design 13 §4.6): the failure is still returned as
   * `ok:false` with the same error text (callers' ENOENT classification
   * keeps working), but the ERROR-level "run command failed" log and the
   * raw-stderr INFO echo are suppressed — an expected probe failure must
   * not pollute the instance log panel. Auth failures are NEVER silenced.
   */
  quiet?: boolean
}

/** Dependencies the runtime hands to TransportProvider.exec. */
export interface TransportExecDeps {
  spawnFn(command: string, args: readonly string[], options: import('node:child_process').SpawnOptions): SpawnedProcess
  execTimeoutMs: number
  /** Independent timeout for the `run` channel (pnpm add hits the registry; default 120s). */
  runTimeoutMs?: number
  disconnectGraceMs: number
  log(level: TransportLogEntry['level'], message: string): void
  /** Write one provider-owned projection field (ssh: serviceActive) and broadcast. */
  setProjection(id: string, key: 'serviceActive', value: boolean | null): void
  /** The current projection for the exec's instance (null = instance was removed). */
  projection(id: string): TransportStatusProjection | null
}

/**
 * Provider-owned environment material leased to exactly one transport
 * child. Some environment values name ephemeral resources (ssh:
 * SSH_ASKPASS); the runtime must keep that resource alive until the child
 * exits or reports a spawn error, and must release it when spawn throws.
 * `release` must be idempotent because Node may report both error and exit.
 */
export interface TransportSpawnLease {
  env: NodeJS.ProcessEnv
  release(): void
}

/**
 * The provider surface the runtime drives. A provider is pure transport
 * know-how: it never sees timers, phases or the registry — the runtime does.
 */
export interface TransportProvider {
  /** The registry key this provider declares (normally the transport method,
   * or a test/future key). The runtime resolves the registry by
   * `spec.transport`, with a legacy kind-keyed fallback. */
  kind: TransportKind
  /**
   * Whitelist-gated spec validation (option-injection safe). Null = reject
   * the entry (dropped loudly by the registry, never silently half-kept).
   * A transport-selected provider may serve multiple shipped target kinds
   * (ssh and http both serve dsh|gateway); `kind` is only the legacy provider
   * lookup key when an old spec has no explicit transport. The provider
   * must preserve/whitelist the target kind and normalize its `transport`
   * mechanism, and
   * `insecureHttp`; a spec whose kind/transport the provider cannot serve
   * (e.g. the direct-endpoint gateway provider receiving transport 'ssh')
   * is rejected loudly rather than mis-served.
   */
  validateSpec(input: unknown): TransportInstanceSpec | null
  /**
   * argv of the transport process for one start, given the allocated local
   * port. Direct-endpoint providers omit this method. CONTRACT: returned
   * argv is DISPLAY-SAFE because the runtime may log it into a renderer-
   * visible summary (host/user/ports only; never credentials or tokens).
   */
  buildStartArgs?(spec: TransportInstanceSpec, localPort: number): readonly string[]
  /**
   * Optional leased extra environment for the transport process (merged
   * over process.env by the runtime). Providers use it to inject
   * per-instance non-argv material such as SSH_ASKPASS (ssh: password auth,
   * design 05 §8). The runtime releases the lease only after child
   * exit/error, or immediately when spawn itself throws. Absent/null = the
   * child inherits the main process environment unchanged.
   */
  buildStartEnv?(spec: TransportInstanceSpec): TransportSpawnLease | null
  /**
   * Optional per-instance resource retirement (ssh: stop handing out old
   * askpass generations without invalidating live child leases). Called by
   * the runtime when an instance's transport is stopped (disconnect,
   * removal, app quit). Never called for an instance the provider does not
   * know.
   */
  disposeAuth?(spec: TransportInstanceSpec): void
  /**
   * Optional FINAL per-instance cleanup request (ssh: purge every unleased
   * askpass generation and defer live generations to their child-scoped
   * release). Called by the runtime ONLY when an instance is REMOVED from
   * the registry — never on a plain disconnect. Absent = disposeAuth already
   * covers removal.
   */
  purgeAuth?(spec: TransportInstanceSpec): void
  /** Probe target for DIRECT ENDPOINT providers (ignored in tunnel mode). */
  probeTarget?(spec: TransportInstanceSpec): { host: string; port: number }
  /** Ready URL for DIRECT ENDPOINT providers (ignored in tunnel mode). */
  endpointUrl?(spec: TransportInstanceSpec): string | null
  /** Classify one COMPLETE stderr line of the transport process. */
  classifyStderr(line: string): StderrClassification
  /**
   * Optional redaction for NON-stderr channels (tunnel stdout): the stderr
   * path is redacted inside classifyStderr, but stdout lines would otherwise
   * land in the ring verbatim (ssh -N writes no stdout in practice, yet a
   * misbehaving remote could echo path/credential-shaped text). Applied per
   * chunk, like the exec channel. Absent = no redaction.
   */
  redactOutput?(text: string): string
  /**
   * Optional one-shot endpoint identity verification (dsh: the destination
   * answers the host.describe wire handshake). The runtime calls it once
   * after the transport probe reports the endpoint up and BEFORE the phase
   * may become ready: a port that merely accepts TCP is not proof of a dsh
   * instance, and a non-dsh service on the destination port must never
   * present as ready. Absent = the transport probe is trusted alone.
   */
  verifyUp?(spec: TransportInstanceSpec, endpoint: TransportProbeEndpoint): Promise<TransportVerifyResult>
  /** Optional remote-service exec channel. Absent = exec returns an explicit error. */
  exec?(
    spec: TransportInstanceSpec,
    action: TransportExecAction,
    deps: TransportExecDeps,
    payload?: TransportRunPayload,
  ): Promise<TransportExecResult>
}
/**
 * v1 wire-surface compat names (preload / renderer / connections typings
 * keep these; desktop internals use the Transport* names above).
 */
export type SshInstanceInput = TransportInstanceInput
export type SshInstanceSpec = TransportInstanceSpec
export type SshStatusProjection = TransportStatusProjection
export type SshLogEntry = TransportLogEntry
export type SshPhase = TransportPhase

/**
 * True when two specs point at a different transport TARGET — kind or any
 * host/user/port field. Label-only edits are not target changes.
 *
 * Compatibility semantic helper for the pre-v3 target model. Kind, host,
 * user, SSH/remote ports, serviceName, and remoteDshHome are included;
 * transport, HTTP scheme, and SPKI are excluded. The main-owned connection
 * transaction does NOT use this helper for credential ownership: gateway and
 * SSH secrets have separate binding fingerprints and retarget rules.
 *
 * It remains exported only to lock the compatibility comparison and prevent
 * accidental drift in callers that reason about whole execution targets.
 */
export function transportTargetChanged(a: TransportInstanceSpec, b: TransportInstanceSpec): boolean {
  return a.kind !== b.kind
    || a.host !== b.host
    || a.user !== b.user
    || a.sshPort !== b.sshPort
    || a.remotePort !== b.remotePort
    || a.serviceName !== b.serviceName
    || a.remoteDshHome !== b.remoteDshHome
}
