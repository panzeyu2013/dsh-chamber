/**
 * Shared harness for the split /chamber/runtime route suites: fake plane,
 * stateDir config, route runner, settle pollers, the derived probe set and a
 * valid runtime tree fixture. Extracted verbatim from runtime-routes.test.ts.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ApiRequest,
  type ApiResponse,
  type Logger,
  type PlaneHandle,
} from '@dsh-chamber/control-plane'
import {
  activationProbeNamesForDomains,
  readOverrideState,
  writeActivationIntent,
  writeCurrentPointer,
  writeOverride,
  type OverrideRecord,
} from '@dsh-chamber/dsh-runtime'
import type { GatewayConfig } from '../../src/config.ts'
import { syncedHostDomainProbeNames } from '../../src/plugins.ts'
import {
  createGatewayRuntimeManager,
  type GatewayRuntimeManager,
  type GatewayRuntimeManagerOptions,
} from '../../src/runtime-manager.ts'
import { type RuntimeRoutes } from '../../src/runtime-routes.ts'
import { FakeRequest, FakeResponse } from './utils.ts'

export const silentLogger: Logger = { log() {}, warn() {}, error() {} }

export const TEST_BUILTIN_VERSION = '0.9.0'
export const gatewayPackageVersion = (JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string }).version

export function config(stateDir: string): GatewayConfig {
  const anchor = join(stateDir, 'builtin-anchor')
  const packageDir = join(anchor, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(anchor, 'package.json'), JSON.stringify({
    name: 'gateway-test-anchor',
    dependencies: { '@deepseek-ai/dsh': TEST_BUILTIN_VERSION },
  }))
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh', version: TEST_BUILTIN_VERSION,
  }))
  return {
    plane: { host: '127.0.0.1', port: 3000, stateDir, dshWorkspacePath: anchor },
    auth: { kind: 'none' },
    corsOrigins: [],
    trustedProxies: [],
  }
}

export function fakePlane(overrides: Partial<PlaneHandle> = {}): PlaneHandle & { _state: { connectionState: string; restartError: string | null } } {
  const state = { connectionState: 'stopped', restartError: null as string | null }
  return {
    seededProbeDomains: [],
    start: async () => {},
    startLocal: async () => {},
    stop: async () => {},
    stopLocal: async () => {},
    restartLocal: async () => {
      if (state.restartError !== null) throw new Error(state.restartError)
      state.connectionState = 'ready'
    },
    onLocalStateChange: () => () => {},
    registerInstanceTransport: () => {},
    unregisterInstanceTransport: () => {},
    refreshLocalExposure: () => {},
    getLocalDshPort: () => 17510,
    get port() { return 3000 },
    get connectionState() { return state.connectionState },
    get localProcessAlive() { return false },
    get localDshPort() { return 17510 },
    get localWritersQuiescent() { return true },
    get instanceId() { return 'test-gateway' },
    ...overrides,
    _state: state,
  }
}

export async function runRoute(routes: RuntimeRoutes, method: string, path: string, body?: string): Promise<{ status: number; json: unknown }> {
  const fakeReq = new FakeRequest(method, path, { authorization: 'Bearer x' })
  const req = fakeReq as unknown as ApiRequest
  const fakeRes = new FakeResponse()
  const res = fakeRes as unknown as ApiResponse
  // Start the handler first: readJsonBody attaches its stream listeners
  // synchronously, and the paused-mode FakeRequest buffers bytes emitted
  // before a listener attaches — so this ordering is safe either way.
  const pending = routes.handle(req, res, path)
  if (body !== undefined) fakeReq.emit('data', Buffer.from(body))
  fakeReq.emit('end')
  const claimed = await pending
  assert.equal(claimed, true, `${method} ${path} must be claimed`)
  return { status: fakeRes.statusCode, json: fakeRes.body === '' ? null : JSON.parse(fakeRes.body) }
}

/** Poll until the apply-now async job settles (202 semantics expose no promise
 * handle — the outcome arrives via status()/applyNowInFlight). */
