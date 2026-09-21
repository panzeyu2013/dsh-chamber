/**
 * release-artifacts.test.mjs —— 双端同 tag 产物清单断言（W-27）：两族产物名不碰撞、feed
 * 归属唯一（Electron 腿 yml feed vs Swift 腿 Sparkle appcast，S-22 双通道）、命名规则可预测
 * （stable/beta 通道），并与 release.yml 的 --artifact-basename 命名参数一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
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
  normalizeEnclosureUrl,
} from './release-artifacts.mjs'
import { APPCAST_USAGE, parseVerifyAppcastArgs, verifyNativeAppcast } from './verify-native-appcast.mjs'
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
  // releaseManifest 的同一组字段由本文件 CLI 用例（--check-dir/JSON 清单）与
  // release-workflow-policy.test.mjs 的 feed 名钉住；此处不再重复 in-process 断言。
})

test('release.yml 的 Swift 命名参数与本清单一致（其余 workflow 行由 release-workflow-policy 权威钉住）', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
  const native = nativeMacArtifacts('1.2.3')
  assert.match(workflow, /--artifact-basename "dsh-chamber-\$\{VERSION\}-macos-arm64"/)
  for (const name of native) {
    assert.ok(name.startsWith('dsh-chamber-1.2.3-macos-arm64'), name)
  }
  // 本清单独有：Swift 腿不得出现 Squirrel feed；final 条目从已发布 stable feed 复制。
  const swiftJob = workflow.slice(
    workflow.indexOf('\n  build-swift:'),
    workflow.indexOf('\n  finalize-release:'),
  )
  assert.doesNotMatch(swiftJob, /latest-mac\.yml|beta-mac\.yml/, 'Squirrel feed 不得出现在 Swift 腿')
  const swiftJobCode = swiftJob.split('\n').filter((line) => !/^[ \t]*#/.test(line)).join('\n')
  assert.ok(swiftJobCode.includes("--pattern 'appcast-swift.xml' --dir /tmp/stable-feed --clobber"),
    'S-23：final 条目从已发布 stable feed 复制（不再下载 stable zip）')
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
  // 属性形 <item …> 必须同样被 verify 看见——merge 与 verify 共用同一个 item 模式，
  // 否则「merge 放行的 feed，门禁瞎眼」会变成静默跳过（merge-native-feed.test.mjs 有对侧 pin）。
  assert.equal(appcastItems('<item xml:lang="en"><sparkle:shortVersionString>1.2.3</sparkle:shortVersionString></item>').length, 1)
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
    ['主 enclosure 无 sparkle:edSignature（公钥/私钥不匹配的真实形态）',
      appcastXml(good.replace(/ sparkle:edSignature="[^"]*"/, ''))],
  ]) {
    assert.throws(() => assertAppcastAdvertises(xml, { version, sparkleVersion: bundle }), /appcast/, name)
  }
})

// ------------------------------------------------- 2026-09 增量更新门禁（delta + feed 形状）
// generate_appcast 为每个旧归档产出 <sparkle:deltas> 条目（deltaFrom = 旧 sparkle:version）。
// 发布侧把「staged 过旧归档」与「产出 delta」绑成 fail-closed：没有 delta = 增量链静默退化。
function appcastItemWithDelta({ version, bundleVersion, zip, deltaFrom, prefix = 'https://github.com/o/r/releases/latest/download' }) {
  const delta = [
    '            <sparkle:deltas>',
    `                <enclosure url="${prefix}/dsh-chamber${bundleVersion}-${deltaFrom}.delta" sparkle:deltaFrom="${deltaFrom}" length="955082" type="application/octet-stream" sparkle:edSignature="deltasig"/>`,
    '            </sparkle:deltas>',
  ].join('\n')
  return appcastItem({ version, bundleVersion, zip, prefix }).replace('        </item>', `${delta}\n        </item>`)
}

test('2026-09 增量门禁：deltaFrom 必须存在，单条目/final 形状 fail-closed', () => {
  const version = '0.3.3'
  const zip = nativeMacArtifacts(version)[1]
  const bundle = bundleVersionFor(version)
  const withDelta = appcastXml(appcastItemWithDelta({ version, bundleVersion: bundle, zip, deltaFrom: '0.3.2.999999999' }))
  const advertised = assertAppcastAdvertises(withDelta, {
    version, sparkleVersion: bundle, expectDeltaFrom: '0.3.2.999999999',
  })
  assert.equal(advertised.itemCount, 1)
  assert.deepEqual(advertised.deltas.map((entry) => entry.deltaFrom), ['0.3.2.999999999'])

  // 没有 delta / deltaFrom 不匹配 = FAIL（staged 过旧归档却没产出 delta 必须响）。
  const noDelta = appcastXml(appcastItem({ version, bundleVersion: bundle, zip }))
  assert.throws(() => assertAppcastAdvertises(noDelta, {
    version, sparkleVersion: bundle, expectDeltaFrom: '0.3.2.999999999',
  }), /没有 deltaFrom=0\.3\.2\.999999999/)
  assert.throws(() => assertAppcastAdvertises(withDelta, {
    version, sparkleVersion: bundle, expectDeltaFrom: '0.3.1.999999999',
  }), /没有 deltaFrom=/)
  // 未签名的 delta 也必须 FAIL（客户端会拒绝它；Sparkle 自己会把签不上的 delta 摘掉，
  // 能出现在 feed 里就说明签名链坏了）。
  const unsignedDelta = withDelta.replace('sparkle:edSignature="deltasig"', '')
  assert.ok(!unsignedDelta.includes('deltasig'))
  assert.throws(() => assertAppcastAdvertises(unsignedDelta, {
    version, sparkleVersion: bundle, expectDeltaFrom: '0.3.2.999999999',
  }), /未签名的 delta/)

  // stable 单条目形状：历史条目会引用 releases/latest 上不存在的旧 zip。
  const two = appcastXml(
    appcastItem({ version, bundleVersion: bundle, zip }),
    appcastItem({ version: '0.3.2', bundleVersion: bundleVersionFor('0.3.2'), zip: nativeMacArtifacts('0.3.2')[1] }),
  )
  assert.throws(() => assertAppcastAdvertises(two, { version, sparkleVersion: bundle, singleItem: true }),
    /stable feed 必须恰好保留 1 个 <item>/)

  // S-23：beta 渠道的滚动 feed 必须带 final 条目（beta 客户端据此升级到正式版）。
  const betaVersion = '0.3.3-beta.1'
  const betaZip = nativeMacArtifacts(betaVersion)[1]
  const betaOnly = appcastXml(appcastItem({ version: betaVersion, bundleVersion: bundleVersionFor(betaVersion), zip: betaZip }))
  assert.throws(() => assertAppcastAdvertises(betaOnly, {
    version: betaVersion, sparkleVersion: bundleVersionFor(betaVersion), requireFinalItem: true,
  }), /缺少 final 条目/)
  const merged = appcastXml(
    appcastItem({ version, bundleVersion: bundle, zip }),
    appcastItem({ version: betaVersion, bundleVersion: bundleVersionFor(betaVersion), zip: betaZip }),
  )
  assert.equal(assertAppcastAdvertises(merged, {
    version: betaVersion, sparkleVersion: bundleVersionFor(betaVersion), requireFinalItem: true,
  }).itemCount, 2)

  // 只有 sparkle:version、没有 shortVersionString 的畸形条目不得冒充 final（否则
  // requireFinalItem 会被骗过，merge 也会把它当 final 复制进滚动 feed）。
  const versionOnlyFinal = appcastXml(
    appcastItem({ version, bundleVersion: bundle, zip })
      .replace(`<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`, ''),
    appcastItem({ version: betaVersion, bundleVersion: bundleVersionFor(betaVersion), zip: betaZip }),
  )
  assert.ok(!versionOnlyFinal.includes(`<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`))
  assert.throws(() => assertAppcastAdvertises(versionOnlyFinal, {
    version: betaVersion, sparkleVersion: bundleVersionFor(betaVersion), requireFinalItem: true,
  }), /缺少 final 条目/)

  // 多个 <sparkle:deltas> 块必须全部读取（只读第一块会静默丢 delta，让 gate 变成假阴性）。
  const twoDeltaBlocks = appcastItemWithDelta({ version: '0.3.3', bundleVersion: bundleVersionFor('0.3.3'), zip: nativeMacArtifacts('0.3.3')[1], deltaFrom: '0.3.2.999999999' })
  const extra = [
    '            <sparkle:deltas>',
    `                <enclosure url="https://github.com/o/r/releases/latest/download/dsh-chamber${bundleVersionFor('0.3.3')}-0.3.1.999999999.delta" sparkle:deltaFrom="0.3.1.999999999" length="1" type="application/octet-stream" sparkle:edSignature="d2"/>`,
    '            </sparkle:deltas>',
  ].join('\n')
  const multiBlocks = appcastXml(twoDeltaBlocks.replace(/\n            <\/sparkle:deltas>\n/, `\n            </sparkle:deltas>\n${extra}\n`))
  assert.deepEqual(
    assertAppcastAdvertises(multiBlocks, {
      version: '0.3.3', sparkleVersion: bundleVersionFor('0.3.3'), expectDeltaFrom: '0.3.1.999999999',
    }).deltas.map((entry) => entry.deltaFrom).sort(),
    ['0.3.1.999999999', '0.3.2.999999999'],
  )
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
    assert.match(ok, /appcast 本版本门禁通过：0\.4\.0-beta\.3（sparkle:version 0\.4\.0\.3/)
    // 版本不匹配：脚本非零退出（发布腿 fail-closed）。
    const wrong = spawnSync(process.execPath, [appcastScript, '0.4.0', file], { encoding: 'utf8' })
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.stderr, /appcast 本版本门禁失败/)
    // 文件缺失/参数错误同样非零。
    assert.equal(spawnSync(process.execPath, [appcastScript, version, join(dir, 'missing.xml')]).status, 1)
    const usage = spawnSync(process.execPath, [appcastScript, version], { encoding: 'utf8' })
    assert.equal(usage.status, 2, 'scripts/README 门禁三纪律：用法错误 = 2')
    assert.equal(usage.stderr.trim(), APPCAST_USAGE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('2026-09 复核：签名作用域、不同基线计数、自指 delta、URL 规范化、CDATA/空白短版本', () => {
  const version = '0.3.3'
  const zip = nativeMacArtifacts(version)[1]
  const bundle = bundleVersionFor(version)
  const base = appcastItemWithDelta({ version, bundleVersion: bundle, zip, deltaFrom: '0.3.2.999999999' })

  // 主 enclosure 无签名、delta 有签名 → 必须 FAIL（不能只靠「item 里某处有签名」）
  const unsignedMain = appcastXml(base.replace(' sparkle:edSignature="sig"', ''))
  assert.throws(() => assertAppcastAdvertises(unsignedMain, { version, sparkleVersion: bundle }),
    /主 enclosure 没有 sparkle:edSignature/)

  // 空签名值同样必须 FAIL（正则必须是 [^"]+ 而不是 [^"]*）
  const emptySig = appcastXml(base.replace('sparkle:edSignature="sig"', 'sparkle:edSignature=""'))
  assert.throws(() => assertAppcastAdvertises(emptySig, { version, sparkleVersion: bundle }),
    /主 enclosure 没有 sparkle:edSignature/)

  // 第二个 delta 未签名 → 必须 FAIL（只查第一个 delta 不够）
  const unsignedSecond = '                <enclosure url="https://github.com/o/r/releases/latest/download/dsh-chamber'
    + bundle + '-0.3.1.999999999.delta" sparkle:deltaFrom="0.3.1.999999999" length="1" type="application/octet-stream"/>'
  const twoDeltas = appcastXml(base.replace('            </sparkle:deltas>',
    unsignedSecond + '\n            </sparkle:deltas>'))
  assert.throws(() => assertAppcastAdvertises(twoDeltas, { version, sparkleVersion: bundle }),
    /未签名的 delta/)

  // 两条 deltaFrom 相同 → 只算一个基线（计数门禁不许被重复项骗过）
  const signedSecond = unsignedSecond
    .replaceAll('0.3.1.999999999', '0.3.2.999999999')
    .replace('/>', ' sparkle:edSignature="d2"/>')
  const duplicateBaseline = appcastXml(base.replace('            </sparkle:deltas>',
    signedSecond + '\n            </sparkle:deltas>'))
  assert.throws(() => assertAppcastAdvertises(duplicateBaseline, {
    version, sparkleVersion: bundle, expectDeltaCount: 2,
  }), /只有 1 个不同基线的 delta/)

  // 自指 delta（deltaFrom = 自身 sparkle:version）必须 FAIL
  const selfRef = appcastXml(base.replaceAll('0.3.2.999999999', bundle))
  assert.throws(() => assertAppcastAdvertises(selfRef, { version, sparkleVersion: bundle }),
    /deltaFrom 等于自身/)

  // enclosure URL 带 query/fragment/实体也必须被认作本版本条目（否则门禁与 merge 对 URL 形状各说各话）
  const queryUrl = appcastXml(base.replace(zip + '"', zip + '?token=1&amp;x=2#'))
  assert.equal(assertAppcastAdvertises(queryUrl, { version, sparkleVersion: bundle }).version, version)
  assert.equal(normalizeEnclosureUrl('https://x/a.zip?t=1#f'), 'https://x/a.zip')

  // 空白 shortVersionString 既非 final 也匹配不上本版本；CDATA 包裹的要被识别
  const blankShort = appcastXml(base.replace(
    `<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`,
    '<sparkle:shortVersionString>   </sparkle:shortVersionString>'))
  assert.throws(() => assertAppcastAdvertises(blankShort, { version, sparkleVersion: bundle }), /不含本版本/)
  const cdata = appcastXml(base.replace(
    `<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`,
    `<sparkle:shortVersionString><![CDATA[${version}]]></sparkle:shortVersionString>`))
  assert.equal(assertAppcastAdvertises(cdata, { version, sparkleVersion: bundle }).sparkleVersion, bundle)

  // final 条目没有带签名的 enclosure 时 requireFinalItem 必须 FAIL
  const unsignedFinal = appcastXml(
    appcastItem({ version: '0.3.2', bundleVersion: bundleVersionFor('0.3.2'), zip: nativeMacArtifacts('0.3.2')[1] })
      .replace(' sparkle:edSignature="sig"', ''),
    appcastItem({ version, bundleVersion: bundle, zip }),
  )
  assert.throws(() => assertAppcastAdvertises(unsignedFinal, {
    version, sparkleVersion: bundle, requireFinalItem: true,
  }), /final 条目没有任何带 sparkle:edSignature/)
})

test('verify-native-appcast CLI/选项：--single-item 与 --expect-final-item 真的生效（不是死 flag）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-flags-'))
  try {
    const version = '0.4.0'
    const betaVersion = '0.4.0-beta.1'
    const zip = nativeMacArtifacts(version)[1]
    const bundle = bundleVersionFor(version)
    const betaZip = nativeMacArtifacts(betaVersion)[1]
    const two = join(dir, 'two.xml')
    writeFileSync(two, appcastXml(
      appcastItem({ version, bundleVersion: bundle, zip }),
      appcastItem({ version: '0.3.9', bundleVersion: '0.3.9.999999999', zip: nativeMacArtifacts('0.3.9')[1] }),
    ))
    assert.equal(verifyNativeAppcast(version, two).itemCount, 2, '不传 flag 时两条件目本身合法')
    assert.throws(() => verifyNativeAppcast(version, two, { singleItem: true }), /恰好保留 1 个 <item>/)
    const single = spawnSync(process.execPath, [appcastScript, version, two, '--single-item'], { encoding: 'utf8' })
    assert.equal(single.status, 1, '--single-item 必须真的传进门禁')
    assert.match(single.stderr, /恰好保留 1 个 <item>/)

    const betaOnly = join(dir, 'beta-only.xml')
    writeFileSync(betaOnly, appcastXml(
      appcastItem({ version: betaVersion, bundleVersion: bundleVersionFor(betaVersion), zip: betaZip }),
    ))
    assert.equal(verifyNativeAppcast(betaVersion, betaOnly).itemCount, 1)
    assert.throws(() => verifyNativeAppcast(betaVersion, betaOnly, { requireFinalItem: true }), /缺少 final 条目/)
    const finalFlag = spawnSync(process.execPath, [appcastScript, betaVersion, betaOnly, '--expect-final-item'], { encoding: 'utf8' })
    assert.equal(finalFlag.status, 1, '--expect-final-item 必须真的传进门禁')
    assert.match(finalFlag.stderr, /缺少 final 条目/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verify-native-appcast：EdDSA 签名必须真的验得过（存在 ≠ 有效）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-sig-'))
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    const otherRaw = generateKeyPairSync('ed25519').publicKey
      .export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    const version = '0.4.0'
    const bundle = bundleVersionFor(version)
    const zip = nativeMacArtifacts(version)[1]
    const archive = join(dir, zip)
    writeFileSync(archive, Buffer.from('fake archive bytes for signature test'))
    const mainSig = cryptoSign(null, readFileSync(archive), privateKey).toString('base64')
    const item = appcastItem({ version, bundleVersion: bundle, zip })
      .replace('sparkle:edSignature="sig"', `sparkle:edSignature="${mainSig}"`)
    const file = join(dir, 'appcast-swift.xml')
    writeFileSync(file, appcastXml(item))
    assert.equal(verifyNativeAppcast(version, file, { signaturesDir: dir, publicKey: rawPublic }).version, version)
    assert.throws(() => verifyNativeAppcast(version, file, { signaturesDir: dir, publicKey: otherRaw }),
      /EdDSA 签名验不过/, '换一把公钥必须拒绝')
    writeFileSync(archive, Buffer.from('fake archive bytes for signature test!'))
    assert.throws(() => verifyNativeAppcast(version, file, { signaturesDir: dir, publicKey: rawPublic }),
      /EdDSA 签名验不过/, '归档字节被改动必须拒绝')
    writeFileSync(archive, Buffer.from('fake archive bytes for signature test'))
    rmSync(archive)
    assert.throws(() => verifyNativeAppcast(version, file, { signaturesDir: dir, publicKey: rawPublic }),
      /文件不在/, '没有真实归档字节就无法验签，必须拒绝')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verify-native-appcast：delta 的签名同样要验过（密钥轮换形态必须拒）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-sig-delta-'))
  try {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const rawPublic = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64')
    const version = '0.4.0'
    const bundle = bundleVersionFor(version)
    const zip = nativeMacArtifacts(version)[1]
    const archive = join(dir, zip)
    writeFileSync(archive, Buffer.from('archive'))
    const mainSig = cryptoSign(null, readFileSync(archive), privateKey).toString('base64')
    const deltaName = `dsh-chamber${bundle}-0.3.2.999999999.delta`
    const deltaFile = join(dir, deltaName)
    writeFileSync(deltaFile, Buffer.from('delta bytes'))
    const deltaSig = cryptoSign(null, readFileSync(deltaFile), privateKey).toString('base64')
    const item = appcastItemWithDelta({ version, bundleVersion: bundle, zip, deltaFrom: '0.3.2.999999999' })
      .replace('sparkle:edSignature="sig"', `sparkle:edSignature="${mainSig}"`)
      .replace('sparkle:edSignature="deltasig"', `sparkle:edSignature="${deltaSig}"`)
    const file = join(dir, 'appcast-swift-beta.xml')
    writeFileSync(file, appcastXml(item))
    assert.equal(verifyNativeAppcast(version, file, { signaturesDir: dir, publicKey: rawPublic }).deltas.length, 1)
    // 轮换形态：delta 文件真实存在，但签名不是当前公钥签的 → 必须 FAIL
    writeFileSync(deltaFile, Buffer.from('delta bytes changed'))
    assert.throws(() => verifyNativeAppcast(version, file, { signaturesDir: dir, publicKey: rawPublic }),
      /delta\(deltaFrom=0\.3\.2\.999999999\) 的 EdDSA 签名验不过/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verify-native-appcast：--expect-delta-from 的「营销版本 → sparkle:version」折算被直接覆盖', () => {
  // 发布腿唯一的新 glue：release.yml 传的是上一版本的营销版本号（0.4.0-beta.2），
  // bundleVersionFor 折算成 appcast 里的 sparkle:deltaFrom（0.4.0.2）。
  assert.deepEqual(
    parseVerifyAppcastArgs(['0.4.0-beta.3', 'a.xml', '--single-item', '--expect-final-item', '--expect-delta-from', '0.4.0-beta.2']),
    {
      version: '0.4.0-beta.3',
      appcastPath: 'a.xml',
      singleItem: true,
      requireFinalItem: true,
      expectDeltaFromVersion: '0.4.0-beta.2',
      expectDeltaCount: null,
      signaturesDir: null,
      publicKey: null,
    },
  )
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--signatures-dir', '/tmp/x']), null,
    '验签参数必须成对（只给一个会让人误以为验过了）')
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--public-key', 'AAAA']), null)
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--expect-delta-from']), null, '缺值即非法')
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--expect-delta-from', '--single-item']), null, '开关不能当值')
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--expect-delta-count', '2']).expectDeltaCount, 2)
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--expect-delta-count', '0']), null, '0 个 delta 的要求无意义')
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--expect-delta-count', 'two']), null)
  assert.equal(parseVerifyAppcastArgs(['0.4.0', 'a.xml', '--expect-delta-count']), null, '缺值即非法')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-native-delta-'))
  try {
    const version = '0.4.0-beta.3'
    const previous = '0.4.0-beta.2'
    const file = join(dir, 'appcast-swift-beta.xml')
    writeFileSync(file, appcastXml(appcastItemWithDelta({
      version,
      bundleVersion: bundleVersionFor(version),
      zip: nativeMacArtifacts(version)[1],
      deltaFrom: bundleVersionFor(previous),
    })))
    // 函数面：选项收营销版本号，自己折算；折算没发生（拿 raw 当营销版本）必须 fail-closed。
    assert.deepEqual(
      verifyNativeAppcast(version, file, { expectDeltaFromVersion: previous })
        .deltas.map((entry) => entry.deltaFrom),
      [bundleVersionFor(previous)],
    )
    assert.throws(() => verifyNativeAppcast(version, file, { expectDeltaFromVersion: '0.4.0-beta.9' }),
      /没有 deltaFrom=0\.4\.0\.9/, '传别的营销版本必须失败（折算链必须真的发生）')
    // CLI 面：--expect-delta-from 走同一条 glue（发布腿实际调用形态）。
    const cli = execFileSync(process.execPath,
      [appcastScript, version, file, '--expect-delta-from', previous], { encoding: 'utf8' })
    assert.match(cli, /deltaFrom=0\.4\.0\.2/)
    // 只有 1 个 delta 时要求 ≥2 必须 FAIL（更旧的 baseline 静默失去覆盖要响）。
    assert.throws(() => verifyNativeAppcast(version, file, { expectDeltaCount: 2 }),
      /只有 1 个不同基线的 delta（要求 ≥2）/)
    assert.equal(verifyNativeAppcast(version, file, { expectDeltaCount: 1 }).deltas.length, 1)
    const countCli = spawnSync(process.execPath,
      [appcastScript, version, file, '--expect-delta-count', '2'], { encoding: 'utf8' })
    assert.equal(countCli.status, 1, 'delta 数不足 = 门禁红（不是用法错误 2）')
    assert.match(countCli.stderr, /只有 1 个不同基线的 delta（要求 ≥2）/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
