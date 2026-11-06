/**
 * PR2 derived checkout rows (design 08 §3.2-§3.3): the sidebar's read surface.
 *
 * Behaviour locks (the pure helpers the shell renders and drags with) plus
 * source locks for the wiring a plain-node test cannot render: the row owns no
 * kebab/rename, its header folds like the old worktree row (the main fold still
 * hides the whole family), the Git occupant mounts with the SOURCE workspace id and the
 * checkout display identity, and the drag commit persists into `checkoutOrder`
 * (view-prefs) instead of the host order.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { deriveServerWorkspaces, nextServerOrder } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { checkoutOrderKey } from '@dsh-chamber/dsh-chamber-client-core/checkout-placement'
import { hiddenByMainWorkspaceFold, type RepoGitLayout } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import { workspaceTreeDepths, workspaceTreeParents } from '@dsh-chamber/dsh-chamber-client-core/workspace-tree'
import type { ChamberServerWorkspace, InstanceSnapshot } from '@dsh-chamber/dsh-chamber-client-core'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  applyCheckoutOrder, checkoutBranchOf, checkoutHealthLabelKey, checkoutHealthOf, checkoutPathOf,
  checkoutRowFacts, derivedCheckoutFlag, insertCheckoutRows, isCheckoutRow, isRealWorkspaceRow,
  sessionFullOrder, workspaceFlagOf,
} from '../../src/client/checkout-row.ts'
import { orderWorkspaceRows } from '../../src/client/sidebar-context.ts'

const read = (rel: string): string => stripComments(readFileSync(new URL(rel, import.meta.url), 'utf8'))
const SECTION = read('../../src/client/ServerSection.tsx')
const ROWS = read('../../src/client/ServerSectionRows.tsx')
const DRAG = read('../../src/client/sidebar-root-drag.ts')
const ROOT = read('../../src/client/SidebarRoot.tsx')
const CONTEXT = read('../../src/client/sidebar-context.ts')
const CSS = read('../../src/client/sidebar-chamber.module.css')
const CHECKOUT = read('../../src/client/checkout-row.ts')

const MAIN_PATH = '/repo/app'
const CHECKOUT_A = `${MAIN_PATH}/.agents/worktrees/feat-a`
const CHECKOUT_B = `${MAIN_PATH}/.agents/worktrees/feat-b`

/** One unregistered worktree layout row (PR2 requires path/locked). */
function layoutEntry(path: string, overrides: Partial<RepoGitLayout['unregistered'][number]> = {}) {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    worktreeId: `wt:${path}`,
    path,
    branch: path.slice(path.lastIndexOf('/') + 1),
    status: 'ready' as const,
    headState: 'branch' as const,
    attention: [],
    dirty: false,
    locked: false,
    head: 'abc123',
    ...overrides,
  }
}

function layouts(entries: ReturnType<typeof layoutEntry>[] = [layoutEntry(CHECKOUT_A)]): RepoGitLayout[] {
  return [{ repoKey: 'repo-a', mainWorkspaceId: 'w-main', unregistered: entries }]
}

/** Snapshot: one main checkout with two sessions, one of them entered a worktree. */
function snapshot(): InstanceSnapshot {
  return {
    workspaces: [{
      workspaceId: 'w-main', path: MAIN_PATH, title: 'app', sessionIds: ['s1', 's2'], createdAt: '', updatedAt: '',
    }],
    sessions: [
      { sessionId: 's1', title: 'One', displayTitle: 'One', running: false, blank: false, cwd: MAIN_PATH, updatedAt: 5 },
      { sessionId: 's2', title: 'Two', displayTitle: 'Two', running: false, blank: false, cwd: MAIN_PATH, workingDirectory: CHECKOUT_A, updatedAt: 6 },
    ],
    archivedSessionIds: [],
  }
}

