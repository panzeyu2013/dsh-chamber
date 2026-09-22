/**
 * Unit tests for the single gate entry and the gate helpers it runs.
 *
 * The runner's failure modes are quiet ones: an unknown mode that exits 0, a
 * mode whose steps vanished during a rename, or a `--list` call that executes
 * something anyway. Each is pinned here. The same file also pins the pure
 * layers of the helpers the darwin/CI legs invoke — the Swift test runner
 * (G1/G2/G23), the compiled-sidecar smoke (G4) and the shim payload-shape gate
 * (G22) — because those helpers must fail loudly on their own without a runner.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MODES, pnpmInvocation, requestedMode, runMode, stepInvocation } from './run-checks.mjs'
import { ARTIFACTS, ensureArtifacts, formatMissingArtifacts, missingArtifacts } from '../dev/ensure-artifacts.mjs'
import { ciUnclassifiedGateCommands, jobBlock, staticGateParityProblems } from './static-gate-parity.mjs'
import { judgeSwiftTestReport, parseSwiftTestReport, swiftTestArgs, swiftTestEnvironment } from './run-swift-tests.mjs'
import { smokeDecision } from './compiled-sidecar-smoke.mjs'
import { DEFAULT_SIDECAR_DIR, resolveNodeBinary, resolveSidecarDir } from '../lib/sidecar-assembly.mjs'
import {
  EXPECTED_SURFACE,
  FACTORY_TO_NAMESPACE,
  assertShimReinjectionNoop,
  assertSurfaceCounts,
  comparePayloadShapes,
  compareRuntimePayloads,
  describeRuntimePayload,
  injectShimToken,
  parseMemberCall,
  parsePayloadShape,
  payloadShapeMatches,
  runShimFailureBranch,
} from './verify-shim-payload-shape.mjs'
import {
  BRIDGE_NAMESPACE_KEYS,
  BRIDGE_SCALAR_KEYS,
  DEFAULT_DESKTOP_DIST,
  artifactDecision,
  assertFrozenPreloadSurface,
  inspectPreloadSurface,
  resolveDesktopDist,
  runElectronArtifactSmoke,
} from './verify-electron-artifacts.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
test('every mode resolves to at least one step', () => {
  for (const [mode, steps] of Object.entries(MODES)) {
    assert.ok(steps.length > 0, `${mode} must list at least one step`)
  }
})
test('no mode lists the same step twice', () => {
  for (const [mode, steps] of Object.entries(MODES)) {
    assert.equal(new Set(steps).size, steps.length, `${mode} repeats a step`)
  }
})
test('mode names are recognised and unknown names are rejected', () => {
  assert.equal(requestedMode(['tests']), 'tests')
  assert.equal(requestedMode(['--list', 'static']), 'static')
  assert.equal(requestedMode(['nonsense']), undefined)
  assert.equal(requestedMode(['--list']), undefined)
})
test('an unknown mode reports a failure instead of a silent pass', () => {
  const { failed, ran } = runMode('nope', { log: () => {} })
  assert.deepEqual(failed, ['mode nope has no steps'])
  assert.equal(ran, 0)
})
test('listing a mode runs nothing', () => {
  const lines = []
  const { failed, ran } = runMode('static', { list: true, log: line => lines.push(line) })
  assert.deepEqual(failed, [])
  assert.equal(ran, 0)
  assert.equal(lines.length, MODES.static.length + 1)
})
test('the pnpm invocation always names an executable', () => {
  const invocation = pnpmInvocation()
  assert.ok(invocation.command.length > 0)
  assert.ok(Array.isArray(invocation.prefix))
})
test('stepInvocation resolves script names and explicit command entries without a shell', () => {
  const pnpm = { command: 'pnpm', prefix: [] }
  assert.deepEqual(stepInvocation('verify:i18n', pnpm),
    { command: 'pnpm', args: ['run', 'verify:i18n'], display: 'pnpm run verify:i18n' })
  assert.deepEqual(stepInvocation('node scripts/gates/verify-electron-artifacts.mjs', pnpm),
    { command: process.execPath, args: ['scripts/gates/verify-electron-artifacts.mjs'],
      display: 'node scripts/gates/verify-electron-artifacts.mjs' })
  const viaPnpm = stepInvocation('pnpm run build:sidecar --skip-node', { command: '/usr/bin/node', prefix: ['/pnpm.cjs'] })
  assert.equal(viaPnpm.command, '/usr/bin/node')
  assert.deepEqual(viaPnpm.args, ['/pnpm.cjs', 'run', 'build:sidecar', '--skip-node'])
})
test('G32/G33: the darwin tests mode carries the executed-assembly gates ci.yml runs', () => {
  const gates = [
    'test:sidecar:compiled',
    'node scripts/gates/verify-electron-artifacts.mjs',
    'node scripts/gui-acceptance/run.mjs --flavor native --require-assembly',
  ]
  if (process.platform === 'darwin') {
    for (const gate of gates) assert.ok(MODES.tests.includes(gate), `check:tests must run ${gate}`)
    for (const gate of gates) assert.ok(MODES.full.includes(gate), `check:full must run ${gate}`)
    // A gate must not run before the build that produces what it executes.
    const assemblyBuild = 'pnpm run build:sidecar --skip-node --skip-vendor --skip-host-packages'
    assert.ok(MODES.tests.indexOf(assemblyBuild) < MODES.tests.indexOf('test:sidecar:compiled'),
      'the sidecar assembly build must precede the compiled sidecar smoke')
    assert.ok(MODES.tests.indexOf(assemblyBuild)
      < MODES.tests.indexOf('node scripts/gui-acceptance/run.mjs --flavor native --require-assembly'),
    'the sidecar assembly build must precede the native acceptance')
    assert.ok(MODES.tests.indexOf('pnpm --filter @dsh-chamber/desktop run build:preload')
      < MODES.tests.indexOf('node scripts/gates/verify-electron-artifacts.mjs'),
    'build:preload must precede the Electron artifacts gate')
  } else {
    for (const gate of gates) {
      assert.equal(MODES.tests.includes(gate), false, 'the native/Electron assembly gates stay off the ubuntu leg')
      assert.equal(MODES.full.includes(gate), false)
    }
  }
})
// A5: the root tsc program is part of the typecheck mode, so
// a local check:typecheck cannot stay green while root tsc regresses. It must be
// the FIRST step (ci.yml runs it before the per-package client faces).
test('A5: the root typecheck program is the first step of the typecheck mode', () => {
  assert.equal(MODES.typecheck[0], 'typecheck')
  assert.ok(MODES.full.includes('typecheck'), 'check:full must carry the root program too')
})
test('the full mode is the union of the narrower modes', () => {
  const union = new Set([...MODES.static, ...MODES.typecheck, ...MODES.tests])
  for (const step of union) assert.ok(MODES.full.includes(step), `full is missing ${step}`)
})
// Swift test runner (run-swift-tests.mjs; G1/G2/G23)
test('the Swift suite rides tests/full on darwin only, before the .build/release consumers', () => {
  if (process.platform === 'darwin') {
    assert.ok(MODES.tests.includes('test:swift'), 'darwin check:tests must run the XCTest suite (G1)')
    assert.ok(MODES.full.includes('test:swift'), 'darwin check:full must run the XCTest suite (G1)')
    assert.ok(
      MODES.tests.indexOf('test:swift') < MODES.tests.indexOf('test:macos'),
      'test:swift must run first: its release build satisfies the packaging suite .build/release precondition',
    )
  } else {
    assert.equal(MODES.tests.includes('test:swift'), false, 'the Swift leg never rides the ubuntu test job')
    assert.equal(MODES.full.includes('test:swift'), false)
  }
})
test('swiftTestArgs pins the shipped release configuration (G23)', () => {
  const args = swiftTestArgs()
  assert.deepEqual(args.slice(0, 2), ['test', '--package-path'])
  assert.equal(args[2], 'macos')
  assert.ok(args.includes('-c'), 'swift test must name a configuration')
  assert.equal(args[args.indexOf('-c') + 1], 'release', 'G23: the shipped release configuration must be the tested one')
})
test('swiftTestEnvironment defaults DSH_CHAMBER_SHELL_NODE_BIN without overwriting an explicit value', () => {
  assert.equal(swiftTestEnvironment({}, '/usr/bin/node').DSH_CHAMBER_SHELL_NODE_BIN, '/usr/bin/node')
  assert.equal(swiftTestEnvironment({ DSH_CHAMBER_SHELL_NODE_BIN: '' }, '/usr/bin/node').DSH_CHAMBER_SHELL_NODE_BIN, '/usr/bin/node')
  assert.equal(swiftTestEnvironment({ DSH_CHAMBER_SHELL_NODE_BIN: '/opt/node' }, '/usr/bin/node').DSH_CHAMBER_SHELL_NODE_BIN, '/opt/node')
})
test('parseSwiftTestReport takes the last XCTest summary and counts every skipped case', () => {
  const output = [
    "Test Case '-[DSHChamberTests.X testSkipped]' skipped (0.001 seconds).",
    '\t Executed 5 tests, with 0 failures (0 unexpected) in 1.0 (1.0) seconds',
    '\t Executed 7 tests, with 1 failures (0 unexpected) in 2.0 (2.0) seconds',
  ].join('\n')
  assert.deepEqual(parseSwiftTestReport(output), { executed: 7, failures: 1, skipped: 1 })
  assert.deepEqual(parseSwiftTestReport('no XCTest summary here'), { executed: null, failures: null, skipped: 0 })
  // The swift-testing footer is not an XCTest summary: an empty swift-testing
  // run must not let a vanished XCTest corpus pass.
  assert.deepEqual(
    parseSwiftTestReport('◇ Test run started.\n✔ Test run with 0 tests in 0 suites passed'),
    { executed: null, failures: null, skipped: 0 },
  )
})
test('judgeSwiftTestReport fails on no summary, zero tests, failures and any XCTSkip (G2)', () => {
  assert.equal(judgeSwiftTestReport({ executed: null, failures: null, skipped: 0 }).ok, false)
  assert.equal(judgeSwiftTestReport({ executed: 0, failures: 0, skipped: 0 }).ok, false)
  assert.equal(judgeSwiftTestReport({ executed: 3, failures: 1, skipped: 0 }).ok, false)
  const skipVerdict = judgeSwiftTestReport({ executed: 3, failures: 0, skipped: 1 })
  assert.equal(skipVerdict.ok, false)
  assert.match(skipVerdict.reason, /XCTSkip/)
  assert.deepEqual(judgeSwiftTestReport({ executed: 182, failures: 0, skipped: 0 }), { ok: true })
})
// Compiled sidecar smoke (compiled-sidecar-smoke.mjs; G4)
test('smokeDecision: disabled is a skip, enabled with a missing artifact is a failure', () => {
  const base = {
    enabled: true,
    entryPath: '/assembly/sidecar.js',
    entryExists: true,
    controlPlanePath: '/assembly/dist/control-plane/index.js',
    controlPlaneExists: true,
  }
  assert.deepEqual(smokeDecision(base), { action: 'run' })
  const skipped = smokeDecision({ ...base, enabled: false })
  assert.equal(skipped.action, 'skip')
  assert.match(skipped.reason, /DSH_CHAMBER_SIDECAR_COMPILED/)
  assert.equal(smokeDecision({ ...base, entryExists: false }).action, 'fail')
  assert.equal(smokeDecision({ ...base, controlPlaneExists: false }).action, 'fail')
})
test('resolveSidecarDir honors the environment override; resolveNodeBinary prefers the bundled node', () => {
  assert.equal(resolveSidecarDir({}, '/repo'), DEFAULT_SIDECAR_DIR)
  assert.equal(resolveSidecarDir({ DSH_CHAMBER_SIDECAR_DIR: '/tmp/assembly' }, '/repo'), '/tmp/assembly')
  assert.equal(
    resolveSidecarDir({ DSH_CHAMBER_SIDECAR_DIR: 'rel/assembly' }, '/repo'),
    resolve('/repo', 'rel/assembly'),
  )
  assert.equal(resolveNodeBinary('/nonexistent-assembly-dir', '/usr/bin/node'), '/usr/bin/node')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-smoke-node-'))
  try {
    writeFileSync(join(dir, 'node'), '#!/bin/sh\n')
    assert.equal(resolveNodeBinary(dir, '/usr/bin/node'), join(dir, 'node'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
// Shim payload shape (verify-shim-payload-shape.mjs; G22)
test('parsePayloadShape: absent/null, direct expression and exact object key sets', () => {
  assert.deepEqual(parsePayloadShape(')'), { kind: 'none' })
  assert.deepEqual(parsePayloadShape(', null)'), { kind: 'none' })
  assert.deepEqual(parsePayloadShape(', instances)'), { kind: 'direct', expression: 'instances' })
  assert.deepEqual(parsePayloadShape(', { id })'), { kind: 'keys', keys: ['id'] })
  assert.deepEqual(parsePayloadShape(', { patch })'), { kind: 'keys', keys: ['patch'] })
  assert.deepEqual(
    parsePayloadShape(', { previousId: previousId, input: input, credentials: credentials })'),
    { kind: 'keys', keys: ['credentials', 'input', 'previousId'] },
  )
  assert.deepEqual(
    parsePayloadShape(', { id: id, add: input.add, remove: input.remove, deferRestart: input.deferRestart })'),
    { kind: 'keys', keys: ['add', 'deferRestart', 'id', 'remove'] },
  )
})
test('parseMemberCall distinguishes invoke from push on both surfaces', () => {
  const preloadInvoke = parseMemberCall("    set: patch => ipcRenderer.invoke('dsh-chamber:settings-set', { patch }),", 'preload')
  assert.equal(preloadInvoke.channel, 'dsh-chamber:settings-set')
  assert.equal(preloadInvoke.kind, 'invoke')
  assert.deepEqual(parsePayloadShape(preloadInvoke.after), { kind: 'keys', keys: ['patch'] })
  const preloadPush = parseMemberCall("    onChanged: callback => { ipcRenderer.on('dsh-chamber:settings-changed', listener) },", 'preload')
  assert.equal(preloadPush.kind, 'push')
  const shimPush = parseMemberCall(
    '    onChanged: function (callback) { return subscribe(PUSH_EVENTS.SETTINGS_CHANGED, makePassthroughListener(callback)) }',
    'shim',
    { SETTINGS_CHANGED: 'dsh-chamber:settings-changed' },
  )
  assert.equal(shimPush.channel, 'dsh-chamber:settings-changed')
  assert.equal(shimPush.kind, 'push')
})
test('comparePayloadShapes catches an invoke payload-key drift', () => {
  const factories = Object.keys(FACTORY_TO_NAMESPACE)
  const preloadText = factories
    .map(factory => `function ${factory}(): SomeSurface {\n  return {\n    ping: () => ipcRenderer.invoke('ch:ping', { id }),\n  };\n}`)
    .join('\n')
  const shimBlock = payload => 'var PUSH_EVENTS = {\n  }\n' + Object.values(FACTORY_TO_NAMESPACE)
    .map(namespace => `  var ${namespace} = {\n    ping: function (id) { return invoke('ch:ping', ${payload}) },\n  }`)
    .join('\n')
  const manifest = { invoke: [{ channel: 'ch:ping' }], push: [], counts: { invoke: 1, push: 0, total: 1 } }
  const matching = comparePayloadShapes({ preloadText, shimText: shimBlock('{ id: id }'), manifest })
  assert.deepEqual(matching.mismatches, [])
  assert.equal(matching.checked, factories.length)
  const drifted = comparePayloadShapes({ preloadText, shimText: shimBlock('{ other: id }'), manifest })
  assert.equal(drifted.mismatches.length, factories.length)
  assert.match(drifted.mismatches[0], /payload shape keys:\{id\} \(preload\) != keys:\{other\} \(shim\)/)
})
test('the shipped preload/shim surfaces agree on every payload shape and stay manifest-locked', () => {
  const verdict = comparePayloadShapes({
    preloadText: readFileSync(join(REPO_ROOT, 'packages/desktop/preload.cts'), 'utf8'),
    shimText: readFileSync(
      join(REPO_ROOT, 'macos/Sources/DSHChamber/Resources/bridge-shim.js'),
      'utf8',
    ),
    manifest: JSON.parse(readFileSync(join(REPO_ROOT, 'packages/desktop/bridge-manifest.json'), 'utf8')),
  })
  assert.deepEqual(verdict.mismatches, [])
  assert.deepEqual(verdict.missingFromManifest, [])
  assert.deepEqual(verdict.unexposedManifestChannels, [])
  // G34: the exact totals are pinned, not a `>= 60` floor — a member removed
  // from BOTH sides (the case per-member comparison cannot see) must fail here.
  assert.deepEqual(
    { namespaces: verdict.namespaces, members: verdict.checked, perNamespace: verdict.perNamespace },
    {
      namespaces: EXPECTED_SURFACE.namespaces,
      members: EXPECTED_SURFACE.members,
      perNamespace: EXPECTED_SURFACE.perNamespace,
    },
    'the shipped surfaces must expose exactly the pinned namespace/member totals',
  )
  assert.equal(EXPECTED_SURFACE.members,
    Object.values(EXPECTED_SURFACE.perNamespace).reduce((sum, count) => sum + count, 0),
    'the total pin must equal the per-namespace pin sum')
})
test('G34: a silently removed member fails the surface-total pin, not only a mismatch', () => {
  const base = {
    namespaces: EXPECTED_SURFACE.namespaces,
    members: EXPECTED_SURFACE.members,
    invoke: EXPECTED_SURFACE.invoke,
    push: EXPECTED_SURFACE.push,
    perNamespace: { ...EXPECTED_SURFACE.perNamespace },
  }
  assert.deepEqual(assertSurfaceCounts(base), base)
  // An emptied namespace: the per-member comparison sees two matching (empty)
  // blocks; only the count pin notices the rows are gone.
  const expects = (label, got, want) => new RegExp(`G34.*${label} ${got} != ${want}`)
  const emptied = { ...base, members: base.members - EXPECTED_SURFACE.perNamespace.runtime,
    perNamespace: { ...base.perNamespace, runtime: 0 } }
  assert.throws(() => assertSurfaceCounts(emptied),
    expects('runtime members', 0, EXPECTED_SURFACE.perNamespace.runtime))
  assert.throws(() => assertSurfaceCounts({ ...base, members: base.members - 1 }),
    expects('members', EXPECTED_SURFACE.members - 1, EXPECTED_SURFACE.members))
  assert.throws(() => assertSurfaceCounts({ ...base, invoke: base.invoke - 1 }),
    expects('invoke members', EXPECTED_SURFACE.invoke - 1, EXPECTED_SURFACE.invoke))
  assert.throws(() => assertSurfaceCounts({ ...base, push: base.push - 1 }),
    expects('push members', EXPECTED_SURFACE.push - 1, EXPECTED_SURFACE.push))
  assert.throws(() => assertSurfaceCounts({ ...base, namespaces: base.namespaces - 1 }),
    expects('namespaces', EXPECTED_SURFACE.namespaces - 1, EXPECTED_SURFACE.namespaces))
  assert.throws(() => assertSurfaceCounts({ ...base, perNamespace: { ...base.perNamespace, nope: 1 } }),
    /G34.*unexpected namespace nope/)
  // The runtime arm may omit the invoke/push split only when it did not observe it.
  assert.doesNotThrow(() => assertSurfaceCounts({ namespaces: base.namespaces, members: base.members }))
})
// Shim runtime arm (verify-shim-payload-shape.mjs; G22 residual)
const SHIM_SOURCE = readFileSync(join(REPO_ROOT, 'macos/Sources/DSHChamber/Resources/bridge-shim.js'), 'utf8')
const PRELOAD_SOURCE = readFileSync(join(REPO_ROOT, 'packages/desktop/preload.cts'), 'utf8')
test('injectShimToken replaces the placeholder and rejects a malformed token', () => {
  const token = 'a1'.repeat(16)
  const injected = injectShimToken(SHIM_SOURCE, token)
  assert.equal(injected.includes('__DSH_CHAMBER_NATIVE_TOKEN__'), false)
  assert.ok(injected.includes(token))
  assert.throws(() => injectShimToken(SHIM_SOURCE, 'short'), /32 lowercase hex/)
  assert.throws(() => injectShimToken(SHIM_SOURCE, 'A'.repeat(32)), /32 lowercase hex/)
})
test('runtime payload shape predicates are key-exact, not truthy', () => {
  assert.equal(payloadShapeMatches({ kind: 'none' }, null), true)
  assert.equal(payloadShapeMatches({ kind: 'none' }, undefined), true)
  assert.equal(payloadShapeMatches({ kind: 'none' }, {}), false)
  assert.equal(payloadShapeMatches({ kind: 'direct', expression: 'instances' }, ['a']), true)
  assert.equal(payloadShapeMatches({ kind: 'direct', expression: 'instances' }, null), false)
  assert.equal(payloadShapeMatches({ kind: 'keys', keys: ['id'] }, { id: 'x' }), true)
  assert.equal(payloadShapeMatches({ kind: 'keys', keys: ['id'] }, { id: 'x', extra: 1 }), false)
  assert.equal(payloadShapeMatches({ kind: 'keys', keys: ['id'] }, { instanceId: 'x' }), false)
  assert.equal(describeRuntimePayload(undefined), 'no-payload')
  assert.equal(describeRuntimePayload({ b: 1, a: 2 }), 'keys:{a, b}')
  assert.equal(describeRuntimePayload(['x']), 'direct:array(1)')
})
test('the real shim executes in node:vm and every member posts the preload payload keys (G22)', async () => {
  const verdict = await compareRuntimePayloads({ preloadText: PRELOAD_SOURCE, shimText: SHIM_SOURCE })
  assert.deepEqual(verdict.mismatches, [])
  // G34: the executed surface is pinned to the same totals as the static arm,
  // including the invoke/push split and the per-namespace rows.
  assert.deepEqual(
    {
      namespaces: verdict.namespaces,
      members: verdict.checked,
      invoke: verdict.invoked,
      push: verdict.subscribed,
      perNamespace: verdict.perNamespace,
    },
    {
      namespaces: EXPECTED_SURFACE.namespaces,
      members: EXPECTED_SURFACE.members,
      invoke: EXPECTED_SURFACE.invoke,
      push: EXPECTED_SURFACE.push,
      perNamespace: EXPECTED_SURFACE.perNamespace,
    },
  )
})
test('the runtime arm catches a payload-key drift and a channel drift the static gate would too (G22)', async () => {
  const payloadDrift = SHIM_SOURCE.replace(
    "invoke('desktop_ssh_delete_connection', { id: id })",
    "invoke('desktop_ssh_delete_connection', { instanceId: id })",
  )
  assert.notEqual(payloadDrift, SHIM_SOURCE, 'the drift fixture must really change the shim')
  const payloadVerdict = await compareRuntimePayloads({ preloadText: PRELOAD_SOURCE, shimText: payloadDrift })
  assert.ok(payloadVerdict.mismatches.some((entry) => entry.includes('desktopSsh.delete_connection') && entry.includes('instanceId')),
    'a key-exact drift must fail the runtime arm: ' + JSON.stringify(payloadVerdict.mismatches))

  const channelDrift = SHIM_SOURCE.replace("invoke('desktop_ssh_instances_get'", "invoke('desktop_ssh_instances_get_drifted'")
  assert.notEqual(channelDrift, SHIM_SOURCE)
  const channelVerdict = await compareRuntimePayloads({ preloadText: PRELOAD_SOURCE, shimText: channelDrift })
  assert.ok(channelVerdict.mismatches.some((entry) => entry.includes('desktopSsh.instances_get')),
    'a channel drift must fail the runtime arm')
})
test('the total-failure branch still exposes the surface with null scalars after 11 rejections (G22/T-12)', async () => {
  const failure = await runShimFailureBranch({ shimText: SHIM_SOURCE })
  assert.equal(failure.attempts, 11, '1 + INFO_MAX_ATTEMPTS rejections must have been observed')
  assert.deepEqual(failure.scalars, { controlPlaneUrl: null, dshVersion: null, version: null, platform: null })
  assert.equal(failure.namespaces.length, 9)
  assert.ok(failure.warnings.some((warning) => /info failed after 10 attempts/.test(warning)), 'the degradation must be loud')
})
test('re-injecting the installed shim is a no-op (P-19 marker) (G22)', async () => {
  const reinjection = await assertShimReinjectionNoop({ shimText: SHIM_SOURCE })
  assert.equal(reinjection.marker, true)
  assert.equal(reinjection.extraEnvelopes, 0)
  assert.equal(reinjection.sameResolve, true)
  assert.equal(reinjection.sameSurface, true)
  assert.deepEqual(reinjection.conflicts, [])
})
// Electron compiled-artifact smoke (verify-electron-artifacts.mjs; G4 residual)
test('electron artifact decision: both absent is a loud skip, a partial build is a failure', () => {
  const both = {
    controlPlaneEntry: '/dist/control-plane/index.js',
    controlPlaneExists: true,
    preloadEntry: '/dist/preload.cjs',
    preloadExists: true,
  }
  assert.deepEqual(artifactDecision(both), { action: 'run' })
  const skipped = artifactDecision({ ...both, controlPlaneExists: false, preloadExists: false })
  assert.equal(skipped.action, 'skip')
  assert.match(skipped.reason, /compiled Electron artifacts absent/)
  assert.match(skipped.reason, /build:desktop/)
  // One artifact present = a build-order bug: run and fail, never skip.
  const partialPlane = artifactDecision({ ...both, preloadExists: false })
  assert.equal(partialPlane.action, 'fail')
  assert.match(partialPlane.reason, /partial compiled Electron build/)
  assert.match(partialPlane.reason, /preload\.cjs/)
  assert.equal(artifactDecision({ ...both, controlPlaneExists: false }).action, 'fail')
})
test('runElectronArtifactSmoke returns skip for an empty dist and fail for a partial one (never a silent pass)', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-electron-empty-'))
  const partial = mkdtempSync(join(tmpdir(), 'dsh-electron-partial-'))
  try {
    const skipped = await runElectronArtifactSmoke({ desktopDist: empty, log: () => {} })
    assert.equal(skipped.action, 'skip')
    writeFileSync(join(partial, 'preload.cjs'), '"use strict";\n')
    const failed = await runElectronArtifactSmoke({ desktopDist: partial, log: () => {} })
    assert.equal(failed.action, 'fail', 'a partial build must never fall through to a run')
    assert.match(failed.reason, /partial compiled Electron build/)
    assert.match(failed.reason, /control-plane\/index\.js/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
    rmSync(partial, { recursive: true, force: true })
  }
})
test('resolveDesktopDist honors the override, default points at packages/desktop/dist', () => {
  assert.equal(resolveDesktopDist({}, '/repo'), DEFAULT_DESKTOP_DIST)
  assert.equal(resolveDesktopDist({ DSH_CHAMBER_DESKTOP_DIST: '/tmp/dist' }, '/repo'), '/tmp/dist')
  assert.equal(resolveDesktopDist({ DSH_CHAMBER_DESKTOP_DIST: 'rel/dist' }, '/repo'), resolve('/repo', 'rel/dist'))
})
/** A synthetic compiled-preload fixture with the frozen surface shape. */
function preloadFixture({ dropNamespace = null, badMember = false, scalar = 'value' } = {}) {
  const namespaces = BRIDGE_NAMESPACE_KEYS.filter((namespace) => namespace !== dropNamespace)
  const lines = [
    "const { contextBridge, ipcRenderer } = require('electron')",
    'contextBridge.exposeInMainWorld("dshChamber", {',
    ...BRIDGE_SCALAR_KEYS.map((key) => '  ' + key + ': "' + scalar + '",'),
    ...namespaces.map((namespace) => badMember
      ? '  ' + namespace + ': { member: 42 },'
      : '  ' + namespace + ': { member: () => ipcRenderer.invoke("ch:' + namespace + '") },'),
    '})',
  ]
  return lines.join('\n')
}
test('compiled preload vm harness parses CJS, stubs electron and captures the exposed surface', async () => {
  const harness = await inspectPreloadSurface(preloadFixture(), { info: {} })
  assert.ok(harness.exposed.dshChamber !== undefined, 'the vm run must reach exposeInMainWorld')
  assert.deepEqual(
    Object.keys(harness.exposed.dshChamber).sort(),
    [...BRIDGE_SCALAR_KEYS, ...BRIDGE_NAMESPACE_KEYS].sort(),
  )
  // The stubbed ipcRenderer is what proves the bridge routes through Electron's
  // IPC seam rather than reading anything from the page.
  harness.exposed.dshChamber.desktopSsh.member()
  assert.deepEqual(harness.invokes, [{ channel: 'ch:desktopSsh', payload: undefined }])
})
test('frozen preload surface assertion fails closed on a missing namespace, a non-function member and a scalar drift', async () => {
  const good = await inspectPreloadSurface(preloadFixture(), { info: {} })
  assert.deepEqual(assertFrozenPreloadSurface(good.exposed.dshChamber), {
    namespaces: BRIDGE_NAMESPACE_KEYS.length,
    members: BRIDGE_NAMESPACE_KEYS.length,
  })
  const missing = await inspectPreloadSurface(preloadFixture({ dropNamespace: 'badge' }), { info: {} })
  assert.throws(() => assertFrozenPreloadSurface(missing.exposed.dshChamber), /surface drifted/)
  const badMember = await inspectPreloadSurface(preloadFixture({ badMember: true }), { info: {} })
  assert.throws(
    () => assertFrozenPreloadSurface(badMember.exposed.dshChamber),
    /is not a function/,
    'a namespace member that is not a function must be caught by the assertion',
  )
  const scalarDrift = await inspectPreloadSurface(preloadFixture({ scalar: 'stub' }), { info: {} })
  assert.throws(
    () => assertFrozenPreloadSurface(scalarDrift.exposed.dshChamber, { expectedScalars: { controlPlaneUrl: 'http://127.0.0.1:1' } }),
    /scalar controlPlaneUrl/,
  )
  assert.throws(() => assertFrozenPreloadSurface(null), /exposed no dshChamber/)
})
test('the REAL compiled Electron artifacts execute when present (loud skip otherwise) (G4)', async (t) => {
  const controlPlaneEntry = join(DEFAULT_DESKTOP_DIST, 'control-plane', 'index.js')
  const preloadEntry = join(DEFAULT_DESKTOP_DIST, 'preload.cjs')
  if (!existsSync(controlPlaneEntry) || !existsSync(preloadEntry)) {
    // Unit tests run before the CI desktop build; ci.yml's test-macos step runs the gate itself after build:control-plane/preload.
    t.diagnostic('SKIP: compiled Electron artifacts absent under ' + DEFAULT_DESKTOP_DIST
      + ' — the ci.yml test-macos step executes this gate after building them')
    return
  }
  const verdict = await runElectronArtifactSmoke({ desktopDist: DEFAULT_DESKTOP_DIST })
  assert.equal(verdict.action, 'run')
  assert.ok(verdict.port > 0)
  // G34 产物臂：`>= 60` 下限会让陈旧的 dist 在本机一路绿，故与源面同一组精确钉子比对；红时先跑 `pnpm --filter @dsh-chamber/desktop run build:preload` 刷新编译产物。
  assert.equal(verdict.members, EXPECTED_SURFACE.members,
    'the COMPILED preload must equal the pinned member total（陈旧 dist 先跑 '
    + 'pnpm --filter @dsh-chamber/desktop run build:preload）')
})

