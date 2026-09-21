/**
 * test-runner-lockstep.test.mjs —— desktop 测试清单（scripts/test.mjs）锁步 +
 * 零测试守卫（D2b）与 macOS 腿跳过纪律（G2）。
 *
 * 2026-12 精简：旧 ①（parseReportedTestCount / parseReportedTotals 的汇总行解析）
 * 是跨 runner parity——权威共享实现 scripts/lib/test-manifest.mjs 的同一语义断言
 * 在 scripts/lib/test-manifest.test.mjs:15-34（spec/TAP/缺汇总/tests 0/最后一个
 * 汇总块）；desktop 侧只保留本包运行器独有的不变量：
 *  ② evaluateChildRun：exit 0+无汇总/tests 0、非 0 退出/信号/spawn error、
 *     allowlist 例外——fail-closed 负例；
 *  ②b/②c macOS 腿 requireNoSkips：任一跳过硬失败（G2）；
 *  ③ runEntries：零测试子进程接到守卫上（证明守卫确实在 runner 主循环里）；
 *  ⑤ 清单锁步：盘上每个 *.test.ts / *.test.mjs 都出现在 GROUPS ∪ WIN32_FILES ∪
 *     MACOS_FILES 中（结构化成员判定）、组内无重复、清单文件都存在、
 *     ZERO_TEST_ALLOWLIST 条目有理由且指向真实文件。
 * 旧 ④（输出透传/组标题）折进 ③：同一 spawn 桩已断言透传内容。
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
  evaluateChildRun,
  runEntries,
} from './test.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 与 scripts/gates/verify-test-wiring.mjs 同款忽略目录（vendor/dist 里的
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

test('②b macOS 腿的跳过纪律：部分跳过在 requireNoSkips 下必须失败（G2）', () => {
  const partial = {
    status: 0, signal: null,
    stdout: 'ℹ tests 3\nℹ pass 2\nℹ fail 0\nℹ skipped 1\n', stderr: '',
  }
  // 非 macOS 腿沿用判定：有测试体执行即通过（win32 等平台腿确有合法 skip）。
  assert.deepEqual(evaluateChildRun('fixture.test.ts', partial), { ok: true })
  // macOS 腿：任一 skip 都是失败——跳过的是真前置（codesign/hdiutil/…），不是无关平台分支。
  const verdict = evaluateChildRun('fixture.test.ts', partial, undefined, { requireNoSkips: true })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /macOS 腿不得有跳过用例（skipped 1）/)
  // 零跳过仍是正常通过。
  assert.deepEqual(
    evaluateChildRun('fixture.test.ts', {
      status: 0, signal: null,
      stdout: 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0\n', stderr: '',
    }, undefined, { requireNoSkips: true }),
    { ok: true },
  )
})

test('②c runEntries：requireNoSkips 的跳过子进程在 runner 主循环里被判失败（G2）', () => {
  const spawn = () => ({ status: 0, signal: null, stdout: 'ℹ tests 2\nℹ pass 1\nℹ skipped 1\n', stderr: '', error: undefined })
  const macosVerdict = runEntries(
    [{ group: 'macos', file: 'build-swift-app.test.mjs', nodeArgs: [] }],
    { spawn, writeOut: () => {}, writeErr: () => {}, requireNoSkips: true },
  )
  assert.equal(macosVerdict.ok, false)
  assert.equal(macosVerdict.file, 'build-swift-app.test.mjs')
  assert.match(macosVerdict.reason, /跳过/)
  // 同一子进程在默认判定（win32/全量腿）下通过——规则只在 macOS 腿启用。
  assert.deepEqual(
    runEntries(
      [{ group: 'scripts', file: 'build-sidecar.test.mjs', nodeArgs: [] }],
      { spawn, writeOut: () => {}, writeErr: () => {} },
    ),
    { ok: true },
  )
})

test('③ runEntries：零测试子进程返回被判失败（守卫确实接在 runner 循环上）', () => {
  const calls = []
  const written = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    return { status: 0, signal: null, stdout: 'no tests here\n', stderr: '', error: undefined }
  }
  const verdict = runEntries(
    [{ group: 'fixture', file: 'zero.test.ts', nodeArgs: [] }],
    { spawn, writeOut: text => written.push(text), writeErr: text => written.push('ERR:' + text) },
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
  // 组标题在子进程输出之前写出（旧 ④ 的透传断言，同一 spawn 桩覆盖）。
  assert.equal(written[0], '\n=== fixture ===\n')
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
