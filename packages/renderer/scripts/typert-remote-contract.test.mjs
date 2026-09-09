import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertRemotePackageContract,
  EXPECTED_REMOTE_PACKAGES,
  remotePackagesFromAssembly,
} from './typert-remote-contract.mjs'

const VENDOR = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))

test('rc.8 dsh-api-remotes assembly and renderer generation stay in lockstep', () => {
  const source = readFileSync(`${VENDOR}dsh-api-remotes/src/client/index.ts`, 'utf8')
  const packages = remotePackagesFromAssembly(source)
  // The expected list is single-sourced in typert-remote-contract.mjs (shared
  // with the upgrade gate's C4) so an upstream assembly change is ONE edit.
  assert.deepEqual(packages, [...EXPECTED_REMOTE_PACKAGES])
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
