/**
 * shell-ipc-plugins-gateway — domain IPC registrations: the manual chamber
 * host-package seed-cache sync fallback (`desktop_gateway_plugin_sync`). There is no
 * gateway plugin write bridge (apply/materialize/undo); seeding is chamber
 * provisioning, not a
 * plugin-model write (design 21 §6.11), so the sync handler stays.
 *
 * The parameters are read from the ACTIVE registration (the commit entry's record):
 * the renderer supplies only the instance id, so a manual sync can never dial a
 * renderer-chosen URL/credential. No committed record → loud {ok:false}.
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import { INSTANCE_ID_PATTERN } from './transport-manager.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { describeUnknownError } from './deep-link.ts'
import { committedRecordGen, committedRegistrationForSync } from './active-registration.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export function registerGatewayPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps } = ctx
  const { transportManager: sm, syncGatewayChamberPluginsFor } = ctx.deps.ctx
  // Manual chamber-plugin sync (design 21 §6.5): re-runs the seed-cache sync over the
  // ACTIVE registration's committed transport origin/headers/SPKI pin/authority/UDS
  // socket — never a renderer-supplied URL or credential, and never the pre-refresh
  // snapshot (the registry record is the one truth a session refresh updates).
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_SYNC, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    // currentRecordGen → the record at that generation: a record replaced between
    // the two reads is refused instead of dialing stale parameters.
    const recordGen = committedRecordGen(id);
    const registration = recordGen === undefined ? undefined : committedRegistrationForSync(id, recordGen);
    if (registration === undefined) return { ok: false as const, error: 'no active gateway registration' };
    // Live-state re-check: the record is revoked when the transport leaves ready, but a
    // manual sync can still race a disconnect after the hit — a stale-ready dead
    // transport must never read as a completed sync.
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    try {
      // The execution closure re-reads the committed record and re-checks its
      // generation right before the upload (a re-bound target fails loud there).
      const result = await syncGatewayChamberPluginsFor(
        id,
        registration.facts.url,
        registration.facts.headers ?? {},
        registration.facts.spkiPin ?? null,
      );
      if (result === null) return { ok: false as const, error: 'no active gateway registration' };
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
