/**
 * Remote plugin sync orchestration (desktop main process): pure orchestration +
 * dependency injection (`exec`/`status`), so nothing here imports electron or a
 * real SSH host. Contract A: `restart`; `dsh plugin add/remove` and manifest
 * reads via `exec(id, run, ...)`; file writes via `write-file`; a successful `run`
 * carries the captured stdout that manifest parsing and the hash-skip rely on.
 * SECURITY: renderer specs are re-validated here and every remote path derives
 * from `remoteDshHome`.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
// Insert render/parse/conflict logic is single-sourced in control-plane
// (cordis-inserts.ts via control-plane-module.ts); only fold semantics and
// message wording stay here.
import { hasExactInsert, insertConflict, renderCordisInserts } from './control-plane-module.ts'
import type { CordisInsert, InsertConflictKind } from './control-plane-module.ts'
// Whitelists are single-sourced in control-plane plugin-spec.ts (via the
// facade) so the orchestration-side re-validation, the exec-side argv whitelist
// and the gateway executor can never drift.
import {
  decidePluginMutation,
  derivePluginRows,
  deriveProtectedSet,
  isMaterializedValue,
  MAX_PLUGIN_SPEC_CHARS,
  parsePluginManifest,
  PLUGIN_MATERIALIZED_VALUE_MASK,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  readInstalledVersion,
  readManifestVersion,
  runPluginMutation,
  scrubMutationEnv,
} from './control-plane-module.ts'
import type {
  FamilyVersions,
  MutationChildExecutor,
  PluginManifestParseResult,
  PluginMutationDecision,
  PluginRow,
  ProtectedSet,
} from './control-plane-module.ts'
// Owner-private file primitives (control-plane private-file.ts, via the facade)
// for the local-plugin-writer ledger: 0600 atomic replace, owner-only parent.
import { atomicWritePrivateFileNoFollow, ensurePrivateDirectoryNoFollow, readPrivateFileNoFollow } from './control-plane-module.ts'
// Chamber host-package insert facts derive from control-plane host-graph-seed.ts
// via the facade — the constants below are never re-typed here.
import {
  CHAMBER_HOST_PACKAGES, HOST_ARCHIVE_CLEANUP_INSERT, HOST_GIT_WORKTREE_INSERT, HOST_GRAPH_INSERT,
  HOST_GRAPH_PATCH_FILENAME, HOST_PACKAGE_SEED_FILES,
  type ChamberHostPackageDescriptor, type HostPackageInsert, type HostPackageSeedFile,
} from './control-plane-module.ts'
// ssh protected-set row assembly helpers (parseSpecName / buildSshApplyRows /
// describePluginRefusals) are pure: no Electron, no plugin-sync import (no cycle).
import {
  buildSshApplyRows,
  defaultSshProtectionFacts,
  describePluginRefusals,
  parseSpecName,
  parseSpecVersion,
  type SshProtectionFacts,
} from './ssh-apply-rows.ts'
// ENOENT_PATTERN is shared the same way: ssh-provider classifies the RAW stderr
// line (redaction can hide a `.ssh*`-named home path), so provider-side
// classification and this caller-side test can never drift.
import { ENOENT_PATTERN } from './ssh-provider.ts'
// Contract A types are SHARED from transport-provider.ts (no runtime imports),
// so this pulls no transport-manager/electron surface.
import type { TransportExecAction, TransportRunPayload } from './transport-provider.ts'
// win32 must run pnpm.cjs through node/Electron: Node >=18.20.2/20.12.2 refuses
// to spawn a .cmd without a shell (CVE-2024-27980). Pure module.
import { bundledPnpmEntryCandidates, firstExistingPnpmEntry, pnpmBinDirCandidates, pnpmBinNames, pnpmScriptEntryCandidates, resolvePnpmLauncher } from './pnpm-launcher.ts'
import {
  INSTALL_ENV_WHITELIST,
  RuntimeInstallerSupervisor,
  isRuntimeInstallerWriterSafetyError,
} from '@dsh-chamber/dsh-runtime'
// Failure reasons returned to the main process are sanitized like every desktop
// diagnostic (absolute paths redacted).
import { sanitizeErrorText } from './sanitize-error.ts'

export { PLUGIN_SPEC_PATTERN, PLUGIN_NAME_PATTERN }
// The authoritative chamber host-package registry (name + insert id + liveness
// probe); every desktop consumer derives from this SAME list, never a
// re-declaration.
export { CHAMBER_HOST_PACKAGES }

/** S：chamber 播种注册表名（单一来源 = CHAMBER_HOST_PACKAGES）。 */
export const CHAMBER_SEED_NAMES: readonly string[] = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.name)

/** 写面/读面共用判定事实：`familySource: runtime`（默认）时 familyNames 是已解析的 F，
 * 缺席 ⇒ **降级态**：P 退到 B₀ ∪ S 且官方 scope 的 install 一律被拒（只收紧不放松）；
 * `familySource: none`（ssh）没有族事实源，同上保守形态。 */
export interface PluginProtectionFacts {
  familyNames?: readonly string[] | null
  /** F 内名字的版本集合；缺席 ⇒ 复验退回世代比较，写面判定不需要它。 */
  familyVersions?: FamilyVersions | null
  runtimeVersion?: string | null
  profileState?: 'ready' | 'absent'
  familySource?: 'runtime' | 'none'
}

/** ssh 缺省事实（B₀ ∪ S、无族来源、版本未知）。 */
export function sshProtectionFacts(): PluginProtectionFacts {
  return { familyNames: null, familyVersions: null, runtimeVersion: null, familySource: 'none' }
}

/** 是否把内建运行时线的锚锁文件当成本次 F 的来源。锚描述的是随包发布的那条线；
 * 用户选装或 DSH_CHAMBER_DSH_PATH 的树可能是另一条线，交给它会误判跨代副本。
 * 判据用**版本相等**（而非来源是 bundled）：dev/env 活动树与内建同版时锚更好，
 * 而源码线活动锁文件含 opt-in 段会被判据拒掉。 */
export function shouldPreferPinnedRuntimeLockfile(
  activeVersion: string | null,
  pinnedVersion: string | null,
): boolean {
  return activeVersion !== null && pinnedVersion !== null && activeVersion === pinnedVersion
}

/** 由事实派生受保护集合 + 降级态：本该有 F 但读不到时退到 B₀ ∪ S 并拒官方 scope
 * 的 install（只收紧不放松），第三方行与 remove 面不受影响。 */
export function protectedSetFromFacts(facts: PluginProtectionFacts): ProtectedSet | null {
  return protectedSetState(facts).set
}

/** 派生结果 + 降级标记（写面用它选 `familySource`）。 */
export function protectedSetState(facts: PluginProtectionFacts): { set: ProtectedSet | null; degraded: boolean } {
  const family = facts.familyNames
  const hasFamily = Array.isArray(family) && family.length > 0
  const degraded = facts.familySource !== 'none' && !hasFamily
  const derived = deriveProtectedSet({
    seedNames: CHAMBER_SEED_NAMES,
    familyNames: hasFamily ? family : null,
  })
  return { set: derived.ok ? derived.set : null, degraded }
}

/** 本地/ssh 写面判定包装：把「事实 → P → decide」收敛成一次调用，供 main.ts 的 IPC
 * 前置校验、`runLocalDshPlugin` 的纵深校验与 `applyPlugins` 的整批拒绝共用。 */
export function guardPluginMutation(input: {
  op: 'install' | 'remove'
  name: string | null
  version?: string | null
  facts: PluginProtectionFacts
}): PluginMutationDecision {
  if (input.name === null || input.name === '') {
    return { kind: 'refuse', code: 'invalid-name', error: 'invalid plugin name' }
  }
  const { set, degraded } = protectedSetState(input.facts)
  return decidePluginMutation({
    op: input.op,
    name: input.name,
    version: input.version ?? null,
    runtimeVersion: input.facts.runtimeVersion ?? null,
    derivation: set === null ? null : { ok: true, set },
    profileState: input.facts.profileState ?? 'ready',
    familySource: degraded ? 'unavailable' : (input.facts.familySource ?? 'runtime'),
  })
}

/** ssh 组装事实（ssh-apply-rows 形状），由共享事实派生：IPC 前置校验与
 * applyPlugins 的整批拒绝使用同一份 P。 */
export function sshApplyFacts(facts: PluginProtectionFacts = sshProtectionFacts()): SshProtectionFacts {
  return {
    protectedSet: protectedSetFromFacts(facts),
    runtimeVersion: facts.runtimeVersion ?? null,
    profileState: facts.profileState ?? 'ready',
  }
}

/** 判定 → 面向主进程调用方的错误文案（含建议 spec）。 */
export function describePluginDecision(decision: PluginMutationDecision): string {
  if (decision.kind === 'allow') return ''
  if (decision.kind === 'defer') return `${decision.error} [${decision.code}]`
  const base = `${decision.error} [${decision.code}]`
  return decision.suggest === undefined ? base : `${base}（建议 spec：${decision.suggest}）`
}

// Contract A types imported from transport-provider.ts (single source).


/** The non-secret status surface `applyPlugins` needs for the ready recheck. */
export interface StatusLike {
  phase?: string | null
}

/** Exec outcome: `status` = fresh non-secret projection after systemctl actions;
 * `stdout` = captured stdout (UTF-8, lossy for binary), `stdoutBytes` = RAW bytes
 * for byte-domain consumers; absent stdout on a successful `run` = empty. */
export type ExecResult =
  | { ok: true; status?: StatusLike; stdout?: string; stdoutBytes?: Buffer }
  | { ok: false; error: string }

export type ExecFn = (id: string, action: TransportExecAction, payload?: TransportRunPayload) => Promise<ExecResult>
export type StatusFn = (id: string) => StatusLike | null

/** The instance identity the remote orchestration functions need. */
export interface RemoteSpec {
  id: string
  remoteDshHome: string | null
}

/** Exact owner for one long-running, same-id-sensitive remote saga; object
 * identity prevents an old `finally` from clearing a newer incarnation. */
export interface ExactOwnershipToken {
  readonly id: string
  readonly fingerprint: string
  readonly generation: number
}

/** Per-id single-flight ownership that lets a changed incarnation supersede
 * immediately; Electron-free so the behavior is directly unit-testable. */
export class ExactOwnershipRegistry {
  #generation = 0
  readonly #owners = new Map<string, ExactOwnershipToken>()

