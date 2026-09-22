/**
 * build-swift-app.test.mjs —— .app 打包脚本单测（design 25 §3.2/§8.4）
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
 *     可执行位、资源包（只含 bridge-shim.js）、Info.plist 版本/图标/ATS、图标；
 *  ⑤b/⑤c 本地化 fail-closed：缺 .lproj（纯函数）+ 内容级（0 字节/截断/缺 .lproj
 *     的真实装配腿负例，plutil 解析；0 字节 .strings 不得 EXIT=0 报完成）；
 *  ⑥ sidecar 装配拷贝 + A5 基名反例 loud + 缺 node / node 无执行位 loud；
 *  ⑦ ad-hoc 签名 + codesign 校验通过（真实 codesign，无网络）；
 *  ⑧ codesignArgs argv 顺序（ad-hoc/hardened 分支互斥、identity 紧跟 --sign）；
 *  ⑨ entitlements 文件合法 plist 且为最小集；
 *  ⑩ 逃出 bundle 的绝对符号链接 → 归一化后真实 codesign 校验通过；
 *  ④b Mach-O magic 全集（含 FAT_MAGIC_64）+ readdir 失败 fail closed；
 *  ⑪ 架构断言：同宿主通过、--arch 反向 loud、.app 与捆绑 node 无交集 loud；
 *  ⑫ lipo 输出解析（x86_64/arm64e/旧版 Non-fat 文案）；
 *  ⑬ DMG 卷内容（/Applications 快捷方式）与卷名来自 --app-name（纯 + 真实 hdiutil）；
 *  ⑬a/⑬b/⑬c 资源包两形态归一、.DS_Store blob 提取、bplist 读取器（含符号整数）；
 *  ⑬d/⑬e/⑬f/⑬g 内容判据负例、Iloc 记录作用域、facts 分类、装配 shim 失败分支。
 *  ⑰ CFBundleVersion 映射：beta.N → X.Y.Z.N、final → X.Y.Z.final 标记，
 *     同 base 的 beta.N < beta.N+1 < final 且 beta 与 final 不同；
 *  ⑱ --dry-run 计划断言：feed/公钥成对、https、.xml、精确产物名；不写盘；
 *  ⑲ sidecar 符号链接归一化日志不含 undefined（copyTree 无返回值）；
 *  ⑳ 缺图标 fail closed（装配与 dry-run 两处）；㉑ dist/web 过滤
 *     （*.map / .vite 不进 .app，规则与 Electron build.files 对齐）。
 */
import {
  after,
  test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync,
  spawnSync } from 'node:child_process'
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
  MODULE_NAME,
  RESOURCE_BUNDLE_NAME,
  STABLE_BUNDLE_SUFFIX,
  appLayout,
  assemblePlan,
  buildOutputDir,
  bundleVersionFor,
  codesignArgs,
  dmgConvertArgs,
  dmgCreateArgs,
  dryRunPlanReport,
  findNestedMachOFiles,
  isMachO,
  machOArchs,
  parseBuildSwiftAppArgs,
  parseLipoArchs,
  renderInfoPlist,
  findEscapingSymlinks,
  runBuildSwiftApp,
  finderLayoutScript,
  stageDmgVolume,
  resourceBundleResourcesDir,
  assertBridgeShimPresent,
  LOCALIZATIONS,
  localizationDir,
  localizationFile,
  assertLocalizationsPresent,
  assertLocalizationsContent,
  plistLocalizations,
  dsStoreBlobs,
  dsStoreIlocEntries,
  parseBinaryPlist,
  dmgLayoutFacts,
  assertDmgLayoutFacts,
  dsStoreHasIlocEntry,
  DMG_ICON_SIZE,
  DMG_WINDOW,
  DMG_WINDOW_ORIGIN,
  findSparkleFramework,
  shouldCopyWebDistEntry,
  sparkleFeedChannel,
} from '../../../macos/scripts/build-swift-app.mjs'
// 滚动 tag 是 release-artifacts.mjs 的单源——这里按同一常量断言 dry-run
// 计划的通道 URL 形状（build-swift-app.mjs 也从它导入）。
import { NATIVE_BETA_ROLLING_TAG } from '../../../scripts/release/release-artifacts.mjs'

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

/**
 * 造一份最小 SwiftPM 构建输出（macos/.build/<config>/），供真实装配腿的本地化
 * 负例使用：只满足装配步在本地化断言之前的输入契约（可执行占位 + 扁平资源包 +
 * bridge-shim.js + 调用方给的 .lproj 内容）。用独立 config 目录，绝不碰真实
 * .build/release（⑤/⑥/⑦ 等真实装配用例仍以它为输入）；负例在架构断言（lipo）
 * 之前就必须 loud。macos/.build/ 已在 macos/.gitignore 内，调用方负责清理。
 */
