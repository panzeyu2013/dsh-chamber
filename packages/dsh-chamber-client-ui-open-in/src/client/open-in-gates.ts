/**
 * Pure render-gate logic for the OpenInButton (design 16 §6.3): the three
 * gates and the launch instance-id derivation, extracted from the component
 * (which imports React, CSS and a raster mark — untestable under plain node).
 * Everything here is a pure function over plain data, so the node test suite
 * (`test/open-in-gates.ts`) covers the button's decision surface without a
 * DOM: which apps a source may use, whether a header's session maps to a
 * concrete workspace path, and the view-id → raw-registry-id strip.
 */
import type { OpenInApp, OpenInSource } from '../shared/coordinator.ts'
import { buildOpenInViewModel } from '../shared/open-in-view-model.ts'

/**
 * Gate 1 — which apps THIS source may actually use, fail-closed:
 * - LOCAL (`'local'`) sources get every available app (Finder + VS Code);
 * - either canonical target kind (`'dsh-<id>'` / `'gateway-<id>'`) over SSH,
 *   plus the legacy `'ssh-<id>'` input alias, gets remote-capable apps only;
 * - either target over HTTP and unknown/malformed sources get NOTHING because
 *   vscode-remote is a transport capability, not a target-kind capability.
 * The bridge's `available` flag is honored as a hard filter.
 *
 * Since Batch 3 Phase 0 this is a thin adapter over the shared per-source
 * view-model (`shared/open-in-view-model.ts`) — the single decision surface
 * the unified open-in entry consumes; the returned apps are the input objects
 * in view-model order.
 *
 * The `channel` field survives on the view-model entry because it still decides
 * the LAUNCH carrier (instance RPC vs trusted IPC); it no longer decides the
 * mark (`markKindFor`).
 */
export function usableAppsForSource(
  sourceId: string,
  apps: ReadonlyArray<OpenInApp>,
  transport: 'local' | 'ssh' | 'http',
): OpenInApp[] {
  // Non-string source ids (defensive: the slot face is loose) are unknown →
  // fail-closed like gateway/unknown strings. Production never passes one
  // (the client entry bails on an absent chamberInstanceId), so this is pure
  // input hardening — no behavior change for reachable inputs.
  if (typeof sourceId !== 'string') return []
  const source = sourceFromLooseFacts(sourceId, transport)
  const model = buildOpenInViewModel({ source, localEntries: null, mainEntries: apps })
  const byId = new Map(apps.map(app => [app.id, app]))
  return model.entries
    .map(entry => byId.get(entry.id))
    .filter((app): app is OpenInApp => app !== undefined)
}

/** Adapt the loose (sourceId, transport) gate inputs to the strict view-model
 *  source shape. Malformed ids stay malformed — the view-model classifies them
 *  as `unsupported`, which is exactly this gate's fail-closed outcome. */
function sourceFromLooseFacts(sourceId: string, transport: 'local' | 'ssh' | 'http'): OpenInSource {
  if (sourceId === 'local') {
    return { sourceId: 'local', instanceId: 'local', local: true, transport }
  }
  const prefix = ['dsh-', 'gateway-', 'ssh-'].find(candidate => sourceId.startsWith(candidate))
  return {
    sourceId,
    instanceId: prefix === undefined ? sourceId : sourceId.slice(prefix.length),
    local: false,
    transport,
  }
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

/** Which mark the header entry renders for one view-model entry. */
export type OpenInMarkKind = 'catalog-icon' | 'vscode' | 'generic'

/**
 * Mark selection (design 20 §5): the host-served catalog icon wins whenever the
 * instance answered one — for EVERY channel, exactly as upstream draws whatever
 * icon its host serves (`OpenInAppAction.tsx` `AppIcon`). A main-channel entry
 * is no exception: the id is the same application the local catalog resolves, so
 * its real bundle art is strictly better than the bundled raster and keeps the
 * mark pipeline upstream's. The launch channel still decides the CARRIER, never
 * the mark. Only when the host serves no icon does the chamber fallback apply —
 * the VS Code product raster for that family (the remote-SSH case, where there
 * is no instance catalog at all, and the rare extraction failure), and
 * upstream's own rounded square for everything else.
 * @param entry - the view-model entry (only its `displayKind` reaches the mark).
 * @param hasCatalogIcon - whether the boot icon cache holds a host icon for the id.
 * @returns which of the three mark renderers to use.
 */
export function markKindFor(
  entry: { readonly displayKind: string },
  hasCatalogIcon: boolean,
): OpenInMarkKind {
  if (hasCatalogIcon) return 'catalog-icon'
  if (entry.displayKind === 'vscode') return 'vscode'
  return 'generic'
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
