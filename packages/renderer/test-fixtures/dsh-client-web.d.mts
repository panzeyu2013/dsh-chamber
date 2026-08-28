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
  readonly runtimeCtx: undefined | {
    sessions: {
      list: { getSnapshot(): { byId: Record<string, unknown> } }
      open(sessionId: string): void
    }
  }
}

export function ensureWebModuleSystem(): void

export function __testSetBootError(value: string | undefined): void
export function __testSetRunError(value: unknown | undefined): void
export function __testSetModuleSystemError(value: unknown | undefined): void
export function __testDisposedCount(): number
export function __testResetDisposed(): void
export function __testConfiguredContexts(): Array<Record<string, unknown>>
export function __testResetConfiguredContexts(): void
export function __testQueueRunGate(label: string): { started: Promise<void>; release(): void }
export function __testQueueDisposeGate(): { started: Promise<string>; release(): void; fail(error: Error): void }
export function __testEntryStates(): Array<{ label: string; disposed: boolean }>
export function __testOpenedSessions(): Array<{ label: string; sessionId: string }>
export function __testSetSessionsListed(value: boolean): void
export function __testSetSessionsSnapshotError(value: unknown | undefined): void
export function __testSetSessionsOpenError(value: unknown | undefined): void
export function __testResetLifecycle(): void
export function __testEventLog(): string[]
export function __testResetEventLog(): void
