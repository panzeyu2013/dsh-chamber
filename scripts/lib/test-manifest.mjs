/**
 * test-manifest.mjs — the shared runner for package test manifests.
 *
 * Every chamber package's `scripts/test.mjs` declares an authoritative,
 * grouped file list; the runner's job is identical everywhere:
 *   - a listed file that does not exist is a failure, never a silent skip;
 *   - every file runs as its own node child, with the transcript streamed
 *     through in manifest order (per-file output is buffered and flushed in
 *     declaration order, so a bounded pool never interleaves transcripts);
 *   - at most `jobs` children run at once (file-level parallelism, default
 *     min(4, cores)); `--jobs <n>` / `DSH_TEST_JOBS=<n>` / `--jobs=<n>`
 *     select it — the command line wins over the environment;
 *   - the first failure (non-zero exit, signal, spawn error or timeout) ends
 *     the run: no new child starts after a failure is recorded, and the
 *     in-flight rest is cancelled once the failure reaches the ordered flush;
 *   - a child that exits 0 WITHOUT executing a single node:test body fails
 *     (the "zero-test" guard: a manifest
 *     that silently runs nothing is not a pass — including the all-skipped case
 *     a count-only guard would let through);
 *   - an empty manifest (or an empty group) is a manifest defect, refused
 *     before anything spawns;
 *   - a package with platform legs (win32/macos subsets) selects one leg with
 *     --win32 / --macos; a zero-test allowlist may name an explicit exception;
 *     the macOS leg additionally refuses skipped tests (requireNoSkips).
 *
 * Output is captured through pipes rather than inherited stdio so the
 * node:test summary can be parsed; the transcript is still written through in
 * order. The parsed count covers both the spec summary (`ℹ tests N`) and the
 * TAP summary (`# tests N`).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'

/** node:test summary lines: spec (`ℹ tests N`) and TAP (`# tests N`). */
const SUMMARY_LINE = /^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)\s*$/gm

/** Per-child output ceiling (bytes), matching the old spawnSync maxBuffer. */
export const MAX_CHILD_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * Post-exit drain bound: after the child process is gone, at most one pipe
 * buffer (<=64 KiB) can still arrive, so this grace is enough to capture it
 * while releasing a pool slot held open by a leaked stdout-inheriting
 * descendant. Without it that slot waits for the entry's own timeout (or
 * forever when none is declared).
 */
export const DEFAULT_DRAIN_GRACE_MS = 2_000

/**
 * Default file-level concurrency when neither --jobs nor DSH_TEST_JOBS is set:
 * min(DEFAULT_TEST_JOBS, availableParallelism()). The cap is only a ceiling — a
 * 4-vCPU CI still resolves to 4, while a many-core developer box is not held at
 * a quarter of its capacity (the pool is one process per file, not nested).
 */
export const DEFAULT_TEST_JOBS = 8

/**
 * Environment switch: print the RESOLVED manifest (label, packageRoot, guard,
 * per-file options and entries) as one marker line and exit without running a
 * test. The run-checks tests mode consumes it to build one global file pool
 * across every package, so the per-package pnpm invocation only resolves the
 * manifest and never owns a private pool.
 */
export const MANIFEST_DUMP_ENV = 'DSH_TEST_MANIFEST_DUMP'

/** Prefix of the one-line dump; unique enough that transcripts never match. */
export const MANIFEST_DUMP_PREFIX = '__DSH_TEST_MANIFEST_DUMP__'

/**
 * Opt-in diagnostics switch: when set, one `[timing] {...}` JSON line lands on
 * stderr after the pool drains (per-entry wall clock + the run total). It is the
 * measurement seam for bottleneck analysis; it never changes scheduling.
 */
export const TIMING_ENV = 'DSH_TEST_TIMING'

