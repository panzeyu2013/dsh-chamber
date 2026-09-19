/**
 * updater.ts part 3 — sanitizeErrorText, the electron-updater cache path
 * resolution, version comparison, cleanupStaleUpdateCache. Sibling parts:
 * updater.test.ts, updater-restart-install.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cachedUpdateVersion, cleanupStaleUpdateCache, compareChamberVersions, resolveUpdaterCacheDir, sanitizeErrorText, updaterCacheDirNameFromYaml, updaterCacheRoot } from '../../updater.ts'
import { makeController, waitFor } from '../support/updater-harness.ts'
test('sanitizeErrorText replaces POSIX absolute paths', () => {
  assert.equal(sanitizeErrorText('Cannot read /Users/example/Library/Caches/dsh-chamber-updater/x'), 'Cannot read [path]')
  assert.equal(sanitizeErrorText('a /opt/x and /usr/local/bin/y'), 'a [path] and [path]')
  assert.equal(sanitizeErrorText('/root/x at start'), '[path] at start')
})
test('sanitizeErrorText replaces Windows drive paths (backslash and forward slash)', () => {
  assert.equal(sanitizeErrorText('Cannot read C:\\Users\\foo\\AppData\\Local\\dsh-chamber-updater'), 'Cannot read [path]')
  assert.equal(sanitizeErrorText('err D:/workspace/x'), 'err [path]')
})
test('sanitizeErrorText leaves URLs intact (scheme, host and path segments)', () => {
  const tagUrl = 'https://github.com/panzeyu2013/dsh-chamber/releases/tag/v0.2.0'
  assert.equal(sanitizeErrorText(`failed ${tagUrl}`), `failed ${tagUrl}`)
  const downloadUrl = 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0/latest.yml'
  assert.equal(sanitizeErrorText(`Cannot download ${downloadUrl}: 404`), `Cannot download ${downloadUrl}: 404`)
})
test('sanitizeErrorText redacts paths next to URLs without touching the URL', () => {
  const downloadUrl = 'https://github.com/panzeyu2013/dsh-chamber/releases/download/v0.2.0/latest.yml'
  assert.equal(
    sanitizeErrorText(`Cannot download ${downloadUrl}: ENOENT /Users/x/Library/Caches/y`),
    `Cannot download ${downloadUrl}: ENOENT [path]`,
  )
})

// ---- Startup stale-download-cache cleanup (design 11, 2026-12) ----
test('updaterCacheDirNameFromYaml reads the baked scalar (plain/quoted) and refuses escapes', () => {
  assert.equal(
    updaterCacheDirNameFromYaml('owner: panzeyu2013\nprovider: github\nupdaterCacheDirName: \'@dsh-chamberdesktop-updater\'\n'),
    '@dsh-chamberdesktop-updater',
  )
  assert.equal(
    updaterCacheDirNameFromYaml('updaterCacheDirName: "dsh-chamberdesktop-updater"\n'),
    'dsh-chamberdesktop-updater',
  )
  assert.equal(updaterCacheDirNameFromYaml('owner: panzeyu2013\nprovider: github\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName:\n'), null)
  // A value must be a bare dir NAME — separators/dot-names would escape the
  // cache root and are refused (defense in depth even for a bundled yml).
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: ../evil\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: a/b\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: a\\b\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: ..\n'), null)
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: .\n'), null)
  // Inline comments are not part of the scalar.
  assert.equal(updaterCacheDirNameFromYaml('updaterCacheDirName: x-updater # keep\n'), 'x-updater')
})
test('updaterCacheRoot follows the electron-updater platform branches', () => {
  const env = (extra: Record<string, string> = {}) => ({ HOME: '/h', ...extra })
  assert.equal(updaterCacheRoot('darwin', env(), '/Users/t'), '/Users/t/Library/Caches')
  assert.equal(updaterCacheRoot('win32', env({ LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }), 'C:\\Users\\t'),
    'C:\\Users\\t\\AppData\\Local')
  assert.equal(updaterCacheRoot('win32', env(), 'C:\\Users\\t'), join('C:\\Users\\t', 'AppData', 'Local'))
  assert.equal(updaterCacheRoot('linux', env(), '/home/t'), join('/home', 't', '.cache'))
  assert.equal(updaterCacheRoot('linux', env({ XDG_CACHE_HOME: '/var/cache/x' }), '/home/t'), '/var/cache/x')
})
test('resolveUpdaterCacheDir: packaged + baked yml resolves the real cache dir; dev never resolves', async () => {
  const yml = 'owner: panzeyu2013\nrepo: dsh-chamber\nprovider: github\nupdaterCacheDirName: \'@dsh-chamberdesktop-updater\'\n'
  const read = async (path: string) => {
    assert.ok(path.endsWith(join('Resources', 'app-update.yml')) || path.endsWith('app-update.yml'), `unexpected read: ${path}`)
    return yml
  }
  const darwin = await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'darwin', home: '/Users/t', resourcesPath: '/Applications/dsh-chamber.app/Contents/Resources', readFile: read,
  })
  assert.equal(darwin, '/Users/t/Library/Caches/@dsh-chamberdesktop-updater')
  const win = await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }, home: 'C:\\Users\\t',
    resourcesPath: 'C:\\dsh-chamber\\resources', readFile: read,
  })
  assert.equal(win, join('C:\\Users\\t\\AppData\\Local', '@dsh-chamberdesktop-updater'))
  // Dev / unpacked shapes have no baked yml — nothing resolves.
  assert.equal(await resolveUpdaterCacheDir({ isPackaged: false, readFile: read }), null)
  // Unreadable yml → null (never throws).
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, resourcesPath: '/nonexistent', readFile: async () => { throw new Error('ENOENT') },
  }), null)
  // A refused (traversal) dir name → null.
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, home: '/Users/t', resourcesPath: '/r',
    readFile: async () => 'updaterCacheDirName: ../../evil\n',
  }), null)
})

test('resolveUpdaterCacheDir refuses a RELATIVE derived cache dir (crafted env roots → null, no deletion possible)', async () => {
  const yml = 'updaterCacheDirName: \'@dsh-chamberdesktop-updater\'\n'
  const read = async () => yml
  // A relative XDG_CACHE_HOME / LOCALAPPDATA / home makes the derived dir
  // relative too: return null (F7) so no deletion targets a relative path.
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'linux', env: { XDG_CACHE_HOME: 'relative/cache' }, home: 'relative/home',
    resourcesPath: '/opt/dsh-chamber/resources', readFile: read,
  }), null)
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'win32', env: { LOCALAPPDATA: 'Relative\\AppData\\Local' },
    resourcesPath: 'C:\\dsh-chamber\\resources', readFile: read,
  }), null)
  assert.equal(await resolveUpdaterCacheDir({
    isPackaged: true, platform: 'linux', env: {}, home: 'home-relative',
    resourcesPath: '/opt/dsh-chamber/resources', readFile: read,
  }), null)
})

test('cachedUpdateVersion reads the first canonical chamber version out of a cache file name', () => {
  assert.equal(cachedUpdateVersion('dsh-chamber-electron-0.2.2-arm64-mac.zip'), '0.2.2')
  assert.equal(cachedUpdateVersion('dsh-chamber-electron-0.2.2-beta.1-arm64-mac.zip'), '0.2.2-beta.1')
  assert.equal(cachedUpdateVersion('dsh-chamber-0.10.2-x64.zip'), '0.10.2')
  assert.equal(cachedUpdateVersion('dsh-chamber-latest-mac.zip'), null)
  assert.equal(cachedUpdateVersion('0.2.2'), '0.2.2')
  // An extra dotted tail stops the version at the separator; non-strings → null.
  assert.equal(cachedUpdateVersion('dsh-chamber-electron-0.2.2.1-arm64.zip'), '0.2.2')
  assert.equal(cachedUpdateVersion(null), null)
  assert.equal(cachedUpdateVersion(undefined), null)
  assert.equal(cachedUpdateVersion(42), null)
})

test('compareChamberVersions is numeric, beta-aware and refuse non-canonical input', () => {
  assert.equal(compareChamberVersions('0.2.2', '0.2.2'), 0)
  assert.ok((compareChamberVersions('0.2.3', '0.2.2') ?? 0) > 0)
  assert.ok((compareChamberVersions('0.2.2', '0.2.3') ?? 0) < 0)
  assert.ok((compareChamberVersions('0.2.10', '0.2.9') ?? 0) > 0, 'patch parts compare numerically')
  assert.ok((compareChamberVersions('1.0.0', '0.9.9') ?? 0) > 0)
  // Stable > beta of the same base; beta.N numeric.
  assert.ok((compareChamberVersions('0.2.2', '0.2.2-beta.1') ?? 0) > 0)
  assert.ok((compareChamberVersions('0.2.2-beta.1', '0.2.2') ?? 0) < 0)
  assert.ok((compareChamberVersions('0.2.2-beta.2', '0.2.2-beta.1') ?? 0) > 0)
  assert.equal(compareChamberVersions('0.2.2-beta.1', '0.2.2-beta.1'), 0)
  // Non-canonical → null (callers must not act).
  assert.equal(compareChamberVersions('0.2', '0.2.2'), null)
  assert.equal(compareChamberVersions('v0.2.2', '0.2.2'), null)
  assert.equal(compareChamberVersions('0.2.2-rc.1', '0.2.2'), null)
  assert.equal(compareChamberVersions('abc', '0.2.2'), null)
})

/** A fresh fake electron-updater cache tree under os.tmpdir(). */
async function makeCacheTree(dirName: string): Promise<{ root: string; cacheDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-updater-cache-test-'))
  return { root, cacheDir: join(root, dirName) }
}

