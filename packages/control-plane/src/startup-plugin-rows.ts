/**
 * Startup upstream plugin rows — the local spawn's `--patch` overlay extension that
 * mounts the two upstream host plugins the managed web profile does not bundle:
 *
 *   - `@deepseek-ai/dsh-tool-workspace-dependencies` (the primary-runtime payload behind
 *     the `load_workspace_dependencies` tool), and
 *   - `@deepseek-ai/dsh-skill-office` (the seven Office skill directories plus the
 *     LibreOffice Kit CLI wiring).
 *
 * Scope is the LOCAL Swift instance only: the resource roots ship inside the sidecar
 * assembly and a remote (gateway/SSH) instance never sees them, so no capability is
 * read from env and no version gate is applied — a row is emitted purely from
 * "resource present + the ACTIVE workspace installs the plugin package".
 *
 * Unlike the chamber host packages (cordis-inserts.ts renders `--patch` insert rows
 * whose names are on the chamber scope whitelist and whose config is absent), these
 * rows carry a `config:` mapping with resource ABSOLUTE PATHS, so they get their own
 * renderer with their own allowlist. They are still ordinary loader `insert` patches:
 * one more top-level `- insert:` object appended to the same overlay file and applied
 * at host boot.
 *
 * Resource gating is deliberately fail-open and INDEPENDENT per row: a missing payload
 * or assets tree (a dev checkout, an older app) emits NO row for that capability plus a
 * diagnostic — never a half-capability row and never a spawn failure. A row the user
 * profile patch already mounts is skipped (the loader identities are global; a
 * duplicate id/name pair would fail the next boot).
 *
 * Pure node: only node:fs/node:path plus the local loader-patch parser
 * (./cordis-inserts.ts), so the planner/renderer suite runs under
 * `node --experimental-strip-types` without node_modules.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parseLoaderRows } from './cordis-inserts.ts'

/**
 * Resource capability roots resolved by the owning shell (the Swift sidecar entry).
 * Both roots are optional on purpose: absent means this deployment does not carry the
 * resource (no row is mounted); a supplied root must be absolute.
 */
export interface StartupPluginCapabilities {
  /** Primary-runtime payload dir (`runtime.json` + `dependencies/`), a sibling of the
   *  sidecar entry: packaged `<sidecar>/primary-runtime`, dev
   *  `packages/desktop/resources/primary-runtime`. */
  readonly primaryRuntimeDir?: string
  /** Office skill assets dir (the seven skill folders + office/references/sidecar.md),
   *  a sibling of the payload: packaged `<sidecar>/office-skills`, dev
   *  `packages/desktop/resources/office-skills`. */
  readonly officeSkillsDir?: string
}

/** The loader-patch row identity of one startup upstream plugin. */
export interface StartupPluginIdentity {
  readonly id: string
  readonly name: string
}

/** One rendered startup row: a loader insert identity plus its plugin config mapping. */
export interface StartupPluginRow {
  readonly id: string
  readonly name: string
  readonly config: Readonly<Record<string, string | false>>
}

/**
 * The fixed allowlist of startup upstream rows (the only two upstream packages a local
 * spawn may mount). The renderer accepts no other id/name.
 */
export const STARTUP_PLUGIN_ROWS = {
  workspaceDependencies: {
    id: 'chamber-workspace-dependencies',
    name: '@deepseek-ai/dsh-tool-workspace-dependencies',
  },
  officeSkills: {
    id: 'chamber-office-skills',
    name: '@deepseek-ai/dsh-skill-office',
  },
} as const

/** Per-row config key allowlist, in the fixed render order (design contract). */
const STARTUP_PLUGIN_CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
  [STARTUP_PLUGIN_ROWS.workspaceDependencies.id]: ['source', 'root'],
  [STARTUP_PLUGIN_ROWS.officeSkills.id]: ['assetRoot', 'node', 'cli'],
}

