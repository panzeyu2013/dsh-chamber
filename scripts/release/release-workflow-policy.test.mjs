import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const validation = between('\n  validation:', '\n  build-gateway:')
const gatewayBuild = between('\n  build-gateway:', '\n  build-macos:')
const macBuild = between('\n  build-macos:', '\n  build-windows:')
const windowsBuild = between('\n  build-windows:', '\n  build-linux:')
const linuxBuild = between('\n  build-linux:', '\n  build-swift:')
// 2026-12 验证轮：整行注释必须先剥掉，否则被 `#` 注释掉的命令仍能满足锚点
// 断言（notarytool 提交被注释后测试仍绿）。所有 swiftBuild.* 断言因此只看代码行。
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
// The native artifacts ship from the same tag under a -native name; the dry
// run must be credential-free and the formal run fail-closed on the signing
// identity (A6: missing Apple credentials block the release, never silently
// downgrade to an ad-hoc build). The leg sits between build-linux and
// finalize-release, so the linux slice above must stop at its boundary.
//
// 2026-12 audit (P1): the old block was satisfiable by the wrong code —
// `--app-name dsh-chamber-native` alone matched the "native artifact names"
// alternation, `--identity` alone matched the "identity|notarytool"
// alternation, and nothing pinned the staple-before-archive order. Every claim
// is now an exact-string or an order assertion.
assert.match(swiftBuild, /pnpm run build:sidecar/)
assert.match(swiftBuild, /pnpm run build:swift-app --out macos\/release/)
assert.ok(swiftBuild.includes('--app-name dsh-chamber-native'))
assert.ok(swiftBuild.includes('--artifact-basename "dsh-chamber-native-${VERSION}-macos-arm64"'),
  'the uploaded .zip/.dmg basename must be exact (a -native substring is not enough)')
assert.ok(swiftBuild.includes('--identity "$IDENTITY"'),
  'the resolved Developer ID identity must actually be passed to build:swift-app')
assert.match(swiftBuild, /dry_run/, 'the native leg must branch on the dry-run input')
// Formal leg is credential fail-closed: no CSC_LINK → red; no Developer ID
// identity inside the imported p12 → red. The no-credentials path is the
// explicit dry-run branch only.
assert.ok(
  swiftBuild.includes('test -n "${CSC_LINK:-}" || { echo "::error::formal Swift release requires CSC_LINK"; exit 1; }'),
  'formal native release must fail closed when CSC_LINK is absent',
)
assert.ok(swiftBuild.includes('no Developer ID Application identity in CSC_LINK'),
  'formal native release must fail closed when the p12 carries no Developer ID identity')
// Formal leg assembles+signs only (--no-zip --no-dmg): the archives are made
// AFTER notarization+stapling, otherwise the uploaded .app has no ticket.
// The array is used through the bash-3.2-safe guarded expansion (macOS runner
// default bash + `set -u`: a bare "${ARTIFACT_ARGS[@]}" on the empty dry-run
// array is an unbound-variable error). Pin the value and exactly two
// expansions.
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
// Notarize then staple the .app BEFORE any distribution archive is written:
// a zip/dmg generated before stapling ships an unticketed app (offline
// Gatekeeper rejects it). The DMG itself is notarized+stapled after creation.
const notarySubmit = swiftBuild.indexOf('xcrun notarytool submit')
const dmgSubmit = swiftBuild.indexOf('xcrun notarytool submit "${BASE}.dmg"')
const appStaple = swiftBuild.indexOf('xcrun stapler staple "$APP"')
const appValidate = swiftBuild.indexOf('xcrun stapler validate "$APP"')
const zipWrite = swiftBuild.indexOf('ditto -c -k --sequesterRsrc --keepParent "$APP" "${BASE}.zip"')
const dmgCreate = swiftBuild.indexOf('hdiutil create')
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
assert.ok(swiftBuild.includes('ln -s /Applications "$DMG_STAGE/Applications"'),
  'the dmg volume must carry the /Applications symlink (P7)')
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
assert.ok(swiftBuild.includes('lipo -archs "$APP/Contents/MacOS/DSHChamberPoc"'),
  'the .app binary architecture must be asserted')
assert.ok(swiftBuild.includes('lipo -archs "$APP/Contents/Resources/sidecar/node"'),
  'the bundled node architecture must be asserted')