  begin(id: string, fingerprint: string):
    | { accepted: true; token: ExactOwnershipToken }
    | { accepted: false; token: ExactOwnershipToken } {
    const current = this.#owners.get(id)
    if (current !== undefined && current.fingerprint === fingerprint) {
      return { accepted: false, token: current }
    }
    this.#generation += 1
    const token = Object.freeze({ id, fingerprint, generation: this.#generation })
    this.#owners.set(id, token)
    return { accepted: true, token }
  }

  owns(token: ExactOwnershipToken): boolean {
    return this.#owners.get(token.id) === token
  }

  revoke(id: string): boolean {
    return this.#owners.delete(id)
  }

  finish(token: ExactOwnershipToken): boolean {
    if (!this.owns(token)) return false
    this.#owners.delete(token.id)
    return true
  }
}

/** Edge tracker for ready-triggered work: repeated ready projections are not
 * lifecycle edges and must not restart a saga. */
export class ReadyPhaseEdges {
  readonly #phases = new Map<string, string>()

  observe(id: string, phase: string): boolean {
    const previous = this.#phases.get(id) ?? 'idle'
    this.#phases.set(id, phase)
    return phase === 'ready' && previous !== 'ready'
  }

  forget(id: string): void {
    this.#phases.delete(id)
  }

  get activeCount(): number {
    return this.#phases.size
  }
}

/** Final completion fence: per-step scoped exec protects the mutation path, and
 * this fence stops a late probe/status/read result from succeeding a same-id
 * replacement. */
export async function runWithFinalOwnership<T>(
  owns: () => boolean,
  operation: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  if (!owns()) return { ok: false, error: 'ssh instance changed while operation was in progress' }
  let result: T
  try {
    result = await operation()
  } catch (error) {
    let detail = 'unknown error'
    try { detail = String(error) } catch { /* hostile thrown value */ }
    return { ok: false, error: `remote operation failed: ${detail}` }
  }
  return owns()
    ? result
    : { ok: false, error: 'ssh instance changed while operation was in progress' }
}

/** Wrap every exec step in an ownership check: a multi-step saga must not
 * continue on a same-id replacement after an await (the transport also
 * terminates the running step). */
export function scopeExecToOwnership(
  exec: ExecFn,
  id: string,
  owns: () => boolean,
): ExecFn {
  return async (execId, action, payload) => {
    if (execId !== id || !owns()) return { ok: false, error: 'ssh instance changed while operation was in progress' }
    let result: ExecResult
    try {
      result = await exec(execId, action, payload)
    } catch (error) {
      let detail = 'unknown error'
      try { detail = String(error) } catch { /* hostile thrown value */ }
      return { ok: false, error: `exec failed: ${detail}` }
    }
    if (!owns()) return { ok: false, error: 'ssh instance changed while operation was in progress' }
    return result
  }
}

// Whitelists imported from the control-plane shared module (plugin-spec.ts via
// control-plane-module.ts) and re-exported for main-process consumers.


export const DEFAULT_REMOTE_DSH_HOME = '~/.dsh'
export const WEB_PROFILE = 'web'
// Chamber host-package seed facts: id/name pairs are control-plane own (host-graph-seed.ts
// via the facade); the desktop keeps the established names because main.ts/tests import them.
export const CLIENT_GRAPH_PACKAGE_NAME = HOST_GRAPH_INSERT.name
export const CLIENT_GRAPH_INSERT_ID = HOST_GRAPH_INSERT.id
export const GIT_WORKTREE_PACKAGE_NAME = HOST_GIT_WORKTREE_INSERT.name
export const GIT_WORKTREE_INSERT_ID = HOST_GIT_WORKTREE_INSERT.id
export const ARCHIVE_CLEANUP_PACKAGE_NAME = HOST_ARCHIVE_CLEANUP_INSERT.name
export const ARCHIVE_CLEANUP_INSERT_ID = HOST_ARCHIVE_CLEANUP_INSERT.id
/**
  * The module-A seed files: the install-level flat fallback carries the SAME set the local
  * seed (HOST_PACKAGE_SEED_FILES) and both probes agree on — DERIVED via the facade, never
  * re-typed (a hand-copied pair is how the remote writer and the gateway upload drift apart).
 * `installed` requires EVERY declared file: package.json alone is a half-injected
 * module A (the boot row could not resolve).
 */
export const SEED_FILES: readonly HostPackageSeedFile[] = HOST_PACKAGE_SEED_FILES

/** The seed member carrying the package manifest — the one probes parse for the
 * installed version; typed by the shared union so dropping it is a compile error. */
const MANIFEST_SEED_FILE: HostPackageSeedFile = 'package.json'

/** Resolve the effective remote dsh home (`~/.dsh` when not configured). */
export function remoteHome(remoteDshHome: string | null): string {
  return remoteDshHome === null || remoteDshHome === undefined || remoteDshHome === ''
    ? DEFAULT_REMOTE_DSH_HOME
    : remoteDshHome
}

export function remoteManifestPath(remoteDshHome: string | null): string {
  return `${remoteHome(remoteDshHome)}/profiles/${WEB_PROFILE}/package.json`
}

export function remotePatchPath(remoteDshHome: string | null): string {
  return `${remoteHome(remoteDshHome)}/profiles/${WEB_PROFILE}/cordis.patch.yml`
}

export function sha256hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Extract the package name from a validated spec (`name@ver`, `@scope/name@ver`);
 * null when unparseable (the caller already whitelist-checked it). */
export function packageNameFromSpec(spec: string): string | null {
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    if (slash === -1) return null
    const rest = spec.slice(slash + 1)
    const at = rest.indexOf('@')
    return at === -1 ? spec : spec.slice(0, slash + 1 + at)
  }
  const at = spec.indexOf('@')
  return at === -1 ? spec : spec.slice(0, at)
}


export type SpecClass =
  | { kind: 'sync' }
  | { kind: 'materialize' }
  | { kind: 'unsyncable'; reason: string }

export function unsyncableReason(spec: string): string {
  if (/^workspace:/i.test(spec)) return 'workspace:* spec is monorepo-internal and cannot be transferred directly'
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/i.test(spec)) return 'git dependency is not synced directly (install manually over ssh)'
  if (/^npm:/i.test(spec)) return 'npm: alias spec is not synced directly'
  if (/^https?:\/\//i.test(spec)) return 'URL spec is not synced directly'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(spec)
  if (scheme !== null) return `unsupported spec scheme "${scheme[1]}:" is not synced directly`
  return 'version range / wildcard / alias spec is not synced directly (use an exact registry spec)'
}

/** Is this value a semver x-wildcard (`1.x`, `x`, `^1.x`)? An x-wildcard is a RANGE,
 * not a locked version; ranges are refused, so this SEMANTIC gate layers on the
 * syntax whitelist (whose char classes let `x` through). */
export function hasXWildcard(versionOrValue: string): boolean {
  const bare = versionOrValue.replace(/^[\^~]/, '')
  return /(^|\.)x(\.|$)/i.test(bare)
}

/** Full-spec form: extract the `@version` part and test it for an x-wildcard. */
export function hasXWildcardVersion(spec: string): boolean {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return false
  return hasXWildcard(spec.slice(at + 1))
}

/** The syncable dependency-VALUE whitelist: the version grammar alone (`^1.0.0`,
 * `~2.0.0`, `1.2.3`, dist-tags) — a value is synced as `<name>@<value>`, so a BARE
 * version must not be judged by the full name@spec grammar. */
export const PLUGIN_VERSION_VALUE_PATTERN = /^(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next)$/

/** Classify a dependency VALUE (not a spec): the materialize arm is the SHARED ruler
 * `isMaterializedValue` (file:/link:/relative/absolute/home/Windows-drive), so
 * desktop, ssh redaction, gateway and browser can never disagree; values matching the
 * version whitelist are syncable, everything else is unsyncable. */
export function classifyDependencyValue(spec: string): SpecClass {
  if (isMaterializedValue(spec)) return { kind: 'materialize' }
  if (PLUGIN_VERSION_VALUE_PATTERN.test(spec)) {
    if (hasXWildcard(spec)) return { kind: 'unsyncable', reason: 'x-wildcard version is a range, not a locked version (use an exact version)' }
    return { kind: 'sync' }
  }
  return { kind: 'unsyncable', reason: unsyncableReason(spec) }
}

// Manifest types (contract B)

/**
 * One chamber host package per-target state — the plugin page chamber-table row. The
 * expected set comes from control-plane own registry, so a new host package appears
 * with no UI or row-list change.
 */
export interface ChamberHostPackageState {
  /** Loader insert id. */
  insertId: string
  /** Package name (profile node_modules dir + loader module specifier). */
  name: string
  /** Remote probed for liveness ('namespace/method'). */
  probe: string
  /** Every declared seed file is present at the target. */
  installed: boolean
  /** The target's loader overlay carries this exact insert row. */
  patched: boolean
  /** Seeded manifest version; null when absent/unreadable — never a guessed default. */
  version: string | null
  /** Live-effect state of the RUNNING instance: true = probe answered (boot row
   * loaded); false = injected but not loaded (restart pending); null = not probed
   * (local / no ready tunnel). LOCAL stays null by design: the page proves itself. */
  live: boolean | null
  /** The registry row is meaningful for the LOCAL shape only. The ssh probe reports
   * `installed:false`/`patched:false` WITHOUT a remote call = not asked, never target
   * lacks it; the view OMITS it on non-local targets, so a synthesized row must never
   * feed a target-level gate (needs-seed/restart). */
  localOnly?: boolean
}

/** `ok:false` = the injection state could not be read (loud, never a silent
 * not-injected). The projection is PER REGISTRY PACKAGE: every loader row lives in
 * the SAME cordis.patch.yml, so `patched` and `live` are judged per package (one
 * insert present does not prove that another row exists). */
export type ChamberInjectionState =
  | { ok: true; packages: ChamberHostPackageState[] }
  | { ok: false; error: string }

export interface RemotePluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  /** Read-face row projection: one row per `dependencies` entry with role +
   * backend-computed `protected`. Composition and seed registry classify but never
   * create rows; render from `rows` when present. */
  rows: PluginRow[]
  profileExists: boolean
  error?: string
  /** Chamber-injected component state probed over the wire — read-only cats, never a write. */
  chamber: ChamberInjectionState
}

export interface UnsyncableEntry {
  name: string
  reason: string
}

export interface LocalPluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  /** Read-face row projection (design 21 §6.11.5) — see RemotePluginManifest.rows. */
  rows: PluginRow[]
  clientLines: string[]
  /** Dependency names whose own package.json declares `dsh.bundle` — the known set the bundles assertion uses. */
  bundleLines: string[]
  unsyncable: UnsyncableEntry[]
  /** Chamber-injected component state (design 09): always readable locally. */
  chamber: ChamberInjectionState
}

export interface PluginApplyResult {
  applied: number
  skipped: number
  failed: { spec: string; error: string }[]
  restarted: boolean
  deferred: boolean
  verified: boolean
  ready: boolean | null
  /** Note when `ready` is null for a NON-deferred restart (the instance was not
   * connected before the apply, so no recheck ran) — never a misleading `ready:false`. */
  readyNote?: string
}

export type RemotePluginListResult = { ok: true; manifest: RemotePluginManifest } | { ok: false; error: string }
export type ApplyPluginsResult = { ok: true; result: PluginApplyResult } | { ok: false; error: string }


/**
 * Parse a remote profile package.json into dependencies + bundles; the model
 * projection has exactly ONE definition (the shared wire `parsePluginManifest`),
 * while JSON faults stay classified the desktop way (`invalid-json`,
 * `not-an-object`).
 */
export function parseRemoteManifest(text: string): { dependencies: Record<string, string>; bundles: string[]; error?: string } {
  const parsed: PluginManifestParseResult = parsePluginManifest(text)
  if (!parsed.ok) {
    return {
      dependencies: {},
      bundles: [],
      error: parsed.fault === 'invalid-json'
        ? `failed to parse remote package.json: ${parsed.detail}`
        : 'remote package.json is not a JSON object',
    }
  }
  return { dependencies: parsed.dependencies, bundles: parsed.bundles }
}

/** The `version` string from a JSON package-manifest text; null when unreadable
 * or version-less — never a guessed default. The judgement is the shared wire
 * `readManifestVersion`; this owns only the text to JSON step. */
function parsePackageVersion(text: string): string | null {
  try {
    return readManifestVersion(JSON.parse(text))
  } catch {
    return null
  }
}

/** Classify one dependency own package.json: `dsh.bundle.patch` → bundle,
 * `dsh.client` → client, anything else → plain. */
export type LocalPluginKind = 'bundle' | 'client' | 'plain'

export function classifyLocalDependency(pkg: unknown): LocalPluginKind {
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return 'plain'
  const dsh = (pkg as Record<string, unknown>).dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return 'plain'
  const d = dsh as Record<string, unknown>
  const bundle = d.bundle
  if (bundle !== null && typeof bundle === 'object' && !Array.isArray(bundle)
    && (bundle as Record<string, unknown>).patch !== undefined) {
    return 'bundle'
  }
  const client = d.client
  if (client !== null && typeof client === 'object' && !Array.isArray(client)) return 'client'
  return 'plain'
}


