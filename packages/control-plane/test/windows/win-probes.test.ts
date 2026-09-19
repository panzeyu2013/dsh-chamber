/**
 * Windows probe unit tests (design 02 §5.1 parity work, M1): the pure
 * parsers/builders/classifiers of win-probes.ts are exercised on EVERY
 * platform; the exec helpers are win32-gated and their off-platform refusal
 * is asserted here too. Real Windows exec behavior (taskkill/netstat/CIM
 * exit codes and output shapes) is covered by the win32-only integration
 * tests (packages/control-plane/test/windows/win32-lifecycle.integration.test.ts) on the
 * Windows CI leg.
 *
 * Run directly: node packages/control-plane/test/windows/win-probes.test.ts
 *
 * S1 windows-fix coverage: case-insensitive netstat states, the
 * Get-NetTCPConnection JSON listen parser (primary port probe), CreationDate
 * identity rows and the pre-taskkill residual re-proof verdict.
 * S5 windows-fix coverage: the CIM-table liveness verdict that replaces the
 * win32 process.kill(pid, 0) OpenProcess probe on the kill-confirmation paths
 * (review/windows/fixes/s5-win32-liveness.md).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildCimTableCommand,
  buildTcpListenTableCommand,
  cimPidLiveness,
  cimRowStillIdentifies,
  classifyCimLiveness,
  classifyCimLivenessFromTableReads,
  classifyTaskkillOutput,
  descendantPidsOf,
  hasWindowsResidualTree,
  parseCimProcessTable,
  parseNetstatListeningPids,
  parseNetstatListeningRows,
  parseTcpConnectionListenJson,
  queryWindowsProcessTable,
  taskkillTreeArgs,
  treeKillWindows,
  windowsIdentity,
  windowsPortOwnedBy,
} from '../../src/win-probes.ts'

test('parseCimProcessTable parses an array document', () => {
  const text = JSON.stringify([
    { ProcessId: 9021, ParentProcessId: 100, CommandLine: 'node bin.js --profile web', CreationDate: '\\/Date(1700000000000)\\/' },
    { ProcessId: 9022, ParentProcessId: 9021, CommandLine: null },
  ])
  assert.deepEqual(parseCimProcessTable(text), [
    { pid: 9021, ppid: 100, command: 'node bin.js --profile web', createdAt: '\\/Date(1700000000000)\\/' },
    { pid: 9022, ppid: 9021, command: null, createdAt: null },
  ])
})

test('parseCimProcessTable parses a single-object document and numeric-string fields', () => {
  const text = JSON.stringify({ ProcessId: '9021', ParentProcessId: '', CommandLine: 'x', CreationDate: '2026-01-01T00:00:00+08:00' })
  assert.deepEqual(parseCimProcessTable(text), [{ pid: 9021, ppid: null, command: 'x', createdAt: '2026-01-01T00:00:00+08:00' }])
})

test('parseCimProcessTable skips rows without a pid and ignores garbage', () => {
  assert.deepEqual(parseCimProcessTable('not json'), [])
  assert.deepEqual(parseCimProcessTable(''), [])
  assert.deepEqual(parseCimProcessTable(JSON.stringify([{ CommandLine: 'x' }, { ProcessId: 7, ParentProcessId: null, CommandLine: '' }])), [
    { pid: 7, ppid: null, command: null, createdAt: null },
  ])
})

test('parseCimProcessTable keeps a string CreationDate and nulls any other type', () => {
  const text = JSON.stringify([
    { ProcessId: 1, ParentProcessId: 0, CommandLine: 'a', CreationDate: '2026-01-01T00:00:00.0000000+08:00' },
    { ProcessId: 2, ParentProcessId: 1, CommandLine: 'b', CreationDate: 42 },
  ])
  assert.deepEqual(parseCimProcessTable(text), [
    { pid: 1, ppid: 0, command: 'a', createdAt: '2026-01-01T00:00:00.0000000+08:00' },
    { pid: 2, ppid: 1, command: 'b', createdAt: null },
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

test('parseNetstatListeningRows is case-insensitive on proto and state and drops junk pids', () => {
  const sample = [
    '  tcp    127.0.0.1:17510        0.0.0.0:0              listening       9021',
    '  TCP    [::1]:17510             [::]:0                 Listening       9021',
    '  TCP    127.0.0.1:5354         0.0.0.0:0              LISTENING       1000',
    '  TCP    127.0.0.1:5355         0.0.0.0:0              ESTABLISHED     1001',
    '  TCP    127.0.0.1:17510        0.0.0.0:0              LISTENING       not-a-pid',
  ].join('\n')
  assert.deepEqual(parseNetstatListeningRows(sample), [
    { port: 17510, pid: 9021 },
    { port: 5354, pid: 1000 },
  ])
  assert.deepEqual(parseNetstatListeningPids(sample, 17510), [9021])
})

test('parseTcpConnectionListenJson reads LocalPort/OwningProcess rows (array, single object, numeric strings)', () => {
  assert.deepEqual(parseTcpConnectionListenJson(JSON.stringify([
    { LocalPort: 17510, OwningProcess: 9021 },
    { LocalPort: 5354, OwningProcess: '1000' },
  ])), [
    { port: 17510, pid: 9021 },
    { port: 5354, pid: 1000 },
  ])
  // A single listener still serializes as a bare object, not an array.
  assert.deepEqual(
    parseTcpConnectionListenJson(JSON.stringify({ LocalPort: '17510', OwningProcess: 9021 })),
    [{ port: 17510, pid: 9021 }],
  )
})

test('parseTcpConnectionListenJson drops junk rows and unparseable documents', () => {
  assert.deepEqual(parseTcpConnectionListenJson('not json'), [])
  assert.deepEqual(parseTcpConnectionListenJson(''), [])
  assert.deepEqual(parseTcpConnectionListenJson(JSON.stringify([
    { LocalPort: 17510 },
    { OwningProcess: 9021 },
    { LocalPort: 0, OwningProcess: 4 },
    { LocalPort: 70000, OwningProcess: 4 },
    { LocalPort: 17510, OwningProcess: 0 },
    { LocalPort: 17510, OwningProcess: 9021 },
  ])), [{ port: 17510, pid: 9021 }])
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

test('classifyCimLiveness turns a CIM row into alive / dead / unknown (S5)', () => {
  const row = { pid: 7, ppid: 1, command: 'node worker.js', createdAt: '\\/Date(1700000000000)\\/' }
  // A row for the pid is alive, with or without an identity pin.
  assert.equal(classifyCimLiveness(7, null, row), true)
  assert.equal(classifyCimLiveness(7, row, { ...row }), true)
  // Table readable, pid absent: the scanned process object is gone.
  assert.equal(classifyCimLiveness(7, null, null), false)
  assert.equal(classifyCimLiveness(7, row, null), false)
  // Pid reused by another process: the scanned process is dead.
  assert.equal(classifyCimLiveness(7, row, { ...row, createdAt: '\\/Date(1800000000000)\\/' }), false)
  assert.equal(classifyCimLiveness(7, row, { ...row, pid: 8 }), false)
  // No shared identity field can prove the row: unknown, never "dead".
  const noProof = { ...row, createdAt: null, command: null }
  assert.equal(classifyCimLiveness(7, noProof, { ...noProof }), null)
})

test('the liveness classifier re-probes a FRESH table before trusting a cached "dead" (S5 fail-open)', () => {
  // The shared 500ms CIM cache can PREDATE the pid: a process created after
  // the cached read is absent from it while fully alive. "Dead" authorizes
  // skipping the signal (terminateChild) and dropping the pid record, so it
  // must be re-proved against a cache-bypassing read — mutation check:
  // deleting the fresh arm makes the first assertion below return false.
  const cachedRows = parseCimProcessTable(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, CommandLine: 'leader', CreationDate: 't0' },
  ]))
  const freshRows = parseCimProcessTable(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, CommandLine: 'leader', CreationDate: 't0' },
    { ProcessId: 200, ParentProcessId: 100, CommandLine: 'late child', CreationDate: 't1' },
  ]))
  const reads: boolean[] = []
  const read = (fresh: boolean) => {
    reads.push(fresh)
    return fresh ? freshRows : cachedRows
  }
  assert.equal(classifyCimLivenessFromTableReads(200, null, read), true)
  assert.deepEqual(reads, [false, true], 'the cached miss must be followed by exactly one fresh read')
  // A cached ALIVE verdict is final: no second interpreter start.
  reads.length = 0
  assert.equal(classifyCimLivenessFromTableReads(100, null, read), true)
  assert.deepEqual(reads, [false])
  // Cached dead + fresh dead: the fresh read is the absence proof.
  reads.length = 0
  assert.equal(classifyCimLivenessFromTableReads(999, null, read), false)
  assert.deepEqual(reads, [false, true])
  // Cached dead + fresh probe unavailable = unknown (null), so callers keep
  // their fail-closed answer instead of skipping a signal.
  assert.equal(classifyCimLivenessFromTableReads(999, null, fresh => {
    if (fresh) throw new Error('powershell unavailable')
    return cachedRows
  }), null)
  // Pid reuse inside the TTL: the fresh table names a DIFFERENT process for
  // the same pid, so the scanned process is dead (never "alive").
  const reusedRows = parseCimProcessTable(JSON.stringify([
    { ProcessId: 100, ParentProcessId: 1, CommandLine: 'leader', CreationDate: 't0' },
    { ProcessId: 200, ParentProcessId: 1, CommandLine: 'recycled pid', CreationDate: 't2' },
  ]))
  assert.equal(classifyCimLivenessFromTableReads(200, freshRows[1]!, fresh => fresh ? reusedRows : cachedRows), false)
  // No shared identity field on either side stays "unprovable" (null), never
  // "dead".
  const unpinned = { pid: 200, ppid: 100, command: null, createdAt: null }
  assert.equal(classifyCimLivenessFromTableReads(200, unpinned, read), null)
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
  assert.match(command, /Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate/)
  assert.match(command, /ConvertTo-Json -InputObject \$rows -Compress/)
  assert.match(command, /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/)
})

test('buildTcpListenTableCommand is the read-only Get-NetTCPConnection projection', () => {
  const command = buildTcpListenTableCommand()
  assert.match(command, /Get-NetTCPConnection -State Listen/)
  assert.match(command, /Select-Object LocalPort,OwningProcess/)
  assert.match(command, /ConvertTo-Json -InputObject \$rows -Compress/)
  assert.match(command, /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/)
})

test('windows exec helpers fail closed off win32', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => queryWindowsProcessTable(), /win32/)
  assert.throws(() => windowsIdentity(1), /win32/)
  assert.throws(() => windowsPortOwnedBy(1, 80), /win32/)
  assert.throws(() => hasWindowsResidualTree(1), /win32/)
  assert.throws(() => cimPidLiveness(1), /win32/)
  assert.throws(() => treeKillWindows(1), /win32/)
})
