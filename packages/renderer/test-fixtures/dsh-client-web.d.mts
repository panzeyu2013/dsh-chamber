/**
 * Type declaration for the shell.test.ts fixture (test-fixtures/
 * dsh-client-web.mjs) — the controllable `@deepseek-ai/dsh-client-web` face
 * shell.ts consumes in tests. Mirrors the ambient face of
 * vendor-modules.d.ts; test-only, never shipped.
 */
export class AppWebEntry {
  el: unknown
  options: unknown
  disposed: boolean
  label: string
  constructor(el: unknown, options: unknown)
  run(): Promise<void>
  dispose(): Promise<void>
  readonly bootError: string | undefined
  // Each face is absent while the fixture models its pre-activation window
  // (runtimeCtx present, child-fiber service not yet registered) — shell.ts
  // treats both as transient poll states.
  readonly runtimeCtx: undefined | {
    loader?: { entries(): ReadonlyArray<{ options: { name: string }; fiber?: { state: number } }> }
    sessions?: {
      list: { getSnapshot(): { byId: Record<string, unknown> } }
      /** rc.2 open path: an owned reference the caller must release. */
      retain(target: string, options: { source: string }): {
        readonly sessionId: string
        release(): void
      }
    }
    /**
     * The cordis service-lookup face: the shell reads the official view owner
     * (ui-workspace) through `get('uiWorkspace', false)` only — never a direct
     * property (the fixture's direct getter throws).
     */
    reflect?: { get(name: string, strict?: boolean): unknown }
  }
}

/** Fiber-state mirror (loader-status.ts): the sweep compares against ACTIVE. */
export const FIBER_STATE: {
  PENDING: 0
  LOADING: 1
  ACTIVE: 2
  FAILED: 3
  DISPOSED: 4
  UNLOADING: 5
}

/** Module-system gate face (mirror of vendor-modules.d.ts ensureWebModuleSystem return slice). */
export function ensureWebModuleSystem(): {
  manifest: { plugins: Array<{ id: string; immediately?: boolean }> }
  prefetch(id: string): Promise<void>
}

export function __testSetBootError(value: string | undefined): void
export function __testSetRunError(value: unknown | undefined): void
export function __testSetModuleSystemError(value: unknown | undefined): void
/** Make the chamber prefetch reject (the shell gate swallows it). */
export function __testSetChamberPrefetchError(value: unknown | undefined): void
export function __testDisposedCount(): number
export function __testResetDisposed(): void
export function __testConfiguredContexts(): Array<Record<string, unknown>>
export function __testResetConfiguredContexts(): void
export function __testQueueRunGate(label: string): { started: Promise<void>; release(): void }
export function __testQueueDisposeGate(): { started: Promise<string>; release(): void; fail(error: Error): void }
export function __testEntryStates(): Array<{ label: string; disposed: boolean }>
export function __testOpenedSessions(): Array<{ label: string; sessionId: string }>
/** Every retain call with its source — the rc.2 open evidence. */
export function __testRetainCalls(): Array<{ label: string; sessionId: string; source: string }>
/** Released references in order (replaced reference on a switch, last on teardown). */
export function __testReleasedSessions(): Array<{ label: string; sessionId: string }>
/** The session one entry currently presents. */
export function __testPresentedSession(label: string): string | undefined
export function __testSetSessionsListed(value: boolean): void
export function __testSetSessionsAvailable(value: boolean): void
/** Simulate the ui-workspace view owner activating after the sessions face. */
export function __testSetNavigationAvailable(value: boolean): void
/** Make the view-owner reflect lookup itself throw (the hostile-proxy arm). */
export function __testSetNavigationReadError(value: unknown | undefined): void
/** Remove the whole reflect face from the runtimeCtx (a host without the lookup layer). */
export function __testSetReflectAvailable(value: boolean): void
export function __testSetSessionsReadError(value: unknown | undefined): void
export function __testSetSessionsSnapshotError(value: unknown | undefined): void
export function __testSetSessionsOpenError(value: unknown | undefined): void
/** The failed boot's loader entries (sweep face). */
export function __testSetLoaderEntries(
  value: ReadonlyArray<{ options: { name: string }; fiber?: { state: number } }> | undefined,
): void
export function __testResetLifecycle(): void
export function __testEventLog(): string[]
export function __testResetEventLog(): void
