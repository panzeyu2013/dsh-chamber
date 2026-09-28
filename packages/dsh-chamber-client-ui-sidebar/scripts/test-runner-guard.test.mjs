/**
 * test-runner-guard.test.mjs —— sidebar 测试清单（scripts/test.mjs）的零测试
 * 守卫 + 清单锁步测试。
 *
 * 清单只保留数据表，runner 语义（解析、零测试判定、平台腿、首败即停）
 * 全部来自共享引擎 scripts/lib/test-manifest.mjs；本文件因此只钉本包的事实：
 *   ① 清单锁步：盘上每个 *.test.ts / *.test.mjs 都出现在 GROUPS ∪ WIN32_FILES 里、
 *      清单文件真实存在、单表无重复、WIN32_FILES ⊆ GROUPS；
 *   ② 平台腿：--win32 只选 WIN32_FILES 且在 GROUPS 查表（继承 nodeArgs），默认腿
 *      展开每个非空组；
 *   ③ 源码锁：清单确实把本包的表交给共享 runner，本地 spawn 循环已删除。
 *
 * 共享判定档本身（evaluateChildRun / parseReportedTotals 的 executed 语义）
 * 归 scripts/lib/test-manifest.test.mjs 一个测试所有——四个包守卫曾各抄一份，
 * 语义变更要改四处。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, WIN32_FILES } from './test.mjs'
import { collectEntries, manifestLockstepProblems, selectManifest } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 清单条目可以是路径串，也可以是 { file, nodeArgs }。 */
const fileOf = entry => (typeof entry === 'string' ? entry : entry.file)

test('① 清单锁步：盘上测试文件全部接线、清单文件都存在、WIN32_FILES ⊆ GROUPS', () => {
  assert.deepEqual(
    manifestLockstepProblems({
      packageRoot: PACKAGE_ROOT,
      groups: GROUPS,
      platformFiles: { win32: WIN32_FILES },
      platformSubsetsOfGroups: ['win32'],
    }),
    [],
  )
})

test('② 平台腿：--win32 只选 WIN32_FILES（在 GROUPS 查表），默认腿展开全部非空组', () => {
  const selected = selectManifest({ groups: GROUPS, platformFiles: { win32: WIN32_FILES }, argv: ['--win32'] })
  assert.equal(selected.leg, 'win32')
  assert.deepEqual(selected.groups.win32.map(entry => entry.file), WIN32_FILES.map(fileOf))
  assert.deepEqual([...new Set(selected.groups.win32.map(entry => entry.group))], ['win32'])
  const full = selectManifest({ groups: GROUPS, platformFiles: { win32: WIN32_FILES }, argv: [] })
  const entries = collectEntries(full.groups)
  const nonEmptyGroups = Object.keys(GROUPS).filter(key => GROUPS[key].length > 0).sort()
  assert.deepEqual(
    [...new Set(entries.map(entry => entry.group))].sort(),
    nonEmptyGroups,
    '默认腿必须展开每个非空 GROUPS 组（空占位组不产生条目，也不得吞掉别的组）',
  )
  assert.deepEqual(entries.map(entry => entry.file), Object.values(GROUPS).flat().map(fileOf))
})

test('③ 源码锁：清单把本包的表交给共享 runner，本地 spawn 循环已删除', () => {
  const source = readFileSync(new URL('./test.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('runTestManifest({'), '清单必须委托共享 runner')
  assert.ok(source.includes('platformFiles: { win32: WIN32_FILES }'), 'win32 腿必须接线')
  assert.ok(source.includes('const isMain = process.argv[1] !== undefined'), 'CLI 必须在 import 守卫内')
  assert.ok(!source.includes('spawnSync'), '本地 spawn 循环必须已删除（单一 runner 引擎）')
})
