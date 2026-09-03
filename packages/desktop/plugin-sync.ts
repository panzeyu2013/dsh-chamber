/**
 * Remote plugin sync orchestration (design 13 M2+M3, desktop main process).
 *
 * Pure orchestration + dependency injection: every function takes its
 * side-effecting deps as parameters (`exec`, `status`, `localDshHome`, …) so
 * the whole surface is unit-testable without electron or a real SSH host.
 * The exec/status contract is re-declared locally (contract A below) — no
 * `transport-manager.ts` import — and the desktop `main.ts` adapts the
 * transport manager's runtime surface onto it. The §7.2 spec/name whitelist
 * constants are imported from control-plane `plugin-spec.ts` (via
 * control-plane-module.ts — the single source shared with the gateway), and
 * only ssh-specific classification (ENOENT_PATTERN) is imported from
 * `ssh-provider.ts`.
 *
 * Contract A (consumed; produced by the parallel transport agent):
 *   - `restart`                    = exec(id, 'restart')
 *   - `dsh plugin add/remove`      = exec(id, 'run', { op:'exec', command:'dsh',
 *                                     argv:['plugin','--profile','web','add',spec] })
 *   - read remote manifest         = exec(id, 'run', { op:'exec', command:'cat',
 *                                     argv:[path] })
 *   - write a remote file          = exec(id, 'run', { op:'write-file',
 *                                     path, contentBase64, sha256 })
 *
 * The `run` action's success result carries the captured remote stdout in a
 * `stdout` field (the `cat` read-back that manifest parsing and hash-skip rely
 * on). `status` carries the non-secret phase projection for the ready recheck.
 *
 * Security (design 13 §7.2): renderer-supplied add/remove specs are RE-validated
 * against the spec/name whitelists here — never trusted — and every remote
 * path is derived from `remoteDshHome` (a whitelisted, shell-safe value).
 */

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
// The cordis loader insert render/parse/conflict logic is single-sourced in
// control-plane (cordis-inserts.ts, A2 cross-package protocol single-
// sourcing) — consumed through control-plane-module.ts (the desktop
// dual-path facade: packaged → compiled dist/control-plane, dev → workspace
// source). The insert wire format can never drift from the local overlay
// seed (host-graph-seed.ts); only the fold semantics (deterministic rewrite
// / append / fail-loud) and message wording stay here.
import { hasExactInsert, insertConflict, renderCordisInserts } from './control-plane-module.ts'
import type { CordisInsert, InsertConflictKind } from './control-plane-module.ts'
// Canonical whitelists (design 13 §7.2; the single source moved to
// control-plane plugin-spec.ts, design 21 §6.2) — consumed through
// control-plane-module.ts (the desktop dual-path facade: packaged → compiled
// dist/control-plane, dev/tests → workspace source) so the orchestration-side
// 二次校验, the exec-side argv whitelist (ssh-provider.ts re-exports the same
// names) and the gateway executor share one source and can never drift.
import { isDeniedPluginName, MAX_PLUGIN_SPEC_CHARS, PLUGIN_NAME_PATTERN, PLUGIN_SPEC_PATTERN } from './control-plane-module.ts'
// ssh unified increments (design 21 §6.4, plan Phase 5): the reserved-name
// deny + row assembly helpers (parseSpecName / buildSshApplyRows /
// describeReservedNameRefusal — ssh-apply-rows.ts). Pure module, imports no
// Electron and nothing from plugin-sync (no cycle).
import { buildSshApplyRows, describeReservedNameRefusal, parseSpecName } from './ssh-apply-rows.ts'
// ENOENT_PATTERN ("absent remote file" classification) is shared the same way:
// ssh-provider classifies the RAW stderr line against it (redaction can hide a
// `.ssh*`-named home path), so the provider-side classification and this
// caller-side error-text test can never drift apart.
import { ENOENT_PATTERN } from './ssh-provider.ts'
// Contract A types (design 13 §4.1) are SHARED from transport-provider.ts —
// the provider's single source of truth (transport-provider has no runtime
// imports, so this pulls no transport-manager/electron surface). The copied
// union used to drift ('base64'/'mkdir' went missing from the copy).
import type { TransportExecAction, TransportRunPayload } from './transport-provider.ts'
import {
  RuntimeInstallerSupervisor,
  isRuntimeInstallerWriterSafetyError,
} from './runtime-installer.ts'

export { PLUGIN_SPEC_PATTERN, PLUGIN_NAME_PATTERN }

// ============================================================================
// Contract A types: TransportExecAction / TransportRunPayload imported from
// transport-provider.ts (single source, see the import note above).
// ============================================================================


/** The non-secret status surface `applyPlugins` needs for the ready recheck. */
export interface StatusLike {
  phase?: string | null
}

/**
 * Exec outcome. `status` is the fresh non-secret projection for systemctl
 * actions; `stdout` is the captured remote stdout for `run` (the `cat`
 * read-back) — the UTF-8 view, lossy for binary content; `stdoutBytes` is the
 * RAW captured bytes for byte-domain consumers (the seed hash-skip). Absent
 * stdout on a successful `run` is treated as empty output.
 */
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

/** Exact owner for one long-running, same-id-sensitive remote saga. Object
 * identity prevents an old `finally` from clearing a newer incarnation. */
export interface ExactOwnershipToken {
  readonly id: string
  readonly fingerprint: string
  readonly generation: number
}

/** Per-id single-flight ownership that permits a changed incarnation to
 * supersede immediately. This is deliberately in the Electron-free module so
 * remove/re-add and stale-finally behavior is directly unit-testable. */
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

/** Edge tracker for ready-triggered work. Repeated status projections while
 * already ready are not lifecycle edges and must not restart a saga. */
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

/** Final completion fence for remote sagas. Per-step scoped exec protects the
 * mutation path; this fence prevents a late probe/status/read result from
 * being returned as success for a same-id replacement. */
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

/** Wrap every exec step in an ownership check. Multi-step sagas therefore
 * cannot continue on a same-id replacement after an await; the transport
 * runtime independently terminates and rejects the currently-running step. */
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

// ============================================================================
// Whitelists (design 13 §7.2 — contract C): imported from the control-plane
// shared module (plugin-spec.ts via control-plane-module.ts) and re-exported
// for the main-process consumers; ENOENT_PATTERN comes from ssh-provider.ts
// (see the import note above).
// ============================================================================

// ============================================================================
// Path / value helpers
// ============================================================================

export const DEFAULT_REMOTE_DSH_HOME = '~/.dsh'
export const WEB_PROFILE = 'web'
export const CLIENT_GRAPH_PACKAGE_NAME = '@dsh-chamber/dsh-host-client-graph'
export const CLIENT_GRAPH_INSERT_ID = 'client-graph'
export const GIT_WORKTREE_PACKAGE_NAME = '@dsh-chamber/dsh-host-git-worktree'
export const GIT_WORKTREE_INSERT_ID = 'git-worktree'

/**
 * The two module-A seed files (design 09 module A / design 13 §4.6): the
 * install-level flat fallback carries package.json + dist/index.js — the same
 * set the local seed (control-plane host-graph-seed.ts HOST_GRAPH_SEED_FILES),
 * the remote seed writer and BOTH installed probes agree on. `installed`
 * means BOTH files are present; a package.json alone is a half-injected
 * module A (the boot row could not resolve) and must not report "installed".
 */
const SEED_FILES = ['package.json', 'dist/index.js'] as const

/**
 * The local `--patch` overlay filename (design 09 方案 A, module B). The
 * single source of truth is `packages/control-plane/src/host-graph-seed.ts`
 * (`HOST_GRAPH_PATCH_FILENAME`); the desktop mirrors the constant here
 * because it is not part of the control-plane package's public index (the
 * package exports the seed functions, not the filename) and the local
 * overlay probe (localPluginList) is a pure-module surface — the mirror is
 * pinned by the overlay probes in plugin-sync.test.ts. The overlay lives
 * next to the dsh home (`<stateDir>/dsh-chamber-graph.patch.yml` where the
 * managed dsh home is `<stateDir>/dsh-home`), so `dirname(localDshHome)`
 * locates it.
 */
