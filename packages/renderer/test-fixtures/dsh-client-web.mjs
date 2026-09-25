/**
 * Test fixture shared by the packages/renderer/test/lifecycle/shell*.test.ts —
 * the controllable
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
// Loader-entry face of the failed boot: tests hand in the exact sweep
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
// rc.2 presentation records. The shell routes every open through the official
// view owner (uiWorkspace.openSession), which retains the target with source
// 'mainView' and releases the reference it replaced — the vendor replaceMain
// composition. Retain calls are the "the click really opened it" evidence;
// releases pin the reference lifetime across switches and entry disposal.
const retainedSessions = []
const releasedSessions = []
/** label -> { sessionId, reference }: what each entry's view owner presents now. */
const presentedByEntry = new Map()
let entrySequence = 0
let sessionsListed = true
// Models the window between boot settle (root fibers active) and the runtime
// sessions service activation (a composite CHILD fiber): while false, the
// entry's runtimeCtx carries no sessions face yet. Module-global: every entry
// runtimeCtx read reflects the CURRENT value (like the real per-boot state).
let sessionsAvailable = true
// Models the ui-workspace service activating after the session controller:
// while false the entry has a sessions face but no view owner yet.
let navigationAvailable = true
// Thrown by reflect.get itself — the throwing cordis proxy arm, distinct from an
// absent service (which the non-throwing `reflect.get(name, false)` form answers
// as undefined). Mirrors sessionsReadError one level down the lookup.
let navigationReadError = undefined
// While false the runtimeCtx exposes NO reflect face at all (a ctx without the
// lookup layer). The readSessionViewNavigation contract then stays transient;
// the direct uiWorkspace getter below is the tripwire that catches a
// reintroduced direct-property fallback.
let reflectAvailable = true
// Thrown by the runtimeCtx getter itself (distinct from sessionsSnapshotError,
// which throws from list.getSnapshot): pins the shell's hostile-read arm.
let sessionsReadError = undefined
let sessionsSnapshotError = undefined
// Thrown by sessions.retain — the rc.2 open path the view owner calls through.
let sessionsOpenError = undefined

/**
 * The rc.2 per-entry sessions face: `retain` returns an owned reference (there
 * is no `open` any more); `list.byId` carries each row's `retainedBy` counts,
 * which is how the probe reads the presented main-view session.
 */
function sessionsFace(label) {
  return {
    list: {
      getSnapshot() {
        if (sessionsSnapshotError !== undefined) throw sessionsSnapshotError
        // Every id is visible immediately: shell lifecycle tests exercise which
        // entry receives the dispatch. Tests that exercise polling can
        // temporarily make every id absent through the fixture knob.
        return {
          byId: new Proxy({}, {
            get(_target, id) {
              if (!sessionsListed) return undefined
              const presented = presentedByEntry.get(label)
              return { id, retainedBy: presented?.sessionId === id ? { mainView: 1 } : {} }
            },
          }),
        }
      },
    },
    retain(target, options) {
      if (sessionsOpenError !== undefined) throw sessionsOpenError
      const reference = {
        sessionId: target,
        released: false,
        release() {
          if (this.released) return
          this.released = true
          releasedSessions.push({ label, sessionId: target })
        },
      }
      retainedSessions.push({ label, sessionId: target, source: options?.source })
      return reference
    },
  }
}

/** The official view owner: vendor `replaceMain` — retain the new target, release the replaced reference. */
function viewOwnerFace(label) {
  const sessions = sessionsFace(label)
  return {
    openSession(target) {
      const reference = sessions.retain(target, { source: 'mainView' })
      const previous = presentedByEntry.get(label)
      presentedByEntry.set(label, { sessionId: target, reference })
      previous?.reference.release()
    },
  }
}

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
    // The official view owner's ctx-effect releases the presented reference on
    // disposal; the fixture models the same lifetime.
    const presented = presentedByEntry.get(this.label)
    presentedByEntry.delete(this.label)
    presented?.reference.release()
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
    const label = this.label
    const ctx = {
      loader: { entries: () => loaderEntries },
      sessions: sessionsAvailable ? sessionsFace(label) : undefined,
      // Deliberately NOT a direct service property: production reads the view
      // owner through reflect only. A reinstated direct fallback hits this getter
      // and fails loud in every open test (the fixture's own mutation alarm).
      get uiWorkspace() {
        throw new Error('fixture: runtimeCtx.uiWorkspace must not be read directly (use reflect.get)')
      },
    }
    if (reflectAvailable) {
      // The real cordis service lookup face. `reflect.get(name, false)` is the
      // non-throwing form the shell must use for an absent service; the strict
      // default throws on a miss like the real proxy, so dropping the `false`
      // argument (or asking for another name) turns the absent-service tests red.
      ctx.reflect = {
        get(name, strict = true) {
          if (navigationReadError !== undefined) throw navigationReadError
          if (name !== 'uiWorkspace' || !navigationAvailable) {
            if (strict) throw new Error(`fixture: service ${String(name)} is not registered`)
            return undefined
          }
          return viewOwnerFace(label)
        },
      }
    }
    return ctx
  }
}

