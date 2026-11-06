/**
 * P0-3 host-key module: app-owned known_hosts (parse/format/fingerprint/three states/atomic
 * replace/mutex/first-use import/TTL) and the failure-triggered ssh self-proof probe with an
 * injected spawn. No real ssh runs here; the fake writes the same known_hosts line ssh writes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash, createHmac } from 'node:crypto'
import type { SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HOST_KEY_PROBE_TTL_MS, applyTrustedHostKey, buildSelfProofArgs, classifyPresentedHostKey, sshOptionValue, sshTrustPins,
  createHostKeyGuard, ensureKnownHostsFile, fingerprintSha256, formatKnownHostsLine,
  globalKnownHostsFileFor, hostPatternFor, isHostKeyKnown, knownHostsPathFor, lastHostKeyProbe,
  parseKnownHosts, parseKnownHostsLine, probeHostKey, recordHostKeyProbe,
  toHostKeyProjection, withKnownHostsMutex, writeTrustedHostKey,
} from '../../host-key.ts'
import type { HostKeyProbeOutcome, HostKeyTarget } from '../../host-key.ts'
import type { SpawnedProcess } from '../../transport-provider.ts'
import { sshProvider } from '../../ssh-provider.ts'
import { spec } from '../support/ssh-provider-run-deps.ts'

const TARGET: HostKeyTarget = { host: 'h.example.com', sshPort: null }
const PORT_TARGET: HostKeyTarget = { host: 'h.example.com', sshPort: 2222 }
const ED25519_A = { type: 'ssh-ed25519', blob: Buffer.from('ed25519-key-a').toString('base64') }
const ED25519_B = { type: 'ssh-ed25519', blob: Buffer.from('ed25519-key-b').toString('base64') }
const RSA_A = { type: 'ssh-rsa', blob: Buffer.from('rsa-key-a').toString('base64') }

function tempStore(t: { after(fn: () => void): void }, userText?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hostkey-test-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const knownHostsFile = knownHostsPathFor(dir)
  const userKnownHostsFile = join(dir, 'user_known_hosts')
  if (userText !== undefined) writeFileSync(userKnownHostsFile, userText)
  // No global reset needed: the probe registry is keyed by the (unique) temp known_hosts path.
  return { dir, knownHostsFile, userKnownHostsFile }
}

function lineFor(target: HostKeyTarget, key: { type: string; blob: string }): string {
  return hostPatternFor(target) + ' ' + key.type + ' ' + key.blob
}

/** The file a `-o <name>=…` argument names (sshOptionValue quotes it for ssh). */
function optionFile(args: readonly string[], name: string): string {
  const raw = (args.find(arg => arg.startsWith(name + '=')) ?? '').slice(name.length + 1)
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
}

class FakeProbeChild extends EventEmitter {
  stdout = null
  stderr = new EventEmitter()
  stdin = null
  killCalls: NodeJS.Signals[] = []
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal)
    return true
  }
}

function probeSpawn(plan: {
  line?: string
  stderr?: string
  exitCode?: number | null
  inspect?: (args: readonly string[]) => void
}) {
  const calls: string[][] = []
  const files: string[] = []
  const child = new FakeProbeChild()
  const spawnFn = (_command: string, args: readonly string[], _options: SpawnOptions): SpawnedProcess => {
    calls.push([...args])
    const file = optionFile(args, 'UserKnownHostsFile')
    files.push(file)
    plan.inspect?.(args)
    setImmediate(() => {
      if (plan.line !== undefined) writeFileSync(file, plan.line)
      if (plan.stderr !== undefined) child.stderr.emit('data', Buffer.from(plan.stderr))
      child.emit('exit', plan.exitCode === undefined ? 255 : plan.exitCode, null)
    })
    return child as unknown as SpawnedProcess
  }
  return { spawnFn, calls, files, child }
}

function unavailable(reason: string): HostKeyProbeOutcome {
  return {
    state: 'unavailable', type: null, blob: null, fingerprints: [], previousFingerprints: [],
    changed: false, probedAt: Date.now(), reason,
  }
}

function okOutcome(state: 'unknown' | 'known' | 'changed', key: { type: string; blob: string }, previous: string[] = []): HostKeyProbeOutcome {
  const fingerprint = fingerprintSha256(key.blob) ?? ''
  return {
    state, type: key.type, blob: key.blob, fingerprints: fingerprint === '' ? [] : [fingerprint],
    previousFingerprints: previous, changed: state === 'changed', probedAt: Date.now(),
  }
}

