/**
 * A1 write-surface orchestrator (design 21 §6.2/§6.3; plan Phase 4.2-4.5
 * wiring): fuses the serial-queue executor (plugins-exec.ts, Phase 4.3), the
 * durable journal (plugins-journal.ts, Phase 4.2) and the installed-profile
 * projection (plugins-installed.ts, Phase 3a) behind the runtime-manager
 * single-writer lease (beginProfileWrite, Phase 4.1).
 *
 * Submit contract (install/remove/materialize):
 *   ① validate FIRST (whitelist family from the shared control-plane
 *      module + reserved-name deny + per-kind spec family + — for remove —
 *      membership in the CURRENT installed projection), then
 *   ② acquire the managed profile-write lease via the runtime manager; a
 *      refused lease maps to the existing /chamber/runtime 409 family, and
 *   ③ only with the lease held enqueue into the executor (its duplicate/full
 *      refusals pass through, releasing the lease again).
 *
 * Deferred intents: when the lease is refused because the runtime is busy or
 * pending (or the manager is not built yet, or the managed profile does not
 * exist yet), install/materialize submissions are PERSISTED as durable
 * deferred intents (<stateDir>/chamber-plugins/third-party/deferred.json —
 * same 0600 atomic no-follow discipline and corrupt-aside handling as the
 * journal, ≤ 64 KiB) and drained automatically on the next ready/degraded
 * edge (index.ts wiring). Remove is user-instant by design: it is NEVER
 * deferred, and recovery-phase refusals (runtime_recovery_required) are never
 * deferred either — only retry/restore are allowed there.
 *
 * Lease lifecycle: one lease per accepted op, held from enqueue acceptance
 * until the executor records the op's terminal state. The release rides the
 * executor's PER-OP terminal hook, registered at enqueue time — before the
 * worker can process the item — so a terminal that fires synchronously
 * inside enqueue (e.g. a pre-mutation backup failure) still releases the
 * lease exactly once. A lease count (not a bool) on the manager side lets
 * queued ops hold their leases concurrently; the executor's serial worker
 * keeps the actual DSH_HOME writes one at a time.
 *
 * dispose(): stops acceptance, kills the in-flight child and settles queued
 * ops as blocked (all terminals release their leases). The executor is
 * invalidated, not permanently destroyed: a later gateway start rebuilds it
 * lazily on the next successful lease (start-rollback retry shape).
 *
 * The dsh CLI launch is resolved PER SPAWN from the ACTIVE runtime workspace
 * (`resolveWorkspace()`, env → override → builtin anchor — the same source
 * control-plane spawns the managed instance from): node executable
 * (resolveNodeExecutable, shared with control-plane spawn-dsh) + the
 * workspace's installed entry (`node_modules/@deepseek-ai/dsh/lib/bin.js`)
 * or the dev source entry (tsx). A runtime version switch between ops can
 * therefore never leave the queue spawning a stale entry.
 */

import { existsSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  atomicWritePrivateFileNoFollow,
  ensurePrivateDirectoryNoFollow,
  isDeniedPluginName,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  readPrivateFileNoFollow,
  resolveNodeExecutable,
} from '@dsh-chamber/control-plane'
import type { SpawnFn } from './plugins-exec.ts'
import { createPluginsExec, PLUGIN_QUEUE_CAP, type PluginExec } from './plugins-exec.ts'
import type { ProfileWriteLease } from './runtime-manager.ts'
import { createPluginsJournal, thirdPartyRoot } from './plugins-journal.ts'
import type { JournalLogger, JournalOp, JournalPending } from './plugins-journal.ts'
import { isFileValue, MATERIALIZED_VALUE_MASK } from './plugins-installed.ts'
import type { ChamberInstalled } from './plugins-installed.ts'

/** Deferred-intent store: file name under the third-party root. */
export const DEFERRED_INTENTS_FILE = 'deferred.json'
/** Bounded read/write ceiling for deferred.json (design 21 §6.9 discipline:
 * the store can never grow past ~64 KiB; appends beyond it are refused). */
export const DEFERRED_INTENTS_MAX_BYTES = 64 * 1024
/** Materialize `file:` spec length cap (a staged absolute path plus prefix). */
export const MATERIALIZE_FILE_SPEC_MAX_CHARS = 4096
/** Maximum spec length on the registry install route (shared whitelist). */
export const INSTALL_SPEC_MAX_CHARS = MAX_PLUGIN_SPEC_CHARS
/** Drain-deadline bound (design 21 §6.9 default family): one drain run gives
 * up after this long and leaves the remaining intents to the next
 * ready/degraded edge (mirrors the single-op timeout). */
