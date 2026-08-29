/**
 * The desktop main-process facade over the control-plane package (A2
 * cross-package protocol single-sourcing).
 *
 * The desktop's packaged build cannot import workspace packages from
 * node_modules (Node's type erasure does not cover node_modules; the TS
 * sources ship raw in the asar), so build-control-plane.mjs compiles the
 * control-plane sources into <pkg>/dist/control-plane/ and the packaged app
 * loads THAT — while dev (and the pure-node tests) run the workspace source
 * through the pnpm symlink. This module lifts the dual-path resolution (the
 * former main.ts controlPlaneModule block) into one shared module:
 *
 *   - main.ts consumes createControlPlane;
 *   - ssh-provider.ts consumes the RPC envelope primitives
 *     (buildClientRequest / parseServerResponse / postClientRequest) for
 *     verifyDshEndpoint / probeRemoteMethod;
 *   - plugin-sync.ts consumes the cordis insert primitives
 *     (renderCordisInserts / parseLoaderRows / hasExactInsert / fieldCount /
 *     insertConflict) for the remote cordis.patch.yml seed merge.
 *
 * The packaged-runtime gate deliberately uses process metadata rather than
 * importing `electron`: this facade is also consumed by pure-node modules
 * and tests, which must not require Electron's downloaded binary merely to
 * load shared protocol helpers. Electron sets `process.versions.electron` in
 * every main process and `process.defaultApp` when an unpackaged app is run
 * through the default Electron executable.
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The packaged-build compiled entry (build:control-plane output). A packaged
 * app without it is a broken build; fail with an explicit artifact error
 * before attempting the dynamic import.
 */
const pkgDir = path.dirname(fileURLToPath(import.meta.url))
const CONTROL_PLANE_ENTRY = path.join(pkgDir, 'dist', 'control-plane', 'index.js')
const controlPlaneEntrySpecifier = './dist/control-plane/index.js'

export function isPackagedElectronRuntime(runtime: {
  electronVersion?: string
  defaultApp?: boolean
}): boolean {
  return typeof runtime.electronVersion === 'string'
    && runtime.electronVersion.length > 0
    && runtime.defaultApp !== true
}

const runtimeProcess = process as NodeJS.Process & { defaultApp?: boolean }
const isPackaged = isPackagedElectronRuntime({
  electronVersion: process.versions.electron,
  defaultApp: runtimeProcess.defaultApp,
})

if (isPackaged && !existsSync(CONTROL_PLANE_ENTRY)) {
  throw new Error(
    `missing packaged control-plane artifact: ${CONTROL_PLANE_ENTRY} (run pnpm --filter @dsh-chamber/desktop run build:control-plane before packaging)`,
  )
}

/**
 * The resolved control-plane module: the compiled artifact when packaged,
 * the workspace source otherwise. Top-level await mirrors the former
 * main.ts block — every importer (main.ts wiring assembly, ssh-provider,
 * plugin-sync) is blocked on the resolution before its own body runs, so the
 * re-exports below are safe to use at runtime.
 */
const controlPlaneModule: typeof import('@dsh-chamber/control-plane') = await (isPackaged
  ? import(controlPlaneEntrySpecifier)
  : import('@dsh-chamber/control-plane'))

/** The control-plane factory (former main.ts `const { createControlPlane }`). */
export const createControlPlane = controlPlaneModule.createControlPlane
export const call = controlPlaneModule.call

// RPC wire envelope primitives (rpc-envelope.ts) — consumed by ssh-provider.
export const buildClientRequest = controlPlaneModule.buildClientRequest
export const parseServerResponse = controlPlaneModule.parseServerResponse
export const postClientRequest = controlPlaneModule.postClientRequest
export const mintRpcId = controlPlaneModule.mintRpcId

// Cordis loader insert primitives (cordis-inserts.ts) — consumed by
// plugin-sync.
export const renderCordisInserts = controlPlaneModule.renderCordisInserts
export const parseLoaderRows = controlPlaneModule.parseLoaderRows
export const hasExactInsert = controlPlaneModule.hasExactInsert
export const fieldCount = controlPlaneModule.fieldCount
export const insertConflict = controlPlaneModule.insertConflict

// Types ride the same single source; type-only exports are erased at build
// time, so re-exporting from the workspace package costs nothing at runtime.
export type {
  ClientRequestEnvelope,
  CordisInsert,
  InsertConflictKind,
  ParsedInsertRow,
  RawUnaryOutcome,
  ServerResponseEnvelope,
  ServerResponseParse,
} from '@dsh-chamber/control-plane'
