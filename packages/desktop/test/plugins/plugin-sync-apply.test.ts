/**
 * plugin-sync — part 3: exact ownership fences (ExactOwnershipRegistry,
 * scopeExecToOwnership, runWithFinalOwnership, ReadyPhaseEdges), applyPlugins
 * (whitelist, remove-before-add, single-flight, failure isolation, restart/verify),
 * materializeAndAdd / materializeArchiveAndAdd and the local writer reaper.
 * Sibling part: plugin-sync.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { applyPlugins, ExactOwnershipRegistry, localPluginWriterLedgerPath, materializeAbsolutePath, materializeAndAdd, materializeArchiveAndAdd, materializePluginsDir, remoteManifestPath, ReadyPhaseEdges, reapStaleLocalPluginWriters, scopeExecToOwnership, runWithFinalOwnership } from '../../plugin-sync.ts'
import type { ExecFn, ExecResult, SshApplyJournalSink, StatusFn } from '../../plugin-sync.ts'
import { NotificationSourceIncarnations } from '../../notifications.ts'
import { err, ok, readyStatus, SEED_SPEC, tempDir } from './plugin-sync-fixtures.ts'

/** Bounded wait for pid to be reaped (kill(pid, 0) → ESRCH): a killed leader's
 *  descendant is a zombie until init reaps it, so a single-shot assertion flaked. */
async function waitForEsrch(pid: number, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`${what} (pid ${pid}) still alive after the reaping window`)
}

/** An applyPlugins exec fake: `dsh` ops succeed or follow `onDsh`, the verify
 *  `cat` returns `manifest`, `restart` follows `onRestart`; else loud. */
function applyExec(options: { manifest?: string; onDsh?: (spec?: string) => ExecResult; onRestart?: () => ExecResult } = {}): ExecFn {
  return async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') return options.onDsh?.(payload.argv?.[4]) ?? ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') return ok(options.manifest)
    if (action === 'restart') return options.onRestart?.() ?? ok()
    return err(`unexpected ${action}`)
  }
}

/** The remote profile manifest JSON: `dependencies` installed, `bundles` activated. */
const manifestJson = (dependencies: Record<string, string>, bundles: string[] = []): string =>
  JSON.stringify({ dependencies, dsh: { profile: { bundles } } })

/** The 8-byte gzip-magic blob a materialize pack fixture returns. */
const TARBALL_BYTES = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x00, 0x01])