export const DRAIN_DEADLINE_MS = 10 * 60 * 1000

/** Durable deferred-install intent (install/materialize only; remove is
 * never deferred). */
export interface DeferredIntent {
  id: string
  ts: number
  kind: 'install' | 'materialize'
  name: string
  spec?: string
  initiator?: string
}

export type PluginTaskSubmitInput = JournalPending

/** Refusals the orchestrator answers with (the route maps these to the
 * design 21 §6.2 HTTP family: invalid/reserved → 400, everything else 409;
 * runtime_* mirror the /chamber/runtime codes). */
export type PluginTaskRefusalCode =
  | 'queue_full'
  | 'queue_busy'
  | 'runtime_busy'
  | 'runtime_pending'
  | 'runtime_recovery_required'
  | 'reserved'
  | 'invalid_name'
  | 'invalid_spec'
  | 'not_installed'
  | 'no_manifest'
  | 'persistence_failed'

export type PluginTaskSubmitResult =
  | { ok: true; opId: string; deferred: false }
  | { ok: true; deferred: true; intentId: string }
  | { ok: false; code: PluginTaskRefusalCode; error: string }

export interface PluginTaskTasksProjection {
  /** Journal ops, newest first (retention-capped by the journal). */
  tasks: JournalOp[]
  /** Durable deferred intents (install/materialize awaiting a ready edge). */
  deferred: DeferredIntent[]
  /** True while the executor has a mutation in flight. */
  busy: boolean
}

/** The structural runtime-manager surface the orchestrator drives (kept
 * minimal so lifecycle fakes stay compatible; production is
 * GatewayRuntimeManager). */
export interface GatewayRuntimeManagerLike {
  beginProfileWrite(): ProfileWriteLease
  resolveWorkspace(): { path: string; version: string | null; source: string }
  profileWriteInFlight(): boolean
  /** Runtime-mutation execution-window accessor (design 21 decision 6/7):
   * true while a runtime mutation writer (activation/apply-now/rollback/
   * restore/start/restart-exhausted rollback) is in flight. Wired as the
   * executor's canRun gate. */
  mutationInFlight(): boolean
}

export interface ChamberPluginTasksDeps {
  stateDir: string
  /** Lazy manager accessor: null before construction and after stop — a
   * submission then defers (install/materialize) or refuses (remove). */
  manager: () => GatewayRuntimeManagerLike | null
  /** Current connectionState projection ('starting'/'restarting' refuse). */
  statusProbe: () => string
  logger: JournalLogger
  /** Installed-profile projection (remove membership + absent-profile
   * deferral checks). */
  installed: ChamberInstalled
  /** Injectable spawn seam (tests only; production spawns the real dsh CLI
   * through the node executable resolution below). */
  spawn?: SpawnFn
  timeoutMs?: number
  /** Design 21 §6.3 "装完自动受控 restart 一次": after ≥1 drained intent's
   * op ran to ok, the orchestrator asks the wiring layer for ONE controlled
   * managed-dsh restart (mounts the freshly installed plugins). The wiring
   * lambda owns every gate (ready/degraded, recovery/pending phases, lease
   * and restart single-flight) and must NOT throw — a closed gate is a
   * skip, never an error. Absent (unit harnesses) → no restart is asked. */
  restartManaged?: () => Promise<void>
}

export interface ChamberPluginTasks {
  /** Startup reconciliation: journal pending ops from a previous run →
   * failed (preImage retained). Called once by the wiring layer at
   * construction. */
  reconcileJournal(): void
  /** Validate → lease → enqueue (or defer), per the module header. Throws
   * ONLY on deferred-store persistence failure (the route maps that to 500
   * persistence_failed, mirroring the sync-upload convention); every input/
   * runtime refusal is a result. */
  submit(input: PluginTaskSubmitInput, opts?: { defer?: boolean }): Promise<PluginTaskSubmitResult>
  /** Projection for GET /chamber/plugins/tasks. */
  tasks(): PluginTaskTasksProjection
  /** Current deferred intents (newest first). */
  deferredIntents(): DeferredIntent[]
  /** Remove one deferred intent by id. Returns true when it existed. */
  clearIntent(intentId: string): boolean
  /** Re-submit every deferred intent (ready-edge drain; index wiring).
   * Deferral is bypassed — a refused lease leaves the intent in place.
   * Serialized: concurrent calls collapse into the running drain. Drains in
   * WAVES paced by the executor queue cap (queue_full refusals wait for a
   * live-op slot before the next wave). Returns the number of intents
   * cleared (accepted ops move from the deferred store into the journal as
   * pending ops). When ≥1 drained op ran to ok, one controlled restart is
   * requested through deps.restartManaged (design 21 §6.3). */
  drainDeferred(): Promise<number>
  /** Stop acceptance, kill the in-flight child, settle queued ops blocked,
   * release every held lease. Idempotent; safe to call before any op ran. */
  dispose(): Promise<void>
}

