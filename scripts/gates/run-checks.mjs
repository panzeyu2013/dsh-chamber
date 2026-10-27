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
 * A step is normally a package script name (`pnpm run <step>`). Two executed-
 * assembly gates (the compiled-sidecar smoke and the compiled Electron
 * artifacts smoke) have no root package.json alias on purpose — one is
 * a script under scripts/gates/ — so a step may also be written as an explicit
 * command line: `node <script> [args]` or `pnpm <args>`. Both forms are
 * spawned directly by this runner; nothing is interpreted by a shell.
 *
 * The tests mode schedules differently from the other modes: every package step
 * is resolved once with DSH_TEST_MANIFEST_DUMP=1 (its manifest prints its exact
 * entries and exits without running a test; a package whose declared script is
 * exactly the shared invocation resolves directly, without a pnpm startup), and
 * all entries of all packages then run on ONE bounded file pool launched
 * round-robin across steps (transcripts still flush in declaration order).
 * --jobs is therefore a global concurrency budget, not a per-package one; a
 * package step that is not manifest-based (an && chain) executes during
 * resolution and is ordered as one pre-run section. static/typecheck pool their
 * whole-gate commands the same way (capped at min(--jobs, 6), with
 * DSH_TEST_JOBS=1 so a gate that itself fans out cannot multiply the pool); only
 * the ordered leftovers
 * (artifact freshness, the darwin build→test chain) keep the serial loop,
 * because their order is a build contract.
 *
 * Usage:
 *   node scripts/gates/run-checks.mjs <static|tests|typecheck|full>
 *   node scripts/gates/run-checks.mjs <mode> --list     # print the plan, run nothing
 *   node scripts/gates/run-checks.mjs <mode> --continue # keep going after a failure
 *   node scripts/gates/run-checks.mjs <mode> --jobs 8   # one global file pool of 8
 *                                                       # for tests/full (env:
 *                                                       # DSH_TEST_JOBS, default
 *                                                       # min(8, cores))
 *
 * Artifact pre-step: the untracked build artifacts
 * (dsh-runtime / the four seed packages / the mobile dist+lib) are ensured
 * before a mode runs. tests/typecheck/full build the missing ones
 * (`pnpm run build:artifacts`); static is read-only and fails loudly with that
 * command instead — a clean checkout bootstraps itself, and no mode silently
 * skips a gate because an artifact was absent.
 *
 * full additionally sets DSH_ARTIFACT_FRESHNESS_MOBILE_REBUILD=1: the artifact
 * freshness gate then re-runs the mobile package's own build.mjs in a temp
 * copy and byte-compares lib/client.js. tests mode has NO mobile byte compare of
 * its own; CI covers it with the separate C8 step (verify-upstream-touchpoints.mjs
 * rebuilds in place), and the gate prints a NOTE instead of pretending it ran.
 *
 * Exit status is 1 when any step fails (or when a mode resolves to no steps: a
 * mode that runs nothing has not passed).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureArtifacts } from '../dev/ensure-artifacts.mjs'
import { deriveModes, loadGateRegistry, validateGateRegistry } from './gate-registry.mjs'
import {
  MANIFEST_DUMP_ENV, TIMING_ENV, parseManifestDump, resolveJobs, runEntries, spawnCaptured,
} from '../lib/test-manifest.mjs'

/**
 * Gate membership is NOT declared here. The machine source is
 * gate-surfaces.json (loader: gate-registry.mjs); this file owns execution order
 * inside a mode, the artifact pre-step and the pool scheduling.
 */
const GATE_REGISTRY = loadGateRegistry()
const REGISTRY_PROBLEMS = validateGateRegistry(GATE_REGISTRY)
if (REGISTRY_PROBLEMS.length > 0) {
  console.error('run-checks: gate-surfaces.json is invalid:', REGISTRY_PROBLEMS)
  process.exit(2)
}

/** Named gate groups derived from the registry; keep names disjoint from script names. */
export const MODES = deriveModes(GATE_REGISTRY)

