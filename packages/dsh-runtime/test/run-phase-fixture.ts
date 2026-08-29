/**
 * apply-now P1 run-phase fixture (design 18 addendum · Apply Now).
 *
 * The canonical bridge between the pure-Node `FakeHostAdapter` (design 18 §9.1
 * M5 deliverable, test/fake-adapter.ts) and the real DI seams `StartupDeps` /
 * `ApplyDeps` that the desktop main process and the gateway server adapt the
 * shared core through. It models host orchestration semantics:
 *
 *   - `applyNow()` stops the host before the activation transaction, so the
 *     observed order is stop → snapshot → switchPointer → spawnAndProbe →
 *     verdict — the apply-now runtime entry the two hosts already own;
 *   - only durable state (current pointer / override / activation journal)
 *     survives a simulated crash: a `crashAfter` side effect captures
 *     `currentState()` at the exact crash point and a re-entry fixture is
 *     seeded from it (`fromState`), exactly like a process restart that
 *     reconstructs deps and re-runs runStartupPhase.
 *
 * The fixture keeps the in-memory clock on the FakeHostAdapter (`advanceClock`
 * drives probe-window timeouts and delayed-verdict re-probing).
 */
import { FakeHostAdapter } from './fake-adapter.ts'
import type { ProbeResult } from '../src/activation-gate.ts'
import type { ApplyDeps } from '../src/apply-phase.ts'
import type {
  ActivationJournal,
  ActivationJournalState,
  OverrideRecord,
} from '../src/dsh-runtime-store.ts'
import { runStartupPhase, type StartupDeps, type StartupResult } from '../src/runtime-startup.ts'

export type RunPhaseEvent =
  | { kind: 'stop' }
  | { kind: 'snapshot'; version: string }
  | { kind: 'switch'; version: string | null }
  | { kind: 'probe'; version: string; isBuiltin: boolean }
  | { kind: 'restore'; snapshot: string }
  | { kind: 'known-good'; version: string }

/** Durable state a crash would persist — the only state that crosses a restart. */
export interface RunPhaseState {
  pointer: string | null
  override: OverrideRecord | null
  journal: ActivationJournalState
}

export type RunPhaseCrashPoint = 'stop' | 'snapshot' | 'switch' | 'probe'

export interface RunPhaseFixtureOptions {
  shellVersion?: string
  builtinVersion?: string
  pointer?: string | null
  override?: OverrideRecord | null
  journal?: ActivationJournalState
  probeResults?: ProbeResult[]
  snapshotThrows?: boolean
  restoreOutcome?: 'complete' | 'half' | 'incomplete'
  /** Simulate process death at the named side effect (capture + throw once). */
  crashAfter?: RunPhaseCrashPoint
}

const DEFAULT_BUILTIN = '0.1.1-rc.2'

export class RunPhaseFixture {
  readonly adapter: FakeHostAdapter
  readonly events: RunPhaseEvent[] = []
  readonly restoreOutcome: 'complete' | 'half' | 'incomplete'
  readonly crashAfter?: RunPhaseCrashPoint
  readonly shellVersion: string
  readonly builtinVersion: string
  /** Mutable so a test can clear a durable snapshot-failed gate and retry. */
  snapshotThrows: boolean

  snapshotCalls = 0
  switchCalls = 0
  restoreCalls = 0
  knownGoodCalls: string[] = []
  /** Signals observed by each probe call (the ApplyDeps.probe seam forwards the host signal verbatim). */
  readonly probeSignals: Array<AbortSignal | undefined> = []

  private pointer: string | null
  private override: OverrideRecord | null
  private journal: ActivationJournalState
  private probeOverride: ((version: string, isBuiltin: boolean) => Promise<ProbeResult[]>) | null = null
  private crashFired = false
  private crashedState: RunPhaseState | null = null

  constructor(options: RunPhaseFixtureOptions = {}) {
    this.shellVersion = options.shellVersion ?? '0.1.4'
    this.builtinVersion = options.builtinVersion ?? DEFAULT_BUILTIN
    this.pointer = options.pointer ?? '0.1.0'
    this.override = options.override ?? null
    this.journal = options.journal ?? { kind: 'missing' }
    this.snapshotThrows = options.snapshotThrows ?? false
    this.restoreOutcome = options.restoreOutcome ?? 'complete'
    this.crashAfter = options.crashAfter
    this.adapter = new FakeHostAdapter({ probeResults: options.probeResults, nowMs: 0 })
  }

  /** Rebuild a fixture from durable state — a process restart with fresh deps. */
  static fromState(state: RunPhaseState, options: RunPhaseFixtureOptions = {}): RunPhaseFixture {
    return new RunPhaseFixture({
      ...options,
      pointer: state.pointer,
      override: state.override,
      journal: state.journal,
    })
  }

  /** Durable state as of now — what a crash at this moment would persist. */
  currentState(): RunPhaseState {
    return {
      pointer: this.pointer,
      override: this.override,
      journal: this.journal,
    }
  }

  /** Durable state captured at the crash point (throws if the fixture never crashed). */
  crashed(): RunPhaseState {
    if (this.crashedState === null) throw new Error('run-phase fixture never reached its crash point')
    return this.crashedState
  }

  /** Inject a probe implementation (overrides adapter probeResults). */
  setProbe(probe: (version: string, isBuiltin: boolean) => Promise<ProbeResult[]>): void {
    this.probeOverride = probe
  }

  writeOverride(record: OverrideRecord): void {
    this.override = record
  }

