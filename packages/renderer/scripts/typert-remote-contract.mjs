/**
 * Read the generated-Remote contribution set selected by dsh-api-remotes.
 *
 * The upstream client assembly is the authority: every value import from a
 * a generated `@deepseek-ai/dsh-.../remote` subpath is mounted into
 * ctx.remote. Chamber's
 * source-only vendor snapshot has no `lib/typert.remote-client.js`, so the
 * renderer build must generate exactly that set before Vite resolves it.
 */

/**
 * The pinned assembly contract: every remote package the official
 * `dsh-api-remotes` client half VALUE-imports, in assembly order
 * (dsh-v0.1.5-alpha.2 = 15 rows). SINGLE SOURCE for both consumers — the
 * lockstep test (`typert-remote-contract.test.mjs`) and the upgrade touchpoint
 * gate (`scripts/dev/verify-upstream-touchpoints.mjs` C4). A same-length swap
 * (one package added while another is removed, or a reorder) must not pass
 * silently, so both compare the parsed assembly against this exact list; an
 * upstream change is one edit here plus the package contract assertions.
 */
export const EXPECTED_REMOTE_PACKAGES = Object.freeze([
  '@deepseek-ai/dsh-agent-presets',
  '@deepseek-ai/dsh-commands',
  '@deepseek-ai/dsh-api-settings-controller',
  '@deepseek-ai/dsh-goal',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-cordis-host-runner',
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-message-feedback',
  '@deepseek-ai/dsh-command-feedback',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-session-reference',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-workspace-controller',
  '@deepseek-ai/dsh-api-workspace-files',
])

const REMOTE_SPECIFIER = '@deepseek-ai/(dsh-[a-z0-9]+(?:-[a-z0-9]+)*)/remote'
const VALUE_REMOTE_IMPORT = new RegExp(
  `^\\s*import\\s+(?!type\\b)[^'"\\n]+?\\s+from\\s+['"]${REMOTE_SPECIFIER}['"]`,
  'gm',
)

const REMOTE_EXPORT = Object.freeze({
  types: './lib/typert.remote-client.d.ts',
  default: './lib/typert.remote-client.js',
})
const REMOTE_FILES = Object.freeze([
  'lib/typert.remote-client.js',
  'lib/typert.remote-client.d.ts',
])

/**
 * Return package names in their assembly order, de-duplicated.
 * Type-only re-exports do not select a runtime contribution.
 */
export function remotePackagesFromAssembly(source) {
  if (typeof source !== 'string') throw new TypeError('Remote assembly source must be a string')
  const packages = []
  const seen = new Set()
  for (const match of source.matchAll(VALUE_REMOTE_IMPORT)) {
    const packageName = `@deepseek-ai/${match[1]}`
    if (seen.has(packageName)) continue
    seen.add(packageName)
    packages.push(packageName)
  }
  if (packages.length === 0) {
    throw new Error('Remote assembly does not value-import any @deepseek-ai/dsh-*/remote contributions')
  }
  return packages
}

/**
 * Assert the upstream publish contract required by generated Remote clients.
 * This mirrors WorkspaceTypertGenerator.validateExport rather than inventing
 * a chamber-specific subpath shape.
 */
export function assertRemotePackageContract(packageName, manifest) {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${packageName}: package.json must be an object`)
  }
  if (manifest.name !== packageName) {
    throw new Error(`${packageName}: package.json name is ${JSON.stringify(manifest.name)}`)
  }
  const actual = manifest.exports !== null && typeof manifest.exports === 'object'
    && !Array.isArray(manifest.exports)
    ? manifest.exports['./remote']
    : undefined
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)
    || actual.types !== REMOTE_EXPORT.types || actual.default !== REMOTE_EXPORT.default) {
    throw new Error(`${packageName}: ./remote must export ${JSON.stringify(REMOTE_EXPORT)}`)
  }
  const files = Array.isArray(manifest.files) ? manifest.files : []
  for (const file of REMOTE_FILES) {
    if (!files.includes(file)) throw new Error(`${packageName}: package files must include ${file}`)
  }
}
