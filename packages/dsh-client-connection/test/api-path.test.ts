/**
 * node:test for the chamber base-path patch
 * (`packages/dsh-client-connection/src/api-path.ts`) — the ONLY chamber
 * source with no static gate, so this suite is its runtime check:
 * `resolveInstanceBasePath` decides the per-instance proxy prefix from the
 * explicit argument, then `window.__DSH_BASE_PATH__`, then the stock empty
 * (paths carry `/api` as authored); trailing slashes normalize away and the
 * stock `/api` collapses to the no-prefix form.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { API_PATH, resolveInstanceBasePath } from '../src/api-path.ts'

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

// ── window.__DSH_BASE_PATH__ knob (sequential instance boots) ─────────────

test('base-path: window knob applies when no explicit argument is given', () => {
  const prev = (globalThis as { window?: unknown }).window
  ;(globalThis as Record<string, unknown>).window = { __DSH_BASE_PATH__: '/api/i/ssh-x' }
  try {
    assert.equal(resolveInstanceBasePath(), '/api/i/ssh-x')
    // explicit still wins over the knob
    assert.equal(resolveInstanceBasePath('/api/i/local'), '/api/i/local')
    // the stock knob value collapses too
    ;(globalThis as Record<string, unknown>).window = { __DSH_BASE_PATH__: API_PATH }
    assert.equal(resolveInstanceBasePath(), '')
  } finally {
    if (prev === undefined) delete (globalThis as Record<string, unknown>).window
    else (globalThis as Record<string, unknown>).window = prev
  }
})

// ── no window (node / fixture half) ───────────────────────────────────────

test('base-path: without a window the knob is absent and the stock default applies', () => {
  const prev = (globalThis as { window?: unknown }).window
  ;(globalThis as Record<string, unknown>).window = undefined
  try {
    assert.equal(resolveInstanceBasePath(), '')
  } finally {
    if (prev === undefined) delete (globalThis as Record<string, unknown>).window
    else (globalThis as Record<string, unknown>).window = prev
  }
})

test('base-path: the stock /api constant is the one path authoring uses', () => {
  assert.equal(API_PATH, '/api')
})
