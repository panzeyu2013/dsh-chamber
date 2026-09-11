/**
 * nav-active.ts pure-logic tests (design 15 v1 flat form) — node:test, no
 * DOM. Covers the fixed chamber-global nav ids (connections / general — the
 * update status lives inside General) staying valid regardless of the
 * selected server's section ledger.
 *
 * 2026-09 修订：第三个固定入口 `__plugins` 已退役（其 subject 是单个来源、
 * owner 是 chamber 壳，两组都不属于它），现由连接页在该服务器卡片内呈现；
 * 本文件因此只守 connections/general 两个固定 id，并显式钉死「退役的 id
 * 不再是固定项」——否则它会作为普通 ledger id 走回落分支。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTIONS_SECTION_ID,
  FIXED_SECTION_IDS,
  GENERAL_SECTION_ID,
  isFixedSectionId,
  resolveActiveSection,
  type SectionNavRow,
} from '../src/client/nav-active.ts';
import { sectionRows } from '../src/client/section-rows.ts';

const rows: SectionNavRow[] = [
  { id: 'models', order: 10, label: 'Models' },
  { id: 'agent-presets', order: 20, label: 'Agent Presets' },
];

test('resolveActiveSection: chamber-global fixed ids always win', () => {
  assert.equal(resolveActiveSection(CONNECTIONS_SECTION_ID, rows), CONNECTIONS_SECTION_ID);
  assert.equal(resolveActiveSection(GENERAL_SECTION_ID, rows), GENERAL_SECTION_ID);
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

test('resolveActiveSection: the retired __plugins id is no longer a fixed entry', () => {
  // It must behave like any unknown ledger id: fall back to the first row.
  assert.equal(resolveActiveSection('__plugins', rows), 'models');
  assert.equal(resolveActiveSection('__plugins', []), undefined);
  assert.equal(FIXED_SECTION_IDS.includes('__plugins'), false);
});

test('isFixedSectionId: chamber-owned pages are distinguishable from ledger sections', () => {
  assert.equal(isFixedSectionId(CONNECTIONS_SECTION_ID), true);
  assert.equal(isFixedSectionId(GENERAL_SECTION_ID), true);
  assert.equal(isFixedSectionId('__plugins'), false);
  assert.equal(isFixedSectionId('models'), false);
  assert.equal(isFixedSectionId(undefined), false);
});

test('FIXED_SECTION_IDS: exactly the two chamber-global entries (design 15 contract)', () => {
  assert.deepEqual([...FIXED_SECTION_IDS], [CONNECTIONS_SECTION_ID, GENERAL_SECTION_ID]);
});

test('nav rows carry id/order/label only — no provenance tag (upstream form)', () => {
  const row: SectionNavRow = { id: 'x', order: 1, label: 'X' };
  assert.deepEqual(Object.keys(row).sort(), ['id', 'label', 'order']);
  // A ledger entry's `registrant` stamp is DIAGNOSTICS-ONLY upstream (the
  // official shell renders `navIcon(row.id)` + the label and nothing else), so
  // the projection drops it: a plugin-provided section must look exactly like an
  // official one, in this panel as in the instance's own frontend. The old
  // chamber-side「插件」provenance tag is retired (2026-09-11).
  const entries = [
    { options: { id: 'models', order: 20, label: '模型' }, registrant: '@deepseek-ai/dsh-client-ui-settings-models' },
    { options: { id: 'acme', order: 40, label: 'Acme' }, registrant: '@acme/dsh-plugin-acme' },
  ];
  assert.deepEqual(sectionRows({ entries: () => entries }), [
    { id: 'models', order: 20, label: '模型' },
    { id: 'acme', order: 40, label: 'Acme' },
  ]);
});
