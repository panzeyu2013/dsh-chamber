/**
 * Shared gateway-provider loopback servers: an ephemeral node:http probe
 * stub, a node:https stub over an embedded fixture certificate, and the
 * connection:close sync-API stub server.
 * Bare helper file — never registered in scripts/test.mjs.
 */

import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

/** Start a node:http server on an ephemeral loopback port; returns the port
 * and a close handle. `insecureHttp: true` makes the probe speak plain http,
 * so the real verifyGatewayEndpoint path is exercised without TLS. */
export async function startHttpProbeServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

/** Start a real node:https server with an embedded fixture certificate. */
export async function startHttpsProbeServer(
  keyPem: string,
  certPem: string,
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createHttpsServer({ key: keyPem, cert: certPem }, handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

export function startSyncHttpServer(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    // connection: close keeps every stub request on a FRESH socket — several
    // stub handlers answer without consuming the request body, and node's
    // server parser can desync on keep-alive reuse after an unconsumed body
    // (HPE_INVALID_METHOD on the next request), which would corrupt the very
    // settle/restart sequences these tests drive.
    const server = createServer((req, res) => {
      res.setHeader('connection', 'close')
      handler(req, res)
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        port: address.port,
        close: () => new Promise<void>((res, rej) => server.close(err => (err ? rej(err) : res()))),
      })
    })
  })
}
