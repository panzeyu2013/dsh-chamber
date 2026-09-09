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
 *     verifyDshEndpoint / probeRemoteMethod, and re-exports the plugin
 *     spec/name whitelist family (plugin-spec.ts) to its own consumers;
 *   - plugin-sync.ts consumes the cordis insert primitives
 *     (renderCordisInserts / parseLoaderRows / hasExactInsert / fieldCount /
 *     insertConflict) for the remote cordis.patch.yml seed merge, the
 *     plugin-spec whitelist constants for its add/remove re-validation, and
 *     the host-package insert facts (HOST_GRAPH_INSERT / HOST_GIT_WORKTREE_INSERT
 *     / HOST_ARCHIVE_CLEANUP_INSERT from host-graph-seed.ts) its
 *     package-name/insert-id constants derive from.
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

// Unified host-identity probe contract (rpc-envelope.ts single source) —
// consumed by ssh-provider's endpoint probes (verifyDshEndpoint /
// probeDshSignature). Same method names/payloads/64 KiB cap as the
// control-plane probeHostIdentity.
export const HOST_IDENTITY_METHOD = controlPlaneModule.HOST_IDENTITY_METHOD
export const LEGACY_HOST_PROBE_METHOD = controlPlaneModule.LEGACY_HOST_PROBE_METHOD
export const HOST_PROBE_MAX_RESPONSE_BYTES = controlPlaneModule.HOST_PROBE_MAX_RESPONSE_BYTES
export const buildHostIdentityProbePayload = controlPlaneModule.buildHostIdentityProbePayload
export const buildLegacyHostProbePayload = controlPlaneModule.buildLegacyHostProbePayload

// Cordis loader insert primitives (cordis-inserts.ts) — consumed by
// plugin-sync.
export const renderCordisInserts = controlPlaneModule.renderCordisInserts
export const parseLoaderRows = controlPlaneModule.parseLoaderRows
export const hasExactInsert = controlPlaneModule.hasExactInsert
export const fieldCount = controlPlaneModule.fieldCount
export const insertConflict = controlPlaneModule.insertConflict

// Chamber host-package insert facts (host-graph-seed.ts, design 09 module A /
// design 13 §4.6 — re-exported by the control-plane package index) — consumed
// by plugin-sync, whose desktop-facing package-name/insert-id constants
// derive from these so the local seed, the remote seed writer and
// control-plane's own seed can never drift.
export const HOST_GRAPH_INSERT = controlPlaneModule.HOST_GRAPH_INSERT
export const HOST_GIT_WORKTREE_INSERT = controlPlaneModule.HOST_GIT_WORKTREE_INSERT
export const HOST_ARCHIVE_CLEANUP_INSERT = controlPlaneModule.HOST_ARCHIVE_CLEANUP_INSERT
// The canonical host-seed namespace + its fail-loud assertion (Batch 1 naming
// unification, 2026-09) — consumed by plugin-sync's remote cordis.patch.yml
// merge, which must also recognize the pre-rename names to fold them once.
export const HOST_SEED_PACKAGE_PREFIX = controlPlaneModule.HOST_SEED_PACKAGE_PREFIX
export const assertHostSeedInsertNaming = controlPlaneModule.assertHostSeedInsertNaming
// The authoritative chamber host-package registry (name + insert id + liveness
// probe): the desktop derives every chamber row/probe from it — never a
// hand-maintained parallel list (2026-09 user decision).
export const CHAMBER_HOST_PACKAGES = controlPlaneModule.CHAMBER_HOST_PACKAGES

// Plugin spec/name whitelist family + reserved-name deny predicate
// (plugin-spec.ts, design 21 §6.2/§6.7 — the shared source for the desktop
// main (ssh-provider re-export / plugin-sync) and the gateway executor) —
// consumed by ssh-provider.ts and plugin-sync.ts.
export const isDeniedPluginName = controlPlaneModule.isDeniedPluginName
export const extractSpecName = controlPlaneModule.extractSpecName
export const MATERIALIZE_FILE_SPEC_PATTERN = controlPlaneModule.MATERIALIZE_FILE_SPEC_PATTERN
export const MAX_PLUGIN_SPEC_CHARS = controlPlaneModule.MAX_PLUGIN_SPEC_CHARS
export const PLUGIN_NAME_PATTERN = controlPlaneModule.PLUGIN_NAME_PATTERN
export const PLUGIN_SPEC_PATTERN = controlPlaneModule.PLUGIN_SPEC_PATTERN
export const RUN_STDOUT_MAX_BYTES = controlPlaneModule.RUN_STDOUT_MAX_BYTES
export const WRITE_FILE_MAX_BYTES = controlPlaneModule.WRITE_FILE_MAX_BYTES

