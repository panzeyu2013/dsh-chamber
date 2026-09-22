/**
 * /chamber/runtime builtin/anchor selection and post-update invalidation:
 * restore-pre-rollback, pnpm entry resolution, the builtin snapshot and staged
 * re-selection. Split from runtime-routes.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { createRequire } from 'node:module'
import { createGatewayRuntimeManager, readBuiltinVersion } from '../../src/runtime-manager.ts'
import {
  readActivationJournalState,
  readCurrentPointerState,
  writeCurrentPointer,
  writeOverride,
  stashPreRollback,
} from '@dsh-chamber/dsh-runtime'
import { createRuntimeRoutes } from '../../src/runtime-routes.ts'
import {
  silentLogger,
  gatewayPackageVersion,
  config,
  fakePlane,
  runRoute,
  waitForSettle,
  probeResultsFor,
  makeValidTree,
  readOverrideRow,
  writeOverrideRow,
  writeVersionSwitchIntent,
  runtimeManager,
  derivedProbe,
} from '../support/runtime-routes-harness.ts'

test('restore-pre-rollback complete keeps an env-probe-failed resume verdict (MAJOR-1 regression)', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-restore-resume-env-'))
  const home = join(stateDir, 'dsh-home')
  try {
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), '{"source":"v1"}')
    const stashPath = await stashPreRollback(stateDir, home)
    assert.ok(stashPath.startsWith(join(stateDir, 'dsh-runtime', 'pre-rollback')), 'the stash lives under the pre-rollback dir')
    writeFileSync(join(home, 'settings.json'), '{"source":"v2"}')

    const manager = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      // The env probe in the RESUME transaction fails: the runtime answers
      // the plane health check but lacks a required feature (A-U2).
      probeCandidate: async () => probeResultsFor(stateDir).map((name, index) => ({ name, ok: index !== 0 })),
    })
    const res = await manager.restorePreRollback(basename(stashPath))
    assert.deepEqual(res, { accepted: true })
    const s = await manager.status()
    assert.equal(s.startupBlockedReason, 'env-probe-failed', 'the resume verdict must survive the complete branch (the old code cleared it, leaving stopped + clean)')
    assert.match(s.operationError ?? '', /env runtime activation probes failed/)
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), '{"source":"v1"}', 'DSH_HOME was restored from the stash')
    await manager.dispose()

    // Re-probe on the next startup transaction (fix the target → restart the
    // gateway semantics): an all-ok probe manager on the same state clears it.
    const recovered = createGatewayRuntimeManager({
      config: config(stateDir),
      plane: fakePlane(),
      logger: silentLogger,
      probeCandidate: async () => probeResultsFor(stateDir).map(name => ({ name, ok: true })),
    })
    assert.deepEqual(await recovered.startupTransaction(), { blockedReason: null })
    assert.equal((await recovered.status()).startupBlockedReason, null)
    await recovered.dispose()
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('env-probe-failed closes every mutation route with an explicit no-recovery-route refusal (A-U2 gate coverage)', async () => {
  const manager = {
    status: () => ({ phase: 'idle', pending: null, startupBlockedReason: 'env-probe-failed' }),
    mutationInProgress: () => false,
    restartInFlight: () => false,
    startInFlight: () => false,
  }
  const routes = createRuntimeRoutes(() => manager as never, silentLogger)
  for (const [suffix, method, payload] of [
    ['select', 'POST', JSON.stringify({ version: '1.0.0' })],
    ['apply', 'POST', undefined],
    ['apply-now', 'POST', undefined],
    ['rollback', 'POST', JSON.stringify({ version: '1.0.0' })],
    ['cleanup-version', 'POST', JSON.stringify({ version: '1.0.0' })],
    ['restore-pre-rollback', 'POST', JSON.stringify({ stashName: '1700000000000-deadbeef' })],
    ['retry-apply', 'POST', undefined],
    ['retry-restore', 'POST', undefined],
    ['restore-builtin', 'POST', undefined],
    ['recover-metadata', 'POST', undefined],
    ['restart', 'POST', undefined],
    ['start', 'POST', undefined],
    ['registry', 'PUT', JSON.stringify({ origin: 'https://registry.npmmirror.com' })],
  ] as const) {
    const response = await runRoute(routes, method, `/chamber/runtime/${suffix}`, payload)
    assert.equal(response.status, 409, `${suffix} must refuse under env-probe-failed`)
    assert.equal((response.json as { code: string }).code, 'runtime_recovery_required', suffix)
    assert.match((response.json as { error: string }).error, /no recovery route applies/, suffix)
  }
})

test('the gateway pnpm installer entry resolves to an existing file (R9-R1: exports-hidden subpath regression)', () => {
  const require = createRequire(import.meta.url)
  // Mirror the manager's strategy: pnpm's exports only exposes '.', so join
  // the bin path from the resolved package.json — and assert it exists.
  const pnpmPkg = require.resolve('pnpm')
  assert.ok(pnpmPkg.endsWith('package.json'), `resolved pnpm entry is its package.json (${pnpmPkg})`)
  const entry = join(dirname(pnpmPkg), 'bin', 'pnpm.cjs')
  assert.ok(existsSync(entry), `pnpm CLI entry must exist at ${entry}`)
})


test('readBuiltinVersion reads the anchor package version (F1 regression)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-rt-builtin-ver-'))
  try {
    assert.equal(readBuiltinVersion(dir), null, 'missing package.json → null')
    const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }))
    assert.equal(readBuiltinVersion(dir), '9.9.9')
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true })
    const sourceDir = join(dir, 'apps', 'cli')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '8.8.8' }))
    assert.equal(readBuiltinVersion(dir), '8.8.8', 'a source-checkout anchor reads apps/cli/package.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('activationFacts uses the anchor semver as the builtin snapshot source (F1 regression)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-facts-'))
  const anchorDir = mkdtempSync(join(tmpdir(), 'gw-rt-anchor-'))
  try {
    const pkgDir = join(anchorDir, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '9.9.9' }))
    const manager = createGatewayRuntimeManager({
      config: { ...config(stateDir), plane: { ...config(stateDir).plane, dshWorkspacePath: anchorDir } },
      plane: fakePlane(),
      logger: silentLogger,
    })
    const facts = manager.activationFacts()
    assert.equal(facts.sourceIsBuiltin, true)
    assert.equal(facts.sourceVersion, '9.9.9', 'the very first install must snapshot the builtin semver, not null')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(anchorDir, { recursive: true, force: true })
  }
})

test('builtin-active cached selection stays staged across restart without weakening pointer loss', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-reselect-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    const manager = runtimeManager(stateDir, fakePlane())
    const result = await manager.select('1.0.0')
    assert.equal(result.accepted, true)
    const override = readOverrideRow(stateDir)
    assert.equal(override?.chosenVersion, '1.0.0')
    assert.equal(override?.pending, null)
    assert.equal(override?.selectedOnly, true, 'builtin remains the explicit active authority until apply')
    assert.equal(manager.resolveWorkspace().source, 'builtin')
    await manager.dispose()

    const restarted = runtimeManager(stateDir, fakePlane())
    assert.deepEqual(await restarted.startupTransaction(), { blockedReason: null })
    assert.equal(restarted.resolveWorkspace().source, 'builtin', 'staged selection survives a healthy gateway restart')
    assert.equal((await restarted.status()).selectedVersion, '1.0.0')
    await restarted.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a post-update re-selection consumes the invalidation stamp instead of stranding a dead pending (2026-09 gateway switch regression)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-reactivate-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    // The exact durable precondition observed on the dsh-test gateway after its
    // 0.2.4 shell update: the retained choice still carries the ACTIVE
    // invalidation stamp (with shellVersion already refreshed to the current
    // shell, which is what made the pair self-contradictory), plus the F4
    // history fields the UI echoes.
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion,
      chosenVersion: '0.5.0',
      resolvedVersion: '0.5.0',
      pending: null,
      swapAttempted: false,
      invalidatedAt: '2026-09-10T15:45:50.948Z',
      invalidatedReason: `gateway shell updated to ${gatewayPackageVersion}`,
      lastInvalidatedAt: '2026-09-10T15:45:50.948Z',
      lastInvalidatedReason: `gateway shell updated to ${gatewayPackageVersion}`,
      lastInvalidatedFromVersion: '0.5.0',
      lastInvalidationRecovered: false,
      lastOutcome: null,
      lastError: null,
    })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir) })
    const routes = createRuntimeRoutes(() => manager, silentLogger)

    // apply() on an invalidated record must refuse honestly instead of arming a
    // pending the core permanently ignores (pre-fix: 200 + dead pending, then
    // the stranded intent journal tripped the selection-corrupt detector).
    const refused = await runRoute(routes, 'POST', '/chamber/runtime/apply')
    assert.equal(refused.status, 409, 'an invalidated selection must not be armed')
    assert.equal((refused.json as { code: string }).code, 'no_selection')
    assert.equal(readOverrideRow(stateDir)?.pending, null, 'the refused apply must not rewrite pending')
    assert.equal(readActivationJournalState(stateDir).kind, 'missing', 'the refused apply must not strand an intent journal')

    // Re-selecting under the CURRENT shell is the user re-expressing intent: it
    // consumes the ACTIVE stamp (desktop parity) and keeps the F4 history.
    assert.equal((await manager.select('1.0.0')).accepted, true)
    const reselected = readOverrideRow(stateDir)
    assert.equal(reselected?.chosenVersion, '1.0.0')
    assert.equal(reselected?.invalidatedAt, null, 'the active invalidation stamp is consumed')
    assert.equal(reselected?.invalidatedReason, null, 'the active invalidation reason is consumed')
    assert.equal(reselected?.lastInvalidatedAt, '2026-09-10T15:45:50.948Z', 'F4 history survives the re-selection')
    assert.equal(reselected?.lastInvalidatedFromVersion, '0.5.0', 'the retained original selection stays visible')

    // The switch now arms for real and actually commits.
    const applied = await runRoute(routes, 'POST', '/chamber/runtime/apply')
    assert.equal(applied.status, 200)
    assert.equal(readOverrideRow(stateDir)?.pending, '1.0.0')
    const now = await runRoute(routes, 'POST', '/chamber/runtime/apply-now')
    assert.equal(now.status, 202)
    await waitForSettle(manager)
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' }, 'the re-selected switch commits')
    const settled = await manager.status()
    assert.equal(settled.activeVersion, '1.0.0')
    assert.equal(settled.metadataHealth, 'healthy', 'a completed switch must never project selection-corrupt')
    assert.equal(settled.canRecoverMetadata, false, 'no recovery surface is advertised for healthy metadata')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an instance already stranded in post-update selection-corrupt metadata heals through the ordinary select+apply path', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-heal-stranded-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    // The literal durable state the dsh-test gateway was found in after its rc.2
    // switch attempt: a version-switch intent journal + armed pending written by
    // apply(), sitting next to an override that still carries the app-update
    // stamp — and NO lastInvalidated* history (the backfill case).
    writeVersionSwitchIntent(stateDir, '1.0.0')
    writeOverride(stateDir, {
      shellVersion: gatewayPackageVersion,
      chosenVersion: '1.0.0',
      resolvedVersion: '1.0.0',
      pending: '1.0.0',
      swapAttempted: false,
      selectedOnly: false,
      invalidatedAt: '2026-09-10T15:45:50.948Z',
      invalidatedReason: `gateway shell updated to ${gatewayPackageVersion}`,
    })
    const plane = fakePlane()
    plane._state.connectionState = 'ready'
    const manager = runtimeManager(stateDir, plane, { probeCandidate: derivedProbe(stateDir) })
    const routes = createRuntimeRoutes(() => manager, silentLogger)

    // Faithful reproduction of the reported symptom: semantic-mismatch
    // selection-corrupt, and the component classifier contributes NO id — which
    // is what the settings UI renders as「未知组件」. If the classifier ever
    // learns to name journal-mismatch, update this expectation (it would be an
    // improvement, not a regression).
    const broken = await manager.status()
    assert.equal(broken.metadataHealth, 'selection-corrupt', 'the stranded state is reported corrupt')
    assert.deepEqual(broken.metadataComponents, [], 'the reported 未知组件 symptom: no component id is classified')
    assert.equal(broken.canRecoverMetadata, true, 'recover-metadata is advertised')
    assert.equal(broken.startupBlockedReason, null, 'the startup gate never blocked — hence 已隔离 was not actually true')
    assert.equal(broken.pending, null, 'the armed pending is invisible while the record is invalidated')

    // The ordinary UI path must heal it without recover-metadata or operator
    // surgery: select consumes the stamp (and clears the stale intent journal),
    // apply then arms for real, apply-now commits.
    assert.equal((await manager.select('1.0.0')).accepted, true)
    const healed = readOverrideRow(stateDir)
    assert.equal(healed?.invalidatedAt, null)
    assert.equal(healed?.lastInvalidatedAt, '2026-09-10T15:45:50.948Z',
      'the stamp is folded into history instead of being lost')
    assert.equal(healed?.lastInvalidatedFromVersion, '1.0.0', 'the pre-selection choice is recorded')
    const applied = await runRoute(routes, 'POST', '/chamber/runtime/apply')
    assert.equal(applied.status, 200, 'apply is admitted again once the stamp is consumed')
    assert.equal((await runRoute(routes, 'POST', '/chamber/runtime/apply-now')).status, 202)
    await waitForSettle(manager)
    assert.deepEqual(readCurrentPointerState(stateDir), { kind: 'valid', version: '1.0.0' }, 'the healed instance actually switched')
    const settled = await manager.status()
    assert.equal(settled.activeVersion, '1.0.0')
    assert.equal(settled.metadataHealth, 'healthy', 'the stranded metadata is fully cleared')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('staging v2 from active user v1 never authorizes builtin if v1 current pointer disappears', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-stage-from-user-'))
  try {
    makeValidTree(stateDir, '1.0.0')
    makeValidTree(stateDir, '2.0.0')
    writeCurrentPointer(stateDir, '1.0.0')
    writeOverrideRow(stateDir, { chosenVersion: '1.0.0', pending: null, lastOutcome: 'applied' })
    const manager = runtimeManager(stateDir, fakePlane())
    await manager.select('2.0.0')
    assert.equal(readOverrideRow(stateDir)?.selectedOnly, false)
    assert.equal(manager.resolveWorkspace().version, '1.0.0', 'the active pointer, not the staged choice, remains authoritative')
    rmSync(join(stateDir, 'dsh-runtime', 'current'))
    assert.throws(() => manager.resolveWorkspace(), /missing its authoritative current pointer/,
      'lost active v1 pointer must quarantine instead of falling back to builtin')
    await manager.dispose()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an empty DSH_GATEWAY_DSH_PATH counts as unset (resolves builtin)', () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = ''
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-empty-env-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
    assert.equal(manager.resolveWorkspace().source, 'builtin')
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('version mutations refuse while the env anchor is active (env always wins)', async () => {
  const previous = process.env.DSH_GATEWAY_DSH_PATH
  process.env.DSH_GATEWAY_DSH_PATH = '/tmp/env-dsh'
  const stateDir = mkdtempSync(join(tmpdir(), 'gw-rt-env-mutate-'))
  try {
    const manager = runtimeManager(stateDir, fakePlane())
    assert.equal(manager.resolveWorkspace().source, 'env')
    await assert.rejects(manager.select('1.2.3'), /env always wins/)
    await assert.rejects(manager.apply(), /env always wins/)
    await assert.rejects(manager.rollback('1.2.3'), /env always wins/)
    await assert.rejects(manager.restoreBuiltin(), /env always wins/)
    await assert.rejects(manager.setRegistry('https://registry.npmmirror.com'), /env always wins/)
    await manager.restart()
    assert.equal((await manager.status()).restart, 'ok', 'process restart remains available for env-pinned runtimes')
  } finally {
    if (previous === undefined) delete process.env.DSH_GATEWAY_DSH_PATH
    else process.env.DSH_GATEWAY_DSH_PATH = previous
    rmSync(stateDir, { recursive: true, force: true })
  }
})