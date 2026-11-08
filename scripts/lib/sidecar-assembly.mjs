/**
 * Sidecar assembly resolution — ONE implementation for the call sites:
 *   - scripts/gates/checks/compiled-sidecar-smoke.mjs
 *   - scripts/gui-acceptance/drivers/native.mjs
 *   - scripts/gates/checks/remote-state-acceptance.mjs
 *   - macos/scripts/build-swift-app.mjs / packages/desktop/scripts/build-sidecar.mjs
 *
 * Semantics: the assembly's single Node lives INSIDE the primary-runtime payload
 * (`<sidecar>/primary-runtime/dependencies/{node,pnpm,python}`, design 25 §3.2 /
 * swift-impl-contract)：没有独立的 `dsh-chamber-helper` 了——Swift 用
 * `<payload node> <sidecar>/sidecar.js` 启动侧车，托管 dsh 使用同一个
 * process.execPath。运行时二进制只在它是普通文件时才算数（不是目录/悬空链接）；
 * dev 与 `build:sidecar --skip-node` 的 CI 装配继续使用调用者自己的 node。
 *
 * 归因（design 25 §4.3 A5，随「单 Node」裁决再反转）：payload 里的可执行文件
 * 就叫 `node`（不重命名），监控按**应用派生的子进程关系**归属，而不再依赖特制
 * 基名；`packages/control-plane/src/spawn-dsh.ts` 的 bundled-runtime 分支对
 * `node`/`node.exe` 直用 process.execPath 正是为这个形状保留的。
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
 * 装配内唯一 Node 的相对路径（primary-runtime payload 的 dependencies/node，
 * 与 prepare-python-payload 的 `--with-node` 落位同源）。
 */
export const PAYLOAD_NODE_RELATIVE = join('primary-runtime', 'dependencies', 'node', 'bin', 'node')

/**
 * payload Node 的基名 = `node`（单 Node 裁决不重命名；进程名即 node，归因靠
 * 应用派生的子进程关系，见文件头与 design 25 §4.3 A5）。
 */
export const PAYLOAD_NODE_BASENAME = 'node'

/**
 * Path of the assembly's single Node executable.
 * @param {string} sidecarDir - assembly directory.
 * @returns {string} absolute path of the payload Node executable.
 */
export function payloadNodePath(sidecarDir) {
  return join(sidecarDir, PAYLOAD_NODE_RELATIVE)
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
 * Node binary for an assembly: the payload Node ({@link payloadNodePath}) when
 * that is a regular file (the shipped shape), else the interpreter running the
 * caller (dev / CI builds made with `build:sidecar --skip-node`).
 * @param {string} sidecarDir - assembly directory.
 * @param {string} execPath - current node executable.
 * @returns {string} node executable path.
 */
export function resolveNodeBinary(sidecarDir, execPath = process.execPath) {
  const payload = payloadNodePath(sidecarDir)
  try {
    if (statSync(payload).isFile()) return payload
  } catch {
    /* no payload node: fall through to the running interpreter */
  }
  return execPath
}
