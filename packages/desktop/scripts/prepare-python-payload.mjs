#!/usr/bin/env node
/**
 * prepare-python-payload.mjs —— python 载荷（primary runtime）的下载 / 校验 / 落位。
 *
 * 上游口径（vendor/harness-checkout/apps/desktop/scripts/prepare-primary-runtime.ts）：
 * 打包态不自带宿主机装的解释器，而是按一份锁下载 relocatable 的 CPython + 平台轮子，
 * 解到 bundle 内的只读载荷目录，再在首次使用时**安装**到可写的 dsh home
 * （apps/desktop-host/src/primary-runtime.ts 的 installPrimaryRuntime），最后由宿主工具
 * load_workspace_dependencies 把绝对路径交给模型——**不改 PATH、不注入 env**
 * （apps/desktop-host/src/workspace-dependencies.ts 的工具描述逐字写明）。
 * 本脚本负责前半段：解析锁 → 按 URL 下载 → 逐件 sha256 校验 → 解到载荷布局 → 写
 * runtime.json；后半段（安装 + 路径暴露）属上游 desktop-host app，本仓不运行它。
 *
 * 与本仓既有 node 载荷的关系：node 归档的版本与摘要不在本脚本另立一份，而是与
 * packages/desktop/scripts/build-sidecar.mjs 的 PINNED_NODE_SHA256 前置锁步
 * （prepare-python-payload.test.mjs）；锁里的 nodeArchive/nodeSha256 只是同一事实的
 * 声明面（并供 mac x64 腿取一份已验证的 x64 node）。
 *
 * 离线纪律：--dry-run 只解析锁 + 校验布局与目标，**不联网、不写盘**（无网环境的默认
 * 证据）；真实下载只在本脚本被显式调用时发生（发布腿 / 显式构建腿），默认构建链不触发。
 * 依赖纪律：只用 node 内置（crypto/fs/zlib + 全局 fetch）——因此 tar.gz 与 zip 的解包
 * 是本文件内的最小实现（见 readTarGz / readZip）。
 *
 * CLI：
 *   node scripts/prepare-python-payload.mjs --dry-run [--target mac-arm64]
 *   node scripts/prepare-python-payload.mjs [--target <t>] [--out <dir>] [--cache <dir>] [--with-node]
 *   node scripts/prepare-python-payload.mjs --verify <dir>
 * 退出码：0 成功；1 失败（锁不合法 / 摘要不匹配 / 载荷不完整）。
 */
import { createHash } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync, inflateRawSync } from 'node:zlib'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
/** packages/desktop —— 本脚本与锁、载荷目录的共同根。 */
export const DESKTOP_DIR = path.resolve(SCRIPT_DIR, '..')
/** 锁文件（唯一版本/sha256 来源；脚本内不得再写死任何构件摘要）。 */
export const LOCK_PATH = path.join(DESKTOP_DIR, 'primary-runtime-lock.json')
/** Electron 侧载荷落点：extraResources 投递到 <resourcesPath>/primary-runtime。 */
export const DEFAULT_OUT_DIR = path.join(DESKTOP_DIR, 'resources', 'primary-runtime')
/** 下载缓存（按 sha256 命名；release/ 已在 .gitignore）。 */
export const DEFAULT_CACHE_DIR = path.join(DESKTOP_DIR, 'release', 'primary-runtime-cache')
/** 载荷清单格式（布局语义改变时递增）。 */
export const PAYLOAD_FORMAT = 1
/** 桌面应用版本：runtime.json 的 `desktopVersion`（上游 parsePrimaryRuntime 必填）。 */
export const DESKTOP_VERSION = JSON.parse(
  readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'),
).version
/** runtime.json 的两种状态：complete = 真实载荷；absent = 未准备（只有说明文件）。 */
export const PAYLOAD_COMPLETE = 'complete'
export const PAYLOAD_ABSENT = 'absent'

/**
 * 本仓登记的目标（键名与上游锁一致）。没有登记的平台 = 不出货，resolveTarget 拒绝。
 * linux/windows 上游有目标而本仓尚未发布（design 22/23 外部门禁未闭），故意缺席。
 */
export const REGISTERED_TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u

/** 读取并解析锁文本（JSON 错误带上来源，不吞异常）。 */
export function parseLock(text, source = LOCK_PATH) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error('primary runtime lock 不是合法 JSON（' + source + '）：' + (error instanceof Error ? error.message : String(error)))
  }
  return assertLock(parsed, source)
}

/**
 * 校验锁的结构与不变量（fail-closed；返回同一对象便于链式使用）。
 * 这里不校验构件真实性——sha256 是否与真实构件一致只能在下载时判定（不匹配即抛）。
 */
