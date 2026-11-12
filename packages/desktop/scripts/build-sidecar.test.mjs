/**
 * build-sidecar.test.mjs —— sidecar 打包脚本单测（design 25 §3.2/§4.3）
 *
 * 覆盖：
 *  ① 参数解析与布局（缺省 out、各开关、--skip-node 与 --require-node 互斥、
 *     未知参数 loud；**单 Node 裁决**：布局不再有独立 helper/node 字段，装配内
 *     唯一的 Node 在 primary-runtime payload 里）；
 *  ② 计划文本（payload node/pnpm/target arch/office 与 --skip-* 的步骤差异）；
 *  ③ payload 门控纯函数：verifyPayloadNodeAndPnpm（node 存在 + 可执行位、pnpm
 *     入口）与 assertPayloadTarget（runtime.json 的 platform/arch 比对）；
 *  ③e 内嵌 pnpm 版本 pin：单源 desktop dependencies.pnpm + 构建期 fail-closed；
 *  ③d vendor/dsh + pnpm 拷贝（Electron extraResources 同款过滤器）；
 *  ④ office 技能资产：copyOfficeAssets 替换式落位 / 缺源跳过 = 缺位 /
 *     --require-office-assets fail-closed（4 文件清单来自单源常量）；
 *  ⑤ 单 Node 归因：resolveNodeExecutable 对 basename=node 的 execPath 直用
 *     （design 25 §4.3 A5 再反转；helper 基名随单 Node 裁决退场）；
 *  ⑥ 真实装配（--skip-node/--skip-vendor）与 --dry-run 子进程：输入校验通过、
 *     不写盘、不联网；
 *  ⑦ normalizeSymlinks：树内绝对链接→相对、树外链接→实体化、悬空→loud、幂等；
 *  ⑧ copyTree：cpSync(verbatimSymlinks) 只搬链接，实体化交给 normalizeSymlinks；
 *  ⑨b --skip-* 的诚实语义：跳过 = 缺位（含旧布局 helper/node 的迁移清理）；
 *  ⑨c tsc emit 目录（dist/sidecar）被清掉，不被 electron-builder 打包；
 *  ⑨d host 包产物 fail-closed；G6 缺源 fail-closed；G39 vendor 版本/平台断言。
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
  HOST_PACKAGES,
  PNPM_PINNED_VERSION,
  assertHostPackageArtifacts,
  assertPayloadTarget,
  buildPlan,
  clearLegacySidecarEmit,
  copyOfficeAssets,
  copyPnpm,
  copyTree,
  copyVendorDsh,
  normalizeSymlinks,
  parseBuildSidecarArgs,
  resolvePnpmPin,
  runBuildSidecar,
  sidecarLayout,
  verifyPayloadNodeAndPnpm,
  verifyVendorDshDocs,
  verifyVendorDshRuntime,
} from './build-sidecar.mjs'
// office 资产的 4 文件清单与在场判定单源 = prepare-office-assets.mjs（装配侧不另抄一份）。
import { OFFICE_SKILL_FILES, verifyOfficeAssets } from './prepare-office-assets.mjs'
import { platformExecutableName, resolveElectronPackageDir, sharedDistDirFor } from './electron-shared.mjs'
import { payloadNodePath } from '../../../scripts/lib/sidecar-assembly.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const script = path.join(here, 'build-sidecar.mjs')

/** vendor/dsh 的平台前缀（装配断言读它；实际形如 darwin-arm64）。 */
const HOST_ARCH = process.arch === 'x64' ? 'x64' : 'arm64'
const HOST_PLATFORM = `${process.platform}-${HOST_ARCH}`

/** M19：rc.2 起 @deepseek-ai/dsh 随包 docs；装配断言要求两份读者入口在场且可读。 */
function writeVendorDshDocs(vendorDir) {
  const docsDir = path.join(vendorDir, 'node_modules', '@deepseek-ai', 'dsh', 'docs')
  mkdirSync(path.join(docsDir, 'user'), { recursive: true })
  mkdirSync(path.join(docsDir, 'upgrade-guide'), { recursive: true })
  writeFileSync(path.join(docsDir, 'user', 'index.md'), '# user\n')
  writeFileSync(path.join(docsDir, 'upgrade-guide', 'README.md'), '# guides\n')
}

