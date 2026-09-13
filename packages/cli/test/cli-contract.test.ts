/**
 * CLI ⇄ control-plane runtime-gate contracts (design 05 §7.2 保留面).
 *
 * The CLI is a thin shell over the management REST surface, but it is the
 * FIRST consumer of that surface's real wire shapes. Three gates were
 * misaligned with the implementation and are pinned here black-box: the child
 * process is the REAL `src/index.ts` (spawned with this node), driven against
 * an in-test node:http fake control plane, so every assertion below is about
 * what the binary actually prints / requests / exits with.
 *
 * 1. Log-line shape: the implementation returns {ts: string|null,
 *    stream: 'stdout'|'stderr'|null, line} (control-plane host-logs.ts
 *    parseLogLine) — a raw passthrough line carries NO metadata. The shell must
 *    render a placeholder for an unparseable/missing ts, never `new Date(null)`
 *    → 1970 and never an uncaught RangeError that kills `--follow`.
 * 2. `--limit`: the control plane CLAMPS to MAX_LIMIT (1000) instead of
 *    erroring, so a larger --limit silently truncates; the shell must refuse.
 *    The boundary is read from the control-plane source, not duplicated here.
 * 3. Recovery surface: GET /api/connections/local/writers and POST
 *    /api/connections/local/reclaim (control-plane api.ts, design 04 §3.2)
 *    need CLI entry points, and a 409 connection_busy refusal must reach the
 *    user as localized, actionable copy (the DELETE path's precedent).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

// fileURLToPath: the repo path contains spaces, so url.pathname would be
// percent-encoded and spawn() would look for a non-existent binary.
const CLI_PATH = fileURLToPath(new URL('../src/index.ts', import.meta.url))

/** The control plane's hard cap, read from its source — the CLI mirrors it, so
 *  the boundary assertions below can never drift from the authority. */
const CONTROL_PLANE_MAX_LIMIT = Number(
  /export const MAX_LIMIT = (\d+)/u.exec(
    readFileSync(new URL('../../control-plane/src/host-logs.ts', import.meta.url), 'utf8'),
  )?.[1] ?? '0',
)

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

type PlaneHandler = (req: IncomingMessage, res: ServerResponse) => void

