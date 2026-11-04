/**
 * remote-forward-service — the production assembly of the Remote Browser
 * forward plane (design 28 §6.1/§7, W0/S1 slice).
 *
 * THE HOLE THIS MODULE FILLS. shell-ipc-browser.ts registers the four
 * dsh-chamber:forward-* channels but, until now, every flavor passed
 * service = null, so each call answered the typed forward_failed
 * ("forward ipc service is not assembled"). This module constructs the real
 * RemoteForwardManager once per process with every side effect that the
 * frozen/registry/budget modules deliberately do NOT own:
 *
 *   - source resolver: registry instance -> ForwardSource (the fingerprint is
 *     re-proved on every call through ctx.matchesNotificationSource, and the
 *     identity digest is sha256(kind|transport|host|user|sshPort|remotePort) so
 *     a retarget can never inherit the previous host's browser alias);
 *   - namespace store: ForwardNamespaces over <dataDir>/remote-browser-namespaces.json
 *     (atomic owner-only replace, load fail-closed: a corrupt file refuses every
 *     forward instead of reusing unknown aliases);
 *   - child ledger: ForwardChildLedger over <dataDir>/forward-children.json
 *     (0600, load fail-closed), plus the startup reapForwardChildren pass with a
 *     real process probe/killer. Unprovable identity NEVER kills: the probe
 *     throws when the exact argv cannot be read (macOS remains fail-closed; win32
 *     uses the CIM adapter in remote-forward-windows.ts) and the reaper keeps
 *     the record;
 *   - ports: alias-host bind/release probes and OS-assigned ephemeral ports
 *     (never 127.0.0.1), plus the 2s TCP listener probe the manager polls;
 *   - child launcher: ssh -N -L alias:port:127.0.0.1:target with shell:false,
 *     POSIX detached process groups, a bounded stderr classifier (auth vs
 *     local-bind), an idempotent stop (process group kill / taskkill /T /F), one
 *     askpass lease per child released exactly once, and a durable ledger record
 *     written BEFORE the launch is reported as started; a child whose start-time
 *     token cannot be read is refused (never faked);
 *   - openExternal: the injected edges.openExternal (void = ok, rejection =
 *     open_failed), deliberately NOT the app-wide 8/10s link bucket;
 *   - authorize: one native edges.showMessage confirmation (cancel is the
 *     default), then — only after the dialog resolved and the source proof still
 *     holds — the durable per-(source, identity) confirmed-port store.
 *
 * TRUST. Every input reaching the manager is already guarded by the registrar
 * (wire guards + sender/frame trust + the fingerprint proof). This module only
 * builds adapters; it never widens what the renderer can ask for.
 *
 * ENVIRONMENT / TODO(S1/W0). This tree has no node_modules, no real SSH source,
 * and neither macOS nor Windows: the real ssh/askpass spawn, the packaged
 * private-file adapter, the darwin process probe, and the real ssh/askpass
 * spawn are TODO and are NOT exercised here. Windows CIM parsing is pure and
 * unit-tested in test/forward/forward-windows.test.ts; the service adapters are
 * driven by fakes in test/forward/forward-service.test.ts.
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'

import { describeError } from './describe-error.ts'
import type { HostMessageOptions } from './host-edges.ts'
import { buildForwardArgs } from './remote-forward-args.ts'
import { parseWindowsProcessJson, windowsProcessQueryArgs } from './remote-forward-windows.ts'
import { ForwardChildLedger, reapForwardChildren, windowsTaskkillArgs } from './remote-forward-lifecycle.ts'
import type {
  ForwardChildRegistryStorage,
  ForwardKillPlan,
  ForwardKiller,
  ForwardProcessProbe,
  ForwardProcessSnapshot,
} from './remote-forward-lifecycle.ts'
import { RemoteForwardManager } from './remote-forward-manager.ts'
import type {
  ForwardChild,
  ForwardChildExit,
  ForwardChildLauncher,
  ForwardLaunchInput,
  ForwardListenerProbe,
  ForwardListArgs,
  ForwardListResult,
  ForwardOpenArgs,
  ForwardOpenResult,
  ForwardPortAllocator,
  ForwardReleaseArgs,
  ForwardReleaseResult,
  ForwardRetireResult,
  ForwardRequestArgs,
  ForwardRequestResult,
  ForwardSource,
  ForwardSourceResolver,
  ForwardTimers,
} from './remote-forward-manager.ts'
import { ForwardNamespaces } from './remote-forward-namespace.ts'
import type { ForwardNamespaceStorage } from './remote-forward-namespace.ts'
import type { ForwardIpcService } from './shell-ipc-browser.ts'
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { TransportInstanceSpec, TransportSpawnLease } from './transport-provider.ts'

/** Sub-directory under <userData> owned by the browser-forward plane. */
const FORWARD_DATA_DIR_NAME = 'remote-browser'
/** Persisted namespace/alias store (schema in remote-forward-namespace.ts). */
const NAMESPACE_FILE_NAME = 'remote-browser-namespaces.json'
/** Persisted child ledger (schema in remote-forward-lifecycle.ts). */
const CHILDREN_FILE_NAME = 'forward-children.json'
const ENABLEMENT_FILE_NAME = 'remote-browser-enabled.json'
/** Listener probe window: the manager polls the alias until this deadline. */
const DEFAULT_PROBE_TIMEOUT_MS = 2000
/** Bounded stderr capture per child (never logged, only classified). */
const STDERR_CAPTURE_MAX_BYTES = 8192
/** SIGTERM -> SIGKILL grace for one forward child on POSIX. */
const DEFAULT_STOP_GRACE_MS = 1500
/** Linux /proc/<pid>/stat field 22 (starttime), indexed after the comm field. */
const PROC_STARTTIME_INDEX = 19

/** Classification: the SSH identity was refused (askpass/OTP/permission). */
const AUTH_STDERR = /(?:Permission denied|Authentication failed|Too many authentication failures|Host key verification failed|No more authentication methods|no supported authentication methods)/iu
/** Classification: the LOCAL bind was refused (ExitOnForwardFailure). */
const BIND_STDERR = /(?:Address already in use|Cannot listen to port|Could not request local forwarding|administratively prohibited|bind \[[^\]]+\]:[^\n]*(?:in use|denied|not permitted))/iu

