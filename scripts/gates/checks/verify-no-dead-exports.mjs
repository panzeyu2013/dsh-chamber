/**
 * Dead-export gate (G-H) - every package entry's public surface must have
 * production consumers.
 *
 * WHY. A package's src/index.ts declares its public surface: direct
 * declarations plus re-exported modules. A wholesale export-* barrel or a stale
 * named re-export can grow without anyone importing the result. An export
 * nothing imports is a face with no consumer: it invites a second implementation
 * (the exact anti-pattern this refactor removes), it makes a future rename look
 * like API, and it hides which parts of the model are actually wired.
 *
 * WHAT IS CHECKED. Every first-party workspace package (the package list is
 * derived from pnpm-workspace.yaml - no package is named in this file) with a
 * src/index.ts. Every runtime export reachable through that index must be
 * named by a production importer: a named import, a namespace/default member
 * access, a dynamic-import member or a re-export in any .ts/.tsx/.mts/.mjs
 * file under packages/ or scripts/, the package's own production files
 * included, excluding tests and build output. An import through the package
 * specifier and a relative import that resolves inside the package directory are
 * the same consumer (the implementation is used either way; only the entry
 * re-export face is judged). An export with no importer is red unless it is
 * covered by a documented exemption.
 *
 * KNOWN REMAINING HOLE (measured 2026-09): the own-entry skip below covers the
 * \`import {…} from\` loop only. A package's own \`export {…} from\` barrel line still
 * counts as a consumer, so barrel-only names stay green. Completing the skip there
 * surfaces 31 test-only runtime exports across control-plane (15), dsh-runtime (14),
 * client-core (1) and one more package; each needs a TEST_ONLY_EXPORT_ALLOWLIST
 * entry or a consumer, which is a barrel-policy decision, not a drive-by edit.
 *
 * TEST-ONLY EXPORTS. An export reachable from an entry with no production
 * importer but named by a test still needs a reason: TEST_ONLY_EXPORT_ALLOWLIST
 * names it with the reviewer's reason (typically a pinned constant the suite
 * asserts, or a state seam the suite owns). The list may not lie: an entry whose
 * export gains a production importer, or loses every test importer, is red.
 *
 * NOT JUDGED, but named with a reason so the skip is auditable:
 * - RUNTIME_LOADED_PACKAGES: entries the dsh plugin loader / host-graph insert
 *   loads at runtime by package name - no static importer exists by design. The
 *   package's NON-root public entries are still judged through the client-seam
 *   table below (a client-plugin package is not a blanket skip).
 * - RUNTIME_LOADED_CLIENT_SEAMS: the browser half of a client-plugin package is a
 *   package.json export subpath the composite entry loads by package name; the
 *   client-plugin loader reads the namespace and calls apply() / reads inject, so
 *   each seam lists those ABI names instead of relying on an importer. Every other
 *   runtime export reachable from a non-root public entry (`./client` and extra
 *   subpaths such as `./section`) is judged like a package root.
 * - CLIENT_SEAM_SKIPS: a client-plugin package whose client half is replayed from
 *   the upstream pin (dsh-api-gateway, dsh-client-connection) is not
 *   chamber-authored surface; an in-repo importer rule would flag upstream API
 *   and force edits that break the fork-replay discipline. The reason is recorded.
 * - PENDING_PACKAGES: barrel narrowing assigned to another owner. The dead faces
 *   are still counted and printed, but do not fail this run. A pending package
 *   with no dead export is a zombie entry and FAILS - the list can only shrink
 *   as owners land their narrowing.
 * - TYPE-ONLY exports (interfaces, type aliases, `export type` faces and inline
 *   `type` modifiers in a named re-export group): erased at runtime and often the
 *   contract's documentation face; judging them by "an importer names the type"
 *   would flag the many types read only in type positions. Ruling
 *   (upstream-drift V2): they stay out of this gate - narrowing a type that lost
 *   its last consumer is a review duty, not a script verdict.
 *
 *
 * IMPLEMENTATION-SURFACE PACKAGES. A package whose public entry is a thin
 * loader can carry a shipped implementation tree that no index re-export
 * reaches (the client-plugin ./client half is the motivating case).
 * INTERNAL_SURFACE_PACKAGES names such packages with their implementation
 * roots and the entry files that stay entry-level; every runtime export under
 * those roots is live when a production importer names it OR its own module
 * reads it, and anything else needs an INTERNAL_SURFACE_ALLOWLIST entry with
 * the reason a reviewer accepted. Stale allowlist entries are red.
 * EXEMPTIONS. DEAD_EXPORT_EXEMPTIONS names a real dead export per package, with
 * the reason a reviewer accepted and where the consumer lands. A stale exemption
 * (the export is imported or gone) is red: the list may not lie.
 *
 * RETIRED PLUGIN WRITE SURFACE. The 2026-09 C layering ruling (D1) deleted every
 * user-reachable plugin write IPC method; RETIRED_PLUGIN_WRITE_FACE_NAMES is the
 * single owner of that set, and this gate scans the shipped surfaces (package
 * sources incl. the renderer type face, the desktop sidecar stub and the native
 * shell's shim/manifest sources) so a write method cannot quietly reappear in a
 * surface the read-face lockstep suite does not walk. Tests, generated output,
 * vendor trees and docs are not scanned: the names legitimately live there.
 *
 * NEGATIVE CONTROL: --self-test drives the pure resolvers with fabricated module
 * lists: an orphan export is reported, an exemption silences it, a stale exemption
 * is flagged, the index parser does not mistake comment text for an export name
 * and drops type-only re-exports, the client-seam verdict reports an unimported
 * export but respects the registered ABI names and flags a stale ABI entry, the
 * coverage verdict reports an unregistered client plugin and a zombie row, and the
 * retired write-face scanner detects a reappearance in a fabricated shim source.
 *
 * Usage:
 *   node scripts/gates/checks/verify-no-dead-exports.mjs            # gate
 *   node scripts/gates/checks/verify-no-dead-exports.mjs --self-test
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { walkFiles } from '../../lib/walk.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '../../..')

/**
 * Exports with no production importer, each with the reason a reviewer accepted
 * and the consumer landing point. package is the directory name under
 * packages/; every entry must name a REAL dead export (a stale exemption fails).
 * @type {readonly { package: string, name: string, reason: string }[]}
 */
