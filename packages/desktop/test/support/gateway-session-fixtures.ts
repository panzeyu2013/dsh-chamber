/**
 * Shared gateway-session fixtures: the JWT/cookie/password constants, the
 * module-scope origin scope counter, the login record/handler, the real
 * loopback gateway stub, the fake request factories and the failure-result
 * assertion helper. Bare helper file — not a test.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GATEWAY_SESSION_COOKIE_NAME, type GatewayHttpRequest, type GatewaySessionManager, type GatewaySessionOrigin, type GatewaySessionResult } from '../../gateway-session.ts'
import { configureGatewaySessionProvider } from '../../gateway-provider.ts'

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZXNzaW9uIn0.signature'
export const COOKIE = `${GATEWAY_SESSION_COOKIE_NAME}=${JWT}`
export const PASSWORD = 'correct horse battery staple'
let gatewayScopeSequence = 0

export interface LoginRecord {
  path: string
  body: string
  headers: IncomingMessage['headers']
}

/** A gateway stub answering `POST /auth/login` with a 3xx + set-cookie (the
 * default happy path), recording every login. */
export function loginHandler(logins: LoginRecord[], status = 302, setCookie: string[] | null = [`${COOKIE}; HttpOnly; Path=/; Max-Age=43200; SameSite=Strict`]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      logins.push({ path: req.url ?? '', body, headers: req.headers })
      res.writeHead(status, setCookie !== null ? { 'set-cookie': setCookie } : {})
      res.end()
    })
  }
}

/** Start a real node:http gateway stub on an ephemeral loopback port. The
 * origin uses `insecureHttp: true` so the module speaks plain http (no TLS
 * fixture needed). */
export async function startGateway(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ origin: GatewaySessionOrigin; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    origin: { baseUrl: `http://127.0.0.1:${port}`, insecureHttp: true, scope: `test:gateway:${gatewayScopeSequence += 1}` },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

/** A fake request factory (`typeof node:http request` shape) for the cases a
 * real socket cannot reach deterministically: https-scheme URL inspection
 * and network errors. */
export function stubRequestFactory(opts: { seenUrl?: (url: unknown) => void; status?: number; setCookie?: string[] | null; networkError?: boolean } = {}): GatewayHttpRequest {
  const { seenUrl, status = 302, setCookie = [COOKIE], networkError = false } = opts
  interface StubClientRequest {
    on(event: string, listener: (...args: unknown[]) => void): unknown
    emit(event: string, ...args: unknown[]): boolean
    end(): void
    destroy(): void
  }
  interface StubIncomingMessage {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    resume(): StubIncomingMessage
    on(event: string, listener: (...args: unknown[]) => void): unknown
  }
  const factory = ((url: unknown, _options: unknown, cb: (res: StubIncomingMessage) => void) => {
    seenUrl?.(url)
    const req = new EventEmitter() as unknown as StubClientRequest
    req.end = () => {}
    req.destroy = () => {}
    if (networkError) {
      setImmediate(() => req.emit('error', new Error('ECONNREFUSED')))
    } else {
      setImmediate(() => {
        const res = new EventEmitter() as unknown as StubIncomingMessage
        res.statusCode = status
        res.headers = setCookie !== null ? { 'set-cookie': setCookie } : {}
        res.resume = () => res
        cb(res)
      })
    }
    return req
  }) as unknown as GatewayHttpRequest
  return factory
}

type FailureCode = Extract<GatewaySessionResult, { ok: false }>['code']

export function assertFailure(result: GatewaySessionResult, code: FailureCode): asserts result is Extract<GatewaySessionResult, { ok: false }> {
  assert.equal(result.ok, false, 'expected a failure result')
  assert.equal((result as { code: string }).code, code)
}

/** Bind a real session manager into the gateway provider's injectable seam and
 * hand back the reset that must run in the test's finally block. */
export function bindSessionManager(mgr: GatewaySessionManager): () => void {
  configureGatewaySessionProvider({
    ensureSession: (target, password) => mgr.ensureSession(target, password),
    generation: target => mgr.generation(target),
    registrationAuthProof: target => mgr.registrationAuthProof(target),
    setRegistrationAuthProof: (target, proof) => mgr.setRegistrationAuthProof(target, proof),
    cachedCookie: target => mgr.cachedCookie(target),
    invalidate: target => mgr.invalidate(target),
  })
  return () => configureGatewaySessionProvider({})
}
