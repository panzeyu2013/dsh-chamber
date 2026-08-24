/**
 * activation-gate.ts 纯逻辑测试（design 18 §3.4 激活门控裁决）——node:test，
 * 无 electron、无副作用。覆盖：decideVerdict 全 ok → pass / 窗口内首次 fail →
 * observe / 窗口外 fail → fail / observe 后仍 fail → fail（延迟裁决后再失败
 * 才回退）/ 窗口边界与自定义窗口 / 观察一次后恢复 → pass；rollbackTarget 四
 * 分支（previous known-good / previous 非 known-good 但有 known-good / 都无 →
 * null / previous === known-good）；shouldAutoRollback 四态（restart-exhausted
 * × active-is-override）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PROBE_WINDOW_MS,
  REQUIRED_ACTIVATION_PROBES,
  decideVerdict,
  rollbackTarget,
  shouldAutoRollback,
} from './activation-gate.ts';

const ok = (name: string): { name: string; ok: boolean } => ({ name, ok: true });
const allOk = () => REQUIRED_ACTIVATION_PROBES.map(ok);
const withFailure = (name: string) => allOk().map(probe => (
  probe.name === name ? { ...probe, ok: false, error: 'failed' } : probe
));

test('decideVerdict: 全部探针 ok → pass（含多探针；error 字段不影响裁决）', () => {
  const probes = allOk();
  assert.equal(decideVerdict(probes, { elapsedMs: 5_000 }), 'pass');
  // observedOnce 只在「仍失败」时生效；探针已恢复 → pass
  assert.equal(decideVerdict(probes, { elapsedMs: 5_000, observedOnce: true }), 'pass');
});

test('decideVerdict: 空或不完整探针列表绝不空真', () => {
  assert.equal(decideVerdict([], { elapsedMs: 0 }), 'observe');
  assert.equal(decideVerdict([], { elapsedMs: 0, observedOnce: true }), 'fail');
  assert.equal(decideVerdict([ok('host.describe')], { elapsedMs: 0 }), 'observe');
});

test('decideVerdict: 窗口内首次失败 → observe（超时不立即判失败，给慢迁移二次确认窗口）', () => {
  const probes = withFailure('commands.execute');
  assert.equal(decideVerdict(probes, { elapsedMs: 5_000 }), 'observe');
  // 窗口边界内（elapsed === windowMs）仍 observe
  assert.equal(decideVerdict(probes, { elapsedMs: DEFAULT_PROBE_WINDOW_MS }), 'observe');
});

test('decideVerdict: 窗口外首次失败 → observe（§3.4 超时不立即判失败，慢迁移二次确认）', () => {
  const probes = withFailure('session.list');
  assert.equal(decideVerdict(probes, { elapsedMs: DEFAULT_PROBE_WINDOW_MS + 1 }), 'observe');
  assert.equal(decideVerdict(probes, { elapsedMs: 120_000 }), 'observe');
});

test('decideVerdict: 已 observe 过一次仍 fail → fail（延迟裁决后再失败才回退）', () => {
  const probes = withFailure('clientGraph/graph');
  // 窗口内第二次仍失败：observe 只给一次二次确认窗口
  assert.equal(decideVerdict(probes, { elapsedMs: 5_000, observedOnce: true }), 'fail');
  // 窗口外第二次仍失败：同样 fail
  assert.equal(decideVerdict(probes, { elapsedMs: 120_000, observedOnce: true }), 'fail');
});

test('decideVerdict: windowMs 是硬上限，超窗成功也需二次观察', () => {
  const probes = withFailure('gitWorktree/previewCreate');
  assert.equal(decideVerdict(probes, { elapsedMs: 500, windowMs: 1_000 }), 'observe');
  assert.equal(decideVerdict(probes, { elapsedMs: 1_001, windowMs: 1_000 }), 'observe');
  assert.equal(decideVerdict(probes, { elapsedMs: 10_000, windowMs: 5_000 }), 'observe');
  assert.equal(decideVerdict(allOk(), { elapsedMs: 1_001, windowMs: 1_000 }), 'observe');
  assert.equal(decideVerdict(allOk(), { elapsedMs: 1_001, windowMs: 1_000, observedOnce: true }), 'fail');
});

test('decideVerdict: 混合探针（部分 ok 部分 fail）按任一 fail 裁决', () => {
  const probes = withFailure('settings.describe');
  assert.equal(decideVerdict(probes, { elapsedMs: 3_000 }), 'observe');
  assert.equal(decideVerdict(probes, { elapsedMs: 90_000 }), 'observe');
  assert.equal(decideVerdict(probes, { elapsedMs: 3_000, observedOnce: true }), 'fail');
});

test('decideVerdict: duplicate or unexpected names fail closed', () => {
  const duplicate = allOk();
  duplicate[duplicate.length - 1] = ok('host.describe');
  assert.equal(decideVerdict(duplicate, { elapsedMs: 1 }), 'observe');
  assert.equal(decideVerdict(duplicate, { elapsedMs: 1, observedOnce: true }), 'fail');
});

test('rollbackTarget: previous known-good（曾探针通过或 known-good）→ 切换前版本', () => {
  assert.equal(
    rollbackTarget({ previousVersion: '0.1.1-rc.2', previousWasKnownGood: true, knownGoodVersion: '0.1.1' }),
    '0.1.1-rc.2',
  );
  // knownGoodVersion 与 previous 相同也算 previous 可信任
  assert.equal(
    rollbackTarget({ previousVersion: '0.1.1', previousWasKnownGood: true, knownGoodVersion: '0.1.1' }),
    '0.1.1',
  );
});

test('rollbackTarget: previous 非 known-good 但有 known-good → 最近 known-good', () => {
  assert.equal(
    rollbackTarget({ previousVersion: '0.2.0', previousWasKnownGood: false, knownGoodVersion: '0.1.1' }),
    '0.1.1',
  );
  assert.equal(
    rollbackTarget({ previousVersion: '0.2.0', previousWasKnownGood: false, knownGoodVersion: '0.1.1-rc.2' }),
    '0.1.1-rc.2',
  );
});

test('rollbackTarget: previous 与 known-good 都无 → null（落内建树）', () => {
  assert.equal(rollbackTarget({ previousVersion: null, previousWasKnownGood: false, knownGoodVersion: null }), null);
  // previous 非空但不可信任 + 无 known-good → null（绝不回退到坏树）
  assert.equal(rollbackTarget({ previousVersion: '0.2.0', previousWasKnownGood: false, knownGoodVersion: null }), null);
});

test('rollbackTarget: previous === known-good → 切换前版本（即使 previousWasKnownGood 为 false）', () => {
  assert.equal(
    rollbackTarget({ previousVersion: '0.1.1', previousWasKnownGood: false, knownGoodVersion: '0.1.1' }),
    '0.1.1',
  );
});

test('rollbackTarget: 无切换前版本但有 known-good → known-good（首次安装/恢复内建场景）', () => {
  assert.equal(
    rollbackTarget({ previousVersion: null, previousWasKnownGood: false, knownGoodVersion: '0.1.1' }),
    '0.1.1',
  );
});

test('shouldAutoRollback: 四态 = restart-exhausted 与 active-is-override 的合取', () => {
  assert.equal(shouldAutoRollback(false, false), false, '未 exhausted 且非 override → 不回退');
  assert.equal(shouldAutoRollback(true, false), false, 'exhausted 但激活树是内建 → 不回退');
  assert.equal(shouldAutoRollback(false, true), false, 'override 但未 exhausted → 不回退');
  assert.equal(shouldAutoRollback(true, true), true, 'exhausted 且激活树是 override → 触发一次自动回退');
});
