/**
 * G02 回归：`DSH_CLIENT_VERSION` 的构建期单源（已提交运行时锁文件）。
 *
 * 行为锁：
 *  - `resolveDshClientVersion()` 返回**已提交**的随包 dsh 运行时锁文件
 *    （`packages/desktop/vendor/dsh/pnpm-lock.yaml` 根 importer）里的
 *    `@deepseek-ai/dsh` 精确版本，与独立读取的锁文件值逐字相等（测试不写版本
 *    字面量，pin 升级不需要改测试）；
 *  - clean checkout 条件：临时根**只放锁文件**（没有 `bundle:dsh` 生成的运行树
 *    清单）也能解析——版本源不得依赖任何生成物；
 *  - 缺文件 / 坏内容 / 缺 importers / 缺根 importer / 缺依赖条目 / 空或非法版本
 *    全部 fail loud；range/workspace specifier 回退到已安装的纯版本（peer hash 不算版本）；
 *  - 双解析漂移护栏：helper 与 `packages/desktop/scripts/bundle-dsh.mjs` 的
 *    `lockfileDshVersion` 对同一份**已提交** lockfile 必须得到同一版本；并用
 *    「packages 区先出现别的 @deepseek-ai/dsh@ 版本」的 fixture 钉住两侧语义差异
 *    （bundle-dsh = 整个文本首个正则命中；helper = 根 importer 声明），避免把
 *    「恰好同值」误读成「同一解析」；
 *  - `vite.config.mjs` 的 define 必须走该 helper，且配置/helper 源码里不存在
 *    硬编码的 dsh 版本或 chamber 版本文本，也没有兜底版本字面量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_RUNTIME_LOCKFILE_RELATIVE, resolveDshClientVersion } from './dsh-client-version.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** 独立读一遍已提交锁文件（不经过被测函数），避免测试自身成为版本字面量。 */
function pinnedDshVersion() {
  const text = readFileSync(join(REPO_ROOT, DSH_RUNTIME_LOCKFILE_RELATIVE), 'utf8')
  const match = /'@deepseek-ai\/dsh':\n\s+specifier: ([^\s]+)\n/u.exec(text)
  assert.ok(match !== null, 'committed pnpm-lock.yaml must carry the root importer @deepseek-ai/dsh specifier')
  return match[1]
}

/**
 * 抽取 `bundle-dsh.mjs` 里 `lockfileDshVersion` 用的正则字面量（C10 anchor 所在源码）。
 * 不复制、不改该脚本：护栏读它的真实文本，脚本改了正则即红。
 * @returns 从源码抽出的 RegExp（无 flags，与源码字面量一致）。
 */
function bundleDshLockfilePattern() {
  const source = readFileSync(join(REPO_ROOT, 'packages/desktop/scripts/bundle-dsh.mjs'), 'utf8')
  const fnAt = source.indexOf('function lockfileDshVersion')
  assert.ok(fnAt >= 0, 'bundle-dsh.mjs 必须仍有 lockfileDshVersion（C10 anchor 源码）——锚点失效即停，重写本护栏')
  const fnEnd = source.indexOf('\n}', fnAt)
  assert.ok(fnEnd > fnAt, 'bundle-dsh.mjs lockfileDshVersion 函数体边界不可解析')
  const body = source.slice(fnAt, fnEnd)
  const regexLiteral = /const match = (\/(?:[^\/\\]|\\.)+\/)\.exec\(text\)/u.exec(body)
  assert.ok(regexLiteral !== null, 'bundle-dsh.mjs 的 lockfileDshVersion 正则字面量抽不出来——护栏失效即停（改锚点/改断言，不许静默跳过）')
  return { pattern: new RegExp(regexLiteral[1].slice(1, -1)), body }
}

/** 构造一份 pnpm v9 形状的锁文件文本（fixtures 用；默认正常版本）。 */
function lockfileText({
  version = '1.2.3',
  specifier = version,
  importer = true,
  dependency = true,
  extraImporters = '',
  prefix = '',
} = {}) {
  if (!importer) return prefix + 'lockfileVersion: ' + "'9.0'" + '\n\npackages: {}\n'
  const dependencyBlock = dependency
    ? '      ' + "'@deepseek-ai/dsh':" + '\n' +
      '        specifier: ' + specifier + '\n' +
      '        version: ' + version + '(0123456789abcdef)\n'
    : ''
  return prefix + 'lockfileVersion: ' + "'9.0'" + '\n\nimporters:\n\n  .:\n    dependencies:\n' + dependencyBlock + extraImporters + '\npackages: {}\n'
}

