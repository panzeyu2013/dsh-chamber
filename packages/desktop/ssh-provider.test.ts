/**
 * ssh provider password-auth unit tests (design 05 §8): the in-memory
 * password store, the ephemeral askpass helper script (single-quote
 * escaping, host-key `yes` answers, directly executable 0700 file, dispose cleanup) and the
 * buildStartEnv surface that wires the password into the ssh spawn without
 * a TTY or the command line. Pure-Node, no real ssh host: the helper's
 * behavior is verified by actually executing it against ssh-style prompts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import type { SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  acquireSshAuthLease,
  buildAskpassScript,
  buildRemoteExecArgv,
  chmodAskpassDirOwnerOnly,
  configureSshPasswordStore,
  cleanupStaleAskpassHelpers,
  createAskpassHelper,
  disposeSshAuth,
  purgeSshAuth,
  getSshPassword,
  probeDshSignature,
  verifyDshEndpoint,
  resolveWriteTarget,
  setSshPassword,
  sshPasswordSupported,
  sshProvider,
  verifyGatewayEndpointViaTunnel,
  MAX_SSH_PASSWORD_CHARS,
  RUN_STDOUT_MAX_BYTES,
  WRITE_FILE_MAX_BYTES,
} from './ssh-provider.ts'
import { configureGatewaySessionProvider, GATEWAY_RUNTIME_IDENTITY, setGatewayPassword, setGatewayToken } from './gateway-provider.ts'
import type { GatewaySessionProviderHooks } from './gateway-provider.ts'
import type { GatewayRegistrationAuthProof, GatewaySessionOrigin } from './gateway-session.ts'
import type { TransportExecDeps, TransportInstanceSpec, TransportStatusProjection, SpawnedProcess } from './transport-provider.ts'
import { CHILD_LINE_MAX_CHARS } from './bounded-lines.ts'
import { sshCredentialBinding } from './credential-binding.ts'

const GATEWAY_RUNTIME_STATUS = { kind: GATEWAY_RUNTIME_IDENTITY, connectionState: 'stopped' }

function completeTestGatewaySessionHooks(partial: GatewaySessionProviderHooks): GatewaySessionProviderHooks {
  if (partial.ensureSession === undefined) throw new TypeError('test session hooks require ensureSession')
  let generation = 0
  let proof: GatewayRegistrationAuthProof | null = null
  let cached: string | null = null
  return {
    ensureSession: async (origin, password) => {
      const result = await partial.ensureSession!(origin, password)
      if (result.ok) cached = result.cookie
      return result
    },
    generation: partial.generation ?? (() => generation),
    registrationAuthProof: partial.registrationAuthProof ?? (() => proof),
    setRegistrationAuthProof: partial.setRegistrationAuthProof ?? ((_origin, next) => { proof = next }),
    cachedCookie: origin => partial.cachedCookie?.(origin) ?? cached,
    invalidate: origin => {
      generation += 1
      proof = null
      cached = null
      partial.invalidate?.(origin)
    },
  }
}

/** A minimal valid ssh spec for provider-surface tests (v2: kind = target
 *  type 'dsh', transport = mechanism 'ssh' — design 17 §2). */
function spec(id: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'dsh', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome: null, insecureHttp: false }
}

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
    // 2026-11 review: "Password for <user>:" (no colon right after "password")
    // is a REAL password prompt and must receive the password.
    const passwordFor = spawnSync(path, ['Password for user@h.example.com:'], { encoding: 'utf8' })
    assert.equal(passwordFor.stdout, "s3cr't\n", 'Password for <user>: prompts answer the stored password')
    // Fail-closed (2026-11): a prompt that is NOT provably a host-key or
    // password prompt (OTP/verification code, password change) gets NO
    // answer — the stored password must never leave the helper for it.
    const otp = spawnSync(path, ['Verification code:'], { encoding: 'utf8' })
    assert.equal(otp.status, 0)
    assert.equal(otp.stdout, '', 'fail-closed: a non-credential prompt receives no answer')
    assert.ok(!otp.stdout.includes("s3cr't"), 'fail-closed: the password never reaches an OTP prompt')
    // 2026-11 review hardening: OTP wording that ALSO contains "assword:"
    // must still fail closed (explicit exclusion branch, not the password one).
    const otpWording = spawnSync(path, ['One-time password:'], { encoding: 'utf8' })
    assert.equal(otpWording.stdout, '', 'fail-closed: "One-time password:" receives no answer')
    const change = spawnSync(path, ['Enter new password:'], { encoding: 'utf8' })
    assert.equal(change.stdout, '', 'fail-closed: a password-change prompt receives no answer')
    // 2026-11 round-2: the prompt is normalized to lowercase before matching,
    // so ANY casing variant behaves identically (the pre-normalization
    // version leaked the password for "One-time Password:").
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
    assert.equal(
      getSshPassword(nonAuthenticationEdit),
      'pw',
      'non-authentication metadata is outside password ownership',
    )
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
  // Regression: the old fixed cap deleted the tunnel helper once enough
  // concurrent systemd/run children created newer generations.
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
      passwords: {
        't-owner-mode': { password: 'pw', host: 'h.example.com', user: 'u', sshPort: null },
      },
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

