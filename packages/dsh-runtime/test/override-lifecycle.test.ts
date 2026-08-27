/**
 * override-lifecycle.ts 纯逻辑测试（design 18 §3.5 失效规则 / 回落保护 /
 * swap-attempted / pending 重放）——node:test，无 electron、无文件 IO。
 *
 * 覆盖：shouldInvalidate 版本相等/不等；invalidate 保留
 * chosenVersion/resolvedVersion/pending 且复位 swapAttempted（标记 ≠ 删除、
 * 不修改入参）；effectivePending 未失效/已失效（pending 一并失效）/record null
 * 三分支；shouldRetrySwap 置位/未置位；replayDecision 三分支（pending 空 /
 * 指针===pending / 指针!==pending，含指针缺失时视为需切换）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OverrideRecord } from '../src/dsh-runtime-store.ts';
import {
  effectivePending,
  invalidate,
  replayDecision,
  shouldInvalidate,
  shouldRetrySwap,
} from '../src/override-lifecycle.ts';

const SHELL = '0.1.1-rc.2';
const CURRENT = '0.1.1';
const CHOSEN = '0.2.0';
const RESOLVED = '0.2.0';
const PENDING = '0.3.0';

/** 构造一条完整 override 记录；未给字段用默认值。 */
function makeRecord(overrides: Partial<OverrideRecord> = {}): OverrideRecord {
  return {
    shellVersion: SHELL,
    chosenVersion: CHOSEN,
    resolvedVersion: RESOLVED,
    pending: PENDING,
    swapAttempted: false,
    ...overrides,
  };
}

test('shouldInvalidate: shellVersion === currentShellVersion → false（未失效）', () => {
  assert.equal(shouldInvalidate(makeRecord(), SHELL), false);
  assert.equal(shouldInvalidate(makeRecord({ pending: null }), SHELL), false);
});

test('shouldInvalidate: shellVersion !== currentShellVersion → true（override 与 pending 一并失效）', () => {
  assert.equal(shouldInvalidate(makeRecord(), CURRENT), true);
  assert.equal(shouldInvalidate(makeRecord({ shellVersion: '0.0.9' }), SHELL), true);
});

test('invalidate: 保留 chosenVersion/resolvedVersion/pending（标记 ≠ 删除）', () => {
  const record = makeRecord({ swapAttempted: true });
  const invalidated = invalidate(record);
  assert.equal(invalidated.chosenVersion, CHOSEN);
  assert.equal(invalidated.resolvedVersion, RESOLVED);
  assert.equal(invalidated.pending, PENDING);
  assert.equal(invalidated.shellVersion, SHELL);
  // 记录存活是 F4「自动恢复上一 override 树」的前提——绝非删除。
  assert.deepEqual(
    { chosenVersion: invalidated.chosenVersion, resolvedVersion: invalidated.resolvedVersion, pending: invalidated.pending },
    { chosenVersion: CHOSEN, resolvedVersion: RESOLVED, pending: PENDING },
  );
});

test('invalidate: swapAttempted 复位（true → false），入参不被修改', () => {
  const record = makeRecord({ swapAttempted: true });
  const invalidated = invalidate(record);
  assert.equal(invalidated.swapAttempted, false);
  // 纯函数：原记录原样，调用方持有的引用不受影响。
  assert.equal(record.swapAttempted, true);
  assert.notEqual(invalidated, record);
});

test('invalidate: swapAttempted 已是 false 时保持 false（标记幂等）', () => {
  const record = makeRecord({ swapAttempted: false });
  assert.equal(invalidate(record).swapAttempted, false);
});

test('invalidate: persists reason/time and an already-invalidated record stays invalid', () => {
  const record = makeRecord();
  const invalidated = invalidate(record, 'shell-version-changed', new Date('2026-08-23T00:00:00.000Z'));
  assert.equal(invalidated.invalidatedAt, '2026-08-23T00:00:00.000Z');
  assert.equal(invalidated.invalidatedReason, 'shell-version-changed');
  assert.equal(invalidated.lastInvalidatedAt, '2026-08-23T00:00:00.000Z');
  assert.equal(invalidated.lastInvalidatedReason, 'shell-version-changed');
  assert.equal(invalidated.lastInvalidatedFromVersion, record.resolvedVersion);
  assert.equal(invalidated.lastInvalidationRecovered, false);
  assert.equal(shouldInvalidate(invalidated, SHELL), true, 'persistent marker, not transient comparison');
  assert.equal(effectivePending(invalidated, SHELL), null);
  const again = invalidate(invalidated, 'different', new Date('2026-08-24T00:00:00.000Z'));
  assert.equal(again.invalidatedAt, invalidated.invalidatedAt);
  assert.equal(again.invalidatedReason, invalidated.invalidatedReason);
  assert.equal(again.lastInvalidatedAt, invalidated.lastInvalidatedAt);
});

test('effectivePending: 未失效时返回 record.pending', () => {
  assert.equal(effectivePending(makeRecord(), SHELL), PENDING);
  assert.equal(effectivePending(makeRecord({ pending: null }), SHELL), null);
});

test('effectivePending: 已失效（壳版本不等）→ null，pending 一并失效', () => {
  assert.equal(effectivePending(makeRecord(), CURRENT), null);
  assert.equal(effectivePending(makeRecord({ pending: '0.9.9' }), CURRENT), null);
});

test('effectivePending: record 为 null（无 override 记录）→ null', () => {
  assert.equal(effectivePending(null, SHELL), null);
  assert.equal(effectivePending(null, CURRENT), null);
});

test('shouldRetrySwap: swapAttempted===true → false（置位后不重试，避免每启重复警告）', () => {
  assert.equal(shouldRetrySwap(makeRecord({ swapAttempted: true })), false);
});

test('shouldRetrySwap: swapAttempted===false → true（可尝试，置位由上层在尝试时做）', () => {
  assert.equal(shouldRetrySwap(makeRecord({ swapAttempted: false })), true);
});

test('replayDecision: pending 为空 → none（无未决切换）', () => {
  const record = makeRecord({ pending: null });
  assert.equal(replayDecision(record, CURRENT), 'none');
  assert.equal(replayDecision(record, null), 'none');
});

test('replayDecision: 当前指针 === pending → skip-switch-probe-only（切换已生效，跳过切换直接探针）', () => {
  assert.equal(replayDecision(makeRecord(), PENDING), 'skip-switch-probe-only');
});

test('replayDecision: 当前指针 !== pending → apply-switch（指针尚未指向 pending）', () => {
  assert.equal(replayDecision(makeRecord(), CURRENT), 'apply-switch');
  assert.equal(replayDecision(makeRecord(), '0.4.0'), 'apply-switch');
  // 指针缺失（null，如指针文件损坏/缺失）也视为未生效 → 执行切换。
  assert.equal(replayDecision(makeRecord(), null), 'apply-switch');
});
