/**
 * Source lock for the chamber journal silence watchdog (design 14 §D4).
 *
 * `src/client/journal-stream.ts` is upstream-verbatim plus this one patch, so an
 * upstream re-sync replaces it wholesale and review alone cannot hold the change.
 * The lock fails loudly when the patched file loses:
 *
 *  - the watchdog arm/disarm wiring, or
 *  - the hard rule that a restart happens ONLY after a probe proves the Host
 *    cursor advanced (a blind idle restart is exactly what design 14 §D4 rejected).
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
  assert.doesNotMatch(checkStall.slice(0, probeAt), /this\.stream\.restart\(\)/u, 'nothing before the probe may restart the stream')
})

test('the user-initiated page read carries its own deadline', () => {
  const prepend = bodyOf(
    journal,
    '  async prepend(request: PageRequest): Promise<void> {',
    '  /**\n   * chamber patch: bound one user-initiated page read.',
  )
  assert.match(prepend, /this\.readPage\(request, this\.currentCursor\(\), this\.prependSignal\(\)\)/u)
  assert.match(prepend, /this\.prependSignal\(\)/u, 'the read must not use the lifetime signal directly')
  assert.doesNotMatch(prepend, /this\.readPage\(request, this\.currentCursor\(\), this\.stream\.signal\)/u, 'the read must not use the lifetime signal directly')
  assert.match(journal, /return AbortSignal\.any\(\[this\.stream\.signal, AbortSignal\.timeout\(this\.stallTiming\.readDeadlineMs\)\]\)/u)
  assert.match(policy, /readDeadlineMs: 60_000/u)
})

test('the probe compares the Host opening cursor against the applied one', () => {
  assert.match(probe, /this\.follow\(this\.initialRequest, signal\)/u)
  // A sibling follow yields the FRAME (not a RemoteStreamItem): next.value is the
  // frame itself. Reading next.value.value would throw on every probe and kill the
  // restart arm silently — this lock plus the behavioral
  // probe test both pin the unwrapping.
  assert.match(probe, /next\.value\.type !== 'opened'/u)
  assert.match(probe, /this\.options\.compare\(next\.value\.cursor, applied\) > 0/u)
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
  assert.match(journal, /this\.lastProgressAt = Date\.now\(\)\s*\n\s*this\.quietProbes = 0\s*\n\s*this\.options\.publish\(change\)/u)
  assert.match(policy, /export function streamStallProbeIntervalMs\(quietProbes: number, timing: StreamStallTiming\): number/u)
  assert.match(policy, /export const MAX_STREAM_STALL_PROBE_INTERVAL_MS = 90_000/u)
})

test('every published item advances the silence window', () => {
  assert.match(
    journal,
    /private publish\(change: RemoteJournalChange<Page, Entry, Notification>\): void \{\s*\n\s*this\.lastProgressAt = Date\.now\(\)\s*\n\s*this\.quietProbes = 0\s*\n\s*this\.options\.publish\(change\)/u,
  )
  assert.equal([...journal.matchAll(/this\.options\.publish\(/gu)].length, 1, 'publishing goes through the progress-marking wrapper')
})

test('the watchdog timing stays a pure, import-free policy decision', () => {
  assert.doesNotMatch(policy, /^import /mu, 'the policy module must not import anything')
  assert.doesNotMatch(policy, /@deepseek-ai\//u, 'the policy module must not reach a vendor specifier')
  assert.match(policy, /export function decideStreamStallAction\(clock: StreamStallClock, timing: StreamStallTiming\): StreamStallAction/u)
  assert.match(journal, /import \{\s*\n\s*decideStreamStallAction,\s*\n\s*DEFAULT_STREAM_STALL_TIMING,\s*\n\s*type StreamStallTiming,\s*\n\} from '\.\/stream-stall-policy\.ts'/u)
})
