/**
 * build-sidecar.test.mjs —— W-23 sidecar 打包脚本单测（design 25 §3.2/§4.3）
 *
 * 覆盖：
 *  ① 参数解析与布局（缺省 out、各开关、未知参数 loud）；
 *  ② 计划文本（--skip-node/--skip-bundle 的步骤差异）；
 *  ③ Node 归档命名/URL/成员路径 + SHASUMS256.txt 解析；
 *  ③b 摘要固定（PINNED_NODE_SHA256）：默认版本两架构全覆盖、pin/override/冲突/
 *     未固定四种判定（纯函数，不联网）；
 *  ③c Electron pin → 内置 node 的固定表（G37：无 Electron 二进制也无条件断言，
 *     漂移臂 loud）与 vendor/dsh 版本 + 平台装配断言（G39，拷贝前 fail-closed）；
 *  ④ SHA-256 流式计算与不匹配检测；
 *  ⑤ **A5 断言**：捆绑 Node 基名必须叫 node——正例通过、反例 loud；
 *     并实证 resolveNodeExecutable 的纯 Node 分支前提（basename(execPath) ==
 *     'node' → 直用 execPath；其他基名 → 回落，不直用）；
 *  ⑥ --dry-run 真实子进程：输入校验通过、不写盘、不联网（exit 0）；
 *  ⑦ normalizeSymlinks：树内绝对链接→相对、树外链接→实体化、悬空→loud、
 *     幂等（P2：cpSync 会把相对链接绝对化，bundle 因此过不了 codesign）；
 *  ⑧ copyTree：cpSync(verbatimSymlinks) 只搬链接，实体化全部交给 normalizeSymlinks；
 *  ⑨b --skip-* 的诚实语义：跳过 = 缺位，不继承上一轮装配；
 *  ⑨c 历史 tsc emit 目录（dist/sidecar）被清掉，不再被 electron-builder 打包。
 * 不联网、不下载 Node、不写仓库外路径（dry-run 无副作用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_NODE_VERSION,
  ELECTRON_NODE_PINS,
  ELECTRON_PINNED_VERSION,
  HOST_PACKAGES,
  PINNED_NODE_SHA256,
  PNPM_PINNED_VERSION,
  assertBundledNodeBasename,
  assertElectronNodePin,
  assertHostPackageArtifacts,
  assertNodeArchiveMembers,
  assertNodePinTable,
  clearLegacySidecarEmit,
  copyPnpm,
  copyTree,
  normalizeSymlinks,
  copyVendorDsh,
  buildPlan,
  nodeArchiveName,
  nodeDistUrl,
  nodeMemberPath,
  parseBuildSidecarArgs,
  parseShasums,
  resolveElectronPin,
  resolvePinnedNodeDigest,
  resolvePnpmPin,
  runBuildSidecar,
  sha256File,
  verifySha256,
  verifyVendorDshRuntime,
  sidecarLayout,
} from './build-sidecar.mjs'
import { platformExecutableName, resolveElectronPackageDir, sharedDistDirFor } from './electron-shared.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const script = path.join(here, 'build-sidecar.mjs')

/**
 * Host-derived default arch (G5): parseBuildSidecarArgs mirrors the machine
 * (x64 host → x64 archive, everything else → arm64 DEFAULT_ARCH) exactly like
 * build-sidecar.mjs:388. The tests used to hardcode arm64, so an x64 Mac read
 * as a false red.
 */
const HOST_ARCH = process.arch === 'x64' ? 'x64' : 'arm64'

/** vendor/dsh 的平台前缀（G39 断言读它；实际形如 darwin-arm64）。 */
const HOST_PLATFORM = `${process.platform}-${HOST_ARCH}`

/** The desktop manifest — single source for the pnpm pin asserted below. */
const DESKTOP_MANIFEST = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))

test('① 参数解析：缺省值、开关与错误', () => {
  const defaults = parseBuildSidecarArgs([])
  assert.equal(defaults.outDir, path.join(desktopDir, 'release', 'sidecar'))
  assert.equal(defaults.dryRun, false)
  assert.equal(defaults.skipNode, false)
  assert.equal(defaults.nodeVersion, DEFAULT_NODE_VERSION)
  // G5: the default arch follows the HOST (x64 → x64), not a hardcoded arm64.
  assert.equal(defaults.arch, HOST_ARCH)
  assert.equal(defaults.nodeSha256, null)

  const parsed = parseBuildSidecarArgs([
    '--out', '/tmp/x', '--dry-run', '--skip-node', '--skip-bundle',
    '--node-version', '24.9.0', '--node-sha256', 'AB'.repeat(32), '--arch', 'x64',
  ])
  assert.equal(parsed.outDir, '/tmp/x')
  assert.equal(parsed.dryRun, true)
  assert.equal(parsed.skipNode, true)
  assert.equal(parsed.skipBundle, true)
  assert.equal(parsed.nodeVersion, '24.9.0')
  assert.equal(parsed.nodeSha256, 'ab'.repeat(32), 'sha256 归一化为小写')
  assert.equal(parsed.arch, 'x64')
  // Negative arm: --arch is a whitelist (D8) — an explicit bad value must fail
  // loudly rather than flow into the archive name and the lipo assertion.
  assert.throws(() => parseBuildSidecarArgs(['--arch', 'ia32']), /--arch 只接受 arm64\|x64/)
  assert.equal(parseBuildSidecarArgs(['--arch', 'arm64']).arch, 'arm64')
  assert.equal(parseBuildSidecarArgs(['--arch', 'x64']).arch, 'x64')
  assert.throws(() => parseBuildSidecarArgs(['--nope']), /未知参数/)
  assert.throws(() => parseBuildSidecarArgs(['--out']), /缺少取值/)
})

test('① 布局：node / sidecar.js / package.json / dist/control-plane / host 包', () => {
  const layout = sidecarLayout('/tmp/out')
  assert.equal(layout.outDir, '/tmp/out')
  assert.equal(layout.node, '/tmp/out/node')
  assert.equal(layout.entry, '/tmp/out/sidecar.js')
  assert.equal(layout.packageJson, '/tmp/out/package.json')
  assert.equal(layout.dist, '/tmp/out/dist')
  assert.equal(layout.controlPlaneDist, '/tmp/out/dist/control-plane')
  assert.equal(layout.controlPlaneEntry, '/tmp/out/dist/control-plane/index.js')
  assert.equal(layout.hostPackageDist('dsh-chamber-seed-client-graph'), '/tmp/out/dist/dsh-chamber-seed-client-graph')
})

