/**
 * Route-level A1 write-surface tests (design 21 §6.2; plan Phase 4.4):
 * PUT /chamber/plugins/install, PUT /chamber/plugins/materialize (streamed
 * reader + tgz scan + staging + submit), POST /chamber/plugins/remove,
 * GET /chamber/plugins/tasks — 202/400/409/411/413/405 mapping, deferred
 * variants, and one end-to-end run over the REAL orchestrator (fake spawn +
 * fake runtime manager).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createChamberPlugins } from '../src/plugins.ts'
import { createChamberInstalled } from '../src/plugins-installed.ts'
import { createChamberSurface } from '../src/routes.ts'
import type { ChamberSurfacePluginTasks } from '../src/routes.ts'
import { thirdPartyRoot } from '../src/plugins-journal.ts'
import { createChamberPluginTasks } from '../src/plugins-tasks.ts'
import type { PluginTaskSubmitInput, PluginTaskSubmitResult, PluginTaskTasksProjection, DeferredIntent } from '../src/plugins-tasks.ts'
import type { JournalOp } from '../src/plugins-journal.ts'
import { FakeRequest, FakeResponse } from './utils.ts'
import { buildTgz, buildPluginTgz, type TarEntrySpec } from './tgz-fixtures.ts'
import { writeManifestFixture, scratchDir, makeSpawnHarness } from './plugins-tasks-fixtures.ts'

const silent = { log() {}, warn() {}, error() {} }
const channels = {
  register() {},
  async start() {},
  async stop() {},
  resolve: () => null,
  health: () => 'unknown' as const,
  list: () => [],
}

/** Surface with a programmable fake tasks orchestrator + real installed. */
function surfaceWithTasks(stateDir: string, tasks: ChamberSurfacePluginTasks): ReturnType<typeof createChamberSurface> {
  return createChamberSurface({
    logger: silent,
    channels,
    plugins: createChamberPlugins(stateDir, silent),
    installed: createChamberInstalled(stateDir),
    tasks,
    stateDir,
  })
}

/** Track submissions and answer from a queue of canned results. */
function recordingTasks(results: Array<Record<string, unknown>>): {
  tasks: ChamberSurfacePluginTasks
  calls: Array<PluginTaskSubmitInput>
} {
  const calls: Array<PluginTaskSubmitInput> = []
  const tasks: ChamberSurfacePluginTasks = {
    submit: async (input: PluginTaskSubmitInput): Promise<PluginTaskSubmitResult> => {
      calls.push(input)
      return (results.shift() ?? { ok: false, code: 'queue_busy', error: 'no canned result' }) as PluginTaskSubmitResult
    },
    tasks: (): PluginTaskTasksProjection => ({ tasks: [], deferred: [], busy: false }),
  }
  return { tasks, calls }
}

async function jsonRequest(
  host: ReturnType<typeof createChamberSurface>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string | string[] | undefined> = {},
): Promise<{ res: FakeResponse; req: FakeRequest }> {
  const req = new FakeRequest(method, path, headers)
  const res = new FakeResponse()
  const pending = host.handle(req as unknown as ApiRequest, res as unknown as ApiResponse, path)
  if (body !== undefined) {
    const bytes = Buffer.from(JSON.stringify(body))
    req.emit('data', bytes)
    req.emit('end')
  }
  await pending
  return { res, req }
}

async function rawUpload(
  host: ReturnType<typeof createChamberSurface>,
  bytes: Buffer,
  extraHeaders: Record<string, string> = {},
): Promise<{ res: FakeResponse; req: FakeRequest }> {
  const req = new FakeRequest('PUT', '/chamber/plugins/materialize', {
    'content-length': String(bytes.length),
    'x-plugin-name': 'upload-pkg',
    'x-plugin-version': '1.2.3',
    ...extraHeaders,
  })
  const res = new FakeResponse()
  const pending = host.handle(req as unknown as ApiRequest, res as unknown as ApiResponse, '/chamber/plugins/materialize')
  if (bytes.length > 0) req.emit('data', bytes)
  req.emit('end')
  await pending
  return { res, req }
}

function stagedTgz(stateDir: string, slug = 'upload-pkg'): string | null {
  const dir = join(thirdPartyRoot(stateDir), slug)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter(name => name.endsWith('.tgz'))
  return files.length === 0 ? null : join(dir, files[0]!)
}