export function assertLock(lock, source = LOCK_PATH) {
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new Error('primary runtime lock 必须是对象（' + source + '）')
  }
  for (const field of ['nodeVersion', 'pythonVersion', 'pythonRelease']) {
    if (typeof lock[field] !== 'string' || lock[field] === '') {
      throw new Error('primary runtime lock 缺 ' + field + '（' + source + '）')
    }
  }
  if (!/^\d+\.\d+\.\d+$/u.test(lock.pythonVersion)) {
    throw new Error('pythonVersion 必须是 X.Y.Z（' + source + '）：' + JSON.stringify(lock.pythonVersion))
  }
  const targets = lock.targets
  if (targets === null || typeof targets !== 'object' || Array.isArray(targets) || Object.keys(targets).length === 0) {
    throw new Error('primary runtime lock 的 targets 必须是非空对象（' + source + '）')
  }
  for (const [target, artifact] of Object.entries(targets)) {
    if (!Object.prototype.hasOwnProperty.call(REGISTERED_TARGETS, target)) {
      throw new Error('锁登记了未出货的目标 ' + target + '——只允许 ' + Object.keys(REGISTERED_TARGETS).join(' / ') + '（' + source + '）')
    }
    for (const field of ['nodeArchive', 'pythonTarget']) {
      if (typeof artifact[field] !== 'string' || artifact[field] === '') {
        throw new Error('targets.' + target + '.' + field + ' 缺失或为空（' + source + '）')
      }
    }
    for (const field of ['nodeSha256', 'pythonSha256']) {
      if (typeof artifact[field] !== 'string' || !SHA256_PATTERN.test(artifact[field])) {
        throw new Error('targets.' + target + '.' + field + ' 必须是小写 64 位 hex：' + JSON.stringify(artifact[field]) + '（' + source + '）')
      }
    }
    assertWheelList(artifact.wheels, 'targets.' + target + '.wheels', source)
  }
  assertWheelList(lock.wheels, 'wheels', source)
  const packages = lock.pythonPackages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages) || Object.keys(packages).length === 0) {
    throw new Error('primary runtime lock 的 pythonPackages 必须是非空对象（' + source + '）')
  }
  for (const [name, version] of Object.entries(packages)) {
    if (typeof version !== 'string' || version === '') {
      throw new Error('pythonPackages.' + name + ' 的版本必须是非空字符串（' + source + '）')
    }
  }
  return lock
}

function assertWheelList(wheels, label, source) {
  if (!Array.isArray(wheels) || wheels.length === 0) {
    throw new Error('primary runtime lock 的 ' + label + ' 必须是非空数组（' + source + '）')
  }
  for (const wheel of wheels) {
    if (wheel === null || typeof wheel !== 'object' || Array.isArray(wheel)) {
      throw new Error(label + ' 的每项必须是 { url, sha256 }（' + source + '）')
    }
    if (typeof wheel.url !== 'string' || !/^https:\/\//u.test(wheel.url) || !wheel.url.endsWith('.whl')) {
      throw new Error(label + ' 含非 https .whl 的 url：' + JSON.stringify(wheel.url) + '（' + source + '）')
    }
    if (typeof wheel.sha256 !== 'string' || !SHA256_PATTERN.test(wheel.sha256)) {
      throw new Error(label + ' 的 ' + wheel.url + ' 缺小写 64 位 hex sha256（' + source + '）')
    }
  }
}

/** 宿主（或显式 --target）→ 锁里的目标键。未登记的组合直接拒绝，绝不猜。 */
export function resolveTarget(lock, platform = process.platform, arch = process.arch) {
  const found = Object.entries(REGISTERED_TARGETS)
    .find(([, value]) => value.platform === platform && value.arch === arch)
  if (found === undefined) {
    throw new Error(
      '没有登记 ' + platform + '/' + arch + ' 的 python 载荷目标——本仓只出货 '
      + Object.keys(REGISTERED_TARGETS).join(' / ') + '；未出货平台不注册锁目标',
    )
  }
  const [target] = found
  if (lock.targets[target] === undefined) throw new Error('锁缺 targets.' + target + '（--target 与 REGISTERED_TARGETS 漂移）')
  return target
}

/** astral-sh/python-build-standalone 的归档名（上游同式）。 */
export function pythonArchiveName(lock, target) {
  return 'cpython-' + lock.pythonVersion + '+' + lock.pythonRelease + '-' + lock.targets[target].pythonTarget
    + '-install_only_stripped.tar.gz'
}

/** 归档 URL（上游同式：release tag = pythonRelease，文件名 URI 编码）。 */
export function pythonArchiveUrl(lock, target) {
  const name = pythonArchiveName(lock, target)
  return 'https://github.com/astral-sh/python-build-standalone/releases/download/'
    + lock.pythonRelease + '/' + encodeURIComponent(name)
}

