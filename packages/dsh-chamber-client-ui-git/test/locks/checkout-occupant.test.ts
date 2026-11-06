/**
 * Checkout-row occupant wiring lock (design 08 PR2, 11-final-design §5.2; PR3
 * cleanup in §6).
 *
 * The derived kind:'checkout' row mounts the SAME sidebar.workspace.git seat as a
 * registered workspace row, but its occurrence context carries the frozen
 * checkout:{path,branch,title} and keeps workspaceId pointing at the SOURCE main
 * workspace. This lock pins the wiring a plain node run cannot import (the
 * component value-imports React + the design-system package):
 *  - the checkout branch resolves facts by PATH and precedes the source/workspace
 *    lookup (a checkout row must never render the main workspace's actions);
 *  - its actions are exactly new session / path-based removal / copy path, all
 *    behind the host's reveal hooks, and its dirty/locked/unknown status capsule
 *    is a member of that same reveal cluster (never a rest row label);
 *  - PR3 is irreversible: the legacy unregistered block and the registered
 *    removal path are GONE, while the create dialog still only creates checkouts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { normalize, stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

/** Comment-stripped source: a lock must never be satisfied by prose. */
const source = (relative: string): string =>
  stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const LINE = source('../../src/client/SidebarWorkspaceGitLine.tsx')
const COORDINATOR = source('../../src/shared/coordinator.ts')
const LAYOUT = source('../../src/shared/layout.ts')
const TYPES = source('../../src/shared/types.ts')
const CREATE_DIALOG = source('../../src/client/CreateWorktreeDialog.tsx')
const REMOVAL = source('../../src/client/useCheckoutRemoval.tsx')
const REMOVE_DIALOG = source('../../src/client/CheckoutRemoveDialog.tsx')
const STOP_DIALOG = source('../../src/client/CheckoutArchiveStopDialog.tsx')
const ARCHIVE_FACTS = source('../../src/client/checkout-archive-facts.ts')

const flat = (text: string): string => normalize(text)

/** The derived-checkout branch: from its dispatch to the source-scope alert. */
const checkoutStart = LINE.indexOf('const checkout = context.checkout')
const sourceBlockStart = LINE.indexOf("if (context.workspaceId === '')", checkoutStart)
const checkoutBranch = LINE.slice(checkoutStart, sourceBlockStart)
/** The registered-workspace mount: after the source alert branch (comments are
 *  stripped, so the anchor is code). */
const workspaceBlockStart = LINE.indexOf('const snapshot = source.snapshot', sourceBlockStart)
const workspaceBranch = LINE.slice(workspaceBlockStart)

test('the occurrence context consumes the frozen checkout fields without touching the slot contract', () => {
  assert.notEqual(checkoutStart, -1, 'the checkout occurrence is consumed')
  assert.ok(sourceBlockStart > checkoutStart, 'the checkout branch precedes the source/workspace branches')
  assert.match(flat(LINE), /checkout\?: \{ path: string; branch: string \| null; title: string \}/,
    'the occupant declares the frozen checkout:{path,branch,title} occurrence')
  // The checkout branch must never fall through to the workspace-scoped lookup:
  // workspaceId names the SOURCE main workspace, not the checkout's identity.
  assert.doesNotMatch(flat(checkoutBranch), /gitFactsForWorkspace/,
    'a checkout row must not resolve facts by the source workspace id')
})

test('checkout facts resolve by path and stay scoped to the row repository', () => {
  assert.match(flat(checkoutBranch), /findCheckout\(snapshot, checkout\.path, context\.repoKey\)/,
    'the checkout row resolves its snapshot row by canonical path')
  assert.match(flat(checkoutBranch), /checkoutRemoveBlockReason\(worktree, currentSessionId\)/,
    'the removal affordance reads the checkout-specific guard, never the registered one')
})

