/**
 * Source-level guard for the stylesheet template literal (2026-09-13 review-fix).
 *
 * MOBILE_CSS is a single backtick-delimited template literal, so ONE backtick
 * inside a comment terminates it and every importer dies with a bare
 * `SyntaxError` pointing at the comment — a failure mode that costs a full
 * edit/run cycle to diagnose and that a parser-level test can never report
 * (the module would not even load). This file therefore reads styles.ts as
 * TEXT rather than importing it, and fails with the offending line instead.
 *
 * It also pins the second source-level invariant of that file: every rule must
 * live inside a media query (the "PC leak" rule) is asserted in
 * breakpoints.test.ts against the parsed string, so this file stays a pure
 * source guard for what breaks the PARSE.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE_URL = new URL('../src/client/styles.ts', import.meta.url)

/** The literal's open/close line numbers, 1-based. */
function literalBounds(lines: readonly string[]): { open: number; close: number } {
  const open = lines.findIndex(line => line.includes('export const MOBILE_CSS = `'))
  assert.ok(open !== -1, 'MOBILE_CSS export not found (renamed?)')
  let close = -1
  for (let index = open + 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '`') { close = index; break }
  }
  assert.ok(close !== -1, 'MOBILE_CSS closing backtick not found (unterminated literal?)')
  return { open: open + 1, close: close + 1 }
}

test('MOBILE_CSS carries no stray backtick (a comment cannot terminate the literal)', () => {
  const lines = readFileSync(fileURLToPath(SOURCE_URL), 'utf8').split('\n')
  const { open, close } = literalBounds(lines)
  const offenders: string[] = []
  for (let line = open + 1; line < close; line += 1) {
    if ((lines[line - 1] ?? '').includes('`')) offenders.push(`${line}: ${lines[line - 1] ?? ''}`)
  }
  assert.deepEqual(
    offenders,
    [],
    `a backtick inside the MOBILE_CSS literal ends it and breaks every importer:\n${offenders.join('\n')}`,
  )
})

test('the stylesheet comments stay inside the literal (single source, no shadow copy)', () => {
  const source = readFileSync(fileURLToPath(SOURCE_URL), 'utf8')
  // Exactly two backticks in the whole file would be too strict (prose outside
  // the literal legitimately quotes names); instead require the literal to be
  // the ONLY place CSS braces live, and to close on a line of its own.
  const lines = source.split('\n')
  const { close } = literalBounds(lines)
  const after = lines.slice(close).join('\n')
  assert.ok(!after.includes('{'), 'no CSS rule may live after the literal')
})
