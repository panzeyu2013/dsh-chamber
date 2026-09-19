/**
 * chamber-settings.ts pure-logic tests (design 14 D7) — node:test, no electron.
 * Covers normalize / atomic round-trip / corrupt preservation / platform gates /
 * close-window decision / quit-risk (update exemption) / patch validation.
 *
 * S-E settings-set → applySettingsPatch 行为族（parity 边界 #2）：installIpcHandlers
 * 装配 fake ctx/edges/registrar，叶 reject 与叶同步 throw 同汇于 catch 回滚
 * （{error} + keepAwake 反悔 + 绝不持久化 + settings-get 回旧值 + 无 push），
 * 叶 {ok:false,error} 原样 loud 返回；成功 = await 叶后 persist/commit/push。
 * fake ctx 未注入字段为 loud stub——误触未装配路径即抛错，绝不静默假通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHAMBER_SETTINGS,
  MAX_SETTINGS_FILE_BYTES,
  closeToTrayRecoveryAvailable,
  computeQuitRisk,
  computeSupported,
  decideMainWindowClose,
  launchAtLoginReconcileDecision,
  normalizeSettings,
  readSettingsFile,
  shouldHideToTray,
  shouldUpdaterQuitTakeOver,
  validatePatch,
  verifyLaunchAtLoginReadBack,
  writeSettingsFile,
  type ChamberSettings,
} from '../../chamber-settings.ts';
import { installIpcHandlers, type ShellAssemblyCtx } from '../../shell-core.ts';
import { IPC_CHANNELS } from '../../ipc-events.ts';

// ---------------------------------------------------------------------------
// S-E settings-set → applySettingsPatch 行为族（见文件头注记）。installIpcHandlers
// 全量注册但只 invoke settings 通道；未注入字段为 loud methodStub，误触即红。
// ---------------------------------------------------------------------------

type SettingsSetLeaves = Pick<ShellAssemblyCtx, 'setKeepAwake' | 'setLoginItem'>

/** 注册体装配面（installIpcHandlers 参数类型——不 export 也可用 Parameters）。 */
type SettingsInstallDeps = Parameters<typeof installIpcHandlers>[0]

interface SettingsHarness {
  invoke(channel: string, payload: unknown): Promise<unknown>
  holder(): ChamberSettings
  persistCalls: ChamberSettings[]
  pushes: { channel: string; payload: unknown }[]
  keepAwakeCalls: boolean[]
  loginItemCalls: boolean[]
}

/** methodStub：调用即抛的 loud stub（sidecar-ctx 同款——fake ctx 缺键的兜底）。 */
function settingsMethodStub(prefix: string): (..._args: never[]) => never {
  return new Proxy(
    function stub(): never {
      throw new Error('fake-ctx-unavailable:' + prefix);
    },
    {
      get(target, key) {
        const own = Reflect.get(target, key);
        if (own !== undefined) return own;
        if (key === 'apply' || key === 'bind' || key === 'call') {
          return Function.prototype[key as 'apply' | 'bind' | 'call'];
        }
        if (typeof key === 'string') return settingsMethodStub(prefix + '.' + key);
        return undefined;
      },
    },
  ) as (..._args: never[]) => never;
}

/**
 * 装配 installIpcHandlers（fake registrar/edges + 可注入叶的 fake ctx）并返回
 * settings 通道驱动面；每次调用独立 registrar/记录数组，测试间零共享。
 * persist 默认真实记录（spy），commit 更新 holder；opts 可覆写 persist/initial。
 */
function installSettingsHarness(
  leaves: SettingsSetLeaves,
  opts: { persist?: (next: ChamberSettings) => void; initial?: ChamberSettings } = {},
): SettingsHarness {
  const persistCalls: ChamberSettings[] = [];
  const pushes: { channel: string; payload: unknown }[] = [];
  const keepAwakeCalls: boolean[] = [];
  const loginItemCalls: boolean[] = [];
  let holder: ChamberSettings = { ...(opts.initial ?? DEFAULT_CHAMBER_SETTINGS) };
  const registry = new Map<string, (payload: unknown) => Promise<unknown> | unknown>();
  const persistImpl = opts.persist ?? ((next: ChamberSettings) => { persistCalls.push(next); });
  const harness: SettingsHarness = {
    invoke(channel, payload) {
      const handler = registry.get(channel);
      if (handler === undefined) throw new Error('fake-registrar: unknown channel ' + channel);
      return Promise.resolve(handler(payload));
    },
    holder: () => holder,
    persistCalls,
    pushes,
    keepAwakeCalls,
    loginItemCalls,
  };

  const ctxReal: Record<string, unknown> = {
    hostFacts: {
      flavor: 'electron',
      controlPlaneUrl: 'http://127.0.0.1:1',
      platform: process.platform,
      trayPresent: () => true,
    },
    runtimeFacts: { dshVersion: () => null },
    settingsIO: {
      current: () => holder,
      commit: (next: ChamberSettings) => {
        holder = next;
      },
      persist: persistImpl,
    },
    isQuitting: () => false,
    setKeepAwake: leaves.setKeepAwake,
    setLoginItem: leaves.setLoginItem,
    // 装配期订阅（先订阅后 start 契约）：空实现即可（sidecar-ctx 同款）。
    updateController: { subscribe: () => {} },
    // 嵌套解构的顶层键必须存在（空对象 = 子键 undefined）；settings 路径不触碰。
    sshPluginTargets: {},
  };
  const ctx = new Proxy(ctxReal as object, {
    get(target: Record<string, unknown>, key: string | symbol) {
      if (typeof key === 'symbol') return undefined;
      if (key in target) return target[key];
      return settingsMethodStub(String(key));
    },
  }) as unknown as SettingsInstallDeps['ctx'];

  const edges = {
    rendererPush(channel: string, payload: unknown) {
      pushes.push({ channel, payload });
      return true;
    },
    onSystemResume() {},
    onMainWindowShown() {},
  } as unknown as SettingsInstallDeps['edges'];

  installIpcHandlers({ ipc: { handle: (channel, handler) => registry.set(channel, handler) }, edges, ctx });
  return harness;
}

