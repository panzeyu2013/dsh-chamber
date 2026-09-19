/**
 * notify-test-result.ts 纯映射测试（design 19 §3.3/§4 契约升级，2026-09）。
 *
 * 钉住一条产品纪律：'dsh-chamber:notify' 的失败**必须带原因**（宿主/OS 原文或本进程
 * 裁决原因）——macOS 通知权限被拒后不再弹授权框，用户唯一的恢复路径就是从设置页看到
 * 原因并去「系统设置 → 通知」打开。反向也要钉：成功不带原因、空串/非字符串不制造假原因、
 * reject 路径同样如实。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testNotifyRejected, testNotifyResult } from '../../src/client/notify-test-result.ts';

test('shown:true → sent（成功不携带原因）', () => {
  assert.deepEqual(testNotifyResult({ shown: true }), { kind: 'sent' });
});

test('shown:false + error → failed，并保留宿主/OS 原文', () => {
  const reason = 'swift-edge-notification-not-authorized:denied';
  assert.deepEqual(testNotifyResult({ shown: false, error: reason }), { kind: 'failed', error: reason });
});

test('shown:false 无原因 / 空串 / 非字符串 → failed 且不带原因（不制造假原因）', () => {
  assert.deepEqual(testNotifyResult({ shown: false }), { kind: 'failed' });
  assert.deepEqual(testNotifyResult({ shown: false, error: '' }), { kind: 'failed' });
  assert.deepEqual(testNotifyResult({ shown: false, error: '   ' }), { kind: 'failed' });
});

test('invoke reject → failed + 异常消息（桥异常也必须有原因）', () => {
  assert.deepEqual(testNotifyRejected(new Error('ipc closed')), { kind: 'failed', error: 'ipc closed' });
  assert.deepEqual(testNotifyRejected('boom'), { kind: 'failed', error: 'boom' });
});

test('原因为多行/长文本时原样保留（不做截断或改写）', () => {
  const reason = 'macOS refused to deliver the notification (notification authorization may be denied — check System Settings > Notifications): The operation couldn’t be completed.';
  assert.deepEqual(testNotifyResult({ shown: false, error: reason }), { kind: 'failed', error: reason });
});
