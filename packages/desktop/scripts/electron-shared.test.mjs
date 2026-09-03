/**
 * electron-shared unit tests: pure path/platform helpers plus the override
 * and cached branches of ensureSharedElectronDist. The materialize branch
 * (real download/extract) is intentionally NOT exercised here — it needs the
 * network and is validated by the dev bootstrap smoke.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DIST_META_FILE,
  ELECTRON_CACHE_ROOT_ENV,
  ELECTRON_DIST_ENV,
  ELECTRON_PKG_DIR_ENV,
  distIsUsable,
  effectiveDownloadArch,
  ensureSharedElectronDist,
  platformExecutableName,
  resolveCacheRoot,
  sharedDistDirFor,
} from './electron-shared.mjs'

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'electron-shared-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('platformExecutableName per platform', () => {
  assert.equal(platformExecutableName('darwin'), 'Electron.app/Contents/MacOS/Electron')
  assert.equal(platformExecutableName('linux'), 'electron')
  assert.equal(platformExecutableName('win32'), 'electron.exe')
  assert.throws(() => platformExecutableName('freebsd'), /not available/)
})

test('resolveCacheRoot platform defaults and env override', () => {
  const home = '/home/u'
  assert.equal(
    resolveCacheRoot('darwin', {}, home),
    path.join(home, 'Library', 'Caches', 'dsh-chamber'),
  )
  assert.equal(
    resolveCacheRoot('linux', { XDG_CACHE_HOME: '/xdg' }, home),
    path.join('/xdg', 'dsh-chamber'),
  )
  assert.equal(
    resolveCacheRoot('linux', {}, home),
    path.join(home, '.cache', 'dsh-chamber'),
  )
  assert.equal(
    resolveCacheRoot('win32', { LOCALAPPDATA: 'C:\\AppData\\Local' }, home),
    path.join('C:\\AppData\\Local', 'dsh-chamber', 'Cache'),
  )
  const custom = '/custom/cache'
  assert.equal(
    resolveCacheRoot('darwin', { [ELECTRON_CACHE_ROOT_ENV]: custom }, home),
    custom,
  )
  assert.throws(() => resolveCacheRoot('freebsd', {}, home), /no cache root/)
})

test('sharedDistDirFor is versioned under the cache root with platform+arch', () => {
  const home = '/home/u'
  assert.equal(
    sharedDistDirFor('43.4.0', { platform: 'darwin', arch: 'arm64', env: {}, home }),
    path.join(home, 'Library', 'Caches', 'dsh-chamber', 'electron', 'v43.4.0-darwin-arm64'),
  )
})

test('distIsUsable requires matching marker and executable', () =>
  withTmp((root) => {
    const dist = path.join(root, 'dist')
    mkdirSync(dist, { recursive: true })
    const execRel = platformExecutableName(process.platform)
    const exec = path.join(dist, execRel)
    mkdirSync(path.dirname(exec), { recursive: true })
    writeFileSync(exec, '')
    const meta = { version: '43.4.0', platform: process.platform, arch: process.arch }
    // no marker yet
    assert.equal(distIsUsable(dist, '43.4.0', process.platform, process.arch), false)
    writeFileSync(path.join(dist, DIST_META_FILE), `${JSON.stringify(meta)}\n`)
    assert.equal(distIsUsable(dist, '43.4.0', process.platform, process.arch), true)
    // version mismatch → not usable
    assert.equal(distIsUsable(dist, '43.4.1', process.platform, process.arch), false)
    // corrupt marker → not usable
    writeFileSync(path.join(dist, DIST_META_FILE), 'not json\n')
    assert.equal(distIsUsable(dist, '43.4.0', process.platform, process.arch), false)
  }))

test('ensure uses DSH_CHAMBER_ELECTRON_DIST as-is', () =>
  withTmp(async (root) => {
    const execRel = platformExecutableName(process.platform)
    const dist = path.join(root, 'real-dist')
    const exec = path.join(dist, execRel)
    mkdirSync(path.dirname(exec), { recursive: true })
    writeFileSync(exec, 'x')
    const env = { [ELECTRON_DIST_ENV]: dist }
    const result = await ensureSharedElectronDist(env)
    assert.equal(result.status, 'override')
    assert.equal(result.distDir, dist)
  }))

test('ensure rejects a dist override without the platform executable', () =>
  withTmp(async (root) => {
    const dist = path.join(root, 'empty-dist')
    mkdirSync(dist, { recursive: true })
    const env = { [ELECTRON_DIST_ENV]: dist }
    await assert.rejects(() => ensureSharedElectronDist(env), /不存在可执行文件/)
  }))

test('ensure reuses a legacy local dist when the shared cache is cold', () =>
  withTmp(async (root) => {
    // Fake electron npm package with an old-flow local dist (dist/version +
    // executable, no shared cache). Offline machines keep working.
    const pkgDir = path.join(root, 'electron-pkg')
    const legacyDist = path.join(pkgDir, 'dist')
    const exec = path.join(legacyDist, platformExecutableName(process.platform))
    mkdirSync(path.dirname(exec), { recursive: true })
    writeFileSync(exec, 'x')
    writeFileSync(path.join(legacyDist, 'version'), 'v43.4.0\n')
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'electron', version: '43.4.0' }))
    const env = {
      [ELECTRON_PKG_DIR_ENV]: pkgDir,
      [ELECTRON_CACHE_ROOT_ENV]: path.join(root, 'cache'),
    }
    const result = await ensureSharedElectronDist(env)
    assert.equal(result.status, 'legacy')
    assert.equal(result.distDir, legacyDist)
  }))

test('ensure returns cached when marker and executable match', () =>
  withTmp(async (root) => {
    // Fake electron npm package (only version is read on the cached path).
    const pkgDir = path.join(root, 'electron-pkg')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'electron', version: '43.4.0' }))
    // Pre-materialized shared dist with matching marker. Arch must match the
    // implementation's effectiveDownloadArch() (Rosetta x64 node downloads
    // arm64), not raw process.arch.
    const cacheRoot = path.join(root, 'cache')
    const dist = sharedDistDirFor('43.4.0', { env: { [ELECTRON_CACHE_ROOT_ENV]: cacheRoot }, home: root })
    const exec = path.join(dist, platformExecutableName(process.platform))
    mkdirSync(path.dirname(exec), { recursive: true })
    writeFileSync(exec, 'x')
    writeFileSync(
      path.join(dist, DIST_META_FILE),
      `${JSON.stringify({ version: '43.4.0', platform: process.platform, arch: effectiveDownloadArch() })}\n`,
    )
    const env = {
      [ELECTRON_PKG_DIR_ENV]: pkgDir,
      [ELECTRON_CACHE_ROOT_ENV]: cacheRoot,
    }
    const result = await ensureSharedElectronDist(env)
    assert.equal(result.status, 'cached')
    assert.equal(result.distDir, dist)
  }))
