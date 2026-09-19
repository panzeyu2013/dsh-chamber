/**
 * plugin-model.ts unit tests (plain node:test, no dsh, no React): the pure unified
 * plugin-management model layer (design 21 §6.6 step ①) — legacy protection fallback
 * (§6.11.7), intent ordering, apply-result normalization for both wire shapes (the ssh
 * producer's fail-loud ok:true markers verified/ready/readyNote are never collapsed into
 * a clean success), the gateway task projection → row model, the v1 ok-only undo derive,
 * the protected-row projection + the §6.11.5 diff/apply boundary, and the batch failure
 * policy constant.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  actionableDependencies,
  BATCH_FAILURE_POLICY,
  BATCH_POLICY_SENTENCE,
  classifyGatewayApplyResult,
  classifySshApplyResult,
  describeBatchPolicy,
  isActionableRow,
  isRemovableRow,
  legacyProtectedName,
  orderApplyOps,
  partialCounts,
  pluginRowsOf,
  projectInstalledRows,
  projectTasks,
  sshSyncableDependencies,
  undoForLatest,
  UNDO_V1_POLICY,
  type ApplyOutcome,
  type GatewayApplyShape,
  type GatewayTasksShape,
  type PluginRowShape,
  type SshApplyShape,
  type TaskRow,
} from '../../src/client/plugin-model.ts'
import { pluginRow as row } from '../support/fixtures.ts'

// ---------------------------------------------------------------------------
// 1. Legacy protection fallback (design 21 §6.11.7 — version skew only; P is
// the backend's projection now, §6.11.5).
// ---------------------------------------------------------------------------

test('legacyProtectedName: the official and chamber domains stay refused on the fallback path', () => {
  for (const refused of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@dsh-chamber/dsh-chamber-seed-client-graph',
    '@dsh-chamber/dsh-chamber-seed-git-worktree',
    // 真实 registry 名（mobile 是 gateway 打包的单例例外，无桌面链路）。
    '@dsh-chamber/dsh-client-ui-mobile',
    '@dsh-chamber/anything-else',
  ]) {
    assert.equal(legacyProtectedName(refused), true, `${refused} must be refused by the legacy fallback`)
  }
  // 官方 opt-in 层（@deepseek-ai/dsh-experimental-*）在新投影里可装可卸，但旧
  // 服务端仍按旧规则拒绝整个官方域 —— 回退路径不猜 opt-in 白名单（§6.11.7）。
  assert.equal(legacyProtectedName('@deepseek-ai/dsh-experimental-x'), true)
  // A versioned full spec still matches by prefix when a caller forgets to
  // extract the name first.
  assert.equal(legacyProtectedName('@dsh-chamber/pkg@1.0.0'), true)
  for (const allowed of [
    'third-party-plugin',
    '@scope/third-party',
    'dsh-plugin-x',
    '@deepseek-ai', // no scope slash: not a scoped name
    '@dsh-chamber',
    '',
  ]) {
    assert.equal(legacyProtectedName(allowed), false, `${JSON.stringify(allowed)} must not be refused`)
  }
})

// ---------------------------------------------------------------------------
// 2. Intent model (orderApplyOps)
// ---------------------------------------------------------------------------

test('orderApplyOps: removes come FIRST, adds after, each group in input order, defer passthrough', () => {
  const ordered = orderApplyOps({
    add: [{ name: 'b', spec: 'b@^2.0.0' }, { name: 'a', spec: 'a@1.0.0' }],
    remove: ['r1', 'r2'],
    defer: true,
  })
  assert.deepEqual(ordered, {
    removes: ['r1', 'r2'],
    adds: [{ name: 'b', spec: 'b@^2.0.0' }, { name: 'a', spec: 'a@1.0.0' }],
    defer: true,
    coalesced: [],
  })
})

test('orderApplyOps: intra-group duplicates are stripped, first occurrence wins (also for differing add specs)', () => {
  const ordered = orderApplyOps({
    add: [
      { name: 'a', spec: 'a@1.0.0' },
      { name: 'a', spec: 'a@2.0.0' }, // duplicate name — the FIRST spec wins
      { name: 'b', spec: 'b@^1.0.0' },
    ],
    remove: ['x', 'x', 'y'],
    defer: false,
  })
  assert.deepEqual(ordered, {
    removes: ['x', 'y'],
    adds: [{ name: 'a', spec: 'a@1.0.0' }, { name: 'b', spec: 'b@^1.0.0' }],
    defer: false,
    coalesced: [],
  })
})

test('orderApplyOps: add+remove of the same name coalesces to the add (remove reported in coalesced)', () => {
  const ordered = orderApplyOps({
    add: [{ name: 'shared', spec: 'shared@^1.0.0' }, { name: 'keep', spec: 'keep' }],
    remove: ['drop', 'shared', 'shared'],
    defer: false,
  })
  // net rule: 'shared' is removed then re-added → keep only the add; the
  // duplicate remove entry was already stripped by the intra-group rule.
  assert.deepEqual(ordered, {
    removes: ['drop'],
    adds: [{ name: 'shared', spec: 'shared@^1.0.0' }, { name: 'keep', spec: 'keep' }],
    defer: false,
    coalesced: ['shared'],
  })
})

test('orderApplyOps: input arrays are never mutated', () => {
  const add = [{ name: 'a', spec: 'a' }]
  const remove = ['a']
  const input = { add, remove, defer: false }
  orderApplyOps(input)
  assert.deepEqual(add, [{ name: 'a', spec: 'a' }])
  assert.deepEqual(remove, ['a'])
})

// ---------------------------------------------------------------------------
// 3. Apply-result normalization — gateway shape (GatewayPluginApplyIpcResult
// union twin: cancelled / ok:true installed+removed+restarted+deferred? /
// ok:false error+partial?)
// ---------------------------------------------------------------------------

test('gateway: cancelled arm maps to {cancelled:true}', () => {
  const result: GatewayApplyShape = { ok: true, cancelled: true }
  assert.deepEqual(classifyGatewayApplyResult(result), { cancelled: true })
})

test('gateway: ok:true full batch executes with the named lists; omitted deferred defaults to false', () => {
  const result: GatewayApplyShape = { ok: true, installed: ['foo@^1.0.0', 'bar'], removed: ['legacy'], restarted: true }
  assert.deepEqual(classifyGatewayApplyResult(result), {
    executed: { removed: ['legacy'], installed: ['foo@^1.0.0', 'bar'], restarted: true, deferred: false },
  })
})

test('gateway: ok:true deferred:true keeps the flag (restart-to-apply skipped)', () => {
  const result: GatewayApplyShape = { ok: true, installed: [], removed: [], restarted: false, deferred: true }
  assert.deepEqual(classifyGatewayApplyResult(result), {
    executed: { removed: [], installed: [], restarted: false, deferred: true },
  })
})

test('gateway: ok:false with partial counts the accepted ops; attemptedOps gives the honest n/m total', () => {
  const result: GatewayApplyShape = { ok: false, error: 'executor refusal at op 3', partial: { installed: ['foo@^1.0.0'], removed: ['legacy'] } }
  assert.deepEqual(classifyGatewayApplyResult(result, 5), { failed: { error: 'executor refusal at op 3', partialDone: 2, partialTotal: 5 } })
  // Without the attempted count the total degrades to the backend-visible
  // count (n/n) — documented, never fabricated.
  assert.deepEqual(classifyGatewayApplyResult(result), { failed: { error: 'executor refusal at op 3', partialDone: 2, partialTotal: 2 } })
})

test('gateway: ok:false without partial reports 0 done / 0 total (nothing ran)', () => {
  const result: GatewayApplyShape = { ok: false, error: 'apply in progress' }
  assert.deepEqual(classifyGatewayApplyResult(result), { failed: { error: 'apply in progress', partialDone: 0, partialTotal: 0 } })
})

// ---------------------------------------------------------------------------
// 3b. Apply-result normalization — ssh shape (plugin_apply union twin:
// {ok:true,result}|{ok:false,error}; result reports COUNTS only —
// applied/skipped/failed, never per-name success; no cancelled arm —
// plugin_apply has no cancellation path, design 21 §7)
// ---------------------------------------------------------------------------

test('ssh: ok:true clean result executes with restarted/deferred passthrough; no name lists (counts-only result)', () => {
  const result: SshApplyShape = {
    ok: true, result: { applied: 3, skipped: 0, failed: [], restarted: true, deferred: false, verified: true, ready: true },
  }
  assert.deepEqual(classifySshApplyResult(result), {
    executed: { removed: [], installed: [], restarted: true, deferred: false },
  })
})

test('ssh: per-item failures still EXECUTE (single-item isolation) with partial done/total = applied/(applied+failed)', () => {
  const result: SshApplyShape = {
    ok: true,
    result: {
      applied: 2, skipped: 0, failed: [{ spec: 'broken@1.0.0', error: 'registry 404' }],
      restarted: false, deferred: true, verified: false, ready: null,
    },
  }
  assert.deepEqual(classifySshApplyResult(result), {
    // The fixture's verified:false (assertion fail-loud) rides the executed
    // arm even though this batch also has per-row failures — markers and
    // partial coexist; neither is hidden.
    executed: { removed: [], installed: [], restarted: false, deferred: true, verified: false },
    partial: { done: 2, total: 3 },
  })
})

test('ssh: all ops failed → executed with partial 0/m (the batch ran, every row failed)', () => {
  const result: SshApplyShape = {
    ok: true,
    result: {
      applied: 0, skipped: 0, failed: [{ spec: 'a', error: 'e1' }, { spec: 'b', error: 'e2' }],
      restarted: false, deferred: false, verified: false, ready: null,
    },
  }
  assert.deepEqual(classifySshApplyResult(result), {
    executed: { removed: [], installed: [], restarted: false, deferred: false, verified: false },
    partial: { done: 0, total: 2 },
  })
})

test('ssh: verified:false with ZERO row failures stays a loud executed (assertion fail-loud, never a clean success)', () => {
  const result: SshApplyShape = {
    ok: true,
    result: {
      applied: 1, skipped: 0, failed: [], restarted: true, deferred: false,
      verified: false, // applyPlugins ④: the post-apply assertion failed
      ready: true,
    },
  }
  const outcome = classifySshApplyResult(result)
  assert.deepEqual(outcome, {
    executed: { removed: [], installed: [], restarted: true, deferred: false, verified: false },
  })
})

test('ssh: restart executed but readiness failed → ready:false marker; readiness not re-checked → ready:null + readyNote carried', () => {
  const recheckFailed: SshApplyShape = {
    ok: true,
    result: {
      applied: 2, skipped: 0, failed: [], restarted: true, deferred: false,
      verified: true, ready: false, // applyPlugins ⑤: restart ok, recheck failed
    },
  }
  const outcome = classifySshApplyResult(recheckFailed)
  assert.deepEqual(outcome, {
    executed: { removed: [], installed: [], restarted: true, deferred: false, ready: false },
  })
  // A restart executed while the instance was not connected: readiness was
  // not re-checked — carry ready:null + the producer's readyNote verbatim.
  const notRechecked: SshApplyShape = {
    ok: true,
    result: {
      applied: 1, skipped: 0, failed: [], restarted: true, deferred: false, verified: true, ready: null,
      readyNote: 'instance was not connected before restart — readiness was not re-checked',
    },
  }
  const outcome2 = classifySshApplyResult(notRechecked)
  assert.deepEqual(outcome2, {
    executed: {
      removed: [], installed: [], restarted: true, deferred: false,
      ready: null, readyNote: 'instance was not connected before restart — readiness was not re-checked',
    },
  })
})

test('ssh: skipped-only rows are never a partial (skipped ops were not attempted)', () => {
  const result: SshApplyShape = {
    ok: true, result: { applied: 1, skipped: 4, failed: [], restarted: false, deferred: true, verified: true, ready: null },
  }
  assert.deepEqual(classifySshApplyResult(result), {
    executed: { removed: [], installed: [], restarted: false, deferred: true },
  })
})

test('ssh: ok:false wholesale refusal fails with 0 done; attemptedOps supplies the total', () => {
  const result: SshApplyShape = { ok: false, error: 'apply in progress' }
  assert.deepEqual(classifySshApplyResult(result), { failed: { error: 'apply in progress', partialDone: 0, partialTotal: 0 } })
  assert.deepEqual(classifySshApplyResult(result, 6), { failed: { error: 'apply in progress', partialDone: 0, partialTotal: 6 } })
})

// ---------------------------------------------------------------------------
// 3c. partialCounts
// ---------------------------------------------------------------------------

test('partialCounts: cancelled → null; clean executed → null; executed+partial and failed surface their counts', () => {
  const cancelled: ApplyOutcome = { cancelled: true }
  const clean: ApplyOutcome = { executed: { removed: [], installed: [], restarted: true, deferred: false } }
  const partialExec: ApplyOutcome = { executed: { removed: [], installed: [], restarted: false, deferred: true }, partial: { done: 2, total: 3 } }
  const failed: ApplyOutcome = { failed: { error: 'boom', partialDone: 1, partialTotal: 4 } }
  assert.equal(partialCounts(cancelled), null)
  assert.equal(partialCounts(clean), null)
  assert.deepEqual(partialCounts(partialExec), { done: 2, total: 3 })
  assert.deepEqual(partialCounts(failed), { done: 1, total: 4 })
})

// ---------------------------------------------------------------------------
// 4. Batch failure policy — single definition (design 21 §6.6)
// ---------------------------------------------------------------------------

test('BATCH_FAILURE_POLICY: registry/remove is fail-fast, materialize rows stay isolated', () => {
  assert.deepEqual(BATCH_FAILURE_POLICY, { registryAndRemove: 'fail-fast', materializeRows: 'isolated' })
  assert.equal(describeBatchPolicy(), BATCH_POLICY_SENTENCE)
})

// ---------------------------------------------------------------------------
// 5. Gateway task projection (GET /chamber/plugins/tasks twin: {ok:true,
// tasks: JournalOp[], deferred: DeferredIntent[], busy})
// ---------------------------------------------------------------------------

test('projectTasks: journal ops map onto rows (spec/error/restarted default to null) and busy passes through', () => {
  const shape: GatewayTasksShape = {
    ok: true,
    busy: true,
    deferred: [],
    tasks: [
      {
        id: 'op-3', ts: 3000, kind: 'remove', name: 'old', preImage: 'backups/op-3',
        status: 'ok', restarted: 'ok', initiator: 'conn-a',
      },
      {
        id: 'op-2', ts: 2000, kind: 'install', name: 'foo', spec: '^1.2.0', preImage: 'backups/op-2',
        status: 'failed', error: 'registry 404',
      },
      {
        id: 'op-1', ts: 1000, kind: 'materialize', name: 'pkg', spec: 'file:/…/pkg-abc.tgz', preImage: null,
        status: 'blocked', error: 'runtime busy; retry later',
      },
    ],
  }
  const { rows, busy } = projectTasks(shape)
  assert.equal(busy, true)
  assert.equal(rows.length, 3)
  assert.deepEqual(rows[0], {
    opId: 'op-3', kind: 'remove', name: 'old', spec: null, status: 'ok', error: null,
    restarted: 'ok', ts: 3000, deferred: false, intentId: null,
  })
  assert.deepEqual(rows[1], {
    opId: 'op-2', kind: 'install', name: 'foo', spec: '^1.2.0', status: 'failed', error: 'registry 404',
    restarted: null, ts: 2000, deferred: false, intentId: null,
  })
  assert.deepEqual(rows[2], {
    opId: 'op-1', kind: 'materialize', name: 'pkg', spec: 'file:/…/pkg-abc.tgz', status: 'blocked',
    error: 'runtime busy; retry later', restarted: null, ts: 1000, deferred: false, intentId: null,
  })
})

test('projectTasks: deferred intents project as pending intent rows (opId "", intentId set) listed BEFORE journal ops', () => {
  const shape: GatewayTasksShape = {
    ok: true,
    busy: false,
    deferred: [
      { id: 'int-2', ts: 2000, kind: 'install', name: 'late', spec: '^2.0.0' },
      { id: 'int-1', ts: 1500, kind: 'materialize', name: 'pkg', spec: 'file:/…/pkg.tgz', initiator: 'conn-b' },
    ],
    tasks: [
      { id: 'op-1', ts: 1000, kind: 'install', name: 'earlier', spec: '^1.0.0', preImage: null, status: 'ok' },
    ],
  }
  const { rows, busy } = projectTasks(shape)
  assert.equal(busy, false)
  assert.equal(rows.length, 3)
  // Deferred intents first, wire order preserved, never claimed executed.
  assert.deepEqual(rows[0], {
    opId: '', kind: 'install', name: 'late', spec: '^2.0.0', status: 'pending', error: null,
    restarted: null, ts: 2000, deferred: true, intentId: 'int-2',
  })
  assert.deepEqual(rows[1], {
    opId: '', kind: 'materialize', name: 'pkg', spec: 'file:/…/pkg.tgz', status: 'pending', error: null,
    restarted: null, ts: 1500, deferred: true, intentId: 'int-1',
  })
  assert.deepEqual(rows[2], {
    opId: 'op-1', kind: 'install', name: 'earlier', spec: '^1.0.0', status: 'ok', error: null,
    restarted: null, ts: 1000, deferred: false, intentId: null,
  })
})

// ---------------------------------------------------------------------------
// 6. Undo derive (design 21 §6.4 撤销最近变更; v1 = ok-only policy)
// ---------------------------------------------------------------------------

function opRow(over: Partial<TaskRow> & Pick<TaskRow, 'opId' | 'kind' | 'name' | 'status'>): TaskRow {
  return { spec: null, error: null, restarted: null, ts: 0, deferred: false, intentId: null, ...over }
}

test('UNDO_V1_POLICY: v1 derives undo from ok ops only (failed/blocked never undoable)', () => {
  assert.equal(UNDO_V1_POLICY, 'ok-only')
})

test('undoForLatest: newest ok install → remove action (undo an install = remove the name)', () => {
  const rows = [opRow({ opId: 'op-2', kind: 'install', name: 'foo', status: 'ok', ts: 2 })]
  assert.deepEqual(undoForLatest(rows), { action: { kind: 'remove', name: 'foo' } })
})

test('undoForLatest: newest ok materialize → remove of the name it installed', () => {
  const rows = [
    opRow({ opId: 'op-3', kind: 'materialize', name: 'pkg', status: 'ok', spec: 'file:/…/pkg.tgz', ts: 3 }),
    opRow({ opId: 'op-2', kind: 'install', name: 'older', status: 'ok', ts: 2 }),
  ]
  assert.deepEqual(undoForLatest(rows), { action: { kind: 'remove', name: 'pkg' } })
})

test('undoForLatest: newest ok REMOVE cannot be undone from task rows (spec never journaled) → remove-lacks-spec', () => {
  const rows = [
    opRow({ opId: 'op-3', kind: 'remove', name: 'old', status: 'ok', ts: 3 }),
    opRow({ opId: 'op-2', kind: 'install', name: 'foo', status: 'ok', ts: 2 }),
  ]
  assert.deepEqual(undoForLatest(rows), { action: null, reason: 'remove-lacks-spec' })
})

test('undoForLatest: a newer failed/blocked op above the newest ok op does not hide it in v1 (ok-only policy)', () => {
  const rows = [
    opRow({ opId: 'op-3', kind: 'install', name: 'broken', status: 'blocked', error: 'runtime busy', ts: 3 }),
    opRow({ opId: 'op-2', kind: 'install', name: 'foo', status: 'ok', ts: 2 }),
  ]
  assert.deepEqual(undoForLatest(rows), { action: { kind: 'remove', name: 'foo' } })
})

test('undoForLatest: only failed/blocked terminal ops → only-failed (attempted, never succeeded)', () => {
  const rows = [
    opRow({ opId: 'op-2', kind: 'install', name: 'b', status: 'failed', error: 'registry 404', ts: 2 }),
    opRow({ opId: 'op-1', kind: 'remove', name: 'a', status: 'blocked', error: 'queue full', ts: 1 }),
  ]
  assert.deepEqual(undoForLatest(rows), { action: null, reason: 'only-failed' })
})

test('undoForLatest: pending-only rows → none-executed (nothing terminal yet)', () => {
  const rows = [
    opRow({ opId: 'op-1', kind: 'install', name: 'foo', status: 'pending', ts: 1 }),
  ]
  assert.deepEqual(undoForLatest(rows), { action: null, reason: 'none-executed' })
})

test('undoForLatest: empty rows and deferred-intent-only rows → none-executed', () => {
  assert.deepEqual(undoForLatest([]), { action: null, reason: 'none-executed' })
  const intents: TaskRow[] = [
    { opId: '', kind: 'install', name: 'late', spec: '^1.0.0', status: 'pending', error: null, restarted: null, ts: 1, deferred: true, intentId: 'int-1' },
  ]
  assert.deepEqual(undoForLatest(intents), { action: null, reason: 'none-executed' })
  // A pending intent above executed ops never disturbs the derive.
  const mixed = [...intents, opRow({ opId: 'op-9', kind: 'install', name: 'foo', status: 'ok', ts: 9 })]
  assert.deepEqual(undoForLatest(mixed), { action: { kind: 'remove', name: 'foo' } })
})

// ---------------------------------------------------------------------------
// 7. Protected rows: projection + the diff/apply boundary (design 21 §6.11.5)
// ---------------------------------------------------------------------------

test('pluginRowsOf: absent/non-array rows answer null (the §6.11.7 fallback trigger); an array comes back as a copy', () => {
  assert.equal(pluginRowsOf(undefined), null)
  assert.equal(pluginRowsOf(null), null)
  assert.equal(pluginRowsOf({}), null)
  assert.equal(pluginRowsOf({ rows: undefined }), null)
  // 形状校验：非数组同样走回退，绝不抛（旧 producer 的意外载荷不是崩溃点）。
  assert.equal(pluginRowsOf({ rows: 'nope' as unknown as PluginRowShape[] }), null)
  const rows = [row({ name: 'a' })]
  const copy = pluginRowsOf({ rows })
  assert.deepEqual(copy, rows)
  assert.notEqual(copy, rows, 'returns a shallow copy: callers may sort/iterate without touching the IPC payload')
})

test('isActionableRow: every UNPROTECTED row enters the diff boundary (layers included)', () => {
  assert.equal(isActionableRow(row({ name: 't', role: 'third-party' })), true)
  assert.equal(isActionableRow(row({ name: 'm', role: 'materialized' })), true)
  // 角色不参与判据：用户自己加的层（layer）同样是用户内容，必须可同步——按角色收窄
  // 会把它们从对账视图里静默抹掉（功能回归，2026-12 review 修正）。
  assert.equal(isActionableRow(row({ name: 'l', role: 'layer' })), true)
  assert.equal(isActionableRow(row({ name: 'u', role: 'unknown' })), true)
  // protected 是后端判定：即使角色看起来像第三方（运行时线族的非层成员），
  // 也绝不进 diff 输入（§6.11.5 硬要求）。
  assert.equal(isActionableRow(row({ name: 'f', role: 'third-party', protected: true })), false)
  assert.equal(isActionableRow(row({ name: 'c', role: 'composition', protected: true })), false)
  assert.equal(isActionableRow(row({ name: 's', role: 'seed', protected: true })), false)
})

test('isRemovableRow: every unprotected row is removable (remove judges name ∈ P only) — layers included', () => {
  assert.equal(isRemovableRow(row({ name: 't' })), true)
  assert.equal(isRemovableRow(row({ name: 'l', role: 'layer' })), true)
  assert.equal(isRemovableRow(row({ name: 'm', role: 'materialized' })), true)
  // 受保护行一律不可移除（组合 / 播种 / 线族同判，§6.11.3 R1）。
  assert.equal(isRemovableRow(row({ name: 'c', role: 'composition', protected: true })), false)
  assert.equal(isRemovableRow(row({ name: 's', role: 'seed', protected: true })), false)
  assert.equal(isRemovableRow(row({ name: 'f', role: 'layer', protected: true })), false)
})

test('actionableDependencies: rows mode keeps every unprotected dependency (layers included)', () => {
  const rows = [
    row({ name: '@deepseek-ai/dsh-base', role: 'composition', protected: true, spec: '^0.1.0' }),
    row({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', role: 'seed', protected: true, spec: null }),
    row({ name: '@deepseek-ai/dsh-family-member', role: 'third-party', protected: true, spec: '^0.1.0' }),
    row({ name: 'user-layer', role: 'layer', protected: false, spec: '^2.0.0' }),
    row({ name: 'third-party-a', role: 'third-party', protected: false, spec: '^1.0.0' }),
    row({ name: 'local-copy', role: 'materialized', protected: false, spec: 'file:../p' }),
  ]
  const dependencies = {
    '@deepseek-ai/dsh-base': '^0.1.0', '@dsh-chamber/dsh-chamber-seed-client-graph': '^0.1.0',
    '@deepseek-ai/dsh-family-member': '^0.1.0', 'user-layer': '^2.0.0',
    'third-party-a': '^1.0.0', 'local-copy': 'file:../p',
  }
  assert.deepEqual(actionableDependencies(dependencies, rows), {
    'user-layer': '^2.0.0',
    'third-party-a': '^1.0.0',
    'local-copy': 'file:../p',
  })
})

test('sshSyncableDependencies: the ssh transport filter drops official scope (whole-batch refusal), never user content', () => {
  // 官方 scope 在 ssh 面上会被**整批**拒绝（§6.11.3 ssh 保守装面），所以对账输入必须
  // 排除它；而用户自己加的层/第三方/物化行必须留下。
  const rows = [
    row({ name: '@deepseek-ai/dsh-base', role: 'composition', protected: true, spec: '^0.1.0' }),
    row({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', role: 'seed', protected: true, spec: null }),
    // 本地官方 opt-in 层：非 protected（F 外），但 ssh 装不了 ⇒ 传输能力过滤掉。
    row({ name: '@deepseek-ai/dsh-experimental-x', role: 'layer', protected: false, spec: '0.1.5-rc.2' }),
    row({ name: 'user-layer', role: 'layer', protected: false, spec: '^2.0.0' }),
    row({ name: 'third-party-a', role: 'third-party', protected: false, spec: '^1.0.0' }),
    row({ name: 'local-copy', role: 'materialized', protected: false, spec: 'file:../p' }),
  ]
  const dependencies = Object.fromEntries(rows.map(entry => [entry.name, entry.spec ?? '^1.0.0']))
  assert.deepEqual(sshSyncableDependencies(dependencies, rows), {
    'user-layer': '^2.0.0',
    'third-party-a': '^1.0.0',
    'local-copy': 'file:../p',
  })
  // rows 缺失（旧 producer，§6.11.7）：legacy 回退同样滤掉官方 scope（旧前缀规则）。
  assert.deepEqual(
    Object.keys(sshSyncableDependencies({ 'pkg-a': '^1.0.0', '@deepseek-ai/old': '^1.0.0' }, null)),
    ['pkg-a'],
  )
})

test('actionableDependencies: the map is filtered, never extended by a row without a dependency entry', () => {
  const rows = [row({ name: 'a', spec: '^9.9.9' }), row({ name: 'orphan', spec: '^1.0.0' })]
  // 依赖表的值逐字保留（行里的 spec 不覆盖它）；没有依赖项的行绝不新增。
  assert.deepEqual(actionableDependencies({ a: '^1.2.3' }, rows), { a: '^1.2.3' })
  // 依赖项存在但投影里没有对应行 ⇒ 保守丢弃（绝不猜可操作性）。
  assert.deepEqual(actionableDependencies({ ghost: '^1.0.0' }, []), {})
  // 组合/播种行没有依赖值也不可操作 → 恒不产生依赖项。
  assert.deepEqual(
    actionableDependencies({}, [row({ name: 'c', role: 'composition', protected: true, spec: null })]),
    {},
  )
})

test('actionableDependencies: rows absent (old gateway) falls back to the legacyProtectedName filter', () => {
  const dependencies = {
    '@deepseek-ai/dsh': '^0.1.0', '@dsh-chamber/dsh-client-ui-mobile': '^0.1.0',
    'third-party-a': '^1.0.0', '@scope/third-party': '^2.0.0',
  }
  assert.deepEqual(actionableDependencies(dependencies, null), {
    'third-party-a': '^1.0.0',
    '@scope/third-party': '^2.0.0',
  })
  // 空 rows 不是「缺失」：后端明确投影了空集 ⇒ 没有任何可操作行（绝不静默退回
  // 按域名的旧过滤——新口径下官方 opt-in 层也可装卸）。
  assert.deepEqual(actionableDependencies(dependencies, []), {})
})

test('projectInstalledRows: rows mode renders one row per declared dependency (protected flagged read-only)', () => {
  // 行集口径（design 21 §6.11.5 的 2026-09 修订）：后端只按依赖表投影，所以受保护行
  // 也**带依赖值**（`@deepseek-ai/dsh-base` 若出现，是因为该 profile 自己声明了它）。
  const dependencies = {
    '@deepseek-ai/dsh-base': '^0.1.0', '@dsh-chamber/dsh-chamber-seed-client-graph': '0.3.1',
    'third-party-a': '^1.0.0',
  }
  const rows = [
    row({ name: '@deepseek-ai/dsh-base', role: 'composition', protected: true, version: '0.1.5' }),
    row({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', role: 'seed', protected: true, version: '0.3.1' }),
    row({ name: 'third-party-a' }),
  ]
  const projected = projectInstalledRows(dependencies, rows)
  assert.equal(projected.legacy, false)
  assert.deepEqual(projected.rows.map(view => view.name), [
    '@deepseek-ai/dsh-base',
    '@dsh-chamber/dsh-chamber-seed-client-graph',
    'third-party-a',
  ])
  const base = projected.rows[0]
  assert.equal(base.protected, true)
  assert.equal(base.removable, false)
  assert.equal(base.version, '0.1.5')
  assert.equal(base.spec, '^0.1.0', 'the dependency value wins for rows that have one')
  const seed = projected.rows[1]
  assert.equal(seed.protected, true)
  assert.equal(seed.removable, false)
  assert.equal(seed.role, 'seed')
  assert.equal(seed.spec, '0.3.1')
  assert.equal(projected.rows[2].removable, true)
  // 防御性：投影是「按行」驱动的——万一某个后端给出没有依赖项的行，它照样渲染
  // （spec null ⇒ 单元格落到版本），绝不静默丢行或抛错。
  const orphan = projectInstalledRows({}, [row({ name: 'x', spec: null, version: '9.9.9' })])
  assert.deepEqual(orphan.rows.map(view => [view.name, view.spec, view.version]), [['x', null, '9.9.9']])
})

test('projectInstalledRows: rows absent falls back to the legacy dependencies filter and reports legacy:true', () => {
  const projected = projectInstalledRows({
    '@deepseek-ai/dsh': '^0.1.0', '@dsh-chamber/dsh-client-ui-mobile': '^0.1.0', 'third-party-a': '^1.0.0',
  }, null)
  assert.equal(projected.legacy, true)
  assert.deepEqual(projected.rows, [
    { name: 'third-party-a', spec: '^1.0.0', version: null, role: 'unknown', protected: false, removable: true, legacy: true },
  ])
  // 空 rows（新后端投影了空集）不是回退：legacy:false、行集为空。
  const empty = projectInstalledRows({ 'third-party-a': '^1.0.0' }, [])
  assert.equal(empty.legacy, false)
  assert.deepEqual(empty.rows, [])
})
