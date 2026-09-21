/**
 * shell-ipc-plugins-ssh — domain IPC registrations split out of shell-core.ts
 * (2026-12 stage-3 shell-core domain split). PURE MOVE: handler bodies, registration
 * order and error semantics are unchanged; the shared state/helpers arrive through
 * ShellIpcCtx, the assembly-side deps through ctx.deps.ctx.
 */
import type { ShellIpcCtx } from './shell-core.ts'
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
    // readManifest 投影统一掩码 (design 21 §6.2/§6.4, decision 18): the
    // renderer projection masks remote-local `file:` dependency values
    // (MATERIALIZED_VALUE_MASK, `file:` prefix preserved) exactly like the
    // gateway installed route — remote paths never leave the main process
    // through this RPC. The main-process-internal manifest (verifyApplied
    // read-backs, the undo journal snapshot, materialize resolution) is
    // never redacted — only this IPC response is.
    if (!result.ok) return result;
    return { ok: true, manifest: redactRemotePluginManifest(result.manifest) };
  });
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_APPLY, async (payload: unknown) => {
    const { id, add, remove, restart } = payload as { id: string; add: string[]; remove: string[]; restart?: boolean };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    // A non-boolean `restart` (e.g. the string 'false') must never be
    // treated as truthy and trigger an unwanted restart — refused here
    // before any exec (applyPlugins re-checks too, defense in depth).
    if (restart !== undefined && typeof restart !== 'boolean') {
      return { ok: false, error: 'restart must be a boolean' };
    }
    // Protected-set judgement (design 21 §6.11, ssh form = B₀ ∪ S with no
    // family source): whole-batch refusal naming each refused row and its
    // code BEFORE any transport work. applyPlugins re-checks with the same
    // facts (defense in depth) and the undo path rides that same check.
    const assembled = buildSshApplyRows(add, remove, sshApplyFacts());
    if (assembled.refusals.length > 0) {
      return { ok: false, error: describePluginRefusals(assembled.refusals) };
    }
    // Known bundle packages for the §4.5 ④ bundles assertion (design 13):
    // the LOCAL manifest's bundle-declaring dependency names. When the
    // local profile is unreadable there is no local source to sync from,
    // so the bundles half of the assertion is skipped (dependencies
    // membership is still asserted); never a silent wrong assertion.
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
  // Undo the latest ok ssh plugin change (design 21 §6.4, plan Phase 5 ssh
  // 统一增量): the undo journal (applyPlugins records every executed row
  // with its pre-change remote spec) answers 「撤销最近变更」. v1 undo =
  // the inverse row through the SAME ssh apply flow — undoing an ok add
  // removes that name; undoing an ok remove re-adds the previous REGISTRY
  // spec (a remove whose previous spec was a remote file: package cannot
  // be re-added in v1 → {ok:false, unavailable:'file-backed'}). The undo
  // is a user-initiated MAIN-process confirmation (default cancel, decision
  // 14) and re-executes with restart-to-apply, journaled, so further undos
  // chain. Never a silent script action.
  deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_UNDO, async (payload: unknown) => {
    const { id } = payload as { id: unknown };
    if (typeof id !== 'string' || !INSTANCE_ID_PATTERN.test(id)) {
      return { ok: false as const, error: 'invalid or unknown instance id' };
    }
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false as const, error: 'ssh instance not found' };
    // Target binding (design 21 §6.4 review P1): only ops recorded on the
    // CURRENT operational target are undoable — a connection edit under
    // the same id (new host/user/service/home) must never replay a change
    // onto the wrong machine. Ops recorded before target binding existed
    // (fingerprint null) are never undoable either (their target cannot be
    // proven).
    const op = sshPluginJournal.latestOkForTarget(id, target.fingerprint);
    if (op === null) return { ok: false as const, error: 'no recent plugin change to undo on this target', unavailable: 'none' as const };
    const decision = buildSshUndoDecision(op);
    if (!decision.ok) {
      return { ok: false as const, error: decision.error, unavailable: decision.info.unavailable };
    }
    // Main-process confirmation with the undo copy (default cancel — the
    // undo re-executes a remote write + restart, never a silent action).
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
    // Execute the inverse row through the same apply flow (journaled so
    // further undos chain) with restart-to-apply.
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
        // Honest undo outcome (P2-2): a change that EXECUTED but did not
        // fully take effect must never project as a clean success. The
        // undone arm carries the outcome fields ({restarted, ready,
        // readyNote}) whenever the undo is not clean — a failed restart,
        // a failed post-change verification, or a failed readiness
        // re-check. A clean undo (rows executed + restart ok + verified +
        // readiness ok or not-checked-with-note) omits the fields
        // entirely, so the PRESENCE of undone.restarted is the renderer's
        // "executed but not fully effective" signal (mirror shape,
        // backward compatible with the clean {kind, name} arm).
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

  // Host-graph seed + remote materialize (design 13 M4): the M2 orchestration
  // functions that were implemented but not yet wired. Seed installs the
  // chamber host packages (module A host-graph + git-worktree +
  // archive-cleanup) onto the remote (09 遗留 1; the manual resend covers
  // BOTH chamber host packages — a remote connected before the git package
  // existed only picks it up through this path or the next ready
  // transition); materialize installs a local plugin source (folder or .tgz
  // archive) remotely — the ADD view goes through materialize_add_pick
  // (picker in the Electron main via edges.pickPluginSource, pick-only), the
  // sync view through materialize_add (dir resolved from the authoritative
  // local manifest, validated here as absolute + directory). LOCAL_PLUGIN_*
  // 本地腿（runLocalDshPlugin 执行面）仍留 main.ts。
  deps.ipc.handle(IPC_CHANNELS.SSH_SEED_HOST_GRAPH, async (payload: unknown) => {
    const { id } = payload as { id: string };
    const target = findRemoteTarget(id);
    if (target === null) return { ok: false, error: 'ssh instance not found' };
    // Not shipped is a loud error on the MANUAL path (the button must never
    // look like it succeeded while writing nothing) — the auto path skips
    // with an info log instead. The manual resend covers BOTH chamber host
    // packages (host-graph + git-worktree): a remote connected before the
    // git package existed only picks it up through this path or the next
    // ready transition.
    // Portability first (design 20 §6, 2026-12 review): a `localOnly` row (empty
    // sourceDir by design) must never count as a missing artifact on this
    // OTHER-host path; the shipped-artifact gate also refuses an empty dir, so it
    // can never resolve the process CWD's own dist/index.js.
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
      // Surface the outcome in the instance's ring-buffer log (the connections
      // UI log panel) — the injection is never a silent modification.
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
  // materialize_add (sync view): renderer supplies only the dependency NAME.
  // Main re-reads the authoritative local manifest and resolves/canonicalizes
  // its path; an IPC caller can never choose an arbitrary local directory.
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
  // materialize_add_pick (add view): PICK-ONLY — the picker runs here in
  // the main process, so a compromised renderer can never drive the pack
  // surface to an arbitrary local directory (design 13 §5.8 hardening).
  // The pick may be a plugin SOURCE FOLDER or a ready .tgz plugin archive
  // (design 21 §10 archive-pick): a folder is packed locally and uploaded;
  // an archive uploads verbatim (no local pnpm pack runs).
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
    // property narrowing at closure boundaries, and the closure bodies must
    // not re-check the kind.
    const source = classified.source;
    if (source.kind === 'dir') {
      return runWithFinalOwnership(
        () => ownsRemoteTarget(target),
        () => materializeAndAdd(scopedExecForTarget(target), target.spec, source.path),
      );
    }
    const archiveName = source.name;
    // The archive's declared version (read by classifyPluginPick) is the
    // judgement's version input; dropping it left the parameter dead and
    // the materialize generation check unable to see it (2026-12 review).
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

  // —— G 组（S7 批；W-10 S7 施工图第 1 项）——
  // gateway 插件 3 注册体（GATEWAY_PLUGIN_SYNC / GATEWAY_PLUGIN_APPLY /
  // GATEWAY_PLUGIN_MATERIALIZE——按原 main.ts 顺序紧接 F 组追加；注册体自
  // main.ts 逐字迁入，全零 Electron，trustedIpc 围栏由装配侧注入 registrar
  // 包装）。编排纯模块直接 import（gateway-provider / gateway-sync-registry /
  // gateway-ipc-shared / plugin-tarball——main.ts 同款 import 面）；注册参数
  // 读取（getGatewaySyncRegistration 纯模块——main 装配侧的 ready 注册/离开
  // ready/实例撤销路径（sm.onStatusChanged / publishRegistryTransition）经
  // setGatewaySyncRegistration 写同一注册表，读写同表不分叉）与 ready 位复验
  // 在注册体侧。手动 sync 的上传执行闭包经 ctx.syncGatewayChamberPluginsFor
  // （main 装配侧定义——ready 自动 sync 与手动 re-entry 共用同一执行路径与
  // 注册参数，语义不分叉）。确认对话框 = 上方 S6 edges 版 confirmPluginAction
  // 助手（单参 copy；无存活主窗 → 'native confirmation unavailable'；response
  // ===1（'继续'）→ ok；否则 cancelled；异常 → loud——语义与 main 闭包逐字一
  // 致；main 侧原 confirmPluginAction 闭包已随 W-10 S8 H 组删除（LOCAL_PLUGIN_ADD/
  // REMOVE 迁出后无使用点）——本组与 H 组注册体同经本助手）；无存活主窗预检 =
  // edges.mainWindowAlive、插件源 pick = edges.pickPluginSource（宿主腿均在
  // electron-edges.ts S6 实现）。
}
