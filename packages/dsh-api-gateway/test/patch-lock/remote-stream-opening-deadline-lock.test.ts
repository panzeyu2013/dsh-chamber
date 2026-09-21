/**
 * Source lock for the chamber stream-opening patch (design 14 §D4, 2026-09
 * ui-chat freeze investigation).
 *
 * An upstream re-sync replaces `src/client/stream-client.ts` wholesale, so review
 * alone cannot hold the patch. Two regressions are pinned here:
 *
 *  - sending an open frame into a socket that was replaced or is already closing
 *    (RFC 6455 discards that payload silently, which is how a logical stream hung
 *    forever with no error to retry on), and
 *  - leaving a logical stream without an opening-item deadline, which is what let
 *    a lost opening frame surface as a permanent `chat.loadingHistory` hint (the
 *    upstream chat view renders exactly that string when `openState === 'loading'`).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = (relative: string): string => readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
const client = source('src/client/stream-client.ts')
const policy = source('src/client/remote-retry-policy.ts')

/** One logical-stream opener: from its signature to the next member's doc comment. */
function openerBody(sourceText: string): string {
  const start = sourceText.indexOf('  async *open(')
  const end = sourceText.indexOf('  /**\n   * Permanently stop the carrier', start)
  assert.ok(start >= 0 && end > start, 'the logical-stream opener must be locatable')
  return sourceText.slice(start, end)
}

