/**
 * verify-upstream-touchpoints.mjs sibling tests.
 *
 * Three parts, because they answer three different questions:
 *   0. PURE: `parseVerifyArgs` pins the accepted surface and every rejection
 *      reason (the gate script itself is a top-level program — importing it
 *      would run C1/C3–C15, so the decision logic lives in its own module, the
 *      same split artifact-gate.mjs uses).
 *   1. WIRING (subprocess): the script must actually consult the guard BEFORE
 *      any gate runs. That matters more than the parse result: the default mode
 *      rebuilds and restores the committed artifacts in place, so a silently
 *      ignored argument means a full write pass the caller never asked for. The
 *      regression therefore also asserts that a usage error leaves an artifact's
 *      mtime untouched and prints no gate marker.
 *   2. PURE: the C15 hover-port verdict (`verify-upstream-touchpoints-hover.mjs`)
 *      — the machine judgment behind the "upstream fixes the race ⇒ retire the
 *      port" deviation. It rides this file, not a new one, because
 *      `package.json`'s `test:upgrade-tools` names its test files explicitly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USAGE_EXIT_CODE, VERIFY_USAGE, parseVerifyArgs } from './verify-upstream-touchpoints-args.mjs'
import {
  callbackStatements, componentBody, dwellOpenTimers, hoverPortVerdict, openCallbackDrift,
  racyGraceArmShape, racyOpenPathShape,
  stripComments,
} from './verify-upstream-touchpoints-hover.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'verify-upstream-touchpoints.mjs')
/** Any committed artifact C8 rewrites in default mode (witness for "no write"). */
const witnessArtifact = join(here, '..', '..', 'packages', 'dsh-runtime', 'dist', 'index.js')

const run = (...argv) => spawnSync(process.execPath, [scriptPath, ...argv], {
  cwd: join(here, '..', '..'),
  encoding: 'utf8',
})

test('no arguments means the documented default run (no help, no usage error)', () => {
  assert.deepEqual(parseVerifyArgs([]), { help: false, noArtifactRebuild: false, tags: null, errors: [] })
})

test('--no-artifact-rebuild is accepted in either position and never duplicated', () => {
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuild']), {
    help: false, noArtifactRebuild: true, tags: null, errors: [],
  })
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuild', '--tags', 'v1', 'v2']), {
    help: false, noArtifactRebuild: true, tags: ['v1', 'v2'], errors: [],
  })
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuild', '--no-artifact-rebuild']).errors, [
    '重复的 --no-artifact-rebuild（第 2 个参数）',
  ])
})

test('--tags requires exactly two tag values', () => {
  // 夹具用中性 tag：写死历史 dsh pin 会让 §5 的旧 pin 残留扫描每次发布都报一条。
  assert.deepEqual(parseVerifyArgs(['--tags', 'v9.9.9-rc.7', 'v9.9.9-rc.8']).tags, ['v9.9.9-rc.7', 'v9.9.9-rc.8'])
  // A missing/flag-looking value used to fall through to a silent full run.
  assert.match(parseVerifyArgs(['--tags', 'v1']).errors.join('\n'), /--tags 需要恰好两个 tag 值/)
  assert.match(parseVerifyArgs(['--tags']).errors.join('\n'), /--tags 需要恰好两个 tag 值（得到 无）/)
  assert.match(parseVerifyArgs(['--tags', '--no-artifact-rebuild']).errors.join('\n'), /--tags 需要恰好两个 tag 值/)
  assert.match(parseVerifyArgs(['--tags', 'a', 'b', 'c']).errors.join('\n'), /不接受位置参数 c/)
  assert.match(parseVerifyArgs(['--tags', 'a', 'b', '--tags', 'c', 'd']).errors.join('\n'), /重复的 --tags/)
})

test('every unrecognized argument is an error — a typo can never be ignored', () => {
  // The near-miss that motivated the guard: one missing letter in the only
  // flag that suppresses the in-place artifact rebuild.
  assert.deepEqual(parseVerifyArgs(['--no-artifact-rebuid']).errors, [
    '未知参数 --no-artifact-rebuid（已知：--no-artifact-rebuild, --tags, --help, -h）',
  ])
  for (const argument of ['--tag', '--tags=v1', '--verbose', '-x', '--']) {
    assert.match(parseVerifyArgs([argument]).errors.join('\n'), /未知参数/, `${argument} must be rejected`)
  }
  assert.match(parseVerifyArgs(['run']).errors.join('\n'), /不接受位置参数 run/)
})

