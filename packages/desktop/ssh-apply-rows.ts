/**
 * Pure row/deny/undo logic for the ssh plugin apply surface — no Electron, no fs:
 *
 * - parseSpecName / buildSshApplyRows — name extraction plus the RESERVED-name
 *   whole-batch refusal shared by the main-process ssh apply preflight (before
 *   any remote change) and applyPlugins' defense-in-depth deny;
 * - buildSshUndoDecision / describeSshUndoConfirmation — the pure undo decision
 *   over one journal op plus its confirmation-dialog copy.
 *
 * The whitelists come from the control-plane shared single source
 * (control-plane-module.ts).
 */

import {
  CHAMBER_HOST_PACKAGES,
  decidePluginMutation,
  deriveProtectedSet,
  extractSpecName,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  registrySpecVersion,
} from './control-plane-module.ts'
import type { PluginMutationDecision, ProtectedSet } from './control-plane-module.ts'
import type { SshJournalOp } from './ssh-plugin-journal.ts'

/** S 分量：chamber 播种注册表名（单一来源 CHAMBER_HOST_PACKAGES）。 */
export const SSH_SEED_NAMES: readonly string[] = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.name)

/** ssh 后端的判定事实：只有 `B₀ ∪ S`——远端无 family 事实源，故
 *  `familySource:'none'`（装面官方 scope 一律拒）且 `familyNames:null`。 */
export interface SshProtectionFacts {
  protectedSet: ProtectedSet | null
  runtimeVersion: string | null
  profileState: 'ready' | 'absent'
}

/** ssh 缺省事实：`B₀ ∪ S` + 无族来源 + 版本未知（装面保守、卸面按事实）。 */
export function defaultSshProtectionFacts(): SshProtectionFacts {
  const derived = deriveProtectedSet({ seedNames: SSH_SEED_NAMES, familyNames: null })
  return {
    protectedSet: derived.ok ? derived.set : null,
    runtimeVersion: null,
    profileState: 'ready',
  }
}

/** Extract the REGISTRY package name of a spec/name (`name`, `name@1.2.3`,
 *  `@scope/name`, `@scope/name@1.2.3` → bare name); anything not a whitelisted
 *  registry spec (including `file:`/`link:`/path materialize values) → null —
 *  a materialize row's name is known only from its manifest row. */
export function parseSpecName(spec: unknown): string | null {
  if (typeof spec !== 'string' || spec === '') return null
  if (!PLUGIN_NAME_PATTERN.test(spec) && !PLUGIN_SPEC_PATTERN.test(spec)) return null
  // Extraction delegates to the control-plane core (same lastIndexOf('@') rule
  // as gateway-ipc-shared); the final name re-validation below stays local.
  const name = extractSpecName(spec)
  return PLUGIN_NAME_PATTERN.test(name) ? name : null
}

/** The registry VERSION VALUE a spec pins (`name@<value>` → `<value>`), or
 *  null for a bare name / non-registry value; single source = control-plane.
 *  An official-scope install must carry an exact version. */
export const parseSpecVersion = registrySpecVersion

/** One assembled ssh apply row (kind + the name it touches + its spec). */
export interface SshApplyRow {
  kind: 'add' | 'remove'
  /** The row's spec (add: the full registry spec; remove: the bare name). */
  spec: string
  /** Parsed registry name of the row; null when the row carries no name. */
  name: string | null
}

/** One refused row: the decision (code + copy + optional suggested spec). */
export interface SshApplyRefusal {
  name: string
  kind: 'add' | 'remove'
  /** ALWAYS a refusal: `buildSshApplyRows` drops `defer` (profile absent means
   *  "let the CLI create it"), so a defer can never be mislabeled a refusal. */
  decision: Extract<PluginMutationDecision, { kind: 'refuse' }>
}

export interface BuildSshApplyRowsResult {
  /** Rows whose name parsed (string rows only). */
  rows: SshApplyRow[]
  /** Refused rows across ALL rows — a whole-batch refusal (first refusal per name). */
  refusals: SshApplyRefusal[]
}

/**
 * Assemble add/remove rows for the ssh apply surface (pure; applyPlugins stays
 * the authority on payload shape validation): extract each row's name/version
 * and run the protected-set decision over every row. The caller REFUSES THE
 * WHOLE BATCH when `refusals` is non-empty — before any remote change.
 *
 * ssh facts are `B₀ ∪ S` with no family source: official-scope installs are
 * refused conservatively (an allowed install could shadow the remote anchor's
 * own release packages, unbounded by any local fact), while removes are judged
 * by `B₀ ∪ S` alone (removing an unexpected official copy is restorative).
 */
