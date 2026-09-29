/**
 * Pure render-gate logic for the OpenInButton: the workspace lookup for the
 * header’s session, pure over plain data so the node test suite covers it
 * without a DOM. The per-source app matrix is NOT re-derived here —
 * `buildOpenInViewModel` is the single decision surface and `parseOpenInSource`
 * the single view-id/transport parser.
 */

/**
 * Gate 2 — the workspace path for a header’s session, or undefined when it
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
 * the file tree's displayed root IS the directory the button opens), otherwise
 * the header seat resolves its own session's workspace. The owner path is
 * TRIMMED before use and whitespace-only values fall back: a padded owner path
 * would otherwise render a button whose launch can only fail.
 */
export function resolveOpenInPath(
  absolutePath: string | undefined,
  workspaces: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: string[] }>,
  sessionId: string | undefined,
): string | undefined {
  if (typeof absolutePath === 'string') {
    const owner = absolutePath.trim()
    if (owner !== '') return owner
  }
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  return workspacePathForSession(workspaces, sessionId)
}
