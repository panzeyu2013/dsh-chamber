/**
 * client-plugin-loader.ts tests: the page-level union-table bookkeeping driven by the shell boot.
 * The failure modes under test are the ones that would otherwise duplicate a plugin registration on one
 * cordis context, strand a plugin for the page lifetime, or hide a version conflict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BundleLoadTimeoutError, clientPluginRowClaim, clientPluginRowOwner,
  dedupeCoveredRows, loadClientPluginRows, scanClientPluginRowConflicts,
} from '@dsh-chamber/dsh-chamber-client-core/client-plugin-loader';
import { resetClientPluginLoaderState } from '../../../dsh-chamber-client-core/src/client-plugin-loader.ts';
import { resetHttpBudgetForTests } from '../../../dsh-chamber-client-core/src/http-budget.ts';

const row = (id: string, rev = 'r1', url = `/plugins/??${id}/client.js&rev=${rev}`) => ({ id, url, rev });

const collecting = { ordinary: 'defer', timeout: 'collect' } as const;
const bootPass = { ordinary: 'defer', timeout: 'throw' } as const;
const bootRecovery = { ordinary: 'throw', timeout: 'throw' } as const;

test('loadClientPluginRows: each unique combo url loads once; duplicate ids reuse the same execution', async () => {
  resetClientPluginLoaderState();
  const loaded: string[] = [];
  const rows = [row('@scope/a'), row('@scope/a'), row('@scope/b'),
    { id: '@scope/c', url: '/plugins/??@scope/a/client.js,@scope/c/client.js&rev=r1', rev: 'r1' }];
  const outcomes = await loadClientPluginRows('local', rows, { loadBundle: async url => { loaded.push(url); } }, collecting);
  assert.equal(loaded.length, 3, 'one script per unique url');
  assert.equal(outcomes.filter(outcome => outcome.state === 'loaded').length, 3);
  assert.equal(outcomes.filter(outcome => outcome.state === 'reused').length, 1, 'the duplicate id reuses the same execution');
  // The combo-sharing row is loaded (its factory comes from the shared script).
  assert.equal(outcomes.filter(outcome => outcome.row.id === '@scope/c')[0]?.state, 'loaded');
});

test('loadClientPluginRows: a wide pass is bounded by bundleMax, never refused by queue depth', async () => {
  resetClientPluginLoaderState();
  resetHttpBudgetForTests();
  const loaded: string[] = [];
  let inflight = 0;
  let peak = 0;
  const rows = Array.from({ length: 11 }, (_, index) => row(`@scope/wide-${index}`));
  try {
    const outcomes = await loadClientPluginRows('ssh-wide', rows, {
      loadBundle: async (url: string) => {
        loaded.push(url);
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inflight -= 1;
      },
    }, collecting);
    assert.equal(loaded.length, 11, 'every unique bundle dispatches in the default configuration');
    assert.ok(peak <= 2, 'bundleMax caps the kernel load wave (peak=' + String(peak) + ')');
    assert.equal(outcomes.filter(outcome => outcome.state === 'failed').length, 0);
  } finally {
    resetHttpBudgetForTests();
  }
});

test('loadClientPluginRows: first-load-wins — same id+rev reuses across sources, a different rev reports the conflict kind', async () => {
  resetClientPluginLoaderState();
  const loaded: string[] = [];
  const deps = { loadBundle: async (url: string) => { loaded.push(url); } };
  await loadClientPluginRows('local', [row('@scope/plugin', 'revA')], deps, collecting);
  // Same source, newer rev → restart-required.
  const restart = await loadClientPluginRows('local', [row('@scope/plugin', 'revB')], deps, collecting);
  assert.deepEqual(restart, [{ state: 'rev-conflict', row: row('@scope/plugin', 'revB'), conflict: 'restart', ownerSourceId: 'local' }]);
  // Another source, newer rev → cross-instance bundle-rev drift.
  const version = await loadClientPluginRows('ssh-b', [row('@scope/plugin', 'revB')], deps, collecting);
  assert.equal(version[0]?.state, 'rev-conflict');
  assert.equal(version[0]?.state === 'rev-conflict' ? version[0].conflict : '', 'version');
  assert.equal(loaded.length, 1, 'the loaded factory is never re-executed');
  assert.equal(clientPluginRowOwner('@scope/plugin'), 'local');
});

test('loadClientPluginRows: a same-release release-published id shares the foreign factory without loading', async () => {
  resetClientPluginLoaderState();
  const id = '@deepseek-ai/dsh-client-ui-open-in-app';
  const loaded: string[] = [];
  const deps = { loadBundle: async (url: string) => { loaded.push(url); } };
  await loadClientPluginRows('local', [row(id, 'revA')], deps, { ...collecting, releaseVersion: '0.2.1-rc.2' });
  const shared = await loadClientPluginRows('ssh-b', [row(id, 'revB')], deps, {
    ...collecting, releaseVersion: '0.2.1-rc.2',
  });
  assert.deepEqual(shared, [{ state: 'shared', row: row(id, 'revB'), ownerSourceId: 'local' }]);
  assert.equal(loaded.length, 1, 'the owner factory is never re-executed');
  assert.deepEqual(clientPluginRowClaim(id), {
    rev: 'revA',
    url: `/plugins/??${id}/client.js&rev=revA`,
    ownerSourceId: 'local',
    releaseVersion: '0.2.1-rc.2',
  });
  // A different host release, or an unknown one, stays fail-closed.
  const different = await loadClientPluginRows('ssh-b', [row(id, 'revB')], deps, {
    ...collecting, releaseVersion: '0.2.0-rc.2',
  });
  assert.equal(different[0]?.state, 'rev-conflict');
  const unknown = await loadClientPluginRows('ssh-b', [row(id, 'revB')], deps, collecting);
  assert.equal(unknown[0]?.state, 'rev-conflict');
});

test('loadClientPluginRows: sharedRevisions lets a caller-verified profile row share the factory, at that rev only', async () => {
  resetClientPluginLoaderState();
  const id = '@scope/verified-profile';
  let loads = 0;
  const deps = { loadBundle: async () => { loads += 1; } };
  await loadClientPluginRows('local', [row(id, 'revA')], deps, collecting);
  const approved = new Map([[id, 'revB']]);
  const shared = await loadClientPluginRows('ssh-b', [row(id, 'revB')], deps, {
    ...collecting, sharedRevisions: approved,
  });
  assert.deepEqual(shared, [{ state: 'shared', row: row(id, 'revB'), ownerSourceId: 'local' }]);
  assert.equal(loads, 1);
  // The approval is bound to the verified REV: another build of the same id is a conflict.
  const otherBuild = await loadClientPluginRows('ssh-b', [row(id, 'revC')], deps, {
    ...collecting, sharedRevisions: approved,
  });
  assert.equal(otherBuild[0]?.state, 'rev-conflict');
  // Without the approval the same foreign call is a conflict.
  const conflict = await loadClientPluginRows('ssh-b', [row(id, 'revB')], deps, collecting);
  assert.equal(conflict[0]?.state, 'rev-conflict');
  // The approval is about FOREIGN rows only: the owner's own rebuilt row still restarts.
  const restart = await loadClientPluginRows('local', [row(id, 'revB')], deps, {
    ...collecting, sharedRevisions: approved,
  });
  assert.equal(restart[0]?.state, 'rev-conflict');
});

test('loadClientPluginRows: a shared row awaits the owner execution and surfaces its failure', async () => {
  resetClientPluginLoaderState();
  const id = '@deepseek-ai/dsh-client-ui-sample';
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_resolve, reject) => { fail = reject; });
  const owner = loadClientPluginRows('local', [row(id, 'revA')], { loadBundle: () => pending }, {
    ordinary: 'throw', timeout: 'throw', releaseVersion: '0.2.1-rc.2',
  });
  // The claim is published synchronously before the owner's execution settles.
  const shared = loadClientPluginRows('ssh-b', [row(id, 'revB')], { loadBundle: async () => {} }, {
    ...collecting, releaseVersion: '0.2.1-rc.2',
  });
  // A recovery pass keeps the throw policy: the owner's failure is surfaced loud.
  const strict = loadClientPluginRows('ssh-c', [row(id, 'revB')], { loadBundle: async () => {} }, {
    ordinary: 'throw', timeout: 'throw', releaseVersion: '0.2.1-rc.2',
  });
  fail(new Error('owner bundle exploded'));
  await assert.rejects(owner, /owner bundle exploded/);
  // The boot pass DEFERS an ordinary owner failure: the owner's claim is rolled back and
  // this caller can load its own build on the recovery pass — another instance's
  // transient failure must not fail this boot.
  const collected = await shared;
  assert.equal(collected[0]?.state, 'failed');
  await assert.rejects(strict, /owner bundle exploded/);
});

test('loadClientPluginRows: reuseForeignBuilds shares any foreign build, awaits the owner, and never restarts the owner', async () => {
  resetClientPluginLoaderState();
  const id = '@deepseek-ai/dsh-client-ui-sample';
  let loads = 0;
  const deps = { loadBundle: async () => { loads += 1; } };
  await loadClientPluginRows('local', [row(id, 'revA')], deps, collecting);
  // The boot policy accepts the foreign build (the page keeps ONE factory per id), so the
  // kernel takes the shared branch instead of reporting a conflict — at ANY rev, without
  // reading or executing the foreign bundle.
  const shared = await loadClientPluginRows('ssh-b', [row(id, 'revB')], deps, {
    ...collecting, reuseForeignBuilds: true,
  });
  assert.deepEqual(shared, [{ state: 'shared', row: row(id, 'revB'), ownerSourceId: 'local' }]);
  assert.equal(loads, 1, 'the foreign build is never loaded');
  // The policy is about FOREIGN rows only: the owner's own rebuilt row still restarts.
  const restart = await loadClientPluginRows('local', [row(id, 'revB')], deps, {
    ...collecting, reuseForeignBuilds: true,
  });
  assert.equal(restart[0]?.state, 'rev-conflict');
  assert.equal(restart[0]?.state === 'rev-conflict' ? restart[0].conflict : '', 'restart');
});

test('scanClientPluginRowConflicts: same-release release-published ids are not conflicts', async () => {
  resetClientPluginLoaderState();
  const id = '@deepseek-ai/dsh-client-ui-sample';
  await loadClientPluginRows('local', [row(id, 'revA')], { loadBundle: async () => {} }, {
    ...collecting, releaseVersion: '0.2.1-rc.2',
  });
  assert.deepEqual(scanClientPluginRowConflicts('ssh-b', [row(id, 'revB')], '0.2.1-rc.2'), []);
  assert.equal(scanClientPluginRowConflicts('ssh-b', [row(id, 'revB')], '0.2.0-rc.2').length, 1);
  // Same-instance conflicts are never released by a matching release.
  assert.equal(scanClientPluginRowConflicts('local', [row(id, 'revB')], '0.2.1-rc.2').length, 1);
});

test('loadClientPluginRows: an ordinary failure is deferred in the boot pass, thrown in the recovery pass, and stays retryable', async () => {
  resetClientPluginLoaderState();
  let loads = 0;
  const deps = { loadBundle: async () => { loads += 1; throw new Error('bundle exploded'); } };
  const deferred = await loadClientPluginRows('local', [row('@scope/fail')], deps, bootPass);
  assert.equal(deferred[0]?.state, 'failed');
  assert.equal(deferred[0]?.state === 'failed' ? deferred[0].timeout : true, false);
  await assert.rejects(loadClientPluginRows('local', [row('@scope/fail')], deps, bootRecovery), /bundle exploded/);
  assert.equal(loads, 2, 'records were rolled back, so the recovery pass executed again');
});

test('loadClientPluginRows: a timeout tombstones the element — later callers reuse it, and a late success makes it reusable', async () => {
  resetClientPluginLoaderState();
  let loads = 0;
  let settleOutcome!: (loaded: boolean) => void;
  const bundleOutcome = new Promise<boolean>(resolve => { settleOutcome = resolve; });
  const deps = { loadBundle: async () => { loads += 1; throw new BundleLoadTimeoutError('bundle timed out', bundleOutcome); } };
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
    loadBundle: async () => { loads += 1; if (loads === 1) throw new BundleLoadTimeoutError('bundle timed out', bundleOutcome); },
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
    loadBundle: async () => { throw new BundleLoadTimeoutError('bundle timed out', new Promise<boolean>(() => {})); },
  };
  await assert.rejects(loadClientPluginRows('local', [row('@scope/boot-timeout')], deps, bootPass), /timed out/);
});

test('dedupeCoveredRows: drops covered ids, keeps the rest in order', () => {
  const rows = [row('a'), row('covered'), row('b')];
  assert.deepEqual(dedupeCoveredRows(rows, ['covered']).map(entry => entry.id), ['a', 'b']);
  assert.deepEqual(dedupeCoveredRows(rows, []), rows);
});