test('known_hosts lines parse/format: markers, [host]:port, IPv6, hashed entries, malformed rows', () => {
  const portLine = parseKnownHostsLine('[h.example.com]:2222 ssh-ed25519 AAAA')
  assert.deepEqual(portLine, { markers: [], patterns: ['[h.example.com]:2222'], type: 'ssh-ed25519', blob: 'AAAA', raw: '[h.example.com]:2222 ssh-ed25519 AAAA' })
  assert.equal(formatKnownHostsLine({ patterns: ['a', 'b'], type: 'ssh-rsa', blob: 'BBBB' }), 'a,b ssh-rsa BBBB')
  const marker = parseKnownHostsLine('@revoked *.example.com ssh-rsa CCCC')
  assert.deepEqual(marker?.markers, ['@revoked'])
  assert.equal(parseKnownHostsLine('|1|c2FsdA==|aGFzaA== ssh-ed25519 DDDD')?.type, 'ssh-ed25519')
  assert.equal(parseKnownHostsLine(''), null)
  assert.equal(parseKnownHostsLine('# comment'), null)
  assert.equal(parseKnownHostsLine('only-two-fields ssh-ed25519'), null)
  assert.equal(parseKnownHostsLine('host not-base64! AAAA'), null)
  assert.equal(parseKnownHosts('\n'.concat(lineFor(TARGET, ED25519_A), '\n# tail\n')).length, 1)
})

test('hostPatternFor is the HostKeyAlias token: bare host on 22, host:port otherwise (B1)', () => {
  assert.equal(hostPatternFor({ host: 'h.example.com', sshPort: null }), 'h.example.com')
  assert.equal(hostPatternFor({ host: 'h.example.com', sshPort: 22 }), 'h.example.com')
  // The alias is itself the known_hosts token: host:port for an explicit port,
  // so two servers on one host keep separate trust entries.
  assert.equal(hostPatternFor({ host: 'h.example.com', sshPort: 2222 }), 'h.example.com:2222')
  assert.equal(hostPatternFor({ host: '::1', sshPort: 2222 }), '::1:2222')
  assert.equal(hostPatternFor({ host: '[::1]', sshPort: null }), '::1')
})

test('fingerprintSha256 hashes the DECODED blob (ssh-keygen -E sha256 shape, no padding)', () => {
  const expected = 'SHA256:' + createHash('sha256').update(Buffer.from(ED25519_A.blob, 'base64')).digest('base64').replace(/=+$/, '')
  assert.equal(fingerprintSha256(ED25519_A.blob), expected)
  assert.match(expected, /^SHA256:[A-Za-z0-9+/]+$/)
  assert.notEqual(fingerprintSha256(ED25519_A.blob), fingerprintSha256(ED25519_B.blob))
  assert.equal(fingerprintSha256('not base64!'), null)
  assert.equal(fingerprintSha256(''), null)
})

test('three-state classification: unknown / known / changed, port-isolated, hashed + wildcard rows', () => {
  const empty = classifyPresentedHostKey('', TARGET, ED25519_A)
  assert.deepEqual(empty, { state: 'unknown', previousFingerprints: [] })

  const text = lineFor(TARGET, ED25519_A)
  assert.equal(classifyPresentedHostKey(text, TARGET, ED25519_A).state, 'known')
  const changed = classifyPresentedHostKey(text, TARGET, ED25519_B)
  assert.equal(changed.state, 'changed')
  assert.deepEqual(changed.previousFingerprints, [fingerprintSha256(ED25519_A.blob)])
  // A type-only match is NOT "known": the blob must match.
  assert.equal(classifyPresentedHostKey(text, TARGET, { type: 'ssh-ed25519', blob: RSA_A.blob }).state, 'changed')
  // Port isolation: a :22 row never authorizes :2222 (and vice versa).
  assert.equal(classifyPresentedHostKey(lineFor(TARGET, ED25519_A), PORT_TARGET, ED25519_A).state, 'unknown')
  assert.equal(classifyPresentedHostKey(lineFor(PORT_TARGET, ED25519_A), TARGET, ED25519_A).state, 'unknown')
  assert.equal(classifyPresentedHostKey(lineFor(PORT_TARGET, ED25519_A), PORT_TARGET, ED25519_A).state, 'known')

  // OpenSSH HashedKnownHosts form (Ubuntu default): |1|<salt>|<HMAC-SHA1(salt, host)>.
  const salt = Buffer.from('0123456789abcdef')
  const digest = createHmac('sha1', salt).update('h.example.com').digest()
  const hashed = '|1|' + salt.toString('base64') + '|' + digest.toString('base64') + ' ' + ED25519_A.type + ' ' + ED25519_A.blob
  assert.equal(classifyPresentedHostKey(hashed, TARGET, ED25519_A).state, 'known')

  // Wildcards and negation follow OpenSSH semantics.
  const wildcard = '*.example.com ' + ED25519_A.type + ' ' + ED25519_A.blob
  assert.equal(classifyPresentedHostKey(wildcard, TARGET, ED25519_A).state, 'known')
  const negated = '!h.example.com,*.example.com ' + ED25519_A.type + ' ' + ED25519_A.blob
  assert.equal(classifyPresentedHostKey(negated, TARGET, ED25519_A).state, 'unknown')
})

