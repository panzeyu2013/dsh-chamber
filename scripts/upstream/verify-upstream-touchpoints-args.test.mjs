// verify-upstream-touchpoints.mjs sibling tests: parse surface + guard wiring (no
// C1/C3–C16 gate or rebuild before the argument guard) + the pre-install module-graph
// lock (the entry runs before pnpm install) + the C15 hover-port verdict
// (verify-upstream-touchpoints-hover.mjs, driven by the PINNED vendor source read at
// test time and mutated in memory) + the C16 vendor-source verdict
// (verify-upstream-touchpoints-vendor.mjs); test:upgrade-tools lists its test files explicitly.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USAGE_EXIT_CODE, VERIFY_USAGE, parseVerifyArgs } from './verify-upstream-touchpoints-args.mjs'
import {
  HOVER_PORT_SOURCES, callbackStatements, componentBody, dwellOpenTimers, hoverPortVerdict,
  jsxArrowHandler, openCallbackDrift, pointerGraceArmName, postCommitCallbacks,
  postCommitDismissalRecheck, racyGraceArmShape, racyOpenPathShape, stripComments,
} from './verify-upstream-touchpoints-hover.mjs'
import {
  clauseSymbols, relativeVendorImports, sourceModuleSpecifiers, vendorSourceVerdict,
} from './verify-upstream-touchpoints-vendor.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const scriptPath = join(here, 'verify-upstream-touchpoints.mjs')
/** Any build-time artifact C8 rewrites in default mode (witness for "no write"). */
const witnessArtifact = join(here, '..', '..', 'packages', 'dsh-runtime', 'dist', 'index.js')
/** mtime when the (untracked) witness artifact exists, `null` on a clean checkout. */
const witnessMtime = () => (existsSync(witnessArtifact) ? statSync(witnessArtifact).mtimeMs : null)

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
  // A missing/flag-looking value must not fall through to a silent full run.
  assert.match(parseVerifyArgs(['--tags', 'v1']).errors.join('\n'), /--tags 需要恰好两个 tag 值/)
  assert.match(parseVerifyArgs(['--tags']).errors.join('\n'), /--tags 需要恰好两个 tag 值（得到 无）/)
  assert.match(parseVerifyArgs(['--tags', '--no-artifact-rebuild']).errors.join('\n'), /--tags 需要恰好两个 tag 值/)
  assert.match(parseVerifyArgs(['--tags', 'a', 'b', 'c']).errors.join('\n'), /不接受位置参数 c/)
  assert.match(parseVerifyArgs(['--tags', 'a', 'b', '--tags', 'c', 'd']).errors.join('\n'), /重复的 --tags/)
})

test('every unrecognized argument is an error — a typo can never be ignored', () => {
  // One missing letter in the only flag that suppresses the rebuild must be a usage error, never a silent full run.
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
  const before = witnessMtime()
  const result = run('--no-artifact-rebuid')
  assert.equal(result.status, USAGE_EXIT_CODE, `unknown argument must exit ${USAGE_EXIT_CODE} (got ${result.status})`)
  assert.match(result.stderr, /未知参数 --no-artifact-rebuid/)
  assert.match(result.stderr, /--no-artifact-rebuild/)
  assert.doesNotMatch(result.stdout, /[✓] C\d/, 'no gate may run before the guard')
  assert.doesNotMatch(result.stdout, /C8/, 'the in-place artifact rebuild must never start for a usage error')
  assert.equal(witnessMtime(), before, 'a usage error must not touch any artifact')
})

