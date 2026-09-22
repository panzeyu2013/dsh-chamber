/**
 * lockfile-facts-memo unit tests: the local
 * plugin-protection facts must be parsed once per input identity and MUST
 * reload when the underlying lockfile changes (mtime OR size) — a stale
 * family fact would judge a plugin install against a runtime line the machine
 * does not run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeyedMemo, fileIdentity, lockfileIdentityKey } from '../../lockfile-facts-memo.ts'

test('createKeyedMemo: load runs once per key and again on every key change', () => {
  const memo = createKeyedMemo<{ n: number }>()
  let loads = 0
  const load = (): { n: number } => { loads += 1; return { n: loads } }
  assert.deepEqual(memo.read('a', load), { n: 1 })
  assert.deepEqual(memo.read('a', load), { n: 1 }, 'same key ⇒ cached value')
  assert.equal(loads, 1)
  assert.deepEqual(memo.read('b', load), { n: 2 })
  assert.deepEqual(memo.read('a', load), { n: 3 }, 'the memo holds ONE entry: switching back reloads')
  assert.equal(loads, 3)
})

test('createKeyedMemo: a thrown load does not poison the cache (retry reloads)', () => {
  const memo = createKeyedMemo<string>()
  let attempts = 0
  assert.throws(() => memo.read('k', () => { attempts += 1; throw new Error('boom') }))
  assert.equal(memo.read('k', () => { attempts += 1; return 'ok' }), 'ok')
  assert.equal(attempts, 2)
})

test('fileIdentity/lockfileIdentityKey: mtime and size changes invalidate; absent is distinct', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lockfile-memo-'))
  try {
    const file = join(dir, 'pnpm-lock.yaml')
    assert.equal(fileIdentity(file), 'absent')
    assert.equal(lockfileIdentityKey([file]), file + '=absent')
    writeFileSync(file, 'a'.repeat(64))
    const first = lockfileIdentityKey([file])
    assert.notEqual(first, file + '=absent')
    assert.equal(lockfileIdentityKey([file]), first, 'unchanged file ⇒ identical key')
    writeFileSync(file, 'a'.repeat(128))
    const bigger = lockfileIdentityKey([file])
    assert.notEqual(bigger, first, 'size change ⇒ different key')
    utimesSync(file, new Date(), new Date(Date.now() + 5_000))
    assert.notEqual(lockfileIdentityKey([file]), bigger, 'mtime change ⇒ different key')
    rmSync(file, { force: true })
    assert.equal(lockfileIdentityKey([file]), file + '=absent', 'removal ⇒ back to absent')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createKeyedMemo + lockfileIdentityKey: the real invalidation path reloads after a file edit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lockfile-memo-'))
  try {
    const file = join(dir, 'pnpm-lock.yaml')
    writeFileSync(file, 'first')
    const memo = createKeyedMemo<string>()
    let loads = 0
    const read = (): string => memo.read(lockfileIdentityKey([file]) + '|tree', () => { loads += 1; return 'facts-' + loads })
    assert.equal(read(), 'facts-1')
    assert.equal(read(), 'facts-1')
    assert.equal(loads, 1)
    writeFileSync(file, 'second-version')
    assert.equal(read(), 'facts-2', 'an edited lockfile must reload the facts')
    assert.equal(loads, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
