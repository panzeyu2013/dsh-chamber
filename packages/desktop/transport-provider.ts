/**
 * Transport-provider abstraction: the connection-manager runtime is source-agnostic. TARGET TYPE
 * (`kind`: `dsh` = loopback web profile, no auth surface, never injects auth headers nor mounts
 * `/chamber/*`; `gateway` = auth surface, may inject `Authorization`/`Cookie`) and TRANSPORT
 * METHOD (`transport`: `ssh` tunnel + systemd exec, or `http` direct endpoint) are ORTHOGONAL;
 * the runtime resolves ONE provider per spec BY TRANSPORT, with a legacy kind-keyed fallback. The
 * provider owns spec validation (whitelist-gated, option-injection safe), argv/endpoint, stderr
 * classification + redaction and the exec channel; the runtime owns the lifecycle.
 * v1 compat: wire typings keep the `Ssh*` aliases; legacy `kind:'ssh'` migrates.
 */

/** Target kinds shipped: the spec `kind` field — `dsh` (web profile, no auth
 *  surface) or `gateway` (authenticated server shape). Future targets extend the union. */
export const TARGET_KINDS = ['dsh', 'gateway'] as const

/** Transport methods shipped: the spec `transport` field — `ssh` (tunnel subprocess +
 *  systemd exec) or `http` (direct endpoint). Providers register BY transport; the
 *  spec's `kind` decides target semantics (auth-header injection, `/chamber/*`). */
export const TRANSPORT_METHODS = ['ssh', 'http'] as const

/** Renderer/registry resource budgets, enforced again in the main process. */
export const MAX_TRANSPORT_INSTANCES = 32
export const MAX_INSTANCE_LABEL_CHARS = 128

/**
 * The registry id whitelist: id rides the per-instance reverse-proxy connectionId
 * (`<kind>:<id>` → source id `dsh-<id>` / `gateway-<id>`) and transport keys, so it must
 * be a plain identifier and must not collide with the reserved 'local' source id.
 * Single source of truth — enforced by every provider's validateSpec via the shared check.
 */
export const INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]{1,64}$/

/** Open-ended kind union: autocompletes the shipped kinds while still accepting a future target
 *  string; the runtime resolves the provider registry by `spec.transport` first. */
export type TransportKind = (typeof TARGET_KINDS)[number] | (string & {})

/** Open-ended transport-method union: autocompletes the shipped methods while accepting a future string. */
export type TransportMethod = (typeof TRANSPORT_METHODS)[number] | (string & {})

/** Tunnel lifecycle phase machine. */
export type TransportPhase = 'idle' | 'connecting' | 'ready' | 'degraded' | 'error'

/** Instance spec as accepted on save (optional input fields per the wire contract; legacy kinds
 *  migrate in transport-manager). */
export interface TransportInstanceInput {
  id: string
  label: string
  /** Target type: 'dsh' | 'gateway'; omitted legacy entries migrate in transport-manager
   *  (kind:'ssh'→dsh, missing→dsh). */
  kind?: TransportKind
  /** Transport method: 'ssh' | 'http'; inferred from kind when omitted (dsh→ssh,
   *  gateway→http). */
  transport?: TransportMethod
  host: string
  user?: string | null
  /** SSH daemon port; null = ssh default (22 or the host's ~/.ssh/config Port). */
  sshPort?: number | null
  /** The remote dsh web profile port on the host (the tunnel destination). */
  remotePort: number
  serviceName?: string | null
  /** Remote dsh home: `~/.dsh` or an absolute path; null = remote default. Non-secret. */
  remoteDshHome?: string | null
  /** transport='http' only: true = plaintext http origin (default false = https). Non-secret,
   *  and NOT part of the credential-target comparison: an http↔https switch keeps credentials. */
  insecureHttp?: boolean
  /** transport='http' gateway targets only: optional SPKI pin — hex sha256 of the peer cert's SPKI
   * DER, `^[0-9a-fA-F]{64}$` (validateSpec refuses anything else), https-only. The pin is the trust
   * anchor, so an internal CA needs no NODE_EXTRA_CA_CERTS; a mismatch is terminal. Excluded from the
   * credential-target comparison — it is not a credential. */
  spkiPin?: string
}

