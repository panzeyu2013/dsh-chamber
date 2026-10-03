/**
 * Sidecar assembly resolution — ONE implementation for the three call sites:
 *   - scripts/gates/compiled-sidecar-smoke.mjs
 *   - scripts/gui-acceptance/native.mjs
 *   - scripts/gates/remote-state-acceptance.mjs
 *
 * Semantics: the bundled runtime counts only when it is a regular file (not a
 * directory/symlink-to-nowhere), and the env override accepts an absolute path
 * or one relative to the caller's cwd.
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
 * Bundled Node basename inside a sidecar assembly — the single source for
 * every Node-side consumer (build-sidecar, build-swift-app, the gates).
 *
 * Why not `node` (design 25 §4.3 A5, inverted): monitors attribute a process by
 * its executable basename, so a bundled runtime literally named `node` made
 * the control plane and every managed dsh host read as generic `node` rows
 * instead of app-owned processes. The runtime gate that accepts this name lives
 * in `packages/control-plane/src/spawn-dsh.ts` (a package source cannot import
 * a repo script) and `packages/desktop/scripts/build-sidecar.test.mjs` asserts
 * the two stay locked.
 */
export const BUNDLED_NODE_BASENAME = 'dsh-chamber-helper'

/**
 * Path of the bundled runtime in an assembly.
 * @param {string} sidecarDir - assembly directory.
 * @returns {string} absolute path of the bundled Node executable.
 */
export function bundledNodePath(sidecarDir) {
  return join(sidecarDir, BUNDLED_NODE_BASENAME)
}

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
 * Node binary for an assembly: its own bundled runtime
 * ({@link BUNDLED_NODE_BASENAME}) when that is a regular file (the shipped
 * shape), else the interpreter running the caller (CI builds with --skip-node).
 * @param {string} sidecarDir - assembly directory.
 * @param {string} execPath - current node executable.
 * @returns {string} node executable path.
 */
export function resolveNodeBinary(sidecarDir, execPath = process.execPath) {
  const bundled = bundledNodePath(sidecarDir)
  try {
    if (statSync(bundled).isFile()) return bundled
  } catch {
    /* no bundled node: fall through to the running interpreter */
  }
  return execPath
}
