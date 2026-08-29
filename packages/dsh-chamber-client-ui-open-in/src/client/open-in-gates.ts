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
 * - either canonical target kind (`'dsh-<id>'` / `'gateway-<id>'`) over SSH,
 *   plus the legacy `'ssh-<id>'` input alias, gets remote-capable apps only;
 * - either target over HTTP and unknown/malformed sources get NOTHING because
 *   vscode-remote is a transport capability, not a target-kind capability.
 * The bridge's `available` flag is honored as a hard filter.
 */
export function usableAppsForSource(
  sourceId: string,
  apps: ReadonlyArray<OpenInApp>,
  transport: 'local' | 'ssh' | 'http',
): OpenInApp[] {
  const availableApps = apps.filter(app => app.available)
  // Non-string source ids (defensive: the slot face is loose) are unknown →
  // fail-closed like gateway/unknown strings. Production never passes one
  // (the client entry bails on an absent chamberInstanceId), so this is pure
  // input hardening — no behavior change for reachable inputs.
  if (typeof sourceId !== 'string') return []
  if (sourceId === 'local') return transport === 'local' ? availableApps : []
  if (transport !== 'ssh') return []
  const prefix = ['dsh-', 'gateway-', 'ssh-'].find(candidate => sourceId.startsWith(candidate))
  if (prefix !== undefined && /^(?!local$)[A-Za-z0-9_-]{1,64}$/.test(sourceId.slice(prefix.length))) {
    return availableApps.filter(app => app.remoteCapable)
  }
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
 * View id → raw registry id for the main-process launch: canonical dsh/
 * gateway prefixes and the legacy ssh prefix are all presentation identity;
 * the privileged main process receives the raw registry id plus the exact
 * boot-bound source proof.
 */
export function rawInstanceIdForLaunch(sourceId: string): string {
  for (const prefix of ['dsh-', 'gateway-', 'ssh-']) {
    if (sourceId.startsWith(prefix)) return sourceId.slice(prefix.length)
  }
  return sourceId
}
