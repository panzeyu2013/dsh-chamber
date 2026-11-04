/**
 * bundle-row-disables.ts unit tests (P5b-0): the id-targeted disable for a row a
 * profile BUNDLE mounts, and the two semantics the design pins:
 *   - bundle NOT enabled (the opt-in default) → skip + diagnostic, never a failure;
 *   - bundle ENABLED but the row cannot be proven (absent/misspelled id, name
 *     mismatch, unreadable patch) → fail-closed (throw);
 * plus the production reader over the managed profile and installation anchors
 * (dsh-app-boot's own resolution order) and the load-time registry pin.
 * Run directly: node packages/control-plane/test/plugins/bundle-row-disables.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ROW_DISABLES,
  FORGE_BUNDLE_PACKAGE_NAME,
  FORGE_GITHUB_ROW,
  assertBundleRowDisableTargets,
  profileBundlePatchReader,
  resolveBundleRowDisables,
  type BundleRowDisableTarget,
} from '../../src/bundle-row-disables.ts'
import { parsePatchRows, renderCordisDisablePatches } from '../../src/cordis-inserts.ts'

const FORGE_PATCH = `- insert:
    - id: worktree
      name: '@deepseek-ai/dsh-experimental-worktree'
    - id: tool-worktree
      name: '@deepseek-ai/dsh-experimental-tool-worktree'
    - id: forge
      name: '@deepseek-ai/dsh-experimental-forge'
    - id: forge-github
      name: '@deepseek-ai/dsh-experimental-forge-github'
    - id: forge-session
      name: '@deepseek-ai/dsh-experimental-forge-session'
    - id: optional-forge-panel
      group: true
      isolate:
        worktrees: true
      insert:
        - id: forge-worktree
          name: '@deepseek-ai/dsh-experimental-worktree'
        - id: forge-panel
          name: '@deepseek-ai/dsh-experimental-client-ui-forge'
`

const TARGET: BundleRowDisableTarget = {
  bundle: FORGE_BUNDLE_PACKAGE_NAME,
  id: 'forge-github',
  name: '@deepseek-ai/dsh-experimental-forge-github',
}

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-bundle-disables-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A BundlePatchRead that serves one fixed patch text. */
const readable = (patches: readonly string[]) => () => ({ ok: true as const, patches })

// ---------------------------------------------------------------------------
// The canonical registry (the local overlay applies it every spawn)
// ---------------------------------------------------------------------------

test('the canonical registry disables the forge bundle GitHub provider and is validation-pinned', () => {
  assert.deepEqual(BUNDLE_ROW_DISABLES, [FORGE_GITHUB_ROW])
  assert.equal(FORGE_GITHUB_ROW.id, 'forge-github')
  assert.equal(FORGE_GITHUB_ROW.bundle, '@deepseek-ai/dsh-experimental-forge-bundle')
  assert.equal(FORGE_GITHUB_ROW.name, '@deepseek-ai/dsh-experimental-forge-github')
  // A malformed or ambiguous target must fail at load, not render as a no-op patch.
  assert.throws(() => assertBundleRowDisableTargets([{ ...TARGET, id: 'bad id!' }]), /invalid target/)
  assert.throws(() => assertBundleRowDisableTargets([{ ...TARGET, bundle: 'not-scoped' }]), /invalid target/)
  assert.throws(() => assertBundleRowDisableTargets([TARGET, { ...TARGET }]), /duplicate target/)
})

test('the pinned forge bundle still mounts the row the overlay must disable', t => {
  const patchPath = fileURLToPath(new URL('../../../../vendor/harness-checkout/packages/experimental/forge-bundle/cordis.patch.yml', import.meta.url))
  if (!existsSync(patchPath)) {
    t.skip('vendor/harness-checkout is not materialized')
    return
  }
  const patch = readFileSync(patchPath, 'utf8')
  const rows = parsePatchRows(patch)
  const target = rows.find(row => row.id === FORGE_GITHUB_ROW.id)
  assert.ok(target, 'the pinned bundle must still mount ' + FORGE_GITHUB_ROW.id)
  assert.deepEqual(target.names, [FORGE_GITHUB_ROW.name])
  assert.deepEqual(
    resolveBundleRowDisables({ enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME], readBundlePatches: readable([patch]) }),
    [{ id: FORGE_GITHUB_ROW.id, name: FORGE_GITHUB_ROW.name }],
  )
})

