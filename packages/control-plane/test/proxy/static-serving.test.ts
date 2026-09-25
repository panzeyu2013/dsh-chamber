/**
 * Static frontend service tests (v4, design 04 §5 / 05 §3.3): webDistDir
 * dist/ + __DSH_BOOT__ — on-the-fly gzip (byte-identical round trip),
 * vary: accept-encoding on gzip and identity variants, explicit
 * content-length (incl. HEAD), the immutable cache policy for /assets/*,
 * no-cache + __DSH_BOOT__ injection on index.html, SPA fallback to the
 * shell, missing-asset 404, q-value-aware Accept-Encoding, and /health
 * untouched — against a real HTTP server on an ephemeral port with a
 * fixture dist in a temp dir (never the real dist). The dsh host is never
 * spawned (fake spawn seam, same as manager-api.ts). The module under test
 * is src/static-serving.ts (createStaticServing), exercised both directly
 * with fake req/res doubles and through the assembled plane.
 *
 * Static assertions use raw-socket requests: undici's fetch transparently
 * decompresses gzip bodies and may add its own accept-encoding, which would
 * hide the exact bytes/headers under test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { connect } from 'node:net'
import { createControlPlane } from '../../src/index.ts'
import { createStaticServing } from '../../src/static-serving.ts'
import type { ApiRequest, ApiResponse } from '../../src/api.ts'
import { fakeWire } from '../support/utils.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

interface Fixture {
  dir: string
  indexHtml: string
  asset: Buffer
  assetUrl: string
  /** An `/assets/` entry WITHOUT a content hash (Vite never emits one, but the
   *  cache rule must not pin it for a year if it ever does). */
  plainAssetUrl: string
  manifestRev: string
}

/** Build a fixture dist in a fresh temp dir (index.html + one hash asset +
 * one unhashed asset + manifest.json — the real dist is never touched). */
function fixtureDist(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-chamber-static-dist-'))
  mkdirSync(join(dir, 'assets'))
  const indexHtml = '<!doctype html><html><head><title>chamber</title></head><body><div id="root"></div></body></html>'
  writeFileSync(join(dir, 'index.html'), indexHtml)
  const asset = Buffer.from(`console.log("chamber asset ${Date.now()}");\n`.repeat(500))
  // Vite's default output name: `<name>-<8 base64url chars>.<ext>` — the shape
  // the shared isHashedStaticAssetPath predicate keys on.
  const assetUrl = '/assets/chamber-BKQ_L1z6.js'
  writeFileSync(join(dir, 'assets', 'chamber-BKQ_L1z6.js'), asset)
  const plainAssetUrl = '/assets/chamber.js'
  writeFileSync(join(dir, 'assets', 'chamber.js'), 'console.log("unhashed");\n')
  const manifestRev = 'abc123'
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
    rev: manifestRev,
    entries: [{ id: '@dsh-chamber/app', url: `${assetUrl}?rev=${manifestRev}`, rev: manifestRev, immediately: true }],
  }))
  return { dir, indexHtml, asset, assetUrl, plainAssetUrl, manifestRev }
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
    localConnectionDeps: { spawnDsh: wire.spawnDsh, probeHostIdentity: wire.probeHostIdentity },
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

