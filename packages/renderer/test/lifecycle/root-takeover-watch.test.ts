/**
 * The page-level root-takeover net (design 09 §3.5): a foreign full-screen overlay
 * that zeroes `#root` must be reported and released — while an `inert`-only hold
 * (legit dialogs) is never touched, and a writer that flaps sub-grace is still
 * caught by the rolling evidence window.
 *
 * Every case drives the PRODUCT paths (defaultTarget → defaultObserve →
 * defaultRelease → monotonicNow) with a fake document/MutationObserver/performance
 * and a counting fake root; timers are the real globals, driven by `t.mock.timers`
 * (the repo's convention) — only the globals are injected.
 */
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_ROOT_TAKEOVER_RULE, ROOT_TAKEOVER_IDLE, installRootTakeoverWatch, rootTakeoverStep,
  type RootTakeoverFacts,
} from '../../src/root-takeover-watch.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const RULE = DEFAULT_ROOT_TAKEOVER_RULE

test('rootTakeoverStep: a stable hold reports at the grace, a flapping one through the window', () => {
  const held = rootTakeoverStep(ROOT_TAKEOVER_IDLE, { opacity: '0', at: 0 })
  assert.deepEqual(held.actions, [])
  assert.equal(held.state.phase, 'held')
  const early = rootTakeoverStep(held.state, { opacity: '0', at: RULE.graceMs - 1 })
  assert.deepEqual(early.actions, [])
  const fired = rootTakeoverStep(early.state, { opacity: '0', at: RULE.graceMs })
  assert.deepEqual(fired.actions, ['report', 'release'])
  assert.equal(fired.state.releases, 1)
  // Any non-zero opacity ends the episode — but the evidence window survives it,
  // so three zero observations that never hold for the grace still report.
  const cleared = rootTakeoverStep(fired.state, { opacity: '', at: 10_000 })
  assert.equal(cleared.state.phase, 'idle')
  assert.deepEqual(cleared.state.zeroAt, [])
  let flapping = rootTakeoverStep(cleared.state, { opacity: '0', at: 11_000 }).state
  flapping = rootTakeoverStep(flapping, { opacity: '', at: 11_500 }).state
  flapping = rootTakeoverStep(flapping, { opacity: '0', at: 12_000 }).state
  flapping = rootTakeoverStep(flapping, { opacity: '', at: 12_500 }).state
  const thirdZero = rootTakeoverStep(flapping, { opacity: '0', at: 13_000 })
  assert.deepEqual(thirdZero.actions, ['report', 'release'], 'the rolling window fills the gap the grace cannot')
  const quiet = rootTakeoverStep(thirdZero.state, { opacity: '0', at: 13_400 })
  assert.deepEqual(quiet.actions, [], 'the report cooldown holds the next report back')
})

test('rootTakeoverStep: later releases are spaced and capped, and the page budget outlives the episode', () => {
  let state = rootTakeoverStep(ROOT_TAKEOVER_IDLE, { opacity: '0', at: 0 }).state
  state = rootTakeoverStep(state, { opacity: '0', at: RULE.graceMs }).state
  const spaced = rootTakeoverStep(state, { opacity: '0', at: RULE.graceMs + RULE.retryMs - 1 })
  assert.deepEqual(spaced.actions, [])
  state = rootTakeoverStep(spaced.state, { opacity: '0', at: RULE.graceMs + RULE.retryMs }).state
  assert.equal(state.releases, 2)
  state = rootTakeoverStep(state, { opacity: '0', at: RULE.graceMs + 2 * RULE.retryMs }).state
  assert.equal(state.releases, 3)
  const capped = rootTakeoverStep(state, { opacity: '0', at: RULE.graceMs + 3 * RULE.retryMs })
  assert.deepEqual(capped.actions, ['exhausted'])
  // The budget is for the PAGE, not one episode: a cleared-then-re-taken root must
  // not restart the fight, but the new episode is still REPORTED (new evidence).
  const cleared = rootTakeoverStep(capped.state, { opacity: '', at: RULE.graceMs + 4 * RULE.retryMs })
  assert.equal(cleared.state.phase, 'idle')
  const again = rootTakeoverStep(cleared.state, { opacity: '0', at: RULE.graceMs + 5 * RULE.retryMs })
  assert.deepEqual(again.actions, [])
  const rereported = rootTakeoverStep(again.state, { opacity: '0', at: RULE.graceMs + 6 * RULE.retryMs })
  assert.deepEqual(rereported.actions, ['report'])
  assert.deepEqual(rootTakeoverStep(rereported.state, { opacity: '0', at: RULE.graceMs + 7 * RULE.retryMs }).actions, [])
})

