/**
 * test-runner-lockstep.test.mjs —— desktop 测试清单（scripts/test.mjs）锁步 +
 * 零测试守卫（D2b）测试。
 *
 * 背景：test.mjs 旧版只看子进程退出码——一个列出但没跑任何测试（或根本
 * spawn 不起来）的文件会被当成通过。现在 test.mjs 在 runner 汇总行上判
 * 零测试/缺汇总为失败，并允许 ZERO_TEST_ALLOWLIST 显式登记例外。
 *
 * 断言链：
 *  ① parseReportedTestCount / parseReportedTotals：spec（ℹ tests N）与 TAP（# tests N）两种汇总
 *     行都解析；无汇总行 = null；取最后一个汇总（子进程输出在前，本文件
 *     汇总在后）；
 *  ② evaluateChildRun：exit 0 + tests>0 通过；exit 0 + 无汇总/tests 0 失败；
 *     非 0 退出 / 信号 / spawn error 失败；allowlist 命中显式放行；
 *  ③ runEntries：零测试子进程返回接到守卫上（注入 spawn），证明守卫确实
 *     在 runner 主循环里生效，而不是孤立的纯函数；
 *  ④ runEntries：正常文件通过并按顺序输出（stdout/stderr 透传）；
 *  ⑤ 清单锁步：packages/desktop 下每个 *.test.ts / *.test.mjs 都出现在
 *     GROUPS ∪ WIN32_FILES ∪ MACOS_FILES 中（新增测试文件必须显式接线），
 *     清单里的文件都真实存在，且任一清单内部无重复。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GROUPS,
  WIN32_FILES,
  MACOS_FILES,
  ZERO_TEST_ALLOWLIST,
  parseReportedTestCount,
  parseReportedTotals,
  evaluateChildRun,
  runEntries,
} from './test.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 与 scripts/dev/verify-test-wiring.mjs 同款忽略目录（vendor/dist 里的
 *  测试不属于本包清单的扫描面）。 */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'lib', 'release', '.git', '.desktop-build', 'coverage', '.dev-user-data'])

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

test('① parseReportedTestCount：spec/TAP 汇总行解析，缺汇总行 = null', () => {
  assert.equal(parseReportedTestCount('ℹ tests 3\nℹ pass 3\n'), 3)
  assert.equal(parseReportedTestCount('# tests 68\n# pass 68\n'), 68)
  assert.equal(parseReportedTestCount('# tests 0\n'), 0)
  assert.equal(parseReportedTestCount('console.log only\n'), null)
  // 子进程（被列文件若再 spawn 测试）的输出在前，本文件汇总在最后。
  assert.equal(parseReportedTestCount('# tests 2\n# tests 5\n'), 5)
  // 汇总块解析：tests/pass/fail/skipped 同块；新块以 tests 行重新起算。
  assert.deepEqual(parseReportedTotals('ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ skipped 0\n'),
    { tests: 3, pass: 2, fail: 1, skipped: 0 })
  assert.deepEqual(parseReportedTotals('ℹ tests 1\nℹ pass 1\nℹ tests 4\nℹ pass 0\nℹ fail 0\nℹ skipped 4\n'),
    { tests: 4, pass: 0, fail: 0, skipped: 4 })
  assert.deepEqual(parseReportedTotals('no summary\n'), { tests: null, pass: null, fail: null, skipped: null })
})

test('② evaluateChildRun：零测试 / 无法 spawn 一律失败，例外须显式放行', () => {
  const pass = { status: 0, signal: null, stdout: 'ℹ tests 1\nℹ pass 1\n', stderr: '' }
  assert.deepEqual(evaluateChildRun('fixture.test.ts', pass), { ok: true })
  // 2026-12 验证轮：全 skip 的文件报 tests 1 但没有任何测试体执行 → 必须失败
  // （旧的计数守卫只看 tests，会把它放过）。
  assert.equal(
    evaluateChildRun('fixture.test.ts', {
      status: 0, signal: null,
      stdout: 'ℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ skipped 1\n', stderr: '',
    }).ok,
    false,
    'pass 0 / fail 0（全部跳过）不得视为通过',
  )
  assert.equal(evaluateChildRun('fixture.test.ts', { status: 0, signal: null, stdout: 'no tests\n', stderr: '' }).ok, false)
  assert.equal(evaluateChildRun('fixture.test.ts', { status: 0, signal: null, stdout: '# tests 0\n', stderr: '' }).ok, false)
  assert.equal(evaluateChildRun('fixture.test.ts', { status: 1, signal: null, stdout: 'ℹ tests 1\n', stderr: '' }).ok, false)
  assert.equal(evaluateChildRun('fixture.test.ts', { status: null, signal: 'SIGKILL', stdout: '', stderr: '' }).ok, false)
  assert.equal(evaluateChildRun('fixture.test.ts', { status: null, signal: null, error: new Error('spawn ENOENT'), stdout: '', stderr: '' }).ok, false)
  const allowlist = [{ file: 'fixture.test.ts', reason: 'fixture：该文件只在脚本模式下运行' }]
  assert.deepEqual(evaluateChildRun('fixture.test.ts', { status: 0, signal: null, stdout: '', stderr: '' }, allowlist), { ok: true })
})

