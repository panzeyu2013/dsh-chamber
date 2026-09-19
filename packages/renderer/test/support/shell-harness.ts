/**
 * Shared harness for the packages/renderer/test/lifecycle/shell*.test.ts split:
 * the fixture knobs, the shell.ts module surface and the fetch/window/DOM stubs
 * every part reaches for. Test-only; the dynamic import runs under the shell
 * test loader (`--import ../../scripts/dev/test-shell-register.mjs`).
 *
 * Parts: shell.test.ts, shell-tail-wait-teardown.test.ts, session-open-poll.test.ts.
 */
import type { TestContext } from 'node:test'

// Test knobs — same module instance shell.ts sees (the loader maps the bare
// specifier to this URL; the relative import resolves to the same file).
import {
  FIBER_STATE,
  __testConfiguredContexts, __testDisposedCount, __testEventLog,
  __testEntryStates, __testOpenedSessions, __testQueueDisposeGate, __testQueueRunGate,
  __testResetConfiguredContexts, __testResetDisposed, __testResetEventLog,
  __testResetLifecycle, __testSetSessionsAvailable, __testSetSessionsListed,
  __testSetSessionsOpenError, __testSetSessionsReadError,
  __testSetSessionsSnapshotError, __testSetLoaderEntries,
  __testSetBootError, __testSetChamberPrefetchError, __testSetModuleSystemError,
  __testSetRunError,
} from '../../test-fixtures/dsh-client-web.mjs'

export {
  FIBER_STATE,
  __testConfiguredContexts, __testDisposedCount, __testEventLog,
  __testEntryStates, __testOpenedSessions, __testQueueDisposeGate, __testQueueRunGate,
  __testResetConfiguredContexts, __testResetDisposed, __testResetEventLog,
  __testResetLifecycle, __testSetSessionsAvailable, __testSetSessionsListed,
  __testSetSessionsOpenError, __testSetSessionsReadError,
  __testSetSessionsSnapshotError, __testSetLoaderEntries,
  __testSetBootError, __testSetChamberPrefetchError, __testSetModuleSystemError,
  __testSetRunError,
}

export const shellModule = await import('../../src/shell.ts')
export const {
  collectFailedEntries,
  disposeAllShells, disposeInstanceShell, INSTANCE_TAIL_WAIT_CAP_MS, openInstanceSession,
  tailWaitRemainingMs,
} = shellModule

export const testSourceFingerprint = (instanceId: string): string => instanceId === 'local'
  ? 'local'
  : 'ab'.repeat(32)
export const createChamberContextSetup = (instanceId: string, basePath: string, sourceFingerprint = testSourceFingerprint(instanceId)) =>
  shellModule.createChamberContextSetup(instanceId, basePath, sourceFingerprint)
export const bootInstanceShell = (
  instanceId: string,
  basePath: string,
  el: HTMLElement,
  onState: Parameters<typeof shellModule.bootInstanceShell>[3],
) => shellModule.bootInstanceShell(instanceId, basePath, el, onState, testSourceFingerprint(instanceId))

// ── Plumbing ───────────────────────────────────────────────────────────────

/** Host-graph channel resolves 503 instance_unavailable (expected pre-ready; no bundle preloads). */
export function stubUnavailableGraph(onFetch?: () => void): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    onFetch?.()
    return new Response(
      JSON.stringify({ code: 'instance_unavailable', error: 'instance not ready' }),
      { status: 503, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Host graph is ready immediately with no extra plugin rows. */
export function stubReadyGraph(onFetch?: (url: string) => void): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input) => {
    onFetch?.(String(input))
    return new Response(JSON.stringify({
      rpcId: 'shell-generation-test',
      result: { ok: true, value: { rev: 'empty', entries: [] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

/** Mirror the browser's `window === globalThis` relationship for renderer code. */
export function stubWindow(): () => void {
  const g = globalThis as Record<string, unknown>
  const original = g.window
  g.window = globalThis
  return () => {
    if (original === undefined) delete g.window
    else g.window = original
  }
}

/** Thrown value whose Error test and String conversion both throw. This is a
 * realistic hostile plugin/runtime boundary: catch blocks must not assume the
 * caught value is safely inspectable. */
export function hostileThrownValue(): unknown {
  return new Proxy(Object.create(null) as object, {
    getPrototypeOf() {
      throw new Error('hostile getPrototypeOf trap')
    },
    get(_target, property) {
      if (property === Symbol.toPrimitive || property === 'toString' || property === 'valueOf') {
        throw new Error('hostile string conversion trap')
      }
      return undefined
    },
  })
}

// ── Per-test scope ─────────────────────────────────────────────────────────

export interface ShellTestScopeOptions {
  /** Graph stub: 'ready' (default), 'unavailable' (pre-ready 503), 'none' (caller installs fetch). */
  graph?: 'ready' | 'unavailable' | 'none'
  /** Records a graph fetch; called by the graph stub with the fetched url. */
  onFetch?: (url: string) => void
  /** Enable fake setTimeout+Date timers (default true). */
  timers?: boolean
  /** Silence console.error for the test (default true). */
  silentConsole?: boolean
}

/** `__testResetLifecycle` plus the fixture knobs it leaves behind. */
function resetLifecycle(): void {
  __testResetLifecycle()
  __testResetDisposed()
  __testSetBootError(undefined)
  __testSetRunError(undefined)
  __testSetModuleSystemError(undefined)
}

/**
 * One shell-test scope: graph/window stubs, lifecycle reset, fake timers and
 * console silence, with a t.after teardown that disposes `instanceId` (every
 * shell when omitted) and restores all of it.
 */
export function shellTestScope(
  t: TestContext,
  options: ShellTestScopeOptions = {},
  instanceId?: string,
): void {
  const { graph = 'ready', onFetch, timers = true, silentConsole = true } = options
  const restoreFetch = graph === 'unavailable' ? stubUnavailableGraph(() => onFetch?.(''))
    : graph === 'ready' ? stubReadyGraph(url => onFetch?.(url))
    : (): void => {}
  const restoreWindow = stubWindow()
  const originalConsoleError = console.error
  if (silentConsole) console.error = () => {}
  resetLifecycle()
  if (timers) t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.after(() => {
    if (instanceId === undefined) disposeAllShells()
    else disposeInstanceShell(instanceId)
    resetLifecycle()
    if (timers) t.mock.timers.reset()
    console.error = originalConsoleError
    restoreFetch()
    restoreWindow()
  })
}
