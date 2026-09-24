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
