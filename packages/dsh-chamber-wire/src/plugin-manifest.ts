/**
 * The plugin-manifest wire contract (design 21): THE single definition of the
 * profile-manifest model and its read algorithm — fault-classified parse,
 * version read, path-value classifier, masking, refusal-code vocabulary. A
 * backend that reads bytes never re-implements it; the browser reaches it
 * through the client-core pass-through face.
 * PURE + UNPRIVILEGED + IO-FREE: no node builtins, no browser globals, no
 * filesystem — every backend keeps its own byte acquisition and feeds TEXT in.
 * Zero runtime dependencies, so the seed esbuild bundle and the client bundles
 * inline it.
 */

/** Mask replacing a machine-local-path dependency VALUE in renderer-facing
 *  projections. Keeps its `file:` prefix so the masked spec still classifies
 *  as materialized (name-based diff and row roles keep working). */
export const PLUGIN_MATERIALIZED_VALUE_MASK = 'file:<hidden>'

/**
 * Is this dependency VALUE a machine-local path (a materialize row)? The grammar
 * is deliberately WIDER than `file:`: `link:`, relative (`./`, `../`, bare `.`/`..`,
 * backslash separators), absolute (`/`, a backslash, or a `C:` drive) and
 * home-relative (`~`, `~/x`, backslash form). Semver stays a registry value
 * (`~1.2.0` is a tilde range; only the `~/` and backslash path forms count), and
 * a bare `.foo` is not a path either.
 */
export function isMaterializedValue(value: string): boolean {
 if (typeof value !== 'string' || value === '') return false
 if (/^(file|link):/i.test(value)) return true
 if (/^\.\.?([/\\]|$)/.test(value)) return true
 if (value.startsWith('/') || value.startsWith('\\')) return true
 if (value === '~' || /^~[/\\]/.test(value)) return true
 return /^[a-zA-Z]:[\\/]/.test(value)
}

/**
 * Mask every materialized dependency value: the exact rule every masking backend
 * applies to the `dependencies` channel, so the map and the row `spec` derive
 * from one function. Non-path values pass through verbatim; already-masked ones
 * stay masked (idempotent).
 */
export function maskMaterializedDependencies(dependencies: Record<string, string>): Record<string, string> {
 const masked: Record<string, string> = {}
 for (const [name, spec] of Object.entries(dependencies)) {
 masked[name] = isMaterializedValue(spec) ? PLUGIN_MATERIALIZED_VALUE_MASK : spec
 }
 return masked
}

/** Read the `version` string; null when absent (not a non-empty string) or the manifest is not an object — never a guessed default. */
export function readManifestVersion(manifest: unknown): string | null {
 if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null
 const version = (manifest as Record<string, unknown>).version
 return typeof version === 'string' && version !== '' ? version : null
}

/**
 * Is this value a semver x-wildcard (`x`, `1.x`, `1.2.x`, optional `^`/`~`
 * prefix)? An x-wildcard is a RANGE, not a locked version, so both the apply gate
 * and the UI classifier refuse it. Segment-anchored: `lexical` is not one.
 */
export function hasXWildcard(versionOrValue: string): boolean {
 const bare = versionOrValue.replace(/^[\^~]/, '')
 return /(^|\.)x(\.|$)/i.test(bare)
}

/** Parsed profile-manifest model: declared dependencies plus the live bundle
 *  layer. Dependency VALUES stay RAW — masking is a separate step, so a backend
 *  returning the manifest to its own process keeps the raw text. */
export interface PluginManifestModel {
 /** `dependencies`: string values only (non-string dropped, not stringified), declaration order. */
 dependencies: Record<string, string>
 /** `dsh.profile.bundles`: string members only; an absent/non-array path yields []. */
 bundles: string[]
}

/** Why a manifest text did not parse: `invalid-json` (`JSON.parse` threw) or `not-an-object` (null/array/primitive). */
export type PluginManifestFault = 'invalid-json' | 'not-an-object'

/** `detail` carries the JSON error text for `invalid-json` and '' for `not-an-object`. */
export type PluginManifestParseResult =
 | ({ ok: true } & PluginManifestModel)
 | { ok: false; fault: PluginManifestFault; detail: string }

/**
 * The manifest read algorithm over TEXT (the backend owns byte acquisition):
 * `JSON.parse` throw → `invalid-json`; null/array/primitive → `not-an-object`;
 * `dependencies` → string values only, raw; `dsh.profile.bundles` → string
 * members only (absent path → []).
 */
export function parsePluginManifest(text: string): PluginManifestParseResult {
 let parsed: unknown
 try {
 parsed = JSON.parse(text)
 } catch (error) {
 return { ok: false, fault: 'invalid-json', detail: String(error) }
 }
 if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
 return { ok: false, fault: 'not-an-object', detail: '' }
 }
 const record = parsed as Record<string, unknown>
 const dependencies: Record<string, string> = {}
 const rawDeps = record.dependencies
 if (rawDeps !== null && typeof rawDeps === 'object' && !Array.isArray(rawDeps)) {
 for (const [name, spec] of Object.entries(rawDeps as Record<string, unknown>)) {
 if (typeof spec === 'string') dependencies[name] = spec
 }
 }
 return { ok: true, dependencies, bundles: readBundleLayer(record) }
}

/** `dsh.profile.bundles` walk: absent path, non-array and non-string members all mean "not there". */
function readBundleLayer(record: Record<string, unknown>): string[] {
 let current: unknown = record
 for (const key of ['dsh', 'profile', 'bundles'] as const) {
 if (current === null || typeof current !== 'object') return []
 current = (current as Record<string, unknown>)[key]
 }
 if (!Array.isArray(current)) return []
 return current.filter((item): item is string => typeof item === 'string')
}

/** `profile_absent` = no manifest yet (fresh instance); `profile_corrupt` =
 *  present but unreadable/unsafe/unparseable. The byte layer picks the code. */
export type PluginProfileRefusalCode = 'profile_absent' | 'profile_corrupt'
