/** One real-socket proof that the gateway evaluator threads through the
 * control-plane shell; the rest of the boundary matrix stays no-listen. */

import { request as httpRequest } from 'node:http'
import { createConnection } from 'node:net'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createControlPlane } from '@dsh-chamber/control-plane'
import type { AuthProvider } from '../src/auth.ts'
import { parseGatewayConfig } from '../src/config.ts'
import { createGatewayDispatch } from '../src/dispatch.ts'
import { createGatewayRequestPolicy } from '../src/middleware.ts'

const silentLogger = { log() {}, warn() {}, error() {} }
const TOKEN = '0123456789abcdef0123456789abcdef'

test('anonymous control-plane cannot opt into a network bind with only a permissive CORS callback', () => {
  assert.throws(() => createControlPlane({
    host: '0.0.0.0',
    corsEvaluator: () => ({ allowed: true }),
  }), /HTTP\/upgrade middleware/)
})

function get(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: path === '/chamber/settings' ? 'OPTIONS' : 'GET', headers }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

function rawRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = ''
    let settled = false
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(payload))
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve(response)
    }
    socket.setTimeout(5_000, () => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(new Error('raw gateway request timed out'))
    })
    socket.on('data', chunk => { response += chunk.toString('utf8') })
    socket.on('end', finish)
    socket.on('close', hadError => { if (!hadError) finish() })
    socket.on('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

test('public Host health/preflight pass while an unknown authority is rejected', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'gateway-public-http-'))
  const config = parseGatewayConfig({
    host: '0.0.0.0',
    port: 3000,
    apiToken: TOKEN,
    publicOrigin: 'http://gateway.example:3000',
    corsOrigins: ['capacitor://localhost'],
  }, stateDir, '/tmp/dsh')
  const policy = createGatewayRequestPolicy(config)
  const auth: AuthProvider = {
    kind: 'token',
    async verify(req) { return req.headers.authorization === 'Bearer secret' ? { kind: 'token', id: 'test', issuedAt: 0 } : null },
  }
  const proxy = { async handleHttp() {}, async handleUpgrade() {}, getDiagnostics() { return { requests: 0, failures: 0, activeStreams: 0, activeHttpRequests: 0, pendingUpgrades: 0, bufferedRequestBytes: 0 } }, closeAllStreams() {} }
  const features = { async handle() { return true }, start() {}, stop() {} }
  const dispatch = createGatewayDispatch(auth, () => proxy, () => features, () => ({ async handle() { return false } }), silentLogger, policy)
  const plane = createControlPlane({
    host: '0.0.0.0',
    port: 0,
    stateDir,
    dshWorkspacePath: '/tmp/dsh',
    logger: silentLogger,
    corsEvaluator: policy.corsEvaluator,
    middleware: dispatch.middleware,
    upgradeMiddleware: dispatch.upgradeMiddleware,
  })
  try {
    await plane.start()
    const health = await get(plane.port!, '/health', {
      host: 'gateway.example:3000',
      origin: 'http://gateway.example:3000',
    })
    assert.equal(health.status, 200)
    assert.equal(health.headers['access-control-allow-origin'], 'http://gateway.example:3000')

    const rejected = await get(plane.port!, '/health', { host: 'attacker.example' })
    assert.equal(rejected.status, 421)

    const invalidTarget = await get(plane.port!, '//attacker.example/health', {
      host: 'gateway.example:3000',
    })
    assert.equal(invalidTarget.status, 400)

    const backslashTarget = await get(plane.port!, '/\\\\attacker.example/health', {
      host: 'gateway.example:3000',
    })
    assert.equal(backslashTarget.status, 400)

    const preflight = await get(plane.port!, '/chamber/settings', {
      host: 'gateway.example:3000',
      origin: 'capacitor://localhost',
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization, content-type',
    })
    assert.equal(preflight.status, 204)
    assert.match(String(preflight.headers['access-control-allow-headers']), /authorization/)

    // Use literal duplicate field lines rather than node:http's normalized
    // header object: Node keeps a single Authorization value, so only the
    // shared raw request policy can prevent first-value masking.
    const duplicateHttp = await rawRequest(plane.port!, [
      'GET /health HTTP/1.1',
      'Host: gateway.example:3000',
      'Authorization: Bearer secret',
      'Authorization: Bearer attacker-controlled-second-value',
      'Connection: close',
      '',
      '',
    ].join('\r\n'))
    assert.match(duplicateHttp, /^HTTP\/1\.1 400 Bad Request/)
    assert.match(duplicateHttp, /"code":"bad_request"/)

    const duplicateWs = await rawRequest(plane.port!, [
      'GET /api/i/missing/api/remote.mux HTTP/1.1',
      'Host: gateway.example:3000',
      'Origin: http://gateway.example:3000',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Authorization: Bearer secret',
      'Authorization: Bearer attacker-controlled-second-value',
      '',
      '',
    ].join('\r\n'))
    assert.match(duplicateWs, /^HTTP\/1\.1 400 Bad Request/)
    assert.match(duplicateWs, /"code":"bad_request"/)
  } finally {
    await plane.stop()
    rmSync(stateDir, { recursive: true, force: true })
  }
})
