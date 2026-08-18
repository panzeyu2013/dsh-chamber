/**
 * Transport-provider abstraction (design 03 §2.2 / 05 §7-§8): the
 * connection-manager runtime (`transport-manager.ts`) is source-agnostic.
 * Every registry instance carries a `kind`; the runtime drives ONE
 * TransportProvider per manager (v1 ships `ssh`, `ssh-provider.ts`), and the
 * provider owns everything source-specific:
 * - spec validation (whitelist-gated, option-injection safe),
 * - the transport process argv — or `null` for a DIRECT ENDPOINT provider
 *   (no local tunnel process; the runtime probes `probeTarget()` and exposes
 *   `endpointUrl()`; e.g. a tailnet host that is reachable as-is),
 * - stderr classification (terminal auth vs transient) and redaction,
 * - the optional remote-service exec channel (`ssh`: systemd over ssh).
 *
 * The generic runtime owns the phase machine, bounded jittered reconnect,
 * ring-buffer logs, non-secret status projection, status pushes, child
 * supervision (SIGTERM → SIGKILL escalation) and the instance registry.
 *
 * v1 compat: the preload/renderer wire typings keep the `Ssh*` names (the
 * `SshInstanceInput`/`SshInstanceSpec`/`SshStatusProjection`/`SshLogEntry`
 * aliases below); desktop internals use the `Transport*` names.
 */

/** Transport kinds shipped in v1. Future kinds (tailscale, remote-tunnel …) extend the union. */
export const TRANSPORT_KINDS = ['ssh'] as const

/**
 * The registry id whitelist (design 03 §2.2): id rides /api/i/ssh-<id> path
 * segments and transport keys, so it must be a plain identifier and must
 * not collide with the reserved 'local' source id. Single source of truth —
 * enforced by every provider's validateSpec via the shared check.
 */
export const INSTANCE_ID_PATTERN = /^(?!local$)[a-zA-Z0-9_-]+$/

/**
 * Open-ended kind union: autocompletes the shipped kinds while still
 * accepting a future kind string (provider registry extensibility).
 */
export type TransportKind = (typeof TRANSPORT_KINDS)[number] | (string & {})

/** Tunnel lifecycle phase machine（隧道生命周期 phase 机）. */
export type TransportPhase = 'idle' | 'connecting' | 'ready' | 'degraded' | 'error'

/** Instance spec as accepted on save (kind, user, sshPort and serviceName are optional input). */
export interface TransportInstanceInput {
  id: string
  label: string
  /** Provider kind; omitted / legacy entries default to the manager's provider kind. */
  kind?: TransportKind
  host: string
  user?: string | null
  /** SSH daemon port; null = ssh default (22 or the host's ~/.ssh/config Port). */
  sshPort?: number | null
  /** The remote dsh web profile port on the host (the tunnel / direct endpoint destination). */
  remotePort: number
  serviceName?: string | null
  /** Remote dsh home (design 13 §4.2); `~/.dsh` or an absolute path, null = remote default `~/.dsh`. Non-secret. */
  remoteDshHome?: string | null
}

/** Normalized non-secret instance spec as held by the registry. */
export interface TransportInstanceSpec {
  id: string
  label: string
  kind: TransportKind
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
}

/**
 * The non-secret status projection (design 05 §8): phase, local ports,
 * retryAttempt, requiresUserAction, serviceActive, logSummary. Never a
 * tunnel URL, never credential material. `kind` lets the renderer branch
 * per provider.
 */
export interface TransportStatusProjection {
  kind: TransportKind
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
 * `run`-channel captures: `stdout` is the UTF-8-decoded view of the remote
 * stdout (lossy for binary content — replacement chars), and `stdoutBytes`
 * is the RAW captured bytes for byte-domain consumers (write-file SHA-256
 * verification, design 13 §4.1). Both are only present when the exec requested
 * stdout capture.
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
 * (tunnel mode: 127.0.0.1:<localPort>; direct endpoint mode: probeTarget). */
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

/**
 * The `run` action payload (design 13 §4.1): either a whitelisted remote
 * command (`exec`) or a file write over ssh stdin (`write-file`).
 */
export interface TransportRunPayload {
  op: 'exec' | 'write-file'
  /** op='exec': remote command name (whitelisted). */
  command?: 'dsh' | 'cat' | 'base64' | 'mkdir' | 'printf'
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
 * The provider surface the runtime drives. A provider is pure transport
 * know-how: it never sees timers, phases or the registry — the runtime does.
 */
export interface TransportProvider {
  kind: TransportKind
  /**
   * Whitelist-gated spec validation (option-injection safe). Null = reject
   * the entry (dropped loudly by the registry, never silently half-kept).
   * INVARIANT: the returned spec's `kind` MUST equal this provider's kind —
   * the runtime drops any entry whose kind mismatches (defense in depth).
   */
  validateSpec(input: unknown): TransportInstanceSpec | null
  /**
   * argv of the transport process for one start, given the allocated local
   * port. ABSENT (or returning null) selects the DIRECT ENDPOINT mode: no
   * child process, the runtime probes `probeTarget()` and exposes
   * `endpointUrl()`. CONTRACT: the returned argv is DISPLAY-SAFE — the
   * runtime logs it verbatim into the renderer-visible projection summary
   * (host/user/ports only; never credentials or tokens).
   */
  buildStartArgs?(spec: TransportInstanceSpec, localPort: number): readonly string[] | null
  /**
   * Optional extra environment for the transport process (merged over
   * process.env by the runtime). Providers use it to inject per-instance
   * non-argv material such as SSH_ASKPASS (ssh: password auth, design 05
   * §8). Absent/null = the child inherits the main process environment
   * unchanged.
   */
  buildStartEnv?(spec: TransportInstanceSpec): NodeJS.ProcessEnv | null
  /**
   * Optional per-instance resource cleanup (ssh: delete the ephemeral
   * askpass helper). Called by the runtime when an instance's transport is
   * stopped (disconnect, removal, app quit). Never called for an instance
   * the provider does not know.
   */
  disposeAuth?(spec: TransportInstanceSpec): void
  /** Probe target for DIRECT ENDPOINT providers (ignored in tunnel mode). */
  probeTarget?(spec: TransportInstanceSpec): { host: string; port: number }
  /** Ready URL for DIRECT ENDPOINT providers (ignored in tunnel mode). */
  endpointUrl?(spec: TransportInstanceSpec): string | null
  /** Classify one COMPLETE stderr line of the transport process. */
  classifyStderr(line: string): StderrClassification
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
