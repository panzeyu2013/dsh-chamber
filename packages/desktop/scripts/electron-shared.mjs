#!/usr/bin/env node
/**
 * Shared Electron dist bootstrap (multi-worktree parallel dev, 2026-09).
 *
 * Problem: every git worktree used for parallel desktop development used to
 * materialize its own ~300MB Electron binary into its own pnpm virtual-store
 * electron package dir (node_modules/.pnpm/…/electron/dist) on the first dev
 * run (electron@43.x ships no postinstall, so nothing downloads at install
 * time; the dev launcher self-healed per worktree). With N worktrees that is
 * N downloads/extractions of byte-identical content — electron is pinned
 * exactly (e.g. 43.4.0), so the artifact is identical across worktrees and
 * branches.
 *
 * This module keeps ONE dist per machine per electron version/platform/arch
 * under the platform cache dir and hands its executable to every worktree:
 *
 *   darwin: ~/Library/Caches/dsh-chamber/electron/v<version>-<platform>-<arch>/
 *   linux : $XDG_CACHE_HOME|~/.cache/dsh-chamber/electron/v<version>-<platform>-<arch>/
 *   win32 : %LOCALAPPDATA%\dsh-chamber\Cache\electron\v<version>-<platform>-<arch>\
 *
 * Keying the dir by version+platform+arch means an arch switch (e.g. a
 * Rosetta toggle) never deletes a dist another running dev instance may still
 * be using — each (version, platform, arch) triple has its own dir, and the
 * marker file only guards against corruption/stale writes.
 *
 * The zip download itself is cached by electron's own @electron/get
 * (~/Library/Caches/electron on macOS), so wiping the shared dist does not
 * re-download.
 *
 * Consumers:
 *   - packages/desktop/scripts/electron-dev.mjs (dev launcher, auto-ensure);
 *   - scripts/dev/ensure-electron.mjs (root postinstall, gated by
 *     DSH_CHAMBER_ELECTRON=1).
 * The old per-worktree node_modules/electron/dist (pre-shared flow) is no
 * longer created by either, but is still reused automatically when present
 * (status 'legacy') — offline machines that already materialized a local dist
 * keep working without any download. `require('electron')` under plain node
 * no longer self-heals; the dev launcher never calls it anymore (it spawns
 * the resolved executable directly). DSH_CHAMBER_ELECTRON_DIST remains the
 * explicit escape hatch for any existing dist dir.
 *
 * Env:
 *   DSH_CHAMBER_ELECTRON_DIST         — absolute path to an existing full
 *                                       dist dir; used as-is (no download, no
 *                                       cache write).
 *   DSH_CHAMBER_ELECTRON_CACHE_ROOT   — override the cache root (hermetic
 *                                       tests / unusual setups).
 *   DSH_CHAMBER_ELECTRON_PKG_DIR      — override the electron npm package dir
 *                                       (hermetic tests only).
 *   ELECTRON_MIRROR (or .npmrc electron_mirror) — binary download mirror.
 *
 * Only node builtins + the electron package's own dependencies (@electron/get,
 * @electron-internal/extract-zip) are used — no new dependencies.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const ELECTRON_DIST_ENV = 'DSH_CHAMBER_ELECTRON_DIST'
export const ELECTRON_CACHE_ROOT_ENV = 'DSH_CHAMBER_ELECTRON_CACHE_ROOT'
export const ELECTRON_PKG_DIR_ENV = 'DSH_CHAMBER_ELECTRON_PKG_DIR'
/** Freshness marker written inside the shared dist dir. */
export const DIST_META_FILE = '.electron-dist.json'
/** Stale tmp-sibling cleanup threshold (crashed materializations leave ~300MB
 * `${distDir}.tmp-*` orphans; younger dirs may belong to a concurrent run). */
const TMP_STALE_MS = 60 * 60 * 1000

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..', '..')

