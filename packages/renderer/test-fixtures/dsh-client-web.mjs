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
// Loader-entry face of the failed boot (T15): tests hand in the exact sweep
// result the chamber overlay must turn into a plugin-id list.
let loaderEntries = []
let runError = undefined
let moduleSystemError = undefined
let disposedCount = 0
const eventLog = []
const configuredContexts = []
const runGates = []
const allRunGates = new Set()
const disposeGates = []
const allDisposeGates = new Set()
const entryStates = []
const openedSessions = []
let entrySequence = 0
let sessionsListed = true
// Models the window between boot settle (root fibers active) and the runtime
// sessions service activation (a composite CHILD fiber): while false, the
// entry's runtimeCtx carries no sessions face yet. Module-global: every entry
// runtimeCtx read reflects the CURRENT value (like the real per-boot state).
let sessionsAvailable = true
// Thrown by the runtimeCtx getter itself (distinct from sessionsSnapshotError,
// which throws from list.getSnapshot): pins the shell's hostile-read arm.
let sessionsReadError = undefined
let sessionsSnapshotError = undefined
let sessionsOpenError = undefined

/** Fiber-state mirror (loader-status.ts): the sweep compares against ACTIVE. */
export const FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
}

export class AppWebEntry {
  constructor(el, options) {
    this.el = el
    this.options = options
    this.disposed = false
    this.label = `entry-${++entrySequence}`
    this.state = { label: this.label, disposed: false }
    entryStates.push(this.state)
  }

  async run() {
    if (this.options?.configureContext !== undefined) {
      const facts = {}
      this.options.configureContext({
        provide(name, value) {
          facts[name] = value
          return () => {}
        },
      })
      configuredContexts.push(facts)
    }
    const gate = runGates.shift()
    if (gate !== undefined) {
      this.label = gate.label
      this.state.label = gate.label
      gate.markStarted()
      try {
        await gate.wait
      } finally {
        allRunGates.delete(gate)
      }
    }
    if (runError !== undefined) throw runError
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.state.disposed = true
    disposedCount += 1
    const gate = disposeGates.shift()
    if (gate !== undefined) {
      gate.markStarted(this.label)
      try {
        await gate.wait
      } finally {
        allDisposeGates.delete(gate)
      }
    }
  }

  get bootError() {
    return bootError
  }

  get runtimeCtx() {
    if (this.disposed) return undefined
    if (sessionsReadError !== undefined) throw sessionsReadError
    if (!sessionsAvailable) return { sessions: undefined, loader: { entries: () => loaderEntries } }
    const label = this.label
    return {
      loader: { entries: () => loaderEntries },
      sessions: {
        list: {
          getSnapshot() {
            if (sessionsSnapshotError !== undefined) throw sessionsSnapshotError
            // Every id is visible immediately: shell lifecycle tests exercise
            // which entry receives the dispatch. Tests that exercise polling
            // can temporarily make every id absent through the fixture knob.
            return { byId: new Proxy({}, { get: () => sessionsListed ? {} : undefined }) }
          },
        },
        open(sessionId) {
          if (sessionsOpenError !== undefined) throw sessionsOpenError
          openedSessions.push({ label, sessionId })
        },
      },
    }
  }
}

// C3 gate face (2026-09): mirrors the slice of the real ClientModuleSystem
// that shell.ts consumes after C3 — `manifest` (the chamber boot row) and
// `prefetch(id)`. prefetch pushes an event synchronously so tests can pin
// call order, and honors two knobs: an injected error (the shell gate
// swallows it — the loud path is run()'s create-side import, not tested
// here) and an optional gate (tests can hold extra-bundle loads until the
// chamber "eval" settles).
let chamberPrefetchError = undefined
const prefetchGates = []
const allPrefetchGates = new Set()
const moduleSystemFace = {
  manifest: { plugins: [{ id: '@dsh-chamber/app', immediately: true }] },
  async prefetch(id) {
    eventLog.push(`prefetch:${id}`)
    if (chamberPrefetchError !== undefined) throw chamberPrefetchError
    const gate = prefetchGates.shift()
    if (gate !== undefined) {
      gate.markStarted()
      try {
        await gate.wait
      } finally {
        allPrefetchGates.delete(gate)
      }
    }
  },
}

