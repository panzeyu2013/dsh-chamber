/**
 * 归档确认相位的纯逻辑测试：失败分类（只有可解码的 session-active 拒绝进入确认）与
 * 活动家族 → 字典行映射（逐分支对照官方 activityLine；未知家族走 generic 行）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { InstanceRpcError } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { archiveActivityLines, classifyArchiveFailure } from '../../src/client/session-archive-confirm.ts'

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

test('archiveActivityLines mirrors the official family mapping (turn bare; unknown goes generic)', () => {
  const join = (names: readonly string[]): string => names.join('|')
  assert.deepEqual(archiveActivityLines([
    { kind: 'turn', items: [] },
    { kind: 'subagent', items: [{ id: 's1', label: 'worker' }, { id: 's2' }] },
    { kind: 'job', items: [{ id: 'j1' }] },
    { kind: 'schedule', items: [{ id: 'sch1', label: 'ping' }, { id: 'sch2' }] },
    { kind: 'future-family', items: [{ id: 'f1' }] },
  ], join), [
    { key: 'archive.confirm.turn', params: {} },
    { key: 'archive.confirm.subagents.other', params: { n: 2, names: 'worker|s2' } },
    { key: 'archive.confirm.jobs.one', params: { n: 1, names: 'j1' } },
    { key: 'archive.confirm.schedules.other', params: { n: 2, names: 'ping|sch2' } },
    // The generic line carries the kind and the count, never a name list.
    { key: 'archive.confirm.other.one', params: { kind: 'future-family', n: 1 } },
  ])
})

test('classifyArchiveFailure confirms only a decodable session-active refusal', () => {
  const refusal = new InstanceRpcError('workspace/session-active', 'busy', {
    sessionId: 's1',
    activity: [{ kind: 'turn' }, { kind: 'job', items: [{ id: 'j1' }] }],
  })
  assert.deepEqual(classifyArchiveFailure(refusal), {
    kind: 'confirm',
    activity: [{ kind: 'turn', items: [] }, { kind: 'job', items: [{ id: 'j1' }] }],
  })
  // A refusal whose details cannot be decoded keeps the raw error: the dialog
  // must never show an empty or partial "what will stop" list.
  assert.deepEqual(classifyArchiveFailure(new InstanceRpcError('workspace/session-active', 'busy')), { kind: 'reject' })
  assert.deepEqual(classifyArchiveFailure(new InstanceRpcError('workspace/unknown-session', 'gone')), { kind: 'reject' })
  assert.deepEqual(classifyArchiveFailure(new Error('transport exploded')), { kind: 'reject' })
})

test('wiring lock: the confirm phase resends with stopActivity; only a decodable refusal arms', () => {
  // The pure functions above cannot pin the two hook call sites — and deleting
  // { stopActivity: true } from the confirm phase would otherwise leave every
  // test green while the user's "stop and archive" gets refused again. Same
  // SHAPE-only lock discipline as leading-seat-wiring.test.ts (comment-stripped
  // source, so a comment cannot satisfy the lock).
  const dialogs = stripComments(read('../../src/client/sidebar-root-dialogs.tsx'))
  const sessions = stripComments(read('../../src/client/sidebar-root-sessions.ts'))
  // The second call (after the user confirms) carries the additive field.
  assert.ok(dialogs.includes('archiveSessionForSource(target.sourceId, target.sessionId, { stopActivity: true })'))
  // The first call stays plain: no field, no explicit false anywhere in the hook.
  assert.ok(sessions.includes('await archiveSessionForSource(server.id, sessionId)'))
  assert.ok(!sessions.includes('stopActivity'), 'the first phase must not pre-send the field')
  // Only a DECODABLE refusal arms; every other failure rethrows to rowErrors.
  assert.ok(sessions.includes("if (attempt.kind === 'reject') throw error"))
  assert.ok(sessions.includes('if (!openArchiveConfirm('))
  // The title comes from the clicked row (the aggregate has no server.sessions).
  assert.ok(!sessions.includes('server.sessions'))
  assert.ok(stripComments(read('../../src/client/ServerSectionRows.tsx'))
    .includes('onArchiveSession(server, session.id, session.displayTitle)'))
  // The single-layer gate must decide on the synchronous ref, not the render
  // closure: the first archive call can settle ~30s after the click, so a stale
  // closure would stack a second layer or silently replace a pending confirm.
  // 每层都必须以 false 起手：新增一层不该让这条锁红，但 true 起手会让首个确认被静默吞掉。
  const layers = /const openLayersRef = useRef\(\{([^}]*)\}\)/.exec(dialogs)
  assert.ok(layers !== null, 'the layer gate must be one synchronous ref')
  assert.doesNotMatch(layers[1], /:\s*true/u)
  assert.ok(dialogs.includes('const open = openLayersRef.current'))
  assert.ok(dialogs.includes('open.sessionArchive = true'))
  assert.ok(dialogs.includes('openLayersRef.current.sessionArchive = false'))
  // 跨行换靶保护：另一行的拒绝落在同一次 unary 往返窗内时，第二次武装必须被拒——否则已武装
  // 目标被静默覆盖（连同它的 pending/error），被覆盖那行的拒绝既无行错误也无提示。
  assert.ok(dialogs.includes('open.archiveTarget !== null && open.archiveTarget !== request.sessionId'))
  assert.ok(dialogs.includes('open.archiveTarget === request.sessionId && open.archivePending'))
  assert.ok(dialogs.includes('open.archiveTarget = request.sessionId'))
  // 兜底对齐（每次提交后把四个「层在屏」布尔对齐 state）**不得整体替换 ref**：
  // `archiveTarget`/`archivePending` 是打开方在同一 tick 声明的同步权威、不由 state 派生，
  // 整体替换会把已武装目标与「第二段在飞」标记一起清成 undefined，跨行换靶与重复点击
  // 两道保护随即静默失效（TS 也会因缺字段报错）。只允许属性级改写。
  assert.doesNotMatch(dialogs, /openLayersRef\.current\s*=\s*\{/u)
  assert.ok(dialogs.includes('const open = openLayersRef.current'))
})

