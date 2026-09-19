/**
 * Shared fixtures for the spawn-dsh suite: the fake dsh CLI entry preamble
 * (cookie-name helper + argv/port bootstrap), the standard spawnHost call over
 * the fixture dirs, and the child-reaping helper. Test-only.
 */
import { createServer as createNetServer } from 'node:net'
import { join } from 'node:path'
import { spawnDsh } from '../../src/spawn-dsh.ts'

/**
 * A dsh port base that is free right now: spawnDsh defaults to 17510, the live
 * chamber instance range, so a developer machine already running the app has
 * every candidate port taken. The contracts under test are port-agnostic.
 */
export async function freeDshPortBase(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createNetServer()
    server.on('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

/** The fake host's cookie-name helper: the host mints its cookie from the Host
 *  header it actually received, exactly like the real BrowserAuth.authorizeIndex. */
export const FAKE_DSH_COOKIE_NAME_JS = [
  "const { createHash } = require('node:crypto')",
  "const authCookieName = host => 'dsh-auth-' + createHash('sha256').update(host).digest('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')",
]

/** The common fake-dsh entry preamble: the cookie-name helper plus the
 *  argv/port bootstrap every fake host script repeats. */
export const FAKE_DSH_PREAMBLE = [
  ...FAKE_DSH_COOKIE_NAME_JS,
  "const { createServer } = require('node:http')",
  "const args = process.argv.slice(2)",
  "const port = Number(args[args.indexOf('--port') + 1])",
]

const quietLogger = { log: (_line: string) => {}, warn: (_line: string) => {}, error: (_line: string) => {} }

/** spawnDsh over the standard fixture dirs and a fresh port base. */
export async function spawnHost(
  stateDir: string,
  dshWorkspacePath: string,
  signal: AbortSignal,
  overrides: Partial<Parameters<typeof spawnDsh>[0]> = {},
): ReturnType<typeof spawnDsh> {
  return spawnDsh({
    dshPortBase: await freeDshPortBase(),
    stateDir,
    dshHome: join(stateDir, 'home'),
    dshWorkspacePath,
    logger: quietLogger,
    signal,
    ...overrides,
  })
}

/** Reap the spawned child (the SpawnAttemptResult child belongs to the caller). */
export async function reapSpawned(
  spawned: { child: { kill(): void; once(event: string, listener: () => void): unknown } },
): Promise<void> {
  spawned.child.kill()
  await new Promise<void>(resolve => spawned.child.once('exit', () => resolve()))
}
