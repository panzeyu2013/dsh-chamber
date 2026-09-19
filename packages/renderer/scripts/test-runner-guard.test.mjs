/**
 * test-runner-guard.test.mjs —— renderer 测试清单（scripts/test.mjs）的零测试
 * 守卫（D2b）+ 清单锁步测试。
 *
 * 断言链：
 *   ① parseExecutedTestCount：spec（ℹ tests N）与 TAP（# tests N）两种汇总行
 *      都解析；无汇总行 / tests 0 / 全部 skip（pass 0 / fail 0）一律 null——
 *      静默空清单不得变绿；取最后一个汇总块（子进程输出在前）；
 *   ② 清单锁步：盘上每个 *.test.ts / *.test.mjs 都出现在 GROUPS ∪ WIN32_FILES
 *      里（新增测试必须显式接线），清单列出的文件都真实存在、单表无重复，
 *      WIN32_FILES 是 GROUPS 的子集（win32 腿只跑全量腿已覆盖的文件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, WIN32_FILES, collectEntries, parseExecutedTestCount } from './test.mjs'

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

test('① parseExecutedTestCount：零测试体（无汇总 / tests 0 / 全 skip）一律 null', () => {
  assert.equal(parseExecutedTestCount('ℹ tests 3\nℹ pass 3\n'), 3)
  assert.equal(parseExecutedTestCount('# tests 2\n# pass 1\n# fail 1\n'), 2)
  assert.equal(parseExecutedTestCount('# tests 0\n'), null)
  assert.equal(parseExecutedTestCount('ℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ skipped 1\n'), null)
  assert.equal(parseExecutedTestCount('console.log only\n'), null)
  // 子进程（被列文件若再 spawn 测试）的输出在前，本文件汇总在最后。
  assert.equal(parseExecutedTestCount('ℹ tests 9\nℹ pass 9\nℹ tests 2\nℹ pass 1\nℹ fail 1\n'), 2)
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

test('③ collectEntries：--win32 只选 WIN32_FILES，默认腿展开全部 GROUPS', () => {
  const win32Entries = collectEntries({ win32: true })
  assert.deepEqual(win32Entries.map(entry => entry.file), WIN32_FILES.map(fileOf))
  assert.deepEqual([...new Set(win32Entries.map(entry => entry.group))], ['win32'])
  const full = collectEntries()
  const nonEmptyGroups = Object.keys(GROUPS).filter(key => GROUPS[key].length > 0).sort()
  assert.deepEqual(
    [...new Set(full.map(entry => entry.group))].sort(),
    nonEmptyGroups,
    '默认腿必须展开每个非空 GROUPS 组（空占位组不产生条目，也不得吞掉别的组）',
  )
  assert.deepEqual(full.map(entry => entry.file), Object.values(GROUPS).flat().map(fileOf))
})

test('④ 零测试守卫确实接在 runner 主循环上（源码锁）', () => {
  const source = readFileSync(new URL('./test.mjs', import.meta.url), 'utf8')
  assert.ok(
    source.includes("parseExecutedTestCount((result.stdout ?? '')"),
    '零测试守卫必须接在子进程退出码判定之后，不能只是导出的纯函数',
  )
  assert.ok(
    source.includes('const isMain = process.argv[1] !== undefined'),
    'CLI 必须在 import 守卫内（否则清单被测试 import 时会重跑整套）',
  )
})
