#!/usr/bin/env node
/**
 * merge-native-feed.mjs —— 滚动 beta feed 的跨通道条目合并。
 *
 * 背景（为什么需要它）：Sparkle 的 generate_appcast 按每个归档**内嵌 SUFeedURL 的文件名**
 * 分组，同一收件目录里同时放 stable 与 beta 归档、又传 `-o`（单输出文件）时直接失败
 * `multiple appcasts found`（Sparkle 2.10.0 generate_appcast/Appcast.swift:45-62；本仓
 * 本地实测复现）。所以要为 delta 增加历史归档 staging，stable 与 beta 的收件目录
 * 必须**完全分开**；同时 beta 客户端的滚动 feed 上必须能看到最新正式版
 * （beta 版本遇到对应正式版允许升级到正式版，只有正式版不存在时才按 beta 通道更新）。
 *
 * 做法：beta feed 由 beta 收件目录单独生成（beta 条目 + beta→beta delta），本脚本只把
 * **已发布 stable feed 里的最新 final 条目**复制进 beta feed。条目是 generate_appcast
 * 产出的原样 XML（enclosure 的 EdDSA 签名与条目内容绑定，逐字复制即保持有效）；本仓未开启
 * `SURequireSignedFeed`（feed 级签名），因此合并后**不需要**重签 feed。若未来开启该键，
 * 本脚本必须补 sign_update 重签（见 docs/design/25-macos-swift-native-shell.md §7）。
 *
 * 用法：
 *   node scripts/release/merge-native-feed.mjs --beta <beta feed> [--stable <stable feed>]
 *     [--previous <上次发布的滚动 feed>] [--download-url-prefix <url>]
 *     [--beta-item-limit <n>] -o <out>
 *
 * 规则：
 *   1. `--beta` 里的 beta 条目逐字保留（含各自 <sparkle:deltas>；URL 已指向滚动 tag）；
 *   2. final 条目取 `--stable` 里 sparkle:version 最大者（唯一，替换旧 final，不累积）；
 *      `--stable` 缺失时退回 `--previous` 里已有的 final 条目（绝不因一次取不到 stable feed
 *      就把 beta 客户端的升级可见性删掉）；
 *   3. 给了 `--download-url-prefix` 时，仅改写 **final 条目**里每个 enclosure url 的文件名部分
 *      （stable 的 releases/latest/download/ → 滚动 tag 下载目录），保证正式版还在 draft 期间
 *      前缀就已可下载；beta 条目不动；
 *   4. 条目按 sparkle:version 数值降序；重复 sparkle:version 直接失败；
 *   5. beta 条目为空 → 失败（绝不用只有 final 的 feed 覆盖滚动通道）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { argv, exit } from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  APPCAST_ITEM_PATTERN,
  appcastItemIsFinal,
  appcastMainEnclosureTags,
  appcastItemIsPrerelease,
  appcastSparkleField,
} from './release-artifacts.mjs'

export const MERGE_USAGE = '用法：merge-native-feed.mjs --beta <beta feed> [--stable <stable feed>] '
  + '[--previous <上次发布的滚动 feed>] [--download-url-prefix <url>] [--beta-item-limit <n>] -o <out>'

/**
 * 一条 appcast item 的完整 `<item …>…</item>` 块（逐字保留用）。
 * 与 verify 共用 APPCAST_ITEM_PATTERN——merge 放行的 item 必须同样被 verify 看见。
 */
export function appcastItemBlocks(xml) {
  return [...String(xml).matchAll(APPCAST_ITEM_PATTERN)].map((match) => match[0])
}

/**
 * sparkle:version 是点分十进制（build-swift-app 的 bundleVersionFor：X.Y.Z.999999999 / X.Y.Z.N），
 * 按数值段比较；缺失段按 0。纯函数，单测直测。
 */
