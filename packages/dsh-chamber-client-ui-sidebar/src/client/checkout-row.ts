/**
 * Sidebar read surface for DERIVED checkout rows (design 08 / 11 §4-§5): the
 * App derive synthesizes one row per Git worktree the source's repo layouts
 * report (`kind: 'checkout'`), and this shell renders/drags/folds/tree-nests
 * them with the same machinery as host workspaces. Everything here is pure and
 * git-type-light on purpose: the sidebar never becomes a Git surface, it reads
 * the neutral layout/flags stores the Git plugin publishes.
 *
 * Two identities ride every checkout row and must not be conflated:
 *  - the ROW id (`__checkout__:<canonicalPath>`) — a display-only group that the
 *    host does not know; every workspace-scoped mutation on it would fail, so
 *    the row owns no kebab/rename/delete-of-workspace;
 *  - the SOURCE workspace (`familyMainId`) — the repository's main checkout, the
 *    only host workspace the row's sessions belong to and the only legal target
 *    for their wire commits (session drags match on it).
 */
import type { ChamberServerWorkspace } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { canonicalPathKey } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { checkoutOrderKey, orderCheckoutRows } from '@dsh-chamber/dsh-chamber-client-core/checkout-placement'
import {
  getSourceRepoLayouts, getWorkspaceGitFlag,
  type RepoGitLayout, type UnregisteredWorktreeInfo, type WorkspaceGitFlag,
} from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import type { SidebarKey } from './locales.ts'

/** Minimal structural row shape the helpers accept (tests pass literals). */
type CheckoutRowShape = Pick<ChamberServerWorkspace, 'id' | 'kind'> & Partial<Pick<
  ChamberServerWorkspace, 'path' | 'repoKey' | 'familyMainId' | 'synthetic' | 'ungrouped' | 'allSessionIds'
>>

/** True for a row the App derive synthesized from a repo layout (never a host workspace). */
export function isCheckoutRow(workspace: Pick<ChamberServerWorkspace, 'kind'>): boolean {
  return workspace.kind === 'checkout'
}

/**
 * True for a row the HOST knows: a draggable/droppable member of the workspace
 * order. Checkout rows are display-only groups (their id would 404 on every
 * wire call) and the ungrouped/synthetic buckets are not draggable by rule, so
 * every workspace-drag surface filters with THIS predicate — one definition, no
 * second list that could drift.
 */
export function isRealWorkspaceRow(workspace: CheckoutRowShape): boolean {
  return workspace.ungrouped !== true && workspace.synthetic !== true && !isCheckoutRow(workspace)
}

/** The checkout's canonical path — the placement/drag/order key. */
export function checkoutPathOf(workspace: CheckoutRowShape): string | undefined {
  if (!isCheckoutRow(workspace)) return undefined
  return workspace.path === undefined || workspace.path === '' ? undefined : workspace.path
}

/** The source workspace's id (the repo's MAIN checkout) a checkout row hangs under. */
export function checkoutFamilyMainOf(workspace: CheckoutRowShape): string | undefined {
  if (!isCheckoutRow(workspace)) return undefined
  return workspace.familyMainId === undefined || workspace.familyMainId === '' ? undefined : workspace.familyMainId
}

/**
 * The synthesized git flag of a checkout row. The flags store publishes flags
 * for REAL workspaces only (`retainSourceWorkspaceFlags` prunes every other
 * key), so the derived row carries its identity itself: the family main and the
 * repoKey are enough for the fold predicate, the tree anchor and the accent
 * family. Reading it through {@link workspaceFlagOf} keeps every caller on ONE
 * lookup that cannot see a half-populated flag store.
 */
export function derivedCheckoutFlag(workspace: CheckoutRowShape): WorkspaceGitFlag | undefined {
  if (!isCheckoutRow(workspace)) return undefined
  const mainWorkspaceId = checkoutFamilyMainOf(workspace)
  if (mainWorkspaceId === undefined) return undefined
  return {
    isWorktree: true,
    isMain: false,
    mainWorkspaceId,
    ...(workspace.repoKey === undefined ? {} : { repoKey: workspace.repoKey }),
  }
}

/** The git flag of one rendered row: the store's flag, else the derived row's own. */
export function workspaceFlagOf(sourceId: string, workspace: CheckoutRowShape): WorkspaceGitFlag | undefined {
  return getWorkspaceGitFlag(sourceId, workspace.id) ?? derivedCheckoutFlag(workspace)
}

/** One repository's unregistered worktrees for a source ([] when git facts are not published yet). */
export function checkoutLayoutEntries(sourceId: string, layouts?: readonly RepoGitLayout[]): readonly UnregisteredWorktreeInfo[] {
  return (layouts ?? getSourceRepoLayouts(sourceId)).flatMap(layout => layout.unregistered)
}

/** The layout entry a checkout row was derived from (canonical-path identity). */
export function checkoutLayoutEntry(
  sourceId: string,
  path: string | undefined,
  layouts?: readonly RepoGitLayout[],
): UnregisteredWorktreeInfo | undefined {
  if (path === undefined) return undefined
  const key = canonicalPathKey(path)
  return checkoutLayoutEntries(sourceId, layouts).find(entry => canonicalPathKey(entry.path) === key)
}

/**
 * Row health, fail-closed: the layout entry's own status when the facts are
 * present, `unknown` when they are not (snapshot failure / cold facts). A row
 * must never claim `ready` from absent facts.
 */
