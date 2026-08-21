/**
 * Static frontend service tests (v4, design 04 §5 / 05 §3.3): webDistDir
 * dist/ + __DSH_BOOT__ — on-the-fly gzip (byte-identical round trip),
 * vary: accept-encoding on gzip and identity variants, explicit
 * content-length (incl. HEAD), the immutable cache policy for /assets/*,
 * no-cache + __DSH_BOOT__ injection on index.html, SPA fallback to the
 * shell, missing-asset 404, q-value-aware Accept-Encoding, and /health
 * untouched — against a real HTTP server on an ephemeral port with a
 * fixture dist in a temp dir (never the real dist). The dsh host is never
 * spawned (fake spawn seam, same as manager-api.ts).
 *
 * Static assertions use raw-socket requests: undici's fetch transparently
 * decompresses gzip bodies and may add its own accept-encoding, which would
 * hide the exact bytes/headers under test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { connect } from 'node:net'
import { createControlPlane } from '../src/index.ts'
import type { SpawnedDsh } from '../src/local-connection.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

/** A fake spawn: immediate ready on a fixed port; counts spawn attempts. */
function fakeWire() {
  let spawns = 0
  const spawnDsh = async (): Promise<SpawnedDsh> => {
    spawns += 1
    return {
      child: { on: () => {}, exitCode: null },
      port: 17510,
      stop: async () => {},
    }
  }
  const describeCapabilities = async () => ({ value: { attachedSessions: 0 }, cachedAt: Date.now() })
  return { spawnDsh, describeCapabilities, get spawns() { return spawns } }
}

interface Fixture {
  dir: string
  indexHtml: string
  asset: Buffer
  assetUrl: string
  manifestRev: string
}

/** Build a fixture dist in a fresh temp dir (index.html + one hash asset +
 * manifest.json — the real dist is never touched). */
function fixtureDist(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chamber-static-dist-'))
  mkdirSync(join(dir, 'assets'))
  const indexHtml = '<!doctype html><html><head><title>chamber</title></head><body><div id="root"></div></body></html>'
  writeFileSync(join(dir, 'index.html'), indexHtml)
  const asset = Buffer.from(`console.log("chamber asset ${Date.now()}");\n`.repeat(500))
  const assetUrl = '/assets/chamber-abc123.js'
  writeFileSync(join(dir, 'assets', 'chamber-abc123.js'), asset)
  const manifestRev = 'abc123'
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    rev: manifestRev,
    entries: [{ id: '@dsh-chamber/app', url: `${assetUrl}?rev=${manifestRev}`, rev: manifestRev, immediately: true }],
  }))
  return { dir, indexHtml, asset, assetUrl, manifestRev }
}

interface StaticHolder {
  plane: ReturnType<typeof createControlPlane>
  fixture: Fixture
  stateDir: string
  base: string
}

/** Start the plane over the fixture dist on an ephemeral port. */
async function makeStaticPlane(): Promise<StaticHolder> {
  const fixture = fixtureDist()
  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-chamber-static-state-'))
  const wire = fakeWire()
  const plane = createControlPlane({
    port: 0,
    stateDir,
    webDistDir: fixture.dir,
    logger: silentLogger,
    localConnectionDeps: { spawnDsh: wire.spawnDsh, describeCapabilities: wire.describeCapabilities },
  })
  try {
    await plane.start()
    return { plane, fixture, stateDir, base: `http://127.0.0.1:${plane.port}` }
  } catch (error) {
    rmSync(stateDir, { recursive: true, force: true })
    rmSync(fixture.dir, { recursive: true, force: true })
    throw error
  }
}

async function cleanup(holder: StaticHolder) {
  await holder.plane.stop().catch(() => {})
  rmSync(holder.stateDir, { recursive: true, force: true })
  rmSync(holder.fixture.dir, { recursive: true, force: true })
}

