/**
 * gate-registry.test.mjs — negative controls for the gate-surface registry.
 *
 * The registry is the machine source every consumer derives from, so a validator that
 * silently accepts bad data would let a gate disappear from a surface without any red.
 * These fixtures prove each data invariant rejects what it claims to reject.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { deriveModes, gateInvocation, loadGateRegistry, proofGateIds, validateGateRegistry } from './gate-registry.mjs'

const scripts = {
  'verify:import-cycles': 'node scripts/gates/verify-import-cycles.mjs',
  'test:runtime': 'pnpm --filter @dsh-chamber/dsh-runtime run test',
}
const exists = () => true

/** One valid architecture gate + one valid package-test gate. */
const fixture = () => ({
  gates: [
    {
      id: 'arch.one', title: 'One', command: 'verify:import-cycles', modes: ['static'], tier: 'architecture',
      surfaces: { local: true, ci: true, release: true },
    },
    {
      id: 'tests.pkg', title: 'Pkg', command: 'test:runtime', modes: ['tests'], tier: 'test',
      surfaces: { local: true, ci: true, release: true },
    },
  ],
})

const problemsOf = registry => validateGateRegistry(registry, { scripts, exists })

test('a well-formed registry has no problems', () => {
  assert.deepEqual(problemsOf(fixture()), [])
})

test('the shipped registry is valid and every mode is non-empty', () => {
  const registry = loadGateRegistry()
  assert.deepEqual(validateGateRegistry(registry), [])
  const modes = deriveModes(registry)
  for (const mode of ['static', 'typecheck', 'tests', 'full']) {
    assert.ok(modes[mode].length > 0, mode + ' must resolve to at least one step')
  }
})

test('the shipped registry resolves to the documented per-mode counts', () => {
  const registry = loadGateRegistry()
  const counts = platform => {
    const modes = deriveModes(registry, { platform })
    return [modes.static.length, modes.typecheck.length, modes.tests.length, modes.full.length]
  }
  assert.deepEqual(counts('linux'), [22, 13, 22, 57], 'linux mode counts drifted: a gate was added/removed without updating this golden')
  assert.deepEqual(counts('darwin'), [22, 13, 30, 65], 'darwin mode counts drifted')
  const linux = deriveModes(registry, { platform: 'linux' })
  assert.deepEqual(linux.full, [...linux.static, ...linux.typecheck, ...linux.tests], 'full must be exactly static+typecheck+tests')
})

test('the proof job list is single-sourced from the registry', async () => {
  const { REQUIRED_JOBS } = await import('../release/verify-release-ci-proof.mjs')
  const { CI_JOB_IDS } = await import('./gate-registry.mjs')
  assert.deepEqual(REQUIRED_JOBS, [...CI_JOB_IDS], 'the release proof must not carry its own job list')
})

test('the gate identity surface is a golden (id -> command, and the proof set)', () => {
  const registry = loadGateRegistry()
  const pairs = registry.gates.map(gate => gate.id + ' ' + gate.command)
  const hash = createHash('sha256').update(JSON.stringify(pairs)).digest('hex').slice(0, 16)
  assert.equal(hash, 'cee7d45e272ab9a8', 'a gate was added, removed, renamed or re-commanded: update this golden in the same change')
  assert.deepEqual(proofGateIds(registry), ['policy.workflow-pins', 'upstream.registry', 'upstream.anchors'],
    'the proof set is a release contract; changing it must be a deliberate edit of this assertion')
})

