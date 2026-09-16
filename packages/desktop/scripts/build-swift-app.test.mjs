/**
 * build-swift-app.test.mjs —— W-24 .app 打包脚本单测（design 25 §3.2/§8.4）
 *
 * 位置说明：脚本本体在 `macos/scripts/`（design/todo 指定的落位），但 `macos/`
 * 不是 pnpm 包——测试随 desktop 的 packaging-script 测试族放，并由
 * `test:macos`（ci.yml `test-macos` 腿）消费，**不在** ubuntu 的 `test` 链
 * （那里没有 plutil/codesign/ditto 与 SwiftPM 产物）。
 *
 * 覆盖：
 *  ① 参数解析与布局（app 结构、**资源包必须放 Contents/Resources**——放 .app 根会被
 *     codesign 判为未密封内容；运行时由 ChamberResources 定位）；
 *  ② Info.plist 模板渲染（__VERSION__ 替换）与 plutil 校验；
 *  ③ 计划文本随开关变化；
 *  ④ --dry-run 子进程：模板/entitlements 就绪、不写盘；
 *  ⑤ 真实组装（--skip-build --skip-sidecar --no-sign --no-zip --no-dmg）：
 *     可执行位、资源包（只含 bridge-shim.poc.js）、Info.plist 版本/图标/ATS、图标；
 *  ⑥ sidecar 装配拷贝 + A5 基名反例 loud + 缺 node / node 无执行位 loud；
 *  ⑦ ad-hoc 签名 + codesign 校验通过（真实 codesign，无网络）；
 *  ⑧ codesignArgs argv 顺序（ad-hoc/hardened 分支互斥、identity 紧跟 --sign）；
 *  ⑨ entitlements 文件合法 plist 且为最小集；
 *  ⑩ 逃出 bundle 的绝对符号链接 → 归一化后真实 codesign 校验通过；
 *  ④b Mach-O magic 全集（含 FAT_MAGIC_64）+ readdir 失败 fail closed；
 *  ⑪ 架构断言：同宿主通过、--arch 反向 loud、.app 与捆绑 node 无交集 loud；
 *  ⑫ lipo 输出解析（x86_64/arm64e/旧版 Non-fat 文案）；
 *  ⑬ DMG 卷内容（/Applications 快捷方式）与卷名来自 --app-name（纯 + 真实 hdiutil）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  APP_NAME,
  RESOURCE_BUNDLE_NAME,
  appLayout,
  assemblePlan,
  buildOutputDir,
  codesignArgs,
  dmgCreateArgs,
  findNestedMachOFiles,
  isMachO,
  machOArchs,
  parseBuildSwiftAppArgs,
  parseLipoArchs,
  renderInfoPlist,
  runBuildSwiftApp,
  stageDmgVolume,
} from '../../../macos/scripts/build-swift-app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const macosDir = path.resolve(desktopDir, '..', '..', 'macos')
const script = path.join(macosDir, 'scripts', 'build-swift-app.mjs')

/** 组装测试共用的临时输出目录（每个用例独立）。 */
function tempOut() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-swift-app-'))
}

/**
 * 造一个真实（但极小）的 Mach-O 可执行文件——架构断言走 lipo，需要完整
 * Mach-O 头/load command，字节魔数不足以让 lipo 读出架构。测试拿它当假 node。
 */
function fakeMachO(dir, name, arch) {
  const target = path.join(dir, name)
  // 源码走 stdin：sidecar 目录里不能留下 node.c（A5 基名断言只接受 node）。
  execFileSync(
    'cc',
    ['-x', 'c', ...(arch === undefined ? [] : ['-arch', arch]), '-o', target, '-'],
    { input: 'int main(void) { return 0; }\n' },
  )
  chmodSync(target, 0o755)
  return target
}

/** 写一个最小可用的 sidecar 装配目录（真实 Mach-O node + sidecar.js/package.json）。 */
function writeFakeSidecar(dir, nodeArch) {
  writeFileSync(path.join(dir, 'sidecar.js'), '// fake')
  writeFileSync(path.join(dir, 'package.json'), '{}')
  fakeMachO(dir, 'node', nodeArch)
  return dir
}