/** 在临时仓库根下写一份锁文件，返回临时根（调用方负责清理）。 */
function fixtureRoot(text) {
  const root = mkdtempSync(join(tmpdir(), 'chamber-dsh-client-version-'))
  const dir = join(root, 'packages/desktop/vendor/dsh')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pnpm-lock.yaml'), text)
  return root
}

test('resolveDshClientVersion 返回已提交锁文件根 importer 的 @deepseek-ai/dsh 版本', () => {
  const version = resolveDshClientVersion()
  assert.equal(version, pinnedDshVersion(), 'G02 版本必须等于已提交运行时锁文件 pin，不得使用其他来源')
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u, '版本应是精确 semver')
})

test('clean checkout：临时根只有已提交锁文件（无 bundle:dsh 生成物）也能解析', () => {
  const root = fixtureRoot(lockfileText({ version: '9.9.9-rc.1' }))
  try {
    assert.equal(resolveDshClientVersion(root), '9.9.9-rc.1')
    assert.equal(existsSync(join(root, 'packages/desktop/vendor/dsh/package.json')), false, 'fixture 不应需要运行树清单')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('锁文件缺失 → fail loud（含路径）', () => {
  const root = mkdtempSync(join(tmpdir(), 'chamber-dsh-client-version-missing-'))
  try {
    assert.throws(() => resolveDshClientVersion(root), (error) => {
      assert.match(String(error.message), /读不到已提交的随包 dsh 运行时锁文件/u)
      assert.ok(String(error.message).includes(join(root, DSH_RUNTIME_LOCKFILE_RELATIVE)))
      return true
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('坏内容 / 缺 importers → fail loud', () => {
  for (const [name, text] of [
    ['坏内容', 'not: [yaml'],
    ['缺 importers', lockfileText({ importer: false })],
  ]) {
    const root = fixtureRoot(text)
    try {
      assert.throws(() => resolveDshClientVersion(root), (error) => {
        assert.match(String(error.message), /importers/u, name)
        return true
      }, name)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('缺根 importer / 缺依赖条目 → fail loud', () => {
  const noRoot = fixtureRoot(lockfileText({ extraImporters: '\n  packages/ui:\n    dependencies: {}\n' }).replace('  .:\n    dependencies:\n', ''))
  try {
    assert.throws(() => resolveDshClientVersion(noRoot), /根 importer/u)
  } finally {
    rmSync(noRoot, { recursive: true, force: true })
  }
  const noDependency = fixtureRoot(lockfileText({ dependency: false }))
  try {
    assert.throws(() => resolveDshClientVersion(noDependency), /'@deepseek-ai\/dsh' 依赖条目/u)
  } finally {
    rmSync(noDependency, { recursive: true, force: true })
  }
})

test('空 / 非法版本 → fail loud（不兜底字面量）', () => {
  for (const [name, text] of [
    ['空版本', lockfileText({ version: '', specifier: '' })],
    ['非法版本', lockfileText({ version: 'latest', specifier: 'latest' })],
    ['range', lockfileText({ version: '^1.2.3', specifier: '^1.2.3' })],
  ]) {
    const root = fixtureRoot(text)
    try {
      assert.throws(() => resolveDshClientVersion(root), /dsh client version:/u, name)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('range/workspace specifier → 回退到已安装纯版本（peer hash 去掉）', () => {
  for (const [name, specifier, version, expected] of [
    ['caret range', '^1.2.3', '1.2.3(abcdef012345)', '1.2.3'],
    ['workspace prot', 'workspace:*', '2.0.0-rc.1(peer@1)', '2.0.0-rc.1'],
  ]) {
    const root = fixtureRoot(lockfileText({ specifier, version }))
    try {
      assert.equal(resolveDshClientVersion(root), expected, name)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('双解析漂移护栏：helper 与 bundle-dsh lockfileDshVersion 在同一已提交 lockfile 上同版本', () => {
  const { pattern, body } = bundleDshLockfilePattern()
  const lockfile = readFileSync(join(REPO_ROOT, DSH_RUNTIME_LOCKFILE_RELATIVE), 'utf8')
  const bundleParsed = pattern.exec(lockfile)
  assert.ok(bundleParsed !== null, 'bundle-dsh 正则应命中已提交 lockfile（同源版本面）')
  const helperVersion = resolveDshClientVersion()
  assert.equal(bundleParsed[1], helperVersion, '两处解析漂移：dsh-client-version.mjs 与 bundle-dsh.mjs lockfileDshVersion 必须同版本')
  // C10 anchor：bundle-dsh 的兜底字面量必须与 pin 同步（该字面量是运行时锚，不是可漂移副本）。
  const fallback = /return '([0-9][^']*)'/u.exec(body)
  assert.ok(fallback !== null, 'bundle-dsh.mjs lockfileDshVersion 的兜底版本字面量抽不出来（C10 anchor）')
  assert.equal(fallback[1], helperVersion, 'bundle-dsh 兜底字面量与 lockfile pin 漂移（C10 会红；本护栏提前暴露）')
})

test('双解析语义差异 fixture：packages 区先出现其它 @deepseek-ai/dsh@ 版本时，helper 仍取根 importer', () => {
  // bundle-dsh 的 lockfileDshVersion 是对整个 lockfile 文本的「首个 @deepseek-ai/dsh@<semver>」
  // 正则命中；本 helper 只读根 importer 声明。两者当前在已提交 lockfile 上恰好同值（上一测试），
  // 但语义不同：该 fixture 把 packages 区放在 importers 之前，锁住两侧行为差异，避免把
  // 「同值」误当成「同一解析」而掩盖未来锁文件布局变化。
  const fixture = lockfileText({
    version: '1.2.3',
    specifier: '1.2.3',
    prefix: "lockfileVersion: '9.0'\n\npackages:\n\n  '@deepseek-ai/dsh@9.9.9': {}\n\n",
  })
  const root = fixtureRoot(fixture)
  try {
    assert.equal(resolveDshClientVersion(root), '1.2.3', 'helper 必须取根 importer 的声明版本')
    const { pattern } = bundleDshLockfilePattern()
    assert.equal(pattern.exec(fixture)[1], '9.9.9', 'bundle-dsh 正则取全文首个命中（语义差异的锚）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vite.config.mjs / helper：走 helper、读已提交 lockfile、无硬编码/兜底版本字面量', () => {
  const config = readFileSync(new URL('../vite.config.mjs', import.meta.url), 'utf8')
  assert.match(
    config,
    /import \{ resolveDshClientVersion \} from '\.\/scripts\/dsh-client-version\.mjs'/u,
    '配置必须 import G02 helper',
  )
  const defineAt = config.indexOf('define: {')
  const keyAt = config.indexOf("'process.env.DSH_CLIENT_VERSION'")
  assert.ok(defineAt >= 0, '配置必须保留 define 块')
  assert.ok(keyAt > defineAt, 'DSH_CLIENT_VERSION define 必须在 define 块内')
  assert.match(
    config,
    /'process\.env\.DSH_CLIENT_VERSION': JSON\.stringify\(resolveDshClientVersion\(\)\)/u,
    'DSH_CLIENT_VERSION 必须由 helper 提供，不能写死',
  )
  assert.match(config, /已提交的运行时锁文件|pnpm-lock\.yaml/u, '配置注释必须指认已提交锁文件为版本源')
  const helperSource = readFileSync(new URL('./dsh-client-version.mjs', import.meta.url), 'utf8')
  assert.match(helperSource, /pnpm-lock\.yaml/u, 'helper 的版本源必须是已提交 lockfile')
  assert.doesNotMatch(helperSource, /vendor\/dsh\/package\.json/u, 'helper 不得再读 bundle:dsh 生成的运行树清单')
  const chamberVersion = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version
  for (const candidate of [config, helperSource]) {
    for (const version of [pinnedDshVersion(), chamberVersion]) {
      assert.equal(candidate.includes(version), false, '源码不得硬编码版本字面量 ' + version)
    }
  }
})
