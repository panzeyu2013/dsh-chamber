/**
 * Pure verdict for the C15 hover-port gate (design 06 §7).
 *
 * WHY THIS EXISTS: the chamber sidebar draws its row hover cards with its own
 * `RowHoverCard` + client-core `src/hover-intent.ts` instead of the pinned
 * `ui-primitives` HoverCard. The vendored atom arms its grace close against the
 * last COMMITTED `open` (its `onPointerLeave` is `if (open) armClose()`), so a
 * pointerleave handled while React's commit of the dwell open is still pending
 * arms nothing and the card mounts with the pointer already gone — nothing
 * later can dismiss it. Vendor sources are read-only here, so the corrected
 * machine lives in the chamber package. That port is a DEVIATION with one
 * explicit retirement condition — "upstream fixes the race" — and before this
 * module nothing checked it. The pin's preview/inline phase machine moved the
 * open statement from `setOpen(true)` to `setPhase('open')` without
 * re-checking the pointer, so the condition is NOT met and the deviation
 * stands; the shape rules below read the phase-machine form.
 *
 * The verdict turns the condition into a machine judgment over the PINNED
 * upstream tree:
 *   1. the racy close shape is still there: in the `HoverCard` component, every
 *      call to the `usePointerGrace` arm inside an `onPointerLeave` handler is
 *      governed by a test that IS the committed `open` — exactly `open`, or an
 *      `&&` conjunction with `open` as one operand. A top-level `||` widens
 *      reachability past committed `open`, so a ref-intent repair such as
 *      `open || intentRef.current` (and the degenerate `open || true`) is a
 *      FIX, not the racy shape. One bare, ref-guarded or disjunctive occurrence
 *      means the premise may be gone and a human must adjudicate — it is NOT
 *      auto-passed;
 *   2. the racy OPEN shape is still there: the dwell timer that opens the card
 *      re-checks NOTHING about the pointer, and its callback may hold only the
 *      open call plus a `= null` cleanup of the very timer ref the dwell
 *      assignment writes (any other member write — e.g. `intentRef.current =
 *      true` — is a repair and reads as drift). The timer is identified by its
 *      `openDelayMs` delay, because the pin's phase machine also closes through
 *      the same setter (the preview fade's `setPhase('closed')`) and the
 *      code-only projection neutralizes both literals to `setPhase('')`: a
 *      shape-only match could not tell the two timers apart. The
 *      race has two ends, and the minimal upstream fix on the OPEN end —
 *      `if (!insideRef.current) return` inside the dwell callback — would leave
 *      `onPointerLeave` byte-identical, so a close-side-only gate would keep
 *      printing ✓ after the retirement condition was met. Zero dwell timers
 *      (the open path was rewritten) and several candidates are DRIFT too;
 *   3. NO post-commit dismissal outside the pinned set may appear: every
 *      `useEffect`/`useLayoutEffect`/`useInsertionEffect` callback in the
 *      component that closes or moves the phase must be one of the pinned
 *      callbacks (preview fade, owner-disable, Escape) verbatim. The
 *      commit-layer repair — record pointer presence in a ref, at module scope,
 *      or behind a helper, then dismiss from a post-commit effect — leaves BOTH
 *      pinned shapes byte-identical while the race is gone, and a rule that
 *      requires a `.current` read INSIDE the callback is trivially bypassed by
 *      moving the pointer fact out of it. The rule is therefore FAIL-CLOSED:
 *      any other dismissal-capable post-commit callback is drift — see
 *      {@link postCommitDismissalRecheck};
 *   4. the two timing constants stay in lockstep with the chamber port
 *      (upstream `POINTER_GRACE_MS` == chamber `HOVER_CLOSE_GRACE_MS`, upstream
 *      `openDelayMs` default == chamber `HOVER_OPEN_DELAY_MS`), each read from a
 *      UNIQUE assignment: zero matches and several distinct values are both
 *      hard failures, so a decoy or a second assignment can never be picked;
 *   5. any check failing is a HARD failure, so the day upstream fixes the
 *      race — from either end — the maintainer is forced to decide: retire the
 *      port or re-register the deviation, instead of discovering it by accident.
 *
 * DECOY DISCIPLINE: the shape match and the
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
  chamberHoverIntent: 'packages/dsh-chamber-client-core/src/hover-intent.ts',
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
 * ever satisfy the shape match or be read as a constant assignment. (The literal
 * neutralization is what makes the checks decoy-proof.) The regex heuristic (`/` where a value may start)
 * keeps text verbatim when no closing `/` follows before the line ends, so a
 * misdetected JSX closing tag cannot swallow the rest of its line.
 * @param {string} source - TS/TSX source text.
 * @returns {string} a code-only projection of `source`.
 *
 * 刻意不复用 `scripts/dev/test-support/source-text.ts` 的助手：本门必须能在裸 checkout
 * 独立运行，且这里需要比通用助手更强的 JSX/正则启发（见上），失败模式是「宁可保留原文」。
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
 * Split at top-level occurrences of `operator`, ignoring those nested inside
 * `()[] {}`.
 * @param {string} text - expression text.
 * @param {string} operator - `&&` or `||`.
 * @returns {string[]} one part per top-level occurrence (one part when absent).
 */
