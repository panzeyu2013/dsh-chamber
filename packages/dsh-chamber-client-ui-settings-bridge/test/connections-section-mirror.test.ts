/**
 * Connections-section mirror drift gate (2026-09 relocation).
 *
 * WHY this file exists: the settings shell embeds the connections section
 * through `src/ambient/connections-section.d.ts` (a local declaration compiled
 * INSTEAD of the real component — tsconfig paths intercept the stable
 * `.../settings-connections/section` subpath, so the real TSX is never part of
 * this program). The mirror's own header says the two sides "MUST be updated
 * together", but until the settings-assembly relocation there was NO gate: a
 * prop added on the shell side could silently fail to reach the component (or
 * an ambient member could vanish with nothing noticing).
 *
 * The gate is deliberately small and textual: the props the shell passes are a
 * closed, explicit list, so both files must name each of them. It reads the two
 * sources from disk (plain node, no compiler), which is the same technique the
 * connections package already uses for its cross-package drift checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MIRROR = join(ROOT, 'packages/dsh-chamber-client-ui-settings-bridge/src/ambient/connections-section.d.ts');
const REAL = join(ROOT, 'packages/dsh-chamber-client-ui-settings-connections/src/client/ConnectionsSection.tsx');

/**
 * Every prop the settings shell passes to <ConnectionsSection> (the call site
 * lives in SettingsShell.tsx). Add a member here when the call site grows one —
 * a missing member in EITHER file fails this test.
 */
const CALL_SITE_PROPS: readonly string[] = [
  't',
  'pluginDiagnostics',
  'onRecheckDiagnostic',
  'assemblyReport',
  'assemblyT',
  'onRefreshAssembly',
  'assemblyRefreshing',
];

test('connections-section mirror: every call-site prop exists in the ambient mirror', () => {
  const mirror = readFileSync(MIRROR, 'utf8');
  for (const prop of CALL_SITE_PROPS) {
    assert.ok(
      new RegExp(`^\\s*${prop}\\??:`, 'm').test(mirror),
      `ambient mirror no longer declares the call-site prop "${prop}" (${MIRROR})`,
    );
  }
});

test('connections-section mirror: every call-site prop is accepted by the real component', () => {
  const real = readFileSync(REAL, 'utf8');
  for (const prop of CALL_SITE_PROPS) {
    assert.ok(
      new RegExp(`^\\s*${prop}\\??:`, 'm').test(real),
      `the real ConnectionsSection no longer declares the prop "${prop}" (${REAL})`,
    );
  }
});

test('connections-section mirror: the assembly report mirror keeps the producer contract', () => {
  const mirror = readFileSync(MIRROR, 'utf8');
  const producer = readFileSync(
    join(ROOT, 'packages/dsh-chamber-client-ui-settings-bridge/src/client/settings-extensions.ts'),
    'utf8',
  );
  for (const field of ['sourceId', 'state', 'total', 'notices']) {
    assert.ok(new RegExp(`^\\s*${field}\\??:`, 'm').test(mirror), `mirror lost report field "${field}"`);
    assert.ok(new RegExp(`^\\s*${field}\\??:`, 'm').test(producer), `producer lost report field "${field}"`);
  }
});

/**
 * Keys the assembly block asks THIS shell's dictionary for. They cannot be
 * type-checked across the package boundary (the block receives a translate
 * function, not the dictionary), so the contract is pinned textually — the
 * same reasoning as the mirror gate above.
 */
test('assembly block: every copy key it renders exists in the shell dictionary (zh + en)', () => {
  const view = readFileSync(
    join(ROOT, 'packages/dsh-chamber-client-ui-settings-connections/src/client/settings-assembly-diagnostics.tsx'),
    'utf8',
  );
  const pure = readFileSync(
    join(ROOT, 'packages/dsh-chamber-client-ui-settings-connections/src/client/settings-assembly-diagnostics.ts'),
    'utf8',
  );
  const locales = readFileSync(join(ROOT, 'packages/dsh-chamber-client-ui-settings-bridge/src/locales.ts'), 'utf8');
  const used = new Set(
    [...`${view}\n${pure}`.matchAll(/\bt\('([A-Za-z0-9_]+)'/g)].map(match => match[1]!),
  );
  assert.ok(used.size >= 8, `expected the block to render its own copy, found ${used.size} keys`);
  // The producer's notice keys travel as data; every one must be in the shell
  // dictionary too.
  for (const key of ['pluginsUnavailable', 'noticeInactive', 'noticeFailed', 'noticeOmittedSeat', 'noticeCrash', 'noticeShared', 'noticeCapability', 'noticeRevConflict']) {
    used.add(key);
  }
  for (const key of used) {
    const declarations = [...locales.matchAll(new RegExp(`^\\s*${key}:`, 'gm'))].length;
    assert.equal(declarations, 2, `"${key}" must be declared in BOTH dictionaries (zh + en), found ${declarations}`);
  }
});
