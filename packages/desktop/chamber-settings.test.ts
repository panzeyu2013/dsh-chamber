/**
 * chamber-settings.ts pure-logic tests (design 14 D7) — node:test, no
 * electron. Covers normalize / atomic file round-trip / corrupt preservation /
 * platform gates / close-window decision / quit-risk (update exemption) /
 * patch validation.
 *
 * settings-set → applySettingsPatch 行为族（S-E settings 副作用叶 async 化收口
 * — parity 边界 #2 行为确认）：经 installIpcHandlers 装配注入 fake ctx/edges/
 * registrar，以 fake 副作用叶断言——叶 reject（Swift 异步 leg 失败形态）与叶
 * 同步 throw（Electron 宿主腿形态）同汇于 applySettingsPatch 的 catch 回滚
 * （{error} + keepAwake 反悔 + 绝不持久化 + settings-get 回旧值 + 无 push）；
 * 叶 {ok:false,error}（login-item leg 失败）→ error 原样 loud 返回 + keepAwake
 * 反悔；成功路径 = await 叶后 persist/commit/push 全链。fake ctx 的未注入字段
 * 为 loud stub——误触未装配路径即抛错，绝不静默假通过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CHAMBER_SETTINGS,
  closeToTrayRecoveryAvailable,
  computeQuitRisk,
  computeSupported,
  normalizeSettings,
  readSettingsFile,
  shouldHideToTray,
  validatePatch,
  writeSettingsFile,
  type ChamberSettings,
} from './chamber-settings.ts';
import { installIpcHandlers, type ShellAssemblyCtx } from './shell-core.ts';
import { IPC_CHANNELS } from './ipc-events.ts';

// ---------------------------------------------------------------------------
// S-E settings-set → applySettingsPatch 行为族（fake ctx/edges/registrar 装配；
// 见文件头注记）。installIpcHandlers 全量注册但只 invoke settings 通道——ctx
// 未注入字段为 loud stub（Proxy 缺失键返回调用即抛的 methodStub），误触即红。
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
 * 装配 installIpcHandlers（fake registrar/edges + 可注入副作用叶的 fake ctx）
 * 并返回 settings 通道驱动面。每次调用独立 registrar/记录数组——测试间零共享。
 * persist 默认真实记录（spy）；commit 更新 holder。opts.persist 可覆写
 * （persist 失败路径用例）；opts.initial 可指定起始 holder。
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
    // I 组段装配期订阅（installIpcHandlers 先订阅后 start 契约）：空实现即可
    // （sidecar-ctx 同款装配期空 subscribe）。
    updateController: { subscribe: () => {} },
    // 嵌套解构字段必须存在（installIpcHandlers 顶部解构 sshPluginTargets 的子键）；
    // 空对象 = 子键 undefined——settings 路径不触碰，误触即 loud stub 不可达。
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
    // Swift flavor 形态：async 叶，leg 失败 = rejected promise（与 Electron
    // 同步 throw 同一 applySettingsPatch catch 路径）。
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
  // A well-formed notifications block stays valid (and unknown nested keys
  // remain a forward-compat tolerance, like the top level).
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
  // Top-level boolean keys are part of the file's SHAPE: a wrong type must
  // never be silently re-normalized (corrupt-preserve discipline).
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