/**
 * Resolve the file-level concurrency for one manifest run.
 *
 * Precedence: `--jobs <n>` / `--jobs=<n>` > `DSH_TEST_JOBS` > the default
 * (min(8, availableParallelism())). An explicit value is not clamped — a small
 * CI box asks for 1 by setting the environment variable, not by degrading the
 * default silently.
 * @param {string[]} argv - process arguments (the manifest also reads --win32/--macos here).
 * @param {Record<string, string | undefined>} env - environment to read DSH_TEST_JOBS from.
 * @returns {{ jobs: number } | { error: string }}
 */
export function resolveJobs(argv = [], env = process.env) {
  let raw
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--jobs') {
      raw = argv[index + 1]
      index += 1
      continue
    }
    if (argument.startsWith('--jobs=')) raw = argument.slice('--jobs='.length)
  }
  if (raw === undefined || raw === '') raw = env.DSH_TEST_JOBS
  if (raw === undefined || raw === '') {
    return { jobs: Math.max(1, Math.min(DEFAULT_TEST_JOBS, availableParallelism())) }
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { error: '--jobs/DSH_TEST_JOBS must be a positive integer (got ' + JSON.stringify(String(raw)) + ')' }
  }
  return { jobs: parsed }
}

/**
 * Parse the LAST manifest dump line out of a child's stdout.
 * Returns null when the child never dumped (a non-manifest step) or the line
 * is malformed: the caller must then treat the child as a pre-run section
 * rather than silently drop it.
 * @param {string} stdout - captured child stdout.
 * @returns {object | null} parsed payload, or null.
 */
export function parseManifestDump(stdout) {
  let payload = null
  for (const line of String(stdout ?? '').split('\n')) {
    if (!line.startsWith(MANIFEST_DUMP_PREFIX)) continue
    try { payload = JSON.parse(line.slice(MANIFEST_DUMP_PREFIX.length)) } catch { payload = null }
  }
  if (payload === null || !Array.isArray(payload.entries) || typeof payload.packageRoot !== 'string') return null
  return payload
}

/**
 * Spawn one child with piped, buffered stdio and a killable handle.
 *
 * The resolved value is shaped like a spawnSync result so evaluateChildRun
 * accepts it unchanged (status/signal/error/stdout/stderr); a timeout resolves
 * with an ETIMEDOUT error and an over-budget child with ENOBUFS, exactly the
 * spawnSync contract the zero-test verdict reasons were written against.
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {object} [options] - cwd/env/timeoutMs/maxBufferBytes/drainGraceMs.
 * @returns {{ promise: Promise<object>, kill: () => void }}
 */