const execFileAsync = promisify(execFile)

/** One owner-only JSON file behind the namespace/ledger/enablement stores. */
export interface ForwardServiceStorage {
  readonly namespace: ForwardNamespaceStorage
  readonly ledger: ForwardChildRegistryStorage
  /** Optional; tests may omit it (then enablement is process-local). */
  readonly enablement?: ForwardBrowserEnablementStorage
}

/** Raw owner-only file behind the per-port enablement store. */
export interface ForwardBrowserEnablementStorage {
  read(): Promise<string | null>
  write(text: string): Promise<void>
}

/**
 * Persisted per-source/per-port enablement ("the user approved the system
 * browser for this namespace:port"). The row is keyed by (sourceId, identity)
 * and carries the confirmed port keys; a retarget/re-key asks again, so a NEW
 * machine never inherits the old one's browser permission.
 */
export interface ForwardBrowserEnablementStore {
  /** Load a durable store before the manager is constructed; absent = local only. */
  load?(): Promise<void>
  /** Legacy whole-source grant (kept for injected/test seams). */
  isEnabled(sourceId: string, identity: string): boolean
  /** Legacy whole-source grant (kept for injected/test seams). */
  markEnabled(sourceId: string, identity: string): void | Promise<void>
  /** Per-namespace:port confirmations for design 28 D9 (production store). */
  portsFor?(sourceId: string, identity: string): readonly string[]
  markPortEnabled?(sourceId: string, identity: string, namespace: number, targetPort: number): void | Promise<void>
}

/** Spawn options of one forward child (shell:false by construction). */
export interface ForwardSpawnOptions {
  readonly shell: false
  readonly detached: boolean
  readonly windowsHide: boolean
  readonly stdio: ['ignore', 'ignore', 'pipe']
  readonly env: NodeJS.ProcessEnv
}

/** The process surface the launcher reads (satisfied by the real ChildProcess). */
export interface ForwardSpawnProcessHandle {
  readonly pid: number | undefined
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  /** Optional: only the "spawn returned no pid" refusal uses it. */
  kill?(signal?: NodeJS.Signals): boolean
}

/** The spawn seam (tests substitute a fake child; production is node:child_process). */
export type ForwardSpawn = (
  command: string,
  args: readonly string[],
  options: ForwardSpawnOptions,
) => ForwardSpawnProcessHandle

/** Assembly options: every side effect has a production default and a test seam. */
export interface RemoteForwardServiceOptions {
  /** Owner-only storage root; default <userData>/remote-browser (see resolveDataDir). */
  readonly dataDir?: string
  /** Storage override (tests inject memory stores; production uses the 0600 adapter). */
  readonly storage?: ForwardServiceStorage
  readonly ports?: ForwardPortAllocator
  readonly probe?: ForwardListenerProbe
  readonly spawn?: ForwardSpawn
  /** Stop one child tree (POSIX process group / win32 taskkill); tests count calls. */
  readonly stopProcess?: (target: { readonly pid: number; readonly pgid: number | null }, isAlive?: () => boolean) => void
  /** Platform start-time token: /proc/<pid>/stat or ps -o lstart=. null = refuse. */
  readonly startTime?: (pid: number) => Promise<string | null>
  /** Askpass material for exactly one child (null = key/agent auth). */
  readonly authLease?: (sourceId: string) => TransportSpawnLease | null | Promise<TransportSpawnLease | null>
  readonly processProbe?: ForwardProcessProbe
  readonly killer?: ForwardKiller
  /** Startup reaper over the durable ledger (default on; never kills unprovable records). */
  readonly reapOnStart?: boolean
  readonly browserEnabled?: ForwardBrowserEnablementStore
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly mintId?: () => string
  readonly mintNamespace?: () => number
  readonly timers?: ForwardTimers
  readonly probeTimeoutMs?: number
  readonly probeIntervalMs?: number
  readonly releaseTimeoutMs?: number
  /** Bounded relaunch budget after a bound child dies (manager default 2 attempts). */
  readonly reconnect?: { readonly maxAttempts: number; readonly baseDelayMs: number; readonly maxDelayMs: number }
  /** Test seam for the per-source spawn throttle. */
  readonly spawnWindowMs?: number
  readonly stopGraceMs?: number
}

/** The assembled forward plane: the registrar's four calls plus shutdown. */
export interface RemoteForwardService extends ForwardIpcService {
  /** Delete/retarget teardown: close every forward and tombstone the alias. */
  retireSource(sourceId: string): Promise<ForwardRetireResult>
  /** App exit / sidecar shutdown: close every child (best effort, never throws). */
  dispose(): Promise<void>
}

/** The refusal half shared by all four results (the manager's own union). */
type ForwardFailure = { readonly ok: false; readonly error: { readonly code: 'forward_failed'; readonly detail: string } }

/** Stable non-secret detail: a code, never a path and never payload text. */
function readinessFailure(code: string): ForwardFailure {
  const detail = code === ''
    ? 'forward service storage is unavailable'
    : 'forward service storage is unavailable (' + code + ')'
  return { ok: false, error: { code: 'forward_failed', detail } }
}

function errorCodeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : ''
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** The structural slice of the shared owner-private file primitives we consume. */
interface PrivateFileModule {
  ensurePrivateDirectoryNoFollow(path: string, mode?: number): void
  readPrivateFileNoFollow(path: string, options?: { maxBytes?: number; tightenMode?: number }): { value: string }
  atomicWritePrivateFileNoFollow(path: string, value: string | Buffer, options?: { mode?: number }): void
}

function createPrivateJsonFile(
  module: PrivateFileModule,
  file: string,
): { read(): Promise<string | null>; write(text: string): Promise<void> } {
  return {
    async read(): Promise<string | null> {
      try {
        return module.readPrivateFileNoFollow(file, { tightenMode: 0o600 }).value
      } catch (error) {
        // Absence is the first run; everything else (unsafe leaf, unreadable)
        // propagates so the store fails closed.
        if (isMissingFileError(error)) return null
        throw error
      }
    },
    async write(text: string): Promise<void> {
      module.atomicWritePrivateFileNoFollow(file, text, { mode: 0o600 })
    },
  }
}

