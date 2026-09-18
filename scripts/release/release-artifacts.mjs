#!/usr/bin/env node
/**
 * release-artifacts.mjs —— 双端同 tag 产物清单（W-27；design 25 §8.4/§六）
 *
 * 单 tag 下两个 macOS 产物族并存（D2 共存决策）：
 *   Electron 腿（build-macos，既有）：dsh-chamber-electron-<v>-arm64.dmg /
 *     dsh-chamber-electron-<v>-arm64-mac.zip + 更新 feed（latest-mac.yml | beta-mac.yml）
 *   Swift 腿（build-swift，W-26）：dsh-chamber-<v>-macos-arm64.dmg /
 *     .zip + Sparkle appcast（S-01 / 裁决 D-1 选 B；S-22 双通道：稳定版
 *     appcast-swift.xml，beta 版 appcast-swift-beta.xml——beta 是 GitHub
 *     prerelease，releases/latest 解析不到它，因此 beta appcast 每次发布都覆盖
 *     到**滚动 tag/release**（NATIVE_BETA_ROLLING_TAG）上的同名 asset，beta.N
 *     客户端据此能看到 beta.N+1；S-36：appcast 引用的每个 zip 也上传到该滚动
 *     release（enclosure 逐条可下载），且 beta appcast 同时收最新 final 条目
 *     （S-22/S-23：beta 客户端能看到 final，与 Electron 的 latest.yml 回退对齐）。
 *
 * 本模块把"产物名不得碰撞 / feed 归属唯一"从散文变成可执行断言（演练清单 +
 * 策略测试共用）：Electron 的名字必含 `-electron`，Swift 原生腿用裸名 `dsh-chamber-`
 * （2026-12 命名归属反转：旧约定是 Electron 裸名 / Swift 带 `-native` 后缀）；
 * 只有 Electron 腿产出 `*.yml` feed，Swift 腿的更新源是 `*.xml` appcast。
 *
 * CLI：`node scripts/release/release-artifacts.mjs <version> [--check-dir <dir>]`。
 * `--check-dir` 进一步断言清单里的 native 产物确实存在于发布腿输出目录——
 * W-26 的真实消费者（release.yml 的 verify 步在上传前调用它，见脚本内注释）。
 * 2026-12 A2 的 appcast 本版本门禁（sparkle:version = CFBundleVersion、enclosure
 * = 本版本 zip，缺一即 FAIL）在 scripts/release/verify-native-appcast.mjs——它静态
 * import build-swift-app 的映射；本模块只导出纯断言 assertAppcastAdvertises。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Electron mac 腿产物（electron-builder 缺省命名：productName-version-arch[-mac].ext）。 */
export function electronMacArtifacts(version) {
  return [
    `dsh-chamber-electron-${version}-arm64.dmg`,
    `dsh-chamber-electron-${version}-arm64-mac.zip`,
  ]
}

/** Electron mac 更新 feed（稳定通道 latest / beta 通道 beta，二选一）。 */
export function electronMacFeed(version) {
  return version.includes('-') ? `beta-mac.yml` : `latest-mac.yml`
}

/** Swift 原生壳产物（W-26 build-swift：裸名 dsh-chamber-…；更新源 = Sparkle appcast）。 */
export function nativeMacArtifacts(version) {
  return [
    `dsh-chamber-${version}-macos-arm64.dmg`,
    `dsh-chamber-${version}-macos-arm64.zip`,
  ]
}

/** Swift 原生壳的 Sparkle appcast（S-22：稳定/beta 通道各自一个 feed 资产）。 */
export function nativeMacFeed(version) {
  return version.includes('-') ? 'appcast-swift-beta.xml' : 'appcast-swift.xml'
}

/**
 * 滚动 beta appcast 的 release tag（S-22 单源；release.yml 的 build-swift job env
 * 与本常量逐字一致，由 release-workflow-policy.test.mjs 锁步）。
 *
 * 为什么需要滚动 tag：beta 是 GitHub prerelease，`releases/latest/download/…` 恒
 * 解析不到；而版本固定形 `releases/download/v<ver>/…` 只会指向 beta.N 自己的
 * 资产——beta.N 客户端永远发现不了 beta.N+1。所以每次 beta 都把 appcast 以
 * --clobber 覆盖到这一个 tag/release 的同名 asset 上。
 *
 * **不以 v 开头**：release.yml 的 tag 触发是 `v*`（push tags: v*），滚动 tag
 * 绝不能触发一次发布运行。
 */
export const NATIVE_BETA_ROLLING_TAG = 'appcast-swift-beta'

