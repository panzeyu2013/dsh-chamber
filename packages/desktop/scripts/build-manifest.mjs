#!/usr/bin/env node
/**
 * build-manifest.mjs — G3「构建输入摘要」清单模块（design 21 §7；TODO D§2.2）。
 *
 * 为什么需要：packages/desktop/dist/web/** 与 dist/host-*-package/** 在
 * .gitignore 里，干净 checkout 的「缺失」是正常态；要防的是本地/打包态的
 * 「存在但陈旧」——CI 每次全新构建看不到这一类。标记串守卫对没有稳定文案的
 * 产物（vite 输出、cpSync 出来的 host 包）判不了，所以构建时写一份
 * `.build-manifest.json`：
 *
 *   { schemaVersion, artifactId, builtAt, toolVersion,
 *     inputsHash, inputsCount, outputs: [{ path, bytes, sha256 }] }
 *
 *  - inputsHash = 构建输入文件集（路径 + 内容 sha256，按路径排序后整体再
 *    sha256）。输入集规则在**本模块单源**（WEB_DIST_INPUT_PACKAGE_DIRS /
 *    hostPackageInputFiles），写入方与比对方共用同一份规则，新增/删除输入
 *    文件也会改变摘要（只存单个 digest 不够，集合漂移同样是陈旧）；
 *  - toolVersion = 构建工具链身份（web = node 主版本 + vite 版本；host 包 =
 *    纯拷贝构建器版本），跨机器/跨工具链的产物直接判陈旧（fail closed）；
 *  - outputs = 产物目录里每个文件的路径/字节/sha256（不含 manifest 自身），
 *    额外文件（旧 chunk 残留）、缺文件、被手工改过的文件都判陈旧。
 *
 * 语义（与 verify-artifact-freshness 同款）：
 *   - 目录缺失（clean checkout）⇒ `missing`，**不是**陈旧，调用方按需 SKIP；
 *   - 目录在但 manifest 缺失/损坏/摘要不符/产物不符 ⇒ `stale`，绝不自动修复；
 *   - 失败信息必须给重建命令（TODO D§2.3「操作者只看到红、不知下一步」）。
 *
 * 已知覆盖边界（登记而非静默）：vendor 上游源码树（vendor/harness-checkout，
 * 2 万文件 / ~190MB）不逐文件哈希，pin 只以 `harness.commit`（声明式 pin）
 * 参与摘要；锁定文件里同 semver 范围内的第三方小版本漂移不改变摘要——发布/
 * 打包链总是全新构建，这一类由构建顺序而不是本摘要兜底。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The manifest file name written INTO each artifact directory (gitignored tree). */
export const BUILD_MANIFEST_FILE = '.build-manifest.json'
/** Schema version; a mismatch is stale (an older build predates the current rules). */
export const BUILD_MANIFEST_SCHEMA_VERSION = 1

/** Artifact ids — the same strings the freshness registry / gate use. */
export const WEB_DIST_ARTIFACT_ID = 'desktop/dist/web'
export const HOST_PACKAGE_ARTIFACT_ID = 'desktop/dist/host-*-package'
/** Contract of THREE places (vite outDir / main-side webDistDir / build-swift-app). */
export const WEB_DIST_RELATIVE = 'packages/desktop/dist/web'

/** Rebuild commands named by every failure message (single source; TODO D§2.3). */
export const WEB_DIST_REBUILD_COMMAND = 'pnpm run build:renderer'
export const HOST_PACKAGE_REBUILD_COMMAND = 'pnpm --filter @dsh-chamber/desktop run build:host-graph-package（前置：pnpm run build:host-packages）'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

/**
 * Chamber workspace packages whose SOURCE is baked into the renderer's
 * dist/web bundle (vite.config.mjs aliases + renderer package dependencies).
 * The lockstep test walks vite.config.mjs for `src('../<pkg>/src/...')` alias
 * targets and requires each package here — adding an alias without adding the
 * package to this list reddens the test instead of silently leaving a build
 * input unguarded.
 */
