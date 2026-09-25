/**
 * plugin-model.ts unit tests (plain node:test, no dsh, no React): the pure READ-ONLY
 * plugin-row model layer — the installed-row projection (design 21 §6.11.5), including
 * the authoritative empty-rows answer and the explicit-empty projection for a missing or
 * malformed `rows` payload (no legacy dependencies fallback). The write model (apply
 * classification, task projection, undo derive, diff/apply boundary) was retired with the
 * plugin write surfaces (D1).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pluginRowsOf,
  projectInstalledRows,
  type PluginRowShape,
} from '../../src/client/plugin-model.ts'
import { pluginRow as row } from '../support/fixtures.ts'

test('pluginRowsOf: missing/non-array rows answer an explicit empty projection; an array comes back as a copy', () => {
  assert.deepEqual(pluginRowsOf(undefined), [])
  assert.deepEqual(pluginRowsOf(null), [])
  assert.deepEqual(pluginRowsOf({}), [])
  assert.deepEqual(pluginRowsOf({ rows: undefined }), [])
  // 形状校验：非数组同样是空投影，绝不抛（producer 的意外载荷不是崩溃点）。
  assert.deepEqual(pluginRowsOf({ rows: 'nope' as unknown as PluginRowShape[] }), [])
  const rows = [row({ name: 'a' })]
  const copy = pluginRowsOf({ rows })
  assert.deepEqual(copy, rows)
  assert.notEqual(copy, rows, 'returns a shallow copy: callers may sort/iterate without touching the IPC payload')
})

test('projectInstalledRows: renders one row per backend projection row (protected flagged read-only)', () => {
  // 行集口径（design 21 §6.11.5）：后端只按依赖表投影，所以受保护行
  // 也**带依赖值**（`@deepseek-ai/dsh-base` 若出现，是因为该 profile 自己声明了它）。
  const dependencies = {
    '@deepseek-ai/dsh-base': '^0.1.0', '@dsh-chamber/dsh-chamber-seed-client-graph': '0.3.1',
    'third-party-a': '^1.0.0',
  }
  const rows = [
    row({ name: '@deepseek-ai/dsh-base', role: 'composition', protected: true, version: '0.1.5' }),
    row({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', role: 'seed', protected: true, version: '0.3.1' }),
    row({ name: 'third-party-a' }),
  ]
  const projected = projectInstalledRows(dependencies, rows)
  assert.deepEqual(projected.map(view => view.name), [
    '@deepseek-ai/dsh-base',
    '@dsh-chamber/dsh-chamber-seed-client-graph',
    'third-party-a',
  ])
  const base = projected[0]!
  assert.equal(base.protected, true)
  assert.equal(base.version, '0.1.5')
  assert.equal(base.spec, '^0.1.0', 'the dependency value wins for rows that have one')
  const seed = projected[1]!
  assert.equal(seed.protected, true)
  assert.equal(seed.role, 'seed')
  assert.equal(seed.spec, '0.3.1')
  // 防御性：投影是「按行」驱动的——万一某个后端给出没有依赖项的行，它照样渲染
  // （spec null ⇒ 单元格落到版本），绝不静默丢行或抛错。
  const orphan = projectInstalledRows({}, [row({ name: 'x', spec: null, version: '9.9.9' })])
  assert.deepEqual(orphan.map(view => [view.name, view.spec, view.version]), [['x', null, '9.9.9']])
})

test('projectInstalledRows: an empty or absent row projection renders the empty state, never a dependencies fallback', () => {
  assert.deepEqual(projectInstalledRows({ 'third-party-a': '^1.0.0' }, []), [])
  assert.deepEqual(projectInstalledRows({ 'third-party-a': '^1.0.0' }, pluginRowsOf(null)), [])
})