export function compareSparkleVersions(left, right) {
  const parse = (value) => String(value ?? '').split('.').map((segment) => Number.parseInt(segment, 10))
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = Number.isFinite(a[index]) ? a[index] : 0
    const y = Number.isFinite(b[index]) ? b[index] : 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * 只把 enclosure URL 的**文件名部分**重挂到前缀上（query/fragment 一并丢弃）。
 * 前缀必须以 `/` 结尾——否则 URL(relativeTo:) 语义会拼出 `…tagfile`（静默坏链接）。
 */
export function rewriteEnclosureUrls(item, downloadUrlPrefix) {
  if (typeof downloadUrlPrefix !== 'string' || !downloadUrlPrefix.endsWith('/')) {
    throw new Error('download-url-prefix 必须以 / 结尾（URL(relativeTo:) 语义）')
  }
  return String(item).replace(/(<enclosure\b[^>]*?\burl=")([^"]+)(")/g, (whole, head, url, tail) => {
    const path = url.split('#')[0].split('?')[0]
    const name = path.slice(path.lastIndexOf('/') + 1)
    return `${head}${downloadUrlPrefix}${name}${tail}`
  })
}

/**
 * 合并滚动 beta feed：beta 条目 + 唯一最新 final 条目。
 * @param input - `{ betaFeedXml, stableFeedXml?, previousFeedXml?, downloadUrlPrefix? }`。
 * @returns `{ xml, betaItemCount, finalItem }`；finalItem 为 `{ version, shortVersionString } | null`。
 */
