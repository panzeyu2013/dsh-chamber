/**
 * Sidecar assembly resolution — ONE implementation for the three call sites
 * that used to resolve `packages/desktop/release/sidecar` and its bundled
 * `node` independently (P1-4 of the 13-scripts audit):
 *   - scripts/gates/compiled-sidecar-smoke.mjs
 *   - scripts/gui-acceptance/native.mjs
 *   - scripts/gates/remote-state-acceptance.mjs (used to hardcode an .app path)
 *
 * Semantics are the STRICTER of the old copies: the bundled `node` counts only
 * when it is a regular file (not a directory/symlink-to-nowhere), and the env
 * override accepts an absolute path or one relative to the caller's cwd.
 */
import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root derived from this file's location (scripts/lib/…). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Override for the assembly directory (CI builds into a job temp dir when needed). */
export const SIDECAR_DIR_ENV = 'DSH_CHAMBER_SIDECAR_DIR'

/** Build-sidecar's default output: the assembly the packaged Swift shell embeds. */
export const DEFAULT_SIDECAR_DIR = join(REPO_ROOT, 'packages', 'desktop', 'release', 'sidecar')

/**
 * Resolve the assembly directory: explicit env override (absolute or relative to
 * the caller's cwd), else the build-sidecar default output.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @param {string} cwd - base for relative overrides.
 * @returns {string} absolute assembly directory.
 */
export function resolveSidecarDir(env = process.env, cwd = process.cwd()) {
  const configured = typeof env[SIDECAR_DIR_ENV] === 'string' ? env[SIDECAR_DIR_ENV].trim() : ''
  if (configured !== '') return isAbsolute(configured) ? configured : resolve(cwd, configured)
  return DEFAULT_SIDECAR_DIR
}

/**
 * Node binary for an assembly: its own bundled `node` when that is a regular
 * file (the shipped shape), else the interpreter running the caller (CI builds
 * with --skip-node).
 * @param {string} sidecarDir - assembly directory.
 * @param {string} execPath - current node executable.
 * @returns {string} node executable path.
 */
export function resolveNodeBinary(sidecarDir, execPath = process.execPath) {
  const bundled = join(sidecarDir, 'node')
  try {
    if (statSync(bundled).isFile()) return bundled
  } catch {
    /* no bundled node: fall through to the running interpreter */
  }
  return execPath
}
