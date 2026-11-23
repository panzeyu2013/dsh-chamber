/**
 * Pure render-gate logic for the OpenInButton: the directory lookup for the
 * header's session, pure over plain data so the node test suite covers it
 * without a DOM. The per-source app matrix is NOT re-derived here —
 * `buildOpenInViewModel` is the single decision surface and `parseOpenInSource`
 * the single view-id/transport parser.
 */

/** One session-list row as the framework `useSessions` selector publishes it
 *  (the structural subset the directory lookup needs; vendor SessionSummary). */
export interface OpenInSessionRow {
  /** Header directory the session was created in (upstream `cwd`). */
  cwd?: string | null
  /** Host-computed projection values (upstream store row `projectionValues`). */
  projectionValues?: Readonly<Record<string, unknown>>
}

/** The sessions-list snapshot subset the directory lookup reads. */
export interface OpenInSessionsState {
  byId?: Readonly<Record<string, OpenInSessionRow>>
  /** Shared projection values, including unopened Sessions. */
  projectionsBySession?: Readonly<Record<string, { values?: Readonly<Record<string, unknown>> }>>
}

function projectedString(
  values: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  if (values === undefined) return undefined
  const value = values[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Gate 2 — the directory one session WORKS IN, as the Client knows it: the
 * upstream `selectSessionDirectory` port (dsh-api-session-controller
 * client/sessions/directories -> `projectedString('workingDirectory')` from the
 * shared projection bag, then the store row's own projection bag, then the
 * header `cwd`). The projected `workingDirectory` is the effective checkout —
 * a session moved into a worktree opens the worktree, not the workspace root.
 */
export function selectSessionDirectory(
  state: OpenInSessionsState,
  sessionId: string,
): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const cwd = state.byId?.[sessionId]?.cwd
  return projectedString(state.projectionsBySession?.[sessionId]?.values, 'workingDirectory')
    ?? projectedString(state.byId?.[sessionId]?.projectionValues, 'workingDirectory')
    ?? (typeof cwd === 'string' ? cwd : undefined)
}

/**
 * Gate 2 — the workspace path for a header's session, or undefined when it
 * belongs to none or the workspace carries no path (the button renders null).
 */
export function workspacePathForSession(
  workspaces: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: string[] }>,
  sessionId: string,
): string | undefined {
  const workspace = workspaces.find(item => item.sessionIds.includes(String(sessionId)))
  return workspace?.path
}

/**
 * Gate 2 for BOTH seats — the Files tab's owner path wins when the slot handed
 * one over (rc.2 `sidebar.right.tab.files.actions` owner `{ absolutePath }`;
 * the file tree's displayed root IS the directory the button opens). The header
 * seat then opens the session's CURRENT directory projection
 * ({@link selectSessionDirectory}: the checkout when the session works in one),
 * and falls back to the session's workspace root when no directory is projected
 * (cold/unmounted list) so the old behavior survives a not-yet-ready projection.
 * Owner/session paths are TRIMMED before use and whitespace-only values fall
 * back: a padded path would otherwise render a button whose launch can only fail.
 */
export function resolveOpenInPath(
  absolutePath: string | undefined,
  workspaces: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: string[] }>,
  sessionId: string | undefined,
  sessionDirectory?: string,
): string | undefined {
  if (typeof absolutePath === 'string') {
    const owner = absolutePath.trim()
    if (owner !== '') return owner
  }
  const directory = typeof sessionDirectory === 'string' ? sessionDirectory.trim() : ''
  if (directory !== '') return directory
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return workspacePathForSession(workspaces, sessionId)
}
