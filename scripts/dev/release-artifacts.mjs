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
 *
 * CLI：`node scripts/dev/release-artifacts.mjs <version> [--check-dir <dir>]`。
 * `--check-dir` 进一步断言清单里的 native 产物确实存在于发布腿输出目录——
 * W-26 的真实消费者（release.yml 的 verify 步在上传前调用它，见脚本内注释）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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
    // 原生壳的更新源是 Sparkle appcast（S-01 / 裁决 D-1 选 B）：release 腿在 EdDSA
    // 私钥存在时生成 appcast-swift.xml 并随 release 上传；它不是与产物同名的文件，
    // 故不进 artifacts（--check-dir 也不强制它存在——私钥缺失时该构建只是没有安装
    // 腿，仍照常出包）。
    native: { artifacts: native, feed: 'appcast-swift.xml' },
  }
}

/** 清单里在 dir 下缺失的文件名（--check-dir 的判定；导出以便单测）。 */
export function missingArtifacts(names, dir, exists = existsSync) {
  return names.filter((name) => !exists(join(dir, name)))
}

function main() {
  const argv = process.argv.slice(2)
  let version = null
  let checkDir = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check-dir') {
      checkDir = argv[index + 1] ?? null
      index += 1
      if (checkDir === null) {
        console.error('用法：release-artifacts.mjs <version> [--check-dir <dir>]')
        process.exit(1)
      }
    } else if (version === null) {
      version = argv[index]
    } else {
      console.error(`未知参数：${argv[index]}`)
      process.exit(1)
    }
  }
  if (version === null || version === '') {
    console.error('用法：release-artifacts.mjs <version> [--check-dir <dir>]')
    process.exit(1)
  }
  const manifest = releaseManifest(version)
  console.log(JSON.stringify(manifest, null, 2))
  // W-26 消费者：发布腿在 build:swift-app 之后用它断言**实际要上传的** native
  // 文件名与清单逐字一致（Electron 腿的产物由 build-macos 生成，不在本检查面）。
  if (checkDir !== null) {
    const missing = missingArtifacts(manifest.native.artifacts, checkDir)
    if (missing.length > 0) {
      console.error(`发布清单中的 native 产物在 ${checkDir} 缺失：${missing.join(', ')}`)
      process.exit(1)
    }
  }
}

if (process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
