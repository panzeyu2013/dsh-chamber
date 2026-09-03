/**
 * Pure row/deny/undo logic for the ssh plugin apply surface (design 21 §6.4
 * ssh 统一增量, plan Phase 5) — no Electron, no fs:
 *
 * - parseSpecName / buildSshApplyRows — name extraction + the RESERVED-name
 *   whole-batch refusal shared by the main-process ssh apply IPC preflight
 *   (before any remote change, matching the gateway same-set deny, decision
 *   19) and applyPlugins' own defense-in-depth deny;
 * - buildSshUndoDecision / describeSshUndoConfirmation — the pure undo
 *   decision over one journal op (ssh-plugin-journal.ts) plus its
 *   confirmation-dialog copy.
 *
 * The whitelists are the control-plane shared single source (plugin-spec.ts
 * via control-plane-module.ts — the same source the gateway routes and the
 * ssh-provider re-exports consume).
 */

import {
  isDeniedPluginName,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
} from './control-plane-module.ts'
import type { SshJournalOp } from './ssh-plugin-journal.ts'

/**
 * Extract the REGISTRY package name of a spec/name: `name`, `name@1.2.3`,
 * `@scope/name`, `@scope/name@1.2.3` → the bare name. Anything that is not a
 * whitelisted registry spec (including `file:`/`link:`/path materialize
 * values, which carry no registry name) → null. The deny paths apply the
 * reserved-name predicate to this parsed name; a file: materialize row's name
 * is only ever known from its manifest row (never from the value itself).
 */
export function parseSpecName(spec: unknown): string | null {
  if (typeof spec !== 'string' || spec === '') return null
  if (!PLUGIN_NAME_PATTERN.test(spec) && !PLUGIN_SPEC_PATTERN.test(spec)) return null
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  return PLUGIN_NAME_PATTERN.test(name) ? name : null
}

/** One assembled ssh apply row (kind + the name it touches + its spec). */
export interface SshApplyRow {
  kind: 'add' | 'remove'
  /** The row's spec (add: the full registry spec; remove: the bare name). */
  spec: string
  /** Parsed registry name of the row; null when the row carries no name. */
  name: string | null
}

export interface BuildSshApplyRowsResult {
  /** Rows whose name parsed (string rows only). */
  rows: SshApplyRow[]
  /** Unique reserved names found across ALL rows — a whole-batch refusal. */
  refused: string[]
}

/**
 * Assemble add/remove rows for the ssh apply surface (pure, tolerant of
 * unknown payload shapes — applyPlugins remains the authority on shape
 * validation): extract each row's name and collect the RESERVED names
 * (official `@deepseek-ai/*` + chamber `@dsh-chamber/*` domains, the same
 * deny set as the gateway install/remove routes and the local dialog row
 * filter). The caller REFUSES THE WHOLE BATCH when `refused` is non-empty —
 * before any remote change (matches the gateway same-set deny, decision 19).
 */
export function buildSshApplyRows(addRows: unknown, removeRows: unknown): BuildSshApplyRowsResult {
  const rows: SshApplyRow[] = []
  const refused = new Set<string>()
  const consider = (kind: 'add' | 'remove', value: unknown): void => {
    if (typeof value !== 'string' || value === '') return
    const name = parseSpecName(value)
    rows.push({ kind, spec: value, name })
    if (name !== null && isDeniedPluginName(name)) refused.add(name)
  }
  if (Array.isArray(addRows)) for (const value of addRows) consider('add', value)
  if (Array.isArray(removeRows)) for (const value of removeRows) consider('remove', value)
  return { rows, refused: [...refused] }
}

/** The reserved-name whole-batch refusal copy (loud, lists the denied
 *  names). Same rationale wording as the gateway 'reserved' refusal. */
