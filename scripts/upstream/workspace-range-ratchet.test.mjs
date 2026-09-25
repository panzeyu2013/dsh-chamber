/**
 * workspace range 政策棘轮（升级计划 §22.3.7）：上游 6 个副本/分叉的内部依赖必须写成
 * `workspace:*`（上游政策拒 caret，见
 * `.agents/notes/implemented/process/2026-09-22-workspace-release-ranges.md`）。本仓
 * 2026-12 已把三处包里的 57 个 `workspace:^` 归位；这条棘轮防止以后回潮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const registry = JSON.parse(readFileSync(join(ROOT, 'scripts/upstream/registry.json'), 'utf8'))
/** 上游副本/分叉集合（registry 的 fork/seed 条目；那是政策适用面）。 */
const OURS = registry.entries.filter((entry) => entry.type === 'fork' || entry.type === 'seed').map((entry) => entry.ours)
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

test('workspace range：上游副本/分叉的内部依赖不得用 caret（要 workspace:* 或 ~）', () => {
  const offenders = []
  for (const rel of OURS) {
    const pkg = JSON.parse(readFileSync(join(ROOT, rel, 'package.json'), 'utf8'))
    for (const field of FIELDS) {
      for (const [name, range] of Object.entries(pkg[field] ?? {})) {
        if (typeof range === 'string' && range.startsWith('workspace:^')) {
          offenders.push(rel + ' ' + field + ' ' + name + '=' + range)
        }
      }
    }
  }
  assert.deepEqual(offenders, [], '内部依赖必须写成 workspace:*（上游政策拒 caret）：' + offenders.join('；'))
})

test('workspace range 棘轮：政策适用面不得缩到空', () => {
  assert.ok(OURS.length >= 6, 'registry 的 fork/seed 集合变小了：' + OURS.length)
})
