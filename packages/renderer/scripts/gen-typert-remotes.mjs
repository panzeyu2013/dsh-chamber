#!/usr/bin/env node
/**
 * gen-typert-remotes.mjs — emits the typert-generated Remote client artifacts
 * the dsh client assembly imports (`@deepseek-ai/<pkg>/remote`). Those files
 * are build outputs of the external dsh checkout's tsdown pipeline and do not
 * exist in the source-only vendor tree; the typert generator itself does, so
 * we bundle it (esbuild, resolving `typescript` from the chamber install) and
 * run it in-memory against the external workspace (read-only — artifacts are
 * written under packages/renderer/src/generated/typert/, never into vendor).
 *
 * The typert model is workspace-global (interface-merged TypertLookupMap,
 * cross-package Remote references), so the analysis registers the whole
 * external package tree — exactly the scope of the upstream workspace pass.
 * Two chamber adaptations make those programs compile here:
 *  - the external repo's own tsconfigs resolve their ambient types through
 *    the external repo's node_modules, which does not exist here; we analyze
 *    with a chamber-owned host aggregate (hostConfig) that pins lib
 *    ES2024+DOM and maps every @deepseek-ai/* import onto the vendor source
 *    tree via tsconfig paths (realpaths, so module identities compare);
 *  - default-lib discovery of the bundled typescript resolves against the
 *    bundle directory, and the analyzer's standard-lib checks require a
 *    /typescript/lib/ path segment — bundle and libs share that directory.
 *
 * vite.config.mjs maps the `/remote` subpath of these packages to the
 * generated artifact (src/remote/index.ts does not exist upstream).
 */
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertRemotePackageContract, remotePackagesFromAssembly } from './typert-remote-contract.mjs'

const requireFromRenderer = createRequire(fileURLToPath(new URL('../package.json', import.meta.url)))
// esbuild is vite's transitive dependency — resolve it through vite's tree.
const viteEntry = requireFromRenderer.resolve('vite')
// import() treats a string specifier as a URL: a POSIX absolute path parses as
// a file: URL, but a Windows absolute path ("D:\…") parses as protocol "d:" and
// fails with ERR_UNSUPPORTED_ESM_URL_SCHEME — always convert to a file URL.
const esbuildModule = await import(pathToFileURL(createRequire(viteEntry).resolve('esbuild')).href)
const build = esbuildModule.build

const CACHE = fileURLToPath(new URL('../.cache/', import.meta.url))
const VENDOR = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/', import.meta.url))
const OUT_ROOT = fileURLToPath(new URL('../src/generated/typert/', import.meta.url))
const BUNDLE = join(CACHE, 'typescript/lib/typert-generator.cjs')
const HOST_CONFIG = join(CACHE, 'host-tsconfig.json')

/**
 * dsh-api-remotes/client is the authoritative runtime assembly. Derive its
 * value-imported contributions instead of duplicating an rc-specific list:
 * rc.8 added file/session reference Remotes, and a stale five-item copy made
 * Vite fail only after the generator had reported success.
 */
