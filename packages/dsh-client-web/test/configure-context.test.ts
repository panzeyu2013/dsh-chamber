/**
 * Real AppWebEntry.configureContext seam tests (design 05 §4).
 *
 * This suite imports the actual copied `src/boot.ts` (unlike
 * renderer/shell.test.ts), so the AppWebEntry.run chain under assertion is
 * production code; the test-only loader replaces only unbuilt external package
 * exports and CSS.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AppWebEntry } from '../src/boot.ts'
import {
  bootRuntimeEvents,
  Context,
  recordBootRuntimeEvent,
  resetBootRuntimeEvents,
} from './fixtures/boot-runtime.mjs'

class ElementStub {
  className = ''
  textContent = ''
  dataset: Record<string, string> = {}
  parentElement: ElementStub | null = null
  children: ElementStub[] = []
  style = { setProperty() {} }
  // A real container is an HTMLElement and therefore carries its document; the
  // boot chain reads it for the window-drag watcher, which is a no-op on any
  // platform other than darwin.
  ownerDocument = { documentElement: { dataset: { platform: 'test' } } }

  append(...children: ElementStub[]): void {
    for (const child of children) child.parentElement = this
    this.children.push(...children)
  }

  replaceChildren(...children: ElementStub[]): void {
    for (const child of this.children) child.parentElement = null
    for (const child of children) child.parentElement = this
    this.children = children
  }

  remove(): void {
    if (this.parentElement === null) return
    this.parentElement.children = this.parentElement.children.filter(child => child !== this)
    this.parentElement = null
  }
}

/**
 * Install the DOM and shared-module globals (plus an optional console.error
 * capture); the returned restore undoes every patch it applied.
 */
function installBootHarness(
  options: { immediate?: boolean; onPrefetch?: () => Promise<void> } = {},
  captureConsole = false,
) {
  const globals = globalThis as Record<string, unknown>
  const previousDom = globals.document
  const previousModules = globals.__DSH_MODULES__
  globals.document = { createElement: () => new ElementStub() }
  globals.__DSH_MODULES__ = {
    manifest: {
      plugins: options.immediate === true ? [{ id: '@example/manifest-row', immediately: true }] : [],
    },
    prefetch() {
      return options.onPrefetch?.() ?? Promise.resolve()
    },
  }
  const originalConsoleError = console.error
  const logged: unknown[] = []
  if (captureConsole) console.error = reason => { logged.push(reason) }
  return {
    logged,
    restore() {
      console.error = originalConsoleError
      if (previousModules === undefined) delete globals.__DSH_MODULES__
      else globals.__DSH_MODULES__ = previousModules
      if (previousDom === undefined) delete globals.document
      else globals.document = previousDom
    },
  }
}

test('configureContext: real boot calls it exactly once before first plugin materialization/await', async () => {
  let releasePrefetch!: () => void
  const prefetchGate = new Promise<void>(resolve => { releasePrefetch = resolve })
  const { restore } = installBootHarness({ immediate: true, onPrefetch: () => prefetchGate })
  resetBootRuntimeEvents()
  let configured = 0
  let configuredContext: unknown
  const entry = new AppWebEntry(new ElementStub() as unknown as HTMLElement, {
    configureContext(ctx) {
      configured += 1
      configuredContext = ctx
      recordBootRuntimeEvent('configure')
    },
  })
  try {
    const running = entry.run()
    // The immediate-tier prefetch is intentionally still pending. Context
    // configuration and the first ctx.plugin call must nevertheless already
    // have happened synchronously, in that order.
    assert.equal(configured, 1)
    assert.ok(configuredContext instanceof Context)
    assert.deepEqual(
      bootRuntimeEvents().slice(0, 3),
      ['context', 'configure', 'plugin-materialize'],
    )

    // Await assimilation is a microtask; it still must precede every loader
    // row materialization, which is blocked by the prefetch gate.
    await Promise.resolve()
    assert.deepEqual(bootRuntimeEvents(), ['context', 'configure', 'plugin-materialize', 'plugin-await'])
    releasePrefetch()
    await running

    const events = bootRuntimeEvents()
    assert.equal(configured, 1)
    assert.ok(events.indexOf('plugin-await') < events.indexOf('materialize:@deepseek-ai/dsh-client-modules'))
    assert.ok(events.indexOf('materialize:@deepseek-ai/dsh-client-modules') < events.indexOf('loader-await'))
    assert.equal(entry.bootError, undefined)
  } finally {
    releasePrefetch()
    await entry.dispose()
    restore()
  }
})

test('configureContext: a throw is logged and exposed through real AppWebEntry.bootError', async () => {
  const { logged, restore } = installBootHarness({}, true)
  resetBootRuntimeEvents()
  let configured = 0
  const reason = new Error('configure context exploded')
  const entry = new AppWebEntry(new ElementStub() as unknown as HTMLElement, {
    configureContext() {
      configured += 1
      recordBootRuntimeEvent('configure')
      throw reason
    },
  })
  try {
    await entry.run()
    assert.equal(configured, 1)
    assert.equal(entry.bootError, 'configure context exploded')
    assert.deepEqual(logged, [reason])
    assert.deepEqual(bootRuntimeEvents(), ['context', 'configure'])
  } finally {
    await entry.dispose()
    restore()
  }
})

test('configureContext: hostile thrown values settle through bootError without rejecting run()', async () => {
  const { restore } = installBootHarness({}, true)
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error('prototype coercion exploded')
    },
    get(_target, key) {
      if (key === Symbol.toPrimitive || key === 'toString' || key === 'message' || key === 'name') {
        throw new Error('property coercion exploded')
      }
      return undefined
    },
  })
  const entry = new AppWebEntry(new ElementStub() as unknown as HTMLElement, {
    configureContext() {
      throw hostile
    },
  })
  try {
    await assert.doesNotReject(entry.run())
    assert.equal(entry.bootError, 'unknown error')
  } finally {
    await entry.dispose()
    restore()
  }
})