/** 原生壳 appcast 在 release 下的相对路径（稳定 = releases/latest；beta = 滚动
 *  tag 的 asset）。与 nativeMacFeed 同源：路径末段就是通道 feed 文件名。 */
export function nativeMacFeedPath(version) {
  return version.includes('-')
    ? `releases/download/${NATIVE_BETA_ROLLING_TAG}/appcast-swift-beta.xml`
    : 'releases/latest/download/appcast-swift.xml'
}

/** 原生壳 appcast 的完整 URL（repository 形如 `owner/repo`）。发布腿用
 *  ${GITHUB_REPOSITORY} 拼同一路径；策略测试据此断言 workflow 的注入 URL。 */
export function nativeMacFeedUrl(version, repository) {
  return `https://github.com/${repository}/${nativeMacFeedPath(version)}`
}

/**
 * beta appcast 的 enclosure 下载前缀（S-36 单源；纯函数，测试直测）。
 *
 * Sparkle 的 generate_appcast 缺省把 enclosure 解析为「zip 文件名相对该 zip 内嵌
 * SUFeedURL」（ArchiveItem.archiveURL：URL(string:filename, relativeTo:feedURL)），
 * 而 beta zip 内嵌的 SUFeedURL 是滚动 tag 的 appcast URL ⇒ enclosure 落在
 * releases/download/<rolling-tag>/<zip>。zip 必须真的上传到那个 release，或者
 * 用 --download-url-prefix 显式钉住同一前缀——本函数就是后者，且发布腿把
 * appcast 引用的**每个** zip 一并上传到滚动 release（S-36：enclosure 可下载）。
 *
 * **尾部斜杠不可省**：URL(string:relativeTo:) 会把 prefix 的最后一段当作文件名
 * 替换掉，少一个斜杠就得到 releases/download/<zip> 而不是
 * releases/download/<tag>/<zip>。stable 的对应值见 nativeAppcastDownloadPrefix
 * （null = 不传前缀，保持 releases/latest 的相对解析形状逐字节不变）。
 */
export function nativeBetaRollingDownloadPrefix(repository) {
  return `https://github.com/${repository}/releases/download/${NATIVE_BETA_ROLLING_TAG}/`
}

/** appcast 生成时应传的 --download-url-prefix：beta = 滚动 tag 下载目录（zip 与
 *  appcast 同 release）；stable = null（**绝不传前缀**：stable zip 内嵌 SUFeedURL
 *  是 releases/latest/download/appcast-swift.xml，相对解析得到
 *  releases/latest/download/<zip>，正是既有正确形状）。 */
export function nativeAppcastDownloadPrefix(version, repository) {
  return version.includes('-') ? nativeBetaRollingDownloadPrefix(repository) : null
}

/** 最新 final release 的 native zip 模式（S-22/S-23：beta appcast 同时收当前 beta
 *  与最新 final，beta 客户端因此能看到 final——Electron beta 经 latest.yml 回退
 *  本来就能看到；发布腿用 gh release download 按本模式取件）。 */
export const NATIVE_STABLE_ZIP_PATTERN = 'dsh-chamber-*-macos-arm64.zip'

/**
 * 复刻 Sparkle 的 enclosure 绝对 URL 解析（S-36 锁步；纯函数，测试直测）：
 * 有 downloadPrefix 时用它，否则用 feedUrl 去掉末段后的目录。
 * @param archiveName zip 文件名（asset 名）
 * @param feedUrl zip 内嵌 SUFeedURL（beta = 滚动 tag appcast；stable = releases/latest）
 * @param downloadPrefix 生成时传的 --download-url-prefix（null = 未传）
 */
export function nativeEnclosureUrl(archiveName, feedUrl, downloadPrefix = null) {
  return new URL(archiveName, downloadPrefix ?? feedUrl).toString()
}

/**
 * appcast 的 <item> 块（generate_appcast 的输出不嵌套 <item>）。
 *
 * 期望的 `sparkle:version`（CFBundleVersion 映射）由调用方传入：单一来源是
 * macos/scripts/build-swift-app.mjs 的 bundleVersionFor，它同时写进 .app 的
 * Info.plist（Sparkle 用 CFBundleVersion 比较版本）。scripts/release/
 * verify-native-appcast.mjs 是本断言的 CLI 消费者——它静态 import 那份映射，
 * 绝不在本模块里动态 import build-swift-app：那会在 CLI 入口构成
 * top-level-await 环（本模块被 build-swift-app 静态依赖），直接 deadlock。
 */
export function appcastItems(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => match[1])
}

/**
 * 取一条 item 里的 sparkle 字段：元素形（`<sparkle:x>v</sparkle:x>`，generate_appcast
 * 的输出版本）或属性形（`sparkle:x="v"`，Sparkle 1.x 的 enclosure 形状）。
 * @returns 字段值，缺失时 null。
 */
