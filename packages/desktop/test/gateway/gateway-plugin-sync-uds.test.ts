/**
 * Gateway chamber plugin sync over a POSIX UDS tunnel (design 17 §9.3).
 *
 * The controlled-restart leg used to omit the tunnel dial target: the probe and
 * the upload dialed the UDS listener, while `POST /chamber/runtime/restart` fell
 * back to `127.0.0.1:<remote port>` and could only ever ECONNREFUSED (observed
 * 4× in the shipped 0.4.5-beta.6 log). An uploaded package therefore waited for
 * the next *natural* spawn instead of applying immediately. This file locks the
 * restart onto the same dial target, and keeps a transport-level negative
 * control (without `socketPath` the very first GET cannot reach a UDS-only host,
 * which is exactly why the restart leg must carry it too).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'

import { syncGatewayChamberPlugins } from '../../gateway-provider.ts'

const silentLogger = { log() {}, warn() {} }

/** A UDS HTTP server that answers the three sync legs and records what it saw. */
async function seedServer(socketPath: string, seen: string[]) {
  const server = createServer((req, res) => {
    const key = `${req.method ?? 'GET'} ${req.url ?? '/'}`
    seen.push(key)
    // Drain the body so the request settles on the client's side as well.
    req.resume()
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/chamber/plugins') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ items: [] }))
        return
      }
      if (req.method === 'PUT' && req.url === '/chamber/plugins') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ changed: true }))
        return
      }
      if (req.method === 'POST' && req.url === '/chamber/runtime/restart') {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  server.listen(socketPath)
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server
}

/** A port that was just closed, so a TCP dial fails fast instead of hitting a real host. */
async function closedPort(): Promise<number> {
  const server = createNetServer()
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 9
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

/** sockaddr_un has a 104-byte path budget; os.tmpdir() is /var/folders/<deep>/T on macOS,
 *  so a long mkdtemp prefix would make this test fail with ENAMETOOLONG instead of the
 *  behaviour under test. Short root + an explicit budget assertion. */
function tempSocketDir(): string {
  const dir = mkdtempSync('/tmp/gwuds-')
  assert.ok(Buffer.byteLength(join(dir, 'gw.sock')) < 100, 'UDS path must fit the sockaddr_un budget')
  return dir
}

const packages = [{
  name: '@dsh-chamber/probe-host',
  packageJson: JSON.stringify({ name: '@dsh-chamber/probe-host', version: '1.0.0' }),
  distIndex: 'export {}',
}]

test('gateway plugin sync: the controlled restart rides the same UDS dial target', async () => {
  const dir = tempSocketDir()
  const socketPath = join(dir, 'gw.sock')
  const seen: string[] = []
  const server = await seedServer(socketPath, seen)
  try {
    const result = await syncGatewayChamberPlugins({
      origin: 'http://127.0.0.1:30801',
      headers: {},
      spkiPin: null,
      packages,
      logger: silentLogger,
      timeoutMs: 5_000,
      socketPath,
    })
    assert.equal(result.uploaded, true, 'a changed upload asks for the controlled restart')
    assert.equal(result.failed, undefined)
    assert.ok(seen.includes('PUT /chamber/plugins'), 'the upload leg dialed the UDS listener')
    assert.ok(seen.includes('POST /chamber/runtime/restart'),
      'the restart leg must dial the same UDS listener (missing socketPath → 127.0.0.1 ECONNREFUSED)')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gateway plugin sync: without socketPath a UDS-only gateway is unreachable (negative control)', async () => {
  const dir = tempSocketDir()
  const socketPath = join(dir, 'gw.sock')
  const seen: string[] = []
  const server = await seedServer(socketPath, seen)
  const port = await closedPort()
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${port}`,
      headers: {},
      spkiPin: null,
      packages,
      logger: silentLogger,
      timeoutMs: 2_000,
    })
    assert.equal(result.failed, true)
    assert.equal(result.uploaded, false)
    assert.deepEqual(seen, [], 'no leg may reach the UDS listener without a dial target')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