/**
 * Modes whose steps consume the untracked build artifacts (scripts/dev/
 * ensure-artifacts.mjs). tests/typecheck/full self-bootstrap; static is the
 * read-only gate set — it must NEVER write the working tree, so a missing
 * artifact is a loud failure that names the build command instead of a silent skip.
 */
export const ARTIFACT_MODES = new Set(['static', 'typecheck', 'tests', 'full'])

/**
 * Repository gates (the static and per-package typecheck steps). They are whole
 * commands, independent of one another and of the package tests, so a mode
 * pools them as command entries. Their child env pins DSH_TEST_JOBS=1: a gate
 * that itself fans out (test:scripts) must not multiply the pool.
 */
const GATE_STEPS = new Set([...MODES.static, ...MODES.typecheck])

/**
 * Package-test steps: registry tier 'test', mode 'tests', declared as a bare root
 * script (the artifact-freshness node step and the darwin assembly gates stay serial).
 */
const PACKAGE_TEST_STEPS = new Set(
  GATE_REGISTRY.gates
    .filter(gate => gate.tier === 'test' && gate.modes.includes('tests')
      && !gate.command.startsWith('node ') && !gate.command.startsWith('pnpm '))
    .map(gate => gate.command),
)

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
 * Read the mode requested on the command line. `--jobs <n>` consumes its value
 * so a flag placed before the mode cannot be mistaken for the mode name.
 * @param {string[]} argv - process arguments.
 * @returns {string | undefined} mode name, or undefined when absent/unknown.
 */
export function requestedMode(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--jobs') { index += 1; continue }
    if (argument.startsWith('-')) continue
    return Object.hasOwn(MODES, argument) ? argument : undefined
  }
  return undefined
}

/**
 * Read the optional `--jobs <n>` concurrency override. It is forwarded to every
 * spawned step as `DSH_TEST_JOBS`, so the package manifests and the scripts
 * runner share one file-level budget; absent means "let each runner default".
 * @param {string[]} argv - process arguments.
 * @returns {{ jobs?: number, error?: string }}
 */
export function requestedJobs(argv) {
  let raw
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--jobs') {
      raw = argv[index + 1]
      if (raw === undefined) return { error: '--jobs needs a concurrency value' }
      index += 1
      continue
    }
    if (argument.startsWith('--jobs=')) raw = argument.slice('--jobs='.length)
  }
  if (raw === undefined) return {}
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { error: '--jobs must be a positive integer (got ' + JSON.stringify(String(raw)) + ')' }
  }
  return { jobs: parsed }
}

/** Repository root, derived from this file's location (never the caller cwd). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** The two package test scripts that ARE the shared manifest invocation. */
const MANIFEST_TEST_SCRIPTS = new Set([
  'node ./scripts/test.mjs',
  'node ../../scripts/dev/ensure-artifacts.mjs && node ./scripts/test.mjs',
])

/**
 * Map every workspace package name to its directory and test script, so the
 * tests-mode resolve step can run a manifest directly instead of paying one
 * `pnpm run` startup per package.
 * @param {string} [repoRoot] - repository root.
 * @returns {Map<string, { dir: string, test: string }>}
 */
export function packageManifestDirs(repoRoot = REPO_ROOT) {
  const map = new Map()
  const packagesRoot = resolve(repoRoot, 'packages')
  if (!existsSync(packagesRoot)) return map
  for (const name of readdirSync(packagesRoot)) {
    const manifestPath = resolve(packagesRoot, name, 'package.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (typeof manifest.name !== 'string' || typeof manifest.scripts?.test !== 'string') continue
      map.set(manifest.name, { dir: resolve(packagesRoot, name), test: manifest.scripts.test })
    } catch { /* an unreadable package contributes no direct route */ }
  }
  return map
}

/** Root package scripts (the declaration a step name resolves through). */
export function rootScripts(repoRoot = REPO_ROOT) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
    return manifest !== null && typeof manifest === 'object' && typeof manifest.scripts === 'object' ? manifest.scripts : {}
  } catch {
    return {}
  }
}

