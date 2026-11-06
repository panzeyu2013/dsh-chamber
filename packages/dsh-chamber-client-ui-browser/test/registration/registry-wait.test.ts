/**
 * The readiness wait of the Browser tab registration (fork of the upstream
 * plugin: the right-sidebar host row may apply after this deferred chunk).
 *
 * The regression this pins: a one-shot registry probe registered the tab only
 * on the page's FIRST boot and lost on every source opened later — the "no
 * Browser button on another server" bug. The installer must be armed on
 * `ctx.inject` with BOTH services (`sidebarRight` + `sidebarRightTabs`), must
 * NOT run eagerly, and must warn only about services that never arrive.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REGISTRY_GRACE_MS,
  SIDEBAR_HOST_SERVICES,
  waitForSidebarHost,
  type RegistryWaitContext,
} from '../../src/client/registry-wait.ts'

interface Harness {
  ctx: RegistryWaitContext
  services: Map<string, unknown>
  injected: { deps: string[]; callback: (host: RegistryWaitContext) => void }[]
  disposers: (() => void)[]
}

function fake(initial: Record<string, unknown> = {}): Harness {
  const services = new Map<string, unknown>(Object.entries(initial))
  const injected: Harness['injected'] = []
  const disposers: Harness['disposers'] = []
  const ctx: RegistryWaitContext = {
    get: (name) => services.get(name),
    inject: (deps, callback) => { injected.push({ deps, callback }); return undefined },
    effect: (body) => {
      const disposer = body()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, services, injected, disposers }
}

test('arms ctx.inject for both right-sidebar services and installs nothing eagerly', () => {
  const harness = fake()
  let installs = 0
  waitForSidebarHost(harness.ctx, () => { installs += 1 })
  assert.equal(installs, 0, 'an eager install is the first-boot-only regression')
  assert.equal(harness.injected.length, 1)
  assert.deepEqual(harness.injected[0].deps, ['sidebarRight', 'sidebarRightTabs'])
  assert.deepEqual([...SIDEBAR_HOST_SERVICES], ['sidebarRight', 'sidebarRightTabs'])
})

test('installs on the context where the services appeared', () => {
  const harness = fake()
  const seen: RegistryWaitContext[] = []
  waitForSidebarHost(harness.ctx, (host) => { seen.push(host) })
  harness.services.set('sidebarRight', { openTabs: {} })
  harness.services.set('sidebarRightTabs', { register() {} })
  harness.injected[0].callback(harness.ctx)
  assert.deepEqual(seen, [harness.ctx])
})

test('diagnoses services that never arrive, once, after the grace', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  const harness = fake()
  waitForSidebarHost(harness.ctx, () => { throw new Error('must not install') })
  t.mock.timers.tick(REGISTRY_GRACE_MS - 1)
  assert.deepEqual(warnings, [])
  t.mock.timers.tick(1)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sidebarRight, sidebarRightTabs still absent/u)
})

test('names only the missing service when the other one is present', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  const harness = fake({ sidebarRight: { openTabs: {} } })
  waitForSidebarHost(harness.ctx, () => {})
  t.mock.timers.tick(REGISTRY_GRACE_MS)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /sidebarRightTabs still absent/u)
  assert.doesNotMatch(warnings[0], /sidebarRight, /u)
})

test('stays quiet when both services exist at fire time', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  const harness = fake({ sidebarRight: { openTabs: {} }, sidebarRightTabs: { register() {} } })
  waitForSidebarHost(harness.ctx, () => {})
  t.mock.timers.tick(REGISTRY_GRACE_MS)
  assert.deepEqual(warnings, [])
})

test('clears the grace timer with the context', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  const harness = fake()
  waitForSidebarHost(harness.ctx, () => {})
  for (const dispose of harness.disposers) dispose()
  t.mock.timers.tick(REGISTRY_GRACE_MS)
  assert.deepEqual(warnings, [])
})
