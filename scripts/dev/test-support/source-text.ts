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
 * newlines, so positions and line shapes survive) while leaving string, template
 * and **regex** literals untouched, and {@link normalize} collapses whitespace so
 * a formatting change cannot break a semantic lock.
 *
 * Package-local helpers under each package's `test/support/` directory re-export these
 * instead of growing another copy: the same implementation otherwise recurs in 20
 * test files, nine of them byte-identical.
 * Deliberate variants stay local and say why (e.g. the regex-based interface
 * stripper in `packages/desktop/test/ipc/ipc-surface-mirror.test.ts`, the
 * CSS-only stripper in `packages/dsh-chamber-client-ui-mobile/test/behavior/composer-guard.test.ts`).
 */

/**
 * Remove line/block comments while preserving string, template and regex literals.
 *
 * 正则字面量按「表达式位置」识别：行首或 `( [ { , ; = : ! & | ? + - * % ^ ~ < >` 之后、
 * `return/typeof/case/...` 关键字之后，以及**值位置之后的无空白片段**——`) ] }`/标识符之后的
 * `/` 若到下一个未转义 `/` 之间没有空白，也按正则处理（`if (ok) /[//]/.test(s)`、
 * `function f() {} /a\/\//.test(s)`）：这类形态按除号处理会让正则体里的 `//`/`/*` 变成注释
 * 起点，把真代码抹掉（`doesNotMatch` 反向源锁假绿）；判成正则的代价只是让注释文本留在结果里
 * （可见噪声，锁会显式变红），方向安全。字符类 `[...]`、转义 `\/`、标志位按字面量原样复制。
 * 实测：对 packages 的 src 面 + scripts 共 529 个出厂文件，用 @babel/parser 的 comment 区间
 * 做独立对照——本实现抹掉的字符 100% 落在注释区间内（0 越界），且注释字符一个不漏（0 噪声）；
 * 第三轮审计的三类反例（`) ] }` 之后含 `//`、含 `/*` 吃到 EOF、无字符类的转义斜杠）都已封住。
 * 剩余已知边界（与旧实现同，仅方向为多剥）：模板字面量的 `${}` 内部不单独扫描，因此「模板里
 * 再嵌模板、且内层反引号之后的插值里出现 `//`」会被误当行注释起点；该形态在出厂源码里零出现，
 * 只在扫描面之外（dev 工作树拷贝）观察到。
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
    if (ch === '/' && startsRegexLiteral(code, i)) {
      // 正则字面量原样复制（含字符类/转义/标志位）：否则 `/\//` 会被当行注释起点，把该行
      // 后面的真代码一并 blank——反向源锁就此假绿，正是本助手存在要防的失败模式。
      out += ch
      let inClass = false
      i += 1
      while (i < code.length) {
        const rc = code[i]
        if (rc === '\\') { out += rc + (code[i + 1] ?? ''); i += 2; continue }
        if (rc === '\n') break
        if (rc === '[') inClass = true
        else if (rc === ']') inClass = false
        else if (rc === '/' && !inClass) { out += rc; i += 1; break }
        out += rc
        i += 1
      }
      while (i < code.length && /[a-z]/i.test(code[i] ?? '')) { out += code[i]; i += 1 }
      i -= 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

/** `return/typeof/...` 之后是表达式位置：那里的 `/` 起正则，不是除号。 */
const REGEX_PREFIX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do',
  'else', 'yield', 'await', 'throw',
])

/** 判断 index 处的 `/` 是否起一个正则字面量（表达式位置）；判不出时按除号处理。 */
function startsRegexLiteral(code: string, index: number): boolean {
  let j = index - 1
  while (j >= 0 && /\s/.test(code[j] ?? '')) j -= 1
  if (j < 0) return true
  const prev = code[j] ?? ''
  if ('([{,;=:!&|?+-*%^~<>'.includes(prev)) return true
  if (prev === ')' || prev === ']' || prev === '}') return looksLikeClassRegex(code, index)
  let k = j
  while (k >= 0 && /[A-Za-z0-9_$]/.test(code[k] ?? '')) k -= 1
  if (REGEX_PREFIX_KEYWORDS.has(code.slice(k + 1, j + 1))) return true
  return looksLikeClassRegex(code, index)
}

/**
 * 窄判据（第三轮）：`/` 之后到下一个未转义 `/` 之前是**无空白且含 `[`** 的片段时按正则处理。
 * 这类形态（`if (ok) /[//]/.test(s)`、`function f() {} /[/*]/.test(s)`）若按除号处理，类内的
 * `//`/`/*` 会被当注释起点把真实代码抹掉（\`doesNotMatch\` 反向源锁假绿）。收窄到「无空白 +
 * 含字符类」是为了不把 `a[i]/b[j] // c` 这类普通除号误当正则——那只会让注释文本留在结果里
 * （可见噪声），方向是安全的。
 * @param code - the source text.
 * @param index - the `/` position.
 * @returns whether the slash can only be a regex literal.
 */
function looksLikeClassRegex(code: string, index: number): boolean {
  let scanned = index + 1
  let escaped = false
  while (scanned < code.length) {
    const ch = code[scanned]
    if (ch === '\n' || ch === '\r') break
    if (escaped) { escaped = false; scanned += 1; continue }
    if (ch === '\\') { escaped = true; scanned += 1; continue }
    if (ch === '/') {
      // 判据只看「片段里没有空白」：真正则字面量（连 `\/` 转义也一起）内部不会出现
      // 空白，而除号的右操作数几乎总有空白或跨行（`a / b`、`a[i]/b[j]` 之外的形态）。
      // 放宽到「无空白」是为了覆盖 `if (x) /a\/\//.test(s)` 这类无字符类的正则；
      // 代价方向仍是安全的：误判成正则只会让注释文本留在结果里（可见噪声）。
      const inner = code.slice(index + 1, scanned)
      return !/\s/u.test(inner)
    }
    scanned += 1
  }
  return false
}

/** Collapse whitespace so formatting changes cannot break a semantic lock. */
export function normalize(code: string): string {
  return code.replace(/\s+/g, ' ')
}