/**
 * Resolve a root test step to a direct manifest invocation when its declared
 * command is exactly the manifest invocation. The run-checks artifact pre-step
 * already ensured the artifacts the ensure-artifacts preamble would build, so
 * the preamble is redundant here; anything else falls back to its pnpm step.
 * @param {string} step - one package-test step (registry tier 'test').
 * @param {object} [facts] - injectable repository facts (tests).
 * @param {Map<string, { dir: string, test: string }>} [facts.packages] - package name -> facts.
 * @param {Record<string, string>} [facts.scripts] - root scripts.
 * @returns {{ command: string, args: string[], cwd: string } | null}
 */
export function directManifestInvocation(step, { packages = packageManifestDirs(), scripts = rootScripts() } = {}) {
  const declared = scripts[step]
  if (typeof declared !== 'string') return null
  const match = /^pnpm --filter (\S+) run test$/u.exec(declared)
  if (match === null) return null
  const entry = packages.get(match[1])
  if (entry === undefined || !MANIFEST_TEST_SCRIPTS.has(entry.test)) return null
  return { command: process.execPath, args: ['scripts/test.mjs'], cwd: entry.dir }
}

/**
 * Resolve the global file-pool budget: an explicit --jobs wins, then
 * DSH_TEST_JOBS, then the shared runner default (min(8, cores)). An invalid
 * DSH_TEST_JOBS is a configuration error and fails loudly here too: the package
 * manifests already refuse it, and silently running at the default would make
 * the pool width depend on a typo.
 * @param {number | undefined} jobs - the --jobs value.
 * @param {Record<string, string | undefined>} [env] - environment to read.
 * @returns {number}
 * @throws {Error} when DSH_TEST_JOBS is set but is not a positive integer.
 */
export function totalJobs(jobs, env = process.env) {
  if (jobs !== undefined) return jobs
  const resolved = resolveJobs([], env)
  if ('error' in resolved) throw new Error(resolved.error)
  return resolved.jobs
}

/**
 * Resolve the package steps into one global test plan.
 *
 * Every step runs ONCE with DSH_TEST_MANIFEST_DUMP=1:
 *   - a manifest step prints its resolved entries as one marker line and exits
 *     without running a test (the global pool runs them later);
 *   - a step that is not manifest-based (an && chain) executes its tests for
 *     real and is carried as one pre-run section, ordered at its step position.
 * Steps resolve on a small pool, so the per-package pnpm startup overlaps.
 * @param {string[]} steps - package steps in declaration order.
 * @param {object} [options] - resolution behaviour.
 * @param {(step: string) => Promise<object>} [options.launch] - one dump attempt; injectable for tests.
 * @param {number} [options.concurrency] - resolve-phase concurrency.
 * @param {boolean} [options.keepGoing] - keep resolving after a failure.
 * @returns {Promise<{ entries: object[], resolved: number }>} the flattened global entries.
 */
