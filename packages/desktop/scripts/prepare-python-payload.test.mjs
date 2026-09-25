/**
 * prepare-python-payload.test.mjs —— python 载荷 machinery 的行为与纪律用例（C5）。
 *
 * 覆盖五件事：
 *  ① 锁是唯一版本/摘要来源：结构校验、未出货目标拒绝、与 build-sidecar 的
 *     PINNED_NODE_SHA256 锁步、脚本里不得出现写死的 64 位摘要；
 *  ② 最小解包器（tar.gz / zip，node 内置）在真实布局（符号链接、权限位、
 *     dist-info）上工作，并在越出载荷根 / CRC 不符 / 未知安装 scheme 时拒绝；
 *  ③ --dry-run 的离线保证：零 fetch、零写盘；真实路径的落位布局 + runtime.json +
 *     自检（site-packages 里每个锁定发行版都必须精确命中同名同版本的 dist-info；
 *     缺 pythonPackages 元数据直接判不完整）；
 *  ④ 「改锁没改校验就红」：翻改锁里的一个 sha256 后，同一份字节必须被拒
 *     （下载侧与缓存复用侧各一条）；
 *  ⑤ CLI（main 级）：不带 --target 时按宿主解析目标（不得被显式 --target 守卫误拦，
 *     D1），显式未登记 target 仍要响亮拒绝。
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
  LOCK_PATH,
  PAYLOAD_FORMAT,
  REGISTERED_TARGETS,
  assertLock,
  crc32,
  extractTarGz,
  extractWheel,
  fetchVerifiedArchive,
  formatPlan,
  materialize,
  nodeArchiveName,
  parseArgs,
  parseLock,
  payloadPlan,
  pythonArchiveName,
  pythonArchiveUrl,
  resolveTarget,
  safeEntryPath,
  sha256Hex,
  verifyPayload,
} from './prepare-python-payload.mjs'
import { DEFAULT_NODE_VERSION, PINNED_NODE_SHA256, nodeArchiveName as sidecarNodeArchiveName } from './build-sidecar.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_SOURCE = readFileSync(path.join(SCRIPT_DIR, 'prepare-python-payload.mjs'), 'utf8')
const LOCK_TEXT = readFileSync(LOCK_PATH, 'utf8')
const LOCK = parseLock(LOCK_TEXT, LOCK_PATH)

/** 临时工作目录（每个用例自建，结束即删）。 */
function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-python-payload-test-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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

/** 以真实锁为骨架、把摘要换成本用例夹具摘要的锁（URL 清单不变）。 */
function fixtureLock() {
  const lock = JSON.parse(LOCK_TEXT)
  const pythonBytes = fakePythonArchive()
  const wheelBytes = new Map()
  const digestOf = (bytes) => sha256Hex(bytes)
  for (const artifact of Object.values(lock.targets)) {
    artifact.pythonSha256 = digestOf(pythonBytes)
    for (const wheel of artifact.wheels) {
      wheelBytes.set(wheel.url, fakeWheel(wheel.url))
      wheel.sha256 = digestOf(wheelBytes.get(wheel.url))
    }
  }
  for (const wheel of lock.wheels) {
    wheelBytes.set(wheel.url, fakeWheel(wheel.url))
    wheel.sha256 = digestOf(wheelBytes.get(wheel.url))
  }
  return { lock, pythonBytes, wheelBytes }
}

/** 只认夹具 URL 的 fetch 替身（计调用次数，便于断言 dry-run 零联网）。 */
function fixtureFetch(pythonBytes, wheelBytes) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    const bytes = url.includes('cpython-') ? pythonBytes : wheelBytes.get(url)
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

test('① 计划：条目来自锁，node 可选且与 build-sidecar 表锁步', () => {
  const plan = payloadPlan(LOCK, 'mac-arm64')
  assert.equal(plan.format, PAYLOAD_FORMAT)
  assert.equal(plan.entries.length, 1 + LOCK.targets['mac-arm64'].wheels.length + LOCK.wheels.length)
  assert.equal(plan.pythonBinary, 'dependencies/python/bin/python3')
  assert.equal(plan.sitePackages, 'dependencies/python/lib/python3.12/site-packages')
  assert.ok(plan.entries.every((entry) => /^[0-9a-f]{64}$/u.test(entry.sha256)))
  assert.equal(plan.entries.filter((entry) => entry.kind === 'node').length, 0)

  const withNode = payloadPlan(LOCK, 'mac-arm64', { includeNode: true })
  const nodeEntry = withNode.entries.find((entry) => entry.kind === 'node')
  assert.ok(nodeEntry !== undefined)
  assert.equal(nodeEntry.sha256, LOCK.targets['mac-arm64'].nodeSha256)

  for (const [target, arch] of [['mac-arm64', 'arm64']]) {
    const name = nodeArchiveName(LOCK, target)
    assert.equal(name, sidecarNodeArchiveName(DEFAULT_NODE_VERSION, arch), 'node 归档名必须与 build-sidecar 同式')
    assert.equal(LOCK.nodeVersion, DEFAULT_NODE_VERSION, '锁的 nodeVersion 必须等于 build-sidecar 的默认 pin')
    assert.equal(LOCK.targets[target].nodeSha256, PINNED_NODE_SHA256[name], 'node 摘要必须与 PINNED_NODE_SHA256 锁步')
  }
  const digest = payloadPlan(LOCK, 'mac-arm64').payloadDigest
  assert.match(digest, /^[0-9a-f]{64}$/u)
  assert.equal(digest, payloadPlan(LOCK, 'mac-arm64', { includeNode: true }).payloadDigest,
    '载荷身份只覆盖 python/wheel（node 由 build-sidecar 另行捆绑，不参与 python 身份）')
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

    // 缺 pythonPackages 键 / 空对象：无法核对 = 不完整，不得整段跳过。
    const missing = verifyPayload(buildPayload('missing-packages', manifestOf(undefined)))
    assert.equal(missing.ok, false, '缺 pythonPackages 不得凭空通过')
    assert.ok(missing.problems.some((problem) => problem.includes('pythonPackages')), missing.problems.join('；'))
    const empty = verifyPayload(buildPayload('empty-packages', manifestOf({})))
    assert.equal(empty.ok, false, '空 pythonPackages 不得凭空通过')
    assert.ok(empty.problems.some((problem) => problem.includes('pythonPackages')), empty.problems.join('；'))
  })
})

test('⑤ CLI 参数：未知参数拒绝，--dry-run/--target/--verify 解析', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/u)
  assert.throws(() => parseArgs(['--target']), /缺少取值/u)
  const options = parseArgs(['--dry-run', '--target', 'mac-arm64'])
  assert.equal(options.dryRun, true)
  assert.equal(options.target, 'mac-arm64')
  assert.equal(parseArgs(['--verify', '/x']).verifyDir, path.resolve('/x'))
  assert.equal(parseArgs([]).outDir, null)
  assert.equal(DEFAULT_OUT_DIR.endsWith(path.join('resources', 'primary-runtime')), true)
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