test('applyTrustedHostKey appends once, replaces a changed key and preserves unrelated rows', () => {
  const original = '# my hosts\n' + lineFor({ host: 'other.example.com', sshPort: null }, RSA_A) + '\n'
  const appended = applyTrustedHostKey(original, TARGET, ED25519_A)
  assert.equal(appended.replaced, false)
  assert.ok(appended.text.startsWith('# my hosts\n'))
  assert.ok(appended.text.includes(lineFor(TARGET, ED25519_A)))
  assert.ok(appended.text.endsWith('\n'))
  // Idempotent: the identical row is de-duplicated, not appended twice.
  const twice = applyTrustedHostKey(appended.text, TARGET, ED25519_A)
  assert.equal(twice.replaced, true)
  assert.equal(twice.text, appended.text)
  // A changed key replaces every row for the target (same pattern, any type) and keeps others.
  const stale = lineFor(TARGET, ED25519_A) + '\n' + lineFor(TARGET, RSA_A) + '\n' + lineFor({ host: 'other.example.com', sshPort: null }, RSA_A) + '\n'
  const replaced = applyTrustedHostKey(stale, TARGET, ED25519_B, { replace: true })
  assert.equal(replaced.replaced, true)
  assert.ok(!replaced.text.includes(ED25519_A.blob))
  const targetRows = replaced.text.split('\n').filter(row => row.startsWith(hostPatternFor(TARGET) + ' '))
  assert.deepEqual(targetRows, [lineFor(TARGET, ED25519_B)], 'the target keeps exactly one row (any type was replaced)')
  assert.equal(replaced.text.split('\n').filter(line => line !== '').length, 2)
})

test('the probe TTL registry keeps the LAST probe per target and expires after 5 minutes', () => {
  // A unique virtual path: the registry is keyed by the app known_hosts file.
  const knownHostsFile = '/tmp/probe-registry-test-' + String(process.pid) + '-' + String(Date.now()) + '/known_hosts'
  const t0 = 1_000_000
  recordHostKeyProbe(knownHostsFile, TARGET, { ...okOutcome('unknown', ED25519_A), probedAt: t0 })
  assert.equal(lastHostKeyProbe(knownHostsFile, TARGET, t0 + 1000)?.state, 'unknown')
  assert.equal(lastHostKeyProbe(knownHostsFile, TARGET, t0 + HOST_KEY_PROBE_TTL_MS + 1), null, 'expired')
  recordHostKeyProbe(knownHostsFile, TARGET, { ...okOutcome('changed', ED25519_B, ['SHA256:old']), probedAt: t0 + 2000 })
  const latest = lastHostKeyProbe(knownHostsFile, TARGET, t0 + 2001)
  assert.equal(latest?.state, 'changed', 'only the most recent probe counts')
  assert.equal(lastHostKeyProbe(knownHostsFile, PORT_TARGET, t0 + 2001), null, 'targets do not share records')
  assert.deepEqual(toHostKeyProjection(latest!), { state: 'changed', fingerprints: [fingerprintSha256(ED25519_B.blob)], changed: true, previousFingerprints: ['SHA256:old'] })
  // previousFingerprints is a changed-state field: a KNOWN key must not render「原指纹」next to
  // 「主机指纹」with the same value (that display was read as a key rotation when none happened).
  assert.deepEqual(toHostKeyProjection(okOutcome('known', ED25519_A, ['SHA256:old'])), {
    state: 'known',
    fingerprints: [fingerprintSha256(ED25519_A.blob)],
  })
})

