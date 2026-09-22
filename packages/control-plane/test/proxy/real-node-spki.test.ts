/**
 * Real-Node integration regressions (part 5 of the test/proxy split):
 * IncomingMessage 'close' semantics for HTTP/WS, WS teardown logging and the
 * SPKI certificate-pinning fixtures/forwarding for gateway https + wss.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer, get, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer as createHttpsServer } from 'node:https'
import { createHash, X509Certificate } from 'node:crypto'
import { createInstanceProxy } from '../../src/instance-proxy.ts'
import {
  fakeRequest,
  fakeResponse,
  fakeSocket,
  GATEWAY_AUTHORIZATION,
  quietLogger,
  sleep,
} from '../support/proxy-fakes.ts'

// ---------------------------------------------------------------------------
// Real-Node integration pin: IncomingMessage 'close' fires
// as soon as the request body is consumed — immediately for a bodyless
// GET/HEAD — NOT on client disconnect. The proxy's disconnect detection must
// therefore hang off the RESPONSE leg (res 'close' + writableEnded) and the
// upgrade path off the raw socket; a req 'close' listener would abort every
// bodyless forward / WS handshake right after it starts (fake-request unit
// tests never exercise real Node stream semantics — this block does).
// ---------------------------------------------------------------------------

/** Boot a real proxy instance + real upstream, returns their ports. */
function bootRealProxy(): Promise<{ proxyPort: number; upstreamPort: number; upstream: ReturnType<typeof createServer>; server: ReturnType<typeof createServer> }> {
  return new Promise((resolve) => {
    const upstream = createServer((req, res) => {
      res.setHeader('content-type', 'text/plain')
      res.end(`upstream-ok:${req.method}`)
    })
    const proxy = createInstanceProxy({
      logger: quietLogger,
      getLocalState: () => 'ready',
      getLocalDshPort: () => upstreamPort,
    })
    let upstreamPort = 0
    let server: ReturnType<typeof createServer> | null = null
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as AddressInfo).port
      server = createServer((req, res) => { void proxy.handleHttp(req as any, res as any) })
      server.on('upgrade', (req, socket, head) => { void proxy.handleUpgrade(req as any, socket as any, head) })
      server.listen(0, '127.0.0.1', () => {
        resolve({ proxyPort: (server!.address() as AddressInfo).port, upstreamPort, upstream, server: server! })
      })
    })
  })
}

test('real Node streams: bodyless GET forwards (req close must not abort the upstream)', async () => {
  const { proxyPort, upstream, server } = await bootRealProxy()
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = get(`http://127.0.0.1:${proxyPort}/api/i/local/some/path?q=1`, res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
    })
    assert.equal(body, 'upstream-ok:GET')
  } finally {
    server.close()
    upstream.close()
  }
})

test('real Node streams: bodyless HEAD forwards', async () => {
  const { proxyPort, upstream, server } = await bootRealProxy()
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${proxyPort}/api/i/local/head-target`, { method: 'HEAD' }, res => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 200)
  } finally {
    server.close()
    upstream.close()
  }
})

test('real Node streams: POST with body still forwards', async () => {
  const { proxyPort, upstream, server } = await bootRealProxy()
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(`http://127.0.0.1:${proxyPort}/api/i/local/post-target`, { method: 'POST' }, res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => resolve(data))
      })
      req.on('error', reject)
      req.end('payload')
    })
    assert.equal(body, 'upstream-ok:POST')
  } finally {
    server.close()
    upstream.close()
  }
})

test('real Node streams: WS upgrade handshake is not aborted by req close', async () => {
  const upstream = createServer(() => {})
  upstream.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
    socket.end()
  })
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => upstreamPort,
  })
  let upstreamPort = 0
  let server: ReturnType<typeof createServer> | null = null
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as AddressInfo).port
      server = createServer((req, res) => { void proxy.handleHttp(req as any, res as any) })
      server.on('upgrade', (req, socket, head) => { void proxy.handleUpgrade(req as any, socket as any, head) })
      server.listen(0, '127.0.0.1', () => resolve())
    })
  })
  try {
    const got101 = await new Promise<boolean>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: (server!.address() as AddressInfo).port,
        path: '/api/i/local/api/remote.mux',
        headers: {
          connection: 'upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      })
      req.on('upgrade', () => {
        req.destroy()
        resolve(true)
      })
      req.on('response', () => resolve(false))
      req.on('error', () => resolve(false))
      req.end()
    })
    assert.equal(got101, true, 'the WS handshake must reach the upstream (req close must not abort it)')
  } finally {
    server!.close()
    upstream.close()
  }
})