export function spawnCaptured(command, args, { cwd, env, timeoutMs, maxBufferBytes = MAX_CHILD_OUTPUT_BYTES, drainGraceMs = DEFAULT_DRAIN_GRACE_MS } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] })
  let resolveResult
  const promise = new Promise((resolvePromise) => { resolveResult = resolvePromise })
  let stdout = ''
  let stderr = ''
  let capturedBytes = 0
  let settled = false
  let timedOut = false
  let overflowed = false
  let exitCode = null
  let exitSignal = null
  let timer
  let drainGrace
  let hardKill
  const finish = (error) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    if (drainGrace !== undefined) clearTimeout(drainGrace)
    if (hardKill !== undefined) clearTimeout(hardKill)
    // Release the pipe handles. A drained-but-never-closed stdout (a leaked
    // descendant still holding the write end) keeps a libuv fd poll alive, so
    // this process would outlive the resolved promise — a runner-visible hang
    // even though the capture itself already returned.
    child.stdout?.destroy()
    child.stderr?.destroy()
    resolveResult({ status: exitCode, signal: exitSignal, error: error ?? null, stdout, stderr })
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const append = (chunk, which) => {
    if (overflowed) return
    capturedBytes += Buffer.byteLength(chunk)
    if (which === 'out') stdout += chunk
    else stderr += chunk
    if (capturedBytes > maxBufferBytes) {
      overflowed = true
      child.kill('SIGKILL')
    }
  }
  child.stdout.on('data', (chunk) => append(chunk, 'out'))
  child.stderr.on('data', (chunk) => append(chunk, 'err'))
  child.on('error', (error) => finish(error))
  const settleAfterStop = (drainExpired = false) => {
    if (drainExpired) {
      // Loud, never silent: the process is gone but its stdio stayed open (a
      // leaked descendant still holds the pipe). The slot is released with what
      // was captured, and the transcript says so, so a truncated tail is visible
      // evidence rather than a mystery.
      stderr += (stderr === '' || stderr.endsWith('\n') ? '' : '\n')
        + '[runner] stdio stayed open ' + String(drainGraceMs) + 'ms after exit; released with a leaked descendant still holding it\n'
    }
    if (timedOut) finish(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }))
    else if (overflowed) finish(Object.assign(new Error('maxBuffer exceeded'), { code: 'ENOBUFS' }))
    else finish(null)
  }
  // Resolve on 'close', never on 'exit': with piped stdio the process can exit
  // before its stdout 'data' events are delivered, and a large final write (the
  // manifest dump is one multi-KiB line) was intermittently captured as empty —
  // which silently degraded the whole package into an empty pre-run section.
  // 'close' fires only after both pipes reached EOF, which is the spawnSync
  // contract evaluateChildRun was written against.
  child.on('close', (code, signal) => {
    exitCode = code
    exitSignal = signal
    settleAfterStop()
  })
  // Bounded escape for a leaked descendant that inherited stdout: the process
  // is gone, but 'close' would not fire until the survivor exits. After exit at
  // most one pipe buffer can still arrive, so a short grace drains it and then
  // releases the pool slot instead of letting an unrelated process own it.
  child.on('exit', (code, signal) => {
    exitCode = code
    exitSignal = signal
    if (drainGraceMs > 0) drainGrace = setTimeout(() => settleAfterStop(true), drainGraceMs)
  })
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      hardKill = setTimeout(() => child.kill('SIGKILL'), 5_000)
      hardKill.unref?.()
    }, timeoutMs)
  }
  return {
    promise,
    kill() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      hardKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
      hardKill.unref?.()
    },
  }
}

/**
 * Executed test bodies (pass + fail) of the LAST node:test summary block.
 * Returns null when no test body executed (no summary line / tests 0 / only
 * skipped): a zero-body run must never be mistaken for a green one.
 * @param output - child stdout + stderr.
 * @returns executed test count, or null.
 */
export function parseExecutedTestCount(output) {
  let block = null
  for (const match of output.matchAll(SUMMARY_LINE)) {
    const key = match[1]
    if (block === null || key === 'tests') block = { tests: 0, pass: 0, fail: 0, skipped: 0 }
    block[key] = Number(match[2])
  }
  if (block === null || block.tests === 0) return null
  const executed = (block.pass ?? 0) + (block.fail ?? 0)
  return executed > 0 ? executed : null
}

/**
 * The LAST node:test summary block in `output` (a file that never entered the
 * runner prints none). `tests` counts REGISTERED tests including skipped/todo
 * ones, so a positive `tests` alone does NOT prove a test body executed.
 * @param output - child stdout + stderr.
 * @returns {{ tests: number | null, pass: number | null, fail: number | null, skipped: number | null }}
 */
export function parseReportedTotals(output) {
  const empty = { tests: null, pass: null, fail: null, skipped: null }
  let block = null
  for (const match of String(output).matchAll(SUMMARY_LINE)) {
    const key = match[1]
    if (block === null || key === 'tests') block = { ...empty }
    block[key] = Number(match[2])
  }
  return block ?? empty
}

