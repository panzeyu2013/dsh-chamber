/**
 * node:test for the rc.8 `commands.execute` wire compat bridge
 * (`packages/dsh-client-connection/src/client/rc8-commands-compat.ts`) — the
 * load-bearing decision behind the "无法调整 session 权限" fix (2026-08):
 * an rc.7-shaped shell against an rc.8+ host must present the `images`
 * argument the rc.8 host command executor requires, while rc.7-era hosts must
 * never receive the extra field (their gateway rejects it). Pure functions —
 * no DOM, no network — so this suite runs under plain node
 * (`pnpm run test:connection`).
 *
 * The assertions pin the exact version-gate semantics: only host versions
 * semver-sorting at/after 0.1.0-rc.8 get the rewrite, and the rewrite is
 * additive and idempotent (never mutates the caller's envelope).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMMANDS_EXECUTE_ENDPOINT,
  applyCommandsExecuteCompat,
  needsCommandsImagesArg,
  withCommandsImagesArg,
} from '../src/client/rc8-commands-compat.ts'

// ── needsCommandsImagesArg: the version gate ───────────────────────────────

test('version gate: rc.7-era hosts never need the images arg', () => {
  assert.equal(needsCommandsImagesArg(undefined), false)
  assert.equal(needsCommandsImagesArg('0.1.0-rc.7'), false)
  assert.equal(needsCommandsImagesArg('0.0.1-rc.5'), false)
  assert.equal(needsCommandsImagesArg('0.1.0-rc.0'), false)
})

test('version gate: rc.8 and every later 0.1.0-line version need the images arg', () => {
  assert.equal(needsCommandsImagesArg('0.1.0-rc.8'), true)
  assert.equal(needsCommandsImagesArg('0.1.0-rc.9'), true)
  assert.equal(needsCommandsImagesArg('0.1.0-rc.99'), true)
  // Semver pre-release ordering: the stable release sorts after rc.8.
  assert.equal(needsCommandsImagesArg('0.1.0'), true)
  assert.equal(needsCommandsImagesArg('0.2.0'), true)
  assert.equal(needsCommandsImagesArg('1.0.0'), true)
})

test('version gate: unknown or malformed version strings conservatively answer false', () => {
  assert.equal(needsCommandsImagesArg(''), false)
  assert.equal(needsCommandsImagesArg('0.1.0-rc.8-1'), false)
  assert.equal(needsCommandsImagesArg('dev'), false)
  assert.equal(needsCommandsImagesArg('0.1.0-rc.eight'), false)
})

// ── withCommandsImagesArg: the additive rewrite ────────────────────────────

const rc7Payload = { args: { sessionId: 'sx-1', line: '/permission workspace-write' } }

test('rewrite: adds images: [] into the args envelope when absent', () => {
  const next = withCommandsImagesArg(rc7Payload) as { args: Record<string, unknown> }
  assert.deepEqual(next, {
    args: { sessionId: 'sx-1', line: '/permission workspace-write', images: [] },
  })
  // Non-mutating: the caller envelope is untouched (frozen-safe).
  assert.deepEqual(rc7Payload, { args: { sessionId: 'sx-1', line: '/permission workspace-write' } })
  assert.notEqual(next, rc7Payload)
})

test('rewrite: a payload that already carries images passes through unchanged', () => {
  const rc8Payload = { args: { sessionId: 'sx-1', line: '/compact', images: [] } }
  assert.equal(withCommandsImagesArg(rc8Payload), rc8Payload)
})

test('rewrite: non-args envelopes pass through untouched', () => {
  const plain = { ns: 'permission', ops: [] }
  assert.equal(withCommandsImagesArg(plain), plain)
  assert.equal(withCommandsImagesArg(null), null)
  assert.equal(withCommandsImagesArg(undefined), undefined)
  const text = 'payload'
  assert.equal(withCommandsImagesArg(text), text)
  const empty = {}
  assert.equal(withCommandsImagesArg(empty), empty)
})

// ── applyCommandsExecuteCompat: the full decision ──────────────────────────

test('compat: rc.8 host gets the rewrite, rc.7 host never does', () => {
  const next = applyCommandsExecuteCompat(rc7Payload, '0.1.0-rc.8') as { args: Record<string, unknown> }
  assert.deepEqual(next.args.images, [])
  assert.equal(applyCommandsExecuteCompat(rc7Payload, '0.1.0-rc.7'), rc7Payload)
  assert.equal(applyCommandsExecuteCompat(rc7Payload, undefined), rc7Payload)
})

test('compat: the endpoint constant is the exact generic-RPC wire id', () => {
  assert.equal(COMMANDS_EXECUTE_ENDPOINT, 'commands/execute')
})
