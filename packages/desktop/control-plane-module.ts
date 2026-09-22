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

/**
 * Assembled-sidecar marker (design 25 §3.2/§4.3, W-23): the Swift Supervisor
 * spawns `<sidecar>/sidecar.js` with `DSH_CHAMBER_SIDECAR_COMPILED=1`, where the
 * workspace bare specifier is unresolvable (no node_modules tree) and the
 * compiled artifact sits at `<sidecar>/dist/control-plane/index.js` — exactly
 * the relative entry this module already resolves. Explicit and env-driven:
 * never guessed from process shape, and never set by the Electron shell.
 */
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
// The canonical legacy session/list shape predicate (rpc-envelope.ts, 2.1
// audit) — consumed by ssh-provider's legacy dsh-signature arm and the
// startup-host activation-probe seam; the same judgement the control plane's
// dsh-client applies.
export const isLegacyHostProbeValue = controlPlaneModule.isLegacyHostProbeValue

// Cordis loader insert primitives (cordis-inserts.ts) — consumed by
// plugin-sync.
export const renderCordisInserts = controlPlaneModule.renderCordisInserts
export const parseLoaderRows = controlPlaneModule.parseLoaderRows
export const hasExactInsert = controlPlaneModule.hasExactInsert
export const fieldCount = controlPlaneModule.fieldCount
export const insertConflict = controlPlaneModule.insertConflict

// Chamber host-package insert facts (host-graph-seed.ts, design 09 module A /
// design 13 §3 — re-exported by the control-plane package index) — consumed
// by plugin-sync, whose desktop-facing package-name/insert-id constants
// derive from these so the local seed, the remote seed writer and
// control-plane's own seed can never drift.
export const HOST_GRAPH_INSERT = controlPlaneModule.HOST_GRAPH_INSERT
export const HOST_GIT_WORKTREE_INSERT = controlPlaneModule.HOST_GIT_WORKTREE_INSERT
export const HOST_ARCHIVE_CLEANUP_INSERT = controlPlaneModule.HOST_ARCHIVE_CLEANUP_INSERT
export const HOST_OPEN_IN_INSERT = controlPlaneModule.HOST_OPEN_IN_INSERT
// The canonical host-seed namespace + its fail-loud assertion (Batch 1 naming
// unification, 2026-09) — consumed by plugin-sync's remote cordis.patch.yml
// merge, which must also recognize the pre-rename names to fold them once.
export const HOST_SEED_PACKAGE_PREFIX = controlPlaneModule.HOST_SEED_PACKAGE_PREFIX
export const assertHostSeedInsertNaming = controlPlaneModule.assertHostSeedInsertNaming
// The authoritative chamber host-package registry (name + insert id + liveness
// probe): the desktop derives every chamber row/probe from it — never a
// hand-maintained parallel list (2026-09 user decision).
export const CHAMBER_HOST_PACKAGES = controlPlaneModule.CHAMBER_HOST_PACKAGES
// The seeded file set + the local `--patch` overlay filename (host-graph-seed.ts
// single source, forwarded by the control-plane index) — consumed by
// plugin-sync.ts (remote seed writer / install probes / overlay resolution)
// and gateway-provider.ts (the gateway upload payload keys), both of which
// used to re-type ['package.json','dist/index.js'] and the overlay filename.
export const HOST_PACKAGE_SEED_FILES = controlPlaneModule.HOST_PACKAGE_SEED_FILES
export const HOST_GRAPH_PATCH_FILENAME = controlPlaneModule.HOST_GRAPH_PATCH_FILENAME

// Plugin spec/name whitelist family (the reserved-name deny predicate is retired;
// `protected-plugins.ts` owns the judgement, design 21 §6.11)
// (plugin-spec.ts, design 21 §6.2/§6.7 — the shared source for the desktop
// main (ssh-provider re-export / plugin-sync) and the gateway executor) —
// consumed by ssh-provider.ts and plugin-sync.ts.
export const extractSpecName = controlPlaneModule.extractSpecName
export const MATERIALIZE_FILE_SPEC_PATTERN = controlPlaneModule.MATERIALIZE_FILE_SPEC_PATTERN
export const MAX_PLUGIN_SPEC_CHARS = controlPlaneModule.MAX_PLUGIN_SPEC_CHARS
export const PLUGIN_NAME_PATTERN = controlPlaneModule.PLUGIN_NAME_PATTERN
export const PLUGIN_SPEC_PATTERN = controlPlaneModule.PLUGIN_SPEC_PATTERN
export const RUN_STDOUT_MAX_BYTES = controlPlaneModule.RUN_STDOUT_MAX_BYTES
export const WRITE_FILE_MAX_BYTES = controlPlaneModule.WRITE_FILE_MAX_BYTES

