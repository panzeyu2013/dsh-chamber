/**
 * host-package-dirs.test.ts —— chamber host 包目录名映射纯函数单测。
 *
 * 覆盖 2026-12 验证轮的两条要求：
 *  ① scoped 包名必须去 scope（dev 向上检索按 packages/<目录名> 拼路径，把
 *     '@scope/name' 当目录名会让检索永远落空——该缺陷在集成期被自查抓到）；
 *  ② 无 scope 包名原样返回、空串/异常输入不得抛（调用方在装配路径上）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packageDirName } from './host-package-dirs.ts'

test('① scoped 包名去 scope（注册表 → 仓库目录名）', () => {
  assert.equal(packageDirName('@dsh-chamber/dsh-chamber-seed-client-graph'), 'dsh-chamber-seed-client-graph')
  assert.equal(packageDirName('@dsh-chamber/dsh-chamber-seed-git-worktree'), 'dsh-chamber-seed-git-worktree')
  assert.equal(packageDirName('@dsh-chamber/dsh-chamber-seed-archive-cleanup'), 'dsh-chamber-seed-archive-cleanup')
  // 只剥第一段 scope：@a/b/c 的目录名是 b/c（与 npm 语义一致）。
  assert.equal(packageDirName('@a/b/c'), 'b/c')
})

test('② 无 scope / 边界输入原样返回', () => {
  assert.equal(packageDirName('plain-name'), 'plain-name')
  assert.equal(packageDirName('@scope-only/'), '')
  assert.equal(packageDirName(''), '')
})
