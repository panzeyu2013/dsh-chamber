/**
 * Windows process-tree probe unit tests (design 21 M2a): pure parsers and
 * classifiers of dsh-runtime/src/windows-process.ts run on every platform;
 * the exec helpers are win32-gated and their off-platform refusal is asserted
 * here too. Real Windows tooling behavior is covered by the control-plane
 * win32-only integration test (win32-lifecycle.integration.test.ts).
 *
 * Run directly: node packages/dsh-runtime/test/windows/windows-process.test.ts
 *
 * S5 windows-fix coverage: the CommandLine/CreationDate identity projection
 * and the pre-taskkill residual re-proof verdict (the control-plane twin's
 * S1 rule, ported back in S5 — review/windows/fixes/s5-win32-liveness.md).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cimRowStillIdentifies,
  classifyTaskkill,
  descendantPidsOf,
  hasWindowsDescendants,
  killWindowsTree,
  killWindowsTreeWithResidual,
  parseProcessTable,
  processTableCommand,
  queryWindowsProcessTable,
  taskkillTreeArgs,
} from '../../src/windows-process.ts'

test('parseProcessTable handles array, single-object and numeric-string documents', () => {
  assert.deepEqual(parseProcessTable(JSON.stringify([
    { ProcessId: 10, ParentProcessId: 1, CommandLine: 'node a.js', CreationDate: '\\/Date(1700000000000)\\/' },
    { ProcessId: 11, ParentProcessId: 10, CommandLine: null },
    { ProcessId: 12, ParentProcessId: null },
  ])), [
    { pid: 10, ppid: 1, command: 'node a.js', createdAt: '\\/Date(1700000000000)\\/' },
    { pid: 11, ppid: 10, command: null, createdAt: null },
    { pid: 12, ppid: null, command: null, createdAt: null },
  ])
  assert.deepEqual(parseProcessTable(JSON.stringify({ ProcessId: '20', ParentProcessId: '5', CommandLine: 'x', CreationDate: 'ts' })), [
    { pid: 20, ppid: 5, command: 'x', createdAt: 'ts' },
  ])
  assert.deepEqual(parseProcessTable(''), [])
  assert.deepEqual(parseProcessTable('garbage'), [])
  assert.deepEqual(parseProcessTable(JSON.stringify([{ ParentProcessId: 1 }])), [])
})

test('parseProcessTable keeps a string CommandLine/CreationDate and nulls any other type', () => {
  const text = JSON.stringify([
    { ProcessId: 1, ParentProcessId: 0, CommandLine: 'a', CreationDate: 42 },
    { ProcessId: 2, ParentProcessId: 1, CommandLine: '', CreationDate: '2026-01-01T00:00:00+08:00' },
  ])
  assert.deepEqual(parseProcessTable(text), [
    { pid: 1, ppid: 0, command: 'a', createdAt: null },
    { pid: 2, ppid: 1, command: null, createdAt: '2026-01-01T00:00:00+08:00' },
  ])
})

test('cimRowStillIdentifies requires a stable field to prove the same process', () => {
  const row = { pid: 7, ppid: 1, command: 'node worker.js', createdAt: '\\/Date(1700000000000)\\/' }
  assert.equal(cimRowStillIdentifies(row, { ...row }), 'match')
  // Pid reuse: same ProcessId, different creation date — never kill.
  assert.equal(cimRowStillIdentifies(row, { ...row, createdAt: '\\/Date(1800000000000)\\/' }), 'mismatch')
  // Gone between the scan and the fresh probe.
  assert.equal(cimRowStillIdentifies(row, null), 'mismatch')
  // CreationDate unreadable on both sides: the command line must prove it.
  const noDate = { ...row, createdAt: null }
  assert.equal(cimRowStillIdentifies(noDate, { ...noDate }), 'match')
  assert.equal(cimRowStillIdentifies(noDate, { ...noDate, command: 'node other.js' }), 'mismatch')
  // No shared stable field: fail closed, the caller refuses to terminate.
  assert.equal(cimRowStillIdentifies({ ...noDate, command: null }, { ...noDate, command: null }), 'unprovable')
})

test('descendantPidsOf walks stale parent chains, skips the root and tolerates cycles', () => {
  const sorted = (pids: number[]): number[] => [...pids].sort((a, b) => a - b)
  const rows = parseProcessTable(JSON.stringify([
    { ProcessId: 1, ParentProcessId: 99 },
    { ProcessId: 2, ParentProcessId: 1 },
    { ProcessId: 3, ParentProcessId: 2 },
    { ProcessId: 4, ParentProcessId: 99 },
  ]))
  // Traversal order is an implementation detail; membership is the contract.
  assert.deepEqual(sorted(descendantPidsOf(rows, 1)), [2, 3])
  assert.deepEqual(sorted(descendantPidsOf(rows, 99)), [1, 2, 3, 4])
  assert.deepEqual(descendantPidsOf(rows, 7), [])
  const cyclic = parseProcessTable(JSON.stringify([
    { ProcessId: 1, ParentProcessId: 2 },
    { ProcessId: 2, ParentProcessId: 1 },
  ]))
  assert.deepEqual(descendantPidsOf(cyclic, 1), [2])
})

test('taskkill args and outcome classifier follow the documented contract', () => {
  assert.deepEqual(taskkillTreeArgs(7), ['/PID', '7', '/T', '/F'])
  assert.equal(classifyTaskkill(0, 'SUCCESS: ... terminated.'), 'signalled')
  assert.equal(classifyTaskkill(1, 'ERROR: ... no running instance of the task.'), 'gone')
  assert.equal(classifyTaskkill(128, ''), 'error')
  assert.equal(classifyTaskkill(1, 'ERROR: ... Access is denied.'), 'error')
})

test('processTableCommand is read-only UTF-8 pid/parent/identity output', () => {
  const command = processTableCommand()
  assert.match(command, /Get-CimInstance Win32_Process/)
  assert.match(command, /Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate/)
  assert.match(command, /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/)
})

test('windows exec helpers fail closed off win32', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => queryWindowsProcessTable(), /win32/)
  assert.throws(() => hasWindowsDescendants(1), /win32/)
  assert.throws(() => killWindowsTree(1), /win32/)
  assert.throws(() => killWindowsTreeWithResidual(1), /win32/)
})
