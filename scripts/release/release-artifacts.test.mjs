/**
 * release-artifacts.test.mjs —— 双端同 tag 产物清单断言（W-27）：两族产物名不碰撞、feed
 * 归属唯一（Electron 腿 yml feed vs Swift 腿 Sparkle appcast，S-22 双通道）、命名规则可预测
 * （stable/beta 通道），并与 release.yml 的 --artifact-basename 命名参数一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NATIVE_BETA_ROLLING_TAG,
  NATIVE_STABLE_ZIP_PATTERN,
  appcastEnclosureUrls,
  appcastItems,
  appcastSparkleField,
  assertAppcastAdvertises,
  assertNoCollision,
  electronMacArtifacts,
  electronMacFeed,
  missingArtifacts,
  nativeAppcastDownloadPrefix,
  nativeBetaRollingDownloadPrefix,
  nativeEnclosureUrl,
  nativeMacArtifacts,
  nativeMacFeed,
  nativeMacFeedPath,
  nativeMacFeedUrl,
  releaseManifest,
} from './release-artifacts.mjs'
import { APPCAST_USAGE, verifyNativeAppcast } from './verify-native-appcast.mjs'
// The appcast's sparkle:version is the .app CFBundleVersion; the mapping stays single-sourced with the Swift builder (lockstep asserted below).
import { bundleVersionFor } from '../../macos/scripts/build-swift-app.mjs'

const script = fileURLToPath(new URL('./release-artifacts.mjs', import.meta.url))
const appcastScript = fileURLToPath(new URL('./verify-native-appcast.mjs', import.meta.url))

test('两族产物名不碰撞（-electron 命名空间隔离）', () => {
  const electron = electronMacArtifacts('0.3.0')
  const native = nativeMacArtifacts('0.3.0')
  assert.equal(assertNoCollision(electron, native), true)
  assert.deepEqual(electron, ['dsh-chamber-electron-0.3.0-arm64.dmg', 'dsh-chamber-electron-0.3.0-arm64-mac.zip'])
  assert.deepEqual(native, [
    'dsh-chamber-0.3.0-macos-arm64.dmg',
    'dsh-chamber-0.3.0-macos-arm64.zip',
  ])
  assert.throws(
    () => assertNoCollision(electron, [electron[0]]),
    /产物名碰撞/,
  )
})

test('feed 归属唯一：Electron 产出 yml，Swift 产出 appcast（S-22 双通道）', () => {
  assert.equal(electronMacFeed('0.3.0'), 'latest-mac.yml')
  assert.equal(electronMacFeed('0.3.0-beta.2'), 'beta-mac.yml')
  assert.equal(nativeMacFeed('0.3.0'), 'appcast-swift.xml')
  assert.equal(nativeMacFeed('0.3.0-beta.2'), 'appcast-swift-beta.xml',
    'beta 是 GitHub prerelease，/releases/latest 解析不到，必须有自己的 appcast')

  // S-22 双通道 URL（稳定 = releases/latest；beta = 滚动 tag 的 asset）。
  assert.equal(NATIVE_BETA_ROLLING_TAG, 'appcast-swift-beta')
  assert.ok(!NATIVE_BETA_ROLLING_TAG.startsWith('v'),
    '滚动 tag 不得以 v 开头——release.yml 的 tag 触发是 v*，否则创建滚动 release 会触发一次发布')
  assert.equal(
    nativeMacFeedUrl('0.3.0', 'panzeyu2013/dsh-chamber'),
    'https://github.com/panzeyu2013/dsh-chamber/releases/latest/download/appcast-swift.xml',
    '稳定通道 URL 保持不变（releases/latest 只解析非 prerelease）')
  assert.equal(
    nativeMacFeedUrl('0.3.0-beta.2', 'panzeyu2013/dsh-chamber'),
    'https://github.com/panzeyu2013/dsh-chamber/releases/download/appcast-swift-beta/appcast-swift-beta.xml',
    'beta.N 必须从滚动 tag 发现 beta.N+1（版本固定 tag 只会看到 beta.N 自己）')
  assert.equal(nativeMacFeedPath('0.3.0'), 'releases/latest/download/appcast-swift.xml')
  assert.equal(nativeMacFeedPath('0.3.0-beta.2'),
    'releases/download/appcast-swift-beta/appcast-swift-beta.xml')
  const stable = releaseManifest('0.3.0')
  assert.equal(stable.electron.feed, 'latest-mac.yml')
  assert.equal(stable.native.feed, 'appcast-swift.xml',
    '稳定通道原生壳更新源 = appcast-swift.xml（S-01 / 裁决 D-1 选 B）')

  const beta = releaseManifest('0.3.0-beta.2')
  assert.equal(beta.electron.feed, 'beta-mac.yml')
  assert.equal(beta.native.feed, 'appcast-swift-beta.xml',
    'beta 通道原生壳更新源 = Sparkle beta appcast（S-22）')
  for (const name of beta.native.artifacts) {
    assert.doesNotMatch(name, /\.ya?ml$/)
  }
})

test('release.yml 的 Swift 命名参数与本清单一致', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const native = nativeMacArtifacts('1.2.3')
  assert.match(workflow, /--app-name dsh-chamber/)
  assert.match(workflow, /--artifact-basename "dsh-chamber-\$\{VERSION\}-macos-arm64"/)
  // 清单里的 dmg/zip 基名 = workflow 的 --artifact-basename。
  for (const name of native) {
    assert.ok(name.startsWith('dsh-chamber-1.2.3-macos-arm64'), name)
  }
  // Electron/Squirrel 的 feed 仍归 Electron 腿；Swift 腿的更新源是 Sparkle appcast（S-01 /
  // 裁决 D-1 选 B；S-22 双通道），必须由 EdDSA 私钥签名，dry-run 不进入该步。
  const swiftJob = workflow.slice(
    workflow.indexOf('\n  build-swift:'),
    workflow.indexOf('\n  finalize-release:'),
  )
  assert.doesNotMatch(swiftJob, /latest-mac\.yml|beta-mac\.yml/, 'Squirrel feed 不得出现在 Swift 腿')
  assert.match(swiftJob, /appcast-swift\.xml/, '稳定通道原生壳更新源 = appcast-swift.xml')
  assert.match(swiftJob, /appcast-swift-beta\.xml/, 'beta 通道原生壳更新源 = appcast-swift-beta.xml（S-22）')
  assert.match(swiftJob, /releases\/latest\/download\/appcast-swift\.xml/,
    '稳定 feed URL 必须保持不变（releases/latest 只解析非 prerelease）')
  assert.ok(!swiftJob.includes('/releases/download/v${VERSION}/appcast-swift-beta.xml'),
    'beta feed 绝不钉在版本 tag 上：beta.N 必须看到 beta.N+1（S-22 滚动通道）')
  assert.ok(swiftJob.includes('releases/download/${SPARKLE_BETA_ROLLING_TAG}/appcast-swift-beta.xml'),
    'beta feed URL 必须解析到滚动 tag 的 beta appcast（S-22）')
  assert.ok(swiftJob.includes(`SPARKLE_BETA_ROLLING_TAG: ${NATIVE_BETA_ROLLING_TAG}`),
    '滚动 tag 必须在 build-swift job env 单一定义，且与 release-artifacts.mjs 逐字锁步')
  // 滚动发布：tag/release 缺失即幂等创建（prerelease，不影响 releases/latest），beta 每次
  // --clobber 覆盖同一 appcast；S-36：appcast 引用的 zip 也上传到该 release（enclosure 可下载），
  // 发布发生在 verify 之后的 upload 步。只看代码行（注释文案不构成断言满足，同 release-workflow-policy 纪律）。
  const swiftJobCode = swiftJob.split('\n').filter((line) => !/^[ \t]*#/.test(line)).join('\n')
  assert.match(swiftJobCode, /ROLLING_TAG="\$\{SPARKLE_BETA_ROLLING_TAG\}"/)
  assert.match(swiftJobCode, /gh release view "\$ROLLING_TAG" --repo "\$GITHUB_REPOSITORY"/)
  assert.match(swiftJobCode, /gh release create "\$ROLLING_TAG"/)
  assert.match(swiftJobCode, /--prerelease/)
  assert.match(swiftJobCode, /gh release upload "\$ROLLING_TAG" "\$BETA_APPCAST" --clobber/,
    '滚动 appcast 发布（verify 之后、归档之后）')
  assert.match(swiftJobCode, /for ARCHIVE in \/tmp\/appcast-in\/\*\.zip \/tmp\/appcast-in\/\*\.delta; do/,
    'S-36：appcast 引用的每个归档（zip 与 delta）都上传到滚动 release')
  assert.match(swiftJobCode, /--download-url-prefix/,
    'S-36：beta appcast 的 enclosure 前缀钉在滚动 tag 下载目录')
  assert.match(swiftJobCode, /gh release download/,
    'S-22/S-23：beta appcast 收最新 final native zip（beta 客户端能看到 final）')
  assert.match(swiftJobCode, /--sparkle-feed "\$SPARKLE_FEED"/, '构建必须注入所选通道的 feed')
  assert.match(swiftJobCode, /generate_appcast/, 'appcast 必须由 Sparkle 的 generate_appcast 生成')
  assert.match(swiftJobCode, /SPARKLE_PRIVATE_KEY/, 'appcast 必须用 EdDSA 私钥签名')
  assert.match(swiftJobCode, /dry_run != 'true'/, '签名/上传 appcast 只在正式发布腿执行')
})

test('S-36 enclosure 前缀单源：beta 走滚动 tag 下载目录，stable 不传前缀', () => {
  assert.equal(
    nativeBetaRollingDownloadPrefix('panzeyu2013/dsh-chamber'),
    'https://github.com/panzeyu2013/dsh-chamber/releases/download/appcast-swift-beta/',
    '前缀必须指向滚动 tag 的下载目录且以斜杠结尾')
  assert.ok(nativeBetaRollingDownloadPrefix('o/r').endsWith('/'),
    'URL(filename, relativeTo: prefix) 缺尾部斜杠会替换掉 tag 段')
  assert.equal(nativeAppcastDownloadPrefix('0.3.0-beta.2', 'o/r'), nativeBetaRollingDownloadPrefix('o/r'))
  assert.equal(nativeAppcastDownloadPrefix('0.3.0', 'o/r'), null,
    'stable 不传前缀：enclosure 相对 releases/latest 解析，形状不变')
  assert.equal(NATIVE_STABLE_ZIP_PATTERN, 'dsh-chamber-*-macos-arm64.zip')
  // enclosure 解析与 Sparkle 的 URL(filename, relativeTo:) 同语义。
  const betaZip = nativeMacArtifacts('0.3.0-beta.2')[1]
  const betaFeed = nativeMacFeedUrl('0.3.0-beta.2', 'o/r')
  const target = `https://github.com/o/r/releases/download/${NATIVE_BETA_ROLLING_TAG}/${betaZip}`
  assert.equal(nativeEnclosureUrl(betaZip, betaFeed, nativeBetaRollingDownloadPrefix('o/r')), target)
  assert.equal(nativeEnclosureUrl(betaZip, betaFeed), target,
    '不带前缀时按 zip 内嵌 SUFeedURL 相对解析，同样落在滚动 tag——zip 因此必须上传到那里')
  const stableZip = nativeMacArtifacts('0.3.0')[1]
  assert.equal(
    nativeEnclosureUrl(stableZip, nativeMacFeedUrl('0.3.0', 'o/r')),
    `https://github.com/o/r/releases/latest/download/${stableZip}`)
})

test('CLI 输出 JSON 清单（stable/beta 通道 feed 各自正确）', () => {
  const out = execFileSync(process.execPath, [script, '0.4.0'], { encoding: 'utf8' })
  const manifest = JSON.parse(out)
  assert.equal(manifest.version, '0.4.0')
  assert.deepEqual(manifest.electron.artifacts, electronMacArtifacts('0.4.0'))
  assert.deepEqual(manifest.native.artifacts, nativeMacArtifacts('0.4.0'))
  assert.equal(manifest.native.feed, 'appcast-swift.xml')

  const beta = JSON.parse(execFileSync(process.execPath, [script, '0.4.0-beta.3'], { encoding: 'utf8' }))
  assert.equal(beta.version, '0.4.0-beta.3')
  assert.deepEqual(beta.native.artifacts, nativeMacArtifacts('0.4.0-beta.3'))
  assert.equal(beta.native.feed, 'appcast-swift-beta.xml')
  assert.equal(beta.electron.feed, 'beta-mac.yml')
})

test('--check-dir：清单成为真实消费者的断言，缺一即红（W-26 上传前门禁）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-release-artifacts-'))
  try {
    const version = '0.4.0'
    const native = nativeMacArtifacts(version)
    for (const name of native) writeFileSync(join(dir, name), 'x')
    const ok = execFileSync(process.execPath, [script, version, '--check-dir', dir], { encoding: 'utf8' })
    assert.deepEqual(JSON.parse(ok).native.artifacts, native)

    // 缺一个上传物 → 非零退出（发布腿不得上传与清单不符的名字）。
    rmSync(join(dir, native[1]))
    const bad = spawnSync(process.execPath, [script, version, '--check-dir', dir], { encoding: 'utf8' })
    assert.notEqual(bad.status, 0, bad.stdout + bad.stderr)
    assert.match(bad.stderr, /native 产物在 .* 缺失/)
    assert.match(bad.stderr, new RegExp(native[1].replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))

    // 纯函数面：缺失清单只含真正缺失的名字。
    assert.deepEqual(missingArtifacts(native, dir), [native[1]])
    assert.deepEqual(missingArtifacts(native, dir, () => true), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------- 2026-12 A2 appcast 本版本门禁
// generate_appcast 的**真实输出形状**（0.3.2-beta.1 线上 appcast 逐字段）：item +
// <sparkle:version>（CFBundleVersion）+ <sparkle:shortVersionString> + <enclosure url=... edSignature=...>。
function appcastItem({ version, bundleVersion, zip, prefix = 'https://github.com/o/r/releases/latest/download' }) {
  return [
    '        <item>',
    `            <title>${version}</title>`,
    '            <pubDate>Thu, 17 Sep 2026 02:17:15 +0000</pubDate>',
    `            <sparkle:version>${bundleVersion}</sparkle:version>`,
    `            <sparkle:shortVersionString>${version}</sparkle:shortVersionString>`,
    '            <sparkle:minimumSystemVersion>14.4</sparkle:minimumSystemVersion>',
    '            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>',
    `            <enclosure url="${prefix}/${zip}" length="83274334" type="application/octet-stream" sparkle:edSignature="sig"/>`,
    '        </item>',
  ].join('\n')
}
function appcastXml(...items) {
  return [
    '<?xml version="1.0" standalone="yes"?>',
    '<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">',
    '    <channel>',
    '        <title>dsh-chamber</title>',
    ...items,
    '    </channel>',
    '</rss>',
  ].join('\n')
}

test('appcast 本版本断言：命中本版本 item 的 sparkle:version + enclosure（A2）', () => {
  const version = '0.4.0'
  const zip = nativeMacArtifacts(version)[1]
  const xml = appcastXml(appcastItem({ version, bundleVersion: bundleVersionFor(version), zip }))
  const advertised = assertAppcastAdvertises(xml, { version, sparkleVersion: bundleVersionFor(version) })
  assert.equal(advertised.sparkleVersion, '0.4.0.999999999')
  assert.ok(advertised.enclosure.endsWith(`/${zip}`))

  // beta appcast 同时收「最新 final + 当前 beta」：断言当前 beta 那一条。
  const betaVersion = '0.4.0-beta.3'
  const betaZip = nativeMacArtifacts(betaVersion)[1]
  const betaXml = appcastXml(
    appcastItem({ version, bundleVersion: bundleVersionFor(version), zip }),
    appcastItem({ version: betaVersion, bundleVersion: bundleVersionFor(betaVersion), zip: betaZip }),
  )
  assert.equal(
    assertAppcastAdvertises(betaXml, { version: betaVersion, sparkleVersion: bundleVersionFor(betaVersion) }).sparkleVersion,
    '0.4.0.3',
  )

  // 解析辅助：item/字段/enclosure 拆分与属性形兼容。
  assert.equal(appcastItems(betaXml).length, 2)
  assert.equal(appcastSparkleField(appcastItems(betaXml)[1], 'version'), '0.4.0.3')
  assert.equal(appcastEnclosureUrls(appcastItems(betaXml)[1])[0], `https://github.com/o/r/releases/latest/download/${betaZip}`)
  const attributeForm = '<item><enclosure url="https://o/r/x.zip" sparkle:version="1.2.3"/></item>'
  assert.equal(appcastSparkleField(appcastItems(attributeForm)[0], 'version'), '1.2.3')
})

test('appcast 本版本断言 fail-closed 的每种形态（A2）', () => {
  const version = '0.4.0'
  const zip = nativeMacArtifacts(version)[1]
  const bundle = bundleVersionFor(version)
  const good = appcastItem({ version, bundleVersion: bundle, zip })
  for (const [name, xml] of [
    ['空 appcast', ''],
    ['没有 item', appcastXml()],
    ['没有本版本条目（beta 只宣传别人）', appcastXml(appcastItem({ version: '0.3.9', bundleVersion: '0.3.9.999999999', zip: 'old.zip' }))],
    ['sparkle:version 不是 CFBundleVersion（旧映射）', appcastXml(appcastItem({ version, bundleVersion: version, zip }))],
    ['enclosure 指向别的归档', appcastXml(appcastItem({ version, bundleVersion: bundle, zip: 'other.zip' }))],
    ['shortVersionString 缺失', appcastXml(good.replace(`<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`, ''))],
  ]) {
    assert.throws(() => assertAppcastAdvertises(xml, { version, sparkleVersion: bundle }), /appcast/, name)
  }
})

test('verify-native-appcast CLI：本版本命中即 0，缺 / 错即非零（A2 发布腿门禁）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-appcast-'))
  try {
    const version = '0.4.0-beta.3'
    const zip = nativeMacArtifacts(version)[1]
    const file = join(dir, 'appcast-swift-beta.xml')
    writeFileSync(file, appcastXml(
      appcastItem({ version, bundleVersion: bundleVersionFor(version), zip, prefix: `https://github.com/o/r/releases/download/${NATIVE_BETA_ROLLING_TAG}` }),
    ))
    assert.equal(verifyNativeAppcast(version, file).sparkleVersion, '0.4.0.3')
    const ok = execFileSync(process.execPath, [appcastScript, version, file], { encoding: 'utf8' })
    assert.match(ok, /appcast 本版本门禁通过：0\.4\.0-beta\.3（sparkle:version 0\.4\.0\.3）/)
    // 版本不匹配：脚本非零退出（发布腿 fail-closed）。
    const wrong = spawnSync(process.execPath, [appcastScript, '0.4.0', file], { encoding: 'utf8' })
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.stderr, /appcast 本版本门禁失败/)
    // 文件缺失/参数错误同样非零。
    assert.equal(spawnSync(process.execPath, [appcastScript, version, join(dir, 'missing.xml')]).status, 1)
    const usage = spawnSync(process.execPath, [appcastScript, version], { encoding: 'utf8' })
    assert.equal(usage.status, 1)
    assert.equal(usage.stderr.trim(), APPCAST_USAGE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