test('exact ownership lets a changed incarnation supersede and stale finally cannot clear it', () => {
  const owners = new ExactOwnershipRegistry()
  const first = owners.begin('same', 'host-a')
  assert.equal(first.accepted, true)
  const duplicate = owners.begin('same', 'host-a')
  assert.equal(duplicate.accepted, false, 'same incarnation remains single-flight')
  const replacement = owners.begin('same', 'host-b')
  assert.equal(replacement.accepted, true, 'changed incarnation starts immediately')
  assert.equal(owners.owns(first.token), false)
  assert.equal(owners.finish(first.token), false, 'old finally cannot delete new ownership')
  assert.equal(owners.owns(replacement.token), true)
  assert.equal(owners.finish(replacement.token), true)
  const removed = owners.begin('same', 'host-b')
  assert.equal(removed.accepted, true)
  assert.equal(owners.revoke('same'), true)
  assert.equal(owners.owns(removed.token), false)
  assert.equal(owners.begin('same', 'host-b').accepted, true, 'remove/re-add gets fresh ownership even with same fingerprint')
})
test('scoped exec checks exact ownership before and after every remote step', async () => {
  let owner = true
  let calls = 0
  let settle!: (result: ReturnType<typeof ok>) => void
  const underlying: ExecFn = async () => {
    calls += 1
    return await new Promise(resolve => { settle = resolve })
  }
  const scoped = scopeExecToOwnership(underlying, 'same', () => owner)
  const inFlight = scoped('same', 'run', { op: 'exec', command: 'cat', argv: ['/tmp/x'] })
  owner = false
  settle(ok())
  assert.deepEqual(await inFlight, { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.deepEqual(await scoped('same', 'restart'), { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.deepEqual(await scoped('other', 'restart'), { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.equal(calls, 1, 'stale ownership never starts another saga step')
})
test('remote saga ownership cannot revive after byte-identical same-id re-add', async () => {
  const sources = new NotificationSourceIncarnations()
  const sourceId = 'ssh-same'
  const fingerprint = 'a'.repeat(64)
  sources.replaceRemoteSources([{ sourceId, fingerprint }])
  const sourceToken = sources.capture(sourceId)!
  const operationalFingerprint = 'same-operational-fields'
  let currentOperationalFingerprint = operationalFingerprint
  const owns = (): boolean =>
    sources.owns(sourceToken) && currentOperationalFingerprint === operationalFingerprint
  let calls = 0
  let settle!: (result: ExecResult) => void
  const scoped = scopeExecToOwnership(async () => {
    calls += 1
    return await new Promise<ExecResult>(resolve => { settle = resolve })
  }, 'same', owns)
  const firstStep = scoped('same', 'run', { op: 'exec', command: 'cat', argv: ['first'] })
  sources.replaceRemoteSources([])
  sources.replaceRemoteSources([{ sourceId, fingerprint }])
  assert.equal(currentOperationalFingerprint, operationalFingerprint)
  assert.equal(owns(), false, 'reusable fields do not restore exact lifecycle ownership')
  settle(ok())
  assert.deepEqual(await firstStep, { ok: false, error: 'ssh instance changed while operation was in progress' })
  const secondStep = await scoped('same', 'run', { op: 'exec', command: 'cat', argv: ['second'] })
  assert.deepEqual(secondStep, { ok: false, error: 'ssh instance changed while operation was in progress' })
  assert.equal(calls, 1, 'a later saga step never runs on the replacement host')
})
test('final ownership fence rejects a deferred completion after same-id replacement', async () => {
  let owner = true
  let settle!: (value: { ok: true; manifest: string }) => void
  const pending = runWithFinalOwnership(
    () => owner,
    () => new Promise(resolve => { settle = resolve }),
  )
  owner = false
  settle({ ok: true, manifest: 'old-host' })
  assert.deepEqual(await pending, { ok: false, error: 'ssh instance changed while operation was in progress' })
})
test('ready edge tracker fires only non-ready to ready and forgets removed ids', () => {
  const edges = new ReadyPhaseEdges()
  assert.equal(edges.observe('same', 'connecting'), false)
  assert.equal(edges.observe('same', 'ready'), true)
  assert.equal(edges.observe('same', 'ready'), false, 'service/status projections while ready never reseed')
  assert.equal(edges.observe('same', 'degraded'), false)
  assert.equal(edges.observe('same', 'ready'), true)
  edges.forget('same')
  assert.equal(edges.activeCount, 0)
  assert.equal(edges.observe('same', 'ready'), true, 'same-id re-add has a fresh edge history')
})

// ============================================================================
// applyPlugins
// ============================================================================

test('applyPlugins: re-validates add/remove against the whitelist (untrusted renderer)', async () => {
  const noop: ExecFn = async () => ok()
  assert.deepEqual(await applyPlugins(noop, readyStatus, SEED_SPEC, { add: ['file:/tmp/x.tgz'], remove: [] }),
    { ok: false, error: 'invalid add spec: "file:/tmp/x.tgz"' })
  assert.deepEqual(await applyPlugins(noop, readyStatus, SEED_SPEC, { add: ['foo; rm -rf /'], remove: [] }),
    { ok: false, error: 'invalid add spec: "foo; rm -rf /"' })
  assert.deepEqual(await applyPlugins(noop, readyStatus, SEED_SPEC, { add: [], remove: ['../evil'] }),
    { ok: false, error: 'invalid remove name: "../evil"' })
})
test('applyPlugins: remove runs before add, serial, per-item isolation, restart + verify', async () => {
  const order: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      order.push(`${payload.argv?.[0] === 'plugin' ? payload.argv[3] : '?'}:${payload.argv?.[4]}`)
      return ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      // verification read-back: `new-pkg` present, `old-pkg` absent
      return ok(manifestJson({ 'new-pkg': '^1.0.0' }))
    }
    if (action === 'restart') return ok()
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['new-pkg@^1.0.0'], remove: ['old-pkg'] })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.applied, 2)
    assert.equal(result.result.restarted, true)
    assert.equal(result.result.deferred, false)
    assert.equal(result.result.verified, true)
    assert.equal(result.result.ready, true)
    assert.deepEqual(result.result.failed, [])
  }
  assert.deepEqual(order, ['remove:old-pkg', 'add:new-pkg@^1.0.0'])
})
test('applyPlugins: restart===false defers and skips the ready recheck', async () => {
  const actions: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') { actions.push('dsh'); return ok() }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') return ok(manifestJson({ pkg: '^1.0.0' }))
    actions.push(action)
    return ok()
  }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['pkg@^1.0.0'], remove: [], restart: false })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.deferred, true)
    assert.equal(result.result.restarted, false)
    assert.equal(result.result.ready, null)
  }
  assert.ok(!actions.includes('restart'))
})
test('applyPlugins: single-flight refuses a concurrent apply for the same instance', async t => {
  const pending: Array<(r: ExecResult) => void> = []
  let auto = false
  const exec: ExecFn = () => {
    if (auto) return Promise.resolve(ok())
    return new Promise(resolve => { pending.push(resolve) })
  }
  const first = applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['x@1.0.0'], remove: [] })
  // Natural single-flight cleanup, registered BEFORE any assertion: even on
  // a mid-test failure, completing the held apply lets the production
  // finally-block release the guard (no production test backdoor; state
  // never leaks into later tests).
  t.after(async () => {
    auto = true
    for (const resolve of pending) resolve(ok())
    await Promise.allSettled([first])
  })
  const second = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['y@1.0.0'], remove: [] })
  assert.deepEqual(second, { ok: false, error: 'apply in progress' })
})
test('applyPlugins: a changed operational owner is not blocked by the reusable id', async t => {
  const pending: Array<(r: ExecResult) => void> = []
  let auto = false
  const exec: ExecFn = () => auto
    ? Promise.resolve(ok('{}'))
    : new Promise(resolve => { pending.push(resolve) })
  const oldApply = applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['old@1.0.0'], remove: [] }, { ownershipKey: 'host-a' })
  const newApply = applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['new@1.0.0'], remove: [] }, { ownershipKey: 'host-b' })
  // Natural single-flight cleanup (see the single-flight test), registered
  // before the assertions so a mid-test failure still releases the guard.
  t.after(async () => {
    auto = true
    for (const resolve of pending) resolve(ok())
    await Promise.allSettled([oldApply, newApply])
  })
  await Promise.resolve()
  assert.equal(pending.length, 2, 'replacement owner starts immediately')
  const duplicate = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['duplicate@1.0.0'], remove: [] }, { ownershipKey: 'host-b' })
  assert.deepEqual(duplicate, { ok: false, error: 'apply in progress' })
})
test('applyPlugins: protected names refuse the WHOLE batch before any exec (design 21 §6.11)', async () => {
  // ssh facts = B₀ ∪ S with NO family source: a chamber seed / composition
  // member is `protected`, and ANY official-scope install is conservative-
  // refused. The refusal must happen before ANY remote change and must name
  // each refused row with its code.
  let execCalls = 0
  const exec: ExecFn = async () => { execCalls += 1; return ok() }
  const seedAdd = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['@dsh-chamber/dsh-chamber-seed-client-graph@1.2.3'], remove: [] })
  assert.equal(seedAdd.ok, false)
  if (!seedAdd.ok) {
    assert.match(seedAdd.error, /@dsh-chamber\/dsh-chamber-seed-client-graph \[protected\]/)
  }
  const compositionRemove = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: [], remove: ['@deepseek-ai/dsh-base'] })
  assert.equal(compositionRemove.ok, false)
  if (!compositionRemove.ok) {
    assert.match(compositionRemove.error, /@deepseek-ai\/dsh-base \[protected\]/)
  }
  // ssh install face is conservative: an official-scope row is refused even
  // when the name is NOT in B₀ ∪ S (no remote family facts can bound it).
  const officialAdd = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.2'], remove: [] })
  assert.equal(officialAdd.ok, false)
  if (!officialAdd.ok) {
    assert.match(officialAdd.error, /@deepseek-ai\/dsh-experimental-agent-team-profile \[protected\]/)
  }
  // A MIXED batch (valid rows alongside a refused one) is refused in full:
  // the valid rows must never execute around the refused row.
  const mixed = await applyPlugins(exec, readyStatus, SEED_SPEC, {
    add: ['fine-pkg@1.0.0', '@deepseek-ai/official@0.1.5-rc.2'],
    remove: ['@dsh-chamber/dsh-chamber-seed-git-worktree'],
  })
  assert.equal(mixed.ok, false)
  if (!mixed.ok) {
    assert.match(mixed.error, /@deepseek-ai\/official/)
    assert.match(mixed.error, /@dsh-chamber\/dsh-chamber-seed-git-worktree/)
  }
  assert.equal(execCalls, 0, 'no exec (not even a snapshot read) may run for a refused batch')
})
test('applyPlugins: with a journal sink, every executed row records its PRE-CHANGE spec (snapshot first)', async () => {
  const order: string[] = []
  let manifestCats = 0
  const PRE = { dependencies: { 'old-pkg': '^2.0.0', 'up-pkg': '^1.0.0' } }
  const POST = { dependencies: { 'new-pkg': '^1.0.0', 'up-pkg': '^2.0.0' } }
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      const verb = payload.argv?.[0] === 'plugin' ? payload.argv[3] : '?'
      order.push(`${verb}:${payload.argv?.[4]}`)
      return ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      const target = payload.argv?.[0] ?? ''
      if (target === remoteManifestPath(null)) {
        manifestCats += 1
        order.push(`cat:manifest#${manifestCats}`)
        return ok(JSON.stringify(manifestCats === 1 ? PRE : POST))
      }
      // Chamber probe files: absent (never loud).
      order.push('cat:probe-absent')
      return err('cat: /root/.dsh/profiles/x/package.json: No such file or directory')
    }
    order.push(action)
    return ok()
  }
  const recorded: Array<{ name: string; kind: string; specBefore: string | null; ok: boolean }> = []
  const journal: SshApplyJournalSink = {
    record: entry => recorded.push({ name: entry.name, kind: entry.kind, specBefore: entry.specBefore, ok: entry.ok }),
  }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC,
    { remove: ['old-pkg'], add: ['new-pkg@^1.0.0', 'up-pkg@^2.0.0'], restart: false }, { journal })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.applied, 3)
    assert.equal(result.result.verified, true)
    assert.equal(result.result.deferred, true)
  }
  // Snapshot read happens BEFORE the first remote change…
  const snapshotIndex = order.indexOf('cat:manifest#1')
  const firstRowIndex = order.findIndex(call => call.startsWith('remove:') || call.startsWith('add:'))
  assert.ok(snapshotIndex !== -1 && snapshotIndex < firstRowIndex, 'the journal snapshot must precede every remote change')
  // …the verify read-back comes after the rows.
  assert.ok(order.indexOf('cat:manifest#2') > firstRowIndex)
  // Rows are journaled in execution order with the PRE-change specs: an add
  // of an absent name has specBefore null; an in-place upgrade records the
  // version it replaced; a remove records the spec it removed.
  assert.deepEqual(recorded, [
    { name: 'old-pkg', kind: 'remove', specBefore: '^2.0.0', ok: true },
    { name: 'new-pkg', kind: 'add', specBefore: null, ok: true },
    { name: 'up-pkg', kind: 'add', specBefore: '^1.0.0', ok: true },
  ])
})
test('applyPlugins: failed rows are journaled with ok:false and their error, never undoable', async () => {
  const order: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      const spec = payload.argv?.[4]
      order.push(`add:${spec}`)
      return spec === 'bad-pkg@1.0.0' ? err('remote: bad package name') : ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') return ok(manifestJson({}))
    return ok()
  }
  const recorded: Array<{ name: string; ok: boolean; error?: string }> = []
  const journal: SshApplyJournalSink = { record: entry => recorded.push(entry) }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC,
    { add: ['good-pkg@1.0.0', 'bad-pkg@1.0.0'], remove: [], restart: false }, { journal })
  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.result.failed, [{ spec: 'bad-pkg@1.0.0', error: 'remote: bad package name' }])
  assert.deepEqual(recorded, [
    { instanceId: 's1', name: 'good-pkg', kind: 'add', specBefore: null, ok: true },
    { instanceId: 's1', name: 'bad-pkg', kind: 'add', specBefore: null, ok: false, error: 'remote: bad package name' },
  ])
})
test('applyPlugins: a non-ENOENT journal snapshot failure refuses the whole batch (P0-2: no row, nothing to undo)', async () => {
  const order: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      order.push('cat:snapshot')
      return err('ssh: connect to host example.com port 22: Connection reset by peer')
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      order.push(['dsh', String(payload.argv?.[3]), String(payload.argv?.[4])].join(':'))
      return ok()
    }
    order.push(action)
    return ok()
  }
  const recorded: unknown[] = []
  const journal: SshApplyJournalSink = { record: entry => recorded.push(entry) }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC,
    { remove: ['old-pkg'], add: ['up-pkg@^2.0.0'], restart: false }, { journal })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /pre-change journal snapshot could not be read/)
    assert.match(result.error, /Connection reset by peer/, 'the sanitized cause is reported, not a bare default')
  }
  // A row with `specBefore` null would execute and be recorded, so undoing it
  // would remove a plugin that was upgraded in place. Nothing may run, and no
  // op may be recorded — an empty journal makes latestOkForTarget return null,
  // so the undo IPC answers "no recent plugin change to undo" instead of
  // issuing a remove.
  assert.deepEqual(order, ['cat:snapshot'], 'no remote change may follow the failed snapshot read')
  assert.deepEqual(recorded, [], 'no journal op may be recorded without a trustworthy pre-change spec')
})
test('applyPlugins: an unparseable snapshot manifest refuses the batch too (never an empty dependency map)', async () => {
  const order: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      order.push('cat:snapshot')
      return ok('not a JSON manifest at all')
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      order.push(['dsh', String(payload.argv?.[3]), String(payload.argv?.[4])].join(':'))
      return ok()
    }
    order.push(action)
    return ok()
  }
  const recorded: unknown[] = []
  const journal: SshApplyJournalSink = { record: entry => recorded.push(entry) }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC,
    { add: ['up-pkg@^2.0.0'], remove: [], restart: false }, { journal })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /failed to parse remote package\.json/)
  assert.deepEqual(order, ['cat:snapshot'], 'a manifest that cannot be parsed is not an empty dependency map')
  assert.deepEqual(recorded, [])
})
test('applyPlugins: an ENOENT snapshot (absent profile) stays an empty snapshot — the batch still applies', async () => {
  const order: string[] = []
  let cats = 0
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      cats += 1
      if (cats === 1) {
        order.push('cat:snapshot')
        return err('cat: /root/.dsh/profiles/web/package.json: No such file or directory')
      }
      order.push('cat:verify')
      return ok(manifestJson({ 'fresh-pkg': '^1.0.0' }))
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      order.push(['dsh', String(payload.argv?.[3]), String(payload.argv?.[4])].join(':'))
      return ok()
    }
    return err('unexpected ' + action)
  }
  const recorded: Array<{ name: string; specBefore: string | null }> = []
  const journal: SshApplyJournalSink = {
    record: entry => recorded.push({ name: entry.name, specBefore: entry.specBefore }),
  }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC,
    { add: ['fresh-pkg@^1.0.0'], remove: [], restart: false }, { journal })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.result.verified, true)
  // verifyApplied re-pulls the manifest + chamber probes (several tagged
  // 'cat:verify' reads); strip those and assert the only real change ran.
  assert.equal(order[0], 'cat:snapshot', 'the snapshot read is the first remote call')
  assert.deepEqual(order.filter(entry => entry !== 'cat:verify'), ['cat:snapshot', 'dsh:add:fresh-pkg@^1.0.0'],
    'the absent profile must not block the batch')
  assert.deepEqual(recorded, [{ name: 'fresh-pkg', specBefore: null }])
})
test('applyPlugins: without a journal sink the historical exec sequence is unchanged (no snapshot read)', async () => {
  const order: string[] = []
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      order.push(`dsh:${payload.argv?.[3]}:${payload.argv?.[4]}`)
      return ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'cat') {
      order.push('cat:verify')
      return ok(manifestJson({ 'pkg-a': '^1.0.0' }))
    }
    if (action === 'restart') {
      order.push('restart')
      return ok()
    }
    return err(`unexpected ${action}`)
  }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['pkg-a@^1.0.0'], remove: [] })
  assert.equal(result.ok, true)
  assert.deepEqual(order[0], 'dsh:add:pkg-a@^1.0.0', 'the first exec is the change itself — no snapshot read without a journal')
})
test('materializeAndAdd: a folder claiming a protected name (or an unpinned official one) is refused before any exec', async () => {
  // ssh facts: B₀ ∪ S protection + conservative official-scope installs.
  // A chamber *seed* name can never be smuggled in through a folder pick...
  const root = tempDir()
  let execCalls = 0
  const exec: ExecFn = async () => { execCalls += 1; return ok() }
  const noPack = async (): Promise<never> => { throw new Error('pack must not run for a refused materialize') }
  const seedDir = join(root, 'seed')
  mkdirSync(seedDir)
  writeFileSync(join(seedDir, 'package.json'), JSON.stringify({ name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0' }))
  const seedPick = await materializeAndAdd(exec, SEED_SPEC, seedDir, noPack)
  assert.equal(seedPick.ok, false)
  if (!seedPick.ok) assert.match(seedPick.error, /\[protected\]/)
  // ...and an official-scope folder is refused on the ssh install face even
  // when the name is not part of the baseline.
  const officialDir = join(root, 'official')
  mkdirSync(officialDir)
  writeFileSync(join(officialDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', version: '0.1.5-rc.2' }))
  const officialPick = await materializeAndAdd(exec, SEED_SPEC, officialDir, noPack)
  assert.equal(officialPick.ok, false)
  if (!officialPick.ok) assert.match(officialPick.error, /\[protected\]/)
  assert.equal(execCalls, 0, 'the remote write/add chain never runs')
})

// ============================================================================
// applyPlugins: failure isolation / verification / restart semantics
// ============================================================================

test('applyPlugins: per-item failure isolation — one failing add never blocks the rest', async () => {
  const exec = applyExec({
    manifest: manifestJson({ good: '^1.0.0' }),
    onDsh: spec => spec === 'bad@1.0.0' ? err('pnpm error: 404 Not Found') : ok(),
  })
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['good@^1.0.0', 'bad@1.0.0'], remove: [], restart: false })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.applied, 1, 'only the successful add counts')
    assert.equal(result.result.failed.length, 1)
    assert.equal(result.result.failed[0].spec, 'bad@1.0.0')
    assert.match(result.result.failed[0].error, /404/)
    assert.equal(result.result.verified, true, 'failed items are excluded from the assertion')
  }
})
test('applyPlugins: verified:false when an add did not land in the remote manifest (fail-loud)', async () => {
  // The add "succeeded" on the wire but never reached dependencies.
  const exec = applyExec({ manifest: manifestJson({}) })
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['pkg@^1.0.0'], remove: [], restart: false })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.applied, 1)
    assert.equal(result.result.verified, false)
  }
})
test('applyPlugins: restart failure → {restarted:false, ready:null}, honest report, never a fake success', async () => {
  const exec = applyExec({ manifest: manifestJson({ pkg: '^1.0.0' }), onRestart: () => err('systemctl restart failed (exit 5)') })
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['pkg@^1.0.0'], remove: [] })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.restarted, false)
    assert.equal(result.result.ready, null)
    assert.equal(result.result.deferred, false)
  }
})
test('applyPlugins: ready recheck failure after a restart → {ready:false}', async () => {
  // The instance is CONNECTED before the apply (ready), then the restart
  // leaves it down and it never recovers — the bounded recheck must time out.
  let phase: 'ready' | 'error' = 'ready'
  const status: StatusFn = () => ({ phase })
  const exec = applyExec({ manifest: manifestJson({ pkg: '^1.0.0' }), onRestart: () => { phase = 'error'; return ok() } })
  const result = await applyPlugins(exec, status, SEED_SPEC, { add: ['pkg@^1.0.0'], remove: [] }, { verifyReadyTimeoutMs: 20, verifyReadyIntervalMs: 5 })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.restarted, true)
    assert.equal(result.result.ready, false)
  }
})
test('applyPlugins: restart on a NOT-connected instance reports ready:null + readyNote, never a misleading ready:false', async () => {
  const idleStatus: StatusFn = () => ({ phase: 'idle' })
  const exec = applyExec({ manifest: manifestJson({ pkg: '^1.0.0' }) })
  const result = await applyPlugins(exec, idleStatus, SEED_SPEC, { add: ['pkg@^1.0.0'], remove: [] })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.restarted, true)
    assert.equal(result.result.ready, null)
    assert.ok(result.result.readyNote !== undefined)
    assert.match(result.result.readyNote, /not connected/)
  }
})
test('applyPlugins: a non-boolean restart is refused (string "false" must never trigger a restart)', async () => {
  const exec: ExecFn = async () => { throw new Error('no exec may run for an invalid apply') }
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['pkg@^1.0.0'], remove: [], restart: 'false' as unknown as boolean })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /restart must be a boolean/)
})
test('applyPlugins: a known bundle add missing from the remote bundles layer → verified:false (design 13 §3)', async () => {
  // dependency present but the bundle activation layer is empty.
  const exec = applyExec({ manifest: manifestJson({ 'bundle-pkg': '^1.0.0' }) })
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['bundle-pkg@^1.0.0'], remove: [], restart: false }, { knownBundles: ['bundle-pkg'] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.result.verified, false)
})
test('applyPlugins: a known bundle add in dependencies AND bundles → verified:true', async () => {
  const exec = applyExec({ manifest: manifestJson({ 'bundle-pkg': '^1.0.0' }, ['bundle-pkg']) })
  const result = await applyPlugins(exec, readyStatus, SEED_SPEC, { add: ['bundle-pkg@^1.0.0'], remove: [], restart: false }, { knownBundles: ['bundle-pkg'] })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.result.verified, true)
})