function derived(): ChamberServerWorkspace[] {
  return deriveServerWorkspaces(snapshot(), 'local', '', undefined, 1_000, 'default', layouts(), 1)
}

const checkoutRow = (rows: readonly ChamberServerWorkspace[], path = CHECKOUT_A): ChamberServerWorkspace | undefined =>
  rows.find(row => isCheckoutRow(row) && checkoutPathOf(row) === path)

test('the derive emits a checkout row per unregistered worktree, right after its main, with placement', () => {
  const rows = derived()
  assert.equal(rows[0]?.id, 'w-main', 'the main row keeps its position')
  assert.equal(isCheckoutRow(rows[0]!), false, 'the main is a host workspace row')
  const row = checkoutRow(rows)
  assert.ok(row !== undefined, 'the unregistered worktree is a row')
  assert.equal(row.kind, 'checkout')
  assert.equal(row.path, CHECKOUT_A)
  assert.equal(row.familyMainId, 'w-main')
  assert.equal(row.repoKey, 'repo-a')
  assert.notEqual(row.synthetic, true, 'a checkout row is never the synthetic cwd fallback')
  assert.deepEqual(row.sessions.map(session => session.id), ['s2'], 'the entered session is placed here')
  assert.deepEqual(rows[0]?.sessions.map(session => session.id), ['s1'], 'the main row keeps only unplaced members')
  assert.deepEqual(rows[0]?.allSessionIds, ['s1', 's2'], 'the main row carries the PRE-placement membership order')
  assert.equal(rows.indexOf(row!), 1, 'the checkout row sits right after its main (host order untouched)')
})

test('an override never floats a checkout row above its family: it rides the main block', () => {
  const rows = derived()
  const other: ChamberServerWorkspace = { id: 'w-other', title: 'other', path: '/repo/other', sessions: [] }
  // Display order: main (+ checkout), other. A drag override that knows only the
  // real ids would PREPEND the unknown checkout id in orderWithOverride.
  const ordered = orderWorkspaceRows('local', [...rows, other], ['w-other', 'w-main'], undefined)
  assert.deepEqual(ordered.map(row => row.id), ['w-other', 'w-main', checkoutRow(rows)!.id],
    'the checkout row follows its main after the family move')
  assert.deepEqual(ordered.filter(row => isRealWorkspaceRow(row)).map(row => row.id), ['w-other', 'w-main'],
    'the host rows carry the override order')
})

test('the checkout sub-order applies inside the family slots only', () => {
  const rows = derived()
  const [main, row] = [rows[0]!, checkoutRow(rows)!]
  const second: ChamberServerWorkspace = { ...row, id: '__checkout__:' + CHECKOUT_B, path: CHECKOUT_B, title: 'feat-b' }
  const family = [row, second]
  const stored = { [checkoutOrderKey('local', MAIN_PATH)]: [CHECKOUT_B, CHECKOUT_A] }
  assert.deepEqual(applyCheckoutOrder('local', family, MAIN_PATH, stored).map(item => item.path), [CHECKOUT_B, CHECKOUT_A])
  assert.deepEqual(applyCheckoutOrder('local', family, MAIN_PATH, undefined).map(item => item.path), [CHECKOUT_A, CHECKOUT_B],
    'no stored order = derive order')
  // insert at the family's slot: the real rows keep their positions.
  const mixed = [main, row, second, { id: 'w-other', title: 'other', path: '/repo/other', sessions: [] }]
  const inserted = insertCheckoutRows('local', [main, mixed[3]!], [row, second], stored)
  assert.deepEqual(inserted.map(item => item.id), [main.id, second.id, row.id, 'w-other'])
})