test('--help prints the usage text, runs no gate and exits 0', () => {
  const before = witnessMtime()
  const result = run('--help')
  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes(VERIFY_USAGE), '--help must print the module\'s single usage text')
  assert.doesNotMatch(result.stdout, /[✓] C\d/, '--help must short-circuit before the gates')
  assert.doesNotMatch(result.stdout, /C8 构建期生成物/, '--help must never reach the rebuild gate')
  assert.equal(witnessMtime(), before, '--help must not touch any artifact')
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
  // Windows ESM trap: Node accepts only file:/data:/node: URLs, so a raw path reads as scheme 'd:'
  // and dies with ERR_UNSUPPORTED_ESM_URL_SCHEME while every POSIX leg stays green.
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

// C15 — hover-port verdict (pure): decision logic lives in
// verify-upstream-touchpoints-hover.mjs; coverage rides THIS file because
// test:upgrade-tools lists its test files explicitly.
//
// Every fixture here is PINNED text read at test time and mutated in memory:
// vendor/harness-checkout for the two upstream files, this repo for the chamber port.
// Hand-transcribed upstream copies were retired — their only pin was a sha256 in a
// comment that nothing asserted, so a pin upgrade left them green against stale text.
// Every mutation anchor is asserted present, so a reformat of the pin fails loud.

/** Repository root. */
const ROOT = join(here, '..', '..')
/** Frozen upstream tree the two C15 upstream sources live in; absent = loud skip. */
const PIN_ROOT = join(ROOT, 'vendor', 'harness-checkout')
const pinSkip = existsSync(PIN_ROOT)
  ? false
  : 'vendor/harness-checkout 未物化（子模块缺失）：' + PIN_ROOT

/** Root each C15 source resolves against; paths come from HOVER_PORT_SOURCES, so a registry rename cannot silently pass. */
const HOVER_SOURCE_ROOT = {
  upstreamHoverCard: PIN_ROOT,
  upstreamPointerGrace: PIN_ROOT,
  chamberHoverIntent: ROOT,
}
const readHoverSource = (key) => readFileSync(join(HOVER_SOURCE_ROOT[key], HOVER_PORT_SOURCES[key]), 'utf8')
const realHoverSources = () => Object.fromEntries(Object.keys(HOVER_PORT_SOURCES)
  .map((key) => [key, { path: HOVER_PORT_SOURCES[key], text: readHoverSource(key) }]))

/** The real source set with ONE file replaced by text, every path still the real one. */
const hoverMutantSources = (key, text) => ({
  ...realHoverSources(),
  [key]: { path: HOVER_PORT_SOURCES[key], text },
})
const hoverMutant = (text) => hoverMutantSources('upstreamHoverCard', text)

/** Replace from with to exactly once; a missing anchor fails the test instead of mutating nothing. */
const replaceOnce = (text, from, to) => {
  assert.ok(text.includes(from), 'pinned anchor drifted (rebuild this fixture from the pin): ' + from)
  return text.replace(from, to)
}

/** Anchors of the pinned HoverCard.tsx every mutant keys on. */
const DWELL_TIMER = "timerRef.current = setTimeout(() => { setPhase('open') }, openDelayMs)"
const GRACE_ARM_GUARD = 'if (open) armClose()'
const GRACE_BINDING = 'const { arm: armClose, cancel: cancelClose } = usePointerGrace(close)'
const HOVER_CARD_DECLARATION = 'export function HoverCard({'
const GRACE_DECL = 'export const POINTER_GRACE_MS = 200'
const CHAMBER_OPEN_DECL = 'export const HOVER_OPEN_DELAY_MS = 500'
/** Real pinned text with one anchor replaced. */
const hoverReplace = (from, to) => replaceOnce(readHoverSource('upstreamHoverCard'), from, to)
const graceReplace = (from, to) => replaceOnce(readHoverSource('upstreamPointerGrace'), from, to)
const chamberReplace = (from, to) => replaceOnce(readHoverSource('chamberHoverIntent'), from, to)

/** Real pinned HoverCard whose dwell timer callback body is statements (OPEN-side mutants). */
const dwellMutant = (statements) => hoverReplace(DWELL_TIMER,
  'timerRef.current = setTimeout(() => { ' + statements + ' }, openDelayMs)')

/** Real pinned HoverCard with effect inserted after the grace binding; moduleScope lands before the declaration. */
const withEffect = (effect, moduleScope = '') => replaceOnce(
  replaceOnce(readHoverSource('upstreamHoverCard'), HOVER_CARD_DECLARATION, moduleScope + HOVER_CARD_DECLARATION),
  GRACE_BINDING,
  GRACE_BINDING + '\n' + effect,
)

/** Real pinned HoverCard with the whole onPointerLeave={…} attribute replaced (balanced-brace slice). */
const withLeaveHandler = (handler) => {
  const text = readHoverSource('upstreamHoverCard')
  const at = text.indexOf('onPointerLeave={')
  assert.notEqual(at, -1, 'the pinned source must still carry onPointerLeave')
  let depth = 0
  let end = -1
  for (let index = at + 'onPointerLeave='.length; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) { end = index + 1; break }
    }
  }
  assert.notEqual(end, -1, 'the pinned onPointerLeave attribute must close')
  return text.slice(0, at) + handler + text.slice(end)
}