test('WS stream teardown logs the ending leg and lifetime (stability forensics)', async () => {
  // The instance-side mux heartbeat can end
  // a socket with no gateway trace, leaving an instance termination
  // indistinguishable from a client reconnect. One bounded line per
  // stream names the leg that ended the splice and its lifetime; the
  // cause strings are the greppable contract.
  const lines: string[] = []
  const logger = {
    log: (...args: unknown[]) => { lines.push(args.map(String).join(' ')) },
    warn: (...args: unknown[]) => { lines.push(args.map(String).join(' ')) },
    error: (...args: unknown[]) => { lines.push(args.map(String).join(' ')) },
  }
  const upstream = createServer(() => {})
  upstream.on('upgrade', (_req, socket) => {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
    )
    // End the UPSTREAM leg after the handshake: this is the shape an
    // instance-side mux heartbeat termination takes at the proxy (a plain
    // socket close, no error, no gateway trace before this instrument).
    setTimeout(() => { socket.end() }, 120)
  })
  let upstreamPort = 0
  const proxy = createInstanceProxy({
    logger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => upstreamPort,
  })
  let server: ReturnType<typeof createServer> | null = null
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', () => {
      upstreamPort = (upstream.address() as AddressInfo).port
      server = createServer((req, res) => { void proxy.handleHttp(req as any, res as any) })
      server.on('upgrade', (req, socket, head) => { void proxy.handleUpgrade(req as any, socket as any, head) })
      server.listen(0, '127.0.0.1', () => resolve())
    })
  })
  try {
    await new Promise<void>((resolve) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port: (server!.address() as AddressInfo).port,
        path: '/api/i/local/api/remote.mux',
        headers: {
          connection: 'upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      })
      req.on('upgrade', () => resolve())
      req.on('error', () => resolve())
      req.end()
    })
    // Poll until the MATCHING line arrives (not merely any line): an unrelated
    // log line must not end the wait early.
    const closeLine = /WebSocket stream \S+ closed \(upstream close, \d+ms\)/
    for (let i = 0; i < 40 && !lines.some(line => closeLine.test(line)); i += 1) await sleep(25)
    assert.ok(
      lines.some(line => closeLine.test(line)),
      `expected an upstream-close teardown line, got: ${lines.join(' | ')}`,
    )
  } finally {
    server!.close()
    upstream.close()
  }
})

// ---------------------------------------------------------------------------
// SPKI certificate pinning forwarding (design 17 §13.4.2 / S23): the same
// embedded self-signed fixture certs as gateway-provider.test.ts (test
// constants — no openssl at test time), served by a REAL node:https server.
// With a pinned gateway transport the proxy's outbound https connection is
// gated on the pin: a matching peer forwards normally, a mismatching peer is
// an explicit 502 upstream_failed (proxy honesty — never a silent pass), and
// an unpinned transport forwards without the pin gate.
// ---------------------------------------------------------------------------

