/**
 * Workflow YAML scalar gate: catch the one class of workflow syntax error that
 * every other check in this repository is blind to.
 *
 * `verify-workflow-action-pins.mjs` and `release-workflow-policy.test.mjs` read
 * the workflow files as TEXT, so they stay green on a file that GitHub refuses
 * to parse.
 *
 * The rule enforced here is the YAML constraint itself: a plain (unquoted,
 * non-block) mapping value must not contain `: ` and must not end with `:`.
 * Block scalars (`|`, `>`) and quoted values are skipped; `#` comments are not
 * values and are ignored.
 *
 * Usage:
 *   node scripts/gates/verify-workflow-yaml-scalars.mjs          # gate
 *   node scripts/gates/verify-workflow-yaml-scalars.mjs --list   # report only
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows')

/** Keys whose value is a plain scalar we can judge. */
export const SCALAR_KEYS = ['name', 'run', 'if', 'uses', 'with', 'env', 'id', 'shell', 'working-directory']

/**
 * Find plain scalars that YAML forbids.
 * @param {string} text - workflow file contents.
 * @returns {{ line: number, key: string, value: string, reason: string }[]} findings.
 */
export function findInvalidPlainScalars(text) {
  const findings = []
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.replace(/#.*$/u, '')
    if (line.trim() === '') continue
    const match = /^\s*(?:-\s+)?([A-Za-z0-9_-]+):\s?(.*)$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    if (!SCALAR_KEYS.includes(key)) continue
    const value = match[2].trim()
    if (value === '') continue
    const first = value[0]
    if (first === '"' || first === "'" || first === '|' || first === '>' || first === '[' || first === '{') continue
    if (value.includes(': ')) {
      findings.push({ line: index + 1, key, value, reason: 'plain scalar contains ": " (colon + space)' })
    } else if (value.endsWith(':')) {
      findings.push({ line: index + 1, key, value, reason: 'plain scalar ends with ":"' })
    }
  }
  return findings
}

/**
 * Collect every workflow file the gate covers.
 * @returns {string[]} absolute paths, sorted.
 */
export function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map(name => join(WORKFLOW_DIR, name))
}

function main() {
  const listOnly = process.argv.includes('--list')
  const files = workflowFiles()
  if (files.length === 0) {
    console.error('workflow YAML scalars: no workflow files found — a gate that scans nothing has not passed')
    process.exit(1)
  }
  const failures = []
  for (const file of files) {
    for (const finding of findInvalidPlainScalars(readFileSync(file, 'utf8'))) {
      failures.push({ file: relative(REPO_ROOT, file), ...finding })
    }
  }
  const report = failures.map(f => `  - ${f.file}:${String(f.line)} [${f.key}] ${f.reason}: ${f.value}`)
  if (listOnly) {
    console.log(`workflow YAML scalars: ${files.length} file(s), ${failures.length} invalid plain scalar(s)`)
    if (failures.length > 0) console.log(report.join('\n'))
    return
  }
  if (failures.length > 0) {
    console.error(`workflow YAML scalars: ${failures.length} value(s) YAML cannot parse:`)
    console.error(report.join('\n'))
    console.error('Quote the value, drop the colon, or use a block scalar.')
    process.exit(1)
  }
  console.log(`workflow YAML scalars: ${files.length} workflow file(s), no invalid plain scalars`)
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) main()
