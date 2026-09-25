/**
 * node:test for the chamber base path
 * (packages/dsh-client-connection/src/api-path.ts) — the ONLY chamber
 * source with no static gate, so this suite is its runtime check:
 * `resolveInstanceBasePath` decides the per-instance proxy prefix from the
 * explicit argument alone; trailing slashes normalize away and the stock
 * `/api` collapses to the no-prefix form. A page global is deliberately NOT read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { API_PATH, resolveInstanceBasePath } from '../../src/api-path.ts'
import { withWindow } from '../support/global-window.ts'

// ── explicit argument wins ────────────────────────────────────────────────

test('base-path: explicit per-instance prefix wins', () => {
  assert.equal(resolveInstanceBasePath('/api/i/local'), '/api/i/local')
  assert.equal(resolveInstanceBasePath('/api/i/ssh-abc'), '/api/i/ssh-abc')
})

test('base-path: trailing slashes normalize away', () => {
  assert.equal(resolveInstanceBasePath('/api/i/local/'), '/api/i/local')
  assert.equal(resolveInstanceBasePath('/api/i/local//'), '/api/i/local')
})

test('base-path: explicit empty or stock /api collapses to no-prefix', () => {
  assert.equal(resolveInstanceBasePath(''), '')
  assert.equal(resolveInstanceBasePath(API_PATH), '')
})

// ── no page global is consulted ──────────────────────────────────────────

test('base-path: a page global can never supply the prefix', () => {
  withWindow({ __DSH_BASE_PATH__: '/api/i/ssh-x' }, () => {
    assert.equal(resolveInstanceBasePath(), '', 'the removed global must not resurface as a fallback')
    assert.equal(resolveInstanceBasePath('/api/i/local'), '/api/i/local', 'only the explicit argument decides')
  })
})

// ── no window (node / fixture half) ───────────────────────────────────────

test('base-path: without a window the stock default applies', () => {
  withWindow(undefined, () => {
    assert.equal(resolveInstanceBasePath(), '')
  })
})

test('base-path: the stock /api constant is the one path authoring uses', () => {
  assert.equal(API_PATH, '/api')
})