// Closure: the .app must carry the sidecar entrypoint, the assembly
// package.json, the control-plane relative entry and all four host packages.
assert.ok(swiftBuild.includes('test -f "$APP/Contents/Resources/sidecar/package.json"'))
assert.ok(swiftBuild.includes('test -f "$APP/Contents/Resources/sidecar/dist/control-plane/index.js"'))
// The loop's package list is pinned as an EXACT token set: a substring assertion
// would stay green if a name gained a suffix (…-open-in → …-open-in-x), which is
// exactly the drift the 2026-12 verification round found (exactness, not
// mutation-proven text).
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
// G16 (release blocker): the appcast used to run BEFORE notarize/staple, while
// the formal leg assembles with --no-zip --no-dmg — its `test -f "$ZIP"` could
// never see the zip that only exists after stapling, so every formal release
// with SPARKLE_PRIVATE_KEY configured went red (or signed a stale, un-notarized
// zip). It must follow the stapler step, sign the FINAL zip, and be unable to
// run before any artifact exists.
//
// S-36 (2026-12 audit, top severity): the beta appcast's enclosure resolved to
// the ROLLING tag while the zip was only uploaded to v<version> — discovering
// beta.N+1 then 404ing on download. The fixed shape has three load-bearing
// parts, all pinned below: (1) every archive the appcast references (current
// beta + the latest final zip for S-22/S-23) is staged into the generate_appcast
// input dir; (2) beta generation passes --download-url-prefix pinned to the
// rolling download dir so every enclosure URL resolves there; (3) the rolling
// release — the PUBLIC beta discovery surface — receives those archives BEFORE
// the appcast, and only after the fail-closed verification step. The stable
// channel passes no prefix and never touches the rolling release, so its
// enclosure shape (releases/latest/download/<zip>) stays byte-identical.
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
assert.ok(appcastStep.includes('ZIP="${BASE}.zip"'),
  'the appcast must sign the final distribution zip path (BASE = the artifact basename)')
const appcastZipGuard = appcastStep.indexOf('test -f "$ZIP"')
assert.notEqual(appcastZipGuard, -1, 'the appcast must fail closed when the final zip is absent')
assert.ok(appcastStep.indexOf('generate_appcast') > appcastZipGuard,
  'the zip-existence guard must run BEFORE generate_appcast (no appcast without an artifact)')
assert.ok(appcastStep.indexOf('curl') > appcastZipGuard,
  'nothing may be fetched before the final zip exists (the step cannot run before any artifact)')

// S-22/S-36: beta releases are GitHub prereleases, so releases/latest/download
// never resolves for them — and a version-fixed URL (releases/download/v<ver>/…)
// would only ever show beta.N its own asset. beta.N must discover beta.N+1 AND
// download it: the feed points at the ROLLING tag/release asset and the archive
// set the appcast references is uploaded there too.
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

// S-36 enclosure resolution, locked to Sparkle's own algorithm
// (ArchiveItem.archiveURL: URL(filename, relativeTo: prefix ?? embedded
// SUFeedURL)). With the prefix pinned to the rolling download dir every beta
// enclosure lands next to the appcast; the same URL falls out of the embedded
// feed, which is exactly why the zip must ALSO live on the rolling release.
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

// Staging: the signed beta zip always enters the generate_appcast input dir, and
// a beta release also pulls the latest final native zip from releases/latest so
// the beta appcast carries the final item too (S-22/S-23). A missing final zip
// degrades loudly, never fails the beta.
assert.ok(appcastStep.includes('cp "$ZIP" /tmp/appcast-in/'),
  'the final signed beta zip must be staged into the appcast input dir (S-36)')
assert.ok(appcastStep.includes(`--pattern '${NATIVE_STABLE_ZIP_PATTERN}'`),
  'the beta appcast must stage the latest final native zip (S-22/S-23)')
assert.ok(appcastStep.includes('gh release download "$STABLE_TAG"'),
  'the final zip must actually be fetched from the latest release')
assert.ok(appcastStep.includes('repos/${GITHUB_REPOSITORY}/releases/latest'),
  'the final tag must come from /releases/latest (never an implicit/possibly-prerelease latest)')
assert.match(appcastStep, /::warning::latest final release 没有可下载的 native zip/,
  'a missing final native zip must degrade loudly, never fail the beta release')