test('--help wins over everything else and is the only zero-error early exit', () => {
  assert.equal(parseVerifyArgs(['--help']).help, true)
  assert.equal(parseVerifyArgs(['-h']).help, true)
  assert.equal(parseVerifyArgs(['--help', '--no-artifact-rebuild']).help, true)
  const withTypo = parseVerifyArgs(['--help', '--nope'])
  assert.equal(withTypo.help, true)
  assert.deepEqual(withTypo.errors, [], 'help short-circuits before validation, like every standard CLI')
  assert.equal(parseVerifyArgs(['--no-artifact-rebuild']).help, false)
})

test('usage text documents every accepted flag and both exit codes', () => {
  for (const fragment of ['--no-artifact-rebuild', '--tags <old> <new>', '--help, -h', '退出码', '就地重建']) {
    assert.ok(VERIFY_USAGE.includes(fragment), `usage text must document ${fragment}`)
  }
  assert.equal(USAGE_EXIT_CODE, 2)
  assert.equal(VERIFY_USAGE.startsWith('verify-upstream-touchpoints'), true)
})

test('the script exits 2 on an unknown argument without running a single gate or writing an artifact', () => {
  const before = statSync(witnessArtifact).mtimeMs
  const result = run('--no-artifact-rebuid')
  assert.equal(result.status, USAGE_EXIT_CODE, `unknown argument must exit ${USAGE_EXIT_CODE} (got ${result.status})`)
  assert.match(result.stderr, /未知参数 --no-artifact-rebuid/)
  assert.match(result.stderr, /--no-artifact-rebuild/)
  assert.doesNotMatch(result.stdout, /[✓] C\d/, 'no gate may run before the guard')
  assert.doesNotMatch(result.stdout, /C8/, 'the in-place artifact rebuild must never start for a usage error')
  assert.equal(statSync(witnessArtifact).mtimeMs, before, 'a usage error must not touch any artifact')
})

test('--help prints the usage text, runs no gate and exits 0', () => {
  const before = statSync(witnessArtifact).mtimeMs
  const result = run('--help')
  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes(VERIFY_USAGE), '--help must print the module\'s single usage text')
  assert.doesNotMatch(result.stdout, /[✓] C\d/, '--help must short-circuit before the gates')
  assert.doesNotMatch(result.stdout, /C8 提交态生成物/, '--help must never reach the rebuild gate')
  assert.equal(statSync(witnessArtifact).mtimeMs, before, '--help must not touch any artifact')
})

/** Argument text of every `await import(...)` call in a source file (balanced-paren scan). */
function dynamicImportArguments(source) {
  const args = []
  const marker = 'await import('
  let from = 0
  for (;;) {
    const at = source.indexOf(marker, from)
    if (at === -1) return args
    let depth = 1
    let i = at + marker.length
    const start = i
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') depth -= 1
      i += 1
    }
    args.push(source.slice(start, i - 1))
    from = i
  }
}

