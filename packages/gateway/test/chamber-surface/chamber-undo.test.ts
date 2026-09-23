/**
 * Gateway undo = RESTORE tests (design 21 §3 undoJournal / §6.3 write order /
 * §6.8 r2). The route + the REAL orchestrator/executor run against a fake
 * spawn and a fake runtime manager; the profile files are rewritten by the
 * test exactly like the dsh CLI would.
 *
 * Load-bearing assertions:
 *   - an install followed by `POST /chamber/plugins/undo` restores the
 *     pre-mutation package.json AND pnpm-lock.yaml byte-for-byte (and the
 *     inverse: a preImage without a lockfile removes the current one);
 *   - an executed REMOVE is undone by re-adding its declaration — the ssh
 *     「撤销=恢复」 semantics, never a remove-only shortcut;
 *   - the protected-set judgement re-runs on the INVERSE direction at restore
 *     time (a protected name's install cannot be undone by a silent remove);
 *   - nothing to undo → 409 no_undoable_op; corrupt journal → 503
 *     journal_unavailable; a writer in flight → 409 runtime_busy;
 *   - the undo op itself is journaled (kind undo, undoOf target, own preImage)
 *     and both backup directories stay referenced.
 *
 * Run directly: node packages/gateway/test/chamber-surface/chamber-undo.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiRequest, ApiResponse } from '@dsh-chamber/control-plane'
import { createChamberPlugins } from '../../src/plugins.ts'
import { createChamberInstalled, INSTALLED_PROFILE_DIR, MANAGED_DSH_HOME_DIR } from '../../src/plugins-installed.ts'
import { createChamberSurface } from '../../src/routes.ts'
import { backupDirFor, journalFilePath, thirdPartyRoot } from '../../src/plugins-journal.ts'
import { createChamberPluginTasks } from '../../src/plugins-tasks.ts'
import { FakeRequest, FakeResponse } from '../support/utils.ts'
import { surfaceSilentLogger, surfaceStubChannels } from '../support/chamber-surface-harness.ts'
import { makeSpawnHarness, scratchDir, waitFor, writeManifestFixture } from '../support/plugins-tasks-fixtures.ts'

const silent = surfaceSilentLogger

const MANIFEST_V0 = JSON.stringify({ name: 'web', version: '0.0.0', dependencies: { 'base-pkg': '^1.0.0' } }, undefined, 2)
const LOCK_V0 = "lockfileVersion: '9.0'\n\nimporters:\n  .: {}\n"
const MANIFEST_V1 = JSON.stringify({ name: 'web', version: '0.0.0', dependencies: { 'base-pkg': '^1.0.0', 'new-pkg': '1.0.0' } }, undefined, 2)
const LOCK_V1 = "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    new-pkg: 1.0.0\n"

function profileDir(stateDir: string): string {
  return join(stateDir, MANAGED_DSH_HOME_DIR, INSTALLED_PROFILE_DIR)
}

function writePair(stateDir: string, manifest: string, lock: string | null): void {
  mkdirSync(profileDir(stateDir), { recursive: true })
  writeFileSync(join(profileDir(stateDir), 'package.json'), manifest, 'utf8')
  if (lock !== null) writeFileSync(join(profileDir(stateDir), 'pnpm-lock.yaml'), lock, 'utf8')
}

interface Harness {
  stateDir: string
  workspace: string
  host: ReturnType<typeof createChamberSurface>
  orchestrator: ReturnType<typeof createChamberPluginTasks>
  spawn: ReturnType<typeof makeSpawnHarness>
  leasesHeld: () => number
  /** The exact on-disk profile pair at harness setup (the byte-for-byte
   *  restore target). */
  before: { manifest: string; lock: string | null }
}

async function makeHarness(
  t: { after(fn: () => void): void },
  options: { manifest?: string; lock?: string | null; journalOps?: unknown[] } = {},
): Promise<Harness> {
  const stateDir = scratchDir(t, 'gateway-undo-')
  writeManifestFixture(stateDir, JSON.parse(options.manifest ?? MANIFEST_V0).dependencies)
  if (options.lock !== undefined) {
    if (options.lock === null) {
      // The fixture writes package.json only; an explicit null means "no lock".
    } else {
      writeFileSync(join(profileDir(stateDir), 'pnpm-lock.yaml'), options.lock, 'utf8')
    }
  }
  if (options.journalOps !== undefined) {
    mkdirSync(thirdPartyRoot(stateDir), { recursive: true })
    writeFileSync(journalFilePath(stateDir), JSON.stringify({ version: 1, ops: options.journalOps }, undefined, 2), 'utf8')
  }
  const workspace = scratchDir(t, 'gateway-undo-ws-')
  mkdirSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
  writeFileSync(join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '#!/usr/bin/env node\n')
  let leases = 0
  const manager = {
    workspace,
    beginProfileWrite() {
      leases += 1
      return { ok: true as const, release: () => { leases -= 1 } }
    },
    profileWriteInFlight: () => leases > 0,
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
    timeoutMs: 2000,
  })
  t.after(async () => {
    for (const call of spawn.calls) call.child.close(0)
    await orchestrator.dispose()
  })
  const host = createChamberSurface({
    logger: silent,
    channels: surfaceStubChannels,
    plugins: createChamberPlugins(stateDir, silent),
    installed: createChamberInstalled(stateDir),
    tasks: orchestrator,
    stateDir,
  })
  const lockFile = join(profileDir(stateDir), 'pnpm-lock.yaml')
  return {
    stateDir,
    workspace,
    host,
    orchestrator,
    spawn,
    leasesHeld: () => leases,
    before: {
      manifest: readFileSync(join(profileDir(stateDir), 'package.json'), 'utf8'),
      lock: existsSync(lockFile) ? readFileSync(lockFile, 'utf8') : null,
    },
  }
}