// Generation: exactly one generate_appcast call, without a prefix for stable and
// with the rolling prefix for beta (the guarded bash-3.2 array expansion keeps
// the stable command byte-identical).
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

// Rolling publish happens in the POST-verify upload step: archives first, then
// the appcast that references them. The probe/create-if-absent guard is
// unchanged (prerelease → never releases/latest); the stable branch never
// touches the rolling release.
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
assert.ok(uploadStep.includes('for ARCHIVE in /tmp/appcast-in/*.zip /tmp/appcast-in/*.delta; do'),
  'every archive the appcast references (zip AND delta) must be published to the rolling release (S-36)')
assert.ok(
  uploadStep.indexOf('gh release upload "$ROLLING_TAG" "$ARCHIVE" --clobber')
  < uploadStep.indexOf('gh release upload "$ROLLING_TAG" "$BETA_APPCAST" --clobber'),
  'archives must be published BEFORE the appcast that references them',
)
assert.ok(uploadStep.includes('STAGED_ZIP="/tmp/appcast-in/$(basename "${BASE}.zip")"'),
  'the appcast-referenced beta zip must be located by its exact basename')
assert.match(uploadStep, /::error::appcast 引用的 beta zip 不在收件目录/,
  'an appcast whose staged zip vanished must fail closed, never publish a 404 enclosure')
assert.match(uploadStep, /::warning::beta appcast 缺失/,
  'a missing SPARKLE_PRIVATE_KEY stays a loud skip (release still ships)')

// S-23: a FINAL release also refreshes the rolling beta appcast (preserving the
// newest beta item), so a beta client discovers the final version even when the
// final ships after the last beta — the native analog of Electron's latest.yml
// fallback. The refresh is gated on the rolling release already existing and on
// the stable appcast having actually been generated (missing key → loud skip);
// the stable appcast asset itself is never rewritten (byte-identical channel).
assert.ok(uploadStep.includes('STABLE_APPCAST="macos/release/appcast-swift.xml"'),
  'the stable branch must gate the rolling refresh on the generated stable appcast')
assert.match(uploadStep, /::warning::stable appcast 缺失/,
  'a missing stable appcast (no private key) must skip the refresh loudly, never red the release')
assert.ok(uploadStep.includes('BETA_ZIP_NAME=') && uploadStep.includes('--json assets')
  && uploadStep.includes('sort -V'),
  'the refresh must preserve the newest beta zip item held by the rolling release')
assert.ok(uploadStep.includes('gh release download "$ROLLING_TAG" --repo "$GITHUB_REPOSITORY" --pattern "$BETA_ZIP_NAME"'),
  'the preserved beta archive must be fetched from the rolling release')
assert.match(uploadStep, /::warning::滚动通道没有 beta zip 资产/,
  'an empty rolling beta channel degrades loudly to a final-only refresh')
assert.ok(uploadStep.includes(
  '--download-url-prefix "https://github.com/${GITHUB_REPOSITORY}/releases/download/${ROLLING_TAG}/"'),
  'the refreshed rolling appcast must pin the same rolling download prefix')
assert.ok(uploadStep.includes('/tmp/appcast-stable-refresh-out/appcast-swift-beta.xml'),
  'the refreshed feed must be uploaded under the exact SUFeedURL asset name')
// V1 re-verification: generate_appcast also references .delta archives; uploading
// only *.zip leaves delta enclosures unresolved (Sparkle falls back to the full
// zip, but the appcast must not advertise unreachable assets).
assert.match(uploadStep, /for ARCHIVE in \/tmp\/appcast-in\/\*\.zip \/tmp\/appcast-in\/\*\.delta; do/,
  'the beta upload must publish zip AND delta archives before the appcast')
assert.match(uploadStep, /for ARCHIVE in \/tmp\/appcast-stable-refresh\/\*\.zip \/tmp\/appcast-stable-refresh\/\*\.delta; do/,
  'the stable refresh must publish zip AND delta archives before the refreshed appcast')
assert.ok(
  uploadStep.indexOf('gh release upload "$ROLLING_TAG" "$ARCHIVE" --clobber', uploadStep.indexOf('STABLE_APPCAST='))
  < uploadStep.indexOf('gh release upload "$ROLLING_TAG" /tmp/appcast-stable-refresh-out/appcast-swift-beta.xml --clobber'),
  'the refresh must publish archives before the refreshed appcast too',
)

