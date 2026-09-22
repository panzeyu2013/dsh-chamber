/**
 * Gateway-side projection of the MANAGED web profile's plugin manifest
 * (design 21 §6.2 — the readManifest gateway implementation, A0 read surface,
 * plan Phase 3a): parses `<stateDir>/dsh-home/profiles/web/package.json` —
 * the profile manifest of the gateway-managed dsh instance, the same file the
 * desktop reads for its own instance (plugin-sync.ts localPluginList, whose
 * web profile lives at `<home>/profiles/web/package.json`).
 *
 * Outcome discipline (proxy honesty, never a silent empty list):
 *   - the manifest does not exist yet (fresh gateway, dsh never spawned, or
 *     the web profile was never initialized) → profile_absent;
 *   - the manifest exists but is unreadable/unsafe (permissions, symlinked
 *     leaf/directory, oversized) or does not parse (invalid JSON, non-object)
 *     → profile_corrupt with the evidence in `error`. A torn read caught by
 *     the private-file stable-snapshot discipline (a non-atomic in-place
 *     rewrite) also lands here. The design 21 §6.2 read/write fence is
 *     DELIVERED, not pending: the A1 executor (plan Phase 4) serializes the
 *     gateway's own writers behind the runtime-manager profile-write lease,
 *     and the read route consults that fence before reading (routes.ts
 *     `pluginProfileWriteInFlight` → retryable 409 runtime_busy while a
 *     mutation is queued or running). This read module stays a pure
 *     projection — it takes no lease and never blocks; the fence lives one
 *     layer up, at the route. A tear that still reaches here is therefore
 *     evidence of a writer OUTSIDE the gateway's fence (an operator-run
 *     `dsh plugin add` against the managed profile, or the managed dsh's own
 *     boot-time profile write during a spawn) and stays loud on purpose.
 *
 * Masking: dependency VALUES that are local-path `file:` specs would name
 * gateway-local paths and must never leave this read — each is replaced with
 * MATERIALIZED_VALUE_MASK. The mask keeps the `file:` prefix so both sides'
 * spec classifiers still classify the value as a materialize spec and the
 * name-based diff keeps working. Scope filtering (official/chamber/reserved
 * domains) is deliberately NOT done here — the model layer owns it (design 21
 * §6.2/§6.7: the UI and the route are same-origin); the full masked map is
 * returned.
 */

import { join } from 'node:path'
import {
  CHAMBER_HOST_PACKAGES,
  derivePluginRows,
  deriveProtectedSet,
  PLUGIN_MATERIALIZED_VALUE_MASK,
  isMaterializedValue,
  readInstalledVersion,
  resolveRuntimeFamily,
} from '@dsh-chamber/control-plane'
import { readStringArray } from '@dsh-chamber/control-plane'
import type { FamilyVersions, PluginRow, ProtectedSet } from '@dsh-chamber/control-plane'
import { readPrivateTextOrNull } from './private-read.ts'

/** Managed dsh home directory name under the gateway stateDir (the runtime
 * manager spawns the managed instance with DSH_HOME=<stateDir>/dsh-home). */
export const MANAGED_DSH_HOME_DIR = 'dsh-home'

/** Profile-manifest layout relative to the managed dsh home (design 21 §6.2):
 * `<home>/profiles/web/package.json` — the gateway twin of the desktop's
 * WEB_PROFILE layout. */
export const INSTALLED_PROFILE_DIR = join('profiles', 'web')

/** Bounded manifest read cap (design 21 §6.2 read discipline; a profile
 * package.json is a few KiB — 1 MiB is a generous ceiling). */
export const INSTALLED_MANIFEST_MAX_BYTES = 1024 * 1024

/**
 * Mask replacing `file:` dependency VALUES in the read projection. Keeps the
 * `file:` prefix so the value's materialize classification survives the
 * projection. Single source = control-plane `PLUGIN_MATERIALIZED_VALUE_MASK`
 * (desktop plugin-sync.ts re-exports the same constant);
 * chamber-installed.test.ts still pins the two exported literals together.
 */
export const MATERIALIZED_VALUE_MASK = PLUGIN_MATERIALIZED_VALUE_MASK

/** Is this dependency spec a local-path `file:` value? Case-insensitive (kept for
 *  the narrow questions that really mean `file:`). */
