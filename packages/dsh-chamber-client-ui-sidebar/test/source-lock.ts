/**
 * Shared helpers for the sidebar's source-text locks.
 *
 * The UI modules of this package (ServerSection / SidebarRoot /
 * ArchiveManagerDialog) value-import React and the dsh client packages, so they
 * cannot be imported in a plain `node test/…` run; their WIRING is therefore
 * pinned by reading their text — the precedent is `test/panel-wiring.test.ts`
 * (comments are stripped first, so a lock can never be satisfied by a comment).
 */

import { readFileSync } from 'node:fs'

/** Read one file relative to this test directory. */
export function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/**
 * Remove line/block comments while preserving string and template literals, so
 * an assertion over the result can never be satisfied by commented-out code.
 * @param code - the source text.
 * @returns the source with comments replaced by spaces.
 */
export function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) {
      if (ch === '\n') { line = false; out += ch } else out += ' '
      continue
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '
      continue
    }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

/** Collapse whitespace so formatting changes cannot break a semantic lock. */
export function normalize(code: string): string {
  return code.replace(/\s+/g, ' ')
}

/**
 * Whether the text carries CJK ideographs — used to prove a module has no
 * hardcoded Chinese copy left (comments must be stripped first).
 * @param code - comment-free source text.
 * @returns true when any CJK ideograph is present.
 */
export function hasCjk(code: string): boolean {
  return /[\u4e00-\u9fff]/u.test(code)
}