test('① 参数解析：缺省值、单 Node 开关与错误', () => {
  const defaults = parseBuildSidecarArgs([])
  assert.equal(defaults.outDir, path.join(desktopDir, 'release', 'sidecar'))
  assert.equal(defaults.dryRun, false)
  assert.equal(defaults.skipNode, false, '单 Node：--skip-node 只表达「不要求 payload node」')
  assert.equal(defaults.requireNode, false)
  assert.equal(defaults.requirePnpm, false)
  assert.equal(defaults.skipOfficeAssets, false)
  assert.equal(defaults.requireOfficeAssets, false)
  assert.equal(defaults.arch, null, '缺省不猜目标架构；payload 存在时按 --arch 比对')
  assert.equal(defaults.pythonPayloadDir, path.join(desktopDir, 'resources', 'primary-runtime'))
  assert.equal(defaults.officeAssetsDir, path.join(desktopDir, 'resources', 'office-skills'))

  const parsed = parseBuildSidecarArgs([
    '--out', '/tmp/x', '--dry-run', '--skip-node', '--skip-bundle', '--skip-office-assets', '--arch', 'x64',
  ])
  assert.equal(parsed.outDir, '/tmp/x')
  assert.equal(parsed.dryRun, true)
  assert.equal(parsed.skipNode, true)
  assert.equal(parsed.skipBundle, true)
  assert.equal(parsed.skipOfficeAssets, true)
  assert.equal(parsed.arch, 'x64')
  // 发布腿的四个 --require-*（python 既有 + 单 Node 的 node/pnpm/office）。
  const required = parseBuildSidecarArgs([
    '--require-python', '--require-node', '--require-pnpm', '--require-office-assets',
  ])
  assert.equal(required.requirePython, true)
  assert.equal(required.requireNode, true)
  assert.equal(required.requirePnpm, true)
  assert.equal(required.requireOfficeAssets, true)
  // 显式源路径只在调用方给路径时严格校验（默认源缺失只 warn）。
  const sources = parseBuildSidecarArgs(['--office-assets', '/tmp/office-assets'])
  assert.equal(sources.officeAssetsDir, '/tmp/office-assets')
  assert.equal(sources.officeAssetsExplicit, true)
  // 互斥：--skip-node 与 --require-node 同时出现是调用方自相矛盾。
  assert.throws(() => parseBuildSidecarArgs(['--skip-node', '--require-node']), /互斥/)
  assert.throws(() => parseBuildSidecarArgs(['--skip-python', '--require-python']), /互斥/)
  assert.throws(() => parseBuildSidecarArgs(['--skip-office-assets', '--require-office-assets']), /互斥/)
  // 单 Node 裁决后旧的独立 Node 下载参数必须消失（防止发布腿沿用过时 argv）。
  assert.throws(() => parseBuildSidecarArgs(['--node-archive', '/tmp/node.tar.gz']), /未知参数/)
  assert.throws(() => parseBuildSidecarArgs(['--node-version', '24.9.0']), /未知参数/)
  assert.throws(() => parseBuildSidecarArgs(['--node-sha256', 'ab'.repeat(32)]), /未知参数/)
  // Negative arm: --arch is a whitelist — an explicit bad value must fail loudly
  // rather than flow into the payload target assertion and the release artifacts.
  assert.throws(() => parseBuildSidecarArgs(['--arch', 'ia32']), /--arch 只接受 arm64\|x64/)
  assert.equal(parseBuildSidecarArgs(['--arch', 'arm64']).arch, 'arm64')
  assert.equal(parseBuildSidecarArgs(['--arch', 'x64']).arch, 'x64')
  assert.throws(() => parseBuildSidecarArgs(['--nope']), /未知参数/)
  assert.throws(() => parseBuildSidecarArgs(['--out']), /缺少取值/)
})