const REMOTE_ASSEMBLY_ENTRY = join(VENDOR, 'dsh-api-remotes/src/client/index.ts')
const REMOTE_PACKAGES = remotePackagesFromAssembly(readFileSync(REMOTE_ASSEMBLY_ENTRY, 'utf8'))
for (const packageName of REMOTE_PACKAGES) {
  const packageDir = packageName.slice('@deepseek-ai/'.length)
  const manifest = JSON.parse(readFileSync(join(VENDOR, packageDir, 'package.json'), 'utf8'))
  assertRemotePackageContract(packageName, manifest)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * The external dsh checkout root: walk up from a vendored package through its
 * realpath until the repo-root aggregate (tsconfig.host.json) is found. Works
 * for every source the preinstall bootstrap (ensure-harness-vendor.mjs) may
 * resolve — managed clone, sibling checkout, DSH_CHAMBER_HARNESS_ROOT — so no
 * machine-specific path is hardcoded here.
 */
function findHarnessRoot() {
  const probe = join(VENDOR, 'dsh-agent')
  if (!isFile(join(probe, 'package.json'))) {
    throw new Error('gen-typert-remotes: vendor tree missing — run `pnpm install` (preinstall populates vendor/harness-packages)')
  }
  let dir = realpathSync(probe)
  for (;;) {
    if (isFile(join(dir, 'tsconfig.host.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error(`gen-typert-remotes: ${realpathSync(probe)} 上方找不到 tsconfig.host.json`)
    }
    dir = parent
  }
}

const HARNESS_ROOT = findHarnessRoot()

function isWithinDir(file, dir) {
  const relative = file.startsWith(dir) ? file.slice(dir.length) : ''
  return relative !== '' && !relative.startsWith('/') === false
}

/** Subpath → source entry convention (mirrors vite.config.mjs). */
function sourceEntry(pkgDir, sub) {
  const src = join(pkgDir, 'src')
  if (sub === '') return join(src, 'index.ts')
  if (sub === 'client') {
    for (const cand of [join(src, 'client/index.ts'), join(src, 'client.ts')]) {
      if (isFile(cand)) return cand
    }
    return join(src, 'client.ts')
  }
  if (sub === 'remote' || sub === 'api' || sub === 'types' || sub === 'brand' || sub === 'presentation' || sub === 'typert') {
    for (const cand of [join(src, `${sub}/index.ts`), join(src, `${sub}.ts`)]) {
      if (isFile(cand)) return cand
    }
  }
  if (sub.startsWith('api/')) {
    const cand = join(src, `${sub}.ts`)
    if (isFile(cand)) return cand
  }
  for (const cand of [join(src, `${sub}/index.ts`), join(src, `${sub}.ts`)]) {
    if (isFile(cand)) return cand
  }
  return null
}

/**
 * Walk one file's value imports, bounded to the vendor tree and the analyzed
 * package roots (relative imports never climb out of the tree).
 */
function walkImports(file, onSpec, roots) {
  const seen = new Set()
  const queue = [file]
  while (queue.length > 0) {
    const current = queue.shift()
    if (seen.has(current)) continue
    seen.add(current)
    if (!isFile(current)) continue
    const text = readFileSync(current, 'utf8')
    const found = new Set()
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) found.add(match[1])
    for (const match of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)) found.add(match[1])
    for (const match of text.matchAll(/import\s+['"]([^'"]+)['"]/g)) found.add(match[1])
    for (const spec of found) {
      onSpec(spec)
      if (spec.startsWith('@deepseek-ai/')) {
        const name = spec.slice('@deepseek-ai/'.length)
        const slash = name.indexOf('/')
        const pkg = slash === -1 ? name : name.slice(0, slash)
        const sub = slash === -1 ? '' : name.slice(slash + 1)
        const entry = sourceEntry(join(VENDOR, pkg), sub)
        if (entry !== null && isWithinVendor(entry) && isFile(entry)) queue.push(entry)
      } else if (spec.startsWith('.')) {
        const resolved = join(dirname(current), spec)
        for (const cand of [resolved, `${resolved}.ts`, `${resolved}.tsx`, join(resolved, 'index.ts'), join(resolved, 'index.tsx')]) {
          if (isFile(cand)) {
            queue.push(cand)
            break
          }
        }
      }
    }
  }
}

function isWithinVendor(file) {
  return file.startsWith(VENDOR)
}

/**
 * The host-face registration scope: the external repo's own host aggregate
 * references (tsconfig.host.json) — the authoritative package set the typert
 * host face is composed from. The client tree and client-half extensions are
 * deliberately absent there, so interface-merged metadata cannot collide.
 */
/** Minimal JSONC comment strip (tsconfigs carry line and block comments). */
function stripJsonComments(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]
    if (inString) {
      out += char
      if (char === '\\') { out += next; i += 1 }
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') { inString = true; out += char; continue }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += char
  }
  return out
}

function hostFacePackageDirs() {
  const aggregate = join(HARNESS_ROOT, 'tsconfig.host.json')
  const parsed = JSON.parse(stripJsonComments(readFileSync(aggregate, 'utf8')))
  const dirs = []
  for (const reference of parsed.references ?? []) {
    if (typeof reference.path !== 'string') continue
    const resolved = reference.path.endsWith('.json')
      ? join(HARNESS_ROOT, dirname(reference.path))
      : join(HARNESS_ROOT, reference.path)
    const manifest = join(resolved, 'package.json')
    if (isFile(manifest)) dirs.push(resolved)
  }
  return dirs
}

