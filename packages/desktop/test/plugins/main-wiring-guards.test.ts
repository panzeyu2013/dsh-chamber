/**
 * Desktop SOURCE-level wiring gates (design 13 §6 / design 20 §6 / design 21
 * §6.11) — merged suite (2026-12 test reorganization), W-10 seam re-point.
 *
 * Sources (both were package-root tests; now one file):
 *   - chamber-seed-portability-wiring.test.ts — every "what belongs on that
 *     OTHER host" read goes through the portable seed list.
 *   - protected-plugin-guard-wiring.test.ts   — every local plugin mutation
 *     judges the protected set before the CLI can run.
 * One wiring discipline: main.ts / shell-core.ts are Electron entry surfaces
 * these suites cannot import, so the call sites are pinned over COMMENT-STRIPPED
 * source text and identifier occurrences are counted instead of a spelling being
 * banned.
 *
 * W-10 note (design 25 §4.1 seam, 2026-12 merge): the desktop main process is
 * split across main.ts (assembly / lifecycle / startup host — zero IPC
 * registration bodies) and shell-core.ts (installIpcHandlers — every IPC body,
 * registered via the injected deps.ipc.handle). These gates therefore read BOTH
 * files: the ready-time gap log, the gateway upload source list and the ctx
 * hand-off live in main.ts; the manual 注入 preflight, all three local mutation
 * guards and localProtectionFacts / verifyLocalProfileFamily live in
 * shell-core.ts.
 *
 * Merge note: the shared stripComments helper, mainSource and mainCode prologue
 * (byte-identical in both sources) were deduped here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

// --- merged from test/plugins/chamber-seed-portability-wiring.test.ts ---
const mainSource = readFileSync(join(import.meta.dirname, '..', '..', 'main.ts'), 'utf8')
const coreSource = readFileSync(join(import.meta.dirname, '..', '..', 'shell-core.ts'), 'utf8')

/** Comments removed: this file's house style is long prose in comments, so
 *  identifier counting must not see them. */
const mainCode = stripComments(mainSource)
const coreCode = stripComments(coreSource)
const desktopCode = mainCode + '\n' + coreCode

// 2026-12 parity batch (P-04/P-11/G15): the Electron-free sidecar entry and its
// ctx assembly are read-only here — F1 owns sidecar-ctx.ts, so these locks assert
// the call-site shapes without editing it.
const sidecarEntrySource = readFileSync(join(import.meta.dirname, '..', '..', 'sidecar-entry.ts'), 'utf8')
const sidecarEntryCode = stripComments(sidecarEntrySource)
const sidecarCtxCode = stripComments(readFileSync(join(import.meta.dirname, '..', '..', 'sidecar-ctx.ts'), 'utf8'))

/** Slice of `source` between two code markers (exclusive of the end marker). */
function between(source: string, startMarker: string, endMarker: string, what: string): string {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `${what} no longer contains: ${startMarker}`)
  const end = source.indexOf(endMarker, start)
  assert.notEqual(end, -1, `${what} no longer contains ${endMarker} after ${startMarker}`)
  return source.slice(start, end)
}

test('the portability rule is derived once per surface, and the full projection is never re-read', () => {
  assert.ok(
    mainCode.includes('const portableHostSeeds = portableChamberHostPackageSeeds(chamberHostPackageSeeds)'),
    'main.ts must derive the portable seed list from the registry projection',
  )
  // main.ts: exactly three mentions — the declaration, that derivation, and the
  // single ctx hand-off (core needs the same projection instance for the F/G
  // seed paths). Any other read ('.filter(', '.map(', '.some(', spread)
  // re-introduces the defect this change fixed; a legitimately added read is a
  // deliberate edit of this gate rather than a silent regression.
  const mainMentions = mainCode.match(/chamberHostPackageSeeds/g) ?? []
  assert.equal(mainMentions.length, 3,
    `main.ts must mention the full registry projection exactly at its declaration, its portability derivation and the ctx hand-off (found ${mainMentions.length})`)
  // shell-core.ts: exactly three mentions — the ShellAssemblyCtx field, the ctx
  // destructure, and its own portable derivation. The W-10 move must not turn
  // the injected field into a second full-projection read face.
  const coreMentions = coreCode.match(/chamberHostPackageSeeds/g) ?? []
  assert.equal(coreMentions.length, 3,
    `shell-core.ts must mention the injected projection exactly at its ctx field, ctx destructure and portability derivation (found ${coreMentions.length})`)
  assert.ok(coreCode.includes('portableChamberHostPackageSeeds(chamberHostPackageSeeds)'),
    'shell-core.ts must derive its own portable list from the injected projection')
})

