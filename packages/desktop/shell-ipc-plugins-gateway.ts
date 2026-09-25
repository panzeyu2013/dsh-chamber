/**
 * shell-ipc-plugins-gateway — domain IPC registrations: the manual chamber
 * host-package seed-cache sync fallback (`desktop_gateway_plugin_sync`). The
 * gateway plugin WRITE bridge (apply/materialize/undo) was retired with the
 * 2026-09 C layering ruling; seeding is chamber provisioning, not a
 * plugin-model write (design 21 §6.11), so the sync handler stays.
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import { INSTANCE_ID_PATTERN } from './transport-manager.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { describeUnknownError } from './deep-link.ts'
import { getGatewaySyncRegistration } from './gateway-sync-registry.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export function registerGatewayPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps } = ctx
  const { transportManager: sm, syncGatewayChamberPluginsFor } = ctx.deps.ctx
  // Manual chamber-plugin sync (design 21 §6.5): re-runs the seed-cache sync
  // over the REGISTERED transport origin/headers/SPKI pin — never a
  // renderer-supplied URL or credential. No ready registration → loud
  // {ok:false}; null from the awaited auto-sync path → instance vanished.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_SYNC, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const reg = getGatewaySyncRegistration(id);
    if (reg === undefined) return { ok: false as const, error: 'no active gateway registration' };
    // Live-state re-check: the registry entry is cleared when the transport
    // leaves ready, but a manual sync can still race a disconnect after the
    // hit — a stale-ready dead transport must never read as a completed sync.
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    try {
      const result = await syncGatewayChamberPluginsFor(id, reg.url, reg.headers, reg.spkiPin);
      if (result === null) return { ok: false as const, error: 'gateway instance not found' };
      // A sync that failed on the wire is {ok:false}: the both-false tuple
      // must never masquerade as the "already up to date" answer.
      if (result.failed === true) {
        return { ok: false as const, error: result.error ?? 'gateway plugin sync failed' };
      }
      return { ok: true as const, uploaded: result.uploaded, skipped: result.skipped };
    } catch (error) {
      return { ok: false as const, error: `gateway plugin sync failed: ${sanitizeErrorText(describeUnknownError(error))}` };
    }
  });
}