/**
 * Decide one listed child's outcome: spawn failure, non-zero exit, or a run
 * that executed no test body (no summary / tests 0 / pass 0 and fail 0 — all
 * skipped included). `allowlist` is injectable so a package can name an
 * explicit exception; `requireNoSkips` is the macOS-leg discipline (a skipped
 * packaging prerequisite must fail the run instead of shrinking coverage).
 * @param file - package-relative listed path.
 * @param result - spawn result (status/signal/error/stdout/stderr).
 * @param allowlist - zero-test exceptions, each { file, reason }.
 * @param options.requireNoSkips - refuse a partial skip set.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluateChildRun(file, result, allowlist = [], { requireNoSkips = false, guard = 'executed' } = {}) {
  if (result.error !== undefined && result.error !== null) {
    return { ok: false, reason: '无法启动：' + String(result.error.message ?? result.error) }
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'exit ' + (result.status ?? ('signal ' + (result.signal ?? 'unknown'))) }
  }
  if (allowlist.some(entry => entry.file === file)) return { ok: true }
  const totals = parseReportedTotals(String(result.stdout ?? '') + '\n' + String(result.stderr ?? ''))
  if (totals.tests === null) return { ok: false, reason: '未运行任何测试（无 node:test 汇总行；零测试文件不得视为通过）' }
  if (totals.tests === 0) return { ok: false, reason: 'node:test 汇总 tests 0（零测试文件不得视为通过）' }
  if (requireNoSkips && (totals.skipped ?? 0) > 0) {
    return { ok: false, reason: 'macOS 腿不得有跳过用例（skipped ' + String(totals.skipped) + '）——缺前置必须红，不得静默降覆盖' }
  }
  // guard 'registered': the manifest only needs the child to have ENTERED
  // node:test with at least one registered test. This is the documented
  // dsh-runtime / control-plane semantics: a fully platform-skipped listed file
  // (e.g. a win32-only integration test on a POSIX leg) is legitimate.
  if (guard === 'registered') return { ok: true }
  if ((totals.pass ?? 0) === 0 && (totals.fail ?? 0) === 0) {
    return { ok: false, reason: '所有测试被跳过/待办（pass 0 / fail 0）——未执行任何测试体' }
  }
  return { ok: true }
}

/**
 * Select the manifest groups one invocation should run: a package with
 * platform legs passes `platformFiles` and the matching flag; a package
 * without that leg keeps its full manifest even when the flag is present.
 * @param args.groups - the full grouped manifest.
 * @param args.platformFiles - optional { win32?, macos? } file lists.
 * @param args.argv - the process arguments to read the leg flags from.
 * @returns the groups to run, the selected leg (when one was), or an error.
 */
export function selectManifest({ groups, platformFiles = {}, argv = [], allowPlatformFilesOutsideGroups = false }) {
  const win32 = argv.includes('--win32')
  const macos = argv.includes('--macos')
  if (win32 && macos) return { error: '--win32 and --macos are mutually exclusive' }
  const leg = win32 ? 'win32' : macos ? 'macos' : undefined
  if (leg === undefined || platformFiles[leg] === undefined) return { groups, leg: undefined }
  // A leg selects a SUBSET of the manifest: every file is looked up in GROUPS so
  // its nodeArgs carry over, and a leg naming a file the manifest does not list
  // is refused instead of quietly running a file no group owns.
  const all = collectEntries(groups)
  const entries = []
  for (const item of platformFiles[leg]) {
    const file = typeof item === 'string' ? item : item.file
    const entry = all.find(candidate => candidate.file === file)
    if (entry === undefined) {
      if (!allowPlatformFilesOutsideGroups) return { error: '--' + leg + ' lists a file outside GROUPS: ' + file }
      entries.push({
        ...(typeof item === 'string' ? {} : item), group: leg, file, nodeArgs: typeof item === 'string' ? [] : (item.nodeArgs ?? []),
      })
      continue
    }
    entries.push({ ...entry, group: leg })
  }
  return { groups: { [leg]: entries }, leg }
}

