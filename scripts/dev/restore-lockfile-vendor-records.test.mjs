/**
 * restore-lockfile-vendor-records.mjs unit tests (plain node:test, no repo
 * mutation): the pnpm-11 pruning repair must补回 records that pnpm dropped,
 * but MUST NOT resurrect a member that upstream removed from its workspace
 * (2026-09 fix — the 0.1.5 landlock removal made frozen installs fail with
 * "锁文件有、链接缺" because the script blindly replayed HEAD's records).
 *
 * Runs the script as a child process through its documented test overrides:
 *   RESTORE_LOCKFILE_PATH / RESTORE_LOCKFILE_HEAD / RESTORE_VENDOR_LINK_DIR
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'restore-lockfile-vendor-records.mjs')

function importerBlock(name, deps = '') {
  return `  vendor/harness-packages/@deepseek-ai/${name}:\n${deps}`
}

/** A minimal v9-shaped lockfile with the three sections the script merges. */
function lockfile(importers) {
  return [
    "lockfileVersion: '9.0'",
    '',
    'settings:',
    '  autoInstallPeers: true',
    '',
    'importers:',
    '',
    ...importers.flatMap(block => (block === '' ? [''] : block.split('\n'))),
    '',
    'packages:',
    '',
    "  '@example/dep@1.0.0': {}",
    '',
    'snapshots:',
    '',
    "  '@example/dep@1.0.0': {}",
    '',
  ].join('\n')
}

function run(env) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'restore-lockfile-'))
  const linkDir = join(dir, 'links')
  mkdirSync(join(linkDir, 'dsh-client-store'), { recursive: true })
  const current = join(dir, 'pnpm-lock.yaml')
  const head = join(dir, 'head-lock.yaml')
  return { dir, linkDir, current, head }
}

test('restore: a record pnpm pruned is补回 when the member still exists', () => {
  const { linkDir, current, head } = fixture()
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', '    dependencies: {}')]))
  writeFileSync(head, lockfile([
    importerBlock('dsh-client-store', '    dependencies: {}'),
    importerBlock('dsh-client-ui-slots', "    dependencies:\n      '@example/dep':\n        specifier: 1.0.0\n        version: 1.0.0"),
  ]))
  // dsh-client-ui-slots exists as a link too (only pruned from the lockfile).
  mkdirSync(join(linkDir, 'dsh-client-ui-slots'), { recursive: true })
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  const merged = readFileSync(current, 'utf8')
  assert.match(merged, /vendor\/harness-packages\/@deepseek-ai\/dsh-client-ui-slots:/)
  assert.match(result.stdout, /已补回 vendor importer 1 条/)
})

test('restore: a member upstream REMOVED is skipped, never resurrected', () => {
  const { linkDir, current, head } = fixture()
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', '    dependencies: {}')]))
  writeFileSync(head, lockfile([
    importerBlock('dsh-client-store', '    dependencies: {}'),
    importerBlock('node-addon-landlock-run', '    optionalDependencies: {}'),
  ]))
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  const merged = readFileSync(current, 'utf8')
  assert.doesNotMatch(merged, /node-addon-landlock-run/, 'a removed workspace member must not come back')
  assert.match(result.stdout, /跳过 1 条已从上游 workspace 移除的成员记录/)
  assert.match(result.stdout, /node-addon-landlock-run/)
})

test('restore: a broken symlink counts as removed (upstream deleted the target)', () => {
  const { dir, linkDir, current, head } = fixture()
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', '    dependencies: {}')]))
  writeFileSync(head, lockfile([
    importerBlock('dsh-client-store', '    dependencies: {}'),
    importerBlock('ghost-package', '    dependencies: {}'),
  ]))
  // A symlink pointing at a non-existent target: existsSync follows it → false.
  symlinkSync(join(dir, 'does-not-exist'), join(linkDir, 'ghost-package'))
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  assert.doesNotMatch(readFileSync(current, 'utf8'), /ghost-package/)
  assert.match(result.stdout, /跳过 1 条/)
})
