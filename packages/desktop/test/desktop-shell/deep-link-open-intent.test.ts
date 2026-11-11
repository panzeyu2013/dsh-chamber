/**
 * shell-core `dsh-chamber://open` deep link (design 16 §3.1 / §4.2) — the window-raise
 * intent never enters the VS Code launch queue: it calls the装配期快照的
 * edges.focusMainWindow leaf, ignores the link while quitting is in flight, and a
 * missing/failing leaf is loud (never silently dropped). Fake edges/ctx: no window, no
 * Electron, no VS Code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueDeepLink, installIpcHandlers } from '../../shell-core.ts';

/** installIpcHandlers 参数类型（不 export 也可用 Parameters 取得）。 */
type ShellInstallDeps = Parameters<typeof installIpcHandlers>[0];

/** 捕获 console.error 文案（loud 断言）；同步恢复，失败路径不污染其余测试。 */
function captureConsoleErrors(run: () => void | Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  return Promise.resolve()
    .then(run)
    .finally(() => { console.error = original; })
    .then(() => errors);
}

/** 等一轮宏任务：focus 的 `void leaf().catch(...)` 在微任务里落日志。 */
function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

/** 调用即抛的 loud stub（sidecar-ctx 同款；嵌套键返回下一层 stub）。 */
function methodStub(prefix: string): (..._args: never[]) => never {
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
        if (typeof key === 'string') return methodStub(prefix + '.' + key);
        return undefined;
      },
    },
  ) as (..._args: never[]) => never;
}

let focusCalls = 0;
let focusImpl: () => Promise<void> = async () => {};
let quitting = false;

/** 单装配不变式：本文件先跑「未装配」用例，再装配一次（顺序敏感，见用例注释）。 */
function assemble(): void {
  const edges = {
    rendererPush: () => true,
    onSystemResume: () => {},
    onMainWindowShown: () => {},
    showError: () => {},
    focusMainWindow: () => {
      focusCalls += 1;
      return focusImpl();
    },
  } as unknown as ShellInstallDeps['edges'];
  // ctx 形状照 test/local-state/chamber-settings.test.ts 的最小装配（installIpcHandlers
  // 注册期只解构这些键；未列出的键 = loud stub，误触即红）。
  const ctxReal: Record<string, unknown> = {
    hostFacts: {
      flavor: 'swift',
      controlPlaneUrl: 'http://127.0.0.1:1',
      platform: process.platform,
      trayPresent: () => true,
    },
    runtimeFacts: { dshVersion: () => null },
    settingsIO: { current: () => ({}), commit: () => {}, persist: () => {} },
    isQuitting: () => quitting,
    nativeBetaChannelSwitch: false,
    setKeepAwake: async () => {},
    setLoginItem: async () => ({ ok: true }),
    setDebugMode: async () => ({ inspectable: false, apiAvailable: false }),
    updateController: { subscribe: () => {} },
    sshPluginTargets: {},
  };
  const ctx = new Proxy(ctxReal, {
    get(target, key) {
      if (typeof key === 'symbol') return undefined;
      if (key in target) return target[key as string];
      // 未注入字段 = 调用即 loud 的 methodStub（fake ctx 缺键的兜底；注册期只解构不调用）。
      return methodStub(String(key));
    },
  }) as unknown as ShellInstallDeps['ctx'];
  installIpcHandlers({
    ipc: { handle: () => {} },
    edges,
    ctx,
  });
}

test('open 深链在 IPC 装配前到达 → loud 拒绝（绝不静默丢弃）', async () => {
  const errors = await captureConsoleErrors(() => { enqueueDeepLink('dsh-chamber://open'); });
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /focusMainWindow 未装配/);
  assert.equal(focusCalls, 0);
});

test('装配后 open 的两种合法拼写都只调 focusMainWindow 一次（不启动 VS Code）', async () => {
  assemble();
  for (const raw of ['dsh-chamber://open', 'dsh-chamber://open/']) {
    const errors = await captureConsoleErrors(() => { enqueueDeepLink(raw); });
    assert.deepEqual(errors, [], raw);
  }
  assert.equal(focusCalls, 2);
});

test('focusMainWindow 叶 reject → loud（console.error 带原因），绝不留 unhandled rejection', async () => {
  focusImpl = async () => { throw new Error('no window to raise'); };
  const errors = await captureConsoleErrors(async () => {
    enqueueDeepLink('dsh-chamber://open');
    await settle();
  });
  focusImpl = async () => {};
  assert.equal(focusCalls, 3);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /聚焦主窗口失败/);
  assert.match(errors[0] ?? '', /no window to raise/);
});

test('quit 在途 → open 深链整体 ignore（恢复入口的 quit 围栏）', async () => {
  quitting = true;
  const errors = await captureConsoleErrors(() => { enqueueDeepLink('dsh-chamber://open'); });
  quitting = false;
  assert.deepEqual(errors, []);
  assert.equal(focusCalls, 3);
});

test('非法 open 变体 → 落到 VS Code 解析并 loud 拒绝，绝不聚焦窗口', async () => {
  for (const raw of ['dsh-chamber://open/foo', 'dsh-chamber://open?instance=local', 'dsh-chamber://user@open']) {
    const errors = await captureConsoleErrors(() => { enqueueDeepLink(raw); });
    assert.equal(errors.length, 1, raw);
    assert.match(errors[0] ?? '', /深链解析失败/, raw);
  }
  assert.equal(focusCalls, 3);
});

test('open-vscode 深链不触碰 focusMainWindow（两种意图互不串路）', async () => {
  const errors = await captureConsoleErrors(() => {
    enqueueDeepLink('dsh-chamber://open-vscode?instance=local&path=/foo');
  });
  // 装配后 enqueue 会 drain VS Code 队列；fake ctx 缺查表事实 → 失败 loud 但绝不聚焦。
  assert.equal(errors.some((line) => line.includes('聚焦主窗口失败')), false);
  assert.equal(focusCalls, 3);
});