// ---------------------------------------------------------------------------
// PUT /chamber/plugins/install
// ---------------------------------------------------------------------------

test('install: accepted → 202 {accepted:true, opId}; submission carries name/spec/initiator', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const canned = recordingTasks([{ ok: true, opId: 'op-1', deferred: false }])
  const host = surfaceWithTasks(stateDir, canned.tasks)
  const { res } = await jsonRequest(host, 'PUT', '/chamber/plugins/install', { name: 'alpha', spec: 'alpha@^1.0.0' }, {
    host: 'gw.example:8443',
  })
  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), { accepted: true, opId: 'op-1' })
  assert.equal(canned.calls.length, 1)
  assert.deepEqual(canned.calls[0], { kind: 'install', name: 'alpha', spec: 'alpha@^1.0.0', initiator: 'gw.example:8443' })
})

test('install: deferred submission → 202 {accepted:true, deferred:true, intentId}', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const canned = recordingTasks([{ ok: true, deferred: true, intentId: 'int-9' }])
  const host = surfaceWithTasks(stateDir, canned.tasks)
  const { res } = await jsonRequest(host, 'PUT', '/chamber/plugins/install', { name: 'beta', spec: 'beta@1' })
  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), { accepted: true, deferred: true, intentId: 'int-9' })
})

test('install: invalid/reserved refusals → 400 with the submit code; busy family → 409', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const cases = [
    [{ ok: false, code: 'invalid_name', error: 'invalid plugin name' }, 400],
    [{ ok: false, code: 'invalid_spec', error: 'invalid registry spec' }, 400],
    [{ ok: false, code: 'reserved', error: 'reserved' }, 400],
    [{ ok: false, code: 'queue_busy', error: 'duplicate operation pending' }, 409],
    [{ ok: false, code: 'queue_full', error: 'full' }, 409],
    [{ ok: false, code: 'runtime_busy', error: 'busy' }, 409],
    [{ ok: false, code: 'runtime_pending', error: 'pending' }, 409],
    [{ ok: false, code: 'runtime_recovery_required', error: 'recovery' }, 409],
  ] as const
  for (const [result, status] of cases) {
    const canned = recordingTasks([{ ...result }])
    const host = surfaceWithTasks(stateDir, canned.tasks)
    const { res } = await jsonRequest(host, 'PUT', '/chamber/plugins/install', { name: 'pkg', spec: 'pkg@1' })
    assert.equal(res.status, status, JSON.stringify(result))
    assert.equal(res.json().code, result.code, JSON.stringify(result))
  }
})

test('install: non-JSON body → 400 bad_request; wrong method → 405', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const canned = recordingTasks([])
  const host = surfaceWithTasks(stateDir, canned.tasks)
  const req = new FakeRequest('PUT', '/chamber/plugins/install')
  const res = new FakeResponse()
  const pending = host.handle(req as unknown as ApiRequest, res as unknown as ApiResponse, '/chamber/plugins/install')
  req.emit('data', Buffer.from('{ nope'))
  req.emit('end')
  await pending
  assert.equal(res.status, 400)
  assert.equal(res.json().code, 'bad_request')
  assert.equal(canned.calls.length, 0, 'no submit for an unparsable body')

  const method = await jsonRequest(host, 'GET', '/chamber/plugins/install')
  assert.equal(method.res.status, 405)
  assert.equal(method.res.json().code, 'method_not_allowed')
})

// ---------------------------------------------------------------------------
// POST /chamber/plugins/remove
// ---------------------------------------------------------------------------

