/**
 * /chamber/runtime activation probes and host-domain derivation: probe-set shape
 * gates, the chamber host registry and syncedHostDomainProbeNames. Split from
 * runtime-routes.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertChamberHostRegistry, CHAMBER_HOST_PACKAGES } from '@dsh-chamber/control-plane'
import { createGatewayRuntimeManager } from '../../src/runtime-manager.ts'
import {
  createChamberPlugins,
  SYNCED_PLUGIN_DIR,
  SYNCABLE_HOST_PACKAGES,
  syncedHostDomainProbeNames,
} from '../../src/plugins.ts'
import {
  PROBE_NAMES_WITHOUT_HOST_DOMAINS,
  REQUIRED_ACTIVATION_PROBES,
  clearActivationJournal,
  readActivationJournalState,
  readCurrentPointer,
  readOverride,
} from '@dsh-chamber/dsh-runtime'
import {
  silentLogger,
  TEST_BUILTIN_VERSION,
  config,
  fakePlane,
  waitForSettle,
  probeResultsFor,
  makeValidTree,
  armPendingSwitch,
  writeOverrideRow,
  writeVersionSwitchIntent,
} from '../support/runtime-routes-harness.ts'

test('applyNow runs the version-switch activation transaction in stop → transaction → start order', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-applynow-order-'))
  try {
    const home = armPendingSwitch(stateDir, '1.0.0')
    const order: string[] = []
    const plane = fakePlane({
      stopLocal: async () => { order.push('stop') },
      startLocal: async () => { order.push('start') },
    })
    plane._state.connectionState = 'ready'
    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      probeCandidate: async () => {
        order.push('probe:override')
        return probeResultsFor(stateDir).map(name => ({ name, ok: true }))
      },
      onActivationQuarantineChange: (active) => { order.push(`quarantine:${active ? 'on' : 'off'}`) },
    })
    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal(order[0], 'quarantine:on', 'derived consumers detach before the host is quiesced')
    assert.ok(order.indexOf('stop') < order.indexOf('probe:override'), 'DSH_HOME is quiesced before snapshot/switch/probe')
    assert.ok(order.indexOf('probe:override') < order.indexOf('quarantine:off'),
      'candidate ready remains quarantined through the complete probe verdict')
    assert.equal(order.filter(entry => entry === 'start').length, 2,
      'one start spawns the candidate inside the transaction (internal spawn), one resumes the verdict winner')
    // P0 regression: the verdict-winner resume must happen AFTER the activation
    // window closes. Inside the window index.ts's canStartLocal gate refuses
    // every non-internal spawn (activationInProgress() && !internalSpawnActive()
    // → connection_busy) — the old apply-now therefore threw on every recovery.
    assert.ok(order.indexOf('quarantine:off') < order.lastIndexOf('start'),
      'the verdict-winner resume happens only after the activation window closes (restoreBuiltin parity)')
    assert.ok(readdirSync(join(stateDir, 'dsh-runtime', 'snapshots')).some(name => name.startsWith(`${TEST_BUILTIN_VERSION}-`)),
      'the switching-from builtin DSH_HOME is snapshotted under its real source version')
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'the pointer switched inside the activation transaction')
    const journal = readActivationJournalState(stateDir)
    assert.equal(journal.kind, 'valid')
    if (journal.kind === 'valid') {
      assert.equal(journal.journal.phase, 'applied-monitoring',
        'a successful version switch keeps the known-good monitoring journal (unlike reset-builtin)')
    }
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"pending":true}')
    const status = await manager.status()
    assert.equal(status.phase, 'idle')
    assert.equal(status.activeVersion, '1.0.0')
    assert.equal(status.operationError, null, 'a clean apply-now clears the operationError projection')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('real manager: the B1 16 MiB settings/describe cap reaches the wire carrier (seam forwarding)', async () => {
  // No probeCandidate injection: the REAL runRuntimeActivationProbes runs
  // through the manager's call seam against a fake dsh host answering the
  // reduced activation set (no seed cache → hostDomains=false, 4 rows). The
  // settings/describe answer carries ~1.3 MiB of namespaces payload — over
  // the default 1 MiB unary cap, under the B1 16 MiB per-call cap. The
  // activation only passes when the seam forwards
  // RuntimeProbeRpcOptions.maxResponseBytes to the control-plane carrier.
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-b1-cap-'))
  const oldEnv = process.env.DSH_GATEWAY_DSH_PATH
  let settingsDescribeAnswered = false
  const padding = 'x'.repeat(1300 * 1024)
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += String(chunk) })
    req.on('end', () => {
      let envelope: { type?: unknown; rpcId?: unknown; method?: unknown } | null = null
      try { envelope = JSON.parse(body) } catch { envelope = null }
      const rpcId = typeof envelope?.rpcId === 'string' ? envelope.rpcId : 'unknown'
      const method = typeof envelope?.method === 'string' ? envelope.method : ''
      const answer = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
      }
      if (method === 'commands/execute') {
        // The exact business miss the probe layer expects (read-only).
        answer({ ok: false, error: { code: 'session/not-found', message: 'missing probe session' } })
        return
      }
      if (method === 'session/canOpenWorkspacePath') {
        answer({ ok: true, value: true })
        return
      }
      if (method === 'settings/describe') {
        settingsDescribeAnswered = true
        // A legitimately large settings answer: > 1 MiB (the default unary
        // cap) but well under the 16 MiB B1 cap.
        answer({ ok: true, value: { writable: true, namespaces: [{ name: 'probe', padding }] } })
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  let manager: ReturnType<typeof createGatewayRuntimeManager> | null = null
  try {
    delete process.env.DSH_GATEWAY_DSH_PATH
    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    // The data.settings probe reads settings.yaml (never settings.json).
    writeFileSync(join(home, 'settings.yaml'), 'locale:\n  preference: zh\n')
    writeVersionSwitchIntent(stateDir, '1.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: '1.0.0', selectedOnly: false })
    const plane = fakePlane({
      getLocalDshPort: () => port,
      localDshPort: port,
    })
    plane._state.connectionState = 'ready'
    manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
    })
    await manager.applyNow()
    await waitForSettle(manager)
    assert.equal(manager.applyNowInFlight(), false)
    assert.equal(settingsDescribeAnswered, true, 'the settings/describe probe reached the fake host')
    assert.equal(readCurrentPointer(stateDir), '1.0.0',
      'activation passed — the 16 MiB per-call cap reached the carrier through the manager seam')
    const status = await manager.status()
    assert.equal(status.operationError, null, 'a clean apply-now clears the operationError projection')
    await manager.dispose()
    manager = null
  } finally {
    if (oldEnv === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = oldEnv
    await manager?.dispose().catch(() => {})
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('2026-12 shape gate: a synced seed cache flips the activation to the FULL probe set — and drift fails closed', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-shape-'))
  try {
    // Seed EVERY registry host package into the gateway seed cache, exactly
    // as a connecting desktop would (PUT /chamber/plugins →
    // chamber-plugins cache). The probe shape gate — the per-package
    // derivation syncedHostDomainProbeNames over the actually-present
    // packages — must now derive the full 7-name set
    // (REQUIRED_ACTIVATION_PROBES); this is the flow that makes a fresh
    // gateway pick the chamber host layer up after the first desktop sync.
    // Partial syncs derive the exact expected set instead (design 24 §7 C, M2)
    // — covered directly by the syncedHostDomainProbeNames matrix tests below.
    const plugins = createChamberPlugins(stateDir, silentLogger)
    for (const name of HOST_PACKAGE_NAMES) {
      await plugins.put(name, {
        'package.json': JSON.stringify({ name, version: '1.0.0' }),
        'dist/index.js': 'export const ok = 1\n',
      })
    }
    assert.deepEqual(syncedHostDomainProbeNames(stateDir), [...HOST_PACKAGE_DOMAINS],
      'the populated cache must derive the full registry-domain probe list')
    assert.deepEqual(probeResultsFor(stateDir), [...REQUIRED_ACTIVATION_PROBES],
      'the synced shape expects the FULL probe set, chamber host domains included')

    makeValidTree(stateDir, '1.0.0')
    const home = join(stateDir, 'dsh-home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"pending":true}')
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, selectedOnly: true })

    // Full-set candidate (the synced shape) → activation PASSES.
    const passingPlane = fakePlane()
    passingPlane._state.connectionState = 'ready'
    const passing = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: passingPlane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    await passing.applyNow()
    await waitForSettle(passing)
    assert.equal(readCurrentPointer(stateDir), '1.0.0', 'full-set activation passes once the cache is synced')
    assert.equal((await passing.status()).operationError, null)
    await passing.dispose()

    // Drift: the probe returns the REDUCED set while the verdict expects the
    // FULL set (a mid-transaction cache flip or a desynced shape gate) — the
    // activation must FAIL CLOSED, never pass on a partial probe set.
    clearActivationJournal(stateDir)
    makeValidTree(stateDir, '2.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '2.0.0', pending: null, selectedOnly: true, lastOutcome: 'applied' })
    const driftingPlane = fakePlane()
    driftingPlane._state.connectionState = 'ready'
    const drifting = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: driftingPlane,
      logger: silentLogger,
      waitBeforeRetry: async () => {},
      probeCandidate: async ({ isBuiltin }) => {
        return [...PROBE_NAMES_WITHOUT_HOST_DOMAINS].map(name => ({ name, ok: !isBuiltin, ...(!isBuiltin ? {} : { error: 'rejected' }) }))
      },
    })
    await drifting.applyNow()
    await waitForSettle(drifting)
    // The drift poisons EVERY verdict in the transaction: the candidate fails
    // the exact-set check, and the fallback/builtin verification probes fail
    // the same way — the activation ends 'failed' with the pointer cleared
    // (fail-closed), never a partial 'pass' on a reduced probe set.
    assert.equal(readOverride(stateDir)?.lastOutcome, 'failed',
      'the reduced-set drift must fail the activation (fallback verification included)')
    assert.equal(readCurrentPointer(stateDir), null, 'the drift-failed activation clears the pointer (builtin fallback)')
    assert.notEqual((await drifting.status()).operationError, null, 'the drift failure projects into the operationError')
    await drifting.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// M2 derivation matrix: syncedHostDomainProbeNames (design 24 §7 C) — the
// per-package derivation that replaced the binary hasSyncedHostSeed gate.
// ---------------------------------------------------------------------------

// Derived from the control-plane registry (review G2-3): a hand-maintained
// three-name copy would silently shrink this matrix when a 4th registry row
// lands, so the package names and probe domains come from CHAMBER_HOST_PACKAGES
// itself. The length pin below keeps the derivation honest.
const HOST_PACKAGE_NAMES = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.name)
const HOST_PACKAGE_DOMAINS = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.probe.method)

/** Seed the given host packages into a real cache under the test stateDir,
 *  exactly as a connecting desktop would (PUT /chamber/plugins). */
