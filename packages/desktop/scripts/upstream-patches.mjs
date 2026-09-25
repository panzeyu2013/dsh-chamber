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
  return [...block.matchAll(/^ {2}'?([^':\n]+)'?: (patches\/[^\n]+)$/gmu)]
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

/**
 * Render the runtime work-dir pnpm-workspace.yaml: the supply-chain guard, the
 * allowBuilds block, the upstream patch set and the unused-patch waiver.
 * @param allowBuilds - indented allowBuilds lines (no trailing newline).
 * @param patchBlock - the verbatim upstream `patchedDependencies:` block.
 * @returns the file content.
 */
export function renderRuntimeWorkspace(allowBuilds, patchBlock) {
  return 'minimumReleaseAge: 0\nallowBuilds:\n' + allowBuilds + '\n' + patchBlock + 'allowUnusedPatches: true\n'
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