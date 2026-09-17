/**
 * Main-process decision gates extracted from main.ts — merged suite
 * (2026-12 test reorganization).
 *
 * Sources (both were package-root tests; now one file):
 *   - apply-now-gate.test.ts   — the RUNTIME_APPLY_NOW gate matrix.
 *   - disk-evidence-gate.test.ts — the D7 disk-evidence skip set.
 * Both modules are pure decision functions extracted out of the electron entry
 * (main.ts) precisely so their matrices carry real unit assertions; that shared
 * subject area ("a gate lifted out of main.ts") is what justified the merge.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { evaluateApplyNowGate, type ApplyNowGateInput } from '../../apply-now-gate.ts'
import { DISK_SKIP_PROGRESS_PHASES, shouldSkipDiskRefresh } from '../../disk-evidence-gate.ts'
import {
  RENDERER_CRASH_RELOAD_DELAY_MS,
  RENDERER_HANG_RELOAD_DELAY_MS,
  RENDERER_RECOVERY_MAX_RELOADS,
  RENDERER_RECOVERY_WINDOW_MS,
  noteRendererReload,
  shouldReloadAfterCrash,
  shouldScheduleHangReload,
} from '../../shell-core.ts'
import type { RuntimePhase } from '@dsh-chamber/dsh-runtime'

// --- merged from test/runtime/apply-now-gate.test.ts ---
function gateInput(overrides: Partial<ApplyNowGateInput> = {}): ApplyNowGateInput {
  return {
    phase: 'pending',
    source: 'user',
    runtimeBlocked: false,
    managementSupported: true,
    hasOverride: true,
    pending: '2.0.0',
    journalTarget: null,
    overridePending: null,
    connectionState: 'ready',
    operationBusy: false,
    fenceBusy: false,
    snapshotFailed: false,
    treeValid: true,
    ...overrides,
  }
}

test('apply-now gate: a clean pending state resolves ok with the durable target', () => {
  const result = evaluateApplyNowGate(gateInput())
  assert.deepEqual(result, { ok: true, target: '2.0.0' })
})

test('apply-now gate: busy rejects (operation in flight or writer fence held)', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ operationBusy: true })), { ok: false, reason: 'busy' })
  assert.deepEqual(evaluateApplyNowGate(gateInput({ fenceBusy: true })), { ok: false, reason: 'busy' })
  // Busy is the first gate: it outranks env/blocked/not-ready/no-pending.
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    operationBusy: true,
    source: 'env',
    runtimeBlocked: true,
    connectionState: 'stopped',
    pending: null,
  })), { ok: false, reason: 'busy' })
})

test('apply-now gate: env source rejects (env outranks every persisted override)', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ source: 'env' })), { ok: false, reason: 'env' })
  // Env outranks the later gates (blocked/not-ready/no-pending/tree).
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    source: 'env',
    runtimeBlocked: true,
    connectionState: 'restarting',
    pending: null,
    treeValid: false,
  })), { ok: false, reason: 'env' })
})

test('apply-now gate: not-allowed rejects for non-pending phases and unsupported management', () => {
  // Every non-pending phase is rejected (pending is the only phase exposing
  // apply-now in the action matrix).
  for (const phase of ['idle', 'available', 'applying', 'applied', 'rollback', 'snapshot-failed', 'failed', 'error']) {
    assert.deepEqual(evaluateApplyNowGate(gateInput({ phase })), { ok: false, reason: 'not-allowed' }, phase)
  }
  // Read-only platforms reject regardless of phase.
  assert.deepEqual(evaluateApplyNowGate(gateInput({ managementSupported: false })), { ok: false, reason: 'not-allowed' })
  assert.deepEqual(evaluateApplyNowGate(gateInput({ managementSupported: false, phase: 'pending' })), { ok: false, reason: 'not-allowed' })
})

test('apply-now gate: runtimeBlocked rejects', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ runtimeBlocked: true })), { ok: false, reason: 'blocked' })
  // Blocked outranks the not-ready/no-pending/snapshot/tree gates.
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    runtimeBlocked: true,
    connectionState: 'stopped',
    pending: null,
    snapshotFailed: true,
    treeValid: false,
  })), { ok: false, reason: 'blocked' })
})

test('apply-now gate: not-ready rejects unless the control plane is ready or degraded', () => {
  for (const connectionState of ['stopped', 'restarting', 'restart-exhausted', 'error', 'starting', 'none']) {
    assert.deepEqual(
      evaluateApplyNowGate(gateInput({ connectionState })),
      { ok: false, reason: 'not-ready' },
      connectionState,
    )
  }
  // 'none' is the handler's null-control-plane projection; degraded stays ok.
  assert.deepEqual(evaluateApplyNowGate(gateInput({ connectionState: 'none' })), { ok: false, reason: 'not-ready' })
  assert.deepEqual(evaluateApplyNowGate(gateInput({ connectionState: 'degraded' })), { ok: true, target: '2.0.0' })
})

test('apply-now gate: no-pending rejects when all three durable sources are empty (F5)', () => {
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: null, overridePending: null })),
    { ok: false, reason: 'no-pending' },
  )
  // Target resolution precedes the tree/snapshot checks: with no durable
  // target there is nothing to snapshot-reject or tree-preflight.
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    pending: null,
    journalTarget: null,
    overridePending: null,
    snapshotFailed: true,
    treeValid: false,
  })), { ok: false, reason: 'no-pending' })
})

test('apply-now gate: snapshot-failed rejects (retry-apply owns that path)', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ snapshotFailed: true })), { ok: false, reason: 'snapshot-failed' })
  // Snapshot failure outranks the tree preflight.
  assert.deepEqual(evaluateApplyNowGate(gateInput({ snapshotFailed: true, treeValid: false })), { ok: false, reason: 'snapshot-failed' })
})

test('apply-now gate: invalid-tree rejects a resolved target whose tree preflight failed', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ treeValid: false })), { ok: false, reason: 'invalid-tree' })
  // A builtin-anchor journal target is not a version tree: apply-now must
  // never treat it as a valid target (pending is the only version-tree source
  // this path accepts; a builtin intent resolves nothing here).
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    pending: null,
    journalTarget: 'builtin-anchor',
    treeValid: false,
  })), { ok: false, reason: 'invalid-tree' })
})

test('apply-now gate: target resolution prefers pending over journalTarget over overridePending', () => {
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: '2.0.0', journalTarget: '3.0.0', overridePending: '4.0.0' })),
    { ok: true, target: '2.0.0' },
  )
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: '3.0.0', overridePending: '4.0.0' })),
    { ok: true, target: '3.0.0' },
  )
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: null, overridePending: '4.0.0' })),
    { ok: true, target: '4.0.0' },
  )
  // overridePending alone is enough (the post-confirm gate parity fix — the
  // second gate must accept the same three-source target the first does).
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: null, overridePending: '1.9.0', connectionState: 'degraded' })),
    { ok: true, target: '1.9.0' },
  )
})


// --- G21: Electron renderer-recovery policy (behavioural, not a source anchor) ---

test('G21 renderer recovery: at most 3 reloads inside a 60s window, then exhausted', () => {
  const budget = { windowStart: 0, count: 0 }
  // windowStart 0: the first three attempts inside 60s are allowed.
  assert.deepEqual(noteRendererReload(budget, 1_000), { allowed: true, attempt: 1 })
  assert.deepEqual(noteRendererReload(budget, 2_000), { allowed: true, attempt: 2 })
  assert.deepEqual(noteRendererReload(budget, 3_000), { allowed: true, attempt: 3 })
  // The 4th opens the loud stop (main.ts shows the error box, never reloads).
  assert.deepEqual(noteRendererReload(budget, 4_000), { allowed: false, attempt: 4 })
  assert.deepEqual(noteRendererReload(budget, 5_000), { allowed: false, attempt: 5 })
  assert.equal(RENDERER_RECOVERY_MAX_RELOADS, 3)
  assert.equal(RENDERER_RECOVERY_WINDOW_MS, 60_000)
})

test('G21 renderer recovery: the window reset boundary is the strict greater-than (moved verbatim from main.ts)', () => {
  // Exactly 60s after the window started is still inside it (attempt 4 stays
  // exhausted); one millisecond later a fresh window opens with attempt 1.
  const exact = { windowStart: 10_000, count: 3 }
  assert.deepEqual(noteRendererReload(exact, 70_000), { allowed: false, attempt: 4 })
  const past = { windowStart: 10_000, count: 3 }
  assert.deepEqual(noteRendererReload(past, 70_001), { allowed: true, attempt: 1 })
  assert.equal(past.windowStart, 70_001)
  assert.equal(past.count, 1)
})

test('G21 renderer recovery: crash and hang gates', () => {
  // clean-exit is the normal window teardown; a quit in flight owns every reason.
  assert.equal(shouldReloadAfterCrash('clean-exit', false), false)
  assert.equal(shouldReloadAfterCrash('clean-exit', true), false)
  for (const reason of ['abnormal-exit', 'oom', 'launch-failed', 'integrity-failure', 'killed']) {
    assert.equal(shouldReloadAfterCrash(reason, false), true, `${reason} must reload`)
    assert.equal(shouldReloadAfterCrash(reason, true), false, `${reason} while quitting must not reload`)
  }
  // S-34 gate: before the first did-finish-load an unresponsive renderer is only
  // logged (boot is legitimately busy); afterwards the 15s hang timer applies.
  assert.equal(shouldScheduleHangReload(false), false)
  assert.equal(shouldScheduleHangReload(true), true)
  assert.equal(RENDERER_HANG_RELOAD_DELAY_MS, 15_000)
  assert.equal(RENDERER_CRASH_RELOAD_DELAY_MS, 500)
})

test('G21 renderer recovery: main.ts routes every decision through the shared policy', () => {
  // The main process cannot be imported here (it loads electron); this lock keeps
  // the wiring on the tested policy instead of letting the inline decision grow back.
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  assert.match(main, /noteRendererReload\(reloadBudget, Date\.now\(\)\)/)
  assert.match(main, /shouldReloadAfterCrash\(details\.reason, quitRequested\)/)
  assert.match(main, /shouldScheduleHangReload\(loadedOnce\)/)
  assert.match(main, /RENDERER_CRASH_RELOAD_DELAY_MS/)
  assert.match(main, /RENDERER_HANG_RELOAD_DELAY_MS/)
  assert.match(main, /RENDERER_RECOVERY_MAX_RELOADS/)
  assert.doesNotMatch(main, /if \(now - reloadWindowStart > 60_000\)/, 'the inline budget must stay extracted')
})
// --- merged from test/runtime/disk-evidence-gate.test.ts ---
/** Full legal phase set of the runtime state machine (typed against the
 *  RuntimePhase union — a typo/rename here fails the typecheck). */
