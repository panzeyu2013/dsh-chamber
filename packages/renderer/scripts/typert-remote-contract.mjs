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
 * (dsh-v0.1.5-rc.1 = 15 rows). SINGLE SOURCE for both consumers — the
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
const REMOTE_SUFFIX = /@deepseek-ai\/(dsh-[a-z0-9]+(?:-[a-z0-9]+)*)\/remote/g
const IMPORT_CLAUSE = new RegExp(
  `^\\s*import\\s+([^'"\\n]+?)\\s+from\\s+['\"]${REMOTE_SPECIFIER}['\"]`,
  'gm',
)

/**
 * Remove line/block comments so a commented-out import cannot be counted and
 * an import inside a block comment cannot be missed (2026-09 round-3 W4-Q5-F6).
 * @param {string} source - the module text.
 * @returns {string} comment-free text (string bodies preserved).
 */
function stripComments(source) {
  let out = ''
  let quote
  let line = false
  let block = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (line) {
      if (ch === '\n') { line = false; out += ch } else out += ' '
      continue
    }
    if (block) {
      if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '
      continue
    }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

/**
 * Is this import clause type-only? `import type X` and
 * `import { type A, type B }` select no runtime contribution; a mixed clause
 * (`import { type A, B }`) does.
 * @param {string} clause - the text between `import` and `from`.
 * @returns {boolean} true when nothing value-imported is selected.
 */
function isTypeOnlyClause(clause) {
  const trimmed = clause.trim()
  if (/^type\b/.test(trimmed)) return true
  if (!trimmed.startsWith('{')) return false
  const inner = trimmed.slice(1, trimmed.lastIndexOf('}'))
  const specifiers = inner.split(',').map(part => part.trim()).filter(part => part !== '')
  if (specifiers.length === 0) return true
  return specifiers.every(specifier => /^type\b/.test(specifier))
}

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
  return remoteAssembly(source).packages
}

/**
 * Parse the assembly into its value-imported package list AND the local
 * binding names, and fail loudly on any `/remote` edge this line-based parser
 * cannot classify (multi-line imports, re-exports, dynamic import) — an
 * unmodelled edge must never be silently invisible (W4-Q5-F2/F6).
 * @param {string} source - the assembly module text.
 * @returns {{ packages: string[], bindings: Map<string, string> }}
 */
export function remoteAssembly(source) {
  if (typeof source !== 'string') throw new TypeError('Remote assembly source must be a string')
  const code = stripComments(source)
  const packages = []
  const bindings = new Map()
  let matchedEdges = 0
  for (const match of code.matchAll(IMPORT_CLAUSE)) {
    matchedEdges += 1
    if (isTypeOnlyClause(match[1])) continue
    const packageName = `@deepseek-ai/${match[2]}`
    const binding = match[1].trim().split(/\s+/).pop()
    if (binding === undefined || binding === '') continue
    bindings.set(binding, packageName)
    if (!packages.includes(packageName)) packages.push(packageName)
  }
  // Every `/remote` specifier occurrence must be explained by a recognised
  // import or a type-only re-export; anything else (multi-line import, value
  // re-export, dynamic import) fails loudly instead of staying invisible.
  const typeReexport = new RegExp(
    `^\\s*export\\s+type\\b[^'"\\n]*?\\s+from\\s+['\"]${REMOTE_SPECIFIER}['\"]`,
    'gm',
  )
  const allEdges = [...code.matchAll(REMOTE_SUFFIX)].length
  const explained = matchedEdges + [...code.matchAll(typeReexport)].length
  if (allEdges !== explained) {
    throw new Error(
      `Remote assembly has ${allEdges} '/remote' specifier(s) but only ${explained} recognised edge(s) `
      + `(${matchedEdges} import(s) + ${explained - matchedEdges} type re-export(s)) — `
      + 'a multi-line import, value re-export, or dynamic import is unmodelled; re-derive the parser before trusting the contract',
    )
  }
  if (packages.length === 0) {
    throw new Error('Remote assembly does not value-import any @deepseek-ai/dsh-*/remote contributions')
  }
  return { packages, bindings }
}

/**
 * Parse the packages mounted by `apply()`'s contribution array, in order.
 * The imports are only the SELECTION; the mounted array is what actually
 * becomes `ctx.remote` — a same-length edit to the array alone must fail.
 * @param {string} source - the assembly module text.
 * @returns {string[]} package names in mount order.
 */
export function remoteMountPackages(source) {
  const { bindings } = remoteAssembly(source)
  const code = stripComments(source)
  const arrayStart = code.search(/for\s*\(\s*const\s+\w+\s+of\s*\[/)
  if (arrayStart === -1) {
    throw new Error('Remote assembly has no `for (const x of [ ... ])` mount array — re-derive the parser')
  }
  const open = code.indexOf('[', arrayStart)
  const close = code.indexOf(']', open)
  if (close === -1) throw new Error('Remote assembly mount array is unterminated')
  const identifiers = code.slice(open + 1, close)
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
  const mounted = []
  for (const identifier of identifiers) {
    const packageName = bindings.get(identifier)
    if (packageName === undefined) {
      throw new Error(`Remote mount array names ${JSON.stringify(identifier)} which no /remote import binds`)
    }
    mounted.push(packageName)
  }
  return mounted
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