test('① 参数解析：缺省与覆盖', () => {
  const defaults = parseBuildSwiftAppArgs([])
  assert.equal(defaults.config, 'release')
  assert.equal(defaults.identity, '-')
  assert.equal(defaults.outDir, path.join(macosDir, 'release'))
  assert.equal(defaults.skipBuild, false)
  assert.equal(defaults.noSign, false)
  assert.deepEqual(defaults.swiftArgs, [])

  assert.equal(defaults.arch, null, '缺省不猜宿主：只比对 .app 与 node 的架构交集')

  const parsed = parseBuildSwiftAppArgs([
    '--out', '/tmp/app', '--config', 'debug', '--identity', 'Developer ID Application: X',
    '--skip-build', '--skip-web-dist', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg', '--dry-run',
    '--arch', 'x64', '--swift-args', '--disable-sandbox -Xswiftc -O',
  ])
  assert.equal(parsed.outDir, '/tmp/app')
  assert.equal(parsed.config, 'debug')
  assert.equal(parsed.arch, 'x64')
  assert.throws(() => parseBuildSwiftAppArgs(['--arch', 'mips']), /--arch 只接受 arm64\|x64/)
  assert.equal(parsed.identity, 'Developer ID Application: X')
  assert.equal(parsed.skipBuild, true)
  assert.equal(parsed.skipSidecar, true)
  assert.equal(parsed.noSign, true)
  assert.equal(parsed.dryRun, true)
  assert.deepEqual(parsed.swiftArgs, ['--disable-sandbox', '-Xswiftc', '-O'])
  assert.throws(() => parseBuildSwiftAppArgs(['--bogus']), /未知参数/)

  // 发布腿命名（W-26）：.app 目录名与产物基名可分离（-native 防碰撞）。
  const named = parseBuildSwiftAppArgs([
    '--app-name', 'dsh-chamber-native',
    '--artifact-basename', 'dsh-chamber-native-0.2.2-macos-arm64',
  ])
  assert.equal(named.appName, 'dsh-chamber-native')
  assert.equal(named.artifactBasename, 'dsh-chamber-native-0.2.2-macos-arm64')
})

test('① 布局：资源包在 Contents/Resources（放 .app 根会被 codesign 判未密封）', () => {
  const layout = appLayout('/tmp/out')
  assert.equal(layout.appDir, `/tmp/out/${APP_NAME}.app`)
  assert.equal(layout.executable, `/tmp/out/${APP_NAME}.app/Contents/MacOS/${APP_NAME}`)
  assert.equal(layout.infoPlist, `/tmp/out/${APP_NAME}.app/Contents/Info.plist`)
  // 资源包必须放 Contents/Resources（放 .app 根会被 codesign 判未密封内容；
  // 运行时由 ChamberResources 经 Bundle.main.resourceURL 定位）。
  assert.equal(layout.resourceBundle, `/tmp/out/${APP_NAME}.app/Contents/Resources/${RESOURCE_BUNDLE_NAME}`)
  assert.equal(layout.sidecarDir, `/tmp/out/${APP_NAME}.app/Contents/Resources/sidecar`)
  assert.equal(buildOutputDir('release'), path.join(macosDir, '.build', 'release'))

  // 发布腿命名：.app 目录与 zip/dmg 基名各自可定制。
  const named = appLayout('/tmp/out', 'dsh-chamber-native', 'dsh-chamber-native-0.2.2-macos-arm64')
  assert.equal(named.appDir, '/tmp/out/dsh-chamber-native.app')
  assert.equal(named.executable, '/tmp/out/dsh-chamber-native.app/Contents/MacOS/' + APP_NAME)
  assert.equal(named.zipPath, '/tmp/out/dsh-chamber-native-0.2.2-macos-arm64.zip')
  assert.equal(named.dmgPath, '/tmp/out/dsh-chamber-native-0.2.2-macos-arm64.dmg')
})

test('② Info.plist 渲染：只替换占位符', () => {
  const template = '<key>CFBundleShortVersionString</key><string>__VERSION__</string>'
  assert.equal(
    renderInfoPlist(template, { VERSION: '0.2.2' }),
    '<key>CFBundleShortVersionString</key><string>0.2.2</string>')
  const real = readFileSync(path.join(macosDir, 'Info.plist.template'), 'utf8')
  const rendered = renderInfoPlist(real, { VERSION: '9.9.9' })
  assert.ok(rendered.includes('<string>9.9.9</string>'))
  assert.ok(!rendered.includes('__VERSION__'))
  // E13 深链注册仍在（模板契约）。
  assert.ok(rendered.includes('<string>dsh-chamber</string>'))
})

