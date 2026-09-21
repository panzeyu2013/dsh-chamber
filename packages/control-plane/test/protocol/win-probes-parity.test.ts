/**
 * Cross-package parity/lockstep gate for the Windows process-probe twins
 * (audit 14 section 2 group 2, finding A2).
 *
 * packages/control-plane/src/win-probes.ts states in its header that
 * packages/dsh-runtime/src/windows-process.ts is its "twin ... Keep behavior
 * identical across both", yet the two copies are maintained by hand. This file
 * feeds the SAME fixed fixtures to both pure parsers/classifiers and asserts
 * both agreement AND the absolute expected verdict, so a synchronized
 * regression cannot pass either. The export-surface lock below forces a
 * register update whenever either twin adds, renames or drops a value export.
 *
 * The exec helpers are win32-gated; the off-platform refusal message is
 * asserted here and the real Windows tooling behavior stays with the
 * win32-only integration test (packages/control-plane/test/windows/
 * win32-lifecycle.integration.test.ts) on the Windows CI leg.
 *
 * Run directly: node packages/control-plane/test/protocol/win-probes-parity.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as cp from '../../src/win-probes.ts'
import * as rt from '../../../dsh-runtime/src/windows-process.ts'

interface Row {
  pid: number
  ppid: number | null
  command: string | null
  createdAt: string | null
}

/** Fixed CIM/ConvertTo-Json fixtures shared by both parsers; each entry carries
 *  the absolute expected rows so agreement alone is not the contract. */
const PARSE_FIXTURES: ReadonlyArray<{ name: string; input: string; expected: Row[] }> = [
  { name: 'empty string', input: '', expected: [] },
  { name: 'whitespace only', input: '   ', expected: [] },
  { name: 'garbage', input: 'not json', expected: [] },
  { name: 'json null', input: 'null', expected: [] },
  { name: 'json string', input: '"process"', expected: [] },
  { name: 'json number', input: '42', expected: [] },
  { name: 'empty array', input: '[]', expected: [] },
  {
    name: 'single object with numeric-string pid and empty parent',
    input: JSON.stringify({ ProcessId: '9021', ParentProcessId: '', CommandLine: 'x', CreationDate: '2026-01-01T00:00:00+08:00' }),
    expected: [{ pid: 9021, ppid: null, command: 'x', createdAt: '2026-01-01T00:00:00+08:00' }],
  },
  {
    name: 'array with mixed field types and a pid-less row',
    input: JSON.stringify([
      { ProcessId: 1, ParentProcessId: 0, CommandLine: 'a', CreationDate: 't1' },
      { ProcessId: '2', ParentProcessId: '1' },
      { ProcessId: 3, ParentProcessId: null, CommandLine: '', CreationDate: 42 },
      { ParentProcessId: 5, CommandLine: 'no-pid' },
      { ProcessId: true, ParentProcessId: 5 },
      { ProcessId: 1.5 },
    ]),
    expected: [
      { pid: 1, ppid: 0, command: 'a', createdAt: 't1' },
      { pid: 2, ppid: 1, command: null, createdAt: null },
      { pid: 3, ppid: null, command: null, createdAt: null },
    ],
  },
  {
    name: 'nested arrays are flattened in document order',
    input: JSON.stringify([[{ ProcessId: 7, ParentProcessId: 6, CommandLine: 'nested', CreationDate: null }]]),
    expected: [{ pid: 7, ppid: 6, command: 'nested', createdAt: null }],
  },
  {
    name: 'parent field of the wrong type is dropped to null',
    input: JSON.stringify([{ ProcessId: 8, ParentProcessId: true, CommandLine: 'x' }]),
    expected: [{ pid: 8, ppid: null, command: 'x', createdAt: null }],
  },
]

const TREE: Row[] = [
  { pid: 100, ppid: 1, command: 'root', createdAt: 'T100' },
  { pid: 101, ppid: 100, command: 'child-a', createdAt: 'T101' },
  { pid: 102, ppid: 100, command: 'child-b', createdAt: 'T102' },
  { pid: 103, ppid: 101, command: 'grandchild', createdAt: 'T103' },
  { pid: 104, ppid: 104, command: 'self-parent', createdAt: 'T104' },
  { pid: 105, ppid: null, command: 'orphan', createdAt: null },
  { pid: 106, ppid: 999, command: 'detached-from-unknown', createdAt: null },
  { pid: 107, ppid: 103, command: 'cycle-a', createdAt: null },
  { pid: 108, ppid: 107, command: 'cycle-b', createdAt: null },
]

