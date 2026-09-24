/**
 * Gateway undo = RESTORE: the latest successful mutation is undone by restoring
 * the managed profile's `package.json` and (when present) `pnpm-lock.yaml`
 * byte-for-byte from that op's preImage backup, deliberately the ssh backend's
 * 撤销=恢复 rather than a remove-only shortcut.
 *
 * The undo is itself a mutation: journaled as `kind: 'undo'` with its own preImage
 * (so it can be undone) through the SAME serial executor queue, profile-write lease
 * and fence as install/remove, single-flight at the route. The inverse direction
 * re-judges with the SAME `decidePluginMutation` (conservative "只收紧不放松");
 * both backup files are validated BEFORE any write, then the lockfile is restored first
 * and the manifest last, the commit point readers consume.
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  atomicWritePrivateFileNoFollow,
  decidePluginMutation,
  parsePluginManifest,
  readPrivateFileNoFollow,
  registrySpecVersion,
} from '@dsh-chamber/control-plane'
import type { PluginRefusalCode } from '@dsh-chamber/control-plane'
import {
  deriveBootProtectedSet,
  gatewayProtectedSet,
  INSTALLED_MANIFEST_MAX_BYTES,
  INSTALLED_PROFILE_DIR,
  MANAGED_DSH_HOME_DIR,
} from './plugins-installed.ts'
import { backupDirFor } from './plugins-journal.ts'
import type { JournalOp } from './plugins-journal.ts'
import { messageOf } from './util.ts'

/** Bounded read for the profile lockfile copy (manifest bound comes from
 * plugins-installed.ts), shared with the executor's backup so reader and writer agree. */
export const PROFILE_LOCKFILE_MAX_BYTES = 64 * 1024 * 1024

/** Refusals the undo path can answer besides the shared decision codes:
 * `journal_unavailable` (503, retryable once the corrupt record is resolved) and
 * `no_undoable_op` / `preimage_unavailable` (409 state conflicts — re-read the
 * tasks projection and retry). */
export type UndoRefusalCode = PluginRefusalCode | 'no_undoable_op' | 'journal_unavailable' | 'preimage_unavailable'

/** The newest op the undo verb may consume: the latest `ok` op carrying a preImage
 * reference. NO skipping — when the newest ok op has no preImage (a lost/pruned
 * backup, or an abnormal run) the answer is "no undoable operation", never "silently
 * undo an older change", which would revert the newer one too. `ops` must be newest-first. */
export function latestUndoableOp(ops: readonly JournalOp[]): JournalOp | null {
  const newestOk = ops.find(op => op.status === 'ok')
  if (newestOk === undefined || newestOk.preImage === null) return null
  return newestOk
}

/** A validated preImage pair + its parsed dependency table. */
export interface UndoPreImage {
  target: JournalOp
  manifestText: string
  /** null = the pre-mutation profile had no lockfile (an exact restore removes
   * any current one). */
  lockText: string | null
  dependencies: Record<string, string>
}

export type UndoPreflight =
  | { ok: true; preImage: UndoPreImage }
  | { ok: false; code: UndoRefusalCode; error: string }

/** Read and pair-validate the preImage backup of one op (no writes). */
export function readUndoPreImage(stateDir: string, target: JournalOp): UndoPreflight {
  if (target.preImage === null) {
    return { ok: false, code: 'no_undoable_op', error: `operation ${target.id} carries no preImage backup` }
  }
  const backupDir = backupDirFor(stateDir, target.preImage)
  let manifestText: string
  try {
    manifestText = readPrivateFileNoFollow(join(backupDir, 'package.json'), {
      maxBytes: INSTALLED_MANIFEST_MAX_BYTES,
    }).value
  } catch (error) {
    return {
      ok: false,
      code: 'preimage_unavailable',
      error: `pre-mutation manifest backup of operation ${target.id} is unreadable: ${messageOf(error)}`,
    }
  }
  const parsed = parsePluginManifest(manifestText)
  if (!parsed.ok) {
    return {
      ok: false,
      code: 'preimage_unavailable',
      error: `pre-mutation manifest backup of operation ${target.id} does not parse: ${parsed.fault}`,
    }
  }
  let lockText: string | null = null
  const lockPath = join(backupDir, 'pnpm-lock.yaml')
  if (existsSync(lockPath)) {
    try {
      lockText = readPrivateFileNoFollow(lockPath, { maxBytes: PROFILE_LOCKFILE_MAX_BYTES }).value
    } catch (error) {
      return {
        ok: false,
        code: 'preimage_unavailable',
        error: `pre-mutation lockfile backup of operation ${target.id} is unreadable: ${messageOf(error)}`,
      }
    }
    if (lockText.trim() === '') {
      return {
        ok: false,
        code: 'preimage_unavailable',
        error: `pre-mutation lockfile backup of operation ${target.id} is empty; the backup pair is not consistent`,
      }
    }
  }
  return { ok: true, preImage: { target, manifestText, lockText, dependencies: parsed.dependencies } }
}

/** Runtime facts consumed by the inverse judgement. */
export interface UndoRuntimeFacts { path: string; version: string | null }

/** The inverse-direction judgement, run with the SAME single decision
 * implementation as install/remove. */
export function judgeUndo(
  preImage: UndoPreImage,
  facts: UndoRuntimeFacts | null,
): { ok: true } | { ok: false; code: UndoRefusalCode; error: string } {
  const target = preImage.target
  // Undoing an install/materialize restores the manifest WITHOUT the name (the
  // remove direction); undoing a remove restores the declaration with its prior
  // spec (the install direction).
  const op: 'install' | 'remove' = target.kind === 'remove' ? 'install' : 'remove'
  const priorSpec = preImage.dependencies[target.name]
  if (op === 'install' && priorSpec === undefined) {
    return {
      ok: false,
      code: 'preimage_unavailable',
      error: `the pre-mutation manifest does not declare ${target.name}; the backup cannot undo the remove`,
    }
  }
  const set = facts === null ? null : gatewayProtectedSet(facts)
  const decision = decidePluginMutation({
    op,
    name: target.name,
    version: op === 'install' ? registrySpecVersion(priorSpec ?? null) : null,
    runtimeVersion: facts === null ? null : facts.version,
    derivation: { ok: true, set: set ?? deriveBootProtectedSet() },
    profileState: 'ready',
    familySource: set === null ? 'unavailable' : 'runtime',
  })
  if (decision.kind === 'allow' || decision.kind === 'defer') return { ok: true }
  return { ok: false, code: decision.code, error: decision.error }
}

/** Restore the validated pair into the managed profile: lockfile first (removed
 * when the pre-mutation profile had none), manifest last — the manifest is what
 * readers consume, so a crash cannot leave it paired with a stale lockfile. */
export function restoreUndoPreImage(stateDir: string, preImage: UndoPreImage): void {
  const profileDir = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR)
  const lockPath = join(profileDir, 'pnpm-lock.yaml')
  if (preImage.lockText === null) {
    if (existsSync(lockPath)) rmSync(lockPath, { force: true })
  } else {
    atomicWritePrivateFileNoFollow(lockPath, preImage.lockText, { mode: 0o600 })
  }
  atomicWritePrivateFileNoFollow(join(profileDir, 'package.json'), preImage.manifestText, { mode: 0o600 })
}
