/**
 * Windows probe unit tests (design 02 §5.1 parity work, M1): the pure
 * parsers/builders/classifiers of win-probes.ts are exercised on EVERY
 * platform; the exec helpers are win32-gated and their off-platform refusal
 * is asserted here too. Real Windows exec behavior (taskkill/netstat/CIM
 * exit codes and output shapes) is covered by the win32-only integration
 * tests (control-plane/test/win32-lifecycle.integration.test.ts) on the
 * Windows CI leg.
 *
 * Run directly: node packages/control-plane/test/win-probes.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCimTableCommand,
  classifyTaskkillOutput,
  descendantPidsOf,
  hasWindowsResidualTree,
  parseCimProcessTable,
  parseNetstatListeningPids,
  queryWindowsProcessTable,
  taskkillTreeArgs,
  treeKillWindows,
  windowsIdentity,
  windowsPortOwnedBy,
} from '../src/win-probes.ts'

test('parseCimProcessTable parses an array document', () => {
  const text = JSON.stringify([
    { ProcessId: 9021, ParentProcessId: 100, CommandLine: 'node bin.js --profile web' },
    { ProcessId: 9022, ParentProcessId: 9021, CommandLine: null },
  ])
  assert.deepEqual(parseCimProcessTable(text), [
    { pid: 9021, ppid: 100, command: 'node bin.js --profile web' },
    { pid: 9022, ppid: 9021, command: null },
  ])
})

test('parseCimProcessTable parses a single-object document and numeric-string fields', () => {
  const text = JSON.stringify({ ProcessId: '9021', ParentProcessId: '', CommandLine: 'x' })
  assert.deepEqual(parseCimProcessTable(text), [{ pid: 9021, ppid: null, command: 'x' }])
})

test('parseCimProcessTable skips rows without a pid and ignores garbage', () => {
  assert.deepEqual(parseCimProcessTable('not json'), [])
  assert.deepEqual(parseCimProcessTable(''), [])
  assert.deepEqual(parseCimProcessTable(JSON.stringify([{ CommandLine: 'x' }, { ProcessId: 7, ParentProcessId: null, CommandLine: '' }])), [
    { pid: 7, ppid: null, command: null },
  ])
})

test('descendantPidsOf walks the stale-parent chain and never returns the root', () => {
  const rows = parseCimProcessTable(JSON.stringify([
    { ProcessId: 1, ParentProcessId: 999, CommandLine: 'leader' },
    { ProcessId: 2, ParentProcessId: 1, CommandLine: 'child' },
    { ProcessId: 3, ParentProcessId: 2, CommandLine: 'grandchild' },
    { ProcessId: 4, ParentProcessId: 999, CommandLine: 'unrelated' },
  ]))
  assert.deepEqual(descendantPidsOf(rows, 1), [2, 3])
  assert.deepEqual(descendantPidsOf(rows, 99), [])
  // A dead leader is still the stale parent of its orphaned descendants.
  const orphaned = parseCimProcessTable(JSON.stringify([
    { ProcessId: 2, ParentProcessId: 1, CommandLine: 'child' },
    { ProcessId: 3, ParentProcessId: 2, CommandLine: 'grandchild' },
  ]))
  assert.deepEqual(descendantPidsOf(orphaned, 1), [2, 3])
})

test('descendantPidsOf tolerates a parent/child cycle without revisiting the root', () => {
  const rows = parseCimProcessTable(JSON.stringify([
    { ProcessId: 1, ParentProcessId: 2, CommandLine: 'a' },
    { ProcessId: 2, ParentProcessId: 1, CommandLine: 'b' },
  ]))
  assert.deepEqual(descendantPidsOf(rows, 1), [2])
})

test('parseNetstatListeningPids extracts LISTENING pids for the exact port', () => {
  const sample = [
    'Active Connections',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:17510        0.0.0.0:0              LISTENING       9021',
    '  TCP    [::1]:17510             [::]:0                 LISTENING       9021',
    '  TCP    127.0.0.1:5354         0.0.0.0:0              LISTENING       1000',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       888',
    '  UDP    127.0.0.1:17510        *:*                                    777',
  ].join('\r\n')
  assert.deepEqual(parseNetstatListeningPids(sample, 17510), [9021])
  assert.deepEqual(parseNetstatListeningPids(sample, 135), [888])
  assert.deepEqual(parseNetstatListeningPids(sample, 9999), [])
})

test('taskkillTreeArgs and classifyTaskkillOutput follow the documented contract', () => {
  assert.deepEqual(taskkillTreeArgs(42), ['/PID', '42', '/T', '/F'])
  assert.equal(classifyTaskkillOutput(0, 'SUCCESS: The process with PID 42 child process of PID 7 has been terminated.'), 'signalled')
  assert.equal(
    classifyTaskkillOutput(1, 'ERROR: The process "42" with PID 42 could not be terminated.\r\nReason: There is no running instance of the task.'),
    'gone',
  )
  assert.equal(classifyTaskkillOutput(1, 'ERROR: The process with PID 42 could not be terminated. Reason: Access is denied.'), 'error')
  // Non-zero without a not-found message never pretends absence.
  assert.equal(classifyTaskkillOutput(128, ''), 'error')
})

test('buildCimTableCommand is read-only UTF-8 table output', () => {
  const command = buildCimTableCommand()
  assert.match(command, /Get-CimInstance Win32_Process/)
  assert.match(command, /Select-Object ProcessId,ParentProcessId,CommandLine/)
  assert.match(command, /ConvertTo-Json -InputObject \$rows -Compress/)
  assert.match(command, /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/)
})

test('windows exec helpers fail closed off win32', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => queryWindowsProcessTable(), /win32/)
  assert.throws(() => windowsIdentity(1), /win32/)
  assert.throws(() => windowsPortOwnedBy(1, 80), /win32/)
  assert.throws(() => hasWindowsResidualTree(1), /win32/)
  assert.throws(() => treeKillWindows(1), /win32/)
})
