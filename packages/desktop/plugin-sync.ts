/**
 * Plugin READ face + chamber host-package seed orchestration (desktop main
 * process): pure orchestration + dependency injection (`exec`), so nothing here
 * imports electron or a real SSH host. Manifest reads ride `exec(id, run, cat)`;
 * the seed writes via `write-file`; a successful `run` carries the captured
 * stdout that manifest parsing and the hash-skip rely on. The user plugin write
 * surface (install/remove/materialize/undo) was retired with the 2026-09 C
 * layering ruling — this module keeps only the read projections and the chamber
 * seed, whose remote paths all derive from `remoteDshHome`.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// Insert render/parse/conflict logic is single-sourced in control-plane
// (cordis-inserts.ts via control-plane-module.ts); only fold semantics and
// message wording stay here.
import { hasExactInsert, insertConflict, renderCordisInserts } from './control-plane-module.ts'
import type { CordisInsert, InsertConflictKind } from './control-plane-module.ts'
// Whitelists are single-sourced in control-plane plugin-spec.ts (via the
// facade) so the orchestration-side re-validation, the exec-side argv whitelist
// and the gateway executor can never drift.
import {
  derivePluginRows,
  deriveProtectedSet,
  hasXWildcard,
  isMaterializedValue,
  parsePluginManifest,
  PLUGIN_MATERIALIZED_VALUE_MASK,
  PLUGIN_NAME_PATTERN,
  PLUGIN_SPEC_PATTERN,
  readInstalledVersion,
  readManifestVersion,
} from './control-plane-module.ts'
import type {
  PluginManifestParseResult,
  PluginRow,
  ProtectedSet,
} from './control-plane-module.ts'
// Chamber host-package insert facts derive from control-plane host-graph-seed.ts
// via the facade — the constants below are never re-typed here.
import {
  CHAMBER_HOST_PACKAGES, HOST_ARCHIVE_CLEANUP_INSERT, HOST_GIT_WORKTREE_INSERT, HOST_GRAPH_INSERT,
  HOST_GRAPH_PATCH_FILENAME, HOST_PACKAGE_SEED_FILES,
  type ChamberHostPackageDescriptor, type HostPackageInsert, type HostPackageSeedFile,
} from './control-plane-module.ts'
// ENOENT_PATTERN is shared the same way: ssh-provider classifies the RAW stderr
// line (redaction can hide a `.ssh*`-named home path), so provider-side
// classification and this caller-side test can never drift.
import { ENOENT_PATTERN } from './ssh-provider.ts'
// Contract A types are SHARED from transport-provider.ts (no runtime imports),
// so this pulls no transport-manager/electron surface.
import type { TransportExecAction, TransportRunPayload } from './transport-provider.ts'

export { PLUGIN_SPEC_PATTERN, PLUGIN_NAME_PATTERN }
// The authoritative chamber host-package registry (name + insert id + liveness
// probe); every desktop consumer derives from this SAME list, never a
// re-declaration.
export { CHAMBER_HOST_PACKAGES }

/** S：chamber 播种注册表名（单一来源 = CHAMBER_HOST_PACKAGES）。 */
export const CHAMBER_SEED_NAMES: readonly string[] = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.name)

/** 读面保护事实：`familySource: runtime`（默认）时 familyNames 是已解析的 F，
 * 缺席 ⇒ **降级态**：P 退到 B₀ ∪ S（只收紧不放松）；`familySource: none`（ssh）没有族
 * 事实源，同降级形态。用户插件写面已退役，本接口只服务读面判定。 */
export interface PluginProtectionFacts {
  familyNames?: readonly string[] | null
  familySource?: 'runtime' | 'none'
}

/** ssh 缺省事实（B₀ ∪ S、无族来源）。 */
export function sshProtectionFacts(): PluginProtectionFacts {
  return { familyNames: null, familySource: 'none' }
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

/** 由事实派生受保护集合 + 降级态：本该有 F 但读不到时退到 B₀ ∪ S（只收紧不放松）。 */
export function protectedSetFromFacts(facts: PluginProtectionFacts): ProtectedSet | null {
  return protectedSetState(facts).set
}

/** 派生结果 + 降级标记（读面用它选降级阶梯）。 */
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
export const GIT_WORKTREE_PACKAGE_NAME = HOST_GIT_WORKTREE_INSERT.name
export const ARCHIVE_CLEANUP_PACKAGE_NAME = HOST_ARCHIVE_CLEANUP_INSERT.name
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
  /** Read-face row projection: one row per `dependencies` entry with role +
   * backend-computed `protected`. Composition and seed registry classify but never
   * create rows; the renderer renders `rows` (always projected — same-release
   * desktop/gateway/in-place host; the remote `dsh.profile.bundles` stays a
   * producer-side classifier and never travels). */
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
  unsyncable: UnsyncableEntry[]
  /** Chamber-injected component state (design 09): always readable locally. */
  chamber: ChamberInjectionState
}

export type RemotePluginListResult = { ok: true; manifest: RemotePluginManifest } | { ok: false; error: string }


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
 * name-based diffing; names, profileExists, error and chamber pass through;
 * the main-process-internal manifest is never projected.
 */
export function redactRemotePluginManifest(manifest: RemotePluginManifest): RemotePluginManifest {
  const dependencies: Record<string, string> = {}
  for (const [name, spec] of Object.entries(manifest.dependencies)) {
    dependencies[name] = isMaterializedValue(spec) ? MATERIALIZED_VALUE_MASK : spec
  }
  return { ...manifest, dependencies }
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
 * Decide how to fold the chamber loader inserts into an existing
 * cordis.patch.yml (design 13 §3): dedup when already present; deterministic
 * rewrite for the `initProfile` template (comments + `[]`); append for a user
 * block-sequence list (never overwriting user rows); fail-loud for a non-list.
 * The inserts are REQUIRED (the registry is the source of the rows, and a
 * silent client-graph fallback would seed a row the caller never asked for).
 * A row whose loader id is already bound to a different package fails loud
 * (the shared conflict classification).
 *
 * The insert render/parse/conflict classification is single-sourced in
 * control-plane (cordis-inserts.ts, consumed through control-plane-module.ts);
 * the fold semantics and message wording stay here.
 * @param existing - the file content, or null when the file does not exist
 *   (profile not initialized).
 * @param inserts - the loader rows to ensure, in order.
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


export function computeCordisPatchUpdate(
  existing: string | null,
  inserts: readonly ChamberHostInsert[],
): CordisPatchUpdate {
  if (existing === null) {
    return { error: 'remote profile is not initialized (cordis.patch.yml missing) — run a plugin add first' }
  }
  const foldedPatch = existing
  for (const insert of inserts) {
    const conflict = insertConflict(foldedPatch, toCordisInsert(insert))
    if (conflict !== null) return { error: cordisConflictMessage(conflict, insert) }
  }
  const missing = inserts.filter(insert => !hasExactInsert(foldedPatch, toCordisInsert(insert)))
  if (missing.length === 0) return { write: false }
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


