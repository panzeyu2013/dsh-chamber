/**
 * Module 03 tests: host-log reading (readManagedLog) and spawn diagnostics
 * (listDiagnostics) — pure-Node, tmp-directory fixtures, no dsh involved.
 *
 * Coverage:
 * - tail read: JSONL lines parsed oldest→newest, limit honored, ts/stream
 *   preserved, stderr stream tag, \r stripping;
 * - offset: skips the newest lines;
 * - validation: bad limit/offset → typed invalid_argument; limit clamped;
 * - truncation safety: multi-MB file read from the tail only, no partial
 *   lines ever, truncated flag when the window is insufficient; a small
 *   window-starved file is read whole instead;
 * - not-found: no spawn record; record present but no log file;
 *   claim files never resolve; corrupt records skipped;
 * - explicit-port keys (number and numeric string) bypass the registry;
 * - listDiagnostics: lastSpawn = newest record, per-record logFile facts;
 * - writer (createHostLogWriter): round-trip through readManagedLog with a
 *   non-null ISO ts; async open failure (dir removed) is swallowed instead
 *   of an uncaughtException, and the next write recreates the stream.
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostLogs, readLogTail, logPathFor, createHostLogWriter, DEFAULT_LIMIT, MAX_LIMIT, MAX_LOG_LINES } from '../src/host-logs.ts'
import { writePidRecord, DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import type { Logger } from '../src/types.ts'

const silentLogger: Logger = { log() {}, warn() {}, error() {} }

/** The wire error code of a rejected value (assert.rejects validators). */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  return 'code' in error ? String((error as { code?: unknown }).code) : undefined
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hostlogs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeLogs(stateDir: string): void {
  mkdirSync(join(stateDir, 'host-logs'), { recursive: true })
}

/** Write `count` JSONL entries with a recognizable per-line marker. */
function writeJsonlLines(path: string, count: number, { start = 0, prefix = 'msg' }: { start?: number; prefix?: string } = {}): void {
  const chunks = []
  for (let i = start; i < start + count; i++) {
    const ts = `2026-08-14T00:00:${String(i % 60).padStart(2, '0')}.000Z`
    chunks.push(JSON.stringify({ ts, stream: i % 7 === 0 ? 'stderr' : 'stdout', line: `${prefix} ${i}` }))
  }
  writeFileSync(path, chunks.join('\n') + '\n')
}

/* ------------------------------------------------------------------ *
 * readManagedLog — tail reading
 * ------------------------------------------------------------------ */

test('reads the newest limit lines, oldest first, preserving ts/stream', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = DEFAULT_DSH_START_PORT
  writeJsonlLines(logPathFor(stateDir, port), 300)
  writePidRecord(stateDir, 4242, port, process.pid)

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog('local')
  assert.equal(result.port, port)
  assert.equal(result.lines.length, DEFAULT_LIMIT)
  assert.equal(result.truncated, false)
  // newest lines: 300 entries → the last 200 = markers 100..299
  assert.equal(result.lines[0].line, 'msg 100')
  assert.equal(result.lines[result.lines.length - 1].line, 'msg 299')
  assert.equal(result.lines[0].ts, '2026-08-14T00:00:40.000Z')
  // stream tagging: 105 (105 % 7 === 0) is stderr
  const stderrEntry = result.lines.find(entry => entry.line === 'msg 105')
  assert.equal(stderrEntry?.stream, 'stderr')
  const stdoutEntry = result.lines.find(entry => entry.line === 'msg 101')
  assert.equal(stdoutEntry?.stream, 'stdout')
})

test('offset skips the newest lines', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17511
  writeJsonlLines(logPathFor(stateDir, port), 100)
  writePidRecord(stateDir, 4243, port, process.pid)

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog('local', { limit: 10, offset: 5 })
  // last 5 skipped: entries 85..94
  assert.equal(result.lines.length, 10)
  assert.equal(result.lines[0].line, 'msg 85')
  assert.equal(result.lines[9].line, 'msg 94')
})

test('explicit port keys (number and numeric string) bypass the registry', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17777
  writeJsonlLines(logPathFor(stateDir, port), 3)

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  for (const key of [port, String(port)]) {
    const result = await readManagedLog(key)
    assert.equal(result.port, port)
    assert.equal(result.lines.length, 3)
  }
})

test('plain-text lines pass through with null metadata; \\r stripped', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17512
  writeFileSync(logPathFor(stateDir, port), '{"ts":"t1","stream":"stdout","line":"json ok"}\nplain text\r\n')

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog(port)
  assert.deepEqual(result.lines[0], { ts: 't1', stream: 'stdout', line: 'json ok' })
  assert.deepEqual(result.lines[1], { ts: null, stream: null, line: 'plain text' })
})