/**
 * Flatten a grouped manifest into ordered run entries.
 * @param groups - group name -> entries (a path, or { file, nodeArgs }).
 * @returns normalized { group, file, nodeArgs } entries in declaration order.
 */
export function collectEntries(groups) {
  return Object.entries(groups).flatMap(([group, list]) =>
    list.map(entry => (typeof entry === 'string' ? { group, file: entry, nodeArgs: [] } : { group, nodeArgs: [], ...entry })),
  )
}

/**
 * Zero-test guard for the manifest itself: a manifest that lists nothing — or
 * whose group declares an empty list — must fail loudly instead of running
 * zero children and exiting 0.
 * @param groups - group name -> entries.
 * @returns one problem string per defect; empty when the manifest is whole.
 */
export function emptyManifestProblems(groups) {
  const problems = []
  for (const [group, list] of Object.entries(groups)) {
    if (list.length === 0) problems.push(`group '${group}' lists zero test files`)
  }
  if (Object.keys(groups).length === 0) problems.push('the manifest declares no groups at all')
  return problems
}

/**
 * Run the collected entries on a bounded process pool and stream their
 * transcripts through in manifest order.
 *
 * Semantics (unchanged from the serial runner, now with `jobs` in flight):
 * a verdict failure stops new launches immediately; the ordered flush writes
 * every earlier entry, prints the failing one, then cancels what is still
 * running so a long sibling cannot hold the run open. Output order is manifest
 * order regardless of completion order, and the returned failure is the first
 * failing entry in manifest order.
 * @param entries - collectEntries() output.
 * @param args.packageRoot - child cwd + listed-file base.
 * @param args.jobs - max concurrent children (>= 1).
 * @param args.timeoutMs - optional per-child timeout.
 * @param args.zeroTestAllowlist - explicit zero-test exceptions.
 * @param args.requireNoSkips - refuse skipped tests (macOS leg).
 * @param args.guard - 'executed' (default) or 'registered'.
 * @param args.keepGoing - collect every failure instead of stopping at the first.
 * @param args.env - child environment override (command entries may carry their own).
 * @param args.runner - spawn implementation override for one entry (tests).
 * @param args.schedule - optional launch-order permutation of entry indices; the
 *   transcript still flushes in declaration (entry-array) order.
 * @param args.log - group-header sink.
 * @param args.writeStdout - transcript sink.
 * @param args.writeStderr - transcript sink.
 *
 * An entry may override any of the options above (`packageRoot`, `guard`,
 * `zeroTestAllowlist`, `requireNoSkips`, `timeoutMs`) and may carry a
 * `label` (the global scheduling section). A `command` entry spawns an
 * executable invocation (the static/typecheck gates) instead of node+file. A
 * `preResult` entry is not spawned:
 * its captured result is ordered and flushed like any other (`rawStatus: true`
 * judges it by exit status alone — an && chain has no single node:test summary).
 * @returns {{ failed: { entry: object, reason: string } | null, failures: { entry: object, reason: string }[] }}
 */
