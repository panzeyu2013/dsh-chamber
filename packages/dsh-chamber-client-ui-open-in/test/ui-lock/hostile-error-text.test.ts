/**
 * open-in 错误文本的单源锁。
 *
 * 三件事：①域内名 `describeOpenInError` 必须**就是** sidebar 的 `describeThrown`
 * （同一函数对象，而非又一份同形实现）；②`capabilities.ts` 不得持有本地实现；
 * ③按钮的失败路径必须走这个敌意值安全原语，不得回到 `… ? error.message : String(error)`
 * （那会在 `.catch` 内再抛，正是该原语存在的理由）。
 *
 * Run directly: node packages/dsh-chamber-client-ui-open-in/test/ui-lock/hostile-error-text.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describeOpenInError } from '../../src/shared/capabilities.ts'
import { describeThrown } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

const CAPABILITIES = readFileSync(new URL('../../src/shared/capabilities.ts', import.meta.url), 'utf8')
const BUTTON = readFileSync(new URL('../../src/client/OpenInButton.tsx', import.meta.url), 'utf8')

test('describeOpenInError 就是 sidebar 的 describeThrown（同一函数对象，非第二份实现）', () => {
  assert.equal(describeOpenInError, describeThrown)
})

test('capabilities.ts 不再持有本地实现，只重导出规范来源', () => {
  assert.ok(!/export function describeOpenInError/u.test(CAPABILITIES), '不得再有本地函数实现')
  assert.match(CAPABILITIES, /export \{ describeThrown as describeOpenInError \} from '@dsh-chamber\/dsh-chamber-client-ui-sidebar\/shared'/u)
})

test('按钮的 catch 走敌意值安全原语，不得回到朴素格式化', () => {
  assert.match(BUTTON, /setFailureReason\(describeOpenInError\(error\)\)/u)
  assert.ok(!/instanceof Error \? error\.message : String\(error\)/u.test(BUTTON), '朴素格式化会在 .catch 内再抛')
})

test('行为面：敌意值 / 空值仍然只返回文本', () => {
  const hostile = {
    get message(): string { throw new Error('hostile getter') },
    toString(): string { throw new Error('hostile toString') },
  }
  assert.equal(describeOpenInError(hostile), 'unknown error')
  assert.equal(describeOpenInError(''), 'unknown error')
  assert.equal(describeOpenInError(new Error('plain')), 'plain')
})
