#!/usr/bin/env node
/**
 * verify-native-appcast.mjs —— 本版本 appcast 发布物门禁（2026-12 A2 中危，fail-closed）。
 *
 * 为什么单独一个脚本：appcast "生成成功" 不等于客户端能看到这次更新。EdDSA 私钥
 * 已配置时，正式发布必须保证签名发布的 appcast 里真的有**本版本**的条目：
 *   - `sparkle:version` 必须等于 .app 的 CFBundleVersion（Sparkle 用它比较版本；
 *     写成 base 版本号或旧映射 = 永远不提示更新）；
 *   - `sparkle:shortVersionString` 必须是发布版本；
 *   - 同一条 item 的 enclosure 必须指向本版本的 zip。
 * 缺任一条即 FAIL。过去这类偏差只能靠人工核对 appcast，发布照常成功
 * （A2："发布成功但客户端永远看不到更新"）。
 *
 * 期望的 CFBundleVersion 单一来源是 macos/scripts/build-swift-app.mjs 的
 * bundleVersionFor（同一个值写进 Info.plist）。本脚本**静态** import 它：
 * release-artifacts.mjs 被 build-swift-app 静态依赖，如果反过来在
 * release-artifacts 里动态 import，就会在 CLI 入口构成 top-level-await 环而
 * deadlock——所以这个胶水层必须在这里，且必须是静态 import。
 *
 * 用法：
 *   node scripts/release/verify-native-appcast.mjs <version> <appcast-file>
 *
 * 失败 = 非零退出（发布腿据此 FAIL；绝不把"没有本版本条目"降级成日志）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { pathToFileURL } from 'node:url'
import { bundleVersionFor } from '../../macos/scripts/build-swift-app.mjs'
import { assertAppcastAdvertises, nativeMacArtifacts } from './release-artifacts.mjs'

export const APPCAST_USAGE = '用法：verify-native-appcast.mjs <version> <appcast-file>'

/**
 * 校验一个 appcast 文件确实宣传了本版本。
 * @param version - X.Y.Z 或 X.Y.Z-beta.N（release.yml 的 create-release 输出）。
 * @param appcastPath - 发布腿写出的 appcast 文件。
 * @returns 命中条目的事实 `{ version, sparkleVersion, enclosure }`。
 */
export function verifyNativeAppcast(version, appcastPath) {
  const sparkleVersion = bundleVersionFor(version)
  const archiveName = nativeMacArtifacts(version)[1]
  if (!existsSync(appcastPath)) {
    throw new Error(`appcast 不存在：${appcastPath}——签名发布链路未产出本版本的 appcast`)
  }
  return assertAppcastAdvertises(readFileSync(appcastPath, 'utf8'), { version, sparkleVersion, archiveName })
}

function main() {
  const args = argv.slice(2)
  if (args.length !== 2) {
    console.error(APPCAST_USAGE)
    return 1
  }
  try {
    const advertised = verifyNativeAppcast(args[0], args[1])
    console.log(`appcast 本版本门禁通过：${advertised.version}（sparkle:version ${advertised.sparkleVersion}）-> ${advertised.enclosure}`)
    return 0
  } catch (error) {
    console.error(`appcast 本版本门禁失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  exit(main())
}
