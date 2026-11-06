/**
 * Checkout-row placement — the pure leaf behind design 08 PR2's derived
 * `kind:'checkout'` rows (final design 08 §3.2-§3.3/§5.2).
 *
 * A Git checkout (unregistered worktree) is NOT a dsh workspace: the host
 * projects every session under its SOURCE main workspace's membership, and the
 * sidebar row is synthesized here from the Git repo layout. This leaf owns the
 * three pieces that must agree byte-for-byte across producers and consumers:
 * - the row identity / checkoutOrder key spelling (`__checkout__:` family);
 * - the path-segment longest-prefix placement rule
 *   (`workingDirectory ?? cwd`, path boundaries, never a string prefix);
 * - the row skeleton (title/kind/repoKey/familyMainId/path, no `synthetic`).
 *
 * WHY it is a leaf: derive.ts consumes it for the sidebar projection, view-prefs
 * consumes only the key helpers, and the sidebar drag code may consume
 * {@link orderCheckoutRows}. It must stay free of derive/store imports so no
 * module cycle (placement) can form.
 *
 * Ledger (final design 08 §3.2-§3.3): a checkout row exists only while its MAIN
 * checkout is a registered workspace row; a checkout whose path is itself a
 * registered workspace stays that workspace row (no duplicate row, no session
 * move); placement only moves sessions that are host members of that main.
 */
import { basenameOf } from './session-display.ts'
import type { SessionRow, WorkspaceRow } from './instance-snapshot-rows.ts'
import type { RepoGitLayout, UnregisteredWorktreeInfo } from './workspace-git-flags.ts'
import type { ChamberServerWorkspace } from './aggregate-types.ts'

/**
 * Prefix of BOTH a derived checkout row id (`__checkout__:<canonicalPath>`) and
 * a checkoutOrder key (`__checkout__:<sourceId>/<canonicalMainPath>`). Same
 * family as the unary fallback's `__cwd__:` ids: display-only, never a host id.
 */
export const CHECKOUT_ID_PREFIX = '__checkout__:'

/**
 * Canonical COMPARISON key of a checkout path: trailing separators stripped —
 * the SAME rule as derive's `canonicalPathKey` (kept local so this leaf does
 * not import derive). Paths cross the wire host-canonical; the client only
 * normalizes the spelling it compares, never re-realpaths.
 */