/** node 归档名（与 build-sidecar 的 nodeArchiveName 同式）。 */
export function nodeArchiveName(lock, target) {
  return 'node-v' + lock.nodeVersion + '-' + lock.targets[target].nodeArchive
}

/** node 官方分发 URL。 */
export function nodeDistUrl(lock, target) {
  return 'https://nodejs.org/dist/v' + lock.nodeVersion + '/' + nodeArchiveName(lock, target)
}

/** site-packages 的相对路径（dry-run 打印与落位共用）。 */
export function sitePackagesRelative(lock) {
  const [major, minor] = lock.pythonVersion.split('.')
  return path.posix.join('dependencies', 'python', 'lib', 'python' + major + '.' + minor, 'site-packages')
}

/** python 解释器在载荷内的相对路径（darwin）。 */
export function pythonBinaryRelative() {
  return path.posix.join('dependencies', 'python', 'bin', 'python3')
}

/** wheel URL 的文件名（上游锁不记文件名，由 URL 派生）。 */
export function wheelFileName(url) {
  const name = new URL(url).pathname.split('/').pop()
  if (name === undefined || name === '' || !name.endsWith('.whl')) throw new Error('wheel url 取不到 .whl 文件名：' + url)
  return decodeURIComponent(name)
}

/**
 * 载荷身份（与上游 primaryRuntimePayloadDigest 同思路：只由锁定的输入决定，不含时间戳；
 * 改锁任一构件 = 新摘要）。
 */
export function payloadDigest(lock, target) {
  return createHash('sha256').update(JSON.stringify({
    format: PAYLOAD_FORMAT,
    target,
    pythonVersion: lock.pythonVersion,
    pythonRelease: lock.pythonRelease,
    nodeVersion: lock.nodeVersion,
    artifact: lock.targets[target],
    wheels: lock.wheels,
    pythonPackages: lock.pythonPackages,
  })).digest('hex')
}

/**
 * 本次落位的完整计划（dry-run 打印的就是它；entries 是唯一的下载清单）。
 * @param lock - 已校验的锁。
 * @param target - 目标键。
 * @param options.includeNode - 是否连带 node 载荷（默认否：python 载荷不需要 node）。
 */
export function payloadPlan(lock, target, options = {}) {
  const artifact = lock.targets[target]
  const entries = []
  if (options.includeNode === true) {
    entries.push({ kind: 'node', archive: nodeArchiveName(lock, target), url: nodeDistUrl(lock, target), sha256: artifact.nodeSha256 })
  }
  entries.push({
    kind: 'python',
    archive: pythonArchiveName(lock, target),
    url: pythonArchiveUrl(lock, target),
    sha256: artifact.pythonSha256,
  })
  for (const wheel of [...artifact.wheels, ...lock.wheels]) {
    entries.push({ kind: 'wheel', archive: wheelFileName(wheel.url), url: wheel.url, sha256: wheel.sha256 })
  }
  return {
    format: PAYLOAD_FORMAT,
    target,
    platform: REGISTERED_TARGETS[target].platform,
    arch: REGISTERED_TARGETS[target].arch,
    components: {
      python: lock.pythonVersion,
      ...(options.includeNode === true ? { node: lock.nodeVersion } : {}),
      // legacy 形态必需：值只从 pythonPackages 派生（见 legacyDistributionVersions）。
      ...legacyDistributionVersions(lock.pythonPackages),
    },
    pythonPackages: lock.pythonPackages,
    payloadDigest: payloadDigest(lock, target),
    sitePackages: sitePackagesRelative(lock),
    pythonBinary: pythonBinaryRelative(),
    entries,
  }
}

/**
 * legacy 形态要求的发行版版本键（上游 parsePrimaryRuntime 的 components.numpy /
 * components.pandas）：只从 pythonPackages 派生——两个来源各写一份就会在下游解析时
 * 按「inconsistent legacy metadata」拒绝。
 * @param pythonPackages - 锁里的发行版映射。
 * @returns 归一后命中的 { numpy?, pandas? }（缺项不写，由上游按缺失拒绝）。
 */
function legacyDistributionVersions(pythonPackages) {
  const normalized = new Map(
    Object.entries(pythonPackages).map(([name, version]) => [name.toLowerCase().replace(/[-_.]+/gu, '-'), version]),
  )
  const out = {}
  for (const key of ['numpy', 'pandas']) {
    const version = normalized.get(key)
    if (typeof version === 'string') out[key] = version
  }
  return out
}

