/**
 * plugin-sync — part 4: the cordis.patch.yml seed merge (dedup / deterministic
 * template rewrite / legacy fold / append-without-clobber / fail-loud) and
 * seedRemoteChamberHostPackages (built vs portable seeds, preflight, hash skip).
 * Sibling parts: plugin-sync.test.ts, plugin-sync-remote-read.test.ts, plugin-sync-apply.test.ts, plugin-sync-renderer-projection.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARCHIVE_CLEANUP_INSERT_ID, ARCHIVE_CLEANUP_PACKAGE_NAME, CLIENT_GRAPH_INSERT_ID, CLIENT_GRAPH_PACKAGE_NAME, computeCordisPatchUpdate, foldLegacyHostInserts, GIT_WORKTREE_INSERT_ID, GIT_WORKTREE_PACKAGE_NAME, OPEN_IN_PACKAGE_NAME, builtChamberHostPackageSeeds, portableChamberHostPackageSeeds, seedRemoteChamberHostPackages } from '../../plugin-sync.ts'
import type { ChamberHostPackageSeed, ExecFn } from '../../plugin-sync.ts'
import type { TransportRunPayload } from '../../transport-provider.ts'
import { err, ok, okBytes, SEED_SPEC, tempDir } from './plugin-sync-fixtures.ts'

// ============================================================================
// computeCordisPatchUpdate (seed cordis.patch.yml)
// ============================================================================

const TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** The single client-graph loader row: computeCordisPatchUpdate's inserts are
 *  REQUIRED — the one-argument default is production-dead. */
const GRAPH_INSERTS = [{ insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME }]

test('seed: initProfile template is deterministically rewritten with the insert', () => {
  const update = computeCordisPatchUpdate(TEMPLATE, GRAPH_INSERTS)
  assert.equal('error' in update, false)
  if ('error' in update) return
  assert.equal(update.write, true)
  if (!update.write) return
  assert.ok(update.content.includes('- insert:'))
  assert.ok(update.content.includes("name: '@dsh-chamber/dsh-chamber-seed-client-graph'"))
  assert.ok(!update.content.includes('[]'), 'empty list marker is replaced')
  // comments preserved
  assert.ok(update.content.includes('Your patch layer'))
})
test('seed: an existing insert is deduped (no write)', () => {
  const already = TEMPLATE.replace('[]', `[\n  - insert: { id: client-graph, name: '@dsh-chamber/dsh-chamber-seed-client-graph' }\n]`)
  assert.deepEqual(computeCordisPatchUpdate(already, GRAPH_INSERTS), { write: false })
})

// Batch 1 naming unification (2026-09): the one-time legacy fold (plan §3.4).
const LEGACY_CLIENT_GRAPH_ROW = `- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n`

