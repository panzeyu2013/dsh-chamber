/**
 * Minimal external-runtime fixture for the REAL boot.ts seam tests.
 *
 * The copied dsh workspace is source-only (bare package exports point at
 * unbuilt lib files), so the test loader maps boot.ts's external Cordis/module
 * imports here. Local boot.ts/BootPage/row/tolerance code remains real. The
 * event log makes Context configuration order observable without duplicating
 * AppWebEntry itself.
 */
const events = []

export function resetBootRuntimeEvents() {
  events.length = 0
}

/**
 * Per-name fiber plans for the post-await sweep tests. Absent names keep the default
 * active fiber; a plan can be fiberless (import failed), carry a state value
 * (0 pending / 1 loading / 2 active / 3 failed / 4 disposed / 5 unloading) and an
 * activation error rethrown through `fiber.await()` the way cordis does.
 */
const scenario = new Map()

export function setBootScenario(rows = []) {
  scenario.clear()
  for (const row of rows) scenario.set(row.name, row)
}

export function bootRuntimeEvents() {
  return [...events]
}

export function recordBootRuntimeEvent(event) {
  events.push(event)
}

export class Context {
  constructor() {
    events.push('context')
    const entries = new Map()
    this.loader = {
      internal: undefined,
      async create({ name }) {
        events.push(`materialize:${name}`)
        const planned = scenario.get(name)
        const entry = planned?.fiberless === true
          ? { options: { name }, fiber: undefined }
          : {
            options: { name },
            fiber: {
              state: planned?.state ?? 2,
              inject: {},
              async await() { if (planned?.activationError !== undefined) throw new Error(planned.activationError) },
            },
          }
        entries.set(name, entry)
        return name
      },
      resolve(id) {
        return entries.get(id)
      },
      entries() {
        return entries.values()
      },
      async await() {
        events.push('loader-await')
      },
    }
    this.fiber = {
      async dispose() {
        events.push('dispose')
      },
    }
  }

  plugin() {
    events.push('plugin-materialize')
    // A custom thenable records the exact point at which boot.ts awaits the
    // first plugin application (ctx.plugin(Loader)).
    return {
      then(resolve) {
        events.push('plugin-await')
        resolve()
      },
    }
  }

  on() {}

  get() {
    return undefined
  }

  async inject(_services, callback) {
    events.push('mount-inject')
    callback({
      uiRenderer: {
        mount() {
          events.push('mount')
          return () => {}
        },
      },
      effect(effect) {
        effect()
      },
    })
  }
}

// boot.ts imports the loader as a default plugin value. Context.plugin does
// not inspect it; identity alone is sufficient for this seam-level boot.
const Loader = { name: 'fixture-loader' }
export default Loader

// Should the real module-system construction path accidentally run, fail
// loudly instead of letting this fixture mask the missing shared test table.
export function createClientModuleSystem() {
  throw new Error('boot-runtime fixture: unexpected module-system construction')
}

export function apply() {}

/** react-dom surface the alpha.3 @tanstack/react-virtual import touches. */
export const flushSync = (callback) => { callback() }