test('① 布局：单 Node 在 payload 里（无 helper 字段）+ sidecar.js / dist / office-skills', () => {
  const layout = sidecarLayout('/tmp/out')
  assert.equal(layout.outDir, '/tmp/out')
  assert.equal(layout.entry, '/tmp/out/sidecar.js')
  assert.equal(layout.packageJson, '/tmp/out/package.json')
  assert.equal(layout.dist, '/tmp/out/dist')
  assert.equal(layout.controlPlaneDist, '/tmp/out/dist/control-plane')
  assert.equal(layout.controlPlaneEntry, '/tmp/out/dist/control-plane/index.js')
  assert.equal(layout.hostPackageDist('dsh-chamber-seed-client-graph'), '/tmp/out/dist/dsh-chamber-seed-client-graph')
  // 单 Node 裁决：装配目录顶层的独立 node/helper 字段消失了，唯一 Node 在 payload。
  assert.equal(Object.prototype.hasOwnProperty.call(layout, 'node'), false,
    '独立 helper/node 字段已随单 Node 裁决移除')
  assert.equal(layout.primaryRuntime, '/tmp/out/primary-runtime')
  assert.equal(layout.payloadNode, '/tmp/out/primary-runtime/dependencies/node/bin/node')
  assert.equal(layout.payloadNode, payloadNodePath('/tmp/out'),
    'payload node 路径单源 = scripts/lib/sidecar-assembly.mjs')
  assert.equal(layout.payloadPnpmEntry, '/tmp/out/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  assert.equal(layout.officeSkills, '/tmp/out/office-skills')
})

test('② 计划文本反映单 Node 开关', () => {
  const full = buildPlan(parseBuildSidecarArgs(['--arch', 'arm64'])).join('\n')
  assert.match(full, /esbuild 打包 sidecar-entry\.ts/)
  assert.match(full, /写装配 package\.json/)
  assert.match(full, /\[4\] python 载荷/)
  assert.match(full, /\[4a\] payload node：.*primary-runtime\/dependencies\/node\/bin\/node/)
  assert.match(full, /\[4b\] payload pnpm：.*primary-runtime\/dependencies\/pnpm\/bin\/pnpm\.mjs/)
  assert.match(full, /\[4c\] payload 目标架构：darwin-arm64/)
  assert.match(full, /\[4d\] office 技能资产：.*→ .*office-skills/)
  // 单 Node 裁决：计划里不得再出现独立 Node 下载/摘要/helper 字样。
  assert.doesNotMatch(full, /nodejs\.org|SHA-256 校验|Node 捆绑|dsh-chamber-helper/)

  const skipped = buildPlan(parseBuildSidecarArgs([
    '--skip-node', '--skip-bundle', '--skip-office-assets',
  ])).join('\n')
  assert.match(skipped, /跳过 esbuild 打包/)
  assert.match(skipped, /\[4a\] 跳过 payload node 要求/)
  assert.match(skipped, /\[4d\] 跳过 office 技能资产/)
  assert.doesNotMatch(skipped, /payload 目标架构/)
  assert.doesNotMatch(skipped, /nodejs\.org/)

  const required = buildPlan(parseBuildSidecarArgs([
    '--require-node', '--require-pnpm', '--require-office-assets',
  ])).join('\n')
  assert.match(required, /（--require-node：缺件 fail-closed）/)
  assert.match(required, /（--require-pnpm：缺件 fail-closed）/)
  assert.match(required, /（--require-office-assets：缺件 fail-closed）/)
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

test('③c dry-run 真校验输入源（显式缺失即抛 / 默认缺失 warn）且不写盘', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-dry-'))
  try {
    const out = path.join(dir, 'out')
    // 正常 dry-run → 计划可生成（单 Node：payload node 默认不要求）。
    const plan = buildPlan(parseBuildSidecarArgs(['--dry-run', '--out', out])).join('\n')
    assert.match(plan, /\[4a\] payload node/)
    assert.equal(existsSync(out), false, 'dry-run 不得创建输出目录')
    // 显式 --office-assets 源缺失 → 抛（不得静默"校验通过"）
    await assert.rejects(
      runDryRun(['--dry-run', '--out', out, '--office-assets', path.join(dir, 'missing-assets')]),
      /--office-assets 源不存在/,
    )
    // --require-node / --require-pnpm 在 payload 未准备时必须 fail-closed（不下载 Node）。
    await assert.rejects(
      runDryRun(['--dry-run', '--out', out, '--require-node']),
      /payload node\/pnpm 不可用/,
    )
    await assert.rejects(
      runDryRun(['--dry-run', '--out', out, '--require-pnpm']),
      /payload node\/pnpm 不可用/,
    )
    // **显式**传入的 vendor 源缺失 → 抛（调用方路径写错）
    await assert.rejects(
      runDryRun(['--dry-run', '--out', out, '--vendor-dsh', path.join(dir, 'no-vendor')]),
      /--vendor-dsh 源不存在/,
    )
    // 默认源缺失 → 只 warn（干净 checkout 的正常形态；严格校验
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
    // 真实 vendor 树必须让 verifyVendorDshRuntime 过关——runtime manifest
    // 记录的版本 == 包内 dsh 的 version，dsh.platform 以宿主前缀开头；否则拷贝
    // 在任何写盘之前就 fail closed（这里同时是非漂移正例）。
    writeFileSync(path.join(vendorSrc, 'package.json'), JSON.stringify({
      name: 'dsh',
      dependencies: { '@deepseek-ai/dsh': '0.2.0' },
      dsh: { platform: HOST_PLATFORM },
    }))
    writeFileSync(path.join(vendorSrc, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0' }))
    writeVendorDshDocs(vendorSrc)
    // LibreOffice kit 闭包 + 宿主平台引擎：verifyVendorDshRuntime 要求 kit 在场且引擎文件可执行面在场。
    const kitSrc = path.join(vendorSrc, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    mkdirSync(kitSrc, { recursive: true })
    writeFileSync(path.join(kitSrc, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: '0.1.5' }))
    const hostLinux = HOST_PLATFORM.startsWith('linux-')
    const hostEngineName = hostLinux ? 'libreoffice-kit-wasm' : 'libreoffice-kit-' + HOST_PLATFORM
    const hostEngineDir = path.join(vendorSrc, 'node_modules', '@deepseek-ai', hostEngineName)
    const hostEngineEntry = hostLinux ? 'assets/soffice.cjs' : 'bin/libreoffice-kit'
    mkdirSync(path.join(hostEngineDir, path.dirname(hostEngineEntry)), { recursive: true })
    writeFileSync(path.join(hostEngineDir, 'prebuilds.json'), JSON.stringify({
      engine: { kind: hostLinux ? 'wasm' : 'native', [hostLinux ? 'loader' : 'executable']: hostEngineEntry },
    }))
    writeFileSync(path.join(hostEngineDir, hostEngineEntry), hostLinux ? '// wasm loader\n' : '#!/bin/sh\n')
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
    // 版本必须是仓库 pin（fail-closed）——写别的版本 copyPnpm 会抛。
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

test('③f payload 门控纯函数：node/pnpm 存在性 + 可执行位 + target 架构', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-payload-'))
  try {
    const payload = path.join(dir, 'primary-runtime')
    // 未准备：默认不要求 → ok；--require-node/--require-pnpm 各自报缺件（不下载 Node）。
    assert.equal(verifyPayloadNodeAndPnpm(payload, {}).ok, true)
    const nodeRequired = verifyPayloadNodeAndPnpm(payload, { requireNode: true })
    assert.equal(nodeRequired.ok, false)
    assert.match(nodeRequired.problems.join('\n'), /缺 payload node：.*dependencies\/node\/bin\/node/)
    const pnpmRequired = verifyPayloadNodeAndPnpm(payload, { requirePnpm: true })
    assert.match(pnpmRequired.problems.join('\n'), /缺 payload pnpm：.*dependencies\/pnpm\/bin\/pnpm\.mjs/)
    // --skip-node 表达「不要求 payload node」：即使 plan 期注入了 requireNode 也放行
    // （argparse 层已把 --skip-node 与 --require-node 判为互斥）。
    assert.equal(verifyPayloadNodeAndPnpm(payload, { skipNode: true, requireNode: true }).ok, true)
    // 补齐 node（先无执行位）→ 可执行位必须被断言；pnpm 入口存在即过。
    const nodeBin = path.join(payload, 'dependencies', 'node', 'bin')
    mkdirSync(nodeBin, { recursive: true })
    writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\n')
    chmodSync(path.join(nodeBin, 'node'), 0o644)
    assert.match(verifyPayloadNodeAndPnpm(payload, { requireNode: true }).problems.join('\n'), /没有可执行位/)
    chmodSync(path.join(nodeBin, 'node'), 0o755)
    const pnpmEntry = path.join(payload, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    mkdirSync(path.dirname(pnpmEntry), { recursive: true })
    writeFileSync(pnpmEntry, '// pnpm')
    const complete = verifyPayloadNodeAndPnpm(payload, { requireNode: true, requirePnpm: true })
    assert.equal(complete.ok, true)
    assert.equal(complete.node, path.join(nodeBin, 'node'))
    assert.equal(complete.pnpm, pnpmEntry)

    // 目录冒充 payload node：本门必须自己拒绝（build-swift-app 的 isFile 是更晚一道门）。
    rmSync(path.join(nodeBin, 'node'), { force: true })
    mkdirSync(path.join(nodeBin, 'node'))
    const dirNode = verifyPayloadNodeAndPnpm(payload, { requireNode: true })
    assert.equal(dirNode.ok, false)
    assert.match(dirNode.problems.join('\n'), /不是常规文件/)
    rmSync(path.join(nodeBin, 'node'), { recursive: true, force: true })
    writeFileSync(path.join(nodeBin, 'node'), '#!/bin/sh\n', { mode: 0o755 })

    // target 架构：无 --arch / 无 runtime.json → 跳过（null）。
    assert.equal(assertPayloadTarget(payload, null), null)
    assert.equal(assertPayloadTarget(payload, 'arm64'), null)
    const manifest = path.join(payload, 'runtime.json')
    const writeManifest = (value) => writeFileSync(manifest, JSON.stringify(value))
    writeManifest({ payload: 'complete', platform: 'darwin', arch: 'arm64' })
    assert.equal(assertPayloadTarget(payload, 'arm64'), 'arm64')
    assert.throws(() => assertPayloadTarget(payload, 'x64'), /payload 目标架构 "arm64" != --arch x64/)
    writeManifest({ payload: 'complete', platform: 'linux', arch: 'arm64' })
    assert.throws(() => assertPayloadTarget(payload, 'arm64'), /目标平台不是 darwin/)
    writeManifest({ payload: 'absent', platform: 'linux' })
    assert.equal(assertPayloadTarget(payload, 'arm64'), null, '未准备/占位载荷不做目标断言')
    writeFileSync(manifest, 'not json')
    assert.throws(() => assertPayloadTarget(payload, 'arm64'), /不是合法 JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 造 office 资产文件（与 OFFICE_SKILL_FILES 同形；omit 用于缺件用例）。 */
function writeOfficeAssetsFixture(root, { omit = [] } = {}) {
  for (const relative of OFFICE_SKILL_FILES) {
    if (omit.includes(relative)) continue
    const target = path.join(root, relative)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, '# ' + relative + '\nfixture asset\n')
  }
  return root
}

test('④ office 技能资产：替换式落位 / 缺源跳过 = 缺位 / --require-office-assets fail-closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-office-'))
  try {
    assert.equal(OFFICE_SKILL_FILES.length, 4, 'office 资产清单必须恰好 4 个文件（rc.2 资产面）')
    const source = writeOfficeAssetsFixture(path.join(dir, 'assets'))
    const sourceStatus = verifyOfficeAssets(source)
    assert.equal(sourceStatus.ok, true)
    assert.equal(sourceStatus.checked, 4, '4 个资产文件都必须被核对')
    const absentStatus = verifyOfficeAssets(path.join(dir, 'nope'))
    assert.equal(absentStatus.ok, false)
    assert.match(absentStatus.problems.join('\n'), /缺文件：office\/SKILL\.md/)
    const partialStatus = verifyOfficeAssets(
      writeOfficeAssetsFixture(path.join(dir, 'partial'), { omit: ['office-xlsx/SKILL.md'] }))
    assert.equal(partialStatus.ok, false)
    assert.match(partialStatus.problems.join('\n'), /office-xlsx\/SKILL\.md/)

    const dest = path.join(dir, 'out', 'office-skills')
    // 上一轮残留不得留下：替换式落位。
    mkdirSync(path.join(dest, 'stale'), { recursive: true })
    writeFileSync(path.join(dest, 'stale', 'x.txt'), 'stale\n')
    assert.equal(copyOfficeAssets(source, dest), true)
    for (const relative of OFFICE_SKILL_FILES) {
      assert.ok(existsSync(path.join(dest, relative)), relative + ' 应拷贝')
    }
    assert.equal(existsSync(path.join(dest, 'stale')), false, '替换式落位不得残留旧成员')
    // 缺源默认跳过：返回 false 且目标清空（跳过 = 缺位，不继承既有装配）。
    assert.equal(copyOfficeAssets(path.join(dir, 'missing'), dest), false)
    assert.equal(existsSync(dest), false, '缺源跳过必须产生缺位')
    // 发布腿的 fail-closed 开关：同一个缺源 loud。
    assert.throws(
      () => copyOfficeAssets(path.join(dir, 'missing'), dest, { requireAssets: true }),
      /--require-office-assets 但 office 技能资产不可用/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ 单 Node 归因：resolveNodeExecutable 对 basename=node 的 execPath 直用', () => {
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

  // 正例：payload node 的基名就是 node（单 Node 裁决不重命名）→ 直用 execPath、
  // 零额外 args/env。归因改由应用派生的子进程关系承担（design 25 §4.3 A5 再反转），
  // 不再依赖 grep 基名表；spawn-dsh 侧对 {node,node.exe} 的直用分支保留（task-10 域）。
  const payloadNode = '/tmp/assembled-sidecar/primary-runtime/dependencies/node/bin/node'
  const direct = run(payloadNode)
  assert.deepEqual(direct, { file: payloadNode, args: [], env: {} })
  // 反例：其他基名 → 绝不直用（回落 PATH/known locations，系统 node 版本不可控）。
  const fallback = run('/tmp/assembled-sidecar/system-node')
  assert.notEqual(fallback.file, '/tmp/assembled-sidecar/system-node')
})

test('⑥ 真实装配（--skip-node）：sidecar.js / package.json / control-plane / host 包', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-build-'))
  try {
    // --skip-vendor: vendor/dsh 在干净 checkout 是 release-only 产物；缺源
    // fail closed，所以本用例显式表达「不要 vendor」。
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

test('⑨b --skip-* 产生缺位：旧 helper/node 迁移清理 + skip 不继承既有装配', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'dsh-sidecar-skip-'))
  try {
    // 既有装配的遗留：旧布局的独立 Node（改名前的 node 与 dsh-chamber-helper）、
    // sidecar.js、vendor、pnpm、旧 host 包目录。
    writeFileSync(path.join(out, 'dsh-chamber-helper'), 'stale helper')
    chmodSync(path.join(out, 'dsh-chamber-helper'), 0o755)
    writeFileSync(path.join(out, 'node'), 'stale node')
    chmodSync(path.join(out, 'node'), 0o755)
    mkdirSync(path.join(out, 'office-skills', 'office'), { recursive: true })
    writeFileSync(path.join(out, 'office-skills', 'office', 'SKILL.md'), 'stale office')
    writeFileSync(path.join(out, 'sidecar.js'), '// stale bundle')
    mkdirSync(path.join(out, 'vendor', 'dsh'), { recursive: true })
    writeFileSync(path.join(out, 'vendor', 'dsh', 'package.json'), '{"name":"dsh"}')
    mkdirSync(path.join(out, 'pnpm', 'bin'), { recursive: true })
    writeFileSync(path.join(out, 'pnpm', 'bin', 'pnpm.cjs'), '// stale pnpm')
    mkdirSync(path.join(out, 'dist', 'dsh-host-client-graph'), { recursive: true })
    writeFileSync(path.join(out, 'dist', 'dsh-host-client-graph', 'index.js'), 'stale\n')

    await runBuildSidecar(parseBuildSidecarArgs([
      '--out', out, '--skip-node', '--skip-bundle', '--skip-vendor', '--skip-host-packages', '--skip-office-assets',
    ]), { log: () => {}, error: () => {} })
    const layout = sidecarLayout(out)
    // 单 Node 裁决：旧的顶层 node / dsh-chamber-helper 必须被迁移清理清掉。
    assert.equal(existsSync(path.join(out, 'dsh-chamber-helper')), false,
      '旧布局的 dsh-chamber-helper 必须清掉（单 Node 后不再被任何运行期解析）')
    assert.equal(existsSync(path.join(out, 'node')), false, '改名前的顶层 node 必须清掉')
    assert.equal(existsSync(layout.entry), false, '--skip-bundle 必须产生缺位')
    assert.equal(existsSync(layout.vendorDsh), false, '--skip-vendor 必须清掉旧 vendor/dsh')
    assert.equal(existsSync(layout.pnpm), false, '--skip-vendor 必须清掉旧 pnpm')
    assert.equal(existsSync(layout.officeSkills), false, '--skip-office-assets 必须清掉旧 office 资产')
    assert.equal(existsSync(path.join(layout.dist, 'dsh-host-client-graph')), false,
      '--skip-host-packages 不得让旧 host 包目录残留')
    // dist 仍由 control-plane 重建（它是唯一的合法成员）。
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
    // 既有装配的遗留（持久装配目录的常态）：vendor/dsh + pnpm 齐全。
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
    // 缺 vendor 源：在任何写盘之前抛；提示里的逃生门是 --skip-vendor。
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
    // 既有产物只是「停留」而不是「被构建认领」：构建非零退出，发布腿不会产出 .app。
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

test('G39 vendor/dsh 版本 + 平台装配断言：漂移的 vendor 树在拷贝前 fail-closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-vendor-runtime-'))
  try {
    const vendor = path.join(dir, 'vendor')
    const dshDir = path.join(vendor, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    const kitDir = path.join(vendor, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    mkdirSync(kitDir, { recursive: true })
    writeFileSync(path.join(kitDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: '0.1.5' }))
    const writeEngine = (platform) => {
      const isLinux = platform.startsWith('linux-')
      const engineName = isLinux ? 'libreoffice-kit-wasm' : 'libreoffice-kit-' + platform
      const engineDir = path.join(vendor, 'node_modules', '@deepseek-ai', engineName)
      mkdirSync(isLinux ? path.join(engineDir, 'assets') : path.join(engineDir, 'bin'), { recursive: true })
      const entry = isLinux ? 'assets/soffice.cjs' : 'bin/libreoffice-kit'
      writeFileSync(path.join(engineDir, 'prebuilds.json'), JSON.stringify({ engine: { kind: isLinux ? 'wasm' : 'native', [isLinux ? 'loader' : 'executable']: entry } }))
      writeFileSync(path.join(engineDir, entry), isLinux ? '// wasm loader\n' : '#!/bin/sh\n')
    }
    const writeTree = (version, platform) => {
      writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({
        name: 'dsh', dependencies: { '@deepseek-ai/dsh': version }, dsh: { platform },
      }))
      writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version }))
      writeVendorDshDocs(vendor)
      writeEngine(platform)
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

    // 半拷贝/空目录：缺包内 dsh manifest 同样 loud（只做 test -f 覆盖不到）。
    writeTree('0.2.0', 'darwin-arm64')
    rmSync(path.join(dshDir, 'package.json'))
    assert.throws(() => verifyVendorDshRuntime(vendor, 'darwin'), /vendor\/dsh 装配不完整/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G39c payload docs（M19）：dsh 随包 docs 的读者入口在场且可读，缺失/不可读即 fail-closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-vendor-docs-'))
  try {
    const vendor = path.join(dir, 'vendor')
    const dshDir = path.join(vendor, 'node_modules', '@deepseek-ai', 'dsh')
    mkdirSync(dshDir, { recursive: true })
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({
      name: 'dsh', dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.2' }, dsh: { platform: 'darwin-arm64' },
    }))
    writeFileSync(path.join(dshDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.2' }))
    writeVendorDshDocs(vendor)
    // 正例：两份读者入口在场且可读。
    assert.doesNotThrow(() => verifyVendorDshDocs(vendor))

    // 缺 user/index.md → 该入口的 loud 失败。
    rmSync(path.join(dshDir, 'docs', 'user', 'index.md'))
    assert.throws(() => verifyVendorDshDocs(vendor), /缺 user\/index\.md/)

    // 入口存在但不可读（目录顶替文件：existsSync 为真、readFileSync 抛）→ loud 失败。
    writeVendorDshDocs(vendor)
    rmSync(path.join(dshDir, 'docs', 'upgrade-guide', 'README.md'))
    mkdirSync(path.join(dshDir, 'docs', 'upgrade-guide', 'README.md'), { recursive: true })
    assert.throws(() => verifyVendorDshDocs(vendor), /dsh docs 不可读/)

    // 整棵 docs 缺失 → loud 失败。
    rmSync(path.join(dshDir, 'docs'), { recursive: true, force: true })
    assert.throws(() => verifyVendorDshDocs(vendor), /缺 @deepseek-ai\/dsh\/docs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('G39b vendor/dsh 的 LibreOffice 引擎载荷断言：缺目标引擎即 fail-closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-vendor-office-'))
  try {
    const vendor = path.join(dir, 'vendor')
    mkdirSync(path.join(vendor, 'node_modules', '@deepseek-ai', 'dsh'), { recursive: true })
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({
      name: 'dsh', dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.1' }, dsh: { platform: 'darwin-arm64' },
    }))
    writeFileSync(path.join(vendor, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.1' }))
    const kit = path.join(vendor, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    mkdirSync(kit, { recursive: true })
    writeFileSync(path.join(kit, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: '0.1.5' }))
    const engine = path.join(vendor, 'node_modules', '@deepseek-ai', 'libreoffice-kit-darwin-arm64')
    assert.throws(() => verifyVendorDshRuntime(vendor, 'darwin'), /缺少目标平台的 LibreOffice 引擎/)
    mkdirSync(path.join(engine, 'bin'), { recursive: true })
    writeFileSync(path.join(engine, 'prebuilds.json'), '{}')
    assert.throws(() => verifyVendorDshRuntime(vendor, 'darwin'), /缺少目标平台的 LibreOffice 引擎/,
      'prebuilds.json 缺 engine 声明仍须 fail-closed')
    writeFileSync(path.join(engine, 'prebuilds.json'), JSON.stringify({ engine: { kind: 'native', executable: 'bin/libreoffice-kit' } }))
    assert.throws(() => verifyVendorDshRuntime(vendor, 'darwin'), /缺少目标平台的 LibreOffice 引擎/,
      '声明了 native executable 但文件不在场仍须 fail-closed')
    writeFileSync(path.join(engine, 'bin', 'libreoffice-kit'), '#!/bin/sh\n')
    assert.equal(verifyVendorDshRuntime(vendor, 'darwin').version, '0.2.2-rc.1')

    // win32 引擎的可执行面是 .exe：断言按 prebuilds.json 的 engine.executable，而不是硬编码 bin/libreoffice-kit。
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({
      name: 'dsh', dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.1' }, dsh: { platform: 'win32-x64' },
    }))
    const win = path.join(vendor, 'node_modules', '@deepseek-ai', 'libreoffice-kit-win32-x64')
    mkdirSync(path.join(win, 'bin'), { recursive: true })
    writeFileSync(path.join(win, 'prebuilds.json'), JSON.stringify({ engine: { kind: 'native', executable: 'bin/libreoffice-kit.exe' } }))
    assert.throws(() => verifyVendorDshRuntime(vendor, 'win32'), /缺少目标平台的 LibreOffice 引擎/)
    writeFileSync(path.join(win, 'bin', 'libreoffice-kit.exe'), 'MZ')
    assert.equal(verifyVendorDshRuntime(vendor, 'win32').platform, 'win32-x64')

    // linux 目标用 wasm 引擎：按 prebuilds.json 的 loader 断言，不要求 native executable。
    writeFileSync(path.join(vendor, 'package.json'), JSON.stringify({
      name: 'dsh', dependencies: { '@deepseek-ai/dsh': '0.2.2-rc.1' }, dsh: { platform: 'linux-x64' },
    }))
    const wasm = path.join(vendor, 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm')
    mkdirSync(path.join(wasm, 'assets'), { recursive: true })
    writeFileSync(path.join(wasm, 'prebuilds.json'), JSON.stringify({ engine: { kind: 'wasm', loader: 'assets/soffice.cjs' } }))
    assert.throws(() => verifyVendorDshRuntime(vendor, 'linux'), /缺少目标平台的 LibreOffice 引擎/)
    writeFileSync(path.join(wasm, 'assets', 'soffice.cjs'), '// wasm loader\n')
    assert.equal(verifyVendorDshRuntime(vendor, 'linux').platform, 'linux-x64')
    rmSync(path.join(wasm, 'assets', 'soffice.cjs'))
    assert.throws(() => verifyVendorDshRuntime(vendor, 'linux'), /缺少目标平台的 LibreOffice 引擎/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** 跑 dry-run 的输入校验路径（不写盘、不联网）。 */
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
    // 树外 → 实体化（文件/目录），不是链接
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

    // cpSync(verbatimSymlinks: true)：链接原样搬运，不自行 deref/绝对化。
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

    // 悬空链接：copyTree 不自带第二份检查，normalizeSymlinks loud。
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
    // 模拟"改名前的既有装配"：旧名 host 包目录 + 一个无关的陈旧目录。
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
