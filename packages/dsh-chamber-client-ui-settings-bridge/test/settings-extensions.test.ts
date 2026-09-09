/**
 * settings-extensions.ts pure-logic tests (2026-12 graph-driven settings
 * surface) — node:test, no DOM, no cordis runtime. Covers the parts whose
 * failure mode is a SILENTLY missing settings section: row projection (covered
 * filter + root-relative URL guard), graph parsing, fiber classification
 * (including nested `ctx.inject` waiters), registrant attribution, namespace
 * normalization, provenance marking and the honest notice projection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_REMOTE_EVENTS,
  classifyContribution,
  contributedSeats,
  decorateContributions,
  dependencyClosureProviders,
  descendantFibers,
  extensionNotices,
  isPluginProvidedRow,
  mergeContributionVerdict,
  missingInjectNames,
  normalizePluginNamespace,
  omittedSeatContributions,
  parseClientGraphRows,
  projectExtensionRows,
  type ExtensionSnapshot,
  type FiberLike,
  type PluginContribution,
} from '../src/client/settings-extensions.ts';

// ── row projection ────────────────────────────────────────────────────────

test('projectExtensionRows: drops covered ids, prefixes the proxy base path, preserves order', () => {
  const rows = projectExtensionRows([
    { id: 'a', url: '/plugins/??a/client.js&rev=1', rev: '1' },
    { id: 'covered', url: '/plugins/??covered/client.js&rev=2', rev: '2' },
    { id: 'b', url: '/plugins/??b/client.js&rev=3', rev: '3' },
  ], ['covered'], '/api/i/local');
  assert.deepEqual(rows.dropped, []);
  assert.deepEqual(rows.rows, [
    { id: 'a', url: '/api/i/local/plugins/??a/client.js&rev=1', rev: '1' },
    { id: 'b', url: '/api/i/local/plugins/??b/client.js&rev=3', rev: '3' },
  ]);
});

test('projectExtensionRows: a non-root-relative bundle url is DROPPED and reported, never loaded', () => {
  const rows = projectExtensionRows([
    { id: 'evil', url: 'https://example.com/x.js', rev: '1' },
    { id: 'proto', url: '//example.com/x.js', rev: '1' },
    { id: 'rel', url: 'plugins/x.js', rev: '1' },
  ], [], '/api/i/local');
  assert.deepEqual(rows.rows, []);
  assert.deepEqual(rows.dropped.map(entry => entry.id), ['evil', 'proto', 'rel']);
  for (const dropped of rows.dropped) assert.match(dropped.reason, /not root-relative/);
});

test('parseClientGraphRows: malformed graph values fail loud (never silently merged)', () => {
  assert.throws(() => parseClientGraphRows(null), /not an object/);
  assert.throws(() => parseClientGraphRows({ entries: 'nope' }), /must be an array/);
  assert.throws(() => parseClientGraphRows({ entries: [42] }), /not an object/);
  assert.throws(() => parseClientGraphRows({ entries: [{ id: 'a', url: '/u', rev: 7 }] }), /string id\/url\/rev/);
  assert.deepEqual(parseClientGraphRows({ entries: [{ id: 'a', url: '/u', rev: 'r', extra: true }] }), [
    { id: 'a', url: '/u', rev: 'r' },
  ]);
});

// ── fiber classification ─────────────────────────────────────────────────

function fiber(state: number, inject: Record<string, unknown> = {}, provided: readonly string[] = []): FiberLike {
  const providedSet = new Set(provided);
  return {
    state,
    inject,
    ctx: { get: (name: string) => (providedSet.has(name) ? {} : undefined) },
  };
}

test('missingInjectNames: reports the declared services the child context does not provide', () => {
  assert.deepEqual(missingInjectNames(fiber(0, { slots: null, sessions: null }, ['slots'])), ['sessions']);
  assert.deepEqual(missingInjectNames(fiber(0, {}, [])), []);
});

test('descendantFibers: finds nested ctx.inject waiters through the parent chain', () => {
  const root = fiber(2);
  const child = fiber(0, { sessions: null }, []);
  child.parent = { fiber: root };
  const grandchild = fiber(0, { uiConversation: null }, []);
  grandchild.parent = { fiber: child };
  const unrelated = fiber(0);
  assert.deepEqual(descendantFibers(root, [root, child, grandchild, unrelated]), [child, grandchild]);
});

test('classifyContribution: active only when the whole fiber tree is active', () => {
  const root = fiber(2);
  assert.deepEqual(classifyContribution('p', root, [root], undefined), { id: 'p', state: 'active' });
});

test('classifyContribution: a nested waiter makes the plugin inactive with the exact missing services', () => {
  const root = fiber(2);
  const nested = fiber(0, { sessions: null, workspaces: null }, []);
  nested.parent = { fiber: root };
  assert.deepEqual(classifyContribution('p', root, [root, nested], undefined), {
    id: 'p',
    state: 'inactive',
    missing: ['sessions', 'workspaces'],
  });
});

test('classifyContribution: an apply rejection or FAILED fiber is a failure (contained, reported)', () => {
  const root = fiber(2);
  assert.deepEqual(classifyContribution('p', root, [root], new Error('boom')), {
    id: 'p',
    state: 'failed',
    error: 'boom',
  });
  assert.equal(classifyContribution('p', fiber(3), [fiber(3)], undefined).state, 'failed');
});

test('classifyContribution: a still-loading fiber without missing services is inactive, not active', () => {
  const loading = fiber(1, { slots: null }, ['slots']);
  assert.deepEqual(classifyContribution('p', loading, [loading], undefined), { id: 'p', state: 'inactive' });
});

// ── attribution ──────────────────────────────────────────────────────────

const ledger = (entries: Record<string, { registrant?: string; id?: string }[]>) => ({
  entries: (key: string) => entries[key] ?? [],
});

test('contributedSeats: attributes seats by the entry registrant stamp', () => {
  const slots = ledger({
    'settings.section': [{ registrant: 'plugin-x', id: 'x-section' }],
    'settings.action': [{ registrant: 'other', id: 'y' }],
    'settings.header': [{ registrant: 'plugin-x' }],
  });
  assert.deepEqual(contributedSeats(slots, 'plugin-x'), ['settings.section', 'settings.header']);
  assert.deepEqual(contributedSeats(slots, 'nobody'), []);
});

test('omittedSeatContributions: reports only third-party entries in unrendered seats', () => {
  const slots = ledger({
    'settings.trigger': [{ registrant: '@deepseek-ai/dsh-client-ui-settings-general' }],
    'settings.header': [{ registrant: '@deepseek-ai/dsh-client-ui-settings-general' }, { registrant: 'plugin-x' }],
    'settings.section': [{ registrant: 'plugin-x' }],
  });
  const isBase = (id: string): boolean => id.startsWith('@deepseek-ai/');
  assert.deepEqual(omittedSeatContributions(slots, isBase), [{ seat: 'settings.header', pluginId: 'plugin-x' }]);
});

// ── namespace normalization ──────────────────────────────────────────────

test('normalizePluginNamespace: apply-object, default class/function, and non-plugin bundles', () => {
  const apply = (): void => {};
  assert.deepEqual(normalizePluginNamespace({ apply, inject: ['slots'] }), {
    plugin: { apply, inject: ['slots'] },
    nameable: true,
  });
  assert.deepEqual(normalizePluginNamespace({ default: apply }), { plugin: apply, nameable: false });
  assert.deepEqual(normalizePluginNamespace({ default: { apply } }), { plugin: { apply }, nameable: true });
  assert.equal(normalizePluginNamespace({ nothing: true }), null);
  assert.equal(normalizePluginNamespace('string'), null);
});

// ── notices + provenance ─────────────────────────────────────────────────

const snapshot = (partial: Partial<ExtensionSnapshot>): ExtensionSnapshot => ({
  state: 'ready',
  total: 0,
  contributions: [],
  omittedSeats: [],
  crashes: [],
  signature: '',
  ...partial,
});

test('extensionNotices: every non-rendering outcome becomes a line (nothing silent)', () => {
  const notices = extensionNotices(snapshot({
    total: 3,
    contributions: [
      { id: 'inactive-plugin', state: 'inactive', missing: ['sessions'] },
      { id: 'failed-plugin', state: 'failed', error: 'boom' },
      { id: 'ok-plugin', state: 'active', seats: ['settings.section'], sharedWith: ['local'] },
    ],
    omittedSeats: [{ seat: 'settings.header', pluginId: 'ok-plugin' }],
    crashes: [{ seat: 'settings.section', pluginId: 'ok-plugin', detail: 'render exploded' }],
  }));
  assert.deepEqual(notices.map(notice => notice.key), [
    'noticeInactive', 'noticeFailed', 'noticeShared', 'noticeOmittedSeat', 'noticeCrash',
  ]);
  assert.equal(notices[0]?.params?.missing, 'sessions');
  assert.equal(notices[1]?.params?.detail, 'boom');
});

test('extensionNotices: an unavailable graph channel is reported with its reason', () => {
  const notices = extensionNotices(snapshot({ state: 'unavailable', reason: 'HTTP 404' }));
  assert.deepEqual(notices, [{ key: 'pluginsUnavailable', params: { error: 'HTTP 404' } }]);
});

test('extensionNotices: a capability-degraded plugin is reported (no silent no-op)', () => {
  const contributions: PluginContribution[] = [
    { id: 'pushy', state: 'active', seats: ['settings.section'] },
  ];
  const decorated = decorateContributions(contributions, new Map([['pushy', new Set(['settings/document-updated'])]]));
  assert.deepEqual(decorated[0]?.capabilities, [CAPABILITY_REMOTE_EVENTS]);
  const notices = extensionNotices(snapshot({ contributions: decorated, total: 1 }));
  assert.deepEqual(notices.map(notice => notice.key), ['noticeCapability']);
});

test('isPluginProvidedRow: only non-base registrants mark a section as plugin-provided', () => {
  const isBase = (id: string): boolean => id === 'base-plugin';
  assert.equal(isPluginProvidedRow({ registrant: 'plugin-x' }, isBase), true);
  assert.equal(isPluginProvidedRow({ registrant: 'base-plugin' }, isBase), false);
  assert.equal(isPluginProvidedRow({}, isBase), false);
});

// ── optional dependency closure (gated) ──────────────────────────────────

test('dependencyClosureProviders: returns covered providers only, once, in first-seen order', () => {
  const rows = [
    { id: 'x', url: '/u', rev: 'r', inject: ['@deepseek-ai/dsh-client-ui-commands', 'uncovered-pkg'] },
    { id: 'y', url: '/u2', rev: 'r', inject: ['@deepseek-ai/dsh-client-ui-commands', '@deepseek-ai/dsh-client-ui-input-trigger'] },
  ];
  const providers = dependencyClosureProviders(rows, [
    '@deepseek-ai/dsh-client-ui-commands',
    '@deepseek-ai/dsh-client-ui-input-trigger',
  ], []);
  assert.deepEqual(providers, ['@deepseek-ai/dsh-client-ui-commands', '@deepseek-ai/dsh-client-ui-input-trigger']);
  assert.deepEqual(dependencyClosureProviders(rows, ['@deepseek-ai/dsh-client-ui-commands'], ['@deepseek-ai/dsh-client-ui-commands']), []);
  assert.deepEqual(dependencyClosureProviders([{ id: 'x', url: '/u', rev: 'r' }], ['a'], []), []);
});

test('projectExtensionRows / parseClientGraphRows: package inject edges are carried through', () => {
  const parsed = parseClientGraphRows({
    entries: [{ id: 'x', url: '/plugins/x.js', rev: 'r', inject: ['a', 'b'], external: ['ignored'] }],
  });
  assert.deepEqual(parsed[0]?.inject, ['a', 'b']);
  const projected = projectExtensionRows(parsed, [], '/api/i/local');
  assert.deepEqual(projected.rows[0]?.inject, ['a', 'b']);
});

test('extensionNotices: provider-only outcomes are silent; the dependent plugin still reports', () => {
  const notices = extensionNotices(snapshot({
    total: 2,
    contributions: [
      { id: 'provider-pkg', state: 'failed', error: 'not a plugin row', role: 'provider' },
      { id: 'dependent', state: 'inactive', missing: ['commandUi'] },
    ],
  }));
  assert.deepEqual(notices.map(notice => notice.key), ['noticeInactive']);
});

test('extensionNotices: a first-load-wins rev conflict is reported, never hidden', () => {
  const notices = extensionNotices(snapshot({
    total: 1,
    contributions: [{ id: 'drifted', state: 'active', seats: ['settings.section'], revConflict: 'version' }],
  }));
  assert.deepEqual(notices.map(notice => notice.key), ['noticeRevConflict']);
  assert.equal(notices[0]?.params?.kind, 'version');
});

test('mergeContributionVerdict: a late activation replaces the stale inactive verdict', () => {
  const previous: PluginContribution = {
    id: 'late', state: 'inactive', missing: ['foo'], seats: [], sharedWith: ['local'], capabilities: [CAPABILITY_REMOTE_EVENTS],
  };
  const merged = mergeContributionVerdict(previous, { id: 'late', state: 'active' }, ['settings.section']);
  assert.deepEqual(merged, {
    id: 'late', state: 'active', seats: ['settings.section'], sharedWith: ['local'], capabilities: [CAPABILITY_REMOTE_EVENTS],
  });
  assert.equal('missing' in merged, false, 'the stale missing-service list is dropped');
});

test('mergeContributionVerdict: a late failure replaces an optimistic active verdict', () => {
  const previous: PluginContribution = { id: 'flaky', state: 'active', seats: ['settings.section'] };
  const merged = mergeContributionVerdict(previous, { id: 'flaky', state: 'failed', error: 'boom' }, []);
  assert.deepEqual(merged, { id: 'flaky', state: 'failed', seats: [], error: 'boom' });
});