const ALL_RUNTIME_PHASES: readonly RuntimePhase[] = [
  'idle', 'checking', 'available', 'downloading', 'installing', 'pending',
  'applying', 'applied', 'rollback', 'snapshot-failed', 'failed', 'error',
]

const PROGRESS_PHASES = ['downloading', 'installing', 'applying'] as const
const NON_PROGRESS_PHASES: readonly RuntimePhase[] = [
  'idle', 'checking', 'available', 'pending', 'applied',
  'rollback', 'snapshot-failed', 'failed', 'error',
]

test('D7: the three pure-progress phases are in the skip set and skip the disk refresh', () => {
  for (const phase of PROGRESS_PHASES) {
    assert.ok(DISK_SKIP_PROGRESS_PHASES.has(phase), `${phase} must be in DISK_SKIP_PROGRESS_PHASES`)
    assert.equal(shouldSkipDiskRefresh(phase), true, `${phase} must skip the disk refresh`)
  }
})

test('D7: representative non-progress phases never skip the disk refresh', () => {
  for (const phase of NON_PROGRESS_PHASES) {
    assert.equal(DISK_SKIP_PROGRESS_PHASES.has(phase), false, `${phase} must not be in the skip set`)
    assert.equal(shouldSkipDiskRefresh(phase), false, `${phase} must not skip`)
  }
})

