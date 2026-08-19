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