test('every dynamic import in the gate goes through pathToFileURL (Windows ESM scheme trap)', () => {
  // Regression lock for the test-windows leg: Node's ESM loader accepts only
  // file:/data:/node: URLs, so `import(join(ROOT, 'x.mjs'))` reads a Windows
  // absolute path as the scheme 'd:' and the gate dies instantly with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME — while staying green on every POSIX leg
  // (2026-09-11 CI: C1/C3/C4 green, then the C4 assembly-contract import).
  const args = dynamicImportArguments(readFileSync(scriptPath, 'utf8'))
  assert.ok(args.length >= 3, `expected the gate's dynamic imports, found ${args.length}`)
  for (const argument of args) {
    assert.match(
      argument,
      /pathToFileURL\(/,
      `a dynamic import must not take a raw path (import(${argument.trim().replace(/\s+/g, ' ')})）`,
    )
  }
})

// ---------------------------------------------------------------------------
// C15 — hover-port verdict (pure). Second pure half, same rationale as above:
// the gate script is a top-level program, so the decision logic lives in
// `verify-upstream-touchpoints-hover.mjs`. The coverage rides THIS file on
// purpose — `package.json`'s `test:upgrade-tools` lists its test files
// explicitly, and a new `*.test.mjs` would not run in CI without an edit
// outside this change's file ownership.
// ---------------------------------------------------------------------------

/** Upstream atom as pinned: the grace arm is guarded by the committed `open`. */
const PINNED_HOVER_CARD = `import { usePointerGrace } from './pointer-grace.ts'
export function HoverCard({ anchor, openDelayMs = 500 }) {
  const [open, setOpen] = useState(false)
  const { arm: armClose, cancel: cancelClose } = usePointerGrace(close)
  return (
    <span
      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => { setOpen(true) }, openDelayMs)
      }}
      onPointerLeave={() => {
        clearTimer()
        // Leaving a closed card schedules a no-op close; only arm while
        // open, matching Menu's shape.
        if (open) armClose()
      }}
    >
      {anchor}
    </span>
  )
}
`

/**
 * The pin's real `pointer-grace.ts`, verbatim (the whole file, from
 * `harness.commit`; sha256 cba1529e052cf3ea09fd3851990219e2b80d61fa4b3d35da490f28ba9f9965c6).
 * C15 reads `POINTER_GRACE_MS` from exactly this text, so the constants side of
 * the fixture IS the pinned file.
 */
const PINNED_POINTER_GRACE = `import { useCallback, useEffect, useRef } from 'react'

/**
 * Grace before a pointer-dismissed popup closes. Covers the anchor->popup gap
 * (8px for HoverCard, 4px for Menu) at a hand's travel speed without leaving a
 * popup lingering once the pointer has genuinely moved on.
 */
export const POINTER_GRACE_MS = 200

/** Cancelable delayed close for a pointer-dismissed popup. */
export interface PointerGrace {
  /** Schedule the close {@link POINTER_GRACE_MS} from now, replacing any pending one. */
  arm: () => void
  /** Abort a pending close (the pointer came back). */
  cancel: () => void
}

/**
 * Delay a pointer-dismissed popup's close so the pointer can cross the gap
 * between anchor and popup. A pending close is dropped on unmount.
 * @param close - runs when the grace elapses with no re-entry; read at fire
 * time, so callers may pass a fresh closure each render.
 * @returns the {@link PointerGrace} handle.
 */
export function usePointerGrace(close: () => void): PointerGrace {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeRef = useRef(close)
  closeRef.current = close

  const cancel = useCallback(() => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const arm = useCallback(() => {
    cancel()
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      closeRef.current()
    }, POINTER_GRACE_MS)
  }, [cancel])

  useEffect(() => cancel, [cancel])

  return { arm, cancel }
}
`

/**
 * The pin's real `onPointerLeave` attribute, verbatim (comments included) — the
 * exact text C15's shape rule has to read. Mutants below are built by replacing
 * `if (open) armClose()` inside it.
 */
const PINNED_ON_POINTER_LEAVE = `      onPointerLeave={() => {
        clearTimer()
        // Leaving a closed card schedules a no-op close; only arm while
        // open, matching Menu's shape.
        if (open) armClose()
      }}`

/** The fixture card with its real close handler replaced (mutant helper). */
const withHandler = (handler) => PINNED_HOVER_CARD.replace(PINNED_ON_POINTER_LEAVE, handler)

/**
 * The pin's real `onPointerEnter` attribute, verbatim — the OPEN half of the
 * race (dwell timer → `setOpen(true)`, with no pointer re-check). Mutants below
 * replace it whole: the gate's OPEN rule reads this region, and it is the region
 * an upstream fix from that side would have to touch.
 */
const PINNED_ON_POINTER_ENTER = `      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => { setOpen(true) }, openDelayMs)
      }}`

/** The fixture card with its real enter handler replaced (mutant helper). */
const withEnter = (handler) => PINNED_HOVER_CARD.replace(PINNED_ON_POINTER_ENTER, handler)

const CHAMBER_HOVER_INTENT = `export const HOVER_OPEN_DELAY_MS = 500
/** Grace after the pointer leaves… */
export const HOVER_CLOSE_GRACE_MS = 200
`

/** The three sources the gate hands to the verdict, with per-test overrides. */
const hoverSources = (overrides = {}) => ({
  upstreamHoverCard: { path: 'up/HoverCard.tsx', text: PINNED_HOVER_CARD },
  upstreamPointerGrace: { path: 'up/pointer-grace.ts', text: PINNED_POINTER_GRACE },
  chamberHoverIntent: { path: 'chamber/hover-intent.ts', text: CHAMBER_HOVER_INTENT },
  ...overrides,
})

test('C15: the pinned racy shape passes and the locked timings are reported', () => {
  const verdict = hoverPortVerdict(hoverSources())
  assert.equal(verdict.ok, true, verdict.failures.join('\n'))
  assert.match(verdict.summary, /竞态两侧形状仍在/)
  assert.match(verdict.summary, /grace=200ms dwell=500ms/)
})

test('C15 (OPEN side): the dwell callback opens without re-checking the pointer', () => {
  // The pinned open path, read directly: one dwell timer, and its callback does
  // nothing but open. This is the half a close-side-only gate could not see.
  const body = componentBody(stripComments(PINNED_HOVER_CARD), 'HoverCard').text
  const timers = dwellOpenTimers(body)
  assert.equal(timers.length, 1, 'exactly one dwell timer opens the card')
  assert.match(timers[0].callback, /setOpen\(true\)/)
  assert.equal(racyOpenPathShape(body).racy, true)
  assert.deepEqual(callbackStatements(timers[0].callback), ['setOpen(true)'])
})

test('C15 (OPEN side): the callback is classified by SHAPE, so no naming scheme can slip through', () => {
  // Round-2 review F2: a word blacklist only catches the names it lists, so the
  // minimal upstream fix written as `isPointerOnAnchor` / `anchorContainsPointer`
  // / `pointerState.on` passed the gate silently while the race was already gone.
  // Statement-level classification catches every naming scheme.
  for (const guard of [
    'if (!insideRef.current) return',
    'if (!pointerInside) return',
    'if (hoveringRef.current) setOpen(true)',
    'if (!isPointerOnAnchor) return',
    'if (!anchorContainsPointer) return',
    'if (!pointerState.on) return',
    'if (!pointerIsInAnchor) return',
    'if (pointerIsOver) setOpen(true)',
  ]) {
    const text = withEnter(`      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => {
        ${guard}
        setOpen(true)
        }, openDelayMs)
      }}`)
    const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
    assert.equal(verdict.ok, false, `OPEN-side fix must not pass: ${guard}`)
    assert.match(verdict.failures.join('\n'), /竞态 OPEN 形状已变/)
    assert.match(verdict.failures.join('\n'), /退役移植/)
  }
})

test('C15 (OPEN side): an unmount guard is reported as drift with a NEUTRAL diagnosis', () => {
  // Round-2 review F1: `if (!mountedRef.current) return` is the commonest React
  // unmount guard and has nothing to do with the pointer. The gate must still
  // refuse to auto-pass it — it cannot tell it apart from a real presence check —
  // but the diagnosis may NOT assert "upstream fixed the race", because acting on
  // that claim would retire a port that is still needed.
  const text = withEnter(`      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => { if (!mountedRef.current) return; setOpen(true) }, openDelayMs)
      }}`)
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, false, 'a callback the gate cannot classify must not auto-pass')
  const detail = verdict.failures.join('\n')
  assert.match(detail, /mountedRef\.current/, 'the offending statement is quoted for the human')
  assert.match(detail, /无法区分/, 'the diagnosis states the two possibilities instead of picking one')
  assert.doesNotMatch(detail, /上游可能已从 OPEN 侧修掉竞态/,
    'the superseded diagnosis asserted a fact the gate cannot know')
})

