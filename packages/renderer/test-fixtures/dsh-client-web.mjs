/**
 * Test fixture for packages/renderer/src/shell.test.ts — the controllable
 * `@deepseek-ai/dsh-client-web` face shell.ts consumes.
 *
 * The renderer has no install-tree copy of the dsh workspace packages, so the
 * bare specifier cannot resolve in plain node; `scripts/test-shell-loader.mjs`
 * maps it here (registered via `--import scripts/test-shell-register.mjs` in
 * the test:renderer-shell script). The fixture mirrors the ambient face of
 * vendor-modules.d.ts (AppWebEntry + ensureWebModuleSystem) with test knobs;
 * it is test-only — the build/typecheck never load it.
 */
let bootError = undefined
let runError = undefined
let moduleSystemError = undefined
let runHang = false
let runDelayMs = 0
let disposeDelayMs = 0
let disposedCount = 0
const eventLog = []
const lifecycleLog = []
const chamberContextLog = []
const runtimeSessionIds = new Set()
const runtimeOpenLog = []

export class AppWebEntry {
  constructor(el, options) {
    this.el = el
    this.options = options
    this.disposed = false
    lifecycleLog.push('construct')
    chamberContextLog.push(options?.chamberContext)
  }

  async run() {
    if (runError !== undefined) throw runError
    if (runHang) return new Promise(() => {}) // never settles (H1 timeout tests)
    if (runDelayMs > 0) await new Promise(resolve => setTimeout(resolve, runDelayMs)) // late settle (H1)
    if (this.disposed) lifecycleLog.push('cancelled-run')
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    disposedCount += 1
    lifecycleLog.push('dispose')
    if (disposeDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, disposeDelayMs))
      lifecycleLog.push('dispose-complete')
    }
  }

  get bootError() {
    return bootError
  }

  get runtimeCtx() {
    return {
      sessions: {
        list: {
          getSnapshot: () => ({
            byId: Object.fromEntries([...runtimeSessionIds].map(id => [id, { id }])),
          }),
        },
        open: id => { runtimeOpenLog.push(id) },
      },
    }
  }
}

export function ensureWebModuleSystem() {
  // Records the call so tests can pin the first-boot ordering (sink install
  // must precede any host-graph fetch / bundle preload). The real module-system
  // install itself is not exercised here (that logic is boot.ts's; verified
  // by typecheck/build) — this only simulates its failure gate.
  eventLog.push('ensure')
  if (moduleSystemError !== undefined) throw moduleSystemError
}

/** Test knobs (same module instance as shell.ts sees — the loader maps to this URL). */
export function __testSetBootError(value) {
  bootError = value
}

export function __testSetRunError(value) {
  runError = value
}

export function __testSetModuleSystemError(value) {
  moduleSystemError = value
}

/** H1 timeout tests: run() returns a never-settling promise. */
export function __testSetRunHang(value) {
  runHang = value
}

/** H1 late-settle tests: run() resolves after this delay (ms) — lets a boot
 *  settle AFTER its budget expired. */
export function __testSetRunDelayMs(value) {
  runDelayMs = value
}

/** M1 serialization tests: dispose() awaits this delay before settling. */
export function __testSetDisposeDelayMs(value) {
  disposeDelayMs = value
}

/** M1 ordering assertions: 'construct' / 'dispose' in real execution order. */
export function __testLifecycleLog() {
  return lifecycleLog
}

export function __testResetLifecycleLog() {
  lifecycleLog.length = 0
}

export function __testChamberContextLog() {
  return chamberContextLog
}

export function __testResetChamberContextLog() {
  chamberContextLog.length = 0
}

export function __testDisposedCount() {
  return disposedCount
}

export function __testResetDisposed() {
  disposedCount = 0
}

export function __testSetRuntimeSessions(ids) {
  runtimeSessionIds.clear()
  for (const id of ids) runtimeSessionIds.add(id)
}

export function __testRuntimeOpenLog() {
  return runtimeOpenLog
}

export function __testResetRuntimeOpenLog() {
  runtimeOpenLog.length = 0
}

/** Event log: 'ensure' (module-system install) vs 'fetch' (host-graph channel) call order. */
export function __testEventLog() {
  return eventLog
}

export function __testResetEventLog() {
  eventLog.length = 0
}