test('the module mutex serializes read-modify-write tasks (and survives a rejected task)', async () => {
  const order: number[] = []
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
  await Promise.all([
    withKnownHostsMutex(async () => { order.push(1); await sleep(5); order.push(2) }),
    withKnownHostsMutex(() => { order.push(3) }),
  ])
  assert.deepEqual(order, [1, 2, 3])
  await assert.rejects(withKnownHostsMutex(() => { throw new Error('boom') }), /boom/)
  assert.equal(await withKnownHostsMutex(() => 'after-failure'), 'after-failure', 'a rejected task never poisons the chain')
})

test('concurrent trust writes never lose a row (file mutex + atomic replace)', async (t) => {
  const store = tempStore(t)
  const options = { knownHostsFile: store.knownHostsFile }
  await Promise.all(Array.from({ length: 8 }, (_value, index) => {
    const target = { host: 'host' + String(index) + '.example.com', sshPort: null }
    const key = { type: 'ssh-ed25519', blob: Buffer.from('key-' + String(index)).toString('base64') }
    return writeTrustedHostKey(options, target, key, false)
  }))
  const text = readFileSync(store.knownHostsFile, 'utf8')
  assert.equal(text.trim().split('\n').length, 8)
  assert.equal(statSync(store.knownHostsFile).mode & 0o777, 0o600)
  for (let index = 0; index < 8; index += 1) {
    assert.ok(text.includes('host' + String(index) + '.example.com ssh-ed25519'))
  }
})

test('first use imports the user known_hosts once (0600 app copy; the user file is never written)', (t) => {
  const userText = '# user file\n' + lineFor(TARGET, ED25519_A) + '\n'
  const store = tempStore(t, userText)
  const options = { knownHostsFile: store.knownHostsFile, userKnownHostsFile: store.userKnownHostsFile }
  assert.equal(existsSync(store.knownHostsFile), false)
  ensureKnownHostsFile(options)
  assert.equal(readFileSync(store.knownHostsFile, 'utf8'), userText)
  assert.equal(statSync(store.knownHostsFile).mode & 0o777, 0o600)
  assert.equal(statSync(join(store.dir, 'ssh')).mode & 0o777, 0o700)
  assert.equal(isHostKeyKnown(options, TARGET), true, 'an imported host is already known')
  // The import is first-use only: later user-file edits never leak in.
  writeFileSync(store.userKnownHostsFile, userText + lineFor(PORT_TARGET, ED25519_B) + '\n')
  assert.equal(isHostKeyKnown(options, PORT_TARGET), false)
  assert.equal(readFileSync(store.knownHostsFile, 'utf8'), userText)
  assert.equal(readFileSync(store.userKnownHostsFile, 'utf8').includes(ED25519_B.blob), true, 'the user file keeps its own content')
})

test('the self-proof argv pins the throwaway store, BatchMode and no auth method', () => {
  assert.deepEqual(
    buildSelfProofArgs({ host: 'h.example.com', sshPort: 2222, user: 'u' }, '/tmp/x/known_hosts', '/dev/null'),
    [
      '-o', 'UserKnownHostsFile="/tmp/x/known_hosts"',
      '-o', 'GlobalKnownHostsFile="/dev/null"',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=8',
      '-o', 'PreferredAuthentications=none',
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      ...sshTrustPins(),
      '-o', 'HostKeyAlias=h.example.com:2222',
      '-p', '2222', 'u@h.example.com', 'true',
    ],
  )
  assert.equal(globalKnownHostsFileFor('linux'), '/dev/null')
  assert.equal(globalKnownHostsFileFor('darwin'), '/dev/null')
  assert.equal(globalKnownHostsFileFor('win32'), 'NUL')
})

