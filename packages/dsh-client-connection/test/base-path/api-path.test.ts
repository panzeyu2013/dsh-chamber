/**
 * node:test for the chamber base path
 * (packages/dsh-client-connection/src/api-path.ts) — the ONLY chamber
 * source with no static gate, so this suite is its runtime check:
 * `resolveInstanceBasePath` decides the per-instance proxy prefix from the
 * explicit argument, then `window.__DSH_BASE_PATH__`, then the stock empty
 * (paths carry `/api` as authored); trailing slashes normalize away and the
 * stock `/api` collapses to the no-prefix form.
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

// ── window.__DSH_BASE_PATH__ compatibility fallback ──────────────────────

test('base-path: the window compatibility fallback applies when no explicit argument is given', () => {
  withWindow({ __DSH_BASE_PATH__: '/api/i/ssh-x' }, () => {
    assert.equal(resolveInstanceBasePath(), '/api/i/ssh-x')
    assert.equal(resolveInstanceBasePath('/api/i/local'), '/api/i/local') // explicit still wins over the knob
    withWindow({ __DSH_BASE_PATH__: API_PATH }, () => {
      assert.equal(resolveInstanceBasePath(), '') // the stock knob value collapses too
    })
  })
})

// ── no window (node / fixture half) ───────────────────────────────────────

test('base-path: without a window the knob is absent and the stock default applies', () => {
  withWindow(undefined, () => {
    assert.equal(resolveInstanceBasePath(), '')
  })
})

test('base-path: the stock /api constant is the one path authoring uses', () => {
  assert.equal(API_PATH, '/api')
})
