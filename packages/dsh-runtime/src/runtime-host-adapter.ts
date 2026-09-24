/**
 * RuntimeHostAdapter — the SKETCH host-adaptation interface of the shared dsh runtime core.
 * The shared package owns all runtime version-management decisions. NOTE: no production code
 * implements this interface — desktop and gateway adapt the core through the real DI seams
 * `StartupDeps`/`ApplyDeps`/`InstallerDeps` (plus desktop's `ControllerDeps`), and the
 * pure-Node fixture `test/support/fake-adapter.ts` is the only implementor used by
 * host-agnostic tests. Finalizing it must cover clock injection `now`/`nowMs`, the abort
 * signal source, the outbound-proxy environment for install-child env scrubbing, progress
 * granularity via `notify`, and `restartHost()`.
 */
import type { ChildProcess } from 'node:child_process'
import type { ProbeResult } from './activation-gate.ts'

/**
 * RuntimeStatusProjection — sketch: the runtime status snapshot a host adapter forwards to its
 * management surface (desktop IPC / gateway SSE-poll), aligned with the desktop
 * `RuntimeLifecycleProjection` and the gateway `/chamber/runtime/status` payload; only the
 * `notify` seam is pinned.
 */
export type RuntimeStatusProjection = Record<string, unknown>

export interface RuntimeHostAdapter {
  /** State root: desktop `<userData>/dsh-runtime`; gateway `<stateDir>/dsh-runtime`. */
  stateRoot(): string
  /** DSH_HOME: desktop `<userData>/state/dsh-home`; gateway `<stateDir>/dsh-home`. */
  dshHome(): string
  /** Builtin anchors: desktop packaged vendor/dsh; gateway `--dsh-path`/findDshWorkspace. */
  builtinAnchors(): { path: string; version: string }[]
  /** Env override path: `DSH_CHAMBER_DSH_PATH` / `DSH_GATEWAY_DSH_PATH`. */
  envOverridePath(): string | null
  /** Shell version: app version / gateway package version (override invalidation baseline). */
  shellVersion(): string
  /** Node executable (Electron-as-node branch in desktop, plain node in gateway). */
  nodeExecutable(): { cmd: string; args: string[]; env: Record<string, string> }
  /** Embedded pinned pnpm entry (desktop extraResources copy / gateway dependency resolve). */
  pnpmBin(): string
  /** Spawn the candidate tree and run the read-only activation probe list. */
  spawnAndProbe(version: string, isBuiltin: boolean, signal?: AbortSignal): Promise<ProbeResult[]>
  stopHost(): Promise<void>
  /** Transactional restart of the managed host. */
  restartHost(): Promise<void>
  /** Register an install child for will-quit / gateway stop() reaping. */
  registerInstallChild(child: ChildProcess): void
  /** Progress projection to the host surface (desktop IPC / gateway SSE-poll). */
  notify(snapshot: RuntimeStatusProjection): void
  /** Platform gate: Windows mutations are read-only. */
  platformGate(): { mutationsAllowed: boolean; reason?: string }
}
