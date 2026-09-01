import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dedupeCompleteEdges, detectNotificationEdges } from '../src/notification-edges.ts'

// ---- 首报播种：prev === undefined 只播种，任何 next 状态都不发事件 ----

test('first report seeds silently: empty next emits nothing', () => {
  assert.deepEqual(detectNotificationEdges(undefined, {}), [])
})

test('first report seeds silently: running / completed / pending states all emit nothing', () => {
  assert.deepEqual(detectNotificationEdges(undefined, { a: { running: true } }), [])
  assert.deepEqual(detectNotificationEdges(undefined, { a: { completed: true } }), [])
  assert.deepEqual(detectNotificationEdges(undefined, { a: { pending: 'question' } }), [])
  assert.deepEqual(detectNotificationEdges(undefined, { a: { pending: 'approval' } }), [])
  assert.deepEqual(
    detectNotificationEdges(
      undefined,
      { a: { running: true, completed: true, pending: 'plan-review' }, b: { pending: 'question' } },
    ),
    [],
  )
})

// ---- complete ----

test('complete: running true→false edge', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: { running: true } }, { a: { running: false } }),
    [{ sessionId: 'a', kind: 'complete' }],
  )
})

test('complete: completed absent→true and false→true edges', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: {} }, { a: { completed: true } }),
    [{ sessionId: 'a', kind: 'complete' }],
  )
  assert.deepEqual(
    detectNotificationEdges({ a: { completed: false } }, { a: { completed: true } }),
    [{ sessionId: 'a', kind: 'complete' }],
  )
})

test('complete: running edge and completed edge in the same tick emit once', () => {
  assert.deepEqual(
    detectNotificationEdges(
      { a: { running: true } },
      { a: { running: false, completed: true } },
    ),
    [{ sessionId: 'a', kind: 'complete' }],
  )
})

test('complete: a missing running field is not an explicit false edge', () => {
  assert.deepEqual(detectNotificationEdges({ a: { running: true } }, { a: {} }), [])
  assert.deepEqual(
    detectNotificationEdges({ a: { running: true } }, { a: { running: undefined } }),
    [],
  )
})

test('complete: already-false running or already-true completed does not re-emit', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: { running: false } }, { a: { running: false } }),
    [],
  )
  assert.deepEqual(
    detectNotificationEdges({ a: { completed: true } }, { a: { completed: true } }),
    [],
  )
  assert.deepEqual(
    detectNotificationEdges(
      { a: { running: false, completed: true } },
      { a: { running: false, completed: true } },
    ),
    [],
  )
})

test('complete: completed true→false or cleared is not an edge', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: { completed: true } }, { a: { completed: false } }),
    [],
  )
  assert.deepEqual(detectNotificationEdges({ a: { completed: true } }, { a: {} }), [])
})

// ---- ask ----

test('ask: pending undefined→question edge', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: {} }, { a: { pending: 'question' } }),
    [{ sessionId: 'a', kind: 'ask' }],
  )
  // a session first appearing with a question (after the initial seed) also asks
  assert.deepEqual(
    detectNotificationEdges({ a: {} }, { b: { pending: 'question' } }),
    [{ sessionId: 'b', kind: 'ask' }],
  )
  // a running session moving to question asks independently of running state
  assert.deepEqual(
    detectNotificationEdges(
      { b: { running: true } },
      { b: { running: true, pending: 'question' } },
    ),
    [{ sessionId: 'b', kind: 'ask' }],
  )
})

test('ask: repeated question reports do not re-emit', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'question' } }, { a: { pending: 'question' } }),
    [],
  )
})

test('ask/request: direct switches between concrete values emit for the new value', () => {
  // plan-review↔question 直切与 question↔approval 同代码路径（vendor 组合
  // 选择器不经 undefined 的正常产物）。
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'plan-review' } }, { a: { pending: 'question' } }),
    [{ sessionId: 'a', kind: 'ask' }],
  )
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'question' } }, { a: { pending: 'plan-review' } }),
    [{ sessionId: 'a', kind: 'request' }],
  )
})

