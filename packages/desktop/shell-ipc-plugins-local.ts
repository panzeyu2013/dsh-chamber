/** Domain IPC registrations：本地插件 list / npm search / add / remove。 */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { classifyPluginPick, folderPluginIdentity } from './plugin-tarball.ts'
import { describeLocalPluginAddConfirmation, describeLocalPluginRemoveConfirmation, describePluginDecision, guardPluginMutation, localPluginList, redactLocalPluginManifest, runLocalDshPlugin } from './plugin-sync.ts'
import { describeUnknownError } from './deep-link.ts'
import { isAllowedRegistryUrl } from '@dsh-chamber/dsh-runtime'
import { parseSpecName, parseSpecVersion } from './ssh-apply-rows.ts'
import { sanitizeErrorText } from './sanitize-error.ts'

export function registerLocalPluginHandlers(ctx: ShellIpcCtx): void {
  const { deps, localProtectionFacts, verifyLocalProfileFamily, confirmPluginAction, NPM_SEARCH_MAX_BODY_BYTES } = ctx
  const { localDshHome, runLocalPluginMutation } = ctx.deps.ctx
  // Local manifest read：localPluginList 读的是本机 dsh home（<localDshHome>/…
  // package.json 依赖投影 + bundle 激活层）——与 mutation 叶写同一 home；不可读/损坏一律
  // loud {error}，绝不静默空成功。
  // IPC 响应是脱敏投影：所有 materialize 类依赖值（file:/link:/相对/绝对/`~/` 及
  // rows[].spec）跨界前变成 MATERIALIZED_VALUE_MASK，本机绝对路径绝不进入远端实例的
  // bundle；主进程内部读保持完整（resolveLocalMaterializeDirectory / mutation 叶 / seed 腿）。
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_LIST, () => {
    try {
      return { ok: true, manifest: redactLocalPluginManifest(localPluginList(localDshHome, localProtectionFacts())) };
    } catch (error) {
      return { ok: false, error: describeUnknownError(error) };
    }
  });
  // BEST-EFFORT npm registry search：main-process fetch（renderer 留在 127.0.0.1），
  // 时间与响应体都有界，白名单外 URL/redirect 一律 loud 拒绝；任何拒绝/传输/解析失败都
  // loud {ok:false}，绝不静默空成功、绝不 unhandled rejection。
  deps.ipc.handle(IPC_CHANNELS.NPM_SEARCH, async (payload: unknown) => {
    const { query } = payload as { query: unknown };
    if (typeof query !== 'string' || query.trim() === '') return { ok: false, error: 'empty search query' };
    const text = query.trim();
    if (text.length > 256) return { ok: false, error: 'search query is too long' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    timer.unref?.();
    try {
      const searchUrl = new URL(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=20`);
      // 搜索端点共用 registry URL 白名单（origin + `/-/v1/search` 路径形状），绝不裸 fetch。
      if (!isAllowedRegistryUrl(searchUrl.toString())) {
        return { ok: false, error: 'search URL is not whitelisted' };
      }
      // redirect: 'manual' 与 fetchRegistryResponse 同一 per-hop 纪律：重定向的搜索结果
      // 不接受任意 origin，任何 3xx 都是显式失败。
      const response = await fetch(searchUrl, {
        signal: controller.signal,
        redirect: 'manual',
      });
      if (!response.ok) return { ok: false, error: `npm search failed (HTTP ${response.status})` };
      // 有界读取：超大/无尽的搜索响应绝不在主进程内存里累积。
      const reader = response.body?.getReader();
      let raw = '';
      if (reader !== undefined) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          raw += Buffer.from(value).toString('utf8');
          if (raw.length > NPM_SEARCH_MAX_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            return { ok: false, error: 'npm search response is too large' };
          }
        }
      }
      let data: { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> };
      try {
        data = JSON.parse(raw) as { objects?: Array<{ package?: { name?: unknown; version?: unknown; description?: unknown } }> };
      } catch {
        return { ok: false, error: 'npm search returned malformed JSON' };
      }
      const objects = Array.isArray(data.objects) ? data.objects : [];
      const packages = objects
        .map(entry => entry.package)
        .filter((pkg): pkg is { name: string; version: unknown; description: unknown } => pkg !== undefined && typeof pkg.name === 'string')
        .map(pkg => ({
          name: pkg.name,
          version: typeof pkg.version === 'string' ? pkg.version : '',
          ...(typeof pkg.description === 'string' ? { description: pkg.description } : {}),
        }));
      return { ok: true, packages };
    } catch (error) {
      return { ok: false, error: `npm search failed: ${describeUnknownError(error)}` };
    } finally {
      clearTimeout(timer);
    }
  });

  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD_FILE, async () => {
    if (!deps.edges.mainWindowAlive()) return { ok: false, error: 'no main window' };
    // 本机安装：路径来自 MAIN-process picker（源码目录或现成 .tgz），因此 `file:` spec 是
    // 主进程选定的——传 allowFileSpec 让它经 isAllowedLocalFileSpec（绝对 POSIX/Windows-drive/
    // UNC，无控制字符，≤4096 字符；不额外放宽白名单）。renderer 提交的 spec 通道
    // （LOCAL_PLUGIN_ADD）仍一律拒绝 `file:`，文件系统权限边界不变。
    const picked = await deps.edges.pickPluginSource();
    if (picked.status === 'cancelled') return { ok: true, cancelled: true };
    // 结构预检（扩展名 + 归档上限 + manifest 可解析）；name/version 语义仍以本地 dsh CLI 为准，
    // 与目录选择一致。
    const classified = classifyPluginPick(picked.path);
    if (!classified.ok) return { ok: false, error: sanitizeErrorText(classified.error) };
    // 对 PICKED manifest 做 protected-set 判定：pick 的名字只能来自所选 package.json，故在
    // 结果进入 CLI 前先判。`file:` spec 不带 registry 名，runLocalDshPlugin 自身的 guard 有意跳过。
    const pickedManifest = classified.source.kind === 'tgz'
      ? { ok: true as const, name: classified.source.name, version: classified.source.version as string | null }
      : folderPluginIdentity(classified.source.path);
    if (!pickedManifest.ok) return { ok: false, error: sanitizeErrorText(pickedManifest.error) };
    const localFacts = localProtectionFacts();
    const pickedGuard = guardPluginMutation({
      op: 'install',
      name: pickedManifest.name,
      version: pickedManifest.version,
      facts: localFacts,
    });
    if (pickedGuard.kind === 'refuse') {
      return { ok: false, error: describePluginDecision(pickedGuard) };
    }
    return runLocalPluginMutation('plugin:add-file', async (dshWorkspace) => {
      // 主进程 picker 就是被认可的 file: 来源：传 capability flag 让所选绝对路径过
      // runLocalDshPlugin 的门（否则每次 file: pick 都被当作非法 add spec 拒绝）。
      // Facts 在 mutation 内部重新解析：上面的 guard 跑在 picker/fence lease 之前，期间切换
      // runtime 会让内层 guard 与安装后校验描述上一个 runtime。
      const freshFacts = localProtectionFacts();
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', `file:${picked.path}`, { allowFileSpec: true, protection: freshFacts });
      if (!result.ok) return { ok: false, error: result.error ?? 'local add failed' };
      const verified = verifyLocalProfileFamily(freshFacts);
      return verified.ok ? { ok: true } : { ok: false, error: verified.error };
    });
  });
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_ADD, async (payload: unknown) => {
    const { spec: specArg } = payload as { spec: string };
    // `file:` 导入必须走主进程 picker（目录或 .tgz）；本 spec 通道只接受 registry spec，
    // 被攻陷的 renderer 不能把本机安装面指向任意路径。
    if (typeof specArg === 'string' && specArg.startsWith('file:')) {
      return { ok: false, error: 'local file imports must use the local import picker' };
    }
    // protected-set 判定在前：绝不让用户确认一个写面本会拒绝的安装（受保护名，或缺实例
    // 精确 generation 的官方 scope 安装）。
    const addFacts = localProtectionFacts();
    const addGuard = guardPluginMutation({
      op: 'install',
      name: parseSpecName(specArg),
      version: parseSpecVersion(specArg),
      facts: addFacts,
    });
    if (addGuard.kind === 'refuse') return { ok: false, error: describePluginDecision(addGuard) };
    // 用户确认：向 LOCAL profile 安装 registry 包会在下次本地启动时形成持久执行面，
    // 绝不静默执行脚本。
    const confirm = await confirmPluginAction(describeLocalPluginAddConfirmation(specArg));
    if ('cancelled' in confirm) return { ok: true, cancelled: true };
    if (!confirm.ok) return { ok: false, error: confirm.error };
    return runLocalPluginMutation('plugin:add', async (dshWorkspace) => {
      // Facts 在 mutation 内重新解析：上面的 guard 跑在确认对话框与 fence/lease 之前，期间
      // 切换 runtime 会让内层 guard 与安装后校验描述上一个 runtime；对话框前的 guard 保留为
      // 用户可见的快速拒绝。
      const freshFacts = localProtectionFacts();
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'add', specArg, { protection: freshFacts });
      if (!result.ok) return { ok: false, error: result.error ?? 'local add failed' };
      const verified = verifyLocalProfileFamily(freshFacts);
      return verified.ok ? { ok: true } : { ok: false, error: verified.error };
    });
  });
  deps.ipc.handle(IPC_CHANNELS.LOCAL_PLUGIN_REMOVE, async (payload: unknown) => {
    const { name } = payload as { name: unknown };
    if (typeof name !== 'string' || name === '') return { ok: false, error: 'invalid plugin name' };
    // protected-set 判定在前：composition 成员或 chamber seed 绝不通过插件模型移除——
    // 拒绝即时且诚实，而不是确认后在 CLI 里死掉；`remove` 不判版本。
    const removeFacts = localProtectionFacts();
    const removeGuard = guardPluginMutation({ op: 'remove', name, version: null, facts: removeFacts });
    if (removeGuard.kind === 'refuse') return { ok: false, error: describePluginDecision(removeGuard) };
    // 用户确认：移除是破坏性操作，页面脚本不得静默清空本地 profile。
    const confirm = await confirmPluginAction(describeLocalPluginRemoveConfirmation(name));
    if ('cancelled' in confirm) return { ok: true, cancelled: true };
    if (!confirm.ok) return { ok: false, error: confirm.error };
    return runLocalPluginMutation('plugin:remove', async (dshWorkspace) => {
      const freshFacts = localProtectionFacts();
      const result = await runLocalDshPlugin(dshWorkspace, localDshHome, 'remove', name, { protection: freshFacts });
      return result.ok ? { ok: true } : { ok: false, error: result.error ?? 'local remove failed' };
    });
  });
}
