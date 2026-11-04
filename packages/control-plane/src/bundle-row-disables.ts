/**
 * Bundle-layer id-targeted disables for the local `--patch` overlay (P5b-0).
 *
 * WHY. A row chamber must force OFF can be mounted by an upstream BUNDLE layer (the forge
 * bundle's GitHub provider) rather than by a chamber seed, so there is no insert row to
 * omit: only an id-targeted `disabled` can turn it off. But an id-targeted patch addresses
 * the row by a STRING, and the dsh loader treats an unmatched id or a name mismatch as a
 * per-entry warning that skips the patch — a misspelled id would leave the row enabled
 * while the overlay looks correct. The bundle's own patch file is the only source of truth
 * for the row's identity, so this module verifies against it and implements the two
 * required semantics:
 *
 *   - bundle NOT enabled (P5b is opt-in, so this is the default) → the row will not exist
 *     at boot: the target is skipped with a diagnostic (idempotent, never a boot failure);
 *   - bundle ENABLED → the row must be provable. An absent id, a row bound to another
 *     package, an unreadable bundle, or two rows claiming the id are fail-closed (throw):
 *     booting with the row enabled would silently contradict the plan.
 *
 * IO is injected (the enabled-bundle list and a patch reader) so the decision is
 * unit-testable without a dsh installation; {@link profileBundlePatchReader} is the
 * production reader over the managed profile and dsh installation anchors.
 */

