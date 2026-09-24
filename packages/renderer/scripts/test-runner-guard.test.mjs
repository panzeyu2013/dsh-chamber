/**
 * test-runner-guard.test.mjs —— renderer 测试清单（scripts/test.mjs）的零测试
 * 守卫 + 清单锁步测试。
 *
 * 清单只保留数据表，runner 语义（解析、零测试判定、平台腿、首败即停）
 * 全部来自共享引擎 scripts/lib/test-manifest.mjs；本文件因此：
 *   ① 钉住本包选用的判定档（executed：pass+fail > 0，全 skip 视为零覆盖）；
 *   ② 清单锁步：盘上每个 *.test.ts / *.test.mjs 都出现在 GROUPS ∪ WIN32_FILES 里、
 *      清单文件真实存在、单表无重复、WIN32_FILES ⊆ GROUPS；
 *   ③ 平台腿：--win32 只选 WIN32_FILES 且在 GROUPS 查表（继承 nodeArgs），默认腿
 *      展开每个非空组；
 *   ④ 源码锁：清单确实把本包的表交给共享 runner，本地 spawn 循环已删除。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, WIN32_FILES } from './test.mjs'
import {
  collectEntries, evaluateChildRun, manifestLockstepProblems, parseReportedTotals, selectManifest,
} from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 清单条目可以是路径串，也可以是 { file, nodeArgs }。 */
const fileOf = entry => (typeof entry === 'string' ? entry : entry.file)

test('① 共享判定（本包档：executed）：零测试体（无汇总 / tests 0 / 全 skip）一律红', () => {
  const child = output => ({ status: 0, signal: null, stdout: output })
  assert.equal(evaluateChildRun('a.test.ts', child('ℹ tests 3\nℹ pass 3\n')).ok, true)
  assert.equal(evaluateChildRun('a.test.ts', child('# tests 2\n# pass 1\n# fail 1\n')).ok, true)
  assert.equal(evaluateChildRun('a.test.ts', child('# tests 0\n')).ok, false)
  assert.equal(evaluateChildRun('a.test.ts', child('ℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ skipped 1\n')).ok, false)
  assert.equal(evaluateChildRun('a.test.ts', child('console.log only\n')).ok, false)
  assert.equal(parseReportedTotals('ℹ tests 9\nℹ pass 9\nℹ tests 2\nℹ pass 1\nℹ fail 1\n').tests, 2)
})

test('② 清单锁步：盘上测试文件全部接线、清单文件都存在、WIN32_FILES ⊆ GROUPS', () => {
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

test('③ 平台腿：--win32 只选 WIN32_FILES（在 GROUPS 查表），默认腿展开全部非空组', () => {
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

test('④ 源码锁：清单把本包的表交给共享 runner，本地 spawn 循环已删除', () => {
  const source = readFileSync(new URL('./test.mjs', import.meta.url), 'utf8')
  assert.ok(source.includes('runTestManifest({'), '清单必须委托共享 runner')
  assert.ok(source.includes('platformFiles: { win32: WIN32_FILES }'), 'win32 腿必须接线')
  assert.ok(source.includes('const isMain = process.argv[1] !== undefined'), 'CLI 必须在 import 守卫内')
  assert.ok(!source.includes('spawnSync'), '本地 spawn 循环必须已删除（单一 runner 引擎）')
})