export function mergeRollingBetaFeed({
  betaFeedXml,
  stableFeedXml = null,
  previousFeedXml = null,
  downloadUrlPrefix = null,
  betaItemLimit = 3,
}) {
  if (typeof betaFeedXml !== 'string' || betaFeedXml.trim() === '') {
    throw new Error('beta feed 为空——拒绝生成合并结果')
  }
  if (betaFeedXml.indexOf('<channel') === -1) {
    throw new Error('beta feed 缺少 <channel>——不是可识别的 appcast')
  }
  // 只替换 **item 区段**：区段边界取自与解析器**同一个** APPCAST_ITEM_PATTERN 的匹配位置，
  // 避免「item 列表」与「splice 边界」在畸形 feed 上各说各话。channel 头（title 等）与 item
  // 之后的 channel 级元素逐字保留，不重建 <channel>/</rss> 尾巴。
  const matches = [...String(betaFeedXml).matchAll(APPCAST_ITEM_PATTERN)]
  if (matches.length === 0) {
    throw new Error('beta feed 没有任何 <item>——拒绝生成合并结果')
  }
  const before = betaFeedXml.slice(0, matches[0].index)
  const lastMatch = matches[matches.length - 1]
  const after = betaFeedXml.slice(lastMatch.index + lastMatch[0].length)
  // item 之间只允许空白：任何注释/元素/CDATA 残余都会在「只替换 item 区段」时被丢掉
  // （Sparkle 未来把 description 写成 CDATA 时，一个含 </item> 的字面量就会截断块）。
  for (let index = 1; index < matches.length; index += 1) {
    const gap = betaFeedXml.slice(matches[index - 1].index + matches[index - 1][0].length, matches[index].index)
    if (gap.trim() !== '') {
      throw new Error('beta feed 的 <item> 之间存在非空白内容——只替换 item 区段会在合并时丢掉它，拒绝生成')
    }
  }
  const indent = /([ \t]*)$/.exec(before)?.[1] ?? ''
  const betaBlocks = appcastItemBlocks(betaFeedXml)
  const unclassifiable = betaBlocks.filter((item) => !appcastItemIsFinal(item) && !appcastItemIsPrerelease(item))
  if (unclassifiable.length > 0) {
    throw new Error('beta feed 有既不是 final 也不是 prerelease 的条目（缺/空 sparkle:shortVersionString）——拒绝搬运无法分类的条目')
  }
  const freshBetaItems = betaBlocks.filter((item) => !appcastItemIsFinal(item))
  if (freshBetaItems.length === 0) {
    throw new Error('beta feed 没有任何 beta 条目——拒绝用合并结果覆盖滚动 beta 通道')
  }
  // 旧 feed（--previous）里的条目同样要能分类，否则会在下面被当成 beta 条目搬进来。
  if (previousFeedXml !== null
    && appcastItemBlocks(previousFeedXml).some((item) => !appcastItemIsFinal(item) && !appcastItemIsPrerelease(item))) {
    throw new Error('--previous feed 有既不是 final 也不是 prerelease 的条目（缺/空 sparkle:shortVersionString）——拒绝搬运无法分类的条目')
  }
  // 保留 --previous 里更早的 beta 条目：staging 可能因限额/下载失败少收归档，只搬新鲜条目会让
  // 更早的 beta 从通道里静默消失（旧客户端的版本链断掉）。按 sparkle:version 去重（新鲜条目优先）、
  // 版本倒序，再按 betaItemLimit 截断（口径同 generate_appcast 的 --maximum-versions）。
  // 新鲜 feed 自己出现重复 version = 畸形输入：**不许**靠去重悄悄修好（会丢掉一个真实条目）。
  const freshVersions = freshBetaItems.map((item) => appcastSparkleField(item, 'version'))
  if (new Set(freshVersions).size !== freshVersions.length) {
    throw new Error('beta feed 自身有重复的 sparkle:version——拒绝搬运畸形 feed')
  }
  const previousBetaItems = previousFeedXml === null
    ? []
    : appcastItemBlocks(previousFeedXml).filter((item) => appcastItemIsPrerelease(item))
  const seenBetaVersions = new Set()
  const unionBetaItems = []
  for (const item of [...freshBetaItems, ...previousBetaItems]) {
    const version = appcastSparkleField(item, 'version')
    if (version === null || seenBetaVersions.has(version)) continue
    seenBetaVersions.add(version)
    unionBetaItems.push(item)
  }
  unionBetaItems.sort((left, right) => compareSparkleVersions(
    appcastSparkleField(right, 'version'), appcastSparkleField(left, 'version')))
  const limit = Number.isInteger(betaItemLimit) && betaItemLimit > 0 ? betaItemLimit : 3
  const betaItems = unionBetaItems.slice(0, limit)
  // final 候选只认**可分类为 final** 的条目（shortVersionString 缺失/空不算 final）；stable 侧
  // 一颗可用的 final 都没有时退回 --previous 里已有的 final（可见性绝不删除）。
  const stableFinals = appcastItemBlocks(stableFeedXml === null ? '' : stableFeedXml)
    .filter((item) => appcastItemIsFinal(item))
  const previousFinals = previousFeedXml === null
    ? []
    : appcastItemBlocks(previousFeedXml).filter((item) => appcastItemIsFinal(item))
  // 取「stable ∪ previous」里版本最高的 final。--previous 只在 stable 侧没有可用 final 时兜底
  // 是不够的：releases/latest 是日期序，老系列的 hotfix 可能让 stable 侧比滚动 feed 里已发布的
  // final 更旧——用旧条目覆盖会让 beta 客户端看到的正式版倒退。
  let finalItem = null
  let finalFromStable = false
  for (const [items, fromStable] of [[stableFinals, true], [previousFinals, false]]) {
    for (const item of items) {
      if (finalItem === null
        || compareSparkleVersions(appcastSparkleField(item, 'version'), appcastSparkleField(finalItem, 'version')) > 0) {
        finalItem = item
        finalFromStable = fromStable
      }
    }
  }
  // 搬进滚动 feed 的 final 条目必须自带签名 enclosure：否则 beta 客户端会拒绝它，
  // 「能看到正式版」就只剩一个不可安装的条目（stable 腿自己也会断言签名，这里是纵深防御）。
  if (finalItem !== null
    && !appcastMainEnclosureTags(finalItem).some((tag) => /\bsparkle:edSignature="[^"]+"/.test(tag))) {
    throw new Error('候选 final 条目没有任何带 sparkle:edSignature 的 enclosure——拒绝把它搬进滚动 beta feed')
  }
  // 前缀只对 stable 来源的 final 生效（prefix 是 stable tag 的下载目录）；previous 来源的条目
  // 保留它自己发布时的 URL——套错前缀会直接 404。
  if (finalItem !== null && downloadUrlPrefix !== null && finalFromStable) {
    finalItem = rewriteEnclosureUrls(finalItem, downloadUrlPrefix)
  }
  const items = [...betaItems, ...(finalItem === null ? [] : [finalItem])]
  const seen = new Set()
  for (const item of items) {
    const version = appcastSparkleField(item, 'version')
    if (seen.has(version)) {
      throw new Error(`合并后出现重复 sparkle:version=${version}——拒绝发布行为不可预测的 feed`)
    }
    seen.add(version)
  }
  items.sort((left, right) => compareSparkleVersions(
    appcastSparkleField(right, 'version'),
    appcastSparkleField(left, 'version'),
  ))
  // before 已含首个 item 前的缩进；后续条目用同一缩进，after 原样接回（含 channel 尾巴）。
  const xml = `${before}${items.join('\n' + indent)}${after}`
  return {
    xml,
    betaItemCount: betaItems.length,
    finalItem: finalItem === null
      ? null
      : {
          version: appcastSparkleField(finalItem, 'version'),
          shortVersionString: appcastSparkleField(finalItem, 'shortVersionString'),
        },
  }
}

