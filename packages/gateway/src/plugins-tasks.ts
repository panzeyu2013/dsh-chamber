/**
 * A1 write-surface orchestrator: serial-queue executor (plugins-exec.ts) +
 * durable journal (plugins-journal.ts) + installed-profile projection
 * (plugins-installed.ts), behind the runtime-manager single-writer lease.
 * Submit order is validate -> lease -> enqueue (a refused lease maps to the
 * /chamber/runtime 409 family); install/materialize refusals that could
 * become acceptable later persist as deferred intents drained on the next
 * ready/degraded edge, while remove and recovery-phase refusals never defer.
 * One lease per accepted op is held until the executor records the terminal,
 * and the dsh CLI is resolved PER SPAWN from the ACTIVE runtime workspace,
 * never a stale entry.
 */

import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  atomicWritePrivateFileNoFollow,
  decidePluginMutation,
  ensurePrivateDirectoryNoFollow,
  extractSpecName,
  MAX_PLUGIN_SPEC_CHARS,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  registrySpecVersion,
  resolveNodeExecutable,
} from '@dsh-chamber/control-plane'
import { resolveDshCliEntry } from '@dsh-chamber/dsh-runtime'
import { readPrivateTextOrNull } from './private-read.ts'
import { messageOf, newestFirst } from './util.ts'
import { resolveJudgementInputs } from './plugins-installed.ts'
import { latestUndoableOp } from './plugins-undo.ts'
import type { MutationSpawnFn } from '@dsh-chamber/control-plane'
import { createPluginsExec, PLUGIN_QUEUE_CAP, type PluginExec } from './plugins-exec.ts'
import type { ProfileWriteLease } from './runtime-manager.ts'
import { createPluginsJournal, thirdPartyRoot } from './plugins-journal.ts'
import type { JournalLogger, JournalOp, JournalPending } from './plugins-journal.ts'
import {
  INSTALLED_MANIFEST_MAX_BYTES,
  INSTALLED_PROFILE_DIR,
  isFileValue,
  MANAGED_DSH_HOME_DIR,
  MATERIALIZED_VALUE_MASK,
  type ChamberInstalled,
} from './plugins-installed.ts'

export const DEFERRED_INTENTS_FILE = 'deferred.json'
/** Bounded read/write ceiling for deferred.json: appends past it are refused. */
export const DEFERRED_INTENTS_MAX_BYTES = 64 * 1024
/** Materialize `file:` spec length cap (a staged absolute path plus prefix). */
export const MATERIALIZE_FILE_SPEC_MAX_CHARS = 4096
/** Maximum spec length on the registry install route (shared whitelist). */
export const INSTALL_SPEC_MAX_CHARS = MAX_PLUGIN_SPEC_CHARS
/** One drain run gives up after this long; leftovers wait for the next
 * ready/degraded edge (mirrors the single-op timeout). */
export const DRAIN_DEADLINE_MS = 10 * 60 * 1000

/**
 * Refusals that can never become acceptable by waiting: the drain drops the
 * intent (recording a failed op) instead of retrying forever; everything else
 * (queue/lease/runtime windows, missing manifest) stays deferred.
 * `protected-set-unavailable` is deliberately NOT here — the set may just not
 * be derivable YET, and treating that as permanent would delete a queued
 * install for good.
 */
const PERMANENT_DRAIN_REFUSALS: ReadonlySet<PluginTaskRefusalCode> = new Set([
  'protected', 'needs-version', 'needs-exact-version', 'generation-mismatch',
  'runtime-version-unknown', 'invalid-name', 'invalid_name', 'invalid_spec',
  'not_installed',
])

/** Durable deferred-install intent (install/materialize only). */
export interface DeferredIntent {
  id: string
  ts: number
  kind: 'install' | 'materialize'
  name: string
  spec?: string
  /** Declared version (see JournalOp.version): without it a deferred
   *  official-scope materialize is un-drainable and stays forever. */
  version?: string
  initiator?: string
}