/**
 * Ledger ownership attestation: a group/world-reachable children file is not a
 * trusted kill list, so the reaper kills nothing. win32 ACLs (icacls) are
 * TODO(S1/W0); the ledger still fails closed on read/parse there.
 */
async function verifyLedgerOwner(file: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  try {
    return (statSync(file).mode & 0o077) === 0
  } catch (error) {
    return isMissingFileError(error)
  }
}

/**
 * The production storage adapter: <dataDir>/remote-browser-{namespaces,children}.json
 * through the repository's single owner-private primitive (atomic replace, 0600,
 * no-follow). Imported lazily because the desktop package reaches that primitive
 * through control-plane-module.ts, whose workspace resolution needs the pnpm link
 * tree — tests inject storage and never take this path.
 * TODO(S1/W0): verify the packaged (compiled control-plane) adapter and the
 * owner-only ACL on a real install.
 */
async function createDefaultStorage(dataDir: string): Promise<ForwardServiceStorage> {
  const module = (await import('./control-plane-module.ts')) as unknown as PrivateFileModule
  module.ensurePrivateDirectoryNoFollow(dataDir)
  const childrenFile = path.join(dataDir, CHILDREN_FILE_NAME)
  return {
    namespace: createPrivateJsonFile(module, path.join(dataDir, NAMESPACE_FILE_NAME)),
    ledger: {
      ...createPrivateJsonFile(module, childrenFile),
      verifyOwner: () => verifyLedgerOwner(childrenFile),
    },
    enablement: createPrivateJsonFile(module, path.join(dataDir, ENABLEMENT_FILE_NAME)),
  }
}

/**
 * The owner-only storage root.
 *
 * ASSUMPTION (documented, not guessed at runtime): ctx.deps.ctx.localDshHome is
 * <userData>/state/dsh-home (shell-core.localDshHomeDir), so two dirnames up is
 * the userData root and the forward plane lives at <userData>/remote-browser,
 * next to the other desktop-owned state files. A flavor that ever injects a
 * different root shape moves this directory with it; the derivation is the
 * single place to change. TODO(S1/W0): confirm against a packaged install and a
 * Swift sidecar (its --user-data shape) before release.
 */
function resolveDataDir(ctx: ShellIpcCtx, options: RemoteForwardServiceOptions): string {
  if (typeof options.dataDir === 'string' && options.dataDir !== '') return options.dataDir
  const localDshHome = (ctx.deps.ctx as { localDshHome?: unknown }).localDshHome
  if (typeof localDshHome !== 'string' || localDshHome === '') {
    throw new Error('forward service cannot derive <userData> without ctx.deps.ctx.localDshHome')
  }
  return path.join(path.dirname(path.dirname(localDshHome)), FORWARD_DATA_DIR_NAME)
}

/** In-process enablement (tests and the no-storage fallback). */
class InMemoryBrowserEnablement implements ForwardBrowserEnablementStore {
  readonly #enabled = new Set<string>()
  readonly #ports = new Set<string>()

  isEnabled(sourceId: string, identity: string): boolean {
    return this.#enabled.has(sourceId + '\u0000' + identity)
  }

  markEnabled(sourceId: string, identity: string): void {
    this.#enabled.add(sourceId + '\u0000' + identity)
  }

  portsFor(sourceId: string, identity: string): readonly string[] {
    const prefix = sourceId + '\u0000' + identity + '\u0000'
    return [...this.#ports].filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
  }

  markPortEnabled(sourceId: string, identity: string, namespace: number, targetPort: number): void {
    this.#ports.add(sourceId + '\u0000' + identity + '\u0000' + String(namespace) + ':' + String(targetPort))
  }
}

const ENABLEMENT_STATE_VERSION = 1
const ENABLEMENT_MAX_ENTRIES = 512

function enablementStoreError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}

/**
 * Durable per-port enablement. The row key is (sourceId, identity) and each row
 * carries confirmedPorts, so a retarget asks again and a new port needs its own
 * grant. The write is awaited before the grant is reported. A corrupt or
 * unreadable file fails the service closed at startup (never an empty store).
 */
class FileBrowserEnablement implements ForwardBrowserEnablementStore {
  readonly #storage: ForwardBrowserEnablementStorage
  readonly #now: () => number
  readonly #entries = new Map<string, { readonly sourceId: string; readonly identity: string; readonly enabledAt: number; readonly confirmedPorts: readonly string[] }>()
  #loaded = false

  constructor(storage: ForwardBrowserEnablementStorage, now: () => number) {
    this.#storage = storage
    this.#now = now
  }

  async load(): Promise<void> {
    const text = await this.#storage.read()
    if (text === null) {
      this.#loaded = true
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw enablementStoreError('enablement_store_corrupt', 'enablement JSON is not parseable')
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw enablementStoreError('enablement_store_corrupt', 'enablement root is not an object')
    }
    const record = raw as { version?: unknown; entries?: unknown }
    if (record.version !== ENABLEMENT_STATE_VERSION || !Array.isArray(record.entries)) {
      throw enablementStoreError('enablement_store_corrupt', 'enablement schema is not version 1')
    }
    if (record.entries.length > ENABLEMENT_MAX_ENTRIES) {
      throw enablementStoreError('enablement_store_corrupt', 'enablement file exceeds the entry cap')
    }
    const next = new Map<string, { sourceId: string; identity: string; enabledAt: number; confirmedPorts: readonly string[] }>()
    for (const entry of record.entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw enablementStoreError('enablement_store_corrupt', 'enablement entry is not an object')
      }
      const row = entry as { sourceId?: unknown; identity?: unknown; enabledAt?: unknown; confirmedPorts?: unknown }
      if (typeof row.sourceId !== 'string' || row.sourceId === ''
        || typeof row.identity !== 'string' || row.identity === ''
        || typeof row.enabledAt !== 'number' || !Number.isFinite(row.enabledAt)) {
        throw enablementStoreError('enablement_store_corrupt', 'enablement entry fields are invalid')
      }
      // Schema v1 rows written before D9 have no confirmedPorts. They grant
      // NOTHING now: the next request must show the per-port dialog. This is a
      // deliberate fail-closed migration, not a silent whole-source carry-over.
      const ports = row.confirmedPorts === undefined ? [] : row.confirmedPorts
      if (!Array.isArray(ports) || ports.length > 256) {
        throw enablementStoreError('enablement_store_corrupt', 'enablement confirmedPorts is invalid')
      }
      const confirmedPorts: string[] = []
      for (const value of ports) {
        // The namespace half is opaque here (production is 2..254; tests may
        // inject 0). The port half is the real bound: 1..65535.
        if (typeof value !== 'string' || !/^\d+:(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/u.test(value)) {
          throw enablementStoreError('enablement_store_corrupt', 'enablement confirmedPorts entry is invalid')
        }
        confirmedPorts.push(value)
      }
      const key = row.sourceId + '\u0000' + row.identity
      if (next.has(key)) throw enablementStoreError('enablement_store_corrupt', 'enablement entry is duplicated')
      next.set(key, { sourceId: row.sourceId, identity: row.identity, enabledAt: row.enabledAt, confirmedPorts })
    }
    this.#entries.clear()
    for (const [key, value] of next) this.#entries.set(key, value)
    this.#loaded = true
  }

