/**
 * Gateway runtime owner lease: the single-process single-stateDir guard. One
 * gateway per stateDir: O_EXCL create closes the read-check-write TOCTOU, a
 * stale owner
 * with a proven-dead pid is taken over by rename-claim, and any takeover that
 * cannot prove the exact moved bytes and the fresh token fails loud.
 */
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  assertRuntimeRootNoFollow,
  createRuntimeFileExclusiveNoFollow,
  quarantineRuntimeFileNoFollow,
  readPrivateFileNoFollow,
  removeRuntimeFileNoFollow,
  sanitizeErrorText,
  type RuntimeFileIdentity,
} from '@dsh-chamber/dsh-runtime'

function ownerFile(stateRoot: string): string {
  return join(stateRoot, 'owner.json')
}

/**
 * Fail-loud single-process guard (design 18 §9.3): one gateway per stateDir.
 * O_EXCL exclusive create closes the read-check-write TOCTOU — a concurrent
 * second owner gets EEXIST; a stale owner whose pid is dead is taken over.
 * A takeover that cannot prove the exact moved bytes and the exact fresh
 * token fails loud. Unique stale evidence is benign and may remain after an
 * ambiguous durability failure.
 */
const processRuntimeOwnerLeases = new Set<string>()

export interface RuntimeOwnerLease {
  leaseKey: string
  file: string
  token: string
  payload: string
  identity: RuntimeFileIdentity
}

function verifyFreshRuntimeOwner(file: string, payload: string): RuntimeFileIdentity {
  const proof = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
  if (proof.kind !== 'valid' || proof.raw !== payload) {
    throw new Error('gateway runtime owner final proof failed; refusing writer authority')
  }
  return proof.identity
}

function restoreMovedRuntimeOwner(file: string, stale: string, movedRaw: string, movedIdentity: RuntimeFileIdentity): void {
  try {
    const current = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
    if (current.kind !== 'missing') return
    quarantineRuntimeFileNoFollow(dirname(dirname(file)), stale, file, { expectedIdentity: movedIdentity })
    const restored = readPrivateFileNoFollow(file, 16 * 1024, { tightenMode: false })
    if (restored.kind !== 'valid' || restored.raw !== movedRaw) {
      throw new Error('restored owner bytes do not match')
    }
  } catch {
    // Fail-closed: the contender never enters. Exact stale/fresh evidence is
    // retained for the current owner or operator; an unproved restore must
    // never overwrite a third contender.
  }
}

