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
const configuredContexts = []
const runGates = []
const allRunGates = new Set()
const disposeGates = []
const allDisposeGates = new Set()
const entryStates = []
const openedSessions = []
let entrySequence = 0
let sessionsListed = true
let sessionsSnapshotError = undefined
let sessionsOpenError = undefined

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
    const label = this.label
    return {
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

export function __testSetSessionsSnapshotError(value) {
  sessionsSnapshotError = value
}

export function __testSetSessionsOpenError(value) {
  sessionsOpenError = value
}

export function __testResetLifecycle() {
  for (const gate of allRunGates) gate.release()
  for (const gate of allDisposeGates) gate.release()
  allRunGates.clear()
  allDisposeGates.clear()
  runGates.length = 0
  disposeGates.length = 0
  entryStates.length = 0
  openedSessions.length = 0
  entrySequence = 0
  sessionsListed = true
  sessionsSnapshotError = undefined
  sessionsOpenError = undefined
}

/** Event log: 'ensure' (module-system install) vs 'fetch' (host-graph channel) call order. */
export function __testEventLog() {
  return eventLog
}

export function __testResetEventLog() {
  eventLog.length = 0
}