// ============================================================================
// materializeAndAdd (design 13 §3)
// ============================================================================

test('materializePluginsDir is the stable literal dir for every remoteDshHome (design 13 §3)', () => {
  assert.equal(materializePluginsDir(null), '~/.dsh-chamber/plugins')
  assert.equal(materializePluginsDir('~/.dsh'), '~/.dsh-chamber/plugins')
  assert.equal(materializePluginsDir('/opt/dsh'), '~/.dsh-chamber/plugins')
})
test('materializeAbsolutePath resolves ~ via the REMOTE $HOME (printf), never the local home', async () => {
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') {
      assert.deepEqual(payload.argv, ['%s', '$HOME'])
      return ok('/home/remote-user')
    }
    return err(`unexpected ${action}`)
  }
  const resolved = await materializeAbsolutePath(exec, SEED_SPEC, '~/.dsh-chamber/plugins/pkg-a1b2.tgz')
  assert.deepEqual(resolved, { ok: true, path: '/home/remote-user/.dsh-chamber/plugins/pkg-a1b2.tgz' })
})
test('materializeAbsolutePath: absolute paths pass through; an unsafe remote $HOME fails loud', async () => {
  const passthrough = await materializeAbsolutePath(async () => err('unexpected'), SEED_SPEC, '/opt/x.tgz')
  assert.deepEqual(passthrough, { ok: true, path: '/opt/x.tgz' })
  const unsafeExec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') return ok('bad home with spaces; rm -rf /')
    return err(`unexpected ${action}`)
  }
  const fail = await materializeAbsolutePath(unsafeExec, SEED_SPEC, '~/.dsh-chamber/plugins/x.tgz')
  assert.equal(fail.ok, false)
  if (!fail.ok) assert.match(fail.error, /not an absolute, shell-safe path/)
})