export function describeReservedNameRefusal(names: readonly string[]): string {
  return (
    `reserved plugin name(s): ${names.join('、')} — ` +
    '@deepseek-ai/* and @dsh-chamber/* cannot be installed or removed through the plugin model'
  )
}

/** Renderer-facing undo projection shape (design 21 §6.4): what undoing the
 *  latest ok op would do, with the re-add spec MASKED when it would name a
 *  remote-local reference. v1 only supports registry re-adds; a remote
 *  `file:` specBefore is reported as unavailable ('file-backed') and is
 *  never sent to the renderer. */
export interface SshUndoInfo {
  /** The name the undo touches. */
  name: string
  /** Kind of the op being reversed: 'add' — a fresh install is undone by
   *  removing the name again, an in-place upgrade is undone by restoring
   *  `spec`; 'remove' — undone by re-adding with `spec`. */
  kind: 'add' | 'remove'
  /** Registry spec to re-add (restoring an in-place upgrade or undoing a
   *  remove); null when the undo removes the name. REGISTRY form only — a
   *  file:-backed specBefore is masked and marked unavailable, never
   *  projected. */
  spec: string | null
  /** Whether the underlying spec was a file: reference (masked; v1 reports
   *  it unavailable instead of projecting it). */
  masked: boolean
  /** Why this op cannot be undone: 'file-backed' = the previous spec was a
   *  remote file: path (v1 cannot re-add it); 'none' = nothing undoable or
   *  the previous spec is unknown/not a restorable registry value (ranges,
   *  x-wildcards, aliases, …). */
  unavailable?: 'file-backed' | 'none'
}

export type SshUndoDecision =
  | { ok: true; info: SshUndoInfo; action: { kind: 'add'; spec: string } | { kind: 'remove'; name: string } }
  | { ok: false; error: string; info: SshUndoInfo }

/**
 * Is this registry VERSION VALUE an x-wildcard (`1.x`, `^1.2.x`, `x`, …)?
 * An x-wildcard is a RANGE, not a locked version — applyPlugins refuses it
 * (plugin-sync.ts hasXWildcardVersion, the §7.2 semantic gate on top of the
 * syntax whitelist). An undo re-add whose previous spec is wildcard-shaped
 * must be refused HERE (unavailable 'none') so the decision never reports
 * ok:true and then dies in applyPlugins with a confusing 'invalid add spec'.
 * Mirrors hasXWildcard/hasXWildcardVersion semantics (plugin-sync.ts) —
 * pinned against the apply-side gate by the ssh-apply-rows tests.
 */
function isXWildcardVersionValue(value: string): boolean {
  return /(^|\.)x(\.|$)/i.test(value.replace(/^[\^~]/, ''))
}

/**
 * The v1 undo decision over one journal op (design 21 §6.4 + plan Phase 5):
 * undoing a change RESTORES the pre-change row state:
 *   - undoing an ok 'add' whose name was ABSENT before (specBefore null —
 *     a fresh install) = remove that name again;
 *   - undoing an ok 'add' that REPLACED an existing row (specBefore
 *     non-null — an in-place upgrade of an already-installed plugin) =
 *     RESTORE the previous spec by re-adding `name@specBefore` (a plain
 *     remove would delete a plugin that existed before the change — the
 *     design 21 §6.4 「撤销=恢复」 row-level semantics);
 *   - undoing an ok 'remove' = re-add `name@specBefore`.
 * The restore re-add is composed into a REGISTRY spec and only accepted
 * when it stays whitelist-shaped AND locked (no x-wildcard); a remote
 * `file:` specBefore is refused (unavailable 'file-backed'); a missing or
 * out-of-model specBefore is refused (unavailable 'none').
 */
export function buildSshUndoDecision(op: SshJournalOp): SshUndoDecision {
  if (op.kind === 'add' && op.specBefore === null) {
    // Fresh install → undo = remove the name again.
    const info: SshUndoInfo = { name: op.name, kind: 'add', spec: null, masked: false }
    return { ok: true, info, action: { kind: 'remove', name: op.name } }
  }
  return restoreDecision(op)
}

