#!/usr/bin/env node
/**
 * verify-native-appcast.mjs —— 本版本 appcast 发布物门禁（fail-closed）。
 *
 * 为什么单独一个脚本：appcast "生成成功" 不等于客户端能看到这次更新。EdDSA 私钥
 * 已配置时，正式发布必须保证签名发布的 appcast 里真的有**本版本**的条目：
 *   - `sparkle:version` 必须等于 .app 的 CFBundleVersion（Sparkle 用它比较版本；
 *     写成 base 版本号或旧映射 = 永远不提示更新）；
 *   - `sparkle:shortVersionString` 必须是发布版本；
 *   - 同一条 item 的 enclosure 必须指向本版本的 zip。
 * 缺任一条即 FAIL：这类偏差若只靠人工核对 appcast，发布照常成功
 * 而客户端永远看不到更新。
 *
 * design 25 §7 增量更新的三条可选形状门禁（缺省不改变既有语义）：
 *   - `--single-item`：stable feed 必须恰好 1 个 item（历史 zip 只当 delta 基线，不进 feed）；
 *   - `--expect-final-item`：feed 必须含 final 条目（beta 渠道滚动 feed 携带最新正式版）；
 *   - `--expect-delta-from <上一版本>`：本版本 item 必须带该旧版本 `sparkle:version` 的 delta——
 *     收件目录里放了旧归档却没产出 delta = 增量链静默退化，必须 FAIL。参数收的是 chamber 版本号
 *     （X.Y.Z 或 X.Y.Z-beta.N），经 bundleVersionFor 折成 sparkle:version，单一来源与本 .app 的
 *     CFBundleVersion 同源。
 *
 * 期望的 CFBundleVersion 单一来源是 macos/scripts/build-swift-app.mjs 的
 * bundleVersionFor（同一个值写进 Info.plist）。本脚本**静态** import 它：
 * release-artifacts.mjs 被 build-swift-app 静态依赖，如果反过来在
 * release-artifacts 里动态 import，就会在 CLI 入口构成 top-level-await 环而
 * deadlock——所以这个胶水层必须在这里，且必须是静态 import。
 *
 * 用法：
 *   node scripts/release/verify-native-appcast.mjs <version> <appcast-file>
 *     [--single-item] [--expect-final-item] [--expect-delta-from <上一版本>]
 *
 * 失败 = 非零退出（发布腿据此 FAIL；绝不把"没有本版本条目"降级成日志）。
 */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { argv, exit } from 'node:process'
import { pathToFileURL } from 'node:url'
import { bundleVersionFor } from '../../macos/scripts/build-swift-app.mjs'
import { assertAppcastAdvertises, nativeMacArtifacts } from './release-artifacts.mjs'

export const APPCAST_USAGE = '用法：verify-native-appcast.mjs <version> <appcast-file> '
  + '[--single-item] [--expect-final-item] [--expect-delta-from <上一版本>] [--expect-delta-count <n>] '
  + '[--signatures-dir <dir> --public-key <base64>]'

/**
 * 用 Ed25519 公钥验证一份文件的 Sparkle `sparkle:edSignature`（签名覆盖文件字节；
 * 公钥是 32 字节原始 key 的 base64，需包成 SPKI DER 交给 node:crypto）。
 * 只断言「签名存在」不够——密钥轮换后条目会带上
 * 一个**任何公钥都验不过**的签名，generate_appcast 既不警告也不写放弃标记。
 * @returns true/false；公钥/签名长度不合法时抛错（配置错误必须响，不许静默放行）。
 */
export function verifySparkleSignature(publicKeyBase64, signatureBase64, filePath) {
  const raw = Buffer.from(publicKeyBase64, 'base64')
  if (raw.length !== 32) {
    throw new Error(`SUPublicEDKey 不是 32 字节 Ed25519 原始公钥（解出 ${raw.length} 字节）——拒绝把它当作验签依据`)
  }
  const signature = Buffer.from(signatureBase64, 'base64')
  if (signature.length !== 64) {
    throw new Error(`sparkle:edSignature 不是 64 字节 Ed25519 签名（解出 ${signature.length} 字节）`)
  }
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
  return cryptoVerify(null, readFileSync(filePath), key, signature)
}

/** 对本版本主归档与它宣传的每个 delta 逐条验签（文件必须真实存在于 signaturesDir）。 */
export function verifyAdvertisedSignatures(advertised, { signaturesDir, publicKey }) {
  const targets = [
    { what: `本版本归档 ${basename(advertised.enclosure ?? '')}`, url: advertised.enclosure, signature: advertised.enclosureSignature },
    ...advertised.deltas.map((delta) => ({
      what: `delta(deltaFrom=${delta.deltaFrom ?? '?'})`,
      url: delta.url,
      signature: delta.signature,
    })),
  ]
  for (const target of targets) {
    if (target.url === null || target.url === undefined) {
      throw new Error(`${target.what} 没有 enclosure url——无法验签`)
    }
    if (target.signature === null || target.signature === undefined || target.signature === '') {
      throw new Error(`${target.what} 没有 sparkle:edSignature——无法验签`)
    }
    const file = join(signaturesDir, basename(target.url))
    if (!existsSync(file)) {
      throw new Error(`${target.what} 的文件不在 ${signaturesDir}（${basename(target.url)}）——验签需要真实字节`)
    }
    if (!verifySparkleSignature(publicKey, target.signature, file)) {
      throw new Error(`${target.what} 的 EdDSA 签名验不过（公钥与签名不匹配或归档被改动）——客户端会拒绝它`)
    }
  }
  return targets.length
}