test('seed: a pre-rename row under the same loader id folds to the canonical name (never an id-bound conflict)', () => {
  const update = computeCordisPatchUpdate(LEGACY_CLIENT_GRAPH_ROW, GRAPH_INSERTS)
  assert.equal('error' in update, false, 'the old-name row is a rename to absorb, not a conflict to refuse')
  if ('error' in update || !update.write) return assert.fail('expected a fold write')
  assert.equal(update.content, `- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n`)
  // One-time: the folded patch is already canonical, so the next pass is a no-op.
  assert.deepEqual(computeCordisPatchUpdate(update.content, GRAPH_INSERTS), { write: false })
})
test('seed: the legacy fold is scoped to the matching loader id and the exact rendered row', () => {
  // The same legacy name under a DIFFERENT loader id is a user row: it is left
  // verbatim and the missing canonical row is appended beside it.
  const userRow = `- insert:\n    - id: user-row\n      name: '@dsh-chamber/dsh-host-client-graph'\n`
  const update = computeCordisPatchUpdate(userRow, GRAPH_INSERTS)
  assert.equal('error' in update, false)
  if ('error' in update || !update.write) return assert.fail('expected an append write')
  assert.ok(update.content.startsWith(userRow), 'the user row is preserved verbatim')
  assert.ok(update.content.includes("name: '@dsh-chamber/dsh-chamber-seed-client-graph'"))
  // A hand-written flow-style legacy row is NOT guessed at: the shared
  // classification reports the id conflict loudly instead of rewriting bytes
  // the seed writer never produced.
  const flow = `- insert: [{ id: client-graph, name: '@dsh-chamber/dsh-host-client-graph' }]\n`
  const conflict = computeCordisPatchUpdate(flow, GRAPH_INSERTS)
  assert.ok('error' in conflict)
  if ('error' in conflict) assert.match(conflict.error, /already bound to a different package/)
})
test('seed: all three pre-rename rows fold in one pass; unrelated rows stay untouched', () => {
  const legacyPatch = [
    `- id: system-prompt\n  config:\n    persona: hi\n`,
    `- insert:\n    - id: ${CLIENT_GRAPH_INSERT_ID}\n      name: '@dsh-chamber/dsh-host-client-graph'\n`,
    `- insert:\n    - id: ${GIT_WORKTREE_INSERT_ID}\n      name: '@dsh-chamber/dsh-host-git-worktree'\n`,
    `- insert:\n    - id: ${ARCHIVE_CLEANUP_INSERT_ID}\n      name: '@dsh-chamber/dsh-host-archive-cleanup'\n`,
  ].join('')
  const inserts = [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
    { insertId: ARCHIVE_CLEANUP_INSERT_ID, packageName: ARCHIVE_CLEANUP_PACKAGE_NAME },
  ]
  const update = computeCordisPatchUpdate(legacyPatch, inserts)
  assert.equal('error' in update, false)
  if ('error' in update || !update.write) return assert.fail('expected a fold write')
  assert.equal(update.content, [
    `- id: system-prompt\n  config:\n    persona: hi\n`,
    `- insert:\n    - id: ${CLIENT_GRAPH_INSERT_ID}\n      name: '${CLIENT_GRAPH_PACKAGE_NAME}'\n`,
    `- insert:\n    - id: ${GIT_WORKTREE_INSERT_ID}\n      name: '${GIT_WORKTREE_PACKAGE_NAME}'\n`,
    `- insert:\n    - id: ${ARCHIVE_CLEANUP_INSERT_ID}\n      name: '${ARCHIVE_CLEANUP_PACKAGE_NAME}'\n`,
  ].join(''))
  assert.deepEqual(computeCordisPatchUpdate(update.content, inserts), { write: false })
  // foldLegacyHostInserts is the exported seam: nothing to fold = no write.
  assert.deepEqual(foldLegacyHostInserts(update.content, inserts), { content: update.content, folded: false })
})
test('seed: a user block list is appended to, never clobbered', () => {
  const userList = `- id: system-prompt\n  config:\n    persona: hi\n`
  const update = computeCordisPatchUpdate(userList, GRAPH_INSERTS)
  assert.equal('error' in update, false)
  if ('error' in update) return
  assert.equal(update.write, true)
  if (!update.write) return
  assert.ok(update.content.startsWith('- id: system-prompt'), 'user rows preserved')
  assert.ok(update.content.includes('- insert:'))
  assert.ok(update.content.includes("name: '@dsh-chamber/dsh-chamber-seed-client-graph'"))
})
test('seed: a non-list file fails loud', () => {
  const mapping = 'system-prompt:\n  persona: hi\n'
  const update = computeCordisPatchUpdate(mapping, GRAPH_INSERTS)
  assert.ok('error' in update)
  if ('error' in update) assert.match(update.error, /not a top-level YAML array/)
})
test('seed: a missing cordis.patch.yml (uninitialized profile) fails loud', () => {
  const update = computeCordisPatchUpdate(null, GRAPH_INSERTS)
  assert.ok('error' in update)
  if ('error' in update) assert.match(update.error, /not initialized/)
})
test('seed: a similar-but-different entry does NOT dedup (client-graph-foo id is not the client-graph entry)', () => {
  // The OLD substring dedup matched `id: client-graph` inside
  // `id: client-graph-foo` and wrongly skipped the insert; the line-level
  // boundary check must not.
  const similar = `- id: client-graph-foo
  config:
    x: 1
`
  const update = computeCordisPatchUpdate(similar, GRAPH_INSERTS)
  assert.equal('error' in update, false)
  if ('error' in update) return
  assert.equal(update.write, true, 'a client-graph-foo id must not count as the client-graph entry')
})
test('seed: two chamber host rows merge together and only a missing row is appended', () => {
  const inserts = [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ]
  const first = computeCordisPatchUpdate(TEMPLATE, inserts)
  assert.equal('error' in first, false)
  if ('error' in first || !first.write) return
  assert.ok(first.content.includes('id: client-graph'))
  assert.ok(first.content.includes('id: git-worktree'))
  assert.deepEqual(computeCordisPatchUpdate(first.content, inserts), { write: false })
  const graphSeed = computeCordisPatchUpdate(TEMPLATE, [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
  ])
  assert.equal('error' in graphSeed, false)
  if ('error' in graphSeed || !graphSeed.write) return
  const graphOnly = graphSeed.content
  const second = computeCordisPatchUpdate(graphOnly, inserts)
  assert.equal('error' in second, false)
  if ('error' in second || !second.write) return
  assert.equal((second.content.match(/id: client-graph/g) ?? []).length, 1)
  assert.equal((second.content.match(/id: git-worktree/g) ?? []).length, 1)
})
test('seed: crossed id/name rows fail loud before appending a boot-breaking duplicate', () => {
  const crossed = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
    - id: git-worktree
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
`
  const update = computeCordisPatchUpdate(crossed, [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|already mounted|duplicate chamber loader identity/)
})
test('seed: same chamber id with a different package fails loud', () => {
  const update = computeCordisPatchUpdate(`- insert:\n    - id: git-worktree\n      name: '@example/not-chamber'\n`, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound/)
})
test('seed: same chamber package under a different id fails loud', () => {
  const update = computeCordisPatchUpdate(`- insert:\n    - id: user-git-row\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n`, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already mounted/)
})
test('seed: duplicate exact chamber rows fail loud instead of accepting the next boot failure', () => {
  const duplicate = `- insert:\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n    - id: git-worktree\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n`
  const update = computeCordisPatchUpdate(duplicate, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /duplicate chamber loader identity/)
})
test('seed: name-first sibling rows cannot be cross-paired into a false exact match', () => {
  const crossed = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
    - name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
      id: another-git-service
`
  const update = computeCordisPatchUpdate(crossed, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|already mounted|duplicate chamber loader identity/)
})
test('seed: an exact name-first loader row is reused', () => {
  const exact = `- insert:
    - name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
      id: git-worktree
`
  assert.deepEqual(computeCordisPatchUpdate(exact, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ]), { write: false })
})
test('seed: a nested config name cannot complete the parent loader identity', () => {
  const nested = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
      config:
        name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
`
  const update = computeCordisPatchUpdate(nested, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|duplicate chamber loader identity/)
})
test('seed: crossed inline-flow mappings stay separate', () => {
  const crossed = `- insert: [{ id: git-worktree, name: '@example/not-chamber' }, { id: other, name: '@dsh-chamber/dsh-chamber-seed-git-worktree' }]
`
  const update = computeCordisPatchUpdate(crossed, [
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, true)
  if ('error' in update) assert.match(update.error, /already bound|already mounted|duplicate chamber loader identity/)
})

// ============================================================================
// seedRemoteChamberHostPackages — single-package edge cases (design 13 §3)
// ============================================================================

function makeSeedExec(overrides: {
  seedFiles?: Map<string, Buffer>
  patchContent?: string | null
  failWrite?: (path: string) => string | null
  failSeedCat?: (path: string) => string | null
} = {}) {
  const calls: string[] = []
  const written: Array<{ path: string; bytes: Buffer }> = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0]
      calls.push(`cat:${path}`)
      if (path !== undefined && path.startsWith('~/.dsh/profiles/node_modules/@dsh-chamber/')) {
        if (overrides.failSeedCat !== undefined) {
          const message = overrides.failSeedCat(path)
          if (message !== null) return err(message)
        }
        const bytes = overrides.seedFiles?.get(path)
        if (bytes !== undefined) return okBytes(bytes)
        return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
      }
      if (path === '~/.dsh/profiles/web/cordis.patch.yml') {
        if (overrides.patchContent === null) return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
        return ok(overrides.patchContent)
      }
      return err('run command failed (exit 1): cat: no such file')
    }
    if (action === 'run' && payload?.op === 'write-file') {
      const path = payload.path ?? '?'
      calls.push(`write:${path}`)
      if (overrides.failWrite !== undefined) {
        const message = overrides.failWrite(path)
        if (message !== null) return err(message)
      }
      written.push({ path, bytes: Buffer.from(payload.contentBase64 ?? '', 'base64') })
      return ok()
    }
    calls.push(`other:${action}`)
    return ok()
  }
  return { exec, calls, written }
}

/** A module A source dir with `package.json` bytes and a `dist/index.js`. */
function writeModuleA(root: string, pkgJson: string | Buffer, distJs: string | Buffer): string {
  const sourceDir = join(root, 'module-a')
  mkdirSync(join(sourceDir, 'dist'), { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), pkgJson)
  writeFileSync(join(sourceDir, 'dist', 'index.js'), distJs)
  return sourceDir
}

/** A throwaway module A source dir for the single-package edge cases. */
function moduleASource(pkgJson: string | Buffer = '{"name":"x"}', distJs = 'export const graph = 1\n'): string {
  return writeModuleA(tempDir(), pkgJson, distJs)
}

/** One single-package seed list (the client-graph row) — the legacy
 *  `seedRemoteHostGraph` wrapper was deleted as production-dead; its edge-case
 *  coverage lives on through these single-package calls. */
function singleGraphSeed(sourceDir: string): ChamberHostPackageSeed[] {
  return [{ insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME, sourceDir, label: 'host-graph' }]
}

/** A built host-package source dir (package.json + dist/index.js) under `root`. */
function writeHostSeedPackage(root: string, dirName: string, packageName: string, distJs: string): string {
  const sourceDir = join(root, dirName)
  mkdirSync(join(sourceDir, 'dist'), { recursive: true })
  writeFileSync(join(sourceDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0' }))
  writeFileSync(join(sourceDir, 'dist', 'index.js'), distJs)
  return sourceDir
}

function dualHostSeeds(root: string): ChamberHostPackageSeed[] {
  const graph = writeHostSeedPackage(root, 'graph', CLIENT_GRAPH_PACKAGE_NAME, 'export const graph = 1\n')
  const git = writeHostSeedPackage(root, 'git', GIT_WORKTREE_PACKAGE_NAME, 'export const git = 1\n')
  return [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME, sourceDir: graph, label: 'host-graph' },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME, sourceDir: git, label: 'git-worktree' },
  ]
}

function tripleHostSeeds(root: string): ChamberHostPackageSeed[] {
  const archive = writeHostSeedPackage(root, 'archive', ARCHIVE_CLEANUP_PACKAGE_NAME, 'export const archive = 1\n')
  return [...dualHostSeeds(root), { insertId: ARCHIVE_CLEANUP_INSERT_ID, packageName: ARCHIVE_CLEANUP_PACKAGE_NAME, sourceDir: archive, label: 'archive-cleanup' }]
}

test('seedRemoteChamberHostPackages: seeds three packages before one merged patch write', async () => {
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, tripleHostSeeds(tempDir()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.packages.map(entry => entry.insertId),
    [CLIENT_GRAPH_INSERT_ID, GIT_WORKTREE_INSERT_ID, ARCHIVE_CLEANUP_INSERT_ID],
    'all three loader rows report their write state')
  assert.equal(result.packages.length, 3)
  assert.equal(result.wrote, true)
  assert.equal(result.patched, true)
  assert.equal(remote.written.length, 7, 'six package files (three pairs) + one merged patch')
  // Every chamber host package lands its seed-file pair on the remote.
  for (const packageName of [CLIENT_GRAPH_PACKAGE_NAME, GIT_WORKTREE_PACKAGE_NAME, ARCHIVE_CLEANUP_PACKAGE_NAME]) {
    const slug = packageName.slice('@dsh-chamber/'.length)
    assert.ok(remote.written.some(entry => entry.path === `~/.dsh/profiles/node_modules/@dsh-chamber/${slug}/package.json`),
      `${packageName} package.json must be seeded`)
    assert.ok(remote.written.some(entry => entry.path === `~/.dsh/profiles/node_modules/@dsh-chamber/${slug}/dist/index.js`),
      `${packageName} dist/index.js must be seeded`)
  }
  const patchWrites = remote.written.filter(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(patchWrites.length, 1)
  const patch = patchWrites[0].bytes.toString('utf8')
  assert.ok(patch.includes('id: client-graph'))
  assert.ok(patch.includes('id: git-worktree'))
  assert.ok(patch.includes('id: archive-cleanup'))
  assert.equal(remote.calls.at(-1), 'write:~/.dsh/profiles/web/cordis.patch.yml', 'patch is committed after every package file')
})
test('seedRemoteChamberHostPackages: seeds two packages before one merged patch write', async () => {
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, dualHostSeeds(tempDir()))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.packages.length, 2)
  assert.equal(result.wrote, true)
  assert.equal(result.patched, true)
  assert.equal(remote.written.length, 5, 'four package files + one merged patch')
  const patchWrites = remote.written.filter(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(patchWrites.length, 1)
  const patch = patchWrites[0].bytes.toString('utf8')
  assert.ok(patch.includes('id: client-graph'))
  assert.ok(patch.includes('id: git-worktree'))
  assert.equal(remote.calls.at(-1), 'write:~/.dsh/profiles/web/cordis.patch.yml', 'patch is committed after every package file')
})
test('seedRemoteChamberHostPackages: broken second source fails preflight before any remote call', async () => {
  const root = tempDir()
  const seeds = dualHostSeeds(root)
  const broken = join(root, 'broken-git')
  mkdirSync(join(broken, 'dist'), { recursive: true })
  writeFileSync(join(broken, 'dist', 'index.js'), 'export default {}\n')
  seeds[1] = { ...seeds[1], sourceDir: broken }
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, seeds)
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /package\.json missing/)
  assert.deepEqual(remote.calls, [])
  assert.deepEqual(remote.written, [])
})
test('seedRemoteChamberHostPackages: second-package read failure happens before every write', async () => {
  const remote = makeSeedExec({
    patchContent: TEMPLATE,
    failSeedCat: path => path.includes(GIT_WORKTREE_PACKAGE_NAME) ? 'ssh transport failed (exit 255)' : null,
  })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, dualHostSeeds(tempDir()))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /git-worktree seed read/)
  assert.deepEqual(remote.written, [], 'all remote probes finish before the first write')
})
test('portableChamberHostPackageSeeds: localOnly rows never travel, the rest keep registry order', () => {
  const seeds: ChamberHostPackageSeed[] = [
    { insertId: 'client-graph', packageName: CLIENT_GRAPH_PACKAGE_NAME, sourceDir: '/tmp/graph', label: 'client-graph' },
    { insertId: 'open-in', packageName: OPEN_IN_PACKAGE_NAME, sourceDir: '', label: 'open-in', localOnly: true },
    { insertId: 'archive-cleanup', packageName: ARCHIVE_CLEANUP_PACKAGE_NAME, sourceDir: '/tmp/archive', label: 'archive-cleanup' },
  ]
  const snapshot = structuredClone(seeds)
  assert.deepEqual(portableChamberHostPackageSeeds(seeds).map(seed => seed.insertId),
    ['client-graph', 'archive-cleanup'],
    'a localOnly row is dropped; everything else keeps input order')
  assert.deepEqual(seeds, snapshot, 'the input list is never mutated')
  assert.deepEqual(portableChamberHostPackageSeeds([]), [])
  assert.deepEqual(
    portableChamberHostPackageSeeds([seeds[1]!]),
    [],
    'an all-localOnly list is empty, never a seed with an empty sourceDir',
  )
})
test('builtChamberHostPackageSeeds: an empty sourceDir is never resolved (the CWD is not a package)', () => {
  const root = tempDir()
  const built = dualHostSeeds(root)
  const seeds: ChamberHostPackageSeed[] = [
    ...built,
    // An unmapped registry row: `join('', 'dist', 'index.js')` would resolve
    // against the process CWD, so the gate must refuse the empty dir BEFORE any
    // filesystem probe — asserted on the result set, not on CWD content.
    { insertId: 'unmapped', packageName: '@dsh-chamber/dsh-chamber-seed-unmapped', sourceDir: '', label: 'unmapped' },
    // A directory that exists but has no built entry (source checkout).
    { insertId: 'unbuilt', packageName: '@dsh-chamber/dsh-chamber-seed-unbuilt', sourceDir: join(root, 'not-built'), label: 'unbuilt' },
  ]
  assert.deepEqual(builtChamberHostPackageSeeds(seeds).map(seed => seed.insertId),
    [CLIENT_GRAPH_INSERT_ID, GIT_WORKTREE_INSERT_ID],
    'only real source dirs with a built dist/index.js are shipped here')
  assert.deepEqual(builtChamberHostPackageSeeds([]), [])
})
test('builtChamberHostPackageSeeds: an empty sourceDir stays refused even when the CWD LOOKS like a built package', () => {
  // This is the only test that can kill the `sourceDir !== ''` guard: the
  // CWD-independent case above passes with or without it (this checkout has no
  // packages/desktop/dist/index.js). The guard exists because
  // `existsSync(join('', 'dist', 'index.js'))` resolves the process CWD, so a
  // shell whose working directory contains a built entry would otherwise stage
  // ITS OWN bytes as that package's seed (2026-12 review; verification gap G1).
  const built = dualHostSeeds(tempDir())
  const emptyDirSeed: ChamberHostPackageSeed = {
    insertId: 'unmapped',
    packageName: '@dsh-chamber/dsh-chamber-seed-unmapped',
    sourceDir: '',
    label: 'unmapped',
  }
  const cwd = tempDir('chamber-cwd-')
  mkdirSync(join(cwd, 'dist'))
  writeFileSync(join(cwd, 'dist', 'index.js'), '// a CWD that looks like a built package\n')
  const previous = process.cwd()
  process.chdir(cwd)
  try {
    assert.ok(existsSync(join('', 'dist', 'index.js')),
      'the fixture CWD must resolve a dist/index.js, or this test cannot bite')
    assert.deepEqual(builtChamberHostPackageSeeds([...built, emptyDirSeed]).map(seed => seed.insertId),
      [CLIENT_GRAPH_INSERT_ID, GIT_WORKTREE_INSERT_ID],
      'an empty sourceDir is never resolved, whatever the CWD happens to contain')
  } finally {
    process.chdir(previous)
  }
})
test('seedRemoteChamberHostPackages: a localOnly row with a REAL source dir is neither probed nor written (design 20 §6)', async () => {
  // The seed must carry a real populated dir: with `sourceDir: ''` the writer's
  // shipped-artifact gate would skip the row anyway and the test would pass
  // even with the portability filter deleted (2026-12 review — the first
  // version of this test was vacuous for exactly that reason).
  const root = tempDir()
  const seeds: ChamberHostPackageSeed[] = [
    ...dualHostSeeds(root),
    {
      insertId: 'open-in',
      packageName: OPEN_IN_PACKAGE_NAME,
      sourceDir: writeHostSeedPackage(root, 'open-in', OPEN_IN_PACKAGE_NAME, 'export const openIn = 1\n'),
      label: 'open-in',
      localOnly: true,
    },
  ]
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, seeds)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.packages.map(entry => entry.insertId), [CLIENT_GRAPH_INSERT_ID, GIT_WORKTREE_INSERT_ID])
  assert.equal(remote.calls.some(call => call.includes(OPEN_IN_PACKAGE_NAME)), false,
    'no remote call ever mentions the local-shape-only package')
  const patch = remote.written.find(entry => entry.path.endsWith('/cordis.patch.yml'))?.bytes.toString('utf8') ?? ''
  assert.equal(patch.includes('open-in'), false, 'not even a dangling loader row')
})
test('seedRemoteChamberHostPackages: an unbuilt package is omitted from files and loader rows', async () => {
  const root = tempDir()
  const seeds = dualHostSeeds(root)
  seeds[1] = { ...seeds[1], sourceDir: join(root, 'not-built') }
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, seeds)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.packages.map(entry => entry.insertId), [CLIENT_GRAPH_INSERT_ID])
  const patch = remote.written.find(entry => entry.path.endsWith('/cordis.patch.yml'))?.bytes.toString('utf8') ?? ''
  assert.ok(patch.includes('id: client-graph'))
  assert.ok(!patch.includes('id: git-worktree'))
  assert.ok(!remote.calls.some(call => call.includes(GIT_WORKTREE_PACKAGE_NAME)))
})
test('seedRemoteChamberHostPackages (single package): module A absent = not shipped → no files AND no patch (never a broken insert)', async () => {
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, singleGraphSeed(join(tempDir(), 'does-not-exist')))
  assert.deepEqual(result, { ok: true, wrote: false, patched: false, packages: [] },
    'an unbuilt package yields no row, no write and no patch')
  assert.deepEqual(remote.calls, [], 'no remote exec at all when module A is absent')
  assert.equal(remote.written.length, 0)
})
test('seedRemoteChamberHostPackages (single package): writes both seed files and appends the patch insert', async () => {
  const sourceDir = moduleASource(JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0' }))
  const remote = makeSeedExec({ patchContent: TEMPLATE })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, singleGraphSeed(sourceDir))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.wrote, true)
  assert.equal(result.patched, true)
  assert.equal(remote.written.length, 3, 'package.json + dist/index.js + patch')
  const patchWrite = remote.written.find(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml')
  assert.ok(patchWrite !== undefined)
  assert.ok(patchWrite.bytes.toString('utf8').includes('- insert:'))
  assert.ok(remote.calls.some(call => call === 'write:~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js'))
})
test('seedRemoteChamberHostPackages (single package): hash-identical seed files are skipped in the BYTE domain, patch still ensured', async () => {
  // dist/index.js carries invalid UTF-8 bytes — the old string-domain hash
  // would have false-mismatched (U+FFFD) and rewritten; the byte-domain
  // comparison must skip.
  const distJs = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x81, 0x00, 0x01])
  const pkgJson = Buffer.from('{"name":"x"}')
  const sourceDir = writeModuleA(tempDir(), pkgJson, distJs)
  const seedFiles = new Map<string, Buffer>()
  seedFiles.set('~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/package.json', pkgJson)
  seedFiles.set('~/.dsh/profiles/node_modules/@dsh-chamber/dsh-chamber-seed-client-graph/dist/index.js', distJs)
  const remote = makeSeedExec({ patchContent: TEMPLATE, seedFiles })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, singleGraphSeed(sourceDir))
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.wrote, false, 'identical bytes are skipped (no rewrite)')
  assert.equal(remote.written.length, 1, 'only the patch write remains')
  assert.equal(remote.written[0].path, '~/.dsh/profiles/web/cordis.patch.yml')
})
test('seedRemoteChamberHostPackages (single package): an uninitialized remote profile (patch ENOENT) fails loud', async () => {
  const remote = makeSeedExec({ patchContent: null })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, singleGraphSeed(moduleASource()))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not initialized/)
  assert.equal(remote.written.length, 0, 'the patch probe runs FIRST — no package files are left behind by the fail-loud path')
})
test('seedRemoteChamberHostPackages (single package): a seed write failure fails loud and never reaches the patch', async () => {
  const remote = makeSeedExec({
    patchContent: TEMPLATE,
    failWrite: path => (path.includes('dist/index.js') ? 'write-file target not allowed' : null),
  })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, singleGraphSeed(moduleASource()))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /write-file failed for dist\/index\.js/)
  assert.ok(!remote.written.some(entry => entry.path === '~/.dsh/profiles/web/cordis.patch.yml'), 'no patch without the package files')
})
test('seedRemoteChamberHostPackages (single package): a NON-ENOENT seed-file cat failure fails loud WITHOUT attempting the write', async () => {
  const remote = makeSeedExec({
    patchContent: TEMPLATE,
    // The FIRST seed-file probe (package.json) dies with an ssh failure —
    // not an ENOENT — so the seed must fail loud before any write, exactly
    // like the patch probe's discipline (never mask a dead ssh behind a
    // misleading "write-file failed").
    failSeedCat: path => (path.endsWith('/package.json') ? 'the ssh exec could not reach the host (exit 255)' : null),
  })
  const result = await seedRemoteChamberHostPackages(remote.exec, SEED_SPEC, singleGraphSeed(moduleASource()))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /host-graph seed read package\.json failed/)
  assert.equal(remote.written.length, 0, 'no write is attempted after a non-ENOENT read-back failure')
  assert.ok(!remote.calls.some(call => call.startsWith('write:')), 'the failing cat is never papered over by a write')
})
test('seedRemoteChamberHostPackages (single package): every probe cat is marked quiet (expected ENOENT on a first seed)', async () => {
  const sourceDir = moduleASource()
  const payloads: TransportRunPayload[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (payload !== undefined) payloads.push(payload)
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const path = payload.argv?.[0] ?? ''
      if (path === '~/.dsh/profiles/web/cordis.patch.yml') return ok(TEMPLATE)
      return err(`run command failed (exit 1): cat: ${path}: No such file or directory`)
    }
    if (action === 'run' && payload?.op === 'write-file') return ok()
    return ok()
  }
  const result = await seedRemoteChamberHostPackages(exec, SEED_SPEC, singleGraphSeed(sourceDir))
  assert.equal(result.ok, true)
  if (!result.ok) return
  const probes = payloads.filter(p => p.op === 'exec' && p.command === 'cat')
  assert.equal(probes.length, 3, 'two seed-file probes + the patch probe')
  assert.ok(probes.every(p => p.quiet === true), 'every probe cat carries quiet: true')
  // A write-file is never quiet: a failed write is a real error, always loud.
  assert.ok(payloads.filter(p => p.op === 'write-file').every(p => p.quiet !== true), 'write-file payloads are never quiet')
})
