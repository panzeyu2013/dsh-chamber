/**
 * session-todo-settings.ts pure-logic tests (sidebar todo area control group)
 * — node:test, no DOM. Covers the group's settings access: an absent
 * sessionTodo block reads as the design defaults (ALL ON — passive
 * presentation, unlike the opt-in notifications master switch), and patches
 * ride as PARTIAL nested objects — the main-process validatePatch accepts
 * partial nested keys and applySettingsPatch deep-merges them, so a stale
 * full-object snapshot from another N-ctx shell can never clobber the sibling
 * switches.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChamberSettings } from '../src/ambient/settings-bridge.d.ts';
import {
  SESSION_TODO_DEFAULTS,
  sessionTodoOf,
  sessionTodoPatch,
} from '../src/client/session-todo-settings.ts';

// Loose fixtures: cast through unknown (structural access — the decode is
// value-validated by design, so fixtures stay independent of the authoritative
// ChamberSettings shape evolution).
const settings = (extra: object): ChamberSettings => ({ ...extra }) as unknown as ChamberSettings;

test('sessionTodo defaults are ALL ON and mirror the desktop store defaults', () => {
  // Mirror assertion: desktop DEFAULT_CHAMBER_SETTINGS.sessionTodo is
  // { enabled: true, onComplete: true, onAsk: true, onRequest: true }.
  assert.deepEqual(SESSION_TODO_DEFAULTS, { enabled: true, onComplete: true, onAsk: true, onRequest: true });
});

test('sessionTodoOf: an absent block reads as the design defaults (never a fake off)', () => {
  assert.deepEqual(sessionTodoOf(undefined), SESSION_TODO_DEFAULTS);
  assert.deepEqual(sessionTodoOf(settings({})), SESSION_TODO_DEFAULTS);
  assert.deepEqual(sessionTodoOf(settings({ windowCloseBehavior: 'quit' })), SESSION_TODO_DEFAULTS);
  // null block（损坏/未来形态）同样回落默认，不抛。
  assert.deepEqual(sessionTodoOf(settings({ sessionTodo: null })), SESSION_TODO_DEFAULTS);
  // Array block：与 desktop normalizeSessionTodoSettings 同款前置拒绝（守卫对齐）。
  assert.deepEqual(sessionTodoOf(settings({ sessionTodo: ['enabled'] })), SESSION_TODO_DEFAULTS);
});

test('sessionTodoOf: a full explicit block passes through exactly (keys can never be dropped/inverted)', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false, onComplete: false, onAsk: false, onRequest: false } }));
  assert.deepEqual(got, { enabled: false, onComplete: false, onAsk: false, onRequest: false });
});

test('sessionTodoOf: a partial block fills missing keys from the defaults', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false } }));
  assert.equal(got.enabled, false);
  assert.equal(got.onComplete, true);
  assert.equal(got.onAsk, true);
  assert.equal(got.onRequest, true);
});

test('sessionTodoOf: a mixed block keeps the valid keys and falls back per invalid key', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false, onAsk: 'bogus' } }));
  assert.deepEqual(got, { enabled: false, onComplete: true, onAsk: true, onRequest: true });
});

test('sessionTodoOf: unknown future nested keys are filtered out', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: false, futureKey: 42 } }));
  assert.deepEqual(got, { enabled: false, onComplete: true, onAsk: true, onRequest: true });
});

test('sessionTodoOf: non-boolean values fall back to the defaults', () => {
  const got = sessionTodoOf(settings({ sessionTodo: { enabled: 'yes', onComplete: 1 } }));
  assert.deepEqual(got, SESSION_TODO_DEFAULTS);
});

test('sessionTodoPatch: rides as a PARTIAL nested object (siblings never clobbered)', () => {
  const patch = sessionTodoPatch({ enabled: false });
  assert.deepEqual(patch, { sessionTodo: { enabled: false } });
  assert.equal('onComplete' in (patch.sessionTodo as object), false, 'untouched switches do not ride the wire');
});
