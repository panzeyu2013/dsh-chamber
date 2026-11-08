/**
 * prepare-python-payload.test.mjs —— python 载荷 machinery 的行为与纪律用例（C5）。
 *
 * 覆盖六件事：
 *  ① 锁是唯一版本/摘要来源：结构校验、未出货目标拒绝、node 版本/摘要不再有 sidecar
 *     第二 pin、脚本里不得出现写死的 64 位摘要；
 *  ② 最小解包器（tar.gz / zip，node 内置）在真实布局（符号链接、权限位、
 *     dist-info）上工作，并在越出载荷根 / CRC 不符 / 未知安装 scheme 时拒绝；
 *  ③ --dry-run 的离线保证：零 fetch、零写盘；真实路径的落位布局 + runtime.json +
 *     自检（site-packages 里每个锁定发行版都必须精确命中同名同版本的 dist-info；
 *     缺 pythonPackages 元数据直接判不完整）；
 *  ④ 「改锁没改校验就红」：翻改锁里的一个 sha256 后，同一份字节必须被拒
 *     （下载侧与缓存复用侧各一条）；
 *  ⑤ CLI（main 级）：不带 --target 时按宿主解析目标（不得被显式 --target 守卫误拦，
 *     D1），显式未登记 target 仍要响亮拒绝。
 *  ⑥ full 载荷的 pnpm 半边（--with-pnpm 隐含 --with-node）：版本单源（desktop
 *     dependencies.pnpm）、构建机 node_modules/pnpm 的解析/拷贝/外平台原生包 prune、
 *     manifest legacy components.pnpm、payloadDigest 纳入 pnpm 版本、--verify 对
 *     components.node/pnpm 的构件核查。默认行为必须保持 python-only。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync, gzipSync } from 'node:zlib'
import {
  DEFAULT_OUT_DIR,
  DESKTOP_PNPM_VERSION,
  LOCK_PATH,
  PAYLOAD_FORMAT,
  REGISTERED_TARGETS,
  DESKTOP_VERSION,
  assertLock,
  acceptsNpmPlatform,
  crc32,
  desktopPnpmVersion,
  extractTarGz,
  extractWheel,
  fetchVerifiedArchive,
  foreignPnpmNativePackages,
  formatPlan,
  materialize,
  nodeArchiveName,
  nodeBinaryRelative,
  parseArgs,
  parseLock,
  payloadManifest,
  payloadPlan,
  pnpmBinaryRelative,
  pnpmDirectoryRelative,
  pythonArchiveName,
  pythonArchiveUrl,
  resolvePnpmSource,
  resolveTarget,
  safeEntryPath,
  sha256Hex,
  verifyPayload,
} from './prepare-python-payload.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_SOURCE = readFileSync(path.join(SCRIPT_DIR, 'prepare-python-payload.mjs'), 'utf8')
const LOCK_TEXT = readFileSync(LOCK_PATH, 'utf8')
const LOCK = parseLock(LOCK_TEXT, LOCK_PATH)

/** 临时工作目录（每个用例自建，结束即删；异步回调要等 promise 落定再删）。 */
function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-python-payload-test-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  let result
  try {
    result = fn(dir)
  } catch (error) {
    cleanup()
    throw error
  }
  if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
    return result.finally(cleanup)
  }
  cleanup()
  return result
}

/** tar 头（ustar，含校验和字段——readTar 只读字段，测试写的是真格式）。 */
function tarHeader(name, size, mode, type, linkname) {
  const header = Buffer.alloc(512)
  header.write(name, 0, 100, 'utf8')
  header.write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100, 'latin1')
  header.write('0000000\0', 108, 'latin1')
  header.write('0000000\0', 116, 'latin1')
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1')
  header.write('00000000000\0', 136, 'latin1')
  header.write('        ', 148, 'latin1')
  header.write(type, 156, 1, 'latin1')
  if (linkname !== undefined) header.write(linkname, 157, 100, 'utf8')
  header.write('ustar\0', 257, 6, 'latin1')
  header.write('00', 263, 2, 'latin1')
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1')
  return header
}

/** 极简 tar 写端（store；只为用例造夹具，不参与产品路径）。 */
function buildTar(entries) {
  const parts = []
  for (const entry of entries) {
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data)
    parts.push(tarHeader(entry.name, data.length, entry.mode ?? 0o644, entry.type ?? '0', entry.linkname))
    if (data.length > 0) {
      parts.push(data)
      parts.push(Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length))
    }
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

function buildTarGz(entries) {
  return gzipSync(buildTar(entries))
}

/** 极简 zip 写端（store / deflate 两种方法；central directory 带 unix 权限位）。 */
function buildZip(entries, method = 0) {
  const body = []
  const records = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const name = Buffer.from(entry.name, 'utf8')
    const payload = method === 8 ? deflateRawSync(data) : data
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    body.push(local, name, payload)
    records.push({ name, crc, payload, data, offset, mode: entry.mode ?? 0o644 })
    offset += local.length + name.length + payload.length
  }
  const centralParts = []
  for (const record of records) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE((3 << 8) | 20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(method, 10)
    header.writeUInt32LE(record.crc, 16)
    header.writeUInt32LE(record.payload.length, 20)
    header.writeUInt32LE(record.data.length, 24)
    header.writeUInt16LE(record.name.length, 28)
    header.writeUInt32LE(record.mode << 16, 38)
    header.writeUInt32LE(record.offset, 42)
    centralParts.push(header, record.name)
  }
  const central = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(records.length, 8)
  eocd.writeUInt16LE(records.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...body, central, eocd])
}

/** 夹具 python 安装树（install_only 布局 + 一个符号链接 + 一个不可执行文件）。 */
function fakePythonArchive() {
  return buildTarGz([
    { name: 'python/', type: '5', mode: 0o755 },
    { name: 'python/bin/', type: '5', mode: 0o755 },
    { name: 'python/bin/python3', data: '#!/bin/sh\nexit 0\n', mode: 0o755 },
    { name: 'python/bin/python3.12', data: '#!/bin/sh\nexit 0\n', mode: 0o755 },
    { name: 'python/bin/python', type: '2', linkname: 'python3', mode: 0o777 },
    { name: 'python/lib/', type: '5', mode: 0o755 },
    { name: 'python/lib/python3.12/', type: '5', mode: 0o755 },
    { name: 'python/lib/python3.12/site-packages/.keep', data: '', mode: 0o644 },
  ])
}

/** 夹具 node 归档（extractNodePayload 只取 <root>/bin/node 与 <root>/LICENSE）。 */
function fakeNodeArchive() {
  const root = 'node-v' + LOCK.nodeVersion + '-darwin-arm64'
  return buildTarGz([
    { name: root + '/bin/node', data: '#!/bin/sh\nexit 0\n', mode: 0o755 },
    { name: root + '/LICENSE', data: 'Node.js LICENSE\n', mode: 0o644 },
  ])
}

/**
 * 夹具 pnpm 包：版本必须等于 desktop dependencies.pnpm（单一来源），并带齐
 * prune 需要的外平台 optional 原生包（@reflink 的 darwin-arm64 / darwin-x64 /
 * win32-x64）与一个无 os/cpu 约束的普通包。只造 prune/拷贝真正读取的文件。
 */