test('C15 (OPEN side): clearing its own expired timer ref is cleanup, not a statement to adjudicate', () => {
  // An upstream refactor that nulls the expired timer ref inside the dwell
  // callback is ordinary hygiene. Failing the gate on it would push maintainers
  // to weaken the gate instead of trusting it.
  const text = withEnter(`      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => { timerRef.current = null; setOpen(true) }, openDelayMs)
      }}`)
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, true, verdict.failures.join('\n'))
})

test('C15 (OPEN side): a read-modify-write of any ref is drift, not cleanup', () => {
  // `x.current += 1` READS the old value, so it is not the pure write the
  // whitelist admits.
  const text = withEnter(`      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => { openEpochRef.current += 1; setOpen(true) }, openDelayMs)
      }}`)
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, false, 'a compound assignment must not count as cleanup')
})

test('C15 (OPEN side): the statement classifier is exact about bodies and splitting', () => {
  assert.deepEqual(callbackStatements('() => { setOpen(true) }'), ['setOpen(true)'])
  assert.deepEqual(callbackStatements('() => setOpen(true)'), ['setOpen(true)'])
  assert.deepEqual(callbackStatements('() => { timerRef.current = null; setOpen(true) }'),
    ['timerRef.current = null', 'setOpen(true)'])
  // A `;` inside a nested call is not a statement boundary.
  assert.deepEqual(callbackStatements('() => { log(a, b); setOpen(true) }'), ['log(a, b)', 'setOpen(true)'])
  assert.equal(openCallbackDrift('() => { setOpen(true) }').drift, false)
  assert.equal(openCallbackDrift('() => {}').drift, true, 'an empty callback opens nothing')
  assert.equal(openCallbackDrift('() => { if (x) setOpen(true) }').drift, true,
    'a conditional open is exactly the shape the port compensates for')
})

