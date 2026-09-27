/**
 * step-gate 行为契约（完成点步进的 #185 重入闸）：非重入同步执行、步骤体永不嵌套、
 * 重入按 id 去重、微任务补跑，且补跑期间的新请求再排一轮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStepGate, type StepDefer } from '../../src/step-gate.ts'

function manual(): { defer: StepDefer; pending: () => number; drain: () => void } {
  const queue: Array<() => void> = []
  return {
    defer: run => { queue.push(run) },
    pending: () => queue.length,
    drain: () => { const now = [...queue]; queue.length = 0; for (const run of now) run() },
  }
}

test('non-reentrant requests run synchronously and in order', () => {
  const calls: string[] = []
  const gate = createStepGate(id => calls.push(id))
  gate.request('a')
  gate.request('b')
  assert.deepEqual(calls, ['a', 'b'])
})

test('a request issued from inside the step is deferred, never nested', () => {
  const calls: string[] = []
  const box = manual()
  const gate = createStepGate(id => { calls.push(id); if (id === 'a') gate.request('b') }, box.defer)
  gate.request('a')
  assert.deepEqual(calls, ['a'], '步骤体不得自我重入')
  assert.equal(box.pending(), 1)
  box.drain()
  assert.deepEqual(calls, ['a', 'b'])
})

test('reentrant requests for the same id coalesce into one catch-up run', () => {
  const calls: string[] = []
  const box = manual()
  const gate = createStepGate(id => {
    calls.push(id)
    if (id === 'a') { gate.request('b'); gate.request('b'); gate.request('b') }
  }, box.defer)
  gate.request('a')
  box.drain()
  assert.deepEqual(calls, ['a', 'b'], '三次同 id 重入只补跑一次')
})

test('a request arriving during the catch-up run schedules one more microtask', () => {
  const calls: string[] = []
  const box = manual()
  const gate = createStepGate(id => {
    calls.push(id)
    if (id === 'a') gate.request('b')
    if (id === 'b') gate.request('c')
  }, box.defer)
  gate.request('a')
  box.drain()
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(box.pending(), 1, '补跑不得嵌套自己的后续请求')
  box.drain()
  assert.deepEqual(calls, ['a', 'b', 'c'])
})

test('the default defer is a microtask: a reentrant request lands before a 0ms task', async () => {
  const calls: string[] = []
  const gate = createStepGate(id => { calls.push(id); if (id === 'a') gate.request('b') })
  gate.request('a')
  assert.deepEqual(calls, ['a'])
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, ['a', 'b'])
})
