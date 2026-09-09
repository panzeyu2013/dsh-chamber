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
 *     可执行位、资源包、Info.plist 版本、图标；
 *  ⑥ sidecar 装配拷贝 + A5 基名反例 loud；
 *  ⑦ ad-hoc 签名 + codesign 校验通过（真实 codesign，无网络）；
 *  ⑧ codesignArgs argv 顺序（ad-hoc/hardened 分支互斥、identity 紧跟 --sign）；
 *  ⑨ entitlements 文件合法 plist 且为最小集。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
  findNestedMachOFiles,
  isMachO,
  parseBuildSwiftAppArgs,
  renderInfoPlist,
  runBuildSwiftApp,
} from '../../../macos/scripts/build-swift-app.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(here, '..')
const macosDir = path.resolve(desktopDir, '..', '..', 'macos')
const script = path.join(macosDir, 'scripts', 'build-swift-app.mjs')

/** 组装测试共用的临时输出目录（每个用例独立）。 */
function tempOut() {
  return mkdtempSync(path.join(tmpdir(), 'dsh-swift-app-'))
}

test('① 参数解析：缺省与覆盖', () => {
  const defaults = parseBuildSwiftAppArgs([])
  assert.equal(defaults.config, 'release')
  assert.equal(defaults.identity, '-')
  assert.equal(defaults.outDir, path.join(macosDir, 'release'))
  assert.equal(defaults.skipBuild, false)
  assert.equal(defaults.noSign, false)
  assert.deepEqual(defaults.swiftArgs, [])

  const parsed = parseBuildSwiftAppArgs([
    '--out', '/tmp/app', '--config', 'debug', '--identity', 'Developer ID Application: X',
    '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg', '--dry-run',
    '--swift-args', '--disable-sandbox -Xswiftc -O',
  ])
  assert.equal(parsed.outDir, '/tmp/app')
  assert.equal(parsed.config, 'debug')
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
    '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg', '--swift-args', '--disable-sandbox',
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
    const notMachO = path.join(dir, 'readme.js')
    writeFileSync(notMachO, 'module.exports = 1')
    assert.equal(isMachO(thin), true)
    assert.equal(isMachO(fat), true)
    assert.equal(isMachO(notMachO), false)
    assert.equal(isMachO(path.join(dir, 'missing')), false)
    assert.deepEqual(findNestedMachOFiles(dir), [fat, thin].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑤ 真实组装：可执行位 / 资源包 / Info.plist 版本 / 图标', async () => {
  const out = tempOut()
  try {
    const result = await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    assert.equal(result.dryRun, false)
    const layout = appLayout(out)
    assert.ok(existsSync(layout.executable), '可执行应存在')
    assert.ok((statSync(layout.executable).mode & 0o111) !== 0, '可执行位应保留')
    assert.ok(existsSync(layout.resourceBundle), 'SwiftPM 资源包应在 Contents/Resources')
    assert.ok(existsSync(path.join(layout.resourceBundle, 'bridge-shim.poc.js')),
      '资源包内应含 A 桥 shim（SwiftPM 资源包为扁平目录）')
    const plist = readFileSync(layout.infoPlist, 'utf8')
    const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
    assert.ok(plist.includes(`<string>${desktopPkg.version}</string>`), 'Info.plist 版本 = chamber 版本')
    assert.ok(existsSync(layout.icon), 'icon.icns 应平移')
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
    writeFileSync(path.join(sidecar, 'sidecar.js'), '// fake')
    writeFileSync(path.join(sidecar, 'package.json'), '{}')
    const result = await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--sidecar', sidecar, '--skip-build', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    const layout = appLayout(out)
    assert.ok(existsSync(path.join(layout.sidecarDir, 'sidecar.js')))
    assert.ok(existsSync(path.join(layout.sidecarDir, 'package.json')))
    assert.ok(result.layout)

    // 反例：node 名字不对（node-v24.18.1）→ A5 loud。
    writeFileSync(path.join(sidecar, 'node-v24.18.1'), 'not a real node')
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--sidecar', sidecar, '--skip-build', '--no-sign', '--no-zip', '--no-dmg',
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
        '--out', out, '--sidecar', sidecar, '--skip-build', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      /缺少 sidecar\.js/,
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
      '--out', out, '--skip-build', '--skip-sidecar', '--no-zip', '--no-dmg',
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
