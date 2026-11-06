/**
 * 输入活动席位的接线锁（N-ctx 壳常驻 v1.1）：监听形态/归属属性/零 React 状态更新。
 *
 * 席位本身没有可纯函数化的判定（它只是把 document 事件写进 Map），所以本套件用源码文本
 * 锁住接线契约；常驻阀读数的行为面由 resident-policy 的输入保护窗单测覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-input-activity.ts', import.meta.url)),
  'utf8',
)

test('input activity: document-level capture + passive listeners for the three input events', () => {
  assert.match(SOURCE, /const INPUT_EVENTS = \['beforeinput', 'input', 'compositionstart'\] as const/,
    'the covered event family is pinned')
  assert.match(SOURCE, /document\.addEventListener\(type, record, \{ capture: true, passive: true \}\)/,
    'capture + passive: one document seat sees every shell without blocking input')
  assert.match(SOURCE, /document\.removeEventListener\(type, record, \{ capture: true \}\)/,
    'the same capture semantics power the cleanup')
})

test('input activity: attribution is the nearest [data-instance] shell root', () => {
  assert.match(SOURCE, /const INSTANCE_SELECTOR = '\[data-instance\]'/, 'one attribute owner')
  assert.match(SOURCE, /const INSTANCE_ATTRIBUTE = 'data-instance'/, 'the read uses the same attribute name')
  assert.match(SOURCE, /target\.closest\(INSTANCE_SELECTOR\)/, 'the attribution walks up to the shell root')
  assert.match(SOURCE, /element\.getAttribute\(INSTANCE_ATTRIBUTE\)/, 'the id is read from the shell root, never inferred')
})

test('input activity: zero React state updates (the Map is the only observation store)', () => {
  assert.match(SOURCE, /useEffect\(/, 'the listeners are installed in an effect')
  assert.match(SOURCE, /const lastInputAtById = new Map/, 'the observation store is a module-level Map')
  assert.doesNotMatch(SOURCE, /useState|useReducer|setState|useSyncExternalStore/,
    'input must not trigger a React render')
})

test('input activity: lastInputAt / clearInput are the module-level observation face', () => {
  assert.match(SOURCE, /export function lastInputAt\(id: string\): number \| undefined/)
  assert.match(SOURCE, /export function clearInput\(id: string\): void/)
  assert.match(SOURCE, /lastInputAtById\.delete\(id\)/, 'clearInput drops the record (no unbounded Map growth)')
})