/** 解析 CLI 参数；非法返回 null。 */
export function parseMergeArgs(args) {
  const options = { beta: null, stable: null, previous: null, downloadUrlPrefix: null, betaItemLimit: null, out: null }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const value = args[index + 1]
    if (argument === '--beta' || argument === '--stable' || argument === '--previous'
      || argument === '--download-url-prefix' || argument === '--beta-item-limit' || argument === '-o') {
      if (value === undefined || value.startsWith('--')) return null
      index += 1
      if (argument === '--beta') options.beta = value
      else if (argument === '--stable') options.stable = value
      else if (argument === '--previous') options.previous = value
      else if (argument === '--download-url-prefix') options.downloadUrlPrefix = value
      else if (argument === '--beta-item-limit') {
        if (!/^[1-9][0-9]*$/.test(value)) return null
        options.betaItemLimit = Number(value)
      } else options.out = value
      continue
    }
    return null
  }
  if (options.beta === null || options.out === null) return null
  return options
}

function main() {
  const options = parseMergeArgs(argv.slice(2))
  if (options === null) {
    // scripts/README.md 门禁三纪律：0 通过 / 1 红 / 2 用法错误。
    console.error(MERGE_USAGE)
    return 2
  }
  try {
    const merged = mergeRollingBetaFeed({
      betaFeedXml: readFileSync(options.beta, 'utf8'),
      stableFeedXml: options.stable === null ? null : readFileSync(options.stable, 'utf8'),
      previousFeedXml: options.previous === null ? null : readFileSync(options.previous, 'utf8'),
      downloadUrlPrefix: options.downloadUrlPrefix,
      betaItemLimit: options.betaItemLimit === null ? 3 : options.betaItemLimit,
    })
    writeFileSync(options.out, merged.xml)
    // 机器可读的一行：release.yml 据此决定是否要求 final 条目（没有 keyed 正式版原生包时
    // 只能 loud 降级为「只含 beta」，绝不能因此阻塞 beta 通道）。finalItem 是布尔 token，
    // 供发布腿做精确匹配（final 版本号只作人类可读信息）。
    const finalItemToken = merged.finalItem === null ? '0' : '1'
    const finalShort = merged.finalItem === null ? 'none' : merged.finalItem.shortVersionString
    const finalSparkle = merged.finalItem === null ? 'none' : merged.finalItem.version
    console.log(`merge-native-feed: betaItems=${merged.betaItemCount} finalItem=${finalItemToken} final=${finalShort} sparkleVersion=${finalSparkle}`)
    return 0
  } catch (error) {
    console.error(`merge-native-feed 失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  exit(main())
}