export const WEB_DIST_INPUT_PACKAGE_DIRS = Object.freeze([
  // the renderer itself (its src is the bundle, its scripts are the build
  // pipeline: gen-typert-remotes / gen-boot-manifest / check-chunk-budgets)
  'packages/renderer',
  // chamber client kernel + wire contracts + clockless stream state
  'packages/dsh-chamber-client-core',
  'packages/dsh-chamber-wire',
  'packages/dsh-stream-state',
  // chamber self-built client plugins (boot graph + deferred rows)
  'packages/dsh-chamber-client-ui-sidebar',
  'packages/dsh-chamber-client-ui-layout',
  'packages/dsh-chamber-client-ui-settings-connections',
  'packages/dsh-chamber-client-ui-settings-bridge',
  'packages/dsh-chamber-client-ui-settings-plugin-manager',
  'packages/dsh-chamber-client-ui-git',
  'packages/dsh-chamber-client-ui-open-in',
  'packages/dsh-chamber-client-ui-browser',
  // the three upstream client forks copied into this repo (resolved to SOURCE
  // by vite.config.mjs: connection carrier / web shell / api-gateway client)
  'packages/dsh-client-connection',
  'packages/dsh-client-web',
  'packages/dsh-api-gateway',
])

/**
 * Extra files that determine dist/web but live outside the package roots above:
 * the vite entry HTML/config, the shared manifest builder itself (its rules are
 * part of the build contract), and the declared upstream pin (the vendor source
 * tree is too large to hash file-by-file; see the header's coverage note).
 */
export const WEB_DIST_EXTRA_INPUT_FILES = Object.freeze([
  'packages/renderer/index.html',
  'packages/renderer/vite.config.mjs',
  'packages/desktop/scripts/build-manifest.mjs',
  'harness.commit',
])

/** Directory names never walked on the input side (build outputs / tests / tooling). */
const SKIP_INPUT_DIRS = new Set([
  'node_modules', 'dist', 'test', 'tests', 'test-fixtures', 'coverage', 'release', 'swift',
])

/**
 * Non-build files never count as build inputs: docs / source maps / hidden
 * entries / test sources, and the renderer's test-manifest entry point
 * (`scripts/test.mjs` runs tests, it is not part of the bundle pipeline).
 */
const SKIP_INPUT_FILE = /\.(?:md|map)$|(?:^|\/)\.|\.test\.(?:[cm]?[jt]sx?)$|scripts\/test\.mjs$/u

/** @param {string} absPath @returns {string} file content sha256 (hex) */
export function sha256File(absPath) {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex')
}

/**
 * Deterministic digest of an input set: sorted `<repo-relative path>NUL<sha256>`
 * lines hashed once. Paths (not absolute spellings) keep the digest portable
 * across checkouts / machines; sorting makes it order-preserving for callers.
 * @param {readonly {path: string, sha256: string}[]} entries
 * @returns {string} `sha256:<hex>`
 */
export function digestEntries(entries) {
  const lines = [...entries]
    .map((entry) => entry.path + '\0' + entry.sha256)
    .sort()
    .join('\n')
  return 'sha256:' + createHash('sha256').update(lines, 'utf8').digest('hex')
}

/** @param {string} absPath @param {string} root @returns {string} root-relative posix path */
function repoRelative(absPath, root) {
  return relative(root, absPath).split(sep).join('/')
}

