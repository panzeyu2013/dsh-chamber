/**
 * Pure verdict for the C11 hover-port gate (design 06 §7; 2026-09-13).
 *
 * WHY THIS EXISTS: the chamber sidebar draws its row hover cards with its own
 * `RowHoverCard` + `shared/hover-intent.ts` instead of the pinned
 * `ui-primitives` HoverCard. The vendored atom arms its grace close against the
 * last COMMITTED `open` (its `onPointerLeave` is `if (open) armClose()`), so a
 * pointerleave handled while React's commit of the dwell open is still pending
 * arms nothing and the card mounts with the pointer already gone — nothing
 * later can dismiss it. Vendor sources are read-only here, so the corrected
 * machine lives in the chamber package. That port is a DEVIATION with one
 * explicit retirement condition — "upstream fixes the race" — and before this
 * module nothing checked it.
 *
 * The verdict turns the condition into a machine judgment over the PINNED
 * upstream tree:
 *   1. the racy close shape is still there: in the `HoverCard` component, every
 *      call to the `usePointerGrace` arm inside an `onPointerLeave` handler is
 *      reached only under the committed `open` condition (an `if`/`&&`/`?:`
 *      test). One bare or differently-guarded occurrence means the premise may
 *      be gone and a human must adjudicate — it is NOT auto-passed;
 *   2. the racy OPEN shape is still there: the dwell timer that opens the card
 *      re-checks NOTHING about the pointer (2026-09-13 review finding A1). The
 *      race has two ends, and the minimal upstream fix on the OPEN end —
 *      `if (!insideRef.current) return` inside the dwell callback — would leave
 *      `onPointerLeave` byte-identical, so a close-side-only gate would keep
 *      printing ✓ after the retirement condition was met. Zero dwell timers
 *      (the open path was rewritten) and several candidates are DRIFT too;
 *   3. the two timing constants stay in lockstep with the chamber port
 *      (upstream `POINTER_GRACE_MS` == chamber `HOVER_CLOSE_GRACE_MS`, upstream
 *      `openDelayMs` default == chamber `HOVER_OPEN_DELAY_MS`), each read from a
 *      UNIQUE assignment: zero matches and several distinct values are both
 *      hard failures, so a decoy or a second assignment can never be picked;
 *   4. any check failing is a HARD failure, so the day upstream fixes the
 *      race — from either end — the maintainer is forced to decide: retire the
 *      port or re-register the deviation, instead of discovering it by accident.
 *
 * DECOY DISCIPLINE (2026-09-13 adversarial review): the shape match and the
 * numeric parse both run on ONE `stripComments()` projection per file that keeps
 * code only — comments removed AND string, template and regex literals
 * neutralized — and the shape match is scoped to the `HoverCard` component body,
 * so neither a log/telemetry string, a comment, a regex/pattern literal, an
 * unrelated `open` expression in another statement, nor a second component's
 * handler in the same file can fake a pass.
 *
 * Pure: no I/O, no process access. The gate reads the files and passes their
 * text in (`text: null` = unreadable, which is itself a hard failure: a missing
 * pin tree must never read as "no race"). The gate script itself is a
 * top-level program and cannot be imported by a test, the same split
 * `artifact-gate.mjs` and `verify-upstream-touchpoints-args.mjs` use.
 */

/**
 * A source file handed to {@link hoverPortVerdict}.
 * @typedef {{ path: string, text: string | null }} SourceFile
 */

/**
 * The upstream/chamber pairs the gate reads. Kept here, next to the parse, so
 * the registry in `docs/checklists/upstream-touchpoints.md` has one machine
 * counterpart.
 */
export const HOVER_PORT_SOURCES = {
  /** Upstream atom whose racy close the port replaces (pin, not origin/master). */
  upstreamHoverCard: 'packages/client/ui-primitives/src/HoverCard.tsx',
  /** Upstream grace constant + hook the racy shape is built from. */
  upstreamPointerGrace: 'packages/client/ui-primitives/src/pointer-grace.ts',
  /** Chamber port: the constants the upstream values must stay lockstep with. */
  chamberHoverIntent: 'packages/dsh-chamber-client-ui-sidebar/src/shared/hover-intent.ts',
}

/** The component whose close handler the shape check is scoped to. */
const HOVER_CARD_COMPONENT = 'HoverCard'