test('the opener refuses a socket that was replaced or is closing before it sends', () => {
  const body = openerBody(client)
  assert.match(body, /if \(socket !== this\.socket \|\| socket\.readyState !== WebSocket\.OPEN\)/u)
  assert.match(body, /throw new RemoteStreamCarrierError\(/u, 'the refusal must be a carrier failure, not a plain Error')
  const guardAt = body.indexOf('socket !== this.socket')
  const sendAt = body.indexOf("this.send(socket, { type: 'open'")
  assert.ok(guardAt >= 0 && sendAt > guardAt, 'the send guard must precede the open frame')
})

test('the opener arms a first-item deadline through the pure policy and fails the inbox', () => {
  const body = openerBody(client)
  assert.match(body, /const openingKey = streamOpeningKey\(endpoint, payload\)/u)
  assert.match(body, /remoteStreamOpeningTimeoutMs\(this\.openingTimeouts\.get\(openingKey\) \?\? 0\)/u)
  assert.match(body, /inbox\.fail\(new RemoteStreamCarrierError\(/u)
  assert.match(body, /const streak = \(this\.openingTimeouts\.get\(openingKey\) \?\? 0\) \+ 1\s*\n\s*this\.openingTimeouts\.set\(openingKey, streak\)/u)
  assert.match(body, /this\.openingTimeouts\.delete\(openingKey\)/u, 'the first delivered frame (any type) resets that request widening')
  assert.match(body, /clearTimeout\(opening\)/u)
  assert.doesNotMatch(body, /generationAbort|AbortController/u, 'the deadline must not abort a generation signal')
})

test('an unanswered opening escalates from the retry lane to a PHYSICAL carrier rebuild', () => {
  // Second investigation (2026-09-21): the deadline alone could never leave the
  // state it detects. The retry lane above this module may only re-issue the same
  // request on the same generation, so a carrier that stays OPEN while delivering
  // nothing (silent socket, wedged generation source, stalled Host fiber) kept
  // chat.loadingHistory forever. The escalation must stay wired to the deadline.
  const body = openerBody(client)
  assert.match(body, /if \(shouldEscalateOpeningStall\(streak, this\.lastOpeningEscalationAt, Date\.now\(\)\)\) \{/u)
  assert.match(body, /this\.rebuildSilentCarrier\(endpoint, streak\)/u)
  assert.match(client, /private rebuildSilentCarrier\(endpoint: string, streak: number\): void \{/u)
  const rebuild = (() => {
    const start = client.indexOf('  private rebuildSilentCarrier(')
    const end = client.indexOf('  private failAll(', start)
    assert.ok(start >= 0 && end > start, 'rebuildSilentCarrier() must be locatable')
    return client.slice(start, end)
  })()
  assert.match(rebuild, /this\.socket = undefined/u, 'the rebuild must retire the current socket before failing its streams')
  assert.match(rebuild, /this\.failAll\(new RemoteStreamCarrierError\(/u, 'every pending stream must fail as an ordinary carrier error')
  assert.match(rebuild, /socket\.close\(4000, 'opening stall'\)/u)
  assert.match(rebuild, /this\.scheduleMaintain\(\)/u, 'the replacement connect must go through the re-scheduling heal')
  assert.match(rebuild, /'opening-stall-escalation'/u, 'the rebuild must leave one bounded fact')
  assert.match(policy, /export const REMOTE_STREAM_OPENING_ESCALATION_STREAK = 2/u)
  assert.match(policy, /export const REMOTE_STREAM_OPENING_ESCALATION_COOLDOWN_MS = 60_000/u)
})

test('a lane-commanded reconnect is marked and never widens the heal cadence', () => {
  assert.match(client, /class RemoteStreamReconnectRequest extends RemoteStreamCarrierError \{\}/u)
  const reconnect = (() => {
    const start = client.indexOf('  reconnect(): void {')
    const end = client.indexOf('  /**\n   * Open one logical stream', start)
    assert.ok(start >= 0 && end > start, 'reconnect() must be locatable')
    return client.slice(start, end)
  })()
  assert.match(reconnect, /new RemoteStreamReconnectRequest\('api gateway: Remote stream reconnect requested'\)/u)
  assert.match(reconnect, /this\.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS/u, 'the lane restart starts from the base cadence')
  assert.match(client, /if \(!\(error instanceof RemoteStreamReconnectRequest\)\) \{/u, 'only genuine failures may widen')
  assert.match(client, /'socket-attempt-failed'/u, 'a failed attempt must leave one bounded fact')
})

test('the WebSocket handshake itself is bounded and every settle path disarms it', () => {
  const connect = (() => {
    const start = client.indexOf('  private connect(): Promise<WebSocket> {')
    const end = client.indexOf('  /** chamber patch: instance method so the mux route', start)
    assert.ok(start >= 0 && end > start, 'connect() must be locatable')
    return client.slice(start, end)
  })()
  assert.match(connect, /clearHandshake\(\)/u)
  assert.match(connect, /const candidate = setTimeout\(\(\) => \{\s*\n\s*rejectCandidate\(new RemoteStreamCarrierError\(/u)
  assert.match(connect, /\}, REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS\)/u)
  assert.match(connect, /const rejectCandidate = \(error: Error\): void => \{\s*\n\s*settled = true\s*\n\s*clearHandshake\(\)/u, 'a rejected candidate must disarm the deadline')
  assert.match(connect, /const opened = \(\): void => \{\s*\n\s*settled = true\s*\n\s*clearHandshake\(\)/u, 'a completed handshake must disarm the deadline')
  assert.match(policy, /export const REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS = 30_000/u)
})

test('a lost socket self-heals through a RE-SCHEDULING mux maintain, never a one-shot', () => {
  const lost = (() => {
    const start = client.indexOf('  private lost(')
    const end = client.indexOf('  private scheduleMaintain(', start)
    assert.ok(start >= 0 && end > start, 'the lost() teardown must be locatable')
    return client.slice(start, end)
  })()
  assert.match(lost, /this\.forensics\?\.\('socket-lost', error\.message\)/u)
  assert.match(lost, /this\.scheduleMaintain\(\)/u, 'lost() must hand the heal to the scheduler')
  const scheduler = (() => {
    const start = client.indexOf('  private scheduleMaintain(): void {')
    const end = client.indexOf('  private stopHealTimer(', start)
    assert.ok(start >= 0 && end > start, 'scheduleMaintain() must be locatable')
    return client.slice(start, end)
  })()
  assert.match(scheduler, /if \(elapsed >= this\.maintainIntervalMs\)/u)
  assert.match(scheduler, /const timer = setTimeout\(\(\) => \{\s*\n\s*this\.healTimer = undefined\s*\n\s*this\.scheduleMaintain\(\)\s*\n\s*\}, this\.maintainIntervalMs - elapsed\)/u)
  assert.match(scheduler, /if \(this\.healTimer !== undefined\) return/u, 'exactly one pending heal timer')
  assert.match(client, /this\.maintainIntervalMs = Math\.min\(this\.maintainIntervalMs \* 2, REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS\)/u, 'a failed attempt must widen the interval')
  assert.match(
    client,
    /if \(this\.keepAlive === task\) this\.keepAlive = undefined\s*\n\s*this\.scheduleMaintain\(\)/u,
    'a failed connect must release its guard and re-schedule',
  )
  assert.match(client, /if \(this\.keepAlive === task\) this\.keepAlive = undefined/u, 'the guard release is identity-checked')
  assert.match(client, /this\.maintainIntervalMs = REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS\s*\n\s*this\.stopHealTimer\(\)/u, 'a successful open resets the cadence')
  assert.match(client, /this\.stopHealTimer\(\)\s*\n\s*this\.openingTimeouts\.clear\(\)/u, 'close() must stop the heal and prune the budget map')
  assert.match(client, /this\.lastMaintainAt = Date\.now\(\)/u, 'maintain() must stamp the throttle')
})

test('the deadline timer is always disarmed on the way out', () => {
  const body = openerBody(client)
  const finallyAt = body.lastIndexOf('} finally {')
  assert.ok(finallyAt > 0, 'the opener keeps its finally')
  assert.match(body.slice(finallyAt), /if \(opening !== undefined\) clearTimeout\(opening\)/u)
})

test('the opening budget stays a pure, import-free policy decision', () => {
  assert.doesNotMatch(policy, /^import /mu)
  assert.match(policy, /export function remoteStreamOpeningTimeoutMs\(streak: number\): number/u)
  assert.match(policy, /export const REMOTE_STREAM_OPENING_TIMEOUT_MS = 30_000/u)
  assert.match(policy, /export const REMOTE_STREAM_OPENING_TIMEOUT_MAX_MS = 120_000/u)
  assert.match(
    client,
    /import \{\s*\n\s*REMOTE_STREAM_HANDSHAKE_TIMEOUT_MS,\s*\n\s*REMOTE_STREAM_MAINTAIN_MAX_INTERVAL_MS,\s*\n\s*REMOTE_STREAM_MAINTAIN_MIN_INTERVAL_MS,\s*\n\s*remoteStreamOpeningTimeoutMs,\s*\n\s*shouldEscalateOpeningStall,\s*\n\s*streamOpeningKey,\s*\n\} from '\.\/remote-retry-policy\.ts'/u,
  )
})
