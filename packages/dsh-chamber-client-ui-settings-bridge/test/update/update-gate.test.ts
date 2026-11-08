/**
 * update-gate.ts pure-logic tests (design 11) — node:test, no DOM. Covers the
 *「检查更新」button disable gates, mirrored from the main-process runCheck()
 * phase gates (a re-check must never clobber an in-flight check/download or a
 * completed download), plus the「重启并安装」availability gate, mirrored from
 * updater.restartAndInstall() (restart into the downloaded update — completed
 * download on an installable shape only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betaUpdatesSwitchState, updateCheckDisabled, updateCheckPlatformBlocked, updateRestartAvailable } from '../../src/client/update-gate.ts';
import { classifyBlockedReason, NATIVE_SHELL_BLOCKED_REASON } from '../../src/client/blocked-reason.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('updateCheckDisabled: an explicit check is disabled while a check/download owns the flow', () => {
  assert.equal(updateCheckDisabled('checking'), true);
  assert.equal(updateCheckDisabled('downloading'), true);
  // 原生（Sparkle）安装中也拥有流程——重查绝不把 installing 打回 checking。
  assert.equal(updateCheckDisabled('installing'), true);
});

test('updateCheckDisabled: a completed download is final for this version', () => {
  assert.equal(updateCheckDisabled('downloaded'), true);
});

test('updateCheckDisabled: checkable phases stay enabled', () => {
  assert.equal(updateCheckDisabled(undefined), false);
  assert.equal(updateCheckDisabled('idle'), false);
  assert.equal(updateCheckDisabled('up-to-date'), false);
  assert.equal(updateCheckDisabled('available'), false);
  assert.equal(updateCheckDisabled('error'), false);
});

test('updateCheckPlatformBlocked: linux is blocked, mac-signing is not', () => {
  assert.equal(updateCheckPlatformBlocked('auto-update is not supported on this platform'), true);
  assert.equal(updateCheckPlatformBlocked('missing Developer ID signature'), false);
  assert.equal(updateCheckPlatformBlocked(null), false);
  assert.equal(updateCheckPlatformBlocked(undefined), false);
});

test('updateRestartAvailable: only a completed download on an installable shape offers the restart action', () => {
  assert.equal(updateRestartAvailable('downloaded', null, 'darwin'), true);
  assert.equal(updateRestartAvailable('downloaded', null, 'win32'), true);
  assert.equal(updateRestartAvailable('downloaded', null, undefined), true);
  assert.equal(updateRestartAvailable('downloaded', null, null), true);
});

test('updateRestartAvailable: every non-downloaded phase is not restartable', () => {
  assert.equal(updateRestartAvailable(undefined, null, 'darwin'), false);
  assert.equal(updateRestartAvailable('idle', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('checking', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('up-to-date', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('available', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('downloading', null, 'darwin'), false);
  assert.equal(updateRestartAvailable('error', null, 'darwin'), false);
  // 原生安装中（phase installing）绝不提供第二次「重启并安装」入口。
  assert.equal(updateRestartAvailable('installing', null, 'darwin'), false);
});

test('updateRestartAvailable: a blocked install shape never offers the restart action', () => {
  assert.equal(updateRestartAvailable('downloaded', 'auto-update is not supported on this platform', 'darwin'), false);
  assert.equal(updateRestartAvailable('downloaded', 'missing Developer ID signature', 'darwin'), false);
  assert.equal(updateRestartAvailable('downloaded', 'development build', 'darwin'), false);
  assert.equal(updateRestartAvailable('downloaded', undefined, 'darwin'), false);
});

test('updateRestartAvailable: linux never offers the restart action (AppImage single-instance race, H1)', () => {
  // Even a completed download on an installable linux shape (AppImage) keeps
  // only the quit-install leg — updater.restartAndInstall() refuses linux too.
  assert.equal(updateRestartAvailable('downloaded', null, 'linux'), false);
});

// --- 「接收预览版（beta）更新」开关门（design 11 §3.2 / design 25 §7；v4 = 纯偏好通道） ---

test('betaUpdatesSwitchState: 能力门优先——宿主说不支持时禁用并报 unsupported', () => {
  // 缺字段/宿主事实为假 = 该构建没有可切换的两条通道 feed URL（非原生壳，或构建期未成对注入）。
  assert.deepEqual(
    betaUpdatesSwitchState({ update: null, supported: false }),
    { checked: false, disabled: true, reason: 'unsupported' },
  );
  // 历史推送里已有 beta 通道时 checked 仍只回读相位事实，但纪律仍是禁用。
  assert.deepEqual(
    betaUpdatesSwitchState({ update: { channel: 'beta' }, supported: false }),
    { checked: true, disabled: true, reason: 'unsupported' },
  );
});

test('betaUpdatesSwitchState: 更新面未水合/不可用时禁用并报 unavailable（未知不等于可用）', () => {
  assert.deepEqual(
    betaUpdatesSwitchState({ update: null, supported: true }),
    { checked: false, disabled: true, reason: 'unavailable' },
  );
});

test('betaUpdatesSwitchState: 可用构建上开关 = 壳推送的生效通道（普通开关，默认关）', () => {
  assert.deepEqual(
    betaUpdatesSwitchState({ update: { channel: 'stable' }, supported: true }),
    { checked: false, disabled: false, reason: null },
  );
  assert.deepEqual(
    betaUpdatesSwitchState({ update: { channel: 'beta' }, supported: true }),
    { checked: true, disabled: false, reason: null },
  );
});

test('betaUpdatesSwitchState: v4 纯偏好——纯门不看安装版本后缀（beta 构建也是普通开关）', () => {
  // 契约 v4 删除了「X.Y.Z-beta.N → beta」：门只收 update/supported 两个事实，版本后缀
  // 不再产生特殊态。源码锚：纯门里不得重新出现版本形状/后缀判定或 preview-build 态。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const gate = readFileSync(path.resolve(here, '../../src/client/update-gate.ts'), 'utf8');
  assert.doesNotMatch(gate, /-beta\./, 'update-gate.ts 不得重新引入版本后缀通道判定（v4）');
  assert.doesNotMatch(gate, /preview-build/, 'update-gate.ts 不得保留 preview-build 特殊态（v4）');
});

test('beta 订阅开关：UpdateSection 只做文案映射，决策走纯门，三个词条都被消费', () => {
  // 与「调试模式」行同款结构锚（没有渲染测试框架）：钉住接线与「无死词条 / 无特殊态」，
  // 行为面由上面的真值表覆盖。能力门读的是宿主事实 supported.betaUpdatesSupported。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const updateSection = readFileSync(path.resolve(here, '../../src/client/UpdateSection.tsx'), 'utf8');
  assert.match(updateSection, /status\?\.supported\.betaUpdatesSupported === true/);
  assert.match(updateSection, /betaUpdatesSwitchState\(\{ update, supported \}\)/);
  assert.match(updateSection, /applySettingsPatch\(\{ betaUpdates: next \}\)/);
  assert.match(updateSection, /<BetaUpdatesRow t=\{t\} \/>/);
  assert.doesNotMatch(updateSection, /updateBetaUpdatesPreviewBuild|preview-build/, 'v4 不得保留 beta 构建特殊态');
  for (const key of ['updateBetaUpdatesLabel', 'updateBetaUpdatesDesc', 'updateBetaUpdatesUnsupported']) {
    assert.match(updateSection, new RegExp("t\\('" + key + "'"), key + ' 未被 UpdateSection 消费');
  }
});

test('原生壳 blocked reason：分类、跨包锁步与未知原因诚实透传（2026-09 模块评审 E）', () => {
  // 字面量锁步：desktop 侧 update-headless.ts 的 wire 值必须与本插件逐字一致。
  const here = path.dirname(fileURLToPath(import.meta.url));
  const desktopSource = readFileSync(
    path.resolve(here, '../../../desktop/update-headless.ts'),
    'utf8',
  );
  const match = /NATIVE_SHELL_INSTALL_BLOCKED_REASON = '([^']+)'/.exec(desktopSource);
  assert.ok(match, 'desktop 侧应导出 NATIVE_SHELL_INSTALL_BLOCKED_REASON');
  assert.equal(NATIVE_SHELL_BLOCKED_REASON, match[1], '原生壳 reason 字面量必须跨包锁步');
  assert.equal(NATIVE_SHELL_BLOCKED_REASON, '原生壳不支持自动安装');

  // 分类：两类已知 + 未知兜底（未知绝不套「未配置签名」文案）。
  assert.equal(classifyBlockedReason('原生壳不支持自动安装'), 'native-shell');
  assert.equal(classifyBlockedReason('missing Developer ID signature'), 'mac-signing');
  assert.equal(classifyBlockedReason('some future reason'), 'unknown');
  assert.equal(classifyBlockedReason(null), 'unknown');
  assert.equal(classifyBlockedReason(undefined), 'unknown');

  // 原生壳原因不是「平台不支持自动更新」——检查按钮仍可用（design 25 §7）。
  assert.equal(updateCheckPlatformBlocked('原生壳不支持自动安装'), false);
});

test('S-21：页面更新面零发现——store/section/gate 绝不自跑 GitHub 查询或 fetch', () => {
  // 发现单源在壳侧（native → updateNativeAction kind=check → Sparkle appcast；
  // Electron → electron-updater feed）。页面只消费 dsh-chamber:update-state-changed
  // 推送的相位——这里把「页面不得出现第二条发现腿」钉成回归锁。
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const file of ['update-store.ts', 'update-gate.ts', 'UpdateSection.tsx']) {
    const source = readFileSync(path.resolve(here, '../../src/client', file), 'utf8');
    assert.doesNotMatch(source, /api\.github\.com/, file + ' 不得内嵌 GitHub API 发现（S-21）');
    assert.doesNotMatch(source, /\bfetch\s*\(/, file + ' 不得自己出网发现更新（S-21）');
  }
});