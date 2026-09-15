/**
 * Shared harness for the packages/renderer/test/lifecycle/shell*.test.ts split:
 * the fixture knobs, the shell.ts module surface and the fetch/window/DOM stubs
 * every part reaches for. Test-only; the dynamic import runs under the shell
 * test loader (`--import ../../scripts/dev/test-shell-register.mjs`).
 *
 * Parts: shell.test.ts, shell-tail-wait-teardown.test.ts, session-open-poll.test.ts.
 */
// Test knobs — same module instance shell.ts sees (the loader maps the bare
// specifier to this URL; the relative import resolves to the same file).
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
} from '../../test-fixtures/dsh-client-web.mjs'

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