// Gate face: mirrors the slice of the real ClientModuleSystem
// that shell.ts consumes after C3 — `manifest` (the chamber boot row) and
// `prefetch(id)`. prefetch pushes an event synchronously so tests can pin
// call order, and honors the injected-error knob (the shell gate swallows it —
// the loud path is run()'s create-side import, not tested here). The optional
// prefetch gate was never wired (nothing queued it), so it is retired: the
// await-before-load behavior is driven by shell-core's awaitBeforeLoad /
// chamberEval instead.
let chamberPrefetchError = undefined
const moduleSystemFace = {
  manifest: { plugins: [{ id: '@dsh-chamber/app', immediately: true }] },
  async prefetch(id) {
    eventLog.push(`prefetch:${id}`)
    if (chamberPrefetchError !== undefined) throw chamberPrefetchError
  },
}

export function ensureWebModuleSystem() {
  // Records the call so tests can pin the first-boot ordering (sink install
  // must precede any host-graph fetch / bundle preload). The real module-system
  // install itself is not exercised here (that logic is boot.ts's; verified
  // by typecheck/build) — this only simulates its failure gate and hands back
  // the gate face above (shell.ts fireChamberPrefetch / awaitBeforeLoad).
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

/** Make the chamber prefetch reject (shell gate swallows; create-side loud untested). */
export function __testSetChamberPrefetchError(value) {
  chamberPrefetchError = value
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

/** Presented sessions: in rc.2 a presentation IS a mainView retain. */
export function __testOpenedSessions() {
  return retainedSessions.map(({ label, sessionId }) => ({ label, sessionId }))
}

/** Every retain call with its source — the "the click really opened it" evidence. */
export function __testRetainCalls() {
  return retainedSessions.map(record => ({ ...record }))
}

/** Released references in order: the replaced reference on a switch, the last on teardown. */
export function __testReleasedSessions() {
  return releasedSessions.map(record => ({ ...record }))
}

/** The session one entry currently presents (the fixture's mainView retention). */
export function __testPresentedSession(label) {
  return presentedByEntry.get(label)?.sessionId
}

export function __testSetSessionsListed(value) {
  sessionsListed = value
}

/** Simulate the runtime sessions service being (un)available at read time. */
export function __testSetSessionsAvailable(value) {
  sessionsAvailable = value
}

/** Simulate the ui-workspace view owner activating after the sessions face. */
export function __testSetNavigationAvailable(value) {
  navigationAvailable = value
}

/** Make the view-owner reflect lookup itself throw (the hostile-proxy arm). */
export function __testSetNavigationReadError(value) {
  navigationReadError = value
}

/** Remove the whole reflect face from the runtimeCtx (a host without the lookup layer). */
export function __testSetReflectAvailable(value) {
  reflectAvailable = value
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

/** The failed boot's loader entries (sweep: `{ options.name, fiber.state }`). */
export function __testSetLoaderEntries(value) {
  loaderEntries = value ?? []
}

export function __testResetLifecycle() {
  for (const gate of allRunGates) gate.release()
  for (const gate of allDisposeGates) gate.release()
  allRunGates.clear()
  allDisposeGates.clear()
  runGates.length = 0
  disposeGates.length = 0
  entryStates.length = 0
  retainedSessions.length = 0
  releasedSessions.length = 0
  presentedByEntry.clear()
  entrySequence = 0
  sessionsListed = true
  sessionsAvailable = true
  navigationAvailable = true
  navigationReadError = undefined
  reflectAvailable = true
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
