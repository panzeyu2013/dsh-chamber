/**
 * ssh-apply-rows.ts tests — the ssh unified-increment pure surface (design
 * 21 §6.4, plan Phase 5): registry-name parsing, reserved-name whole-batch
 * refusal, and the v1 undo decision / confirmation copy.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSshApplyRows,
  buildSshUndoDecision,
  defaultSshProtectionFacts,
  describePluginRefusals,
  describeSshUndoConfirmation,
  parseSpecName,
  parseSpecVersion,
} from './ssh-apply-rows.ts'
import type { SshJournalOp } from './ssh-plugin-journal.ts'

function op(partial: Partial<SshJournalOp> & Pick<SshJournalOp, 'kind' | 'name' | 'specBefore'>): SshJournalOp {
  return { id: 'op-1', ts: 1, instanceId: 's1', fingerprint: 'fp-host-a', ok: true, ...partial }
}

// ============================================================================
// parseSpecName
// ============================================================================

test('parseSpecName: extracts the registry name of every whitelisted spec form', () => {
  assert.equal(parseSpecName('name'), 'name')
  assert.equal(parseSpecName('name@1.2.3'), 'name')
  assert.equal(parseSpecName('name@^1.2.3'), 'name')
  assert.equal(parseSpecName('name@latest'), 'name')
  assert.equal(parseSpecName('@scope/pkg'), '@scope/pkg')
  assert.equal(parseSpecName('@scope/pkg@1.2.3'), '@scope/pkg')
  assert.equal(parseSpecName('@scope/pkg@^2.0.0'), '@scope/pkg')
})

test('parseSpecName: materialize/file specs and non-registry values carry no name → null', () => {
  assert.equal(parseSpecName('file:../pkg'), null)
  assert.equal(parseSpecName('file:/root/.dsh-chamber/plugins/x-1.tgz'), null)
  assert.equal(parseSpecName('FILE:/abs/path'), null)
  assert.equal(parseSpecName('link:./pkg'), null)
  assert.equal(parseSpecName('../rel'), null)
  assert.equal(parseSpecName('/abs'), null)
  assert.equal(parseSpecName('~/home'), null)
})

test('parseSpecName: non-registry garbage is refused without throwing', () => {
  assert.equal(parseSpecName('^1.2.3'), null)
  assert.equal(parseSpecName('>=1.2.3 <2'), null)
  assert.equal(parseSpecName('foo; rm -rf /'), null)
  assert.equal(parseSpecName('git+https://x/y'), null)
  assert.equal(parseSpecName(''), null)
  assert.equal(parseSpecName(undefined), null)
  assert.equal(parseSpecName(42), null)
  assert.equal(parseSpecName(null), null)
})

// ============================================================================
// buildSshApplyRows
// ============================================================================

test('buildSshApplyRows: install face is conservative, remove face judges B₀ ∪ S (design 21 §6.11)', () => {
  const result = buildSshApplyRows(
    ['pkg-a@^1.0.0', '@scope/pkg-b', '@dsh-chamber/dsh-chamber-seed-client-graph@1.2.3', '@deepseek-ai/ui@2.0.0'],
    ['@dsh-chamber/git-worktree', 'plain-name', '@deepseek-ai/ui', '@deepseek-ai/dsh-base'],
  )
  assert.equal(result.rows.length, 8)
  assert.deepEqual(result.rows.filter(row => row.name === null), [])
  // Refused: the chamber SEED (protected) + every official-scope INSTALL
  // (conservative — no remote family facts) + the composition member on remove.
  assert.deepEqual(
    result.refusals.map(refusal => `${refusal.name}:${refusal.decision.kind === 'refuse' ? refusal.decision.code : 'defer'}`),
    [
      '@dsh-chamber/dsh-chamber-seed-client-graph:protected',
      '@deepseek-ai/ui:protected',
      '@deepseek-ai/dsh-base:protected',
    ],
  )
  // Allowed (not protected by B₀ ∪ S): a non-seed chamber name and an
  // unexpected official-scope row may be REMOVED — removing a stray copy is
  // restorative, never destructive.
  assert.deepEqual(result.refusals.map(refusal => refusal.kind), ['add', 'add', 'remove'])
})

test('buildSshApplyRows: a deferred judgement is never reported as a batch refusal', () => {
  // profileState 'absent' ⇒ decide returns defer. A deferral means "let the CLI
  // create the profile", so the batch must NOT be refused (the preflight must
  // not block a first install).
  const facts = { ...defaultSshProtectionFacts(), profileState: 'absent' as const }
  const result = buildSshApplyRows(['third-party-pkg@1.0.0'], [], facts)
  assert.deepEqual(result.refusals, [])
  assert.deepEqual(result.rows.map(row => row.name), ['third-party-pkg'])
})

test('buildSshApplyRows: tolerated unknown payload shapes (main preflight safety)', () => {
  const empty = buildSshApplyRows(undefined, undefined)
  assert.deepEqual(empty, { rows: [], refusals: [] })
  const notArrays = buildSshApplyRows('x', { remove: ['y'] })
  assert.deepEqual(notArrays, { rows: [], refusals: [] })
  const nonStrings = buildSshApplyRows([42, null, 'ok-pkg@1.0.0'], [['nested'], '@dsh-chamber/denied'])
  assert.deepEqual(nonStrings.rows, [
    { kind: 'add', spec: 'ok-pkg@1.0.0', name: 'ok-pkg' },
    { kind: 'remove', spec: '@dsh-chamber/denied', name: '@dsh-chamber/denied' },
  ])
  // `@dsh-chamber/denied` is NOT a seed ⇒ not protected ⇒ no refusal (the
  // domain-prefix rule is retired; S is the fact).
  assert.deepEqual(nonStrings.refusals, [])
})

test('buildSshApplyRows: refused names are unique even when repeated across rows', () => {
  const seed = '@dsh-chamber/dsh-chamber-seed-client-graph'
  const result = buildSshApplyRows([`${seed}@1.0.0`, `${seed}@2.0.0`], [seed])
  assert.equal(result.refusals.length, 1)
  assert.equal(result.refusals[0]?.name, seed)
})

test('parseSpecVersion: registry specs carry their pinned value; bare/file specs do not', () => {
  assert.equal(parseSpecVersion('pkg@1.2.3'), '1.2.3')
  assert.equal(parseSpecVersion('@scope/pkg@0.1.5-rc.2'), '0.1.5-rc.2')
  assert.equal(parseSpecVersion('@scope/pkg@^1.0.0'), '^1.0.0')
  assert.equal(parseSpecVersion('@scope/pkg'), null)
  assert.equal(parseSpecVersion('pkg'), null)
  assert.equal(parseSpecVersion('file:/x/y.tgz'), null)
  assert.equal(parseSpecVersion('pkg@'), null)
})

test('describePluginRefusals: loud copy naming each row and its refusal code', () => {
  const refusals = buildSshApplyRows(
    ['@deepseek-ai/experimental-layer@0.1.5-rc.2', 'pkg@1.0.0'],
    ['@deepseek-ai/dsh-base'],
  ).refusals
  const text = describePluginRefusals(refusals)
  assert.match(text, /@deepseek-ai\/experimental-layer \[protected\]/)
  assert.match(text, /@deepseek-ai\/dsh-base \[protected\]/)
})

test('defaultSshProtectionFacts: B₀ ∪ S only — no family source', () => {
  const facts = defaultSshProtectionFacts()
  assert.equal(facts.runtimeVersion, null)
  assert.equal(facts.profileState, 'ready')
  assert.equal(facts.protectedSet?.names.has('@deepseek-ai/dsh-base'), true, 'B₀ is protected')
  assert.equal(facts.protectedSet?.names.has('@dsh-chamber/dsh-chamber-seed-client-graph'), true, 'S is protected')
  assert.equal(facts.protectedSet?.names.has('@deepseek-ai/dsh-session'), false, 'F is unknown on ssh ⇒ not in P')
})

// ============================================================================
// buildSshUndoDecision (v1 undo semantics)
// ============================================================================

test('undo decision: undoing an ok add removes that name again (spec null, not masked)', () => {
  const decision = buildSshUndoDecision(op({ kind: 'add', name: 'pkg-a', specBefore: null }))
  assert.equal(decision.ok, true)
  if (decision.ok) {
    assert.deepEqual(decision.action, { kind: 'remove', name: 'pkg-a' })
    assert.deepEqual(decision.info, { name: 'pkg-a', kind: 'add', spec: null, masked: false })
  }
})

test('undo decision: undoing an in-place upgrade (add row with a previous spec) RESTORES the previous registry spec', () => {
  // The add REPLACED an already-installed row (specBefore non-null): a plain
  // remove would delete a plugin that existed before the change — the undo
  // must re-add the previous spec (design 21 §6.4 「撤销=恢复」 row-level
  // semantics).
  const decision = buildSshUndoDecision(op({ kind: 'add', name: 'up-pkg', specBefore: '^1.0.0' }))
  assert.equal(decision.ok, true)
  if (decision.ok) {
    assert.deepEqual(decision.action, { kind: 'add', spec: 'up-pkg@^1.0.0' })
    assert.deepEqual(decision.info, { name: 'up-pkg', kind: 'add', spec: 'up-pkg@^1.0.0', masked: false })
  }
  const scoped = buildSshUndoDecision(op({ kind: 'add', name: '@scope/up-pkg', specBefore: '2.0.0' }))
  assert.equal(scoped.ok, true)
  if (scoped.ok) assert.deepEqual(scoped.action, { kind: 'add', spec: '@scope/up-pkg@2.0.0' })
})

test('undo decision: an add whose previous spec was an x-wildcard is unavailable (none), never an ok:true that applyPlugins would refuse', () => {
  const wildcard = buildSshUndoDecision(op({ kind: 'add', name: 'up-pkg', specBefore: '1.x' }))
  assert.equal(wildcard.ok, false)
  if (!wildcard.ok) {
    assert.equal(wildcard.info.unavailable, 'none')
    assert.match(wildcard.error, /1\.x/)
  }
  const caretWildcard = buildSshUndoDecision(op({ kind: 'remove', name: 'pkg-a', specBefore: '^1.2.x' }))
  assert.equal(caretWildcard.ok, false)
  if (!caretWildcard.ok) assert.equal(caretWildcard.info.unavailable, 'none')
  const bareTagWildcard = buildSshUndoDecision(op({ kind: 'remove', name: 'pkg-a', specBefore: 'x' }))
  assert.equal(bareTagWildcard.ok, false)
  if (!bareTagWildcard.ok) assert.equal(bareTagWildcard.info.unavailable, 'none')
})

test('undo decision: an add that replaced a file:-backed install is unavailable (file-backed), never projected', () => {
  const decision = buildSshUndoDecision(op({ kind: 'add', name: 'mat-pkg', specBefore: 'file:/root/.dsh-chamber/plugins/mat-pkg-abc.tgz' }))
  assert.equal(decision.ok, false)
  if (!decision.ok) {
    assert.equal(decision.info.unavailable, 'file-backed')
    assert.equal(decision.info.masked, true)
    assert.equal(decision.info.spec, null)
    assert.match(decision.error, /file:/)
  }
})

test('undo decision: undoing an ok remove re-adds the previous REGISTRY spec (name@value)', () => {
  const decision = buildSshUndoDecision(op({ kind: 'remove', name: 'pkg-a', specBefore: '^1.2.3' }))
  assert.equal(decision.ok, true)
  if (decision.ok) {
    assert.deepEqual(decision.action, { kind: 'add', spec: 'pkg-a@^1.2.3' })
    assert.deepEqual(decision.info, { name: 'pkg-a', kind: 'remove', spec: 'pkg-a@^1.2.3', masked: false })
  }
})

test('undo decision: undoing an ok remove of a scoped plugin composes the scoped spec', () => {
  const decision = buildSshUndoDecision(op({ kind: 'remove', name: '@scope/pkg-b', specBefore: '2.0.0' }))
  assert.equal(decision.ok, true)
  if (decision.ok) {
    assert.deepEqual(decision.action, { kind: 'add', spec: '@scope/pkg-b@2.0.0' })
  }
})

test('undo decision: a removed file:-backed spec is unavailable (file-backed) and never projected', () => {
  const decision = buildSshUndoDecision(op({ kind: 'remove', name: 'mat-pkg', specBefore: 'file:/root/.dsh-chamber/plugins/mat-pkg-abc.tgz' }))
  assert.equal(decision.ok, false)
  if (!decision.ok) {
    assert.equal(decision.info.unavailable, 'file-backed')
    assert.equal(decision.info.masked, true)
    assert.equal(decision.info.spec, null)
    assert.match(decision.error, /file:/)
  }
})

test('undo decision: a remove with an unknown previous spec is unavailable (none)', () => {
  const decision = buildSshUndoDecision(op({ kind: 'remove', name: 'pkg-a', specBefore: null }))
  assert.equal(decision.ok, false)
  if (!decision.ok) {
    assert.equal(decision.info.unavailable, 'none')
    assert.equal(decision.info.masked, false)
    assert.equal(decision.info.spec, null)
  }
})

test('undo decision: a non-version-value previous spec cannot be re-added (none)', () => {
  const range = buildSshUndoDecision(op({ kind: 'remove', name: 'pkg-a', specBefore: '>=1.2.3 <2' }))
  assert.equal(range.ok, false)
  if (!range.ok) assert.equal(range.info.unavailable, 'none')
  const workspace = buildSshUndoDecision(op({ kind: 'remove', name: 'pkg-a', specBefore: 'workspace:*' }))
  assert.equal(workspace.ok, false)
  if (!workspace.ok) assert.equal(workspace.info.unavailable, 'none')
})

// ============================================================================
// describeSshUndoConfirmation (main-process confirm copy)
// ============================================================================

test('undo confirmation copy: undoing an add (remove the name) — zh copy with restart note', () => {
  const copy = describeSshUndoConfirmation({
    targetLabel: 'web-1',
    targetId: 's1',
    opKind: 'add',
    name: 'pkg-a',
    spec: null,
  })
  assert.match(copy.message, /撤销对远程实例 web-1 的最近插件变更？/)
  assert.match(copy.detail, /最近一次变更是安装插件 pkg-a/)
  assert.match(copy.detail, /重启远端 dsh 实例使变更生效/)
})

test('undo confirmation copy: undoing a remove names the registry re-add spec', () => {
  const copy = describeSshUndoConfirmation({
    targetLabel: null,
    targetId: 's1',
    opKind: 'remove',
    name: 'pkg-a',
    spec: 'pkg-a@^1.2.3',
  })
  assert.match(copy.message, /撤销对远程实例 s1 的最近插件变更？/)
  assert.match(copy.detail, /最近一次变更是移除插件 pkg-a/)
  assert.match(copy.detail, /以 pkg-a@\^1\.2\.3 从 npm registry 重新安装/)
})

test('undo confirmation copy: restoring an in-place upgrade names the previous spec (not a removal)', () => {
  const copy = describeSshUndoConfirmation({
    targetLabel: null,
    targetId: 's1',
    opKind: 'add',
    name: 'up-pkg',
    spec: 'up-pkg@^1.0.0',
  })
  assert.match(copy.message, /撤销对远程实例 s1 的最近插件变更？/)
  assert.match(copy.detail, /最近一次变更是将插件 up-pkg 更新到新的 registry 版本/)
  assert.match(copy.detail, /恢复到 up-pkg@\^1\.0\.0/)
  assert.doesNotMatch(copy.detail, /从远端实例移除/)
})

test('undo confirmation copy: opKind remove without a spec stays honest (no registry claim)', () => {
  const copy = describeSshUndoConfirmation({ targetLabel: null, targetId: 's1', opKind: 'remove', name: 'pkg-a', spec: null })
  assert.match(copy.detail, /最近一次变更是移除插件 pkg-a/)
  assert.doesNotMatch(copy.detail, /npm registry/)
})