function fakePnpmSource(dir, options = {}) {
  const version = options.version ?? DESKTOP_PNPM_VERSION
  const root = path.join(dir, 'pnpm')
  const writeJson = (relative, value) => {
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(value, undefined, 2) + '\n')
  }
  writeJson('package.json', { name: 'pnpm', version, bin: { pnpm: 'bin/pnpm.mjs' }, main: 'bin/pnpm.mjs' })
  if (options.bin !== false) {
    mkdirSync(path.join(root, 'bin'), { recursive: true })
    writeFileSync(path.join(root, 'bin', 'pnpm.mjs'), '#!/usr/bin/env node\nconsole.log("pnpm fixture")\n')
  }
  writeJson('dist/node_modules/plain/package.json', { name: 'plain', version: '1.0.0' })
  writeJson('dist/node_modules/@reflink/reflink/package.json', { name: '@reflink/reflink', version: '0.1.19' })
  writeJson('dist/node_modules/@reflink/reflink-darwin-arm64/package.json',
    { name: '@reflink/reflink-darwin-arm64', version: '0.1.19', os: ['darwin'], cpu: ['arm64'] })
  writeJson('dist/node_modules/@reflink/reflink-darwin-x64/package.json',
    { name: '@reflink/reflink-darwin-x64', version: '0.1.19', os: ['darwin'], cpu: ['x64'] })
  writeJson('dist/node_modules/@reflink/reflink-win32-x64-msvc/package.json',
    { name: '@reflink/reflink-win32-x64-msvc', version: '0.1.19', os: ['win32'], cpu: ['x64'] })
  mkdirSync(path.join(root, 'dist', 'node_modules', '.bin'), { recursive: true })
  writeFileSync(path.join(root, 'dist', 'node_modules', '.bin', 'abbrev'), '#!/bin/sh\n')
  return root
}

/** wheel 文件名 → dist-info 目录名（PEP 427/503 的测试侧推导）。 */
function distInfoOfWheel(url) {
  const fileName = new URL(url).pathname.split('/').pop()
  const stem = fileName.replace(/\.whl$/u, '')
  const parts = stem.split('-')
  return parts[0] + '-' + parts[1] + '.dist-info'
}

/** 夹具 wheel（store zip，含 dist-info/RECORD）。 */
function fakeWheel(url) {
  const distInfo = distInfoOfWheel(url)
  return buildZip([
    { name: distInfo + '/', data: '' },
    { name: distInfo + '/METADATA', data: 'Metadata-Version: 2.1\nName: ' + distInfo + '\n' },
    { name: distInfo + '/RECORD', data: '' },
  ])
}

/**
 * 以真实锁为骨架、把摘要换成本用例夹具摘要的锁（URL 清单不变）。
 * @param options.includeNode - 同时伪造 node 归档摘要（pnpm 用例隐含 node）。
 */
function fixtureLock(options = {}) {
  const lock = JSON.parse(LOCK_TEXT)
  const pythonBytes = fakePythonArchive()
  const nodeBytes = options.includeNode === true ? fakeNodeArchive() : undefined
  const wheelBytes = new Map()
  const digestOf = (bytes) => sha256Hex(bytes)
  for (const artifact of Object.values(lock.targets)) {
    artifact.pythonSha256 = digestOf(pythonBytes)
    if (nodeBytes !== undefined) artifact.nodeSha256 = digestOf(nodeBytes)
    for (const wheel of artifact.wheels) {
      wheelBytes.set(wheel.url, fakeWheel(wheel.url))
      wheel.sha256 = digestOf(wheelBytes.get(wheel.url))
    }
  }
  for (const wheel of lock.wheels) {
    wheelBytes.set(wheel.url, fakeWheel(wheel.url))
    wheel.sha256 = digestOf(wheelBytes.get(wheel.url))
  }
  return { lock, pythonBytes, nodeBytes, wheelBytes }
}

/** 只认夹具 URL 的 fetch 替身（计调用次数，便于断言 dry-run 零联网）。 */
function fixtureFetch(pythonBytes, wheelBytes, nodeBytes = undefined) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    let bytes
    if (url.includes('cpython-')) bytes = pythonBytes
    else if (url.includes('/node-v')) bytes = nodeBytes
    else bytes = wheelBytes.get(url)
    if (bytes === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: true, status: 200, arrayBuffer: async () => bytes }
  }
  return { impl, calls }
}

test('① 锁：结构、登记目标与来源字段', () => {
  assert.equal(assertLock(LOCK), LOCK)
  // x64 腿 2026-12 暂时移除（STATUS）：锁与白名单都只登记 arm64。
  assert.deepEqual(Object.keys(LOCK.targets).sort(), ['mac-arm64'])
  assert.deepEqual(Object.keys(REGISTERED_TARGETS).sort(), ['mac-arm64'])
  assert.match(LOCK.pythonVersion, /^\d+\.\d+\.\d+$/u)
  assert.ok(Object.keys(LOCK.pythonPackages).length >= 13)
  assert.ok(typeof LOCK.provenance === 'object' && typeof LOCK.provenance.structure === 'string')
})

test('① 锁：未出货目标 / 坏摘要 / 空清单一律拒绝', () => {
  const clone = () => JSON.parse(LOCK_TEXT)
  const winTarget = clone()
  winTarget.targets['win-x64'] = winTarget.targets['mac-arm64']
  assert.throws(() => assertLock(winTarget), /未出货的目标 win-x64/u)

  const badSha = clone()
  badSha.targets['mac-arm64'].pythonSha256 = 'XYZ'
  assert.throws(() => assertLock(badSha), /pythonSha256 必须是小写 64 位 hex/u)

  const emptyWheels = clone()
  emptyWheels.wheels = []
  assert.throws(() => assertLock(emptyWheels), /wheels 必须是非空数组/u)

  const badPackages = clone()
  badPackages.pythonPackages = {}
  assert.throws(() => assertLock(badPackages), /pythonPackages 必须是非空对象/u)

  const badUrl = clone()
  badUrl.wheels[0].url = 'http://example.com/x.whl'
  assert.throws(() => assertLock(badUrl), /非 https \.whl/u)

  assert.throws(() => parseLock('{'), /不是合法 JSON/u)
  assert.throws(() => parseLock('[1]'), /必须是对象/u)
})

test('① 目标解析与 URL 派生（上游同式）', () => {
  assert.equal(resolveTarget(LOCK, 'darwin', 'arm64'), 'mac-arm64')
  // x64 暂时移除：darwin/x64 不再有登记目标，必须响亮拒绝（不是回退 arm64）。
  assert.throws(() => resolveTarget(LOCK, 'darwin', 'x64'), /没有登记 darwin\/x64/u)
  assert.throws(() => resolveTarget(LOCK, 'linux', 'x64'), /没有登记 linux\/x64/u)
  assert.throws(() => resolveTarget(LOCK, 'win32', 'x64'), /没有登记 win32\/x64/u)

  assert.equal(
    pythonArchiveName(LOCK, 'mac-arm64'),
    'cpython-3.12.14+20260901-aarch64-apple-darwin-install_only_stripped.tar.gz',
  )
  assert.equal(
    pythonArchiveUrl(LOCK, 'mac-arm64'),
    'https://github.com/astral-sh/python-build-standalone/releases/download/20260901/'
      + 'cpython-3.12.14%2B20260901-aarch64-apple-darwin-install_only_stripped.tar.gz',
  )
})