/** Timing pairs: upstream name (per file) ↔ chamber constant (hover-intent.ts). */
const TIMING_PAIRS = [
  {
    upstream: { source: 'upstreamPointerGrace', name: 'POINTER_GRACE_MS' },
    chamber: { name: 'HOVER_CLOSE_GRACE_MS' },
    meaning: '宽限关闭（指针离场后跨 8px 间隙）',
  },
  {
    upstream: { source: 'upstreamHoverCard', name: 'openDelayMs' },
    chamber: { name: 'HOVER_OPEN_DELAY_MS' },
    meaning: '悬停停留 dwell（上游内联默认值）',
  },
]

/** Escape one literal for embedding in a RegExp. */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// ---------------------------------------------------------------------------
// Code-only projection: comments removed, string/template literals neutralized
// ---------------------------------------------------------------------------

/**
 * Index just past the quoted string whose opening quote is at `start`.
 * @param {string} source - source text.
 * @param {number} start - index of the opening `'` or `"`.
 * @returns {number} index just past the closing quote (or the text end).
 */
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

/**
 * Index just past the template literal whose opening backtick is at `start`,
 * including any `${ … }` expression (which is scanned as code).
 * @param {string} source - source text.
 * @param {number} start - index of the opening backtick.
 * @returns {number} index just past the closing backtick (or the text end).
 */
function skipTemplate(source, start) {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') { index += 2; continue }
    if (char === '`') return index + 1
    if (char === '$' && source[index + 1] === '{') { index = skipTemplateExpression(source, index + 2); continue }
    index += 1
  }
  return index
}

/**
 * Index just past the `}` closing a `${ … }` expression whose body starts at
 * `start` (nested strings/templates/comments are skipped).
 * @param {string} source - source text.
 * @param {number} start - index of the first character of the expression body.
 * @returns {number} index just past the matching `}` (or the text end).
 */
function skipTemplateExpression(source, start) {
  let index = start
  let depth = 0
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'") { index = skipQuoted(source, index); continue }
    if (char === '`') { index = skipTemplate(source, index); continue }
    if (char === '{') { depth += 1; index += 1; continue }
    if (char === '}') {
      if (depth === 0) return index + 1
      depth -= 1
      index += 1
      continue
    }
    index += 1
  }
  return index
}

/**
 * Keep only CODE: line/block comments are removed and every string, template or
 * regex literal is replaced by an empty placeholder, so no literal content can
 * ever satisfy the shape match or be read as a constant assignment. (The name is
 * from this module's first revision; the literal neutralization is what makes
 * the checks decoy-proof.) The regex heuristic (`/` where a value may start)
 * keeps text verbatim when no closing `/` follows before the line ends, so a
 * misdetected JSX closing tag cannot swallow the rest of its line.
 * @param {string} source - TS/TSX source text.
 * @returns {string} a code-only projection of `source`.
 */