const HOST_GRAPH_PATCH_FILENAME = 'dsh-chamber-graph.patch.yml'

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

/**
 * Extract the package name from a validated spec: `name@ver` → `name`,
 * `@scope/name@ver` → `@scope/name`, `name` → `name`. Returns null for an
 * unparseable spec (the caller has already whitelist-checked the spec).
 */
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

// ============================================================================
// Spec classification (design 13 §4.4)
// ============================================================================

export type SpecClass =
  | { kind: 'sync' }
  | { kind: 'materialize' }
  | { kind: 'unsyncable'; reason: string }

/** `file:` / `link:` / relative / absolute path specs → materialize (design 13 §4.6). */
export function isMaterializeSpec(spec: string): boolean {
  return /^(file:|link:|\.{1,2}\/|\/|~\/)/i.test(spec)
}

export function unsyncableReason(spec: string): string {
  if (/^workspace:/i.test(spec)) return 'workspace:* spec is monorepo-internal and cannot be transferred directly'
  if (/^(git\+|git:|github:|gitlab:|bitbucket:)/i.test(spec)) return 'git dependency is not synced directly (install manually over ssh)'
  if (/^npm:/i.test(spec)) return 'npm: alias spec is not synced directly'
  if (/^https?:\/\//i.test(spec)) return 'URL spec is not synced directly'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(spec)
  if (scheme !== null) return `unsupported spec scheme "${scheme[1]}:" is not synced directly`
  return 'version range / wildcard / alias spec is not synced directly (use an exact registry spec)'
}

/**
 * Is this version/value a semver x-wildcard (`1.x`, `1.2.x`, `x`, `^1.x`)?
 * An x-wildcard is a RANGE, not a locked version — and ranges are "拒绝直传"
 * (design 13 §7.2). The §7.2 char classes let `x` through (it is shell-safe), so
 * this is a SEMANTIC gate layered on top of the syntax whitelist.
 */
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

export function classifySpec(spec: string): SpecClass {
  if (PLUGIN_SPEC_PATTERN.test(spec)) {
    if (hasXWildcardVersion(spec)) return { kind: 'unsyncable', reason: 'x-wildcard version is a range, not a locked version (use an exact version)' }
    return { kind: 'sync' }
  }
  if (isMaterializeSpec(spec)) return { kind: 'materialize' }
  return { kind: 'unsyncable', reason: unsyncableReason(spec) }
}

/**
 * The syncable dependency-VALUE whitelist (design 13 §7.2): the version part of
 * PLUGIN_SPEC_PATTERN alone — `^1.0.0`, `~2.0.0`, `1.2.3`, `v1.0.0`,
 * `1.0.0-beta.1`, dist-tags `latest`/`next`. A dependency value is synced as
 * `<name>@<value>`, so a BARE version must be judged by the version grammar,
 * not the full name@spec grammar (a leading `^`/`~` would otherwise be misread
 * as a non-registry spec).
 */
export const PLUGIN_VERSION_VALUE_PATTERN = /^(\^|~)?([0-9A-Za-z][0-9A-Za-z._+-]*|latest|next)$/

/**
 * Classify a dependency VALUE — the right-hand side of a `dependencies`
 * entry (`^1.0.0`, `file:../pkg`, `workspace:*`, …) — NOT a full package
 * spec. Materialize specs stay materialize; version values matching the §7.2
 * version whitelist are syncable (`<name>@<value>`); everything else
 * (ranges with spaces/`>`/`<`/`*`/`||`, `npm:` aliases, git/URL, workspace)
 * is unsyncable.
 */
export function classifyDependencyValue(spec: string): SpecClass {
  if (isMaterializeSpec(spec)) return { kind: 'materialize' }
  if (PLUGIN_VERSION_VALUE_PATTERN.test(spec)) {
    if (hasXWildcard(spec)) return { kind: 'unsyncable', reason: 'x-wildcard version is a range, not a locked version (use an exact version)' }
    return { kind: 'sync' }
  }
  return { kind: 'unsyncable', reason: unsyncableReason(spec) }
}

// ============================================================================
// Manifest types (contract B)
// ============================================================================

/**
 * Chamber-injected host-graph state (design 09 方案 A, module A+B; surfaced so
 * the injection is never a silent modification — the plugin management UI
 * shows it verbatim):
 * - `installed` — module A's package files are present in the profile
 *   (local: `<home>/profiles/web/node_modules/@dsh-chamber/dsh-host-client-graph`,
 *   seeded per-spawn by the control plane; remote: the install-level flat
 *   fallback `<home>/profiles/node_modules/…`, seeded by seedRemoteHostGraph).
 * - `patched` — the boot layer carries the client-graph insert (local: the
 *   `--patch` overlay file; remote: the profile's cordis.patch.yml).
 * Both must hold for the row to actually resolve at boot — one without the
 * other is a half-injected state the UI renders distinctly, never "done".
 */
export interface ChamberHostGraphState {
  installed: boolean
  patched: boolean
  /** Module A's own package version (read from the seeded package.json —
   *  local: the profile node_modules copy; remote: the install-level flat
   *  fallback, whose manifest the probe already cats). null when not
   *  installed or the manifest is unreadable/version-less — never a guessed
   *  default. */
  version: string | null
  /**
   * Live-effect state of the RUNNING instance (design 09 module A liveness):
   * true = the instance's clientGraph/graph remote answered the RPC probe
   * (module A is loaded in the running process); false = injected but not
   * loaded yet (a restart is pending); null = not probed (local side / no
   * ready tunnel / the probe could not classify). The LOCAL side stays null
   * by design — the local instance IS the chamber page, whose own boot
   * already proves the graph channel (or degrades with the acknowledged
   * module-C observability gap); only the remote side has a separate probe.
   */
  live: boolean | null
}

/**
 * Probe outcome: `ok:false` = the instance's injection state could not be
 *  read (remote ssh exec failure / unparseable patch) — loud, never a silent
 *  "not injected". `gitWorktree` reports the second chamber host package
 *  (design 08 §11): its loader row lives in the SAME cordis.patch.yml, so
 *  `patched` is checked per package (the host-graph insert present does NOT
 *  prove the git-worktree insert present — a machine seeded before the git
 *  package existed can carry only the client-graph row); `live` answers the
 *  same "已生效 vs 重启后生效" question for the RUNNING instance as
 *  hostGraph.live (host-graph can be live from an older boot while the
 *  newly-seeded git-worktree row still awaits its restart). */
export type ChamberInjectionState =
  | {
    ok: true
    hostGraph: ChamberHostGraphState
    gitWorktree: { installed: boolean; patched: boolean; version: string | null; live: boolean | null }
  }
  | { ok: false; error: string }

export interface RemotePluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  profileExists: boolean
  error?: string
  /** Chamber-injected component state (design 09) probed over the wire —
   *  read-only cats, never a write. */
  chamber: ChamberInjectionState
}

export interface UnsyncableEntry {
  name: string
  reason: string
}

export interface LocalPluginManifest {
  dependencies: Record<string, string>
  bundles: string[]
  clientLines: string[]
  /** Dependency names whose own package.json declares `dsh.bundle` (design 13
   *  §4.4) — the "known bundle packages" the remote apply's bundles assertion
   *  uses (design 13 §4.5 ④). */
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
  /** Distinguishing note when `ready` is null for a NON-deferred restart
   *  (e.g. the instance was not connected before the apply, so no ready
   *  recheck was performed — never a misleading `ready:false`). */
  readyNote?: string
}

export type RemotePluginListResult = { ok: true; manifest: RemotePluginManifest } | { ok: false; error: string }
export type ApplyPluginsResult = { ok: true; result: PluginApplyResult } | { ok: false; error: string }

// ============================================================================
// Manifest parsing
// ============================================================================