interface DeferredStoreFile {
  version: 1
  intents: DeferredIntent[]
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Parse the package name a registry spec refers to (the trailing @version
 * segment, if any, is dropped; the whitelist guarantees the shape). */
function pluginSpecName(spec: string): string {
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/** Name + spec whitelist validation shared by install/materialize/remove. */
type ValidationOutcome =
  | { kind: 'refuse'; code: PluginTaskRefusalCode; error: string }
  | { kind: 'ok' }
  | { kind: 'defer-profile-absent' }

function validateSubmission(stateDir: string, input: PluginTaskSubmitInput, installed: ChamberInstalled): ValidationOutcome {
  const kind = input.kind
  const name = input.name
  const spec = input.spec

  if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
    return { kind: 'refuse', code: 'invalid_name', error: 'invalid plugin name' }
  }
  if (isDeniedPluginName(name)) {
    return {
      kind: 'refuse',
      code: 'reserved',
      error: 'plugin name is reserved (@deepseek-ai/* and @dsh-chamber/* cannot be installed or removed through the plugin model)',
    }
  }

  if (kind === 'remove') {
    if (spec !== undefined) {
      return { kind: 'refuse', code: 'invalid_spec', error: 'remove does not take a spec' }
    }
    // Membership is checked against the CURRENT installed projection: a
    // manifest that cannot prove the plugin installed refuses removal
    // (proxy honesty — never a silent no-op). Absent profile → no_manifest
    // (nothing to verify); corrupt profile → no_manifest with the corrupt
    // evidence (only the gateway log carries the detail).
    const projection = installed.read()
    if (!projection.ok) {
      const error = projection.code === 'profile_absent'
        ? 'managed profile is not initialized; cannot verify installed plugins'
        : 'managed profile is corrupted; cannot verify installed plugins'
      return { kind: 'refuse', code: 'no_manifest', error }
    }
    if (projection.dependencies[name] === undefined) {
      return { kind: 'refuse', code: 'not_installed', error: 'plugin is not installed on the managed profile' }
    }
    return { kind: 'ok' }
  }

  if (kind === 'install') {
    if (typeof spec !== 'string' || spec === '') {
      return { kind: 'refuse', code: 'invalid_spec', error: 'install requires a registry spec' }
    }
    if (spec.length > INSTALL_SPEC_MAX_CHARS || !PLUGIN_SPEC_PATTERN.test(spec)) {
      return { kind: 'refuse', code: 'invalid_spec', error: 'invalid registry spec' }
    }
    if (/^file:/iu.test(spec)) {
      return {
        kind: 'refuse',
        code: 'invalid_spec',
        error: 'file: specs are not accepted on the registry install route; upload the archive via PUT /chamber/plugins/materialize',
      }
    }
    if (pluginSpecName(spec) !== name) {
      return { kind: 'refuse', code: 'invalid_spec', error: 'spec must reference the submitted plugin name' }
    }
    // The managed profile does not exist yet (fresh gateway, dsh never
    // spawned): the mutation would fail against an absent manifest — defer
    // the intent until a ready edge has created the profile (design 21
    // §6.2: profile missing → deferred).
    const projection = installed.read()
    if (!projection.ok && projection.code === 'profile_absent') return { kind: 'defer-profile-absent' }
    return { kind: 'ok' }
  }

  // kind === 'materialize'
  if (typeof spec !== 'string' || spec === '') {
    return { kind: 'refuse', code: 'invalid_spec', error: 'materialize requires the staged file: spec' }
  }
  if (spec.length > MATERIALIZE_FILE_SPEC_MAX_CHARS || !/^file:/iu.test(spec) || /[\0\r\n]/u.test(spec)) {
    return { kind: 'refuse', code: 'invalid_spec', error: 'invalid materialize file: spec' }
  }
  const stagedPath = spec.slice('file:'.length)
  if (!isAbsolute(stagedPath)) {
    return { kind: 'refuse', code: 'invalid_spec', error: 'materialize file: spec must be an absolute path' }
  }
  // Defense in depth: only gateway-staged paths under the third-party root
  // may reach `dsh plugin add file:…` (the route stages under this root with
  // the private-file discipline; submit callers cannot smuggle other paths).
  const root = thirdPartyRoot(stateDir)
  const check = relative(root, stagedPath)
  if (check === '' || check.startsWith('..') || isAbsolute(check)) {
    return { kind: 'refuse', code: 'invalid_spec', error: 'materialize file: spec must be under the gateway staging root' }
  }
  const projection = installed.read()
  if (!projection.ok && projection.code === 'profile_absent') return { kind: 'defer-profile-absent' }
  return { kind: 'ok' }
}

export function createChamberPluginTasks(deps: ChamberPluginTasksDeps): ChamberPluginTasks {
  const { stateDir, logger } = deps
  const log = deps.logger.log.bind(deps.logger)
  const warn = deps.logger.warn.bind(deps.logger)
  const journal = createPluginsJournal(stateDir, logger)
  const deferredFilePath = (): string => join(thirdPartyRoot(stateDir), DEFERRED_INTENTS_FILE)

  /** Single-flight guard for drainDeferred (see drain). */
  let drainInFlight: Promise<number> | null = null
  /** Live executor; null between dispose() and the next lease-backed submit
   * (lazy rebuild — see the module header). */
  let executor: PluginExec | null = null

  // -----------------------------------------------------------------------
  // Deferred intent store (deferred.json; same 0700/0600 no-follow
  // discipline as the journal, corrupt evidence renamed aside, ≤ 64 KiB)
  // -----------------------------------------------------------------------

  function asideCorruptIntents(cause: unknown, text?: string): DeferredIntent[] {
    const aside = `${deferredFilePath()}.corrupt-${Date.now()}`
    warn(
      `plugins-tasks: deferred intent store is corrupt or unreadable (${messageOf(cause)}${text === undefined ? '' : `: ${text}`}); ` +
      `moving it aside to ${aside} and starting fresh`,
    )
    try {
      renameSync(deferredFilePath(), aside)
    } catch (error) {
      warn(`plugins-tasks: could not move the corrupt deferred intent store aside: ${messageOf(error)}`)
    }
    return []
  }

  function loadIntents(): DeferredIntent[] {
    let value: { value: string }
    try {
      value = readPrivateFileNoFollow(deferredFilePath(), {
        tightenMode: 0o600,
        requiredMode: 0o600,
        maxBytes: DEFERRED_INTENTS_MAX_BYTES,
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      return asideCorruptIntents(error)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(value.value)
    } catch (error) {
      return asideCorruptIntents(error)
    }
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as DeferredStoreFile).intents)) {
      return asideCorruptIntents(new Error('payload is not a {version, intents} object'))
    }
    const intents = (parsed as DeferredStoreFile).intents
    const valid = intents.filter(
      (intent): intent is DeferredIntent =>
        typeof intent === 'object'
        && intent !== null
        && typeof (intent as DeferredIntent).id === 'string'
        && typeof (intent as DeferredIntent).ts === 'number'
        && ((intent as DeferredIntent).kind === 'install' || (intent as DeferredIntent).kind === 'materialize')
        && typeof (intent as DeferredIntent).name === 'string'
        && ((intent as DeferredIntent).spec === undefined || typeof (intent as DeferredIntent).spec === 'string')
        && ((intent as DeferredIntent).initiator === undefined || typeof (intent as DeferredIntent).initiator === 'string'),
    )
    if (valid.length !== intents.length) {
      return asideCorruptIntents(new Error('some intents are malformed'), `${valid.length}/${intents.length} kept`)
    }
    return [...valid]
  }

