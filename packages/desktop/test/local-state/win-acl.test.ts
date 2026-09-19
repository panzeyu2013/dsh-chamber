/**
 * win-acl unit tests (design 21 M2a): pure argument builders + output
 * verifiers run on every platform; the exec helper is win32-gated and its
 * off-platform refusal is asserted here too. Real icacls behavior is
 * validated on the Windows CI/实机 leg.
 *
 * Run directly: node packages/desktop/test/local-state/win-acl.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { userInfo } from 'node:os'
import {
  applyWindowsAclTightening,
  buildIcaclsTightenArgs,
  currentWindowsUserName,
  tightenWindowsAcl,
  verifyIcaclsOutput,
} from '../../win-acl.ts'

test('buildIcaclsTightenArgs removes inheritance and grants the user full control', () => {
  assert.deepEqual(buildIcaclsTightenArgs('C:\\state\\dir', 'directory', 'alice'), [
    'C:\\state\\dir', '/inheritance:r', '/grant:r', 'alice:(OI)(CI)F',
  ])
  assert.deepEqual(buildIcaclsTightenArgs('C:\\state\\secret.json', 'file', 'alice'), [
    'C:\\state\\secret.json', '/inheritance:r', '/grant:r', 'alice:F',
  ])
})

test('currentWindowsUserName prefers the process token over the spoofable USERNAME env', () => {
  // The process token (os.userInfo) is the primary identity source: a parent
  // process can set USERNAME to anything, so the environment may only fill in
  // when the OS lookup is unavailable (the second parameter injects it here).
  assert.equal(currentWindowsUserName({ USERNAME: 'spoofed' }, 'alice'), 'alice')
  assert.equal(currentWindowsUserName({ USERNAME: '  spoofed  ' }, '  alice  '), 'alice')
  assert.equal(currentWindowsUserName({ USERNAME: 'alice' }, ''), 'alice')
  assert.equal(currentWindowsUserName({ USERNAME: '  alice  ' }, null), 'alice')
  assert.equal(currentWindowsUserName({}, null), null)
  assert.equal(currentWindowsUserName({ USERNAME: '' }, null), null)
  // The no-argument call reads this host's own process token first.
  const own = userInfo().username
  if (own.trim() !== '') {
    assert.equal(currentWindowsUserName({ USERNAME: 'spoofed' }), own)
  }
})

test('verifyIcaclsOutput accepts a tightened directory or file (real parenthesized and legacy mask forms)', () => {
  // Real icacls rendering: rights are parenthesized groups, and the object's
  // own line carries the DIRECTORY:/FILE: kind marker.
  const dirAcl = [
    'C:\\Users\\alice\\AppData\\Roaming\\dsh-chamber\\state DIRECTORY:(OI)(CI)(F)',
    'C:\\Users\\alice\\AppData\\Roaming\\dsh-chamber\\state alice:(OI)(CI)(F)',
  ].join('\r\n')
  assert.deepEqual(verifyIcaclsOutput(dirAcl, 'alice', 'directory'), { ok: true })
  const fileAcl = [
    'C:\\Users\\alice\\AppData\\Roaming\\dsh-chamber\\state\\ssh-passwords.json FILE:(F)',
    'C:\\Users\\alice\\AppData\\Roaming\\dsh-chamber\\state\\ssh-passwords.json alice:(F)',
  ].join('\r\n')
  assert.deepEqual(verifyIcaclsOutput(fileAcl, 'alice', 'file'), { ok: true })
  // The /grant-shaped (unparenthesized) legacy rendering stays accepted.
  assert.deepEqual(verifyIcaclsOutput('C:\\state\\dir alice:(OI)(CI)F', 'alice', 'directory'), { ok: true })
  assert.deepEqual(verifyIcaclsOutput('C:\\state\\secret.json alice:F', 'alice', 'file'), { ok: true })
  // A path containing spaces must not pollute the principal token (the bare
  // USERNAME form currentWindowsUserName returns): the ACE tail is anchored
  // on the LAST colon and the token immediately before it.
  const spacedBare = 'C:\\Users\\John Doe\\AppData\\Roaming\\dsh-chamber\\state alice:(OI)(CI)(F)'
  assert.deepEqual(verifyIcaclsOutput(spacedBare, 'alice', 'directory'), { ok: true })
  const spacedDomain = 'C:\\Users\\John Doe\\AppData\\Roaming\\dsh-chamber\\state DESKTOP-X\\alice:(OI)(CI)(F)'
  assert.deepEqual(verifyIcaclsOutput(spacedDomain, 'alice', 'directory'), { ok: true })
  const spacedFile = 'C:\\Users\\John Doe\\AppData\\Roaming\\dsh-chamber\\state\\ssh-passwords.json alice:(F)'
  assert.deepEqual(verifyIcaclsOutput(spacedFile, 'alice', 'file'), { ok: true })
  // A kind-marker line alone proves nothing: DIRECTORY/FILE is not a user
  // principal, so it can never satisfy the check.
  assert.equal(verifyIcaclsOutput('C:\\state\\dir DIRECTORY:(OI)(CI)(F)', 'alice', 'directory').ok, false)
  assert.equal(verifyIcaclsOutput('C:\\state\\secret.json FILE:(F)', 'alice', 'file').ok, false)
})

test('verifyIcaclsOutput rejects inherited, Everyone/Users/SYSTEM and missing grants', () => {
  const withInherited = [
    'C:\\state\\dir alice:(I)(OI)(CI)(F)',
  ].join('\r\n')
  assert.deepEqual(verifyIcaclsOutput(withInherited, 'alice', 'directory'), {
    ok: false,
    reason: 'inherited ACE remains after tightening: alice:(I)(OI)(CI)(F)',
  })
  // The legacy bare mask carries its (I) group too.
  assert.equal(verifyIcaclsOutput('C:\\state\\dir alice:(I)(OI)(CI)F', 'alice', 'directory').ok, false)
  const withEveryone = [
    'C:\\state\\dir Everyone:(OI)(CI)(F)',
    'C:\\state\\dir alice:(OI)(CI)(F)',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(withEveryone, 'alice', 'directory').ok, false)
  const withUsers = [
    'C:\\state\\dir BUILTIN\\Users:(OI)(CI)(F)',
    'C:\\state\\dir alice:(OI)(CI)(F)',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(withUsers, 'alice', 'directory').ok, false)
  const withSystem = [
    'C:\\state\\dir NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    'C:\\state\\dir alice:(OI)(CI)(F)',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(withSystem, 'alice', 'directory').ok, false)
  // Spaced paths must not smuggle a well-known principal past the check.
  const spacedEveryone = [
    'C:\\Users\\John Doe\\AppData\\Roaming\\dsh-chamber\\state Everyone:(OI)(CI)(F)',
    'C:\\Users\\John Doe\\AppData\\Roaming\\dsh-chamber\\state alice:(OI)(CI)(F)',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(spacedEveryone, 'alice', 'directory').ok, false)
  const missingUser = [
    'C:\\state\\dir bob:(OI)(CI)(F)',
  ].join('\r\n')
  assert.equal(verifyIcaclsOutput(missingUser, 'alice', 'directory').ok, false)
  // A file grant does not satisfy a directory expectation and vice versa.
  assert.equal(verifyIcaclsOutput('C:\\state\\dir alice:(F)', 'alice', 'directory').ok, false)
  assert.equal(verifyIcaclsOutput('C:\\state\\dir alice:(OI)(CI)(F)', 'alice', 'file').ok, false)
})

test('verifyIcaclsOutput is a USER allowlist: any foreign principal or DENY ACE fails (2026-12 audit P1)', () => {
  // The old check was a three-name blacklist, so an ACL whose only extra
  // principal was another well-known group still returned {ok:true} — and the
  // verify-first probe then skipped tightening entirely. Every non-user
  // principal must now fail, even beside the user's own full-control grant.
  const foreign = [
    'C:\\state\\dir NT AUTHORITY\\Authenticated Users:(OI)(CI)(M)',
    'C:\\state\\dir NT AUTHORITY\\INTERACTIVE:(OI)(CI)(M)',
    'C:\\state\\dir CREATOR OWNER:(OI)(CI)(IO)(F)',
    'C:\\state\\dir Everyone:(OI)(CI)(F)',
    'C:\\state\\dir BUILTIN\\Users:(OI)(CI)(F)',
    'C:\\state\\dir NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    'C:\\state\\dir bob:(OI)(CI)(F)',
  ]
  for (const acl of foreign) {
    const verdict = verifyIcaclsOutput(
      [acl, 'C:\\state\\dir alice:(OI)(CI)(F)'].join('\r\n'), 'alice', 'directory')
    assert.equal(verdict.ok, false, `foreign principal must fail the allowlist: ${acl}`)
    if (!verdict.ok) assert.match(verdict.reason, /foreign principal/)
  }
  // A DENY ACE is not a grant: the user's own (DENY) ACE used to pass because
  // the parser only looked for the (F) token.
  const denied = verifyIcaclsOutput('C:\\state\\dir alice:(DENY)(OI)(CI)(F)', 'alice', 'directory')
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.match(denied.reason, /deny ACE/)
  assert.equal(verifyIcaclsOutput('C:\\state\\secret.json alice:(DENY)(F)', 'alice', 'file').ok, false)
  // A correctly tightened user-only directory/file stays accepted.
  assert.deepEqual(verifyIcaclsOutput([
    'C:\\Users\\John Doe\\AppData\\Roaming\\dsh-chamber\\state DIRECTORY:(OI)(CI)(F)',
    'C:\\Users\\John Doe\\AppData\\Roaming\\dsh-chamber\\state alice:(OI)(CI)(F)',
  ].join('\r\n'), 'alice', 'directory'), { ok: true })
  assert.deepEqual(verifyIcaclsOutput([
    'C:\\state\\secret.json FILE:(F)',
    'C:\\state\\secret.json alice:(F)',
  ].join('\r\n'), 'alice', 'file'), { ok: true })
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
  assert.deepEqual(verifyIcaclsOutput('C:\\state\\dir alice:(OI)(CI)(F)', 'alice', 'directory'), { ok: true })
  assert.deepEqual(verifyIcaclsOutput('C:\\state\\dir DESKTOP-X\\alice:(OI)(CI)(F)', 'alice', 'directory'), { ok: true })
  // Domain-prefixed principals are case-insensitive like the bare form.
  assert.equal(verifyIcaclsOutput('C:\\state\\dir DESKTOP-X\\ALICE:(OI)(CI)(F)', 'alice', 'directory').ok, true)
  // A principal whose name merely CONTAINS the user must never satisfy it.
  assert.equal(verifyIcaclsOutput('C:\\state\\dir bobalice:(OI)(CI)(F)', 'alice', 'directory').ok, false)
  assert.equal(verifyIcaclsOutput('C:\\state\\dir alice-sub:(OI)(CI)(F)', 'alice', 'directory').ok, false)
  assert.equal(verifyIcaclsOutput('C:\\state\\dir xalice:(OI)(CI)(F)', 'alice', 'directory').ok, false)
  // A path fragment ending in the user name is not a principal either.
  assert.equal(verifyIcaclsOutput('C:\\Users\\alice\\state bob:(OI)(CI)(F)', 'alice', 'directory').ok, false)
})