test('C15 (OPEN side): a comment or a string naming an inside flag cannot trip the rule', () => {
  // The mirror of the close-side decoy test: comments are stripped, so a note
  // about the guard is not the guard. A false positive here would fail the gate
  // on a cosmetic edit.
  const text = withEnter(`      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        // upstream once considered: if (!insideRef.current) return
        timerRef.current = setTimeout(() => { setOpen(true) }, openDelayMs)
      }}`)
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, true, verdict.failures.join('\n'))
})

test('C15 (OPEN side): a rewritten or ambiguous open path is drift, never a silent pass', () => {
  const rewritten = withEnter(`      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        openSoon(openDelayMs)
      }}`)
  const missing = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text: rewritten } }))
  assert.equal(missing.ok, false, 'an unlocatable open path must not read as "race still present"')
  assert.match(missing.failures.join('\n'), /竞态 OPEN 形状已变/)

  const duplicated = withEnter(`      onPointerEnter={() => {
        cancelClose()
        if (open) return
        clearTimer()
        timerRef.current = setTimeout(() => { setOpen(true) }, openDelayMs)
        otherRef.current = setTimeout(() => { setOpen(true) }, openDelayMs)
      }}`)
  const ambiguous = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text: duplicated } }))
  assert.equal(ambiguous.ok, false, 'two opening timers are ambiguous, not a pass')
  assert.match(ambiguous.failures.join('\n'), /生效点不唯一/)
})

test('C15: a guard that only exists in a comment cannot satisfy the gate', () => {
  // The shape the pin has, plus a comment claiming it — but the real handler
  // arms unconditionally. Comment stripping is what makes this fail loud.
  const text = PINNED_HOVER_CARD.replace(
    'if (open) armClose()',
    'armClose() // was: if (open) armClose()',
  )
  assert.match(text, /if \(open\) armClose\(\)/, 'fixture must keep the guard text in the comment')
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /竞态关闭形状已变/)
  assert.match(verdict.failures.join('\n'), /up\/HoverCard\.tsx/)
  assert.match(verdict.failures.join('\n'), /退役移植/)
})

test('C15: the day upstream arms on a ref (or unconditionally), the gate forces the decision', () => {
  for (const replacement of ['if (openRef.current) armClose()', 'armClose()']) {
    const text = PINNED_HOVER_CARD.replace('if (open) armClose()', replacement)
    const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
    assert.equal(verdict.ok, false, `${replacement} must not read as "race still present"`)
  }
})

test('C15: a Menu-style ternary handler is still read (and is still the racy shape)', () => {
  const text = PINNED_HOVER_CARD.replace(
    `      onPointerLeave={() => {
        clearTimer()
        // Leaving a closed card schedules a no-op close; only arm while
        // open, matching Menu's shape.
        if (open) armClose()
      }}`,
    "      onPointerLeave={closeOnPointerLeave ? () => { if (open) armClose() } : undefined}",
  )
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, true, verdict.failures.join('\n'))
})

