/**
 * plugin-model.ts unit tests (plain node:test, no dsh, no React): the pure
 * unified plugin-management model layer (design 21 §6.6 step ①) — the deny
 * mirror + its TEXTUAL lockstep against the control-plane single source,
 * intent ordering (remove-first / duplicates / net coalesce), apply-result
 * normalization for both backends (gateway + ssh shapes as they really are on
 * the wire — incl. the ssh producer's fail-loud ok:true markers verified/
 * ready/readyNote, never collapsed into a clean success), the gateway task
 * projection → row model, the v1 ok-only undo derive, the denied-row filter
 * and the batch failure policy constant.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BATCH_FAILURE_POLICY,
  BATCH_POLICY_SENTENCE,
  classifyGatewayApplyResult,
  classifySshApplyResult,
  describeBatchPolicy,
  filterDeniedRows,
  isDeniedPluginName,
  orderApplyOps,
  partialCounts,
  projectTasks,
  undoForLatest,
  UNDO_V1_POLICY,
  type ApplyOutcome,
  type GatewayApplyShape,
  type GatewayTasksShape,
  type SshApplyShape,
  type TaskRow,
} from '../src/client/plugin-model.ts'

// ---------------------------------------------------------------------------
// 1. Deny mirror + lockstep (control-plane plugin-spec.ts is the single
// source; the browser renderer keeps this hand mirror — ADD_SPEC precedent,
// design 21 §6.2/§6.7).
// ---------------------------------------------------------------------------

/** The mirror test source files (textual compare, never an import of the
 *  Node-side control-plane module from a browser-bundle module). */
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const modelSource = () => readFileSync(join(TEST_DIR, '..', 'src', 'client', 'plugin-model.ts'), 'utf8')
const pluginSpecSource = () => readFileSync(join(TEST_DIR, '..', '..', 'control-plane', 'src', 'plugin-spec.ts'), 'utf8')

/** The single-line predicate body of an isDeniedPluginName declaration. */
function denyPredicateBody(source: string, fileLabel: string): string {
  const match = /export function isDeniedPluginName\(name: string\): boolean \{([\s\S]*?)\n\}/.exec(source)
  if (match === null) {
    assert.fail(`${fileLabel}: expected a single-line isDeniedPluginName body`)
  }
  return match[1].trim()
}

test('deny mirror lockstep: the renderer predicate body is byte-identical to control-plane plugin-spec.ts', () => {
  const model = denyPredicateBody(modelSource(), 'plugin-model.ts')
  const shared = denyPredicateBody(pluginSpecSource(), 'control-plane/src/plugin-spec.ts')
  assert.equal(model, shared,
    'plugin-model.ts isDeniedPluginName must stay a byte-identical hand mirror of control-plane plugin-spec.ts isDeniedPluginName (the renderer cannot import the Node-side module; change both sides together)')
  // The extracted body must really be the two-prefix rule — guards a stale
  // or unrelated match passing the byte compare trivially.
  assert.match(model, /name\.startsWith\('@deepseek-ai\/'\)/)
  assert.match(model, /name\.startsWith\('@dsh-chamber\/'\)/)
  assert.equal(model, "return name.startsWith('@deepseek-ai/') || name.startsWith('@dsh-chamber/')")
})

