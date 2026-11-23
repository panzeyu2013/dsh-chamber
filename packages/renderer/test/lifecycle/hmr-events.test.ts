/**
 * Per-instance client-plugin events over the authenticated Remote stream
 * (0.2.3-alpha.1 decision C / M1 retirement, PLAN §12.3.3).
 *
 * The bridge's whole job is the translation the retired page-channel `pluginGraph` topic
 * used to perform server-side: mount the HMR client's generated `pluginEvents` contribution
 * on THIS instance's ctx, follow it as a baseline-and-increment Remote stream, and hand the
 * live reconciler the same JSON frame texts it already parses
 * (`live-graph.ts parsePluginEventFrame`). Everything here runs against fake ctx faces —
 * the generated contribution and the snapshot stream are the two injectable seams, so this
 * test never resolves a build artifact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  hmrFrameToPluginEventText, subscribeHmrPluginEvents, type HmrEventsContext, type SnapshotStreamOptions,
} from '../../src/hmr-events.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const readSource = (rel: string): string =>
  stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))

test('hmrFrameToPluginEventText: upstream frames become the reconciler wire text', () => {
  assert.equal(hmrFrameToPluginEventText({ type: 'baseline', graph: { rev: 'g', entries: [] } }),
    JSON.stringify({ type: 'graph', graph: { rev: 'g', entries: [] } }))
  assert.equal(hmrFrameToPluginEventText({ type: 'graph', graph: { rev: 'g2', entries: [] } }),
    JSON.stringify({ type: 'graph', graph: { rev: 'g2', entries: [] } }))
  assert.equal(hmrFrameToPluginEventText({ type: 'rebuilt', id: '@scope/p', rev: 'r2' }),
    JSON.stringify({ type: 'rebuilt', id: '@scope/p', rev: 'r2' }))
  // Forward compatibility: a newer Host's unknown increment is dropped, never a page failure.
  assert.equal(hmrFrameToPluginEventText({ type: 'future-frame' } as never), null)
})

/** A fake ctx + stream harness: the contribution mount, the physical stream and the
 *  access gate are all observable, and one snapshot-stream stub forwards frames. */
function harness() {
  const calls: string[] = []
  const items: string[] = []
  const errors: { code: string; message: string }[] = []
  const opens: number[] = []
  let snapshotOptions: SnapshotStreamOptions | undefined
  let streamOpened = 0
  let unmounted = 0
  let controlDisposed = 0
  let accessReleased = 0
  let streamOptions: { open(signal: AbortSignal): AsyncIterable<unknown> } | undefined
  const frameQueue: unknown[] = []
  let accessCallback: (() => () => void) | undefined
  // Structural fake: the real remote face is generic (`$stream<Item>`); the fixture's
  // minimal stream object is cast once here instead of re-typing every member.
  const ctx = {
    remote: {
      async $mount(_contribution: unknown) {
        calls.push('mount')
        return async () => { unmounted += 1 }
      },
      $stream<Item>(options: { name: string; open(signal: AbortSignal): AsyncIterable<Item> }) {
        streamOptions = options as unknown as { open(signal: AbortSignal): AsyncIterable<unknown> }
        calls.push('stream:' + options.name)
        streamOpened += 1
        return {
          [Symbol.asyncIterator]() { return this },
          next: async () => ({ done: true, value: undefined as never }),
          restart: () => {},
        }
      },
    },
    remoteAccess: {
      whenAccess(action: string, callback: () => () => void) {
        calls.push('whenAccess:' + action)
        accessCallback = callback
        return () => { accessReleased += 1 }
      },
    },
    get(name: string) {
      assert.equal(name, 'remote.pluginEvents')
      return {
        async *follow() {
          for (const frame of frameQueue) yield frame as never
        },
      }
    },
  } as unknown as HmrEventsContext
  const seams = {
    async loadContribution() { calls.push('load'); return { package: '@deepseek-ai/dsh-client-hmr' } },
    createSnapshotStream(_stream: unknown, options: SnapshotStreamOptions) {
      snapshotOptions = options
      calls.push('snapshot')
      return {
        start() { calls.push('start') },
        async dispose() { controlDisposed += 1 },
        restart() {},
      }
    },
  }
  return {
    ctx, seams, calls, items, errors, opens,
    get snapshotOptions() { return snapshotOptions },
    get streamOpened() { return streamOpened },
    get unmounted() { return unmounted },
    get controlDisposed() { return controlDisposed },
    get accessReleased() { return accessReleased },
    get streamOptions() { return streamOptions },
    frameQueue,
    install(): () => void {
      return accessCallback!()
    },
    async tick(): Promise<void> {
      // Let the mount/stream arm's awaits settle (microtasks only).
      for (let i = 0; i < 8; i += 1) await Promise.resolve()
    },
  }
}

test('a Host reload error is mapped to a carrier loss so the stream reconnects (upstream parity)', async () => {
  const h = harness()
  // Replace the mounted namespace with one whose follow throws the reloading error.
  ;(h.ctx as unknown as { get(name: string): unknown }).get = (name: string) => {
    assert.equal(name, 'remote.pluginEvents')
    return {
      async *follow() {
        throw Object.assign(new Error('host reloading'), { code: 'gateway/invocation-unavailable' })
      },
    }
  }
  const subscription = subscribeHmrPluginEvents(h.ctx, handlers(h), h.seams)
  h.install()
  await h.tick()
  assert.ok(h.streamOptions, 'the stream was created')
  await assert.rejects(
    async () => { for await (const _frame of h.streamOptions!.open(new AbortController().signal)) void _frame },
    (error: unknown) => (error as { code?: string }).code === 'gateway/carrier-lost',
    'reloading codes become carrier losses (the api-gateway $stream reconnects)',
  )
  subscription.close()
  await h.tick()
})