test('the checkout row offers exactly its three actions behind the host reveal hooks', () => {
  assert.match(flat(checkoutBranch), /createSessionHere\(context\.sourceId, checkout\.path\)/,
    'new session: session.create(source) + enter(path) — PR1 createSessionHere')
  assert.match(flat(checkoutBranch), /\{removal\.dialog\}/,
    'the checkout row renders the shared path-based removal confirmation')
  assert.match(flat(REMOVAL), /removeUnregisteredWorktree\(sourceId, \{/,
    'removal goes through the path-based unregistered removal (no workspace.delete)')
  assert.match(flat(checkoutBranch), /copyCheckoutPath\(checkout\.path\)/,
    'copy path: the row canonical path through the clipboard affordance')
  const actionHooks = checkoutBranch.match(/data-git-action=""/gu) ?? []
  assert.ok(actionHooks.length >= 3, 'all three actions carry the hover/keyboard reveal hook')
  assert.match(LINE, /className=\{css\.headerGit\} data-git-occupant=""/u,
    'the occupant container carries the cross-package rest-footprint hook')
})

test('the status capsule is a reveal-cluster member, before the three actions', () => {
  const flatBranch = flat(checkoutBranch)
  const occupantAt = flatBranch.indexOf('className={css.headerGit}')
  const capsuleAt = flatBranch.indexOf('className={css.checkoutStatus}')
  assert.notEqual(occupantAt, -1, 'the occupant container still renders')
  assert.notEqual(capsuleAt, -1, 'the dirty/locked/unknown capsule still renders')
  assert.ok(occupantAt < capsuleAt,
    'the status word is a member of the hover/keyboard-revealed occupant container (design 08 §3.2)')
  // The container must not close between its opening and the capsule: that is
  // nesting, not merely "renders after the container" (the retired 0.4.4 shape).
  assert.ok(!flatBranch.slice(occupantAt, capsuleAt).includes('</span>'),
    'the capsule is INSIDE the occupant container body')
  assert.match(flatBranch, /data-git-checkout-status=""/u,
    'the capsule keeps the cross-package data hook (CSS modules hash the class)')
  const capsuleRefAt = flatBranch.indexOf('css.checkoutStatus', occupantAt)
  assert.ok(capsuleRefAt >= capsuleAt, 'the capsule class usage follows the container opening')
  assert.equal(flatBranch.indexOf('css.checkoutStatus', capsuleRefAt + 1), -1,
    'exactly one capsule declaration, and it is the one inside the container')
  assert.ok(flatBranch.indexOf('data-git-action', capsuleAt) > capsuleAt,
    'the status word precedes the reveal actions (the leftmost cluster member)')
})

test('the checkout row never renders workspace management (no create dialog, no registered removal)', () => {
  for (const forbidden of ['CreateWorktreeDialog', 'setCreateOpen', 'RemoveWorktreeDialog', 'setRemoveTarget']) {
    assert.ok(!checkoutBranch.includes(forbidden), 'a checkout row must not render ' + forbidden)
  }
  // No independent fold/kebab affordance: the row header belongs to the sidebar and
  // only the main workspace row collapses the family (11-final-design §4).
  for (const forbidden of ['fold', 'kebab', 'rename']) {
    assert.ok(!checkoutBranch.toLowerCase().includes(forbidden), 'a checkout row exposes no ' + forbidden)
  }
})

test('PR3: the unregistered block and the registered removal path are gone', () => {
  // The legacy repo-scope block (Plan A) is replaced by derived checkout rows.
  assert.doesNotMatch(flat(LINE), /context\.workspaceId === '' && context\.repoKey/,
    'no repo-scope unregistered block branch may survive')
  assert.doesNotMatch(LINE, /t\('unregisteredTitle'\)/, 'the block heading copy is retired')
  assert.doesNotMatch(flat(LINE), /createSessionHere\(context\.sourceId, worktree\.path\)/,
    'the block-only create-session entry is gone')
  // The registered remove dialog and coordinator path are retired.
  assert.doesNotMatch(LINE, /<RemoveWorktreeDialog|RemoveViewTarget|setRemoveTarget|removeWorktree\(/,
    'the registered removal dialog/state may not reappear')
  assert.doesNotMatch(COORDINATOR, /export async function removeWorktree\(/,
    'the registered removal coordinator path is retired')
  assert.doesNotMatch(COORDINATOR, /workspaceDelete|deleteWorkspaceForSource|archiveSessionForSource/,
    'no workspace-delete handoff or archive prerequisite may remain')
  // The registered-workspace mount keeps ONLY the create entry.
  assert.match(flat(workspaceBranch), /if \(primary === undefined \|\| !primary\.isMain\) return null/,
    'a registered worktree (or non-git workspace) renders no Git action')
  assert.doesNotMatch(flat(workspaceBranch), /RemoveWorktreeDialog|runningRemoveTitle|blocked/,
    'the registered mount carries no removal affordance')
  // The create dialog still only creates checkouts (PR1: no workspace/session leg).
  assert.match(CREATE_DIALOG, /createFromPreview\(sourceId, preview\)/)
  assert.doesNotMatch(CREATE_DIALOG, /createSessionHere|workspace\.create|createWorkspace|rollbackCreate/,
    'the create dialog never creates a workspace or a session')
})

test('the removal flow is close-safe, re-plans the archive at confirm, and arms the force acknowledgements', () => {
  // A confirmed removal cannot be dismissed by X/Escape/mask (only the success
  // path closes it): the async step would otherwise continue after an apparent cancel.
  assert.match(flat(REMOVE_DIALOG), /if \(disabled\) return/,
    'the dialog ignores a close while removal is disabled')
  assert.match(flat(REMOVE_DIALOG), /onClose=\{requestClose\}/,
    'the Modal close path uses the guarded close')
  // The archive roots are physical sessions, planned from the unary snapshot and
  // re-fetched at confirm; no polled workspace membership and no stale preview.
  assert.match(flat(ARCHIVE_FACTS), /planCheckoutArchive\(/)
  assert.match(flat(ARCHIVE_FACTS), /archiveSetKnown === true/)
  assert.match(flat(REMOVAL), /fetchCheckoutArchiveFacts\(sourceId, target\.path/,
    'the confirm path re-plans with fresh facts')
  assert.doesNotMatch(flat(REMOVAL), /main\.sessionIds/, 'archive roots do not depend on polled membership')
  assert.match(flat(REMOVAL), /readActivityRefusal: error => sessionArchiveRefusal\(error\)/,
    'the stop confirmation carries the activity families')
  assert.match(flat(REMOVAL), /<CheckoutArchiveStopDialog/, 'the stop confirmation is the activity-list dialog')
  assert.doesNotMatch(flat(REMOVAL), /<RiskConfirmation/, 'the generic risk dialog is not the stop surface')
  // Dirty/submodule host refusals re-arm the acknowledgment and the retry is a
  // separate, explicit discard authorization.
  assert.match(flat(REMOVAL), /removeFailureCode\(error\)/)
  assert.match(flat(REMOVAL), /worktree-submodules/)
  assert.match(flat(REMOVAL), /setRowForceReason/)
  assert.match(flat(REMOVAL), /unregisteredRemoveOptions\(discard, rowDeleteBranch/)
  assert.match(flat(STOP_DIALOG), /archiveActivityList/)
})

test('the coordinator publishes the layout projection with the placement keys (path/locked)', () => {
  assert.match(flat(COORDINATOR), /setSourceRepoLayouts\(sourceId, repoLayouts\(snapshot\)\)/,
    'one pure layout projection feeds the sidebar registry')
  assert.doesNotMatch(COORDINATOR, /layouts\.push\(/,
    'no second inline layout builder may remain beside the pure projection')
  assert.match(flat(LAYOUT), /path: worktree\.path/, 'the layout row carries the canonical checkout path')
  assert.match(flat(LAYOUT), /locked: worktree\.locked/, 'the layout row carries the removal guard locked fact')
  assert.match(flat(LAYOUT), /if \(worktree\.isMain \|\| worktree\.workspaceId !== null\) continue/,
    'the main checkout and registered worktrees never become unregistered layout rows')
  // The published fact type declares both keys (consumers must be able to rely on them).
  const start = TYPES.indexOf('export interface UnregisteredWorktreeInfo {')
  assert.notEqual(start, -1, 'the published layout fact interface exists')
  const body = TYPES.slice(start, TYPES.indexOf('}', start))
  assert.match(body, /path: string/, 'path is a REQUIRED layout fact')
  assert.match(body, /locked: boolean/, 'locked is a REQUIRED layout fact')
})
