/**
 * test-manifest.mjs — the shared runner for package test manifests.
 *
 * Every chamber package's `scripts/test.mjs` declares an authoritative,
 * grouped file list; the runner's job is identical everywhere:
 *   - a listed file that does not exist is a failure, never a silent skip;
 *   - every file runs as its own node child, in manifest order, with the
 *     transcript streamed through;
 *   - the first failure (non-zero exit or signal) ends the run;
 *   - a child that exits 0 WITHOUT executing a single node:test body fails
 *     (the "zero-test" guard desktop/renderer/sidebar already had: a manifest
 *     that silently runs nothing is not a pass — including the all-skipped case
 *     the old count-only guard let through);
 *   - an empty manifest (or an empty group) is a manifest defect, refused
 *     before anything spawns;
 *   - a package with platform legs (win32/macos subsets) selects one leg with
 *     --win32 / --macos; a zero-test allowlist may name an explicit exception;
 *     the macOS leg additionally refuses skipped tests (requireNoSkips).
 *
 * Output is captured through pipes rather than inherited stdio so the
 * node:test summary can be parsed; the transcript is still written through in
 * order (stdio: ['inherit', 'pipe', 'pipe']). The parsed count covers both the
 * spec summary (`ℹ tests N`) and the TAP summary (`# tests N`).
 */

import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

/** node:test summary lines: spec (`ℹ tests N`) and TAP (`# tests N`). */
const SUMMARY_LINE = /^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)\s*$/gm

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
 * @param result - spawnSync result (status/signal/error/stdout/stderr).
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
 * @param args.argv - the arguments to read leg flags from.
 */
export function runTestManifest({
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
  argv = process.argv,
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

  for (const [index, entry] of entries.entries()) {
    if (index === 0 || entries[index - 1].group !== entry.group) console.log('\n=== ' + entry.group + ' ===')
    const result = spawnSync(process.execPath, [...entry.nodeArgs, entry.file], {
      cwd: packageRoot,
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    })
    if (typeof result.stdout === 'string' && result.stdout !== '') process.stdout.write(result.stdout)
    if (typeof result.stderr === 'string' && result.stderr !== '') process.stderr.write(result.stderr)
    const verdict = evaluateChildRun(entry.file, result, zeroTestAllowlist, { requireNoSkips: noSkips, guard })
    if (!verdict.ok) {
      console.error('[test] ' + entry.file + ' failed (' + verdict.reason + ')')
      process.exit(1)
    }
  }
}