async function syncPackagesInto(stateDir: string, names: readonly string[]): Promise<void> {
  const plugins = createChamberPlugins(stateDir, silentLogger)
  for (const name of names) {
    await plugins.put(name, {
      'package.json': JSON.stringify({ name, version: '1.0.0' }),
      'dist/index.js': 'export const ok = 1\n',
    })
  }
}

test('the registry derivation covers every chamber host package (never a shrunk row copy)', () => {
  assert.ok(HOST_PACKAGE_NAMES.length >= 3, 'the registry must still carry the base host packages')
  assert.equal(HOST_PACKAGE_NAMES.length, SYNCABLE_HOST_PACKAGES.length,
    'the syncable list is the registry')
  assert.equal(HOST_PACKAGE_DOMAINS.length, HOST_PACKAGE_NAMES.length)
  assert.equal(new Set(HOST_PACKAGE_DOMAINS).size, HOST_PACKAGE_DOMAINS.length,
    'every registry row owns a distinct probe domain (assertChamberHostRegistry pins this at load)')
  assertChamberHostRegistry(CHAMBER_HOST_PACKAGES)
})

test('assertChamberHostRegistry: a 4th row reusing an existing probe domain fails loud', () => {
  // The set-equality drift pin alone would PASS here (the domain set is
  // unchanged) while HOST_PACKAGE_PROBE_DOMAINS became ambiguous — the
  // duplicate-method pin is what catches it.
  assert.throws(
    () => assertChamberHostRegistry([
      ...CHAMBER_HOST_PACKAGES,
      { insert: { id: 'ghost', name: '@dsh-chamber/dsh-host-ghost' }, probe: { method: HOST_PACKAGE_DOMAINS[0], args: {} } },
    ]),
    /probe method .* is claimed by more than one host package/,
  )
  assert.throws(
    () => assertChamberHostRegistry([
      ...CHAMBER_HOST_PACKAGES,
      { insert: { id: CHAMBER_HOST_PACKAGES[0].insert.id, name: '@dsh-chamber/dsh-host-other' }, probe: { method: 'future/domain', args: {} } },
    ]),
    /duplicate loader insert id/,
  )
  assert.throws(
    () => assertChamberHostRegistry([
      ...CHAMBER_HOST_PACKAGES,
      { insert: { id: 'other', name: CHAMBER_HOST_PACKAGES[0].insert.name }, probe: { method: 'future/domain', args: {} } },
    ]),
    /duplicate host package name/,
  )
})