// ---- request ----

test('request: pending undefined→approval and →plan-review edges', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: {} }, { a: { pending: 'approval' } }),
    [{ sessionId: 'a', kind: 'request' }],
  )
  assert.deepEqual(
    detectNotificationEdges({ b: {} }, { b: { pending: 'plan-review' } }),
    [{ sessionId: 'b', kind: 'request' }],
  )
})

test('request: repeated approval reports do not re-emit', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'approval' } }, { a: { pending: 'approval' } }),
    [],
  )
})

test('ask and request are independent: one session asks while another requests', () => {
  assert.deepEqual(
    detectNotificationEdges(
      { a: {}, b: {} },
      { a: { pending: 'question' }, b: { pending: 'approval' } },
    ),
    [
      { sessionId: 'a', kind: 'ask' },
      { sessionId: 'b', kind: 'request' },
    ],
  )
})

// ---- mixed：同一 session 多事件顺序 + 不同 session 各自触发 ----

test('mixed: a session completing and asking in the same tick emits complete then ask', () => {
  assert.deepEqual(
    detectNotificationEdges(
      { a: { running: true } },
      { a: { running: false, completed: true, pending: 'question' } },
    ),
    [
      { sessionId: 'a', kind: 'complete' },
      { sessionId: 'a', kind: 'ask' },
    ],
  )
})

test('mixed: complete plus request for one session, independent request for another', () => {
  assert.deepEqual(
    detectNotificationEdges(
      { a: { running: true }, b: {} },
      { a: { running: false, pending: 'approval' }, b: { pending: 'plan-review' } },
    ),
    [
      { sessionId: 'a', kind: 'complete' },
      { sessionId: 'a', kind: 'request' },
      { sessionId: 'b', kind: 'request' },
    ],
  )
})

test('mixed: output follows next insertion order across sessions', () => {
  const prev = { x: {}, y: {}, z: {} }
  const next = {
    z: { pending: 'question' },
    y: { pending: 'approval' },
    x: { pending: 'question' },
  } as const
  assert.deepEqual(detectNotificationEdges(prev, next), [
    { sessionId: 'z', kind: 'ask' },
    { sessionId: 'y', kind: 'request' },
    { sessionId: 'x', kind: 'ask' },
  ])
})

// ---- pending 清除 / 直切不触发；session 消失不触发 ----

test('pending cleared back to undefined emits nothing', () => {
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'question' } }, { a: {} }),
    [],
  )
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'approval' } }, { a: { pending: undefined } }),
    [],
  )
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'plan-review' } }, { a: {} }),
    [],
  )
})

test('pending switching straight between values emits for the new value', () => {
  // vendor 组合选择器会正常产生不经 undefined 的直切（question 被回答后
  // approval 仍 pending）：每个新值对用户都是新事件，必须通知。
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'question' } }, { a: { pending: 'approval' } }),
    [{ sessionId: 'a', kind: 'request' }],
  )
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'approval' } }, { a: { pending: 'question' } }),
    [{ sessionId: 'a', kind: 'ask' }],
  )
  // 同值重放不重复发
  assert.deepEqual(
    detectNotificationEdges({ a: { pending: 'approval' } }, { a: { pending: 'approval' } }),
    [],
  )
})

test('completed arming while idle is a raw edge; dedupeCompleteEdges drops it after a running edge', () => {
  // 纯函数层面：idle 后 vendor 延迟武装 completed 仍产生 complete 边沿
  // （含 before=undefined 的断连兜底补发）。
  assert.deepEqual(
    detectNotificationEdges({ a: { running: false } }, { a: { running: false, completed: true } }),
    [{ sessionId: 'a', kind: 'complete' }],
  )
  assert.deepEqual(
    detectNotificationEdges({}, { a: { running: false, completed: true } }),
    [{ sessionId: 'a', kind: 'complete' }],
  )
})