test('the tunnel argv pins StrictHostKeyChecking=yes and the app store (legacy argv unchanged)', () => {
  const argv = sshProvider.buildStartArgs!(spec('t-argv'), 40000, { knownHostsFile: '/u/ssh/known_hosts', globalKnownHostsFile: '/dev/null' })
  assert.ok(argv.includes('StrictHostKeyChecking=yes'), 'strict checking is explicit')
  assert.ok(argv.includes('UserKnownHostsFile="/u/ssh/known_hosts"'))
  assert.ok(argv.includes('GlobalKnownHostsFile="/dev/null"'))
  // B1: the alias is the SAME token the trust file records, or strict lookup
  // would ask for [realhost]:port and never find the trusted line.
  assert.ok(argv.includes('HostKeyAlias=h.example.com'))
  for (const pin of sshTrustPins()) assert.ok(argv.includes(pin), pin)
  assert.ok(!argv.some(arg => arg.startsWith('StrictHostKeyChecking=no')))
  const legacy = sshProvider.buildStartArgs!(spec('t-argv'), 40000)
  assert.ok(!legacy.some(arg => arg.startsWith('StrictHostKeyChecking=')), 'no configured store = historical argv (pure callers)')
  assert.ok(!legacy.some(arg => arg.startsWith('UserKnownHostsFile=')))
})

test('a known_hosts path with a space is quoted so ssh keeps it as ONE argument (macOS userData)', () => {
  // Production replica: every macOS userData root contains "Application Support". ssh splits an
  // -o value on whitespace, so the unquoted form pointed ssh at a truncated/relative path, read no
  // key, and failed every strict child with "No ... host key is known" / "Host key verification
  // failed" — trust could never take effect (real-machine report, 0.4.4-beta.3).
  const file = join('/Users/someone/Library/Application Support/@dsh-chamber/desktop/ssh', 'known_hosts')
  assert.equal(sshOptionValue(file), '"' + file + '"')
  assert.equal(sshOptionValue('/a "b"/c'), '"/a \\"b\\"/c"', 'quotes are escaped for the ssh_config parser')

  const proof = buildSelfProofArgs(TARGET, file, '/dev/null')
  assert.ok(proof.includes('UserKnownHostsFile="' + file + '"'))
  assert.ok(proof.includes('GlobalKnownHostsFile="/dev/null"'))
  assert.equal(optionFile(proof, 'UserKnownHostsFile'), file, 'the quoted value round-trips')

  const tunnel = sshProvider.buildStartArgs!(spec('t-space'), 40000, { knownHostsFile: file, globalKnownHostsFile: '/dev/null' })
  const option = tunnel.find(arg => arg.startsWith('UserKnownHostsFile='))
  // The value ssh receives after its own whitespace split must still be exactly one token.
  assert.equal(option, 'UserKnownHostsFile=' + sshOptionValue(file))
  assert.equal(sshOptionValue(file).slice(1, -1), file, 'the space inside the path is preserved')
})

test('the self-proof probe writes its key to a 0600 throwaway file and deletes it', async (t) => {
  const store = tempStore(t)
  const fake = probeSpawn({
    line: lineFor(TARGET, ED25519_A),
    stderr: 'Permission denied (publickey).\n',
    inspect: (args) => {
      const file = optionFile(args, 'UserKnownHostsFile')
      assert.match(file, /dsh-chamber-hostkey-/, 'the probe never touches the app or user store')
      assert.equal(statSync(file).mode & 0o777, 0o600)
    },
  })
  const outcome = await probeHostKey({ target: TARGET, knownHostsFile: store.knownHostsFile, spawnFn: fake.spawnFn })
  assert.equal(outcome.state, 'unknown')
  assert.equal(outcome.type, ED25519_A.type)
  assert.equal(outcome.blob, ED25519_A.blob)
  assert.deepEqual(outcome.fingerprints, [fingerprintSha256(ED25519_A.blob)])
  assert.equal(fake.calls.length, 1)
  assert.equal(existsSync(fake.files[0]!), false, 'the throwaway file is deleted')
  assert.equal(fake.calls[0]!.includes('PreferredAuthentications=none'), true)
})

test('probe classification: an imported known key is known, a changed key reports the old fingerprint', async (t) => {
  const store = tempStore(t, lineFor(TARGET, ED25519_A) + '\n')
  const known = await probeHostKey({
    target: TARGET, knownHostsFile: store.knownHostsFile, userKnownHostsFile: store.userKnownHostsFile,
    spawnFn: probeSpawn({ line: lineFor(TARGET, ED25519_A) }).spawnFn,
  })
  assert.equal(known.state, 'known')
  assert.deepEqual(known.previousFingerprints, [fingerprintSha256(ED25519_A.blob)])

  const changed = await probeHostKey({
    target: TARGET, knownHostsFile: store.knownHostsFile, spawnFn: probeSpawn({ line: lineFor(TARGET, ED25519_B) }).spawnFn,
  })
  assert.equal(changed.state, 'changed')
  assert.equal(changed.changed, true)
  assert.deepEqual(changed.fingerprints, [fingerprintSha256(ED25519_B.blob)])
  assert.deepEqual(changed.previousFingerprints, [fingerprintSha256(ED25519_A.blob)])
})