test('rootTakeoverStep: the published rule numbers are pinned (design 09 §3.5)', () => {
  // The numbers are a DESIGN contract (grace/retry/budget/window/samples), so a
  // silent retune must fail here rather than ride on the RULE.* symbols.
  assert.deepEqual(DEFAULT_ROOT_TAKEOVER_RULE, {
    graceMs: 3000, retryMs: 5000, maxReleases: 3, windowMs: 15_000, minSamples: 3,
  })
})

test('rootTakeoverStep: repeated writes to one continuous hold are one episode, not flapping', () => {
  let state = rootTakeoverStep(ROOT_TAKEOVER_IDLE, { opacity: '0', at: 0 }).state
  state = rootTakeoverStep(state, { opacity: '0', at: 100 }).state
  const third = rootTakeoverStep(state, { opacity: '0', at: 200 })
  assert.deepEqual(third.actions, [], 'a stable hold that keeps rewriting style is not window evidence')
  const grace = rootTakeoverStep(third.state, { opacity: '0', at: RULE.graceMs })
  assert.deepEqual(grace.actions, ['report', 'release'], 'it still reports at the grace')
  assert.equal(grace.state.phase, 'held')
})

interface FakeRoot { element: HTMLElement; opacityWrites: string[]; inertWrites: boolean[]; failNextRelease(): void }
function fakeRoot(initial: { opacity?: string; inert?: boolean } = {}): FakeRoot {
  const opacityWrites: string[] = []
  const inertWrites: boolean[] = []
  let opacity = initial.opacity ?? ''
  let inert = initial.inert ?? false
  let failRelease = false
  const element = { style: {} as CSSStyleDeclaration } as { style: CSSStyleDeclaration; inert: boolean }
  Object.defineProperty(element.style, 'opacity', {
    get: () => opacity,
    set: (value: string) => {
      // The product's release writes '' — model a hostile DOM where that write throws.
      if (value === '' && failRelease) { failRelease = false; throw new Error('style write rejected') }
      opacity = value
      opacityWrites.push(value)
    },
    configurable: true,
  })
  Object.defineProperty(element, 'inert', {
    get: () => inert,
    set: (value: boolean) => { inert = value; inertWrites.push(value) },
    configurable: true,
  })
  return {
    element: element as unknown as HTMLElement,
    opacityWrites,
    inertWrites,
    failNextRelease: () => { failRelease = true },
  }
}
/** The product release is the only writer that clears inert (manual clears cannot fake it). */
const releases = (fake: FakeRoot): number => fake.inertWrites.filter(value => value === false).length

interface DomFixture {
  change(): void
  observed(): unknown[]
  advance(ms: number): void
  /** The delays the watcher asked the mocked timer for, in schedule order. */
  scheduled(): number[]
  restore(): void
}
const PRISTINE = (() => {
  const globals = globalThis as { document?: unknown; MutationObserver?: unknown; performance?: unknown; setTimeout?: unknown }
  return {
    document: globals.document, observer: globals.MutationObserver,
    performance: globals.performance, setTimeout: globals.setTimeout,
  }
})()
function installDom(t: TestContext, root: HTMLElement | null): DomFixture {
  const globals = globalThis as { document?: unknown; MutationObserver?: unknown; performance?: unknown; setTimeout?: unknown }
  const options: unknown[] = []
  const delays: number[] = []
  let notify: (() => void) | null = null
  let now = 0
  let zeroRun = 0
  // Wrap the mocked timer to see what the watcher asks for. A run of back-to-back
  // 0ms re-arms is the busy-spin bug: fail fast instead of looping forever inside a
  // single tick (timers advance the fake clock only through \`advance\`).
  const timeouts = globalThis.setTimeout
  globals.setTimeout = (fn: () => void, delay?: number) => {
    delays.push(delay ?? 0)
    if ((delay ?? 0) > 0) zeroRun = 0
    else if (++zeroRun > 50) throw new Error('root-takeover watch spun on 0ms re-arms')
    return timeouts(fn, delay)
  }
  globals.document = { getElementById: (id: string) => (id === 'root' ? root : null) }
  // The product clock is monotonicNow() → globalThis.performance.now, and
  // `t.mock.timers` cannot mock performance: the fake clock advances in lockstep
  // with the mocked timers, so timer callbacks and elapsed math agree.
  globals.performance = { now: () => now }
  globals.MutationObserver = class {
    constructor(onChange: () => void) { notify = onChange }
    observe(_target: unknown, next: unknown): void { options.push(next) }
    disconnect(): void { notify = null }
  }
  return {
    change: () => notify?.(),
    observed: () => options,
    advance: (ms: number) => { now += ms; t.mock.timers.tick(ms) },
    scheduled: () => delays,
    restore: () => {
      globals.document = PRISTINE.document
      globals.MutationObserver = PRISTINE.observer
      globals.performance = PRISTINE.performance
      globals.setTimeout = PRISTINE.setTimeout
    },
  }
}