/** Normalized non-secret instance spec as held by the registry. */
export interface TransportInstanceSpec {
  id: string
  label: string
  /** Target type: 'dsh' | 'gateway'; decides auth-header injection and /chamber/* mounting,
   *  NOT the transport — see `transport`. */
  kind: TransportKind
  /** The runtime resolves the provider by this field (legacy kind-keyed fallback retained). */
  transport: TransportMethod
  host: string
  user: string | null
  sshPort: number | null
  /** The remote dsh web profile port on 127.0.0.1 / the host (the tunnel destination). */
  remotePort: number
  /** Remote systemd unit name; null = the instance's start/stop is not managed. */
  serviceName: string | null
  /** Normalized `~/.dsh` or absolute path; null = default. Non-secret. */
  remoteDshHome: string | null
  /** transport='http' only: true = plaintext http origin. Non-secret, normalized required;
   *  excluded from the credential-target comparison (http↔https keeps credentials). */
  insecureHttp: boolean
  /** transport='http' gateway targets only: optional SPKI pin (hex sha256 of the peer cert's
   * SPKI DER); absent = no pinning. See TransportInstanceInput.spkiPin. Non-secret. */
  spkiPin?: string
}

/** Canonical v1→v2 input normalization shared by registry load/save and the authoritative save IPC:
 *  one place makes the optional `transport` wire contract real instead of accepting it in
 *  TypeScript while rejecting it at the main-process boundary. */
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

/** Best-effort signal to a spawned child (shared by kill/escalation and teardown). */
export function signalChild(child: SpawnedProcess | null, signal: NodeJS.Signals) {
  if (child === null) return
  try {
    child.kill(signal)
  } catch { /* already gone */ }
}

/**
 * The non-secret status projection: phase, local ports, retryAttempt, requiresUserAction,
 * serviceActive, logSummary. Never a tunnel URL, never credential material. `kind`/`transport`
 * let the renderer branch; `insecureHttp` drives the honest 明文 badge.
 */
export interface TransportStatusProjection {
  kind: TransportKind
  /** The live mechanism ('ssh' tunnel vs 'http' direct endpoint). Non-secret. */
  transport: TransportMethod
  /** transport='http': true = plaintext origin — the 明文 badge stays visible after configuring. Non-secret. */
  insecureHttp: boolean
  phase: TransportPhase
  localPort: number | null
  sshPort: number | null
  remotePort: number
  retryAttempt: number
  requiresUserAction: boolean
  /**
   * Class of the terminal failure behind `requiresUserAction`, so the UI never conflates the two
   * repair surfaces:
   * - 'auth' — transport/credential-level failure (SSH auth, host key, spawn): the TRANSPORT is
   *   broken and the user must fix credentials/host key.
   * - 'endpoint' — the transport reached the destination and it ANSWERED at protocol level but
   *   rejected (wrong version / breaking change / non-dsh service, or gateway 401/403); an SSH
   *   auth hint would be a lie.
   * null whenever requiresUserAction is false.
   */
  userActionKind: 'auth' | 'endpoint' | null
  /** Last known remote-service activation state (ssh: systemd); null = no serviceName, or
   *  start/stop/is-active not run yet (on-demand writes only — no polling). */
  serviceActive: boolean | null
  /** Remote dsh home (non-secret metadata). */
  remoteDshHome: string | null
  logSummary: string
}