test('C15: a one-sided timing change fails and names both sides with both values', () => {
  const upstreamDrift = hoverPortVerdict(hoverSources({
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text: 'export const POINTER_GRACE_MS = 250' },
  }))
  assert.equal(upstreamDrift.ok, false)
  const message = upstreamDrift.failures.join('\n')
  assert.match(message, /POINTER_GRACE_MS = 250/)
  assert.match(message, /HOVER_CLOSE_GRACE_MS = 200/)
  assert.match(message, /up\/pointer-grace\.ts/)
  assert.match(message, /chamber\/hover-intent\.ts/)
  assert.match(message, /退役移植/)

  const chamberDrift = hoverPortVerdict(hoverSources({
    chamberHoverIntent: { path: 'chamber/hover-intent.ts', text: 'export const HOVER_OPEN_DELAY_MS = 400\nexport const HOVER_CLOSE_GRACE_MS = 200' },
  }))
  assert.equal(chamberDrift.ok, false)
  assert.match(chamberDrift.failures.join('\n'), /openDelayMs = 500/)
  assert.match(chamberDrift.failures.join('\n'), /HOVER_OPEN_DELAY_MS = 400/)
})

test('C15: a renamed or dropped constant is a parse failure, never a silent pass', () => {
  const renamed = hoverPortVerdict(hoverSources({
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text: 'export const GRACE_MS = 200' },
  }))
  assert.equal(renamed.ok, false)
  assert.match(renamed.failures.join('\n'), /解析不到上游 up\/pointer-grace\.ts 的 POINTER_GRACE_MS/)

  const retired = hoverPortVerdict(hoverSources({
    chamberHoverIntent: { path: 'chamber/hover-intent.ts', text: 'export const HOVER_OPEN_DELAY_MS = 500' },
  }))
  assert.equal(retired.ok, false)
  assert.match(retired.failures.join('\n'), /解析不到 chamber chamber\/hover-intent\.ts 的 HOVER_CLOSE_GRACE_MS/)
})

test('C15: an unmaterialized pin tree is a hard failure, never "no race"', () => {
  const verdict = hoverPortVerdict(hoverSources({
    upstreamHoverCard: { path: 'up/HoverCard.tsx', text: null },
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text: null },
  }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /读不到 上游 HoverCard up\/HoverCard\.tsx/)
  assert.match(verdict.failures.join('\n'), /读不到 上游 pointer-grace up\/pointer-grace\.ts/)
})

test('C15: the gate actually consults the verdict on the pinned tree (wiring scan)', () => {
  // The full gate cannot run in a bare worktree (an empty `vendor/harness-checkout`
  // makes C1 throw before C15), so this scan is what proves the block is wired.
  const source = readFileSync(scriptPath, 'utf8')
  assert.match(source, /import \{ HOVER_PORT_SOURCES, hoverPortVerdict \} from '\.\/verify-upstream-touchpoints-hover\.mjs'/)
  assert.match(source, /hoverPortVerdict\(\{/)
  for (const key of ['upstreamHoverCard', 'upstreamPointerGrace', 'chamberHoverIntent']) {
    assert.match(source, new RegExp(`${key}: readSource\\(HOVER_PORT_SOURCES\\.${key}, (SUBMODULE|ROOT)\\)`))
  }
  assert.match(source, /else for \(const failure of verdict\.failures\) fail\(failure\)/)
})

// ---------------------------------------------------------------------------
// C15 adversarial-review regressions (2026-09-13): the three executed
// false-passes plus the reasoned "second component" hole. Each mutant below
// fixes the race (or moves the timing) while leaving decoy text behind; the
// hardened module must fail all of them.
// ---------------------------------------------------------------------------

test('C15 mutant (a): a decoy string cannot stand in for the missing guard', () => {
  // The race is FIXED (unconditional arm) but a log/telemetry string still
  // spells out the old shape. String literals are neutralized before matching,
  // so only the real code decides.
  const text = withHandler(`      onPointerLeave={() => {
        clearTimer()
        console.log('legacy shape: if (open) armClose()')
        armClose()
      }}`)
  assert.match(text, /'legacy shape: if \(open\) armClose\(\)'/, 'fixture must keep the decoy string')
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, false)
  const message = verdict.failures.join('\n')
  assert.match(message, /竞态关闭形状已变/)
  assert.match(message, /不在「已提交的 open」条件内/)
  assert.match(message, /退役移植/)
})

test('C15 mutant (b): an unrelated `open` expression in another statement does not guard the arm', () => {
  for (const handler of [
    // ASI form (no semicolons): the `&&` and the arm are different statements.
    `      onPointerLeave={() => {
        clearTimer()
        open && void 0
        armClose()
      }}`,
    // Explicit-statement form: identical semantics.
    '      onPointerLeave={() => { clearTimer(); open && void 0; armClose() }}',
  ]) {
    const verdict = hoverPortVerdict(hoverSources({
      upstreamHoverCard: { path: 'up/HoverCard.tsx', text: withHandler(handler) },
    }))
    assert.equal(verdict.ok, false, `${handler} must be drift`)
    assert.match(verdict.failures.join('\n'), /不在「已提交的 open」条件内/)
  }
})

test('C15 mutant (c): a decoy string cannot be read as the timing constant', () => {
  const text = `const NOTE = 'POINTER_GRACE_MS = 200'
export const POINTER_GRACE_MS = 120
`
  const verdict = hoverPortVerdict(hoverSources({
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text },
  }))
  assert.equal(verdict.ok, false)
  const message = verdict.failures.join('\n')
  assert.match(message, /悬停时间常数失步/)
  assert.match(message, /POINTER_GRACE_MS = 120/)
  assert.match(message, /HOVER_CLOSE_GRACE_MS = 200/)
  assert.doesNotMatch(message, /POINTER_GRACE_MS = 200 != /, 'the decoy value must never be compared')
})

