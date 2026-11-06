/** shell-ipc-open-in — domain IPC registrations. */
import type { ShellIpcCtx } from './shell-ipc-ctx.ts'
import type { OpenInLaunchContext, OpenInRequest } from './open-in.ts'
import { describeError } from './describe-error.ts'
import { IPC_CHANNELS } from './ipc-events.ts'
import { isValidNotificationSourceFingerprint } from './notifications.ts'
import { listOpenInApps, runOpenInLaunch } from './open-in.ts'
import { registerForwardHandlers } from './shell-ipc-browser.ts'
import { createRemoteForwardService } from './remote-forward-service.ts'
import type { RemoteForwardService, RemoteForwardServiceOptions } from './remote-forward-service.ts'
import type { ForwardEmbeddingSnapshot, ForwardFrameError } from './remote-forward-manager.ts'

/**
 * The per-process remote-browser forward plane.
 *
 * Built ONCE: every `installIpcHandlers` call (Electron main and the Swift
 * sidecar both go through it) would otherwise create another manager with its
 * own alias namespace and child ledger, so two registrations could hand the same
 * (alias, port) to two children. A creation-level failure (no derivable
 * <userData>, unusable options) is remembered as null: the four forward channels
 * stay registered and keep answering the honest `forward_failed`
 * ("forward ipc service is not assembled") instead of disappearing from the
 * bridge surface. Store-level failures (corrupt namespace/children file) are NOT
 * creation failures: the service exists and fails CLOSED per call with a typed
 * `forward_failed`, so the launcher can show a real error instead of a lie.
 *
 * TODO(S1/W0): persist the "browser enabled" decision and confirm the real
 * ssh/askpass spawn, the packaged private-file adapter and the
 * darwin/win32 process adapters on their platforms.
 */
let forwardService: RemoteForwardService | null = null
let forwardServiceCreated = false
/** Embedding capability chosen when the forward plane was assembled (absent = enabled). */
let localEmbedding: ForwardEmbeddingSnapshot | undefined
/**
 * Bounded main-side local-frame failure store (v2 W-15 fix): a local direct
 * iframe has no forward record, so main projects its did-fail-load observation
 * here and the renderer reads it back through the additive `forward.list.frameErrors`
 * field. Keyed by canonical origin; insertion order is the eviction order.
 */
const LOCAL_FRAME_ERROR_LIMIT = 8
const localFrameErrorsByOrigin = new Map<string, ForwardFrameError>()

/**
 * True for a direct local browser frame URL: http(s) on 127.0.0.1 / localhost.
 * The alias range 127.0.0.2..254 is a forwarded page (record frameError path),
 * so it is deliberately NOT local here.
 */
export function isLocalBrowserFrameUrl(url: string): boolean {
  if (typeof url !== 'string' || url.length === 0 || url.length > 4096) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
}

/**
 * Project one observed local child-frame failure (or clear one origin with null).
 * Non-local / unparsable URLs are ignored: an alias failure belongs to its record,
 * and a foreign scheme has no local iframe to paint. Bounded, never throws.
 */
export function noteLocalFrameError(url: string, frameError: ForwardFrameError | null): void {
  if (!isLocalBrowserFrameUrl(url)) return
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return
  }
  // Re-insert so a refreshed failure is the newest entry (LRU-ish eviction).
  localFrameErrorsByOrigin.delete(origin)
  if (frameError !== null) {
    localFrameErrorsByOrigin.set(origin, frameError)
    while (localFrameErrorsByOrigin.size > LOCAL_FRAME_ERROR_LIMIT) {
      const oldest = localFrameErrorsByOrigin.keys().next().value
      if (oldest === undefined) break
      localFrameErrorsByOrigin.delete(oldest)
    }
  }
}

/** Snapshot of the bounded local-frame failure store (newest last). */
export function localFrameErrors(): readonly { readonly origin: string; readonly code: ForwardFrameError }[] {
  return [...localFrameErrorsByOrigin].map(([origin, code]) => ({ origin, code }))
}

