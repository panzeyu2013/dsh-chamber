#!/usr/bin/env node
/**
 * God-file budget gate (G-B) — the per-file line budgets from the refactor
 * objective are a RATCHET: a budgeted file may shrink, never grow, and the
 * ratified number must be lowered in the same change that shrinks it (the same
 * "只降不升" discipline as the upstream legacy 文件:行 budget).
 *
 * WHY. These files carry the structural debt the refactor exists to remove; a
 * line budget that is only a document rots on the first "small" addition. The
 * gate makes the debt current, visible, and monotonically decreasing, while the
 * target column keeps the destination honest.
 *
 * The ratified table is validated before it is trusted: a malformed entry (a
 * missing/non-integer `lines`) must fail loud, because the comparisons below
 * would otherwise read as "no violation" and silently pass.
 *
 * USAGE.
 *   node scripts/gates/verify-file-budgets.mjs                 # gate
 *   node scripts/gates/verify-file-budgets.mjs --report        # table only
 *   node scripts/gates/verify-file-budgets.mjs --update-budget # lower the ratchet
 *   node scripts/gates/verify-file-budgets.mjs --update-budget --force
 *   node scripts/gates/verify-file-budgets.mjs --self-test     # built-in negative control
 *
 * File-only, read-only (except --update-budget), no artifacts.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BUDGET_PATH = join(HERE, 'file-budgets.json')

const KNOWN_ARGS = new Set(['--report', '--update-budget', '--force', '--self-test'])

/** Parse the CLI; an unknown argument is a usage error, never silently ignored. */
export function parseArgs(argv) {
  const unknown = argv.filter((arg) => !KNOWN_ARGS.has(arg))
  if (unknown.length > 0) throw new Error('unknown argument(s): ' + unknown.join(', '))
  return {
    report: argv.includes('--report'),
    update: argv.includes('--update-budget'),
    force: argv.includes('--force'),
    selfTest: argv.includes('--self-test'),
  }
}