test('static: /assets/* immutable cache policy; index.html no-cache; manifest.json untouched', async () => {
  const holder = await makeStaticPlane()
  try {
    const asset = await rawRequest(holder.plane.port!, 'GET', holder.fixture.assetUrl, { 'accept-encoding': 'gzip' })
    assert.equal(asset.status, 200)
    assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')
    // The rule is the SHARED hash predicate, not a bare `/assets/` prefix: an
    // unhashed entry under /assets/ must not be pinned for a year.
    const plain = await rawRequest(holder.plane.port!, 'GET', holder.fixture.plainAssetUrl, { 'accept-encoding': 'gzip' })
    assert.equal(plain.status, 200)
    assert.equal(plain.headers['cache-control'], undefined, 'an unhashed /assets/ entry is not immutable')

    const html = await rawRequest(holder.plane.port!, 'GET', '/', { 'accept-encoding': 'identity' })
    assert.equal(html.status, 200)
    assert.equal(html.headers['cache-control'], 'no-cache')
    assert.match(html.headers['content-security-policy'] ?? '', /default-src 'self'/)
    assert.match(html.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/)
    // CSP 半面：文档预览把 HTML/PDF/图片注入 blob: iframe，没有显式
    // frame-src 时 default-src 'self' 会一并拒掉（两 flavor 同因）。范围收窄：
    // 只放行 blob:，非 blob 子 frame 继续被 default-src 兜住。
    assert.match(html.headers['content-security-policy'] ?? '', /frame-src blob:/)
    assert.doesNotMatch(html.headers['content-security-policy'] ?? '', /frame-src [^;]*'self'/)
    assert.doesNotMatch(html.headers['content-security-policy'] ?? '', /script-src[^;]*'unsafe-inline'/)
    // 'unsafe-eval' is required by the official dsh module loader (boot-manifest
    // `__jsExpr` config evaluation); every inline script still needs the nonce.
    assert.match(html.headers['content-security-policy'] ?? '', /script-src[^;]*'unsafe-eval'/)
    assert.match(html.headers['content-security-policy'] ?? '', /script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/)
    // macOS 原生壳视口越界策略的运行时前提：壳注入的 <style> 无 nonce，
    // style-src 必须保留 'unsafe-inline'，否则整页弹性回弹静默复现
    // （design 25 §5.2；src/index.ts 同处有注释指向本条）。
    // 三条一起钉：只钉 unsafe-inline 的存在会漏掉另两种同样静默失效的改法
    // （同指令加 nonce/hash → CSP3 忽略 unsafe-inline；新增 style-src-elem → 覆盖 style-src）。
    // 指令级解析，而不是子串正则：重复指令
    // （"style-src 'none'; … style-src 'self' 'unsafe-inline'" —— CSP3 首次生效）或
    // "style-src 'none'; style-src-attr 'unsafe-inline'" 都能让注入的 <style> 被挡，
    // 而四条子串断言全绿。
    // 逗号分隔的每个 policy 都**同时生效**（CSP3 合取），同一 policy 内重复指令首次生效：
    // 因此要收集**所有**生效的 style-src，任何一个缺 unsafe-inline 就算失败
    // （只解析第一条 policy 会被 "…, style-src 'none'" 绕过）。
    // 每个 policy 的**生效样式源**按 CSP3 回退链取：
    // style-src-elem（管 <style>/<link rel=stylesheet>）→ style-src → default-src；
    // 同一 policy 内重复指令首次生效；没有任何相关指令 = 不限制（undefined）。
    // style-src-attr 只管 style 属性，不参与 <style> 的判定。
    // 两类静默绕过：① 只收 style-src 会漏掉
    // ", default-src 'none'"（没有 style-src 时 default-src 才是生效源，实测 WebKit
    // 整页样式被挡）；② nonce/hash 检查必须大小写不敏感（引擎把 'NONCE-abc' 当真
    // nonce，反向静态正则漏判）。
    const effectiveStyleSrcs = (header: string): (string | undefined)[] => {
      const values: (string | undefined)[] = []
      for (const policy of header.split(',')) {
        const directives = new Map<string, string>()
        for (const part of policy.split(';')) {
          const [rawName, ...rest] = part.trim().split(/\s+/)
          const name = (rawName ?? '').toLowerCase()
          if (name === '' || directives.has(name)) continue
          directives.set(name, rest.join(' '))
        }
        values.push(
          directives.get('style-src-elem')
          ?? directives.get('style-src')
          ?? directives.get('default-src'))
      }
      return values
    }
    const styleAllowsUnsafeInline = (sources: string): boolean =>
      /'unsafe-inline'/i.test(sources)
      && !/'nonce-/i.test(sources)
      && !/'sha(256|384|512)-/i.test(sources)
    // 解析器自证（否则这组断言只是换写法的子串匹配）。
    assert.deepEqual(
      effectiveStyleSrcs("style-src 'none'; style-src 'self' 'unsafe-inline'"),
      ["'none'"],
      '同一 policy 内重复指令按首次生效解析（值保留引号）',
    )
    assert.deepEqual(effectiveStyleSrcs("style-src 'none'; style-src-elem 'unsafe-inline'"),
      ["'unsafe-inline'"], 'style-src-elem 是回退链第一环，覆盖 style-src')
    assert.deepEqual(effectiveStyleSrcs("style-src-attr 'none'"),
      [undefined], 'style-src-attr 只管属性：<style> 不受它限制')
    assert.deepEqual(effectiveStyleSrcs("default-src 'none'"),
      ["'none'"], '没有 style-src 时 default-src 是 <style> 的生效源')
    assert.deepEqual(effectiveStyleSrcs("style-src 'self' 'unsafe-inline', style-src 'none'"),
      ["'self' 'unsafe-inline'", "'none'"],
      '逗号分隔的第二个 policy 也必须被看到')
    // 判定器自证：关键字与 nonce/hash 都按大小写不敏感处理（引擎语义）。
    assert.equal(styleAllowsUnsafeInline("'self' 'unsafe-inline'"), true)
    assert.equal(styleAllowsUnsafeInline("'self' 'UNSAFE-INLINE'"), true, '关键字大小写不敏感')
    assert.equal(styleAllowsUnsafeInline("'self' 'unsafe-inline' 'NONCE-abc'"), false,
      '大写 nonce 同样让 unsafe-inline 失效')
    assert.equal(styleAllowsUnsafeInline("'self' 'unsafe-inline' 'SHA256-AAAA'"), false)
    const styleSrcs = effectiveStyleSrcs(html.headers['content-security-policy'] ?? '')
      .filter((value): value is string => value !== undefined)
    assert.ok(styleSrcs.length > 0, '响应头必须至少有一个 policy 生效并约束 <style>')
    for (const styleSrc of styleSrcs) {
      assert.ok(styleAllowsUnsafeInline(styleSrc),
        '每个生效的样式源都必须保留 unsafe-inline、且不带 nonce/hash（S-50 注入的样式无 nonce）')
    }
    assert.equal(html.headers['cross-origin-opener-policy'], 'same-origin')
    // same-origin (not no-referrer): no-referrer makes modern browsers send
    // Origin: null on same-origin form POSTs, which the origin fences reject
    // fail-closed (see CONTROL_PLANE_SECURITY_HEADERS).
    assert.equal(html.headers['referrer-policy'], 'same-origin')
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
  // The window rebuild path can produce
  // `http://127.0.0.1:<port>//`; `new URL('//', base)` throws, and an
  // uncaught exception would take the whole control plane down. The request
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

// ---------------------------------------------------------------------------
// createStaticServing direct tests (fake req/res doubles — no HTTP server)
// ---------------------------------------------------------------------------

/** Minimal ApiResponse double capturing status/headers/body. */
class FakeRes {
  headersSent = false
  writableEnded = false
  status = 0
  headers: Record<string, string> = {}
  body: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  _cspNonce?: string
  _corsHeaders?: Record<string, string>
  writeHead(status: number, headers?: Record<string, string | number | string[] | undefined>) {
    this.status = status
    this.headers = {}
    for (const [name, value] of Object.entries(headers ?? {})) {
      this.headers[name.toLowerCase()] = String(value)
    }
  }
  end(payload?: unknown) {
    if (payload === undefined) this.body = Buffer.alloc(0)
    else if (typeof payload === 'string') this.body = Buffer.from(payload, 'utf8')
    else this.body = Buffer.from(payload as Uint8Array)
  }
  on() { return this }
  once() { return this }
  removeListener() { return this }
  write() { return true }
  setHeader() { return undefined }
  destroy() { return undefined }
}

/** Minimal ApiRequest double; serve() only reads headers. */
function fakeReq(headers: Record<string, string> = {}): ApiRequest {
  return { headers } as unknown as ApiRequest
}

/** Serve one path through the module directly (await the async serve). */
async function serveOnce(
  serving: ReturnType<typeof createStaticServing>,
  req: ApiRequest,
  pathname: string,
): Promise<FakeRes> {
  const res = new FakeRes() as unknown as ApiResponse
  res._cspNonce = 'dsh-nonce-test'
  await serving.serve(req, res, pathname)
  return res as unknown as FakeRes
}

test('static module: gzip negotiation is q-value aware (gzip;q=0 refuses, multi-token accepts)', async () => {
  const fixture = fixtureDist()
  try {
    const serving = createStaticServing({ webDistDir: fixture.dir })
    const refused = await serveOnce(serving, fakeReq({ 'accept-encoding': 'gzip;q=0, deflate' }), fixture.assetUrl)
    assert.equal(refused.status, 200)
    assert.equal(refused.headers['content-encoding'], undefined)
    assert.equal(refused.headers['vary'], 'accept-encoding')
    assert.deepEqual(refused.body, fixture.asset)

    const accepted = await serveOnce(serving, fakeReq({ 'accept-encoding': 'deflate, gzip, br' }), fixture.assetUrl)
    assert.equal(accepted.status, 200)
    assert.equal(accepted.headers['content-encoding'], 'gzip')
    assert.deepEqual(gunzipSync(accepted.body), fixture.asset)

    const noHeader = await serveOnce(serving, fakeReq(), fixture.assetUrl)
    assert.equal(noHeader.headers['content-encoding'], undefined)
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('static module: MIME resolution, SPA fallback, missing-asset 404 and path-escape 404', async () => {
  const fixture = fixtureDist()
  try {
    const serving = createStaticServing({ webDistDir: fixture.dir })

    // Unknown extension → octet-stream; known extension → its MIME type.
    writeFileSync(join(fixture.dir, 'app.xyz'), 'data')
    const unknown = await serveOnce(serving, fakeReq(), '/app.xyz')
    assert.equal(unknown.status, 200)
    assert.equal(unknown.headers['content-type'], 'application/octet-stream')
    const asset = await serveOnce(serving, fakeReq(), fixture.assetUrl)
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8')

    // SPA fallback serves the injected shell for an unknown HTML-ish path.
    const fallback = await serveOnce(serving, fakeReq(), '/some/unknown/route')
    assert.equal(fallback.status, 200)
    assert.match(fallback.headers['content-type'] ?? '', /text\/html/)
    assert.ok(fallback.body.toString('utf8').includes('window.__DSH_BOOT__='))

    // Missing assets answer JSON 404, never the shell.
    const missing = await serveOnce(serving, fakeReq(), '/assets/missing-xyz.js')
    assert.equal(missing.status, 404)
    assert.match(missing.headers['content-type'] ?? '', /application\/json/)
    assert.ok(missing.body.toString('utf8').includes('not_found'))

    // A traversal path is rejected (never served from outside webDistDir).
    const escape = await serveOnce(serving, fakeReq(), '/../outside.txt')
    assert.equal(escape.status, 404)
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('static module: __DSH_BOOT__ injection requires the CSP nonce (missing → rejection)', async () => {
  const fixture = fixtureDist()
  try {
    const serving = createStaticServing({ webDistDir: fixture.dir })
    const res = new FakeRes() as unknown as ApiResponse
    res._cspNonce = 'dsh-nonce-test'
    await serving.serve(fakeReq(), res, '/')
    const text = (res as unknown as FakeRes).body.toString('utf8')
    assert.match(text, /<script nonce="dsh-nonce-test">window\.__DSH_BOOT__=/)
    assert.ok(text.includes('</script></head>'), 'the injected script lands before </head>')

    const noNonce = new FakeRes() as unknown as ApiResponse
    await assert.rejects(
      serving.serve(fakeReq(), noNonce, '/'),
      /missing CSP nonce for static response/,
    )
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Gzip cache semantics (async read/gzip + single-flight)
// ---------------------------------------------------------------------------

test('static module: gzip cache serves the previously compressed bytes while mtime+size are unchanged', async () => {
  const fixture = fixtureDist()
  try {
    const target = join(fixture.dir, 'assets', 'chamber-BKQ_L1z6.js')
    // Pin a fixed whole-ms mtime: the rewrite below must not move the
    // path+mtime+size cache key, so only the bytes on disk change.
    const pinned = new Date(2_000_000_000_000)
    utimesSync(target, pinned, pinned)
    const serving = createStaticServing({ webDistDir: fixture.dir })

    const first = await serveOnce(serving, fakeReq({ 'accept-encoding': 'gzip' }), fixture.assetUrl)
    assert.equal(first.headers['content-encoding'], 'gzip')
    assert.deepEqual(gunzipSync(first.body), fixture.asset)

    // Same byte length (same cache key) but different bytes: the cached
    // compressed payload must still be served.
    const replacement = Buffer.from(fixture.asset.toString('utf8').replaceAll('chamber asset', 'CHAMBER-ASSET'))
    assert.equal(replacement.length, fixture.asset.length)
    assert.notDeepEqual(replacement, fixture.asset)
    writeFileSync(target, replacement)
    utimesSync(target, pinned, pinned)

    const second = await serveOnce(serving, fakeReq({ 'accept-encoding': 'gzip' }), fixture.assetUrl)
    assert.equal(second.headers['content-encoding'], 'gzip')
    assert.deepEqual(second.body, first.body, 'cache hit returns the previously compressed bytes')
    assert.deepEqual(gunzipSync(second.body), fixture.asset, 'the cached bytes still decode to the pre-rewrite file')
    assert.equal(second.headers['content-length'], String(second.body.length))

    // Identity reads never touch the gzip cache and see the current file.
    const identity = await serveOnce(serving, fakeReq(), fixture.assetUrl)
    assert.equal(identity.headers['content-encoding'], undefined)
    assert.deepEqual(identity.body, replacement)
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('static module: gzip cache invalidates when the file mtime moves (new bytes served)', async () => {
  const fixture = fixtureDist()
  try {
    const target = join(fixture.dir, 'assets', 'chamber-BKQ_L1z6.js')
    const pinned = new Date(2_000_000_000_000)
    utimesSync(target, pinned, pinned)
    const serving = createStaticServing({ webDistDir: fixture.dir })

    const first = await serveOnce(serving, fakeReq({ 'accept-encoding': 'gzip' }), fixture.assetUrl)
    assert.deepEqual(gunzipSync(first.body), fixture.asset)

    // Same byte length, moved mtime: the key changes, so the new bytes are
    // read and re-compressed instead of serving the stale variant.
    const replacement = Buffer.from(fixture.asset.toString('utf8').replaceAll('chamber asset', 'INVALIDATED!!'))
    assert.equal(replacement.length, fixture.asset.length)
    writeFileSync(target, replacement)
    const moved = new Date(2_000_000_000_000 + 1000)
    utimesSync(target, moved, moved)

    const second = await serveOnce(serving, fakeReq({ 'accept-encoding': 'gzip' }), fixture.assetUrl)
    assert.notDeepEqual(second.body, first.body, 'a new mtime must not serve the stale compressed bytes')
    assert.deepEqual(gunzipSync(second.body), replacement)
    assert.equal(second.headers['content-length'], String(second.body.length))
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('static module: concurrent gzip misses for one file all resolve with the correct bytes', async () => {
  const fixture = fixtureDist()
  try {
    const serving = createStaticServing({ webDistDir: fixture.dir })
    // Cold cache: all eight requests enter the miss path together; the
    // single-flight map shares one read/gzip, and every response must still
    // carry the complete gzip variant.
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => serveOnce(serving, fakeReq({ 'accept-encoding': 'gzip' }), fixture.assetUrl)),
    )
    for (const response of responses) {
      assert.equal(response.status, 200)
      assert.equal(response.headers['content-encoding'], 'gzip')
      assert.equal(response.headers['content-length'], String(response.body.length))
      assert.deepEqual(gunzipSync(response.body), fixture.asset)
    }
    for (const response of responses) {
      assert.deepEqual(response.body, responses[0].body, 'one shared compression serves every concurrent miss')
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C4 安全模式：index.html 头部注入 window.__DSH_CHAMBER_SAFE_MODE__（渲染端
// 据此跳过 extra rows），且必须先于 __DSH_BOOT__；普通启动完全不注入。
// ---------------------------------------------------------------------------

test('static module: 安全模式注入 __DSH_CHAMBER_SAFE_MODE__ 且先于 __DSH_BOOT__；普通启动不注入', async () => {
  const fixture = fixtureDist()
  try {
    const safeRes = new FakeRes() as unknown as ApiResponse
    safeRes._cspNonce = 'dsh-nonce-safe'
    await createStaticServing({ webDistDir: fixture.dir, safeMode: true }).serve(fakeReq(), safeRes, '/')
    const safeText = (safeRes as unknown as FakeRes).body.toString('utf8')
    assert.match(safeText, /<script nonce="dsh-nonce-safe">window\.__DSH_CHAMBER_SAFE_MODE__=true;<\/script>/)
    assert.ok(
      safeText.indexOf('__DSH_CHAMBER_SAFE_MODE__') < safeText.indexOf('window.__DSH_BOOT__='),
      '安全模式全局必须先于 __DSH_BOOT__ 注入（bundle 求值前即可读）',
    )

    const normalRes = new FakeRes() as unknown as ApiResponse
    normalRes._cspNonce = 'dsh-nonce-normal'
    await createStaticServing({ webDistDir: fixture.dir }).serve(fakeReq(), normalRes, '/')
    const normalText = (normalRes as unknown as FakeRes).body.toString('utf8')
    assert.ok(!normalText.includes('__DSH_CHAMBER_SAFE_MODE__'), '普通启动不注入该全局（响应逐字节不变）')
    assert.ok(normalText.includes('window.__DSH_BOOT__='), '普通启动照旧只注入 __DSH_BOOT__')
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('createControlPlane 安全模式 env 缺省读点：DSH_CHAMBER_SAFE_MODE=1 → 页面收到注入', async () => {
  const previous = process.env.DSH_CHAMBER_SAFE_MODE
  process.env.DSH_CHAMBER_SAFE_MODE = '1'
  try {
    const holder = await makeStaticPlane()
    try {
      const html = await rawRequest(holder.plane.port!, 'GET', '/')
      assert.ok(
        html.body.toString('utf8').includes('window.__DSH_CHAMBER_SAFE_MODE__=true;'),
        '未显式传 safeMode 时也必须从进程 env 读到（Electron 同进程 / Swift sidecar 同一读点）',
      )
    } finally {
      await cleanup(holder)
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_CHAMBER_SAFE_MODE
    else process.env.DSH_CHAMBER_SAFE_MODE = previous
  }
})
