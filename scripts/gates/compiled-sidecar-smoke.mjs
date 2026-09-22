#!/usr/bin/env node
/**
 * compiled-sidecar-smoke.mjs —— executed-assembly gate.
 *
 * The sidecar assembly (`packages/desktop/release/sidecar`) is what Swift ships:
 * a bundled `node`, the esbuild-bundled `sidecar.js` and the compiled
 * `dist/control-plane`. The JS suites spawn the
 * TypeScript source, and the packaging suites only assert the files exist, so a
 * bundle that cannot boot (broken external, missing compiled entry, unresolved
 * bare specifier) can ship unseen.
 *
 * This gate spawns the REAL `sidecar.js` with `DSH_CHAMBER_SIDECAR_COMPILED=1`
 * (the marker that selects the assembly-relative `dist/control-plane` import),
 * waits for the ready frame, drives two representative invokes over the same
 * NDJSON protocol the Swift shell speaks, and requires a graceful SIGTERM exit
 * (exit 0). Environment:
 *
 *   DSH_CHAMBER_SIDECAR_COMPILED=1   enables the smoke (required to execute)
 *   DSH_CHAMBER_SIDECAR_DIR=<dir>    assembly dir; defaults to
 *                                    packages/desktop/release/sidecar
 *
 * A disabled run is a LOUD skip (`SKIP: ...`) — never a silent pass. CI builds
 * the assembly first (see ci.yml's test-macos job), so there the gate runs.
 *
 * Packaged-.app launch is deliberately NOT attempted here: assembling and
 * launching a signed/notarized .app needs release credentials and a GUI session
 * that a plain test leg does not have. The actionable partial is the sidecar
 * boot chain this gate covers; the .app window chain stays a release/real-machine
 * acceptance item.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveNodeBinary, resolveSidecarDir } from '../lib/sidecar-assembly.mjs'
import { SIDECAR_COMPILED_ENV, freeLoopbackPort, sidecarLaunchArgs, sidecarLaunchEnv } from '../lib/sidecar-launch.mjs'

/** Assembly-sidecar marker consumed by control-plane-module.isPackagedSidecarRuntime. */
export const COMPILED_ENV = SIDECAR_COMPILED_ENV
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')


/**
 * Decide whether the smoke runs, skips loudly, or fails.
 * @param {{ enabled: boolean, entryPath: string, entryExists: boolean, controlPlanePath: string, controlPlaneExists: boolean }} input - observed facts.
 * @returns {{ action: 'run' } | { action: 'skip', reason: string } | { action: 'fail', reason: string }} decision.
 */
export function smokeDecision({ enabled, entryPath, entryExists, controlPlanePath, controlPlaneExists }) {
  if (!enabled) {
    return {
      action: 'skip',
      reason: `${COMPILED_ENV} != 1 — build the sidecar assembly and set ${COMPILED_ENV}=1 to execute ${entryPath}`,
    }
  }
  if (!entryExists) {
    return { action: 'fail', reason: `missing compiled sidecar entry: ${entryPath} (build it first: pnpm run build:sidecar)` }
  }
  if (!controlPlaneExists) {
    return { action: 'fail', reason: `missing compiled control-plane: ${controlPlanePath} (build:control-plane must run before build:sidecar)` }
  }
  return { action: 'run' }
}