/**
 * Remote-service exec outcome (ssh: systemctl): never thrown; ok carries the fresh status projection
 * (serviceActive included), failure an error string.
 *
 * `run` exec captures `stdout` (UTF-8-decoded, lossy for binary) and `stdoutBytes` (RAW, for
 * byte-domain consumers) only for whitelisted `exec` reads; `write-file` verifies its read-back
 * with a streaming SHA-256 digest and returns status only.
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

/** Spawn-result surface the runtime needs — satisfied by the real ChildProcess and the tests' fake. */
export interface SpawnedProcess {
  stdin: { write(chunk: string | Buffer): unknown; end(): unknown } | null
  stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** The endpoint a transport exposes to probes (always the local tunnel listener 127.0.0.1:<localPort>). */
export interface TransportProbeEndpoint {
  host: string
  port: number
}

/** One-shot endpoint identity verification outcome. */
export interface TransportVerifyResult {
  ok: boolean
  /** Non-secret reason (hostnames/ports only, never credentials); shown in logs and logSummary. */
  detail?: string
  /**
   * True = deterministic failure: the destination ANSWERED and proved it is not a compatible dsh
   * (wrong HTTP answer / version / protocol) — retrying cannot change the answer, so the runtime
   * lands on error immediately (requiresUserAction, no reconnect). Absent/false = transient:
   * the bounded reconnect path applies.
   */
  terminal?: boolean
}

/** One complete stderr line, classified by the provider. */
export interface StderrClassification {
  /**
   * Redacted display text (trimEnd'ed); empty lines are dropped. PRECEDENCE: a provider must never
   * return { log: '', terminalAuth: true } — terminalAuth is only evaluated on non-empty lines.
   */
  log: string
  /** True = terminal auth/host-key failure: never auto-retried, requiresUserAction. */
  terminalAuth: boolean
  /**
   * True = the RAW line is an "absent file" signal (remote `cat` ENOENT), classified on the
   * UNREDACTED text — redaction can replace the whole line (a `.ssh*`-named remote home path) and
   * erase the signal the `run` caller's ENOENT classification relies on.
   */
  enoent: boolean
}

/** Remote-service exec channel action (ssh: systemctl start|stop|restart|is-active;
 *  `run` = a whitelisted remote command). */
export type TransportExecAction = 'start' | 'stop' | 'restart' | 'is-active' | 'run'

/** The `run`-channel remote command whitelist — single source of truth (plugin-sync's contract A
 *  types import it). The union equals the EXECUTABLE set enforced by buildRemoteExecArgv:
 *  'base64'/'mkdir' are NOT exec commands (write-file builds them into its own shell template),
 *  so they are deliberately absent. */
export type TransportRunCommand = 'dsh' | 'cat' | 'printf'

/** The `run` action payload: a whitelisted remote command (`exec`) or a file write over ssh stdin (`write-file`). */
export interface TransportRunPayload {
  op: 'exec' | 'write-file'
  /** op='exec': remote command name (whitelisted). */
  command?: TransportRunCommand
  /** op='exec': argv after the command name (whitelisted per command). */
  argv?: string[]
  /** op='write-file': target path (whitelisted prefixes). */
  path?: string
  /** op='write-file': file bytes, base64-encoded (no shell quoting needed). */
  contentBase64?: string
  /** op='write-file': expected SHA-256 hex of the decoded content (verified after write). */
  sha256?: string
  /**
   * True = a non-zero exit is EXPECTED (first-seed probe of a not-yet-existing file): still
   * `ok:false` with the same error text (callers' ENOENT classification keeps working), but the
   * ERROR-level "run command failed" log and raw-stderr INFO echo are suppressed so an expected
   * probe does not pollute the log panel. Auth failures are NEVER silenced.
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
 * Provider-owned environment material leased to exactly one transport child; values may name
 * ephemeral resources (ssh: SSH_ASKPASS), so the runtime keeps them alive until the child exits or
 * reports a spawn error and releases them if spawn throws. `release` must be idempotent because
 * Node may report both error and exit.
 */
export interface TransportSpawnLease {
  env: NodeJS.ProcessEnv
  release(): void
}

/** The provider surface the runtime drives: a provider is pure transport know-how and never sees timers, phases or the registry. */
export interface TransportProvider {
  /** The registry key this provider declares (normally the transport method, or a test/future key);
   *  the runtime resolves by `spec.transport` with a legacy kind-keyed fallback. */
  kind: TransportKind
  /**
   * Whitelist-gated spec validation (option-injection safe): null = reject the entry (dropped
   * loudly, never silently half-kept). A transport-selected provider may serve multiple target
   * kinds (ssh and http both serve dsh|gateway); it must preserve/whitelist the target kind,
   * normalize its transport mechanism and `insecureHttp`, and loudly reject a spec whose
   * kind/transport it cannot serve rather than mis-serve it.
   */
  validateSpec(input: unknown): TransportInstanceSpec | null
  /** argv of the transport process for one start (direct-endpoint providers omit it). CONTRACT:
   *  display-safe — the runtime may log it into a renderer-visible summary (host/user/ports only,
   *  never credentials or tokens). */
  buildStartArgs?(spec: TransportInstanceSpec, localPort: number): readonly string[]
  /**
   * Optional leased extra environment for the transport process (merged over process.env):
   * per-instance non-argv material such as SSH_ASKPASS. The runtime releases the lease only after
   * child exit/error, or immediately when spawn throws; absent/null = inherit process.env unchanged.
   */
  buildStartEnv?(spec: TransportInstanceSpec): TransportSpawnLease | null
  /** Optional per-instance resource retirement (ssh: stop handing out old askpass generations
   *  without invalidating live child leases), called when an instance's transport is stopped
   *  (disconnect/removal/quit). Never called for an instance the provider does not know. */
  disposeAuth?(spec: TransportInstanceSpec): void
  /** Optional FINAL per-instance cleanup (ssh: purge every unleased askpass generation, defer live
   *  ones to child-scoped release), called ONLY when an instance is REMOVED — never on plain
   *  disconnect. Absent = disposeAuth already covers removal. */
  purgeAuth?(spec: TransportInstanceSpec): void
  /** Probe target for DIRECT ENDPOINT providers (ignored in tunnel mode). */
  probeTarget?(spec: TransportInstanceSpec): { host: string; port: number }
  /** Ready URL for DIRECT ENDPOINT providers (ignored in tunnel mode). */
  endpointUrl?(spec: TransportInstanceSpec): string | null
  /** Classify one COMPLETE stderr line of the transport process. */
  classifyStderr(line: string): StderrClassification
  /** Optional redaction for NON-stderr channels (tunnel stdout): stderr is redacted inside
   *  classifyStderr, but stdout would otherwise land in the ring verbatim (a misbehaving remote
   *  could echo path/credential-shaped text). Applied per chunk. Absent = no redaction. */
  redactOutput?(text: string): string
  /**
   * Optional one-shot endpoint identity verification (dsh: the unified host-identity handshake —
   * fixed-size session/canOpenWorkspacePath boolean; the legacy session/list arm only re-answers a
   * pre-identity runtime tree on 404). Called once after the probe reports the endpoint up and
   * BEFORE the phase may become ready — a port merely accepting TCP is not proof of a dsh instance.
   * Absent = the transport probe is trusted alone.
   * CONTRACT: verifyUp MUST settle within its own bounded deadline (the transport layer awaits it
   * bare, no outer timeout); a provider that can hang would permanently occupy the connect/reverify
   * single-flight.
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
 * v1 wire-surface compat names (preload / renderer / connections typings); desktop internals use
 * the `Transport*` names above.
 */
export type SshInstanceInput = TransportInstanceInput
export type SshInstanceSpec = TransportInstanceSpec
export type SshStatusProjection = TransportStatusProjection
export type SshLogEntry = TransportLogEntry
export type SshPhase = TransportPhase