/** Parse a remote profile package.json into its projected dependencies + bundles. */
export function parseRemoteManifest(text: string): { dependencies: Record<string, string>; bundles: string[]; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { dependencies: {}, bundles: [], error: `failed to parse remote package.json: ${String(error)}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { dependencies: {}, bundles: [], error: 'remote package.json is not a JSON object' }
  }
  const record = parsed as Record<string, unknown>
  const dependencies: Record<string, string> = {}
  const rawDeps = record.dependencies
  if (rawDeps !== null && typeof rawDeps === 'object' && !Array.isArray(rawDeps)) {
    for (const [name, spec] of Object.entries(rawDeps as Record<string, unknown>)) {
      if (typeof spec === 'string') dependencies[name] = spec
    }
  }
  return { dependencies, bundles: readStringArray(record, ['dsh', 'profile', 'bundles']) }
}

function readStringArray(record: Record<string, unknown>, path: string[]): string[] {
  let current: unknown = record
  for (const key of path) {
    if (current === null || typeof current !== 'object') return []
    current = (current as Record<string, unknown>)[key]
  }
  if (!Array.isArray(current)) return []
  return current.filter((item): item is string => typeof item === 'string')
}

/** Read the `version` string from a JSON package-manifest text; null when
 *  unreadable or version-less — never a guessed default. */
function parsePackageVersion(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed?.version === 'string' && parsed.version !== '' ? parsed.version : null
  } catch {
    return null
  }
}

/** Read the `version` string from an already-parsed package manifest; null
 *  when absent/unreadable. */
function readManifestVersion(pkg: unknown): string | null {
  if (pkg === null || typeof pkg !== 'object' || Array.isArray(pkg)) return null
  const version = (pkg as Record<string, unknown>).version
  return typeof version === 'string' && version !== '' ? version : null
}

/**
 * Classify one dependency's own package.json (design 13 §4.4): `dsh.bundle.patch`
 * → bundle, `dsh.client` → client, anything else → plain.
 */
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

// ============================================================================
// 1. localPluginList
// ============================================================================

/**
 * Read the LOCAL profile manifest from the authoritative local dsh home
 * (`<localDshHome>/profiles/web/package.json` — NOT `dsh-chamber:info.dshHome`,
 * which currently drifts from the real spawn home, design 13 §2.2). Projects
 * `dependencies` + `dsh.profile.bundles`, classifies each dependency's
 * node_modules package as bundle/client/plain, and flags unsyncable dependency
 * VALUES (by the value grammar — ordinary `^1.0.0`/`~2.0.0` ranges are
 * syncable, never flagged). Dependency names are whitelist-checked before any
 * node_modules read (path traversal defense). Throws on an unreadable/
 * malformed profile manifest.
 */
export function localPluginList(localDshHome: string): LocalPluginManifest {
  const profileDir = join(localDshHome, 'profiles', WEB_PROFILE)
  const manifestPath = join(profileDir, 'package.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read local profile manifest (${manifestPath}): ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`local profile manifest is not a JSON object (${manifestPath})`)
  }
  const record = parsed as Record<string, unknown>
  const dependencies: Record<string, string> = {}
  const rawDeps = record.dependencies
  if (rawDeps !== null && typeof rawDeps === 'object' && !Array.isArray(rawDeps)) {
    for (const [name, spec] of Object.entries(rawDeps as Record<string, unknown>)) {
      if (typeof spec === 'string') dependencies[name] = spec
    }
  }
  const bundles = readStringArray(record, ['dsh', 'profile', 'bundles'])
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
    // The dependency VALUE is classified by the value grammar
    // (classifyDependencyValue): `^1.0.0` / `~2.0.0` are ordinary registry
    // ranges → syncable, never mislabeled unsyncable. `classifySpec` (full
    // name@spec grammar) would reject a bare `^1.0.0` as a non-registry spec.
    const cls = classifyDependencyValue(spec)
    if (cls.kind === 'unsyncable') unsyncable.push({ name, reason: cls.reason })
  }
  return {
    dependencies,
    bundles,
    clientLines,
    bundleLines,
    unsyncable,
    // Chamber-injected host-graph (design 09 module B): module A's package in
    // the profile node_modules + the `--patch` overlay beside the dsh home.
    // Both must be present for the client-graph row to resolve at boot — the
    // UI renders the half-injected state distinctly, never as "done".
    chamber: {
      ok: true,
      hostGraph: {
        // installed = BOTH seed files present — the same two-file definition
        // as the remote probe and the seed writer (SEED_FILES, control-plane
        // host-graph-seed.ts HOST_GRAPH_SEED_FILES): a package.json without
        // dist/index.js is a half-injected module A (the boot row could not
        // resolve) and must report 未注入, never "done".
        installed: SEED_FILES.every(relative =>
          existsSync(join(profileDir, 'node_modules', CLIENT_GRAPH_PACKAGE_NAME, relative))),
        patched: existsSync(join(dirname(localDshHome), HOST_GRAPH_PATCH_FILENAME)),
        // Module A's own version from the seeded manifest (null when absent).
        version: readManifestVersion(readDependencyManifest(profileDir, CLIENT_GRAPH_PACKAGE_NAME)),
        // Local side: the local instance IS the chamber page — its own boot
        // proves the graph channel (or degrades with the acknowledged module-C
        // observability gap). No separate liveness probe; the remote side
        // carries one (probeRemoteChamber liveProbe).
        live: null,
      },
      // Second chamber host package (design 08 §11) — same two-file presence
      // definition as the remote probe; `patched` checks the overlay CONTENT
      // for the git-worktree row (the overlay normally carries both rows, but
      // a stale overlay from before the git package existed can carry only the
      // client-graph row — the same half-injected state the remote probe's
      // per-package insert check detects); no live probe on the local side.
      gitWorktree: {
        installed: SEED_FILES.every(relative =>
          existsSync(join(profileDir, 'node_modules', GIT_WORKTREE_PACKAGE_NAME, relative))),
        patched: localOverlayCarriesGitWorktree(localDshHome),
        version: readManifestVersion(readDependencyManifest(profileDir, GIT_WORKTREE_PACKAGE_NAME)),
        live: null,
      },
    },
  }
}

// ============================================================================
// 1.5 Renderer projection + confirmation copy (design 09 §4 v1 mitigations)
// ============================================================================

/**
 * Mask for local-path dependency values in the renderer-facing projection.
 * The IPC surface must never echo local absolute paths: a remote instance's
 * client bundle executes in the chamber page (declared trust boundary, design
 * 09 §4) and could read them. The mask keeps a `file:` prefix so BOTH sides'
 * spec classifiers (main `isMaterializeSpec` / client `isPathSpec`) still
 * classify the value as materialize and the name-based diff matching
 * (plugin-diff.ts §4.5) keeps working unchanged.
 */
export const MATERIALIZED_VALUE_MASK = 'file:<hidden>'

/**
 * Project the LOCAL manifest for the renderer: dependency VALUES that are
 * local-path specs (file:/link:/relative/absolute/`~/` — classified
 * materialize) are replaced with MATERIALIZED_VALUE_MASK. Names, kinds,
 * bundle lines, unsyncable entries and the chamber block pass through
 * untouched. The main-process-internal full manifest (used by
 * resolveLocalMaterializeDirectory, applyPlugins knownBundles, the seed
 * paths) is never projected — only the IPC response is redacted.
 */
export function redactLocalPluginManifest(manifest: LocalPluginManifest): LocalPluginManifest {
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    dependencies[name] = classifyDependencyValue(spec).kind === 'materialize' ? MATERIALIZED_VALUE_MASK : spec
  }
  return { ...manifest, dependencies }
}

/** Is this dependency spec a remote-local-path `file:` value? Case-
 *  insensitive, mirroring the gateway installed-route semantics (design 21
 *  §6.2: on a dsh-managed profile only `file:` forms can name machine-local
 *  paths — the write flows land registry or file: entries; link:/relative/
 *  absolute forms cannot reach a profile through `dsh plugin`). */
export function isRemoteFileValue(spec: string): boolean {
  return /^file:/i.test(spec)
}

/**
 * Project a REMOTE manifest for the renderer (design 21 §6.2/§6.4 readManifest
 * 投影统一掩码, decision 18): dependency VALUES that are `file:` specs would
 * name remote-machine paths and must never leave the main process in a
 * renderer-bound IPC response. Each is replaced with MATERIALIZED_VALUE_MASK
 * (file:-prefixed only — exactly the gateway `/chamber/plugins/installed`
 * semantics); the mask keeps the `file:` prefix so both sides' spec
 * classifiers still classify the value as materialize and the name-based diff
 * matching (plugin-diff.ts §4.5) keeps working unchanged. Names, bundles,
 * profileExists, error and the chamber block pass through untouched. The
 * main-process-internal manifest (verifyApplied's post-change read-back, the
 * undo journal snapshot, materialize resolution) is NEVER projected — only
 * the plugin_list IPC response is redacted (main.ts SSH_PLUGIN_LIST handler).
 */
export function redactRemotePluginManifest(manifest: RemotePluginManifest): RemotePluginManifest {
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    dependencies[name] = isRemoteFileValue(spec) ? MATERIALIZED_VALUE_MASK : spec
  }
  return { ...manifest, dependencies }
}

/** Confirmation-dialog copy builder (pure, tested): pack-and-transfer. */
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

/** Confirmation-dialog copy builder (pure, tested): local install. */
export function describeLocalPluginAddConfirmation(spec: string): { message: string; detail: string } {
  return {
    message: `安装插件 ${spec} 到本地 dsh？`,
    detail: `将从 npm registry 安装 ${spec} 到本地 dsh profile。\n该插件的客户端代码将在下次本地实例启动时于本应用内执行。`,
  }
}

/** Confirmation-dialog copy builder (pure, tested): local remove. */
export function describeLocalPluginRemoveConfirmation(name: string): { message: string; detail: string } {
  return {
    message: `从本地 dsh 移除插件 ${name}？`,
    detail: `将从本地 dsh profile 卸载 ${name}。`,
  }
}

/** Confirmation-dialog copy builder (pure, tested): manual chamber host
 *  seed (persistent remote modification — packages + boot-layer merge;
 *  2026 review). */
export function describeSeedConfirmation(info: { targetLabel: string | null; targetId: string }): { message: string; detail: string } {
  const target = info.targetLabel ?? info.targetId
  return {
    message: `向远程实例 ${target} 注入 chamber 宿主组件？`,
    detail: `将在远端实例 ${target} 上写入 chamber host 包并挂载 boot 层（幂等，已是最新则跳过）。\n注入内容来自本机已构建的 chamber 包，重启远端 dsh 后生效。`,
  }
}

/** Confirmation-dialog copy builder (pure, tested): remote plugin apply
 *  (registry add/remove on a remote instance — a persistent execution
 *  surface, same class as the local install; 2026 final review). */
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
 * Whether the local `--patch` overlay (control-plane host-graph-seed.ts
 * `dsh-chamber-graph.patch.yml`, beside the managed dsh home) actually
 * carries the git-worktree loader row. Presence of the overlay file alone
 * does not prove it: the overlay is regenerated per spawn with only the rows
 * whose built artifacts exist, so a stale overlay can predate the git
 * package. Unreadable/absent → false (never a guessed "patched").
 */
function localOverlayCarriesGitWorktree(localDshHome: string): boolean {
  const overlayPath = join(dirname(localDshHome), HOST_GRAPH_PATCH_FILENAME)
  if (!existsSync(overlayPath)) return false
  try {
    return hasExactInsert(readFileSync(overlayPath, 'utf8'), toCordisInsert(GIT_WORKTREE_HOST_INSERT))
  } catch {
    return false
  }
}

/**
 * Resolve one materialize dependency from the authoritative local manifest.
 * The renderer supplies only the dependency name; it never supplies a path.
 * Relative specs are anchored exactly where pnpm resolves them (the web
 * profile directory), and the target package name must match the manifest key.
 */
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
  if (typeof spec !== 'string' || classifyDependencyValue(spec).kind !== 'materialize') {
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
    // This result crosses into the renderer. Keep the selected/resolved local
    // path inside the main process even on ENOENT/permission failures.
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

// ============================================================================
// 2. remotePluginList
// ============================================================================

export async function remotePluginList(exec: ExecFn, spec: RemoteSpec, opts?: { liveProbe?: LiveProbe; gitWorktreeLiveProbe?: LiveProbe }): Promise<RemotePluginListResult> {
  const path = remoteManifestPath(spec.remoteDshHome)
  // Quiet (2026-08 review fix): on an uninitialized remote profile the
  // manifest cat ENOENTs — an EXPECTED probe failure that must not write an
  // ERROR "run command failed" line into the instance log panel, exactly the
  // pollution the quiet flag exists to prevent (same rule as the chamber
  // probe cats below). ENOENT classification still rides the result; a
  // genuine ssh failure stays loud.
  const result = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [path], quiet: true })
  if (!result.ok) {
    // ENOENT = the remote profile is not initialized (not a fatal ssh error).
    if (ENOENT_PATTERN.test(result.error)) {
      return { ok: true, manifest: { dependencies: {}, bundles: [], profileExists: false, chamber: await probeRemoteChamber(exec, spec, opts) } }
    }
    return { ok: false, error: result.error }
  }
  const parsed = parseRemoteManifest(result.stdout ?? '')
  return {
    ok: true,
    manifest: {
      dependencies: parsed.dependencies,
      bundles: parsed.bundles,
      profileExists: true,
      error: parsed.error,
      chamber: await probeRemoteChamber(exec, spec, opts),
    },
  }
}

/**
 * Live-effect probe of the running instance (design 09 module A): true = the
 * instance's clientGraph/graph remote answered (module A loaded), false =
 * injected but restart pending, null = unknown/unprobed. The desktop main
 * adapts probeClientGraphLive (ssh-provider.ts) onto this shape.
 */
export type LiveProbe = () => Promise<boolean | null>

/**
 * Read-only probe of the chamber-injected host-graph state on a remote
 * instance (design 09 module A+B): module A's TWO seed files (package.json +
 * dist/index.js — the same SEED_FILES set seedRemoteHostGraph writes) at the
 * install-level flat fallback (`<home>/profiles/node_modules/…`, the layer
 * seedRemoteHostGraph writes and `dsh plugin` pnpm relinks never prune) +
 * the profile's cordis.patch.yml inserts (reusing computeCordisPatchUpdate's
 * dedup rules, checked PER package — the host-graph insert present does not
 * prove the git-worktree insert present, design 08 §11). Three extra `cat`
 * round-trips, all marked quiet (their ENOENT on a not-yet-seeded instance
 * is expected, never a log-panel error); ENOENT = that file not injected
 * (never an error); any other ssh failure is a loud probe error — never a
 * silent "not injected". `installed` requires BOTH files: a package.json
 * without dist/index.js is a half-installed module A (the boot row could not
 * resolve) and must not report "installed".
 *
 * Additionally parses each package's own VERSION from the package.json it
 * already cats, and — when a `liveProbe`/`gitWorktreeLiveProbe` is supplied
 * (the desktop main's tunnel RPC probes) — reports whether the RUNNING
 * instance has actually loaded the module (live tri-state), so the plugin UI
 * can distinguish "已生效" from "重启后生效" instead of a constant claim.
 */
async function probeRemoteChamber(exec: ExecFn, spec: RemoteSpec, opts?: { liveProbe?: LiveProbe; gitWorktreeLiveProbe?: LiveProbe }): Promise<ChamberInjectionState> {
  const home = remoteHome(spec.remoteDshHome)
  const pkgPath = `${home}/profiles/node_modules/${CLIENT_GRAPH_PACKAGE_NAME}/package.json`
  const indexPath = `${home}/profiles/node_modules/${CLIENT_GRAPH_PACKAGE_NAME}/dist/index.js`
  const pkgRes = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [pkgPath], quiet: true })
  let pkgInstalled: boolean
  let version: string | null = null
  if (pkgRes.ok) {
    pkgInstalled = true
    version = parsePackageVersion(pkgRes.stdout ?? '')
  } else if (ENOENT_PATTERN.test(pkgRes.error)) {
    pkgInstalled = false
  } else {
    return { ok: false, error: `host-graph probe failed: ${pkgRes.error}` }
  }
  const indexRes = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [indexPath], quiet: true })
  let indexInstalled: boolean
  if (indexRes.ok) {
    indexInstalled = true
  } else if (ENOENT_PATTERN.test(indexRes.error)) {
    indexInstalled = false
  } else {
    return { ok: false, error: `host-graph probe failed: ${indexRes.error}` }
  }
  const installed = pkgInstalled && indexInstalled

  const patchRes = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [remotePatchPath(spec.remoteDshHome)], quiet: true })
  let patched = false
  let gitPatched = false
  if (patchRes.ok) {
    // Per-package insert presence: the two chamber boot rows live in the SAME
    // cordis.patch.yml, but one can predate the other (a machine seeded before
    // the git-worktree package existed carries only the client-graph row —
    // hostGraph live would then report 已生效 while the git RPC 404s and the
    // sidebar silently shows no git surface). Each row is judged against its
    // own insert; a conflict in either is a loud probe error.
    const update = computeCordisPatchUpdate(patchRes.stdout ?? '', [CLIENT_GRAPH_HOST_INSERT])
    if ('error' in update) return { ok: false, error: update.error }
    patched = update.write === false
    const gitUpdate = computeCordisPatchUpdate(patchRes.stdout ?? '', [GIT_WORKTREE_HOST_INSERT])
    if ('error' in gitUpdate) return { ok: false, error: gitUpdate.error }
    gitPatched = gitUpdate.write === false
  } else if (!ENOENT_PATTERN.test(patchRes.error)) {
    return { ok: false, error: `host-graph probe failed: ${patchRes.error}` }
  }

  // Liveness only when BOTH halves are present AND a probe was supplied: a
  // half-injected module cannot be live by definition; without a ready tunnel
  // the desktop cannot reach the instance's RPC (null = honest "not probed").
  const live = installed && patched && opts?.liveProbe !== undefined
    ? await opts.liveProbe()
    : null

  // Second chamber host package (design 08 §11). Its own boot-row presence
  // (gitPatched) and its own running-process liveness (gitWorktreeLiveProbe)
  // are probed separately: host-graph live from an older boot does NOT prove
  // the git-worktree row loaded (a restart seeded the row after that boot).
  const gitPkgPath = `${home}/profiles/node_modules/${GIT_WORKTREE_PACKAGE_NAME}/package.json`
  const gitIndexPath = `${home}/profiles/node_modules/${GIT_WORKTREE_PACKAGE_NAME}/dist/index.js`
  const gitPkgRes = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [gitPkgPath], quiet: true })
  let gitPkgInstalled: boolean
  let gitVersion: string | null = null
  if (gitPkgRes.ok) {
    gitPkgInstalled = true
    gitVersion = parsePackageVersion(gitPkgRes.stdout ?? '')
  } else if (ENOENT_PATTERN.test(gitPkgRes.error)) {
    gitPkgInstalled = false
  } else {
    return { ok: false, error: `git-worktree probe failed: ${gitPkgRes.error}` }
  }
  const gitIndexRes = await exec(spec.id, 'run', { op: 'exec', command: 'cat', argv: [gitIndexPath], quiet: true })
  let gitIndexInstalled: boolean
  if (gitIndexRes.ok) {
    gitIndexInstalled = true
  } else if (ENOENT_PATTERN.test(gitIndexRes.error)) {
    gitIndexInstalled = false
  } else {
    return { ok: false, error: `git-worktree probe failed: ${gitIndexRes.error}` }
  }
  const gitInstalled = gitPkgInstalled && gitIndexInstalled
  const gitLive = gitInstalled && gitPatched && opts?.gitWorktreeLiveProbe !== undefined
    ? await opts.gitWorktreeLiveProbe()
    : null

  return {
    ok: true,
    hostGraph: { installed, patched, version, live },
    gitWorktree: { installed: gitInstalled, patched: gitPatched, version: gitVersion, live: gitLive },
  }
}

// ============================================================================
// 3. applyPlugins
// ============================================================================

export interface ApplyActions {
  add: string[]
  remove: string[]
  restart?: boolean
}

/**
 * Durable per-instance ssh apply journal sink (design 21 §6.4, plan Phase 5
 * ssh 统一增量 — produced by ssh-plugin-journal.ts createSshPluginJournal).
 * STRUCTURAL on purpose: plugin-sync never imports the journal module, and an
 * apply without a journal keeps its exact historical exec/read behavior. The
 * implementor never throws (journaling is best-effort; a persistence failure
 * must never break an apply).
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

/** Pre-change remote manifest read used ONLY by the journal capture: a single
 *  quiet `cat` + parse of the profile manifest (no chamber probes — the
 *  journal only needs the dependency rows). Returns the dependency map, or
 *  null when the read failed with a real ssh error (an absent profile is an
 *  empty map — ENOENT classification rides the result). */
async function readJournalSnapshot(exec: ExecFn, spec: RemoteSpec): Promise<Record<string, string> | null> {
  const res = await exec(spec.id, 'run', {
    op: 'exec',
    command: 'cat',
    argv: [remoteManifestPath(spec.remoteDshHome)],
    quiet: true,
  })
  if (!res.ok) {
    return ENOENT_PATTERN.test(res.error) ? {} : null
  }
  return parseRemoteManifest(res.stdout ?? '').dependencies
}

/** In-flight apply guards (single-flight per instance, design 13 §4.5 ⑥). */
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

/** Re-pull the remote manifest and assert the applied set landed (design 13 §4.5 ④). */
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
    // design 13 §4.5 ④: a KNOWN bundle-declaring add must also land in the
    // remote bundle activation layer (`dsh.profile.bundles`, which the
    // remote `dsh plugin` reconcile fills), not just in dependencies — the
    // layer a broken reconcile would silently skip.
    if (knownBundles !== undefined && knownBundles.includes(name) && !bundles.includes(name)) return false
  }
  for (const name of remove) {
    if (failedSpecs.has(name)) continue
    if (name in deps) return false
  }
  return true
}

/**
 * Apply a plugin-set change to one remote instance (design 13 §4.5):
 * ① re-validate add/remove against the §7.2 whitelists (never trust the
 *    renderer) and `restart` as a boolean;
 * ② remove then add, serial, per-item failure isolation;
 * ③ restart when there was a change and `restart !== false` (defer otherwise);
 * ④ re-pull the manifest and assert add∈dependencies (bundle-declaring adds
 *    also ∈ bundles, per `opts.knownBundles`) / remove∉dependencies;
 * ⑤ bounded ready recheck after a successful restart — skipped with a
 *    distinguishing `readyNote` when the instance was not connected before
 *    the apply (a 30s timeout would misreport it as "restarted but broken");
 * ⑥ single-flight.
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
    /** Undo journal sink (design 21 §6.4): when present, a pre-change
     *  manifest snapshot is read BEFORE the first remote change and every
     *  executed row is recorded with its pre-change spec (`specBefore`).
     *  Absent → the apply keeps its historical exec sequence (no extra read,
     *  no journaling). */
    journal?: SshApplyJournalSink
    /** Operational target fingerprint (main.ts operationalFingerprint) of
     *  the instance the rows execute on; recorded on every journal entry so
     *  an undo can never replay a change onto a different host that reuses
     *  the same connection id after an edit (design 21 §6.4 review P1). */
    targetFingerprint?: string | null
  },
): Promise<ApplyPluginsResult> {
  const id = spec.id
  const inFlightKey = `${id}\u0000${opts?.ownershipKey ?? ''}`

  // ⑥ single-flight: exact operational incarnation, not merely the reusable
  // registry id. A changed target may start immediately and stale finally
  // removes only its own key.
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
  // Reserved-name deny (design 21 §6.4/decision 19, same set as the gateway):
  // @deepseek-ai/* and @dsh-chamber/* are the official/chamber domains and
  // can never be installed or removed through the plugin model — refuse the
  // WHOLE batch, loudly, listing the denied names, BEFORE any remote change
  // (never a partial apply around a refused row). parseSpecName extracts the
  // name of every add row (the rows are already whitelist-shaped above);
  // remove rows carry their name directly. buildSshApplyRows stays the
  // shared assembly both here and the main-process IPC preflight use.
  const assembled = buildSshApplyRows(add, remove)
  if (assembled.refused.length > 0) {
    return { ok: false, error: describeReservedNameRefusal(assembled.refused) }
  }
  // A non-boolean `restart` (e.g. the string 'false') must never be treated
  // as truthy and trigger an unwanted restart.
  if (actions.restart !== undefined && typeof actions.restart !== 'boolean') {
    return { ok: false, error: 'restart must be a boolean' }
  }

  applyInFlight.add(inFlightKey)
  try {
    const failed: { spec: string; error: string }[] = []
    let applied = 0

    // Journal capture (design 21 §6.4): read the pre-change manifest BEFORE
    // the first remote change so every executed row can be recorded with the
    // spec the touched name had before the op (add: null when the name was
    // absent; remove: the previous spec string — the undo journal's undoable
    // fact). A failed snapshot (real ssh error) never aborts the apply — the
    // rows are recorded with specBefore null and the row outcome still tells
    // the truth; an absent profile (ENOENT) is an empty snapshot.
    const journal = opts?.journal
    const snapshot = journal === undefined ? null : await readJournalSnapshot(exec, spec)
    const specBeforeOf = (name: string): string | null =>
      snapshot === null ? null : (snapshot[name] ?? null)

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
      // The pre-apply phase decides whether a ready recheck is meaningful:
      // an instance that was NOT connected (phase idle/connecting/error)
      // before the apply cannot come ready inside the recheck window, and a
      // bounded timeout would misreport a healthy-but-disconnected instance
      // as "restarted but not recovered". Distinguish instead.
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
      // restart failure: restarted stays false, ready stays null — honest
      // "installed but restart failed" report, never a fake success.
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

// ============================================================================
// 4. seedRemoteChamberHostPackages (design 13 §4.6, M2)
// ============================================================================

export interface ChamberHostPackageSeed {
  insertId: string
  packageName: string
  sourceDir: string
  label: string
}

export interface ChamberHostPackageSeedState {
  insertId: string
  packageName: string
  wrote: boolean
}

type ChamberHostInsert = Pick<ChamberHostPackageSeed, 'insertId' | 'packageName'>

const CLIENT_GRAPH_HOST_INSERT: ChamberHostInsert = {
  insertId: CLIENT_GRAPH_INSERT_ID,
  packageName: CLIENT_GRAPH_PACKAGE_NAME,
}

const GIT_WORKTREE_HOST_INSERT: ChamberHostInsert = {
  insertId: GIT_WORKTREE_INSERT_ID,
  packageName: GIT_WORKTREE_PACKAGE_NAME,
}

/**
 * Adapt the local {insertId, packageName} pair to the shared CordisInsert
 * ({id, name}) — the insert render/parse/conflict logic is single-sourced in
 * control-plane (cordis-inserts.ts).
 */
function toCordisInsert(insert: ChamberHostInsert): CordisInsert {
  return { id: insert.insertId, name: insert.packageName }
}

export type CordisPatchUpdate =
  | { write: false }
  | { write: true; content: string }
  | { error: string }

/**
 * Decide how to fold the client-graph insert into an existing cordis.patch.yml
 * (design 13 §4.6): dedup when already present; deterministic rewrite for the
 * `initProfile` template (comments + `[]`); append for a user block-sequence
 * list (never overwriting user rows); fail-loud for a non-list.
 *
 * The insert render/parse/conflict classification is single-sourced in
 * control-plane (cordis-inserts.ts, consumed through control-plane-module.ts);
 * the fold semantics and message wording stay here.
 * @param existing - the file content, or null when the file does not exist
 *   (profile not initialized).
 */

/** The cordis.patch.yml conflict wording for one desired insert (the shared
 *  insertConflict classification mapped onto this module's error surface). */
function cordisConflictMessage(conflict: InsertConflictKind, insert: ChamberHostInsert): string {
  if (conflict === 'duplicate-identity') {
    return `cordis.patch.yml contains duplicate chamber loader identity for id '${insert.insertId}' or package '${insert.packageName}'`
  }
  if (conflict === 'id-bound') {
    return `cordis.patch.yml loader id '${insert.insertId}' is already bound to a different package`
  }
  return `cordis.patch.yml package '${insert.packageName}' is already mounted under a different loader id`
}

export function computeCordisPatchUpdate(
  existing: string | null,
  inserts: readonly ChamberHostInsert[] = [CLIENT_GRAPH_HOST_INSERT],
): CordisPatchUpdate {
  if (existing === null) {
    return { error: 'remote profile is not initialized (cordis.patch.yml missing) — run a plugin add first' }
  }
  for (const insert of inserts) {
    const conflict = insertConflict(existing, toCordisInsert(insert))
    if (conflict !== null) return { error: cordisConflictMessage(conflict, insert) }
  }
  const missing = inserts.filter(insert => !hasExactInsert(existing, toCordisInsert(insert)))
  if (missing.length === 0) return { write: false }
  const rendered = renderCordisInserts(missing.map(toCordisInsert))
  const significant = existing.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  // Empty list: the initProfile template (`# comments\n[]`) or a comments-only
  // file — deterministic rewrite, preserving the comment header.
  if (significant.length === 0 || (significant.length === 1 && significant[0] === '[]')) {
    const base = existing.replace(/\[\]\s*$/, '').trimEnd()
    return { write: true, content: base === '' ? rendered : `${base}\n${rendered}` }
  }
  // A block-sequence list: append at the end, never touching existing rows.
  if (significant[0].startsWith('-')) {
    return { write: true, content: `${existing.replace(/\s+$/, '')}\n${rendered}` }
  }
  return { error: 'cordis.patch.yml is not a top-level YAML array — cannot seed chamber host inserts safely' }
}

export type SeedRemoteResult = { ok: true; wrote: boolean; patched: boolean } | { ok: false; error: string }

export type SeedRemoteHostPackagesResult =
  | { ok: true; wrote: boolean; patched: boolean; packages: ChamberHostPackageSeedState[] }
  | { ok: false; error: string }

/**
 * Seed all built chamber host packages onto a remote instance (design 13
 * §4.6): ensure cordis.patch.yml carries their exact inserts (cat read-back
 * dedup, append merge, non-list fail-loud), then write-file package.json +
 * dist/index.js into the install-level flat fallback
 * `<remoteDshHome>/profiles/node_modules/@dsh-chamber/...` (not the profile
 * node_modules — that is managed by pnpm and re-linked on every `dsh plugin`
 * op). The PATCH IS PROBED FIRST: an uninitialized remote profile (the patch
 * `cat` ENOENTs) or an unmergeable patch fails loud BEFORE any package file is
 * written — a failed seed never leaves half-injected state (package files
 * present, boot insert missing). The patch WRITE stays gated on the package
 * files having been written (an insert referencing a package that does not
 * exist on the remote would break its host boot). Hash-identical files are
 * skipped (byte-domain comparison). The probe cats are marked `quiet`: on a
 * first seed the files genuinely do not exist (ENOENT by design) — the
 * expected failures are returned to the caller (ENOENT classification keeps
 * working) but never logged as instance-panel errors. An absent build artifact
 * is "not shipped" — the LOCAL seed's graceful-skip invariant
 * (control-plane host-graph-seed.ts) — so the seed returns
 * `{wrote:false, patched:false}` WITHOUT touching the patch. A built source
 * that is missing another declared file fails loudly.
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
  for (const seed of seeds) {
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

  // Only a built dist/index.js makes a package available. A checkout may have
  // the source directory without its artifact; that is "not shipped", so it
  // must not create a dangling loader row.
  const available = seeds.filter(seed => existsSync(join(seed.sourceDir, 'dist', 'index.js')))
  if (available.length === 0) return { ok: true, wrote: false, patched: false, packages: [] }

  // Preflight every local byte before touching the remote. In particular, a
  // broken second package cannot leave the first package half-seeded.
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

  // Patch probe FIRST (fail-fast, design 13 §4.6): the cordis.patch.yml
  // `cat` is the uninitialized-profile signal — a missing profile dir makes
  // it ENOENT, and computeCordisPatchUpdate(null) turns that into the loud
  // "remote profile is not initialized" error. Probing before any package
  // write means the fail-loud path never leaves partial package files behind.
  // The probe is quiet: its ENOENT is expected on a first seed.
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

  // Probe every remote byte before the first write. A transport/read failure
  // for package two therefore cannot leave package one partially updated.
  for (const file of staged) {
    const catRes = await exec(id, 'run', { op: 'exec', command: 'cat', argv: [file.remotePath], quiet: true })
    if (catRes.ok) {
      // Hash-skip: a cat read-back whose bytes match skips the write — the
      // comparison is byte-domain (stdoutBytes), so binary seed files never
      // false-mismatch through the lossy UTF-8 view. A hash MISMATCH on an
      // ok read-back (content drift) still falls through to the write.
      if (sha256hex(catRes.stdoutBytes ?? Buffer.from(catRes.stdout ?? '', 'utf8')) === file.sha256) file.write = false
    } else if (!ENOENT_PATTERN.test(catRes.error)) {
      // ENOENT = genuinely absent → write below (same discipline as the patch
      // probe above). ANY other ssh failure is loud — attempting a write that
      // will also fail would mask the real cause behind a misleading
      // "write-file failed" error. The probe cat is quiet: on a first seed the
      // file genuinely does not exist (ENOENT by design).
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

  // Ensure cordis.patch.yml carries the insert — the WRITE stays AFTER the
  // package files (never a dangling insert referencing a package that does
  // not exist on the remote). The probe above already validated the merge.
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

/** Backwards-compatible single-package wrapper used by the existing IPC. */
export async function seedRemoteHostGraph(
  exec: ExecFn,
  spec: RemoteSpec,
  moduleASourceDir: string,
): Promise<SeedRemoteResult> {
  const result = await seedRemoteChamberHostPackages(exec, spec, [{
    insertId: CLIENT_GRAPH_INSERT_ID,
    packageName: CLIENT_GRAPH_PACKAGE_NAME,
    sourceDir: moduleASourceDir,
    label: 'host-graph',
  }])
  if (!result.ok) return result
  return { ok: true, wrote: result.wrote, patched: result.patched }
}

// ============================================================================
// 5. materializeAndAdd (design 13 §4.6, M2 — optional fallback)
// ============================================================================

export type MaterializeResult = { ok: true; spec: string; remotePath: string } | { ok: false; error: string }

/** The materialized-tarball stable dir (design 13 §4.6): ALWAYS the literal
 *  `~/.dsh-chamber/plugins` — the remote shell expands `~` at word start for
 *  the write-file `mkdir -p`/redirect, and the write-file target whitelist
 *  (ssh-provider resolveWriteTarget) accepts exactly this prefix. It is
 *  intentionally independent of `remoteDshHome` (an absolute home must not
 *  move the dir into a `<dirname(home)>` subtree that the whitelist does not
 *  cover). The absolute form for the `file:` add spec is derived from the
 *  REMOTE `$HOME` (materializeAbsolutePath), never the local home. */
export function materializePluginsDir(_remoteDshHome: string | null): string {
  return '~/.dsh-chamber/plugins'
}

/** A remote `$HOME` value is usable for the `file:` spec only when it is an
 *  absolute, shell-safe path (no spaces/metachars — it rides the remote shell
 *  command line and pnpm's `file:` resolution). */
const REMOTE_HOME_PATTERN = /^\/[a-zA-Z0-9._/-]+$/

/**
 * Resolve a leading `~` in a remote path to the REMOTE user's home (design 13
 * §4.6: a word-middle `~` is not expanded by the remote shell/pnpm, so the
 * `file:` spec needs the absolute form). The home is read from the REMOTE
 * side via the whitelisted `printf %s $HOME` exec — never the LOCAL home
 * (which names a path that does not exist on the remote). Fail-loud when the
 * remote home cannot be determined or is not shell-safe; never silent.
 */
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
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

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
  if (!existsSync(ledger)) return null
  try {
    const parsed = JSON.parse(readFileSync(ledger, 'utf8')) as Partial<LocalPluginWriterRecord>
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
  const parent = dirname(ledger)
  mkdirSync(parent, { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodSync(parent, PRIVATE_DIR_MODE)
  const record: LocalPluginWriterRecord = {
    schemaVersion: LOCAL_PLUGIN_WRITER_SCHEMA,
    pid,
    ownerPid: process.pid,
    ownerStartToken: ownerIdentity?.startToken ?? null,
    childStartToken: childIdentity?.startToken ?? null,
    childCommandHash: childIdentity?.commandHash ?? null,
    createdAt: new Date().toISOString(),
  }
  const tmp = `${ledger}.tmp-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    chmodSync(tmp, PRIVATE_FILE_MODE)
    renameSync(tmp, ledger)
    chmodSync(ledger, PRIVATE_FILE_MODE)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

/** Reap a plugin writer left by a hard-crashed Electron owner. Identity is
 * checked before signaling so PID reuse can never kill an unrelated process.
 * A corrupt or unverifiable live record fails closed and blocks DSH_HOME use. */
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
  // If the original group leader is still present, authenticate it exactly
  // before signaling. A daemonized descendant may keep the original process
  // group alive after that leader exits; in that case there is no leader PID
  // left to compare, but the still-live PGID remains reserved to that group.
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

/** App-quit barrier for every local pack/plugin child and its Unix group.
 * The historical and runtime-controller names share one single-flight owner. */
export function disposePluginSyncChildren(): Promise<void> {
  pluginSyncDisposePromise ??= localPluginChildSupervisor.dispose()
  return pluginSyncDisposePromise
}

export function disposeLocalPluginChildren(): Promise<void> {
  return disposePluginSyncChildren()
}

/** Run a bounded child without blocking Electron's main event loop. */
export async function runChild(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; writerHome?: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const env = Object.fromEntries(
    Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  let supervisionComplete = false
  try {
    const result = await localPluginChildSupervisor.run([command, ...args], {
      cwd: options.cwd,
      env,
      timeoutMs: options.timeoutMs,
      onSpawn: options.writerHome === undefined
        ? undefined
        : pid => writeLocalPluginWriterRecord(options.writerHome!, pid),
    })
    // A resolved supervisor promise means the direct child and its Unix
    // process group have both been proven gone. Only then may crash evidence
    // be cleared, regardless of the command's exit status.
    supervisionComplete = true
    if (result.status === 0) return { ok: true }
    return { ok: false, error: result.stderr.trim() || `child exited ${result.status ?? 'unknown'}` }
  } catch (error) {
    // A residual/unknown writer is not an ordinary command failure. Preserve
    // the durable ledger in `finally` and reject so the caller's writer fence
    // cannot observe a normal result while DSH_HOME may still be mutating.
    if (isRuntimeInstallerWriterSafetyError(error)) throw error
    return { ok: false, error: String(error) }
  } finally {
    if (options.writerHome !== undefined && supervisionComplete) {
      try { rmSync(localPluginWriterLedgerPath(options.writerHome), { force: true }) } catch { /* startup reaper handles residue */ }
    }
  }
}

/** Build the fixed pack argv. `pnpm pack` otherwise runs prepack/prepare/
 * postpack from the selected directory; folder selection is consent to read
 * and transfer a package, not consent to execute that package's code. */
export function buildPnpmPackArgs(outDir: string): string[] {
  return ['pack', '--config.ignore-scripts=true', '--pack-destination', outDir]
}

async function packDirectory(localDir: string): Promise<{ bytes: Buffer } | null> {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-materialize-'))
  try {
    const pnpmBin = resolvePnpmBinDir()
    const env = pnpmBin === null
      ? process.env
      : { ...process.env, PATH: `${pnpmBin}${pathDelimiter()}${process.env.PATH ?? ''}` }
    const result = await runChild(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', buildPnpmPackArgs(outDir), {
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
    // The remote copy is intentionally persistent, but this local staging
    // archive contains source and must never survive success, failure or app
    // cancellation.
    rmSync(outDir, { recursive: true, force: true })
  }
}

/**
 * Materialize a local-path plugin and install it remotely (design 13 §4.6):
 * `pnpm pack` → write-file the tarball to `~/.dsh-chamber/plugins/<name>-<hash>.tgz`
 * (kept, never cleaned — pnpm persists `file:` deps against it) → resolve the
 * tarball's ABSOLUTE remote path from the remote `$HOME` (never the local
 * home) → `dsh plugin add file:<absolute path>` (the exec-side argv whitelist
 * has a dedicated `file:` branch, the shared MATERIALIZE_FILE_SPEC_PATTERN
 * (control-plane plugin-spec.ts, re-exported by ssh-provider.ts).
 * The tarball filename is normalized for scoped names (`@scope/name` →
 * `scope-name`) so it passes the write-target filename whitelist. Fails loud
 * on any step — including an unresolvable/unsafe remote `$HOME` — never
 * reports success for a chain that did not complete. `pack` is injectable for
 * tests (default = the real `pnpm pack`).
 */
export async function materializeAndAdd(
  exec: ExecFn,
  spec: RemoteSpec,
  localDir: string,
  pack?: (dir: string) => { bytes: Buffer } | null | Promise<{ bytes: Buffer } | null>,
): Promise<MaterializeResult> {
  const id = spec.id
  let name: string
  try {
    const pkg = JSON.parse(readFileSync(join(localDir, 'package.json'), 'utf8')) as Record<string, unknown>
    if (typeof pkg.name !== 'string' || !PLUGIN_NAME_PATTERN.test(pkg.name)) {
      return { ok: false, error: 'materialize: invalid package name' }
    }
    name = pkg.name
  } catch {
    return { ok: false, error: 'materialize: cannot read package.json' }
  }
  // Reserved-name deny (design 21 §6.4, decision 19 — same set as the dialog
  // row filter and the apply rows): a picked folder whose manifest claims an
  // official/chamber domain name is refused BEFORE the pack/upload/write
  // chain touches anything (the package.json is user-picked code, but its
  // declared name decides what would be installed into the managed profile).
  if (isDeniedPluginName(name)) {
    return { ok: false, error: describeReservedNameRefusal([name]) }
  }
  const packed = await (pack ?? packDirectory)(localDir)
  if (packed === null) return { ok: false, error: 'materialize: pnpm pack failed' }
  const hash = sha256hex(packed.bytes).slice(0, 16)
  // Scoped names (`@scope/name`) contain `/` — normalize for the tarball
  // FILENAME whitelist (`[a-zA-Z0-9._-]+`, ssh-provider resolveWriteTarget).
  const tarballName = `${name.replace(/^@/, '').replace(/\//g, '-')}-${hash}.tgz`
  const remotePath = `${materializePluginsDir(spec.remoteDshHome)}/${tarballName}`
  const writeRes = await exec(id, 'run', {
    op: 'write-file',
    path: remotePath,
    contentBase64: packed.bytes.toString('base64'),
    sha256: sha256hex(packed.bytes),
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

// ============================================================================
// 6. Local pnpm resolution + local `dsh plugin` exec (design 13 §5.1, M4)
// ============================================================================

function pathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

/**
 * Resolve a directory holding a `pnpm` executable (for local `dsh plugin` and
 * `pnpm pack` under a desktop-launched packaged app, whose PATH is minimal —
 * `/usr/bin:/bin:/usr/sbin:/sbin` — and lacks pnpm). Scans PATH first, then
 * well-known install roots (nvm versions, volta, homebrew, and the Linux
 * official-installer roots ~/.local/share/pnpm and ~/.local/bin — design 21).
 * Returns null when no pnpm is found — the caller then fails with an honest
 * "pnpm not found".
 */
export function resolvePnpmBinDir(): string | null {
  const name = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const candidates: string[] = []
  for (const dir of (process.env.PATH ?? '').split(pathDelimiter())) {
    if (dir !== '') candidates.push(dir)
  }
  const nvmRoot = join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmRoot)) {
    for (const version of readdirSync(nvmRoot)) candidates.push(join(nvmRoot, version, 'bin'))
  }
  candidates.push(
    join(homedir(), '.volta', 'bin'),
    join(homedir(), '.local', 'share', 'pnpm'),
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  )
  for (const dir of candidates) {
    if (existsSync(join(dir, name))) return dir
  }
  return null
}

export interface LocalPluginExecResult {
  ok: boolean
  error?: string
}

/**
 * Run `dsh plugin --profile web <add|remove> <spec>` against the LOCAL dsh home
 * (design 13 §5.1). Resolves the dsh CLI entry the same way the control plane
 * does (02 §3.1: installed `node_modules/@deepseek-ai/dsh/lib/bin.js`, else the
 * `apps/cli/src/bin.ts` source via tsx), spawns it under the right node
 * executable (Electron main → `process.execPath` + ELECTRON_RUN_AS_NODE=1 +
 * `--expose-internals`), pins `DSH_HOME` to the local home, and prepends a
 * resolved pnpm bin dir to PATH (the `dsh plugin` CLI internally forwards to
 * pnpm, which a Finder-launched app cannot find otherwise). Specs are
 * whitelist-checked before spawn (defense in depth).
 */
/**
 * Local-only `file:` spec accepted for the MAIN-PROCESS folder-picker path
 * (design 13 §5.8). The selected path rides an argv array, never a shell, so
 * ordinary Unicode/punctuation is safe and must work. Accept POSIX absolute,
 * Windows drive and UNC paths; refuse relative/control-character input.
 * `allowFileSpec` below is still required, so renderer-submitted specs cannot
 * use this capability even if they spell a valid absolute path.
 */
export function isAllowedLocalFileSpec(spec: string): boolean {
  if (!spec.startsWith('file:') || spec.length > 4096) return false
  const selectedPath = spec.slice('file:'.length)
  if (selectedPath === '' || /[\0\r\n]/.test(selectedPath)) return false
  return isAbsolute(selectedPath)
    || /^[a-zA-Z]:[\\/]/.test(selectedPath)
    || /^\\\\[^\\]+\\[^\\]+/.test(selectedPath)
}

export async function runLocalDshPlugin(
  dshWorkspace: string,
  localDshHome: string,
  action: 'add' | 'remove',
  spec: string,
  options: { allowFileSpec?: boolean } = {},
): Promise<LocalPluginExecResult> {
  if (typeof spec !== 'string') return { ok: false, error: 'plugin spec must be a string' }
  const addOk = spec.length <= 4096 && (
    (spec.length <= MAX_PLUGIN_SPEC_CHARS && PLUGIN_SPEC_PATTERN.test(spec) && !hasXWildcardVersion(spec))
    || (options.allowFileSpec === true && isAllowedLocalFileSpec(spec))
  )
  if (action === 'add' && !addOk) return { ok: false, error: `invalid add spec: ${JSON.stringify(spec)}` }
  if (action === 'remove' && (spec.length > MAX_PLUGIN_SPEC_CHARS || !PLUGIN_NAME_PATTERN.test(spec))) return { ok: false, error: `invalid remove name: ${JSON.stringify(spec)}` }

  const installed = join(dshWorkspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const source = join(dshWorkspace, 'apps', 'cli', 'src', 'bin.ts')
  let entryArgs: string[]
  if (existsSync(installed)) entryArgs = [installed]
  else if (existsSync(source)) entryArgs = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts']
  else return { ok: false, error: `no dsh CLI entry found in ${dshWorkspace}` }

  const isElectron = process.versions.electron !== undefined
  const nodeArgs = isElectron ? ['--expose-internals', ...entryArgs] : entryArgs
  const pnpmBin = resolvePnpmBinDir()
  const env: Record<string, string | undefined> = {
    ...process.env,
    DSH_HOME: localDshHome,
    ...(isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    ...(pnpmBin !== null ? { PATH: `${pnpmBin}${pathDelimiter()}${process.env.PATH ?? ''}` } : {}),
  }
  const result = await runChild(process.execPath, [...nodeArgs, 'plugin', '--profile', 'web', action, spec], {
    cwd: dshWorkspace,
    env,
    timeoutMs: 120_000,
    writerHome: localDshHome,
  })
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
