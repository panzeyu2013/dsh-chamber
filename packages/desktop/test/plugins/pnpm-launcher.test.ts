/**
 * pnpm launcher resolution tests (design 21 §6.3 / design 23 D2): the direct
 * `pnpm pack` spawn must never name a `.cmd`/`.bat` — Node
 * >=18.20.2/20.12.2 refuses those without a shell (CVE-2024-27980, EINVAL).
 * Pure command/args shape per platform; runs on every CI leg.
 *
 * Run directly: node packages/desktop/test/plugins/pnpm-launcher.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  pnpmScriptEntryCandidates,
  resolvePnpmLauncher,
  windowsPnpmSearchDirs,
} from '../../pnpm-launcher.ts'

test('resolvePnpmLauncher: POSIX keeps the bare pnpm name', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(
      resolvePnpmLauncher({
        platform,
        execPath: '/usr/local/bin/node',
        scriptEntry: '/opt/pnpm/bin/pnpm.cjs',
        electron: false,
      }),
      { command: 'pnpm', args: [], env: {} },
    )
  }
})

test('resolvePnpmLauncher: win32 runs the pnpm script through execPath', () => {
  assert.deepEqual(
    resolvePnpmLauncher({
      platform: 'win32',
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      scriptEntry: 'C:\\app\\resources\\pnpm\\bin\\pnpm.cjs',
      electron: false,
    }),
    {
      command: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\app\\resources\\pnpm\\bin\\pnpm.cjs'],
      env: {},
    },
  )
  // No launcher may ever name a .cmd/.bat shim.
  const launcher = resolvePnpmLauncher({
    platform: 'win32',
    execPath: 'C:\\node.exe',
    scriptEntry: 'C:\\app\\pnpm\\bin\\pnpm.cjs',
  })
  assert.ok(launcher !== null)
  assert.equal(/\.(cmd|bat)$/i.test(launcher.command), false)
  assert.equal(launcher.args.some(arg => /\.(cmd|bat)$/i.test(arg)), false)
})

test('resolvePnpmLauncher: Electron main needs ELECTRON_RUN_AS_NODE for the script', () => {
  assert.deepEqual(
    resolvePnpmLauncher({
      platform: 'win32',
      execPath: 'C:\\app\\dsh-chamber.exe',
      scriptEntry: 'C:\\app\\resources\\pnpm\\bin\\pnpm.cjs',
      electron: true,
    }),
    {
      command: 'C:\\app\\dsh-chamber.exe',
      args: ['C:\\app\\resources\\pnpm\\bin\\pnpm.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  )
})

test('resolvePnpmLauncher: win32 without a script entry refuses (no .cmd fallback)', () => {
  assert.equal(resolvePnpmLauncher({ platform: 'win32', execPath: 'C:\\node.exe', scriptEntry: null }), null)
  assert.equal(resolvePnpmLauncher({ platform: 'win32', execPath: 'C:\\node.exe', scriptEntry: '' }), null)
})

test('pnpmScriptEntryCandidates: bundled copy first, then installer roots', () => {
  assert.deepEqual(
    pnpmScriptEntryCandidates({
      platform: 'win32',
      moduleDir: 'C:\\app\\resources\\app.asar',
      resourcesPath: 'C:\\app\\resources',
      env: {
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      },
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
    }),
    [
      'C:\\app\\resources\\pnpm\\bin\\pnpm.cjs',
      'C:\\app\\resources\\app.asar\\node_modules\\pnpm\\bin\\pnpm.cjs',
      'C:\\Users\\alice\\AppData\\Local\\node_modules\\pnpm\\bin\\pnpm.cjs',
      'C:\\Users\\alice\\AppData\\Roaming\\node_modules\\pnpm\\bin\\pnpm.cjs',
      'C:\\Program Files\\nodejs\\node_modules\\pnpm\\bin\\pnpm.cjs',
    ],
  )
})

test('pnpmScriptEntryCandidates: dev shape has no resources root, POSIX joins', () => {
  assert.deepEqual(
    pnpmScriptEntryCandidates({
      platform: 'darwin',
      moduleDir: '/repo/packages/desktop',
      resourcesPath: undefined,
      env: {},
      execPath: '/usr/bin/node',
    }),
    [
      '/repo/packages/desktop/node_modules/pnpm/bin/pnpm.cjs',
      '/usr/bin/node_modules/pnpm/bin/pnpm.cjs',
    ],
  )
})

test('windowsPnpmSearchDirs: bundled first, then %LOCALAPPDATA%\\pnpm, %APPDATA%\\npm, node dir', () => {
  assert.deepEqual(
    windowsPnpmSearchDirs({
      env: {
        LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
      },
      execPath: 'C:\\Program Files\\nodejs\\node.exe',
      bundledBinDir: 'C:\\app\\resources\\pnpm\\bin',
    }),
    [
      'C:\\app\\resources\\pnpm\\bin',
      'C:\\Users\\alice\\AppData\\Local\\pnpm',
      'C:\\Users\\alice\\AppData\\Roaming\\npm',
      'C:\\Program Files\\nodejs',
    ],
  )
})

test('windowsPnpmSearchDirs: missing bundled copy and empty env roots are skipped', () => {
  assert.deepEqual(
    windowsPnpmSearchDirs({ env: {}, execPath: 'C:\\node.exe', bundledBinDir: null }),
    ['C:\\'],
  )
})

test('plugin-sync packDirectory spawns the resolved launcher, never the .cmd shim', () => {
  // The pure resolver only matters if the call site uses it: pin the wiring so
  // a `process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'` spawn
  // cannot come back (source-assertion style, same as the IPC surface mirror).
  const source = readFileSync(join(import.meta.dirname, '..', '..', 'plugin-sync.ts'), 'utf8')
  assert.equal(/process\.platform === 'win32' \? 'pnpm\.cmd'/.test(source), false)
  assert.match(source, /resolvePnpmLauncher\(\{/)
  assert.match(source, /\.\.\.launcher\.args, \.\.\.buildPnpmPackArgs\(outDir\)/)
})