export async function runEntries(entries, {
  packageRoot,
  jobs = 1,
  timeoutMs,
  zeroTestAllowlist = [],
  requireNoSkips = false,
  guard = 'executed',
  keepGoing = false,
  env,
  runner,
  schedule,
  log = (line) => console.log(line),
  writeStdout = (text) => process.stdout.write(text),
  writeStderr = (text) => process.stderr.write(text),
} = {}) {
  const results = new Array(entries.length)
  const handles = new Map()
  const failures = []
  const timings = new Array(entries.length)
  const runStartedAt = Date.now()
  let next = 0
  let active = 0
  let stopped = false
  let flushPointer = 0
  let failed = null
  let resolveDone
  const done = new Promise((resolvePromise) => { resolveDone = resolvePromise })
  const limit = Math.max(1, Math.min(jobs, Math.max(1, entries.length)))
  // A global scheduling label (the package step / gate display) plus the
  // manifest group when the entry belongs to one.
  const sectionOf = (entry) => {
    const group = entry.group === undefined || entry.group === '' ? undefined : String(entry.group)
    if (entry.label === undefined) return group ?? '<unnamed>'
    return group === undefined ? String(entry.label) : entry.label + ' / ' + group
  }

  const killRest = () => {
    for (const handle of handles.values()) handle.kill()
  }
  const flush = () => {
    if (!keepGoing && failed !== null) return
    while (flushPointer < entries.length) {
      const outcome = results[flushPointer]
      if (outcome === undefined) return
      const entry = entries[flushPointer]
      const previous = flushPointer === 0 ? undefined : entries[flushPointer - 1]
      if (previous === undefined || sectionOf(previous) !== sectionOf(entry)) log('\n=== ' + sectionOf(entry) + ' ===')
      if (outcome.result.stdout !== '') writeStdout(outcome.result.stdout)
      if (outcome.result.stderr !== '') writeStderr(outcome.result.stderr)
      if (!outcome.verdict.ok) {
        const record = { entry, reason: outcome.verdict.reason }
        failures.push(record)
        if (failed === null) failed = record
        if (!keepGoing) {
          stopped = true
          killRest()
          return
        }
      }
      flushPointer += 1
    }
  }
  const pump = () => {
    while (!stopped && active < limit && next < entries.length) {
      // Launch order may differ from transcript order (schedule is a
      // permutation): a long file declared last then starts early instead of
      // becoming the tail. Output still flushes in declaration order.
      const index = schedule === undefined ? next : schedule[next]
      next += 1
      const entry = entries[index]
      // A pre-run section (a package step that is not manifest-based, or a
      // failed dump) carries its captured result: it is ordered with the rest
      // but never spawned again. rawStatus entries pass on exit 0 alone.
      const handle = entry.preResult !== undefined
        ? { promise: Promise.resolve(entry.preResult), kill() {} }
        : runner !== undefined
          ? runner(entry)
          : entry.command !== undefined
            ? spawnCaptured(entry.command, entry.args ?? [], {
              cwd: entry.cwd ?? entry.packageRoot ?? packageRoot,
              env: entry.env ?? env,
              timeoutMs: entry.timeoutMs ?? timeoutMs,
            })
            : spawnCaptured(process.execPath, [...entry.nodeArgs, entry.file], {
              cwd: entry.packageRoot ?? packageRoot,
              env: entry.env ?? env,
              timeoutMs: entry.timeoutMs ?? timeoutMs,
            })
      handles.set(index, handle)
      active += 1
      const startedAt = Date.now()
      handle.promise.then((result) => {
        active -= 1
        handles.delete(index)
        // A pre-run section was captured during resolve, not spawned here:
        // recording 0ms would misreport it as pool work in the timing JSON.
        timings[index] = entry.preResult !== undefined ? null : Date.now() - startedAt
        const verdict = entry.rawStatus === true
          ? (result.status === 0
            ? { ok: true }
            : { ok: false, reason: 'exit ' + String(result.status ?? ('signal ' + String(result.signal))) })
          : evaluateChildRun(entry.file, result, entry.zeroTestAllowlist ?? zeroTestAllowlist, {
            requireNoSkips: entry.requireNoSkips ?? requireNoSkips,
            guard: entry.guard ?? guard,
          })
        results[index] = { entry, result, verdict }
        if (!verdict.ok && !keepGoing) stopped = true
        flush()
        pump()
      })
    }
    if (active === 0) resolveDone()
  }
  pump()
  await done
  if (process.env[TIMING_ENV] !== undefined && process.env[TIMING_ENV] !== '') {
    process.stderr.write('[timing] ' + JSON.stringify({
      jobs: limit,
      totalMs: Date.now() - runStartedAt,
      entries: entries.map((entry, index) => ({
        label: entry.label ?? entry.group ?? '',
        file: entry.file,
        ms: timings[index] ?? null,
        ok: results[index] === undefined ? null : results[index].verdict.ok,
        ...(entry.preResult === undefined ? {} : { section: true }),
      })),
    }) + '\n')
  }
  return { failed, failures }
}