function splitTopLevel(text, operator) {
  const parts = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(' || char === '[' || char === '{') { depth += 1; continue }
    if (char === ')' || char === ']' || char === '}') { depth -= 1; continue }
    if (depth === 0 && text.startsWith(operator, index)) {
      parts.push(text.slice(start, index))
      start = index + operator.length
      index += operator.length - 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** Strip every fully enclosing parenthesis pair around an expression. */
function stripOuterParens(text) {
  let inner = text.trim()
  while (inner.startsWith('(') && matchingParen(inner, 0) === inner.length - 1) {
    inner = inner.slice(1, -1).trim()
  }
  return inner
}

/**
 * Whether a conditional test IS (or entails) the committed `open`: exactly
 * `open`, or an `&&` conjunction with `open` as one operand. Any top-level
 * `||` rejects — a disjunction can be true while committed `open` is false, so
 * `open || intentRef.current` and `open || true` are the FIX this gate must not
 * mistake for the racy shape — and so does every unrecognized spelling
 * (`!open`, `openRef.current`, `open === true`): the gate auto-passes only the
 * proven shape, everything else forces adjudication.
 */
const isCommittedOpenGuard = (text) => {
  const inner = stripOuterParens(text)
  if (inner === 'open') return true
  if (splitTopLevel(inner, '||').length > 1) return false
  const conjuncts = splitTopLevel(inner, '&&')
  return conjuncts.length > 1 && conjuncts.some((conjunct) => stripOuterParens(conjunct) === 'open')
}

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
 * after it: `if (<guard>)`, `<guard> &&`, `<guard> ?`.
 * @param {string} text - statement text ending where the call starts.
 * @returns {boolean} true when the call's test IS/entails the committed `open`
 *   (see {@link isCommittedOpenGuard}); `||` disjunctions reject.
 */
function regionGuardsOpen(text) {
  const tail = text.replace(/\s+$/, '')
  const ifPattern = /(?:^|[^\w$])if\s*\(/g
  let lastIf = null
  for (let match = ifPattern.exec(tail); match !== null; match = ifPattern.exec(tail)) lastIf = match
  if (lastIf !== null) {
    const open = lastIf.index + lastIf[0].lastIndexOf('(')
    const close = matchingParen(tail, open)
    if (close !== -1 && /^[{(\s]*$/.test(tail.slice(close + 1))
      && isCommittedOpenGuard(tail.slice(open + 1, close))) {
      return true
    }
  }
  const andAt = tail.lastIndexOf('&&')
  if (andAt !== -1 && /^[(\s]*$/.test(tail.slice(andAt + 2)) && isCommittedOpenGuard(tail.slice(0, andAt))) return true
  const questionAt = lastTernaryQuestion(tail)
  if (questionAt !== -1 && /^[(\s]*$/.test(tail.slice(questionAt + 1))
    && isCommittedOpenGuard(tail.slice(0, questionAt))) {
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
 * The dwell callback may contain exactly two kinds of statement: opening the
 * card, and a `= null` cleanup of the very timer ref the dwell assignment
 * writes (`timerRef.current = setTimeout(…)` → `timerRef.current = null`).
 * Anything else is drift.
 *
 * The cleanup arm is keyed to the ASSIGNMENT TARGET, never to "any member
 * write": a repair such as `intentRef.current = true` is a member write too,
 * and admitting every `x.y = …` would let the open-side fix through as the racy
 * shape. `= null` only — a compound assignment (`+=`, `||=`) reads the old
 * value and is not cleanup.
 *
 * Whitelist by SHAPE, never a blacklist of presence-looking words.
 * A word blacklist is wrong in both directions:
 *   · it misfires — `if (!mountedRef.current) return` is the commonest React
 *     unmount guard and has nothing to do with the pointer, yet a word blacklist
 *     reports it as "upstream may have fixed the race";
 *   · it leaks — `isPointerOnAnchor`, `anchorContainsPointer`, `pointerState.on`
 *     name the very check this gate hunts for and match no word on any list.
 * Classifying shape and reporting NEUTRALLY is the only version that is neither
 * false nor silent: the gate cannot distinguish "upstream fixed the race" from
 * "the callback grew a statement", so it says precisely that and hands the
 * adjudication to a human (the failure tail spells out both outcomes).
 */
const OPEN_CALL = /^setPhase\s*\(\s*''\s*\)$/

/** The member path of a `= null` cleanup, whitespace-normalized. */
const cleanupWriteOf = (timerRef) => (timerRef === null ? null : `${timerRef}=null`)

/**
 * Top-level statements of an arrow/function callback body (nesting-aware `;`
 * split, braces unwrapped, expression bodies kept whole).
 * @param {string} callback - the timer's first-argument region (code-only).
 * @returns {string[]} trimmed, non-empty statements.
 */
export function callbackStatements(callback) {
  const text = callback.trim()
  const arrow = text.indexOf('=>')
  let body
  if (arrow !== -1) {
    body = text.slice(arrow + 2).trim()
  } else {
    const brace = text.indexOf('{')
    body = brace === -1 ? text : text.slice(brace)
  }
  if (body.startsWith('{')) {
    const end = matchingBrace(body, 0)
    body = end === -1 ? body.slice(1) : body.slice(1, end)
  }
  const statements = []
  let depth = 0
  let start = 0
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (char === ';' && depth === 0) {
      statements.push(body.slice(start, index).trim())
      start = index + 1
    }
  }
  statements.push(body.slice(start).trim())
  return statements.filter((statement) => statement !== '')
}

/**
 * Whether a dwell callback contains a statement the port cannot account for.
 * The only admitted cleanup is a `= null` write to `timerRef` (the LHS the
 * dwell `setTimeout` is assigned to); with an unknown target this defaults to
 * null, which admits no write at all — fail-closed.
 * @param {string} callback - the timer's first-argument region (code-only).
 * @param {string | null} [timerRef] - member path from {@link dwellOpenTimers}.
 * @returns {{ drift: boolean, statement: string, detail: string }}
 */
export function openCallbackDrift(callback, timerRef = null) {
  const statements = callbackStatements(callback)
  if (statements.length === 0) return { drift: true, statement: '', detail: 'dwell 回调体为空' }
  const cleanup = cleanupWriteOf(timerRef)
  for (const statement of statements) {
    if (OPEN_CALL.test(statement)) continue
    if (cleanup !== null && statement.replace(/\s+/g, '') === cleanup) continue
    return { drift: true, statement, detail: `回调里多出了「${statement}」` }
  }
  return { drift: false, statement: '', detail: '' }
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
 * The member path a `setTimeout(` at `at` is assigned to — `timerRef.current`
 * in `timerRef.current = setTimeout(…)` — or null when the call is not the
 * right-hand side of a plain member assignment. Whitespace is normalized away so
 * the path can be compared against a callback statement.
 * @param {string} code - the `HoverCard` component body (code-only).
 * @param {number} at - index of the `setTimeout` token.
 * @returns {string | null} the assignment target, or null when unknown.
 */
function assignedTimerRef(code, at) {
  const match = /((?:this|[A-Za-z_$][\w$]*)(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*=\s*$/.exec(code.slice(0, at))
  return match === null ? null : match[1].replace(/\s+/g, '')
}

/**
 * Every `setTimeout(` call in `code` that IS the dwell timer — the one delayed
 * by the `openDelayMs` prop — as `{ at, callback, timerRef }` (callback = the
 * first-argument region, timerRef = the member path the call is assigned to).
 * The delay names the timer: the pin also closes through `setPhase('closed')` on
 * the preview fade, whose code-only projection is the same `setPhase('')` as the
 * dwell's open call, so a callback-shape match would read two candidates.
 * Selection is semantic, not positional, so reformatting is tolerated while a
 * rewritten open path (or a decoy timer) is not.
 * @param {string} code - the `HoverCard` component body (code-only).
 * @returns {{ at: number, callback: string, timerRef: string | null }[]} the dwell
 *   timers found.
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
    if (comma === -1) continue
    const rest = args.slice(comma + 1)
    const delayComma = topLevelComma(rest)
    const delay = (delayComma === -1 ? rest : rest.slice(0, delayComma)).trim()
    if (delay === 'openDelayMs') {
      found.push({ at: match.index, callback: args.slice(0, comma), timerRef: assignedTimerRef(code, match.index) })
    }
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
 * The same goes for a callback that has grown beyond "open the card (+ clean up
 * its own timer ref)": the verdict says only that the shape moved, never which
 * of the two it was.
 * @param {string} component - the `HoverCard` component body (code-only).
 * @returns {{ racy: boolean, detail: string }} verdict + human-readable detail.
 */
export function racyOpenPathShape(component) {
  const timers = dwellOpenTimers(component)
  if (timers.length === 0) {
    return {
      racy: false,
      detail: "找不到「openDelayMs dwell 定时器里 setPhase('open')」这一 OPEN 路径（已改写/移除）",
    }
  }
  if (timers.length > 1) {
    return {
      racy: false,
      detail: `有 ${timers.length} 处以 openDelayMs 为延迟的 setTimeout 会开卡，生效点不唯一`,
    }
  }
  const drift = openCallbackDrift(timers[0].callback, timers[0].timerRef)
  if (drift.drift) {
    return {
      racy: false,
      detail: `${drift.detail}——本门只能按形状判定，无法区分「上游已在 dwell 触发时复查指针在场`
        + '（竞态确已修）」与「回调只是长了一句（竞态仍在）」，故不自动放行：请贴回调原文人工裁决',
    }
  }
  return {
    racy: true,
    detail: "dwell 回调只 setPhase('open')（至多把该定时器赋值的 timer ref 清成 null），OPEN 侧未复查指针在场",
  }
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
// Post-commit dismissal re-check — the third repair shape
// ---------------------------------------------------------------------------

/** The post-commit hook calls a repair can hide behind. */
const POST_COMMIT_HOOKS = [`useEffect`, `useLayoutEffect`, `useInsertionEffect`]

/** Read one `.current` ref token out of `text` (diagnostics + presence only). */
const REF_READ = /[A-Za-z_$][\w$]*\s*\.\s*current\b/

/**
 * First-argument region of every post-commit hook call in `code`
 * (`useEffect(…)` / `useLayoutEffect(…)` / `useInsertionEffect(…)`).
 * @param {string} code - the `HoverCard` component body (code-only).
 * @returns {string[]} one region per call (empty when the component has none).
 */
export function postCommitCallbacks(code) {
  const found = []
  for (const hook of POST_COMMIT_HOOKS) {
    const pattern = new RegExp(`\\b${hook}\\s*\\(`, 'g')
    for (let match = pattern.exec(code); match !== null; match = pattern.exec(code)) {
      const open = match.index + match[0].length - 1
      const close = matchingParen(code, open)
      if (close === -1) continue
      found.push(code.slice(open + 1, close))
      pattern.lastIndex = close + 1
    }
  }
  return found
}

/**
 * The post-commit dismissal callbacks pinned in the frozen HoverCard, as
 * whitespace-normalized code-only first-argument regions (the FULL argument
 * list, deps array included; the code-only projection neutralizes every string
 * literal, so 'preview'/'Escape' read as ''). These are the ONLY
 * dismissal-capable post-commit callbacks the gate admits — preview fade,
 * owner-disable, Escape. A pin upgrade that reformats or rewrites one reddens
 * the gate with the drift message and forces re-adjudication; the list must
 * only ever be regenerated from the PINNED source, never widened to admit a new
 * shape (that would restore the fail-open hole this list closes).
 */
export const PINNED_POST_COMMIT_DISMISSALS = [
  // Preview fade: closing -> closed through a nested timer.
  "() => { if (!closing) return const timer = setTimeout(() => { setPhase('') }, PREVIEW_FADE_MS) return () => { clearTimeout(timer) } }, [closing]",
  // Owner disabling mid-hover (menu opened, drag started).
  '() => { if (!disabled) return clearTimer() cancelClose() close() }, [disabled, cancelClose, close]',
  // Escape keydown: the dismissal rides a nested keydown listener.
  "() => { if (!open || (variant !== '' && !inline)) return const dismiss = (event: KeyboardEvent): void => { if (event.key !== '') return if (inline) event.stopPropagation() clearTimer() cancelClose() close() } window.addEventListener('', dismiss, inline) return () => { window.removeEventListener('', dismiss, inline) } }, [open, variant, inline, cancelClose, close]",
]

/**
 * Whether a POST-COMMIT callback performs a dismissal/phase action outside the
 * pinned set — the commit-layer repair the CLOSE/OPEN shapes cannot see. The
 * upstream fix this catches keeps onPointerLeave byte-identical and the dwell
 * callback unchanged: it records pointer presence (in a ref, at module scope, or
 * behind a helper) and adds a post-commit effect that closes when the pointer is
 * gone, so both pinned shapes still read as "race present" while the race is
 * gone.
 *
 * FAIL-CLOSED: every callback that mentions a dismissal token (close(,
 * setPhase(''), the grace arm) must be one of
 * {@link PINNED_POST_COMMIT_DISMISSALS} VERBATIM ({@link postCommitCallbacks}
 * returns the whole argument list, deps included). The previous rule required a
 * literal .current read inside the callback, so moving the pointer fact to
 * module scope or behind a helper defeated it; here the drift is the dismissal
 * itself. The pinned dismissal callbacks that do NOT read pointer state
 * (owner-disable, Escape) are admitted by the whitelist; ref bookkeeping that
 * never dismisses is not this shape and stays green.
 * @param {string} component - the HoverCard component body (code-only).
 * @param {string | null} armName - identifier from {@link pointerGraceArmName}.
 * @returns {{ recheck: boolean, detail: string }} verdict + human-readable detail.
 */
export function postCommitDismissalRecheck(component, armName) {
  const dismissalTokens = ["close(", "setPhase('')"]
  if (armName !== null) dismissalTokens.push(armName + '(')
  for (const callback of postCommitCallbacks(component)) {
    if (!dismissalTokens.some((token) => callback.includes(token))) continue
    if (PINNED_POST_COMMIT_DISMISSALS.includes(callback.replace(/\s+/g, ' ').trim())) continue
    const ref = REF_READ.exec(callback)
    return {
      recheck: true,
      detail: 'post-commit 回调（' + excerpt(callback) + '）' + (ref === null
        ? '执行了关闭/相位动作，且不是白名单化的 pinned 形状'
        : '里读 ' + ref[0].replace(/\s+/g, '') + ' 的同时执行了关闭/相位动作，且不是白名单化的 pinned 形状'),
    }
  }
  return { recheck: false, detail: '' }
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
  return `C15 读不到 ${source} ${path}（pin 树未物化/文件被删/改名）——本门必须在冻结 pin 上判定：`
    + '先 ensure-harness-vendor（子模块物化）后重跑；若上游确实删除/改名了该文件，'
    + '按 docs/checklists/upstream-touchpoints.md §4 的登记行重审移植并同步本门'
}

/** The shared adjudication tail of every shape-drift failure. */
const RETIREMENT_TAIL = '上游可能已修掉「leave 落在 dwell→commit 窗口就残留」的竞态，移植的退役条件被触碰。'
  + '请裁决：退役移植（RowHoverCard/hover-intent 回到 vendor HoverCard，并同步 '
  + 'docs/design/06-sidebar-enhancements.md §7 与 docs/progress/STATUS.md 的偏差条），'
  + '或说明为何仍保留并更新本门与 docs/checklists/upstream-touchpoints.md §4 的登记行'

/**
 * Decide C15 for one run.
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
        `C15 上游 ${upstreamHoverCard.path} 里找不到 ${HOVER_CARD_COMPONENT} 组件体（结构漂移/改名）——`
        + `无法在组件范围内证明竞态形状仍在，按漂移处理：${RETIREMENT_TAIL}`,
      )
    } else {
      const handlers = jsxArrowHandlers(component.text, 'onPointerLeave')
      if (handlers.length === 0) {
        const rawComponent = componentBody(upstreamHoverCard.text, HOVER_CARD_COMPONENT)
        failures.push(
          `C15 上游 ${upstreamHoverCard.path} 的 ${HOVER_CARD_COMPONENT} 组件内找不到 onPointerLeave 处理器`
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
            `C15 上游 HoverCard 的竞态关闭形状已变：${shape.detail}（${upstreamHoverCard.path}`
            + `${rawHandler === null ? '' : `；onPointerLeave 现为：${excerpt(rawHandler.body)}`}）——${RETIREMENT_TAIL}`,
          )
        }
      }
      // ①b 竞态的另一半（OPEN 侧）：dwell 回调不得复查指针在场。只锁 CLOSE 侧
      //     会漏掉「上游在 setPhase('open') 前加 inside 复查」这一最小修复——那时
      //     onPointerLeave 一字不改，竞态其实已经没了，本门必须逼出退役裁决。
      const openShape = racyOpenPathShape(component.text)
      if (!openShape.racy) {
        failures.push(
          `C15 上游 HoverCard 的竞态 OPEN 形状已变：${openShape.detail}（${upstreamHoverCard.path}）——`
          + RETIREMENT_TAIL,
        )
      }
      // ①c 第三类修复：post-commit（useEffect 等提交后）执行关闭/相位动作。fail-closed：
      //     白名单化 pinned 形状之外的任何 dismiss 回调都判漂移——把指针事实挪到 ref
      //     之外（模块作用域/helper）无法绕过；这类修复既不动 ① 的 CLOSE 形状、也不动
      //     ①b 的 dwell 回调，必须单独判，交人工裁决。
      const postCommit = postCommitDismissalRecheck(component.text, pointerGraceArmName(component.text))
      if (postCommit.recheck) {
        failures.push(
          'C15 上游 HoverCard 出现白名单外的 post-commit 关闭/相位回调：' + postCommit.detail + '（' + upstreamHoverCard.path + '）——'
          + '任何提交后（useEffect/useLayoutEffect/useInsertionEffect）执行 close()/setPhase 关闭/宽限 arm 的回调'
          + '都可能是「把指针在场事实放到 ref/模块作用域/helper 后复查」的竞态修复；被钉的 CLOSE/OPEN 两侧都能一字不改，'
          + '本门对非白名单化 pinned 形状一律按漂移处理、无法区分修复与无关守卫，故不自动放行：请贴 effect 原文人工裁决。'
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
        `C15 解析不到上游 ${upstreamPath} 的 ${pair.upstream.name} = <数字>（${pair.meaning}）——`
        + '形状漂移/改名：不能证明锁步即按漂移处理，核对两侧实现后更新本门与 '
        + 'docs/checklists/upstream-touchpoints.md §4 的登记行，或退役移植',
      )
    } else if (upstreamRead.distinct.length > 1) {
      failures.push(
        `C15 上游 ${upstreamPath} 的 ${pair.upstream.name} 有多个不同赋值（${upstreamRead.distinct.join(' / ')}）——`
        + '不能判定锁步（诱饵/重复赋值），按漂移处理：核对哪一处是生效值后更新本门与 '
        + 'docs/checklists/upstream-touchpoints.md §4 的登记行，或退役移植',
      )
    }
    if (chamberRead.distinct.length === 0 && chamberHoverIntent.text !== null) {
      failures.push(
        `C15 解析不到 chamber ${chamberHoverIntent.path} 的 ${pair.chamber.name} = <数字>（${pair.meaning}）——`
        + '移植的常数面改名/删除：若已退役移植，请同步移除本门与 '
        + 'docs/checklists/upstream-touchpoints.md §4 的登记行；否则恢复该导出',
      )
    } else if (chamberRead.distinct.length > 1) {
      failures.push(
        `C15 chamber ${chamberHoverIntent.path} 的 ${pair.chamber.name} 有多个不同赋值`
        + `（${chamberRead.distinct.join(' / ')}）——生效值不唯一，不能判定锁步：`
        + '只保留一个默认导出，或同步更新本门与 docs/checklists/upstream-touchpoints.md §4 的登记行',
      )
    }
    if (upstreamValue !== null && chamberValue !== null && upstreamValue !== chamberValue) {
      failures.push(
        `C15 悬停时间常数失步（${pair.meaning}）：上游 ${upstreamPath} 的 ${pair.upstream.name} = ${upstreamValue}`
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
    summary: "✓ C15 hover 移植保鲜: 上游竞态两侧形状仍在（OPEN: openDelayMs dwell 回调只 setPhase('open')"
      + "（至多把该 timer ref 清成 null）、不复查指针在场；"
      + 'CLOSE: onPointerLeave 的 arm 只在直接/合取含已提交 open 的守卫内、不接受 || 析取；'
      + 'post-commit: 组件体内无白名单外的关闭/相位回调）'
      + `；常数锁步 grace=${grace.upstreamValue}ms dwell=${dwell.upstreamValue}ms`
      + `（${upstreamHoverCard.path} / ${upstreamPointerGrace.path} ↔ ${chamberHoverIntent.path}）`,
  }
}
