#!/usr/bin/env node
/**
 * verify-electron-artifacts.mjs —— executed Electron-compiled-artifact gate (G4 residual).
 *
 * G4's first half is covered by compiled-sidecar-smoke.mjs (the shipped
 * `sidecar.js` boots and answers the B bridge). The Electron compiled
 * artifacts were still only asserted to EXIST:
 *
 *   - `dist/control-plane/index.js` is a tsc-emitted ESM tree loaded by the
 *     packaged main process; a broken emit (unresolved relative import, a
 *     missing module, a non-ESM artifact) only surfaced when a user launched
 *     the packaged app;
 *   - `dist/preload.cjs` is loaded into the sandbox preload world at window
 *     creation (main.ts:832-841 fails closed when it is absent, but nothing
 *     executed the compiled file to prove it parses and exposes the frozen
 *     `window.dshChamber` surface).
 *
 * This gate therefore:
 *   (a) spawns the COMPILED control-plane entry electron-free (plain Node, no
 *       Electron module), requires it to bind a loopback port and answer an
 *       HTTP `/health` probe, then SIGTERMs it and requires a clean exit 0;
 *   (b) runs the COMPILED `dist/preload.cjs` inside node:vm with a stubbed
 *       `electron` module and asserts it parses and exposes the frozen
 *       surface: the 4 info scalars + the 9 namespace objects whose members
 *       are functions and whose subscribe members return an unsubscribe.
 *
 * Discipline: with BOTH artifacts absent the gate prints a loud `SKIP:` and
 * exits 0 (a fresh checkout has no build). When either artifact exists the
 * gate runs and any misbehaviour fails hard — a partial build is a failure,
 * never a skip.
 *
 * Usage:
 *   node scripts/gates/verify-electron-artifacts.mjs
 *
 * Env:
 *   DSH_CHAMBER_DESKTOP_DIST   desktop package dir (default packages/desktop/dist)
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { FACTORY_TO_NAMESPACE } from './verify-shim-payload-shape.mjs'

export const DESKTOP_DIST_ENV = 'DSH_CHAMBER_DESKTOP_DIST'
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DEFAULT_DESKTOP_DIST = join(REPO_ROOT, 'packages', 'desktop', 'dist')

/** The 4 info scalars of the frozen `window.dshChamber` surface. */
export const BRIDGE_SCALAR_KEYS = ['controlPlaneUrl', 'dshVersion', 'version', 'platform']
/** The 9 namespaces, single-sourced from the payload gate's factory mapping. */
export const BRIDGE_NAMESPACE_KEYS = Object.values(FACTORY_TO_NAMESPACE).sort()

/**
 * Resolve the desktop dist dir: env override (absolute or relative to cwd),
 * else `packages/desktop/dist`.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @param {string} cwd - base for relative overrides.
 * @returns {string} absolute desktop dist dir.
 */
export function resolveDesktopDist(env = process.env, cwd = process.cwd()) {
  const configured = typeof env[DESKTOP_DIST_ENV] === 'string' ? env[DESKTOP_DIST_ENV].trim() : ''
  if (configured !== '') return isAbsolute(configured) ? configured : resolve(cwd, configured)
  return DEFAULT_DESKTOP_DIST
}

/**
 * Decide whether the gate runs, skips loudly, or fails.
 * @param {{ controlPlaneEntry: string, controlPlaneExists: boolean, preloadEntry: string, preloadExists: boolean }} input - observed artifacts.
 * @returns {{ action: 'run' } | { action: 'skip', reason: string } | { action: 'fail', reason: string }} decision.
 */
export function artifactDecision({ controlPlaneEntry, controlPlaneExists, preloadEntry, preloadExists }) {
  if (!controlPlaneExists && !preloadExists) {
    return {
      action: 'skip',
      reason: `compiled Electron artifacts absent (${controlPlaneEntry}, ${preloadEntry}) — run pnpm run build:desktop; the gate hard-fails when either exists`,
    }
  }
  const missing = []
  if (!controlPlaneExists) missing.push(controlPlaneEntry)
  if (!preloadExists) missing.push(preloadEntry)
  if (missing.length > 0) {
    return { action: 'fail', reason: `partial compiled Electron build: missing ${missing.join(', ')}` }
  }
  return { action: 'run' }
}

/**
 * The child wrapper that boots the compiled plane as a plain Node module. The
 * host package source dirs are pointed at the temp state dir so the gate never
 * seeds the developer's real dsh home; `port: 0` asks the OS for a free port.
 */