test('the in-family drag math round-trips: nextServerOrder over canonical paths → checkoutOrder', () => {
  const rows = derived()
  const base = checkoutRow(rows)!
  const paths = [CHECKOUT_A, CHECKOUT_B, '/repo/app/.agents/worktrees/feat-c']
  const family = paths.map((path, index) => ({ ...base, id: `__checkout__:${path}`, path, title: `wt-${String(index)}` }))
  // The commit's pure half (sidebar-root-drag commitCheckoutDrag): the anchor is
  // computed on the RENDERED sub-order of canonical paths, then persisted verbatim.
  const moved = nextServerOrder(paths, paths[2]!, { id: paths[0]!, half: 'before' })
  assert.deepEqual(moved, [paths[2], paths[0], paths[1]], 'moving the last row before the first')
  const stored = { [checkoutOrderKey('local', MAIN_PATH)]: moved! }
  assert.deepEqual(applyCheckoutOrder('local', family, MAIN_PATH, stored).map(row => row.path), moved)
  assert.equal(nextServerOrder(paths, paths[1]!, { id: paths[0]!, half: 'after' }), null,
    'a drop that changes nothing is a no-op (no view-prefs write)')
})

test('a checkout row folds with its main row and inherits the tree level', () => {
  const rows = derived()
  const row = checkoutRow(rows)!
  const flag = workspaceFlagOf('local', row)
  assert.deepEqual(derivedCheckoutFlag(row), { isWorktree: true, isMain: false, mainWorkspaceId: 'w-main', repoKey: 'repo-a' },
    'the derived row synthesizes its own flag (the flags store publishes real rows only)')
  assert.equal(hiddenByMainWorkspaceFold(flag, true, true), true, 'folding the main hides the checkout row')
  assert.equal(hiddenByMainWorkspaceFold(flag, true, false), false, 'a vanished main must not lock the row hidden')
  assert.equal(isCheckoutRow(rows[0]!), false)
  assert.equal(derivedCheckoutFlag(rows[0]), undefined, 'a host workspace never gets a synthesized flag')
  const parents = workspaceTreeParents(
    [rows[0]!, row],
    id => (id === row.id ? 'w-main' : undefined),
  )
  assert.equal(parents.get(row.id), parents.get('w-main'), 'the checkout nests at its main level, never under it')
  assert.equal(workspaceTreeDepths(parents).get(row.id), workspaceTreeDepths(parents).get('w-main'))
})

test('row facts are fail-closed: absent layouts never read as healthy', () => {
  const row = checkoutRow(derived())!
  assert.equal(checkoutHealthOf('local', row, layouts()), 'ready')
  assert.equal(checkoutHealthLabelKey('ready'), undefined, 'a healthy row carries no hint')
  assert.equal(checkoutHealthOf('local', row, []), 'unknown', 'no facts = unknown, never ready')
  assert.equal(checkoutHealthLabelKey('unknown'), 'checkout.statusUnknown')
  const missing = layouts([layoutEntry(CHECKOUT_A, { status: 'missing', branch: null })])
  assert.equal(checkoutHealthOf('local', row, missing), 'missing')
  assert.equal(checkoutHealthLabelKey('missing'), 'checkout.missing')
  assert.equal(checkoutBranchOf('local', row, missing), undefined, 'a detached/unknown branch falls back to the row title')
  const facts = checkoutRowFacts('local', row, 'feat-a', missing)
  assert.equal(facts.branch, 'feat-a')
  assert.equal(facts.healthKey, 'checkout.missing')
  // The store fallback path (no layouts argument) reads the published layouts.
  assert.equal(checkoutHealthOf('local', row), 'unknown', 'the store is empty in this process')
})

test('the session drag anchor space is the source full order when the family has checkouts', () => {
  const rows = derived()
  assert.deepEqual(sessionFullOrder(rows[0]!), ['s1', 's2'], 'the main row exposes the pre-placement order')
  assert.deepEqual(sessionFullOrder({ id: 'w', title: '', sessions: [{ id: 'x', title: '', displayTitle: 'x' }] }), ['x'],
    'a family without checkouts keeps its own members as the full order')
})