  isEnabled(sourceId: string, identity: string): boolean {
    // Source-wide grants are deliberately no longer honoured by the production
    // store: D9 requires a per-namespace:port confirmation.
    void sourceId
    void identity
    return false
  }

  portsFor(sourceId: string, identity: string): readonly string[] {
    return this.#entries.get(sourceId + '\u0000' + identity)?.confirmedPorts ?? []
  }

  async markPortEnabled(sourceId: string, identity: string, namespace: number, targetPort: number): Promise<void> {
    if (!this.#loaded) throw enablementStoreError('enablement_store_unloaded', 'enablement store is not loaded')
    const key = sourceId + '\u0000' + identity
    const previous = this.#entries.get(key)
    const portKey = String(namespace) + ':' + String(targetPort)
    if (previous?.confirmedPorts.includes(portKey) === true) return
    if (previous === undefined && this.#entries.size >= ENABLEMENT_MAX_ENTRIES) {
      throw enablementStoreError('enablement_store_full', 'enablement store is full')
    }
    const nextPorts = [...(previous?.confirmedPorts ?? []), portKey].sort()
    this.#entries.set(key, { sourceId, identity, enabledAt: previous?.enabledAt ?? this.#now(), confirmedPorts: nextPorts })
    try {
      await this.#storage.write(this.serialize())
    } catch (error) {
      if (previous === undefined) this.#entries.delete(key)
      else this.#entries.set(key, previous)
      throw error
    }
  }

  async markEnabled(sourceId: string, identity: string): Promise<void> {
    // Legacy seam kept for interface compatibility; the production path uses
    // markPortEnabled. Recording a source-wide entry would defeat D9.
    void sourceId
    void identity
    throw enablementStoreError('enablement_store_unsupported', 'source-wide enablement is not supported')
  }

  private serialize(): string {
    const entries = [...this.#entries.values()]
      .map(entry => ({ ...entry, confirmedPorts: [...entry.confirmedPorts].sort() }))
      .sort((left, right) => (left.sourceId + '\u0000' + left.identity).localeCompare(right.sourceId + '\u0000' + right.identity))
    return JSON.stringify({ version: ENABLEMENT_STATE_VERSION, entries })
  }
}

/**
 * Stable connection identity digest: sha256 over the registry facts that decide
 * whether "the same source id" still points at the same machine. A retarget
 * changes it, which rotates the browser namespace (and the alias) and re-asks
 * the confirmation.
 */
function forwardSourceIdentity(instance: TransportInstanceSpec): string | null {
  if (typeof instance.host !== 'string' || instance.host === '') return null
  if (typeof instance.kind !== 'string' || instance.kind === '') return null
  if (typeof instance.transport !== 'string' || instance.transport === '') return null
  if (!Number.isSafeInteger(instance.remotePort)) return null
  if (instance.sshPort !== null && !Number.isSafeInteger(instance.sshPort)) return null
  if (instance.user !== null && typeof instance.user !== 'string') return null
  return createHash('sha256')
    .update([
      instance.kind,
      instance.transport,
      instance.host,
      instance.user ?? '',
      instance.sshPort === null ? '' : String(instance.sshPort),
      String(instance.remotePort),
    ].join('|'))
    .digest('hex')
}

/**
 * The registry-backed source resolver. The fingerprint proof runs BEFORE the
 * registry lookup, so a forged source id never even walks the roster; the
 * manager's own gate then decides source_not_dsh / transport_not_ssh from the
 * real kind/transport instead of pretending the source is unknown.
 */
function createSourceResolver(
  ctx: ShellIpcCtx,
  enablement: ForwardBrowserEnablementStore,
): ForwardSourceResolver {
  return {
    resolve(sourceId: string, fingerprint: string): ForwardSource | null {
      if (typeof sourceId !== 'string' || typeof fingerprint !== 'string') return null
      if (!ctx.matchesNotificationSource(sourceId, fingerprint)) return null
      const instance = ctx.deps.ctx.transportManager
        .listInstances()
        .find(candidate => candidate.kind + '-' + candidate.id === sourceId)
      if (instance === undefined) return null
      const identity = forwardSourceIdentity(instance)
      if (identity === null) return null
      return {
        sourceId,
        fingerprint,
        kind: instance.kind,
        transport: instance.transport,
        ssh: { host: instance.host, user: instance.user, sshPort: instance.sshPort },
        remotePort: instance.remotePort,
        identity,
        browserEnabled: enablement.isEnabled(sourceId, identity),
        confirmedPorts: enablement.portsFor?.(sourceId, identity) ?? [],
      }
    },
  }
}

/** The confirm dialog's non-secret copy (the launcher never sees these facts). */
function authorizeOptions(source: ForwardSource, targetPort: number, sshPort: number | null): HostMessageOptions {
  const destination = source.ssh.user === null ? source.ssh.host : source.ssh.user + '@' + source.ssh.host
  return {
    type: 'question',
    title: '远程浏览器访问确认',
    message: '允许 ' + source.sourceId + ' 在本机浏览器打开远端端口 ' + String(targetPort) + ' 吗？',
    detail: '将通过 SSH（' + destination + '，端口 ' + String(sshPort ?? 22) + '）把远端 127.0.0.1:' + String(targetPort)
      + ' 转发到本机的专用回环地址，并用“系统浏览器”打开。注意：在关闭该转发前，本机任何进程都可以访问这个地址。'
      + '此确认只记住该端口的浏览器访问许可；连接目标或端口变更后会重新询问。',
    buttons: ['打开系统浏览器', '取消'],
    // Cancel is the default AND the escape action: Enter/Esc never grant access.
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }
}

/**
 * One native confirmation, then the browser permission is remembered — but only
 * for the SAME source incarnation: a retarget during the dialog (or a source
 * replaced behind it) yields false, and the registrar's post-await proof then
 * turns the call into source_changed.
 */
async function authorizeForward(
  ctx: ShellIpcCtx,
  source: ForwardSource,
  request: { readonly targetPort: number; readonly namespace: number },
  enablement: ForwardBrowserEnablementStore,
): Promise<boolean> {
  let response: number
  try {
    response = await ctx.deps.edges.showMessage(authorizeOptions(source, request.targetPort, source.ssh.sshPort))
  } catch {
    return false
  }
  if (response !== 0) return false
  if (!ctx.matchesNotificationSource(source.sourceId, source.fingerprint)) {
    const error = new Error('source changed during the native confirmation') as Error & { code?: string }
    error.code = 'confirmation_late'
    throw error
  }
  try {
    if (enablement.markPortEnabled !== undefined) {
      await enablement.markPortEnabled(source.sourceId, source.identity, request.namespace, request.targetPort)
    } else {
      await enablement.markEnabled(source.sourceId, source.identity)
    }
  } catch {
    // A durable grant is the permission; a failed write must not leave the
    // in-process store claiming access the user did not durably grant.
    return false
  }
  return true
}

/** The edges.openExternal seam as the manager's honest open result (void = ok). */
function createOpenExternal(ctx: ShellIpcCtx): { openExternal(url: string): Promise<{ ok: true } | { ok: false; detail: string | null }> } {
  return {
    async openExternal(url: string): Promise<{ ok: true } | { ok: false; detail: string | null }> {
      try {
        // The URL is main-composed (scheme + alias + local port + normalized
        // path); the rejection text is never relayed (no URL echo).
        await ctx.deps.edges.openExternal(url)
        return { ok: true }
      } catch {
        return { ok: false, detail: null }
      }
    },
  }
}

/** Bind (and release) one alias host:port; resolves the bound port. */
function bindAliasPort(host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    let settled = false
    server.once('error', (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    server.listen({ host, port, exclusive: true }, () => {
      if (settled) return
      const address = server.address()
      const bound = typeof address === 'object' && address !== null ? address.port : null
      if (bound === null || !Number.isSafeInteger(bound) || bound <= 0) {
        settled = true
        server.close()
        reject(new Error('alias bind reported no port'))
        return
      }
      settled = true
      server.close(() => resolve(bound))
    })
  })
}

/** Real port allocator: bind on the ALIAS host (never 127.0.0.1). */
function createNetPortAllocator(): ForwardPortAllocator {
  return {
    async isFree(host: string, port: number): Promise<boolean> {
      try {
        await bindAliasPort(host, port)
        return true
      } catch {
        return false
      }
    },
    async ephemeral(host: string): Promise<number> {
      return await bindAliasPort(host, 0)
    },
  }
}

/** Listener probe: TCP connect to alias:port, bounded (design 28 §3). */
function createNetListenerProbe(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): ForwardListenerProbe {
  return (host: string, port: number) => new Promise<boolean>(resolve => {
    const socket = net.connect({ host, port })
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/** Linux /proc/<pid>/stat field 22 (starttime), an opaque per-boot token. */
function readLinuxStartTime(pid: number): string | null {
  try {
    const raw = readFileSync('/proc/' + String(pid) + '/stat', 'utf8')
    // comm (field 2) is parenthesized and may contain spaces/parens.
    const close = raw.lastIndexOf(')')
    if (close === -1) return null
    const startTime = raw.slice(close + 1).trim().split(/\s+/u)[PROC_STARTTIME_INDEX]
    if (startTime === undefined || !/^[0-9]+$/u.test(startTime)) return null
    return 'linux:' + startTime
  } catch {
    return null
  }
}

/** Fallback start-time token (ps -o lstart= -p <pid>), platform-normalized. */
async function readPsStartTime(pid: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)])
    const text = String(stdout).trim()
    return text === '' ? null : 'ps:' + text
  } catch {
    return null
  }
}

/**
 * Query one Windows process through CIM: creation token + exact command line.
 * A missing PowerShell/CIM or an empty result is null (the caller refuses); it
 * is never a fabricated identity. The parser lives in remote-forward-windows.ts
 * so the quoting rules are unit-tested without a Windows host.
 */
async function readWindowsProcess(pid: number): Promise<{ readonly startTime: string; readonly argv: readonly string[] } | null> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', windowsProcessQueryArgs(pid), {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
    })
    const identity = parseWindowsProcessJson(String(stdout))
    return identity === null ? null : { startTime: identity.startTime, argv: identity.argv }
  } catch {
    return null
  }
}