export function stripComments(source) {
  let out = ''
  let index = 0
  /** Last emitted non-space code character: the regex-literal position hint. */
  let previous = ''
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '"' || char === "'") {
      index = skipQuoted(source, index)
      out += "''"
      previous = "'"
      continue
    }
    if (char === '`') {
      index = skipTemplate(source, index)
      out += '``'
      previous = '`'
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '/' && /[=(,:[!&|?{};+\-*%^~<>]/.test(previous)) {
      // A regex literal is NEUTRALIZED like any other literal: its text is
      // pattern data, so a decoy such as `/if (open) armClose()/` or
      // `/POINTER_GRACE_MS = 200/` must not be readable as code either. The
      // heuristic (`/` where a value may start) misfires on JSX closing tags
      // (`</span>` — the `<` looks like a value position); when no closing `/`
      // is found before the line ends it is NOT a regex, and the text is kept
      // verbatim so no real code (braces included) can be swallowed.
      const start = index
      index += 1
      let inClass = false
      let closed = false
      while (index < source.length) {
        const inner = source[index]
        if (inner === '\\') { index += 2; continue }
        if (inner === '\n') break
        if (inner === '/' && !inClass) { closed = true; index += 1; break }
        if (inner === '[') inClass = true
        else if (inner === ']') inClass = false
        index += 1
      }
      if (closed) {
        out += '/(?:)/'
        previous = '/'
      } else {
        const verbatim = source.slice(start, index)
        out += verbatim
        previous = verbatim.replace(/\s+$/, '').slice(-1) || previous
      }
      continue
    }
    out += char
    if (!/\s/.test(char)) previous = char
    index += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Structural extraction (all over the code-only projection)
// ---------------------------------------------------------------------------

/**
 * Index of the `}` matching the `{` at `open`, or -1.
 * @param {string} text - source text.
 * @param {number} open - index of the opening brace.
 * @returns {number} index of the matching close brace.
 */
function matchingBrace(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Index of the `)` matching the `(` at `open`, or -1.
 * @param {string} text - source text.
 * @param {number} open - index of the opening parenthesis.
 * @returns {number} index of the matching close parenthesis.
 */
function matchingParen(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * Body of the `name` component (function-declaration form) — the scope every
 * shape check runs in, so a second component's handler in the same file cannot
 * be read instead.
 * @param {string} code - code-only source.
 * @param {string} name - component name.
 * @returns {{ start: number, end: number, text: string } | null} body region, or
 *   null when the declaration cannot be found (the gate treats that as drift).
 */
export function componentBody(code, name) {
  const patterns = [
    new RegExp(`export\\s+function\\s+${escapeRegExp(name)}\\s*\\(`),
    new RegExp(`(?:^|[^\\w$.])function\\s+${escapeRegExp(name)}\\s*\\(`),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(code)
    if (match === null) continue
    const paramsOpen = code.indexOf('(', match.index)
    const paramsClose = paramsOpen === -1 ? -1 : matchingParen(code, paramsOpen)
    if (paramsClose === -1) continue
    const braceOpen = code.indexOf('{', paramsClose)
    if (braceOpen === -1) continue
    const braceClose = matchingBrace(code, braceOpen)
    if (braceClose === -1) continue
    return { start: braceOpen + 1, end: braceClose, text: code.slice(braceOpen + 1, braceClose) }
  }
  return null
}

/**
 * Every JSX attribute arrow-function in `code`, e.g.
 * `onPointerLeave={() => { … }}` or `onPointerLeave={flag ? () => { … } : undefined}`.
 * @param {string} code - code-only source.
 * @param {string} attribute - JSX attribute name (e.g. `onPointerLeave`).
 * @returns {{ body: string, handler: string }[]} the arrow body (block contents,
 *   or the expression after `=>`) and the whole JSX expression container, per
 *   occurrence (empty when the shape is absent).
 */
export function jsxArrowHandlers(code, attribute) {
  const found = []
  let from = 0
  for (;;) {
    const at = code.indexOf(attribute, from)
    if (at === -1) return found
    const tail = code.slice(at + attribute.length)
    const assignment = /^\s*=\s*\{/.exec(tail)
    if (assignment === null) {
      from = at + attribute.length
      continue
    }
    const open = at + attribute.length + assignment[0].length - 1
    const close = matchingBrace(code, open)
    if (close === -1) return found
    const handler = code.slice(open + 1, close)
    from = close + 1
    const arrow = handler.indexOf('=>')
    if (arrow === -1) {
      found.push({ body: handler, handler })
      continue
    }
    const rest = handler.slice(arrow + 2)
    const start = rest.search(/\S/)
    if (start === -1) {
      found.push({ body: handler, handler })
      continue
    }
    if (rest[start] === '{') {
      const end = matchingBrace(handler, arrow + 2 + start)
      found.push({ body: end === -1 ? handler : handler.slice(arrow + 2 + start + 1, end), handler })
      continue
    }
    found.push({ body: rest.slice(start), handler })
  }
}

/**
 * First JSX attribute arrow-function in `code` (diagnostics + single-handler
 * callers); see {@link jsxArrowHandlers}.
 * @param {string} code - code-only source.
 * @param {string} attribute - JSX attribute name.
 * @returns {{ body: string, handler: string } | null} the first occurrence.
 */
export function jsxArrowHandler(code, attribute) {
  return jsxArrowHandlers(code, attribute)[0] ?? null
}

/**
 * The local identifier bound to the `arm` half of `usePointerGrace()`, read from
 * the destructuring inside the component (upstream aliases it to `armClose`).
 * STRICT on purpose: without the destructuring there is no proven grace arm, so
 * the caller treats null as drift instead of guessing at a `*arm*(` callee
 * (which a decoy could supply).
 * @param {string} code - code-only source.
 * @returns {string | null} the grace-arm identifier, or null when the hook's arm
 *   half is absent/renamed.
 */
export function pointerGraceArmName(code) {
  const destructure = /const\s*\{([\s\S]*?)\}\s*=\s*usePointerGrace\s*\(/.exec(code)
  if (destructure === null) return null
  const aliased = /\barm\s*:\s*([A-Za-z_$][\w$]*)/.exec(destructure[1])
  if (aliased !== null) return aliased[1]
  if (/(?:^|[{,\s])arm\s*(?:[,}\s]|$)/.test(destructure[1])) return 'arm'
  return null
}

// ---------------------------------------------------------------------------
// Occurrence-level guard analysis
// ---------------------------------------------------------------------------

/**
 * Whether a conditional test references the committed `open` state. A NEGATED
 * `open` (`!open`) does not count: it inverts the racy intent instead of
 * reproducing it, and treating it as the known shape would hide a rewrite.
 */
const referencesOpen = (text) => /\bopen\b/.test(text) && !/!\s*open\b/.test(text)

/** Index of the last ternary `?` (ignoring `?.` and `??`), or -1. */
function lastTernaryQuestion(text) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== '?') continue
    if (text[index - 1] === '?' || text[index + 1] === '?' || text[index + 1] === '.') continue
    return index
  }
  return -1
}

/**
 * The statement region containing `at`: from just after the last statement
 * boundary at the same nesting depth (`;`, or an unmatched `{`/`(`/`[`) up to
 * `at`.
 * @param {string} body - the handler body (code-only).
 * @param {number} at - index of the call.
 * @returns {{ text: string, boundary: string, boundaryIndex: number }} region.
 */
function statementRegion(body, at) {
  let depth = 0
  for (let index = at - 1; index >= 0; index -= 1) {
    const char = body[index]
    if (char === ')' || char === ']' || char === '}') { depth += 1; continue }
    if (char === '(' || char === '[' || char === '{') {
      if (depth === 0) return { text: body.slice(index + 1, at), boundary: char, boundaryIndex: index }
      depth -= 1
      continue
    }
    if (depth === 0 && char === ';') return { text: body.slice(index + 1, at), boundary: ';', boundaryIndex: index }
  }
  return { text: body.slice(0, at), boundary: '', boundaryIndex: -1 }
}

/** Index of the `{` owning the statement that ends at `from`, or -1. */
function enclosingBrace(body, from) {
  let depth = 0
  for (let index = from; index >= 0; index -= 1) {
    const char = body[index]
    if (char === ')' || char === ']' || char === '}') { depth += 1; continue }
    if (char === '(' || char === '[') {
      if (depth > 0) depth -= 1
      continue
    }
    if (char === '{') {
      if (depth === 0) return index
      depth -= 1
    }
  }
  return -1
}

/**
 * Whether the tail of `text` is a conditional that governs a call placed right
 * after it: `if (…open…)`, `…open… &&`, `…open… ?`.
 * @param {string} text - statement text ending where the call starts.
 * @returns {boolean} true when the call is guarded by the committed `open`.
 */
function regionGuardsOpen(text) {
  const tail = text.replace(/\s+$/, '')
  const ifPattern = /(?:^|[^\w$])if\s*\(/g
  let lastIf = null
  for (let match = ifPattern.exec(tail); match !== null; match = ifPattern.exec(tail)) lastIf = match
  if (lastIf !== null) {
    const open = lastIf.index + lastIf[0].lastIndexOf('(')
    const close = matchingParen(tail, open)
    if (close !== -1 && /^[{(\s]*$/.test(tail.slice(close + 1)) && referencesOpen(tail.slice(open + 1, close))) {
      return true
    }
  }
  const andAt = tail.lastIndexOf('&&')
  if (andAt !== -1 && /^[(\s]*$/.test(tail.slice(andAt + 2)) && referencesOpen(tail.slice(0, andAt))) return true
  const questionAt = lastTernaryQuestion(tail)
  if (questionAt !== -1 && /^[(\s]*$/.test(tail.slice(questionAt + 1)) && referencesOpen(tail.slice(0, questionAt))) {
    return true
  }
  return false
}

/**
 * Whether the call at `at` is reached only under the committed `open` — the
 * occurrence-level rule. A blank statement region steps outward into the
 * enclosing construct (`{ … }` block, `( … )`, or the block owning the
 * statement), so `if (open) { clearTimer(); armClose() }` still counts, while a
 * bare, `openRef`-guarded, or merely nearby-`open` call does not.
 * @param {string} body - the handler body (code-only).
 * @param {number} at - index of the arm call.
 * @returns {boolean} true when this occurrence is guarded by committed `open`.
 */
function governedByCommittedOpen(body, at) {
  let position = at
  for (let step = 0; step < 8; step += 1) {
    const region = statementRegion(body, position)
    if (region.text.trim() !== '') return regionGuardsOpen(region.text)
    if (region.boundary === '{' || region.boundary === '(' || region.boundary === '[') {
      position = region.boundaryIndex
      continue
    }
    if (region.boundary === ';') {
      const block = enclosingBrace(body, region.boundaryIndex)
      if (block === -1) return false
      position = block
      continue
    }
    return false
  }
  return false
}

// ---------------------------------------------------------------------------
// Open-path (dwell) analysis — the OTHER half of the race
// ---------------------------------------------------------------------------

/**
 * Words that name a SYNCHRONOUS pointer-presence fact when they appear as an
 * identifier segment. Segment-wise (camelCase/underscore split) on purpose:
 * `pointerInside` / `insideRef` / `hoveringRef` all hit, while `disabled`,
 * `openDelayMs`, `clearTimer` and `cancelClose` — the identifiers the pinned
 * open path really uses — do not.
 */
const POINTER_PRESENCE_WORDS = new Set([
  'inside', 'hover', 'hovering', 'hovered', 'within', 'present', 'current', 'over',
])

/**
 * The pointer-presence signal in `text`, or null. A ref read (`x.current`) is
 * matched first because it is the characteristic shape of the fix — the pointer
 * flag has to be readable synchronously at dwell-fire time.
 * Scope note: only ever applied to a dwell timer's callback region, never to a
 * whole file — `pointer-grace.ts` reads `closeRef.current` legitimately.
 * @param {string} text - the dwell callback region (code-only).
 * @returns {string | null} the offending identifier/property read.
 */
export function pointerPresenceSignal(text) {
  const refRead = /\b[A-Za-z_$][\w$]*\s*\.\s*current\b/.exec(text)
  if (refRead !== null) return refRead[0]
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const segments = match[0].split(/(?=[A-Z])|_/).filter((segment) => segment !== '')
    if (segments.some((segment) => POINTER_PRESENCE_WORDS.has(segment.toLowerCase()))) return match[0]
  }
  return null
}

/** Index of the first top-level `,` in `text` (nesting-aware), or -1. */
function topLevelComma(text) {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue }
    if (char === ')' || char === ']' || char === '}') { depth -= 1; continue }
    if (char === ',' && depth === 0) return index
  }
  return -1
}

/**
 * Every `setTimeout(` call in `code` whose FIRST argument opens the card
 * (`setOpen(true)`), as `{ at, callback }` (callback = the first-argument
 * region). Selection is semantic, not positional, so reformatting is tolerated
 * while a rewritten open path (or a decoy timer that does not open) is not.
 * @param {string} code - the `HoverCard` component body (code-only).
 * @returns {{ at: number, callback: string }[]} the dwell timers found.
 */
export function dwellOpenTimers(code) {
  const found = []
  const pattern = /\bsetTimeout\s*\(/g
  for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
    const open = match.index + match[0].length - 1
    const close = matchingParen(code, open)
    if (close === -1) continue
    const args = code.slice(open + 1, close)
    const comma = topLevelComma(args)
    const first = comma === -1 ? args : args.slice(0, comma)
    if (/setOpen\s*\(\s*true\s*\)/.test(first)) found.push({ at: match.index, callback: first })
  }
  return found
}

/**
 * Whether the OPEN path still lacks a pointer-presence re-check — i.e. whether
 * the racy half this port compensates for is still there.
 *
 * STRICT on purpose: zero dwell timers (the open path was rewritten) and several
 * candidates (an ambiguous/duplicated open path) are both DRIFT, never a pass —
 * the day upstream fixes the race from this side, a maintainer must retire the
 * port or re-adjudicate it, and a structural rewrite deserves the same review.
 * @param {string} component - the `HoverCard` component body (code-only).
 * @returns {{ racy: boolean, detail: string }} verdict + human-readable detail.
 */
export function racyOpenPathShape(component) {
  const timers = dwellOpenTimers(component)
  if (timers.length === 0) {
    return {
      racy: false,
      detail: '找不到「dwell 定时器里 setOpen(true)」这一 OPEN 路径（已改写/移除）',
    }
  }
  if (timers.length > 1) {
    return {
      racy: false,
      detail: `有 ${timers.length} 处 setTimeout 回调会 setOpen(true)，生效点不唯一`,
    }
  }
  const signal = pointerPresenceSignal(timers[0].callback)
  if (signal !== null) {
    return {
      racy: false,
      detail: `dwell 回调里出现了指针在场复查（${signal}）——`
        + '上游可能已从 OPEN 侧修掉竞态',
    }
  }
  return { racy: true, detail: 'dwell 回调只做 setOpen(true)，OPEN 侧未复查指针在场' }
}

/**
 * Whether EVERY call to the grace arm in `body` sits inside a conditional whose
 * test references the committed `open`. Matched semantically on code-only text
 * (whitespace/reformatting tolerant, so this is not a whitespace-exact string
 * lock). A guard that reads anything but the committed `open` (a ref, a
 * different flag, no guard at all) does NOT match — that is the day the
 * deviation must be re-adjudicated, and a loud failure is the point.
 * @param {string} body - the `onPointerLeave` arrow body (code-only).
 * @param {string | null} armName - identifier from {@link pointerGraceArmName}.
 * @returns {{ racy: boolean, detail: string }} verdict + human-readable detail.
 */
export function racyGraceArmShape(body, armName) {
  if (armName === null) {
    return {
      racy: false,
      detail: '找不到 usePointerGrace 的 arm 绑定（hook 已移除/改名），'
        + '无法证明宽限关闭仍由该 arm 触发',
    }
  }
  const occurrences = [...body.matchAll(new RegExp(`\\b${escapeRegExp(armName)}\\s*\\(`, 'g'))]
    .map((match) => match.index)
  if (occurrences.length === 0) {
    return { racy: false, detail: `onPointerLeave 不再调用宽限 arm ${armName}()` }
  }
  const unguarded = occurrences.filter((at) => !governedByCommittedOpen(body, at))
  if (unguarded.length > 0) {
    return {
      racy: false,
      detail: `onPointerLeave 的 ${armName}() 共 ${occurrences.length} 处调用，其中 ${unguarded.length} 处不在`
        + '「已提交的 open」条件内（无条件 arm / ref / 其他标志 / 只是附近的 open 表达式）',
    }
  }
  return { racy: true, detail: `onPointerLeave 的 ${occurrences.length} 处 ${armName}() 都在已提交的 open 条件内` }
}

// ---------------------------------------------------------------------------
// Numeric constants
// ---------------------------------------------------------------------------

/**
 * Read `NAME = <decimal>` occurrences on code-only text (a sign or a comparison
 * is never read as the value). The caller must accept a UNIQUE value only: zero
 * matches and several distinct values are both drift (a decoy or a second
 * assignment must never be silently picked).
 * @param {string} code - code-only source.
 * @param {string} name - identifier to read.
 * @returns {{ value: number | null, distinct: number[], occurrences: number }} read.
 */
export function readNumericConstant(code, name) {
  // The value must be a plain decimal literal: a sign or a comparison must not
  // be read as the constant (`= -200` and `= 200n` are not the shape).
  const matches = [...code.matchAll(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(-?)(\\d+)(?![\\w.])`, 'g'))]
    .map((match) => (match[1] === '-' ? -Number.parseInt(match[2], 10) : Number.parseInt(match[2], 10)))
  const distinct = [...new Set(matches)]
  return { value: distinct.length === 1 ? distinct[0] : null, distinct, occurrences: matches.length }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

/** One-line, length-capped source excerpt for a failure message (diagnostics only). */
function excerpt(text, limit = 200) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** Message for a source the gate could not read at all. */
function unreadable(source, path) {
  return `C11 读不到 ${source} ${path}（pin 树未物化/文件被删/改名）——本门必须在冻结 pin 上判定：`
    + '先 ensure-harness-vendor（子模块物化）后重跑；若上游确实删除/改名了该文件，'
    + '按 docs/checklists/upstream-touchpoints.md §4 的登记行重审移植并同步本门'
}

/** The shared adjudication tail of every shape-drift failure. */
const RETIREMENT_TAIL = '上游可能已修掉「leave 落在 dwell→commit 窗口就残留」的竞态，移植的退役条件被触碰。'
  + '请裁决：退役移植（RowHoverCard/hover-intent 回到 vendor HoverCard，并同步 '
  + 'docs/design/06-sidebar-enhancements.md §7 与 docs/progress/STATUS.md 的偏差条），'
  + '或说明为何仍保留并更新本门与 docs/checklists/upstream-touchpoints.md §4 的登记行'

/**
 * Decide C11 for one run.
 * @param {{ upstreamHoverCard: SourceFile, upstreamPointerGrace: SourceFile, chamberHoverIntent: SourceFile }} sources
 *   the three sources; `text: null` marks an unreadable file.
 * @returns {{ ok: boolean, failures: string[], summary: string }} verdict.
 */
export function hoverPortVerdict({ upstreamHoverCard, upstreamPointerGrace, chamberHoverIntent }) {
  const failures = []
  const upstream = {
    upstreamHoverCard,
    upstreamPointerGrace,
  }
  if (upstreamHoverCard.text === null) failures.push(unreadable('上游 HoverCard', upstreamHoverCard.path))
  if (upstreamPointerGrace.text === null) failures.push(unreadable('上游 pointer-grace', upstreamPointerGrace.path))
  if (chamberHoverIntent.text === null) failures.push(unreadable('chamber hover-intent', chamberHoverIntent.path))

  // ONE code-only projection per file, used by BOTH the shape match and the
  // numeric parse: comments removed, string/template literals neutralized.
  const hoverCode = upstreamHoverCard.text === null ? null : stripComments(upstreamHoverCard.text)
  const graceCode = upstreamPointerGrace.text === null ? null : stripComments(upstreamPointerGrace.text)
  const chamberCode = chamberHoverIntent.text === null ? null : stripComments(chamberHoverIntent.text)

  // ① 竞态形状仍在：形状变了就是「上游可能已修」，必须人工裁决。
  if (hoverCode !== null) {
    const component = componentBody(hoverCode, HOVER_CARD_COMPONENT)
    if (component === null) {
      failures.push(
        `C11 上游 ${upstreamHoverCard.path} 里找不到 ${HOVER_CARD_COMPONENT} 组件体（结构漂移/改名）——`
        + `无法在组件范围内证明竞态形状仍在，按漂移处理：${RETIREMENT_TAIL}`,
      )
    } else {
      const handlers = jsxArrowHandlers(component.text, 'onPointerLeave')
      if (handlers.length === 0) {
        const rawComponent = componentBody(upstreamHoverCard.text, HOVER_CARD_COMPONENT)
        failures.push(
          `C11 上游 ${upstreamHoverCard.path} 的 ${HOVER_CARD_COMPONENT} 组件内找不到 onPointerLeave 处理器`
          + `（结构漂移）${rawComponent === null ? '' : `；组件现为：${excerpt(rawComponent.text)}`}——`
          + `无法证明竞态形状仍在，按漂移处理：${RETIREMENT_TAIL}`,
        )
      } else {
        // Every handler in the component, joined with a `;` so no guard can
        // span a boundary: the arm call must be guarded in ALL of them.
        const joined = handlers.map((handler) => handler.body).join(';')
        const shape = racyGraceArmShape(joined, pointerGraceArmName(component.text))
        if (!shape.racy) {
          const rawHandler = jsxArrowHandler(upstreamHoverCard.text ?? '', 'onPointerLeave')
          failures.push(
            `C11 上游 HoverCard 的竞态关闭形状已变：${shape.detail}（${upstreamHoverCard.path}`
            + `${rawHandler === null ? '' : `；onPointerLeave 现为：${excerpt(rawHandler.body)}`}）——${RETIREMENT_TAIL}`,
          )
        }
      }
      // ①b 竞态的另一半（OPEN 侧）：dwell 回调不得复查指针在场。只锁 CLOSE 侧
      //     会漏掉「上游在 setOpen(true) 前加 inside 复查」这一最小修复——那时
      //     onPointerLeave 一字不改，竞态其实已经没了，本门必须逼出退役裁决。
      const openShape = racyOpenPathShape(component.text)
      if (!openShape.racy) {
        failures.push(
          `C11 上游 HoverCard 的竞态 OPEN 形状已变：${openShape.detail}（${upstreamHoverCard.path}）——`
          + RETIREMENT_TAIL,
        )
      }
    }
  }

  // ② 时间常数逐值锁步：移植声称行为等价，单侧改动即漂移；取值必须唯一。
  const values = {}
  for (const pair of TIMING_PAIRS) {
    const upstreamSource = upstream[pair.upstream.source]
    const upstreamPath = upstreamSource.path
    const upstreamCode = upstreamSource === upstreamHoverCard ? hoverCode : graceCode
    const upstreamRead = upstreamCode === null
      ? { value: null, distinct: [], occurrences: 0 }
      : readNumericConstant(upstreamCode, pair.upstream.name)
    const chamberRead = chamberCode === null
      ? { value: null, distinct: [], occurrences: 0 }
      : readNumericConstant(chamberCode, pair.chamber.name)
    const upstreamValue = upstreamRead.value
    const chamberValue = chamberRead.value
    if (upstreamRead.distinct.length === 0) {
      failures.push(
        `C11 解析不到上游 ${upstreamPath} 的 ${pair.upstream.name} = <数字>（${pair.meaning}）——`
        + '形状漂移/改名：不能证明锁步即按漂移处理，核对两侧实现后更新本门与 '
        + 'docs/checklists/upstream-touchpoints.md §4 的登记行，或退役移植',
      )
    } else if (upstreamRead.distinct.length > 1) {
      failures.push(
        `C11 上游 ${upstreamPath} 的 ${pair.upstream.name} 有多个不同赋值（${upstreamRead.distinct.join(' / ')}）——`
        + '不能判定锁步（诱饵/重复赋值），按漂移处理：核对哪一处是生效值后更新本门与 '
        + 'docs/checklists/upstream-touchpoints.md §4 的登记行，或退役移植',
      )
    }
    if (chamberRead.distinct.length === 0 && chamberHoverIntent.text !== null) {
      failures.push(
        `C11 解析不到 chamber ${chamberHoverIntent.path} 的 ${pair.chamber.name} = <数字>（${pair.meaning}）——`
        + '移植的常数面改名/删除：若已退役移植，请同步移除本门与 '
        + 'docs/checklists/upstream-touchpoints.md §4 的登记行；否则恢复该导出',
      )
    } else if (chamberRead.distinct.length > 1) {
      failures.push(
        `C11 chamber ${chamberHoverIntent.path} 的 ${pair.chamber.name} 有多个不同赋值`
        + `（${chamberRead.distinct.join(' / ')}）——生效值不唯一，不能判定锁步：`
        + '只保留一个默认导出，或同步更新本门与 docs/checklists/upstream-touchpoints.md §4 的登记行',
      )
    }
    if (upstreamValue !== null && chamberValue !== null && upstreamValue !== chamberValue) {
      failures.push(
        `C11 悬停时间常数失步（${pair.meaning}）：上游 ${upstreamPath} 的 ${pair.upstream.name} = ${upstreamValue}`
        + ` != chamber ${chamberHoverIntent.path} 的 ${pair.chamber.name} = ${chamberValue}`
        + '——移植的前提是行为等价，两侧必须逐值一致：'
        + `要么把 chamber 的 ${pair.chamber.name} 对齐到上游的 ${upstreamValue}（再评估移植是否仍等价），`
        + '要么退役移植（改回 vendor HoverCard）并同步 docs/checklists/upstream-touchpoints.md §4 的登记行',
      )
    }
    values[pair.chamber.name] = { upstreamValue, chamberValue }
  }

  if (failures.length > 0) return { ok: false, failures, summary: '' }
  const grace = values.HOVER_CLOSE_GRACE_MS
  const dwell = values.HOVER_OPEN_DELAY_MS
  return {
    ok: true,
    failures: [],
    summary: '✓ C11 hover 移植保鲜: 上游竞态两侧形状仍在（OPEN: dwell 回调只 setOpen(true)、不复查指针在场；'
      + 'CLOSE: onPointerLeave 以已提交的 open 守卫宽限）'
      + `；常数锁步 grace=${grace.upstreamValue}ms dwell=${dwell.upstreamValue}ms`
      + `（${upstreamHoverCard.path} / ${upstreamPointerGrace.path} ↔ ${chamberHoverIntent.path}）`,
  }
}
