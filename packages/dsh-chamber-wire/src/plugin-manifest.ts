/**
 * The plugin-manifest wire contract (design 21 §3 `readManifest`, §6.2 mask
 * discipline): THE single definition of the profile-manifest model and its
 * read algorithm — parse (fault-classified), version read, path-value
 * classifier, masking and the refusal-code vocabulary.
 *
 * Consumers, all through THIS module (a backend that reads bytes never
 * re-implements the algorithm):
 * - gateway: `packages/gateway/src/plugins-installed.ts` parses the managed
 * web profile's package.json with {@link parsePluginManifest} and masks with
 * {@link maskMaterializedDependencies};
 * - control-plane: the protected-set row projection classifies with
 * {@link isMaterializedValue} and reads installed versions with
 * {@link readManifestVersion} (`protected-plugins.ts`);
 * - desktop (phase 2, R6, landed): `packages/desktop/plugin-sync.ts`
 * consumes `parsePluginManifest` / `readManifestVersion` /
 * `isMaterializedValue` through the dual-path facade
 * (`control-plane-module.ts`; control-plane re-exports these definitions
 * and the packaged desktop reads the esbuild-inlined copy). The former
 * local parse body and the narrower `isMaterializeSpec` regex are DELETED,
 * never mirrored;
 * - browser: the settings-connections diff consumes {@link isMaterializedValue}
 * and {@link hasXWildcard} through the client-core pass-through face
 * (`@dsh-chamber/dsh-chamber-client-core/plugin-manifest`), because the
 * browser cannot import the Node-only control-plane.
 *
 * PURE + UNPRIVILEGED + IO-FREE: no node builtins, no browser globals, no
 * filesystem — every backend keeps its own byte acquisition (bounded private
 * read, `cat` over ssh, HTTP projection) and feeds TEXT in here. Zero runtime
 * dependencies, so the seed esbuild bundle and the client bundles inline it.
 *
 * The three semantics this module owns, each a single function:
 * - parse/缺失语义: {@link parsePluginManifest} classifies JSON faults
 * (`invalid-json` / `not-an-object`) and projects the model. A backend maps
 * its own byte-layer ENOENT/read failure to `profile_absent` /
 * `profile_corrupt` — that vocabulary is pinned by
 * {@link PluginProfileRefusalCode}.
 * - 版本语义: {@link readManifestVersion} — a version is a non-empty string or
 * nothing; never a guessed default.
 * - 掩码语义: {@link isMaterializedValue} is the ruler (path forms only —
 * semver ranges/tags are registry values) and
 * {@link PLUGIN_MATERIALIZED_VALUE_MASK} the replacement. The mask keeps its
 * `file:` prefix so the masked value still classifies as materialized on
 * every side (name-based diff + row roles keep working).
 */

/** Mask replacing a machine-local-path dependency VALUE in every
 * renderer-facing projection (design 21 §6.2/§6.4, decision 18). The value
 * keeps its `file:` prefix so {@link isMaterializedValue} still classifies
 * the masked spec as materialized: a masked manifest stays diffable by name
 * and the row projection keeps role `materialized`. */
export const PLUGIN_MATERIALIZED_VALUE_MASK = 'file:<hidden>'

/**
 * Is this dependency VALUE a machine-local path (a materialize row)?
 *
 * The grammar is deliberately WIDER than `file:` (design 21 decision 18,
 * review): `link:`, relative (`./`, `../` — including a bare `.`/`..`
 * and backslash separators), absolute (`/`, `\\`, `C:\`) and home-relative
 * (`~`, `~/x`, `~\x`) values all name a machine-local path that must never
 * leave its owner through a projection.
 *
 * Semver values stay registry values: `~1.2.0` is a tilde range, not a home
 * path — only the `~/`/`~\\`/`~` path forms count. A bare `.foo` is not a path
 * either.
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
 * Mask every materialized dependency value in one projection step: the exact
 * rule every masking backend applies to the `dependencies` channel, so the
 * `dependencies` map and the row projection's `spec` can be derived from the
 * same function. Values that are not local paths pass through verbatim;
 * already-masked values stay masked (idempotent).
 */