  function persistIntents(intents: DeferredIntent[]): void {
    const text = `${JSON.stringify({ version: 1, intents } as DeferredStoreFile)}\n`
    if (Buffer.byteLength(text) > DEFERRED_INTENTS_MAX_BYTES) {
      throw new Error(`deferred intent store exceeds its ${DEFERRED_INTENTS_MAX_BYTES} byte bound`)
    }
    ensurePrivateDirectoryNoFollow(thirdPartyRoot(stateDir), 0o700)
    atomicWritePrivateFileNoFollow(deferredFilePath(), text, { mode: 0o600 })
  }

  /** Append one durable intent; throws when the store is full or unwritable
   * (the caller maps persistence failure to 500 persistence_failed). */
  function appendDeferredIntent(input: PluginTaskSubmitInput): DeferredIntent {
    const intent: DeferredIntent = { id: randomUUID(), ts: Date.now(), kind: input.kind as 'install' | 'materialize', name: input.name }
    if (input.spec !== undefined) intent.spec = input.spec
    if (input.initiator !== undefined) intent.initiator = input.initiator
    persistIntents([...loadIntents(), intent])
    return intent
  }

  function dropDeferredIntent(intentId: string): boolean {
    const intents = loadIntents()
    const next = intents.filter(intent => intent.id !== intentId)
    if (next.length === intents.length) return false
    persistIntents(next)
    return true
  }