/** Walk regular files (sorted) under dir; callers own the directory-level skips. */
function walkRegularFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_INPUT_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      walkRegularFiles(full, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

/**
 * Input entries for one package root: `src/**` (+ `scripts/**` for the
 * renderer, whose build pipeline lives there) and package.json. Entries carry
 * mtimeMs for staleness diagnostics; the digest itself only uses path+sha256.
 * @param {string} absDir package root.
 * @param {string} root repo root (digest paths are root-relative).
 * @param {{primary?: boolean}} [options] primary = renderer's own tree.
 */
function packageInputEntries(absDir, root, { primary = false } = {}) {
  if (!existsSync(absDir)) throw new Error('build-manifest: 输入包不存在：' + absDir)
  const files = []
  for (const subdir of primary ? ['src', 'scripts'] : ['src']) {
    const dir = join(absDir, subdir)
    if (existsSync(dir)) walkRegularFiles(dir, files)
  }
  const manifest = join(absDir, 'package.json')
  if (existsSync(manifest)) files.push(manifest)
  return files
    .filter((file) => !SKIP_INPUT_FILE.test('/' + repoRelative(file, root)))
    .map((file) => ({ path: repoRelative(file, root), bytes: statSync(file).size, sha256: sha256File(file), mtimeMs: statSync(file).mtimeMs }))
}

/**
 * The complete dist/web build input set (rules above). Throws when a declared
 * package root is missing: that is a source-tree contract break, not "no inputs".
 * @param {{ root?: string }} [options]
 * @returns {{ path: string, bytes: number, sha256: string, mtimeMs: number }[]}
 */
export function webDistInputFiles({ root = REPO_ROOT } = {}) {
  const entries = []
  for (const packageDir of WEB_DIST_INPUT_PACKAGE_DIRS) {
    const primary = packageDir === 'packages/renderer'
    entries.push(...packageInputEntries(join(root, packageDir), root, { primary }))
  }
  for (const relativePath of WEB_DIST_EXTRA_INPUT_FILES) {
    const full = join(root, relativePath)
    if (!existsSync(full)) throw new Error('build-manifest: dist/web 的声明输入缺失：' + relativePath)
    entries.push({ path: relativePath, bytes: statSync(full).size, sha256: sha256File(full), mtimeMs: statSync(full).mtimeMs })
  }
  return dedupeSorted(entries)
}

/**
 * Build-input entries for one host package artifact: the seed package's
 * package.json + built dist/** that build-host-graph-package copies, plus the
 * builder itself and this module (their rules are part of the build contract).
 * @param {string} sourceDir the seed package directory the copy reads.
 * @param {{ root?: string, builderFiles?: readonly string[] }} [options]
 */
export function hostPackageInputFiles(sourceDir, { root = REPO_ROOT, builderFiles = HOST_PACKAGE_BUILDER_FILES } = {}) {
  const files = []
  const manifest = join(sourceDir, 'package.json')
  if (!existsSync(manifest)) throw new Error('build-manifest: host 包输入缺 package.json：' + sourceDir)
  files.push(manifest)
  const dist = join(sourceDir, 'dist')
  if (!existsSync(dist)) throw new Error('build-manifest: host 包输入缺被拷贝的 dist/：' + sourceDir)
  walkRegularFiles(dist, files)
  for (const builder of builderFiles) {
    const full = join(root, builder)
    if (!existsSync(full)) throw new Error('build-manifest: host 包构建器缺失：' + builder)
    files.push(full)
  }
  return dedupeSorted(files.map((file) => ({ path: repoRelative(file, root), bytes: statSync(file).size, sha256: sha256File(file), mtimeMs: statSync(file).mtimeMs })))
}

/** Build scripts whose behaviour is part of every host-package artifact. */
export const HOST_PACKAGE_BUILDER_FILES = Object.freeze([
  'packages/desktop/scripts/build-host-graph-package.mjs',
  'packages/desktop/scripts/build-manifest.mjs',
])

/** Sort + dedupe by path (one file reached through two roots must not double-count). */
function dedupeSorted(entries) {
  const byPath = new Map()
  for (const entry of entries) byPath.set(entry.path, entry)
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * Every file inside an artifact directory (sorted, posix relative paths), the
 * manifest itself excluded. Hidden files count too: a leftover `.vite/` or a
 * stale dotfile is exactly the "extra output" this guard exists to catch.
 * @param {string} dir artifact directory.
 * @returns {{ path: string, bytes: number, sha256: string }[]}
 */
export function collectOutputFiles(dir) {
  if (!existsSync(dir)) throw new Error('build-manifest: 产物目录不存在：' + dir)
  const files = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        const path = relative(dir, full).split(sep).join('/')
        if (path === BUILD_MANIFEST_FILE) continue
        files.push({ path, bytes: statSync(full).size, sha256: sha256File(full) })
      }
    }
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Toolchain identity of the dist/web build (toolVersion field). */
export function webDistToolVersion({ root = REPO_ROOT } = {}) {
  const candidate = join(root, 'packages', 'renderer', 'node_modules', 'vite', 'package.json')
  let viteVersion = 'unknown'
  try {
    viteVersion = JSON.parse(readFileSync(candidate, 'utf8')).version
  } catch {
    try {
      viteVersion = JSON.parse(readFileSync(join(root, 'node_modules', 'vite', 'package.json'), 'utf8')).version
    } catch {
      viteVersion = 'unknown'
    }
  }
  const nodeMajor = String(process.version).split('.')[0]
  return 'web-build/1 ' + nodeMajor + ' vite@' + viteVersion
}

/** Toolchain identity of a host-package copy (pure file copy: version only). */
export function hostPackageToolVersion() {
  return 'host-package-copy/1'
}

/**
 * Write the manifest into an artifact directory. Must run AFTER the artifact's
 * last writer step (web: after check-chunk-budgets wrote perf-sizes.json; host:
 * after the atomic rename), because outputs are enumerated from disk here.
 * @param {string} dir artifact directory.
 * @param {{ artifactId: string, inputs: readonly {path: string, sha256: string}[], toolVersion: string, builtAt?: string }} build
 * @returns {object} the written manifest.
 */
export function writeBuildManifest(dir, { artifactId, inputs, toolVersion, builtAt = new Date().toISOString() }) {
  if (!existsSync(dir)) throw new Error('build-manifest: 产物目录不存在，无法写 manifest：' + dir)
  const manifest = {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    artifactId,
    builtAt,
    toolVersion,
    inputsHash: digestEntries(inputs),
    inputsCount: inputs.length,
    outputs: collectOutputFiles(dir),
  }
  writeFileSync(join(dir, BUILD_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

/** dist/web writer (build pipeline: packages/renderer/scripts/check-chunk-budgets.mjs). */
export function writeWebDistBuildManifest({ webDistDir, root = REPO_ROOT } = {}) {
  return writeBuildManifest(webDistDir, {
    artifactId: WEB_DIST_ARTIFACT_ID,
    inputs: webDistInputFiles({ root }),
    toolVersion: webDistToolVersion({ root }),
  })
}

/** host-*-package writer (build-host-graph-package.mjs). */
export function writeHostPackageBuildManifest({ outDir, sourceDir, root = REPO_ROOT } = {}) {
  return writeBuildManifest(outDir, {
    artifactId: hostPackageArtifactId(outDir),
    inputs: hostPackageInputFiles(sourceDir, { root }),
    toolVersion: hostPackageToolVersion(),
  })
}

/** Artifact id of a host package directory: `desktop/dist/<basename>`. */
export function hostPackageArtifactId(outDir) {
  return 'desktop/dist/' + outDir.split(sep).pop()
}

/**
 * Read + validate the manifest shape; null manifest means "no manifest at all"
 * which callers report as stale (a stale build, never silently rebuilt).
 * @param {string} dir artifact directory.
 * @returns {{ manifest: object | null, problem: string }}
 */
export function readBuildManifest(dir) {
  const file = join(dir, BUILD_MANIFEST_FILE)
  if (!existsSync(file)) {
    return { manifest: null, problem: '缺少 ' + BUILD_MANIFEST_FILE + '（产物构建早于 G3 守卫，或产物是手工放置的）' }
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    return { manifest: null, problem: BUILD_MANIFEST_FILE + ' 不是合法 JSON：' + (error instanceof Error ? error.message : String(error)) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { manifest: null, problem: BUILD_MANIFEST_FILE + ' 不是对象' }
  }
  return { manifest: parsed, problem: '' }
}

/**
 * Compare an artifact directory against the current source tree.
 * @param {string} dir artifact directory (missing ⇒ status 'missing', not stale).
 * @param {{ artifactId: string, inputs: readonly {path: string, sha256: string, mtimeMs?: number}[], toolVersion: string, rebuildCommand: string }} expected
 * @returns {{ status: 'ok' | 'missing' | 'stale', problems: string[], manifest: object | null }}
 */
export function verifyBuildManifest(dir, { artifactId, inputs, toolVersion, rebuildCommand }) {
  if (!existsSync(dir)) {
    return { status: 'missing', problems: ['产物目录不存在：' + dir], manifest: null }
  }
  const { manifest, problem } = readBuildManifest(dir)
  if (manifest === null) return { status: 'stale', problems: [problem], manifest }
  const problems = []
  if (manifest.schemaVersion !== BUILD_MANIFEST_SCHEMA_VERSION) {
    problems.push('manifest schemaVersion=' + String(manifest.schemaVersion) + '，当前规则要求 ' + BUILD_MANIFEST_SCHEMA_VERSION)
  }
  if (manifest.artifactId !== artifactId) {
    problems.push('manifest artifactId=' + JSON.stringify(manifest.artifactId) + '，期望 ' + JSON.stringify(artifactId))
  }
  if (typeof manifest.toolVersion !== 'string' || manifest.toolVersion !== toolVersion) {
    problems.push('构建工具链不一致：manifest=' + JSON.stringify(manifest.toolVersion) + '，当前=' + JSON.stringify(toolVersion))
  }
  if (typeof manifest.inputsHash !== 'string' || manifest.inputsHash !== digestEntries(inputs)) {
    problems.push('输入摘要不一致（构建时 ' + String(manifest.inputsCount) + ' 个输入，当前 ' + String(inputs.length) + ' 个）' + diagnosticInputsNewer(manifest, inputs))
  }
  problems.push(...compareOutputs(dir, manifest))
  return { status: problems.length > 0 ? 'stale' : 'ok', problems, manifest }
}

/**
 * Name the inputs modified after the recorded build time (best-effort
 * diagnostics; mtimes survive almost every edit and a branch switch pushes
 * every touched file past builtAt).
 */
function diagnosticInputsNewer(manifest, inputs) {
  const builtAt = typeof manifest.builtAt === 'string' ? Date.parse(manifest.builtAt) : Number.NaN
  if (!Number.isFinite(builtAt)) return ''
  const newer = inputs
    .filter((entry) => typeof entry.mtimeMs === 'number' && entry.mtimeMs > builtAt)
    // The freshness gate's own typert class re-runs gen-typert-remotes and
    // restores the tree, so those files' mtimes are newer on every gate run
    // while their content is unchanged. Naming them would misdirect the
    // operator; the content digest still reports the drift.
    .filter((entry) => !entry.path.startsWith('packages/renderer/src/generated/'))
    // Newest first: when several inputs changed, naming the most recently
    // modified ones is both more useful to the operator and stable against the
    // millisecond-truncated `builtAt` (a file created in the same millisecond as
    // the manifest write also counts as "newer" and must not crowd the drift
    // out of the first-5 window).
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .map((entry) => entry.path)
    .slice(0, 5)
  if (newer.length === 0) return ''
  return '；构建后改动过的输入（前 5）：' + newer.join(', ')
}

/** Output-set + content comparison; returns problem strings. */
function compareOutputs(dir, manifest) {
  const problems = []
  if (!Array.isArray(manifest.outputs)) {
    problems.push('manifest 缺 outputs[]（无法判定产物集合）')
    return problems
  }
  const current = collectOutputFiles(dir)
  const currentByPath = new Map(current.map((entry) => [entry.path, entry]))
  const recordedByPath = new Map(manifest.outputs.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string').map((entry) => [entry.path, entry]))
  if (recordedByPath.size !== manifest.outputs.length) {
    problems.push('manifest outputs[] 含非法条目（' + manifest.outputs.length + ' 项中仅 ' + recordedByPath.size + ' 项可解析）')
  }
  const missing = [...recordedByPath.keys()].filter((path) => !currentByPath.has(path))
  const extra = [...currentByPath.keys()].filter((path) => !recordedByPath.has(path))
  const changed = [...recordedByPath.keys()].filter((path) => {
    const next = currentByPath.get(path)
    return next !== undefined && next.sha256 !== recordedByPath.get(path).sha256
  })
  if (missing.length > 0) problems.push('产物缺文件（前 5）：' + missing.slice(0, 5).join(', '))
  if (extra.length > 0) problems.push('产物多出文件（前 5）：' + extra.slice(0, 5).join(', '))
  if (changed.length > 0) problems.push('产物内容与构建时不一致（前 5）：' + changed.slice(0, 5).join(', '))
  return problems
}

/**
 * Pack-time / gate-time problem list: append the rebuild command to every
 * stale verdict (TODO D§2.3 — a red without a next step is a dead end).
 * @param {{ problems: readonly string[] }} verdict
 * @param {string} rebuildCommand
 * @returns {string}
 */
export function formatManifestVerdict(verdict, rebuildCommand) {
  return verdict.problems.join('；') + '（重建：' + rebuildCommand + '）'
}