test('deny mirror matrix: official and chamber domains denied, third-party allowed (design 21 decision 19)', () => {
  for (const denied of [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-client-ui-primitives',
    '@dsh-chamber/dsh-host-client-graph',
    '@dsh-chamber/dsh-host-git-worktree',
    '@dsh-chamber/dsh-chamber-client-ui-mobile',
    '@dsh-chamber/anything-else',
  ]) {
    assert.equal(isDeniedPluginName(denied), true, `${denied} must be denied`)
  }
  // A versioned full spec still matches by prefix when a caller forgets to
  // extract the name first — same tolerated behavior as the shared source.
  assert.equal(isDeniedPluginName('@dsh-chamber/pkg@1.0.0'), true)
  for (const allowed of [
    'third-party-plugin',
    '@scope/third-party',
    'dsh-plugin-x',
    '@deepseek-ai', // no scope slash: not a scoped name — allowed, mirror-exact
    '@dsh-chamber',
    '',
  ]) {
    assert.equal(isDeniedPluginName(allowed), false, `${JSON.stringify(allowed)} must not be denied`)
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
  const result: GatewayApplyShape = {
    ok: true,
    installed: ['foo@^1.0.0', 'bar'],
    removed: ['legacy'],
    restarted: true,
  }
  assert.deepEqual(classifyGatewayApplyResult(result), {
    executed: {
      removed: ['legacy'],
      installed: ['foo@^1.0.0', 'bar'],
      restarted: true,
      deferred: false,
    },
  })
})

test('gateway: ok:true deferred:true keeps the flag (restart-to-apply skipped)', () => {
  const result: GatewayApplyShape = {
    ok: true,
    installed: [],
    removed: [],
    restarted: false,
    deferred: true,
  }
  assert.deepEqual(classifyGatewayApplyResult(result), {
    executed: { removed: [], installed: [], restarted: false, deferred: true },
  })
})

test('gateway: ok:false with partial counts the accepted ops; attemptedOps gives the honest n/m total', () => {
  const result: GatewayApplyShape = {
    ok: false,
    error: 'executor refusal at op 3',
    partial: { installed: ['foo@^1.0.0'], removed: ['legacy'] },
  }
  assert.deepEqual(classifyGatewayApplyResult(result, 5), {
    failed: { error: 'executor refusal at op 3', partialDone: 2, partialTotal: 5 },
  })
  // Without the attempted count the total degrades to the backend-visible
  // count (n/n) — documented, never fabricated.
  assert.deepEqual(classifyGatewayApplyResult(result), {
    failed: { error: 'executor refusal at op 3', partialDone: 2, partialTotal: 2 },
  })
})

test('gateway: ok:false without partial reports 0 done / 0 total (nothing ran)', () => {
  const result: GatewayApplyShape = { ok: false, error: 'apply in progress' }
  assert.deepEqual(classifyGatewayApplyResult(result), {
    failed: { error: 'apply in progress', partialDone: 0, partialTotal: 0 },
  })
})

// ---------------------------------------------------------------------------
// 3b. Apply-result normalization — ssh shape (plugin_apply union twin:
// {ok:true,result}|{ok:true,cancelled:true}|{ok:false,error}; result reports
// COUNTS only — applied/skipped/failed, never per-name success)
// ---------------------------------------------------------------------------

test('ssh: cancelled arm (the A confirmation-chain wrapper arm) maps to {cancelled:true}', () => {
  const result: SshApplyShape = { ok: true, cancelled: true }
  assert.deepEqual(classifySshApplyResult(result), { cancelled: true })
})

test('ssh: ok:true clean result executes with restarted/deferred passthrough; no name lists (counts-only result)', () => {
  const result: SshApplyShape = {
    ok: true,
    result: {
      applied: 3,
      skipped: 0,
      failed: [],
      restarted: true,
      deferred: false,
      verified: true,
      ready: true,
    },
  }
  assert.deepEqual(classifySshApplyResult(result), {
    executed: { removed: [], installed: [], restarted: true, deferred: false },
  })
})

test('ssh: per-item failures still EXECUTE (single-item isolation) with partial done/total = applied/(applied+failed)', () => {
  const result: SshApplyShape = {
    ok: true,
    result: {
      applied: 2,
      skipped: 0,
      failed: [{ spec: 'broken@1.0.0', error: 'registry 404' }],
      restarted: false,
      deferred: true,
      verified: false,
      ready: null,
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
      applied: 0,
      skipped: 0,
      failed: [{ spec: 'a', error: 'e1' }, { spec: 'b', error: 'e2' }],
      restarted: false,
      deferred: false,
      verified: false,
      ready: null,
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
      applied: 1,
      skipped: 0,
      failed: [],
      restarted: true,
      deferred: false,
      verified: false, // applyPlugins ④: the post-apply assertion failed
      ready: true,
    },
  }
  const outcome = classifySshApplyResult(result)
  assert.ok('executed' in outcome, 'ok:true is executed, not failed')
  assert.equal(outcome.partial, undefined, 'no row failures → no partial')
  assert.equal(outcome.executed.verified, false, 'the verified:false marker must ride the executed summary')
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
  assert.ok('executed' in outcome)
  assert.equal(outcome.executed.ready, false)
  assert.equal(outcome.executed.readyNote, undefined)
  assert.deepEqual(outcome, {
    executed: { removed: [], installed: [], restarted: true, deferred: false, ready: false },
  })
  // A restart executed while the instance was not connected: readiness was
  // not re-checked — carry ready:null + the producer's readyNote verbatim.
  const notRechecked: SshApplyShape = {
    ok: true,
    result: {
      applied: 1, skipped: 0, failed: [], restarted: true, deferred: false,
      verified: true, ready: null,
      readyNote: 'instance was not connected before restart — readiness was not re-checked',
    },
  }
  const outcome2 = classifySshApplyResult(notRechecked)
  assert.ok('executed' in outcome2)
  assert.equal(outcome2.executed.ready, null)
  assert.equal(outcome2.executed.readyNote, 'instance was not connected before restart — readiness was not re-checked')
  assert.deepEqual(outcome2, {
    executed: {
      removed: [], installed: [], restarted: true, deferred: false,
      ready: null, readyNote: 'instance was not connected before restart — readiness was not re-checked',
    },
  })
})

test('ssh: skipped-only rows are never a partial (skipped ops were not attempted)', () => {
  const result: SshApplyShape = {
    ok: true,
    result: {
      applied: 1,
      skipped: 4,
      failed: [],
      restarted: false,
      deferred: true,
      verified: true,
      ready: null,
    },
  }
  assert.deepEqual(classifySshApplyResult(result), {
    executed: { removed: [], installed: [], restarted: false, deferred: true },
  })
})

test('ssh: ok:false wholesale refusal fails with 0 done; attemptedOps supplies the total', () => {
  const result: SshApplyShape = { ok: false, error: 'apply in progress' }
  assert.deepEqual(classifySshApplyResult(result), {
    failed: { error: 'apply in progress', partialDone: 0, partialTotal: 0 },
  })
  assert.deepEqual(classifySshApplyResult(result, 6), {
    failed: { error: 'apply in progress', partialDone: 0, partialTotal: 6 },
  })
})

// ---------------------------------------------------------------------------
// 3c. partialCounts
// ---------------------------------------------------------------------------

test('partialCounts: cancelled → null; clean executed → null; executed+partial and failed surface their counts', () => {
  const cancelled: ApplyOutcome = { cancelled: true }
  const clean: ApplyOutcome = { executed: { removed: [], installed: [], restarted: true, deferred: false } }
  const partialExec: ApplyOutcome = {
    executed: { removed: [], installed: [], restarted: false, deferred: true },
    partial: { done: 2, total: 3 },
  }
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
  assert.equal(BATCH_FAILURE_POLICY.registryAndRemove, 'fail-fast')
  assert.equal(BATCH_FAILURE_POLICY.materializeRows, 'isolated')
  assert.equal(describeBatchPolicy(), BATCH_POLICY_SENTENCE)
  assert.equal(typeof describeBatchPolicy(), 'string')
  assert.ok(describeBatchPolicy().length > 0)
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
// 7. Reserved-row filter
// ---------------------------------------------------------------------------

test('filterDeniedRows: partitions name rows into allowed and denied (official + chamber domains)', () => {
  const rows = [
    { name: '@dsh-chamber/dsh-host-client-graph', note: 'seed host package' },
    { name: 'third-party-a', note: 'fine' },
    { name: '@deepseek-ai/dsh', note: 'official' },
    { name: 'third-party-b', note: 'fine' },
    { name: '@scope/third-party', note: 'scoped but fine' },
  ]
  const { allowed, denied } = filterDeniedRows(rows)
  assert.deepEqual(allowed.map(row => row.name), ['third-party-a', 'third-party-b', '@scope/third-party'])
  assert.deepEqual(denied.map(row => row.name), ['@dsh-chamber/dsh-host-client-graph', '@deepseek-ai/dsh'])
  // Original array untouched; generic name-carrying shapes work.
  assert.equal(rows.length, 5)
})

test('filterDeniedRows: empty input stays empty on both sides', () => {
  assert.deepEqual(filterDeniedRows([]), { allowed: [], denied: [] })
})