test('③ 计划文本随开关变化', () => {
  const full = assemblePlan(parseBuildSwiftAppArgs([])).join('\n')
  assert.match(full, /swift build -c release/)
  assert.match(full, /签名（identity=-）/)
  assert.match(full, /zip →/)
  assert.match(full, /dmg →/)

  const minimal = assemblePlan(parseBuildSwiftAppArgs([
    '--skip-build', '--skip-web-dist', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg', '--swift-args', '--disable-sandbox',
  ])).join('\n')
  assert.match(minimal, /复用已有 swift build/)
  assert.match(minimal, /跳过 sidecar 拷贝/)
  assert.match(minimal, /跳过签名/)
  assert.doesNotMatch(minimal, /dmg →/)
})

test('④ --dry-run 子进程：就绪校验、不写盘', () => {
  const out = tempOut()
  try {
    const stdout = execFileSync(process.execPath, [script, '--dry-run', '--out', out], {
      cwd: macosDir,
      encoding: 'utf8',
    })
    assert.match(stdout, /dry-run：模板\/entitlements 就绪/)
    assert.ok(!existsSync(path.join(out, `${APP_NAME}.app`)), 'dry-run 不写盘')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('④ codesignArgs argv：选项先于 --sign，ad-hoc/hardened 分支互斥', () => {
  const adhoc = codesignArgs({ identity: '-' }, '/tmp/x.app', '/tmp/e.plist')
  assert.deepEqual(adhoc, [
    '--force', '--timestamp=none', '--sign', '-', '--entitlements', '/tmp/e.plist', '/tmp/x.app',
  ])
  const hardened = codesignArgs({ identity: 'Developer ID Application: X (TEAM)' }, '/tmp/x.app', '/tmp/e.plist')
  assert.deepEqual(hardened, [
    '--force', '--options', 'runtime', '--sign', 'Developer ID Application: X (TEAM)',
    '--entitlements', '/tmp/e.plist', '/tmp/x.app',
  ])
  // identity 必须紧跟 --sign（否则 codesign 把 --options 当 identity）。
  const signIndex = hardened.indexOf('--sign')
  assert.equal(hardened[signIndex + 1], 'Developer ID Application: X (TEAM)')
  assert.ok(hardened.indexOf('--options') < signIndex, '--options 必须在 --sign 之前')
  assert.ok(hardened.indexOf('--entitlements') > signIndex)
  // hardened 不带 --timestamp=none（公证需安全时间戳）；ad-hoc 不带 --options。
  assert.ok(!hardened.includes('--timestamp=none'))
  assert.ok(!adhoc.includes('--options'))
  // 缺 entitlements 时不得输出字面 "null"。
  assert.ok(!codesignArgs({ identity: '-' }, '/tmp/x.app').includes('null'))
})

test('④b Mach-O 识别 + 嵌套原生文件枚举（公证前置）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-swift-macho-'))
  try {
    const thin = path.join(dir, 'lib.node')
    writeFileSync(thin, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]))
    const fat = path.join(dir, 'nested', 'deep.node')
    mkdirSync(path.dirname(fat), { recursive: true })
    writeFileSync(fat, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0]))
    // 2026-12 P9：FAT_MAGIC_64 两个字节序都必须是 Mach-O（漏判会让 64 位胖二进制
    // 逃避嵌套签名，公证才失败）。
    const fat64 = path.join(dir, 'fat64.node')
    writeFileSync(fat64, Buffer.from([0xca, 0xfe, 0xba, 0xbf, 0, 0, 0, 0]))
    const fat64Swapped = path.join(dir, 'fat64-swapped.node')
    writeFileSync(fat64Swapped, Buffer.from([0xbf, 0xba, 0xfe, 0xca, 0, 0, 0, 0]))
    const notMachO = path.join(dir, 'readme.js')
    writeFileSync(notMachO, 'module.exports = 1')
    assert.equal(isMachO(thin), true)
    assert.equal(isMachO(fat), true)
    assert.equal(isMachO(fat64), true, 'FAT_MAGIC_64 (0xcafebabf) 必须是 Mach-O')
    assert.equal(isMachO(fat64Swapped), true, 'FAT_CIGAM_64 (0xbfbafeca) 必须是 Mach-O')
    assert.equal(isMachO(notMachO), false)
    assert.equal(isMachO(path.join(dir, 'missing')), false)
    assert.deepEqual(findNestedMachOFiles(dir), [fat, fat64, fat64Swapped, thin].sort())
    // fail closed：枚举失败会让未签名的嵌套 Mach-O 逃过 deep 校验，绝不静默返回空表。
    assert.throws(() => findNestedMachOFiles(path.join(dir, 'missing')), /无法读取待枚举目录/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ 真实组装：可执行位 / 资源包 / Info.plist 版本 / 图标', async () => {
  const out = tempOut()
  try {
    const result = await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--skip-build', '--skip-web-dist', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    assert.equal(result.dryRun, false)
    const layout = appLayout(out)
    assert.ok(existsSync(layout.executable), '可执行应存在')
    assert.ok((statSync(layout.executable).mode & 0o111) !== 0, '可执行位应保留')
    assert.ok(existsSync(layout.resourceBundle), 'SwiftPM 资源包应在 Contents/Resources')
    assert.ok(existsSync(path.join(layout.resourceBundle, 'bridge-shim.poc.js')),
      '资源包内应含 A 桥 shim（SwiftPM 资源包为扁平目录）')
    // P8：chamber-bridge.stub.js 是 JS 锁步生成物，无运行期消费者——留在源码树
    // 供 JS 测试断言，但不得进 bundle。
    assert.ok(!existsSync(path.join(layout.resourceBundle, 'chamber-bridge.stub.js')),
      '无运行期消费者的 stub 不得打进 SwiftPM 资源包')
    assert.ok(existsSync(path.join(macosDir, 'Sources', 'DSHChamberPoc', 'Resources', 'chamber-bridge.stub.js')),
      'stub 仍须留在源码树作为 JS 锁步产物')
    const plist = readFileSync(layout.infoPlist, 'utf8')
    const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
    assert.ok(plist.includes(`<string>${desktopPkg.version}</string>`), 'Info.plist 版本 = chamber 版本')
    assert.ok(existsSync(layout.icon), 'icon.icns 应平移')
    // P6：图标引用与 ATS 本地回环放行都必须真的写进产物 plist。
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>icon\.icns<\/string>/,
      'Info.plist 必须引用平移到 Resources/icon.icns 的图标')
    assert.ok(plist.includes('<key>NSAppTransportSecurity</key>'), 'ATS 字典必须存在')
    assert.match(plist, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/,
      'http://127.0.0.1 控制面需要 ATS local networking 放行')
    const lint = spawnSync('plutil', ['-lint', layout.infoPlist], { encoding: 'utf8' })
    assert.equal(lint.status, 0, lint.stdout + lint.stderr)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑥ sidecar 拷贝 + A5 基名反例 loud', async () => {
  const out = tempOut()
  const sidecar = mkdtempSync(path.join(tmpdir(), 'dsh-fake-sidecar-'))
  try {
    writeFakeSidecar(sidecar)
    writeFileSync(path.join(sidecar, 'package.json'), '{}')
    const result = await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--sidecar', sidecar, '--skip-build', '--skip-web-dist', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    const layout = appLayout(out)
    assert.ok(existsSync(path.join(layout.sidecarDir, 'sidecar.js')))
    assert.ok(existsSync(path.join(layout.sidecarDir, 'package.json')))
    assert.ok(existsSync(path.join(layout.sidecarDir, 'node')), '捆绑 node 必须随装配进 .app（P2）')
    assert.ok((statSync(path.join(layout.sidecarDir, 'node')).mode & 0o111) !== 0, 'node 必须可执行')
    assert.ok(result.layout)

    // 反例：node 名字不对（node-v24.18.1）→ A5 loud。
    writeFileSync(path.join(sidecar, 'node-v24.18.1'), 'not a real node')
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--sidecar', sidecar, '--skip-build', '--skip-web-dist', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      /基名必须是 'node'/,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(sidecar, { recursive: true, force: true })
  }
})