const CERT_A = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJAMuxiI8oRgl7MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjA4MjgwNDM4MDRaFw0zNjA4MjUwNDM4MDRaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALYDiUAFkzdtkyjr/VrNpyfe3p5c0lLWSy+OtqeRK4db2toYN8aWr+vxFMYT
4HqF/VW0ByfOAl0Mfi3kCZPbAFShUY11oYtoHCIGNyQIP6sf+Uc8a2zjodcm67yG
uS980hNK7e1v19B1L/kIZXncrkS7acXbC905GOihh6U3ZQyAGNva/CRlV4fdn2N2
Ti27Hy2xek9S8guA5/Ck+IEAq1iR0KwVNYcYd1yNBYwOGHCbNoSv+bOS2dKNurB0
SgolQYO7FFHWFCDO1dtPbwZfe8B1ucGCQSrgvSEELMjucaZxKMlRh4odH35Asxo8
ldUIdAwEqMK0rDdVmlDWWcEpQGECAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQB1f5w9ld+gR42JDBgqy/UM8eI4
StDLYWNcOrImEV+OiCwhYDs/zXLk4CH9/MGTK3dypCY8nrfRiQ+JRfZf05sWeTyx
vFUu+tfaAKRiNQ39t+//josjJ2CuZeMctPap+F+YwxpxsDdQIEuAELgdWYAVvog4
nYQ7wAd7xngG/RoHv8hoXN7r+ZBk8+hU53YQ4o8xg5gTw6PFG7fVJ4YUxZC8uK72
yld1ntC7f8QDh0iHd9OEz3a+gs1ygsElBO49Rj58JgZLMBsOOOroowhnIsbVR/hN
E0KrcDN2oPfeHsQOarolqSXpNbJJF+Ue+Xlf9RfZNYLc6z2ntclmBAOHr14l
-----END CERTIFICATE-----
`
const KEY_A = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC2A4lABZM3bZMo
6/1azacn3t6eXNJS1ksvjrankSuHW9raGDfGlq/r8RTGE+B6hf1VtAcnzgJdDH4t
5AmT2wBUoVGNdaGLaBwiBjckCD+rH/lHPGts46HXJuu8hrkvfNITSu3tb9fQdS/5
CGV53K5Eu2nF2wvdORjooYelN2UMgBjb2vwkZVeH3Z9jdk4tux8tsXpPUvILgOfw
pPiBAKtYkdCsFTWHGHdcjQWMDhhwmzaEr/mzktnSjbqwdEoKJUGDuxRR1hQgztXb
T28GX3vAdbnBgkEq4L0hBCzI7nGmcSjJUYeKHR9+QLMaPJXVCHQMBKjCtKw3VZpQ
1lnBKUBhAgMBAAECggEAQVaHoInfzRfyqc/9ROlqRe/FbofXoJD4sHvEqeZ8/7xD
leL3srxJLqN+V5SvEoyi4m8b2ngjdQ+VBBhGL+N//OFkCync8dRPtQ8SIEctw9pY
e+/+iDo20KtSGH0sYRWnu/E78+4gRN6sd/NBqjtD+7xjPfliCuoCPRAvR2nZRmDh
/dyg73uq7CFmZb0Xj5E8+sDLsvgEiJ0ZTsxrR197ga72vSVa703iCdXDK1J03ZMd
3TOJAvbOuyn86KADoXkfss6ZL2422/TZ1F8X/gfs4fZs5aRzFoC+cjpzkkptPJxZ
UcDDa9CyxeFotm3E++HRl2xaqwFjpIS6vYr6O2PT+QKBgQDrSG6jh9pStgA9dCXw
3Y0VJyQRbhjEz13rgD7qCvCHRPoM1MYFg2fQ7sFWEq1sByDV0d8qQIKJ/evohlAe
tgw/5fxpW1/9h8LELmTNqP7eqIyVdPikugOmuo7NgdfhfZIr7O9gIOKlntAiKPgG
silO0WEK6WTUUmwcT85gbHo28wKBgQDGClokuhdBla+nBTwndsdrgLux62TLW+/H
OrCud1a7JMfV0PQWCzYQvraWBW132omu7v9Q3pjxuh3kVIafe+qB6SahaIzfA0xL
YMdp4NPnp7qrCK/oA5IliWwPSj5qpoOmBleFUBGkWSMl703LCD8gbXp7tZ6kAwc6
jpqB+kdoWwKBgGRSNhq0SnsJ74BEjgjt7sIeNlrYPudsI/fObwUMNRL4bkYaU3T2
WsXTh8xTmm59e5qwKh+x8fc0teonmvH9XavBPKcPtxY7VOihf4nRjRsTcx4nCf3y
8quc0FcADjSvfiwMkuTCIOHNnaFzJo50WPiqfl5QthVyL3bC8JRcrJ/RAoGBALBs
Infba8JaZdullzwU3XyQdyT97ZIYOdhDGYii+ZnIH1oERp2oqSZrr16gQS/neIZl
lP9m/dtCEUUKY8+J5ZSLroVWDUDSwFHaSmuxBTW2v12EZKiNHdHgxWotmsMJyffK
aIdzl/PQELbHo4a+tvXdcaLpXgUASZ1J0qz92EVHAoGBANabVLiKqQwy4sN4iwT0
5hmnDnsJgOPgydCv8BOXRl7kFu/qVJuv5t+ENERiOrkFbsGGu3ws1HAXPhZckidF
fQQAwvxZjbNVVo4umyxyqUmZyIgLWVxfWABr30wb35RVK+BdAzk1TANpvPTsAt0I
SGO6VATS9KOAchJ/HFfHpRWb
-----END PRIVATE KEY-----
`
const PIN_A = '74f9461a9ae839c59a07e0d7639bc2c6daa4e97d104b1c3a3076a0f2fcb30d33'
const CERT_B = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJALk7aVPu4lYVMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjA4MjgwNDQ0MjVaFw0zNjA4MjUwNDQ0MjVaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAL7IlWIk7pbIcXeTVCa3phs9N1BZQMquAgsgfg8yXwqyIioSPvF2K+6PiwxP
7gqbir+vVLDwBcvlShXOmShxz6P714AbmsheBAwyX/Gz7uyOoeRo2v0Z42HFe3I2
qWLtHwwGR2UFgEHpHoUKPhft6pW6d5G82YJxOfE0UtgSYDjUFFwiHdzBLepeo6F7
KN7+qXUEZbOe0m7vsWB0+LoU33kQayLTu/pQUMd0Sg+jdNXAczr2MKhvRpESt6l0
ryvezeNqu2cwCmzkuD6mdMHS8O8WDJoaPcxYOgFlAJasiWnRcw0yQZt9nfNsirSt
KqgHTdO5iZdxY80Xn0FpWF4jZusCAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQCJAFkG3Nkf9qdcakZR9q3MLtPI
dElNqw2toAKkgslNEDi68NhI4oHdy/VWUvjv+Io77UR625zXgee4Off+A0Q4+rKC
MSnV+L3vKzVXmQiJe1keSRsJRhHJ5lyCWLQC0cXA8hi2VlhsH3zjsxdss+OkbpVA
cRF/0Zrf8vWmuLvIEHUECDS9FhhK06Ck53MtH4ylUHk1/GYWgxx4fJO5rn5ICGld
GEh/5hgbSIerocTVqopN2wRAwKk6sDi8Mj357LsqBXjOxiG9wM7/970q7HG2wPMD
It601afsP0WIHRkByyugcKQsBIIEPg9XdCP54SymB1Kxa8g9OWzJWNPyCdlg
-----END CERTIFICATE-----
`
const PIN_B = '087ee792a02c84ba6e994244a28449d7ece7ab6cd86b8d4c0c50dafa887d3478'

test('the SPKI pin fixtures are self-consistent in the proxy tests too', () => {
  const pinOf = (pem: string) =>
    createHash('sha256').update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  assert.equal(pinOf(CERT_A), PIN_A)
  assert.equal(pinOf(CERT_B), PIN_B)
})

test('gateway https forward with SPKI pin: match forwards, mismatch is an explicit 502 (S23)', async () => {
  let handlerCalls = 0
  let receivedBodyBytes = 0
  const receivedCredentials: Array<{ authorization?: string; cookie?: string }> = []
  const tlsApplicationBytes: number[] = []
  let tcpConnections = 0
  const server = createHttpsServer({ key: KEY_A, cert: CERT_A }, (req, res) => {
    handlerCalls += 1
    receivedCredentials.push({
      ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
    })
    req.on('data', chunk => { receivedBodyBytes += chunk.length })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  // `secureConnection` exposes decrypted TLS application data. Recording it
  // proves the negative case did not merely avoid the HTTP handler: no
  // request line/header/body byte was written after the mismatched handshake.
  server.on('secureConnection', tlsSocket => {
    const index = tlsApplicationBytes.push(0) - 1
    tlsSocket.on('data', chunk => { tlsApplicationBytes[index] += chunk.length })
  })
  server.on('connection', () => { tcpConnections += 1 })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    // NO injected httpRequest → the real node:https request path runs. The
    // real upstream answers asynchronously (unlike the fake, which emits
    // synchronously inside end()), so each case awaits the response/error
    // completion before asserting.
    const proxy = createInstanceProxy({
      logger: quietLogger,
      getLocalState: () => 'ready',
      getLocalDshPort: () => 17510,
      upstreamTimeoutMs: 2000,
    })
    // Pin match → the request rides through (the pin is the trust anchor —
    // the self-signed chain alone would fail, but the pinned key is trusted).
    proxy.registerTransport('gateway:pinned', `https://127.0.0.1:${port}`, undefined, { tls: { spkiPin: PIN_A } })
    const okRes = fakeResponse()
    const okDone = new Promise<void>(resolve => (okRes as unknown as EventEmitter).once('finish', () => resolve()))
    await proxy.handleHttp(fakeRequest('/api/i/gateway-pinned/api/session/list', 'GET'), okRes)
    await okDone
    assert.equal(okRes.status, 200)
    assert.equal(handlerCalls, 1)

    // Pin mismatch → explicit 502 upstream_failed (proxy honesty: a peer that
    // does not match the pinned key is an upstream failure, never a silent
    // pass-through). Include both sanctioned credentials and a business body:
    // the pre-write gate must hold all of them behind the pin verdict.
    handlerCalls = 0
    receivedBodyBytes = 0
    receivedCredentials.length = 0
    const tlsConnectionsBeforeMismatch = tlsApplicationBytes.length
    const tcpConnectionsBeforeMismatch = tcpConnections
    proxy.registerTransport('gateway:pinned', `https://127.0.0.1:${port}`, {
      authorization: GATEWAY_AUTHORIZATION,
      cookie: 'dsh_gateway_session=must-not-reach-the-wrong-peer',
    }, { tls: { spkiPin: PIN_B } })
    const businessBody = '{"secret":"must-not-reach-the-wrong-peer"}'
    const badRes = fakeResponse()
    let badFinishes = 0
    ;(badRes as unknown as EventEmitter).on('finish', () => { badFinishes += 1 })
    const badDone = new Promise<void>(resolve => (badRes as unknown as EventEmitter).once('finish', () => resolve()))
    await proxy.handleHttp(fakeRequest('/api/i/gateway-pinned/api/session/list', 'POST', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(businessBody)),
    }, businessBody), badRes)
    await badDone
    await sleep(20)
    assert.equal(badRes.status, 502)
    assert.equal(JSON.parse(badRes.body).code, 'upstream_failed')
    assert.equal(handlerCalls, 0, 'a mismatched pin never reaches the TLS server HTTP handler')
    assert.equal(receivedBodyBytes, 0, 'no business body byte reaches a mismatched peer')
    assert.deepEqual(receivedCredentials, [], 'Authorization/Cookie never reach a mismatched peer')
    assert.equal(tcpConnections, tcpConnectionsBeforeMismatch + 1, 'the negative case reached a real TLS server connection')
    assert.equal(
      tlsApplicationBytes.slice(tlsConnectionsBeforeMismatch).reduce((total, bytes) => total + bytes, 0),
      0,
      'no decrypted HTTP request byte is written before the pin matches',
    )
    assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'the failed request lease is released exactly once')
    assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 0, 'the rejected body reservation is released')
    assert.equal(proxy.getDiagnostics().failures, 1, 'the pin failure is counted once')
    assert.equal(badFinishes, 1, 'the loud 502 response is finished once')

    // No pin → the pin machinery is inert: the unpinned https forward against
    // this self-signed chain fails chain validation (502) — the unpinned
    // SUCCESS path is the http tests above; here the point is that an
    // unpinned transport never engages the pin gate.
    proxy.registerTransport('gateway:plain', `https://127.0.0.1:${port}`)
    const plainRes = fakeResponse()
    const plainDone = new Promise<void>(resolve => (plainRes as unknown as EventEmitter).once('finish', () => resolve()))
    await proxy.handleHttp(fakeRequest('/api/i/gateway-plain/api/session/list', 'GET'), plainRes)
    await plainDone
    assert.equal(plainRes.status, 502)
    assert.equal(JSON.parse(plainRes.body).code, 'upstream_failed')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('gateway WS upgrade with SPKI pin: match upgrades, mismatch rejects with 502 (S23)', async () => {
  const server = createHttpsServer({ key: KEY_A, cert: CERT_A })
  let upgradeCalls = 0
  const receivedCredentials: Array<{ authorization?: string; cookie?: string }> = []
  const tlsApplicationBytes: number[] = []
  let tcpConnections = 0
  server.on('secureConnection', tlsSocket => {
    const index = tlsApplicationBytes.push(0) - 1
    tlsSocket.on('data', chunk => { tlsApplicationBytes[index] += chunk.length })
  })
  server.on('connection', () => { tcpConnections += 1 })
  server.on('upgrade', (req, socket) => {
    upgradeCalls += 1
    receivedCredentials.push({
      ...(typeof req.headers.authorization === 'string' ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers.cookie === 'string' ? { cookie: req.headers.cookie } : {}),
    })
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const proxy = createInstanceProxy({
      logger: quietLogger,
      getLocalState: () => 'ready',
      getLocalDshPort: () => 17510,
      upstreamTimeoutMs: 2000,
    })
    // The real upstream handshake answers asynchronously (the fake emits the
    // upgrade synchronously inside end()); await the socket write. The real
    // node:https server only upgrades when the request carries the WebSocket
    // handshake headers (the fake upstream ignored them).
    const wsHeaders = {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    }
    const waitForWrite = async (socket: ReturnType<typeof fakeSocket>): Promise<void> => {
      const deadline = Date.now() + 2000
      while (socket.written === '' && Date.now() < deadline) await sleep(5)
    }
    // Pin match → the upgrade handshake rides through.
    proxy.registerTransport('gateway:pinned-ws', `https://127.0.0.1:${port}`, undefined, { tls: { spkiPin: PIN_A } })
    const okSocket = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/gateway-pinned-ws/api/remote.mux', 'GET', wsHeaders), okSocket, Buffer.alloc(0))
    await waitForWrite(okSocket)
    assert.match(okSocket.written, /101/)
    assert.equal(upgradeCalls, 1)

    // Pin mismatch → the handshake is rejected with an explicit 502, and no
    // HTTP upgrade line/header (including credentials) reaches the peer.
    upgradeCalls = 0
    receivedCredentials.length = 0
    const tlsConnectionsBeforeMismatch = tlsApplicationBytes.length
    const tcpConnectionsBeforeMismatch = tcpConnections
    proxy.registerTransport('gateway:pinned-ws', `https://127.0.0.1:${port}`, {
      authorization: GATEWAY_AUTHORIZATION,
      cookie: 'dsh_gateway_session=must-not-reach-the-wrong-peer',
    }, { tls: { spkiPin: PIN_B } })
    const badSocket = fakeSocket()
    await proxy.handleUpgrade(fakeRequest('/api/i/gateway-pinned-ws/api/remote.mux', 'GET', wsHeaders), badSocket, Buffer.alloc(0))
    await waitForWrite(badSocket)
    await sleep(20)
    assert.match(badSocket.written, /502/)
    assert.equal((badSocket.written.match(/HTTP\/1\.1 502/g) ?? []).length, 1, 'the loud WS rejection is written once')
    assert.equal(upgradeCalls, 0, 'a mismatched pin never reaches the TLS server upgrade handler')
    assert.deepEqual(receivedCredentials, [], 'Authorization/Cookie never reach a mismatched WS peer')
    assert.equal(tcpConnections, tcpConnectionsBeforeMismatch + 1, 'the negative case reached a real TLS server connection')
    assert.equal(
      tlsApplicationBytes.slice(tlsConnectionsBeforeMismatch).reduce((total, bytes) => total + bytes, 0),
      0,
      'no decrypted WS handshake byte is written before the pin matches',
    )
    assert.equal(proxy.getDiagnostics().pendingUpgrades, 0, 'the rejected handshake lease is released exactly once')
    assert.equal(proxy.getDiagnostics().failures, 1, 'the pin failure is counted once')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
