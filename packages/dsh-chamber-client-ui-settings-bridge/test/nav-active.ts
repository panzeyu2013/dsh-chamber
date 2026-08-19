/**
 * nav-active.ts pure-logic tests (design 15 v1 flat form) — node:test, no
 * DOM. Covers the fixed chamber-global nav ids (connections / general /
 * update) staying valid regardless of the selected server's section ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTIONS_SECTION_ID,
  GENERAL_SECTION_ID,
  UPDATE_SECTION_ID,
  resolveActiveSection,
  type SectionNavRow,
} from '../src/client/nav-active.ts';

const rows: SectionNavRow[] = [
  { id: 'models', order: 10, label: 'Models' },
  { id: 'agent-presets', order: 20, label: 'Agent Presets' },
];

test('resolveActiveSection: chamber-global fixed ids always win', () => {
  assert.equal(resolveActiveSection(CONNECTIONS_SECTION_ID, rows), CONNECTIONS_SECTION_ID);
  assert.equal(resolveActiveSection(GENERAL_SECTION_ID, rows), GENERAL_SECTION_ID);
  assert.equal(resolveActiveSection(UPDATE_SECTION_ID, rows), UPDATE_SECTION_ID);
  // Even with an empty server ledger, the fixed ids stay valid.
  assert.equal(resolveActiveSection(GENERAL_SECTION_ID, []), GENERAL_SECTION_ID);
});

test('resolveActiveSection: server-section id passes through when in the ledger', () => {
  assert.equal(resolveActiveSection('models', rows), 'models');
});

test('resolveActiveSection: a section id that left the ledger falls back to the first row', () => {
  assert.equal(resolveActiveSection('plugins', rows), 'models');
  assert.equal(resolveActiveSection(undefined, rows), 'models');
  assert.equal(resolveActiveSection(undefined, []), undefined);
});