test('③ runEntries：零测试子进程返回被判失败（守卫确实接在 runner 循环上）', () => {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, signal: null, stdout: 'no tests here\n', stderr: '', error: undefined }
  }
  const verdict = runEntries(
    [{ group: 'fixture', file: 'zero.test.ts', nodeArgs: [] }],
    { spawn, writeOut: () => {}, writeErr: () => {} },
  )
  assert.deepEqual(verdict, {
    ok: false,
    file: 'zero.test.ts',
    reason: '未运行任何测试（无 node:test 汇总行；零测试文件不得视为通过）',
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['zero.test.ts'])
  assert.equal(calls[0].options.cwd, PACKAGE_ROOT)
  assert.deepEqual(calls[0].options.stdio, ['inherit', 'pipe', 'pipe'])
  assert.equal(calls[0].options.encoding, 'utf8')
})

test('④ runEntries：正常文件通过并按顺序透传输出', () => {
  const written = []
  const spawn = () => ({ status: 0, signal: null, stdout: 'ℹ tests 2\nℹ pass 2\n', stderr: 'warn\n', error: undefined })
  const verdict = runEntries(
    [
      { group: 'a', file: 'one.test.ts', nodeArgs: [] },
      { group: 'a', file: 'two.test.ts', nodeArgs: [] },
    ],
    { spawn, writeOut: text => written.push(text), writeErr: text => written.push('ERR:' + text) },
  )
  assert.deepEqual(verdict, { ok: true })
  assert.equal(written[0], '\n=== a ===\n')
  assert.ok(written.includes('ℹ tests 2\nℹ pass 2\n'))
  assert.ok(written.includes('ERR:warn\n'))
})

test('⑤ 清单锁步：盘上每个 desktop 测试文件都被接线、清单文件都存在、单表无重复', () => {
  // 单表内部不得重复（跨表重复——win-acl 同时属于全量与 win32 腿——按
  // test.mjs 头注释是刻意的）。
  for (const [group, files] of Object.entries(GROUPS)) {
    const names = files.map(fileOf)
    assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], group + ' 组内重复列出测试文件')
  }
  for (const files of [WIN32_FILES, MACOS_FILES]) {
    const names = files.map(fileOf)
    assert.deepEqual(names.filter((name, index) => names.indexOf(name) !== index), [], '平台腿组内重复列出测试文件')
  }

  const listed = [
    ...Object.values(GROUPS).flat().map(fileOf),
    ...WIN32_FILES.map(fileOf),
    ...MACOS_FILES.map(fileOf),
  ]
  const discovered = discoverTestFiles(PACKAGE_ROOT)
  assert.ok(discovered.length > 0, '发现集为空 —— 锁步断言被空集骗过')
  assert.deepEqual(discovered.filter(file => !listed.includes(file)), [], '盘上的测试文件必须显式列进 GROUPS/WIN32_FILES/MACOS_FILES')
  assert.deepEqual(listed.filter(file => !discovered.includes(file)), [], '清单列出的文件必须在盘上存在')
  assert.deepEqual(
    ZERO_TEST_ALLOWLIST
      .filter(entry => entry.reason.trim() === '' || !existsSync(path.join(PACKAGE_ROOT, entry.file)))
      .map(entry => entry.file),
    [],
    'ZERO_TEST_ALLOWLIST 每个条目都必须有理由且指向真实文件',
  )
})
