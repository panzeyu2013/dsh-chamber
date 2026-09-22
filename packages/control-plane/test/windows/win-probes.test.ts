/**
 * Windows probe unit tests (design 02 §5.1 parity work): the pure
 * parsers/builders/classifiers of win-probes.ts are exercised on EVERY
 * platform; the exec helpers are win32-gated and their off-platform refusal
 * is asserted here too. Real Windows exec behavior (taskkill/netstat/CIM
 * exit codes and output shapes) is covered by the win32-only integration
 * tests (packages/control-plane/test/windows/win32-lifecycle.integration.test.ts) on the
 * Windows CI leg.
 *
 * Run directly: node packages/control-plane/test/windows/win-probes.test.ts
 *
 * Windows-fix coverage: case-insensitive netstat states and the
 * Get-NetTCPConnection JSON listen parser (primary port probe).
 * Windows-fix coverage: the CIM-table liveness verdict that replaces the
 * win32 process.kill(pid, 0) OpenProcess probe on the kill-confirmation paths.
 * The CIM/ConvertTo-Json parse rows, CreationDate identity rows, taskkill
 * classifiers, table command bytes and the off-platform exec refusal are pinned
 * by the cross-package gate protocol/win-probes-parity.test.ts (fixed expected
 * rows, strictly stronger), so they are not repeated here.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTcpListenTableCommand,
  cimPidLiveness,
  classifyCimLiveness,
  classifyCimLivenessFromTableReads,
  hasWindowsResidualTree,
  parseCimProcessTable,
  parseNetstatListeningPids,
  parseNetstatListeningRows,
  parseTcpConnectionListenJson,
  queryWindowsProcessTable,
  treeKillWindows,
  windowsIdentity,
  windowsPortOwnedBy,
} from '../../src/win-probes.ts'

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
