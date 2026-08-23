/**
 * dsh runtime installer (design 16 §4) — the runtime npm install pipeline.
 *
 * Replays the build-time `bundle-dsh.mjs` semantics at runtime: download is
 * delegated to pnpm (the shell never downloads the top-level tarball twice,
 * R3-2 F24); the pipeline is
 *
 *   write work dir (package.json + pnpm-workspace.yaml with allowBuilds) →
 *   `pnpm install` (hoisted + store-dir + registry + no-notifier + no-retry) →
 *   prune (prune-runtime semantics) → smoke (`bin.js --version` == target) →
 *   manifest (dependencies + dsh.platform) → atomic publish to <baseDir>/<ver>
 *
 * All external side effects (node resolution / process run / prune / smoke)
 * are injectable so the unit tests mock every spawn — the tests never reach a
 * real pnpm or a real install. The defaults run in the Electron main process
 * (resolveNodeExecutable, ELECTRON_RUN_AS_NODE=1) or plain node.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { assertSafeVersion } from './version-safety.ts'
import { ALLOW_BUILDS } from './allow-builds.mjs'
import { sanitizeErrorText } from './sanitize-error.ts'
import { resolveNodeExecutable } from '@dsh-chamber/control-plane'

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface PruneResult {
  removedFiles: number
  removedDirs: number
}

export interface InstallerDeps {
  /** Node executable used to run pnpm + the smoke check. */
  node: () => { file: string; args: string[]; env: Record<string, string> }
  /** Spawn a command to completion. */
  run: (args: string[], opts: { cwd: string; env?: Record<string, string> }) => Promise<RunResult>
  /** Prune the installed tree (prune-runtime semantics, design 16 §4). */
  prune: (root: string) => Promise<PruneResult>
  /** Smoke: assert the installed CLI reports exactly `version`. */
  smoke: (workDir: string, version: string) => Promise<void>
}

export interface InstallOptions {
  /** `<userData>/dsh-runtime` — version trees, store and work dirs live here. */
  baseDir: string
  /** Exact version to install (asserted safe before any path use). */
  version: string
  /** User-selected registry origin (default npmjs; mirrors allowed, §6). */
  registryOrigin: string
  /** Path to `pnpm.cjs` (embedded pnpm; resolved by the caller for dev vs packaged). */
  pnpmEntry: string
  deps?: Partial<InstallerDeps>
}

export interface InstallResult {
  versionTreeDir: string
  resolvedVersion: string
}

/** Env whitelist for the install subprocess (design 16 §4 R3-2 F1 source
 *  pinning): only the vars pnpm/network need pass through; everything else —
 *  especially npm_config_* (npm_config_proxy / npm_config_strict_ssl are a
 *  MITM surface) and secrets (SSH_AUTH_SOCK, cloud credentials, git tokens) —
 *  is scrubbed so the install subprocess can never inherit it. */
const INSTALL_ENV_WHITELIST = /^(PATH|HOME|XDG_CACHE_HOME|HTTP_PROXY|HTTPS_PROXY|NO_PROXY)$/

export function scrubInstallEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (INSTALL_ENV_WHITELIST.test(key) && value !== undefined) out[key] = value
  }
  return out
}

/** Real process spawn (default `run`). */
function defaultRun(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [file, ...rest] = args
    const child = spawn(file, rest, {
      cwd: opts.cwd,
      // Scrub the inherited env (secrets stay out of the subprocess); the
      // trusted opts.env (node.env + NPM_CONFIG_USERCONFIG) is layered on top.
      env: { ...scrubInstallEnv(process.env), ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ status: code, stdout, stderr }))
  })
}

/** Default prune — the build-time prune-runtime logic, loaded lazily (the .mjs
 *  sits in scripts/ which is excluded from `files`; the runtime installer's
 *  compiled prune copy is the follow-up that swaps this default, design 16 §4). */
async function defaultPrune(root: string): Promise<PruneResult> {
  const mod = await import('./prune-runtime.mjs') as { pruneRuntimeArtifacts: (r: string) => PruneResult }
  return mod.pruneRuntimeArtifacts(root)
}

