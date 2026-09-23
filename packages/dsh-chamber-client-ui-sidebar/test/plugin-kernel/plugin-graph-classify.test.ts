/**
 * plugin-graph-classify unit tests (audit arch-03 P2-2): the SINGLE SOURCE of
 * the host boot-graph channel classification. Every HTTP status / envelope
 * branch and every Chinese message literal is pinned verbatim here, and the
 * consumer lock at the bottom keeps renderer/src/host-graph.ts (fetchHostGraph)
 * and client-core/src/plugin-graph-recheck.ts consuming this module instead of
 * re-growing a local status branch tree or a second copy of the copy.
 * Plain node:test, no dsh, no React, no fetch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  classifyPluginGraphOutcome, graphEntryImmediatelyMessage, graphEntryLabel,
  graphHttpFailureMessage, wrapGraphTransportFailure,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-graph-classify'
import type { UnaryPostOutcome } from '@dsh-chamber/dsh-chamber-client-core/wire-common'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/** One collected postUnary answer; the kernel reads the body only on 503/2xx. */
const outcome = (status: number, body: unknown, jsonError?: unknown): UnaryPostOutcome =>
  ({ status, ok: status >= 200 && status < 300, body, jsonError })

/** The boot wire's server-response envelope around one result payload. */
const envelope = (result: unknown): unknown => ({ type: 'server-response', rpcId: 'r1', result })

/** A 200 answer whose result.value carries `entries`. */
const graph = (entries: unknown[]): UnaryPostOutcome =>
  outcome(200, envelope({ ok: true, value: { rev: 'rev', entries } }))

test('a 503 instance_unavailable is the pre-ready verdict; every other 503 is a channel failure', () => {
  assert.deepEqual(
    classifyPluginGraphOutcome(outcome(503, { code: 'instance_unavailable', error: 'the instance is not ready' })),
    { kind: 'instance-unavailable' },
  )
  // A 503 whose body parse failed reads as no body -> no code -> channel failure.
  assert.deepEqual(classifyPluginGraphOutcome(outcome(503, undefined)),
    { kind: 'channel', state: 'graph-unreachable', message: '宿主启动图不可达：HTTP 503' })
  assert.deepEqual(classifyPluginGraphOutcome(outcome(503, { code: 'resource_exhausted' })),
    { kind: 'channel', state: 'graph-unreachable', message: '宿主启动图不可达：HTTP 503' })
})

test('the status classification: 404 is not-injected, every other non-2xx is graph-unreachable', () => {
  assert.deepEqual(classifyPluginGraphOutcome(outcome(404, {})),
    { kind: 'channel', state: 'not-injected', message: '宿主启动图不可达：HTTP 404' })
  for (const status of [400, 401, 403, 500, 502, 504]) {
    assert.deepEqual(classifyPluginGraphOutcome(outcome(status, {})),
      { kind: 'channel', state: 'graph-unreachable', message: `宿主启动图不可达：HTTP ${status}` }, String(status))
  }
  assert.equal(graphHttpFailureMessage(404), '宿主启动图不可达：HTTP 404')
})

test('a transport rejection folds into the shared unreachable copy', () => {
  assert.equal(wrapGraphTransportFailure(new Error('network down')), '宿主启动图不可达：network down')
  assert.equal(wrapGraphTransportFailure('boom'), '宿主启动图不可达：boom')
})

test('a 2xx body that is not valid JSON is malformed with the parse message', () => {
  assert.deepEqual(classifyPluginGraphOutcome(outcome(200, undefined, new Error('Unexpected token'))),
    { kind: 'malformed', message: '宿主启动图：envelope 不是合法 JSON：Unexpected token' })
  assert.deepEqual(classifyPluginGraphOutcome(outcome(200, undefined, 'boom')),
    { kind: 'malformed', message: '宿主启动图：envelope 不是合法 JSON：boom' })
})

test('an envelope without an object result is malformed', () => {
  for (const body of [{ rpcId: 'r1' }, null, 'nope', []]) {
    assert.deepEqual(classifyPluginGraphOutcome(outcome(200, body)),
      { kind: 'malformed', message: '宿主启动图：envelope 缺少 result' }, JSON.stringify(body))
  }
})