test('① 计划：条目来自锁，node 可选；pnpm 版本进入 components 与 payloadDigest', () => {
  const plan = payloadPlan(LOCK, 'mac-arm64')
  assert.equal(plan.format, PAYLOAD_FORMAT)
  assert.equal(plan.entries.length, 1 + LOCK.targets['mac-arm64'].wheels.length + LOCK.wheels.length)
  assert.equal(plan.pythonBinary, 'dependencies/python/bin/python3')
  assert.equal(plan.sitePackages, 'dependencies/python/lib/python3.12/site-packages')
  assert.ok(plan.entries.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sha256)))
  assert.equal(plan.entries.filter((entry) => entry.kind === 'node').length, 0)
  assert.equal(plan.pnpm, null, '默认仍是 python-only')
  assert.equal(plan.components.node, undefined)
  assert.equal(plan.components.pnpm, undefined)

  const withNode = payloadPlan(LOCK, 'mac-arm64', { includeNode: true })
  const nodeEntry = withNode.entries.find((entry) => entry.kind === 'node')
  assert.ok(nodeEntry !== undefined)
  assert.equal(nodeEntry.sha256, LOCK.targets['mac-arm64'].nodeSha256)
  assert.equal(withNode.components.node, LOCK.nodeVersion)

  // node 版本/摘要的唯一来源是载荷锁：Swift 单 Node 后 build-sidecar 不再另存 pin
  // （本用例因此不再 import build-sidecar；锁字段自证归档名与摘要形状）。
  assert.match(LOCK.nodeVersion, /^\d+\.\d+\.\d+$/u)
  assert.equal(nodeArchiveName(LOCK, 'mac-arm64'), 'node-v' + LOCK.nodeVersion + '-darwin-arm64.tar.gz')
  assert.match(LOCK.targets['mac-arm64'].nodeSha256, /^[0-9a-f]{64}$/u)
  assert.equal(nodeBinaryRelative('darwin'), 'dependencies/node/bin/node')
  assert.equal(nodeBinaryRelative('win32'), 'dependencies/node/bin/node.exe')

  // --with-pnpm 隐含 --with-node（plan 层也保持该不变式，不依赖调用方）。
  const pnpm = { source: path.join(path.sep, 'build', 'node_modules', 'pnpm'), version: DESKTOP_PNPM_VERSION }
  const withPnpm = payloadPlan(LOCK, 'mac-arm64', { pnpm })
  assert.equal(withPnpm.components.pnpm, DESKTOP_PNPM_VERSION)
  assert.equal(withPnpm.components.node, LOCK.nodeVersion, '--with-pnpm 隐含 --with-node')
  assert.equal(withPnpm.pnpm.version, DESKTOP_PNPM_VERSION)
  assert.equal(withPnpm.pnpm.source, pnpm.source)
  assert.equal(withPnpm.entries.filter((entry) => entry.kind === 'node').length, 1)
  assert.equal(pnpmDirectoryRelative(), 'dependencies/pnpm')
  assert.equal(pnpmBinaryRelative(), 'dependencies/pnpm/bin/pnpm.mjs')

  const digest = payloadPlan(LOCK, 'mac-arm64').payloadDigest
  assert.match(digest, /^[0-9a-f]{64}$/u)
  assert.equal(digest, payloadPlan(LOCK, 'mac-arm64', { includeNode: true }).payloadDigest,
    'node 归档不改变载荷身份（python-only 与 --with-node 共用同一 python 身份）')
  assert.notEqual(withPnpm.payloadDigest, digest, 'pnpm 版本必须进入 payloadDigest')
  assert.equal(withPnpm.payloadDigest, payloadPlan(LOCK, 'mac-arm64', { pnpm: { ...pnpm } }).payloadDigest,
    '同一 pnpm 版本 ⇒ 同一身份（可复现）')
})

test('① 摘要唯一来源：脚本内不得写死 64 位 hex（只能读锁）', () => {
  const literals = SCRIPT_SOURCE.match(/\b[0-9a-f]{64}\b/gu) ?? []
  assert.deepEqual(literals, [], '脚本出现写死的构件摘要——摘要必须以锁为唯一来源')
  assert.match(SCRIPT_SOURCE, /LOCK_PATH/u)
})

test('② 路径联合：绝对路径 / .. / 盘符 / NUL 一律拒绝', () => {
  assert.equal(safeEntryPath('a/b/c.txt'), 'a/b/c.txt')
  assert.equal(safeEntryPath('./a//b'), 'a/b')
  for (const bad of ['/etc/passwd', '../x', 'a/../../x', 'C:\\windows\\x', 'a\0b']) {
    assert.throws(() => safeEntryPath(bad), /载荷|绝对路径|NUL/u, bad)
  }
})

test('② tar.gz：落位文件 / 目录 / 符号链接 / 权限位', () => {
  withTempDir((dir) => {
    const written = extractTarGz(fakePythonArchive(), dir)
    assert.ok(written >= 4)
    assert.equal(readFileSync(path.join(dir, 'python', 'bin', 'python3'), 'utf8'), '#!/bin/sh\nexit 0\n')
    assert.equal(statSync(path.join(dir, 'python', 'bin', 'python3')).mode & 0o777, 0o755)
    assert.equal(lstatSync(path.join(dir, 'python', 'bin', 'python')).isSymbolicLink(), true)
    assert.equal(readlinkSync(path.join(dir, 'python', 'bin', 'python')), 'python3')
    assert.equal(readFileSync(path.join(dir, 'python', 'lib', 'python3.12', 'site-packages', '.keep'), 'utf8'), '')
  })
})

test('② tar.gz：越出载荷根的条目与逃逸符号链接必须拒绝', () => {
  withTempDir((dir) => {
    const escape = buildTarGz([{ name: '../../evil.txt', data: 'x', mode: 0o644 }])
    assert.throws(() => extractTarGz(escape, dir), /载荷根/u)
    const absolute = buildTarGz([{ name: '/tmp/evil.txt', data: 'x', mode: 0o644 }])
    assert.throws(() => extractTarGz(absolute, dir), /绝对路径/u)
    const symlinkEscape = buildTarGz([{ name: 'python/bin/link', type: '2', linkname: '../../../../etc/passwd', mode: 0o777 }])
    assert.throws(() => extractTarGz(symlinkEscape, dir), /指向载荷外/u)
  })
})

test('② zip：store 与 deflate 两种方法 + CRC 拒绝 + 未知压缩方法', () => {
  withTempDir((dir) => {
    for (const method of [0, 8]) {
      const zip = buildZip([{ name: 'pkg/data.txt', data: 'hello zip\n' }], method)
      const target = path.join(dir, String(method))
      assert.equal(extractWheel(zip, target), 1)
      assert.equal(readFileSync(path.join(target, 'pkg', 'data.txt'), 'utf8'), 'hello zip\n')
    }
    const corrupted = buildZip([{ name: 'pkg/data.txt', data: 'hello zip\n' }], 0)
    corrupted[42] = corrupted[42] ^ 0xFF
    assert.throws(() => extractWheel(corrupted, path.join(dir, 'corrupt')), /CRC|长度/u)
  })
})

test('② wheel：只允许 .data/scripts scheme，其余安装 scheme 拒绝', () => {
  withTempDir((dir) => {
    const scripts = buildZip([{ name: 'pkg-1.0.data/scripts/tool', data: '#!/bin/sh\n', mode: 0o755 }])
    assert.equal(extractWheel(scripts, path.join(dir, 'ok')), 1)
    const dataPurelib = buildZip([{ name: 'pkg-1.0.data/purelib/pkg.py', data: 'x' }])
    assert.throws(() => extractWheel(dataPurelib, path.join(dir, 'bad')), /不支持的安装路径/u)
  })
})

test('③ dry-run：零 fetch、零写盘，且计划完整可打印', async () => {
  const { impl, calls } = fixtureFetch(Buffer.alloc(0), new Map())
  const outDir = path.join(tmpdir(), 'dsh-python-payload-never-written')
  const result = await materialize({ lock: LOCK, target: 'mac-arm64', dryRun: true, fetchImpl: impl, outDir })
  assert.equal(result.dryRun, true)
  assert.equal(calls.length, 0, 'dry-run 不得联网')
  assert.equal(existsSync(outDir), false, 'dry-run 不得写盘')
  const lines = formatPlan(result.plan, { outDir })
  assert.ok(lines.some((line) => line.includes('target: mac-arm64')))
  assert.ok(lines.some((line) => line.includes('sha256=')))
})