export function maskMaterializedDependencies(dependencies: Record<string, string>): Record<string, string> {
 const masked: Record<string, string> = {}
 for (const [name, spec] of Object.entries(dependencies)) {
 masked[name] = isMaterializedValue(spec) ? PLUGIN_MATERIALIZED_VALUE_MASK : spec
 }
 return masked
}

/** Read the `version` string from an already-parsed package manifest; null
 * when absent (not a non-empty string) or the manifest is not an object —
 * never a guessed default. */
export function readManifestVersion(manifest: unknown): string | null {
 if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null
 const version = (manifest as Record<string, unknown>).version
 return typeof version === 'string' && version !== '' ? version : null
}

/**
 * Is this dependency value a semver x-wildcard (`x`, `1.x`, `1.2.x`, with an
 * optional `^`/`~` prefix)? An x-wildcard is a RANGE, not a locked version, so
 * the apply gate refuses it; the UI classifier refuses it up front so no row
 * is offered as actionable while the backend would wholesale-reject the batch.
 * Segment-anchored: a dist-tag merely containing x (`lexical`) is not one.
 */
export function hasXWildcard(versionOrValue: string): boolean {
 const bare = versionOrValue.replace(/^[\^~]/, '')
 return /(^|\.)x(\.|$)/i.test(bare)
}

/** The parsed profile-manifest model: the profile's declared dependencies plus
 * its live bundle layer. Field semantics ARE the readManifest projection
 * (design 21 §6.2): dependency VALUES are kept RAW here — masking is a
 * separate projection step ({@link maskMaterializedDependencies}) so a
 * backend that returns the manifest to its own process (the desktop's local
 * read) can keep the raw text while a renderer-facing projection masks. */
export interface PluginManifestModel {
 /** `dependencies`: string values only (non-string entries are dropped, not
 * stringified), in declaration order. */
 dependencies: Record<string, string>
 /** `dsh.profile.bundles`: string members only, in declaration order; an
 * absent/non-array path yields []. */
 bundles: string[]
}

/** Why a manifest text did not parse. `invalid-json` = `JSON.parse` threw;
 * `not-an-object` = valid JSON, but null/array/primitive. */
export type PluginManifestFault = 'invalid-json' | 'not-an-object'

/** A fault-classified manifest parse. `detail` carries the JSON error text for
 * `invalid-json` (the backend composes its own message around it) and '' for
 * `not-an-object`. */
export type PluginManifestParseResult =
 | ({ ok: true } & PluginManifestModel)
 | { ok: false; fault: PluginManifestFault; detail: string }

/**
 * The manifest read algorithm over TEXT (the backend owns byte acquisition).
 * Exactly the classification every backend duplicated:
 * - `JSON.parse` throw → `invalid-json` with the error text;
 * - `null`/array/primitive → `not-an-object`;
 * - `dependencies` object → string values only, raw;
 * - `dsh.profile.bundles` → string members only (absent path → []).
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

/** `dsh.profile.bundles` walk: an absent path, a non-array value and non-string
 * members are all "not there"; never a guessed default. */
function readBundleLayer(record: Record<string, unknown>): string[] {
 let current: unknown = record
 for (const key of ['dsh', 'profile', 'bundles'] as const) {
 if (current === null || typeof current !== 'object') return []
 current = (current as Record<string, unknown>)[key]
 }
 if (!Array.isArray(current)) return []
 return current.filter((item): item is string => typeof item === 'string')
}

/** The readManifest refusal vocabulary (design 21 §6.2): `profile_absent` =
 * no profile manifest yet (fresh instance, dsh never spawned); `profile_corrupt`
 * = present but unreadable/unsafe/unparseable. The byte layer decides which
 * one a read lands in; the client maps the gateway's 404/500 onto the same
 * two codes. */
export type PluginProfileRefusalCode = 'profile_absent' | 'profile_corrupt'
