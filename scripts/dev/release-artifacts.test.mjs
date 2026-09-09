/**
 * release-artifacts.test.mjs —— 双端同 tag 产物清单断言（W-27）
 *
 * 演练清单的可执行面：两族产物名不碰撞、feed 归属唯一（只有 Electron 腿有
 * feed）、命名规则可预测（stable/beta 通道），并与 release.yml 的实际命名
 * 参数一致（Swift 腿 `--artifact-basename dsh-chamber-native-${VERSION}-macos-arm64`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  assertNoCollision,
  electronMacArtifacts,
  electronMacFeed,
  nativeMacArtifacts,
  releaseManifest,
} from './release-artifacts.mjs'

const script = fileURLToPath(new URL('./release-artifacts.mjs', import.meta.url))

test('两族产物名不碰撞（-native 命名空间隔离）', () => {
  const electron = electronMacArtifacts('0.3.0')
  const native = nativeMacArtifacts('0.3.0')
  assert.equal(assertNoCollision(electron, native), true)
  assert.deepEqual(electron, ['dsh-chamber-0.3.0-arm64.dmg', 'dsh-chamber-0.3.0-arm64-mac.zip'])
  assert.deepEqual(native, [
    'dsh-chamber-native-0.3.0-macos-arm64.dmg',
    'dsh-chamber-native-0.3.0-macos-arm64.zip',
  ])
  assert.throws(
    () => assertNoCollision(electron, [electron[0]]),
    /产物名碰撞/,
  )
})

test('feed 归属唯一：只有 Electron 腿产出 yml', () => {
  assert.equal(electronMacFeed('0.3.0'), 'latest-mac.yml')
  assert.equal(electronMacFeed('0.3.0-beta.2'), 'beta-mac.yml')
  const manifest = releaseManifest('0.3.0-beta.2')
  assert.equal(manifest.electron.feed, 'beta-mac.yml')
  assert.equal(manifest.native.feed, null, 'Swift v1 blocked-available 无 appcast/feed')
  for (const name of manifest.native.artifacts) {
    assert.doesNotMatch(name, /\.ya?ml$/)
  }
})

test('release.yml 的 Swift 命名参数与本清单一致', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const native = nativeMacArtifacts('1.2.3')
  assert.match(workflow, /--app-name dsh-chamber-native/)
  assert.match(workflow, /--artifact-basename "dsh-chamber-native-\$\{VERSION\}-macos-arm64"/)
  // 清单里的 dmg/zip 基名 = workflow 的 --artifact-basename。
  for (const name of native) {
    assert.ok(name.startsWith('dsh-chamber-native-1.2.3-macos-arm64'), name)
  }
  // Swift 腿不得生成/上传更新 feed（Electron 独占 latest-mac.yml/beta-mac.yml）。
  const swiftJob = workflow.slice(
    workflow.indexOf('\n  build-swift:'),
    workflow.indexOf('\n  finalize-release:'),
  )
  assert.doesNotMatch(swiftJob, /latest-mac\.yml|beta-mac\.yml|appcast/)
})

test('CLI 输出 JSON 清单', () => {
  const out = execFileSync(process.execPath, [script, '0.4.0'], { encoding: 'utf8' })
  const manifest = JSON.parse(out)
  assert.equal(manifest.version, '0.4.0')
  assert.deepEqual(manifest.electron.artifacts, electronMacArtifacts('0.4.0'))
  assert.deepEqual(manifest.native.artifacts, nativeMacArtifacts('0.4.0'))
})
