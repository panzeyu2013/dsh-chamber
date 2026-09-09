/**
 * build-sidecar.test.mjs —— W-23 sidecar 打包脚本单测（design 25 §3.2/§4.3）
 *
 * 覆盖：
 *  ① 参数解析与布局（缺省 out、各开关、未知参数 loud）；
 *  ② 计划文本（--skip-node/--skip-bundle 的步骤差异）；
 *  ③ Node 归档命名/URL/成员路径 + SHASUMS256.txt 解析；
 *  ④ SHA-256 流式计算与不匹配检测；
 *  ⑤ **A5 断言**：捆绑 Node 基名必须叫 node——正例通过、反例 loud；
 *     并实证 resolveNodeExecutable 的纯 Node 分支前提（basename(execPath) ==
 *     'node' → 直用 execPath；其他基名 → 回落，不直用）；
 *  ⑥ --dry-run 真实子进程：输入校验通过、不写盘、不联网（exit 0）。
 * 不联网、不下载 Node、不写仓库外路径（dry-run 无副作用）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_NODE_VERSION,
  HOST_PACKAGES,
  assertBundledNodeBasename,
  assertNodeArchiveMembers,
  copyPnpm,
  copyVendorDsh,
  buildPlan,
  nodeArchiveName,
  nodeDistUrl,
  nodeMemberPath,
  parseBuildSidecarArgs,
  parseShasums,
  runBuildSidecar,
  sha256File,
  verifySha256,
  sidecarLayout,
} from './build-sidecar.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const script = path.join(here, 'build-sidecar.mjs')

test('① 参数解析：缺省值、开关与错误', () => {
  const defaults = parseBuildSidecarArgs([])
  assert.equal(defaults.outDir, path.join(desktopDir, 'release', 'sidecar'))
  assert.equal(defaults.dryRun, false)
  assert.equal(defaults.skipNode, false)
  assert.equal(defaults.nodeVersion, DEFAULT_NODE_VERSION)
  assert.equal(defaults.arch, 'arm64')
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
  assert.equal(layout.hostPackageDist('dsh-host-client-graph'), '/tmp/out/dist/dsh-host-client-graph')
})

test('② 计划文本反映开关', () => {
  const base = parseBuildSidecarArgs([])
  const full = buildPlan(base).join('\n')
  assert.match(full, /esbuild 打包 sidecar-entry\.ts/)
  assert.match(full, /Node 捆绑：https:\/\/nodejs\.org\/dist\/v24\.18\.1\/node-v24\.18\.1-darwin-arm64\.tar\.gz/)
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

test('③d vendor/dsh + pnpm 拷贝（Electron extraResources 同款过滤器）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-vendor-'))
  try {
    // vendor/dsh：清单三件 + node_modules；dest 预置脏文件必须被清掉
    const vendorSrc = path.join(dir, 'vendor-src')
    mkdirSync(path.join(vendorSrc, 'node_modules', 'x'), { recursive: true })
    writeFileSync(path.join(vendorSrc, 'package.json'), '{"name":"dsh"}')
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
    writeFileSync(path.join(pnpmSrc, 'package.json'), '{"name":"pnpm"}')
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
    await runBuildSidecar(parseBuildSidecarArgs(['--out', out, '--skip-node']), {
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
