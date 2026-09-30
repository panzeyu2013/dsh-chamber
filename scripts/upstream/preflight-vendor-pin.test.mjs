/**
 * preflight-vendor-pin.mjs unit tests (plain node:test, read-only): the pre-bump report is advisory, but its classification
 * drives real upgrade decisions (fork replay, vendor seam risk, upstream member drift); the pure helpers are pinned here, no repo mutation.
 *
 * The dropped-drift and noun-diff helpers are pinned with synthetic fixtures:
 * their job is to turn "upstream added something this repo will never see" into a
 * list a human reviews, so the false-positive shape matters as much as the hit shape.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FORK_PATHS,
  addedNameTokens,
  classifyChange,
  collectAddedLinesByFile,
  collectDeepImportedPackages,
  droppedReasonFor,
  expandRenames,
  forksFromRegistry,
  globMatch,
  isDroppedNoise,
  isRegisteredDropped,
  parsePin,
  resolvePackageDirs,
  splitTopLevelCommas,
  tokensMissingFromCopy,
  unquoteGitPath,
  upstreamPackages,
} from './preflight-vendor-pin.mjs'

test('parsePin: takes the last non-comment line of harness.commit', () => {
  assert.equal(parsePin('# pinned upstream\n\n82a5fd61a7cf5c293cec4bdff68f455398d685e9\n'), '82a5fd61a7cf5c293cec4bdff68f455398d685e9')
  assert.equal(parsePin('aaa\n# tag: dsh-v0.1.3-alpha.2\nbbb\n'), 'bbb')
  assert.equal(parsePin('# only comments\n\n'), null)
})

test('classifyChange: fork files split into pure / replay / dropped / unregistered', () => {
  const fork = FORK_PATHS[0]
  const file = fork.upstream + '/src/client/connection.ts'
  assert.equal(classifyChange(file, () => true, new Set()), 'fork-pure')
  assert.equal(classifyChange(file, () => false, new Set()), 'fork-replay')
  // Absent from the in-repo copy but registered dropped = intended, and still a review item.
  const droppedDir = fork.dropped.find(entry => entry.endsWith('/'))
  assert.ok(droppedDir, 'the first shadow fork must register at least one dropped directory')
  assert.equal(classifyChange(fork.upstream + '/' + droppedDir + 'gone.test.ts', () => true, new Set()), 'fork-dropped')
  // Absent and unregistered = the C3 violation shape: adjudicate, never ignore.
  assert.equal(classifyChange(fork.upstream + '/src/does-not-exist.ts', () => true, new Set()), 'fork-unregistered')
})

test('classifyChange: an injected fork table keeps the decision independent of registry contents', () => {
  const forks = [{ upstream: 'packages/up/thing', fork: 'packages/local/thing', dropped: ['docs/'], droppedNotes: {} }]
  assert.equal(classifyChange('packages/up/thing/docs/a.md', () => true, new Set(), forks), 'fork-dropped')
  assert.equal(classifyChange('packages/up/thing/src/gone.ts', () => true, new Set(), forks), 'fork-unregistered')
})

test('classifyChange: a deep-imported vendor path is a seam risk, others are ignored', () => {
  const deep = new Set(['packages/client/ui-layout'])
  assert.equal(classifyChange('packages/client/ui-layout/src/client/columns.ts', () => false, deep), 'vendor-seam')
  assert.equal(classifyChange('packages/client/ui-layout/package.json', () => false, deep), 'vendor-seam')
  assert.equal(classifyChange('packages/client/ui-slots/src/client/x.ts', () => false, deep), 'other')
  // A fork path wins over seam classification even if it is also deep-imported.
  assert.equal(classifyChange(FORK_PATHS[1].upstream + '/src/seed.ts', () => true, new Set(['packages/client/web'])), 'fork-pure')
})

test('isRegisteredDropped / droppedReasonFor: exact, prefix and glob keys resolve; a miss stays null', () => {
  const fork = {
    dropped: ['tests/', 'README.md', 'src/mount.ts'],
    droppedNotes: {
      'tests/': 'no tsdown suite',
      'README.md': 'chamber README',
      'src/mount.ts': 'kernel inlines mountClient',
      'src/*.gen.ts': 'generated',
    },
  }
  assert.equal(isRegisteredDropped(fork, 'tests/a.test.ts'), true)
  assert.equal(isRegisteredDropped(fork, 'tests'), false, 'a directory prefix needs the trailing slash')
  assert.equal(isRegisteredDropped(fork, 'src/gone.ts'), false)
  assert.equal(droppedReasonFor(fork, 'src/mount.ts'), 'kernel inlines mountClient')
  assert.equal(droppedReasonFor(fork, 'tests/deep/a.test.ts'), 'no tsdown suite')
  assert.equal(droppedReasonFor(fork, 'src/x.gen.ts'), 'generated')
  assert.equal(droppedReasonFor(fork, 'src/unknown.ts'), null, 'a missing reason must stay visible as null')
})

test('globMatch: only * is a wildcard, and the match is anchored', () => {
  assert.equal(globMatch('README*', 'README.md'), true)
  assert.equal(globMatch('README*', 'src/README.md'), false)
  assert.equal(globMatch('src/*.gen.ts', 'src/a.gen.ts'), true)
  assert.equal(globMatch('src/*.gen.ts', 'src/a/b.gen.ts'), false)
  assert.equal(globMatch('a.b', 'axb'), false, 'regex specials in the pattern are escaped')
})

test('collectAddedLinesByFile: hunk state machine — content lines starting with ++ never become file headers', () => {
  const diff = [
    'diff --git a/src/one.ts b/src/one.ts',
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -1,0 +2,3 @@',
    '+export const added = 1',
    '+++ this is an added content line, not a header',
    '+export const second = 2',
    'diff --git a/src/two.ts b/src/two.ts',
    '--- a/src/two.ts',
    '+++ b/src/two.ts',
    '@@ -3 +3 @@',
    '-removed',
    '+export function grown() {}',
    'diff --git a/src/new.ts b/src/new.ts',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1 @@',
    '+export const brandNew = 1',
    'diff --git a/src/gone.ts b/src/gone.ts',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const gone = 1',
    'diff --git a/src/moved.ts b/src/renamed.ts',
    'similarity index 100%',
    'rename from src/moved.ts',
    'rename to src/renamed.ts',
  ].join('\n')
  const byFile = collectAddedLinesByFile(diff)
  assert.deepEqual(byFile.get('src/one.ts'), [
    'export const added = 1',
    '++ this is an added content line, not a header',
    'export const second = 2',
  ])
  assert.deepEqual(byFile.get('src/two.ts'), ['export function grown() {}'])
  assert.deepEqual(byFile.get('src/new.ts'), ['export const brandNew = 1'])
  assert.equal(byFile.has('src/gone.ts'), false, 'a deleted file has no live +++ header')
  assert.equal(byFile.has('src/renamed.ts'), false, 'a pure rename carries no hunks')
  assert.equal(byFile.size, 3)
})

test('unquoteGitPath: strips b/ and decodes git C-quoted escapes', () => {
  assert.equal(unquoteGitPath('src/plain.ts'), 'src/plain.ts')
  assert.equal(unquoteGitPath('b/src/plain.ts'), 'src/plain.ts')
  assert.equal(unquoteGitPath('"src/na\\303\\257ve.ts"'), 'src/na\u00efve.ts')
  assert.equal(unquoteGitPath('"b/src/with space.ts"'), 'src/with space.ts')
  assert.equal(unquoteGitPath('"src/tab\\there.ts"'), 'src/tab\there.ts')
})
test('addedNameTokens: declaration forms, Remote methods and dotted seat keys', () => {
  const tokens = addedNameTokens([
    'export function grown() {}',
    'export default class Shell {}',
    'export function* walk() {}',
    'export const a = 1, b = 2',
    "export type { Config } from './x'",
    "export { q as r, s } from './y'",
    "  @Remote('workspace.pinSession')",
    '  @Remote(',
    '    "api.changes.open",',
    '  )',
    "  slots.register('sidebar.panellist', row)",
    "  const label = 'index.ts'",
    "  const version = 'v1.2'",
  ])
  assert.deepEqual(tokens.map(token => token.kind + ':' + token.name), [
    'export:grown',
    'export:Shell',
    'export:walk',
    'export:a',
    'export:Config',
    'export:r',
    'export:s',
    'export:b',
    'remote:workspace.pinSession',
    'remote:api.changes.open',
    'slot:sidebar.panellist',
  ])
})

test('tokensMissingFromCopy: the kind must match, and a commented-out declaration is not a pass', () => {
  const upstream = addedNameTokens(['export const grown = 1', "slots.register('sidebar.new', x)"])
  const copy = addedNameTokens([
    '// export const grown = 1',
    "// slots.register('sidebar.new', x)",
    "slots.register('sidebar.old', x)",
  ])
  assert.deepEqual(tokensMissingFromCopy(upstream, copy), [
    { kind: 'export', name: 'grown' },
    { kind: 'slot', name: 'sidebar.new' },
  ])
  const replayed = addedNameTokens(['export const grown = 1', "slots.register('sidebar.new', x)"])
  assert.deepEqual(tokensMissingFromCopy(upstream, replayed), [])
})

test('isDroppedNoise: tests / packaging config / README are noise, capability faces are not', () => {
  assert.equal(isDroppedNoise('tests/a.test.ts'), true)
  assert.equal(isDroppedNoise('src/tests/a.test.ts'), true)
  assert.equal(isDroppedNoise('tsdown.config.ts'), true)
  assert.equal(isDroppedNoise('README.md'), true)
  assert.equal(isDroppedNoise('README.i18n.yaml'), true)
  assert.equal(isDroppedNoise('src/README.md'), true)
  assert.equal(isDroppedNoise('src/mount.ts'), false)
  assert.equal(isDroppedNoise('src/index.ts'), false)
})

test('forksFromRegistry: an empty shadow-fork table fails loud instead of passing as zero diff', () => {
  assert.throws(() => forksFromRegistry({ entries: [] }), /覆盖面消失/)
  // The real registry must still yield the three shadow forks, and nothing else.
  assert.deepEqual(FORK_PATHS.map(fork => fork.upstream).sort(), [
    'packages/api/gateway',
    'packages/client/connection',
    'packages/client/web',
  ])
  assert.ok(FORK_PATHS.every(fork => Array.isArray(fork.dropped) && fork.droppedNotes !== undefined))
})
test('splitTopLevelCommas / addedNameTokens: only top-level commas split multi-declarators', () => {
  assert.deepEqual(splitTopLevelCommas("a = 1, b = 2"), ['a = 1', ' b = 2'])
  assert.deepEqual(splitTopLevelCommas('o = { a: 1, b: 2 }'), ['o = { a: 1, b: 2 }'])
  assert.deepEqual(splitTopLevelCommas("s = 'x, y', t = 2"), ["s = 'x, y'", ' t = 2'])
  // The shapes below used to mint pseudo export tokens (object property / arrow
  // parameter / type annotation / array element / string body) that could suppress
  // a real miss on the copy side.
  assert.deepEqual(addedNameTokens(['export const o = { a: 1, total: 2 }']).map(t => t.name), ['o'])
  assert.deepEqual(addedNameTokens(['export const f = (x, total) => x + total']).map(t => t.name), ['f'])
  assert.deepEqual(addedNameTokens(['export const fn: (a: string, total: number) => void = null']).map(t => t.name), ['fn'])
  assert.deepEqual(addedNameTokens(['export const list = [a, total]']).map(t => t.name), ['list'])
  assert.deepEqual(addedNameTokens(["export const s = 'a, total'"]).map(t => t.name), ['s'])
  assert.deepEqual(addedNameTokens(['export const a = 1, total = 2']).map(t => t.name), ['a', 'total'])
})

test('addedNameTokens: block comments are stripped by state, inline ones keep their code', () => {
  assert.deepEqual(addedNameTokens(['/*', 'export const total = 1', '*/']), [])
  assert.deepEqual(addedNameTokens(['/* c */ export const inline = 1']).map(t => t.name), ['inline'])
  assert.deepEqual(addedNameTokens(['export const before = 1 /* export const after = 2 */']).map(t => t.name), ['before'])
})