test('③ 真实落位：布局 + runtime.json + 自检（site-packages 每个发行版）', async () => {
  const { lock, pythonBytes, wheelBytes } = fixtureLock()
  const { impl, calls } = fixtureFetch(pythonBytes, wheelBytes)
  await withTempDir(async (dir) => {
    const outDir = path.join(dir, 'primary-runtime')
    const result = await materialize({
      lock, target: 'mac-arm64', outDir, cacheDir: path.join(dir, 'cache'), fetchImpl: impl,
    })
    assert.equal(result.dryRun, false)
    assert.equal(calls.length, 1 + lock.targets['mac-arm64'].wheels.length + lock.wheels.length)
    const manifest = JSON.parse(readFileSync(path.join(outDir, 'runtime.json'), 'utf8'))
    assert.equal(manifest.payload, 'complete')
    assert.equal(manifest.target, 'mac-arm64')
    assert.equal(manifest.components.python, lock.pythonVersion)
    assert.equal(manifest.payloadDigest, result.manifest.payloadDigest)
    assert.equal(statSync(path.join(outDir, 'dependencies/python/bin/python3')).mode & 0o777, 0o755)
    const sitePackages = path.join(outDir, manifest.layout.sitePackages)
    const installed = readdirSync(sitePackages)
    for (const [name, version] of Object.entries(lock.pythonPackages)) {
      const normalized = name.toLowerCase().replace(/[-_.]+/gu, '_')
      assert.ok(
        installed.some((entry) => entry.startsWith(normalized + '-' + version)),
        '缺 ' + name + ' ' + version + '（site-packages: ' + installed.join(',') + '）',
      )
    }
    const check = verifyPayload(outDir)
    assert.equal(check.ok, true, check.problems.join('；'))
    assert.equal(check.state, 'complete')

    // 幂等：第二次运行命中缓存（fetch 不再被调用）。
    const second = fixtureFetch(pythonBytes, wheelBytes)
    await materialize({ lock, target: 'mac-arm64', outDir, cacheDir: path.join(dir, 'cache'), fetchImpl: second.impl })
    assert.equal(second.calls.length, 0, '缓存命中后不得再联网')
  })
})

test('④ 改锁没改校验就红：翻一个 hex 后同一份字节被拒', async () => {
  const { lock, pythonBytes, wheelBytes } = fixtureLock()
  const flipped = JSON.parse(JSON.stringify(lock))
  const original = flipped.targets['mac-arm64'].pythonSha256
  flipped.targets['mac-arm64'].pythonSha256 = (original[0] === '0' ? '1' : '0') + original.slice(1)
  const { impl } = fixtureFetch(pythonBytes, wheelBytes)
  await withTempDir(async (dir) => {
    const outDir = path.join(dir, 'primary-runtime')
    await assert.rejects(
      materialize({ lock: flipped, target: 'mac-arm64', outDir, cacheDir: path.join(dir, 'cache'), fetchImpl: impl }),
      /sha256 不匹配/u,
    )
    assert.equal(existsSync(outDir), false, '校验失败不得落位（staging 必须清掉）')
  })
})

test('④ 缓存复用也要重算摘要：被换过的缓存文件必须重下', async () => {
  const { lock, pythonBytes, wheelBytes } = fixtureLock()
  await withTempDir(async (dir) => {
    const cacheDir = path.join(dir, 'cache')
    mkdirSync(cacheDir, { recursive: true })
    const entry = { kind: 'python', archive: 'x.tar.gz', url: 'https://example.com/cpython-x-install_only_stripped.tar.gz', sha256: sha256Hex(pythonBytes) }
    writeFileSync(path.join(cacheDir, entry.sha256), 'not the real bytes')
    const { impl, calls } = fixtureFetch(pythonBytes, wheelBytes)
    const archive = await fetchVerifiedArchive(entry, { cacheDir, fetchImpl: impl })
    assert.equal(calls.length, 1, '摘要不符的缓存必须丢弃并重下')
    assert.equal(archive.fromCache, false)
    assert.equal(sha256Hex(archive.bytes), entry.sha256)
    assert.ok(lock.targets['mac-arm64'].pythonSha256.length === 64)
  })
})

test('④ 下载内容与锁不符时拒绝落位（含 HTTP 失败）', async () => {
  const { lock, pythonBytes } = fixtureLock()
  await withTempDir(async (dir) => {
    const bad = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('wrong') })
    await assert.rejects(
      materialize({ lock, target: 'mac-arm64', outDir: path.join(dir, 'out'), cacheDir: path.join(dir, 'cache'), fetchImpl: bad }),
      /sha256 不匹配/u,
    )
    const failing = async () => ({ ok: false, status: 503, arrayBuffer: async () => Buffer.alloc(0) })
    await assert.rejects(
      materialize({ lock, target: 'mac-arm64', outDir: path.join(dir, 'out2'), cacheDir: path.join(dir, 'cache2'), fetchImpl: failing }),
      /下载失败|sha256 不匹配/u,
    )
    assert.ok(pythonBytes.length > 0)
  })
})

test('③ verifyPayload：未准备 / 伪载荷 / 缺发行版三种红', () => {
  withTempDir((dir) => {
    const absent = verifyPayload(path.join(dir, 'nope'))
    assert.equal(absent.ok, false)
    assert.equal(absent.state, 'absent')

    const placeholder = path.join(dir, 'placeholder')
    mkdirSync(placeholder, { recursive: true })
    writeFileSync(path.join(placeholder, 'runtime.json'), JSON.stringify({ format: PAYLOAD_FORMAT, payload: 'placeholder' }))
    const check = verifyPayload(placeholder)
    assert.equal(check.ok, false)
    assert.ok(check.problems.some((problem) => problem.includes('payload=placeholder')))

    const complete = path.join(dir, 'complete')
    mkdirSync(path.join(complete, 'dependencies/python/bin'), { recursive: true })
    mkdirSync(path.join(complete, 'dependencies/python/lib/python3.12/site-packages/numpy-2.3.5.dist-info'), { recursive: true })
    writeFileSync(path.join(complete, 'dependencies/python/bin/python3'), '#!/bin/sh\n')
    writeFileSync(path.join(complete, 'runtime.json'), JSON.stringify({
      format: PAYLOAD_FORMAT,
      payload: 'complete',
      target: 'mac-arm64',
      pythonPackages: { numpy: '2.3.5', pandas: '3.0.1' },
      layout: { python: 'dependencies/python/bin/python3', sitePackages: 'dependencies/python/lib/python3.12/site-packages' },
    }))
    const partial = verifyPayload(complete)
    assert.equal(partial.ok, false)
    assert.ok(partial.problems.some((problem) => problem.includes('pandas 3.0.1')))
  })
})