/**
 * 载荷清单对象（写进 runtime.json；与 payloadPlan 的事实同源，并可被上游唯一消费者
 * `parsePrimaryRuntime` 直接解析：`desktopVersion` + `platform`(win32|darwin|linux) +
 * `arch`(x64|arm64) + legacy `components.numpy/pandas`）。我方额外字段
 * （format/payload/target/layout）供本仓 --verify 使用，上游解析器不读它们。
 */
export function payloadManifest(lock, target, options = {}) {
  const plan = payloadPlan(lock, target, options)
  return {
    format: PAYLOAD_FORMAT,
    payload: PAYLOAD_COMPLETE,
    target: plan.target,
    platform: plan.platform,
    arch: plan.arch,
    desktopVersion: options.desktopVersion ?? DESKTOP_VERSION,
    components: plan.components,
    pythonPackages: plan.pythonPackages,
    payloadDigest: plan.payloadDigest,
    layout: { python: plan.pythonBinary, sitePackages: plan.sitePackages },
  }
}

/** sha256 hex（唯一摘要入口；下载、缓存复用与单测都走它）。 */
export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 取一份**已按锁校验**的归档到本地缓存。
 * 缓存按 sha256 命名且复用时重新摘要——「锁的 sha 变了而缓存没变」与「缓存被换过」
 * 都会在这里红，不会静默用旧字节。
 */
export async function fetchVerifiedArchive(entry, options = {}) {
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR
  const fetchImpl = options.fetchImpl ?? fetch
  const log = options.log ?? (() => {})
  const cached = path.join(cacheDir, entry.sha256)
  if (existsSync(cached)) {
    const bytes = readFileSync(cached)
    if (sha256Hex(bytes) === entry.sha256) {
      log('[python-payload] 复用缓存 ' + entry.archive + '（sha256 命中）')
      return { path: cached, bytes, fromCache: true }
    }
    log('[python-payload] 缓存 ' + entry.archive + ' 摘要不符（锁已变或缓存被替换），丢弃重下')
    rmSync(cached, { force: true })
  }
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch——下载需要 node >= 18 的全局 fetch')
  log('[python-payload] 下载 ' + entry.archive + ' ← ' + entry.url)
  const response = await fetchImpl(entry.url)
  if (response === null || typeof response !== 'object' || response.ok !== true) {
    throw new Error('下载失败 ' + entry.archive + '：HTTP ' + String(response?.status ?? '?') + '（' + entry.url + '）')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const actual = sha256Hex(bytes)
  if (actual !== entry.sha256) {
    throw new Error('sha256 不匹配（' + entry.archive + '）：锁 ' + entry.sha256 + '，实际 ' + actual
      + '——锁与构件已经不一致，拒绝落位')
  }
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(cached, bytes)
  return { path: cached, bytes, fromCache: false }
}

/** 载荷内相对路径的联合校验（拒绝绝对路径、..、盘符与 NUL）。 */
export function safeEntryPath(name) {
  const normalized = String(name).replaceAll('\\', '/')
  if (normalized === '' || normalized.includes('\u0000')) throw new Error('归档条目名为空或含 NUL：' + JSON.stringify(name))
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) throw new Error('归档条目是绝对路径：' + normalized)
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) throw new Error('归档条目越出载荷根：' + normalized)
  return segments.join('/')
}

/** tar 的八进制字段（允许结尾 NUL/空格，空字段读作 0）。 */
function octalField(header, offset, length) {
  const raw = header.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/u, '').trim()
  return raw === '' ? 0 : Number.parseInt(raw, 8)
}

/**
 * 读一个未压缩 tar（含 GNU longname 'L' 与 pax 'x' 头）。
 * 除 gzip 的 CRC 外，tar 头校验和也验——损坏在解包前就红。
 */
export function readTar(buffer) {
  const entries = []
  let offset = 0
  let pendingLongName = null
  let pendingPaxPath = null
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = octalField(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const dataStart = offset + 512
    const data = buffer.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (typeflag === 'L') {
      pendingLongName = data.toString('utf8').replace(/\0+$/u, '')
      continue
    }
    if (typeflag === 'x' || typeflag === 'g') {
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(data.toString('utf8'))
      if (match !== null) pendingPaxPath = match[1]
      continue
    }
    const prefix = header.subarray(345, 345 + 155).toString('utf8').replace(/\0.*$/u, '')
    const base = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    const name = pendingPaxPath ?? pendingLongName ?? [prefix, base].filter((part) => part !== '').join('/')
    pendingLongName = null
    pendingPaxPath = null
    if (name === '') continue
    entries.push({
      name,
      type: typeflag,
      mode: octalField(header, 100, 8),
      size,
      linkname: header.subarray(157, 157 + 100).toString('utf8').replace(/\0.*$/u, ''),
      data,
    })
  }
  return entries
}

