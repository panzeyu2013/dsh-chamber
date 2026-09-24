/**
 * Gateway-side projection of the MANAGED web profile's plugin manifest
 * (`<stateDir>/dsh-home/profiles/web/package.json`).
 *
 * Never a silent empty list: absent manifest → profile_absent; present but
 * unreadable/unsafe (permissions, symlinked leaf/dir, oversized) or
 * unparseable → profile_corrupt with evidence in `error` (a torn read lands
 * here too). The write fence lives one layer up — the route probes it and
 * answers a retryable 409 runtime_busy — so this module takes no lease and
 * never blocks; a tear reaching here means a writer OUTSIDE the gateway's
 * fence. Local-path values are masked by the shared ruler below.
 */

import { join } from 'node:path'
import {
  CHAMBER_HOST_PACKAGES,
  derivePluginRows,
  deriveProtectedSet,
  readInstalledVersion,
  resolveRuntimeFamily,
} from '@dsh-chamber/control-plane'
import type { FamilyVersions, PluginRow, ProtectedSet } from '@dsh-chamber/control-plane'
// The manifest read algorithm + mask ruler lives in the neutral wire package;
// this module keeps only its byte read and the gateway-specific projection.
import {
  isMaterializedValue,
  maskMaterializedDependencies,
  parsePluginManifest,
  PLUGIN_MATERIALIZED_VALUE_MASK,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import type { PluginProfileRefusalCode } from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import { readPrivateTextOrNull } from './private-read.ts'

/** Managed dsh home dir under stateDir (the managed instance runs with DSH_HOME=<stateDir>/dsh-home). */
export const MANAGED_DSH_HOME_DIR = 'dsh-home'

/** Profile-manifest layout relative to the managed home: `<home>/profiles/web/package.json`. */
export const INSTALLED_PROFILE_DIR = join('profiles', 'web')

/** Bounded manifest read cap: a profile package.json is a few KiB; 1 MiB is generous. */
export const INSTALLED_MANIFEST_MAX_BYTES = 1024 * 1024

/**
 * Mask replacing local-path dependency values in the read projection; keeps the
 * `file:` prefix so the value's materialize classification survives. Single
 * source = the wire package's PLUGIN_MATERIALIZED_VALUE_MASK.
 */
export const MATERIALIZED_VALUE_MASK = PLUGIN_MATERIALIZED_VALUE_MASK

/** Is this dependency spec a local-path `file:` value? Case-insensitive. */
export function isFileValue(spec: string): boolean {
  return /^file:/i.test(spec)
}

export type InstalledResult =
  | {
    ok: true
    dependencies: Record<string, string>
    bundles: string[]
    /** Read-face row projection: one row per dependency with role + the
     *  SERVER-computed `protected` flag (the gateway is the authority — family
     *  facts live here, not in the desktop). */
    rows: PluginRow[]
    profileExists: true
  }
  | { ok: false; code: PluginProfileRefusalCode; error?: string }

/** Workspace path + version the protected-set derivation needs; null before the manager exists. */
export type GatewayRuntimeFacts = { path: string; version: string | null }

/** S 分量：chamber 播种注册表名（与 desktop 同源，control-plane 单一来源）。 */
const SEED_NAMES: readonly string[] = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.name)

/** B₀ ∪ S only (no family) — the degraded-ladder set. */
export function deriveBootProtectedSet(): ProtectedSet {
  const derived = deriveProtectedSet({ seedNames: SEED_NAMES, familyNames: null })
  if (!derived.ok) throw new Error(`chamber seed registry cannot form a protected set: ${derived.reason}`)
  return derived.set
}

/** The single protected-set derivation for an already resolved family closure,
 *  shared so a judgement reads the runtime lockfile once. */
function protectedSetFromFamily(family: ReturnType<typeof resolveRuntimeFamily> | null): ProtectedSet | null {
  if (family === null || !family.ok) return null
  const derived = deriveProtectedSet({ seedNames: SEED_NAMES, familyNames: family.names })
  return derived.ok ? derived.set : null
}

/** Server-side protected set from the ACTIVE runtime's lockfile closure. F
 * underivable ⇒ null (write faces fail closed; the read face then marks
 * official-scope rows read-only conservatively). */
export function gatewayProtectedSet(facts: GatewayRuntimeFacts | null): ProtectedSet | null {
  if (facts === null) return null
  return protectedSetFromFamily(resolveRuntimeFamily(facts.path))
}

/** The facts one protected-set judgement needs, resolved ONCE per judgement —
 * submit-time and execution-time judgements are DELIBERATELY different
 * snapshots, so this is returned, never cached. `resolve` must be a GUARDED
 * accessor returning null instead of throwing. */