function makeMaterializeExec() {
  const calls: Array<{ op: string; argv?: string[] }> = []
  const written: Array<{ path: string; bytes: Buffer }> = []
  const exec: ExecFn = async (_id, action, payload) => {
    const record: { op: string; argv?: string[] } = { op: payload?.op ?? action }
    calls.push(record)
    if (action === 'run' && payload?.op === 'write-file') {
      written.push({ path: payload.path ?? '?', bytes: Buffer.from(payload.contentBase64 ?? '', 'base64') })
      return ok()
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') {
      record.argv = payload.argv
      return ok('/home/u')
    }
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'dsh') {
      record.argv = payload.argv
      return ok()
    }
    return err(`unexpected ${action}`)
  }
  return { exec, calls, written }
}

test('materializeAndAdd: pack → write-file → remote $HOME → add file:<absolute> (scoped name normalized)', async () => {
  const root = tempDir()
  const pkgDir = join(root, 'pkg')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/my-plugin', version: '1.0.0' }))
  const remote = makeMaterializeExec()
  const result = await materializeAndAdd(remote.exec, SEED_SPEC, pkgDir, () => ({ bytes: TARBALL_BYTES }))
  assert.equal(result.ok, true)
  if (!result.ok) return
  // write target: the stable literal dir + the NORMALIZED scoped filename.
  assert.equal(remote.written.length, 1)
  const writePath = remote.written[0].path
  assert.ok(writePath.startsWith('~/.dsh-chamber/plugins/scope-my-plugin-'), `normalized filename, got ${writePath}`)
  assert.ok(writePath.endsWith('.tgz'))
  assert.ok(remote.written[0].bytes.equals(TARBALL_BYTES), 'the tarball bytes are preserved verbatim')
  // add spec: absolute file: under the remote $HOME — never a local path.
  const addCall = remote.calls.find(entry => entry.op === 'exec' && entry.argv?.[0] === 'plugin')
  assert.ok(addCall !== undefined)
  const addSpec = addCall.argv?.[4] ?? ''
  assert.match(addSpec, /^file:\/home\/u\/\.dsh-chamber\/plugins\/scope-my-plugin-[0-9a-f]{16}\.tgz$/)
  assert.equal(result.remotePath, writePath)
  assert.equal(result.spec, addSpec)
})
test('materializeAndAdd: an unresolvable remote $HOME fails loud (never the LOCAL home path)', async () => {
  const root = tempDir()
  const pkgDir = join(root, 'pkg')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }))
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'write-file') return ok()
    if (action === 'run' && payload?.op === 'exec' && payload.command === 'printf') {
      return err('run command failed (exit 255): the ssh exec could not reach the host')
    }
    return err(`unexpected ${action}`)
  }
  const result = await materializeAndAdd(exec, SEED_SPEC, pkgDir, () => ({ bytes: Buffer.from('x') }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /cannot resolve the remote \$HOME/)
})
test('materializeAndAdd: a write-file failure fails loud before the add', async () => {
  const root = tempDir()
  const pkgDir = join(root, 'pkg')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }))
  const exec: ExecFn = async (_id, action, payload) => {
    if (action === 'run' && payload?.op === 'write-file') return err('write-file verification failed: remote SHA-256 mismatch')
    return err(`unexpected ${action}`)
  }
  const result = await materializeAndAdd(exec, SEED_SPEC, pkgDir, () => ({ bytes: Buffer.from('x') }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /write-file failed/)
})

