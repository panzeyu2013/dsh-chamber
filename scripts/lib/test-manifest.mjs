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
 *     that silently runs nothing is not a pass);
 *   - an empty manifest (or an empty group) is a manifest defect, refused
 *     before anything spawns.
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
 */
export function runTestManifest({ label, packageRoot, groups }) {
  const problems = emptyManifestProblems(groups)
  if (problems.length > 0) {
    console.error(`[test] ${label}: refusing a zero-case manifest:`)
    for (const problem of problems) console.error('  - ' + problem)
    process.exit(1)
  }

  const entries = collectEntries(groups)
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
    })
    if (typeof result.stdout === 'string' && result.stdout !== '') process.stdout.write(result.stdout)
    if (typeof result.stderr === 'string' && result.stderr !== '') process.stderr.write(result.stderr)
    if (result.status !== 0) {
      console.error('[test] ' + entry.file + ' failed (exit ' + (result.status ?? ('signal ' + result.signal)) + ')')
      process.exit(1)
    }
    if (parseExecutedTestCount((result.stdout ?? '') + '\n' + (result.stderr ?? '')) === null) {
      console.error('[test] ' + entry.file + ' ran no test body（零测试文件不得视为通过）')
      process.exit(1)
    }
  }
}