test('remove: accepted → 202; not_installed/no_manifest refusals → 409; reserved → 400', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const accepted = recordingTasks([{ ok: true, opId: 'op-rm', deferred: false }])
  const ok = await jsonRequest(surfaceWithTasks(stateDir, accepted.tasks), 'POST', '/chamber/plugins/remove', { name: 'alpha' })
  assert.equal(ok.res.status, 202)
  assert.equal(ok.res.json().opId, 'op-rm')
  assert.equal(accepted.calls.length, 1)
  assert.deepEqual(accepted.calls[0], { kind: 'remove', name: 'alpha', initiator: 'chamber' })

  const notInstalled = recordingTasks([{ ok: false, code: 'not_installed', error: 'plugin is not installed on the managed profile' }])
  const ni = await jsonRequest(surfaceWithTasks(stateDir, notInstalled.tasks), 'POST', '/chamber/plugins/remove', { name: 'ghost' })
  assert.equal(ni.res.status, 409)
  assert.equal(ni.res.json().code, 'not_installed')

  const noManifest = recordingTasks([{ ok: false, code: 'no_manifest', error: 'managed profile is not initialized' }])
  const nm = await jsonRequest(surfaceWithTasks(stateDir, noManifest.tasks), 'POST', '/chamber/plugins/remove', { name: 'ghost' })
  assert.equal(nm.res.status, 409)
  assert.equal(nm.res.json().code, 'no_manifest')

  const reserved = recordingTasks([{ ok: false, code: 'reserved', error: 'reserved' }])
  const rv = await jsonRequest(surfaceWithTasks(stateDir, reserved.tasks), 'POST', '/chamber/plugins/remove', { name: '@deepseek-ai/x' })
  assert.equal(rv.res.status, 400)
  assert.equal(rv.res.json().code, 'reserved')
})

test('remove: wrong method → 405', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const host = surfaceWithTasks(stateDir, recordingTasks([]).tasks)
  const { res } = await jsonRequest(host, 'PUT', '/chamber/plugins/remove', { name: 'alpha' })
  assert.equal(res.status, 405)
})

// ---------------------------------------------------------------------------
// GET /chamber/plugins/tasks
// ---------------------------------------------------------------------------

test('tasks: projection shape + no gating; wrong method → 405', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const op: JournalOp = { id: 'op-1', ts: 1, kind: 'install', name: 'alpha', preImage: null, status: 'pending' }
  const intent: DeferredIntent = { id: 'int-1', ts: 2, kind: 'materialize', name: 'beta' }
  const tasks: ChamberSurfacePluginTasks = {
    submit: async () => ({ ok: false, code: 'queue_busy', error: 'unused' }),
    tasks: () => ({ tasks: [op], deferred: [intent], busy: true }),
  }
  const host = surfaceWithTasks(stateDir, tasks)
  const { res } = await jsonRequest(host, 'GET', '/chamber/plugins/tasks')
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true, tasks: [op], deferred: [intent], busy: true })

  const slash = await jsonRequest(host, 'GET', '/chamber/plugins/tasks/')
  assert.equal(slash.res.status, 200)
  const method = await jsonRequest(host, 'POST', '/chamber/plugins/tasks')
  assert.equal(method.res.status, 405)
})

// ---------------------------------------------------------------------------
// PUT /chamber/plugins/materialize
// ---------------------------------------------------------------------------

test('materialize: content-length required → 411; declared oversize → 413 + destroy', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const canned = recordingTasks([])
  const host = surfaceWithTasks(stateDir, canned.tasks)

  const noLength = new FakeRequest('PUT', '/chamber/plugins/materialize', { 'x-plugin-name': 'a', 'x-plugin-version': '1.0.0' })
  const noLengthRes = new FakeResponse()
  await host.handle(noLength as unknown as ApiRequest, noLengthRes as unknown as ApiResponse, '/chamber/plugins/materialize')
  assert.equal(noLengthRes.status, 411)
  assert.equal(noLengthRes.json().code, 'length_required')

  const oversizeDeclared = new FakeRequest('PUT', '/chamber/plugins/materialize', {
    'content-length': String(32 * 1024 * 1024 + 1),
  })
  const oversizeRes = new FakeResponse()
  await host.handle(oversizeDeclared as unknown as ApiRequest, oversizeRes as unknown as ApiResponse, '/chamber/plugins/materialize')
  assert.equal(oversizeRes.status, 413)
  assert.equal(oversizeRes.json().code, 'too_large')
  assert.equal(oversizeDeclared.destroyed, true)
})

test('materialize: actual body beyond 32 MiB → 413 too_large + destroy (never scanned/staged)', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const canned = recordingTasks([])
  const host = surfaceWithTasks(stateDir, canned.tasks)
  const req = new FakeRequest('PUT', '/chamber/plugins/materialize', {
    'content-length': String(32 * 1024 * 1024 + 10),
    'x-plugin-name': 'upload-pkg',
    'x-plugin-version': '1.2.3',
  })
  const res = new FakeResponse()
  const pending = host.handle(req as unknown as ApiRequest, res as unknown as ApiResponse, '/chamber/plugins/materialize')
  req.emit('data', Buffer.alloc(32 * 1024 * 1024 + 10))
  req.emit('end')
  await pending
  assert.equal(res.status, 413)
  assert.equal(res.json().code, 'too_large')
  assert.equal(req.destroyed, true)
  assert.equal(canned.calls.length, 0)
  assert.equal(stagedTgz(stateDir), null)
})

