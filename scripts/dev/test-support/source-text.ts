/**
 * Shared source-text helpers for the repository's source-lock tests.
 *
 * Several UI/shell modules value-import React or the dsh client packages and
 * therefore cannot be imported by a plain `node test/…` run; their WIRING is
 * pinned by reading their source text instead. A lock that matches raw source
 * can be satisfied by a COMMENT — precisely the failure mode the locks exist to
 * prevent, because the comments next to the code describe the invariant being
 * pinned.
 *
 * {@link stripComments} therefore blanks every line/block comment (preserving
 * newlines, so positions and line shapes survive) while leaving string and
 * template literals untouched, and {@link normalize} collapses whitespace so a
 * formatting change cannot break a semantic lock.
 *
 * Package-local helpers under each package's `test/support/` directory re-export these
 * instead of growing another copy: the same implementation otherwise recurs in 20
 * test files, nine of them byte-identical.
 * Deliberate variants stay local and say why (e.g. the regex-based interface
 * stripper in `packages/desktop/test/ipc/ipc-surface-mirror.test.ts`, the
 * CSS-only stripper in `packages/dsh-chamber-client-ui-mobile/test/behavior/composer-guard.test.ts`).
 */

/**
 * Remove line/block comments while preserving string and template literals.
 *
 * **不识别正则字面量**（已知边界）：正则里的 `/`、引号或 `//` 会被当普通代码字符
 * 继续扫描——最坏情形是进入错误的引号态，令后面的真注释**不被剥掉**（源锁因此可能匹配到
 * 注释文本，正是本助手要防的失败模式）；反之 `//` 形状的正则也会把行尾截成注释。
 * 需要正则感知的语料请用局部实现（见本文件头注列的刻意变体），不要靠本助手。
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
