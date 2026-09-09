import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertRemotePackageContract,
  EXPECTED_REMOTE_PACKAGES,
  remoteMountPackages,
  remotePackagesFromAssembly,
} from './typert-remote-contract.mjs'

const VENDOR = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))

test('rc.8 dsh-api-remotes assembly and renderer generation stay in lockstep', () => {
  const source = readFileSync(`${VENDOR}dsh-api-remotes/src/client/index.ts`, 'utf8')
  const packages = remotePackagesFromAssembly(source)
  // The expected list is single-sourced in typert-remote-contract.mjs (shared
  // with the upgrade gate's C4) so an upstream assembly change is ONE edit.
  assert.deepEqual(packages, [...EXPECTED_REMOTE_PACKAGES])
  // Imports are only the SELECTION; the apply() mount array is what becomes
  // ctx.remote. A same-length edit to the array alone must fail (W4-Q5-F1).
  assert.deepEqual(remoteMountPackages(source), [...EXPECTED_REMOTE_PACKAGES])
  for (const packageName of packages) {
    const shortName = packageName.slice('@deepseek-ai/'.length)
    const manifest = JSON.parse(readFileSync(`${VENDOR}${shortName}/package.json`, 'utf8'))
    assertRemotePackageContract(packageName, manifest)
  }
})

test('only value imports select runtime contributions and duplicates preserve first order', () => {
  assert.deepEqual(remotePackagesFromAssembly(`
    import first from '@deepseek-ai/dsh-first/remote'
    export type {} from '@deepseek-ai/dsh-type-only/remote'
    import firstAgain from '@deepseek-ai/dsh-first/remote'
    import second from '@deepseek-ai/dsh-second-part/remote'
  `), [
    '@deepseek-ai/dsh-first',
    '@deepseek-ai/dsh-second-part',
  ])
})

test('empty assemblies and noncanonical Remote exports fail loud', () => {
  assert.throws(
    () => remotePackagesFromAssembly("export type {} from '@deepseek-ai/dsh-only-type/remote'"),
    /does not value-import/,
  )
  assert.throws(
    () => assertRemotePackageContract('@deepseek-ai/dsh-example', {
      name: '@deepseek-ai/dsh-example',
      exports: { './remote': './lib/remote.js' },
      files: [],
    }),
    /\.\/remote must export/,
  )
})

test('the parser ignores type-only clauses and comments, and fails loud on unmodelled edges', () => {
  // Type-only named clauses select nothing; a MIXED clause selects a value.
  assert.deepEqual(remotePackagesFromAssembly(`
    import type typed from '@deepseek-ai/dsh-a/remote'
    import { type B1, type B2 } from '@deepseek-ai/dsh-b/remote'
    import { type C1, c2 } from '@deepseek-ai/dsh-c/remote'
  `), ['@deepseek-ai/dsh-c'])

  // A commented-out import is invisible in both directions.
  assert.deepEqual(remotePackagesFromAssembly(`
    // import dead from '@deepseek-ai/dsh-dead/remote'
    /* import alsoDead from '@deepseek-ai/dsh-also-dead/remote' */
    import live from '@deepseek-ai/dsh-live/remote'
  `), ['@deepseek-ai/dsh-live'])

  // A genuinely multi-line CLAUSE is an unmodelled edge: fail loud, never
  // silently drop. (A clause on one line with the `from` wrapped is handled.)
  assert.deepEqual(remotePackagesFromAssembly(`
    import first
      from '@deepseek-ai/dsh-first/remote'
  `), ['@deepseek-ai/dsh-first'])
  assert.throws(
    () => remotePackagesFromAssembly(`
      import {
        first,
      } from '@deepseek-ai/dsh-first/remote'
    `),
    /unmodelled/,
  )
  // A value re-export is likewise unmodelled.
  assert.throws(
    () => remotePackagesFromAssembly("export { x } from '@deepseek-ai/dsh-x/remote'"),
    /unmodelled/,
  )
})

test('remoteMountPackages reads the apply() mount array in order', () => {
  const source = `
    import a from '@deepseek-ai/dsh-a/remote'
    import b from '@deepseek-ai/dsh-b/remote'
    export async function apply(ctx) {
      for (const contribution of [b, a]) {
        await ctx.remote.$mount(contribution)
      }
    }
  `
  assert.deepEqual(remoteMountPackages(source), ['@deepseek-ai/dsh-b', '@deepseek-ai/dsh-a'])
  // An identifier no import binds fails loud.
  assert.throws(
    () => remoteMountPackages(`
      import a from '@deepseek-ai/dsh-a/remote'
      for (const c of [a, unknownBinding]) {}
    `),
    /no \/remote import binds/,
  )
  // No mount array at all is a structural drift.
  assert.throws(
    () => remoteMountPackages("import a from '@deepseek-ai/dsh-a/remote'"),
    /no .*mount array/,
  )
})
