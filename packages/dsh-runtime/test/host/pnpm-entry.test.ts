/**
 * pnpm-entry.ts 单测：共享 pnpm 入口候选顺序 + 存在性解析（design 18 §9.2
 * D1）。纯逻辑（临时目录做文件系统形状），无 electron/网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pnpmEntryCandidates, resolvePnpmEntry } from '../../src/pnpm-entry.ts'

/** Touch a file, creating its parents. */
function touch(file: string): string {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, '')
  return file
}

test('pnpmEntryCandidates: full POSIX order bundled → resources → explicit → dev → legacy → installer roots', () => {
  const entries = pnpmEntryCandidates({
    platform: 'linux',
    execPath: '/usr/bin/node',
    env: { LOCALAPPDATA: '/home/u/.local/share', APPDATA: '/home/u/.config' },
    bundledDir: '/app/dist',
    resourcesPath: '/app/resources',
    explicitEntries: ['/repo/node_modules/pnpm/bin/pnpm.cjs'],
    moduleDir: '/repo/packages/desktop',
    legacyPackagedDir: '/app/legacy',
  })
  assert.deepEqual(entries, [
    '/app/dist/pnpm/bin/pnpm.cjs',
    '/app/resources/pnpm/bin/pnpm.cjs',
    '/repo/node_modules/pnpm/bin/pnpm.cjs',
    '/repo/packages/desktop/node_modules/pnpm/bin/pnpm.cjs',
    '/app/legacy/pnpm/bin/pnpm.cjs',
    '/home/u/.local/share/node_modules/pnpm/bin/pnpm.cjs',
    '/home/u/.config/node_modules/pnpm/bin/pnpm.cjs',
    '/usr/bin/node_modules/pnpm/bin/pnpm.cjs',
  ])
})

test('pnpmEntryCandidates: win32 joins by the TARGET platform, not the host', () => {
  const entries = pnpmEntryCandidates({
    platform: 'win32',
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local', APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' },
    resourcesPath: 'C:\\app\\resources',
    moduleDir: 'C:\\app\\resources\\app.asar',
  })
  assert.deepEqual(entries, [
    'C:\\app\\resources\\pnpm\\bin\\pnpm.cjs',
    'C:\\app\\resources\\app.asar\\node_modules\\pnpm\\bin\\pnpm.cjs',
    'C:\\Users\\alice\\AppData\\Local\\node_modules\\pnpm\\bin\\pnpm.cjs',
    'C:\\Users\\alice\\AppData\\Roaming\\node_modules\\pnpm\\bin\\pnpm.cjs',
    'C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs',
  ])
})

test('pnpmEntryCandidates: absent and empty shapes contribute nothing beyond the execPath root', () => {
  assert.deepEqual(
    pnpmEntryCandidates({ platform: 'linux', execPath: '/usr/bin/node', env: {} }),
    ['/usr/bin/node_modules/pnpm/bin/pnpm.cjs'],
  )
  assert.deepEqual(
    pnpmEntryCandidates({
      platform: 'linux',
      execPath: '/usr/bin/node',
      env: { LOCALAPPDATA: '', APPDATA: '' },
      bundledDir: '',
      resourcesPath: null,
      moduleDir: null,
      legacyPackagedDir: undefined,
      explicitEntries: [''],
    }),
    ['/usr/bin/node_modules/pnpm/bin/pnpm.cjs'],
  )
})

test('resolvePnpmEntry: bundled → explicit → dev priority; all missing → candidates[0]', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-entry-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bundledDir = join(root, 'dist')
  const explicit = join(root, 'repo', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const moduleDir = join(root, 'desktop')
  const dev = join(moduleDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const search = {
    platform: 'linux' as const,
    execPath: '/usr/bin/node',
    env: {},
    bundledDir,
    explicitEntries: [explicit],
    moduleDir,
  }
  assert.equal(
    resolvePnpmEntry(search),
    join(bundledDir, 'pnpm', 'bin', 'pnpm.cjs'),
    'every candidate absent → candidates[0] (the caller keeps its loud-failure semantics)',
  )
  touch(dev)
  assert.equal(resolvePnpmEntry(search), dev, 'dev module tree is the first real fallback')
  touch(explicit)
  assert.equal(resolvePnpmEntry(search), explicit, 'explicit entries outrank the dev module tree')
  const bundled = touch(join(bundledDir, 'pnpm', 'bin', 'pnpm.cjs'))
  assert.equal(resolvePnpmEntry(search), bundled, 'the bundled copy outranks package resolution')
  const resources = touch(join(root, 'resources', 'pnpm', 'bin', 'pnpm.cjs'))
  assert.equal(resolvePnpmEntry({ ...search, resourcesPath: join(root, 'resources') }), bundled, 'bundled still outranks resources')
  rmSync(join(bundledDir, 'pnpm'), { recursive: true, force: true })
  assert.equal(resolvePnpmEntry({ ...search, resourcesPath: join(root, 'resources') }), resources, 'resources is the next candidate after bundled')
})

test('resolvePnpmEntry: installer roots are the last fallback (LOCALAPPDATA before APPDATA/execPath)', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-roots-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const local = join(root, 'AppData', 'Local')
  const roaming = join(root, 'AppData', 'Roaming')
  const localEntry = touch(join(local, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  const roamingEntry = touch(join(roaming, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'))
  const search = {
    platform: 'linux' as const,
    execPath: '/usr/bin/node',
    env: { LOCALAPPDATA: local, APPDATA: roaming },
  }
  assert.equal(resolvePnpmEntry(search), localEntry)
  assert.equal(resolvePnpmEntry({ ...search, env: { APPDATA: roaming } }), roamingEntry)
})