/** gunzip + 读 tar。 */
export function readTarGz(buffer) {
  return readTar(gunzipSync(buffer))
}

/**
 * 把 tar 条目解到 destination。
 * @param buffer - .tar.gz 字节。
 * @param destination - 解包根（载荷内相对布局的起算点，与上游 cwd=dependencies 等价）。
 * @param options.filter - 可选 (entry) => string | null：返回重写后的相对路径，null 丢弃。
 * @returns 写出的文件/符号链接数。
 */
export function extractTarGz(buffer, destination, options = {}) {
  const filter = options.filter
  let written = 0
  for (const entry of readTarGz(buffer)) {
    const rewritten = filter === undefined ? safeEntryPath(entry.name) : filter(entry)
    if (rewritten === null || rewritten === undefined) continue
    const relative = safeEntryPath(rewritten)
    const target = path.join(destination, relative)
    if (entry.type === '5' || entry.name.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }
    mkdirSync(path.dirname(target), { recursive: true })
    if (entry.type === '2') {
      writeSymlink(target, entry.linkname, destination)
      written += 1
      continue
    }
    if (entry.type !== '0' && entry.type !== '7') {
      throw new Error('tar 条目类型 ' + JSON.stringify(entry.type) + ' 不受支持：' + entry.name)
    }
    writeFileSync(target, entry.data)
    applyMode(target, entry.mode)
    written += 1
  }
  return written
}

/** 创建 tar 里的符号链接；目标必须落在**本次解包根**内（相对链接按链接所在目录解析）。 */
function writeSymlink(target, linkname, rootDir) {
  const root = path.resolve(rootDir)
  const resolved = path.resolve(path.dirname(target), linkname)
  if (path.isAbsolute(linkname) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
    throw new Error('符号链接指向载荷外：' + target + ' -> ' + linkname)
  }
  rmSync(target, { force: true })
  symlinkSync(linkname, target)
}

