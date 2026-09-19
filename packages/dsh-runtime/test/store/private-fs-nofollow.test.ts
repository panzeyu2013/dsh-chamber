/**
 * Platform no-follow strategy unit tests (S1 / D3+D4). POSIX must keep the
 * historical O_NOFOLLOW/O_DIRECTORY flags byte-for-byte; a host whose constants
 * lack O_NOFOLLOW (win32) must resolve portable flags instead of throwing,
 * while the shared open helper still refuses a symlinked final component
 * through lstat identity checks immediately before and after the open. Both
 * branches run on every host through the injectable constants seam.
 *
 * Run directly: node packages/dsh-runtime/test/store/private-fs-nofollow.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeSync, constants, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openPrivateNoFollowSync,
  resolveNoFollowFlags,
  type NoFollowConstantsLike,
} from '../../src/private-fs.ts'

const P_READ = 0
const P_WRITE = 1
const P_CREAT = 64
const P_EXCL = 128
const P_DIRECTORY = 65536
const P_NOFOLLOW = 131072

/** POSIX shape: the flags are present whatever this host's token values are —
 *  the pure flag arithmetic is what is under test. */
const POSIX_CONSTANTS: NoFollowConstantsLike = {
  O_RDONLY: P_READ,
  O_WRONLY: P_WRITE,
  O_CREAT: P_CREAT,
  O_EXCL: P_EXCL,
  O_NOFOLLOW: P_NOFOLLOW,
  O_DIRECTORY: P_DIRECTORY,
}

/** Windows shape: create/read flags exist, O_NOFOLLOW/O_DIRECTORY do not. */
const FALLBACK_CONSTANTS: NoFollowConstantsLike = {
  O_RDONLY: constants.O_RDONLY,
  O_WRONLY: constants.O_WRONLY,
  O_CREAT: constants.O_CREAT,
  O_EXCL: constants.O_EXCL,
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-private-nofollow-'))
}

test('resolveNoFollowFlags keeps the POSIX O_NOFOLLOW/O_DIRECTORY flags exactly', () => {
  assert.deepEqual(resolveNoFollowFlags('read', POSIX_CONSTANTS), {
    flags: P_READ | P_NOFOLLOW,
    kernelNoFollow: true,
  })
  assert.deepEqual(resolveNoFollowFlags('directory', POSIX_CONSTANTS), {
    flags: P_READ | P_DIRECTORY | P_NOFOLLOW,
    kernelNoFollow: true,
  })
  assert.deepEqual(resolveNoFollowFlags('write', POSIX_CONSTANTS), {
    flags: P_WRITE | P_CREAT | P_EXCL | P_NOFOLLOW,
    kernelNoFollow: true,
  })
})

test('resolveNoFollowFlags falls back without throwing when O_NOFOLLOW is absent', () => {
  assert.deepEqual(resolveNoFollowFlags('read', FALLBACK_CONSTANTS), {
    flags: constants.O_RDONLY,
    kernelNoFollow: false,
  })
  assert.deepEqual(resolveNoFollowFlags('directory', FALLBACK_CONSTANTS), {
    flags: constants.O_RDONLY,
    kernelNoFollow: false,
  })
  assert.deepEqual(resolveNoFollowFlags('write', FALLBACK_CONSTANTS), {
    flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    kernelNoFollow: false,
  })
  // A completely empty constants table still resolves (never throws) and
  // degrades to flag 0 with the user-space identity proof required.
  assert.deepEqual(resolveNoFollowFlags('read', {}), { flags: 0, kernelNoFollow: false })
  assert.deepEqual(resolveNoFollowFlags('write', {}), { flags: 0, kernelNoFollow: false })
})

test('the fallback open refuses a symlinked final FILE component before opening it', () => {
  const dir = makeTempDir()
  const target = join(dir, 'target.txt')
  writeFileSync(target, 'secret')
  const link = join(dir, 'link.txt')
  symlinkSync(target, link)
  assert.throws(
    () => openPrivateNoFollowSync(link, 'read', { constantsLike: FALLBACK_CONSTANTS }),
    /符号链接/,
  )
  // The target was never reached through the link; a direct open still works.
  const opened = openPrivateNoFollowSync(target, 'read', { constantsLike: FALLBACK_CONSTANTS })
  try {
    assert.equal(opened.stats.isFile(), true)
  } finally {
    closeSync(opened.fd)
  }
})

test('the fallback open refuses a symlinked final DIRECTORY component', () => {
  const dir = makeTempDir()
  const real = join(dir, 'real-dir')
  mkdirSync(real)
  const link = join(dir, 'link-dir')
  symlinkSync(real, link, 'dir')
  assert.throws(
    () => openPrivateNoFollowSync(link, 'directory', { constantsLike: FALLBACK_CONSTANTS }),
    /符号链接/,
  )
  const opened = openPrivateNoFollowSync(real, 'directory', { constantsLike: FALLBACK_CONSTANTS })
  try {
    assert.equal(opened.stats.isDirectory(), true)
  } finally {
    closeSync(opened.fd)
  }
})

test('the fallback write open creates a fresh exclusive leaf and keeps the raw EEXIST signal', () => {
  const dir = makeTempDir()
  const target = join(dir, 'fresh.txt')
  const created = openPrivateNoFollowSync(target, 'write', { constantsLike: FALLBACK_CONSTANTS })
  try {
    assert.equal(created.stats.isFile(), true)
    // POSIX mode-bit semantics only: win32 fstat synthesizes 0o666 for any
    // writable file (libuv sets 0666 unless the READONLY attribute is set), so
    // the created mode is not observable there. The O_EXCL assertion below
    // still runs on every platform — it is the fallback freshness proof.
    if (process.platform !== 'win32') {
      assert.equal(created.stats.mode & 0o777, 0o600)
    }
  } finally {
    closeSync(created.fd)
  }
  // O_EXCL is the fallback freshness proof: an existing leaf (a symlink
  // included) fails with the raw contention signal, never a follow.
  assert.throws(
    () => openPrivateNoFollowSync(target, 'write', { constantsLike: FALLBACK_CONSTANTS }),
    /EEXIST/,
  )
})

test('the POSIX flags make open(2) itself refuse a symlinked final component', {
  skip: process.platform === 'win32' ? 'O_NOFOLLOW is a POSIX constant' : false,
}, () => {
  const dir = makeTempDir()
  const target = join(dir, 'target.txt')
  writeFileSync(target, 'x')
  const link = join(dir, 'link.txt')
  symlinkSync(target, link)
  assert.throws(() => openPrivateNoFollowSync(link, 'read'), /ELOOP/)
})
