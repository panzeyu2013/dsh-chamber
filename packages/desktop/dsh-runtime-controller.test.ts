/**
 * dsh-runtime-controller.ts tests (design 16 §3.5/§3.6) — node:test, no real
 * fetch/install. fetchMetadata / install / store are injected mocks; the tests
 * assert orchestration: check phases, no-op + version-exists gates,
 * single-flight, override.pending write, resetBuiltin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshRuntimeController } from './dsh-runtime-controller.ts';
import type { RegistryMetadata } from './registry-metadata.ts';
import type { OverrideRecord } from './dsh-runtime-store.ts';
import type { InstallResult } from './runtime-installer.ts';

function meta(latest: string | null, versions: string[]): RegistryMetadata {
  const byVersion = new Map<string, { version: string; tarball: string; integrity: string | null }>();
  for (const v of versions) byVersion.set(v, { version: v, tarball: `https://r/${v}.tgz`, integrity: 'sha512-x' });
  return { latest, versions, byVersion };
}

interface Store {
  override: OverrideRecord | null
  pointer: string | null
  trees: string[]
  deleted: boolean
}

function makeStore(): Store {
  return { override: null, pointer: null, trees: [], deleted: false };
}

function makeDeps(store: Store, opts?: { meta?: RegistryMetadata; installResult?: InstallResult; installError?: Error }) {
  return {
    fetchMetadata: async () => opts?.meta ?? meta('0.2.0', ['0.2.0', '0.1.1-rc.2']),
    install: async (): Promise<InstallResult> => {
      if (opts?.installError) throw opts.installError;
      return opts?.installResult ?? { versionTreeDir: '/rt/0.2.0', resolvedVersion: '0.2.0' };
    },
    store: {
      readOverride: () => store.override,
      writeOverride: (_b: string, record: OverrideRecord) => { store.override = record; },
      readCurrentPointer: () => store.pointer,
      listVersionTrees: () => store.trees,
      deleteOverride: () => { store.deleted = true; store.override = null; },
    },
    shellVersion: '0.1.4',
  };
}

function makeController(store: Store, deps?: ReturnType<typeof makeDeps>, opts?: { bundled?: string | null }) {
  return new DshRuntimeController({
    baseDir: '/base', bundledVersion: opts?.bundled ?? '0.1.1-rc.2', packageName: '@deepseek-ai/dsh',
    registryOrigin: 'https://registry.npmjs.org', pnpmEntry: '/pnpm/bin/pnpm.cjs',
    compatibilityBaseline: null, deps: deps ?? makeDeps(store),
  });
}

test('check: success fills latest + versions, phase available when newer', async () => {
  const store = makeStore();
  const c = makeController(store);
  const state = await c.check();
  assert.equal(state.latest, '0.2.0');
  assert.equal(state.phase, 'available');
  assert.equal(state.versions.find((v) => v.latest)?.version, '0.2.0');
  assert.equal(state.versions[0]?.version, '0.1.1-rc.2'); // active pinned to top
});

test('check: latest equals active → phase idle', async () => {
  const store = makeStore();
  store.pointer = '0.2.0';
  const c = makeController(store, makeDeps(store, { meta: meta('0.2.0', ['0.2.0']) }), { bundled: '0.1.1-rc.2' });
  const state = await c.check();
  assert.equal(state.phase, 'idle');
});

test('check: fetchMetadata failure → phase error', async () => {
  const store = makeStore();
  const deps = makeDeps(store);
  deps.fetchMetadata = async () => { throw new Error('network down'); };
  const c = makeController(store, deps);
  const state = await c.check();
  assert.equal(state.phase, 'error');
  assert.match(state.error ?? '', /network down/);
});

test('install: selecting active version is a no-op', async () => {
  const store = makeStore();
  store.pointer = '0.2.0';
  let installCalls = 0;
  const deps = makeDeps(store, { meta: meta('0.2.0', ['0.2.0']) });
  deps.install = async () => { installCalls += 1; return { versionTreeDir: '/x', resolvedVersion: '0.2.0' }; };
  const c = makeController(store, deps);
  await c.check();
  const state = await c.install('0.2.0');
  assert.equal(installCalls, 0);
  assert.equal(state.pending, null);
});

test('install: version not in registry → error, no install', async () => {
  const store = makeStore();
  let installCalls = 0;
  const deps = makeDeps(store, { meta: meta('0.2.0', ['0.2.0']) });
  deps.install = async () => { installCalls += 1; return { versionTreeDir: '/x', resolvedVersion: '0.9.9' }; };
  const c = makeController(store, deps);
  await c.check();
  const state = await c.install('0.9.9');
  assert.equal(installCalls, 0);
  assert.equal(state.phase, 'error');
});

test('install: success writes override.pending and phase pending', async () => {
  const store = makeStore();
  const c = makeController(store);
  await c.check();
  const state = await c.install('0.2.0');
  assert.equal(state.phase, 'pending');
  assert.equal(state.pending, '0.2.0');
  assert.equal(store.override?.pending, '0.2.0');
  assert.equal(store.override?.resolvedVersion, '0.2.0');
});

test('install: failure → phase error with sanitized message', async () => {
  const store = makeStore();
  const deps = makeDeps(store, { installError: new Error('pnpm install failed /opt/x') });
  const c = makeController(store, deps);
  await c.check();
  const state = await c.install('0.2.0');
  assert.equal(state.phase, 'error');
  assert.match(state.error ?? '', /pnpm install failed/);
});

test('install: single-flight — a second install during in-flight is rejected', async () => {
  const store = makeStore();
  let resolveFirst!: (r: InstallResult) => void;
  let installCalls = 0;
  const deps = makeDeps(store);
  deps.install = () => { installCalls += 1; return new Promise((resolve) => { resolveFirst = resolve; }); };
  const c = makeController(store, deps);
  await c.check();
  const first = c.install('0.2.0');
  const second = await c.install('0.2.0'); // should be rejected by single-flight
  assert.equal(installCalls, 1);
  assert.equal(second.phase, 'installing'); // in-flight state, no new install started
  resolveFirst({ versionTreeDir: '/rt/0.2.0', resolvedVersion: '0.2.0' });
  await first;
});

test('resetBuiltin: deletes override, clears pending', async () => {
  const store = makeStore();
  const c = makeController(store);
  await c.check();
  await c.install('0.2.0');
  const state = c.resetBuiltin();
  assert.equal(store.deleted, true);
  assert.equal(state.pending, null);
});

test('getState: active = current pointer ?? bundled', () => {
  const store = makeStore();
  const c = makeController(store, undefined, { bundled: '0.1.1-rc.2' });
  assert.equal(c.getState().active, '0.1.1-rc.2');
  store.pointer = '0.2.0';
  assert.equal(c.getState().active, '0.2.0');
});