// ---------------------------------------------------------------------------
// resolveBundleRowDisables — idempotent skip vs fail-closed
// ---------------------------------------------------------------------------

test('an unenabled bundle is an idempotent skip: no disable, no patch read, one diagnostic', () => {
  const logs: string[] = []
  let reads = 0
  const disables = resolveBundleRowDisables({
    enabledBundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    readBundlePatches: bundleName => {
      reads += 1
      throw new Error(`must not read ${bundleName}`)
    },
    log: message => { logs.push(message) },
  })
  assert.deepEqual(disables, [], 'the opt-in bundle is off, so the overlay carries no disable row')
  assert.equal(reads, 0, 'a disabled bundle is never resolved or verified')
  assert.equal(logs.length, 1)
  assert.ok(logs[0]!.includes(FORGE_BUNDLE_PACKAGE_NAME), logs[0])
  assert.ok(logs[0]!.includes('forge-github'), logs[0])
  assert.match(logs[0]!, /skipped/)
})

test('an enabled bundle with its row present yields the exact id-targeted disable row', () => {
  const disables = resolveBundleRowDisables({
    enabledBundles: ['@deepseek-ai/dsh-base', FORGE_BUNDLE_PACKAGE_NAME],
    readBundlePatches: readable([FORGE_PATCH]),
    log() {},
  })
  assert.deepEqual(disables, [{ id: 'forge-github', name: '@deepseek-ai/dsh-experimental-forge-github' }])
  assert.equal(
    renderCordisDisablePatches(disables),
    `- id: forge-github\n  name: '@deepseek-ai/dsh-experimental-forge-github'\n  disabled: true\n`,
    'the same canonical renderer the overlay uses produces the row bytes',
  )
})

test('a row INSIDE a group entry is addressable by id (the panel rows)', () => {
  const targets: BundleRowDisableTarget[] = [
    { ...TARGET, id: 'forge-worktree', name: '@deepseek-ai/dsh-experimental-worktree' },
    { ...TARGET, id: 'forge-panel', name: '@deepseek-ai/dsh-experimental-client-ui-forge' },
  ]
  const disables = resolveBundleRowDisables({
    enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME],
    readBundlePatches: readable([FORGE_PATCH]),
    targets,
    log() {},
  })
  assert.deepEqual(disables.map(row => row.id), ['forge-worktree', 'forge-panel'],
    'group children are found at the depth the loader indexes them')
})

test('a misspelled/absent id in an ENABLED bundle is fail-closed', () => {
  assert.throws(
    () => resolveBundleRowDisables({
      enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME],
      readBundlePatches: readable([FORGE_PATCH]),
      targets: [{ ...TARGET, id: 'forge-githb' }],
      log() {},
    }),
    /mounts no row with id 'forge-githb'.*fail-closed/,
  )
})

test('a row bound to another package is fail-closed (the loader would skip the disable)', () => {
  assert.throws(
    () => resolveBundleRowDisables({
      enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME],
      readBundlePatches: readable([FORGE_PATCH]),
      targets: [{ ...TARGET, name: '@deepseek-ai/dsh-experimental-forge' }],
      log() {},
    }),
    /binds 'forge-github' to '@deepseek-ai\/dsh-experimental-forge-github'.*fail-closed/,
  )
})

test('an enabled bundle whose patch cannot be read is fail-closed with the reason', () => {
  assert.throws(
    () => resolveBundleRowDisables({
      enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME],
      readBundlePatches: () => ({ ok: false, reason: 'the bundle package is not installed' }),
      log() {},
    }),
    /is enabled but its patch could not be read \(the bundle package is not installed\).*fail-closed/,
  )
})

test('multiple patch files are verified as one ordered patch list', () => {
  const disables = resolveBundleRowDisables({
    enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME],
    readBundlePatches: readable([
      "- insert:\n    - id: worktree\n      name: '@deepseek-ai/dsh-experimental-worktree'\n",
      "- insert:\n    - id: forge-github\n      name: '@deepseek-ai/dsh-experimental-forge-github'\n",
    ]),
    log() {},
  })
  assert.deepEqual(disables.map(row => row.id), ['forge-github'])
})

// ---------------------------------------------------------------------------
// profileBundlePatchReader — the production anchors (dsh-app-boot order)
// ---------------------------------------------------------------------------

