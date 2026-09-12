import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compareReleaseVersions, releaseChannel } from './release-semver.mjs'


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
const linuxBuild = between('\n  build-linux:', '\n  finalize-release:')

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
assert.match(workflow, /make_latest=false/)
assert.match(workflow, /make_latest=true/)
assert.match(workflow, /needs: \[create-release, build-gateway, build-macos, build-windows, build-linux\]/)
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
// The tag path must not run the push chain twice, but must not lose the leg
// release.yml lacks either; the classifier must be frozen so widening the prose
// allowlist (which SKIPS gates) cannot happen by accident.
assert.match(
  ciWorkflow,
  /\n  test:\n(?:(?:[ \t]+#[^\n]*)?\n)*[ \t]+if:\s*github\.ref_type\s*!=\s*'tag'\n/,
  'the linux push chain must step aside for tag pushes (release.yml validates those)',
)
const ciWindowsJob = jobBlock(ciWorkflow, 'test-windows')
assert.ok(
  !/^\s+if:\s*github\.ref_type\s*!=\s*'tag'\s*$/m.test(ciWindowsJob),
  'the windows leg must KEEP running on tag pushes: release.yml has no win32-semantics leg',
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
assert.ok(
  classifiesHeavySteps(ciTestJob) >= 15,
  'the heavy push chain must be gated by the change classifier (steps.classify.outputs.code)',
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

// Every build job (build-gateway / build-macos / build-windows / build-linux)
// must build from the exact SHA the create-release job validated and bound
// the tag to; a default-branch advance between jobs must never ship an
// unvalidated commit under a validated tag (S16).
const buildJobs = workflow.slice(workflow.indexOf('  build-gateway:'))
const buildRefPins = buildJobs.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []
assert.equal(
  buildRefPins.length,
  4,
  'every build-job checkout must pin ref: ${{ github.sha }} to the validated workflow SHA',
)

console.log('release workflow policy: commit-bound, published-immutable, beta-isolated, signed, GitHub-only gateway')
