/**
 * Source lock for the chamber journal silence watchdog (design 14 §D4).
 *
 * `src/client/journal-stream.ts` is upstream-verbatim plus chamber patches, so an
 * upstream re-sync replaces it wholesale and review alone cannot hold the change.
 * The lock fails loudly when the patched file loses:
 *
 *  - the watchdog arm/disarm wiring,
 *  - the hard rule that a restart happens ONLY after a probe proves the Host
 *    cursor advanced (a blind idle restart is exactly what design 14 §D4 rejected),
 *  - the bounded user-initiated history read, or
 *  - the total deadline on one logical open across its physical reopens.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (relative: string): string => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const journal = source('src/client/journal-stream.ts')
const policy = source('src/client/stream-stall-policy.ts')

function bodyOf(sourceText: string, start: string, end: string): string {
  const from = sourceText.indexOf(start)
  const to = sourceText.indexOf(end, from)
  assert.ok(from >= 0 && to > from, 'expected block ' + JSON.stringify(start) + ' to be locatable')
  return sourceText.slice(from, to)
}

const checkStall = bodyOf(journal, 'private async checkStall(): Promise<void> {', '  /** Open one sibling follow')
const probe = bodyOf(journal, 'private async probeHostAdvance(): Promise<boolean> {', '  private async consume(')
const open = bodyOf(journal, '  async open(request: PageRequest): Promise<void> {', '  /**\n   * Read and prepend one older page')
const dispose = bodyOf(journal, '  dispose(): Promise<void> {', '  private publish(')

test('the watchdog is armed only after the opening window is published and disarmed on dispose', () => {
  assert.match(open, /this\.opened = true\s*\n\s*this\.startStallWatchdog\(\)\s*\n\s*this\.done = this\.consume\(iterator\)/u)
  assert.match(dispose, /this\.disposed = true\s*\n\s*this\.stopStallWatchdog\(\)/u)
  assert.match(journal, /const timer = setInterval\(\(\) => \{ void this\.checkStall\(\) \}, this\.stallTiming\.tickMs\)/u)
  assert.match(journal, /clearInterval\(this\.stallTimer\)/u)
})

test('the logical open carries a total deadline across physical reopens', () => {
  // The per-episode opening budget bounds ONE physical attempt; the logical open
  // retries generations. Without this bound the vendor's openPromise stayed pending
  // forever with openState 'loading' and no lever could conclude the open.
  assert.match(open, /const firstFrame = this\.takeNext\(iterator\)/u)
  assert.match(open, /await withDeadline<IteratorResult<JournalStreamItem<Page, Entry, Cursor, Notification>> \| 'expired'>\(firstFrame, \{/u)
  assert.match(open, /ms: this\.openDeadlineMs/u)
  assert.match(open, /if \(bounded\.settled === 'deadline'\)/u)
  assert.match(open, /delivered no opening item within/u)
  // The bound's VALUE is the shared table's page-failure leaf, so the vendor face
  // and the page hint flip in the same window instead of drifting copies.
  assert.match(journal, /options\.openDeadlineMs \?\? LADDER_TABLES\.streamHealth\.loadingFailedMs/u)
})

test('the restart requires a probe-proven advance — no blind idle restart exists', () => {
  assert.match(checkStall, /const action = decideStreamStallAction\(/u)
  assert.match(checkStall, /if \(action !== 'probe'\) return/u)
  const restartAt = checkStall.indexOf('this.stream.restart()')
  const probeAt = checkStall.indexOf('await this.probeHostAdvance()')
  assert.ok(probeAt >= 0 && restartAt > probeAt, 'the restart must sit behind the probe result')
  assert.match(checkStall, /let advanced = false\s*\n\s*try \{\s*\n\s*advanced = await this\.probeHostAdvance\(\)/u, 'the probe result must be captured before any action')
  const advancedAt = checkStall.lastIndexOf('if (advanced)', restartAt)
  assert.ok(advancedAt >= 0 && advancedAt < restartAt, 'the restart must sit behind the advanced branch')
  assert.doesNotMatch(checkStall.slice(advancedAt, restartAt), /\}/u, 'nothing may close the advanced branch before the restart')
  assert.match(checkStall, /this\.quietProbes \+= 1/u, 'no advance (or a failed probe) must widen the cadence')
  assert.doesNotMatch(checkStall, /if \(await this\.probeHostAdvance/u, 'the probe must not be read straight into the condition')
  // The assistant stream advances under its own host revision while the durable
  // cursor can stand still; dropping that signal leaves a stalled text stream
  // un-rebuilt (the fork patch must keep BOTH advance proofs).
  assert.match(probe, /const compared = this\.options\.compare\(next\.value\.cursor, applied\)/u)
  assert.match(probe, /revision > this\.lastAssistantRevision/u)
  assert.match(journal, /assistantStream\?: \{ revision\?: unknown \}/u)
  // Removing the READ (keeping the type) left the suite green: pin the expression.
  assert.match(journal, /assistantStream\?\.revision \?\? record\?\.revision/u)
  // EVERY published value must advance the applied revision: a live stream delivers
  // replace/notification without a new opening, and a stale applied revision made
  // each probe claim an advance (periodic rebuild of a healthy long stream).
  assert.match(journal, /this\.noteAssistantRevision\(change\.page, this\.generation\)/u)
  assert.match(journal, /this\.noteAssistantRevision\(notification, this\.generation\)/u)
  assert.match(journal, /this\.noteAssistantRevision\(page, this\.generation\)/u)
  assert.doesNotMatch(checkStall.slice(0, probeAt), /this\.stream\.restart\(\)/u, 'nothing before the probe may restart the stream')
})

test('the user-initiated page read carries its own deadline', () => {
  const prepend = bodyOf(
    journal,
    '  async prepend(request: PageRequest): Promise<void> {',
    '  /** Replace the active physical generation while retaining the published window. */',
  )
  // The read owns a private AbortController composed with the lifetime signal and
  // races the shared deadline primitive; the lifetime signal alone is never used.
  assert.match(prepend, /const readAbort = new AbortController\(\)/u)
  assert.match(prepend, /const signal = AbortSignal\.any\(\[this\.stream\.signal, readAbort\.signal\]\)/u)
  assert.match(prepend, /this\.readPage\(request, this\.currentCursor\(\), signal\)/u)
  assert.match(prepend, /await withDeadline\(reading, \{\n\s*ms: this\.stallTiming\.readDeadlineMs/u)
  assert.match(prepend, /readAbort\.abort\(new Error\(/u)
  assert.match(prepend, /history read deadline/u)
  assert.match(prepend, /if \(bounded\.settled === 'deadline'\)/u)
  assert.doesNotMatch(prepend, /this\.readPage\(request, this\.currentCursor\(\), this\.stream\.signal\)/u, 'the read must not use the lifetime signal directly')
  assert.match(policy, /readDeadlineMs: 60_000/u)
})

test('the probe compares the Host opening cursor against the applied one', () => {
  assert.match(probe, /this\.follow\(this\.initialRequest, signal\)/u)
  // A sibling follow yields the FRAME (not a RemoteStreamItem): next.value is the
  // frame itself. Reading next.value.value would throw on every probe and kill the
  // restart arm silently — this lock plus the behavioral
  // probe test both pin the unwrapping.
  assert.match(probe, /next\.value\.type !== 'opened'/u)
  assert.match(probe, /if \(compared > 0\) return true/u)
  assert.doesNotMatch(probe, /next\.value\.value/u)
  assert.match(probe, /deadline\.abort\(new Error\('journal stall probe deadline'\)\)/u)
  // (W2): the probe deadline moved to the shared deadline primitive, which owns
  // the single timer and always clears it — the hand-written timer must not return.
  // The generic names the frame iterator result (RemoteJournalFrame), not the
  // RemoteStreamItem wrapper consume() unwraps.
  assert.match(probe, /await withDeadline<IteratorResult<RemoteJournalFrame<Entry, Cursor, Page, Notification>>>\(iterator\.next\(\), \{/u)
  assert.doesNotMatch(probe, /setTimeout\(/u, 'the hand-written probe timer is retired with the primitive')
  assert.doesNotMatch(probe, /this\.stream\.restart\(\)/u, 'the probe only reads')
})

test('a dormancy backoff keeps a quiet stream from probing forever', () => {
  assert.match(checkStall, /quietProbes: this\.quietProbes/u)
  assert.match(checkStall, /this\.quietProbes \+= 1/u, 'a probe without advance must widen the cadence')
  assert.match(checkStall, /this\.quietProbes = 0/u, 'an advanced probe resets the cadence')
  assert.match(journal, /if \(change\.type === 'replace' \|\| change\.type === 'append'\) \{\s*\n\s*this\.lastProgressAt = elapsedClock\(\)\s*\n\s*this\.quietProbes = 0\s*\n\s*\}\s*\n\s*this\.options\.publish\(change\)/u)
  assert.match(policy, /export function streamStallProbeIntervalMs\(quietProbes: number, timing: StreamStallTiming\): number/u)
  assert.match(policy, /export const MAX_STREAM_STALL_PROBE_INTERVAL_MS = 90_000/u)
})

test('only a replace/append publication advances the silence window', () => {
  // Prepending old history and cursorless assistant frames reach the view but do
  // NOT prove the durable tail advanced, so they must not postpone the probe.
  assert.match(
    journal,
    /private publish\(change: RemoteJournalChange<Page, Entry, Notification>\): void \{\s*\n\s*if \(this\.disposed\) return\s*\n\s*if \(change\.type === 'replace' \|\| change\.type === 'append'\) \{\s*\n\s*this\.lastProgressAt = elapsedClock\(\)\s*\n\s*this\.quietProbes = 0\s*\n\s*\}\s*\n\s*this\.options\.publish\(change\)/u,
  )
  assert.equal([...journal.matchAll(/this\.options\.publish\(/gu)].length, 1, 'publishing goes through the one progress-marking wrapper')
})

test('the watchdog timing stays a pure, import-free policy decision', () => {
  assert.doesNotMatch(policy, /^import /mu, 'the policy module must not import anything')
  assert.doesNotMatch(policy, /@deepseek-ai\//u, 'the policy module must not reach a vendor specifier')
  assert.match(policy, /export function decideStreamStallAction\(clock: StreamStallClock, timing: StreamStallTiming\): StreamStallAction/u)
  assert.match(journal, /import \{\s*\n\s*decideStreamStallAction,\s*\n\s*DEFAULT_STREAM_STALL_TIMING,\s*\n\s*type StreamStallTiming,\s*\n\} from '\.\/stream-stall-policy\.ts'/u)
})