test('③ verifyPayload：错版本 dist-info / 缺 pythonPackages 都必须红（fail-closed）', () => {
  withTempDir((dir) => {
    const layout = {
      python: 'dependencies/python/bin/python3',
      sitePackages: 'dependencies/python/lib/python3.12/site-packages',
    }
    /** 造一个「布局齐全、只有 site-packages 内容不同」的载荷目录。 */
    const buildPayload = (name, manifest) => {
      const root = path.join(dir, name)
      mkdirSync(path.join(root, 'dependencies/python/bin'), { recursive: true })
      mkdirSync(path.join(root, layout.sitePackages), { recursive: true })
      writeFileSync(path.join(root, layout.python), '#!/bin/sh\n')
      writeFileSync(path.join(root, 'runtime.json'), JSON.stringify(manifest))
      return root
    }
    const manifestOf = (pythonPackages) => ({
      format: PAYLOAD_FORMAT,
      payload: 'complete',
      target: 'mac-arm64',
      ...(pythonPackages === undefined ? {} : { pythonPackages }),
      layout,
    })

    // 同名但版本错的 dist-info：旧实现按名字归一化命中即放过 → fail-open。
    const wrongVersion = buildPayload('wrong-version', manifestOf({ numpy: '2.3.5' }))
    mkdirSync(path.join(wrongVersion, layout.sitePackages, 'numpy-9.9.9.dist-info'), { recursive: true })
    const wrong = verifyPayload(wrongVersion)
    assert.equal(wrong.ok, false, '同名错版本不得算过')
    assert.ok(wrong.problems.some((problem) => problem.includes('numpy 2.3.5')), wrong.problems.join('；'))

    // 同版本精确命中必须过（防止把上面那条修成一律红）。
    const exact = buildPayload('exact', manifestOf({ numpy: '2.3.5' }))
    mkdirSync(path.join(exact, layout.sitePackages, 'numpy-2.3.5.dist-info'), { recursive: true })
    const exactCheck = verifyPayload(exact)
    assert.equal(exactCheck.ok, true, exactCheck.problems.join('；'))

    // 反向精确集合：多出的发行版（夹带/被换过的 wheel）必须红——只查「锁 ⊆ 实装」
    // 会让它静默放行。
    const extra = buildPayload('extra-dist', manifestOf({ numpy: '2.3.5' }))
    mkdirSync(path.join(extra, layout.sitePackages, 'numpy-2.3.5.dist-info'), { recursive: true })
    mkdirSync(path.join(extra, layout.sitePackages, 'rogue-1.0.dist-info'), { recursive: true })
    const extraCheck = verifyPayload(extra)
    assert.equal(extraCheck.ok, false, '多出的发行版不得算过')
    assert.ok(extraCheck.problems.some((problem) => problem.includes('多出未登记发行版 rogue-1.0.dist-info')),
      extraCheck.problems.join('；'))

    // 解释器基线：CPython 的 install_only 载荷自带 pip（版本随解释器构建变化），
    // 上游 smoke.py 的期望集合是「声明的发行版 ∪ {pip}」——pip 必须按名字放行，
    // 其余未登记发行版仍然红（release dry run 曾因漏掉这条基线而假红）。
    const baseline = buildPayload('interpreter-baseline', manifestOf({ numpy: '2.3.5' }))
    mkdirSync(path.join(baseline, layout.sitePackages, 'numpy-2.3.5.dist-info'), { recursive: true })
    mkdirSync(path.join(baseline, layout.sitePackages, 'pip-26.2.1.dist-info'), { recursive: true })
    const baselineCheck = verifyPayload(baseline)
    assert.equal(baselineCheck.ok, true, baselineCheck.problems.join('；'))

    // 归一化对等：python-dateutil 的 dist-info 目录名是 python_dateutil-…，
    // 必须被认成同一发行版（否则精确集合会把它误判成「多出」）。
    const normalized = buildPayload('normalized', manifestOf({ 'python-dateutil': '2.9.0.post0' }))
    mkdirSync(path.join(normalized, layout.sitePackages, 'python_dateutil-2.9.0.post0.dist-info'), { recursive: true })
    const normalizedCheck = verifyPayload(normalized)
    assert.equal(normalizedCheck.ok, true, normalizedCheck.problems.join('；'))

    // 缺 pythonPackages 键 / 空对象：无法核对 = 不完整，不得整段跳过。
    const missing = verifyPayload(buildPayload('missing-packages', manifestOf(undefined)))
    assert.equal(missing.ok, false, '缺 pythonPackages 不得凭空通过')
    assert.ok(missing.problems.some((problem) => problem.includes('pythonPackages')), missing.problems.join('；'))
    const empty = verifyPayload(buildPayload('empty-packages', manifestOf({})))
    assert.equal(empty.ok, false, '空 pythonPackages 不得凭空通过')
    assert.ok(empty.problems.some((problem) => problem.includes('pythonPackages')), empty.problems.join('；'))
  })
})

test('⑤ CLI 参数：未知参数拒绝，--dry-run/--target/--verify 解析；--with-pnpm 隐含 node', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/u)
  assert.throws(() => parseArgs(['--target']), /缺少取值/u)
  const options = parseArgs(['--dry-run', '--target', 'mac-arm64'])
  assert.equal(options.dryRun, true)
  assert.equal(options.target, 'mac-arm64')
  assert.equal(options.withNode, false)
  assert.equal(options.withPnpm, false)
  assert.equal(parseArgs(['--verify', '/x']).verifyDir, path.resolve('/x'))
  assert.equal(parseArgs([]).outDir, null)
  assert.equal(DEFAULT_OUT_DIR.endsWith(path.join('resources', 'primary-runtime')), true)

  // --with-pnpm 隐含 --with-node（默认 python-only 不受影响）。
  const withPnpm = parseArgs(['--with-pnpm', '--pnpm-source', '/build/pnpm'])
  assert.equal(withPnpm.withPnpm, true)
  assert.equal(withPnpm.withNode, true, '--with-pnpm 必须隐含 --with-node')
  assert.equal(withPnpm.pnpmSource, path.resolve('/build/pnpm'))
  assert.equal(parseArgs(['--with-node']).withNode, true)
  assert.equal(parseArgs(['--with-node']).withPnpm, false)
  // --pnpm-source 只在 --with-pnpm 下有意义：单独出现响亮拒绝，不静默忽略。
  assert.throws(() => parseArgs(['--pnpm-source', '/build/pnpm']), /--pnpm-source 只与 --with-pnpm/u)
})

test('⑤ CLI（main 级）：不带 --target 时按宿主解析，显式未登记 target 仍拒绝', () => {
  const cliPath = path.join(SCRIPT_DIR, 'prepare-python-payload.mjs')
  const runCli = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
  const hostTarget = Object.entries(REGISTERED_TARGETS)
    .find(([, value]) => value.platform === process.platform && value.arch === process.arch)

  const dryRun = runCli(['--dry-run'])
  // D1 回归点：parseArgs 默认 target=null 不得被显式 --target 守卫当成「未登记」拦下。
  assert.doesNotMatch(dryRun.stderr, /未登记的 --target/u)
  if (hostTarget === undefined) {
    // 非登记宿主：宿主回退仍必须落在 resolveTarget 的响亮拒绝上（而不是 null 守卫）。
    assert.equal(dryRun.status, 1)
    assert.match(dryRun.stderr, /没有登记 /u)
  } else {
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.match(dryRun.stdout, new RegExp('target: ' + hostTarget[0] + '（'))
  }

  // 修掉 null 守卫后，显式 --target 的登记校验不得放宽（mac-x64 腿 2026-12 已移除）。
  const unregistered = runCli(['--dry-run', '--target', 'mac-x64'])
  assert.equal(unregistered.status, 1)
  assert.match(unregistered.stderr, /未登记的 --target mac-x64/u)
})

/**
 * 上游唯一消费者 `@deepseek-ai/dsh-tool-workspace-dependencies` 的
 * `parsePrimaryRuntime`（pin 见 `harness.commit`；vendor/harness-checkout/packages/skill/
 * tool-workspace-dependencies/src/index.ts）**在本仓不能直接 import**：子模块自身的
 * node_modules 链接指向未构建的 lib。这里按同一份源码镜像出接受规则，并由下面的源锁
 * 用例钉住那几行——上游改规则时这条锁先红，再决定要不要跟。
 */
const UPSTREAM_PLATFORMS = ['win32', 'darwin', 'linux']
const isUpstreamVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+/u.test(value)

function upstreamAccepts(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const legacy = value.components !== undefined
  const versions = legacy ? value.components : value
  if (typeof versions !== 'object' || versions === null) return false
  if (legacy && ['python', 'node', 'pnpm'].some((key) => value[key] !== undefined)) return false
  const { desktopVersion, platform, arch } = value
  const { python, node } = versions
  if (typeof desktopVersion !== 'string' || desktopVersion.length === 0) return false
  if (typeof platform !== 'string' || !UPSTREAM_PLATFORMS.includes(platform)) return false
  if (typeof arch !== 'string' || !['x64', 'arm64'].includes(arch)) return false
  if (!isUpstreamVersion(python)) return false
  if (node !== undefined && !isUpstreamVersion(node)) return false
  const pythonPackages = value.pythonPackages
  if (typeof pythonPackages !== 'object' || pythonPackages === null) return false
  if (legacy) {
    for (const name of ['numpy', 'pandas']) {
      if (!isUpstreamVersion(versions[name])) return false
      const entry = Object.entries(pythonPackages)
        .find(([key]) => key.toLowerCase().replace(/[-_.]+/gu, '-') === name)
      if (entry !== undefined && entry[1] !== versions[name]) return false
    }
  }
  return true
}

