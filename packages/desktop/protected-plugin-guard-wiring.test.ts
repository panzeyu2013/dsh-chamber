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