export type PluginTaskSubmitInput = JournalPending

/** Refusals the orchestrator answers with (the route maps invalid/reserved to
 * 400, everything else to 409; runtime_* mirror the /chamber/runtime codes). */
export type PluginTaskRefusalCode =
  | 'queue_full'
  | 'queue_busy'
  | 'runtime_busy'
  | 'runtime_pending'
  | 'runtime_recovery_required'
  | 'reserved'
  | 'invalid-name'
  | 'protected'
  | 'needs-version'
  | 'needs-exact-version'
  | 'generation-mismatch'
  | 'protected-set-unavailable'
  | 'runtime-version-unknown'
  | 'invalid_name'
  | 'invalid_spec'
  | 'not_installed'
  | 'no_manifest'
  | 'no_undoable_op'
  | 'journal_unavailable'
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
  busy: boolean
}

/** The structural runtime-manager surface the orchestrator drives (kept
 * minimal so lifecycle fakes stay compatible). */
export interface GatewayRuntimeManagerLike {
  beginProfileWrite(): ProfileWriteLease
  resolveWorkspace(): { path: string; version: string | null; source: string }
  profileWriteInFlight(): boolean
  /** True while a runtime mutation writer is in flight (executor canRun gate). */
  mutationInFlight(): boolean
}

export interface ChamberPluginTasksDeps {
  stateDir: string
  /** Lazy manager accessor; null before construction and after stop. */
  manager: () => GatewayRuntimeManagerLike | null
  /** Current connectionState projection ('starting'/'restarting' refuse). */
  statusProbe: () => string
  logger: JournalLogger
  /** Installed-profile projection (remove membership + deferral checks). */
  installed: ChamberInstalled
  /** Injectable spawn seam (production spawns the real dsh CLI below). */
  spawn?: MutationSpawnFn
  timeoutMs?: number
  /** After ≥1 drained op ran to ok, asks for ONE controlled managed-dsh restart
   * (mounts the freshly installed plugins). The wiring lambda owns every gate
   * and must NOT throw — a closed gate is a skip, never an error. Absent →
   * no restart is asked. */
  restartManaged?: () => Promise<void>
}

export interface ChamberPluginTasks {
  /** Startup reconciliation: previous run's pending ops → failed (preImage
   * retained). A corrupt journal is NOT empty: the "no pending operations
   * carried over" judgement is suppressed and the pending set reported loudly. */
  reconcileJournal(): void
  /** Boot-time staged-archive orphan sweep, called once right AFTER
   * reconcileJournal (executor idle, no concurrent staging). Reclaims *.tgz
   * files under the third-party root that no manifest, deferred intent or live
   * journal op references; executed materialize ops RETAIN their archive. Only
   * successfully read sources license deletion — an unreadable manifest or a
   * corrupt journal skips the whole sweep. */
  sweepOrphanedStagedArchives(): void
  /** Validate → lease → enqueue (or defer). Throws ONLY on deferred-store
   * persistence failure (mapped to 500 persistence_failed); every input or
   * runtime refusal is a result. */
  submit(input: PluginTaskSubmitInput, opts?: { defer?: boolean }): Promise<PluginTaskSubmitResult>
  /** Projection for GET /chamber/plugins/tasks. */
  tasks(): PluginTaskTasksProjection
  /** Current deferred intents (newest first). */
  deferredIntents(): DeferredIntent[]
  /** Remove one deferred intent by id. Returns true when it existed. */
  clearIntent(intentId: string): boolean
  /** Re-submit every deferred intent (ready-edge drain); deferral is bypassed
   * (a refused lease leaves the intent) and concurrent calls collapse into the
   * running drain. Drains in WAVES paced by the queue cap, returning the number
   * cleared; after ≥1 drained op ran ok, one restart is requested. */
  drainDeferred(): Promise<number>
  /** Stop acceptance, kill the in-flight child, settle queued ops blocked, release every held lease. Idempotent. */
  dispose(): Promise<void>
}