// ---- complete 去重（App 层 dedupeCompleteEdges）----

test('dedupe: a running-edge complete suppresses the later completed-arming edge', () => {
  // 正被查看的会话完成：running 边沿先发并记入 notified；切走后 vendor
  // 延迟武装 completed 的边沿被丢弃。
  let notified = new Set<string>()
  const first = dedupeCompleteEdges(
    [{ sessionId: 'a', kind: 'complete' }],
    notified,
    [],
  )
  assert.deepEqual(first.edges, [{ sessionId: 'a', kind: 'complete' }])
  notified = first.notified
  const second = dedupeCompleteEdges(
    [{ sessionId: 'a', kind: 'complete' }],
    notified,
    [],
  )
  assert.deepEqual(second.edges, [])
})

test('dedupe: re-running clears the memory so the next completion notifies again', () => {
  let notified = new Set(['a'])
  const rerun = dedupeCompleteEdges([], notified, ['a'])
  const again = dedupeCompleteEdges(
    [{ sessionId: 'a', kind: 'complete' }],
    rerun.notified,
    [],
  )
  assert.deepEqual(again.edges, [{ sessionId: 'a', kind: 'complete' }])
})

test('dedupe: ask/request edges always pass through untouched', () => {
  const result = dedupeCompleteEdges(
    [
      { sessionId: 'a', kind: 'ask' },
      { sessionId: 'b', kind: 'request' },
    ],
    new Set(['b']),
    [],
  )
  assert.deepEqual(result.edges, [
    { sessionId: 'a', kind: 'ask' },
    { sessionId: 'b', kind: 'request' },
  ])
})

test('dedupe: same report with running=true and a complete edge still emits (running clears first)', () => {
  // runningIds 先清记忆、后滤边沿：同一报告内某会话 running=true 且带 complete
  // 边沿时照发。真实数据中 vendor 不变量使该组合不可达（completed 仅在
  // !running 时武装、running 时同步解除——manager.ts），此处锁定纯函数行为，
  // 防 vendor 语义变化时静默失效。
  const result = dedupeCompleteEdges(
    [{ sessionId: 'a', kind: 'complete' }],
    new Set(['a']),
    ['a'],
  )
  assert.deepEqual(result.edges, [{ sessionId: 'a', kind: 'complete' }])
  assert.equal(result.notified.has('a'), true)
})

test('a session vanishing from next emits nothing', () => {
  assert.deepEqual(detectNotificationEdges({ a: { running: true } }, {}), [])
  assert.deepEqual(
    detectNotificationEdges(
      { a: { pending: 'question' }, b: { completed: true } },
      { b: { completed: true } },
    ),
    [],
  )
  // vanishing sessions never emit, even mid-transition, while other sessions still do
  assert.deepEqual(
    detectNotificationEdges(
      { a: { running: true, pending: 'approval' } },
      { b: { pending: 'question' } },
    ),
    [{ sessionId: 'b', kind: 'ask' }],
  )
})

// ---- 断连重连诚实补发：来源级边沿记忆，重放不重复 ----

test('reconnect replay: identical facts do not re-emit, new edges do', () => {
  const seed = detectNotificationEdges(undefined, { a: { running: true, pending: 'question' } })
  assert.deepEqual(seed, [])

  const prev = { a: { running: true, pending: 'question' } } as const
  // mux replay re-publishes the same facts: nothing
  assert.deepEqual(
    detectNotificationEdges(prev, { a: { running: true, pending: 'question' } }),
    [],
  )
  // then the session completes while the pending is answered
  assert.deepEqual(
    detectNotificationEdges(
      { a: { running: true, pending: 'question' } },
      { a: { running: false, pending: undefined } },
    ),
    [{ sessionId: 'a', kind: 'complete' }],
  )
})