interface FakePlane {
  url: string
  calls: string[]
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** Run `body` against a loopback fake control plane that records every call. */
async function withPlane(
  handler: PlaneHandler,
  body: (plane: FakePlane) => Promise<void>,
): Promise<void> {
  const calls: string[] = []
  const server = createServer((req, res) => {
    calls.push(`${req.method ?? 'GET'} ${req.url ?? ''}`)
    handler(req, res)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake plane did not bind a port')
  try {
    await body({ url: `http://127.0.0.1:${address.port}`, calls })
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
  }
}

interface CliRun {
  child: ChildProcess
  stdout: string
  stderr: string
  result: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

function startCli(args: string[]): CliRun {
  const child = spawn(process.execPath, [CLI_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  const run: CliRun = {
    child,
    stdout: '',
    stderr: '',
    result: new Promise(resolve => {
      child.on('close', (code, signal) => { resolve({ code, signal }) })
    }),
  }
  const capture = (stream: Readable | null, key: 'stdout' | 'stderr'): void => {
    if (stream === null) return
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => { run[key] += chunk })
  }
  capture(child.stdout, 'stdout')
  capture(child.stderr, 'stderr')
  return run
}

/** Run the CLI to completion (non-follow commands). */
async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const run = startCli(args)
  const { code } = await run.result
  return { code, stdout: run.stdout, stderr: run.stderr }
}

async function waitFor(condition: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => { setTimeout(resolve, 25) })
  }
  assert.fail(`timed out waiting for ${label}`)
}

async function stopCli(run: CliRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGKILL')
  await run.result
}

/** One raw passthrough line: the implementation's honest "no metadata" shape. */
const RAW_LINE = { ts: null, stream: null, line: 'raw line without metadata' }
/** A JSONL line whose ts is a string the implementation passes through
 *  verbatim (parseLogLine only checks `typeof ts === 'string'`). */
const NON_ISO_LINE = { ts: 'yesterday-ish', stream: 'stdout', line: 'non-iso ts line' }

function hostLogsPlane(lines: unknown[]): PlaneHandler {
  return (req, res) => {
    if ((req.url ?? '').startsWith('/api/host/logs')) {
      sendJson(res, 200, { port: 17500, lines, truncated: false })
      return
    }
    sendJson(res, 404, { error: 'not_found' })
  }
}

/* ------------------------------------------------------------------ */
/* 1. Log-line shape                                                   */
/* ------------------------------------------------------------------ */

test('host logs: a raw line (ts:null, stream:null) renders placeholders, never an epoch timestamp', async () => {
  await withPlane(hostLogsPlane([RAW_LINE]), async plane => {
    const result = await runCli(['host', 'logs', '--url', plane.url])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /^\[\?\] \[\?\] raw line without metadata$/mu)
    assert.equal(result.stdout.includes('1970'), false,
      'new Date(null) is not a timestamp — a raw line has none, and the shell must say so')
  })
})

test('host logs --follow: a ts:null line neither crashes nor fabricates 1970', async () => {
  await withPlane(hostLogsPlane([RAW_LINE]), async plane => {
    const run = startCli(['host', 'logs', '--follow', '--url', plane.url])
    try {
      await waitFor(
        () => run.stdout.includes('raw line without metadata') || run.child.exitCode !== null,
        'the followed snapshot to be printed',
      )
      assert.match(run.stdout, /^\[\?\] \[\?\] raw line without metadata$/mu)
      assert.equal(run.stdout.includes('1970'), false)
      assert.equal(run.stderr, '', 'a followed line must never be a fatal error')
      // Liveness: the follow loop keeps polling instead of exiting on the line.
      await new Promise(resolve => { setTimeout(resolve, 300) })
      assert.equal(run.child.exitCode, null, '--follow must stay alive across snapshots')
    } finally {
      await stopCli(run)
    }
  })
})

test('host logs --follow: a non-ISO ts string is a placeholder, not a RangeError out of the loop', async () => {
  await withPlane(hostLogsPlane([NON_ISO_LINE]), async plane => {
    const run = startCli(['host', 'logs', '--follow', '--url', plane.url])
    try {
      await waitFor(
        () => run.stdout.includes('non-iso ts line') || run.child.exitCode !== null,
        'the followed snapshot to be printed',
      )
      assert.match(run.stdout, /^\[\?\] \[stdout\] non-iso ts line$/mu)
      assert.equal(run.stderr, '',
        'new Date(<non-ISO>).toISOString() throws RangeError — that must never kill the follow loop')
      await new Promise(resolve => { setTimeout(resolve, 300) })
      assert.equal(run.child.exitCode, null)
    } finally {
      await stopCli(run)
    }
  })
})

/* ------------------------------------------------------------------ */
/* 2. --limit gate                                                     */
/* ------------------------------------------------------------------ */

test('host logs --limit: the control-plane cap is mirrored (cap accepted, cap+1 refused before any request)', async () => {
  assert.ok(Number.isInteger(CONTROL_PLANE_MAX_LIMIT) && CONTROL_PLANE_MAX_LIMIT > 0,
    'control-plane host-logs.ts MAX_LIMIT must stay a positive integer')
  await withPlane(hostLogsPlane([RAW_LINE]), async plane => {
    const accepted = await runCli(['host', 'logs', '--limit', String(CONTROL_PLANE_MAX_LIMIT), '--url', plane.url])
    assert.equal(accepted.code, 0, accepted.stderr)
    assert.equal(plane.calls.length, 1)
    assert.match(plane.calls[0]!, new RegExp(`limit=${CONTROL_PLANE_MAX_LIMIT}\\b`, 'u'))

    const refused = await runCli(['host', 'logs', '--limit', String(CONTROL_PLANE_MAX_LIMIT + 1), '--url', plane.url])
    assert.notEqual(refused.code, 0, 'an over-cap --limit must exit non-zero, never silently truncate')
    assert.match(refused.stderr, new RegExp(String(CONTROL_PLANE_MAX_LIMIT), 'u'))
    assert.equal(plane.calls.length, 1,
      'the refusal happens in the shell — an over-cap request must never reach the control plane')
  })
})

test('host logs --limit: non-positive and non-integer values are refused', async () => {
  await withPlane(hostLogsPlane([RAW_LINE]), async plane => {
    for (const value of ['0', '-1', '1.5', 'abc', '']) {
      const result = await runCli(['host', 'logs', '--limit', value, '--url', plane.url])
      assert.notEqual(result.code, 0, `--limit ${JSON.stringify(value)} must be refused`)
      assert.match(result.stderr, /--limit/u)
    }
    assert.equal(plane.calls.length, 0)
  })
})

/* ------------------------------------------------------------------ */
/* 3. Recovery surface + refusal mapping                               */
/* ------------------------------------------------------------------ */

test('connections writers: GET /api/connections/local/writers is reachable and rendered', async () => {
  await withPlane((req, res) => {
    if (req.method === 'GET' && req.url === '/api/connections/local/writers') {
      sendJson(res, 200, {
        quiescent: false,
        writers: [{
          name: 'managed-dsh/1.json',
          status: 'kept',
          pid: 4242,
          reason: 'identity-unverified',
          takeOverAvailable: true,
        }],
        errors: [],
      })
      return
    }
    sendJson(res, 404, { error: 'not_found' })
  }, async plane => {
    const result = await runCli(['connections', 'writers', '--url', plane.url])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(plane.calls, ['GET /api/connections/local/writers'])
    assert.match(result.stdout, /4242/u, 'the blocking writer pid must be visible')
    assert.match(result.stdout, /identity-unverified/u)
  })
})

test('connections writers --json: the raw diagnosis is passed through verbatim', async () => {
  const diagnosis = { quiescent: true, writers: [], errors: [] }
  await withPlane((_req, res) => { sendJson(res, 200, diagnosis) }, async plane => {
    const result = await runCli(['connections', 'writers', '--json', '--url', plane.url])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), diagnosis)
  })
})