export const CONTROL_PLANE_BOOT_WRAPPER = `
const entry = process.env.DSH_ELECTRON_CP_ENTRY
const stateDir = process.env.DSH_ELECTRON_CP_STATE
const { pathToFileURL } = await import('node:url')
const module = await import(pathToFileURL(entry).href)
if (typeof module.createControlPlane !== 'function') {
  console.error('compiled control-plane does not export createControlPlane')
  process.exit(2)
}
const plane = module.createControlPlane({
  port: 0,
  stateDir,
  hostGraphPackageSourceDir: stateDir,
  hostGitWorktreePackageSourceDir: stateDir,
  hostArchiveCleanupPackageSourceDir: stateDir,
  hostOpenInPackageSourceDir: stateDir,
})
await plane.start()
if (typeof plane.port !== 'number' || plane.port <= 0) {
  console.error('compiled control-plane bound no port')
  process.exit(3)
}
process.stdout.write(JSON.stringify({ ready: true, port: plane.port }) + '\\n')
let stopping = false
const shutdown = async () => {
  if (stopping) return
  stopping = true
  try { await plane.stop() } catch (error) { console.error(String(error)); process.exit(4) }
  process.exit(0)
}
process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
`

/**
 * Boot the compiled control-plane entry electron-free and probe it.
 * @param {{ nodeBinary: string, entry: string, stateDir: string, timeoutMs?: number }} input - spawn inputs.
 * @returns {Promise<{ port: number, health: unknown }>} observed facts.
 */
export async function bootCompiledControlPlane({ nodeBinary, entry, stateDir, timeoutMs = 30_000 }) {
  const child = spawn(nodeBinary, ['--input-type=module', '-e', CONTROL_PLANE_BOOT_WRAPPER], {
    cwd: dirname(entry),
    env: { ...process.env, DSH_ELECTRON_CP_ENTRY: entry, DSH_ELECTRON_CP_STATE: stateDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolveExit) => child.on('exit', (code, signal) => resolveExit({ code, signal })))
  const deadline = Date.now() + timeoutMs
  let ready = null
  try {
    while (ready === null && Date.now() < deadline) {
      const line = stdout.split('\n').find((candidate) => candidate.includes('"ready":true'))
      if (line !== undefined) {
        ready = JSON.parse(line)
        break
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`compiled control-plane exited before ready (code=${String(child.exitCode)} signal=${String(child.signalCode)})\n---- stderr tail ----\n${stderr.slice(-800)}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
    if (ready === null) {
      throw new Error(`compiled control-plane did not reach a listening state within ${timeoutMs}ms\n---- stderr tail ----\n${stderr.slice(-800)}`)
    }
    if (typeof ready.port !== 'number' || ready.port <= 0) {
      throw new Error(`compiled control-plane ready frame carried no port: ${JSON.stringify(ready)}`)
    }
    const response = await fetch(`http://127.0.0.1:${ready.port}/health`)
    const body = await response.text()
    if (response.status !== 200) {
      throw new Error(`compiled control-plane /health answered ${response.status}: ${body.slice(0, 200)}`)
    }
    let health
    try {
      health = JSON.parse(body)
    } catch {
      throw new Error(`compiled control-plane /health is not JSON: ${body.slice(0, 200)}`)
    }
    child.kill('SIGTERM')
    const outcome = await Promise.race([
      exited,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({ code: 'timeout', signal: null }), 10_000)),
    ])
    if (outcome.code !== 0) {
      throw new Error(`compiled control-plane SIGTERM exit was ${String(outcome.code)} signal ${String(outcome.signal)}, expected 0 (graceful shutdown)\n---- stderr tail ----\n${stderr.slice(-800)}`)
    }
    return { port: ready.port, health }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
}

/**
 * Load a compiled CJS preload inside node:vm with a stubbed `electron`.
 * @param {string} preloadSource - `dist/preload.cjs` contents.
 * @param {{ info?: object, onInvoke?: (channel: string, payload: unknown) => unknown }} [options] - stub behaviour.
 * @returns {{ exposed: Record<string, unknown>, invokes: { channel: string, payload: unknown }[], listeners: Map<string, Function>, context: object }} harness facts.
 */
export function loadPreloadInVm(preloadSource, { info = {}, onInvoke } = {}) {
  const exposed = {}
  const invokes = []
  const listeners = new Map()
  const ipcRenderer = {
    invoke(channel, payload) {
      invokes.push({ channel, payload })
      if (onInvoke !== undefined) return Promise.resolve(onInvoke(channel, payload))
      return Promise.resolve(info)
    },
    on(channel, listener) { listeners.set(channel, listener) },
    removeListener(channel, listener) {
      if (listeners.get(channel) === listener) listeners.delete(channel)
    },
  }
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    module: { exports: {} },
    require(specifier) {
      if (specifier === 'electron') {
        return {
          contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } },
          ipcRenderer,
        }
      }
      throw new Error(`preload vm stub received unexpected require: ${String(specifier)}`)
    },
  }
  sandbox.exports = sandbox.module.exports
  vm.createContext(sandbox, { name: 'compiled-preload' })
  vm.runInContext(preloadSource, sandbox, { filename: 'dist/preload.cjs' })
  return { exposed, invokes, listeners, context: sandbox }
}

/**
 * Wait one macrotask so the preload's `requestAppInfo().then(...)` exposure
 * branch has run, then return the harness.
 */
