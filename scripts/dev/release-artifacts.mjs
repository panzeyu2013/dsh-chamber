#!/usr/bin/env node
/**
 * release-artifacts.mjs —— 双端同 tag 产物清单（W-27；design 25 §8.4/§六）
 *
 * 单 tag 下两个 macOS 产物族并存（D2 共存决策）：
 *   Electron 腿（build-macos，既有）：dsh-chamber-<v>-arm64.dmg /
 *     dsh-chamber-<v>-arm64-mac.zip + 更新 feed（latest-mac.yml | beta-mac.yml）
 *   Swift 腿（build-swift，W-26）：dsh-chamber-native-<v>-macos-arm64.dmg /
 *     .zip，**无 feed**（v1 blocked-available 不做 Sparkle appcast，design 25 §7）
 *
 * 本模块把"产物名不得碰撞 / feed 归属唯一"从散文变成可执行断言（演练清单 +
 * 策略测试共用）：Electron 的名字不含 `-native`，Swift 的名字必含 `-native`；
 * 只有 Electron 腿产出 `*.yml` feed。
 */
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Electron mac 腿产物（electron-builder 缺省命名：productName-version-arch[-mac].ext）。 */
export function electronMacArtifacts(version) {
  return [
    `dsh-chamber-${version}-arm64.dmg`,
    `dsh-chamber-${version}-arm64-mac.zip`,
  ]
}

/** Electron mac 更新 feed（稳定通道 latest / beta 通道 beta，二选一）。 */
export function electronMacFeed(version) {
  return version.includes('-') ? `beta-mac.yml` : `latest-mac.yml`
}

/** Swift 原生壳产物（W-26 build-swift：-native 命名，无 feed）。 */
export function nativeMacArtifacts(version) {
  return [
    `dsh-chamber-native-${version}-macos-arm64.dmg`,
    `dsh-chamber-native-${version}-macos-arm64.zip`,
  ]
}

/** 两族产物名必须互不碰撞（防同 tag 上传互相覆盖/--clobber 误删）。 */
export function assertNoCollision(left, right) {
  const overlap = left.filter((name) => right.includes(name))
  if (overlap.length > 0) {
    throw new Error(`产物名碰撞：${overlap.join(', ')}`)
  }
  return true
}

/** 单 tag 完整清单（演练用；不含 .blockmap——finalize 会删除）。 */
export function releaseManifest(version) {
  const electron = electronMacArtifacts(version)
  const native = nativeMacArtifacts(version)
  assertNoCollision(electron, native)
  return {
    version,
    electron: { artifacts: electron, feed: electronMacFeed(version) },
    native: { artifacts: native, feed: null },
  }
}

function main() {
  const version = process.argv[2]
  if (version === undefined || version === '') {
    console.error('用法：release-artifacts.mjs <version>')
    process.exit(1)
  }
  const manifest = releaseManifest(version)
  console.log(JSON.stringify(manifest, null, 2))
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