test('expandRenames: a rename also surfaces the vacated old path as a deletion', () => {
  assert.deepEqual(expandRenames([
    { status: 'R100', path: 'packages/client/web/src/new.ts', from: 'packages/client/web/src/old.ts' },
    { status: 'M', path: 'packages/client/web/src/keep.ts', from: null },
    { status: 'D', path: 'packages/client/web/src/gone.ts', from: null },
  ]), [
    { status: 'R100', path: 'packages/client/web/src/new.ts' },
    { status: 'D', path: 'packages/client/web/src/old.ts' },
    { status: 'M', path: 'packages/client/web/src/keep.ts' },
    { status: 'D', path: 'packages/client/web/src/gone.ts' },
  ])
})

test('addedNameTokens: generic and regex commas never mint pseudo exports', () => {
  assert.deepEqual(addedNameTokens(['export const g = new Map<string, total>()']).map(t => t.name), ['g'])
  assert.deepEqual(addedNameTokens(['export const r: Record<string, total> = {}']).map(t => t.name), ['r'])
  assert.deepEqual(addedNameTokens(['export const re = /a,total/']).map(t => t.name), ['re'])
})

test('stripBlockComments: a // line never opens a block, and a quoted /* stays a string', () => {
  assert.deepEqual(addedNameTokens(['// note: /* unclosed marker', 'export const real = 1']).map(t => t.name), ['real'])
  assert.deepEqual(addedNameTokens(["const p = '/*'", 'export const real = 1']).map(t => t.name), ['real'])
})

