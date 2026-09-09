import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareReleaseVersions, releaseChannel } from './release-semver.mjs'

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
const swiftBuild = between('\n  build-swift:', '\n  finalize-release:')

assert.match(tagBinding, /git rev-parse "\$\{TAG\}\^\{commit\}"/)
assert.match(tagBinding, /TAG_SHA.*RELEASE_SHA/)
assert.match(workflow, /node scripts\/dev\/release-preflight\.mjs "\$VERSION" --versions-only/)
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
// --- Swift native shell leg (design 25, W-26) -----------------------------
// The native artifacts ship from the same tag under a -native name; the dry
// run must be credential-free and the formal run fail-closed on the signing
// identity (A6: missing Apple credentials block the release, never silently
// downgrade to an ad-hoc build).
assert.match(swiftBuild, /pnpm run build:sidecar/)
assert.match(swiftBuild, /pnpm run build:swift-app --out macos\/release/)
assert.match(swiftBuild, /--app-name dsh-chamber-native/)
assert.match(swiftBuild, /--artifact-basename "dsh-chamber-native-\$\{VERSION\}-macos-arm64"/)
assert.match(swiftBuild, /unset CSC_LINK CSC_KEY_PASSWORD APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_TEAM_ID GH_TOKEN/)
assert.match(swiftBuild, /formal Swift release requires CSC_LINK/)
assert.match(swiftBuild, /no Developer ID Application identity in CSC_LINK/)
assert.match(swiftBuild, /notarytool submit/)
assert.match(swiftBuild, /stapler staple/)
assert.match(swiftBuild, /gh release upload "v\$\{VERSION\}"/)
assert.match(swiftBuild, /--clobber/)
assert.match(swiftBuild, /basename "\$APP\/Contents\/Resources\/sidecar\/node"/)
assert.match(swiftBuild, /= "node"/)
assert.match(swiftBuild, /bridge-shim\.poc\.js/)
assert.match(swiftBuild, /dist\/web\/index\.html/)
assert.match(swiftBuild, /ARTIFACT_ARGS=\(--no-zip --no-dmg\)/)
// macOS runners default to bash 3.2: an empty array under `set -u` makes
// "${A[@]}" an unbound-variable error, so the dry-run path (empty array) MUST
// use the guarded expansion form.
assert.ok(
  swiftBuild.includes('${ARTIFACT_ARGS[@]+"${ARTIFACT_ARGS[@]}"}'),
  'dry-run empty array must use the bash-3.2-safe guarded expansion',
)
assert.equal(
  swiftBuild.split('${ARTIFACT_ARGS[').length - 1,
  2,
  'the guarded form is the ONLY ARTIFACT_ARGS expansion (an extra unguarded one breaks dry-run on bash 3.2)',
)
assert.match(swiftBuild, /notarytool submit "\$SUBMIT_ZIP"/)
assert.match(swiftBuild, /stapler staple "\$APP"/)
assert.ok(
  swiftBuild.indexOf('stapler staple "$APP"') < swiftBuild.indexOf('ditto -c -k --sequesterRsrc --keepParent "$APP" "${BASE}.zip"'),
  'final archives must be built AFTER stapling (ticket must be inside the shipped .app)',
)
// Notarize/Upload must stay gated on a non-dry-run (mutation steps).
assert.match(swiftBuild, /- name: Notarize \+ staple native app \(release only\)\n        if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/)
assert.match(swiftBuild, /- name: Upload native artifacts to the draft release\n        if: \$\{\{ github\.event\.inputs\.dry_run != 'true' \}\}/)

assert.match(workflow, /make_latest=false/)
assert.match(workflow, /make_latest=true/)
assert.match(workflow, /needs: \[create-release, build-gateway, build-macos, build-windows, build-linux, build-swift\]/)
for (const requiredGate of [
  'pnpm run typecheck:gateway',
  'pnpm run typecheck:runtime',
  'pnpm run test:gateway',
  'pnpm run test:runtime',
  'pnpm run test:release-workflow',
  'pnpm run test:cli',
  'pnpm run test:control-plane',
  'pnpm run test:open-in',
  'pnpm run typecheck:connection',
]) {
  assert.ok(
    validation.includes(requiredGate),
    `release validation must include the CI gate: ${requiredGate}`,
  )
}
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

console.log('release workflow policy: commit-bound, published-immutable, beta-isolated, signed, GitHub-only gateway')