// G35: the real-repository parity assertion (MODES.static ↔ ci.yml's
// unclassified gate steps, with the drift negative controls) lives in
// verify-workflow-action-pins.test.mjs; this file keeps only the member the
// parity check cannot see (a step dropped on BOTH sides stays parity-clean).
test('G35: the fault-injection matrix runs on the push path too, not only from check:static', () => {
  const scripts = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts
  const job = jobBlock(readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'), 'test')
  const ciCommands = ciUnclassifiedGateCommands(job, scripts)
  assert.ok(ciCommands.some(command => command.includes('remote-state-injection-matrix')))
})

// ---- untracked build artifacts: ensure-artifacts + the run-checks pre-step.
// The seed/runtime/mobile artifacts are untracked, so every check mode must
// either self-bootstrap or fail loudly; a mode that silently skips a gate
// because an artifact is absent must fail these tests.
test('ensure-artifacts: an empty fixture root reports every manifest entry and names the build command', () => {
  const empty = mkdtempSync(join(tmpdir(), 'dsh-ensure-artifacts-'))
  try {
    const missing = missingArtifacts(empty)
    assert.equal(missing.length, ARTIFACTS.length, 'every tracked-removed artifact must be in the checklist')
    const report = formatMissingArtifacts(missing).join('\n')
    assert.match(report, /pnpm run build:artifacts/, 'the aggregate build command is the one-copy-paste fix')
    for (const artifact of ARTIFACTS) assert.ok(report.includes(artifact.id), 'report must name ' + artifact.id)
    // --check semantics (build: false) must report without writing.
    const verdict = ensureArtifacts({ repoRoot: empty, build: false, log: () => {} })
    assert.equal(verdict.ok, false)
    assert.equal(verdict.built, false)
    assert.equal(verdict.missing.length, ARTIFACTS.length)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
test('run-checks static fails loudly on missing artifacts; tests/typecheck/full self-bootstrap', () => {
  const refusal = () => ({ ok: false, missing: [{ id: 'x', path: 'x', build: 'y' }], built: false })
  const staticLogs = []
  const staticRun = runMode('static', {
    log: line => staticLogs.push(line),
    ensureArtifacts: options => {
      assert.equal(options.build, false, 'static is read-only: it must never build')
      return refusal()
    },
  })
  assert.equal(staticRun.ran, 0)
  assert.deepEqual(staticRun.failed, ['ensure-artifacts (1 missing)'])
  assert.ok(staticLogs.some(line => line.includes('pnpm run build:artifacts')),
    'the static failure must name the build command')
  for (const mode of ['typecheck', 'tests', 'full']) {
    let requested
    const run = runMode(mode, {
      log: () => {},
      ensureArtifacts: options => { requested = options.build; return refusal() },
    })
    assert.equal(requested, true, mode + ' must build what is missing')
    assert.equal(run.ran, 0, mode + ' must not run steps when the artifacts cannot be ensured')
  }
})
test('run-checks --list never runs the artifact pre-step', () => {
  let called = false
  const lines = []
  runMode('tests', {
    list: true,
    log: line => lines.push(line),
    ensureArtifacts: () => { called = true; return { ok: false, missing: [], built: false } },
  })
  assert.equal(called, false, 'listing runs nothing, including the pre-step')
  assert.equal(lines.length, MODES.tests.length + 1)
})
