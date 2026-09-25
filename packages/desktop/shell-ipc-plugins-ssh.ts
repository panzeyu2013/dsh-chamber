/**
 * shell-ipc-plugins-ssh — domain IPC registrations: the ssh plugin READ face
 * (manifest cat → projection) plus the manual chamber host-package seed
 * fallback. The user plugin write surface (apply/undo/materialize) was retired
 * with the 2026-09 C layering ruling; seeding is chamber provisioning, not a
 * plugin-model write (design 21 §6.11), so SSH_SEED_HOST_GRAPH stays.
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { ExactOwnershipToken } from './plugin-sync.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { builtChamberHostPackageSeeds, redactRemotePluginManifest, remotePluginList, runWithFinalOwnership, seedRemoteChamberHostPackages } from './plugin-sync.ts'

export function registerSshPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps, portableHostSeeds } = ctx
  const { findRemoteTarget, ownsRemoteTarget, scopedExecForTarget, scopedProbeForTarget, liveProbeFor } = ctx.deps.ctx.sshPluginTargets
  const { transportManager: sm, hostPackageSeeding } = ctx.deps.ctx
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
    // 绝不穿过这条 RPC 离开主进程。
    if (!result.ok) return result;
    return { ok: true, manifest: redactRemotePluginManifest(result.manifest) };
  });

  // Host-graph seed (design 13 M4): installs the chamber host packages onto the
  // remote. Seeding is chamber provisioning — not part of the retired user
  // plugin write surface (design 21 §6.11) — and the manual resend covers BOTH
  // host packages.
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
}
