/**
 * `forward.openInBrowser` main-side composition tests (design 28 §7/§8.2).
 *
 * The security ruling this suite pins: the renderer never passes a URL. The
 * registrar normalizes a same-origin relative path (or `/`) and hands the
 * manager `{ sourceId, sourceFingerprint, id, path }` only; the manager composes
 * `scheme://alias:localPort + path` and awaits `edges.openExternal`. So:
 *   - every absolute/protocol-relative/userinfo/control-byte/oversized path is
 *     refused with `invalid_path` before the manager is entered;
 *   - extra payload keys (a smuggled `url` / `localUrl` / `scheme`) are dropped,
 *     never relayed;
 *   - the fragment is dropped and the query survives (wire contract);
 *   - the typed failures (`open_failed` / `rate_limited` / `forward_stale` /
 *     `forward_not_bound`) are relayed unchanged — the launcher owns the copy;
 *   - the open leg is re-proved across the await boundary like the other three.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { IPC_CHANNELS } from '../../ipc-events.ts'
import type { ForwardOpenArgs } from '../../remote-forward-manager.ts'
import {
  FakeForwardService,
  FINGERPRINT,
  FORWARD_ID,
  ForwardIpcHarness,
  SOURCE_ID,
} from './forward-ipc-fixture.ts'

function openPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sourceId: SOURCE_ID, sourceFingerprint: FINGERPRINT, id: FORWARD_ID, ...overrides }
}

test('the path is normalized to a same-origin relative path (fragment dropped, query kept)', async () => {
  const cases: Array<[input: unknown, expected: string]> = [
    [undefined, '/'],
    [null, '/'],
    ['/', '/'],
    ['/app', '/app'],
    ['app', '/app'],
    ['/app?x=1&y=2', '/app?x=1&y=2'],
    ['/app#frag', '/app'],
    ['/a/../b', '/b'],
    // design 28 §3 ceiling: a 4096-character same-origin path is accepted.
    ['/' + 'a'.repeat(4095), '/' + 'a'.repeat(4095)],
  ]
  for (const [input, expected] of cases) {
    const harness = new ForwardIpcHarness()
    const service = new FakeForwardService()
    harness.install(service)
    assert.deepEqual(await harness.invoke(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, openPayload({ path: input })),
      { ok: true }, String(input))
    assert.equal((service.calls[0]?.args as ForwardOpenArgs).path, expected, String(input))
  }
})

const INVALID_PATHS: Array<[name: string, path: unknown]> = [
  ['absolute URL', 'http://evil.example/'],
  ['protocol-relative', '//evil.example/x'],
  ['userinfo URL', 'http://u:p@127.0.0.1/'],
  ['encoded control bytes', '/%0d%0a'],
  ['raw CR/LF', '/x\r\ny'],
  ['oversized path', '/' + 'a'.repeat(4096)],
  ['non-string path', 42],
  ['object path', {}],
]

test('every non-relative path is refused with invalid_path before the manager is entered', async () => {
  for (const [name, path] of INVALID_PATHS) {
    const harness = new ForwardIpcHarness()
    const service = new FakeForwardService()
    harness.install(service)
    assert.deepEqual(
      await harness.invoke(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, openPayload({ path })),
      { ok: false, error: { code: 'invalid_path', detail: null } },
      name,
    )
    assert.deepEqual(service.calls, [], name + ': the manager must not be entered')
  }
})

test('a smuggled URL/localUrl/scheme key is dropped, never relayed', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)
  await harness.invoke(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, openPayload({
    path: '/app',
    url: 'http://127.0.0.1:5173/steal',
    localUrl: 'http://127.0.0.7:5173/',
    scheme: 'file',
    sourceFingerprint2: 'ignored',
  }))
  const args = service.calls[0]?.args as ForwardOpenArgs
  assert.deepEqual(Object.keys(args).sort(), ['id', 'path', 'sourceFingerprint', 'sourceId'])
  assert.equal(JSON.stringify(args).includes('://'), false, 'no URL may cross this boundary')
})

test('the typed open failures are relayed unchanged (launcher owns the copy)', async () => {
  const failures = ['open_failed', 'rate_limited', 'forward_stale', 'forward_not_bound'] as const
  for (const code of failures) {
    const harness = new ForwardIpcHarness()
    const service = new FakeForwardService()
    service.openResult = { ok: false, error: { code, detail: null } }
    harness.install(service)
    assert.deepEqual(
      await harness.invoke(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, openPayload({ path: '/app' })),
      { ok: false, error: { code, detail: null } },
      code,
    )
  }
})

test('the open leg is re-proved across the await boundary (source_changed)', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  service.beforeResolve = () => harness.retire(SOURCE_ID)
  harness.install(service)
  assert.deepEqual(
    await harness.invoke(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, openPayload({ path: '/app' })),
    { ok: false, error: { code: 'source_changed', detail: null } },
  )
})

test('a bad forward id is refused before path normalization (forward_not_found)', async () => {
  const harness = new ForwardIpcHarness()
  const service = new FakeForwardService()
  harness.install(service)
  for (const id of ['nope', 'fwd-XYZ', '', 7]) {
    assert.deepEqual(
      await harness.invoke(IPC_CHANNELS.FORWARD_OPEN_IN_BROWSER, openPayload({ id, path: 'http://evil.example/' })),
      { ok: false, error: { code: 'forward_not_found', detail: null } },
      String(id),
    )
  }
  assert.deepEqual(service.calls, [])
})