export function isFileValue(spec: string): boolean {
  return /^file:/i.test(spec)
}

/**
 * Masking predicate: **the same ruler the role classifier uses** — `file:`/`link:`/
 * relative/absolute/`~` values all name a machine-local path (2026-12 review: masking
 * only `file:` leaked `link:`/absolute values into `dependencies` and `rows[].spec`).
 * The mask keeps the `file:` prefix, so the name-based diff and both spec classifiers
 * still classify the value as materialized.
 */
function isMaskableValue(spec: string): boolean {
  return isMaterializedValue(spec)
}

export type InstalledResult =
  | {
    ok: true
    dependencies: Record<string, string>
    bundles: string[]
    /** Read-face row projection (design 21 §6.11.5, 2026-09 revision): one row per
     *  declared dependency, each with role + the SERVER-computed `protected` flag
     *  (the gateway is the authority for a gateway target — the family facts live
     *  here, not in the desktop). B₀ and the seed registry only classify rows;
     *  the managed profile's installation baseline is not part of this list. */
    rows: PluginRow[]
    profileExists: true
  }
  | { ok: false; code: 'profile_absent' | 'profile_corrupt'; error?: string }

/** Runtime facts the protected-set derivation needs (design 21 §6.11.1): the
 *  effective workspace path + its version, or null before the manager exists. */
export type GatewayRuntimeFacts = { path: string; version: string | null }

/** S 分量：chamber 播种注册表名（与 desktop 同源，control-plane 单一来源）。 */
const SEED_NAMES: readonly string[] = CHAMBER_HOST_PACKAGES.map(descriptor => descriptor.insert.name)

/** B₀ ∪ S only (no family) — the degraded-ladder set (design 21 §6.11.3). */
export function deriveBootProtectedSet(): ProtectedSet {
  const derived = deriveProtectedSet({ seedNames: SEED_NAMES, familyNames: null })
  if (!derived.ok) throw new Error(`chamber seed registry cannot form a protected set: ${derived.reason}`)
  return derived.set
}

/** The protected-set derivation for an ALREADY resolved family closure: the
 *  single step `gatewayProtectedSet` and `resolveJudgementInputs` share, so a
 *  judgement reads the runtime lockfile once. */
function protectedSetFromFamily(family: ReturnType<typeof resolveRuntimeFamily> | null): ProtectedSet | null {
  if (family === null || !family.ok) return null
  const derived = deriveProtectedSet({ seedNames: SEED_NAMES, familyNames: family.names })
  return derived.ok ? derived.set : null
}

/**
 * Derive the server-side protected set from the ACTIVE runtime's lockfile
 * closure. F cannot be derived ⇒ null (the write faces fail closed; the read
 * face then conservatively marks official-scope rows read-only).
 */
export function gatewayProtectedSet(facts: GatewayRuntimeFacts | null): ProtectedSet | null {
  if (facts === null) return null
  return protectedSetFromFamily(resolveRuntimeFamily(facts.path))
}

/** The facts one protected-set judgement needs (design 21 §6.11.3), resolved
 *  ONCE per judgement. Submit-time and execution-time judgements are
 *  DELIBERATELY different snapshots, so this is a returned bundle, never a
 *  module-level cache.
 *
 *  `resolve` must be a GUARDED accessor: it returns null instead of throwing
 *  (each caller owns its own warning and the degraded-ladder policy). */
export interface JudgementInputs {
  /** The resolved runtime workspace facts, or null when unavailable. */
  facts: GatewayRuntimeFacts | null
  /** `facts.version`, or null when unavailable. */
  runtimeVersion: string | null
  /** Never null: the full P when derivable, B₀ ∪ S otherwise — the decision
   *  needs a set either way, and `familySource` names which ladder was used. */
  derivation: { ok: true; set: ProtectedSet }
  familySource: 'runtime' | 'unavailable'
  /** Active family closure names; null when the facts are unavailable or the
   *  closure cannot be trusted (verification falls back to the generation arm). */
  familyNames: readonly string[] | null
  /** Version facts for the family names; null on the same conditions as
   *  `familyNames`. */
  familyVersions: FamilyVersions | null
}