/* ------------------------------------------------------------------ *
 * readManagedLog — validation
 * ------------------------------------------------------------------ */

test('bad limit/offset are typed invalid_argument; limit clamps to MAX_LIMIT', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17513
  writeJsonlLines(logPathFor(stateDir, port), 50)
  writePidRecord(stateDir, 4244, port, process.pid)

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  for (const bad of [{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: '5' }, { offset: -1 }, { offset: 1.5 }] as any[]) {
    await assert.rejects(() => readManagedLog('local', bad), error => {
      assert.equal(codeOf(error), 'invalid_argument')
      return true
    })
  }
  const clamped = await readManagedLog('local', { limit: MAX_LIMIT + 5000 })
  assert.equal(clamped.lines.length, 50) // only 50 exist; clamp did not error
})

/* ------------------------------------------------------------------ *
 * truncation safety
 * ------------------------------------------------------------------ */

test('multi-MB file: tail-only read, no partial lines, truncated flag', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17514
  writePidRecord(stateDir, 4245, port, process.pid)
  const path = logPathFor(stateDir, port)
  // ~1.6 MB of JSONL lines (well over the 256 KiB tail window, under 4 MiB
  // whole-read cap — so the window path is exercised and the read stays
  // whole-file only for the small-file branch elsewhere).
  writeJsonlLines(path, 20_000, { prefix: 'big' })

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog('local')
  assert.equal(result.lines.length, DEFAULT_LIMIT)
  assert.equal(result.lines[result.lines.length - 1].line, 'big 19999')
  // every returned line is a complete parseable entry — never a fragment
  for (const entry of result.lines) {
    assert.equal(typeof entry.line, 'string')
    assert.match(entry.line, /^big \d+$/)
  }
})

test('huge file beyond whole-read cap: truncated when the window is insufficient', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17515
  writePidRecord(stateDir, 4246, port, process.pid)
  const path = logPathFor(stateDir, port)
  // ~7.2 MB (over MAX_WHOLE_READ_BYTES): the 256 KiB window holds ≈3.6k
  // lines, so a 6000-line request cannot be satisfied → truncated: true and
  // only what the window held is returned (never a whole-file read).
  writeJsonlLines(path, 100_000, { prefix: 'huge' })

  // readManagedLog clamps limit to MAX_LIMIT (1000), which the window always
  // satisfies — truncation is only reachable through the unclamped tail API.
  const result = await readLogTail(path, { limit: 6000, offset: 0 })
  assert.equal(result.truncated, true)
  assert.ok(result.lines.length < 6000, `window held ${result.lines.length} lines`)
  assert.ok(result.lines.length > 1000, `window held ${result.lines.length} lines`)
  assert.equal(result.lines[result.lines.length - 1].line, 'huge 99999')
  for (const entry of result.lines) assert.match(entry.line, /^huge \d+$/)
})

test('huge file: a request the window CAN satisfy is not flagged truncated', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17515
  writePidRecord(stateDir, 4246, port, process.pid)
  writeJsonlLines(logPathFor(stateDir, port), 100_000, { prefix: 'huge' })

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog('local', { limit: 200 })
  assert.equal(result.truncated, false)
  assert.equal(result.lines.length, 200)
  assert.equal(result.lines[result.lines.length - 1].line, 'huge 99999')
})

test('window-starved file (window too small for the needed count) is read whole', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  const port = 17516
  // ~2000 × ~500 bytes ≈ 1 MB: over the 256 KiB tail window, under the 4 MiB
  // whole-read cap; limit 600 needs more than the window holds (≈510 long
  // lines) → whole-file re-read for a complete answer, no silent subset.
  const lines = []
  for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ ts: 't', stream: 'stdout', line: `tiny ${i} ${'x'.repeat(450)}` }))
  writeFileSync(logPathFor(stateDir, port), lines.join('\n') + '\n')

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog(port, { limit: 600 })
  assert.equal(result.truncated, false)
  assert.equal(result.lines.length, 600)
  assert.equal(result.lines[0].line, `tiny 1400 ${'x'.repeat(450)}`)
})

/* ------------------------------------------------------------------ *
 * not-found semantics
 * ------------------------------------------------------------------ */