interface DeferredStoreFile {
  version: 1
  intents: DeferredIntent[]
}

/** Name + spec whitelist validation shared by install/materialize/remove. */
type ValidationOutcome =
  | { kind: 'refuse'; code: PluginTaskRefusalCode; error: string }
  | { kind: 'ok' }
  | { kind: 'defer-profile-absent' }

function validateSubmission(input: PluginTaskSubmitInput, deps: ChamberPluginTasksDeps): ValidationOutcome {
  const kind = input.kind
  const name = input.name
  const spec = input.spec
  const installed = deps.installed

  if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
    return { kind: 'refuse', code: 'invalid_name', error: 'invalid plugin name' }
  }

  /**
   * Protected-set judgement: the gateway is the AUTHORITY for a gateway target
   * — family facts live here, the decision is op-phased (remove never judges a
   * version) and an official-scope install must pin this instance's exact
   * generation from the same resolveWorkspace() as /chamber/runtime/status.
   */
  const decide = (op: 'install' | 'remove', version: string | null): ValidationOutcome | null => {
    const manager = deps.manager()
    // Gateway start window (no manager) and corrupt runtime metadata (the
    // resolver throws): judge with the DEGRADED ladder (B₀ ∪ S + official-scope
    // installs refused) rather than skip the judgement — a protected name must
    // not sit in the deferred store until a later edge silently drops it. The
    // resolver's throw must not escape as a 500, so it runs behind a guarded
    // accessor; one resolution per judgement (resolveJudgementInputs).
    const inputs = resolveJudgementInputs(() => {
      if (manager === null) return null
      try {
        const workspace = manager.resolveWorkspace()
        return { path: workspace.path, version: workspace.version }
      } catch (error) {
        deps.logger.warn(`plugins-tasks: runtime facts unavailable (${messageOf(error)}); judging with the conservative ladder`)
        return null
      }
    })
    // F underivable ⇒ conservative ladder, not a blanket refusal:
    // official-scope installs are refused (stronger than generation), B₀ ∪ S
    // still protects, and third-party ops keep working.
    const decision = decidePluginMutation({
      op,
      name,
      version,
      runtimeVersion: inputs.runtimeVersion,
      derivation: inputs.derivation,
      // The profile-absent defer is decided by the callers' own projection
      // checks; this judgement is about the NAME, profile assumed ready.
      profileState: 'ready',
      familySource: inputs.familySource,
    })
    if (decision.kind === 'allow') return null
    if (decision.kind === 'defer') return { kind: 'defer-profile-absent' }
    return { kind: 'refuse', code: decision.code, error: decision.error }
  }

  if (kind === 'remove') {
    if (spec !== undefined) {
      return { kind: 'refuse', code: 'invalid_spec', error: 'remove does not take a spec' }
    }
    // Membership is checked against the CURRENT installed projection: a
    // manifest that cannot prove the plugin installed refuses removal (never a
    // silent no-op); absent/corrupt profile → no_manifest.
    const projection = installed.read()
    if (!projection.ok) {
      const error = projection.code === 'profile_absent'
        ? 'managed profile is not initialized; cannot verify installed plugins'
        : 'managed profile is corrupted; cannot verify installed plugins'
      return { kind: 'refuse', code: 'no_manifest', error }
    }
    // Removal is judged by P alone (never by a version), and BEFORE the
    // membership check: "this name can never be removed" outranks "not
    // currently installed" (mutable profile state).
    const refused = decide('remove', null)
    if (refused !== null) return refused
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
    if (extractSpecName(spec) !== name) {
      return { kind: 'refuse', code: 'invalid_spec', error: 'spec must reference the submitted plugin name' }
    }
    const refused = decide('install', registrySpecVersion(spec))
    if (refused !== null) return refused
    // The managed profile does not exist yet: the mutation would fail against
    // an absent manifest — defer until a ready edge has created the profile.
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
  // may reach `dsh plugin add file:…` — callers cannot smuggle others.
  const root = thirdPartyRoot(deps.stateDir)
  const check = relative(root, stagedPath)
  if (check === '' || check.startsWith('..') || isAbsolute(check)) {
    return { kind: 'refuse', code: 'invalid_spec', error: 'materialize file: spec must be under the gateway staging root' }
  }
  // The staged archive's declared version rides the submit input (a `file:` spec carries none).
  const refused = decide('install', typeof input.version === 'string' && input.version !== '' ? input.version : null)
  if (refused !== null) return refused
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

  let drainInFlight: Promise<number> | null = null
  /** Live executor; null between dispose() and the next lease-backed submit. */
  let executor: PluginExec | null = null

  // Deferred intent store: deferred.json, same 0700/0600 no-follow + corrupt-aside discipline as the journal, ≤ 64 KiB.

  /** Corruption observed on the deferred store by THIS instance (sticky): the
   * staged specs of the lost intents are unknown, so the boot sweep must not
   * read them as "nothing references those archives". */
  let deferredStoreCorrupt = false
  let deferredPriorEvidence: string[] | null = null
  function deferredCorruptionEvidence(): string[] {
    if (deferredPriorEvidence === null) {
      try {
        deferredPriorEvidence = readdirSync(thirdPartyRoot(stateDir))
          .filter(name => name.startsWith(`${DEFERRED_INTENTS_FILE}.corrupt-`))
      } catch {
        deferredPriorEvidence = []
      }
    }
    return deferredPriorEvidence
  }

  function asideCorruptIntents(cause: unknown, text?: string): DeferredIntent[] {
    deferredStoreCorrupt = true
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
    let text: string | null
    try {
      // Absent file (ENOENT) is the only empty answer; anything else is corrupt evidence.
      text = readPrivateTextOrNull(deferredFilePath(), {
        tightenMode: 0o600,
        requiredMode: 0o600,
        maxBytes: DEFERRED_INTENTS_MAX_BYTES,
      })
    } catch (error) {
      return asideCorruptIntents(error)
    }
    if (text === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
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

  /** Append one durable intent; throws when the store is full or unwritable (caller maps to 500 persistence_failed). */
  function appendDeferredIntent(input: PluginTaskSubmitInput): DeferredIntent {
    const intent: DeferredIntent = { id: randomUUID(), ts: Date.now(), kind: input.kind as 'install' | 'materialize', name: input.name }
    if (input.spec !== undefined) intent.spec = input.spec
    if (input.version !== undefined) intent.version = input.version
    if (input.initiator !== undefined) intent.initiator = input.initiator
    persistIntents([...loadIntents(), intent])
    return intent
  }

  function recordRefusedIntent(intent: DeferredIntent, refusal: { code: string; error: string }): void {
    // Best effort: the journal is the operator-visible record; a write failure
    // is logged, never thrown into the drain loop.
    try {
      const opId = journal.appendPending({
        kind: intent.kind,
        name: intent.name,
        ...(intent.spec === undefined ? {} : { spec: intent.spec }),
        ...(intent.version === undefined ? {} : { version: intent.version }),
        initiator: 'deferred-drain',
      })
      journal.markTerminal(opId, { status: 'failed', error: `deferred ${intent.kind} refused: ${refusal.error} [${refusal.code}]` })
    } catch (error) {
      warn(`plugins-tasks: could not record the refused deferred intent ${intent.id}: ${messageOf(error)}`)
    }
  }

  function dropDeferredIntent(intentId: string): boolean {
    const intents = loadIntents()
    const next = intents.filter(intent => intent.id !== intentId)
    if (next.length === intents.length) return false
    persistIntents(next)
    return true
  }

  /** Gateway-local `file:` spec values (materialize staging paths) must never
   * leave this module toward the renderer. The mask keeps the `file:` prefix so
   * classifiers still recognise a materialize value. */
  function maskProjectedSpec(spec: string | undefined): string | undefined {
    if (spec === undefined) return undefined
    return isFileValue(spec) ? MATERIALIZED_VALUE_MASK : spec
  }

  /** Remove a materialize op's staged archive ONLY when nothing can ever
   * consume it again: a cleared deferred intent never ran, so no manifest
   * references its file. Terminal EXECUTED ops deliberately RETAIN theirs — the
   * manifest permanently records `file:<staged>` and a later re-resolution
   * (reinstall, lockfile staleness, pruning) fetches that path again, so
   * deleting it would leave a dangling tarball reference. Best effort. */
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

  /** Kill one crash-orphaned mutation child recorded on a pending journal op:
   * a crash mid-mutation leaves the detached `dsh plugin`/pnpm process group
   * writing DSH_HOME. The group (negative pid — child is its leader) is killed
   * first, then the pid itself. Best effort; never fails the reconcile. */
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

  // Executor lifecycle + lease bookkeeping

  /** Lazy executor construction. The spawn command is the resolved NODE
   * executable; the per-op argv prefix (node args + workspace CLI entry) and
   * cwd come from cliLaunch, resolved per spawn. */
  function getExecutor(): PluginExec {
    if (executor !== null) return executor
    const nodeExec = resolveNodeExecutable()
    executor = createPluginsExec({
      stateDir,
      // The real command is the node executable (the gateway server runs under
      // plain node); the entry rides the per-op argv prefix below.
      dshCliPath: nodeExec.file,
      journal,
      statusProbe: deps.statusProbe,
      logger,
      spawn: deps.spawn,
      timeoutMs: deps.timeoutMs,
      // Execution-window gate: a queued op dequeues into a spawn only when NO
      // runtime mutation writer is in flight, so it never spawns mid-transaction
      // (the executor waits out the window in its bounded canRun poll). A null
      // manager has no window to violate — submit refused/deferred first.
      canRun: () => {
        const manager = deps.manager()
        return manager === null || !manager.mutationInFlight()
      },
      // Per-op runtime facts: the same workspace the ops launch from, so both
      // the execution-time re-judgement and the post-install verdict describe
      // the tree the mutation actually touched. A throwing resolver (corrupt
      // metadata) is the CALLER's contract to guard.
      runtimeFacts: () => {
        const manager = deps.manager()
        if (manager === null) return null
        const workspace = manager.resolveWorkspace()
        return { path: workspace.path, version: workspace.version }
      },
      cliLaunch: () => {
        const manager = deps.manager()
        if (manager === null) {
          throw new Error('gateway runtime manager is unavailable; cannot resolve the dsh CLI workspace')
        }
        const workspace = manager.resolveWorkspace()
        const resolved = resolveDshCliEntry(workspace.path)
        if (resolved === null) {
          throw new Error(`no dsh CLI entry found in ${workspace.path}`)
        }
        // nodeExec.args covers the Electron-run-node edge; the tsx loader
        // rides --import for the dev source shape (as control-plane spawn-dsh).
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
    // worker can process the item; even a synchronous terminal releases once.
    const result = await getExecutor().enqueue(input, (_op, status) => {
      try {
        release()
      } catch (error) {
        warn(`plugins-tasks: profile-write lease release failed: ${messageOf(error)}`)
      }
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

  /**
   * The undo verb's acceptance path: undo = RESTORE, never remove-only. Undo is
   * NEVER deferred — the honest answers are the 4xx/409 family or a queued 202.
   * The target is selected here and bound to the journal op (`undoOf`), which
   * the executor re-verifies at execution. */
  async function submitUndo(
    input: PluginTaskSubmitInput,
    onTerminal?: (status: 'ok' | 'failed' | 'blocked') => void,
  ): Promise<PluginTaskSubmitResult> {
    // Corruption ≠ emptiness: a corrupt record set cannot prove "nothing is
    // undoable", so the answer is the retryable 503, never no_undoable_op.
    const integrity = journal.integrity()
    if (integrity.state === 'corrupt') {
      return {
        ok: false,
        code: 'journal_unavailable',
        error: `plugin journal is corrupt or unreadable (${integrity.error}); refusing to pick an undo target`,
      }
    }
    const manager = deps.manager()
    if (manager === null) {
      return {
        ok: false,
        code: 'runtime_pending',
        error: 'gateway runtime manager is not initialized; retry when the managed instance is up',
      }
    }
    // Single-flight FIRST: undo restores whole-file state, so it must never
    // race another profile writer. The check precedes target selection on
    // purpose — under a writer the target set is mid-change, so "busy" is the
    // only honest answer (never a confident no_undoable_op).
    if (manager.profileWriteInFlight()) {
      return {
        ok: false,
        code: 'runtime_busy',
        error: 'a managed profile write is in flight; retry after the running plugin operation settles',
      }
    }
    const target = latestUndoableOp(journal.recent())
    if (target === null) {
      return { ok: false, code: 'no_undoable_op', error: 'no undoable plugin operation is recorded' }
    }
    const lease = manager.beginProfileWrite()
    if (!lease.ok) return { ok: false, code: lease.code, error: lease.error }
    return submitWithLease(
      {
        kind: 'undo',
        name: target.name,
        undoOf: target.id,
        ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      },
      lease.release,
      onTerminal,
    )
  }

  async function submitImpl(
    input: PluginTaskSubmitInput,
    allowDefer: boolean,
    onTerminal?: (status: 'ok' | 'failed' | 'blocked') => void,
  ): Promise<PluginTaskSubmitResult> {
    if (input.kind === 'undo') return await submitUndo(input, onTerminal)
    const outcome = validateSubmission(input, deps)
    if (outcome.kind === 'refuse') {
      return { ok: false, code: outcome.code, error: outcome.error }
    }
    if (outcome.kind === 'defer-profile-absent') {
      // The managed profile does not exist yet: defer install/materialize
      // until a ready edge creates it; defer disabled answers no_manifest.
      if (!allowDefer) {
        return { ok: false, code: 'no_manifest', error: 'managed profile is not initialized' }
      }
      const intent = appendDeferredIntent(input)
      log(`plugins-tasks: deferred ${input.kind} ${input.name} (${intent.id}); profile not initialized yet`)
      return { ok: true, deferred: true, intentId: intent.id }
    }

    const manager = deps.manager()
    if (manager === null) {
      // Runtime manager not built yet (gateway start window): install/
      // materialize defer; remove refuses.
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
        // Recovery phases expose only retry/restore; remove is user-instant — neither defers.
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
      // A corrupt journal answers [] exactly like an empty one, but its
      // pending set — and every recorded childPid — is UNKNOWN. Never claim
      // "no pending operations carried over" for it.
      const integrity = journal.integrity()
      const corrupt = integrity.state === 'corrupt'
      if (corrupt) {
        warn(
          'plugins-tasks: plugin journal is corrupt or has unresolved corruption evidence — the pending ' +
          `operation set is UNKNOWN (${integrity.error}` +
          `${integrity.asidePath === null ? '' : `; evidence kept at ${integrity.asidePath}`}); refusing to ` +
          'report "no pending operations carried over" — no orphan child is reaped and no preImage is ' +
          'reclaimed from these records',
        )
      }
      if (reconciled.length > 0) {
        warn(`plugins-tasks: journal reconciled ${reconciled.length} pending operation(s) from a previous run (marked failed)`)
      } else if (!corrupt) {
        log('plugins-tasks: journal reconciled; no pending operations carried over')
      }
      // Crash-orphan reaping: a pending op with a spawned child pid means the
      // previous process died mid-mutation and its detached `dsh plugin`/pnpm
      // child may still be writing DSH_HOME — kill it before any new mutation.
      // Only records actually READ are reaped; a corrupt journal has no pid.
      for (const op of reconciled) {
        if (op.childPid !== undefined) killOrphanedChild(op.childPid)
      }
    },

    sweepOrphanedStagedArchives() {
      // Boot-only: the executor is idle and no route can stage concurrently, so
      // the reference set below is stable. Referenced = manifest file: targets +
      // deferred intents' staged specs + live journal ops' staged specs; a set
      // is trustworthy only when every source was READ.
      const integrity = journal.integrity()
      if (integrity.state === 'corrupt') {
        warn(
          'plugins-tasks: staged-archive sweep skipped: the plugin journal is corrupt or has unresolved ' +
          `corruption evidence (${integrity.error}), so the live operation set is unknown; staged archives are retained`,
        )
        return
      }
      const referenced = new Set<string>()
      const manifestPath = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR, 'package.json')
      let manifestText: string | null = null
      try {
        // Absent manifest (fresh gateway) is the ONE empty answer the sweep
        // trusts; intents/ops below still protect their own. Any other failure
        // is rethrown by the shared wrapper.
        manifestText = readPrivateTextOrNull(manifestPath, {
          tightenMode: 0o600,
          maxBytes: INSTALLED_MANIFEST_MAX_BYTES,
        })
      } catch (error) {
        // Present but unreadable/unsafe (permissions, symlinked dir/leaf,
        // oversized): a read failure must never license deletion.
        warn(
          'plugins-tasks: staged-archive sweep skipped: the managed profile manifest is present but ' +
          `unreadable (${messageOf(error)}); refusing to read that as "nothing is referenced" — staged archives are retained`,
        )
        return
      }
      if (manifestText !== null) {
        let parsed: unknown
        try {
          parsed = JSON.parse(manifestText)
        } catch (error) {
          warn(
            'plugins-tasks: staged-archive sweep skipped: the managed profile manifest is present but ' +
            `not valid JSON (${messageOf(error)}); staged archives are retained`,
          )
          return
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          warn(
            'plugins-tasks: staged-archive sweep skipped: the managed profile manifest is present but ' +
            'not a JSON object; staged archives are retained',
          )
          return
        }
        const dependencies = (parsed as { dependencies?: unknown }).dependencies
        // Read-face parse shape: a missing/non-object `dependencies` member means "no declared dependencies", not corrupt.
        if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
          for (const spec of Object.values(dependencies as Record<string, unknown>)) {
            if (typeof spec === 'string' && isFileValue(spec)) referenced.add(spec.slice('file:'.length))
          }
        }
      }
      // The deferred store is a reference source too: read it FIRST (the read
      // may move corrupt bytes aside), then refuse the whole sweep if this run
      // or an earlier one observed corruption — a lost deferred materialize's
      // archive may depend on it.
      const intents = loadIntents()
      if (deferredStoreCorrupt || deferredCorruptionEvidence().length > 0) {
        warn(
          'plugins-tasks: staged-archive sweep skipped: the deferred intent store is corrupt or has unresolved ' +
          'corruption evidence, so deferred staged references are unknown; staged archives are retained',
        )
        return
      }
      for (const intent of intents) {
        if (intent.spec !== undefined && isFileValue(intent.spec)) referenced.add(intent.spec.slice('file:'.length))
      }
      for (const op of journal.recent()) {
        if (op.status === 'pending' && op.spec !== undefined && isFileValue(op.spec)) {
          referenced.add(op.spec.slice('file:'.length))
        }
      }
      // Walk the staging root: *.tgz directly under each first-level slug dir
      // (backups/ and deferred.json carry no archives). A fresh gateway has no
      // root yet — a silent no-op, not a warning.
      const root = thirdPartyRoot(stateDir)
      if (!existsSync(root)) return
      let removed = 0
      try {
        for (const dirName of readdirSync(root, { withFileTypes: true })) {
          if (!dirName.isDirectory() || dirName.name === 'backups') continue
          const dirPath = join(root, dirName.name)
          let entries: string[]
          try {
            entries = readdirSync(dirPath)
          } catch {
            continue
          }
          for (const file of entries) {
            if (!file.endsWith('.tgz')) continue
            const stagedPath = join(dirPath, file)
            if (referenced.has(stagedPath)) continue
            try {
              rmSync(stagedPath, { force: true })
              removed += 1
            } catch (error) {
              warn(`plugins-tasks: could not remove orphaned staged archive ${stagedPath}: ${messageOf(error)}`)
            }
          }
        }
      } catch (error) {
        warn(`plugins-tasks: staged-archive orphan sweep could not read ${root}: ${messageOf(error)}`)
        return
      }
      if (removed > 0) {
        log(`plugins-tasks: staged-archive sweep removed ${removed} orphaned archive(s) under ${root}`)
      }
    },

    async submit(input, opts) {
      return submitImpl(input, opts?.defer !== false)
    },

    tasks() {
      // file: spec values are masked in the outward projection and childPid
      // (a LIVE HOST PROCESS id of a pending mutation) never leaves this module.
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
      // A cleared intent NEVER executed, so its staged archive is the one case
      // nothing can consume; executed ops retain theirs. Persistence failure
      // still answers false and leaves the archive for a later sweep.
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
      // Single-flight: concurrent drains collapse into the running one; each
      // intent is re-submitted at most once per round and the lease serializes
      // the executor anyway. A plugin installed onto a RUNNING instance only
      // mounts on the next spawn, hence the one controlled restart when ≥1
      // drained op ran to ok.
      if (drainInFlight !== null) return drainInFlight
      const run = (async (): Promise<number> => {
        let cleared = 0
        // Restart-once: the request fires only after EVERY drained op of this
        // run went terminal AND at least one ran ok — requesting at the first
        // ok terminal would race still-pending ops whose leases keep the
        // wiring gate closed, losing the single attempt.
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
            // All drained ops settled — no lease of this run holds the gate closed.
            requestRestartNow()
          }
        }
        // Wave pacing against the executor queue cap: a round submits every
        // stored intent; queue_full refusals wait for a live-op slot before
        // the next wave. Bounded by the drain deadline so a pathological
        // backlog can never pin the drain — leftovers retry on the next edge.
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
              // defer:false — a refused lease leaves the intent for the next edge.
              const result = await submitImpl(
                {
                  kind: intent.kind,
                  name: intent.name,
                  spec: intent.spec,
                  version: intent.version,
                  initiator: intent.initiator,
                },
                false,
                onDrainedTerminal,
              )
              if (result.ok && !result.deferred) {
                if (dropDeferredIntent(intent.id)) cleared += 1
                acceptedInRun += 1
              } else if (!result.ok && result.code === 'queue_full') {
                queueFull = true
              } else if (!result.ok && PERMANENT_DRAIN_REFUSALS.has(result.code as PluginTaskRefusalCode)) {
                // A permanent refusal must not be retried forever in silence:
                // drop the intent AND record it as a failed op so the tasks
                // projection tells the operator why.
                dropDeferredIntent(intent.id)
                warn(`plugins-tasks: deferred ${intent.kind} ${intent.name} was refused (${result.code}): ${result.error}`)
                recordRefusedIntent(intent, result)
              } else if (!result.ok && result.code === 'persistence_failed') {
                // The executor could not journal the op — a write failure, not a busy window.
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
          // next wave; leftovers retry on the next ready/degraded edge.
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
      // Every queued/in-flight op already carries its lease release, so the
      // dispose terminals release all leases; disposal is idempotent.
      if (exec !== null) await exec.dispose()
    },
  }
}

export function deferredIntentsFilePath(stateDir: string): string {
  return join(thirdPartyRoot(stateDir), DEFERRED_INTENTS_FILE)
}