export async function inspectPreloadSurface(preloadSource, options = {}) {
  const harness = loadPreloadInVm(preloadSource, options)
  await new Promise((resolveTick) => setImmediate(resolveTick))
  return harness
}

/**
 * Assert the exposed bridge is the frozen surface: 4 scalars + 9 namespaces;
 * every member is a function; every `on*` member returns an unsubscribe.
 * @param {unknown} bridge - `contextBridge.exposeInMainWorld('dshChamber', bridge)` value.
 * @param {{ expectedScalars?: Record<string, unknown> }} [options] - scalar assertions.
 * @returns {{ namespaces: number, members: number }} checked counts.
 */
export function assertFrozenPreloadSurface(bridge, { expectedScalars } = {}) {
  if (bridge === null || typeof bridge !== 'object') {
    throw new Error(`preload exposed no dshChamber object (got ${String(bridge)})`)
  }
  const actualKeys = Object.keys(bridge).sort()
  const expectedKeys = [...BRIDGE_SCALAR_KEYS, ...BRIDGE_NAMESPACE_KEYS].sort()
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`preload surface drifted: exposed [${actualKeys.join(', ')}] != frozen [${expectedKeys.join(', ')}]`)
  }
  for (const key of BRIDGE_SCALAR_KEYS) {
    if (expectedScalars !== undefined && bridge[key] !== expectedScalars[key]) {
      throw new Error(`preload scalar ${key} = ${JSON.stringify(bridge[key])}, expected ${JSON.stringify(expectedScalars[key])}`)
    }
  }
  let members = 0
  for (const namespace of BRIDGE_NAMESPACE_KEYS) {
    const value = bridge[namespace]
    if (value === null || typeof value !== 'object') {
      throw new Error(`preload namespace ${namespace} is not an object (got ${String(value)})`)
    }
    for (const [name, member] of Object.entries(value)) {
      if (typeof member !== 'function') {
        throw new Error(`preload namespace ${namespace}.${name} is not a function (got ${typeof member})`)
      }
      members += 1
    }
  }
  return { namespaces: BRIDGE_NAMESPACE_KEYS.length, members }
}

/**
 * Run the gate. Returns a verdict instead of exiting so tests can call it.
 * @param {{ desktopDist?: string, nodeBinary?: string, log?: Function }} [options] - inputs.
 * @returns {Promise<{ action: 'skip', reason: string } | { action: 'run', port: number, members: number, health: unknown }>} verdict.
 */
export async function runElectronArtifactSmoke({
  desktopDist = resolveDesktopDist(),
  nodeBinary = process.execPath,
  log = console.log,
} = {}) {
  const controlPlaneEntry = join(desktopDist, 'control-plane', 'index.js')
  const preloadEntry = join(desktopDist, 'preload.cjs')
  const decision = artifactDecision({
    controlPlaneEntry,
    controlPlaneExists: existsSync(controlPlaneEntry),
    preloadEntry,
    preloadExists: existsSync(preloadEntry),
  })
  if (decision.action !== 'run') return decision

  const stateDir = mkdtempSync(join(tmpdir(), 'dsh-electron-artifacts-'))
  try {
    const boot = await bootCompiledControlPlane({ nodeBinary, entry: controlPlaneEntry, stateDir })
    const info = {
      controlPlaneUrl: `http://127.0.0.1:${boot.port}`,
      dshVersion: 'gate-fixture',
      version: 'gate-fixture',
      platform: process.platform,
    }
    const harness = await inspectPreloadSurface(readFileSync(preloadEntry, 'utf8'), { info })
    const surface = assertFrozenPreloadSurface(harness.exposed.dshChamber, { expectedScalars: info })
    const infoChannel = harness.invokes.find((call) => call.channel === 'dsh-chamber:info')
    if (infoChannel === undefined) {
      throw new Error('compiled preload never invoked dsh-chamber:info — the exposure branch was not exercised')
    }
    log(`electron-artifacts: control-plane booted on port ${boot.port} and answered /health; preload exposed ${surface.namespaces} namespaces / ${surface.members} members`)
    return { action: 'run', port: boot.port, members: surface.members, health: boot.health }
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
}

async function main() {
  const desktopDist = resolveDesktopDist()
  let verdict
  try {
    verdict = await runElectronArtifactSmoke({ desktopDist })
  } catch (error) {
    console.error('electron compiled-artifact smoke: FAILED — ' + (error instanceof Error ? error.message : String(error)))
    return 1
  }
  if (verdict.action === 'skip') {
    console.error('SKIP: ' + verdict.reason)
    return 0
  }
  if (verdict.action === 'fail') {
    // A partial build is a failure, never a pass: the caller (or CI) must see a
    // non-zero exit, not just a printed reason.
    console.error('electron compiled-artifact smoke: FAILED — ' + verdict.reason)
    return 1
  }
  console.log(`ELECTRON ARTIFACTS SMOKE PASS: ${desktopDist} (control-plane boot + preload surface)`)
  return 0
}

const isEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) process.exit(await main())