export async function resolvePackageTestPlan(steps, { launch, concurrency = 8, keepGoing = false } = {}) {
  const sections = new Array(steps.length)
  let next = 0
  let stopped = false
  const worker = async () => {
    while (!stopped && next < steps.length) {
      const index = next
      next += 1
      const step = steps[index]
      const result = await launch(step)
      const dump = parseManifestDump(result.stdout)
      if (dump === null) {
        // A declared chain step ran its tests for real: keep the captured
        // transcript and status as the section's pre-run result. A manifest
        // step that produced no dump is a hard failure: degrading it to a
        // "pre-run" pass would silently skip every file it lists.
        const missingDump = result.requireDump === true
        const sectionResult = missingDump
          ? {
              ...result,
              status: result.status === 0 ? 1 : result.status,
              stderr: String(result.stderr ?? '') + (String(result.stderr ?? '').endsWith('\n') ? '' : '\n')
                + '[plan] ' + step + ': manifest dump missing or unparseable; refusing to skip its files silently\n',
            }
          : result
        sections[index] = { step, result: sectionResult }
        if (sectionResult.status !== 0) stopped = !keepGoing
        continue
      }
      sections[index] = {
        step,
        entries: dump.entries.map(entry => ({
          ...entry,
          label: step,
          packageRoot: dump.packageRoot,
          guard: dump.guard,
          timeoutMs: dump.timeoutMs ?? undefined,
          zeroTestAllowlist: dump.zeroTestAllowlist,
          requireNoSkips: dump.requireNoSkips,
        })),
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, steps.length)) }, worker))
  const skipped = steps.filter((_step, index) => sections[index] === undefined)
  const entries = []
  for (const section of sections) {
    if (section === undefined) break
    if (section.entries !== undefined) entries.push(...section.entries)
    else {
      entries.push({
        file: section.step,
        label: section.step,
        group: 'step',
        preResult: section.result,
        rawStatus: true,
      })
    }
  }
  return { entries, resolved: sections.filter(section => section !== undefined).length, skipped }
}

/**
 * Resolve a root step to a direct `node <script> [args]` invocation when its
 * declared command is exactly that. pnpm's only contribution for these gate
 * steps is its startup plus node_modules/.bin on PATH; the direct route keeps
 * the .bin PATH (callers add it) and skips the startup. A leading node flag
 * (`node --import ...`) is refused deliberately: only the plain form is proven
 * here, everything else falls back to its declared pnpm step.
 * @param {string} step - one MODES entry.
 * @param {object} [facts] - injectable repository facts (tests).
 * @param {Record<string, string>} [facts.scripts] - root scripts.
 * @returns {{ command: string, args: string[] } | null}
 */
export function directNodeInvocation(step, { scripts = rootScripts() } = {}) {
  const declared = scripts[step]
  if (typeof declared !== 'string') return null
  const match = /^node ([^-]\S*)(?: (.*))?$/u.exec(declared)
  if (match === null) return null
  return {
    command: process.execPath,
    args: [match[1], ...(match[2] === undefined || match[2] === '' ? [] : match[2].split(/\s+/u))],
    cwd: REPO_ROOT,
  }
}

/**
 * Resolve a `tsc ...` root step to the pinned local compiler invocation
 * (node + the JS entry, no .bin shim and no pnpm startup). Falls back to null —
 * the declared pnpm step — when the compiler is not installed.
 * @param {string} step - one MODES entry.
 * @param {object} [facts] - injectable repository facts (tests).
 * @param {Record<string, string>} [facts.scripts] - root scripts.
 * @param {string} [facts.binPath] - the tsc JS entry to execute.
 * @returns {{ command: string, args: string[], cwd: string } | null}
 */
