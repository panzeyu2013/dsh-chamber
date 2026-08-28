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
 *   - main.ts consumes createControlPlane (and CONTROL_PLANE_ENTRY for the
 *     packaged-artifact presence check);
 *   - ssh-provider.ts consumes the RPC envelope primitives
 *     (buildClientRequest / parseServerResponse / postClientRequest) for
 *     verifyDshEndpoint / probeRemoteMethod;
 *   - plugin-sync.ts consumes the cordis insert primitives
 *     (renderCordisInserts / parseLoaderRows / hasExactInsert / fieldCount /
 *     insertConflict) for the remote cordis.patch.yml seed merge.
 *
 * The isPackaged gate mirrors main.ts exactly. The electron reference is
 * made test-safe: in a pure-node test process the `electron` package
 * resolves to its launcher (no `app` member), which falls through to the
 * workspace branch — the same branch dev uses, and exactly what the tests
 * need. Inside the real Electron main process the gate is the genuine
 * app.isPackaged.
 */

import * as electronNs from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The packaged-build compiled entry (build:control-plane output). Exported
 * for main.ts's packaged-artifact presence check (a packaged app without the
 * compiled entry is a broken build: loud dialog, not a cryptic failure).
 */
const pkgDir = path.dirname(fileURLToPath(import.meta.url))
export const CONTROL_PLANE_ENTRY = path.join(pkgDir, 'dist', 'control-plane', 'index.js')
const controlPlaneEntrySpecifier = './dist/control-plane/index.js'

const isPackaged = (electronNs as unknown as { app?: { isPackaged?: boolean } }).app?.isPackaged === true

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