// materializeArchiveAndAdd (design 21 §6.5 archive-pick): a READY .tgz uploads
// verbatim — no local package.json read, no pnpm pack — through the same
// write-file → remote $HOME → add file: tail.
test('materializeArchiveAndAdd: archive bytes → write-file → remote $HOME → add file:<absolute>', async () => {
  const remote = makeMaterializeExec()
  const result = await materializeArchiveAndAdd(remote.exec, SEED_SPEC, { name: 'pkg', bytes: TARBALL_BYTES })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(remote.written.length, 1)
  const writePath = remote.written[0].path
  assert.ok(writePath.startsWith('~/.dsh-chamber/plugins/pkg-'), `name-derived filename, got ${writePath}`)
  assert.ok(writePath.endsWith('.tgz'))
  assert.ok(remote.written[0].bytes.equals(TARBALL_BYTES), 'the archive bytes are preserved verbatim (no repack)')
  const addCall = remote.calls.find(entry => entry.op === 'exec' && entry.argv?.[0] === 'plugin')
  assert.ok(addCall !== undefined)
  const addSpec = addCall.argv?.[4] ?? ''
  assert.match(addSpec, /^file:\/home\/u\/\.dsh-chamber\/plugins\/pkg-[0-9a-f]{16}\.tgz$/)
  assert.equal(result.remotePath, writePath)
  assert.equal(result.spec, addSpec)
})
test('materializeArchiveAndAdd: protected / unpinned-official / malformed names are refused before any exec', async () => {
  const exec: ExecFn = async () => err('unexpected exec — a refused archive must not touch the remote')
  const bytes = Buffer.from([0x1f, 0x8b, 0x08])
  // A chamber SEED name is protected; a non-seed `@dsh-chamber/*` name is NOT
  // (the protected seed set is the fact) but still needs a well-formed shape.
  for (const name of ['@dsh-chamber/dsh-chamber-seed-client-graph', 'bad name!', '']) {
    const result = await materializeArchiveAndAdd(exec, SEED_SPEC, { name, bytes })
    assert.equal(result.ok, false, name)
    if (!result.ok) assert.match(result.error, /invalid package name|\[protected\]/)
  }
  // Official scope on the ssh install face: conservative refusal regardless of
  // the archive's declared version.
  const official = await materializeArchiveAndAdd(exec, SEED_SPEC, { name: '@deepseek-ai/taken', version: '0.1.5-rc.2', bytes })
  assert.equal(official.ok, false)
  if (!official.ok) assert.match(official.error, /\[protected\]/)
})
test('materializeArchiveAndAdd: an oversized or empty archive is refused before any exec', async () => {
  const exec: ExecFn = async () => err('unexpected exec')
  const empty = await materializeArchiveAndAdd(exec, SEED_SPEC, { name: 'pkg', bytes: Buffer.alloc(0) })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.match(empty.error, /empty/)
  const oversized = await materializeArchiveAndAdd(exec, SEED_SPEC, { name: 'pkg', bytes: Buffer.alloc(50 * 1024 * 1024 + 1) })
  assert.equal(oversized.ok, false)
  if (!oversized.ok) assert.match(oversized.error, /remote write cap/)
})
test('local plugin writer reaper fail-closes on PID identity reuse', async () => {
  const root = tempDir()
  const home = join(root, 'state', 'dsh-home')
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(localPluginWriterLedgerPath(home), JSON.stringify({
    schemaVersion: 1,
    pid: 41001,
    ownerPid: 41000,
    ownerStartToken: 'old-owner',
    childStartToken: 'old-child',
    childCommandHash: 'old-command',
    createdAt: new Date().toISOString(),
  }))
  const signals: string[] = []
  const result = await reapStaleLocalPluginWriters(home, {
    inspectProcess: pid => pid === 41001
      ? { startToken: 'reused-child', commandHash: 'different-command' }
      : null,
    processAlive: pid => pid === 41001,
    signalGroup: (_pid, signal) => { signals.push(signal) },
    wait: async () => {},
  })
  assert.deepEqual(result, { ok: false, error: 'local plugin writer PID identity changed; refusing to signal it' })
  assert.deepEqual(signals, [])
  assert.equal(existsSync(localPluginWriterLedgerPath(home)), true)
})
test('local plugin writer reaper kills a daemonized descendant after its group leader exited', {
  skip: process.platform === 'win32',
  timeout: 15_000,
}, async () => {
  const root = tempDir()
  const home = join(root, 'state', 'dsh-home')
  mkdirSync(join(root, 'state'), { recursive: true })
  const leader = spawn(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref()",
    "process.stdout.write(String(child.pid))",
  ].join(';')], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  let output = ''
  leader.stdout?.setEncoding('utf8')
  leader.stdout?.on('data', chunk => { output += chunk })
  await new Promise<void>((resolve, reject) => {
    leader.once('close', () => resolve())
    leader.once('error', reject)
  })
  const descendantPid = Number(output)
  assert.ok(Number.isInteger(leader.pid) && leader.pid! > 0)
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0)
  writeFileSync(localPluginWriterLedgerPath(home), JSON.stringify({
    schemaVersion: 1,
    pid: leader.pid,
    ownerPid: 2_000_000_000,
    ownerStartToken: null,
    childStartToken: 'leader-exited',
    childCommandHash: 'leader-exited',
    createdAt: new Date().toISOString(),
  }))
  try {
    const result = await reapStaleLocalPluginWriters(home)
    assert.deepEqual(result, { ok: true, reaped: true })
    assert.equal(existsSync(localPluginWriterLedgerPath(home)), false)
    await waitForEsrch(descendantPid, 'reaped descendant')
  } finally {
    try { process.kill(-leader.pid!, 'SIGKILL') } catch { /* already reaped */ }
    rmSync(root, { recursive: true, force: true })
  }
})