export function checkoutPathKey(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

/**
 * Path segments used for the boundary match (separators normalized, empty
 * segments dropped). Segment-array comparison is what makes `/a/bc` NOT a
 * child of `/a/b` — a plain startsWith would place it there.
 */
function pathSegments(path: string): string[] {
  return checkoutPathKey(path).replaceAll('\\', '/').split('/').filter(segment => segment !== '')
}

/**
 * True when `path` is `ancestor` itself or one of its descendants on a path
 * segment boundary. Shared by checkout placement (row derivation) and the
 * checkout-archive plan so the two never disagree about what "inside" means.
 * Paths are host-canonical; only the spelling is normalized here.
 */
export function pathIsWithin(path: string | undefined, ancestor: string): boolean {
  if (path === undefined || path === '') return false
  const pathParts = pathSegments(path)
  const ancestorParts = pathSegments(ancestor)
  if (ancestorParts.length === 0 || pathParts.length < ancestorParts.length) return false
  for (let index = 0; index < ancestorParts.length; index += 1) {
    if (pathParts[index] !== ancestorParts[index]) return false
  }
  return true
}

/** Stable derived row id of one checkout path. */
export function checkoutRowId(path: string): string {
  return `${CHECKOUT_ID_PREFIX}${checkoutPathKey(path)}`
}

/**
 * checkoutOrder key for one repo family (view-prefs): the source id plus the
 * MAIN checkout's canonical path. The main path itself may begin with '/', so
 * the joined spelling can contain '//' — always parse with
 * {@link parseCheckoutOrderKey}, never by splitting on '/' naively.
 */
export function checkoutOrderKey(sourceId: string, mainPath: string): string {
  return `${CHECKOUT_ID_PREFIX}${sourceId}/${checkoutPathKey(mainPath)}`
}

/** Inverse of {@link checkoutOrderKey}; undefined for any other key shape. */
export function parseCheckoutOrderKey(key: string): { sourceId: string; mainPath: string } | undefined {
  if (!key.startsWith(CHECKOUT_ID_PREFIX)) return undefined
  const rest = key.slice(CHECKOUT_ID_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  const sourceId = rest.slice(0, slash)
  const mainPath = rest.slice(slash + 1)
  if (sourceId === '' || mainPath === '') return undefined
  return { sourceId, mainPath }
}

/** One derived checkout row's placement facts (before its sessions are rendered). */
export interface CheckoutPlacement {
  /** The family's MAIN checkout workspace id. */
  mainWorkspaceId: string
  /** Repository opaque identity (layout repoKey). */
  repoKey: string
  /** Row title: the branch when attached, the directory name otherwise. */
  title: string
  /** The host-canonical checkout path exactly as the layout published it. */
  path: string
  /** Canonical comparison key (`checkoutPathKey(path)`). */
  pathKey: string
  /** The layout's worktree facts (branch/status/dirty/locked...); display reads them, the aggregate signature does not. */
  worktree: UnregisteredWorktreeInfo
  /**
   * Placed session ids, in the MAIN workspace's host membership order (a
   * subsequence of `workspace.sessionIds`, placement never reorders).
   */
  sessionIds: string[]
}

export interface CheckoutPlacementResult {
  /** Derived rows per MAIN workspace id; families without rows are absent. */
  rowsByMainWorkspaceId: Map<string, CheckoutPlacement[]>
  /** Every session moved out of its source row into a checkout row. */
  placedSessionIds: Set<string>
}

export interface CheckoutPlacementInput {
  /**
   * The snapshot's workspace rows (host membership + paths). Synthetic
   * cwd-derived groups (`__cwd__:`) can never be a family main: the layout
   * names a REGISTERED main checkout, so a synthetic match degrades to no row.
   */
  workspaces: readonly Pick<WorkspaceRow, 'workspaceId' | 'path' | 'sessionIds' | 'synthetic'>[]
  /** The snapshot's session rows (effective-directory facts). */
  sessions: readonly Pick<SessionRow, 'sessionId' | 'cwd' | 'workingDirectory' | 'origin'>[]
  /** The source's published Git repo layouts (workspace-git-flags). */
  layouts: readonly RepoGitLayout[]
}

/** Longest path-segment prefix match across one family's checkouts. */
function longestPrefixMatch(
  candidates: readonly { readonly placement: CheckoutPlacement; readonly segments: readonly string[] }[],
  effectiveSegments: readonly string[],
): CheckoutPlacement | undefined {
  let best: CheckoutPlacement | undefined
  let bestLength = -1
  for (const candidate of candidates) {
    const segments = candidate.segments
    // Empty-segment paths (a filesystem root) never make a checkout row.
    if (segments.length === 0 || segments.length > effectiveSegments.length || segments.length <= bestLength) continue
    let matches = true
    for (let index = 0; index < segments.length; index += 1) {
      if (segments[index] !== effectiveSegments[index]) {
        matches = false
        break
      }
    }
    if (!matches) continue
    best = candidate.placement
    bestLength = segments.length
  }
  return best
}

/**
 * Plan every checkout row and every placement for one source snapshot.
 *
 * PURE and order-preserving: rows keep the layout's worktree order; placed
 * sessions keep the MAIN workspace's host membership order. The result is
 * deliberately a plan (no rendered rows, no visibility decisions) so
 * derive.ts owns the one session-row builder.
 */
export function planCheckoutPlacements(input: CheckoutPlacementInput): CheckoutPlacementResult {
  const rowsByMainWorkspaceId = new Map<string, CheckoutPlacement[]>()
  const placedSessionIds = new Set<string>()
  if (input.layouts.length === 0) return { rowsByMainWorkspaceId, placedSessionIds }

  const workspaceById = new Map(input.workspaces.map(workspace => [workspace.workspaceId, workspace]))
  const sessionById = new Map(input.sessions.map(session => [session.sessionId, session]))
  // A checkout path that is ALREADY a registered workspace must stay that
  // workspace row: no second row and no cross-row session move (design 08 I3).
  const registeredPaths = new Set(input.workspaces.map(workspace => checkoutPathKey(workspace.path)))
  const issuedPaths = new Set<string>()

  for (const layout of input.layouts) {
    const mainWorkspaceId = layout.mainWorkspaceId
    // An unregistered main checkout has no row (and therefore no family rows):
    // sessions cannot be rooted in it (design 08 I9).
    if (mainWorkspaceId === null) continue
    const main = workspaceById.get(mainWorkspaceId)
    if (main === undefined || main.synthetic === true) continue
    const rows: CheckoutPlacement[] = []
    for (const worktree of layout.unregistered) {
      const pathKey = checkoutPathKey(worktree.path)
      if (pathKey === '' || pathSegments(worktree.path).length === 0) continue
      if (registeredPaths.has(pathKey) || issuedPaths.has(pathKey)) continue
      issuedPaths.add(pathKey)
      rows.push({
        mainWorkspaceId,
        repoKey: layout.repoKey,
        title: worktree.branch ?? (worktree.name !== '' ? worktree.name : basenameOf(worktree.path)),
        path: worktree.path,
        pathKey,
        worktree,
        sessionIds: [],
      })
    }
    if (rows.length === 0) continue

    const candidates = rows.flatMap(placement => {
      const segments = pathSegments(placement.path)
      return segments.length === 0 ? [] : [{ placement, segments }]
    })
    // "accounted uses host membership": only sessions the host lists under the
    // MAIN workspace are candidates; strays stay in the ungrouped bucket and a
    // session registered under another workspace keeps that row.
    for (const sessionId of main.sessionIds) {
      const session = sessionById.get(sessionId)
      if (session === undefined || session.origin === 'subagent') continue
      const effective = session.workingDirectory ?? session.cwd
      if (effective === undefined || effective === '') continue
      const match = longestPrefixMatch(candidates, pathSegments(effective))
      if (match === undefined) continue
      match.sessionIds.push(sessionId)
      placedSessionIds.add(sessionId)
    }
    rowsByMainWorkspaceId.set(mainWorkspaceId, rows)
  }
  return { rowsByMainWorkspaceId, placedSessionIds }
}

/**
 * The derived checkout row skeleton. Checkout rows intentionally carry NO
 * `synthetic`/`ungrouped` marker, no `createdAt` (the layout has no creation
 * fact) and no `reusableBlankSessionId` ("+" belongs to the main row).
 * `sessionRowOf` returns undefined for a session the derive's visibility gate
 * hid, so the ONE session-row rule stays in derive.ts.
 */
export function checkoutWorkspaceOf(
  placement: CheckoutPlacement,
  sessionRowOf: (sessionId: string) => ChamberServerWorkspace['sessions'][number] | undefined,
): ChamberServerWorkspace {
  return {
    id: checkoutRowId(placement.path),
    title: placement.title,
    path: placement.path,
    kind: 'checkout',
    repoKey: placement.repoKey,
    familyMainId: placement.mainWorkspaceId,
    sessions: placement.sessionIds.flatMap(sessionId => {
      const row = sessionRowOf(sessionId)
      return row === undefined ? [] : [row]
    }),
  }
}

/**
 * Apply the stored checkout sub-order (view-prefs `checkoutOrder`) to one
 * family's rows: stored canonical paths first (unknown paths skipped), then the
 * remaining rows in derived/layout order — the same reconcile rule as the
 * ungrouped / updated session accounts. PURE; always returns a fresh array, so
 * a caller may mutate/splice it. Rows whose `path` is absent cannot carry an
 * order fact and trail in their derived position.
 */
export function orderCheckoutRows<T extends { readonly path?: string }>(
  rows: readonly T[],
  stored: readonly string[] | undefined,
): T[] {
  if (stored === undefined || stored.length === 0) return [...rows]
  const byKey = new Map<string, T>()
  for (const row of rows) {
    if (row.path === undefined || row.path === '') continue
    byKey.set(checkoutPathKey(row.path), row)
  }
  const seen = new Set<string>()
  const ordered: T[] = []
  for (const path of stored) {
    const key = checkoutPathKey(path)
    const row = byKey.get(key)
    if (row === undefined || seen.has(key)) continue
    seen.add(key)
    ordered.push(row)
  }
  if (ordered.length === 0) return [...rows]
  for (const row of rows) {
    const key = row.path === undefined || row.path === '' ? undefined : checkoutPathKey(row.path)
    if (key === undefined || !seen.has(key)) ordered.push(row)
  }
  return ordered
}