/** Shared restore path: an in-place-upgrade undo (add row with specBefore)
 *  and a remove undo both restore the previous spec the same way. */
function restoreDecision(op: SshJournalOp): SshUndoDecision {
  const specBefore = op.specBefore
  if (specBefore === null) {
    const info: SshUndoInfo = { name: op.name, kind: op.kind, spec: null, masked: false, unavailable: 'none' }
    return { ok: false, error: 'cannot undo: the previous registry spec of this plugin is unknown', info }
  }
  if (/^file:/i.test(specBefore)) {
    const info: SshUndoInfo = { name: op.name, kind: op.kind, spec: null, masked: true, unavailable: 'file-backed' }
    return {
      ok: false,
      error: 'cannot undo: the previous spec of this plugin was a remote file: package (v1 restores registry specs only)',
      info,
    }
  }
  // Registry version value → compose `name@value` and require the composed
  // spec to still be whitelist-shaped AND locked: a non-version value (range,
  // alias, …) or an x-wildcard value cannot be re-added through the ssh
  // apply surface — refused here (none), never a decision that would die in
  // applyPlugins as 'invalid add spec'.
  const spec = `${op.name}@${specBefore}`
  if (!PLUGIN_SPEC_PATTERN.test(spec) || isXWildcardVersionValue(specBefore)) {
    const info: SshUndoInfo = { name: op.name, kind: op.kind, spec: null, masked: false, unavailable: 'none' }
    return {
      ok: false,
      error: `cannot undo: previous spec ${JSON.stringify(specBefore)} is not a locked registry version value`,
      info,
    }
  }
  const info: SshUndoInfo = { name: op.name, kind: op.kind, spec, masked: false }
  return { ok: true, info, action: { kind: 'add', spec } }
}

/** Confirmation-dialog copy builder (pure) for 「撤销最近变更」(design 21
 *  §6.4/§6.7: a user-initiated MAIN-process confirmation, default cancel —
 *  the undo re-executes a remote write + restart through the same ssh apply
 *  flow, never a silent script action). zh-CN copy consistent with the
 *  sibling ssh/local confirmations in plugin-sync.ts. `spec` is non-null
 *  exactly when the undo RE-ADDS a registry spec (restoring an in-place
 *  upgrade or undoing a remove); null when the undo removes the name. */
export function describeSshUndoConfirmation(info: {
  targetLabel: string | null
  targetId: string
  opKind: 'add' | 'remove'
  name: string
  /** Registry re-add spec (undoes that re-add); null when the undo removes
   *  the name. */
  spec: string | null
}): { message: string; detail: string } {
  const target = info.targetLabel ?? info.targetId
  const detailParts: string[] = []
  if (info.spec !== null) {
    // The undo re-adds a registry spec: undoing a remove, or restoring the
    // previous spec of an in-place upgrade (an add that replaced an
    // existing install).
    detailParts.push(
      info.opKind === 'remove'
        ? `最近一次变更是移除插件 ${info.name}。撤销将以 ${info.spec} 从 npm registry 重新安装它（在远端以该实例用户身份执行）。`
        : `最近一次变更是将插件 ${info.name} 更新到新的 registry 版本。撤销将恢复到 ${info.spec}（在远端以该实例用户身份执行）。`,
    )
  } else if (info.opKind === 'add') {
    detailParts.push(`最近一次变更是安装插件 ${info.name}。撤销将把它从远端实例移除。`)
  } else {
    detailParts.push(`最近一次变更是移除插件 ${info.name}。`)
  }
  detailParts.push('撤销执行完成后将重启远端 dsh 实例使变更生效——本实例上的会话会随之重连。')
  return {
    message: `撤销对远程实例 ${target} 的最近插件变更？`,
    detail: detailParts.join('\n'),
  }
}
