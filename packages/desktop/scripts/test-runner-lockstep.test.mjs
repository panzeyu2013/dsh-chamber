/**
 * test-runner-lockstep.test.mjs —— desktop 测试清单（scripts/test.mjs）锁步 +
 * 零测试守卫与 macOS 腿跳过纪律。
 *
 * 清单本身只保留数据表，判定与循环都在共享引擎
 * scripts/lib/test-manifest.mjs（引擎自测 scripts/lib/test-manifest.test.mjs 覆盖
 * 断言解析、零测试判定、平台腿与循环接线）。本文件因此只钉 desktop 独有的不变量：
 *  ② evaluateChildRun 的 fail-closed 负例（exit 0+无汇总 / tests 0 / 非 0 退出 /
 *     信号 / spawn error / allowlist 例外）——引擎实现，本包档为 executed；
 *  ②b macOS 腿 requireNoSkips：任一跳过硬失败，且只在 macOS 腿启用；
 *  ③ 清单接线源码锁：本包确实把平台腿、allowlist 与 macOS 跳过纪律交给共享引擎，
 *     且本地不持有 spawn 循环或本地判定；
 *  ⑤ 清单锁步：盘上每个 *.test.ts / *.test.mjs 都出现在 GROUPS ∪ WIN32_FILES ∪
 *     MACOS_FILES 中、组内无重复、清单文件都存在、ZERO_TEST_ALLOWLIST 条目
 *     有理由且指向真实文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS, WIN32_FILES, MACOS_FILES, ZERO_TEST_ALLOWLIST } from './test.mjs'
import { evaluateChildRun, manifestLockstepProblems } from '../../../scripts/lib/test-manifest.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNNER_SOURCE = readFileSync(new URL('./test.mjs', import.meta.url), 'utf8')

test('② evaluateChildRun：零测试 / 无法 spawn 一律失败，例外须显式放行', () => {
  const pass = { status: 0, signal: null, stdout: 'ℹ tests 1\nℹ pass 1\n', stderr: '' }
  assert.deepEqual(evaluateChildRun('fixture.test.ts', pass), { ok: true })
  // 全 skip 的文件报 tests 1 但没有任何测试体执行 → 必须失败
  // （只看 tests 的计数守卫会把它放过）。
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
  assert.deepEqual(evaluateChildRun('fixture.test.ts', partial), { ok: true })
  const verdict = evaluateChildRun('fixture.test.ts', partial, undefined, { requireNoSkips: true })
  assert.equal(verdict.ok, false)
  assert.match(verdict.reason, /macOS 腿不得有跳过用例（skipped 1）/)
  assert.deepEqual(
    evaluateChildRun('fixture.test.ts', {
      status: 0, signal: null,
      stdout: 'ℹ tests 3\nℹ pass 3\nℹ fail 0\nℹ skipped 0\n', stderr: '',
    }, undefined, { requireNoSkips: true }),
    { ok: true },
  )
})

test('③ 源码锁：本包把腿/allowlist/macOS 纪律交给共享引擎，本地无 spawn 循环与判定', () => {
  assert.ok(RUNNER_SOURCE.includes('runTestManifest({'), '清单必须委托共享 runner')
  assert.ok(RUNNER_SOURCE.includes('platformFiles: { win32: WIN32_FILES, macos: MACOS_FILES }'), '两条平台腿必须接线')
  assert.ok(RUNNER_SOURCE.includes('zeroTestAllowlist: ZERO_TEST_ALLOWLIST'), 'allowlist 必须交给引擎')
  assert.ok(RUNNER_SOURCE.includes("requireNoSkipsLegs: ['macos']"), 'macOS 腿跳过纪律必须交给引擎')
  assert.ok(RUNNER_SOURCE.includes('allowPlatformFilesOutsideGroups: true'), 'macos 是独立集合（darwin 锁/打包套件不在 GROUPS）')
  assert.ok(!RUNNER_SOURCE.includes('spawnSync'), '本地 spawn 循环必须已删除（单一 runner 引擎）')
  assert.ok(!RUNNER_SOURCE.includes('evaluateChildRun('), '本地不得再持有判定（判定属共享引擎）')
})

test('⑤ 清单锁步：盘上每个 desktop 测试文件都被接线、清单文件都存在、单表无重复', () => {
  // 单表内部不得重复（跨表重复——win-acl 同时属于全量与 win32 腿——按
  // test.mjs 头注释是刻意的）；macOS 是独立集合（allowPlatformFilesOutsideGroups）。
  assert.deepEqual(
    manifestLockstepProblems({
      packageRoot: PACKAGE_ROOT,
      groups: GROUPS,
      platformFiles: { win32: WIN32_FILES, macos: MACOS_FILES },
      allowlist: ZERO_TEST_ALLOWLIST,
    }),
    [],
  )
})