test('② 计划文本反映开关', () => {
  const base = parseBuildSidecarArgs([])
  const full = buildPlan(base).join('\n')
  assert.match(full, /esbuild 打包 sidecar-entry\.ts/)
  // G5: the plan URL carries the host-derived arch, never a hardcoded arm64.
  assert.match(
    full,
    new RegExp('Node 捆绑：https://nodejs\\.org/dist/v' + DEFAULT_NODE_VERSION.replace(/\./g, '\\.')
      + '/node-v' + DEFAULT_NODE_VERSION.replace(/\./g, '\\.') + '-darwin-' + HOST_ARCH + '\\.tar\\.gz'),
  )
  assert.match(full, /写装配 package\.json/)

  const skipped = buildPlan(parseBuildSidecarArgs(['--skip-node', '--skip-bundle'])).join('\n')
  assert.match(skipped, /跳过 esbuild 打包/)
  assert.match(skipped, /跳过 Node 捆绑/)
  assert.doesNotMatch(skipped, /nodejs\.org/)

  const offline = buildPlan(parseBuildSidecarArgs(['--node-archive', '/tmp/node.tar.gz'])).join('\n')
  assert.match(offline, /本地 \/tmp\/node\.tar\.gz/)
})

test('③ Node 归档命名/URL/成员路径与 SHASUMS 解析', () => {
  assert.equal(nodeArchiveName('24.18.1', 'arm64'), 'node-v24.18.1-darwin-arm64.tar.gz')
  assert.equal(
    nodeDistUrl('24.18.1', 'node-v24.18.1-darwin-arm64.tar.gz'),
    'https://nodejs.org/dist/v24.18.1/node-v24.18.1-darwin-arm64.tar.gz',
  )
  assert.equal(nodeMemberPath('24.18.1', 'arm64'), 'node-v24.18.1-darwin-arm64/bin/node')

  const shasums = [
    'aaaa'.repeat(16) + '  node-v24.18.1-linux-x64.tar.gz',
    'bbbb'.repeat(16) + '  node-v24.18.1-darwin-arm64.tar.gz',
    'cccc'.repeat(16) + ' *node-v24.18.1-darwin-x64.tar.gz',
    'DDDD'.repeat(16) + '  node-v24.18.1-darwin-uppercase.tar.gz',
    '',
  ].join('\n')
  assert.equal(parseShasums(shasums, 'node-v24.18.1-darwin-arm64.tar.gz'), 'bbbb'.repeat(16))
  assert.equal(parseShasums(shasums, 'node-v24.18.1-darwin-x64.tar.gz'), 'cccc'.repeat(16))
  assert.equal(parseShasums(shasums, 'missing.tar.gz'), null)
  assert.equal(
    parseShasums(shasums, 'node-v24.18.1-darwin-uppercase.tar.gz'), null,
    '非小写 hex 不是合法 sha256（真实 SHASUMS256.txt 恒小写）')
  assert.equal(parseShasums('garbage', 'node-v24.18.1-darwin-arm64.tar.gz'), null)
})

test('③b Node 归档摘要固定在仓库：默认版本两架构全覆盖 + 覆盖/冲突语义', () => {
  // 固定表：默认版本的两个 darwin 归档都必须在表内、都是小写 64-hex——升级
  // DEFAULT_NODE_VERSION 时本门禁先红（摘要必须与官方 SHASUMS256.txt 同步）。
  for (const arch of ['arm64', 'x64']) {
    const name = nodeArchiveName(DEFAULT_NODE_VERSION, arch)
    assert.ok(Object.prototype.hasOwnProperty.call(PINNED_NODE_SHA256, name),
      `默认 Node 版本 ${DEFAULT_NODE_VERSION} 的 ${arch} 归档必须钉进 PINNED_NODE_SHA256`)
    assert.match(PINNED_NODE_SHA256[name], /^[0-9a-f]{64}$/,
      `${name} 的固定摘要必须是小写 64 位 hex`)
  }

  const arm = nodeArchiveName(DEFAULT_NODE_VERSION, 'arm64')

  // 未传 --node-sha256：用仓库固定值，来源标记 pinned（调用方据此不读网络摘要）。
  assert.deepEqual(resolvePinnedNodeDigest(arm, null),
    { digest: PINNED_NODE_SHA256[arm], source: 'pinned' })

  // 显式传入且与固定值一致：走 override（同样不读网络摘要）。
  assert.deepEqual(resolvePinnedNodeDigest(arm, PINNED_NODE_SHA256[arm]),
    { digest: PINNED_NODE_SHA256[arm], source: 'override' })

  // 显式传入却与固定值冲突：loud 拒绝（同一版本的官方归档内容不可变，只可能是
  // 固定值写错或包被替换——绝不静默采纳）。
  assert.throws(() => resolvePinnedNodeDigest(arm, 'f'.repeat(64)),
    /与仓库固定摘要不一致/)

  // 未固定的版本（--node-version 升级但表未更新）：digest=null ⇒ 调用方回退
  // SHASUMS256.txt 并响亮说明，绝不把「没固定」当「已校验」。
  assert.deepEqual(resolvePinnedNodeDigest(nodeArchiveName('24.9.0', 'arm64'), null),
    { digest: null, source: 'network' })
  assert.deepEqual(resolvePinnedNodeDigest(nodeArchiveName('24.9.0', 'arm64'), 'a'.repeat(64)),
    { digest: 'a'.repeat(64), source: 'override' }, '未固定版本允许显式摘要')

  // 注入表：判定完全由传入的表决定（测试与未来多版本表可替换来源）。
  assert.deepEqual(resolvePinnedNodeDigest('x.tar.gz', null, { 'x.tar.gz': 'b'.repeat(64) }),
    { digest: 'b'.repeat(64), source: 'pinned' })

  // G18: 表 ↔ DEFAULT_NODE_VERSION 的锁步现在是构建期断言（runBuildSidecar 在
  // 动网络之前调用），不是注释——多留旧版本行、少一个 arch、摘要写错都 loud。
  assert.deepEqual(assertNodePinTable(), [...Object.keys(PINNED_NODE_SHA256)].sort())
  assert.throws(
    () => assertNodePinTable({ ...PINNED_NODE_SHA256, 'node-v24.9.0-darwin-arm64.tar.gz': 'a'.repeat(64) }),
    /非默认版本条目/,
  )
  assert.throws(
    () => assertNodePinTable({ ...PINNED_NODE_SHA256, [nodeArchiveName(DEFAULT_NODE_VERSION, 'x64')]: 'A'.repeat(64) }),
    /小写 64 位 hex/,
  )
  const missingArm = { ...PINNED_NODE_SHA256 }
  delete missingArm[nodeArchiveName(DEFAULT_NODE_VERSION, 'arm64')]
  assert.throws(() => assertNodePinTable(missingArm), /缺少默认归档/)
  // 注入版本同样成立（版本与两个 arch 摘要一起给才通过）。
  assert.deepEqual(
    assertNodePinTable({
      'node-v1.2.3-darwin-arm64.tar.gz': 'a'.repeat(64),
      'node-v1.2.3-darwin-x64.tar.gz': 'b'.repeat(64),
    }, '1.2.3'),
    ['node-v1.2.3-darwin-arm64.tar.gz', 'node-v1.2.3-darwin-x64.tar.gz'],
  )
})

