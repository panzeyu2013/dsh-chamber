/**
 * Shared sidecar launch plumbing (2026-12 single-sourcing pass, M13).
 *
 * The compiled-sidecar smoke gate and the GUI-acceptance native leg each
 * carried the same free-loopback-port picker (12 byte-identical lines) and the
 * same launch contract: the required argv shape and the three environment
 * markers the shipped sidecar.js demands (compiled assembly marker, node-
 * as-electron flag, update-check opt-out). The picker and the contract live
 * here; each leg keeps its own process spawning and timeouts.
 */
import { createServer } from 'node:net'

/** The marker that tells a sidecar it runs from the compiled assembly. */
export const SIDECAR_COMPILED_ENV = 'DSH_CHAMBER_SIDECAR_COMPILED'

/** Pick a free loopback port (the sidecar binds it; never a fixed test port). */
export function freeLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

/**
 * The argv the native sidecar is launched with (a throwaway user-data dir and
 * an explicit port, so no leg ever reuses a fixed test port).
 * @param input.userDataDir - the throwaway user-data directory.
 * @param input.port - the picked loopback port.
 * @returns the sidecar argv (without the entry path).
 */
export function sidecarLaunchArgs({ userDataDir, port }) {
  return ['--user-data-dir', userDataDir, '--port', String(port)]
}

/**
 * The environment the shipped sidecar.js requires (compiled assembly marker +
 * no update check).
 * @param base - the environment to extend.
 * @returns the launch environment.
 */
export function sidecarLaunchEnv(base = process.env) {
  return {
    ...base,
    [SIDECAR_COMPILED_ENV]: '1',
    ELECTRON_RUN_AS_NODE: '1',
    DSH_SIDECAR_TEST_NO_UPDATE_CHECK: '1',
  }
}