/** The platform start-time token; null = the launcher must refuse to start. */
async function readProcessStartTime(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  if (platform === 'win32') {
    const info = await readWindowsProcess(pid)
    return info === null ? null : info.startTime
  }
  const linux = readLinuxStartTime(pid)
  if (linux !== null) return linux
  return await readPsStartTime(pid)
}

/** Exact argv from /proc/<pid>/cmdline (NUL-separated, no shell tokenizing). */
function readLinuxArgv(pid: number): string[] | null {
  try {
    const raw = readFileSync('/proc/' + String(pid) + '/cmdline', 'utf8')
    if (raw === '') return null
    const argv = raw.split('\u0000')
    while (argv.length > 0 && argv[argv.length - 1] === '') argv.pop()
    return argv.length === 0 ? null : argv
  } catch {
    return null
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Real process probe (POSIX /proc). CONTRACT (remote-forward-lifecycle): null
 * ONLY when the OS proves the pid is gone; anything the probe cannot prove is a
 * throw, and the reaper then keeps the record and kills nothing.
 * darwin's exact argv remains fail-closed (ps cannot reproduce it); win32 uses
 * the CIM adapter in remote-forward-windows.ts.
 */
function createDefaultProcessProbe(platform: NodeJS.Platform): ForwardProcessProbe {
  return {
    async inspect(pid: number): Promise<ForwardProcessSnapshot | null> {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError('invalid pid for the forward process probe')
      if (platform === 'win32') {
        const info = await readWindowsProcess(pid)
        if (info === null) {
          if (!processExists(pid)) return null
          throw new Error('forward process probe cannot prove the Windows identity of pid ' + String(pid))
        }
        return { pid, startTime: info.startTime, argv: [...info.argv] }
      }
      const argv = readLinuxArgv(pid)
      if (argv === null) {
        if (!processExists(pid)) return null
        throw new Error('forward process probe cannot prove argv on platform ' + platform + ' (TODO S1/W0)')
      }
      const startTime = await readProcessStartTime(pid, platform)
      if (startTime === null) throw new Error('forward process probe cannot prove the start time of pid ' + String(pid))
      return { pid, startTime, argv }
    },
  }
}

/** Real kill adapter (POSIX process group SIGKILL / win32 taskkill /T /F). */
function createDefaultKiller(platform: NodeJS.Platform): ForwardKiller {
  return {
    async kill(plan: ForwardKillPlan): Promise<'killed' | 'not_found' | 'failed'> {
      if (!Number.isSafeInteger(plan.pid) || plan.pid <= 0) return 'failed'
      if (platform === 'win32') {
        try {
          await execFileAsync('taskkill', windowsTaskkillArgs(plan.pid), { windowsHide: true })
          return 'killed'
        } catch (error) {
          return (error as { code?: unknown }).code === 128 ? 'not_found' : 'failed'
        }
      }
      const target = plan.pgid !== null && Number.isSafeInteger(plan.pgid) && plan.pgid > 1 ? -plan.pgid : plan.pid
      try {
        process.kill(target, 'SIGKILL')
        return 'killed'
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ESRCH') return 'not_found'
        return 'failed'
      }
    },
  }
}

/** Signal the child tree: the process group when POSIX-detached, else the pid. */
function signalForwardTree(pid: number, pgid: number | null, signal: NodeJS.Signals): void {
  const target = pgid !== null && pgid > 1 ? -pgid : pid
  try {
    process.kill(target, signal)
  } catch {
    if (target === pid) return
    try {
      process.kill(pid, signal)
    } catch {
      /* already gone */
    }
  }
}

/**
 * Real stop: SIGTERM to the process group, SIGKILL after the grace (POSIX), or
 * taskkill /T /F on win32 (no Job Object addon in this package).
 * TODO(S1/W0): verify the escalation window on a real ssh child (macOS/Windows).
 */
function createDefaultStopProcess(
  platform: NodeJS.Platform,
  spawnFn: ForwardSpawn,
  graceMs: number,
): (target: { readonly pid: number; readonly pgid: number | null }, isAlive?: () => boolean) => void {
  return (target: { readonly pid: number; readonly pgid: number | null }, isAlive: () => boolean = () => true): void => {
    if (!isAlive()) return
    if (platform === 'win32') {
      try {
        // taskkill's own output is never read; the pipe keeps one stdio shape
        // for every spawn this module issues.
        spawnFn('taskkill', windowsTaskkillArgs(target.pid), {
          shell: false,
          detached: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
          env: { ...process.env },
        })
      } catch {
        /* taskkill unavailable: the ledger/reaper owns the leftover */
      }
      return
    }
    signalForwardTree(target.pid, target.pgid, 'SIGTERM')
    const timer = setTimeout(() => {
      // A child that already exited must not have its pid re-signalled after the
      // grace: the exit callback flips this predicate. This narrows (not fully
      // closes) the pid-reuse window; the start-time reaper remains the
      // authoritative guard for leftovers.
      if (!isAlive()) return
      signalForwardTree(target.pid, target.pgid, 'SIGKILL')
    }, Math.max(0, graceMs))
    timer.unref()
  }
}

/** Start-time token reader bound to the assembly platform. */
async function defaultStartTime(pid: number, platform: NodeJS.Platform): Promise<string | null> {
  return await readProcessStartTime(pid, platform)
}

/**
 * Askpass lease for one child; lazily loaded so the pure test slice never needs
 * the workspace link tree (ssh-provider reaches the control-plane facade).
 * TODO(S1/W0): verify against a password-auth source on a real machine.
 */
async function defaultAuthLease(ctx: ShellIpcCtx, sourceId: string): Promise<TransportSpawnLease | null> {
  const instance = ctx.deps.ctx.transportManager
    .listInstances()
    .find(candidate => candidate.kind + '-' + candidate.id === sourceId)
  if (instance === undefined) return null
  const module = await import('./ssh-provider.ts')
  return module.acquireSshAuthLease(instance)
}

/** Bounded stderr capture for one child (classified, never logged). */
function childStderrText(proc: ForwardSpawnProcessHandle): () => string {
  let text = ''
  const stream = proc.stderr
  if (stream !== null) {
    stream.on('data', (chunk: unknown) => {
      const piece = typeof chunk === 'string'
        ? chunk
        : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : ''
      if (piece === '') return
      text = (text + piece).slice(-STDERR_CAPTURE_MAX_BYTES)
    })
  }
  return () => text
}

/** Resolve the child's exit exactly once, classified from the captured stderr. */
function childExit(proc: ForwardSpawnProcessHandle, stderrText: () => string): Promise<ForwardChildExit> {
  let settle!: (exit: ForwardChildExit) => void
  const promise = new Promise<ForwardChildExit>(resolve => {
    settle = resolve
  })
  let done = false
  const finish = (code: number | null, signal: string | null, spawnError: boolean): void => {
    if (done) return
    done = true
    // Let pending stderr callbacks run before classifying (the last line often
    // arrives just before 'exit').
    setImmediate(() => {
      const text = stderrText()
      settle({
        code,
        signal,
        authFailed: !spawnError && AUTH_STDERR.test(text),
        bindFailed: !spawnError && BIND_STDERR.test(text),
      })
    })
  }
  proc.on('exit', (code: number | null, signal: string | null) => {
    finish(typeof code === 'number' ? code : null, typeof signal === 'string' ? signal : null, false)
  })
  proc.on('error', () => finish(null, null, true))
  return promise
}

/** Everything the launcher needs (all OS effects injected). */
interface ForwardLauncherDeps {
  readonly ledger: ForwardChildLedger
  readonly spawn: ForwardSpawn
  readonly authLease: (sourceId: string) => TransportSpawnLease | null | Promise<TransportSpawnLease | null>
  readonly startTime: (pid: number) => Promise<string | null>
  readonly stopProcess: (target: { readonly pid: number; readonly pgid: number | null }, isAlive?: () => boolean) => void
  readonly platform: NodeJS.Platform
}

/**
 * Spawn one forward child and record it BEFORE reporting the launch.
 *
 * Ordering (crash-safety, design 28 §3/§8):
 *   1. askpass lease acquired (one generation per child);
 *   2. ssh spawned with shell:false — the argv comes from buildForwardArgs, so no
 *      registry string can become a second word;
 *   3. the start-time token is read; when it cannot be read the child is stopped
 *      and the launch is refused (no fabricated identity — the reaper must be
 *      able to prove a leftover before it may kill it);
 *   4. the ledger record is committed; only then is the child reported as
 *      started. ssh -N can only bind after auth + request, so in practice the
 *      record lands before the listener exists; the residual window is bounded
 *      and covered by the next start's reaper;
 *   5. exit (normal or failed) removes the record and releases the lease exactly
 *      once; an unexpected exit leaves no in-memory state behind.
 */
async function launchForwardChild(deps: ForwardLauncherDeps, input: ForwardLaunchInput): Promise<ForwardChild> {
  // Defense in depth: the manager builds the argv with buildForwardArgs, and the
  // launcher re-derives it from the same spec and refuses to spawn a deviating
  // command line (a future manager edit cannot silently drop
  // ExitOnForwardFailure or retarget the remote side).
  const expected = buildForwardArgs(input.ssh, input.aliasHost, input.localPort, input.targetPort)
  if (expected.length !== input.argv.length || expected.some((arg, index) => arg !== input.argv[index])) {
    throw new Error('forward argv deviates from buildForwardArgs; refusing to spawn')
  }
  const lease = await deps.authLease(input.sourceId)
  let released = false
  const releaseLease = (): void => {
    if (released) return
    released = true
    try {
      lease?.release()
    } catch {
      /* release must be idempotent; a throwing adapter cannot undo the spawn */
    }
  }
  const env: NodeJS.ProcessEnv = lease === null ? { ...process.env } : { ...process.env, ...lease.env }
  let proc: ForwardSpawnProcessHandle
  try {
    proc = deps.spawn('ssh', [...input.argv], {
      shell: false,
      // POSIX process group so a stop/reap kills the whole ssh tree; win32 has
      // no Job Object addon, so taskkill /T covers it.
      detached: deps.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    })
  } catch (error) {
    releaseLease()
    throw error
  }

  const pid = typeof proc.pid === 'number' && Number.isSafeInteger(proc.pid) && proc.pid > 0 ? proc.pid : null
  const pgid = pid === null || deps.platform === 'win32' ? null : pid
  let exited = false
  const exit = childExit(proc, childStderrText(proc))
  void exit.then(() => { exited = true })
  let stopped = false
  const stop = (): void => {
    if (stopped || pid === null) return
    stopped = true
    try {
      deps.stopProcess({ pid, pgid }, () => !exited)
    } catch {
      /* already gone: the exit handler and the reaper own the rest */
    }
  }
  if (pid === null) {
    try {
      proc.kill?.('SIGKILL')
    } catch {
      /* no pid to signal */
    }
    releaseLease()
    throw new Error('ssh forward child reported no pid')
  }

  let startTime: string | null
  try {
    startTime = await deps.startTime(pid)
  } catch {
    startTime = null
  }
  if (startTime === null || startTime === '') {
    stop()
    releaseLease()
    throw new Error('cannot prove the ssh forward child start time; refusing to forward')
  }

  try {
    await deps.ledger.add({
      forwardId: input.forwardId,
      sourceId: input.sourceId,
      pid,
      startTime,
      // The ledger stores the FULL spawned argv, including the program name.
      // The OS identity probe (/proc/<pid>/cmdline, Windows CIM CommandLine)
      // returns argv[0] too; storing only buildForwardArgs() made every real
      // child an identity_mismatch at the next-start reaper.
      argv: ['ssh', ...input.argv],
      pgid,
      localHost: input.aliasHost,
      localPort: input.localPort,
      targetPort: input.targetPort,
    })
  } catch (error) {
    stop()
    releaseLease()
    throw error
  }

  // The listener attaches after the ledger write. A real ChildProcess that
  // already exited would have emitted 'exit' into the stream's buffered state
  // (stderr) / been missed (exit); the manager's probe then reports a bind-like
  // timeout and the ledger tombstone is reaped at the next start.
  // TODO(S1/W0): drill a fast-dying ssh (bad host) on a real machine.
  void exit.then(() => {
    releaseLease()
    // A failed removal only leaves a tombstone for the next start's reaper.
    void deps.ledger.remove(input.forwardId).catch(() => undefined)
  })
  return { exit, stop }
}

/** The manager's launcher seam over launchForwardChild. */
function createSshForwardLauncher(deps: ForwardLauncherDeps): ForwardChildLauncher {
  return {
    launch(input: ForwardLaunchInput): Promise<ForwardChild> {
      return launchForwardChild(deps, input)
    },
  }
}

/**
 * Startup reaper pass. It never kills what it cannot prove, and a failure in the
 * pass (a storage error while removing a tombstone) is logged and does NOT
 * disable forwarding: the record stays authoritative for the next start, which
 * is exactly the documented crash window.
 */
async function runStartupReap(
  ledger: ForwardChildLedger,
  storage: ForwardChildRegistryStorage,
  probe: ForwardProcessProbe,
  killer: ForwardKiller,
  platform: NodeJS.Platform,
): Promise<void> {
  const verifyOwnership = typeof storage.verifyOwner === 'function'
    ? () => (storage.verifyOwner as () => Promise<boolean>)()
    : undefined
  try {
    const report = await reapForwardChildren({
      ledger,
      probe,
      killer,
      planFor: platform === 'win32' ? record => ({ pid: record.pid, pgid: null }) : undefined,
      verifyOwnership,
    })
    if (report.reaped > 0) {
      console.warn('[dsh-chamber] remote-browser 回收遗留转发子进程：' + String(report.reaped)
        + ' 个（未证明身份的保留 ' + String(report.remaining) + ' 个）')
    }
  } catch (error) {
    console.warn('[dsh-chamber] remote-browser 启动回收失败（未执行任何 kill）：' + describeError(error))
  }
}

/**
 * Assemble the forward plane for one process. Construction is synchronous (the
 * registrar must receive a service now); the stores load and the reaper runs on
 * a ready promise, and every call fails CLOSED with a typed forward_failed until
 * that promise settles — a corrupt namespace/children file never becomes an
 * empty store, and never a partial service.
 *
 * Throws only for a construction-level mistake the caller must not paper over
 * (missing localDshHome, unusable options); shell-ipc-open-in.ts turns that into
 * service = null so the four channels keep answering the honest "not assembled"
 * refusal.
 */
export function createRemoteForwardService(
  ctx: ShellIpcCtx,
  options: RemoteForwardServiceOptions = {},
): RemoteForwardService {
  const platform = options.platform ?? process.platform
  const now = options.now ?? ((): number => Date.now())
  const spawnFn = options.spawn ?? (spawn as unknown as ForwardSpawn)
  const stopProcess = options.stopProcess
    ?? createDefaultStopProcess(platform, spawnFn, options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS)
  const startTime = options.startTime ?? ((pid: number) => defaultStartTime(pid, platform))
  const authLease = options.authLease ?? ((sourceId: string) => defaultAuthLease(ctx, sourceId))
  const ports = options.ports ?? createNetPortAllocator()
  const probe = options.probe ?? createNetListenerProbe()
  const processProbe = options.processProbe ?? createDefaultProcessProbe(platform)
  const killer = options.killer ?? createDefaultKiller(platform)
  const dataDir = resolveDataDir(ctx, options)
  const openExternal = createOpenExternal(ctx)

  let manager: RemoteForwardManager | null = null
  let failure: ForwardFailure | null = null

  const ready = (async (): Promise<void> => {
    const storage = options.storage ?? await createDefaultStorage(dataDir)
    const enablement: ForwardBrowserEnablementStore = options.browserEnabled
      ?? (storage.enablement === undefined
        ? new InMemoryBrowserEnablement()
        : new FileBrowserEnablement(storage.enablement, now))
    if (enablement.load !== undefined) await enablement.load()
    const sources = createSourceResolver(ctx, enablement)
    const namespaces = new ForwardNamespaces({
      storage: storage.namespace,
      now,
      ...(options.mintNamespace === undefined ? {} : { mintNamespace: options.mintNamespace }),
    })
    const ledger = new ForwardChildLedger({ storage: storage.ledger, now })
    await namespaces.load()
    await ledger.load()
    if (options.reapOnStart !== false) {
      await runStartupReap(ledger, storage.ledger, processProbe, killer, platform)
    }
    const launcher = createSshForwardLauncher({
      ledger,
      spawn: spawnFn,
      authLease,
      startTime,
      stopProcess,
      platform,
    })
    manager = new RemoteForwardManager({
      sources,
      namespaces: {
        ensure: input => namespaces.ensure(input),
        retire: sourceId => namespaces.retire(sourceId),
      },
      ports,
      probe,
      launcher,
      openExternal,
      authorize: (source: ForwardSource, request: { readonly targetPort: number; readonly namespace: number }) =>
        authorizeForward(ctx, source, request, enablement),
      now,
      ...(options.mintId === undefined ? {} : { mintId: options.mintId }),
      ...(options.timers === undefined ? {} : { timers: options.timers }),
      ...(options.probeTimeoutMs === undefined ? {} : { probeTimeoutMs: options.probeTimeoutMs }),
      ...(options.probeIntervalMs === undefined ? {} : { probeIntervalMs: options.probeIntervalMs }),
      ...(options.releaseTimeoutMs === undefined ? {} : { releaseTimeoutMs: options.releaseTimeoutMs }),
      ...(options.reconnect === undefined ? {} : { reconnect: options.reconnect }),
      ...(options.spawnWindowMs === undefined ? {} : { spawnWindowMs: options.spawnWindowMs }),
    })
  })().catch((error: unknown) => {
    manager = null
    failure = readinessFailure(errorCodeOf(error))
    console.warn('[dsh-chamber] remote-browser 转发存储不可用，四个通道返回 forward_failed：' + describeError(error))
  })

  const settled = async (): Promise<RemoteForwardManager | null> => {
    await ready
    return manager
  }

  const refuse = (): ForwardFailure => failure ?? readinessFailure('')

  return {
    async request(args: ForwardRequestArgs): Promise<ForwardRequestResult> {
      const current = await settled()
      if (current === null) return refuse()
      return await current.request(args)
    },
    async release(args: ForwardReleaseArgs): Promise<ForwardReleaseResult> {
      const current = await settled()
      if (current === null) return refuse()
      return await current.release(args)
    },
    async list(args: ForwardListArgs): Promise<ForwardListResult> {
      const current = await settled()
      if (current === null) return refuse()
      return await current.list(args)
    },
    async openInBrowser(args: ForwardOpenArgs): Promise<ForwardOpenResult> {
      const current = await settled()
      if (current === null) return refuse()
      return await current.openInBrowser(args)
    },
    async retireSource(sourceId: string): Promise<ForwardRetireResult> {
      const current = await settled()
      if (current === null) return { released: 0, namespaceRetired: false }
      return await current.retireSource(sourceId)
    },
    async dispose(): Promise<void> {
      await ready
      if (manager === null) return
      try {
        await manager.stopAll()
      } catch {
        /* shutdown best effort: the lifecycle reaper owns leftovers */
      }
    },
  }
}
