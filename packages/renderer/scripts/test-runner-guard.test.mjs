/**
 * test-runner-guard.test.mjs —— renderer 测试清单（scripts/test.mjs）的零测试
 * 守卫 + 清单锁步测试。
 *
 * 2026-12（M1）后清单只保留数据表，runner 语义（解析、零测试判定、平台腿、首败即停）
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
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, WIN32_FILES } from './test.mjs'
import {
  collectEntries, evaluateChildRun, parseReportedTotals, selectManifest,
} from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 与 scripts/gates/verify-test-wiring.mjs 同款忽略目录（vendor/dist 里的测试
 *  不属于本包清单的扫描面）。 */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'lib', 'release', '.git', '.desktop-build', 'coverage'])

function discoverTestFiles(root) {
  const found = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        visit(path.join(directory, entry.name))
        continue
      }
      if (entry.isFile() && /\.test\.(ts|mjs)$/.test(entry.name)) {
        found.push(path.relative(root, path.join(directory, entry.name)).split(path.sep).join('/'))
      }
    }
  }
  visit(root)
  return found.sort()
}

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
  for (const [group, files] of Object.entries(GROUPS)) {
    const names = files.map(fileOf)
    assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], group + ' 组内重复列出测试文件')
  }
  const win32Names = WIN32_FILES.map(fileOf)
  assert.deepEqual(win32Names.filter((name, index) => win32Names.indexOf(name) !== index), [], 'WIN32_FILES 组内重复列出测试文件')

  const listed = [...Object.values(GROUPS).flat().map(fileOf), ...win32Names]
  const discovered = discoverTestFiles(PACKAGE_ROOT)
  assert.ok(discovered.length > 0, '发现集为空 —— 锁步断言被空集骗过')
  assert.deepEqual(discovered.filter(file => !listed.includes(file)), [], '盘上的测试文件必须显式列进 GROUPS/WIN32_FILES')
  assert.deepEqual(listed.filter(file => !discovered.includes(file)), [], '清单列出的文件必须在盘上存在')
  assert.deepEqual(
    listed.filter(file => !existsSync(path.join(PACKAGE_ROOT, file))),
    [],
    '清单列出的路径必须真实存在',
  )
  const fullNames = Object.values(GROUPS).flat().map(fileOf)
  assert.deepEqual(win32Names.filter(name => !fullNames.includes(name)), [], 'WIN32_FILES 必须是 GROUPS 的子集')
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