test('C15: several distinct assignments are ambiguous — never silently one of them', () => {
  const text = 'export const POINTER_GRACE_MS = 120\nexport const POINTER_GRACE_MS = 200\n'
  const verdict = hoverPortVerdict(hoverSources({
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text },
  }))
  assert.equal(verdict.ok, false)
  const message = verdict.failures.join('\n')
  assert.match(message, /多个不同赋值（120 \/ 200）/)
  assert.match(message, /诱饵\/重复赋值/)
})

test('C15: a decoy component above HoverCard cannot supply the guarded shape', () => {
  // The shape check is scoped to the HoverCard component body, so a second
  // component carrying the old guarded handler cannot vouch for a fixed
  // HoverCard below it.
  const decoy = `function LegacyPreview({ open, armClose }) {
  return <span onPointerLeave={() => { if (open) armClose() }} />
}

`
  const fixed = withHandler(`      onPointerLeave={() => {
        clearTimer()
        armClose()
      }}`)
  const verdict = hoverPortVerdict(hoverSources({
    upstreamHoverCard: { path: 'up/HoverCard.tsx', text: decoy + fixed },
  }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /竞态关闭形状已变/)
})

test('C15: every legitimate guard form of the racy shape is still accepted', () => {
  for (const body of [
    'clearTimer(); if (open) armClose()',
    'clearTimer(); if (open) { armClose() }',
    'clearTimer(); clearTimer(); if (open && !closing) { armClose() }',
    'clearTimer(); open && armClose()',
    'clearTimer(); open ? armClose() : undefined',
  ]) {
    assert.equal(racyGraceArmShape(body, 'armClose').racy, true, body)
  }
})

test('C15: one bare occurrence among guarded ones is drift at the occurrence level', () => {
  for (const body of [
    'clearTimer(); armClose()',
    'clearTimer(); openRef.current && armClose()',
    'clearTimer(); if (open) armClose(); armClose()',
  ]) {
    assert.equal(racyGraceArmShape(body, 'armClose').racy, false, body)
  }
})

test('C15: a negated or removed guard is drift, never the known shape', () => {
  // `!open` inverts the racy intent; a removed/renamed hook leaves no proven
  // arm. Both must force the adjudication.
  for (const body of ['clearTimer(); if (!open) armClose()', 'clearTimer(); !open && armClose()']) {
    assert.equal(racyGraceArmShape(body, 'armClose').racy, false, body)
  }
  const renamedHook = PINNED_HOVER_CARD.replace(
    'usePointerGrace(close)',
    'useHoverGrace(close)',
  )
  const verdict = hoverPortVerdict(hoverSources({
    upstreamHoverCard: { path: 'up/HoverCard.tsx', text: renamedHook },
  }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /找不到 usePointerGrace 的 arm 绑定/)
})

test('C15 mutant (d): a regex-literal decoy is neutralized like any other literal', () => {
  // The arm call is gone; only a regex literal spelling the old shape remains.
  const text = withHandler(`      onPointerLeave={() => {
        clearTimer()
        const legacy = /if \\(open\\) armClose()/
        void legacy
      }}`)
  const verdict = hoverPortVerdict(hoverSources({ upstreamHoverCard: { path: 'up/HoverCard.tsx', text } }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /不再调用宽限 arm armClose\(\)/)

  const grace = 'const re = /POINTER_GRACE_MS = 200/\nexport const POINTER_GRACE_MS = 120\n'
  const drifted = hoverPortVerdict(hoverSources({
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text: grace },
  }))
  assert.equal(drifted.ok, false)
  assert.match(drifted.failures.join('\n'), /POINTER_GRACE_MS = 120/)
})

test('C15: a sign or comparison is never read as the constant value', () => {
  const negative = hoverPortVerdict(hoverSources({
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text: 'export const POINTER_GRACE_MS = -200' },
  }))
  assert.equal(negative.ok, false)
  assert.match(negative.failures.join('\n'), /POINTER_GRACE_MS = -200/)

  const comparison = hoverPortVerdict(hoverSources({
    upstreamPointerGrace: { path: 'up/pointer-grace.ts', text: 'export const POINTER_GRACE_MS === 200' },
  }))
  assert.equal(comparison.ok, false)
  assert.match(comparison.failures.join('\n'), /解析不到上游 up\/pointer-grace\.ts 的 POINTER_GRACE_MS/)
})

test('C15: calling the arm through an alias is drift too (only direct calls are proven)', () => {
  // Fail-closed: an aliased arm cannot be proven guarded, so it must force the
  // adjudication rather than pass silently.
  assert.equal(racyGraceArmShape('const a = armClose; clearTimer(); a()', 'armClose').racy, false)
})

test('C15: comments and string/template literals are neutralized before matching', () => {
  const stripped = stripComments(`const a = 'if (open) armClose()'
const b = "POINTER_GRACE_MS = 200"
const c = \`template armClose( and \${open && armClose()})\`
// POINTER_GRACE_MS = 200
/* onPointerLeave={() => armClose()} */
const d = armClose()
`)
  assert.doesNotMatch(stripped, /if \(open\) armClose\(\)/)
  assert.doesNotMatch(stripped, /POINTER_GRACE_MS/)
  assert.doesNotMatch(stripped, /onPointerLeave/)
  // Template expressions are dropped with their literal: no code leaks out.
  assert.doesNotMatch(stripped, /template armClose/)
  assert.doesNotMatch(stripped, /open && armClose/)
  assert.match(stripped, /const d = armClose\(\)/)
})

test('C15: a JSX closing tag is not mistaken for a regex (no code is swallowed)', () => {
  // Regression for the regex branch: `</span>` puts a `/` where a value may
  // start, but there is no closing `/` before the line ends — the text must be
  // kept verbatim, or the rest of the line (braces included) disappears and the
  // component body can no longer be parsed.
  const stripped = stripComments(`const x = <span>{copied ? label : content}</span>
const y = armClose()
`)
  assert.match(stripped, /\{copied \? label : content\}/)
  assert.match(stripped, /const y = armClose\(\)/)

  // A real regex literal IS neutralized.
  const regex = stripComments(`const re = /if \\(open\\) armClose()/
const z = 1
`)
  assert.doesNotMatch(regex, /armClose/)
  assert.match(regex, /const z = 1/)
})

test('C15: the component scope is extracted by balanced braces', () => {
  const code = stripComments(`function Other() { return null }
export function HoverCard({ a }: { a: string }) {
  const nested = () => { return { b: 1 } }
  return nested
}
`)
  const body = componentBody(code, 'HoverCard')
  assert.notEqual(body, null)
  assert.match(body.text, /const nested/)
  assert.doesNotMatch(body.text, /function Other/)
})
