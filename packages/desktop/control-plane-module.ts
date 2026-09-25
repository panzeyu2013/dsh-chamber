/**
 * The desktop main-process facade over the control-plane package (cross-package
 * protocol single-sourcing).
 *
 * Packaged builds cannot import workspace packages from node_modules (raw TS cannot be
 * type-stripped at runtime), so build-control-plane.mjs compiles them into
 * <pkg>/dist/control-plane/ and the packaged app loads THAT; dev and pure-node tests run
 * the workspace source through the pnpm symlink. The packaged-runtime gate deliberately
 * uses process metadata (Electron sets `process.versions.electron` /
 * `process.defaultApp`) instead of importing `electron`.
 */

import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The packaged-build compiled entry; a packaged app without it is a broken build,
 * failed with an explicit artifact error before the dynamic import. */
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

/** Assembled-sidecar marker: the Swift Supervisor spawns `<sidecar>/sidecar.js` with
 * DSH_CHAMBER_SIDECAR_COMPILED=1, where the bare workspace specifier is unresolvable
 * and the compiled artifact sits at `<sidecar>/dist/control-plane/index.js`. Explicit
 * and env-driven — never guessed from process shape, never set by the Electron shell. */
export function isPackagedSidecarRuntime(runtime: NodeJS.ProcessEnv = process.env): boolean {
  return runtime.DSH_CHAMBER_SIDECAR_COMPILED === '1'
}

const runtimeProcess = process as NodeJS.Process & { defaultApp?: boolean }
const isPackaged = isPackagedElectronRuntime({
  electronVersion: process.versions.electron,
  defaultApp: runtimeProcess.defaultApp,
}) || isPackagedSidecarRuntime()

if (isPackaged && !existsSync(CONTROL_PLANE_ENTRY)) {
  throw new Error(
    `missing packaged control-plane artifact: ${CONTROL_PLANE_ENTRY} (run pnpm --filter @dsh-chamber/desktop run build:control-plane before packaging)`,
  )
}

/** The resolved control-plane module: compiled artifact when packaged, workspace source
 * otherwise. Top-level await blocks every importer on the resolution before its own
 * body runs, so the re-exports below are safe to use at runtime. */
const controlPlaneModule: typeof import('@dsh-chamber/control-plane') = await (isPackaged
  ? import(controlPlaneEntrySpecifier)
  : import('@dsh-chamber/control-plane'))

export const createControlPlane = controlPlaneModule.createControlPlane
export const call = controlPlaneModule.call

// State-root writer lease: the desktop main and the Swift sidecar take the <userData>
// host-root lease through this facade; the packaged sidecar control plane takes
// <userData>/state from the same module — one lease contract, no desktop-local copy.
export const acquireStateRootLease = controlPlaneModule.acquireStateRootLease
export const StateRootLeaseError = controlPlaneModule.StateRootLeaseError
/** Type face of the same class (a facade `const` re-export is value-only). */
export type StateRootLeaseError = InstanceType<typeof controlPlaneModule.StateRootLeaseError>

// RPC wire envelope primitives (rpc-envelope.ts) — consumed by ssh-provider.
export const buildClientRequest = controlPlaneModule.buildClientRequest
export const parseServerResponse = controlPlaneModule.parseServerResponse
export const postClientRequest = controlPlaneModule.postClientRequest
export const mintRpcId = controlPlaneModule.mintRpcId

// Unified host-identity probe contract (rpc-envelope single source) consumed by
// ssh-provider endpoint probes; same methods/payloads/64 KiB cap as control-plane probeHostIdentity.
export const HOST_IDENTITY_METHOD = controlPlaneModule.HOST_IDENTITY_METHOD
export const LEGACY_HOST_PROBE_METHOD = controlPlaneModule.LEGACY_HOST_PROBE_METHOD
export const HOST_PROBE_MAX_RESPONSE_BYTES = controlPlaneModule.HOST_PROBE_MAX_RESPONSE_BYTES
export const buildHostIdentityProbePayload = controlPlaneModule.buildHostIdentityProbePayload
export const buildLegacyHostProbePayload = controlPlaneModule.buildLegacyHostProbePayload
// The canonical legacy session/list shape predicate (rpc-envelope) consumed by
// ssh-provider legacy signature arm and the activation-probe seam.
export const isLegacyHostProbeValue = controlPlaneModule.isLegacyHostProbeValue

// Cordis loader insert primitives (cordis-inserts.ts) — consumed by plugin-sync.
export const renderCordisInserts = controlPlaneModule.renderCordisInserts
export const hasExactInsert = controlPlaneModule.hasExactInsert
export const insertConflict = controlPlaneModule.insertConflict

// Chamber host-package insert facts (host-graph-seed.ts, re-exported by the control-plane
// index) — plugin-sync derives its package-name/insert-id constants from these, so the local
// seed, the remote seed writer and control-plane own seed can never drift.
export const HOST_GRAPH_INSERT = controlPlaneModule.HOST_GRAPH_INSERT
export const HOST_GIT_WORKTREE_INSERT = controlPlaneModule.HOST_GIT_WORKTREE_INSERT
export const HOST_ARCHIVE_CLEANUP_INSERT = controlPlaneModule.HOST_ARCHIVE_CLEANUP_INSERT
export const HOST_OPEN_IN_INSERT = controlPlaneModule.HOST_OPEN_IN_INSERT
// The authoritative chamber host-package registry (name + insert id + liveness probe):
// every desktop chamber row/probe derives from it, never a parallel list.
export const CHAMBER_HOST_PACKAGES = controlPlaneModule.CHAMBER_HOST_PACKAGES
// The seeded file set + the local `--patch` overlay filename (host-graph-seed.ts single
// source) — consumed by plugin-sync (remote seed writer/probes/overlay) and gateway-provider.
export const HOST_PACKAGE_SEED_FILES = controlPlaneModule.HOST_PACKAGE_SEED_FILES
export const HOST_GRAPH_PATCH_FILENAME = controlPlaneModule.HOST_GRAPH_PATCH_FILENAME

