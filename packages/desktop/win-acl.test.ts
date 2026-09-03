/**
 * win-acl unit tests (design 21 M2a): pure argument builders + output
 * verifiers run on every platform; the exec helper is win32-gated and its
 * off-platform refusal is asserted here too. Real icacls behavior is
 * validated on the Windows CI/实机 leg.
 *
 * Run directly: node packages/desktop/win-acl.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyWindowsAclTightening,
  buildIcaclsTightenArgs,
  currentWindowsUserName,
  tightenWindowsAcl,
  verifyIcaclsOutput,
} from './win-acl.ts'

test('buildIcaclsTightenArgs removes inheritance and grants the user full control', () => {
  assert.deepEqual(buildIcaclsTightenArgs('C:\\state\\dir', 'directory', 'alice'), [
    'C:\\state\\dir', '/inheritance:r', '/grant:r', 'alice:(OI)(CI)F',
  ])
  assert.deepEqual(buildIcaclsTightenArgs('C:\\state\\secret.json', 'file', 'alice'), [
    'C:\\state\\secret.json', '/inheritance:r', '/grant:r', 'alice:F',
  ])
})

test('currentWindowsUserName reads USERNAME and fails closed when absent', () => {
  assert.equal(currentWindowsUserName({ USERNAME: 'alice' }), 'alice')
  assert.equal(currentWindowsUserName({ USERNAME: '  alice  ' }), 'alice')
  assert.equal(currentWindowsUserName({}), null)
  assert.equal(currentWindowsUserName({ USERNAME: '' }), null)
})

test('verifyIcaclsOutput accepts a tightened directory or file', () => {
  const dirAcl = [
    'C:\\Users\\alice\\AppData\\Roaming\\dsh-chamber\\state alice:(OI)(CI)F',
  ].join('\r\n')
  assert.deepEqual(verifyIcaclsOutput(dirAcl, 'alice', 'directory'), { ok: true })
  const fileAcl = [
    'C:\\Users\\alice\\AppData\\Roaming\\dsh-chamber\\state\\ssh-passwords.json alice:F',
  ].join('\r\n')
  assert.deepEqual(verifyIcaclsOutput(fileAcl, 'alice', 'file'), { ok: true })
})

test('verifyIcaclsOutput rejects inherited, Everyone/Users/SYSTEM and missing grants', () => {
  const withInherited = [
    'C:\\state\\dir alice:(I)(OI)(CI)F',
  ].join('\r\n')
  assert.deepEqual(verifyIcaclsOutput(withInherited, 'alice', 'directory'), {
    ok: false,
    reason: 'inherited ACE remains after tightening: alice:(I)(OI)(CI)F',
  })
  const withEveryone = [
    'C:\\state\\dir Everyone:(OI)(CI)F',
    'C:\\state\\dir alice:(OI)(CI)F',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(withEveryone, 'alice', 'directory').ok, false)
  const withSystem = [
    'C:\\state\\dir NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    'C:\\state\\dir alice:(OI)(CI)F',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(withSystem, 'alice', 'directory').ok, false)
  const missingUser = [
    'C:\\state\\dir bob:(OI)(CI)F',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(missingUser, 'alice', 'directory').ok, false)
  // A file grant does not satisfy a directory expectation and vice versa.
  assert.equal(verifyIcaclsOutput('C:\\state\\dir alice:F', 'alice', 'directory').ok, false)
  assert.equal(verifyIcaclsOutput('C:\\state\\dir alice:(OI)(CI)F', 'alice', 'file').ok, false)
})

test('applyWindowsAclTightening skips missing targets, collects failures and preserves kinds', () => {
  const calls: Array<{ path: string; kind: 'directory' | 'file' }> = []
  const tighten = ((path: string, kind: 'directory' | 'file') => {
    calls.push({ path, kind })
    return kind === 'file'
      ? { ok: true as const }
      : { ok: false as const, error: 'boom' }
  }) as typeof tightenWindowsAcl
  const errors = applyWindowsAclTightening(
    [
      { path: '/exists/dir', kind: 'directory' },
      { path: '/exists/file', kind: 'file' },
      { path: '/missing/file', kind: 'file' },
    ],
    { tighten, exists: (path: string) => path.startsWith('/exists') },
  )
  assert.deepEqual(errors, ['/exists/dir (directory): boom'])
  assert.deepEqual(calls, [
    { path: '/exists/dir', kind: 'directory' },
    { path: '/exists/file', kind: 'file' },
  ])
})

test('tightenWindowsAcl fails closed off win32', { skip: process.platform === 'win32' }, () => {
  assert.throws(() => tightenWindowsAcl('/tmp/whatever', 'directory'), /win32/)
})

test('verifyIcaclsOutput matches the principal exactly (equality or domain prefix, never substring)', () => {
  assert.deepEqual(verifyIcaclsOutput('C:\\state\\dir alice:(OI)(CI)F', 'alice', 'directory'), { ok: true })
  assert.deepEqual(verifyIcaclsOutput('C:\\state\\dir DESKTOP-X\\alice:(OI)(CI)F', 'alice', 'directory'), { ok: true })
  // A principal whose name merely CONTAINS the user must never satisfy it.
  assert.equal(verifyIcaclsOutput('C:\\state\\dir bobalice:(OI)(CI)F', 'alice', 'directory').ok, false)
  assert.equal(verifyIcaclsOutput('C:\\state\\dir alice-sub:(OI)(CI)F', 'alice', 'directory').ok, false)
})
