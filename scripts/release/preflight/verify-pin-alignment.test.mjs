/**
 * verify-pin-alignment.mjs 的 CLI 级单测：正例 + 两个负向对照（payload 漂移 / vendor 缺失）。
 * fixture 是 /tmp 里的最小仓库树；脚本按自身位置解析 ROOT，因此整棵 fixture 自包含、不读本仓。
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(here, './verify-pin-alignment.mjs')
const PIN = 'a'.repeat(40)
const DSH = '7.7.7'
const PNPM = '9.9.9'
const KIT = '0.1.5'

const macTarget = {
  nodeArchive: 'darwin-arm64.tar.gz',
  nodeSha256: 'b'.repeat(64),
  pythonTarget: 'aarch64-apple-darwin',
  pythonSha256: 'c'.repeat(64),
  wheels: [{ url: 'https://example.invalid/numpy.whl', sha256: 'd'.repeat(64) }],
}
const pythonPackages = { numpy: '2.3.5', pandas: '3.0.1' }
const crossWheels = [{ url: 'https://example.invalid/six.whl', sha256: 'e'.repeat(64) }]
const lock = {
  provenance: { upstreamCommit: PIN },
  nodeVersion: '1.2.3',
  pythonVersion: '3.12.14',
  pythonRelease: '20260901',
  pythonPackages,
  targets: { 'mac-arm64': macTarget },
  wheels: crossWheels,
}
const upstreamLock = {
  ...lock,
  targets: { ...lock.targets, 'win-x64': { ...macTarget, nodeArchive: 'win-x64.zip' } },
}
const kitLines = [
  "'@deepseek-ai/libreoffice-kit@" + KIT + "':",
  "'@deepseek-ai/libreoffice-kit-darwin-arm64@" + KIT + "':",
  "'@deepseek-ai/libreoffice-kit-darwin-x64@" + KIT + "':",
  "'@deepseek-ai/libreoffice-kit-wasm@" + KIT + "':",
  "'@deepseek-ai/libreoffice-kit-win32-arm64@" + KIT + "':",
  "'@deepseek-ai/libreoffice-kit-win32-x64@" + KIT + "':",
].join('\n')

function write(root, rel, content) {
  const file = path.join(root, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-pin-fixture-'))
  write(root, 'harness.commit', '# pinned upstream\n' + PIN + '\n')
  write(root, 'packages/desktop/primary-runtime-lock.json', JSON.stringify(lock, null, 2))
  write(root, 'vendor/harness-checkout/scripts/primary-runtime/lock.json', JSON.stringify(upstreamLock, null, 2))
  write(root, 'package.json', JSON.stringify({ packageManager: 'pnpm@' + PNPM }))
  write(root, 'packages/desktop/package.json', JSON.stringify({ dependencies: { pnpm: PNPM } }))
  write(root, 'packages/gateway/package.json', JSON.stringify({ dependencies: { pnpm: PNPM }, dshAnchorVersion: DSH }))
  write(root, 'packages/desktop/scripts/bundle-dsh.mjs',
    "const BUNDLE_PNPM_VERSION = '" + PNPM + "';\nfunction lockfileDshVersion() {\n  return '" + DSH + "';\n}\n")
  write(root, 'packages/desktop/vendor/dsh/pnpm-lock.yaml',
    "'@deepseek-ai/dsh':\n        specifier: " + DSH + "\n" + kitLines + "\n")
  write(root, '.github/workflows/ci.yml',
    '- uses: pnpm/action-setup@' + 'f'.repeat(40) + '\n        with:\n          version: ' + PNPM + '\n')
  write(root, '.github/workflows/release.yml', 'env:\n  DSH_CHAMBER_DSH_VERSION: ' + DSH + '\n')
  write(root, 'scripts/install-gateway.sh',
    'DSH_CHAMBER_DSH_VERSION="${DSH_CHAMBER_DSH_VERSION:-' + DSH + '}"\n')
  write(root, 'vendor/harness-checkout/apps/cli/package.json', JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH }))
  write(root, 'vendor/harness-checkout/pnpm-lock.yaml', kitLines + '\n')
  mkdirSync(path.join(root, 'scripts', 'release', 'preflight'), { recursive: true })
  copyFileSync(SCRIPT, path.join(root, 'scripts', 'release', 'preflight', 'verify-pin-alignment.mjs'))
  return root
}

function run(root) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'release', 'preflight', 'verify-pin-alignment.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('verify-pin-alignment：fixture 正例 exit 0', () => {
  const root = fixture()
  try {
    const result = run(root)
    assert.equal(result.status, 0, result.stderr + result.stdout)
    assert.match(result.stdout, /pin 对齐检查通过/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verify-pin-alignment：payload nodeVersion 漂移 → exit 1 + DRIFT 行', () => {
  const root = fixture()
  try {
    write(root, 'packages/desktop/primary-runtime-lock.json',
      JSON.stringify({ ...lock, nodeVersion: '9.9.9' }, null, 2))
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /nodeVersion/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('verify-pin-alignment：vendor pin 树缺失 → exit 1 且报子模块未初始化', () => {
  const root = fixture()
  try {
    rmSync(path.join(root, 'vendor', 'harness-checkout', 'scripts', 'primary-runtime', 'lock.json'), { force: true })
    const result = run(root)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /pin 子模块未初始化/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