/** Default smoke — run the installed CLI `--version` and require an exact match. */
async function defaultSmoke(node: () => { file: string; args: string[]; env: Record<string, string> }, run: InstallerDeps['run'], workDir: string, version: string): Promise<void> {
  const n = node()
  const bin = join(workDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const res = await run([n.file, ...n.args, bin, '--version'], { cwd: workDir, env: n.env })
  if (res.status !== 0 || res.stdout.trim() !== version) {
    const detail = sanitizeErrorText((res.stderr || res.stdout).trim()).slice(0, 500)
    throw new Error(`dsh smoke check failed (exit ${res.status}, want ${version}): ${detail}`)
  }
}

export async function installRuntimeVersion(opts: InstallOptions): Promise<InstallResult> {
  const version = assertSafeVersion(opts.version)
  // Layout must match dsh-runtime-store's runtimeDirPath (§3.2): version trees
  // and all transient install dirs live under <baseDir>/dsh-runtime/.
  const runtimeDir = join(opts.baseDir, 'dsh-runtime')
  mkdirSync(runtimeDir, { recursive: true })

  const nodeFn = opts.deps?.node ?? resolveNodeExecutable
  const runFn = opts.deps?.run ?? defaultRun
  const pruneFn = opts.deps?.prune ?? defaultPrune
  const smokeFn = opts.deps?.smoke ?? ((workDir: string, ver: string) => defaultSmoke(nodeFn, runFn, workDir, ver))

  const workDir = join(runtimeDir, `.work-${randomBytes(4).toString('hex')}`)
  const storeDir = join(runtimeDir, '.pnpm-store')
  const cacheDir = join(runtimeDir, '.pnpm-cache')
  // Source pinning (design 16 §4 R3-2 F1): point pnpm at a shell-managed empty
  // npmrc so the user's ~/.npmrc can never drift the registry.
  const npmrc = join(runtimeDir, '.npmrc')

  mkdirSync(workDir, { recursive: true })
  // Record the owning pid (§4 R3-2 F21): startup cleanup removes a stale
  // `.work-*` left by a hard-killed install (pid no longer alive).
  writeFileSync(join(workDir, 'pid'), String(process.pid))
  writeFileSync(npmrc, '')

  // The work dir must carry pnpm-workspace.yaml BEFORE pnpm runs (a fully
  // missing allowBuilds config hard-fails pnpm) and must only ever write
  // `true` (an explicit `false` silently skips build scripts, breaking
  // fail-safe) — design 16 §4 R3-2 F6/F7.
  writeFileSync(join(workDir, 'package.json'), `${JSON.stringify({
    name: 'dsh-runtime-install',
    version: '0.0.0',
    private: true,
    dependencies: { '@deepseek-ai/dsh': version },
  }, null, 2)}\n`)
  writeFileSync(join(workDir, 'pnpm-workspace.yaml'), `minimumReleaseAge: 0\nallowBuilds:\n${ALLOW_BUILDS.map((name) => `  ${JSON.stringify(name)}: true`).join('\n')}\n`)

  const node = nodeFn()
  const installArgs = [
    node.file, ...node.args, opts.pnpmEntry, 'install',
    '--config.node-linker=hoisted',
    '--store-dir', storeDir,
    '--cache-dir', cacheDir,
    '--registry', opts.registryOrigin,
    // `--no-update-notifier` is NOT a pnpm 11 option (removed upstream; real-
    // install test confirmed "Unknown option: 'update-notifier'") — dropped.
    '--fetch-retries=0',
  ]
  const installEnv = { ...node.env, NPM_CONFIG_USERCONFIG: npmrc }

  try {
    let res = await runFn(installArgs, { cwd: workDir, env: installEnv })
    if (res.status !== 0) {
      // Retry once (design 16 §4 R3-2 F8): transient koffi optional-dep
      // download failures fall back to a source build and can fail once.
      res = await runFn(installArgs, { cwd: workDir, env: installEnv })
    }
    if (res.status !== 0) {
      const detail = sanitizeErrorText((res.stderr || res.stdout).trim()).slice(0, 800)
      throw new Error(`dsh runtime install failed (exit ${res.status}): ${detail}`)
    }

    await pruneFn(workDir)
    await smokeFn(workDir, version)

    // The installed dependency is pinned exactly (dependencies = {version}),
    // and smoke just confirmed the CLI reports that same version.
    const resolvedVersion = version
    const manifest = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8'))
    manifest.dependencies = { '@deepseek-ai/dsh': resolvedVersion }
    manifest.dsh = { platform: `${process.platform}-${process.arch}` }
    writeFileSync(join(workDir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    // Atomic publish: prune + smoke done BEFORE the tree becomes visible; a
    // half-finished work dir is never published as an installed version
    // (design 16 §4 R3-2 F15).
    const versionTreeDir = join(runtimeDir, version)
    rmSync(versionTreeDir, { recursive: true, force: true })
    rmSync(join(workDir, 'pid'), { force: true }) // pid marker must not land in the tree
    renameSync(workDir, versionTreeDir)
    return { versionTreeDir, resolvedVersion }
  } finally {
    // Residual cleanup: no-op after a successful rename, removes the work dir
    // on any failure path (design 16 §4).
    rmSync(workDir, { recursive: true, force: true })
  }
}
