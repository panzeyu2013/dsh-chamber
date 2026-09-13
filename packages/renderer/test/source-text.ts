/**
 * Shared helpers for the renderer's source-text wiring locks.
 *
 * `App.tsx` renders the whole shell and cannot be imported by a node test, so
 * several test files assert against its SOURCE TEXT. A lock that matches raw
 * source can be satisfied by a comment — precisely the failure mode the locks
 * exist to prevent, because the comments next to the code describe the very
 * invariant being pinned (2026-09 round-3 W4-12 precedent:
 * `packages/dsh-chamber-client-ui-sidebar/test/panel-wiring.test.ts`).
 *
 * {@link stripComments} therefore blanks every line/block comment (preserving
 * newlines, so positions and line shapes survive) while leaving string,
 * template and regex literals untouched, and {@link normalize} collapses
 * whitespace so a formatting change cannot break a semantic lock.
 */

/**
 * Remove line/block comments while preserving string and template literals.
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
