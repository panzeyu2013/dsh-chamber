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
let disposedCount = 0
const eventLog = []

export class AppWebEntry {
  constructor(el, options) {
    this.el = el
    this.options = options
    this.disposed = false
  }

  async run() {
    if (runError !== undefined) throw runError
  }

  dispose() {
    this.disposed = true
    disposedCount += 1
  }

  get bootError() {
    return bootError
  }

  get runtimeCtx() {
    return undefined
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

export function __testDisposedCount() {
  return disposedCount
}

export function __testResetDisposed() {
  disposedCount = 0
}

/** Event log: 'ensure' (module-system install) vs 'fetch' (host-graph channel) call order. */
export function __testEventLog() {
  return eventLog
}

export function __testResetEventLog() {
  eventLog.length = 0
}