test('schema v1 passwords are preserved but loudly retired because they have no endpoint owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, passwords: { 't-v1': 'pw' } }), { mode: 0o600 })
    const notice = configureSshPasswordStore(file)
    assert.match(notice ?? '', /no endpoint bindings/)
    assert.match(notice ?? '', /re-enter passwords/)
    assert.equal(
      readdirSync(dir).some(name => name.startsWith('ssh-passwords.json.unbound-')),
      true,
      'the old plaintext file is uniquely preserved for manual recovery',
    )
    assert.equal(getSshPassword(spec('t-v1')), null, 'an unowned legacy secret is never guessed onto the current registry')
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
      passwords: {
        't-symlink': { password: 'pw', host: 'h.example.com', user: 'u', sshPort: null },
      },
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

test('non-empty legacy SSH password files are uniquely preserved and never auto-bound', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-passwd-legacy-'))
  const file = join(dir, 'ssh-passwords.json')
  try {
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, passwords: { legacy: 'password' } }))
    const notice = configureSshPasswordStore(file, id => spec(id))
    assert.match(notice ?? '', /no endpoint bindings|re-enter/)
    assert.equal(getSshPassword('legacy'), null)
    assert.equal(existsSync(file), false)
    assert.equal(readdirSync(dir).some(name => name.startsWith('ssh-passwords.json.unbound-')), true)
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
  assert.equal(sshProvider.validateSpec({ id: 'x'.repeat(65), label: 'h', host: 'h', remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'valid', label: 'x'.repeat(129), host: 'h', remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'valid', label: 'h', host: 'x'.repeat(254), remotePort: 3080 }), null)
  assert.equal(sshProvider.validateSpec({ id: 'valid', label: 'h', host: 'h', remotePort: 3080, serviceName: 'x'.repeat(256) }), null)
  assert.equal(sshProvider.validateSpec({ id: 'dash-unit', label: 'h', host: 'h', remotePort: 3080, serviceName: '-x' }), null)
  assert.equal(sshProvider.validateSpec({ id: 'option-unit', label: 'h', host: 'h', remotePort: 3080, serviceName: '--user' }), null)
  assert.ok(sshProvider.validateSpec({ id: 'hyphen-unit', label: 'h', host: 'h', remotePort: 3080, serviceName: 'my-unit.service' }) !== null)
  assert.ok(sshProvider.validateSpec({ id: 'valid', label: 'h', host: 'h', remotePort: 3080 }) !== null)
})

test('the ssh provider serves both target kinds over the ssh transport (v2, design 17 §2)', () => {
  // Accepted v2 forms: kind 'dsh' / transport 'ssh' normalize into the
  // canonical { kind:'dsh', transport:'ssh', insecureHttp:false } spec.
  const viaKind = sshProvider.validateSpec({ id: 'a', label: 'h', kind: 'dsh', host: 'h', remotePort: 3080 })
  assert.ok(viaKind !== null)
  if (viaKind !== null) {
    assert.equal(viaKind.kind, 'dsh')
    assert.equal(viaKind.transport, 'ssh')
    assert.equal(viaKind.insecureHttp, false)
  }
  const viaTransport = sshProvider.validateSpec({ id: 'b', label: 'h', host: 'h', transport: 'ssh', remotePort: 3080 })
  assert.ok(viaTransport !== null)
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
  assert.equal(sshProvider.validateSpec({ id: 'e', label: 'h', host: 'h', remotePort: 3080, insecureHttp: true }), null)
  assert.equal(sshProvider.validateSpec({ id: 'e2', label: 'h', kind: 'gateway', host: 'h', remotePort: 30801, insecureHttp: true }), null)
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

// --- design 13 §7.2 exec whitelist tests (M1) ---

function specWithHome(id: string, remoteDshHome: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'dsh', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome, insecureHttp: false }
}

test('buildRemoteExecArgv accepts a whitelisted dsh plugin add/remove', () => {
  assert.deepEqual(
    buildRemoteExecArgv(spec('w1'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', '@scope/name@^1.2.3'] }),
    ['dsh', 'plugin', '--profile', 'web', 'add', '@scope/name@^1.2.3'],
  )
  assert.deepEqual(
    buildRemoteExecArgv(spec('w1'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'remove', 'name'] }),
    ['dsh', 'plugin', '--profile', 'web', 'remove', 'name'],
  )
})

test('buildRemoteExecArgv prepends DSH_HOME when remoteDshHome is set', () => {
  assert.deepEqual(
    buildRemoteExecArgv(specWithHome('w2', '/opt/dsh'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'name@1.2.3'] }),
    ['DSH_HOME=/opt/dsh', 'dsh', 'plugin', '--profile', 'web', 'add', 'name@1.2.3'],
  )
})

test('buildRemoteExecArgv refuses injection / non-registry specs', () => {
  const bad = [
    '-oProxyCommand=x',
    'name;rm -rf /',
    'name|cat /etc/passwd',
    'name>out',
    'name<in',
    'name*',
    "name'$(x)'",
    'git+https://github.com/a/b',
    'file:../pkg',
    'name@>=1.0.0 <2.0.0',
    'name@1.2.3 || 2.0.0',
    'npm:alias@1.0.0',
  ]
  for (const s of bad) {
    assert.equal(buildRemoteExecArgv(spec('w3'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', s] }), null, `refuses ${JSON.stringify(s)}`)
  }
})

test('buildRemoteExecArgv refuses wrong dsh argv structure', () => {
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'update', 'name'] }), null, 'refuses non-whitelisted action')
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add'] }), null, 'refuses missing spec')
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['other', '--profile', 'web', 'add', 'name'] }), null, 'refuses wrong subcommand')
  assert.equal(buildRemoteExecArgv(spec('w4'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'remove', 'name@1.2.3'] }), null, 'remove refuses @version')
})

test('buildRemoteExecArgv allows only the two whitelisted cat paths (always under LC_ALL=C)', () => {
  // LC_ALL=C forces the REMOTE coreutils to English regardless of the remote
  // locale — the general fix for localized ENOENT messages (zh_CN 没有那个文件
  // 或目录, ja, fr, …), not a per-language whitelist.
  assert.deepEqual(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/package.json'] }), ['LC_ALL=C', 'cat', '~/.dsh/profiles/web/package.json'])
  assert.deepEqual(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/cordis.patch.yml'] }), ['LC_ALL=C', 'cat', '~/.dsh/profiles/web/cordis.patch.yml'])
  assert.equal(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['/etc/passwd'] }), null, 'refuses arbitrary cat path')
  assert.equal(buildRemoteExecArgv(spec('w5'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/web/package.json', 'extra'] }), null, 'refuses extra argv')
})

test('resolveWriteTarget allows the three prefixes and rejects traversal', () => {
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh-chamber/plugins/pkg-abc123.tgz'), '~/.dsh-chamber/plugins/pkg-abc123.tgz')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/dist/index.js'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/dist/index.js')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/web/cordis.patch.yml'), '~/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(resolveWriteTarget(spec('w6'), '/etc/passwd'), null, 'refuses arbitrary path')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh-chamber/plugins/../evil.tgz'), null, 'refuses dot-dot')
  assert.equal(resolveWriteTarget(spec('w6'), '~/.dsh/profiles/web/package.json'), null, 'refuses non-whitelisted profile file')
})

