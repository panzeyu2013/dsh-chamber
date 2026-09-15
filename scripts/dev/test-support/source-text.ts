/**
 * Shared source-text helpers for the repository's source-lock tests.
 *
 * Several UI/shell modules value-import React or the dsh client packages and
 * therefore cannot be imported by a plain `node test/…` run; their WIRING is
 * pinned by reading their source text instead. A lock that matches raw source
 * can be satisfied by a COMMENT — precisely the failure mode the locks exist to
 * prevent, because the comments next to the code describe the invariant being
 * pinned (2026-09 round-3 W4-12 precedent:
 * `packages/dsh-chamber-client-ui-sidebar/test/plugin-kernel/panel-wiring.test.ts`).
 *
 * {@link stripComments} therefore blanks every line/block comment (preserving
 * newlines, so positions and line shapes survive) while leaving string and
 * template literals untouched, and {@link normalize} collapses whitespace so a
 * formatting change cannot break a semantic lock.
 *
 * Package-local helpers under each package's `test/support/` directory re-export these
 * instead of growing another copy: before the 2026-12 support-layer pass the
 * same implementation existed in 20 test files, nine of them byte-identical.
 * Deliberate variants stay local and say why (e.g. the regex-based interface
 * stripper in `packages/desktop/test/ipc/ipc-surface-mirror.test.ts`, the
 * CSS-only stripper in `packages/dsh-chamber-client-ui-mobile/test/visual/breakpoints.test.ts`).
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
