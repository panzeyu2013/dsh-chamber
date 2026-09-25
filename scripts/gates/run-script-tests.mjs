/**
 * Repository script-test manifest and runner — the single entry for every
 * `*.test.mjs` under `scripts/`.
 *
 * WHY: the groups below mirror the scripts/ directory taxonomy
 * (`scripts/README.md` §目录): a test's home states what it locks, and the root
 * manifest exposes one script per group.
 *
 * The manifest is authoritative in BOTH directions: a `*.test.mjs` under
 * `scripts/` that no group lists fails the run, a listed file that disappeared
 * fails the run, and every stem must name the module it unit-tests (a
 * `<stem>.mjs` beside it) unless it is one of the documented SUBJECT_TESTS
 * locks — a lockstep over repository files has no single module to name.
 *
 * Execution mirrors each package's `scripts/test.mjs`: one node child per file
 * with inherited stdio, first failure ends the run.
 *
 * Usage:
 *   node scripts/gates/run-script-tests.mjs                     # every group
 *   node scripts/gates/run-script-tests.mjs --group upstream    # repeatable
 *   node scripts/gates/run-script-tests.mjs --list
 *   node scripts/gates/run-script-tests.mjs --jobs 8            # file-level pool
 *
 * Exit codes (scripts/README.md §分类规则 2): 0 pass · 1 failure · 2 usage error.
 */
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { walkFiles } from '../lib/walk.mjs'
// The shared bounded-pool runner: the scripts suite uses the same file-level
// concurrency knob (--jobs / DSH_TEST_JOBS) the package manifests use, so one
// DSH_TEST_JOBS budget governs the whole tests mode.
import { resolveJobs, spawnCaptured } from '../lib/test-manifest.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Group -> authoritative file list, repository-root relative, in run order. */
export const GROUPS = {
  // Every-push repository gates: the CI change classifier, the gate runners'
  // own failure modes, the doc/test-wiring gates and the workflow-scalar gate.
  gates: [
    'scripts/gates/classify-ci-changes.test.mjs',
    'scripts/gates/run-checks.test.mjs',
    'scripts/gates/run-script-tests.test.mjs',
    'scripts/gates/verify-md-links.test.mjs',
    'scripts/gates/verify-test-wiring.test.mjs',
    'scripts/gates/verify-workflow-action-pins.test.mjs',
    'scripts/gates/install-gateway-pure.test.mjs',
    // The ladder-table parity gate's own comparison (G-G negative control) and the
    // dead-export gate's surface resolver (G-H negative control).
    'scripts/gates/verify-ladder-table-parity.test.mjs',
    'scripts/gates/verify-no-dead-exports.test.mjs',
    // The god-file ratchet's schema/classifier/CLI controls and the
    // import-cycle resolver's parser/graph controls — the two gate self-tests
    // made automatic, so a malformed budget or a silently-matching resolver
    // can never pass as a clean gate.
    'scripts/gates/verify-file-budgets.test.mjs',
    'scripts/gates/verify-import-cycles.test.mjs',
    'scripts/gates/verify-upstream-lifecycle-contract.test.mjs',
    'scripts/gates/verify-workflow-yaml-scalars.test.mjs',
    // 包边界门（R4 P7）：A/B 判据的负控与真实仓库正控。
    'scripts/gates/verify-package-boundaries.test.mjs',
    // Shared package-test runner (its zero-case guard is a repository gate
    // helper, so it runs with the gate suites).
    'scripts/lib/test-manifest.test.mjs',
    // The shared SDK-copy typecheck engine (the two gate entry points are
    // run-checks typecheck steps; the engine's path/diagnostic split is where a
    // silently-wrong filter would hide).
    'scripts/dev/typecheck-sdk-copy.test.mjs',
    // The shared test-only vendor resolve-hook factory (three package loaders).
    'scripts/dev/test-support/vendor-resolve.test.mjs',
    // Shared sidecar launch plumbing (free-port picker + argv/env contract).
    'scripts/lib/sidecar-launch.test.mjs',
    // Shared scripts-toolbox CLI epilogue (usage block / failure projection).
    'scripts/lib/cli.test.mjs',
  ],
  // Upstream pin and touchpoint tooling (pin preflight, lockfile repair,
  // registry/touchpoint gates, protected-set and anchor gates).
  upstream: [
    'scripts/upstream/preflight-vendor-pin.test.mjs',
    'scripts/upstream/artifact-gate.test.mjs',
    'scripts/upstream/restore-lockfile-vendor-records.test.mjs',
    'scripts/upstream/verify-upstream-touchpoints-args.test.mjs',
    'scripts/upstream/registry.test.mjs',
    'scripts/upstream/check-anchors.test.mjs',
    'scripts/upstream/plugin-protection-gate.test.mjs',
    'scripts/upstream/lockfile-store-path-mappings.test.mjs',
    'scripts/upstream/verify-mobile-anchors.test.mjs',
  ],
  // Release chain: workflow safety policy, dual-flavor artifact清单, packaging
  // manifest lockstep.
  release: [
    'scripts/release/release-workflow-policy.test.mjs',
    'scripts/release/release-artifacts.test.mjs',
    'scripts/release/merge-native-feed.test.mjs',
    'scripts/release/packaging-manifest-lockstep.test.mjs',
  ],
  // GUI acceptance toolbox judgement layer (the driving layer needs a display
  // and a running app, so it stays a local gate).
  'gui-acceptance': [
    'scripts/gui-acceptance/checks.test.mjs',
    'scripts/gui-acceptance/mobile-checks.test.mjs',
    'scripts/gui-acceptance/mobile-walkthrough.test.mjs',
    // The --live probe's registry resolution (MX sweep source): an explicit
    // --registry must win over the Electron userData convention, and the
    // id/kind-only reader must stay the only thing that touches the file.
    'scripts/gui-acceptance/probe.test.mjs',
  ],
}