/** A managed web profile with an (empty) user layer and the given bundle layer. */
function writeProfile(dshHome: string, bundles: readonly string[]): string {
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }))
  return profileDir
}

/** A bundle package installed under one anchor's node_modules. */
function writeBundlePackage(anchorDir: string, patchFiles: Record<string, string>): string {
  const packageDir = join(anchorDir, 'node_modules', FORGE_BUNDLE_PACKAGE_NAME)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: FORGE_BUNDLE_PACKAGE_NAME,
    dsh: { bundle: { patch: Object.keys(patchFiles) } },
  }))
  for (const [file, text] of Object.entries(patchFiles)) writeFileSync(join(packageDir, file), text)
  return packageDir
}

test('the production reader resolves a profile-installed bundle and verifies its row', t => {
  const root = tempDir(t)
  const dshHome = join(root, 'dsh-home')
  const profileDir = writeProfile(dshHome, ['@deepseek-ai/dsh-base', FORGE_BUNDLE_PACKAGE_NAME])
  writeBundlePackage(profileDir, { 'cordis.patch.yml': FORGE_PATCH })
  const read = profileBundlePatchReader({ dshHome })
  const result = read(FORGE_BUNDLE_PACKAGE_NAME)
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.patches.length, 1)
  const disables = resolveBundleRowDisables({
    enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME],
    readBundlePatches: read,
    log() {},
  })
  assert.deepEqual(disables, [{ id: 'forge-github', name: '@deepseek-ai/dsh-experimental-forge-github' }])
})

test('the production reader falls back to the dsh installation anchor (hoisted layout)', t => {
  const root = tempDir(t)
  const dshHome = join(root, 'dsh-home')
  writeProfile(dshHome, ['@deepseek-ai/dsh-base', FORGE_BUNDLE_PACKAGE_NAME])
  const dshWorkspacePath = join(root, 'runtime')
  const dshAppDir = join(dshWorkspacePath, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dshAppDir, { recursive: true })
  writeFileSync(join(dshAppDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }))
  writeBundlePackage(dshWorkspacePath, { 'cordis.patch.yml': FORGE_PATCH })
  const result = profileBundlePatchReader({ dshHome, dshWorkspacePath })(FORGE_BUNDLE_PACKAGE_NAME)
  assert.equal(result.ok, true, 'the hoisted installation node_modules is an anchor')
})

test('the production reader reports a resolvable bundle whose declared patch is missing', t => {
  const root = tempDir(t)
  const dshHome = join(root, 'dsh-home')
  const profileDir = writeProfile(dshHome, [FORGE_BUNDLE_PACKAGE_NAME])
  const packageDir = join(profileDir, 'node_modules', FORGE_BUNDLE_PACKAGE_NAME)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: FORGE_BUNDLE_PACKAGE_NAME,
    dsh: { bundle: { patch: './absent.yml' } },
  }))
  const result = profileBundlePatchReader({ dshHome })(FORGE_BUNDLE_PACKAGE_NAME)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.reason, /absent\.yml/)
    assert.match(result.reason, /unreadable/)
  }
  // Fail-closed reaches the caller's error, not a silent no-op.
  assert.throws(
    () => resolveBundleRowDisables({
      enabledBundles: [FORGE_BUNDLE_PACKAGE_NAME],
      readBundlePatches: profileBundlePatchReader({ dshHome }),
      log() {},
    }),
    /fail-closed/,
  )
})

test('the production reader reports an unresolvable bundle and a bundle with no dsh.bundle', t => {
  const root = tempDir(t)
  const dshHome = join(root, 'dsh-home')
  const profileDir = writeProfile(dshHome, [FORGE_BUNDLE_PACKAGE_NAME])
  const missing = profileBundlePatchReader({ dshHome })(FORGE_BUNDLE_PACKAGE_NAME)
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.reason, /not installed/)

  const packageDir = join(profileDir, 'node_modules', FORGE_BUNDLE_PACKAGE_NAME)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: FORGE_BUNDLE_PACKAGE_NAME }))
  const noBundle = profileBundlePatchReader({ dshHome })(FORGE_BUNDLE_PACKAGE_NAME)
  assert.equal(noBundle.ok, false)
  if (!noBundle.ok) assert.match(noBundle.reason, /no dsh\.bundle/)
})
