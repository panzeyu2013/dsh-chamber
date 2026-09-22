/**
 * Source lock for the chamber carrier-retry patch (design 14 §D4).
 * An upstream re-sync replaces `src/client/remote-stream.ts` wholesale, so review
 * alone cannot hold the patch: this lock fails loudly when the replayed file drops
 * the live-generation retry branch (dropping it means a second rapid carrier
 * failure => gateway/internal => a failEventStream() latch with no retry).
 * `REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS` and reports its expiry through the
 * carrier seam. Upstream's timer-less wait parked every new logical stream on a
 * parked lane — the `openState='loading'` forever shape with no error edge and
 * no reopen attempt. The locks below pin the bound AND the upstream pieces the
 * patch must keep (snapshot probe, generation subscription, abort wording).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (relative: string): string => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const carrier = source('src/client/remote-stream.ts')
const policy = source('src/client/remote-retry-policy.ts')

/**
 * The live-generation branch body: from the snapshot guard to the no-generation
 * wait. Asserted structurally (no `throw` at all) rather than by matching
 * upstream's exact wording — a re-sync may reformat, but it must not reintroduce
 * a terminal escape for a carrier that keeps failing while the lane is up.
 */
function liveGenerationBranch(sourceText: string): string {
  const start = sourceText.indexOf('if (connection.generation.getSnapshot() !== undefined) {')
  // The no-generation wait begins at its Promise (it is the operation the
  // shared bound races, so the exact generic does not name the upstream outcome).
  const end = sourceText.indexOf('new Promise', start)
  assert.ok(start >= 0 && end > start, 'the live-generation branch must be locatable in the carrier')
  return sourceText.slice(start, end)
}

test('the live-generation branch never throws — a keep-failing carrier cannot escape terminally', () => {
  const branch = liveGenerationBranch(carrier)
  assert.doesNotMatch(branch, /\bthrow\b/u, 'no terminal escape may stay in the live-generation branch')
  assert.match(branch, /remoteStreamRetryDelayMs\(attempt\)/u, 'the branch paces through the pure policy')
  assert.match(branch, /await delayRemoteStreamRetry\(delayMs, signal\)/u, 'the branch waits the bounded backoff')
  assert.match(branch, /\breturn\b/u, 'the branch returns to the reopen loop')
  assert.doesNotMatch(carrier, /error: RemoteStreamCarrierError,\s*\n\s*attempt: number/u, 'the retry waiter no longer takes the carrier error')
})

test('the reopen loop keeps the revision/abort guards around the retry', () => {
  assert.match(carrier, /await waitForRemoteStreamRetry\(this\.connection, attempt, signal\)/u)
  assert.match(
    carrier,
    /import \{[\s\S]*?remoteStreamRetryDelayMs[\s\S]*?\} from '\.\/remote-retry-policy\.ts'/u,
    'the pacing math must stay imported from the pure policy module',
  )
  assert.match(carrier, /if \(revision !== this\.revision\) continue\s*\n\s*attempt\+\+/u, 'a superseded generation must not start an episode')
  assert.match(
    carrier,
    /const retryOutcome = await waitForRemoteStreamRetry\(/u,
    'the wait outcome is captured so an expired bound can be published',
  )
  assert.match(
    carrier,
    /if \(retryOutcome === 'expired'\) \{[\s\S]*?this\.options\.carrierFailed\?\.\(/u,
    'an expired bound is a retryable carrier condition: it must ride the carrier seam, not stay invisible',
  )
})

test('the abortable wait lives in the import-free policy module with the shared wording', () => {
  assert.match(
    carrier,
    /import \{[\s\S]*?delayRemoteStreamRetry,[\s\S]*?remoteStreamRetryDelayMs,[\s\S]*?REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS,[\s\S]*?\} from '\.\/remote-retry-policy\.ts'/u,
    'the abortable backoff and the no-generation bound are both imported from the policy module',
  )
  assert.match(policy, /export function delayRemoteStreamRetry\(delayMs: number, signal: AbortSignal\): Promise<void>/u)
  assert.match(policy, /clearTimeout\(timer\)/u)
  assert.match(policy, /new Error\('Remote stream retry aborted', \{ cause: signal\.reason \}\)/u)
  // One wording per module: the carrier keeps upstream's no-generation wait, the
  // policy owns the live-generation one — the abort text users read is identical.
  assert.equal([...carrier.matchAll(/'Remote stream retry aborted'/gu)].length, 1, 'carrier keeps exactly the upstream wording')
  assert.equal([...policy.matchAll(/'Remote stream retry aborted'/gu)].length, 1, 'policy owns exactly one wording')
})

test('the no-generation wait keeps the upstream probe AND is bounded', () => {
  //  the wait's SHAPE lives in the shared primitive, so the locks below pin the
  // pieces that carry the behaviour:
  //   - the push subscription and the snapshot probe are the condition;
  //   - the bound is the exported policy constant, passed to withDeadline;
  //   - expiry resolves 'expired' (never rejects).
  // "Exactly one timer, always cleared" is not this lock's job: the primitive
  // owns it, and test/async-op/async-op.test.ts pins it there. What must NOT happen
  // is the bound silently disappearing - hence the withDeadline assertion.
  assert.match(carrier, /dispose = connection\.generation\.subscribe\(inspect\)/u)
  assert.match(carrier, /if \(connection\.generation\.getSnapshot\(\) !== undefined\) resolve\(\)/u)
  assert.match(
    carrier,
    /await withDeadline\(generationArrived, \{/u,
    'the bound must be the shared primitive (it arms one timer and always clears it)',
  )
  assert.match(
    carrier,
    /ms: REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS/u,
    'the wait must be bounded by the exported policy constant',
  )
  assert.match(carrier, /onExpire: \(\) => 'expired' as const/u, 'expiry resolves (reopen), it never rejects terminally')
  assert.match(
    policy,
    /export const REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS = 30_000/u,
    'the bound lives in the import-free policy module',
  )
})

test('non-carrier escapes are still marked terminal for consumers', () => {
  assert.match(carrier, /remoteErrorOf\(error\) \?\? new RemoteError\(\s*'gateway\/internal'/u)
  assert.match(carrier, /if \(!\(error instanceof RemoteStreamCarrierError\)\) throw terminalStreamFailure\(error\)/u)
})

test('the pacing policy stays import-free so it is unit-testable without the vendor graph', () => {
  assert.doesNotMatch(policy, /^import /mu, 'the policy module must not import anything')
  assert.doesNotMatch(policy, /@deepseek-ai\//u, 'the policy module must not reach a vendor specifier')
  assert.match(policy, /export function remoteStreamRetryDelayMs\(attempt: number\): number/u)
})