async function request(
  host: ReturnType<typeof createChamberSurface>,
  method: string,
  path: string,
  body?: unknown,
): Promise<FakeResponse> {
  const req = new FakeRequest(method, path, { host: 'gw.example:8443' })
  const res = new FakeResponse()
  const pending = host.handle(req as unknown as ApiRequest, res as unknown as ApiResponse, path)
  if (body !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  }
  await pending
  return res
}

async function waitOp(harness: Harness, opId: string): Promise<Record<string, any>> {
  let found: Record<string, any> | null = null
  await waitFor(() => {
    const op = harness.orchestrator.tasks().tasks.find(candidate => candidate.id === opId)
    if (op === undefined || op.status === 'pending') return false
    found = op as unknown as Record<string, any>
    return true
  }, `op ${opId} to settle`)
  if (found === null) throw new Error('op never settled')
  return found
}

test('install → undo restores package.json AND pnpm-lock.yaml byte-for-byte; the undo op is journaled with its own preImage', async t => {
  const h = await makeHarness(t, { manifest: MANIFEST_V0, lock: LOCK_V0 })
  // The install executes: the fake child rewrites the pair like the dsh CLI.
  const install = await request(h.host, 'PUT', '/chamber/plugins/install', { name: 'new-pkg', spec: 'new-pkg@1' })
  assert.equal(install.status, 202)
  const installOpId = install.json().opId as string
  await waitFor(() => h.spawn.calls.length === 1, 'install child')
  writePair(h.stateDir, MANIFEST_V1, LOCK_V1)
  h.spawn.calls[0]!.child.close(0)
  const installOp = await waitOp(h, installOpId)
  assert.equal(installOp.status, 'ok')
  assert.equal(installOp.preImage, installOpId)

  const undo = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(undo.status, 202)
  const undoOpId = undo.json().opId as string
  const undoOp = await waitOp(h, undoOpId)
  assert.equal(undoOp.status, 'ok')
  assert.equal(undoOp.kind, 'undo')
  assert.equal(undoOp.undoOf, installOpId, 'the undo records which op it restored')
  assert.equal(undoOp.preImage, undoOpId, 'the undo backed up the CURRENT pair first (it is itself undoable)')

  // Byte-for-byte restore of BOTH files.
  assert.equal(readFileSync(join(profileDir(h.stateDir), 'package.json'), 'utf8'), h.before.manifest)
  assert.equal(readFileSync(join(profileDir(h.stateDir), 'pnpm-lock.yaml'), 'utf8'), h.before.lock)

  // Both preImage directories stay referenced (the journal's retention rule).
  assert.equal(readFileSync(join(backupDirFor(h.stateDir, installOpId), 'package.json'), 'utf8'), h.before.manifest)
  const undoBackup = backupDirFor(h.stateDir, undoOpId)
  assert.equal(readFileSync(join(undoBackup, 'package.json'), 'utf8'), MANIFEST_V1, 'the undo backup holds the post-install pair')
  assert.equal(readFileSync(join(undoBackup, 'pnpm-lock.yaml'), 'utf8'), LOCK_V1)
})

test('undo of an executed REMOVE restores the removed declaration (撤销=恢复, not remove-only)', async t => {
  // Journal a previous ok `remove` whose preImage still declared the name.
  const removedOpId = 'op-remove-1'
  const h = await makeHarness(t, { manifest: MANIFEST_V0, lock: LOCK_V0, journalOps: [
    { id: removedOpId, ts: Date.now() - 1000, kind: 'remove', name: 'removed-pkg', preImage: removedOpId, status: 'ok' },
  ] })
  mkdirSync(backupDirFor(h.stateDir, removedOpId), { recursive: true })
  const preManifest = JSON.stringify({ name: 'web', version: '0.0.0', dependencies: { 'removed-pkg': '^2.0.0' } }, undefined, 2)
  writeFileSync(join(backupDirFor(h.stateDir, removedOpId), 'package.json'), preManifest, 'utf8')

  const undo = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(undo.status, 202)
  const undoOp = await waitOp(h, undo.json().opId as string)
  assert.equal(undoOp.status, 'ok')
  assert.equal(readFileSync(join(profileDir(h.stateDir), 'package.json'), 'utf8'), preManifest)
})

