/**
 * Behavior tests for the extracted workspace-resolution facts: the env →
 * override/current → builtin chain, the loud corrupt-metadata failures and the
 * activation facts, driven directly against a temp stateDir.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRuntimeRootNoFollow, overridePath, writeCurrentPointer } from '@dsh-chamber/dsh-runtime'
import { createRuntimeWorkspaceFacts } from '../../src/runtime/workspace-facts.ts'
import {
  config,
  gatewayPackageVersion,
  makeValidTree,
  TEST_BUILTIN_VERSION,
  writeOverrideRow,
} from '../support/runtime-routes-harness.ts'

function fixture(envPath: string | null = null) {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-workspace-facts-'))
  const gatewayConfig = config(stateDir)
  const stateRoot = ensureRuntimeRootNoFollow(stateDir)
  const facts = createRuntimeWorkspaceFacts({
    anchor: gatewayConfig.plane.dshWorkspacePath,
    stateRoot,
    baseDir: stateDir,
    platform: process.platform,
    shellVersion: gatewayPackageVersion,
    builtinVersion: TEST_BUILTIN_VERSION,
    getEnvPath: () => envPath,
  })
  return { stateDir, stateRoot, anchor: gatewayConfig.plane.dshWorkspacePath, facts }
}

function externalAnchor(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-workspace-env-'))
  mkdirSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'env-anchor', dependencies: { '@deepseek-ai/dsh': version } }))
  writeFileSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  return dir
}

test('env path is the highest-priority source', () => {
  const env = externalAnchor('9.9.9')
  const { stateDir, facts } = fixture(env)
  try {
    assert.deepEqual(facts.resolveWorkspace(), { path: env, version: '9.9.9', source: 'env' })
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(env, { recursive: true, force: true })
  }
})

test('builtin anchor is the source when no env/override/pointer exists', () => {
  const { stateDir, anchor, facts } = fixture()
  try {
    assert.deepEqual(facts.resolveWorkspace(), { path: anchor, version: TEST_BUILTIN_VERSION, source: 'builtin' })
    assert.equal(facts.currentPointerVersion(), null)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('an active override with its current pointer resolves to the version tree', () => {
  const { stateDir, stateRoot, facts } = fixture()
  try {
    makeValidTree(stateDir, '1.2.3')
    writeOverrideRow(stateDir, { chosenVersion: '1.2.3', pending: null, selectedOnly: false })
    writeCurrentPointer(stateDir, '1.2.3')
    assert.deepEqual(facts.resolveWorkspace(), { path: join(stateRoot, '1.2.3'), version: '1.2.3', source: 'override' })
    assert.equal(facts.currentPointerVersion(), '1.2.3')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('a staged selection stays on builtin; a stale applied record fails loud', () => {
  const staged = fixture()
  try {
    makeValidTree(staged.stateDir, '1.2.3')
    writeOverrideRow(staged.stateDir, { chosenVersion: '1.2.3', pending: null, selectedOnly: true })
    assert.equal(staged.facts.resolveWorkspace().source, 'builtin')
  } finally {
    rmSync(staged.stateDir, { recursive: true, force: true })
  }
  const stranded = fixture()
  try {
    writeOverrideRow(stranded.stateDir, { chosenVersion: '1.2.3', pending: null, selectedOnly: false })
    assert.throws(() => stranded.facts.resolveWorkspace(), /missing its authoritative current pointer/)
  } finally {
    rmSync(stranded.stateDir, { recursive: true, force: true })
  }
})

test('a pointer without a valid tree is refused, never silently followed', () => {
  const { stateDir, facts } = fixture()
  try {
    writeOverrideRow(stateDir, { chosenVersion: '9.9.9', pending: null, selectedOnly: false })
    writeCurrentPointer(stateDir, '9.9.9')
    assert.throws(() => facts.resolveWorkspace(), /current tree 9.9.9 is invalid/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('corrupt override metadata fails loud instead of falling back to builtin', () => {
  const { stateDir, facts } = fixture()
  try {
    writeFileSync(overridePath(stateDir), '{broken-json')
    assert.throws(() => facts.resolveWorkspace(), /override metadata is corrupt/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('requireBuiltinVersion rejects an anchor that drifted after construction', () => {
  const { stateDir, anchor, facts } = fixture()
  try {
    assert.equal(facts.requireBuiltinVersion(), TEST_BUILTIN_VERSION)
    writeFileSync(join(anchor, 'package.json'), JSON.stringify({ name: 'drifted', dependencies: { '@deepseek-ai/dsh': '0.0.1' } }))
    assert.throws(() => facts.requireBuiltinVersion(), /does not expose a stable exact/)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('activation facts report the pointer as the snapshot source and the builtin real semver otherwise', () => {
  const { stateDir, facts } = fixture()
  try {
    assert.deepEqual(facts.activationFacts(), {
      sourceVersion: TEST_BUILTIN_VERSION,
      sourceIsBuiltin: true,
      sourceWasKnownGood: true,
      knownGoodVersion: null,
    })
    makeValidTree(stateDir, '1.2.3')
    writeOverrideRow(stateDir, { chosenVersion: '1.2.3', pending: null, selectedOnly: false })
    writeCurrentPointer(stateDir, '1.2.3')
    const factsAfter = facts.activationFacts()
    assert.equal(factsAfter.sourceVersion, '1.2.3')
    assert.equal(factsAfter.sourceIsBuiltin, false)
    assert.equal(factsAfter.sourceWasKnownGood, false)
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})