export interface JudgementInputs {
  /** The resolved runtime workspace facts, or null when unavailable. */
  facts: GatewayRuntimeFacts | null
  /** `facts.version`, or null when unavailable. */
  runtimeVersion: string | null
  /** Never null: full P when derivable, B₀ ∪ S otherwise; `familySource` names the ladder used. */
  derivation: { ok: true; set: ProtectedSet }
  familySource: 'runtime' | 'unavailable'
  /** Active family closure names; null when unavailable or untrusted. */
  familyNames: readonly string[] | null
  /** Version facts for the family names; null under the same conditions. */
  familyVersions: FamilyVersions | null
}

/** Resolve the judgement inputs from one guarded facts accessor: the protected
 *  set and the family versions come from the SAME lockfile resolution. F
 *  underivable ⇒ B₀ ∪ S with `familySource:'unavailable'` (fail closed). */
export function resolveJudgementInputs(resolve: () => GatewayRuntimeFacts | null): JudgementInputs {
  const facts = resolve()
  const family = facts === null ? null : resolveRuntimeFamily(facts.path)
  const protectedSet = protectedSetFromFamily(family)
  return {
    facts,
    runtimeVersion: facts === null ? null : facts.version,
    derivation: { ok: true, set: protectedSet ?? deriveBootProtectedSet() },
    familySource: protectedSet === null ? 'unavailable' : 'runtime',
    familyNames: family === null ? null : (family.ok ? family.names : null),
    familyVersions: family === null ? null : (family.ok ? family.versions : null),
  }
}

export interface ChamberInstalled {
  /** Project the managed web profile's plugin manifest. */
  read(): InstalledResult
}

/** Read the profile manifest (no-follow, tightened to 0600, bounded); null
 * when it does not exist yet — no requiredMode: the manifest is pnpm-written,
 * not 0600-owned by construction, so requiring 0600 would misclassify it. */
function readProfileManifest(path: string): string | null {
  return readPrivateTextOrNull(path, { tightenMode: 0o600, maxBytes: INSTALLED_MANIFEST_MAX_BYTES })
}

export function createChamberInstalled(
  stateDir: string,
  /** Lazy runtime-facts accessor; absent ⇒ the read face conservatively marks
   *  official-scope rows read-only. */
  runtimeFacts?: () => GatewayRuntimeFacts | null,
): ChamberInstalled {
  const manifestPath = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR, 'package.json')
  const profileDir = join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR)
  return {
    read(): InstalledResult {
      let text: string
      try {
        const manifestText = readProfileManifest(manifestPath)
        if (manifestText === null) {
          // ENOENT: no managed profile yet — the client defers install until it exists.
          return { ok: false, code: 'profile_absent' }
        }
        text = manifestText
      } catch (error) {
        // Present but unreadable/unsafe (permissions, symlink, oversized,
        // torn read) → corrupt, never a silent empty list.
        return { ok: false, code: 'profile_corrupt', error: `managed profile manifest is present but unreadable: ${String(error)}` }
      }
      // The read algorithm — JSON fault classification, dependencies projection
      // (string values only), bundles walk — lives in the wire package.
      const parsed = parsePluginManifest(text)
      if (!parsed.ok) {
        return parsed.fault === 'invalid-json'
          ? { ok: false, code: 'profile_corrupt', error: `managed profile manifest is not valid JSON: ${parsed.detail}` }
          : { ok: false, code: 'profile_corrupt', error: 'managed profile manifest is not a JSON object' }
      }
      // Local-path values never leave this module — the shared mask ruler.
      const dependencies = maskMaterializedDependencies(parsed.dependencies)
      const bundles = parsed.bundles
      // The accessor THROWS on corrupt override/pointer metadata; the read face
      // must survive that (a throwing projection would kill the recovery read
      // with a generic 500). Null facts ⇒ B₀ ∪ S only.
      let facts: GatewayRuntimeFacts | null = null
      if (runtimeFacts !== undefined) {
        try {
          facts = runtimeFacts()
        } catch {
          facts = null
        }
      }
      // F unknown (no wiring / no manager) ⇒ B₀ ∪ S is still ALWAYS applied.
      // `protected` stays exactly "name ∈ P": official-scope INSTALL conservatism
      // is a write-face capability, not a read-face fact — marking such rows
      // protected would hide a remove the write face allows.
      const derived = gatewayProtectedSet(facts)
      const protectedSet = derived ?? deriveBootProtectedSet()
      const rows = derivePluginRows({
        dependencies,
        bundles,
        protectedSet,
        seedNames: SEED_NAMES,
        // Memoized per call: the rows derivation asks once per dependency.
        installedVersion: (() => {
          const cache = new Map<string, string | null>()
          return (name: string) => {
            if (!cache.has(name)) cache.set(name, readInstalledVersion(profileDir, name))
            return cache.get(name) ?? null
          }
        })(),
        // Same masking rule as above: local-path values never reach the renderer via `rows` either.
        maskSpec: spec => (isMaterializedValue(spec) ? MATERIALIZED_VALUE_MASK : spec),
      })
      return { ok: true, dependencies, bundles, rows, profileExists: true }
    },
  }
}