test('D7: the skip set stays exactly the three progress phases', () => {
  // 恒为 3：任何未来相位进入/离开 skip 集都会在此显式炸出，防止静默扩展。
  assert.equal(DISK_SKIP_PROGRESS_PHASES.size, 3)
  const full = new Set<RuntimePhase>(ALL_RUNTIME_PHASES)
  for (const phase of DISK_SKIP_PROGRESS_PHASES) {
    assert.ok(full.has(phase), `skip member '${phase}' must be a legal runtime phase`)
  }
  assert.deepEqual(
    [...DISK_SKIP_PROGRESS_PHASES].sort(),
    [...PROGRESS_PHASES].sort(),
    'the skip set must contain exactly downloading/installing/applying',
  )
})

// --- S-08 / S-41 / P-20: main.ts wiring of the tested decisions (2026-12 macOS audit) ---
//
// main.ts loads electron and cannot be imported here; these assertions pin the
// WIRING to the pure decisions whose behaviour matrices live in
// test/local-state/chamber-settings.test.ts. The source is comment-stripped so a
// commented-out line can never satisfy a contract.

const desktopMainCode = stripComments(readFileSync(new URL('../../main.ts', import.meta.url), 'utf8'))

/** The body block of a function whose signature starts with `signature`.
 *  The body brace is the LAST `{` before the end of the signature line: a
 *  return-type annotation may itself contain object type literals
 *  (`): { ok: true } | { ok: false; error: string } {`). */
