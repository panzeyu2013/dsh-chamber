/**
 * The wait/install wiring of the Browser tab type (design 28 §5.2).
 *
 * The regression this pins: a one-shot `ctx.get('sidebarRightTabs')` probe
 * registered the tab only on the page's FIRST boot (the local instance, which
 * pays the chunk fetch) and lost on every source opened later — the "no Browser
 * button on another server" bug. The installer must be armed on `ctx.inject`,
 * must NOT run eagerly, and must run when the registry appears.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REGISTRY_GRACE_MS,
  waitForSidebarTabs,
  type RegistryWaitContext,
} from '../../src/client/registry-wait.ts'

interface Harness {
  ctx: RegistryWaitContext
  service: { value: unknown }
  injected: { deps: string[]; callback: (host: RegistryWaitContext) => void }[]
  disposers: (() => void)[]
}

function fake(service: { value: unknown } = { value: undefined }): Harness {
  const injected: Harness['injected'] = []
  const disposers: Harness['disposers'] = []
  const ctx: RegistryWaitContext = {
    get: () => service.value,
    inject: (deps, callback) => { injected.push({ deps, callback }); return undefined },
    effect: (body) => {
      const disposer = body()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, service, injected, disposers }
}

test('arms ctx.inject for the registry and installs nothing eagerly', () => {
  const harness = fake()
  let installs = 0
  waitForSidebarTabs(harness.ctx, () => { installs += 1 })
  assert.equal(installs, 0, 'an eager install is the first-boot-only regression')
  assert.equal(harness.injected.length, 1)
  assert.deepEqual(harness.injected[0].deps, ['sidebarRightTabs'])
})

test('installs on the context where the registry appeared', () => {
  const harness = fake()
  const seen: RegistryWaitContext[] = []
  waitForSidebarTabs(harness.ctx, (host) => { seen.push(host) })
  harness.service.value = { register() {} }
  harness.injected[0].callback(harness.ctx)
  assert.deepEqual(seen, [harness.ctx])
})

test('diagnoses a registry that never arrives, once, after the grace', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  const harness = fake()
  waitForSidebarTabs(harness.ctx, () => { throw new Error('must not install') })
  t.mock.timers.tick(REGISTRY_GRACE_MS - 1)
  assert.deepEqual(warnings, [])
  t.mock.timers.tick(1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sidebarRightTabs is still absent/u)
})

test('stays quiet when any registry value exists at fire time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  // A malformed value is the installer's diagnostic (it warns with the shape copy);
  // the absence diagnostic must not claim "still absent" on top of it.
  const harness = fake({ value: { notARegistry: true } })
  waitForSidebarTabs(harness.ctx, () => {})
  t.mock.timers.tick(REGISTRY_GRACE_MS)
  assert.deepEqual(warnings, [])
})

test('clears the grace timer with the context', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  const harness = fake()
  waitForSidebarTabs(harness.ctx, () => {})
  for (const dispose of harness.disposers) dispose()
  t.mock.timers.tick(REGISTRY_GRACE_MS)
  assert.deepEqual(warnings, [])
})
