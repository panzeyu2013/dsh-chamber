#!/usr/bin/env node
/**
 * dsh-chamber gateway CLI (design 17 §3): the server-side access
 * shape's entry point. Mirrors the control-plane standalone.ts arg-parsing
 * style (strict flags, `--key value` / `--key=value`, exit 2 on config error).
 *
 * Usage:
 *   gateway serve [--host 0.0.0.0] [--port 3000]
 *       [--state-dir DIR] [--dsh-path PATH]
 *       [--ui-password PWD] [--api-token TOK] [--cors-origin ORIGIN ...]
 *       [--public-origin URL] [--trusted-proxy IP ...] [--no-auth]
 *   gateway auth status [--state-dir DIR]
 *   gateway auth reset-password --new PASSWORD [--state-dir DIR]
 *   gateway auth clear [--state-dir DIR]
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_STATE_DIR, defaultDshWorkspacePath, type Logger } from '@dsh-chamber/control-plane'
import { GatewayConfigError, parseGatewayConfig } from './config.ts'
import { findDshWorkspace, isDshWorkspace } from './dsh-path.ts'
import { createGateway } from './index.ts'
import {
  GatewayAuthUsageError,
  gatewayAuthClear,
  gatewayAuthResetPassword,
  gatewayAuthStatus,
} from './auth-cli.ts'

const HELP = `gateway — dsh-chamber server-side access gateway (design 17)

Usage:
  gateway serve [options]
  gateway auth ...   manage gateway credentials while stopped (gateway auth --help)

Options:
  --host ADDR         listen address ('127.0.0.1' | '0.0.0.0', default 127.0.0.1)
  --port N            HTTP port (default 3000)
  --dsh-port N        first port attempted for the managed dsh host
                      (default 17510; server installs commonly use 30800)
  --state-dir DIR     state root (default $DSH_GATEWAY_STATE or ~/.dsh-chamber)
  --dsh-path PATH     builtin anchor dsh workspace (design 18 §9.3 resolution:
                      $DSH_GATEWAY_DSH_PATH env > runtime override > this anchor;
                      default: repo-adjacent checkout if found)
  --ui-password PWD   browser password auth (12-1024 characters)
  --api-token TOK     shared bearer token (32-4096 visible ASCII; use a CSPRNG)
                      for API/Desktop clients — a token-only deployment has NO
                      browser login/frontend; add --ui-password for browser use
  --public-origin URL expected public authority (design 17 §6 request policy / S3 族:
                      reject unknown Host with 421)
  --trusted-proxy IP exact reverse-proxy peer allowed to supply X-Forwarded-* (repeatable)
  --cors-origin O     extra allowed origin (repeatable)
  --mobile-ua-redirect
                      redirect an authenticated mobile-browser GET/HEAD of / to
                      --mobile-entry (design 17 §18 UA shunting; default off)
  --mobile-entry PATH origin-form target of the mobile UA redirect
                      (default /chamber/mobile.html)
  --no-auth
                      allow an externally-reachable bind with NO auth (S1 override;
                      prints a loud warning — trusted networks only)
  -v, --version       show the installed gateway package version
  -h, --help          show this help

TLS terminates at a reverse proxy. Configure --public-origin and one or more
exact --trusted-proxy peers; this process intentionally serves HTTP only.

Exit codes: 0 clean shutdown/help, 1 startup failure, 2 configuration error,
130 SIGINT.
`

const AUTH_HELP = `gateway auth — manage gateway credentials while the gateway is STOPPED
(design 17 §7 / Phase 3)

reset-password and clear take the stateDir exclusive lock, so a live gateway
is refused loudly. status is a lock-free read-only projection and also works
while the gateway is running. For runtime changes use the browser /chamber/
page or the API (POST /auth/change-password, POST /auth/change-token) instead.

Usage:
  gateway auth status [--state-dir DIR]
  gateway auth reset-password --new PASSWORD [--state-dir DIR]
  gateway auth clear [--state-dir DIR]

Subcommands:
  status           show whether a password/token is configured, its source
                   (config|runtime) and last-write time (non-secret only)
  reset-password   replace the password with a new runtime-managed password
                   (12-1024 characters); rotates the session secret first,
                   so the runtime password survives restarts (config seeding
                   will not overwrite it)
  clear            remove BOTH credentials (password + token); the next start
                   re-seeds from deployment config (--ui-password/--api-token)
                   — a --no-auth deployment returns to anonymous mode

Options:
  --state-dir DIR  state root (default $DSH_GATEWAY_STATE or ~/.dsh-chamber)
  --new PASSWORD   the new password for reset-password
  -h, --help       show this help

Exit codes: 0 success, 1 runtime failure (gateway running / state errors),
2 usage error.
`

interface ParsedArgs {
  command: 'serve' | 'auth'
  // serve options
  host?: string
  port?: number
  dshPort?: number
  stateDir?: string
  dshPath?: string
  uiPassword?: string
  apiToken?: string
  publicOrigin?: string
  trustedProxies: string[]
  corsOrigins: string[]
  allowAnonymousExternal: boolean
  mobileUaRedirect: boolean
  mobileEntryPath?: string
  // auth options
  subcommand?: 'status' | 'reset-password' | 'clear'
  newPassword?: string
  version: boolean
  help: boolean
}

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { command: 'serve', corsOrigins: [], trustedProxies: [], allowAnonymousExternal: false, mobileUaRedirect: false, version: false, help: false }
  let positional = false // 'serve' seen
  let authMode = false
  let subcommandSeen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === 'serve' && !authMode && !positional) { positional = true; continue }
    if (arg === 'auth' && !authMode && !positional) { authMode = true; args.command = 'auth'; continue }
    if (arg === '-h' || arg === '--help') { args.help = true; continue }
    if (arg === '-v' || arg === '--version') { args.version = true; continue }
    if (authMode && !subcommandSeen) {
      if (arg === 'status' || arg === 'reset-password' || arg === 'clear') { args.subcommand = arg; subcommandSeen = true; continue }
      // Flags may precede the subcommand (same leniency as `serve`); anything
      // else at the subcommand position is a usage error.
      if (!arg.startsWith('-')) throw new UsageError(`unknown auth subcommand: ${arg}`)
    }
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
    if (authMode) {
      switch (name) {
        case '--state-dir': args.stateDir = takeValue(); break
        case '--new': args.newPassword = takeValue(); break
        default: throw new UsageError(`unknown option: ${arg}`)
      }
      continue
    }
    switch (name) {
      case '--host': args.host = takeValue(); break
      case '--port': {
        const raw = takeValue()
        if (!/^\d+$/.test(raw)) throw new UsageError(`invalid --port value: ${raw}`)
        args.port = Number(raw)
        break
      }
      case '--dsh-port': {
        const raw = takeValue()
        if (!/^\d+$/.test(raw)) throw new UsageError(`invalid --dsh-port value: ${raw}`)
        args.dshPort = Number(raw)
        break
      }
      case '--state-dir': args.stateDir = takeValue(); break
      case '--dsh-path': args.dshPath = takeValue(); break
      case '--ui-password': args.uiPassword = takeValue(); break
      case '--api-token': args.apiToken = takeValue(); break
      case '--public-origin': args.publicOrigin = takeValue(); break
      case '--trusted-proxy': args.trustedProxies.push(takeValue()); break
      case '--cors-origin': args.corsOrigins.push(takeValue()); break
      case '--mobile-ua-redirect':
        if (inlineValue !== undefined) throw new UsageError('--mobile-ua-redirect takes no value')
        args.mobileUaRedirect = true
        break
      case '--mobile-entry': args.mobileEntryPath = takeValue(); break
      case '--no-auth':
        if (inlineValue !== undefined) throw new UsageError('--no-auth takes no value')
        args.allowAnonymousExternal = true
        break
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

/** `gateway auth <subcommand>`: offline credential management while the
 * gateway is stopped (auth-cli.ts owns the operations). Usage errors exit 2,
 * runtime failures (lock held by a live gateway / state errors) exit 1. */
