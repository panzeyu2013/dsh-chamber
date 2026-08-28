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
  constructor(el: unknown, options: unknown)
  run(): Promise<void>
  dispose(): Promise<void>
  readonly bootError: string | undefined
  readonly runtimeCtx: undefined
}

export function ensureWebModuleSystem(): void

export function __testSetBootError(value: string | undefined): void
export function __testSetRunError(value: Error | undefined): void
export function __testSetModuleSystemError(value: Error | undefined): void
export function __testSetRunHang(value: boolean): void
export function __testSetRunDelayMs(value: number): void
export function __testSetDisposeDelayMs(value: number): void
export function __testLifecycleLog(): string[]
export function __testResetLifecycleLog(): void
export function __testChamberContextLog(): Array<{ instanceId: string; basePath: string; generation: number } | undefined>
export function __testResetChamberContextLog(): void
export function __testDisposedCount(): number
export function __testResetDisposed(): void
export function __testSetRuntimeSessions(ids: string[]): void
export function __testRuntimeOpenLog(): string[]
export function __testResetRuntimeOpenLog(): void
export function __testEventLog(): string[]
export function __testResetEventLog(): void
