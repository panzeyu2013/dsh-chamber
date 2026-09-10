/**
 * preflight-vendor-pin.mjs unit tests (plain node:test, read-only): the pre-bump
 * report is advisory tooling, but its classification drives real upgrade
 * decisions (which fork files must be replayed, which vendor files are seam
 * risk, which upstream members appeared/disappeared), so the pure helpers are
 * pinned here. No repo mutation: `classifyChange` only reads existing fork files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FORK_PATHS,
  classifyChange,
  collectDeepImportedPackages,
  parsePin,
  resolvePackageDirs,
  upstreamPackages,
} from './preflight-vendor-pin.mjs'

test('parsePin: takes the last non-comment line of harness.commit', () => {
  assert.equal(parsePin('# pinned upstream\n\n82a5fd61a7cf5c293cec4bdff68f455398d685e9\n'), '82a5fd61a7cf5c293cec4bdff68f455398d685e9')
  assert.equal(parsePin('aaa\n# tag: dsh-v0.1.3-alpha.2\nbbb\n'), 'bbb')
  assert.equal(parsePin('# only comments\n\n'), null)
})

test('classifyChange: fork files split into pure / replay / missing', () => {
  const fork = FORK_PATHS[0]
  const file = `${fork.upstream}/src/client/connection.ts`
  assert.equal(classifyChange(file, () => true, new Set()), 'fork-pure')
  assert.equal(classifyChange(file, () => false, new Set()), 'fork-replay')
  // Upstream file absent from the in-repo copy → dropped face, no action.
  assert.equal(classifyChange(`${fork.upstream}/src/does-not-exist.ts`, () => true, new Set()), 'fork-missing')
})

test('classifyChange: a deep-imported vendor path is a seam risk, others are ignored', () => {
  const deep = new Set(['packages/client/ui-layout'])
  assert.equal(classifyChange('packages/client/ui-layout/src/client/columns.ts', () => false, deep), 'vendor-seam')
  assert.equal(classifyChange('packages/client/ui-layout/package.json', () => false, deep), 'vendor-seam')
  assert.equal(classifyChange('packages/client/ui-slots/src/client/x.ts', () => false, deep), 'other')
  // A fork path wins over seam classification even if it is also deep-imported.
  assert.equal(classifyChange(`${FORK_PATHS[1].upstream}/src/seed.ts`, () => true, new Set(['packages/client/web'])), 'fork-pure')
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
      if (!(file in manifests)) throw new Error(`missing ${file}`)
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
