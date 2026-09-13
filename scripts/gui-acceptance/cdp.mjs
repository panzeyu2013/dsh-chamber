/**
 * Minimal Chrome DevTools Protocol client for the GUI acceptance toolbox.
 *
 * ZERO DEPENDENCIES: Node's built-in `fetch` (target discovery) and global
 * `WebSocket` (the protocol carrier, stable since Node 22) — no `ws` import
 * through another package's node_modules, no new runtime dependency.
 *
 * Scope is deliberately small: discover a page target, evaluate expressions,
 * capture screenshots, send real key events, reload, and collect console /
 * network facts. Anything richer belongs in the test page itself.
 */

/** Discover the page target served by a dev instance's CDP port. */
export async function discoverPageTarget(cdpPort, { urlPattern = /^http:\/\/127\.0\.0\.1:\d+\//, timeoutMs = 90_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = 'no /json/list answer yet'
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find(target => target.type === 'page' && urlPattern.test(target.url ?? ''))
      if (page !== undefined) return page
      last = list.map(target => `${target.type}:${target.url}`).join(', ') || 'no targets'
    } catch (error) {
      last = String(error?.message ?? error)
    }
    await new Promise(resolve => setTimeout(resolve, 700))
  }
  throw new Error(`no CDP page target on port ${cdpPort} within ${timeoutMs}ms (last: ${last})`)
}

/** One CDP session over the built-in WebSocket. */
export class CdpSession {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Set()
  /** Facts observed on the page: console errors/warnings + non-2xx responses. */
  consoleErrors = []
  consoleWarnings = []
  netFailures = new Map()
  #requestUrls = new Map()
  #collectFrom = 0

  static async connect(webSocketDebuggerUrl) {
    const session = new CdpSession()
    const socket = new WebSocket(webSocketDebuggerUrl)
    session.#socket = socket
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', () => resolve(undefined), { once: true })
      socket.addEventListener('error', event => reject(new Error(`CDP socket error: ${String(event?.message ?? 'unknown')}`)), { once: true })
    })
    socket.addEventListener('message', event => session.#onMessage(event.data))
    return session
  }

  #onMessage(raw) {
    let message
    try { message = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      this.#pending.delete(message.id)
      if (message.error !== undefined) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
      return
    }
    this.#record(message)
    for (const listener of this.#listeners) listener(message)
  }

  #record(message) {
    const after = timestamp => timestamp === undefined || timestamp >= this.#collectFrom
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type) && after(message.params.timestamp)) {
      const text = message.params.args.map(argument => argument.value ?? argument.description ?? argument.type).join(' ')
      ;(message.params.type === 'error' ? this.consoleErrors : this.consoleWarnings).push(text)
    }
    if (message.method === 'Runtime.exceptionThrown' && after(message.params.timestamp)) {
      this.consoleErrors.push(message.params.exceptionDetails?.exception?.description ?? 'uncaught exception')
    }
    if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry
      if (!after(entry.timestamp) || !['error', 'warning'].includes(entry.level)) return
      ;(entry.level === 'error' ? this.consoleErrors : this.consoleWarnings).push(`${entry.source}: ${entry.text}`)
    }
    if (message.method === 'Network.requestWillBeSent') this.#requestUrls.set(message.params.requestId, message.params.request.url)
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      this.#count(`${message.params.response.status} ${message.params.response.url}`)
    }
    if (message.method === 'Network.loadingFailed') {
      const url = this.#requestUrls.get(message.params.requestId) ?? '(unknown)'
      this.#count(`FAILED(${message.params.errorText}) ${url}`)
    }
  }

  #count(key) { this.netFailures.set(key, (this.netFailures.get(key) ?? 0) + 1) }

  /** Enable the domains the acceptance run observes. */
  async enableObservation() {
    await this.send('Runtime.enable')
    await this.send('Log.enable')
    await this.send('Page.enable')
    await this.send('Network.enable')
  }

  /** Drop facts recorded so far and start observing from now (reload-safe). */
  beginObservationWindow() {
    this.#collectFrom = Date.now()
    this.consoleErrors.length = 0
    this.consoleWarnings.length = 0
    this.netFailures.clear()
    this.#requestUrls.clear()
  }

  onMessage(listener) { this.#listeners.add(listener) }

  send(method, params = {}, { timeoutMs = 30_000 } = {}) {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#socket.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP timeout: ${method}`))
      }, timeoutMs)
    })
  }

  /** Evaluate in the page; throws on a page-side exception. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result?.value
  }

  /** Poll an expression until it is truthy. */
  async waitFor(expression, label, { timeoutMs = 25_000, pollMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { if (await this.evaluate(expression)) return true } catch { /* keep polling */ }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    throw new Error(`waitFor timed out: ${label}`)
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }

  /**
   * A real pointer move (not a synthetic DOM event): hover surfaces only react
   * to input the browser's own hit-testing produced.
   * @param x - viewport x in CSS pixels.
   * @param y - viewport y in CSS pixels.
   */
  async moveMouse(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' })
  }

  /** A real key event (not a synthetic DOM event) — the Escape path needs one. */
  async pressKey(key, code, virtualKeyCode) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode })
    }
  }

  async reload() { await this.send('Page.reload') }

  close() { try { this.#socket.close() } catch { /* already gone */ } }
}
