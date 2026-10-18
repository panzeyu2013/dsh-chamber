/**
 * Upstream pnpm patch channel staging (upgrade plan §17-C / §22.0-2).
 *
 * The vendor pin carries `patchedDependencies` + `patches/*` in its own
 * pnpm-workspace.yaml (node-pty's DSH_NODE_PTY_SPAWN_HELPER, pi-ai's streaming
 * fix, exceljs / fortune-sheet / @electron/osx-sign / @yao-pkg/pkg). The
 * bundled runtime is installed from `packages/desktop/vendor/dsh/pnpm-lock.yaml`
 * in a scratch work dir, so without this module the packaged runtime would
 * silently install UNPATCHED dependencies — the upstream fixes would exist only
 * in an upstream checkout.
 *
 * This module is the single source for both halves: the verbatim
 * `patchedDependencies:` block and the patch files staged next to the generated
 * pnpm-workspace.yaml. Both are read from the PINNED vendor tree (never from a
 * chamber copy), so a pin upgrade moves them in one place, and
 * `upstream-patches.test.mjs` fails when the vendor shape — or the committed
 * runtime lockfile — no longer matches.
 *
 * `allowUnusedPatches` is deliberate: the runtime closure uses only a subset of
 * the upstream set (the rest belong to the upstream dev/build graph), and pnpm
 * otherwise refuses the install with ERR_PNPM_UNUSED_PATCH. The lockfile still
 * records every entry, and every in-graph package resolves with its patch_hash.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, derived from this file (`packages/desktop/scripts/...`). */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

/** The pinned upstream workspace file that owns the patch set. */
export const VENDOR_WORKSPACE = join(REPO_ROOT, 'vendor', 'harness-checkout', 'pnpm-workspace.yaml')

/** The pinned upstream patch directory (the bytes the runtime install applies). */
export const VENDOR_PATCHES = join(REPO_ROOT, 'vendor', 'harness-checkout', 'patches')

/** Committed runtime lockfile — the install face that must record the patch set. */
export const RUNTIME_LOCKFILE = join(REPO_ROOT, 'packages', 'desktop', 'vendor', 'dsh', 'pnpm-lock.yaml')

const PATCH_BLOCK = /^patchedDependencies:\n(?: {2}.*\n)+/mu

/**
 * The upstream `patchedDependencies:` block, verbatim (including its trailing
 * newline).
 * @param workspacePath - override for tests.
 * @returns the YAML block.
 */
export function upstreamPatchedDependencies(workspacePath = VENDOR_WORKSPACE) {
  let text
  try {
    text = readFileSync(workspacePath, 'utf8')
  } catch (error) {
    throw new Error(
      '[upstream-patches] 读不到上游 patch 源 ' + workspacePath + '：'
      + (error instanceof Error ? error.message : String(error))
      + '（先跑 ensure-harness-vendor）',
    )
  }
  const match = PATCH_BLOCK.exec(text)
  if (match === null) {
    throw new Error('[upstream-patches] ' + workspacePath + ' 没有 patchedDependencies 块——上游 patch 集合变化必须显式处理（§17-C）')
  }
  return match[0]
}

/**
 * The `specifier: patches/file.patch` pairs of one block (source order).
 * @param block - a `patchedDependencies:` block.
 * @returns {{ spec: string, file: string }[]}.
 */
export function parsePatchedDependencies(block) {
  return [...block.matchAll(/^ {2}["']?([^"':\n]+)["']?: (patches\/[^\n]+)$/gmu)]
    .map(match => ({ spec: match[1], file: match[2] }))
}

/**
 * Patch file names in one patch directory (sorted).
 * @param patchesDir - override for tests.
 * @returns {string[]}.
 */
export function upstreamPatchFiles(patchesDir = VENDOR_PATCHES) {
  return readdirSync(patchesDir).filter(name => name.endsWith('.patch')).sort()
}

/** Split a `name@version` patch specifier; patch keys must carry an exact version to pin. */
function specName(spec) {
  const at = spec.lastIndexOf('@')
  if (at <= 0) throw new Error('[upstream-patches] 补丁键必须带精确版本（否则无法派生 override）：' + spec)
  const name = spec.slice(0, at)
  const version = spec.slice(at + 1)
  if (!/^(@[^/@]+\/)?[^@/\s]+$/u.test(name) || version === '') {
    throw new Error('[upstream-patches] 补丁键形状非法（name@version）：' + spec)
  }
  return { name, version }
}

