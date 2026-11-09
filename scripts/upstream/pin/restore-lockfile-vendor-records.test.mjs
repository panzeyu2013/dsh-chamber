/**
 * restore-lockfile-vendor-records.mjs unit tests (plain node:test, no repo mutation): the pnpm-11 pruning
 * repair must补回 dropped records but MUST NOT resurrect a member upstream removed from its workspace.
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

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), './restore-lockfile-vendor-records.mjs')

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

// TODO A§16.4: the HEAD record predates edges the upgrade just added. Restoring the
// raw record is not enough — the CURRENT member package.json edges must be unioned
// in, otherwise frozen fails with no repair path.

function writeManifest(linkDir, member, manifest) {
  mkdirSync(join(linkDir, member), { recursive: true })
  writeFileSync(join(linkDir, member, 'package.json'), JSON.stringify(manifest))
}

test('restore: a restored record is unioned with the CURRENT package.json edges', () => {
  const { linkDir, current, head } = fixture()
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', '    dependencies: {}')]))
  writeFileSync(head, lockfile([
    importerBlock('dsh-client-store', '    dependencies: {}'),
    importerBlock('dsh-client-ui-slots', '    dependencies: {}'),
  ]))
  writeManifest(linkDir, 'dsh-client-ui-slots', {
    name: '@deepseek-ai/dsh-client-ui-slots',
    dependencies: { '@deepseek-ai/dsh-brand': 'workspace:*', zod: '4.4.3' },
  })
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  const merged = readFileSync(current, 'utf8')
  // Workspace edge becomes a link version; a registry edge keeps its specifier (frozen verifies).
  assert.match(merged, /dsh-client-ui-slots:[\s\S]*'@deepseek-ai\/dsh-brand':[\s\S]*specifier: workspace:\*[\s\S]*version: link:\.\.\/dsh-brand/)
  assert.match(merged, /dsh-client-ui-slots:[\s\S]*zod:[\s\S]*specifier: 4\.4\.3[\s\S]*version: 4\.4\.3/)
  assert.match(result.stdout, /specifier 边 2 条/)
})

test('restore: a kept record missing a new registry edge gains it (fail-closed at frozen)', () => {
  const { linkDir, current, head } = fixture()
  const block = "    dependencies:\n      zod:\n        specifier: 4.4.3\n        version: 4.4.3"
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', block)]))
  writeFileSync(head, lockfile([importerBlock('dsh-client-store', block)]))
  writeManifest(linkDir, 'dsh-client-store', {
    dependencies: { zod: '4.4.3', lodash: '^4.17.0' },
  })
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  const merged = readFileSync(current, 'utf8')
  assert.match(merged, /      lodash:\n        specifier: \^4\.17\.0\n        version: \^4\.17\.0/)
  // The existing edge is untouched (no reordering, no rewrite).
  assert.match(merged, /      zod:\n        specifier: 4\.4\.3\n        version: 4\.4\.3/)
  assert.match(result.stdout, /specifier 边 1 条/)
})

test('restore: a member without a manifest is left byte-identical (no invented edges)', () => {
  const { linkDir, current, head } = fixture()
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', '    dependencies: {}')]))
  writeFileSync(head, lockfile([importerBlock('dsh-client-store', '    dependencies: {}')]))
  const before = readFileSync(current, 'utf8')
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  assert.equal(readFileSync(current, 'utf8'), before)
  assert.match(result.stdout, /无需修复/)
})

test('restore: a member key that escapes the link tree reads no manifest', () => {
  const { linkDir, current, head } = fixture()
  const block = '    dependencies: {}'
  writeFileSync(current, lockfile([importerBlock('../escape', block)]))
  writeFileSync(head, lockfile([importerBlock('../escape', block)]))
  // A manifest OUTSIDE the member path exists only to prove the guard refuses to read it.
  mkdirSync(join(linkDir, 'escape'), { recursive: true })
  writeFileSync(join(linkDir, 'escape', 'package.json'), JSON.stringify({ dependencies: { zod: '4.4.3' } }))
  const before = readFileSync(current, 'utf8')
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  assert.equal(readFileSync(current, 'utf8'), before, 'an escaping member key must stay byte-identical')
})

test('restore: an inline-empty group is expanded, never duplicated', () => {
  const { linkDir, current, head } = fixture()
  const block = '    dependencies: {}'
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', block)]))
  writeFileSync(head, lockfile([importerBlock('dsh-client-store', block)]))
  writeManifest(linkDir, 'dsh-client-store', { dependencies: { zod: '4.4.3' } })
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  const merged = readFileSync(current, 'utf8')
  assert.equal((merged.match(/^    dependencies:/gm) ?? []).length, 1, 'exactly one dependencies group')
  assert.doesNotMatch(merged, /dependencies: \{\}/)
  assert.match(merged, /    dependencies:\n      zod:\n        specifier: 4\.4\.3\n        version: 4\.4\.3/)
  assert.match(result.stdout, /specifier 边 1 条/)
})

test('restore: multiple added entries keep the pnpm sort order', () => {
  const { linkDir, current, head } = fixture()
  const block = "    dependencies:\n      zod:\n        specifier: 4.4.3\n        version: 4.4.3"
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', block)]))
  writeFileSync(head, lockfile([importerBlock('dsh-client-store', block)]))
  writeManifest(linkDir, 'dsh-client-store', { dependencies: { zzz: '1.0.0', aaa: '2.0.0' } })
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  const merged = readFileSync(current, 'utf8')
  const aaa = merged.indexOf('      aaa:')
  const zod = merged.indexOf('      zod:')
  const zzz = merged.indexOf('      zzz:')
  assert.ok(aaa > -1 && zod > aaa && zzz > zod, 'entries must be name-sorted')
})

test('restore: a missing dependency GROUP is created in alphabetical position and counted once', () => {
  const { linkDir, current, head } = fixture()
  const block = "    dependencies:\n      zod:\n        specifier: 4.4.3\n        version: 4.4.3"
  writeFileSync(current, lockfile([importerBlock('dsh-client-store', block)]))
  writeFileSync(head, lockfile([importerBlock('dsh-client-store', block)]))
  writeManifest(linkDir, 'dsh-client-store', { devDependencies: { '@example/tool': '2.0.0' } })
  const result = run({ RESTORE_LOCKFILE_PATH: current, RESTORE_LOCKFILE_HEAD: head, RESTORE_VENDOR_LINK_DIR: linkDir })
  assert.equal(result.code, 0, result.stdout)
  const merged = readFileSync(current, 'utf8')
  assert.match(merged, /    dependencies:[\s\S]*    devDependencies:\n      '@example\/tool':\n        specifier: 2\.0\.0/)
  assert.match(result.stdout, /specifier 边 1 条/, 'a new group must count once, not twice')
})
