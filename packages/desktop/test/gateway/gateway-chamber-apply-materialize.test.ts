/** gateway provider — part 4: gatewayChamberApplyBatch / gatewayChamberMaterialize — the apply
 *  flow, refusals and partial outcomes, settle/restart polls, tarball upload headers and the
 *  client-side pre-flight gates (siblings: gateway-provider / gateway-session-spki / gateway-chamber-sync). */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GATEWAY_RUNTIME_IDENTITY, gatewayChamberApplyBatch, gatewayChamberMaterialize } from '../../gateway-provider.ts'
import { parseSpecArg } from '../../gateway-ipc-shared.ts'
import { CERT_A, KEY_A, PIN_B } from '../support/gateway-tls-fixtures.ts'
import { startHttpsProbeServer, startSyncHttpServer } from '../support/gateway-test-servers.ts'

// ---------------------------------------------------------------------------
// Gateway batch apply + folder materialize (design 21 §6.5, plan Phase 4.6)
// ---------------------------------------------------------------------------

/** JSON helper used by the fixture servers below. */
function fixtureJson(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

const FIXTURE_TARBALL = Buffer.from('fake tgz bytes for the materialize fixture')

type BatchParams = Parameters<typeof gatewayChamberApplyBatch>[0]
type MaterializeParams = Parameters<typeof gatewayChamberMaterialize>[0]

/** The standard apply/materialize call target (gw-1, loopback origin, no TLS
 *  pin, no extra headers); `extra` carries the per-case timeout/authority
 *  overrides, `headers` overriding the empty default. */
function batchTarget(port: number, options: BatchParams['options'], extra: Partial<BatchParams> = {}): BatchParams {
  return { id: 'gw-1', url: `http://127.0.0.1:${port}`, headers: {}, spkiPin: null, options, ...extra }
}

function materializeTarget(port: number, tarball: MaterializeParams['tarball'], name: MaterializeParams['name'], version: MaterializeParams['version'], extra: Partial<MaterializeParams> = {}): MaterializeParams {
  return { id: 'gw-1', url: `http://127.0.0.1:${port}`, headers: {}, spkiPin: null, tarball, name, version, ...extra }
}

test('parseSpecArg: gateway registry add specs parse to their package names (plan Phase 4.6)', () => {
  assert.deepEqual(parseSpecArg('alpha'), { name: 'alpha' })
  assert.deepEqual(parseSpecArg('alpha@^1.2.3'), { name: 'alpha' })
  assert.deepEqual(parseSpecArg('@scope/name@2.0.0-beta.1'), { name: '@scope/name' })
  assert.equal(parseSpecArg('file:/tmp/x.tgz'), null, 'file: specs belong to the materialize channel')
  // Official/chamber scope is a SHAPE pass on the gateway client path (design
  // 21 §6.11.5): the server's protected-set judgement decides it.
  assert.deepEqual(parseSpecArg('@dsh-chamber/host-graph@1.0.0'), { name: '@dsh-chamber/host-graph' })
  assert.equal(parseSpecArg('not a spec'), null)
  assert.equal(parseSpecArg(''), null)
})

test('gatewayChamberApplyBatch: full flow installs, removes, waits for the ops to settle and restarts to apply', async () => {
  const seen: Array<{ method: string; url: string; headers: import('node:http').IncomingHttpHeaders; body?: unknown }> = []
  let statusCalls = 0
  const server = await startSyncHttpServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, ...(body === '' ? {} : { body: JSON.parse(body) }) })
      if (req.url === '/chamber/plugins/install' && req.method === 'PUT') {
        fixtureJson(res, 202, { accepted: true, opId: 'op-install-1' })
        return
      }
      if (req.url === '/chamber/plugins/remove' && req.method === 'POST') {
        fixtureJson(res, 202, { accepted: true, opId: 'op-remove-1' })
        return
      }
      if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
        fixtureJson(res, 200, {
          ok: true,
          busy: false,
          tasks: [
            { id: 'op-install-1', kind: 'install', name: 'alpha', preImage: null, status: 'ok' },
            { id: 'op-remove-1', kind: 'remove', name: 'beta', preImage: null, status: 'ok' },
          ],
          deferred: [],
        })
        return
      }
      if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
        fixtureJson(res, 202, { accepted: true })
        return
      }
      if (req.url === '/chamber/runtime/status' && req.method === 'GET') {
        statusCalls += 1
        // First projection: restart still running; second: settled ok.
        fixtureJson(res, 200, statusCalls === 1
          ? { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'restarting', restart: 'running' }
          : { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'ready', restart: 'ok' })
        return
      }
      fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
    })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha@^1.0.0'], remove: ['beta'] }, {
   headers: { authorization: 'Bearer test-token' },
   settleIntervalMs: 5,
   restartPollIntervalMs: 5,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.outcome, {
        installed: ['alpha'],
        removed: ['beta'],
        restarted: true,
        deferredOps: [],
      })
    }
    assert.deepEqual(seen.map(entry => `${entry.method} ${entry.url}`), [
      // Remove-before-add (design 21 decision 5): the removal is submitted
      // before the install, then the ops settle and the restart runs.
      'POST /chamber/plugins/remove',
      'PUT /chamber/plugins/install',
      'GET /chamber/plugins/tasks',
      'POST /chamber/runtime/restart',
      'GET /chamber/runtime/status',
      'GET /chamber/runtime/status',
    ])
    const remove = seen.find(entry => entry.url === '/chamber/plugins/remove')
    assert.deepEqual(remove?.body, { name: 'beta' })
    const install = seen.find(entry => entry.url === '/chamber/plugins/install')
    assert.deepEqual(install?.body, { name: 'alpha', spec: 'alpha@^1.0.0' })
    for (const entry of seen) {
      assert.equal(entry.headers.authorization, 'Bearer test-token')
    }
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: an ssh-tunnel origin presents the remote authority on every request', async () => {
  const hosts: string[] = []
  const seen: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    hosts.push(req.headers.host ?? '(none)')
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.url === '/chamber/plugins/install' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-1' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, { ok: true, busy: false, tasks: [{ id: 'op-1', kind: 'install', name: 'alpha', preImage: null, status: 'ok' }], deferred: [] })
      return
    }
    if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
      fixtureJson(res, 202, { accepted: true })
      return
    }
    if (req.url === '/chamber/runtime/status' && req.method === 'GET') {
      fixtureJson(res, 200, { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'ready', restart: 'ok' })
      return
    }
    fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha'], remove: [] }, {
   authority: 'gateway.example:8443',
   settleIntervalMs: 5,
   restartPollIntervalMs: 5,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, true)
    assert.deepEqual(seen, [
      'PUT /chamber/plugins/install',
      'GET /chamber/plugins/tasks',
      'POST /chamber/runtime/restart',
      'GET /chamber/runtime/status',
    ])
    assert.ok(hosts.length >= 4, 'every request presents the tunnel authority')
    for (const host of hosts) assert.equal(host, 'gateway.example:8443')
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: deferRestart skips the settle/restart polls entirely', async () => {
  const seen: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`)
    fixtureJson(res, 202, { accepted: true, opId: 'op-1' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha'], remove: [], deferRestart: true }, {
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.outcome, { installed: ['alpha'], removed: [], restarted: false, deferredOps: [] })
    }
    assert.deepEqual(seen, ['PUT /chamber/plugins/install'])
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: a first-op refusal fails loud with the code and NO phantom outcome', async () => {
  const server = await startSyncHttpServer((_req, res) => {
    fixtureJson(res, 409, { error: 'duplicate operation pending', code: 'queue_busy' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha@^1.0.0'], remove: [] }, {
   headers: { authorization: 'Bearer test-token' },
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /install of alpha refused \(HTTP 409, code queue_busy\)/)
      assert.match(result.error, /duplicate operation pending/)
      assert.equal(result.outcome, undefined, 'nothing executed before the first-op refusal')
    }
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: a mid-batch refusal aborts with the honest partial outcome', async () => {
  let calls = 0
  const server = await startSyncHttpServer((_req, res) => {
    calls += 1
    if (calls === 1) {
      fixtureJson(res, 202, { accepted: true, opId: 'op-1' })
      return
    }
    fixtureJson(res, 409, { error: 'runtime mutation in progress', code: 'runtime_busy' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha', 'beta'], remove: [] }, {
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /install of beta refused/)
      assert.match(result.error, /ops already executed before the failure: 1/)
      assert.deepEqual(result.outcome, { installed: ['alpha'], removed: [], restarted: false, deferredOps: [] })
    }
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: a mid-removal refusal stops the batch before ANY install (remove-first, decision 5)', async () => {
  const seen: string[] = []
  let calls = 0
  const server = await startSyncHttpServer((req, res) => {
    calls += 1
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`)
    if (req.url === '/chamber/plugins/remove' && req.method === 'POST' && calls === 1) {
      fixtureJson(res, 202, { accepted: true, opId: 'op-rm-1' })
      return
    }
    fixtureJson(res, 409, { error: 'not installed', code: 'not_installed' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha'], remove: ['beta', 'gamma'] }, {
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /remove of gamma refused/)
      assert.match(result.error, /ops already executed before the failure: 1/)
      assert.deepEqual(result.outcome, { installed: [], removed: ['beta'], restarted: false, deferredOps: [] })
    }
    assert.deepEqual(seen, [
      'POST /chamber/plugins/remove',
      'POST /chamber/plugins/remove',
    ], 'a failed removal stops the batch: no install request ever goes out')
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: an op that fails in the gateway executor blocks the restart with its journal error', async () => {
  let calls = 0
  const server = await startSyncHttpServer((req, res) => {
    calls += 1
    if (req.url === '/chamber/plugins/install' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-bad' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, {
        ok: true,
        busy: false,
        tasks: [{ id: 'op-bad', kind: 'install', name: 'alpha', preImage: 'backups/op-bad', status: 'failed', error: 'pnpm add failed (exit 1)' }],
        deferred: [],
      })
      return
    }
    fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha'], remove: [] }, {
   settleIntervalMs: 5,
   settleTimeoutMs: 2_000,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /install of alpha failed on the gateway: pnpm add failed \(exit 1\)/)
      assert.deepEqual(result.outcome, { installed: ['alpha'], removed: [], restarted: false, deferredOps: [] })
    }
    assert.equal(calls, 2, 'no restart was asked over a failed op (install + tasks only)')
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: a restart refusal after execution is a loud partial failure, never swallowed', async () => {
  const server = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/install' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-1' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, { ok: true, busy: false, tasks: [{ id: 'op-1', kind: 'install', name: 'alpha', preImage: null, status: 'ok' }], deferred: [] })
      return
    }
    fixtureJson(res, 409, { error: 'managed profile write in flight (plugin mutation); restart refused', code: 'runtime_busy' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha'], remove: [] }, {
   settleIntervalMs: 5,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /restart of the managed dsh refused \(HTTP 409, code runtime_busy\)/)
      assert.deepEqual(result.outcome, { installed: ['alpha'], removed: [], restarted: false, deferredOps: [] })
    }
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: a post-202 restart rejection (restart failed) surfaces the operationError', async () => {
  const server = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/install' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-1' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, { ok: true, busy: false, tasks: [{ id: 'op-1', kind: 'install', name: 'alpha', preImage: null, status: 'ok' }], deferred: [] })
      return
    }
    if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
      fixtureJson(res, 202, { accepted: true })
      return
    }
    fixtureJson(res, 200, { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'ready', restart: 'failed', operationError: 'canStartLocal gate closed' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha'], remove: [] }, {
   settleIntervalMs: 5,
   restartPollIntervalMs: 5,
   restartPollTimeoutMs: 1_000,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /restart failed: canStartLocal gate closed/)
      assert.equal(result.outcome?.restarted, false)
    }
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: deferred installs are reported as deferredOps and never restart', async () => {
  const seen: string[] = []
  const server = await startSyncHttpServer((req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`)
    fixtureJson(res, 202, { accepted: true, deferred: true, intentId: 'int-7' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(server.port, { add: ['alpha'], remove: [] }, { requestTimeoutMs: 2_000 }))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.deepEqual(result.outcome, { installed: [], removed: [], restarted: false, deferredOps: ['alpha'] })
    }
    assert.deepEqual(seen, ['PUT /chamber/plugins/install'])
  } finally {
    await server.close()
  }
})

test('gatewayChamberApplyBatch: an empty batch and client-side invalid specs fail before any HTTP request', async () => {
  const empty = await gatewayChamberApplyBatch({
    id: 'gw-1', url: 'http://127.0.0.1:1', headers: {}, spkiPin: null,
    options: { add: [], remove: [] },
  })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.error, /nothing to apply/)
  const badSpec = await gatewayChamberApplyBatch({
    id: 'gw-1', url: 'http://127.0.0.1:1', headers: {}, spkiPin: null,
    options: { add: ['file:/tmp/x.tgz'], remove: [] },
  })
  assert.equal(badSpec.ok, false)
  if (!badSpec.ok) assert.match(badSpec.error, /invalid add spec/)
  const badRemove = await gatewayChamberApplyBatch({
    id: 'gw-1', url: 'http://127.0.0.1:1', headers: {}, spkiPin: null,
    options: { add: [], remove: ['@dsh-chamber/taken'] },
  })
  assert.equal(badRemove.ok, false)
})

test('gatewayChamberApplyBatch: settle timeout and restart-poll timeout stay loud, partial failures', async () => {
  const settleServer = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/install' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-1' })
      return
    }
    fixtureJson(res, 200, { ok: true, busy: true, tasks: [{ id: 'op-1', kind: 'install', name: 'alpha', preImage: null, status: 'pending' }], deferred: [] })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(settleServer.port, { add: ['alpha'], remove: [] }, {
   settleIntervalMs: 5,
   settleTimeoutMs: 60,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.match(result.error, /has not finished applying the plugin ops/)
      assert.deepEqual(result.outcome, { installed: ['alpha'], removed: [], restarted: false, deferredOps: [] })
    }
  } finally {
    await settleServer.close()
  }

  const restartServer = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/install' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-1' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, { ok: true, busy: false, tasks: [{ id: 'op-1', kind: 'install', name: 'alpha', preImage: null, status: 'ok' }], deferred: [] })
      return
    }
    if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
      fixtureJson(res, 202, { accepted: true })
      return
    }
    fixtureJson(res, 200, { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'restarting', restart: 'running' })
  })
  try {
    const result = await gatewayChamberApplyBatch(batchTarget(restartServer.port, { add: ['alpha'], remove: [] }, {
   settleIntervalMs: 5,
   restartPollIntervalMs: 5,
   restartPollTimeoutMs: 60,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /restart accepted but the gateway did not reach ready in time/)
  } finally {
    await restartServer.close()
  }
})

test('gatewayChamberMaterialize: uploads the tarball with the exact headers, waits for the executor op and restarts the managed dsh (202 settle parity)', async () => {
  const seen: Array<{ method: string; url: string; headers: import('node:http').IncomingHttpHeaders; body: Buffer }> = []
  let statusCalls = 0
  const server = await startSyncHttpServer((req, res) => {
    res.setHeader('connection', 'close')
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      if (req.url === '/chamber/plugins/materialize' && req.method === 'PUT') {
        fixtureJson(res, 202, { accepted: true, opId: 'op-mat-1' })
        return
      }
      if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
        fixtureJson(res, 200, {
          ok: true,
          busy: false,
          tasks: [{ id: 'op-mat-1', kind: 'materialize', name: 'custom-pkg', preImage: null, status: 'ok' }],
          deferred: [],
        })
        return
      }
      if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
        fixtureJson(res, 202, { accepted: true })
        return
      }
      if (req.url === '/chamber/runtime/status' && req.method === 'GET') {
        statusCalls += 1
        fixtureJson(res, 200, statusCalls === 1
          ? { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'restarting', restart: 'running' }
          : { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'ready', restart: 'ok' })
        return
      }
      fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
    })
  })
  try {
    const result = await gatewayChamberMaterialize(materializeTarget(server.port, FIXTURE_TARBALL, 'custom-pkg', '1.2.3', {
   headers: { authorization: 'Bearer test-token' },
   settleIntervalMs: 5,
   restartPollIntervalMs: 5,
   requestTimeoutMs: 2_000,
 }))
    assert.deepEqual(result, { ok: true, outcome: { executed: true, restarted: true } })
    assert.deepEqual(seen.map(entry => `${entry.method} ${entry.url}`), [
      'PUT /chamber/plugins/materialize',
      // The desktop does NOT stop at the 202: it waits for the executor op
      // to settle, then asks for the controlled restart and polls it —
      // exactly the apply-batch discipline (the plugin mounts only on the
      // next spawn, so the restart is part of the install flow).
      'GET /chamber/plugins/tasks',
      'POST /chamber/runtime/restart',
      'GET /chamber/runtime/status',
      'GET /chamber/runtime/status',
    ])
    const upload = seen[0]!
    assert.equal(upload.method, 'PUT')
    assert.equal(upload.url, '/chamber/plugins/materialize')
    assert.equal(upload.headers['x-plugin-name'], 'custom-pkg')
    assert.equal(upload.headers['x-plugin-version'], '1.2.3')
    assert.equal(upload.headers['content-length'], String(FIXTURE_TARBALL.length))
    assert.equal(upload.headers.authorization, 'Bearer test-token')
    assert.ok(upload.body.equals(FIXTURE_TARBALL))
    for (const entry of seen) assert.equal(entry.headers.authorization, 'Bearer test-token')
  } finally {
    await server.close()
  }
})

test('gatewayChamberMaterialize: a deferred answer maps to {ok:true,deferred:true}; refusals map their code', async () => {
  const deferredServer = await startSyncHttpServer((_req, res) => {
    fixtureJson(res, 202, { accepted: true, deferred: true, intentId: 'int-mat' })
  })
  try {
    const deferred = await gatewayChamberMaterialize(materializeTarget(deferredServer.port, FIXTURE_TARBALL, 'custom-pkg', '1.2.3'))
    assert.deepEqual(deferred, { ok: true, deferred: true })
  } finally {
    await deferredServer.close()
  }

  const refusalServer = await startSyncHttpServer((_req, res) => {
    fixtureJson(res, 413, { error: 'archive too large', code: 'too_large' })
  })
  try {
    const refused = await gatewayChamberMaterialize(materializeTarget(refusalServer.port, FIXTURE_TARBALL, 'custom-pkg', '1.2.3'))
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.match(refused.error, /materialize of custom-pkg@1\.2\.3 refused \(HTTP 413, code too_large\)/)
      assert.match(refused.error, /archive too large/)
    }
  } finally {
    await refusalServer.close()
  }
})

test('gatewayChamberMaterialize: a failed executor op and a refused restart are loud, with the executed fact carried', async () => {
  // Op failure: the executor reports the terminal op as failed.
  const failedOpServer = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/materialize' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-mat-fail' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, {
        ok: true,
        busy: false,
        tasks: [{ id: 'op-mat-fail', kind: 'materialize', name: 'custom-pkg', preImage: null, status: 'failed', error: 'pnpm install failed on the gateway' }],
        deferred: [],
      })
      return
    }
    fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
  })
  try {
    const failed = await gatewayChamberMaterialize(materializeTarget(failedOpServer.port, FIXTURE_TARBALL, 'custom-pkg', '1.2.3', {
   settleIntervalMs: 5,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(failed.ok, false)
    if (!failed.ok) {
      assert.equal(failed.outcome, undefined, 'a failed op executed nothing')
      assert.match(failed.error, /materialize of custom-pkg failed on the gateway: pnpm install failed on the gateway/)
    }
  } finally {
    await failedOpServer.close()
  }

  // Restart refused AFTER the op settled: loud partial with the executed fact.
  const restartRefusalServer = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/materialize' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-mat-ok' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, {
        ok: true,
        busy: false,
        tasks: [{ id: 'op-mat-ok', kind: 'materialize', name: 'custom-pkg', preImage: null, status: 'ok' }],
        deferred: [],
      })
      return
    }
    if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
      fixtureJson(res, 409, { error: 'a mutation is still running', code: 'busy' })
      return
    }
    fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
  })
  try {
    const refused = await gatewayChamberMaterialize(materializeTarget(restartRefusalServer.port, FIXTURE_TARBALL, 'custom-pkg', '1.2.3', {
   settleIntervalMs: 5,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(refused.ok, false)
    if (!refused.ok) {
      assert.deepEqual(refused.outcome, { executed: true, restarted: false }, 'the install executed before the restart refusal')
      assert.match(refused.error, /restart of the managed dsh refused after the plugin was installed \(HTTP 409, code busy\)/)
    }
  } finally {
    await restartRefusalServer.close()
  }
})

test('gatewayChamberMaterialize: an unsettled executor op and an unsettled restart are loud timeouts', async () => {
  // The op never reaches a terminal journal state within the poll budget.
  const pendingServer = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/materialize' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-mat-slow' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, {
        ok: true,
        busy: true,
        tasks: [{ id: 'op-mat-slow', kind: 'materialize', name: 'custom-pkg', preImage: null, status: 'pending' }],
        deferred: [],
      })
      return
    }
    fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
  })
  try {
    const pending = await gatewayChamberMaterialize(materializeTarget(pendingServer.port, FIXTURE_TARBALL, 'custom-pkg', '1.2.3', {
   settleIntervalMs: 5,
   settleTimeoutMs: 60,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(pending.ok, false)
    if (!pending.ok) assert.match(pending.error, /has not finished applying the plugin ops/)
  } finally {
    await pendingServer.close()
  }

  // The restart 202 was accepted but readiness never settles.
  const restartTimeoutServer = await startSyncHttpServer((req, res) => {
    if (req.url === '/chamber/plugins/materialize' && req.method === 'PUT') {
      fixtureJson(res, 202, { accepted: true, opId: 'op-mat-r' })
      return
    }
    if (req.url === '/chamber/plugins/tasks' && req.method === 'GET') {
      fixtureJson(res, 200, {
        ok: true,
        busy: false,
        tasks: [{ id: 'op-mat-r', kind: 'materialize', name: 'custom-pkg', preImage: null, status: 'ok' }],
        deferred: [],
      })
      return
    }
    if (req.url === '/chamber/runtime/restart' && req.method === 'POST') {
      fixtureJson(res, 202, { accepted: true })
      return
    }
    if (req.url === '/chamber/runtime/status' && req.method === 'GET') {
      fixtureJson(res, 200, { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'restarting', restart: 'running' })
      return
    }
    fixtureJson(res, 404, { error: 'not_found', code: 'not_found' })
  })
  try {
    const timedOut = await gatewayChamberMaterialize(materializeTarget(restartTimeoutServer.port, FIXTURE_TARBALL, 'custom-pkg', '1.2.3', {
   settleIntervalMs: 5,
   restartPollIntervalMs: 5,
   restartPollTimeoutMs: 60,
   requestTimeoutMs: 2_000,
 }))
    assert.equal(timedOut.ok, false)
    if (!timedOut.ok) {
      assert.deepEqual(timedOut.outcome, { executed: true, restarted: false })
      assert.match(timedOut.error, /restart accepted but the gateway did not reach ready in time/)
    }
  } finally {
    await restartTimeoutServer.close()
  }
})

test('gatewayChamberMaterialize: client-side header validation and the archive cap fail before any request', async () => {
  let received = 0
  const server = await startSyncHttpServer((_req, res) => {
    received += 1
    fixtureJson(res, 202, { accepted: true })
  })
  try {
    const badVersion = await gatewayChamberMaterialize(materializeTarget(server.port, FIXTURE_TARBALL, 'custom-pkg', 'v1.2.3'))
    assert.equal(badVersion.ok, false)
    // A well-formed OFFICIAL-SCOPE name is a shape pass (design 21 §6.11.5):
    // the gateway's submit path owns the protected-set judgement, so the upload
    // is allowed to leave the client.
    const before = received
    const officialName = await gatewayChamberMaterialize(materializeTarget(server.port, FIXTURE_TARBALL, '@dsh-chamber/taken', '1.2.3'))
    assert.equal(received, before + 1, 'a well-formed official-scope name is not refused client-side')
    // The fixture answers 202 without an opId, so the provider reports that
    // honestly — the point here is only that no CLIENT-SIDE refusal happened.
    if (!officialName.ok) assert.match(officialName.error, /no opId/)
    // Reset the counter: the tail of this test asserts that every INVALID
    // submission is refused before any request is made.
    received = 0
    const badName = await gatewayChamberMaterialize(materializeTarget(server.port, FIXTURE_TARBALL, 'bad name!', '1.2.3'))
    assert.equal(badName.ok, false)
    const empty = await gatewayChamberMaterialize(materializeTarget(server.port, Buffer.alloc(0), 'custom-pkg', '1.2.3'))
    assert.equal(empty.ok, false)
    const oversized = await gatewayChamberMaterialize(materializeTarget(server.port, Buffer.alloc(32 * 1024 * 1024 + 1), 'custom-pkg', '1.2.3'))
    assert.equal(oversized.ok, false)
    if (!oversized.ok) assert.match(oversized.error, /32,?MiB|upload cap|beyond the/)
    assert.equal(received, 0, 'invalid materialize submissions never reach the gateway')
  } finally {
    await server.close()
  }
})

test('gatewayChamberMaterialize: an SPKI-pinned https gateway receives zero bytes on a wrong-key peer', async () => {
  let receivedRequests = 0
  const server = await startHttpsProbeServer(KEY_A, CERT_A, (_req, res) => {
    receivedRequests += 1
    fixtureJson(res, 202, { accepted: true })
  })
  try {
    const result = await gatewayChamberMaterialize({
      id: 'gw-1',
      url: `https://127.0.0.1:${server.port}`,
      headers: { authorization: 'Bearer test-token' },
      spkiPin: PIN_B,
      tarball: FIXTURE_TARBALL,
      name: 'custom-pkg',
      version: '1.2.3',
    })
    assert.equal(result.ok, false, 'a wrong-key peer must never receive the tarball')
    assert.equal(receivedRequests, 0, 'zero application bytes reach a wrong-key peer')
  } finally {
    await server.close()
  }
})
