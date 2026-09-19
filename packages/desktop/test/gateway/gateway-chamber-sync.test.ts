/** gateway provider — part 3: syncGatewayChamberPlugins — the desktop→gateway chamber host package
 *  upload (changed-package PUT, idempotence, controlled restart, tunnel authority, pre-PUT SPKI
 *  check) (siblings: gateway-provider / gateway-session-spki / gateway-chamber-apply-materialize). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { syncGatewayChamberPlugins } from '../../gateway-provider.ts'
import type { LocalChamberHostPackage } from '../../gateway-provider.ts'
import { CERT_A, KEY_A, PIN_B } from '../support/gateway-tls-fixtures.ts'
import { startHttpsProbeServer, startSyncHttpServer } from '../support/gateway-test-servers.ts'

// ---------------------------------------------------------------------------
// Desktop-synced chamber host packages (design 17 §9.3, 2026-12 Phase 3)
// ---------------------------------------------------------------------------

const GRAPH_PACKAGE: LocalChamberHostPackage = {
  name: '@dsh-chamber/dsh-chamber-seed-client-graph',
  packageJson: JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.2.3' }),
  distIndex: 'export const graph = 1\n',
}
const GIT_PACKAGE: LocalChamberHostPackage = {
  name: '@dsh-chamber/dsh-chamber-seed-git-worktree',
  packageJson: JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-git-worktree', version: '2.0.0' }),
  distIndex: 'export const git = 1\n',
}
// The third chamber host package (design 24): the desktop uploads all three
// rows into the gateway seed cache (main.ts localChamberHostPackageSources).
const ARCHIVE_PACKAGE: LocalChamberHostPackage = {
  name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup',
  packageJson: JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup', version: '3.0.0' }),
  distIndex: 'export const archive = 1\n',
}

function syncLog(): { warns: string[]; logs: string[]; logger: { warn(m: string): void; log(m: string): void } } {
  const warns: string[] = []
  const logs: string[] = []
  return {
    warns,
    logs,
    logger: { warn: (message: string) => warns.push(message), log: (message: string) => logs.push(message) },
  }
}


test('syncGatewayChamberPlugins: happy path uploads only the changed package and requests the controlled restart', async () => {
  const seen: Array<{ method: string; url: string; body?: unknown }> = []
  const server = await startSyncHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', ...(body === '' ? {} : { body: JSON.parse(body) }) })
      if (req.url === '/chamber/plugins' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          items: [
            { name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0' },
            { name: '@dsh-chamber/dsh-chamber-seed-git-worktree', version: '2.0.0' },
            { name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup', version: '3.0.0' },
          ],
        }))
        return
      }
      if (req.url === '/chamber/plugins' && req.method === 'PUT') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, changed: true }))
        return
      }
      if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
        res.writeHead(202)
        res.end()
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  try {
    const { warns, logs, logger } = syncLog()
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      // All three chamber host packages ride the sync; only the
      // version-mismatched graph package uploads (git/archive already match
      // the cache projection).
      packages: [GRAPH_PACKAGE, GIT_PACKAGE, ARCHIVE_PACKAGE],
      logger,
    })
    assert.equal(result.uploaded, true)
    assert.equal(result.skipped, false)
    assert.deepEqual(seen.map(entry => `${entry.method} ${entry.url}`), [
      'GET /chamber/plugins',
      'PUT /chamber/plugins',
      'POST /chamber/runtime/restart',
    ])
    assert.equal(seen.filter(entry => entry.method === 'PUT').length, 1,
      'the two version-matching packages must not upload')
    // Only the version-mismatched package is uploaded, with the exact body.
    const put = seen.find(entry => entry.method === 'PUT')
    assert.ok(put !== undefined)
    assert.equal((put.body as { name: string }).name, '@dsh-chamber/dsh-chamber-seed-client-graph')
    assert.deepEqual((put.body as { files: Record<string, string> }).files, {
      'package.json': GRAPH_PACKAGE.packageJson,
      'dist/index.js': GRAPH_PACKAGE.distIndex,
    })
    assert.deepEqual(warns, [])
    assert.ok(logs.some(line => line.includes('uploaded @dsh-chamber/dsh-chamber-seed-client-graph')))
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: version-identical packages skip the upload (idempotent)', async () => {
  const requests: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      items: [
        { name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.2.3' },
        { name: '@dsh-chamber/dsh-chamber-seed-git-worktree', version: '2.0.0' },
        { name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup', version: '3.0.0' },
      ],
    }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      // The full three-package upload list stays quiet when every local
      // version matches the gateway projection (archive-cleanup included).
      packages: [GRAPH_PACKAGE, GIT_PACKAGE, ARCHIVE_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, false)
    assert.equal(result.skipped, false)
    assert.deepEqual(requests, ['GET /chamber/plugins'])
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: a byte-identical PUT answer (changed:false) asks no restart', async () => {
  const requests: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    requests.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [{ name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0' }] }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, changed: false }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, false, 'a byte-identical upload must not trigger the controlled restart')
    assert.deepEqual(requests, ['GET /chamber/plugins', 'PUT /chamber/plugins'])
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: a --no-auth gateway (empty headers) still receives the sync', async () => {
  const seenAuth: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? '(none)')
    if (req.method === 'PUT') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, changed: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [] }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: {},
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, true, 'a headerless --no-auth deployment must still receive the sync')
    assert.deepEqual(seenAuth, ['(none)', '(none)', '(none)'], 'no Authorization header is invented for the headerless shape')
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: an ssh-tunnel origin presents the remote authority as the Host header', async () => {
  const seenHosts: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    seenHosts.push(req.headers.host ?? '(none)')
    if (req.method === 'PUT') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, changed: true }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [] }))
  })
  try {
    await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      authority: 'gateway.example:443',
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: syncLog().logger,
    })
    assert.deepEqual(seenHosts, ['gateway.example:443', 'gateway.example:443', 'gateway.example:443'])
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: non-2xx answers and a down gateway resolve with a warn, never reject', async () => {
  const authServer = await startSyncHttpServer((_req, res) => {
    res.writeHead(401)
    res.end()
  })
  try {
    const first = syncLog()
    const denied = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${authServer.port}`,
      headers: { authorization: 'Bearer bad' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: first.logger,
    })
    assert.equal(denied.uploaded, false)
    assert.equal(denied.skipped, false)
    // Honesty marker (design 21 review P2-B1): a refused projection is a
    // FAILURE, never the both-false "already up to date" tuple.
    assert.equal(denied.failed, true)
    assert.ok((denied.error ?? '').includes('401'), 'the failure carries the status detail')
    assert.ok(first.warns.some(line => line.includes('HTTP 401')), 'a refused projection warns with the status')
  } finally {
    await authServer.close()
  }

  // Gateway down: the connect error is contained — resolves, never rejects.
  const closed = await startSyncHttpServer((_req, res) => { res.writeHead(200); res.end() })
  const deadPort = closed.port
  await closed.close()
  const second = syncLog()
  const result = await syncGatewayChamberPlugins({
    origin: `http://127.0.0.1:${deadPort}`,
    headers: { authorization: 'Bearer test-token' },
    spkiPin: null,
    packages: [GRAPH_PACKAGE],
    logger: second.logger,
    timeoutMs: 500,
  })
  assert.equal(result.uploaded, false)
  assert.equal(result.skipped, false)
  assert.equal(result.failed, true, 'a down gateway is an explicit failure, never both-false success')
  assert.ok((result.error ?? '').length > 0, 'the failure carries a sanitized detail')
  assert.ok(second.warns.length > 0, 'a down gateway warns and resolves')
})

test('syncGatewayChamberPlugins: an SPKI-pinned https gateway is checked before any application bytes', async () => {
  let receivedRequests = 0
  const server = await startHttpsProbeServer(KEY_A, CERT_A, (_req, res) => {
    receivedRequests += 1
    res.writeHead(200)
    res.end('{}')
  })
  try {
    const { warns, logger } = syncLog()
    const result = await syncGatewayChamberPlugins({
      origin: `https://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: PIN_B,
      packages: [GRAPH_PACKAGE],
      logger,
    })
    assert.equal(result.uploaded, false)
    assert.equal(receivedRequests, 0, 'a wrong-key peer receives zero application bytes')
    assert.equal(result.failed, true, 'an SPKI-refused sync is an explicit failure')
    assert.ok(warns.length > 0, 'the pin mismatch warns and resolves')
  } finally {
    await server.close()
  }
})

test('syncGatewayChamberPlugins: an empty package list is a best-effort skip', async () => {
  const result = await syncGatewayChamberPlugins({
    origin: 'http://127.0.0.1:1',
    headers: { authorization: 'Bearer x' },
    spkiPin: null,
    packages: [],
    logger: syncLog().logger,
  })
  assert.deepEqual(result, { uploaded: false, skipped: true })
})

test('syncGatewayChamberPlugins: an upload PUT refusal is an explicit failure, never the both-false "up to date" tuple', async () => {
  const server = await startSyncHttpServer((req, res) => {
    res.setHeader('connection', 'close')
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [] }))
      return
    }
    res.writeHead(500)
    res.end()
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, false)
    assert.equal(result.skipped, false)
    assert.equal(result.failed, true, 'a refused upload must never project as up to date')
    assert.ok((result.error ?? '').includes('@dsh-chamber/dsh-chamber-seed-client-graph'), 'the failure names the refused package')
  } finally {
    await server.close()
  }

  // A 400 refusal with a gateway REASON body carries the reason (the
  // old-gateway "unsyncable package" case): the user must see WHY the
  // upload was refused, not a bare HTTP status.
  const reasonServer = await startSyncHttpServer((req, res) => {
    res.setHeader('connection', 'close')
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [] }))
      return
    }
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unsyncable package "@dsh-chamber/dsh-chamber-seed-archive-cleanup" (this gateway release cannot cache it — it may predate the package; update the gateway to match the connecting desktop)', code: 'invalid_input' }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${reasonServer.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [ARCHIVE_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.failed, true)
    assert.ok((result.error ?? '').includes('uploading @dsh-chamber/dsh-chamber-seed-archive-cleanup failed (HTTP 400'), 'the failure names the refused package and status')
    assert.ok((result.error ?? '').includes('unsyncable package'), 'the failure carries the gateway refusal reason')
    assert.ok((result.error ?? '').includes('update the gateway'), 'the failure carries the remediation hint')
  } finally {
    await reasonServer.close()
  }
})

test('syncGatewayChamberPlugins: a partial failure (one upload refused, one landed) is loud on top of uploaded:true', async () => {
  let puts = 0
  const server = await startSyncHttpServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ items: [] }))
      return
    }
    if (req.url === '/chamber/runtime/restart') {
      res.writeHead(202, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ accepted: true }))
      return
    }
    puts += 1
    if (puts === 1) {
      res.writeHead(500)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, changed: true }))
  })
  try {
    const result = await syncGatewayChamberPlugins({
      origin: `http://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: null,
      packages: [GRAPH_PACKAGE, GIT_PACKAGE],
      logger: syncLog().logger,
    })
    assert.equal(result.uploaded, true, 'the second package still landed')
    assert.equal(result.failed, true, 'the refused package is not hidden behind the partial success')
    assert.ok((result.error ?? '').includes('@dsh-chamber/dsh-chamber-seed-client-graph'), 'the failure names the refused package')
  } finally {
    await server.close()
  }
})
