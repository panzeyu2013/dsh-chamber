/**
 * ssh provider password-auth unit tests (design 05 §8) — part 1: the in-memory password store, the
 * ephemeral askpass helper script (single-quote escaping, host-key yes answers, executable 0700
 * file, dispose cleanup) and password persistence. Pure-Node: the helper is executed against
 * ssh-style prompts. Sibling parts: ssh-provider-exec.test.ts (remote argv/run channel),
 * ssh-provider-endpoint-auth.test.ts (probeDshSignature / verifyUp auth).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { acquireSshAuthLease, buildAskpassScript, chmodAskpassDirOwnerOnly, configureSshPasswordStore, cleanupStaleAskpassHelpers, createAskpassHelper, disposeSshAuth, purgeSshAuth, getSshPassword, setSshPassword, sshPasswordSupported, sshProvider, MAX_SSH_PASSWORD_CHARS } from '../../ssh-provider.ts'
import type { TransportInstanceSpec } from '../../transport-provider.ts'
import { sshCredentialBinding } from '../../credential-binding.ts'
import { runDeps, spec } from '../support/ssh-provider-run-deps.ts'
test('buildAskpassScript escapes single quotes and keeps password/passphrase prompts apart from host-key confirmations', () => {
  const script = buildAskpassScript("it's-a-pass'word")
  // The password must be embedded sh-safely: every ' becomes '\'' so the
  // literal value survives the shell.
  assert.ok(script.includes(`printf '%s\\n' 'it'\\''s-a-pass'\\''word'`), 'single quotes are escaped for sh')
  // The host-key confirmation branch must answer yes, never the password.
  assert.ok(script.includes('*"yes/no"*'), 'host-key yes/no prompts are matched')
  assert.ok(script.includes('echo yes'), 'host-key prompts answer yes')
  assert.ok(!script.includes("it's-a-pass"), 'the raw password never appears in the host-key branch')
})
test('the askpass helper answers host-key prompts with yes and password prompts with the password', () => {
  // A restrictive umask must not strip the execute bit OpenSSH requires.
  const previousUmask = process.umask(0o177)
  let path: string
  try {
    path = createAskpassHelper('t-askpass-1', "s3cr't")
  } finally {
    process.umask(previousUmask)
  }
  try {
    const hostKey = spawnSync(path, ['Are you sure you want to continue connecting (yes/no/[fingerprint])?'], { encoding: 'utf8' })
    assert.equal(hostKey.status, 0)
    assert.equal(hostKey.stdout.trim(), 'yes', 'host-key confirmation is accepted (first connect)')
    const password = spawnSync(path, ["user@h.example.com's password:"], { encoding: 'utf8' })
    assert.equal(password.status, 0)
    assert.equal(password.stdout, "s3cr't\n", 'password prompt answers the stored password (line-terminated)')
    const passphrase = spawnSync(path, ["Enter passphrase for key '/Users/x/.ssh/id_ed25519':"], { encoding: 'utf8' })
    assert.equal(passphrase.stdout, "s3cr't\n", 'key passphrase prompts reuse the stored password')
    // "Password for <user>:" (no colon right after "password")
    // is a REAL password prompt and must receive the password.
    const passwordFor = spawnSync(path, ['Password for user@h.example.com:'], { encoding: 'utf8' })
    assert.equal(passwordFor.stdout, "s3cr't\n", 'Password for <user>: prompts answer the stored password')
    // Fail-closed: a prompt that is NOT provably a host-key or
    // password prompt (OTP/verification code, password change) gets NO
    // answer — the stored password must never leave the helper for it.
    const otp = spawnSync(path, ['Verification code:'], { encoding: 'utf8' })
    assert.equal(otp.status, 0)
    assert.equal(otp.stdout, '', 'fail-closed: a non-credential prompt receives no answer')
    assert.ok(!otp.stdout.includes("s3cr't"), 'fail-closed: the password never reaches an OTP prompt')
    // OTP wording that ALSO contains "assword:"
    // must still fail closed (explicit exclusion branch, not the password one).
    const otpWording = spawnSync(path, ['One-time password:'], { encoding: 'utf8' })
    assert.equal(otpWording.stdout, '', 'fail-closed: "One-time password:" receives no answer')
    const change = spawnSync(path, ['Enter new password:'], { encoding: 'utf8' })
    assert.equal(change.stdout, '', 'fail-closed: a password-change prompt receives no answer')
    // The prompt is normalized to lowercase before matching, so ANY casing
    // variant behaves identically (an unnormalized match would leak the
    // password for "One-time Password:").
    const mixedCase = spawnSync(path, ['One-time Password:'], { encoding: 'utf8' })
    assert.equal(mixedCase.stdout, '', 'fail-closed: "One-time Password:" (mixed case) receives no answer')
    const upperCase = spawnSync(path, ['ONE-TIME PASSWORD:'], { encoding: 'utf8' })
    assert.equal(upperCase.stdout, '', 'fail-closed: "ONE-TIME PASSWORD:" receives no answer')
    const newPasswordUpper = spawnSync(path, ['Enter New Password:'], { encoding: 'utf8' })
    assert.equal(newPasswordUpper.stdout, '', 'fail-closed: "Enter New Password:" receives no answer')
    const changeUpper = spawnSync(path, ['Please change your password:'], { encoding: 'utf8' })
    assert.equal(changeUpper.stdout, '', 'fail-closed: a change-password prompt receives no answer')
    // All-caps REAL password prompts now work too (normalized positive match).
    const capsPassword = spawnSync(path, ['PASSWORD:'], { encoding: 'utf8' })
    assert.equal(capsPassword.stdout, "s3cr't\n", 'an all-caps password prompt still answers the password')
    const capsPasswordFor = spawnSync(path, ['PASSWORD for user@h.example.com:'], { encoding: 'utf8' })
    assert.equal(capsPasswordFor.stdout, "s3cr't\n", 'an all-caps "Password for <user>:" prompt still answers')
    // Boundary: an "otp"-named host/user must NOT trip the otp exclusion.
    const otpHost = spawnSync(path, ["user@otp-host's password:"], { encoding: 'utf8' })
    assert.equal(otpHost.stdout, "s3cr't\n", 'a host named "otp-host" still answers a real password prompt')
    // OpenSSH runs SSH_ASKPASS directly: it must be executable but stay owner-only.
    assert.equal(statSync(path).mode & 0o777, 0o700, 'helper is executable and owner-only')
    const helperDir = dirname(path)
    assert.notEqual(helperDir, join(tmpdir(), 'dsh-chamber-ssh'), 'the historical globally pre-claimable directory is never used')
    assert.match(helperDir, new RegExp(`dsh-chamber-ssh-${process.pid}-[^/\\\\]+$`), 'the helper lives in an unguessable process-private leaf')
    assert.equal(statSync(helperDir).mode & 0o777, 0o700, 'the process-private leaf is owner-only')
    if (typeof process.getuid === 'function') {
      assert.equal(statSync(helperDir).uid, process.getuid(), 'the current OS user owns the helper directory')
    }
  } finally {
    rmSync(path, { force: true })
  }
})
test('createAskpassHelper refuses instance ids outside the registry whitelist', () => {
  assert.throws(() => createAskpassHelper('bad/id', 'pw'), /invalid instance id/)
  assert.throws(() => createAskpassHelper('../escape', 'pw'), /invalid instance id/)
})
test('startup cleanup preserves helpers owned by this live process', () => {
  const path = createAskpassHelper('t-live-owner', 'pw')
  try {
    assert.equal(cleanupStaleAskpassHelpers(), null)
    assert.equal(existsSync(path), true)
  } finally {
    rmSync(path, { force: true })
  }
})
test('askpass directory gate tightens an owned directory and fails closed on an untrusted path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-askpass-mode-test-'))
  try {
    chmodSync(dir, 0o777)
    chmodAskpassDirOwnerOnly(dir)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    // A file/symlink/non-owned directory can never be downgraded to a warning:
    // createAskpassHelper would execute password-bearing code from this path.
    assert.throws(() => chmodAskpassDirOwnerOnly('/dev/null'), /private directory|owned by uid|EPERM/)
    assert.throws(() => chmodAskpassDirOwnerOnly(join(process.cwd(), 'definitely-missing-askpass-dir')), /ENOENT|ENOTDIR/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('setSshPassword/getSshPassword round-trip and clear (empty string and null both clear)', () => {
  const owner = spec('t-store-1')
  setSshPassword(owner, 'pw')
  assert.equal(getSshPassword(owner), 'pw')
  setSshPassword(owner, '')
  assert.equal(getSshPassword(owner), null, "'' clears")
  setSshPassword(owner, 'pw2')
  setSshPassword(owner, null)
  assert.equal(getSshPassword(owner), null, 'null clears')
})
test('acquireSshAuthLease returns a child-scoped askpass env only when a password is stored', () => {
  const owner = spec('t-env-1')
  setSshPassword(owner, 'pw')
  let lease: ReturnType<typeof acquireSshAuthLease> = null
  try {
    lease = acquireSshAuthLease(spec('t-env-1'))
    assert.ok(lease !== null, 'a stored password yields an askpass lease')
    assert.equal(lease.env.SSH_ASKPASS_REQUIRE, 'force', 'askpass is forced (no TTY needed)')
    assert.ok(typeof lease.env.SSH_ASKPASS === 'string' && lease.env.SSH_ASKPASS.length > 0)
    const path = lease.env.SSH_ASKPASS
    assert.ok(existsSync(path), 'the helper exists before the spawn')
    assert.equal(acquireSshAuthLease(spec('t-env-2')), null, 'no stored password = key/agent auth (null lease)')
    lease.release()
    assert.ok(!existsSync(path), 'child lease release removes its helper')
    lease.release()
    assert.ok(!existsSync(path), 'release is idempotent')
  } finally {
    lease?.release()
    setSshPassword(owner, null)
    purgeSshAuth(owner.id)
    purgeSshAuth('t-env-2')
  }
})
test('every askpass spawn requires the exact persisted host/user/sshPort owner', () => {
  const owner = spec('t-owner-bound')
  setSshPassword(owner, 'pw')
  let exactLease: ReturnType<typeof acquireSshAuthLease> = null
  try {
    exactLease = acquireSshAuthLease(owner)
    assert.ok(exactLease !== null, 'the exact owner receives an askpass helper')
    for (const changed of [
      { ...owner, host: 'attacker.example.com' },
      { ...owner, user: 'other-user' },
      { ...owner, sshPort: 2222 },
    ]) {
      assert.equal(getSshPassword(changed), null)
      assert.equal(acquireSshAuthLease(changed), null, 'a same-id endpoint edit cannot receive the old password')
    }
    const nonAuthenticationEdit: TransportInstanceSpec = {
      ...owner,
      label: 'renamed',
      remotePort: 4080,
      serviceName: 'other.service',
      remoteDshHome: '/srv/dsh',
    }
    assert.equal(getSshPassword(nonAuthenticationEdit), 'pw', 'non-authentication metadata is outside password ownership')
  } finally {
    exactLease?.release()
    setSshPassword(owner, null)
    purgeSshAuth(owner.id)
  }
})
test('dispose/purge never delete a helper before its child lease releases', () => {
  const owner = spec('t-env-3')
  setSshPassword(owner, 'pw')
  let lease: ReturnType<typeof acquireSshAuthLease> = null
  try {
    lease = acquireSshAuthLease(owner)
    assert.ok(lease !== null && lease.env.SSH_ASKPASS !== undefined)
    const path = lease.env.SSH_ASKPASS
    assert.ok(existsSync(path))
    disposeSshAuth(owner)
    assert.ok(existsSync(path), 'plain disconnect keeps the in-flight child helper')
    assert.equal(statSync(path).mode & 0o777, 0o700, 'the retained helper stays owner-executable')
    setSshPassword(owner, null)
    assert.equal(getSshPassword(owner), null, 'explicit clear blocks every future password-backed spawn')
    assert.equal(acquireSshAuthLease(owner), null)
    assert.ok(existsSync(path), 'explicit password clear cannot invalidate the already-live child path')
    purgeSshAuth('t-env-3')
    assert.ok(existsSync(path), 'instance removal still cannot invalidate a live child path')
    lease.release()
    assert.ok(!existsSync(path), 'the helper is removed exactly when the child lease releases')
  } finally {
    lease?.release()
    setSshPassword(owner, null)
    purgeSshAuth(owner.id)
  }
})
test('more than five concurrent askpass generations stay alive and clean up by child lifecycle', () => {
  // A fixed cap would delete the tunnel helper once enough concurrent
  // systemd/run children create newer generations.
  const owner = spec('t-env-4')
  setSshPassword(owner, 'pw')
  const leases: NonNullable<ReturnType<typeof acquireSshAuthLease>>[] = []
  try {
    for (let i = 0; i < 7; i += 1) {
      const lease = acquireSshAuthLease(owner)
      assert.ok(lease !== null)
      leases.push(lease)
    }
    const paths = leases.map(lease => lease.env.SSH_ASKPASS!)
    assert.equal(new Set(paths).size, 7, 'each child gets a fresh password generation')
    assert.ok(paths.every(path => existsSync(path)), 'tunnel + six concurrent exec generations all survive')
    disposeSshAuth(owner)
    purgeSshAuth(owner.id)
    assert.ok(paths.every(path => existsSync(path)), 'dispose/purge cannot delete any live child helper')
    for (let i = 0; i < leases.length; i += 1) {
      leases[i].release()
      assert.ok(!existsSync(paths[i]), `exited child ${i + 1} cleans its own helper`)
      assert.ok(paths.slice(i + 1).every(path => existsSync(path)), 'other live children keep their helpers')
    }
    assert.ok(paths.every(path => !existsSync(path)), 'all child exits leave no helper residue')
  } finally {
    for (const lease of leases) lease.release()
    setSshPassword(owner, null)
    purgeSshAuth(owner.id)
  }
})
test('a synchronous exec spawn failure releases its freshly-created askpass helper', async () => {
  configureSshPasswordStore(null)
  const execSpec = { ...spec('t-env-spawn-fail'), serviceName: 'dsh-chamber' }
  setSshPassword(execSpec, 'pw')
  let helperPath: string | null = null
  try {
    const result = await sshProvider.exec!(execSpec, 'start', runDeps((_command, _args, options) => {
      helperPath = typeof options.env?.SSH_ASKPASS === 'string' ? options.env.SSH_ASKPASS : null
      throw new Error('synthetic spawn failure')
    }))
    assert.equal(result.ok, false)
    assert.ok(helperPath !== null, 'the lease was acquired before spawn')
    assert.ok(!existsSync(helperPath), 'failed spawn releases the helper immediately')
  } finally {
    setSshPassword(execSpec, null)
    purgeSshAuth(execSpec.id)
  }
})
test('sshPasswordSupported is false on win32 (askpass unreliability gate)', () => {
  assert.equal(sshPasswordSupported(), process.platform !== 'win32')
})
test('configureSshPasswordStore persists to and reloads from the plaintext file (0600, atomic)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    assert.equal(configureSshPasswordStore(file), null, 'missing file = first run, no notice')
    const firstOwner = spec('t-file-1')
    const secondOwner = { ...spec('t-file-2'), host: 'second.example.com', user: null, sshPort: 2222 }
    setSshPassword(firstOwner, 'pw-1')
    setSshPassword(secondOwner, 'pw-2')
    assert.ok(existsSync(file), 'file is written on the first set')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'password file is 0600')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      schemaVersion: number
      passwords: Record<string, string>
      bindings: Record<string, string>
    }
    assert.equal(parsed.schemaVersion, 2)
    assert.equal(parsed.passwords['t-file-1'], 'pw-1')
    assert.equal(parsed.passwords['t-file-2'], 'pw-2')
    assert.equal(parsed.bindings['t-file-1'], sshCredentialBinding(firstOwner))
    assert.equal(parsed.bindings['t-file-2'], sshCredentialBinding(secondOwner))
    // Simulate a restart: reconfigure away (clears the memory map), reload.
    configureSshPasswordStore(null)
    assert.equal(getSshPassword(firstOwner), null, 'memory cleared by reconfiguration')
    assert.equal(configureSshPasswordStore(file), null, 'reload is clean')
    assert.equal(getSshPassword(firstOwner), 'pw-1', 'password survives a restart via the file')
    assert.equal(getSshPassword(secondOwner), 'pw-2')
    assert.equal(acquireSshAuthLease({ ...firstOwner, host: 'new-endpoint.example.com' }), null,
      'a registry/password crash split fails closed after restart instead of redirecting the old secret')
    // Explicit clear removes the entry from the file too.
    setSshPassword(firstOwner, null)
    const afterClear = JSON.parse(readFileSync(file, 'utf8')) as { passwords: Record<string, unknown> }
    assert.equal(afterClear.passwords['t-file-1'], undefined, 'cleared entry leaves the file')
    assert.equal(afterClear.passwords['t-file-2'], parsed.passwords['t-file-2'], 'other entries stay')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('password-store load tightens a broad mode before reading owner-bound secrets', t => {
  if (process.platform === 'win32') { t.skip('POSIX permission contract'); return }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      passwords: { 't-owner-mode': 'pw' },
      bindings: { 't-owner-mode': sshCredentialBinding(spec('t-owner-mode')) },
    }))
    chmodSync(file, 0o644)
    assert.equal(configureSshPasswordStore(file), null)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(getSshPassword(spec('t-owner-mode')), 'pw')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('an old-schema password file is preserved as corrupt and never auto-bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, passwords: { 't-v1': 'pw' } }), { mode: 0o600 })
    const notice = configureSshPasswordStore(file)
    assert.ok(notice !== null && notice.includes('.corrupt'), 'old-schema file is preserved for forensics')
    assert.equal(getSshPassword(spec('t-v1')), null, 'an old secret is never guessed onto the current registry')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('password-store load refuses symlinks instead of following them', t => {
  if (process.platform === 'win32') { t.skip('POSIX permission contract'); return }
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const target = join(dir, 'target.json')
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(target, JSON.stringify({
      schemaVersion: 2,
      passwords: { 't-symlink': 'pw' },
      bindings: { 't-symlink': sshCredentialBinding(spec('t-symlink')) },
    }), { mode: 0o600 })
    symlinkSync(target, file)
    assert.match(configureSshPasswordStore(file) ?? '', /cannot read|non-regular/)
    assert.equal(getSshPassword(spec('t-symlink')), null)
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SSH password binding fails closed across the secret-fsync → registry-fsync crash window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-binding-'))
  const file = join(dir, 'ssh-passwords.json')
  const oldSpec = spec('crash-ssh')
  const newSpec = { ...oldSpec, host: 'new.example.com', user: 'new-user', sshPort: 2222 }
  let current: TransportInstanceSpec | null = oldSpec
  try {
    configureSshPasswordStore(file, () => current)
    setSshPassword(oldSpec.id, 'new-target-password', newSpec)
    assert.equal(getSshPassword(oldSpec.id), null, 'new-target secret is invisible while old registry metadata remains')
    configureSshPasswordStore(null)
    configureSshPasswordStore(file, () => current)
    assert.equal(getSshPassword(oldSpec.id), null, 'restart after the crash remains fail-closed')
    current = newSpec
    assert.equal(getSshPassword(oldSpec.id), 'new-target-password', 'the binding becomes visible only under its exact SSH endpoint')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('SSH password load tightens an existing regular file before reading and refuses symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-load-mode-'))
  const file = join(dir, 'ssh-passwords.json')
  const target = join(dir, 'target.json')
  const link = join(dir, 'linked-passwords.json')
  const payload = JSON.stringify({
    schemaVersion: 2,
    passwords: { 'load-mode': 'pw' },
    bindings: { 'load-mode': sshCredentialBinding(spec('load-mode')) },
  })
  try {
    writeFileSync(file, payload, { mode: 0o644 })
    chmodSync(file, 0o644)
    assert.equal(configureSshPasswordStore(file, id => spec(id)), null)
    assert.equal(statSync(file).mode & 0o777, 0o600, 'mode is tightened before the password enters memory')
    assert.equal(getSshPassword('load-mode'), 'pw')

    // Creating symlinks is privilege-gated on many Windows installations.
    // Keep the load-mode regression portable while exercising the concrete
    // link refusal wherever CI can create one.
    if (process.platform !== 'win32') {
      writeFileSync(target, payload, { mode: 0o644 })
      symlinkSync(target, link)
      const notice = configureSshPasswordStore(link)
      assert.match(notice ?? '', /cannot read|regular file|symlink/)
      assert.equal(getSshPassword('load-mode'), null, 'a symlink target is never adopted as the live password store')
      assert.equal(statSync(target).mode & 0o777, 0o644)
    }
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('password persistence tightens a pre-existing plaintext tmp file before replacing the store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  const tmp = `${file}.tmp`
  try {
    configureSshPasswordStore(file, id => spec(id))
    writeFileSync(tmp, 'stale plaintext')
    chmodSync(tmp, 0o644)
    setSshPassword(spec('t-mode'), 'pw')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'renamed password file is owner-only even when tmp existed as 0644')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('a corrupt password file is preserved as *.corrupt and fails loud, never silent-empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(file, '{not json')
    const notice = configureSshPasswordStore(file)
    assert.ok(notice !== null && notice.includes('.corrupt'), 'corrupt file reports loudly')
    assert.ok(existsSync(`${file}.corrupt`), 'corrupt file is preserved for forensics')
    assert.equal(getSshPassword(spec('anything')), null, 'store starts empty after a corrupt file')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('a syntactically valid password file with an invalid schema is preserved and rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      passwords: {
        local: { password: 'pw', host: 'h.example.com', user: 'u', sshPort: null },
        'bad/id': { password: 'pw', host: 'h.example.com', user: 'u', sshPort: null },
        valid: 42,
      },
    }))
    const notice = configureSshPasswordStore(file)
    assert.ok(notice !== null && notice.includes('invalid password file'), 'invalid schema reports loudly')
    assert.ok(existsSync(`${file}.corrupt`), 'invalid file is preserved for forensics')
    assert.equal(getSshPassword(spec('valid')), null, 'no partial entries are published')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('password persistence failure rolls back memory and removes the plaintext tmp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  let helper: string | null = null
  let secondHelper: string | null = null
  let firstLease: ReturnType<typeof acquireSshAuthLease> = null
  let secondLease: ReturnType<typeof acquireSshAuthLease> = null
  try {
    configureSshPasswordStore(file)
    const firstOwner = spec('t-rollback')
    const secondOwner = spec('t-rollback-2')
    setSshPassword(firstOwner, 'old')
    setSshPassword(secondOwner, 'old-2')
    firstLease = acquireSshAuthLease(firstOwner)
    secondLease = acquireSshAuthLease(secondOwner)
    helper = firstLease?.env.SSH_ASKPASS ?? null
    secondHelper = secondLease?.env.SSH_ASKPASS ?? null
    assert.ok(helper !== null && existsSync(helper), 'old committed auth helper exists')
    assert.ok(secondHelper !== null && existsSync(secondHelper), 'second committed auth helper exists')
    // Replacing the target file with a directory makes the final atomic rename
    // fail after the tmp payload was written, deterministically across CI.
    rmSync(file)
    mkdirSync(file)
    assert.throws(() => setSshPassword(firstOwner, 'new'))
    assert.equal(getSshPassword(firstOwner), 'old', 'failed update does not publish new memory state')
    assert.equal(existsSync(`${file}.tmp`), false, 'failed update leaves no extra plaintext tmp')
    assert.equal(getSshPassword(secondOwner), 'old-2', 'a failed write leaves unrelated live auth state untouched')
    assert.equal(existsSync(helper!), true, 'failed write preserves the helper used by an in-flight ssh child')
    assert.equal(existsSync(secondHelper!), true, 'failed write preserves unrelated child leases')
    firstLease?.release()
    secondLease?.release()
  } finally {
    firstLease?.release()
    secondLease?.release()
    disposeSshAuth(spec('t-rollback'))
    disposeSshAuth(spec('t-rollback-2'))
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('clearing an id with no stored password is a true no-op even when the store is unwritable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    configureSshPasswordStore(file)
    const keptOwner = spec('t-kept')
    setSshPassword(keptOwner, 'old')
    rmSync(file)
    mkdirSync(file)
    assert.doesNotThrow(() => setSshPassword('t-never-stored', null))
    assert.equal(getSshPassword(keptOwner), 'old')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
test('setSshPassword refuses reserved ids; provider validation rejects malformed authentication owners', () => {
  assert.throws(() => setSshPassword(spec('local'), 'pw'), /invalid instance id/)
  assert.throws(() => setSshPassword(spec('../escape'), 'pw'), /invalid instance id/)
  assert.equal(sshProvider.validateSpec({ ...spec('valid-owner'), host: '-oProxyCommand=evil' }), null)
})
test('password and instance metadata limits are enforced in the provider', () => {
  assert.throws(() => setSshPassword(spec('t-too-long'), 'x'.repeat(MAX_SSH_PASSWORD_CHARS + 1)), /longer/)
  assert.equal(sshProvider.validateSpec({ id: 'x'.repeat(65), label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'valid', label: 'x'.repeat(129), kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'valid', label: 'h', kind: 'dsh', transport: 'ssh', host: 'x'.repeat(254), remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'valid', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080, serviceName: 'x'.repeat(256) }), null)
  assert.equal(sshProvider.validateSpec({ id: 'dash-unit', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080, serviceName: '-x' }), null)
  assert.equal(sshProvider.validateSpec({ id: 'option-unit', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080, serviceName: '--user' }), null)
  assert.ok(sshProvider.validateSpec({ id: 'hyphen-unit', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080, serviceName: 'my-unit.service' }) !== null)
  assert.ok(sshProvider.validateSpec({ id: 'valid', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080 }) !== null)
  // kind and transport are REQUIRED: pre-v2 records are dropped loudly at
  // registry load, never defaulted here (the legacy fill-ins are gone).
  assert.equal(sshProvider.validateSpec({ id: 'legacy', label: 'h', host: 'h', remotePort: 3080 }), null)
})
test('the ssh provider serves both target kinds over the ssh transport (v2, design 17 §2)', () => {
  // Accepted v2 forms: kind 'dsh' / transport 'ssh' normalize into the
  // canonical { kind:'dsh', transport:'ssh', insecureHttp:false } spec.
  const viaKind = sshProvider.validateSpec({ id: 'a', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080 })
  assert.ok(viaKind !== null)
  if (viaKind !== null) {
    assert.equal(viaKind.kind, 'dsh')
    assert.equal(viaKind.transport, 'ssh')
    assert.equal(viaKind.insecureHttp, false)
  }
  // A partial pre-v2 shape (kind or transport missing) is refused at this
  // provider boundary; the registry loader canonicalizes before validating,
  // and that input canonicalizer is the one remaining pre-v2 path (open).
  assert.equal(sshProvider.validateSpec({ id: 'b', label: 'h', host: 'h', transport: 'ssh', remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'b2', label: 'h', host: 'h', kind: 'dsh', remotePort: 3080 }), null)
  // v2 (design 17 §2.1/§2.2): a GATEWAY target over the ssh transport is
  // served by this provider — the tunnel + exec machinery is transport-
  // specific, the kind only decides verifyUp/header semantics.
  const gatewayViaSsh = sshProvider.validateSpec({ id: 'c', label: 'h', kind: 'gateway', transport: 'ssh', host: 'h', user: 'u', remotePort: 30801 })
  assert.ok(gatewayViaSsh !== null)
  if (gatewayViaSsh !== null) {
    assert.equal(gatewayViaSsh.kind, 'gateway')
    assert.equal(gatewayViaSsh.transport, 'ssh')
    assert.equal(gatewayViaSsh.insecureHttp, false)
  }
  // A direct-http transport (the http provider's job) is refused loudly,
  // never mis-served by the tunnel provider.
  assert.equal(sshProvider.validateSpec({ id: 'd', label: 'h', kind: 'dsh', transport: 'http', host: 'h', remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'd2', label: 'h', kind: 'gateway', transport: 'http', host: 'h', remotePort: 443 }), null)
  // insecureHttp is meaningless for a loopback tunnel: true is refused,
  // false/absent normalize to false.
  assert.equal(sshProvider.validateSpec({ id: 'e', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h', remotePort: 3080, insecureHttp: true }), null)
  assert.equal(sshProvider.validateSpec({ id: 'e2', label: 'h', kind: 'gateway', transport: 'ssh', host: 'h', remotePort: 30801, insecureHttp: true }), null)
})
test('the ssh provider refuses an S23 pin instead of silently dropping an inapplicable trust anchor', () => {
  assert.equal(sshProvider.validateSpec({
    id: 'ssh-pin',
    label: 'ssh pin',
    kind: 'gateway',
    transport: 'ssh',
    host: 'gateway.example.com',
    user: 'alice',
    remotePort: 30801,
    spkiPin: 'ab'.repeat(32),
  }), null)
})