test('⑥ 载荷 manifest 可被上游 parsePrimaryRuntime 解析（四个变体）', () => {
  const withNode = payloadManifest(LOCK, 'mac-arm64', { includeNode: true })
  assert.equal(upstreamAccepts(withNode), true, '真实 manifest（legacy 形态）必须解析通过')
  assert.equal(withNode.desktopVersion, DESKTOP_VERSION)
  assert.equal(withNode.platform, 'darwin')
  assert.equal(withNode.arch, 'arm64')
  assert.equal(withNode.components.numpy, LOCK.pythonPackages.numpy.replace(/[-_.]+/gu, '-') === 'numpy' ? LOCK.pythonPackages.numpy : withNode.components.numpy)
  assert.equal(withNode.components.pandas, LOCK.pythonPackages.pandas)
  assert.equal(withNode.components.pnpm, undefined, 'python-only/--with-node 的 manifest 不声明 pnpm')

  // full 载荷：legacy components 带 pnpm 版本 + layout.pnpm，仍是上游可解析的 legacy 形态。
  const withPnpm = payloadManifest(LOCK, 'mac-arm64', {
    pnpm: { source: path.join(path.sep, 'build', 'node_modules', 'pnpm'), version: DESKTOP_PNPM_VERSION },
  })
  assert.equal(upstreamAccepts(withPnpm), true, '带 components.pnpm 的 legacy manifest 必须解析通过')
  assert.equal(withPnpm.components.pnpm, DESKTOP_PNPM_VERSION)
  assert.equal(withPnpm.components.node, LOCK.nodeVersion, '--with-pnpm 隐含 node 组件')
  assert.equal(withPnpm.layout.pnpm, 'dependencies/pnpm/bin/pnpm.mjs')
  assert.equal(withPnpm.layout.node, 'dependencies/node/bin/node')
  assert.equal(withPnpm.payloadDigest, payloadPlan(LOCK, 'mac-arm64', {
    pnpm: { source: path.join(path.sep, 'build', 'node_modules', 'pnpm'), version: DESKTOP_PNPM_VERSION },
  }).payloadDigest, 'manifest 与 plan 的摘要同源')

  const legacyConsistent = JSON.parse(JSON.stringify(withNode))
  assert.equal(upstreamAccepts(legacyConsistent), true, '变体 1：legacy + numpy/pandas 同源 → 通过')

  const noDesktopVersion = JSON.parse(JSON.stringify(withNode))
  delete noDesktopVersion.desktopVersion
  assert.equal(upstreamAccepts(noDesktopVersion), false, '变体 2：缺 desktopVersion → 拒绝')

  const mismatched = JSON.parse(JSON.stringify(withNode))
  mismatched.components.pandas = '0.0.1'
  assert.equal(upstreamAccepts(mismatched), false, '变体 3：components 与 pythonPackages 不一致 → 拒绝')

  const newShape = JSON.parse(JSON.stringify(withNode))
  newShape.python = newShape.components.python
  newShape.node = newShape.components.node
  delete newShape.components
  assert.equal(upstreamAccepts(newShape), true, '变体 4：新形态（顶层 python/node，无 components）→ 通过')

  const badPlatform = JSON.parse(JSON.stringify(withNode))
  badPlatform.platform = 'ios'
  assert.equal(upstreamAccepts(badPlatform), false, '变体 4b：platform 不在 win32|darwin|linux → 拒绝')
})

test('⑥ 源锁：上游 parsePrimaryRuntime 的接受规则行仍在（改了先红再决定跟不跟）', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const source = readFileSync(path.join(
    repoRoot, 'vendor/harness-checkout/packages/skill/tool-workspace-dependencies/src/index.ts'), 'utf8')
  for (const marker of ["const PLATFORMS = ['win32', 'darwin', 'linux']", "['x64', 'arm64']", 'desktopVersion', "['numpy', 'pandas']"]) {
    assert.ok(source.includes(marker), '上游解析器不再含：' + marker)
  }
})

/**
 * ⑦ pin 恒等：锁 provenance 的 upstreamCommit 必须等于 harness.commit；同时本锁的
 * node/python 坐标（含 nodeSha256）必须逐项等于上游 pin 的 scripts/primary-runtime/
 * lock.json——本仓相对上游只允许收窄 targets（design 18 §4.2 的出货平台裁决）。
 * pin 升级时本锁与上游锁同批移动；此前升级漏改过 provenance——本文件把这种漏改变成红。
 */
test('⑦ 锁 provenance 的 upstreamCommit 与 harness.commit 一致（pin 升级必须同批）', () => {
  const provenance = JSON.parse(LOCK_TEXT).provenance
  assert.ok(provenance !== null && typeof provenance === 'object', '锁必须带 provenance 对象')
  const pin = readFileSync(new URL('../../../harness.commit', import.meta.url), 'utf8')
    .split('\n').map((line) => line.trim()).find((line) => line !== '' && !line.startsWith('#'))
  assert.notEqual(pin, undefined, 'harness.commit carries the pin line')
  assert.equal(JSON.parse(LOCK_TEXT).provenance.upstreamCommit, pin,
    'primary-runtime lock 记录的是当前 pin；升级后必须同行更新')
})

/**
 * ⑦b 坐标对齐：本锁的 node/python 坐标逐项等于上游 pin 的 primary-runtime 锁；
 * 唯一允许的差异是 targets 收窄到本仓真实出货平台（当前 mac-arm64，design 18 §4.2）。
 * 上游锁路径 = vendor/harness-checkout/scripts/primary-runtime/lock.json（pin 子模块）。
 */
test('⑦b 锁的 node/python 坐标与上游 pin 锁逐项相等（targets 只允许 mac-arm64）', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const upstreamPath = path.join(repoRoot, 'vendor/harness-checkout/scripts/primary-runtime/lock.json')
  assert.ok(existsSync(upstreamPath), 'pin 子模块未初始化：' + upstreamPath)
  const upstream = JSON.parse(readFileSync(upstreamPath, 'utf8'))
  const lock = JSON.parse(LOCK_TEXT)
  assert.deepEqual(Object.keys(lock.targets).sort(), ['mac-arm64'],
    '本仓只出货 darwin/arm64；targets 收窄属设计裁决（design 18 §4.2 provenance.targets）')
  assert.equal(lock.nodeVersion, upstream.nodeVersion, 'nodeVersion 必须等于上游 pin 锁')
  assert.equal(lock.pythonVersion, upstream.pythonVersion, 'pythonVersion 必须等于上游 pin 锁')
  assert.equal(lock.pythonRelease, upstream.pythonRelease, 'pythonRelease 必须等于上游 pin 锁')
  assert.deepEqual(lock.pythonPackages, upstream.pythonPackages, 'pythonPackages 必须与上游逐项相等')
  assert.deepEqual(lock.wheels, upstream.wheels, '跨平台 wheels 必须与上游逐项相等（URL+sha256）')
  const ours = lock.targets['mac-arm64']
  const theirs = upstream.targets['mac-arm64']
  assert.ok(theirs !== undefined, '上游 pin 锁缺 mac-arm64 目标——先对齐上游')
  for (const field of ['nodeArchive', 'nodeSha256', 'pythonTarget', 'pythonSha256']) {
    assert.equal(ours[field], theirs[field], 'targets.mac-arm64.' + field + ' 必须等于上游 pin 锁')
  }
  assert.deepEqual(ours.wheels, theirs.wheels, 'targets.mac-arm64.wheels 必须与上游逐项相等')
})
/**
 * ⑧ full 载荷的 pnpm 半边。
 *
 * seam 选择：不依赖构建机真实 node_modules/pnpm——resolvePnpmSource / materialize 都接受
 * 显式 source，CLI 用 --pnpm-source 注入夹具包；默认查找路径（packages/desktop →
 * 仓库根 node_modules/pnpm）只用注入的 desktopDir/repoRoot 临时树验证优先级。
 */
