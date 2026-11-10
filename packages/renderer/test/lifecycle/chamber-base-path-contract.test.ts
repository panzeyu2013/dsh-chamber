/**
 * Public client-plugin context contract v1 (design 09 §4): every chamber N-ctx
 * entry publishes the per-entry chamberBasePath before any client plugin
 * materializes, and a native dsh host publishes none. The real Cordis
 * provide/get visibility is covered by scripts/chamber-base-path-real-context.test.mjs;
 * this suite locks the value shape and the rejection cases that keep the single
 * source honest (fake contexts only).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createChamberContextSetup, shellModule, testSourceFingerprint } from '../support/shell-harness.ts'

interface Capture {
  facts: Record<string, unknown>
  ctx: { provide(name: string, value?: unknown): () => void }
}

/** Minimal configureContext target: records every provided service. */
function capture(): Capture {
  const facts: Record<string, unknown> = {}
  return {
    facts,
    ctx: {
      provide(name, value) {
        facts[name] = value
        return () => {}
      },
    },
  }
}

const BASE_PATH = /^\/api\/i\/[^/]+$/

test('contract v1: local entry publishes /api/i/local and the local transport', () => {
  const { facts, ctx } = capture()
  createChamberContextSetup('local', '/api/i/local')(ctx)
  assert.equal(facts.chamberBasePath, '/api/i/local')
  assert.match(String(facts.chamberBasePath), BASE_PATH)
  assert.equal(facts.chamberInstanceId, 'local')
  assert.equal(facts.chamberTransport, 'local')
  assert.ok(!String(facts.chamberBasePath).endsWith('/'), 'the contract value carries no trailing slash')
})

test('contract v1: remote dsh/ssh entries publish their own prefix and transport', () => {
  const dsh = capture()
  shellModule.createChamberContextSetup(
    'dsh-abc', '/api/i/dsh-abc', testSourceFingerprint('dsh-abc'), 'http',
  )(dsh.ctx)
  assert.equal(dsh.facts.chamberBasePath, '/api/i/dsh-abc')
  assert.match(String(dsh.facts.chamberBasePath), BASE_PATH)
  assert.equal(dsh.facts.chamberTransport, 'http')

  const ssh = capture()
  shellModule.createChamberContextSetup(
    'ssh-abc', '/api/i/ssh-abc', testSourceFingerprint('ssh-abc'), 'ssh',
  )(ssh.ctx)
  assert.equal(ssh.facts.chamberBasePath, '/api/i/ssh-abc')
  assert.equal(ssh.facts.chamberTransport, 'ssh')
})

test('contract v1: malformed or cross-instance prefixes are rejected at the single source', () => {
  assert.throws(() => shellModule.createChamberContextSetup(' ', '/api/i/ ', 'ab'.repeat(32)), /empty instance id/)
  assert.throws(
    () => shellModule.createChamberContextSetup('local', '/api/i/local/', 'local'),
    /instance\/base-path mismatch/,
  )
  assert.throws(
    () => shellModule.createChamberContextSetup('ssh-a', '/api/i/ssh-b', testSourceFingerprint('ssh-a')),
    /instance\/base-path mismatch/,
  )
  assert.throws(
    () => shellModule.createChamberContextSetup('remote-1', '/api/i/remote-1', testSourceFingerprint('remote-1')),
    /invalid instance id/,
  )
  assert.throws(
    () => shellModule.createChamberContextSetup('ssh-a', '/api/i/ssh-a', 'not-a-fingerprint'),
    /invalid source fingerprint/,
  )
})
