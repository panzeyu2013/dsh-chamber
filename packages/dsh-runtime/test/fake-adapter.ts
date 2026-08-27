/**
 * Pure-Node fake host adapter (design 18 §9.1 M5 deliverable).
 *
 * Implements `RuntimeHostAdapter` with no Electron/userData/IPC dependency so
 * the shared core's tests can run entirely against `node:test` fixtures:
 *   - `stateRoot`/`dshHome` are temp dirs under `os.tmpdir()`;
 *   - an in-memory clock (`nowMs` + `advanceClock`) replaces wall-clock time;
 *   - `spawnAndProbe`/`stopHost`/`restartHost`/`registerInstallChild` are recorded
 *     fakes (probe results are injectable);
 *   - `pnpmBin`/`nodeExecutable` are inert string/argv fixtures.
 *
 * The existing runtime-startup/apply-phase tests already build their own
 * `StartupDeps`/`ApplyDeps` fakes (the concrete seams this adapter will front in
 * the M6 wiring); this class is the canonical shared fixture for host-agnostic
 * tests and the adapter seam itself.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { REQUIRED_ACTIVATION_PROBES } from '../src/activation-gate.ts'
import type { ProbeResult } from '../src/activation-gate.ts'
import type { RuntimeHostAdapter, RuntimeStatusProjection } from '../src/runtime-host-adapter.ts'

export interface FakeHostAdapterOptions {
  stateRoot?: string
  dshHome?: string
  shellVersion?: string
  envOverridePath?: string | null
  builtinAnchors?: { path: string; version: string }[]
  pnpmBin?: string
  nodeExecutable?: { cmd: string; args: string[]; env: Record<string, string> }
  probeResults?: ProbeResult[]
  mutationsAllowed?: boolean
  nowMs?: number
}

const defaultProbes = (): ProbeResult[] =>
  REQUIRED_ACTIVATION_PROBES.map((name) => ({ name, ok: true }))

export class FakeHostAdapter implements RuntimeHostAdapter {
  readonly stateRootPath: string
  readonly dshHomePath: string
  readonly shell: string
  readonly envOverride: string | null
  readonly anchors: { path: string; version: string }[]
  readonly pnpm: string
  readonly nodeExec: { cmd: string; args: string[]; env: Record<string, string> }
  readonly allowMutations: boolean
  private probeResults: ProbeResult[]

  /** In-memory clock (ms since epoch). */
  nowMs: number

  readonly spawned: Array<{ version: string; isBuiltin: boolean }> = []
  readonly installChildren: ChildProcess[] = []
  readonly notifications: RuntimeStatusProjection[] = []
  stopCalls = 0
  restartCalls = 0

  constructor(options: FakeHostAdapterOptions = {}) {
    this.stateRootPath = options.stateRoot ?? mkdtempSync(join(tmpdir(), 'dsh-runtime-fake-state-'))
    this.dshHomePath = options.dshHome ?? mkdtempSync(join(tmpdir(), 'dsh-runtime-fake-home-'))
    this.shell = options.shellVersion ?? '0.2.0-beta.1'
    this.envOverride = options.envOverridePath ?? null
    this.anchors = options.builtinAnchors ?? [{ path: '/fake/builtin/dsh', version: '0.1.1-rc.2' }]
    this.pnpm = options.pnpmBin ?? '/fake/pnpm/bin/pnpm.cjs'
    this.nodeExec = options.nodeExecutable ?? { cmd: '/fake/node', args: [], env: {} }
    this.allowMutations = options.mutationsAllowed ?? true
    this.probeResults = options.probeResults ?? defaultProbes()
    this.nowMs = options.nowMs ?? 0
  }

  advanceClock(ms: number): number {
    this.nowMs += ms
    return this.nowMs
  }

  stateRoot(): string {
    return this.stateRootPath
  }

  dshHome(): string {
    return this.dshHomePath
  }

  builtinAnchors(): { path: string; version: string }[] {
    return this.anchors
  }

  envOverridePath(): string | null {
    return this.envOverride
  }

  shellVersion(): string {
    return this.shell
  }

  nodeExecutable(): { cmd: string; args: string[]; env: Record<string, string> } {
    return this.nodeExec
  }

  pnpmBin(): string {
    return this.pnpm
  }

  async spawnAndProbe(version: string, isBuiltin: boolean, _signal?: AbortSignal): Promise<ProbeResult[]> {
    this.spawned.push({ version, isBuiltin })
    return this.probeResults
  }

  setProbeResults(results: ProbeResult[]): void {
    this.probeResults = results
  }

  async stopHost(): Promise<void> {
    this.stopCalls += 1
  }

  async restartHost(): Promise<void> {
    this.restartCalls += 1
  }

  registerInstallChild(child: ChildProcess): void {
    this.installChildren.push(child)
  }

  notify(snapshot: RuntimeStatusProjection): void {
    this.notifications.push(snapshot)
  }

  platformGate(): { mutationsAllowed: boolean; reason?: string } {
    return this.allowMutations
      ? { mutationsAllowed: true }
      : { mutationsAllowed: false, reason: 'windows-read-only' }
  }
}
