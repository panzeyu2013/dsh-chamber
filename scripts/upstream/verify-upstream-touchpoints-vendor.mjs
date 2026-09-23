/**
 * Pure verdict for the C16 vendor-source-consumer gate (R4 P5).
 *
 * WHY THIS EXISTS: `packages/renderer/src/host-graph.ts` reads the boot-graph
 * wire validators (`optionalStringArray` / `stripClientSuffix`) from the PINNED
 * upstream module by real-source RELATIVE path
 * (`../../../vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts`).
 * That path is public in the vendor package's `exports` (`./src/*`), the module
 * is browser-safe with zero runtime imports, and a plain-node renderer test
 * cannot resolve `@deepseek-ai/*` — so the chamber rule is "keep the vendor
 * import, REGISTER it", never "hand-roll a second implementation". The audit
 * defect was the missing registration, not the reference.
 *
 * C16 turns the registration into a machine judgment in BOTH directions:
 *   1. every registered `(consumer, vendorFile)` pair must still exist as a
 *      relative import in the consumer, with a symbol set EQUAL to the
 *      registered one (an extra or a missing symbol is a hard failure — the
 *      registration is the hand-written half);
 *   2. every symbol must still be exported as a function by the vendor file
 *      (an upstream rename/downgrade hard-fails and forces the `retiresWhen`
 *      adjudication);
 *   3. a relative import that escapes a chamber package into `vendor/` without
 *      a registered pair is a hard failure — no second allowlist exists.
 *
 * The import extraction is a small tokenizer (comments removed, string,
 * template and regex literals replaced by placeholders), so a decoy inside a
 * comment or a string can never satisfy the gate. It is shared with the P7
 * package-boundary gate (`scripts/gates/verify-package-boundaries.mjs`), which
 * uses the same registry block to allow exactly these vendor imports.
 *
 * Pure: no I/O, no process access. The gate script reads the files and passes
 * their text in (`text: null` = unreadable, itself a hard failure).
 */

/** Escape one literal for embedding in a RegExp. */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Index just past the quoted string whose opening quote is at `start`. */
function skipQuoted(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    if (source[index] === '\\') { index += 2; continue }
    if (source[index] === quote) return index + 1
    index += 1
  }
  return index
}

/** Index just past the template literal whose opening backtick is at `start`. */
function skipTemplate(source, start) {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') { index += 2; continue }
    if (char === '`') return index + 1
    index += 1
  }
  return index
}

/** Index just past a regex literal starting at `start`, or -1 when none closes on the line. */
function skipRegex(source, start) {
  let index = start + 1
  let inClass = false
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') { index += 2; continue }
    if (char === '\n') return -1
    if (char === '/' && !inClass) return index + 1
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    index += 1
  }
  return -1
}

/**
 * Code-only projection: line/block comments removed, and every string, template
 * or regex literal replaced by `\u0000<index>\u0000` (the literal table is
 * returned alongside). This is what makes the extraction decoy-proof: text
 * inside a comment or a literal is never read as an import.
 * @param {string} source - TS/TSX/JS source text.
 * @returns {{ code: string, literals: string[] }} projection + literal values.
 */
export function codeProjection(source) {
  const literals = []
  let code = ''
  let index = 0
  let previous = ''
  const placeholder = (value) => {
    literals.push(value)
    // Newlines inside a literal/comment are preserved so a later match still
    // reports the real source line.
    const newlines = (value.match(/\n/gu) ?? []).length
    return '\n'.repeat(newlines) + `\u0000${literals.length - 1}\u0000`
  }
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '"' || char === "'") {
      const end = skipQuoted(source, index)
      code += placeholder(source.slice(index + 1, end - 1))
      previous = "'"
      index = end
      continue
    }
    if (char === '`') {
      const end = skipTemplate(source, index)
      code += placeholder(source.slice(index + 1, end - 1))
      previous = '`'
      index = end
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') code += '\n'
        index += 1
      }
      index += 2
      continue
    }
    if (char === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(previous)) {
      const end = skipRegex(source, index)
      if (end !== -1) {
        code += placeholder('/(?:)/')
        previous = '/'
        index = end
        continue
      }
    }
    code += char
    if (!/\s/.test(char)) previous = char
    index += 1
  }
  return { code, literals }
}

/** Line number (1-based) of `at` inside `text`. */
const lineAt = (text, at) => text.slice(0, at).split('\n').length

