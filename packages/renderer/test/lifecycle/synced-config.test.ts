/**
 * Browser-synced plugin Config supply (0.2.3-alpha.1 W4-0 / PLAN §12.3.1 + §13.1).
 *
 * The measured failure this file guards against: a covered client plugin whose alpha.1
 * `apply(ctx, config)` dereferences its synced Config is mounted by the composite WITHOUT a
 * second argument. The caller never throws, the plugin fiber ends FAILED and the ROOT fiber
 * stays ACTIVE — the user gets an empty shell and the boot reports success (the connection →
 * api-gateway → remote → api-remotes PENDING chain).
 *
 * The tests cover the two supply paths the composite uses:
 *  1. COVERED rows — `register()` passes {@link syncedConfigActivationFor} as `ctx.plugin`'s
 *     second argument (roster-gated, so a plugin with its own Config schema is untouched);
 *  2. EXTRA rows — the per-instance `internal/config` listener turns `loader.create({ name })`
 *     into an activation with the same per-field reference object.
 * Plus the wire/merge seams the values come from: `HostGraphRow.config` parsing, the
 * covered-row capture BEFORE `dedupeCoveredRows`, and the source-text wiring locks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createSyncedConfigActivation, installSyncedConfigSupply, SYNCED_CONFIG_COVERED_IDS,
  syncedConfigActivationFor, type SyncedConfigSupply,
} from '../../src/synced-config.ts'
import {
  coveredSyncedConfigValues, parseGraphRows, toExtraRows,
} from '../../src/host-graph.ts'
import { CHAMBER_COVERED_IDS } from '../../src/chamber-covered.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const readSource = (rel: string): string =>
  stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))

/** One wire row in the shape the host graph carries (config optional). */
const wireRow = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  url: `/plugins/??${id}&rev=abc123`,
  rev: 'abc123',
  ...over,
})

test('createSyncedConfigActivation: per-field refs, absent fields undefined, identity stable', () => {
  const config = createSyncedConfigActivation({
    recovery: { httpTimeoutMs: 5_000 },
    maxConcurrentFileUploads: 3,
  }) as Record<string, any>
  // The plugins' alpha.1 deref shapes: .get(), .getSnapshot(), .subscribe().
  assert.deepEqual(config.recovery.get(), { httpTimeoutMs: 5_000 })
  assert.equal(config.recovery.getSnapshot(), config.recovery.get())
  const recovery = config.recovery
  assert.equal(config.recovery, recovery, 'a field reference keeps its identity across reads')
  assert.equal(config.maxConcurrentFileUploads.get(), 3)
  // A field the host never sent is NOT has-own but reads undefined (the plugins' fallback path).
  assert.equal(Object.hasOwn(config, 'recentViewLimit'), false)
  assert.equal(config.recentViewLimit.get(), undefined)
  assert.deepEqual(Object.keys(config), ['recovery', 'maxConcurrentFileUploads'])
  // Subscribe/unsubscribe is the observable contract (a live writer would notify; boot supply
  // never writes, so unsubscribe is asserted by not throwing and returning a disposer).
  const listeners: number[] = []
  const dispose = config.recovery.subscribe(() => { listeners.push(1) })
  dispose()
  assert.deepEqual(listeners, [])
  // The boot supply is immutable in this batch: there is no live writer on the ref (a live-config
  // batch adds the writer + notification together, per the module header). This also pins the P2
  // dead-surface cleanup: a never-called FieldRef.write must not come back on its own.
  assert.equal('write' in recovery, false, 'the boot-supply ref carries no live writer')
  // The object is read-only: writes are refused, never silently accepted.
  assert.throws(() => { config.recovery = 1 }, TypeError)
  // Values are deep-frozen: a plugin cannot mutate the host's projection through the ref.
  assert.equal(Object.isFrozen(config.recovery.get()), true)
})