test('connections writers: a 501 not_implemented surface is a localized hint, not a raw English body', async () => {
  await withPlane((_req, res) => {
    sendJson(res, 501, { code: 'not_implemented', message: 'this surface has no managed local host' })
  }, async plane => {
    const result = await runCli(['connections', 'writers', '--url', plane.url])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /501/u)
    assert.match(result.stderr, /not_implemented/u)
    assert.equal(/this surface has no managed local host/u.test(result.stderr), false,
      'the refusal is localized (the English wire detail is not the user-facing copy)')
  })
})

test('connections reclaim: POST /api/connections/local/reclaim is reachable and rendered', async () => {
  await withPlane((req, res) => {
    if (req.method === 'POST' && req.url === '/api/connections/local/reclaim') {
      sendJson(res, 200, {
        reclaimed: [4242],
        connection: { id: 'local', status: 'ready', dshPort: 17500 },
        spawned: true,
      })
      return
    }
    sendJson(res, 404, { error: 'not_found' })
  }, async plane => {
    const result = await runCli(['connections', 'reclaim', '--url', plane.url])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(plane.calls, ['POST /api/connections/local/reclaim'])
    assert.match(result.stdout, /4242/u)
    assert.match(result.stdout, /ready/u)
  })
})

test('connections reclaim: a 409 connection_busy refusal is localized', async () => {
  await withPlane((_req, res) => {
    sendJson(res, 409, { code: 'connection_busy', message: 'a live writer still holds the DSH_HOME' })
  }, async plane => {
    const result = await runCli(['connections', 'reclaim', '--url', plane.url])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /connection_busy/u)
    assert.equal(/a live writer still holds the DSH_HOME/u.test(result.stderr), false)
  })
})

test('connections add: a 409 connection_busy refusal reaches the user as localized, actionable copy', async () => {
  await withPlane((_req, res) => {
    sendJson(res, 409, {
      code: 'connection_busy',
      message: 'local DSH_HOME writer quiescence is not proven',
      detail: { writers: [] },
    })
  }, async plane => {
    const result = await runCli(['connections', 'add', '--kind', 'local', '--url', plane.url])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /409 connection_busy/u)
    assert.match(result.stderr, /写者/u, 'the refusal names the writer latch and the diagnosis command')
    assert.match(result.stderr, /connections writers/u)
    assert.equal(/writer quiescence is not proven/u.test(result.stderr), false)
  })
})
