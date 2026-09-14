/**
 * Single gate entry for local development: the repository's `test:*`,
 * `typecheck:*` and `verify:*` scripts are grouped into named modes so "which
 * checks do I run" is one command instead of a list recalled from CI YAML.
 *
 * The `tests` / `typecheck` modes are the same sets `.github/workflows/ci.yml`
 * invokes; when a package's script is added or renamed, update the mode here and
 * `pnpm run test:release-workflow` keeps the release path aligned (the policy
 * test derives the push path's gates from ci.yml and requires release
 * validation to run them).
 *
 * Usage:
 *   node scripts/dev/run-checks.mjs <static|tests|typecheck|full>
 *   node scripts/dev/run-checks.mjs <mode> --list     # print the plan, run nothing
 *   node scripts/dev/run-checks.mjs <mode> --continue # keep going after a failure
 *
 * Exit status is 1 when any step fails (or when a mode resolves to no steps: a
 * mode that runs nothing has not passed).
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package test suites, in the order the CI job runs them. */
const PACKAGE_TESTS = [
  'test:runtime',
  'test:control-plane',
  'test:desktop',
  'test:gateway',
  'test:renderer-shell',
  'test:sidebar',
  'test:layout',
  'test:git',
  'test:host-git',
  'test:host-archive-cleanup',
  'test:host-open-in',
  'test:settings-bridge',
  'test:connections',
  'test:client-web',
  'test:connection',
  'test:open-in',
  'test:mobile',
  'test:cli',
]

/** Client plugin compiler faces checked on every push. */
const CLIENT_TYPECHECKS = [
  'typecheck:sidebar',
  'typecheck:git',
  'typecheck:layout',
  'typecheck:connections',
  'typecheck:settings-bridge',
  'typecheck:client-web',
  'typecheck:connection',
  'typecheck:api-gateway',
  'typecheck:open-in',
  'typecheck:mobile',
]

/** Repository-level policy and documentation gates. */
const STATIC_CHECKS = [
  'verify:i18n',
  'verify:styles',
  'verify:workflows',
  'verify:workflow-yaml',
  'verify:test-wiring',
  'verify:md-links',
  'test:release-workflow',
  'test:upgrade-tools',
  'test:gui-acceptance',
]

/** Named gate groups. Keep the names disjoint from script names to avoid confusion. */
export const MODES = {
  static: STATIC_CHECKS,
  tests: PACKAGE_TESTS,
  typecheck: CLIENT_TYPECHECKS,
  full: [...STATIC_CHECKS, ...CLIENT_TYPECHECKS, ...PACKAGE_TESTS],
}

/**
 * Resolve the pnpm invocation used for one step.
 * @returns {{ command: string, prefix: string[] }} executable and leading args.
 */
export function pnpmInvocation() {
  const execPath = process.env.npm_execpath
  if (execPath !== undefined && execPath !== '') {
    return { command: process.execPath, prefix: [execPath] }
  }
  return { command: 'pnpm', prefix: [] }
}

/**
 * Read the mode requested on the command line.
 * @param {string[]} argv - process arguments.
 * @returns {string | undefined} mode name, or undefined when absent/unknown.
 */
export function requestedMode(argv) {
  const name = argv.find(argument => !argument.startsWith('-'))
  return name !== undefined && Object.hasOwn(MODES, name) ? name : undefined
}

/**
 * Run one mode's steps in order.
 * @param {string} mode - mode name present in {@link MODES}.
 * @param {{ list?: boolean, keepGoing?: boolean, log?: (line: string) => void }} [options] - behaviour overrides.
 * @returns {{ failed: string[], ran: number }} outcome.
 */
export function runMode(mode, options = {}) {
  const log = options.log ?? ((line) => { console.log(line) })
  const steps = MODES[mode]
  if (steps === undefined || steps.length === 0) return { failed: [`mode ${mode} has no steps`], ran: 0 }
  if (options.list === true) {
    log(`run-checks ${mode}: ${steps.length} step(s)`)
    for (const step of steps) log(`  - pnpm run ${step}`)
    return { failed: [], ran: 0 }
  }
  const { command, prefix } = pnpmInvocation()
  const failed = []
  let ran = 0
  for (const step of steps) {
    log(`\n=== pnpm run ${step} ===`)
    const result = spawnSync(command, [...prefix, 'run', step], { stdio: 'inherit' })
    ran += 1
    if (result.status !== 0) {
      failed.push(step)
      log(`run-checks: ${step} FAILED (exit ${String(result.status ?? 'signal')})`)
      if (options.keepGoing !== true) break
    }
  }
  return { failed, ran }
}

function main() {
  const mode = requestedMode(process.argv.slice(2))
  if (mode === undefined) {
    console.error(`run-checks: expected one of ${Object.keys(MODES).join(', ')}`)
    console.error('  node scripts/dev/run-checks.mjs <mode> [--list] [--continue]')
    process.exit(2)
  }
  const { failed, ran } = runMode(mode, {
    list: process.argv.includes('--list'),
    keepGoing: process.argv.includes('--continue'),
  })
  if (failed.length > 0) {
    console.error(`\nrun-checks ${mode}: ${failed.length} of ${ran} step(s) failed: ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nrun-checks ${mode}: ${ran} step(s) passed`)
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) main()
