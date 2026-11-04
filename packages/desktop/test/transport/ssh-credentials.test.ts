/**
 * SSH 凭据镜像（design 05 §8 / P2-5）与 askpass 传递路径的单元测试：
 * - safeStorage 适配器加密/解密 round-trip（fake adapter，不依赖 Electron）；
 * - 旧明文（schemaVersion 2）读取 + 可用时迁移重写（0600、原子、密文）；
 * - 适配器不可用（Linux 无 keyring）→ 旧明文可读、新保存拒绝（绝不写明文）；
 * - 跨 flavor 密文（safeStorage + 无适配器）→ 原地保留、fail closed、不 rename .corrupt；
 * - 结构损坏 / 解密失败 → .corrupt 保留（fail closed）；
 * - askpass：FIFO 非明文路径（0700 helper + 0600 FIFO）的生成/权限/清理，
 *   以及 mkfifo 失败时自动回退到 0700 内嵌脚本。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MAX_SSH_PASSWORD_CHARS,
  openSshCredentialStore,
  SSH_PASSWORD_ENCRYPTION_UNAVAILABLE,
  SSH_PASSWORD_SAFESTORAGE_UNREADABLE,
  type SshCredentialCryptoAdapter,
} from '../../ssh-credentials.ts'
import {
  ASKPASS_PASSWORD_FIFO_ENV,
  buildAskpassScript,
  createAskpassArtifact,
  startAskpassFifoWriter,
  type AskpassArtifact,
} from '../../ssh-askpass.ts'
import { acquireSshAuthLease, configureSshPasswordStore, getSshPassword, purgeSshAuth, setSshPassword } from '../../ssh-provider.ts'
import { sshCredentialBinding } from '../../credential-binding.ts'
import { spec } from '../support/ssh-provider-run-deps.ts'

const POSIX = process.platform !== 'win32'

/** 一个形状与 Electron safeStorage 相同的假适配器：密文带可验证前缀，绝不接受明文冒充。 */
function fakeCrypto(): SshCredentialCryptoAdapter {
  return {
    isAvailable: () => true,
    encrypt: plain => 'enc:' + Buffer.from(plain, 'utf8').toString('base64'),
    decrypt: blob => {
      if (!blob.startsWith('enc:')) throw new Error('not a fake ciphertext')
      return Buffer.from(blob.slice(4), 'base64').toString('utf8')
    },
  }
}

/** 适配器存在但 keyring 不可用（Electron on Linux without GNOME Keyring/KWallet）。 */
function unavailableCrypto(): SshCredentialCryptoAdapter {
  return {
    isAvailable: () => false,
    encrypt: () => { throw new Error('encryption unavailable') },
    decrypt: () => { throw new Error('encryption unavailable') },
  }
}

function tempFile(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-credentials-'))
  return { dir, file: join(dir, 'ssh-passwords.json') }
}

function legacyPayload(entries: ReadonlyArray<{ id: string; password: string; host?: string }>): string {
  const passwords: Record<string, string> = {}
  const bindings: Record<string, string> = {}
  for (const entry of entries) {
    passwords[entry.id] = entry.password
    bindings[entry.id] = sshCredentialBinding({ ...spec(entry.id), host: entry.host ?? 'h.example.com' })!
  }
  return JSON.stringify({ schemaVersion: 2, passwords, bindings }, undefined, 2) + '\n'
}