test('install: the product paths cover inert-only holds, the grace window and re-arming', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '', inert: true })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  const dispose = installRootTakeoverWatch({ report: facts => reports.push(facts) })
  t.after(() => { dispose(); dom.restore() })
  assert.deepEqual(dom.observed(), [{ attributes: true, attributeFilter: ['style', 'inert'] }])
  // A legitimate inert-only hold is never touched, even after a long tick.
  dom.advance(60_000)
  assert.equal(reports.length, 0)
  assert.equal(fake.element.inert, true)
  assert.deepEqual(fake.opacityWrites, [])
  // The takeover starts: a write inside the grace window must not report early.
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs - 1)
  dom.change()
  assert.equal(reports.length, 0)
  dom.advance(1)
  assert.equal(reports.length, 1)
  assert.deepEqual(
    {
      trigger: reports[0]!.trigger, released: reports[0]!.released, releaseFailed: reports[0]!.releaseFailed,
      releaseAttempt: reports[0]!.releaseAttempt, inert: reports[0]!.inert,
    },
    { trigger: 'held', released: true, releaseFailed: false, releaseAttempt: 1, inert: true },
  )
  assert.ok(reports[0]!.heldMs >= RULE.graceMs, 'fact carries the hold duration')
  assert.equal(fake.element.style.opacity, '')
  assert.equal(fake.element.inert, false)
  assert.equal(releases(fake), 1)
  // Clearing ends the episode; a second takeover reports and releases again.
  dom.change()
  dom.advance(60_000)
  assert.equal(reports.length, 1)
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs)
  assert.equal(reports.length, 2, 'a new episode reports again')
  assert.equal(releases(fake), 2, 'and releases again while the budget lasts')
})

test('install: a sub-grace flapping writer is caught by the rolling window, spaced by the cooldown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '' })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  const dispose = installRootTakeoverWatch({ report: facts => reports.push(facts) })
  t.after(() => { dispose(); dom.restore() })
  for (let second = 0; second < 12; second += 1) {
    fake.element.style.opacity = '0'
    dom.change()
    dom.advance(700)
    fake.element.style.opacity = ''
    dom.change()
    dom.advance(300)
  }
  assert.equal(reports.length, 2, 'one report when the window fills, the next after the cooldown')
  assert.equal(reports[0]!.trigger, 'flapping')
  assert.equal(reports[0]!.released, true)
  assert.ok(reports[0]!.heldMs < RULE.graceMs, 'no continuous hold ever reached the grace')
  assert.equal(releases(fake), 2)
})

test('install: the release budget is spent once, then episodes are report-only', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const error = t.mock.method(console, 'error', () => {})
  const fake = fakeRoot({ opacity: '0', inert: true })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  const dispose = installRootTakeoverWatch({ report: facts => reports.push(facts) })
  t.after(() => { dispose(); dom.restore() })
  dom.advance(RULE.graceMs)
  // The writer re-zeros between retries (the observed overlay does), so the state
  // stays in ONE episode and the retry spacing governs the next release.
  for (let attempt = 2; attempt <= RULE.maxReleases; attempt += 1) {
    fake.element.style.opacity = '0'
    dom.change()
    dom.advance(RULE.retryMs)
    assert.equal(releases(fake), attempt, 'release ' + String(attempt))
  }
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.retryMs)
  assert.equal(releases(fake), RULE.maxReleases, 'no release beyond the budget')
  assert.equal(error.mock.callCount(), 1, 'exactly one give-up report')
  assert.match(String(error.mock.calls[0]!.arguments[0]), /giving up on automatic recovery/, 'the give-up copy is the operator evidence')
  // Budget spent: a NEW episode whose only attribute write is the re-zero must
  // still be reported (the grace timer cannot depend on a second mutation).
  fake.element.style.opacity = ''
  dom.change()
  dom.advance(RULE.retryMs)
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs)
  assert.equal(reports.length, 2, 'the post-budget episode is reported')
  assert.equal(reports[1]!.released, false)
  assert.equal(reports[1]!.releaseFailed, false, 'a spent budget is not a rejected write')
  assert.equal(releases(fake), RULE.maxReleases, 'and never released again')
  dom.advance(RULE.retryMs * 3)
  assert.equal(reports.length, 2, 'report-only means no further scheduled work')
  assert.equal(error.mock.callCount(), 1)
})