const handlers = (h: ReturnType<typeof harness>) => ({
  onItem: (data: string) => { h.items.push(data) },
  onOpen: () => { h.opens.push(1) },
  onError: (code: string, message: string) => { h.errors.push({ code, message }) },
})

test('subscribeHmrPluginEvents: mounts, streams, forwards baseline/graph/rebuilt as JSON', async () => {
  const h = harness()
  const subscription = subscribeHmrPluginEvents(h.ctx, handlers(h), h.seams)
  assert.deepEqual(h.calls, ['whenAccess:pluginEvents/follow'], 'the arm is gated by remoteAccess')
  h.install()
  await h.tick()
  assert.deepEqual(h.calls.slice(1), ['load', 'mount', 'stream:Plugin events', 'snapshot', 'start'],
    'contribution mount → $stream → snapshot consumer')
  assert.equal(h.streamOpened, 1)
  assert.equal(h.opens.length, 1, 'onOpen marks the fresh generation')

  assert.notEqual(h.snapshotOptions, undefined)
  // Baseline replaces; graph/rebuilt increments forward; unknown frames drop.
  h.snapshotOptions!.replace({ type: 'baseline', graph: { rev: 'g', entries: [{ id: '@scope/a' }] } })
  h.snapshotOptions!.update({ type: 'graph', graph: { rev: 'g2', entries: [] } })
  h.snapshotOptions!.update({ type: 'rebuilt', id: '@scope/a', rev: 'r2' })
  h.snapshotOptions!.update({ type: 'future-frame' })
  assert.deepEqual(h.items, [
    JSON.stringify({ type: 'graph', graph: { rev: 'g', entries: [{ id: '@scope/a' }] } }),
    JSON.stringify({ type: 'graph', graph: { rev: 'g2', entries: [] } }),
    JSON.stringify({ type: 'rebuilt', id: '@scope/a', rev: 'r2' }),
  ])
  assert.equal(h.snapshotOptions!.isSnapshot({ type: 'baseline' }), true)
  assert.equal(h.snapshotOptions!.isSnapshot({ type: 'rebuilt' }), false)

  // A terminal stream failure reaches the reconciler as an onError (recovery is the stream's).
  h.snapshotOptions!.failed(new Error('carrier lost'))
  assert.equal(h.errors.length, 1)
  assert.equal(h.errors[0]!.code, 'stream-failed')

  // close(): idempotent; disposes the consumer, unmounts the namespace, releases the gate.
  subscription.close()
  subscription.close()
  await h.tick()
  assert.equal(h.controlDisposed, 1)
  assert.equal(h.unmounted, 1)
  assert.equal(h.accessReleased, 1, 'closing releases the access observation')
})

test('access revoke then regrant re-arms the stream (whenAllowed semantics)', async () => {
  const h = harness()
  const subscription = subscribeHmrPluginEvents(h.ctx, handlers(h), h.seams)
  const release1 = h.install()
  await h.tick()
  assert.equal(h.streamOpened, 1, 'first grant mounts one generation')
  release1()
  await h.tick()
  assert.equal(h.unmounted, 1, 'revocation tears down the current generation')
  const release2 = h.install()
  await h.tick()
  assert.equal(h.streamOpened, 2, 'a later grant re-arms instead of being latched off forever')
  release2()
  subscription.close()
  await h.tick()
})

test('subscribeHmrPluginEvents: no remoteAccess ⇒ no mount, live sync stays off', async () => {
  const h = harness()
  const bare: HmrEventsContext = { remote: h.ctx.remote, get: h.ctx.get }
  const subscription = subscribeHmrPluginEvents(bare, handlers(h), h.seams)
  await h.tick()
  assert.deepEqual(h.calls, [], 'without the access gate nothing arms (boot stays the authority)')
  subscription.close()
})

test('subscribeHmrPluginEvents: close before/during arming tears down without leaking', async () => {
  const h = harness()
  const subscription = subscribeHmrPluginEvents(h.ctx, handlers(h), h.seams)
  // The access gate installs the arm; close DURING the arm (before its awaits settle).
  const release = h.install()
  subscription.close()
  await h.tick()
  assert.equal(h.unmounted <= 1, true, 'a racing close never mounts twice or leaks a namespace')
  assert.equal(h.controlDisposed <= 1, true)
  release()
})

test('wiring: the shell arms the bridge per instance and the official HMR row stays skipped', () => {
  const shell = readSource('../../src/shell.ts')
  assert.match(shell, /import \{ subscribeHmrPluginEvents, type HmrEventsSeams \} from '\.\/hmr-events\.ts'/)
  assert.match(shell, /const pluginEventsSubscribe = options\.pluginEventsSubscribe === undefined\s*\n\s*\? subscribeHmrPluginEvents/)
  assert.match(shell, /subscribePluginGraph: handlers => pluginEventsSubscribe\(liveCtx, handlers, options\.pluginEventsSeams\)/)
  assert.doesNotMatch(shell, /EventSource/, 'the renderer has no EventSource transport')
  assert.doesNotMatch(shell, /subscribePageChannel/, 'the page-channel pluginGraph transport is gone')
  const covered = readSource('../../src/chamber-covered.ts')
  assert.match(covered, /'@deepseek-ai\/dsh-client-hmr'/, 'the official HMR row stays a covered skip')
})
