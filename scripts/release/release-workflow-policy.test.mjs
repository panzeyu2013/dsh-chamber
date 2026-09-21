import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { compareReleaseVersions, releaseChannel } from './release-semver.mjs'
import {
  NATIVE_BETA_ROLLING_TAG,
  NATIVE_STABLE_ZIP_PATTERN,
  nativeAppcastDownloadPrefix,
  nativeBetaRollingDownloadPrefix,
  nativeEnclosureUrl,
  nativeMacArtifacts,
  nativeMacFeedUrl,
} from './release-artifacts.mjs'
import { REQUIRED_JOB_STEPS, REQUIRED_JOBS, judgeCandidates, judgeRun, pickCandidateRuns } from './verify-release-ci-proof.mjs'


/** Slice one job's text out of a workflow file (top-level job keys are 2-space indented). */
function jobBlock(text, name) {
  const match = text.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z][a-z0-9-]*:\\n|$)`))
  assert.ok(match, `workflow must define a ${name} job`)
  return match[1]
}

const workflow = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')
const desktopPackage = JSON.parse(
  readFileSync(new URL('../../packages/desktop/package.json', import.meta.url), 'utf8'),
)

function between(startMarker, endMarker) {
  const start = workflow.indexOf(startMarker)
  const end = workflow.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(start, -1, `missing release marker: ${startMarker}`)
  assert.notEqual(end, -1, `missing following release marker: ${endMarker}`)
  return workflow.slice(start, end)
}

const tagBinding = between(
  '      - name: Bind release tag to the checked-out commit',
  '      - name: Assert version matches package.json',
)
const prepare = between(
  '      - name: Refuse published release and replace stale drafts for this tag',
  '      - name: Create GitHub Release (draft)',
)
const createJob = between('\n  create-release:', '\n  validation:')
const create = between('      - name: Create GitHub Release (draft)', '\n  validation:')
// 与 swiftBuild 同一纪律（2026-12 对抗复核）：整行注释必须先剥掉，否则被 `#` 注释掉的 release 步骤仍能满足 includes(gate) 断言。
const validation = between('\n  validation:', '\n  build-gateway:')
  .split('\n')
  .filter((line) => !/^[ \t]*#/.test(line))
  .join('\n')
const gatewayBuild = between('\n  build-gateway:', '\n  build-macos:')
const macBuild = between('\n  build-macos:', '\n  build-windows:')
const windowsBuild = between('\n  build-windows:', '\n  build-linux:')
const linuxBuild = between('\n  build-linux:', '\n  build-swift:')
// 2026-12 验证轮：整行注释必须先剥掉，否则被 `#` 注释掉的命令仍能满足锚点断言（notarytool 提交被注释后测试仍绿）；所有 swiftBuild.* 断言只看代码行。
const swiftBuild = between('\n  build-swift:', '\n  finalize-release:')
  .split('\n')
  .filter((line) => !/^[ \t]*#/.test(line))
  .join('\n')

assert.match(tagBinding, /git rev-parse "\$\{TAG\}\^\{commit\}"/)
assert.match(tagBinding, /TAG_SHA.*RELEASE_SHA/)
assert.match(workflow, /node scripts\/release\/release-preflight\.mjs "\$VERSION" --versions-only/)
assert.doesNotMatch(workflow, /for PKG in/)
assert.doesNotMatch(workflow, /all \d+ chamber packages/i)
assert.match(workflow, /release version must be canonical SemVer/)
assert.doesNotMatch(workflow, /VERSION="\$\{\{[^\n]*outputs\.version/)
assert.match(workflow, /group: release-publish/)
assert.match(workflow, /cancel-in-progress: false/)
assert.match(workflow, /create-release:\n(?:\s+#[^\n]*\n)*\s+needs: validation/)
assert.match(prepare, /if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/)
assert.match(prepare, /gh api --paginate --slurp/)
assert.match(prepare, /\.draft/)
assert.match(prepare, /PUBLISHED_IDS/)
assert.match(prepare, /refusing destructive rerun/)
assert.ok(
  prepare.indexOf('refusing destructive rerun') < prepare.indexOf('gh api -X DELETE'),
  'published-release guard must run before any draft deletion',
)

assert.match(create, /if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/)
assert.match(create, /target_commitish: \$\{\{ github\.sha \}\}/)
assert.match(create, /draft: true/)
assert.match(createJob, /Require macOS release signing credentials before mutation/)
assert.match(createJob, /formal releases require CSC_LINK/)
assert.ok(
  createJob.indexOf('Require macOS release signing credentials before mutation') <
    createJob.indexOf('Refuse published release and replace stale drafts for this tag'),
  'formal signing credentials must be verified before any GitHub Release mutation',
)
assert.doesNotMatch(workflow, /npm publish|npm dist-tag/)
assert.match(gatewayBuild, /sha256sum/)
assert.match(gatewayBuild, /packages\/gateway\/release\/\*\.tgz\.sha256/)
assert.match(gatewayBuild, /Upload gateway package to the draft release/)
// --- Swift native shell leg (design 25, W-26) -----------------------------
// Native artifacts ship from the same tag under a -native name; the dry run is
// credential-free and the formal run fail-closed on the signing identity (A6: missing Apple
// credentials block the release, never an ad-hoc downgrade), and the leg sits between
// build-linux and finalize-release. 2026-12 audit P1: the old alternation matches were
// satisfiable by the wrong code and staple-before-archive order was unpinned, so every claim
// is now an exact string or an order assertion.
assert.match(swiftBuild, /pnpm run build:sidecar/)
assert.match(swiftBuild, /pnpm run build:swift-app --out macos\/release/)
assert.ok(swiftBuild.includes('--app-name dsh-chamber'))
assert.ok(swiftBuild.includes('--artifact-basename "dsh-chamber-${VERSION}-macos-arm64"'),
  'the uploaded .zip/.dmg basename must be exact (a -native substring is not enough)')
assert.ok(swiftBuild.includes('--identity "$IDENTITY"'),
  'the resolved Developer ID identity must actually be passed to build:swift-app')
assert.match(swiftBuild, /dry_run/, 'the native leg must branch on the dry-run input')
// Formal leg is credential fail-closed: no CSC_LINK or no Developer ID identity in the
// imported p12 → red; the no-credentials path is the explicit dry-run branch only.
assert.ok(
  swiftBuild.includes('test -n "${CSC_LINK:-}" || { echo "::error::formal Swift release requires CSC_LINK"; exit 1; }'),
  'formal native release must fail closed when CSC_LINK is absent',
)
assert.ok(swiftBuild.includes('no Developer ID Application identity in CSC_LINK'),
  'formal native release must fail closed when the p12 carries no Developer ID identity')
// Formal leg assembles+signs only (--no-zip --no-dmg): archives are made AFTER
// notarization+stapling, otherwise the uploaded .app has no ticket. The array uses the
// bash-3.2-safe guarded expansion (macOS runner bash + `set -u`: a bare
// "${ARTIFACT_ARGS[@]}" on the empty dry-run array is an unbound-variable error), so pin
// the value and exactly two expansions.
assert.ok(swiftBuild.includes('ARTIFACT_ARGS=(--no-zip --no-dmg)'),
  'the formal leg must defer zip/dmg creation until after stapling')
assert.ok(
  swiftBuild.includes('if [[ "$DRY_RUN" != "true" ]]; then')
  && swiftBuild.indexOf('ARTIFACT_ARGS=(--no-zip --no-dmg)')
    > swiftBuild.indexOf('if [[ "$DRY_RUN" != "true" ]]; then'),
  '--no-zip/--no-dmg are the FORMAL branch, never the dry run',
)
assert.ok(swiftBuild.includes('${ARTIFACT_ARGS[@]+"${ARTIFACT_ARGS[@]}"}'),
  'the artifact args must use the bash-3.2-guarded array expansion')
assert.equal((swiftBuild.split('ARTIFACT_ARGS[@]').length - 1), 2,
  'ARTIFACT_ARGS[@] must be expanded exactly twice (guard + value)')
// Notarize+staple the .app BEFORE any distribution archive: a zip/dmg generated earlier
// ships an unticketed app (offline Gatekeeper rejects it). The .dmg is stapled after creation.
const notarySubmit = swiftBuild.indexOf('xcrun notarytool submit')
const dmgSubmit = swiftBuild.indexOf('xcrun notarytool submit "${BASE}.dmg"')
const appStaple = swiftBuild.indexOf('xcrun stapler staple "$APP"')
const appValidate = swiftBuild.indexOf('xcrun stapler validate "$APP"')
const zipWrite = swiftBuild.indexOf('ditto -c -k --sequesterRsrc --keepParent "$APP" "${BASE}.zip"')
// 2026-09 P7 补强：DMG 卷内容与 Finder 拖拽布局由 macos/scripts/dmg.mjs **单源**实现
// （本地装配腿 import 同模块），workflow 只调用该 CLI；顺序不变量锚调用点，卷内断言锚共享模块。
const dmgCreate = swiftBuild.indexOf(
  'node macos/scripts/dmg.mjs --app "$APP" --app-name dsh-chamber --out "${BASE}.dmg"')
const dmgStaple = swiftBuild.indexOf('xcrun stapler staple "${BASE}.dmg"')
assert.ok(notarySubmit !== -1, 'the formal leg must submit the app to notarytool')
assert.ok(appStaple !== -1, 'the formal leg must staple the app')
assert.ok(appStaple > notarySubmit, 'staple must follow the notarytool submit')
assert.ok(appValidate > appStaple, 'the stapled app must be validated')
assert.ok(zipWrite > appStaple, 'the distribution zip must be written AFTER the app is stapled')
assert.ok(dmgCreate > appStaple, 'the distribution dmg must be created AFTER the app is stapled')
assert.ok(dmgSubmit !== -1, 'the dmg itself must be submitted to notarytool (P7)')
assert.ok(dmgSubmit > dmgCreate, 'the dmg notarization must follow its creation')
assert.ok(dmgStaple > dmgSubmit, 'the dmg staple must follow its own notarization')
assert.equal(swiftBuild.split('xcrun notarytool submit').length - 1, 2,
  'exactly two notarytool submissions: the .app and the .dmg')
// 卷内容断言改锚共享模块（workflow 不再内联 staging）。
assert.doesNotMatch(swiftBuild, /hdiutil create/,
  'the workflow must not inline hdiutil staging — single implementation lives in macos/scripts/dmg.mjs')
assert.doesNotMatch(swiftBuild, /DMG_STAGE|ln -s \/Applications/,
  'the workflow must not re-introduce the old inline dmg staging')
// 内容级门禁（backgroundType/别名/窗口/坐标）只存在于 dmg.mjs；正式腿不得把它关掉
// ——--skip-verify 仅供调试 CLI（2026-09 审查：原先无人断言这一点）。
assert.doesNotMatch(swiftBuild, /--skip-verify/,
  'the release leg must keep the dmg content verification on (--skip-verify is debug-only)')
const dmgModule = readFileSync(new URL('../../macos/scripts/dmg.mjs', import.meta.url), 'utf8')
const swiftAssembler = readFileSync(new URL('../../macos/scripts/build-swift-app.mjs', import.meta.url), 'utf8')
assert.match(swiftAssembler, /from '\.\/dmg\.mjs'/,
  'the local assembly leg must import the same dmg module (single implementation)')
assert.ok(dmgModule.includes("symlinkSync('/Applications'"),
  'the dmg volume must carry the /Applications symlink (P7)')
assert.ok(dmgModule.includes("DMG_BACKGROUND_DIR_NAME = '.background'")
  && dmgModule.includes("DMG_BACKGROUND_FILE_NAME = 'background.tiff'"),
  'the dmg volume must carry the hidden .background/background.tiff (Finder background)')
assert.match(dmgModule, /set background picture of viewOptions to file/,
  'the Finder layout script must set the background picture')
assert.match(dmgModule, /export function assertDmgLayoutFacts/,
  'the dmg content assertions must stay a single, unit-testable implementation')
// 图标坐标在模块里是常量 + 模板插值，锚常量与插值点（源文本断言，非运行值）。
assert.match(dmgModule, /DMG_WINDOW = \{ width: 540, height: 380 \}/,
  'the Finder window size must stay pinned to the background image size')
assert.match(dmgModule, /DMG_ICON_POSITIONS = \{ app: \{ x: 130, y: 220 \}, applications: \{ x: 410, y: 220 \} \}/,
  'the Finder layout must pin both icon positions (electron-builder default contents)')
assert.match(dmgModule, /set position of item "\$\{appName\}\.app" of container window to \$\{appPos\}/,
  'the Finder layout script must place the app icon')
assert.match(dmgModule, /set position of item "\$\{DMG_APPLICATIONS_LINK\}" of container window to \$\{appsPos\}/,
  'the Finder layout script must place the Applications shortcut')
assert.match(dmgModule, /'-format', 'UDRW'/,
  'Finder needs a writable intermediate image to write .DS_Store')
assert.match(dmgModule, /'-format', 'UDZO'/,
  'the distribution image must still be compressed UDZO')
const dmgBackground = new URL('../../macos/resources/dmg-background.tiff', import.meta.url)
assert.ok(existsSync(dmgBackground), 'the in-repo dmg background asset must exist (nothing else paints the drag cue)')
// 双 rep TIFF（electron-builder 同款 540×380@72dpi + 1080×760@144dpi）：钉 TIFF magic
//（「II*\0」/「MM\0*」+ 非空，big-endian 源模板，两种字节序都接受），防资产被误换成 1x PNG。
const dmgBackgroundBytes = readFileSync(dmgBackground)
assert.ok(dmgBackgroundBytes.length > 1024, 'the dmg background asset must not be an empty placeholder')
assert.ok(
  (dmgBackgroundBytes[0] === 0x49 && dmgBackgroundBytes[1] === 0x49)
  || (dmgBackgroundBytes[0] === 0x4d && dmgBackgroundBytes[1] === 0x4d),
  'the dmg background must stay a TIFF (multi-representation asset, not a 1x PNG)')
// Fail-closed verification of the UPLOADED blobs, not only the staged .app.
assert.ok(
  swiftBuild.split('\n').some((line) => line.trim() === 'node scripts/release/release-artifacts.mjs "$VERSION" --check-dir macos/release'),
  'release-artifacts must be a real consumer so its collision assertion observes the real tag names',
)
assert.ok(swiftBuild.includes('ditto -x -k "${BASE}.zip" "$EXTRACT"'),
  'the zip actually uploaded must be extracted and re-verified (P4)')
assert.ok(swiftBuild.includes('codesign --verify --deep --strict --verbose=2 "$ZIP_APP"'),
  'codesign --verify must run on the app inside the zip')
assert.ok(swiftBuild.includes('spctl --assess --type execute --verbose=4 "$ZIP_APP"'),
  'spctl must assess the app inside the zip')
assert.ok(swiftBuild.includes('lipo -archs "$APP/Contents/MacOS/dsh-chamber"'),
  'the .app binary architecture must be asserted')
assert.ok(swiftBuild.includes('lipo -archs "$APP/Contents/Resources/sidecar/node"'),
  'the bundled node architecture must be asserted')
// Closure: the .app must carry the sidecar entrypoint, assembly package.json, the control-plane relative entry and all four host packages.
assert.ok(swiftBuild.includes('test -f "$APP/Contents/Resources/sidecar/package.json"'))
assert.ok(swiftBuild.includes('test -f "$APP/Contents/Resources/sidecar/dist/control-plane/index.js"'))
// The loop's package list is pinned as an EXACT token set: a substring assertion would
// stay green if a name gained a suffix (…-open-in → …-open-in-x) — the drift the 2026-12
// verification round found. Exactness, not mutation-proven text.
const hostLoop = swiftBuild.match(/for HOST in ([^;]*); do/)
assert.ok(hostLoop !== null, 'the closure check must iterate the host packages through $HOST')
assert.deepEqual(
  (hostLoop?.[1] ?? '').replace(/\\\n\s*/g, ' ').trim().split(/\s+/).sort(),
  ['dsh-chamber-seed-archive-cleanup', 'dsh-chamber-seed-client-graph', 'dsh-chamber-seed-git-worktree', 'dsh-chamber-seed-open-in'],
  'the host-package loop list must be exactly the four shipped host packages',
)
assert.ok(swiftBuild.includes('test -f "$APP/Contents/Resources/sidecar/dist/$HOST/dist/index.js"'),
  'the closure loop must test the per-host dist entry inside the .app')

// ---------------------------------------------------------------- G16 / S-22 / S-36
// G16 (release blocker): the appcast used to run BEFORE notarize/staple, while the formal
// leg assembles with --no-zip --no-dmg, so its `test -f "$ZIP"` could never see the zip that
// only exists after stapling (every formal release with SPARKLE_PRIVATE_KEY configured went
// red or signed a stale, un-notarized zip). It must follow the stapler step and sign the FINAL zip.
//
// S-36 (2026-12 audit, top severity): the beta appcast's enclosure resolved to the ROLLING
// tag while the zip was only uploaded to v<version> (discovering beta.N+1 then 404ed). After the
// 2026-09 S-23 rework the load-bearing parts pinned below are: (1) the beta generate_appcast
// input dir holds ONLY beta-sourced archives (current beta zip + past beta zips as delta
// baselines) — the stable zip is never copied there (two feeds in one dir + -o fails with
// "multiple appcasts found"); (2) beta generation passes --download-url-prefix pinned to the
// rolling download dir so every beta enclosure URL resolves there; (3) the rolling release — the
// PUBLIC beta discovery surface — receives the current beta zip and its deltas BEFORE the
// appcast, only after the fail-closed verification step; (4) the copied final item carries the
// version-fixed releases/download/<stable-tag>/ prefix. The stable appcast is never published on
// the rolling release; the S-23 refresh only pushes the final zip + stable deltas there (before
// overwriting the rolling beta feed), while the stable feed keeps releases/latest/download.
const appcastStep = between(
  '      - name: Generate + sign the Sparkle appcast',
  '      - name: Verify native app + uploaded archives',
)
  .split('\n')
  .filter((line) => !/^[ \t]*#/.test(line))
  .join('\n')
const verifyStep = between(
  '      - name: Verify native app + uploaded archives',
  '      - name: Upload native artifacts',
)
  .split('\n')
  .filter((line) => !/^[ \t]*#/.test(line))
  .join('\n')
const uploadStep = between(
  '      - name: Upload native artifacts',
  '\n  finalize-release:',
)
  .split('\n')
  .filter((line) => !/^[ \t]*#/.test(line))
  .join('\n')
const appcastIndex = swiftBuild.indexOf('Generate + sign the Sparkle appcast')
const verifyIndex = swiftBuild.indexOf('Verify native app + uploaded archives')
const uploadIndex = swiftBuild.indexOf('Upload native artifacts')
assert.notEqual(appcastIndex, -1, 'the native leg must generate the Sparkle appcast')
assert.ok(appcastIndex > appStaple,
  'G16: the appcast must be generated AFTER the notarize/staple step (it signs the final stapled zip)')
assert.ok(appcastIndex < uploadIndex, 'the appcast must be generated before the artifacts are uploaded')
assert.match(appcastStep, /if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/,
  'the appcast step is release-only: the dry run must skip it')
assert.match(appcastStep, /::warning::SPARKLE_PRIVATE_KEY absent/,
  'a missing SPARKLE_PRIVATE_KEY must skip loudly, never publish an unsigned appcast')
// 2026-12 A2 key gate: a keyless repo keeps the loud skip above; a repo with the PUBLIC key
// configured but no private key ships a feed nobody signs — that arm must FAIL.
assert.match(appcastStep, /::error::SPARKLE_PUBLIC_ED_KEY is configured but SPARKLE_PRIVATE_KEY is missing/,
  'public key without private key must fail closed, never ship a dead update chain')
assert.match(appcastStep, /SPARKLE_PUBLIC_ED_KEY: \$\{\{ secrets\.SPARKLE_PUBLIC_ED_KEY \}\}/,
  'the appcast step must receive the public key so the inconsistent-key arm is reachable')
assert.ok(appcastStep.includes('ZIP="${BASE}.zip"'),
  'the appcast must sign the final distribution zip path (BASE = the artifact basename)')
const appcastZipGuard = appcastStep.indexOf('test -f "$ZIP"')
assert.notEqual(appcastZipGuard, -1, 'the appcast must fail closed when the final zip is absent')
assert.ok(appcastStep.indexOf('generate_appcast') > appcastZipGuard,
  'the zip-existence guard must run BEFORE generate_appcast (no appcast without an artifact)')
assert.ok(appcastStep.indexOf('curl') > appcastZipGuard,
  'nothing may be fetched before the final zip exists (the step cannot run before any artifact)')

// S-22/S-36: beta releases are prereleases, so releases/latest/download never resolves for
// them and a version-fixed URL would only show beta.N its own asset: the feed points at the
// ROLLING tag/release asset, which also carries the archives the appcast references.
assert.ok(swiftBuild.includes('https://github.com/${GITHUB_REPOSITORY}/releases/latest/download/appcast-swift.xml'),
  'the stable feed URL must stay unchanged')
assert.ok(!swiftBuild.includes('/releases/download/v${VERSION}/appcast-swift-beta.xml'),
  'the beta feed must not be pinned to the version tag (beta.N could never see beta.N+1)')
assert.ok(swiftBuild.includes('releases/download/${SPARKLE_BETA_ROLLING_TAG}/appcast-swift-beta.xml'),
  'beta builds must inject the rolling tag\'s beta appcast')
assert.ok(swiftBuild.includes(`SPARKLE_BETA_ROLLING_TAG: ${NATIVE_BETA_ROLLING_TAG}`),
  'the rolling tag must be defined once (build-swift job env) and match release-artifacts.mjs')
assert.ok(!NATIVE_BETA_ROLLING_TAG.startsWith('v'),
  'the rolling tag must not start with v: release.yml triggers on push tags v* and would run a release')
assert.equal(
  nativeMacFeedUrl('0.3.2-beta.1', 'panzeyu2013/dsh-chamber'),
  'https://github.com/panzeyu2013/dsh-chamber/releases/download/appcast-swift-beta/appcast-swift-beta.xml',
  'the beta feed URL (single-sourced) must resolve on the rolling tag')
assert.equal(
  nativeMacFeedUrl('0.3.2', 'panzeyu2013/dsh-chamber'),
  'https://github.com/panzeyu2013/dsh-chamber/releases/latest/download/appcast-swift.xml',
  'the stable feed URL (single-sourced) must stay releases/latest')

// S-36 enclosure resolution, locked to Sparkle's own algorithm (ArchiveItem.archiveURL:
// URL(filename, relativeTo: prefix ?? embedded SUFeedURL)): with the prefix pinned to the
// rolling download dir every beta enclosure lands next to the appcast, so the zip must ALSO
// live on the rolling release.
const betaZip = nativeMacArtifacts('0.3.2-beta.1')[1]
const betaFeed = nativeMacFeedUrl('0.3.2-beta.1', 'panzeyu2013/dsh-chamber')
const betaRollingPrefix = nativeBetaRollingDownloadPrefix('panzeyu2013/dsh-chamber')
const betaEnclosure = `https://github.com/panzeyu2013/dsh-chamber/releases/download/${NATIVE_BETA_ROLLING_TAG}/${betaZip}`
assert.equal(nativeAppcastDownloadPrefix('0.3.2-beta.1', 'panzeyu2013/dsh-chamber'), betaRollingPrefix,
  'beta generation must use the rolling download prefix (single-sourced)')
assert.ok(betaRollingPrefix.endsWith('/'),
  'the prefix must end in a slash: URL(filename, relativeTo: prefix) replaces the last segment otherwise')
assert.equal(nativeEnclosureUrl(betaZip, betaFeed, betaRollingPrefix), betaEnclosure,
  'the beta enclosure must resolve on the rolling release (S-36)')
assert.equal(nativeEnclosureUrl(betaZip, betaFeed), betaEnclosure,
  'even without the flag the embedded rolling SUFeedURL yields the same URL — the zip must therefore be uploaded there')
const stableZip = nativeMacArtifacts('0.3.2')[1]
assert.equal(nativeAppcastDownloadPrefix('0.3.2', 'panzeyu2013/dsh-chamber'), null,
  'stable must pass NO prefix: its enclosure shape is unchanged')
assert.equal(nativeEnclosureUrl(stableZip, nativeMacFeedUrl('0.3.2', 'panzeyu2013/dsh-chamber')),
  `https://github.com/panzeyu2013/dsh-chamber/releases/latest/download/${stableZip}`,
  'the stable enclosure stays on releases/latest (byte-identical generation)')

// 2026-09 增量更新：stable 与 beta 的收件目录/feed/上传面**完全分开**——generate_appcast 按
// 归档内嵌 SUFeedURL 的文件名分组，两通道归档同目录 + -o 会直接失败 multiple appcasts found
// （Sparkle 2.10.0 generate_appcast/Appcast.swift:45-62，本机复现）；而 delta 需要把本通道的
// 历史归档放进同一个收件目录。staging 只取本通道归档、逐条精确文件名（绝不宽 glob）。
assert.ok(appcastStep.includes('STAGE_DIR="/tmp/appcast-in-stable"')
  && appcastStep.includes('STAGE_DIR="/tmp/appcast-in-beta"'),
  'stable 与 beta 必须各有独立收件目录（同目录 + -o = multiple appcasts found）')
assert.ok(appcastStep.includes('cp "$ZIP" "$STAGE_DIR/"'),
  '本版本的已签名 zip 必须被 stage 进本通道收件目录（S-36）')
assert.ok(!appcastStep.includes('/tmp/appcast-in/'),
  '旧的两通道共用收件目录必须彻底消失')
assert.ok(appcastStep.includes('--maximum-versions "$MAX_VERSIONS"')
  && appcastStep.includes('MAX_VERSIONS=1') && appcastStep.includes('MAX_VERSIONS=3'),
  'stable feed 只保留当前条目（MAX_VERSIONS=1），beta 保留最近 3 条')
assert.ok(appcastStep.includes('--maximum-deltas "$DELTA_SOURCES"')
  && appcastStep.includes('DELTA_SOURCES="${SPARKLE_DELTA_SOURCES:-2}"'),
  'delta 覆盖的历史版本数由 SPARKLE_DELTA_SOURCES 控制（默认 2）')
assert.match(appcastStep, /\[\[ "\$DELTA_SOURCES" =~ \^\[1-5\]\$ \]\]/,
  'delta 源数量必须被夹在 1..5（generate_appcast --maximum-deltas 上限）')
assert.ok(appcastStep.includes('gh release list --repo "$GITHUB_REPOSITORY" --exclude-drafts --exclude-pre-releases'),
  'stable staging 必须从非 draft/非 prerelease 的历史 release 取归档')
assert.match(appcastStep, /dsh-chamber-\[0-9\]\*-macos-arm64\.zip/,
  'stable 历史归档必须用精确命名匹配')
assert.ok(appcastStep.includes('--pattern "$NAME" --dir "$STAGE_DIR"'),
  '历史归档必须逐条精确文件名下载进本通道收件目录')
assert.match(appcastStep, /grep -E '\^dsh-chamber-\[0-9\]\+/,
  'beta 历史归档必须从滚动 release 的资产列表按命名过滤')
assert.ok(appcastStep.includes('sort -Vr'),
  'beta 历史归档必须按版本降序取最新若干')
assert.ok(appcastStep.includes('[[ "$NAME" == "$CURRENT_NAME" ]] && continue'),
  '当前版本不能当作自己的 delta 基线')
assert.ok(appcastStep.includes('STAGED_PREVIOUS') && appcastStep.includes('NEWEST_PREVIOUS_VERSION'),
  'staging 结果（条数与最新旧版本）必须进入 verify 门禁')
assert.match(appcastStep,
  /VERIFY_ARGS\+=\(--expect-delta-from "\$NEWEST_PREVIOUS_VERSION" --expect-delta-count "\$STAGED_PREVIOUS"\)/,
  'staged 过旧归档时 verify 必须断言最新基线的 deltaFrom 且 delta 条数 ≥ staged 基线数'
  + '（只钉最新基线会让更旧的基线静默失去增量覆盖）')
// D1（2026-09 复核，经验复现）：Sparkle 会按「delta > 7/8 整包」规则主动放弃 delta
// （Appcast.swift:360），只在缓存目录写 *.ignore、stdout 无提示。把「主动放弃」当成
// 增量链退化会误红整个发布，所以必须区分两者：干净 CFFIXED_USER_HOME + 标记计数。
assert.ok(appcastStep.includes('CFFIXED_USER_HOME="$DELTA_CACHE_HOME"')
  && appcastStep.includes('MARKER_DIR="$DELTA_CACHE_HOME/Library/Caches/Sparkle_generate_appcast"'),
  'generate_appcast 必须跑在干净的 CFFIXED_USER_HOME 下并从 Sparkle marker 目录统计放弃标记')
assert.match(appcastStep, /if \[\[ "\$DECLINED_DELTAS" -eq 0 && "\$UNACCOUNTED_COUNT" -eq 0 \]\]; then/,
  '只有「没有任何放弃/丢失」时才允许要求全部基线都产出 delta（否则体积规则会误红正式发布）')
assert.match(appcastStep, /EXPECTED_DELTAS=\$MATCHED_DELTAS/,
  '放弃/丢失之后，门禁只能要求「已核实的匹配数」（剩余基线仍要产出 delta）')
assert.ok(appcastStep.includes('::warning::Sparkle 主动放弃 $DECLINED_DELTAS 个基线')
  && appcastStep.includes('这些基线走整包下载'),
  '主动放弃必须是 loud 警告（绝不静默）')
assert.ok(appcastStep.includes('::warning::$UNACCOUNTED_COUNT 个基线因 delta 生成失败走整包'),
  'delta 生成失败也必须 loud 警告（与主动放弃分开报）')
// R4-5/二轮：滚动 release 是公开面，重跑不许静默换字节——同名 beta zip 必须字节一致才允许
// 覆盖（否则已发布 feed 的签名指向的字节变了，客户端先验签失败）。
assert.ok(uploadStep.includes('REPUBLISH_ASSETS=') && uploadStep.includes('cmp -s "/tmp/republish-check/')
  && uploadStep.includes('::error::滚动 release 上已有同名 beta zip 但字节不同'),
  'beta 重跑必须先证明同名 zip 字节一致（或提示提升 beta 号），不许静默 clobber')

// R4-4/二轮：draft 上的 appcast 必须在 zip/delta 之后上传（S-36 的「归档先于 feed」在
// draft 面同样成立，不再依赖「draft 不可见」的间接论证）。
assert.ok(!appcastStep.includes('gh release upload "v${VERSION}" "macos/release/${APPCAST}"'),
  'appcast 步不许再往 draft 传 appcast（会先于归档落地）')
assert.ok(uploadStep.includes('gh release upload "v${VERSION}" "macos/release/${APPCAST}" --clobber')
  && uploadStep.indexOf('gh release upload "v${VERSION}"') < uploadStep.indexOf('gh release upload "v${VERSION}" "macos/release/${APPCAST}"'),
  'draft appcast 必须在 dmg/zip（以及 delta）之后才上传')

// D2：密钥门禁必须对称——私钥在而公钥缺同样 FAIL（否则会发布「带 appcast 但检查不到
// 更新」的包，并在下一次发布把它当作产不出 delta 的基线）。
assert.ok(appcastStep.includes('SPARKLE_PRIVATE_KEY is configured but SPARKLE_PUBLIC_ED_KEY is missing'),
  '私钥在而公钥缺必须 FAIL（镜像门禁；HAS_APPCAST 基线守卫只防旧包，不防新造出来的）')
// A1/R2（两个评审各自用真实 Sparkle 复现）：公钥与私钥不匹配时 generate_appcast 只打警告并把
// 条目发成没有 sparkle:edSignature 的形状——必须在发布腿 FAIL，且脚本侧同时断言签名存在。
assert.match(appcastStep, /does not match key EdDSA\|ignored, because it could not be signed/,
  '签名问题必须从 generate_appcast 输出里被识别')
assert.ok(appcastStep.includes('::error::generate_appcast 报告 EdDSA 签名问题')
  && appcastStep.indexOf('::error::generate_appcast 报告 EdDSA 签名问题') < appcastStep.indexOf('DECLINED_DELTAS=0'),
  '签名问题必须在统计放弃标记之前 exit 1（否则"全部被放弃"会把发布放行）')
// A2/R3/R2-7：staged 归档必须带**与当前发布公钥一致**的 SUPublicEDKey（无公钥的旧 app 既不产
// delta 也不写放弃标记；密钥轮换后的旧基线会让 generate_appcast 只打警告并发未签名条目）。
assert.ok(appcastStep.includes('baseline_can_use_delta() {')
  && appcastStep.includes('plist_field() {')
  && appcastStep.includes('unzip -Z1 "$zip"')
  && appcastStep.includes('plutil -convert xml1 -o - -- -')
  && appcastStep.includes('[[ "$key" == "$SPARKLE_PUBLIC_ED_KEY" ]]')
  && appcastStep.includes('[[ "$branch" == "$CURRENT_MIN_SYSTEM" ]]')
  && !appcastStep.includes("grep -q 'SUPublicEDKey'")
  && !appcastStep.includes('unzip -p "$1" \'*Contents/Info.plist\''),
  'staged 归档必须解包检查**主 app** Info.plist 的 SUPublicEDKey 且与当前公钥一致（空值/取不到一律拒绝，'
  + '绝不用「键名存在」兜底），并与当前 app 同分支（branch point 不同会产出第二个 feed 条目）')
assert.equal(appcastStep.split('baseline_can_use_delta "$STAGE_DIR/$NAME"').length - 1, 2,
  'stable 与 beta 两个 staging 循环都必须做 keyed/同分支基线过滤')
assert.equal(appcastStep.split('STAGED_BUNDLES="$STAGED_BUNDLES $BUNDLE"').length - 1, 2,
  '两个循环都必须记录基线构建号（逐基线账目要用）')
assert.equal(appcastStep.split('与已 staged 基线同构建号').length - 1, 2,
  '同构建号的历史包必须去重（否则逐基线账目会要求两个 deltaFrom）')
// A4：stable 收件目录必须显式拒绝 beta 命名（滚动 release 的 prerelease 标记一旦被清掉）。
assert.ok(appcastStep.includes('dsh-chamber-[0-9]*-beta.*-macos-arm64.zip) ;;'),
  'stable staging glob 必须先排掉 beta 归档')
// A7：被执行的三方工具链要 -f + 固定 SHA-256；私钥临时文件要 umask 077 + EXIT trap。
assert.ok(appcastStep.includes('SPARKLE_TARBALL_SHA256=')
  && appcastStep.includes('curl -fsSL --retry 3 -o /tmp/sparkle.tar.xz')
  && appcastStep.includes('shasum -a 256 -c -'),
  'Sparkle tarball 必须校验固定 SHA-256 且 curl 用 -f')
// R3/F3（真实 Sparkle 2.10.0 复现）：只断言「签名存在」挡不住密钥轮换后那个「任何公钥都
// 验不过」的签名——验签必须真的用 Ed25519 公钥验归档字节，且公钥必须进到验签步。
assert.equal(appcastStep.split('--signatures-dir "$STAGE_DIR" --public-key "$SPARKLE_PUBLIC_ED_KEY"').length - 1, 2,
  'appcast 步的两处 verify（普通/合并后）都必须逐条真验签')
assert.ok(uploadStep.includes('--signatures-dir /tmp/appcast-in-stable --public-key "$SPARKLE_PUBLIC_ED_KEY"'),
  'stable 刷新后的滚动 feed 验签必须真验（本版本 zip/delta 就在 /tmp/appcast-in-stable）')
assert.ok(uploadStep.includes('SPARKLE_PUBLIC_ED_KEY: ${{ secrets.SPARKLE_PUBLIC_ED_KEY }}'),
  'upload 步必须注入公钥，否则刷新验签没有验签依据')

// R2-8：tarball 版本必须与 SwiftPM pin 锁步（否则升 Sparkle 时 URL/哈希会悄悄对不上）。
const sparklePin = /releases\/download\/([0-9.]+)\/Sparkle-\1\.tar\.xz/.exec(appcastStep)
assert.ok(sparklePin !== null, 'tarball URL 必须带版本号（与 SHA-256 一起构成 pin）')
assert.ok(readFileSync(new URL('../../macos/Package.resolved', import.meta.url), 'utf8')
  .includes(`"version" : "${sparklePin[1]}"`),
  `workflow 里的 Sparkle ${sparklePin[1]} 必须与 macos/Package.resolved 的 pin 一致`)
// R2-1/R2-2：gh 的「缺失」文案有三种（release not found / no assets match / no assets to download），
// 分类器必须大小写不敏感且三个都覆盖，否则首个 beta 会硬 FAIL。
assert.equal(appcastStep.split("grep -qiE 'no assets (match|to download)|not found'").length - 1, 2,
  '两处 feed 读取都必须用覆盖三种缺省文案的、大小写不敏感的分类器')
// 分类器本身要被真的执行到（R2 的变异测试证明：只 pin 字符串等于没测）。
const classifierPattern = /grep -qiE '([^']+)' \/tmp\/(?:stable|rolling)-feed\.err/.exec(appcastStep)?.[1]
assert.ok(classifierPattern, '必须能从 workflow 里取出分类器正则')
const classifierMatches = (text) => new RegExp(classifierPattern, 'i').test(text)
for (const text of ['release not found', 'no assets match the file pattern', 'no assets to download', 'gh: Not Found (HTTP 404)']) {
  assert.ok(classifierMatches(text), `必须把 "${text}" 判成「通道/资产不存在」`)
}
for (const text of ['gh: Bad credentials (HTTP 401)', 'dial tcp 1.2.3.4: i/o timeout', 'HTTP 502 Bad Gateway']) {
  assert.ok(!classifierMatches(text), `不得把 "${text}" 判成缺失（那是真实故障，必须 FAIL）`)
}
// 合并把旧 beta 条目并进来，但长度必须与 generate_appcast 的 --maximum-versions 同口径。
assert.ok(appcastStep.includes('--beta-item-limit "$MAX_VERSIONS"'),
  'beta 合并必须传 --beta-item-limit（否则合并长度与 feed 生成口径不一致）')
assert.ok(appcastStep.includes('umask 077') && appcastStep.includes("trap 'rm -f /tmp/ed-key.txt' EXIT"),
  'EdDSA 私钥文件必须 0600 且退出时清理（失败路径也要清）')
// R1/二轮：逐基线账目——全部被放弃时 delta 门禁会退化成空断言，逐条归因仍然生效，且
// 「多 branch/多条 feed 的标记互相顶替」不再是漏洞（每个基线必须有它自己的 delta 或标记）。
assert.ok(appcastStep.includes('for OLD in $STAGED_BUNDLES; do')
  && appcastStep.includes('grep -q "sparkle:deltaFrom=')
  && appcastStep.includes('${NEW_BUNDLE}-${OLD}.delta')
  && appcastStep.includes('::error::以下 staged 基线既没有 delta 也没有放弃标记'),
  '逐基线账目：每个 staged 基线必须有自己的 delta 或有 (新构建号, 它) 的放弃标记，否则点名 FAIL')
// R2-3：marker 只能数 cache 根目录的直接子项（Sparkle 把解包出的 app bundle 也放在同一棵 cache 树里，
// 递归 find 会把 bundle 里任何 *.ignore 算成「放弃」，从而绕过账目门禁）。
assert.ok(appcastStep.includes('MARKER_DIR="$DELTA_CACHE_HOME/Library/Caches/Sparkle_generate_appcast"')
  && appcastStep.includes('ls "$MARKER_DIR"/*"${NEW_BUNDLE}-${OLD}.delta"*.ignore'),
  '放弃标记必须落在 Sparkle marker 目录、并按 (新构建号, 基线) 精确归因'
  + '（不解包树递归、也不靠总数相减）')
// R2-5：「delta 根本生成不出来」不算放弃标记，但逐基线账目要用它解释「既无 delta 又无标记」的差额；
// 超出该差额的基线才是真丢失（fail-closed）。
assert.ok(appcastStep.includes("CREATE_FAILURES=\"$(grep -c 'Could not create delta update'")
  && appcastStep.includes('if [[ "$UNACCOUNTED_COUNT" -gt "$CREATE_FAILURES" ]]; then'),
  'delta 生成失败必须作为「无标记但可解释」的差额，超出的基线才 FAIL')
assert.ok(appcastStep.includes('无法统计 delta 生成失败条数'),
  '空字符串在算术里等于 0：统计失败必须是显式 ::error::，不许被当成「没有失败」')
// R4（第二轮复核）：公开放入口必须良构，且合并只增不减——verify 只看「本版本条目 + final」，
// 看不到 beta 条目被丢掉这类静默退化。
assert.equal(appcastStep.split('xmllint --noout').length - 1, 2,
  '生成 feed 与合并 feed 都必须过 xmllint --noout（非良构 feed 会让 Sparkle 拒绝整个通道）')
assert.ok(uploadStep.includes('xmllint --noout /tmp/appcast-stable-refresh-out/appcast-swift-beta.xml'),
  '刷新后的滚动 feed 同样要过良构校验')
assert.ok(appcastStep.includes('FRESH_ITEMS=') && appcastStep.includes('MERGED_ITEMS=')
  && appcastStep.includes('::error::合并后条目数减少'),
  '合并必须只增不减：beta 条目丢失必须 FAIL')

// R4/R5：非 404 的探测/下载失败不得被当成「通道不存在」而静默跳过。
assert.ok(appcastStep.includes('::error::读取 latest final $STABLE_TAG 的 appcast 失败（非 404/缺资产）')
  && appcastStep.includes('::error::读取滚动 beta feed 失败（非 404/缺资产）')
  && appcastStep.includes('/tmp/rolling-feed.err'),
  'beta 腿的两处 feed 读取必须保留 stderr 并区分 404/缺资产 与真实错误')
assert.ok(uploadStep.includes('::error::探测 beta 滚动通道失败（非 404）')
  && uploadStep.includes('ROLLING_PROBE_ERR')
  && uploadStep.includes('releases/tags/${ROLLING_TAG}'),
  'stable 刷新必须把「滚动通道不存在（404）」与「探测失败（网络/鉴权）」分开，后者 fail-closed')
assert.match(appcastStep, /\[\[ "\$CHANNEL" == "stable" \]\] && VERIFY_ARGS\+=\(--single-item\)/,
  'stable feed 必须恰好 1 个条目（历史条目会引用 releases/latest 上的死链）')
// 变异测试暴露的死 flag 面：只钉 += 赋值不够，必须钉「调用点真的展开数组」与 guard 表达式，
// 否则删掉 ${VERIFY_ARGS[@]+…}/{FINAL_ARGS[@]+…} 或把 guard 反向（-z），CI 依旧全绿。
assert.match(appcastStep, /\[\[ "\$STAGED_PREVIOUS" -ge 1 && -n "\$NEWEST_PREVIOUS_VERSION" \]\]/,
  'delta 期望只在 staged ≥1 且有最新旧版本号时启用（guard 反向突变必须被抓）')
const nonBetaVerifyStart = appcastStep.indexOf('--signatures-dir "$STAGE_DIR"')
assert.notEqual(nonBetaVerifyStart, -1, '非 beta 路径的 verify 必须带验签参数')
assert.ok(appcastStep.slice(nonBetaVerifyStart, nonBetaVerifyStart + 400)
  .includes('${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"}'),
  '非 beta 路径的 verify 调用必须展开 VERIFY_ARGS（否则单条目/deltaFrom/验签门禁静默失效）')
assert.ok(appcastStep.includes('${FINAL_ARGS[@]+"${FINAL_ARGS[@]}"} ${VERIFY_ARGS[@]+"${VERIFY_ARGS[@]}"}'),
  'beta 合并路径的 verify 调用必须同时展开 FINAL_ARGS 与 VERIFY_ARGS')
// S-23（2026-09 改法）：beta feed 的 final 条目从**已发布 stable feed** 复制，绝不把 stable
// zip 放进 beta 收件目录；取不到 stable feed 时保留上次滚动 feed 的 final 条目。
assert.ok(appcastStep.includes('node scripts/release/merge-native-feed.mjs'),
  'S-23：beta feed 的 final 条目必须由 merge-native-feed 从已发布 stable feed 复制')
assert.ok(appcastStep.includes('FINAL_ARGS+=(--expect-final-item)')
  && appcastStep.includes('"$MERGE_OUTPUT" == *"finalItem=0"*'),
  'G42：只有合并结果真的带 final 条目才要求 --expect-final-item（尚无 keyed final 时 loud 降级，绝不阻塞 beta）')
assert.ok(appcastStep.includes('HAS_APPCAST="true"')
  && appcastStep.includes('has no appcast-swift.xml (当时未配置 Sparkle 密钥) — 不作 delta 基线'),
  '没有 appcast 的旧 stable 发布不得作 delta 基线：其 app 可能产不出 delta（verify 会误红）或内嵌别的 feed')
const nativeStableHead = NATIVE_STABLE_ZIP_PATTERN.split('*')[0]
const nativeStableTail = NATIVE_STABLE_ZIP_PATTERN.split('*')[1]
assert.ok(appcastStep.includes(`${nativeStableHead}[0-9]*${nativeStableTail}`),
  'stable staging glob 必须是 NATIVE_STABLE_ZIP_PATTERN 的数字起始特化（同头同尾，避免两处各自漂移）')
assert.ok(appcastStep.includes('releases/download/${STABLE_TAG}/'),
  'final 条目必须改挂版本固定前缀：releases/latest 会被后续正式版移走 ⇒ S-36 404')
assert.match(appcastStep, /gh release download "\$STABLE_TAG" --repo "\$GITHUB_REPOSITORY" --pattern 'appcast-swift\.xml'/,
  'final 条目从最新正式版的 appcast 复制（不再下载 stable zip）')
assert.ok(appcastStep.includes('repos/${GITHUB_REPOSITORY}/releases/latest'),
  'final feed 必须来自 /releases/latest（绝不含 prerelease/draft）')
assert.match(appcastStep, /if STABLE_TAG="\$\(gh api/,
  'the /releases/latest lookup must distinguish 404 (no final release) from real failures')
assert.match(appcastStep, /elif grep -q 'Not Found' \/tmp\/stable-latest\.err/,
  'only an explicit 404 may be treated as "no final release yet"')
assert.match(appcastStep, /::error::解析 \/releases\/latest 失败（非 404）/,
  'a non-404 latest-release resolution failure must fail closed')
assert.match(appcastStep, /node scripts\/release\/verify-native-appcast\.mjs "\$VERSION" "\/tmp\/appcast-out\/\$\{APPCAST\}"/,
  'the signed appcast must be proven to carry this version before it is uploaded')

// Generation: exactly one generate_appcast call — no prefix for stable, the rolling prefix
// for beta (the guarded bash-3.2 array expansion keeps the stable command byte-identical).
assert.equal(appcastStep.split('/tmp/sparkle-bin/bin/generate_appcast').length - 1, 1,
  'exactly one generate_appcast invocation')
assert.ok(appcastStep.includes('PREFIX_ARGS=()'),
  'the prefix array must start empty (stable generation passes no flag)')
const prefixAssign = appcastStep.indexOf('PREFIX_ARGS=(--download-url-prefix')
assert.notEqual(prefixAssign, -1, 'the beta branch must assign the rolling download prefix')
assert.ok(
  appcastStep.lastIndexOf('if [[ -n "$ROLLING_TAG" ]]; then', prefixAssign) !== -1
  && appcastStep.lastIndexOf('if [[ -n "$ROLLING_TAG" ]]; then', prefixAssign) < prefixAssign,
  'the prefix assignment must sit inside the beta-only branch (stable never gets one)',
)
assert.ok(appcastStep.includes('--download-url-prefix "https://github.com/${GITHUB_REPOSITORY}/releases/download/${ROLLING_TAG}/"'),
  'the prefix must be the rolling download dir (trailing slash)')
assert.ok(appcastStep.includes('${PREFIX_ARGS[@]+"${PREFIX_ARGS[@]}"}'),
  'the optional prefix must use the bash-3.2-guarded array expansion')
assert.ok(swiftBuild.includes('gh release upload "v${VERSION}" "macos/release/${APPCAST}" --clobber'),
  'the channel appcast must actually be uploaded to the draft release')
// Sparkle's -o takes the output FILE, not a directory ("Is a directory" / "The file
// appcast-out couldn't be opened"), so pin the file form against silent regression.
assert.ok(appcastStep.includes('-o "/tmp/appcast-out/${APPCAST}" "$STAGE_DIR"'),
  'the appcast must be written to an explicit channel-named .xml file path (-o takes a filename)')
assert.doesNotMatch(appcastStep, /-o \/tmp\/appcast-out /,
  'passing a directory to -o fails at runtime (Sparkle expects a file path)')
assert.ok(uploadStep.includes('-o /tmp/appcast-stable-refresh-out/appcast-swift-beta.xml'),
  'the stable refresh must write the merged rolling feed under its exact asset name')
assert.match(
  swiftBuild,
  /if \[\[ "\$VERSION" == \*-\* \]\]; then\n\s+SPARKLE_FEED="\$SPARKLE_FEED_BETA"\n\s+else\n\s+SPARKLE_FEED="\$SPARKLE_FEED_STABLE"\n\s+fi/,
  'the feed must be selected from the release channel (beta vs stable)',
)
assert.ok(swiftBuild.includes('--sparkle-feed "$SPARKLE_FEED"'),
  'the build must inject the selected feed, not a hard-coded URL')
assert.ok(
  appcastStep.includes('APPCAST="appcast-swift-beta.xml"') && appcastStep.includes('APPCAST="appcast-swift.xml"'),
  'the appcast output name must be channel-selected to match the injected feed',
)

// Rolling publish happens in the POST-verify upload step: archives first, then the appcast
// that references them. The probe/create-if-absent guard is unchanged (prerelease → never
// releases/latest); the stable branch never publishes its own appcast there — only the S-23
// refresh writes to the rolling release, and it does so after the archives.
assert.match(appcastStep, /ROLLING_TAG=""/,
  'the stable branch must not touch the rolling release (only beta republishes it)')
assert.doesNotMatch(appcastStep, /gh release upload "\$ROLLING_TAG"/,
  'S-36: the public rolling publish must not run before the fail-closed verify step')
assert.match(verifyStep, /spctl --assess --type execute --verbose=4 "\$ZIP_APP"/,
  'the fail-closed executable assessment must be part of the step that precedes the rolling publish')
assert.ok(appcastIndex < verifyIndex && verifyIndex < uploadIndex,
  'order must be generate/sign → verify uploaded blobs → rolling publish + draft upload')
assert.match(uploadStep, /if \[\[ "\$VERSION" == \*-\* \]\]; then/,
  'only a beta release republishes the rolling channel')
assert.match(uploadStep, /ROLLING_TAG="\$\{SPARKLE_BETA_ROLLING_TAG\}"/,
  'the beta upload step must select the rolling tag from the job env')
assert.match(uploadStep, /gh release view "\$ROLLING_TAG" --repo "\$GITHUB_REPOSITORY"/,
  'the rolling release must be probed before creating it')
assert.match(uploadStep, /gh release create "\$ROLLING_TAG"/,
  'the rolling release/tag must be created when absent')
assert.ok(
  uploadStep.indexOf('gh release view "$ROLLING_TAG"') < uploadStep.indexOf('gh release create "$ROLLING_TAG"'),
  'the create must be guarded by the existence probe',
)
assert.match(uploadStep, /--prerelease/,
  'the rolling release must be a prerelease so releases/latest stays on stable')
assert.ok(uploadStep.includes('STAGED_ZIP="/tmp/appcast-in-beta/$(basename "${BASE}.zip")"'),
  'the appcast-referenced beta zip must be located by its exact basename in the beta staging dir')
assert.ok(uploadStep.includes('gh release upload "$ROLLING_TAG" "$STAGED_ZIP" --clobber'),
  'the current beta zip must be published to the rolling release (it is the beta enclosure)')
assert.ok(uploadStep.includes('for ARCHIVE in /tmp/appcast-in-beta/*.delta; do'),
  'delta archives the appcast references must be published to the rolling release (S-36)')
assert.ok(
  uploadStep.indexOf('gh release upload "$ROLLING_TAG" "$STAGED_ZIP" --clobber')
  < uploadStep.indexOf('gh release upload "$ROLLING_TAG" "$BETA_APPCAST" --clobber'),
  'archives must be published BEFORE the appcast that references them',
)
assert.ok(
  uploadStep.indexOf('for ARCHIVE in /tmp/appcast-in-beta/*.delta; do')
  < uploadStep.indexOf('gh release upload "$ROLLING_TAG" "$BETA_APPCAST" --clobber'),
  'delta 归档必须先于引用它的 appcast 上传（S-36：delta enclosure 不留 404）',
)
assert.ok(!uploadStep.includes('/tmp/appcast-in/'),
  '旧的两通道共用收件目录必须彻底消失（历史 beta zip 已在滚动 release 上，不重复上传）')
assert.match(uploadStep, /::error::appcast 引用的 beta zip 不在收件目录/,
  'an appcast whose staged zip vanished must fail closed, never publish a 404 enclosure')
// 2026-12 A2 key gate, both arms in the UPLOAD step too: the keyless repo keeps the loud
// skip, but a CONFIGURED private key with a missing appcast must never be silently skipped.
assert.match(uploadStep, /::warning::beta appcast 缺失（SPARKLE_PRIVATE_KEY 未配置）/,
  'a missing SPARKLE_PRIVATE_KEY stays a loud skip (release still ships)')
assert.match(uploadStep, /::error::SPARKLE_PRIVATE_KEY 已配置但 \$BETA_APPCAST 缺失/,
  'a configured key with no beta appcast must fail closed, never skip the rolling publish')

// S-23: a FINAL release also refreshes the rolling beta appcast, so a beta client discovers
// the final version even when the final ships after the last beta (the native analog of
// Electron's latest.yml fallback). 2026-09 改法：stable 与 beta 的收件目录/feed 分开，刷新改为
// 「已发布滚动 feed 的 beta 条目 + 本次 stable final 条目」合并（不再重跑 generate_appcast：
// 两通道归档同目录 + -o 会 multiple appcasts found）。刷新 gated on 滚动 release 存在且本次
// stable appcast 已生成；stable appcast 本身绝不被改写。
assert.ok(uploadStep.includes('STABLE_APPCAST="macos/release/appcast-swift.xml"'),
  'the stable branch must gate the rolling refresh on the generated stable appcast')
assert.match(uploadStep, /::warning::stable appcast 缺失（SPARKLE_PRIVATE_KEY 未配置）/,
  'a missing stable appcast (no private key) must skip the refresh loudly, never red the release')
assert.match(uploadStep, /::error::SPARKLE_PRIVATE_KEY 已配置但 \$STABLE_APPCAST 缺失/,
  'a configured key with no stable appcast must fail closed, never skip the refresh silently')
assert.ok(uploadStep.includes('node scripts/release/merge-native-feed.mjs'),
  'the refresh must merge the published rolling feed with the new stable final item')
assert.ok(uploadStep.includes('gh release download "$ROLLING_TAG" --repo "$GITHUB_REPOSITORY"')
  && uploadStep.includes("--pattern 'appcast-swift-beta.xml' --dir /tmp/rolling-feed --clobber"),
  'the refresh must read the published rolling feed (beta items are its only source)')
assert.match(uploadStep, /::warning::滚动通道存在但缺少 appcast-swift-beta\.xml——本次跳过 beta 通道刷新/,
  'G42：滚动 release 在却缺 feed = beta 通道损坏——loud 跳过刷新（beta 客户端在下一个 beta 合并时看到 final），绝不用它阻塞正式发布')
assert.match(uploadStep, /if gh release download "\$ROLLING_TAG" --repo "\$GITHUB_REPOSITORY" \\\n\s+--pattern 'appcast-swift-beta\.xml' --dir \/tmp\/rolling-feed --clobber; then/,
  '刷新必须在下载成功分支里做（缺 feed 走 warning 分支，而不是先合并再失败）')
assert.ok(!uploadStep.includes('BETA_ZIP_NAME=') && !uploadStep.includes('sort -V'),
  'the refresh must no longer download the newest beta zip (beta items come from the feed)')
assert.doesNotMatch(uploadStep, /generate_appcast/,
  'the refresh must not re-run generate_appcast (two feeds + -o = multiple appcasts found)')
assert.ok(uploadStep.includes(
  '--download-url-prefix "https://github.com/${GITHUB_REPOSITORY}/releases/download/${ROLLING_TAG}/"'),
  'the refreshed rolling appcast must rewrite the final item onto the rolling download prefix')
// A2 + S-23 content gate: the merged feed must carry this final version (and keep the beta
// items) — test -f alone proved nothing.
assert.ok(uploadStep.includes('--signatures-dir /tmp/appcast-in-stable --public-key "$SPARKLE_PUBLIC_ED_KEY" --expect-final-item'),
  'the merged rolling feed must be proven to carry this final version before upload')
assert.ok(uploadStep.includes('/tmp/appcast-stable-refresh-out/appcast-swift-beta.xml'),
  'the refreshed feed must be uploaded under the exact SUFeedURL asset name')
// 归档先于 feed：final zip 与 stable delta 先落到滚动 release（合并后的 final 条目 URL 指向滚动前缀）。
assert.ok(uploadStep.includes('gh release upload "$ROLLING_TAG" "${BASE}.zip" --clobber'),
  'the final zip must land on the rolling release before the merged feed references it')
assert.ok(uploadStep.includes('for ARCHIVE in /tmp/appcast-in-stable/*.delta; do'),
  'the final item deltas must be published too (merged enclosure URLs point at them)')
assert.ok(
  uploadStep.indexOf('gh release upload "$ROLLING_TAG" "${BASE}.zip" --clobber')
  < uploadStep.indexOf('gh release upload "$ROLLING_TAG" /tmp/appcast-stable-refresh-out/appcast-swift-beta.xml --clobber'),
  'the refresh must publish archives before the merged feed',
)
assert.ok(
  uploadStep.indexOf('gh release upload "$ROLLING_TAG" "$ARCHIVE" --clobber', uploadStep.indexOf('STABLE_APPCAST='))
  < uploadStep.indexOf('gh release upload "$ROLLING_TAG" /tmp/appcast-stable-refresh-out/appcast-swift-beta.xml --clobber'),
  '刷新步的 delta 归档同样必须先于合并 feed 上传（S-36）',
)
// stable feed 自己的 delta 也必须随 draft 上传（enclosure 指向 releases/latest/download/<delta>）。
assert.ok(uploadStep.includes('gh release upload "v${VERSION}" "$ARCHIVE" --clobber'),
  'the stable deltas must be uploaded to the draft release before finalize')

// G29: a reused output dir can hold older versions side by side (0.3.1 + 0.3.2-beta.1
// reproduced locally), so the leg never globs — every reference and the upload are exact paths.
assert.doesNotMatch(swiftBuild, /macos\/release\/\*\.(dmg|zip)/,
  'the native leg must never glob macos/release for dmg/zip')
assert.ok(swiftBuild.includes('test -f "${BASE}.dmg"') && swiftBuild.includes('test -f "${BASE}.zip"'),
  'the verify step must assert the exact artifact names')
assert.ok(swiftBuild.includes('"${BASE}.dmg" "${BASE}.zip" --clobber'),
  'the upload must name exactly the manifest artifacts (no stale sibling swept in)')

// G36: the Electron leg must not glob its own output dir either (G29 fixed the Swift leg
// only). A reused packages/desktop/release can hold older versions side by side, so every
// reference names the exact staged artifact and the zip verify step must carry VERSION.
assert.ok(macBuild.includes('BASE="packages/desktop/release/dsh-chamber-electron-${VERSION}-arm64"'),
  'G36: the mac leg must derive the exact artifact base from VERSION')
assert.ok(macBuild.includes('APP_DIR="packages/desktop/release/mac-arm64/dsh-chamber-electron.app"'),
  'G36: the app bundle path must be exact, not find|head')
assert.ok(macBuild.includes('test -f "${BASE}.dmg"') && macBuild.includes('test -f "${BASE}-mac.zip"'),
  'G36: the verify step must assert the exact dmg/zip names')
assert.ok(macBuild.includes('DMG="${BASE}.dmg"') && macBuild.includes('ZIP="${BASE}-mac.zip"'),
  'G36: notarize/verify must target the exact artifacts')
assert.doesNotMatch(macBuild, /ls packages\/desktop\/release\/\*\.(dmg|zip)/,
  'G36: no glob in the Electron release leg')
assert.doesNotMatch(macBuild, /find packages\/desktop\/release[^\n]*head -n 1/,
  'G36: no find|head -1 in the Electron release leg')
assert.match(between('      - name: Verify mac zip contents', '  build-windows:'), /env:\n\s+VERSION: \$\{\{ needs\.create-release\.outputs\.version \}\}\n/,
  'G36: the zip verify step must receive VERSION (its path interpolation uses it)')

// ---------------------------------------------------------------- S-31 + G28
// S-31: electron-builder notarizes the .app only; the dmg needs its own notarytool submit +
// staple (+ validate) or offline Gatekeeper rejects the mounted volume. The build step
// already published the unstapled dmg, so the stapled file is re-uploaded over it.
const dmgStep = between(
  '      - name: Notarize + staple the Electron dmg',
  '      - name: Verify mac zip contents',
)
  .split('\n')
  .filter((line) => !/^[ \t]*#/.test(line))
  .join('\n')
assert.ok(macBuild.indexOf('Notarize + staple the Electron dmg') > macBuild.indexOf('Build and package macOS app'),
  'dmg notarization must follow the build that produces the dmg (S-31)')
assert.match(dmgStep, /if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/,
  'dmg notarization is release-only: the dry run must skip it')
const dmgSubmitIndex = dmgStep.indexOf('xcrun notarytool submit "$DMG"')
assert.notEqual(dmgSubmitIndex, -1, 'the dmg must be submitted to notarytool')
assert.ok(dmgStep.indexOf('xcrun stapler staple "$DMG"') > dmgSubmitIndex,
  'the dmg staple must follow its own notarization')
assert.ok(dmgStep.indexOf('xcrun stapler validate "$DMG"') > dmgStep.indexOf('xcrun stapler staple "$DMG"'),
  'the stapled dmg must be validated')
// Real-release check: electron-builder signs only the .app, so an unsigned but stapled dmg
// is rejected by `spctl --type open --context primary-signature`; stay fail-closed for a signed
// image and degrade loudly for an unsigned one.
assert.match(dmgStep, /if codesign -dv "\$DMG" >\/dev\/null 2>&1; then\n\s+spctl --assess --type open[^\n]*"\$DMG"/,
  'the dmg Gatekeeper assessment must be gated on the dmg actually carrying a signature')
assert.match(dmgStep, /stapled but unsigned[^\n]*primary-signature assertion/,
  'an unsigned dmg must degrade loudly instead of failing the release')
assert.match(dmgStep, /gh release upload "v\$\{VERSION\}" "\$DMG" --clobber/,
  'the stapled dmg must replace the unstapled asset electron-builder published')
// G28: the uploaded zip is not just `test -n`-ed — it is extracted and the .app inside re-verified (mirrors the Swift leg's P4(b)).
const zipVerifyStep = between(
  '      - name: Verify mac zip contents',
  '\n  build-windows:',
)
  .split('\n')
  .filter((line) => !/^[ \t]*#/.test(line))
  .join('\n')
assert.ok(zipVerifyStep.includes('ditto -x -k "$ZIP" "$EXTRACT"'), 'the uploaded zip must be extracted (G28)')
assert.ok(zipVerifyStep.includes('codesign --verify --deep --strict --verbose=2 "$ZIP_APP"'),
  'the app inside the zip must be codesign-verified')
assert.ok(zipVerifyStep.includes('xcrun stapler validate "$ZIP_APP"'),
  'the app inside the zip must carry the stapled notarization ticket')
assert.ok(zipVerifyStep.includes('spctl --assess --type execute --verbose=4 "$ZIP_APP"'),
  'the app inside the zip must pass Gatekeeper assessment')

for (const build of [macBuild, windowsBuild, linuxBuild]) {
  assert.match(build, /electron-builder\.beta\.yml/)
  assert.match(build, /VERSION.*\*-\*/s)
  assert.match(build, /if \[\[ "\$DRY_RUN" == "true" \]\]/)
  assert.match(build, /unset .*GH_TOKEN/)
}
for (const credential of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
  assert.match(macBuild, new RegExp(`unset [^\\n]*${credential}`), `dry-run mac build must strip ${credential}`)
}
assert.match(macBuild, /beta-mac\.yml/)
assert.match(macBuild, /latest-mac\.yml/)
assert.match(windowsBuild, /beta\.yml/)
assert.match(windowsBuild, /latest\.yml/)
assert.match(linuxBuild, /beta-linux\.yml/)
assert.match(linuxBuild, /latest-linux\.yml/)
assert.match(workflow, /make_latest=false/)
assert.match(workflow, /make_latest=true/)
assert.match(workflow, /needs: \[create-release, build-gateway, build-macos, build-windows, build-linux, build-swift\]/)
// The release path validates itself because a tag push runs ci.yml and release.yml in
// PARALLEL — publishing an untested commit must be impossible. The list below must therefore
// track ci.yml's gate set: the 2026-12 review P2 found gates only ci.yml ran (design-token
// conformance, upgrade tooling, the third-party-notices diff, desktop packaging sub-builds,
// the upstream-touchpoint registry/C8 gate).
// ---------------------------------------------------------------- mechanical alignment contract (2026-09)
// The two chains used to be hand-written lists kept aligned by a hand-written list of gate
// names HERE (`test:gui-acceptance` slipped through that way). The contract is now derived
// FROM ci.yml — every gate command the push path runs must appear in release validation, or
// be listed in EXEMPT with the reason and where its coverage lives instead.
const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const ciTestJob = jobBlock(ciWorkflow, 'test')

/** Every gate command a job runs: `run:` blocks, inline or multi-line. */
function gateCommands(jobText) {
  const commands = new Set()
  for (const raw of jobText.split('\n')) {
    let line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    line = line.replace(/^-\s+/, '').replace(/^run:\s*/, '')
    if (['|', '>', '|-', '>-'].includes(line)) continue
    for (const [pattern, normalize] of [
      [/^pnpm run ([A-Za-z0-9:_-]+)/, match => `pnpm run ${match[1]}`],
      [/^pnpm --filter (\S+) run ([A-Za-z0-9:_-]+)/, match => `pnpm --filter ${match[1]} run ${match[2]}`],
      [/^node (scripts\/[^\s]+\.mjs)/, match => `node ${match[1]}`],
      [/^(git diff --exit-code -- [^\s]+)/, match => match[1]],
    ]) {
      const match = line.match(pattern)
      if (match) { commands.add(normalize(match)); break }
    }
  }
  return [...commands].sort()
}

/** Gates the push path runs that release validation deliberately does NOT: each entry names
 * the reason and where the coverage lives instead; a gate simply missing is a failure. */
const EXEMPT = new Map([
  ['pnpm run smoke', 'the release path has never wired smoke (ci.yml says so at its own step): a checkout carries no bundled dsh runtime, so it would only print SKIP. Real gap — a post-bundle smoke inside the build legs — is a separate change, not a silent exemption.'],
  ['node scripts/gates/classify-ci-changes.mjs', 'push-path plumbing, not a gate: it only decides whether the expensive chain is worth running, and release validation always runs that chain in full, so there is nothing to classify.'],
])

const missingGates = gateCommands(ciTestJob).filter(gate => !validation.includes(gate) && !EXEMPT.has(gate))
assert.deepEqual(
  missingGates,
  [],
  `release validation must run every gate the push path runs (or list it in EXEMPT with a reason). Missing: ${missingGates.join(', ')}`,
)
// An exemption that stops being needed must be removed, not left to rot.
for (const gate of EXEMPT.keys()) {
  assert.ok(
    gateCommands(ciTestJob).includes(gate),
    `EXEMPT lists ${gate}, but the push path no longer runs it — drop the exemption`,
  )
  assert.ok(
    !validation.includes(gate),
    `EXEMPT lists ${gate}, but release validation runs it now — drop the exemption`,
  )
}

// ---------------------------------------------------------------- T1/T2/T3
// A release PROVES its commit passed CI instead of re-running the chain on the tag (2026-09
// CI-trigger revision): tagging a commit that never went through main used to skip the linux
// chain entirely. ci.yml now has no tag path at all and release validation carries the proof.
// The classifier stays frozen so widening the prose allowlist (which SKIPS gates) is deliberate.
assert.doesNotMatch(
  ciWorkflow,
  /github\.ref_type/,
  'ci.yml must not branch on tags anymore: a release proves its commit ran this chain on main instead of re-running it',
)
assert.doesNotMatch(
  ciWorkflow,
  /^\s+tags:\s*\[[^\]]*'v\*'[^\]]*\]\s*$/m,
  'ci.yml must not trigger on tag pushes: release.yml owns the tag path and rejects a commit main never validated',
)
const ciWindowsJob = jobBlock(ciWorkflow, 'test-windows')
// The proof names every required leg explicitly, so release validation cannot pass on a commit whose linux chain or windows leg never ran.
assert.match(
  validation,
  /- name: Release commit passed CI on main[\s\S]{0,400}?run: node scripts\/release\/verify-release-ci-proof\.mjs --sha/,
  'release validation must prove the released commit passed ci.yml on main (linux + windows legs)',
)
assert.match(
  validation,
  /permissions:\n\s+contents: read\n\s+actions: read\n/,
  'the proof lists workflow runs/jobs, so the validation job needs actions: read',
)
for (const manifest of ['dsh-runtime', 'control-plane', 'desktop']) {
  assert.ok(
    ciWindowsJob.includes(`--filter @dsh-chamber/${manifest} run test:win32`),
    `the windows leg must keep the ${manifest} test:win32 manifest`,
  )
}
assert.match(
  ciWorkflow,
  /^concurrency:\n  group:\s*ci-\$\{\{\s*github\.ref\s*\}\}\n  cancel-in-progress:\s*\$\{\{\s*github\.event_name\s*==\s*'pull_request'\s*\}\}$/m,
  'the push chain must serialize per ref and cancel ONLY pull-request runs: cancelling a branch push could drop the validation of a code commit when a prose-only push follows it (the classifier spares prose the heavy chain, so nothing would re-validate that commit)',
)
// 2026-12 single-entry collapse: the package test set and the client typecheck set are each
// invoked through `scripts/gates/run-checks.mjs`, so the gated step count must not fall below
// the post-collapse floor while both concentrated entries stay classifier-gated.
for (const entry of ['node scripts/gates/run-checks.mjs tests', 'node scripts/gates/run-checks.mjs typecheck']) {
  assert.match(
    ciTestJob,
    new RegExp(`if:\\s*steps\\.classify\\.outputs\\.code\\s*==\\s*'true'\\n\\s+run:\\s*${entry.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`),
    `the classifier must gate the heavy single entry: ${entry}`,
  )
}
assert.ok(
  classifiesHeavySteps(ciTestJob) >= 10,
  'the heavy push chain must stay classified by the change classifier (floor 10 after the 2026-12 single-entry collapse)',
)

/** Count the heavy steps the classifier can skip. */
function classifiesHeavySteps(jobText) {
  return [...jobText.matchAll(/^\s+if:\s*steps\.classify\.outputs\.code\s*==\s*'true'\s*$/gm)].length
}

// The prose allowlist decides what SKIPS the heavy chain: widening it must be a deliberate edit to this assertion.
const classifier = readFileSync(new URL('../gates/classify-ci-changes.mjs', import.meta.url), 'utf8')
const prefixes = classifier.match(/export const PROSE_ONLY_PREFIXES = \[([^\]]*)\]/)
const files = classifier.match(/export const PROSE_ONLY_FILES = \[([^\]]*)\]/)
assert.ok(prefixes && files, 'the classifier must export its prose allowlist')
assert.deepEqual(
  [...prefixes[1].matchAll(/'([^']+)'/g)].map(match => match[1]),
  ['docs/'],
  'prose prefixes decide which pushes skip gates — widen deliberately, in this test',
)
assert.deepEqual(
  [...files[1].matchAll(/'([^']+)'/g)].map(match => match[1]),
  ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CHANGELOG.md', 'LICENSE', 'SECURITY.md', 'CODE_OF_CONDUCT.md'],
  'prose files decide which pushes skip gates — widen deliberately, in this test',
)
// The upstream-touchpoint registry gate runs in TWO passes, both load-bearing: a substring
// check on the script path alone would pass with either missing, so pin the exact command
// lines AND their order around the install (advisory file-only before, C8 rebuild after).
const upstreamGateRuns = validation.match(/^\s+run: node scripts\/upstream\/verify-upstream-touchpoints\.mjs.*$/gm) ?? []
assert.equal(
  upstreamGateRuns.length,
  2,
  `release validation must run the upstream gate exactly twice (advisory + C8 rebuild), found ${upstreamGateRuns.length}`,
)
const advisoryGate = validation.indexOf('run: node scripts/upstream/verify-upstream-touchpoints.mjs --no-artifact-rebuild')
const rebuildGate = validation.indexOf('run: node scripts/upstream/verify-upstream-touchpoints.mjs\n')
const installStep = validation.indexOf('run: pnpm install --frozen-lockfile')
assert.notEqual(advisoryGate, -1, 'release validation must run the upstream gate in --no-artifact-rebuild mode')
assert.notEqual(rebuildGate, -1, 'release validation must run the upstream gate in its default (C8 rebuild) mode')
assert.ok(
  advisoryGate < installStep && installStep < rebuildGate,
  'the upstream gate must run file-only before the install and its C8 rebuild pass after it (ci.yml order)',
)
// Regenerating the notices file is not a gate by itself — the committed file must be proven current, on both the English mirror and the canonical one.
assert.match(
  validation,
  /git diff --exit-code -- THIRD_PARTY_NOTICES\.md docs\/THIRD_PARTY_NOTICES\.en-US\.md/,
  'release validation must assert the regenerated third-party notices are committed',
)
assert.equal(releaseChannel('1.2.3'), 'latest')
assert.equal(releaseChannel('1.2.3-beta.1'), 'beta')
assert.equal(releaseChannel('1.2.3-beta.0'), 'beta')
assert.throws(() => releaseChannel('1.2.3-rc.1'), /only X\.Y\.Z-beta\.N/)
assert.throws(() => releaseChannel('1.2.3-alpha'), /only X\.Y\.Z-beta\.N/)
assert.equal(compareReleaseVersions('1.2.3-beta.2', '1.2.3-beta.10'), -1)
assert.equal(compareReleaseVersions('1.2.3-beta.10', '1.2.3'), -1)
assert.equal(compareReleaseVersions('2.0.0', '1.99.99'), 1)
assert.throws(() => releaseChannel('1.2.3;echo injected'))
assert.equal(
  desktopPackage.build?.electronDownload,
  undefined,
  'formal desktop builds must not trust a committed third-party Electron mirror',
)
// S-30 support-matrix floor: the native shell runs the SHIPPED BUNDLE on the OS WebKit, so
// the floor is the JS baseline that bundle needs, not the Electron runtime's own floor (12.0
// in Electron 43.x). The bundle calls Promise.withResolvers unconditionally (approval /
// user-question / PDF-preview paths, A3-1), which first ships in Safari 17.4 / macOS 14.4, so
// 13.x and 14.0–14.3 are unservable and the floor is 14.4. Both flavors ship from the same
// tag, so pin Electron's declaration, the Swift plist and the SwiftPM platform together; no
// pre-14.4 fallback on either leg. SwiftPM names a major (.macOS(.v14)) while the plist
// carries the EXACT 14.4, so the plist assertion below is the exact-floor check.
const nativeInfoPlistTemplate = readFileSync(new URL('../../macos/Info.plist.template', import.meta.url), 'utf8')
const swiftPackageManifest = readFileSync(new URL('../../macos/Package.swift', import.meta.url), 'utf8')
assert.equal(
  desktopPackage.build?.mac?.minimumSystemVersion,
  '14.4',
  'the Electron flavor must declare the native macOS floor 14.4 (S-30)',
)
assert.match(
  nativeInfoPlistTemplate,
  /<key>LSMinimumSystemVersion<\/key>\s*<string>14\.4<\/string>/,
  'the native .app must carry the exact LSMinimumSystemVersion 14.4 (the release floor)',
)
assert.match(
  swiftPackageManifest,
  /\.macOS\(\.v14\)/,
  'the Swift package must declare the same macOS floor (.v14) as the shipped plist',
)
assert.doesNotMatch(nativeInfoPlistTemplate, /<string>1[23]\.0<\/string>/,
  'no pre-14.4 fallback may be reintroduced in the native plist')
assert.doesNotMatch(swiftPackageManifest, /\.macOS\(\.v1[23]\)/,
  'no pre-14.4 fallback may be reintroduced in the Swift package')
// A1: app-builder-lib keeps a locale only when wanted === basename or wanted.startsWith(
// basename + '-' | '_') (ElectronFramework.js:81-88). Mac locale dirs use an UNDERSCORE
// (zh_CN.lproj), so the hyphenated "zh-CN" of the win/linux .pak legs can never match and
// silently deletes the packaged Chinese resources; the mac leg overrides electronLanguages
// with the real lproj basenames while the top-level value keeps the hyphenated spelling.
assert.ok(
  Array.isArray(desktopPackage.build?.mac?.electronLanguages)
  && desktopPackage.build.mac.electronLanguages.includes('zh_CN'),
  'the mac leg must declare the real lproj basename zh_CN (zh-CN never matches zh_CN.lproj)',
)
assert.ok(
  Array.isArray(desktopPackage.build?.electronLanguages)
  && desktopPackage.build.electronLanguages.includes('zh-CN'),
  'the win/linux .pak legs keep the hyphenated zh-CN spelling',
)

// Every build job (build-gateway / build-macos / build-windows / build-linux / build-swift)
// must build from the exact SHA create-release validated and bound the tag to; a default-branch
// advance must never ship an unvalidated commit under a validated tag (S16).
const buildJobs = workflow.slice(workflow.indexOf('  build-gateway:'))
const buildRefPins = buildJobs.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []
assert.equal(
  buildRefPins.length,
  5,
  'every build-job checkout must pin ref: ${{ github.sha }} to the validated workflow SHA',
)
assert.match(
  swiftBuild,
  /ref: \$\{\{ github\.sha \}\}/,
  'the native leg ships artifacts from the tag too: it must build the validated SHA like every other leg',
)

// --------------------------------------------------------- proof decision logic
// The proof gate's decision surface is pure, so every arm is covered here (the network poll
// only runs in release.yml): green, in-flight, failed run, failed leg, missing leg, flaky re-run.
const GREEN_RUN = {
  id: 1,
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://example.test/run/1',
  head_sha: 'a'.repeat(40),
  event: 'push',
  head_branch: 'main',
  created_at: '2026-09-13T07:00:00Z',
}
/** A GitHub jobs-API shape: every step the proof requires, green by default. */
const job = (name, conclusion, stepConclusion = 'success') => ({
  name,
  conclusion,
  steps: (REQUIRED_JOB_STEPS[name] ?? []).map(step => ({ name: step, conclusion: stepConclusion })),
})
/** The same job with one required step deleted (a leg step removed from ci.yml). */
const jobWithoutStep = (name, stepName) => {
  const entry = job(name, 'success')
  return { ...entry, steps: entry.steps.filter(step => step.name !== stepName) }
}
assert.equal(judgeRun(GREEN_RUN, [job('test', 'success'), job('test-windows', 'success'), job('test-macos', 'success')]).state, 'ok')
assert.equal(judgeRun(GREEN_RUN, [job('test', 'success'), job('test-windows', 'skipped')]).state, 'failed',
  'a skipped windows leg does not prove the win32 contracts')
assert.equal(judgeRun(GREEN_RUN, [job('test', 'success')]).state, 'failed',
  'a run without the windows job is an incomplete chain, not a proof')
assert.equal(judgeRun({ ...GREEN_RUN, status: 'in_progress', conclusion: null }, []).state, 'pending',
  'a run still in flight keeps the release waiting instead of failing')
assert.equal(judgeRun({ ...GREEN_RUN, conclusion: 'failure' }, []).state, 'failed')
assert.equal(judgeRun(null, []).state, 'failed', 'a missing run entry must fail closed')
// G25: job names alone are not a proof — the load-bearing steps must exist and be green,
// not a green job whose `swift test` step was deleted or prose-classifier-skipped.
assert.equal(
  judgeRun(GREEN_RUN, [
    job('test', 'success'),
    job('test-windows', 'success'),
    jobWithoutStep('test-macos', 'Swift tests (release configuration, XCTSkip == 0)'),
  ]).state,
  'failed',
  'deleting the macOS Swift/XCTest step must fail the proof',
)
assert.match(
  judgeRun(GREEN_RUN, [
    job('test', 'success'),
    job('test-windows', 'success'),
    jobWithoutStep('test-macos', 'Swift tests (release configuration, XCTSkip == 0)'),
  ]).reason,
  /no "Swift tests \(release configuration, XCTSkip == 0\)" step/,
)
assert.equal(
  judgeRun(GREEN_RUN, [
    jobWithoutStep('test', 'Package unit tests — single entry (runtime / control-plane / desktop / gateway / renderer-shell / client+host plugins)'),
    job('test-windows', 'success'),
    job('test-macos', 'success'),
  ]).state,
  'failed',
  'deleting a linux-chain step must fail the proof',
)
assert.equal(
  judgeRun(GREEN_RUN, [
    job('test', 'success', 'skipped'),
    job('test-windows', 'success'),
    job('test-macos', 'success'),
  ]).state,
  'failed',
  'a step the classifier skipped does not prove that gate ran on the release commit',
)
// A2 high: the mac packaging rehearsal is in the required table, so a run whose rehearsal was
// deleted (or classifier-skipped on a prose-only push) fails the proof even with all jobs green.
assert.equal(
  judgeRun(GREEN_RUN, [
    job('test', 'success'),
    job('test-windows', 'success'),
    jobWithoutStep('test-macos', 'macOS packaging rehearsal (ad-hoc, no publish, no credentials)'),
  ]).state,
  'failed',
  'deleting the mac packaging rehearsal step must fail the release proof',
)
// 2026-12 P2: the WINDOWS packaging rehearsal is the win32 mirror of the mac
// one — the NSIS pack used to be first executed inside release.yml (with the
// release credentials loaded) and the proof did not require its ci.yml
// rehearsal, so deleting or classifier-skipping that step left a release able
// to ship a win32 pack no push-path gate had ever produced. Pin the same shape
// as the mac rehearsal: push-only, classifier-gated, --publish=never, nothing
// uploaded — and require it by name in the proof.
const WIN_REHEARSAL_STEP = 'Windows packaging rehearsal (no publish, no credentials)'
assert.ok(
  REQUIRED_JOB_STEPS['test-windows'].includes(WIN_REHEARSAL_STEP),
  'G25/P2: the proof must require the Windows packaging rehearsal step',
)
const winRehearsal = jobBlock(ciWorkflow, 'test-windows').slice(
  jobBlock(ciWorkflow, 'test-windows').indexOf(`- name: ${WIN_REHEARSAL_STEP}`),
)
assert.notEqual(winRehearsal, '', 'ci.yml test-windows must define the Windows packaging rehearsal step')
assert.match(winRehearsal,
  /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && steps\.classify\.outputs\.code == 'true'/,
  'the win rehearsal is push-only and classifier-gated: never minutes of NSIS work per pull request')
assert.ok(
  winRehearsal.includes('pnpm --filter @dsh-chamber/desktop exec electron-builder --win --x64 --publish=never'),
  'the win rehearsal must run the release packaging invocation with --publish=never',
)
assert.doesNotMatch(winRehearsal, /--publish=always|gh release upload/,
  'the win rehearsal must not publish or upload anything')
assert.equal(
  judgeRun(GREEN_RUN, [
    job('test', 'success'),
    jobWithoutStep('test-windows', WIN_REHEARSAL_STEP),
    job('test-macos', 'success'),
  ]).state,
  'failed',
  'deleting the windows packaging rehearsal step must fail the release proof',
)
assert.equal(
  judgeRun(GREEN_RUN, [
    { name: 'test', conclusion: 'success' },
    job('test-windows', 'success'),
    job('test-macos', 'success'),
  ]).state,
  'failed',
  'a job entry with no step data cannot prove its steps ran (fail closed)',
)
assert.deepEqual(
  pickCandidateRuns([
    GREEN_RUN,
    { ...GREEN_RUN, id: 2, event: 'pull_request' },
    { ...GREEN_RUN, id: 3, head_branch: 'feature' },
    { ...GREEN_RUN, id: 4, head_sha: 'b'.repeat(40) },
  ], { sha: GREEN_RUN.head_sha, branch: 'main' }).map(run => run.id),
  [1],
  'only a push run on the base branch proves a release',
)
assert.equal(
  judgeCandidates([GREEN_RUN, { ...GREEN_RUN, id: 5, created_at: '2026-09-13T06:00:00Z' }], new Map([
    [5, [job('test', 'success'), job('test-windows', 'failure'), job('test-macos', 'success')]],
    [1, [job('test', 'success'), job('test-windows', 'success'), job('test-macos', 'success')]],
  ])).state,
  'ok',
  'a flaky failure that was re-run green still proves the commit',
)
assert.equal(judgeCandidates([{ ...GREEN_RUN, status: 'queued', conclusion: null }], new Map()).state, 'pending')
assert.equal(judgeCandidates([], new Map()).state, 'pending', 'no run yet is "not proven yet", never a failure')

// The proof's required set is the release's platform contract: freezing it here makes dropping
// a leg a deliberate edit, and the native artifacts ship from the same tag.
assert.deepEqual(
  REQUIRED_JOBS,
  ['test', 'test-windows', 'test-macos'],
  'the proof must require the push chain plus both platform contract legs, including the macOS leg that validates the native artifacts',
)
// G25: the job-name-only proof is gone. Every required job pins its load-bearing steps, and
// those names must exist verbatim in the ci.yml job the proof watches (rename => two-file edit).
assert.deepEqual(
  Object.keys(REQUIRED_JOB_STEPS).sort(),
  [...REQUIRED_JOBS].sort(),
  'every required job must pin the load-bearing steps the proof checks',
)
assert.ok(
  REQUIRED_JOB_STEPS['test-macos'].includes('Swift tests (release configuration, XCTSkip == 0)'),
  'the proof must require the step that runs `swift test`',
)
assert.ok(
  REQUIRED_JOB_STEPS['test-macos'].includes('Compiled sidecar smoke (shipped sidecar.js executes)'),
  'the proof must require the step that executes the shipped sidecar',
)
// A2 高危: the Electron mac pack used to be first really executed inside release.yml (after
// the draft existed, with Apple credentials loaded) — both real failures of the 0.3.2-beta
// series landed there. ci.yml now rehearses the exact chain on an ordinary main push and the
// release proof must require that rehearsal by name, else a deleted or classifier-skipped
// rehearsal silently shrinks coverage. Pin the rehearsal shape: push-only, classifier-gated,
// ad-hoc, --publish=never, no notarization/upload command anywhere in the step.
const MAC_REHEARSAL_STEP = 'macOS packaging rehearsal (ad-hoc, no publish, no credentials)'
assert.ok(
  REQUIRED_JOB_STEPS['test-macos'].includes(MAC_REHEARSAL_STEP),
  'G25/A2: the proof must require the mac packaging rehearsal step',
)
const macRehearsal = jobBlock(ciWorkflow, 'test-macos').slice(
  jobBlock(ciWorkflow, 'test-macos').indexOf(`- name: ${MAC_REHEARSAL_STEP}`),
)
assert.notEqual(macRehearsal, '', 'ci.yml test-macos must define the mac packaging rehearsal step')
assert.match(macRehearsal,
  /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main' && steps\.classify\.outputs\.code == 'true'/,
  'the rehearsal is push-only and classifier-gated: never minutes of packaging per pull request')
assert.match(macRehearsal, /CSC_IDENTITY_AUTO_DISCOVERY: 'false'/,
  'the rehearsal must never pick up a runner keychain identity (afterPack ad-hoc signs)')
assert.ok(
  macRehearsal.includes('pnpm --filter @dsh-chamber/desktop exec electron-builder --mac --arm64 --publish=never'),
  'the rehearsal must run the release packaging invocation with --publish=never',
)
assert.doesNotMatch(macRehearsal, /--publish=always|notarytool|gh release upload/,
  'the rehearsal must not publish, notarize or upload anything')
// G32: the two EXECUTED-assembly gates are the only steps that prove the shipped artifacts
// actually boot; a proof watching only their ci.yml presence would stay green after the step
// (or its build prerequisite) was deleted. Both must be in the required table, and run-checks
// must expose the same two gates so a developer's terminal runs what the proof demands — one
// has no package.json alias by design, so its entry is a direct command; pin exact strings.
for (const step of [
  'Electron compiled artifacts smoke (control-plane boot + preload surface)',
  'Native assembly acceptance (spawned sidecar boots + serves)',
]) {
  assert.ok(
    REQUIRED_JOB_STEPS['test-macos'].includes(step),
    `G32/G33: the proof must require the executed-assembly step "${step}"`,
  )
  assert.ok(
    jobBlock(ciWorkflow, 'test-macos').includes(`- name: ${step}`),
    `ci.yml test-macos must keep the proof-required step: ${step}`,
  )
}
const runChecksSource = readFileSync(new URL('../gates/run-checks.mjs', import.meta.url), 'utf8')
for (const entry of [
  'test:sidecar:compiled',
  'node scripts/gates/verify-electron-artifacts.mjs',
  'node scripts/gui-acceptance/run.mjs --flavor native --require-assembly',
]) {
  assert.ok(
    runChecksSource.includes(`'${entry}'`),
    `G32/G33: run-checks must expose the executed-assembly gate "${entry}" (a gate outside every local mode is only wired in CI)`,
  )
}
assert.ok(
  REQUIRED_JOB_STEPS['test'].includes('Package unit tests — single entry (runtime / control-plane / desktop / gateway / renderer-shell / client+host plugins)'),
  'the proof must require the linux-chain package test entry',
)
for (const [jobName, steps] of Object.entries(REQUIRED_JOB_STEPS)) {
  const block = jobBlock(ciWorkflow, jobName)
  for (const step of steps) {
    assert.ok(
      block.includes(`- name: ${step}`),
      `ci.yml job ${jobName} must keep the step the proof requires: ${step}`,
    )
  }
}
assert.match(jobBlock(ciWorkflow, 'test-macos'), /^\s+swift build -c release$/m,
  'the pinned macOS build step must still build the release configuration')
assert.match(jobBlock(ciWorkflow, 'test-macos'), /run-swift-tests\.mjs/,
  'the pinned macOS test step must run the gated release-configured Swift runner')

console.log('release workflow policy: commit-bound, published-immutable, beta-isolated, signed, GitHub-only gateway')
