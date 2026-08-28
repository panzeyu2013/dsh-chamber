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
const create = between('      - name: Create GitHub Release (draft)', '\n  build-gateway:')
const validation = between('\n  validation:', '\n  build-gateway:')

assert.match(tagBinding, /git rev-parse "\$\{TAG\}\^\{commit\}"/)
assert.match(tagBinding, /TAG_SHA.*RELEASE_SHA/)
assert.match(workflow, /node scripts\/dev\/release-preflight\.mjs "\$VERSION" --versions-only/)
assert.doesNotMatch(workflow, /for PKG in/)
assert.doesNotMatch(workflow, /all \d+ chamber packages/i)
assert.match(workflow, /release version must be canonical SemVer/)
assert.doesNotMatch(workflow, /VERSION="\$\{\{[^\n]*outputs\.version/)
assert.match(workflow, /group: release-publish/)
assert.match(workflow, /cancel-in-progress: false/)
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
assert.match(workflow, /npm publish "\$TGZ" --access public --tag "\$CHANNEL"/)
assert.match(workflow, /npm dist-tag add/)
assert.match(workflow, /refusing to move npm \$\{CHANNEL\} backward/)
assert.match(workflow, /make_latest:/)
for (const requiredGate of [
  'pnpm run typecheck:gateway',
  'pnpm run typecheck:runtime',
  'pnpm run test:gateway',
  'pnpm run test:runtime',
  'pnpm run test:release-workflow',
  'pnpm run test:cli',
  'node packages/control-plane/test/gateway-transport.test.ts',
  'node packages/control-plane/test/restart-local.ts',
]) {
  assert.ok(
    validation.includes(requiredGate),
    `release validation must include the CI gate: ${requiredGate}`,
  )
}
assert.equal(releaseChannel('1.2.3'), 'latest')
assert.equal(releaseChannel('1.2.3-beta.1'), 'beta')
assert.equal(compareReleaseVersions('1.2.3-beta.2', '1.2.3-beta.10'), -1)
assert.equal(compareReleaseVersions('1.2.3-beta.10', '1.2.3'), -1)
assert.equal(compareReleaseVersions('2.0.0', '1.99.99'), 1)
assert.throws(() => releaseChannel('1.2.3;echo injected'))
assert.equal(
  desktopPackage.build?.electronDownload,
  undefined,
  'formal desktop builds must not trust a committed third-party Electron mirror',
)

// Every build job (build-gateway / build-macos / build-windows) must build
// from the exact SHA the create-release job validated and bound the tag to;
// a default-branch advance between jobs must never ship an unvalidated
// commit under a validated tag (S16).
const buildJobs = workflow.slice(workflow.indexOf('  build-gateway:'))
const buildRefPins = buildJobs.match(/ref: \$\{\{ github\.sha \}\}/g) ?? []
assert.equal(
  buildRefPins.length,
  3,
  'every build-job checkout must pin ref: ${{ github.sha }} to the validated workflow SHA',
)

console.log('release workflow policy: commit-bound, published-immutable, dry-run mutation-free')