/** Minimal NDJSON driver over the sidecar's stdio (same frames the Swift B bridge sends). */
function createDriver(child, stderrRef) {
  const rl = createInterface({ input: child.stdout })
  const pending = new Map()
  const notifiers = new Map()
  let nextId = 1
  rl.on('line', (line) => {
    if (line.length === 0) return
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    if (typeof frame.notify === 'string') {
      const waiter = notifiers.get(frame.notify)
      if (waiter !== undefined) {
        notifiers.delete(frame.notify)
        waiter(frame.payload ?? {})
      }
      return
    }
    if (typeof frame.id === 'number') {
      const settle = pending.get(frame.id)
      if (settle !== undefined) {
        pending.delete(frame.id)
        settle(frame)
      }
    }
  })
  const fail = (message) => {
    const tail = stderrRef().slice(-800)
    throw new Error(message + (tail === '' ? '' : `\n---- sidecar stderr tail ----\n${tail}`))
  }
  return {
    waitNotify(name, timeoutMs) {
      return new Promise((resolveNotify, reject) => {
        const timer = setTimeout(() => {
          notifiers.delete(name)
          reject(new Error(`timed out after ${timeoutMs}ms waiting for the '${name}' frame`))
        }, timeoutMs)
        notifiers.set(name, (payload) => {
          clearTimeout(timer)
          resolveNotify(payload)
        })
      })
    },
    invoke(method, payload, timeoutMs) {
      return new Promise((resolveInvoke, reject) => {
        const id = nextId
        nextId += 1
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`))
        }, timeoutMs)
        pending.set(id, (frame) => {
          clearTimeout(timer)
          resolveInvoke(frame)
        })
        child.stdin.write(JSON.stringify({ id, method, payload }) + '\n')
      })
    },
    fail,
  }
}

/** Run the smoke; throws on any failure. */
async function runSmoke({ nodeBinary, entryPath, controlPlanePath }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-compiled-sidecar-'))
  const port = await freeLoopbackPort()
  let child
  let stderr = ''
  try {
    child = spawn(nodeBinary, [entryPath, ...sidecarLaunchArgs({ userDataDir, port })], {
      cwd: dirname(entryPath),
      env: sidecarLaunchEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const exit = new Promise((resolveExit) => {
      child.on('exit', (code) => resolveExit(code))
    })
    const driver = createDriver(child, () => stderr)
    const ready = await driver.waitNotify('ready', 30_000)
    if (typeof ready.port !== 'number') {
      driver.fail(`ready frame carried no port: ${JSON.stringify(ready)}`)
    }
    const info = await driver.invoke('dsh-chamber:info', null, 10_000)
    if (info.ok !== true) driver.fail(`dsh-chamber:info rejected: ${JSON.stringify(info)}`)
    const platform = info.result !== null && typeof info.result === 'object' ? info.result.platform : undefined
    if (platform !== process.platform) {
      driver.fail(`dsh-chamber:info platform mismatch: ${String(platform)} != ${process.platform}`)
    }
    const settings = await driver.invoke('dsh-chamber:settings-get', null, 10_000)
    if (settings.ok !== true) driver.fail(`dsh-chamber:settings-get rejected: ${JSON.stringify(settings)}`)
    child.kill('SIGTERM')
    const code = await Promise.race([
      exit,
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 10_000)),
    ])
    if (code !== 0) driver.fail(`SIGTERM exit was ${String(code)}, expected 0 (graceful)`)
    return { entryPath, controlPlanePath, port, info }
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

async function main() {
  const sidecarDir = resolveSidecarDir()
  const entryPath = join(sidecarDir, 'sidecar.js')
  const controlPlanePath = join(sidecarDir, 'dist', 'control-plane', 'index.js')
  const decision = smokeDecision({
    enabled: process.env[COMPILED_ENV] === '1',
    entryPath,
    entryExists: existsSync(entryPath),
    controlPlanePath,
    controlPlaneExists: existsSync(controlPlanePath),
  })
  if (decision.action === 'skip') {
    console.error('SKIP: ' + decision.reason)
    return 0
  }
  if (decision.action === 'fail') {
    console.error('compiled sidecar smoke: FAILED — ' + decision.reason)
    return 1
  }
  const nodeBinary = resolveNodeBinary(sidecarDir)
  try {
    const result = await runSmoke({ nodeBinary, entryPath, controlPlanePath })
    console.log(
      `COMPILED SIDECAR SMOKE PASS: ${result.entryPath} booted (node=${nodeBinary}, port=${result.port}) and answered dsh-chamber:info + settings-get`,
    )
    return 0
  } catch (error) {
    console.error('compiled sidecar smoke: FAILED — ' + (error instanceof Error ? error.message : String(error)))
    return 1
  }
}

const isEntry = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) process.exit(await main())
