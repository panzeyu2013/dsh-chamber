/**
 * Gateway undo = RESTORE (design 21 §6.3 write order / §6.8 r2; the §3 model
 * verb `undoJournal`, gateway implementation).
 *
 * Semantics (deliberately the SAME meaning as the ssh backend's 撤销=恢复, not
 * a remove-only shortcut): undoing the latest successful mutation restores the
 * managed profile's `package.json` and (when the pre-mutation profile had one)
 * `pnpm-lock.yaml` byte-for-byte from that op's preImage backup
 * (`chamber-plugins/third-party/backups/<op-id>/`). A fresh install is
 * therefore undone by returning the manifest to the state without the name; a
 * remove is undone by putting the removed declaration back; an in-place
 * upgrade returns to the prior spec. There is no per-op synthesized
 * add/remove verb — the backup pair IS the restoring material.
 *
 * The undo is itself a mutation (design 21 §6.3):
 *   - it is journaled as its own op (`kind: 'undo'`, `undoOf: <target op id>`),
 *     so GET /chamber/plugins/tasks projects a real terminal state;
 *   - it takes a pre-mutation backup of the CURRENT profile first (its own
 *     `preImage`), so an undo can itself be undone (redo) while the paired
 *     backup directories stay referenced by their ops (the journal's retention
 *     pruning only removes directories no retained op references);
 *   - it runs through the SAME serial executor queue, the SAME
 *     runtime-manager profile-write lease and the SAME read/write fence as
 *     install/remove, and the orchestrator refuses it while another profile
 *     write is in flight (single-flight at the route).
 *
 * Judgement (design 21 §6.11.3/§6.11.4): the inverse direction of the op is
 * re-judged at restore time with the SAME single `decidePluginMutation`
 * the install path uses — undoing an install/materialize removes a name
 * (`protected` refuses it), undoing a remove re-installs the preImage's prior
 * spec (official scope must still be exact-generation). The restore only ever
 * returns to a state that existed before, so the judgement is the conservative
 * "只收紧不放松" guard, never a new capability.
 *
 * Pair discipline ("两文件成对校验"): both backup files are read and validated
 * BEFORE anything is written; the manifest must exist and parse, the lockfile
 * (present in the backup) must be readable. Restore writes the lockfile first
 * (or removes it when the pre-mutation profile had none — an exact restore)
 * and the manifest last (the manifest is the commit point readers consume).
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
 * plugins-installed.ts). The executor's pre-mutation backup applies the same
 * bound; it lives here so the undo pair reader and the backup writer can
 * never disagree. */
export const PROFILE_LOCKFILE_MAX_BYTES = 64 * 1024 * 1024

/** Refusals the undo path can answer in addition to the shared decision
 * codes. `journal_unavailable` is the gateway's own state (503, retryable
 * after the operator resolves the corrupt record); `no_undoable_op` and
 * `preimage_unavailable` are state conflicts over the journal/preImage set
 * (409, the caller re-reads the tasks projection and retries). */
export type UndoRefusalCode = PluginRefusalCode | 'no_undoable_op' | 'journal_unavailable' | 'preimage_unavailable'

/** The newest op the undo verb may consume: the latest `ok` op that carries a
 * preImage reference. NO skipping: when the newest ok op has no preImage (a
 * lost/pruned backup, or a record from an abnormal run), the answer is "no
 * undoable operation", never "silently undo an older change" — a wholesale
 * preImage restore would revert the newer change too. `ops` is newest-first
 * (`journal.recent()`). */
export function latestUndoableOp(ops: readonly JournalOp[]): JournalOp | null {
  const newestOk = ops.find(op => op.status === 'ok')
  if (newestOk === undefined || newestOk.preImage === null) return null
  return newestOk
}

/** A validated preImage pair + its parsed dependency table. */
export interface UndoPreImage {
  target: JournalOp
  manifestText: string
  /** null = the pre-mutation profile had no lockfile (exact restore removes
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

/** Runtime facts consumed by the inverse judgement (same shape the executor's
 * family/decision wiring uses). */
export interface UndoRuntimeFacts { path: string; version: string | null }

/** The inverse-direction judgement (design 21 §6.11.3), run with the SAME
 * single decision implementation as install/remove. */
export function judgeUndo(
  preImage: UndoPreImage,
  facts: UndoRuntimeFacts | null,
): { ok: true } | { ok: false; code: UndoRefusalCode; error: string } {
  const target = preImage.target
  // Undoing an install/materialize restores the manifest WITHOUT the name
  // (the remove direction); undoing a remove restores the declaration with
  // its prior spec (the install direction).
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

/** Restore the validated pair into the managed profile. The lockfile is
 * committed first (removed when the pre-mutation profile had none), the
 * manifest last: the manifest is what readers consume, so a crash can never
 * leave a restored manifest paired with a stale lockfile. */
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
