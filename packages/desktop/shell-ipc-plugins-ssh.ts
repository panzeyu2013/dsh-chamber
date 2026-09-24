/**
 * shell-ipc-plugins-ssh — domain IPC registrations
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { ExactOwnershipToken } from './plugin-sync.ts'
import { INSTANCE_ID_PATTERN } from './transport-manager.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { applyPlugins, builtChamberHostPackageSeeds, localPluginList, materializeAndAdd, materializeArchiveAndAdd, redactRemotePluginManifest, remotePluginList, resolveLocalMaterializeDirectory, runWithFinalOwnership, seedRemoteChamberHostPackages, sshApplyFacts } from './plugin-sync.ts'
import { buildSshApplyRows, buildSshUndoDecision, describePluginRefusals, describeSshUndoConfirmation } from './ssh-apply-rows.ts'
import { classifyPluginPick } from './plugin-tarball.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export function registerSshPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps, localProtectionFacts, confirmPluginAction, portableHostSeeds } = ctx
  const { findRemoteTarget, ownsRemoteTarget, scopedExecForTarget, scopedStatusForTarget, scopedProbeForTarget, liveProbeFor } = ctx.deps.ctx.sshPluginTargets
  const { localDshHome, sshPluginJournal, transportManager: sm, hostPackageSeeding } = ctx.deps.ctx
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_LIST, async (payload: unknown) => {
    const { id } = payload as { id: string };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    const result = await runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => remotePluginList(scopedExecForTarget(target), target.spec, {
        liveProbe: scopedProbeForTarget(target, liveProbeFor(id)),
      }),
    );
    // readManifest 投影统一掩码 (design 21 §6.2/§6.4)：renderer 投影把远端
    // 本地路径类值掩成 MATERIALIZED_VALUE_MASK（保留 file: 前缀）——远端路径
    // 绝不穿过这条 RPC 离开主进程；主进程内部的 manifest（verifyApplied
    // 回读、undo journal 快照、materialize 解析）不脱敏。
    if (!result.ok) return result;
    return { ok: true, manifest: redactRemotePluginManifest(result.manifest) };
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_APPLY, async (payload: unknown) => {
    const { id, add, remove, restart } = payload as { id: string; add: string[]; remove: string[]; restart?: boolean };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    // A non-boolean `restart` (e.g. the string 'false') must never be treated
    // as truthy; refused before any exec (applyPlugins re-checks too).
    if (restart !== undefined && typeof restart !== 'boolean') {
      return { ok: false, error: 'restart must be a boolean' };
    }
    // Protected-set judgement (design 21 §6.11, ssh form = B₀ ∪ S with no
    // family source): whole-batch refusal naming each refused row and its code
    // BEFORE any transport work; applyPlugins re-checks with the same facts.
    const assembled = buildSshApplyRows(add, remove, sshApplyFacts());
    if (assembled.refusals.length > 0) {
      return { ok: false, error: describePluginRefusals(assembled.refusals) };
    }
    // Known bundle packages for the bundles assertion (§4.5 ④, design 13):
    // the LOCAL manifest's bundle-declaring dependency names. An unreadable
    // local profile skips only the bundles half — dependency membership is
    // still asserted, never a silent wrong assertion.
    let knownBundles: string[] | undefined;
    try {
      knownBundles = localPluginList(localDshHome, localProtectionFacts()).bundleLines;
    } catch (localError) {
      console.warn('[dsh-chamber] 本地清单不可读，bundle 激活层断言跳过：', localError);
      knownBundles = undefined;
    }
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => applyPlugins(
        scopedExecForTarget(target),
        scopedStatusForTarget(target),
        target.spec,
        { add, remove, restart },
        {
          knownBundles,
          ownershipKey: `${target.sourceToken.generation}:${target.fingerprint}`,
          journal: sshPluginJournal,
          targetFingerprint: target.fingerprint,
          protection: sshApplyFacts(),
        },
      ),
    );
  });
  // Undo the latest ok ssh plugin change (design 21 §6.4): the undo journal
  // records every executed row with its pre-change remote spec, and v1 undo
  // runs the inverse row through the SAME ssh apply flow — an ok add is
  // removed; an ok remove re-adds the previous REGISTRY spec (a previous
  // remote file: package cannot be re-added in v1 → unavailable:'file-backed').
  // User-initiated main-process confirmation (default cancel) with
  // restart-to-apply, journaled so further undos chain.
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_UNDO, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false as const, error: 'ssh instance not found' };
    // Target binding (design 21 §6.4): only ops recorded on the CURRENT
    // operational target are undoable — a connection edit under the same id
    // must never replay a change onto the wrong machine; fingerprint-null ops
    // (recorded before binding) are not provably undoable either.
    const op = sshPluginJournal.latestOkForTarget(id, target.fingerprint);
    if (op === null) return { ok: false as const, error: 'no recent plugin change to undo on this target', unavailable: 'none' as const };
    const decision = buildSshUndoDecision(op);
    if (!decision.ok) {
      return { ok: false as const, error: decision.error, unavailable: decision.info.unavailable };
    }
    // Main-process confirmation with the undo copy; default cancel.
    const instance = sm.listInstances().find(candidate => candidate.id === id);
    const confirm = await confirmPluginAction(describeSshUndoConfirmation({
      targetLabel: instance?.label ?? null,
      targetId: id,
      opKind: op.kind,
      name: op.name,
      spec: decision.action.kind === 'add' ? decision.action.spec : null,
    }));
    if ('cancelled' in confirm) return { ok: true as const, cancelled: true };
    if (!confirm.ok) return { ok: false as const, error: confirm.error };
    // Execute the inverse row through the same apply flow with restart-to-apply.
    const undoActions: { add: string[]; remove: string[]; restart: boolean } =
      decision.action.kind === 'add'
        ? { add: [decision.action.spec], remove: [], restart: true }
        : { add: [], remove: [decision.action.name], restart: true };
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      async () => {
        const result = await applyPlugins(
          scopedExecForTarget(target),
          scopedStatusForTarget(target),
          target.spec,
          undoActions,
          {
            ownershipKey: `${target.sourceToken.generation}:${target.fingerprint}`,
            journal: sshPluginJournal,
            targetFingerprint: target.fingerprint,
            protection: sshApplyFacts(),
          },
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        if (result.result.applied === 0 && result.result.failed.length > 0) {
          return { ok: false as const, error: `undo failed: ${result.result.failed[0].error}` };
        }
        // Honest undo outcome: an executed change that did not fully take
        // effect must never project as a clean success — the undone arm then
        // carries {restarted, ready, readyNote} (failed restart, failed
        // post-change verification or failed readiness re-check). A clean undo
        // omits them, so the PRESENCE of undone.restarted is the renderer's
        // "executed but not fully effective" signal, backward compatible with
        // the clean {kind, name} arm.
        const outcome = result.result;
        const cleanUndo =
          outcome.applied > 0
          && outcome.restarted
          && outcome.verified
          && outcome.ready !== false;
        if (cleanUndo) return { ok: true as const, undone: { kind: op.kind, name: op.name } };
        return {
          ok: true as const,
          undone: {
            kind: op.kind,
            name: op.name,
            restarted: outcome.restarted,
            ready: outcome.ready,
            ...(outcome.readyNote === undefined ? {} : { readyNote: outcome.readyNote }),
          },
        };
      },
    );
  });

  // Host-graph seed + remote materialize (design 13 M4): Seed installs the
  // chamber host packages onto the remote (the manual resend covers BOTH host
  // packages); materialize installs a local plugin source remotely — the ADD
  // view via materialize_add_pick (main-process picker, pick-only), the sync
  // view via materialize_add (absolute directory resolved from the
  // authoritative local manifest). LOCAL_PLUGIN_* 本地腿留在 main.ts。
  deps.ipc.handle(IPC_CHANNELS.SSH_SEED_HOST_GRAPH, async (payload: unknown) => {
    const { id } = payload as { id: string };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    // Not shipped is a loud error on the MANUAL path (the button must never
    // look like it succeeded while writing nothing); the auto path skips with
    // an info log. Portability first (design 20 §6): a `localOnly` row (empty
    // sourceDir by design) must never count as a missing artifact here, and an
    // empty dir can never resolve the process CWD's dist/index.js.
    const seeds = portableHostSeeds();
    const built = builtChamberHostPackageSeeds(seeds);
    const missing = seeds.filter(seed => !built.includes(seed));
    if (missing.length > 0) {
      return { ok: false, error: `chamber host 包未打包：${missing.map(seed => seed.label).join('、')} 的 dist/index.js 缺失——请先构建（pnpm run build:host-packages）` };
    }
    const begun = hostPackageSeeding.begin(id, target.fingerprint);
    if (!begun.accepted) return { ok: false, error: 'chamber host seed in progress' };
    const token: ExactOwnershipToken = begun.token;
    const ownsSeed = () => hostPackageSeeding.owns(token) && ownsRemoteTarget(target);
    try {
      const result = await seedRemoteChamberHostPackages(
        scopedExecForTarget(target, ownsSeed),
        target.spec,
        seeds,
      );
      if (!ownsSeed()) return { ok: false, error: 'ssh instance changed while host seed was in progress' };
      // Surface the outcome in the instance's ring-buffer log (never a silent modification).
      if (result.ok) {
        const summary = result.packages.map(entry => `${entry.insertId}${entry.wrote ? ' 已写入' : ' 已是最新'}`).join('、');
        if (ownsSeed()) sm.appendLog(id, 'info', `chamber host 包注入完成：${summary}；boot 层${result.patched ? '已挂载' : '无需改动'}（重启后生效）`);
      } else {
        if (ownsSeed()) sm.appendLog(id, 'error', `chamber host 包注入失败：${result.error}`);
      }
      return result;
    } finally {
      hostPackageSeeding.finish(token);
    }
  });
  // materialize_add (sync view): the renderer supplies only the dependency
  // NAME; main re-reads the authoritative manifest and resolves its path, so
  // an IPC caller can never choose an arbitrary local directory.
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD, async (payload: unknown) => {
    const { id, name } = payload as { id: string; name: unknown };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    if (typeof name !== 'string') return { ok: false, error: 'invalid plugin name' };
    const resolved = resolveLocalMaterializeDirectory(localDshHome, name);
    if (!resolved.ok) return resolved;
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => materializeAndAdd(scopedExecForTarget(target), target.spec, resolved.path),
    );
  });
  // materialize_add_pick (add view): PICK-ONLY — the picker runs in the main
  // process, so a compromised renderer can never drive the pack surface to an
  // arbitrary local directory (design 13 §5.8). The pick may be a source
  // folder (packed locally, uploaded) or a ready .tgz (uploaded verbatim).
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD_PICK, async (payload: unknown) => {
    const { id } = payload as { id: string };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    if (!deps.edges.mainWindowAlive()) return { ok: false, error: 'no main window' };
    const picked = await deps.edges.pickPluginSource();
    if (picked.status === 'cancelled') return { ok: true, cancelled: true };
    if (!ownsRemoteTarget(target)) return { ok: false, error: 'ssh instance changed while the plugin picker was open' };
    const classified = classifyPluginPick(picked.path);
    if (!classified.ok) return { ok: false, error: sanitizeErrorText(classified.error) };
    // Narrow the source BEFORE the ownership closures — TypeScript resets
    // property narrowing at closure boundaries, so the closures must not re-check.
    const source = classified.source;
    if (source.kind === 'dir') {
      return runWithFinalOwnership(
        () => ownsRemoteTarget(target),
        () => materializeAndAdd(scopedExecForTarget(target), target.spec, source.path),
      );
    }
    const archiveName = source.name;
    // The archive's declared version is the judgement's version input; dropping
    // it would leave the materialize generation check blind to it.
    const archiveVersion = source.version;
    const archiveBytes = source.bytes;
    return runWithFinalOwnership(
      () => ownsRemoteTarget(target),
      () => materializeArchiveAndAdd(scopedExecForTarget(target), target.spec, {
        name: archiveName,
        version: archiveVersion,
        bytes: archiveBytes,
      }),
    );
  });

}
