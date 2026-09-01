/**
 * Gateway credential CLI operations (design 17 §7 / Phase 3): offline
 * (`gateway auth`) management of the persisted credentials while the gateway
 * is STOPPED. Runtime changes belong to the web UI /auth/change-* endpoints;
 * these commands take the stateDir exclusive lock, so a live gateway is
 * rejected loudly (a stale crash-left lock is taken over by the store, which
 * is the correct behavior).
 *
 * Pure functions (no argv parsing, no process.exit — cli.ts owns those), so
 * this module is unit-testable with the node:test suite. Secrets are never
 * printed: status emits only the non-secret projection, and reset-password
 * only reports that a new verifier was persisted.
 */

import { createGatewayStore, hashCredential, readCredentialProjection, type GatewayStore } from './store.ts'
import { MAX_GATEWAY_PASSWORD_CHARS, MIN_GATEWAY_PASSWORD_CHARS } from './config.ts'

export interface GatewayAuthLogger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Usage error (invalid argument values) — the CLI maps it to exit 2.
 * Runtime failures (gateway running, state/file errors) are plain Errors
 * mapped to exit 1. */
export class GatewayAuthUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayAuthUsageError'
  }
}

/** Human-readable, NON-SECRET status of the persisted credentials
 * (source + last-write time only). A damaged/missing stateDir reports
 * `not configured` instead of throwing. */
export function gatewayAuthStatus(stateDir: string): string {
  const projection = readCredentialProjection(stateDir)
  const lines: string[] = []
  lines.push(projection.password === null
    ? 'password: not configured'
    : `password: configured (${projection.password.source}, ${new Date(projection.password.updatedAt).toISOString()})`)
  lines.push(projection.token === null
    ? 'token: not configured'
    : `token: configured (${projection.token.source}, ${new Date(projection.token.updatedAt).toISOString()})`)
  lines.push('non-secret projection: source and last-write time only')
  return lines.join('\n')
}

/** Open the stateDir store with the CLI's lock semantics: a live gateway
 * (live pid in `.gateway.lock`, structured error code 'gateway_locked' +
 * owner pid) fails with a clear message instead of the raw lock error; a
 * stale lock is taken over by the store (correct). */
function acquireStoppedStore(stateDir: string, logger: GatewayAuthLogger, runningHint: string): GatewayStore {
  try {
    return createGatewayStore(stateDir, logger)
  } catch (error) {
    const coded = error as Error & { code?: string; pid?: number }
    if (coded.code === 'gateway_locked') {
      throw new Error(coded.pid !== undefined
        ? `gateway is running (pid ${coded.pid}); ${runningHint}`
        : `gateway is running; ${runningHint}`)
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** Replace the password with a new runtime-managed verifier (design 17 §7).
 * Validates 12–1024 characters (GatewayAuthUsageError on violation), then
 * rotates the session secret FIRST so a failed write never leaves old cookies
 * valid alongside a new verifier (S13 rotate-first discipline). The new
 * password is `source:'runtime'`: config seeding will NOT overwrite it on the
 * next start. */
export async function gatewayAuthResetPassword(stateDir: string, newPassword: string, logger: GatewayAuthLogger = console): Promise<void> {
  if (typeof newPassword !== 'string'
    || newPassword.length < MIN_GATEWAY_PASSWORD_CHARS || newPassword.length > MAX_GATEWAY_PASSWORD_CHARS) {
    throw new GatewayAuthUsageError(`new password must be ${MIN_GATEWAY_PASSWORD_CHARS}-${MAX_GATEWAY_PASSWORD_CHARS} characters`)
  }
  const store = acquireStoppedStore(stateDir, logger, 'use the web UI /auth/change-password instead')
  try {
    store.rotateJwtSecret()
    store.setPasswordCredential(hashCredential(newPassword), 'runtime')
  } finally {
    store.close()
  }
  logger.log('password reset: a runtime-managed password is now active')
  logger.log('the password is runtime-managed: config seeding will not overwrite it on the next start;')
  logger.log('to restore the deployment-config password, revert it via the web UI /auth/change-password while running, or run `gateway auth clear` while stopped')
}

/** Remove BOTH persisted credentials (password + token) while stopped.
 * Rotates the session secret first (kills any old cookies), then deletes the
 * credential files. The next start re-seeds from deployment config; a
 * --no-auth deployment returns to anonymous mode (loud S1 warning). */
export async function gatewayAuthClear(stateDir: string, logger: GatewayAuthLogger = console): Promise<void> {
  const store = acquireStoppedStore(stateDir, logger, 'stop the gateway first, or remove credentials via the web UI /auth/change-*')
  try {
    store.rotateJwtSecret()
    store.setPasswordCredential(null)
    store.setTokenHash(null)
  } finally {
    store.close()
  }
  logger.log('credentials cleared: password-credential and tokens.json removed')
  logger.log('the next start re-seeds credentials from deployment config (--ui-password/--api-token or DSH_GATEWAY_*)')
  logger.warn('if this gateway was deployed with --no-auth, it will be externally reachable with NO authentication after the next start — any host that can reach the port has full access to the managed dsh and its /chamber/ management surface')
}