import { existsSync, readFileSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { join } from 'node:path'
import { parsePatchRows } from './cordis-inserts.ts'
import type { CordisDisablePatch } from './cordis-inserts.ts'

/** One row a bundle layer mounts that the local overlay must force off. */
export interface BundleRowDisableTarget {
  /** The bundle package that mounts the row (a `dsh.profile.bundles` member). */
  readonly bundle: string
  /** The loader entry id inside that bundle's patch (top level or inside a group). */
  readonly id: string
  /** The exact package name the row must be bound to; a name mismatch is fail-closed. */
  readonly name: string
}

/** The forge bundle (official OPTIONAL bundle; P5b is opt-in). */
export const FORGE_BUNDLE_PACKAGE_NAME = '@deepseek-ai/dsh-experimental-forge-bundle'

/**
 * The forge bundle's GitHub provider row. P5b keeps GitHub off: with the provider disabled
 * the worktree UI/tool stay complete (it only injects the GitHub host half), and the
 * trailing-glyph/PR surface is deferred. The bundle mounts the row itself, so the only
 * channel is this id-targeted disable.
 */
export const FORGE_GITHUB_ROW: BundleRowDisableTarget = {
  bundle: FORGE_BUNDLE_PACKAGE_NAME,
  id: 'forge-github',
  name: '@deepseek-ai/dsh-experimental-forge-github',
}

/** The canonical bundle-row disable registry (the local overlay applies it every spawn). */
export const BUNDLE_ROW_DISABLES: readonly BundleRowDisableTarget[] = [FORGE_GITHUB_ROW]

/** Loader ids are plain words; bundle/row package names are scoped package specifiers. */
const TARGET_ID_PATTERN = /^[a-zA-Z0-9._-]+$/
const TARGET_PACKAGE_PATTERN = /^@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/

/**
 * Fail-loud registry pin (runs at load): a malformed target would only surface at render
 * time (or, worse, silently no-op through the loader's warning path), and a duplicate
 * bundle+id pair would make the emitted overlay ambiguous. Throws, never warns.
 */
export function assertBundleRowDisableTargets(targets: readonly BundleRowDisableTarget[] = BUNDLE_ROW_DISABLES): void {
  const seen = new Set<string>()
  for (const target of targets) {
    if (!TARGET_PACKAGE_PATTERN.test(target.bundle)
      || !TARGET_ID_PATTERN.test(target.id)
      || !TARGET_PACKAGE_PATTERN.test(target.name)) {
      throw new Error(`bundle row disable: invalid target ${JSON.stringify(target)}`)
    }
    const key = `${target.bundle}#${target.id}`
    if (seen.has(key)) throw new Error(`bundle row disable: duplicate target ${JSON.stringify(target)}`)
    seen.add(key)
  }
}

assertBundleRowDisableTargets()

/** One bundle's patch read: every declared patch text in application order, or why not. */
export type BundlePatchRead =
  | { readonly ok: true; readonly patches: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/** Inputs of one bundle-row disable resolution. */
export interface BundleRowDisableInput {
  /** `dsh.profile.bundles` from the managed profile manifest (the enabled layer list). */
  readonly enabledBundles: readonly string[]
  /** Read every patch file the bundle declares, in application order. */
  readonly readBundlePatches: (bundleName: string) => BundlePatchRead
  /** Targets to apply; defaults to {@link BUNDLE_ROW_DISABLES}. */
  readonly targets?: readonly BundleRowDisableTarget[]
  /** Diagnostic sink for the idempotent skip (never a failure sink). */
  readonly log?: (message: string) => void
}

/** `'a'`, `'a', 'b'` or `no package name` for one row's name scalars. */
function describeNames(names: readonly string[]): string {
  return names.length === 0 ? 'no package name' : names.map(name => `'${name}'`).join(', ')
}

/**
 * Resolve the disable rows this spawn must carry for bundle-mounted rows.
 *
 * Idempotency: a target whose bundle is not enabled is skipped with a diagnostic — the
 * bundle is opt-in, so before the user enables it the row simply does not exist and the
 * host must boot normally. Fail-closed: once the bundle IS enabled, every target must be
 * provable against the bundle's own patch (see the module comment); any doubt throws so
 * the instance fails loudly instead of booting with the row silently enabled.
 */
export function resolveBundleRowDisables(input: BundleRowDisableInput): CordisDisablePatch[] {
  const targets = input.targets ?? BUNDLE_ROW_DISABLES
  assertBundleRowDisableTargets(targets)
  const enabled = new Set(input.enabledBundles)
  const log = input.log ?? (() => {})
  const reads = new Map<string, BundlePatchRead>()
  const claimed = new Set<string>()
  const disables: CordisDisablePatch[] = []
  for (const target of targets) {
    if (!enabled.has(target.bundle)) {
      log(`bundle row disable: bundle '${target.bundle}' is not enabled; the id-targeted disable for '${target.id}' is skipped (the row does not exist at boot — idempotent)`)
      continue
    }
    let read = reads.get(target.bundle)
    if (read === undefined) {
      read = input.readBundlePatches(target.bundle)
      reads.set(target.bundle, read)
    }
    if (!read.ok) {
      throw new Error(
        `bundle row disable: bundle '${target.bundle}' is enabled but its patch could not be read (${read.reason}); `
          + `cannot prove row '${target.id}' — refusing to start (fail-closed)`,
      )
    }
    const rows = parsePatchRows(read.patches.join('\n')).filter(row => row.id === target.id)
    if (rows.length === 0) {
      throw new Error(
        `bundle row disable: bundle '${target.bundle}' is enabled but its patch mounts no row with id '${target.id}' `
          + '(misspelled id, or an upstream pin renamed/removed it) — refusing to start (fail-closed)',
      )
    }
    if (rows.length > 1) {
      throw new Error(
        `bundle row disable: bundle '${target.bundle}' mounts the loader id '${target.id}' ${rows.length} times; `
          + 'refusing to choose one (fail-closed)',
      )
    }
    const names = rows[0]!.names
    if (names.length !== 1 || names[0] !== target.name) {
      throw new Error(
        `bundle row disable: bundle '${target.bundle}' binds '${target.id}' to ${describeNames(names)} instead of `
          + `'${target.name}' — the loader would skip the disable as a name mismatch (fail-closed)`,
      )
    }
    if (claimed.has(target.id)) {
      throw new Error(`bundle row disable: loader id '${target.id}' is targeted twice; the overlay would carry a duplicate row`)
    }
    claimed.add(target.id)
    disables.push({ id: target.id, name: target.name })
  }
  return disables
}

/** The managed web profile directory under a dsh home. */
function profileDirOf(dshHome: string): string {
  return join(dshHome, 'profiles', 'web')
}

/**
 * The installation anchors dsh-app-boot resolves a bundle from (its own package first,
 * then the profile): the installed layout carries the dsh app under
 * `node_modules/@deepseek-ai/dsh`, the source layout under `apps/cli`. Absent anchors
 * contribute nothing; the profile anchor is always included by the reader itself.
 */
function installationAnchors(dshWorkspacePath: string | null | undefined): string[] {
  if (dshWorkspacePath === null || dshWorkspacePath === undefined || dshWorkspacePath === '') return []
  return [
    join(dshWorkspacePath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(dshWorkspacePath, 'apps', 'cli', 'package.json'),
  ]
}

/** Node's own node_modules lookup order from one anchor, probing for the package manifest
 *  (never requiring the package to export `./package.json`). */
function packageDirFromAnchor(anchor: string, packageName: string): string | null {
  let searchPaths: string[]
  try {
    searchPaths = nodeModule.createRequire(anchor).resolve.paths(packageName) ?? []
  } catch {
    return null
  }
  for (const searchPath of searchPaths) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return null
}

/** The patch file paths a bundle manifest declares (`dsh.bundle.patch`), or why not. */
function bundlePatchFiles(packageDir: string): { files: string[] } | { reason: string } {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    return { reason: `its package.json is unreadable (${error instanceof Error ? error.message : String(error)})` }
  }
  const bundle = (manifest as { dsh?: { bundle?: { patch?: unknown } } } | null)?.dsh?.bundle
  if (bundle === null || typeof bundle !== 'object') return { reason: 'its package.json declares no dsh.bundle' }
  const declared = bundle.patch
  const files = typeof declared === 'string'
    ? [declared]
    : Array.isArray(declared) && declared.every(file => typeof file === 'string') ? declared : null
  if (files === null || files.length === 0) {
    return { reason: 'its package.json declares dsh.bundle.patch as neither a file path nor a list of file paths' }
  }
  return { files }
}

/**
 * The production bundle-patch reader for the managed local instance: resolve the bundle
 * package the way dsh-app-boot does (installation anchors first, then the profile
 * directory), read its declared patch files in application order, and return their text.
 * Anything unreadable is reported as a reason (the caller decides fail-closed), never a
 * silent empty read.
 */
export function profileBundlePatchReader(
  input: { readonly dshHome: string; readonly dshWorkspacePath?: string | null },
): (bundleName: string) => BundlePatchRead {
  const profileAnchor = join(profileDirOf(input.dshHome), 'package.json')
  const anchors = [...installationAnchors(input.dshWorkspacePath), profileAnchor].filter(anchor => existsSync(anchor))
  return bundleName => {
    let packageDir: string | null = null
    for (const anchor of anchors) {
      packageDir = packageDirFromAnchor(anchor, bundleName)
      if (packageDir !== null) break
    }
    if (packageDir === null) {
      return { ok: false, reason: 'the bundle package is not installed in the dsh installation or the profile' }
    }
    const declared = bundlePatchFiles(packageDir)
    if ('reason' in declared) return { ok: false, reason: declared.reason }
    const patches: string[] = []
    for (const file of declared.files) {
      const path = join(packageDir, file)
      try {
        patches.push(readFileSync(path, 'utf8'))
      } catch (error) {
        return { ok: false, reason: `its declared patch ${path} is unreadable (${error instanceof Error ? error.message : String(error)})` }
      }
    }
    return { ok: true, patches }
  }
}