  function newestFirst(intents: DeferredIntent[]): DeferredIntent[] {
    return intents
      .map((intent, index) => ({ intent, index }))
      .sort((a, b) => b.intent.ts - a.intent.ts || b.index - a.index)
      .map(entry => entry.intent)
  }

  /** Projection masking (design 21 §6.2/decision 18, P2 review): gateway-
   * local `file:` spec values (the materialize staging path) must never
   * leave this module toward the renderer — the readManifest discipline
   * applies to the tasks/deferred projections too. The mask keeps the
   * `file:` prefix so classifiers still recognise a materialize value. */
  function maskProjectedSpec(spec: string | undefined): string | undefined {
    if (spec === undefined) return undefined
    return isFileValue(spec) ? MATERIALIZED_VALUE_MASK : spec
  }

  /** Remove a materialize op's staged archive once it can never be consumed
   * again (design 21 P2 review — staged-archive GC): after the op went
   * terminal, or when a deferred intent is cleared. Best effort, guarded to
   * the gateway staging root; the op itself is unaffected by a failed
   * unlink. */
  function unlinkStagedArchive(spec: string | undefined): void {
    if (spec === undefined || !isFileValue(spec)) return
    const stagedPath = spec.slice('file:'.length)
    const root = thirdPartyRoot(stateDir)
    const check = relative(root, stagedPath)
    if (check === '' || check.startsWith('..') || isAbsolute(check)) return
    try {
      if (existsSync(stagedPath)) rmSync(stagedPath, { force: true })
    } catch (error) {
      warn(`plugins-tasks: could not remove the staged archive ${stagedPath}: ${messageOf(error)}`)
    }
  }

  /** Kill one crash-orphaned mutation child recorded on a pending journal op
   * (design 21 §6.3 P2 review): a gateway crash mid-mutation leaves the
   * detached `dsh plugin`/pnpm process group writing DSH_HOME. The group
   * (negative pid — the child is its leader) is killed first, then the pid
   * itself. Best effort; the reconcile never fails over a kill. */
  function killOrphanedChild(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 1) return
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ESRCH') {
          warn(`plugins-tasks: could not kill the orphaned mutation child ${target}: ${messageOf(error)}`)
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Executor lifecycle + lease bookkeeping
  // -----------------------------------------------------------------------