test('C15: the pinned racy shape passes, both ends are locatable and the locked timings are reported', { skip: pinSkip }, () => {
  // The file's own PREVIEW_FADE_MS timer, template literals and module scope must not read as the OPEN path.
  const code = stripComments(readHoverSource('upstreamHoverCard'))
  assert.doesNotMatch(code, /\$\{/, 'template expressions are dropped with their literal')
  const body = componentBody(code, 'HoverCard').text
  const timers = dwellOpenTimers(body)
  assert.equal(timers.length, 1, 'the PREVIEW_FADE_MS close timer must not read as a dwell')
  assert.equal(timers[0].timerRef, 'timerRef.current', 'the assignment target is the ref whose cleanup is admissible')
  assert.deepEqual(callbackStatements(timers[0].callback), ["setPhase('')"])
  assert.equal(openCallbackDrift(timers[0].callback, timers[0].timerRef).drift, false)
  assert.equal(racyOpenPathShape(body).racy, true)
  const armName = pointerGraceArmName(body)
  assert.equal(armName, 'armClose', 'the pin aliases the hook arm; a rename must be re-adjudicated')
  const handler = jsxArrowHandler(body, 'onPointerLeave')
  assert.notEqual(handler, null, 'the pinned handler must stay locatable')
  assert.equal(racyGraceArmShape(handler.body, armName).racy, true)
  const verdict = hoverPortVerdict(realHoverSources())
  assert.equal(verdict.ok, true, verdict.failures.join('\n'))
  assert.match(verdict.summary, /竞态两侧形状仍在/)
  assert.match(verdict.summary, /grace=200ms dwell=500ms/)
})

test('C15 (CLOSE): shape-preserving guards stay green, every widened or moved guard is drift', { skip: pinSkip }, () => {
  // The statement forms carry an explicit ';' boundary here: the pin's own layout relies on
  // ASI, which the gate reads fail-closed, so the boundary is what the admission rule is
  // tested against (the ASI spelling is covered as drift by the bare-guard mutant below).
  for (const guard of [
    'if (open) { armClose() }',
    'if (open && !closing) { armClose() }',
    '; open && armClose()',
    '; open ? armClose() : undefined',
  ]) {
    const verdict = hoverPortVerdict(hoverMutant(hoverReplace(GRACE_ARM_GUARD, guard)))
    assert.equal(verdict.ok, true, guard + ': ' + verdict.failures.join('\n'))
  }
  let drift = ''
  for (const guard of [
    'armClose() // was: if (open) armClose()',
    'armClose()',
    'if (openRef.current) armClose()',
    'if (!open) armClose()',
    'if (open || intentRef.current) armClose()',
    'if (open || true) armClose()',
    'const a = armClose; a()',
    "open && void 0\n        armClose()",
    "console.log('legacy shape: if (open) armClose()')\n        armClose()",
    'const legacy = /if \\(open\\) armClose()/\n        void legacy',
  ]) {
    const verdict = hoverPortVerdict(hoverMutant(hoverReplace(GRACE_ARM_GUARD, guard)))
    assert.equal(verdict.ok, false, guard + ' must be red')
    drift = verdict.failures.join('\n')
    assert.match(drift, /竞态关闭形状已变/, guard)
  }
  // Hard-failure criterion: the verdict names the pinned source and the adjudication tail.
  assert.match(drift, /HoverCard\.tsx/)
  assert.match(drift, /退役移植/)
})

test('C15 (CLOSE): the component scope and the handler form decide, never a decoy elsewhere', { skip: pinSkip }, () => {
  const decoy = 'function LegacyPreview({ open, armClose }) {\n'
    + '  return <span onPointerLeave={() => { if (open) armClose() }} />\n'
    + '}\n\n'
  const prefixed = hoverPortVerdict(hoverMutant(decoy + hoverReplace(GRACE_ARM_GUARD, 'armClose()')))
  assert.equal(prefixed.ok, false, "a second component's guarded handler cannot vouch for the real HoverCard")
  assert.match(prefixed.failures.join('\n'), /竞态关闭形状已变/)

  const ternaryText = withLeaveHandler(
    '      onPointerLeave={closeOnPointerLeave ? () => { if (open) armClose() } : undefined}',
  )
  assert.doesNotMatch(ternaryText, /Leaving a closed card/, 'the pinned attribute must actually be replaced')
  const ternary = hoverPortVerdict(hoverMutant(ternaryText))
  assert.equal(ternary.ok, true, ternary.failures.join('\n'))

  const renamed = hoverPortVerdict(hoverMutant(hoverReplace('usePointerGrace(close)', 'useHoverGrace(close)')))
  assert.equal(renamed.ok, false)
  assert.match(renamed.failures.join('\n'), /找不到 usePointerGrace 的 arm 绑定/)
})

test('C15 (OPEN): every pointer re-check spelling is drift, classified by shape', { skip: pinSkip }, () => {
  let drift = ''
  for (const guard of [
    'if (!insideRef.current) return',
    'if (!pointerInside) return',
    "if (hoveringRef.current) setPhase('open')",
    'if (!isPointerOnAnchor) return',
    'if (!anchorContainsPointer) return',
    'if (!pointerState.on) return',
    'if (!pointerIsInAnchor) return',
    "if (pointerIsOver) setPhase('open')",
  ]) {
    const verdict = hoverPortVerdict(hoverMutant(dwellMutant(guard + "; setPhase('open')")))
    assert.equal(verdict.ok, false, 'OPEN-side fix must not pass: ' + guard)
    drift = verdict.failures.join('\n')
    assert.match(drift, /竞态 OPEN 形状已变/)
  }
  assert.match(drift, /退役移植/)
  // An unmount guard is reported neutrally: the gate cannot know whether it is a fix.
  const unmount = hoverPortVerdict(hoverMutant(dwellMutant("if (!mountedRef.current) return; setPhase('open')")))
  assert.equal(unmount.ok, false, 'a callback the gate cannot classify must not auto-pass')
  const detail = unmount.failures.join('\n')
  assert.match(detail, /mountedRef\.current/, 'the offending statement is quoted for the human')
  assert.match(detail, /无法区分/, 'the diagnosis states the two possibilities instead of picking one')
  assert.doesNotMatch(detail, /上游可能已从 OPEN 侧修掉竞态/, 'the diagnosis must not assert a fact the gate cannot know')
})

test('C15 (OPEN): only a null cleanup of the dwell timer ref is admitted', { skip: pinSkip }, () => {
  const cleanup = hoverPortVerdict(hoverMutant(dwellMutant("timerRef.current = null; setPhase('open')")))
  assert.equal(cleanup.ok, true, cleanup.failures.join('\n'))
  for (const callback of [
    "intentRef.current = true; setPhase('open')",
    "otherRef.current = null; setPhase('open')",
    "openEpochRef.current += 1; setPhase('open')",
    "setPhase('open'); if (!mountedRef.current) return",
  ]) {
    const verdict = hoverPortVerdict(hoverMutant(dwellMutant(callback)))
    assert.equal(verdict.ok, false, callback)
    assert.match(verdict.failures.join('\n'), /竞态 OPEN 形状已变/)
  }
  // With no assignment target there is no admitted cleanup (fail-closed).
  const unassigned = hoverPortVerdict(hoverMutant(hoverReplace(DWELL_TIMER,
    "void setTimeout(() => { timerRef.current = null; setPhase('open') }, openDelayMs)")))
  assert.equal(unassigned.ok, false, 'an unassigned dwell timer has no ref whose cleanup is admissible')
})

test('C15 (OPEN): a rewritten, duplicated or comment-decoyed open path is drift, never a silent pass', { skip: pinSkip }, () => {
  const rewritten = hoverPortVerdict(hoverMutant(hoverReplace(DWELL_TIMER, 'openSoon(openDelayMs)')))
  assert.equal(rewritten.ok, false, 'an unlocatable open path must not read as "race still present"')
  assert.match(rewritten.failures.join('\n'), /竞态 OPEN 形状已变/)

  const duplicated = hoverPortVerdict(hoverMutant(hoverReplace(DWELL_TIMER,
    DWELL_TIMER + "\n        otherRef.current = setTimeout(() => { setPhase('open') }, openDelayMs)")))
  assert.equal(duplicated.ok, false, 'two opening timers are ambiguous, not a pass')
  assert.match(duplicated.failures.join('\n'), /生效点不唯一/)

  const comment = hoverPortVerdict(hoverMutant(hoverReplace(DWELL_TIMER,
    '// upstream once considered: if (!insideRef.current) return\n        ' + DWELL_TIMER)))
  assert.equal(comment.ok, true, comment.failures.join('\n'))
})

test('C15 (post-commit): the three pinned dismissal callbacks are admitted, every other one is drift', { skip: pinSkip }, () => {
  const component = componentBody(stripComments(readHoverSource('upstreamHoverCard')), 'HoverCard').text
  assert.equal(postCommitDismissalRecheck(component, pointerGraceArmName(component)).recheck, false,
    'preview fade + owner disable + Escape are the pinned dismissal callbacks')
  const dismissalCallbacks = postCommitCallbacks(component)
    .filter((callback) => /close\(|setPhase\(''\)|armClose\(/.test(callback))
  assert.equal(dismissalCallbacks.length, 3, 'a fourth dismissal-capable effect must be re-adjudicated')

  const repair = (effect, moduleScope) => hoverPortVerdict(hoverMutant(withEffect(effect, moduleScope)))
  const refRepair = repair('  const insideRef = useRef(false)\n  useEffect(() => {\n    if (open && !insideRef.current) { close(); return }\n  }, [open])')
  assert.equal(refRepair.ok, false, 'the commit-layer repair must not read as "race still present"')
  const detail = refRepair.failures.join('\n')
  assert.match(detail, /白名单外的 post-commit 关闭\/相位回调/)
  assert.match(detail, /insideRef\.current/)
  assert.match(detail, /无法区分/)
  assert.match(detail, /退役移植/)
  assert.doesNotMatch(detail, /竞态关闭形状已变/, 'the close shape is untouched; this rule owns the verdict')
  assert.doesNotMatch(detail, /竞态 OPEN 形状已变/, 'the open shape is untouched; this rule owns the verdict')

  for (const action of ["setPhase('closed'); return", 'armClose(); return']) {
    const verdict = repair('  const insideRef = useRef(false)\n  useEffect(() => {\n    if (open && !insideRef.current) { '
      + action + ' }\n  }, [open])')
    assert.equal(verdict.ok, false, action)
    assert.match(verdict.failures.join('\n'), /白名单外的 post-commit 关闭\/相位回调/)
  }
  // Moving the pointer fact to module scope or behind a helper cannot bypass the fail-closed rule.
  for (const condition of ['!pointerInside', '!pointerIsInside()', '!pointerState.value']) {
    const effect = '  useEffect(() => {\n    if (open && ' + condition + ') { close(); return }\n  }, [open])'
    assert.doesNotMatch(effect, /\.current/, 'the bypass deliberately keeps ref reads out of the callback')
    const verdict = repair(effect, 'let pointerInside = false\n\n')
    assert.equal(verdict.ok, false, condition + ' must be red under the fail-closed rule')
    assert.match(verdict.failures.join('\n'), /白名单外的 post-commit 关闭\/相位回调/)
  }
  // Ref bookkeeping and a comment naming the repair stay green.
  const bookkeeping = repair('  const mountedOnceRef = useRef(false)\n  useEffect(() => {\n    mountedOnceRef.current = true\n    return () => { mountedOnceRef.current = false }\n  }, [])')
  assert.equal(bookkeeping.ok, true, bookkeeping.failures.join('\n'))
  const comment = repair('  // upstream once considered: useEffect(() => { if (open && !insideRef.current) close() }, [open])')
  assert.equal(comment.ok, true, comment.failures.join('\n'))
})

test('C15: the timing constants are read from the pinned source, and every drift shape is red', { skip: pinSkip }, () => {
  const graceWith = (replacement, prefix = '') => hoverMutantSources('upstreamPointerGrace',
    prefix + graceReplace(GRACE_DECL, replacement))
  const chamberWith = (replacement) => hoverMutantSources('chamberHoverIntent', chamberReplace(CHAMBER_OPEN_DECL, replacement))
  const graceDrift = hoverPortVerdict(graceWith('export const POINTER_GRACE_MS = 250'))
  assert.equal(graceDrift.ok, false)
  const graceDetail = graceDrift.failures.join('\n')
  assert.match(graceDetail, /POINTER_GRACE_MS = 250/)
  assert.match(graceDetail, /HOVER_CLOSE_GRACE_MS = 200/)
  assert.match(graceDetail, /pointer-grace\.ts/)
  assert.match(graceDetail, /hover-intent\.ts/)
  assert.match(graceDetail, /退役移植/)

  const chamberDrift = hoverPortVerdict(chamberWith('export const HOVER_OPEN_DELAY_MS = 400'))
  assert.equal(chamberDrift.ok, false)
  assert.match(chamberDrift.failures.join('\n'), /openDelayMs = 500/)
  assert.match(chamberDrift.failures.join('\n'), /HOVER_OPEN_DELAY_MS = 400/)

  const renamed = hoverPortVerdict(graceWith('export const GRACE_MS = 200'))
  assert.equal(renamed.ok, false)
  assert.match(renamed.failures.join('\n'), /解析不到上游 .*POINTER_GRACE_MS/)

  const retired = hoverPortVerdict(hoverMutantSources('chamberHoverIntent',
    chamberReplace('export const HOVER_CLOSE_GRACE_MS = 200\n', '')))
  assert.equal(retired.ok, false)
  assert.match(retired.failures.join('\n'), /解析不到 chamber .*HOVER_CLOSE_GRACE_MS/)

  // A decoy literal is never read as the value, neither a string nor a regex.
  const decoy = hoverPortVerdict(graceWith('export const POINTER_GRACE_MS = 120', "const NOTE = 'POINTER_GRACE_MS = 200'\n"))
  assert.equal(decoy.ok, false)
  assert.match(decoy.failures.join('\n'), /悬停时间常数失步/)
  assert.match(decoy.failures.join('\n'), /POINTER_GRACE_MS = 120/)
  assert.doesNotMatch(decoy.failures.join('\n'), /POINTER_GRACE_MS = 200 != /)
  const regexDecoy = hoverPortVerdict(graceWith('export const POINTER_GRACE_MS = 120', 'const re = /POINTER_GRACE_MS = 200/\n'))
  assert.equal(regexDecoy.ok, false)
  assert.match(regexDecoy.failures.join('\n'), /POINTER_GRACE_MS = 120/)

  const duplicated = hoverPortVerdict(hoverMutantSources('upstreamPointerGrace',
    readHoverSource('upstreamPointerGrace') + 'export const POINTER_GRACE_MS = 220\n'))
  assert.equal(duplicated.ok, false)
  assert.match(duplicated.failures.join('\n'), /多个不同赋值（200 \/ 220）/)
  assert.match(duplicated.failures.join('\n'), /诱饵\/重复赋值/)

  const negative = hoverPortVerdict(graceWith('export const POINTER_GRACE_MS = -200'))
  assert.equal(negative.ok, false)
  assert.match(negative.failures.join('\n'), /POINTER_GRACE_MS = -200/)
  const comparison = hoverPortVerdict(graceWith('export const POINTER_GRACE_MS === 200'))
  assert.equal(comparison.ok, false)
  assert.match(comparison.failures.join('\n'), /解析不到上游 .*POINTER_GRACE_MS/)
})

test('C15: an unmaterialized pin tree is a hard failure, never "no race"', () => {
  const verdict = hoverPortVerdict({
    upstreamHoverCard: { path: HOVER_PORT_SOURCES.upstreamHoverCard, text: null },
    upstreamPointerGrace: { path: HOVER_PORT_SOURCES.upstreamPointerGrace, text: null },
    chamberHoverIntent: { path: HOVER_PORT_SOURCES.chamberHoverIntent, text: null },
  })
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /读不到 上游 HoverCard/)
  assert.match(verdict.failures.join('\n'), /读不到 上游 pointer-grace/)
  assert.match(verdict.failures.join('\n'), /读不到 chamber hover-intent/)
})

test('C15: the gate actually consults the verdict on the pinned tree (wiring scan)', () => {
  // The full gate cannot run in a bare worktree (empty vendor/harness-checkout makes C1 throw before C15), so this scan proves the wiring.
  const source = readFileSync(scriptPath, 'utf8')
  assert.match(source, /import \{ HOVER_PORT_SOURCES, hoverPortVerdict \} from '\.\/verify-upstream-touchpoints-hover\.mjs'/)
  assert.match(source, /hoverPortVerdict\(\{/)
  for (const key of ['upstreamHoverCard', 'upstreamPointerGrace', 'chamberHoverIntent']) {
    assert.match(source, new RegExp(key + ': readSource\\(HOVER_PORT_SOURCES\\.' + key + ', (SUBMODULE|ROOT)\\)'))
  }
  assert.match(source, /else for \(const failure of verdict\.failures\) fail\(failure\)/)
})

// ---------------------------------------------------------------------------
// C16 — vendor-source consumers: the registry list and the real relative
// imports must agree in BOTH directions. The three negative controls are the
// plan's: a renamed symbol, an unregistered import, a deleted registration.
// ---------------------------------------------------------------------------

const VENDOR_CONSUMER = 'packages/renderer/src/host-graph.ts'
const VENDOR_FILE = 'vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts'
const VENDOR_SPECIFIER = '../../../vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts'
const VENDOR_ENTRY = {
  consumer: VENDOR_CONSUMER,
  vendorFile: VENDOR_FILE,
  symbols: ['optionalStringArray', 'stripClientSuffix'],
}
const VENDOR_TEXT = [
  'export function optionalStringArray(subject: string, field: string, value: unknown): string[] | undefined {',
  '  return undefined',
  '}',
  'export function stripClientSuffix(spec: string): string { return spec }',
  '',
].join('\n')
const vendorImport = (overrides = {}) => ({
  consumer: VENDOR_CONSUMER,
  vendorFile: VENDOR_FILE,
  specifier: VENDOR_SPECIFIER,
  symbols: [...VENDOR_ENTRY.symbols],
  line: 63,
  ...overrides,
})
const c16 = (imports, entries = [VENDOR_ENTRY]) => vendorSourceVerdict({
  entries,
  imports,
  vendorSources: { [VENDOR_FILE]: VENDOR_TEXT },
})

test('C16: the registered pair with its exact symbol set passes', () => {
  const verdict = c16([vendorImport()])
  assert.equal(verdict.ok, true, verdict.failures.join('\n'))
  assert.match(verdict.summary, /C16 vendor 源消费者/)
})

test('C16 negative control 1: a renamed consumer symbol fails (symbol set must be equal)', () => {
  const verdict = c16([vendorImport({ symbols: ['optionalStringArray'] })])
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /符号集合不一致/)
  assert.match(verdict.failures.join('\n'), /stripClientSuffix/)
})

test('C16 negative control 2: an unregistered vendor-relative import fails', () => {
  const verdict = c16([vendorImport(), vendorImport({ consumer: 'packages/renderer/src/other.ts', line: 9 })])
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /未登记的 vendor 源相对 import/)
  assert.match(verdict.failures.join('\n'), /packages\/renderer\/src\/other\.ts:9/)
})

test('C16 negative control 3: a registration whose import disappeared fails (no orphan entries)', () => {
  const verdict = c16([])
  assert.equal(verdict.ok, false)
  assert.match(verdict.failures.join('\n'), /过期登记/)
})

test('C16: a vendor export that is renamed/removed as a function fails', () => {
  const renamed = vendorSourceVerdict({
    entries: [VENDOR_ENTRY],
    imports: [vendorImport()],
    vendorSources: { [VENDOR_FILE]: VENDOR_TEXT.replace('export function stripClientSuffix', 'export const stripClientSuffix') },
  })
  assert.equal(renamed.ok, false)
  assert.match(renamed.failures.join('\n'), /不再以 export function stripClientSuffix 导出/)
})

test('C16: a missing registry block and an unreadable vendor file are hard failures', () => {
  const noBlock = vendorSourceVerdict({ entries: undefined, imports: [], vendorSources: {} })
  assert.equal(noBlock.ok, false)
  assert.match(noBlock.failures.join('\n'), /缺 vendorSourceConsumers/)
  const unreadable = vendorSourceVerdict({ entries: [VENDOR_ENTRY], imports: [vendorImport()], vendorSources: { [VENDOR_FILE]: null } })
  assert.equal(unreadable.ok, false)
  assert.match(unreadable.failures.join('\n'), /读不到 vendor 文件/)
})

test('C16: declaration symbols are read source-side and decoy literals are neutralized', () => {
  assert.deepEqual(clauseSymbols('{ optionalStringArray, stripClientSuffix as strip }'), ['optionalStringArray', 'stripClientSuffix'])
  assert.deepEqual(clauseSymbols('* as ns'), ['*'])
  assert.deepEqual(clauseSymbols('import D, { G as H }'), ['G', 'default'])
  const text = [
    "// import { x } from '../../../vendor/harness-packages/x.ts'",
    'const s = "import { y } from ' + "'../../../vendor/harness-packages/y.ts'" + '"',
    'const r = /vendor\\/z\\.ts/',
    "import { optionalStringArray } from '../../../vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts'",
    'const dyn = await import("../../../vendor/dyn.ts")',
    'const req = require("../../../vendor/req.ts")',
  ].join('\n')
  assert.deepEqual(sourceModuleSpecifiers(text).map((item) => item.specifier), [
    '../../../vendor/harness-packages/@deepseek-ai/dsh-client-modules/src/client/manifest.ts',
    '../../../vendor/dyn.ts',
    '../../../vendor/req.ts',
  ])
  const imports = relativeVendorImports('packages/renderer/src/probe.ts', text)
  assert.equal(imports.length, 3)
  assert.deepEqual(imports[0].symbols, ['optionalStringArray'])
})

test('C16 wiring: the real host-graph vendor import is exactly the registered pair', () => {
  const root = join(here, '..', '..')
  const registry = JSON.parse(readFileSync(join(root, 'scripts', 'upstream', 'registry.json'), 'utf8'))
  const consumer = readFileSync(join(root, 'packages', 'renderer', 'src', 'host-graph.ts'), 'utf8')
  const imports = relativeVendorImports(VENDOR_CONSUMER, consumer)
  assert.equal(imports.length, 1, 'host-graph.ts must carry exactly one vendor-relative import')
  assert.equal(imports[0].vendorFile, VENDOR_FILE)
  assert.deepEqual(imports[0].symbols, ['optionalStringArray', 'stripClientSuffix'])
  const verdict = c16(imports, registry.vendorSourceConsumers)
  assert.equal(verdict.ok, true, verdict.failures.join('\n'))
})

// ── pre-install 可运行性锁 ────────────────────────────────────────────────
// CI 在 `pnpm install` 之前就跑本入口（ci.yml 的 test/test-windows、release.yml 的
// validation）：入口模块图必须只含 `node:` 与相对 specifier，触达的 packages/ 源文件
// 也不得出现裸包名。回归史：入口 → plugin-protection-gate.mjs →
// control-plane/src/protected-plugins.ts 的 wire 值导入 ⇒ install 前
// ERR_MODULE_NOT_FOUND。运行时判据因此住在 leaf runtime-family.ts。
function moduleGraphProblems(root, entry) {
  const reached = new Set()
  const problems = []
  const visit = (file) => {
    if (reached.has(file)) return
    reached.add(file)
    for (const { specifier } of sourceModuleSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('.')) { visit(resolve(dirname(file), specifier)); continue }
      problems.push(relative(root, file) + ' -> ' + specifier)
    }
  }
  visit(entry)
  return { reached: [...reached], problems }
}

// The six entries the CI/release jobs run before the frozen install (ci.yml test +
// test-windows, release.yml validation; test-macos has no touchpoint gate).
const PREINSTALL_ENTRIES = [
  'scripts/gates/classify-ci-changes.mjs',
  'scripts/gates/verify-workflow-action-pins.mjs',
  'scripts/gates/verify-workflow-yaml-scalars.mjs',
  'scripts/dev/ensure-harness-vendor.mjs',
  'scripts/upstream/verify-upstream-touchpoints.mjs',
  'scripts/release/verify-release-ci-proof.mjs',
  'scripts/release/release-semver.mjs',
  'scripts/release/release-preflight.mjs',
]

test('pre-install: every pre-install entry graph never needs node_modules', () => {
  const root = join(here, '..', '..')
  const problems = []
  const packageSources = new Set()
  for (const entry of PREINSTALL_ENTRIES) {
    const graph = moduleGraphProblems(root, join(root, entry))
    problems.push(...graph.problems)
    for (const file of graph.reached) {
      const rel = relative(root, file).split('\\').join('/')
      if (rel.startsWith('packages/')) packageSources.add(rel)
    }
  }
  assert.deepEqual(problems, [], 'these entries run before the frozen install: only node:/relative specifiers')
  assert.deepEqual([...packageSources].sort(), ['packages/control-plane/src/runtime-family.ts'],
    'the runtime judgment may enter a pre-install graph only through its leaf module')
})

test('pre-install lock self-test: a synthetic bare specifier is caught', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-preinstall-graph-'))
  try {
    writeFileSync(join(dir, 'entry.mjs'), "import { mid } from './mid.mjs'\nimport 'bare-side-effect'\n")
    writeFileSync(join(dir, 'mid.mjs'), "export const mid = (await import('bare-dynamic')).x\n")
    const { reached, problems } = moduleGraphProblems(dir, join(dir, 'entry.mjs'))
    assert.equal(reached.length, 2)
    assert.deepEqual(problems.sort(), ['entry.mjs -> bare-side-effect', 'mid.mjs -> bare-dynamic'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