function applyMode(target, mode) {
  if (typeof mode !== 'number' || mode === 0) return
  try {
    chmodSync(target, mode & 0o777)
  } catch (error) {
    throw new Error('无法设置权限 ' + (mode & 0o777).toString(8) + '（' + target + '）：'
      + (error instanceof Error ? error.message : String(error)))
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

/** zip 条目的 CRC-32（与 central directory 的 crc 字段比对）。 */
export function crc32(buffer) {
  let crc = 0xFFFFFFFF
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

/** zip central directory → 条目（只支持 store/deflate，够 wheel 用；zip64 直接拒绝）。 */
export function readZip(buffer) {
  const eocd = findEndOfCentralDirectory(buffer)
  const total = buffer.readUInt16LE(eocd + 10)
  const cdOffset = buffer.readUInt32LE(eocd + 16)
  if (cdOffset === 0xFFFFFFFF || total === 0xFFFF) throw new Error('zip64 归档不受支持')
  const entries = []
  let cursor = cdOffset
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014B50) throw new Error('zip central directory 记录签名不符（offset ' + cursor + '）')
    const versionMadeBy = buffer.readUInt16LE(cursor + 4)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    entries.push({
      name: buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      unixMode: (versionMadeBy >> 8) === 3 ? (externalAttributes >>> 16) & 0xFFFF : 0,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557)
  for (let cursor = buffer.length - 22; cursor >= minimum; cursor -= 1) {
    if (buffer.readUInt32LE(cursor) === 0x06054B50) return cursor
  }
  throw new Error('zip 缺 End of Central Directory（不是合法 zip）')
}

/** 一个 zip 条目的解压字节（CRC 校验；store 与 deflate 两种方法）。 */
export function readZipEntryData(buffer, entry) {
  const local = entry.localOffset
  if (buffer.readUInt32LE(local) !== 0x04034B50) throw new Error('zip local header 签名不符：' + entry.name)
  const nameLength = buffer.readUInt16LE(local + 26)
  const extraLength = buffer.readUInt16LE(local + 28)
  const start = local + 30 + nameLength + extraLength
  const raw = buffer.subarray(start, start + entry.compressedSize)
  let data
  if (entry.method === 0) data = raw
  else if (entry.method === 8) data = inflateRawSync(raw)
  else throw new Error('zip 压缩方法 ' + entry.method + ' 不受支持：' + entry.name)
  if (data.length !== entry.uncompressedSize) {
    throw new Error('zip 条目长度不符（' + entry.name + '）：' + String(data.length) + ' != ' + String(entry.uncompressedSize))
  }
  const actual = crc32(data)
  if (actual !== entry.crc) throw new Error('zip 条目 CRC 不符（' + entry.name + '）：' + actual.toString(16) + ' != ' + entry.crc.toString(16))
  return data
}

/**
 * 把 wheel（zip）解到 destination（上游同义：wheel 的 .data 只允许 scripts scheme，
 * 其余安装 scheme 直接拒绝——避免把宿主绝对路径布局解到 site-packages）。
 */
export function extractWheel(buffer, destination) {
  let written = 0
  for (const entry of readZip(buffer)) {
    const relative = safeEntryPath(entry.name)
    const segments = relative.split('/')
    if (segments[0] !== undefined && segments[0].endsWith('.data')) {
      const scheme = segments.length > 2 ? segments[1] : ''
      if (scheme !== '' && scheme !== 'scripts') throw new Error('wheel 需要不支持的安装路径：' + entry.name)
    }
    if (entry.name.endsWith('/')) {
      mkdirSync(path.join(destination, relative), { recursive: true })
      continue
    }
    const target = path.join(destination, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, readZipEntryData(buffer, entry))
    applyMode(target, entry.unixMode === 0 ? 0o644 : (entry.unixMode & 0o777) || 0o644)
    written += 1
  }
  return written
}

/** node 归档 → dependencies/node（只取 bin/node + LICENSE；npm/headers 不落位）。 */
export function extractNodePayload(buffer, destination) {
  const wanted = new Map([['bin/node', 'node/bin/node'], ['LICENSE', 'node/LICENSE']])
  let written = 0
  for (const entry of readTarGz(buffer)) {
    if (entry.type !== '0') continue
    const segments = safeEntryPath(entry.name).split('/')
    const mapped = wanted.get(segments.slice(1).join('/'))
    if (mapped === undefined) continue
    const target = path.join(destination, mapped)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, entry.data)
    applyMode(target, entry.mode === 0 ? 0o755 : entry.mode & 0o777)
    written += 1
  }
  if (written !== wanted.size) {
    throw new Error('node 归档缺件（期望 ' + [...wanted.keys()].join(' / ') + '，实际命中 ' + String(written)
      + '）——归档布局与 extractNodePayload 不一致')
  }
  mkdirSync(path.join(destination, 'node', 'node_modules'), { recursive: true })
  writeFileSync(
    path.join(destination, 'node', 'node_modules', 'README.txt'),
    'Reserved for bundled Node packages. pnpm uses its default installation directories.\n',
  )
  return written
}

/**
 * 解释器基线发行版：python-build-standalone 的 install_only 载荷自带 pip，而上游
 * `scripts/primary-runtime/smoke.py`（第 28–30 行）把期望集合定义为
 * 「声明的发行版 ∪ {pip}」——pip 属于**解释器基座**，不是载荷锁的成员（版本随
 * 解释器构建变化，上游也只按名字放行）。反向精确集合因此必须按名字放行它；其余
 * 任何未登记发行版依然红。2026-09 release dry run 正是因为漏掉这条基线而假红。
 */
export const INTERPRETER_BASELINE_DISTRIBUTIONS = new Set(['pip'])

/** PEP 503 归一化（dist-info 目录名比较用；只做大小写与分隔符折叠）。 */
export function normalizeDistributionName(name) {
  return name.toLowerCase().replace(/[-_.]+/gu, '-')
}

/** 期望的 dist-info 目录名（Pillow/12.3.0 → pillow-12.3.0.dist-info）。 */
export function distInfoName(name, version) {
  return normalizeDistributionName(name).replaceAll('-', '_') + '-' + version + '.dist-info'
}

function listDirectories(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 载荷完整性判定（发布腿与 build-sidecar 的 --require-python 共用；不联网）。
 * @returns {{ ok: boolean, state: 'complete'|'absent'|'incomplete', target: string|null, problems: string[] }}
 */
export function verifyPayload(dir) {
  const manifestPath = path.join(dir, 'runtime.json')
  if (!existsSync(manifestPath)) {
    return { ok: false, state: PAYLOAD_ABSENT, target: null, problems: ['缺 runtime.json（载荷未准备）：' + manifestPath] }
  }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      state: 'incomplete',
      target: null,
      problems: ['runtime.json 不是合法 JSON：' + (error instanceof Error ? error.message : String(error))],
    }
  }
  const problems = []
  if (manifest.format !== PAYLOAD_FORMAT) problems.push('runtime.json format=' + String(manifest.format) + '，期望 ' + String(PAYLOAD_FORMAT))
  if (manifest.payload !== PAYLOAD_COMPLETE) problems.push('runtime.json payload=' + String(manifest.payload) + '，只有 ' + PAYLOAD_COMPLETE + ' 才是真实载荷')
  if (typeof manifest.target !== 'string' || !Object.prototype.hasOwnProperty.call(REGISTERED_TARGETS, manifest.target)) {
    problems.push('runtime.json target 非法：' + JSON.stringify(manifest.target))
  }
  const pythonBinary = path.join(dir, typeof manifest.layout?.python === 'string' ? manifest.layout.python : pythonBinaryRelative())
  if (!existsSync(pythonBinary)) problems.push('缺 python 解释器：' + pythonBinary)
  const sitePackages = path.join(dir, typeof manifest.layout?.sitePackages === 'string' ? manifest.layout.sitePackages : sitePackagesRelative({ pythonVersion: '3.12' }))
  const sitePackagesExists = existsSync(sitePackages)
  if (!sitePackagesExists) problems.push('缺 site-packages 目录：' + sitePackages)
  const distributions = sitePackagesExists ? listDirectories(sitePackages) : []
  const packages = manifest.pythonPackages
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages) || Object.keys(packages).length === 0) {
    // 缺元数据不是「没有可核对的包」而是「无法证明载荷完整」——fail-closed，否则
    // release.yml 与 build:sidecar --require-python 共用的闸门会凭空放行。
    problems.push('runtime.json 缺 pythonPackages（或为空）——无法核对 site-packages 里的锁定发行版')
  } else {
    for (const [name, version] of Object.entries(packages)) {
      // 必须精确命中 distInfoName(name, version)：同名 dist-info 的错版本不得算过。
      const expected = typeof version === 'string' && version !== '' ? distInfoName(name, version) : null
      if (expected === null || !distributions.includes(expected)) {
        problems.push('site-packages 缺 ' + name + ' ' + String(version) + '（期望 ' + (expected ?? '合法版本号') + '）')
      }
    }
    // 反向（精确集合）：site-packages 里**多出**的发行版同样是「载荷与锁不一致」。
    // 只查「锁 ⊆ 实装」会让一个被换过/夹带了额外 wheel 的载荷静默放行；上游
    // prepare.ts 的 smoke.py 断言的正是精确集合（升级计划 §22.4.2-8）。
    const locked = new Set(Object.keys(packages).map((name) => normalizeDistributionName(name)))
    for (const directory of distributions) {
      const match = /^(.+)-([0-9][^-]*)\.dist-info$/u.exec(directory)
      if (match === null) continue
      const normalized = normalizeDistributionName(match[1])
      if (INTERPRETER_BASELINE_DISTRIBUTIONS.has(normalized) || locked.has(normalized)) continue
      problems.push('site-packages 多出未登记发行版 ' + directory + '（载荷与锁不一致）')
    }
  }
  return {
    ok: problems.length === 0,
    state: problems.length === 0 ? PAYLOAD_COMPLETE : 'incomplete',
    target: typeof manifest.target === 'string' ? manifest.target : null,
    problems,
  }
}