test('syncedHostDomainProbeNames: an empty cache derives an empty list (plain dsh shape)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-derive-empty-'))
  try {
    assert.deepEqual(syncedHostDomainProbeNames(stateDir), [])
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('syncedHostDomainProbeNames: 1-of-N and 2-of-N caches derive exactly the mounted domains in canonical order', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-derive-partial-'))
  try {
    await syncPackagesInto(stateDir, [HOST_PACKAGE_NAMES[0]])
    assert.deepEqual(syncedHostDomainProbeNames(stateDir), [HOST_PACKAGE_DOMAINS[0]])
    await syncPackagesInto(stateDir, [HOST_PACKAGE_NAMES[1]])
    assert.deepEqual(syncedHostDomainProbeNames(stateDir), [HOST_PACKAGE_DOMAINS[0], HOST_PACKAGE_DOMAINS[1]])
    // An interrupted third sync leaves the 2-of-N derivation stable (the set
    // never shrinks from a later probe run).
    assert.deepEqual(syncedHostDomainProbeNames(stateDir), [HOST_PACKAGE_DOMAINS[0], HOST_PACKAGE_DOMAINS[1]])
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('syncedHostDomainProbeNames: a full cache derives every registry domain; a stray non-syncable cache dir stays inert', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-derive-full-'))
  try {
    await syncPackagesInto(stateDir, HOST_PACKAGE_NAMES)
    assert.deepEqual(syncedHostDomainProbeNames(stateDir), [...HOST_PACKAGE_DOMAINS],
      'the full cache must derive EVERY registry domain, not a hand-written subset')
    // A pre-upgrade leftover dir for a package that is no longer syncable is
    // inert: stray cache content can neither add nor remove a derived domain.
    mkdirSync(join(stateDir, SYNCED_PLUGIN_DIR, 'stale-package', 'dist'), { recursive: true })
    writeFileSync(join(stateDir, SYNCED_PLUGIN_DIR, 'stale-package', 'dist', 'index.js'), 'export const stale = 1\n')
    assert.deepEqual(syncedHostDomainProbeNames(stateDir), [...HOST_PACKAGE_DOMAINS])
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('syncedHostDomainProbeNames: a cache entry whose package has no domain mapping fails loud (never a silent skip)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-derive-drift-'))
  try {
    // A syncable host package the HOST_PACKAGE_PROBE_DOMAINS map does not
    // know would silently drop its probe row from the expected set (fail-open
    // for a mounted domain). The module constants cannot drift at runtime, so
    // the derivation's injectable package-list seam drives the branch — the
    // same drift class activationProbeNamesForDomains throws on.
    const ghost = { id: 'ghost', name: '@dsh-chamber/dsh-host-ghost' }
    mkdirSync(join(stateDir, SYNCED_PLUGIN_DIR, 'dsh-host-ghost', 'dist'), { recursive: true })
    writeFileSync(join(stateDir, SYNCED_PLUGIN_DIR, 'dsh-host-ghost', 'dist', 'index.js'), 'export const ghost = 1\n')
    assert.throws(
      () => syncedHostDomainProbeNames(stateDir, [...SYNCABLE_HOST_PACKAGES, ghost]),
      /"@dsh-chamber\/dsh-host-ghost" has no activation probe domain/,
    )
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