/** Escape one literal for a RegExp source. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^$+?{}()|[\]\\]/gu, '\\$&')
}

/**
 * The resolution pins derived from one patch block: every patched dependency
 * resolves to the version its patch was built for. pnpm matches a versioned
 * patch key exactly; a range that floats past it leaves the patch unused.
 * @param block - a `patchedDependencies:` block.
 * @returns {{ name: string, version: string }[]} in source order.
 */
export function patchOverrides(block) {
  const overrides = parsePatchedDependencies(block).map(({ spec }) => specName(spec))
  const seen = new Set()
  for (const { name } of overrides) {
    // One override key cannot pin two versions of the same package; pnpm would
    // reject the duplicated YAML key later with a less direct message.
    if (seen.has(name)) throw new Error('[upstream-patches] 同一包出现多个补丁版本，无法派生唯一 override：' + name)
    seen.add(name)
  }
  return overrides
}

/**
 * Render the runtime work-dir pnpm-workspace.yaml: the supply-chain guard, the
 * patch-version overrides, the allowBuilds block, the upstream patch set and the
 * unused-patch waiver.
 * @param allowBuilds - indented allowBuilds lines (no trailing newline).
 * @param patchBlock - the verbatim upstream `patchedDependencies:` block.
 * @returns the file content.
 */
export function renderRuntimeWorkspace(allowBuilds, patchBlock) {
  const overrides = patchOverrides(patchBlock)
    .map(({ name, version }) => "  '" + name + "': " + version + '\n')
    .join('')
  return 'minimumReleaseAge: 0\noverrides:\n' + overrides
    + 'allowBuilds:\n' + allowBuilds + '\n' + patchBlock + 'allowUnusedPatches: true\n'
}

/**
 * Fail loud when a patched dependency is present in the install graph but its
 * patch did not resolve (pnpm reduces that to a warning under
 * `allowUnusedPatches`). In-graph detection is derived from the lock
 * itself, so a stale `runtimeClosure` flag cannot hide it.
 * @param lockText - one pnpm-lock.yaml.
 * @param block - the same patch block the lock was generated against.
 * @param label - lock identity for the error message.
 * @throws when a patched package resolves in-graph without its patch_hash.
 */
export function assertPatchesApplied(lockText, block, label) {
  const top = /^patchedDependencies:\n(?: {2}.*\n)+/mu.exec(lockText)?.[0]
  if (top === undefined) throw new Error('[upstream-patches] ' + label + ' 缺少 patchedDependencies 块（§17-C）')
  const hashes = new Map(
    [...top.matchAll(/^ {2}["']?([^"':\n]+)["']?: ([0-9a-f]{64})$/gmu)].map(match => [match[1], match[2]]),
  )
  const body = lockText.replace(top, '')
  for (const { spec } of parsePatchedDependencies(block)) {
    const { name } = specName(spec)
    if (!new RegExp("^ {2}[\"']?" + escapeRegExp(name) + '@', 'mu').test(body)) continue
    const hash = hashes.get(spec)
    if (hash === undefined || !lockText.includes(spec + '(patch_hash=' + hash + ')')) {
      throw new Error('[upstream-patches] ' + label + ': ' + name
        + ' 在图内但补丁未生效（' + spec + ' 的 patch_hash 不在 snapshot 键）——拒绝继续（§17-C）')
    }
  }
}

/**
 * Stage the pinned patch files into a work dir (`<work>/patches/*.patch`).
 * @param workDir - the bundler's scratch dir.
 * @param patchesDir - override for tests.
 * @returns {{ files: number, entries: number }}.
 */
export function stageUpstreamPatches(workDir, patchesDir = VENDOR_PATCHES) {
  const files = upstreamPatchFiles(patchesDir)
  const target = join(workDir, 'patches')
  mkdirSync(target, { recursive: true })
  for (const name of files) copyFileSync(join(patchesDir, name), join(target, name))
  return { files: files.length, entries: parsePatchedDependencies(upstreamPatchedDependencies()).length }
}