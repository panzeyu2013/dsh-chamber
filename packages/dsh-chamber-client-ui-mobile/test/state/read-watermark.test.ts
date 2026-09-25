/**
 * Mobile read-watermark reporter tests. Pure node:test — no DOM, no
 * network: the official list face, fetch and storage are all injected.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  READ_CLIENT_ID_KEY,
  READ_PATH,
  MIN_REPORT_INTERVAL_MS,
  SNAPSHOT_PATH,
  createReadWatermarkReporter,
  postReadMark,
  reportCurrentSession,
  resolveReadClientId,
  rowWatermark,
} from '../../src/client/read-watermark.ts'
import type { ReadWatermarkRow } from '../../src/client/read-watermark.ts'

/** Minimal fetch double: the reporter only reads `ok` and `json()`. */
function jsonFetch(body: unknown, ok = true): typeof fetch {
  return (async () => ({ ok, json: async () => body })) as unknown as typeof fetch
}

test('lockstep: mirror routes match the control-plane session-state protocol source', () => {
  // The phone reads the gateway mirror through these two paths; this package
  // cannot import control-plane, so the mirror literals are pinned against the
  // authoritative source text (the renderer pins the same authority from its
  // side in session-facts-source.test.ts).
  const source = readFileSync(new URL('../../../control-plane/src/session-state-protocol.ts', import.meta.url), 'utf8')
  assert.ok(source.includes("export const SESSION_STATE_PATH = '/chamber/session-state'"),
    'control-plane must declare SESSION_STATE_PATH = /chamber/session-state')
  assert.ok(source.includes('SESSION_STATE_READ_PATH = `${SESSION_STATE_PATH}/read`'),
    'control-plane must derive SESSION_STATE_READ_PATH from SESSION_STATE_PATH')
  assert.equal(SNAPSHOT_PATH, '/chamber/session-state')
  assert.equal(READ_PATH, '/chamber/session-state/read')
})

test('rowWatermark is the host-domain max(updatedAt, completedAt); unknown is 0', () => {
  assert.equal(rowWatermark({ updatedAt: 1_000, completedAt: 2_000 }), 2_000)
  assert.equal(rowWatermark({ updatedAt: 2_000, completedAt: 1_000 }), 2_000)
  assert.equal(rowWatermark({ updatedAt: 5 }), 5)
  assert.equal(rowWatermark({ completedAt: 7 }), 7)
  assert.equal(rowWatermark(undefined), 0)
  assert.equal(rowWatermark({}), 0)
  // Non-finite / non-number values never become a watermark.
  assert.equal(rowWatermark({ updatedAt: Number.NaN, completedAt: Number.POSITIVE_INFINITY }), 0)
  assert.equal(rowWatermark({ updatedAt: '9' } as unknown as ReadWatermarkRow), 0)
})

test('resolveReadClientId reuses a valid stored id, creates and persists otherwise', () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) }
  assert.equal(resolveReadClientId(storage, () => 'mobile-aaaaaaaa'), 'mobile-aaaaaaaa')
  assert.equal(store.get(READ_CLIENT_ID_KEY), 'mobile-aaaaaaaa')
  // Existing valid id wins over a fresh generator.
  assert.equal(resolveReadClientId(storage, () => 'mobile-bbbbbbbb'), 'mobile-aaaaaaaa')
  // Illegal stored id (too short / bad chars) is replaced.
  store.set(READ_CLIENT_ID_KEY, 'x')
  assert.equal(resolveReadClientId(storage, () => 'mobile-cccccccc'), 'mobile-cccccccc')
  // Throwing storage still yields a usable id (private mode).
  const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(resolveReadClientId(throwing, () => 'mobile-dddddddd'), 'mobile-dddddddd')
})

test('the reporter is monotonic and throttled, and dispose makes it inert', () => {
  let clock = 0
  const posted: Array<[string, number]> = []
  const reporter = createReadWatermarkReporter({ post: (s, w) => posted.push([s, w]), now: () => clock, minIntervalMs: 100 })
  reporter.report('s1', 10)
  assert.deepEqual(posted, [['s1', 10]])
  // Same or lower watermark is dropped (mirror merges with max anyway).
  reporter.report('s1', 10)
  reporter.report('s1', 9)
  assert.deepEqual(posted, [['s1', 10]])
  // Higher watermark inside the throttle window is not sent yet…
  clock = 50
  reporter.report('s1', 20)
  assert.deepEqual(posted, [['s1', 10]])
  // …but once the window elapsed the newer mark lands.
  clock = 200
  reporter.report('s1', 30)
  assert.deepEqual(posted, [['s1', 10], ['s1', 30]])
  // Unknown watermark / empty id are never reported.
  reporter.report('', 99)
  reporter.report('s2', 0)
  assert.equal(posted.length, 2)
  reporter.dispose()
  reporter.report('s3', 5)
  assert.equal(posted.length, 2)
})