test('materialize: invalid archives → 400 tgz_invalid / cap codes; nothing staged', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const canned = recordingTasks([])
  const host = surfaceWithTasks(stateDir, canned.tasks)

  const garbage = await rawUpload(host, Buffer.from('definitely not a gzip stream'))
  assert.equal(garbage.res.status, 400)
  assert.equal(garbage.res.json().code, 'tgz_invalid')

  const notTar = await rawUpload(host, gzipSync(Buffer.from('gzip of garbage, no tar inside')))
  assert.equal(notTar.res.status, 400)
  assert.equal(notTar.res.json().code, 'tgz_invalid')

  const tooManyEntries: TarEntrySpec[] = Array.from({ length: 4097 }, (_unused, index) => ({ name: `f-${index}.js`, data: '' }))
  const many = await rawUpload(host, buildTgz(tooManyEntries, { padDeclared: false }))
  assert.equal(many.res.status, 400)
  assert.equal(many.res.json().code, 'too_many_entries')
  assert.equal(stagedTgz(stateDir), null, 'no archive staged after a refused scan')
  assert.equal(canned.calls.length, 0)
})

test('materialize: header validation (name pattern/denied/version) → 400 before staging', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const host = surfaceWithTasks(stateDir, recordingTasks([]).tasks)
  const bytes = buildPluginTgz()

  const badName = await rawUpload(host, bytes, { 'x-plugin-name': 'bad name!' })
  assert.equal(badName.res.status, 400)
  assert.equal(badName.res.json().code, 'invalid_input')

  const versionedName = await rawUpload(host, bytes, { 'x-plugin-name': 'pkg@1.0.0' })
  assert.equal(versionedName.res.status, 400)

  const denied = await rawUpload(host, bytes, { 'x-plugin-name': '@dsh-chamber/dsh-host-client-graph' })
  assert.equal(denied.res.status, 400)
  assert.equal(denied.res.json().code, 'reserved')

  const badVersion = await rawUpload(host, bytes, { 'x-plugin-version': 'v1.2' })
  assert.equal(badVersion.res.status, 400)
  assert.equal(badVersion.res.json().code, 'invalid_input')
})

test('materialize: valid upload → staged 0600 archive under third-party/<slug>/ and submit file: spec → 202', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  writeManifestFixture(stateDir, {})
  const canned = recordingTasks([{ ok: true, opId: 'op-mat', deferred: false }])
  const host = surfaceWithTasks(stateDir, canned.tasks)
  const bytes = buildPluginTgz()
  const { res } = await rawUpload(host, bytes)
  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), { accepted: true, opId: 'op-mat' })

  assert.equal(canned.calls.length, 1)
  const staged = stagedTgz(stateDir)
  assert.ok(staged !== null, 'archive staged')
  if (staged !== null) {
    assert.match(staged, /upload-pkg-1\.2\.3-[0-9a-f]{8}\.tgz$/)
    assert.equal(readFileSync(staged).equals(bytes), true, 'staged bytes are the uploaded archive')
    if (process.platform !== 'win32') assert.equal(statSync(staged).mode & 0o777, 0o600)
  }
  const call = canned.calls[0]!
  assert.equal(call.kind, 'materialize')
  assert.equal(call.name, 'upload-pkg')
  assert.equal(call.spec, `file:${staged}`)
})

test('materialize: scoped names flatten to a safe slug (no traversal)', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  writeManifestFixture(stateDir, {})
  const canned = recordingTasks([{ ok: true, opId: 'op-scope', deferred: false }])
  const host = surfaceWithTasks(stateDir, canned.tasks)
  const bytes = buildPluginTgz()
  const { res } = await rawUpload(host, bytes, { 'x-plugin-name': '@scope/upload-pkg' })
  assert.equal(res.status, 202)
  const staged = stagedTgz(stateDir, 'scope-upload-pkg')
  assert.ok(staged !== null)
  if (staged !== null) assert.equal(canned.calls[0]!.spec, `file:${staged}`)
})

