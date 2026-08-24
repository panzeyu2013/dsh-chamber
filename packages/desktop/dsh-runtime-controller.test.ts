/**
 * dsh-runtime-controller.ts tests (design 18 §3.5/§3.6) — node:test, no real
 * fetch/install. fetchMetadata / install / store are injected mocks; the tests
 * assert orchestration: check phases, no-op + version-exists gates,
 * single-flight, override.pending write, resetBuiltin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DshRuntimeController } from './dsh-runtime-controller.ts';
import type { ControllerDeps, RuntimeState } from './dsh-runtime-controller.ts';
import type { RegistryMetadata } from './registry-metadata.ts';
import type { OverrideRecord } from './dsh-runtime-store.ts';
import type { ActivationIntentInput } from './dsh-runtime-store.ts';
import type { RuntimeDiskSummary } from './dsh-runtime-store.ts';
import type { InstallResult } from './runtime-installer.ts';

function meta(latest: string | null, versions: string[]): RegistryMetadata {
  const byVersion = new Map<string, { version: string; tarball: string; integrity: string | null }>();
  const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
  for (const v of versions) byVersion.set(v, { version: v, tarball: `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${v}.tgz`, integrity });
  return { packageName: '@deepseek-ai/dsh', origin: 'https://registry.npmjs.org', latest, versions, byVersion };
}

interface Store {
  override: OverrideRecord | null
  pointer: string | null
  trees: string[]
  deleted: boolean
  activationIntent: ActivationIntentInput | null
  activationCleared: boolean
}

function makeStore(): Store {
  return {
    override: null,
    pointer: null,
    trees: [],
    deleted: false,
    activationIntent: null,
    activationCleared: false,
  };
}

function diskSummary(totalBytes: number): RuntimeDiskSummary {
  return {
    versionTrees: 0,
    versionTreeBytes: totalBytes,
    storeBytes: 0,
    cacheBytes: 0,
    installHomeBytes: 0,
    xdgCacheBytes: 0,
    workBytes: 0,
    failureBytes: 0,
    snapshotBytes: 0,
    preRollbackBytes: 0,
    restoreBackupBytes: 0,
    totalBytes,
    storePruneNeeded: false,
  };
}

function makeDeps(store: Store, opts?: { meta?: RegistryMetadata; installResult?: InstallResult; installError?: Error }): ControllerDeps {
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
      validateVersionTree: () => ({ ok: true }),
      deleteOverride: () => { store.deleted = true; store.override = null; },
      clearCurrentPointer: () => { store.pointer = null; },
      writeActivationIntent: (_baseDir, input) => { store.activationIntent = input; },
      clearActivationJournal: () => { store.activationCleared = true; },
    },
    shellVersion: '0.1.4',
  };
}

function makeController(
  store: Store,
  deps?: ReturnType<typeof makeDeps>,
  opts?: {
    bundled?: string | null
    managementSupported?: boolean
    managementUnsupportedReason?: string | null
    logicalDiskLimitBytes?: number
  },
) {
  return new DshRuntimeController({
    baseDir: '/base', bundledVersion: opts?.bundled ?? '0.1.1-rc.2', packageName: '@deepseek-ai/dsh',
    registryOrigin: 'https://registry.npmjs.org', pnpmEntry: '/pnpm/bin/pnpm.cjs',
    managementSupported: opts?.managementSupported,
    managementUnsupportedReason: opts?.managementUnsupportedReason,
    logicalDiskLimitBytes: opts?.logicalDiskLimitBytes,
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
  store.override = { shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: null, swapAttempted: false };
  const c = makeController(store, makeDeps(store, { meta: meta('0.2.0', ['0.2.0']) }), { bundled: '0.1.1-rc.2' });
  const state = await c.check();
  assert.equal(state.phase, 'idle');
});

test('check: active newer than registry latest is not reported as available', async () => {
  const store = makeStore();
  store.pointer = '2.0.0';
  store.override = { shellVersion: '0.1.4', chosenVersion: '2.0.0', resolvedVersion: '2.0.0', pending: null, swapAttempted: false };
  const c = makeController(store, makeDeps(store, { meta: meta('1.9.9', ['1.9.9']) }));
  const state = await c.check();
  assert.equal(state.phase, 'idle');
  assert.equal(state.latest, '1.9.9');
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

test('check: success then offline keeps stale recommendation and unions fresh validated cache', async () => {
  const store = makeStore();
  const deps = makeDeps(store, { meta: meta('0.2.0', ['0.2.0']) });
  const c = makeController(store, deps);
  await c.check();
  store.trees = ['0.1.0']; // absent/yanked from the last successful metadata
  deps.fetchMetadata = async () => { throw new Error('offline'); };
  const state = await c.check();
  assert.equal(state.phase, 'error');
  assert.equal(state.latest, '0.2.0', 'last successful recommendation remains visible');
  assert.equal(state.versions.find((entry) => entry.version === '0.2.0')?.latest, true);
  assert.equal(state.versions.find((entry) => entry.version === '0.1.0')?.cached, true);
});

test('install: selecting active version is a no-op', async () => {
  const store = makeStore();
  store.pointer = '0.2.0';
  store.override = { shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: null, swapAttempted: false };
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

test('install: live progress is projected (download bytes + stages) and clears on completion', async () => {
  const store = makeStore();
  const deps = makeDeps(store, { meta: meta('0.2.0', ['0.2.0']) });
  deps.install = async (opts) => {
    // The renderer must see byte progress mid-download, then the stage
    // milestones, then the terminal 'done' (bar clears). The 200ms gap
    // clears the controller's 150ms push throttle so both byte ticks land.
    opts.onProgress?.({ stage: 'download', received: 512, total: 1024 });
    await new Promise(resolve => setTimeout(resolve, 200));
    opts.onProgress?.({ stage: 'download', received: 1024, total: 1024 });
    opts.onProgress?.({ stage: 'install' });
    opts.onProgress?.({ stage: 'done' });
    return { versionTreeDir: '/rt/0.2.0', resolvedVersion: '0.2.0' };
  };
  const c = makeController(store, deps);
  const states: RuntimeState[] = [];
  const unsubscribe = c.onChanged((state) => states.push(state));
  try {
    await c.check();
    const final = await c.install('0.2.0');
    assert.equal(final.phase, 'pending');
    assert.equal(final.progress, null, 'the bar is cleared once the install commits');
    const downloadPushes = states.filter((s) => s.progress?.stage === 'download');
    assert.ok(downloadPushes.length >= 1, 'download byte progress was projected');
    const lastDownload = downloadPushes.at(-1)?.progress;
    assert.equal(lastDownload?.stage, 'download');
    if (lastDownload?.stage === 'download') {
      assert.equal(lastDownload.received, 1024);
      assert.equal(lastDownload.total, 1024);
    }
    assert.ok(states.some((s) => s.progress?.stage === 'install'), 'the install stage milestone was projected');
  } finally {
    unsubscribe();
  }
});

test('install: logical disk soft limit blocks only a fresh download', async () => {
  const store = makeStore();
  let installCalls = 0;
  const deps = makeDeps(store);
  deps.store.runtimeDiskSummary = () => diskSummary(100);
  deps.install = async () => {
    installCalls += 1;
    return { versionTreeDir: '/x', resolvedVersion: '0.2.0' };
  };
  const c = makeController(store, deps, { logicalDiskLimitBytes: 100 });
  await c.check();
  const state = await c.install('0.2.0');
  assert.equal(installCalls, 0);
  assert.equal(state.phase, 'error');
  assert.equal(state.diskUsage?.totalBytes, 100);
  assert.equal(state.diskLimitBytes, 100);
  assert.equal(state.diskLimitExceeded, true);
  assert.match(state.error ?? '', /软上限|清理/);
});

test('install: cached activation remains available above the logical disk soft limit', async () => {
  const store = makeStore();
  store.trees = ['0.2.0'];
  const deps = makeDeps(store);
  deps.store.runtimeDiskSummary = () => { throw new Error('must not measure cached activation'); };
  deps.install = async () => { throw new Error('must not download cached activation'); };
  const c = makeController(store, deps, { logicalDiskLimitBytes: 1 });
  const state = await c.install('0.2.0');
  assert.equal(state.phase, 'pending');
  assert.equal(state.pending, '0.2.0');
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
  assert.deepEqual(store.activationIntent, {
    targetVersion: '0.2.0',
    manualRollback: false,
    intentKind: 'version-switch',
  });
});

test('install: selecting an older version records a manual rollback intent before pending', async () => {
  const store = makeStore();
  store.pointer = '0.3.0';
  store.override = { shellVersion: '0.1.4', chosenVersion: '0.3.0', resolvedVersion: '0.3.0', pending: null, swapAttempted: false };
  store.trees = ['0.2.0', '0.3.0'];
  const c = makeController(store);
  const state = await c.install('0.2.0');
  assert.equal(state.phase, 'pending');
  assert.deepEqual(store.activationIntent, {
    targetVersion: '0.2.0',
    manualRollback: true,
    intentKind: 'version-switch',
  });
});

test('install: retention validation failure never publishes a pending override', async () => {
  const store = makeStore();
  const deps = makeDeps(store);
  deps.store.recordExplicitInstall = () => { throw new Error('tree became invalid'); };
  const c = makeController(store, deps);
  await c.check();
  const state = await c.install('0.2.0');
  assert.equal(state.phase, 'error');
  assert.equal(store.override, null);
  assert.equal(state.pending, null);
});

test('install: activation intent failure never publishes a pending override', async () => {
  const store = makeStore();
  const deps = makeDeps(store);
  deps.store.writeActivationIntent = () => { throw new Error('activation journal unavailable'); };
  const c = makeController(store, deps);
  await c.check();
  const state = await c.install('0.2.0');
  assert.equal(state.phase, 'error');
  assert.equal(store.override, null);
  assert.equal(state.pending, null);
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

test('resetBuiltin: controller core never bypasses the main-process activation transaction', async () => {
  const store = makeStore();
  const c = makeController(store);
  await c.check();
  await c.install('0.2.0');
  const state = c.resetBuiltin();
  assert.equal(store.deleted, false);
  assert.equal(state.pending, '0.2.0');
  assert.match(state.error ?? '', /事务协调器/);
  assert.equal(store.activationCleared, false);
});

test('install: registry source change after check fails closed and requires a new check', async () => {
  const store = makeStore();
  let origin = 'https://registry.npmjs.org';
  let installs = 0;
  const deps = makeDeps(store);
  deps.install = async () => { installs += 1; return { versionTreeDir: '/x', resolvedVersion: '0.2.0' }; };
  const c = new DshRuntimeController({
    baseDir: '/base', bundledVersion: '0.1.1-rc.2', packageName: '@deepseek-ai/dsh',
    registryOrigin: origin, getRegistryOrigin: () => origin, pnpmEntry: '/pnpm',
    compatibilityBaseline: null, deps,
  });
  await c.check();
  origin = 'https://registry.npmmirror.com';
  const state = await c.install('0.2.0');
  assert.equal(installs, 0);
  assert.equal(state.phase, 'error');
  assert.match(state.error ?? '', /不存在|重新检查/);
});

test('invalid cached tree cannot bypass registry/install verification', async () => {
  const store = makeStore();
  store.trees = ['0.2.0'];
  let installs = 0;
  const deps = makeDeps(store);
  deps.store.validateVersionTree = () => ({ ok: false, error: 'wrong platform' });
  deps.install = async () => { installs += 1; return { versionTreeDir: '/x', resolvedVersion: '0.2.0' }; };
  const c = makeController(store, deps);
  await c.check();
  await c.install('0.2.0');
  assert.equal(installs, 1, 'invalid cache is treated as absent and reinstalled from bound metadata');
});

test('getState: active = current pointer ?? bundled', () => {
  const store = makeStore();
  const c = makeController(store, undefined, { bundled: '0.1.1-rc.2' });
  assert.equal(c.getState().active, '0.1.1-rc.2');
  store.pointer = '0.2.0';
  assert.equal(c.getState().active, '0.1.1-rc.2', 'orphan pointer is ignored without a valid override');
  store.override = { shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: null, swapAttempted: false };
  assert.equal(c.getState().active, '0.2.0');
});

test('getState projects durable shell-invalidation notice after automatic reactivation', () => {
  const store = makeStore();
  store.pointer = '0.2.0';
  store.override = {
    shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: null,
    swapAttempted: false, invalidatedAt: null, invalidatedReason: null,
    lastInvalidatedAt: '2026-08-23T00:00:00.000Z',
    lastInvalidatedReason: 'shell-version-changed',
    lastInvalidatedFromVersion: '0.2.0',
    lastInvalidationRecovered: true,
  };
  const state = makeController(store).getState();
  assert.deepEqual(state.invalidationNotice, {
    at: '2026-08-23T00:00:00.000Z',
    reason: 'shell-version-changed',
    fromVersion: '0.2.0',
    recovered: true,
  });
});

test('env path presence stays authoritative when its manifest version is unreadable', async () => {
  const store = makeStore();
  store.override = { shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: '0.2.0', swapAttempted: false };
  store.pointer = '0.2.0';
  const deps = makeDeps(store);
  const c = new DshRuntimeController({
    baseDir: '/base', bundledVersion: '0.1.1-rc.2', packageName: '@deepseek-ai/dsh',
    registryOrigin: 'https://registry.npmjs.org', pnpmEntry: '/pnpm',
    compatibilityBaseline: null, envOverrideActive: true, envVersion: null, deps,
  });
  const state = c.getState();
  assert.equal(state.source, 'env');
  assert.equal(state.active, null);
  assert.equal(state.pending, null, 'persisted pending is deferred while env outranks it');
  assert.equal((await c.install('0.3.0')).phase, 'error');
  assert.equal(c.resetBuiltin().source, 'env');
  assert.equal(store.deleted, false);
});

test('unsupported runtime management is read-only in controller core', async () => {
  const store = makeStore();
  store.override = { shellVersion: '0.1.4', chosenVersion: '0.2.0', resolvedVersion: '0.2.0', pending: null, swapAttempted: false };
  store.pointer = '0.2.0';
  let metadataCalls = 0;
  let installCalls = 0;
  const deps = makeDeps(store);
  deps.fetchMetadata = async () => { metadataCalls += 1; return meta('0.3.0', ['0.3.0']); };
  deps.install = async () => { installCalls += 1; return { versionTreeDir: '/x', resolvedVersion: '0.3.0' }; };
  const c = makeController(store, deps, {
    managementSupported: false,
    managementUnsupportedReason: 'Windows runtime mutation is deferred',
  });

  assert.equal((await c.check()).phase, 'idle');
  assert.equal((await c.install('0.3.0')).pending, null);
  const state = c.resetBuiltin();
  assert.deepEqual({ metadataCalls, installCalls }, { metadataCalls: 0, installCalls: 0 });
  assert.equal(store.deleted, false);
  assert.equal(store.pointer, '0.2.0');
  assert.equal(state.managementSupported, false);
  assert.equal(state.managementUnsupportedReason, 'Windows runtime mutation is deferred');
});

test('throwing state listeners cannot strand check or install single-flight', async () => {
  const store = makeStore();
  const c = makeController(store);
  const originalError = console.error;
  console.error = () => undefined;
  const dispose = c.onChanged(() => { throw new Error('renderer gone'); });
  try {
    assert.equal((await c.check()).phase, 'available');
    assert.equal((await c.install('0.2.0')).phase, 'pending');
    // Clear the pending fixture and prove the flight was released.
    store.override = null;
    c.setLifecycle({ phase: 'applying' });
    c.setLifecycle({ phase: 'idle' });
    assert.equal((await c.install('0.2.0')).phase, 'pending');
  } finally {
    dispose();
    console.error = originalError;
  }
});

test('setLifecycle rejects an illegal stale edge and its accompanying fields as one patch', async () => {
  const store = makeStore();
  let resolveMetadata!: (value: RegistryMetadata) => void;
  const deps = makeDeps(store);
  deps.fetchMetadata = () => new Promise((resolve) => { resolveMetadata = resolve; });
  const c = makeController(store, deps);
  const checking = c.check();
  assert.equal(c.getState().phase, 'checking');
  const rejected = c.setLifecycle({
    phase: 'rollback',
    error: 'stale rollback',
    restoreOutcome: 'half',
    canRetryRestore: true,
  });
  assert.equal(rejected.phase, 'checking');
  assert.equal(rejected.error, null);
  assert.equal(rejected.restoreOutcome, 'none');
  assert.equal(rejected.canRetryRestore, false);
  resolveMetadata(meta('0.2.0', ['0.2.0']));
  assert.equal((await checking).phase, 'available');
});

test('metadata recovery capability is an explicit category-only lifecycle projection', () => {
  const store = makeStore();
  const c = makeController(store);
  const initial = c.getState();
  assert.equal(initial.metadataHealth, 'unknown');
  assert.deepEqual(initial.metadataComponents, []);
  assert.equal(initial.canRecoverMetadata, false);
  const projected = c.setLifecycle({
    phase: 'failed',
    runtimeBlocked: true,
    metadataHealth: 'selection-corrupt',
    metadataComponents: ['current', 'activation-journal', 'retained-evidence'],
    canRecoverMetadata: true,
  });
  assert.equal(projected.metadataHealth, 'selection-corrupt');
  assert.deepEqual(projected.metadataComponents, ['current', 'activation-journal', 'retained-evidence']);
  assert.equal(projected.canRecoverMetadata, true);
});