/**
 * 下载 + 校验 + 落位（唯一会写盘的入口）。
 * @param options.lock - 锁对象（本函数先 assertLock）。
 * @param options.target - 目标键（缺省由宿主解析）。
 * @param options.outDir - 落位目录（先在同级 staging 组装，最后整体替换）。
 * @param options.dryRun - true = 只算计划，不联网、不写盘。
 * @param options.fetchImpl - 注入的 fetch（测试用；dry-run 下保证零调用）。
 * @returns {{ dryRun: boolean, plan: object, manifest?: object, files?: number }}
 */
export async function materialize(options) {
  const log = options.log ?? (() => {})
  const lock = assertLock(options.lock)
  const target = options.target ?? resolveTarget(lock, options.platform, options.arch)
  if (!Object.prototype.hasOwnProperty.call(lock.targets, target)) throw new Error('锁缺 targets.' + target)
  const plan = payloadPlan(lock, target, { includeNode: options.includeNode === true })
  if (options.dryRun === true) {
    log('[python-payload] dry-run：锁/布局校验通过（target=' + target + '，entries=' + String(plan.entries.length)
      + '，downloads=0，writes=0）；未联网、未写盘')
    return { dryRun: true, plan }
  }
  const outDir = options.outDir ?? DEFAULT_OUT_DIR
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR
  const staging = path.join(path.dirname(outDir), '.primary-runtime-staging-' + String(process.pid))
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  let files = 0
  try {
    for (const entry of plan.entries) {
      const archive = await fetchVerifiedArchive(entry, { cacheDir, fetchImpl: options.fetchImpl, log })
      if (entry.kind === 'python') files += extractTarGz(archive.bytes, path.join(staging, 'dependencies'))
      else if (entry.kind === 'wheel') files += extractWheel(archive.bytes, path.join(staging, plan.sitePackages))
      else if (entry.kind === 'node') files += extractNodePayload(archive.bytes, path.join(staging, 'dependencies'))
      else throw new Error('未知载荷条目：' + String(entry.kind))
    }
    const manifest = payloadManifest(lock, target, { includeNode: options.includeNode === true })
    writeFileSync(path.join(staging, 'runtime.json'), JSON.stringify(manifest, undefined, 2) + '\n')
    const check = verifyPayload(staging)
    if (!check.ok) {
      throw new Error('落位自检失败（' + check.problems.join('；') + '）——载荷未替换，请检查锁与构件')
    }
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(path.dirname(outDir), { recursive: true })
    renameSync(staging, outDir)
    log('[python-payload] 完成：' + outDir + '（target=' + target + '，files=' + String(files)
      + '，payloadDigest=' + manifest.payloadDigest + '）')
    return { dryRun: false, plan, manifest, files }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

const USAGE = [
  '用法：',
  '  node scripts/prepare-python-payload.mjs --dry-run [--target mac-arm64]',
  '  node scripts/prepare-python-payload.mjs [--target <t>] [--out <dir>] [--cache <dir>] [--with-node]',
  '  node scripts/prepare-python-payload.mjs --verify <dir>',
].join('\n')

/** 解析 CLI 参数（未知参数 = 失败；--dry-run 不写盘不联网）。 */
export function parseArgs(argv) {
  const options = {
    dryRun: false, target: null, outDir: null, cacheDir: null, withNode: false,
    verifyDir: null, lockPath: LOCK_PATH, help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      index += 1
      if (index >= argv.length) throw new Error(arg + ' 缺少取值')
      return argv[index]
    }
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--with-node') options.withNode = true
    else if (arg === '--target') options.target = next()
    else if (arg === '--out') options.outDir = path.resolve(next())
    else if (arg === '--cache') options.cacheDir = path.resolve(next())
    else if (arg === '--lock') options.lockPath = path.resolve(next())
    else if (arg === '--verify') options.verifyDir = path.resolve(next())
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error('未知参数：' + arg)
  }
  return options
}

/** dry-run 的计划打印（发布腿日志的证据面）。 */
export function formatPlan(plan, options = {}) {
  const lines = [
    '[python-payload] target: ' + plan.target + '（' + plan.platform + '/' + plan.arch + '）',
    '[python-payload] components: ' + JSON.stringify(plan.components),
    '[python-payload] payloadDigest: ' + plan.payloadDigest,
    '[python-payload] 布局：' + plan.pythonBinary + '；site-packages=' + plan.sitePackages,
  ]
  for (const entry of plan.entries) {
    lines.push('[python-payload]   [' + entry.kind + '] ' + entry.archive + ' sha256=' + entry.sha256.slice(0, 12)
      + '… ← ' + entry.url)
  }
  if (options.outDir !== undefined) lines.push('[python-payload] out: ' + options.outDir)
  return lines
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(USAGE)
    return 0
  }
  if (options.verifyDir !== null) {
    const result = verifyPayload(options.verifyDir)
    if (result.ok) {
      console.log('[python-payload] 载荷完整：' + options.verifyDir + '（target=' + String(result.target) + '，state=' + result.state + '）')
      return 0
    }
    console.error('[python-payload] 载荷不完整（' + options.verifyDir + '）：\n  - ' + result.problems.join('\n  - '))
    return 1
  }
  const lock = parseLock(readFileSync(options.lockPath, 'utf8'), options.lockPath)
  // 显式 --target 也要过登记表：否则未出货架构会在下游以'Cannot read properties of undefined' 的形态炸掉。
  if (options.target !== null && !Object.prototype.hasOwnProperty.call(REGISTERED_TARGETS, options.target)) {
    throw new Error('未登记的 --target ' + options.target + '——本仓只出货 ' + Object.keys(REGISTERED_TARGETS).join(' / ')
      + '（x64 腿 2026-12 暂时移除，见 docs/progress/STATUS.md）')
  }
  const target = options.target ?? resolveTarget(lock)
  const plan = payloadPlan(lock, target, { includeNode: options.withNode })
  for (const line of formatPlan(plan, { outDir: options.outDir ?? DEFAULT_OUT_DIR })) console.log(line)
  if (options.dryRun) {
    console.log('[python-payload] dry-run：锁/布局校验通过；未联网、未写盘')
    return 0
  }
  await materialize({
    lock,
    target,
    outDir: options.outDir ?? DEFAULT_OUT_DIR,
    cacheDir: options.cacheDir ?? DEFAULT_CACHE_DIR,
    includeNode: options.withNode,
    log: (line) => { console.log(line) },
  })
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error('[python-payload] 失败：' + (error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  })
}
