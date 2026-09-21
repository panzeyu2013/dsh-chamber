/**
 * merge-native-feed.test.mjs —— 滚动 beta feed 跨通道合并（S-23；2026-09 增量更新）单测。
 *
 * 锁的是 merge-native-feed.mjs 的纯函数：beta 条目逐字保留、final 条目唯一且取最新、
 * 前缀改写只作用于 final 条目、缺 stable feed 时回退保留旧 final、重复版本/无 beta 条目 fail-closed。
 * fixtures 用 generate_appcast 的真实输出形状（含 <sparkle:deltas>）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MERGE_USAGE,
  appcastItemBlocks,
  compareSparkleVersions,
  mergeRollingBetaFeed,
  parseMergeArgs,
  rewriteEnclosureUrls,
} from './merge-native-feed.mjs'
import { appcastSparkleField } from './release-artifacts.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'merge-native-feed.mjs')

const ROLLING = 'https://github.com/o/r/releases/download/appcast-swift-beta/'
const STABLE_DIR = 'https://github.com/o/r/releases/latest/download/'

const BETA_FEED = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>dsh-chamber</title>
        <item>
            <title>0.3.3-beta.1</title>
            <pubDate>Mon, 21 Sep 2026 10:00:00 +0000</pubDate>
            <sparkle:version>0.3.3.1</sparkle:version>
            <sparkle:shortVersionString>0.3.3-beta.1</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>14.4</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="${ROLLING}dsh-chamber-0.3.3-beta.1-macos-arm64.zip" length="83300000" type="application/octet-stream" sparkle:edSignature="BETA1=="/>
            <sparkle:deltas>
                <enclosure url="${ROLLING}dsh-chamber0.3.3.1-0.3.2.5.delta" sparkle:deltaFrom="0.3.2.5" length="900000" type="application/octet-stream" sparkle:edSignature="DELTA1=="/>
            </sparkle:deltas>
        </item>
        <item>
            <title>0.3.2-beta.5</title>
            <pubDate>Sun, 20 Sep 2026 17:21:18 +0000</pubDate>
            <sparkle:version>0.3.2.5</sparkle:version>
            <sparkle:shortVersionString>0.3.2-beta.5</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>14.4</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="${ROLLING}dsh-chamber-0.3.2-beta.5-macos-arm64.zip" length="83252840" type="application/octet-stream" sparkle:edSignature="BETA5=="/>
        </item>
    </channel>
</rss>
`

const STABLE_FEED = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>dsh-chamber</title>
        <item>
            <title>0.3.2</title>
            <pubDate>Mon, 21 Sep 2026 12:00:00 +0000</pubDate>
            <sparkle:version>0.3.2.999999999</sparkle:version>
            <sparkle:shortVersionString>0.3.2</sparkle:shortVersionString>
            <sparkle:minimumSystemVersion>14.4</sparkle:minimumSystemVersion>
            <sparkle:hardwareRequirements>arm64</sparkle:hardwareRequirements>
            <enclosure url="${STABLE_DIR}dsh-chamber-0.3.2-macos-arm64.zip" length="83200000" type="application/octet-stream" sparkle:edSignature="FINAL=="/>
            <sparkle:deltas>
                <enclosure url="${STABLE_DIR}dsh-chamber0.3.2.999999999-0.3.1.999999999.delta" sparkle:deltaFrom="0.3.1.999999999" length="700000" type="application/octet-stream" sparkle:edSignature="STABLEDELTA=="/>
            </sparkle:deltas>
        </item>
    </channel>
</rss>
`

const PREVIOUS_ROLLING = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0">
    <channel>
        <title>dsh-chamber</title>
        <item>
            <title>0.3.1</title>
            <sparkle:version>0.3.1.999999999</sparkle:version>
            <sparkle:shortVersionString>0.3.1</sparkle:shortVersionString>
            <enclosure url="${ROLLING}dsh-chamber-0.3.1-macos-arm64.zip" length="83100000" type="application/octet-stream" sparkle:edSignature="OLD=="/>
        </item>
        <item>
            <title>0.3.2-beta.5</title>
            <sparkle:version>0.3.2.5</sparkle:version>
            <sparkle:shortVersionString>0.3.2-beta.5</sparkle:shortVersionString>
            <enclosure url="${ROLLING}dsh-chamber-0.3.2-beta.5-macos-arm64.zip" length="83252840" type="application/octet-stream" sparkle:edSignature="BETA5=="/>
        </item>
    </channel>
</rss>
`

test('compareSparkleVersions 按数值段比较 CFBundleVersion 映射', () => {
  assert.equal(compareSparkleVersions('0.3.2.999999999', '0.3.2.5'), 1)
  assert.equal(compareSparkleVersions('0.3.10.1', '0.3.9.9'), 1)
  assert.equal(compareSparkleVersions('0.3.2.5', '0.3.2.5'), 0)
  assert.equal(compareSparkleVersions('0.4.0.0', '0.3.9.999999999'), 1)
})

test('合并保留 beta 条目、替换为唯一最新 final，且按版本降序', () => {
  const merged = mergeRollingBetaFeed({ betaFeedXml: BETA_FEED, stableFeedXml: STABLE_FEED })
  const items = appcastItemBlocks(merged.xml)
  assert.equal(items.length, 3, '2 个 beta 条目 + 1 个 final 条目')
  assert.equal(merged.betaItemCount, 2)
  assert.deepEqual(merged.finalItem, { version: '0.3.2.999999999', shortVersionString: '0.3.2' })
  const versions = items.map((item) => /<sparkle:version>([^<]*)</.exec(item)[1])
  assert.deepEqual(versions, ['0.3.3.1', '0.3.2.999999999', '0.3.2.5'])
  assert.ok(merged.xml.includes('<title>dsh-chamber</title>'), 'channel 头（title 等）必须逐字保留')
  assert.ok(merged.xml.includes('sparkle:edSignature="FINAL=="'), 'final 条目逐字保留（含签名）')
  assert.ok(merged.xml.includes('sparkle:edSignature="DELTA1=="'), 'beta 条目的 delta 逐字保留')
})

test('--download-url-prefix 只改写 final 条目（beta 条目 URL 不动）', () => {
  const merged = mergeRollingBetaFeed({
    betaFeedXml: BETA_FEED,
    stableFeedXml: STABLE_FEED,
    downloadUrlPrefix: ROLLING,
  })
  assert.ok(merged.xml.includes(`url="${ROLLING}dsh-chamber-0.3.2-macos-arm64.zip"`), 'final zip 改写到滚动前缀')
  assert.ok(merged.xml.includes(`url="${ROLLING}dsh-chamber0.3.2.999999999-0.3.1.999999999.delta"`), 'final 的 delta 同样改写')
  assert.doesNotMatch(merged.xml, /releases\/latest\/download/, '合并结果里不再残留 stable 直链')
  assert.ok(merged.xml.includes(`url="${ROLLING}dsh-chamber-0.3.3-beta.1-macos-arm64.zip"`), 'beta 条目 URL 保持不变')
})

const PREVIOUS_NEWER = PREVIOUS_ROLLING
  .replaceAll('0.3.1.999999999', '0.4.0.999999999')
  .replaceAll('0.3.1', '0.4.0')

test('两个候选源都在时取版本最高的 final，且只有 stable 来源才改前缀', () => {
  const fromStable = mergeRollingBetaFeed({
    betaFeedXml: BETA_FEED, stableFeedXml: STABLE_FEED, previousFeedXml: PREVIOUS_ROLLING,
    downloadUrlPrefix: ROLLING,
  })
  assert.deepEqual(fromStable.finalItem, { version: '0.3.2.999999999', shortVersionString: '0.3.2' },
    'stable 有可用 final 时不许被 previous 的旧 final 顶掉')
  assert.ok(fromStable.xml.includes(`url="${ROLLING}dsh-chamber-0.3.2-macos-arm64.zip"`))

  const stablePrefix = 'https://github.com/o/r/releases/download/v0.3.2/'
  const fromPrevious = mergeRollingBetaFeed({
    betaFeedXml: BETA_FEED, stableFeedXml: STABLE_FEED, previousFeedXml: PREVIOUS_NEWER,
    downloadUrlPrefix: stablePrefix,
  })
  assert.deepEqual(fromPrevious.finalItem, { version: '0.4.0.999999999', shortVersionString: '0.4.0' },
    'previous 里的 final 更新时必须取更新的那个（老系列 hotfix 不许把可见性倒退）')
  assert.ok(fromPrevious.xml.includes(`url="${ROLLING}dsh-chamber-0.4.0-macos-arm64.zip"`),
    'previous 来源的 final 保留自己的 URL')
  assert.ok(!fromPrevious.xml.includes(stablePrefix),
    'stable tag 的前缀绝不能套到 previous 来源的条目上（会 404）')
})

test('stable 侧多个 final 取版本最大的', () => {
  const twoFinals = STABLE_FEED.replace('    </channel>', [
    '        <item>',
    '            <sparkle:version>0.4.0.999999999</sparkle:version>',
    '            <sparkle:shortVersionString>0.4.0</sparkle:shortVersionString>',
    '            <enclosure url="https://example.invalid/dsh-chamber-0.4.0-macos-arm64.zip" length="1" type="application/octet-stream" sparkle:edSignature="s"/>',
    '        </item>',
    '    </channel>',
  ].join('\n'))
  const merged = mergeRollingBetaFeed({ betaFeedXml: BETA_FEED, stableFeedXml: twoFinals })
  assert.deepEqual(merged.finalItem, { version: '0.4.0.999999999', shortVersionString: '0.4.0' })
})

test('beta feed 里无法分类的条目（缺 shortVersionString）直接失败', () => {
  const noShort = BETA_FEED.replace('<sparkle:shortVersionString>0.3.3-beta.1</sparkle:shortVersionString>', '')
  assert.throws(() => mergeRollingBetaFeed({ betaFeedXml: noShort, stableFeedXml: STABLE_FEED }), /无法分类/)
})

test('候选 final 没有签名 enclosure 时失败（纵深防御）', () => {
  const unsignedStable = STABLE_FEED.replace(' sparkle:edSignature="FINAL=="', '')
  assert.throws(() => mergeRollingBetaFeed({ betaFeedXml: BETA_FEED, stableFeedXml: unsignedStable }),
    /没有任何带 sparkle:edSignature/)
})

test('parseMergeArgs 拒绝把开关当值', () => {
  assert.equal(parseMergeArgs(['--beta', '--stable', '-o', 'x.xml']), null)
  assert.equal(parseMergeArgs(['--download-url-prefix', '-o', 'x.xml', '--beta', 'b.xml']), null)
  assert.equal(parseMergeArgs(['--beta', 'b.xml', '--stable', '--previous', '-o', 'x.xml']), null)
})

test('保留 --previous 里更早的 beta 条目（staging 少收归档时旧 beta 不许消失）', () => {
  const previous = [
    '<?xml version="1.0" standalone="yes"?>',
    '<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>',
    '        <item>',
    '            <sparkle:version>0.3.3.2</sparkle:version>',
    '            <sparkle:shortVersionString>0.3.3-beta.2</sparkle:shortVersionString>',
    '            <enclosure url="${ROLLING}dsh-chamber-0.3.3-beta.2-macos-arm64.zip" length="1" type="application/octet-stream" sparkle:edSignature="s2"/>',
    '        </item>',
    '        <item>',
    '            <sparkle:version>0.3.3.1</sparkle:version>',
    '            <sparkle:shortVersionString>0.3.3-beta.1</sparkle:shortVersionString>',
    '            <enclosure url="${ROLLING}dsh-chamber-0.3.3-beta.1-macos-arm64.zip" length="1" type="application/octet-stream" sparkle:edSignature="s1"/>',
    '        </item>',
    '    </channel></rss>',
  ].join('\n')
  // 新鲜 feed 只含本次发布的 beta.1（模拟 staging 少收历史归档 → 旧条目本会静默消失）
  const fresh = [
    '<?xml version="1.0" standalone="yes"?>',
    '<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" version="2.0"><channel>',
    '        <item>',
    '            <sparkle:version>0.3.4.1</sparkle:version>',
    '            <sparkle:shortVersionString>0.3.4-beta.1</sparkle:shortVersionString>',
    '            <enclosure url="${ROLLING}dsh-chamber-0.3.4-beta.1-macos-arm64.zip" length="1" type="application/octet-stream" sparkle:edSignature="n1"/>',
    '        </item>',
    '    </channel></rss>',
  ].join('\n')
  const merged = mergeRollingBetaFeed({ betaFeedXml: fresh, stableFeedXml: STABLE_FEED, previousFeedXml: previous })
  const versions = (xml) => appcastItemBlocks(xml)
    .map((item) => appcastSparkleField(item, 'shortVersionString'))
  assert.deepEqual(versions(merged.xml), ['0.3.4-beta.1', '0.3.3-beta.2', '0.3.3-beta.1', '0.3.2'],
    '旧 beta 条目必须保留、按版本倒序，final 仍在最后')
  assert.equal(merged.betaItemCount, 3)
  // 限额：只保留最新的 N 条 beta（口径同 --maximum-versions）
  const capped = mergeRollingBetaFeed({
    betaFeedXml: fresh, stableFeedXml: STABLE_FEED, previousFeedXml: previous, betaItemLimit: 2,
  })
  assert.deepEqual(versions(capped.xml), ['0.3.4-beta.1', '0.3.3-beta.2', '0.3.2'],
    'beta 条目按 --beta-item-limit 截断')
  // 去重：同一 sparkle:version 在新鲜 feed 与旧 feed 都出现时只保留新鲜那一条
  const alsoPrevious = previous.replace('0.3.3.2', '0.3.4.1').replace('0.3.3-beta.2', '0.3.4-beta.9')
  const deduped = mergeRollingBetaFeed({ betaFeedXml: fresh, stableFeedXml: STABLE_FEED, previousFeedXml: alsoPrevious })
  assert.deepEqual(versions(deduped.xml), ['0.3.4-beta.1', '0.3.3-beta.1', '0.3.2'])
  // --previous 里无法分类的条目必须拒绝（不能被当成 beta 条目搬进来）
  const broken = previous.replace('<sparkle:shortVersionString>0.3.3-beta.1</sparkle:shortVersionString>', '')
  assert.throws(() => mergeRollingBetaFeed({ betaFeedXml: fresh, stableFeedXml: STABLE_FEED, previousFeedXml: broken }),
    /无法分类/)
  // CLI：--beta-item-limit 只接受正整数
  assert.equal(parseMergeArgs(['--beta', 'b.xml', '--beta-item-limit', '0', '-o', 'x.xml']), null)
  assert.equal(parseMergeArgs(['--beta', 'b.xml', '--beta-item-limit', 'x', '-o', 'x.xml']), null)
  assert.equal(parseMergeArgs(['--beta', 'b.xml', '--beta-item-limit', '3', '-o', 'x.xml']).betaItemLimit, 3)
})

test('缺 stable feed 时保留 --previous 里的旧 final 条目（绝不删可见性）', () => {
  const merged = mergeRollingBetaFeed({ betaFeedXml: BETA_FEED, previousFeedXml: PREVIOUS_ROLLING })
  assert.deepEqual(merged.finalItem, { version: '0.3.1.999999999', shortVersionString: '0.3.1' })
  assert.ok(merged.xml.includes('sparkle:edSignature="OLD=="'))
})

test('既无 stable 也无 previous 时只输出 beta 条目（final 为 null）', () => {
  const merged = mergeRollingBetaFeed({ betaFeedXml: BETA_FEED })
  assert.equal(merged.finalItem, null)
  assert.equal(appcastItemBlocks(merged.xml).length, 2)
})

test('beta feed 自身重复 sparkle:version 直接失败（不靠去重悄悄修好）', () => {
  const item = BETA_FEED.slice(BETA_FEED.indexOf('<item>'), BETA_FEED.indexOf('</item>') + '</item>'.length)
  const duplicated = BETA_FEED.replace('    </channel>', `${item}\n    </channel>`)
  assert.throws(() => mergeRollingBetaFeed({ betaFeedXml: duplicated, stableFeedXml: STABLE_FEED }),
    /beta feed 自身有重复的 sparkle:version/)
})

test('没有 beta 条目的 feed 直接失败（拒绝 final-only 覆盖滚动通道）', () => {
  assert.throws(() => mergeRollingBetaFeed({ betaFeedXml: STABLE_FEED, stableFeedXml: STABLE_FEED }),
    /没有任何 beta 条目/)
  assert.throws(() => mergeRollingBetaFeed({ betaFeedXml: '' }), /为空/)
  assert.throws(() => mergeRollingBetaFeed({ betaFeedXml: '<rss></rss>' }), /缺少 <channel>/)
})

test('rewriteEnclosureUrls 只换文件名部分，并丢掉 query/fragment', () => {
  const rewritten = rewriteEnclosureUrls(
    '<enclosure url="https://example.invalid/a/b/app-1.0.zip" length="1" type="application/octet-stream"/>',
    ROLLING,
  )
  assert.equal(rewritten,
    `<enclosure url="${ROLLING}app-1.0.zip" length="1" type="application/octet-stream"/>`)

  const withQuery = rewriteEnclosureUrls(
    '<enclosure url="https://example.invalid/a/b/app-1.0.zip?token=1#frag" length="1" type="application/octet-stream"/>',
    ROLLING,
  )
  assert.equal(withQuery,
    `<enclosure url="${ROLLING}app-1.0.zip" length="1" type="application/octet-stream"/>`,
    'query/fragment 绝不能跟着文件名拼到新前缀上')

  assert.throws(() => rewriteEnclosureUrls('<enclosure url="x/y.zip"/>', 'https://example.invalid/prefix'),
    /必须以 \/ 结尾/, '缺尾斜杠会静默拼出 …prefixy.zip，必须 fail-closed')
})

test('前缀改写绝不触碰 beta 条目（用非 ROLLING 的 beta URL 排除幂等假阳性）', () => {
  const foreign = 'https://github.com/o/r/releases/download/v0.3.3/'
  const foreignBeta = BETA_FEED.replaceAll(ROLLING, foreign)
  const merged = mergeRollingBetaFeed({
    betaFeedXml: foreignBeta,
    stableFeedXml: STABLE_FEED,
    downloadUrlPrefix: ROLLING,
  })
  assert.ok(merged.xml.includes(`url="${foreign}dsh-chamber-0.3.3-beta.1-macos-arm64.zip"`),
    'beta 条目 URL 必须逐字保留（改写只针对 final 条目）')
  assert.ok(merged.xml.includes(`url="${foreign}dsh-chamber0.3.3.1-0.3.2.5.delta"`),
    'beta 条目的 delta URL 同样不受影响')
  assert.ok(merged.xml.includes(`url="${ROLLING}dsh-chamber-0.3.2-macos-arm64.zip"`), 'final 条目照常改写')
})

test('stable 侧给不出可用 final 时退回 --previous 的 final（可见性绝不删除）', () => {
  const prereleaseOnly = STABLE_FEED
    .replace('<sparkle:version>0.3.2.999999999</sparkle:version>', '<sparkle:version>0.3.2.6</sparkle:version>')
    .replace('<sparkle:shortVersionString>0.3.2</sparkle:shortVersionString>',
      '<sparkle:shortVersionString>0.3.2-beta.6</sparkle:shortVersionString>')
  const merged = mergeRollingBetaFeed({
    betaFeedXml: BETA_FEED, stableFeedXml: prereleaseOnly, previousFeedXml: PREVIOUS_ROLLING,
  })
  assert.deepEqual(merged.finalItem, { version: '0.3.1.999999999', shortVersionString: '0.3.1' })
})

test('shortVersionString 缺失的条目不算 final（不放行 —expect-final-item 假阳）', () => {
  const missingShort = STABLE_FEED.replace(
    '<sparkle:shortVersionString>0.3.2</sparkle:shortVersionString>', '')
  assert.ok(!missingShort.includes('<sparkle:shortVersionString>0.3.2<'),
    '夹具必须真的去掉 shortVersionString')
  const merged = mergeRollingBetaFeed({
    betaFeedXml: BETA_FEED, stableFeedXml: missingShort, previousFeedXml: PREVIOUS_ROLLING,
  })
  assert.deepEqual(merged.finalItem, { version: '0.3.1.999999999', shortVersionString: '0.3.1' },
    '缺 shortVersionString 的条目不能被当成正式版条目')
})

test('channel 头尾与带属性的 <item> 形状都保留（不重建 <channel>/</rss> 尾巴）', () => {
  const withLanguage = BETA_FEED
    .replace('        <item>', '        <item sparkle:foo="bar">')
    .replace('    </channel>', '        <language>zh</language>\n    </channel>')
  const merged = mergeRollingBetaFeed({ betaFeedXml: withLanguage, stableFeedXml: STABLE_FEED })
  assert.ok(merged.xml.includes('<language>zh</language>'), 'item 之后的 channel 级元素必须逐字保留')
  assert.equal(appcastItemBlocks(merged.xml).length, 3, '带属性的 <item …> 也必须被识别')
})

test('CLI：输出机器可读的 final 状态行（release.yml 据此决定是否要求 final 条目）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-merge-feed-'))
  try {
    const beta = join(dir, 'beta.xml')
    const stable = join(dir, 'stable.xml')
    const out = join(dir, 'merged.xml')
    writeFileSync(beta, BETA_FEED)
    writeFileSync(stable, STABLE_FEED)
    const merged = spawnSync(process.execPath, [SCRIPT, '--beta', beta, '--stable', stable, '-o', out], { encoding: 'utf8' })
    assert.equal(merged.status, 0, merged.stderr)
    assert.match(merged.stdout, /merge-native-feed: betaItems=2 finalItem=1 final=0\.3\.2 sparkleVersion=0\.3\.2\.999999999/)
    assert.ok(readFileSync(out, 'utf8').includes('<title>dsh-chamber</title>'), 'channel 头（title）必须保留')

    const noFinal = spawnSync(process.execPath, [SCRIPT, '--beta', beta, '-o', out], { encoding: 'utf8' })
    assert.equal(noFinal.status, 0, noFinal.stderr)
    assert.match(noFinal.stdout, /merge-native-feed: betaItems=2 finalItem=0 final=none sparkleVersion=none/)

    const usage = spawnSync(process.execPath, [SCRIPT, '--beta', beta], { encoding: 'utf8' })
    assert.equal(usage.status, 2, 'scripts/README 门禁三纪律：用法错误 = 2')
    assert.equal(usage.stderr.trim(), MERGE_USAGE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseMergeArgs 校验最小参数与未知开关', () => {
  assert.deepEqual(parseMergeArgs(['--beta', 'b.xml', '-o', 'out.xml']), {
    beta: 'b.xml', stable: null, previous: null, downloadUrlPrefix: null, betaItemLimit: null, out: 'out.xml',
  })
  assert.equal(parseMergeArgs(['--beta', 'b.xml']), null, '缺 -o')
  assert.equal(parseMergeArgs(['-o', 'out.xml']), null, '缺 --beta')
  assert.equal(parseMergeArgs(['--wat', 'x', '--beta', 'b.xml', '-o', 'o.xml']), null)
  assert.equal(parseMergeArgs(['--beta']), null, '缺值')
  assert.match(MERGE_USAGE, /merge-native-feed\.mjs/)
})