test('createSyncedConfigActivation: no values ⇒ all-undefined refs (the empty-config fallback)', () => {
  const config = createSyncedConfigActivation(undefined) as Record<string, any>
  assert.deepEqual(Object.keys(config), [])
  assert.equal(config.recovery.get(), undefined)
  assert.equal(config.maxConcurrentFileUploads.getSnapshot(), undefined)
  // The empty activation still round-trips through the proxy invariants.
  const injected = createSyncedConfigActivation({}) as Record<string, any>
  assert.equal(injected.anything.get(), undefined)
})

test('SYNCED_CONFIG_COVERED_IDS: every roster id is composite-covered and unique', () => {
  assert.equal(new Set(SYNCED_CONFIG_COVERED_IDS).size, SYNCED_CONFIG_COVERED_IDS.length)
  assert.ok(SYNCED_CONFIG_COVERED_IDS.length >= 6, 'the measured alpha.1 roster is 6 covered rows')
  const covered = new Set(CHAMBER_COVERED_IDS)
  for (const id of SYNCED_CONFIG_COVERED_IDS) {
    assert.ok(covered.has(id), `${id} must stay composite-covered (the composite is its only mounter)`)
  }
  // The silent-empty-shell chain root: connection's apply dereferences config.recovery.
  assert.ok(SYNCED_CONFIG_COVERED_IDS.includes('@deepseek-ai/dsh-client-connection'))
  assert.ok(SYNCED_CONFIG_COVERED_IDS.includes('@deepseek-ai/dsh-client-ui-settings-models'),
    'the DEFERRED roster member takes its config too (the deferred mount path is covered)')
})

test('syncedConfigActivationFor: roster-gated second argument, values threaded from the ctx supply', () => {
  const supply: SyncedConfigSupply = {
    values: new Map([['@deepseek-ai/dsh-client-connection', { recovery: { httpTimeoutMs: 7 } }]]),
    extraRowIds: new Set(),
  }
  const ctx = { chamberSyncedConfig: supply }
  const connection = syncedConfigActivationFor(ctx, '@deepseek-ai/dsh-client-connection') as Record<string, any>
  assert.deepEqual(connection.recovery.get(), { httpTimeoutMs: 7 })
  // A roster id without wire values still gets the empty fallback (fiber stays ACTIVE).
  const workspace = syncedConfigActivationFor(ctx, '@deepseek-ai/dsh-client-ui-workspace') as Record<string, any>
  assert.equal(workspace.recentViewLimit.get(), undefined)
  // Non-roster rows take no second argument: a plugin with its own Config schema must not
  // receive a reference object (cordis would reject it).
  assert.equal(syncedConfigActivationFor(ctx, '@deepseek-ai/dsh-client-ui-chat'), undefined)
  // A missing supply (a test/boot shape without the seam) degrades to the empty fallback.
  const bare = syncedConfigActivationFor({}, '@deepseek-ai/dsh-client-connection') as Record<string, any>
  assert.equal(bare.recovery.get(), undefined)
})