test('resolveWriteTarget honors a custom remoteDshHome', () => {
  assert.equal(resolveWriteTarget(specWithHome('w7', '/opt/dsh'), '/opt/dsh/profiles/web/cordis.patch.yml'), '/opt/dsh/profiles/web/cordis.patch.yml')
  assert.equal(resolveWriteTarget(specWithHome('w7', '/opt/dsh'), '~/.dsh/profiles/web/cordis.patch.yml'), null, 'default-home path rejected when a custom home is set')
})

test('resolveWriteTarget rejects traversal inside the seed subtree (shared SEED_RELATIVE_PATTERN)', () => {
  const seed = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'
  assert.equal(resolveWriteTarget(spec('w7b'), seed), seed)
  assert.equal(
    resolveWriteTarget(spec('w7b'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/../../etc/passwd'),
    null,
    'dot-dot escapes the seed subtree',
  )
  assert.equal(
    resolveWriteTarget(spec('w7b'), '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/./package.json'),
    null,
    'self-segment is refused too',
  )
})

test('buildRemoteExecArgv accepts the fixed printf $HOME lookup (materialize remote-home resolution)', () => {
  assert.deepEqual(
    buildRemoteExecArgv(spec('w8'), { op: 'exec', command: 'printf', argv: ['%s', '$HOME'] }),
    ['printf', '%s', '$HOME'],
  )
  assert.equal(buildRemoteExecArgv(spec('w8'), { op: 'exec', command: 'printf', argv: ['%s', 'HOME'] }), null, 'refuses any argv other than the fixed form')
  assert.equal(buildRemoteExecArgv(spec('w8'), { op: 'exec', command: 'printf', argv: ['$HOME', '%s'] }), null)
})

test('buildRemoteExecArgv allows the converged seed-subtree cat read (seed hash-skip)', () => {
  const seedPkg = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [seedPkg] }), ['LC_ALL=C', 'cat', seedPkg])
  const seedDist = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/dist/index.js'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [seedDist] }), ['LC_ALL=C', 'cat', seedDist])
  const gitWorktreeDist = '~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/dist/index.js'
  assert.deepEqual(buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: [gitWorktreeDist] }), ['LC_ALL=C', 'cat', gitWorktreeDist])
  assert.equal(
    buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/node_modules/other/pkg.json'] }),
    null,
    'outside the seed subtree refused',
  )
  assert.equal(
    buildRemoteExecArgv(spec('w9'), { op: 'exec', command: 'cat', argv: ['~/.dsh/profiles/node_modules/@dsh-chamber/../../etc/passwd'] }),
    null,
    'traversal beyond the seed subtree refused',
  )
})

test('buildRemoteExecArgv accepts the materialize file: add spec, constrained to the materialize dir', () => {
  const ok = buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/home/u/.dsh-chamber/plugins/pkg-a1b2c3d4.tgz'] })
  assert.deepEqual(ok, ['dsh', 'plugin', '--profile', 'web', 'add', 'file:/home/u/.dsh-chamber/plugins/pkg-a1b2c3d4.tgz'])
  // the normalized scoped-name filename form
  assert.ok(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/home/u/.dsh-chamber/plugins/scope-name-a1b2.tgz'] }) !== null)
  // everything else stays refused — plain registry add must still pass untouched
  assert.ok(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'pkg@^1.0.0'] }) !== null)
  assert.equal(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/etc/passwd'] }), null, 'absolute path outside the materialize dir refused')
  assert.equal(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:~/x.tgz'] }), null, '~ mid-word never accepted')
  assert.equal(buildRemoteExecArgv(spec('w10'), { op: 'exec', command: 'dsh', argv: ['plugin', '--profile', 'web', 'add', 'file:/tmp/evil.tgz'] }), null, 'outside .dsh-chamber/plugins refused')
})

// ============================================================================
// write-file flow (design 13 §4.1) — through the real provider surface
// ============================================================================

/** A fake ssh child whose stdin writes are recorded (base64 payloads). */
class FakeRunChild extends EventEmitter implements SpawnedProcess {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin: { write(chunk: string | Buffer): unknown; end(): unknown }
  stdinWrites: Buffer[] = []
  killCalls: string[] = []
  constructor() {
    super()
    this.stdin = {
      write: (chunk) => { this.stdinWrites.push(Buffer.from(chunk)); return true },
      end: () => {},
    }
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal)
    return true
  }
  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.emit('exit', code, signal)
  }
  stdoutWrite(text: string | Buffer) {
    this.stdout.emit('data', Buffer.from(text))
  }
  stderrWrite(text: string) {
    this.stderr.emit('data', Buffer.from(text))
  }
}

