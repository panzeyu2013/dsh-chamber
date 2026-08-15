/**
 * ssh provider password-auth unit tests (design 05 §8): the in-memory
 * password store, the ephemeral askpass helper script (single-quote
 * escaping, host-key `yes` answers, 0600 file, dispose cleanup) and the
 * buildStartEnv surface that wires the password into the ssh spawn without
 * a TTY or the command line. Pure-Node, no real ssh host: the helper's
 * behavior is verified by actually executing it against ssh-style prompts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildAskpassScript,
  configureSshPasswordStore,
  createAskpassHelper,
  disposeSshAuth,
  getSshPassword,
  setSshPassword,
  sshAuthEnv,
  sshPasswordSupported,
} from './ssh-provider.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

/** A minimal valid ssh spec for provider-surface tests. */
function spec(id: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null }
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
  const path = createAskpassHelper('t-askpass-1', "s3cr't")
  try {
    const hostKey = spawnSync('sh', [path, 'Are you sure you want to continue connecting (yes/no/[fingerprint])?'], { encoding: 'utf8' })
    assert.equal(hostKey.status, 0)
    assert.equal(hostKey.stdout.trim(), 'yes', 'host-key confirmation answers yes')
    const password = spawnSync('sh', [path, "user@h.example.com's password:"], { encoding: 'utf8' })
    assert.equal(password.status, 0)
    assert.equal(password.stdout, "s3cr't\n", 'password prompt answers the stored password (line-terminated)')
    const passphrase = spawnSync('sh', [path, "Enter passphrase for key '/Users/x/.ssh/id_ed25519':"], { encoding: 'utf8' })
    assert.equal(passphrase.stdout, "s3cr't\n", 'key passphrase prompts reuse the stored password')
    // The helper file is 0600 (owner-only).
    assert.equal(statSync(path).mode & 0o777, 0o600, 'helper is 0600')
  } finally {
    rmSync(path, { force: true })
  }
})

test('createAskpassHelper refuses instance ids outside the registry whitelist', () => {
  assert.throws(() => createAskpassHelper('bad/id', 'pw'), /invalid instance id/)
  assert.throws(() => createAskpassHelper('../escape', 'pw'), /invalid instance id/)
})

test('setSshPassword/getSshPassword round-trip and clear (empty string and null both clear)', () => {
  setSshPassword('t-store-1', 'pw')
  assert.equal(getSshPassword('t-store-1'), 'pw')
  setSshPassword('t-store-1', '')
  assert.equal(getSshPassword('t-store-1'), null, "'' clears")
  setSshPassword('t-store-1', 'pw2')
  setSshPassword('t-store-1', null)
  assert.equal(getSshPassword('t-store-1'), null, 'null clears')
})

test('sshAuthEnv returns the askpass env only when a password is stored', () => {
  setSshPassword('t-env-1', 'pw')
  try {
    const env = sshAuthEnv(spec('t-env-1'))
    assert.ok(env !== null, 'a stored password yields an askpass env')
    assert.equal(env!.SSH_ASKPASS_REQUIRE, 'force', 'askpass is forced (no TTY needed)')
    assert.ok(typeof env!.SSH_ASKPASS === 'string' && env!.SSH_ASKPASS.length > 0)
    assert.ok(existsSync(env!.SSH_ASKPASS!), 'the helper exists before the spawn')
    assert.equal(sshAuthEnv(spec('t-env-2')), null, 'no stored password = key/agent auth (null env)')
  } finally {
    setSshPassword('t-env-1', null)
    disposeSshAuth(spec('t-env-1'))
    disposeSshAuth(spec('t-env-2'))
  }
})

test('disposeSshAuth deletes the ephemeral askpass helper', () => {
  setSshPassword('t-env-3', 'pw')
  try {
    const env = sshAuthEnv(spec('t-env-3'))
    assert.ok(env !== null && env!.SSH_ASKPASS !== undefined)
    const path = env!.SSH_ASKPASS
    assert.ok(existsSync(path))
    disposeSshAuth(spec('t-env-3'))
    assert.ok(!existsSync(path), 'helper is deleted on dispose')
    // A later sshAuthEnv (reconnect) writes a FRESH helper.
    const next = sshAuthEnv(spec('t-env-3'))
    assert.ok(next !== null && next!.SSH_ASKPASS !== path, 'a fresh helper replaces the disposed one')
  } finally {
    setSshPassword('t-env-3', null)
    disposeSshAuth(spec('t-env-3'))
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
    setSshPassword('t-file-1', 'pw-1')
    setSshPassword('t-file-2', 'pw-2')
    assert.ok(existsSync(file), 'file is written on the first set')
    assert.equal(statSync(file).mode & 0o777, 0o600, 'password file is 0600')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { passwords: Record<string, string> }
    assert.equal(parsed.passwords['t-file-1'], 'pw-1')
    assert.equal(parsed.passwords['t-file-2'], 'pw-2')
    // Simulate a restart: reconfigure away (clears the memory map), reload.
    configureSshPasswordStore(null)
    assert.equal(getSshPassword('t-file-1'), null, 'memory cleared by reconfiguration')
    assert.equal(configureSshPasswordStore(file), null, 'reload is clean')
    assert.equal(getSshPassword('t-file-1'), 'pw-1', 'password survives a restart via the file')
    assert.equal(getSshPassword('t-file-2'), 'pw-2')
    // Explicit clear removes the entry from the file too.
    setSshPassword('t-file-1', null)
    const afterClear = JSON.parse(readFileSync(file, 'utf8')) as { passwords: Record<string, string> }
    assert.equal(afterClear.passwords['t-file-1'], undefined, 'cleared entry leaves the file')
    assert.equal(afterClear.passwords['t-file-2'], 'pw-2', 'other entries stay')
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
    assert.equal(getSshPassword('anything'), null, 'store starts empty after a corrupt file')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})