/**
 * Parse the imported/exported names of one import clause, e.g.
 * `{ a, b as c, type D }` -> `['D', 'a', 'b']`, `defaultExport, { x }` ->
 * `['default', 'x']`, `* as ns` -> `['*']`.
 * @param {string} clause - the text between `import`/`export` and `from`.
 * @returns {string[]} sorted, de-duplicated source-side symbol names.
 */
export function clauseSymbols(clause) {
  const cleaned = clause.replace(/^\s*(?:import|export)\s+/u, '').replace(/^type\s+/u, '').trim()
  const symbols = new Set()
  const braces = /\{([^}]*)\}/u.exec(cleaned)
  if (braces !== null) {
    for (const raw of braces[1].split(',')) {
      const part = raw.replace(/^\s*type\s+/u, '').trim()
      if (part === '') continue
      symbols.add(part.split(/\s+as\s+/u)[0].trim())
    }
  }
  // A default binding may precede the named clause (`import d, { a } from`).
  const beforeBraces = braces === null ? cleaned : cleaned.slice(0, braces.index).trim()
  if (/^[A-Za-z_$][\w$]*\s*,?$/u.test(beforeBraces)) symbols.add('default')
  if (/\*/u.test(cleaned)) symbols.add('*')
  return [...symbols].sort()
}

/**
 * Every static/dynamic import or require in `text` whose specifier is a string
 * literal, with the source-side symbol names it binds and the line number.
 * @param {string} text - source text.
 * @returns {{ specifier: string, symbols: string[], index: number, line: number }[]}
 */