test('③e 内嵌 pnpm 版本 pin：单源 desktop dependencies.pnpm + 构建期 fail-closed（G18）', () => {
  // 单一来源：desktop manifest 的 dependencies.pnpm；Electron 侧 after-pack 的
  // 运行时校验读同一来源（after-pack-adhoc-sign.test.mjs 断言跨模块相等）。
  assert.match(PNPM_PINNED_VERSION, /^\d+\.\d+\.\d+/)
  assert.equal(resolvePnpmPin({ dependencies: { pnpm: '9.9.9' } }), '9.9.9')
  assert.throws(() => resolvePnpmPin({ dependencies: {} }), /缺少 dependencies\.pnpm/)
  assert.throws(() => resolvePnpmPin({}), /缺少 dependencies\.pnpm/)

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-pnpm-pin-'))
  try {
    const src = path.join(dir, 'pnpm-src')
    mkdirSync(path.join(src, 'bin'), { recursive: true })
    writeFileSync(path.join(src, 'bin', 'pnpm.cjs'), '// pnpm')
    // 版本漂移 → loud，且不落盘（dest 不存在）。
    writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'pnpm', version: '0.0.1-drift' }))
    const dest = path.join(dir, 'out', 'pnpm')
    assert.throws(() => copyPnpm(src, dest), /内嵌 pnpm 版本漂移/)
    assert.equal(existsSync(dest), false, '版本不符时不得产出半成品')
    // 名字不对 → loud。
    writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'not-pnpm', version: PNPM_PINNED_VERSION }))
    assert.throws(() => copyPnpm(src, dest), /不是 pnpm 包/)
    // pin 匹配 → 正常拷贝。
    writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'pnpm', version: PNPM_PINNED_VERSION }))
    assert.equal(copyPnpm(src, dest), true)
    const copied = JSON.parse(readFileSync(path.join(dest, 'package.json'), 'utf8'))
    assert.equal(copied.version, PNPM_PINNED_VERSION)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④ sha256File 流式摘要 + verifySha256 真值/不匹配', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-sha-'))
  try {
    const file = path.join(dir, 'payload.bin')
    writeFileSync(file, 'dsh-chamber')
    // 真值 = sha256("dsh-chamber")（勿手写假摘要——2026-09 审计：旧测试的
    // 假期望值让「任何 64 位 hex 都通过」，校验回归不可见）。
    const real = '857528dee81128d5a6156b79a167c06a91b36e9c28fcf7be286210b6d7c7d6cf'
    assert.equal(await sha256File(file), real)
    assert.equal(await verifySha256(file, real), real)
    await assert.rejects(
      verifySha256(file, 'f'.repeat(64)),
      /SHA-256 不匹配/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('④b A5 归档成员断言：合成 tar 三例 + stdout 注入', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-a5-'))
  try {
    const member = 'node-v24.18.1-darwin-arm64/bin/node'
    const makeArchive = (name, entries) => {
      const root = path.join(dir, name)
      for (const entry of entries) {
        const full = path.join(root, entry)
        mkdirSync(path.dirname(full), { recursive: true })
        writeFileSync(full, 'fake')
      }
      const archive = path.join(dir, `${name}.tgz`)
      execFileSync('tar', ['-czf', archive, '-C', root, 'node-v24.18.1-darwin-arm64'])
      return archive
    }
    const good = makeArchive('good', [member])
    assert.deepEqual(assertNodeArchiveMembers(good, member).length > 0, true)

    const badName = makeArchive('badname', ['node-v24.18.1-darwin-arm64/bin/node-v24.18.1'])
    assert.throws(() => assertNodeArchiveMembers(badName, member), /缺少成员/)

    const missing = makeArchive('missing', ['node-v24.18.1-darwin-arm64/lib/x'])
    assert.throws(() => assertNodeArchiveMembers(missing, member), /缺少成员/)

    // tar 不可用/非归档 → 响亮失败（fail-closed）
    const notArchive = path.join(dir, 'not.tgz')
    writeFileSync(notArchive, 'not a tar')
    assert.throws(() => assertNodeArchiveMembers(notArchive, member), /无法列出 Node 归档成员/)

    // 纯 stdout 注入路径（不依赖真实 tar）：成员存在 → 通过；不存在 → loud。
    assert.deepEqual(assertNodeArchiveMembers('unused', member, `${member}\nother\n`), [member, 'other'])
    assert.throws(
      () => assertNodeArchiveMembers('unused', member, 'node-v24.18.1-darwin-arm64/bin/node-v24.18.1\n'),
      /缺少成员/,
      'member 不在 stdout 时应报缺少成员',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③c dry-run 真校验输入源（显式缺失即抛 / 默认缺失 warn）且不写盘', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-dry-'))
  try {
    const out = path.join(dir, 'out')
    // 正常 dry-run（源齐备）→ 计划可生成
    const plan = buildPlan(parseBuildSidecarArgs(['--dry-run', '--out', out])).join('\n')
    assert.match(plan, /\[4\] Node 捆绑/)
    assert.equal(existsSync(out), false, 'dry-run 不得创建输出目录')
    // 缺 --node-archive 源 → 抛（原实现静默"校验通过"）
    await assert.rejects(
      runDryRun(['--dry-run', '--out', out, '--node-archive', path.join(dir, 'missing.tgz')]),
      /--node-archive 不存在/,
    )
    // **显式**传入的 vendor 源缺失 → 抛（调用方路径写错）
    await assert.rejects(
      runDryRun(['--dry-run', '--out', out, '--vendor-dsh', path.join(dir, 'no-vendor')]),
      /--vendor-dsh 源不存在/,
    )
    // 默认源缺失 → 只 warn（干净 checkout 的正常形态；2026-09 二轮：严格校验
    // 会让 push CI 必红，因为 vendor/dsh 由 release 腿的 bundle:dsh 物化）。
    // 直接改 options 的默认源路径（保持 Explicit=false）来模拟干净 checkout。
    const warnings = []
    const cleanOptions = parseBuildSidecarArgs(['--dry-run', '--out', out])
    cleanOptions.vendorDshDir = path.join(dir, 'no-vendor')
    cleanOptions.pnpmDir = path.join(dir, 'no-pnpm')
    await runBuildSidecar(cleanOptions, {
      log() {},
      warn(message) { warnings.push(message) },
      error() {},
    })
    assert.ok(warnings.some(w => /未找到内置 dsh 工作区/.test(w)), '默认 vendor 源缺失应 warn')
    assert.ok(warnings.some(w => /未找到 pnpm/.test(w)), '默认 pnpm 源缺失应 warn')
    assert.equal(existsSync(out), false, 'dry-run 不得写盘')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('③d vendor/dsh + pnpm 拷贝（Electron extraResources 同款过滤器）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-vendor-'))
  try {
    // vendor/dsh：清单三件 + node_modules；dest 预置脏文件必须被清掉
    const vendorSrc = path.join(dir, 'vendor-src')
    mkdirSync(path.join(vendorSrc, 'node_modules', 'x'), { recursive: true })
    mkdirSync(path.join(vendorSrc, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    // G39：真实 vendor 树必须让 verifyVendorDshRuntime 过关——runtime manifest
    // 记录的版本 == 包内 dsh 的 version，dsh.platform 以宿主前缀开头；否则拷贝
    // 在任何写盘之前就 fail closed（这里同时是非漂移正例）。
    writeFileSync(path.join(vendorSrc, 'package.json'), JSON.stringify({
      name: 'dsh',
      dependencies: { '@deepseek-ai/dsh': '0.2.0' },
      dsh: { platform: HOST_PLATFORM },
    }))
    writeFileSync(path.join(vendorSrc, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }))
    writeFileSync(path.join(vendorSrc, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    writeFileSync(path.join(vendorSrc, 'pnpm-workspace.yaml'), 'packages: []')
    writeFileSync(path.join(vendorSrc, 'node_modules', 'x', 'index.js'), 'module.exports=1')
    writeFileSync(path.join(vendorSrc, 'README.md'), 'must not be copied')
    const vendorDest = path.join(dir, 'out', 'vendor', 'dsh')
    mkdirSync(vendorDest, { recursive: true })
    writeFileSync(path.join(vendorDest, 'stale.txt'), 'stale')
    assert.equal(copyVendorDsh(vendorSrc, vendorDest), true)
    assert.ok(existsSync(path.join(vendorDest, 'package.json')))
    assert.ok(existsSync(path.join(vendorDest, 'pnpm-lock.yaml')))
    assert.ok(existsSync(path.join(vendorDest, 'node_modules', 'x', 'index.js')))
    assert.ok(!existsSync(path.join(vendorDest, 'README.md')), '未列入过滤器的文件不得拷入')
    assert.ok(!existsSync(path.join(vendorDest, 'stale.txt')), '目标目录应先清空')

    // pnpm：package.json + bin/pnpm.{cjs,mjs} + dist；多余文件不拷
    const pnpmSrc = path.join(dir, 'pnpm-src')
    mkdirSync(path.join(pnpmSrc, 'bin'), { recursive: true })
    mkdirSync(path.join(pnpmSrc, 'dist'), { recursive: true })
    // 版本必须是仓库 pin（G18 fail-closed）——写别的版本 copyPnpm 会抛。
    writeFileSync(path.join(pnpmSrc, 'package.json'), JSON.stringify({ name: 'pnpm', version: PNPM_PINNED_VERSION }))
    writeFileSync(path.join(pnpmSrc, 'bin', 'pnpm.cjs'), '// pnpm')
    writeFileSync(path.join(pnpmSrc, 'bin', 'pnpm.mjs'), '// pnpm mjs')
    writeFileSync(path.join(pnpmSrc, 'bin', 'pnpx.cjs'), '// pnpx must not copy')
    writeFileSync(path.join(pnpmSrc, 'dist', 'pnpm.js'), '// dist')
    const pnpmDest = path.join(dir, 'out', 'pnpm')
    assert.equal(copyPnpm(pnpmSrc, pnpmDest), true)
    assert.ok(existsSync(path.join(pnpmDest, 'bin', 'pnpm.cjs')))
    assert.ok(existsSync(path.join(pnpmDest, 'bin', 'pnpm.mjs')))
    assert.ok(existsSync(path.join(pnpmDest, 'dist', 'pnpm.js')))
    assert.ok(!existsSync(path.join(pnpmDest, 'bin', 'pnpx.cjs')), 'pnpx 不在过滤器内')

    // 缺源 → false（调用方 warn；不抛）
    assert.equal(copyVendorDsh(path.join(dir, 'nope'), path.join(dir, 'out2')), false)
    assert.equal(copyPnpm(path.join(dir, 'nope'), path.join(dir, 'out3')), false)

    // 计划包含 3d/3e 与 --skip-vendor 分支
    const plan = buildPlan(parseBuildSidecarArgs(['--dry-run'])).join('\n')
    assert.match(plan, /\[3d\] 拷贝内置 dsh 工作区/)
    assert.match(plan, /\[3e\] 拷贝内嵌 pnpm/)
    const skipped = buildPlan(parseBuildSidecarArgs(['--dry-run', '--skip-vendor'])).join('\n')
    assert.match(skipped, /\[3d\] 跳过 vendor\/dsh \+ pnpm 拷贝/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ A5：捆绑 Node 基名断言（正例通过、反例 loud）', () => {
  assert.doesNotThrow(() => assertBundledNodeBasename('/tmp/sidecar/node'))
  assert.throws(
    () => assertBundledNodeBasename('/tmp/sidecar/node-v24.18.1'),
    /基名必须是 'node'/,
  )
  assert.throws(() => assertBundledNodeBasename('/tmp/sidecar/dsh-chamber'), /A5/)
})

test('⑤ A5 实证：resolveNodeExecutable 纯 Node 分支以 basename 为唯一前提', () => {
  const scriptBody = `
    Object.defineProperty(process, 'execPath', { value: process.argv[1], configurable: true });
    const { resolveNodeExecutable } = await import('@dsh-chamber/control-plane');
    console.log(JSON.stringify(resolveNodeExecutable()));
  `
  const run = (fakeExecPath) => JSON.parse(execFileSync(
    process.execPath,
    ['--input-type=module', '-e', scriptBody, fakeExecPath],
    { cwd: desktopDir, encoding: 'utf8' },
  ).trim())

  // 正例：基名 node → 直用 execPath、零额外 args/env（捆绑命名 node 的零改动前提）。
  const direct = run('/tmp/assembled-sidecar/node')
  assert.deepEqual(direct, { file: '/tmp/assembled-sidecar/node', args: [], env: {} })
  // 反例：其他基名 → 绝不直用（回落 PATH/known locations，系统 node 版本不可控）。
  const fallback = run('/tmp/assembled-sidecar/dsh-chamber')
  assert.notEqual(fallback.file, '/tmp/assembled-sidecar/dsh-chamber')
})

test('⑥ 真实装配（--skip-node）：sidecar.js / package.json / control-plane / host 包', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-build-'))
  try {
    // --skip-vendor: vendor/dsh 在干净 checkout 是 release-only 产物；缺源现在
    // fail closed（G6），所以本用例显式表达「不要 vendor」。
    await runBuildSidecar(parseBuildSidecarArgs(['--out', out, '--skip-node', '--skip-vendor']), {
      log: () => {},
      error: () => {},
    })
    const layout = sidecarLayout(out)
    assert.ok(existsSync(layout.entry), 'sidecar.js 应产出')
    assert.ok(existsSync(layout.controlPlaneEntry), 'control-plane 编译产物应拷贝')
    const pkg = JSON.parse(readFileSync(layout.packageJson, 'utf8'))
    assert.equal(pkg.type, 'module')
    assert.equal(typeof pkg.version, 'string')
    for (const host of HOST_PACKAGES) {
      const target = layout.hostPackageDist(host.name)
      assert.ok(existsSync(path.join(target, 'package.json')), `${host.name}/package.json 应拷贝`)
      assert.ok(existsSync(path.join(target, 'dist', 'index.js')), `${host.name}/dist/index.js 应拷贝`)
    }
    // bundle 内不得残留 runtime 裸说明符（control-plane 经 facade 的相对入口）。
    const bundle = readFileSync(layout.entry, 'utf8')
    const bareUses = bundle.split('\n').filter((line) => line.includes("from '@dsh-chamber/control-plane'"))
    assert.deepEqual(bareUses, [], '打包产物不应含裸 control-plane 静态 import')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑥ --dry-run 子进程：输入校验通过、无写盘、无联网', async () => {  const out = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-dry-'))
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, '--dry-run', '--out', path.join(out, 'assembled')],
      { cwd: desktopDir, encoding: 'utf8' },
    )
    assert.match(stdout, /dry-run：输入校验通过，未写盘、未联网/)
    // 无写盘：目标目录不存在。
    const result = await runBuildSidecar(
      parseBuildSidecarArgs(['--dry-run', '--out', path.join(out, 'assembled')]),
      { log: () => {}, error: () => {} },
    )
    assert.equal(result.dryRun, true)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑨b --skip-* 产生缺位：不继承上一轮装配的 node / sidecar.js / vendor / pnpm / host 包', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-skip-'))
  try {
    // 上一轮完整装配的遗留（含改名前的旧 host 包目录）。
    writeFileSync(path.join(out, 'node'), 'stale node')
    chmodSync(path.join(out, 'node'), 0o755)
    writeFileSync(path.join(out, 'sidecar.js'), '// stale bundle')
    mkdirSync(path.join(out, 'vendor', 'dsh'), { recursive: true })
    writeFileSync(path.join(out, 'vendor', 'dsh', 'package.json'), '{"name":"dsh"}')
    mkdirSync(path.join(out, 'pnpm', 'bin'), { recursive: true })
    writeFileSync(path.join(out, 'pnpm', 'bin', 'pnpm.cjs'), '// stale pnpm')
    mkdirSync(path.join(out, 'dist', 'dsh-host-client-graph'), { recursive: true })
    writeFileSync(path.join(out, 'dist', 'dsh-host-client-graph', 'index.js'), 'stale\n')

    await runBuildSidecar(parseBuildSidecarArgs([
      '--out', out, '--skip-node', '--skip-bundle', '--skip-vendor', '--skip-host-packages',
    ]), { log: () => {}, error: () => {} })
    const layout = sidecarLayout(out)
    assert.equal(existsSync(layout.node), false, '--skip-node 必须产生缺位（旧的 node 不得留下被一起签名发布）')
    assert.equal(existsSync(layout.entry), false, '--skip-bundle 必须产生缺位')
    assert.equal(existsSync(layout.vendorDsh), false, '--skip-vendor 必须清掉旧 vendor/dsh')
    assert.equal(existsSync(layout.pnpm), false, '--skip-vendor 必须清掉旧 pnpm')
    assert.equal(existsSync(path.join(layout.dist, 'dsh-host-client-graph')), false,
      '--skip-host-packages 不得让旧 host 包目录残留')
    // dist 仍由 control-plane 重建（它是本次的唯一合法成员）。
    assert.deepEqual(readdirSync(layout.dist), ['control-plane'])
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑨c 历史 tsc emit 目录被清掉（electron-builder 的 dist glob 不再打包无人消费的编译产物）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-emit-'))
  try {
    const legacy = path.join(dir, 'dist', 'sidecar')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(path.join(legacy, 'sidecar-stub.js'), '// legacy emit\n')
    clearLegacySidecarEmit(legacy)
    assert.equal(existsSync(legacy), false, '旧 emit 目录必须删除')
    clearLegacySidecarEmit(legacy) // 幂等：不存在也不炸
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑨d host 包产物 fail-closed：缺一个即抛，不产出半套 host 包', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-host-artifacts-'))
  try {
    const good = path.join(dir, 'good')
    mkdirSync(path.join(good, 'dist'), { recursive: true })
    writeFileSync(path.join(good, 'package.json'), '{"name":"@dsh-chamber/good"}')
    writeFileSync(path.join(good, 'dist', 'index.js'), 'export {}\n')
    const bad = path.join(dir, 'bad')
    mkdirSync(bad, { recursive: true })
    writeFileSync(path.join(bad, 'package.json'), '{}')
    const resolve = (name) => path.join(dir, name)
    assert.doesNotThrow(() => assertHostPackageArtifacts([{ name: 'good' }], resolve))
    assert.throws(
      () => assertHostPackageArtifacts([{ name: 'bad' }], resolve),
      /host 包 bad 缺少构建产物/,
      '缺 dist/index.js 必须 fail closed（旧实现只 warn，产出宿主域缺席的 .app）',
    )
    // 全量前置：第一个齐备、第二个缺失也在拷贝前抛（不发布半新半旧的集合）。
    assert.throws(() => assertHostPackageArtifacts([{ name: 'good' }, { name: 'bad' }], resolve), /bad/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G6 缺源 fail-closed：不跳过的源缺失是非零失败，不再 warn 后带旧产物「成功」', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-missing-source-'))
  try {
    const out = path.join(dir, 'out')
    // 上一轮装配的遗留（持久装配目录的常态）：旧 vendor/dsh + pnpm 齐全。
    mkdirSync(path.join(out, 'vendor', 'dsh'), { recursive: true })
    writeFileSync(path.join(out, 'vendor', 'dsh', 'package.json'), '{"name":"dsh","version":"old"}')
    mkdirSync(path.join(out, 'pnpm', 'bin'), { recursive: true })
    writeFileSync(path.join(out, 'pnpm', 'bin', 'pnpm.cjs'), '// old pnpm')

    const makeOptions = () => {
      const options = parseBuildSidecarArgs(['--out', out, '--skip-node', '--skip-bundle', '--skip-host-packages'])
      options.vendorDshDir = path.join(dir, 'no-vendor')
      options.pnpmDir = path.join(dir, 'no-pnpm')
      return options
    }
    // 缺 vendor 源：在任何写盘之前抛（G6）；提示里的逃生门是 --skip-vendor。
    await assert.rejects(
      runBuildSidecar(makeOptions(), { log: () => {}, warn: () => {}, error: () => {} }),
      /内置 dsh 工作区源不存在：.*--skip-vendor/,
    )
    // 缺 pnpm 源：同一姿态（独立分支，不能只测 vendor）。
    const pnpmMissing = makeOptions()
    pnpmMissing.vendorDshDir = path.join(dir, 'vendor-present')
    mkdirSync(pnpmMissing.vendorDshDir, { recursive: true })
    writeFileSync(path.join(pnpmMissing.vendorDshDir, 'package.json'), '{"name":"dsh"}')
    await assert.rejects(
      runBuildSidecar(pnpmMissing, { log: () => {}, warn: () => {}, error: () => {} }),
      /内嵌 pnpm 源不存在：.*--skip-vendor/,
    )
    // 旧产物只是「停留」而不是「被本轮认领」：构建非零退出，发布腿不会产出 .app。
    assert.equal(existsSync(path.join(out, 'vendor', 'dsh', 'package.json')), true)
    // dry-run 的既有语义不变：默认源缺失仍是 warn（干净 checkout 正常形态）。
    const dryOptions = parseBuildSidecarArgs(['--dry-run', '--out', out, '--skip-node'])
    dryOptions.vendorDshDir = path.join(dir, 'no-vendor')
    dryOptions.pnpmDir = path.join(dir, 'no-pnpm')
    const warnings = []
    await runBuildSidecar(dryOptions, { log: () => {}, warn: m => warnings.push(m), error: () => {} })
    assert.ok(warnings.some(w => /未找到内置 dsh 工作区/.test(w)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The Electron binary of the installed electron package, or null (no dist → loud skip). */
function findElectronBinary() {
  const pkgDir = resolveElectronPackageDir()
  if (pkgDir === null) return null
  let version
  try {
    version = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
  for (const distDir of [path.join(pkgDir, 'dist'), sharedDistDirFor(version, { env: process.env })]) {
    const executable = path.join(distDir, platformExecutableName())
    if (existsSync(executable)) return executable
  }
  return null
}

test('G18 装配捆绑 node 的版本 == DEFAULT_NODE_VERSION（装配存在时机械断言）', () => {
  const bundled = path.join(desktopDir, 'release', 'sidecar', 'node')
  if (!existsSync(bundled)) {
    console.log('SKIP: 本机无 sidecar 装配 node（release-only 产物；ci.yml test-macos 用 --skip-node 构建装配）——'
      + 'PINNED_NODE_SHA256 ↔ DEFAULT_NODE_VERSION 的表锁步已在 ③b 无条件断言')
    return
  }
  const version = execFileSync(bundled, ['--version'], { encoding: 'utf8' }).trim().replace(/^v/, '')
  assert.equal(version, DEFAULT_NODE_VERSION,
    '装配的 node 版本必须等于 DEFAULT_NODE_VERSION（与 Electron 同一 pin；升级版本需同步表与注释）')
})

test('G37 Electron pin → node 版本是固定表（无 Electron 二进制也必须断言）', () => {
  // 旧 G18 断言执行 Electron 二进制读 process.versions.node，缺二进制即响亮 SKIP
  // ——而 CI 每条腿都没有 Electron dist（electron 无 postinstall），所以它在 CI
  // 恒跳过。表把映射变成无条件断言：desktop 的精确 Electron pin 必须命中一行，
  // 且该行 node 版本必须等于 DEFAULT_NODE_VERSION；升级任一 pin 都会红。
  const electronPin = resolveElectronPin(DESKTOP_MANIFEST)
  assert.equal(electronPin, DESKTOP_MANIFEST.devDependencies.electron)
  assert.equal(ELECTRON_PINNED_VERSION, electronPin, 'module 级 pin 与 manifest 同源')
  assert.equal(ELECTRON_NODE_PINS[electronPin], DEFAULT_NODE_VERSION,
    `ELECTRON_NODE_PINS[${electronPin}] 必须等于 DEFAULT_NODE_VERSION`)
  assert.equal(assertElectronNodePin(electronPin), DEFAULT_NODE_VERSION)
  // 漂移臂：未知 Electron / 表值不等于捆绑 pin / 范围说明符，都必须 loud。
  assert.throws(() => assertElectronNodePin('99.0.0'), /不在 ELECTRON_NODE_PINS 表内/)
  assert.throws(() => assertElectronNodePin(electronPin, { pins: { [electronPin]: '0.0.1' } }),
    /内置 node 0\.0\.1 != 捆绑 pin/)
  assert.throws(() => resolveElectronPin({ devDependencies: { electron: '^43.4.0' } }),
    /必须是精确版本/)
  assert.throws(() => resolveElectronPin({ devDependencies: {} }), /缺少 devDependencies\.electron/)

  // 二进制在场时（桌面开发机 / DSH_CHAMBER_ELECTRON=1）仍实测交叉验证表值——
  // 表是 CI 的门，实测是表本身的证据；缺二进制不再跳过上面的断言。
  const electronBinary = findElectronBinary()
  if (electronBinary === null) {
    console.log('note: Electron dist 未物化——表断言已执行（G37）；物化后本用例会再实测一次')
    return
  }
  const version = execFileSync(electronBinary, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim()
  assert.equal(version, ELECTRON_NODE_PINS[electronPin],
    `Electron 内置 node ${version} != 表值 ${ELECTRON_NODE_PINS[electronPin]}（D6/G37：表是错的）`)
})

test('G39 vendor/dsh 版本 + 平台装配断言：漂移的 vendor 树在拷贝前 fail-closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-vendor-runtime-'))
  try {
    const vendor = path.join(dir, 'vendor')
    const dshDir = path.join(vendor, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    const writeTree = (version, platform) => {
      writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({
        name: 'dsh', dependencies: { '@deepseek-ai/dsh': version }, dsh: { platform },
      }))
      writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
    }
    const dest = path.join(dir, 'out', 'vendor', 'dsh')
    writeTree('0.2.0', 'darwin-arm64')
    assert.deepEqual(verifyVendorDshRuntime(vendor, 'darwin'), { version: '0.2.0', platform: 'darwin-arm64' })
    assert.equal(copyVendorDsh(vendor, dest, { platform: 'darwin' }), true)
    assert.deepEqual(verifyVendorDshRuntime(dest, 'darwin'), { version: '0.2.0', platform: 'darwin-arm64' },
      '拷贝产物必须通过同一断言（拷贝不得改坏 manifest）')

    // 版本漂移：runtime manifest 记录 0.2.0，包内实际 0.3.0 → 写盘前抛。
    writeTree('0.2.0', 'darwin-arm64')
    writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.3.0' }))
    assert.throws(() => verifyVendorDshRuntime(vendor, 'darwin'), /vendor\/dsh 版本漂移/)
    assert.throws(() => copyVendorDsh(vendor, dest, { platform: 'darwin' }), /vendor\/dsh 版本漂移/)

    // 平台漂移：linux 烘焙的运行时不得进 darwin 装配。
    writeTree('0.2.0', 'linux-x64')
    assert.throws(() => verifyVendorDshRuntime(vendor, 'darwin'), /vendor\/dsh 平台漂移.*linux-x64/)

    // 半拷贝/空目录：缺包内 dsh manifest 同样 loud（release 旧实现的 test -f 覆盖不到）。
    writeTree('0.2.0', 'darwin-arm64')
    rmSync(path.join(dshDir, 'package.json'))
    assert.throws(() => verifyVendorDshRuntime(vendor, 'darwin'), /vendor\/dsh 装配不完整/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G18 Node 捆绑离线端到端：SHA 校验 → 解包 → 基名/0755 断言真的执行（不再只有 --skip-node）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-node-e2e-'))
  try {
    const version = '0.0.1-fake'
    const arch = HOST_ARCH
    const member = `node-v${version}-darwin-${arch}/bin/node`
    const root = path.join(dir, `node-v${version}-darwin-${arch}`)
    mkdirSync(path.join(root, 'bin'), { recursive: true })
    writeFileSync(path.join(root, 'bin', 'node'), '#!/bin/sh\necho fake-node\n')
    const archive = path.join(dir, nodeArchiveName(version, arch))
    execFileSync('tar', ['-czf', archive, '-C', dir, `node-v${version}-darwin-${arch}`])
    const digest = await sha256File(archive)

    const out = path.join(dir, 'out')
    await runBuildSidecar(parseBuildSidecarArgs([
      '--out', out, '--skip-bundle', '--skip-host-packages', '--skip-vendor',
      '--node-version', version, '--arch', arch, '--node-archive', archive, '--node-sha256', digest,
    ]), { log: () => {}, error: () => {} })
    const layout = sidecarLayout(out)
    assert.equal(readFileSync(layout.node, 'utf8'), '#!/bin/sh\necho fake-node\n')
    assert.equal(statSync(layout.node).mode & 0o777, 0o755, '落位 Node 必须是 0755')
    assert.ok(assertNodeArchiveMembers(archive, member).includes(member))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 跑 dry-run 的输入校验路径（不写盘、不联网）。 */
/** 跑真实的 dry-run 校验路径（runBuildSidecar 的 dry-run 分支）。 */
async function runDryRun(argv, warnings = []) {
  await runBuildSidecar(parseBuildSidecarArgs(argv), {
    log() {},
    warn(message) { warnings.push(message) },
    error() {},
  })
}

test('⑦ normalizeSymlinks：树内→相对、树外→实体化、悬空 loud、幂等', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-symlink-'))
  try {
    const dest = path.join(root, 'dest')
    const external = path.join(root, 'external')
    mkdirSync(path.join(dest, '.bin'), { recursive: true })
    mkdirSync(path.join(dest, 'pkg'), { recursive: true })
    mkdirSync(path.join(external, 'dir'), { recursive: true })
    writeFileSync(path.join(dest, 'pkg', 'cli.js'), 'console.log(1)\n')
    writeFileSync(path.join(external, 'outside.js'), 'outside\n')
    writeFileSync(path.join(external, 'dir', 'a.txt'), 'a\n')
    // cpSync 的产物形状：相对链接被改写成绝对链接。
    symlinkSync(path.join(dest, 'pkg', 'cli.js'), path.join(dest, '.bin', 'inside'))
    symlinkSync(path.join(external, 'outside.js'), path.join(dest, '.bin', 'outside'))
    symlinkSync(path.join(external, 'dir'), path.join(dest, 'dirlink'))

    const rewritten = normalizeSymlinks(dest)
    assert.equal(rewritten, 3)
    // 树内 → 相对链接（保留链接语义）
    assert.equal(readlinkSync(path.join(dest, '.bin', 'inside')), '../pkg/cli.js')
    // 树外 → 实体化（文件/目录），不再是链接
    assert.ok(!lstatSync(path.join(dest, '.bin', 'outside')).isSymbolicLink())
    assert.equal(readFileSync(path.join(dest, '.bin', 'outside'), 'utf8'), 'outside\n')
    assert.ok(!lstatSync(path.join(dest, 'dirlink')).isSymbolicLink())
    assert.ok(statSync(path.join(dest, 'dirlink')).isDirectory())
    assert.equal(readFileSync(path.join(dest, 'dirlink', 'a.txt'), 'utf8'), 'a\n')
    // 幂等
    assert.equal(normalizeSymlinks(dest), 0)
    // 悬空 → loud
    symlinkSync(path.join(root, 'missing'), path.join(dest, '.bin', 'dangling'))
    assert.throws(() => normalizeSymlinks(dest), /符号链接目标不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑧ copyTree：verbatim 只搬链接；树内相对链接保留、树外链接由 normalizeSymlinks 实体化', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-copytree-'))
  try {
    const src = path.join(root, 'src')
    const dst = path.join(root, 'dst')
    const external = path.join(root, 'ext')
    mkdirSync(path.join(src, '.bin'), { recursive: true })
    mkdirSync(path.join(src, 'pkg'), { recursive: true })
    mkdirSync(external, { recursive: true })
    writeFileSync(path.join(src, 'pkg', 'cli.js'), 'cli\n')
    writeFileSync(path.join(external, 'out.js'), 'out\n')
    symlinkSync('../pkg/cli.js', path.join(src, '.bin', 'inside'))
    symlinkSync(path.join(external, 'out.js'), path.join(src, '.bin', 'outside'))

    // cpSync(verbatimSymlinks: true)：链接原样搬运，不再自行 deref/绝对化。
    copyTree(src, dst)
    assert.ok(lstatSync(path.join(dst, '.bin', 'inside')).isSymbolicLink())
    assert.equal(readlinkSync(path.join(dst, '.bin', 'inside')), '../pkg/cli.js')
    assert.equal(readFileSync(path.join(dst, 'pkg', 'cli.js'), 'utf8'), 'cli\n')
    assert.ok(lstatSync(path.join(dst, '.bin', 'outside')).isSymbolicLink(),
      'copyTree 只搬链接（实体化是 normalizeSymlinks 的职责）')

    // 实体化：唯一处置点，树外链接变成自包含文件。
    const materialized = normalizeSymlinks(dst)
    assert.equal(materialized, 1)
    assert.ok(!lstatSync(path.join(dst, '.bin', 'outside')).isSymbolicLink())
    assert.equal(readFileSync(path.join(dst, '.bin', 'outside'), 'utf8'), 'out\n')

    // 悬空链接：copyTree 不再自带第二份检查，normalizeSymlinks loud。
    symlinkSync(path.join(root, 'missing'), path.join(src, '.bin', 'dangling'))
    copyTree(src, path.join(root, 'dst2'))
    assert.throws(() => normalizeSymlinks(path.join(root, 'dst2')), /符号链接目标不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑨ 装配目录重建：上一轮遗留的 host 包目录（T2 改名前的旧名）不留在产物里', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-rebuild-'))
  try {
    // 模拟"改名前的上一轮装配"：旧名 host 包目录 + 一个无关的陈旧目录。
    const stale = path.join(out, 'dist', 'dsh-host-client-graph', 'dist')
    mkdirSync(stale, { recursive: true })
    writeFileSync(path.join(stale, 'index.js'), 'stale\n')
    mkdirSync(path.join(out, 'dist', 'leftover-junk'), { recursive: true })

    await runBuildSidecar(parseBuildSidecarArgs(['--out', out, '--skip-node', '--skip-vendor']), {
      log: () => {},
      error: () => {},
    })
    const layout = sidecarLayout(out)
    // <out>/dist 由本脚本独家拥有 → 整目录重建，旧目录必须消失
    assert.ok(!existsSync(path.join(layout.dist, 'dsh-host-client-graph')), '旧名 host 包目录不应残留')
    assert.ok(!existsSync(path.join(layout.dist, 'leftover-junk')), '无关陈旧目录不应残留')
    // 当前 host 包与 control-plane 仍齐全
    assert.ok(existsSync(layout.controlPlaneEntry))
    for (const host of HOST_PACKAGES) {
      assert.ok(existsSync(path.join(layout.hostPackageDist(host.name), 'dist', 'index.js')))
    }
    // dist/ 顶层 == {control-plane} ∪ HOST_PACKAGES（无第三方成员）
    const expected = ['control-plane', ...HOST_PACKAGES.map((h) => h.name)].sort()
    assert.deepEqual(readdirSync(layout.dist).sort(), expected)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
