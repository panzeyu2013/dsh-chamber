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