test('the checkout row renders as an action seat row, never as a workspace row', () => {
  // No kebab/rename: the row-action cluster is gated on !checkout, and the
  // double-click rename gate early-returns for a checkout row.
  assert.ok(SECTION.includes('{checkout && (') && SECTION.includes('{!checkout && !workspace.ungrouped && !workspace.synthetic && ('),
    'the host workspace kebab cluster is gated off the checkout row')
  assert.ok(SECTION.includes('|| workspace.synthetic === true || checkout) return'),
    'a checkout row never arms the inline rename')
  // The header folds like the old worktree row; the state key is the row's own.
  assert.ok(SECTION.includes('aria-expanded={!folded}'))
  assert.ok(SECTION.includes('const folded = viewPrefs.folded[accountStateKey] === true'))
  assert.ok(SECTION.includes("toggleWorkspaceFold(server.id, workspace.id)"), 'the fold toggle is shared')
  assert.ok(SECTION.includes('data-checkout-row={checkout ? \'\' : undefined}'))
  // The Git occupant is the only action surface: it mounts with the SOURCE
  // workspace id plus the display identity, and the host-workspace mount is off.
  assert.ok(SECTION.includes('workspaceId: workspace.familyMainId ?? workspace.id,'))
  assert.ok(SECTION.includes('checkout: {') && SECTION.includes('path: checkoutFacts.path,')
    && SECTION.includes('branch: checkoutFacts.branch,') && SECTION.includes('title: checkoutFacts.title,'),
  'the checkout display identity rides the occurrence context')
  assert.ok(SECTION.includes('{checkout && checkoutFacts?.path !== undefined && ('),
    'no path = no seat: a derived row never degrades into a duplicate workspace seat')
  assert.ok(SECTION.includes('{!checkout && workspace.ungrouped !== true && workspace.synthetic !== true && ('),
    'a checkout row never mounts the host-workspace occupant')
  assert.ok(SECTION.includes("renderWorkspaceGit('sidebar.workspace.git', { wide }, {"),
    'the occupant receives the column state (the plugin hides itself on the rail)')
  // Keyboard reachability for the seat: the fold button is the tab stop (as on
  // the old worktree row) and focus reuses the shared .rowActionsVisible reveal.
  assert.ok(SECTION.includes('(menuOpen[workspaceKey] === true || keyboardFocusKey === workspaceKey)'),
    'the shared keyboard reveal state drives the checkout occupant too')
  assert.equal(/data-checkout-row[^{]*\{[^}]*data-git-occupant[^}]*display/u.test(CSS), false,
    'no resident occupant rule: checkout rows reveal on hover like every workspace row')
})

test('the row renders branch title, health hint, count and its own empty state', () => {
  assert.ok(SECTION.includes('checkoutRowFacts(server.id, workspace, workspace.title)'))
  assert.ok(SECTION.includes("checkoutFacts.branch, checkoutFacts.path ?? ''"),
    'the title carries a branch/path tooltip (a checkout row has no hover card)')
  assert.ok(SECTION.includes('data-chamber-checkout-health={checkoutFacts?.healthKey}'))
  assert.ok(SECTION.includes('{visibleSessionCount > 0 && ('), 'the session count badge is shared with host rows')
  assert.ok(SECTION.includes("{t('checkout.empty')}"), 'a 0-session checkout row still says so')
  assert.equal(SECTION.includes('data-chamber-checkout-glyph'), false, 'the static (non-foldable) glyph is retired')
  assert.ok(SECTION.includes('gitRow\n                                    ? cc.foldToggleGit'),
    'the header gutter keeps the worktree/checkout branch glyph + chevron swap')
  // pin / archive / count parity: the placed sessions ride the SAME account order and
  // the SAME pin partition pipeline as a host row (only the account id is the source's).
  assert.ok(SECTION.includes('const accountId = checkoutFamilyMainOf(workspace) ?? workspace.id'),
    'a checkout row reads the SOURCE session account for its order')
  assert.ok(SECTION.includes('const sessions = flatAccount ? flatSessions : sessionsOf(workspace)'),
    'placed sessions ride one window/pin pipeline (no second row renderer)')
  assert.ok(SECTION.includes('const next = partitionPinnedSessions(sessionsInOrder(workspace), pinOptions)'),
    'the pin partition is the shared one for every row kind')
})