function functionBodyBlock(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.notEqual(start, -1, `missing function ${signature}`)
  const lineEnd = source.indexOf('\n', start)
  assert.notEqual(lineEnd, -1, `unterminated signature ${signature}`)
  const open = source.lastIndexOf('{', lineEnd)
  assert.notEqual(open, -1, `no body block for ${signature}`)
  return balancedBlock(source, open)
}

/** The `{ … }` block that starts at or after `from` (balanced braces). */
function balancedBlock(source: string, from: number): string {
  const open = source.indexOf('{', from)
  assert.notEqual(open, -1, 'no block found in main.ts')
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail('unbalanced block in main.ts')
}

test('S-08 main.ts: the close handler defers the teardown to the shared close decision', () => {
  const marker = "win.on('close', (event) => {"
  const first = desktopMainCode.indexOf(marker)
  assert.notEqual(first, -1, 'the main-window close handler is gone from main.ts')
  assert.equal(desktopMainCode.indexOf(marker, first + 1), -1, 'a second close handler appeared')
  const handler = balancedBlock(desktopMainCode, first)
  assert.match(handler, /decideMainWindowClose\(\{/, 'the close route must go through the shared pure decision')
  for (const fact of [
    'behavior: chamberSettings.windowCloseBehavior',
    'recoveryAvailable',
    'quitRequested',
    'quitConfirmed',
    'updateRestartArmed: updaterQuitArmed',
  ]) {
    assert.ok(handler.includes(fact), `the close decision must weigh ${fact}`)
  }
  assert.match(handler, /event.preventDefault()/, 'hide/defer branches must preventDefault')
  assert.match(handler, /app.quit()/, 'the deferred close must start the quit chain — before-quit owns the decision')
  assert.doesNotMatch(handler, /showMainWindow()/, 'the close handler must never rebuild the window (S-08)')
})

test('S-08 main.ts: cancelling the quit restores the living window, never rebuilds it', () => {
  const start = desktopMainCode.indexOf("app.on('before-quit'")
  assert.notEqual(start, -1, 'the before-quit handler is gone from main.ts')
  const handler = balancedBlock(desktopMainCode, start)
  assert.match(handler, /if \(!quitRequested\) showMainWindow\(\)/,
    'the cancel/failure path must restore in place (S-08: no rebuild, no page reload)')
  assert.doesNotMatch(
    handler,
    /mainWindow === null \|\| mainWindow\.isDestroyed\(\)\) \{\s*showMainWindow\(\)/,
    'the destroyed-window rebuild guard must be gone: the window stays alive until the decision resolves',
  )
  // The no-control-plane allow path must confirm the quit too: the S-08 defer
  // branch re-enters app.quit() from inside the close event, and an allowing
  // path that left quitConfirmed false would make Electron close the window
  // again, re-entering the defer branch — an unbreakable app.quit() ↔ close loop.
  assert.match(handler, /if \(cp === null\) \{[\s\S]*?quitConfirmed = true;/,
    'the cp===null allow path must set quitConfirmed (the defer branch re-enters app.quit from close)')
})

test('S-41 main.ts: a corrupt settings file never moves the OS login item', () => {
  const start = desktopMainCode.indexOf('const settingsLoad = readSettingsFile(')
  assert.notEqual(start, -1, 'the startup settings load is gone from main.ts')
  assert.match(desktopMainCode, /launchAtLoginReconcileDecision\(settingsLoad\.state, chamberSettings\.launchAtLogin\)/,
    'the login-item reconcile must consult the read state, not just the defaulted value')
  assert.match(desktopMainCode, /const loginItemResult = applyLaunchAtLogin\(loginItemDecision\.enabled\)/,
    'only the decision\'s apply branch may reach the OS login item')
  assert.doesNotMatch(desktopMainCode, /applyLaunchAtLogin\(chamberSettings\.launchAtLogin\)/,
    'the raw (defaulted) settings value must never be replayed directly — that silently unregistered a corrupt-file login item')
})

test('P-20 main.ts: applyLaunchAtLogin reads the OS state back before reporting ok', () => {
  const fn = functionBodyBlock(desktopMainCode, 'function applyLaunchAtLogin(')
  assert.match(fn, /app\.getLoginItemSettings\(\)/, 'the darwin/win32 leg must read the item back')
  assert.match(fn, /verifyLaunchAtLoginReadBack\(enabled, observed, process\.platform\)/,
    'the read-back verdict must go through the tested predicate')
  assert.doesNotMatch(fn, /setLoginItemSettings\(\{ openAtLogin: enabled \}\);\s*return \{ ok: true \}/,
    'the write must not answer ok:true without the read-back')
  assert.match(fn, /if \(existsSync\(desktopFile\) !== enabled\)/,
    'the Linux file leg must verify its own post-write state')
})