/** The platform executable path relative to a dist dir (install.js parity). */
export function platformExecutableName(platform = process.platform) {
  switch (platform) {
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'win32':
      return 'electron.exe'
    case 'linux':
      return 'electron'
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`)
  }
}

/**
 * Platform cache root for the shared dist. ELECTRON_CACHE_ROOT_ENV wins when
 * set (hermetic tests); otherwise env-paths-style platform cache dirs.
 */
export function resolveCacheRoot(platform = process.platform, env = process.env, home = os.homedir()) {
  const override = env[ELECTRON_CACHE_ROOT_ENV]
  if (override !== undefined && override !== '') return override
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'dsh-chamber')
  if (platform === 'linux') {
    const xdg = env.XDG_CACHE_HOME
    return xdg !== undefined && xdg !== '' ? path.join(xdg, 'dsh-chamber') : path.join(home, '.cache', 'dsh-chamber')
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA
    return local !== undefined && local !== ''
      ? path.join(local, 'dsh-chamber', 'Cache')
      : path.join(home, 'AppData', 'Local', 'dsh-chamber', 'Cache')
  }
  throw new Error(`no cache root for platform: ${platform}`)
}

/**
 * Versioned shared dist dir: <cacheRoot>/electron/v<version>-<platform>-<arch>.
 * Platform+arch in the key: an arch switch never deletes a dist that another
 * running dev instance may still be using.
 */
export function sharedDistDirFor(version, opts = {}) {
  const { platform = process.platform, arch = effectiveDownloadArch(), env = process.env, home = os.homedir() } = opts
  return path.join(resolveCacheRoot(platform, env, home), 'electron', `v${version}-${platform}-${arch}`)
}

/**
 * Download arch for the current machine. Mirrors electron's install.js: under
 * Rosetta a darwin x64 node must fetch the arm64 build.
 */
export function effectiveDownloadArch() {
  if (process.platform === 'darwin' && process.arch === 'x64') {
    try {
      const out = spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' })
      if (out.status === 0 && out.stdout.trim() === '1') return 'arm64'
    } catch {
      // sysctl unavailable → keep x64
    }
  }
  return process.arch
}

/** The electron npm package dir (the package ships without the binary). */
export function resolveElectronPackageDir(env = process.env) {
  const override = env[ELECTRON_PKG_DIR_ENV]
  if (override !== undefined && override !== '') return override
  for (const candidate of [
    path.join(REPO_ROOT, 'packages', 'desktop', 'node_modules', 'electron'),
    path.join(REPO_ROOT, 'node_modules', 'electron'),
  ]) {
    if (existsSync(path.join(candidate, 'package.json'))) return candidate
  }
  return null
}

/** Marker read; null when absent/unreadable/corrupt (corrupt → re-materialize). */
export function readDistMeta(distDir) {
  const file = path.join(distDir, DIST_META_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** A dist dir is reusable when its marker matches version/platform/arch and
 * the platform executable is present. */
export function distIsUsable(distDir, version, platform, arch) {
  const meta = readDistMeta(distDir)
  if (meta === null || meta.version !== version || meta.platform !== platform || meta.arch !== arch) return false
  return existsSync(path.join(distDir, platformExecutableName(platform)))
}

/** .npmrc electron_mirror (repo-root), mirroring ensure-electron's parsing. */
function readNpmrcElectronMirror() {
  const npmrc = path.join(REPO_ROOT, '.npmrc')
  if (!existsSync(npmrc)) return null
  for (const line of readFileSync(npmrc, 'utf8').split('\n')) {
    const m = /^\s*electron_mirror\s*=\s*(\S+)\s*$/.exec(line)
    if (m !== null) return m[1]
  }
  return null
}

/**
 * Ensure a usable dist and return { distDir, status } where status is
 * 'override' | 'legacy' | 'cached' | 'installed'. Never touches the network
 * on the override/legacy/cached paths.
 */
export async function ensureSharedElectronDist(env = process.env) {
  const override = env[ELECTRON_DIST_ENV]
  if (override !== undefined && override !== '') {
    const executable = path.join(override, platformExecutableName())
    if (!existsSync(executable)) {
      throw new Error(
        `${ELECTRON_DIST_ENV}=${override} 下不存在可执行文件 ${platformExecutableName()}（须指向完整 Electron dist 目录）`,
      )
    }
    return { distDir: override, status: 'override' }
  }

  const pkgDir = resolveElectronPackageDir(env)
  if (pkgDir === null) {
    throw new Error(
      '未找到 electron npm 包（packages/desktop/node_modules/electron 或 node_modules/electron）— 请先 pnpm install',
    )
  }
  const version = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version
  const platform = process.platform
  const arch = effectiveDownloadArch()
  const distDir = sharedDistDirFor(version, { env })

  if (distIsUsable(distDir, version, platform, arch)) {
    return { distDir, status: 'cached' }
  }

  // Legacy local dist from the pre-shared flow (the electron package dir's own
  // dist/, version file matching): reuse it as-is — offline machines that
  // already materialized once keep working without any download. It is not
  // copied into the shared cache; the next shared materialization supersedes
  // it. (Old flow also wrote path.txt; the launcher spawns the resolved
  // executable directly and never needs it.)
  const legacyDist = path.join(pkgDir, 'dist')
  const legacyVersionFile = path.join(legacyDist, 'version')
  if (
    existsSync(legacyVersionFile)
    && readFileSync(legacyVersionFile, 'utf8').trim().replace(/^v/, '') === version
    && existsSync(path.join(legacyDist, platformExecutableName(platform)))
  ) {
    return { distDir: legacyDist, status: 'legacy' }
  }

  // Shared dir present but unusable (corrupt marker / stale write): clear it
  // before re-materializing. Readers never observe a half-written dir —
  // publication is the atomic tmp+rename below, and the version-platform-arch
  // key means this never touches a dir another running instance uses.
  if (existsSync(distDir)) {
    rmSync(distDir, { recursive: true, force: true })
  }

  // Materialize into the shared dir via a unique tmp dir + atomic rename:
  // parallel first dev runs (two worktrees on one machine) must never extract
  // into the same half-written dir. The download zip is cached by electron's
  // own @electron/get, so a wiped shared dist re-extracts without network.
  // createRequire must root at the REAL package dir: pnpm exposes electron as
  // a symlink (packages/desktop/node_modules/electron → .pnpm/...), and
  // module resolution from the symlink path misses the package's own
  // dependencies (@electron/get, @electron-internal/extract-zip) that live
  // beside it in the virtual store.
  const realPkgDir = realpathSync(pkgDir)
  const require = createRequire(path.join(realPkgDir, 'package.json'))
  const { downloadArtifact } = require('@electron/get')
  const { extract } = require('@electron-internal/extract-zip')
  if (process.env.ELECTRON_MIRROR === undefined) {
    const mirror = readNpmrcElectronMirror()
    if (mirror !== null) process.env.ELECTRON_MIRROR = mirror
  }
  const checksums = require(path.join(pkgDir, 'checksums.json'))
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    platform,
    arch,
    checksums,
  })

  // Sweep stale tmp siblings left by crashed materializations (~300MB each).
  // Young dirs are kept — a concurrent process may be actively extracting.
  const tmpPrefix = `${distDir}.tmp-`
  try {
    for (const entry of readdirSync(path.dirname(distDir))) {
      if (!entry.startsWith(tmpPrefix)) continue
      const stale = path.join(path.dirname(distDir), entry)
      try {
        if (Date.now() - statSync(stale).mtimeMs > TMP_STALE_MS) {
          rmSync(stale, { recursive: true, force: true })
        }
      } catch {
        // raced or already gone
      }
    }
  } catch {
    // parent dir missing — nothing to sweep
  }

  const tmpDir = `${distDir}.tmp-${process.pid}-${Date.now().toString(36)}`
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
  try {
    await extract(zipPath, { dir: tmpDir })
    writeFileSync(path.join(tmpDir, DIST_META_FILE), `${JSON.stringify({ version, platform, arch })}\n`)
    const executable = path.join(tmpDir, platformExecutableName(platform))
    if (!existsSync(executable)) {
      throw new Error(`Electron 解压后缺少可执行文件 ${executable}（zip 损坏或平台不匹配，可清除缓存后重试）`)
    }
    try {
      renameSync(tmpDir, distDir)
    } catch (renameError) {
      // A concurrent process won the race and published distDir first.
      if (distIsUsable(distDir, version, platform, arch)) {
        return { distDir, status: 'cached' }
      }
      throw renameError
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
  return { distDir, status: 'installed' }
}
