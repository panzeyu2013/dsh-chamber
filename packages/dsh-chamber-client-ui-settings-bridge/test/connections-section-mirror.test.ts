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
const SHELL = join(ROOT, 'packages/dsh-chamber-client-ui-settings-bridge/src/client/SettingsShell.tsx');

/**
 * Every prop the settings shell passes to <ConnectionsSection> (the call site
 * lives in SettingsShell.tsx). Add a member here when the call site grows one —
 * a missing member in EITHER file fails this test.
 */
const CALL_SITE_PROPS: readonly string[] = [
  't',
  'pluginDiagnostics',
  'bootGaps',
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

test('connections-section mirror: the shell actually PASSES every listed prop', () => {
  // 2026-12 review (falsification): the two cases above only prove that both
  // SIDES DECLARE the props — a prop could be dropped from the call site and the
  // whole connections card surface would go dead with every test green. This
  // case reads the call site the list claims to describe.
  const shell = readFileSync(SHELL, 'utf8');
  const start = shell.indexOf('<ConnectionsSection');
  assert.ok(start >= 0, `the shell no longer renders <ConnectionsSection> (${SHELL})`);
  const end = shell.indexOf('/>', start);
  assert.ok(end > start, 'the <ConnectionsSection> element must be self-closing');
  const callSite = shell.slice(start, end);
  for (const prop of CALL_SITE_PROPS) {
    assert.ok(
      new RegExp(`(?:^|\\s)${prop}=`).test(callSite),
      `the shell stopped passing "${prop}" to <ConnectionsSection> — the surface it feeds is dead`,
    );
  }
  // …and the reverse direction: the shell must not pass a member the list does
  // not track (a new prop would otherwise reach the component un-gated).
  for (const match of callSite.matchAll(/(?:^|\s)([a-zA-Z][a-zA-Z0-9]*)=/g)) {
    assert.ok(
      CALL_SITE_PROPS.includes(match[1]!),
      `"${match[1]}" is passed to <ConnectionsSection> but is not in CALL_SITE_PROPS`,
    );
  }
});
