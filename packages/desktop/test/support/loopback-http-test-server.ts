/**
 * Bare loopback test-server helpers shared by the desktop provider suites
 * (test/transport/ssh-provider-endpoint-auth.test.ts binds servers it creates inline with closures;
 * test/gateway/gateway-provider.test.ts keeps its own http/https start helpers around the
 * same two steps). They encode ONLY the listen/close boilerplate: bind an
 * already-created node:http(s) server to 127.0.0.1 on an ephemeral port and
 * read the port AFTER the listen callback fired (never before), and await
 * the server.close callback (a `finally` must always wait for the real close before a test ends).
 *
 * Bare helper file, not a test: the desktop test script enumerates suites
 * explicitly. It lives under test/support/ (with the other desktop harnesses),
 * so it is outside the package's shipped `files` surface by construction.
 */
import type { Server } from 'node:net'

/** Listen on 127.0.0.1:0 and resolve the bound ephemeral port. */
export async function listenEphemeral(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as import('node:net').AddressInfo).port
}

/** Close a loopback server, awaiting the close callback. */
export async function closeLoopbackServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}