test('installSyncedConfigSupply: publishes the supply and activates EXTRA entry roots only', () => {
  const provided = new Map<string, unknown>()
  const listeners: ((fiber: unknown, next: () => unknown) => unknown)[] = []
  const ctx = {
    provide(name: string, value: unknown): () => void {
      provided.set(name, value)
      return () => {}
    },
    on(name: string, listener: (fiber: unknown, next: () => unknown) => unknown, options?: { global?: boolean }): () => void {
      assert.equal(name, 'internal/config')
      assert.equal(options?.global, true, 'the per-instance listener must bypass context filtering')
      assert.equal((options as { prepend?: boolean }).prepend, true, 'prepend keeps the loader interpolation inside the listener')
      listeners.push(listener)
      return () => {}
    },
  }
  const supply: SyncedConfigSupply = {
    values: new Map([['@scope/extra', { limit: 2 }]]),
    extraRowIds: new Set(['@scope/extra', '@scope/extra-empty']),
  }
  installSyncedConfigSupply(ctx, supply)
  assert.equal(provided.get('chamberSyncedConfig'), supply)
  assert.equal(listeners.length, 1)

  /** A cordis fiber shaped like an entry ROOT: the parent fiber belongs to another entry. */
  const entryRoot = (name: string) => {
    const entry = { options: { name } }
    const fiber = { entry, parent: { fiber: { entry: undefined } } }
    return fiber
  }
  const nextValue = { raw: 'config' }
  const next = () => nextValue
  // The extra row's entry root receives the per-field reference object.
  const activation = listeners[0]!(entryRoot('@scope/extra'), next) as Record<string, any>
  assert.notEqual(activation, nextValue)
  assert.equal(activation.limit.get(), 2)
  assert.equal(listeners[0]!(entryRoot('@scope/extra'), next), activation,
    'one activation per extra row (identity is stable)')
  // An extra row WITHOUT wire values still gets an activation (empty refs, upstream parity).
  const emptyExtra = listeners[0]!(entryRoot('@scope/extra-empty'), next) as Record<string, any>
  assert.notEqual(emptyExtra, nextValue)
  assert.equal(emptyExtra.anything.get(), undefined)
  // A kernel row / the composite itself / a CHILD fiber keeps the raw config resolution.
  assert.equal(listeners[0]!(entryRoot('@deepseek-ai/dsh-client-modules'), next), nextValue)
  const childEntry = { options: { name: '@scope/extra' } }
  const childFiber = { entry: childEntry, parent: { fiber: { entry: childEntry } } }
  assert.equal(listeners[0]!(childFiber, next), nextValue)
  // A hostile fiber shape must not break the waterfall (guarded reflection).
  assert.equal(listeners[0]!(null, next), nextValue)
})

test('installSyncedConfigSupply: an own-Config-schema face keeps ordinary config or throws (upstream parity)', () => {
  const listeners: ((fiber: unknown, next: () => unknown) => unknown)[] = []
  const ctx = {
    provide(): () => void { return () => {} },
    on(_name: string, listener: (fiber: unknown, next: () => unknown) => unknown): () => void { listeners.push(listener); return () => {} },
  }
  const supply: SyncedConfigSupply = {
    values: new Map([['@scope/extra', { limit: 2 }]]),
    extraRowIds: new Set(['@scope/extra', '@scope/extra-empty']),
  }
  installSyncedConfigSupply(ctx, supply)
  const rootWithSchema = (name: string) => {
    const entry = { options: { name } }
    return { entry, parent: { fiber: { entry: undefined } }, runtime: { Config: class {} } }
  }
  const next = () => ({ raw: 'config' })
  assert.deepEqual(listeners[0]!(rootWithSchema('@scope/extra-empty'), next), { raw: 'config' },
    'a face with its own schema keeps ordinary config when the Host sent no synced values')
  assert.throws(() => listeners[0]!(rootWithSchema('@scope/extra'), next), /requires the Host schema alone/,
    'synced values plus an own Config schema is a loud error (upstream entries.ts parity)')
})

test('installSyncedConfigSupply: a context without events (test/legacy stub) only publishes the supply', () => {
  const provided = new Map<string, unknown>()
  const ctx = { provide(name: string, value: unknown): void { provided.set(name, value) } }
  const supply: SyncedConfigSupply = { values: new Map(), extraRowIds: new Set() }
  installSyncedConfigSupply(ctx, supply)
  assert.equal(provided.get('chamberSyncedConfig'), supply)
})

test('HostGraphRow.config: parsed/validated like upstream and carried through toExtraRows', () => {
  const rows = parseGraphRows([
    wireRow('@scope/plain'),
    wireRow('@deepseek-ai/dsh-client-connection', { config: { recovery: { httpTimeoutMs: 5_000 } } }),
    wireRow('@scope/extra', { config: { limit: 2 } }),
  ] as never)
  assert.equal(rows[0]!.config, undefined)
  assert.deepEqual(rows[1]!.config, { recovery: { httpTimeoutMs: 5_000 } })
  // The kept row's values travel to the mount path (ExtraModuleRow.config).
  const extras = toExtraRows([rows[2]!], '/api/i/local')
  assert.deepEqual(extras[0]!.config, { limit: 2 })
  assert.equal(toExtraRows([rows[0]!], '/api/i/local')[0]!.config, undefined)
  // Malformed values FAIL the graph parse (a wrong graph is a boot hazard, like upstream).
  assert.throws(() => parseGraphRows([wireRow('@scope/bad', { config: 3 })] as never), /config must be an object/)
  assert.throws(() => parseGraphRows([wireRow('@scope/bad', { config: null })] as never), /config must be an object/)
  assert.throws(() => parseGraphRows([wireRow('@scope/bad', { config: [] })] as never), /config must be an object/)
})

