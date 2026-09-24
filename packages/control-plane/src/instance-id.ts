/**
 * Control-plane instance identity: one durable UUID at <stateDir>/instance-id.
 * The exclusive-create name becomes visible before its writer finishes the file
 * fsync, so concurrent first starts retry a bounded window then share the winner.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  createPrivateFileExclusiveNoFollow,
  ensurePrivateDirectoryNoFollow,
  readPrivateFileNoFollow,
} from './private-file.ts'

const INSTANCE_ID_MAX_BYTES = 128
const DEFAULT_RETRY_ATTEMPTS = 50
const DEFAULT_RETRY_DELAY_MS = 10
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const sleepCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

export interface InstanceIdDeps {
  randomUUID?: () => string
  /** Number of retries after an observed, stable-but-invalid competing leaf. */
  retryAttempts?: number
  retryDelayMs?: number
  /** Synchronous test seam; production uses Atomics.wait without spinning. */
  sleep?: (delayMs: number) => void
}

export function isValidInstanceId(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function invalidInstanceId(file: string, observed: string): Error & { code: string; transient: boolean } {
  return Object.assign(new Error(`instance-id must contain exactly one UUID: ${file}`), {
    code: 'instance_id_invalid',
    // An O_EXCL winner may be observed before its UUID is fully written; a
    // full-width invalid value is stable evidence and fails immediately.
    transient: observed.length < 36,
  })
}

function readValidatedInstanceId(file: string): string {
  const value = readPrivateFileNoFollow(file, {
    maxBytes: INSTANCE_ID_MAX_BYTES,
    // Startup (write-capable owner) migrates the legacy umask-derived mode, then verifies the pinned inode is owner-only.
    tightenMode: 0o600,
    requiredMode: 0o600,
  }).value.trim()
  if (!isValidInstanceId(value)) throw invalidInstanceId(file, value)
  return value
}

function isTransientCompetingRead(error: unknown): boolean {
  if ((error as { code?: unknown; transient?: unknown }).code === 'instance_id_invalid') {
    return (error as { transient?: unknown }).transient === true
  }
  const message = error instanceof Error ? error.message : ''
  return message.includes('changed while opening')
    || message.includes('changed during read')
    || message.includes('became unsafe before read')
}

/** Read or exclusively create the process owner's durable instance UUID. */
export function ensureInstanceId(stateDir: string, deps: InstanceIdDeps = {}): string {
  const file = join(stateDir, 'instance-id')
  const retryAttempts = deps.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  if (!Number.isInteger(retryAttempts) || retryAttempts < 0
    || !Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('instance-id retry policy must use non-negative integers')
  }
  const sleep = deps.sleep ?? ((delayMs: number) => {
    if (delayMs > 0) Atomics.wait(sleepCell, 0, 0, delayMs)
  })

  // Owns a newly-created root (0700); never chmods an existing caller-selected root as a read side effect.
  ensurePrivateDirectoryNoFollow(stateDir, 0o700, { existingMode: 'preserve' })

  let candidate: string | null = null
  let lastError: unknown = null
  for (let attempt = 0; attempt <= retryAttempts; attempt += 1) {
    try {
      return readValidatedInstanceId(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        candidate ??= (deps.randomUUID ?? randomUUID)()
        if (!isValidInstanceId(candidate)) {
          throw new Error('instance-id generator returned a non-UUID value')
        }
        try {
          createPrivateFileExclusiveNoFollow(file, `${candidate}\n`, { mode: 0o600 })
          return candidate
        } catch (createError) {
          if ((createError as NodeJS.ErrnoException).code !== 'EEXIST') throw createError
          // Another creator owns the visible name, possibly between O_EXCL and fsync.
          lastError = createError
        }
      } else if (isTransientCompetingRead(error)) {
        lastError = error
      } else {
        throw error
      }
    }
    if (attempt < retryAttempts) sleep(retryDelayMs)
  }
  throw new Error(
    `instance-id did not settle to a valid UUID after ${retryAttempts + 1} reads: ${file}`,
    { cause: lastError },
  )
}