export function sourceModuleSpecifiers(text) {
  const { code, literals } = codeProjection(text)
  const found = []
  const seen = new Set()
  const push = (match, specifierIndex, clause) => {
    const literalIndex = Number.parseInt(match[specifierIndex], 10)
    const specifier = literals[literalIndex]
    if (typeof specifier !== 'string' || specifier === '') return
    const key = `${specifier}\u0000${match.index}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({
      specifier,
      symbols: clause === undefined ? [] : clauseSymbols(clause),
      index: match.index,
      line: lineAt(code, match.index),
    })
  }
  const stringRef = '\\u0000(\\d+)\\u0000'
  // Explicit group indexes: the clause capture exists only on the first two
  // forms, so "group 1 is non-empty" is NOT a valid discriminator (the
  // dynamic/require forms have their digits in group 1).
  const patterns = [
    // import … from '<spec>' / import type … from '<spec>': clause 1, specifier 2
    { expression: new RegExp(`\\bimport\\s+((?:type\\s+)?[\\w$*{},\\s:]*?)\\bfrom\\s*${stringRef}`, 'gu'), clauseGroup: 1, specifierGroup: 2 },
    // export … from '<spec>': clause 1, specifier 2
    { expression: new RegExp(`\\bexport\\s+((?:type\\s+)?(?:\\*|\\{[\\w$,\\s]*\\}))\\s*from\\s*${stringRef}`, 'gu'), clauseGroup: 1, specifierGroup: 2 },
    // side-effect import '<spec>': specifier 1
    { expression: new RegExp(`\\bimport\\s*${stringRef}`, 'gu'), specifierGroup: 1 },
    // dynamic import('<spec>') / require('<spec>'): specifier 1
    { expression: new RegExp(`\\bimport\\s*\\(\\s*${stringRef}\\s*\\)`, 'gu'), specifierGroup: 1 },
    { expression: new RegExp(`\\brequire\\s*\\(\\s*${stringRef}\\s*\\)`, 'gu'), specifierGroup: 1 },
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern.expression)) {
      push(match, pattern.specifierGroup, pattern.clauseGroup === undefined ? undefined : match[pattern.clauseGroup])
    }
  }
  return found.sort((a, b) => a.index - b.index)
}

/**
 * Resolve one relative specifier against a repo-relative file path (POSIX
 * normalization, no extension probing) — the `/`-separated form every registry
 * key uses.
 * @param {string} file - repo-relative consumer path.
 * @param {string} specifier - a `./` or `../` specifier.
 * @returns {string} repo-relative resolved path.
 */
export function resolveRelativeSpecifier(file, specifier) {
  const segments = file.split('/').slice(0, -1)
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') segments.pop()
    else segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Every relative import of `file` that escapes into the vendor tree
 * (`vendor/…`), the only relative escape the registry may track.
 * @param {string} file - repo-relative consumer path.
 * @param {string} text - consumer source text.
 * @returns {{ consumer: string, vendorFile: string, specifier: string, symbols: string[], line: number }[]}
 */
export function relativeVendorImports(file, text) {
  const out = []
  for (const item of sourceModuleSpecifiers(text)) {
    if (!item.specifier.startsWith('.')) continue
    const vendorFile = resolveRelativeSpecifier(file, item.specifier)
    if (!vendorFile.startsWith('vendor/')) continue
    out.push({ consumer: file, vendorFile, specifier: item.specifier, symbols: item.symbols, line: item.line })
  }
  return out
}

/**
 * Decide C16 for one run.
 * @param {object} input - collected facts.
 * @param {unknown} input.entries - `registry.vendorSourceConsumers` (any non-array is a failure).
 * @param {{ consumer: string, vendorFile: string, specifier: string, symbols: string[], line: number }[]} input.imports - every discovered vendor-relative import.
 * @param {Record<string, string | null>} input.vendorSources - registered vendorFile -> text (null = unreadable).
 * @returns {{ ok: boolean, failures: string[], summary: string }} verdict.
 */
export function vendorSourceVerdict({ entries, imports, vendorSources }) {
  const failures = []
  if (!Array.isArray(entries)) {
    failures.push('C16 registry 缺 vendorSourceConsumers 数组——vendor 源直穿必须登记（单一来源 scripts/upstream/registry.json）')
    return { ok: false, failures, summary: '' }
  }
  const key = (consumer, vendorFile) => `${consumer}\u0000${vendorFile}`
  const registered = new Set(entries.map((entry) => key(entry.consumer, entry.vendorFile)))
  if (registered.size !== entries.length) {
    failures.push('C16 registry vendorSourceConsumers 有重复的 (consumer, vendorFile) 条目——一对只允许登记一次')
  }

  for (const item of imports) {
    if (!registered.has(key(item.consumer, item.vendorFile))) {
      failures.push(
        `C16 未登记的 vendor 源相对 import: ${item.consumer}:${item.line} → '${item.specifier}'（${item.vendorFile}）——`
        + 'vendor 直穿必须登记进 registry.vendorSourceConsumers（consumer/vendorFile/symbols/reason/retiresWhen），'
        + '或改走包说明符；不得以「登记表之外」的形态存在',
      )
    }
  }

  const sourceCode = (text) => codeProjection(text).code
  for (const entry of entries) {
    const found = imports.filter((item) => item.consumer === entry.consumer && item.vendorFile === entry.vendorFile)
    if (found.length === 0) {
      failures.push(
        `C16 过期登记: ${entry.consumer} 不再相对 import ${entry.vendorFile}——`
        + '删除 registry.vendorSourceConsumers 条目（若已改走包说明符），或恢复该 import（双向一致，不许留孤儿登记）',
      )
      continue
    }
    const actual = [...new Set(found.flatMap((item) => item.symbols))].sort()
    const expected = [...new Set(entry.symbols)].sort()
    if (actual.join(',') !== expected.join(',')) {
      failures.push(
        `C16 符号集合不一致: ${entry.consumer} 实际 import [${actual.join(', ')}]，`
        + `登记 [${expected.join(', ')}]——多/少都是硬失败：同批更新 registry 登记（或恢复 import）`,
      )
    }
    const text = vendorSources?.[entry.vendorFile]
    if (typeof text !== 'string') {
      failures.push(
        `C16 读不到 vendor 文件 ${entry.vendorFile}（pin 树未物化/文件被删/改名）——`
        + '先 ensure-harness-vendor（子模块物化）后重跑；若上游确实删除/改名，按 entry.retiresWhen 裁决移植',
      )
      continue
    }
    const code = sourceCode(text)
    for (const symbol of expected) {
      if (symbol === 'default' || symbol === '*') {
        failures.push(`C16 登记的符号 '${symbol}' 不是具名导出：本门要求每个登记符号在 vendor 文件里是 export function <name>`)
        continue
      }
      const pattern = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${escapeRegExp(symbol)}\\b`, 'u')
      if (!pattern.test(code)) {
        failures.push(
          `C16 ${entry.vendorFile} 不再以 export function ${symbol} 导出（上游改名/重写？）——`
          + '按登记条目的 retiresWhen 裁决：上游已把符号放上公开面则退役直穿并删除登记，否则更新本门与登记',
        )
      }
    }
  }

  if (failures.length > 0) return { ok: false, failures, summary: '' }
  return {
    ok: true,
    failures: [],
    summary: `✓ C16 vendor 源消费者: ${entries.length} 条登记与 ${imports.length} 条真实相对 import 双向一致（符号集合逐条相等；导出仍是 export function）`,
  }
}