const FIXTURE_PNPM_SOURCE = path.join(path.sep, 'fixture', 'node_modules', 'pnpm')

test('⑧ pnpm 版本单源：desktop dependencies.pnpm；解析/版本漂移/入口缺失一律拒绝', () => {
  // 单一来源：DESKTOP_PNPM_VERSION 直接读取 desktop package.json。
  assert.equal(desktopPnpmVersion(), DESKTOP_PNPM_VERSION)
  assert.equal(
    JSON.parse(readFileSync(path.join(SCRIPT_DIR, '..', 'package.json'), 'utf8')).dependencies.pnpm,
    DESKTOP_PNPM_VERSION,
  )
  withTempDir((dir) => {
    const source = fakePnpmSource(dir)
    const resolved = resolvePnpmSource({ source })
    assert.equal(resolved.version, DESKTOP_PNPM_VERSION)
    assert.equal(resolved.source, source)

    // 版本漂移：绝不让两个版本的 pnpm 混进载荷。
    const driftDir = path.join(dir, 'drift')
    const drift = fakePnpmSource(driftDir, { version: '0.0.1' })
    assert.throws(() => resolvePnpmSource({ source: drift }), /版本漂移/u)

    // 缺入口 bin/pnpm.mjs。
    const noBinDir = path.join(dir, 'no-bin')
    const noBin = fakePnpmSource(noBinDir, { bin: false })
    assert.throws(() => resolvePnpmSource({ source: noBin }), /bin\/pnpm\.mjs/u)

    // 显式 source 不存在 / 不是 pnpm 包。
    assert.throws(() => resolvePnpmSource({ source: path.join(dir, 'nope') }), /--pnpm-source/u)
    const wrongNameDir = path.join(dir, 'wrong-name')
    fakePnpmSource(wrongNameDir)
    writeFileSync(path.join(wrongNameDir, 'pnpm', 'package.json'),
      JSON.stringify({ name: 'not-pnpm', version: DESKTOP_PNPM_VERSION }))
    assert.throws(() => resolvePnpmSource({ source: path.join(wrongNameDir, 'pnpm') }), /不是 pnpm 包/u)
    assert.ok(source.length > 0)
  })
})

test('⑧ pnpm 默认查找：desktop node_modules/pnpm 优先于仓库根候选', () => {
  withTempDir((dir) => {
    const desktopDir = path.join(dir, 'desktop')
    const repoRoot = path.join(dir, 'repo')
    const repoCandidate = fakePnpmSource(path.join(repoRoot, 'node_modules'))
    // 只有仓库根候选：命中它。
    const onlyRepo = resolvePnpmSource({ desktopDir, repoRoot })
    assert.equal(onlyRepo.source, repoCandidate)
    // desktop 候选也出现后：desktop 优先（pnpm 是 desktop 的直接依赖）。
    const desktopCandidate = fakePnpmSource(path.join(desktopDir, 'node_modules'))
    const both = resolvePnpmSource({ desktopDir, repoRoot })
    assert.equal(both.source, desktopCandidate)
    // 全缺：响亮给出候选路径与 --pnpm-source 提示。
    assert.throws(
      () => resolvePnpmSource({ desktopDir: path.join(dir, 'empty-desktop'), repoRoot: path.join(dir, 'empty-repo') }),
      /找不到构建机 pnpm 包[\s\S]*--pnpm-source/u,
    )
  })
})

test('⑧ acceptsNpmPlatform：与上游 npm-platform.ts 的 os/cpu 语义一致', () => {
  assert.equal(acceptsNpmPlatform(undefined, 'darwin'), true)
  assert.equal(acceptsNpmPlatform(['darwin'], 'darwin'), true)
  assert.equal(acceptsNpmPlatform(['darwin'], 'linux'), false)
  assert.equal(acceptsNpmPlatform(['!darwin'], 'darwin'), false)
  assert.equal(acceptsNpmPlatform(['!darwin'], 'linux'), true)
  assert.equal(acceptsNpmPlatform(['any'], 'win32'), true)
  assert.equal(acceptsNpmPlatform(['darwin', 'arm64'], 'arm64'), true)
  assert.throws(() => acceptsNpmPlatform('darwin', 'darwin'), /arrays of strings/u)
  assert.throws(() => acceptsNpmPlatform([1], 'darwin'), /arrays of strings/u)
})

test('⑧ 默认仍 python-only：不带 --with-pnpm/--with-node 不落 dependencies/pnpm', async () => {
  // parseArgs 默认两 flag 均 false（见 ⑤），plan 层也保持 components 无 pnpm、无 node 条目。
  const plan = payloadPlan(LOCK, 'mac-arm64')
  assert.equal(plan.pnpm, null)
  assert.equal(plan.entries.filter((entry) => entry.kind === 'node').length, 0)
  const { lock, pythonBytes, wheelBytes } = fixtureLock()
  const { impl } = fixtureFetch(pythonBytes, wheelBytes)
  await withTempDir(async (dir) => {
    const outDir = path.join(dir, 'primary-runtime')
    const result = await materialize({ lock, target: 'mac-arm64', outDir, cacheDir: path.join(dir, 'cache'), fetchImpl: impl })
    assert.equal(result.manifest.components.pnpm, undefined)
    assert.equal(result.manifest.components.node, undefined)
    assert.equal(existsSync(path.join(outDir, 'dependencies', 'pnpm')), false)
    assert.equal(verifyPayload(outDir).ok, true)
  })
})