/** Minimal TransportExecDeps driving the provider's `run` channel. */
/** Bounded poll for observable side effects (the timeout timer is unref'ed;
 * racing it with a fixed keep-alive flaked under CI stalls). */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${what} did not become true within ${timeoutMs}ms`)
}

function runDeps(spawnFn: TransportExecDeps['spawnFn']): TransportExecDeps {
  const projection: TransportStatusProjection = {
    kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'idle', localPort: null, sshPort: null, remotePort: 3080,
    retryAttempt: 0, requiresUserAction: false, userActionKind: null, serviceActive: null, remoteDshHome: null,
    logSummary: '',
  }
  return {
    spawnFn,
    execTimeoutMs: 5_000,
    runTimeoutMs: 5_000,
    disconnectGraceMs: 100,
    log: () => {},
    setProjection: () => {},
    projection: () => projection,
  }
}

test('a run timeout resolves without releasing askpass before the real child exit', async () => {
  configureSshPasswordStore(null)
  const runSpec = spec('t-run-timeout-lease')
  setSshPassword(runSpec.id, 'pw')
  const child = new FakeRunChild()
  let helperPath: string | null = null
  let exited = false
  try {
    const deps = runDeps((_command, _args, options) => {
      helperPath = typeof options.env?.SSH_ASKPASS === 'string' ? options.env.SSH_ASKPASS : null
      return child
    })
    deps.runTimeoutMs = 5
    deps.disconnectGraceMs = 1_000
    const resultPromise = sshProvider.exec!(runSpec, 'run', deps, {
      op: 'exec', command: 'printf', argv: ['%s', '$HOME'],
    })
    // Production timeout timers are intentionally unref'ed: wait on the
    // observable side effect (SIGTERM) instead of racing a fixed keep-alive
    // against CI stalls.
    await waitFor(() => child.killCalls.includes('SIGTERM'), 'the 5ms timeout sent SIGTERM')
    const result = await resultPromise
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /timed out/)
    assert.ok(child.killCalls.includes('SIGTERM'), 'timeout asks the real child to terminate')
    assert.ok(helperPath !== null && existsSync(helperPath), 'promise resolution alone cannot release the live child helper')
    child.simulateExit(143, 'SIGTERM')
    exited = true
    assert.ok(!existsSync(helperPath), 'the later real child exit releases the helper')
  } finally {
    if (!exited) child.simulateExit(143, 'SIGTERM')
    setSshPassword(runSpec.id, null)
    purgeSshAuth(runSpec.id)
  }
})

/**
 * A fake remote host for the `run` channel: records every spawn and answers
 * write-file (`mkdir -p … && base64 -d > …` — decodes the recorded stdin),
 * `cat` (serves the file bytes / ENOENT), `printf %s $HOME` and `dsh`
 * automatically on the next tick. `tamper` overrides the bytes `cat` serves
 * for a path (verification-mismatch tests).
 */
function makeRemoteHost(home = '/home/u') {
  const files = new Map<string, Buffer>()
  const tamper = new Map<string, Buffer>()
  const spawns: Array<{ command: string; args: string[]; child: FakeRunChild }> = []
  const spawnFn = (command: string, args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    const record = { command, args: [...args], child }
    spawns.push(record)
    setImmediate(() => handleRemote(record))
    return child
  }
  function handleRemote(record: { command: string; args: string[]; child: FakeRunChild }) {
    // ssh args: [target, ...remoteArgv] or ['-p', <port>, target, ...remoteArgv]
    const remoteArgv = record.args[0] === '-p' ? record.args.slice(3) : record.args.slice(1)
    const child = record.child
    const joined = remoteArgv.join(' ')
    if (joined.startsWith('mkdir -p ') && joined.includes(' && base64 -d > ')) {
      const target = joined.slice(joined.lastIndexOf('> ') + 2)
      const base64 = child.stdinWrites.map(bytes => bytes.toString('utf8')).join('')
      files.set(target, Buffer.from(base64, 'base64'))
      child.simulateExit(0)
      return
    }
    if (remoteArgv[0] === 'cat' || (remoteArgv[0] === 'LC_ALL=C' && remoteArgv[1] === 'cat')) {
      // The provider now runs every remote cat under `LC_ALL=C` (English
      // messages regardless of the remote locale); the bare form is kept for
      // the write-file read-back fake and legacy shapes.
      const path = remoteArgv[0] === 'cat' ? remoteArgv[1] as string : remoteArgv[2] as string
      const bytes = tamper.get(path) ?? files.get(path)
      if (bytes === undefined) {
        child.stderrWrite(`cat: ${path}: No such file or directory\n`)
        child.simulateExit(1)
      } else {
        child.stdoutWrite(bytes)
        child.simulateExit(0)
      }
      return
    }
    if (remoteArgv[0] === 'printf' && remoteArgv[1] === '%s' && remoteArgv[2] === '$HOME') {
      child.stdoutWrite(home)
      child.simulateExit(0)
      return
    }
    if (remoteArgv[0] === 'dsh') {
      child.simulateExit(0)
      return
    }
    child.stderrWrite(`unknown remote command: ${joined}\n`)
    child.simulateExit(1)
  }
  return { spawns, files, tamper, spawnFn }
}

test('write-file: streams base64 over ssh stdin and verifies the read-back in the BYTE domain', async () => {
  const remote = makeRemoteHost()
  // Binary content with invalid UTF-8 sequences: the lossy `toString('utf8')`
  // view must NOT be what the hash is computed over (the pre-fix code hashed
  // the string, so this content always failed with U+FFFD corruption).
  const content = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfe, 0x81, 0x82, 0x00, 0x01])
  const sha256 = createHash('sha256').update(content).digest('hex')
  const result = await sshProvider.exec!(spec('wf1'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path: '~/.dsh-chamber/plugins/pkg-abc123.tgz',
    contentBase64: content.toString('base64'),
    sha256,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  // The fake host stored the decoded bytes verbatim; the write command was a
  // single fixed `mkdir -p … && base64 -d > …` shell template.
  assert.ok(remote.files.get('~/.dsh-chamber/plugins/pkg-abc123.tgz')!.equals(content))
  assert.equal(remote.spawns.length, 2, 'one write spawn + one cat read-back spawn')
  assert.ok(remote.spawns[0].args[1].startsWith('mkdir -p ~/.dsh-chamber/plugins && base64 -d > '))
  // Verification is a streaming digest. Successful write-file calls return
  // status only instead of retaining/decoding a second copy of the payload.
  assert.equal(result.stdoutBytes, undefined)
  assert.equal(result.stdout, undefined)
})

test('write-file: a tampered read-back fails loud (never a fake success)', async () => {
  const remote = makeRemoteHost()
  const content = Buffer.from('hello')
  const path = '~/.dsh-chamber/plugins/pkg-abc123.tgz'
  remote.tamper.set(path, Buffer.from('tampered'))
  const result = await sshProvider.exec!(spec('wf2'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path,
    contentBase64: content.toString('base64'),
    sha256: createHash('sha256').update(content).digest('hex'),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /verification failed: remote SHA-256 mismatch/)
})

test('write-file: a payload sha256 mismatch is refused before any spawn', async () => {
  const remote = makeRemoteHost()
  const result = await sshProvider.exec!(spec('wf3'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path: '~/.dsh-chamber/plugins/pkg-abc123.tgz',
    contentBase64: Buffer.from('hello').toString('base64'),
    sha256: '0'.repeat(64),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /content does not match sha256/)
  assert.equal(remote.spawns.length, 0)
})

test('write-file: content over the 50MiB cap is refused before any spawn', async () => {
  const remote = makeRemoteHost()
  const big = Buffer.alloc(WRITE_FILE_MAX_BYTES + 1, 0x61)
  const result = await sshProvider.exec!(spec('wf4'), 'run', runDeps(remote.spawnFn), {
    op: 'write-file',
    path: '~/.dsh-chamber/plugins/pkg-abc123.tgz',
    contentBase64: big.toString('base64'),
    sha256: createHash('sha256').update(big).digest('hex'),
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /exceeds the .*byte limit/)
  assert.equal(remote.spawns.length, 0, 'no ssh process may spawn for an oversized write')
})

test('run: captured remote stdout is bounded before buffering', async () => {
  const remote = makeRemoteHost()
  const path = '~/.dsh/profiles/web/package.json'
  remote.files.set(path, Buffer.alloc(RUN_STDOUT_MAX_BYTES + 1, 0x61))
  const result = await sshProvider.exec!(spec('wf-stdout-cap'), 'run', runDeps(remote.spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: [path],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /stdout exceeds the .*byte limit/)
  assert.ok(remote.spawns[0].child.killCalls.includes('SIGTERM'), 'oversized producer is terminated')
})

test('run: an unterminated stderr line is bounded and discarded before redaction detail assembly', async () => {
  const child = new FakeRunChild()
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(() => child)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const running = sshProvider.exec!(spec('wf-stderr-cap'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  child.stderrWrite('x'.repeat(CHILD_LINE_MAX_CHARS + 1))
  child.stderrWrite('\nordinary failure\n')
  child.simulateExit(1)
  const result = await running
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /output line dropped/)
    assert.match(result.error, /ordinary failure/)
    assert.ok(result.error.length < 4096, 'failure detail remains bounded')
  }
  assert.ok(logs.some(entry => entry.level === 'error' && entry.message.includes('output line dropped')))
  assert.ok(logs.every(entry => !entry.message.includes('xxxxx')), 'raw overlong stderr never reaches logs')
})

test('run: many newline-delimited stderr lines are bounded while the process is still running', async () => {
  const child = new FakeRunChild()
  const running = sshProvider.exec!(spec('wf-stderr-count-cap'), 'run', runDeps(() => child), {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  for (let index = 0; index < 5_000; index += 1) child.stderrWrite(`failure-${index}\n`)
  child.simulateExit(1)
  const result = await running
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(result.error.length < 4096, 'detail storage is capped incrementally, not only sliced after join')
    assert.match(result.error, /failure-0/)
  }
})

test('run: a non-zero exit carries the REDACTED remote stderr text (ENOENT → profile not initialized)', async () => {
  const remote = makeRemoteHost()
  const result = await sshProvider.exec!(spec('wf5'), 'run', runDeps(remote.spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /run command failed \(exit 1\)/)
    assert.match(result.error, /No such file or directory/, 'the ENOENT stderr text rides the run error')
  }
})

test('run: a non-quiet failure is logged at ERROR level (loud by default)', async () => {
  const remote = makeRemoteHost()
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(remote.spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wf7'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  assert.equal(result.ok, false)
  assert.ok(
    logs.some(entry => entry.level === 'error' && entry.message.startsWith('run command failed')),
    'the ERROR log line is present for a non-quiet failure',
  )
})

test('run: a QUIET failure keeps the ENOENT error text but suppresses the ERROR log and the stderr INFO echo', async () => {
  const remote = makeRemoteHost()
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(remote.spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wf8'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-client-graph/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /run command failed \(exit 1\)/)
    assert.match(result.error, /No such file or directory/, 'the ENOENT stderr text still rides the run error')
  }
  assert.ok(
    !logs.some(entry => entry.level === 'error' && entry.message.startsWith('run command failed')),
    'no ERROR log for a quiet expected failure',
  )
  assert.ok(
    !logs.some(entry => entry.message.includes('No such file or directory')),
    'no raw-stderr INFO echo for a quiet run',
  )
})

test('run: a QUIET ENOENT probe under a `.ssh`-named home stays ENOENT-classified (redacted display still hides the path)', async () => {
  // A whitelist-valid remoteDshHome like /root/.ssh-custom (design 13 §7.2)
  // makes redactSshStderr replace the whole ENOENT line with the redacted
  // summary — the absent-file signal must survive (classified on the RAW
  // stderr), so the plugin-sync caller still reads "file absent", never a
  // loud ssh failure — while the display text still hides the path.
  const spawnFn = (_command: string, _args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    setImmediate(() => {
      child.stderrWrite('cat: /root/.ssh-custom/profiles/web/package.json: No such file or directory\n')
      child.simulateExit(1)
    })
    return child
  }
  const result = await sshProvider.exec!(specWithHome('wf9', '/root/.ssh-custom'), 'run', runDeps(spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: ['/root/.ssh-custom/profiles/web/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /No such file or directory/, 'the ENOENT classification survives the `.ssh*` whole-line redaction')
    assert.ok(!result.error.includes('.ssh-custom'), 'the `.ssh`-named home path never rides the error')
    assert.ok(!result.error.includes('/root/'), 'no path material rides the error')
    assert.ok(result.error.includes('[ssh material redacted]'), 'the redacted summary is what is displayed')
  }
})

test('run: a zh_CN-locale ENOENT ("没有那个文件或目录") is classified as absent — a quiet probe, never a loud failure', async () => {
  // Real-world case (2026-08 user report): coreutils on a zh_CN-locale host
  // prints `没有那个文件或目录` for a missing file. classifyStderr must flag
  // it ENOENT (classified on the RAW line) so the plugin-sync caller reads
  // "file absent" (未注入) instead of a loud ssh failure — while the quiet
  // run stays log-free.
  const spawnFn = (_command: string, _args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    setImmediate(() => {
      child.stderrWrite('cat: ~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/package.json: 没有那个文件或目录\n')
      child.simulateExit(1)
    })
    return child
  }
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wzh'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/node_modules/@dsh-chamber/dsh-host-git-worktree/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.error, /没有那个文件或目录/, 'the zh_CN ENOENT text rides the run error')
  }
  assert.ok(
    !logs.some(entry => entry.level === 'error' && entry.message.startsWith('run command failed')),
    'no ERROR log for a quiet zh_CN ENOENT probe',
  )
  assert.ok(
    !logs.some(entry => entry.message.includes('没有那个文件或目录')),
    'no raw-stderr INFO echo for a quiet run',
  )
})

test('run: a QUIET exec with an auth failure stays LOUD (ERROR log + authentication-failure result)', async () => {
  // quiet suppresses EXPECTED failures only (ENOENT probes) — an auth failure
  // is never expected, so it must still log the ERROR line and return the
  // authentication-failure result, never a generic quieted failure.
  const spawnFn = (_command: string, _args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    setImmediate(() => {
      child.stderrWrite('Permission denied (publickey).\n')
      child.simulateExit(255)
    })
    return child
  }
  const logs: Array<{ level: string; message: string }> = []
  const deps = runDeps(spawnFn)
  deps.log = (level, message) => { logs.push({ level, message }) }
  const result = await sshProvider.exec!(spec('wf10'), 'run', deps, {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
    quiet: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error, 'authentication failure — requires user action')
  assert.ok(
    logs.some(entry => entry.level === 'error' && entry.message.includes('authentication failure detected')),
    'quiet never silences an auth failure — the ERROR line is still logged',
  )
})

test('run: private material in stderr is redacted from the failure detail', async () => {
  const spawnFn = (_command: string, _args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    const child = new FakeRunChild()
    setImmediate(() => {
      child.stderrWrite('Load key "/Users/alice/.ssh/id_ed25519": invalid format\n')
      child.simulateExit(1)
    })
    return child
  }
  const result = await sshProvider.exec!(spec('wf6'), 'run', runDeps(spawnFn), {
    op: 'exec',
    command: 'cat',
    argv: ['~/.dsh/profiles/web/package.json'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.ok(!result.error.includes('/Users/alice/.ssh'), 'the key path never rides the error')
    assert.match(result.error, /\[ssh material redacted\]/)
  }
})

// ---------------------------------------------------------------------------
// probeDshSignature: the dsh-signature classification over a REAL loopback
// HTTP server (valid session/list envelope / wrong envelope / 404 / timeout /
// refused).
// ---------------------------------------------------------------------------

test('probeDshSignature classifies the dsh session/list signature', async () => {
  const behaviors: Array<(req: any, res: any) => void> = [
    // A valid server-response envelope echoing the session/list request →
    // positive dsh signature (the only remaining dsh wire evidence on
    // upstream 0.1.2-alpha.1 — the events.mux arms are gone).
    (req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += String(chunk) })
      req.on('end', () => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: {} } }))
      })
    },
    // A server-response envelope with result.ok !== true: NOT a dsh signature.
    (req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += String(chunk) })
      req.on('end', () => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'forbidden' } } }))
      })
    },
    // 200 with another content type: NOT a dsh signature.
    (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>') },
    // 404: no signature.
    (_req, res) => { res.writeHead(404); res.end('nope') },
  ]
  let call = 0
  const server = createServer((req, res) => {
    const behavior = behaviors[call++]
    if (behavior === undefined) { res.writeHead(500); res.end() }
    else behavior(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'dsh')
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('verifyDshEndpoint: a 401 answer is the 0.1.2 browser-auth gate — terminal with the honest reason', async () => {
  // review-round3c P0: a 0.1.2 web-profile host answers 401 without the
  // signed cookie; the launch token is unrecoverable over the tunnel, so the
  // probe must fail loud with the auth-required reason (never "not a dsh").
  // The session/list probe AND the signature probe both hit the 401 gate; a
  // bare 401 from a NON-dsh server keeps the neutral message (round4 P2).
  const server = createServer((_req, res) => { res.writeHead(401); res.end('unauthorized') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const result = await verifyDshEndpoint({ host: '127.0.0.1', port })
    assert.equal(result.ok, false)
    assert.equal(result.terminal, true)
    // The signature probe is gated the same way → the hedged 401 message.
    assert.match(result.detail ?? '', /answered HTTP 401/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})


test('probeDshSignature answers none on connection failure and timeout', async () => {
  // A refused port (server closed): the probe must resolve 'none', never
  // reject or hang.
  const server = createServer(() => {})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  assert.equal(await probeDshSignature({ host: '127.0.0.1', port }), 'none', 'ECONNREFUSED → none')

  // A silent server: the request timeout resolves 'none'.
  const silent = createServer(() => { /* never answers */ })
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
  const silentPort = (silent.address() as AddressInfo).port
  try {
    assert.equal(await probeDshSignature({ host: '127.0.0.1', port: silentPort }, 120), 'none', 'timeout → none')
  } finally {
    await new Promise<void>(resolve => silent.close(() => resolve()))
  }
})

// ---------------------------------------------------------------------------
// verifyUp kind branching (design 17 §9.2): dsh targets never carry auth
// headers; gateway targets may — a stored token rides the tunnel probe as
// Bearer, a missing token is NO pre-flight refusal (the probe goes out
// without a header and the gateway's own 401 is classified terminal, §2.3).
// ---------------------------------------------------------------------------

/** A gateway-over-ssh spec (kind 'gateway', transport 'ssh'). */
function gatewaySshSpec(id: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'gateway', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 30801, serviceName: null, remoteDshHome: null, insecureHttp: false }
}

/** A loopback server that collects the request body and delegates to a
 * handler (probe handlers echo the client-request rpcId in their
 * server-response / gateway-status bodies). */
function describeServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void) {
  return createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => handler(req, res, body))
  })
}

test('ssh provider verifyUp: a gateway target with a stored token probes WITH an Authorization header', async () => {
  const TOKEN = 'x'.repeat(32)
  setGatewayToken('gw-auth', TOKEN)
  try {
    let seenAuth: string | null = null
    const server = describeServer((req, res, _body) => {
      seenAuth = req.headers.authorization ?? null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-auth'), { host: '127.0.0.1', port })
      assert.deepEqual(result, { ok: true })
      assert.equal(seenAuth, `Bearer ${TOKEN}`, 'the stored token rides the tunnel probe as Authorization')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    setGatewayToken('gw-auth', null)
  }
})

test('ssh provider verifyUp: a gateway target WITHOUT a token probes with NO header; a 401 is terminal', async () => {
  setGatewayToken('gw-noauth', null)
  let seenAuth: string | null = null
  const server = describeServer((req, res) => {
    seenAuth = req.headers.authorization ?? null
    res.writeHead(401)
    res.end('unauthorized')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-noauth'), { host: '127.0.0.1', port })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, '401 = deterministic (terminal), never auto-retried')
      assert.match(result.detail ?? '', /requires authentication \(401\) — configure the shared token/)
    }
    assert.equal(seenAuth, null, 'no credentials → the probe carries NO Authorization header (no pre-flight refusal)')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('ssh provider verifyUp: a rejected token answers 401 terminal with the token message', async () => {
  setGatewayToken('gw-bad', 'z'.repeat(32))
  try {
    const server = describeServer((_req, res) => {
      res.writeHead(401)
      res.end('unauthorized')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-bad'), { host: '127.0.0.1', port })
      assert.equal(result.ok, false)
      if (!result.ok) {
        assert.equal(result.terminal, true)
        assert.match(result.detail ?? '', /rejected the token \(401\) — check the shared token/)
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    setGatewayToken('gw-bad', null)
  }
})

test('ssh provider verifyUp: a dsh target NEVER carries an auth header, even when a token exists for its id', async () => {
  const TOKEN = 'y'.repeat(32)
  setGatewayToken('dsh-with-token', TOKEN)
  try {
    let seenAuth: string | null = null
    const server = describeServer((req, res, body) => {
      seenAuth = req.headers.authorization ?? null
      let rpcId: string | null = null
      try { rpcId = (JSON.parse(body) as { rpcId?: unknown }).rpcId as string | null } catch { /* ignore */ }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    try {
      // A dsh-kind spec whose id happens to have a stored token: dsh target
      // semantics forbid auth injection (design 17 §2.1) — the header must
      // never leak even in the collision case.
      const dshSpec: TransportInstanceSpec = { id: 'dsh-with-token', label: 'h', kind: 'dsh', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome: null, insecureHttp: false }
      const result = await sshProvider.verifyUp!(dshSpec, { host: '127.0.0.1', port })
      assert.deepEqual(result, { ok: true })
      assert.equal(seenAuth, null, 'dsh targets never inject auth headers')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  } finally {
    setGatewayToken('dsh-with-token', null)
  }
})

test('verifyGatewayEndpointViaTunnel classifies a 403 origin/Host policy rejection as terminal', async () => {
  const server = describeServer((_req, res) => {
    res.writeHead(403)
    res.end('forbidden')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const result = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, null)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, '403 origin/Host policy rejection = terminal')
      assert.match(result.detail ?? '', /origin\/Host policy \(403\)/)
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

// ---------------------------------------------------------------------------
// verifyUp password-session flow over the SSH TUNNEL (design 17 §9.2/§9.3,
// S1 gap): a gateway-over-ssh target with a stored password and NO token
// uses the SAME session-hook pattern as the direct-endpoint gateway provider
// — ensure a login session keyed to the TUNNEL origin, probe WITH its
// Cookie, and on a rejected 401 invalidate + re-login exactly once before the
// terminal password-refused state. main.ts wires configureGatewaySessionProvider
// once; the ssh provider reads the SAME hooks (getGatewaySessionHooks).
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'dsh_gateway_session=fake-jwt-for-tunnel'
const GATEWAY_PASSWORD = 'gateway-login-password-456'

/** A loopback gateway stub recording the probe's cookie/authorization. */
function tunnelGatewayServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void) {
  return describeServer(handler)
}

test('ssh provider verifyUp: a password-configured gateway-over-ssh target (no token) logs in via the TUNNEL origin and probes WITH the Cookie (design 17 §9.2/§9.3, S1)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const exchanged: Array<{ origin: GatewaySessionOrigin; password: string }> = []
  let cached: string | null = null
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (origin: GatewaySessionOrigin, password: string) => {
      exchanged.push({ origin, password })
      return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const)
    },
    cachedCookie: () => cached,
    invalidate: () => {},
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  const server = tunnelGatewayServer((req, res, _body) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    setGatewayPassword('gw-tunnel-pw-1', GATEWAY_PASSWORD)
    const spec = gatewaySshSpec('gw-tunnel-pw-1')
    const endpoint = { host: '127.0.0.1', port }
    // First verifyUp: no cached session → the STORED password is exchanged
    // against the LOOPBACK tunnel origin (NOT the remote spec host:port) and
    // the probe rides the session Cookie.
    const first = await sshProvider.verifyUp!(spec, endpoint)
    assert.equal(first.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE, 'the tunnel probe carries the session Cookie')
    assert.equal(seen.authorization, undefined, 'no Authorization when the session authenticates')
    assert.equal(exchanged.length, 1)
    assert.equal(exchanged[0].password, GATEWAY_PASSWORD, 'the STORED password is what the login exchanges — never the cookie')
    assert.equal(exchanged[0].origin.baseUrl, `http://127.0.0.1:${port}`, 'the session is keyed to the TUNNEL endpoint origin')
    assert.equal(exchanged[0].origin.insecureHttp, true, 'the tunnel origin is plain http (the session manager scheme selector)')
    assert.equal(exchanged[0].origin.authority, '127.0.0.1:30801', 'the session key uses the remote loopback HTTP authority, not the SSH alias')
    assert.match(exchanged[0].origin.scope, /^v1:gw-tunnel-pw-1:/, 'the session key is owned by this exact connection and SSH target binding')
    // Second verifyUp with a live cached session: NO re-login — bounded
    // reconnect cycles must never hammer the login endpoint (429 discipline).
    cached = SESSION_COOKIE
    const second = await sshProvider.verifyUp!(spec, endpoint)
    assert.equal(second.ok, true)
    assert.equal(seen.cookie, SESSION_COOKIE)
    assert.equal(exchanged.length, 1, 'a live cached session is never re-exchanged')
  } finally {
    setGatewayPassword('gw-tunnel-pw-1', null)
    configureGatewaySessionProvider({})
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('ssh provider verifyUp: a tunnel-probe 401 with the session cookie invalidates, re-logs in ONCE, and only then reports the terminal password-refused state (design 17 §7.3/§9.3)', async () => {
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const server = tunnelGatewayServer((_req, res) => {
    res.writeHead(401)
    res.end('unauthorized')
  })
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (_origin: GatewaySessionOrigin) => {
      logins += 1
      return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const)
    },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    setGatewayPassword('gw-tunnel-401-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-401-1'), { host: '127.0.0.1', port })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.terminal, true, 'a session rejected even after the one re-login is deterministic')
      assert.match(result.detail ?? '', /rejected the password authentication \(401\) — re-enter the password/)
    }
    assert.equal(logins, 2, 'the 401 triggered exactly ONE automatic re-login (bounded, §9.3 重登一次)')
    assert.equal(invalidated.length, 2, 'both the stale and the freshly minted session are invalidated')
    assert.equal(invalidated[0].baseUrl, `http://127.0.0.1:${port}`, 'the invalidation targets the tunnel origin')
  } finally {
    setGatewayPassword('gw-tunnel-401-1', null)
    configureGatewaySessionProvider({})
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('ssh provider verifyUp: a tunnel-probe 401 self-heals through the one automatic re-login — the fresh session probes ok (design 17 §9.3)', async () => {
  let probes = 0
  const server = tunnelGatewayServer((_req, res, _body) => {
    probes += 1
    if (probes === 1) {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  const invalidated: GatewaySessionOrigin[] = []
  let logins = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: (_origin: GatewaySessionOrigin) => {
      logins += 1
      return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const)
    },
    cachedCookie: () => null,
    invalidate: origin => { invalidated.push(origin) },
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    setGatewayPassword('gw-tunnel-relogin-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-relogin-1'), { host: '127.0.0.1', port })
    assert.equal(result.ok, true, 'the fresh session after the one automatic re-login is accepted')
    assert.equal(probes, 2, 'exactly two probes: the stale-cookie probe and the fresh-session re-probe')
    assert.equal(logins, 2, 'the initial login plus exactly ONE automatic re-login')
    assert.equal(invalidated.length, 1, 'only the stale session was invalidated — the fresh one is kept')
  } finally {
    setGatewayPassword('gw-tunnel-relogin-1', null)
    configureGatewaySessionProvider({})
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('ssh provider verifyUp: token and password coexist — the tunnel probe carries Bearer AND Cookie (design 17 §2.3)', async () => {
  const TOKEN = 'q'.repeat(32)
  setGatewayToken('gw-tunnel-both-1', TOKEN)
  let sessionConsulted = 0
  const hooks: GatewaySessionProviderHooks = {
    ensureSession: () => { sessionConsulted += 1; return Promise.resolve({ ok: true, cookie: SESSION_COOKIE } as const) },
    cachedCookie: () => null,
    invalidate: () => { sessionConsulted += 1 },
  }
  configureGatewaySessionProvider(completeTestGatewaySessionHooks(hooks))
  let seenAuth: string | null = null
  let seenCookie: string | null = null
  const server = tunnelGatewayServer((req, res) => {
    seenAuth = req.headers.authorization ?? null
    seenCookie = req.headers.cookie ?? null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    setGatewayPassword('gw-tunnel-both-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-both-1'), { host: '127.0.0.1', port })
    assert.equal(result.ok, true)
    assert.equal(seenAuth, `Bearer ${TOKEN}`, 'the Bearer token rides the tunnel probe')
    assert.equal(seenCookie, SESSION_COOKIE, 'the independent password session also rides the tunnel probe')
    assert.equal(sessionConsulted, 1, 'the token never shadows the password/session flow')
  } finally {
    setGatewayToken('gw-tunnel-both-1', null)
    setGatewayPassword('gw-tunnel-both-1', null)
    configureGatewaySessionProvider({})
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('ssh provider verifyUp: a refused password login falls back to a valid tunnel Bearer', async () => {
  const TOKEN = 'r'.repeat(32)
  configureGatewaySessionProvider(completeTestGatewaySessionHooks({
    ensureSession: async () => ({ ok: false, code: 'invalid_credentials', error: 'password rejected' }),
    cachedCookie: () => null,
  }))
  let probes = 0
  const server = tunnelGatewayServer((req, res) => {
    probes += 1
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(req.headers.cookie, undefined)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    setGatewayToken('gw-tunnel-fallback', TOKEN)
    setGatewayPassword('gw-tunnel-fallback', GATEWAY_PASSWORD)
    assert.deepEqual(await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-fallback'), { host: '127.0.0.1', port }), { ok: true })
    assert.equal(probes, 1)
  } finally {
    setGatewayToken('gw-tunnel-fallback', null)
    setGatewayPassword('gw-tunnel-fallback', null)
    configureGatewaySessionProvider({})
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('ssh provider verifyUp: without session hooks a password-configured gateway-over-ssh target probes WITHOUT auth (inert default, design 17 §2.3)', async () => {
  const seen: { cookie?: string; authorization?: string } = {}
  const server = tunnelGatewayServer((req, res) => {
    seen.cookie = req.headers.cookie
    seen.authorization = req.headers.authorization
    res.writeHead(401)
    res.end('unauthorized')
  })
  configureGatewaySessionProvider({})
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    setGatewayPassword('gw-tunnel-inert-1', GATEWAY_PASSWORD)
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-tunnel-inert-1'), { host: '127.0.0.1', port })
    assert.equal(seen.cookie, undefined, 'no hooks → the tunnel probe carries no Cookie')
    assert.equal(seen.authorization, undefined, 'no hooks → the tunnel probe carries no Authorization')
    assert.equal(result.ok, false, 'the password-gated tunnel endpoint must reject the probe')
    assert.match(result.detail ?? '', /requires authentication/)
  } finally {
    setGatewayPassword('gw-tunnel-inert-1', null)
    configureGatewaySessionProvider({})
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('verifyGatewayEndpointViaTunnel: a 401 with a session Cookie is classified as the password being refused, never as a token problem', async () => {
  const server = tunnelGatewayServer((_req, res) => {
    res.writeHead(401)
    res.end('unauthorized')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    // Cookie-carrying probe: password-refused message (design 17 §7.3 密码被拒).
    const withCookie = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, null, undefined, undefined, SESSION_COOKIE)
    assert.equal(withCookie.ok, false)
    assert.equal(withCookie.terminal, true)
    assert.equal(withCookie.statusCode, 401, 'the raw status rides the result for the session flow')
    assert.match(withCookie.detail ?? '', /rejected the password authentication \(401\) — re-enter the password/)
    // Cookie-less, token-less probe: "configure the shared token or password".
    const noCredential = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, null)
    assert.equal(noCredential.ok, false)
    assert.match(noCredential.detail ?? '', /requires authentication \(401\) — configure the shared token/)
    // Token-carrying probe: "check the shared token".
    const withToken = await verifyGatewayEndpointViaTunnel({ host: '127.0.0.1', port }, 'z'.repeat(32))
    assert.equal(withToken.ok, false)
    assert.match(withToken.detail ?? '', /rejected the token \(401\) — check the shared token/)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('ssh provider verifyUp: a gateway-over-ssh probe presents the remote loopback authority, never the SSH hostname/alias (design 17 §9.3)', async () => {
  setGatewayToken('gw-host', null)
  let seenHost: string | null = null
  const server = describeServer((req, res, _body) => {
    seenHost = req.headers.host ?? null
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_RUNTIME_STATUS))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  try {
    const result = await sshProvider.verifyUp!(gatewaySshSpec('gw-host'), { host: '127.0.0.1', port })
    assert.deepEqual(result, { ok: true })
    assert.equal(seenHost, '127.0.0.1:30801', 'the forward terminates at remote loopback; an SSH alias is not an HTTP authority')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