test('a proof gate must be placed on release validation, on a legal ci job and on both surfaces', () => {
  const base = {
    id: 'arch.proof', title: 'Proof', command: 'verify:import-cycles', modes: ['static'], tier: 'policy',
    surfaces: { local: true, ci: true, release: true },
  }
  const check = gate => validateGateRegistry({ gates: [gate] }, { scripts, exists })
  assert.ok(check({ ...base, proof: true }).length > 0, 'proof without a placement must be rejected')
  assert.ok(check({ ...base, proof: 'true' }).length > 0, 'a non-boolean proof must be rejected (a string would silently leave the proof set)')
  assert.ok(check({ ...base, proof: true, workflow: { ciJob: 'publish', releaseJob: 'validation', order: 'post' } }).length > 0,
    'a bogus ciJob must be rejected: the release proof only scans the known jobs')
  assert.ok(check({ ...base, proof: true, workflow: { ciJob: 'test', releaseJob: 'build', order: 'post' } }).length > 0,
    'a proof outside release validation must be rejected')
  assert.ok(check({ ...base, proof: true, surfaces: { local: true, ci: false, release: false }, reason: 'never runs',
    workflow: { ciJob: 'test', releaseJob: 'validation', order: 'post' } }).length > 0,
    'a proof gate that claims it never runs on ci/release must be rejected')
  assert.ok(check({ ...base, proof: true, workflow: null }).length > 0, 'a null workflow must be rejected without throwing')
  assert.ok(check({ ...base, workflow: { ciJob: 'test', order: 'post' } }).length > 0, 'a workflow without releaseJob must be rejected')
  assert.ok(check({ ...base, workflow: { ciJob: 'test', releaseJob: 'validation', order: 'late' } }).length > 0, 'an invalid order must be rejected')
  assert.deepEqual(check({ ...base, proof: true, workflow: { ciJob: 'test', releaseJob: 'validation', order: 'post' } }), [])
})

test('duplicate / malformed ids are rejected', () => {
  const registry = fixture()
  registry.gates[1].id = 'arch.one'
  assert.match(problemsOf(registry).join(';'), /duplicated/u)
  registry.gates[1].id = 'Not_An_Id'
  assert.match(problemsOf(registry).join(';'), /id invalid/u)
})

test('an unknown mode or tier is rejected', () => {
  const registry = fixture()
  registry.gates[0].modes = ['static', 'full']
  assert.match(problemsOf(registry).join(';'), /unknown mode/u)
  const other = fixture()
  other.gates[0].tier = 'mystery'
  assert.match(problemsOf(other).join(';'), /tier unknown/u)
})

test('a release gate must be proven in CI', () => {
  const registry = fixture()
  registry.gates[0].surfaces.ci = false
  registry.gates[0].reason = 'local convenience'
  assert.match(problemsOf(registry).join(';'), /release-blocking but not proven in CI/u)
})

test('an omitted surface needs a reason, and an architecture gate may never be local-only', () => {
  const registry = fixture()
  registry.gates[0].surfaces.release = false
  assert.match(problemsOf(registry).join(';'), /carries no reason/u)
  registry.gates[0].reason = 'local by decision'
  const text = problemsOf(registry).join(';')
  assert.match(text, /architecture gate and may never be local-only/u)
  registry.gates[0].tier = 'policy'
  assert.deepEqual(problemsOf(registry), [])
})

test('an unresolvable command is rejected', () => {
  const registry = fixture()
  registry.gates[0].command = 'verify:does-not-exist'
  assert.match(problemsOf(registry).join(';'), /not a root script/u)
  const nodeCmd = fixture()
  nodeCmd.gates[0].command = 'node scripts/gates/missing.mjs'
  assert.match(validateGateRegistry(nodeCmd, { scripts, exists: () => false }).join(';'), /command file missing/u)
  const pnpmCmd = fixture()
  pnpmCmd.gates[0].command = 'pnpm --filter @dsh-chamber/desktop run build:preload'
  assert.deepEqual(problemsOf(pnpmCmd), [])
})

test('darwin-only gates are excluded from the derivation on other platforms', () => {
  const registry = fixture()
  registry.gates.push({
    id: 'macos.one', title: 'Mac', command: 'test:runtime', modes: ['tests'], tier: 'assembly', platform: 'darwin',
    surfaces: { local: true, ci: true, release: false }, reason: 'macOS-only',
  })
  assert.deepEqual(deriveModes(registry, { platform: 'linux' }).tests, ['test:runtime'])
  assert.deepEqual(deriveModes(registry, { platform: 'darwin' }).tests, ['test:runtime', 'test:runtime'])
  assert.deepEqual(deriveModes(registry, { platform: 'linux' }).full,
    ['verify:import-cycles', 'test:runtime'])
})

test('gateInvocation renders bare scripts through pnpm and keeps explicit commands', () => {
  assert.equal(gateInvocation({ command: 'test:runtime' }), 'pnpm run test:runtime')
  assert.equal(gateInvocation({ command: 'node scripts/x.mjs --flag' }), 'node scripts/x.mjs --flag')
})