export function ensureWebModuleSystem() {
  // Records the call so tests can pin the first-boot ordering (sink install
  // must precede any host-graph fetch / bundle preload). The real module-system
  // install itself is not exercised here (that logic is boot.ts's; verified
  // by typecheck/build) — this only simulates its failure gate and hands back
  // the C3 face above (shell.ts fireChamberPrefetch / awaitBeforeLoad).
  eventLog.push('ensure')
  if (moduleSystemError !== undefined) throw moduleSystemError
  return moduleSystemFace
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

/** Make the C3 chamber prefetch reject (shell gate swallows; create-side loud untested). */
export function __testSetChamberPrefetchError(value) {
  chamberPrefetchError = value
}

/** Gate the next chamber prefetch: release() lets the "eval" settle. */
export function __testQueueChamberPrefetchGate() {
  let markStarted
  let release
  const started = new Promise(resolve => { markStarted = resolve })
  const wait = new Promise(resolve => { release = resolve })
  const gate = { wait, markStarted, release }
  prefetchGates.push(gate)
  allPrefetchGates.add(gate)
  return { started, release }
}

export function __testDisposedCount() {
  return disposedCount
}

export function __testResetDisposed() {
  disposedCount = 0
}

/** Per-entry facts captured when the fixture mirrors AppWebEntry.run(). */
export function __testConfiguredContexts() {
  return configuredContexts
}

export function __testResetConfiguredContexts() {
  configuredContexts.length = 0
}

/**
 * Queue one deterministic run() gate. The returned promise resolves when an
 * AppWebEntry consumes the gate; release() lets that run settle.
 */
export function __testQueueRunGate(label) {
  let markStarted
  let release
  const started = new Promise(resolve => { markStarted = resolve })
  const wait = new Promise(resolve => { release = resolve })
  const gate = {
    label,
    wait,
    markStarted,
    release,
  }
  runGates.push(gate)
  allRunGates.add(gate)
  return { started, release }
}

/** Gate the next first-time entry disposal and expose which entry consumed it. */
export function __testQueueDisposeGate() {
  let markStarted
  let release
  let fail
  const started = new Promise(resolve => { markStarted = resolve })
  const wait = new Promise((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const gate = { wait, markStarted, release }
  disposeGates.push(gate)
  allDisposeGates.add(gate)
  return { started, release, fail }
}

/** Fixture lifecycle observations (copies prevent tests mutating the log). */
export function __testEntryStates() {
  return entryStates.map(state => ({ ...state }))
}

export function __testOpenedSessions() {
  return openedSessions.map(open => ({ ...open }))
}

export function __testSetSessionsListed(value) {
  sessionsListed = value
}

/** Simulate the runtime sessions service being (un)available at read time. */
export function __testSetSessionsAvailable(value) {
  sessionsAvailable = value
}

/** Make the runtimeCtx read itself throw (hostile-boundary arm). */
export function __testSetSessionsReadError(value) {
  sessionsReadError = value
}

export function __testSetSessionsSnapshotError(value) {
  sessionsSnapshotError = value
}

export function __testSetSessionsOpenError(value) {
  sessionsOpenError = value
}

/** The failed boot's loader entries (T15 sweep: `{ options.name, fiber.state }`). */
export function __testSetLoaderEntries(value) {
  loaderEntries = value ?? []
}

export function __testResetLifecycle() {
  for (const gate of allRunGates) gate.release()
  for (const gate of allDisposeGates) gate.release()
  for (const gate of allPrefetchGates) gate.release()
  allRunGates.clear()
  allDisposeGates.clear()
  allPrefetchGates.clear()
  runGates.length = 0
  disposeGates.length = 0
  prefetchGates.length = 0
  entryStates.length = 0
  openedSessions.length = 0
  entrySequence = 0
  sessionsListed = true
  sessionsAvailable = true
  sessionsReadError = undefined
  sessionsSnapshotError = undefined
  sessionsOpenError = undefined
  chamberPrefetchError = undefined
  loaderEntries = []
}

/** Event log: 'ensure' (module-system install) vs 'fetch' (host-graph channel) call order. */
export function __testEventLog() {
  return eventLog
}

export function __testResetEventLog() {
  eventLog.length = 0
}