export function directTscInvocation(step, {
  scripts = rootScripts(),
  binPath = resolve(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
} = {}) {
  const declared = scripts[step]
  if (typeof declared !== 'string') return null
  const match = /^tsc(?: (.*))?$/u.exec(declared)
  if (match === null || !existsSync(binPath)) return null
  return {
    command: process.execPath,
    args: [binPath, ...(match[1] === undefined || match[1] === '' ? [] : match[1].split(/\s+/u))],
    cwd: REPO_ROOT,
  }
}

/**
 * Round-robin launch order across package steps: one entry per step per round.
 *
 * The global pool's transcript stays in declaration order, but running each
 * step's files back to back makes the last-declared step the tail (measured:
 * test:cli's 3.7s file started last and pushed the pool from its 17.7s floor to
 * 20.8s). Interleaving steps starts every step's first files early; the
 * simulated makespan drops to ~18.1s without any a-priori duration data.
 * @param {{ label?: string }[]} entries - plan entries in declaration order.
 * @returns {number[]} a permutation of 0..entries.length-1.
 */
export function roundRobinSchedule(entries) {
  const byStep = new Map()
  for (let index = 0; index < entries.length; index += 1) {
    const label = typeof entries[index].label === 'string' ? entries[index].label : String(index)
    const list = byStep.get(label)
    if (list === undefined) byStep.set(label, [index])
    else list.push(index)
  }
  const lists = [...byStep.values()]
  const schedule = []
  for (let round = 0; ; round += 1) {
    let added = false
    for (const list of lists) {
      if (round < list.length) {
        schedule.push(list[round])
        added = true
      }
    }
    if (!added) break
  }
  return schedule
}

/**
 * Resolve one mode step to an executable invocation. A step is either a
 * package script name (the default: `pnpm run <step>`) or an explicit command
 * line for a gate without a root package.json alias (`node <script> [args]` or
 * `pnpm <args>`); nothing is passed through a shell, so the tokens are split on
 * whitespace and no quoting is honoured — the entries in this file are
 * constants, not user input.
 * @param {string} step - one MODES entry.
 * @param {{ command: string, prefix: string[] }} [pnpm] - the pnpm invocation.
 * @returns {{ command: string, args: string[], display: string }} invocation.
 */
export function stepInvocation(step, pnpm = pnpmInvocation()) {
  if (step.startsWith('node ')) {
    return {
      command: process.execPath,
      args: step.slice('node '.length).trim().split(/\s+/u),
      display: step,
    }
  }
  if (step.startsWith('pnpm ')) {
    return {
      command: pnpm.command,
      args: [...pnpm.prefix, ...step.slice('pnpm '.length).trim().split(/\s+/u)],
      display: step,
    }
  }
  return { command: pnpm.command, args: [...pnpm.prefix, 'run', step], display: `pnpm run ${step}` }
}

/**
 * Run one mode's steps in three phases:
 *   1. repository gates (static/typecheck) — whole commands on a bounded pool;
 *   2. package tests — every package manifest resolved once, then all files on
 *      ONE global pool (--jobs is the total budget);
 *   3. ordered leftovers (artifact freshness, the darwin assembly chain) — the
 *      serial declaration loop, because their order is a build contract.
 * A failure stops later launches unless --continue; the per-phase order of the
 * transcript is always the declaration order.
 * @param {string} mode - mode name present in {@link MODES}.
 * @param {{ list?: boolean, keepGoing?: boolean, jobs?: number, log?: (line: string) => void, ensureArtifacts?: typeof ensureArtifacts, spawn?: typeof spawnSync, runner?: (entry: object) => { promise: Promise<object>, kill: () => void }, launchStep?: (step: string) => Promise<object>, resolveTimeoutMs?: number, writeStdout?: (text: string) => void, writeStderr?: (text: string) => void }} [options] - behaviour overrides.
 * @returns {Promise<{ failed: string[], ran: number }>} outcome.
 */
export async function runMode(mode, options = {}) {
  const log = options.log ?? ((line) => { console.log(line) })
  const steps = MODES[mode]
  if (steps === undefined || steps.length === 0) return { failed: [`mode ${mode} has no steps`], ran: 0 }
  const pnpm = pnpmInvocation()
  if (options.list === true) {
    log(`run-checks ${mode}: ${steps.length} step(s)`)
    for (const step of steps) log(`  - ${stepInvocation(step, pnpm).display}`)
    return { failed: [], ran: 0 }
  }
  // The pool width is validated before any repository work: a bogus
  // --jobs/DSH_TEST_JOBS must not run half a gate before failing.
  let jobs
  try {
    jobs = totalJobs(options.jobs)
  } catch (error) {
    log('run-checks: ' + (error instanceof Error ? error.message : String(error)))
    return { failed: ['invalid --jobs/DSH_TEST_JOBS'], ran: 0 }
  }
  // Artifact pre-step: tests/typecheck/full build what is missing, static only
  // reports. Must stay after the --list early return (listing runs nothing).
  if (ARTIFACT_MODES.has(mode)) {
    const ensure = options.ensureArtifacts ?? ensureArtifacts
    const verdict = ensure({ build: mode !== 'static', log })
    if (!verdict.ok) {
      log(`run-checks: ${mode} 需要构建期产物且缺失 ${verdict.missing.length} 个——先跑 pnpm run build:artifacts`
        + (mode === 'static' && verdict.built === false ? '（static 只读，不自动构建）' : ''))
      return { failed: [`ensure-artifacts (${verdict.missing.length} missing)`], ran: 0 }
    }
  }
  const keepGoing = options.keepGoing === true
  const failed = []
  let ran = 0
  // --jobs is the one knob every runner reads; DSH_TEST_JOBS carries it to the
  // darwin steps that still spawn their own manifest.
  const env = options.jobs === undefined ? process.env : { ...process.env, DSH_TEST_JOBS: String(options.jobs) }
  const timing = process.env[TIMING_ENV] !== undefined && process.env[TIMING_ENV] !== ''
  const writeStdout = options.writeStdout ?? ((text) => process.stdout.write(text))
  const writeStderr = options.writeStderr ?? ((text) => process.stderr.write(text))
  // pnpm injects node_modules/.bin into the child PATH; a direct step needs the
  // same so a gate that shells out to a local binary keeps working.
  const stepEnv = {
    ...env,
    PATH: resolve(REPO_ROOT, 'node_modules', '.bin') + delimiter + (env.PATH ?? ''),
    // full 档启用更重的移动包 src↔lib 重建比对（tests 档本身没有移动产物字节比对，
    // CI 由独立的 C8 step 覆盖；这里在临时副本里重跑包的 build.mjs，不写工作树）。
    // tests 档不设，门会打 NOTE——不静默当通过。
    ...(mode === 'full' ? { DSH_ARTIFACT_FRESHNESS_MOBILE_REBUILD: '1' } : {}),
  }
  const recordFailures = (pool) => {
    for (const record of pool.failures) {
      const step = record.entry.command !== undefined
        ? record.entry.file
        : (typeof record.entry.label === 'string' ? record.entry.label : record.entry.file)
      if (!failed.includes(step)) failed.push(step)
      log(`run-checks: ${record.entry.file} failed (${record.reason})`)
    }
  }

  // Phase 1 — repository gates: whole commands, pooled at a capped concurrency
  // (tsc faces are memory-heavy; the cap keeps a small CI box alive). --jobs is
  // still the hard bound, so a 4-vCPU runner keeps 4 while a big dev box may use
  // 6; buffered output flushes in declaration order.
  const gateSteps = steps.filter(step => GATE_STEPS.has(step))
  if (gateSteps.length > 0) {
    const gateEntries = gateSteps.map(step => {
      const invocation = directNodeInvocation(step) ?? directTscInvocation(step) ?? stepInvocation(step, pnpm)
      return {
        file: step,
        label: stepInvocation(step, pnpm).display,
        group: '',
        command: invocation.command,
        args: invocation.args,
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        env: { ...stepEnv, DSH_TEST_JOBS: '1' },
        rawStatus: true,
      }
    })
    const gatePool = await runEntries(gateEntries, {
      jobs: Math.min(jobs, 6),
      keepGoing,
      log,
      writeStdout,
      writeStderr,
      runner: options.runner,
    })
    ran += gateSteps.length
    recordFailures(gatePool)
  }

  // Phase 2 — package tests share ONE global file pool: the per-package pnpm
  // invocation only resolves the manifest, so a slow package cannot hold the
  // run behind its own tail and a small package is not handed a private pool.
  const packageSteps = steps.filter(step => PACKAGE_TEST_STEPS.has(step))
  if (packageSteps.length > 0 && (keepGoing || failed.length === 0)) {
    const launch = options.launchStep ?? (async (step) => {
      // A manifest package resolves in-place (no pnpm startup); a non-manifest
      // step still goes through its declared root script.
      const direct = directManifestInvocation(step)
      const invocation = direct ?? stepInvocation(step, pnpm)
      const handle = spawnCaptured(invocation.command, invocation.args, {
        ...(direct === null ? {} : { cwd: direct.cwd }),
        env: { ...env, [MANIFEST_DUMP_ENV]: '1' },
        timeoutMs: options.resolveTimeoutMs ?? 300_000,
      })
      const result = await handle.promise
      // A direct manifest invocation MUST dump; a chain step is allowed to have
      // run for real instead. The flag lets the resolver tell the two apart.
      return direct === null ? result : { ...result, requireDump: true }
    })
    const resolveStartedAt = Date.now()
    const plan = await resolvePackageTestPlan(packageSteps, {
      launch,
      concurrency: Math.min(jobs, 8),
      keepGoing,
    })
    if (timing) {
      process.stderr.write('[timing] resolveMs=' + String(Date.now() - resolveStartedAt)
        + ' steps=' + String(plan.resolved) + ' items=' + String(plan.entries.length) + '\n')
    }
    ran += plan.resolved
    log(`[plan] ${plan.resolved} package step(s) resolved, ${plan.entries.length} item(s) scheduled on ${jobs} job(s)`)
    if (plan.skipped.length > 0) {
      log(`[plan] skipped after a resolve failure: ${plan.skipped.join(', ')}`)
    }
    const pool = await runEntries(plan.entries, {
      jobs,
      keepGoing,
      log,
      writeStdout,
      writeStderr,
      runner: options.runner,
      // Launch interleaved across steps so the last-declared step is not the
      // tail; the transcript still flushes in declaration order.
      schedule: roundRobinSchedule(plan.entries),
    })
    recordFailures(pool)
  }

  // Phase 3 — ordered leftovers (artifact freshness, the darwin build→test
  // chain) keep the serial loop: their order is a contract, not a preference.
  const serialSteps = steps.filter(step => !GATE_STEPS.has(step) && !PACKAGE_TEST_STEPS.has(step))
  for (const step of serialSteps) {
    if (failed.length > 0 && !keepGoing) break
    const invocation = directNodeInvocation(step) ?? directTscInvocation(step) ?? stepInvocation(step, pnpm)
    log(`\n=== ${stepInvocation(step, pnpm).display} ===`)
    const spawn = options.spawn ?? spawnSync
    const result = spawn(invocation.command, invocation.args, {
      stdio: 'inherit',
      env: stepEnv,
      cwd: invocation.cwd ?? REPO_ROOT,
    })
    ran += 1
    if (result.status !== 0) {
      failed.push(step)
      log(`run-checks: ${step} FAILED (exit ${String(result.status ?? 'signal')})`)
      if (!keepGoing) break
    }
  }
  return { failed, ran }
}

async function main() {
  const argv = process.argv.slice(2)
  const mode = requestedMode(argv)
  const jobs = requestedJobs(argv)
  if (mode === undefined || jobs.error !== undefined) {
    if (jobs.error !== undefined) console.error('run-checks: ' + jobs.error)
    else console.error(`run-checks: expected one of ${Object.keys(MODES).join(', ')}`)
    console.error('  node scripts/gates/run-checks.mjs <mode> [--list] [--continue] [--jobs N]')
    console.error('  DSH_TEST_JOBS=N is equivalent to --jobs N for the tests-mode global pool')
    process.exit(2)
  }
  const { failed, ran } = await runMode(mode, {
    list: process.argv.includes('--list'),
    keepGoing: process.argv.includes('--continue'),
    ...(jobs.jobs === undefined ? {} : { jobs: jobs.jobs }),
  })
  if (failed.length > 0) {
    console.error(`\nrun-checks ${mode}: ${failed.length} of ${ran} step(s) failed: ${failed.join(', ')}`)
    process.exit(1)
  }
  console.log(`\nrun-checks ${mode}: ${ran} step(s) passed`)
}

/** 入口判定：realpath 双侧比较（符号链接绝对路径调用时不静默 no-op）。 */
const isEntry = (() => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isEntry) {
  main().catch((error) => {
    console.error('run-checks: ' + String(error?.stack ?? error))
    process.exit(1)
  })
}