/**
 * Tests whose stem names the artifact they lock instead of a module beside them
 * (no single module can be named). Each entry needs the reason the exception
 * is accepted, and the runner fails when an entry is no longer listed.
 */
export const SUBJECT_TESTS = [
  {
    path: 'scripts/release/packaging-manifest-lockstep.test.mjs',
    reason: 'locks the packaged-manifest rows shared by build-sidecar / build-host-graph-package / before-pack; the subject is the manifest agreement, not one module',
  },
  {
    path: 'scripts/release/release-workflow-policy.test.mjs',
    reason: 'derives the release/push gate alignment from .github/workflows/ci.yml; the subject is the workflow pair, not one module',
  },
  {
    path: 'scripts/gates/install-gateway-pure.test.mjs',
    reason: 'locks the pure validators/version comparison embedded in scripts/install-gateway.sh (single-file installer); the program text is extracted from the shipped script and executed in node:vm',
  },
  {
    path: 'scripts/upstream/lockfile-store-path-mappings.test.mjs',
    reason: 'locks tsconfig path mappings against pnpm-lock store paths that no chamber script owns',
  },
]

// ONE walk for every gate that scans the repository (scripts/lib/walk.mjs).
// This caller keeps its own narrow ignore set
// because scripts/ contains REAL directories named like build output:
// scripts/release/ (tests) and scripts/lib/ (shared modules + their tests) —
// the repo-wide union would silently drop both.
const SCRIPT_TEST_IGNORED_DIRECTORIES = ['node_modules', 'dist', '.git']

/**
 * Resolve the command line into a selection.
 * `--jobs` is recognized (and its value consumed) here but validated by
 * {@link resolveJobs}; leaving it out of `problems` keeps one concurrency parser
 * shared with the package manifests.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{ groups: string[], list: boolean, problems: string[] }} the groups to run (all when none was named).
 */
export function resolveSelection(argv) {
  const problems = []
  const groups = []
  let list = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--list') { list = true; continue }
    if (argument === '--jobs') {
      if (argv[index + 1] === undefined) { problems.push('--jobs needs a concurrency value'); break }
      index += 1
      continue
    }
    if (argument.startsWith('--jobs=')) continue
    if (argument === '--group') {
      const name = argv[index + 1]
      if (name === undefined) { problems.push('--group needs a group name'); break }
      if (!Object.hasOwn(GROUPS, name)) {
        problems.push(`unknown group '${name}' (known: ${Object.keys(GROUPS).join(', ')})`)
      } else if (!groups.includes(name)) groups.push(name)
      index += 1
      continue
    }
    problems.push(`unknown argument '${argument}'`)
  }
  return { groups: groups.length > 0 ? groups : Object.keys(GROUPS), list, problems }
}

/**
 * Compare the manifest with what is on disk and with the naming rule.
 * @param {object} input - collected facts.
 * @param {readonly { group: string, path: string }[]} input.listed - every manifest entry, in group order.
 * @param {readonly string[]} input.onDisk - every `.test.mjs`/`.test.ts` under `scripts/`, repository-root relative.
 * @param {(path: string) => boolean} input.moduleExists - whether `<stem>.mjs` exists beside a test file.
 * @param {readonly { path: string, reason: string }[]} [input.subjects] - accepted subject locks.
 * @returns {string[]} problems, empty when the manifest is whole.
 */