test('coveredSyncedConfigValues: captured BEFORE the dedupe drops the covered rows', () => {
  const rows = parseGraphRows([
    wireRow('@scope/kept', { config: { limit: 9 } }),
    wireRow('@deepseek-ai/dsh-client-connection', { config: { recovery: { httpTimeoutMs: 5_000 } } }),
    wireRow('@deepseek-ai/dsh-client-ui-conversation'),
  ] as never)
  const values = coveredSyncedConfigValues(rows)
  assert.deepEqual([...values.keys()], ['@deepseek-ai/dsh-client-connection'])
  assert.deepEqual(values.get('@deepseek-ai/dsh-client-connection'), { recovery: { httpTimeoutMs: 5_000 } })
  // Non-covered rows are not in the covered map, and a covered row without config is absent
  // (its activation reads undefined, the plugin's own default).
  assert.equal(values.has('@scope/kept'), false)
})

// ── Wiring locks: the supply is useless unless every mount path consumes it.

test('wiring: the shell captures covered config before the merge and publishes the supply', () => {
  const shell = readSource('../../src/shell.ts')
  const hostGraph = readSource('../../src/host-graph.ts')
  // host-graph fires the capture hook BEFORE dedupeCoveredRows (the covered rows' values
  // exist only on the un-deduped wire rows).
  const captureCall = hostGraph.indexOf('deps.onCoveredConfig?.(coveredSyncedConfigValues(firstRows))')
  const dedupeCall = hostGraph.indexOf('const rows = toExtraRows(dedupeCoveredRows(firstRows')
  assert.ok(captureCall > 0, 'collectExtraRows must capture the covered rows\' config')
  assert.ok(dedupeCall > captureCall, 'the capture MUST precede the covered-row dedupe')
  // The shell forwards the capture and installs the per-instance supply before plugins mount.
  assert.match(shell, /onCoveredConfig: \(values\) => \{ coveredSyncedConfig = values \}/)
  assert.match(shell, /installSyncedConfigSupply\(targetContext, supply\)/)
  assert.match(shell, /extraRowIds: new Set\(extraRows\.map\(row => row\.id\)\)/)
})

test('wiring: chamber-entry passes the roster activation to BOTH mount paths', () => {
  const entry = readSource('../../src/chamber-entry.ts')
  // First-screen register: the second ctx.plugin argument.
  assert.match(entry, /const syncedConfig = syncedConfigActivationFor\(ctx, id\)/)
  assert.match(entry, /ctx\.plugin\(decorateMount\(id, plugin\), syncedConfig\)/)
  // Deferred cluster: the same supply (ui-settings-models is a deferred roster member).
  assert.match(entry, /const syncedConfig = syncedConfigActivationFor\(ctx, outcome\.id\)/)
  assert.match(entry, /ctx\.plugin\(deferredPlugin, syncedConfig\)/)
})

test('wiring: the live reconciler lets the per-instance listener activate a newly added extra row', () => {
  const live = readSource('../../src/live-graph.ts')
  assert.match(live, /loader\.create\(\{ name: row\.id \}\)/,
    'the live path must NOT pass the activation through create({ config }): loader interpolation flattens it')
  assert.doesNotMatch(live, /config: createSyncedConfigActivation/)
  const supply = readSource('../../src/synced-config.ts')
  assert.match(supply, /prepend: true/, 'the listener must run before loader interpolation')
  assert.match(supply, /entry root|parent.*fiber.*entry/i, 'the entry-root predicate must match the loader convention')
})