// Plugin-manifest read algorithm + materialize ruler + x-wildcard semantic gate (wire
// plugin-manifest.ts is the single source) — consumed by plugin-sync manifest reads,
// masking, materialize resolution and the version-value classifier. Through THIS facade
// the packaged app reads the definitions inlined in dist/control-plane/index.js instead
// of a bare wire specifier.
export const hasXWildcard = controlPlaneModule.hasXWildcard
export const isMaterializedValue = controlPlaneModule.isMaterializedValue
export const parsePluginManifest = controlPlaneModule.parsePluginManifest
export const readManifestVersion = controlPlaneModule.readManifestVersion
// Plugin spec/name whitelist family (plugin-spec.ts, shared by the desktop main and the
// gateway executor) — consumed by ssh-provider and plugin-sync; reserved-name judgement
// lives in protected-plugins.ts.
export const MAX_PLUGIN_SPEC_CHARS = controlPlaneModule.MAX_PLUGIN_SPEC_CHARS
export const PLUGIN_NAME_PATTERN = controlPlaneModule.PLUGIN_NAME_PATTERN
export const PLUGIN_SPEC_PATTERN = controlPlaneModule.PLUGIN_SPEC_PATTERN
export const RUN_STDOUT_MAX_BYTES = controlPlaneModule.RUN_STDOUT_MAX_BYTES
export const WRITE_FILE_MAX_BYTES = controlPlaneModule.WRITE_FILE_MAX_BYTES

// Protected-plugin READ face (protected-plugins.ts): P = B₀ ∪ S ∪ F derivation and the
// read-face row projection, same single source as the whitelist family. The user plugin
// write face was retired with the 2026-09 C layering ruling, so no mutation-decision
// re-export lives here anymore.
export const derivePluginRows = controlPlaneModule.derivePluginRows
export const deriveProtectedSet = controlPlaneModule.deriveProtectedSet
export const PLUGIN_MATERIALIZED_VALUE_MASK = controlPlaneModule.PLUGIN_MATERIALIZED_VALUE_MASK
export const readInstalledVersion = controlPlaneModule.readInstalledVersion
export const resolveRuntimeFamily = controlPlaneModule.resolveRuntimeFamily

// Owner-private file primitives (private-file.ts): the single 0600 atomic-replace /
// no-follow read mechanism for credential mirrors, settings store, undo journal and ledger.
export const ensurePrivateDirectoryNoFollow = controlPlaneModule.ensurePrivateDirectoryNoFollow
export const atomicWritePrivateFileNoFollow = controlPlaneModule.atomicWritePrivateFileNoFollow
export const readPrivateFileNoFollow = controlPlaneModule.readPrivateFileNoFollow

// Owner-only audit-trail core (audit-trail.ts): the shared serializer + hardened
// append/rotate behind the desktop audit log and the gateway audit.
export const appendAuditTrailLine = controlPlaneModule.appendAuditTrailLine
export const serializeAuditEvent = controlPlaneModule.serializeAuditEvent
export const AUDIT_TRAIL_MAX_BYTES = controlPlaneModule.AUDIT_TRAIL_MAX_BYTES

// Gateway wire-protocol credential/session facts + SPKI pin helpers (the cross-shape single
// source, imported by the gateway server too, so client and server cannot drift on cookie
// name/TTL/bounds/caps) — consumed by gateway-session and gateway-provider.
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


// Types ride the same single source; type-only exports are erased at build time, so the re-export costs nothing at runtime.
export type {
  AuditTrailEvent,
  ChamberHostPackageDescriptor,
  ClientRequestEnvelope,
  CordisInsert,
  DerivePluginRowsInput,
  FamilyVersions,
  HostPackageInsert,
  HostPackageSeedFile,
  InsertConflictKind,
  ParsedInsertRow,
  PluginManifestFault,
  PluginManifestModel,
  PluginManifestParseResult,
  PluginRow,
  PluginRowRole,
  ProtectedDerivation,
  ProtectedFacts,
  ProtectedSet,
  ProtectedSource,
  RawUnaryOutcome,
  ReadAllRequest,
  ReadRequest,
  RuntimeFamilyResolution,
  ServerResponseEnvelope,
  ServerResponseParse,
  SessionStateCapability,
  SessionStateCapabilityKind,
  SessionStateCompletedAtSource,
  SessionStateDegradationCode,
  SessionStateDelta,
  SessionStateDescriptor,
  SessionStateFeature,
  SessionStateHostInfo,
  SessionStateHostState,
  SessionStateMode,
  SessionStatePendingKind,
  SessionStateProbeFailureReason,
  SessionStateProbeOutcome,
  SessionStateReadState,
  SessionStateRow,
  SessionStateSnapshot,
  SessionTurnEnd,
  SessionTurnEndCause,
  SessionTurnEndDisposition,
  SessionTurnEndKind,
  StateRootLease,
  StateRootLeaseFlavor,
  StateRootLeaseScope,
} from '@dsh-chamber/control-plane'