export const DEAD_EXPORT_EXEMPTIONS = [
  // Table value surface: the constants are consumed through CARRIER_ENV /
  // TABLE_SNAPSHOT by the reducer, the api-gateway and the G-G parity gate. The
  // values are the table's public record, so there is no direct importer by design.
  { package: 'dsh-stream-state', name: 'REBUILD_WINDOW_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'MAX_REBUILDS_PER_WINDOW', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'MIN_REBUILD_SPACING_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'IN_FLIGHT_GRACE_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'OPENING_STALL_STREAK', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  // Aggregate reducer kept for the ladder's suite only.
  { package: 'dsh-stream-state', name: 'collapseRecords', reason: 'ladder internal; used by planLadder + its suite' },
  // Upstream host-plugin entry (src/index.ts is a [pure] mirror of the upstream
  // package, C1 byte-identical): name/inject/Config are the cordis plugin ABI
  // the dsh loader reads at runtime; the browser half is imported through the
  // ./client subpath and does not consume the root entry.
  { package: 'dsh-client-connection', name: 'name', reason: 'upstream [pure] host-plugin entry: loader reads the plugin name at runtime (no static importer)' },
  { package: 'dsh-client-connection', name: 'inject', reason: 'upstream [pure] host-plugin entry: cordis reads inject at load time (no static importer)' },
  { package: 'dsh-client-connection', name: 'Config', reason: 'upstream [pure] host-plugin entry: config schema consumed by the dsh loader (no static importer)' },
]

/**
 * Test-only runtime exports (upstream-drift V1): no production importer, but at
 * least one suite imports the name. The reason names the suite that owns it;
 * the export retires when that suite stops needing it.
 * @type {readonly { package: string, name: string, reason: string }[]}
 */
export const TEST_ONLY_EXPORT_ALLOWLIST = [
  // Differential harness: the equivalence suite imports the normalizer and the
  // comparator directly (scripts/refactor/equivalence.mjs imports the reducers).
  { package: 'dsh-stream-state', name: 'reasonClassOf', reason: 'differential normalizer consumed by the equivalence suite (test/equivalence)' },
  { package: 'dsh-stream-state', name: 'equivalents', reason: 'differential comparison consumed by the equivalence suite (test/equivalence)' },
  // Replay faces driven by the carrier/source vectors in the package suite.
  { package: 'dsh-stream-state', name: 'decideRebuild', reason: 'pure rebuild predicate replayed by the carrier vectors in the package suite' },
  { package: 'dsh-stream-state', name: 'reduceSourceSequence', reason: 'source reducer replay face driven by the package vectors' },
  // Presentation outer-bound helpers superseded by decidePresentation/planVeilTimer
  // in production, kept for the suite's bound cases.
  { package: 'dsh-stream-state', name: 'surfaceBoundMs', reason: 'outer-bound helper asserted by the package suite; retires when the frame API covers the bound cases' },
  { package: 'dsh-stream-state', name: 'veilUpperBoundMs', reason: 'outer-bound helper asserted by the package suite; retires when the frame API covers the bound cases' },
  // Upstream [pure] host-plugin entry: the loader calls apply() by plugin ABI; the
  // C1 byte-parity suite imports it for the comparison.
  { package: 'dsh-client-connection', name: 'apply', reason: 'upstream [pure] host-plugin entry: dsh loader calls apply() by plugin ABI; the byte-parity suite imports it' },
  // The proxy ⇄ client budget contract (design 27 §3.4): NET_BUDGET now has a
  // PRODUCTION importer (the proxy's header window), so it is not test-only; the
  // worst-case helper is consumed by the contract test (the client must outlive it).
  { package: 'dsh-chamber-wire', name: 'proxyWorstCaseMs', reason: 'proxy worst case asserted by the budget-contract test (the client must outlive it)' },
  // P0-1: the inbound+flush total is the number the client budget must outlive;
  // only the contract suite names it (production composes it through
  // mutationCallBudgetMs).
  { package: 'dsh-chamber-wire', name: 'proxyTotalWorstCaseMs', reason: 'inbound+flush total asserted by the budget-contract test (the client must outlive it)' },
]

/**
 * Package entries loaded at runtime by name, so their root index has no static
 * importer by design. Each entry carries the reason; none of these packages'
 * root exports is judged as a dead face. A client-plugin package's browser half
 * is still judged through RUNTIME_LOADED_CLIENT_SEAMS below.
 * @type {Readonly<Record<string, string>>}
 */
export const RUNTIME_LOADED_PACKAGES = {
  'dsh-chamber-seed-client-graph': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-seed-git-worktree': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-seed-archive-cleanup': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-seed-open-in': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-client-ui-browser': 'client-plugin loader: the composite entry imports the ./client half by package name (deferred chunk); the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-git': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-layout': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-open-in': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-settings-bridge': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-settings-connections': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-sidebar': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
}

/**
 * Client-plugin seams: the browser half of these packages is a package.json export
 * subpath that the composite entry (renderer/src/chamber-entry.ts) loads by package
 * name. The client-plugin loader reads the module namespace and calls apply() /
 * reads inject, so those ABI names have no static importer by design - the seam
 * lists them per package instead of exempting the whole package. Every OTHER
 * runtime export reachable from a non-root public entry (`./client` and extra
 * subpaths such as `./section`, `./machine-catalog`, `./stream-health-probe`) is
 * judged like a package root, with the seam entry's own re-export lines excluded
 * from its consumer set. The table MUST cover every discovered client-plugin
 * package (a manifest declaring `dsh.client`; a package without a resolvable
 * `./client` export fails loud instead of being registered): a new package is red
 * until its seam is registered with a reason, and a row whose package stopped
 * matching is a zombie (red). `abi` stays honest: a listed name that gained a
 * production importer or disappeared from the client entry is a stale exemption.
 * @type {readonly { package: string, reason: string, abi: readonly string[] }[]}
 */
export const RUNTIME_LOADED_CLIENT_SEAMS = [
  { package: 'dsh-chamber-client-ui-browser', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client as a deferred chunk (design 28 Browser fork); the root . is the host-plugin ABI' },
  { package: 'dsh-chamber-client-ui-git', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client at build time (design 08 Git worktree); the root . is the host-plugin ABI' },
  { package: 'dsh-chamber-client-ui-layout', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client at build time (design 06 layout fork, the only root-slot declarer); the root . is the host-plugin ABI' },
  { package: 'dsh-chamber-client-ui-open-in', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client at build time (designs 16/20 open-in + the stream-health seat); the root . is the host-plugin ABI' },
  { package: 'dsh-chamber-client-ui-settings-bridge', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client at build time (design 05 settings shell); the root . is the host-plugin ABI' },
  { package: 'dsh-chamber-client-ui-settings-connections', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client at build time (design 05 connections page); the root . is the host-plugin ABI' },
  { package: 'dsh-chamber-client-ui-settings-plugin-manager', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client at build time (design 05 plugin-manager section); the package has no root src/index.ts, so ./client is its only public face' },
  { package: 'dsh-chamber-client-ui-sidebar', abi: ['apply', 'inject'], reason: 'the composite entry loads ./client at build time (design 05 sidebar shell); the root . is the host-plugin ABI' },
]

/**
 * Client-plugin packages deliberately outside the seam judgment, each with the
 * reason. Both are client halves replayed from the upstream pin, not
 * chamber-authored surface: judging them by in-repo importers would flag upstream
 * client API (installConnection/SYSTEM_RESUME_EVENT/isRemoteFailure) that the
 * official runtime consumes at load time, and "fixing" that would break the C1
 * byte-parity / fork-replay discipline. Recorded so a new client plugin cannot
 * join this skip without a reviewed reason.
 * @type {Readonly<Record<string, string>>}
 */
export const CLIENT_SEAM_SKIPS = {
  'dsh-api-gateway': 'fork of the official api-gateway client half (registry fork.dsh-api-gateway): the client entry replays the upstream surface, so in-repo importer status is not the owning contract',
  'dsh-client-connection': '[pure] mirror of the official connection client + per-entry base-path patch (C1 byte parity): the client entry is upstream API the official runtime loads by name, not chamber-authored surface',
}

/**
 * Packages whose barrel narrowing is owned by another writer while a migration
 * lands. Their dead faces are counted and printed but do not fail this run; an
 * entry that no longer has a dead export is a zombie and fails instead. The
 * table is empty after the client-core barrel converged (R4 P3/P3b): its tests
 * now reference package-local sources, so a new entry is a deliberate,
 * time-boxed suppression, never a default.
 * @type {Readonly<Record<string, { owner: string, reason: string, retiresWhen: string }>>}
 */
export const PENDING_PACKAGES = {}

/**
 * Entryless first-party packages: no src/index.ts, so the judged surface is
 * every runtime export of their production files. Both are entry-shaped (the
 * Electron main process and the renderer app), and their exports are still a
 * public surface: other packages and scripts import them. Loader/bundle entry
 * files are skipped — their exports are consumed by Electron/Vite
 * configuration, not by an import.
 */
export const ENTRYLESS_PACKAGES = [
  { name: 'desktop', spec: '@dsh-chamber/desktop', ignoreFiles: ['main.ts', 'sidecar-entry.ts'] },
  { name: 'renderer', spec: '@dsh-chamber/renderer', ignoreFiles: ['chamber-entry.ts', 'main.tsx'] },
]

/**
 * Test-only seams of entryless packages: exports whose only consumers are the
 * suites that own the behavior. Every entry must still be a real
 * zero-production-consumer export (stale = red), and a NEW export with no
 * production consumer fails the gate instead of growing this list silently.
 * @type {readonly { package: string, name: string, reason: string }[]}
 */
export const ENTRYLESS_SEAMS = [
  { package: 'renderer', name: '__testShellLifecycleOwnerCounts', reason: 'shell lifecycle suite asserts the owner ledger count; the suite owns the seam' },
  { package: 'renderer', name: '__testLastRequestedSession', reason: 'shell suite reads the last requested session id; the suite owns the seam' },
  { package: 'renderer', name: '__resetSessionFactsGoalWarningForTests', reason: 'session-facts-source suite re-arms the one-shot goal-shape warning; the suite owns the seam' },
  { package: 'renderer', name: 'resetRendererStallEvidence', reason: 'renderer-stall-evidence suite resets the module singleton between cases; the suite owns the seam' },
  { package: 'desktop', name: 'clearGatewaySyncRegistrations', reason: 'gateway-sync-registry suite resets module state between cases' },
  // Remote Browser v4 (design 28) W0/S1 slice. forward-service.ts (the S1
  // assembly) now imports ForwardNamespaces, ForwardChildLedger and
  // reapForwardChildren, so those three seams were retired in that change (the
  // gate flags a seam that gained a production consumer, so they cannot go
  // quietly stale). RETIRE each remaining entry in the same change that imports
  // the name from a production file.
  { package: 'desktop', name: 'FORWARD_SSH_FORBIDDEN_OPTION_NAMES', reason: 'design 28 argv-discipline constant; forward argv golden suite owns it (no production reader by design)' },
  { package: 'desktop', name: 'canForwardTransition', reason: 'design 28 transition table reader for review/suite; the manager drives states through its own patches, so no production reader exists' },
  { package: 'desktop', name: 'FORWARD_REAP_SEMANTICS', reason: 'design 28 crash-window documentation constant; the lifecycle suite asserts it (documentation, not a code path)' },
  { package: 'desktop', name: 'forwardSpawnSupervision', reason: 'design 28 POSIX detached/win32 policy; asserted by the lifecycle suite, the launcher states the same policy inline with its spawn call' },
  { package: 'desktop', name: 'localFrameErrors', reason: 'frozen-Electron-only local-frame store snapshot (design 28 v3 §3 retired forward.list.frameErrors); the forward-service suite asserts the writer/bounding behavior' },
]

/**
 * The retired user plugin WRITE face (2026-09 C layering ruling / D1): IPC
 * method and channel names that must not reappear in any shipped surface. The
 * settings-connections read-face lockstep suite imports this constant, so the
 * set has one owner; the gate scans the surfaces in retiredWriteFaceScanFiles().
 * @type {readonly string[]}
 */
export const RETIRED_PLUGIN_WRITE_FACE_NAMES = Object.freeze([
  'gateway_plugin_apply',
  'gateway_plugin_materialize',
  'plugin_apply',
  'ssh_plugin_undo',
  'npm_search',
  'plugin_materialize_add',
  'local_plugin_add',
  'local_plugin_remove',
])

/**
 * Production files of the shipped surfaces the retired write-face scan covers:
 * every package source (renderer type face, desktop preload/sidecar stub,
 * gateway, settings plugins) plus the native shell sources (bridge shim,
 * generated manifest). Tests, build output, generated trees and vendor trees
 * are excluded - the names legitimately live in suites and docs, never in a
 * shipped surface.
 * @param {string} [repoRoot] - repository root.
 * @returns {string[]} absolute paths, sorted.
 */
export function retiredWriteFaceScanFiles(repoRoot = REPO_ROOT) {
  const sourceFile = (path) => /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|swift|json)$/u.test(path)
  const options = { extraIgnored: ['test', 'tests', 'lib', 'generated', '.tmp'] }
  return [
    ...walkFiles(join(repoRoot, 'packages'), sourceFile, options),
    ...walkFiles(join(repoRoot, 'macos', 'Sources'), sourceFile, options),
  ].sort()
}

/**
 * Pure verdict: the first retired name found in each scanned source. A plain
 * substring match, not a word boundary: desktop_ssh_plugin_apply contains the
 * retired plugin_apply and must count as a reappearance.
 * @param {{ file: string, text: string }[]} sources - scanned file/text pairs.
 * @param {readonly string[]} [names] - the retired set.
 * @returns {{ file: string, name: string }[]} one entry per offending file.
 */
export function retiredWriteFaceViolations(sources, names = RETIRED_PLUGIN_WRITE_FACE_NAMES) {
  const violations = []
  for (const source of sources) {
    const name = names.find((candidate) => source.text.includes(candidate))
    if (name !== undefined) violations.push({ file: source.file, name })
  }
  return violations
}

/** Strip comments so an import/export parser never reads prose as code. */
export function stripComments(sourceText) {
  let out = ''
  let index = 0
  const length = sourceText.length
  while (index < length) {
    const char = sourceText[index]
    const next = sourceText[index + 1]
    if (char === '/' && next === '/') {
      while (index < length && sourceText[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < length && !(sourceText[index] === '*' && sourceText[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '\u0060') {
      out += char
      index += 1
      while (index < length) {
        out += sourceText[index]
        if (sourceText[index] === '\\') {
          index += 1
          if (index < length) out += sourceText[index]
        } else if (sourceText[index] === char) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Parse export-* from './x.ts' (and named re-exports) out of the index. A named
 * group keeps its module (so a missing target is still red) but carries only its
 * RUNTIME names: `export type {…} from` and an inline `type` modifier are erased
 * at runtime and are not a judged face (header: TYPE-ONLY rule).
 */
export function parseIndexModules(indexText) {
  const text = stripComments(indexText)
  const modules = []
  const star = /(?:^|\n)\s*export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gu
  for (const match of text.matchAll(star)) modules.push(match[1])
  const named = /(?:^|\n)\s*export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gu
  for (const match of text.matchAll(named)) {
    const typeOnlyGroup = match[1] !== undefined
    const names = typeOnlyGroup
      ? []
      : match[2].split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '' && !/^type\s+/u.test(item))
        .map((item) => item.split(/\s+as\s+/u)[0].trim())
        .filter(Boolean)
    modules.push({ module: match[3], names })
  }
  return modules
}

/** Runtime exports of one module source (types are erased and not importable values). */
export function extractRuntimeExports(sourceText) {
  const text = stripComments(sourceText)
  const names = []
  const pattern = /(?:^|\n)\s*export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/gmu
  for (const match of text.matchAll(pattern)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** Named imports of one module source: [{ source, names }]. */
export function collectImports(sourceText) {
  const text = stripComments(sourceText)
  const imports = []
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gsu
  for (const match of text.matchAll(pattern)) {
    const names = match[1]
      .split(',')
      .map((name) => name.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim())
      .filter(Boolean)
    imports.push({ source: match[2], names })
  }
  return imports
}

/** Workspace globs (packages: list) from pnpm-workspace.yaml. */
export function workspacePackageGlobs(repoRoot = REPO_ROOT) {
  const text = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const globs = []
  let inPackages = false
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/u.test(line)) { inPackages = true; continue }
    if (!inPackages) continue
    if (line.trim() === '') continue
    if (/^\S/u.test(line)) break
    const match = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/u.exec(line)
    if (match !== null) globs.push(match[1].trim())
  }
  return globs
}

/**
 * Packages whose implementation tree is judged IN ADDITION to the package entry
 * (R4 review): the client-plugin ./client half ships a whole carrier that no
 * index re-export reaches, so an entry-only scan would leave it unjudged.
 * `roots` are package-relative implementation roots; `entryFiles` are
 * package-relative ENTRY files excluded from this tree scan. Their runtime
 * exports are the client-plugin loader ABI (`apply`/`inject` and the ./client
 * entry face) owned by the loader contract, not by this scan — the package ROOT
 * entry (`src/index.ts`) keeps the ordinary entry-level rules above. Self-use
 * counts as live inside the judged tree.
 * @type {Readonly<Record<string, { roots: readonly string[], entryFiles: readonly string[], reason: string }>>}
 */
export const INTERNAL_SURFACE_PACKAGES = {
  'dsh-chamber-client-ui-browser': {
    roots: ['src/client', 'src/shared'],
    entryFiles: ['src/client/index.ts'],
    reason: 'the v3 native-guest carrier (BrowserBridge / guest-state / geometry / keymap / popup-limit / forward bridge) lives in the ./client half; the root index only exports apply(), so the entry-only scan would leave the shipped carrier unjudged',
  },
}

/**
 * Accepted implementation exports with no production importer and no self-use
 * (R4 review 2026-11-10; narrowed by the browser v3 fix batch). Each entry must
 * STAY dead: a production importer, a self-use, or a vanished export makes the
 * entry stale (red), exactly like the other exemption tables. The remaining entry
 * is upstream-verbatim text kept under a SHA lock; the test-only carrier guards
 * that used to be listed here were DELETED with their tests (design 28 v3 §3,
 * D16) instead of being allowlisted, so do not re-add them.
 * @type {readonly { package: string, name: string, reason: string }[]}
 */
export const INTERNAL_SURFACE_ALLOWLIST = [
  // Upstream-verbatim file under a SHA-256 freeze (locks/registration.test.ts): the
  // helper has no v3 reader but deleting it would break the upstream-text lock.
  { package: 'dsh-chamber-client-ui-browser', name: 'browserAddressCheckpoint', reason: 'upstream ui-sidebar-browser text kept verbatim under the package SHA lock; the v3 state push carries the address, so it has no reader and must stay for byte-identity' },
]
/**
 * First-party packages with a src/index.ts: the package list comes from
 * pnpm-workspace.yaml globs, filtered to direct children of packages/.
 * @returns {{ name: string, dir: string, spec: string, index: string }[]}
 */
export function discoverPackages(repoRoot = REPO_ROOT) {
  const dirs = new Set()
  for (const glob of workspacePackageGlobs(repoRoot)) {
    const star = glob.indexOf('*')
    if (star === -1) { dirs.add(resolve(repoRoot, glob)); continue }
    const base = glob.slice(0, star).replace(/\/+$/u, '')
    const rest = glob.slice(star + 1).replace(/^\/+/u, '')
    if (base === '' || rest.includes('*') || rest.includes('/')) continue
    const baseDir = resolve(repoRoot, base)
    if (!existsSync(baseDir)) continue
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(join(baseDir, entry.name, rest))
    }
  }
  const packages = []
  for (const dir of [...dirs].sort()) {
    const rel = relative(repoRoot, dir).split(sep).join('/')
    if (!rel.startsWith('packages/') || rel.slice('packages/'.length).includes('/')) continue
    const index = join(dir, 'src', 'index.ts')
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(index) || !existsSync(manifestPath)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    packages.push({ name: rel.slice('packages/'.length), dir, spec: manifest.name, index })
  }
  return packages
}

/**
 * Client-plugin packages: every direct child of packages/ whose manifest declares
 * `dsh.client` (the client-plugin loader's contract). `clientEntry` is the
 * manifest's `./client` export resolved to a path, or null when the manifest
 * declares the client plugin without that export (a broken convention: the loader
 * imports `<pkg>/client` - the caller fails it loud instead of skipping it).
 * `subpaths` lists the package's OTHER public export subpaths (each is
 * source-judged like an entry). Derived from the workspace tree - no package is
 * named here.
 * @returns {{ name: string, dir: string, spec: string, clientEntry: string | null,
 *   subpaths: { subpath: string, file: string }[] }[]}
 */
export function discoverClientPlugins(repoRoot = REPO_ROOT) {
  const base = join(repoRoot, 'packages')
  if (!existsSync(base)) return []
  const plugins = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(base, entry.name)
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    if (manifest.dsh === null || typeof manifest.dsh !== 'object') continue
    if (manifest.dsh.client === null || typeof manifest.dsh.client !== 'object') continue
    const exportsMap = manifest.exports === null || typeof manifest.exports !== 'object' ? {} : manifest.exports
    const targetOf = (target) => {
      if (typeof target === 'string') return target
      if (target === null || typeof target !== 'object') return undefined
      const candidate = target.default ?? target.types
      return typeof candidate === 'string' ? candidate : undefined
    }
    const clientTarget = targetOf(exportsMap['./client'])
    const subpaths = []
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (subpath === '.' || subpath === './client' || subpath === './package.json') continue
      const rel = targetOf(target)
      if (rel === undefined || !/\.(?:ts|tsx|mts|cts)$/u.test(rel)) continue
      subpaths.push({ subpath, file: join(dir, rel) })
    }
    plugins.push({
      name: entry.name,
      dir,
      spec: manifest.name,
      clientEntry: clientTarget === undefined ? null : join(dir, clientTarget),
      subpaths,
    })
  }
  return plugins.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Importer names of one package's entry (see the header for the consumer rule).
 * Every file under packages/ and scripts/ is scanned, including the package's
 * own sources; build output is always excluded.
 * @param {{ scope?: 'production' | 'test', ownEntryFiles?: string[],
 *   skipOwnReExports?: boolean }} [options] - `production` (default) excludes
 *   test files; `test` reads ONLY them (the V1 test-only rule); `ownEntryFiles`
 *   adds more judged entries whose own re-export lines must not self-satisfy
 *   (client seams); `skipOwnReExports` extends the own-entry skip to the
 *   `export {…} from` loop for those files (the barrel-only hole stays for the
 *   package root: closing it is a separate barrel-policy decision).
 * @returns {Set<string>}
 */
export function collectPackageConsumers(pkg, repoRoot = REPO_ROOT, options = {}) {
  const scope = options.scope ?? 'production'
  const imported = new Set()
  const files = [
    ...walkFiles(join(repoRoot, 'packages'), () => true),
    ...walkFiles(join(repoRoot, 'scripts'), () => true),
  ]
  // The package's own root entry declares the surface; a named re-export inside it
  // cannot be its own consumer (that self-satisfaction would mask every barrel-only
  // name - the gate then only ever catches `export *` barrels). Other files in the
  // same package still count: an internal importer is a real consumer of the name.
  const ownEntryFiles = new Set([
    join(pkg.dir, 'src', 'index.ts'),
    join(pkg.dir, 'src', 'index.tsx'),
    ...(options.ownEntryFiles ?? []),
  ])
  for (const absolute of files) {
    if (!/\.(?:ts|tsx|mts|mjs)$/u.test(absolute)) continue
    const rel = relative(repoRoot, absolute).split(sep).join('/')
    if (rel.includes('/dist/') || rel.includes('/lib/')) continue
    const inTest = rel.includes('/test/') || rel.includes('/tests/')
      || /\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|mjs)$/u.test(rel)
    if (scope === 'production' ? inTest : !inTest) continue
    let raw
    try {
      raw = readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    const text = stripComments(raw)
    const inPackage = (source) => {
      if (source === pkg.spec || source.startsWith(pkg.spec + '/')) return true
      if (!source.startsWith('.')) return false
      const resolved = resolve(dirname(absolute), source)
      return resolved === pkg.dir || resolved.startsWith(pkg.dir + sep)
    }
    const declaresOwnSurface = ownEntryFiles.has(absolute)
    for (const entry of collectImports(text)) {
      if (!inPackage(entry.source)) continue
      if (declaresOwnSurface) continue
      for (const name of entry.names) imported.add(name)
    }
    const memberAccesses = (binding) => {
      const pattern = new RegExp('\\b' + binding.replace(/[$]/gu, '\\$&') + '\\.([A-Za-z0-9_$]+)\\b', 'gu')
      for (const match of text.matchAll(pattern)) imported.add(match[1])
    }
    for (const match of text.matchAll(/import\s+(?:type\s+)?(?:\*\s+as\s+([A-Za-z0-9_$]+)|([A-Za-z0-9_$]+))\s+from\s+['"]([^'"]+)['"]/gu)) {
      if (!inPackage(match[3])) continue
      const binding = match[1] ?? match[2]
      if (binding !== undefined) memberAccesses(binding)
    }
    for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gsu)) {
      if (!inPackage(match[2])) continue
      if (options.skipOwnReExports === true && declaresOwnSurface) continue
      for (const name of match[1].split(',').map((item) => item.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim()).filter(Boolean)) imported.add(name)
    }
    const dynamicBindings = []
    for (const match of text.matchAll(/const\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=\s*await[\s\S]{0,400}?import\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      if (inPackage(match[2])) dynamicBindings.push(match[1])
    }
    for (const match of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/gsu)) {
      if (!inPackage(match[2])) continue
      for (const name of match[1].split(',').map((item) => item.trim().split(':').pop().split(/\s+as\s+/u)[0].trim()).filter(Boolean)) imported.add(name)
    }
    for (const match of text.matchAll(/await\s+import\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*([A-Za-z0-9_$]+)/gu)) {
      if (inPackage(match[1])) imported.add(match[2])
    }
    for (const binding of dynamicBindings) memberAccesses(binding)
  }
  return imported
}

/**
 * Read one package entry surface from disk. `entry` defaults to the package root
 * (`src/index.ts`); a client seam passes its `./client` (or extra subpath) entry,
 * and local re-exports resolve from that entry's own directory.
 * @returns {{ indexText: string, modules: { package: string, file: string, names: string[], missing?: true }[] }}
 */
export function readModules(pkg, repoRoot = REPO_ROOT, entry = pkg.index) {
  const indexText = readFileSync(entry, 'utf8')
  const modules = []
  const indexRel = relative(repoRoot, entry).split(sep).join('/')
  const baseDir = dirname(entry)
  for (const name of extractRuntimeExports(indexText)) modules.push({ package: pkg.name, file: indexRel, names: [name] })
  for (const entryModule of parseIndexModules(indexText)) {
    const module = typeof entryModule === 'string' ? entryModule : entryModule.module
    const file = join(baseDir, module.replace(/^\.\//u, ''))
    const relFile = relative(repoRoot, file).split(sep).join('/')
    if (!existsSync(file)) {
      modules.push({ package: pkg.name, file: relFile, names: [], missing: true })
      continue
    }
    const names = typeof entryModule === 'string'
      ? extractRuntimeExports(readFileSync(file, 'utf8'))
      : entryModule.names
    modules.push({ package: pkg.name, file: relFile, names })
  }
  return { indexText, modules }
}

/**
 * Pure verdict: which declared runtime exports no importer names.
 * @returns {{ dead: { name: string, file: string, package?: string }[], checked: number }}
 */
export function deadExports(modules, imported, exemptions = DEAD_EXPORT_EXEMPTIONS) {
  const exempted = new Set()
  for (const entry of exemptions) {
    exempted.add(entry.package === undefined ? '\u0000' + entry.name : entry.package + '\u0000' + entry.name)
  }
  const dead = []
  let checked = 0
  for (const module of modules) {
    for (const name of module.names) {
      checked += 1
      if (imported.has(name)) continue
      if (exempted.has('\u0000' + name) || exempted.has((module.package ?? '') + '\u0000' + name)) continue
      const entry = { name, file: module.file }
      if (module.package !== undefined) entry.package = module.package
      dead.push(entry)
    }
  }
  return { dead, checked }
}

/**
 * Pure verdict for the V1 test-only rule: entries' runtime exports that no
 * production importer names but a test does. Each needs an allowlist reason.
 * @returns {{ unallowed: { name: string, file: string, package?: string }[], stale: typeof TEST_ONLY_EXPORT_ALLOWLIST, checked: number }}
 */
export function testOnlyExports(modules, productionImported, testImported, allowlist = TEST_ONLY_EXPORT_ALLOWLIST) {
  const allowed = new Map()
  for (const entry of allowlist) allowed.set((entry.package ?? '') + '\u0000' + entry.name, entry)
  const used = new Set()
  const unallowed = []
  let checked = 0
  for (const module of modules) {
    for (const name of module.names) {
      if (productionImported.has(name)) continue
      if (!testImported.has(name)) continue
      checked += 1
      const key = (module.package ?? '') + '\u0000' + name
      if (allowed.has(key)) { used.add(key); continue }
      const entry = { name, file: module.file }
      if (module.package !== undefined) entry.package = module.package
      unallowed.push(entry)
    }
  }
  return { unallowed, stale: allowlist.filter((entry) => !used.has((entry.package ?? '') + '\u0000' + entry.name)), checked }
}

/** Exemptions that no longer name a dead export (stale = the list would lie). */
export function staleExemptions(modules, imported, exemptions = DEAD_EXPORT_EXEMPTIONS) {
  const dead = new Set(deadExports(modules, imported, []).dead.map((entry) => (entry.package ?? '') + '\u0000' + entry.name))
  return exemptions.filter((entry) => !dead.has((entry.package ?? '') + '\u0000' + entry.name))
}

/**
 * Pure verdict for entryless packages: declared runtime exports with no
 * production consumer and no seam entry.
 * @returns {{ dead: { name: string, file: string }[], checked: number }}
 */
export function entrylessDeadExports(modules, imported, seams = ENTRYLESS_SEAMS) {
  const allowed = new Set(seams.map((entry) => entry.name))
  const dead = []
  let checked = 0
  for (const module of modules) {
    const selfUsed = new Set(module.selfUsed ?? [])
    for (const name of module.names) {
      checked += 1
      // An export its own module still reads is not dead — only unnecessarily
      // exported. The judged surface is "nobody (outside or inside) reads it".
      if (imported.has(name) || selfUsed.has(name) || allowed.has(name)) continue
      dead.push({ name, file: module.file })
    }
  }
  return { dead, checked }
}

/** Seam entries that no longer name a zero-consumer export (stale = red). */
export function staleEntrylessSeams(modules, imported, seams = ENTRYLESS_SEAMS) {
  const dead = new Set(entrylessDeadExports(modules, imported, []).dead.map((entry) => entry.name))
  return seams.filter((entry) => !dead.has(entry.name))
}

/**
 * Pure verdict for one registered client seam: runtime exports reachable from the
 * seam's non-root public entries that no production importer names, plus ABI names
 * whose exemption no longer holds. `abi` covers only names declared by the client
 * ENTRY modules (the loader reads that namespace); an extra public subpath gets no
 * ABI allowance because a static importer is supposed to name its exports.
 * @returns {{ dead: { name: string, file: string }[], staleAbi: string[], checked: number }}
 */
export function clientSeamVerdict(entryModules, subpathModules, imported, abi) {
  const entryNames = new Set()
  for (const module of entryModules) for (const name of module.names) entryNames.add(name)
  const abiNames = new Set(abi)
  const dead = []
  let checked = 0
  for (const module of [...entryModules, ...subpathModules]) {
    for (const name of module.names) {
      checked += 1
      if (imported.has(name)) continue
      if (entryNames.has(name) && abiNames.has(name)) continue
      dead.push({ name, file: module.file })
    }
  }
  const staleAbi = abi.filter((name) => imported.has(name) || !entryNames.has(name))
  return { dead, staleAbi, checked }
}

/**
 * Coverage verdict for the client-seam tables: every discovered client-plugin
 * package must be registered (judged or skipped with a reason) and every row must
 * still match a discovered package.
 * @returns {{ unregistered: string[], zombies: string[], conflicts: string[] }}
 */
export function clientSeamCoverage(discovered, seams = RUNTIME_LOADED_CLIENT_SEAMS, skips = CLIENT_SEAM_SKIPS) {
  const registered = new Set(seams.map((entry) => entry.package))
  const skipped = new Set(Object.keys(skips))
  // A package that declares dsh.client without a resolvable ./client export is not
  // a coverable seam (the caller fails it loud); it must not count as registered.
  const present = new Set(discovered.filter((plugin) => plugin.clientEntry !== null).map((plugin) => plugin.name))
  return {
    unregistered: discovered
      .filter((plugin) => plugin.clientEntry !== null && !registered.has(plugin.name) && !skipped.has(plugin.name))
      .map((plugin) => plugin.name),
    zombies: [...registered, ...skipped].filter((name) => !present.has(name)),
    conflicts: [...registered].filter((name) => skipped.has(name)),
  }
}

/**
 * Strip comments AND string/template literal CONTENTS. Self-use must mean a
 * name really appears in code: a dead export whose name only occurs inside a
 * literal (a comment or a quoted string) is not a consumer; template literals are
 * kept because their ${...} interpolations are real code. A space replaces each
 * literal so adjacent tokens cannot fuse into a false symbol.
 * @param {string} sourceText - module source.
 * @returns {string} source with comments and literal contents removed.
 */
export function stripCommentsAndStrings(sourceText) {
  let out = ''
  let index = 0
  const length = sourceText.length
  while (index < length) {
    const char = sourceText[index]
    const next = sourceText[index + 1]
    if (char === '/' && next === '/') {
      while (index < length && sourceText[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < length && !(sourceText[index] === '*' && sourceText[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'") {
      out += ' '
      index += 1
      while (index < length) {
        if (sourceText[index] === '\\') {
          index += 2
          continue
        }
        if (sourceText[index] === char) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}


/**
 * Names a module reads itself (the export declaration plus at least one more
 * word-boundary occurrence in code, comments stripped). Such an export is an
 * unnecessary `export`, not dead code: the implementation surface rule exempts
 * it. Pure.
 * @param {string} sourceText - module source.
 * @param {readonly string[]} names - its runtime exports.
 * @returns {string[]} self-read names.
 */
export function selfUsedRuntimeExports(sourceText, names, { stripStrings = true, stripComments: stripCommentText = true } = {}) {
  const text = stripStrings
    ? stripCommentsAndStrings(sourceText)
    : stripCommentText ? stripComments(sourceText) : sourceText
  const isWordChar = (char) => /[A-Za-z0-9_$]/.test(char)
  const used = []
  for (const name of names) {
    let count = 0
    let at = text.indexOf(name)
    while (at !== -1) {
      const before = at === 0 ? '' : text[at - 1]
      const after = text[at + name.length] ?? ''
      if (!isWordChar(before) && !isWordChar(after)) count += 1
      at = text.indexOf(name, at + name.length)
    }
    if (count > 1) used.push(name)
  }
  return used
}

/**
 * Read the implementation surface of one INTERNAL_SURFACE_PACKAGES entry:
 * every runtime export under its declared roots, excluding its entry files,
 * with self-use recorded. Returns [] for packages not in the table.
 * @param {{ name: string, dir: string }} pkg - discovered package.
 * @param {string} [repoRoot] - repository root.
 * @returns {{ package: string, file: string, names: string[], selfUsed: string[] }[]}
 */
export function internalSurfaceModules(pkg, repoRoot = REPO_ROOT) {
  const config = INTERNAL_SURFACE_PACKAGES[pkg.name]
  if (config === undefined) return []
  const entryFiles = new Set((config.entryFiles ?? []).map((file) => join(pkg.dir, file)))
  const modules = []
  for (const root of config.roots) {
    const absolute = join(pkg.dir, root)
    if (!existsSync(absolute)) continue
    const files = walkFiles(
      absolute,
      (file) => /\.(?:ts|tsx|mts|cts)$/u.test(file) && !/\.d\.(?:ts|mts|cts)$/u.test(file),
      { extraIgnored: ['test', 'tests', 'test-fixtures', 'scripts', 'vendor', 'generated', 'lib'] },
    )
    for (const file of files) {
      if (entryFiles.has(file)) continue
      const text = readFileSync(file, 'utf8')
      const names = extractRuntimeExports(text)
      if (names.length === 0) continue
      modules.push({
        package: pkg.name,
        file: relative(repoRoot, file).split(sep).join('/'),
        names,
        selfUsed: selfUsedRuntimeExports(text, names),
      })
    }
  }
  return modules
}

/**
 * Pure verdict for one implementation surface: an export is live when a
 * production importer names it or its own module reads it (selfUsed); anything
 * else is red unless INTERNAL_SURFACE_ALLOWLIST names it. Test importers do NOT
 * count, so a test-only internal export needs an allowlist reason too.
 * @returns {{ dead: { package: string, name: string, file: string }[], checked: number }}
 */
export function internalSurfaceDeadExports(modules, imported, allowlist = INTERNAL_SURFACE_ALLOWLIST) {
  const allowed = new Set(allowlist.map((entry) => (entry.package ?? '') + '\u0000' + entry.name))
  const dead = []
  let checked = 0
  for (const module of modules) {
    const selfUsed = new Set(module.selfUsed ?? [])
    for (const name of module.names) {
      checked += 1
      if (imported.has(name) || selfUsed.has(name)) continue
      if (allowed.has((module.package ?? '') + '\u0000' + name)) continue
      dead.push({ package: module.package ?? '', name, file: module.file })
    }
  }
  return { dead, checked }
}

/** Implementation-surface allowlist entries that no longer name a dead face (stale = red). */
export function staleInternalSurfaceAllowlist(modules, imported, allowlist = INTERNAL_SURFACE_ALLOWLIST) {
  const dead = new Set(internalSurfaceDeadExports(modules, imported, []).dead.map((entry) => entry.package + '\u0000' + entry.name))
  return allowlist.filter((entry) => !dead.has((entry.package ?? '') + '\u0000' + entry.name))
}


function selfTest() {
  const modules = [
    { file: 'src/a.ts', names: ['used', 'orphan'] },
    { file: 'src/b.ts', names: ['alsoUsed'] },
  ]
  const verdict = deadExports(modules, new Set(['used', 'alsoUsed']))
  const detected = verdict.dead.length === 1 && verdict.dead[0].name === 'orphan' && verdict.checked === 3
  const exempted = deadExports(modules, new Set(['used', 'alsoUsed']), [{ name: 'orphan', reason: 'scheduled' }])
  const exemptionWorks = exempted.dead.length === 0
  const stale = staleExemptions(modules, new Set(['used', 'alsoUsed', 'orphan']), [{ name: 'orphan', reason: 'scheduled' }])
  const staleDetected = stale.length === 1
  // V1 test-only rule negative controls: report without an entry, silence with a
  // reason, red once the export gains a production importer.
  const testOnlyModules = [{ package: 'pkg', file: 'packages/x/src/index.ts', names: ['pinnedConstant', 'usedInProd'] }]
  const testOnlyVerdict = testOnlyExports(testOnlyModules, new Set(['usedInProd']), new Set(['pinnedConstant', 'usedInProd']), [])
  const testOnlyDetected = testOnlyVerdict.checked === 1 && testOnlyVerdict.unallowed.length === 1
    && testOnlyVerdict.unallowed[0].name === 'pinnedConstant'
  const testOnlyAllowed = testOnlyExports(testOnlyModules, new Set(['usedInProd']), new Set(['pinnedConstant', 'usedInProd']),
    [{ package: 'pkg', name: 'pinnedConstant', reason: 'pinned constant asserted by the suite' }]).unallowed.length === 0
  const testOnlyStale = testOnlyExports(testOnlyModules, new Set(['pinnedConstant', 'usedInProd']), new Set(['pinnedConstant', 'usedInProd']),
    [{ package: 'pkg', name: 'pinnedConstant', reason: 'x' }]).stale.length === 1
  const parsed = parseIndexModules(
    '// comment with { braces } must not parse as an export\n' +
    "export * from './a.ts'\n" +
    'export {\n' +
    '  // another { comment\n' +
    '  used,\n' +
    '  type Face,\n' +
    "} from './b.ts'\n" +
    "export type { TypeOnly } from './c.ts'\n",
  )
  // Comments are not code, an inline `type` modifier is erased, and a type-only
  // group keeps its module (missing-target check) but declares no runtime name.
  const commentsIgnored = parsed.length === 3
    && parsed[1].names.length === 1
    && parsed[1].names[0] === 'used'
    && parsed[2].names.length === 0
  // Client seam negative controls: an unimported export of a non-root public
  // entry is reported, the registered ABI names are exempt while the client entry
  // declares them, and an ABI name that gained a production importer is stale.
  const seamEntryModules = [{ package: 'pkg', file: 'packages/pkg/src/client/index.ts', names: ['apply', 'inject', 'used', 'orphan'] }]
  const seamSubpathModules = [{ package: 'pkg', file: 'packages/pkg/src/client/extra.ts', names: ['subUsed', 'subOrphan'] }]
  const seamVerdict = clientSeamVerdict(seamEntryModules, seamSubpathModules, new Set(['used', 'subUsed']), ['apply', 'inject'])
  const seamDetected = seamVerdict.checked === 6
    && seamVerdict.dead.length === 2
    && seamVerdict.dead.some((item) => item.name === 'orphan')
    && seamVerdict.dead.some((item) => item.name === 'subOrphan')
    && seamVerdict.staleAbi.length === 0
  const seamStale = clientSeamVerdict(seamEntryModules, seamSubpathModules, new Set(['used', 'subUsed', 'apply']), ['apply', 'inject']).staleAbi
  const seamStaleDetected = seamStale.length === 1 && seamStale[0] === 'apply'
  const coverageVerdict = clientSeamCoverage(
    [{ name: 'judged' }, { name: 'skipped' }, { name: 'newcomer' }],
    [{ package: 'judged', reason: 'registered', abi: ['apply'] }, { package: 'gone', reason: 'stale', abi: ['apply'] }],
    { skipped: 'recorded skip reason' },
  )
  const coverageDetected = coverageVerdict.unregistered.length === 1
    && coverageVerdict.unregistered[0] === 'newcomer'
    && coverageVerdict.zombies.length === 1
    && coverageVerdict.zombies[0] === 'gone'
    && coverageVerdict.conflicts.length === 0
  const entrylessModules = [{ file: 'src/x.ts', names: ['used', 'seamOnly', 'orphan'] }]
  const entrylessVerdict = entrylessDeadExports(entrylessModules, new Set(['used']), [{ name: 'seamOnly', reason: 'suite seam' }])
  const entrylessDetected = entrylessVerdict.checked === 3 && entrylessVerdict.dead.length === 1 && entrylessVerdict.dead[0].name === 'orphan'
  const entrylessStale = staleEntrylessSeams(entrylessModules, new Set(['used', 'seamOnly', 'orphan']), [{ name: 'seamOnly', reason: 'suite seam' }])
  const entrylessStaleDetected = entrylessStale.length === 1
  // Implementation-surface rule negative controls: self-use is live, a real
  // orphan is reported, an allowlist silences it, and a stale entry is flagged.
  const internalModules = [
    { package: 'pkg', file: 'packages/x/src/client/a.ts', names: ['prodUsed', 'selfUsedName', 'orphan'], selfUsed: ['selfUsedName'] },
  ]
  const internalVerdict = internalSurfaceDeadExports(internalModules, new Set(['prodUsed']), [])
  const internalDetected = internalVerdict.checked === 3 && internalVerdict.dead.length === 1
    && internalVerdict.dead[0].name === 'orphan'
  const internalSelfUsed = internalVerdict.dead.every((entry) => entry.name !== 'selfUsedName')
  const internalAllowed = internalSurfaceDeadExports(internalModules, new Set(['prodUsed']),
    [{ package: 'pkg', name: 'orphan', reason: 'suite seam' }]).dead.length === 0
  const internalStale = staleInternalSurfaceAllowlist(internalModules, new Set(['prodUsed', 'orphan']),
    [{ package: 'pkg', name: 'orphan', reason: 'suite seam' }]).length === 1
  // Self-use scanner controls (strict arm): a comment or a quoted literal is NOT
  // a consumer; a real call is; a ${...} interpolation is real code (template
  // literals stay verbatim). Historical mode still counts a quoted mention.
  const selfUseSource = ['// ghost prose', "const label = 'ghost'", '${ghost()}', 'ghost()'].join('\n')
  const strictSelfUse = selfUsedRuntimeExports(selfUseSource, ['ghost'])
  const historicalSelfUse = selfUsedRuntimeExports(selfUseSource, ['ghost'], { stripStrings: false, stripComments: false })
  const selfUseStrictOk = strictSelfUse.length === 1 && strictSelfUse[0] === 'ghost'
  const selfUseHistoricalOk = historicalSelfUse.length === 1 && historicalSelfUse[0] === 'ghost'
  const retiredVerdict = retiredWriteFaceViolations([
    { file: 'packages/x/src/clean.ts', text: 'const listPlugins = () => []' },
    { file: 'macos/Sources/X/Resources/bridge-shim.js', text: "invoke('desktop_local_plugin_add', {})" },
  ])
  const retiredDetected = retiredVerdict.length === 1 && retiredVerdict[0].name === 'local_plugin_add'
  if (detected && exemptionWorks && staleDetected && commentsIgnored && entrylessDetected && entrylessStaleDetected && retiredDetected && internalDetected && internalSelfUsed && internalAllowed && internalStale && selfUseStrictOk && selfUseHistoricalOk
    && testOnlyDetected && testOnlyAllowed && testOnlyStale && seamDetected && seamStaleDetected && coverageDetected) {
    console.log('no-dead-exports self-test: ok (an orphan is reported, an exemption silences it, a stale exemption is flagged, a test-only export needs a reason, comments and quoted literals are not code but template interpolations are, type-only re-exports are erased, a client-seam orphan is reported while its registered ABI names and coverage rows stay honest, a retired write-face name reappearing is caught)')
    return
  }
  console.error(
    'no-dead-exports self-test: FAIL (detected=' + String(detected) +
    ', exemptionWorks=' + String(exemptionWorks) + ', staleDetected=' + String(staleDetected) +
    ', internal=' + String(internalDetected) + '/' + String(internalSelfUsed) + '/' + String(internalAllowed) + '/' + String(internalStale) +
    ', commentsIgnored=' + String(commentsIgnored) + ', entryless=' + String(entrylessDetected) + '/' + String(entrylessStaleDetected) +
    ', retiredWriteFace=' + String(retiredDetected) +
    ', testOnly=' + String(testOnlyDetected) + '/' + String(testOnlyAllowed) + '/' + String(testOnlyStale) +
    ', clientSeam=' + String(seamDetected) + '/' + String(seamStaleDetected) + '/' + String(coverageDetected) + ')',
  )
  process.exit(1)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const packages = discoverPackages()
  if (packages.length < 10) {
    console.error('no-dead-exports: workspace discovery found only ' + String(packages.length) + ' package(s) with src/index.ts - refusing to read a discovery failure as a clean surface')
    process.exit(1)
  }
  const failures = []
  const perPackage = []
  let totalChecked = 0
  let totalDead = 0
  let internalChecked = 0
  for (const pkg of packages) {
    const { modules } = readModules(pkg)
    const declared = modules.reduce((sum, module) => sum + module.names.length, 0)
    const indexHasExports = /(?:^|\n)\s*export\s/u.test(stripComments(readFileSync(pkg.index, 'utf8')))
    if (indexHasExports && modules.length === 0) {
      failures.push(pkg.name + ': index declares exports but the parser read none - refusing to read a parse failure as a clean surface')
      continue
    }
    const missing = modules.filter((module) => module.missing === true)
    if (missing.length > 0) {
      failures.push(pkg.name + ': index re-exports a missing module: ' + missing.map((module) => module.file).join(', '))
      continue
    }
    const imported = collectPackageConsumers(pkg)
    const testImported = collectPackageConsumers(pkg, REPO_ROOT, { scope: 'test' })
    const deadExemptions = DEAD_EXPORT_EXEMPTIONS.filter((entry) => entry.package === pkg.name)
    const testOnlyAllowlist = TEST_ONLY_EXPORT_ALLOWLIST.filter((entry) => entry.package === pkg.name)
    // An allowlisted test-only export is not a dead face, but the test-only rule
    // below still judges it (its entry must stay honest).
    const { dead, checked } = deadExports(modules, imported, [...deadExemptions, ...testOnlyAllowlist])
    const stale = staleExemptions(modules, imported, deadExemptions)
    const testOnly = testOnlyExports(modules, imported, testImported, testOnlyAllowlist)
    totalChecked += checked
    totalDead += dead.length
    // Implementation surface (INTERNAL_SURFACE_PACKAGES): the shipped tree the
    // thin entry does not re-export. Self-use is live; a test-only or
    // zero-consumer name needs an allowlist entry that must stay honest.
    let internal = { dead: [], checked: 0 }
    if (INTERNAL_SURFACE_PACKAGES[pkg.name] !== undefined) {
      const internalModules = internalSurfaceModules(pkg)
      const internalAllowlist = INTERNAL_SURFACE_ALLOWLIST.filter((entry) => entry.package === pkg.name)
      if (internalModules.length === 0) {
        failures.push(pkg.name + ': implementation surface is configured in INTERNAL_SURFACE_PACKAGES but the scan read no module - refusing to read a walk failure as a clean surface')
      }
      internal = internalSurfaceDeadExports(internalModules, imported, internalAllowlist)
      const staleInternal = staleInternalSurfaceAllowlist(internalModules, imported, internalAllowlist)
      if (staleInternal.length > 0) {
        failures.push(pkg.name + ': ' + String(staleInternal.length)
          + ' stale INTERNAL_SURFACE_ALLOWLIST entry(ies) - the export gained a production/self consumer or is gone: '
          + staleInternal.map((entry) => entry.name).join(', '))
      }
      if (internal.dead.length > 0) {
        failures.push(pkg.name + ': ' + String(internal.dead.length)
          + ' implementation export(s) with no production importer and no self-use: '
          + internal.dead.map((entry) => entry.name + ' (' + entry.file + ')').join(', '))
      }
      internalChecked += internal.checked
    }
    perPackage.push({ pkg, declared, dead, stale, testOnly, internal })
  }
  // A configured implementation surface whose package is not discovered would
  // silently go unjudged (rename/private-package drift): fail the discovery gap.
  for (const name of Object.keys(INTERNAL_SURFACE_PACKAGES)) {
    if (!packages.some((pkg) => pkg.name === name)) {
      failures.push('INTERNAL_SURFACE_PACKAGES names ' + name + ' but package discovery found no such package with src/index.ts - the implementation surface would silently go unjudged')
    }
  }
  let entrylessChecked = 0
  let entrylessDead = 0
  for (const pkg of ENTRYLESS_PACKAGES) {
    const dir = join(REPO_ROOT, 'packages', pkg.name)
    const files = walkFiles(dir, (file) => /\.(?:ts|tsx|mts|cts)$/u.test(file) && !/\.d\.(?:ts|mts|cts)$/u.test(file) && !pkg.ignoreFiles.includes(basename(file)), { extraIgnored: ['test', 'tests', 'test-fixtures', 'scripts', 'vendor', 'generated', 'lib'] })
    const modules = []
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const names = extractRuntimeExports(text)
      if (names.length === 0) continue
      const isWordChar = (char) => /[A-Za-z0-9_$]/.test(char)
      const selfUsed = []
      for (const name of names) {
        let count = 0
        let at = text.indexOf(name)
        while (at !== -1) {
          const before = at === 0 ? '' : text[at - 1]
          const after = text[at + name.length] ?? ''
          if (!isWordChar(before) && !isWordChar(after)) count += 1
          at = text.indexOf(name, at + name.length)
        }
        if (count > 1) selfUsed.push(name)
      }
      modules.push({ package: pkg.name, file: relative(REPO_ROOT, file).split(sep).join('/'), names, selfUsed })
    }
    const imported = collectPackageConsumers({ name: pkg.name, dir, spec: pkg.spec })
    const seams = ENTRYLESS_SEAMS.filter((entry) => entry.package === pkg.name)
    const { dead, checked } = entrylessDeadExports(modules, imported, seams)
    entrylessChecked += checked
    entrylessDead += dead.length
    const stale = staleEntrylessSeams(modules, imported, seams)
    if (stale.length > 0) {
      failures.push(pkg.name + ': ' + String(stale.length) + ' stale entryless seam(s) - the export now has a production consumer or is gone: ' + stale.map((entry) => entry.name).join(', '))
    }
    if (dead.length > 0) {
      failures.push(pkg.name + ': ' + String(dead.length) + ' runtime export(s) with no production consumer (entryless surface): ' + dead.map((entry) => entry.name + ' (' + entry.file + ')').join(', '))
    }
  }
  if (entrylessChecked < 100) {
    failures.push('the entryless scan parsed only ' + String(entrylessChecked) + ' runtime export(s) - below the sanity floor (100); refusing to read a parse failure as a clean surface')
  }
  const retiredFiles = retiredWriteFaceScanFiles()
  const retiredViolations = retiredWriteFaceViolations(retiredFiles.map((file) => ({
    file: relative(REPO_ROOT, file).split(sep).join('/'),
    text: readFileSync(file, 'utf8'),
  })))
  if (retiredFiles.length < 100) {
    failures.push('the retired write-face scan read only ' + String(retiredFiles.length) + ' file(s) - below the sanity floor (100); refusing to read a walk failure as a clean surface')
  }
  if (retiredViolations.length > 0) {
    failures.push('retired plugin write-face names reappeared in shipped surfaces: '
      + retiredViolations.map((entry) => entry.name + ' (' + entry.file + ')').join(', '))
  }
  // Client-plugin seams (design 05 / 09): the browser half is loaded by package
  // name, so the root entry keeps the RUNTIME_LOADED skip while every NON-root
  // public entry is judged here. The seam table must cover the discovered set.
  const clientPlugins = discoverClientPlugins()
  const seamCoverage = clientSeamCoverage(clientPlugins)
  for (const name of seamCoverage.unregistered) {
    failures.push('client-plugin package ' + name + ': manifest declares dsh.client but no RUNTIME_LOADED_CLIENT_SEAMS row - register the seam (or a CLIENT_SEAM_SKIPS reason) so the browser half is never silently unjudged')
  }
  for (const name of seamCoverage.zombies) {
    failures.push('client seam ' + name + ': registered/skipped but no package manifest declares dsh.client with a ./client export - delete the stale row')
  }
  for (const name of seamCoverage.conflicts) {
    failures.push('client seam ' + name + ': registered as both judged and skipped - one row must own it')
  }
  let clientSeamChecked = 0
  let clientSeamDead = 0
  const clientSeamByName = new Map(RUNTIME_LOADED_CLIENT_SEAMS.map((entry) => [entry.package, entry]))
  for (const plugin of clientPlugins) {
    if (plugin.clientEntry === null) {
      failures.push('client-plugin package ' + plugin.name + ': manifest declares dsh.client but no resolvable ./client export target - the client-plugin loader imports <pkg>/client, so fix the manifest (it cannot be registered as a seam)')
      continue
    }
    const seam = clientSeamByName.get(plugin.name)
    if (seam === undefined) continue
    if (!/\.(?:ts|tsx|mts|cts)$/u.test(plugin.clientEntry)) {
      failures.push('client seam ' + plugin.name + ': the registered ./client entry resolves to a non-source file (' + plugin.clientEntry + ') - a judged seam must point at a source entry')
      continue
    }
    const judgedEntries = [plugin.clientEntry, ...plugin.subpaths.map((entry) => entry.file)]
    const imported = collectPackageConsumers(plugin, REPO_ROOT, { ownEntryFiles: judgedEntries, skipOwnReExports: true })
    const clientRead = readModules(plugin, REPO_ROOT, plugin.clientEntry)
    const subpathReads = plugin.subpaths.map((entry) => readModules(plugin, REPO_ROOT, entry.file))
    const missing = [...clientRead.modules, ...subpathReads.flatMap((read) => read.modules)]
      .filter((module) => module.missing === true)
    if (missing.length > 0) {
      failures.push('client seam ' + plugin.name + ': a public entry re-exports a missing module: ' + missing.map((module) => module.file).join(', '))
      continue
    }
    const subpathModules = subpathReads.flatMap((read) => read.modules)
    const verdict = clientSeamVerdict(clientRead.modules, subpathModules, imported, seam.abi)
    clientSeamChecked += verdict.checked
    clientSeamDead += verdict.dead.length
    if (verdict.dead.length > 0) {
      failures.push('client seam ' + plugin.name + ': ' + String(verdict.dead.length)
        + ' runtime export(s) of a non-root public entry have no production importer: '
        + verdict.dead.map((item) => item.name + ' (' + item.file + ')').join(', ')
        + ' - delete the export, narrow the entry, or list the name in the seam ABI only when the loader really reads it')
    }
    if (verdict.staleAbi.length > 0) {
      failures.push('client seam ' + plugin.name + ': stale ABI exemption(s) - the name gained a production importer or the client entry no longer declares it: ' + verdict.staleAbi.join(', '))
    }
  }
  if (clientPlugins.length < 8) {
    failures.push('the client-plugin scan found only ' + String(clientPlugins.length) + ' package(s) - below the sanity floor (8); refusing to read a discovery failure as a clean surface')
  }
  if (clientSeamChecked < 20) {
    failures.push('the client-seam scan parsed only ' + String(clientSeamChecked) + ' runtime export(s) - below the sanity floor (20); refusing to read a parse failure as a clean surface')
  }
  let testOnlyAllowedCount = 0
  for (const entry of perPackage) {
    testOnlyAllowedCount += entry.testOnly.checked
    if (entry.testOnly.unallowed.length > 0) {
      failures.push(entry.pkg.name + ': ' + String(entry.testOnly.unallowed.length)
        + ' test-only runtime export(s) need a TEST_ONLY_EXPORT_ALLOWLIST entry with the reason a reviewer accepted: '
        + entry.testOnly.unallowed.map((item) => item.name + ' (' + item.file + ')').join(', '))
    }
    if (entry.testOnly.stale.length > 0) {
      failures.push(entry.pkg.name + ': ' + String(entry.testOnly.stale.length)
        + ' stale TEST_ONLY_EXPORT_ALLOWLIST entry(ies) - the export gained a production importer or every test importer is gone: '
        + entry.testOnly.stale.map((item) => item.name).join(', '))
    }
  }
  if (totalChecked < 100) {
    failures.push('the workspace parsed only ' + String(totalChecked) + ' runtime export(s) - below the sanity floor (100); refusing to read a parse failure as a clean surface')
  }
  for (const entry of perPackage) {
    if (entry.stale.length > 0) {
      failures.push(entry.pkg.name + ': ' + String(entry.stale.length) + ' stale exemption(s) - the export is imported or gone: '
        + entry.stale.map((item) => item.package + '#' + item.name).join(', '))
    }
  }
  if (failures.length > 0) {
    for (const message of failures) console.error('✗ no-dead-exports: ' + message)
    process.exit(1)
  }
  let runtimeLoaded = 0
  let pendingSuppressed = 0
  for (const entry of perPackage) {
    const runtimeReason = RUNTIME_LOADED_PACKAGES[entry.pkg.name]
    if (runtimeReason !== undefined) {
      runtimeLoaded += 1
      continue
    }
    const pending = PENDING_PACKAGES[entry.pkg.name]
    if (pending !== undefined) {
      if (entry.dead.length === 0) {
        console.error('✗ no-dead-exports: PENDING_PACKAGES entry ' + entry.pkg.name + ' (owner ' + pending.owner
          + ') no longer has any dead export - delete the entry (zombie: ' + pending.retiresWhen + ')')
        process.exit(1)
      }
      pendingSuppressed += entry.dead.length
      console.warn('⚠ no-dead-exports: ' + entry.pkg.name + ' pending barrel narrowing (owner ' + pending.owner + '): '
        + String(entry.dead.length) + ' dead export(s) suppressed - ' + entry.dead.map((item) => item.name).join(', '))
      continue
    }
    if (entry.dead.length > 0) {
      console.error('✗ no-dead-exports: ' + entry.pkg.name + ': ' + String(entry.dead.length) + ' of ' + String(entry.declared) + ' runtime export(s) have no production importer:')
      for (const item of entry.dead) console.error('  - ' + item.name + '  (' + item.file + ')')
      console.error('Delete the export (and its implementation if unused), narrow the re-export, or add a DEAD_EXPORT_EXEMPTIONS entry with the reason and the phase that lands its consumer.')
      process.exit(1)
    }
  }
  const clientSeamJudged = clientPlugins.filter((plugin) => clientSeamByName.has(plugin.name)).length
  const suffix = [
    internalChecked > 0 ? String(internalChecked) + ' implementation export(s) judged in ' + String(Object.keys(INTERNAL_SURFACE_PACKAGES).length) + ' package(s), ' + String(INTERNAL_SURFACE_ALLOWLIST.length) + ' allowlisted' : '',
    clientSeamJudged > 0 ? String(clientSeamJudged) + ' client-plugin package(s) judged at non-root public entries (' + String(clientSeamChecked) + ' runtime export(s)' + (clientSeamDead > 0 ? ', ' + String(clientSeamDead) + ' dead' : '') + ')' : '',
    clientPlugins.length > clientSeamJudged ? String(clientPlugins.length - clientSeamJudged) + ' pinned-fork client half(ies) skipped with a reason' : '',
    runtimeLoaded > 0 ? String(runtimeLoaded) + ' runtime-loaded package(s) not judged' : '',
    pendingSuppressed > 0 ? String(pendingSuppressed) + ' pending dead export(s) suppressed' : '',
    testOnlyAllowedCount > 0 ? String(testOnlyAllowedCount) + ' test-only export(s) allowlisted' : '',
  ].filter(Boolean).join('; ')
  console.log('ok no-dead-exports: all ' + String(totalChecked - pendingSuppressed) + ' judged runtime export(s) have a production importer across ' + String(packages.length) + ' package(s), plus ' + String(entrylessChecked) + ' entryless export(s) across ' + String(ENTRYLESS_PACKAGES.length) + ' package(s), plus ' + String(internalChecked) + ' implementation export(s) across ' + String(Object.keys(INTERNAL_SURFACE_PACKAGES).length) + ' package(s)'
    + (suffix === '' ? '' : '（' + suffix + '）'))
}

const isEntry = process.argv[1] !== undefined && process.argv[1].endsWith('verify-no-dead-exports.mjs')
if (isEntry) main()
