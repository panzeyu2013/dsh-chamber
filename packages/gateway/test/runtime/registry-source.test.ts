/**
 * Behavior tests for the extracted gateway registry source persistence:
 * default origin, canonical round-trip, byte-preserving quarantine on corrupt
 * content and the loud refusal once quarantined.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REGISTRY_ORIGIN, ensureRuntimeRootNoFollow } from '@dsh-chamber/dsh-runtime'
import { readRegistryOrigin, writeRegistryOrigin } from '../../src/runtime/registry-source.ts'

function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-registry-source-'))
  const stateRoot = ensureRuntimeRootNoFollow(stateDir)
  return { stateDir, stateRoot, file: join(stateRoot, 'registry.json') }
}

function evidence(stateRoot: string): string[] {
  return readdirSync(stateRoot).filter((name) => name.startsWith('registry.json.corrupt-')).sort()
}

test('a truly missing registry file falls back to the default npmjs origin', () => {
  const { stateDir, stateRoot } = fixture()
  try {
    assert.equal(readRegistryOrigin(stateDir), DEFAULT_REGISTRY_ORIGIN)
    assert.deepEqual(evidence(stateRoot), [], 'a real absence is not corruption evidence')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('writeRegistryOrigin round-trips the canonical origin', () => {
  const { stateDir } = fixture()
  try {
    writeRegistryOrigin(stateDir, DEFAULT_REGISTRY_ORIGIN)
    assert.equal(readRegistryOrigin(stateDir), DEFAULT_REGISTRY_ORIGIN)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('invalid JSON is quarantined byte-for-byte and stays loud on the next read', () => {
  const { stateDir, stateRoot, file } = fixture()
  try {
    writeFileSync(file, '{broken-json')
    assert.throws(() => readRegistryOrigin(stateDir), (error: unknown) => {
      const message = (error as Error).message
      return /invalid JSON/.test(message) && /original bytes preserved as registry\.json\.corrupt-/.test(message)
    })
    const preserved = evidence(stateRoot)
    assert.equal(preserved.length, 1)
    assert.equal(readFileSync(join(stateRoot, preserved[0]), 'utf8'), '{broken-json', 'the original bytes survive')
    assert.throws(() => readRegistryOrigin(stateDir), /remains quarantined/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a non-canonical origin is treated as corrupt, never silently normalized', () => {
  const { stateDir, stateRoot, file } = fixture()
  try {
    writeFileSync(file, JSON.stringify({ origin: DEFAULT_REGISTRY_ORIGIN + '/' }))
    assert.throws(() => readRegistryOrigin(stateDir), /origin is missing or non-canonical/)
    assert.equal(evidence(stateRoot).length, 1)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a symlinked registry file is unsafe and quarantined', { skip: process.platform === 'win32' }, () => {
  const { stateDir, stateRoot } = fixture()
  const outside = join(stateDir, 'outside-target.json')
  try {
    writeFileSync(outside, JSON.stringify({ origin: DEFAULT_REGISTRY_ORIGIN }))
    symlinkSync(outside, join(stateRoot, 'registry.json'))
    assert.throws(() => readRegistryOrigin(stateDir), /not a bounded single-link regular file/)
    assert.equal(evidence(stateRoot).length, 1)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