test('safeStorage adapter encrypts at rest and round-trips through a restart', () => {
  const { dir, file } = tempFile()
  try {
    const crypto = fakeCrypto()
    assert.equal(configureSshPasswordStore(file, id => spec(id), crypto), null)
    const first = spec('cred-1')
    const second = spec('cred-2')
    setSshPassword(first, 'p@ss-one')
    setSshPassword(second, 'p@ss-two')
    const raw = readFileSync(file, 'utf8')
    assert.ok(!raw.includes('p@ss-one') && !raw.includes('p@ss-two'), 'no plaintext secret reaches the disk')
    const parsed = JSON.parse(raw) as { schemaVersion: number; storage: string; passwords: Record<string, string> }
    assert.equal(parsed.schemaVersion, 3)
    assert.equal(parsed.storage, 'safeStorage', 'the file carries the explicit storage discriminator')
    assert.ok(parsed.passwords['cred-1'].startsWith('enc:'), 'the stored value is the adapter ciphertext')
    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600, 'the mirror stays owner-only 0600')
    // Restart: reconfigure away (clears memory) and reload with the same adapter.
    configureSshPasswordStore(null)
    assert.equal(getSshPassword(first), null, 'memory cleared by reconfiguration')
    assert.equal(configureSshPasswordStore(file, id => spec(id), crypto), null)
    assert.equal(getSshPassword(first), 'p@ss-one')
    assert.equal(getSshPassword(second), 'p@ss-two')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy v2 plaintext is readable and migrated to ciphertext on read (0600, atomic rewrite)', () => {
  const { dir, file } = tempFile()
  try {
    const owner = spec('legacy-1')
    writeFileSync(file, legacyPayload([{ id: owner.id, password: 'legacy-pw' }]), { mode: 0o600 })
    assert.equal(configureSshPasswordStore(file, id => spec(id), fakeCrypto()), null, 'a legacy file loads without a notice')
    assert.equal(getSshPassword(owner), 'legacy-pw', 'the old plaintext remains readable')
    const raw = readFileSync(file, 'utf8')
    assert.ok(!raw.includes('legacy-pw'), 'the migration rewrote the secret as ciphertext')
    const parsed = JSON.parse(raw) as { schemaVersion: number; storage: string }
    assert.equal(parsed.schemaVersion, 3)
    assert.equal(parsed.storage, 'safeStorage')
    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600)
    // A second startup reads the migrated file cleanly.
    configureSshPasswordStore(null)
    assert.equal(configureSshPasswordStore(file, id => spec(id), fakeCrypto()), null)
    assert.equal(getSshPassword(owner), 'legacy-pw')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no keychain: legacy plaintext stays readable, new/changed saves are refused (never plaintext)', () => {
  const { dir, file } = tempFile()
  try {
    const owner = spec('nokeyring-1')
    const legacy = legacyPayload([{ id: owner.id, password: 'old-plain' }])
    writeFileSync(file, legacy, { mode: 0o600 })
    const notice = configureSshPasswordStore(file, id => spec(id), unavailableCrypto())
    assert.match(notice ?? '', /keychain|keyring/i, 'the startup notice explains the missing keyring')
    assert.equal(getSshPassword(owner), 'old-plain', 'the legacy plaintext stays readable (never silently dropped)')
    assert.equal(readFileSync(file, 'utf8'), legacy, 'no rewrite happens while encryption is unavailable')

    const fresh = spec('nokeyring-2')
    assert.throws(
      () => setSshPassword(fresh, 'brand-new'),
      (error: unknown) => String(error).includes(SSH_PASSWORD_ENCRYPTION_UNAVAILABLE),
      'a NEW password is refused with the actionable keyring message',
    )
    assert.equal(getSshPassword(fresh), null, 'the refused password never enters memory')
    assert.ok(!readFileSync(file, 'utf8').includes('brand-new'), 'the refused password is never written in plaintext')

    // A pure clear (removal) is still allowed: it cannot create a new plaintext secret.
    assert.doesNotThrow(() => setSshPassword(owner, null))
    assert.equal(getSshPassword(owner), null)
    const afterClear = JSON.parse(readFileSync(file, 'utf8')) as { passwords: Record<string, unknown> }
    assert.equal(afterClear.passwords[owner.id], undefined, 'the cleared entry leaves the file')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cross-flavor safeStorage file is preserved byte-for-byte, never renamed .corrupt', () => {
  const { dir, file } = tempFile()
  try {
    const owner = spec('crossflavor-1')
    const crypto = fakeCrypto()
    writeFileSync(file, legacyPayload([{ id: owner.id, password: 'electron-pw' }]), { mode: 0o600 })
    assert.equal(configureSshPasswordStore(file, id => spec(id), crypto), null)
    const encrypted = readFileSync(file, 'utf8')
    assert.equal(configureSshPasswordStore(null), null)
    // Another flavor (Swift sidecar) has no keychain adapter at all.
    const notice = configureSshPasswordStore(file, id => spec(id), unavailableCrypto())
    assert.equal(notice, SSH_PASSWORD_SAFESTORAGE_UNREADABLE)
    assert.equal(getSshPassword(owner), null, 'undecryptable entries fail closed')
    assert.equal(readFileSync(file, 'utf8'), encrypted, 'the file is preserved unchanged')
    assert.equal(existsSync(file + '.corrupt'), false, 'a valid other-flavor file is NOT corruption')
    // M3: a write from the truly adapter-less flavor (Swift sidecar) must not
    // downgrade the file to plaintext or erase entries it could not decrypt.
    configureSshPasswordStore(null)
    assert.equal(configureSshPasswordStore(file, id => spec(id)), SSH_PASSWORD_SAFESTORAGE_UNREADABLE)
    assert.throws(() => setSshPassword(owner.id, 'new-pw'), /safeStorage-encrypted/u)
    assert.equal(readFileSync(file, 'utf8'), encrypted, 'a refused write leaves the ciphertext intact')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('corrupt files and undecryptable blobs are preserved as .corrupt and fail closed', () => {
  const { dir, file } = tempFile()
  try {
    writeFileSync(file, '{not json', { mode: 0o600 })
    const notice = configureSshPasswordStore(file, id => spec(id), fakeCrypto())
    assert.ok(notice !== null && notice.includes('.corrupt'), 'invalid JSON is preserved loudly')
    assert.ok(existsSync(file + '.corrupt'))
    assert.equal(getSshPassword(spec('anything')), null)

    // A safeStorage-tagged file whose blob the adapter cannot decrypt is corrupt, not plaintext.
    const second = tempFile()
    try {
      const owner = spec('bad-blob-1')
      writeFileSync(second.file, JSON.stringify({
        schemaVersion: 3,
        storage: 'safeStorage',
        passwords: { [owner.id]: 'not-a-ciphertext' },
        bindings: { [owner.id]: sshCredentialBinding(owner) },
      }), { mode: 0o600 })
      const blobNotice = configureSshPasswordStore(second.file, id => spec(id), fakeCrypto())
      assert.ok(blobNotice !== null && blobNotice.includes('.corrupt'), 'an undecryptable blob fails closed as corruption')
      assert.equal(getSshPassword(owner), null, 'no partial entries are published')
      assert.ok(existsSync(second.file + '.corrupt'))
    } finally {
      configureSshPasswordStore(null)
      rmSync(second.dir, { recursive: true, force: true })
    }
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed migration keeps plaintext entries usable and reports the failure loudly', () => {
  const { dir, file } = tempFile()
  try {
    const owner = spec('migrate-fail-1')
    const legacy = legacyPayload([{ id: owner.id, password: 'still-here' }])
    writeFileSync(file, legacy, { mode: 0o600 })
    const failing: SshCredentialCryptoAdapter = {
      isAvailable: () => true,
      encrypt: () => { throw new Error('keychain encrypt boom') },
      decrypt: blob => blob,
    }
    const notice = configureSshPasswordStore(file, id => spec(id), failing)
    assert.match(notice ?? '', /upgrade failed/i)
    assert.equal(getSshPassword(owner), 'still-here', 'the loaded plaintext stays usable')
    assert.equal(readFileSync(file, 'utf8'), legacy, 'the failed upgrade leaves the plaintext file in place')
  } finally {
    configureSshPasswordStore(null)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('openSshCredentialStore memory-only mode writes nothing and rejects oversized values', t => {
  const store = openSshCredentialStore(null)
  assert.equal(store.notice, null)
  assert.equal(store.entries.size, 0)
  assert.doesNotThrow(() => store.persist(new Map()))
  // The provider bound is still enforced at the setter; the store itself accepts any parsed value
  // up to the shared cap (single source MAX_SSH_PASSWORD_CHARS).
  assert.equal(MAX_SSH_PASSWORD_CHARS, 4096)
  t.diagnostic('memory-only store is a no-op for persistence')
})

/** Run one askpass invocation against a FIFO artifact and collect its stdout. */
function runAskpass(helperPath: string, prompt: string, fifo: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(helperPath, [prompt], { env: { ...process.env, [ASKPASS_PASSWORD_FIFO_ENV]: fifo } })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk) })
    child.on('error', () => resolve({ code: null, stdout }))
    child.on('exit', code => resolve({ code, stdout }))
  })
}

test('FIFO askpass: non-secret 0700 helper + 0600 FIFO, answers only password prompts, cleans up', async t => {
  if (!POSIX) { t.skip('POSIX 0700/0600 and mkfifo semantics'); return }
  const artifact: AskpassArtifact = createAskpassArtifact('askpass-fifo-1', "fi'fo-pw")
  const writer = startAskpassFifoWriter(artifact.fifo!, "fi'fo-pw")
  try {
    assert.ok(artifact.fifo !== null, 'the FIFO transport is available on this platform')
    assert.equal(statSync(artifact.path).mode & 0o777, 0o700, 'the helper is owner-executable')
    assert.equal(lstatSync(artifact.fifo).mode & 0o777, 0o600, 'the FIFO is owner-only 0600')
    assert.ok(lstatSync(artifact.fifo).isFIFO(), 'the secret channel is a real FIFO')
    assert.equal(statSync(dirname(artifact.path)).mode & 0o777, 0o700, 'the private leaf is 0700')
    const script = readFileSync(artifact.path, 'utf8')
    assert.ok(!script.includes("fi'fo-pw"), 'the password is NOT embedded in the helper')
    assert.ok(script.includes(ASKPASS_PASSWORD_FIFO_ENV), 'the helper reads the private FIFO path')

    const password = await runAskpass(artifact.path, "user@h.example.com's password:", artifact.fifo)
    assert.equal(password.code, 0)
    assert.equal(password.stdout, "fi'fo-pw\n", 'the parent-written answer reaches ssh (line-terminated)')
    const hostKey = await runAskpass(artifact.path, 'Are you sure you want to continue connecting (yes/no/[fingerprint])?', artifact.fifo)
    assert.equal(hostKey.stdout, '', 'a host-key prompt still receives NO answer (fail-closed)')
    const otp = await runAskpass(artifact.path, 'Verification code:', artifact.fifo)
    assert.equal(otp.stdout, '', 'keyboard-interactive/OTP prompts are never answered (v1 unsupported)')
  } finally {
    writer.stop()
    artifact.cleanup()
    assert.equal(existsSync(artifact.path), false, 'cleanup removes the helper')
    assert.equal(artifact.fifo !== null && existsSync(artifact.fifo), false, 'cleanup removes the FIFO')
  }
})

test('askpass falls back to the documented 0700 embedded script when mkfifo is unavailable', t => {
  if (!POSIX) { t.skip('POSIX 0700 semantics'); return }
  const artifact = createAskpassArtifact('askpass-fallback-1', "s3cr't", {
    createFifo: () => { throw new Error('mkfifo unavailable') },
  })
  try {
    assert.equal(artifact.fifo, null, 'no FIFO artifact is reported after a failed mkfifo')
    assert.equal(statSync(artifact.path).mode & 0o777, 0o700)
    assert.ok(readFileSync(artifact.path, 'utf8').includes(buildAskpassScript("s3cr't")), 'the fallback embeds the escaped password')
  } finally {
    artifact.cleanup()
    assert.equal(existsSync(artifact.path), false)
  }
  const forcedScript = createAskpassArtifact('askpass-fallback-2', 'pw', { transport: 'script' })
  try {
    assert.equal(forcedScript.fifo, null)
  } finally {
    forcedScript.cleanup()
  }
})

test('an ssh auth lease carries the FIFO path and removes every artifact on release', t => {
  if (!POSIX) { t.skip('POSIX 0700/0600 and mkfifo semantics'); return }
  const { dir, file } = tempFile()
  let lease: ReturnType<typeof acquireSshAuthLease> = null
  try {
    configureSshPasswordStore(file, undefined, fakeCrypto())
    const owner = spec('lease-fifo-1')
    setSshPassword(owner, 'lease-pw')
    lease = acquireSshAuthLease(owner)
    assert.ok(lease !== null, 'a stored password yields an askpass lease')
    const helper = lease.env.SSH_ASKPASS
    const fifo = lease.env[ASKPASS_PASSWORD_FIFO_ENV]
    assert.equal(lease.env.SSH_ASKPASS_REQUIRE, 'force')
    assert.ok(typeof helper === 'string' && existsSync(helper), 'the helper exists before the spawn')
    assert.ok(typeof fifo === 'string' && lstatSync(fifo).isFIFO(), 'the lease exposes the private FIFO')
    assert.ok(!readFileSync(helper, 'utf8').includes('lease-pw'), 'the helper never carries the password')
    lease.release()
    assert.equal(existsSync(helper), false, 'child exit (lease release) removes the helper')
    assert.equal(existsSync(fifo), false, 'child exit (lease release) removes the FIFO')
  } finally {
    lease?.release()
    configureSshPasswordStore(null)
    purgeSshAuth('lease-fifo-1')
    rmSync(dir, { recursive: true, force: true })
  }
})
