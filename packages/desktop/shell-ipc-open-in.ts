/** shell-ipc-open-in — domain IPC registrations. */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { OpenInLaunchContext, OpenInRequest } from './open-in.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { isValidNotificationSourceFingerprint } from './notifications.ts'
import { listOpenInApps, runOpenInLaunch } from './open-in.ts'

export function registerOpenInHandlers(ctx: ShellIpcCtx): void {
  const { deps, captureVscodeSource, openInCtx, enqueueRendererDeepLinkIntent, ownsNotificationSource, matchesNotificationSource } = ctx
  const { transportManager: sm } = ctx.deps.ctx
  deps.ipc.handle(IPC_CHANNELS.OPEN_IN_APPS, () => ({
    apps: listOpenInApps(openInCtx, (appId, error) => {
      console.error(`[dsh-chamber] open-in provider ${appId} 可用性探测失败：${error}`)
    }),
  }))
  deps.ipc.handle(IPC_CHANNELS.OPEN_IN, async (payload: unknown) => {
    // 载荷形状守卫：不可信渲染载荷直接解构会以 TypeError 落到 transport
    // rejection；统一为 loud {error}。
    const req = payload as Partial<OpenInRequest> | null
    if (req === null || typeof req !== 'object' || typeof req.appId !== 'string' || typeof req.instanceId !== 'string' || typeof req.path !== 'string' || typeof req.sourceFingerprint !== 'string') {
      return { ok: false, error: 'invalid open-in payload' }
    }
    const sourceInstance = req.instanceId === 'local'
      ? undefined
      : sm.listInstances().find(candidate => candidate.id === req.instanceId);
    const sourceId = req.instanceId === 'local'
      ? 'local'
      : sourceInstance === undefined ? '' : `${sourceInstance.kind}-${sourceInstance.id}`;
    if (!isValidNotificationSourceFingerprint(sourceId, req.sourceFingerprint)) {
      return { ok: false, error: 'invalid source fingerprint' };
    }
    if (!matchesNotificationSource(sourceId, req.sourceFingerprint)) {
      return { ok: false, error: 'source changed before open-in request was accepted' };
    }
    const sourceToken = captureVscodeSource(req.instanceId);
    if (sourceToken === null) return { ok: false, error: 'source not found' };
    const ownsSource = () => ownsNotificationSource(sourceToken);
    const scopedOpenInCtx: OpenInLaunchContext = {
      ...openInCtx,
      lookupInstance: id => ownsSource() ? openInCtx.lookupInstance(id) : null,
      openVscodeUrl: async url => {
        if (!ownsSource()) return { ok: false, error: 'source changed before VS Code launch' };
        const opened = await openInCtx.openVscodeUrl(url);
        return ownsSource() ? opened : { ok: false, error: 'source changed while VS Code launch was in progress' };
      },
    };
    const result = await runOpenInLaunch({ appId: req.appId, instanceId: req.instanceId, path: req.path }, scopedOpenInCtx)
    if (!ownsSource()) return { ok: false, error: 'source changed while open-in was in progress' };
    // vscode 启动成功后把 intent 放入 renderer hold/replay 队列（与 OS 深链
    // 路径对齐；finder 无此语义）。窗口未就绪也不丢，renderer ready 后补推；
    // 该 UI 联动从不阻塞 vscode 启动。
    if (result.ok && req.appId === 'vscode') {
      enqueueRendererDeepLinkIntent({ instanceId: req.instanceId, path: req.path }, sourceToken);
    }
    return result;
  })
}
