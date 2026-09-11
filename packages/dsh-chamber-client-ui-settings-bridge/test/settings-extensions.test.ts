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
import { readFileSync } from 'node:fs';
import {
  CAPABILITY_REMOTE_EVENTS,
  CAPABILITY_REMOTE_MOUNT,
  CAPABILITY_REMOTE_STREAM,
  REMOTE_MOUNT_UNAVAILABLE,
  REMOTE_STREAM_UNAVAILABLE,
  RootSeatLedger,
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
  toAssemblyReport,
  type ExtensionSnapshot,
  type FiberLike,
  type PluginContribution,
  type RemoteCapabilityUse,
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

test('descendantFibers: a self-parented chain (cordis root) stays bounded and is not a descendant', () => {
  // Cordis ends every parent chain at a self-parented root (`Fiber.name` walks
  // `do { … } while (fiber !== fiber.parent.fiber)`), so the chain never becomes
  // `undefined`. The unguarded walk therefore spun at 100% of one core and froze
  // the renderer while the settings shell was mounted (2026-09 acceptance).
  const root = fiber(2);
  const looping = fiber(0, { sessions: null }, []);
  looping.parent = { fiber: looping };
  assert.deepEqual(descendantFibers(root, [root, looping]), []);
});

test('descendantFibers: a two-node parent cycle stays bounded and yields no descendants', () => {
  // A malformed graph must be just as bounded as cordis's self-parented root.
  const root = fiber(2);
  const first = fiber(0, { sessions: null }, []);
  const second = fiber(0, { uiConversation: null }, []);
  first.parent = { fiber: second };
  second.parent = { fiber: first };
  assert.deepEqual(descendantFibers(root, [root, first, second]), []);
});

test('descendantFibers: a cycle hanging off a real descendant does not hide that descendant', () => {
  const root = fiber(2);
  const child = fiber(0, { sessions: null }, []);
  child.parent = { fiber: root };
  const looping = fiber(0, { uiConversation: null }, []);
  looping.parent = { fiber: looping };
  assert.deepEqual(descendantFibers(root, [root, child, looping]), [child]);
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
  const decorated = decorateContributions(contributions, new Map([
    [CAPABILITY_REMOTE_EVENTS, new Map([['pushy', new Set(['settings/document-updated'])]])],
  ]));
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

// ── stub-remote capability report (2026-12 review 4a) ─────────────────────

test('the remote placeholders name the channel they cannot provide', () => {
  // The child context has no WS carrier and mounts its plugin set itself, so
  // `$mount`/`$stream` are NAMED placeholders: a plugin that asks for one must
  // get a reason it can act on, never an undefined-is-not-a-function crash.
  assert.match(REMOTE_MOUNT_UNAVAILABLE, /^settings panel has no remote mount channel/);
  assert.match(REMOTE_STREAM_UNAVAILABLE, /^settings panel has no remote stream channel/);
});

test('decorateContributions: each stub-remote capability is stamped on its requester', () => {
  const contributions: PluginContribution[] = [
    { id: 'pushy', state: 'active' },
    { id: 'mounter', state: 'active' },
    { id: 'streamer', state: 'active' },
    { id: 'quiet', state: 'active' },
  ];
  const use: RemoteCapabilityUse = new Map([
    [CAPABILITY_REMOTE_EVENTS, new Map([['pushy', new Set(['settings/document-updated'])]])],
    [CAPABILITY_REMOTE_MOUNT, new Map([['mounter', new Set(['@acme/remote'])]])],
    [CAPABILITY_REMOTE_STREAM, new Map([['streamer', new Set(['/acme/stream'])]])],
  ]);
  const decorated = decorateContributions(contributions, use);
  assert.deepEqual(decorated[0]?.capabilities, [CAPABILITY_REMOTE_EVENTS]);
  assert.deepEqual(decorated[1]?.capabilities, [CAPABILITY_REMOTE_MOUNT]);
  assert.deepEqual(decorated[2]?.capabilities, [CAPABILITY_REMOTE_STREAM]);
  assert.equal(decorated[3]?.capabilities, undefined, 'a plugin that asked for nothing stays unmarked');
});

test('decorateContributions: an attributed-but-empty key set is not a capability use', () => {
  const decorated = decorateContributions(
    [{ id: 'quiet', state: 'active' }],
    new Map([[CAPABILITY_REMOTE_MOUNT, new Map([['quiet', new Set<string>()]])]]),
  );
  assert.equal(decorated[0]?.capabilities, undefined);
});

test('decorateContributions: capability order is the diagnostic display order, not map order', () => {
  const contributions: PluginContribution[] = [{ id: 'both', state: 'active' }];
  const use: RemoteCapabilityUse = new Map([
    [CAPABILITY_REMOTE_STREAM, new Map([['both', new Set(['/s'])]])],
    [CAPABILITY_REMOTE_EVENTS, new Map([['both', new Set(['settings/document-updated'])]])],
  ]);
  assert.deepEqual(
    decorateContributions(contributions, use)[0]?.capabilities,
    [CAPABILITY_REMOTE_EVENTS, CAPABILITY_REMOTE_STREAM],
  );
});

test('extensionNotices: a mount-degraded plugin is reported, never silently swallowed', () => {
  const decorated = decorateContributions(
    [{ id: 'mounter', state: 'active', seats: ['settings.section'] }],
    new Map([[CAPABILITY_REMOTE_MOUNT, new Map([['mounter', new Set(['@acme/remote'])]])]]),
  );
  const notices = extensionNotices(snapshot({ contributions: decorated, total: 1 }));
  assert.deepEqual(notices.map(notice => notice.key), ['noticeCapability']);
  assert.equal(notices[0]?.params?.capability, CAPABILITY_REMOTE_MOUNT);
});

// ── unseated root standard sources (2026-12 review 4b) ────────────────────

test('RootSeatLedger: records every compartment member, attributed to its contributor', () => {
  const ledger = new RootSeatLedger();
  ledger.record('@acme/plugin', {
    hooks: { panelInfo: {} },
    keyedHooks: { resource: () => undefined },
    props: { chamberFileApiBase: '/api/i/local' },
  });
  assert.deepEqual(ledger.entries(), [{
    owner: '@acme/plugin',
    seats: ['root.hooks.panelInfo', 'root.keyedHooks.resource', 'root.props.chamberFileApiBase'],
  }]);
});

test('RootSeatLedger: a non-base contributor becomes one omitted-seat row per unseated seat', () => {
  const ledger = new RootSeatLedger();
  ledger.record('@deepseek-ai/dsh-client-resources', { keyedHooks: { resource: () => undefined } });
  assert.deepEqual(ledger.omittedSeats(id => id === 'base-plugin'), [
    { seat: 'root.keyedHooks.resource', pluginId: '@deepseek-ai/dsh-client-resources', kind: 'root-standard-source' },
  ]);
  assert.deepEqual(ledger.omittedSeats(id => id === '@deepseek-ai/dsh-client-resources'), [],
    'the chamber base set is filtered out exactly like the other omitted-seat rows');
});

test('extensionNotices: an unseated root seat gets its own explicit line', () => {
  const ledger = new RootSeatLedger();
  ledger.record('@deepseek-ai/dsh-client-resources', { keyedHooks: { resource: () => undefined } });
  const notices = extensionNotices(snapshot({
    total: 1,
    contributions: [{ id: '@deepseek-ai/dsh-client-resources', state: 'active', seats: ['settings.section'] }],
    omittedSeats: ledger.omittedSeats(() => false),
  }));
  assert.deepEqual(notices.map(notice => notice.key), ['noticeRootSeat']);
  assert.equal(notices[0]?.params?.plugin, '@deepseek-ai/dsh-client-resources');
  assert.equal(notices[0]?.params?.seat, 'root.keyedHooks.resource');
});

test('extensionNotices: an unrendered SLOT seat keeps its own line (the two are not merged)', () => {
  const notices = extensionNotices(snapshot({
    omittedSeats: [{ seat: 'settings.trigger', pluginId: 'third-party' }],
  }));
  assert.deepEqual(notices.map(notice => notice.key), ['noticeOmittedSeat']);
});

test('RootSeatLedger: repeated contributions from one owner accumulate on that owner', () => {
  const ledger = new RootSeatLedger();
  ledger.record('plugin-a', { hooks: { one: {} } });
  ledger.record('plugin-a', { hooks: { two: {} } });
  assert.deepEqual(ledger.entries(), [{ owner: 'plugin-a', seats: ['root.hooks.one', 'root.hooks.two'] }]);
});

test('RootSeatLedger: an empty or malformed contribution records nothing', () => {
  const ledger = new RootSeatLedger();
  ledger.record('plugin-a', undefined);
  ledger.record('plugin-a', {});
  ledger.record('plugin-a', { hooks: 'not-an-object' });
  ledger.record('plugin-a', { hooks: { ok: {} }, keyedHooks: null });
  assert.deepEqual(ledger.entries(), [{ owner: 'plugin-a', seats: ['root.hooks.ok'] }]);
});

// ── source-text locks for the stub remote and the bridge outlet ───────────

test('the stub remote answers $mount/$stream with the named reason and drops $dispatch', () => {
  const context = code('../src/client/bridge-context.ts');
  assert.ok(context.includes('throw new Error(REMOTE_MOUNT_UNAVAILABLE)'),
    '$mount must fail with the named reason, never resolve to undefined');
  assert.ok(context.includes('throw new Error(REMOTE_STREAM_UNAVAILABLE)'),
    '$stream must fail with the named reason, never return undefined');
  assert.ok(context.includes('$mount(') && context.includes('$stream('),
    'both upstream ClientRemote members must exist as named placeholders');
  // Upstream ClientRemote = TypertClientRemote ($mount/$on) + $stream/$host
  // (vendor/harness-checkout/packages/api/gateway/src/client/index.ts:104-123,
  // packages/typert/protocol/src/types.ts:311-325): `$dispatch` is not part of
  // that face and had no consumer in this repository.
  assert.ok(!context.includes('$dispatch'), 'the never-upstream $dispatch stub must be gone');
  assert.ok(context.includes('readonly $host = { home: undefined, isLoopback: true }'),
    'the fixed host facts stay (they ARE upstream)');
});

test('the child slot registry records root contributions through the PUBLIC provideRoot', () => {
  const context = code('../src/client/bridge-context.ts');
  assert.ok(context.includes('class BridgeSlotRegistry extends SlotRegistry'),
    'the child context must mount the recording registry subclass');
  assert.ok(context.includes('return super.provideRoot(contribution)'),
    'the recording must delegate, never re-implement, provideRoot');
  assert.ok(!context.includes('_rootSource') && !context.includes('hostFace'),
    'the record must not reach for the private root-binding members');
  assert.ok(context.includes('rootSeats'),
    'the ledger must reach the extension phase (the diagnostics rows)');
});

test('the outlet kit seats only hooks it can prove and never the root read face', () => {
  const outlet = code('../src/client/bridge-outlet.tsx');
  for (const seat of ['useSessions: emptyObservableHook', 'useWorkspaces: emptyObservableHook', 'usePanelInfo: panelInfoHook']) {
    assert.ok(outlet.includes(seat), `the kit must keep ${seat}`);
  }
  for (const privateReach of ['keyedHooks', 'provideRoot', 'host.root', 'slots.root', '_rootSource', 'install(']) {
    assert.ok(!outlet.includes(privateReach),
      `the outlet must not consume the root read face (${privateReach}) — it is delivered only to the installed renderer`);
  }
});

test('the extension store notices a capability-only change (the report would else be invisible)', () => {
  const context = code('../src/client/bridge-context.ts');
  assert.ok(/contributionsEqual[\s\S]*capabilities/.test(context),
    'contributionsEqual must compare capabilities, or a mid-session capability request never republishes');
});

/** Read one package source file as text. */
function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

/**
 * Read one package source file with comments removed: these locks must not be
 * satisfiable — or defeated — by prose.
 * @param relative - path relative to this test file.
 * @returns the code text.
 */
function code(relative: string): string {
  const text = source(relative);
  let out = '';
  let quote: string | undefined;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (line) {
      if (ch === '\n') { line = false; out += ch } else out += ' ';
      continue;
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' ';
      continue;
    }
    if (quote !== undefined) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch;
  }
  return out;
}
// ── settings-assembly report (2026-09 relocation to the connections card) ──

test('toAssemblyReport: names its source and carries state/total plus the notice list', () => {
  const report = toAssemblyReport('gateway-office', snapshot({
    total: 2,
    contributions: [
      { id: 'ok-plugin', state: 'active', seats: ['settings.section'] },
      { id: 'broken-plugin', state: 'failed', error: 'boom' },
    ],
  }));
  assert.equal(report.sourceId, 'gateway-office');
  assert.equal(report.total, 2);
  assert.deepEqual(report.notices.map(notice => notice.key), ['noticeFailed']);
  assert.equal(report.notices[0]?.params?.plugin, 'broken-plugin');
  // The report is a pure projection: no extra bookkeeping fields beyond the
  // contract the connections card renders (a stale field would be dead weight).
  assert.deepEqual(Object.keys(report).sort(), ['notices', 'sourceId', 'state', 'total']);
});

test('toAssemblyReport: a settled source with nothing to report stays empty (no invented lines)', () => {
  const report = toAssemblyReport('local', snapshot({ total: 1, contributions: [{ id: 'quiet', state: 'active' }] }));
  assert.deepEqual(report.notices, []);
  assert.equal(report.total, 1);
});

test('toAssemblyReport: the unavailable state carries its reason through the notice params', () => {
  const report = toAssemblyReport('local', snapshot({ state: 'unavailable', reason: 'HTTP 404' }));
  assert.equal(report.state, 'unavailable');
  assert.deepEqual(report.notices, [{ key: 'pluginsUnavailable', params: { error: 'HTTP 404' } }]);
});