/** Drop every stored local-frame failure (document restart / renderer revoke). */
export function clearLocalFrameErrors(): void {
  localFrameErrorsByOrigin.clear()
}

/** The module-level singleton (tests pass `options` to inject fakes). */
export function getOrCreateForwardService(
  ctx: ShellIpcCtx,
  options?: RemoteForwardServiceOptions,
): RemoteForwardService | null {
  if (forwardServiceCreated) return forwardService
  forwardServiceCreated = true
  localEmbedding = options?.embedding
  try {
    forwardService = createRemoteForwardService(ctx, options ?? {})
  } catch (error) {
    forwardService = null
    console.warn('[dsh-chamber] remote-browser 转发服务未装配，四个通道返回 forward_failed：' + describeError(error))
  }
  if (forwardService !== null) {
    // Source deletion/retarget must stop live children and tombstone the alias;
    // the transport registry is the one place that sees both edges.
    ctx.deps.ctx.transportManager.setSourceRetiredListener?.((sourceId) => {
      void forwardService?.retireSource(sourceId).catch((error: unknown) => {
        console.warn('[dsh-chamber] remote-browser 转发源回收失败：' + describeError(error))
      })
    })
  }
  return forwardService
}

/**
 * v2 renderer-lifecycle funnel (design 28 §16.5): a document reload/crash/close
 * kills every iframe, so every tab-bound forward must be revoked with it. The
 * new document re-attaches lazily from its persisted tabs. Pinned records (the
 * system-browser leg) hold no consumer and are deliberately left alive.
 */
export type ForwardRendererLifecycleEvent = 'did-start-loading' | 'did-finish-load' | 'crashed' | 'closed'

/** Revoke every forward a renderer consumer holds (idempotent, never throws). */
export function revokeForwardRenderer(event: ForwardRendererLifecycleEvent): void {
  if (event !== 'did-start-loading' && event !== 'crashed' && event !== 'closed') return
  // A new document paints fresh local frames: the previous document's origin
  // observations must not refuse them (W-15 store lifecycle).
  clearLocalFrameErrors()
  const service = forwardService
  if (service === null) return
  void service.revokeAttached().catch((error: unknown) => {
    console.warn('[dsh-chamber] remote-browser 渲染器生命周期回收失败：' + describeError(error))
  })
}

/**
 * Quit leg: stop every live forward child before the shell's transports go away.
 * Idempotent; a disposal failure is loud but never blocks the rest of the quit
 * chain (the durable ledger + next-start reaper still cover a crash window).
 */
export async function disposeForwardService(): Promise<void> {
  const service = forwardService
  if (service === null) return
  forwardService = null
  forwardServiceCreated = false
  try {
    await service.dispose()
  } catch (error) {
    console.warn('[dsh-chamber] remote-browser 转发退出回收失败：' + describeError(error))
  }
}

/**
 * v2 frame-failure projection (design 28 §16.7): main forwards an observed
 * child-frame load failure for a browser record's alias origin. Safe before the
 * service exists (no-op) and async by contract (returns before the patch lands).
 */
export function noteForwardFrameError(url: string, frameError: ForwardFrameError | null): void {
  const service = forwardService
  if (service === null) return
  void service.noteFrameErrorForUrl(url, frameError).catch((error: unknown) => {
    console.warn('[dsh-chamber] remote-browser frame error 投影失败：' + describeError(error))
  })
}

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
  // Remote-browser forward (design 28 §7): mounted from this registrar to keep
  // installIpcHandlers the single registration point without a shell-core
  // budget raise (w0-ipc-gate-map §3.2 option C). The service is the module-level
  // singleton above (null only when it could not be constructed at all), so the
  // four channels are wired to real forwards on both flavors. The local frame
  // state rides ALONGSIDE the service (not inside it): the local leg has no
  // forward record, but its failures answer on the same list channel.
  registerForwardHandlers(ctx, getOrCreateForwardService(ctx), {
    frameErrors: localFrameErrors,
    embedding: () => localEmbedding,
  })
}
