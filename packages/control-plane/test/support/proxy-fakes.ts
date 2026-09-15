/**
 * Shared fakes for the split instance-proxy suite (test/proxy/): the quiet
 * logger + gateway credential, the fake outbound/incoming HTTP legs and
 * upgrade sockets, the default local-instance proxy factory and sleep().
 */

import { EventEmitter } from 'node:events'
import { createInstanceProxy } from '../../src/instance-proxy.ts'
import { DEFAULT_DSH_START_PORT } from '../../src/spawn-dsh.ts'
import type { ProxyRequest, ProxyResponse, ProxySocket } from '../../src/instance-proxy.ts'

export const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

export const GATEWAY_AUTHORIZATION = `Bearer ${'t'.repeat(32)}`

/** A fake outbound http.request: records every call and plays behaviors. */
export interface UpstreamBehavior {
  response?: { status: number; headers: Record<string, string>; body?: string | null }
  upgrade?: { status: number; headers: Record<string, string>; head?: Buffer }
  error?: Error
}

interface UpstreamCall {
  url: URL
  options: Record<string, unknown>
  body: Buffer[]
}

export function fakeHttpRequest(handler: (url: URL, options: any) => UpstreamBehavior | undefined) {
  const calls: UpstreamCall[] = []
  const fn: any = (url: URL, options: any) => {
    const call: UpstreamCall = { url, options, body: [] }
    calls.push(call)
    const req = new EventEmitter() as any
    req.write = (chunk: Buffer) => {
      call.body.push(Buffer.from(chunk))
      return true
    }
    req.end = () => {
      req.emit('finish')
      const behavior = handler(url, options)
      if (behavior === undefined) return // hang
      if (behavior.error !== undefined) {
        // Synchronous emission: the proxy registers its handlers before
        // end(), so the verdict lands before handleHttp resolves.
        req.emit('error', behavior.error)
        return
      }
      if (behavior.upgrade !== undefined) {
        const upstreamRes = new EventEmitter() as any
        upstreamRes.statusCode = behavior.upgrade.status
        upstreamRes.headers = behavior.upgrade.headers
        const upstreamSocket = new EventEmitter() as any
        upstreamSocket.write = () => true
        upstreamSocket.pipe = (target: unknown) => target
        upstreamSocket.destroy = () => {}
        // S2: NON-loopback (direct-http) splices arm OS-level TCP keepalive
        // on the upstream leg — real node sockets carry net.Socket.setKeepAlive;
        // record the configuration here so wiring tests can assert it.
        upstreamSocket.keepAliveCalls = []
        upstreamSocket.setKeepAlive = (enable: boolean, delay?: number) => {
          upstreamSocket.keepAliveCalls.push({ enable, delay })
        }
        req.emit('upgrade', upstreamRes, upstreamSocket, behavior.upgrade.head ?? Buffer.alloc(0))
        return
      }
      if (behavior.response !== undefined) {
        const res = new EventEmitter() as any
        res.statusCode = behavior.response.status
        res.headers = behavior.response.headers
        res.destroy = () => res.emit('close')
        req.emit('response', res)
        if (typeof behavior.response.body === 'string') {
          res.emit('data', Buffer.from(behavior.response.body))
          res.emit('end')
        }
        return
      }
    }
    const signal: AbortSignal | undefined = options?.signal
    if (signal !== undefined) {
      if (signal.aborted) process.nextTick(() => req.emit('error', new Error('Aborted')))
      else signal.addEventListener('abort', () => req.emit('error', new Error('Aborted')), { once: true })
    }
    return req
  }
  return { fn, calls }
}

export function fakeRequest(url: string, method = 'GET', headers: Record<string, string> = {}, body?: string): ProxyRequest {
  const emitter = new EventEmitter()
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return Object.assign(emitter, {
    url,
    method,
    headers,
    async * [Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }) as unknown as ProxyRequest
}

export function fakeResponse(): ProxyResponse & { status: number | null; headers: Record<string, unknown>; body: string; destroyed: boolean } {
  const emitter = new EventEmitter()
  const res = Object.assign(emitter, {
    status: null as number | null,
    headers: {} as Record<string, unknown>,
    body: '',
    destroyed: false,
    headersSent: false,
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.status = status
      this.headers = { ...(headers ?? {}) }
      this.headersSent = true
      return undefined
    },
    write(chunk: unknown) {
      this.body += String(chunk)
      return true
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body += String(payload)
      emitter.emit('finish')
      return undefined
    },
    setHeader() {},
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      emitter.emit('close')
    },
  })
  return res as any
}

export function fakeSocket(): ProxySocket & { written: string; writtenBuffers: Buffer[]; closed: boolean } {
  const emitter = new EventEmitter()
  const socket = Object.assign(emitter, {
    written: '',
    writtenBuffers: [] as Buffer[],
    closed: false,
    write(data: unknown) {
      this.written += String(data)
      this.writtenBuffers.push(Buffer.from(data as Buffer))
      return true
    },
    end() { this.closed = true; return undefined },
    destroy() {
      if (this.closed) return
      this.closed = true
      emitter.emit('close')
    },
    pipe(target: unknown) { return target },
  })
  return socket as any
}

export function makeProxy(options: { state?: string; port?: number | null } = {}) {
  const { state = 'ready', port = DEFAULT_DSH_START_PORT } = options
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' },
  }))
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => state,
    getLocalDshPort: () => port,
    httpRequest: upstream.fn,
  })
  return { proxy, upstream }
}

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
