/**
 * Shared gateway test fakes — the canonical stand-ins for Node's
 * IncomingMessage / ServerResponse used by the dispatch-harness tests
 * (audit.test.ts, dispatch-composition.test.ts, runtime-routes.test.ts,
 * feature-lifecycle.test.ts, mobile-ua-redirect.test.ts). Single source of
 * truth for the request/response surface the gateway middleware drives; do
 * not re-declare these locally.
 *
 * Body bytes are always emitted manually by the caller (`req.emit('data'|'end',
 * ...)`) — the paused-mode buffer replays bytes emitted before a 'data'
 * listener attaches (mirrors Node's paused-mode IncomingMessage; the dispatch
 * middleware awaits auth before readBody()). A request whose body is never
 * emitted therefore never completes, which some tests rely on (quiescence
 * drain). For timer-driven auto-emission see the runtime-routes harness,
 * which emits right after starting the route handler.
 */
import { EventEmitter } from 'node:events'

export class FakeRequest extends EventEmitter {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  readonly socket: { remoteAddress: string; encrypted?: boolean }
  destroyed = false

  private pendingBody: Array<{ type: 'data'; chunk: Buffer } | { type: 'end' }> = []

  constructor(
    method = 'GET',
    url = '/',
    headers: Record<string, string | string[] | undefined> = {},
    remoteAddress = '203.0.113.8',
  ) {
    super()
    this.method = method
    this.url = url
    this.headers = headers
    this.socket = { remoteAddress }
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener)
    if (event === 'data') {
      for (const entry of this.pendingBody) {
        if (entry.type === 'data') super.emit('data', entry.chunk)
      }
      this.pendingBody = this.pendingBody.filter(entry => entry.type !== 'data')
    }
    if (event === 'end') {
      const endIndex = this.pendingBody.findIndex(entry => entry.type === 'end')
      if (endIndex !== -1) {
        this.pendingBody.splice(endIndex, 1)
        super.emit('end')
      }
    }
    return this
  }

  override emit(event: string | symbol, ...args: any[]): boolean {
    if ((event === 'data' || event === 'end') && this.listenerCount('data') === 0) {
      this.pendingBody.push(event === 'data' ? { type: 'data', chunk: args[0] as Buffer } : { type: 'end' })
      return true
    }
    return super.emit(event, ...args)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('aborted')
    this.emit('close')
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {}
}

export class FakeResponse extends EventEmitter {
  status = 0
  statusCode = 200
  headersSent = false
  headers: Record<string, string> = {}
  body = ''
  chunks: string[] = []
  endCalls = 0
  destroyed = false
  _corsHeaders?: Record<string, string>

  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  writeHead(status: number, headers: Record<string, string> = {}): this {
    this.status = status
    this.statusCode = status
    this.headersSent = true
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
    return this
  }

  write(chunk: unknown): boolean {
    const text = String(chunk)
    this.body += text
    this.chunks.push(text)
    return true
  }

  end(chunk?: unknown): void {
    if (chunk !== undefined) {
      const text = String(chunk)
      this.body += text
      this.chunks.push(text)
    }
    this.endCalls += 1
    this.emit('finish')
  }

  destroy(): void {
    this.destroyed = true
  }

  json(): any {
    return JSON.parse(this.chunks.join(''))
  }
}
