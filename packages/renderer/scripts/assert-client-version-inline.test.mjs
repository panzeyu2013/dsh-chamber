/**
 * G02 残留：构建产物内联断言脚本的回归。
 *
 * 机器门 `assert-client-version-inline.mjs` 负责把「这次构建有没有真正把
 * DSH_CLIENT_VERSION 折进产物」变成构建失败；本测试用 fixture 临时目录锁
 * 三件事：命中（literal 在）/ 缺失（define 未生效）/ 残留（process.env 引用或
 * `he.DSH_CLIENT_VERSION` 折叠），并穿过 CLI 断言退出码与重建提示。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_ASSETS_DIR,
  REBUILD_COMMAND,
  inspectClientVersionInline,
} from './assert-client-version-inline.mjs'
import { resolveDshClientVersion } from './dsh-client-version.mjs'

const SCRIPT = fileURLToPath(new URL('./assert-client-version-inline.mjs', import.meta.url))
const expectedVersion = resolveDshClientVersion()

/** 在临时目录下按 {文件名: 内容} 写一组产物，返回 {dir}（调用方清理）。 */
function fixtureAssets(files) {
  const dir = mkdtempSync(join(tmpdir(), 'chamber-client-version-inline-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

/** 跑 CLI（fixture 目录），返回 { status, stdout, stderr }。 */
function runCli(assetsDir) {
  return spawnSync(process.execPath, [SCRIPT, '--assets-dir', assetsDir], { encoding: 'utf8' })
}

test('命中：产物含期望版本字面量 → 通过（纯函数 + CLI exit 0）', () => {
  const dir = fixtureAssets({
    'index-hit.js': 'const v=' + JSON.stringify(expectedVersion) + ';',
    'other.js': 'export const unrelated = 1;',
  })
  try {
    const verdict = inspectClientVersionInline({ assetsDir: dir, expectedVersion })
    assert.equal(verdict.ok, true)
    assert.deepEqual(verdict.literalFiles, ['index-hit.js'])
    assert.deepEqual(verdict.residuals, [])
    const result = runCli(dir)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /client version inline: /u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('缺失：产物没有期望版本字面量 → 失败（define 未生效）', () => {
  const dir = fixtureAssets({ 'index-miss.js': 'const v=undefined;' })
  try {
    const verdict = inspectClientVersionInline({ assetsDir: dir, expectedVersion })
    assert.equal(verdict.ok, false)
    assert.match(verdict.problems.join('\n'), /没有任何产物内联期望版本/u)
    const result = runCli(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, new RegExp('重建：' + REBUILD_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('残留 process.env.DSH_CLIENT_VERSION → 失败（未替换的 define 引用）', () => {
  const dir = fixtureAssets({
    'index-ok.js': 'const v=' + JSON.stringify(expectedVersion) + ';',
    'index-residual.js': 'if (process.env.DSH_CLIENT_VERSION) {}',
  })
  try {
    const verdict = inspectClientVersionInline({ assetsDir: dir, expectedVersion })
    assert.equal(verdict.ok, false)
    assert.ok(verdict.residuals.some(item => item.kind === 'process-env'))
    const result = runCli(dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /process\.env\.DSH_CLIENT_VERSION/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('残留 .DSH_CLIENT_VERSION 空对象折叠（he.DSH_CLIENT_VERSION）→ 失败', () => {
  const dir = fixtureAssets({
    'index-ok.js': 'const v=' + JSON.stringify(expectedVersion) + ';',
    'index-folded.js': 'var he={};const v=he.DSH_CLIENT_VERSION;',
  })
  try {
    const verdict = inspectClientVersionInline({ assetsDir: dir, expectedVersion })
    assert.equal(verdict.ok, false)
    assert.ok(verdict.residuals.some(item => item.kind === 'folded-member'))
    const result = runCli(dir)
    assert.equal(result.status, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('产物目录缺失 / 期望版本为空 → fail loud', () => {
  const missing = join(tmpdir(), 'chamber-client-version-inline-missing-' + String(process.pid))
  const verdict = inspectClientVersionInline({ assetsDir: missing, expectedVersion })
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join('\n'), /产物目录不存在/u)
  const result = runCli(missing)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /G02 构建产物断言失败/u)
  assert.throws(() => inspectClientVersionInline({ assetsDir: missing, expectedVersion: '' }), /expectedVersion/u)
})

test('默认目录指向 renderer 的 dist/web/assets（构建链落点）', () => {
  assert.ok(DEFAULT_ASSETS_DIR.endsWith(join('packages', 'desktop', 'dist', 'web', 'assets')), DEFAULT_ASSETS_DIR)
})

test('build 链源码锁：assert 门紧跟 vite build 且在 gen-boot-manifest 之前', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const build = pkg.scripts?.build
  assert.equal(typeof build, 'string', 'renderer package.json 必须保留 build 脚本')
  const gateStep = 'node scripts/assert-client-version-inline.mjs'
  const bootStep = 'node scripts/gen-boot-manifest.mjs'
  assert.ok(
    build.includes('vite build && ' + gateStep),
    'build 链必须在 vite build 之后立即跑 assert 门（删掉/挪走即红）：' + build,
  )
  const gateAt = build.indexOf(gateStep)
  const bootAt = build.indexOf(bootStep)
  assert.ok(bootAt > gateAt, 'assert 门必须在 gen-boot-manifest 之前（坏产物不得继续生成 boot manifest）：' + build)
  // 旧式漏接（只有 gate 文件、build 链没接）也是红：上面 includes 已锁定顺序形态。
})