export function assertSingleOwner(baseDir: string, beforeStaleRename?: () => void): RuntimeOwnerLease {
  const stateRoot = assertRuntimeRootNoFollow(baseDir)
  const leaseKey = resolve(stateRoot)
  if (processRuntimeOwnerLeases.has(leaseKey)) {
    throw new Error('this process already owns the gateway runtime stateDir; refusing a second manager')
  }
  const file = ownerFile(stateRoot)
  const token = randomBytes(24).toString('hex')
  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token })}\n`
  try {
    createRuntimeFileExclusiveNoFollow(baseDir, file, payload)
    const identity = verifyFreshRuntimeOwner(file, payload)
    processRuntimeOwnerLeases.add(leaseKey)
    return { leaseKey, file, token, payload, identity }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  // The on-disk record is also authoritative: a same-pid owner is rejected
  // below (covering duplicate loaded copies of this module), a live foreign
  // pid fails loud, and only a dead foreign pid (ESRCH) is taken over.
  let previousPid: number
  const ownerRead = readPrivateFileNoFollow(file, 16 * 1024)
  if (ownerRead.kind !== 'valid') {
    throw new Error('gateway runtime owner record is unsafe or unreadable; refusing to take over without a proven-dead pid')
  }
  try {
    const parsed = JSON.parse(ownerRead.raw) as { pid?: unknown }
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0) {
      throw new Error('invalid pid')
    }
    previousPid = parsed.pid
  } catch {
    throw new Error('gateway runtime owner record is corrupt; refusing to take over without a proven-dead pid')
  }
  if (previousPid === process.pid) {
    // The on-disk record is a second, independent guard. Reject even when a
    // duplicate module/bundle has its own in-memory lease Set; otherwise two
    // managers in one Node process can both write the tree and either dispose
    // can unlink the other's owner record.
    throw new Error(`this process (pid ${process.pid}) already owns the gateway runtime stateDir; refusing a second manager`)
  }
  try {
    process.kill(previousPid, 0)
    throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
  } catch (error) {
    if (error instanceof Error && error.message.includes('another gateway process')) throw error
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`another gateway process (pid ${previousPid}) owns this stateDir; dsh-runtime has no cross-process lock — refusing to start`)
    }
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    // ESRCH: previous owner is gone — take over below.
  }
  // Atomic takeover: rename the stale record out of the way FIRST — whoever
  // renames wins, and a second taker's rename fails ENOENT (fail-loud) instead
  // of racing an unlink that could remove the winner's fresh file.
  const stale = `${file}.stale-${process.pid}-${randomBytes(8).toString('hex')}`
  let movedIdentity: RuntimeFileIdentity
  try {
    movedIdentity = quarantineRuntimeFileNoFollow(baseDir, file, stale, {
      expectedIdentity: ownerRead.identity,
      ...(beforeStaleRename === undefined ? {} : { beforeRename: beforeStaleRename }),
    })
  } catch (error) {
    const displaced = readPrivateFileNoFollow(stale, 16 * 1024, { tightenMode: false })
    if (displaced.kind === 'valid') {
      restoreMovedRuntimeOwner(file, stale, displaced.raw, displaced.identity)
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('another gateway process is starting concurrently against this stateDir; refusing to start')
    }
    throw new Error(`gateway runtime stale owner could not be durably claimed: ${sanitizeErrorText(String(error))}`)
  }
  const moved = readPrivateFileNoFollow(stale, 16 * 1024, { tightenMode: false })
  if (moved.kind !== 'valid' || moved.raw !== ownerRead.raw
    || moved.identity.dev !== movedIdentity.dev || moved.identity.ino !== movedIdentity.ino) {
    if (moved.kind === 'valid') restoreMovedRuntimeOwner(file, stale, moved.raw, moved.identity)
    throw new Error('another gateway process replaced the owner during stale takeover; refusing to start')
  }

  let freshIdentity: RuntimeFileIdentity
  try {
    createRuntimeFileExclusiveNoFollow(baseDir, file, payload)
    freshIdentity = verifyFreshRuntimeOwner(file, payload)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('another gateway process is starting concurrently against this stateDir; refusing to start')
    }
    // Fail loud: a takeover that cannot rewrite the owner record
    // must NOT continue without any owner record — that would silently disable
    // the single-process guard for this stateDir (a concurrent second gateway
    // could then run against the same stateRoot).
    throw new Error(`gateway runtime owner record could not be rewritten: ${sanitizeErrorText(String(error))}`)
  }
  try {
    removeRuntimeFileNoFollow(baseDir, stale, { expectedIdentity: moved.identity })
  } catch {
    // Unique stale evidence is non-authoritative. Retain it when cleanup
    // durability is ambiguous; fresh owner authority was already proven.
  }
  processRuntimeOwnerLeases.add(leaseKey)
  return { leaseKey, file, token, payload, identity: freshIdentity }
}

export function releaseSingleOwner(baseDir: string, lease: RuntimeOwnerLease): void {
  const current = readPrivateFileNoFollow(lease.file, 16 * 1024, { tightenMode: false })
  if (current.kind !== 'valid' || current.raw !== lease.payload) {
    throw new Error('gateway runtime owner token no longer matches; refusing to release another owner')
  }
  let token: unknown
  try { token = (JSON.parse(current.raw) as { token?: unknown }).token } catch { token = null }
  if (token !== lease.token) {
    throw new Error('gateway runtime owner token no longer matches; refusing to release another owner')
  }
  removeRuntimeFileNoFollow(baseDir, lease.file, { expectedIdentity: current.identity })
  // The in-memory lease is released only after the on-disk record was removed.
  processRuntimeOwnerLeases.delete(lease.leaseKey)
}