test('install: the spent budget is enforced even when the exhausted signal never fired', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '0' })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  const dispose = installRootTakeoverWatch({ report: facts => reports.push(facts) })
  t.after(() => { dispose(); dom.restore() })
  dom.advance(RULE.graceMs)
  for (let attempt = 2; attempt <= RULE.maxReleases; attempt += 1) {
    fake.element.style.opacity = '0'
    dom.change()
    dom.advance(RULE.retryMs)
    assert.equal(releases(fake), attempt)
  }
  // The overlay stops right after the last release, BEFORE the retry can emit the
  // `exhausted` action: the budget is spent all the same, so the next episode may
  // only report — a budget check that waits for `exhausted` would release a 4th time.
  fake.element.style.opacity = ''
  dom.change()
  dom.advance(RULE.retryMs)
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs)
  assert.equal(reports.length, 2, 'the new episode is reported')
  assert.equal(reports[1]!.released, false, 'report only: the budget is spent')
  assert.equal(releases(fake), RULE.maxReleases, 'no release beyond the page budget')
})

test('install: a grace inside the report cooldown waits for the cooldown (no 0ms spin)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '' })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  const dispose = installRootTakeoverWatch({ report: facts => reports.push(facts) })
  t.after(() => { dispose(); dom.restore() })
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs)
  assert.equal(reports.length, 1, 'the first report lands at the grace')
  // The release cleared the attribute; a hostile writer re-zeros it right after and
  // holds. The new episode's grace therefore lands INSIDE the first report's
  // cooldown: the wake-up must wait for the cooldown, not re-arm at 0ms.
  fake.element.style.opacity = ''
  dom.change()
  dom.advance(104)
  fake.element.style.opacity = '0'
  dom.change()
  assert.equal(reports.length, 1)
  // The new episode's grace (t=6104) falls inside the first report's cooldown, so
  // the only honest wake-up is the cooldown's end (t=8000) — never a 0ms re-arm.
  const remaining = RULE.retryMs - 104
  const last = dom.scheduled().at(-1) ?? 0
  assert.ok(
    Math.abs(last - remaining) <= 1,
    'the wake-up waits the cooldown remainder (' + String(remaining) + 'ms), got ' + String(last),
  )
  dom.advance(2000)
  assert.equal(reports.length, 1, 'nothing fires before the cooldown opens')
  dom.advance(last)
  assert.equal(reports.length, 2, 'the report lands when the cooldown opens')
  assert.equal(reports[1]!.trigger, 'held')
  assert.equal(releases(fake), 2, 'and the second release rides the second report')
})

test('install: a dispose from inside the report callback stops the watch', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '0' })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  let dispose: () => void = () => {}
  dispose = installRootTakeoverWatch({ report: facts => { reports.push(facts); dispose() } })
  t.after(() => { dispose(); dom.restore() })
  const scheduledBefore = dom.scheduled().length
  dom.advance(RULE.graceMs)
  assert.equal(reports.length, 1, 'the episode still reports before the re-entrant dispose')
  const writes = fake.opacityWrites.length
  dom.advance(RULE.retryMs * 4)
  assert.equal(reports.length, 1, 'no further report after a re-entrant dispose')
  assert.equal(fake.opacityWrites.length, writes, 'nor any further release write')
  assert.equal(dom.scheduled().length, scheduledBefore, 'nor any re-armed timer')
})