/** settings-get 结果里的 settings 部分（旧/新值断言用）。 */
function settingsOf(result: unknown): ChamberSettings {
  return (result as { settings: ChamberSettings }).settings;
}
test('S-E settings-set: keep-awake 叶 reject（Swift 异步 leg 失败）→ 回滚 + 绝不持久化 + settings-get 回旧值 + {error}', async () => {
  const harness = installSettingsHarness({
    // Swift flavor 形态：async 叶 reject（与 Electron 同步 throw 同一 catch 路径）。
    setKeepAwake: async (enabled: boolean): Promise<void> => {
      harness.keepAwakeCalls.push(enabled);
      throw new Error('swift-edge-ui-unavailable:setKeepAwake:no-window');
    },
    setLoginItem: async (enabled: boolean) => {
      harness.loginItemCalls.push(enabled);
      return { ok: true as const };
    },
  });
  const resp = await harness.invoke(IPC_CHANNELS.SETTINGS_SET, { patch: { keepAwake: true } });
  assert.deepEqual(resp, { ok: false, error: 'settings apply failed' });
  // 反悔叶被调用（新值应用 + 回滚到旧值）；login-item 未被触碰。
  assert.deepEqual(harness.keepAwakeCalls, [true, false]);
  assert.deepEqual(harness.loginItemCalls, []);
  // 绝不持久化 + holder/查询回旧值 + 失败无 push。
  assert.equal(harness.persistCalls.length, 0);
  assert.equal(settingsOf(await harness.invoke(IPC_CHANNELS.SETTINGS_GET, null)).keepAwake, false);
  assert.equal(harness.pushes.length, 0, '失败路径不得推送 settings-changed');
});
test('S-E settings-set: keep-awake 叶同步 throw（Electron 宿主腿形态）→ 同一回滚路径（await 吸收同步失败）', async () => {
  const harness = installSettingsHarness({
    setKeepAwake: (enabled: boolean): void => {
      harness.keepAwakeCalls.push(enabled);
      throw new Error('powerSaveBlocker start failed');
    },
    setLoginItem: async (enabled: boolean) => {
      harness.loginItemCalls.push(enabled);
      return { ok: true as const };
    },
  });
  const resp = await harness.invoke(IPC_CHANNELS.SETTINGS_SET, { patch: { keepAwake: true } });
  assert.deepEqual(resp, { ok: false, error: 'settings apply failed' });
  assert.deepEqual(harness.keepAwakeCalls, [true, false]);
  assert.equal(harness.persistCalls.length, 0);
  assert.equal(settingsOf(await harness.invoke(IPC_CHANNELS.SETTINGS_GET, null)).keepAwake, false);
});
test('S-E settings-set: login-item 叶 {ok:false,error} → error 原样 loud 返回 + keepAwake 反悔 + 绝不持久化 + 旧值', async () => {
  const harness = installSettingsHarness({
    setKeepAwake: async (enabled: boolean): Promise<void> => {
      harness.keepAwakeCalls.push(enabled);
    },
    setLoginItem: async (enabled: boolean) => {
      harness.loginItemCalls.push(enabled);
      // Swift legs 诚实错误（no-bundle/unavailable/apply-failed）原样进 {error}。
      return { ok: false as const, error: 'swift-edge-ui-unavailable:setLoginItem:no-bundle' };
    },
  });
  const resp = await harness.invoke(IPC_CHANNELS.SETTINGS_SET, {
    patch: { keepAwake: true, launchAtLogin: true },
  });
  // renderer 看到与 Electron applyLaunchAtLogin 失败同形的 {error}（文案源属宿主）。
  assert.deepEqual(resp, { ok: false, error: 'swift-edge-ui-unavailable:setLoginItem:no-bundle' });
  // keepAwake 先应用后反悔；login-item 失败未应用故无反悔调用。
  assert.deepEqual(harness.keepAwakeCalls, [true, false]);
  assert.deepEqual(harness.loginItemCalls, [true]);
  assert.equal(harness.persistCalls.length, 0, '失败绝不持久化');
  const get = await harness.invoke(IPC_CHANNELS.SETTINGS_GET, null);
  assert.equal(settingsOf(get).keepAwake, false);
  assert.equal(settingsOf(get).launchAtLogin, false);
  assert.equal(harness.pushes.length, 0);
});
test('S-E settings-set: 成功路径（async 叶）→ persist 深合并一次 + commit + push + settings-get 新值', async () => {
  const harness = installSettingsHarness({
    setKeepAwake: async (enabled: boolean): Promise<void> => {
      harness.keepAwakeCalls.push(enabled);
    },
    setLoginItem: (enabled: boolean) => {
      harness.loginItemCalls.push(enabled);
      return { ok: true as const };
    },
  });
  const resp = await harness.invoke(IPC_CHANNELS.SETTINGS_SET, {
    patch: { keepAwake: true, launchAtLogin: true },
  });
  assert.equal('error' in (resp as object), false, '成功路径无 error');
  assert.equal(settingsOf(resp).keepAwake, true);
  assert.equal(settingsOf(resp).launchAtLogin, true);
  assert.deepEqual(harness.keepAwakeCalls, [true]);
  assert.deepEqual(harness.loginItemCalls, [true]);
  // persist 恰好一次、载荷为深合并后的完整对象（嵌套默认保留）。
  assert.equal(harness.persistCalls.length, 1);
  assert.equal(harness.persistCalls[0]!.keepAwake, true);
  assert.equal(harness.persistCalls[0]!.launchAtLogin, true);
  assert.deepEqual(harness.persistCalls[0]!.notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  // committed push（settings-changed）+ settings-get 回读新值。
  assert.deepEqual(harness.pushes.map((p) => p.channel), [IPC_CHANNELS.SETTINGS_CHANGED]);
  const get = await harness.invoke(IPC_CHANNELS.SETTINGS_GET, null);
  assert.equal(settingsOf(get).keepAwake, true);
});
test('S-E settings-set: persist 失败 → 已应用副作用 await 反悔 + {error:settings persist failed} + holder 旧值', async () => {
  const harness = installSettingsHarness(
    {
      setKeepAwake: async (enabled: boolean): Promise<void> => {
        harness.keepAwakeCalls.push(enabled);
      },
      setLoginItem: async (enabled: boolean) => {
        harness.loginItemCalls.push(enabled);
        return { ok: true as const };
      },
    },
    { persist: () => { throw new Error('disk full'); } },
  );
  const resp = await harness.invoke(IPC_CHANNELS.SETTINGS_SET, {
    patch: { keepAwake: true, launchAtLogin: true },
  });
  assert.deepEqual(resp, { ok: false, error: 'settings persist failed' });
  // 反悔 await 两叶（keepAwake 反悔 + login-item 反悔）；holder 未被 commit。
  assert.deepEqual(harness.keepAwakeCalls, [true, false]);
  assert.deepEqual(harness.loginItemCalls, [true, false]);
  const get = await harness.invoke(IPC_CHANNELS.SETTINGS_GET, null);
  assert.equal(settingsOf(get).keepAwake, false);
  assert.equal(settingsOf(get).launchAtLogin, false);
  assert.deepEqual(harness.holder(), DEFAULT_CHAMBER_SETTINGS);
});
test('normalizeSettings: defaults for null / non-object', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_CHAMBER_SETTINGS);
  assert.deepEqual(normalizeSettings('nope'), DEFAULT_CHAMBER_SETTINGS);
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_CHAMBER_SETTINGS);
});
test('normalizeSettings: accepts valid fields, rejects bad values, ignores unknown keys', () => {
  const ok = normalizeSettings({ windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true, quitConfirmation: false, vscodeOpenInNewWindow: false, registryOrigin: 'https://registry.npmmirror.com', futureKey: 42 });
  assert.deepEqual(ok, {
    windowCloseBehavior: 'quit', launchAtLogin: true, keepAwake: true, quitConfirmation: false,
    vscodeOpenInNewWindow: false,
    registryOrigin: 'https://registry.npmmirror.com', notifications: DEFAULT_CHAMBER_SETTINGS.notifications,
    sessionTodo: DEFAULT_CHAMBER_SETTINGS.sessionTodo,
  });
  // Bad enum / non-boolean values fall back to defaults silently (normalize is
  // the persistence read path; loud validation lives in validatePatch).
  const bad = normalizeSettings({ windowCloseBehavior: 'minimize', launchAtLogin: 'yes', keepAwake: 1, quitConfirmation: 'yes', vscodeOpenInNewWindow: 'yes' });
  assert.deepEqual(bad, DEFAULT_CHAMBER_SETTINGS);
  assert.equal(normalizeSettings({ registryOrigin: 'https://registry.example/private' }).registryOrigin, DEFAULT_CHAMBER_SETTINGS.registryOrigin);
  assert.equal(normalizeSettings({ registryOrigin: 'https://registry.example/?token=x' }).registryOrigin, DEFAULT_CHAMBER_SETTINGS.registryOrigin);
  // vscodeOpenInNewWindow (design 16 §3.3): 合法布尔保留；缺字段/非法回落默认 true。
  assert.equal(normalizeSettings({ vscodeOpenInNewWindow: false }).vscodeOpenInNewWindow, false);
  assert.equal(normalizeSettings({}).vscodeOpenInNewWindow, true);
  assert.equal(DEFAULT_CHAMBER_SETTINGS.vscodeOpenInNewWindow, true, 'new-window policy defaults ON');
});
test('normalizeSettings: nested notifications — missing/invalid fields fall back to defaults', () => {
  // 缺字段 → 整组默认。
  assert.deepEqual(normalizeSettings({ notifications: {} }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  // 非对象（null/数组/标量）→ 整组默认。
  assert.deepEqual(normalizeSettings({ notifications: null }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  assert.deepEqual(normalizeSettings({ notifications: 'yes' }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  assert.deepEqual(normalizeSettings({ notifications: ['x'] }).notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  // 部分字段 → 缺失用默认；合法字段保留；非法值回落默认。
  const partial = normalizeSettings({ notifications: { enabled: true, mode: 'always', onAsk: false, onComplete: 'yes' } });
  assert.deepEqual(partial.notifications, { enabled: true, mode: 'always', onComplete: true, onAsk: false, onRequest: true, badgeEnabled: true });
  const invalid = normalizeSettings({ notifications: { enabled: 'yes', mode: 'sometimes', onRequest: 1 } });
  assert.deepEqual(invalid.notifications, DEFAULT_CHAMBER_SETTINGS.notifications);
  // 未知嵌套键忽略（前向兼容，persistence 读路径语义同顶层）。
  const unknown = normalizeSettings({ notifications: { enabled: true, futureNested: 42 } });
  assert.deepEqual(unknown.notifications, { enabled: true, mode: 'hidden-only', onComplete: true, onAsk: true, onRequest: true, badgeEnabled: true });
  // badgeEnabled（design 19 §3.7）：合法布尔保留，非法回落默认 true。
  assert.equal(normalizeSettings({ notifications: { badgeEnabled: false } }).notifications.badgeEnabled, false);
  assert.equal(normalizeSettings({ notifications: { badgeEnabled: 'yes' } }).notifications.badgeEnabled, true);
});
test('writeSettingsFile + readSettingsFile round-trip (atomic, 0600)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  const settings = {
    windowCloseBehavior: 'quit' as const,
    launchAtLogin: true,
    keepAwake: true,
    quitConfirmation: false,
    vscodeOpenInNewWindow: false,
    registryOrigin: 'https://registry.npmjs.org',
    notifications: { enabled: true, mode: 'always' as const, onComplete: false, onAsk: true, onRequest: false, badgeEnabled: false },
    sessionTodo: { enabled: false, onComplete: false, onAsk: true, onRequest: false },
  };
  writeSettingsFile(file, settings);
  const read = readSettingsFile(file);
  assert.equal(read.notice, null);
  assert.deepEqual(read.settings, settings);
  const stat = readFileSync(file, 'utf8');
  assert.ok(stat.includes('"quit"'));
  assert.ok(stat.includes('"always"'));
  assert.ok(!existsSync(`${file}.tmp`), 'tmp file cleaned up by rename');
});

test('readSettingsFile: missing file → defaults, no notice', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const read = readSettingsFile(path.join(dir, 'absent.json'));
  assert.equal(read.notice, null);
  assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS);
});

test('readSettingsFile: corrupt file preserved as *.corrupt, defaults + loud notice', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  writeFileSync(file, '{ not json !!!', 'utf8');
  const read = readSettingsFile(file);
  assert.ok(read.notice !== null, 'corrupt read must produce a notice');
  assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS);
  assert.ok(existsSync(`${file}.corrupt`), 'corrupt file preserved');
  assert.ok(!existsSync(file), 'corrupt file moved away');
});
test('readSettingsFile: non-object JSON is corrupt', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-'));
  const file = path.join(dir, 'chamber-settings.json');
  writeFileSync(file, '["not","an","object"]', 'utf8');
  const read = readSettingsFile(file);
  assert.ok(read.notice !== null);
  assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS);
});
test('readSettingsFile: invalid persisted registry trust anchor is preserved as corrupt', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-invalid-registry-'));
  const file = path.join(dir, 'chamber-settings.json');
  try {
    writeFileSync(file, JSON.stringify({ registryOrigin: 'http://private.example/path' }));
    const read = readSettingsFile(file);
    assert.equal(read.settings.registryOrigin, DEFAULT_CHAMBER_SETTINGS.registryOrigin);
    assert.match(read.notice ?? '', /corrupt/);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.corrupt`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readSettingsFile: malformed nested notifications block is preserved as corrupt (review 2026-08)', () => {
  // The notifications sub-block is part of the file's SHAPE: a scalar, an
  // array, or a wrongly-typed field must never be silently re-normalized to
  // defaults (corrupt-preserve discipline, same as registryOrigin).
  const malformed: unknown[] = [
    { notifications: 'enabled' },
    { notifications: ['enabled', true] },
    { notifications: { enabled: true, mode: 'sometimes' } },
    { notifications: { enabled: 'yes', mode: 'always' } },
    { notifications: { enabled: true, mode: 'always', onComplete: 1 } },
    { notifications: { badgeEnabled: 'yes' } },
  ];
  for (const [index, payload] of malformed.entries()) {
    const dir = mkdtempSync(path.join(tmpdir(), `chamber-settings-bad-notifications-${index}-`));
    const file = path.join(dir, 'chamber-settings.json');
    try {
      writeFileSync(file, JSON.stringify(payload));
      const read = readSettingsFile(file);
      assert.match(read.notice ?? '', /corrupt/, `notifications payload #${index} must be corrupt`);
      assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS, `notifications payload #${index} falls back to defaults`);
      assert.equal(existsSync(file), false, `notifications payload #${index} file moved away`);
      assert.equal(existsSync(`${file}.corrupt`), true, `notifications payload #${index} preserved`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // A well-formed block stays valid (unknown nested keys are forward-compat).
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-good-notifications-'));
  const file = path.join(dir, 'chamber-settings.json');
  try {
    writeFileSync(file, JSON.stringify({
      notifications: { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false, futureKey: 'x' },
    }));
    const read = readSettingsFile(file);
    assert.equal(read.notice, null, 'well-formed notifications block reads clean');
    assert.deepEqual(read.settings.notifications, { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: false, badgeEnabled: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('readSettingsFile: wrongly-typed vscodeOpenInNewWindow is preserved as corrupt', () => {
  // Top-level booleans are part of the file's SHAPE: a wrong type is corruption.
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-bad-vscode-open-'));
  const file = path.join(dir, 'chamber-settings.json');
  try {
    writeFileSync(file, JSON.stringify({ vscodeOpenInNewWindow: 'yes' }));
    const read = readSettingsFile(file);
    assert.match(read.notice ?? '', /corrupt/);
    assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.corrupt`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normalizeSettings: nested sessionTodo (sidebar todo area) — missing/invalid fields fall back to defaults', () => {
  // 缺字段 → 整组默认（默认全开：被动呈现，非打扰型通知）。
  assert.deepEqual(normalizeSettings({ sessionTodo: {} }).sessionTodo, DEFAULT_CHAMBER_SETTINGS.sessionTodo);
  // 非对象（null/数组/标量）→ 整组默认。
  assert.deepEqual(normalizeSettings({ sessionTodo: null }).sessionTodo, DEFAULT_CHAMBER_SETTINGS.sessionTodo);
  assert.deepEqual(normalizeSettings({ sessionTodo: 'yes' }).sessionTodo, DEFAULT_CHAMBER_SETTINGS.sessionTodo);
  assert.deepEqual(normalizeSettings({ sessionTodo: ['x'] }).sessionTodo, DEFAULT_CHAMBER_SETTINGS.sessionTodo);
  // 部分字段 → 缺失用默认；合法字段保留；非法值回落默认。
  const partial = normalizeSettings({ sessionTodo: { enabled: false, onAsk: false, onComplete: 'yes' } });
  assert.deepEqual(partial.sessionTodo, { enabled: false, onComplete: true, onAsk: false, onRequest: true });
  const invalid = normalizeSettings({ sessionTodo: { enabled: 'yes', onRequest: 1 } });
  assert.deepEqual(invalid.sessionTodo, DEFAULT_CHAMBER_SETTINGS.sessionTodo);
  // 未知嵌套键忽略（前向兼容，persistence 读路径语义同顶层）。
  const unknown = normalizeSettings({ sessionTodo: { enabled: false, futureNested: 42 } });
  assert.deepEqual(unknown.sessionTodo, { enabled: false, onComplete: true, onAsk: true, onRequest: true });
});

test('readSettingsFile: malformed nested sessionTodo block is preserved as corrupt', () => {
  // Same shape discipline as notifications: a scalar/array/wrongly-typed
  // sub-block is corruption, never silently re-normalized to defaults.
  const malformed: unknown[] = [
    { sessionTodo: 'enabled' },
    { sessionTodo: ['enabled', true] },
    { sessionTodo: { enabled: true, onComplete: 1 } },
    { sessionTodo: { enabled: 'yes' } },
  ];
  for (const [index, payload] of malformed.entries()) {
    const dir = mkdtempSync(path.join(tmpdir(), `chamber-settings-bad-session-todo-${index}-`));
    const file = path.join(dir, 'chamber-settings.json');
    try {
      writeFileSync(file, JSON.stringify(payload));
      const read = readSettingsFile(file);
      assert.match(read.notice ?? '', /corrupt/, `sessionTodo payload #${index} must be corrupt`);
      assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS, `sessionTodo payload #${index} falls back to defaults`);
      assert.equal(existsSync(file), false, `sessionTodo payload #${index} file moved away`);
      assert.equal(existsSync(`${file}.corrupt`), true, `sessionTodo payload #${index} preserved`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // A well-formed sessionTodo block stays valid (unknown nested keys remain a
  // forward-compat tolerance, like the top level).
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-good-session-todo-'));
  const file = path.join(dir, 'chamber-settings.json');
  try {
    writeFileSync(file, JSON.stringify({
      sessionTodo: { enabled: false, onComplete: false, onAsk: true, onRequest: false, futureKey: 'x' },
    }));
    const read = readSettingsFile(file);
    assert.equal(read.notice, null, 'well-formed sessionTodo block reads clean');
    assert.deepEqual(read.settings.sessionTodo, { enabled: false, onComplete: false, onAsk: true, onRequest: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('validatePatch: nested sessionTodo — valid partial patches accepted', () => {
  const full = validatePatch({ sessionTodo: { enabled: false, onComplete: false, onAsk: true, onRequest: false } });
  assert.ok(full.ok);
  if (full.ok) assert.deepEqual(full.patch.sessionTodo, { enabled: false, onComplete: false, onAsk: true, onRequest: false });
  // 部分嵌套字段合法（未提供的字段不落 patch，由 applySettingsPatch deep-merge 兜底）。
  const partial = validatePatch({ sessionTodo: { enabled: false } });
  assert.ok(partial.ok);
  if (partial.ok) assert.deepEqual(partial.patch.sessionTodo, { enabled: false });
  // 顶层合法键 + 嵌套 partial 组合通过（整体采纳）。
  const mixed = validatePatch({ keepAwake: true, sessionTodo: { enabled: false, onAsk: false } });
  assert.ok(mixed.ok);
  if (mixed.ok) assert.deepEqual(mixed.patch, { keepAwake: true, sessionTodo: { enabled: false, onAsk: false } });
  // 空对象也是合法 partial（无操作）。
  const empty = validatePatch({ sessionTodo: {} });
  assert.ok(empty.ok);
});
test('validatePatch: nested sessionTodo — invalid values rejected loudly', () => {
  const notObject = validatePatch({ sessionTodo: 'yes' });
  assert.equal(notObject.ok, false);
  const nullNested = validatePatch({ sessionTodo: null });
  assert.equal(nullNested.ok, false);
  const arrayNested = validatePatch({ sessionTodo: ['enabled'] });
  assert.equal(arrayNested.ok, false);
  const badBool = validatePatch({ sessionTodo: { onComplete: 'yes' } });
  assert.equal(badBool.ok, false);
  const unknownNested = validatePatch({ sessionTodo: { enabled: true, futureNested: 42 } });
  assert.equal(unknownNested.ok, false);
  // 嵌套非法时顶层合法键也不应被采纳（整体失败）。
  const mixedBad = validatePatch({ keepAwake: true, sessionTodo: { enabled: 'yes' } });
  assert.equal(mixedBad.ok, false);
});


// --- P-12: shared strictness (Swift StartupSettings parity) ---
test('P-12: duplicate JSON keys at any nesting level are corruption (both flavors judge the same)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-dup-keys-'))
  const file = path.join(dir, 'chamber-settings.json')
  try {
    const duplicates = [
      '{"keepAwake":true,"keepAwake":false}',
      '{"notifications":{"enabled":true,"enabled":false}}',
      '{"sessionTodo":{"onAsk":true,"onAsk":false}}',
      // Escaped key spelling is the same key (JSON.parse keeps the last).
      '{"keepAwake":true,"\\u006beepAwake":false}',
    ]
    for (const [index, raw] of duplicates.entries()) {
      writeFileSync(file, raw)
      const read = readSettingsFile(file)
      assert.match(read.notice ?? '', /corrupt/, `duplicate-key payload #${index} must be corrupt`)
      assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS)
      assert.equal(existsSync(file), false, `duplicate-key payload #${index} moved away`)
      assert.equal(existsSync(`${file}.corrupt`), true, `duplicate-key payload #${index} preserved`)
    }
    // Distinct keys (including unknown forward-compat keys) still read clean.
    writeFileSync(file, '{"keepAwake":true,"futureKey":1,"notifications":{"enabled":true,"futureNested":1}}')
    const clean = readSettingsFile(file)
    assert.equal(clean.notice, null)
    assert.equal(clean.settings.keepAwake, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('P-12: BOM / NUL encodings and an over-limit size are corruption, never coerced', () => {
  assert.equal(MAX_SETTINGS_FILE_BYTES, 1 << 20, 'the shared bound mirrors the Swift 1 MiB read limit')
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-encoding-'))
  const file = path.join(dir, 'chamber-settings.json')
  try {
    const payloads = [
      '\uFEFF{"keepAwake":true}', // UTF-8 BOM
      '{"keepAwake":true}\u0000', // raw NUL
      // > 1 MiB (the Swift read bound; readPrivateFileNoFollow rejects, no truncation).
      '{"keepAwake":true,"pad":"' + 'x'.repeat(MAX_SETTINGS_FILE_BYTES) + '"}',
    ]
    for (const [index, raw] of payloads.entries()) {
      writeFileSync(file, raw)
      const read = readSettingsFile(file)
      assert.match(read.notice ?? '', /unreadable|corrupt/, `payload #${index} must be refused`)
      assert.deepEqual(read.settings, DEFAULT_CHAMBER_SETTINGS)
      assert.equal(existsSync(file), false, `payload #${index} moved away`)
      assert.equal(existsSync(`${file}.corrupt`), true, `payload #${index} preserved`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('P-12: registry-origin shape set is the strict shared one (Swift mirror)', () => {
  const rejected = [
    'http://registry.example',
    'https://[::1]',
    'https://[::1]:8443',
    'https://user:pass@registry.example',
    'https://registry.example:',
    'https://registry.example:+80',
    'https://registry.example:0',
    'https://registry.example:65536',
    'https://\u0645\u062b\u0627\u0644.example', // RTL host (UTS46 CheckBidi)
    'https://\uE000.example', // private-use host scalar
    'https://\uFF11\uFF12.example', // non-ASCII digits
    'https://exa\\mple.com', // backslash authority
    ' https://registry.example', // stray whitespace WHATWG would trim
    'https://registry.example/private',
    'https://registry.example?token=x',
  ]
  for (const raw of rejected) {
    const patch = validatePatch({ registryOrigin: raw })
    assert.equal(patch.ok, false, `${raw} must be rejected`)
    if (!patch.ok) assert.equal(patch.code, 'invalid-registry-origin')
  }
  const accepted: Array<[string, string]> = [
    ['https://registry.npmjs.org', 'https://registry.npmjs.org'],
    ['https://registry.example:8443', 'https://registry.example:8443'],
    ['https://registry.example:65535', 'https://registry.example:65535'],
    ['HTTPS://REGISTRY.EXAMPLE', 'https://registry.example'],
    // LTR IDN letters stay legal; WHATWG canonicalizes the accepted value.
    ['https://m\u00fcnchen.example', 'https://xn--mnchen-3ya.example'],
  ]
  for (const [raw, canonical] of accepted) {
    const patch = validatePatch({ registryOrigin: raw })
    assert.equal(patch.ok, true, `${raw} must be accepted`)
    if (patch.ok) assert.equal(patch.patch.registryOrigin, canonical)
  }
})
test('P-12: a persisted strict-rejected origin is preserved as corrupt (read path uses the same predicate)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chamber-settings-ipv6-origin-'))
  const file = path.join(dir, 'chamber-settings.json')
  try {
    writeFileSync(file, JSON.stringify({ registryOrigin: 'https://[::1]:8443' }))
    const read = readSettingsFile(file)
    assert.match(read.notice ?? '', /corrupt/)
    assert.equal(read.settings.registryOrigin, DEFAULT_CHAMBER_SETTINGS.registryOrigin)
    assert.equal(existsSync(file), false)
    assert.equal(existsSync(`${file}.corrupt`), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('computeSupported: launchAtLogin on all shipping platforms; closeToTray follows tray availability, always on darwin', () => {
  // design 21 M4: win32 launchAtLogin unlocked (HKCU Run key).
  assert.deepEqual(computeSupported('win32', true), { launchAtLogin: true, closeToTray: true });
  assert.deepEqual(computeSupported('win32', false), { launchAtLogin: true, closeToTray: false });
  assert.deepEqual(computeSupported('darwin', false), { launchAtLogin: true, closeToTray: true });
  assert.deepEqual(computeSupported('linux', true), { launchAtLogin: true, closeToTray: true });
  assert.deepEqual(computeSupported('linux', false), { launchAtLogin: true, closeToTray: false });
});

test('closeToTrayRecoveryAvailable: macOS Dock always recovers; elsewhere the tray is the gate', () => {
  assert.equal(closeToTrayRecoveryAvailable('darwin', false), true, 'macOS Dock icon recovery is always available');
  assert.equal(closeToTrayRecoveryAvailable('darwin', true), true);
  assert.equal(closeToTrayRecoveryAvailable('linux', true), true);
  assert.equal(closeToTrayRecoveryAvailable('linux', false), false, 'no tray on linux → no recovery surface');
  assert.equal(closeToTrayRecoveryAvailable('win32', true), true);
  assert.equal(closeToTrayRecoveryAvailable('win32', false), false);
});

test('shouldHideToTray: needs behavior + recovery surface + no quit in flight', () => {
  assert.equal(shouldHideToTray('hide-to-tray', true, false), true);
  assert.equal(shouldHideToTray('hide-to-tray', false, false), false, 'no recovery surface → never hide');
  assert.equal(shouldHideToTray('hide-to-tray', true, true), false, 'quit in flight → never hide');
  assert.equal(shouldHideToTray('quit', true, false), false);
});

test('shouldHideToTray: an armed update restart never hides (macOS quitAndInstall closes windows first)', () => {
  // macOS: quitAndInstall closes every window BEFORE before-quit runs, so a hide
  // here aborts the install/relaunch and leaves a windowless living process.
  assert.equal(shouldHideToTray('hide-to-tray', true, false, true), false, 'armed restart → the close must reach the window manager');
  assert.equal(shouldHideToTray('hide-to-tray', true, true, true), false);
  assert.equal(shouldHideToTray('hide-to-tray', true, false, false), true, 'not armed → normal hide-to-tray behavior');
  assert.equal(shouldHideToTray('quit', true, false, true), false);
});

test('shouldUpdaterQuitTakeOver: only a released-free, armed leg with the window already gone', () => {
  // The `armNativeUpdaterQuit` fallback (B3): the native macOS leg closes the
  // window and stops without quitting, so the host takes over — ONLY under all
  // three conditions: no quit in flight, arming still held, window already gone.
  assert.equal(shouldUpdaterQuitTakeOver(false, true, false), true, 'armed + window gone + no quit → take over');
  assert.equal(shouldUpdaterQuitTakeOver(true, true, false), false, 'a real quit is in flight → never race the teardown');
  assert.equal(shouldUpdaterQuitTakeOver(false, false, false), false, 'the arming was released → never self-quit');
  assert.equal(shouldUpdaterQuitTakeOver(false, true, true), false, 'the window is still there → the user owns the exit');
  assert.equal(shouldUpdaterQuitTakeOver(true, false, true), false);
});
test('computeQuitRisk: only a running local instance triggers confirm (2026-08: remote tunnels never prompt)', () => {
  const local = computeQuitRisk({ quitConfirmation: true, localRunning: true, updateDownloadReady: false });
  assert.equal(local.needsConfirm, true);
  assert.deepEqual(local.reasons, ['正在运行的本地 dsh 实例']);
  const none = computeQuitRisk({ quitConfirmation: true, localRunning: false, updateDownloadReady: false });
  assert.equal(none.needsConfirm, false);
  assert.deepEqual(none.reasons, []);
});
test('computeQuitRisk: quitConfirmation off never confirms', () => {
  const off = computeQuitRisk({ quitConfirmation: false, localRunning: true, updateDownloadReady: false });
  assert.equal(off.needsConfirm, false);
  assert.deepEqual(off.reasons, []);
});
test('computeQuitRisk: downloaded update exempts confirmation (design 14 D2)', () => {
  const risk = computeQuitRisk({ quitConfirmation: true, localRunning: true, updateDownloadReady: true });
  assert.equal(risk.needsConfirm, false);
  assert.deepEqual(risk.reasons, []);
});
test('validatePatch: rejects unknown keys and bad types loudly', () => {
  const unknown = validatePatch({ nope: true });
  assert.equal(unknown.ok, false);
  const badEnum = validatePatch({ windowCloseBehavior: 'minimize' });
  assert.equal(badEnum.ok, false);
  const badBool = validatePatch({ keepAwake: 'yes' });
  assert.equal(badBool.ok, false);
  const badVscodeBool = validatePatch({ vscodeOpenInNewWindow: 'yes' });
  assert.equal(badVscodeBool.ok, false);
  const notObject = validatePatch('x');
  assert.equal(notObject.ok, false);
});
test('validatePatch: accepts known partial patches', () => {
  const ok = validatePatch({ windowCloseBehavior: 'quit', keepAwake: true, quitConfirmation: false });
  assert.ok(ok.ok);
  if (ok.ok) assert.deepEqual(ok.patch, { windowCloseBehavior: 'quit', keepAwake: true, quitConfirmation: false });
  // vscodeOpenInNewWindow 是通用布尔分支的普通键：单键 partial 可独立上 wire。
  const vscodeOff = validatePatch({ vscodeOpenInNewWindow: false });
  assert.ok(vscodeOff.ok);
  if (vscodeOff.ok) assert.deepEqual(vscodeOff.patch, { vscodeOpenInNewWindow: false });
});
test('validatePatch: nested notifications — valid partial patches accepted', () => {
  const full = validatePatch({ notifications: { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: true } });
  assert.ok(full.ok);
  if (full.ok) assert.deepEqual(full.patch.notifications, { enabled: true, mode: 'always', onComplete: false, onAsk: true, onRequest: true });
  // 部分嵌套字段合法（未提供的字段不落 patch，由 applySettingsPatch deep-merge 兜底）。
  const partial = validatePatch({ notifications: { enabled: true, mode: 'hidden-only' } });
  assert.ok(partial.ok);
  if (partial.ok) assert.deepEqual(partial.patch.notifications, { enabled: true, mode: 'hidden-only' });
  // 空对象也是合法 partial（无操作）。
  const empty = validatePatch({ notifications: {} });
  assert.ok(empty.ok);
});
test('validatePatch: nested notifications — badgeEnabled rides as its own partial key', () => {
  const off = validatePatch({ notifications: { badgeEnabled: false } });
  assert.ok(off.ok);
  if (off.ok) assert.deepEqual(off.patch.notifications, { badgeEnabled: false });
  // 兄弟键不随 patch 上 wire（deep-merge 在主进程）。
  if (off.ok) assert.equal('enabled' in (off.patch.notifications as object), false);
  const bad = validatePatch({ notifications: { badgeEnabled: 'yes' } });
  assert.equal(bad.ok, false);
});
test('validatePatch: nested notifications — invalid values rejected loudly', () => {
  const notObject = validatePatch({ notifications: 'yes' });
  assert.equal(notObject.ok, false);
  const nullNested = validatePatch({ notifications: null });
  assert.equal(nullNested.ok, false);
  const arrayNested = validatePatch({ notifications: ['enabled'] });
  assert.equal(arrayNested.ok, false);
  const badMode = validatePatch({ notifications: { mode: 'sometimes' } });
  assert.equal(badMode.ok, false);
  const badBool = validatePatch({ notifications: { onComplete: 'yes' } });
  assert.equal(badBool.ok, false);
  const unknownNested = validatePatch({ notifications: { enabled: true, futureNested: 42 } });
  assert.equal(unknownNested.ok, false);
  // 嵌套非法时顶层合法键也不应被采纳（整体失败）。
  const mixed = validatePatch({ keepAwake: true, notifications: { mode: 'always' as unknown } });
  assert.ok(mixed.ok, 'mode 合法时整体通过');
  const mixedBad = validatePatch({ keepAwake: true, notifications: { mode: 'sometimes' } });
  assert.equal(mixedBad.ok, false);
});

// ---------------------------------------------------------------------------
// S-08 / S-41 / P-20 纯判定（接线断言见 test/runtime/main-decision-gates.test.ts）。
// ---------------------------------------------------------------------------
test('S-41 readSettingsFile: missing / ok / corrupt are distinguishable for side-effect callers', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-settings-state-'));
  try {
    const missingPath = path.join(dir, 'absent.json');
    const missing = readSettingsFile(missingPath);
    assert.equal(missing.state, 'missing');
    assert.equal(missing.notice, null);
    assert.deepEqual(missing.settings, DEFAULT_CHAMBER_SETTINGS);

    const okPath = path.join(dir, 'ok.json');
    writeFileSync(okPath, JSON.stringify({ launchAtLogin: true, keepAwake: true }));
    const ok = readSettingsFile(okPath);
    assert.equal(ok.state, 'ok');
    assert.equal(ok.notice, null);
    assert.equal(ok.settings.launchAtLogin, true);

    const corruptPath = path.join(dir, 'corrupt.json');
    writeFileSync(corruptPath, 'not-json{');
    const corrupt = readSettingsFile(corruptPath);
    assert.equal(corrupt.state, 'corrupt');
    assert.match(corrupt.notice ?? '', /corrupt/);
    // 默认值只供内存/UI 使用；损坏文件本身仍被保留（loud 处理不变）。
    assert.equal(corrupt.settings.launchAtLogin, false);
    assert.equal(existsSync(corruptPath), false);
    assert.equal(existsSync(`${corruptPath}.corrupt`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('S-41 launchAtLoginReconcileDecision: only a readable file may move the OS login item', () => {
  // ok/missing replay the persisted value (missing = defaults → false, still
  // unregistering a leftover, as Swift StartupSettings does); corrupt never moves it.
  assert.deepEqual(launchAtLoginReconcileDecision('ok', true), { action: 'apply', enabled: true });
  assert.deepEqual(launchAtLoginReconcileDecision('ok', false), { action: 'apply', enabled: false });
  assert.deepEqual(launchAtLoginReconcileDecision('missing', false), { action: 'apply', enabled: false });
  assert.deepEqual(launchAtLoginReconcileDecision('corrupt', false), { action: 'skip', reason: 'corrupt-settings' });
  // Even a hypothetical true never leaks out of a corrupt file: the verdict is
  // a property of the read state, not of the defaulted settings value.
  assert.deepEqual(launchAtLoginReconcileDecision('corrupt', true), { action: 'skip', reason: 'corrupt-settings' });
  assert.deepEqual(launchAtLoginReconcileDecision('missing', true), { action: 'apply', enabled: true });
});

test('S-41 follow-up: the *.corrupt sibling keeps the next launch indeterminate (never a default replay)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-chamber-settings-corrupt-sibling-'));
  try {
    const file = path.join(dir, 'chamber-settings.json');
    // Launch 1 — corrupt is preserved as *.corrupt and reported, so reconcile skips.
    writeFileSync(file, 'not-json{');
    const first = readSettingsFile(file);
    assert.equal(first.state, 'corrupt');
    assert.match(first.notice ?? '', /corrupt/);
    assert.deepEqual(launchAtLoginReconcileDecision(first.state, first.settings.launchAtLogin),
      { action: 'skip', reason: 'corrupt-settings' });
    assert.equal(existsSync(file), false, 'corrupt file moved aside');
    assert.equal(existsSync(`${file}.corrupt`), true, 'corrupt evidence preserved');

    // Launch 2 — the live file is missing but the *.corrupt sibling is durable
    // evidence: decaying to 'missing' would replay the default and UNREGISTER it.
    const second = readSettingsFile(file);
    assert.equal(second.state, 'corrupt', 'sibling evidence must keep the state indeterminate');
    assert.notEqual(second.notice, null, 'the second launch stays loud');
    assert.match(second.notice ?? '', /corrupt/);
    assert.deepEqual(second.settings, DEFAULT_CHAMBER_SETTINGS);
    assert.deepEqual(launchAtLoginReconcileDecision(second.state, second.settings.launchAtLogin),
      { action: 'skip', reason: 'corrupt-settings' });

    // A genuinely missing file WITHOUT corrupt evidence keeps today's
    // semantics: the persisted default (false) is replayed.
    const clean = readSettingsFile(path.join(dir, 'never-written.json'));
    assert.equal(clean.state, 'missing');
    assert.equal(clean.notice, null);
    assert.deepEqual(launchAtLoginReconcileDecision(clean.state, clean.settings.launchAtLogin),
      { action: 'apply', enabled: false });

    // A readable file wins over the stale sibling: the next launch applies it.
    writeSettingsFile(file, { ...DEFAULT_CHAMBER_SETTINGS, launchAtLogin: true });
    const recovered = readSettingsFile(file);
    assert.equal(recovered.state, 'ok');
    assert.equal(recovered.settings.launchAtLogin, true);
    assert.deepEqual(launchAtLoginReconcileDecision(recovered.state, recovered.settings.launchAtLogin),
      { action: 'apply', enabled: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('P-20 verifyLaunchAtLoginReadBack: the OS state decides, never the write call', () => {
  assert.deepEqual(verifyLaunchAtLoginReadBack(true, { openAtLogin: true }, 'darwin'), { ok: true });
  assert.deepEqual(verifyLaunchAtLoginReadBack(false, { openAtLogin: false }, 'win32'), { ok: true });
  // Read-back mismatch (OS silently refused): honest failure naming both values.
  const mismatch = verifyLaunchAtLoginReadBack(true, { openAtLogin: false }, 'darwin');
  assert.equal(mismatch.ok, false);
  if (!mismatch.ok) {
    assert.match(mismatch.error, /requested openAtLogin=true/);
    assert.match(mismatch.error, /observed false/);
  }
  const reverse = verifyLaunchAtLoginReadBack(false, { openAtLogin: true }, 'win32');
  assert.equal(reverse.ok, false);
  // No usable read-back is a failure, never a pass (undefined/null/non-boolean).
  for (const missing of [undefined, null, 'true', 1]) {
    const verdict = verifyLaunchAtLoginReadBack(true, { openAtLogin: missing }, 'darwin');
    assert.equal(verdict.ok, false, `openAtLogin=${String(missing)} must fail the read-back`);
    if (!verdict.ok) assert.match(verdict.error, /read-back unavailable/);
  }
  // macOS 13+ 'requires-approval': registered but not launchable → honest failure.
  const pending = verifyLaunchAtLoginReadBack(true, { openAtLogin: true, status: 'requires-approval' }, 'darwin');
  assert.equal(pending.ok, false);
  if (!pending.ok) assert.match(pending.error, /requires user approval/);
  assert.deepEqual(verifyLaunchAtLoginReadBack(true, { openAtLogin: true, status: 'enabled' }, 'darwin'), { ok: true });
  // The status caveat is darwin-only; a win32 read-back ignores it.
  assert.deepEqual(verifyLaunchAtLoginReadBack(true, { openAtLogin: true, status: 'requires-approval' }, 'win32'), { ok: true });
  // Disabling with 'not-registered' is a clean success, not a pending-approval.
  assert.deepEqual(verifyLaunchAtLoginReadBack(false, { openAtLogin: false, status: 'not-registered' }, 'darwin'), { ok: true });
});

test('S-08 decideMainWindowClose: a close that would quit is deferred until the decision', () => {
  // hide-to-tray with a recovery surface: the only branch that may hide.
  assert.equal(decideMainWindowClose({
    behavior: 'hide-to-tray', recoveryAvailable: true, quitRequested: false, quitConfirmed: false, updateRestartArmed: false }), 'hide');
  // No recovery surface: this close would end in a quit, so the window stays
  // alive for the confirmation dialog (no X-close rebuild/reload).
  assert.equal(decideMainWindowClose({
    behavior: 'hide-to-tray', recoveryAvailable: false, quitRequested: false, quitConfirmed: false, updateRestartArmed: false }), 'defer-quit');
  // close-behavior='quit': defer until confirmed; only a confirmed quit destroys.
  assert.equal(decideMainWindowClose({
    behavior: 'quit', recoveryAvailable: true, quitRequested: false, quitConfirmed: false, updateRestartArmed: false }), 'defer-quit');
  assert.equal(decideMainWindowClose({
    behavior: 'quit', recoveryAvailable: true, quitRequested: false, quitConfirmed: true, updateRestartArmed: false }), 'close');
  // A real quit already in flight (before-quit confirmed it) may close.
  assert.equal(decideMainWindowClose({
    behavior: 'hide-to-tray', recoveryAvailable: true, quitRequested: true, quitConfirmed: true, updateRestartArmed: false }), 'close');
  // Quit requested but unconfirmed (dialog open): keep the window alive (S-08).
  assert.equal(decideMainWindowClose({
    behavior: 'quit', recoveryAvailable: true, quitRequested: true, quitConfirmed: false, updateRestartArmed: false }), 'defer-quit');
  // An armed update restart owns teardown (macOS closes windows before before-quit).
  assert.equal(decideMainWindowClose({
    behavior: 'quit', recoveryAvailable: true, quitRequested: false, quitConfirmed: false, updateRestartArmed: true }), 'close');
  assert.equal(decideMainWindowClose({
    behavior: 'hide-to-tray', recoveryAvailable: true, quitRequested: false, quitConfirmed: false, updateRestartArmed: true }), 'close');
  // Confirmed quit + armed update: still a real close.
  assert.equal(decideMainWindowClose({
    behavior: 'quit', recoveryAvailable: false, quitRequested: true, quitConfirmed: true, updateRestartArmed: true }), 'close');
});