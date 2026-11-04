/**
 * checkout-placement leaf tests (design 08 PR2 §5.2): path-segment longest
 * prefix placement, `workingDirectory ?? cwd`, host-membership eligibility,
 * main-row/registered-path suppressions, the `__checkout__:` identity/order key
 * spelling and the stored sub-order reconcile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKOUT_ID_PREFIX,
  checkoutOrderKey,
  checkoutPathKey,
  checkoutRowId,
  orderCheckoutRows,
  parseCheckoutOrderKey,
  planCheckoutPlacements,
} from '../src/checkout-placement.ts'
import { checkoutWorkspaceOf } from '../src/checkout-placement.ts'
import { layout, session, snapshot, workspace, worktree } from './support/fixtures.ts'

const MAIN = '/repo'
const FEAT = '/repo/.agents/worktrees/feat'
const OTHER = '/repo/.agents/worktrees/other'

test('placement: longest path-segment prefix wins; workingDirectory overrides cwd', () => {
  const rows = snapshot(
    [workspace('m1', MAIN, ['s-cwd', 's-wd', 's-sub', 's-sibling', 's-main'])],
    [
      session('s-cwd', { cwd: FEAT }),
      // A stale header cwd (the source) must LOSE to the projected working dir.
      session('s-wd', { cwd: MAIN, workingDirectory: FEAT }),
      session('s-sub', { cwd: `${OTHER}/src/deep` }),
      // '/repo/.agents/worktrees/feature-x' is NOT under '.../feat' (segment boundary).
      session('s-sibling', { cwd: '/repo/.agents/worktrees/feature-x' }),
      session('s-main', { cwd: MAIN }),
    ],
    { },
  )
  const plan = planCheckoutPlacements({
    workspaces: rows.workspaces,
    sessions: rows.sessions,
    layouts: [layout('r1', 'm1', [worktree(FEAT, { branch: 'feat' }), worktree(OTHER)])],
  })
  const feat = plan.rowsByMainWorkspaceId.get('m1')?.find(row => row.path === FEAT)
  const other = plan.rowsByMainWorkspaceId.get('m1')?.find(row => row.path === OTHER)
  assert.deepEqual(feat?.sessionIds, ['s-cwd', 's-wd'], 'cwd and the working-directory override share one membership order')
  assert.deepEqual(other?.sessionIds, ['s-sub'])
  assert.deepEqual([...plan.placedSessionIds].sort(), ['s-cwd', 's-sub', 's-wd'])
  assert.equal(feat?.title, 'feat', 'branch titles the row')
  assert.equal(other?.title, 'other', 'a detached checkout falls back to the directory name')
  assert.equal(feat?.repoKey, 'r1')
  assert.equal(feat?.worktree.locked, false)
})

test('placement: nested checkouts use the deepest prefix; equal length keeps layout order', () => {
  const outer = '/repo/.agents/worktrees/a'
  const inner = `${outer}/nested`
  const rows = snapshot(
    [workspace('m1', MAIN, ['s-inner', 's-outer'])],
    [session('s-inner', { cwd: `${inner}/pkg` }), session('s-outer', { cwd: `${outer}/pkg` })],
  )
  const plan = planCheckoutPlacements({
    workspaces: rows.workspaces,
    sessions: rows.sessions,
    layouts: [layout('r1', 'm1', [worktree(outer), worktree(inner)])],
  })
  assert.deepEqual(plan.rowsByMainWorkspaceId.get('m1')?.map(row => row.path), [outer, inner], 'layout order is kept')
  assert.deepEqual(plan.rowsByMainWorkspaceId.get('m1')?.find(row => row.path === inner)?.sessionIds, ['s-inner'])
  assert.deepEqual(plan.rowsByMainWorkspaceId.get('m1')?.find(row => row.path === outer)?.sessionIds, ['s-outer'])
})

test('placement: host membership is the eligibility gate (strays/other workspaces stay put)', () => {
  const rows = snapshot(
    [workspace('m1', MAIN, ['s-member']), workspace('w2', '/repo/other-registered', ['s-other-member'])],
    [
      session('s-member', { cwd: FEAT }),
      // Not a member of m1 even though its cwd is inside m1's checkout.
      session('s-stray', { cwd: FEAT }),
      // A member of ANOTHER registered workspace keeps that row.
      session('s-other-member', { cwd: FEAT }),
    ],
  )
  const plan = planCheckoutPlacements({
    workspaces: rows.workspaces,
    sessions: rows.sessions,
    layouts: [layout('r1', 'm1', [worktree(FEAT)])],
  })
  assert.deepEqual(plan.rowsByMainWorkspaceId.get('m1')?.[0]?.sessionIds, ['s-member'])
  assert.deepEqual([...plan.placedSessionIds], ['s-member'])
})

test('no checkout row: unregistered main, unknown main row, synthetic main, or registered path', () => {
  const rows = snapshot(
    [workspace('m1', MAIN, ['s1', 's2']), workspace('registered', FEAT, ['s-reg'])],
    [session('s1', { cwd: FEAT }), session('s2', { cwd: OTHER })],
  )
  for (const mainWorkspaceId of [null, 'gone']) {
    const plan = planCheckoutPlacements({
      workspaces: rows.workspaces,
      sessions: rows.sessions,
      layouts: [layout('r1', mainWorkspaceId, [worktree(OTHER)])],
    })
    assert.equal(plan.rowsByMainWorkspaceId.size, 0, `main=${String(mainWorkspaceId)} produces no family rows`)
    assert.equal(plan.placedSessionIds.size, 0)
  }
  // Synthetic cwd-derived rows are never a family main.
  const synthetic = snapshot([workspace('m1', MAIN, ['s1'], { synthetic: true })], [session('s1', { cwd: FEAT })])
  assert.equal(planCheckoutPlacements({
    workspaces: synthetic.workspaces,
    sessions: synthetic.sessions,
    layouts: [layout('r1', 'm1', [worktree(OTHER)])],
  }).rowsByMainWorkspaceId.size, 0)

  // A checkout that the host ALREADY registered keeps its workspace row: no
  // duplicate row and no cross-row move (design 08 I3).
  const registeredPlan = planCheckoutPlacements({
    workspaces: rows.workspaces,
    sessions: rows.sessions,
    layouts: [layout('r1', 'm1', [worktree(FEAT), worktree(OTHER)])],
  })
  const paths = registeredPlan.rowsByMainWorkspaceId.get('m1')?.map(row => row.path) ?? []
  assert.deepEqual(paths, [OTHER], 'the registered checkout path is suppressed')
  assert.deepEqual(registeredPlan.rowsByMainWorkspaceId.get('m1')?.[0]?.sessionIds, ['s2'])
  assert.equal(registeredPlan.placedSessionIds.size, 1)
})

test('checkout identity/order keys: __checkout__ family, canonical paths, parse round-trip', () => {
  assert.equal(CHECKOUT_ID_PREFIX, '__checkout__:')
  assert.equal(checkoutRowId(FEAT), `__checkout__:${FEAT}`)
  assert.equal(checkoutRowId(`${FEAT}/`), checkoutRowId(FEAT), 'trailing separators are canonicalized')
  assert.equal(checkoutPathKey('C:\\\\repo\\\\'), 'C:\\\\repo', 'only trailing separators are stripped')
  const posix = checkoutOrderKey('local', MAIN)
  assert.equal(posix, '__checkout__:local//repo')
  assert.deepEqual(parseCheckoutOrderKey(posix), { sourceId: 'local', mainPath: MAIN })
  const ssh = checkoutOrderKey('ssh-a', 'C:/repo/')
  assert.deepEqual(parseCheckoutOrderKey(ssh), { sourceId: 'ssh-a', mainPath: 'C:/repo' })
  assert.equal(parseCheckoutOrderKey('__checkout__:'), undefined)
  assert.equal(parseCheckoutOrderKey('__checkout__:local'), undefined)
  assert.equal(parseCheckoutOrderKey('__checkout__:/repo'), undefined, 'an empty source is malformed')
  assert.equal(parseCheckoutOrderKey('updatedOrder/local/repo'), undefined)
})

test('orderCheckoutRows: stored canonical paths first, unknown rows trail, no stored order keeps order', () => {
  const a = { id: 'a', path: '/x/a' }
  const b = { id: 'b', path: '/x/b' }
  const c = { id: 'c', path: '/x/c' }
  const noPath: { id: string; path?: string } = { id: 'raw' }
  const rows: Array<{ id: string; path?: string }> = [a, b, c, noPath]
  assert.deepEqual(orderCheckoutRows(rows, undefined).map(row => row.id), ['a', 'b', 'c', 'raw'])
  assert.deepEqual(orderCheckoutRows(rows, []).map(row => row.id), ['a', 'b', 'c', 'raw'])
  assert.deepEqual(orderCheckoutRows(rows, ['/x/c', '/x/gone', '/x/a']).map(row => row.id), ['c', 'a', 'b', 'raw'])
  assert.notEqual(orderCheckoutRows(rows, ['/x/c']), rows, 'always a fresh array for the caller')
  assert.deepEqual(orderCheckoutRows(rows, ['/x/gone']).map(row => row.id), ['a', 'b', 'c', 'raw'])
})

test('checkoutWorkspaceOf emits the frozen derived shape (no synthetic, no reusable blank)', () => {
  const row = checkoutWorkspaceOf({
    mainWorkspaceId: 'm1',
    repoKey: 'r1',
    title: 'feat',
    path: FEAT,
    pathKey: checkoutPathKey(FEAT),
    worktree: worktree(FEAT),
    sessionIds: ['s2', 's1'],
  }, id => ({ id, title: '', displayTitle: id }))
  assert.deepEqual(row, {
    id: checkoutRowId(FEAT),
    title: 'feat',
    path: FEAT,
    kind: 'checkout',
    repoKey: 'r1',
    familyMainId: 'm1',
    sessions: [{ id: 's2', title: '', displayTitle: 's2' }, { id: 's1', title: '', displayTitle: 's1' }],
  })
  assert.equal('synthetic' in row, false)
  assert.equal('reusableBlankSessionId' in row, false)
  // Visibility: an undefined row is omitted, not invented.
  assert.deepEqual(checkoutWorkspaceOf({
    mainWorkspaceId: 'm1', repoKey: 'r1', title: 'x', path: FEAT, pathKey: '', worktree: worktree(FEAT), sessionIds: ['hidden'],
  }, () => undefined).sessions, [])
})
