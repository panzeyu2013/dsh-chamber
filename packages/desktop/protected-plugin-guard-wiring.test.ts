/**
 * Protected-set GUARD wiring in the desktop main process (design 21 §6.11).
 *
 * Every local plugin mutation is judged before anything can reach the dsh CLI:
 * `guardPluginMutation` reads the derived protected set `P = B₀ ∪ S ∪ F` and the
 * caller must refuse on `kind === 'refuse'`. The behaviour of that predicate is
 * covered by plugin-sync.test.ts / ssh-apply-rows tests, but the WIRING lives in
 * main.ts — an Electron entry this suite cannot import — and that is exactly the
 * shape that shipped broken once: `plugin-tarball.ts` used `MAX_PLUGIN_SPEC_CHARS`
 * without importing it, so the folder-pick path threw a ReferenceError at runtime
 * while every pure-module test stayed green (2026-09-13 merge). A dropped or moved
 * guard call would be invisible for the same reason.
 *
 * Pinned at the SOURCE level over comment-stripped code, the same lockstep
 * discipline as chamber-seed-portability-wiring.test.ts: this file's house style
 * puts long prose in comments, so identifier occurrences are counted rather than
 * a spelling being banned.
 *
 * The gate itself is asserted as an ORDERING inside each handler: judging the name
 * after the CLI ran would be theatre.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const mainSource = readFileSync(join(import.meta.dirname, 'main.ts'), 'utf8')

/** Comment stripper (house implementation, same as the portability/visual-lock tests). */
function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) { if (ch === '\n') { line = false; out += ch } else out += ' '; continue }
    if (block) { if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '; continue }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

const mainCode = stripComments(mainSource)

/** The `ipcMain.handle(IPC_CHANNELS.<channel>, …)` block, up to the next handler. */
function handlerBlock(channel: string): string {
  const start = mainCode.indexOf(`ipcMain.handle(IPC_CHANNELS.${channel},`)
  assert.notEqual(start, -1, `main.ts no longer registers ${channel}`)
  const end = mainCode.indexOf('ipcMain.handle(', start + 1)
  assert.notEqual(end, -1, `no handler follows ${channel}, so the block cannot be delimited`)
  return mainCode.slice(start, end)
}

/** `haystack` must contain `needle` after `after` (order inside one handler). */
function assertOrdered(haystack: string, after: string, needle: string, what: string): void {
  const needleAt = haystack.indexOf(needle)
  assert.notEqual(needleAt, -1, `${what}: main.ts no longer contains ${needle}`)
  const afterAt = haystack.indexOf(after)
  assert.notEqual(afterAt, -1, `${what}: main.ts no longer contains ${after}`)
  assert.ok(afterAt < needleAt, `${what}: ${needle} must run BEFORE ${after}`)
}

test('main.ts: all three local plugin mutations judge the protected set first', () => {
  // Exactly three guard call sites: one per user-reachable local mutation. A
  // silently dropped guard changes this count, and a fourth one is a deliberate
  // edit of this gate rather than a silent addition.
  const guards = mainCode.match(/guardPluginMutation\(/g) ?? []
  assert.equal(guards.length, 3,
    `expected the three local mutation guards (add-file/add/remove), found ${guards.length} guardPluginMutation calls`)

  const addFile = handlerBlock('LOCAL_PLUGIN_ADD_FILE')
  // The picked folder's name is only known from its package.json, so the guard has
  // to judge THAT manifest — and do it before the CLI can install anything.
  assertOrdered(addFile, 'pickPluginSource(', 'folderPluginIdentity(', 'add-file')
  assertOrdered(addFile, 'folderPluginIdentity(', "guardPluginMutation({", 'add-file')
  assertOrdered(addFile, "guardPluginMutation({", "runLocalPluginMutation('plugin:add-file'", 'add-file')
  assert.match(addFile, /op: 'install'/, 'the folder/archive pick is an INSTALL judgement')

  const add = handlerBlock('LOCAL_PLUGIN_ADD')
  assertOrdered(add, "guardPluginMutation({", 'runLocalPluginMutation(', 'add')
  assert.match(add, /op: 'install'/, 'the renderer-submitted spec is an INSTALL judgement')

  const remove = handlerBlock('LOCAL_PLUGIN_REMOVE')
  assertOrdered(remove, "guardPluginMutation({", 'runLocalPluginMutation(', 'remove')
  assert.match(remove, /op: 'remove'/, 'the remove channel is a REMOVE judgement')
})

test('main.ts: a refused judgement returns before the mutation, and the CLI guard stays as depth', () => {
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
  assert.match(mainCode, /runLocalDshPlugin\([^)]*protection:/s,
    'the local CLI runner must receive the protection facts (defence in depth)')
})

/** `main.ts` slice from `start` up to (excluding) `end`; both must exist. */
function sliceBetween(start: string, end: string, what: string): string {
  const from = mainCode.indexOf(start)
  assert.notEqual(from, -1, `${what}: main.ts no longer contains ${start}`)
  const to = mainCode.indexOf(end, from)
  assert.notEqual(to, -1, `${what}: no ${end} after ${start}, so the block cannot be delimited`)
  return mainCode.slice(from, to)
}

test('main.ts: the local protection facts carry the runtime version facts from the SAME resolution as F', () => {
  // design 21 §6.11.3: the post-install verification judges a family member on
  // the versions the runtime provides; main.ts is the only desktop producer of
  // those facts, and it must read them off the SAME resolveRuntimeFamily result
  // as F — a second resolution could observe a runtime swap in between.
  const facts = sliceBetween('const localProtectionFacts = (): PluginProtectionFacts => {',
    'const verifyLocalProfileFamily', 'localProtectionFacts')
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

test('main.ts: the post-install verification passes the version facts to the verdict AND the message', () => {
  const verify = sliceBetween('const verifyLocalProfileFamily = (facts: PluginProtectionFacts)',
    'const confirmPluginAction', 'verifyLocalProfileFamily')
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

test('main.ts / plugin-sync.ts: the ssh conservative shape still carries NO version facts', () => {
  // ssh has no runtime family source at all (familySource 'none', fails closed);
  // its facts must not silently acquire a version arm.
  const syncSource = readFileSync(join(import.meta.dirname, 'plugin-sync.ts'), 'utf8')
  assert.match(syncSource,
    /return \{ familyNames: null, familyVersions: null, runtimeVersion: null, familySource: 'none' \}/,
    'sshProtectionFacts must stay version-factless (conservative ssh shape)')
})

test('main.ts: the built-in runtime pin is only used when it IS the active runtime line', () => {
  // design 21 §6.11.1 + design 18 §3.6: a user-selected runtime (or an
  // env-provided tree) is another dsh version whose own lockfile is the right
  // fact source. Handing it the built-in pin judges a consistent profile
  // against versions it never had — the 2026-12 review fixture failed a
  // legitimate 0.1.5-rc.3 profile loudly while the pin sat at rc.2. Same-version
  // trees still prefer the pin (a source-line lockfile carries the opt-in
  // segment and is refused by the trust criterion).
  const facts = sliceBetween('const localProtectionFacts = (): PluginProtectionFacts => {',
    'const verifyLocalProfileFamily', 'localProtectionFacts')
  assert.match(facts,
    /const usePinned = shouldPreferPinnedRuntimeLockfile\(resolved\.version, readDshVersion\(builtinDshWorkspace\)\)/,
    'the pin must be gated on the active runtime version matching the built-in line')
  assert.match(facts, /const pinnedLockfilePath = resolvePinnedRuntimeLockfile\(\);/,
    'the built-in anchor path is resolved once')
  assert.match(facts, /pinnedLockfilePath: usePinned \? pinnedLockfilePath : null/,
    'an unmatched active runtime must NOT receive the built-in pin')
})

test('main.ts: a dev/env tree at another generation may still fall back to the built-in anchor', () => {
  // A source-line dev tree carries an opt-in lockfile and forbidden tree names,
  // so both of its own fact sources are refused. Without a stand-in the local
  // write face degrades to "official installs refused" for the repo's own
  // `DSH_CHAMBER_DSH_PATH` flow. The stand-in is env-only: a user-SELECTED
  // released runtime is NEVER judged by another line's anchor (W2).
  const facts = sliceBetween('const localProtectionFacts = (): PluginProtectionFacts => {',
    'const verifyLocalProfileFamily', 'localProtectionFacts')
  assert.match(facts, /if \(!family\.ok && !usePinned && resolved\.source === 'env'\) \{/,
    'the built-in anchor stand-in must be gated on an env-provided runtime that could not resolve its own facts')
  assert.match(facts, /family = resolveRuntimeFamily\(resolved\.path, \{ pinnedLockfilePath \}\)/,
    'the stand-in must retry the same resolution WITH the built-in anchor')
})