test('resolvePackageDirs / upstreamPackages: every workspace root is covered, non-dsh names skipped', () => {
  const manifests = {
    'packages/client/ui-layout/package.json': { name: '@deepseek-ai/dsh-client-ui-layout' },
    'packages/api/gateway/package.json': { name: '@deepseek-ai/dsh-api-gateway' },
    'native/landlock-run/packages/landlock-run/package.json': { name: '@deepseek-ai/node-addon-landlock-run' },
    'apps/desktop/package.json': { name: '@deepseek-ai/dsh-desktop' },
    'benchmarks/package.json': { name: '@deepseek-ai/dsh-benchmarks' },
    'website/package.json': { name: 'website' },
    'packages/client/ui-layout/src/client/AppFrame.tsx': null,
    'packages/not-a-member/README.md': null,
  }
  const io = {
    list: () => Object.keys(manifests).join('\n'),
    read: (_ref, file) => {
      if (!(file in manifests)) throw new Error('missing ' + file)
      return JSON.stringify(manifests[file])
    },
  }
  const dirs = resolvePackageDirs(io, 'ref')
  assert.equal(dirs.get('dsh-client-ui-layout'), 'packages/client/ui-layout')
  assert.equal(dirs.get('dsh-api-gateway'), 'packages/api/gateway')
  assert.equal(dirs.get('node-addon-landlock-run'), 'native/landlock-run/packages/landlock-run')
  assert.equal(dirs.get('dsh-desktop'), 'apps/desktop')
  assert.equal(dirs.get('dsh-benchmarks'), 'benchmarks')
  assert.equal(dirs.size, 5, 'non-dsh manifests are not members')
  assert.deepEqual([...upstreamPackages(io, 'ref')].sort(), [
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-benchmarks',
    '@deepseek-ai/dsh-client-ui-layout',
    '@deepseek-ai/dsh-desktop',
    '@deepseek-ai/node-addon-landlock-run',
  ])
})