test('⑥ 缺 sidecar.js 的装配目录 loud', async () => {
  const out = tempOut()
  const sidecar = mkdtempSync(path.join(tmpdir(), 'dsh-fake-sidecar-'))
  try {
    writeFileSync(path.join(sidecar, 'package.json'), '{}')
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--sidecar', sidecar, '--skip-build', '--skip-web-dist', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      /缺少 sidecar\.js/,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(sidecar, { recursive: true, force: true })
  }
})

test('⑥ 缺捆绑 node / node 无执行位 → loud（runtime 不再静默回落 PATH）', async () => {
  const out = tempOut()
  const sidecar = mkdtempSync(path.join(tmpdir(), 'dsh-fake-sidecar-nonode-'))
  const argv = (dir) => parseBuildSwiftAppArgs([
    '--out', out, '--sidecar', dir, '--skip-build', '--skip-web-dist', '--no-sign', '--no-zip', '--no-dmg',
  ])
  try {
    writeFileSync(path.join(sidecar, 'sidecar.js'), '// fake')
    writeFileSync(path.join(sidecar, 'package.json'), '{}')
    await assert.rejects(
      runBuildSwiftApp(argv(sidecar), { log: () => {}, error: () => {} }),
      /缺少捆绑 node/,
      '没有 node 的 sidecar 曾经能签名并打包成功（P2）',
    )
    const node = path.join(sidecar, 'node')
    writeFileSync(node, '#!/bin/sh\n')
    chmodSync(node, 0o644)
    await assert.rejects(
      runBuildSwiftApp(argv(sidecar), { log: () => {}, error: () => {} }),
      /没有可执行位/,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(sidecar, { recursive: true, force: true })
  }
})

test('⑦ ad-hoc 签名 + codesign 校验通过', async (t) => {
  // codesign 无 --version；用存在性 + 帮助退出码探测（macOS 恒有 /usr/bin/codesign）。
  if (!existsSync('/usr/bin/codesign')) {
    t.skip('codesign 不可用')
    return
  }
  const out = tempOut()
  try {
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--skip-build', '--skip-web-dist', '--skip-sidecar', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    const layout = appLayout(out)
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', layout.appDir], { encoding: 'utf8' })
    assert.equal(verify.status, 0, verify.stderr + verify.stdout)
    const info = spawnSync('codesign', ['-dv', layout.appDir], { encoding: 'utf8' })
    assert.match(`${info.stdout}${info.stderr}`, /Signature=adhoc/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑦ entitlements 文件是合法 plist 且含最小集', () => {
  for (const file of ['entitlements.plist', 'entitlements.node.plist']) {
    const full = path.join(macosDir, file)
    assert.ok(existsSync(full), `${file} 应存在`)
    const lint = spawnSync('plutil', ['-lint', full], { encoding: 'utf8' })
    assert.equal(lint.status, 0, `${file}: ${lint.stdout}${lint.stderr}`)
    const text = readFileSync(full, 'utf8')
    assert.ok(text.includes('com.apple.security.cs.disable-library-validation'))
  }
  // 壳不继承 Electron 的 JIT 权限（那是 V8 需求）。
  assert.ok(!readFileSync(path.join(macosDir, 'entitlements.plist'), 'utf8').includes('allow-jit'))
  assert.ok(readFileSync(path.join(macosDir, 'entitlements.node.plist'), 'utf8').includes('allow-jit'))
})

test('⑩ sidecar 含逃出 bundle 的绝对符号链接 → 归一化后真实 codesign 校验通过', async (t) => {
  // P2 回归锁（2026-09 GUI 验收）：cpSync 会把相对链接绝对化，bundle 内出现
  // 指向构建机源树的链接时 `codesign --verify --strict` 报
  // `invalid destination for symbolic link in bundle`。本用例用**真实 codesign**
  // 覆盖 sidecar 载荷（⑥/⑦ 的 --skip-sidecar 路径看不到这一层）。
  if (!existsSync('/usr/bin/codesign')) {
    t.skip('codesign 不可用')
    return
  }
  const out = tempOut()
  const sidecar = mkdtempSync(path.join(tmpdir(), 'dsh-fake-sidecar-link-'))
  const external = mkdtempSync(path.join(tmpdir(), 'dsh-external-target-'))
  try {
    writeFakeSidecar(sidecar)
    // 树外目标 + 树内目标各一枚绝对链接（cpSync 的产物形状）。
    writeFileSync(path.join(external, 'outside.js'), 'outside\n')
    mkdirSync(path.join(sidecar, 'vendor', 'dsh', 'node_modules', '.bin'), { recursive: true })
    mkdirSync(path.join(sidecar, 'vendor', 'dsh', 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(path.join(sidecar, 'vendor', 'dsh', 'node_modules', 'pkg', 'cli.js'), 'cli\n')
    const bin = path.join(sidecar, 'vendor', 'dsh', 'node_modules', '.bin')
    symlinkSync(path.join(external, 'outside.js'), path.join(bin, 'outside'))
    // 树内**相对**链接（pnpm .bin 的真实形状）：必须原样保留。
    symlinkSync('../pkg/cli.js', path.join(bin, 'inside'))

    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--sidecar', sidecar, '--skip-build', '--skip-web-dist', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    const layout = appLayout(out)

    // ① 不再有逃出 bundle 的链接
    const bundBin = path.join(layout.sidecarDir, 'vendor', 'dsh', 'node_modules', '.bin')
    assert.ok(!lstatSync(path.join(bundBin, 'outside')).isSymbolicLink(), '树外链接必须实体化')
    assert.equal(readFileSync(path.join(bundBin, 'outside'), 'utf8'), 'outside\n')
    assert.ok(lstatSync(path.join(bundBin, 'inside')).isSymbolicLink(), '树内链接必须保留为链接')
    assert.equal(readlinkSync(path.join(bundBin, 'inside')), '../pkg/cli.js', '树内链接保持相对拼写')

    // ② 真实 codesign 校验（ad-hoc 默认身份）
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', layout.appDir], { encoding: 'utf8' })
    assert.equal(verify.status, 0, verify.stderr + verify.stdout)
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(sidecar, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('⑪ 架构：同宿主通过；--arch 反向 loud；.app 与 node 无交集 loud（P4）', async (t) => {
  const binary = path.join(buildOutputDir('release'), APP_NAME)
  if (!existsSync(binary)) {
    t.skip('缺少 swift build 产物（先 swift build -c release）')
    return
  }
  const hostArchs = machOArchs(binary)
  const out = tempOut()
  const same = mkdtempSync(path.join(tmpdir(), 'dsh-arch-same-'))
  const other = mkdtempSync(path.join(tmpdir(), 'dsh-arch-other-'))
  const argv = (dir, extra = []) => parseBuildSwiftAppArgs([
    '--out', out, '--sidecar', dir, '--skip-build', '--skip-web-dist', '--no-sign', '--no-zip', '--no-dmg', ...extra,
  ])
  try {
    writeFakeSidecar(same)
    await assert.doesNotReject(
      runBuildSwiftApp(argv(same), { log: () => {}, error: () => {} }),
      '宿主架构一致的 .app + 捆绑 node 必须通过',
    )
    // 显式 --arch 反向：两个产物都不含它 → loud（App 检查先触发）。
    const opposite = hostArchs.includes('arm64') ? 'x64' : 'arm64'
    await assert.rejects(
      runBuildSwiftApp(argv(same, ['--arch', opposite]), { log: () => {}, error: () => {} }),
      /架构不含/,
    )
    // 交叉编译一枚异架构 node：无交集路径（非显式 --arch 分支）必须 loud——
    // build-sidecar 缺省 darwin-arm64 + 宿主 swift build 正是这个形状。
    const crossArch = hostArchs.includes('arm64') ? 'x86_64' : 'arm64'
    writeFakeSidecar(other, crossArch)
    await assert.rejects(
      runBuildSwiftApp(argv(other), { log: () => {}, error: () => {} }),
      /架构无交集/,
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(same, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
})

test('⑫ lipo 输出解析：x86_64/arm64e 归一化 + 旧版 Non-fat 文案', () => {
  assert.deepEqual(parseLipoArchs('arm64\n'), ['arm64'])
  assert.deepEqual(parseLipoArchs('x86_64 arm64\n'), ['x64', 'arm64'])
  assert.deepEqual(parseLipoArchs('Non-fat file: /bin/ls is architecture: arm64\n'), ['arm64'])
  assert.deepEqual(parseLipoArchs('arm64e\n'), ['arm64'])
})

test('⑬ DMG 卷内容：/Applications 快捷方式 + 卷名来自 --app-name', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-dmg-stage-'))
  try {
    const app = path.join(dir, 'Fake.app')
    mkdirSync(path.join(app, 'Contents'), { recursive: true })
    writeFileSync(path.join(app, 'Contents', 'Info.plist'), 'plist')
    const stage = path.join(dir, 'stage')
    stageDmgVolume(app, stage, 'dsh-chamber-native')
    assert.ok(existsSync(path.join(stage, 'dsh-chamber-native.app', 'Contents', 'Info.plist')),
      'DMG 卷内 app 名必须来自 --app-name')
    const link = path.join(stage, 'Applications')
    assert.ok(lstatSync(link).isSymbolicLink(), 'DMG 卷必须带 /Applications 快捷方式（P7）')
    assert.equal(readlinkSync(link), '/Applications')
    assert.deepEqual(
      dmgCreateArgs({ appName: 'dsh-chamber-native' }, '/tmp/stage', '/tmp/x.dmg'),
      ['create', '-volname', 'dsh-chamber-native', '-srcfolder', '/tmp/stage', '-ov', '-format', 'UDZO', '/tmp/x.dmg'],
      'hdiutil 卷名必须来自 --app-name（不再固定 APP_NAME）',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑬ 真实 DMG：卷内含 .app + /Applications 链接，卷名 = --app-name', async (t) => {
  if (!existsSync('/usr/bin/hdiutil')) {
    t.skip('hdiutil 不可用')
    return
  }
  const out = tempOut()
  try {
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--app-name', 'dsh-chamber-native',
      '--artifact-basename', 'dsh-chamber-native-9.9.9-macos-arm64',
      '--skip-build', '--skip-sidecar', '--skip-web-dist', '--no-sign', '--no-zip',
    ]), { log: () => {}, error: () => {} })
    const dmg = path.join(out, 'dsh-chamber-native-9.9.9-macos-arm64.dmg')
    assert.ok(existsSync(dmg), 'DMG 应产出')
    const mount = path.join(out, 'mnt')
    mkdirSync(mount)
    const attach = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { encoding: 'utf8' })
    assert.equal(attach.status, 0, attach.stderr + attach.stdout)
    try {
      assert.ok(existsSync(path.join(mount, 'dsh-chamber-native.app', 'Contents', 'Info.plist')))
      assert.ok(lstatSync(path.join(mount, 'Applications')).isSymbolicLink(), '挂载卷内应有 /Applications 链接')
      const info = spawnSync('diskutil', ['info', mount], { encoding: 'utf8' })
      assert.match(info.stdout, /Volume Name:\s+dsh-chamber-native/)
    } finally {
      spawnSync('hdiutil', ['detach', mount, '-force'], { encoding: 'utf8' })
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑭ 缺 renderer dist/web 又要产出归档 → fail-closed；--skip-web-dist 显式跳过（S5·F19）', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'dsh-webdist-'))
  try {
    // 归档形态（默认要 zip/dmg）+ 不存在的 web dist → 必须抛，绝不静默产出白屏 .app。
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--web-dist', path.join(out, 'no-such-web-dist'),
        '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip',
      ]), { log: () => {}, error: () => {} }),
      /renderer dist\/web 缺失/,
    )
    // 目录存在但没有 index.html（emptyOutDir 失败留下的空目录）→ 同样必须抛。
    const emptyDist = path.join(out, 'empty-web-dist')
    mkdirSync(emptyDist, { recursive: true })
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--web-dist', emptyDist,
        '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      /renderer dist\/web 缺失或不完整/,
    )
    // 合法 dist（含 index.html）→ 装配成功且文件被拷入（--no-zip --no-dmg 也要求
    // web 界面：release 正式腿就是这个形状）。
    const goodDist = path.join(out, 'good-web-dist')
    mkdirSync(goodDist, { recursive: true })
    writeFileSync(path.join(goodDist, 'index.html'), '<!doctype html><title>t</title>')
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--web-dist', goodDist,
      '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    assert.ok(existsSync(appLayout(out).webDist + '/index.html'), 'web dist 必须随装配进 .app')
    // 显式跳过 → 允许缺位（局部装配形状）。
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--web-dist', path.join(out, 'no-such-web-dist'),
      '--skip-build', '--skip-sidecar', '--skip-web-dist', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})