interface RawResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** Raw HTTP request over a socket: byte-exact headers + body (no undici). */
function rawRequest(port: number, method: string, path: string, requestHeaders: Record<string, string> = {}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = Buffer.alloc(0)
    socket.on('connect', () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close']
      for (const [name, value] of Object.entries(requestHeaders)) lines.push(`${name}: ${value}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    socket.on('data', chunk => {
      // The socket is never put in string mode, so chunk is always a Buffer at
      // runtime; the typed union also allows a string (setEncoding), which is
      // never used here — the branch only satisfies the SocketEventMap typing.
      response = Buffer.concat([response, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'binary')])
    })
    socket.on('end', () => {
      try {
        const sep = response.indexOf('\r\n\r\n')
        if (sep === -1) {
          reject(new Error('no header terminator'))
          return
        }
        const headText = response.subarray(0, sep).toString('latin1')
        const statusLine = /^HTTP\/1\.1 (\d{3})/.exec(headText)
        if (statusLine === null) {
          reject(new Error(`bad status line: ${headText.split('\r\n')[0] ?? ''}`))
          return
        }
        const headers: Record<string, string> = {}
        for (const line of headText.split('\r\n').slice(1)) {
          const idx = line.indexOf(':')
          if (idx !== -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
        }
        resolve({ status: Number(statusLine[1]), headers, body: response.subarray(sep + 4) })
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', reject)
  })
}

test('static: gzip and identity variants round-trip the file bytes; vary + explicit content-length', async () => {
  const holder = await makeStaticPlane()
  try {
    const assetPath = holder.fixture.assetUrl
    const expected = holder.fixture.asset

    // Gzip variant (q=0.5 still accepts gzip per RFC 9110).
    const gz = await rawRequest(holder.plane.port!, 'GET', assetPath, { 'accept-encoding': 'gzip;q=0.5' })
    assert.equal(gz.status, 200)
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.equal(gz.headers['vary'], 'accept-encoding')
    assert.equal(gz.headers['transfer-encoding'], undefined, 'explicit content-length disables chunked')
    assert.equal(gz.headers['content-length'], String(gz.body.length))
    assert.equal(gz.body.length, gzipSync(expected).length, 'served gzip is the file gzipped')
    assert.deepEqual(gunzipSync(gz.body), expected)

    // Identity variant: no accept-encoding at all.
    const identity = await rawRequest(holder.plane.port!, 'GET', assetPath)
    assert.equal(identity.status, 200)
    assert.equal(identity.headers['content-encoding'], undefined)
    assert.equal(identity.headers['vary'], 'accept-encoding')
    assert.equal(identity.headers['content-length'], String(identity.body.length))
    assert.deepEqual(identity.body, expected)

    // HEAD carries a real Content-Length without a body.
    const head = await rawRequest(holder.plane.port!, 'HEAD', assetPath, { 'accept-encoding': 'gzip' })
    assert.equal(head.status, 200)
    assert.equal(head.body.length, 0)
    assert.equal(head.headers['content-length'], String(gzipSync(expected).length))
    assert.equal(head.headers['content-encoding'], 'gzip')
  } finally {
    await cleanup(holder)
  }
})

test('static: q-value-aware Accept-Encoding — gzip;q=0 refuses, multi-token accepts', async () => {
  const holder = await makeStaticPlane()
  try {
    const assetPath = holder.fixture.assetUrl

    // gzip;q=0 is an explicit refusal → identity, with vary still present.
    const refused = await rawRequest(holder.plane.port!, 'GET', assetPath, { 'accept-encoding': 'gzip;q=0, deflate' })
    assert.equal(refused.status, 200)
    assert.equal(refused.headers['content-encoding'], undefined)
    assert.equal(refused.headers['vary'], 'accept-encoding')
    assert.deepEqual(refused.body, holder.fixture.asset)

    // A plain multi-token list accepts gzip.
    const accepted = await rawRequest(holder.plane.port!, 'GET', assetPath, { 'accept-encoding': 'deflate, gzip, br' })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.headers['content-encoding'], 'gzip')
  } finally {
    await cleanup(holder)
  }
})

test('static: /assets/* immutable cache policy; index.html no-cache; manifest.json untouched', async () => {
  const holder = await makeStaticPlane()
  try {
    const asset = await rawRequest(holder.plane.port!, 'GET', holder.fixture.assetUrl, { 'accept-encoding': 'gzip' })
    assert.equal(asset.status, 200)
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')

    const html = await rawRequest(holder.plane.port!, 'GET', '/', { 'accept-encoding': 'identity' })
    assert.equal(html.status, 200)
    assert.equal(html.headers['cache-control'], 'no-cache')
    assert.match(html.headers['content-security-policy'] ?? '', /default-src 'self'/)
    assert.match(html.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/)
    assert.doesNotMatch(html.headers['content-security-policy'] ?? '', /script-src[^;]*'unsafe-inline'/)
    // 'unsafe-eval' is required by the official dsh module loader (boot-manifest
    // `__jsExpr` config evaluation); every inline script still needs the nonce.
    assert.match(html.headers['content-security-policy'] ?? '', /script-src[^;]*'unsafe-eval'/)
    assert.match(html.headers['content-security-policy'] ?? '', /script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/)
    assert.equal(html.headers['cross-origin-opener-policy'], 'same-origin')
    assert.equal(html.headers['referrer-policy'], 'no-referrer')
    assert.equal(html.headers['x-content-type-options'], 'nosniff')
    assert.equal(html.headers['x-frame-options'], 'DENY')

    const manifest = await rawRequest(holder.plane.port!, 'GET', '/manifest.json')
    assert.equal(manifest.status, 200)
    assert.equal(manifest.headers['cache-control'], undefined, 'non-asset paths keep no cache header')
    assert.equal(manifest.headers['vary'], 'accept-encoding')
    assert.deepEqual(JSON.parse(manifest.body.toString('utf8')).rev, holder.fixture.manifestRev)
  } finally {
    await cleanup(holder)
  }
})

test('static: __DSH_BOOT__ injection lands in index.html before </head> (identity and gzip)', async () => {
  const holder = await makeStaticPlane()
  try {
    const html = await rawRequest(holder.plane.port!, 'GET', '/', { 'accept-encoding': 'identity' })
    assert.equal(html.status, 200)
    assert.match(html.headers['content-type'] ?? '', /text\/html/)
    const text = html.body.toString('utf8')
    assert.ok(text.includes('<div id="root"></div>'), 'the fixture index.html body is served')
    const nonce = /script-src[^;]*'nonce-([^']+)'/.exec(html.headers['content-security-policy'] ?? '')?.[1]
    assert.ok(nonce !== undefined, 'the response CSP carries a script nonce')
    const startMarker = `<script nonce="${nonce}">window.__DSH_BOOT__=`
    const endMarker = ';</script></head>'
    const startIdx = text.indexOf(startMarker)
    assert.ok(startIdx !== -1, 'the boot script is injected')
    const endIdx = text.indexOf(endMarker, startIdx)
    assert.ok(endIdx !== -1, 'the boot script lands before </head>')
    const boot = JSON.parse(text.slice(startIdx + startMarker.length, endIdx)) as { rev: string; entries: { url: string }[] }
    assert.equal(boot.rev, holder.fixture.manifestRev)
    assert.equal(boot.entries[0].url, `${holder.fixture.assetUrl}?rev=${holder.fixture.manifestRev}`)

    // The gzipped index.html variant carries the same injected payload.
    const gz = await rawRequest(holder.plane.port!, 'GET', '/', { 'accept-encoding': 'gzip' })
    assert.equal(gz.status, 200)
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.ok(gunzipSync(gz.body).toString('utf8').includes('window.__DSH_BOOT__='))
  } finally {
    await cleanup(holder)
  }
})

test('static: boot manifest strings cannot terminate the inline script block', async () => {
  const holder = await makeStaticPlane()
  try {
    writeFileSync(join(holder.fixture.dir, 'manifest.json'), JSON.stringify({
      rev: '</script><script>globalThis.pwned=true</script>',
      entries: [],
    }))
    const html = await rawRequest(holder.plane.port!, 'GET', '/')
    const text = html.body.toString('utf8')
    assert.equal((text.match(/<script nonce=/g) ?? []).length, 1)
    assert.doesNotMatch(text, /<script>globalThis\.pwned/)
    assert.match(text, /\\u003c\/script>\\u003cscript>/)
  } finally {
    await cleanup(holder)
  }
})

test('static: SPA fallback serves the injected shell; missing assets answer 404', async () => {
  const holder = await makeStaticPlane()
  try {
    const fallback = await rawRequest(holder.plane.port!, 'GET', '/some/unknown/route')
    assert.equal(fallback.status, 200)
    assert.match(fallback.headers['content-type'] ?? '', /text\/html/)
    assert.equal(fallback.headers['cache-control'], 'no-cache')
    assert.ok(fallback.body.toString('utf8').includes('window.__DSH_BOOT__='), 'fallback is the injected index.html')

    for (const missing of ['/assets/missing-xyz.js', '/assets/missing.png', '/not-an-asset.txt']) {
      const response = await rawRequest(holder.plane.port!, 'GET', missing)
      assert.equal(response.status, 404, `${missing} should 404`)
      assert.match(response.headers['content-type'] ?? '', /application\/json/)
      assert.equal(response.headers['content-length'], String(response.body.length), `${missing} carries an explicit length`)
      assert.ok(response.body.toString('utf8').includes('not_found'), `${missing} body carries not_found`)
    }
  } finally {
    await cleanup(holder)
  }
})

test('static: /health is untouched by the static service', async () => {
  const holder = await makeStaticPlane()
  try {
    const health = await fetch(`${holder.base}/health`)
    assert.equal(health.status, 200)
    assert.match(health.headers.get('content-type') ?? '', /application\/json/)
    const body = (await health.json()) as { ok: boolean; dsh: { status: string } }
    assert.equal(body.ok, true)
    assert.equal(body.dsh.status, 'stopped')
  } finally {
    await cleanup(holder)
  }
})

test('static: a `//`-leading request line answers 400 and never crashes the server', async () => {
  // Regression (2026-08): the window rebuild path once produced
  // `http://127.0.0.1:<port>//`; `new URL('//', base)` throws, and the
  // uncaught exception took the whole control plane down. The request
  // handler must reject the malformed line explicitly and keep serving.
  const holder = await makeStaticPlane()
  try {
    const bad = await rawRequest(holder.plane.port!, 'GET', '//')
    assert.equal(bad.status, 400)
    assert.match(bad.body.toString('utf8'), /invalid-url/)
    // The server must still serve a normal request afterwards.
    const health = await fetch(`${holder.base}/health`)
    assert.equal(health.status, 200)
  } finally {
    await cleanup(holder)
  }
})