export function buildSshApplyRows(
  addRows: unknown,
  removeRows: unknown,
  facts: SshProtectionFacts = defaultSshProtectionFacts(),
): BuildSshApplyRowsResult {
  const rows: SshApplyRow[] = []
  const refusals: SshApplyRefusal[] = []
  const refused = new Set<string>()
  const consider = (kind: 'add' | 'remove', value: unknown): void => {
    if (typeof value !== 'string' || value === '') return
    const name = parseSpecName(value)
    rows.push({ kind, spec: value, name })
    if (name === null || refused.has(name)) return
    const decision = decidePluginMutation({
      op: kind === 'add' ? 'install' : 'remove',
      name,
      version: kind === 'add' ? parseSpecVersion(value) : null,
      runtimeVersion: facts.runtimeVersion,
      derivation: facts.protectedSet === null ? null : { ok: true, set: facts.protectedSet },
      profileState: facts.profileState,
      familySource: 'none',
    })
    // Only `refuse` counts: `defer` (profile absent) means "let the CLI
    // create it", not a batch refusal.
    if (decision.kind !== 'refuse') return
    refused.add(name)
    refusals.push({ name, kind, decision })
  }
  if (Array.isArray(addRows)) for (const value of addRows) consider('add', value)
  if (Array.isArray(removeRows)) for (const value of removeRows) consider('remove', value)
  return { rows, refusals }
}

/** The whole-batch refusal copy (loud, names each row and its refusal code). */
export function describePluginRefusals(refusals: readonly SshApplyRefusal[]): string {
  return refusals
    .map(({ name, decision }) => {
      const suggest = decision.suggest === undefined ? '' : `（建议 spec：${decision.suggest}）`
      return `${name} [${decision.code}] ${decision.error}${suggest}`
    })
    .join('；')
}

/** Renderer-facing undo projection: what undoing the latest ok op would do,
 *  with the re-add spec MASKED when it would name a remote-local reference. v1
 *  registry re-adds only; a remote `file:` specBefore is never projected. */
export interface SshUndoInfo {
  /** The name the undo touches. */
  name: string
  /** Op being reversed: 'add' → remove again (fresh install) or restore
   *  `spec` (in-place upgrade); 'remove' → re-add with `spec`. */
  kind: 'add' | 'remove'
  /** Registry spec to re-add (restoring an upgrade or undoing a remove); null
   *  when the undo removes the name. REGISTRY form only — a file:-backed
   *  specBefore is masked, never projected. */
  spec: string | null
  /** Whether the underlying spec was a file: reference (masked, not projected). */
  masked: boolean
  /** Why this op cannot be undone: 'file-backed' = the previous spec was a
   *  remote file: path; 'none' = unknown or not a restorable registry value
   *  (ranges, x-wildcards, aliases, …). */
  unavailable?: 'file-backed' | 'none'
}

export type SshUndoDecision =
  | { ok: true; info: SshUndoInfo; action: { kind: 'add'; spec: string } | { kind: 'remove'; name: string } }
  | { ok: false; error: string; info: SshUndoInfo }

/** Is this registry VERSION VALUE an x-wildcard (`1.x`, `^1.2.x`, `x`, …)?
 *  An x-wildcard is a RANGE, not a locked version — applyPlugins refuses it, so
 *  an undo re-add whose previous spec is wildcard-shaped must be refused HERE
 *  (unavailable 'none') instead of dying later in applyPlugins. */
function isXWildcardVersionValue(value: string): boolean {
  return /(^|\.)x(\.|$)/i.test(value.replace(/^[\^~]/, ''))
}

/**
 * The v1 undo decision over one journal op — undoing a change RESTORES the
 * pre-change row state:
 *   - ok 'add' with specBefore null (fresh install) → remove the name again;
 *   - ok 'add' with specBefore non-null (in-place upgrade) → re-add
 *     `name@specBefore` (a plain remove would delete a pre-existing plugin —
 *     「撤销=恢复」 semantics);
 *   - ok 'remove' → re-add `name@specBefore`.
 * The restore must stay a whitelist-shaped, locked REGISTRY spec: a remote
 * `file:` specBefore is 'file-backed', a missing/out-of-model one 'none'.
 */
export function buildSshUndoDecision(op: SshJournalOp): SshUndoDecision {
  if (op.kind === 'add' && op.specBefore === null) {
    // Fresh install → undo = remove the name again.
    const info: SshUndoInfo = { name: op.name, kind: 'add', spec: null, masked: false }
    return { ok: true, info, action: { kind: 'remove', name: op.name } }
  }
  return restoreDecision(op)
}

/** Shared restore path for an in-place-upgrade undo and a remove undo. */
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
  // Compose `name@value` and require a whitelist-shaped, locked spec: a range,
  // alias or x-wildcard is refused here, never passed on to die in applyPlugins.
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

/** Confirmation-dialog copy builder (pure) for 「撤销最近变更」: user-initiated
 *  MAIN-process confirmation, default cancel — the undo re-executes a remote
 *  write + restart through the same ssh apply flow, never a silent action.
 *  `spec` is non-null exactly when the undo RE-ADDS a registry spec. */
export function describeSshUndoConfirmation(info: {
  targetLabel: string | null
  targetId: string
  opKind: 'add' | 'remove'
  name: string
  /** Registry re-add spec (undoes that re-add); null when the undo removes the name. */
  spec: string | null
}): { message: string; detail: string } {
  const target = info.targetLabel ?? info.targetId
  const detailParts: string[] = []
  if (info.spec !== null) {
    // Undoing a remove, or restoring the previous spec of an in-place upgrade.
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
