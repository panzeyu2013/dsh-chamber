/**
 * settings-assembly-diagnostics.ts pure-logic tests (2026-09 relocation) —
 * node:test, no DOM.
 *
 * The block the connections page renders inside the selected server's card is
 * split the way `plugin-diagnostic.ts`(pure)/`.tsx`(view) already splits that
 * surface, so every decision the user can see is pinned here: tone, the
 * loading verdict, the settled summary, and the reading order (which is the
 * producer's, never re-sorted here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblyIsLoading,
  assemblyLines,
  assemblySummary,
  type AssemblyTranslate,
  type SettingsAssemblyReportView,
} from '../src/client/settings-assembly-diagnostics.ts';

/** Translate stub: echoes key + params so assertions stay copy-independent. */
const t: AssemblyTranslate = (key, params) => `${key}${params === undefined ? '' : JSON.stringify(params)}`;

function report(over: Partial<SettingsAssemblyReportView> = {}): SettingsAssemblyReportView {
  return { sourceId: 'local', state: 'ready', total: 0, notices: [], ...over };
}

test('assemblyIsLoading: pending/loading are the assembling states', () => {
  assert.equal(assemblyIsLoading(report({ state: 'pending' })), true);
  assert.equal(assemblyIsLoading(report({ state: 'loading' })), true);
  assert.equal(assemblyIsLoading(report({ state: 'ready' })), false);
  assert.equal(assemblyIsLoading(report({ state: 'unavailable' })), false);
});

test('assemblyLines: one localized line per notice, order preserved', () => {
  const lines = assemblyLines(report({
    notices: [
      { key: 'noticeInactive', params: { plugin: 'p', missing: 'sessions' } },
      { key: 'noticeFailed', params: { plugin: 'q', detail: 'boom' } },
    ],
  }), t);
  assert.deepEqual(lines.map(line => line.tone), ['info', 'info']);
  assert.match(lines[0]!.text, /^noticeInactive\{"plugin":"p","missing":"sessions"\}$/);
  assert.match(lines[1]!.text, /^noticeFailed\{/);
});

test('assemblyLines: only the channel-level failure is a warning', () => {
  const lines = assemblyLines(report({
    state: 'unavailable',
    notices: [
      { key: 'pluginsUnavailable', params: { error: 'HTTP 404' } },
      { key: 'noticeCrash', params: { plugin: 'p', detail: 'render' } },
    ],
  }), t);
  assert.deepEqual(lines.map(line => line.tone), ['warn', 'info']);
});

test('assemblyLines: no notices yields no lines (silence is not reported as a line)', () => {
  assert.deepEqual(assemblyLines(report({ state: 'ready' }), t), []);
});

test('assemblySummary: assembling beats every settled verdict', () => {
  assert.equal(assemblySummary(report({ state: 'loading', total: 3 }), t), 'pluginsLoading');
  assert.equal(assemblySummary(report({ state: 'pending', notices: [{ key: 'noticeFailed' }] }), t), 'pluginsLoading');
});

test('assemblySummary: the settled verdict distinguishes "nothing installed" from "all loaded"', () => {
  assert.equal(assemblySummary(report({ state: 'ready', total: 0 }), t), 'pluginsEmpty');
  assert.equal(assemblySummary(report({ state: 'ready', total: 2 }), t), 'pluginsAllLoaded');
});

test('assemblySummary: when notices exist the list carries the story (no summary line)', () => {
  assert.equal(assemblySummary(report({ state: 'ready', total: 2, notices: [{ key: 'noticeShared' }] }), t), null);
});

test('assemblySummary: the unavailable state always shows its notice, never a summary', () => {
  assert.equal(assemblySummary(report({ state: 'unavailable', notices: [{ key: 'pluginsUnavailable' }] }), t), null);
});
