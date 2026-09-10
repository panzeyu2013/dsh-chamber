/**
 * Pure helpers for the C8 committed-artifact gate (design 09 §3.6 / C8).
 *
 * Extracted so the gate's decision logic is unit-testable: the gate script
 * itself is a top-level program (not importable), and its skip/fail semantics
 * are exactly where a silent pass can hide (2026-09 round-3 adversarial
 * review W4-01/W4-06/W4-07/W4-21).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Read every file under `dir` (recursively) into a relative-path → bytes map.
 * An unreadable file throws — the caller decides whether that is a gate
 * failure (it must never silently compare nothing).
 * @param {string} dir - directory to snapshot (may not exist).
 * @returns {Map<string, Buffer>} snapshot; empty when the directory is absent.
 */
export function snapshotDir(dir) {
  const files = new Map()
  const walk = (current, prefix) => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, rel)
      else files.set(rel, readFileSync(full))
    }
  }
  walk(dir, '')
  return files
}

/**
 * Restore a directory to a snapshot: write every snapshotted file back
 * verbatim and delete files that appeared since. Directories are left in place
 * (an empty leftover directory is harmless; a file is what the gate must not
 * leave behind).
 * @param {string} dir - directory to restore.
 * @param {Map<string, Buffer>} files - the snapshot.
 */
export function restoreDir(dir, files) {
  const present = new Set()
  const walk = (current, prefix) => {
    if (!existsSync(current)) return
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), rel)
      else present.add(rel)
    }
  }
  walk(dir, '')
  for (const rel of present) {
    if (!files.has(rel)) rmSync(join(dir, rel), { force: true })
  }
  for (const [rel, bytes] of files) {
    const target = join(dir, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
  }
}

/**
 * Compare a group's outputs against its pre-build snapshots.
 * @param {readonly string[]} outputs - repo-relative artifact paths.
 * @param {string} root - repository root.
 * @param {Map<string, Map<string, Buffer>>} snapshots - dir → snapshot.
 * @param {(abs: string, rel: string) => string} toRelative - abs artifact → dir-relative key.
 * @returns {string[]} outputs whose bytes are missing or changed.
 */
export function compareOutputs(outputs, root, snapshots, toRelative) {
  const stale = []
  for (const output of outputs) {
    const abs = join(root, output)
    if (!existsSync(abs)) {
      stale.push(`${output}（缺失）`)
      continue
    }
    const dir = dirname(abs)
    const original = snapshots.get(dir)?.get(toRelative(abs, dir))
    if (original === undefined || !readFileSync(abs).equals(original)) stale.push(output)
  }
  return stale
}

/**
 * Decide the gate outcome from its observations. A skipped build is a HARD
 * failure: the gate cannot prove freshness without running the build, and a
 * silent pass here is exactly the hole the 2026-09 review found (CI ran the
 * gate before `pnpm install`, so every group skipped and the gate still
 * reported success).
 * @param {{ stale: string[], skipped: string[] }} observations
 * @returns {{ ok: boolean, message?: string }}
 */
export function artifactGateVerdict({ stale, skipped }) {
  if (skipped.length > 0) {
    return {
      ok: false,
      message: `C8 无法重建产物（不能证明新鲜度）: ${skipped.join('; ')}`
        + ' — 先 pnpm install（esbuild 经 renderer 的 vite 树解析）；'
        + '确实无法构建时用 --no-artifact-rebuild 显式降级为 mtime advisory',
    }
  }
  if (stale.length > 0) {
    return {
      ok: false,
      message: `C8 提交态生成物与 src 不一致（重建后字节不同）: ${stale.join(', ')}`
        + ' — 跑 pnpm run build:host-packages / pnpm run build:dsh-runtime / '
        + 'node packages/dsh-chamber-client-ui-mobile/scripts/build.mjs 后提交',
    }
  }
  return { ok: true }
}