/** Resolve the protected-set judgement inputs from one guarded facts accessor
 *  (2026-12 review): the protected set AND the family version facts come from
 *  the SAME lockfile resolution, so a write face reads runtime facts once per
 *  judgement instead of once per derived fact. F underivable ⇒ B₀ ∪ S with
 *  `familySource:'unavailable'` (fail closed, never a skip). */
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
  /** Project the managed web profile's plugin manifest (design 21 §6.2). */
  read(): InstalledResult
}

/** Read the profile manifest (no-follow, tightened to 0600, bounded); null
 * when it does not exist yet — same private-file pattern plugins.ts uses for
 * the seed cache, minus requiredMode (this manifest is pnpm-written, not
 * 0600-owned by construction; requiring 0600 would misclassify a legit file). */
function readProfileManifest(path: string): string | null {
  return readPrivateTextOrNull(path, { tightenMode: 0o600, maxBytes: INSTALLED_MANIFEST_MAX_BYTES })
}

export function createChamberInstalled(
  stateDir: string,
  /** Lazy runtime-facts accessor (the gateway wiring passes
   *  `() => deps.manager()?.resolveWorkspace() ?? null`). Absent ⇒ the read
   *  face conservatively marks official-scope rows read-only. */
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
          // ENOENT: no managed profile yet (fresh gateway / never initialized)
          // — the client defers install intent until the profile exists.
          return { ok: false, code: 'profile_absent' }
        }
        text = manifestText
      } catch (error) {
        // Present but unreadable/unsafe (permissions, symlink, oversized,
        // torn read) → corrupt, never a silent empty list.
        return { ok: false, code: 'profile_corrupt', error: `managed profile manifest is present but unreadable: ${String(error)}` }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (error) {
        return { ok: false, code: 'profile_corrupt', error: `managed profile manifest is not valid JSON: ${String(error)}` }
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, code: 'profile_corrupt', error: 'managed profile manifest is not a JSON object' }
      }
      const record = parsed as Record<string, unknown>
      const dependencies: Record<string, string> = {}
      const rawDeps = record.dependencies
      if (rawDeps !== null && typeof rawDeps === 'object' && !Array.isArray(rawDeps)) {
        for (const [name, spec] of Object.entries(rawDeps as Record<string, unknown>)) {
          // String values only, kept raw — except file: values, which are
          // masked (gateway-local paths never leave this module).
          if (typeof spec !== 'string') continue
          dependencies[name] = isMaskableValue(spec) ? MATERIALIZED_VALUE_MASK : spec
        }
      }
      const bundles = readStringArray(record, ['dsh', 'profile', 'bundles'])
      // The accessor resolves the runtime workspace, which THROWS on corrupt
      // override/pointer metadata (design 18). The read face must survive that:
      // a throwing projection would kill the §6.8 r1 recovery read with a
      // generic 500 (2026-12 review). Null facts ⇒ B₀ ∪ S only.
      let facts: GatewayRuntimeFacts | null = null
      if (runtimeFacts !== undefined) {
        try {
          facts = runtimeFacts()
        } catch {
          facts = null
        }
      }
      // F unknown (no wiring / no manager yet) ⇒ B₀ ∪ S is still a constant and is
      // ALWAYS applied. `protected` stays exactly "name ∈ P": the official-scope
      // INSTALL conservatism is a capability of the write face (refused with its own
      // code), not a read-face protection fact — marking such rows protected would
      // hide a remove the write face allows (2026-12 review).
      const derived = gatewayProtectedSet(facts)
      const protectedSet = derived ?? deriveBootProtectedSet()
      const rows = derivePluginRows({
        dependencies,
        bundles,
        protectedSet,
        seedNames: SEED_NAMES,
        // Memoized per call (see the desktop twin): the rows derivation asks once
        // per dependency, and a large profile must not pay one disk read per row.
        installedVersion: (() => {
          const cache = new Map<string, string | null>()
          return (name: string) => {
            if (!cache.has(name)) cache.set(name, readInstalledVersion(profileDir, name))
            return cache.get(name) ?? null
          }
        })(),
        // Same masking rule the `dependencies` projection above applies: a
        // managed-profile `file:` value names a gateway-local path and must
        // never reach the renderer through `rows` either (design 21 §6.2).
        maskSpec: spec => (isMaskableValue(spec) ? MATERIALIZED_VALUE_MASK : spec),
      })
      return { ok: true, dependencies, bundles, rows, profileExists: true }
    },
  }
}
