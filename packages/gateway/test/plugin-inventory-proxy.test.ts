/**
 * Full-chain unary RPC regression test (design 17 §6 / 05 §5): the
 * `pluginInventory/list` Remote of the MANAGED dsh instance reaches the host
 * through the whole gateway chain — desktop-side per-instance proxy →
 * gateway auth gate + dispatch → gateway single-target proxy (with the
 * spawn-minted 0.1.2 browser-auth cookie) → the managed dsh host.
 *
 * This is the read path the connections-section plugin-inventory view
 * (gateway / http-direct connections) depends on: the desktop control plane
 * strips `/api/i/gateway-<id>` and forwards the unary RPC to the gateway,
 * whose dispatch lets every non-management `/api/*` fall through to the
 * local-dsh proxy. A break in ANY hop (path claim, auth, cookie injection,
 * Host/Origin rewrite) surfaces here as a loud failure — never a silent
 * empty plugin list.
 *
 * Run: node packages/gateway/test/plugin-inventory-proxy.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createControlPlane,
  registerAuthCookie,
} from '@dsh-chamber/control-plane'
import { parseGatewayConfig } from '../src/config.ts'
import { createGatewayStore } from '../src/store.ts'
import { createAuth } from '../src/auth.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'
import { createGatewayProxy } from '../src/gateway-proxy.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'

const TOKEN = '0123456789abcdef0123456789abcdef'
const silentLogger = { log() {}, warn() {}, error() {} }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** Fake managed dsh host: mimics the real host's /api browser-auth gate
 *  (401 without the spawn-minted cookie) plus the Typert unary wire for
 *  `pluginInventory/list` (client-request → server-response envelope). */
function startFakeDsh(port: number): Server {
  const server = createServer((req, res) => {
    const cookie = req.headers.cookie ?? ''
    if (!cookie.includes('browser-auth=ok')) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      let envelope: { rpcId?: string } = {}
      try { envelope = JSON.parse(raw) } catch { /* malformed */ }
      const body = {
        type: 'server-response',
        rpcId: envelope.rpcId ?? 'unknown',
        result: {
          ok: true,
          value: {
            entries: [
              { entryId: 'p1', moduleName: '@deepseek-ai/dsh-demo', enabled: true, fiberPhase: 'active' },
              { entryId: 'p2', moduleName: '@dsh-chamber/dsh-host-client-graph', enabled: true, fiberPhase: 'active' },
            ],
          },
        },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  server.listen(port, '127.0.0.1')
  return server
}

test('pluginInventory/list reaches the managed dsh through the full gateway chain', async () => {
  const dshPort = await freePort()
  const gwPort = await freePort()
  const desktopPort = await freePort()
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-gw-inventory-'))
  const fakeDsh = startFakeDsh(dshPort)
  // The gateway process spawn-mints the browser-auth cookie for its managed
  // dsh origin (spawn-dsh.ts registerAuthCookie) — simulate that here.
  registerAuthCookie(`http://127.0.0.1:${dshPort}`, 'browser-auth=ok')

  // ---- Gateway: real dispatch + proxy + auth, composed like createGateway.
  const config = parseGatewayConfig(
    { host: '127.0.0.1', port: gwPort, apiToken: TOKEN },
    stateDir,
    '/tmp/dsh',
  )
  const store = createGatewayStore(stateDir, silentLogger)
  const auth = createAuth(config.auth, store, silentLogger)
  const policy = createGatewayRequestPolicy(config)
  const proxy = createGatewayProxy({
    logger: silentLogger,
    getLocalDshPort: () => dshPort,
    getLocalState: () => 'ready',
  })
  const surface = {
    async handle(_req: unknown, res: { writeHead(s: number): void; end(b: string): void }) {
      res.writeHead(404); res.end('{}'); return true
    },
  }
  const runtime = {
    async handle(_req: unknown, res: { writeHead(s: number): void; end(b: string): void }) {
      res.writeHead(404); res.end('{}'); return true
    },
  }
  const dispatch = createGatewayDispatch(
    auth,
    () => proxy as never,
    () => surface as never,
    () => runtime as never,
    silentLogger,
    policy,
    null,
  )
  const gatewayPlane = createControlPlane({
    port: gwPort,
    host: '127.0.0.1',
    stateDir: join(stateDir, 'plane'),
    dshWorkspacePath: '/tmp/dsh',
    logger: silentLogger,
    middleware: dispatch.middleware,
    upgradeMiddleware: dispatch.upgradeMiddleware,
  })
  await gatewayPlane.start()

  // ---- Desktop-side control plane with the gateway transport registered.
  const desktopPlane = createControlPlane({
    port: desktopPort,
    host: '127.0.0.1',
    stateDir: join(stateDir, 'desktop-plane'),
    dshWorkspacePath: '/tmp/dsh',
    logger: silentLogger,
  })
  desktopPlane.registerInstanceTransport(
    'gateway:west',
    `http://127.0.0.1:${gwPort}`,
    { authorization: `Bearer ${TOKEN}` },
    { transport: 'http' },
  )
  await desktopPlane.start()

  try {
    const rpcId = 'e2e-rpc-1'
    const response = await fetch(
      `http://127.0.0.1:${desktopPort}/api/i/gateway-west/api/pluginInventory/list`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: 'pluginInventory/list',
          payload: { args: {} },
        }),
      },
    )
    const text = await response.text()
    assert.equal(response.status, 200, `status ${response.status}: ${text}`)
    const parsed = JSON.parse(text)
    assert.equal(parsed.type, 'server-response')
    assert.equal(parsed.rpcId, rpcId)
    assert.equal(parsed.result?.ok, true)
    assert.equal(parsed.result?.value?.entries?.length, 2)
  } finally {
    await desktopPlane.stop()
    await gatewayPlane.stop()
    await new Promise<void>(resolve => fakeDsh.close(() => resolve()))
    store.close()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