test('collectDeepImportedPackages: finds @deepseek-ai/*/src imports under packages/, skips node_modules', () => {
  const root = mkdtempSync(join(tmpdir(), 'preflight-deep-'))
  mkdirSync(join(root, 'packages', 'renderer', 'node_modules', 'x'), { recursive: true })
  mkdirSync(join(root, 'packages', 'renderer', 'src'), { recursive: true })
  mkdirSync(join(root, 'packages', 'chamber-client-ui-layout', 'src'), { recursive: true })
  writeFileSync(join(root, 'packages', 'renderer', 'src', 'App.tsx'), [
    "import { a } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'",
    "import { b } from '@deepseek-ai/dsh-client-web/src/platform.ts'",
    "import { c } from '@deepseek-ai/dsh-client-ui-slots'", // package root import: not a seam
  ].join('\n'))
  writeFileSync(join(root, 'packages', 'renderer', 'node_modules', 'x', 'index.ts'), "import { d } from '@deepseek-ai/dsh-ignored/src/x.ts'\n")
  writeFileSync(join(root, 'packages', 'chamber-client-ui-layout', 'src', 'service.ts'), "export * from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'\n")
  writeFileSync(join(root, 'packages', 'renderer', 'src', 'notes.md'), "from '@deepseek-ai/dsh-not-a-ts-file/src/x.ts'\n")
  assert.deepEqual([...collectDeepImportedPackages(root)].sort(), ['dsh-client-ui-layout', 'dsh-client-web'])
})
