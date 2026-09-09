/**
 * log-line.test.ts — `formatLogLine` 纯函数测试（2026-09 二轮评审 P5：
 * CLI 渲染面无测试；`ts=null` 曾显示 1970、非数字 ts 会抛）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatLogLine } from '../src/index.ts'

test('formatLogLine: 有效时间戳渲染 ISO', () => {
  assert.equal(formatLogLine({ ts: 0, stream: 'stdout', line: 'hello' }), '[1970-01-01T00:00:00.000Z] [stdout] hello')
  assert.equal(formatLogLine({ ts: '2026-09-09T12:00:00.000Z', stream: 'stderr', line: 'x' }),
    '[2026-09-09T12:00:00.000Z] [stderr] x')
})

test('formatLogLine: null/undefined/非法时间戳显示 -，绝不抛', () => {
  assert.equal(formatLogLine({ ts: null, stream: 'stdout', line: 'raw' }), '[-] [stdout] raw')
  assert.equal(formatLogLine({ ts: undefined } as never), '[-] [?] ')
  assert.equal(formatLogLine({ ts: 'not-a-date', line: 'x' }), '[-] [?] x')
  assert.equal(formatLogLine({ ts: '' , line: 'x' }), '[-] [?] x')
  assert.equal(formatLogLine(null), '[-] [?] ')
})

test('formatLogLine: 缺 stream/line 时用占位', () => {
  assert.equal(formatLogLine({ ts: 0 }), '[1970-01-01T00:00:00.000Z] [?] ')
})
