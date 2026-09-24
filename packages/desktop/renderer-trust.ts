/** Pure trust predicates for Electron main. */

export interface RendererFrameLike {
  url: string
}

export interface RendererWebContentsLike {
  mainFrame: unknown
}

export interface IpcSenderLike {
  sender: unknown
  senderFrame?: RendererFrameLike | null
}

/**
 * Only the fixed chamber shell document is privileged. The control-plane origin
 * also serves untrusted instance responses under /api/i/<id>/*, so origin equality
 * alone would let a proxied remote HTML document inherit preload.
 */
export function isTrustedRendererUrl(url: string, controlPlaneOrigin: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(controlPlaneOrigin)
    return (expected.protocol === 'http:' || expected.protocol === 'https:')
      // A URL carrying userinfo has the same WHATWG origin but is a different trust class;
      // Swift TrustGuard rejects userinfo and this side must not be laxer — the
      // credential-bearing URL is never the shell document, so rejecting loses no capability.
      && actual.username === ''
      && actual.password === ''
      && expected.username === ''
      && expected.password === ''
      && actual.origin === expected.origin
      && actual.pathname === '/'
      && actual.search === ''
  } catch {
    return false
  }
}

/**
 * 可交给 OS 默认处理器打开的外链：严格按 scheme 白名单放行 http(s)（默认浏览器）
 * 与 mailto（邮件客户端），其他协议（file:/javascript:/data:/自定义 scheme）与解析
 * 失败一律拒绝。http(s) 且给出 controlPlaneOrigin 时，同源目标不算外链——在浏览器
 * 里打开控制面只会得到无 preload 的重复壳；mailto 恒为外链。只做 scheme + 同源判定。
 */
export function isExternalLinkUrl(url: string, controlPlaneOrigin?: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'mailto:') return parsed.href !== 'mailto:'
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    if (controlPlaneOrigin !== undefined) {
      return parsed.origin !== new URL(controlPlaneOrigin).origin
    }
    return true
  } catch {
    return false
  }
}

/**
 * The Electron renderer permission posture: deny-by-default with one benign exception,
 * clipboard-sanitized-write (what navigator.clipboard.writeText() requests in Blink —
 * a deny silently breaks every copy button while permissions.query still reports
 * granted). Electron default-grants same-origin requests and the control plane serves
 * proxied instance content on the same origin, so the default must be overridden;
 * clipboard-read, custom-format writes and media/geo/notifications stay denied.
 * main.ts wires this predicate into BOTH the request handler and the check handler
 * (the latter backs permissions.query and must mirror the request posture).
 */
export const CHAMBER_PERMISSION_ALLOWLIST: ReadonlySet<string> = new Set(['clipboard-sanitized-write'])

/** True only for the allowlisted permission (see above). */
export function isChamberPermissionGranted(permission: string): boolean {
  return CHAMBER_PERMISSION_ALLOWLIST.has(permission)
}

/**
 * IPC is accepted only from the current main window main frame and fixed chamber
 * shell document: an origin check alone would let a child, stale WebContents or
 * /api/i/* remote document reuse it.
 */
export function isTrustedIpcSender(
  event: IpcSenderLike,
  webContents: RendererWebContentsLike,
  controlPlaneOrigin: string,
): boolean {
  const frame = event.senderFrame
  return event.sender === webContents
    && frame !== undefined
    && frame !== null
    && frame === webContents.mainFrame
    && isTrustedRendererUrl(frame.url, controlPlaneOrigin)
}

/** The fence-wrapped invoke handler type: `trustedIpc(handler)` returns the listener
 * handed to ipcMain.handle; the handler receives only the invoke args, never the event. */
export type TrustedIpc = (handler: (...args: any[]) => any) => (event: IpcSenderLike, ...args: any[]) => any

/**
 * Build the trustedIpc fence: every ipcMain.handle registration goes through it, so the
 * sender check and the quit gate are enforced once for the whole IPC surface.
 * - sender 校验失败 → throw { code: ipc_sender_forbidden }（不可信 sender / 窗口已销毁）。
 * - quit 在途 → throw { code: app_quitting }（teardown 已开始，late connect/exec/apply
 *   不得向 shutdown 注入新工作）。
 * - 通过 → handler(...args)（事件对象不透传）。sender/quit 谓词可注入。
 */
export function createTrustedIpc(deps: {
  /** Sender validation: the current main window exists, is alive and the event originates from its trusted chamber document. */
  isTrustedSender(event: IpcSenderLike): boolean
  /** Quit-in-progress gate (before-quit/will-quit teardown began). */
  isQuitting(): boolean
}): TrustedIpc {
  return (handler: (...args: any[]) => any) =>
    (event: IpcSenderLike, ...args: any[]): any => {
      if (!deps.isTrustedSender(event)) {
        const error = new Error('forbidden IPC sender') as Error & { code?: string }
        error.code = 'ipc_sender_forbidden'
        throw error
      }
      if (deps.isQuitting()) {
        const error = new Error('app is quitting') as Error & { code?: string }
        error.code = 'app_quitting'
        throw error
      }
      return handler(...args)
    }
}