test('a throwing transport never escapes the reporter', () => {
  const reporter = createReadWatermarkReporter({ post: () => { throw new Error('boom') } })
  assert.doesNotThrow(() => reporter.report('s1', 1))
})

test('postReadMark resolves false instead of rejecting on every failure shape', async () => {
  const ok = await postReadMark(jsonFetch({}, true), '/x', { clientId: 'c', sessionId: 's', readThrough: 1 })
  assert.equal(ok, true)
  const notOk = await postReadMark(jsonFetch({}, false), '/x', { clientId: 'c', sessionId: 's', readThrough: 1 })
  assert.equal(notOk, false)
  const rejected = await postReadMark(async () => { throw new Error('offline') }, '/x', { clientId: 'c', sessionId: 's', readThrough: 1 })
  assert.equal(rejected, false)
})

function mirrorResponse(sessions: Record<string, ReadWatermarkRow & { running?: boolean }>): typeof fetch {
  return jsonFetch({ sessions })
}

test('reportCurrentSession reads the mirror row of the presented rc.2 session', async () => {
  const posted: Array<[string, number]> = []
  const reporter = createReadWatermarkReporter({ post: (s, w) => posted.push([s, w]) })
  // The real rc.2 anchor: byId rows carrying retainedBy. The watermark path
  // must find the presented session (F3).
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: { 'sess-1': { retainedBy: {} }, 'sess-2': { retainedBy: { mainView: 1 } } },
      }),
    },
  }
  const seen: string[] = []
  const fetchImpl = (async (url: string) => {
    seen.push(url)
    return mirrorResponse({ 'sess-2': { updatedAt: 100, completedAt: 400 } })(url)
  }) as unknown as typeof fetch
  const reported = await reportCurrentSession({ sessions, fetchImpl, getClientId: () => 'mobile-x', reporter, base: '' })
  assert.equal(reported, 'sess-2', 'the mainView-retained rc.2 row is the reported session')
  // The mark is the mirror row's max — never a client clock.
  assert.deepEqual(posted, [['sess-2', 400]])
  assert.match(seen[0], /^\/chamber\/session-state\?clientId=mobile-x$/)
})

test('reportCurrentSession is a silent no-op without a presented session, a row, or a watermark', async () => {
  const posted: Array<[string, number]> = []
  const reporter = createReadWatermarkReporter({ post: (s, w) => posted.push([s, w]) })
  const base = { fetchImpl: mirrorResponse({}), getClientId: () => 'mobile-x', reporter, base: '' }
  assert.equal(await reportCurrentSession({ ...base, sessions: undefined }), null)
  assert.equal(await reportCurrentSession({ ...base, sessions: { list: { getSnapshot: () => ({}) } } }), null)
  assert.equal(await reportCurrentSession({ ...base, sessions: { list: { getSnapshot: () => ({ byId: {} }) } } }), null)
  // A zero-retention snapshot presents nothing: a pre-rc.2 `current` field on
  // the same snapshot must not revive it.
  const hybrid = { byId: { stale: { retainedBy: { mainView: 0 } } }, current: 'stale' }
  assert.equal(await reportCurrentSession({
    ...base,
    sessions: { list: { getSnapshot: () => hybrid } },
  }), null, 'a zero-retention snapshot presents nothing, with or without the removed current field')
  // Presented session unknown to the mirror → nothing is invented.
  assert.equal(await reportCurrentSession({
    ...base,
    sessions: { list: { getSnapshot: () => ({ byId: { gone: { retainedBy: { mainView: 1 } } } }) } },
  }), null)
  // Row present but no host watermark yet → nothing is invented.
  const zero = {
    ...base,
    fetchImpl: mirrorResponse({ cur: { running: true } }),
    sessions: { list: { getSnapshot: () => ({ byId: { cur: { retainedBy: { mainView: 1 } } } }) } },
  }
  assert.equal(await reportCurrentSession(zero), null)
  assert.deepEqual(posted, [])
})

test('reportCurrentSession swallows a rejected fetch and a non-2xx mirror', async () => {
  const posted: Array<[string, number]> = []
  const reporter = createReadWatermarkReporter({ post: (s, w) => posted.push([s, w]) })
  const sessions = {
    list: { getSnapshot: () => ({ byId: { cur: { retainedBy: { mainView: 1 } } } }) },
  }
  const rejecting = async () => { throw new Error('offline') }
  assert.equal(await reportCurrentSession({ sessions, fetchImpl: rejecting, getClientId: () => 'c', reporter }), null)
  const notFound = jsonFetch({}, false)
  assert.equal(await reportCurrentSession({ sessions, fetchImpl: notFound, getClientId: () => 'c', reporter }), null)
  assert.deepEqual(posted, [])
})

test('MIN_REPORT_INTERVAL_MS is a small positive throttle (documented default)', () => {
  assert.ok(Number.isInteger(MIN_REPORT_INTERVAL_MS) && MIN_REPORT_INTERVAL_MS > 0 && MIN_REPORT_INTERVAL_MS <= 30_000)
})
