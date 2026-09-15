/**
 * Shared no-listen harness for the split boundary dispatch suites: dispatch
 * composition, temp-store auth and the HTTP runner over FakeRequest/FakeResponse.
 * Extracted verbatim from dispatch-composition.test.ts.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createAuth, type AuthProvider } from '../../src/auth.ts'
import { parseGatewayConfig } from '../../src/config.ts'
import { createGatewayDispatch } from '../../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../../src/middleware.ts'
import { createGatewayStore, type GatewayStore } from '../../src/store.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

export const silentLogger = { log() {}, warn() {}, error() {} }
export const PASSWORD = 'correct-horse-battery'
export const NEW_PASSWORD = 'a-new-correct-password'
export const TOKEN = '0123456789abcdef0123456789abcdef'

export function setup(
  auth: AuthProvider,
  runtime: () => { handle(req: unknown, res: FakeResponse, pathname: string): Promise<boolean> } = () => ({ async handle() { return false } }),
  auditFile?: string,
  surface?: () => { handle(req: unknown, res: FakeResponse, pathname: string): Promise<boolean> },
) {
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    uiPassword: 'correct-horse-battery',
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost'],
  }, '/tmp/gateway-dispatch-state', '/tmp/dsh')
  const policy = createGatewayRequestPolicy(config)
  let httpProxyCalls = 0
  let upgradeProxyCalls = 0
  const proxy = {
    async handleHttp(_req: unknown, res: FakeResponse) { httpProxyCalls += 1; res.writeHead(200); res.end('proxied') },
    async handleUpgrade() { upgradeProxyCalls += 1 },
    closeAllStreams() {},
  }
  const features = surface !== undefined ? surface() : {
    async handle(_req: unknown, res: FakeResponse) { res.writeHead(200); res.end('feature'); return true },
    start() {},
    stop() {},
  }
  const dispatch = createGatewayDispatch(auth, () => proxy as never, () => features as never, runtime as never, silentLogger, policy, auditFile)
  return { dispatch, get httpProxyCalls() { return httpProxyCalls }, get upgradeProxyCalls() { return upgradeProxyCalls } }
}

/** Real-store auth facade on a temp stateDir (with an optional audit file). */
export function realAuth(options: {
  config: Parameters<typeof createAuth>[0]
  auditFile?: boolean
  deps?: Parameters<typeof createAuth>[3]
}): {
  auth: AuthProvider
  store: GatewayStore
  dir: string
  auditFile: string
  cleanup(): void
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-dispatch-'))
  const store = createGatewayStore(dir, silentLogger)
  const auth = createAuth(options.config, store, silentLogger, options.deps)
  const auditFile = join(dir, 'audit.log')
  return {
    auth,
    store,
    dir,
    auditFile: options.auditFile === false ? '' : auditFile,
    cleanup() {
      store.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export function readAudit(file: string): Array<Record<string, string>> {
  return readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, string>)
}

export async function runHttp(
  dispatch: ReturnType<typeof setup>['dispatch'],
  req: FakeRequest,
  body?: string,
  ctx: Parameters<ReturnType<typeof setup>['dispatch']['middleware']>[3] = {} as never,
): Promise<FakeResponse> {
  const res = new FakeResponse()
  const pending = dispatch.middleware(
    req as unknown as ApiRequest,
    res as unknown as ApiResponse,
    new URL(req.url, 'http://localhost'),
    ctx,
  )
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  await pending
  return res
}
