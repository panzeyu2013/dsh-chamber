/**
 * POSIX UDS naming for the ssh -L tunnel: path shape, the sockaddr_un length
 * guard, owner-only directory and startup cleanup. Pure fs on a mkdtemp fixture
 * (no ssh process, no network).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SSH_SOCKET_DIR_PREFIX,
  SSH_SOCKET_ID_HASH_CHARS,
  SSH_SOCKET_PATH_MAX_BYTES,
  configureSshSocketNamespace,
  ensureSshSocketDirectory,
  sshSocketDir,
  sshSocketFileName,
  sshSocketPath,
  sshUdsSupported,
} from '../../ssh-socket.ts'

function fixture(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ssh-socket-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('the socket path is <tmpdir>/dsh-chamber-ssh-<uid>/<sha256(id)[0..16]>.sock', (t) => {
  const base = fixture(t)
  const id = 'remote-1'
  const expectedName = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, SSH_SOCKET_ID_HASH_CHARS) + '.sock'
  assert.equal(sshSocketFileName(id), expectedName)
  assert.match(expectedName, /^[0-9a-f]{16}\.sock$/)
  assert.equal(
    sshSocketPath(id, { tmpDir: base, uid: 4242 }),
    join(base, `${SSH_SOCKET_DIR_PREFIX}4242`, expectedName),
  )
  // deterministic, and two ids never share a listener path
  assert.equal(sshSocketPath(id, { tmpDir: base, uid: 4242 }), sshSocketPath(id, { tmpDir: base, uid: 4242 }))
  assert.notEqual(sshSocketFileName('a'), sshSocketFileName('b'))
  assert.equal(sshSocketDir({ tmpDir: base, uid: 4242 }), join(base, `${SSH_SOCKET_DIR_PREFIX}4242`))
})

test('a path over the sockaddr_un budget is refused loudly (never truncated)', (t) => {
  const base = fixture(t)
  const deep = join(base, 'x'.repeat(SSH_SOCKET_PATH_MAX_BYTES))
  mkdirSync(deep, { recursive: true })
  assert.throws(() => sshSocketPath('remote-1', { tmpDir: deep, uid: 1 }), /too long.*sockaddr_un/u)
  // ensureSshSocketDirectory re-checks a path the caller did not derive here
  assert.throws(() => ensureSshSocketDirectory(join(deep, 'a.sock')), /too long/u)
  assert.throws(() => ensureSshSocketDirectory('relative/path.sock'), /absolute/u)
})

test('ensureSshSocketDirectory creates the per-uid directory 0700 and refuses a planted symlink', (t) => {
  const base = fixture(t)
  const path = ensureSshSocketDirectory(sshSocketPath('remote-1', { tmpDir: base, uid: 4242 }))
  assert.equal(statSync(sshSocketDir({ tmpDir: base, uid: 4242 })).mode & 0o777, 0o700)
  assert.equal(lstatSync(sshSocketDir({ tmpDir: base, uid: 4242 })).isDirectory(), true)
  assert.equal(path, sshSocketPath('remote-1', { tmpDir: base, uid: 4242 }))

  const other = fixture(t)
  const planted = join(other, 'target')
  mkdirSync(planted, { recursive: true })
  symlinkSync(planted, sshSocketDir({ tmpDir: other, uid: 4242 }))
  assert.throws(() => ensureSshSocketDirectory(sshSocketPath('remote-1', { tmpDir: other, uid: 4242 })), /symlink|plain directory/u)
})

test('win32 has no UDS shape', () => {
  assert.equal(sshUdsSupported('win32'), false)
  assert.equal(sshUdsSupported('linux'), true)
})

test('the socket directory is namespaced by the runtime root (two roots cannot steal one listener)', (t) => {
  const base = fixture(t)
  try {
    configureSshSocketNamespace('/root/a')
    const a = sshSocketDir({ tmpDir: base, uid: 4242 })
    configureSshSocketNamespace('/root/b')
    const b = sshSocketDir({ tmpDir: base, uid: 4242 })
    assert.notEqual(a, b, 'two roots must not share the per-uid directory')
    configureSshSocketNamespace(null)
    assert.equal(sshSocketDir({ tmpDir: base, uid: 4242 }), join(base, SSH_SOCKET_DIR_PREFIX + '4242'))
  } finally {
    configureSshSocketNamespace(null)
  }
})