async function writePendingInfo(cacheDir: string, fileName: string): Promise<void> {
  await mkdir(join(cacheDir, 'pending'), { recursive: true })
  await writeFile(join(cacheDir, 'pending', 'update-info.json'),
    JSON.stringify({ fileName, sha512: 'abc', isAdminRightsRequired: false }), 'utf8')
}

test('cleanupStaleUpdateCache removes the whole cache dir when the pending update is already installed', async () => {
  const { root, cacheDir } = await makeCacheTree('equal')
  try {
    await writePendingInfo(cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    await writeFile(join(cacheDir, 'update.zip'), 'x', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(cacheDir, '0.2.2'), true, 'pending == running → stale (already installed)')
    assert.equal(existsSync(cacheDir), false, 'the whole cache dir (incl. update.zip) must be removed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanupStaleUpdateCache removes an older pending update but keeps a newer one', async () => {
  const older = await makeCacheTree('older')
  try {
    await writePendingInfo(older.cacheDir, 'dsh-chamber-electron-0.2.1-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(older.cacheDir, '0.2.2'), true, 'pending older than running → stale')
    assert.equal(existsSync(older.cacheDir), false)
  } finally {
    await rm(older.root, { recursive: true, force: true })
  }
  const newer = await makeCacheTree('newer')
  try {
    await writePendingInfo(newer.cacheDir, 'dsh-chamber-electron-0.2.3-arm64-mac.zip')
    await writeFile(join(newer.cacheDir, 'update.zip'), 'x', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(newer.cacheDir, '0.2.2'), false,
      'a genuinely newer pending update must never be deleted')
    assert.equal(existsSync(join(newer.cacheDir, 'update.zip')), true, 'cache must stay untouched')
    const kept = await readFile(join(newer.cacheDir, 'pending', 'update-info.json'), 'utf8')
    assert.ok(kept.includes('0.2.3'), 'pending metadata must stay untouched')
  } finally {
    await rm(newer.root, { recursive: true, force: true })
  }
})

test('cleanupStaleUpdateCache keeps the cache when nothing is provably stale', async () => {
  // No pending metadata at all (only the squirrel-serving zip).
  const noInfo = await makeCacheTree('no-info')
  try {
    await mkdir(noInfo.cacheDir, { recursive: true })
    await writeFile(join(noInfo.cacheDir, 'update.zip'), 'x', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(noInfo.cacheDir, '0.2.2'), false)
    assert.equal(existsSync(join(noInfo.cacheDir, 'update.zip')), true)
  } finally {
    await rm(noInfo.root, { recursive: true, force: true })
  }
  // Missing metadata file.
  const noFile = await makeCacheTree('no-file')
  try {
    assert.equal(await cleanupStaleUpdateCache(noFile.cacheDir, '0.2.2'), false)
  } finally {
    await rm(noFile.root, { recursive: true, force: true })
  }
  // Corrupt JSON.
  const corrupt = await makeCacheTree('corrupt')
  try {
    await mkdir(join(corrupt.cacheDir, 'pending'), { recursive: true })
    await writeFile(join(corrupt.cacheDir, 'pending', 'update-info.json'), '{not json', 'utf8')
    assert.equal(await cleanupStaleUpdateCache(corrupt.cacheDir, '0.2.2'), false)
    assert.equal(existsSync(join(corrupt.cacheDir, 'pending', 'update-info.json')), true)
  } finally {
    await rm(corrupt.root, { recursive: true, force: true })
  }
  // Version-less file name.
  const noVersion = await makeCacheTree('no-version')
  try {
    await writePendingInfo(noVersion.cacheDir, 'dsh-chamber-latest-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(noVersion.cacheDir, '0.2.2'), false)
  } finally {
    await rm(noVersion.root, { recursive: true, force: true })
  }
  // Beta semantics: running stable 0.2.2 makes a pending 0.2.2-beta.1 stale
  // (superseded); running 0.2.2-beta.1 keeps a pending stable 0.2.2.
  const betaStale = await makeCacheTree('beta-stale')
  try {
    await writePendingInfo(betaStale.cacheDir, 'dsh-chamber-electron-0.2.2-beta.1-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(betaStale.cacheDir, '0.2.2'), true)
    assert.equal(existsSync(betaStale.cacheDir), false)
  } finally {
    await rm(betaStale.root, { recursive: true, force: true })
  }
  const betaFresh = await makeCacheTree('beta-fresh')
  try {
    await writePendingInfo(betaFresh.cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(betaFresh.cacheDir, '0.2.2-beta.1'), false,
      'a pending stable 0.2.2 is still newer than a running 0.2.2-beta.1')
  } finally {
    await rm(betaFresh.root, { recursive: true, force: true })
  }
})


test('cleanupStaleUpdateCache tolerates shape-less JSON content and removal failures (never throws)', async () => {
  // null/arrays/scalars are valid JSON: reading `.fileName` off them must not
  // throw, or the "never throws / keep when not provably stale" contract breaks.
  for (const content of ['null', '[]', '"a string"', '42', '{}', '{"sha512":"abc"}', '{"fileName":42}']) {
    const { root, cacheDir } = await makeCacheTree('shape-guard')
    try {
      await mkdir(join(cacheDir, 'pending'), { recursive: true })
      await writeFile(join(cacheDir, 'pending', 'update-info.json'), content, 'utf8')
      await writeFile(join(cacheDir, 'update.zip'), 'x', 'utf8')
      assert.equal(await cleanupStaleUpdateCache(cacheDir, '0.2.2'), false, `content ${content} must keep the cache`)
      assert.equal(existsSync(join(cacheDir, 'update.zip')), true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  // A failing removal reports false instead of throwing.
  const failing = await makeCacheTree('rm-fail')
  try {
    await writePendingInfo(failing.cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    assert.equal(await cleanupStaleUpdateCache(failing.cacheDir, '0.2.2', {
      removeTree: async () => { throw new Error('EACCES /private/var') },
    }), false)
    assert.equal(existsSync(failing.cacheDir), true, 'a failed removal leaves the cache intact')
  } finally {
    await rm(failing.root, { recursive: true, force: true })
  }
})

test('controller startup cleans a stale injected cache dir and skips when disabled', async () => {
  const stale = await makeCacheTree('controller-stale')
  try {
    await writePendingInfo(stale.cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    const { controller } = makeController({ version: '0.2.2', deps: { staleCache: { cacheDir: stale.cacheDir } } })
    assert.equal(controller.state().phase, 'idle', 'controller construction is not affected by the cleanup')
    assert.equal(await waitFor(() => !existsSync(stale.cacheDir)), true,
      'the controller must asynchronously remove the stale cache dir')
  } finally {
    await rm(stale.root, { recursive: true, force: true })
  }
  // { cacheDir: null } disables the cleanup entirely.
  const kept = await makeCacheTree('controller-kept')
  try {
    await writePendingInfo(kept.cacheDir, 'dsh-chamber-electron-0.2.2-arm64-mac.zip')
    const { controller } = makeController({ version: '0.2.2', deps: { staleCache: { cacheDir: null } } })
    assert.equal(controller.state().phase, 'idle')
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(existsSync(kept.cacheDir), true, 'a null staleCache override must disable the cleanup')
  } finally {
    await rm(kept.root, { recursive: true, force: true })
  }
})
