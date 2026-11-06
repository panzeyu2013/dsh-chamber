/**
 * Optional archive-before-remove: the closure plan (every session physically in
 * the checkout + fork descendants, archived skipped, blank placeholders never
 * archived) and the upstream two-phase runner (plain → confirm → stopActivity;
 * non-refusal failures abort).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { archiveBeforeRemove, isInsideCheckout, planCheckoutArchive } from '../../src/shared/checkout-archive.ts'

const CHECKOUT = '/repo/.agents/worktrees/feat'

test('isInsideCheckout matches the checkout itself and descendants on segment boundaries', () => {
  assert.equal(isInsideCheckout(CHECKOUT, CHECKOUT), true)
  assert.equal(isInsideCheckout(`${CHECKOUT}/pkg`, CHECKOUT), true)
  assert.equal(isInsideCheckout('/repo/.agents/worktrees/feature', CHECKOUT), false)
  assert.equal(isInsideCheckout('/repo', CHECKOUT), false)
  assert.equal(isInsideCheckout(undefined, CHECKOUT), false)
})

test('the plan takes EVERY session physically in the checkout plus its fork closure, not a workspace membership', () => {
  const sessions = [
    { sessionId: 'a', workingDirectory: CHECKOUT, title: 'A', blank: false },
    { sessionId: 'b', cwd: `${CHECKOUT}/nested`, blank: false },
    { sessionId: 'c', cwd: '/repo', blank: false },
    { sessionId: 'a-fork', parentSessionId: 'a', cwd: '/repo', title: 'A fork', blank: false },
    { sessionId: 'a-fork-fork', parentSessionId: 'a-fork', cwd: '/repo', blank: false },
    { sessionId: 'stray', workingDirectory: '/repo/elsewhere', blank: false },
  ]
  const plan = planCheckoutArchive(sessions, CHECKOUT, new Set(['a-fork']))
  assert.deepEqual(plan.roots, ['a', 'b'])
  assert.deepEqual(plan.closure.sort(), ['a', 'a-fork', 'a-fork-fork', 'b'])
  assert.deepEqual(plan.toArchive.sort(), ['a', 'a-fork-fork', 'b'])
  assert.equal(plan.closure.includes('c'), false, 'a session outside the checkout is not a root')
  assert.equal(plan.closure.includes('stray'), false, 'a session outside the checkout is not a root')
  assert.deepEqual(plan.titles, [
    { sessionId: 'a', title: 'A' },
    { sessionId: 'b' },
    { sessionId: 'a-fork-fork' },
  ])
})

test('no workspace membership argument: a session with no membership entry is still a root', () => {
  const plan = planCheckoutArchive([{ sessionId: 'orphan', cwd: CHECKOUT, blank: false }], CHECKOUT)
  assert.deepEqual(plan.roots, ['orphan'])
  assert.deepEqual(plan.toArchive, ['orphan'])
})

test('a blank (provisional, content-free) session inside the checkout is neither counted nor listed/archived', () => {
  const plan = planCheckoutArchive([
    { sessionId: 'blank-new', workingDirectory: CHECKOUT, blank: true },
    { sessionId: 'real', workingDirectory: CHECKOUT, title: 'Real work', blank: false },
  ], CHECKOUT)
  assert.deepEqual(plan.roots, ['real'])
  assert.deepEqual(plan.closure, ['real'])
  assert.deepEqual(plan.toArchive, ['real'])
  assert.deepEqual(plan.titles, [{ sessionId: 'real', title: 'Real work' }])
  assert.equal(plan.closure.includes('blank-new'), false,
    'the blank default-session placeholder is not counted or archived')
})

test('a blank fork intermediate is traversed but never archived', () => {
  const plan = planCheckoutArchive([
    { sessionId: 'root', workingDirectory: CHECKOUT, title: 'Root', blank: false },
    { sessionId: 'blank-mid', parentSessionId: 'root', cwd: '/repo', blank: true },
    { sessionId: 'grandchild', parentSessionId: 'blank-mid', cwd: '/repo', title: 'Kept work', blank: false },
  ], CHECKOUT)
  assert.deepEqual(plan.roots, ['root'])
  assert.deepEqual(plan.closure, ['root', 'grandchild'],
    'the blank child is omitted while its content-bearing grandchild is included')
  assert.deepEqual(plan.toArchive, ['root', 'grandchild'])
  assert.deepEqual(plan.titles, [
    { sessionId: 'root', title: 'Root' },
    { sessionId: 'grandchild', title: 'Kept work' },
  ])
})

test('archiveBeforeRemove archives plainly, then confirms once with the activity families and retries with stopActivity', async () => {
  const calls: string[] = []
  const confirmations: { sessionId: string; kind: string }[][] = []
  const refused = new Error('workspace/session-active')
  const ok = await archiveBeforeRemove(['a', 'b', 'c'], {
    archivePlain: async (id) => {
      calls.push('plain:' + id)
      if (id !== 'b') return
      throw refused
    },
    archiveStop: async (id) => { calls.push('stop:' + id) },
    readActivityRefusal: error => (error === refused ? [{ kind: 'turn', items: [] }] : undefined),
    confirmStop: async (pending) => {
      confirmations.push(pending.map(item => ({ sessionId: item.sessionId, kind: item.activities[0]?.kind ?? '' })))
      return true
    },
  })
  assert.equal(ok, true)
  assert.deepEqual(calls, ['plain:a', 'plain:b', 'plain:c', 'stop:b'])
  assert.deepEqual(confirmations, [[{ sessionId: 'b', kind: 'turn' }]])
})

test('a cancelled stop confirmation returns false without stopActivity', async () => {
  const calls: string[] = []
  const ok = await archiveBeforeRemove(['a'], {
    archivePlain: async () => { throw new Error('session-active') },
    archiveStop: async () => { calls.push('stop') },
    readActivityRefusal: () => [{ kind: 'turn', items: [] }],
    confirmStop: async () => false,
  })
  assert.equal(ok, false)
  assert.deepEqual(calls, [])
})

test('a non-refusal archive failure aborts before any stop retry', async () => {
  const boom = new Error('network')
  await assert.rejects(archiveBeforeRemove(['a'], {
    archivePlain: async () => { throw boom },
    archiveStop: async () => {},
    readActivityRefusal: error => (error === boom ? undefined : [{ kind: 'turn', items: [] }]),
    confirmStop: async () => true,
  }))
})