async function runAuth(args: ParsedArgs, logger: Logger): Promise<number> {
  if (args.subcommand === undefined) {
    logger.error('missing auth subcommand (status | reset-password | clear)')
    console.error(AUTH_HELP)
    return 2
  }
  if (args.subcommand === 'reset-password' && args.newPassword === undefined) {
    logger.error('gateway auth reset-password requires --new PASSWORD')
    console.error(AUTH_HELP)
    return 2
  }
  if (args.subcommand !== 'reset-password' && args.newPassword !== undefined) {
    logger.error('--new is only valid for gateway auth reset-password')
    console.error(AUTH_HELP)
    return 2
  }
  const stateDir = args.stateDir ?? process.env.DSH_GATEWAY_STATE ?? DEFAULT_STATE_DIR
  try {
    if (args.subcommand === 'status') {
      console.log(gatewayAuthStatus(stateDir))
      return 0
    }
    if (args.subcommand === 'reset-password') {
      await gatewayAuthResetPassword(stateDir, args.newPassword as string, logger)
      return 0
    }
    await gatewayAuthClear(stateDir, logger)
    return 0
  } catch (error) {
    if (error instanceof GatewayAuthUsageError) {
      logger.error(error.message)
      return 2
    }
    logger.error(`gateway auth ${args.subcommand} failed: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

async function main(): Promise<number | null> {
  const logger = createLogger()
  const argv = process.argv.slice(2)
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(error.message)
      // An auth-mode parse failure gets the auth help; everything else the
      // serve help (same exit-2 convention).
      console.error(argv.some(arg => arg === 'auth') ? AUTH_HELP : HELP)
      return 2
    }
    throw error
  }
  if (args.help) {
    console.log(args.command === 'auth' ? AUTH_HELP : HELP)
    return 0
  }
  if (args.version) {
    if (args.command !== 'serve' || argv.length !== 1) {
      logger.error('--version cannot be combined with another command or option')
      return 2
    }
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
    console.log(manifest.version)
    return 0
  }
  if (args.command === 'auth') {
    return await runAuth(args, logger)
  }
  // design 18 §9.3: the env override is the highest-priority runtime source,
  // so validate it independently even when --dsh-path supplies a valid
  // builtin anchor. Otherwise a bad env override would survive CLI validation
  // and fail only after the gateway begins its startup transaction.
  const envDshPath = process.env.DSH_GATEWAY_DSH_PATH?.trim()
  if (envDshPath !== undefined && envDshPath !== '' && !isDshWorkspace(envDshPath)) {
    logger.error(`dsh workspace has no supported CLI entry: ${envDshPath}`)
    return 2
  }
  if (args.dshPath !== undefined && !isDshWorkspace(args.dshPath)) {
    logger.error(`dsh workspace has no supported CLI entry: ${args.dshPath}`)
    return 2
  }
  const stateDir = args.stateDir ?? process.env.DSH_GATEWAY_STATE ?? DEFAULT_STATE_DIR
  // design 18 §9.3 anchor semantics: --dsh-path / findDshWorkspace is the
  // BUILTIN ANCHOR; DSH_GATEWAY_DSH_PATH is the runtime env override (highest
  // priority at resolve time). Compatibility: an env-only deployment stays
  // valid — the env path is validated above and doubles as the anchor.
  const anchorPath = args.dshPath ?? findDshWorkspace(defaultDshWorkspacePath())
  const dshWorkspacePath = anchorPath ?? (envDshPath !== undefined && envDshPath !== '' ? envDshPath : null)
  if (dshWorkspacePath === null) {
    logger.error('cannot locate dsh: install @deepseek-ai/dsh globally or pass --dsh-path/DSH_GATEWAY_DSH_PATH')
    return 2
  }
  let config
  try {
    config = parseGatewayConfig({
      host: args.host,
      port: args.port,
      dshPort: args.dshPort,
      uiPassword: args.uiPassword,
      apiToken: args.apiToken,
      publicOrigin: args.publicOrigin,
      trustedProxies: args.trustedProxies.length === 0 ? undefined : args.trustedProxies,
      corsOrigins: args.corsOrigins,
      allowAnonymousExternal: args.allowAnonymousExternal,
      // `=== true ? true : undefined`: an absent flag must NOT pin the
      // option to false, or the DSH_GATEWAY_MOBILE_UA_REDIRECT env fallback
      // in parseGatewayConfig would be unreachable from the CLI (the same
      // undefined-pass-through pattern every other env-backed option uses).
      mobileUaRedirect: args.mobileUaRedirect === true ? true : undefined,
      mobileEntryPath: args.mobileEntryPath,
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

  const gateway = createGateway({ config, logger })
  // The effective auth kind AFTER config seeding (design 17 §7.4): a
  // runtime-managed credential makes `authKind` differ from the deployment
  // config kind — the boot line must not misreport `none` for an actually
  // authenticated deployment.
  logger.log(`boot: bind ${config.plane.host}:${config.plane.port} auth=${gateway.authKind}`)
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
    // Honest boot line (review fix): a blocked runtime startup (swap-attempted
    // / restore-half / restore-incomplete) keeps the gateway up with the
    // managed dsh STOPPED — never print 'local dsh is ready' in that state.
    if (gateway.connectionState === 'ready' || gateway.connectionState === 'degraded') {
      logger.log('boot: gateway listening; local dsh is ready')
    } else {
      logger.error(`boot: gateway listening but local dsh is ${gateway.connectionState} — resume via POST /chamber/runtime/retry-apply|retry-restore or restart the gateway service`)
    }
    return null // keep running
  } catch (error) {
    logger.error(`failed to start: ${String(error)}`)
    return 1
  }
}

const code = await main()
if (code !== null) process.exit(code)