test('an unavailable probe is honest (no key written / ssh missing) and never throws', async (t) => {
  const store = tempStore(t)
  const noKey = await probeHostKey({
    target: TARGET, knownHostsFile: store.knownHostsFile,
    spawnFn: probeSpawn({ stderr: 'ssh: connect to host h.example.com port 22: Connection refused\n' }).spawnFn,
  })
  assert.equal(noKey.state, 'unavailable')
  assert.match(noKey.reason ?? '', /Connection refused/)
  const missingBinary = await probeHostKey({
    target: TARGET, knownHostsFile: store.knownHostsFile,
    spawnFn: () => { throw new Error('spawn ssh ENOENT') },
  })
  assert.equal(missingBinary.state, 'unavailable')
  assert.match(missingBinary.reason ?? '', /ENOENT/)

  // ProxyJump can leave only the hop's key in the throwaway file; never present
  // an unrelated host's key as this target's key (R6 A-m3).
  const otherHost = await probeHostKey({
    target: TARGET, knownHostsFile: store.knownHostsFile,
    spawnFn: probeSpawn({ line: lineFor({ host: 'other.example', sshPort: null }, ED25519_A) }).spawnFn,
  })
  assert.equal(otherHost.state, 'unavailable')
  assert.match(otherHost.reason ?? '', /no host key for the target/)
})

test('trust accepts ONLY the latest probed (type, blob), within the TTL', async (t) => {
  const store = tempStore(t)
  const t0 = 5_000_000
  let clock = t0
  const fake = probeSpawn({ line: lineFor(TARGET, ED25519_A) })
  const guard = createHostKeyGuard({
    knownHostsFile: store.knownHostsFile, userKnownHostsFile: store.userKnownHostsFile,
    spawnFn: fake.spawnFn, now: () => clock,
  })
  // No probe yet: nothing is trustable.
  const beforeProbe = await guard.trust(TARGET, ED25519_A)
  assert.equal(beforeProbe.ok, false)
  if (!beforeProbe.ok) assert.match(beforeProbe.error, /no recent host-key probe/)

  assert.equal(guard.isKnown(TARGET), false)
  const probed = await guard.probe(TARGET)
  assert.equal(probed.state, 'unknown')
  assert.deepEqual(guard.projection(TARGET), { state: 'unknown', fingerprints: [fingerprintSha256(ED25519_A.blob)] })

  // A different key than the probe saw is refused (the renderer cannot invent material).
  const forged = await guard.trust(TARGET, ED25519_B)
  assert.equal(forged.ok, false)
  if (!forged.ok) assert.match(forged.error, /does not match the most recent probe/)
  const invalid = await guard.trust(TARGET, { type: 'ssh-ed25519', blob: 'not base64!' })
  assert.equal(invalid.ok, false)

  // A stale probe (TTL) is refused.
  clock = t0 + HOST_KEY_PROBE_TTL_MS + 1
  const stale = await guard.trust(TARGET, ED25519_A)
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.match(stale.error, /no recent host-key probe/)

  // Re-probe inside the window, then trust: the file now holds the key and the target is known.
  clock = t0 + HOST_KEY_PROBE_TTL_MS + 2
  await guard.probe(TARGET)
  const trusted = await guard.trust(TARGET, ED25519_A)
  assert.equal(trusted.ok, true)
  if (trusted.ok) {
    assert.equal(trusted.replaced, false)
    assert.deepEqual(trusted.projection, { state: 'known', fingerprints: [fingerprintSha256(ED25519_A.blob)] })
  }
  assert.equal(guard.isKnown(TARGET), true)
  assert.match(readFileSync(store.knownHostsFile, 'utf8'), new RegExp(lineFor(TARGET, ED25519_A)))
  assert.equal(guard.isKnown(PORT_TARGET), false)
})