  /**
   * Host orchestration: stop the running dsh first, then run the startup
   * phase (apply-now semantics — the transaction itself only stops during
   * rollback). Observed order: stop → snapshot → switchPointer → probe.
   * `signal` (apply-now S1) is forwarded into the startup entry.
   */
  async applyNow(signal?: AbortSignal): Promise<StartupResult> {
    this.events.push({ kind: 'stop' })
    await this.adapter.stopHost()
    return this.runEntry(signal)
  }

  /** Re-run the startup phase over the current durable state (fresh deps). */
  async runEntry(signal?: AbortSignal): Promise<StartupResult> {
    return runStartupPhase(this.makeStartupDeps(), signal)
  }

  makeStartupDeps(): StartupDeps {
    const fixture = this
    return {
      cleanupStaleInstalls: () => [],
      evict: () => [],
      completeInterruptedRestore: async () => 'none',
      readOverrideState: () => fixture.override === null
        ? { kind: 'missing' }
        : { kind: 'valid', record: fixture.override },
      writeOverride: value => { fixture.override = value },
      deleteOverride: () => { fixture.override = null },
      readCurrentPointerState: () => fixture.pointer === null
        ? { kind: 'missing' }
        : { kind: 'valid', version: fixture.pointer },
      readActivationJournal: () => fixture.journal,
      writeActivationJournal: value => {
        fixture.journal = { kind: 'valid', journal: value }
        // "Crash after snapshot": the pre-swap snapshot is only durable once
        // the prepared journal records its basename, so the crash fires right
        // after that write — before the pointer is touched.
        if (value.phase === 'prepared') fixture.crash('snapshot')
      },
      clearActivationJournal: () => { fixture.journal = { kind: 'missing' } },
      shellVersion: fixture.shellVersion,
      builtinVersion: fixture.builtinVersion,
      activationFacts: () => ({
        sourceVersion: '0.1.0',
        sourceIsBuiltin: false,
        sourceWasKnownGood: true,
        knownGoodVersion: '0.1.0',
      }),
      snapshot: async version => {
        fixture.snapshotCalls += 1
        if (fixture.snapshotThrows) throw new Error('ENOSPC')
        fixture.events.push({ kind: 'snapshot', version })
        return `/snap/${version}-pre-swap`
      },
      resolveSnapshotName: async name => `/snap/${name}`,
      prepareManualRollback: async () => ({ snapshotPath: null, stashPath: null }),
      validateTarget: () => ({ ok: true }),
      switchPointer: version => {
        fixture.switchCalls += 1
        fixture.pointer = version
        fixture.events.push({ kind: 'switch', version })
        fixture.crash('switch')
      },
      spawnAndProbe: async (version, isBuiltin, signal) => {
        fixture.events.push({ kind: 'probe', version, isBuiltin })
        fixture.probeSignals.push(signal)
        const result = fixture.probeOverride !== null
          ? await fixture.probeOverride(version, isBuiltin)
          : await fixture.adapter.spawnAndProbe(version, isBuiltin, signal)
        fixture.crash('probe')
        return result
      },
      stopHost: async () => {
        fixture.events.push({ kind: 'stop' })
        await fixture.adapter.stopHost()
        fixture.crash('stop')
      },
      restore: async snapshotPath => {
        fixture.restoreCalls += 1
        fixture.events.push({ kind: 'restore', snapshot: snapshotPath })
        return fixture.restoreOutcome
      },
      recordProbePass: version => {
        fixture.knownGoodCalls.push(version)
        fixture.events.push({ kind: 'known-good', version })
      },
      recordFailure: () => {},
      waitBeforeRetry: async () => {},
    }
  }

  /** ApplyDeps over the same fixture state — the direct apply-phase seam. */
  makeApplyDeps(): ApplyDeps {
    const startup = this.makeStartupDeps()
    return {
      snapshot: startup.snapshot,
      resolveSnapshotName: startup.resolveSnapshotName,
      prepareManualRollback: startup.prepareManualRollback,
      readCurrentPointerState: startup.readCurrentPointerState,
      validateTarget: startup.validateTarget,
      switchPointer: startup.switchPointer,
      probe: startup.spawnAndProbe,
      stopHost: startup.stopHost,
      restore: startup.restore,
      recordProbePass: startup.recordProbePass,
      readActivationJournal: startup.readActivationJournal,
      writeActivationJournal: startup.writeActivationJournal,
      waitBeforeRetry: startup.waitBeforeRetry,
      nowMs: () => this.adapter.nowMs,
    }
  }

  private crash(point: RunPhaseCrashPoint): void {
    if (this.crashFired || this.crashAfter !== point) return
    this.crashFired = true
    this.crashedState = this.currentState()
    // applyPendingVersion never throws (its wrapper converts any error into a
    // failed outcome), so this sentinel only aborts the transaction and leaves
    // the durable state frozen at the crash point.
    throw new Error('apply-now fixture simulated process death')
  }
}

export function monitoringJournal(patch: Partial<ActivationJournal> = {}): ActivationJournal {
  return {
    schemaVersion: 1,
    phase: 'applied-monitoring',
    targetVersion: '0.2.0',
    targetIsBuiltin: false,
    manualRollback: false,
    intentKind: 'version-switch',
    sourceVersion: '0.1.0',
    sourceIsBuiltin: false,
    sourceWasKnownGood: true,
    knownGoodVersion: '0.1.0',
    preSwapSnapshotName: '0.1.0-pre-swap',
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: '2026-08-23T00:00:00.000Z',
    updatedAt: '2026-08-23T00:00:00.000Z',
    ...patch,
  }
}

export function pendingOverride(pending: string | null = '0.2.0'): OverrideRecord {
  return {
    shellVersion: '0.1.4',
    chosenVersion: '0.1.0',
    resolvedVersion: '0.1.0',
    pending,
    swapAttempted: false,
  }
}
