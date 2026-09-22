/**
 * shell-ipc-plugins-gateway — domain IPC registrations
 */
import type { ShellIpcCtx } from './shell-core.ts'
import { INSTANCE_ID_PATTERN } from './transport-manager.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { buildApplyConfirmMessage, validateApplyPayload } from './gateway-ipc-shared.ts'
import { buildPluginTarball, classifyPluginPick } from './plugin-tarball.ts'
import { describeUnknownError } from './deep-link.ts'
import { gatewayChamberApplyBatch, gatewayChamberMaterialize } from './gateway-provider.ts'
import { gatewayTunnelAuthority } from './gateway-session-refresh.ts'
import { getGatewaySyncRegistration } from './gateway-sync-registry.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export function registerGatewayPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps, confirmPluginAction } = ctx
  const { transportManager: sm, syncGatewayChamberPluginsFor } = ctx.deps.ctx
  // Manual chamber-plugin sync onto a gateway instance (design 21 §6.5):
  // re-run the seed-cache sync the ready registration performs
  // automatically, over the REGISTERED transport origin/headers/SPKI pin —
  // never a renderer-supplied URL or credential. No ready registration →
  // loud {ok:false}; otherwise the awaited auto-sync path answers with the
  // same {uploaded, skipped} projection (or null → instance vanished).
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_SYNC, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const reg = getGatewaySyncRegistration(id);
    if (reg === undefined) return { ok: false as const, error: 'no active gateway registration' };
    // Live-state re-check (design 21 §6.5, honesty): the registry entry is
    // cleared when the transport leaves ready, but a manual sync can still
    // race a disconnect after the hit — a stale-ready dead transport must
    // never be swallowed as a completed sync ({uploaded:false, skipped:false}
    // would read as success). Same `sm.status(id)?.phase` access as the
    // sibling seed/registration code paths.
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    try {
      const result = await syncGatewayChamberPluginsFor(id, reg.url, reg.headers, reg.spkiPin);
      if (result === null) return { ok: false as const, error: 'gateway instance not found' };
      // Honesty (design 21): a sync that failed on the wire is
      // {ok:false} — the both-false tuple must never masquerade as the
      // "already up to date" answer.
      if (result.failed === true) {
        return { ok: false as const, error: result.error ?? 'gateway plugin sync failed' };
      }
      return { ok: true as const, uploaded: result.uploaded, skipped: result.skipped };
    } catch (error) {
      return { ok: false as const, error: `gateway plugin sync failed: ${sanitizeErrorText(describeUnknownError(error))}` };
    }
  });
  // Gateway batch plugin apply (design 21 §6.5): registry
  // add/remove over the REGISTERED transport origin/headers/SPKI pin —
  // never a renderer-supplied URL or credential. Main-process confirmation
  // (decision 14 桌面通道纪律): the batch modifies the gateway's managed
  // dsh profile — a persistent, globally-visible (multi-desktop)
  // execution-surface change, never a silent script action. Cancelled →
  // {ok:true, cancelled:true}; partial failures (an op refused mid-batch
  // or a restart refused after execution) carry the executed
  // installed/removed lists honestly.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_APPLY, async (payload: unknown) => {
    const { id, add, remove, deferRestart } = payload as { id: unknown; add: unknown; remove: unknown; deferRestart: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const validated = validateApplyPayload({ add, remove, deferRestart });
    if (!validated.ok) return { ok: false as const, error: validated.error };
    const reg = getGatewaySyncRegistration(id);
    if (reg === undefined) return { ok: false as const, error: 'no active gateway registration' };
    // Live-state re-check (design 21 §6.5, honesty) — same
    // `sm.status(id)?.phase` access as the sibling sync handler.
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    const instance = sm.listInstances().find(candidate => candidate.id === id);
    if (instance === undefined || instance.kind !== 'gateway') {
      return { ok: false as const, error: 'gateway instance not found' };
    }
    // Batch confirmation with the restart/multi-desktop copy (default
    // cancel — same convention as the local plugin actions).
    const confirm = await confirmPluginAction(buildApplyConfirmMessage({
      targetLabel: instance.label ?? null,
      targetId: id,
      add: validated.value.add,
      remove: validated.value.remove,
      deferRestart: validated.value.deferRestart,
    }));
    if ('cancelled' in confirm) return { ok: true as const, cancelled: true };
    if (!confirm.ok) return { ok: false as const, error: confirm.error };
    // Post-confirm re-check (design 21, mirroring the
    // materialize handler): the user may have kept the dialog open across
    // a disconnect/reconnect — the batch must execute on the CURRENT
    // registration/ready state, never on the pre-dialog snapshot.
    const liveReg = getGatewaySyncRegistration(id);
    if (liveReg === undefined || sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway connection changed while the confirmation was open; nothing was applied' };
    }
    const liveInstance = sm.listInstances().find(candidate => candidate.id === id);
    if (liveInstance === undefined || liveInstance.kind !== 'gateway') {
      return { ok: false as const, error: 'gateway connection changed while the confirmation was open; nothing was applied' };
    }
    try {
      const result = await gatewayChamberApplyBatch({
        id,
        url: liveReg.url,
        headers: liveReg.headers,
        spkiPin: liveReg.spkiPin,
        // Tunnel Host override: the same discipline as
        // syncGatewayChamberPluginsFor — an ssh transport presents the
        // remote gateway authority, never the loopback tunnel endpoint.
        authority: liveInstance.transport === 'ssh' ? gatewayTunnelAuthority(liveInstance.remotePort) : undefined,
        options: {
          add: validated.value.add,
          remove: validated.value.remove,
          deferRestart: validated.value.deferRestart,
        },
      });
      if (!result.ok) {
        const partial = result.outcome !== undefined && (result.outcome.installed.length > 0 || result.outcome.removed.length > 0)
          ? { installed: result.outcome.installed, removed: result.outcome.removed }
          : undefined;
        return {
          ok: false as const,
          error: sanitizeErrorText(result.error),
          ...(partial === undefined ? {} : { partial }),
        };
      }
      const outcome = result.outcome;
      return {
        ok: true as const,
        installed: outcome.installed,
        removed: outcome.removed,
        restarted: outcome.restarted,
        ...(outcome.deferredOps.length > 0 ? { deferred: true } : {}),
      };
    } catch (error) {
      return { ok: false as const, error: `gateway plugin apply failed: ${sanitizeErrorText(describeUnknownError(error))}` };
    }
  });
  // Gateway local materialize (design 21 §6.5/§10 ⑧ archive-pick): PICK-ONLY —
  // the picker runs here in the main process, so a compromised renderer can
  // never drive the pack/upload surface to an arbitrary local path (the same
  // hardening as the ssh materialize_add_pick path). No separate confirmation
  // dialog is needed: choosing the local source IS the user intent (design 21
  // §6.5, pick-only per design). A picked SOURCE FOLDER is packed into a
  // plugin tgz in the main process (bounded caps); a picked .tgz archive
  // uploads verbatim. Either way the plugin package.json name/version become
  // the x-plugin-name/x-plugin-version headers, and the upload rides the
  // REGISTERED transport origin.
  deps.ipc.handle(IPC_CHANNELS.GATEWAY_PLUGIN_MATERIALIZE, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const reg = getGatewaySyncRegistration(id);
    if (reg === undefined) return { ok: false as const, error: 'no active gateway registration' };
    if (sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway is not ready' };
    }
    // 无存活主窗预检经 edges.mainWindowAlive。
    if (!deps.edges.mainWindowAlive()) return { ok: false as const, error: 'no main window' };
    const instance = sm.listInstances().find(candidate => candidate.id === id);
    if (instance === undefined || instance.kind !== 'gateway') {
      return { ok: false as const, error: 'gateway instance not found' };
    }
    // Pick-only (design 21 §6.5): the picker runs here in the main process,
    // so a compromised renderer can never drive the upload surface to an
    // arbitrary local path. The pick may be a plugin SOURCE FOLDER or a
    // ready .tgz plugin archive (design 21 §10 archive-pick).
    const picked = await deps.edges.pickPluginSource();
    if (picked.status === 'cancelled') return { ok: true as const, cancelled: true };
    // Post-pick re-check: the user browsed for a while — the registration
    // and ready phase must still hold before any upload (the same
    // discipline as the ssh picker's ownsRemoteTarget re-check).
    const liveReg = getGatewaySyncRegistration(id);
    if (liveReg === undefined || sm.status(id)?.phase !== 'ready') {
      return { ok: false as const, error: 'gateway connection changed while the plugin picker was open' };
    }
    try {
      const classified = classifyPluginPick(picked.path);
      if (!classified.ok) {
        return { ok: false as const, error: sanitizeErrorText(classified.error) };
      }
      let tarball: Buffer;
      let name: string;
      let version: string;
      if (classified.source.kind === 'dir') {
        const built = await buildPluginTarball(classified.source.path);
        if (!built.manifest.ok) {
          return { ok: false as const, error: sanitizeErrorText(built.manifest.error) };
        }
        tarball = built.buffer;
        name = built.manifest.name;
        version = built.manifest.version;
      } else {
        // A ready npm-pack archive uploads verbatim — no rebuild. Its
        // name/version come from the archive's own manifest (read by the
        // bounded reader in classifyPluginPick) and are re-validated by
        // gatewayChamberMaterialize before any byte is sent.
        tarball = classified.source.bytes;
        name = classified.source.name;
        version = classified.source.version;
      }
      const result = await gatewayChamberMaterialize({
        id,
        url: liveReg.url,
        headers: liveReg.headers,
        spkiPin: liveReg.spkiPin,
        tarball,
        name,
        version,
        authority: instance.transport === 'ssh' ? gatewayTunnelAuthority(instance.remotePort) : undefined,
      });
      // materialize 的 202/受控重启对账结果带 outcome{executed,restarted}——
      // 成功分支优先回传 outcome，失败分支同样透传 outcome（网关侧已脱敏），
      // 无 outcome 时保持 deferred 语义。
      if (result.ok && 'outcome' in result) {
        return { ok: true as const, outcome: result.outcome };
      }
      if (result.ok) {
        return { ok: true as const, deferred: true as const };
      }
      return {
        ok: false as const,
        error: sanitizeErrorText(result.error),
        ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
      };
    } catch (error) {
      // Builder errors carry machine codes (path too long / cap exceeded /
      // folder changed while packing / unreadable) whose message text is
      // already specific — keep it loud and sanitized.
      return { ok: false as const, error: `gateway plugin materialize failed: ${sanitizeErrorText(describeUnknownError(error))}` };
    }
  });

}
