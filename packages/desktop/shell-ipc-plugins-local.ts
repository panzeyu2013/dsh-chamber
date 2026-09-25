/**
 * shell-ipc-plugins-local — domain IPC registration: the LOCAL plugin manifest
 * READ projection (`desktop_local_plugin_list`). The local plugin write surface
 * (npm search / add / picker install / remove) was retired with the 2026-09 C
 * layering ruling.
 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { localPluginList, redactLocalPluginManifest } from './plugin-sync.ts'
import { describeUnknownError } from './deep-link.ts'

export function registerLocalPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps, localProtectionFacts } = ctx
  const { localDshHome } = ctx.deps.ctx
  // Local manifest read：localPluginList 读的是本机 dsh home（<localDshHome>/…
  // package.json 依赖投影 + bundle 激活层）；不可读/损坏一律 loud {error}，绝不静默空成功。
  // IPC 响应是脱敏投影：所有 materialize 类依赖值（file:/link:/相对/绝对/`~/` 及
  // rows[].spec）跨界前变成 MATERIALIZED_VALUE_MASK，本机绝对路径绝不进入 renderer。
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_LIST, () => {
    try {
      return { ok: true, manifest: redactLocalPluginManifest(localPluginList(localDshHome, localProtectionFacts())) };
    } catch (error) {
      return { ok: false, error: describeUnknownError(error) };
    }
  });
}
