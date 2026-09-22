/**
 * The shared metadata-health projection (dsh-runtime/src/metadata-health-projection.ts).
 *
 * This pins the derived facts both hosts publish: the same five component
 * predicates and the same needsRecovery rule.
 *
 * Run directly: node packages/dsh-runtime/test/store/metadata-health-projection.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectMetadataHealthFacts, projectMetadataRecoveryGate } from '../../src/metadata-health-projection.ts'
import type { RuntimeMetadataHealth } from '../../src/runtime-metadata-recovery.ts'

const health = (overrides: Record<string, unknown> = {}): RuntimeMetadataHealth => ({
  status: 'healthy',
  current: { kind: 'valid' },
  override: { kind: 'valid' },
  activationJournal: { kind: 'valid' },
  recovery: { kind: 'valid', record: { phase: 'finalized' } },
  corruptEvidence: [],
  ...overrides,
} as unknown as RuntimeMetadataHealth)

test('a healthy fact projects to no components and no recovery need', () => {
  assert.deepEqual(projectMetadataHealthFacts(health(), { markerRescueAvailable: false }), { components: [], needsRecovery: false })
})

test('each corrupt component is named, in the wire order both hosts publish', () => {
  const projected = projectMetadataHealthFacts(health({
    current: { kind: 'corrupt' },
    override: { kind: 'corrupt' },
    activationJournal: { kind: 'corrupt' },
    recovery: { kind: 'corrupt' },
    corruptEvidence: ['current.2026.json'],
  }), { markerRescueAvailable: false })
  assert.deepEqual(projected.components, ['current', 'override', 'activation-journal', 'recovery-marker', 'retained-evidence'])
})

test('a valid component still counts when the evidence names it (prefix match)', () => {
  const projected = projectMetadataHealthFacts(health({ corruptEvidence: ['override.json.tmp'] }), { markerRescueAvailable: false })
  assert.deepEqual(projected.components, ['override', 'retained-evidence'])
  // A prefix that belongs to no component only marks the retained evidence.
  assert.deepEqual(
    projectMetadataHealthFacts(health({ corruptEvidence: ['other.file'] }), { markerRescueAvailable: false }).components,
    ['retained-evidence'],
  )
})

test('a valid but unfinalized recovery record is an in-progress marker', () => {
  const inProgress = health({ recovery: { kind: 'valid', record: { phase: 'stashing' } } })
  assert.deepEqual(projectMetadataHealthFacts(inProgress, { markerRescueAvailable: false }).components, ['recovery-marker'])
  const finalized = health({ recovery: { kind: 'valid', record: { phase: 'finalized' } } })
  assert.deepEqual(projectMetadataHealthFacts(finalized, { markerRescueAvailable: false }).components, [])
})

test('needsRecovery follows the status plus the caller-computed marker rescue', () => {
  const rescue = { markerRescueAvailable: true }
  assert.equal(projectMetadataHealthFacts(health({ status: 'selection-corrupt' }), { markerRescueAvailable: false }).needsRecovery, true)
  assert.equal(projectMetadataHealthFacts(health({ status: 'recovery-in-progress' }), { markerRescueAvailable: false }).needsRecovery, true)
  assert.equal(projectMetadataHealthFacts(health({ status: 'recovery-marker-corrupt' }), rescue).needsRecovery, true)
  assert.equal(projectMetadataHealthFacts(health({ status: 'recovery-marker-corrupt' }), { markerRescueAvailable: false }).needsRecovery, false)
  assert.equal(projectMetadataHealthFacts(health({ status: 'recovery-finalized' }), rescue).needsRecovery, false)
  // The rescue flag is honored only for the marker-corrupt status, so a stray
  // flag cannot make another status claim a recovery need.
  assert.equal(projectMetadataHealthFacts(health({ status: 'recovery-finalized' }), rescue).needsRecovery, false)
  assert.equal(projectMetadataHealthFacts(health({ status: 'recovery-in-progress' }), rescue).needsRecovery, true)
})

test('the boot gate blocks the two unconditional statuses whatever the rescue seam says', () => {
  // 2026-12 audit 3.1: the boot path may NOT reuse needsRecovery (it adds the
  // recoverable selection-corrupt and subtracts marker-corrupt-without-rescue
  // through the seam). Only an unfinished transaction or a corrupt recovery
  // marker blocks the managed dsh, and the rescue flag does not soften it.
  for (const status of ['recovery-in-progress', 'recovery-marker-corrupt'] as const) {
    for (const markerRescueAvailable of [false, true]) {
      const gate = projectMetadataRecoveryGate(health({ status }), { markerRescueAvailable })
      assert.equal(gate.startupMustBlock, true,
        status + ' must block startup unconditionally (rescue=' + String(markerRescueAvailable) + ')')
    }
  }
  for (const status of ['healthy', 'selection-corrupt', 'recovery-finalized'] as const) {
    for (const markerRescueAvailable of [false, true]) {
      const gate = projectMetadataRecoveryGate(health({ status }), { markerRescueAvailable })
      assert.equal(gate.startupMustBlock, false,
        status + ' must not block startup by itself (rescue=' + String(markerRescueAvailable) + ')')
    }
  }
})

test('the gate delegates needsRecovery to the facts projection (no second rule copy)', () => {
  const statuses = ['healthy', 'selection-corrupt', 'recovery-in-progress', 'recovery-marker-corrupt', 'recovery-finalized'] as const
  for (const status of statuses) {
    for (const markerRescueAvailable of [false, true]) {
      const fact = health({ status })
      assert.deepEqual(
        projectMetadataRecoveryGate(fact, { markerRescueAvailable }),
        {
          needsRecovery: projectMetadataHealthFacts(fact, { markerRescueAvailable }).needsRecovery,
          startupMustBlock: status === 'recovery-in-progress' || status === 'recovery-marker-corrupt',
        },
        status + ' (rescue=' + String(markerRescueAvailable) + ')',
      )
    }
  }
})
