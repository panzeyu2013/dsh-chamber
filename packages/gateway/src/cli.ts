#!/usr/bin/env node
/**
 * dsh-chamber gateway CLI (design 17 §3.1 / §6.6): the server-side access
 * shape's entry point. Mirrors the control-plane standalone.ts arg-parsing
 * style (strict flags, `--key value` / `--key=value`, exit 2 on config error).
 *
 * Usage:
 *   gateway serve [--host 0.0.0.0] [--port 3000]
 *       [--state-dir DIR] [--dsh-path PATH]
 *       [--ui-password PWD] [--api-token TOK] [--cors-origin ORIGIN ...]
 *       [--public-origin URL] [--trusted-proxy IP ...]
 */

import { DEFAULT_STATE_DIR, defaultDshWorkspacePath, type Logger } from '@dsh-chamber/control-plane'
import { GatewayConfigError, parseGatewayConfig } from './config.ts'
import { findDshWorkspace, isDshWorkspace } from './dsh-path.ts'
import { createGateway } from './index.ts'

const HELP = `gateway — dsh-chamber server-side access gateway (design 17)

Usage:
  gateway serve [options]

Options:
  --host ADDR         listen address ('127.0.0.1' | '0.0.0.0', default 127.0.0.1)
  --port N            HTTP port (default 3000)
  --state-dir DIR     state root (default $DSH_GATEWAY_STATE or ~/.dsh-chamber)
  --dsh-path PATH     dsh workspace path (default $DSH_GATEWAY_DSH_PATH or repo default)
  --ui-password PWD   browser password auth (12-1024 characters)
  --api-token TOK     shared bearer token (32-4096 visible ASCII; use a CSPRNG)
  --public-origin URL expected public authority (S11: reject unknown Host with 421)
  --trusted-proxy IP exact reverse-proxy peer allowed to supply X-Forwarded-* (repeatable)
  --cors-origin O     extra allowed origin (repeatable)
  -h, --help          show this help

TLS terminates at a reverse proxy. Configure --public-origin and one or more
exact --trusted-proxy peers; this process intentionally serves HTTP only.

Exit codes: 0 clean shutdown/help, 1 startup failure, 2 configuration error,
130 SIGINT.
`

interface ParsedArgs {
  host?: string
  port?: number
  stateDir?: string
  dshPath?: string
  uiPassword?: string
  apiToken?: string
  publicOrigin?: string
  trustedProxies: string[]
  corsOrigins: string[]
  help: boolean
}

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { corsOrigins: [], trustedProxies: [], help: false }
  let positional = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'serve' && !positional) { positional = true; continue }
    if (arg === '-h' || arg === '--help') { args.help = true; continue }
    let name = arg
    let inlineValue: string | undefined
    const eq = arg.indexOf('=')
    if (eq !== -1) { name = arg.slice(0, eq); inlineValue = arg.slice(eq + 1) }
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue
      if (i + 1 >= argv.length) throw new UsageError(`missing value for ${name}`)
      i += 1
      return argv[i]
    }
    switch (name) {
      case '--host': args.host = takeValue(); break
      case '--port': {
        const raw = takeValue()
        if (!/^\d+$/.test(raw)) throw new UsageError(`invalid --port value: ${raw}`)
        args.port = Number(raw)
        break
      }
      case '--state-dir': args.stateDir = takeValue(); break
      case '--dsh-path': args.dshPath = takeValue(); break
      case '--ui-password': args.uiPassword = takeValue(); break
      case '--api-token': args.apiToken = takeValue(); break
      case '--public-origin': args.publicOrigin = takeValue(); break
      case '--trusted-proxy': args.trustedProxies.push(takeValue()); break
      case '--cors-origin': args.corsOrigins.push(takeValue()); break
      default: throw new UsageError(`unknown option: ${arg}`)
    }
  }
  return args
}

function createLogger(): Logger {
  return {
    log: (...parts: unknown[]) => console.log('[gateway]', ...parts),
    warn: (...parts: unknown[]) => console.warn('[gateway]', ...parts),
    error: (...parts: unknown[]) => console.error('[gateway]', ...parts),
  }
}

async function main(): Promise<number | null> {
  const logger = createLogger()
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(error.message)
      console.error(HELP)
      return 2
    }
    throw error
  }
  if (args.help) {
    console.log(HELP)
    return 0
  }
  const configuredDshPath = args.dshPath ?? process.env.DSH_GATEWAY_DSH_PATH
  if (configuredDshPath !== undefined && !isDshWorkspace(configuredDshPath)) {
    logger.error(`dsh workspace has no supported CLI entry: ${configuredDshPath}`)
    return 2
  }
  const stateDir = args.stateDir ?? process.env.DSH_GATEWAY_STATE ?? DEFAULT_STATE_DIR
  const dshWorkspacePath = configuredDshPath ?? findDshWorkspace(defaultDshWorkspacePath())
  if (dshWorkspacePath === null) {
    logger.error('cannot locate dsh: install @deepseek-ai/dsh globally or pass --dsh-path/DSH_GATEWAY_DSH_PATH')
    return 2
  }
  let config
  try {
    config = parseGatewayConfig({
      host: args.host,
      port: args.port,
      uiPassword: args.uiPassword,
      apiToken: args.apiToken,
      publicOrigin: args.publicOrigin,
      trustedProxies: args.trustedProxies.length === 0 ? undefined : args.trustedProxies,
      corsOrigins: args.corsOrigins,
    }, stateDir, dshWorkspacePath)
  } catch (error) {
    if (error instanceof GatewayConfigError) {
      logger.error(error.message)
      return 2
    }
    throw error
  }
  logger.log(`boot: state dir ${config.plane.stateDir}`)
  logger.log(`boot: dsh workspace ${config.plane.dshWorkspacePath}`)
  logger.log(`boot: bind ${config.plane.host}:${config.plane.port} auth=${config.auth.kind}`)

  const gateway = createGateway({ config, logger })
  let exiting = false
  async function shutdown(signal: string, code: number): Promise<void> {
    if (exiting) return
    exiting = true
    logger.log(`received ${signal}, stopping`)
    try {
      await gateway.stop()
    } finally {
      process.exit(code)
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT', 130))
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0))
  try {
    await gateway.start()
    logger.log('boot: gateway listening; local dsh is ready')
    return null // keep running
  } catch (error) {
    logger.error(`failed to start: ${String(error)}`)
    return 1
  }
}

const code = await main()
if (code !== null) process.exit(code)
