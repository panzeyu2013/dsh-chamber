/**
 * Sidecar boot-account lockstep (E1 启动账).
 *
 * Two invariants that a refactor can silently undo, both pinned by reading the
 * real entry source (the repo's established lockstep style):
 *
 *  1. The login-shell probe starts BEFORE the headless ctx assembly, so its
 *     ~0.65s (cold tail 1.19s) runs underneath the ~1.1s assembly instead of on
 *     the first-frame critical path.
 *  2. Every fatal early exit and the graceful shutdown abort that probe: it is
 *     spawned detached, so a missed abort leaves a stray shell process group.
 *
 * The `[perf] sidecar` marks are pinned too — they are the only attribution
 * this 1.1s block has (see .tmp/perf-2026-11-15/report.md §1).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fileURLToPath } from 'node:url'

// Comments must not satisfy a lock (the repo's stripComments discipline): a mark or an
// abort that only exists in a comment/dead-branch comment is not on the live path.
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const entryPath = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'sidecar-entry.ts')
const source = stripComments(readFileSync(entryPath, 'utf8'))
const settingsPath = entryPath.replace('sidecar-entry.ts', 'shell-ipc-settings.ts')
const settingsSource = stripComments(readFileSync(settingsPath, 'utf8'))

test('sidecar entry: the login-shell probe is hoisted above the headless ctx assembly', () => {
  const probe = source.indexOf('startLoginShellEnvironment(')
  const assembly = source.indexOf('buildHeadlessCtx(')
  assert.ok(probe > 0, 'the probe start is present')
  assert.ok(assembly > 0, 'the assembly call is present')
  assert.ok(probe < assembly,
    'the probe must start before buildHeadlessCtx (E1): otherwise 0.65s sits on the first-frame path')
  // …and the probe must NOT be awaited before the assembly either: `await loginShellEnvironment`
  // inside that window re-serializes the 0.65s onto the critical path while every string above
  // still matches (negative control: insert it → this assertion goes red).
  const between = source.slice(probe, assembly)
  assert.ok(!/await\s+loginShellEnvironment/u.test(between),
    'the probe must not be awaited before the assembly (that re-serializes the probe onto the boot path)')
})

test('sidecar entry: every fatal exit and the shutdown abort the detached probe', () => {
  // 切片上界必须停在 boot().catch：否则会把该处的 abort 算进 shutdown，删掉 shutdown 的
  // abort 仍绿（负向对照实测）。
  const shutdown = source.slice(source.indexOf('async function shutdown('), source.indexOf('void boot().catch('))
  assert.ok(shutdown.includes('abortLoginShell()'),
    'graceful shutdown must abort the probe (detached shell group)')
  const bootFailure = source.slice(source.indexOf('void boot().catch('), source.indexOf("process.on('uncaughtException'"))
  assert.ok(bootFailure.includes('abortLoginShell()'),
    'a fatal boot rejection must abort the probe')
  const planeStart = source.slice(source.indexOf('await controlPlane.start()'), source.indexOf('control plane listening on'))
  assert.ok(planeStart.includes('abortLoginShell()'),
    'a fatal control-plane start must abort the probe')
  const legacy = source.slice(source.indexOf('if (legacyStart && isPackagedSidecarRuntime())'), source.indexOf('type SpawnGateShape'))
  assert.ok(legacy.includes('abortLoginShell()'), 'the dev-legacy fatal path must abort the probe')
  // Presence is not enough: an abort placed AFTER process.exit is unreachable. Pin the order
  // inside every slice that owns a fatal exit.
  for (const [name, slice] of [['shutdown', shutdown], ['boot.catch', bootFailure], ['planeStart', planeStart], ['legacy', legacy]]) {
    const abortAt = slice.indexOf('abortLoginShell()')
    const exitAt = slice.indexOf('process.exit(')
    assert.ok(abortAt >= 0, name + ' must abort the probe')
    if (exitAt >= 0) assert.ok(abortAt < exitAt, name + ': abortLoginShell() must run BEFORE process.exit()')
  }
  // Slice each handler so a nearby abort cannot satisfy a sibling's lock (a proximity
  // regex stayed green after deleting one handler's abort — negative control in round 4).
  const uncaught = source.slice(source.indexOf("process.on('uncaughtException'"), source.indexOf("process.on('unhandledRejection'"))
  assert.ok(uncaught.includes('abortLoginShell()'), 'a crash handler must abort the probe')
  const unhandled = source.slice(source.indexOf("process.on('unhandledRejection'"), source.indexOf("process.on('exit'"))
  assert.ok(unhandled.includes('abortLoginShell()'), 'an unhandled rejection must abort the probe')
  const exitHook = source.slice(source.indexOf("process.on('exit'"))
  assert.ok(exitHook.includes('abortLoginShell()'), 'a last-resort exit hook must abort the probe')
})

test('sidecar entry: the boot-account marks sit in order on the pre-listen path', () => {
  // Order is the contract: a mark moved into a dead branch (or reordered) makes the
  // segments lie while every string is still present, so pin the source order.
  const stages = ['boot-begin', 'loginShellEnv-started', 'headlessCtx', 'ipcHandlers', 'planeStart-begin', 'planeListening']
  // The settled mark is emitted from the probe's .then with its duration appended, so it is
  // pinned separately (it must sit between the start and the assembly mark).
  const settledAt = source.indexOf("perfMark('loginShellEnv-settled(")
  const startedAt = source.indexOf("perfMark('loginShellEnv-started')")
  const assemblyAt = source.indexOf("perfMark('headlessCtx')")
  // Text order is not execution order here: the settled mark sits inside the probe's .then
  // (declared before the started mark) but must still be inside the pre-assembly window.
  assert.ok(settledAt > source.indexOf('startLoginShellEnvironment(') && settledAt < assemblyAt,
    'the settled mark must live inside the pre-assembly window')
  assert.ok(startedAt > 0 && startedAt < assemblyAt, 'the started mark must precede the assembly')
  let previous = -1
  for (const stage of stages) {
    const at = source.indexOf(`perfMark('${stage}')`)
    assert.ok(at >= 0, `missing [perf] sidecar mark: ${stage}`)
    assert.ok(at > previous, `${stage} must appear after the previous stage on the boot path`)
    previous = at
  }
})

test('shell ipc: pageReady is emitted once, from the renderer handshake', () => {
  const markAt = settingsSource.indexOf("perfMark('pageReady')") >= 0
    ? settingsSource.indexOf("perfMark('pageReady')")
    : settingsSource.indexOf("[perf] sidecar pageReady")
  assert.ok(markAt >= 0, 'shell-ipc-settings must emit the pageReady mark')
  assert.ok(settingsSource.includes('NOTIFICATIONS_READY'), 'it rides the renderer readiness handshake')
  assert.match(settingsSource, /let pageReadyMarked = false/u, 'a once-guard keeps it one line per process')
  assert.match(settingsSource, /if \(!pageReadyMarked\)/u, 'the guard must gate the emit')
})