// Owner-private file primitives (private-file.ts, P2-2a) — consumed by the
// desktop main's credential mirrors (ssh-provider / gateway-provider /
// owner-only-secret-file), the chamber-settings store, the ssh plugin undo
// journal (ssh-plugin-journal) and the local-plugin-writer ledger
// (plugin-sync). Single-sourcing the 0600 atomic-replace / no-follow read
// mechanism here retires the per-module handwritten copies.
export const ensurePrivateDirectoryNoFollow = controlPlaneModule.ensurePrivateDirectoryNoFollow
export const atomicWritePrivateFileNoFollow = controlPlaneModule.atomicWritePrivateFileNoFollow
export const readPrivateFileNoFollow = controlPlaneModule.readPrivateFileNoFollow

// Owner-only audit-trail core (audit-trail.ts, P2-2c) — the shared
// serializer + hardened append/rotate implementation behind BOTH the
// desktop audit log (audit-log.ts) and the gateway server audit
// (gateway/src/audit.ts imports the control plane directly).
export const appendAuditTrailLine = controlPlaneModule.appendAuditTrailLine
export const serializeAuditEvent = controlPlaneModule.serializeAuditEvent
export const AUDIT_TRAIL_MAX_BYTES = controlPlaneModule.AUDIT_TRAIL_MAX_BYTES

// Gateway wire-protocol credential/session facts + SPKI pin helpers — the
// cross-shape single source (control-plane gateway-session-protocol.ts /
// spki-pin.ts, design 17 §7.1/§9.3/§13.4.2/S23): the gateway server imports
// the same module, so the desktop client and the server can no longer drift
// on cookie name / TTL / bearer & password bounds / cookie caps. Consumed by
// gateway-session.ts (login cache + expiry) and gateway-provider.ts (SPKI
// probe gate + form validation mirrors).
export const GATEWAY_PASSWORD_MAX_CHARS = controlPlaneModule.GATEWAY_PASSWORD_MAX_CHARS
export const GATEWAY_PASSWORD_MIN_CHARS = controlPlaneModule.GATEWAY_PASSWORD_MIN_CHARS
export const GATEWAY_SESSION_COOKIE_NAME = controlPlaneModule.GATEWAY_SESSION_COOKIE_NAME
export const GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS = controlPlaneModule.GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS
export const GATEWAY_SESSION_TTL_SECONDS = controlPlaneModule.GATEWAY_SESSION_TTL_SECONDS
export const GATEWAY_TOKEN_MAX_CHARS = controlPlaneModule.GATEWAY_TOKEN_MAX_CHARS
export const GATEWAY_TOKEN_MIN_CHARS = controlPlaneModule.GATEWAY_TOKEN_MIN_CHARS
export const GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN = controlPlaneModule.GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN
export const SPKI_PIN_PATTERN = controlPlaneModule.SPKI_PIN_PATTERN
export const SPKI_PIN_MISMATCH_CODE = controlPlaneModule.SPKI_PIN_MISMATCH_CODE
export const spkiPinOfPeerCertificate = controlPlaneModule.spkiPinOfPeerCertificate
export const attachSpkiPinVerifier = controlPlaneModule.attachSpkiPinVerifier

// Types ride the same single source; type-only exports are erased at build
// time, so re-exporting from the workspace package costs nothing at runtime.
export type {
  AuditTrailEvent,
  ChamberHostPackageDescriptor,
  ClientRequestEnvelope,
  CordisInsert,
  HostPackageInsert,
  InsertConflictKind,
  ParsedInsertRow,
  RawUnaryOutcome,
  ServerResponseEnvelope,
  ServerResponseParse,
} from '@dsh-chamber/control-plane'