test('both ssh preflights and the ready-time gap log read the portable list', () => {
  const ready = between(mainCode, 'const builtSeeds = builtChamberHostPackageSeeds(', 'const result = await seedRemoteChamberHostPackages(', 'main.ts')
  assert.ok(ready.includes('const missingSeeds = portableHostSeeds.filter('),
    'the ready-time gap log judges the portable list')

  const manual = between(coreCode, 'IPC_CHANNELS.SSH_SEED_HOST_GRAPH', 'deps.ipc.handle(IPC_CHANNELS.SSH_PLUGIN_MATERIALIZE_ADD,', 'shell-core.ts')
  assert.ok(manual.includes('const seeds = portableHostSeeds();'),
    'the manual 注入 preflight derives the portable list inside core')
  assert.ok(manual.includes('const built = builtChamberHostPackageSeeds(seeds)'),
    'the manual 注入 preflight judges the SHIPPED portable rows')
  assert.ok(manual.includes('const missing = seeds.filter(seed => !built.includes(seed))'),
    'and reports an unbuilt/unmapped row as missing (loud, never a phantom upload)')

  // BOTH writer call sites exist (ready-time in main.ts, manual in core) and
  // both receive the portable list — a full-projection argument would be the
  // regression.
  assert.equal((desktopCode.match(/seedRemoteChamberHostPackages\(/g) ?? []).length, 2,
    'both writer call sites must still exist')
  assert.match(mainCode, /seedRemoteChamberHostPackages\([\s\S]{0,200}?portableHostSeeds,/,
    'the ready-time writer must pass the portable list')
  assert.match(manual, /seedRemoteChamberHostPackages\([\s\S]*?seeds,/,
    'the manual writer must pass the portable list')
  assert.equal(/seedRemoteChamberHostPackages\([\s\S]{0,200}?chamberHostPackageSeeds,/.test(desktopCode), false,
    'neither writer call site may pass the full registry projection')
})

test('main.ts: the gateway upload source list iterates the portable seeds (one rule, one implementation)', () => {
  const upload = between(mainCode, 'const localChamberHostPackageSources = ', 'const syncGatewayChamberPluginsFor = ', 'main.ts')
  assert.ok(upload.includes('return portableHostSeeds.flatMap(seed =>'),
    'the upload must be built from the portable list, not from the full registry with an inline re-check')
  assert.ok(upload.includes('chamberHostSourceDirs[seed.packageName]'),
    'per-package source dirs still come from the single map')
  assert.ok(upload.includes('if (dir === undefined)'),
    'a genuine "registry row lost its source dir" must stay loud')
  assert.equal(upload.includes('descriptor.localOnly'), false,
    'the hand-rolled portability filter is the duplicate this test forbids')
})

// --- merged from test/plugins/protected-plugin-guard-wiring.test.ts ---
/** The `deps.ipc.handle(IPC_CHANNELS.<channel>, …)` block, up to the next handler
 *  (W-10: the registration bodies live in shell-core's installIpcHandlers). */
function handlerBlock(channel: string): string {
  const start = coreCode.indexOf(`deps.ipc.handle(IPC_CHANNELS.${channel},`)
  assert.notEqual(start, -1, `shell-core.ts no longer registers ${channel}`)
  const end = coreCode.indexOf('deps.ipc.handle(', start + 1)
  assert.notEqual(end, -1, `no handler follows ${channel}, so the block cannot be delimited`)
  return coreCode.slice(start, end)
}

/** `haystack` must contain `needle` after `after` (order inside one handler). */
function assertOrdered(haystack: string, after: string, needle: string, what: string): void {
  const needleAt = haystack.indexOf(needle)
  assert.notEqual(needleAt, -1, `${what}: shell-core.ts no longer contains ${needle}`)
  const afterAt = haystack.indexOf(after)
  assert.notEqual(afterAt, -1, `${what}: shell-core.ts no longer contains ${after}`)
  assert.ok(afterAt < needleAt, `${what}: ${needle} must run BEFORE ${after}`)
}

test('shell-core.ts: all three local plugin mutations judge the protected set first', () => {
  // Exactly three guard call sites: one per user-reachable local mutation. A
  // silently dropped guard changes this count, and a fourth one is a deliberate
  // edit of this gate rather than a silent addition.
  const guards = coreCode.match(/guardPluginMutation\(/g) ?? []
  assert.equal(guards.length, 3,
    `expected the three local mutation guards (add-file/add/remove), found ${guards.length} guardPluginMutation calls`)

  const addFile = handlerBlock('LOCAL_PLUGIN_ADD_FILE')
  // The picked folder's name is only known from its package.json, so the guard has
  // to judge THAT manifest — and do it before the CLI can install anything.
  assertOrdered(addFile, 'pickPluginSource(', 'folderPluginIdentity(', 'add-file')
  assertOrdered(addFile, 'folderPluginIdentity(', 'guardPluginMutation({', 'add-file')
  assertOrdered(addFile, 'guardPluginMutation({', "runLocalPluginMutation('plugin:add-file'", 'add-file')
  assert.match(addFile, /op: 'install'/, 'the folder/archive pick is an INSTALL judgement')

  const add = handlerBlock('LOCAL_PLUGIN_ADD')
  assertOrdered(add, 'guardPluginMutation({', 'runLocalPluginMutation(', 'add')
  assert.match(add, /op: 'install'/, 'the renderer-submitted spec is an INSTALL judgement')

  const remove = handlerBlock('LOCAL_PLUGIN_REMOVE')
  assertOrdered(remove, 'guardPluginMutation({', 'runLocalPluginMutation(', 'remove')
  assert.match(remove, /op: 'remove'/, 'the remove channel is a REMOVE judgement')
})

test('shell-core.ts: a refused judgement returns before the mutation, and the CLI guard stays as depth', () => {
  // `kind === 'refuse'` must short-circuit with the decision text; `defer` is the
  // only other outcome the callers admit (profile absent ⇒ the CLI creates it).
  for (const [channel, marker] of [
    ['LOCAL_PLUGIN_ADD_FILE', "runLocalPluginMutation('plugin:add-file'"],
    ['LOCAL_PLUGIN_ADD', 'runLocalPluginMutation('],
    ['LOCAL_PLUGIN_REMOVE', 'runLocalPluginMutation('],
  ] as const) {
    const block = handlerBlock(channel)
    const refusal = block.indexOf("=== 'refuse'")
    assert.notEqual(refusal, -1, `${channel} must branch on the refusal`)
    assert.ok(refusal < block.indexOf(marker),
      `${channel}: the refusal branch must return before the mutation runs`)
  }
  // Second line of defence: the CLI runner itself is handed fresh protection facts,
  // so a caller that forgot to guard still gets refused inside runLocalDshPlugin.
  assert.match(coreCode, /runLocalDshPlugin\([^)]*protection:/s,
    'the local CLI runner must receive the protection facts (defence in depth)')
})

/** Slice of `source` from `start` up to (excluding) `end`; both must exist. */
function sliceBetween(source: string, start: string, end: string, what: string): string {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `${what} no longer contains ${start}`)
  const to = source.indexOf(end, from)
  assert.notEqual(to, -1, `${what}: no ${end} after ${start}, so the block cannot be delimited`)
  return source.slice(from, to)
}

test('shell-core.ts: the local protection facts carry the runtime version facts from the SAME resolution as F', () => {
  // design 21 §6.11.3: the post-install verification judges a family member on
  // the versions the runtime provides; localProtectionFacts is the only desktop
  // producer of those facts, and it must read them off the SAME
  // resolveRuntimeFamily result as F — a second resolution could observe a
  // runtime swap in between.
  const facts = sliceBetween(coreCode, 'const localProtectionFacts = (): PluginProtectionFacts => {',
    'const portableHostSeeds', 'shell-core.ts')
  // Exactly one primary resolution, plus the env-only stand-in retry (asserted by
  // its own test below). Both F and the version facts must still come off the
  // SAME (final) result — never two independent reads that could span a swap.
  const resolutions = facts.match(/resolveRuntimeFamily\(/g) ?? []
  assert.equal(resolutions.length, 2,
    `localProtectionFacts must resolve the runtime family once plus the env stand-in retry, found ${resolutions.length}`)
  assert.match(facts, /familyVersions = family\.ok \? family\.versions : null;/,
    'the ok branch must take `versions` off the same resolution (null when unresolvable)')
  assert.match(facts, /return \{\s*familyNames,\s*familyVersions,/s,
    'the returned facts must carry familyVersions alongside familyNames')
})

test('shell-core.ts: the post-install verification passes the version facts to the verdict AND the message', () => {
  const verify = sliceBetween(coreCode, 'const verifyLocalProfileFamily = (facts: PluginProtectionFacts)',
    'const confirmPluginAction', 'shell-core.ts')
  // The early return is the "no F ⇒ nothing to verify" contract and must stay:
  // familyVersions can never make a factless ssh/degraded path verify.
  assert.match(verify,
    /if \(!Array\.isArray\(facts\.familyNames\) \|\| facts\.familyNames\.length === 0\) return \{ ok: true \};/,
    'the empty-family early return must be preserved')
  assert.match(verify, /const familyVersions = facts\.familyVersions \?\? null;/,
    'the facts field must be normalized to null before use')
  assert.match(verify, /verifyProfileFamilyConsistency\(\{[^}]*familyVersions,/s,
    'verifyProfileFamilyConsistency must receive familyVersions (version arm, not only generation)')
  assert.match(verify,
    /describeFamilyFindings\(verdict\.findings, facts\.runtimeVersion \?\? null, familyVersions\)/,
    'describeFamilyFindings must receive the same familyVersions so the message names the expected version')
})

test('shell-core.ts / plugin-sync.ts: the ssh conservative shape still carries NO version facts', () => {
  // ssh has no runtime family source at all (familySource 'none', fails closed);
  // its facts must not silently acquire a version arm.
  const syncSource = readFileSync(join(import.meta.dirname, '..', '..', 'plugin-sync.ts'), 'utf8')
  assert.match(syncSource,
    /return \{ familyNames: null, familyVersions: null, runtimeVersion: null, familySource: 'none' \}/,
    'sshProtectionFacts must stay version-factless (conservative ssh shape)')
})

test('shell-core.ts: the built-in runtime pin is only used when it IS the active runtime line', () => {
  // design 21 §6.11.1 + design 18 §3.6: a user-selected runtime (or an
  // env-provided tree) is another dsh version whose own lockfile is the right
  // fact source. Handing it the built-in pin judges a consistent profile
  // against versions it never had — the 2026-12 review fixture failed a
  // legitimate 0.1.5-rc.3 profile loudly while the pin sat at rc.2. Same-version
  // trees still prefer the pin (a source-line lockfile carries the opt-in
  // segment and is refused by the trust criterion).
  const facts = sliceBetween(coreCode, 'const localProtectionFacts = (): PluginProtectionFacts => {',
    'const portableHostSeeds', 'shell-core.ts')
  // The built-in line's generation is the assembly-time fact
  // (bundledRuntimeVersion ← main.ts readDshVersion(builtinDshWorkspace)); the
  // anchor path is the ctx leaf the assembly resolves — core never guesses a
  // host path.
  assert.match(facts,
    /const usePinned = shouldPreferPinnedRuntimeLockfile\(resolved\.version, bundledVersion\)/,
    'the pin must be gated on the active runtime version matching the built-in line')
  assert.match(facts, /const pinnedPath = pinnedRuntimeLockfilePath\(\);/,
    'the built-in anchor path is resolved once, through the ctx leaf')
  assert.match(facts, /pinnedLockfilePath: usePinned \? pinnedPath : null/,
    'an unmatched active runtime must NOT receive the built-in pin')
  // The assembly still hands both host facts over (nothing host-shaped lands in core).
  assert.match(mainCode, /builtinDshWorkspacePath: builtinDshWorkspace,/,
    'main.ts must inject the built-in workspace path (resolveActiveRuntime second argument)')
  assert.match(mainCode, /pinnedRuntimeLockfilePath: \(\) => resolvePinnedRuntimeLockfile\(\),/,
    'main.ts must inject the anchor lockfile path leaf')
})


// --- 2026-12 dual-flavor parity batch (P-04 / P-11 / G15) ---

test('P-04: the sidecar resolves its builtin dsh workspace through the shared dev fallback (packaged = no probe)', () => {
  // The Electron-free sidecar used to have no dev fallback at all (swift run
  // without POC_DSH_PATH blocked every startup transaction); Electron main had
  // one. Both now use the same shared resolver/candidate order.
  assert.match(mainCode, /return resolveDevBuiltinDshWorkspace\(pkgDir\);/, 'main.ts dev branch uses the shared helper')
  assert.match(sidecarEntryCode, /resolveSidecarBuiltinDshWorkspace\(\{/,
    'sidecar-entry must resolve the workspace through the shared helper')
  assert.match(sidecarEntryCode, /packaged: isPackagedSidecarRuntime\(\),/,
    'the dev fallback must be gated on the packaged runtime shape')
  assert.match(sidecarEntryCode, /builtinDshWorkspace: dshPath,/, 'the resolved path feeds buildHeadlessCtx')
  assert.doesNotMatch(sidecarEntryCode, /builtinDshWorkspace: args\.dshPath,/,
    'the raw CLI argument must no longer bypass the dev fallback')
})

test('P-11: neither flavor keeps a pre-spawn time fallback (the startup transaction is the only authority)', () => {
  // The Swift-only 5s/12s force-start could bypass the runtime gate
  // (connectionState-only check) and had no Electron equivalent. Both flavors
  // reach the local instance through the same startup transaction:
  // refreshRuntimeEvidence().then(runRuntimeStartup) — runStartupTail is the
  // sidecar's wrapper around exactly that call.
  assert.match(mainCode, /refreshRuntimeEvidence\(\)\.then\(\(\) => runRuntimeStartup\(\)\)/,
    'Electron runs the shared startup transaction')
  assert.match(sidecarEntryCode, /headless\.runStartupTail\(\)/,
    'the sidecar runs its startup tail (the same transaction)')
  assert.match(sidecarCtxCode, /refreshRuntimeEvidence\(\)\.then\(\(\) => runRuntimeStartup\(\)\)/,
    'runStartupTail funnels into the same shared transaction')
  assert.doesNotMatch(sidecarEntryCode, /maybeStartLocal/, 'the Swift-only pre-spawn fallback must stay deleted')
  assert.doesNotMatch(sidecarEntryCode, /startLocalAttempted/, 'its idempotence flag goes with it')
  assert.doesNotMatch(sidecarEntryCode, /setTimeout\(\(\) => void maybeStartLocal\(\), (?:5000|12000)\)/,
    'no time-based force-start may come back on either flavor')
})

test('G15/G35: the runtime-transaction abort reason is one shared constant on BOTH flavors', () => {
  // The two flavors used different abort strings (main.ts 'application is
  // quitting' vs sidecar-ctx 'sidecar is shutting down'). The single source is
  // shell-core RUNTIME_ABORT_REASON; main.ts must not spell the literal again.
  assert.match(coreCode, /export const RUNTIME_ABORT_REASON = 'application is quitting';/,
    'the shared constant keeps the canonical wording')
  assert.match(mainCode, /runtimeOperationAbort\?\.abort\(new Error\(RUNTIME_ABORT_REASON\)\)/,
    'the will-quit abort uses the shared constant')
  assert.match(mainCode, /if \(quitRequested\) throw new Error\(RUNTIME_ABORT_REASON\)/,
    'the startup transaction quit guard uses the shared constant')
  assert.doesNotMatch(mainCode, /new Error\('application is quitting'\)/,
    'no second spelling of the abort reason may remain in main.ts')
  // G35: the Swift flavor's two sites are on the same constant — the sidecar
  // startup-transaction probe guard and the dispose abort. G15 only proved the
  // constant existed and Electron was on it; these assertions are what stop a
  // revert to the old 'sidecar is shutting down' literal.
  assert.match(sidecarCtxCode, /import \{[^}]*RUNTIME_ABORT_REASON[^}]*\} from '\.\/shell-core\.ts'/,
    'sidecar-ctx.ts must import the shared constant from shell-core')
  assert.match(sidecarCtxCode, /if \(quittingRequested\) throw new Error\(RUNTIME_ABORT_REASON\)/,
    'the sidecar startup probe guard uses the shared constant')
  assert.match(sidecarCtxCode, /runtimeOperationAbort\?\.abort\(new Error\(RUNTIME_ABORT_REASON\)\)/,
    'the sidecar dispose abort uses the shared constant')
  assert.doesNotMatch(sidecarCtxCode, /new Error\('application is quitting'\)/,
    'the sidecar must not respell the Electron literal either')
  assert.doesNotMatch(sidecarCtxCode, /new Error\('sidecar is shutting down'\)/,
    'the old Swift-side abort literal must not come back (G35)')
})
test('shell-core.ts: a dev/env tree at another generation may still fall back to the built-in anchor', () => {
  // A source-line dev tree carries an opt-in lockfile and forbidden tree names,
  // so both of its own fact sources are refused. Without a stand-in the local
  // write face degrades to "official installs refused" for the repo's own
  // `DSH_CHAMBER_DSH_PATH` flow. The stand-in is env-only: a user-SELECTED
  // released runtime is NEVER judged by another line's anchor (W2).
  const facts = sliceBetween(coreCode, 'const localProtectionFacts = (): PluginProtectionFacts => {',
    'const portableHostSeeds', 'shell-core.ts')
  assert.match(facts, /if \(!family\.ok && !usePinned && resolved\.source === 'env'\) \{/,
    'the built-in anchor stand-in must be gated on an env-provided runtime that could not resolve its own facts')
  assert.match(facts, /family = resolveRuntimeFamily\(resolved\.path, \{ pinnedLockfilePath: pinnedPath \}\)/,
    'the stand-in must retry the same resolution WITH the built-in anchor')
})