test('no spawn record → typed not_found; claim files never resolve', async t => {
  const stateDir = tempDir(t)
  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  await assert.rejects(() => readManagedLog('local'), error => {
    assert.equal(codeOf(error), 'not_found')
    return true
  })
  await assert.rejects(() => readManagedLog('unknown-connection'), error => {
    assert.equal(codeOf(error), 'not_found')
    return true
  })
  // a claim (external takeover) is not a spawn record
  mkdirSync(join(stateDir, 'managed-dsh'), { recursive: true })
  writeFileSync(join(stateDir, 'managed-dsh', 'claim-4096.json'), JSON.stringify({ port: 4096, kind: 'external' }))
  await assert.rejects(() => readManagedLog('local'), error => {
    assert.equal(codeOf(error), 'not_found')
    return true
  })
})

test('spawn record present but no log file → typed not_found', async t => {
  const stateDir = tempDir(t)
  writePidRecord(stateDir, 4247, 17517, process.pid)
  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  await assert.rejects(() => readManagedLog('local'), error => {
    assert.equal(codeOf(error), 'not_found')
    return true
  })
  await assert.rejects(() => readManagedLog(17517), error => {
    assert.equal(codeOf(error), 'not_found')
    return true
  })
  // an unknown connectionId never silently resolves to the local host
  await assert.rejects(() => readManagedLog('unknown-connection'), error => {
    assert.equal(codeOf(error), 'not_found')
    return true
  })
})

test('corrupt spawn records are skipped; a valid one resolves', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  mkdirSync(join(stateDir, 'managed-dsh'), { recursive: true })
  writeFileSync(join(stateDir, 'managed-dsh', '999999.json'), 'not json at all')
  writePidRecord(stateDir, 4248, 17518, process.pid)
  writeJsonlLines(logPathFor(stateDir, 17518), 2)

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog('local')
  assert.equal(result.port, 17518)
  assert.equal(result.lines.length, 2)
})

test('empty log file → empty lines, no error', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  writeFileSync(logPathFor(stateDir, 17519), '')

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog(17519)
  assert.equal(result.lines.length, 0)
  assert.equal(result.truncated, false)
})

/* ------------------------------------------------------------------ *
 * listDiagnostics
 * ------------------------------------------------------------------ */

test('listDiagnostics: lastSpawn is the newest record, logFile facts attached', async t => {
  const stateDir = tempDir(t)
  makeLogs(stateDir)
  mkdirSync(join(stateDir, 'managed-dsh'), { recursive: true })
  const older = { pid: 1001, ownerPid: 55, port: 17520, binary: 'dsh', profile: 'dsh-control', source: 'spawn', startedAt: '2026-08-13T07:00:00.000Z' }
  const newer = { pid: 1002, ownerPid: 55, port: 17521, binary: 'dsh', profile: 'dsh-control', source: 'spawn', startedAt: '2026-08-14T07:00:00.000Z', ownerInstanceId: 'abc-123' }
  writeFileSync(join(stateDir, 'managed-dsh', '1001.json'), `${JSON.stringify(older)}\n`)
  writeFileSync(join(stateDir, 'managed-dsh', '1002.json'), `${JSON.stringify(newer)}\n`)
  writeFileSync(join(stateDir, 'managed-dsh', 'claim-4097.json'), JSON.stringify({ port: 4097, kind: 'external' }))
  writeFileSync(logPathFor(stateDir, 17521), '{"ts":"t","stream":"stdout","line":"hi"}\n')

  const { listDiagnostics } = hostLogs({ stateDir, logger: silentLogger })
  const diag = await listDiagnostics()
  assert.equal(diag.count, 2)
  assert.equal(diag.managed.length, 2)
  assert.equal(diag.lastSpawn?.pid, 1002)
  assert.equal(diag.lastSpawn?.port, 17521)
  assert.equal(diag.lastSpawn?.ownerInstanceId, 'abc-123')
  assert.equal(diag.lastSpawn?.logFile.exists, true)
  assert.equal(typeof diag.lastSpawn?.logFile.size, 'number')
  const olderEntry = diag.managed.find(entry => entry.pid === 1001)
  assert.equal(olderEntry?.logFile.exists, false)
})

test('listDiagnostics: no records → lastSpawn null, count 0', async t => {
  const stateDir = tempDir(t)
  const { listDiagnostics } = hostLogs({ stateDir, logger: silentLogger })
  const diag = await listDiagnostics()
  assert.equal(diag.count, 0)
  assert.equal(diag.lastSpawn, null)
  assert.deepEqual(diag.managed, [])
})

/* ------------------------------------------------------------------ *
 * readLogTail direct unit checks
 * ------------------------------------------------------------------ */

test('readLogTail drops the partial first line of a cut window', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'tail.log')
  // 300 KiB of lines with an unmistakable marker at the very start
  const lines = []
  for (let i = 0; i < 10_000; i++) lines.push(`L${i} ${'x'.repeat(30)}`)
  writeFileSync(path, lines.join('\n') + '\n')

  const { lines: read, truncated } = await readLogTail(path, { limit: 5, offset: 0 })
  assert.equal(truncated, false)
  assert.equal(read.length, 5)
  assert.equal(read[0].line, `L${9995} ${'x'.repeat(30)}`)
  assert.match(read[0].line, /^L\d+ x+$/) // never a half-cut fragment
})