export type CheckoutHealth = 'ready' | 'missing' | 'invalid' | 'not-a-repo' | 'unknown'

export function checkoutHealthOf(
  sourceId: string,
  workspace: CheckoutRowShape,
  layouts?: readonly RepoGitLayout[],
): CheckoutHealth {
  const entry = checkoutLayoutEntry(sourceId, checkoutPathOf(workspace), layouts)
  if (entry === undefined) return 'unknown'
  return entry.status
}

/** Localized row-health hint; `ready` carries no copy (the row title already says it). */
export function checkoutHealthLabelKey(health: CheckoutHealth): SidebarKey | undefined {
  if (health === 'ready') return undefined
  if (health === 'missing') return 'checkout.missing'
  if (health === 'invalid') return 'checkout.invalid'
  if (health === 'not-a-repo') return 'checkout.notARepo'
  return 'checkout.statusUnknown'
}

/** Branch label of a checkout row (detached/unborn → the derived title stands). */
export function checkoutBranchOf(
  sourceId: string,
  workspace: CheckoutRowShape,
  layouts?: readonly RepoGitLayout[],
): string | undefined {
  const entry = checkoutLayoutEntry(sourceId, checkoutPathOf(workspace), layouts)
  const branch = entry?.branch ?? undefined
  return branch === undefined || branch === '' ? undefined : branch
}

/** Health/lock facts of one checkout row as the row + the Git occupant read them. */
export interface CheckoutRowFacts {
  /** Canonical checkout path (row identity for order/actions). */
  path: string | undefined
  /** Branch (or the derived title when the branch is unknown/detached). */
  branch: string
  /** Derived display title (the row's own title). */
  title: string
  /** Localized health hint key; undefined = healthy (or no facts claimed yet). */
  healthKey: SidebarKey | undefined
}

export function checkoutRowFacts(
  sourceId: string,
  workspace: CheckoutRowShape,
  title: string,
  layouts?: readonly RepoGitLayout[],
): CheckoutRowFacts {
  const path = checkoutPathOf(workspace)
  return {
    path,
    branch: checkoutBranchOf(sourceId, workspace, layouts) ?? title,
    title,
    healthKey: checkoutHealthLabelKey(checkoutHealthOf(sourceId, workspace, layouts)),
  }
}

/**
 * Apply the persisted per-family checkout sub-order to a family's checkout
 * rows. `checkoutOrder` values are canonical paths; unknown rows keep their
 * derived order after the stored ones (`orderCheckoutRows` reconciles).
 */
export function applyCheckoutOrder(
  sourceId: string,
  rows: readonly ChamberServerWorkspace[],
  mainPath: string,
  stored: Readonly<Record<string, string[]>> | undefined,
): ChamberServerWorkspace[] {
  if (stored === undefined) return [...rows]
  const order = stored[checkoutOrderKey(sourceId, mainPath)]
  if (order === undefined || order.length === 0) return [...rows]
  return orderCheckoutRows(rows, order)
}

/**
 * Rebuild one source's display order with its checkout rows re-anchored to
 * their family's main row. The workspace-family drag override (`orderWithOverride`)
 * PREPENDS every id it does not know — right for a host-created workspace
 * (the host prepends too), wrong for a derived checkout row, which belongs to
 * its family block and must never float above it. The derive places checkout
 * rows right after their main; this function reproduces that placement after
 * the override has been applied to the REAL rows only.
 */
export function insertCheckoutRows(
  sourceId: string,
  orderedRealRows: readonly ChamberServerWorkspace[],
  checkoutRows: readonly ChamberServerWorkspace[],
  stored: Readonly<Record<string, string[]>> | undefined,
): ChamberServerWorkspace[] {
  if (checkoutRows.length === 0) return [...orderedRealRows]
  const byMain = new Map<string, ChamberServerWorkspace[]>()
  for (const row of checkoutRows) {
    const mainId = checkoutFamilyMainOf(row)
    if (mainId === undefined) continue
    const group = byMain.get(mainId)
    if (group === undefined) byMain.set(mainId, [row])
    else group.push(row)
  }
  const output = [...orderedRealRows]
  const orphans: ChamberServerWorkspace[] = []
  for (const [mainId, rows] of byMain) {
    const main = orderedRealRows.find(row => row.id === mainId)
    if (main === undefined) {
      // A family whose main row vanished mid-frame: keep the rows reachable at
      // the tail for one frame instead of dropping the sessions they hold (no
      // order key exists without a main path, so the derived order stands).
      orphans.push(...rows)
      continue
    }
    const ordered = main.path === undefined ? [...rows] : applyCheckoutOrder(sourceId, rows, main.path, stored)
    const at = output.indexOf(main)
    output.splice(at + 1, 0, ...ordered)
  }
  return [...output, ...orphans]
}

/**
 * One session-drag anchor space: the SOURCE workspace's full member order
 * (placement happens later, in the derive, so the rendered row only holds the
 * placed subset). Absent `allSessionIds` (no checkout rows for that family) =
 * the row's own members are the full order.
 */
export function sessionFullOrder(workspace: ChamberServerWorkspace): string[] {
  if (workspace.allSessionIds !== undefined) return [...workspace.allSessionIds]
  return workspace.sessions.map(session => session.id)
}