test('a changed key replaces the trusted row through the guard', async (t) => {
  const store = tempStore(t, lineFor(TARGET, ED25519_A) + '\n')
  const guard = createHostKeyGuard({
    knownHostsFile: store.knownHostsFile, userKnownHostsFile: store.userKnownHostsFile,
    spawnFn: probeSpawn({ line: lineFor(TARGET, ED25519_B) }).spawnFn,
  })
  const probed = await guard.probe(TARGET)
  assert.equal(probed.state, 'changed')
  const trusted = await guard.trust(TARGET, ED25519_B)
  assert.equal(trusted.ok, true)
  if (trusted.ok) assert.equal(trusted.replaced, true)
  const text = readFileSync(store.knownHostsFile, 'utf8')
  assert.ok(!text.includes(ED25519_A.blob), 'the old key row is replaced, not kept alongside')
  assert.ok(text.includes(ED25519_B.blob))
  const again = await guard.probe(TARGET)
  assert.equal(again.state, 'known')
})

test('an unavailable probe is never trustable', async (t) => {
  const store = tempStore(t)
  const guard = createHostKeyGuard({
    knownHostsFile: store.knownHostsFile,
    spawnFn: probeSpawn({ stderr: 'timeout\n' }).spawnFn,
  })
  const probed = await guard.probe(TARGET)
  assert.equal(probed.state, 'unavailable')
  assert.deepEqual(guard.projection(TARGET), { state: 'unavailable', fingerprints: [] })
  const trusted = await guard.trust(TARGET, ED25519_A)
  assert.equal(trusted.ok, false)
  if (!trusted.ok) assert.match(trusted.error, /did not observe a key|does not match/)
})

test('unavailable fixture shape stays stable (guard against accidental secret fields)', () => {
  assert.deepEqual(Object.keys(unavailable('x')).sort(), [
    'blob', 'changed', 'fingerprints', 'previousFingerprints', 'probedAt', 'reason', 'state', 'type',
  ])
})

test('trust preserves wildcard and multi-pattern rows for OTHER hosts (R2 B-M2)', () => {
  const multi = 'a.example,b.example ' + ED25519_A.type + ' ' + ED25519_A.blob + '\n'
  const multiOut = applyTrustedHostKey(multi, { host: 'a.example', sshPort: null }, ED25519_B, { replace: true }).text
  assert.match(multiOut, /b\.example ssh-ed25519 /u, 'the other pattern keeps its old trust')
  assert.match(multiOut, /a\.example ssh-ed25519 /u)
  const wild = '*.example ' + ED25519_A.type + ' ' + ED25519_A.blob + '\n'
  const wildOut = applyTrustedHostKey(wild, { host: 'a.example', sshPort: null }, ED25519_B, { replace: true }).text
  assert.match(wildOut, /^!a\.example,\*\.example /m, 'the wildcard row is narrowed, not deleted')
  assert.match(wildOut, /a\.example ssh-ed25519 /u)
})

test('@revoked is a denial marker: never known, never erased by a trust write (P2-6 cleanup)', () => {
  const revoked = '@revoked ' + lineFor(TARGET, ED25519_A)
  assert.equal(classifyPresentedHostKey(revoked, TARGET, ED25519_A).state, 'unknown')
  const applied = applyTrustedHostKey(revoked, TARGET, ED25519_B, { replace: true })
  assert.match(applied.text, /^@revoked /m, 'the revocation row must survive a replace')
  assert.match(applied.text, new RegExp(ED25519_B.blob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'))
  // OpenSSH @revoked is per key: revoking A must not deny a valid B row.
  const mixed = '@revoked ' + lineFor(TARGET, ED25519_A) + '\n' + lineFor(TARGET, ED25519_B)
  assert.equal(classifyPresentedHostKey(mixed, TARGET, ED25519_B).state, 'known')
  assert.equal(classifyPresentedHostKey(mixed, TARGET, ED25519_A).state, 'unknown')
  const bracketRevoked = '@revoked [h.example.com]:2222 ssh-ed25519 ' + ED25519_A.blob
  assert.equal(classifyPresentedHostKey(bracketRevoked, PORT_TARGET, ED25519_A).state, 'unknown',
    'a legacy [host]:port revocation is still a revocation')
  assert.match(applyTrustedHostKey(bracketRevoked, PORT_TARGET, ED25519_B, { replace: true }).text, /^@revoked /m)
  const ca = '@cert-authority ' + lineFor(TARGET, ED25519_A)
  assert.equal(classifyPresentedHostKey(ca, TARGET, ED25519_A).state, 'unknown', 'a CA key is not a host key')
  assert.match(applyTrustedHostKey(ca, TARGET, ED25519_B).text, /^@cert-authority /m, 'the CA row is preserved')
})
