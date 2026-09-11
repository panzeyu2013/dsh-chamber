/**
 * Complete-bridge source-text locks (design 05 §5, 2026-12 修订).
 *
 * These pin the CONTRACT the panel now depends on and the traps it must not
 * fall back into. They are source-text locks on purpose (plain node, no DOM,
 * no cordis runtime) — the same technique this package already used for the
 * retired child-ctx assembly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Read one source file of this package. */
function code(relative: string): string {
  return readFileSync(join(HERE, relative), 'utf8');
}

test('the outlet renders with the SOURCE OWN seats and never invents a substitute', () => {
  const outlet = code('../src/client/bridge-outlet.tsx');
  for (const stub of ['emptyObservableHook', 'panelInfoHook', 'EMPTY_SNAPSHOT', 'EMPTY_PANEL_INFO']) {
    assert.ok(!outlet.includes(stub),
      `the kit must not fabricate ${stub}: an absent seat is a fact about the source, not a hook to fake`);
  }
  assert.ok(outlet.includes('seatProps(standard)'),
    'the kit must be materialized from the passed standard seats');
  for (const seat of ['useSessions', 'useWorkspaces', 'usePanelInfo', 'useResource', 'useSessionPendingInteraction']) {
    assert.ok(outlet.includes(seat), `the seat subset must carry ${seat}`);
  }
  for (const privateReach of ['keyedHooks', 'provideRoot', 'host.root', 'slots.root', '_rootSource', 'install(']) {
    assert.ok(!outlet.includes(privateReach),
      `the outlet must not consume the root read face (${privateReach}) — it is delivered only to the installed renderer`);
  }
});

test('the face registry publishes per instance and gates on the incarnation proof', () => {
  const face = code('../src/client/settings-source-face.ts');
  assert.ok(face.includes('publishSettingsSourceRuntime') && face.includes('publishSettingsSourceSeats'),
    'the ctx half and the renderer-bound seat half are published separately');
  assert.ok(face.includes('sourceFingerprint'),
    'the face must carry the authoritative incarnation proof the panel compares against the roster');
  assert.ok(face.includes('settingsSourceFaceReady'),
    'a half-published face (ledger without seats) must not be renderable');
  assert.ok(face.includes('catch (error)'),
    'every fan-out path must isolate a throwing reader from its siblings');
});

test('the panel renders the selected source’s own ledger, keyed by the roster incarnation', () => {
  const shell = code('../src/client/SettingsShell.tsx');
  assert.ok(shell.includes('getSettingsSourceFace(selectedId)'),
    'the panel must read the selected source’s published face');
  assert.ok(shell.includes('face.sourceFingerprint === selected?.sourceFingerprint'),
    'a face from a replaced source incarnation must never render');
  assert.ok(shell.includes('chamberBridge.setSettingsTarget'),
    'the panel must ask the App layer to keep the selected source’s shell mounted');
  for (const retired of ['mountBridgeSession', 'BridgeSession', 'toAssemblyReport', 'mountRetry', 'nextMountRetryDelayMs']) {
    assert.ok(!shell.includes(retired), `the retired child-ctx path (${retired}) must be gone`);
  }
});

test('the retired child-context machinery is not present anywhere in src', () => {
  for (const relative of [
    '../src/client/bridge-context.ts',
    '../src/client/settings-extensions.ts',
    '../src/client/mount-retry.ts',
    '../src/client/bridge-api.ts',
    '../src/client/bridge-rows/index.ts',
    '../src/client/runtime-section-plugin.ts',
  ]) {
    assert.throws(() => code(relative), `the retired module ${relative} must be deleted`);
  }
});

test('the runtime section registers on the source’s own ctx, not per panel target', () => {
  const index = code('../src/client/index.ts');
  assert.ok(index.includes("ctx.slots.inject('settings.section'"),
    'the「dsh 运行时」section must be registered on the instance’s own ledger');
  assert.ok(index.includes('deriveRuntimeSource') && index.includes('runtimeSectionIntentionallyAbsent'),
    'the local/gateway/absent matrix must stay derived from projected capability facts');
  assert.ok(index.includes('console.error'),
    'a malformed projection must be reported, never thrown at the instance’s own boot');
});