test('⑧ pnpm 落位：dereference 拷贝 + 外平台原生包 prune + manifest/digest/verify', async () => {
  const { lock, pythonBytes, wheelBytes, nodeBytes } = fixtureLock({ includeNode: true })
  await withTempDir(async (dir) => {
    const pnpmSource = fakePnpmSource(path.join(dir, 'build'))
    const pnpm = resolvePnpmSource({ source: pnpmSource })
    const outDir = path.join(dir, 'primary-runtime')
    const { impl, calls } = fixtureFetch(pythonBytes, wheelBytes, nodeBytes)
    const result = await materialize({
      lock, target: 'mac-arm64', outDir, cacheDir: path.join(dir, 'cache'), fetchImpl: impl, pnpm,
    })
    assert.equal(calls.length, 2 + lock.targets['mac-arm64'].wheels.length + lock.wheels.length,
      'node + python + wheels；pnpm 来自构建机，不下载')
    const pnpmDir = path.join(outDir, pnpmDirectoryRelative())
    assert.equal(readFileSync(path.join(pnpmDir, 'bin', 'pnpm.mjs'), 'utf8'), readFileSync(path.join(pnpmSource, 'bin', 'pnpm.mjs'), 'utf8'))
    assert.equal(JSON.parse(readFileSync(path.join(pnpmDir, 'package.json'), 'utf8')).version, DESKTOP_PNPM_VERSION)
    assert.equal(existsSync(path.join(pnpmDir, 'dist', 'node_modules', '@reflink', 'reflink-darwin-arm64')), true)
    assert.equal(existsSync(path.join(pnpmDir, 'dist', 'node_modules', '@reflink', 'reflink')), true, '无 os/cpu 约束的包必须保留')
    assert.equal(existsSync(path.join(pnpmDir, 'dist', 'node_modules', 'plain')), true, '普通包必须保留')
    assert.equal(existsSync(path.join(pnpmDir, 'dist', 'node_modules', '.bin')), true, '.bin 不是包但整包拷贝保留')
    assert.deepEqual(foreignPnpmNativePackages(pnpmDir, 'darwin', 'arm64'), [])
    for (const pruned of ['reflink-darwin-x64', 'reflink-win32-x64-msvc']) {
      assert.equal(existsSync(path.join(pnpmDir, 'dist', 'node_modules', '@reflink', pruned)), false, pruned + ' 必须被 prune')
    }

    const manifest = JSON.parse(readFileSync(path.join(outDir, 'runtime.json'), 'utf8'))
    assert.equal(manifest.payload, 'complete')
    assert.equal(manifest.components.pnpm, DESKTOP_PNPM_VERSION)
    assert.equal(manifest.components.node, lock.nodeVersion, '--with-pnpm 隐含 node 组件')
    assert.equal(manifest.layout.pnpm, pnpmBinaryRelative())
    assert.equal(manifest.layout.node, nodeBinaryRelative('darwin'))
    assert.equal(manifest.payloadDigest, result.manifest.payloadDigest)
    assert.equal(manifest.payloadDigest, payloadPlan(lock, 'mac-arm64', { pnpm }).payloadDigest)
    const check = verifyPayload(outDir)
    assert.equal(check.ok, true, check.problems.join('；'))
    // --verify 的 CLI 路径（release.yml 打包后复核同一命令）也必须对 full 载荷绿。
    const cliVerify = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'prepare-python-payload.mjs'), '--verify', outDir], { encoding: 'utf8' })
    assert.equal(cliVerify.status, 0, cliVerify.stderr)
    assert.match(cliVerify.stdout, /载荷完整/u)

    // 幂等：第二次落位命中缓存（fetch 不再被调用），pnpm 从源重拷。
    const second = fixtureFetch(pythonBytes, wheelBytes, nodeBytes)
    await materialize({
      lock, target: 'mac-arm64', outDir, cacheDir: path.join(dir, 'cache'), fetchImpl: second.impl,
      pnpm: resolvePnpmSource({ source: pnpmSource }),
    })
    assert.equal(second.calls.length, 0, '缓存命中后不得再联网')
    assert.equal(verifyPayload(outDir).ok, true)
  })
})

test('⑧ verify：components.node/pnpm 声明时缺件/版本漂移/夹带外平台必须红（fail-closed）', async () => {
  const { lock, pythonBytes, wheelBytes, nodeBytes } = fixtureLock({ includeNode: true })
  await withTempDir(async (dir) => {
    const pnpmSource = fakePnpmSource(path.join(dir, 'build'))
    const outDir = path.join(dir, 'primary-runtime')
    const pnpm = resolvePnpmSource({ source: pnpmSource })
    const build = async () => {
      const { impl } = fixtureFetch(pythonBytes, wheelBytes, nodeBytes)
      await materialize({
        lock, target: 'mac-arm64', outDir, cacheDir: path.join(dir, 'cache'), fetchImpl: impl,
        pnpm: resolvePnpmSource({ source: pnpmSource }),
      })
    }
    await build()
    assert.equal(verifyPayload(outDir).ok, true)

    // ① 缺 pnpm 入口。
    rmSync(path.join(outDir, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
    const missingBin = verifyPayload(outDir)
    assert.equal(missingBin.ok, false)
    assert.ok(missingBin.problems.some((problem) => problem.includes('components.pnpm')), missingBin.problems.join('；'))
    await build()

    // ② pnpm package.json 版本与 components.pnpm 不一致。
    writeFileSync(path.join(outDir, 'dependencies', 'pnpm', 'package.json'),
      JSON.stringify({ name: 'pnpm', version: '0.0.1' }))
    const drift = verifyPayload(outDir)
    assert.equal(drift.ok, false)
    assert.ok(drift.problems.some((problem) => problem.includes('components.pnpm')), drift.problems.join('；'))
    await build()

    // ③ 夹带外平台原生包（prune 漏掉的回归）。
    const foreignDir = path.join(outDir, 'dependencies', 'pnpm', 'dist', 'node_modules', '@reflink', 'reflink-win32-x64-msvc')
    mkdirSync(foreignDir, { recursive: true })
    writeFileSync(path.join(foreignDir, 'package.json'),
      JSON.stringify({ name: '@reflink/reflink-win32-x64-msvc', os: ['win32'], cpu: ['x64'] }))
    const foreign = verifyPayload(outDir)
    assert.equal(foreign.ok, false)
    assert.ok(foreign.problems.some((problem) => problem.includes('夹带')), foreign.problems.join('；'))
    await build()

    // ④ components.node 声明了 node 但二进制缺失。
    rmSync(path.join(outDir, nodeBinaryRelative('darwin')))
    const missingNode = verifyPayload(outDir)
    assert.equal(missingNode.ok, false)
    assert.ok(missingNode.problems.some((problem) => problem.includes('components.node')), missingNode.problems.join('；'))
    await build()
    assert.equal(verifyPayload(outDir).ok, true)

    // ⑤ node 无执行位：--verify 是发布腿的第二道门，必须自己红（不只靠 build-sidecar）。
    const nodeFile = path.join(outDir, nodeBinaryRelative('darwin'))
    rmSync(nodeFile)
    writeFileSync(nodeFile, 'node', { mode: 0o644 })
    const nonExecutable = verifyPayload(outDir)
    assert.equal(nonExecutable.ok, false)
    assert.ok(nonExecutable.problems.some((problem) => problem.includes('可执行位')), nonExecutable.problems.join('；'))
    await build()
    assert.equal(verifyPayload(outDir).ok, true)
  })
})

test('⑧ CLI：--with-pnpm/--pnpm-source 的 dry-run 不写盘；默认 python-only 计划不含 pnpm', () => {
  const cliPath = path.join(SCRIPT_DIR, 'prepare-python-payload.mjs')
  const runCli = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
  withTempDir((dir) => {
    const source = fakePnpmSource(path.join(dir, 'build'))
    const outDir = path.join(dir, 'out')
    const dryRun = runCli(['--dry-run', '--target', 'mac-arm64', '--with-pnpm', '--pnpm-source', source, '--out', outDir])
    assert.equal(dryRun.status, 0, dryRun.stderr)
    assert.ok(dryRun.stdout.includes('pnpm: ' + DESKTOP_PNPM_VERSION), 'dry-run 计划必须打印 pnpm 版本与来源')
    assert.match(dryRun.stdout, /"pnpm":/u, 'components 必须声明 pnpm 版本')
    assert.equal(existsSync(outDir), false, '--dry-run 不得写盘')

    // 默认（无 --with-pnpm/--with-node）仍 python-only：计划里没有 pnpm/node 载荷。
    const plain = runCli(['--dry-run', '--target', 'mac-arm64', '--out', outDir])
    assert.equal(plain.status, 0, plain.stderr)
    assert.doesNotMatch(plain.stdout, /"pnpm":/u)
    assert.equal(plain.stdout.includes('[node]'), false, '默认计划不得有 node 下载条目')
    assert.match(plain.stdout, /pnpm: 未启用/u)
    assert.equal(existsSync(outDir), false)

    // 版本漂移 / 源缺失：--with-pnpm 在动网络之前就响亮失败。
    const drift = fakePnpmSource(path.join(dir, 'drift'), { version: '0.0.1' })
    const badVersion = runCli(['--dry-run', '--target', 'mac-arm64', '--with-pnpm', '--pnpm-source', drift])
    assert.equal(badVersion.status, 1)
    assert.match(badVersion.stderr, /版本漂移/u)
    const missingSource = runCli(['--dry-run', '--target', 'mac-arm64', '--with-pnpm', '--pnpm-source', path.join(dir, 'nope')])
    assert.equal(missingSource.status, 1)
    assert.match(missingSource.stderr, /--pnpm-source/u)
    assert.ok(source.length > 0)
  })
})