/** Schema guard for the ratified table; returns human-readable errors. */
export function validateBudget(budget) {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) return ['budget must be an object']
  if (!Array.isArray(budget.files)) return ['budget.files must be an array']
  const errors = []
  const seen = new Set()
  budget.files.forEach((entry, index) => {
    const at = `files[${index}]`
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} must be an object`)
      return
    }
    if (typeof entry.path !== 'string' || entry.path === '') errors.push(`${at}.path must be a non-empty string`)
    else if (seen.has(entry.path)) errors.push(`${at}.path is duplicated: ${entry.path}`)
    else seen.add(entry.path)
    if (!Number.isSafeInteger(entry.lines) || entry.lines < 0) errors.push(`${at}.lines must be a non-negative integer`)
    if (!Number.isSafeInteger(entry.target) || entry.target < 0) errors.push(`${at}.target must be a non-negative integer`)
  })
  return errors
}

/**
 * Ratchet verdict for one entry. 'missing' = the budgeted file is gone; 'grow'
 * = the file grew past the ratified number; 'shrink' = it shrank, so the
 * ratchet must be lowered in the same change; 'ok' = exact.
 */
export function classifyEntry(entry, actual) {
  if (actual === null) return 'missing'
  if (actual > entry.lines) return 'grow'
  if (actual < entry.lines) return 'shrink'
  return 'ok'
}

function readBudget() {
  return JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
}

function lineCount(entry) {
  const absolute = resolve(ROOT, entry.path)
  try {
    const text = readFileSync(absolute, 'utf8')
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return null
  }
}

/** Built-in negative control (also covered by verify-file-budgets.test.mjs). */
function selfTest() {
  const good = { path: 'a.ts', lines: 1, target: 0 }
  const checks = [
    [validateBudget({ files: [good] }).length === 0, 'a well-formed table validates'],
    [validateBudget({ files: [{ path: 'a.ts', target: 0 }] }).length === 1, 'a missing lines field is rejected'],
    [validateBudget({ files: [{ path: 'a.ts', lines: -1, target: 0 }] }).length === 1, 'a negative budget is rejected'],
    [validateBudget({ files: [{ path: 'a.ts', lines: 1.5, target: 0 }] }).length === 1, 'a non-integer budget is rejected'],
    [validateBudget({ files: [good, { ...good }] }).length === 1, 'a duplicate path is rejected'],
    [validateBudget({ files: 'nope' }).length === 1, 'a non-array files field is rejected'],
    [classifyEntry(good, 2) === 'grow', 'growth is a failure'],
    [classifyEntry(good, 0) === 'shrink', 'shrink demands a ratchet update'],
    [classifyEntry(good, 1) === 'ok', 'an exact count is clean'],
    [classifyEntry(good, null) === 'missing', 'a missing file is a failure'],
    [(() => { try { parseArgs(['--nope']); return false } catch { return true } })(), 'an unknown argument is rejected'],
    [parseArgs(['--report']).report === true, '--report parses'],
  ]
  const failed = checks.filter(([ok]) => !ok)
  for (const [ok, label] of checks) if (!ok) console.error('self-test FAIL: ' + label)
  console.log(failed.length === 0 ? `self-test: OK (${checks.length} cases)` : `self-test: FAILED (${failed.length}/${checks.length})`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error('usage: ' + [...KNOWN_ARGS].join(' | '))
    console.error(error.message)
    process.exitCode = 2
    return
  }
  if (options.selfTest) { selfTest(); return }
  const { report, update, force } = options
  const budget = readBudget()
  const schemaErrors = validateBudget(budget)
  if (schemaErrors.length > 0) {
    for (const error of schemaErrors) console.error(`FAIL: malformed budget entry — ${error}`)
    console.error('FAIL: the ratified table is malformed (see above).')
    process.exitCode = 1
    return
  }
  const rows = []
  let failed = false
  for (const entry of budget.files) {
    const actual = lineCount(entry)
    rows.push({ ...entry, actual })
    const verdict = classifyEntry(entry, actual)
    if (verdict === 'missing') {
      console.error(`FAIL: budgeted file is gone — remove the entry: ${entry.path}`)
      failed = true
    } else if (verdict === 'grow') {
      console.error(`FAIL: ${entry.path} grew to ${actual} (ratified ${entry.lines}, target ${entry.target}) — shrink it or justify a raised budget in review`)
      failed = true
    } else if (verdict === 'shrink' && !update) {
      console.error(`FAIL: ${entry.path} shrank to ${actual} (< ratified ${entry.lines}) — run node scripts/gates/verify-file-budgets.mjs --update-budget so the ratchet only goes down`)
      failed = true
    }
  }
  if (update) {
    const next = {
      ...budget,
      files: budget.files.map((entry) => ({ ...entry, lines: lineCount(entry) ?? entry.lines })),
    }
    if (!force) {
      const raised = next.files.filter((entry, index) => entry.lines > budget.files[index].lines)
      if (raised.length > 0) {
        console.error('refusing to raise: ' + raised.map((entry) => entry.path).join(', ') + ' (use --force to override)')
        process.exitCode = 1
        return
      }
    }
    writeFileSync(BUDGET_PATH, JSON.stringify(next, null, 2) + '\n')
    console.log(`budget updated: ${next.files.length} file(s)`)
    return
  }
  const width = Math.max(...rows.map((row) => row.path.length))
  for (const row of rows) {
    const met = row.actual !== null && row.actual <= row.target ? ' TARGET-MET' : ''
    console.log(`${row.path.padEnd(width)}  ${String(row.actual).padStart(5)} / ratified ${String(row.lines).padStart(5)} / target ${String(row.target).padStart(5)}${met}`)
  }
  const total = rows.reduce((sum, row) => sum + (row.actual ?? 0), 0)
  const totalTarget = rows.reduce((sum, row) => sum + row.target, 0)
  console.log(`god-file budget: ${rows.length} file(s), ${total} lines now, ${totalTarget} at target (-${total - totalTarget} to go)`)
  if (report) return
  if (failed) {
    console.error('FAIL: the god-file ratchet moved the wrong way (see above).')
    process.exitCode = 1
  }
}
main()