test('install: a second install is a no-op and a dispose releases the page claim', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '' })
  const dom = installDom(t, fake.element)
  const first: RootTakeoverFacts[] = []
  const second: RootTakeoverFacts[] = []
  const disposeFirst = installRootTakeoverWatch({ report: facts => first.push(facts) })
  const disposeSecond = installRootTakeoverWatch({ report: facts => second.push(facts) })
  t.after(() => { disposeSecond(); disposeFirst(); dom.restore() })
  assert.equal(dom.observed().length, 1, 'the second install must not mint a second observer')
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs)
  assert.equal(first.length, 1)
  assert.equal(second.length, 0, 'the shadowed install never reports')
  assert.equal(releases(fake), 1, 'nor releases (the budget stays a page budget)')
  disposeFirst()
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs * 2)
  assert.equal(first.length, 1, 'a disposed watcher stays silent')
  const third: RootTakeoverFacts[] = []
  const disposeThird = installRootTakeoverWatch({ report: facts => third.push(facts) })
  t.after(() => disposeThird())
  assert.equal(dom.observed().length, 2, 'a fresh install after dispose works')
  fake.element.style.opacity = '0'
  dom.change()
  dom.advance(RULE.graceMs)
  assert.equal(third.length, 1)
})

test('install: a throwing release write is reported as not released, and the retry recovers', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '0' })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  const dispose = installRootTakeoverWatch({ report: facts => reports.push(facts) })
  t.after(() => { dispose(); dom.restore() })
  fake.failNextRelease()
  dom.advance(RULE.graceMs)
  assert.equal(reports.length, 1)
  assert.equal(reports[0]!.released, false, 'the report never claims a write that threw')
  assert.equal(reports[0]!.releaseFailed, true, 'the rejected write is named as such, not as a spent budget')
  assert.equal(releases(fake), 0)
  assert.equal(fake.element.style.opacity, '0', 'the hostile DOM kept the hijack value')
  dom.advance(RULE.retryMs)
  assert.equal(reports.length, 1, 'a retry release is not a new report')
  assert.equal(releases(fake), 1)
  assert.equal(fake.element.style.opacity, '')
  assert.equal(fake.element.inert, false)
})

test('install: the disposer unsubscribes and makes any pending wake-up a no-op; a missing #root is a no-op', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const fake = fakeRoot({ opacity: '0' })
  const dom = installDom(t, fake.element)
  const reports: RootTakeoverFacts[] = []
  const dispose = installRootTakeoverWatch({ report: facts => reports.push(facts) })
  t.after(() => { dispose(); dom.restore() })
  dispose()
  dom.advance(RULE.graceMs * 4)
  assert.deepEqual(reports, [], 'a disposed watcher never reports or releases')
  assert.deepEqual(fake.opacityWrites, [])
  const missing = installDom(t, null)
  t.after(() => missing.restore())
  const noRoot = installRootTakeoverWatch({ report: () => { throw new Error('must not run') } })
  noRoot()
  assert.deepEqual(missing.observed(), [], 'no observer is installed without #root')
})

test('install: no document (non-DOM environment) is a safe no-op', () => {
  const globals = globalThis as { document?: unknown }
  const previous = globals.document
  globals.document = undefined
  try {
    const dispose = installRootTakeoverWatch({ report: () => { throw new Error('must not run') } })
    dispose()
  } finally {
    globals.document = previous
  }
})

test('the page entry still installs the watcher and records the incident (source lock)', () => {
  // The wiring lives in main.tsx, which value-imports React and cannot be loaded
  // here; a comment must not satisfy the lock, so comments are stripped first.
  const root = join(import.meta.dirname, '..', '..', '..', '..')
  const main = stripComments(readFileSync(join(root, 'packages/renderer/src/main.tsx'), 'utf8'))
  assert.match(main, /installRootTakeoverWatch\(\{/)
  assert.match(main, /recordIncident\(\{/)
  assert.match(main, /kind: 'root-takeover'/)
  assert.match(main, /facts\.trigger/, 'the incident detail carries the detection trigger')
  assert.match(main, /at: Date\.now\(\)/)
  assert.match(main, /facts\.releaseFailed/, 'a rejected write is distinguished from a spent budget')
  assert.match(main, /'release-failed'/, 'and recorded as its own incident action')
  // The module must time on the monotonic clock: the fake clock moves Date and
  // performance in lockstep, so ONLY a source lock can catch a Date.now() swap.
  const watcher = stripComments(readFileSync(join(root, 'packages/renderer/src/root-takeover-watch.ts'), 'utf8'))
  assert.match(watcher, /monotonicNow\(\)/, 'the watcher times on the monotonic clock')
  assert.doesNotMatch(watcher, /Date\.now\(/, 'never the wall clock: a rewind must not postpone a release')
})