export async function waitForSettle(manager: { applyNowInFlight(): boolean }): Promise<void> {
  for (let i = 0; i < 400 && manager.applyNowInFlight(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

export async function waitForMutationSettle(manager: { mutationInProgress(): boolean }): Promise<void> {
  for (let i = 0; i < 400 && manager.mutationInProgress(); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(manager.mutationInProgress(), false, 'runtime mutation did not settle before the test deadline')
}

/** 2026-12 Phase 3 shape gate (design 24 §7 C, M2): the manager derives the
 * expected probe set per spawn from the seed cache's ACTUALLY PRESENT
 * chamber host packages (syncedHostDomainProbeNames — the per-package
 * derivation that replaced the binary hasSyncedHostSeed gate). The fake
 * host answers exactly the derived set the real dsh would serve: test
 * stateDirs start with no cache (reduced base set); the full-flip fixture
 * seeds every registry package (full 7-name closed set). */
export function probeResultsFor(stateDir: string): readonly string[] {
  return activationProbeNamesForDomains(syncedHostDomainProbeNames(stateDir))
}

/** Create <stateDir>/dsh-home and write its settings.json; returns the home path. */
export function writeDshHome(stateDir: string, settingsJson: string): string {
  const home = join(stateDir, 'dsh-home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'settings.json'), settingsJson)
  return home
}

/** Arm the canonical non-builtin version-switch intent. */
export function writeVersionSwitchIntent(stateDir: string, targetVersion: string): void {
  writeActivationIntent(stateDir, {
    targetVersion, targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
  })
}

/** Shell-pinned override row (shellVersion = the running gateway package version).
 *  resolvedVersion defaults to chosenVersion; swapAttempted defaults to false. */
export function writeOverrideRow(stateDir: string, fields: {
  chosenVersion: string | null
  pending: string | null
  shellVersion?: string
  resolvedVersion?: string
  swapAttempted?: boolean
  selectedOnly?: boolean
  lastOutcome?: string
  lastError?: string | null
  restoreOutcome?: 'none' | 'complete' | 'half' | 'incomplete' | null
}): void {
  writeOverride(stateDir, {
    shellVersion: gatewayPackageVersion,
    resolvedVersion: fields.chosenVersion,
    swapAttempted: false,
    ...fields,
  })
}

/** State-backed override projection for assertions (D5a retired the production
 *  compat read): valid → record, every other state → no record. */
export function readOverrideRow(stateDir: string): OverrideRecord | null {
  const state = readOverrideState(stateDir)
  return state.kind === 'valid' ? state.record : null
}

/** The canonical pending version-switch fixture: valid tree, pending settings.json,
 *  armed intent and the matching override row. Returns the dsh-home path. */
export function armPendingSwitch(stateDir: string, version: string, settingsJson = '{"pending":true}'): string {
  makeValidTree(stateDir, version)
  const home = writeDshHome(stateDir, settingsJson)
  writeVersionSwitchIntent(stateDir, version)
  writeOverrideRow(stateDir, { chosenVersion: version, pending: version, selectedOnly: false })
  return home
}

/** F7 fixture: an applied candidate version over a still-current older tree, with its
 *  dsh-home settings.json. Returns the dsh-home path for later migration assertions. */
export function armAppliedCandidate(
  stateDir: string,
  current = '1.0.0',
  candidate = '2.0.0',
  settingsJson = '{"source":"v1"}',
): string {
  makeValidTree(stateDir, current)
  makeValidTree(stateDir, candidate)
  writeCurrentPointer(stateDir, current)
  writeVersionSwitchIntent(stateDir, candidate)
  writeOverrideRow(stateDir, { chosenVersion: candidate, resolvedVersion: current, pending: candidate, lastOutcome: 'applied' })
  return writeDshHome(stateDir, settingsJson)
}

/** The test probe seam: answer exactly the derived visible probe-name set as OK. */
export function derivedProbe(stateDir: string): NonNullable<GatewayRuntimeManagerOptions['probeCandidate']> {
  return async () => probeResultsFor(stateDir).map(name => ({ name, ok: true }))
}

/** Runtime manager over the shared config/plane/logger. The probe seam stays
 *  real unless the caller injects one (derivedProbe for the derived-set shape). */
export function runtimeManager(
  stateDir: string,
  plane: PlaneHandle,
  overrides: Partial<GatewayRuntimeManagerOptions> = {},
): GatewayRuntimeManager {
  return createGatewayRuntimeManager({ config: config(stateDir), plane, logger: silentLogger, ...overrides })
}

export function makeValidTree(stateDir: string, version: string): void {
  const root = join(stateDir, 'dsh-runtime', version)
  const dshPkg = { name: '@deepseek-ai/dsh', version }
  const criticalFiles: Record<string, string> = {}
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dshDir, { recursive: true })
  const packagePath = join(dshDir, 'package.json')
  const binPath = join(dshDir, 'lib', 'bin.js')
  mkdirSync(join(dshDir, 'lib'), { recursive: true })
  writeFileSync(packagePath, JSON.stringify(dshPkg))
  writeFileSync(binPath, '#!/usr/bin/env node\nconsole.log("hi")\n')
  for (const rel of ['node_modules/@deepseek-ai/dsh/package.json', 'node_modules/@deepseek-ai/dsh/lib/bin.js']) {
    criticalFiles[rel] = `sha256-${createHash('sha256').update(readFileSync(join(root, rel))).digest('base64')}`
  }
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'runtime-tree',
    version,
    dependencies: { '@deepseek-ai/dsh': version },
    dsh: { platform: `${process.platform}-${process.arch}`, criticalFiles },
  }))
}