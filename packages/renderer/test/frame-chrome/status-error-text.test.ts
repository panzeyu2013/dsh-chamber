/**
 * renderer 通用错误文案助手（`src/status.ts`）的边界契约。
 *
 * `errorMessage` 在 **catch 块里**接收桥/网络拒绝值（`api.host.health()`、聚合快照拉取），
 * 因此错误格式化本身是一道异常边界：敌意 getter / toString 抛出的值不得让 catch 处理器
 * 再抛一次。非敌意输入的行为**逐字保持**（含 `undefined` → 'undefined' 这一语义）。
 *
 * Run directly: node packages/renderer/test/frame-chrome/status-error-text.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { errorMessage } from '../../src/status.ts'

test('敌意拒绝值（message getter / toString 抛错）只返回文本，绝不抛', () => {
  const hostileMessage = {
    get message(): string { throw new Error('hostile getter') },
    toString(): string { throw new Error('hostile toString') },
  }
  assert.equal(errorMessage(hostileMessage), 'unknown error')
  const hostileToString = { toString(): string { throw new Error('hostile toString') } }
  assert.equal(errorMessage(hostileToString), 'unknown error')
  // 非 Error 对象的 `message` 字段根本不该被读取：若真去读了这个会抛的 getter，
  // 本断言会以抛出失败；拿到默认的 '[object Object]' 反证读取路径只走 ToPrimitive。
  const hostileMessageOnly = { get message(): string { throw new Error('hostile getter') } }
  assert.equal(errorMessage(hostileMessageOnly), '[object Object]')
})

test('非敌意输入语义不变（含既有 undefined → \'undefined\' 与空串）', () => {
  assert.equal(errorMessage(new Error('boom')), 'boom')
  assert.equal(errorMessage('plain text'), 'plain text')
  assert.equal(errorMessage(''), '')
  assert.equal(errorMessage(undefined), 'undefined')
  assert.equal(errorMessage(null), 'null')
  assert.equal(errorMessage(42), '42')
})