const TASKKILL_CASES: ReadonlyArray<{ status: number | null; combined: string; expected: 'signalled' | 'gone' | 'error' }> = [
  { status: 0, combined: '', expected: 'signalled' },
  { status: 0, combined: 'ERROR: something odd', expected: 'signalled' },
  { status: 1, combined: 'ERROR: The process "7777" not found.', expected: 'gone' },
  { status: 1, combined: 'ERROR: No running instance of the task exists.', expected: 'gone' },
  { status: null, combined: 'No running instance', expected: 'gone' },
  { status: 128, combined: 'ERROR: Access is denied.', expected: 'error' },
  { status: null, combined: '', expected: 'error' },
  { status: 1, combined: '', expected: 'error' },
]

const IDENTITY_CASES: ReadonlyArray<{ original: Row; current: Row | null; expected: 'match' | 'mismatch' | 'unprovable' }> = [
  {
    original: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: 'T7' },
    current: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: 'T7' },
    expected: 'match',
  },
  {
    original: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: 'T7' },
    current: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: 'T8' },
    expected: 'mismatch',
  },
  {
    original: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: null },
    current: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: 'T7' },
    expected: 'match',
  },
  {
    original: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: 'T7' },
    current: { pid: 7, ppid: 1, command: 'node other.js', createdAt: null },
    expected: 'mismatch',
  },
  {
    original: { pid: 7, ppid: 1, command: null, createdAt: null },
    current: { pid: 7, ppid: 1, command: 'node worker.js', createdAt: 'T7' },
    expected: 'unprovable',
  },
  {
    original: { pid: 7, ppid: 1, command: null, createdAt: null },
    current: { pid: 7, ppid: 1, command: null, createdAt: null },
    expected: 'unprovable',
  },
  {
    original: { pid: 7, ppid: 1, command: 'a', createdAt: 'T7' },
    current: null,
    expected: 'mismatch',
  },
  {
    original: { pid: 7, ppid: 1, command: 'a', createdAt: 'T7' },
    current: { pid: 8, ppid: 1, command: 'a', createdAt: 'T7' },
    expected: 'mismatch',
  },
]

test('parseCimProcessTable / parseProcessTable agree with the fixed expected rows', () => {
  for (const fixture of PARSE_FIXTURES) {
    const a = cp.parseCimProcessTable(fixture.input)
    const b = rt.parseProcessTable(fixture.input)
    assert.deepEqual(a, fixture.expected, 'control-plane parser: ' + fixture.name)
    assert.deepEqual(b, fixture.expected, 'dsh-runtime parser: ' + fixture.name)
    assert.deepEqual(a, b, 'parser parity: ' + fixture.name)
  }
})

test('descendantPidsOf agrees on trees, self-parents, orphans and cycles', () => {
  const cases: ReadonlyArray<{ rootPid: number; expected: number[] }> = [
    { rootPid: 100, expected: [101, 102, 103, 107, 108] },
    { rootPid: 101, expected: [103, 107, 108] },
    { rootPid: 103, expected: [107, 108] },
    { rootPid: 104, expected: [] },
    { rootPid: 999, expected: [106] },
    { rootPid: 1000, expected: [] },
  ]
  for (const item of cases) {
    const a = cp.descendantPidsOf(TREE, item.rootPid)
    const b = rt.descendantPidsOf(TREE, item.rootPid)
    assert.deepEqual(a, item.expected, 'control-plane descendants of ' + item.rootPid)
    assert.deepEqual(b, item.expected, 'dsh-runtime descendants of ' + item.rootPid)
    assert.deepEqual(a, b, 'descendant parity for root ' + item.rootPid)
  }
})

test('taskkillTreeArgs is byte-identical for every pid shape', () => {
  for (const pid of [0, 1, 4242, 999999]) {
    assert.deepEqual(cp.taskkillTreeArgs(pid), ['/PID', String(pid), '/T', '/F'])
    assert.deepEqual(rt.taskkillTreeArgs(pid), ['/PID', String(pid), '/T', '/F'])
    assert.deepEqual(cp.taskkillTreeArgs(pid), rt.taskkillTreeArgs(pid))
  }
})