// Protected-plugin set + generation coupling (protected-plugins.ts, design 21
// §6.11) — the op-phased write-face decision (install/remove judge P alike;
// remove never judges a version) and the read-face row projection consumed by
// the desktop main's local/ssh plugin surfaces and the gateway. Same single
// source as the whitelist family above.
export const decidePluginMutation = controlPlaneModule.decidePluginMutation
export const derivePluginRows = controlPlaneModule.derivePluginRows
export const deriveProtectedSet = controlPlaneModule.deriveProtectedSet
export const familyNamesFromLockfileClosure = controlPlaneModule.familyNamesFromLockfileClosure
export const familyNamesFromRuntimeTree = controlPlaneModule.familyNamesFromRuntimeTree
export const isExactVersion = controlPlaneModule.isExactVersion
export const isMaterializedValue = controlPlaneModule.isMaterializedValue
export const officialScope = controlPlaneModule.officialScope
export const OFFICIAL_SCOPE = controlPlaneModule.OFFICIAL_SCOPE
export const CHAMBER_SCOPE = controlPlaneModule.CHAMBER_SCOPE
export const PROFILE_BUNDLES_SNAPSHOT = controlPlaneModule.PROFILE_BUNDLES_SNAPSHOT
export const PLUGIN_MATERIALIZED_VALUE_MASK = controlPlaneModule.PLUGIN_MATERIALIZED_VALUE_MASK
export const protectedReason = controlPlaneModule.protectedReason
export const readInstalledVersion = controlPlaneModule.readInstalledVersion
export const registrySpecVersion = controlPlaneModule.registrySpecVersion
export const resolveRuntimeFamily = controlPlaneModule.resolveRuntimeFamily
export const sameGeneration = controlPlaneModule.sameGeneration
export const verifyProfileFamilyConsistency = controlPlaneModule.verifyProfileFamilyConsistency
export const describeFamilyFindings = controlPlaneModule.describeFamilyFindings
export const suggestExactSpec = controlPlaneModule.suggestExactSpec

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

// Session-state wire contract (control-plane session-state-protocol.ts, plan
// of record docs/progress/todo/remote-session-state-and-switch.md §4;
// protocol-compat-blueprint §8.1) — ONE source for the protocol version,
// feature ids, descriptor classification, read-mark merge and turn/end
// classification shared with the gateway watcher. The desktop session-facts
// probe consumes it through this facade because the packaged desktop cannot
// import a workspace package from node_modules (see the module header). The
// re-exports below require packages/control-plane/src/index.ts to export the
// module (the facade resolves `typeof import('@dsh-chamber/control-plane')` to
// that package root).
export const PROTOCOL_VERSION = controlPlaneModule.PROTOCOL_VERSION
export const SESSION_STATE_PROTOCOL_VERSION = controlPlaneModule.SESSION_STATE_PROTOCOL_VERSION
export const SESSION_STATE_FEATURES = controlPlaneModule.SESSION_STATE_FEATURES
export const SESSION_STATE_BASE_FEATURES = controlPlaneModule.SESSION_STATE_BASE_FEATURES
export const SESSION_STATE_DEGRADATION_CODES = controlPlaneModule.SESSION_STATE_DEGRADATION_CODES
export const SESSION_STATE_PATH = controlPlaneModule.SESSION_STATE_PATH
export const SESSION_STATE_STREAM_PATH = controlPlaneModule.SESSION_STATE_STREAM_PATH
export const SESSION_STATE_READ_PATH = controlPlaneModule.SESSION_STATE_READ_PATH
export const SESSION_STATE_READ_ALL_PATH = controlPlaneModule.SESSION_STATE_READ_ALL_PATH
export const SESSION_STATE_ROUTES = controlPlaneModule.SESSION_STATE_ROUTES
export const SESSION_STATE_READ_BODY_MAX_BYTES = controlPlaneModule.SESSION_STATE_READ_BODY_MAX_BYTES
export const SESSION_STATE_CLIENT_ID_PATTERN = controlPlaneModule.SESSION_STATE_CLIENT_ID_PATTERN
export const SESSION_STATE_SESSION_ID_MAX_CHARS = controlPlaneModule.SESSION_STATE_SESSION_ID_MAX_CHARS
export const SESSION_STATE_PROBE_TIMEOUT_MS = controlPlaneModule.SESSION_STATE_PROBE_TIMEOUT_MS
export const SESSION_STATE_HANDSHAKE_WINDOW_MS = controlPlaneModule.SESSION_STATE_HANDSHAKE_WINDOW_MS
export const parseSessionStateDescriptor = controlPlaneModule.parseSessionStateDescriptor
export const sessionStateFeatureSupport = controlPlaneModule.sessionStateFeatureSupport
export const classifySessionStateProbe = controlPlaneModule.classifySessionStateProbe
export const sessionStateNoteKey = controlPlaneModule.sessionStateNoteKey
export const mergeReadMark = controlPlaneModule.mergeReadMark
export const effectiveReadMark = controlPlaneModule.effectiveReadMark
export const classifyTurnEnd = controlPlaneModule.classifyTurnEnd

// Types ride the same single source; type-only exports are erased at build
// time, so re-exporting from the workspace package costs nothing at runtime.
export type {
  AuditTrailEvent,
  ChamberHostPackageDescriptor,
  ClientRequestEnvelope,
  CordisInsert,
  DecidePluginMutationInput,
  DerivePluginRowsInput,
  FamilyConsistencyFinding,
  FamilyConsistencyVerdict,
  FamilyVersions,
  HostPackageInsert,
  HostPackageSeedFile,
  InsertConflictKind,
  ParsedInsertRow,
  ParsedVersion,
  PluginMutationDecision,
  PluginMutationOp,
  PluginRefusalCode,
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
} from '@dsh-chamber/control-plane'
