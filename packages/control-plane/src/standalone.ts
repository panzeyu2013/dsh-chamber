#!/usr/bin/env node
/**
 * Standalone control-plane server (design 02 §3.8 / §3.9.2 — the "server
 * serve" deployment shape).
 *
 * Boot order (design 02 §3.8): orphan reaper → spawn the managed host →
 * open the control-plane HTTP port. With the current createControlPlane
 * contract (index.ts), the reaper runs inside start() before the HTTP bind;
 * the managed local dsh host (web profile) is spawned on demand (first POST
 * /api/connections) rather than eagerly at boot — both documented
 * deviations of the v1 assembly.
 *
 * CLI: --port (default 3001), --bind (default 127.0.0.1), --state-dir
 * (default ~/.dsh-chamber / $DSH_CHAMBER_STATE), --dsh-path (optional
 * dshWorkspacePath override), --no-spawn (reserved flag; with an on-demand
 * host it changes nothing today), --help.
 *
 * Exit codes: 0 clean shutdown (SIGTERM) / --help, 1 startup failure,
 * 2 configuration error, 130 SIGINT.
 */

import { statSync } from 'node:fs'
import { createControlPlane, DEFAULT_STATE_DIR, defaultDshWorkspacePath } from './index.ts'
import type { Logger } from './types.ts'

const DEFAULT_PORT = 3001
const DEFAULT_BIND = '127.0.0.1'

const HELP = `dsh-chamber serve — standalone control plane (server deployment shape, design 02 §3.8)

Boot order: orphan reaper (inside start()) → HTTP surface on --port. The
managed local dsh host (web profile) is spawned on demand: first POST
/api/connections {kind:'local'}.

Usage:
  node standalone.ts [serve] [options]

Options:
  --port N          control-plane HTTP port (default ${DEFAULT_PORT})
  --bind ADDR       listen address (default ${DEFAULT_BIND})
  --state-dir DIR   control-plane state root
                    (default $DSH_CHAMBER_STATE or ${DEFAULT_STATE_DIR})
  --dsh-path PATH   dsh workspace path override
                    (default $DSH_CHAMBER_DSH_PATH or <repo>/ref-dsh)
  --no-spawn        do not host a dsh (reserved: with the current contract the
                    host is on-demand, so this flag changes nothing today)
  -h, --help        show this help

Exit codes: 0 clean shutdown/help, 1 startup failure, 2 configuration error,
130 SIGINT.
`

class UsageError extends Error {}

/** The strictly-parsed CLI configuration. */
export interface ParsedArgs {
  port: number
  bind: string
  stateDir: string | undefined
  dshPath: string | undefined
  noSpawn: boolean
  help: boolean
}

/**
 * Parse the CLI args strictly: only the listed flags, `--key value` or
 * `--key=value`, an optional leading `serve` positional. Anything else is a
 * configuration error (exit 2).
 */
function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { port: DEFAULT_PORT, bind: DEFAULT_BIND, stateDir: undefined, dshPath: undefined, noSpawn: false, help: false }
  let positional = false
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]
    if (arg === 'serve' && !positional) {
      positional = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      args.help = true
      continue
    }
    if (arg === '--no-spawn') {
      args.noSpawn = true
      continue
    }
    let name = arg
    let inlineValue: string | undefined
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      name = arg.slice(0, eq)
      inlineValue = arg.slice(eq + 1)
    }
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue
      if (i + 1 >= argv.length) throw new UsageError(`missing value for ${name}`)
      i++
      return argv[i]
    }
    switch (name) {
      case '--port': {
        const raw = takeValue()
        if (!/^\d+$/.test(raw)) throw new UsageError(`invalid --port value: ${raw}`)
        const port = Number(raw)
        if (port < 1 || port > 65535) throw new UsageError(`--port out of range 1..65535: ${raw}`)
        args.port = port
        break
      }
      case '--bind': {
        const value = takeValue()
        if (value === '') throw new UsageError('--bind must not be empty')
        args.bind = value
        break
      }
      case '--state-dir': {
        const value = takeValue()
        if (value === '') throw new UsageError('--state-dir must not be empty')
        args.stateDir = value
        break
      }
      case '--dsh-path': {
        const value = takeValue()
        if (value === '') throw new UsageError('--dsh-path must not be empty')
        args.dshPath = value
        break
      }
      default:
        throw new UsageError(`unknown option: ${arg}`)
    }
  }
  return args
}

function createLogger(): Logger {
  return {
    log: (...parts: unknown[]) => console.log('[control-plane]', ...parts),
    warn: (...parts: unknown[]) => console.warn('[control-plane]', ...parts),
    error: (...parts: unknown[]) => console.error('[control-plane]', ...parts),
  }
}

async function main(): Promise<number | null> {
  const logger = createLogger()

  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(String(error.message))
      console.error(HELP)
      return 2
    }
    throw error
  }
  if (args.help) {
    console.log(HELP)
    return 0
  }

  // A nonexistent --dsh-path is a configuration error: the host could never
  // spawn. Fail at config time instead of at first connection.
  if (args.dshPath !== undefined) {
    try {
      if (!statSync(args.dshPath).isDirectory()) throw new Error('not a directory')
    } catch {
      logger.error(`--dsh-path is not a directory: ${args.dshPath}`)
      return 2
    }
  }

  const stateDir = args.stateDir ?? process.env.DSH_CHAMBER_STATE ?? DEFAULT_STATE_DIR
  const dshWorkspacePath = args.dshPath ?? process.env.DSH_CHAMBER_DSH_PATH ?? defaultDshWorkspacePath()

  logger.log(`boot: state dir ${stateDir}`)
  logger.log(`boot: dsh workspace ${dshWorkspacePath}`)
  logger.log(`boot: bind ${args.bind}:${args.port}`)
  if (args.noSpawn) {
    logger.log('boot: --no-spawn (reserved: today the host spawns on first POST /api/connections; eager boot-spawn is a future contract)')
  }

  const plane = createControlPlane({
    logger,
    port: args.port,
    host: args.bind,
    stateDir,
    dshWorkspacePath,
  })

  let exiting = false
  async function shutdown(signal: string, code: number): Promise<void> {
    if (exiting) return
    exiting = true
    logger.log(`received ${signal}, stopping`)
    try {
      await plane.stop()
    } finally {
      process.exit(code)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT', 130))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))

  try {
    // start() runs the orphan reaper first, then binds the HTTP surface
    // (design 02 §3.8 step 1/4 — the reaper precedes any new spawn).
    await plane.start()
    logger.log(`boot: control plane listening on http://${args.bind}:${plane.port} (reaper ran, local host spawns on demand)`)
    return null // keep running
  } catch (error) {
    logger.error(`failed to start: ${String(error)}`)
    return 1
  }
}

const code = await main()
if (code !== null) process.exit(code)