/**
 * Run one package's grouped test manifest.
 * @param args - the package manifest.
 * @param args.label - package name used in diagnostics.
 * @param args.packageRoot - absolute package root (child cwd + listed-file base).
 * @param args.groups - group name -> entries (a path, or { file, nodeArgs }).
 * @param args.platformFiles - optional { win32?, macos? } leg lists.
 * @param args.zeroTestAllowlist - explicit zero-test exceptions.
 * @param args.requireNoSkips - refuse skipped tests (macOS leg).
 * @param args.requireNoSkipsLegs - legs that must not skip (e.g. ['macos']).
 * @param args.guard - 'executed' (default: pass+fail > 0) or 'registered'.
 * @param args.timeoutMs - per-file spawn timeout; omitted means no bound.
 * @param args.allowPlatformFilesOutsideGroups - a leg may be a standalone set
 *   (default false: a leg naming an unlisted file is refused).
 * @param args.jobs - explicit concurrency override (tests); the CLI/env
 *   resolution runs when it is omitted.
 * @param args.argv - the arguments to read leg flags and --jobs from.
 * @param args.env - environment for the DSH_TEST_JOBS fallback.
 */
export async function runTestManifest({
  label,
  packageRoot,
  groups,
  platformFiles = {},
  zeroTestAllowlist = [],
  requireNoSkips = false,
  requireNoSkipsLegs = [],
  guard = 'executed',
  timeoutMs,
  allowPlatformFilesOutsideGroups = false,
  jobs,
  argv = process.argv,
  env = process.env,
}) {
  const selected = selectManifest({ groups, platformFiles, argv, allowPlatformFilesOutsideGroups })
  if (selected.error !== undefined) {
    console.error('[test] ' + label + ': ' + selected.error)
    process.exit(1)
  }
  const { groups: runGroups, leg } = selected
  const noSkips = requireNoSkips || (leg !== undefined && requireNoSkipsLegs.includes(leg))
  const problems = emptyManifestProblems(runGroups)
  if (problems.length > 0) {
    console.error(`[test] ${label}: refusing a zero-case manifest:`)
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }

  const entries = collectEntries(runGroups)
  const missing = entries.filter(entry => !existsSync(join(packageRoot, entry.file)))
  if (missing.length > 0) {
    console.error('[test] listed test file(s) missing:')
    for (const entry of missing) console.error('  - ' + entry.file)
    process.exit(1)
  }

  // The global-plan dump: the manifest is resolved and shipped to the caller
  // exactly as this process would run it (entries, guard, per-file timeout and
  // allowlist), then the process exits without executing a test. run-checks
  // consumes this to schedule all packages on one bounded pool.
  if (env[MANIFEST_DUMP_ENV] === '1') {
    process.stdout.write('\n' + MANIFEST_DUMP_PREFIX + JSON.stringify({
      label,
      packageRoot,
      leg: leg ?? null,
      guard,
      timeoutMs: timeoutMs ?? null,
      requireNoSkips: noSkips,
      zeroTestAllowlist,
      entries,
    }) + '\n')
    return
  }

  let resolvedJobs
  if (resolvedJobs === undefined) {
    const resolution = resolveJobs(argv, env)
    if ('error' in resolution) {
      console.error('[test] ' + label + ': ' + resolution.error)
      process.exit(1)
    }
    resolvedJobs = resolution.jobs
  }

  const { failed } = await runEntries(entries, { packageRoot, jobs: resolvedJobs, timeoutMs, zeroTestAllowlist, requireNoSkips: noSkips, guard })
  if (failed !== null) {
    console.error('[test] ' + failed.entry.file + ' failed (' + failed.reason + ')')
    process.exit(1)
  }
}