// G29: a reused output dir can hold older versions side by side (0.3.1 +
// 0.3.2-beta.1 reproduced locally); the leg never globs — every native
// reference and the upload are exact artifactBasename paths.
assert.doesNotMatch(swiftBuild, /macos\/release\/\*\.(dmg|zip)/,
  'the native leg must never glob macos/release for dmg/zip')
assert.ok(swiftBuild.includes('test -f "${BASE}.dmg"') && swiftBuild.includes('test -f "${BASE}.zip"'),
  'the verify step must assert the exact artifact names')
assert.ok(swiftBuild.includes('"${BASE}.dmg" "${BASE}.zip" --clobber'),
  'the upload must name exactly the manifest artifacts (no stale sibling swept in)')


// G36: the Electron leg must not glob its own output dir either (G29 fixed the
// Swift leg only). A reused packages/desktop/release can hold older versions
// side by side; every reference now names the exact staged artifact, and the
// zip verify step must carry the VERSION env its path interpolation needs.
assert.ok(macBuild.includes('BASE="packages/desktop/release/dsh-chamber-${VERSION}-arm64"'),
  'G36: the mac leg must derive the exact artifact base from VERSION')
assert.ok(macBuild.includes('APP_DIR="packages/desktop/release/mac-arm64/dsh-chamber.app"'),
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
// S-31: electron-builder notarizes the .app only; the dmg itself needs its own
// notarytool submit + staple (+ validate) or offline Gatekeeper rejects the
// mounted volume. The build step already published the unstapled dmg, so the
// stapled file is re-uploaded over it.
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
assert.match(dmgStep, /spctl --assess --type open[^\n]*"\$DMG"/, 'the dmg must be Gatekeeper-assessed')
assert.match(dmgStep, /gh release upload "v\$\{VERSION\}" "\$DMG" --clobber/,
  'the stapled dmg must replace the unstapled asset electron-builder published')
// G28: the uploaded zip is not just `test -n`-ed — it is extracted and the .app
// inside is re-verified (mirrors the Swift leg's P4(b)).
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
// The release path validates itself because a tag push runs ci.yml and
// release.yml in PARALLEL — publishing an untested commit must be impossible.
// The list below therefore has to track ci.yml's gate set: the 2026-12 review
// P2 found gates that only ci.yml ran (design-token conformance, upgrade
// tooling, the third-party-notices diff, the desktop packaging sub-builds, and
// the upstream-touchpoint registry/C8 gate), so a release could ship a commit
// that the push path would have rejected.
// ---------------------------------------------------------------- mechanical
// alignment contract (2026-09)
//
// The release validation chain and the push chain used to be two hand-written
// lists kept aligned by a hand-written list of gate names HERE. That is how a
// gate added to ci.yml alone slips through: `test:gui-acceptance` did exactly
// that. So the contract is now derived FROM ci.yml — every gate command the push
// path runs must appear in release validation, or be listed in EXEMPT with the
// reason and where its coverage lives instead.
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

/**
 * Gates the push path runs that release validation deliberately does NOT: each
 * entry names the reason and where the coverage lives instead. A gate that is
 * simply missing is a failure, not an exemption.
 */
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
// An exemption that stops being needed must be removed, not left to rot: the
// gate is either back in the push path or now covered by validation.
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
// A release PROVES its commit passed CI instead of re-running the chain on the
// tag (2026-09 CI-trigger revision). The old shape had the linux chain step aside
// for tags while the windows leg re-ran the identical SHA — and tagging a commit
// that never went through main skipped the linux chain entirely, so "no release
// from an untested commit" rested on procedure rather than an assertion. Now
// ci.yml has no tag path at all and release validation carries the proof. The
// classifier must stay frozen so widening the prose allowlist (which SKIPS gates)
// cannot happen by accident.
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
// The proof names every required leg explicitly, so release validation cannot pass on a
// commit whose linux chain or windows leg never ran.
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
// 2026-12 single-entry collapse: the package test set and the client typecheck
// set are each invoked through `scripts/gates/run-checks.mjs`, so the number of
// conditioned steps is no longer a proxy for how much heavy work the classifier
// gates. Pin both facts: the concentrated entries themselves must be gated, and
// the gated step count must not fall below the post-collapse floor.
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

// The prose allowlist decides what SKIPS the heavy chain, so freeze it here:
// widening it must be a deliberate edit to this assertion.
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
// The upstream-touchpoint registry gate runs in TWO passes, and both are
// load-bearing: a substring check on the script path alone would pass with
// either one missing, so pin the exact command lines AND their order relative
// to the install (the advisory pass is file-only and must fail fast before it;
// the C8 rebuild pass needs esbuild from node_modules and must come after).
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
// Regenerating the notices file is not a gate by itself — the committed file
// must be proven current, on both the English mirror and the canonical one.
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
// S-30: without an explicit mac.minimumSystemVersion the Electron flavor inherits
// the Electron runtime's floor (12.0 in Electron 43.x) while the Swift shell
// declares 13.0 (Info.plist.template / Package.swift) — one support matrix, one
// floor. Both flavors ship from the same tag, so the native release carries the
// SAME 13.0 floor: pin the Electron declaration, the Swift plist and the SwiftPM
// platform together. There is no macOS 12 fallback on either leg — raising the
// floor is a deliberate edit in all three places.
const nativeInfoPlistTemplate = readFileSync(new URL('../../macos/Info.plist.template', import.meta.url), 'utf8')
const swiftPackageManifest = readFileSync(new URL('../../macos/Package.swift', import.meta.url), 'utf8')
assert.equal(
  desktopPackage.build?.mac?.minimumSystemVersion,
  '13.0',
  'the Electron flavor must declare the native macOS floor 13.0 (S-30)',
)
assert.match(
  nativeInfoPlistTemplate,
  /<key>LSMinimumSystemVersion<\/key>\s*<string>13\.0<\/string>/,
  'the native .app must carry LSMinimumSystemVersion 13.0 (the release floor)',
)
assert.match(
  swiftPackageManifest,
  /\.macOS\(\.v13\)/,
  'the Swift package must declare the same macOS 13 floor as the shipped plist',
)
assert.doesNotMatch(nativeInfoPlistTemplate, /<string>12\.0<\/string>/,
  'no macOS 12 fallback may be reintroduced in the native plist')
assert.doesNotMatch(swiftPackageManifest, /\.macOS\(\.v12\)/,
  'no macOS 12 fallback may be reintroduced in the Swift package')

// Every build job (build-gateway / build-macos / build-windows / build-linux /
// build-swift)
// must build from the exact SHA the create-release job validated and bound
// the tag to; a default-branch advance between jobs must never ship an
// unvalidated commit under a validated tag (S16).
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
// The proof gate's decision surface is pure, so every arm is covered here (the
// network poll itself only runs in release.yml): green run with both legs, a run
// still in flight, a failed run, a failed leg, a missing leg, and "a flaky
// failure re-run green still proves the commit".
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
// G25: job names alone are not a proof — the load-bearing steps must exist and
// be green. The proof used to accept a green job whose `swift test` step had
// been deleted, or whose heavy step the prose-only classifier skipped.
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

// The proof's required set is the release's platform contract: freezing it here
// means dropping a leg has to be a deliberate edit, and adding the native leg
// to the SHIPPED set without adding it here is exactly the hole this asserts
// against (the native artifacts ship from the same tag).
assert.deepEqual(
  REQUIRED_JOBS,
  ['test', 'test-windows', 'test-macos'],
  'the proof must require the push chain plus both platform contract legs, including the macOS leg that validates the native artifacts',
)
// G25: the job-name-only proof is gone. Every required job pins its load-bearing
// steps, and those names must exist verbatim in the ci.yml job the proof watches
// (a rename/deletion is then a deliberate two-file edit instead of silent drift).
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
// G32: the two EXECUTED-assembly gates are the only steps that prove the
// shipped artifacts actually boot; a proof that watched only their ci.yml
// presence would stay green after the step (or its build prerequisite) was
// deleted. Both must be in the required table, and the local gate entry
// (run-checks) must expose the same two gates so a developer's terminal runs
// what the proof demands — one of them has no package.json alias by design
// (the gate lives in scripts/gates/), so the run-checks entry is a direct
// command; pin the exact strings rather than a substring.
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