/* ------------------------------------------------------------------ *
 * createHostLogWriter — the write side of the rolling-log convention
 * ------------------------------------------------------------------ */

test('writer→reader round-trip: ts is a non-null ISO string, lines/stream preserved', async t => {
  const stateDir = tempDir(t)
  const port = 17778
  const writer = createHostLogWriter(stateDir, port)
  writer.write('line one', 'stdout')
  writer.write('line two', 'stderr')
  writer.close()
  await new Promise(resolve => setTimeout(resolve, 100)) // let the stream flush

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog(port)
  assert.equal(result.lines.length, 2)
  assert.deepEqual(result.lines.map(entry => entry.line), ['line one', 'line two'])
  assert.deepEqual(result.lines.map(entry => entry.stream), ['stdout', 'stderr'])
  // every entry carries a real timestamp the parser accepts (a numeric ts
  // would parse as null — regression guard for the writer/parser contract)
  for (const entry of result.lines) {
    assert.equal(typeof entry.ts, 'string')
    assert.notEqual(entry.ts, '')
    assert.ok(!Number.isNaN(Date.parse(entry.ts ?? '')), `ts parses as a date: ${entry.ts}`)
  }
})

test('writer: a write landing on a removed dir is swallowed, not an uncaughtException; the next write recreates', async t => {
  const stateDir = tempDir(t)
  const port = 17779
  const writer = createHostLogWriter(stateDir, port)
  // Sync-append writer (2026 round-3 review): a write that lands while the
  // log dir is dead is LOST silently — a dead log file must never become an
  // uncaughtException or take the host pipes down; the NEXT write lazily
  // recreates dir + file.
  writer.write('first line', 'stdout')

  const uncaught: Error[] = []
  const onUncaught = (error: Error) => uncaught.push(error)
  process.on('uncaughtException', onUncaught)
  try {
    rmSync(join(stateDir, 'host-logs'), { recursive: true, force: true })
    writer.write('second line', 'stderr') // lost, swallowed
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(uncaught, [], 'a dead log must not become an uncaughtException')
  } finally {
    process.removeListener('uncaughtException', onUncaught)
  }

  // the lost write marked the writer for setup; the next write recreates
  writer.write('third line', 'stdout')
  writer.close()
  await new Promise(resolve => setTimeout(resolve, 100))

  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  const result = await readManagedLog(port)
  assert.equal(result.lines.length, 1)
  assert.equal(result.lines[0].line, 'third line')
  assert.equal(result.lines[0].stream, 'stdout')
  assert.ok(typeof result.lines[0].ts === 'string' && result.lines[0].ts !== '')
})

test('writer: rolling ring cap — beyond MAX_LOG_LINES the file stays bounded, newest lines kept', async t => {
  const stateDir = tempDir(t)
  const port = 17780
  const writer = createHostLogWriter(stateDir, port)
  // Cross the cap twice (with an interleaved second batch) so both the first
  // compaction and the re-armed counter are exercised: the file must never
  // grow unbounded and the newest lines must always survive.
  for (let i = 0; i < MAX_LOG_LINES + 60; i++) writer.write(`line ${i}`, 'stdout')
  for (let i = 0; i < MAX_LOG_LINES + 10; i++) writer.write(`more ${i}`, 'stderr')
  writer.close()
  // The WriteStream flush is asynchronous; a fixed sleep is flaky under load
  // (round-3 review: tail lines may still be buffered) — poll until the
  // newest line is observable on disk.
  const { readManagedLog } = hostLogs({ stateDir, logger: silentLogger })
  let result = await readManagedLog(port)
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && (result.lines.length === 0 || result.lines[result.lines.length - 1].line !== `more ${MAX_LOG_LINES + 9}`)) {
    await new Promise(resolve => setTimeout(resolve, 50))
    result = await readManagedLog(port)
  }
  assert.ok(result.lines.length <= MAX_LOG_LINES, `got ${result.lines.length} lines (cap ${MAX_LOG_LINES})`)
  // newest line survives whole; the very first lines are long gone
  assert.equal(result.lines[result.lines.length - 1].line, `more ${MAX_LOG_LINES + 9}`)
  assert.ok(!result.lines.some(entry => entry.line === 'line 0'), 'oldest line compacted away')
  assert.ok(result.lines.some(entry => entry.line.startsWith('more ')), 'newest batch survives')
})