  /** Resolve the ACTIVE runtime workspace's CLI entry (installed artifact
   * preferred, dev source via tsx otherwise — the same resolution order
   * control-plane spawn-dsh uses for the managed instance's own spawn). */
  function resolveCliEntry(workspace: string): { entry: string; viaTsx: boolean } | null {
    const installed = join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(installed)) return { entry: installed, viaTsx: false }
    const source = join(workspace, 'apps', 'cli', 'src', 'bin.ts')
    if (existsSync(source)) return { entry: source, viaTsx: true }
    return null
  }

  /** Lazy executor construction (see the module header). The spawn command
   * is the resolved NODE executable; the per-op argv prefix (node args +
   * workspace CLI entry) and cwd come from cliLaunch, resolved per spawn so
   * a runtime version switch between ops is always followed. */
  function getExecutor(): PluginExec {
    if (executor !== null) return executor
    const nodeExec = resolveNodeExecutable()
    executor = createPluginsExec({
      stateDir,
      // The real command is the node executable (Electron-run gateway shapes
      // are out of scope: the gateway server runs under plain node). The
      // entry rides the per-op argv prefix below.
      dshCliPath: nodeExec.file,
      journal,
      statusProbe: deps.statusProbe,
      logger,
      spawn: deps.spawn,
      timeoutMs: deps.timeoutMs,
      // Execution-window gate (design 21 decision 6/7): a queued op is only
      // dequeued into a spawn when NO runtime mutation writer is in flight.
      // Ops already hold the profile-write lease; this guards the F7/
      // activation windows so a queued op never spawns mid-transaction (the
      // executor waits out the window within its bounded canRun poll before
      // marking the op blocked — see plugins-exec.ts awaitRunWindow). A null
      // manager (not built yet) has no runtime window to violate — submit
      // already refused/deferred before anything reached the queue.
      canRun: () => {
        const manager = deps.manager()
        return manager === null || !manager.mutationInFlight()
      },
      cliLaunch: () => {
        const manager = deps.manager()
        if (manager === null) {
          throw new Error('gateway runtime manager is unavailable; cannot resolve the dsh CLI workspace')
        }
        const workspace = manager.resolveWorkspace()
        const resolved = resolveCliEntry(workspace.path)
        if (resolved === null) {
          throw new Error(`no dsh CLI entry found in ${workspace.path}`)
        }
        // nodeExec.args covers the Electron-run-node edge (--expose-internals;
        // plain node adds nothing). The tsx loader rides --import for the dev
        // source shape, exactly like control-plane spawn-dsh.
        const prefix = [...nodeExec.args]
        if (resolved.viaTsx) prefix.push('--import', 'tsx/esm', resolved.entry)
        else prefix.push(resolved.entry)
        return { argvPrefix: prefix, cwd: workspace.path }
      },
    })
    return executor
  }

  async function submitWithLease(
    input: PluginTaskSubmitInput,
    release: () => void,
    onTerminal?: (status: 'ok' | 'failed' | 'blocked') => void,
  ): Promise<PluginTaskSubmitResult> {
    // The lease release rides the op's terminal hook, registered BEFORE the
    // worker can process the item — a terminal that fires synchronously
    // inside enqueue (pre-mutation backup failure, CLI resolution failure)
    // releases the lease exactly once; the queue's serial worker keeps
    // DSH_HOME writes one at a time under the count-based manager fence.
    // A materialize op's staged archive is removed once the op is terminal
    // (it can never be consumed again); the drain path passes an extra
    // terminal callback (design 21 §6.3 auto-restart once after drained
    // installs).
    const result = await getExecutor().enqueue(input, (_op, status) => {
      try {
        release()
      } catch (error) {
        warn(`plugins-tasks: profile-write lease release failed: ${messageOf(error)}`)
      }
      if (input.kind === 'materialize') unlinkStagedArchive(input.spec)
      log(`plugins-tasks: op terminal (${status}); profile-write lease released`)
      onTerminal?.(status)
    })
    if (!result.ok) {
      // The queue refused (full/busy/duplicate/disposed): nothing runs, so
      // the lease is released immediately — never held past its op.
      try {
        release()
      } catch (error) {
        warn(`plugins-tasks: profile-write lease release failed after queue refusal: ${messageOf(error)}`)
      }
      return { ok: false, code: result.code, error: result.error }
    }
    return { ok: true, opId: result.opId, deferred: false }
  }

  async function submitImpl(
    input: PluginTaskSubmitInput,
    allowDefer: boolean,
    onTerminal?: (status: 'ok' | 'failed' | 'blocked') => void,
  ): Promise<PluginTaskSubmitResult> {
    const outcome = validateSubmission(stateDir, input, deps.installed)
    if (outcome.kind === 'refuse') {
      return { ok: false, code: outcome.code, error: outcome.error }
    }
    if (outcome.kind === 'defer-profile-absent') {
      // The managed profile does not exist yet: defer install/materialize
      // until a ready edge has created it (design 21 §6.2); the drain/retry
      // path leaves the intent instead of looping.
      if (!allowDefer) {
        return { ok: false, code: 'no_manifest', error: 'managed profile is not initialized' }
      }
      const intent = appendDeferredIntent(input)
      log(`plugins-tasks: deferred ${input.kind} ${input.name} (${intent.id}); profile not initialized yet`)
      return { ok: true, deferred: true, intentId: intent.id }
    }

    const manager = deps.manager()
    if (manager === null) {
      // Runtime manager not built yet (gateway start window). install/
      // materialize persist as deferred intents; remove is user-instant
      // and refuses (never deferred).
      if (allowDefer && input.kind !== 'remove') {
        const intent = appendDeferredIntent(input)
        log(`plugins-tasks: deferred ${input.kind} ${input.name} (${intent.id}); gateway runtime is starting`)
        return { ok: true, deferred: true, intentId: intent.id }
      }
      return { ok: false, code: 'runtime_pending', error: 'gateway runtime manager is not initialized; retry when the managed instance is up' }
    }

    const lease = manager.beginProfileWrite()
    if (!lease.ok) {
      if (lease.code === 'runtime_recovery_required' || input.kind === 'remove') {
        // Recovery phases expose only their matching retry/restore; remove
        // is user-instant. Neither is ever deferred.
        return { ok: false, code: lease.code, error: lease.error }
      }
      if (allowDefer) {
        const intent = appendDeferredIntent(input)
        log(`plugins-tasks: deferred ${input.kind} ${input.name} (${intent.id}); ${lease.code}`)
        return { ok: true, deferred: true, intentId: intent.id }
      }
      return { ok: false, code: lease.code, error: lease.error }
    }
    return submitWithLease(input, lease.release, onTerminal)
  }

  return {
    reconcileJournal() {
      const reconciled = journal.reconcile()
      if (reconciled.length > 0) {
        warn(`plugins-tasks: journal reconciled ${reconciled.length} pending operation(s) from a previous run (marked failed)`)
      } else {
        log('plugins-tasks: journal reconciled; no pending operations carried over')
      }
      // Crash-orphan reaping (design 21 §6.3 P2 review): a pending op that
      // recorded a spawned child pid means the previous gateway process died
      // mid-mutation — its detached `dsh plugin`/pnpm child may still be
      // writing DSH_HOME. Kill it before any new mutation can start.
      for (const op of reconciled) {
        if (op.childPid !== undefined) killOrphanedChild(op.childPid)
      }
    },

    async submit(input, opts) {
      return submitImpl(input, opts?.defer !== false)
    },

    tasks() {
      // file: spec values are masked in the outward projection (gateway-local
      // paths never reach the renderer — design 21 decision 18/§6.2) and
      // childPid (a LIVE HOST PROCESS id of a pending mutation) never leaves
      // this module either (round-2 scan: projection hygiene).
      const tasks = journal.recent().map(op => {
        const projected = { ...op }
        delete projected.childPid
        if (projected.spec !== undefined) projected.spec = maskProjectedSpec(projected.spec)
        return projected
      })
      const deferred = newestFirst(loadIntents()).map(intent => ({
        ...intent,
        ...(intent.spec === undefined ? {} : { spec: maskProjectedSpec(intent.spec) }),
      }))
      return { tasks, deferred, busy: executor !== null && executor.workerBusy() }
    },

    deferredIntents() {
      return newestFirst(loadIntents()).map(intent => ({
        ...intent,
        ...(intent.spec === undefined ? {} : { spec: maskProjectedSpec(intent.spec) }),
      }))
    },

    clearIntent(intentId) {
      // The dropped intent's staged archive can never be consumed — remove
      // it (design 21 staged-archive GC); a persistence failure still answers
      // false and leaves the archive for a later sweep.
      const dropped = loadIntents().find(intent => intent.id === intentId)
      try {
        if (!dropDeferredIntent(intentId)) return false
      } catch (error) {
        warn(`plugins-tasks: could not clear deferred intent ${intentId}: ${messageOf(error)}`)
        return false
      }
      if (dropped !== undefined && dropped.kind === 'materialize') unlinkStagedArchive(dropped.spec)
      return true
    },

    async drainDeferred() {
      // Single-flight: concurrent drains (overlapping ready edges) collapse
      // into the running drain; each intent is re-submitted at most once per
      // drain round and the lease serializes the executor anyway. When ≥1
      // drained op ran to ok, one controlled restart is requested through
      // deps.restartManaged (design 21 §6.3 "装完自动受控 restart 一次" — a
      // plugin installed onto a RUNNING instance only mounts on the next
      // spawn).
      if (drainInFlight !== null) return drainInFlight
      const run = (async (): Promise<number> => {
        let cleared = 0
        // Restart-once semantics (design 21 §6.3 "装完自动受控 restart 一次"):
        // the request fires only after EVERY drained op of this run went
        // terminal AND at least one ran ok — requesting at the FIRST ok
        // terminal would race the still-pending drained ops (their
        // profile-write leases keep the wiring gate closed and the single
        // attempt would be lost).
        let acceptedInRun = 0
        let anyOkInRun = false
        let restartRequested = false
        const requestRestartNow = (): void => {
          restartRequested = true
          if (deps.restartManaged === undefined) return
          log('plugins-tasks: drained installs applied; requesting one controlled restart to mount them (design 21 §6.3)')
          try {
            void deps.restartManaged().catch(error => {
              warn(`plugins-tasks: controlled restart after drain failed: ${messageOf(error)}`)
            })
          } catch (error) {
            warn(`plugins-tasks: controlled restart after drain failed: ${messageOf(error)}`)
          }
        }
        const onDrainedTerminal = (status: 'ok' | 'failed' | 'blocked'): void => {
          if (status === 'ok') anyOkInRun = true
          acceptedInRun -= 1
          if (acceptedInRun <= 0 && anyOkInRun && !restartRequested) {
            // All drained ops of this run settled — no plugin-write lease of
            // this run can keep the restart gate closed anymore.
            requestRestartNow()
          }
        }
        // Wave pacing against the executor queue cap: a round submits every
        // stored intent; queue_full refusals (cap reached by ops that are
        // still pending/queued/running) wait for a live-op slot before the
        // next wave. Bounded overall so a pathological backlog or a stalled
        // op can never pin the drain forever — intents left behind retry on
        // the next ready/degraded edge.
        const drainDeadline = Date.now() + DRAIN_DEADLINE_MS
        for (;;) {
          const snapshot = loadIntents()
          if (snapshot.length === 0) break
          if (deps.manager() === null) break
          if (Date.now() > drainDeadline) {
            log(`plugins-tasks: deferred drain hit its ${DRAIN_DEADLINE_MS} ms bound with ${snapshot.length} intent(s) remaining`)
            break
          }
          let queueFull = false
          for (const intent of snapshot) {
            if (deps.manager() === null) break
            if (Date.now() > drainDeadline) break
            try {
              // defer:false — a refused lease leaves the intent for the next
              // ready edge; success (op accepted) clears it.
              const result = await submitImpl(
                { kind: intent.kind, name: intent.name, spec: intent.spec, initiator: intent.initiator },
                false,
                onDrainedTerminal,
              )
              if (result.ok && !result.deferred) {
                if (dropDeferredIntent(intent.id)) cleared += 1
                acceptedInRun += 1
              } else if (!result.ok && result.code === 'queue_full') {
                queueFull = true
              } else if (!result.ok && result.code === 'persistence_failed') {
                // The executor could not journal the op — a gateway write
                // failure, not a busy window; do not spin on it.
                warn(`plugins-tasks: deferred intent ${intent.id} could not be journaled: ${result.error}`)
              }
            } catch (error) {
              warn(`plugins-tasks: deferred intent ${intent.id} could not be drained: ${messageOf(error)}`)
            }
          }
          const remaining = loadIntents()
          if (remaining.length === 0) break
          if (!queueFull) break // lease/state refusals left intents — next edge retries them
          // Wave pacing: wait for a queue slot (an op terminal) before the
          // next wave — bounded by the drain deadline; intents still behind
          // it retry on the next ready/degraded edge.
          for (;;) {
            if (deps.manager() === null) break
            if (Date.now() > drainDeadline) break
            const exec = executor
            if (exec === null || exec.pendingCount() < PLUGIN_QUEUE_CAP) break
            await new Promise<void>(resolve => setTimeout(resolve, 25))
          }
        }
        if (cleared > 0) log(`plugins-tasks: drained ${cleared} deferred intent(s)`)
        return cleared
      })()
      drainInFlight = run
      try {
        return await run
      } finally {
        drainInFlight = null
      }
    },

    async dispose() {
      const exec = executor
      executor = null
      // Every queued/in-flight op already carries its lease release (per-op
      // terminal hook registered at enqueue), so dispose terminals release
      // all leases; the executor idempotence covers double disposal.
      if (exec !== null) await exec.dispose()
    },
  }
}

export function deferredIntentsFilePath(stateDir: string): string {
  return join(thirdPartyRoot(stateDir), DEFERRED_INTENTS_FILE)
}