function writeFakeSwiftBuild(config, localizations) {
  const outputDir = buildOutputDir(config)
  const bundleDir = path.join(outputDir, RESOURCE_BUNDLE_NAME)
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(path.join(outputDir, MODULE_NAME), '#!/bin/sh\nexit 0\n')
  writeFileSync(path.join(bundleDir, 'bridge-shim.js'), '// fake')
  for (const [locale, content] of Object.entries(localizations)) {
    mkdirSync(localizationDir(bundleDir, locale), { recursive: true })
    writeFileSync(localizationFile(bundleDir, locale), content)
  }
  return { outputDir, bundleDir }
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

  // 发布腿命名：.app 目录名与产物基名可分离（-native 防碰撞）。
  const named = parseBuildSwiftAppArgs([
    '--app-name', 'dsh-chamber',
    '--artifact-basename', 'dsh-chamber-0.2.2-macos-arm64',
  ])
  assert.equal(named.appName, 'dsh-chamber')
  assert.equal(named.artifactBasename, 'dsh-chamber-0.2.2-macos-arm64')
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
  const named = appLayout('/tmp/out', 'dsh-chamber', 'dsh-chamber-0.2.2-macos-arm64')
  assert.equal(named.appDir, '/tmp/out/dsh-chamber.app')
  assert.equal(named.executable, '/tmp/out/dsh-chamber.app/Contents/MacOS/' + APP_NAME)
  assert.equal(named.zipPath, '/tmp/out/dsh-chamber-0.2.2-macos-arm64.zip')
  assert.equal(named.dmgPath, '/tmp/out/dsh-chamber-0.2.2-macos-arm64.dmg')
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

test('②b CFBundleVersion：beta.N 与 final 同 base 不同且有序（S-23）', () => {
  // beta.N → X.Y.Z.N；final → X.Y.Z.<final 标记>（见 bundleVersionFor 注释）。
  assert.equal(bundleVersionFor('0.3.2-beta.0'), '0.3.2.0')
  assert.equal(bundleVersionFor('0.3.2-beta.1'), '0.3.2.1')
  assert.equal(bundleVersionFor('0.3.2-beta.10'), '0.3.2.10')
  assert.equal(bundleVersionFor('0.3.2'), `0.3.2.${STABLE_BUNDLE_SUFFIX}`)

  // Sparkle 把缺失的数字段补 0 后逐段比较；测试用同样的语义比较映射结果。
  const parts = (version) => bundleVersionFor(version).split('.').map(Number)
  const cmp = (left, right) => {
    const a = parts(left)
    const b = parts(right)
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0)
      if (diff !== 0) return Math.sign(diff)
    }
    return 0
  }
  // 排序语义用中性版本号做输入：写死具体发布版本会让 §3 的版本号扫描在
  // 每次 bump 后误报（checklist §3 的扫描面就是这一处）。
  assert.ok(cmp('1.2.3-beta.1', '1.2.3-beta.2') < 0, 'beta.N 必须能看到 beta.N+1')
  assert.ok(cmp('0.3.2-beta.9', '0.3.2-beta.10') < 0, 'beta 序号按数值比较而不是字典序')
  assert.ok(cmp('0.3.2-beta.10', '0.3.2') < 0, 'final 必须大于同 base 的 beta（S-23 的 beta.N→final 路径）')
  assert.ok(cmp('0.3.2', '0.3.3-beta.1') < 0, '下一个 patch 的 beta 大于上一个 final')
  assert.ok(cmp('0.3.2-beta.1', '0.3.2') !== 0, 'beta 与 final 不得映成同一 CFBundleVersion')

  // Apple 规则：只含点分十进制整数；非法版本 loud，绝不产出非数字段。
  for (const value of ['0.3.2-beta.0', '0.3.2-beta.1', '1.2.3']) {
    assert.match(bundleVersionFor(value), /^[0-9]+(\.[0-9]+)*$/)
  }
  assert.throws(() => bundleVersionFor('0.3.2-rc.1'), /无法映射 CFBundleVersion/)
  assert.throws(() => bundleVersionFor(`0.3.2-beta.${STABLE_BUNDLE_SUFFIX}`), /beta 序号越界/)
  // 模板保留唯一的 __BUNDLE_VERSION__ 注入点。
  const template = readFileSync(path.join(macosDir, 'Info.plist.template'), 'utf8')
  assert.match(template, /<key>CFBundleVersion<\/key>\s*<string>__BUNDLE_VERSION__<\/string>/)
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

test('④ --dry-run 子进程：就绪校验、计划打印、不写盘、半配置 loud（G30）', () => {
  const out = tempOut()
  try {
    const stdout = execFileSync(process.execPath, [script, '--dry-run', '--out', out,
      '--sparkle-feed', 'https://github.com/o/r/releases/latest/download/appcast-swift.xml',
      '--sparkle-public-key', 'abc=', '--skip-build'], {
      cwd: macosDir,
      encoding: 'utf8',
    })
    assert.match(stdout, /dry-run：模板\/entitlements 就绪/)
    assert.match(stdout, /dry-run：计划校验通过/)
    assert.match(stdout, /sparkle-feed=https:\/\/github\.com\/o\/r\/releases\/latest\/download\/appcast-swift\.xml/)
    assert.match(stdout, /sparkle-channel=stable（releases\/latest）/, 'S-22：dry-run 计划必须标注通道')
    // 默认产物名与 APP_NAME 同源（= dsh-chamber）。
    assert.match(stdout, new RegExp(`zip=.*${APP_NAME}\\.zip`), 'dry-run 必须打印解析后的精确产物名')
    // dry-run 必须打印本地化的将写入路径（Bundle.main 解析层的确切落点）。
    assert.match(stdout,
      /i18n=en\.lproj → .*Contents\/Resources\/en\.lproj\/Localizable\.strings/,
      'dry-run 必须打印 en.lproj 的装配目标路径')
    assert.match(stdout,
      /i18n=zh-Hans\.lproj → .*Contents\/Resources\/zh-Hans\.lproj\/Localizable\.strings/,
      'dry-run 必须打印 zh-Hans.lproj 的装配目标路径')
    assert.match(stdout, new RegExp(`dmg=.*${APP_NAME}\\.dmg`))
    assert.ok(!stdout.includes('abc='), '公钥值不得回显')
    assert.ok(!existsSync(path.join(out, `${APP_NAME}.app`)), 'dry-run 不写盘')
    // 半配置 feed → 非零退出：CI 的 packaging dry run 真的校验计划，绝不空跑。
    const bad = spawnSync(process.execPath, [script, '--dry-run', '--out', out,
      '--sparkle-feed', 'https://example.com/appcast-swift.xml', '--skip-build'], {
      cwd: macosDir,
      encoding: 'utf8',
    })
    assert.notEqual(bad.status, 0, bad.stdout + bad.stderr)
    assert.match(`${bad.stdout}${bad.stderr}`, /必须成对配置/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('④b dryRunPlanReport：feed/公钥成对、https、.xml、精确产物名（G30）', () => {
  const good = parseBuildSwiftAppArgs([
    '--out', '/tmp/dsh-plan', '--app-name', 'dsh-chamber',
    '--artifact-basename', 'dsh-chamber-9.9.9-macos-arm64',
    '--sparkle-feed', 'https://github.com/o/r/releases/latest/download/appcast-swift.xml',
    '--sparkle-public-key', 'abc=',
  ])
  const report = dryRunPlanReport(good)
  assert.equal(report.layout.zipPath, '/tmp/dsh-plan/dsh-chamber-9.9.9-macos-arm64.zip')
  const text = report.lines.join('\n')
  assert.match(text, /zip=\/tmp\/dsh-plan\/dsh-chamber-9\.9\.9-macos-arm64\.zip/)
  assert.match(text, /dmg=\/tmp\/dsh-plan\/dsh-chamber-9\.9\.9-macos-arm64\.dmg/)
  assert.match(text, /app-name=dsh-chamber；artifact-basename=dsh-chamber-9\.9\.9-macos-arm64/)
  assert.match(text, /sparkle-feed=https:\/\/github\.com\/o\/r\/releases\/latest\/download\/appcast-swift\.xml/)
  assert.match(text, /sparkle-channel=stable（releases\/latest）/, '稳定通道必须按 releases/latest 标注')
  assert.doesNotMatch(text, /abc=/, '公钥值不得回显')
  // 计划文本显式给出两个 .lproj 的装配落点（app-name 派生，不是硬编码）。
  assert.match(text,
    /i18n=en\.lproj → \/tmp\/dsh-plan\/dsh-chamber\.app\/Contents\/Resources\/en\.lproj\/Localizable\.strings/)
  assert.match(text,
    /i18n=zh-Hans\.lproj → \/tmp\/dsh-plan\/dsh-chamber\.app\/Contents\/Resources\/zh-Hans\.lproj\/Localizable\.strings/)

  // beta feed 必须落在滚动 tag 上（beta.N 才能发现 beta.N+1）——dry-run
  // 计划把通道与滚动 tag 一并标注；版本固定 tag 直接 loud。
  const rollingFeed = `https://github.com/o/r/releases/download/${NATIVE_BETA_ROLLING_TAG}/appcast-swift-beta.xml`
  const beta = dryRunPlanReport(parseBuildSwiftAppArgs([
    '--out', '/tmp/dsh-plan',
    '--artifact-basename', 'dsh-chamber-0.3.2-beta.1-macos-arm64',
    '--sparkle-feed', rollingFeed, '--sparkle-public-key', 'abc=',
  ]))
  assert.match(
    beta.lines.join('\n'),
    new RegExp(`sparkle-channel=beta（滚动 tag ${NATIVE_BETA_ROLLING_TAG}`),
    'beta feed 必须标注为滚动通道')
  assert.throws(
    () => dryRunPlanReport(parseBuildSwiftAppArgs([
      '--sparkle-feed', 'https://github.com/o/r/releases/download/v0.3.2-beta.1/appcast-swift-beta.xml',
      '--sparkle-public-key', 'abc=',
    ])),
    /滚动 tag/,
    '版本固定 tag 的 beta feed 必须被拒（beta.N 永远看不到 beta.N+1）',
  )
  assert.throws(
    () => dryRunPlanReport(parseBuildSwiftAppArgs([
      '--sparkle-feed', 'https://github.com/o/r/releases/download/v0.3.2/appcast-swift.xml',
      '--sparkle-public-key', 'abc=',
    ])),
    /releases\/latest/,
    '稳定 appcast 必须落在 releases/latest（版本固定 tag 解析不到）',
  )
  // 未识别的本地 appcast 名仍允许（只做 https/.xml 形状校验），通道标注为未识别。
  const custom = dryRunPlanReport(parseBuildSwiftAppArgs([
    '--sparkle-feed', 'https://example.com/feed.xml', '--sparkle-public-key', 'abc=',
  ]))
  assert.match(custom.lines.join('\n'), /sparkle-channel=（未识别 appcast 名/)
  assert.equal(sparkleFeedChannel(''), null)
  assert.equal(sparkleFeedChannel('https://x/appcast-swift.xml'), 'stable')
  assert.equal(sparkleFeedChannel('https://x/appcast-swift-beta.xml'), 'beta')
  // 未配置 Sparkle → 明确报告更新不可用，而不是半配置。
  assert.match(dryRunPlanReport(parseBuildSwiftAppArgs([])).lines.join('\n'), /sparkle=未配置（更新不可用）/)
  // 半配置 / 明文 feed / 非 appcast → loud。
  assert.throws(
    () => dryRunPlanReport(parseBuildSwiftAppArgs(['--sparkle-feed', 'https://x/appcast-swift.xml'])),
    /必须成对配置/,
  )
  assert.throws(
    () => dryRunPlanReport(parseBuildSwiftAppArgs(['--sparkle-public-key', 'abc='])),
    /必须成对配置/,
  )
  assert.throws(
    () => dryRunPlanReport(parseBuildSwiftAppArgs([
      '--sparkle-feed', 'http://x/appcast-swift.xml', '--sparkle-public-key', 'abc=',
    ])),
    /必须是 https URL/,
  )
  assert.throws(
    () => dryRunPlanReport(parseBuildSwiftAppArgs([
      '--sparkle-feed', 'https://x/feed.json', '--sparkle-public-key', 'abc=',
    ])),
    /必须指向 \.xml appcast/,
  )
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
    // FAT_MAGIC_64 两个字节序都必须是 Mach-O（漏判会让 64 位胖二进制
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
    assert.ok(existsSync(path.join(layout.resourceBundle, 'bridge-shim.js')),
      '资源包内应含 A 桥 shim（SwiftPM 资源包为扁平目录）')
    // chamber-bridge.stub.js 是 JS 锁步生成物，无运行期消费者——留在源码树
    // 供 JS 测试断言，但不得进 bundle。
    assert.ok(!existsSync(path.join(layout.resourceBundle, 'chamber-bridge.stub.js')),
      '无运行期消费者的 stub 不得打进 SwiftPM 资源包')
    // 本地化必须落在 Contents/Resources 根（Bundle.main 与系统框架的
    // 本地化解析层）——资源包内的 .lproj 只服务 Bundle.module，不构成原生面事实。
    for (const locale of LOCALIZATIONS) {
      const file = localizationFile(layout.resourcesDir, locale)
      assert.ok(existsSync(file), `装配后缺 ${locale}.lproj/Localizable.strings：${file}`)
    }
    const plist = readFileSync(layout.infoPlist, 'utf8')
    // 声明面（CFBundleLocalizations）必须与资源集逐字一致——声明了却没资源
    // 会让 Bundle 静默回退 DevelopmentRegion（zh 系统见到英文）。
    assert.deepEqual(plistLocalizations(plist), LOCALIZATIONS,
      'Info.plist 的 CFBundleLocalizations 必须与 LOCALIZATIONS 同源')
    const desktopPkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'))
    assert.ok(plist.includes(`<string>${desktopPkg.version}</string>`), 'Info.plist 版本 = chamber 版本')
    // CFBundleVersion 走 bundleVersionFor 映射，beta 与 final 不同版本。
    assert.ok(plist.includes(`<string>${bundleVersionFor(desktopPkg.version)}</string>`),
      'CFBundleVersion 必须是 S-23 映射（Sparkle 比较键）')
    assert.notEqual(bundleVersionFor(desktopPkg.version), desktopPkg.version.split('-')[0],
      '不得再退化成去掉 beta 后缀的数字段')
    assert.ok(existsSync(layout.icon), 'icon.icns 应平移')
    // 图标引用与 ATS 本地回环放行都必须真的写进产物 plist。
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>icon\.icns<\/string>/,
      'Info.plist 必须引用平移到 Resources/icon.icns 的图标')
    assert.ok(plist.includes('<key>NSAppTransportSecurity</key>'), 'ATS 字典必须存在')
    assert.match(plist, /<key>NSAllowsLocalNetworking<\/key>\s*<true\/>/,
      'http://localhost 控制面需要 ATS local networking 放行')
    // 放行的关键是**正确键名** NSExceptionAllowsInsecureHTTPLoads
    // （NSTemporary... 实测不生效）；localhost 是打包态导航 origin 的例外域，
    // 该键名不得出现在产物 plist 里。
    assert.match(plist,
      /<key>localhost<\/key>\s*<dict>\s*<key>NSIncludesSubdomains<\/key>\s*<false\/>\s*<key>NSExceptionAllowsInsecureHTTPLoads<\/key>\s*<true\/>/,
      'S-45：localhost 例外必须用 NSExceptionAllowsInsecureHTTPLoads 放行本机 HTTP')
    assert.ok(!plist.includes('<key>NSTemporaryExceptionAllowsInsecureHTTPLoads</key>'),
      'S-45：旧键名不得再出现在产物 plist')
    const lint = spawnSync('plutil', ['-lint', layout.infoPlist], { encoding: 'utf8' })
    assert.equal(lint.status, 0, lint.stdout + lint.stderr)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑤b 本地化 fail-closed：缺 .lproj/Localizable.strings 即 loud 带路径（S2）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-lproj-'))
  try {
    // 两个都缺 → 报错必须逐个列出精确路径与来源（响亮，不猜）。
    assert.throws(() => assertLocalizationsPresent(dir, '/tmp/from'),
      (error) => {
        assert.match(error.message, /缺本地化资源/)
        assert.ok(error.message.includes(localizationFile(dir, 'en')), error.message)
        assert.ok(error.message.includes(localizationFile(dir, 'zh-Hans')), error.message)
        assert.ok(error.message.includes('/tmp/from'), '来源必须写进报错')
        return true
      })
    for (const locale of LOCALIZATIONS) {
      mkdirSync(localizationDir(dir, locale), { recursive: true })
      writeFileSync(localizationFile(dir, locale), '"common.ok" = "OK";')
    }
    assert.doesNotThrow(() => assertLocalizationsPresent(dir, '/tmp/from'))
    // 只缺一侧也 loud（半装配绝不放行）。
    rmSync(localizationDir(dir, 'zh-Hans'), { recursive: true, force: true })
    assert.throws(() => assertLocalizationsPresent(dir, '/tmp/from'), /zh-Hans\.lproj/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 声明面解析：缺键 → null（调用方 loud）。CFBundleLocalizations 的逐字一致已由
  // macos/Tests/DSHChamberTests/ShellIdentityTests.swift（plist ↔ ShellPageLanguage）锁住。
  const template = readFileSync(path.join(macosDir, 'Info.plist.template'), 'utf8')
  assert.ok(template.includes('<key>CFBundleDevelopmentRegion</key>'),
    'DevelopmentRegion 必须保持既有声明（en），不得被本地化改造替换')
  assert.match(template, /<key>CFBundleDevelopmentRegion<\/key>\s*<string>en<\/string>/)
  assert.equal(plistLocalizations('<plist></plist>'), null, '缺键必须返回 null 而不是空数组')
})

test('⑤c 本地化内容 fail-closed：0 字节 / 缺 .lproj 的真实装配腿负例（S2）', async () => {
  const out = tempOut()
  // 真实装配腿从 .build/<config> 读输入；用独立 config 目录造最小 SwiftPM 产物，
  // 不碰真实 .build/release（⑤/⑥/⑦ 仍以它为输入）。
  const zeroConfig = 'test-i18n-zero'
  const missingConfig = 'test-i18n-missing'
  try {
    // 内容级断言本身：等字节且 plutil 可解析 → 通过；落点被截断（与源不相等）与
    // 0 字节（字节相等但 plutil 拒绝）→ 都必须 loud 且带落点精确路径。
    const src = mkdtempSync(path.join(tmpdir(), 'dsh-lproj-src-'))
    const dst = mkdtempSync(path.join(tmpdir(), 'dsh-lproj-dst-'))
    try {
      for (const locale of LOCALIZATIONS) {
        mkdirSync(localizationDir(src, locale), { recursive: true })
        mkdirSync(localizationDir(dst, locale), { recursive: true })
        writeFileSync(localizationFile(src, locale), '"common.ok" = "OK";\n')
        writeFileSync(localizationFile(dst, locale), '"common.ok" = "OK";\n')
      }
      assert.doesNotThrow(() => assertLocalizationsContent(src, dst))
      writeFileSync(localizationFile(dst, 'en'), '')
      assert.throws(() => assertLocalizationsContent(src, dst), (error) => {
        assert.match(error.message, /fail-closed/)
        assert.ok(error.message.includes(localizationFile(dst, 'en')), error.message)
        return true
      }, '落点被截断（与源不逐字节相等）必须 loud 带路径')
      // 源也是 0 字节：逐字节相等也过不了 plutil。
      writeFileSync(localizationFile(src, 'en'), '')
      assert.throws(() => assertLocalizationsContent(src, dst), (error) => {
        assert.match(error.message, /fail-closed/)
        assert.match(error.message, /plutil/)
        assert.ok(error.message.includes(localizationFile(dst, 'en')), error.message)
        return true
      }, '0 字节 .strings 必须被 plutil 拦下')
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }

    // 真实装配腿（0 字节）：源里 en.lproj/Localizable.strings 被清空 → 复制后的
    // 内容断言 fail（只做 existsSync 会让这种输入 EXIT=0 报「完成」）。
    writeFakeSwiftBuild(zeroConfig, { en: '', 'zh-Hans': '"common.ok" = "OK";\n' })
    const zeroLayout = appLayout(out)
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--config', zeroConfig, '--skip-build', '--skip-web-dist',
        '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      (error) => {
        assert.match(error.message, /fail-closed/)
        assert.match(error.message, /plutil/)
        assert.ok(error.message.includes(localizationFile(zeroLayout.resourcesDir, 'en')), error.message)
        return true
      },
      '0 字节 .strings 过去只过存在性断言，装配仍报完成（独立审查实测）',
    )
    assert.ok(!existsSync(zeroLayout.infoPlist),
      '内容断言在写 Info.plist 之前 fail——坏的 .app 不得成形')

    // 真实装配腿（缺一个 .lproj）：端到端复现「半本地化」输入，loud 带缺失路径
    // （纯函数单测之外，装配腿自己也要红）。
    const missing = writeFakeSwiftBuild(missingConfig, { en: '"common.ok" = "OK";\n' })
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--config', missingConfig, '--skip-build', '--skip-web-dist',
        '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      (error) => {
        assert.match(error.message, /缺本地化资源/)
        assert.ok(error.message.includes(localizationFile(missing.bundleDir, 'zh-Hans')), error.message)
        return true
      },
      '缺一个 .lproj 的真实装配腿必须 fail（此前只有纯函数负例）',
    )
  } finally {
    rmSync(out, { recursive: true, force: true })
    rmSync(buildOutputDir(zeroConfig), { recursive: true, force: true })
    rmSync(buildOutputDir(missingConfig), { recursive: true, force: true })
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
  // cpSync 会把相对链接绝对化，bundle 内出现
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

    const logs = []
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--sidecar', sidecar, '--skip-build', '--skip-web-dist', '--no-zip', '--no-dmg',
    ]), { log: (line) => logs.push(line), error: () => {} })
    const layout = appLayout(out)

    // ⑲ copyTree 无返回值，归一化日志必须由 normalizeSymlinks 的计数驱动，
    // 不得打印「实体化 undefined 处」。
    assert.ok(!logs.some((line) => line.includes('undefined')), `归一化日志不得含 undefined：${logs.join('\n')}`)
    assert.ok(logs.some((line) => /符号链接归一化 \d+ 处/.test(line)), '真实链接被处理时必须打印实际计数')

    // ① 不得有逃出 bundle 的链接
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
  const binary = path.join(buildOutputDir('release'), MODULE_NAME)
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

test('⑬ DMG 卷内容：.app + /Applications 快捷方式 + Finder 拖拽布局（背景/坐标）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-dmg-stage-'))
  try {
    const app = path.join(dir, 'Fake.app')
    mkdirSync(path.join(app, 'Contents'), { recursive: true })
    writeFileSync(path.join(app, 'Contents', 'Info.plist'), 'plist')
    const stage = path.join(dir, 'stage')
    stageDmgVolume(app, stage, 'dsh-chamber')
    assert.ok(existsSync(path.join(stage, 'dsh-chamber.app', 'Contents', 'Info.plist')),
      'DMG 卷内 app 名必须来自 --app-name')
    const link = path.join(stage, 'Applications')
    assert.ok(lstatSync(link).isSymbolicLink(), 'DMG 卷必须带 /Applications 快捷方式（P7）')
    assert.equal(readlinkSync(link), '/Applications')
    // 背景图随卷走（卷内名固定 background.tiff = electron-builder 同款
    // 双 rep TIFF），否则 Finder 布局落空。
    assert.ok(existsSync(path.join(stage, '.background', 'background.tiff')),
      'DMG 卷必须带 .background/background.tiff 背景图')
    // 可写 UDRW 中间镜像（Finder 要写 .DS_Store；最终 UDZO 由 convert 产出）。
    assert.deepEqual(
      dmgCreateArgs('dsh-chamber', '/tmp/stage', '/tmp/x.rw.dmg'),
      ['create', '-volname', 'dsh-chamber', '-srcfolder', '/tmp/stage', '-fs', 'HFS+', '-format', 'UDRW', '-ov', '/tmp/x.rw.dmg'],
      'hdiutil 卷名必须来自 --app-name（不再固定 APP_NAME），且中间镜像必须是可写 UDRW',
    )
    assert.deepEqual(
      dmgConvertArgs('/tmp/x.rw.dmg', '/tmp/x.dmg'),
      ['convert', '/tmp/x.rw.dmg', '-format', 'UDZO', '-ov', '-o', '/tmp/x.dmg'],
      '最终分发镜像 = UDZO（保留 .DS_Store/.background）',
    )
    // Finder 脚本钉住窗口尺寸/图标大小/背景图/两个坐标（纯函数，无需 GUI）。
    const script = finderLayoutScript('dsh-chamber', 'dsh-chamber')
    for (const anchor of [
      'set the bounds of container window to {200, 120, 740, 500}',
      'set icon size of viewOptions to 128',
      'set background picture of viewOptions to file ".background:background.tiff"',
      'set position of item "dsh-chamber.app" of container window to {130, 220}',
      'set position of item "Applications" of container window to {410, 220}',
    ]) {
      assert.ok(script.includes(anchor), `Finder 布局脚本缺锚点：${anchor}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑬a SwiftPM 资源包两种形态都归一到扁平（swiftbuild = Swift 6.4+ 默认后端）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-bundle-shape-'))
  try {
    // native（旧默认）：扁平资源包。
    const flat = path.join(dir, RESOURCE_BUNDLE_NAME)
    mkdirSync(flat, { recursive: true })
    writeFileSync(path.join(flat, 'bridge-shim.js'), 'shim')
    assert.equal(resourceBundleResourcesDir(flat), flat, '扁平形态必须原样取用')
    // swiftbuild（Swift 6.4+ 默认）：多一层 Contents/Resources，必须收敛到资源目录。
    const nested = path.join(dir, 'nested.bundle')
    mkdirSync(path.join(nested, 'Contents', 'Resources'), { recursive: true })
    writeFileSync(path.join(nested, 'Contents', 'Resources', 'bridge-shim.js'), 'shim')
    assert.equal(resourceBundleResourcesDir(nested), path.join(nested, 'Contents', 'Resources'),
      'swiftbuild 形态必须取 Contents/Resources，否则装配出的资源包没有 bridge-shim.js')
    // 判定走注入的 exists（纯函数可测；目录不存在时保持原样，交给后续 fail-closed 报错）。
    assert.equal(resourceBundleResourcesDir('/nonexistent', () => false), '/nonexistent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('⑬b .DS_Store blob 提取：只认「blob + 前置 u32 长度」的 bplist 记录', () => {
  const payload = Buffer.from('bplist00-fake-payload')
  const record = Buffer.concat([
    Buffer.from([0x05]), Buffer.from('.icvp').subarray(0, 5), Buffer.from('blob'),
    (() => { const l = Buffer.alloc(4); l.writeUInt32BE(payload.length); return l })(),
    payload,
  ])
  const other = Buffer.from('bplist00-not-a-blob-record')
  const buffer = Buffer.concat([record, Buffer.from([0x00, 0x00]), other])
  const blobs = dsStoreBlobs(buffer)
  assert.equal(blobs.length, 1, '只有带 blob 标记的记录才算 blob（否则会把别的 bplist 误当布局）')
  assert.equal(blobs[0].toString('latin1'), payload.toString('latin1'), '载荷切片必须精确等于记录长度')
  assert.deepEqual(dsStoreBlobs(Buffer.from('no plist here')), [])
})
test('⑬c parseBinaryPlist 读真实 bplist：字符串/整数/实数/布尔/data/嵌套字典', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-bplist-'))
  try {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      '<key>name</key><string>dsh-chamber</string>',
      '<key>count</key><integer>2</integer>',
      '<key>size</key><real>128.5</real>',
      '<key>flag</key><true/>',
      '<key>blob</key><data>AAECAw==</data>',
      '<key>nested</key><dict><key>inner</key><string>x</string></dict>',
      '</dict></plist>',
    ].join('\n')
    const xmlPath = path.join(dir, 'fixture.plist')
    const binPath = path.join(dir, 'fixture.bin.plist')
    writeFileSync(xmlPath, xml)
    execFileSync('plutil', ['-convert', 'binary1', '-o', binPath, xmlPath])
    const parsed = parseBinaryPlist(readFileSync(binPath))
    assert.equal(parsed.name, 'dsh-chamber')
    assert.equal(parsed.count, 2)
    assert.equal(parsed.size, 128.5)
    assert.equal(parsed.flag, true)
    assert.deepEqual([...Buffer.from(parsed.blob)], [0, 1, 2, 3], 'data 必须原样给到字节')
    assert.equal(parsed.nested.inner, 'x')
    assert.throws(() => parseBinaryPlist(Buffer.from('not a plist')), /bplist00/)
    // 有符号整数：bplist 整数是二补码（plutil 同语义）。按无符号读会让 -5
    // 变成 18446744073709552000；当前 .icvp 无负数，属潜在缺陷。
    const signedXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict><key>neg</key><integer>-5</integer><key>pos</key><integer>5</integer></dict></plist>',
    ].join('\n')
    const signedXmlPath = path.join(dir, 'signed.plist')
    const signedBinPath = path.join(dir, 'signed.bin.plist')
    writeFileSync(signedXmlPath, signedXml)
    execFileSync('plutil', ['-convert', 'binary1', '-o', signedBinPath, signedXmlPath])
    const signed = parseBinaryPlist(readFileSync(signedBinPath))
    assert.equal(signed.neg, -5, 'plutil 写出的负整数必须按有符号读回')
    assert.equal(signed.pos, 5)
    // 手搓最小 bplist 钉住 1/2 字节宽度的符号扩展（plutil 总用 8 字节）。
    const minimalInt = (marker, bytes) => {
      const offsetTableOffset = 8 + 1 + bytes.length
      return Buffer.concat([
        Buffer.from('bplist00', 'latin1'),
        Buffer.from([marker, ...bytes]),
        Buffer.from([8]),
        Buffer.alloc(6), Buffer.from([1, 1]),
        (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(1n); return b })(),
        (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(0n); return b })(),
        (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(offsetTableOffset)); return b })(),
      ])
    }
    // 语义与 plutil 对齐（`plutil -convert binary1` → `-extract raw`）：
    // 1/2/4/16 字节无符号、只有 8 字节有符号；Apple 对非负值用最小宽度（128 → 1 字节 0x80）。
    assert.equal(parseBinaryPlist(minimalInt(0x10, [0xfb])), 251, '1 字节按无符号（0xfb = 251，不是 -5）')
    assert.equal(parseBinaryPlist(minimalInt(0x10, [0x80])), 128, 'iconSize 形态：1 字节 0x80 = 128')
    assert.equal(parseBinaryPlist(minimalInt(0x11, [0xfe, 0x7f])), 65151, '2 字节按无符号')
    assert.equal(parseBinaryPlist(minimalInt(0x10, [0x7f])), 127, '1 字节正数')
    assert.equal(parseBinaryPlist(minimalInt(0x14, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])), 1,
      '真实 Finder .icvp 的 16 字节整数（viewOptionsVersion）必须读出且不得抛')
    assert.deepEqual(parseBinaryPlist(minimalInt(0x80, [0x05])), { uid: 5 }, 'UID（1 字节）')
    assert.deepEqual(parseBinaryPlist(minimalInt(0x81, [0x01, 0x00])), { uid: 256 }, 'UID（2 字节）')
    // date / UTF-16（含非 BMP）覆盖。
    const richXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict><key>when</key><date>2026-09-20T00:00:00Z</date>',
      '<key>emoji</key><string>😀</string></dict></plist>',
    ].join('\n')
    const richXmlPath = path.join(dir, 'rich.plist')
    const richBinPath = path.join(dir, 'rich.bin.plist')
    writeFileSync(richXmlPath, richXml)
    execFileSync('plutil', ['-convert', 'binary1', '-o', richBinPath, richXmlPath])
    const rich = parseBinaryPlist(readFileSync(richBinPath))
    assert.equal(rich.emoji, '😀', 'UTF-16BE 字符串（代理对）必须正确解码')
    assert.ok(rich.when instanceof Date && rich.when.toISOString().startsWith('2026-09-20'), 'date 必须解析成 Date')
    // 畸形 trailer 护栏（42 字节伪造文件曾让解析吃到 ~3GB RSS）。
    const malformed = Buffer.concat([
      Buffer.from('bplist00', 'latin1'), Buffer.alloc(24),
      Buffer.alloc(6), Buffer.from([0, 1]),
      (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(1000000000n); return b })(),
      Buffer.alloc(8), Buffer.alloc(8),
    ])
    assert.throws(() => parseBinaryPlist(malformed), /非法 bplist 偏移宽度/,
      '非法宽度必须当场抛，不得按伪造计数分配内存')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('⑬d 内容级判据的失败分支：每条断言都有负例（2026-09 审查补强）', () => {
  const alias = Buffer.from('/Volumes/dsh-chamber/.background/background.tiff', 'utf8')
  const base = {
    iconView: { backgroundType: 2, backgroundImageAlias: alias, iconSize: DMG_ICON_SIZE },
    window: { WindowBounds: '{{200, 482}, {540, 380}}' },
    ilocEntries: ['dsh-chamber.app', 'Applications'],
  }
  assert.deepEqual(assertDmgLayoutFacts(base, 'dsh-chamber'), { bounds: '{{200, 482}, {540, 380}}' },
    '合法 facts 必须通过（负例之外的正例）')
  const cases = [
    ['没有 .icvp 记录', { ...base, iconView: null }, /没有 Finder 视图记录/],
    ['纯色背景（backgroundType=1）', { ...base, iconView: { ...base.iconView, backgroundType: 1 } }, /backgroundType=2/],
    ['背景别名为空', { ...base, iconView: { ...base.iconView, backgroundImageAlias: Buffer.alloc(0) } }, /缺 backgroundImageAlias/],
    ['别名指向别处', { ...base, iconView: { ...base.iconView, backgroundImageAlias: Buffer.from('/tmp/other.tiff') } }, /没有指向卷内/],
    ['别名指向另一卷的同名路径', { ...base, iconView: { ...base.iconView, backgroundImageAlias: Buffer.from('/Volumes/dsh-OTHER/.background/background.tiff') } }, /不属于本卷/],
    ['图标尺寸不是 128', { ...base, iconView: { ...base.iconView, iconSize: 64 } }, /图标尺寸未落盘/],
    ['窗口尺寸与背景不符', { ...base, window: { WindowBounds: '{{0, 0}, {800, 600}}' } }, /窗口尺寸未落盘/],
    ['缺 Iloc 记录', { ...base, ilocEntries: [] }, /Iloc）缺失/],
    ['Iloc 只登记了一个条目', { ...base, ilocEntries: ['Applications'] }, /缺条目：dsh-chamber\.app/],
  ]
  for (const [label, facts, pattern] of cases) {
    assert.throws(() => assertDmgLayoutFacts(facts, 'dsh-chamber'), pattern, `负例必须红：${label}`)
  }
})

test('⑬e Iloc 断言只认「名字紧邻 Iloc 记录头」的登记（名字出现在别处不算数）', () => {
  const utf16be = (text) => Buffer.from(text, 'utf16le').swap16()
  // 真实形态：[u16 名长][UTF-16BE 名]["Ilocblob"][u32 坐标长][16 字节坐标]，名字紧邻记录头。
  const entry = (name) => Buffer.concat([
    Buffer.from([0, name.length]), utf16be(name), Buffer.from('Ilocblob', 'latin1'), Buffer.alloc(20),
  ])
  const withIloc = Buffer.concat([entry('dsh-chamber.app'), entry('Applications')])
  assert.equal(dsStoreHasIlocEntry(withIloc, 'dsh-chamber.app'), true)
  assert.equal(dsStoreHasIlocEntry(withIloc, 'Applications'), true)
  assert.deepEqual(dsStoreIlocEntries(withIloc), ['dsh-chamber.app', 'Applications'], '按记录头解出条目名')
  // 名字出现在别处（没有 Ilocblob 相邻）不算登记——全文件子串搜索会假阳性。
  const namesOnly = Buffer.concat([
    Buffer.from('Iloc', 'latin1'), utf16be('dsh-chamber.app'), utf16be('Applications'),
  ])
  assert.equal(dsStoreHasIlocEntry(namesOnly, 'dsh-chamber.app'), false)
  assert.deepEqual(dsStoreIlocEntries(namesOnly), [])
  assert.equal(dsStoreHasIlocEntry(withIloc, ''), false, '空名字恒 false')
  assert.equal(dsStoreHasIlocEntry(withIloc, 'chamber'), false, '子串不算登记')
})

test('⑬f dmgLayoutFacts：注入解析器即可单测记录分类（.icvp / .bwsp / Iloc）', () => {
  const record = (name, payload) => Buffer.concat([
    Buffer.from([name.length]), Buffer.from(name, 'latin1'), Buffer.from('blob', 'latin1'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32BE(payload.length); return b })(),
    payload,
  ])
  const iconViewPayload = Buffer.from('bplist00-icvp', 'latin1')
  const windowPayload = Buffer.from('bplist00-bwsp', 'latin1')
  const ilocEntry = Buffer.concat([
    Buffer.from([0, 'Applications'.length]), Buffer.from('Applications', 'utf16le').swap16(),
    Buffer.from('Ilocblob', 'latin1'), Buffer.alloc(20),
  ])
  const buffer = Buffer.concat([
    record('.icvp', iconViewPayload), record('.bwsp', windowPayload), ilocEntry,
  ])
  const iconView = { backgroundType: 2, backgroundImageAlias: Buffer.from('x'), iconSize: 128 }
  const window = { WindowBounds: '{{1, 2}, {540, 380}}' }
  const facts = dmgLayoutFacts(buffer, {
    parsePlist: (blob) => (blob.equals(iconViewPayload) ? iconView : blob.equals(windowPayload) ? window : null),
  })
  assert.equal(facts.iconView?.backgroundType, 2, '.icvp 记录必须归到 iconView')
  assert.equal(facts.window?.WindowBounds, '{{1, 2}, {540, 380}}', '.bwsp 记录必须归到 window')
  assert.deepEqual(facts.ilocEntries, ['Applications'], 'Iloc 记录头里的条目名必须被解出')
  assert.equal(dsStoreHasIlocEntry(buffer, 'Applications'), true)
  assert.equal(dsStoreHasIlocEntry(buffer, 'dsh-chamber.app'), false)
})

test('⑬g 装配 fail-closed：资源包缺 bridge-shim.js 即 loud', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-shim-guard-'))
  try {
    assert.throws(() => assertBridgeShimPresent(dir, '/tmp/source'), /缺 bridge-shim\.js/,
      '缺 shim 必须抛（否则产出没有桥的 .app）')
    writeFileSync(path.join(dir, 'bridge-shim.js'), 'shim')
    assert.doesNotThrow(() => assertBridgeShimPresent(dir))
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
      '--out', out, '--app-name', 'dsh-chamber',
      '--artifact-basename', 'dsh-chamber-9.9.9-macos-arm64',
      '--skip-build', '--skip-sidecar', '--skip-web-dist', '--no-sign', '--no-zip',
    ]), { log: () => {}, error: () => {} })
    const dmg = path.join(out, 'dsh-chamber-9.9.9-macos-arm64.dmg')
    assert.ok(existsSync(dmg), 'DMG 应产出')
    const mount = path.join(out, 'mnt')
    mkdirSync(mount)
    const attach = spawnSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { encoding: 'utf8' })
    assert.equal(attach.status, 0, attach.stderr + attach.stdout)
    try {
      assert.ok(existsSync(path.join(mount, 'dsh-chamber.app', 'Contents', 'Info.plist')))
      assert.ok(lstatSync(path.join(mount, 'Applications')).isSymbolicLink(), '挂载卷内应有 /Applications 链接')
      const info = spawnSync('diskutil', ['info', mount], { encoding: 'utf8' })
      assert.match(info.stdout, /Volume Name:\s+dsh-chamber/)
      // 内容级：.DS_Store 必须真的写着背景=图像 + 指向卷内背景图的别名 + 窗口尺寸 + 两条坐标。
      // 只查「文件在」会放过「设了但没落盘」的 DMG——那正是「没有拖拽提示」的形态。
      const dsStoreBuffer = readFileSync(path.join(mount, '.DS_Store'))
      const facts = dmgLayoutFacts(dsStoreBuffer)
      assert.equal(facts.iconView?.backgroundType, 2, 'backgroundType=2（图像背景）必须落盘')
      const alias = facts.iconView?.backgroundImageAlias
      assert.ok(alias instanceof Uint8Array && alias.length > 0, 'backgroundImageAlias 必须非空')
      const aliasText = Buffer.from(alias).toString('latin1')
      assert.ok(aliasText.includes('.background') && aliasText.includes('background.tiff'),
        '背景别名必须指向卷内 .background/background.tiff')
      assert.equal(facts.iconView?.iconSize, DMG_ICON_SIZE)
      const bounds = facts.window?.WindowBounds
      assert.ok(typeof bounds === 'string' && bounds.startsWith('{{' + DMG_WINDOW_ORIGIN.x + ', ')
        && bounds.endsWith(', {' + DMG_WINDOW.width + ', ' + DMG_WINDOW.height + '}}'),
        `窗口尺寸必须落盘（y 随屏幕取整，不比），实际 ${bounds}`)
      assert.ok(dsStoreHasIlocEntry(dsStoreBuffer, 'dsh-chamber.app'))
      assert.ok(dsStoreHasIlocEntry(dsStoreBuffer, 'Applications'), 'Iloc 必须登记两个条目')
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
    // 装配门还会断言**已拷入字节**携带 scoper 标记，因此夹具
    // 必须是一个真实的页面产物形状，而不是只有一个 index.html。
    const goodDist = path.join(out, 'good-web-dist')
    mkdirSync(path.join(goodDist, 'assets'), { recursive: true })
    writeFileSync(path.join(goodDist, 'index.html'), '<!doctype html><title>t</title><script src="/assets/main-x.js"></script>')
    writeFileSync(
      path.join(goodDist, 'assets', 'main-x.js'),
      'data-chamber-svg-scope chamber-csvg globalThis.__chamberSvgScopeInstalled = installSvgResourceScope()',
    )
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--web-dist', goodDist,
      '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    assert.ok(existsSync(appLayout(out).webDist + '/index.html'), 'web dist 必须随装配进 .app')
    // 负控 1：有 index.html 但没有可检查的页面 chunk → fail-closed（否则空壳能进 .app）。
    const noChunk = path.join(out, 'no-chunk-web-dist')
    mkdirSync(noChunk, { recursive: true })
    writeFileSync(path.join(noChunk, 'index.html'), '<!doctype html><title>t</title>')
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--web-dist', noChunk,
        '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      /没有可检查的页面 chunk/,
    )
    // 负控 2：有 chunk 但构建把 scoper 摇掉了（缺标记）→ fail-closed。
    const staleChunk = path.join(out, 'stale-web-dist')
    mkdirSync(path.join(staleChunk, 'assets'), { recursive: true })
    writeFileSync(path.join(staleChunk, 'index.html'), '<!doctype html><title>t</title>')
    writeFileSync(path.join(staleChunk, 'assets', 'main-x.js'), 'export const nothing = 1')
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--web-dist', staleChunk,
        '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      /没有任何 chunk 携带 SVG scoper 标记/,
    )
    // 显式跳过 → 允许缺位（局部装配形状）。
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--web-dist', path.join(out, 'no-such-web-dist'),
      '--skip-build', '--skip-sidecar', '--skip-web-dist', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑮ Sparkle 装配面：plist 注入 + 计划文本 + 框架定位（S-01 / 裁决 D-1 选 B）', async () => {
  // 未配置 → 两个键是空串（壳据此判为不可用，不点亮「检查更新…」）。
  const bare = renderInfoPlist('A=__SPARKLE_FEED_URL__/__SPARKLE_PUBLIC_ED_KEY__/__VERSION__', {
    SPARKLE_FEED_URL: '', SPARKLE_PUBLIC_ED_KEY: '', VERSION: '1.2.3',
  })
  assert.equal(bare, 'A=//1.2.3')
  const configured = renderInfoPlist('F=__SPARKLE_FEED_URL__ K=__SPARKLE_PUBLIC_ED_KEY__', {
    SPARKLE_FEED_URL: 'https://example.com/appcast-swift.xml', SPARKLE_PUBLIC_ED_KEY: 'abc=',
  })
  assert.equal(configured, 'F=https://example.com/appcast-swift.xml K=abc=')

  const withKeys = parseBuildSwiftAppArgs(['--sparkle-feed', 'https://example.com/a.xml', '--sparkle-public-key', 'abc='])
  assert.equal(withKeys.sparkleFeed, 'https://example.com/a.xml')
  assert.equal(withKeys.sparklePublicKey, 'abc=')
  const plan = assemblePlan(withKeys).join('\n')
  assert.match(plan, /\[2b\] 嵌入 Sparkle\.framework/)
  assert.doesNotMatch(assemblePlan(parseBuildSwiftAppArgs([])).join('\n'), /\[2b\]/, '未配置时计划里没有 Sparkle 步')

  // findSparkleFramework：SwiftPM 二进制制品的路径形态（用假树验证定位逻辑）。
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-sparkle-'))
  try {
    assert.equal(findSparkleFramework(root), null, '没有 artifacts 目录 → null')
    const slice = path.join(root, '.build', 'artifacts', 'sparkle', 'Sparkle', 'Sparkle.xcframework', 'macos-arm64_x86_64', 'Sparkle.framework')
    mkdirSync(slice, { recursive: true })
    assert.equal(findSparkleFramework(root, 'arm64'), slice)
    const other = path.join(root, '.build', 'artifacts', 'sparkle', 'Sparkle', 'Sparkle.xcframework', 'macos-x86_64', 'Sparkle.framework')
    mkdirSync(other, { recursive: true })
    assert.equal(findSparkleFramework(root, 'x64'), other, '宿主架构 slice 优先')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('⑯ Sparkle 嵌入装配：framework 就位 + 链接/ rpath + 无逃逸符号链接 + 深度校验', async (t) => {
  // 依赖解析成功（SwiftPM 制品在 .build/artifacts）才跑；没解析的环境跳过而不是假绿。
  const framework = findSparkleFramework(macosDir)
  if (framework === null) {
    t.skip('本机未解析 Sparkle 制品（swift package resolve）')
    return
  }
  const out = tempOut()
  try {
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--skip-build', '--skip-web-dist', '--skip-sidecar', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    const layout = appLayout(out)
    const embedded = path.join(layout.frameworksDir, 'Sparkle.framework')
    assert.ok(existsSync(path.join(embedded, 'Versions', 'B', 'Sparkle')),
      'Sparkle 可执行文件必须在 Contents/Frameworks/Sparkle.framework 里')
    assert.ok(existsSync(path.join(embedded, 'Versions', 'B', 'Updater.app')),
      'Sparkle 的 Updater.app 必须随框架一起嵌入（安装腿）')
    // 符号链接必须保持相对目标（绝对目标 = 逃出 bundle；物化 = framework 格式歧义）。
    assert.deepEqual(findEscapingSymlinks(embedded), [])
    assert.equal(readlinkSync(path.join(embedded, 'Sparkle')), 'Versions/Current/Sparkle')
    // 可执行既链接 @rpath 的框架，又带 @executable_path/../Frameworks 的 rpath。
    const linked = spawnSync('otool', ['-L', layout.executable], { encoding: 'utf8' }).stdout
    assert.match(linked, /@rpath\/Sparkle\.framework\/Versions\/B\/Sparkle/)
    const load = spawnSync('otool', ['-l', layout.executable], { encoding: 'utf8' }).stdout
    assert.match(load, /@executable_path\/\.\.\/Frameworks/)
    // 嵌套 bundle（framework 及 Updater.app / XPCServices）逐个封装后主签名才成立。
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', layout.appDir], { encoding: 'utf8' })
    assert.equal(verify.status, 0, verify.stderr + verify.stdout)
    const nested = spawnSync('codesign', ['-dv', path.join(embedded, 'Versions', 'B', 'Updater.app')], { encoding: 'utf8' })
    assert.match(`${nested.stdout}${nested.stderr}`, /Signature=adhoc/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('⑳ G38 缺图标 fail closed：装配与 dry-run 计划都不接受无图标 .app', async () => {
  const out = tempOut()
  try {
    // electron-builder 在缺 mac.icon 时抛 InvalidConfigurationError；Swift 装配
    // 必须同样致命，否则能签名打包出无图标 .app。
    const missing = path.join(out, 'no-such-icon.icns')
    await assert.rejects(
      runBuildSwiftApp(parseBuildSwiftAppArgs([
        '--out', out, '--icon', missing,
        '--skip-build', '--skip-web-dist', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
      ]), { log: () => {}, error: () => {} }),
      /缺少图标/,
    )
    assert.throws(
      () => dryRunPlanReport(parseBuildSwiftAppArgs(['--icon', missing])),
      /缺少图标/,
      'dry-run 声称校验计划：缺图标也必须在计划期红',
    )
    // 图标就绪时计划文本显式报告路径（可观察的装配输入）。
    const plan = dryRunPlanReport(parseBuildSwiftAppArgs([])).lines.join('\n')
    assert.match(plan, /icon=.*icon\.icns（就绪）/)
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

test('㉑ G40 dist/web 过滤：*.map 与 .vite/ 不进 .app（与 Electron build.files 对齐）', async () => {
  // 纯函数面：Electron build.files 的两条排除（!dist/**/*.map、!dist/.vite/**）。
  assert.equal(shouldCopyWebDistEntry('index.html'), true)
  assert.equal(shouldCopyWebDistEntry('assets/app.js'), true)
  assert.equal(shouldCopyWebDistEntry('perf-sizes.json'), true,
    'Electron build.files 也随包 perf-sizes.json（只排除 map 与 .vite）')
  assert.equal(shouldCopyWebDistEntry('assets/app.js.map'), false)
  assert.equal(shouldCopyWebDistEntry('deep/nested/chunk.js.map'), false)
  assert.equal(shouldCopyWebDistEntry('.vite'), false)
  assert.equal(shouldCopyWebDistEntry('.vite/manifest.json'), false)
  assert.equal(shouldCopyWebDistEntry('assets/.vite/manifest.json'), false)
  assert.equal(shouldCopyWebDistEntry('assets/vite.config.js'), true,
    '只有 .vite 目录/ .map 后缀被排除，不做子串误伤')

  const out = tempOut()
  try {
    const dist = path.join(out, 'web-dist')
    mkdirSync(path.join(dist, 'assets', '.vite'), { recursive: true })
    mkdirSync(path.join(dist, '.vite'), { recursive: true })
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html>')
    writeFileSync(path.join(dist, 'perf-sizes.json'), '{}')
    // 装配门要求真实页面 chunk 携带 scoper 标记（本用例测的是过滤规则，
    // 因此夹具必须是「合法页面产物」形状，否则会被那道门先拦下）。
    writeFileSync(
      path.join(dist, 'assets', 'app.js'),
      'data-chamber-svg-scope chamber-csvg globalThis.__chamberSvgScopeInstalled = installSvgResourceScope()',
    )
    writeFileSync(path.join(dist, 'assets', 'app.js.map'), '{"version":3}')
    writeFileSync(path.join(dist, '.vite', 'manifest.json'), '{"a":1}')
    writeFileSync(path.join(dist, 'assets', '.vite', 'manifest.json'), '{"b":2}')
    await runBuildSwiftApp(parseBuildSwiftAppArgs([
      '--out', out, '--web-dist', dist,
      '--skip-build', '--skip-sidecar', '--no-sign', '--no-zip', '--no-dmg',
    ]), { log: () => {}, error: () => {} })
    const bundled = appLayout(out).webDist
    assert.ok(existsSync(path.join(bundled, 'index.html')), 'index.html 必须在')
    assert.ok(existsSync(path.join(bundled, 'assets', 'app.js')), '正常资源必须在')
    assert.ok(existsSync(path.join(bundled, 'perf-sizes.json')),
      'Electron 同款过滤不含 perf-sizes.json——不得多删（跨侧过滤是同一集合）')
    assert.ok(!existsSync(path.join(bundled, 'assets', 'app.js.map')), '源码映射不得进 .app')
    assert.ok(!existsSync(path.join(bundled, '.vite', 'manifest.json')), '.vite 清单不得进 .app')
    assert.ok(!existsSync(path.join(bundled, 'assets', '.vite', 'manifest.json')),
      '任意层级的 .vite 目录都不得进 .app')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
})

// 打包套件每次运行都会为 mkdtemp 出的 .app 新增 LaunchServices 注册，而 lsregister 不会
// 随目录删除自动回收（一次运行就留下多条指向已删除路径的记录）。套件结束
// 前定向注销本套件前缀的临时注册；`/Volumes/*` 卷路径记录无法用 -u 撤销（README 已登记）。
after(() => {
  const lsregister = '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'
  const dump = spawnSync(lsregister, ['-dump'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (dump.status !== 0 || typeof dump.stdout !== 'string') return
  for (const match of dump.stdout.matchAll(/^ *path: *(\/private\/var\/folders\/[^ ]*dsh-swift-app-[^ ]*\.app) \(0x[0-9a-f]+\)$/gm)) {
    spawnSync(lsregister, ['-u', match[1]], { encoding: 'utf8' })
  }
})