test('placed sessions render like host-row sessions (no per-session branch glyph)', () => {
  assert.equal(ROWS.includes('data-chamber-checkout-session-glyph'), false,
    'the session row carries no checkout glyph (old worktree-session display parity)')
  assert.equal(ROWS.includes('checkoutParent'), false, 'the glyph facts/prop are retired')
  assert.equal(SECTION.includes('checkoutParent'), false, 'the sidebar passes no checkout parent down')
})

test('the drag commits the checkout sub-order into view-prefs, blocked across families', () => {
  assert.ok(DRAG.includes('checkoutOrderKey(server.id, main.path)'), 'the key is the core helper (no local spelling)')
  assert.equal(CHECKOUT.includes('__checkout__:'), false, 'the sidebar owns no second key spelling')
  assert.ok(DRAG.includes('if (checkoutFamilyMainOf(target) !== activeDrag.mainId) return'),
    'a drop outside the row family is a no-op (blocked by construction, no marker)')
  assert.ok(DRAG.includes('checkoutOrder: { ...prev.checkoutOrder, [key]: nextOrder }'), 'the order lands in view-prefs')
  assert.ok(DRAG.includes('const nextOrder = nextServerOrder(renderedOrder, activeDrag.path, { id: targetPath, half: over.half })'),
    'the anchor is computed on the rendered sub-order of canonical paths')
  assert.ok(DRAG.includes('sessionFullOrder(workspace)'), 'session drags inside a checkout row anchor on the source full order')
  assert.ok(DRAG.includes('if (rowOfSession(over.id) !== activeDrag.placementId) return'),
    'cross-row session drops are a no-op (the rows share an account)')
  assert.ok(SECTION.includes('const activeSessionDrag = sessionDrag !== null') && SECTION.includes('&& sessionDrag.placementId === workspace.id'),
    'the drag marker is keyed on the placement row, not on the account')
  assert.ok(SECTION.includes('dragAccountKey={checkout ? (workspace.familyMainId ?? workspace.id) : workspace.id}'))
  // The family drag stays wire-only: checkout rows are never in the resolver order.
  assert.ok(SECTION.includes('.filter(workspace => isRealWorkspaceRow(workspace))'))
  assert.ok(DRAG.includes('.filter(isRealWorkspaceRow)'))
})

test('flat renders no checkout row (its sessions ride the flat account)', () => {
  assert.ok(SECTION.includes('(flatGroupBy ? [flatWorkspace] : visibleOrderedWorkspaces).map(workspace => {'),
    'flat replaces the workspace rows with the single pseudo account')
  assert.ok(SECTION.includes('const flatMemberSessions = flatGroupBy'), 'placed sessions still enter the flat account')
})

test('the shell threads the checkout drag state through one context', () => {
  for (const key of ['checkoutDrag', 'setCheckoutDrag', 'commitCheckoutDrag', 'checkoutDropCommitted']) {
    assert.ok(ROOT.includes(`    ${key},`), 'SidebarRoot destructures ' + key)
    assert.ok(CONTEXT.includes(key + ':'), 'the section context declares ' + key)
  }
  assert.ok(DRAG.includes('const checkoutAlive = (drag: CheckoutDragState): boolean =>')
    && DRAG.includes('checkoutDrag !== null && !checkoutAlive(checkoutDrag)'),
  'a vanished checkout row is part of the drag watchdog (no stuck click suppression)')
  assert.ok(DRAG.includes('setCheckoutDrag(null)'), 'the watchdog clears the checkout drag state')
})