export function appcastSparkleField(item, field) {
  const element = new RegExp(`<sparkle:${field}>([^<]*)</sparkle:${field}>`).exec(item)
  if (element !== null) return element[1].trim()
  const attribute = new RegExp(`\\bsparkle:${field}="([^"]*)"`).exec(item)
  return attribute === null ? null : attribute[1].trim()
}

/** 一条 item 引用的 enclosure URL（可多条：zip 与 delta）。 */
export function appcastEnclosureUrls(item) {
  return [...item.matchAll(/<enclosure\b[^>]*\burl="([^"]+)"/g)].map((match) => match[1])
}

/**
 * 发布物门禁（A2 中危，fail-closed）：appcast 必须真实宣传**本版本**。
 *
 * "generate_appcast 产出了文件"不等于客户端能看到这次更新：它可能只为别的归档
 * 生成条目，或本版本的 sparkle:version 与 Info.plist 的 CFBundleVersion 不一致
 * （Sparkle 用后者比较版本——错了就是"发布成功、永远不提示更新"）。断言要求同一
 * 条 item 同时满足：
 *   1. `sparkle:shortVersionString` == 发布版本（人类可读版本号）；
 *   2. `sparkle:version` == 调用方传入的 CFBundleVersion（build-swift-app 的
 *      bundleVersionFor(version)，Sparkle 的升级比较字段）；
 *   3. enclosure 至少有一条 URL 指向本版本的 zip 文件名。
 * 任一缺失即抛错——调用方（release.yml 的 appcast 步与滚动 beta 刷新）必须 FAIL。
 * @param xml - appcast 文件内容。
 * @param input - `{ version, sparkleVersion, archiveName? }`。
 * @returns 命中条目的事实（版本/比较字段/enclosure）。
 */
export function assertAppcastAdvertises(xml, { version, sparkleVersion, archiveName = nativeMacArtifacts(version)[1] }) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new Error(`appcast 为空（或不可读）——无法断言 ${version} 的条目/enclosure 已被签名发布`)
  }
  const items = appcastItems(xml)
  if (items.length === 0) {
    throw new Error(`appcast 没有任何 <item>——${version} 没有被这次发布宣传`)
  }
  const isVersionArchive = (url) => url.endsWith(`/${archiveName}`) || url === archiveName
  const matched = items.find((item) => {
    if (appcastSparkleField(item, 'shortVersionString') !== version) return false
    if (sparkleVersion !== null && sparkleVersion !== undefined
      && appcastSparkleField(item, 'version') !== sparkleVersion) return false
    return appcastEnclosureUrls(item).some(isVersionArchive)
  })
  if (matched === undefined) {
    const found = items.map((item) => {
      const short = appcastSparkleField(item, 'shortVersionString') ?? '?'
      const bundle = appcastSparkleField(item, 'version') ?? '?'
      return `${short} (sparkle:version ${bundle})`
    }).join('; ')
    const expected = `sparkle:shortVersionString=${version}`
      + (sparkleVersion === null || sparkleVersion === undefined ? '' : `、sparkle:version=${sparkleVersion}`)
      + `、enclosure 指向 ${archiveName}`
    throw new Error(`appcast 不含本版本的条目/enclosure（需要 ${expected}；appcast 条目：${found}）`)
  }
  return {
    version,
    sparkleVersion: appcastSparkleField(matched, 'version'),
    enclosure: appcastEnclosureUrls(matched).find(isVersionArchive),
  }
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
    // 原生壳的更新源是 Sparkle appcast（S-01 / 裁决 D-1 选 B；S-22 双通道）：
    // release 腿在 EdDSA 私钥存在时生成 nativeMacFeed(version) 并随 release 上传。
    // 它不是与产物同名的文件，故不进 artifacts（--check-dir 也不强制它存在——
    // 私钥缺失时该构建只是没有安装腿，仍照常出包）。
    native: { artifacts: native, feed: nativeMacFeed(version) },
  }
}

/** 清单里在 dir 下缺失的文件名（--check-dir 的判定；导出以便单测）。 */
export function missingArtifacts(names, dir, exists = existsSync) {
  return names.filter((name) => !exists(join(dir, name)))
}

const USAGE = '用法：release-artifacts.mjs <version> [--check-dir <dir>]'

function main() {
  const argv = process.argv.slice(2)
  let version = null
  let checkDir = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--check-dir') {
      checkDir = argv[index + 1] ?? null
      index += 1
      if (checkDir === null) {
        console.error(USAGE)
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
    console.error(USAGE)
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