/**
 * 解析 CLI 参数（纯函数，单测直测）。
 * @param args - `argv.slice(2)`。
 * @returns `{ version, appcastPath, singleItem, requireFinalItem, expectDeltaFromVersion, expectDeltaCount }`，非法时 null。
 */
export function parseVerifyAppcastArgs(args) {
  const positional = []
  const options = {
    singleItem: false,
    requireFinalItem: false,
    expectDeltaFromVersion: null,
    expectDeltaCount: null,
    signaturesDir: null,
    publicKey: null,
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--single-item') {
      options.singleItem = true
      continue
    }
    if (argument === '--expect-final-item') {
      options.requireFinalItem = true
      continue
    }
    if (argument === '--expect-delta-from') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) return null
      options.expectDeltaFromVersion = value
      index += 1
      continue
    }
    if (argument === '--expect-delta-count') {
      const value = args[index + 1]
      if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null
      options.expectDeltaCount = Number(value)
      index += 1
      continue
    }
    if (argument === '--signatures-dir' || argument === '--public-key') {
      const value = args[index + 1]
      if (value === undefined || value.startsWith('--')) return null
      if (argument === '--signatures-dir') options.signaturesDir = value
      else options.publicKey = value
      index += 1
      continue
    }
    if (argument.startsWith('--')) return null
    positional.push(argument)
  }
  if (positional.length !== 2) return null
  // 验签是「要么都给、要么都不给」：只给一个会让人以为已经验过签名。
  if ((options.signaturesDir === null) !== (options.publicKey === null)) return null
  return { version: positional[0], appcastPath: positional[1], ...options }
}

/**
 * 校验一个 appcast 文件确实宣传了本版本（可选形状/delta 断言）。
 * @param version - X.Y.Z 或 X.Y.Z-beta.N（release.yml 的 create-release 输出）。
 * @param appcastPath - 发布腿写出的 appcast 文件。
 * @param options - `{ singleItem?, requireFinalItem?, expectDeltaFromVersion?, expectDeltaCount? }`。
 * @returns 命中条目的事实 `{ version, sparkleVersion, enclosure, itemCount, deltas }`。
 */
export function verifyNativeAppcast(version, appcastPath, options = {}) {
  const sparkleVersion = bundleVersionFor(version)
  const archiveName = nativeMacArtifacts(version)[1]
  if (!existsSync(appcastPath)) {
    throw new Error(`appcast 不存在：${appcastPath}——签名发布链路未产出本版本的 appcast`)
  }
  const expectDeltaFrom = options.expectDeltaFromVersion === undefined || options.expectDeltaFromVersion === null
    ? null
    : bundleVersionFor(options.expectDeltaFromVersion)
  const advertised = assertAppcastAdvertises(readFileSync(appcastPath, 'utf8'), {
    version,
    sparkleVersion,
    archiveName,
    singleItem: options.singleItem === true,
    requireFinalItem: options.requireFinalItem === true,
    expectDeltaFrom,
    expectDeltaCount: options.expectDeltaCount ?? null,
  })
  if (options.signaturesDir !== null && options.signaturesDir !== undefined) {
    verifyAdvertisedSignatures(advertised, {
      signaturesDir: options.signaturesDir,
      publicKey: options.publicKey,
    })
  }
  return advertised
}

function main() {
  const parsed = parseVerifyAppcastArgs(argv.slice(2))
  if (parsed === null) {
    // scripts/README.md 门禁三纪律：0 通过 / 1 红 / 2 用法错误（真正的门禁失败仍是 1）。
    console.error(APPCAST_USAGE)
    return 2
  }
  try {
    const advertised = verifyNativeAppcast(parsed.version, parsed.appcastPath, parsed)
    const deltas = advertised.deltas.length === 0
      ? '无 delta（整包更新）'
      : `deltaFrom=${advertised.deltas.map((entry) => entry.deltaFrom ?? '?').join(',')}`
    console.log(`appcast 本版本门禁通过：${advertised.version}（sparkle:version ${advertised.sparkleVersion}，`
      + `item ${advertised.itemCount} 个，${deltas}）-> ${advertised.enclosure}`)
    return 0
  } catch (error) {
    console.error(`appcast 本版本门禁失败：${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  exit(main())
}
