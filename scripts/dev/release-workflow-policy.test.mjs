import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareReleaseVersions, releaseChannel } from './release-semver.mjs'
import { REQUIRED_JOBS, judgeCandidates, judgeRun, pickCandidateRuns } from './verify-release-ci-proof.mjs'


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
  swiftBuild.split('\n').some((line) => line.trim() === 'node scripts/dev/release-artifacts.mjs "$VERSION" --check-dir macos/release'),
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
  ['node scripts/dev/classify-ci-changes.mjs', 'push-path plumbing, not a gate: it only decides whether the expensive chain is worth running, and release validation always runs that chain in full, so there is nothing to classify.'],
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
  /- name: Release commit passed CI on main[\s\S]{0,400}?run: node scripts\/dev\/verify-release-ci-proof\.mjs --sha/,
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
// set are each invoked through `scripts/dev/run-checks.mjs`, so the number of
// conditioned steps is no longer a proxy for how much heavy work the classifier
// gates. Pin both facts: the concentrated entries themselves must be gated, and
// the gated step count must not fall below the post-collapse floor.
for (const entry of ['node scripts/dev/run-checks.mjs tests', 'node scripts/dev/run-checks.mjs typecheck']) {
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
const classifier = readFileSync(new URL('./classify-ci-changes.mjs', import.meta.url), 'utf8')
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
const upstreamGateRuns = validation.match(/^\s+run: node scripts\/dev\/verify-upstream-touchpoints\.mjs.*$/gm) ?? []
assert.equal(
  upstreamGateRuns.length,
  2,
  `release validation must run the upstream gate exactly twice (advisory + C8 rebuild), found ${upstreamGateRuns.length}`,
)
const advisoryGate = validation.indexOf('run: node scripts/dev/verify-upstream-touchpoints.mjs --no-artifact-rebuild')
const rebuildGate = validation.indexOf('run: node scripts/dev/verify-upstream-touchpoints.mjs\n')
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
const job = (name, conclusion) => ({ name, conclusion })
assert.equal(judgeRun(GREEN_RUN, [job('test', 'success'), job('test-windows', 'success'), job('test-macos', 'success')]).state, 'ok')
assert.equal(judgeRun(GREEN_RUN, [job('test', 'success'), job('test-windows', 'skipped')]).state, 'failed',
  'a skipped windows leg does not prove the win32 contracts')
assert.equal(judgeRun(GREEN_RUN, [job('test', 'success')]).state, 'failed',
  'a run without the windows job is an incomplete chain, not a proof')
assert.equal(judgeRun({ ...GREEN_RUN, status: 'in_progress', conclusion: null }, []).state, 'pending',
  'a run still in flight keeps the release waiting instead of failing')
assert.equal(judgeRun({ ...GREEN_RUN, conclusion: 'failure' }, []).state, 'failed')
assert.equal(judgeRun(null, []).state, 'failed', 'a missing run entry must fail closed')
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

console.log('release workflow policy: commit-bound, published-immutable, beta-isolated, signed, GitHub-only gateway')