test('classifyTaskkillOutput / classifyTaskkill never turn a refusal into absence', () => {
  for (const item of TASKKILL_CASES) {
    const a = cp.classifyTaskkillOutput(item.status, item.combined)
    const b = rt.classifyTaskkill(item.status, item.combined)
    assert.equal(a, item.expected, 'control-plane verdict for ' + JSON.stringify(item))
    assert.equal(b, item.expected, 'dsh-runtime verdict for ' + JSON.stringify(item))
    assert.equal(a, b, 'classifier parity for ' + JSON.stringify(item))
  }
})

test('the CIM process-table command is byte-identical', () => {
  const expected = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
    + '$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate); '
    + 'ConvertTo-Json -InputObject $rows -Compress'
  assert.equal(cp.buildCimTableCommand(), expected)
  assert.equal(rt.processTableCommand(), expected)
  assert.equal(cp.buildCimTableCommand(), rt.processTableCommand())
})

test('cimRowStillIdentifies agrees and never authorizes a kill on doubt', () => {
  for (const item of IDENTITY_CASES) {
    const a = cp.cimRowStillIdentifies(item.original, item.current)
    const b = rt.cimRowStillIdentifies(item.original, item.current)
    assert.equal(a, item.expected, 'control-plane verdict for pid ' + String(item.original.pid))
    assert.equal(b, item.expected, 'dsh-runtime verdict for pid ' + String(item.original.pid))
    assert.equal(a, b, 'identity parity for pid ' + String(item.original.pid))
  }
})

test('win32-gated exec probes refuse off-platform with the same message', { skip: process.platform === 'win32' ? 'win32 host: real exec helpers run in win32-lifecycle.integration.test.ts' : false }, () => {
  assert.throws(() => cp.queryWindowsProcessTable(), /windows process probes are only available on win32/)
  assert.throws(() => rt.queryWindowsProcessTable(), /windows process probes are only available on win32/)
})

/**
 * Export-surface lockstep: a rename, removal or addition on either twin fails
 * this test, so the parity corpus above must be updated deliberately instead
 * of silently losing a compared face.
 */
test('the shared probe surface and the one-sided extras are exactly as registered', () => {
  const shared = [
    ['parseCimProcessTable', 'parseProcessTable'],
    ['descendantPidsOf', 'descendantPidsOf'],
    ['taskkillTreeArgs', 'taskkillTreeArgs'],
    ['classifyTaskkillOutput', 'classifyTaskkill'],
    ['buildCimTableCommand', 'processTableCommand'],
    ['cimRowStillIdentifies', 'cimRowStillIdentifies'],
    ['queryWindowsProcessTable', 'queryWindowsProcessTable'],
  ] as const
  const cpOnly = [
    'parseNetstatListeningRows',
    'parseNetstatListeningPids',
    'parseTcpConnectionListenJson',
    'buildTcpListenTableCommand',
    'classifyCimLiveness',
    'classifyCimLivenessFromTableReads',
    'cimPidLiveness',
    'windowsIdentity',
    'hasWindowsResidualTree',
    'windowsPortOwnedBy',
    'treeKillWindows',
  ] as const
  const rtOnly = ['hasWindowsDescendants', 'killWindowsTree', 'killWindowsTreeWithResidual'] as const
  for (const [cpName, rtName] of shared) {
    assert.equal(typeof (cp as Record<string, unknown>)[cpName], 'function', 'control-plane export ' + cpName)
    assert.equal(typeof (rt as Record<string, unknown>)[rtName], 'function', 'dsh-runtime export ' + rtName)
  }
  for (const name of cpOnly) {
    assert.equal(typeof (cp as Record<string, unknown>)[name], 'function', 'control-plane-only export ' + name)
    assert.equal((rt as Record<string, unknown>)[name], undefined, 'dsh-runtime must not grow ' + name + ' without registering it')
  }
  for (const name of rtOnly) {
    assert.equal(typeof (rt as Record<string, unknown>)[name], 'function', 'dsh-runtime-only export ' + name)
    assert.equal((cp as Record<string, unknown>)[name], undefined, 'control-plane must not grow ' + name + ' without registering it')
  }
  const expectedCp = [...shared.map(pair => pair[0]), ...cpOnly].sort()
  const expectedRt = [...shared.map(pair => pair[1]), ...rtOnly].sort()
  assert.deepEqual(Object.keys(cp).sort(), expectedCp, 'the control-plane export set changed - update the register')
  assert.deepEqual(Object.keys(rt).sort(), expectedRt, 'the dsh-runtime export set changed - update the register')
})