test('materialize: deferred submission still stages the archive and answers 202 deferred', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  writeManifestFixture(stateDir, {})
  const canned = recordingTasks([{ ok: true, deferred: true, intentId: 'int-mat' }])
  const host = surfaceWithTasks(stateDir, canned.tasks)
  const { res } = await rawUpload(host, buildPluginTgz())
  assert.equal(res.status, 202)
  assert.deepEqual(res.json(), { accepted: true, deferred: true, intentId: 'int-mat' })
  assert.ok(stagedTgz(stateDir) !== null, 'the archive survives for the later drain (spec points at it)')
})

test('materialize: wrong method → 405', async t => {
  const stateDir = scratchDir(t, 'gateway-mutations-')
  const host = surfaceWithTasks(stateDir, recordingTasks([]).tasks)
  const { res } = await jsonRequest(host, 'GET', '/chamber/plugins/materialize')
  assert.equal(res.status, 405)
})

// ---------------------------------------------------------------------------
// End-to-end: real orchestrator under the routes (fake spawn + fake manager)
// ---------------------------------------------------------------------------

test('end-to-end: install through the real orchestrator → 202, journal op runs to ok; remove of unknown → 409', async t => {
  const stateDir = scratchDir(t, 'gateway-e2e-')
  writeManifestFixture(stateDir, {})
  const workspace = scratchDir(t, 'gateway-e2e-ws-')
  mkdirSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  let leasesHeld = 0
  let released = 0
  const manager = {
    workspace,
    beginProfileWrite() {
      leasesHeld += 1
      return { ok: true as const, release: () => { leasesHeld -= 1; released += 1 } }
    },
    profileWriteInFlight: () => leasesHeld > 0,
    mutationInFlight: () => false,
    resolveWorkspace: () => ({ path: workspace, version: null as string | null, source: 'builtin' as const }),
  }
  const spawn = makeSpawnHarness()
  const orchestrator = createChamberPluginTasks({
    stateDir,
    manager: () => manager,
    statusProbe: () => 'ready',
    logger: silent,
    installed: createChamberInstalled(stateDir),
    spawn: spawn.spawn,
    timeoutMs: 1000,
  })
  const host = createChamberSurface({
    logger: silent,
    channels,
    plugins: createChamberPlugins(stateDir, silent),
    installed: createChamberInstalled(stateDir),
    tasks: orchestrator,
    stateDir,
  })

  // Install accepted asynchronously; the mutation settles in the journal.
  const install = await jsonRequest(host, 'PUT', '/chamber/plugins/install', { name: 'e2e-pkg', spec: 'e2e-pkg@1' })
  assert.equal(install.res.status, 202)
  assert.equal(typeof install.res.json().opId, 'string')
  const opId = install.res.json().opId
  assert.equal(leasesHeld, 1, 'the route-held lease covers the whole mutation')
  assert.equal(spawn.calls.length, 1)
  assert.deepEqual(
    spawn.calls[0]!.args.slice(1),
    ['plugin', '--profile', 'web', 'add', 'e2e-pkg@1'],
  )
  spawn.calls[0]!.child.close(0)
  await (async (): Promise<void> => {
    const deadline = Date.now() + 4000
    while (true) {
      const projection = orchestrator.tasks()
      if (projection.tasks.some(op => op.id === opId && op.status === 'ok')) return
      if (Date.now() > deadline) throw new Error('op never settled ok')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  })()
  assert.equal(leasesHeld, 0)
  assert.equal(released, 1)

  // Remove of a name that is not installed → 409 not_installed (route maps
  // the orchestrator refusal).
  const ghost = await jsonRequest(host, 'POST', '/chamber/plugins/remove', { name: 'ghost' })
  assert.equal(ghost.res.status, 409)
  assert.equal(ghost.res.json().code, 'not_installed')

  // The tasks projection is live over the real journal.
  const tasks = await jsonRequest(host, 'GET', '/chamber/plugins/tasks')
  assert.equal(tasks.res.status, 200)
  assert.equal(tasks.res.json().ok, true)
  assert.equal(tasks.res.json().tasks[0].name, 'e2e-pkg')
  assert.equal(tasks.res.json().tasks[0].status, 'ok')

  // The surface never calls reconcile/drain/dispose — index.ts owns those.
  await orchestrator.dispose()
})