export function manifestProblems({ listed, onDisk, moduleExists, subjects = SUBJECT_TESTS }) {
  const problems = []
  const seen = new Map()
  for (const entry of listed) {
    const previous = seen.get(entry.path)
    if (previous !== undefined) problems.push(`${entry.path} is listed twice (${previous} and ${entry.group})`)
    else seen.set(entry.path, entry.group)
    if (!onDisk.includes(entry.path)) problems.push(`${entry.path} is listed by '${entry.group}' but does not exist`)
  }
  for (const path of onDisk) {
    if (!path.endsWith('.test.mjs')) {
      problems.push(`${path} must be a .test.mjs: the scripts suites are ESM files this manifest owns (scripts/README.md §分类规则 3)`)
      continue
    }
    if (!seen.has(path)) problems.push(`${path} exists but no group lists it`)
  }
  const subjectPaths = new Set(subjects.map(entry => entry.path))
  for (const path of seen.keys()) {
    if (subjectPaths.has(path)) continue
    if (!moduleExists(path)) {
      problems.push(`${path} must be named after the module it tests (missing ${path.replace(/\.test\.mjs$/u, '.mjs')}), or listed in SUBJECT_TESTS with a reason`)
    }
  }
  for (const entry of subjects) {
    if (!seen.has(entry.path)) problems.push(`SUBJECT_TESTS lists ${entry.path}, but no group carries it — drop the entry`)
  }
  return problems
}

/**
 * List every `*.test.mjs` / `*.test.ts` under `scripts/`, repository-root relative, sorted.
 * @returns {string[]} test file paths.
 */
export function collectScriptTests() {
  return walkFiles(join(REPO_ROOT, 'scripts'), path => /\.test\.(?:mjs|ts)$/u.test(path), { ignoredDirs: SCRIPT_TEST_IGNORED_DIRECTORIES })
    .map(path => relative(REPO_ROOT, path).split(sep).join('/'))
    .sort()
}

async function main() {
  const selection = resolveSelection(process.argv.slice(2))
  if (selection.problems.length > 0) {
    for (const problem of selection.problems) console.error(`[script-tests] ${problem}`)
    console.error('[script-tests] usage: node scripts/gates/run-script-tests.mjs [--group <name>]... [--list]')
    process.exit(2)
  }
  const listed = Object.entries(GROUPS).flatMap(([group, files]) => files.map(path => ({ group, path })))
  const onDisk = collectScriptTests()
  const problems = manifestProblems({
    listed,
    onDisk,
    moduleExists: path => existsSync(join(REPO_ROOT, path.replace(/\.test\.mjs$/u, '.mjs'))),
  })
  if (problems.length > 0) {
    console.error('[script-tests] the manifest and the tree disagree:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  const selected = selection.groups.flatMap(group => GROUPS[group])
  if (selection.list) {
    for (const group of selection.groups) {
      console.log(`[script-tests] ${group}`)
      for (const file of GROUPS[group]) console.log(`  ${file}`)
    }
    return
  }

  const jobResolution = resolveJobs(process.argv.slice(2))
  if ('error' in jobResolution) {
    console.error('[script-tests] ' + jobResolution.error)
    process.exit(2)
  }

  // Bounded pool with manifest-order flush: transcripts never interleave and
  // the first failure in declaration order is the one reported. A failure stops
  // new launches and cancels the rest once it reaches the flush.
  const results = new Array(selected.length)
  const handles = new Map()
  let next = 0
  let active = 0
  let stopped = false
  let flushPointer = 0
  let failed = null
  let resolveDone
  const done = new Promise(resolvePromise => { resolveDone = resolvePromise })
  const limit = Math.max(1, Math.min(jobResolution.jobs, Math.max(1, selected.length)))
  const flush = () => {
    if (failed !== null) return
    while (flushPointer < selected.length) {
      const outcome = results[flushPointer]
      if (outcome === undefined) return
      console.log(`[script-tests] ${selected[flushPointer]}`)
      if (outcome.stdout !== '') process.stdout.write(outcome.stdout)
      if (outcome.stderr !== '') process.stderr.write(outcome.stderr)
      if (outcome.status !== 0) {
        console.error(`[script-tests] ${selected[flushPointer]} failed (exit ${outcome.status ?? `signal ${outcome.signal}`})`)
        failed = selected[flushPointer]
        stopped = true
        for (const handle of handles.values()) handle.kill()
        return
      }
      flushPointer += 1
    }
  }
  const pump = () => {
    while (!stopped && active < limit && next < selected.length) {
      const index = next
      next += 1
      const handle = spawnCaptured(process.execPath, [selected[index]], { cwd: REPO_ROOT })
      handles.set(index, handle)
      active += 1
      handle.promise.then(result => {
        active -= 1
        handles.delete(index)
        results[index] = result
        if (result.status !== 0) stopped = true
        flush()
        pump()
      })
    }
    if (active === 0) resolveDone()
  }
  pump()
  await done
  if (failed !== null) process.exit(1)
  console.log(`[script-tests] ${selected.length} file(s) passed`)
}

const entry = process.argv[1]
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) main()
