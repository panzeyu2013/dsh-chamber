/**
 * Escape ownership tests (2026-09-11 regression).
 *
 * The bug these lock down: the settings panel's document-level Escape guard
 * asked `document.querySelector('[aria-modal="true"]') !== null` while the
 * panel itself is `role="dialog" aria-modal="true"`, so the query always
 * self-matched and Escape silently did nothing (the guard's comment even
 * claimed self-matching was impossible). The rule now excludes the panel's own
 * node by identity; the wiring lock below keeps the shell passing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nestedModalOwnsEscape } from '../src/client/escape-owner.ts';

test('the panel own node never blocks its own Escape', () => {
  const panel = { id: 'panel' };
  assert.equal(nestedModalOwnsEscape([panel], panel), false, 'only our panel open: Escape closes it');
  assert.equal(nestedModalOwnsEscape([], panel), false, 'no modal at all');
});

test('any OTHER modal owns Escape (nested dialog first Esc closes only that layer)', () => {
  const panel = { id: 'panel' };
  assert.equal(nestedModalOwnsEscape([panel, { id: 'nested' }], panel), true, 'nested dialog');
  assert.equal(nestedModalOwnsEscape([{ id: 'foreign' }], panel), true, 'another layer overlay');
  assert.equal(nestedModalOwnsEscape([panel], undefined), true,
    'no panel node in the document (unexpected while open): stay inert rather than close blind');
});

test('the shell wires the rule with its own panel node and an accessible trigger name', () => {
  const source = readFileSync(new URL('../src/client/SettingsShell.tsx', import.meta.url), 'utf8');
  assert.match(source, /nestedModalOwnsEscape\(document\.querySelectorAll\('\[aria-modal="true"\]'\), panelRef\.current\)/,
    'the guard must compare by node identity, passing the panel ref');
  assert.match(source, /<div ref=\{panelRef\} className=\{css\.panel\} role="dialog" aria-modal="true"/,
    'the ref must be attached to the panel node the rule excludes');
  assert.doesNotMatch(source, /document\.querySelector\('\[aria-modal="true"\]'\) !== null/,
    'a blanket aria-modal query self-matches the panel and kills Escape');
  assert.match(source, /aria-label=\{t\('trigger'\)\}/,
    'the rail trigger renders an icon only: it needs the official accessible name');
});