/** Config keys a row MUST carry (an emitted row may never be half-configured). */
const STARTUP_PLUGIN_REQUIRED_KEYS: Readonly<Record<string, readonly string[]>> = {
  [STARTUP_PLUGIN_ROWS.workspaceDependencies.id]: ['source', 'root'],
  [STARTUP_PLUGIN_ROWS.officeSkills.id]: ['assetRoot'],
}

/** The seven Office skill directories dsh-skill-office loads, in upstream order. */
const OFFICE_SKILL_NAMES = [
  'office',
  'office-docx',
  'office-pptx',
  'office-xlsx',
  'office-render',
  'office-recalculate',
  'office-export-pdf',
] as const

/** The upstream packages the active workspace must install (and the kit the CLI comes from). */
const WORKSPACE_DEPENDENCIES_NAME = STARTUP_PLUGIN_ROWS.workspaceDependencies.name
const SKILL_OFFICE_NAME = STARTUP_PLUGIN_ROWS.officeSkills.name
const LIBREOFFICE_KIT_NAME = '@deepseek-ai/libreoffice-kit'

/** Inputs of one per-spawn startup-row plan (see {@link planStartupPluginRows}). */
export interface PlanStartupPluginRowsInput {
  /** Resource capability roots; absent = mount no upstream startup row at all. */
  readonly capabilities?: StartupPluginCapabilities
  /** The ACTIVE dsh workspace/install root (the inserted packages resolve from its anchors). */
  readonly workspacePath: string
  /** The managed dsh home (the primary-runtime install root derives from it). */
  readonly dshHome: string
  /** The user profile patch text (`profiles/web/cordis.patch.yml`), or null when absent. */
  readonly profilePatch: string | null
  /** Informational sink (skip reasons the operator may want). */
  readonly log?: (message: string) => void
  /** Warning sink (a supplied capability root exists but its resource set is incomplete). */
  readonly warn?: (message: string) => void
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The absolute capability roots fail loud when relative: a relative root is a
 *  programming error (the owning shell resolves packaged/dev paths), never a resource
 *  condition, so it must not silently degrade into "no row". */
function assertAbsoluteRoot(label: 'primaryRuntimeDir' | 'officeSkillsDir', value: string | undefined): void {
  if (value !== undefined && !isAbsolute(value)) {
    throw new Error(`startup plugin rows: ${label} must be an absolute path, got ${JSON.stringify(value)}`)
  }
}

/**
 * A package's install dir inside the ACTIVE workspace. Two layouts are supported, the
 * same pair spawn-dsh.ts recognises (installed runtime tree vs pnpm source checkout):
 *   - installed: <workspace>/node_modules/@scope/name
 *   - source:    <workspace>/apps/cli/node_modules/@scope/name (pnpm workspace links)
 * Returns the first EXISTING package.json; null when neither layout installs it.
 */
function workspacePackageManifest(workspacePath: string, packageName: string): string | null {
  for (const anchor of workspacePackageAnchors(workspacePath)) {
    const manifest = join(workspacePackageDir(anchor, packageName), 'package.json')
    if (isFile(manifest)) return manifest
  }
  return null
}

/** The scoped package directory under one workspace anchor. */
function workspacePackageDir(anchor: string, packageName: string): string {
  const slash = packageName.indexOf('/')
  if (slash < 0) return join(anchor, packageName)
  return join(anchor, packageName.slice(0, slash), packageName.slice(slash + 1))
}

/** The two package anchors of a workspace: installed node_modules then pnpm source. */
function workspacePackageAnchors(workspacePath: string): [string, string] {
  return [
    join(workspacePath, 'node_modules'),
    join(workspacePath, 'apps', 'cli', 'node_modules'),
  ]
}

/** True when the user profile patch already mounts this loader id or package name.
 *  Reuse is the loader contract: a duplicated identity would fail the next boot. */
function profileOwnsStartupRow(profilePatch: string | null, identity: StartupPluginIdentity): boolean {
  if (profilePatch === null) return false
  return parseLoaderRows(profilePatch).some(row => row.ids.includes(identity.id) || row.names.includes(identity.name))
}

/** One diagnostic for a gate that failed on an EXISTING capability root (a partial or
 *  corrupt payload is a packaging defect worth a warning, not a silent skip). */
function warnIncomplete(identity: StartupPluginIdentity, details: readonly string[], warn: (message: string) => void): void {
  warn(
    `startup plugin row '${identity.id}' (${identity.name}): ${details.join('; ')}; `
      + 'skipped — no upstream row is mounted',
  )
}

/**
 * The primary-runtime payload gate: `runtime.json` parses and targets this
 * platform/arch, `dependencies/python/bin/python3` is a file, at least one
 * `dependencies/python/lib/pythonX.Y/site-packages` directory exists, and the active
 * workspace installs the tool package (the loader row resolves from that anchor).
 */
function hasUsablePrimaryRuntime(primaryRuntimeDir: string): string[] {
  const missing: string[] = []
  const runtimeJsonPath = join(primaryRuntimeDir, 'runtime.json')
  let metadata: Record<string, unknown> | null = null
  if (!existsSync(runtimeJsonPath)) {
    missing.push(`${runtimeJsonPath} is missing`)
  } else {
    try {
      const parsed: unknown = JSON.parse(readFileSync(runtimeJsonPath, 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>
      } else {
        missing.push(`${runtimeJsonPath} is not a JSON object`)
      }
    } catch (error) {
      missing.push(`${runtimeJsonPath} cannot be parsed (${errorText(error)})`)
    }
  }
  if (metadata !== null && (metadata.platform !== process.platform || metadata.arch !== process.arch)) {
    missing.push(
      `${runtimeJsonPath} targets ${String(metadata.platform)}/${String(metadata.arch)}, `
        + `not ${process.platform}/${process.arch}`,
    )
  }
  const pythonPath = join(primaryRuntimeDir, 'dependencies', 'python', 'bin', 'python3')
  if (!isFile(pythonPath)) missing.push(`${pythonPath} is not a file`)
  const libDir = join(primaryRuntimeDir, 'dependencies', 'python', 'lib')
  if (!hasPythonSitePackages(libDir)) missing.push(`no pythonX.Y/site-packages directory under ${libDir}`)
  return missing
}

/** True when a pythonX.Y lib dir carries its site-packages directory. */
function hasPythonSitePackages(libDir: string): boolean {
  let entries: string[]
  try {
    entries = readdirSync(libDir)
  } catch {
    return false
  }
  return entries.some(entry =>
    /^python\d+\.\d+$/u.test(entry) && isDirectory(join(libDir, entry, 'site-packages')))
}

/** The Office assets gate: seven skill directories each with SKILL.md plus the shared
 *  office/references/sidecar.md. */
function missingOfficeAssets(officeSkillsDir: string): string[] {
  const missing: string[] = []
  for (const skillName of OFFICE_SKILL_NAMES) {
    const skillPath = join(officeSkillsDir, skillName, 'SKILL.md')
    if (!isFile(skillPath)) missing.push(`${skillPath} is missing`)
  }
  const sidecarPath = join(officeSkillsDir, 'office', 'references', 'sidecar.md')
  if (!isFile(sidecarPath)) missing.push(`${sidecarPath} is missing`)
  return missing
}

/** The workspace-installed LibreOffice Kit CLI entry: directly under either package
 *  anchor, or inside the skill package's own node_modules (pnpm SOURCE layout). The CLI
 *  is optional: absent means the operations are explicitly disabled (`cli: false`). */
function workspaceLibreOfficeCli(workspacePath: string): string | null {
  const anchors = workspacePackageAnchors(workspacePath)
  // Hoisted/installed trees expose libreoffice-kit directly under the workspace anchor.
  for (const anchor of anchors) {
    const cli = join(workspacePackageDir(anchor, LIBREOFFICE_KIT_NAME), 'lib', 'cli.js')
    if (isFile(cli)) return cli
  }
  // A pnpm SOURCE workspace installs the kit inside the skill package's own
  // node_modules (that is where the host's package-scoped resolution finds it);
  // the anchor path may itself be a link into the package, so probing through it
  // is layout-faithful.
  for (const anchor of anchors) {
    const nested = join(
      workspacePackageDir(anchor, SKILL_OFFICE_NAME),
      'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js',
    )
    if (isFile(nested)) return nested
  }
  return null
}

/** The payload's standalone Node binary, when the payload carries one. The Swift
 *  sidecar itself runs on this Node; when absent (dev/CI caller Node) the Office row
 *  simply omits `node` and skill-office falls back to process.execPath. */
function payloadNodeBinary(primaryRuntimeDir: string | undefined): string | null {
  if (primaryRuntimeDir === undefined) return null
  const node = join(primaryRuntimeDir, 'dependencies', 'node', 'bin', 'node')
  if (!isFile(node)) return null
  // Reuse the payload's own platform/arch claim: a cross-platform dev payload must
  // not hand skill-office a node that cannot execute here (the wsdeps row is gated
  // on the same metadata; office should not silently depend on it).
  const runtimeJsonPath = join(primaryRuntimeDir, 'runtime.json')
  if (!existsSync(runtimeJsonPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(runtimeJsonPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const metadata = parsed as Record<string, unknown>
    if (metadata.platform !== process.platform || metadata.arch !== process.arch) return null
  } catch {
    return null
  }
  return node
}

/**
 * Plan the primary-runtime/workspace-dependencies row. Emits a row only when every
 * gate passes; a present-but-incomplete payload is warned and skipped, an absent
 * payload directory is a plain log (a dev checkout legitimately carries none).
 */
function planWorkspaceDependenciesRow(
  input: PlanStartupPluginRowsInput,
  log: (message: string) => void,
  warn: (message: string) => void,
): StartupPluginRow | null {
  const identity = STARTUP_PLUGIN_ROWS.workspaceDependencies
  if (profileOwnsStartupRow(input.profilePatch, identity)) {
    log(`startup plugin row '${identity.id}' (${identity.name}): already mounted by the user profile patch; skipped`)
    return null
  }
  const primaryRuntimeDir = input.capabilities?.primaryRuntimeDir
  if (primaryRuntimeDir === undefined) {
    log(`startup plugin row '${identity.id}' (${identity.name}): primaryRuntimeDir not provided; skipped`)
    return null
  }
  if (!isDirectory(primaryRuntimeDir)) {
    log(`startup plugin row '${identity.id}' (${identity.name}): primary runtime payload not present at ${primaryRuntimeDir}; skipped`)
    return null
  }
  if (!isAbsolute(input.dshHome)) {
    warnIncomplete(identity, [`dshHome is not an absolute path (${JSON.stringify(input.dshHome)})`], warn)
    return null
  }
  const missing = hasUsablePrimaryRuntime(primaryRuntimeDir)
  if (workspacePackageManifest(input.workspacePath, WORKSPACE_DEPENDENCIES_NAME) === null) {
    missing.push(
      `the active workspace ${input.workspacePath} does not install ${WORKSPACE_DEPENDENCIES_NAME} `
        + '(neither <workspace>/node_modules nor <workspace>/apps/cli/node_modules carries it)',
    )
  }
  if (missing.length > 0) {
    warnIncomplete(identity, missing, warn)
    return null
  }
  return {
    id: identity.id,
    name: identity.name,
    config: {
      source: primaryRuntimeDir,
      root: join(input.dshHome, 'dsh-runtimes', 'dsh-primary-runtime'),
    },
  }
}

/**
 * Plan the office-skills row: the assets tree and the workspace install gate it. The
 * payload Node is passed explicitly only when the payload carries one AND its manifest
 * targets this host (all Swift hosts share the payload); the workspace CLI entry is passed
 * when present and explicitly disabled (`cli: false`) otherwise, so the three operation
 * skills state the disabled capability instead of failing on a nonexistent path.
 */
function planOfficeSkillsRow(
  input: PlanStartupPluginRowsInput,
  log: (message: string) => void,
  warn: (message: string) => void,
): StartupPluginRow | null {
  const identity = STARTUP_PLUGIN_ROWS.officeSkills
  if (profileOwnsStartupRow(input.profilePatch, identity)) {
    log(`startup plugin row '${identity.id}' (${identity.name}): already mounted by the user profile patch; skipped`)
    return null
  }
  const officeSkillsDir = input.capabilities?.officeSkillsDir
  if (officeSkillsDir === undefined) {
    log(`startup plugin row '${identity.id}' (${identity.name}): officeSkillsDir not provided; skipped`)
    return null
  }
  if (!isDirectory(officeSkillsDir)) {
    log(`startup plugin row '${identity.id}' (${identity.name}): office skill assets not present at ${officeSkillsDir}; skipped`)
    return null
  }
  const missing = missingOfficeAssets(officeSkillsDir)
  if (workspacePackageManifest(input.workspacePath, SKILL_OFFICE_NAME) === null) {
    missing.push(
      `the active workspace ${input.workspacePath} does not install ${SKILL_OFFICE_NAME} `
        + '(neither <workspace>/node_modules nor <workspace>/apps/cli/node_modules carries it)',
    )
  }
  if (missing.length > 0) {
    warnIncomplete(identity, missing, warn)
    return null
  }
  const config: Record<string, string | false> = { assetRoot: officeSkillsDir }
  const node = payloadNodeBinary(input.capabilities?.primaryRuntimeDir)
  if (node !== null) {
    config.node = node
  } else if (input.capabilities?.primaryRuntimeDir !== undefined) {
    const candidate = join(input.capabilities.primaryRuntimeDir, 'dependencies', 'node', 'bin', 'node')
    if (isFile(candidate)) {
      // The payload carries a Node but its manifest is missing/invalid or targets another
      // platform/arch. The wsdeps row usually warns about the same payload; if the profile
      // owns that row the office row must still say why `node` is omitted.
      warn(
        `startup plugin row '${identity.id}' (${identity.name}): payload node ${candidate} is not usable `
        + 'on this host (runtime.json missing/invalid or platform/arch mismatch); node omitted — '
        + 'skill-office falls back to process.execPath',
      )
    }
  }
  config.cli = workspaceLibreOfficeCli(input.workspacePath) ?? false
  return { id: identity.id, name: identity.name, config }
}

/**
 * Plan this spawn's startup upstream rows. Returns the rows in the fixed allowlist
 * order; an absent `capabilities` input yields no row and no diagnostic, while a
 * relative capability root throws (programming error). Every resource gate is
 * independent — one capability missing never suppresses the other row.
 */
export function planStartupPluginRows(input: PlanStartupPluginRowsInput): StartupPluginRow[] {
  const capabilities = input.capabilities
  if (capabilities === undefined) return []
  const log = input.log ?? (() => {})
  const warn = input.warn ?? (() => {})
  assertAbsoluteRoot('primaryRuntimeDir', capabilities.primaryRuntimeDir)
  assertAbsoluteRoot('officeSkillsDir', capabilities.officeSkillsDir)
  // The workspace gates are meaningful only against an absolute root (a relative path
  // would be resolved against process.cwd and could pass by accident).
  if (!isAbsolute(input.workspacePath)) {
    warn(`startup plugin rows: workspacePath is not an absolute path (${JSON.stringify(input.workspacePath)}); skipped`)
    return []
  }
  const rows: StartupPluginRow[] = []
  const workspaceDependencies = planWorkspaceDependenciesRow(input, log, warn)
  if (workspaceDependencies !== null) rows.push(workspaceDependencies)
  const officeSkills = planOfficeSkillsRow(input, log, warn)
  if (officeSkills !== null) rows.push(officeSkills)
  return rows
}

/** The allowlisted identity for a row id; anything else is unrepresentable. */
function startupPluginIdentity(id: string): StartupPluginIdentity {
  for (const identity of Object.values(STARTUP_PLUGIN_ROWS)) {
    if (identity.id === id) return identity
  }
  const allowlist = Object.values(STARTUP_PLUGIN_ROWS).map(identity => identity.id).join(', ')
  throw new Error(`startup plugin insert render: row id '${id}' is not on the allowlist (${allowlist})`)
}

/** YAML single-quoted scalar: the one escape is a literal quote doubled. */
function yamlSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function renderStartupConfigValue(rowId: string, key: string, value: string | false): string {
  if (value === false) {
    if (key !== 'cli') {
      throw new Error(`startup plugin insert render: row '${rowId}' config '${key}' may only be a string or cli: false`)
    }
    return 'false'
  }
  if (typeof value !== 'string') {
    throw new Error(`startup plugin insert render: row '${rowId}' config '${key}' must be a string or false`)
  }
  if (value === '') {
    throw new Error(`startup plugin insert render: row '${rowId}' config '${key}' must not be empty`)
  }
  if (!isAbsolute(value)) {
    throw new Error(
      `startup plugin insert render: row '${rowId}' config '${key}' must be an absolute path, got ${JSON.stringify(value)}`,
    )
  }
  // YAML scalars may not carry control characters; the paths are shell-resolved, so a
  // newline/NUL here is a programming error that must fail loud, never reach the loader.
  if ([...value].some(char => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) {
    throw new Error(`startup plugin insert render: row '${rowId}' config '${key}' contains a control character`)
  }
  return yamlSingleQuote(value)
}

/**
 * Render the startup rows as the overlay's SECOND top-level `- insert:` patch object
 * (a valid continuation of the loader patch array), ending with a newline; zero rows
 * render as the empty string. This is the single validation point for the block: the
 * id/name allowlist, the per-row config key allowlist, required keys, and
 * absolute/control-free string values are all enforced here — invalid input throws.
 */
export function renderStartupPluginInserts(rows: readonly StartupPluginRow[]): string {
  if (rows.length === 0) return ''
  const seen = new Set<string>()
  let text = '- insert:\n'
  for (const row of rows) {
    const identity = startupPluginIdentity(row.id)
    if (row.name !== identity.name) {
      throw new Error(
        `startup plugin insert render: row '${row.id}' must be named '${identity.name}', got ${JSON.stringify(row.name)}`,
      )
    }
    if (seen.has(row.id)) {
      throw new Error(`startup plugin insert render: duplicate overlay row '${row.id}'`)
    }
    seen.add(row.id)
    const allowedKeys = STARTUP_PLUGIN_CONFIG_KEYS[row.id] ?? []
    for (const key of Object.keys(row.config)) {
      if (!allowedKeys.includes(key)) {
        throw new Error(
          `startup plugin insert render: row '${row.id}' config key '${key}' is not allowed (allowed: ${allowedKeys.join(', ')})`,
        )
      }
    }
    for (const key of STARTUP_PLUGIN_REQUIRED_KEYS[row.id] ?? []) {
      if (!Object.hasOwn(row.config, key)) {
        throw new Error(`startup plugin insert render: row '${row.id}' config is missing required key '${key}'`)
      }
    }
    text += `    - id: ${row.id}\n      name: ${yamlSingleQuote(row.name)}\n      config:\n`
    for (const key of allowedKeys) {
      if (!Object.hasOwn(row.config, key)) continue
      text += `        ${key}: ${renderStartupConfigValue(row.id, key, row.config[key] as string | false)}\n`
    }
  }
  return text
}
