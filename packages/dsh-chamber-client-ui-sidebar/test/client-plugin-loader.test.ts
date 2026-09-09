/**
 * client-plugin-loader.ts tests (2026-12): the page-level union-table
 * bookkeeping shared by the shell boot and the settings panel's per-source
 * child context. The failure modes under test are the ones that would
 * otherwise duplicate a plugin registration on one cordis context, strand a
 * plugin for the page lifetime, or hide a version conflict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BundleLoadTimeoutError,
  cachedSourceClientGraph,
  clientPluginRowLoaded,
  clientPluginRowOwner,
  clientRowSignatures,
  dedupeCoveredRows,
  loadClientPluginRows,
  notePluginMounted,
  notePluginUnmounted,
  publishSourceClientGraph,
  resetClientPluginLoaderState,
  retireSourceClientGraph,
} from '../src/shared/client-plugin-loader.ts';

const row = (id: string, rev = 'r1', url = `/plugins/??${id}/client.js&rev=${rev}`) => ({ id, url, rev });

const collecting = { ordinary: 'defer', timeout: 'collect' } as const;
const bootPass = { ordinary: 'defer', timeout: 'throw' } as const;
const bootRecovery = { ordinary: 'throw', timeout: 'throw' } as const;

test('loadClientPluginRows: each unique combo url loads once; duplicate ids reuse the same execution', async () => {
  resetClientPluginLoaderState();
  const loaded: string[] = [];
  const rows = [
    row('@scope/a'),
    row('@scope/a'),
    row('@scope/b'),
    { id: '@scope/c', url: '/plugins/??@scope/a/client.js,@scope/c/client.js&rev=r1', rev: 'r1' },
  ];
  const outcomes = await loadClientPluginRows('local', rows, {
    loadBundle: async url => { loaded.push(url); },
  }, collecting);
  assert.equal(loaded.length, 3, 'one script per unique url');
  assert.equal(outcomes.filter(outcome => outcome.state === 'loaded').length, 3);
  assert.equal(outcomes.filter(outcome => outcome.state === 'reused').length, 1, 'the duplicate id reuses the same execution');
  // The combo-sharing row is loaded (its factory comes from the shared script).
  assert.equal(outcomes.filter(outcome => outcome.row.id === '@scope/c')[0]?.state, 'loaded');
});

test('loadClientPluginRows: first-load-wins — same id+rev reuses across sources, a different rev reports the conflict kind', async () => {
  resetClientPluginLoaderState();
  const loaded: string[] = [];
  const deps = { loadBundle: async (url: string) => { loaded.push(url); } };
  await loadClientPluginRows('local', [row('@scope/plugin', 'revA')], deps, collecting);
  // Same source, newer rev → restart-required.
  const restart = await loadClientPluginRows('local', [row('@scope/plugin', 'revB')], deps, collecting);
  assert.deepEqual(restart, [{
    state: 'rev-conflict', row: row('@scope/plugin', 'revB'), conflict: 'restart', ownerSourceId: 'local',
  }]);
  // Another source, newer rev → cross-instance version drift.
  const version = await loadClientPluginRows('ssh-b', [row('@scope/plugin', 'revB')], deps, collecting);
  assert.equal(version[0]?.state, 'rev-conflict');
  assert.equal(version[0]?.state === 'rev-conflict' ? version[0].conflict : '', 'version');
  assert.equal(loaded.length, 1, 'the loaded factory is never re-executed');
  assert.equal(clientPluginRowOwner('@scope/plugin'), 'local');
  assert.equal(clientPluginRowLoaded('@scope/plugin'), true);
});

test('loadClientPluginRows: an ordinary failure is deferred in the boot pass, thrown in the recovery pass, and stays retryable', async () => {
  resetClientPluginLoaderState();
  let loads = 0;
  const deps = {
    loadBundle: async () => { loads += 1; throw new Error('bundle exploded'); },
  };
  const deferred = await loadClientPluginRows('local', [row('@scope/fail')], deps, bootPass);
  assert.equal(deferred[0]?.state, 'failed');
  assert.equal(deferred[0]?.state === 'failed' ? deferred[0].timeout : true, false);
  await assert.rejects(
    loadClientPluginRows('local', [row('@scope/fail')], deps, bootRecovery),
    /bundle exploded/,
  );
  assert.equal(loads, 2, 'records were rolled back, so the recovery pass executed again');
});

test('loadClientPluginRows: a timeout tombstones the element — later callers reuse it, and a late success makes it reusable', async () => {
  resetClientPluginLoaderState();
  let loads = 0;
  let settleOutcome!: (loaded: boolean) => void;
  const bundleOutcome = new Promise<boolean>(resolve => { settleOutcome = resolve; });
  const deps = {
    loadBundle: async () => {
      loads += 1;
      throw new BundleLoadTimeoutError('bundle timed out', bundleOutcome);
    },
  };
  const first = await loadClientPluginRows('local', [row('@scope/slow')], deps, collecting);
  assert.equal(first[0]?.state, 'failed');
  assert.equal(first[0]?.state === 'failed' ? first[0].timeout : false, true);
  const second = await loadClientPluginRows('ssh-b', [row('@scope/slow')], deps, collecting);
  assert.equal(second[0]?.state, 'failed');
  assert.equal(loads, 1, 'a second source must reuse the tombstone, not execute another script');
  settleOutcome(true);
  await bundleOutcome;
  await new Promise(resolve => setTimeout(resolve, 0));
  const third = await loadClientPluginRows('local', [row('@scope/slow')], deps, collecting);
  assert.equal(third[0]?.state, 'reused');
  assert.equal(loads, 1);
});

test('loadClientPluginRows: a timeout that later errors becomes retryable', async () => {
  resetClientPluginLoaderState();
  let loads = 0;
  let settleOutcome!: (loaded: boolean) => void;
  const bundleOutcome = new Promise<boolean>(resolve => { settleOutcome = resolve; });
  const deps = {
    loadBundle: async () => {
      loads += 1;
      if (loads === 1) throw new BundleLoadTimeoutError('bundle timed out', bundleOutcome);
    },
  };
  await loadClientPluginRows('local', [row('@scope/late-error')], deps, collecting);
  settleOutcome(false);
  await bundleOutcome;
  await new Promise(resolve => setTimeout(resolve, 0));
  const retry = await loadClientPluginRows('local', [row('@scope/late-error')], deps, collecting);
  assert.equal(retry[0]?.state, 'loaded');
  assert.equal(loads, 2);
});

test('loadClientPluginRows: the boot timeout policy rejects instead of collecting', async () => {
  resetClientPluginLoaderState();
  const deps = {
    loadBundle: async () => {
      throw new BundleLoadTimeoutError('bundle timed out', new Promise<boolean>(() => {}));
    },
  };
  await assert.rejects(
    loadClientPluginRows('local', [row('@scope/boot-timeout')], deps, bootPass),
    /timed out/,
  );
});

test('dedupeCoveredRows: drops covered ids, keeps the rest in order', () => {
  const rows = [row('a'), row('covered'), row('b')];
  assert.deepEqual(dedupeCoveredRows(rows, ['covered']).map(entry => entry.id), ['a', 'b']);
  assert.deepEqual(dedupeCoveredRows(rows, []), rows);
});

test('clientRowSignatures: id set drives rebuilds, rev set reports drift', () => {
  const base = clientRowSignatures([row('a', 'r1'), row('b', 'r2')]);
  const rebuilt = clientRowSignatures([row('a', 'r1'), row('b', 'r9')]);
  const installed = clientRowSignatures([row('a', 'r1'), row('b', 'r2'), row('c', 'r3')]);
  assert.equal(base.idSet, rebuilt.idSet);
  assert.notEqual(base.revSet, rebuilt.revSet);
  assert.notEqual(base.idSet, installed.idSet);
});

test('source graph cache: reuses only the same incarnation and can be retired', () => {
  resetClientPluginLoaderState();
  publishSourceClientGraph('ssh-1', { sourceFingerprint: 'fp-1', rows: [row('a')] });
  assert.deepEqual(cachedSourceClientGraph('ssh-1', 'fp-1')?.rows.map(entry => entry.id), ['a']);
  assert.equal(cachedSourceClientGraph('ssh-1', 'fp-2'), undefined, 'a replaced incarnation never serves old rows');
  assert.equal(cachedSourceClientGraph('ssh-2', 'fp-1'), undefined);
  retireSourceClientGraph('ssh-1');
  assert.equal(cachedSourceClientGraph('ssh-1', 'fp-1'), undefined);
});

test('cross-source mount facts: the second source learns it shares the module instance', () => {
  resetClientPluginLoaderState();
  assert.deepEqual(notePluginMounted('@scope/shared', 'local'), []);
  assert.deepEqual(notePluginMounted('@scope/shared', 'ssh-b'), ['local']);
  assert.deepEqual(notePluginMounted('@scope/shared', 'ssh-b'), ['local'], 'idempotent per source');
  notePluginUnmounted('@scope/shared', 'local');
  assert.deepEqual(notePluginMounted('@scope/shared', 'ssh-c'), ['ssh-b']);
  notePluginUnmounted('@scope/shared', 'ssh-b');
  notePluginUnmounted('@scope/shared', 'ssh-c');
  assert.deepEqual(notePluginMounted('@scope/shared', 'local'), []);
});