test('undo restores an absent lockfile by REMOVING the current one (exact pair restore)', async t => {
  const h = await makeHarness(t, { manifest: MANIFEST_V0, lock: null })
  const install = await request(h.host, 'PUT', '/chamber/plugins/install', { name: 'new-pkg', spec: 'new-pkg@1' })
  const installOpId = install.json().opId as string
  await waitFor(() => h.spawn.calls.length === 1, 'install child')
  // The dsh CLI also creates a lockfile on a first install.
  writePair(h.stateDir, MANIFEST_V1, LOCK_V1)
  h.spawn.calls[0]!.child.close(0)
  assert.equal((await waitOp(h, installOpId)).status, 'ok')

  const undo = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(undo.status, 202)
  assert.equal((await waitOp(h, undo.json().opId as string)).status, 'ok')
  assert.equal(readFileSync(join(profileDir(h.stateDir), 'package.json'), 'utf8'), h.before.manifest)
  assert.equal(existsSync(join(profileDir(h.stateDir), 'pnpm-lock.yaml')), false, 'the pre-mutation profile had no lockfile')
})

test('undo re-judges the INVERSE direction: a protected name fails loudly and the profile is untouched', async t => {
  const protectedOpId = 'op-protected-1'
  const current = JSON.stringify({ name: 'web', version: '0.0.0', dependencies: { '@deepseek-ai/dsh-base': '0.1.5-rc.2' } }, undefined, 2)
  const h = await makeHarness(t, { manifest: current, lock: null, journalOps: [
    { id: protectedOpId, ts: Date.now() - 500, kind: 'install', name: '@deepseek-ai/dsh-base', preImage: protectedOpId, status: 'ok' },
  ] })
  mkdirSync(backupDirFor(h.stateDir, protectedOpId), { recursive: true })
  writeFileSync(join(backupDirFor(h.stateDir, protectedOpId), 'package.json'), JSON.stringify({ name: 'web', version: '0.0.0', dependencies: {} }), 'utf8')

  const undo = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(undo.status, 202, 'the submission is accepted; the inverse judgement runs at execution')
  const undoOp = await waitOp(h, undo.json().opId as string)
  assert.equal(undoOp.status, 'failed')
  assert.match(String(undoOp.error), /\[protected\]/, 'the inverse remove decision is the single protected-set judgement')
  assert.equal(readFileSync(join(profileDir(h.stateDir), 'package.json'), 'utf8'), h.before.manifest, 'a refused undo never writes the profile')
})

test('nothing to undo → 409 no_undoable_op; wrong method → 405', async t => {
  const h = await makeHarness(t, { manifest: MANIFEST_V0, lock: null })
  const empty = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(empty.status, 409)
  assert.equal(empty.json().code, 'no_undoable_op')
  const method = await request(h.host, 'GET', '/chamber/plugins/undo')
  assert.equal(method.status, 405)
  assert.equal(method.json().code, 'method_not_allowed')
})

test('a corrupt journal is NOT "nothing to undo" → 503 journal_unavailable', async t => {
  const h = await makeHarness(t, { manifest: MANIFEST_V0, lock: null })
  mkdirSync(thirdPartyRoot(h.stateDir), { recursive: true })
  writeFileSync(journalFilePath(h.stateDir), 'not-json{', 'utf8')
  const response = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(response.status, 503)
  assert.equal(response.json().code, 'journal_unavailable')
})

test('a writer in flight fences the undo → 409 runtime_busy; after settle the undo targets that op', async t => {
  const h = await makeHarness(t, { manifest: MANIFEST_V0, lock: LOCK_V0 })
  const install = await request(h.host, 'PUT', '/chamber/plugins/install', { name: 'new-pkg', spec: 'new-pkg@1' })
  const installOpId = install.json().opId as string
  await waitFor(() => h.spawn.calls.length === 1, 'install child')
  const fenced = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(fenced.status, 409)
  assert.equal(fenced.json().code, 'runtime_busy')
  assert.match(fenced.json().error, /retry/)

  writePair(h.stateDir, MANIFEST_V1, LOCK_V1)
  h.spawn.calls[0]!.child.close(0)
  assert.equal((await waitOp(h, installOpId)).status, 'ok')
  assert.equal(h.leasesHeld(), 0)

  const undo = await request(h.host, 'POST', '/chamber/plugins/undo')
  assert.equal(undo.status, 202)
  const undoOp = await waitOp(h, undo.json().opId as string)
  assert.equal(undoOp.status, 'ok')
  assert.equal(undoOp.undoOf, installOpId)
  assert.equal(readFileSync(join(profileDir(h.stateDir), 'package.json'), 'utf8'), h.before.manifest)
})