/**
 * Read the LOCAL profile manifest from the authoritative local dsh home, project
 * `dependencies` + `dsh.profile.bundles`, classify each dependency node_modules
 * package as bundle/client/plain, and flag unsyncable VALUES by the value grammar.
 * Names are whitelist-checked before any node_modules read (path traversal). Throws
 * on an unreadable/malformed manifest. `rows` is the dependency table with
 * backend-computed role/protected flags; B₀ and S only CLASSIFY rows.
 */
export function localPluginList(localDshHome: string, facts?: PluginProtectionFacts): LocalPluginManifest {
  // The protected flags come from CALLER-supplied runtime facts; without them F is
  // unknown, but B₀ ∪ S is a CONSTANT and always applied — `protected` is `name ∈ P`.
  const protectedSet = facts === undefined
    ? protectedSetState({ familyNames: null, familySource: 'none' }).set
    : protectedSetFromFacts(facts)
  const profileDir = join(localDshHome, 'profiles', WEB_PROFILE)
  const manifestPath = join(profileDir, 'package.json')
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read local profile manifest (${manifestPath}): ${String(error)}`)
  }
  // The parse body is the wire single source: the dependencies projection and the
  // `dsh.profile.bundles` walk are defined once there, never mirrored here.
  const parsed: PluginManifestParseResult = parsePluginManifest(text)
  if (!parsed.ok) {
    throw new Error(parsed.fault === 'invalid-json'
      ? `cannot read local profile manifest (${manifestPath}): ${parsed.detail}`
      : `local profile manifest is not a JSON object (${manifestPath})`)
  }
  const { dependencies, bundles } = parsed
  const clientLines: string[] = []
  const bundleLines: string[] = []
  const unsyncable: UnsyncableEntry[] = []
  for (const [name, spec] of Object.entries(dependencies)) {
    // Path-traversal defense: never join an unvalidated name into a path.
    if (!PLUGIN_NAME_PATTERN.test(name)) {
      unsyncable.push({ name, reason: 'package name is not a safe registry name' })
      continue
    }
    const pkg = readDependencyManifest(profileDir, name)
    const kind = pkg !== null ? classifyLocalDependency(pkg) : 'plain'
    if (kind === 'client') clientLines.push(name)
    if (kind === 'bundle') bundleLines.push(name)
    // The VALUE uses classifyDependencyValue: `^1.0.0`/`~2.0.0` are ordinary
    // registry ranges → syncable (the full name@spec grammar would reject a bare
    const cls = classifyDependencyValue(spec)
    if (cls.kind === 'unsyncable') unsyncable.push({ name, reason: cls.reason })
  }
  const rows = derivePluginRows({
    dependencies,
    bundles,
    protectedSet,
    seedNames: CHAMBER_SEED_NAMES,
    // Memoize the rows derivation for this call so a 200-dependency profile does not
    // pay 200 disk reads; a mutation between two list calls re-reads.
    installedVersion: (() => {
      const cache = new Map<string, string | null>()
      return (name: string) => {
        if (!cache.has(name)) cache.set(name, readInstalledVersion(profileDir, name))
        return cache.get(name) ?? null
      }
    })(),
  })
  return {
    dependencies,
    bundles,
    rows,
    clientLines,
    bundleLines,
    unsyncable,
    // Each registry row is probed for the same two facts the remote probe uses: both
    // seed files present, and the exact insert row in the profile patch layer OR the
    // `--patch` overlay — per package; `live` stays null locally.
    chamber: {
      ok: true,
      packages: CHAMBER_HOST_PACKAGES.map((descriptor): ChamberHostPackageState => ({
        insertId: descriptor.insert.id,
        name: descriptor.insert.name,
        probe: descriptor.probe.method,
        // installed = BOTH seed files present — the same two-file definition as the
        // remote probe and the seed writer: a package.json without dist/index.js is a
        // half-injected package (the boot row could not resolve) and reports 未注入.
        installed: SEED_FILES.every(relative =>
          existsSync(join(profileDir, 'node_modules', descriptor.insert.name, relative))),
        patched: localChamberRowPatched(localDshHome, descriptor.insert),
        version: readManifestVersion(readDependencyManifest(profileDir, descriptor.insert.name)),
        live: null,
        // A local-shape-only row is reported as the registry declares it; the view lists it
        // here and omits it remotely. The field is written only when true (normal rows have no key).
        ...(descriptor.localOnly === true ? { localOnly: true as const } : {}),
      })),
    },
  }
}


/**
 * Mask local-path dependency values in the renderer projection: IPC must never echo
 * local absolute paths (a remote client bundle runs in this page); the mask keeps the
 * `file:` prefix so the shared `isMaterializedValue` classifiers and name-based
 * diffing still work.
 */
export const MATERIALIZED_VALUE_MASK = PLUGIN_MATERIALIZED_VALUE_MASK

/**
 * Project the LOCAL manifest for the renderer: materialize-valued dependencies become
 * MATERIALIZED_VALUE_MASK; names, kinds, bundles, unsyncable entries and the chamber
 * block pass through. The main-process-internal manifest is never projected.
 */
export function redactLocalPluginManifest(manifest: LocalPluginManifest): LocalPluginManifest {
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    dependencies[name] = isMaterializedValue(spec) ? MATERIALIZED_VALUE_MASK : spec
  }
  return { ...manifest, dependencies, rows: maskRowSpecs(manifest.rows, dependencies) }
}

/**
 * Row specs follow the manifest masking rule (a masking backend must not leak through
 * `rows` what `dependencies` masks); idempotent.
 */
function maskRowSpecs(rows: readonly PluginRow[], masked: Record<string, string>): PluginRow[] {
  return rows.map(row => {
    const spec = row.spec === null ? null : (masked[row.name] ?? row.spec)
    return spec === row.spec ? row : { ...row, spec }
  })
}

/**
 * Project a REMOTE manifest for the renderer: a dependency VALUE naming a
 * machine-local path would expose the remote filesystem. The judge is the SHARED
 * `isMaterializedValue` ruler — exactly the gateway installed-plugins semantics, so
 * the backends cannot disagree. The mask keeps the `file:` prefix for classifiers and
 * name-based diffing; names, bundles, profileExists, error and chamber pass through;
 * the main-process-internal manifest is never projected.
 */
export function redactRemotePluginManifest(manifest: RemotePluginManifest): RemotePluginManifest {
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    dependencies[name] = isMaterializedValue(spec) ? MATERIALIZED_VALUE_MASK : spec
  }
  return { ...manifest, dependencies }
}

/** Confirmation-dialog copy: pack-and-transfer. */
export function describeMaterializeConfirmation(info: {
  pluginName: string
  pluginPath: string
  targetLabel: string | null
  targetId: string
}): { message: string; detail: string } {
  const target = info.targetLabel ?? info.targetId
  return {
    message: `将本地插件 ${info.pluginName} 发送到远程实例？`,
    detail: `插件目录：${info.pluginPath}\n目标实例：${target}\n\n该插件的源码将被打包并上传到目标服务器。`,
  }
}

/** Confirmation-dialog copy: local install. */
export function describeLocalPluginAddConfirmation(spec: string): { message: string; detail: string } {
  return {
    message: `安装插件 ${spec} 到本地 dsh？`,
    detail: `将从 npm registry 安装 ${spec} 到本地 dsh profile。\n该插件的客户端代码将在下次本地实例启动时于本应用内执行。`,
  }
}

/** Confirmation-dialog copy: local remove. */
export function describeLocalPluginRemoveConfirmation(name: string): { message: string; detail: string } {
  return {
    message: `从本地 dsh 移除插件 ${name}？`,
    detail: `将从本地 dsh profile 卸载 ${name}。`,
  }
}

/** Confirmation-dialog copy: manual chamber host seed (persistent remote modification). */
export function describeSeedConfirmation(info: { targetLabel: string | null; targetId: string }): { message: string; detail: string } {
  const target = info.targetLabel ?? info.targetId
  return {
    message: `向远程实例 ${target} 注入 chamber 宿主组件？`,
    detail: `将在远端实例 ${target} 上写入 chamber host 包并挂载 boot 层（幂等，已是最新则跳过）。\n注入内容来自本机已构建的 chamber 包，重启远端 dsh 后生效。`,
  }
}

/** Confirmation-dialog copy: remote plugin apply (persistent registry add/remove). */
export function describePluginApplyConfirmation(info: {
  targetLabel: string | null
  targetId: string
  add: string[]
  remove: string[]
  restart: boolean
}): { message: string; detail: string } {
  const target = info.targetLabel ?? info.targetId
  const parts: string[] = []
  if (info.add.length > 0) parts.push(`安装 ${info.add.length} 个插件（${info.add.slice(0, 3).join('、')}${info.add.length > 3 ? ' 等' : ''}）`)
  if (info.remove.length > 0) parts.push(`移除 ${info.remove.length} 个插件（${info.remove.slice(0, 3).join('、')}${info.remove.length > 3 ? ' 等' : ''}）`)
  if (info.restart) parts.push('并重启远端 dsh 实例')
  return {
    message: `修改远程实例 ${target} 的插件？`,
    detail: `将在远端实例 ${target} 上${parts.join('，')}。\n这些插件安装自 npm registry，将在远端以该实例用户身份执行。`,
  }
}

/**
 * Whether the local `--patch` overlay carries one chamber loader row. The filename is
 * control-plane own export (`HOST_GRAPH_PATCH_FILENAME`, via the facade) and lives
 * next to the dsh home (`dirname(localDshHome)`), so reading it reads the mount set of
 * the spawn that wrote it (written when `--patch` is passed, removed otherwise);
 * judged per package. Unreadable/absent → false, never a guessed patched.
 */
function localOverlayCarriesInsert(localDshHome: string, insert: HostPackageInsert): boolean {
  const overlayPath = join(dirname(localDshHome), HOST_GRAPH_PATCH_FILENAME)
  if (!existsSync(overlayPath)) return false
  try {
    return hasExactInsert(readFileSync(overlayPath, 'utf8'), registryInsertToCordis(insert))
  } catch {
    return false
  }
}

/**
 * Whether the LOCAL profile own patch layer carries the row: the SECOND mount source
 * (the control plane reuses an exact row here instead of repeating it in the overlay —
 * duplicate loader identities across layers fail the boot), so an overlay-only check
 * would report a mounted row as 未注入. Unreadable/absent → false.
 */
function localProfilePatchCarriesInsert(localDshHome: string, insert: HostPackageInsert): boolean {
  const patchPath = join(localDshHome, 'profiles', WEB_PROFILE, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return false
  try {
    return hasExactInsert(readFileSync(patchPath, 'utf8'), registryInsertToCordis(insert))
  } catch {
    return false
  }
}

/**
 * Whether one chamber loader row is in the LOCAL composed tree: the profile patch
 * layer OR the `--patch` overlay — both are exact-insert checks; neither alone is the
 * whole mount set, and the probe never infers from time or mere file presence.
 */
function localChamberRowPatched(localDshHome: string, insert: HostPackageInsert): boolean {
  return localProfilePatchCarriesInsert(localDshHome, insert)
    || localOverlayCarriesInsert(localDshHome, insert)
}

/** Resolve one materialize dependency from the authoritative local manifest: the
 * renderer supplies only the name; relative specs anchor at the web profile dir. */
export function resolveLocalMaterializeDirectory(
  localDshHome: string,
  name: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (!PLUGIN_NAME_PATTERN.test(name)) return { ok: false, error: 'invalid plugin name' }
  let manifest: LocalPluginManifest
  try {
    manifest = localPluginList(localDshHome)
  } catch {
    return { ok: false, error: 'local plugin manifest is unreadable' }
  }
  const spec = manifest.dependencies[name]
  // Same shared ruler as classification/redaction (`isMaterializedValue`): the
  // resolver can never accept a value the projection masks differently, or vice versa.
  if (typeof spec !== 'string' || !isMaterializedValue(spec)) {
    return { ok: false, error: 'plugin is not a materialize dependency in the local manifest' }
  }
  let raw = spec
  if (raw.startsWith('file:')) raw = raw.slice('file:'.length)
  else if (raw.startsWith('link:')) raw = raw.slice('link:'.length)
  const profileDir = join(localDshHome, 'profiles', WEB_PROFILE)
  const candidate = raw.startsWith('~/')
    ? join(homedir(), raw.slice(2))
    : isAbsolute(raw) ? raw : resolve(profileDir, raw)
  try {
    const real = realpathSync(candidate)
    if (!statSync(real).isDirectory()) return { ok: false, error: 'plugin path is not a directory' }
    const pkg = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { name?: unknown }
    if (pkg.name !== name) return { ok: false, error: 'plugin package name does not match the local manifest entry' }
    return { ok: true, path: real }
  } catch {
    // This result crosses into the renderer: keep the resolved local path inside the
    // main process even on ENOENT/permission failures.
    return { ok: false, error: 'plugin directory is unreadable' }
  }
}

/** Read `<profile>/node_modules/<name>/package.json`; null when absent/unreadable. */
function readDependencyManifest(profileDir: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}


export async function remotePluginList(
  exec: ExecFn,
  spec: RemoteSpec,
  opts?: { liveProbe?: ChamberLiveProbe },
): Promise<RemotePluginListResult> {
  const path = remoteManifestPath(spec.remoteDshHome)
  // Quiet handling: an uninitialized remote profile ENOENTs the manifest cat — expected,
  // and must not write an ERROR log line; ENOENT = profile uninitialized, ssh failure loud.
  const result = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [path], quiet: true })
  if (!result.ok) {
    if (ENOENT_PATTERN.test(result.error)) {
      return {
        ok: true,
        manifest: {
          dependencies: {},
          bundles: [],
          rows: derivePluginRows({
            dependencies: {},
            bundles: [],
            protectedSet: protectedSetFromFacts(sshProtectionFacts()),
            seedNames: CHAMBER_SEED_NAMES,
          }),
          profileExists: false,
          chamber: await probeRemoteChamber(exec, spec, opts),
        },
      }
    }
    return { ok: false, error: result.error }
  }
  const parsed = parseRemoteManifest(result.stdout ?? '')
  return {
    ok: true,
    manifest: {
      dependencies: parsed.dependencies,
      bundles: parsed.bundles,
      // ssh facts are B₀ ∪ S (no remote family source): official-scope installs are
      // refused by the write face, removals are judged by those facts.
      rows: derivePluginRows({
        dependencies: parsed.dependencies,
        bundles: parsed.bundles,
        protectedSet: protectedSetFromFacts(sshProtectionFacts()),
        seedNames: CHAMBER_SEED_NAMES,
        // `protected` = exactly name ∈ P; ssh install conservatism is a target capability, not
        // a read-face fact (marking official rows protected would hide a REMOVE the write face
        // allows). Rows mask materialize VALUES via the shared ruler, like redaction does.
        maskSpec: spec => (isMaterializedValue(spec) ? MATERIALIZED_VALUE_MASK : spec),
      }),
      profileExists: true,
      error: parsed.error,
      chamber: await probeRemoteChamber(exec, spec, opts),
    },
  }
}

/** Per-package liveness probe (the registry descriptor names the Remote). */
export type ChamberLiveProbe = (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null>

/**
 * Read-only probe of the chamber host-graph state on a remote instance: the seed files
 * at the install-level flat fallback plus the profile cordis.patch.yml inserts, checked
 * PER package (one insert present does not prove another). One quiet `cat` per
 * declared file: ENOENT = not injected; any other ssh failure is loud, never a silent
 * not-injected; `installed` requires EVERY declared file. The version comes from the
 * same cat; with a `liveProbe` the result reports the live tri-state.
 */
async function probeRemoteChamber(
  exec: ExecFn,
  spec: RemoteSpec,
  opts?: { liveProbe?: (descriptor: ChamberHostPackageDescriptor) => Promise<boolean | null> },
): Promise<ChamberInjectionState> {
  const home = remoteHome(spec.remoteDshHome)
  // One patch read for the whole registry; each package row is judged individually.
  const patchRes = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [remotePatchPath(spec.remoteDshHome)], quiet: true })
  let patchContent: string | null = null
  if (patchRes.ok) {
    patchContent = patchRes.stdout ?? ''
  } else if (!ENOENT_PATTERN.test(patchRes.error)) {
    return { ok: false, error: `chamber host-package probe failed: ${patchRes.error}` }
  }

  const packages: ChamberHostPackageState[] = []
  for (const descriptor of CHAMBER_HOST_PACKAGES) {
    // Local-shape-only rows are not part of a remote instance contract: report the
    // flag and make NO remote call — the synthesized values mean not asked, never a
    // probe result other consumers may fold into a target-level gate.
    if (descriptor.localOnly === true) {
      packages.push({
        insertId: descriptor.insert.id,
        name: descriptor.insert.name,
        probe: descriptor.probe.method,
        installed: false,
        patched: false,
        version: null,
        live: null,
        localOnly: true,
      })
      continue
    }
    // Every DECLARED seed file is probed (the shared tuple, so a third file is read
    // here the moment it lands there); the manifest member supplies the version.
    let installed = true
    let version: string | null = null
    for (const relative of SEED_FILES) {
      const filePath = `${home}/profiles/node_modules/${descriptor.insert.name}/${relative}`
      const res = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [filePath], quiet: true })
      if (res.ok) {
        if (relative === MANIFEST_SEED_FILE) version = parsePackageVersion(res.stdout ?? '')
      } else if (ENOENT_PATTERN.test(res.error)) {
        installed = false
      } else {
        return { ok: false, error: `${descriptor.insert.name} probe failed: ${res.error}` }
      }
    }

    // One boot row can predate another in the same cordis.patch.yml (a machine seeded
    // before a package existed carries the older rows only); each row is judged
    // against its own insert, and a conflict in any row is a loud probe error.
    let patched = false
    if (patchContent !== null) {
      const update = computeCordisPatchUpdate(patchContent, [registryInsertToLocal(descriptor.insert)])
      if ('error' in update) return { ok: false, error: update.error }
      patched = update.write === false
    }

    // Live only when BOTH halves are present AND a probe was supplied: a
    // half-injected package cannot be live, and with no ready tunnel the result is
    // null (honest not-probed).
    const live = installed && patched && opts?.liveProbe !== undefined
      ? await opts.liveProbe(descriptor)
      : null

    packages.push({
      insertId: descriptor.insert.id,
      name: descriptor.insert.name,
      probe: descriptor.probe.method,
      installed,
      patched,
      version,
      live,
    })
  }

  return { ok: true, packages }
}


export interface ApplyActions {
  add: string[]
  remove: string[]
  restart?: boolean
}

/**
 * Durable per-instance ssh apply journal sink. STRUCTURAL: plugin-sync never imports the
 * journal module; absent journal = no extra read. The implementor never throws —
 * journaling is best-effort and a persistence failure must never break an apply.
 */
export interface SshApplyJournalSink {
  record(entry: {
    instanceId: string
    name: string
    kind: 'add' | 'remove'
    specBefore: string | null
    ok: boolean
    error?: string
  }): void
}

/**
 * Pre-change manifest read used ONLY by the journal capture (single quiet `cat`).
 * FAIL-CLOSED: an unreadable snapshot refuses the WHOLE batch — `specBefore: null` after
 * a failed read would make undo DELETE an upgraded plugin. ENOENT = benign empty;
 * an unparseable read is a failure, never an empty map.
 */
async function readJournalSnapshot(
  exec: ExecFn,
  spec: RemoteSpec,
): Promise<{ ok: true; dependencies: Record<string, string> } | { ok: false; error: string }> {
  const res = await exec(spec.id, 'run', {
    op: 'exec',
    command: 'cat',
    argv: [remoteManifestPath(spec.remoteDshHome)],
    quiet: true,
  })
  if (!res.ok) {
    return ENOENT_PATTERN.test(res.error) ? { ok: true, dependencies: {} } : { ok: false, error: res.error }
  }
  const parsed = parseRemoteManifest(res.stdout ?? '')
  if (parsed.error !== undefined) return { ok: false, error: parsed.error }
  return { ok: true, dependencies: parsed.dependencies }
}

/** In-flight apply guards: single-flight per instance. */
const applyInFlight = new Set<string>()

const VERIFY_READY_TIMEOUT_MS = 30_000
const VERIFY_READY_INTERVAL_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Bounded ready recheck: poll `status(id)` until phase is ready or timeout. */
async function verifyReady(status: StatusFn, id: string, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const projection = status(id)
    if (projection === null) return false
    if (projection.phase === 'ready') return true
    if (Date.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

/** Re-pull the remote manifest and assert the applied set landed. */
async function verifyApplied(
  exec: ExecFn,
  spec: RemoteSpec,
  add: string[],
  remove: string[],
  failed: { spec: string; error: string }[],
  knownBundles?: string[],
): Promise<boolean> {
  const res = await remotePluginList(exec, spec)
  if (!res.ok || !res.manifest.profileExists) return false
  const deps = res.manifest.dependencies
  const bundles = res.manifest.bundles
  const failedSpecs = new Set(failed.map(entry => entry.spec))
  for (const s of add) {
    if (failedSpecs.has(s)) continue
    const name = packageNameFromSpec(s)
    if (name === null || !(name in deps)) return false
    // A KNOWN bundle-declaring add must also land in the remote bundle activation
    // layer (`dsh.profile.bundles`), not just dependencies — the layer a broken
    // reconcile would silently skip.
    if (knownBundles !== undefined && knownBundles.includes(name) && !bundles.includes(name)) return false
  }
  for (const name of remove) {
    if (failedSpecs.has(name)) continue
    if (name in deps) return false
  }
  return true
}

/**
 * Apply a plugin-set change to one remote instance:
 * 1. re-validate add/remove against the whitelists (never trust the renderer) and
 *    `restart` as a boolean;
 * 2. remove then add, serial, per-item failure isolation;
 * 3. restart when there was a change and `restart !== false` (defer otherwise);
 * 4. re-pull the manifest and assert add ∈ dependencies (bundle-declaring adds
 *    also ∈ bundles) / remove ∉ dependencies;
 * 5. bounded ready recheck after a successful restart — skipped with a
 *    distinguishing note when the instance was not connected before the apply;
 * 6. single-flight per instance.
 */
export async function applyPlugins(
  exec: ExecFn,
  status: StatusFn,
  spec: RemoteSpec,
  actions: ApplyActions,
  opts?: {
    verifyReadyTimeoutMs?: number
    verifyReadyIntervalMs?: number
    knownBundles?: string[]
    ownershipKey?: string
    /** Undo journal sink: when present, a pre-change manifest snapshot is read BEFORE
     * the first remote change and every executed row is recorded with its pre-change
     * spec. Absent → no extra read and no journaling. */
    journal?: SshApplyJournalSink
    /** Operational target fingerprint of the instance the rows execute on, recorded
     * on every entry so an undo can never replay onto a different host that reuses
     * the same connection id. */
    targetFingerprint?: string | null
    /** Protected-set facts: ssh form by default (B₀ ∪ S, no family source). The main
     * process passes the facts it resolved so batch judgement uses the same P as the
     * read-face projection. */
    protection?: SshProtectionFacts
  },
): Promise<ApplyPluginsResult> {
  const id = spec.id
  const inFlightKey = `${id}\u0000${opts?.ownershipKey ?? ''}`

  // Single-flight keys on the exact operational incarnation, not the reusable
  // registry id: a changed target starts immediately; a stale finally removes only
  // its own key.
  if (applyInFlight.has(inFlightKey)) return { ok: false, error: 'apply in progress' }

  // ① re-validate (defense in depth — renderer input is untrusted).
  const add = Array.isArray(actions.add) ? actions.add : []
  const remove = Array.isArray(actions.remove) ? actions.remove : []
  if (add.length + remove.length > 64) return { ok: false, error: 'too many plugin changes in one request' }
  for (const s of add) {
    if (typeof s !== 'string' || s.length > MAX_PLUGIN_SPEC_CHARS || !PLUGIN_SPEC_PATTERN.test(s) || hasXWildcardVersion(s)) {
      return { ok: false, error: `invalid add spec: ${JSON.stringify(s)}` }
    }
  }
  for (const name of remove) {
    if (typeof name !== 'string' || name.length > MAX_PLUGIN_SPEC_CHARS || !PLUGIN_NAME_PATTERN.test(name)) {
      return { ok: false, error: `invalid remove name: ${JSON.stringify(name)}` }
    }
  }
  // Protected-set judgement (ssh form: B₀ ∪ S). Refuse the WHOLE batch, loudly, naming each
  // row and code, BEFORE any remote change; buildSshApplyRows is the shared assembly used
  // by the IPC preflight and here; the undo path rides this function too.
  const assembled = buildSshApplyRows(add, remove, opts?.protection ?? defaultSshProtectionFacts())
  if (assembled.refusals.length > 0) {
    return { ok: false, error: describePluginRefusals(assembled.refusals) }
  }
  // A non-boolean `restart` (e.g. the string false) must never be treated as truthy
  // and trigger an unwanted restart.
  if (actions.restart !== undefined && typeof actions.restart !== 'boolean') {
    return { ok: false, error: 'restart must be a boolean' }
  }

  applyInFlight.add(inFlightKey)
  try {
    const failed: { spec: string; error: string }[] = []
    let applied = 0

    // Journal capture: read the pre-change manifest BEFORE the first remote change (add:
    // null when absent; remove: previous spec). An absent profile is empty. FAIL-CLOSED: a
    // snapshot that cannot be read refuses the WHOLE batch — the journal cannot represent
    // unknown, and `specBefore: null` after a failed read would DELETE an upgrade on undo.
    const journal = opts?.journal
    let snapshot: Record<string, string> | null = null
    if (journal !== undefined) {
      const read = await readJournalSnapshot(exec, spec)
      if (!read.ok) {
        return {
          ok: false,
          error: `refusing the plugin change: the pre-change journal snapshot could not be read (${sanitizeErrorText(read.error)}); without it a later undo could delete a plugin that was upgraded in place instead of restoring it`,
        }
      }
      snapshot = read.dependencies
    }
    const specBeforeOf = (name: string): string | null => snapshot === null ? null : (snapshot[name] ?? null)

    // ② remove first (releases old layers), then add — serial, isolated.
    for (const name of remove) {
      const res = await exec(id, 'run', { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'remove', name] })
      if (res.ok) applied += 1
      else failed.push({ spec: name, error: res.error })
      if (journal !== undefined) {
        journal.record({
          instanceId: id,
          name,
          kind: 'remove',
          ...(opts?.targetFingerprint === undefined ? {} : { fingerprint: opts.targetFingerprint }),
          specBefore: specBeforeOf(name),
          ok: res.ok,
          ...(res.ok ? {} : { error: res.error }),
        })
      }
    }
    for (const s of add) {
      const res = await exec(id, 'run', { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', s] })
      if (res.ok) applied += 1
      else failed.push({ spec: s, error: res.error })
      if (journal !== undefined) {
        const name = parseSpecName(s) ?? s
        journal.record({
          instanceId: id,
          name,
          kind: 'add',
          ...(opts?.targetFingerprint === undefined ? {} : { fingerprint: opts.targetFingerprint }),
          specBefore: specBeforeOf(name),
          ok: res.ok,
          ...(res.ok ? {} : { error: res.error }),
        })
      }
    }

    const changed = applied > 0

    // ④ assert the applied set landed (only meaningful when something changed).
    const verified = changed ? await verifyApplied(exec, spec, add, remove, failed, opts?.knownBundles) : true

    // ③ restart (or defer), then the bounded ready recheck.
    let restarted = false
    let deferred = false
    let ready: boolean | null = null
    let readyNote: string | undefined
    if (changed && actions.restart !== false) {
      // An instance that was NOT connected (phase idle/connecting/error) before the
      // apply cannot come ready inside the recheck window, so distinguish it instead of
      // misreporting a bounded timeout as restarted-but-not-recovered.
      const wasReady = status(id)?.phase === 'ready'
      const restartRes = await exec(id, 'restart')
      if (restartRes.ok) {
        restarted = true
        if (wasReady) {
          ready = await verifyReady(
            status,
            id,
            opts?.verifyReadyTimeoutMs ?? VERIFY_READY_TIMEOUT_MS,
            opts?.verifyReadyIntervalMs ?? VERIFY_READY_INTERVAL_MS,
          )
        } else {
          ready = null
          readyNote = 'instance was not connected before restart — readiness was not re-checked'
        }
      }
      // restart failure: restarted stays false, ready stays null — an honest report,
    } else if (changed) {
      deferred = true
    }

    const result: PluginApplyResult = { applied, skipped: 0, failed, restarted, deferred, verified, ready }
    if (readyNote !== undefined) result.readyNote = readyNote
    return { ok: true, result }
  } finally {
    applyInFlight.delete(inFlightKey)
  }
}


export interface ChamberHostPackageSeed {
  insertId: string
  packageName: string
  sourceDir: string
  label: string
  /** Registry rows marked local-shape-only are never seeded remotely; the caller passes
   * an empty sourceDir, and the flag makes the intent explicit. */
  localOnly?: true
}

export interface ChamberHostPackageSeedState {
  insertId: string
  packageName: string
  wrote: boolean
}

/**
 * The portable seeds (may live on ANOTHER host). THE single source: seedRemote drops
 * `localOnly` rows here before validation/preflight/write, and every desktop path
 * inspecting that other machine must read THIS list — a `localOnly` row carries an
 * empty `sourceDir` by design, so counting it as missing would fail the manual seed,
 * log false build-artifact gaps and warn on every gateway sync.
 */
export function portableChamberHostPackageSeeds(
  seeds: readonly ChamberHostPackageSeed[],
): readonly ChamberHostPackageSeed[] {
  return seeds.filter(seed => seed.localOnly !== true)
}

/**
 * Registry → desktop seed array — the single construction point for the ssh seed list
 * and the gateway upload, folding registry row + sourceDir map + portability rule once.
 * Fail-loud: a NON-localOnly row with a missing/empty sourceDir key is a WIRING defect
 * (both remote paths would silently skip that domain) and THROWS; localOnly is exempt.
 * Not-built is not this function call: only builtChamberHostPackageSeeds may skip a
 * mapped package whose dist/index.js is absent. `registry` is injectable for tests.
 */
export function chamberHostPackageSeedsFrom(
  sourceDirs: Readonly<Record<string, string | undefined>>,
  registry: readonly ChamberHostPackageDescriptor[] = CHAMBER_HOST_PACKAGES,
): ChamberHostPackageSeed[] {
  return registry.map((descriptor): ChamberHostPackageSeed => {
    if (descriptor.localOnly === true) {
      return {
        insertId: descriptor.insert.id,
        packageName: descriptor.insert.name,
        sourceDir: '',
        label: descriptor.insert.id,
        localOnly: true,
      }
    }
    const sourceDir = sourceDirs[descriptor.insert.name]
    if (sourceDir === undefined || sourceDir === '') {
      throw new Error(
        `chamber host 包 '${descriptor.insert.name}' (insert id '${descriptor.insert.id}', `
        + `probe '${descriptor.probe.method}') 在注册表里非 localOnly，但源目录映射缺少 sourceDir 键 `
        + `'${descriptor.insert.name}'：远端 seed 与 gateway 上传都会跳过该域。补上该键（值 = 该 flavor 的包源目录；`
        + '包未构建时键仍须在，只允许 builtChamberHostPackageSeeds 按 dist/index.js 的 existsSync 结果跳过）',
      )
    }
    return {
      insertId: descriptor.insert.id,
      packageName: descriptor.insert.name,
      sourceDir,
      label: descriptor.insert.id,
    }
  })
}

/**
 * The seeds actually SHIPPED here: a mapped source dir whose built entry exists.
 * Fail-loud: a NON-localOnly seed with an empty `sourceDir` is a wiring defect and
 * THROWS. `existsSync` is the ONLY skip (mapped-but-unbuilt is legitimately absent);
 * the empty-dir case must never reach it — `join(empty, dist, index.js)` resolves
 * against the CWD and could stage the CWD own bytes as that package seed.
 * `localOnly` rows never travel.
 */
export function builtChamberHostPackageSeeds(
  seeds: readonly ChamberHostPackageSeed[],
): readonly ChamberHostPackageSeed[] {
  return seeds.filter(seed => {
    if (seed.localOnly === true) return false
    if (seed.sourceDir === '') {
      throw new Error(
        `chamber host 包 '${seed.packageName}' (insert id '${seed.insertId}') 非 localOnly 但 sourceDir 键为空：`
        + '这是接线缺陷（源目录映射漏登记），不是「未构建」——未构建由 dist/index.js 的 existsSync 判定；'
        + '远端 seed 与 gateway 上传绝不静默跳过该域',
      )
    }
    return existsSync(join(seed.sourceDir, 'dist', 'index.js'))
  })
}

type ChamberHostInsert = Pick<ChamberHostPackageSeed, 'insertId' | 'packageName'>

/** Adapt the local {insertId, packageName} pair to the shared CordisInsert
 * ({id, name}); the insert logic is single-sourced in control-plane. */
function toCordisInsert(insert: ChamberHostInsert): CordisInsert {
  return { id: insert.insertId, name: insert.packageName }
}

/** The registry row is already the shared {id, name} shape; the named helper
 * keeps call sites symmetric with the local pair. */
function registryInsertToCordis(insert: HostPackageInsert): CordisInsert {
  return { id: insert.id, name: insert.name }
}

/** Registry row → the desktop-local {insertId, packageName} pair the overlay
 * writers/renderers take. */
function registryInsertToLocal(insert: HostPackageInsert): ChamberHostInsert {
  return { insertId: insert.id, packageName: insert.name }
}

export type CordisPatchUpdate =
  | { write: false }
  | { write: true; content: string }
  | { error: string }

/**
 * Fold chamber loader inserts into an existing cordis.patch.yml: dedup when present;
 * deterministic rewrite for the `initProfile` template; append for a user
 * block-sequence list (never overwrite user rows); fail-loud for a non-list. Inserts
 * are REQUIRED. Pre-rename rows (same loader id, `@dsh-chamber/dsh-host-*`) fold to
 * canonical first; classification is shared, fold semantics and wording stay here.
 */

/** The cordis.patch.yml conflict wording for one desired insert (the shared
 * insertConflict classification mapped onto this module error surface). */
function cordisConflictMessage(conflict: InsertConflictKind, insert: ChamberHostInsert): string {
  if (conflict === 'duplicate-identity') {
    return `cordis.patch.yml contains duplicate chamber loader identity for id '${insert.insertId}' or package '${insert.packageName}'`
  }
  if (conflict === 'id-bound') {
    return `cordis.patch.yml loader id '${insert.insertId}' is already bound to a different package`
  }
  return `cordis.patch.yml package '${insert.packageName}' is already mounted under a different loader id`
}

/**
 * Pre-rename chamber host package names keyed by loader id: the unification maps
 * `@dsh-chamber/dsh-host-<id>` → `@dsh-chamber/dsh-chamber-seed-<id>` WITHOUT changing
 * loader ids, so a profile seeded by an older desktop carries the old name bound to the
 * same id; without the fold later seeds are rejected as id-bound. Names are frozen.
 */
const LEGACY_HOST_PACKAGE_NAMES: Readonly<Record<string, string>> = {
  [CLIENT_GRAPH_INSERT_ID]: '@dsh-chamber/dsh-host-client-graph',
  [GIT_WORKTREE_INSERT_ID]: '@dsh-chamber/dsh-host-git-worktree',
  [ARCHIVE_CLEANUP_INSERT_ID]: '@dsh-chamber/dsh-host-archive-cleanup',
}

/**
 * One-time fold of pre-rename rows: a row with a desired loader id but that id legacy
 * name is rewritten in place to the canonical name. Only the exact bytes the seed
 * writer produces are folded; hand-written variants keep failing loud. A fold is a
 * write even when no row is missing.
 */
export function foldLegacyHostInserts(
  existing: string,
  inserts: readonly ChamberHostInsert[],
): { content: string; folded: boolean } {
  let content = existing
  let folded = false
  for (const insert of inserts) {
    const legacyName = LEGACY_HOST_PACKAGE_NAMES[insert.insertId]
    if (legacyName === undefined) continue
    const legacyRow = renderCordisInserts([{ id: insert.insertId, name: legacyName }])
    if (!content.includes(legacyRow)) continue
    const canonicalRow = renderCordisInserts([{ id: insert.insertId, name: insert.packageName }])
    content = content.split(legacyRow).join(canonicalRow)
    folded = true
  }
  return { content, folded }
}

export function computeCordisPatchUpdate(
  existing: string | null,
  inserts: readonly ChamberHostInsert[],
): CordisPatchUpdate {
  if (existing === null) {
    return { error: 'remote profile is not initialized (cordis.patch.yml missing) — run a plugin add first' }
  }
  // The legacy fold runs BEFORE conflict classification: an old-name row under the
  // same loader id is a rename to absorb, not an id-bound conflict to refuse.
  const { content: foldedPatch, folded } = foldLegacyHostInserts(existing, inserts)
  for (const insert of inserts) {
    const conflict = insertConflict(foldedPatch, toCordisInsert(insert))
    if (conflict !== null) return { error: cordisConflictMessage(conflict, insert) }
  }
  const missing = inserts.filter(insert => !hasExactInsert(foldedPatch, toCordisInsert(insert)))
  if (missing.length === 0) return folded ? { write: true, content: foldedPatch } : { write: false }
  const rendered = renderCordisInserts(missing.map(toCordisInsert))
  const significant = foldedPatch.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  // Empty list (initProfile template or comments-only file): deterministic rewrite,
  // preserving the comment header.
  if (significant.length === 0 || (significant.length === 1 && significant[0] === '[]')) {
    const base = foldedPatch.replace(/\[\]\s*$/, '').trimEnd()
    return { write: true, content: base === '' ? rendered : `${base}\n${rendered}` }
  }
  // A block-sequence list: append at the end, never touching existing rows.
  if (significant[0].startsWith('-')) {
    return { write: true, content: `${foldedPatch.replace(/\s+$/, '')}\n${rendered}` }
  }
  return { error: 'cordis.patch.yml is not a top-level YAML array — cannot seed chamber host inserts safely' }
}

export type SeedRemoteHostPackagesResult =
  | { ok: true; wrote: boolean; patched: boolean; packages: ChamberHostPackageSeedState[] }
  | { ok: false; error: string }

/**
 * Seed all built chamber host packages onto a remote instance: ensure cordis.patch.yml
 * carries their exact inserts, then write package.json + dist/index.js into the
 * install-level flat fallback (not the profile node_modules — pnpm relinks that). The
 * PATCH IS PROBED FIRST: an uninitialized or unmergeable patch fails loud before any
 * package write, and the patch write stays gated on the package files, so a failed seed
 * never leaves half-injected state. Hash-identical files are skipped (byte-domain);
 * probe cats are quiet. An absent artifact is not-shipped → no patch write.
 */
export async function seedRemoteChamberHostPackages(
  exec: ExecFn,
  spec: RemoteSpec,
  seeds: readonly ChamberHostPackageSeed[],
): Promise<SeedRemoteHostPackagesResult> {
  const id = spec.id
  const home = remoteHome(spec.remoteDshHome)

  const seenInsertIds = new Set<string>()
  const seenPackageNames = new Set<string>()
  // Local-shape-only rows never travel: the open-in host domain launches
  // applications on the user own machine. Dropping them here — before validation,
  // preflight and every remote call — keeps the rule in one place.
  const portable = portableChamberHostPackageSeeds(seeds)
  for (const seed of portable) {
    if (!/^[a-zA-Z0-9._-]+$/.test(seed.insertId)
      || !/^@dsh-chamber\/[a-zA-Z0-9._-]+$/.test(seed.packageName)) {
      return { ok: false, error: `invalid chamber host package seed: ${JSON.stringify({ id: seed.insertId, name: seed.packageName })}` }
    }
    if (seenInsertIds.has(seed.insertId) || seenPackageNames.has(seed.packageName)) {
      return { ok: false, error: `duplicate chamber host package seed: ${JSON.stringify({ id: seed.insertId, name: seed.packageName })}` }
    }
    seenInsertIds.add(seed.insertId)
    seenPackageNames.add(seed.packageName)
  }

  // Only a built dist/index.js makes a package available: a source dir without its
  // artifact is not-shipped and must not create a dangling loader row.
  const available = builtChamberHostPackageSeeds(portable)
  if (available.length === 0) return { ok: true, wrote: false, patched: false, packages: [] }

  // Preflight every local byte before touching the remote: a broken second package
  // cannot leave the first half-seeded.
  const staged: Array<{
    seed: ChamberHostPackageSeed
    relative: typeof SEED_FILES[number]
    bytes: Buffer
    sha256: string
    remotePath: string
    write: boolean
  }> = []
  for (const seed of available) {
    for (const relative of SEED_FILES) {
      const source = join(seed.sourceDir, relative)
      if (!existsSync(source)) {
        return { ok: false, error: `${seed.label} seed: ${source} missing in package ${seed.sourceDir}` }
      }
      const bytes = readFileSync(source)
      staged.push({
        seed,
        relative,
        bytes,
        sha256: sha256hex(bytes),
        remotePath: `${home}/profiles/node_modules/${seed.packageName}/${relative}`,
        write: true,
      })
    }
  }

  // Patch probe FIRST: the cordis.patch.yml `cat` is the uninitialized-profile
  // signal (ENOENT → the loud remote-profile-not-initialized error), so probing
  // before any package write leaves no partial package files. The probe is quiet.
  const patchPath = remotePatchPath(spec.remoteDshHome)
  const patchProbe = await exec(id, 'run', { op: 'exec', command: 'cat', argv: [patchPath], quiet: true })
  let existing: string | null
  if (patchProbe.ok) {
    existing = patchProbe.stdout ?? ''
  } else if (ENOENT_PATTERN.test(patchProbe.error)) {
    existing = null
  } else {
    return { ok: false, error: `chamber host seed read cordis.patch.yml failed: ${patchProbe.error}` }
  }
  const update = computeCordisPatchUpdate(existing, available)
  if ('error' in update) return { ok: false, error: update.error }

  // Probe every remote byte before the first write, so a failure on package two
  // cannot leave package one partially updated.
  for (const file of staged) {
    const catRes = await exec(id, 'run', { op: 'exec', command: 'cat', argv: [file.remotePath], quiet: true })
    if (catRes.ok) {
      // Hash-skip: a cat read-back whose bytes match skips the write — the comparison is
      // byte-domain (`stdoutBytes`), so binary files never false-mismatch through the
      // lossy UTF-8 view; a mismatch still falls through to the write. ENOENT =
      if (sha256hex(catRes.stdoutBytes ?? Buffer.from(catRes.stdout ?? '', 'utf8')) === file.sha256) file.write = false
    } else if (!ENOENT_PATTERN.test(catRes.error)) {
      // genuinely absent → write; ANY other ssh failure is loud, since a write that
      // would also fail masks the real cause. Probe cats are quiet (ENOENT by design).
      return { ok: false, error: `${file.seed.label} seed read ${file.relative} failed: ${catRes.error}` }
    }
  }

  let wrote = false
  const states = available.map(seed => ({
    insertId: seed.insertId,
    packageName: seed.packageName,
    wrote: false,
  }))
  for (const file of staged) {
    if (!file.write) continue
    const writeRes = await exec(id, 'run', {
      op: 'write-file',
      path: file.remotePath,
      contentBase64: file.bytes.toString('base64'),
      sha256: file.sha256,
    })
    if (!writeRes.ok) return { ok: false, error: `${file.seed.label} seed write-file failed for ${file.relative}: ${writeRes.error}` }
    wrote = true
    const state = states.find(entry => entry.insertId === file.seed.insertId && entry.packageName === file.seed.packageName)
    if (state !== undefined) state.wrote = true
  }

  // Ensure cordis.patch.yml carries the insert — the WRITE stays AFTER the package
  // files (never a dangling insert for a package absent on the remote).
  let patched = false
  if (update.write) {
    const bytes = Buffer.from(update.content, 'utf8')
    const writeRes = await exec(id, 'run', {
      op: 'write-file',
      path: patchPath,
      contentBase64: bytes.toString('base64'),
      sha256: sha256hex(bytes),
    })
    if (!writeRes.ok) return { ok: false, error: `chamber host seed write cordis.patch.yml failed: ${writeRes.error}` }
    patched = true
  }
  return { ok: true, wrote, patched, packages: states }
}


export type MaterializeResult = { ok: true; spec: string; remotePath: string } | { ok: false; error: string }

/** The materialized-tarball stable dir: ALWAYS the literal `~/.dsh-chamber/plugins` — the
 * remote shell expands `~` at word start and the write whitelist accepts exactly this
 * prefix; independent of `remoteDshHome`. The absolute form comes from REMOTE `$HOME`. */
export function materializePluginsDir(_remoteDshHome: string | null): string {
  return '~/.dsh-chamber/plugins'
}

/** A remote `$HOME` is usable for the `file:` spec only when absolute and
 * shell-safe (it rides the remote shell command line and pnpm `file:`
 * resolution). */
const REMOTE_HOME_PATTERN = /^\/[a-zA-Z0-9._/-]+$/

/** Resolve a leading `~` in a remote path to the REMOTE home (a word-middle `~` is not
 * expanded); read via the whitelisted `printf %s $HOME`, never the local home.
 * Fail-loud when undetermined or not shell-safe. */
export async function materializeAbsolutePath(
  exec: ExecFn,
  spec: RemoteSpec,
  remotePath: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!remotePath.startsWith('~/')) return { ok: true, path: remotePath }
  const homeRes = await exec(spec.id, 'run', { op: 'exec', command: 'printf', argv: ['%s', '$HOME'] })
  if (!homeRes.ok) {
    return { ok: false, error: `materialize: cannot resolve the remote $HOME (${homeRes.error}) — set remoteDshHome or use a key-based path` }
  }
  const remoteHome = (homeRes.stdout ?? '').trim()
  if (remoteHome === '' || !REMOTE_HOME_PATTERN.test(remoteHome)) {
    return { ok: false, error: 'materialize: the remote $HOME is not an absolute, shell-safe path — cannot assemble the file: spec' }
  }
  return { ok: true, path: `${remoteHome}${remotePath.slice(1)}` }
}

const MATERIALIZED_TARBALL_MAX_BYTES = 50 * 1024 * 1024
const CHILD_OUTPUT_MAX_CHARS = 64 * 1024
const localPluginChildSupervisor = new RuntimeInstallerSupervisor(CHILD_OUTPUT_MAX_CHARS, 1_000)
const LOCAL_PLUGIN_WRITER_SCHEMA = 1

export interface LocalPluginWriterRecord {
  schemaVersion: 1
  pid: number
  ownerPid: number
  ownerStartToken: string | null
  childStartToken: string | null
  childCommandHash: string | null
  createdAt: string
}

interface ProcessIdentity {
  startToken: string
  commandHash: string
}

export interface LocalPluginWriterReaperDeps {
  inspectProcess(pid: number): ProcessIdentity | null
  processAlive(pid: number, group: boolean): boolean
  signalGroup(pid: number, signal: NodeJS.Signals): void
  wait(ms: number): Promise<void>
}

export function localPluginWriterLedgerPath(localDshHome: string): string {
  return join(dirname(localDshHome), 'local-plugin-writer.json')
}

function inspectProcess(pid: number): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null
  const ps = '/bin/ps'
  const started = spawnSync(ps, ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 2_000, windowsHide: true,
  })
  const command = spawnSync(ps, ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8', timeout: 2_000, windowsHide: true,
  })
  if (started.status !== 0 || command.status !== 0) return null
  const startToken = started.stdout.trim()
  const commandText = command.stdout.trim()
  if (startToken === '' || commandText === '') return null
  return {
    startToken,
    commandHash: createHash('sha256').update(commandText).digest('hex'),
  }
}

function processAlive(pid: number, group: boolean): boolean {
  try {
    process.kill(group && process.platform !== 'win32' ? -pid : pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const defaultWriterReaperDeps: LocalPluginWriterReaperDeps = {
  inspectProcess,
  processAlive,
  signalGroup: (pid, signal) => {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  },
  wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

function readLocalPluginWriterRecord(localDshHome: string): LocalPluginWriterRecord | null | 'corrupt' {
  const ledger = localPluginWriterLedgerPath(localDshHome)
  let text: string
  try {
    // No-follow / single-link read discipline (the ledger is not a secret but gates DSH_HOME
    // mutation): a planted symlink or hard-link is corrupt, and the reaper fails closed.
    // tightenMode converges a legacy loose leaf to 0600; missing ledger → ENOENT → null.
    text = readPrivateFileNoFollow(ledger, { tightenMode: 0o600 }).value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return 'corrupt'
  }
  try {
    const parsed = JSON.parse(text) as Partial<LocalPluginWriterRecord>
    if (parsed.schemaVersion !== LOCAL_PLUGIN_WRITER_SCHEMA
      || !Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0
      || !Number.isInteger(parsed.ownerPid) || (parsed.ownerPid ?? 0) <= 0
      || (parsed.ownerStartToken !== null && typeof parsed.ownerStartToken !== 'string')
      || (parsed.childStartToken !== null && typeof parsed.childStartToken !== 'string')
      || (parsed.childCommandHash !== null && typeof parsed.childCommandHash !== 'string')
      || typeof parsed.createdAt !== 'string') return 'corrupt'
    return parsed as LocalPluginWriterRecord
  } catch {
    return 'corrupt'
  }
}

function writeLocalPluginWriterRecord(localDshHome: string, pid: number): void {
  const ownerIdentity = inspectProcess(process.pid)
  const childIdentity = inspectProcess(pid)
  if (process.platform !== 'win32' && childIdentity === null) {
    throw new Error('cannot establish local plugin writer identity')
  }
  const ledger = localPluginWriterLedgerPath(localDshHome)
  // Owner-only parent (0700) then one atomic 0600 replace (O_EXCL tmp + fsync + rename +
  // parent fsync; planted symlink/multi-link refused). Failures throw: the writer fence must
  // never see success while the durable ledger is absent or stale.
  ensurePrivateDirectoryNoFollow(dirname(ledger), 0o700)
  const record: LocalPluginWriterRecord = {
    schemaVersion: LOCAL_PLUGIN_WRITER_SCHEMA,
    pid,
    ownerPid: process.pid,
    ownerStartToken: ownerIdentity?.startToken ?? null,
    childStartToken: childIdentity?.startToken ?? null,
    childCommandHash: childIdentity?.commandHash ?? null,
    createdAt: new Date().toISOString(),
  }
  atomicWritePrivateFileNoFollow(ledger, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

/** Reap a plugin writer left by a hard-crashed Electron owner; identity is checked
 * before signaling so PID reuse can never kill an unrelated process. A corrupt or
 * unverifiable live record fails closed and blocks DSH_HOME use. */
export async function reapStaleLocalPluginWriters(
  localDshHome: string,
  deps: LocalPluginWriterReaperDeps = defaultWriterReaperDeps,
): Promise<{ ok: true; reaped: boolean } | { ok: false; error: string }> {
  const ledger = localPluginWriterLedgerPath(localDshHome)
  const record = readLocalPluginWriterRecord(localDshHome)
  if (record === null) return { ok: true, reaped: false }
  if (record === 'corrupt') return { ok: false, error: 'local plugin writer ledger is corrupt' }

  const ownerIdentity = deps.inspectProcess(record.ownerPid)
  const ownerIsSame = deps.processAlive(record.ownerPid, false)
    && record.ownerStartToken !== null
    && ownerIdentity?.startToken === record.ownerStartToken
  if (ownerIsSame) return { ok: false, error: 'a local plugin writer is still owned by a live application process' }

  if (!deps.processAlive(record.pid, process.platform !== 'win32')) {
    rmSync(ledger, { force: true })
    return { ok: true, reaped: false }
  }
  if (process.platform === 'win32' || record.childStartToken === null || record.childCommandHash === null) {
    return { ok: false, error: 'a stale local plugin writer cannot be safely identified on this platform' }
  }
  const childIdentity = deps.inspectProcess(record.pid)
  // If the original group leader is still present, authenticate it exactly before
  // signaling: a daemonized descendant may keep the process group alive after the
  // leader exits, in which case the still-live PGID remains reserved to that group.
  if (childIdentity !== null && (childIdentity.startToken !== record.childStartToken
    || childIdentity.commandHash !== record.childCommandHash)) {
    return { ok: false, error: 'local plugin writer PID identity changed; refusing to signal it' }
  }
  try { deps.signalGroup(record.pid, 'SIGTERM') } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      return { ok: false, error: 'failed to terminate stale local plugin writer' }
    }
  }
  await deps.wait(1_000)
  if (deps.processAlive(record.pid, true)) {
    try { deps.signalGroup(record.pid, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return { ok: false, error: 'failed to kill stale local plugin writer' }
      }
    }
    await deps.wait(1_000)
  }
  if (deps.processAlive(record.pid, true)) {
    return { ok: false, error: 'stale local plugin writer did not exit' }
  }
  rmSync(ledger, { force: true })
  return { ok: true, reaped: true }
}

let pluginSyncDisposePromise: Promise<void> | null = null

/** App-quit barrier for every local pack/plugin child and its Unix group. */
export function disposePluginSyncChildren(): Promise<void> {
  pluginSyncDisposePromise ??= localPluginChildSupervisor.dispose()
  return pluginSyncDisposePromise
}

/** Run a bounded child without blocking Electron main event loop through the SHARED
 * restricted-mutation executor; RuntimeInstallerSupervisor is the executor child seam, so
 * the crash-safe ledger and process-group-quiescence proof stay intact while env/output/
 * timeout/kill discipline stays single-sourced. */
export async function runChild(
  command: string,
  args: string[],
  options: {
    cwd: string
    env: NodeJS.ProcessEnv
    timeoutMs: number
    writerHome?: string
    /** Child execution seam (tests inject a probe; production uses the supervisor adapter). */
    childExecutor?: MutationChildExecutor
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const env = Object.fromEntries(
    Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  let supervisionComplete = false
  const supervisorExecutor: MutationChildExecutor = async execution => {
    const result = await localPluginChildSupervisor.run([execution.command, ...execution.args], {
      cwd: execution.cwd ?? options.cwd,
      env: execution.env,
      timeoutMs: execution.timeoutMs,
      onSpawn: options.writerHome === undefined
        ? undefined
        : pid => writeLocalPluginWriterRecord(options.writerHome!, pid),
    })
    // A resolved supervisor promise means the direct child and its Unix process group
    // are both proven gone; only then may crash evidence be cleared, whatever the exit status.
    supervisionComplete = true
    if (result.status === 0) return { code: 0, signal: null, stdout: result.stdout, stderr: result.stderr }
    // Preserve the operator-facing text exactly: the whole trimmed stderr, falling
    // back to an honest exit note.
    return {
      code: result.status,
      signal: null,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.stderr.trim() || `child exited ${result.status ?? 'unknown'}`,
    }
  }
  try {
    const result = await runPluginMutation({
      command,
      argv: args,
      env,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      // Local main-process errors are operator-facing only (never rendered remotely):
      // keep them verbatim instead of the gateway URL/path redaction.
      sanitize: text => text,
      childExecutor: options.childExecutor ?? supervisorExecutor,
    })
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  } catch (error) {
    // A residual/unknown writer is not an ordinary command failure: preserve the
    // durable ledger in `finally` and reject, so the writer fence cannot observe a
    // normal result while DSH_HOME may still be mutating.
    if (isRuntimeInstallerWriterSafetyError(error)) throw error
    return { ok: false, error: String(error) }
  } finally {
    if (options.writerHome !== undefined && supervisionComplete) {
      try { rmSync(localPluginWriterLedgerPath(options.writerHome), { force: true }) } catch { /* startup reaper handles residue */ }
    }
  }
}

/** Build the fixed pack argv: `pnpm pack` otherwise runs prepack/prepare/postpack
 * from the selected directory — folder selection is consent to read and transfer a
 * package, not to execute that package code. */
export function buildPnpmPackArgs(outDir: string): string[] {
  return ['pack', '--config.ignore-scripts=true', '--pack-destination', outDir]
}

/** The desktop module own directory (packaged: inside the asar; dev: the workspace
 * package dir) — the anchor for the dev pnpm entry probe. */
const desktopModuleDir = dirname(fileURLToPath(import.meta.url))

/** Electron `process.resourcesPath`, or null outside a packaged app; cast-based so
 * this pure-node module never imports electron. */
function packagedResourcesPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return typeof resourcesPath === 'string' && resourcesPath !== '' ? resourcesPath : null
}

/** The app bundled pnpm bin directory (packaged `<resources>/pnpm/bin`, dev
 * `node_modules/pnpm/bin`), or null — the dirname of the first existing
 * bundled-entry candidate. */
function bundledPnpmBinDir(): string | null {
  const entry = firstExistingPnpmEntry(
    bundledPnpmEntryCandidates({
      platform: process.platform,
      moduleDir: desktopModuleDir,
      resourcesPath: packagedResourcesPath(),
    }),
    existsSync,
  )
  return entry === null ? null : dirname(entry)
}

/** The first existing pnpm.cjs entry (bundled copy preferred, then the installer
 * roots), or null. */
function resolvePnpmScriptEntry(): string | null {
  return firstExistingPnpmEntry(
    pnpmScriptEntryCandidates({
      platform: process.platform,
      moduleDir: desktopModuleDir,
      resourcesPath: packagedResourcesPath(),
      env: process.env,
      execPath: process.execPath,
    }),
    existsSync,
  )
}

async function packDirectory(localDir: string): Promise<{ bytes: Buffer } | null> {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-materialize-'))
  try {
    // win32: never spawn `pnpm.cmd` (Node >=18.20.2/20.12.2 refuses .cmd/.bat without a shell,
    // CVE-2024-27980) — run pnpm.cjs through the current node/Electron; POSIX keeps bare `pnpm`.
    // No script entry → null: the caller reports the honest error instead of a .cmd shim.
    const launcher = resolvePnpmLauncher({
      platform: process.platform,
      execPath: process.execPath,
      scriptEntry: resolvePnpmScriptEntry(),
      electron: process.versions.electron !== undefined,
    })
    if (launcher === null) return null
    const pnpmBin = resolvePnpmBinDir()
    const env = {
      ...(pnpmBin === null
        ? process.env
        : { ...process.env, PATH: `${pnpmBin}${pathDelimiter()}${process.env.PATH ?? ''}` }),
      ...launcher.env,
    }
    const result = await runChild(launcher.command, [...launcher.args, ...buildPnpmPackArgs(outDir)], {
      cwd: localDir,
      timeoutMs: 120_000,
      env,
    })
    if (!result.ok) return null
    const tarball = readdirSync(outDir).find(file => file.endsWith('.tgz'))
    if (tarball === undefined) return null
    const tarballPath = join(outDir, tarball)
    if (statSync(tarballPath).size > MATERIALIZED_TARBALL_MAX_BYTES) return null
    return { bytes: readFileSync(tarballPath) }
  } finally {
    // The remote copy is intentionally persistent, but this local staging archive
    // contains source and must never survive success, failure or app cancellation.
    rmSync(outDir, { recursive: true, force: true })
  }
}

/**
 * Shared materialize tail: write-file the tarball to
 * `~/.dsh-chamber/plugins/<name>-<hash>.tgz` (kept — pnpm persists `file:` deps against
 * it) → resolve its ABSOLUTE remote path from the remote `$HOME` (never local) →
 * `dsh plugin add file:<absolute>`. Scoped names are normalized for the filename
 * whitelist; fails loud on any step, never reporting an incomplete chain as success.
 */
async function installRemoteTarball(
  exec: ExecFn,
  spec: RemoteSpec,
  name: string,
  bytes: Buffer,
): Promise<MaterializeResult> {
  const id = spec.id
  if (bytes.length > MATERIALIZED_TARBALL_MAX_BYTES) {
    return { ok: false, error: `materialize: the plugin archive is ${bytes.length} bytes, beyond the ${MATERIALIZED_TARBALL_MAX_BYTES}-byte remote write cap` }
  }
  const hash = sha256hex(bytes).slice(0, 16)
  // Scoped names (`@scope/name`) contain `/` — normalize for the tarball filename
  // whitelist (`[a-zA-Z0-9._-]+`).
  const tarballName = `${name.replace(/^@/, '').replace(/\//g, '-')}-${hash}.tgz`
  const remotePath = `${materializePluginsDir(spec.remoteDshHome)}/${tarballName}`
  const writeRes = await exec(id, 'run', {
    op: 'write-file',
    path: remotePath,
    contentBase64: bytes.toString('base64'),
    sha256: sha256hex(bytes),
  })
  if (!writeRes.ok) return { ok: false, error: `materialize: write-file failed: ${writeRes.error}` }
  const absolute = await materializeAbsolutePath(exec, spec, remotePath)
  if (!absolute.ok) return absolute
  const addRes = await exec(id, 'run', {
    op: 'exec',
    command: 'dsh',
    argv: ['plugin', '--profile', 'web', 'add', `file:${absolute.path}`],
  })
  if (!addRes.ok) return { ok: false, error: `materialize: add failed: ${addRes.error}` }
  return { ok: true, spec: `file:${absolute.path}`, remotePath }
}

/**
 * Materialize a local-path plugin and install it remotely: `pnpm pack` → write-file the
 * tarball to `~/.dsh-chamber/plugins/<name>-<hash>.tgz` (kept) → resolve its ABSOLUTE
 * remote path from the remote `$HOME` → `dsh plugin add file:<absolute>` (the exec-side
 * whitelist has the dedicated `file:` branch). Scoped names normalized; `pack` injectable;
 * fails loud on any step including an unsafe remote `$HOME`.
 */
export async function materializeAndAdd(
  exec: ExecFn,
  spec: RemoteSpec,
  localDir: string,
  pack?: (dir: string) => { bytes: Buffer } | null | Promise<{ bytes: Buffer } | null>,
): Promise<MaterializeResult> {
  let name: string
  let version: string | null = null
  try {
    const pkg = JSON.parse(readFileSync(join(localDir, 'package.json'), 'utf8')) as Record<string, unknown>
    // Name-length bound: the whitelist regex has no {max}, so a large manifest could
    // inflate the remote write path and the `file:` argv — the same
    // MAX_PLUGIN_SPEC_CHARS ceiling the remove-side validation uses.
    if (typeof pkg.name !== 'string' || pkg.name.length > MAX_PLUGIN_SPEC_CHARS || !PLUGIN_NAME_PATTERN.test(pkg.name)) {
      return { ok: false, error: 'materialize: invalid package name' }
    }
    name = pkg.name
    version = typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : null
  } catch {
    return { ok: false, error: 'materialize: cannot read package.json' }
  }
  // Protected-set judgement over the manifest declared name + version BEFORE the
  // pack/upload/write chain: a picked folder can never smuggle a protected name, and
  // an official-scope pick must be same-generation.
  const sshGuard = guardPluginMutation({ op: 'install', name, version, facts: sshProtectionFacts() })
  if (sshGuard.kind !== 'allow') {
    return { ok: false, error: `materialize: ${describePluginDecision(sshGuard)}` }
  }
  const packed = await (pack ?? packDirectory)(localDir)
  if (packed === null) return { ok: false, error: 'materialize: pnpm pack failed' }
  return installRemoteTarball(exec, spec, name, packed.bytes)
}

/**
 * Materialize a READY `.tgz` archive and install it remotely: the manifest was already
 * read by main; the tail is the folder flow but no `pnpm pack` runs. The declared name
 * is re-validated (PLUGIN_NAME_PATTERN + shared protected-set judgement), and bytes are
 * capped at the remote write ceiling before transfer.
 */
export async function materializeArchiveAndAdd(
  exec: ExecFn,
  spec: RemoteSpec,
  archive: { name: string; version?: string | null; bytes: Buffer },
): Promise<MaterializeResult> {
  if (typeof archive?.name !== 'string' || archive.name.length > MAX_PLUGIN_SPEC_CHARS || !PLUGIN_NAME_PATTERN.test(archive.name)) {
    return { ok: false, error: 'materialize: invalid package name' }
  }
  if (!Buffer.isBuffer(archive?.bytes) || archive.bytes.length === 0) {
    return { ok: false, error: 'materialize: the picked plugin archive is empty' }
  }
  const archiveGuard = guardPluginMutation({
    op: 'install',
    name: archive.name,
    version: archive.version ?? null,
    facts: sshProtectionFacts(),
  })
  if (archiveGuard.kind !== 'allow') {
    return { ok: false, error: `materialize: ${describePluginDecision(archiveGuard)}` }
  }
  return installRemoteTarball(exec, spec, archive.name, archive.bytes)
}


function pathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

/**
 * Resolve a directory holding pnpm for a desktop-launched packaged app with a minimal
 * PATH: PATH first, then well-known install roots (candidate dirs and win32 names are
 * pnpm-launcher single implementation; this owns the existence probes). Null when none
 * is found — the caller fails with an honest pnpm-not-found error.
 */
export function resolvePnpmBinDir(): string | null {
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node')
  const candidates = pnpmBinDirCandidates({
    platform: process.platform,
    pathEntries: (process.env.PATH ?? '').split(pathDelimiter()),
    env: process.env,
    execPath: process.execPath,
    bundledBinDir: bundledPnpmBinDir(),
    nvmVersionDirs: process.platform !== 'win32' && existsSync(nvmRoot) ? readdirSync(nvmRoot) : [],
    homedir: homedir(),
  })
  for (const dir of candidates) {
    for (const name of pnpmBinNames(process.platform)) {
      if (existsSync(join(dir, name))) return dir
    }
  }
  return null
}

export interface LocalPluginExecResult {
  ok: boolean
  error?: string
}

/**
 * Local-only `file:` spec accepted for the MAIN-PROCESS folder-picker path: the path
 * rides an argv array, never a shell, so ordinary Unicode must work — POSIX absolute,
 * Windows drive and UNC accepted, relative/control chars refused. `allowFileSpec` is
 * still required, so renderer specs cannot use this capability.
 */
export function isAllowedLocalFileSpec(spec: string): boolean {
  if (!spec.startsWith('file:') || spec.length > 4096) return false
  const selectedPath = spec.slice('file:'.length)
  if (selectedPath === '' || /[\0\r\n]/.test(selectedPath)) return false
  return isAbsolute(selectedPath)
    || /^[a-zA-Z]:[\\/]/.test(selectedPath)
    || /^\\\\[^\\]+\\[^\\]+/.test(selectedPath)
}

/**
 * Run `dsh plugin --profile web <add|remove> <spec>` against the LOCAL dsh home: resolve
 * the CLI entry as the control plane does, spawn under the right node (Electron main →
 * `process.execPath` + ELECTRON_RUN_AS_NODE + `--expose-internals`), pin `DSH_HOME`, and
 * prepend a resolved pnpm bin dir to PATH. Specs are whitelist-checked before spawn.
 */
export async function runLocalDshPlugin(
  dshWorkspace: string,
  localDshHome: string,
  action: 'add' | 'remove',
  spec: string,
  options: {
    allowFileSpec?: boolean
    protection?: PluginProtectionFacts
    /** Child execution seam (tests inject an env probe; production uses runChild writer-safety
     * supervisor adapter). */
    childExecutor?: MutationChildExecutor
  } = {},
): Promise<LocalPluginExecResult> {
  if (typeof spec !== 'string') return { ok: false, error: 'plugin spec must be a string' }
  const addOk = spec.length <= 4096 && (
    (spec.length <= MAX_PLUGIN_SPEC_CHARS && PLUGIN_SPEC_PATTERN.test(spec) && !hasXWildcardVersion(spec))
    || (options.allowFileSpec === true && isAllowedLocalFileSpec(spec))
  )
  if (action === 'add' && !addOk) return { ok: false, error: `invalid add spec: ${JSON.stringify(spec)}` }
  if (action === 'remove' && (spec.length > MAX_PLUGIN_SPEC_CHARS || !PLUGIN_NAME_PATTERN.test(spec))) return { ok: false, error: `invalid remove name: ${JSON.stringify(spec)}` }
  // Defense in depth: the protected-set judgement runs here too when the caller
  // supplies facts. A `file:` spec has no registry name and is skipped — the caller
  // already judged the picked manifest.
  if (options.protection !== undefined && !spec.startsWith('file:')) {
    const guarded = guardPluginMutation({
      op: action === 'add' ? 'install' : 'remove',
      name: parseSpecName(spec),
      version: action === 'add' ? parseSpecVersion(spec) : null,
      facts: options.protection,
    })
    // ONLY `refuse` stops the CLI. `defer` (profile absent) must fall through: the
    // first `dsh plugin add` is exactly what creates the profile.
    if (guarded.kind === 'refuse') {
      return { ok: false, error: describePluginDecision(guarded) }
    }
  }

  const installed = join(dshWorkspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const source = join(dshWorkspace, 'apps', 'cli', 'src', 'bin.ts')
  let entryArgs: string[]
  if (existsSync(installed)) entryArgs = [installed]
  else if (existsSync(source)) entryArgs = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts']
  else return { ok: false, error: `no dsh CLI entry found in ${dshWorkspace}` }

  const isElectron = process.versions.electron !== undefined
  const nodeArgs = isElectron ? ['--expose-internals', ...entryArgs] : entryArgs
  const pnpmBin = resolvePnpmBinDir()
  // Env discipline: the child gets ONLY the shared whitelist (PATH + proxy family) plus
  // explicit pins; every credential carrier (NODE_AUTH_TOKEN, npm_config_*, NPM_*,
  // DSH_GATEWAY_*) is dropped; HOME is NOT pinned so pnpm keeps the provisioned store.
  const pins: Record<string, string> = { DSH_HOME: localDshHome }
  if (isElectron) pins.ELECTRON_RUN_AS_NODE = '1'
  if (pnpmBin !== null) pins.PATH = `${pnpmBin}${pathDelimiter()}${process.env.PATH ?? ''}`
  const env = scrubMutationEnv(process.env, pins, INSTALL_ENV_WHITELIST)
  const result = await runChild(process.execPath, [...nodeArgs, 'plugin', '--profile', 'web', action, spec], {
    cwd: dshWorkspace,
    env,
    timeoutMs: 120_000,
    writerHome: localDshHome,
    ...(options.childExecutor === undefined ? {} : { childExecutor: options.childExecutor }),
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