async function main() {
  mkdirSync(CACHE, { recursive: true })

  // 1. typescript 6.x (the dsh repo's pin) from the pnpm store — the chamber
  //    root pins 7.x which has a different module shape.
  const pnpmStore = fileURLToPath(new URL('../../../node_modules/.pnpm/', import.meta.url))
  const typescriptSix = readdirSync(pnpmStore)
    .filter((entry) => entry.startsWith('typescript@6'))
    .map((entry) => `${pnpmStore}${entry}/node_modules/typescript`)
    .find((candidate) => isFile(join(candidate, 'lib/typescript.js')))
  if (typescriptSix === undefined) throw new Error('gen-typert-remotes: no typescript@6 in the pnpm store')
  // Default-lib discovery of the bundled typescript resolves against the
  // bundle directory (sys.getExecutingFilePath), and the analyzer's
  // standard-lib checks require a /typescript/lib/ path segment — bundle and
  // libs share that directory. Normalize separators before matching: the
  // filter regexes use forward slashes, and cpSync passes native (backslash)
  // paths on Windows — without normalization every lib.*.d.ts would be
  // dropped there, leaving the analyzer's program without default libs
  // (e.g. `Record has no declaration`).
  cpSync(join(typescriptSix, 'lib'), join(CACHE, 'typescript/lib'), {
    recursive: true,
    filter: (source) => {
      const norm = source.replaceAll('\\', '/')
      return !/\.[^/.]+$/.test(norm) || /\/lib\.(?:es|dom|webworker|decorators|scripthost)[^/]*\.d\.ts$/.test(norm)
    },
  })

  // 2. Bundle a tiny generator face: the analyzer + emitter.
  const analyzerPath = join(VENDOR, 'dsh-typert-generator/src/analyzer.ts')
  const emitterPath = join(VENDOR, 'dsh-typert-generator/src/emitter.ts')
  const entryPath = join(CACHE, 'typert-entry.ts')
  writeFileSync(entryPath,
    `import { WorkspaceAnalyzer } from ${JSON.stringify(analyzerPath)}\n`
    + `import { FaceModelEmitter } from ${JSON.stringify(emitterPath)}\n`
    + `export { WorkspaceAnalyzer, FaceModelEmitter }\n`)
  const resolveDep = (spec) => {
    try {
      return requireFromRenderer.resolve(spec)
    } catch {
      return createRequire(viteEntry).resolve(spec)
    }
  }
  await build({
    entryPoints: [entryPath],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: BUNDLE,
    logLevel: 'silent',
    plugins: [{
      name: 'chamber-vendor-dep-resolution',
      setup(builder) {
        builder.onResolve({ filter: /^typescript$/ }, () => ({ path: join(typescriptSix, 'lib/typescript.js') }))
        builder.onResolve({ filter: /^@jridgewell\/gen-mapping$/ }, () => ({ path: resolveDep('@jridgewell/gen-mapping') }))
      },
    }],
  })

  // 3. Chamber-owned host aggregate: ambient libs + @deepseek-ai source paths
  //    + the whole external package tree as project references.
  const packageDirs = hostFacePackageDirs()
  if (packageDirs.length < 100) throw new Error(`gen-typert-remotes: suspiciously few external packages (${packageDirs.length})`)
  const entryRoots = []
  const specs = new Set()
  const npmSpecs = new Set()
  for (const dir of packageDirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const entry = sourceEntry(dir, '')
    if (entry === null) continue
    entryRoots.push(entry)
    const pkgName = typeof manifest.name === 'string' ? manifest.name : null
    if (pkgName !== null && pkgName.startsWith('@deepseek-ai/')) {
      // Seed the spec walk from this package's name.
      specs.add(pkgName)
    }
  }
  for (const entry of entryRoots) {
    walkImports(entry, (spec) => {
      if (spec.startsWith('@deepseek-ai/')) specs.add(spec)
      else if (!spec.startsWith('.') && !spec.startsWith('node:')) npmSpecs.add(spec)
    }, entryRoots)
  }
  const allSpecs = new Set(specs)
  const pathMap = {}
  for (const spec of allSpecs) {
    const name = spec.slice('@deepseek-ai/'.length)
    const slash = name.indexOf('/')
    const pkg = slash === -1 ? name : name.slice(0, slash)
    const sub = slash === -1 ? '' : name.slice(slash + 1)
    const entry = sourceEntry(join(VENDOR, pkg), sub)
    if (entry === null || !isWithinVendor(entry) || !isFile(entry)) continue
    pathMap[spec] = [realpathSync(entry)]
  }
  // The react family resolves to @types/react 18.3 in the dsh repo (their
  // pin, present in the pnpm store); @types/react 19 defaults type parameters
  // to the intrinsic `unknown`, which the typert model cannot name.
  const reactTypesDirs = readdirSync(pnpmStore)
    .filter((entry) => entry.startsWith('@types+react@18'))
    .map((entry) => `${pnpmStore}${entry}/node_modules/@types/react`)
    .filter((candidate) => isFile(join(candidate, 'index.d.ts')))
  const reactDomTypesDirs = readdirSync(pnpmStore)
    .filter((entry) => entry.startsWith('@types+react-dom@18'))
    .map((entry) => `${pnpmStore}${entry}/node_modules/@types/react-dom`)
    .filter((candidate) => isFile(join(candidate, 'index.d.ts')))
  for (const spec of npmSpecs) {
    try {
      if (spec === 'react' && reactTypesDirs.length > 0) {
        pathMap[spec] = [realpathSync(join(reactTypesDirs[0], 'index.d.ts'))]
        continue
      }
      if (spec === 'react-dom' && reactDomTypesDirs.length > 0) {
        pathMap[spec] = [realpathSync(join(reactDomTypesDirs[0], 'index.d.ts'))]
        continue
      }
      if (spec === 'react/jsx-runtime' && reactTypesDirs.length > 0) {
        pathMap[spec] = [realpathSync(join(reactTypesDirs[0], 'jsx-runtime.d.ts'))]
        continue
      }
      if (spec === 'react-dom/client' && reactDomTypesDirs.length > 0) {
        pathMap[spec] = [realpathSync(join(reactDomTypesDirs[0], 'client.d.ts'))]
        continue
      }
      // Map npm specifiers to their TYPES entry (paths bypass package types
      // resolution; pointing at a JS entry yields an implicit-any module).
      const pkgJson = requireFromRenderer.resolve(`${spec}/package.json`)
      const manifest = JSON.parse(readFileSync(pkgJson, 'utf8'))
      const exportsField = manifest.exports
      const entry = exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)
        && typeof exportsField['.'] === 'object' && exportsField['.'] !== null
        ? exportsField['.'].types ?? exportsField['.'].default
        : manifest.types ?? manifest.typings ?? manifest.main
      const base = dirname(pkgJson)
      const target = typeof entry === 'string' ? join(base, entry) : base
      const dts = realpathSync(target)
      if (!isFile(dts) && isFile(`${dts}.d.ts`)) pathMap[spec] = [`${dts}.d.ts`]
      else if (isFile(dts)) pathMap[spec] = [dts]
    } catch {
      // Unresolvable npm specifiers are type-only in practice; leave them out.
    }
  }
  const config = {
    compilerOptions: {
      target: 'es2024',
      module: 'esnext',
      moduleResolution: 'bundler',
      lib: ['ES2024', 'DOM', 'DOM.Iterable'],
      skipLibCheck: true,
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      types: [],
      paths: pathMap,
    },
    references: packageDirs.map((dir) => ({
      // Dual-face packages use solution-style root tsconfigs (empty files +
      // references); the upstream aggregate points at their tsconfig.host.json.
      path: isFile(join(dir, 'tsconfig.host.json')) ? join(dir, 'tsconfig.host.json') : dir,
    })),
  }
  writeFileSync(HOST_CONFIG, `${JSON.stringify(config, null, 2)}\n`)

  // 4. Analyze the host face (workspace scope) and emit the remote-client
  //    artifacts for the selected packages, in-memory.
  const { WorkspaceAnalyzer, FaceModelEmitter } = createRequire(BUNDLE)(BUNDLE)
  const analyzer = new WorkspaceAnalyzer({
    root: HARNESS_ROOT,
    hostConfig: HOST_CONFIG,
    faces: ['host'],
    // Per-package diagnostic programs resolve their ambient types through the
    // external repo's node_modules (absent here); the analysis program itself
    // runs under the chamber aggregate (lib + paths) and is the model source.
    checkDiagnostics: false,
    // Explicit package selection (mirrors the upstream tsdown pipeline's
    // discover-then-generate discipline — see tsdown-plugin.ts emitWorkspace):
    // without `packages` the host program is the FULL discovered workspace,
    // which (a) collides on interface-merged TypertContextMap members declared
    // on both faces (core/agent and client/runtime both declare `agent`), and
    // (b) hard-fails on host SDK value imports that exist in the external
    // repo's node_modules but not in the chamber's install tree (e2b, sharp,
    // node-pty, …) — the unresolved modules degrade to `unknown` types the
    // analyzer refuses. Selecting the emitted set builds the program from
    // those packages' files plus their import closure, which reaches every
    // context key they use (agent/session/…) through the workspace paths.
    packages: REMOTE_PACKAGES,
  })
  const workspace = analyzer.analyze()
  let emitted = 0
  for (const face of workspace.faces) {
    const emitter = new FaceModelEmitter(face)
    for (const packageModel of face.packages) {
      if (!REMOTE_PACKAGES.includes(packageModel.name)) continue
      const artifact = emitter.emit(packageModel.name)
      if (artifact.remote === undefined) continue
      const outDir = join(OUT_ROOT, packageModel.name.replace('@deepseek-ai/', ''))
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'typert.remote-client.js'), artifact.remote.js)
      emitted += 1
    }
  }
  console.log(`gen-typert-remotes: emitted ${emitted} remote-client artifacts into ${OUT_ROOT}`)
  if (emitted !== REMOTE_PACKAGES.length) {
    console.error(`gen-typert-remotes: expected ${REMOTE_PACKAGES.length} artifacts, got ${emitted}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('gen-typert-remotes:', error)
  process.exit(1)
})