test('a result that is not ok carries the host error copy and the shared state regex', () => {
  const failed = (error: unknown): UnaryPostOutcome => outcome(200, envelope({ ok: false, error }))
  assert.deepEqual(classifyPluginGraphOutcome(failed({ code: 'boom', message: 'graph exploded' })),
    { kind: 'channel', state: 'graph-unreachable', message: '宿主启动图：graph 调用失败：graph exploded' })
  // message ?? code ?? 'unknown' (the boot's verbatim ?? chain).
  assert.deepEqual(classifyPluginGraphOutcome(failed({ code: 'internal_error' })),
    { kind: 'channel', state: 'graph-unreachable', message: '宿主启动图：graph 调用失败：internal_error' })
  assert.deepEqual(classifyPluginGraphOutcome(failed({ code: 'c', message: '' })),
    { kind: 'channel', state: 'graph-unreachable', message: '宿主启动图：graph 调用失败：' })
  // No error object at all -> 'unknown', still graph-unreachable.
  assert.deepEqual(classifyPluginGraphOutcome(failed(undefined)),
    { kind: 'channel', state: 'graph-unreachable', message: '宿主启动图：graph 调用失败：unknown' })
  // The state regex (wire-common classifyGraphChannelFailure) reads code + message.
  assert.deepEqual(classifyPluginGraphOutcome(failed({ code: 'rpc_failed', message: 'unknown method clientGraph/graph' })),
    { kind: 'channel', state: 'not-injected', message: '宿主启动图：graph 调用失败：unknown method clientGraph/graph' })
  assert.deepEqual(classifyPluginGraphOutcome(failed({ code: 'not_found' })),
    { kind: 'channel', state: 'not-injected', message: '宿主启动图：graph 调用失败：not_found' })
  // An ARRAY result passes the typeof-object gate and falls into the ok !== true branch.
  assert.deepEqual(classifyPluginGraphOutcome(outcome(200, envelope(['not', 'a', 'record']))),
    { kind: 'channel', state: 'graph-unreachable', message: '宿主启动图：graph 调用失败：unknown' })
})

test('a value without an entries array is malformed', () => {
  for (const value of [undefined, null, 'nope', {}, { entries: 'nope' }]) {
    assert.deepEqual(classifyPluginGraphOutcome(outcome(200, envelope({ ok: true, value }))),
      { kind: 'malformed', message: '宿主启动图：result.value.entries 必须是数组' }, JSON.stringify(value))
  }
})

test('a non-object entry and a missing id/url/rev are malformed with the boot label', () => {
  for (const entry of [42, null, 'junk', true]) {
    assert.deepEqual(classifyPluginGraphOutcome(graph([entry])),
      { kind: 'malformed', message: '宿主启动图：entry 不是对象' }, JSON.stringify(entry))
  }
  // A string id is labelled compactly; anything else by its JSON (boot label).
  assert.deepEqual(classifyPluginGraphOutcome(graph([{ id: 'x', url: '/plugins/x' }])),
    { kind: 'malformed', message: '宿主启动图：entry "x" 必须携带 string id/url/rev' })
  const rest = { id: 7, url: '/plugins/x', rev: 'r' }
  assert.deepEqual(classifyPluginGraphOutcome(graph([rest])),
    { kind: 'malformed', message: `宿主启动图：entry ${JSON.stringify(rest)} 必须携带 string id/url/rev` })
  assert.equal(graphEntryLabel({ id: 'x' }), '"x"')
  assert.equal(graphEntryLabel({ id: 7 }), '{"id":7}')
  assert.equal(graphEntryLabel('nope'), '"nope"')
  assert.equal(graphEntryImmediatelyMessage({ id: 'x' }),
    '宿主启动图：entry "x" 的 immediately 必须是 boolean')
})

test('a valid envelope resolves the validated entries', () => {
  const entries = [
    { id: 'a', url: '/plugins/a', rev: 'r1' },
    { id: 'b', url: '/plugins/b', rev: 'r2', external: ['@scope/x/client'], immediately: true },
  ]
  assert.deepEqual(classifyPluginGraphOutcome(graph(entries)), { kind: 'ok', entries })
})

test('consumer lock: both consumers import this module and keep no local status branch or literal', () => {
  const renderer = normalize(stripComments(
    readFileSync(new URL('../../../renderer/src/host-graph.ts', import.meta.url), 'utf8'),
  ))
  const recheck = normalize(stripComments(
    readFileSync(new URL('../../../dsh-chamber-client-core/src/plugin-graph-recheck.ts', import.meta.url), 'utf8'),
  ))
  assert.match(renderer, /from '@dsh-chamber\/dsh-chamber-client-core\/plugin-graph-classify'/, 'the renderer fetch must consume the single source')
  assert.match(recheck, /from '\.\/plugin-graph-classify\.ts'/, 'the recheck must consume the single source')
  for (const [name, source] of [['renderer', renderer], ['recheck', recheck]] as const) {
    assert.match(source, /classifyPluginGraphOutcome\(/, name + ' must classify through the shared single source')
    assert.doesNotMatch(source, /宿主启动图/, name + ' must not carry its own copy of the message literals')
    assert.doesNotMatch(source, /outcome\.status/, name + ' must not branch on the HTTP status locally')
    assert.doesNotMatch(source, /classifyGraphChannelFailure/, name + ' must not classify the envelope error locally')
  }
})
