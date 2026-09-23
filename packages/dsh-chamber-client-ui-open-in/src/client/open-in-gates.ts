/**
 * Pure render-gate logic for the OpenInButton (design 16 §6.3): the workspace
 * lookup for the header's session. Everything here is a pure function over
 * plain data — the component itself imports React, CSS and a raster mark,
 * untestable under plain node — so the node test suite
 * (test/launch-flow/open-in-view-model.test.ts) covers this decision surface
 * without a DOM: whether a header's session maps to a concrete workspace path.
 *
 * The per-source app matrix is NOT re-derived here: buildOpenInViewModel
 * (shared/open-in-view-model.ts) is the single decision surface, and the
 * strict parseOpenInSource (shared/capabilities.ts) is the single
 * view-id/transport parser — both called by the production component path.
 * This module keeps only the gate the pure view-model cannot answer (the
 * workspace rows come from the framework's useWorkspaces hook).
 */

/**
 * Gate 2 — the workspace path for a header's session, or undefined when the
 * session belongs to no workspace / the workspace carries no path (the
 * button renders null on either — never a click that can only fail).
 */
export function workspacePathForSession(
  workspaces: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: string[] }>,
  sessionId: string,
): string | undefined {
  const workspace = workspaces.find(item => item.sessionIds.includes(String(sessionId)))
  return workspace?.path
}
