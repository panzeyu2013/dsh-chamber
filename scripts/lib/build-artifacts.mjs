/**
 * scripts/lib/build-artifacts.mjs - the SINGLE source of the untracked
 * build-time artifact set (clean checkouts bootstrap it with
 * 'pnpm run build:artifacts').
 *
 * Consumers (all import this module; none re-declares a path):
 *  - scripts/dev/ensure-artifacts.mjs - bootstrap/--check by ARTIFACTS (path list)
 *    and the aggregate BUILD_ARTIFACTS_COMMAND;
 *  - scripts/upstream/verify-upstream-touchpoints.mjs C8 - deterministic
 *    rebuild-and-byte-compare per group (script + output paths);
 *  - scripts/gates/verify-artifact-freshness.mjs cites C8 as the owner of the
 *    seed-dist freshness invariant (it no longer keeps a second seed list).
 *
 * A group is one build script and its outputs: the script is what C8 re-runs,
 * 'build' is the narrow pnpm command ensure-artifacts prints, and 'reason'
 * records why the artifact must exist.
 */

/** Aggregate build command that produces every artifact in ARTIFACT_GROUPS. */
export const BUILD_ARTIFACTS_COMMAND = 'pnpm run build:artifacts'

/**
 * Build-time artifact groups, in ensure-artifacts report order.
 * @type {readonly {
 *   name: string,
 *   idPrefix: string,
 *   packageDir: string,
 *   script: string,
 *   build: string,
 *   outputs: readonly string[],
 *   reason: string,
 * }[]}
 */
export const ARTIFACT_GROUPS = [
  {
    name: 'dsh-runtime',
    idPrefix: 'dsh-runtime',
    packageDir: 'packages/dsh-runtime',
    script: 'packages/dsh-runtime/scripts/build.mjs',
    build: 'pnpm run build:dsh-runtime',
    outputs: ['dist/index.js'],
    reason: 'the shared runtime core bundle the desktop/gateway installer ships; a stale copy is as wrong as a stale seed bundle',
  },
  {
    name: 'seed-client-graph',
    idPrefix: 'seed-client-graph',
    packageDir: 'packages/dsh-chamber-seed-client-graph',
    script: 'packages/dsh-chamber-seed-client-graph/scripts/build.mjs',
    build: 'pnpm run build:host-graph',
    outputs: ['dist/index.js'],
    reason: 'seeded host bundle for the client boot graph insert row',
  },
  {
    name: 'seed-git-worktree',
    idPrefix: 'seed-git-worktree',
    packageDir: 'packages/dsh-chamber-seed-git-worktree',
    script: 'packages/dsh-chamber-seed-git-worktree/scripts/build.mjs',
    build: 'pnpm run build:host-git',
    outputs: ['dist/index.js'],
    reason: 'seeded host bundle for the git worktree insert row',
  },
  {
    name: 'seed-archive-cleanup',
    idPrefix: 'seed-archive-cleanup',
    packageDir: 'packages/dsh-chamber-seed-archive-cleanup',
    script: 'packages/dsh-chamber-seed-archive-cleanup/scripts/build.mjs',
    build: 'pnpm run build:host-archive-cleanup',
    outputs: ['dist/index.js'],
    reason: 'seeded host bundle for the archive cleanup insert row',
  },
  {
    name: 'seed-open-in',
    idPrefix: 'seed-open-in',
    packageDir: 'packages/dsh-chamber-seed-open-in',
    script: 'packages/dsh-chamber-seed-open-in/scripts/build.mjs',
    build: 'pnpm run build:host-open-in',
    outputs: ['dist/index.js'],
    reason: 'design 20 §6: the open-in host domain (fork of upstream open-in-app) is seeded like the other host bundles; its built bundle must equal a fresh rebuild',
  },
  {
    name: 'mobile',
    idPrefix: 'mobile',
    packageDir: 'packages/dsh-chamber-client-ui-mobile',
    script: 'packages/dsh-chamber-client-ui-mobile/scripts/build.mjs',
    build: 'pnpm run build:mobile',
    outputs: ['dist/index.js', 'lib/index.js', 'lib/client.js', 'lib/client.js.map'],
    reason: 'the mobile browser half is a build-time artifact (package.json exports ./client -> lib/client.js) and the gateway seeds it byte for byte; lib/index.js is the mirrored host half',
  },
]

/**
 * Flat artifact list consumed by ensure-artifacts (path + narrow build command).
 * @type {readonly { id: string, path: string, build: string }[]}
 */
export const ARTIFACTS = ARTIFACT_GROUPS.flatMap((group) => group.outputs.map((output) => ({
  id: group.idPrefix + '/' + output,
  path: group.packageDir + '/' + output,
  build: group.build,
})))

/**
 * C8 view: one entry per group with repo-relative output paths.
 * @type {readonly { id: string, script: string, outputs: readonly string[], reason: string }[]}
 */
export const ARTIFACT_REBUILD_GROUPS = ARTIFACT_GROUPS.map((group) => ({
  id: group.name,
  script: group.script,
  outputs: group.outputs.map((output) => group.packageDir + '/' + output),
  reason: group.reason,
}))
