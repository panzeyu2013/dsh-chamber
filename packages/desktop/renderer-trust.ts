/** Pure trust predicates shared by Electron main and its unit tests. */

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
 * Only the fixed chamber shell document is privileged. The control-plane
 * origin also serves untrusted instance responses under /api/i/<id>/*; origin
 * equality alone would let a proxied remote HTML document inherit preload.
 */
export function isTrustedRendererUrl(url: string, controlPlaneOrigin: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(controlPlaneOrigin)
    return (expected.protocol === 'http:' || expected.protocol === 'https:')
      && actual.origin === expected.origin
      && actual.pathname === '/'
      && actual.search === ''
  } catch {
    return false
  }
}

/**
 * IPC is accepted only from the current main window's main frame and fixed
 * chamber shell document. Checking the origin alone is insufficient: a child,
 * stale WebContents, or /api/i/* remote document could otherwise reuse it.
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

/**
 * The fence-wrapped invoke handler type: `trustedIpc(handler)` returns the
 * listener passed to ipcMain.handle. The handler receives only the invoke
 * args (never the event) — mirrors the pre-split main.ts contract.
 */
export type TrustedIpc = (handler: (...args: any[]) => any) => (event: IpcSenderLike, ...args: any[]) => any

/**
 * Build the trustedIpc fence (previously inlined in main.ts): every
 * ipcMain.handle registration goes through it, so the sender check and the
 * quit gate are enforced once for the whole IPC surface.
 *
 * Semantics (unchanged from main.ts):
 * - sender 校验失败 → throw { code: 'ipc_sender_forbidden' }（不可信 sender /
 *   窗口已销毁 / 非 chamber 文档）。
 * - quit 在途 → throw { code: 'app_quitting' }（传输层/控制面 teardown 已开始，
 *   late connect/exec/apply 不得向 shutdown 注入新工作）。
 * - 通过 → handler(...args)（事件对象不透传）。
 *
 * Injectable sender/quit predicates keep this electron-free and unit-testable
 * (renderer-trust.test.ts).
 */
export function createTrustedIpc(deps: {
  /** Sender validation: the current main window exists, is alive and the
   *  event originates from its trusted chamber document. */
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
