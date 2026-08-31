import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertRemotePackageContract, remotePackagesFromAssembly } from './typert-remote-contract.mjs'

const VENDOR = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))

test('rc.8 dsh-api-remotes assembly and renderer generation stay in lockstep', () => {
  const source = readFileSync(`${VENDOR}dsh-api-remotes/src/client/index.ts`, 'utf8')
  const packages = remotePackagesFromAssembly(source)
  // dsh-v0.1.2-alpha.1 assembly: api-remotes' client now value-imports the
  // settings/session/workspace controllers' /remote faces (P2-10); the old
  // dsh-file-reference row is gone from the assembly.
  assert.deepEqual(packages, [
    '@deepseek-ai/dsh-agent-presets',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-api-settings-controller',
    '@deepseek-ai/dsh-goal',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-cordis-host-runner',
    '@deepseek-ai/dsh-host-plugin-inventory',
    '@deepseek-ai/dsh-message-feedback',
    '@deepseek-ai/dsh-session-reference',
    '@deepseek-ai/dsh-subagent',
    '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-api-workspace-controller',
  ])
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
