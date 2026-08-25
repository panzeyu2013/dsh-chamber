/**
 * Pure render-gate logic for the OpenInButton (design 16 §6.3): the three
 * gates and the launch instance-id derivation, extracted from the component
 * (which imports React, CSS and a raster mark — untestable under plain node).
 * Everything here is a pure function over plain data, so the node test suite
 * (`test/open-in-gates.ts`) covers the button's decision surface without a
 * DOM: which apps a source may use, whether a header's session maps to a
 * concrete workspace path, and the view-id → raw-registry-id strip.
 */
import type { OpenInApp } from '../shared/coordinator.ts'

/**
 * Gate 1 — which apps THIS source may actually use, fail-closed:
 * - LOCAL (`'local'`) sources get every available app (Finder + VS Code);
 * - REMOTE (`'ssh-<id>'`) sources get only remote-capable apps (VS Code);
 * - GATEWAY (`'gateway-<id>'`) and unknown sources get NOTHING. A gateway
 *   instance has no vscode-remote semantics, and the main-process launch
 *   keys on the RAW registry id (only the `'ssh-'` prefix is stripped in
 *   `rawInstanceIdForLaunch`), so any gateway button would be a
 *   guaranteed-fail dead button (frontend-review P2 fix: the old
 *   `sourceId === 'local' ? all : remoteCapable-only` branch treated every
 *   non-local source as ssh and rendered a button whose click always failed).
 * The bridge's `available` flag is honored as a hard filter.
 */
export function usableAppsForSource(sourceId: string, apps: ReadonlyArray<OpenInApp>): OpenInApp[] {
  const availableApps = apps.filter(app => app.available)
  // Non-string source ids (defensive: the slot face is loose) are unknown →
  // fail-closed like gateway/unknown strings. Production never passes one
  // (the client entry bails on an absent chamberInstanceId), so this is pure
  // input hardening — no behavior change for reachable inputs.
  if (typeof sourceId !== 'string') return []
  if (sourceId === 'local') return availableApps
  if (sourceId.startsWith('ssh-')) return availableApps.filter(app => app.remoteCapable)
  return []
}

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

/**
 * View id → raw registry id for the main-process launch: `'ssh-<id>'` strips
 * the prefix; `'local'` and everything else pass through as-is (the button
 * only ever renders for local/ssh sources after the gate-1 filter, so a
 * gateway id can never reach the launch path).
 */
export function rawInstanceIdForLaunch(sourceId: string): string {
  return sourceId.startsWith('ssh-') ? sourceId.slice(4) : sourceId
}
