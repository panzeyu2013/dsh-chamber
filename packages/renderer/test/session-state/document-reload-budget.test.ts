/**
 * 页面 document-reload 持久预算：阶梯的内存配额随文档消失，只有跨文档的滚动窗口
 * 才能阻止"重载 → 新文档 → 再次重载"的环。存储不可用时 fail closed。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'
import { DOCUMENT_RELOAD_BUDGET_KEY, shouldReloadDocument, type ReloadBudgetStorage } from '../../src/document-reload-budget.ts'

function storage(): ReloadBudgetStorage & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

test('the rolling window admits reloadMax reloads, then refuses until it slides', () => {
  const disk = storage()
  const windowMs = LADDER_TABLES.delivery.rebootWindowMs
  const max = LADDER_TABLES.delivery.reloadMax
  for (let index = 0; index < max; index += 1) {
    assert.equal(shouldReloadDocument(disk, 1_000 + index), true, 'reload ' + String(index + 1))
  }
  assert.equal(shouldReloadDocument(disk, 1_000 + max), false, 'the cap is reloadMax per window')
  assert.equal(shouldReloadDocument(disk, 1_000 + windowMs + 1), true, 'the oldest entry left the window')
})

test('a corrupt or unwritable budget fails closed (no automatic reload without a ledger)', () => {
  const corrupt = storage()
  corrupt.values.set(DOCUMENT_RELOAD_BUDGET_KEY, '{not json')
  assert.equal(shouldReloadDocument(corrupt, 1_000), false)
  const throwing: ReloadBudgetStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota') },
  }
  assert.equal(shouldReloadDocument(throwing, 1_000), false)
  assert.equal(shouldReloadDocument(undefined, 1_000), false)
})
