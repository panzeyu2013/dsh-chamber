/**
 * In-process HTTP fixtures for the embedded-browser acceptance legs (design 28
 * §16.9 / plan §5 L4 W-14a + W-15).
 *
 * WHY A LOCAL SERVER: the local source's iframe needs no SSH forward (the panel
 * sets the validated loopback URL as src directly), so a plain node:http server
 * on 127.0.0.1 gives W-14a a REAL cross-origin document to embed — its
 * postMessage back to the app document is engine-level proof that the frame
 * loaded and runs, not a DOM-shape assertion that a blank frame satisfies.
 *
 * ROUTES:
 *   `/`              a marker page: postMessage({type, marker, href}) to the parent
 *   `/embed-xfo`     the SAME page with `X-Frame-Options: DENY` (W-15 negative control)
 *
 * The XFO path is fixture-only and deliberately distinctive: the walkthrough's
 * W-11/W-12 gates tolerate its blocked-frame noise by that path segment
 * (checks.mjs EXPECTED_FIXTURE_*), never by "any failed load".
 *
 * IO lives here (like launch.mjs); the judgement layer stays in checks.mjs.
 */
import { createServer } from 'node:http'

/** Message type the fixture posts; the judge requires this exact envelope. */
export const FIXTURE_MESSAGE_TYPE = 'dsh-chamber-embed-probe'
/** Marker value proving the embedded page ran its own script. */
export const FIXTURE_MARKER = 'dsh-embed-ok'
/** The fixture-only XFO path (never served by the product). */
export const FIXTURE_XFO_PATH = '/embed-xfo'

/** The marker page: posts one message to its parent (cross-origin, target '*'). */
function markerPage({ type, marker, href }) {
  const payload = JSON.stringify({ type, marker, href })
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dsh-chamber embed fixture</title></head><body>
<p>embedded fixture</p>
<script>
  try {
    parent.postMessage(${payload}, '*')
  } catch (error) {
    document.title = 'postMessage failed'
  }
</script>
</body></html>`
}

/**
 * Start the fixture on a loopback host and an OS-assigned port.
 * @param opts.host loopback host to bind (default 127.0.0.1)
 * @param opts.type postMessage envelope type (default FIXTURE_MESSAGE_TYPE)
 * @param opts.marker marker value (default FIXTURE_MARKER)
 * @returns `{ origin, port, xfoPath, xfoUrl, close }`; `close` is idempotent.
 */
export async function startEmbedFixture({
  host = '127.0.0.1',
  type = FIXTURE_MESSAGE_TYPE,
  marker = FIXTURE_MARKER,
  xfoPath = FIXTURE_XFO_PATH,
} = {}) {
  const server = createServer((request, response) => {
    const target = request.url ?? '/'
    const pathname = target.split('?')[0]
    if (pathname === '/' || pathname === xfoPath) {
      const href = `http://${host}:${String(server.address()?.port ?? 0)}${pathname}`
      const html = markerPage({ type, marker, href })
      const headers = {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...(pathname === xfoPath ? { 'x-frame-options': 'DENY' } : {}),
      }
      response.writeHead(200, headers)
      response.end(html)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not_found","code":"not_found"}')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const origin = `http://${host}:${String(port)}`
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  return Object.freeze({ origin, port, xfoPath, xfoUrl: origin + xfoPath, close })
}

/**
 * Whether a TCP listener accepts a connection (the W-15b "alias 端口不可达"
 * leg). Raw `node:net` — a fetch could hang on a non-HTTP listener and a
 * timeout would be misread as "unreachable". An ECONNREFUSED error means the
 * listener is gone; any other error is reported as `unknown` (fail-closed in
 * the verdict, never silently counted as released).
 * @param url - http(s) URL naming host + port.
 * @param timeoutMs - bound for the connect attempt.
 * @returns `'open' | 'closed' | 'unknown'`.
 */
export async function probeTcpReachable(url, { timeoutMs = 1_500 } = {}) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'unknown'
  }
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return 'unknown'
  const { createConnection } = await import('node:net')
  return await new Promise(resolve => {
    let settled = false
    let socket = null
    const finish = outcome => {
      if (settled) return
      settled = true
      if (socket !== null) socket.destroy()
      resolve(outcome)
    }
    socket = createConnection({ host: parsed.hostname, port })
    socket.once('connect', () => finish('open'))
    socket.once('error', error => {
      // Only a refused connection proves the listener is gone; DNS/timeout/etc.
      // are "unknown" and the verdict fails closed on them.
      finish(error?.code === 'ECONNREFUSED' ? 'closed' : 'unknown')
    })
    socket.setTimeout(timeoutMs, () => finish('unknown'))
  })
}
